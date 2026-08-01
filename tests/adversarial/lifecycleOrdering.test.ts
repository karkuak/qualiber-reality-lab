/**
 * Refusal atomicity and branch-specific cancellation, through the shipped binary
 * (review P1-10 and P1-2, ADR-ERL2-028 §3 and §6).
 *
 * Every case here runs fresh `erl2` processes against a durable run root. The
 * refusal half is proven with a **byte manifest**: the complete file tree of the
 * run root and both operational siblings is hashed before and after the refused
 * command, and the two must be identical. A refusal that writes evidence is
 * exactly what P1-10 was, and no weaker assertion catches it — the previous
 * defect left a *well-formed, correctly-hashed* cutoff policy behind, so nothing
 * about its content was wrong. Only its existence was.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { erl2 } from "../support/cliRun.js";
import {
  drive,
  environmentPlan,
  phaseIndex,
  runPhase,
  selectedRun,
  type EnvironmentRun,
} from "../support/environmentCli.js";

/**
 * Every file under a directory, by relative path, with its content digest.
 *
 * Directories are recorded too, as `<dir>/` entries with no digest, because the
 * P3 defect this also closes was the *creation of an empty directory*:
 * `<run-root>.substrate` and `<run-root>.reservations` were made by
 * `openEnvironment` before any command logic ran, so a refused command left two
 * new directories and a manifest of files alone would have called that clean.
 */
function manifest(root: string): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string, prefix: string): void => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir).sort()) {
      const absolute = path.join(dir, name);
      const relative = prefix === "" ? name : `${prefix}/${name}`;
      if (statSync(absolute).isDirectory()) {
        out.set(`${relative}/`, "<dir>");
        walk(absolute, relative);
      } else {
        out.set(relative, createHash("sha256").update(readFileSync(absolute)).digest("hex"));
      }
    }
  };
  walk(root, "");
  return out;
}

/** The run root and both operational siblings, as one manifest. */
function fullManifest(run: EnvironmentRun): ReadonlyMap<string, string> {
  const combined = new Map<string, string>();
  for (const [label, root] of [
    ["run", run.runRoot],
    ["substrate", `${path.resolve(run.runRoot)}.substrate`],
    ["reservations", `${path.resolve(run.runRoot)}.reservations`],
  ] as const) {
    for (const [key, digest] of manifest(root)) combined.set(`${label}:${key}`, digest);
  }
  return combined;
}

function diff(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): readonly string[] {
  const changes: string[] = [];
  for (const [key, digest] of after) {
    if (!before.has(key)) changes.push(`created ${key}`);
    else if (before.get(key) !== digest) changes.push(`modified ${key}`);
  }
  for (const key of before.keys()) if (!after.has(key)) changes.push(`removed ${key}`);
  return changes.sort();
}

/**
 * Asserts a command refuses and leaves the run byte-identical.
 *
 * The run lease is the one documented exception, and it is narrow: the lease file
 * is bounded, self-expiring and excluded from every closure derivation by
 * construction. Anything else appearing in the diff is a failure.
 */
function assertRefusalWritesNothing(
  run: EnvironmentRun,
  label: string,
  argv: readonly string[],
): void {
  const before = fullManifest(run);
  const result = erl2(argv);
  assert.notEqual(result.exitCode, 0, `${label}: the command must refuse`);
  assert.ok(
    (result.body.errors ?? []).length > 0 && result.body.errors[0]?.code !== "NON_JSON_OUTPUT",
    `${label}: the refusal must be typed, not a crash: ${JSON.stringify(result.body.errors)}`,
  );
  const after = fullManifest(run);
  const changes = diff(before, after).filter(
    (change) => !change.includes("state/lease.json") && !change.includes("state/snapshot.json"),
  );
  assert.deepEqual(
    changes,
    [],
    `${label} (${result.body.errors[0]?.code ?? "?"}) wrote evidence on a refusal: ${changes.join(", ")}`,
  );
}

// -- P1-10: a refused journey writes nothing ---------------------------------

test("REFUSAL-ATOMIC: this is P1-10 — journey with a missing comparison policy freezes no cutoff policy", () => {
  const run = selectedRun();
  drive(run, phaseIndex(run, "journey"));
  // The exact reproduction. `--cutoff-policy` is admitted and
  // `--comparison-policy` is not, and the old ordering froze
  // `retained/environment/cutoff-policy.json` on one line and then refused
  // `CFG_MISSING_REQUIRED` on the next.
  assertRefusalWritesNothing(run, "journey without --comparison-policy", [
    "journey",
    ...run.base,
    "--cutoff-policy",
    run.registry.cutoffPolicyHash,
  ]);
  assert.equal(
    existsSync(path.join(run.runRoot, "retained", "environment", "cutoff-policy.json")),
    false,
    "no cutoff policy may be retained by a refused journey",
  );
  // And the run is not wedged: the correct command still succeeds.
  const ok = runPhase(run, "journey");
  assert.equal(ok.exitCode, 0, JSON.stringify(ok.body.errors));
});

test("REFUSAL-ATOMIC: every representative refusal cause leaves the run byte-identical", () => {
  // One run per cause, because a refusal that writes nothing still has to be
  // measured against a tree the previous case did not move.
  const causes: readonly (readonly [string, (run: EnvironmentRun) => readonly string[], string])[] = [
    // wrong lifecycle state: journey before the challenge is activated
    ["journey before activation", (run) => ["journey", ...run.base], "connect"],
    // wrong journey occurrence: install when the journey owes configure
    ["install out of order", (run) => ["install", ...run.base], "configure"],
    // activation missing and cutoff missing: a post-capture intent early
    ["remove before activation", (run) => ["remove", ...run.base], "activate"],
    // observation before the traffic it observes
    ["observe before journey", (run) => ["observe", ...run.base], "journey"],
    // freeze-observation before the cutoff is realized
    ["freeze-observation before observe", (run) => ["freeze-observation", ...run.base], "observe"],
    // restore before the results it follows
    ["restore before evaluation", (run) => ["restore", ...run.base], "activate"],
  ];
  for (const [label, argv, stopBefore] of causes) {
    const run = selectedRun();
    drive(run, phaseIndex(run, stopBefore));
    assertRefusalWritesNothing(run, label, argv(run));
  }
});

test("REFUSAL-ATOMIC: a refused environment command creates no substrate or reservation directory", () => {
  const run = selectedRun();
  // Before `provision`, neither sibling should exist — and a refused command must
  // not be what brings them into being. `openEnvironment` used to create both in
  // the `FileSubstrateStore` and `ReservationAllocator` constructors, so *every*
  // refusal left two empty directories behind (review P3).
  const substrate = `${path.resolve(run.runRoot)}.substrate`;
  const reservations = `${path.resolve(run.runRoot)}.reservations`;
  assert.equal(existsSync(substrate), false, "no substrate before provision");
  assert.equal(existsSync(reservations), false, "no reservations before provision");

  // `--archetype` is passed deliberately. Without it `baseline` refuses inside
  // `resolveAdmitted`, which runs *before* the driver and the allocator are
  // constructed — so the refusal never reaches the code that used to create these
  // directories, and the case would pass whether they were created eagerly or
  // not. The negative-control campaign caught exactly that: the control restored
  // the eager `mkdirSync` and killed nothing.
  //
  // With the archetype resolved, the refusal comes from the phase-state check
  // inside `ctx.run.baseline()`, which is after both constructors — which is where
  // the invariant actually lives.
  const refused = erl2(["baseline", ...run.base, "--archetype", run.registry.archetypeHash]);
  assert.notEqual(refused.exitCode, 0, "baseline before provision must refuse");
  assert.equal(refused.body.errors[0]?.code, "POLICY_CONFLICT", "the refusal must be the state check");
  assert.equal(existsSync(substrate), false, "a refused command created a substrate directory");
  assert.equal(existsSync(reservations), false, "a refused command created a reservation directory");

  // And provisioning still creates them, so the laziness did not disable them.
  assert.equal(runPhase(run, "provision").exitCode, 0);
  assert.equal(existsSync(substrate), true);
  assert.equal(existsSync(reservations), true);
});

test("REFUSAL-ATOMIC: nothing is written after the valid terminal, refused or replayed", () => {
  const run = selectedRun();
  assert.equal(drive(run), "generic_finalized");

  // `execute-subject` is a *refusal*: `assertSubjectPortExecutable` forbids the
  // port in a terminal state, before any dispatch.
  assertRefusalWritesNothing(run, "execute-subject after the valid terminal", [
    "execute-subject",
    ...run.base,
  ]);

  // `journey` is an *idempotent replay*, not a refusal, and that distinction is
  // deliberate: `enter` is passed an evidence-derived `alreadyDone` predicate, so
  // a phase whose artifact exists returns it rather than re-running. It must still
  // write nothing, which is the property this case actually cares about.
  const before = fullManifest(run);
  const replayed = erl2(["journey", ...run.base]);
  assert.equal(replayed.exitCode, 0, "a completed phase replays rather than refusing");
  const changes = diff(before, fullManifest(run)).filter(
    (change) => !change.includes("state/lease.json") && !change.includes("state/snapshot.json"),
  );
  assert.deepEqual(changes, [], `a replayed journey wrote: ${changes.join(", ")}`);
});

// -- P1-9 through the shipped binary ------------------------------------------

test("PREREQ-CLI: this is P1-9 — a committed post-capture step cannot run before activation", () => {
  const run = selectedRun();
  // Drive exactly to the review's reproduction: connected and discovered, so the
  // run sits in `step_outcome_frozen` with `exercise` as the next committed step.
  drive(run, phaseIndex(run, "activate"));
  const early = erl2(["execute-subject", ...run.base]);
  assert.notEqual(early.exitCode, 0, "the committed exercise step must not run before activation");
  const message = early.body.errors[0]?.message ?? "";
  assert.ok(
    message.includes("challenge_activation") && message.includes("evidence_cutoff"),
    `the refusal must name the unmet prerequisites, got: ${message}`,
  );
  // The walk then completes normally through the authorized order, so the guard
  // refuses the ordering violation and nothing else.
  assert.equal(drive(run, Number.POSITIVE_INFINITY, phaseIndex(run, "activate")), "generic_finalized");
});

// -- P1-2: cancellation is dispatched from the branch the run is in -----------

interface CancelObservation {
  readonly exitCode: number;
  readonly cleanupVariant: string;
  readonly cleanupStatus: string;
  readonly cancelledDuring: string;
  readonly terminalCount: number;
}

function cancelFrom(run: EnvironmentRun, reason = "operator_stop"): CancelObservation {
  const result = erl2(["cancel", ...run.base, "--reason", reason]);
  const recordPath = path.join(run.runRoot, "retained", "invalid-run-record.json");
  const record = existsSync(recordPath)
    ? (JSON.parse(readFileSync(recordPath, "utf8")) as {
        failed_phase: { cancelled_during?: string };
        cleanup: { variant: string; status: string };
      })
    : undefined;
  const eventsDir = path.join(run.runRoot, "events");
  const terminals = existsSync(eventsDir)
    ? readdirSync(eventsDir).filter((name) => {
        const event = JSON.parse(readFileSync(path.join(eventsDir, name), "utf8")) as {
          state_to: string;
        };
        return event.state_to === "invalidated";
      }).length
    : 0;
  return {
    exitCode: result.exitCode,
    cleanupVariant: record?.cleanup.variant ?? "<none>",
    cleanupStatus: record?.cleanup.status ?? "<none>",
    cancelledDuring: record?.failed_phase.cancelled_during ?? "<none>",
    terminalCount: terminals,
  };
}

test("CANCEL-BRANCH: a live environment never receives a pre-environment cleanup terminal", () => {
  // Every state at or after `provision` has, or may have, external resources.
  for (const stopBefore of ["baseline", "plan", "install", "activate", "journey", "observe"]) {
    const run = selectedRun();
    drive(run, phaseIndex(run, stopBefore));
    const observed = cancelFrom(run);
    assert.equal(observed.exitCode, 12, `cancel from before ${stopBefore} must reach a terminal`);
    assert.notEqual(
      observed.cleanupVariant,
      "none",
      `cancel from before ${stopBefore} claimed cleanup variant none over a live environment`,
    );
    assert.notEqual(
      observed.cleanupStatus,
      "not_required",
      `cancel from before ${stopBefore} claimed cleanup was not required (review P1-2)`,
    );
    assert.equal(observed.terminalCount, 1, "exactly one terminal");
  }
});

test("CANCEL-BRANCH: the branch is not decided by one file's existence", () => {
  const run = selectedRun();
  drive(run, phaseIndex(run, "baseline"));
  // Remove the binding artifact the dispatcher used to read with `existsSync`.
  // The lifecycle is the second witness, so the run must still take the
  // environment branch rather than being downgraded to a pre-environment
  // cancellation claiming `not_required` (ADR-ERL2-028 §4.1).
  const binding = path.join(run.runRoot, "retained", "environment", "substrate-binding.json");
  assert.equal(existsSync(binding), true, "the run must have a binding to remove");
  chmodSync(binding, 0o600);
  unlinkSync(binding);
  assert.equal(existsSync(binding), false);

  const observed = cancelFrom(run);
  assert.notEqual(
    observed.cleanupStatus,
    "not_required",
    "deleting the binding artifact must not downgrade the cancellation branch",
  );
  assert.notEqual(
    observed.cleanupVariant,
    "none",
    "deleting the binding artifact must not produce a pre-environment cleanup variant",
  );
});

test("CANCEL-BRANCH: an unreadable binding refuses rather than answering pre-environment", () => {
  const run = selectedRun();
  drive(run, phaseIndex(run, "baseline"));
  const binding = path.join(run.runRoot, "retained", "environment", "substrate-binding.json");
  // A directory where the binding file belongs raises `EISDIR`, which is not
  // `ENOENT`. `existsSync` reported false for exactly this class and routed a live
  // environment to the pre-environment terminal (review P1-2). It must now be a
  // typed refusal, and specifically not a quiet downgrade.
  chmodSync(binding, 0o600);
  unlinkSync(binding);
  mkdirSync(binding, { recursive: true });

  const result = erl2(["cancel", ...run.base, "--reason", "operator_stop"]);
  const code = result.body.errors[0]?.code ?? "";
  assert.equal(
    code,
    "ENV_SUBSTRATE_UNREADABLE",
    `an unreadable binding must be a typed refusal, got ${code}`,
  );
});

test("CANCEL-BRANCH: a pre-environment run still takes the pre-environment branch", () => {
  // The other direction, so the classifier is not simply answering `environment`
  // for everything — which would make every case above pass for the wrong reason.
  const run = selectedRun();
  const observed = cancelFrom(run);
  assert.equal(observed.exitCode, 12, "cancel before provision must still reach a terminal");
  assert.equal(observed.terminalCount, 1, "exactly one terminal");
});

test("CANCEL-BRANCH: cancelling a cleanup interrupted mid-flight continues it, not restarts it", () => {
  const run = selectedRun();
  const plan = environmentPlan(run);
  for (const [name, argv] of plan.slice(0, phaseIndex(run, "restore"))) {
    const result = erl2([...argv, "--fake-driver-fault", "failed-restore"]);
    assert.equal(result.exitCode, 0, `${name}: ${JSON.stringify(result.body.errors)}`);
  }

  // Kill the process *inside* the emergency cleanup, after its frontier is frozen
  // and before its terminal exists. The operation-id prefix is what makes that
  // reachable: the failing `op-restore` passes `after_external_dispatch` first, so
  // an unqualified boundary would stop the run before any frontier existed.
  const restoreArgv = (plan[phaseIndex(run, "restore")] as [string, readonly string[]])[1];
  const killed = spawnSync(
    process.execPath,
    [
      path.resolve("packages/cli/dist/src/bin.js"),
      ...restoreArgv,
      "--fake-driver-fault", "failed-restore",
      "--crash-at", "after_external_dispatch@op-emergency",
    ],
    { encoding: "utf8", env: { ...process.env, ERL2_DEVELOPMENT_FAKE_SUBJECT: "1" } },
  );
  assert.equal(killed.signal, "SIGKILL", "the cleanup must be interrupted, not returned from");

  // The state this case exists for: a frozen frontier, and no terminal.
  const frontierPath = path.join(run.runRoot, "retained", "environment", "resource-frontier.json");
  assert.equal(existsSync(frontierPath), true, "the interrupted cleanup froze its frontier");
  const frontierBefore = readFileSync(frontierPath, "utf8");
  assert.equal(
    existsSync(path.join(run.runRoot, "retained", "invalid-run-record.json")),
    false,
    "the interrupted cleanup reached no terminal",
  );

  // Cancelling must *continue* that cleanup: adopt the frozen frontier, keep its
  // trigger, and reach exactly one terminal. Re-observing it under a re-derived
  // trigger produced different bytes at the same logical path and raised
  // `ARTIFACT_ALREADY_FROZEN`, leaving the run with no terminal at all.
  const observed = cancelFrom(run);
  assert.equal(observed.terminalCount, 1, `cancel must reach exactly one terminal`);
  assert.equal(
    readFileSync(frontierPath, "utf8"),
    frontierBefore,
    "the adopted frontier must be byte-identical; a continued cleanup does not re-observe it",
  );
  assert.notEqual(observed.cleanupStatus, "not_required", "a live environment owes cleanup");
});

test("CANCEL-BRANCH: cancelling after emergency cleanup completed returns its terminal", () => {
  const run = selectedRun();
  // A failed restoration routes to emergency cleanup and reaches the invalid
  // terminal; cancelling afterwards must return that terminal idempotently rather
  // than freeze a second one or re-run the cleanup under a relabelled trigger.
  const plan = environmentPlan(run);
  for (const [name, argv] of plan.slice(0, phaseIndex(run, "restore"))) {
    const result = erl2([...argv, "--fake-driver-fault", "failed-restore"]);
    assert.equal(result.exitCode, 0, `${name}: ${JSON.stringify(result.body.errors)}`);
  }
  const restore = erl2([...(plan[phaseIndex(run, "restore")] as [string, string[]])[1], "--fake-driver-fault", "failed-restore"]);
  assert.notEqual(restore.exitCode, 0, "the failed restoration must route to the invalid terminal");

  const first = cancelFrom(run);
  assert.equal(first.terminalCount, 1, "the emergency cleanup's terminal is the only one");
  // Cancelling again is a no-op, not a third terminal.
  const second = cancelFrom(run);
  assert.equal(second.terminalCount, 1, "cancellation after a terminal creates no second terminal");
});

test("CANCEL-BRANCH: cancelling a cancelled run returns the same record and writes nothing", () => {
  const run = selectedRun();
  drive(run, phaseIndex(run, "install"));
  assert.equal(cancelFrom(run).terminalCount, 1);
  const before = fullManifest(run);
  const again = erl2(["cancel", ...run.base, "--reason", "operator_stop"]);
  assert.equal(again.exitCode, 12, "a replayed cancellation returns its terminal");
  const changes = diff(before, fullManifest(run)).filter(
    (change) => !change.includes("state/lease.json") && !change.includes("state/snapshot.json"),
  );
  assert.deepEqual(changes, [], `a replayed cancellation wrote: ${changes.join(", ")}`);
});
