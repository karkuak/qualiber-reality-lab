# ADR-ERL2-006 — Same-challenge semantics and comparison modes

**Status:** accepted
**Date:** 2026-07-23
**Deciders:** Lab Core Owner, Integrity/Security Owner
**Normative source:** `external-reality-lab-design-v2.md` §5, §28

## Context

Identical argv or UI across different products is impossible, and byte-identical live ecosystems do not exist.

## Decision

- Sameness is defined by generic interaction intents plus identical challenge, archetype, truth, policies and step commitments.
- `replay_comparison` is development-only and non-blind; it alone can support the byte-identity architecture proof.
- `live_ecosystem` is blind-capable and requires an independently implemented semantic-equivalence receipt.
- Mode crossover is rejected at schema level: replay mode requires `development_only_non_blind` plus a replay envelope hash; live mode requires `blind_capable` plus equivalence profile and verifier hashes.

## Alternatives rejected

- Raw-byte equality for live runs rejected: it would be a false claim.

## Consequences and executable evidence

- `ComparisonPolicyV1` conditionals in `packages/contracts/schemas/selection.schema.json`.
- `SelectionRequestV2` rejects non-blind replay fields for held-out and blind tiers.

## Rollback

Reverting this decision requires a superseding ADR and new golden fixtures; retained artifacts are never rewritten.
