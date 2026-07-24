# CONFLICT-ERL2-001 — retained V1 trust contracts cannot express V2 terminals

**Status:** resolved — option 1 accepted 2026-07-23
**Raised:** 2026-07-23, during Slice 2 contract freeze
**Resolution:** ADR-ERL2-012 (accepted)
**Impacted requirements:** ERL2-FR-010, ERL2-FR-011, ERL2-FR-019, ERL2-FR-023, ERL2-AC-022, ERL2-AC-027

## The conflict

`external-reality-lab-design-v2.md` §16.2 states that `TrustPolicyManifestV1`,
`ProductSafeSignerInventoryV1` and `TrustVerificationReportV1` are *"byte-compatible
retained contracts"* whose *"V1 schema IDs and domains remain unchanged."*

Three V2 requirements cannot be satisfied by those contracts as written.

1. **Signer roles.** §15 requires the verifier to authorize
   `wrapper_signature.key_id` "under the locally pinned run trust policy's
   Lab/verifier role", and §16.2 defines reveal custodians and a randomness
   source as distinct roles. The revision-0.9.8 `TrustPolicyManifestV1`
   `signer_roles` enumeration is closed and contains none of them.

2. **Pre-environment signer inventory.** §16.2 defines
   `PreEnvironmentPublicVerificationBundleV2` with a required `signer_inventory`
   member, but `ProductSafeSignerInventoryV1` requires
   `selection_commitment_hash`, which by construction does not exist for an
   acquisition or package-verification terminal (§16.3 forbids selection
   artifacts in the pre-environment branch).

3. **Excluded terminal types.** `ProductSafeSignerInventoryV1` pins
   `excluded_public_terminal_types` to the literal pair
   `["selection-verification-receipt/v1", "final-run-attestation/v1"]`. Both
   schema identities were replaced in V2 by
   `selection-verification-receipt/v2` and the two `*-final-lab-attestation/v1`
   variants, so the retained literal cannot describe a V2 run.

A fourth, smaller instance: `TrustVerificationReportV1` requires
`selection_verification_receipt_hash`, which a pre-environment terminal
does not have.

## Why it is not resolvable silently

Design v2 §26 requires: *"use explicit V2 majors or new names for changed fields
and invariants … no schema-ID reuse or synthetic no-op artifacts."* Redefining a
V1 identity in place would violate that rule and would invalidate retained V1
bytes. Emitting a bundle without a signer inventory would violate the bundle
schema. Fabricating a synthetic selection commitment for a pre-environment run
is explicitly forbidden by §16.3 and ERL2-AC-022.

## What the implementation did

Following the design's own migration rule rather than its retained-contract
list, Slice 2 introduces new majors and leaves every V1 identity untouched and
readable:

| V2 contract | Retained V1 identity | Change |
|---|---|---|
| `trust-policy-manifest/v2` | `trust-policy-manifest/v1` unchanged | superset signer-role enumeration |
| `signer-inventory/v2` | `product-safe-signer-inventory/v1` unchanged | closed union on `terminal_variant`; correct V2 exclusion sets |
| `trust-verification-report/v2` | `trust-verification-report/v1` unchanged | `selection_verification_receipt_hash` conditional on terminal variant |
| `lab-lifecycle-event/v1` | `run-lifecycle-event/v1` unchanged | new name, not a redefinition |

This is recorded as **ADR-ERL2-012**, accepted by the design owner on
2026-07-23. The four V2 majors are frozen contracts; the V1 identities remain
readable and unmodified.

## Decision taken

**Option 1, accepted 2026-07-23.** The V2 majors above are the frozen contracts,
and design v2 §16.2's retained-contract list is amended to exclude
`TrustPolicyManifestV1`, `ProductSafeSignerInventoryV1` and
`TrustVerificationReportV1`, which move to the "superseded by a V2 major"
category. The change is recorded in the design's revision history as
2.0.0-draft.10.

Options rejected:

2. *Amend the V1 contracts in place* — rejected: it would violate design v2 §26's
   no-schema-ID-reuse rule and would invalidate retained V1 bytes.
3. *Drop the pre-environment terminal variant* — rejected: it would remove the
   Slice 2 exit gate "fake valid run verifies offline" and leave
   ERL2-FR-019 and ERL2-AC-022 unimplementable.
