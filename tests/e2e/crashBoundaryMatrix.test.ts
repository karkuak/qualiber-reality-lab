/**
 * The crash matrix, in fresh OS processes, counting real external invocations
 * (review P1-7, ADR-ERL2-028 §7, §8).
 *
 * ## How this differs from `mutationIntentCrashMatrix.test.ts`
 *
 * That suite drives `EnvironmentRun` in-process and injects a crash by throwing.
 * It proves the reconciliation *logic*, and it is kept. It cannot prove crash
 * recovery, because a thrown error unwinds — `finally` blocks run, the run lease
 * is released — and because its invocation counters live in the memory of the
 * process that is supposed to have died.
 *
 * Here, every step is a separate `erl2` process:
 *
 *  - the crashing process is ended with `SIGKILL` at a named boundary inside the
 *    command, by the development-gated `--crash-at` seam. It cannot be caught, so
 *    nothing unwinds and nothing after the boundary runs;
 *  - external invocations are appended to a **file** by `--invocation-log`,
 *    before and after each call, so the count survives the process that made it;
 *  - the resume is a genuinely new process, sharing nothing with the first but
 *    the run directory and the substrate.
 *
 * The assertion that matters is the invocation count, not the artifact count.
 * Artifact deduplication hides a second external call rather than preventing it,
 * which is why the review's own finding was proven by counting invocations.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CRASH_BOUNDARIES, type CrashBoundary } from "@erl2/core";
import {
  drive,
  environmentPlan,
  phaseIndex,
  selectedRun,
  type EnvironmentRun,
} from "../support/environmentCli.js";

const CLI = path.resolve("packages/cli/dist/src/bin.js");

interface ProcessResult {
  readonly exitCode: number | null;
  readonly signal: string | null;
  /** True when the OS ended this process rather than the process returning. */
  readonly killed: boolean;
}

/**
 * Runs one `erl2` command in a fresh process, reporting how it ended.
 *
 * `spawnSync` reports `status: null` and `signal: "SIGKILL"` for a killed child,
 * which is the distinction the matrix turns on: a command that *refused* returns
 * a nonzero status, and a command that *crashed* returns none at all.
 */
function runProcess(argv: readonly string[]): ProcessResult {
  const result = spawnSync(process.execPath, [CLI, ...argv], {
    encoding: "utf8",
    env: { ...process.env, ERL2_DEVELOPMENT_FAKE_SUBJECT: "1" },
  });
  return {
    exitCode: result.status,
    signal: result.signal,
    killed: result.status === null && result.signal !== null,
  };
}

interface InvocationEntry {
  readonly surface: "driver" | "subject_port";
  readonly phase: "enter" | "return";
  readonly operation_id: string;
  readonly request_hash?: string;
  readonly kind?: string;
}

function invocations(logPath: string): readonly InvocationEntry[] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as InvocationEntry);
}

/**
 * How many times the external interface was *entered* for one operation.
 *
 * `enter` and not `return`: a crash inside the external call leaves an `enter`
 * with no `return`, and that call still happened. Counting returns would report
 * zero invocations for the single most dangerous case in the matrix.
 */
function invocationCount(logPath: string, operationId: string): number {
  return invocations(logPath).filter(
    (entry) => entry.operation_id === operationId && entry.phase === "enter",
  ).length;
}

/** The distinct request bytes each invocation of one operation carried. */
function requestHashes(logPath: string, operationId: string): readonly string[] {
  return [
    ...new Set(
      invocations(logPath)
        .filter((e) => e.operation_id === operationId && e.phase === "enter" && e.request_hash !== undefined)
        .map((e) => e.request_hash as string),
    ),
  ];
}

/** The durable intents this run holds, by operation id. */
function intents(run: EnvironmentRun): Map<string, string> {
  const dir = path.join(run.runRoot, "state", "intents");
  const out = new Map<string, string>();
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const value = JSON.parse(readFileSync(path.join(dir, name), "utf8")) as {
      operation_id: string;
      state: string;
    };
    out.set(value.operation_id, value.state);
  }
  return out;
}

interface LifecycleEvent {
  readonly event_type: string;
  readonly state_to: string;
  readonly produced?: readonly { readonly artifact_role: string }[];
}

function events(run: EnvironmentRun): readonly LifecycleEvent[] {
  const dir = path.join(run.runRoot, "events");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .sort()
    .map((name) => JSON.parse(readFileSync(path.join(dir, name), "utf8")) as LifecycleEvent);
}

function roleCount(run: EnvironmentRun, role: string): number {
  return events(run)
    .flatMap((event) => event.produced ?? [])
    .filter((produced) => produced.artifact_role === role).length;
}

function terminalCount(run: EnvironmentRun): number {
  return events(run).filter((event) => event.state_to === "invalidated").length;
}

function logFile(label: string): string {
  return path.join(mkdtempSync(path.join(tmpdir(), `erl2-invocations-${label}-`)), "invocations.jsonl");
}

/** The argv of one named phase, with the crash seam and the invocation log added. */
function phaseArgv(
  run: EnvironmentRun,
  command: string,
  logPath: string,
  boundary?: CrashBoundary,
): readonly string[] {
  const entry = environmentPlan(run).find(([name]) => name === command);
  assert.ok(entry !== undefined, `no environment phase named ${command}`);
  return [
    ...entry[1],
    "--invocation-log", logPath,
    ...(boundary === undefined ? [] : ["--crash-at", boundary]),
  ];
}

/**
 * The boundaries at which a *subject step* is genuinely ambiguous on resume.
 *
 * `before_external_dispatch` is in this set and the fact deserves stating
 * plainly: at that boundary the subject was **not** called, and the run still
 * fails closed — because the `dispatching` marker is made durable *before* the
 * call, so the evidence cannot separate "about to call" from "called and died".
 * That is a conservative refusal, not a proof of a duplicate, and it is recorded
 * as such rather than counted as an exactly-once win.
 *
 * The three boundaries outside this set are the ones where the evidence is
 * decisive: nothing was declared, the intent proves nothing was dispatched, or
 * the outcome is already frozen.
 */
const SUBJECT_AMBIGUOUS: ReadonlySet<CrashBoundary> = new Set<CrashBoundary>([
  "before_external_dispatch",
  "after_external_dispatch",
  "before_receipt_freeze",
  "after_receipt_freeze",
  "before_lifecycle_append",
]);

/** Boundaries at which the subject port had already been entered when the process died. */
const SUBJECT_CALLED: ReadonlySet<CrashBoundary> = new Set<CrashBoundary>([
  "after_external_dispatch",
  "before_receipt_freeze",
  "after_receipt_freeze",
  "before_lifecycle_append",
  "after_lifecycle_append",
]);

// -- the subject step ---------------------------------------------------------

for (const boundary of CRASH_BOUNDARIES) {
  test(`CRASH-STEP: a subject step crashed at ${boundary} is never invoked twice`, () => {
    const run = selectedRun();
    const log = logFile(`step-${boundary}`);
    // Fresh processes all the way to the plan; the step is the next command.
    drive(run, phaseIndex(run, "install"));

    // The acquisition walk already froze two step outcomes (`acquire` and
    // `verify_package`), so "exactly one outcome" has to mean *one more than
    // before* rather than one in total.
    const outcomesBefore = roleCount(run, "journey-step-outcome");
    const first = runProcess(phaseArgv(run, "install", log, boundary));
    assert.equal(
      first.killed,
      true,
      `the first process must be ended by a signal at ${boundary}, not return (${JSON.stringify(first)})`,
    );
    assert.equal(first.signal, "SIGKILL");

    const calledBeforeCrash = invocationCount(log, "op-step-0");
    assert.equal(
      calledBeforeCrash,
      SUBJECT_CALLED.has(boundary) ? 1 : 0,
      `${boundary}: subject invocations before the crash`,
    );

    // A genuinely new process over the same durable run root.
    const resumed = runProcess(phaseArgv(run, "install", log));
    const total = invocationCount(log, "op-step-0");

    if (SUBJECT_AMBIGUOUS.has(boundary)) {
      // Fail closed, reach a terminal, and do not call the subject again.
      assert.equal(resumed.killed, false, "the resumed process must return, not crash");
      assert.notEqual(resumed.exitCode, 0, `${boundary}: an ambiguous step must refuse`);
      assert.equal(
        total,
        calledBeforeCrash,
        `${boundary}: the subject must not be invoked again after an ambiguous dispatch`,
      );
      // The ambiguity reaches exactly one offline-verifiable invalid terminal
      // rather than stranding the run (ADR-ERL2-028 §5.2).
      assert.equal(terminalCount(run), 1, `${boundary}: exactly one invalid terminal`);
      assert.equal(
        roleCount(run, "journey-step-outcome"),
        outcomesBefore,
        `${boundary}: an ambiguous step must freeze no outcome`,
      );
      assert.equal(roleCount(run, "invalid-run-record"), 1, `${boundary}: exactly one record`);
      const record = JSON.parse(
        readFileSync(path.join(run.runRoot, "retained", "invalid-run-record.json"), "utf8"),
      ) as { failed_phase: { kind: string; failed_intent?: string } };
      assert.equal(record.failed_phase.kind, "journey_execution");
      assert.equal(record.failed_phase.failed_intent, "install");
      // Offline verification of the invalid record, in yet another process.
      const verified = runProcess([
        "verify-record",
        "--record", path.join(run.runRoot, "retained", "invalid-run-record.json"),
        "--lifecycle", path.join(run.runRoot, "state", "lifecycle.json"),
      ]);
      assert.notEqual(verified.exitCode, null, "the verifier must return a status");
    } else {
      // Decisive evidence: the step completes exactly once, or is already complete.
      assert.equal(
        total,
        1,
        `${boundary}: exactly one subject invocation across both processes`,
      );
      assert.equal(
        roleCount(run, "journey-step-outcome"),
        outcomesBefore + 1,
        `${boundary}: exactly one new step outcome`,
      );
      assert.equal(terminalCount(run), 0, `${boundary}: no terminal on a recoverable crash`);
    }

    // Whatever happened, every invocation carried the *same* request bytes: one
    // operation id may name exactly one operation.
    assert.ok(
      requestHashes(log, "op-step-0").length <= 1,
      `${boundary}: one operation id carried ${String(requestHashes(log, "op-step-0").length)} distinct requests`,
    );
  });
}

test("CRASH-STEP: a step whose lifecycle append landed is not re-dispatched, and the walk continues", () => {
  const run = selectedRun();
  const log = logFile("step-continue");
  drive(run, phaseIndex(run, "install"));

  const first = runProcess(phaseArgv(run, "install", log, "after_lifecycle_append"));
  assert.equal(first.killed, true);
  assert.equal(invocationCount(log, "op-step-0"), 1);
  // The intent never reached `settled`, which is exactly the state this boundary
  // exists to leave behind.
  assert.equal(intents(run).get("op-step-0"), "dispatched");

  // The rest of the walk runs in fresh processes and reaches the valid terminal:
  // an unsettled intent over a *completed* operation must not strand the run.
  assert.equal(drive(run, Number.POSITIVE_INFINITY, phaseIndex(run, "configure")), "generic_finalized");
  assert.equal(invocationCount(log, "op-step-0"), 1, "the completed step is never re-invoked");
});

// -- challenge activation -----------------------------------------------------

for (const boundary of CRASH_BOUNDARIES) {
  test(`CRASH-ACTIVATE: activation crashed at ${boundary} applies exactly one logical mutation`, () => {
    const run = selectedRun();
    const log = logFile(`activate-${boundary}`);
    drive(run, phaseIndex(run, "activate"));

    const first = runProcess(phaseArgv(run, "activate", log, boundary));
    assert.equal(
      first.killed,
      true,
      `the first process must be ended by a signal at ${boundary} (${JSON.stringify(first)})`,
    );
    assert.equal(first.signal, "SIGKILL");

    const resumed = runProcess(phaseArgv(run, "activate", log));
    assert.equal(resumed.exitCode, 0, `${boundary}: activation must resume to success`);

    // Activation has a probe — the driver's own operation log — so it is
    // invocation-level exactly once at every boundary, not merely idempotent.
    assert.equal(
      invocationCount(log, "op-activate"),
      1,
      `${boundary}: the activation mutation must be dispatched exactly once`,
    );
    assert.equal(roleCount(run, "mutation-receipt"), 1, `${boundary}: one driver receipt`);
    assert.equal(
      roleCount(run, "challenge-activation-receipt"),
      1,
      `${boundary}: one signed controller receipt`,
    );
    assert.equal(terminalCount(run), 0, `${boundary}: no terminal on a recoverable crash`);
    assert.equal(intents(run).get("op-activate"), "settled");
  });
}

test("CRASH-ACTIVATE: a reconstructed activation receipt is byte-stable, and the run still finalizes", () => {
  const run = selectedRun();
  const log = logFile("activate-bytes");
  drive(run, phaseIndex(run, "activate"));

  // Crash after the driver receipt is retained and before the controller's own
  // receipt is: the resumed process must rebuild the second from retained
  // evidence, and the whole walk must still reach its valid terminal.
  assert.equal(runProcess(phaseArgv(run, "activate", log, "after_receipt_freeze")).killed, true);
  assert.equal(
    drive(run, Number.POSITIVE_INFINITY, phaseIndex(run, "activate")),
    "generic_finalized",
  );
  assert.equal(invocationCount(log, "op-activate"), 1, "exactly one activation mutation");
});

// -- the seam itself ----------------------------------------------------------

test("CRASH-SEAM: the crash and invocation-log flags are refused on the release surface", () => {
  const run = selectedRun();
  const log = logFile("release-surface");
  for (const extra of [["--crash-at", "after_intent_freeze"], ["--invocation-log", log]]) {
    const entry = environmentPlan(run).find(([name]) => name === "provision");
    assert.ok(entry !== undefined);
    const released = spawnSync(process.execPath, [CLI, ...entry[1], ...extra], {
      encoding: "utf8",
      // No development profile: this is the release surface.
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) => key !== "ERL2_DEVELOPMENT_FAKE_SUBJECT"),
      ) as NodeJS.ProcessEnv,
    });
    const body = JSON.parse(released.stdout) as { errors: { code: string }[] };
    assert.equal(
      body.errors[0]?.code,
      "CFG_DEVELOPMENT_FLAG_UNAVAILABLE",
      `${extra[0] as string} must be development-only`,
    );
  }
});

test("CRASH-SEAM: an unknown boundary is refused rather than silently ignored", () => {
  const run = selectedRun();
  const log = logFile("unknown-boundary");
  const entry = environmentPlan(run).find(([name]) => name === "provision");
  assert.ok(entry !== undefined);
  const result = spawnSync(
    process.execPath,
    [CLI, ...entry[1], "--invocation-log", log, "--crash-at", "after_everything"],
    { encoding: "utf8", env: { ...process.env, ERL2_DEVELOPMENT_FAKE_SUBJECT: "1" } },
  );
  const body = JSON.parse(result.stdout) as { errors: { code: string }[] };
  assert.equal(body.errors[0]?.code, "CFG_MISSING_REQUIRED");
  // A flag that was accepted and ignored would make every crash case a false
  // pass, so this is load-bearing rather than tidiness.
  assert.equal(invocationCount(log, "op-provision"), 0);
});
