/**
 * The evidence harness's staging root, and the proof that it leaves nothing
 * behind.
 *
 * ## Why the path *length* is load-bearing
 *
 * `evidence:update` used to generate the adapter-platform runs directly beneath
 * `fixtures/golden`, while `evidence:verify` generated them beneath a random
 * `os.tmpdir()` directory. The adapter host bakes the run's absolute
 * adapter-workspace path into the request frames, and the retained
 * `sandbox-invocation-result/v1` records the true `request_bytes` — so two roots
 * of different absolute path length produced two different sandbox-result core
 * hashes, and that difference propagated into detail record hashes, step
 * outcomes, lifecycle events, snapshots, the subject-output manifest, the
 * content-addressed copies and the terminal hashes. The pin could not hold.
 *
 * The answer is not to stop counting real request bytes. It is to make the two
 * generations equivalent: one fixed repo-relative parent, one fixed prefix, and
 * `mkdtemp`'s fixed-length suffix. Two staging roots then differ in their bytes
 * and never in their length.
 *
 * `mkdtemp` rather than one fixed shared directory, because a fixed directory is
 * a collision between two concurrent generations — the second would generate into
 * the first's tree and both would report on a mixture. The parent is
 * repo-relative for the same reason the generic-finalization runs already use
 * `.erl2-work`: a checkout-relative path is reproducible where `os.tmpdir()` is
 * not, and `.erl2-work` is gitignored and removed by `npm run clean`.
 *
 * ## Why this is a module
 *
 * Extracted from `scripts/generate-evidence.mjs` for the same reason
 * `disposableWorktree.mjs` was extracted from the negative-control campaign: the
 * behaviour that only happens when something goes wrong — cleanup after a throw,
 * cleanup after an early exit, cleanup after an interrupt — should be driven by a
 * test rather than asserted by reading the code.
 */

import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";

/** The one prefix every staging root carries. */
export const STAGING_PREFIX = "stage-";

/** The one parent every staging root is created under, given a checkout root. */
export function stagingParent(repoRoot) {
  return path.join(repoRoot, ".erl2-work", "evidence-staging");
}

/**
 * Creates a staging root and arranges for it to be removed exactly once.
 *
 * The removal is registered for process exit — which covers a clean finish, an
 * explicit `process.exit`, and an uncaught throw — and for `SIGINT`/`SIGTERM`,
 * which reach no exit listener on their own. A half-written staging tree left in
 * the checkout is residue however the process ended.
 *
 * @param {string} repoRoot the checkout root
 * @returns {{ stagingRoot: string, release: () => void }}
 */
export function createStagingRoot(repoRoot) {
  const parent = stagingParent(repoRoot);
  mkdirSync(parent, { recursive: true });
  const stagingRoot = mkdtempSync(path.join(parent, STAGING_PREFIX));

  let removed = false;
  const release = () => {
    if (removed) return;
    removed = true;
    rmSync(stagingRoot, { recursive: true, force: true });
    // The parent goes too, but only if this process left it empty: a concurrent
    // generation owns its own staging root under the same parent.
    try {
      if (readdirSync(parent).length === 0) rmSync(parent, { recursive: true });
    } catch {
      /* another process is using it, or it is already gone */
    }
  };

  process.on("exit", release);
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      release();
      process.exit(130);
    });
  }

  return { stagingRoot, release };
}
