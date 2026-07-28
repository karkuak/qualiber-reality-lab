/**
 * Journey commands: acquisition through frozen subject output (design v2
 * Appendix C).
 *
 * Each command is a separate process operating on durable run state. The
 * workspace recovers its lifecycle from frozen events, so ordering is enforced
 * by the state machine and the role-resolution rules rather than by anything
 * held in memory between commands.
 *
 * Fail-closed states this surface preserves:
 *   - only `--tier development` is accepted, because the fake subject port and
 *     the development beacon are the only ones qualified (ERL2-OQ-007);
 *   - `--keyring development` is the only keyring, and it derives deterministic
 *     labelled development keys — there is no production key path here.
 */

import {
  Erl2Error,
  CODES,
  parseStrictJson,
  type Hash,
  type SubjectAdapterManifestV1,
  type Tier,
} from "@erl2/contracts";
import {
  AdapterHost,
  AdmissionRegistry,
  FakeSubjectPort,
  HostedSubjectPort,
  JOURNEY_PLANE_METRICS,
  type FakeSubjectBehaviour,
  RunWorkspace,
  SteppingClock,
  SystemClock,
  newRunId,
  type Clock,
  type SubjectPort,
  type WorkspaceKeyring,
} from "@erl2/core";
import { ArtifactIndex, VERIFIER_RELEASE_HASH, derivePreFinalizationClosure } from "@erl2/public-verifier";
import { ArtifactStore, developmentAgeIdentity, developmentKey } from "@erl2/integrity";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseFlags, requireString, type FlagSpec, type ParsedFlags } from "./args.js";
import { assembleSelection, loadSourceTrustConfig } from "./selectCommand.js";

const COMMON_FLAGS: readonly FlagSpec[] = [
  { name: "run-root", kind: "string", required: true },
  { name: "registry", kind: "string", required: true },
  { name: "run", kind: "string" },
  { name: "tier", kind: "string" },
  { name: "keyring", kind: "string" },
  { name: "fake-acquire", kind: "string" },
  { name: "fake-verify-package", kind: "string" },
  { name: "adapter-entry", kind: "string" },
];

/**
 * The fake-subject-port scripting flags (`--fake-acquire`/`--fake-verify-package`)
 * are development-only shortcuts that steer test failpoints of the fake port.
 * They are NOT reachable on the default release surface (review §11.8, plan
 * §8.5, index.ts "no development-only shortcut is reachable"); they are enabled
 * only under an explicit, separate development profile signalled by the
 * `ERL2_DEVELOPMENT_FAKE_SUBJECT=1` environment variable.  A caller who passes a
 * fake flag without that profile is refused with a stable code — the flag can
 * never silently script a run on the release surface.
 */
function developmentFakeSubjectProfileEnabled(): boolean {
  return process.env["ERL2_DEVELOPMENT_FAKE_SUBJECT"] === "1";
}

function assertFakeFlagsUnavailableUnlessDevelopmentProfile(flags: ParsedFlags): void {
  const usesFakeFlag =
    flags["fake-acquire"] !== undefined || flags["fake-verify-package"] !== undefined;
  if (usesFakeFlag && !developmentFakeSubjectProfileEnabled()) {
    throw new Erl2Error(
      CODES.CFG_DEVELOPMENT_FLAG_UNAVAILABLE,
      "--fake-acquire and --fake-verify-package are development-only shortcuts; they require the explicit " +
        "development profile (ERL2_DEVELOPMENT_FAKE_SUBJECT=1) and are not reachable on the release surface",
    );
  }
}

function requireDevelopmentTier(flags: ParsedFlags): Tier {
  const tier = (flags["tier"] as string | undefined) ?? "development";
  if (tier !== "development") {
    throw new Erl2Error(
      CODES.ADMISSION_SUBJECT_PORT_NOT_DEVELOPMENT,
      `tier ${tier} is refused: held-out and blind execution is disabled pending ERL2-OQ-007`,
    );
  }
  return tier;
}

function developmentKeyring(flags: ParsedFlags): WorkspaceKeyring {
  const keyring = (flags["keyring"] as string | undefined) ?? "development";
  if (keyring !== "development") {
    throw new Erl2Error(
      CODES.CFG_MISSING_REQUIRED,
      `keyring ${keyring} is not available; only the labelled development keyring exists in this slice`,
    );
  }
  return {
    preregistrar: developmentKey("preregistrar"),
    finalizer: developmentKey("finalizer"),
    timestampAuthority: developmentKey("timestamp"),
    evaluator: developmentKey("evaluator"),
  };
}

/**
 * A run's post-acceptance artifacts are stamped by a clock anchored
 * deterministically on the durable preregistration time (`registered_at`), so a
 * replayed command rebuilds byte-identical records and step outcomes — the
 * re-freeze is idempotent rather than an `ARTIFACT_ALREADY_FROZEN` conflict
 * (P1-2 §7.3).  Preregistration itself (no prior run) is stamped with wall time
 * and is never replayed (each preregistration allocates a fresh run).
 */
function runClock(runRoot: string): Clock {
  const preregPath = path.join(path.resolve(runRoot), "retained", "acquisition-preregistration.json");
  if (existsSync(preregPath)) {
    try {
      const prereg = parseStrictJson(readFileSync(preregPath, "utf8")) as { registered_at?: unknown };
      if (typeof prereg.registered_at === "string") {
        return new SteppingClock(prereg.registered_at, 1000);
      }
    } catch {
      // Fall through to wall time; a torn prereg is caught later by the workspace.
    }
  }
  // Deterministic-evidence anchor: when generating pinned evidence, the
  // composition root sets `ERL2_EVIDENCE_CLOCK` to a fixed instant so
  // preregistration (which has no prior run to anchor on) is byte-reproducible.
  // This is an evidence/CI mechanism read only by the CLI composition root; core
  // still receives an injected clock (P2-10, plan §19.3).
  const evidenceClock = process.env["ERL2_EVIDENCE_CLOCK"];
  if (evidenceClock !== undefined && evidenceClock.length > 0) {
    return new SteppingClock(evidenceClock, 1000);
  }
  return new SystemClock();
}

function openWorkspace(flags: ParsedFlags, runId: string): RunWorkspace {
  const runRoot = requireString(flags, "run-root");
  const registry = AdmissionRegistry.open(requireString(flags, "registry"));
  const clock = runClock(runRoot);
  return new RunWorkspace({
    runId,
    runRoot,
    registry,
    clock,
    keyring: developmentKeyring(flags),
    tier: requireDevelopmentTier(flags),
    subjectPort: subjectPort(flags, runId, runRoot, registry, clock),
  });
}

/**
 * The subject seam.
 *
 * With `--adapter-entry` the run drives a real, certified, out-of-process
 * adapter through the Slice 5 host — the same public protocol any opaque
 * subject uses. Without it the development-only fake port stands in, which the
 * tier gate confines to `--tier development`.
 */
function subjectPort(
  flags: ParsedFlags,
  runId: string,
  runRoot: string,
  registry: AdmissionRegistry,
  clock: SystemClock,
): SubjectPort {
  const entry = flags["adapter-entry"] as string | undefined;
  if (entry === undefined) {
    // The scripting flags are refused unless the explicit development profile is
    // enabled — they are not reachable on the release surface (§11.8).
    assertFakeFlagsUnavailableUnlessDevelopmentProfile(flags);
    return new FakeSubjectPort(fakeSubjectBehaviour(flags));
  }
  if (flags["fake-acquire"] !== undefined || flags["fake-verify-package"] !== undefined) {
    throw new Erl2Error(
      CODES.CFG_MISSING_REQUIRED,
      "--fake-acquire and --fake-verify-package script the development fake port; they cannot steer a real adapter",
    );
  }
  const manifest = registry.require<SubjectAdapterManifestV1>(
    adapterManifestHash(flags, runRoot),
    "SubjectAdapterManifestV1",
  );
  return new HostedSubjectPort(
    new AdapterHost({
      runId,
      adapterManifest: manifest,
      adapterEntryPath: entry,
      workspaceRoot: path.join(path.resolve(runRoot), "adapter-workspace"),
      store: new ArtifactStore(runRoot),
      clock,
    }),
  );
}

/**
 * Resolves the adapter manifest from durable state.
 *
 * After preregistration the run itself records which adapter it bound, so a
 * later command cannot substitute a different one by passing a flag.
 */
function adapterManifestHash(flags: ParsedFlags, runRoot: string): Hash {
  const preregPath = path.join(path.resolve(runRoot), "retained", "acquisition-preregistration.json");
  if (existsSync(preregPath)) {
    const prereg = parseStrictJson(readFileSync(preregPath, "utf8")) as {
      adapter_manifest_hash?: string;
    };
    const bound = prereg.adapter_manifest_hash;
    if (typeof bound === "string") {
      const supplied = flags["adapter"] as string | undefined;
      if (supplied !== undefined && supplied !== bound) {
        throw new Erl2Error(
          CODES.ADMISSION_ARTIFACT_UNKNOWN,
          "--adapter does not match the adapter this run preregistered; a run cannot substitute its adapter",
        );
      }
      return bound as Hash;
    }
  }
  return hash(flags, "adapter");
}

/**
 * Scripted fake-subject behaviour, for exercising failure paths from the CLI.
 * It exists only because the fake port is development-only; the slice 5 adapter
 * host has no such flag.
 */
function fakeSubjectBehaviour(flags: ParsedFlags): FakeSubjectBehaviour {
  const acquire = flags["fake-acquire"] as string | undefined;
  const verify = flags["fake-verify-package"] as string | undefined;
  if (acquire !== undefined && acquire !== "succeeded" && acquire !== "failed") {
    throw new Erl2Error(CODES.CFG_MISSING_REQUIRED, "--fake-acquire must be succeeded or failed");
  }
  if (
    verify !== undefined &&
    verify !== "succeeded" &&
    verify !== "failed" &&
    verify !== "unsupported"
  ) {
    throw new Erl2Error(
      CODES.CFG_MISSING_REQUIRED,
      "--fake-verify-package must be succeeded, failed or unsupported",
    );
  }
  return {
    ...(acquire === undefined ? {} : { acquireStatus: acquire }),
    ...(verify === undefined ? {} : { packageVerificationStatus: verify }),
  };
}

/** A repeated `--flag <hash>`, validated exactly as a single `hash()` is. */
function hashList(flags: ParsedFlags, name: string): readonly Hash[] {
  const values = flags[name];
  if (!Array.isArray(values) || values.length === 0) {
    throw new Erl2Error(CODES.CFG_MISSING_REQUIRED, `flag --${name} is required`);
  }
  const seen = new Set<string>();
  return values.map((value) => {
    if (!/^sha256:[0-9a-f]{64}$/.test(value)) {
      throw new Erl2Error(CODES.CFG_MISSING_REQUIRED, `--${name} must be a sha256 core hash`);
    }
    if (seen.has(value)) {
      throw new Erl2Error(CODES.CFG_DUPLICATE_FLAG, `--${name} names ${value} more than once`);
    }
    seen.add(value);
    return value as Hash;
  });
}

function hash(flags: ParsedFlags, name: string): Hash {
  const value = requireString(flags, name);
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new Erl2Error(CODES.CFG_MISSING_REQUIRED, `--${name} must be a sha256 core hash`);
  }
  return value as Hash;
}

export interface JourneyCommandOutput {
  readonly runId: string;
  readonly state: string;
  readonly data: Record<string, unknown>;
  /**
   * Set when the run reached a *terminal* through a typed failure.
   *
   * The command still returns its record hashes — Appendix C forbids returning
   * a terminal run state without them — but the CLI exits on the failure's own
   * code so a caller cannot mistake "invalidated cleanly" for "succeeded".
   */
  readonly terminalError?: Erl2Error;
}

/**
 * Freezes the invalid terminal for an adapter-owned failure.
 *
 * The order is the design's: detection, then bounded cleanup from the actual
 * resource frontier, then exactly one invalid record. No attestation and no
 * bundle can descend from it.
 */
function invalidateAfterAdapterFailure(
  workspace: RunWorkspace,
  runId: string,
  phase: "acquisition" | "package_verification",
  cause: Erl2Error,
): JourneyCommandOutput {
  const findingHash = workspace.freezeAdapterFailureFinding({
    findingId: "adapter-protocol-failure",
    category: "adapter_protocol_failure",
    summary: `${cause.code}: ${cause.message}`,
    proofRefs: [workspace.requireHashForRole("acquisition-preregistration")],
  });
  const failureEvent = workspace.lifecycle.find((e) => e.failure !== undefined);
  const invalid = workspace.invalidate({
    phase,
    // An adapter that never produced a response left no step event behind, so
    // the detection event carries the failure itself.
    ...(failureEvent === undefined
      ? {
          failure: {
            code: cause.code,
            owner: "adapter" as const,
            message: cause.message.slice(0, 512),
          },
        }
      : { failureEventHash: failureEvent.core_hash }),
    primaryFindingHash: findingHash,
    classification: "adapter_failure",
  });
  return {
    runId,
    state: workspace.lifecycle.currentState,
    data: {
      invalid_run_record_hash: invalid.core_hash,
      terminal_state: invalid.terminal_state,
      cleanup_variant: invalid.cleanup.variant,
      adapter_failure_finding_hash: findingHash,
      refusal_code: cause.code,
    },
    terminalError: cause,
  };
}

export function preregisterAcquisition(argv: readonly string[]): JourneyCommandOutput {
  const flags = parseFlags(argv, [
    ...COMMON_FLAGS,
    { name: "acquisition-source", kind: "string", required: true },
    { name: "adapter", kind: "string", required: true },
    { name: "acquisition-actor-script", kind: "string", required: true },
    { name: "acquisition-actor-schema", kind: "string", required: true },
    { name: "acquisition-step", kind: "string", required: true },
    { name: "package-verification-step", kind: "string", required: true },
    { name: "generic-policy", kind: "string", required: true },
    { name: "trust-policy", kind: "string", required: true },
    { name: "limits", kind: "string", required: true },
    { name: "expires", kind: "string", required: true },
  ]);
  const runId = (flags["run"] as string | undefined) ?? newRunId();
  const workspace = openWorkspace(flags, runId);
  const preregistration = workspace.preregisterAcquisition({
    sourceManifestHash: hash(flags, "acquisition-source"),
    adapterManifestHash: hash(flags, "adapter"),
    genericRunPolicyHash: hash(flags, "generic-policy"),
    runTrustPolicyHash: hash(flags, "trust-policy"),
    acquisitionActorScriptHash: hash(flags, "acquisition-actor-script"),
    acquisitionActorSchemaHash: hash(flags, "acquisition-actor-schema"),
    acquisitionStepCommitmentHash: hash(flags, "acquisition-step"),
    packageVerificationStepCommitmentHash: hash(flags, "package-verification-step"),
    limitsHash: hash(flags, "limits"),
    expiresAt: requireString(flags, "expires"),
  });
  return {
    runId,
    state: workspace.lifecycle.currentState,
    data: {
      acquisition_preregistration_hash: preregistration.core_hash,
      selected_case_identity: preregistration.selected_case_identity,
    },
  };
}

export function acquire(argv: readonly string[]): JourneyCommandOutput {
  const flags = parseFlags(argv, COMMON_FLAGS);
  const runId = requireString(flags, "run");
  const workspace = openWorkspace(flags, runId);

  let record;
  try {
    record = workspace.acquire();
  } catch (cause) {
    // Failure ownership (design §20, review §7.5): only an *adapter*-owned
    // failure (timeout, crash, protocol violation) becomes an adapter finding
    // and invalid record.  A Lab-owned failure — a lease conflict, an
    // `ARTIFACT_ALREADY_FROZEN` persistence conflict (which defaults to owner
    // `lab`), a closure failure — must NOT be laundered into a fabricated
    // adapter finding; it propagates as the Lab error it is.  A subject-owned
    // outcome is handled on the normal path, not here.
    if (!(cause instanceof Erl2Error) || cause.owner !== "adapter") throw cause;
    return invalidateAfterAdapterFailure(workspace, runId, "acquisition", cause);
  }

  const data: Record<string, unknown> = {
    acquisition_record_hash: record.core_hash,
    status: record.status,
    attempts: record.attempts.length,
    active_operator_ms: record.active_operator_ms,
    elapsed_ms: record.elapsed_ms,
    documentation_step_ids: record.documentation_step_ids,
    authentication_prompt_count: record.authentication_prompt_count,
  };

  if (record.status !== "completed") {
    // Design v2 Appendix C: once a run id is durably accepted, the CLI may not
    // return a terminal state without its record hash. A failed acquisition
    // freezes subject output, runs bounded pre-environment cleanup and freezes
    // exactly one invalid record.
    workspace.freezeSubjectOutput({ terminalStage: "acquire" });
    const failureEvent = workspace.lifecycle.find((e) => e.failure !== undefined);
    const findingHash = workspace.freezeInvalidityFinding({
      findingId: "subject-acquisition-failure",
      category: "lab_evidence_failure",
      summary: "Acquisition did not complete; the run has no package to verify.",
      failedGateIds: ["acquisition-completed"],
      proofRefs: [record.core_hash],
    });
    const invalid = workspace.invalidate({
      phase: "acquisition",
      failureEventHash: failureEvent?.core_hash ?? record.core_hash,
      primaryFindingHash: findingHash,
      classification: "dependency_failure",
    });
    data["invalid_run_record_hash"] = invalid.core_hash;
    data["terminal_state"] = invalid.terminal_state;
    data["cleanup_variant"] = invalid.cleanup.variant;
  }

  return { runId, state: workspace.lifecycle.currentState, data };
}

export function freezePackage(argv: readonly string[]): JourneyCommandOutput {
  const flags = parseFlags(argv, COMMON_FLAGS);
  const runId = requireString(flags, "run");
  const workspace = openWorkspace(flags, runId);
  const ref = workspace.freezePackage();
  return {
    runId,
    state: workspace.lifecycle.currentState,
    data: { frozen_package_path: ref.path, frozen_package_file_sha256: ref.file_sha256 },
  };
}

export function verifyPackage(argv: readonly string[]): JourneyCommandOutput {
  const flags = parseFlags(argv, [
    ...COMMON_FLAGS,
    { name: "subject-id", kind: "string", required: true },
    { name: "subject-version", kind: "string", required: true },
  ]);
  const runId = requireString(flags, "run");
  const workspace = openWorkspace(flags, runId);
  const record = workspace.verifyPackage();
  const data: Record<string, unknown> = {
    package_verification_record_hash: record.core_hash,
    status: record.status,
  };
  if (record.status === "completed") {
    const manifest = workspace.freezePackageManifest({
      subjectId: requireString(flags, "subject-id"),
      subjectVersion: requireString(flags, "subject-version"),
    });
    data["subject_package_manifest_hash"] = manifest.core_hash;
    data["package_file_sha256"] = manifest.package_file_sha256;
    // ADR-ERL2-013: a successful package manifest has exactly one authorized
    // continuation, so the response says so rather than leaving a caller to
    // discover it by attempting a forbidden early terminal.
    data["next_authorized_state"] = "challenge_preregistered";
  }
  return { runId, state: workspace.lifecycle.currentState, data };
}

/**
 * `erl2 reveal` — opens the committed judge expectations for the failed and
 * unsupported steps, after the subject output has frozen.
 *
 * The judge identity is a development-only, label-derived age identity, and the
 * vault is a directory the governor prepared; neither is reachable from a
 * subject or an adapter. Functional truth stays sealed: the workspace refuses to
 * open an expectation whose committed `truth_scope` is `functional`.
 */
export function reveal(argv: readonly string[]): JourneyCommandOutput {
  const flags = parseFlags(argv, [
    ...COMMON_FLAGS,
    { name: "vault", kind: "string", required: true },
    { name: "judge-identity", kind: "string" },
  ]);
  const runId = requireString(flags, "run");
  const workspace = openWorkspace(flags, runId);
  const label = (flags["judge-identity"] as string | undefined) ?? "judge";
  const revealed = workspace.revealJudgeExpectations({
    vaultRoot: requireString(flags, "vault"),
    judgeIdentity: developmentAgeIdentity(label),
  });
  return {
    runId,
    state: workspace.lifecycle.currentState,
    data: {
      reveal_record_hash: revealed.recordHash,
      revealed_expectation_hashes: revealed.revealedExpectationHashes,
      revealed_count: revealed.revealedExpectationHashes.length,
    },
  };
}

/**
 * `erl2 evaluate` — freezes the journey result, exactly one domain result and
 * the pre-cleanup result join.
 *
 * A pre-environment terminal has no functional evidence, so the domain plane is
 * not applicable with the exact reason `pre_environment_terminal`. The join is
 * the sole cleanup-entry guard, and its ordering is re-derived from the
 * lifecycle chain before this command returns.
 */
export function evaluate(argv: readonly string[]): JourneyCommandOutput {
  const flags = parseFlags(argv, [...COMMON_FLAGS, { name: "finding", kind: "string" }]);
  const runId = requireString(flags, "run");
  const workspace = openWorkspace(flags, runId);
  const revealed = workspace.hashForRole("judge-expectation-reveal");
  const revealRecord =
    revealed === undefined
      ? { revealed_expectation_hashes: [] as Hash[] }
      : workspace.artifact<{ revealed_expectation_hashes: Hash[] }>(
          revealed,
          "JudgeExpectationRevealRecordV1",
        );
  const result = workspace.evaluatePreEnvironment({
    revealedExpectationHashes: revealRecord.revealed_expectation_hashes,
    journeyMetricDefinitions: JOURNEY_PLANE_METRICS,
    findingHashes: workspace.retainedFindingHashes(),
  });
  return {
    runId,
    state: workspace.lifecycle.currentState,
    data: {
      journey_result_hash: result.journeyResult.core_hash,
      journey_status: result.journeyResult.status,
      domain_result_hash: result.domainResult.core_hash,
      domain_status: result.domainResult.status,
      domain_not_applicable_reason: result.domainResult.reason,
      precleanup_result_join_hash: result.join.core_hash,
      domain_variant: result.join.domain_variant,
      metric_result_hashes: result.metricResults.map((m) => m.core_hash),
      metric_results: result.metricResults.map((m) => ({
        metric_id: m.metric_id,
        status: m.status,
        value: m.value ?? null,
        threshold_class: m.threshold_class,
      })),
    },
  };
}

/**
 * `erl2 finalize-generic` — cleanup, validity, generic index, terminal run
 * record, attestation and public bundle, in the design's order.
 *
 * The closure is derived by the *offline verifier's own algorithm* before the
 * finalizer signs anything, so a missing role or an unaccounted retained
 * artifact refuses finalization rather than producing a bundle that fails
 * verification later.
 */
export function finalizeGeneric(argv: readonly string[]): JourneyCommandOutput {
  const flags = parseFlags(argv, [...COMMON_FLAGS, { name: "claim-scope", kind: "string" }]);
  const runId = requireString(flags, "run");
  const runRoot = requireString(flags, "run-root");
  const workspace = openWorkspace(flags, runId);
  const claimScope = (flags["claim-scope"] as string | undefined) ?? "T1";
  if (claimScope !== "T1" && claimScope !== "T2" && claimScope !== "T3") {
    throw new Erl2Error(
      CODES.CFG_MISSING_REQUIRED,
      "--claim-scope must be T1, T2 or T3; a base attestation never emits T4",
    );
  }
  const finalized = workspace.finalizeGeneric({
    claimScope,
    deriveClosure: (runRecord) =>
      derivePreFinalizationClosure({
        lifecycle: workspace.lifecycle.all(),
        index: ArtifactIndex.scan(runRoot),
        verifierReleaseHash: VERIFIER_RELEASE_HASH,
        verifiedAt: new SystemClock().now(),
        runRecord,
      }),
  });
  return {
    runId,
    state: workspace.lifecycle.currentState,
    data: {
      run_record_hash: finalized.runRecord.core_hash,
      terminal_stage: finalized.runRecord.terminal_stage,
      validity_result_hash: finalized.validity.core_hash,
      validity_status: finalized.validity.status,
      generic_evaluation_index_hash: finalized.index.core_hash,
      final_attestation_hash: finalized.attestation.core_hash,
      claim_scope: finalized.attestation.claim_scope,
      public_bundle_hash: finalized.bundle.core_hash,
      public_bundle_path: "retained/public-bundle.json",
    },
  };
}

export function freezeOutput(argv: readonly string[]): JourneyCommandOutput {
  const flags = parseFlags(argv, [
    ...COMMON_FLAGS,
    { name: "terminal-stage", kind: "string", required: true },
  ]);
  const runId = requireString(flags, "run");
  const workspace = openWorkspace(flags, runId);
  const stage = requireString(flags, "terminal-stage");
  if (stage !== "acquire" && stage !== "verify_package") {
    throw new Erl2Error(
      CODES.CFG_MISSING_REQUIRED,
      "--terminal-stage must be acquire or verify_package for a pre-environment terminal",
    );
  }
  const manifest = workspace.freezeSubjectOutput({ terminalStage: stage });
  return {
    runId,
    state: workspace.lifecycle.currentState,
    data: {
      subject_output_hash: manifest.core_hash,
      terminal_stage: manifest.terminal_stage,
      step_outcome_hashes: manifest.step_outcome_hashes,
      tree_hash: manifest.tree_hash,
    },
  };
}

/**
 * `erl2 cancel` — the mandatory cancellation terminal (design v2 §12).
 *
 * Any durably accepted, non-terminal run may be cancelled: it freezes signed
 * cancellation evidence and exactly one `InvalidLabRunRecordV1` (no fabricated
 * finding), then exits on the cancellation class (12).  Cancelling a run that
 * was never accepted, or one already terminal, is refused with its own code.
 */
export function cancel(argv: readonly string[]): JourneyCommandOutput {
  const flags = parseFlags(argv, [
    ...COMMON_FLAGS,
    { name: "reason", kind: "string", required: true },
    { name: "actor", kind: "string" },
  ]);
  const runId = requireString(flags, "run");
  const workspace = openWorkspace(flags, runId);
  const record = workspace.cancel({
    reasonCode: requireString(flags, "reason"),
    requestedByActorId: (flags["actor"] as string | undefined) ?? "operator",
  });
  return {
    runId,
    state: workspace.lifecycle.currentState,
    data: {
      invalid_run_record_hash: record.core_hash,
      terminal_state: record.terminal_state,
      cleanup_variant: record.cleanup.variant,
      cancelled_during: record.failed_phase.kind === "cancellation" ? record.failed_phase.cancelled_during : undefined,
    },
    // A cancelled run still returns its record hash (Appendix C) but exits on the
    // cancellation class so a caller cannot read it as success.
    terminalError: new Erl2Error(CODES.CANCELLATION_REQUESTED, "run cancelled at operator request"),
  };
}

/**
 * `erl2 preregister-challenge` — the one authorized continuation of a
 * successful package verification (ADR-ERL2-013), and the state `select`
 * departs from.
 *
 * `--challenge` is repeatable and names the admitted challenge family by core
 * hash. The whole family is frozen; nothing here picks a member. Which one the
 * run answers is decided only by `select`, from beacon randomness, which is what
 * makes the later selection checkable offline.
 */
export function preregisterChallenge(argv: readonly string[]): JourneyCommandOutput {
  const flags = parseFlags(argv, [
    ...COMMON_FLAGS,
    { name: "journey-selection-policy", kind: "string", required: true },
    { name: "randomness-policy", kind: "string", required: true },
    { name: "challenge", kind: "string-list", required: true },
  ]);
  const runId = requireString(flags, "run");
  const workspace = openWorkspace(flags, runId);
  const challengeManifestHashes = hashList(flags, "challenge");
  const result = workspace.preregisterChallenge({
    journeySelectionPolicyHash: hash(flags, "journey-selection-policy"),
    randomnessPolicyHash: hash(flags, "randomness-policy"),
    challengeManifestHashes,
  });
  return {
    runId,
    state: workspace.lifecycle.currentState,
    data: {
      challenge_family_size: result.challengeFamilyHashes.length,
      challenge_manifest_hashes: result.challengeFamilyHashes,
    },
  };
}

/**
 * `erl2 select` — advance the durable selection walk (ADR-ERL2-020 §6).
 *
 * Idempotent and resumable by construction: it continues from whatever the last
 * process durably reached, and a completed selection is a no-op. `--max-steps`
 * exists so an operator (and the crash suite) can stop at a chosen boundary; it
 * bounds work, it never skips a step.
 */
export function select(argv: readonly string[]): JourneyCommandOutput {
  const flags = parseFlags(argv, [
    ...COMMON_FLAGS,
    { name: "source-trust-config", kind: "string", required: true },
    { name: "expires", kind: "string", required: true },
    { name: "max-steps", kind: "string" },
  ]);
  const runId = requireString(flags, "run");
  const workspace = openWorkspace(flags, runId);

  const rawMax = flags["max-steps"] as string | undefined;
  const maxSteps = rawMax === undefined ? Number.POSITIVE_INFINITY : Number(rawMax);
  if (!Number.isInteger(maxSteps) && maxSteps !== Number.POSITIVE_INFINITY) {
    throw new Erl2Error(CODES.CFG_MISSING_REQUIRED, "--max-steps must be an integer");
  }

  const { ctx, prelude } = assembleSelection({
    workspace,
    sourceTrust: loadSourceTrustConfig(requireString(flags, "source-trust-config")),
    expiresAt: requireString(flags, "expires"),
  });
  const result = workspace.advanceSelection(ctx, maxSteps, prelude);

  const bindingHash = workspace.hashForRole("selected-challenge-journey-binding");
  return {
    runId,
    state: result.state,
    data: {
      steps_run: result.stepsRun,
      selection_complete: result.state === "selection_receipt_verified",
      ...(bindingHash === undefined ? {} : { selected_binding_hash: bindingHash }),
      ...(workspace.hashForRole("selection-verification-receipt") === undefined
        ? {}
        : { selection_receipt_hash: workspace.hashForRole("selection-verification-receipt") }),
    },
  };
}
