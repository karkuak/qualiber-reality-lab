# ADR-ERL2-008 — Environment archetype admission

**Status:** proposed
**Date:** 2026-07-23
**Deciders:** Lab Core Owner, Integrity/Security Owner
**Normative source:** `external-reality-lab-design-v2.md` §5, §28

## Context

A telemetry-only substrate model would silently narrow the domain.

## Decision

- Archetypes are admitted independently of any subject and separate topology, normal disorder, challenge mutations and cleanup expectations.
- Evidence-source kinds are an open enumeration owned by the environment contract and never filtered by subject support.
- ERL2-OQ-005 (OpenTelemetry Demo archive and per-platform image digest lock) is unresolved, so the Compose driver stays disabled and only the fake driver is used.

## Alternatives rejected

- Pinning revision 0.9.8's proposed 2.2.0 tag without re-qualification rejected: upstream changed through July 2026.

## Consequences and executable evidence

- `erl2 doctor` reports `compose_environment_driver: disabled_pending_erl2_oq_005`.

## Rollback

Reverting this decision requires a superseding ADR and new golden fixtures; retained artifacts are never rewritten.
