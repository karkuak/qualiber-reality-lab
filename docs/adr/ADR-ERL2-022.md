# ADR-ERL2-022 — the environment terminal, the invalid environment terminal, and what "canary-scanned" is allowed to mean

**Status:** accepted
**Date:** 2026-07-28
**Deciders:** Lab Core Owner, Integrity/Security Owner, Environment/Challenge Governor, Verifier Reviewer
**Extends:** ADR-ERL2-021 (environment signer roles and the durable phase model).
Nothing is superseded.
**Normative source:** `external-reality-lab-design-v2.md` `2.0.0-draft.11` §10, §12,
§13, §14 steps 6-7, §16.3, §20; Slice 6.5 brief §6, §15.4.

## Context

Slice 6.5-B stopped at `generic_evaluation_index_frozen`. Three things were left
open and each one was a hole rather than a rough edge:

1. **`verifyEnvironmentBundle` was dead code.** Making it `throw` unconditionally
   left the whole suite green, because no run ever produced an environment
   bundle. The three §15.4 mutations that need an environment terminal were
   unreachable for the same reason.
2. **An environment run had no invalid terminal.** A partial provision, a failed
   restoration and a failed teardown each raised a typed refusal that *named* the
   authorized route without taking it, so a durably accepted run could stop
   without an `InvalidLabRunRecordV1` — which ERL2-FR-001 forbids.
3. **`LIVE_ORACLE_SCAN_SURFACES` still claimed one surface.** That was honest in
   6.5-B and became wrong the moment the environment walk started producing the
   others.

## Decision

### 1. The environment terminal is one command, in the design's order

`finalize-generic` on an environment run freezes validity, the generic index, the
run record, a timestamp checkpoint, the signer inventory, the final attestation
and the public bundle — in that order, in one process.

Nothing above `assertEnvironmentFinalizable` carries a finalizer attestation, and
nothing below it runs if a check fails: validity, closure, restoration, teardown,
residue, exposure, trust and timestamps are all checked before a signature
exists. A bundle that would fail offline verification is refused here instead of
being published.

The closure the finalizer checks is derived by the **offline verifier's own**
algorithm, injected as `deriveClosure`. A producer deriving its own closure would
only be agreeing with itself.

### 1a. The signer inventory is built before the closure and frozen after it

`deriveEnvironmentPreFinalizationClosure` accounts for the candidate run record
and the roles the lifecycle has produced. A signer inventory already sitting in
`retained/` with no lifecycle role yet is an unaccounted artifact, so freezing it
first made finalization refuse its own working file. It is built in memory,
the closure is derived, the gate runs, and only then is it frozen.

### 1b. The bundle references the selection receipt where it already is

A first draft republished the selection verification receipt under a second
retained path so the bundle could name it. Two retained files sharing one core
hash is a `GRAPH_CLOSURE_EXTRA_ARTIFACT` refusal, and that rule is load-bearing:
a signature field is excluded from the core hash, so a forged file at the
canonical path plus a pristine byte-copy under a later-sorting name is exactly
the attack ADR-ERL2-019 §1 closes. The bundle names the path the selection walk
already froze.

### 1c. An environment bundle needs the verifier's pinned beacon

A pre-environment bundle carries no selection chain, so an empty
`randomnessSources` in the verifier's `--root-config` is sufficient. An
environment bundle carries the selection verification receipt as a **mandatory**
member, so the verifier must hold the beacon's pinned registry entry — and
Appendix C requires that entry to be the same authoritative state selection's
`--source-trust-config` resolved. A verifier without it refuses with
`RANDOMNESS_SOURCE_NOT_PINNED`, which is the fail-closed answer, not a
configuration inconvenience.

### 2. The invalid environment terminal derives cleanup from the actual frontier

`EnvironmentRun.invalidate` routes a Lab-owned environment failure through
`invalid_failure_detected → invalid_environment_cleanup_started → …
→ invalid_lab_run_record_frozen → invalidated`, freezing exactly one
`InvalidLabRunRecordV1`.

The frontier is what the driver **observes**; the action set is derived from it
here, never supplied by the driver. A broken or hostile driver cannot talk the Lab
into deleting something it does not own, nor into skipping an action that is
independently safe.

**The detection event is named for the phase that failed**
(`environment_restoration_failed`), not for the state it lands in. The state is
`invalid_failure_detected` for every one of them, and an event stream that only
said that would not say what failed.

### 2a. Emergency is which failure happened, not how bad it was

Design §12: a restoration or teardown failure MUST enter receipt-backed emergency
cleanup. There is no direct edge from either to the invalid record. So `emergency`
is not a caller's severity judgement — it is determined by the phase.

The fake driver's destruction granularity is the whole environment, so one
destroy receipt covers every safe action it attempted, and each action's success
is derived from **re-inspecting the substrate afterwards** rather than from what
destroy claimed. A driver with per-resource destruction would produce one receipt
per action; the contract permits both, and what it refuses — a safe action with no
attempt, an attempt with no receipt, a failure with no reason, an unsafe skip
carrying a receipt — is enforced by `buildEmergencyCleanup` either way.

### 2b. Reservations are released at every terminal, valid or invalid

A failed run that kept its network, volume, port and project reservations would
deny them to every later run. They are released once the substrate is provably
empty on the valid path, and at the invalid terminal on the failing one.

### 2c. Mirrored admission inputs are recorded as produced

The archetype, driver manifest, cutoff policy and comparison policy are mirrored
into the run so an offline reader can re-derive the baseline and the cutoff. They
are now also recorded as *produced* roles, because the invalid-record closure
counts a retained byte the lifecycle never reached as an unaccounted artifact —
four of them, precisely.

### 3. `--fake-driver-fault` is a development-only shortcut, gated like the others

The emergency branch cannot be reached without a substrate failure, and a
substrate failure is not something a test can arrange on a real substrate. The
flag steers a failpoint of the *fake* driver, is refused unless
`ERL2_DEVELOPMENT_FAKE_SUBJECT=1` is set, and is unreachable on the release
surface — the same posture as `--fake-acquire`.

### 4. Three more oracle surfaces go live, and only three

`LIVE_ORACLE_SCAN_SURFACES` becomes `adapter_request`, `lab_telemetry`,
`mounted_file`, `subject_output_prefill`, because the environment walk now
produces all four.

The remaining four stay pending **and stay named individually**:
`environment_variable` and `process_argument` are set by the Slice 5 adapter host,
not by the environment walk; `diagnostics` needs a subject that emits them and the
development fake port emits none; `network_egress` needs a run that egresses and
no shipped path does. Wiring a scan to a surface no run produces would be a scan
of nothing, reported as coverage — the exact dishonesty the live/pending split
exists to prevent.

### 4a. The subject's output bytes are retained, and the scan reads them

The environment step runner discarded `response.outputBytes`. That meant the only
thing in a step outcome the *subject* wrote was thrown away: the outcome recorded
that a step happened, not what it produced — and there was no subject output to
scan, evaluate or attribute.

The bytes are now frozen and referenced from the outcome, and the
`subject_output_prefill` scan reads **the bytes**, not only the outcome metadata.
A canary that reached the subject's output appears in neither the manifest nor the
outcome JSON; only in what the subject actually wrote.

The scan runs **before anything freezes**, so a leak invalidates the run rather
than travelling into the terminal, and the refusal itself writes no subject
output. Scanning after the copies were published would have been a scan of bytes
already on disk: a report, not a gate.

### 5. A restoration is failed if the driver says so, independently of drift

`buildEnvironmentRestoration` derives `passed` from the before/after baselines and
the residual set. That is right for drift and blind to a compensation that simply
did not run: a driver reporting `status: "failed"` while leaving the environment
measuring identically produced `passed: true` over mutations it never reverted.
The receipt's own status is now checked first, and separately.

## Consequences

- `verifyEnvironmentBundle` is live. Making it `throw` now fails two cases, which
  was measured rather than assumed.
- The three §15.4 mutations that needed an environment terminal are covered, each
  asserting a specific code, each applied to a **caller-supplied** document
  (`--public-bundle`, `--root-config`) rather than to the retained tree — a
  mutation inside `retained/` moves the artifact's core hash and is refused by the
  derivation layer before the rule under test is reached.
- A mutated bundle must be given a *consistent* identity to test a member rule at
  all; otherwise the refusal is `ARTIFACT_HASH_MISMATCH` and the case would pass
  with no member rule in place. Both variants are asserted.
- The caller-supplied bundle is written **outside** the run root. Left inside, the
  artifact index found two `public-verification-bundle/v2` artifacts and every
  case refused for that reason instead of for the mutation under test.
- ERL2-OQ-005, ERL2-OQ-007 and ERL2-OQ-008 are unchanged and still fail-closed.

## Evidence

- `tests/e2e/environmentRun.test.ts` — the full path to `generic_finalized`;
  offline verification of the environment bundle (`valid`, variant `environment`,
  no missing roles, no rejected extras); a verifier without the pinned beacon
  refusing; a canary in the subject's output bytes refusing before the freeze,
  with a byte manifest showing zero output written.
- `tests/adversarial/environmentTerminalMutations.test.ts` — the three §15.4
  mutations plus a baseline and a member-substitution case.
- `tests/e2e/environmentInvalidTerminal.test.ts` — restoration and teardown
  failures taking the emergency route in the asserted event order; every safe
  action attempted and receipted, every unsafe skip reasoned and receiptless; a
  contaminated baseline classified Lab-owned; no attestation or bundle descending
  from an invalid record; reservations released; the invalid record verifying
  through `erl2 verify-record`; `--fake-driver-fault` refused on the release
  surface.
- `docs/ledger/remediation-6.5B.md` §2 — negative controls, including the ones
  that did not fail.
