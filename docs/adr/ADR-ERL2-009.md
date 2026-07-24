# ADR-ERL2-009 — Human and agent assistance as evidence

**Status:** proposed
**Date:** 2026-07-23
**Deciders:** Lab Core Owner, Integrity/Security Owner
**Normative source:** `external-reality-lab-design-v2.md` §5, §28

## Context

Operator narration must never become oracle truth.

## Decision

- Assistance is recorded as a signed `AssistanceEventV1` with actor kind, script version, prompt hash, visible evidence hashes, action, timing and intervention reason.
- Free narration is retained as non-deterministic commentary and cannot satisfy truth, citations or gates.
- Undocumented workarounds are structured mutations with before/after hashes.

## Alternatives rejected

- Free-text operator notes as evidence rejected.

## Consequences and executable evidence

- Slice 4 delivers the contract and the JOURNEY-CAPTURE suite.

## Rollback

Reverting this decision requires a superseding ADR and new golden fixtures; retained artifacts are never rewritten.
