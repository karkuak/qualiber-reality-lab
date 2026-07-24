# ADR-ERL2-012 — New majors for trust policy, signer inventory and trust verification report

**Status:** accepted
**Date:** 2026-07-23
**Deciders:** Lab Core Owner, Integrity/Security Owner
**Normative source:** `external-reality-lab-design-v2.md` §5, §28

## Context

Design v2 §16.2 lists `TrustPolicyManifestV1`, `ProductSafeSignerInventoryV1` and `TrustVerificationReportV1` as retained byte-compatible, but V2 changed what they must describe. Implementing them unchanged is impossible without silently redefining a V1 schema, which §26 forbids.

## Decision

- `trust-policy-manifest/v2` extends the signer-role enumeration with the roles V2 introduces (`lab_verifier_association_signer`, `reveal_custodian`, `randomness_source`, `challenge_governor`, `environment_governor`, `evaluator`, `adapter_owner`, `deep_finalizer`).
- `signer-inventory/v2` is a closed union discriminated by `terminal_variant`. The pre-environment branch has no selection commitment and excludes only `pre-environment-final-lab-attestation/v1`; the environment branch keeps the V1 exclusion pair updated to the V2 schema identities.
- `trust-verification-report/v2` makes `selection_verification_receipt_hash` conditional on the terminal variant.
- `lab-lifecycle-event/v1` is a new name rather than a redefinition of `run-lifecycle-event/v1`.
- The V1 schema identities remain available, unmodified, for retained V1 artifacts and the legacy verification wrapper.

## Alternatives rejected

- Redefining the V1 schemas in place rejected: it violates design v2 §26 and would silently invalidate retained bytes.
- Emitting a pre-environment bundle without a signer inventory rejected: the bundle schema requires one.

## Consequences and executable evidence

- Recorded as CONFLICT-ERL2-001 in `docs/decisions/`. **Accepted by the design owner on 2026-07-23 (option 1).** `external-reality-lab-design-v2.md` revision 2.0.0-draft.10 amends the §16.2 retained-contract list accordingly, so the design and the implementation no longer conflict.
- The four V2 majors are frozen contracts as of Slice 2.
- The V1 schema identities remain readable and unmodified; no retained V1 artifact is rewritten.

## Rollback

Reverting this decision requires a superseding ADR and new golden fixtures; retained artifacts are never rewritten.
