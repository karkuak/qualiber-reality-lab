# ADR-ERL2-005 — Core-owned adapter host and privilege broker

**Status:** accepted
**Date:** 2026-07-23
**Deciders:** Lab Core Owner, Integrity/Security Owner
**Normative source:** `external-reality-lab-design-v2.md` §5, §28

## Context

An adapter that can run arbitrary scripts or request ambient privilege becomes a semantic escape hatch.

## Decision

- The host is core-owned; adapters run as separate processes over framed canonical JSON.
- Privilege is a signed RPC to a closed capability broker. There is no shell, glob or environment expansion.
- ERL2-OQ-001 (broker host technology) is unresolved, so the fail-closed state applies: only unprivileged container subjects are supported and no native installer path exists.
- Adapter requests are phase-specific; a later-phase ancestor in an earlier request fails with `REQUEST_ANCESTRY_INVALID`.

## Alternatives rejected

- Adapter-supplied shell commands rejected.

## Consequences and executable evidence

- `packages/adapter-sdk` implements `assertRequestAncestry` and the oracle-canary scanner.
- `erl2 doctor` reports `privilege_broker: unprivileged_container_subjects_only_pending_erl2_oq_001`.

## Rollback

Reverting this decision requires a superseding ADR and new golden fixtures; retained artifacts are never rewritten.
