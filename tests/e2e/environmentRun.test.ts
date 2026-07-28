/**
 * The environment and journey path, driven entirely through the shipped `erl2`
 * binary (Slice 6.5-B).
 *
 * Every invocation is a separate OS process sharing nothing with the last but
 * the run directory, the governor registry, and the substrate the driver
 * provisions into. That is the whole point of the slice: `provision`, `restore`
 * and `destroy` are three different processes, and an environment driver that
 * remembered its resources in a `Map` reported a clean teardown over resources
 * it had never looked at.
 *
 * Brief §14 forbids fixture-built artifacts as completion evidence, so nothing
 * here constructs an artifact. The assertions read the run's own durable trace:
 * the lifecycle event stream and the retained tree, exactly what an offline
 * auditor would have.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { erl2, runToAcquired, verifyBundle } from "../support/cliRun.js";
import type { GovernorRegistry } from "../support/governorRegistry.js";

interface Run {
  readonly runRoot: string;
  readonly runId: string;
  readonly registry: GovernorRegistry;
  readonly base: readonly string[];
}

/** A run driven through the shipped CLI to `case_selected`. */
function selectedRun(): Run {
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
  const selected = erl2([
    "select", ...base,
    "--source-trust-config", sourceTrustConfig,
    "--expires", "2026-12-31T00:00:00Z",
  ]);
  assert.equal(selected.exitCode, 0, JSON.stringify(selected.body.errors));
  assert.equal(selected.body.state, "case_selected");
  return { runRoot: run.runRoot, runId: run.runId, registry: run.registry, base };
}

/**
 * The ordered command plan for the environment path.
 *
 * Every admitted candidate commits the same ordered intents (with its own step
 * instances), so the plan is the same whichever challenge the beacon selected —
 * which is what makes this a test of the path rather than of the draw.
 */
function environmentPlan(run: Run): readonly (readonly [string, readonly string[]])[] {
  const env = [...run.base];
  return [
    ["provision", ["provision", ...env, "--archetype", run.registry.archetypeHash]],
    ["baseline", ["baseline", ...env]],
    ["plan", ["plan", ...env]],
    ["install", ["install", ...env]],
    ["configure", ["configure", ...env]],
    ["authenticate", ["authenticate", ...env]],
    ["connect", ["connect", ...env]],
    ["execute-subject:discover", ["execute-subject", ...env]],
    ["activate", ["activate", ...env]],
    [
      "journey",
      [
        "journey", ...env,
        "--comparison-policy", run.registry.comparisonPolicyHash,
        "--cutoff-policy", run.registry.cutoffPolicyHash,
      ],
    ],
    ["observe", ["observe", ...env]],
    ["freeze-observation", ["freeze-observation", ...env]],
    ["execute-subject:exercise", ["execute-subject", ...env]],
    ["execute-subject:observe", ["execute-subject", ...env]],
    ["remove", ["remove", ...env]],
    ["freeze-output", ["freeze-output", ...env]],
    ["reveal", ["reveal", ...env, "--vault", run.registry.vaultRoot]],
    ["evaluate", ["evaluate", ...env]],
    ["restore", ["restore", ...env]],
    ["destroy", ["destroy", ...env]],
    ["finalize-generic", ["finalize-generic", ...env]],
  ];
}

function drive(run: Run, upTo = Number.POSITIVE_INFINITY, from = 0): string {
  let state: string | undefined;
  for (const [name, argv] of environmentPlan(run).slice(from, upTo)) {
    const result = erl2(argv);
    assert.equal(result.exitCode, 0, `${name}: ${JSON.stringify(result.body.errors)}`);
    state = result.body.state as string;
  }
  // A resume that had nothing left to do still has to report where the run is,
  // and it reports it the way an operator would: by asking the run.
  if (state !== undefined) return state;
  const status = erl2(["status", "--run", run.runId, "--artifact-root", run.runRoot]);
  assert.equal(status.exitCode, 0, JSON.stringify(status.body.errors));
  return status.body.state as string;
}

function lifecycleEvents(
  run: Run,
): readonly { event_type: string; state_to: string; produced?: { artifact_role: string }[] }[] {
  const dir = path.join(run.runRoot, "events");
  return readdirSync(dir)
    .sort()
    .map(
      (name) =>
        JSON.parse(readFileSync(path.join(dir, name), "utf8")) as {
          event_type: string;
          state_to: string;
          produced?: { artifact_role: string }[];
        },
    );
}

function producedRoles(run: Run): readonly string[] {
  return lifecycleEvents(run)
    .flatMap((e) => e.produced ?? [])
    .map((p) => p.artifact_role);
}

/** Full-tree byte manifest of the run root, excluding the lease and test inputs. */
function manifest(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const rec = (dir: string, base: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
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
  return out.filter((p) => !p.includes("lease") && !/^source-trust\.json$/.test(p));
}

const TERMINAL = "generic_finalized";
const TOTAL_PHASES = 21;

test("ENV-CLI: a run advances from case_selected to a finalized environment terminal", () => {
  const run = selectedRun();
  assert.equal(drive(run), TERMINAL);

  // The environment path really happened: every phase left its own durable role.
  const roles = new Set(producedRoles(run));
  for (const role of [
    "environment-reservation-lease",
    "environment-resource-inventory",
    "environment-operation-receipt",
    "environment-baseline",
    "execution-plan",
    "journey-step-outcome",
    "mutation-receipt",
    "traffic-process-start-receipt",
    "runtime-milestone",
    "source-snapshot",
    "observation-bundle",
    "canonical-evidence-envelope",
    "adapter-translation-receipt",
    "subject-output-manifest",
    "judge-expectation-reveal",
    "exposure-event",
    "journey-result",
    "domain-result",
    "precleanup-result-join",
    "compensation-receipt",
    "environment-restoration",
    "teardown-verification",
    "validity-result",
    "generic-evaluation-index",
    "run-record",
    "final-attestation",
    "signer-inventory",
  ]) {
    assert.ok(roles.has(role), `the run produced no ${role}`);
  }
  // The pre-environment cleanup role is forbidden on this branch; its absence is
  // what keeps the two terminal variants mutually exclusive.
  assert.ok(!roles.has("pre-environment-cleanup"), "an environment run must not produce a pre-environment cleanup");
});

test("ENV-VERIFY: the environment public bundle verifies offline, as an external reader", () => {
  const run = selectedRun();
  assert.equal(drive(run), TERMINAL);

  // The verifier needs the beacon's pinned registry entry because an environment
  // bundle carries a selection verification receipt as a mandatory member — that
  // is the whole difference between the two bundle variants.
  const verified = verifyBundle(run.runRoot, {
    sourceTrustPolicyHash: run.registry.sourceTrustPolicyHash,
  });
  assert.equal(verified.exitCode, 0, JSON.stringify(verified.body.errors));
  const data = verified.body.data as {
    verdict: string;
    closure: { derived_terminal_variant: string; derived_terminal_phase: string; rejected_extra_hashes: string[]; missing_roles: string[] };
  };
  assert.equal(data.verdict, "valid");
  assert.equal(data.closure.derived_terminal_variant, "environment");
  assert.equal(data.closure.derived_terminal_phase, "remove");
  assert.deepEqual(data.closure.missing_roles, []);
  assert.deepEqual(data.closure.rejected_extra_hashes, []);
});

test("ENV-VERIFY: a verifier without the pinned beacon cannot authorize the selection chain", () => {
  const run = selectedRun();
  assert.equal(drive(run), TERMINAL);
  // Fail-closed, and for the right reason: the randomness source's authority is
  // the verifier's own pinned configuration, never anything the bundle carries.
  const unpinned = verifyBundle(run.runRoot);
  assert.notEqual(unpinned.exitCode, 0);
  assert.equal(unpinned.body.errors[0]?.code, "RANDOMNESS_SOURCE_NOT_PINNED");
});

test("ENV-CLI: the environment is really torn down and the reservations released", () => {
  const run = selectedRun();
  assert.equal(drive(run), TERMINAL);

  const teardown = JSON.parse(
    readFileSync(path.join(run.runRoot, "retained", "teardown-verification.json"), "utf8"),
  ) as { passed: boolean; checks: { selector: string; residue_count: number }[] };
  assert.equal(teardown.passed, true);
  assert.ok(teardown.checks.length > 0, "an uninspected teardown proves nothing");
  for (const check of teardown.checks) {
    assert.ok(check.selector.includes(run.runId), `selector ${check.selector} is not run-scoped`);
    assert.equal(check.residue_count, 0);
  }

  // The global allocator holds nothing for this run once the substrate is empty.
  const reservations = `${path.resolve(run.runRoot)}.reservations`;
  const held = readdirSync(reservations).filter((n) => n.endsWith(".lease.json"));
  assert.deepEqual(held, [], "a torn-down run must not keep its substrate reservations");
});

test("ENV-CLI: the plan executes exactly the persona the selection opened", () => {
  const run = selectedRun();
  drive(run, 3);
  const read = (file: string): Record<string, string> =>
    JSON.parse(readFileSync(path.join(run.runRoot, "retained", file), "utf8")) as Record<string, string>;
  const executionPlan = read("execution-plan.json");
  const binding = read(path.join("selection", "selected-binding.json"));
  assert.equal(executionPlan["actor_script_hash"], binding["persona_script_hash"]);
  assert.equal(executionPlan["journey_hash"], binding["journey_hash"]);
  assert.equal(executionPlan["challenge_hash"], binding["challenge_manifest_hash"]);
});

test("ENV-CLI: an unsupported step is a retained outcome, never a removed case", () => {
  const run = selectedRun();
  assert.equal(drive(run), TERMINAL);
  const output = JSON.parse(
    readFileSync(path.join(run.runRoot, "retained", "subject-output-manifest.json"), "utf8"),
  ) as { unsupported_inputs: string[]; step_outcome_hashes: string[] };
  // The fixture adapter declares no `authenticate`, `discover` or `observe`
  // operation, so those steps are genuinely unsupported rather than scripted.
  assert.equal(output.unsupported_inputs.length, 3, "the three undeclared operations are retained as unsupported");
  // Eight committed environment steps plus the two pre-environment ones
  // (`acquire`, `verify_package`): the manifest carries the run's whole derived
  // step closure, not just the environment phase.
  assert.equal(output.step_outcome_hashes.length, 10, "every planned step froze exactly one outcome");

  const reveal = JSON.parse(
    readFileSync(path.join(run.runRoot, "retained", "judge-expectation-reveal.json"), "utf8"),
  ) as { revealed_expectation_hashes: string[] };
  assert.equal(
    reveal.revealed_expectation_hashes.length,
    output.unsupported_inputs.length,
    "exactly the failed and unsupported steps had their expectations opened",
  );
});

test("ENV-CLI-CRASH: every phase boundary resumes from retained evidence", () => {
  for (let stopAfter = 1; stopAfter <= TOTAL_PHASES; stopAfter += 1) {
    const run = selectedRun();
    drive(run, stopAfter);
    // A fresh process finishes the run from whatever the last one durably left.
    const finished = drive(run, Number.POSITIVE_INFINITY, stopAfter);
    assert.equal(finished, TERMINAL, `resume after ${String(stopAfter)} phases must complete`);
    // Exactly one of each once-only artifact, however the run was cut.
    const roles = producedRoles(run);
    for (const role of ["environment-resource-inventory", "execution-plan", "observation-bundle", "teardown-verification"]) {
      assert.equal(
        roles.filter((r) => r === role).length,
        1,
        `crash after ${String(stopAfter)} produced ${role} more than once`,
      );
    }
  }
});

test("ENV-CLI: replaying a finished run adds nothing, whether the phase is idempotent or refused", () => {
  const run = selectedRun();
  assert.equal(drive(run), TERMINAL);
  const before = manifest(run.runRoot);

  // Two different correct answers, and the difference is not cosmetic. A phase
  // that produces evidence replays as a no-op and returns what it already
  // produced. A phase that *executes the subject* must be refused outright on a
  // finished run: `assertSubjectPortExecutable` forbids subject execution in any
  // post-reveal, cleanup or terminal state, and a "harmless" replay of one would
  // be exactly the post-terminal execution that guard exists to stop.
  const subjectSteps = new Set([
    "install",
    "configure",
    "authenticate",
    "connect",
    "remove",
    "execute-subject:discover",
    "execute-subject:exercise",
    "execute-subject:observe",
  ]);
  for (const [name, argv] of environmentPlan(run)) {
    const result = erl2(argv);
    if (subjectSteps.has(name)) {
      assert.notEqual(result.exitCode, 0, `${name} must be refused on a finished run`);
      assert.ok(result.body.errors[0]?.code, `${name} must be refused with a typed code`);
      continue;
    }
    assert.equal(result.exitCode, 0, `${name} replay: ${JSON.stringify(result.body.errors)}`);
  }
  assert.deepEqual(changed(before, manifest(run.runRoot)), [], "a replayed environment path adds no evidence");
});

test("ENV-NO-WRITE: every refused environment command adds zero retained evidence", () => {
  const run = selectedRun();
  const env = [...run.base];
  const cases: readonly (readonly [string, readonly string[]])[] = [
    ["provision without --archetype", ["provision", ...env]],
    [
      "provision with an unadmitted archetype",
      ["provision", ...env, "--archetype", `sha256:${"a".repeat(64)}`],
    ],
    ["provision with a malformed archetype hash", ["provision", ...env, "--archetype", "not-a-hash"]],
    ["baseline before provisioning", ["baseline", ...env]],
    ["plan before a baseline", ["plan", ...env]],
    ["install before a plan", ["install", ...env]],
    ["activate before connecting", ["activate", ...env]],
    ["journey before activation", ["journey", ...env]],
    ["observe before traffic", ["observe", ...env]],
    ["freeze-observation before a cutoff", ["freeze-observation", ...env]],
    ["restore before the result join", ["restore", ...env]],
    ["destroy before restoration", ["destroy", ...env]],
    ["an unknown flag", ["provision", ...env, "--archetype", run.registry.archetypeHash, "--nope", "x"]],
  ];
  // Once a phase has run, re-issuing it is an idempotent no-op rather than a
  // refusal, so the "before X" cases are only meaningful on a fresh run.
  const beforePhaseCases = new Set([
    "provision without --archetype",
    "provision with an unadmitted archetype",
    "baseline before provisioning",
    "plan before a baseline",
    "install before a plan",
  ]);
  const runCases = (label: string): void => {
    for (const [name, argv] of cases) {
      if (label === "mid-path" && beforePhaseCases.has(name)) continue;
      const before = manifest(run.runRoot);
      const result = erl2(argv);
      assert.notEqual(result.exitCode, 0, `${label}: ${name} must be refused`);
      assert.ok(result.body.errors[0]?.code, `${label}: ${name} must carry a typed code`);
      assert.deepEqual(changed(before, manifest(run.runRoot)), [], `${label}: ${name} must write nothing`);
    }
  };
  runCases("fresh");

  // Again against a populated tree, where a partial write would otherwise hide.
  drive(run, 3);
  runCases("mid-path");

  // No refusal damaged the run: it still completes.
  assert.equal(drive(run), TERMINAL);
});

test("ENV-ORDER: a named step command may not reorder the committed journey", () => {
  const run = selectedRun();
  drive(run, 3);
  // The journey's next committed step is `install`; asking for `connect` is a
  // refusal, not a reordering.
  const before = manifest(run.runRoot);
  const wrong = erl2(["connect", ...run.base]);
  assert.notEqual(wrong.exitCode, 0);
  assert.equal(wrong.body.errors[0]?.code, "POLICY_CONFLICT");
  assert.deepEqual(changed(before, manifest(run.runRoot)), []);
});

test("ENV-SUBSTRATE: the driver's substrate lives outside the run root", () => {
  const run = selectedRun();
  drive(run, 1);
  assert.ok(
    existsSync(`${path.resolve(run.runRoot)}.substrate`),
    "the fake driver's substrate is a sibling of the run root",
  );
  // Nothing under the run root is substrate state: an artifact index scans the
  // whole run root, so substrate inside it would be indexed as evidence.
  const inside = [...manifest(run.runRoot).keys()].filter((p) => p.includes("substrate"));
  assert.deepEqual(inside, [], "no substrate state may live under the run root");
});

/*
 * The oracle-canary scan on the subject-output surface, driven end to end.
 *
 * This is the case that makes the Slice 6.5-C coverage claim checkable rather
 * than merely stated: a canary token really is written into the subject's own
 * output bytes, and the run really does refuse before those bytes freeze. The
 * scan reads what the subject *wrote*, not the outcome metadata about it — a
 * leaked token appears in neither the manifest nor the outcome JSON.
 */
test("ENV-ORACLE: a canary in the subject's output bytes invalidates the run before it freezes", () => {
  const run = selectedRun();
  const canary = `erl2-canary-${"0f1e2d3c".repeat(4)}`;
  // Every step up to the freeze runs normally; only the subject's output leaks.
  for (const [name, argv] of environmentPlan(run).slice(0, 15)) {
    const leaking = [...argv, "--fake-leak-canary", canary];
    const result = erl2(leaking);
    assert.equal(result.exitCode, 0, `${name}: ${JSON.stringify(result.body.errors)}`);
  }

  const before = manifest(run.runRoot);
  const refused = erl2(["freeze-output", ...run.base]);
  assert.notEqual(refused.exitCode, 0, "a leaked canary must invalidate the run before output freezes");
  assert.equal(refused.body.errors[0]?.code, "JOURNEY_ORACLE_CANARY_LEAKED");
  assert.deepEqual(
    changed(before, manifest(run.runRoot)),
    [],
    "the refusal freezes no subject output",
  );
});
