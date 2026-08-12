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
| New controls for the closures above | 5 |
| **Total, derived from `--list`** | **146** |

The five new controls are `v2-residue-requires-report`,
`v2-residue-report-validated`, `v2-governed-port-refusal`,
`v2-telemetry-follower-readiness` and `v2-telemetry-block-boundary`. The count
is derived from discovery, not targeted: the earlier estimate of "at least 147"
assumed at least six new controls, and six were not needed, because
`v2-cleanup-requires-evidence` already covers the completed-without-residue
boundary once it also names the residue suite. Padding the table to reach a
number would measure nothing.

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

## What this package does not claim

- It is not campaign-ready until a focused independent re-review approves these
  closures.
- It is not publication-ready or merge-ready.
- The full negative-control campaign at the corrected commit is still required,
  and Package A changes the adapter host and protocol boundary, so the earlier
  129-control campaign may not be carried forward.
