# ADR-ERL2-016 — subject isolation is qualified by observed enforcement, never by declaration

**Status:** accepted
**Date:** 2026-07-23
**Deciders:** Integrity/Security Owner, Lab Core Owner, Adapter Reviewer
**Normative source:** `external-reality-lab-design-v2.md` revision `2.0.0-draft.11` §21, §22; implementation plan §11.4; Slice 6 parallel safety track

## Context

The only enabled sandbox profile is `local-process`: a same-user child process.
It genuinely enforces a process boundary, process-tree termination, framing and
deadline caps, an environment allowlist, capability denial, credential handles
and egress adjudication. It does **not** enforce a read-only root filesystem, a
non-root uid, capability drop, no-new-privileges, seccomp, cgroup limits, a
network namespace, kernel read-only mounts, or home-directory isolation.

That is adequate for reference subjects whose source lives in this repository.
It is not adequate for the opaque private artifact Slice 7 needs, or the
third-party OSS subject Slice 9 needs, where the threat model includes an
adversary rather than a bug.

The failure mode this decision guards against is specific: a substrate manifest
that *says* it enforces a control, or a test harness that *mocks* enforcement,
being mistaken for the control actually holding.

## Decisions

### 1. Enabled status is derived, never declared

`qualifyIsolationProfile` takes a substrate lock and a set of enforcement probe
results, and returns `qualified` or `not_qualified`. It has **no input that
means "enabled"**. A profile manifest asserting `enabled: true` cannot reach the
verdict, because no such field is read.

### 2. Probe evidence is discriminated, and only `observed` counts

Every probe result declares how its state was established: `observed`,
`declared`, `mocked`, or `absent`. Qualification requires `observed` for all
twenty required controls.

`fakeEnforcementProbes()` exists so the procedure, its refusals and its
reporting can be tested without a container runtime — and it returns every
control as `mocked` with reason `MOCKED_PROBE_IS_NOT_EVIDENCE`. Running the fake
harness therefore *cannot* qualify a profile. This is the executable form of the
prompt's constraint "do not claim kernel isolation from mocked tests alone".

### 3. A pinned immutable substrate lock is a precondition

Without a pinned lock and an image digest, the verdict is `not_qualified` with
reason `SUBSTRATE_LOCK_NOT_PINNED`, regardless of probe results. Enforcement
observed against an unpinned runtime says nothing about the runtime a later run
will use.

### 4. Subject trust gates the profile

`assertSubjectMayRunUnderProfile` admits `trusted_reference` subjects on
`local-process` and refuses `opaque_private` and `third_party` subjects there.
A qualified container profile admits an opaque subject **under that profile
only**; it does not retroactively make `local-process` safe.

### 5. This track does not implement a privilege broker

ERL2-OQ-001 stays fail-closed and untouched. Stronger isolation and privileged
operations are separate questions, and conflating them would let a container
qualification silently widen what a subject may do.

## Consequences

- The current honest outcome is **not qualified**: no substrate is pinned on
  this host, so `disabled_no_qualified_adapter_substrate` is retained and
  recorded as ERL2-OQ-008.
- Slice 6 is unblocked, because its reference subjects are trusted fixtures.
- Slice 7 must not execute an opaque package and Slice 9 must not execute a
  third-party OSS subject until a substrate is pinned and all twenty controls
  are observed holding.
- When a substrate is qualified, `tests/adversarial/isolationQualification.test.ts`
  is the file that must change, and it may only change because a real probe
  observed enforcement.

## Alternatives considered

- **Enable the container profile behind a flag.** Rejected: a flag is a
  declaration, and the whole point of this decision is that declarations do not
  qualify a profile.
- **Treat the local-process profile as sufficient for opaque subjects with a
  documented caveat.** Rejected: a caveat in prose does not stop a subject
  reading the operator's home directory.
- **Defer the procedure until a substrate exists.** Rejected: the procedure is
  what makes the substrate decision auditable, and writing it after the fact
  invites fitting it to whatever the substrate happens to do.
