# ADR-ERL2-004 — Four result planes, no scalar aggregate

**Status:** accepted
**Date:** 2026-07-23
**Deciders:** Lab Core Owner, Integrity/Security Owner
**Normative source:** `external-reality-lab-design-v2.md` §5, §28

## Context

A single leaderboard score lets a semantic win compensate a safety or validity failure.

## Decision

- Validity, journey, domain and optional deep results are separate artifacts with separate hashes.
- `GenericEvaluationIndexV1` binds them; it does not combine them.
- Only `ValidityResultV1.status="valid"` may enter the generic index.
- Every metric declares numerator, denominator, zero-denominator behaviour, inclusions, exclusions, threshold class and claim ceiling.

## Alternatives rejected

- Weighted scalar score rejected.

## Consequences and executable evidence

- `packs/operations` metric definitions carry all six required fields.
- The `pre-environment-validity-result/v1` schema routes `status="invalid"` away from the index.

## Rollback

Reverting this decision requires a superseding ADR and new golden fixtures; retained artifacts are never rewritten.
