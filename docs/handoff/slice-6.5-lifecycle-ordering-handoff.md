# Handoff — Slice 6.5 lifecycle-ordering and crash-recovery remediation

Companion to [ADR-ERL2-028](../adr/ADR-ERL2-028.md) and
[`remediation-6.5-lifecycle-ordering.md`](../ledger/remediation-6.5-lifecycle-ordering.md).
Successor to [`slice-6.5-cleanup-handoff.md`](slice-6.5-cleanup-handoff.md).

## 1. State

Findings **P1-2**, **P1-7**, **P1-9** and **P1-10** from
`Independent-Code-Review-Slice-6.5B.md` are closed.

This does **not** remediate the whole review. The P2 cluster and the remaining P3
drift are open and listed in §8.

**Two of the four were already substantially addressed by ADR-ERL2-024**, and the
audit that established what was and was not actually delivered is
`remediation-6.5-lifecycle-ordering.md` §1. This is the third time in this
sequence that a previous ADR's own §14 claimed more than its implementation
delivered, so the audit came before any code.

## 2. What changed

| Concern | Before | Now |
|---|---|---|
| journey intent gating | one gate on one state (`execution_plan_frozen`), so it fired on the journey's first step and no other | a row per canonical intent, keyed by the frozen contract's intent union, enforced at the library boundary from retained evidence |
| a post-capture step pre-activation | ran, finalized `valid`, verified offline | refused, naming its unmet prerequisites; the verifier re-derives the same ordering from the event chain |
| a refused `journey` | froze `cutoff-policy.json` and *then* refused | resolves every refusable input before the first freeze; byte manifest identical |
| a refused environment command | created `<run-root>.substrate` and `.reservations` | creates neither; both roots are made on first write, with `ENOENT`-narrow reads |
| `cancel` branch dispatch | `existsSync` on one file — false for `EACCES` as readily as for absence | two witnesses, `ENOENT` the only absence, anything else a typed refusal, classifier shared with the library |
| cancel during emergency cleanup | froze a second frontier under a relabelled trigger → `ARTIFACT_ALREADY_FROZEN`, no terminal, leases held | adopts the frozen frontier and keeps its trigger |
| a pending operation at cancellation | invisible (the intent journal is run-private) | recorded in the hash-chained lifecycle as a Lab-owned failure |
| an ambiguous subject step | refused correctly and reached **no terminal** | reaches one invalid terminal, `failed_phase.kind = "journey_execution"`, owned by the Lab |
| a `declared` intent | probed, so a subject step failed closed over an operation that provably never ran | `not_dispatched_proven`: resumed under the same key |
| the signed activation receipt | `activated_at: this.now()` — not byte-reproducible across a crash | `receipt.ended_at`, stable by construction |
| a crashed run's lease | held for the full 5-minute TTL, so recovery could not start | reclaimed when the kernel reports the holder absent |
| the crash matrix | threw an exception, continued in-process, counted in memory | `SIGKILL`, resumes in a new process, counts from a file |

## 3. Contracts

**No frozen schema changed shape or meaning, and no new contract identity was
added.** The first package in this sequence to add none.

Three facts carry the load and all three already existed: an ambiguous step's
terminal uses `InvalidJourneyExecutionPhaseV1` (present in the frozen contract,
previously unreached by the environment walk); a pending operation's unknown
outcome uses the lifecycle event's `failure` field; and the crash seam and
invocation log are development-only CLI inputs, not evidence.

`EnvironmentRun.invalidate`'s `phase` parameter widens to accept a
journey-execution descriptor. That is a library signature, not a contract.

## 4. Goldens and the byte pin

**Nothing moved.** `evidence:verify OK — pinned 787 files, excluded 7`, unchanged
from the baseline.

`activated_at` does change (§2), but the environment-run golden's bytes are
deliberately unpinned for the cryptographic reason the review recorded, so the
change reaches no pinned artifact. That the pin did not move is *not* evidence the
change had no effect — the crash matrix's `before_lifecycle_append` case failed
with `ARTIFACT_ALREADY_FROZEN` before it and passes after it.

## 5. Verify it yourself

```bash
npm run build && npm run typecheck && npm run verify:generated
npm test
npm run purity
npm run evidence:verify
```

Expect **719 tests / 719 pass / 0 fail**, purity **24/24**, and
`evidence:verify OK — pinned 787 files, excluded 7`. The baseline was 675 tests, so
44 cases are new.

The behavioural claims, individually:

```bash
node --test tests/dist/integration/journeyPrerequisites.test.js
node --test tests/dist/adversarial/lifecycleOrdering.test.js
node --test tests/dist/e2e/crashBoundaryMatrix.test.js
node --test tests/dist/integration/runLease.test.js
```

The crash matrix takes ~4 minutes: every case drives a full CLI walk and then
kills a real process.

## 6. Hazards to carry forward

- **Do not rebuild while a suite is running.** Three separate runs of the new
  suites reported failures that were entirely artefacts of a concurrent
  `npm run build` replacing `dist` mid-run — `NON_JSON_OUTPUT` with a
  `SyntaxError: The requested module '@erl2/core' does not provide an export`
  inside it. Every one of them was collateral, and each cost a full re-run to
  establish that. If a suite fails with `NON_JSON_OUTPUT`, check for a concurrent
  build before believing it.
- **`before_external_dispatch` fails a subject step closed over an operation that
  did not run.** The `dispatching` marker is durable before the call, so the
  evidence cannot separate "about to call" from "called and died". This is
  inherent to having no subject-side probe (ADR-ERL2-024 §4.3). It is labelled a
  *conservative refusal* and is deliberately not counted as an exactly-once win.
  Narrowing it needs a subject protocol change, not a Lab change.
- **The lease liveness check is host-local by nature.** A run root shared across
  hosts would need an owner identity that is not a bare pid. The `pid` field
  already assumed otherwise, so this does not narrow anything, but it is now
  load-bearing.
- **Boundaries 6 and 7 coincide for a single-artifact operation.** Both are
  exercised and both must produce the same outcome; the matrix does not pretend
  they are separate durable states where they are not. For activation, which
  freezes two artifacts, they *are* separate — and that is the pair that caught the
  unreproducible receipt.
- **The crash matrix covers two operations only.** A subject step and challenge
  activation. `provision`, `restore`, `destroy` and the emergency actions keep the
  in-process coverage ADR-ERL2-024 gave them. Extending the eight boundaries to
  them is mechanical and is not done.
- **A control that kills nothing usually means the test is not isolating the
  invariant.** Three of the ten disagreed on the first run. Two were tests that
  never reached the patched code — one refused too early in `openEnvironment`, one
  cancelled a run that had already reached its terminal — and one was a control that
  broke `strictNullChecks`. None was re-scored. The second of those, once made
  reachable, found a live defect: cancelling an interrupted cleanup reached *zero*
  terminals. The full account is in the ledger §12.
- **A test fixture that names a condition it does not contain is the recurring
  failure in this repository.** This package found the third instance:
  `RUN-LEASE: … while a live foreign lease is present` used a pid nothing was
  running under. The first two were `shared_with_other_runs` used for foreignness
  (ADR-ERL2-027 §1.5) and the connect guard's succeeded half. Expect more.

## 7. What Step 5 inherits

The next package is offline-verifier strengthening. Four things it should know:

- **`assertJourneyOrderingFromLifecycle` is the pattern to extend.** It derives
  post-capture ordering from the hash-chained event stream alone and holds its own
  copy of the event prefixes rather than importing them from core — the verifier
  must not share the producer's decision about what a post-capture intent *is*.
- **`assertInvalidFindingAttribution` now covers two failing phase kinds**, through
  the shared `gateForInvalidFailurePhase`. A third kind added to
  `InvalidFailurePhaseV1` must be handled there or it silently returns early,
  which is exactly the shape of the bug this package fixed.
- **The intent journal stays run-private and out of the closure.** Public evidence
  proves the externally relevant ordering through retained receipts and lifecycle
  events; the journal exists for live recovery. Do not make the verifier trust it.
- **The evidence cutoff is still never re-derived offline** (a P2 item), and the
  matrix now makes that gap sharper: the producer refuses a post-capture intent
  before the realized cutoff, and the verifier checks the *ordering* of the event
  that realized it, but not that the cutoff instant follows from its own inputs.

## 8. What remains

Unchanged by this package and still open:

- The P2 cluster: `mounted_file` scanned with metadata that cannot contain the
  mounted content; `lab_telemetry` with no negative control; secret canaries and
  forbidden identifiers unscanned on the environment subject-output surface; the
  declared subject-output size limit hashed but unenforced; the evidence cutoff
  never re-derived offline; retained subject-output payloads unaccounted in the
  verifier; the signer inventory's `complete_for_terminal_chain` omitting members
  whose authority field is not literally named `signature`.
- The remaining P3 drift, less the two items this package closes: the
  operational-directory residue on a refused command, and the "a refusal writes no
  evidence" overclaim.
- ERL2-OQ-005, ERL2-OQ-007 and ERL2-OQ-008 — unchanged, still fail-closed.
- Crash coverage for the four operations named in §6.

**The claims ceiling is unchanged: T1.** This package removes two false claims — a
crash-resumability claim whose evidence injected no crash, and a "refusal writes no
evidence" claim that was untrue for the environment commands — and adds no true
ones.

**The branch is not merge-ready.** Remaining independent-review findings must be
closed and the branch re-reviewed independently. This package passing is not a
merge signal.

## 9. Picking this up in a new session

### 9.1 What the tree is

This package is committed on branch **`slice-6.5-cleanup-remediation`**, on top of
`9ebaebc`. The working tree was **clean** at `9ebaebc` when the package started and
is clean again now, so the checkpoint's diff is exactly this work with no user-owned
change mixed in — a new session does not have to guess which is which.

```bash
git log --oneline -1 slice-6.5-cleanup-remediation   # the checkpoint commit
git show --stat HEAD                                 # 27 paths, 9 of them new
```

The checkpoint reproduces **719 tests / 719 pass / 0 fail**, purity **24/24**,
`generated types are current`, and `evidence:verify OK — pinned 787 files, excluded 7`
from a clean `npm run clean && npm install && npm run build` — the full gate of §5,
run serially with no concurrent build. `git diff --check` is clean and
`git status --short` is empty.

The negative-control totals are **47 controls, 10 of them new in this package, all
ten load-bearing** (§9.2).

The crash claim stops exactly where §2 and the claims file put it: invocation-level
exactly once for **challenge activation** at all eight boundaries and for a **subject
step** at three; fail-closed ambiguity at the subject step's other five; no
evidence-backed second transport invocation anywhere; and **no** crash-matrix claim
for `provision`, `restore`, `destroy` or the emergency actions.

New source (6 files):

```
packages/core/src/journey/prerequisites.ts        the matrix and its enforcement
packages/core/src/run/cancellationBranch.ts       the two-witness classifier
packages/core/src/run/crashBarrier.ts             the eight boundaries
tests/integration/journeyPrerequisites.test.ts    10 pure matrix cases
tests/adversarial/lifecycleOrdering.test.ts       11 CLI refusal + cancellation cases
tests/e2e/crashBoundaryMatrix.test.ts             20 fresh-process crash cases
```

Changed source (12 files): `packages/core/src/{run/environmentRun.ts,
run/mutationIntent.ts, lifecycle/lease.ts, environment/allocator.ts,
environment/substrate.ts, evaluation/invalidityAttribution.ts, index.ts}`,
`packages/cli/src/{environmentCommands.ts, index.ts, journeyCommands.ts}`,
`packages/public-verifier/src/{index.ts, library/environmentDerivation.ts}`. Plus
`scripts/negative-control.mjs` (+10 controls), `tests/integration/runLease.test.ts`,
the two runbooks, the claims, the requirements ledger and the docs.

`packages/contracts/` is **untouched** — no schema, no registry entry, no
generated type.

### 9.2 Negative controls

`npm run negative-control` checks a worktree out at `HEAD` and refuses a dirty
tree, so a campaign needs a commit containing the source it measures. When this
package's ten controls were first measured it was not yet authorized to commit, so
they were measured in a **disposable clone** whose `HEAD` carried the candidate
state — the methodology `remediation-6.5-false-attestation.md` §6 established and
then independently validated by re-running all ten in-repo with identical counts.

Now that the checkpoint exists, `HEAD` carries the measured source directly and the
clone step is no longer needed.

```bash
npm run negative-control                      # all 47
npm run negative-control -- <id>,<id>         # a named subset
```

The measured table is in
[`remediation-6.5-lifecycle-ordering.md`](../ledger/remediation-6.5-lifecycle-ordering.md)
§12. Run the full 47 in the repository once this branch is committed; the previous
package's experience is that a clone and an in-repo run agree, but that has been
checked once, not established.

All ten are load-bearing. **The control that matters most is
`invocation-count-not-dedup`**, which kills 9 of the 20 crash-matrix cases. It removes
reconciliation entirely while leaving every deduplication intact — the artifact
store's duplicate refusal, the lifecycle log's `operation_id` dedupe, the driver's
operation log. A suite that asserted "exactly one retained receipt" still passes
under it. If that control ever kills nothing, the crash matrix has gone back to
counting artifacts and the exactly-once claim is unfounded.

### 9.3 Where to start reading

[ADR-ERL2-028](../adr/ADR-ERL2-028.md) §1 for what was wrong and §2.2 for the one
rule that is easy to get plausibly wrong, then
[`remediation-6.5-lifecycle-ordering.md`](../ledger/remediation-6.5-lifecycle-ordering.md)
§4 for the three defects the crash standard found, then this file.
