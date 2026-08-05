/**
 * The evidence harness's staging root: equal path shape, and no residue.
 *
 * ## What was broken
 *
 * `evidence:update` generated the adapter-platform runs directly beneath
 * `fixtures/golden` while `evidence:verify` generated them beneath a random
 * `os.tmpdir()` directory. The two roots have different absolute path lengths,
 * the adapter host bakes the run's absolute adapter-workspace path into the
 * request frames, and `sandbox-invocation-result/v1` retains the true
 * `request_bytes` — so the two generations produced different sandbox-result core
 * hashes, and that difference propagated into detail record hashes, step
 * outcomes, lifecycle events, snapshots, the subject-output manifest, the
 * content-addressed copies and the terminal hashes. The byte-pin could not hold.
 *
 * The first correction made two staging roots equal in length *to each other*.
 * The independent review measured why that is not enough: their common length
 * still contained `repoRoot`, so the pin held on one checkout and failed on every
 * other — a ten-character difference in the repository root moved `request_bytes`
 * by twenty. The staging root's **complete absolute byte length** is therefore a
 * documented constant, padded from the measured UTF-8 byte length of its parent.
 *
 * ## What these controls assert
 *
 *  - that every staging root is exactly `STAGING_ROOT_TARGET_BYTES` bytes,
 *    across materially different checkout lengths and non-ASCII path components,
 *    plus the checkout-dependent counter-example it replaced;
 *  - that a checkout too deep to pad, and a padding too wide for a path
 *    component, are both refused before anything is generated;
 *  - that a staging root is parallel-safe rather than one shared fixed directory,
 *    and that its sibling work root is too;
 *  - that the root is removed after a clean finish, after an early `process.exit`,
 *    after an uncaught throw and after an interrupt — each driven by really
 *    ending a real process that way, in a throwaway checkout root;
 *  - that no mode of `generate-evidence.mjs` generates into `fixtures/golden`;
 *  - that `--out` refuses to overwrite a directory the harness did not create.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ArtifactStore } from "@erl2/integrity";
import { AdapterHost, SteppingClock } from "@erl2/core";
import {
  acquisitionRequest,
  referenceAdapterEntry,
  REFERENCE_CORRECT_MANIFEST,
} from "../support/adapterFixtures.js";
import { ownedTempDir } from "../support/tempDirs.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const script = path.join(repoRoot, "scripts", "generate-evidence.mjs");
const stagingModule = pathToFileURL(path.join(repoRoot, "scripts", "lib", "evidenceStaging.mjs")).href;

const {
  createStagingRoot,
  stagingPadding,
  stagingParent,
  STAGING_PREFIX,
  WORK_PREFIX,
  STAGING_ROOT_TARGET_BYTES,
} = (await import(stagingModule)) as {
  createStagingRoot: (
    repoRoot: string,
    options?: { targetBytes?: number },
  ) => { stagingRoot: string; workRoot: string; release: () => void };
  stagingPadding: (parent: string, targetBytes?: number) => { padding?: string; refusal?: string };
  stagingParent: (repoRoot: string) => string;
  STAGING_PREFIX: string;
  WORK_PREFIX: string;
  STAGING_ROOT_TARGET_BYTES: number;
};

/** Bytes, never characters — the measure that agrees with the request frame. */
const bytes = (value: string): number => Buffer.byteLength(value, "utf8");

/**
 * Ends a child process the given way, with a staging root already created under
 * a throwaway checkout root, and reports what survived.
 *
 * The child is a real process created by the real `createStagingRoot`, so what is
 * measured is the cleanup the harness actually installs — not a re-description of
 * it here.
 */
function endedProcessResidue(how: "return" | "exit" | "throw" | "interrupt"): {
  readonly status: number | null;
  readonly stagingRoot: string;
  readonly survived: boolean;
  readonly parentSurvived: boolean;
} {
  const fakeRepoRoot = ownedTempDir("erl2-staging-checkout-");
  const childPath = path.join(ownedTempDir("erl2-staging-child-"), "child.mjs");
  writeFileSync(
    childPath,
    [
      `import { createStagingRoot } from ${JSON.stringify(stagingModule)};`,
      `import { writeFileSync } from "node:fs";`,
      `import path from "node:path";`,
      `const { stagingRoot } = createStagingRoot(${JSON.stringify(fakeRepoRoot)});`,
      // A staging root with something in it: an empty directory would be removed
      // by a weaker cleanup than the one under test.
      `writeFileSync(path.join(stagingRoot, "partial-evidence.json"), "{}\\n");`,
      `process.stdout.write(stagingRoot + "\\n");`,
      how === "exit"
        ? `process.exit(7);`
        : how === "throw"
          ? `throw new Error("generation failed");`
          : how === "interrupt"
            ? // A real timer, so the event loop is genuinely idle when the signal
              // arrives, and the process would otherwise outlive the test.
              `process.kill(process.pid, "SIGINT"); setTimeout(() => process.exit(99), 10_000);`
            : `/* return normally */`,
      "",
    ].join("\n"),
  );

  const run = spawnSync(process.execPath, [childPath], { encoding: "utf8" });
  const stagingRoot = run.stdout.trim().split("\n").pop() as string;
  assert.ok(
    stagingRoot !== undefined && stagingRoot.length > 0,
    `the child never reported a staging root (${run.stderr})`,
  );
  return {
    status: run.status,
    stagingRoot,
    survived: existsSync(stagingRoot),
    parentSurvived: existsSync(stagingParent(fakeRepoRoot)),
  };
}

test("EVIDENCE-STAGING: every staging root is the documented absolute byte length, whatever the checkout", () => {
  // Checkout roots of materially different lengths, and one whose components are
  // not ASCII. A path containing `café` occupies more bytes than characters, and
  // it is bytes that reach the request frame — a padding computed from character
  // count would be silently short here and nowhere else.
  const checkouts = [
    ownedTempDir("a-"),
    ownedTempDir("erl2-a-much-longer-simulated-checkout-root-name-"),
    path.join(ownedTempDir("erl2-nonascii-"), "café-Ω-日本語"),
    path.join(ownedTempDir("erl2-nested-"), "one", "two", "three", "four", "five"),
  ];

  const created: { stagingRoot: string; workRoot: string; release: () => void }[] = [];
  try {
    for (const checkout of checkouts) {
      mkdirSync(checkout, { recursive: true });
      const handle = createStagingRoot(checkout);
      created.push(handle);

      assert.equal(
        bytes(handle.stagingRoot),
        STAGING_ROOT_TARGET_BYTES,
        `staging root under a ${String(bytes(checkout))}-byte checkout is ` +
          `${String(bytes(handle.stagingRoot))} bytes: ${handle.stagingRoot}`,
      );
      assert.equal(
        bytes(handle.workRoot),
        STAGING_ROOT_TARGET_BYTES,
        `work root under a ${String(bytes(checkout))}-byte checkout is ` +
          `${String(bytes(handle.workRoot))} bytes: ${handle.workRoot}`,
      );
      assert.equal(path.dirname(handle.stagingRoot), stagingParent(checkout));
      assert.ok(path.basename(handle.stagingRoot).includes(STAGING_PREFIX));
      assert.ok(path.basename(handle.workRoot).includes(WORK_PREFIX));
    }

    // The checkouts really did differ in length, or this control is vacuous.
    const checkoutLengths = new Set(checkouts.map(bytes));
    assert.ok(checkoutLengths.size >= 3, "the simulated checkouts must differ in byte length");
    // At least one differs in bytes from its character count, or the non-ASCII
    // half of the control proves nothing.
    assert.ok(
      checkouts.some((c) => bytes(c) !== c.length),
      "one checkout must contain multi-byte characters",
    );

    // Every root, across every checkout, is one length.
    const allLengths = new Set(created.flatMap((h) => [bytes(h.stagingRoot), bytes(h.workRoot)]));
    assert.deepEqual([...allLengths], [STAGING_ROOT_TARGET_BYTES]);

    // The counter-example this replaced: the pre-fix roots inherited the
    // checkout's length, which is exactly what moved `request_bytes` between a
    // developer's checkout and CI's.
    const unpadded = checkouts.map((c) => bytes(path.join(stagingParent(c), "stage-abcdef")));
    assert.ok(
      new Set(unpadded).size > 1,
      "the pre-fix construction is expected to vary with the checkout; if it no longer does, this control is vacuous",
    );
  } finally {
    for (const handle of created) handle.release();
  }
});

test("EVIDENCE-STAGING: each generation gets its own staging and work root", () => {
  const checkout = ownedTempDir("erl2-staging-checkout-");
  const a = createStagingRoot(checkout);
  const b = createStagingRoot(checkout);
  try {
    const roots = [a.stagingRoot, a.workRoot, b.stagingRoot, b.workRoot];
    assert.equal(new Set(roots).size, 4, `two generations shared a root: ${roots.join(", ")}`);
    // Paired by one token, so a listing shows which work root belongs to which
    // staged tree — and so no second draw can collide with another process.
    assert.equal(
      path.basename(a.stagingRoot).replace(STAGING_PREFIX, WORK_PREFIX),
      path.basename(a.workRoot),
    );
    // The work root is a sibling of the staged tree, never inside it: anything
    // inside would be published into `fixtures/golden`.
    assert.equal(path.dirname(a.workRoot), path.dirname(a.stagingRoot));
    assert.ok(!a.workRoot.startsWith(`${a.stagingRoot}${path.sep}`));
  } finally {
    a.release();
    b.release();
  }
});

test("EVIDENCE-STAGING: an unpaddable checkout is refused before anything is generated", () => {
  // A checkout too deep to reach the target length. Refused, and named: silently
  // generating a shorter root would produce evidence that cannot be reproduced
  // anywhere else, which is the failure this whole mechanism exists to prevent.
  const deep = path.join(ownedTempDir("erl2-overlong-"), "x".repeat(200));
  mkdirSync(deep, { recursive: true });
  assert.ok(
    bytes(stagingParent(deep)) > STAGING_ROOT_TARGET_BYTES,
    "the fixture must actually exceed the target",
  );

  const padded = stagingPadding(stagingParent(deep));
  assert.equal(padded.padding, undefined);
  assert.match(padded.refusal as string, /too deep for reproducible evidence/);

  assert.throws(
    () => createStagingRoot(deep),
    /too deep for reproducible evidence/,
    "an overlong checkout must refuse rather than generate",
  );
  // Refused *before* anything was created.
  assert.equal(existsSync(stagingParent(deep)), false, "the refusal created a staging parent");
});

test("EVIDENCE-STAGING: padding wider than a path component is refused", () => {
  // Reachable only through the target seam: at the shipped 200-byte target the
  // widest possible padding is far below the 255-byte component limit, so this
  // guard would otherwise be unreachable and therefore unproven.
  const checkout = ownedTempDir("erl2-wide-pad-");
  const padded = stagingPadding(stagingParent(checkout), 4096);
  assert.equal(padded.padding, undefined);
  assert.match(padded.refusal as string, /exceeds the 255-byte filesystem limit/);
  assert.throws(() => createStagingRoot(checkout, { targetBytes: 4096 }), /255-byte filesystem limit/);
});

test("EVIDENCE-STAGING: the staging root is removed after a clean finish, an exit, a throw and an interrupt", () => {
  for (const [how, expectedStatus] of [
    ["return", 0],
    ["exit", 7],
    ["throw", 1],
    ["interrupt", 130],
  ] as const) {
    const residue = endedProcessResidue(how);
    assert.equal(residue.status, expectedStatus, `the ${how} child ended unexpectedly`);
    assert.equal(
      residue.survived,
      false,
      `a process that ended by ${how} left ${residue.stagingRoot} behind`,
    );
    assert.equal(
      residue.parentSurvived,
      false,
      `a process that ended by ${how} left an empty staging parent behind`,
    );
  }
});

test("EVIDENCE-STAGING: no mode generates into fixtures/golden, and staging is not a fixed shared directory", () => {
  const source = readFileSync(script, "utf8");

  // The generation root is assigned exactly once, from the shared module, so no
  // mode can quietly pick a different root with a different length.
  assert.match(
    source,
    /const \{ stagingRoot, workRoot \} = createStagingRoot\(root\);/,
    "both roots must come from one createStagingRoot call",
  );
  assert.equal(
    (source.match(/^const \{ stagingRoot, workRoot \}/gm) ?? []).length,
    1,
    "the roots must be assigned exactly once",
  );

  // No execution root may be a fixed shared path any more: two concurrent
  // generations used to delete each other's `.erl2-work/evidence/<label>` runs,
  // and the environment run's `os.tmpdir()` directory was never removed at all.
  assert.equal(
    source.includes('path.join(root, ".erl2-work", "evidence", label)'),
    false,
    "the generic-finalization runs must not share a fixed work root",
  );
  assert.equal(
    source.includes("erl2-environment-run-"),
    false,
    "the environment run must not create an unreleased tmpdir root",
  );
  for (const owned of ['path.join(workRoot, "generic-finalization", label)', 'path.join(workRoot, "environment-run")']) {
    assert.ok(source.includes(owned), `execution must happen in this generation's work root: ${owned}`);
  }

  // `fixtures/golden` may be named only as the pin to compare against and as the
  // publish target — never as somewhere a run is generated.
  const goldenReferences = source.match(/path\.join\(root, "fixtures", "golden"\)/g) ?? [];
  assert.equal(
    goldenReferences.length,
    1,
    "fixtures/golden must be resolved once, as `pinnedRoot`, and never as a generation root",
  );
  assert.match(source, /const pinnedRoot = path\.join\(root, "fixtures", "golden"\);/);
});

test("EVIDENCE-STAGING: --out refuses a directory the harness did not create", () => {
  const occupied = ownedTempDir("erl2-evidence-out-occupied-");
  writeFileSync(path.join(occupied, "someone-elses-file.txt"), "not evidence\n");

  const refused = spawnSync(process.execPath, [script, "--out", occupied], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(refused.status, 2, refused.stderr);
  assert.match(refused.stderr, /refusing to overwrite/);
  // The refusal is a refusal: the directory is untouched and nothing was staged.
  assert.deepEqual(readdirSync(occupied), ["someone-elses-file.txt"]);

  const missingValue = spawnSync(process.execPath, [script, "--out"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(missingValue.status, 2, missingValue.stderr);
  assert.match(missingValue.stderr, /--out requires a directory path/);
});

test("EVIDENCE-STAGING: a real adapter under two different-length checkouts retains identical request_bytes", () => {
  // The property the pin actually depends on, measured end to end rather than
  // argued from path arithmetic: two staging roots generated from checkouts of
  // materially different length, each driving a real out-of-process adapter
  // through the real host.
  const checkouts = [
    ownedTempDir("s-"),
    path.join(ownedTempDir("erl2-a-considerably-longer-checkout-root-"), "nested", "deeper"),
  ];
  assert.notEqual(bytes(checkouts[0] as string), bytes(checkouts[1] as string));

  const handles: { stagingRoot: string; workRoot: string; release: () => void }[] = [];
  try {
    const observed = checkouts.map((checkout) => {
      mkdirSync(checkout, { recursive: true });
      const handle = createStagingRoot(checkout);
      handles.push(handle);

      const host = new AdapterHost({
        runId: "00000000-0000-7000-8000-000000000001",
        adapterManifest: REFERENCE_CORRECT_MANIFEST(),
        adapterEntryPath: referenceAdapterEntry("reference-correct"),
        // The staged tree's own adapter workspace, exactly as the harness lays it out.
        workspaceRoot: path.join(handle.stagingRoot, "adapter-platform", "run", "adapter-workspace"),
        store: new ArtifactStore(path.join(handle.workRoot, "store")),
        clock: new SteppingClock("2026-07-01T00:00:00Z", 1000),
        wallClockMs: 20_000,
        // Every other input to the record's core hash is fixed, including the one
        // measurement that cannot be: this is the evidence-fixture seam, used here
        // for the same reason the harness uses it.
        evidenceFixtureWallClockMs: 0,
      });
      const result = host.run({
        operation: "acquire",
        operationId: "op-acquire",
        request: acquisitionRequest("op-acquire"),
      });
      const frames = readFileSync(
        path.join(handle.stagingRoot, "adapter-platform", "run", "adapter-workspace", "op-acquire", "request.frames"),
      );
      return { frames, result: result.sandboxResult };
    });

    const [a, b] = observed as [(typeof observed)[number], (typeof observed)[number]];

    // The frames carry different absolute paths — they must, the checkouts differ.
    assert.notDeepEqual(a.frames, b.frames, "the frames should differ in their path bytes");
    // …and are nevertheless the same length, which is the whole point.
    assert.equal(
      a.frames.byteLength,
      b.frames.byteLength,
      `frame lengths diverged: ${String(a.frames.byteLength)} vs ${String(b.frames.byteLength)}`,
    );
    // The retained accounting is the true frame length, not a normalized one.
    assert.equal(a.result.request_bytes, a.frames.byteLength);
    assert.equal(b.result.request_bytes, b.frames.byteLength);
    assert.equal(a.result.request_bytes, b.result.request_bytes);
    // And with every other input fixed, the retained record is byte-identical —
    // so nothing downstream of it can move with the checkout location either.
    assert.equal(a.result.core_hash, b.result.core_hash);
  } finally {
    for (const handle of handles) handle.release();
  }
});

test("EVIDENCE-STAGING: two concurrent generations share no mutable execution directory", async () => {
  // The failure this replaces: the three generic-finalization runs executed in
  // `<repoRoot>/.erl2-work/evidence/<label>`, which each generation deleted on
  // entry — so a second generation running at the same time destroyed the first's
  // execution state mid-run. Two real processes, one checkout, at the same time.
  const checkout = ownedTempDir("erl2-concurrent-checkout-");
  const childPath = path.join(ownedTempDir("erl2-concurrent-child-"), "child.mjs");
  writeFileSync(
    childPath,
    [
      `import { createStagingRoot } from ${JSON.stringify(stagingModule)};`,
      `import { mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";`,
      `import path from "node:path";`,
      `const marker = process.argv[2];`,
      `const { stagingRoot, workRoot, release } = createStagingRoot(${JSON.stringify(checkout)});`,
      // Write into the same *logical* execution path both generations use.
      `const runRoot = path.join(workRoot, "generic-finalization", "generic-finalization-failed-verification");`,
      `mkdirSync(runRoot, { recursive: true });`,
      `writeFileSync(path.join(runRoot, "execution-state.json"), marker);`,
      // Hold both roots open across the other process's whole lifetime.
      `await new Promise((r) => setTimeout(r, 1500));`,
      // What survived is what this process wrote, or the isolation failed.
      `const seen = readFileSync(path.join(runRoot, "execution-state.json"), "utf8");`,
      `process.stdout.write(JSON.stringify({ marker, seen, stagingRoot, workRoot, siblings: readdirSync(path.dirname(workRoot)).length }));`,
      `release();`,
      "",
    ].join("\n"),
  );

  const run = (marker: string): Promise<{ marker: string; seen: string; stagingRoot: string; workRoot: string; siblings: number }> =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [childPath, marker], { encoding: "utf8" } as never);
      let out = "";
      child.stdout?.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
      child.on("error", reject);
      child.on("exit", (code) => {
        if (code !== 0) return reject(new Error(`child ${marker} exited ${String(code)}`));
        resolve(JSON.parse(out) as never);
      });
    });

  const [first, second] = await Promise.all([run("generation-a"), run("generation-b")]);

  // Each generation read back its own execution state, not the other's.
  assert.equal(first.seen, "generation-a", "a concurrent generation overwrote this one's execution state");
  assert.equal(second.seen, "generation-b", "a concurrent generation overwrote this one's execution state");
  // Four distinct roots, and both processes really were alive together.
  assert.equal(new Set([first.stagingRoot, first.workRoot, second.stagingRoot, second.workRoot]).size, 4);
  assert.ok(
    first.siblings >= 4 && second.siblings >= 4,
    "the two generations did not overlap; the control proves nothing",
  );
  // Both released: nothing is left under the shared parent.
  assert.equal(
    existsSync(stagingParent(checkout)) ? readdirSync(stagingParent(checkout)).length : 0,
    0,
    "a concurrent generation left roots behind",
  );
});
