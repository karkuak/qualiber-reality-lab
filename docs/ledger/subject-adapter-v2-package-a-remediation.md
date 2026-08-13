# Subject Adapter V2 Package A — review-closure remediation

Date: 2026-08-12

Baseline: `d18364da301fce4fd5a4cbdfa2d78fff45837b51`

This package closes the four findings an independent Package B review raised
against Package A, integrates the `subject-adapter/v2` negative controls into
canonical campaign discovery, and withdraws a targeted-regression figure that no
retained evidence supports.

The approved architecture is unchanged. `subject-adapter/v1` remains the
governed path, `subject-adapter/v2` remains local observation only, and no v2
result gained governed, certified, scored or release authority. Nothing
Qualiber-specific entered the Lab, and the COMPOSE-E2E correction remains
test-only.

## F-1 — the cleanup reducer inferred a clean substrate

`cleanupResult()` emitted `residue: "observed_clean"` and `cleanup_complete`
because a `report-residue` operation had reached the `completed` state. The
completed record carried no residue value, so the reducer could not distinguish
clean from dirty: an adapter reporting fifty leftover artifacts produced output
byte-identical to one reporting none, and `residue_detected` — a value
`LocalCleanupResultV1` has always offered — was unreachable in the production
tree.

Two things were wrong, and the second was the more general:

1. Residue was inferred rather than read.
2. A `completed` record was treated as a successful operation. It never meant
   that: `completed` means the exchange completed and its evidence froze, and
   the adapter's own verdict lived only inside the response envelope. A `stop`
   the adapter reported as `failed` therefore satisfied the cleanup obligation
   for `start`.

### What changed

- `LocalResidueObservationDraft` (`packages/contracts/src/protocol.ts`) is the
  adapter's residue report for one checkpoint. It is a draft like every other
  adapter-authored value — no core hash, no artifact ref, no cleanup verdict —
  and its `status` reuses the existing `ResidueReportV1` vocabulary
  (`clean` / `residue_detected` / `unknown`) so a local observation and a
  governed report say the same words. It is validated by a hand-written closed
  validator in `responseShape.ts`, which is where every other adapter draft is
  validated; it is deliberately not a registered contract, so the public
  contract count is unchanged at 166.
- `assertLocalResidueObservationDraft` refuses an unusable report with
  `ADAPTER_LOCAL_RESIDUE_REPORT_INVALID`, a code distinct from the generic frame
  refusal because "the residue report is unusable" and "the frame is malformed"
  are different facts. It refuses `clean` alongside named residual items,
  `residue_detected` naming none, and a report whose checkpoint is not the one
  the host dispatched.
- `LocalObservationCompletedRecordV1` gains a required `response_status`
  (`supported` / `failed` / `unsupported`) and an optional `residue_observation`
  (`LocalResidueRecordV1`: checkpoint, status, and the two counts).
- `cleanupResult()` now reads both. An operation satisfies a cleanup obligation
  only when its record is `completed` *and* its `response_status` is
  `supported`. Residue comes from the final checkpoint's validated report and
  from nowhere else; there is no branch that derives `observed_clean` from an
  operation reaching a terminal state.

### Residue truth table

| adapter's report | host | `response_status` | `residue_observation` | `cleanup.residue` | `cleanup.status` |
|---|---|---|---|---|---|
| `clean`, no items | accepted | `supported` | `{final, clean, 0, 0}` | `observed_clean` | `cleanup_complete` |
| `residue_detected`, 50 paths | accepted | `supported` | `{final, residue_detected, 0, 50}` | `residue_detected` | `cleanup_incomplete` |
| `unknown` | accepted | `supported` | `{final, unknown, 0, 0}` | `not_observed` | `cleanup_incomplete` |
| `clean` while naming a path | refused | — (no completed record) | absent | `not_observed` | `cleanup_incomplete` |
| malformed, missing, or wrong checkpoint | refused | — (no completed record) | absent | `not_observed` | `cleanup_incomplete` |
| operation is not `report-residue` | n/a | `supported` | absent | `not_observed` | follows the other obligations |

Everything unobserved, unavailable or self-contradicting resolves to
`not_observed`. Uncertainty is reported; it is never rounded down to clean.

### V1 impact

None. `LocalObservationCompletedRecordV1`, `LocalCleanupResultV1` and the
residue draft are `subject-adapter/v2` local-observation contracts introduced on
this branch. No v1 schema, request, receipt, envelope, golden or core hash
moved, and the doctor transcript's `registered_contracts` remains 166 because no
contract was registered.

## F-1b — the second property shipped correct and unmeasured

F-1 corrected two things. The second was the more general: an operation
satisfies a cleanup obligation only when its record is `completed` *and* its
`response_status` is `supported`. A `stop` the adapter reported as `failed` had
been discharging the obligation a successful `start` created.

The reducer was fixed. Nothing measured it. A focused independent re-review
mutated `succeeded()` to drop the adapter-verdict conjunct and ran the entire
test tree: **1,371 tests, 1,347 passed, 0 failed**. No test and no canonical
control observed the property, so it sat outside the campaign's published scope
— the same shape as F-2, and the same standard applies: correct and unproven is,
for a claim boundary, the same as unguarded.

`tests/integration/localOperationSuccess.test.ts` closes it. Two neutral
adapters — `neutral-lifecycle-stop-succeeded` and `neutral-lifecycle-stop-failed`
— differ only in the verdict they return for `stop`, and run through the real
`AdapterHost` subprocess over the smallest lifecycle that reaches the decision:
`start`, then `stop` as the frozen cleanup suffix. Separate certified bytes per
behaviour, for the same reason the residue shapes are separate files.

What is asserted, on reduced evidence rather than on `succeeded()` itself:

| | `stop` record | `response_status` | `cleanup.stop` | `cleanup.status` |
|---|---|---|---|---|
| adapter failed the stop | `completed` | `failed` | `failed` | `cleanup_incomplete` |
| adapter supported the stop | `completed` | `supported` | `completed` | `cleanup_complete` |

The two reduce to different `LocalObservationResultV1.core_hash` values, so the
verdict reaches frozen evidence. The failing case also asserts coherence — that
the reduced result cannot report the stop as done and the cleanup as unfinished
in the same breath — because `cleanupResult()` reads the verdict twice, once
positively in `succeeded()` and once negatively in `unsuccessful()`, and removing
it from only the first produces exactly that self-contradiction.

The new control is `v2-operation-success-requires-adapter-success`. It removes
the conjunct and retains lifecycle completion, so it asks precisely "does the
adapter's verdict decide?" and nothing else. Under it, a stop the adapter failed
is reported as `completed`.

Production behaviour was already correct and is unchanged. This closure is test
and control only.

## F-2 — the governed-port refusal was unproven

`HostedSubjectPort`'s refusal of a v2 host is the one execution-path expression
of "local observation never enters governed execution"; every other proof of
that boundary is a schema-shape assertion. The review mutated the guard to
`if (false)` and the whole targeted suite stayed green, because no test anywhere
constructed a v2 host and offered it to the governed port.

`tests/integration/governedPortRefusal.test.ts` now does. The refusal is proven
behaviourally rather than by matching a message: a dispatch sentinel — the
per-operation working directory and the retained artifact store, which a real
dispatch cannot avoid touching — is shown unchanged after the refusal, and shown
to move under a genuine dispatch, so "nothing ran" is a measurement. The same
host the port rejects then completes a local observation on its own path, so the
refusal is about the seam and not about a broken host.

No second production guard was added. The existing authoritative check is what
the control mutates.

### Corrected: what this control proves, and what it does not

An earlier version of this section said the mutation makes adapter dispatch
observable. **It does not, and that claim is withdrawn.** A second independent
review ran the mutation and drove all three port methods with a v2 host:
`acquire`, `validatePackage` and `step` were each still refused with
`ADAPTER_EXECUTION_MODE_UNSUPPORTED`, and the sentinel did not move.

Enforcement is layered. `HostedSubjectPort` never dispatches with
`executionMode: "local_observation"`, so `AdapterHost.run`'s execution-mode
binding refuses a v2 host on every port method regardless of the constructor
guard. That layer is itself covered by `v2-local-mode-accepts-v1`.

So the honest statement of the boundary is:

- **Proven** — the governed port performs its own early refusal, at
  construction, deterministically, with a typed code, before a port exists to
  dispatch through. The mutation is killed because that refusal disappears.
- **Not proven by this mutation** — that this guard alone is what keeps adapter
  bytes from executing. It is not; the host's mode binding is.

The sentinel is kept, with the narrower reading it can support: it shows no
adapter bytes ran *while layered enforcement held*. A new `HOST-MODE-BINDING`
case pins that second layer directly, so the reason the sentinel stays still is
measured rather than assumed. This is a correction to the validation claim, not
to the boundary — the boundary is stronger than the original text described.

## F-3 — a failed telemetry follower was reported as silence

`startCollectorCapture` created its capture file with `openSync` before the
`docker container logs --follow` process was known to have attached, and
`awaitDurableTelemetry` treated "the file is readable" as "we looked". A
follower that never attached therefore produced `TRACE_NOT_EMITTED` — an
assertion that the collector received nothing, which had not been established.
That is the same false claim the durable capture was written to remove, moved
from "the line rotated away" to "we never attached". `TRACE_OBSERVATION_UNAVAILABLE`
was unreachable in the live path.

Readiness is now tracked from the follower process itself: a synchronous spawn
failure, an `error` event, a stream error, or an exit we did not ask for all
make the capture unusable, and an unusable capture yields
`TRACE_OBSERVATION_UNAVAILABLE` with the reason attached. Our own `SIGTERM` and a
clean exit 0 are not failures. The failure modes are injected through the
existing `spawnProcess` seam, so they are exercised on hosts with no Docker.

No production package, adapter, environment, fixture, overlay, collector
configuration, timeout, retention limit or pinned OTel release changed. The
poll count (40) and interval (1s) are unchanged.

### Corrected: the control is now pinned at the diagnostic code

The behaviour above is right, but `v2-telemetry-follower-readiness` was not
measuring it. A second independent review found that under the mutation every
case this control killed **stayed classified `TRACE_OBSERVATION_UNAVAILABLE`** —
the `unreadable` fallback caught them — and only their explanation strings
changed. A control killed by wording is not pinned to a boundary.

The missing fixture is the one where the classification actually turns:

1. the follower attaches;
2. one poll reads a capture that is present, readable and honestly empty;
3. the follower dies before the deadline.

Nothing else in the verdict chain can stand in for readiness there — the capture
is readable, so `unreadable` is false, and it parses cleanly, so
`terminalBlockTruncated` is false. `a follower that dies after an empty read is
unavailable, not silent` asserts the diagnostic code, and under the mutation it
flips to `TRACE_NOT_EMITTED`: the exact defect, now measured.

The contrast is retained deliberately. `an attached follower that sees nothing
still reports not emitted` has the same empty capture and the same zero spans,
with the follower still attached at the end, and it **is** `TRACE_NOT_EMITTED`.
The follower's fate is the only difference between the two, which makes this a
test of the boundary rather than a rule that every empty observation is
unavailable.

One further correction to the record: `62fa257`'s message said the poll loop's
early exit "decides nothing". It does. `last.available` is initialised `false`
and only a successful read sets it true, so an early `break` on the first poll is
what yields `TRACE_OBSERVATION_UNAVAILABLE` for a spawn failure — demonstrated by
that case still passing under the authoritative-block mutation. The verdict is
made in one place for the attach-then-die path; it is not made in one place for
every path.

## F-4 — block termination had no load-bearing control

The shipped parser was correct, but a mutation that never terminated a block
survived the whole suite while crediting 107 spans from an earlier run to the
current one. The existing cross-run fixture could not catch it because it
contained no marker for the current run at all.

`durableTelemetryObservation.test.ts` now carries a two-block fixture in which
the other run appears only in the first block and this run only in the second,
plus its reverse, plus a non-trace summary terminating a trace block. A
summary-only terminal block — a batch read between its summary line and its dump
— is now reported as `TRACE_OBSERVATION_UNAVAILABLE` rather than as this run
emitting nothing, and a complete terminal block is explicitly asserted *not* to
be treated as truncated, so the distinction cannot degenerate into never
failing.

## Canonical campaign discovery

Twelve v2 controls lived in `scripts/subject-adapter-v2-negative-controls.mjs`,
a second harness with its own runner, patcher and report shape. Each killed what
it claimed to kill, and none was reachable from `npm run negative-control`,
which went on publishing 129 as the campaign's scope. A control the campaign
cannot discover is a control the campaign does not have.

All twelve now live in `CONTROLS` in `scripts/negative-control.mjs`, under the
same discovery, timeout, classification and durable-record path as every other
row, with stable descriptive ids. The superseded script is deleted rather than
left in place, because while it exists someone will run it and its results will
not be in the campaign record. Five controls were added for the boundaries this
package closes.

`node scripts/negative-control.mjs --list` is a new dry discovery mode: it
mutates nothing, needs no clean tree, and prints what the campaign would
measure. Scope was silently wrong once because there was no cheap way to ask.

### Discovered count

| Class | Count |
|---|---|
| Pre-existing controls | 129 |
| Previously separate v2 controls, now discoverable | 12 |
| New controls for the closures above | 6 |
| **Total, derived from `--list`** | **147** |

The six new controls are `v2-residue-requires-report`,
`v2-residue-report-validated`, `v2-governed-port-refusal`,
`v2-telemetry-follower-readiness`, `v2-telemetry-block-boundary` and
`v2-operation-success-requires-adapter-success`.

The count is derived from discovery, never targeted. It reached 147 by a route
worth recording, because the arithmetic alone is misleading:

- This package first shipped **five** new controls and argued that a sixth for
  "completed without residue" would be redundant, since
  `v2-cleanup-requires-evidence` already covers that boundary. **That argument
  was correct**, and an independent re-review confirmed it by surgically removing
  only the `(!finalResiduePlanned || residue === "observed_clean")` conjunct and
  watching three cases fail. The originally estimated sixth control was genuinely
  not needed.
- The sixth control that *was* needed is a different one, for a different
  property: F-1b above, which no one had counted because the record described the
  fix without noticing it was unmeasured.

So 147 matches the original "at least 147" estimate by coincidence rather than
by that estimate being right about which control was missing. The number is an
output of `--list`; padding the table to reach it would measure nothing.

`tests/architecture/negativeControlDiscovery.test.ts` fails if any v2 control
stops being discoverable, if two rows mutate the same preimage, or if the
superseded script returns.

## The `199/199` targeted-regression claim

A `targeted regression total: 199/199` figure circulated in the Package A
handoff status. It appears nowhere in this repository and no retained evidence
supports it. The nearest reconstructions from the implementation ledger are
6 + 10 + 6 + 3 + 4 = 29 Package A targeted cases plus 142 affected V1
regressions = **171**, or **186** including the 15 durable-telemetry controls.
Neither is 199, and the difference is not accounted for.

Per the remediation brief's preference for correcting an unsupported claim over
reconstructing evidence after the fact, **the `199/199` figure is withdrawn**. It
should not be repeated in any status, handoff or review packet. The totals this
package actually produced are recorded above and in the validation section
below; they were measured, not reconciled backwards.

## Validation

Targeted only. The full clean gate and the full negative-control campaign were
**not** run, `evidence:update` was **not** run, and no prior gate evidence was
regenerated.

The repository's validation-evidence verifier still refuses the Package A
evidence directory with `negative-control-campaign/ is missing`. That refusal is
expected and correct while the campaign is pending, and no campaign record was
fabricated to silence it.

### Validation-closure pass

The six remediation controls were run through the canonical harness at the
closure commit. All six agreed, each patching exactly one site:

| Control | Baseline | Mutated | Failing case observed |
|---|---|---|---|
| `v2-residue-requires-report` | 4 pass | 3 fail | dirty report reduces to `observed_clean` |
| `v2-residue-report-validated` | 5 pass | 2 fail | contradictory report believed |
| `v2-governed-port-refusal` | 3 pass | 2 fail | the port's early refusal disappears |
| `v2-telemetry-follower-readiness` | 28 pass | 3 fail | attach-then-die reclassifies to `TRACE_NOT_EMITTED` |
| `v2-telemetry-block-boundary` | 30 pass | 1 fail | an earlier run's batch absorbed by a later run |
| `v2-operation-success-requires-adapter-success` | 3 pass | 1 fail | a failed stop reported as `completed` |

`6 discovered = 6 agreed + 0 disagreed + 0 unmeasured + 0 harness errors`, no
output truncated, working tree byte-identical afterwards, zero residue.

**Still pending, and not claimed anywhere in this repository:** the full
147-control campaign and the exact-final-HEAD clean gate. Neither has run.

## What this package does not claim

- It is not campaign-ready until a focused independent re-review approves these
  closures.
- It is not publication-ready or merge-ready.
- The full negative-control campaign at the corrected commit is still required,
  and Package A changes the adapter host and protocol boundary, so the earlier
  129-control campaign may not be carried forward.
- Two validation claims in this ledger were withdrawn after they were found to
  overstate what their mutations demonstrated (F-2 and F-3 above). The boundaries
  they describe hold; the corrections are to the evidence, not the behaviour. A
  reader should treat the corrected sections as authoritative and assume nothing
  from the withdrawn wording.
