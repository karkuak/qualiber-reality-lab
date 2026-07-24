# ADR-ERL2-010 — Held-out release authority

**Status:** proposed
**Date:** 2026-07-23
**Deciders:** Lab Core Owner, Integrity/Security Owner
**Normative source:** `external-reality-lab-design-v2.md` §5, §28

## Context

Held-out claims must not ship before calibration and retention approval.

## Decision

- Held-out and blind operation requires disjoint operator identities and keys, threshold reveal custody, an append-only access log, and a qualified external beacon.
- ERL2-OQ-006 (seven-year retention legal approval) is unresolved, so held-out production release is disabled.
- Solo development is labelled process separation, never personnel independence.

## Alternatives rejected

- Personnel-independence claim from a solo workflow rejected.

## Consequences and executable evidence

- `BlindSelectionAssuranceV1` requires the literal residual-collusion limitation; a stronger claim fails schema validation.

## Rollback

Reverting this decision requires a superseding ADR and new golden fixtures; retained artifacts are never rewritten.
