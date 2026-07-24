# ADR-ERL2-011 — Single-source beacon randomness, evidence ownership and threshold VRF

**Status:** accepted
**Date:** 2026-07-23
**Deciders:** Lab Core Owner, Integrity/Security Owner
**Normative source:** `external-reality-lab-design-v2.md` §5, §28

## Context

Selector-originated seeds allow source shopping; conflating beacon and Lab signatures allows a false claim about what the beacon attested.

## Decision

- Exactly one randomness source is named in the policy before pool construction. There is no list, fallback, retry, redraw, parallel observation or selector seed.
- The pool freezes and is checkpointed before the first finalized eligible beacon round is observed.
- The beacon-native proof authenticates only the canonical round and output, under the beacon's own signing domain, verified against locally pinned keys. `signForeignDomain` refuses any ERL2 domain.
- `ExternalBeaconRandomnessReceiptV1` is a Lab/verifier-owned wrapper signed under `ERL2-BEACON-ASSOCIATION-V1`. The beacon never receives or signs `source_request_binding_hash`.
- Selection derives `seed = HMAC-SHA-256(randomness_output, "ERL2-SELECT-V2\n" || request_nonce || pool_root_hash)`. Rejection sampling then draws 32-bit candidates from successive `HMAC-SHA-256(seed, "ERL2-SELECT-INDEX-V2\n" || be32(counter))` blocks and rejects any candidate at or above `floor(2^32 / n) * n`. `rejection_count` is recorded and re-derived by the verifier.
- Threshold VRF is DISABLED. `ThresholdVrfRandomnessPolicyV1` is a non-admissible reservation marker; there is no threshold-VRF receipt schema and no successful golden. Every attempt fails with `THRESHOLD_VRF_NOT_ACTIVATED`.
- Activation requires this ADR to pin an audited DKG, authenticated share distribution and verification, uniqueness proof, canonical transcript format and domain separation, participant admission and replacement, proactive and ordinary key rotation, compromise detection and recovery, abort/restart rules, threshold bounds and test vectors — plus new major contracts and security review. None of that exists yet, so activation is refused.
- ERL2-OQ-007 is unresolved: no external beacon is qualified. The fail-closed state is non-blind development selection only, enforced by `assertDevelopmentTierOnly`.

## Alternatives rejected

- Selector-chosen seed rejected.
- Fallback source rejected: an unavailable source invalidates the run instead.
- Threshold VRF as a fallback rejected.

## Consequences and executable evidence

- `tests/adversarial/selectionChain.test.ts` covers wrapper scope confusion, unpinned sources, second draws, threshold-VRF refusal and role/key overlap.
- `packages/core/src/selection/verify.ts` re-derives every receipt check rather than trusting its boolean literals.

## Rollback

Reverting this decision requires a superseding ADR and new golden fixtures; retained artifacts are never rewritten.
