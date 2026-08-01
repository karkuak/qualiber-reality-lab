# ADR-ERL2-028 — the journey prerequisite matrix, refusal atomicity, cancellation continuation, and a crash standard that injects a crash

- **Status:** accepted
- **Date:** 2026-07-29
- **Deciders:** Lab Architecture, Environment/Challenge Governor, Verification Audit
- **Supersedes:** nothing
- **Amends by record:** [ADR-ERL2-024](ADR-ERL2-024.md) §9 (crash and restart behaviour)
- **Builds on:** [ADR-ERL2-013](ADR-ERL2-013.md), [ADR-ERL2-018](ADR-ERL2-018.md),
  [ADR-ERL2-022](ADR-ERL2-022.md), [ADR-ERL2-023](ADR-ERL2-023.md),
  [ADR-ERL2-024](ADR-ERL2-024.md), [ADR-ERL2-026](ADR-ERL2-026.md),
  [ADR-ERL2-027](ADR-ERL2-027.md)
- **Findings closed:** review P1-2, P1-7, P1-9, P1-10
- **Normative revision:** `2.0.0-draft.11`

---

## 1. Context

Four findings from `Independent-Code-Review-Slice-6.5B.md`, and one important
piece of accounting: **two of the four were already substantially addressed by
ADR-ERL2-024, and two were not.** The audit is recorded here because "closed" was
not uniformly true, which is now the third time in this remediation sequence that
has been so.

| Finding | ADR-ERL2-024 left it | This ADR |
|---|---|---|
| **P1-7** dispatch before durable intent | **substantially closed** — the intent journal, the operation identities, the probe/adopt/fail-closed reconciliation and the ordering are all in place and correct | the *proof* was not to standard, and three defects were found by bringing it to standard: §8, §9, §5.2 |
| **P1-2** cancellation not branch-dispatched | **substantially closed** — `cancel` is branch-dispatched, the discriminator (the substrate binding) is the right one, and a live environment is meant never to receive `not_required` | the discriminator was read with `existsSync`, which fails open; and "resumed" was specified but not implemented: §6 |
| **P1-9** post-capture intents before activation | **not addressed** | §2 |
| **P1-10** a refused `journey` writes evidence | **not addressed** | §3 |

### 1.1 P1-9 — one gate, one state, one step

`EnvironmentRun.runStep` carried this:

```ts
if (state === "execution_plan_frozen" && !SETUP_INTENTS.has(step.intent)) throw …
```

The `execute-subject` phase departs from three states, and `step_outcome_frozen`
recurs after *every* step. The gate therefore fired on the journey's first step
and on no other. A run that had connected and discovered sat in
`step_outcome_frozen`; the next `erl2 execute-subject` ran the committed
`exercise` step, before the challenge was activated and before the evidence
cutoff existed. The run then finalized `valid` and verified offline, because
nothing downstream re-asked the question.

### 1.2 P1-10 — a resolution between two freezes

`journeyStart` resolved the cutoff policy at its freeze and the comparison policy
on the following line:

```ts
this.ws.store.freezeJson(`${RETAINED}/cutoff-policy.json`, this.cutoffPolicy(), …);
this.ws.store.freezeJson(`${RETAINED}/comparison-policy.json`, this.comparisonPolicy(), …);
```

`resolveAdmitted` throws `CFG_MISSING_REQUIRED` when a run has not bound the
policy and no flag names one. So `erl2 journey --cutoff-policy <hash>` with no
`--comparison-policy` froze `retained/environment/cutoff-policy.json` and then
refused. The retained byte was well-formed and correctly hashed; nothing about
its *content* was wrong. Only its existence was — and an artifact no lifecycle
event reached is what the closure derivation rejects as unaccounted, so the
refusal also broke the run's own terminal.

Separately, `openEnvironment` constructed `FileSubstrateStore` and
`ReservationAllocator` before any command logic ran, and both created their root
directory in their constructor. **Every** refused environment command therefore
left an empty `<run-root>.substrate` and `<run-root>.reservations` behind (review
P3).

### 1.3 P1-2 — the right discriminator, read the wrong way

ADR-ERL2-024 §4.4 chose the substrate binding as the discriminator, for a good
reason: `provision` freezes it *before* it dispatches, so a run that crashed
mid-provision has one. The dispatcher read it like this:

```ts
return existsSync(path.join(runRoot, "retained", "environment", "substrate-binding.json"));
```

`existsSync` answers **false** for a permission fault on the file or any parent
directory as readily as for a file that was never written. An ordinary `EACCES`
or `EIO` on a live environment run therefore routed the cancellation through the
pre-environment terminal and froze cleanup variant `none` / status
`not_required` while the environment and its reservation leases were still
allocated. That is review P1-2's exact symptom, reached with no flag — by the
same fail-open class ADR-ERL2-026 §2 had already removed from the substrate
reader and from the substrate's identity marker, left in place one layer up.
Deleting the binding artifact produced the same result and needed no fault.

ADR-ERL2-024 §4.4 also specified "during emergency cleanup → **emergency,
resumed**". Nothing implemented "resumed": `cancel` froze a fresh frontier with
`trigger: teardown_failure` for every emergency cancellation, so cancelling
during the emergency cleanup that followed a *restoration* failure produced
different bytes at an already-frozen logical path and raised
`ARTIFACT_ALREADY_FROZEN` — no terminal, leases retained.

### 1.4 P1-7 — a matrix that injected no crash

The mechanism is right. The proof was not. `mutationIntentCrashMatrix.test.ts`
injected a crash by **throwing an exception and continuing in the same process**:

1. a thrown error unwinds, so `finally` blocks run and the run lease is
   released. A killed process does none of that, and the difference is what a
   crash *is*;
2. the invocation counters lived in the memory of the process that was supposed
   to have died, so the measurement could only be taken in a way that made the
   crash fake;
3. the resumed composition was built in the surviving process.

The review said it plainly: "the published crash-resumability claim is unbacked:
the test cited as its evidence injects no crash".

---

## 2. Decision: one prerequisite matrix, over every canonical intent

`packages/core/src/journey/prerequisites.ts` holds a row per intent, keyed by the
frozen contract's own `JourneyIntent` union, so an intent that arrives without a
row **does not compile**.

### 2.1 Where the rows come from

Design v2 §12's state machine, not the intent names:

```
execution_plan_frozen      --> step_planned: install through connect
step_outcome_frozen        --> step_planned: next permitted step
step_outcome_frozen        --> challenge_activated: connected
adapter_translation_frozen --> step_planned: exercise through remove
```

| Intent | Branch | Departs from | Also requires |
|---|---|---|---|
| `acquire`, `verify_package` | pre-environment | — (refused as an environment step) | — |
| `install`, `configure`, `authenticate`, `connect` | environment | `execution_plan_frozen`, `step_outcome_frozen` | package, case, environment, baseline, plan |
| `discover` | environment | `step_outcome_frozen` | the above **+ a prior committed step** |
| `exercise`, `observe`, `diagnose_decide`, `upgrade` | environment | `adapter_translation_frozen`, `step_outcome_frozen` | the above **+ succeeded connection, activation, realized cutoff, observation bundle** |
| `recover`, `rollback`, `remove` | environment | as above | as above |

`discover` is in neither of the design's two ranges, so it departs from
`step_outcome_frozen` only: it follows a step and cannot open a journey.

### 2.2 Why post-capture intents depart from two states, and why that is the crux

`adapter_translation_frozen` is how the post-capture *sequence* is entered. Every
step after the first in that sequence departs from `step_outcome_frozen`, under
`step_outcome_frozen --> step_planned: next permitted step`. A journey committing
`exercise, observe, remove` departs from `adapter_translation_frozen` once and
from `step_outcome_frozen` twice.

So the departure state **cannot** be what separates a post-capture intent from a
pre-activation one: `step_outcome_frozen` is common to both, and it is exactly
the state the old gate did not cover. What separates them is whether the
activation receipt, the realized cutoff and the observation bundle are
**retained**.

This was not reasoned out in advance; it was found by running the gate. A first
implementation restricted post-capture intents to `adapter_translation_frozen`
alone, and the golden environment run failed at the second post-capture step with
`observe departs from adapter_translation_frozen; this run is in
step_outcome_frozen`. Recorded because the wrong version of this rule is
plausible and passes casual reading.

### 2.3 Every check is evidence-derived

Requiring departure from `adapter_translation_frozen` would already imply
activation and the cutoff, because the only path into that state runs through
both. It is still not what the matrix checks. A state is a summary; a retained
artifact is a fact. This is the discipline the review confirmed for phase
idempotence — "answered from evidence, never from state ordering" — and it is
what makes the prerequisite survive any future edge added to the transition
table.

- `challenge_activation` requires **both** the driver `mutation-receipt` and the
  controller's signed `challenge-activation-receipt` (ADR-ERL2-023 §2). A run
  holding only the first activated nothing anyone is accountable for.
- `evidence_cutoff` requires **both** `runtime-milestone` and a retained
  `source-snapshot`: the first is the cutoff's input, the second is an
  observation the cutoff actually stamped.

Reveal, terminal and cleanup prohibitions are deliberately **not** in the matrix.
`assertSubjectPortExecutable` already refuses every one of those states, before
the port is reached, for every intent. Restating them would create a second place
for the rule to drift.

### 2.4 Enforced at the library boundary

`assertJourneyPrerequisites` is called inside `EnvironmentRun.runStep`, before the
step request is built and long before the durable intent. A caller holding an
`EnvironmentRun` is held to the same matrix as one holding the binary. A CLI-only
fix would have left half of P1-9 open.

### 2.5 The edge that is recorded and not opened

Design v2 §12 permits `recover`, `rollback` and `remove` from
`pre_reveal_subject_cleanup_started`. That edge has never shipped. The rows carry
it in `designAlsoPermits`, the enabled `departsFrom` excludes it, and the refusal
says *"design v2 §12 permits `remove` from `pre_reveal_subject_cleanup_started`,
and that edge is not enabled"*. Recording a known-permitted-but-absent edge is
not the same as forbidding it, and a reader is entitled to the difference.

---

## 3. Decision: every refusable check precedes the first retained byte

A phase is restructured as: validate → **then** freeze → then append → then
settle. Concretely, for `journeyStart`:

1. departure state (`enter`);
2. **resolve both admitted policies** — the two resolutions that can throw;
3. assert the substrate binding;
4. resolve every required role;
5. build and validate every artifact;
6. *only now* freeze;
7. append;
8. return.

**A resolution that can throw must never sit between two freezes.** That is the
whole of the fix, and it is a rule about phase structure rather than about the
cutoff policy specifically.

Operational directories are created on **first write**, never in a constructor:
`ReservationAllocator.ensureRoot` runs in `acquire`, and
`FileSubstrateStore.ensureRoot` runs in `save` and `establishInstance`. Reads
already treat `ENOENT` as absence, so an unwritten substrate needs no directory
to be readable as empty.

Making those reads lazy required making them **narrow**, not merely tolerant.
`ReservationAllocator.leaseNames` treats `ENOENT` as "no leases" and raises
anything else: answering "this run holds nothing" for a permission fault would
release a live environment's identities to the next run, which is the fail-open
class ADR-ERL2-026 §2 exists to refuse.

### 3.1 What a refusal may leave

Nothing, with two named exceptions that are bounded by construction and excluded
from every closure derivation: the **run lease** (`state/lease.json`) and the
**derived snapshot** (`state/snapshot.json`). The proof is a byte manifest over
the run root and both operational siblings, including directory entries, taken
before and after the refused command.

---

## 4. Decision: cancellation is classified from durable evidence, and continues what it interrupts

### 4.1 The classifier

`classifyCancellationBranch` is shared by the CLI dispatcher and the library, so
the branch decision cannot disagree with itself. Two independent witnesses, and
`ENOENT` is the only condition that means "this run never had an environment":

1. the retained `substrate-binding` artifact, read with an errno-discriminating
   read — the witness that covers the crash-mid-provision window;
2. the run's own lifecycle events, which name the roles they produced — the
   witness that survives the binding artifact being removed.

Either is enough to reach the environment branch. Neither being readable for a
reason other than absence is a **typed refusal**, never an answer.

The two witnesses are deliberately not cross-checked against each other: a
disagreement is a reason to take the environment branch, not a reason to refuse,
because the environment branch is the one that enumerates a real frontier and can
therefore discover which witness was right.

### 4.2 Continuation

A cancellation that interrupts a cleanup **continues** it:

- the **frontier is adopted**, by role, when the run already froze one. It is an
  observation the run already made; re-observing it under a re-derived trigger was
  what produced the `ARTIFACT_ALREADY_FROZEN` wedge;
- the continuation appends **its own** `emergency_cleanup_resumed` event, under
  `op-emergency-cleanup-resume`. Re-appending `op-emergency-cleanup-start` is
  deduped by the lifecycle log to a no-op, and a no-op leaves the state where it
  was — so the terminal append that follows became an illegal transition and the
  cancelled run reached **no terminal at all**. Half-continuing is worse than
  restarting, and this is the half that was missing;
- the cleanup's **trigger is the frontier's own**. A continued cleanup must not
  relabel the failure it is cleaning up after;
- **completed driver actions are not re-dispatched.** They already were not: each
  emergency action runs under a durable intent whose probe is the driver's own
  operation log (ADR-ERL2-024 §4.3), so reconciliation adopts them. What needed
  fixing was the evidence around them, not the dispatch;
- a cancellation **may not cancel mandatory safety cleanup**, and a cancellation
  after a terminal returns that terminal idempotently.

### 4.3 Pending operations are reconciled before the substrate is touched

`reconcilePendingOperations` runs before any cleanup call and records what could
not be reconciled **in the hash-chained lifecycle**, as the detection event's
`failure` field, Lab-owned.

The intent journal is run-private by design (ADR-ERL2-024 §4.3) and an offline
reader never sees it, so an ambiguity recorded only there is an ambiguity
recorded nowhere. The operator's ask and a pending operation's unknown outcome are
two separate facts and both belong in evidence.

It reports three answers, not two:

- `declared` — proves nothing was dispatched (§5.1);
- a subject step with a frozen outcome — completed, whatever its intent marker
  says. A crash between the lifecycle append and the `settled` marker leaves an
  intent that *looks* pending over an operation that demonstrably finished, and
  reporting that as an ambiguity would fabricate one;
- anything else the driver's operation log cannot confirm — genuinely ambiguous.

No new contract. `CancellationRequestV1` is frozen and has no field for this; the
lifecycle event does, it is hash-chained, and it is public.

---

## 5. Decision: an ambiguous outcome reaches a terminal

### 5.1 `declared` is `not_dispatched_proven`

The journal writes `declared`, then advances to `dispatching`, and only then makes
the external call. An intent still at `declared` is therefore **positive evidence
that no call was issued** — not merely the absence of a receipt.

The previous implementation probed anyway, and that was wrong in both directions.
For an idempotent driver operation the probe answered `absent` and the dispatch
proceeded, so the outcome was right by luck. For a subject step the probe answers
`unknown` by construction, so the run failed closed to an invalid terminal over an
operation that had **demonstrably not happened**. An avoidable invalidation is not
the same virtue as refusing to double-install. "At most once because the Lab gave
up" is acceptable only when the ambiguity is real.

`before_external_dispatch` remains ambiguous, and the reason is stated rather than
smoothed over: the `dispatching` marker is made durable *before* the call, so the
evidence cannot separate "about to call" from "called and died". That boundary is
a **conservative refusal**, not a proof of a duplicate, and it is not counted as
an exactly-once win.

### 5.2 The terminal an ambiguous subject step reaches

`ENV_MUTATION_INTENT_AMBIGUOUS` propagated out of the CLI as an ordinary error.
The run refused correctly, never re-invoked the subject — and was then a durably
accepted run **with no reachable terminal**, which is the brief's own P1
definition. ADR-ERL2-024 §4.3 said "its authorized route is the invalid terminal";
nothing routed it there.

It now routes through `InvalidJourneyExecutionPhaseV1` — `kind:
"journey_execution"`, with `failed_intent` and `step_commitment_hash`. **That
member is already in the frozen contract** and was unreached by the environment
walk, so no contract changes.

- the falsified gate is `mandatory-graph-closed`: a step that was owed and never
  produced an outcome makes the step closure unclosable, since
  `deriveStepClosure` requires exactly one outcome per committed occurrence. It is
  deliberately not an intent-specific gate — the run does not know what the
  subject did, so it may not name a gate that implies it does;
- the classification is `lab_invalidity`, **not** `subject`. The Lab cannot
  establish what the subject did, and `lab_invalidity` is the honest owner of "I
  do not know". Converting ambiguity into subject attribution is the failure this
  route exists to avoid;
- a failed or unreconcilable **activation** routes to the `activation` phase,
  whose gate `environment-not-contaminated` is exactly what a failed or unknown
  activation falsifies.

---

## 6. Decision: a crash standard that injects a crash

This **amends ADR-ERL2-024 §9 by record**, on the precedent ADR-ERL2-020 §5 set:
that section's five in-process injection points and its instrumented-counter
method are superseded, not edited.

### 6.1 Eight boundaries

`CRASH_BOUNDARIES`, in the order a successful operation passes them:

| # | Boundary | Durable state on entry |
|---|---|---|
| 1 | `before_intent_freeze` | nothing exists for this operation |
| 2 | `after_intent_freeze` | intent `declared` |
| 3 | `before_external_dispatch` | intent `dispatching` |
| 4 | `after_external_dispatch` | intent `dispatching`, external effect applied |
| 5 | `before_receipt_freeze` | intent `dispatched`, nothing retained |
| 6 | `after_receipt_freeze` | receipt retained, no event names it |
| 7 | `before_lifecycle_append` | as 6 |
| 8 | `after_lifecycle_append` | event appended, intent not `settled` |

Boundaries 2 and 3 are **distinct durable states** here, because the journal
writes `declared` and then advances to `dispatching` — two separate
temp-then-rename writes. Boundaries 6 and 7 denote the same instant for an
operation that freezes exactly one artifact before its event; both are still
exercised and both must produce the same outcome, because a matrix that quietly
dropped one would not say which of the two it had checked.

### 6.2 The crash is a signal

`process.kill(process.pid, "SIGKILL")`, which cannot be caught, blocked or
ignored. Not `process.exit` (which runs exit handlers) and not a thrown error
(which unwinds through every `finally`). Every durable write in this codebase is
synchronous, so the bytes on disk at the barrier are exactly the bytes a real
crash at that instant would leave.

### 6.3 The count is a file

`--invocation-log` appends one record before **and** after each external call, so
the log distinguishes "entered" from "returned" and a crash inside the call is
visible as an unmatched `enter`. Counts are read by the parent process from the
file, because the process being measured is about to die.

Read-only driver operations are not counted. `completedOperation` in particular is
the *reconciliation probe*: counting it would make a correct
adopt-instead-of-redispatch look like a second call.

### 6.3a Targeting one operation

`--crash-at <boundary>` fires at the first operation to reach that boundary.
`--crash-at <boundary>@<operation-id-prefix>` fires only for a matching operation,
and it exists because some durable states sit *behind* an earlier operation's
boundary of the same name.

A cleanup interrupted after its frontier is frozen and before its terminal is one:
the failing `op-restore` passes `after_external_dispatch` first, so an unqualified
boundary can never reach the emergency actions behind it. The negative-control
campaign found this by way of `cleanup-continuation` killing nothing — the only
state the invariant guards was unreachable by the harness — and the case that
became reachable then found a live defect (§4.2's second paragraph).

### 6.4 The seam is injected, and development-only

Core reads no environment variable — `tests/architecture` enforces it — so the
barrier arrives as an optional callback from the CLI, which gates `--crash-at` and
`--invocation-log` behind the explicit development profile or
`CFG_DEVELOPMENT_FLAG_UNAVAILABLE`, exactly as it gates `--fake-driver-fault`. An
unknown boundary name is `CFG_MISSING_REQUIRED`: a flag accepted and ignored would
make every crash case a false pass.

---

## 7. Decision: a lease whose holder is gone is reclaimable

Found by the matrix, and only because the matrix injects `SIGKILL`.

A killed process leaves its run lease held for the full five-minute TTL. So the
very next process — the one that must reconcile the interrupted operation — was
refused `POLICY_RUN_LEASE_HELD` before it could read a single intent. Bounded
recovery that cannot start for five minutes is a **bounded wedge**.

`RunLease.acquire` now reclaims a foreign lease whose `pid` the kernel reports as
absent, in addition to one past its TTL. `kill(pid, 0)` sends no signal and only
asks about the pid: `ESRCH` is the one answer meaning "gone", `EPERM` means alive
under another user. Every ambiguity — including PID reuse — resolves to *alive*,
so this can only release a lease whose holder is absent and can never steal a live
one. A lease record with no usable pid is treated as alive, so an older record
does not become reclaimable merely for being old.

This also repaired a test that could not fail for its stated reason:
`RUN-LEASE: a mutating command is refused while a live foreign lease is present`
wrote `pid: 99999`, a pid nothing was running under, so it proved "a lease inside
its TTL is honoured" and said nothing about a live holder. It now uses the test
process's own pid, which is genuinely alive and genuinely foreign.

---

## 8. Contract and artifact impact

**No frozen schema changed shape or meaning. No new contract identity.** No field
repurposed, no optional field added to a frozen schema, no retained bytes
rewritten.

Three facts carry the load, and all three already existed:

| Need | Carried by | Already frozen? |
|---|---|---|
| an ambiguous subject step's terminal | `InvalidJourneyExecutionPhaseV1` | yes — present and unreached |
| a pending operation's unknown outcome at cancellation | the lifecycle event's `failure` field | yes |
| the crash seam and the invocation log | neither is evidence; both are development-only CLI inputs | n/a |

`EnvironmentRun.invalidate`'s `phase` parameter widens to accept a
journey-execution descriptor. That is a library signature, not a contract.

`gateForInvalidFailurePhase` is one function over both failing kinds so the
producer and the verifier cannot diverge on the new route. `cancellation` returns
`undefined`: a cancellation is an operator's decision, not the falsification of a
gate, and naming one would be the fabrication ADR-ERL2-027 §4.5 removed.

---

## 9. Rejected alternatives

1. **A new `PendingOperationReconciliationV1` contract.** Considered and
   rejected. The lifecycle event's `failure` field is hash-chained, public,
   already in every closure derivation, and already the place a Lab-owned failure
   is recorded. A new identity would have added a schema, a registry entry,
   generated types, a closure role and a verifier branch to say something an
   existing field says.
2. **Restricting post-capture intents to `adapter_translation_frozen`.**
   Implemented first, and wrong: it refuses the second post-capture step of any
   journey. §2.2.
3. **Gating the matrix in the CLI.** Leaves a caller driving `EnvironmentRun`
   directly unconstrained, which is half of P1-9.
4. **Keeping `existsSync` and adding a separate readability check.** Two reads of
   the same fact, with a window between them. One errno-discriminating read is the
   whole answer.
5. **Cross-checking the two cancellation witnesses and refusing on
   disagreement.** A run whose binding artifact was removed would then reach no
   terminal at all, which is worse than the defect. §4.1.
6. **Probing on a `declared` intent.** Fails closed over an operation that
   provably never ran. §5.1.
7. **Attributing an ambiguous subject step to the subject.** Fabricates an
   outcome the run explicitly does not have.
8. **Waiting out the lease TTL in the crash matrix.** Makes the suite unrunnable
   and leaves the real wedge in the product. Manipulating the lease from the test
   instead would be the test-only shortcut the brief forbids.
9. **`process.exit` at a crash boundary.** Runs exit handlers, so it is not a
   crash.
10. **Counting invocations in memory.** The witness dies with the process. This is
    the specific defect that made the previous matrix's exactly-once claim
    unfounded.

---

## 10. Consequences

**Gained.** Every canonical journey intent has an explicit, compiler-enforced
prerequisite row, enforced at the library boundary from retained evidence. A
refused command leaves the run byte-identical. Cancellation is classified from
durable evidence by a classifier shared with the library, continues an in-flight
cleanup, and records unreconciled operations in public evidence. An ambiguous
subject step reaches exactly one offline-verifiable invalid terminal instead of
stranding the run. Crash recovery is exercised across real process death with
counts that survive it, and works at all rather than after five minutes.

**Costs, stated.** The crash seam is two development-gated flags on the
environment command surface: new surface, refused on the release surface and
proven refused. `before_external_dispatch` fails a subject step closed over an
operation that did not run; that is inherent to having no subject-side probe
(ADR-ERL2-024 §4.3) and is labelled a conservative refusal, not exactly-once.
The lease liveness check is host-local by nature; a run root shared across hosts
would need a different owner identity, and the pid field already assumed
otherwise.

**Not claimed.** Crash safety beyond the two operations actually exercised — a
subject step and challenge activation. The eight boundaries are not run for
`provision`, `restore`, `destroy` or the emergency actions; those keep the
coverage ADR-ERL2-024 gave them. The claims ceiling is unchanged at **T1**: this
ADR removes false claims and adds no true ones.
