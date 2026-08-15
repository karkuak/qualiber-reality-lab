/**
 * The terminal a telemetry-applicable run actually reaches (ADR-ERL2-039).
 *
 * ## Why this suite exists, and why it is in-process
 *
 * The independent Package 3 live-integration review measured that the negative
 * control `telemetry-producer-gate-wiring` was a **declared no-kill**: replacing
 * the production telemetry gate's decision with a constant `true`
 *
 *     passed: String(1) === String(1) || attributableTelemetryGatePassed({…}) && …
 *
 * broke no test in the repository. Every existing test either exercised
 * `attributableTelemetryGatePassed` as a *unit* — which the mutation does not
 * touch — or drove a run whose telemetry was inapplicable (a fake driver) or
 * genuinely valid (the live Compose E2E). Nothing drove an **applicable run
 * whose telemetry gate should fail** through `EnvironmentRun.environmentGates`,
 * so the one wire that decides whether a real run's telemetry is believed was
 * measured by nothing.
 *
 * A CLI-only harness cannot close that, for the same reason the durable-intent
 * matrix could not: the shipped CLI constructs its own `FakeEnvironmentDriver`,
 * whose `driver_kind` is `fake`, so a CLI run can never be telemetry-applicable.
 * So this suite drives `EnvironmentRun` directly — against a run the shipped CLI
 * brought to `case_selected` — through a driver that reports a `compose` kind
 * and implements the package 2 trusted-telemetry seam.
 *
 * The driver is a test double for the *seam*, not for the channel: it returns
 * ERL2-C-171 records that package 2's real producer would have sealed, and every
 * authority, coherence and binding decision downstream is the production one.
 * Nothing here re-implements a check it then asserts.
 *
 * ## What each case proves
 *
 * The assertion that kills the mutation is deliberately not "a helper returned
 * false". It is the whole terminal: the gate is present and failed, the validity
 * result is `invalid`, a retained invalidity finding names the gate, and the run
 * never enters the generic evaluation index. A constant `true` turns all four
 * around at once.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
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
  type TrustedChannelCleanup,
} from "@erl2/core";
import { coreHash, developmentAgeIdentity, developmentKey, sealSigned } from "@erl2/integrity";
import {
  assertContract,
  type AttributableTelemetryObservationV2,
  type ComparisonPolicyV1,
  type CutoffPolicyV1,
  type EnvironmentArchetypeV1,
  type EnvironmentDriverManifestV1,
  type Hash,
  type SubjectAdapterManifestV1,
} from "@erl2/contracts";
import {
  ArtifactIndex,
  deriveEnvironmentClosureProgress,
  VERIFIER_RELEASE_HASH,
} from "@erl2/public-verifier";
import { selectedRun, type EnvironmentRun as CliRun } from "../support/environmentCli.js";
import {
  FIXTURE_SUBSTRATE_HASH,
  absentV2,
  observedV2,
  trustedRecord,
  trustedRecords,
} from "../support/trustedTelemetryFixtures.js";

/**
 * A driver that is a `compose` driver as far as the Lab's declaration predicate
 * can tell, and that produces whatever ERL2-C-171 record the case needs.
 *
 * `driver_kind: "compose"` is the point: it is the first conjunct of
 * `attributableTelemetryDeclared`, and without it no in-process run can reach
 * the code path this suite measures. Everything else delegates to the fake
 * driver, so the substrate, inventory, restoration and teardown are the ones
 * every other in-process suite already trusts.
 */
class TrustedSeamDriver extends FakeEnvironmentDriver {
  private readonly record: (runId: string) => AttributableTelemetryObservationV2;

  constructor(options: {
    readonly base: ConstructorParameters<typeof FakeEnvironmentDriver>[0];
    readonly record: (runId: string) => AttributableTelemetryObservationV2;
  }) {
    super(options.base);
    this.record = options.record;
    // Overridden *after* `super()`, so every receipt the fake driver issues
    // binds this manifest rather than the fake one: `manifestHash()` reads
    // `this.manifest`, and a run that bound a compose manifest will refuse a
    // restoration receipt issued against any other.
    (this as { manifest: EnvironmentDriverManifestV1 }).manifest = assertContract<
      EnvironmentDriverManifestV1
    >(
      "EnvironmentDriverManifestV1",
      sealSigned(
        {
          schema_version: "environment-driver-manifest/v1" as const,
          driver_id: "trusted-seam-test-driver",
          driver_kind: "compose" as const,
          version: "0.1.0",
          supported_operations: [
            "provision",
            "probe",
            "mutate",
            "restore",
            "destroy",
            "inspect",
          ] as const,
          resource_kinds: [...this.manifest.resource_kinds],
          enabled: true,
          // ERL2-C: "a Compose driver is only admissible against a qualified
          // substrate lock", so the contract requires this the moment
          // `driver_kind` is `compose`. This run retains no substrate binding,
          // so `trustedTelemetryBindingMatches` checks only the archetype half —
          // which is the half this suite is about.
          substrate_lock_hash: FIXTURE_SUBSTRATE_HASH as Hash,
        },
        developmentKey("challenge-governor"),
      ),
    );
  }

  // -- the package 2 seam, and the whole of it -------------------------------
  freezeTrustedTelemetryObservation(marker: string): AttributableTelemetryObservationV2 {
    return this.record(marker);
  }
  trustedChannelCleanup(): TrustedChannelCleanup {
    return { attempted: true, removed: true, surviving: [] };
  }
}

interface Composed {
  readonly run: EnvironmentRun;
  readonly runRoot: string;
  readonly archetype: EnvironmentArchetypeV1;
  readonly workspace: RunWorkspace;
}

/** A fresh `EnvironmentRun` over the CLI's run root, driven by the seam driver. */
function compose(
  cli: CliRun,
  record: (runId: string, archetypeHash: Hash) => AttributableTelemetryObservationV2,
): Composed {
  const registry = AdmissionRegistry.open(cli.registry.root);
  const clockSource = new SystemClock();
  const subject = new FakeSubjectPort({
    declaredOperations: registry.require<SubjectAdapterManifestV1>(
      cli.registry.adapterManifestHash,
      "SubjectAdapterManifestV1",
    ).operations,
  });
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
  const archetypeHash = coreHash(archetype) as Hash;
  const driver = new TrustedSeamDriver({
    base: {
      clock,
      signingKey: developmentKey("challenge-governor"),
      archetypeHash: archetype.core_hash,
      resourceKinds: archetype.topology.map((node) => node.node_id),
      evidenceSourceIds: archetype.evidence_sources.map((source) => source.source_id),
      substrate: new FileSubstrateStore(`${path.resolve(cli.runRoot)}.substrate`),
    },
    record: (runId) => record(runId, archetypeHash),
  });
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
      policyAuthor: developmentKey("policy-author"),
      vaultAuthorizer: developmentKey("vault-authorizer"),
      timestampAuthority: developmentKey("timestamp"),
      finalizer: developmentKey("finalizer"),
    },
    clock,
  });
  return { run, runRoot: cli.runRoot, archetype, workspace };
}

/**
 * Drives every environment phase in the shipped CLI's order, in-process.
 *
 * The order is `environmentPlan`'s, and it is duplicated here rather than
 * imported because that helper emits CLI argv for a CLI-constructed driver,
 * which is exactly the thing this suite cannot use.
 */
function driveToTeardown(composed: Composed, vaultRoot: string): void {
  const { run, workspace } = composed;
  run.provision();
  run.baseline();
  run.plan();
  for (const intent of ["install", "configure", "authenticate", "connect", "discover"] as const) {
    run.runStep(intent);
  }
  run.activate();
  run.journeyStart();
  run.observe();
  run.freezeObservation();
  run.runStep("exercise");
  run.runStep("observe");
  run.runStep("remove");
  run.freezeOutput();
  // `reveal` is the workspace's, with the exposure event produced inside it —
  // exactly as `erl2 reveal` composes them, so the lifecycle reaches
  // `judge_journey_expectation_revealed` and `evaluate` is legal.
  workspace.revealJudgeExpectations({
    vaultRoot,
    judgeIdentity: developmentAgeIdentity("judge"),
    alsoProduce: () => {
      const exposure = run.freezeExposure();
      return [
        {
          artifact_role: "exposure-event",
          artifact_core_hash: exposure.core_hash,
          artifact_schema_version: "exposure-event/v1",
        },
      ];
    },
  });
  run.evaluate();
  run.restore();
  run.destroy();
}

/**
 * Freezes validity exactly as `erl2 finalize-generic` does, closure and all.
 *
 * The closure verdict is the offline verifier's own derivation over the run's
 * retained tree — the same call the shipped command makes — so the
 * `mandatory-graph-closed` gate is scored by the algorithm that will score it in
 * production rather than by a convenient constant.
 */
function freezeValidity(composed: Composed): { readonly status: string } {
  const progress = deriveEnvironmentClosureProgress({
    lifecycle: composed.workspace.lifecycle.all(),
    index: ArtifactIndex.scan(composed.runRoot),
    verifierReleaseHash: VERIFIER_RELEASE_HASH,
    verifiedAt: composed.workspace.productionClock().now(),
  });
  const result = composed.run.freezeValidityAndIndex({
    derivedClosureVerdict:
      progress.missingRoles.length === 0 && progress.extraHashes.length === 0 ? "valid" : "invalid",
    derivedMissingRoles: progress.missingRoles,
    derivedExtraHashes: progress.extraHashes,
  });
  return { status: result.validity.status };
}

interface Validity {
  readonly status: string;
  readonly gate_results: readonly { readonly gate_id: string; readonly passed: boolean }[];
  readonly invalidity_finding_hashes: readonly string[];
}

function retainedValidity(runRoot: string): Validity {
  return JSON.parse(
    readFileSync(path.join(runRoot, "retained", "validity-result.json"), "utf8"),
  ) as Validity;
}

const TELEMETRY_GATE = "attributable-telemetry-retained";
const EXERCISE_GATE = "subject-exercise-succeeded";

// -- 1. the negative case: an applicable run whose channel produced nothing ---

test("ENV-TELEM-TERMINAL: a telemetry-applicable run whose channel produced nothing reaches an INVALID terminal", () => {
  const cli = selectedRun();
  const composed = compose(cli, (runId) =>
    absentV2("telemetry_channel_artifact_missing", runId),
  );
  const { runRoot } = composed;
  driveToTeardown(composed, cli.registry.vaultRoot);

  // The refusal *is* the first assertion. An invalid validity result freezes and
  // then stops: `assertValidityAdmitsGenericIndex` refuses to build a generic
  // evaluation index over it, which is what "no false-valid terminal survives"
  // means operationally. Under a telemetry gate that answered from a constant,
  // this call would simply succeed.
  assert.throws(
    () => freezeValidity(composed),
    (error: { code?: string }) => error.code === "EVALUATOR_INVALID_VALIDITY_IN_GENERIC_INDEX",
    "an invalid run must be refused entry to the generic evaluation index",
  );

  const validity = retainedValidity(runRoot);

  // 1. the gate is composed at all — this run declared telemetry obtainable.
  const gate = validity.gate_results.find((g) => g.gate_id === TELEMETRY_GATE);
  assert.notEqual(gate, undefined, "a compose-kind run with a metric source must evaluate the gate");

  // 2. it FAILED. This is the assertion the constant-true mutation turns over.
  assert.equal(
    gate?.passed,
    false,
    "an absent ERL2-C-171 record must fail the gate; a gate that answers from a constant would pass here",
  );

  // 3. the exercising step succeeded, so the failure is telemetry's alone and
  //    not an artefact of ADR-ERL2-039's exercise gate.
  assert.equal(
    validity.gate_results.find((g) => g.gate_id === EXERCISE_GATE)?.passed,
    true,
    "this case isolates the telemetry gate; the exercise must have succeeded",
  );

  // 4. the terminal is invalid, and the failure is retained rather than implied.
  assert.equal(validity.status, "invalid", "a failed telemetry gate must not reach a valid terminal");
  assert.ok(
    validity.invalidity_finding_hashes.length > 0,
    "an invalid terminal must name the Lab invalidity finding for its failed gate",
  );
  const finding = JSON.parse(
    readFileSync(
      path.join(runRoot, "retained", `finding-environment-gate-${TELEMETRY_GATE}.json`),
      "utf8",
    ),
  ) as { readonly failed_gate_ids: readonly string[] };
  assert.deepEqual(
    finding.failed_gate_ids,
    [TELEMETRY_GATE],
    "the retained finding must name the telemetry gate it was frozen for",
  );
});

// -- 2. the positive case: the same path, believed ---------------------------

test("ENV-TELEM-TERMINAL: a telemetry-applicable run with a valid C-171 passes both gates", () => {
  const cli = selectedRun();
  const composed = compose(cli, (runId, archetypeHash) =>
    observedV2({
      bytes: trustedRecords([trustedRecord({ markers: [runId] })]),
      runId,
      archetypeHash,
      spans: 1,
      serviceNames: ["quote"],
      runAttributedRecords: 1,
    }),
  );
  const { runRoot } = composed;
  driveToTeardown(composed, cli.registry.vaultRoot);

  // The positive case reaches the generic evaluation index, which is the thing
  // the negative case is refused. Asserting both directions is what keeps this
  // suite from being satisfied by a gate that simply always fails.
  assert.equal(freezeValidity(composed).status, "valid");

  const validity = retainedValidity(runRoot);
  assert.equal(
    validity.gate_results.find((g) => g.gate_id === TELEMETRY_GATE)?.passed,
    true,
    "a valid, run-bound, run-attributed ERL2-C-171 record must pass the gate",
  );
  assert.equal(
    validity.gate_results.find((g) => g.gate_id === EXERCISE_GATE)?.passed,
    true,
  );
  assert.equal(validity.status, "valid");
  assert.equal(validity.invalidity_finding_hashes.length, 0);
});
