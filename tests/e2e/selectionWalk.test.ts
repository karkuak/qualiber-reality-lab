/**
 * The durable selection walk, driven entirely through the shipped `erl2` binary
 * (ADR-ERL2-020 §6).
 *
 * Every invocation below is a separate OS process that shares nothing with the
 * last but the run directory. That is deliberate: an in-process harness would
 * have to reproduce the CLI's wiring, and a second copy of that wiring drifts —
 * during development this suite and `erl2 select` disagreed about operator
 * identities and custodian key labels until both were fixed. There is now one
 * composition root, `packages/cli/src/selectCommand.ts`, and this exercises it.
 *
 * ## What "the beacon is observed once" means here
 *
 * Across processes there is no in-memory counter to read, so the property is
 * asserted from the **durable trace**, which is what an auditor would actually
 * have: exactly one `selection_randomness_receipt_frozen` lifecycle event and
 * exactly one retained randomness receipt, for every crash/resume path.
 *
 * A second observation is unreachable rather than merely unobserved. The step
 * that draws a round fires only from `independent_randomness_requested` and
 * lands in `selection_randomness_receipt_frozen`; lifecycle transitions are
 * one-way, so that step cannot be re-entered. The only way back into it would be
 * a resume *inside* the window, and that refuses
 * (`SELECTION_RANDOMNESS_RETRY_FORBIDDEN`). `DevelopmentBeaconSource` also
 * refuses a second draw within a process, which the final case pins directly.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { chmodSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DevelopmentBeaconSource } from "@erl2/core";
import { erl2, runToAcquired } from "../support/cliRun.js";
import type { GovernorRegistry } from "../support/governorRegistry.js";

interface Run {
  readonly runRoot: string;
  readonly runId: string;
  readonly registry: GovernorRegistry;
  readonly sourceTrustConfig: string;
}

/** A run driven through the shipped CLI to `challenge_preregistered`. */
function preregisteredRun(): Run {
  const run = runToAcquired();
  const base = [
    "--run-root", run.runRoot,
    "--registry", run.registry.root,
    "--tier", "development",
    "--run", run.runId,
  ];
  assert.equal(erl2(["freeze-package", ...base]).exitCode, 0);
  assert.equal(
    erl2([
      "verify-package", ...base,
      "--fake-verify-package", "succeeded",
      "--subject-id", "s",
      "--subject-version", "0.1.0",
    ]).exitCode,
    0,
  );
  const prereg = erl2([
    "preregister-challenge", ...base,
    "--journey-selection-policy", run.registry.journeySelectionPolicyHash,
    "--randomness-policy", run.registry.randomnessPolicyHash,
    ...run.registry.challengeCandidates.flatMap((c) => ["--challenge", c.challengeManifestHash]),
  ]);
  assert.equal(prereg.exitCode, 0, JSON.stringify(prereg.body.errors));

  const sourceTrustConfig = path.join(run.runRoot, "source-trust.json");
  writeFileSync(
    sourceTrustConfig,
    JSON.stringify({
      sourceTrustPolicyHash: run.registry.sourceTrustPolicyHash,
      randomnessRegistryHeadHash: run.registry.sourceTrustPolicyHash,
    }),
  );
  return { runRoot: run.runRoot, runId: run.runId, registry: run.registry, sourceTrustConfig };
}

function selectArgv(run: Run, extra: readonly string[] = []): readonly string[] {
  return [
    "select",
    "--run-root", run.runRoot,
    "--registry", run.registry.root,
    "--tier", "development",
    "--run", run.runId,
    "--source-trust-config", run.sourceTrustConfig,
    "--expires", "2026-12-31T00:00:00Z",
    ...extra,
  ];
}

/** Reads the durable lifecycle log the way an offline auditor would. */
function lifecycleEvents(
  run: Run,
): readonly { event_type: string; produced?: { artifact_role: string }[] }[] {
  const dir = path.join(run.runRoot, "events");
  return readdirSync(dir)
    .sort()
    .map(
      (name) =>
        JSON.parse(readFileSync(path.join(dir, name), "utf8")) as {
          event_type: string;
          produced?: { artifact_role: string }[];
        },
    );
}

function countEvents(run: Run, eventType: string): number {
  return lifecycleEvents(run).filter((e) => e.event_type === eventType).length;
}

function countProduced(run: Run, role: string): number {
  // Not every lifecycle event produces artifacts — the randomness *request* is
  // deliberately one that does not.
  return lifecycleEvents(run)
    .flatMap((e) => e.produced ?? [])
    .filter((p) => p.artifact_role === role).length;
}

/** Full-tree byte manifest, excluding the lease and the test's own config files. */
function manifest(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const rec = (dir: string, base: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const absolute = path.join(dir, entry.name);
      const relative = base + entry.name;
      if (entry.isDirectory()) {
        out.set(`${relative}/`, "dir");
        rec(absolute, `${relative}/`);
        continue;
      }
      out.set(relative, createHash("sha256").update(readFileSync(absolute)).digest("hex"));
    }
  };
  rec(root, "");
  return out;
}

function changed(before: Map<string, string>, after: Map<string, string>): readonly string[] {
  const out: string[] = [];
  for (const [key, value] of after) if (before.get(key) !== value) out.push(key);
  for (const key of before.keys()) if (!after.has(key)) out.push(`-${key}`);
  return out.filter(
    (p) => !p.includes("lease") && !/^(source-trust|malformed|incomplete)\.json$/.test(p),
  );
}

const TERMINAL = "case_selected";
/**
 * Prelude (role audit, pool), the eleven chain transitions, and the design's own
 * last selection transition — `selection_receipt_verified -> case_selected`,
 * which checks the opened binding against the admitted challenge family.
 */
const TOTAL_STEPS = 14;

test("SELECT-CLI: an uninterrupted select reaches the selected case", () => {
  const run = preregisteredRun();
  const result = erl2(selectArgv(run));
  assert.equal(result.exitCode, 0, JSON.stringify(result.body.errors));
  assert.equal(result.body.state, TERMINAL);

  const data = result.body.data as { steps_run: number; selection_complete: boolean };
  assert.equal(data.steps_run, TOTAL_STEPS);
  assert.equal(data.selection_complete, true);
  assert.equal(countEvents(run, "selection_randomness_receipt_frozen"), 1);
  assert.equal(countProduced(run, "selection-randomness-receipt"), 1);
});

test("SELECT-CLI-CRASH: crashing at every boundary still completes, with one randomness observation", () => {
  for (let crashAfter = 1; crashAfter <= TOTAL_STEPS; crashAfter += 1) {
    const run = preregisteredRun();

    const first = erl2(selectArgv(run, ["--max-steps", String(crashAfter)]));
    assert.equal(
      first.exitCode,
      0,
      `stop after ${String(crashAfter)}: ${JSON.stringify(first.body.errors)}`,
    );

    // The unresumable window: the run durably recorded its intent to observe
    // randomness and stopped before the receipt was frozen. Resuming would risk
    // a second draw, so it refuses and the run must be invalidated.
    if (first.body.state === "independent_randomness_requested") {
      const refused = erl2(selectArgv(run));
      assert.notEqual(refused.exitCode, 0, "a resume inside the beacon window must refuse");
      assert.equal(refused.body.errors[0]?.code, "SELECTION_RANDOMNESS_RETRY_FORBIDDEN");
      assert.equal(countEvents(run, "selection_randomness_receipt_frozen"), 0, "no receipt was frozen");
      continue;
    }

    const second = erl2(selectArgv(run));
    assert.equal(
      second.exitCode,
      0,
      `resume after ${String(crashAfter)}: ${JSON.stringify(second.body.errors)}`,
    );
    assert.equal(second.body.state, TERMINAL, `resume after ${String(crashAfter)} must complete`);

    // The durable trace: one observation, one receipt, however the run was cut.
    assert.equal(
      countEvents(run, "selection_randomness_receipt_frozen"),
      1,
      `crash after ${String(crashAfter)} froze the randomness receipt more than once`,
    );
    assert.equal(countProduced(run, "selection-randomness-receipt"), 1);
    assert.equal(countProduced(run, "selection-verification-receipt"), 1);
  }
});

test("SELECT-CLI: a completed select is idempotent and adds nothing", () => {
  const run = preregisteredRun();
  assert.equal(erl2(selectArgv(run)).body.state, TERMINAL);
  const before = manifest(run.runRoot);

  const again = erl2(selectArgv(run));
  assert.equal(again.exitCode, 0, JSON.stringify(again.body.errors));
  assert.equal((again.body.data as { steps_run: number }).steps_run, 0, "a completed walk runs no steps");
  assert.deepEqual(changed(before, manifest(run.runRoot)), [], "a completed walk adds no evidence");
});

test("SELECT-CLI: the selection request binds the run's own retained artifacts", () => {
  const run = preregisteredRun();
  assert.equal(erl2(selectArgv(run)).body.state, TERMINAL);

  const request = JSON.parse(
    readFileSync(path.join(run.runRoot, "retained", "selection", "selection-request.json"), "utf8"),
  ) as Record<string, string>;
  const retained = (name: string): string =>
    (
      JSON.parse(readFileSync(path.join(run.runRoot, "retained", name), "utf8")) as {
        core_hash: string;
      }
    ).core_hash;

  // No placeholder hashes: every binding names an artifact this run retained.
  assert.equal(request["acquisition_preregistration_hash"], retained("acquisition-preregistration.json"));
  assert.equal(request["acquisition_source_manifest_hash"], retained("acquisition-source-manifest.json"));
  assert.equal(request["adapter_manifest_hash"], retained("adapter-manifest.json"));
  assert.equal(request["generic_run_policy_hash"], retained("generic-run-policy.json"));
  assert.equal(request["journey_selection_policy_hash"], retained("journey-selection-policy.json"));
  assert.equal(request["selection_randomness_policy_hash"], retained("selection-randomness-policy.json"));
  assert.equal(request["requested_tier"], "development", "ERL2-OQ-007: development tier only");
});

/*
 * ADR-ERL2-019 §4 for `select` — a refusal adds zero retained evidence.
 *
 * `select` freezes into `retained/selection/` and observes a beacon, so a
 * refusal that had already written half a stage would leave a run that either
 * cannot be resumed or resumes past the randomness window on partial evidence.
 *
 * Each case runs twice: on a fresh run, and on one stopped mid-walk, because the
 * second is where a partial write would hide against a populated tree.
 */
test("SELECT-NO-WRITE: every refused select adds zero retained evidence", () => {
  const run = preregisteredRun();
  const malformed = path.join(run.runRoot, "malformed.json");
  writeFileSync(malformed, "{ not json");
  const incomplete = path.join(run.runRoot, "incomplete.json");
  writeFileSync(incomplete, JSON.stringify({ sourceTrustPolicyHash: run.registry.sourceTrustPolicyHash }));

  const base = [
    "--run-root", run.runRoot,
    "--registry", run.registry.root,
    "--tier", "development",
    "--run", run.runId,
  ];
  const expires = ["--expires", "2026-12-31T00:00:00Z"];
  const cases: readonly (readonly [string, readonly string[]])[] = [
    ["missing --source-trust-config", ["select", ...base, ...expires]],
    [
      "nonexistent source trust config",
      ["select", ...base, "--source-trust-config", path.join(run.runRoot, "nope.json"), ...expires],
    ],
    ["malformed source trust config", ["select", ...base, "--source-trust-config", malformed, ...expires]],
    ["incomplete source trust config", ["select", ...base, "--source-trust-config", incomplete, ...expires]],
    ["missing --expires", ["select", ...base, "--source-trust-config", run.sourceTrustConfig]],
    [
      "non-integer --max-steps",
      ["select", ...base, "--source-trust-config", run.sourceTrustConfig, ...expires, "--max-steps", "half"],
    ],
    [
      "unknown flag",
      ["select", ...base, "--source-trust-config", run.sourceTrustConfig, ...expires, "--nope", "x"],
    ],
    [
      "duplicate flag",
      [
        "select", ...base,
        "--source-trust-config", run.sourceTrustConfig,
        "--source-trust-config", run.sourceTrustConfig,
        ...expires,
      ],
    ],
  ];

  const runCases = (label: string): void => {
    for (const [name, argv] of cases) {
      const before = manifest(run.runRoot);
      const result = erl2(argv);
      assert.notEqual(result.exitCode, 0, `${label}: ${name} must be refused`);
      assert.ok(result.body.errors[0]?.code, `${label}: ${name} must carry a typed code`);
      assert.deepEqual(changed(before, manifest(run.runRoot)), [], `${label}: ${name} must write nothing`);
    }
  };

  runCases("fresh");
  assert.equal(erl2(selectArgv(run, ["--max-steps", "3"])).body.state, "eligibility_pool_checkpointed");
  runCases("mid-walk");

  // No refusal damaged the run: it still resumes cleanly.
  const finished = erl2(selectArgv(run));
  assert.equal(finished.exitCode, 0, JSON.stringify(finished.body.errors));
  assert.equal(finished.body.state, TERMINAL);
});

test("SELECT-NO-WRITE: select before challenge preregistration is refused and writes nothing", () => {
  const run = runToAcquired();
  const stc = path.join(run.runRoot, "source-trust.json");
  writeFileSync(
    stc,
    JSON.stringify({
      sourceTrustPolicyHash: run.registry.sourceTrustPolicyHash,
      randomnessRegistryHeadHash: run.registry.sourceTrustPolicyHash,
    }),
  );
  const before = manifest(run.runRoot);
  const result = erl2([
    "select",
    "--run-root", run.runRoot,
    "--registry", run.registry.root,
    "--tier", "development",
    "--run", run.runId,
    "--source-trust-config", stc,
    "--expires", "2026-12-31T00:00:00Z",
  ]);
  assert.notEqual(result.exitCode, 0, "a run with no preregistered challenge cannot select");
  // Absence must never read as success: a missing input is reported, not a
  // completed selection with zero steps.
  assert.equal(result.body.errors[0]?.code, "GRAPH_CLOSURE_UNREACHABLE_ARTIFACT");
  assert.deepEqual(changed(before, manifest(run.runRoot)), [], "the refusal writes nothing");
});

/*
 * Tampered retained evidence is refused, and the refusal writes nothing.
 *
 * The tamper is caught by the artifact store's freeze-integrity check while the
 * context is assembled — it never reaches the walk. That is real and desirable,
 * but it is not evidence about mid-walk refusals; the beacon-window case below
 * is the one that tests those.
 */
test("SELECT-NO-WRITE: tampered retained evidence is refused and writes nothing", () => {
  const run = preregisteredRun();
  assert.equal(erl2(selectArgv(run, ["--max-steps", "3"])).exitCode, 0);

  const manifestPath = path.join(run.runRoot, "retained", "selection", "eligibility-pool-manifest.json");
  const poolManifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  poolManifest["pool_root_hash"] = `sha256:${"9".repeat(64)}`;
  chmodSync(manifestPath, 0o644);
  writeFileSync(manifestPath, JSON.stringify(poolManifest));

  const before = manifest(run.runRoot);
  const refused = erl2(selectArgv(run));
  assert.notEqual(refused.exitCode, 0, "a mutated retained artifact must refuse");
  assert.equal(refused.body.errors[0]?.code, "ARTIFACT_HASH_MISMATCH");
  assert.deepEqual(changed(before, manifest(run.runRoot)), [], "the refusal writes nothing");
});

/*
 * The one refusal raised *inside* the walk.
 *
 * `assertResumable` fires after the run lease is held and before any stage runs.
 * Every other refusal here happens during flag parsing, config loading or
 * context assembly, so this is the only case proving the walk itself refuses
 * without leaving a partial freeze — and the highest-stakes one, because the
 * alternative to refusing is a second beacon draw.
 */
test("SELECT-NO-WRITE: the beacon-window refusal is raised inside the walk and writes nothing", () => {
  const run = preregisteredRun();
  assert.equal(
    erl2(selectArgv(run, ["--max-steps", "4"])).body.state,
    "independent_randomness_requested",
  );

  const before = manifest(run.runRoot);
  const refused = erl2(selectArgv(run));
  assert.equal(refused.body.errors[0]?.code, "SELECTION_RANDOMNESS_RETRY_FORBIDDEN");
  assert.deepEqual(changed(before, manifest(run.runRoot)), [], "the in-walk refusal writes nothing");

  // It stays refused: a second attempt does not eventually give up and draw.
  const again = erl2(selectArgv(run));
  assert.equal(again.body.errors[0]?.code, "SELECTION_RANDOMNESS_RETRY_FORBIDDEN");
  assert.deepEqual(changed(before, manifest(run.runRoot)), [], "still writes nothing");
  assert.equal(countEvents(run, "selection_randomness_receipt_frozen"), 0);
});

/*
 * The in-process half of the single-observation rule.
 *
 * The durable trace above proves no run freezes two receipts. This pins the
 * complementary guard: within one process the beacon itself refuses a second
 * draw, so a caller cannot observe twice and keep whichever round it prefers.
 */
test("SELECT-BEACON: the development beacon refuses a second draw", () => {
  const beacon = new DevelopmentBeaconSource({
    seed: "erl2-second-draw",
    firstRoundAt: "2026-07-01T00:00:00Z",
  });
  const first = beacon.firstFinalizedRoundAfter("2026-07-01T00:01:00Z");
  assert.ok(first.roundId, "the first draw succeeds");
  assert.throws(
    () => beacon.firstFinalizedRoundAfter("2026-07-01T00:01:00Z"),
    /second draw is forbidden/,
    "a second draw for the same pool must be refused",
  );
});
