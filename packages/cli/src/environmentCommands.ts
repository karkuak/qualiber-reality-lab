/**
 * The environment and journey commands (design v2 Appendix C, Slice 6.5-B).
 *
 * Each one is a separate process over durable run state: it opens the workspace,
 * rebuilds the environment composition from the run's own retained evidence, and
 * advances exactly one phase of `ENVIRONMENT_PHASES`. Nothing is held between
 * commands.
 *
 * ## Where the environment lives
 *
 * The driver's substrate and the global reservation allocator are **not** part of
 * the run root. They default to sibling directories (`<run-root>.substrate`,
 * `<run-root>.reservations`) and may be pointed anywhere with a flag. That is not
 * a convenience: an artifact index scans the whole run root, so substrate state
 * inside it would be indexed as evidence, and a Compose project inside the
 * evidence tree would be the same category error.
 *
 * ## Where the environment's identity comes from
 *
 * The archetype, comparison policy and cutoff policy are named by hash *once* and
 * mirrored into the run. Every later command resolves them from `retained/` and
 * refuses a flag that names something else — the same rule that stops a run
 * substituting its adapter after preregistration.
 */

import path from "node:path";
import { CODES, Erl2Error, type Hash } from "./contractsFacade.js";
import type {
  ChallengeManifestV1,
  ComparisonPolicyV1,
  CutoffPolicyV1,
  EnvironmentArchetypeV1,
  JourneyIntent,
  SelectedChallengeJourneyBindingV1,
} from "@erl2/contracts";
import {
  EnvironmentRun,
  FakeEnvironmentDriver,
  FileSubstrateStore,
  ReservationAllocator,
  RunWorkspace,
  type EnvironmentKeyring,
} from "@erl2/core";
import {
  ArtifactIndex,
  deriveEnvironmentClosureProgress,
  VERIFIER_RELEASE_HASH,
} from "@erl2/public-verifier";
import { developmentAgeIdentity, developmentKey } from "@erl2/integrity";
import { parseFlags, requireString, type FlagSpec, type ParsedFlags } from "./args.js";
import { COMMON_FLAGS, openWorkspace, type JourneyCommandOutput } from "./journeyCommands.js";

/** Flags every environment command accepts on top of the common ones. */
const ENVIRONMENT_FLAGS: readonly FlagSpec[] = [
  ...COMMON_FLAGS,
  { name: "substrate-root", kind: "string" },
  { name: "reservation-root", kind: "string" },
  { name: "archetype", kind: "string" },
  { name: "comparison-policy", kind: "string" },
  { name: "cutoff-policy", kind: "string" },
];

function substrateRoot(flags: ParsedFlags): string {
  const supplied = flags["substrate-root"] as string | undefined;
  return supplied ?? `${path.resolve(requireString(flags, "run-root"))}.substrate`;
}

function reservationRoot(flags: ParsedFlags): string {
  const supplied = flags["reservation-root"] as string | undefined;
  return supplied ?? `${path.resolve(requireString(flags, "run-root"))}.reservations`;
}

function hashFlag(flags: ParsedFlags, name: string): Hash | undefined {
  const value = flags[name] as string | undefined;
  if (value === undefined) return undefined;
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new Erl2Error(CODES.CFG_MISSING_REQUIRED, `--${name} must be a sha256 core hash`);
  }
  return value as Hash;
}

/**
 * Resolves an admission input that a run binds once and then owns.
 *
 * If the run already retains it, that is the answer and a flag naming anything
 * else is refused. Otherwise the flag is required and resolved from the governor
 * registry — never from the run, which does not have it yet.
 */
function resolveAdmitted<T>(options: {
  readonly workspace: RunWorkspace;
  readonly flags: ParsedFlags;
  readonly flagName: string;
  readonly contract: string;
  readonly retainedHash: Hash | undefined;
  readonly label: string;
}): T {
  const supplied = hashFlag(options.flags, options.flagName);
  if (options.retainedHash !== undefined) {
    if (supplied !== undefined && supplied !== options.retainedHash) {
      throw new Erl2Error(
        CODES.ADMISSION_ARTIFACT_UNKNOWN,
        `--${options.flagName} does not match the ${options.label} this run already bound; a run cannot substitute it`,
      );
    }
    return options.workspace.artifact<T>(options.retainedHash, options.contract);
  }
  if (supplied === undefined) {
    throw new Erl2Error(
      CODES.CFG_MISSING_REQUIRED,
      `--${options.flagName} is required: this run has not yet bound its ${options.label}`,
    );
  }
  return options.workspace.registry.require<T>(supplied, options.contract);
}

/** The core hash of a retained artifact of the given schema, if the run has one. */
function retainedHashOfSchema(workspace: RunWorkspace, schemaVersion: string): Hash | undefined {
  return ArtifactIndex.scan(workspace.store.root)
    .all()
    .find((artifact) => artifact.schemaVersion === schemaVersion)?.coreHash;
}

/**
 * The environment signing roles.
 *
 * Three distinct keys, because the cutoff must be checkable without trusting any
 * one of them, and the exposure record must not be issued by the authority whose
 * challenge it demotes (ADR-ERL2-021).
 */
function environmentKeyring(): EnvironmentKeyring {
  return {
    controller: developmentKey("challenge-governor"),
    trafficSupervisor: developmentKey("traffic-supervisor"),
    runtimeAttestor: developmentKey("runtime-attestor"),
    vaultAuthorizer: developmentKey("vault-authorizer"),
  };
}

export interface EnvironmentContext {
  readonly workspace: RunWorkspace;
  readonly run: EnvironmentRun;
  readonly runId: string;
  readonly runRoot: string;
  readonly flags: ParsedFlags;
}

/**
 * Builds the environment composition for one command.
 *
 * The archetype is checked against the *selected challenge's* admissible
 * archetype set the first time it is bound: a run may not be provisioned into an
 * environment its own challenge never admitted.
 */
export function openEnvironment(argv: readonly string[], extra: readonly FlagSpec[] = []): EnvironmentContext {
  const flags = parseFlags(argv, [...ENVIRONMENT_FLAGS, ...extra]);
  const runId = requireString(flags, "run");
  const runRoot = requireString(flags, "run-root");
  const workspace = openWorkspace(flags, runId);
  const clock = workspace.productionClock();

  const archetype = resolveAdmitted<EnvironmentArchetypeV1>({
    workspace,
    flags,
    flagName: "archetype",
    contract: "EnvironmentArchetypeV1",
    retainedHash: retainedHashOfSchema(workspace, "environment-archetype/v1"),
    label: "environment archetype",
  });
  assertArchetypeAdmissible(workspace, archetype);

  // Resolved lazily: a run binds these at `journey`, so `provision`, `baseline`
  // and `plan` must not demand them.
  const comparisonPolicy = (): ComparisonPolicyV1 =>
    resolveAdmitted<ComparisonPolicyV1>({
      workspace,
      flags,
      flagName: "comparison-policy",
      contract: "ComparisonPolicyV1",
      retainedHash: retainedHashOfSchema(workspace, "comparison-policy/v1"),
      label: "comparison policy",
    });
  const cutoffPolicy = (): CutoffPolicyV1 =>
    resolveAdmitted<CutoffPolicyV1>({
      workspace,
      flags,
      flagName: "cutoff-policy",
      contract: "CutoffPolicyV1",
      retainedHash: retainedHashOfSchema(workspace, "cutoff-policy/v1"),
      label: "cutoff policy",
    });

  const driver = new FakeEnvironmentDriver({
    clock,
    // The driver manifest is the environment governor's, and the development
    // policy grants that role to the challenge-governor key (ADR-ERL2-020 §4).
    signingKey: developmentKey("challenge-governor"),
    archetypeHash: archetype.core_hash,
    resourceKinds: archetype.topology.map((node) => node.node_id),
    evidenceSourceIds: archetype.evidence_sources.map((source) => source.source_id),
    substrate: new FileSubstrateStore(substrateRoot(flags)),
  });

  const run = new EnvironmentRun({
    workspace,
    driver,
    allocator: new ReservationAllocator({ root: reservationRoot(flags), clock }),
    archetype,
    comparisonPolicy,
    cutoffPolicy,
    keys: environmentKeyring(),
    clock,
  });
  return { workspace, run, runId, runRoot, flags };
}

/**
 * The archetype must be one the selected challenge admits.
 *
 * Checked from the run's own retained challenge manifest, so an operator cannot
 * provision a different environment than the one the selected case was admitted
 * for by passing a different `--archetype`.
 */
function assertArchetypeAdmissible(workspace: RunWorkspace, archetype: EnvironmentArchetypeV1): void {
  const bindingHash = workspace.hashForRole("selected-challenge-journey-binding");
  if (bindingHash === undefined) return;
  const binding = workspace.artifact<SelectedChallengeJourneyBindingV1>(
    bindingHash,
    "SelectedChallengeJourneyBindingV1",
  );
  const challenge = workspace.artifact<ChallengeManifestV1>(
    binding.challenge_manifest_hash,
    "ChallengeManifestV1",
  );
  if (!challenge.archetype_hashes.includes(archetype.core_hash)) {
    throw new Erl2Error(
      CODES.ADMISSION_ARTIFACT_UNKNOWN,
      `archetype ${archetype.archetype_id} is not in the selected challenge's admissible archetype set`,
    );
  }
}

function output(ctx: EnvironmentContext, data: Record<string, unknown>): JourneyCommandOutput {
  return { runId: ctx.runId, state: ctx.workspace.lifecycle.currentState, data };
}

// -- the phase commands ------------------------------------------------------

export function provision(argv: readonly string[]): JourneyCommandOutput {
  const ctx = openEnvironment(argv);
  const result = ctx.run.provision();
  return output(ctx, {
    environment_instance_hash: result.inventory.core_hash,
    resource_count: result.inventory.resources.length,
    reservation_lease_count: result.leases,
  });
}

export function baseline(argv: readonly string[]): JourneyCommandOutput {
  const ctx = openEnvironment(argv);
  const fingerprint = ctx.run.baseline();
  return output(ctx, {
    baseline_hash: fingerprint.core_hash,
    fingerprint_hash: fingerprint.fingerprint_hash,
    contamination_detected: fingerprint.contamination.detected,
    probe_count: fingerprint.probes.length,
    evidence_source_count: fingerprint.evidence_source_states.length,
  });
}

export function plan(argv: readonly string[]): JourneyCommandOutput {
  const ctx = openEnvironment(argv);
  const executionPlan = ctx.run.plan();
  return output(ctx, {
    execution_plan_hash: executionPlan.core_hash,
    actor_script_hash: executionPlan.actor_script_hash,
    journey_hash: executionPlan.journey_hash,
  });
}

/**
 * Runs the next committed step of the selected journey.
 *
 * An intent-named command passes its own intent, which acts as a guard: the
 * journey's order decides what runs next, and a command that names a different
 * intent is refused rather than reordering the journey.
 */
function step(argv: readonly string[], intent?: JourneyIntent): JourneyCommandOutput {
  const ctx = openEnvironment(argv);
  const outcome = intent === undefined ? ctx.run.runStep() : ctx.run.runStep(intent);
  const next = ctx.run.nextStep();
  return output(ctx, {
    step_id: outcome.step_id,
    intent: outcome.intent,
    status: outcome.status,
    step_outcome_hash: outcome.core_hash,
    unsupported_inputs: outcome.status === "unsupported" ? outcome.detail_record_hashes.length : 0,
    ...(next === undefined ? { journey_complete: true } : { next_intent: next.intent }),
  });
}

export const executeSubject = (argv: readonly string[]): JourneyCommandOutput => step(argv);
export const install = (argv: readonly string[]): JourneyCommandOutput => step(argv, "install");
export const configure = (argv: readonly string[]): JourneyCommandOutput => step(argv, "configure");
export const authenticate = (argv: readonly string[]): JourneyCommandOutput => step(argv, "authenticate");
export const connect = (argv: readonly string[]): JourneyCommandOutput => step(argv, "connect");
export const recover = (argv: readonly string[]): JourneyCommandOutput => step(argv, "recover");
export const rollback = (argv: readonly string[]): JourneyCommandOutput => step(argv, "rollback");
export const remove = (argv: readonly string[]): JourneyCommandOutput => step(argv, "remove");

export function activate(argv: readonly string[]): JourneyCommandOutput {
  const ctx = openEnvironment(argv);
  const result = ctx.run.activate();
  return output(ctx, { activation_receipt_hash: result.receiptHash });
}

export function journey(argv: readonly string[]): JourneyCommandOutput {
  const ctx = openEnvironment(argv);
  const result = ctx.run.journeyStart();
  return output(ctx, { runtime_milestone_hash: result.milestoneHash });
}

export function observe(argv: readonly string[]): JourneyCommandOutput {
  const ctx = openEnvironment(argv);
  const result = ctx.run.observe();
  return output(ctx, {
    cutoff_instant: result.cutoffInstant,
    source_snapshot_count: result.snapshots.length,
    source_states: result.snapshots.map((snapshot) => ({
      source_id: snapshot.source_id,
      state: snapshot.state,
    })),
  });
}

export function freezeObservation(argv: readonly string[]): JourneyCommandOutput {
  const ctx = openEnvironment(argv);
  const result = ctx.run.freezeObservation();
  return output(ctx, {
    observation_bundle_hash: result.observation.core_hash,
    canonical_evidence_envelope_hash: result.envelope.core_hash,
    envelope_entry_count: result.envelope.entries.length,
    adapter_translation_receipt_hash: ctx.workspace.hashForRole("adapter-translation-receipt"),
  });
}

export function restore(argv: readonly string[]): JourneyCommandOutput {
  const ctx = openEnvironment(argv);
  const restoration = ctx.run.restore();
  return output(ctx, {
    environment_restoration_hash: restoration.core_hash,
    passed: restoration.passed,
    residual_resources: restoration.residual_resources.length,
  });
}

export function destroy(argv: readonly string[]): JourneyCommandOutput {
  const ctx = openEnvironment(argv);
  const result = ctx.run.destroy();
  return output(ctx, {
    teardown_hash: result.teardown.core_hash,
    passed: result.teardown.passed,
    residue_after_teardown: result.residue,
    checks: result.teardown.checks.length,
  });
}

// -- shared commands, environment branch ------------------------------------

/** True once the run has an execution plan: the point of no return into the environment branch. */
export function isEnvironmentBranch(workspace: RunWorkspace): boolean {
  return workspace.hashForRole("execution-plan") !== undefined;
}

export function freezeEnvironmentOutput(argv: readonly string[]): JourneyCommandOutput {
  const ctx = openEnvironment(argv, [{ name: "terminal-stage", kind: "string" }]);
  const manifest = ctx.run.freezeOutput();
  return output(ctx, {
    subject_output_hash: manifest.core_hash,
    terminal_stage: manifest.terminal_stage,
    step_outcome_hashes: manifest.step_outcome_hashes,
    unsupported_inputs: manifest.unsupported_inputs,
    tree_hash: manifest.tree_hash,
  });
}

/**
 * `erl2 reveal` on the environment branch.
 *
 * The exposure event is produced in the *same* durable transition as the reveal:
 * opening the sealed case and recording that it is open are one act, so a reader
 * can never find a run that opened a challenge without saying so.
 */
export function revealEnvironment(argv: readonly string[]): JourneyCommandOutput {
  const ctx = openEnvironment(argv, [
    { name: "vault", kind: "string", required: true },
    { name: "judge-identity", kind: "string" },
  ]);
  const label = (ctx.flags["judge-identity"] as string | undefined) ?? "judge";
  let exposureHash: Hash | undefined;
  const revealed = ctx.workspace.revealJudgeExpectations({
    vaultRoot: requireString(ctx.flags, "vault"),
    judgeIdentity: developmentAgeIdentity(label),
    alsoProduce: () => {
      const exposure = ctx.run.freezeExposure();
      exposureHash = exposure.core_hash;
      return [
        {
          artifact_role: "exposure-event",
          artifact_core_hash: exposure.core_hash,
          artifact_schema_version: "exposure-event/v1",
        },
      ];
    },
  });
  return output(ctx, {
    reveal_record_hash: revealed.recordHash,
    revealed_expectation_hashes: revealed.revealedExpectationHashes,
    revealed_count: revealed.revealedExpectationHashes.length,
    exposure_event_hash: exposureHash,
  });
}

export function evaluateEnvironment(argv: readonly string[]): JourneyCommandOutput {
  const ctx = openEnvironment(argv, [{ name: "finding", kind: "string" }]);
  const result = ctx.run.evaluate();
  return output(ctx, {
    journey_result_hash: result.journeyResult.core_hash,
    journey_status: result.journeyResult.status,
    domain_result_hash: result.domainResult.core_hash,
    domain_status: result.domainResult.status,
    domain_not_applicable_reason: result.domainResult.reason,
    precleanup_result_join_hash: result.join.core_hash,
    metric_result_hashes: result.metricResults.map((metric) => metric.core_hash),
  });
}

/**
 * `erl2 finalize-generic` on the environment branch: validity, then the generic
 * evaluation index.
 *
 * The closure verdict the `mandatory-graph-closed` gate scores is derived by the
 * offline verifier's own algorithm over this run's retained tree — not by a
 * producer assertion, and not by a second implementation of the same check.
 */
export function finalizeEnvironment(argv: readonly string[]): JourneyCommandOutput {
  const ctx = openEnvironment(argv, [{ name: "claim-scope", kind: "string" }]);
  const progress = deriveEnvironmentClosureProgress({
    lifecycle: ctx.workspace.lifecycle.all(),
    index: ArtifactIndex.scan(ctx.runRoot),
    verifierReleaseHash: VERIFIER_RELEASE_HASH,
    verifiedAt: ctx.workspace.productionClock().now(),
  });
  const result = ctx.run.freezeValidityAndIndex({
    derivedClosureVerdict:
      progress.missingRoles.length === 0 && progress.extraHashes.length === 0 ? "valid" : "invalid",
    derivedMissingRoles: progress.missingRoles,
    derivedExtraHashes: progress.extraHashes,
  });
  return output(ctx, {
    validity_result_hash: result.validity.core_hash,
    validity_status: result.validity.status,
    generic_evaluation_index_hash: result.index.core_hash,
    derived_missing_roles: progress.missingRoles,
    derived_extra_hashes: progress.extraHashes,
  });
}

