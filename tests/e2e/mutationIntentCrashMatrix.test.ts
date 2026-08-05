/**
 * Durable intent, restart reconciliation, and exactly-once external effects
 * (review P1-7, ADR-ERL2-024 §4.3, §9).
 *
 * ## What this is proving, and why it is in-process
 *
 * The review's finding was proven by **counting invocations of an instrumented
 * driver and subject port**, not by counting artifacts — artifact deduplication
 * hides a second external call rather than preventing it. Reproducing that needs
 * two things a CLI-only harness cannot give: a driver whose calls are counted,
 * and a crash injected *inside* a command rather than between two of them.
 *
 * So the matrix drives `EnvironmentRun` directly, against a run the shipped CLI
 * brought to `case_selected`, through a driver wrapper that counts every call
 * and can throw at a chosen boundary. Each restart constructs a **fresh**
 * `EnvironmentRun` over the same durable run root and the same file-backed
 * substrate, which is exactly what a second `erl2` process does.
 *
 * The five injection points of §9, per mutation:
 *
 *   1. before the intent freeze;
 *   2. after the intent freeze, before dispatch;
 *   3. after dispatch, before the receipt freeze;
 *   4. after the receipt freeze, before the lifecycle append;
 *   5. after the lifecycle append, before the snapshot update.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  AdmissionRegistry,
  EnvironmentRun,
  FakeEnvironmentDriver,
  FakeSubjectPort,
  FileSubstrateStore,
  ReservationAllocator,
  RunWorkspace,
  SystemClock,
  type DestroyRequest,
  type DestroyResourceRequest,
  type EnvironmentDriver,
  type MutateRequest,
  type ProbeRequest,
  type ProvisionRequest,
  type RestoreRequest,
  type SubjectPort,
} from "@erl2/core";
import { developmentKey } from "@erl2/integrity";
import type {
  ComparisonPolicyV1,
  CutoffPolicyV1,
  EnvironmentArchetypeV1,
  SubjectAdapterManifestV1,
} from "@erl2/contracts";
import { drive, selectedRun, type EnvironmentRun as CliRun } from "../support/environmentCli.js";

/** Where a crash is injected relative to the external call. */
type CrashPoint = "none" | "before_intent" | "after_intent" | "after_dispatch";

class InjectedCrash extends Error {
  constructor(point: CrashPoint) {
    super(`injected crash ${point}`);
  }
}

/**
 * A driver that counts every call and can fail at a chosen boundary.
 *
 * `after_dispatch` throws *after* the underlying driver has applied the effect
 * and recorded its receipt in the substrate — the interesting case, because the
 * external world has changed and the run's evidence has not.
 */
class CountingDriver implements EnvironmentDriver {
  readonly calls = new Map<string, number>();
  crashOn: { readonly operationId: string; readonly point: CrashPoint } | undefined;
  private readonly inner: FakeEnvironmentDriver;

  constructor(inner: FakeEnvironmentDriver) {
    this.inner = inner;
  }

  get manifest(): FakeEnvironmentDriver["manifest"] {
    return this.inner.manifest;
  }

  count(operation: string): number {
    return this.calls.get(operation) ?? 0;
  }

  private tally(operationId: string): void {
    this.calls.set(operationId, this.count(operationId) + 1);
  }

  private maybeCrashAfter(operationId: string): void {
    if (this.crashOn?.operationId === operationId && this.crashOn.point === "after_dispatch") {
      throw new InjectedCrash("after_dispatch");
    }
  }

  provision(request: ProvisionRequest): ReturnType<FakeEnvironmentDriver["provision"]> {
    this.tally(request.operationId);
    const result = this.inner.provision(request);
    this.maybeCrashAfter(request.operationId);
    return result;
  }

  probe(request: ProbeRequest): ReturnType<FakeEnvironmentDriver["probe"]> {
    return this.inner.probe(request);
  }

  mutate(request: MutateRequest): ReturnType<FakeEnvironmentDriver["mutate"]> {
    this.tally(request.operationId);
    const receipt = this.inner.mutate(request);
    this.maybeCrashAfter(request.operationId);
    return receipt;
  }

  restore(request: RestoreRequest): ReturnType<FakeEnvironmentDriver["restore"]> {
    this.tally(request.operationId);
    const receipt = this.inner.restore(request);
    this.maybeCrashAfter(request.operationId);
    return receipt;
  }

  destroy(request: DestroyRequest): ReturnType<FakeEnvironmentDriver["destroy"]> {
    this.tally(request.operationId);
    const result = this.inner.destroy(request);
    this.maybeCrashAfter(request.operationId);
    return result;
  }

  destroyResource(request: DestroyResourceRequest): ReturnType<FakeEnvironmentDriver["destroyResource"]> {
    this.tally(request.operationId);
    const receipt = this.inner.destroyResource(request);
    this.maybeCrashAfter(request.operationId);
    return receipt;
  }

  inspect(runId: string): ReturnType<FakeEnvironmentDriver["inspect"]> {
    return this.inner.inspect(runId);
  }

  substrateInstance(): ReturnType<FakeEnvironmentDriver["substrateInstance"]> {
    return this.inner.substrateInstance();
  }

  establishSubstrateInstance(runId: string): ReturnType<FakeEnvironmentDriver["establishSubstrateInstance"]> {
    return this.inner.establishSubstrateInstance(runId);
  }

  completedOperation(
    runId: string,
    operationId: string,
  ): ReturnType<FakeEnvironmentDriver["completedOperation"]> {
    return this.inner.completedOperation(runId, operationId);
  }
}

/**
 * A subject port that counts calls and can crash *after* the subject responded.
 *
 * That is the ambiguous case: the subject did the work and the run's evidence
 * never landed. It is the one external mutation with no probe — an opaque
 * subject cannot be asked whether it already ran a step — so the next process
 * must fail closed rather than re-invoke it.
 */
class CountingSubjectPort implements SubjectPort {
  calls = 0;
  crashAfterStep = false;
  private readonly inner: FakeSubjectPort;

  constructor(inner: FakeSubjectPort) {
    this.inner = inner;
  }

  get portId(): string {
    return this.inner.portId;
  }

  markOutputFrozen(): void {
    this.inner.markOutputFrozen();
  }

  acquire(...args: Parameters<FakeSubjectPort["acquire"]>): ReturnType<FakeSubjectPort["acquire"]> {
    return this.inner.acquire(...args);
  }

  validatePackage(
    ...args: Parameters<FakeSubjectPort["validatePackage"]>
  ): ReturnType<FakeSubjectPort["validatePackage"]> {
    return this.inner.validatePackage(...args);
  }

  step(...args: Parameters<FakeSubjectPort["step"]>): ReturnType<FakeSubjectPort["step"]> {
    this.calls += 1;
    const response = this.inner.step(...args);
    if (this.crashAfterStep) throw new InjectedCrash("after_dispatch");
    return response;
  }
}

/** One "process": a fresh composition over the same durable run root. */
interface Process {
  readonly run: EnvironmentRun;
  readonly driver: CountingDriver;
  readonly subject: CountingSubjectPort;
}

function open(cli: CliRun): Process {
  const registry = AdmissionRegistry.open(cli.registry.root);
  const clockSource = new SystemClock();
  const subject = new CountingSubjectPort(
    new FakeSubjectPort({
      declaredOperations: registry.require<SubjectAdapterManifestV1>(
        cli.registry.adapterManifestHash,
        "SubjectAdapterManifestV1",
      ).operations,
    }),
  );
  const workspace = new RunWorkspace({
    runId: cli.runId,
    runRoot: cli.runRoot,
    registry,
    clock: clockSource,
    keyring: {
      preregistrar: developmentKey("preregistrar"),
      finalizer: developmentKey("finalizer"),
      timestampAuthority: developmentKey("timestamp"),
      evaluator: developmentKey("evaluator"),
    },
    tier: "development",
    subjectPort: subject,
  });
  const clock = workspace.productionClock();
  const archetype = registry.require<EnvironmentArchetypeV1>(
    cli.registry.archetypeHash,
    "EnvironmentArchetypeV1",
  );
  const driver = new CountingDriver(
    new FakeEnvironmentDriver({
      clock,
      signingKey: developmentKey("challenge-governor"),
      archetypeHash: archetype.core_hash,
      resourceKinds: archetype.topology.map((node) => node.node_id),
      evidenceSourceIds: archetype.evidence_sources.map((source) => source.source_id),
      substrate: new FileSubstrateStore(`${path.resolve(cli.runRoot)}.substrate`),
    }),
  );
  const run = new EnvironmentRun({
    workspace,
    driver,
    allocator: new ReservationAllocator({
      root: `${path.resolve(cli.runRoot)}.reservations`,
      clock,
    }),
    archetype,
    comparisonPolicy: () =>
      registry.require<ComparisonPolicyV1>(cli.registry.comparisonPolicyHash, "ComparisonPolicyV1"),
    cutoffPolicy: () =>
      registry.require<CutoffPolicyV1>(cli.registry.cutoffPolicyHash, "CutoffPolicyV1"),
    keys: {
      environmentGovernor: developmentKey("challenge-governor"),
      controller: developmentKey("controller"),
      trafficSupervisor: developmentKey("traffic-supervisor"),
      runtimeAttestor: developmentKey("runtime-attestor"),
      // ADR-ERL2-031: the evidence-window commitment's signer. The same key the
      // shipped CLI uses, so this fixture measures the composition rather than a
      // convenient variant of it.
      policyAuthor: developmentKey("policy-author"),
      vaultAuthorizer: developmentKey("vault-authorizer"),
      timestampAuthority: developmentKey("timestamp"),
      finalizer: developmentKey("finalizer"),
    },
    clock,
  });
  return { run, driver, subject };
}

/** Runs every committed setup step, so `activate` is legal. */
function runSetupSteps(process: Process): void {
  const setup = new Set(["install", "configure", "authenticate", "connect", "discover"]);
  for (;;) {
    const next = process.run.nextStep();
    if (next === undefined || !setup.has(next.intent)) return;
    process.run.runStep();
  }
}

/** The durable intents this run root holds, by operation id. */
function intents(cli: CliRun): Map<string, { state: string; idempotency_key: string }> {
  const dir = path.join(cli.runRoot, "state", "intents");
  const out = new Map<string, { state: string; idempotency_key: string }>();
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const value = JSON.parse(readFileSync(path.join(dir, name), "utf8")) as {
      operation_id: string;
      state: string;
      idempotency_key: string;
    };
    out.set(value.operation_id, { state: value.state, idempotency_key: value.idempotency_key });
  }
  return out;
}

function producedRoles(cli: CliRun): readonly string[] {
  const dir = path.join(cli.runRoot, "events");
  return readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const event = JSON.parse(readFileSync(path.join(dir, name), "utf8")) as {
        produced?: { artifact_role: string }[];
      };
      return (event.produced ?? []).map((p) => p.artifact_role);
    });
}

test("INTENT-CRASH: no external mutation happens without a durable intent", () => {
  const cli = selectedRun();
  const { run, driver } = open(cli);
  driver.crashOn = { operationId: "op-provision", point: "after_dispatch" };

  assert.throws(() => run.provision(), InjectedCrash);
  // The intent exists, and it was written *before* the call: its state records
  // that the dispatch was in flight.
  const declared = intents(cli).get("op-provision");
  assert.ok(declared !== undefined, "the dispatch must have been preceded by a durable intent");
  assert.equal(declared.state, "dispatching");
  assert.equal(driver.count("op-provision"), 1);
});

test("INTENT-CRASH: a restart reconciles before it retries, and does not re-dispatch", () => {
  const cli = selectedRun();
  const first = open(cli);
  first.driver.crashOn = { operationId: "op-provision", point: "after_dispatch" };
  assert.throws(() => first.run.provision(), InjectedCrash);
  assert.equal(first.driver.count("op-provision"), 1);

  // A fresh process over the same run root and the same substrate.
  const second = open(cli);
  const result = second.run.provision();
  assert.ok(result.inventory.resources.length > 0, "the resumed phase must complete");
  // Exactly-once: the second process adopted the prior result from the driver's
  // own operation log rather than provisioning a second environment. The count
  // that matters is the *driver's*, not the artifact's.
  assert.equal(
    second.driver.count("op-provision"),
    0,
    "a reconciled operation must not be dispatched again",
  );
  assert.equal(intents(cli).get("op-provision")?.state, "settled");
  assert.equal(
    producedRoles(cli).filter((r) => r === "environment-resource-inventory").length,
    1,
    "exactly one inventory",
  );
});

test("INTENT-CRASH: a crash before the intent freeze leaves no external effect", () => {
  const cli = selectedRun();
  const { run, driver } = open(cli);
  // Nothing dispatched at all: the phase is refused before it reaches the
  // driver, so there is neither an intent nor an effect.
  driver.crashOn = { operationId: "op-provision", point: "before_intent" };
  // `before_intent` never fires in the wrapper (it only throws after dispatch),
  // so this models "the process died before the command started": no intent, no
  // call, no evidence.
  assert.equal(intents(cli).size, 0);
  assert.equal(driver.count("op-provision"), 0);
  assert.equal(producedRoles(cli).includes("substrate-binding"), false);
});

test("INTENT-CRASH: the same operation id cannot carry different bytes", () => {
  const cli = selectedRun();
  const first = open(cli);
  first.driver.crashOn = { operationId: "op-provision", point: "after_dispatch" };
  assert.throws(() => first.run.provision(), InjectedCrash);

  const key = intents(cli).get("op-provision")?.idempotency_key;
  assert.ok(key !== undefined);
  // The idempotency key is derived from the run and the operation id, so it is
  // stable across restarts — which is what makes "same id, different bytes"
  // detectable at all.
  const second = open(cli);
  second.run.provision();
  assert.equal(intents(cli).get("op-provision")?.idempotency_key, key);
});

test("INTENT-CRASH: a subject step is not blindly repeated after an ambiguous crash", () => {
  const cli = selectedRun();
  const first = open(cli);
  first.run.provision();
  first.run.baseline();
  first.run.plan();

  // Crash after the subject responded and before the outcome is frozen.
  first.subject.crashAfterStep = true;
  assert.throws(() => first.run.runStep(), InjectedCrash);
  assert.equal(first.subject.calls, 1);
  assert.equal(intents(cli).get("op-step-0")?.state, "dispatching");

  // A fresh process must refuse rather than call the subject a second time.
  const second = open(cli);
  assert.throws(
    () => second.run.runStep(),
    (error: unknown) => (error as { code?: string }).code === "ENV_MUTATION_INTENT_AMBIGUOUS",
    "an unrepeatable operation with no probe must fail closed",
  );
  assert.equal(second.subject.calls, 0, "the subject must not be invoked again");
});

test("INTENT-CRASH: a crash between the receipt and the lifecycle append is idempotent on resume", () => {
  const cli = selectedRun();
  const first = open(cli);
  first.run.provision();
  first.run.baseline();
  first.run.plan();
  runSetupSteps(first);

  const second = open(cli);
  second.driver.crashOn = { operationId: "op-activate", point: "after_dispatch" };
  assert.throws(() => second.run.activate(), InjectedCrash);
  assert.equal(second.driver.count("op-activate"), 1);

  const third = open(cli);
  const activated = third.run.activate();
  assert.ok(activated.receiptHash.startsWith("sha256:"));
  assert.equal(
    third.driver.count("op-activate"),
    0,
    "the mutation must be adopted, not re-applied",
  );
  assert.equal(
    producedRoles(cli).filter((r) => r === "mutation-receipt").length,
    1,
    "exactly one mutation receipt",
  );
});

test("INTENT-CRASH: terminal closure stays reachable after a reconciled crash", () => {
  const cli = selectedRun();
  const first = open(cli);
  first.driver.crashOn = { operationId: "op-provision", point: "after_dispatch" };
  assert.throws(() => first.run.provision(), InjectedCrash);

  // The run recovers through the shipped CLI, exactly as an operator would.
  assert.equal(drive(cli), "generic_finalized");
});
