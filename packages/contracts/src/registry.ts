/**
 * Contract registry: the mapping from a stable ERL2 contract identifier to the
 * closed schema that defines it.
 *
 * The `ERL2-C-nnn` identifiers come from design v2 §16.2.  Anything the Lab
 * validates, freezes, signs, bundles or verifies must appear here; there is no
 * "generic object" escape hatch.
 */

export interface ContractDescriptor {
  /** Stable contract identifier, e.g. `ERL2-C-021`. */
  readonly id: string;
  /** Generated TypeScript type name and `$defs` key. */
  readonly name: string;
  /** JSON Schema `$ref` used to compile the validator. */
  readonly ref: string;
  /**
   * `schema_version` literal, when the contract is a single object rather than
   * a union. Unions declare `undefined` and are discriminated by their members.
   */
  readonly schemaVersion: string | undefined;
  /** True when the contract is a closed union of variants. */
  readonly union: boolean;
}

const d = (
  id: string,
  name: string,
  group: string,
  schemaVersion: string | undefined,
  union = false,
): ContractDescriptor => ({
  id,
  name,
  ref: `erl2:${group}#/$defs/${name}`,
  schemaVersion,
  union,
});

export const CONTRACTS: readonly ContractDescriptor[] = [
  // Environment and journey
  d("ERL2-C-001", "EnvironmentArchetypeV1", "journey", "environment-archetype/v1"),
  d("ERL2-C-002", "EnvironmentInstanceV1", "journey", "environment-instance/v1"),
  d("ERL2-C-003", "JourneyDefinitionV1", "journey", "journey-definition/v1"),
  d("ERL2-C-004", "SubjectVisibleJourneyStepV1", "journey", "subject-visible-journey-step/v1"),
  d("ERL2-C-005", "JudgeJourneyExpectationV1", "journey", "judge-journey-expectation/v1"),
  d("ERL2-C-006", "JourneyStepCommitmentV1", "journey", "journey-step-commitment/v1"),

  // Acquisition and package
  d("ERL2-C-007", "AcquisitionPreregistrationV1", "acquisition", "acquisition-preregistration/v1"),
  d("ERL2-C-008", "AcquisitionAdapterRequestV1", "acquisition", "acquisition-adapter-request/v1"),
  d("ERL2-C-009", "PackageVerificationRequestV1", "acquisition", "package-verification-request/v1"),
  d("ERL2-C-010", "AdapterStepRequestV1", "acquisition", "adapter-step-request/v1"),
  d("ERL2-C-011", "ChallengeManifestV1", "journey", "challenge-manifest/v1"),
  d("ERL2-C-012", "AcquisitionSourceManifestV1", "acquisition", "acquisition-source-manifest/v1"),
  d("ERL2-C-013", "AcquisitionPreregistrationVerificationReceiptV1", "acquisition", "acquisition-preregistration-verification-receipt/v1"),
  d("ERL2-C-014", "SubjectAcquisitionRecordV1", "acquisition", "subject-acquisition-record/v1"),
  d("ERL2-C-015", "SubjectPackageVerificationRecordV1", "acquisition", "subject-package-verification-record/v1"),
  d("ERL2-C-016", "SubjectPackageManifestV1", "acquisition", "subject-package-manifest/v1"),
  d("ERL2-C-017", "SubjectAdapterManifestV1", "acquisition", "subject-adapter-manifest/v1"),
  d("ERL2-C-019", "GenericRunPolicyV1", "acquisition", "generic-run-policy/v1"),
  d("ERL2-C-020", "ComparisonPolicyV1", "selection", "comparison-policy/v1"),

  // Selection chain
  d("ERL2-C-021", "SelectionRequestV2", "selection", "selection-request/v2"),
  d("ERL2-C-023", "SubjectExecutionPlanV1", "journey", "subject-execution-plan/v1"),
  d("ERL2-C-027", "JourneyStepOutcomeV1", "journey", "journey-step-outcome/v1"),
  d("ERL2-C-028", "SubjectOutputManifestV1", "journey", undefined, true),
  d("ERL2-C-028a", "PreEnvironmentSubjectOutputManifestV1", "journey", "subject-output-manifest/v1"),
  d("ERL2-C-028b", "EnvironmentSubjectOutputManifestV1", "journey", "subject-output-manifest/v1"),
  d("ERL2-C-075", "JourneySelectionPolicyV1", "selection", "journey-selection-policy/v1"),
  d("ERL2-C-076", "EligibilityPoolEntryV2", "selection", "eligibility-pool-entry/v2"),
  d("ERL2-C-077", "SelectedChallengeJourneyBindingV1", "selection", "selected-challenge-journey-binding/v1"),
  d("ERL2-C-081", "EligibilityPoolManifestV2", "selection", "eligibility-pool-manifest/v2"),
  d("ERL2-C-082", "SelectionCommitmentV2", "selection", "selection-commitment/v2"),
  d("ERL2-C-083", "SelectionProofV2", "selection", "selection-proof/v2"),
  d("ERL2-C-084", "SelectionVerificationReceiptV2", "selection", "selection-verification-receipt/v2"),
  d("ERL2-C-086", "SelectionRandomnessPolicyV1", "selection", "external-beacon-randomness-policy/v1"),
  d("ERL2-C-087", "SelectionRandomnessReceiptV1", "selection", "external-beacon-randomness-receipt/v1"),
  d("ERL2-C-088", "ThresholdRevealReceiptV1", "selection", "threshold-reveal-receipt/v1"),
  d("ERL2-C-089", "SelectionAssuranceV1", "selection", undefined, true),
  d("ERL2-C-090", "SelectionRoleSeparationAuditV1", "selection", "selection-role-separation-audit/v1"),
  d("ERL2-C-091", "ExternalBeaconRandomnessPolicyV1", "selection", "external-beacon-randomness-policy/v1"),
  d("ERL2-C-092", "ThresholdVrfRandomnessPolicyV1", "selection", "threshold-vrf-randomness-policy/v1"),
  d("ERL2-C-093", "ExternalBeaconRandomnessReceiptV1", "selection", "external-beacon-randomness-receipt/v1"),
  d("ERL2-C-095", "RandomnessSourceTrustVerificationReportV1", "selection", "randomness-source-trust-verification-report/v1"),
  // Beacon-native proofs are frozen as PUBLIC artifacts and re-parsed by the
  // offline verifier, so they are closed, schema-governed wire types (review
  // §11.13). They carry no schema_version — they are discriminated by
  // `proof_kind` and are never core-hashed (their bytes are frozen via JCS).
  d("ERL2-C-152", "BeaconSignatureProofV1", "selection", undefined),
  d("ERL2-C-153", "BeaconInclusionProofV1", "selection", undefined),
  d("ERL2-X-001", "HiddenBindingPayloadV1", "selection", "hidden-binding-payload/v1"),

  // Findings, cleanup, validity, results
  d("ERL2-C-038", "FindingV1", "results", undefined, true),
  d("ERL2-C-038a", "SubjectFindingV1", "results", "finding/v1"),
  d("ERL2-C-038b", "DependencyFindingV1", "results", "finding/v1"),
  d("ERL2-C-038c", "AdapterFailureV1", "results", "finding/v1"),
  d("ERL2-C-038d", "EvaluatorFailureV1", "results", "finding/v1"),
  d("ERL2-C-038e", "LabInvalidityV1", "results", "finding/v1"),
  d("ERL2-C-038f", "InconclusiveFindingV1", "results", "finding/v1"),
  d("ERL2-C-040", "PreEnvironmentCleanupVerificationV1", "results", "pre-environment-cleanup-verification/v1"),
  d("ERL2-C-041", "EnvironmentRestorationVerificationV1", "results", "environment-restoration-verification/v1"),
  d("ERL2-C-042", "CleanupVerificationV1", "results", undefined, true),
  d("ERL2-C-043", "PreEnvironmentValidityResultV1", "results", "pre-environment-validity-result/v1"),
  d("ERL2-C-044", "EnvironmentValidityResultV1", "results", "environment-validity-result/v1"),
  d("ERL2-C-045", "ValidityResultV1", "results", undefined, true),
  d("ERL2-C-085a", "SucceededEmergencyCleanupActionV1", "results", undefined),
  d("ERL2-C-085b", "FailedEmergencyCleanupActionV1", "results", undefined),
  d("ERL2-C-085c", "SkippedUnsafeEmergencyCleanupActionV1", "results", undefined),
  d("ERL2-C-046", "PreSelectionJourneyResultV1", "results", "pre-selection-journey-result/v1"),
  d("ERL2-C-047", "SelectedJourneyResultV1", "results", "selected-journey-result/v1"),
  d("ERL2-C-048", "JourneyResultV1", "results", undefined, true),
  d("ERL2-C-049", "DomainResultEvaluatedV1", "results", "domain-result-evaluated/v1"),
  d("ERL2-C-050", "DomainResultNotApplicableV1", "results", "domain-result-not-applicable/v1"),
  d("ERL2-C-051", "DomainResultV1", "results", undefined, true),
  d("ERL2-C-052", "GenericPrecleanupResultJoinV1", "results", "generic-precleanup-result-join/v1"),
  d("ERL2-C-053", "GenericEvaluationIndexV1", "results", "generic-evaluation-index/v1"),
  d("ERL2-C-078", "EmergencyCleanupVerificationV1", "results", "emergency-cleanup-verification/v1"),
  d("ERL2-C-085", "EmergencyCleanupActionV1", "results", undefined, true),
  d("ERL2-C-097", "TeardownVerificationV1", "results", "teardown-verification/v1"),

  // Data-only evaluation packs, metric definitions and metric results (slice 6)
  d("ERL2-C-039", "EvaluationPackManifestV1", "evaluation", "evaluation-pack-manifest/v1"),
  d("ERL2-C-143", "MetricDefinitionV1", "evaluation", "metric-definition/v1"),
  d("ERL2-C-144", "EvaluationPackBodyV1", "evaluation", "evaluation-pack-body/v1"),
  d("ERL2-C-145", "EvaluationPackCertificationReceiptV1", "evaluation", "evaluation-pack-certification-receipt/v1"),
  d("ERL2-C-146", "MetricResultV1", "evaluation", "metric-result/v1"),
  d("ERL2-C-147", "EvaluationPackAssertionV1", "evaluation", undefined),
  d("ERL2-C-148", "JudgeExpectationRevealRecordV1", "journey", "judge-expectation-reveal-record/v1"),

  // Terminals, attestations and bundles
  d("ERL2-C-055", "PreEnvironmentLabRunRecordV1", "terminal", "pre-environment-lab-run-record/v1"),
  d("ERL2-C-056", "EnvironmentLabRunRecordV1", "terminal", "environment-lab-run-record/v1"),
  d("ERL2-C-057", "InvalidLabRunRecordV1", "terminal", "invalid-lab-run-record/v1"),
  d("ERL2-C-063", "CancellationRequestV1", "terminal", "cancellation-request/v1"),
  // Additive: the signed controller activation receipt design v2 §12 requires and
  // no V2 contract carried (ADR-ERL2-023). No existing schema changed shape.
  d("ERL2-C-155", "ChallengeActivationReceiptV1", "environment", "challenge-activation-receipt/v1"),
  // ADR-ERL2-024 §6.1: additive, on the same terms as ERL2-C-155 and ERL2-C-063.
  // No existing schema changed shape or meaning, and the signer role it uses
  // (`environment_governor`) was already in the frozen SignerRole enum.
  d("ERL2-C-156", "SubstrateBindingV1", "environment", "substrate-binding/v1"),
  // ADR-ERL2-026 §6: additive, on the same terms as ERL2-C-156. The restoration
  // verification is frozen and could not carry the independently observed
  // post-compensation state, so the observation gets its own identity rather
  // than an optional field on a frozen schema.
  d("ERL2-C-157", "RestorationProbeV1", "environment", "restoration-probe/v1"),
  // ADR-ERL2-027 §6.1: additive, on the same terms as ERL2-C-157. The emergency
  // cleanup verification is frozen, and its `remaining_resources` is a
  // producer-derived summary of the producer's own action outcomes — which is
  // exactly why the independent post-cleanup observation needs its own identity
  // rather than an optional field on a frozen schema.
  d("ERL2-C-158", "CleanupResidueProbeV1", "environment", "cleanup-residue-probe/v1"),
  // ADR-ERL2-033: additive. The telemetry the run's own collector received —
  // observed by the driver before teardown begins — was previously observed by
  // the live acceptance test and retained by nothing, which is why the claim
  // boundary forbade saying an offline bundle attests received telemetry. The
  // observation gets its own identity rather than a field on any frozen
  // capture schema because it post-dates the realized cutoff: it is a
  // statement about receipt during the run, never about the evidence window.
  // ADR-ERL2-038 R8: ERL2-C-160 stays registered and parseable so historical
  // evidence keeps verifying under its original scope. It is **not** authoritative
  // for a new telemetry claim; ERL2-C-171 is. The identity is not repointed,
  // because a frozen bundle that declared C-160 coverage would otherwise start
  // reading as a claim about a channel that did not exist when it was written.
  d("ERL2-C-160", "AttributableTelemetryObservationV1", "environment", "attributable-telemetry-observation/v1"),
  // ADR-ERL2-038 §3 and R8: additive, and a new identity rather than a version
  // bump on ERL2-C-160 for the same reason ERL2-C-159 was — the two must be
  // representable at once, one historical and one authoritative, and a single
  // identity spanning both is exactly the dual authority R8 exists to prevent.
  d("ERL2-C-171", "AttributableTelemetryObservationV2", "environment", "attributable-telemetry-observation/v2"),
  // ADR-ERL2-031: additive, and the reason it is a new identity rather than two
  // fields on `ObservationBundleV2` is ordering, not migration cost. The bundle is
  // frozen *after* capture, so durations carried there would be a post-hoc
  // statement about a window already used; a commitment must precede the thing it
  // governs or it commits nothing. The exact warmup and observation durations were
  // composition constants retained in no contract, which is what made the offline
  // cutoff derivation bounds-exact rather than exact (ADR-ERL2-029 §3.2).
  d("ERL2-C-159", "EvidenceWindowCommitmentV1", "evidence", "evidence-window-commitment/v1"),
  d("ERL2-C-058", "LabRunRecordV1", "terminal", undefined, true),
  d("ERL2-C-059", "MandatoryGraphClosureReportV1", "terminal", "mandatory-graph-closure-report/v1"),
  d("ERL2-C-060", "PreEnvironmentFinalLabAttestationV1", "terminal", "pre-environment-final-lab-attestation/v1"),
  d("ERL2-C-061", "EnvironmentFinalLabAttestationV1", "terminal", "environment-final-lab-attestation/v1"),
  d("ERL2-C-062", "FinalLabAttestationV1", "terminal", undefined, true),
  d("ERL2-C-070", "PreEnvironmentPublicVerificationBundleV2", "terminal", "public-verification-bundle/v2"),
  d("ERL2-C-071", "EnvironmentPublicVerificationBundleV2", "terminal", "public-verification-bundle/v2"),
  d("ERL2-C-072", "PublicVerificationBundleV2", "terminal", undefined, true),
  d("ERL2-C-079", "InvalidFailurePhaseV1", "terminal", undefined, true),
  d("ERL2-C-080", "InvalidTerminalReasonV1", "terminal", undefined, true),

  // Journey detail records, capability and assistance (slice 4)
  d("ERL2-C-018", "SubjectCapabilityDeclarationV1", "subject", "subject-capability-declaration/v1"),
  d("ERL2-C-024", "SubjectInstallationRecordV1", "subject", "subject-installation-record/v1"),
  d("ERL2-C-025", "SubjectConfigurationRecordV1", "subject", "subject-configuration-record/v1"),
  d("ERL2-C-026", "SubjectInteractionRecordV1", "subject", "subject-interaction-record/v1"),
  d("ERL2-C-120", "AssistanceEventV1", "subject", "assistance-event/v1"),

  // Capture, cutoff and canonical evidence (slice 4)
  d("ERL2-C-029", "SourceSnapshotV1", "evidence", "source-snapshot/v1"),
  d("ERL2-C-030", "ObservationBundleV2", "evidence", "observation-bundle/v2"),
  d("ERL2-C-031", "ReplayCanonicalEvidenceEnvelopeV1", "evidence", "replay-canonical-evidence-envelope/v1"),
  d("ERL2-C-032", "LiveCanonicalEvidenceEnvelopeV1", "evidence", "live-canonical-evidence-envelope/v1"),
  d("ERL2-C-033", "CanonicalSubjectEvidenceEnvelopeV1", "evidence", undefined, true),
  d("ERL2-C-034", "EvidenceEquivalenceProfileV1", "evidence", "evidence-equivalence-profile/v1"),
  d("ERL2-C-035", "SemanticEvidenceEquivalenceReceiptV1", "evidence", "semantic-evidence-equivalence-receipt/v1"),
  d("ERL2-C-036", "AdapterTranslationReceiptV1", "evidence", "adapter-translation-receipt/v1"),
  d("ERL2-C-037", "GenericClaimSetV1", "evidence", "generic-claim-set/v1"),
  d("ERL2-C-121", "CutoffPolicyV1", "evidence", "cutoff-policy/v1"),
  d("ERL2-C-122", "MonotonicClockDomainV1", "evidence", "monotonic-clock-domain/v1"),
  d("ERL2-C-123", "TrafficProcessStartReceiptV1", "evidence", "traffic-process-start-receipt/v1"),
  d("ERL2-C-124", "RuntimeMilestoneV1", "evidence", "runtime-milestone/v1"),

  // Environment (slice 3)
  d("ERL2-C-110", "EnvironmentDriverManifestV1", "environment", "environment-driver-manifest/v1"),
  d("ERL2-C-111", "SubstrateLockV1", "environment", "substrate-lock/v1"),
  d("ERL2-C-112", "EnvironmentResourceInventoryV1", "environment", "environment-resource-inventory/v1"),
  d("ERL2-C-113", "EnvironmentOperationReceiptV1", "environment", "environment-operation-receipt/v1"),
  d("ERL2-C-114", "EnvironmentBaselineFingerprintV1", "environment", "environment-baseline-fingerprint/v1"),
  d("ERL2-C-115", "EnvironmentResourceFrontierV1", "environment", "environment-resource-frontier/v1"),
  d("ERL2-C-116", "EnvironmentReservationLeaseV1", "environment", "environment-reservation-lease/v1"),
  d("ERL2-C-117", "EnvironmentCleanupContractV1", "environment", "environment-cleanup-contract/v1"),
  d("ERL2-C-118", "EnvironmentResourceV1", "environment", undefined),
  d("ERL2-C-119", "EnvironmentProbeResultV1", "environment", undefined),

  // Adapter platform (slice 5)
  d("ERL2-C-125", "SubjectAdapterCertificationReceiptV1", "adapter", "subject-adapter-certification-receipt/v1"),
  d("ERL2-C-126", "AdapterProtocolNegotiationV1", "adapter", "adapter-protocol-negotiation/v1"),
  d("ERL2-C-127", "AdapterResponseEnvelopeV1", "adapter", "adapter-response-envelope/v1"),
  d("ERL2-C-128", "AdapterCapabilityGrantV1", "adapter", "adapter-capability-grant/v1"),
  d("ERL2-C-129", "MutationIntentV1", "adapter", "mutation-intent/v1"),
  d("ERL2-C-130", "MutationReceiptV1", "adapter", "mutation-receipt/v1"),
  d("ERL2-C-131", "CompensationReceiptV1", "adapter", "compensation-receipt/v1"),
  d("ERL2-C-132", "CredentialHandleRequestV1", "adapter", "credential-handle-request/v1"),
  d("ERL2-C-133", "CredentialHandleGrantV1", "adapter", "credential-handle-grant/v1"),
  d("ERL2-C-134", "CredentialUseReceiptV1", "adapter", "credential-use-receipt/v1"),
  d("ERL2-C-135", "EgressAllowlistPolicyV1", "adapter", "egress-allowlist-policy/v1"),
  d("ERL2-C-136", "EgressDecisionReceiptV1", "adapter", "egress-decision-receipt/v1"),
  d("ERL2-C-137", "SandboxInvocationManifestV1", "adapter", "sandbox-invocation-manifest/v1"),
  d("ERL2-C-138", "SandboxInvocationResultV1", "adapter", "sandbox-invocation-result/v1"),
  d("ERL2-C-139", "SubjectDiagnosticsManifestV1", "adapter", "subject-diagnostics-manifest/v1"),
  d("ERL2-C-140", "ResidueReportV1", "adapter", "residue-report/v1"),
  d("ERL2-C-141", "AdapterFailureReportV1", "adapter", "adapter-failure-report/v1"),
  d("ERL2-C-142", "AdapterCertificationFindingV1", "adapter", undefined),

  // subject-adapter/v2 local observation (ADR-ERL2-037). These identities are
  // additive: the governed V1 contracts above remain byte-for-byte unchanged.
  d("ERL2-C-161", "SubjectAdapterManifestV2", "acquisition", "subject-adapter-manifest/v2"),
  d("ERL2-C-162", "SubjectAdapterCertificationReceiptV2", "adapter", "subject-adapter-certification-receipt/v2"),
  d("ERL2-C-163", "AdapterProtocolNegotiationV2", "adapter", "adapter-protocol-negotiation/v2"),
  d("ERL2-C-164", "AdapterRequestV2", "adapter", "adapter-request/v2"),
  d("ERL2-C-165", "AdapterResponseEnvelopeV2", "adapter", "adapter-response-envelope/v2"),
  d("ERL2-C-166", "SandboxInvocationManifestV2", "adapter", "sandbox-invocation-manifest/v2"),
  d("ERL2-C-167", "LocalObservationLimitsV1", "observation", "local-observation-limits/v1"),
  // The plan and result became closed unions when owner-operated trusted-local
  // execution arrived (ADR-ERL2-042): the certified variants below are the
  // originals, byte-for-byte, and the trusted-local variants are separate
  // documents rather than the same document with certification fields reused
  // for something no certifier ever saw.
  d("ERL2-C-168", "LocalObservationPlanV1", "observation", undefined, true),
  d("ERL2-C-168a", "LocalObservationCertifiedPlanV1", "observation", "local-observation-plan/v1"),
  d("ERL2-C-168b", "LocalObservationTrustedLocalPlanV1", "observation", "local-observation-plan/v1"),
  d("ERL2-C-169", "LocalObservationOperationRecordV1", "observation", undefined, true),
  d("ERL2-C-170", "LocalObservationResultV1", "observation", undefined, true),
  d("ERL2-C-170a", "LocalObservationCertifiedResultV1", "observation", "local-observation-result/v1"),
  d("ERL2-C-170b", "LocalObservationTrustedLocalResultV1", "observation", "local-observation-result/v1"),

  // Owner-operated trusted-local development path (ADR-ERL2-042). None of these
  // is a certification artefact and none may be named as one.
  d("ERL2-C-180", "TrustedLocalAdapterDeclarationV1", "adapter", "trusted-local-adapter-declaration/v1"),
  d("ERL2-C-181", "TrustedLocalOwnerAcknowledgementV1", "adapter", undefined),
  d("ERL2-C-182", "TrustedLocalObservationRecordV1", "observation", "trusted-local-observation-record/v1"),
  d("ERL2-C-183", "TrustedLocalOperationOutcomeV1", "observation", undefined),
  // Registered so the compact predecessor can be validated on its own, at the
  // point it is constructed, rather than only as part of an enclosing request.
  d("ERL2-C-184", "AdapterRequestPredecessorV2", "adapter", undefined, true),

  // Subject-isolation qualification (ERL2-OQ-008, ADR-ERL2-016)
  d("ERL2-C-149", "IsolationSubstrateLockV1", "isolation", "isolation-substrate-lock/v1"),
  d("ERL2-C-150", "IsolationEnforcementProbeResultV1", "isolation", "isolation-enforcement-probe-result/v1"),
  d("ERL2-C-151", "IsolationQualificationReportV1", "isolation", "isolation-qualification-report/v1"),
  // A signed manifest authenticating the twenty probe results (review §10.1/6R-E).
  d("ERL2-C-154", "IsolationProbeSigningManifestV1", "isolation", "isolation-probe-signing-manifest/v1"),

  // Trust, timestamps, lifecycle
  d("ERL2-C-098", "TrustPolicyManifestV2", "trust", "trust-policy-manifest/v2"),
  d("ERL2-C-099", "TrustedTimestampCheckpointV1", "trust", "trusted-timestamp-checkpoint/v1"),
  d("ERL2-C-100", "SignerInventoryV2", "trust", undefined, true),
  d("ERL2-C-101", "TrustVerificationReportV2", "trust", "trust-verification-report/v2"),
  d("ERL2-C-102", "ExposureEventV1", "trust", "exposure-event/v1"),
  d("ERL2-C-103", "LabLifecycleEventV1", "trust", "lab-lifecycle-event/v1"),
  d("ERL2-C-104", "PreEnvironmentSignerInventoryV2", "trust", "signer-inventory/v2"),
  d("ERL2-C-105", "EnvironmentSignerInventoryV2", "trust", "signer-inventory/v2"),
];

const byName = new Map(CONTRACTS.map((c) => [c.name, c]));
const byId = new Map(CONTRACTS.map((c) => [c.id, c]));

export function contractByName(name: string): ContractDescriptor | undefined {
  return byName.get(name);
}

export function contractById(id: string): ContractDescriptor | undefined {
  return byId.get(id);
}

export type ContractName = (typeof CONTRACTS)[number]["name"];
