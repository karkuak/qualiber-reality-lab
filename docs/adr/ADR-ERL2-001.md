# ADR-ERL2-001 — Domain boundary and four-plane ownership

**Status:** accepted
**Date:** 2026-07-23
**Deciders:** Lab Core Owner, Integrity/Security Owner
**Normative source:** `external-reality-lab-design-v2.md` §5, §28

## Context

V2 must not become a universal product benchmark, and no plane may impersonate another.

## Decision

- The Lab is bounded to products that consume software-delivery, operational or organizational evidence and produce findings, diagnoses, hypotheses, recommendations, actions or decisions.
- Four ownership planes exist: Lab core, subject adapter, evaluation pack, optional subject-deep pack.
- Core owns environment/journey orchestration, evidence, lifecycle, truth isolation, run validity, generic measurement, attestation and verification.
- An adapter translates I/O only. A pack asserts semantics only. Neither may set validity or generic thresholds.

## Alternatives rejected

- Monolith rejected: it makes dependency tests meaningless.
- Universal-product scope rejected: there is no coherent shared object model.

## Consequences and executable evidence

- `tests/architecture/purity.test.ts` enforces the dependency direction and scans for named subjects.
- `packages/evaluation-sdk` exposes no I/O, clock, randomness, process or validity API.

## Rollback

Reverting this decision requires a superseding ADR and new golden fixtures; retained artifacts are never rewritten.
