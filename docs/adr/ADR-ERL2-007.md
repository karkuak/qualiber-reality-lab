# ADR-ERL2-007 — Neutral OSS subject selection

**Status:** proposed
**Date:** 2026-07-23
**Deciders:** Lab Core Owner, Integrity/Security Owner
**Normative source:** `external-reality-lab-design-v2.md` §5, §28

## Context

Choosing an OSS subject for adapter convenience would make the independence claim circular.

## Decision

- The candidate inventory, criteria and scoring are published before any adapter feasibility work.
- At least three independently discovered candidates; at least two must remain eligible.
- Rejected and failed candidates are retained.
- ERL2-OQ-003 is unresolved. Until it is, the architectural-independence claim is withheld.

## Alternatives rejected

- Design-time convenience choice rejected.

## Consequences and executable evidence

- Slice 9 is blocked; no independence claim appears in `docs/claims`.

## Rollback

Reverting this decision requires a superseding ADR and new golden fixtures; retained artifacts are never rewritten.
