/**
 * The evidence harness's staging root, its per-generation work root, and the
 * proof that both leave nothing behind.
 *
 * ## Why the absolute path *length* is load-bearing
 *
 * `evidence:update` used to generate the adapter-platform runs directly beneath
 * `fixtures/golden`, while `evidence:verify` generated them beneath a random
 * `os.tmpdir()` directory. The adapter host bakes the run's absolute
 * adapter-workspace path into the request frames — twice, as `output_directory`
 * and `diagnostics_directory` — and the retained `sandbox-invocation-result/v1`
 * records the true `request_bytes`. So two roots of different absolute length
 * produce two different sandbox-result core hashes, and that difference
 * propagates into detail record hashes, step outcomes, lifecycle events,
 * snapshots, the subject-output manifest, the content-addressed copies and the
 * terminal hashes.
 *
 * The first correction made two staging roots equal in length *to each other*.
 * That is not enough, and the independent review measured why: their common
 * length still contained `repoRoot`, so the pin held on one checkout and failed
 * on every other — including CI, whose checkout path is longer than a developer's.
 * A ten-character difference in the repository root moved `request_bytes` by
 * twenty and changed the retained core hash.
 *
 * So the staging root's **complete absolute byte length is a constant**,
 * {@link STAGING_ROOT_TARGET_BYTES}, independent of where the repository is
 * checked out. A root is
 *
 *     <repoRoot>/.erl2-work/evidence-staging/<padding><prefix><6 mkdtemp bytes>
 *
 * where `padding` is a run of ASCII `_` whose length is computed from the
 * *measured UTF-8 byte length* of the parent — never from its character count,
 * because a checkout path containing non-ASCII characters has more bytes than
 * characters and it is bytes that reach the frame.
 *
 * The honest fix is not to stop counting the real request bytes, and not to
 * normalize them: it is to make the input they depend on a constant.
 *
 * ## Why `mkdtemp`, and why a sibling work root
 *
 * `mkdtemp` rather than one fixed shared directory, because a fixed directory is
 * a collision between two concurrent generations — the second would generate
 * into the first's tree and both would report on a mixture.
 *
 * The **work root** is that same guarantee for the runs the harness executes
 * *outside* the staged tree. Three generic-finalization runs and the environment
 * run need somewhere to execute that is not published into `fixtures/golden`.
 * They used to share `<repoRoot>/.erl2-work/evidence/<label>`, which each
 * generation deleted on entry — so two concurrent generations destroyed each
 * other's execution state — and an `os.tmpdir()` directory that was never
 * removed at all. Both now hang off the same unique token as the staging root:
 * distinct per process, constant in length, and released together.
 *
 * ## Why this is a module
 *
 * Extracted from `scripts/generate-evidence.mjs` for the same reason
 * `disposableWorktree.mjs` was extracted from the negative-control campaign: the
 * behaviour that only happens when something goes wrong — cleanup after a throw,
 * cleanup after an early exit, cleanup after an interrupt, a refusal on a
 * checkout too deep to pad — should be driven by a test rather than asserted by
 * reading the code.
 */

import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";

/** The prefix the published staging tree carries. Six bytes, like its sibling. */
export const STAGING_PREFIX = "stage-";

/** The prefix the never-published execution root carries. Six bytes, like its sibling. */
export const WORK_PREFIX = "work--";

/** The byte `mkdtemp` appends. Fixed on every supported platform. */
const MKDTEMP_SUFFIX_BYTES = 6;

/** The padding byte. ASCII by construction, so one character is one byte. */
const PAD_BYTE = "_";

/**
 * The constant absolute byte length of every staging and work root.
 *
 * Chosen, not arbitrary:
 *
 *   - it must exceed the longest supported checkout. The parent adds 28 bytes
 *     (`/.erl2-work/evidence-staging`) and the leaf adds 13 (`/` + prefix + the
 *     `mkdtemp` suffix), so this admits a repository root of up to 159 bytes —
 *     comfortably past a developer's `/Users/…` (45 here) and a GitHub runner's
 *     `/home/runner/work/<repo>/<repo>` (59);
 *   - the padded leaf component stays far below `NAME_MAX` (255): the widest it
 *     can be is 200 − 73 − 1 = 126 bytes for a one-byte repository root;
 *   - the deepest path *beneath* a root is a content-addressed package copy at
 *     169 bytes, so a complete path peaks near 370 — well under `PATH_MAX`
 *     (1024 on macOS, 4096 on Linux).
 *
 * Changing this constant changes every retained `request_bytes` and every hash
 * downstream of one. It is therefore a golden-regenerating edit, and it belongs
 * in the same commit as the regenerated goldens.
 */
export const STAGING_ROOT_TARGET_BYTES = 200;

/** The one parent every root is created under, given a checkout root. */
export function stagingParent(repoRoot) {
  return path.join(repoRoot, ".erl2-work", "evidence-staging");
}

/**
 * The padding that brings `<parent>/<padding><prefix><suffix>` to exactly
 * `targetBytes`, or a typed refusal explaining why it cannot.
 *
 * Separated from directory creation so both refusals are reachable from a test
 * without a filesystem deep enough to trigger them naturally.
 *
 * @param {string} parent absolute staging parent
 * @param {number} targetBytes desired absolute byte length of each root
 * @returns {{ padding: string } | { refusal: string }}
 */
export function stagingPadding(parent, targetBytes = STAGING_ROOT_TARGET_BYTES) {
  // Bytes, never characters: `Buffer.byteLength` is the only measure that agrees
  // with what lands in the request frame. A path component such as `café`
  // occupies five bytes and four characters, and the frame carries five.
  const parentBytes = Buffer.byteLength(parent, "utf8");
  const fixed = 1 /* separator */ + Buffer.byteLength(STAGING_PREFIX, "utf8") + MKDTEMP_SUFFIX_BYTES;
  const padBytes = targetBytes - parentBytes - fixed;

  if (padBytes < 0) {
    return {
      refusal:
        `the checkout is too deep for reproducible evidence: its staging parent is ` +
        `${String(parentBytes)} bytes and a staging root must be exactly ` +
        `${String(targetBytes)}, which leaves ${String(padBytes)} bytes of padding. ` +
        `Check the repository out under a path of at most ` +
        `${String(targetBytes - fixed - Buffer.byteLength(path.join(".erl2-work", "evidence-staging"), "utf8") - 1)} bytes.`,
    };
  }
  const componentBytes = padBytes + Buffer.byteLength(STAGING_PREFIX, "utf8") + MKDTEMP_SUFFIX_BYTES;
  if (componentBytes > 255) {
    return {
      refusal:
        `padding a ${String(parentBytes)}-byte staging parent up to ` +
        `${String(targetBytes)} needs a ${String(componentBytes)}-byte path component, ` +
        `which exceeds the 255-byte filesystem limit`,
    };
  }
  return { padding: PAD_BYTE.repeat(padBytes) };
}

/**
 * Creates this generation's staging root and its sibling work root, and arranges
 * for both to be removed exactly once.
 *
 * The removal is registered for process exit — which covers a clean finish, an
 * explicit `process.exit`, and an uncaught throw — and for `SIGINT`/`SIGTERM`,
 * which reach no exit listener on their own. A half-written tree left in the
 * checkout is residue however the process ended.
 *
 * @param {string} repoRoot the checkout root
 * @param {{ targetBytes?: number }} [options] test seam for the two refusals
 * @returns {{ stagingRoot: string, workRoot: string, release: () => void }}
 */
export function createStagingRoot(repoRoot, options = {}) {
  const targetBytes = options.targetBytes ?? STAGING_ROOT_TARGET_BYTES;
  const parent = stagingParent(repoRoot);
  const padded = stagingPadding(parent, targetBytes);
  // Refused before anything is created, so a checkout that cannot produce
  // reproducible evidence never produces misleading evidence instead.
  if (padded.refusal !== undefined) throw new Error(padded.refusal);
  const { padding } = padded;

  mkdirSync(parent, { recursive: true });
  const stagingRoot = mkdtempSync(path.join(parent, `${padding}${STAGING_PREFIX}`));

  // The work root reuses the staging root's own `mkdtemp` token rather than
  // drawing a second one. `mkdtemp` already reserved that token against every
  // concurrent process, so no other generation can hold the matching work root,
  // and one token keeps the two roots legibly paired in a directory listing.
  const token = path.basename(stagingRoot).slice(padding.length + STAGING_PREFIX.length);
  const workRoot = path.join(parent, `${padding}${WORK_PREFIX}${token}`);

  let removed = false;
  const release = () => {
    if (removed) return;
    removed = true;
    rmSync(stagingRoot, { recursive: true, force: true });
    rmSync(workRoot, { recursive: true, force: true });
    // The parent goes too, but only if this process left it empty: a concurrent
    // generation owns its own pair of roots under the same parent.
    try {
      if (readdirSync(parent).length === 0) rmSync(parent, { recursive: true });
    } catch {
      /* another process is using it, or it is already gone */
    }
  };

  try {
    // Not `recursive`: a pre-existing work root would mean the token collided,
    // which `mkdtemp` makes impossible — so surfacing it beats adopting it.
    mkdirSync(workRoot);

    // The post-condition, checked rather than assumed. If either root is not the
    // documented length the evidence would be silently unreproducible on this
    // platform, which is the failure this whole module exists to prevent.
    for (const [name, root] of [["staging", stagingRoot], ["work", workRoot]]) {
      const actual = Buffer.byteLength(root, "utf8");
      if (actual !== targetBytes) {
        throw new Error(
          `the ${name} root is ${String(actual)} bytes, not the required ${String(targetBytes)}: ${root}`,
        );
      }
    }
  } catch (cause) {
    release();
    throw cause;
  }

  process.on("exit", release);
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      release();
      process.exit(130);
    });
  }

  return { stagingRoot, workRoot, release };
}
