/**
 * `@erl2/core` — lifecycle, admission, selection, journey, cleanup, validity and
 * finalization.
 *
 * Depends only on `@erl2/contracts` and `@erl2/integrity`.  It must never
 * depend on `adapters/*`, `packs/*`, a consumer integration or any named
 * subject (implementation plan §4.1); `tests/architecture` proves it.
 */

export {
  LAB_STATES,
  TERMINAL_STATES,
  TRANSITIONS,
  POST_REVEAL_STATES,
  NO_SUBJECT_EXECUTION_STATES,
  isLabState,
  assertTransitionAllowed,
  assertNoSubjectExecutionAfterReveal,
  assertSubjectPortExecutable,
  type LabState,
} from "./lifecycle/states.js";
export {
  LifecycleLog,
  verifyLifecycleChain,
  type AppendEventInput,
  type RunSnapshot,
} from "./lifecycle/log.js";
export { RunLease, LEASE_TTL_MS } from "./lifecycle/lease.js";
export { TimestampLog, type TimestampSubmission } from "./timestamps/log.js";
export {
  SystemClock,
  SteppingClock,
  SystemRandom,
  SeededRandom,
  uuidV7From,
  newRunId,
  type Clock,
  type RandomSource,
  type Seams,
} from "./runtime/seams.js";
export {
  hidingCommitment,
  poolRootHash,
  poolRootOf,
  selectorVisibleProfileCoreHash,
  sourceRequestBindingHash,
  deriveSelectedIndex,
  opaqueHandleFromBytes,
  type DerivedSelection,
  type HidingCommitmentInput,
  type PoolRootInput,
  type SourceRequestBindingInput,
} from "./selection/derive.js";
export {
  buildEligibilityPool,
  assertPoolMetadataUniform,
  entryLogicalPath,
  FIXED_PAYLOAD_PLAINTEXT_BYTES,
  type BuildPoolOptions,
  type BuiltPool,
  type BuiltPoolEntry,
  type EligibleCandidate,
} from "./selection/pool.js";
export {
  beaconRoundPayloadHash,
  verifyBeaconNativeProof,
  assertWrapperOwnership,
  assertActiveRandomnessVariant,
  assertActiveRandomnessReceiptVariant,
  proofBytes,
  proofDigest,
  parseBeaconSignatureProof,
  parseBeaconInclusionProof,
  type BeaconRound,
  type BeaconSource,
  type BeaconSignatureProofV1,
  type BeaconInclusionProofV1,
} from "./selection/beacon.js";
export {
  DevelopmentBeaconSource,
  DEVELOPMENT_BEACON_NATIVE_DOMAIN,
  DEVELOPMENT_BEACON_SOURCE_ID,
  assertDevelopmentTierOnly,
  type DevelopmentBeaconOptions,
} from "./selection/developmentBeacon.js";
export {
  runSelectionChain,
  type RunSelectionOptions,
  type SelectionChainKeys,
  type SelectionChainResult,
} from "./selection/chain.js";
export {
  resourceIdentityHash,
  assertOwnedByRun,
  assertNarrowSelector,
  assertDriverEnabled,
  assertOperationSupported,
  type EnvironmentDriver,
  type ProvisionRequest,
  type ProvisionResult,
  type ProbeRequest,
  type MutateRequest,
  type RestoreRequest,
  type DestroyRequest,
  type DestroyResourceRequest,
  type DestroyResult,
} from "./environment/driver.js";
export {
  FakeEnvironmentDriver,
  fakeDriverManifest,
  type FakeDriverOptions,
  type FakeDriverFaults,
} from "./environment/fakeDriver.js";
export {
  FileSubstrateStore,
  MemorySubstrateStore,
  type SubstrateInstance,
  type SubstrateIo,
  type SubstrateState,
  type SubstrateStore,
} from "./environment/substrate.js";
export {
  buildRestorationProbe,
  deriveRestorationProbeOutcome,
  restorationProbePassed,
  type ExpectedRevertedMutation,
  type RestorationObservations,
  type RestorationProbeVerdict,
} from "./environment/restorationProbe.js";
export {
  buildResidueProbe,
  deriveResidueProbeOutcome,
  residueProbeClean,
  type ObservedResourceIdentity,
  type ResidueObservations,
  type ResidueProbeVerdict,
} from "./environment/residueProbe.js";
export {
  attributableTelemetryDeclared,
  attributableTelemetryGatePassed,
  collectorWindowComplete,
  contributesToTelemetryCounts,
  decideTelemetryObservationWindow,
  excerptCollectorTelemetry,
  parseTraceSummaryRecord,
  MAX_TELEMETRY_EXCERPT_CHARS,
  parseCollectorTelemetry,
  retainAttributableTelemetryObservation,
  supportsAttributableTelemetry,
  TELEMETRY_RETENTION_REASONS,
  telemetryRetentionRefusal,
  TELEMETRY_WINDOW_REASONS,
  type AttributableTelemetryMaterial,
  type AttributableTelemetryObserver,
  type CollectorTelemetryCounts,
  type ObservedCollectorIdentity,
  type TelemetryObservationStore,
  type TraceSummaryRecord,
  type TelemetryWindowDecision,
} from "./environment/telemetryObservation.js";
export {
  assertSubstrateBinding,
  buildSubstrateBinding,
  reservationNamespaceHash,
  type AssertBindingInput,
  type BuildSubstrateBindingInput,
} from "./environment/substrateBinding.js";
export {
  ReservationAllocator,
  type ReservationKind,
  type ReclaimedLease,
} from "./environment/allocator.js";
export {
  baselineFingerprintHash,
  buildBaselineFingerprint,
  assertBaselineClean,
  assertRepeatableBaseline,
  type BuildBaselineOptions,
  type EvidenceSourceState,
} from "./environment/cleanControl.js";
export {
  freezeResourceFrontier,
  assertFrontierActionsDerivable,
  safeActions,
  type FreezeFrontierOptions,
} from "./environment/frontier.js";
export { emergencyOperationId } from "./run/environmentCleanup.js";
export {
  assertSubstrateQualified,
  assertObservedMatchesLock,
  composeDriverManifestBody,
  verifySubstrateLockSignature,
  REQUIRED_PLATFORMS,
  type ObservedSubstrate,
  type PinnedSubstrateAuthority,
  type SubstrateLockSignatureVerification,
  type Platform,
} from "./environment/substrateLock.js";
export {
  dockerAvailable,
  SpawnDockerCli,
  type DockerCli,
  type DockerInvocation,
  type DockerResult,
} from "./environment/dockerCli.js";
export {
  fileSha256,
  materializeUpstream,
  observeComposeSubstrate,
  observeExecutingPlatform,
  lockedDigest,
  pinnedImageReference,
  OTEL_DEMO_ENDPOINT_PATH,
  OTEL_DEMO_ENDPOINT_SERVICE_ID,
  OTEL_DEMO_RELEASE_TAG,
  OTEL_DEMO_SERVICES,
  OTEL_DEMO_SUBSTRATE_ID,
  UPSTREAM_APPLIED_CONFIG_PATHS,
  type ComposeServiceSpec,
  type MaterializedUpstream,
  type RepositoryConfigPaths,
} from "./environment/composeSubstrate.js";
export {
  ComposeEnvironmentDriver,
  composeEndpointDirectory,
  composeProjectName,
  isValidHostPort,
  newImageResolutionMemo,
  observeRunningImage,
  readComposeEndpoint,
  substrateInstanceHash,
  COMPOSE_DRIVER_ID,
  COMPOSE_SUBSTRATE_KIND,
  ERL2_DRIVER_LABEL,
  ERL2_RUN_LABEL,
  LOOPBACK_HOST,
  OTEL_DEMO_ENDPOINT_CONTAINER_PORT,
  type ComposeDriverOptions,
  type ComposeEndpoint,
  type ImageResolutionMemo,
} from "./environment/composeDriver.js";
export {
  commitJourneyStep,
  assertVisibleStepMatchesCommitment,
  newCanaryId,
  type CommittedStep,
  type CommitStepOptions,
  type VisibleStepInput,
  type JudgeExpectationInput,
} from "./journey/steps.js";
export {
  ORACLE_SCAN_SURFACES,
  LIVE_ORACLE_SCAN_SURFACES,
  PENDING_ORACLE_SCAN_SURFACES,
  scanForCanaries,
  assertNoCanaryLeak,
  assertNoOracleFields,
  redactOracleLabel,
  type OracleScanSurface,
  type OracleScanTarget,
  type OracleScanFinding,
} from "./journey/oracle.js";
export {
  GenericStepEngine,
  INTENT_EVENT_PREFIX,
  nextPermittedIntents,
  deriveStepClosure,
  type RunStepOptions,
  type StepExecutionResult,
  type StepStatus,
} from "./journey/engine.js";
export {
  CRASH_BOUNDARIES,
  NO_CRASH,
  isCrashBoundary,
  type CrashBarrier,
  type CrashBoundary,
} from "./run/crashBarrier.js";
export {
  classifyCancellationBranch,
  type CancellationBranch,
} from "./run/cancellationBranch.js";
export {
  JOURNEY_PREREQUISITES,
  CANONICAL_JOURNEY_INTENTS,
  assertJourneyPrerequisites,
  isPostCaptureIntent,
  type JourneyPrerequisite,
  type JourneyBranch,
  type JourneyIntentRow,
  type JourneyPrerequisiteEvidence,
} from "./journey/prerequisites.js";
export {
  FakeSubjectPort,
  FAKE_SUBJECT_PORT_ID,
  assertDevelopmentSubjectPort,
  type SubjectPort,
  type SubjectStepResponse,
  type SubjectAcquisitionResponse,
  type FakeSubjectBehaviour,
} from "./journey/subjectPort.js";
export {
  AdapterHost,
  instantAfter,
  type AdapterHostOptions,
  type AdapterMount,
  type AdapterOperationResult,
  type LocalAdapterOperationResult,
  type LocalAdapterStepEvidence,
} from "./adapter/host.js";
export { LocalObservationCoordinator } from "./observation/localObservation.js";
export {
  HostedSubjectPort,
  HOSTED_SUBJECT_PORT_ID,
} from "./adapter/hostedSubjectPort.js";
export {
  certifyAdapter,
  certifyAdapterV2Scope,
  type CertifyAdapterOptions,
  type CertifyAdapterV2ScopeOptions,
} from "./adapter/certification.js";
// Exported so the residue draft's refusal contract can be exercised directly.
// A validator whose every branch is only reachable through a certified
// subprocess is a validator whose branches are never really tested.
export { assertLocalResidueObservationDraft } from "./adapter/responseShape.js";
export {
  BOOTSTRAP_RECEIPT_SENTINEL,
  EXTERNAL_ADAPTER_DIR,
  assertAdmissionPermittedForTier,
  assertEntryDigestUnchanged,
  adapterCertifiedGateResults,
  deriveAdapterCertifiedGate,
  deriveCertificationAuthenticity,
  retainAdmittedAdapter,
  verifyAdapterCertification,
  verifyLocalAdapterCertificationV2,
  verifyReceiptSignature,
  type AdapterAdmission,
  type AdapterCertifiedGate,
  type CertificationAuthenticity,
  type PinnedCertificationAuthority,
  type ReceiptLinkage,
  type ReceiptSignatureVerification,
  type RetainedAdmission,
  type VerifyAdapterCertificationInput,
  type VerifyLocalAdapterCertificationV2Input,
  type LocalAdapterAdmissionV2,
} from "./adapter/admission.js";
export {
  UNPRIVILEGED_CAPABILITIES,
  PRIVILEGED_CAPABILITIES,
  PRIVILEGE_BROKER_STATE,
  isPrivilegedCapability,
  privilegedRefusal,
  grantCapabilities,
  assertManifestCapabilitiesUnprivileged,
  type CapabilityGrantOptions,
} from "./adapter/capabilities.js";
export {
  CredentialBroker,
  DEVELOPMENT_CREDENTIAL_POLICY,
  credentialTargetHash,
  type CredentialScopePolicy,
  type IssueHandleOptions,
  type IssuedHandle,
} from "./adapter/credentials.js";
export {
  decideEgress,
  denyByDefaultEgressPolicy,
  loopbackEgressPolicy,
  type EgressDecisionOptions,
} from "./adapter/egress.js";
export {
  MutationLedger,
  mutationTargetHash,
  stateHash,
  type DeclaredMutation,
  type DeclaredCompensation,
  type MutationLedgerOptions,
} from "./adapter/mutations.js";
export {
  assertNoExecutionAfterOutputFreeze,
  assertOutputClean,
  assertSubjectOutputContentClean,
  assertSubjectOutputWithinDeclaredBytes,
  collectBoundedTree,
  freezeAdapterOutput,
  freezeDiagnostics,
  redact,
  scanBytes,
  subjectOutputPayloadByteTotal,
  DEFAULT_OUTPUT_BOUNDS,
  FORBIDDEN_OUTPUT_IDENTIFIERS,
  type CollectedFile,
  type OutputBounds,
  type RetainedSubjectOutputPayload,
} from "./adapter/outputFreezer.js";
export {
  ALLOWED_ENVIRONMENT_VARIABLE_NAMES,
  CONTAINER_PROFILE_ENABLED_STATE,
  CONTAINER_PROFILE_STATE,
  assertControlReportMatchesProfile,
  assertEnvironmentAllowlisted,
  assertMountPermitted,
  assertSandboxProfileEnabled,
  containerObservedControls,
  containerSubstrateLockHash,
  deriveContainerProfileActivation,
  enforcedControls,
  sandboxControlReport,
  unsupportedControls,
  type ContainerProfileActivation,
  type SandboxControlReport,
  type SandboxProfileId,
  type SubjectTrust,
} from "./adapter/sandbox.js";
export {
  CONTAINER_ADAPTER_ROOT,
  CONTAINER_APP_ROOT,
  CONTAINER_DIAGNOSTICS_ROOT,
  CONTAINER_MODULES_ROOT,
  CONTAINER_MOUNTS_ROOT,
  CONTAINER_NUMERIC_USER,
  CONTAINER_OUTPUT_ROOT,
  HARDENED_CONTAINER_RUN_FLAGS,
  containerRuntimeConfigurationInput,
} from "./adapter/containerHardening.js";
export {
  CONTAINER_ADAPTER_USER,
  containerInvocationName,
  probeContainerLauncher,
  resolveAdapterModuleClosure,
  type AdapterModuleDirectory,
  type ContainerLauncherAvailability,
} from "./adapter/containerLauncher.js";
export {
  CONTAINER_DEADLINE_NOT_ENFORCED,
  type ContainerSupervisorMount,
  type ContainerSupervisorReport,
  type ContainerSupervisorSpec,
  type ContainerTerminationObservation,
} from "./adapter/containerSupervisor.js";
export {
  NOT_QUALIFIED_STATE,
  REQUIRED_ISOLATION_CONTROLS,
  assertSubjectMayRunUnderProfile,
  fakeEnforcementProbes,
  qualifyIsolationProfile,
  type IsolationControlId,
  type IsolationProbeResult,
  type IsolationVerdict,
  type ProbeEvidence,
  type SubstrateLockEvidence,
} from "./adapter/isolationQualification.js";
export {
  CliContainerRuntime,
  DEFAULT_PROBE_OUTPUT_BYTES,
  assertRuntimeAvailable,
  runtimeCliEnvironment,
  type ContainerRuntime,
  type RuntimeInvocation,
  type RuntimeResult,
} from "./adapter/containerRuntime.js";
export {
  assertObservedMatchesIsolationLock,
  assertProbeSuiteMatchesLock,
  buildIsolationSubstrateLock,
  diffObservedAgainstIsolationLock,
  discoverSubstrate,
  resolveImageDigest,
  runtimeConfigurationHash,
  type BuildIsolationLockInput,
  type ObservedSubstrateState,
  type SubstrateDrift,
} from "./adapter/isolationSubstrateLock.js";
export {
  PROBE_SUITE_ID,
  assertSuiteCoversEveryControl,
  probeCatalogue,
  probeSuiteDigest,
  reapProbeResidue,
  runEnforcementProbes,
  type ProbeContext,
} from "./adapter/isolationProbes.js";
export {
  QUALIFIER_RELEASE,
  assertQualificationGrantsNoNewAuthority,
  assertQualifiedForExecution,
  buildIsolationQualificationReport,
  probeEvidenceHash,
  toProbeInput,
  type BuildQualificationReportInput,
} from "./adapter/isolationQualificationReport.js";
export {
  verifyIsolationLockSignature,
  deriveIsolationAuthenticity,
  buildIsolationProbeSigningManifest,
  verifyIsolationProbeManifest,
  type IsolationAuthenticity,
  type LockSignatureVerification,
  type PinnedQualificationAuthority,
  type ProbeManifestStatus,
  type ProbeManifestVerification,
} from "./adapter/isolationAuthenticity.js";
export {
  AdmissionRegistry,
  assertChallengeAdmissible,
  assertNoCandidateDerivedEligibility,
  type AdmittedArtifact,
  type ChallengeAdmissionOptions,
} from "./registry/admission.js";
export {
  assertTelemetryOracleClean,
  realizeCutoff,
  isEligibleAtCutoff,
  freezeSourceSnapshot,
  freezeObservation,
  type CutoffInput,
  type RealizedCutoff,
  type SnapshotInput,
  type FreezeObservationOptions,
} from "./capture/capture.js";
export {
  sealWindowCommitment,
  assertMilestoneOnCommittedBoundary,
  committedCutoffMs,
  addExactMs,
  type WindowCommitmentInput,
} from "./capture/evidenceWindow.js";
export {
  assertComparisonModeAdmissible,
  buildReplayEnvelope,
  buildLiveEnvelope,
  assertReplayEnvelopesIdentical,
  assertLiveEquivalence,
  assertTranslationTotality,
  type BuildReplayEnvelopeOptions,
  type BuildLiveEnvelopeOptions,
  type CanonicalEntryInput,
  type UnsupportedDescriptorInput,
} from "./capture/envelope.js";
export {
  EVALUATOR_RELEASE,
  RunWorkspace,
  type OpenWorkspaceOptions,
  type WorkspaceKeyring,
} from "./run/workspace.js";
export {
  assertWorkspaceRunIdentity,
  readWorkspaceIdentity,
  type WorkspaceIdentity,
} from "./run/runIdentity.js";
export {
  MutationIntentJournal,
  type MutationIntent,
  type MutationIntentState,
  type MutationSpec,
  type ProbeVerdict,
  type RetryRule,
} from "./run/mutationIntent.js";
export {
  verifySelectionChain,
  assertDisjointRoles,
  type SelectionChainEvidence,
  type SelectionVerificationOutcome,
} from "./selection/verify.js";

// -- slice 6: generic evaluation, cleanup and finalization -------------------
export {
  assertAttributionProven,
  assertFindingOwnershipConsistent,
  assertInvalidRunAssertsNoSubjectDefect,
  buildAdapterFailure,
  buildDependencyFinding,
  buildEvaluatorFailure,
  buildInconclusiveFinding,
  buildLabInvalidity,
  buildSubjectFinding,
  type AdapterFailureInput,
  type AttributionPrerequisites,
  type DependencyFindingInput,
  type EvaluatorFailureInput,
  type InconclusiveFindingInput,
  type LabInvalidityCategory,
  type LabInvalidityInput,
  type ScoreablePlane,
  type SubjectFindingInput,
} from "./evaluation/findings.js";
export {
  EVALUATOR_REASON_CODES,
  RATIO_SCALE,
  evaluateMetric,
  evaluatePredicate,
  exactInteger,
  exactRatio,
  hardSafetyViolations,
  type EvaluateMetricOptions,
  type EvaluationClaim,
  type EvaluationEnvelopeIndex,
  type EvaluationMutation,
  type EvaluationSource,
  type EvaluationStepOutcome,
  type EvaluationTruthFact,
  type MetricInputs,
} from "./evaluation/metrics.js";
export {
  AUTHORITY_SCOPE_METRIC,
  CAUSAL_OVERCLAIM,
  CITATION_REACHABILITY,
  CORRECT_ABSTENTION,
  CREDENTIAL_SAFETY,
  DEGRADATION_HONESTY,
  DOMAIN_PLANE_METRICS,
  EVIDENCE_PRECISION,
  EVIDENCE_RECALL,
  GENERIC_METRIC_DEFINITIONS,
  JOURNEY_PLANE_METRICS,
  assertReferencedMetricsAreGeneric,
  genericMetric,
  genericMetricHashes,
} from "./evaluation/genericMetrics.js";
export {
  INTERVENTION_SEVERITY,
  NO_ASSISTANCE,
  assertClaimedOrderMatchesDerived,
  buildPreSelectionJourneyResult,
  buildSelectedJourneyResult,
  elapsedMs,
  projectStepOutcomes,
  type AssistanceSummary,
  type JourneyEvaluationInput,
} from "./evaluation/journey.js";
export {
  bindDomainPack,
  buildDomainNotApplicable,
  evaluateDomain,
  missingDomainAncestors,
  type BoundDomainPack,
  type DomainAncestors,
  type DomainEvidence,
  type EvaluateDomainInput,
  type EvaluateDomainOutput,
  type NotApplicableReason,
} from "./evaluation/domain.js";
export {
  ENVIRONMENT_GATE_IDS,
  LAB_VALIDITY_GATES,
  PRE_ENVIRONMENT_GATE_IDS,
  assertAdapterCertificationApplicability,
  requiredGateIds,
  assertGatesAreLabOwned,
  assertRequiredGatesPresent,
  assertValidityAdmitsGenericIndex,
  buildEnvironmentValidity,
  buildPreEnvironmentValidity,
  type GateResult,
} from "./evaluation/validity.js";
export {
  ENVIRONMENT_PHASE_GATE,
  gateForEnvironmentFailurePhase,
  gateForInvalidFailurePhase,
  JOURNEY_EXECUTION_GATE,
  isEnvironmentFailurePhase,
  type EnvironmentFailurePhase,
} from "./evaluation/invalidityAttribution.js";
export {
  DEEP_ANCESTRY_FORBIDDEN_FIELDS,
  assertNoDeepAncestry,
  buildGenericEvaluationIndex,
  buildPrecleanupResultJoin,
  deriveJoinOrdering,
  type BuildGenericIndexInput,
  type BuildJoinInput,
  type JoinOrderingEvidence,
} from "./evaluation/join.js";
export {
  assertRemainingResourcesMatchFrontier,
  buildEmergencyCleanup,
  buildEnvironmentRestoration,
  buildPreEnvironmentCleanup,
  buildTeardownVerification,
  requiredEmergencyAttempts,
  type EmergencyAttempt,
  type EmergencyCleanupInput,
  type EnvironmentRestorationInput,
  type PreEnvironmentCleanupInput,
  type TeardownCheck,
  type TeardownInput,
} from "./cleanup/cleanup.js";
export {
  NON_BLIND_DEVELOPMENT_ASSURANCE,
  assertEnvironmentFinalizable,
  buildEnvironmentAttestation,
  buildEnvironmentBundle,
  buildEnvironmentRunRecord,
  buildEnvironmentSignerInventory,
  type EnvironmentAttestationInput,
  type EnvironmentBundleInput,
  type EnvironmentFinalizationPreconditions,
  type EnvironmentRunRecordInput,
} from "./terminal/environmentFinalize.js";
export {
  assertFinalizable,
  assertNoVersionCrossover,
  buildPreEnvironmentAttestation,
  buildPreEnvironmentBundle,
  buildPreEnvironmentRunRecord,
  buildPreEnvironmentSignerInventory,
  type FinalizationPreconditions,
  type PreEnvironmentAttestationInput,
  type PreEnvironmentBundleInput,
  type PreEnvironmentRunRecordInput,
  type SignerInventoryEntryInput,
} from "./terminal/finalize.js";
export {
  assertInventoryCoversDerivation,
  deriveSignedMembers,
  signerInventoryEntriesFrom,
  PRODUCER_SIGNED_MEMBER_ROLES,
  SELF_REFERENTIAL_INVENTORY_SCHEMA,
  type DerivedSignedMember,
  type RetainedArtifactView,
  type SignerInventoryDerivation,
} from "./terminal/signerInventoryDerivation.js";
export { buildRoleSeparationAudit, buildSelectionRequest, loadSelectionPool, POOL_MANIFEST_PATH, poolEntryPath } from "./run/selectionContext.js";
export { SELECTION_STEPS, assertResumable, stepFrom, type SelectionStep } from "./run/selectionWalk.js";
export type { SelectionPreludeInput } from "./run/workspace.js";
export type { SelectionContext, SelectionProgress } from "./selection/stages.js";
export type { SelectionPool, SelectionPoolEntry } from "./selection/chain.js";
export {
  EnvironmentRun,
  ENVIRONMENT_PHASES,
  type CommittedJourneyStep,
  type EnvironmentKeyring,
  type EnvironmentPhase,
  type EnvironmentRunOptions,
} from "./run/environmentRun.js";
