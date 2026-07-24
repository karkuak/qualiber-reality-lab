/**
 * The generic step engine: every intent, every terminal outcome, and the
 * lifecycle-derived journey closure (design v2 §12, ERL2-FR-004/FR-020).
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { JourneyIntent } from "@erl2/contracts";
import { ArtifactStore, domainHash, HASH_DOMAINS } from "@erl2/integrity";
import {
  deriveStepClosure,
  GenericStepEngine,
  INTENT_EVENT_PREFIX,
  LifecycleLog,
  nextPermittedIntents,
  SteppingClock,
  uuidV7From,
} from "@erl2/core";

const ALL_INTENTS: readonly JourneyIntent[] = [
  "acquire", "verify_package", "install", "configure", "authenticate", "connect",
  "discover", "exercise", "observe", "diagnose_decide", "recover", "upgrade",
  "rollback", "remove",
];

function h(label: string) {
  return domainHash(HASH_DOMAINS.TREE, { label });
}

function newEngine() {
  const root = mkdtempSync(path.join(tmpdir(), "erl2-engine-"));
  const runId = uuidV7From(Date.parse("2026-07-01T00:00:00Z"), Buffer.alloc(10, 3));
  const store = new ArtifactStore(root);
  const clock = new SteppingClock("2026-07-01T00:00:00Z", 1000);
  const lifecycle = new LifecycleLog({ runId, store, clock });
  // A step is unreachable before acquisition preregistration; the state machine
  // enforces that, so the fixture has to preregister first.
  lifecycle.append({
    eventType: "acquisition_preregistered",
    stateTo: "acquisition_preregistered",
    actorId: "operator",
    commandId: "preregister-acquisition",
    operationId: "op-preregister",
  });
  return {
    runId,
    lifecycle,
    engine: new GenericStepEngine({ runId, lifecycle, store, clock }),
  };
}

function runOne(
  ctx: ReturnType<typeof newEngine>,
  stepId: string,
  intent: JourneyIntent,
  status: "succeeded" | "failed" | "unsupported",
) {
  return ctx.engine.runStep({
    stepId,
    intent,
    stepCommitmentHash: h(`${stepId}-commitment`),
    visibleStepHash: h(`${stepId}-visible`),
    adapterRequestHash: h(`${stepId}-request`),
    actorId: "operator",
    commandId: stepId,
    execute: () => ({
      status,
      attemptRecordHashes: [h(`${stepId}-attempt`)],
      detailRecordHashes: [],
      activeOperatorMs: 100,
      ...(status === "succeeded" ? {} : { errorCode: "SUBJECT_RUNTIME_STEP_FAILED" }),
    }),
  });
}

test("JOURNEY-CAPTURE: every intent supports every terminal outcome", () => {
  for (const status of ["succeeded", "failed", "unsupported"] as const) {
    for (const intent of ALL_INTENTS) {
      const ctx = newEngine();
      const { outcome } = runOne(ctx, `step-${intent.replaceAll("_", "-")}`, intent, status);
      assert.equal(outcome.intent, intent);
      assert.equal(outcome.status, status);
      assert.equal(ctx.lifecycle.currentState, "step_outcome_frozen");
      const types = ctx.lifecycle.all().map((e) => e.event_type);
      const prefix = INTENT_EVENT_PREFIX[intent];
      assert.ok(types.includes(`${prefix}_planned`));
      assert.ok(types.includes(`${prefix}_started`));
      assert.ok(types.includes(`${prefix}_outcome_frozen`));
    }
  }
});

test("JOURNEY-CAPTURE: there is no privileged install or configure path", () => {
  // Acquire and remove emit exactly the same submachine shape as install.
  const shapes = ALL_INTENTS.map((intent) => {
    const ctx = newEngine();
    runOne(ctx, `step-${intent.replaceAll("_", "-")}`, intent, "succeeded");
    return ctx.lifecycle.all().map((e) => e.state_to).join(">");
  });
  assert.equal(new Set(shapes).size, 1, "intents produced different lifecycle shapes");
});

test("GRAPH-CLOSURE: the ordered step closure derives from lifecycle events", () => {
  const ctx = newEngine();
  const a = runOne(ctx, "step-acquire", "acquire", "succeeded");
  const b = runOne(ctx, "step-verify-package", "verify_package", "failed");
  const derived = deriveStepClosure(ctx.lifecycle.all());
  assert.deepEqual(derived, [a.outcome.core_hash, b.outcome.core_hash]);
});

test("GRAPH-CLOSURE: a planned occurrence with no frozen outcome is refused", () => {
  const ctx = newEngine();
  runOne(ctx, "step-acquire", "acquire", "succeeded");
  ctx.lifecycle.append({
    eventType: "subject_install_planned",
    stateTo: "step_planned",
    actorId: "operator",
    commandId: "install",
    operationId: "op-orphan-planned",
  });
  assert.throws(
    () => deriveStepClosure(ctx.lifecycle.all()),
    (error: unknown) => (error as { code: string }).code === "GRAPH_CLOSURE_MISSING_ROLE",
  );
});

test("GRAPH-CLOSURE: a duplicated outcome is refused", () => {
  const ctx = newEngine();
  const { outcome } = runOne(ctx, "step-acquire", "acquire", "succeeded");
  const events = [...ctx.lifecycle.all()];
  const frozen = events[events.length - 1];
  assert.throws(
    () => deriveStepClosure([...events, { ...frozen!, event_type: "subject_install_outcome_frozen" }]),
    (error: unknown) => (error as { code: string }).code === "GRAPH_CLOSURE_EXTRA_ARTIFACT",
  );
  assert.match(outcome.core_hash, /^sha256:/);
});

test("JOURNEY-CAPTURE: permitted next intents follow the design's journey order", () => {
  assert.deepEqual(nextPermittedIntents("acquire")[0], "verify_package");
  assert.deepEqual(nextPermittedIntents("remove"), []);
  assert.ok(nextPermittedIntents("connect").includes("remove"));
});

test("STATE-POST-REVEAL: the engine refuses to execute a step after a reveal", () => {
  const ctx = newEngine();
  runOne(ctx, "step-acquire", "acquire", "succeeded");
  ctx.lifecycle.append({
    eventType: "subject_output_frozen",
    stateTo: "subject_output_frozen",
    actorId: "operator",
    commandId: "freeze-output",
    operationId: "op-freeze-output",
  });
  ctx.lifecycle.append({
    eventType: "judge_journey_expectation_revealed",
    stateTo: "judge_journey_expectation_revealed",
    actorId: "judge",
    commandId: "reveal",
    operationId: "op-reveal",
  });
  assert.throws(
    () => runOne(ctx, "step-remove", "remove", "succeeded"),
    (error: unknown) => (error as { code: string }).code === "STATE_POST_REVEAL_EXECUTION_FORBIDDEN",
  );
});
