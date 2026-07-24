# ADR-ERL2-002 — Closed contract composition

**Status:** accepted
**Date:** 2026-07-23
**Deciders:** Lab Core Owner, Integrity/Security Owner
**Normative source:** `external-reality-lab-design-v2.md` §5, §28

## Context

Extensible base objects and generic metadata bags make canonical bytes unstable and let product concepts leak into core.

## Decision

- Every contract is a closed object with `additionalProperties: false`.
- Unions use literal discriminants; there is no inheritance hierarchy.
- No contract carries `metadata`, an extension map or a generic result bag.
- A breaking contract change requires a new schema major; retained bytes are never rewritten.

## Alternatives rejected

- Open inheritance rejected: hashing and version closure become ambiguous.

## Consequences and executable evidence

- `tests/contract/contracts.test.ts` proves unknown fields fail closed.
- `scripts/generate-types.mjs --check` proves the generated types cannot drift from the schemas.

## Rollback

Reverting this decision requires a superseding ADR and new golden fixtures; retained artifacts are never rewritten.
