# ADR-ERL2-018 — the accepted run transaction, recovery, run-lease and cancellation model

**Status:** accepted
**Date:** 2026-07-24
**Deciders:** Lab Core Owner, Integrity/Security Owner, Adapter Reviewer
**Supersedes:** nothing. Extends ADR-ERL2-001 (charter/lifecycle) and the
lifecycle state machine; re-affirms ADR-ERL2-013 (a successful package
verification has exactly one authorized continuation).
**Normative source:** `external-reality-lab-design-v2.md` revision
`2.0.0-draft.11` §12 (lifecycle), §20 (failure ownership), Appendix B (exit
codes), Appendix C (a durably accepted run always yields a terminal record);
implementation plan §8.4 (append-only log + derived snapshot), §8.5 (CLI), §8.6
(crash/replay matrix); remediation prompt §7 (Slice 6R-B).

## Context

The independent review (P1-2, P2-5, and the "missing mandatory cancellation"
blocker) showed that the shipped pre-environment lifecycle was **not**
replay/crash-safe. On the shipped path a command executed the subject port and
froze artifacts **before** any idempotency, lease or state check. As a result:

- an ordinary replayed or retried `acquire` (across a wall-clock second, so the
  record's `started_at`/`ended_at` bytes differed) re-ran the port, hit
  `ARTIFACT_ALREADY_FROZEN` on the re-freeze, and that Lab-owned conflict was
  laundered into a fabricated **adapter** finding — wedging a healthy run with
  no terminal record, violating ERL2-FR-001;
- the in-process run lease in `LifecycleLog` was never called and could not
  protect a run across separate `erl2` processes;
- the no-execution-after-reveal check lived *inside* `runStep`, i.e. after the
  port had already run;
- there was no `cancel` command at all, though design §12 makes cancellation a
  mandatory terminal;
- an artifact-freeze crash between the content link and its marker left a file
  that could neither complete nor re-freeze; a torn derived snapshot crashed
  commands with an uncatalogued exit.

These are architectural properties of the command-execution path, not local
bugs, so the model is recorded here before it is made hard to reverse.

## Decision

The authoritative run state is the **append-only, hash-chained lifecycle event
log**. `state/snapshot.json` is a derived cache and is **never** authoritative;
any command reconstructs state from the events. Durable receipts and frozen
artifacts are authoritative for their own content.

Every command that mutates a durably accepted run observes this order, and every
subject/adapter **port** call happens only after the checks above it pass:

1. **Acquire the durable run lease.** A single `state/lease.json`, created with
   `O_EXCL`. A live lease held by another owner is a **Lab-owned**
   `POLICY_RUN_LEASE_HELD` conflict (never adapter/subject). A lease older than a
   bounded TTL is **stale and recoverable** — the next command steals it — so a
   crash cannot wedge the run behind a dead lease. A different owner may never
   release an active lease. The lease is released when the command completes.
2. **Load and validate authoritative state** from the event log.
3. **Resolve idempotency before any external effect.** If the operation's
   durable outcome is already recorded (the produced role exists in the log), the
   command **returns the existing record without re-invoking the port or
   re-freezing bytes**. An identical replay is a no-op; the same operation id with
   different bytes is a typed conflict at the log append. No external mutation is
   ever duplicated.
4. **Validate command eligibility and terminal/reveal restrictions before
   dispatch.** `assertSubjectPortExecutable(state)` refuses subject/adapter
   execution on any revealed, finalized, cleanup or invalidating state, with zero
   external calls and zero new retained evidence.
5. **Dispatch the port**, freeze the response/receipt, freeze produced artifacts,
   append the lifecycle event, update the derived snapshot.

### Crash-boundary reconciliation

A crash at any boundary must be recoverable without repeating a completed
external mutation or inventing evidence:

- **Artifact frozen, lifecycle event missing** / **event appended, snapshot
  stale or torn:** the event log is authoritative and is replayed on the next
  command; the snapshot is rebuilt from it. `LifecycleLog.snapshot()` returns the
  in-memory state derived from the events, so a torn/missing snapshot file never
  crashes a command (it is a cache, not a source of truth).
- **Content linked, marker missing (or marker corrupt):** the artifact store
  reconciles a markerless/corrupt-marker file against the content bytes — exact
  same bytes complete the freeze (the marker is (re)written); conflicting bytes
  are a typed `ARTIFACT_ALREADY_FROZEN`. A markerless file can therefore always
  either complete or fail typed, never wedge.
- **Unrecoverable accepted run:** every durably accepted run that fails or is
  cancelled freezes exactly one `InvalidLabRunRecordV1` after **frontier-derived**
  bounded cleanup — only over evidence actually reached. The cleanup verification
  is produced only when its required members (acquisition + subject output) exist;
  otherwise the cleanup variant is `none`, so an early failure no longer demands a
  role the run never reached.

### Failure ownership (design §20)

- Lab state conflict, lease conflict, persistence failure (`ARTIFACT_ALREADY_FROZEN`
  defaults to owner `lab`), closure failure → **Lab-owned**; surfaced as the Lab
  error it is, never a fabricated adapter finding.
- Adapter protocol failure or timeout (explicit owner `adapter`) → **adapter-owned**;
  becomes an adapter finding and an invalid record.
- Subject-declared functional outcome → **subject-owned**.
- Cancellation → its own terminal, never a fabricated finding.

### Cancellation (design §12)

`cancel` is a first-class mandatory terminal. Any durably accepted, non-terminal
run may be cancelled: it freezes a **signed** `cancellation-request/v1` (new
additive contract `ERL2-C-063`; no frozen schema changed), records the observed
phase, performs frontier-derived cleanup, and freezes exactly one
`InvalidLabRunRecordV1` with a cancellation `terminal_reason` and **no**
fabricated finding. It exits on the cancellation class (12), and refuses before
run acceptance (`CANCELLATION_BEFORE_ACCEPTANCE`, exit 2) and after any terminal
completion (`CANCELLATION_AFTER_TERMINAL`, exit 11).

## Consequences

- No crash, retry, cancellation or out-of-order command can cause duplicate
  external execution, post-reveal execution, fabricated ownership, permanent
  wedging, or a terminal-less unrecoverable accepted run — the Slice 6R-B exit
  gate.
- The run lease is per-run and cross-process; concurrent commands on the same run
  are serialized, and a dead command's lease is recoverable under a bounded TTL.
- The idempotency guard is keyed on the produced-role presence in the log, which
  covers the common completed-operation replay. The narrower crash-*between*-
  freeze-*and*-append rebuild path is now closed for the shipped (development-tier
  fake-port) path by **byte-deterministic timestamps**: a run's post-acceptance
  artifacts are stamped by a `SteppingClock` anchored on the durable
  preregistration `registered_at`, and the derived snapshot's `updated_at` is
  taken from the just-appended event (not a fresh clock read, which would advance
  only on real appends and diverge on replay). A replay therefore rebuilds
  byte-identical records and step outcomes, the re-freeze is idempotent, and the
  missing event is appended — the run auto-resumes (`tests/e2e/replay.test.ts`
  "auto-resumes"). For a *real* out-of-process adapter (Slice 7+), re-invoking the
  port on that window would be a genuine duplicate mutation; the record-file
  reconcile (read the frozen record and append the event without re-dispatching)
  is the fix that lands with the adapter path and will be folded in here.
- New contract `cancellation-request/v1` (`ERL2-C-063`) and new refusal codes
  (`CANCELLATION_REQUESTED`, `CANCELLATION_BEFORE_ACCEPTANCE`,
  `CANCELLATION_AFTER_TERMINAL`, `POLICY_RUN_LEASE_HELD`) are append-only
  additions; generated types were regenerated and `verify:generated` is clean.

## Evidence

- `tests/e2e/replay.test.ts` — idempotent replay, no wedge, no fabricated
  adapter finding, stray subject command on a finalized run adds no evidence.
- `tests/e2e/cancellation.test.ts` — cancellation terminal, one record, no
  finding, verifies offline, terminal refusal.
- `tests/integration/runLease.test.ts` — concurrent refusal, stale recovery,
  foreign-release no-op, no leak.
- `tests/adversarial/postRevealExecution.test.ts` — pre-dispatch guard over every
  entrypoint state.
- `tests/e2e/crashRecovery.test.ts` — the crash/replay matrix (this ADR).
