# ADR-ERL2-013 — a successful package verification has exactly one authorized continuation

**Status:** accepted
**Date:** 2026-07-23
**Deciders:** Lab Core Owner, Integrity/Security Owner
**Normative source:** `external-reality-lab-design-v2.md` §11.1, §12, §16.2, §16.3

## Context

The Slice 4 implementation carried a lifecycle edge
`package_manifest_frozen → subject_output_frozen`, justified in a code comment
by the existence of a `verify_package` pre-environment terminal stage. That
edge lets a run whose package verification **succeeded** finalize before
challenge preregistration, and the Slice 4 CLI evidence exercised exactly that
path. Slice 5 could not proceed on an ambiguous transition table, so the edge
was reviewed against the design and the schemas rather than against the
handoff summary.

## Evidence examined

1. **The §12 state diagram.** It contains
   `step_outcome_frozen --> package_manifest_frozen: package verified` and
   `package_manifest_frozen --> challenge_preregistered`, and no edge from
   `package_manifest_frozen` to `subject_output_frozen`. The generic terminal
   route it *does* define is `step_outcome_frozen --> subject_output_frozen:
   all subject steps terminal`, plus
   `step_outcome_frozen --> pre_reveal_subject_cleanup_started: failed or
   unsupported` and
   `pre_reveal_subject_cleanup_started --> subject_output_frozen`.

2. **The §12 narrative.** "A failed or unsupported acquisition/setup/operation
   step **can finalize** without functional scoring when its outcome and all
   applicable pre-reveal recovery/rollback/remove attempts are frozen into the
   subject output." Early finalization is authorized for failed and unsupported
   steps. Nothing authorizes it for a successful one.

3. **`PreEnvironmentLabRunRecordV1` (§16.2).** Its members are the
   preregistration, source manifest, acquisition record, an optional
   `package_verification_record_hash`, adapter, run policy, subject output,
   journey result, domain-not-applicable result, join, cleanup, validity and
   index. It has **no** `subject_package_manifest_hash` member;
   `EnvironmentLabRunRecordV1` requires one. A successful package manifest
   reached in a pre-environment terminal would therefore be a retained artifact
   that the terminal record cannot cite — precisely what the verifier-derived
   mandatory closure (ERL2-FR-020, ERL2-AC-023) reports as a rejected extra.

4. **§16.3.** "The pre-environment branch forbids selection/environment/
   observation/restoration/teardown/exposure members." The branch is defined by
   what could not yet exist, and a package manifest exists only when
   verification succeeded — at which point selection is the next required step,
   not an optional one.

The `verify_package` terminal stage is therefore the terminal for a **failed or
unsupported** package verification, reached through the generic step-outcome
route. It is not an early stop for a successful one.

## Decision

**Resolution A.** A successful package verification has exactly one authorized
continuation.

- `package_manifest_frozen → subject_output_frozen` is removed from the
  transition table. `package_manifest_frozen → challenge_preregistered` is
  retained, alongside the universal `→ invalid_failure_detected` edge.
- A failed or unsupported verification reaches `subject_output_frozen` through
  the unchanged generic terminal step-outcome route.
- `PreEnvironmentSubjectOutputManifestV1` no longer declares
  `subject_package_manifest_hash` at all. The branch is closed
  (`additionalProperties: false`), so the field now fails closed as an unknown
  field in both the branch and the `SubjectOutputManifestV1` union. This
  narrows an optional member that Resolution A makes unreachable; it introduces
  no new member, changes no member's meaning, and does not require a contract
  major. `EnvironmentSubjectOutputManifestV1` is unchanged.
- `RunWorkspace.freezeSubjectOutput` refuses with the catalogued code
  `GRAPH_CLOSURE_TERMINAL_MISMATCH` when the run has frozen a package manifest.
- `derivePreEnvironmentClosure` refuses a lifecycle that produced a
  `subject-package-manifest` role (and the other environment-only roles) with
  the same code, so the refusal survives independently of the producer.
- A valid pre-environment terminal may produce `finding` artifacts; the closure
  now admits that optional role instead of reporting a subject finding as a
  rejected extra.

The second reported Slice 4 transition — `invalidate()` routing through
`invalid_failure_detected` before cleanup — is confirmed correct and unchanged.
It matches §12 (`invalid_failure_detected` is the only predecessor of either
invalid cleanup branch) and is now covered by an executable test.

## Alternatives rejected

- **Resolution B (authorize a successful-verification early terminal).**
  Rejected: it would require a new normative terminal variant with its own
  run-record, cleanup, validity, attestation and bundle members to carry the
  package manifest, a new terminal discriminant, and contract majors for every
  schema whose closed shape changed — for a stop the design never describes.
  Per the Slice 5 continuation prompt §12 this would have been a stop-and-ask;
  the design evidence does not support it.
- **Keeping the edge and fabricating a manifest-free output for successful
  verification.** Rejected explicitly by the continuation prompt §5.2 and by
  design v2 §26's ban on synthetic no-op artifacts.
- **Leaving `subject_package_manifest_hash` optional but unreachable.**
  Rejected: an unreachable optional member is a latent re-entry point for the
  same defect, and §16.2 already states that acquisition/package/setup failures
  forbid descendants that could not yet exist.

## Consequences and executable evidence

- `tests/adversarial/preEnvironmentTerminal.test.ts` proves the refusal at four
  independent layers: transition table, closed schema, run workspace and
  offline closure verifier.
- `tests/e2e/journeyRun.test.ts` proves the CLI path: a successful verification
  ends at `package_manifest_frozen` and reports
  `next_authorized_state: "challenge_preregistered"`, while
  `freeze-output --terminal-stage verify_package` refuses with exit 10 and
  `GRAPH_CLOSURE_TERMINAL_MISMATCH`; failed and unsupported verifications reach
  `subject_output_frozen`.
- `fixtures/golden/journey-acquisition-to-frozen-output` is regenerated: the
  terminal run now fails verification, and a second run records the refusal.
  The golden valid pre-environment run
  (`fixtures/golden/valid-pre-environment-run`) now models a failed
  verification with a `subject_package_verification_failure` subject finding
  and verifies offline unchanged otherwise.
- No retained artifact was rewritten; only development fixtures were
  regenerated, which the golden policy permits.

## Rollback

Reverting requires a superseding ADR that defines the full normative terminal
variant described under Resolution B, together with its contract majors.
