/**
 * CONTRACT: the neutral trusted-local example's three load-bearing guards are
 * actually load-bearing — deleting any of them turns this file red.
 *
 * ## Why this exists
 *
 * `trustedLocalExampleDocumentationTruth.test.ts` pins what the example *says*.
 * It deliberately does not run anything: its own docstring says the end-to-end
 * behaviour "is proved by running it — locally and in the `pr` workflow — not
 * here". That left three properties the example's own prose calls its most
 * important ones provable only by a green CI run, and therefore deletable with
 * every gate still green:
 *
 *   - **`verify-example.mjs`'s second pass.** The script's docstring says "Pass
 *     one alone would be worthless: a run command that lied about its own result
 *     would say `ok: true` and this script would agree." Removing pass two left
 *     all twenty-one documentation-truth tests passing and all three CI `grep`
 *     assertions satisfied, because pass one's output is what those greps read.
 *   - **`cleanup-example.sh`'s ownership stamp.** The check that distinguishes
 *     "a directory this example created" from "a directory whose name looks
 *     right", standing directly in front of `rm -rf` on an operator-supplied
 *     path. Deleting it deletes unstamped lookalikes containing real data.
 *   - **`cleanup-example.sh`'s parent-must-be-TMPDIR check.** The containment
 *     boundary on that same `rm -rf`.
 *
 * A fourth property — that CI exercises the example at all — was unprotected for
 * the same reason: no test read the workflow file, so the steps that prove the
 * documented operator path still works could be deleted without anything
 * noticing.
 *
 * ## How these are asserted
 *
 * By behaviour, not by substring. The verifier test produces a genuine
 * successful run through the public example, keeps that run's honest summary,
 * mutates one retained verifier-bound byte in a *copy* of the output tree, and
 * requires refusal — a refusal only the independent second pass can produce,
 * because pass one is reading an unchanged summary that still says
 * `observed_complete`. The cleanup tests compare a full before/after filesystem
 * manifest of every refused target rather than trusting an exit code. The
 * workflow test walks the `pr` job's step list structurally rather than
 * snapshotting the file.
 *
 * Nothing here reaches into `tests/support`: every run goes through the same
 * committed scripts an outsider would type.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const EXAMPLE_DIR = path.join(repoRoot, "examples", "trusted-local-neutral");
const RUN_EXAMPLE = path.join(EXAMPLE_DIR, "run-example.sh");
const VERIFY_EXAMPLE = path.join(EXAMPLE_DIR, "verify-example.mjs");
const CLEANUP_EXAMPLE = path.join(EXAMPLE_DIR, "cleanup-example.sh");

/** The stamp and prefix `run-example.sh` writes and `cleanup-example.sh` requires. */
const STAMP = ".erl2-trusted-local-neutral-scratch";
const PREFIX = "erl2-trusted-local-neutral-";

/**
 * The temporary root exactly as `cleanup-example.sh` computes it —
 * `cd "${TMPDIR:-/tmp}" && pwd -P`. Resolved physically, because on macOS
 * `TMPDIR` is a symlinked `/var/folders/...` whose real path is
 * `/private/var/folders/...`, and every comparison the script makes is about
 * the real directory.
 */
function effectiveTmpRoot(): string {
  return realpathSync(process.env["TMPDIR"] ?? "/tmp");
}

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

interface ManifestEntry {
  readonly relativePath: string;
  readonly kind: "file" | "directory" | "symlink";
  readonly mode: number;
  readonly size: number;
  readonly digest: string;
}

/**
 * A full recursive manifest of a tree: every path, its kind, its mode, its size
 * and — for regular files — the SHA-256 of its bytes. "The directory still
 * exists" is not the property under test; "not one byte of it moved" is.
 */
function manifestOf(root: string): readonly ManifestEntry[] {
  const entries: ManifestEntry[] = [];
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const stats = lstatSync(absolute);
      const relativePath = path.relative(root, absolute);
      if (stats.isSymbolicLink()) {
        entries.push({ relativePath, kind: "symlink", mode: stats.mode, size: 0, digest: "" });
        continue;
      }
      if (stats.isDirectory()) {
        entries.push({ relativePath, kind: "directory", mode: stats.mode, size: 0, digest: "" });
        walk(absolute);
        continue;
      }
      entries.push({
        relativePath,
        kind: "file",
        mode: stats.mode,
        size: stats.size,
        digest: sha256(readFileSync(absolute)),
      });
    }
  };
  walk(root);
  return entries;
}

interface Ran {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function run(command: string, args: readonly string[], cwd = repoRoot): Ran {
  const result = spawnSync(command, [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/** Creates a scratch directory stamped exactly as `run-example.sh` stamps one. */
function makeStampedScratch(parent: string, payload = "real operator data\n"): string {
  const scratch = mkdtempSync(path.join(parent, `${PREFIX}`));
  writeFileSync(
    path.join(scratch, STAMP),
    "created by examples/trusted-local-neutral/run-example.sh\n",
  );
  mkdirSync(path.join(scratch, "payload"));
  writeFileSync(path.join(scratch, "payload", "data.txt"), payload);
  return scratch;
}

/** The same shape, without the ownership stamp: a lookalike. */
function makeUnstampedLookalike(parent: string): string {
  const scratch = mkdtempSync(path.join(parent, `${PREFIX}`));
  mkdirSync(path.join(scratch, "payload"));
  writeFileSync(path.join(scratch, "payload", "data.txt"), "real operator data\n");
  return scratch;
}

/**
 * Asserts a cleanup invocation refused and that the target survived byte for
 * byte — the whole manifest, not the exit code, and not merely its existence.
 */
function assertRefusedAndUntouched(target: string, why: string): void {
  const before = manifestOf(target);
  const result = run(CLEANUP_EXAMPLE, [target]);
  const after = manifestOf(target);
  assert.notEqual(result.status, 0, `${why}: cleanup-example.sh must exit non-zero\n${result.stderr}`);
  assert.match(result.stderr, /^REFUSED: /mu, `${why}: the refusal must name itself`);
  assert.deepEqual(
    after,
    before,
    `${why}: the refused target must remain byte-identical — full filesystem manifest changed`,
  );
}

// ---------------------------------------------------------------------------
// The independent second pass of verify-example.mjs
// ---------------------------------------------------------------------------

test(
  "verify-example.mjs's independent second pass refuses a mutated retained artifact that its unchanged run summary still calls successful",
  { timeout: 300_000 },
  () => {
    const roots: string[] = [];
    try {
      // 1. A genuine successful run, through the public example — no test
      //    support harness, no hand-built record.
      const executed = run(RUN_EXAMPLE, []);
      assert.equal(
        executed.status,
        0,
        `the committed example must run green before its verifier can be tested\n${executed.stderr}`,
      );
      const scratchLine = /^== scratch root: (.+)$/mu.exec(executed.stdout);
      assert.ok(scratchLine?.[1], "run-example.sh must print its scratch root as its first line");
      const scratch = scratchLine[1];
      roots.push(scratch);

      const outputRoot = path.join(scratch, "output");
      const summaryPath = path.join(scratch, "run-summary.json");

      // 2. The run's own honest summary, preserved and never edited. This is
      //    what pass one reads, and it says the run succeeded.
      const summaryBefore = readFileSync(summaryPath);
      const summaryDigest = sha256(summaryBefore);
      const summary: unknown = JSON.parse(summaryBefore.toString("utf8"));
      const summaryData = (summary as { data?: unknown }).data ?? summary;
      assert.equal(
        (summaryData as { terminal_status?: unknown }).terminal_status,
        "observed_complete",
        "the preserved summary must itself assert success, or the test proves nothing",
      );

      // A control: the untouched pair verifies. Without this, a verifier that
      // refused everything would pass the mutation case for the wrong reason.
      const control = run("node", [VERIFY_EXAMPLE, outputRoot, summaryPath]);
      assert.equal(
        control.status,
        0,
        `an untouched successful run must verify\n${control.stderr}`,
      );
      assert.match(
        control.stdout,
        /"independent_verification"/u,
        "the verifier must report an independent verification block on success",
      );

      // 3. Mutate one retained, verifier-bound byte in a *copy* of the output
      //    tree. The retained input is bound by the plan's own ArtifactRef, so
      //    the second pass re-hashes it; the summary knows nothing about it.
      const mutatedRoot = path.join(scratch, "output-mutated");
      cpSync(outputRoot, mutatedRoot, { recursive: true });
      const boundInput = path.join(mutatedRoot, "inputs", "package-mount", "package.bin");
      // The retained input tree is mode 0400 inside owner-only directories —
      // that is the example working as designed. The copy has to be made
      // writable before an attacker's edit can be simulated on it.
      chmodSync(path.dirname(boundInput), 0o700);
      chmodSync(boundInput, 0o600);
      const boundBefore = readFileSync(boundInput);
      const boundDigestBefore = sha256(boundBefore);
      const boundAfterBytes = Buffer.concat([boundBefore, Buffer.from([0x00])]);
      writeFileSync(boundInput, boundAfterBytes, { mode: 0o600 });
      const boundDigestAfter = sha256(readFileSync(boundInput));

      //    The mutation is proved to have applied, by digest, not by assumption.
      assert.notEqual(
        boundDigestAfter,
        boundDigestBefore,
        "the mutation must actually change the retained artifact's bytes",
      );
      assert.equal(
        boundDigestAfter,
        sha256(boundAfterBytes),
        "the retained artifact must hold exactly the mutated bytes",
      );

      // 4. Invoke the real verifier on the mutated tree with the *unchanged*
      //    successful summary.
      assert.equal(
        sha256(readFileSync(summaryPath)),
        summaryDigest,
        "the run summary must be byte-identical: pass one must still see success",
      );
      const verified = run("node", [VERIFY_EXAMPLE, mutatedRoot, summaryPath]);

      // 5. Refusal is required. Pass one cannot produce it — it is reading a
      //    summary that still says observed_complete, and it never looks at the
      //    retained bytes. Only the independent second pass re-hashes them.
      //    Deleting that pass makes this assertion fail.
      assert.notEqual(
        verified.status,
        0,
        "the verifier must refuse a mutated retained artifact even though the run summary still reports success — " +
          "if this passes, verify-example.mjs's independent second pass is not doing anything",
      );
      assert.match(
        verified.stderr,
        /^REFUSED: independent offline verification refused/mu,
        "the refusal must come from the independent verification of retained bytes, not from the summary assertions",
      );
      // The distinction the test is built on, asserted rather than implied: the
      // summary-derived assertions are all satisfied, and the refusal is not
      // one of them.
      for (const summaryAssertion of [/terminal_status is/u, /cleanup\.status is/u, /offline_verification\.ok is/u]) {
        assert.doesNotMatch(
          verified.stderr,
          summaryAssertion,
          "no pass-one assertion may have failed: the mutation is invisible to the run summary",
        );
      }
    } finally {
      for (const root of roots) rmSync(root, { recursive: true, force: true });
    }
  },
);

// ---------------------------------------------------------------------------
// cleanup-example.sh's guards
// ---------------------------------------------------------------------------

test("cleanup-example.sh removes a correctly stamped scratch root directly beneath the effective TMPDIR", () => {
  const tmpRoot = effectiveTmpRoot();
  const scratch = makeStampedScratch(tmpRoot);
  try {
    const result = run(CLEANUP_EXAMPLE, [scratch]);
    assert.equal(result.status, 0, `a genuine task-owned scratch root must be removed\n${result.stderr}`);
    assert.match(result.stdout, /^removed /mu, "the removal must say what it removed");
    assert.equal(
      lstatSync(scratch, { throwIfNoEntry: false }),
      undefined,
      "the scratch root must be gone",
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("cleanup-example.sh refuses an unstamped lookalike with a valid prefix in a valid location, and leaves it byte-identical", () => {
  const lookalike = makeUnstampedLookalike(effectiveTmpRoot());
  try {
    // Everything except the ownership stamp is right: the name carries the
    // prefix and the parent is the effective TMPDIR. Only the stamp guard can
    // refuse this, so deleting that guard deletes real operator data.
    assertRefusedAndUntouched(lookalike, "an unstamped lookalike");
    assert.match(
      run(CLEANUP_EXAMPLE, [lookalike]).stderr,
      /missing the ownership stamp/u,
      "the refusal must be the ownership-stamp guard specifically",
    );
  } finally {
    rmSync(lookalike, { recursive: true, force: true });
  }
});

test("cleanup-example.sh refuses a correctly stamped scratch root whose parent is not the effective TMPDIR, and leaves it byte-identical", () => {
  const nest = mkdtempSync(path.join(effectiveTmpRoot(), "erl2-cleanup-guard-nest-"));
  try {
    const scratch = makeStampedScratch(nest);
    // Correct prefix, correct stamp, wrong containment: only the
    // parent-must-be-TMPDIR guard stands between this and `rm -rf`.
    assertRefusedAndUntouched(scratch, "a stamped scratch root one level too deep");
    assert.match(
      run(CLEANUP_EXAMPLE, [scratch]).stderr,
      /must sit directly beneath/u,
      "the refusal must be the parent-must-be-TMPDIR guard specifically",
    );
  } finally {
    rmSync(nest, { recursive: true, force: true });
  }
});

test("cleanup-example.sh refuses a symbolic link to a valid scratch root, and the link's target survives byte-identical", () => {
  const tmpRoot = effectiveTmpRoot();
  const target = makeStampedScratch(tmpRoot);
  const link = path.join(tmpRoot, `${PREFIX}symlink-${process.pid}`);
  try {
    symlinkSync(target, link);
    const before = manifestOf(target);
    const result = run(CLEANUP_EXAMPLE, [link]);
    assert.notEqual(result.status, 0, "a symbolic link must be refused");
    assert.match(result.stderr, /must be a real directory, not a symbolic link/u, result.stderr);
    assert.deepEqual(manifestOf(target), before, "the link's target must be untouched");
    assert.notEqual(
      lstatSync(link, { throwIfNoEntry: false }),
      undefined,
      "the link itself must also survive",
    );
  } finally {
    rmSync(link, { force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test("cleanup-example.sh refuses a stamped scratch root that was moved out of the temporary root, and leaves it byte-identical", () => {
  const tmpRoot = effectiveTmpRoot();
  const elsewhere = mkdtempSync(path.join(tmpRoot, "erl2-cleanup-guard-moved-"));
  try {
    // Genuinely created in the right place, stamped by the same writer, then
    // moved. The stamp travels with the directory; the containment does not.
    const created = makeStampedScratch(tmpRoot);
    const moved = path.join(elsewhere, path.basename(created));
    renameSync(created, moved);
    assertRefusedAndUntouched(moved, "a stamped scratch root moved out of the temporary root");
  } finally {
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The CI exercise itself
// ---------------------------------------------------------------------------

const WORKFLOW_PATH = path.join(repoRoot, ".github", "workflows", "pr.yml");

/** The `pr` job's block, from its own key to the next job key at the same indent. */
function prJobBlock(workflow: string): string {
  const start = workflow.indexOf("\n  pr:\n");
  assert.ok(start >= 0, "the `pr` job must exist — it is a required check name");
  const next = workflow.indexOf("\n  cross-platform-golden:\n", start + 1);
  assert.ok(next > start, "the `cross-platform-golden` job must follow — it is a required check name");
  return workflow.slice(start, next);
}

/**
 * The `pr` job's steps, split structurally into one block per list item. A step
 * begins at six-space `- ` and runs until the next one, so each block holds
 * that step's own keys — `name`, `run`, `if`, `timeout-minutes`,
 * `continue-on-error` — and no other step's.
 */
function stepBlocks(jobBlock: string): readonly string[] {
  const stepsAt = jobBlock.indexOf("\n    steps:\n");
  assert.ok(stepsAt >= 0, "the `pr` job must declare steps");
  const lines = jobBlock.slice(stepsAt + "\n    steps:\n".length).split("\n");
  const blocks: string[] = [];
  let current: string[] | undefined;
  for (const line of lines) {
    if (line.startsWith("      - ")) {
      if (current !== undefined) blocks.push(current.join("\n"));
      current = [line];
      continue;
    }
    if (current === undefined) continue;
    if (line.trim() !== "" && !line.startsWith("       ") && !line.startsWith("      ")) break;
    current.push(line);
  }
  if (current !== undefined) blocks.push(current.join("\n"));
  assert.ok(blocks.length > 0, "the `pr` job must have parsed into steps");
  return blocks;
}

function stepContaining(blocks: readonly string[], needle: string | RegExp, what: string): string {
  const matches = blocks.filter((block) =>
    typeof needle === "string" ? block.includes(needle) : needle.test(block),
  );
  assert.equal(
    matches.length,
    1,
    `the \`pr\` job must contain exactly one step that ${what} (found ${matches.length})`,
  );
  return matches[0] as string;
}

test("the `pr` job still runs the whole M3 example exercise, in order and fail-closed", () => {
  const workflow = readFileSync(WORKFLOW_PATH, "utf8");
  const job = prJobBlock(workflow);
  const blocks = stepBlocks(job);

  // The four steps the exercise is made of. Each is located by what it does,
  // not by its name, so renaming a step does not silently drop the assertion —
  // deleting it does.
  const runsExample = stepContaining(blocks, "run-example.sh", "runs the worked example");
  const verifiesSuccess = stepContaining(
    blocks,
    '"cleanup_status": "cleanup_complete"',
    "asserts the independent verifier reported success",
  );
  const cleansUp = stepContaining(blocks, "cleanup-example.sh", "invokes the guarded cleanup");
  const provesClean = stepContaining(blocks, "git status --porcelain", "proves a clean working tree");

  // Ordering: the example must run before anything reads its log, cleanup must
  // follow the verification, and the residue proof must come last.
  const order = [runsExample, verifiesSuccess, cleansUp, provesClean].map((block) =>
    blocks.indexOf(block),
  );
  assert.deepEqual(
    order,
    [...order].sort((a, b) => a - b),
    "the exercise must run, verify, clean up and then prove the tree clean, in that order",
  );

  // The cleanup step must go through the guarded script and must prove removal.
  assert.match(
    cleansUp,
    /cleanup-example\.sh "\$scratch"/u,
    "cleanup must run the guarded script on the scratch root the example printed",
  );
  assert.match(cleansUp, /test ! -e "\$scratch"/u, "cleanup must prove the scratch root is gone");
  // The residue step must fail, not merely report.
  assert.match(provesClean, /exit 1/u, "a dirty working tree must fail the job");

  // No M3 step may be neutralised.
  for (const [label, block] of [
    ["the example run", runsExample],
    ["the verifier assertion", verifiesSuccess],
    ["the guarded cleanup", cleansUp],
    ["the residue proof", provesClean],
  ] as const) {
    assert.doesNotMatch(
      block,
      /continue-on-error/u,
      `${label} must not tolerate its own failure`,
    );
    assert.doesNotMatch(
      block,
      /^\s+if:/mu,
      `${label} must run unconditionally — a condition here could be made always-false`,
    );
    assert.match(block, /set -euo pipefail/u, `${label} must fail closed inside its own shell`);
    assert.doesNotMatch(block, /\|\|\s*true/u, `${label} must not swallow a failure`);
    assert.doesNotMatch(block, /set \+e/u, `${label} must not disable shell error checking`);
  }

  // The example step keeps its own hang-cut, independent of the job bound.
  assert.match(
    runsExample,
    /^ {8}timeout-minutes: 5$/mu,
    "the example step must retain its own timeout",
  );
});

test("the workflow's job, trigger, permission and timeout structure is unchanged around the M3 steps", () => {
  const workflow = readFileSync(WORKFLOW_PATH, "utf8");

  // Required check names, exactly as ruleset 21102689 names them.
  assert.match(workflow, /\n {2}pr:\n/u, "the `pr` required check name must be unchanged");
  assert.match(
    workflow,
    /\n {2}cross-platform-golden:\n/u,
    "the `cross-platform-golden` required check name must be unchanged",
  );
  assert.match(
    workflow,
    /os:\s*\[ubuntu-latest,\s*macos-latest\]/u,
    "both required cross-platform legs must be unchanged",
  );
  const jobsSection = workflow.slice(workflow.indexOf("\njobs:\n"));
  assert.ok(jobsSection.startsWith("\njobs:\n"), "the workflow must declare a jobs section");
  assert.deepEqual(
    [...jobsSection.matchAll(/^ {2}([a-z0-9-]+):$/gmu)].map((match) => match[1]),
    ["pr", "cross-platform-golden"],
    "the workflow must declare exactly these two jobs",
  );

  // Triggers and permissions.
  assert.match(workflow, /^on:\n {2}pull_request:\n {2}push:\n {4}branches: \[main\]$/mu, "the triggers must be unchanged");
  assert.match(workflow, /^permissions:\n {2}contents: read$/mu, "permissions must stay read-only");

  // Both job-level bounds survive.
  assert.match(prJobBlock(workflow), /^ {4}timeout-minutes: 60$/mu, "the `pr` job bound must remain");
  assert.match(
    workflow.slice(workflow.indexOf("\n  cross-platform-golden:\n")),
    /^ {4}timeout-minutes: 10$/mu,
    "the `cross-platform-golden` job bound must remain",
  );

  // Nothing anywhere in the workflow may ignore a failure.
  assert.doesNotMatch(workflow, /continue-on-error/u, "no step may tolerate its own failure");
  assert.doesNotMatch(workflow, /if:\s*always\(\)/u, "no step may run unconditionally after failure");
  assert.doesNotMatch(workflow, /if:\s*(false|'false'|"false")/u, "no step may be disabled outright");
});
