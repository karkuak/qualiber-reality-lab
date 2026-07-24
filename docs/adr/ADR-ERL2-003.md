# ADR-ERL2-003 — Canonical identity, signatures and trust compatibility

**Status:** accepted
**Date:** 2026-07-23
**Deciders:** Lab Core Owner, Integrity/Security Owner
**Normative source:** `external-reality-lab-design-v2.md` §5, §28

## Context

Revision 0.9.8's cryptographic invariants must be preserved while V2 changes several contract shapes.

## Decision

- RFC 8785 JCS is implemented exactly once, in `packages/integrity/src/canonical/jcs.ts`.
- `core_hash = SHA256(JCS(core))`; `file_sha256` is over stored bytes; `tree_hash = SHA256(JCS(sorted ArtifactRef entries))`.
- Domain-separated SHA-256 uses a closed registry (`packages/integrity/src/hash/domains.ts`).
- Ed25519 signatures cover `${domain}\n${core_hash}`; V2 uses `ERL2-SIGN-V1`, retained V1 contracts keep `ERL-SIGN-V1`.
- Beyond RFC 8785, integral values outside the IEEE-754 safe range are refused, and duplicate JSON keys are rejected before validation.
- Blind pool payloads use `threshold-x25519-envelope/v1`: ISO 7816-4 fixed-size padding, ChaCha20-Poly1305 under a fresh content key, Shamir(t,n) over GF(2^8) for the key, and ephemeral-static X25519 + HKDF-SHA-256 + ChaCha20-Poly1305 per custodian share. No new primitive is invented.

## Alternatives rejected

- Raw JSON hashing rejected: byte-identical semantics cannot be guaranteed.
- Single-custodian reveal secrets rejected: one operator could open the pool.

## Consequences and executable evidence

- `tests/integration/integrity.test.ts` covers JCS, domain closure, tree hashes, path confinement and the freeze protocol.
- `tests/adversarial/selectionChain.test.ts` exercises the threshold envelope end to end.

## Rollback

Reverting this decision requires a superseding ADR and new golden fixtures; retained artifacts are never rewritten.
