# Slice 6.5 lifecycle-ordering and crash-recovery remediation — P1-2, P1-7, P1-9, P1-10

Companion to [ADR-ERL2-028](../adr/ADR-ERL2-028.md). Successor to
[`remediation-6.5-cleanup.md`](remediation-6.5-cleanup.md), which settled the
cleanup discipline, which in turn succeeded
[`remediation-6.5-false-attestation.md`](remediation-6.5-false-attestation.md) and
[`remediation-6.5-invariants.md`](remediation-6.5-invariants.md).

Source of the defects: `Independent-Code-Review-Slice-6.5B.md`, 2026-07-28, at
`bd71a7f`, plus an audit of what ADR-ERL2-024's implementation actually delivered
for P1-2 and P1-7.

## 1. What was already closed, and what was not

This is the fourth package in the sequence and the third time the audit found
less than the previous ADR's own §14 claimed. Recorded because "closed" has not
been uniformly true.

| Finding | ADR-ERL2-024 left it | This package |
|---|---|---|
| **P1-7** dispatch before durable intent | **substantially closed.** The intent journal, the operation identity table, the probe/adopt/fail-closed reconciliation and the `declare → dispatch-marked → call → freeze → append → settle` ordering are all present and correct at both call sites | the *proof* was not to standard, and bringing it to standard found three defects: §4 |
| **P1-2** cancellation not branch-dispatched | **substantially closed.** `cancel` is branch-dispatched, the discriminator is the right one, and the intent that a live environment never receives `not_required` is real | the discriminator was read with `existsSync`, which fails open; and §4.4's "resumed" was specified and never implemented: §5 |
| **P1-9** post-capture intents before activation | **not addressed** | §2 |
| **P1-10** a refused `journey` writes evidence | **not addressed** | §3 |

## 2. P1-9 — one gate, one state, one step

```ts
if (state === "execution_plan_frozen" && !SETUP_INTENTS.has(step.intent)) throw …
```

`execute-subject` departs from three states and `step_outcome_frozen` recurs after
every step, so the gate fired on the journey's first step and on no other. A run
that had connected and discovered sat in `step_outcome_frozen`; the next
`erl2 execute-subject` ran the committed `exercise` step before activation and
before the evidence cutoff existed, then finalized `valid` and verified offline.

`packages/core/src/journey/prerequisites.ts` replaces it with a row per intent,
keyed by the frozen contract's own `JourneyIntent` union — so an intent that
arrives without a row does not compile. Fourteen rows, derived from design v2
§12's state machine rather than from the intent names. ADR-ERL2-028 §2 carries the
table.

Two things worth reading twice:

- **The departure state cannot be the gate.** A journey committing `exercise,
  observe, remove` departs from `adapter_translation_frozen` once and from
  `step_outcome_frozen` twice, under `step_outcome_frozen --> step_planned: next
  permitted step`. `step_outcome_frozen` is therefore common to post-capture and
  pre-activation steps alike, and it is exactly the state the old gate did not
  cover. What separates them is whether the activation receipt, the realized
  cutoff and the observation bundle are **retained**.
- **This was found by running the gate, not by reasoning.** The first
  implementation restricted post-capture intents to `adapter_translation_frozen`
  alone, and the golden environment run failed at the *second* post-capture step:
  `observe departs from adapter_translation_frozen; this run is in
  step_outcome_frozen`. The wrong version of this rule is plausible and survives
  casual reading, which is why it is written down.

Enforced inside `EnvironmentRun.runStep`, at the library boundary, so a caller
driving `EnvironmentRun` directly is held to the same matrix as one driving the
binary. A CLI-only fix would have left half of P1-9 open.

## 3. P1-10 — a resolution between two freezes

```ts
this.ws.store.freezeJson(`${RETAINED}/cutoff-policy.json`, this.cutoffPolicy(), …);
this.ws.store.freezeJson(`${RETAINED}/comparison-policy.json`, this.comparisonPolicy(), …);
```

`resolveAdmitted` throws when the run has bound no policy and no flag names one.
So `erl2 journey --cutoff-policy <hash>` with no `--comparison-policy` froze
`retained/environment/cutoff-policy.json` and *then* refused. The retained byte
was well-formed and correctly hashed — nothing about its content was wrong, only
its existence, and an artifact no lifecycle event reached is what the closure
derivation rejects as unaccounted. The refusal broke the run's own terminal.

Both policies are now resolved before the first freeze, along with the substrate
binding assertion. **The rule is about phase structure, not about the cutoff
policy: a resolution that can throw must never sit between two freezes.**

Separately, `openEnvironment` constructed `FileSubstrateStore` and
`ReservationAllocator` before any command logic ran, and both created their root
in their constructor — so *every* refused environment command left an empty
`<run-root>.substrate` and `<run-root>.reservations`. Both are now created on
first write.

Making those reads lazy required making them **narrow**.
`ReservationAllocator.leaseNames` treats `ENOENT` as "no leases" and raises
anything else: answering "this run holds nothing" for a permission fault would
hand a live environment's identities to the next run, which is the fail-open class
ADR-ERL2-026 §2 removed from the substrate reader. Laziness that reintroduced a
fail-open would have traded a hygiene defect for an integrity one.

## 4. P1-7 — the matrix that injected no crash

The mechanism was right. `mutationIntentCrashMatrix.test.ts` injected a crash by
**throwing an exception and continuing in the same process**, which cannot prove
crash recovery for three reasons: a thrown error unwinds, so `finally` blocks run
and the run lease is released; the invocation counters lived in the memory of the
process that was supposed to have died; and the resumed composition was built in
the surviving process. The review put it plainly — "the published
crash-resumability claim is unbacked: the test cited as its evidence injects no
crash".

`tests/e2e/crashBoundaryMatrix.test.ts` replaces the proof. Eight named
boundaries, `SIGKILL` at each, resume in a genuinely new process, and invocation
counts appended to a **file** before and after every external call so the count
survives the process that made it. The old suite is kept: it proves the
reconciliation logic, and it still does.

**Three defects were found by bringing the proof to standard, and none of them was
visible to the in-process matrix.**

### 4.1 A `declared` intent was probed instead of trusted

The journal writes `declared`, advances to `dispatching`, and only then calls out.
An intent still at `declared` is therefore positive evidence that no call was
issued. The code probed anyway. For an idempotent driver operation the probe
answered `absent` and the dispatch proceeded — right by luck. For a subject step
the probe answers `unknown` by construction, so the run failed closed to an
invalid terminal over an operation that had **demonstrably not happened**.

An avoidable invalidation is not the same virtue as refusing to double-install.
"At most once because the Lab gave up" is acceptable only when the ambiguity is
real.

### 4.2 The signed activation receipt was not byte-reproducible across a crash

Found by boundary `before_lifecycle_append`, the one window in which both
activation receipts are retained and no event names either.

`activated_at: this.now()`. The stepping clock is anchored to the run's latest
durable instant, which is stable — but the *number of reads before that point* is
not: the first pass dispatches `driver.mutate` and the resumed pass adopts the
stored receipt instead, so the two passes arrive at different ticks. Re-freezing
the receipt raised `ARTIFACT_ALREADY_FROZEN` (CLI exit 10) and the run reached no
terminal.

`activated_at` is now `receipt.ended_at` — the substrate's own account of when the
mutation landed, which is stable by construction because the adopted receipt is
byte-identical. The review had praised this reproducibility property for the
runtime milestone; it held there because that transition reads the clock the same
number of times on both passes.

### 4.3 A crashed run could not be recovered for five minutes

A killed process leaves its run lease held for the full `LEASE_TTL_MS`. So the
very next process — the one that must reconcile the interrupted operation — was
refused `POLICY_RUN_LEASE_HELD` before it could read a single intent. Bounded
recovery that cannot start for five minutes is a **bounded wedge**.

`RunLease.acquire` now also reclaims a lease whose `pid` the kernel reports absent.
`kill(pid, 0)` resolves every ambiguity — including PID reuse — to *alive*, so it
can only release a lease whose holder is gone and can never steal a live one.

This is the defect the exception-based matrix structurally could not find: a thrown
error unwinds through `release()`, so the stale-lease path was never on the tested
route.

**And it repaired a test that could not fail for its stated reason.**
`RUN-LEASE: a mutating command is refused while a live foreign lease is present`
wrote `pid: 99999` — a pid nothing was running under — so it proved "a lease inside
its TTL is honoured" and said nothing about a live holder. It now uses the test
process's own pid, which is genuinely alive and genuinely foreign. Same class as
the `shared_with_other_runs` mistake ADR-ERL2-027 §1.5 recorded: a fixture that
does not contain the condition its name claims.

### 4.4 An ambiguous subject step reached no terminal at all

`ENV_MUTATION_INTENT_AMBIGUOUS` propagated out of the CLI as an ordinary error.
The run refused correctly and never re-invoked the subject — and was then a
durably accepted run **with no reachable terminal**, which is the brief's own P1
definition. ADR-ERL2-024 §4.3 said "its authorized route is the invalid terminal";
nothing routed it there, and `step()` had no `routed(...)` wrapper at all.

It now reaches `InvalidJourneyExecutionPhaseV1` — **already in the frozen
contract, and until now unreached by the environment walk**, so no contract
changed. The falsified gate is `mandatory-graph-closed` (a step owed and never
outcome-frozen makes the step closure unclosable) and the classification is
`lab_invalidity`, not `subject`: the Lab cannot establish what the subject did,
and converting ambiguity into subject attribution is the failure this route exists
to avoid.

## 5. P1-2 — the right discriminator, read the wrong way

```ts
return existsSync(path.join(runRoot, "retained", "environment", "substrate-binding.json"));
```

`existsSync` answers **false** for a permission fault on the file or any parent
directory as readily as for a file that was never written. An `EACCES` or `EIO` on
a live environment run therefore routed the cancellation through the
pre-environment terminal and froze cleanup variant `none` / status `not_required`
while the environment and its reservation leases were still allocated — review
P1-2's exact symptom, reached with no flag. Deleting the binding artifact did the
same and needed no fault at all.

`classifyCancellationBranch` replaces it, shared by the CLI dispatcher and the
library so the decision cannot disagree with itself. Two independent witnesses —
the retained binding read with an errno-discriminating read, and the lifecycle's
own produced roles — and `ENOENT` is the only condition that means "no
environment". Anything else is a typed refusal.

The witnesses are deliberately **not** cross-checked against each other. A
disagreement is a reason to take the environment branch, not to refuse: the
environment branch is the one that enumerates a real frontier and can therefore
discover which witness was right. Refusing would leave a run whose binding
artifact was removed with no terminal at all, which is worse than the defect.

### 5.1 "Resumed" was specified and never implemented

ADR-ERL2-024 §4.4 said "during emergency cleanup → **emergency, resumed**".
`cancel` froze a fresh frontier with `trigger: teardown_failure` for every
emergency cancellation. So cancelling during the emergency cleanup that followed a
*restoration* failure produced different bytes at an already-frozen logical path,
raised `ARTIFACT_ALREADY_FROZEN`, and left no terminal with the leases still held.

Now: the frontier is **adopted** by role when one exists, and the cleanup's
trigger is the frontier's own — a continued cleanup must not relabel the failure
it is cleaning up after. Completed driver actions were already not re-dispatched
(each runs under a durable intent whose probe is the driver's operation log), so
what needed fixing was the evidence around them, not the dispatch.

### 5.2 A pending operation's ambiguity is now public

`reconcilePendingOperations` runs before any cleanup call and records what could
not be reconciled in the **hash-chained lifecycle**, as the detection event's
`failure` field, Lab-owned.

The intent journal is run-private by design and an offline reader never sees it,
so an ambiguity recorded only there is an ambiguity recorded nowhere. No new
contract: `CancellationRequestV1` is frozen and has no field for this, and the
lifecycle event has one that is already public and already hash-chained.

It reports three answers rather than two, and the third one matters: a subject-step
intent whose outcome is already frozen is **complete**, whatever its marker says. A
crash between the append and the settle leaves an intent that looks pending over an
operation that demonstrably finished, and reporting that as an ambiguity would
fabricate one.

## 6. Contracts

**No frozen schema changed shape or meaning. No new contract identity.** No field
repurposed, no optional field added to a frozen schema, no retained bytes
rewritten. This is the first package in the sequence to add no identity at all.

Three facts carry the load and all three already existed:

| Need | Carried by |
|---|---|
| an ambiguous subject step's terminal | `InvalidJourneyExecutionPhaseV1` — present in the frozen contract, previously unreached |
| a pending operation's unknown outcome at cancellation | the lifecycle event's `failure` field |
| the crash seam and the invocation log | neither is evidence; both are development-only CLI inputs |

`EnvironmentRun.invalidate`'s `phase` parameter widens to accept a
journey-execution descriptor. That is a library signature, not a contract.

## 7. Goldens

**No golden changed, and the byte pin is unchanged at 787 pinned / 7 excluded.**

That was not the expectation going in. `activated_at` moves from the Lab's clock
read to the driver receipt's `ended_at` (§4.2), so the environment run's
`activation-receipt.json` does contain different bytes than it would have — but
the environment-run golden's bytes are **deliberately unpinned**, for the
cryptographic reason the independent review recorded (a CSPRNG in
`sealThresholdEnvelope`), so the change reaches no pinned artifact.

Stated plainly because the opposite mistake is the dangerous one: a package that
expected a golden to move and found it had not could conclude its change never
took effect. It did — `tests/e2e/crashBoundaryMatrix.test.ts` proves it at boundary
`before_lifecycle_append`, which failed with `ARTIFACT_ALREADY_FROZEN` before the
change and passes after it. The pin is simply not where that evidence lives.

`EXPECTED_PINNED` is untouched at 787. The pin did not narrow.

## 8. Verifier

Two additions, both derived from the hash-chained event order alone:

- `assertJourneyOrderingFromLifecycle` refuses a post-capture `*_planned` event
  occurring before `challenge_activated` or before `evidence_cutoff_realized`,
  on both the valid and the invalid environment paths. Without it a bundle
  produced by an older or patched Lab still verified `valid`, which is what P1-9's
  reproduction did.
- `assertInvalidFindingAttribution` now covers the `journey_execution` failed-phase
  kind instead of returning early on it, through the shared
  `gateForInvalidFailurePhase`. That is precisely the terminal on which a producer
  might blame the subject for an outcome nobody observed.

The post-capture event prefixes are held in the verifier rather than imported from
core, for the reason every other derivation in that file is: the verifier must not
share the producer's decision about what a post-capture intent *is*.

## 9. Tests

| Suite | Cases | What it proves |
|---|---|---|
| `tests/integration/journeyPrerequisites.test.ts` | 10 | the matrix over all fourteen intents, pure; both-directions completeness; every state × intent refusal; each prerequisite withheld in turn (100+ combinations); the P1-9 state itself |
| `tests/adversarial/lifecycleOrdering.test.ts` | 11 | the P1-10 reproduction with a byte manifest; six representative refusal causes; no operational directory on refusal; nothing written after a terminal; P1-9 through the binary; cancellation from six live states; the deleted-binding and unreadable-binding branches; emergency continuation; replay |
| `tests/e2e/crashBoundaryMatrix.test.ts` | 20 | eight boundaries × two operations in fresh processes, `SIGKILL`, durable invocation counts, terminal counts, and the seam's own development gate |
| `tests/integration/runLease.test.ts` | +2 | a dead holder's lease is reclaimable; a pid-less lease is still honoured |

The byte manifest records **directory entries as well as files**, because the
defect it also closes is the creation of an empty directory — a manifest of files
alone would have called that clean.

## 10. Exactly-once, stated in three separate categories

Not combined, because they are not the same claim.

### Invocation-level exactly once

External invocation count measured at **one** across both processes, at every one
of the eight boundaries:

- **challenge activation** (`op-activate`). It has a probe — the driver's own
  operation log — so a resumed process adopts the prior receipt rather than
  re-applying the mutation.

### Evidence-backed idempotent reconciliation

None in this package. The activation path never reaches a second transport
invocation, so it is not described this way.

### Fail-closed ambiguous outcome

**Subject step** (`op-step-<n>`), at five of eight boundaries:
`before_external_dispatch`, `after_external_dispatch`, `before_receipt_freeze`,
`after_receipt_freeze`, `before_lifecycle_append`. No second invocation, the
ambiguity is retained, and the run reaches exactly one invalid terminal with
`failed_phase.kind = "journey_execution"`.

At the other three boundaries the evidence is decisive and the step is
invocation-level exactly once: `before_intent_freeze` (nothing declared),
`after_intent_freeze` (the intent proves nothing was dispatched, §4.1), and
`after_lifecycle_append` (the outcome is already frozen).

**One of the five is a conservative refusal and is not counted as a win.** At
`before_external_dispatch` the subject was *not* called, and the run still fails
closed, because the `dispatching` marker is durable before the call and the
evidence cannot separate "about to call" from "called and died". Inherent to
having no subject-side probe (ADR-ERL2-024 §4.3), and stated rather than smoothed
over.

## 11. Negative controls

Ten new controls, 47 in total. §16 of the brief names ten invariants; these are
they.

| Control | Guard disabled |
|---|---|
| `journey-prerequisite-matrix` | per-occurrence prerequisite enforcement |
| `post-capture-activation-requirement` | the three facts that make an intent post-capture |
| `prerequisite-evidence-derivation` | prerequisites answered from evidence rather than state |
| `refusal-before-cutoff-freeze` | both policies resolved before the first freeze |
| `lazy-operational-directories` | the eager mkdir in the allocator constructor |
| `cancellation-branch-classification` | the errno-discriminating read and the lifecycle witness |
| `cleanup-continuation` | frontier adoption on a continued cleanup |
| `not-dispatched-proven` | `declared` as proof nothing was dispatched |
| `crash-lease-reclamation` | owner-liveness lease reclamation |
| `invocation-count-not-dedup` | **reconciliation entirely, leaving every deduplication intact** |

The last one is the control this package exists to run. It removes reconciliation
so every unsettled operation is re-dispatched, while leaving the artifact store's
duplicate refusal, the lifecycle log's `operation_id` dedupe and the driver's own
operation log completely intact. A suite that asserted "exactly one retained
receipt" therefore still passes. The invocation-count assertions must fail anyway,
because the external port really was entered twice. **If that control kills
nothing, the matrix is counting artifacts and the exactly-once claim above is
unfounded.**

Results are recorded in §12.

## 12. Campaign results

Measured against a **disposable clone** whose `HEAD` carries the candidate state:
the harness checks a worktree out at `HEAD` and refuses a dirty tree, and at the time
these were measured this package was not yet authorized to commit. Same methodology
`remediation-6.5-false-attestation.md` §6 established and then validated by
re-running all ten of its controls in-repo with identical counts. The live tree was
never patched, and the harness confirmed it byte-identical afterwards.

The package is now committed as a checkpoint on `slice-6.5-cleanup-remediation`, so
`HEAD` carries the measured source directly and a re-run needs no clone.

| Control | Result | Expected |
|---|---|---|
| `journey-prerequisite-matrix` | 22 pass / **1 fail** | fail ✔ |
| `post-capture-activation-requirement` | 7 pass / **3 fail** | fail ✔ |
| `prerequisite-evidence-derivation` | 18 pass / **3 fail** | fail ✔ |
| `refusal-before-cutoff-freeze` | 5 pass / **6 fail** | fail ✔ |
| `lazy-operational-directories` | 11 pass / **1 fail** | fail ✔ (see below) |
| `cancellation-branch-classification` | 9 pass / **2 fail** | fail ✔ |
| `cleanup-continuation` | 11 pass / **1 fail** | fail ✔ (see below) |
| `not-dispatched-proven` | 19 pass / **1 fail** | fail ✔ |
| `crash-lease-reclamation` | 9 pass / **18 fail** | fail ✔ |
| `invocation-count-not-dedup` | 11 pass / **9 fail** | fail ✔ (see below) |

**All ten are load-bearing.** Three were not on the first run, and none of the
three was re-scored to `expect: "pass"`.

### The one that matters

`invocation-count-not-dedup` kills **9 of the 20 crash-matrix cases** with every
deduplication left intact — the artifact store's duplicate refusal, the lifecycle
log's `operation_id` dedupe, and the driver's own operation log. Those nine cases
fail because the external port really was entered twice, and nothing else in the
system was in a position to notice. That is the measurement that makes the
exactly-once claim in §10 mean anything: it is counting invocations, not artifacts.

### The three that disagreed first, and what each turned out to mean

Recorded in full, because this is what the campaign is for.

| Disagreement | Cause | Fix |
|---|---|---|
| `lazy-operational-directories` — killed nothing | the test ran `baseline` with no `--archetype`, so it refused inside `resolveAdmitted` — *before* the driver and allocator are constructed. The case never reached the code the control patches, and would have passed whether the directories were created eagerly or not | the test now passes `--archetype` so the refusal comes from the phase-state check, which is after both constructors, and asserts the refusal code is `POLICY_CONFLICT` so it cannot silently drift back |
| `cleanup-continuation` — killed nothing | the test cancelled a run that had already *finished* its emergency cleanup and reached its terminal, so `cancel` returned the existing record idempotently and never reached the frontier code at all. The state the invariant guards — a frozen frontier with no terminal — is only reachable by a crash *inside* the cleanup, which the seam could not target | the crash seam gained `--crash-at <boundary>@<operation-id-prefix>`, because the failing `op-restore` passes `after_external_dispatch` first and an unqualified boundary can never reach the emergency actions behind it. **The new case then found a real defect**: cancelling an interrupted cleanup reached *zero* terminals, because re-appending `op-emergency-cleanup-start` is deduped to a no-op, the state never advances, and the terminal append becomes an illegal transition. A continuation now appends its own `emergency_cleanup_resumed` event |
| `invocation-count-not-dedup` — **BUILD FAILED** | the control replaced the whole `if (...)` condition with `false`, which removed the `existing !== undefined` narrowing, so the block below stopped compiling under `strictNullChecks` — the same narrowing trap that broke two controls in the 6.5-B campaign | the control now disables only the condition's middle clause, keeping every identifier used and every type narrowed while still making the condition unsatisfiable |

Two of those three were **tests that were not isolating a genuinely load-bearing
invariant**, which is the distinction `remediation-6.5-invariants.md` §8 drew and
the reason a control that kills nothing is never simply re-scored. The third was a
defect in the control itself. And the second one is the more valuable outcome: the
campaign did not merely repair a test, it exposed a live path on which a cancelled
run reached no terminal.

The remaining 37 controls were not re-run by this package. They were last measured
in full at `remediation-6.5-false-attestation.md` §6 (28 of 30 load-bearing) plus
the seven in `remediation-6.5-cleanup.md` §9, and nothing in this package changes
the invariants they isolate. Re-running the full 47 in the repository is the first
thing to do once this branch is committed.

## 13. What is still open

This package closes four findings. It does **not** remediate the whole review.

Still open and not claimed:

- The P2 cluster beyond what the previous three packages closed: `mounted_file`
  scanned with metadata that cannot contain the mounted content; `lab_telemetry`
  with no negative control; secret canaries and forbidden identifiers unscanned on
  the environment subject-output surface; the declared subject-output size limit
  hashed but unenforced; the evidence cutoff never re-derived offline; retained
  subject-output payloads unaccounted in the verifier; the signer inventory's
  `complete_for_terminal_chain` omitting members whose authority field is not
  literally named `signature`.
- The remaining P3 documentation drift, less the two items §3 closes (the
  operational-directory residue, and the "a refusal writes no evidence" overclaim).
- ERL2-OQ-005, ERL2-OQ-007 and ERL2-OQ-008 — unchanged, still fail-closed.
- Crash coverage for `provision`, `restore`, `destroy` and the emergency actions.
  They keep the coverage ADR-ERL2-024 gave them; the eight boundaries are not run
  for them, and no claim is made that they are.

**The claims ceiling is unchanged: T1.** This package removes false claims — a
crash-resumability claim that injected no crash, and a "refusal writes no
evidence" claim that was untrue for the environment commands — and adds no true
ones.

**The branch is not merge-ready.** Remaining independent-review findings must be
closed and the branch re-reviewed independently.
