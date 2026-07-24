# Slice 6.5 gap matrix — environment vertical closure

**Design revision:** `external-reality-lab-design-v2.md` `2.0.0-draft.11`
**Generated:** 2026-07-23, against the working tree after the Slice 6.5 finalization work
**Purpose:** implementation-plan §7.5. It states, per contract, exactly which of
the eight layers exist and which do not, so the remaining work is a list rather
than an estimate.

## How to read it

| Column | Meaning |
|---|---|
| Producer | Production code that constructs the artifact through `assertContract` |
| Durable | The artifact is frozen into the run directory, so a later process can resolve it |
| Event | A lifecycle event publishes it under a role, so the closure can derive it |
| CLI | A phase command produces it in its own OS process |
| Finalizer | The environment finalizer reads or closes over it |
| Verifier | `deriveEnvironmentClosure` requires or admits it |
| +Test | A positive test exercises it |
| −Test | An adversarial test proves its refusal |

`—` means not applicable to this contract; `no` means the layer is genuinely
absent. Nothing below is marked present because a *test* builds it: only
production code counts as a producer.

## 1. Pre-selection — reached and closed today

These already work end to end through real CLI commands; Slice 6.5 changes
nothing about them and the pre-environment terminal's frozen bytes are
unchanged.

| Contract | Producer | Durable | Event | CLI | Finalizer | Verifier | +Test | −Test |
|---|---|---|---|---|---|---|---|---|
| `AcquisitionPreregistrationV1` | yes | yes | yes | `preregister-acquisition` | yes | yes | yes | yes |
| `AcquisitionSourceManifestV1` | yes | yes | yes | `preregister-acquisition` | yes | yes | yes | yes |
| `SubjectAcquisitionRecordV1` | yes | yes | yes | `acquire` | yes | yes | yes | yes |
| `SubjectPackageVerificationRecordV1` | yes | yes | yes | `verify-package` | yes | yes | yes | yes |
| `SubjectPackageManifestV1` | yes | yes | yes | `verify-package` | yes | env-only | yes | yes |
| `JourneyStepOutcomeV1` | yes | yes | yes | every step command | yes | yes | yes | yes |

## 2. Selection — primitives complete, orchestration and CLI absent

`runSelectionChain` implements the whole protocol and is proven by
`tests/adversarial/selectionChain.test.ts`. What is missing is the durable,
cross-process orchestration: no CLI command drives it, and no lifecycle event
publishes its outputs under a role, so the environment closure cannot derive
them.

| Contract | Producer | Durable | Event | CLI | Finalizer | Verifier | +Test | −Test |
|---|---|---|---|---|---|---|---|---|
| `ChallengeManifestV1` | **no** | no | no | **no** (`preregister-challenge`) | — | required | via fixture | partial |
| `SelectionRequestV2` | via chain | no | no | **no** (`select`) | required | required | yes | yes |
| `SelectionRoleSeparationAuditV1` | via chain | no | no | **no** | — | supporting | yes | yes |
| `EligibilityPoolManifestV2` | yes | no | no | **no** | — | required | yes | yes |
| `SelectionRandomnessReceiptV1` | yes | no | no | **no** | — | supporting | yes | yes |
| `SelectionCommitmentV2` | yes | no | no | **no** | inventory | required | yes | yes |
| `ThresholdRevealReceiptV1` | yes | no | no | **no** | — | supporting | yes | yes |
| `SelectedChallengeJourneyBindingV1` | yes | no | no | **no** | required | required | yes | yes |
| `SelectionProofV2` | yes | no | no | **no** | — | required | yes | yes |
| `SelectionVerificationReceiptV2` | yes | no | no | **no** | required | required | yes | yes |

## 3. Environment — driver complete, no run integration

The driver, allocator, clean control and frontier are implemented and tested
against the deterministic fake driver. None of them is reachable from a CLI
command or recorded in the lifecycle chain.

| Contract | Producer | Durable | Event | CLI | Finalizer | Verifier | +Test | −Test |
|---|---|---|---|---|---|---|---|---|
| `EnvironmentReservationLeaseV1` | yes | lease dir | no | **no** | — | required | yes | yes |
| `EnvironmentDriverManifestV1` | yes | no | no | **no** | — | supporting | yes | yes |
| `EnvironmentResourceInventoryV1` | yes | no | no | **no** (`provision`) | required | required | yes | yes |
| `EnvironmentOperationReceiptV1` | yes | no | no | **no** | — | optional | yes | yes |
| `EnvironmentBaselineFingerprintV1` | yes | no | no | **no** (`baseline`) | — | required | yes | yes |
| `EnvironmentResourceFrontierV1` | yes | no | no | **no** | emergency | — | yes | yes |
| `SubjectExecutionPlanV1` | **no** | no | no | **no** (`plan`) | required | required | **no** | **no** |

## 4. Capture and adapter execution — primitives exist, three producers missing

| Contract | Producer | Durable | Event | CLI | Finalizer | Verifier | +Test | −Test |
|---|---|---|---|---|---|---|---|---|
| `CutoffPolicyV1` / `RuntimeMilestoneV1` | yes | no | no | **no** | — | supporting | yes | yes |
| `SourceSnapshotV1` | yes | no | no | **no** (`observe`) | — | optional | yes | yes |
| `ObservationBundleV2` | yes | no | no | **no** (`freeze-observation`) | optional | optional group | yes | yes |
| `ReplayCanonicalEvidenceEnvelopeV1` | yes | no | no | **no** | optional | optional group | yes | yes |
| `LiveCanonicalEvidenceEnvelopeV1` | yes | no | no | **no** | optional | optional group | yes | yes |
| `AdapterTranslationReceiptV1` | **no** | no | no | **no** | optional | optional group | via fixture | partial |
| `SemanticEvidenceEquivalenceReceiptV1` | **no** | no | no | **no** | — | — | **no** | **no** |
| `GenericClaimSetV1` | **no** | no | no | **no** | — | — | **no** | **no** |
| `EnvironmentSubjectOutputManifestV1` | **no** | no | no | **no** | required | required | **no** | **no** |

## 5. Evaluation — complete except for the environment output it reads

| Contract | Producer | Durable | Event | CLI | Finalizer | Verifier | +Test | −Test |
|---|---|---|---|---|---|---|---|---|
| `SelectedJourneyResultV1` | yes | no | no | **no** | required | required | yes | yes |
| `DomainResultEvaluatedV1` | yes | no | no | **no** | required | required | yes | yes |
| `DomainResultNotApplicableV1` | yes | yes | yes | `evaluate` | required | required | yes | yes |
| `GenericPrecleanupResultJoinV1` | yes | yes | yes | `evaluate` | required | required | yes | yes |
| `MetricResultV1` | yes | yes | yes | `evaluate` | — | optional | yes | yes |
| `ExposureEventV1` | **no** | no | no | **no** | **required** | supporting | **no** | **no** |

## 6. Environment cleanup, validity and terminal — added this slice

Everything in this section now has a producer. The four terminal builders, the
ordered finalization gate, the environment closure derivation and the verifier
variant were added in Slice 6.5; they are unit-proven but not yet reachable from
a CLI-driven run, because sections 2–4 above have no orchestration.

| Contract | Producer | Durable | Event | CLI | Finalizer | Verifier | +Test | −Test |
|---|---|---|---|---|---|---|---|---|
| `EnvironmentRestorationVerificationV1` | yes | no | no | **no** (`restore`) | required | required | yes | yes |
| `TeardownVerificationV1` | yes | no | no | **no** (`destroy`) | required | required | yes | yes |
| `EmergencyCleanupVerificationV1` | yes | yes | yes | — | invalid route | invalid route | yes | yes |
| `EnvironmentValidityResultV1` | yes | no | no | **no** | required | required | yes | **no** |
| `GenericEvaluationIndexV1` | yes | yes | yes | `finalize-generic` | required | required | yes | yes |
| `EnvironmentLabRunRecordV1` | **yes (new)** | no | no | **no** | yes | yes | **no** | **no** |
| `EnvironmentSignerInventoryV2` | **yes (new)** | no | no | **no** | yes | yes | **no** | **no** |
| `EnvironmentFinalLabAttestationV1` | **yes (new)** | no | no | **no** | yes | yes | **no** | **no** |
| `EnvironmentPublicVerificationBundleV2` | **yes (new)** | no | no | **no** | yes | **yes (new)** | **no** | **no** |
| `MandatoryGraphClosureReportV1` (env) | **yes (new)** | — | — | `verify` | — | yes | **no** | **no** |

## 7. Subject-isolation qualification — complete (ERL2-OQ-008 gate 1)

Added this slice and fully closed at the evidence level. It is listed here
because it is the other half of the Slice 6.5 scope, not because it is part of
the environment terminal.

| Contract | Producer | Durable | Event | CLI | Finalizer | Verifier | +Test | −Test |
|---|---|---|---|---|---|---|---|---|
| `IsolationSubstrateLockV1` | yes | `environments/isolation/` | — | `qualify:isolation`, `doctor` | — | re-derived | yes | yes |
| `IsolationEnforcementProbeResultV1` | yes | `environments/isolation/probes/` | — | `qualify:isolation`, `doctor` | — | re-derived | yes | yes |
| `IsolationQualificationReportV1` | yes | `environments/isolation/` | — | `qualify:isolation`, `doctor` | — | re-derived | yes | yes |

## 8. What blocks a valid environment terminal

In dependency order. Each item is a prerequisite for the ones below it.

1. **No `SubjectExecutionPlanV1` producer.** The plan is a mandatory closure
   role and a mandatory run-record member. Nothing constructs one.
2. **No `EnvironmentSubjectOutputManifestV1` producer.** The environment branch
   cannot freeze subject output at all, so the reveal ordering that the whole
   design turns on has no environment-side implementation.
3. **No `ExposureEventV1` producer.** `assertEnvironmentFinalizable` requires
   one, correctly: an environment run really did open a selected challenge.
4. **No `AdapterTranslationReceiptV1` producer.** The capture group is
   all-or-nothing, so a run that reaches observation cannot close it.
5. **No lifecycle events for any section 2–4 artifact.** The closure derives
   required roles from `produced` entries in the hash-chained lifecycle. Until
   the orchestration publishes them, `deriveEnvironmentClosure` reports every
   environment role as missing — which is the correct fail-closed behaviour and
   is why no environment bundle can be signed today.
6. **No phase CLI commands.** `select`, `provision`, `baseline`, `plan`,
   `install`, `configure`, `authenticate`, `connect`, `activate`, `journey`,
   `observe`, `freeze-observation`, `execute-subject`, `restore`, `destroy` all
   still refuse with `POLICY_COMMAND_NOT_IMPLEMENTED`. That refusal is honest:
   absence is never reported as success.

Items 1–4 are new producers over existing frozen contracts; no schema change is
required for any of them. Item 5 is orchestration inside `RunWorkspace`. Item 6
is the CLI surface over that orchestration.

## 9. What is safe to rely on today

- The pre-environment terminal is unchanged: same producers, same frozen bytes,
  same offline verification, same refusals.
- The environment finalization stack and the environment closure derivation
  exist and refuse correctly, including the pre-environment/environment
  crossover in both directions.
- No environment attestation or bundle can be produced, because the closure it
  must satisfy cannot be derived. The failure mode is refusal, not a bundle that
  verifies against an incomplete graph.
