# Reliability correction — the observation window, and the marker publication

Two defects an independently classified clean-gate failure exposed, corrected
here. Both were **pre-existing**: every file they live in was byte-identical to
`origin/main` at the failing candidate, so neither is attributable to Package A —
and neither is environmental either, which is where the first classification was
wrong.

## What this correction does *not* claim

The 147-control campaign at `25aea768a09ff6ba2011e25a00000d5b152990d1`
(tree `b3885321e96418e75e63c6b4f5f7f4c93c4a26ac`) remains valid evidence — **for
that candidate and no other**. This correction changes production source, so it
creates a **new executable candidate**, and the campaign does not carry forward
to it. Nineteen controls target the two production files involved, and the
campaign's binding is to a tree that no longer exists.

The focused tests and the affected controls measured here are implementation
evidence. They are **not** a campaign, and they do not certify anything. This
candidate is not campaign-certified, not publication-ready, not merge-ready and
not Qualiber-ready. **No clean-gate rerun is authorized in this package.**

The historical record — the campaign, its explained `process_residue` entry, the
failed gate at `failed-clean-gate-20260813T174226Z/`, and the execution report —
is unchanged and stays bound to `25aea768`.

## COMPOSE-E2E — a production evidence-accuracy defect

**The earlier classification of "environmental, a live-substrate timing failure"
is overturned.** It reasoned from byte-identity with `origin/main` to
"environmental", but byte-identity proves only non-attribution: it says nothing
about whether the pre-existing code is right. The verdict is
`PRE_EXISTING_PRODUCTION_OBSERVATION_DEFECT`, and the mechanism is positive, not
inferred.

`ComposeEnvironmentDriver.observeAttributableTelemetry` derived its two numbers
from evidence with different survival. The collector's debug exporter writes a
batch's `Traces … "spans": N` summary and *then* dumps that batch's resources and
attributes; the run marker rides in the dump; the pinned collector's `json-file`
log rotates from the head (`max-size=5m`, `max-file=2`). The settle loop exited on
`runAttributedRecords >= 1` — the half that survives rotation — and froze the span
count read from the same window, which is the half that does not. Nothing ever
waited for, or checked, the number it was about to retain.

| readable window | `spans` | `run_attributed_records` |
|---|---:|---:|
| complete block | 7 | 2 |
| **summary rotated away** | **0** | **2** |
| dump not yet written | 7 | 0 |

Row two is what the gate recorded. The run's telemetry emission was independently
proven in the same run: an earlier assertion had already passed
`CURRENT_RUN_SPANS_OBSERVED` with `currentRunSpanCount > 0`.

`b22e9fb` diagnosed this exact mechanism and fixed it **only for the test-side
durable follower**, stating "no product code path". The production observer was
left as it was.

**Severity, stated exactly.** The producer's telemetry gate never reads `spans` —
it binds to `evidence`, `run_id`, `marker` and `run_attributed_records >= 1` — so
this could not admit a run with no telemetry, and did not. It is an
evidence-accuracy defect: a retained artifact stated a span count for a run whose
count had never been read.

### The corrected invariant

> The observer never states a span count derived from evidence it did not observe
> in the same window that established run attribution.

One condition, in one place, with one call site
(`decideTelemetryObservationWindow`): **at least one trace batch whose summary
line and whose records naming this run were both inside this window, the summary
first** (`runAttributedBatches >= 1`). It is strictly stronger than the condition
it replaces — it implies `runAttributedRecords >= 1`, so the settling the
exporter's flush schedule needs is unchanged — and it binds the count and the
attribution to one snapshot of one read.

At budget exhaustion the window is described rather than trusted, strongest
evidence first. Records naming this run that no readable summary counts *are* the
proof that the summary was evicted, so that case demotes to an honest `absent`
with `telemetry_span_count_outside_readable_window`. Otherwise nothing of this run
was in the window, and the remaining question is whether the window is whole: one
that begins on a continuation line lost bytes before it and establishes no count,
not even a zero (`telemetry_observation_window_truncated`). A window that begins
where the collector began a record and carries nothing of this run keeps its own
counts, zero included, and the gate refuses it on the attribution floor exactly as
before. `reason_code` on ERL2-C-160 is an open string, so **no schema or contract
changed**.

### One wrong turn, found live and recorded

The first version of the completeness check searched the window for the
collector's own start-up sentences (`Everything is ready`, `Starting GRPC
server`), reasoning that it writes them once, before it can have exported
anything. The bounded live loaded run refuted it. At `verbosity: detailed` the
collector exports its **own** logs back through the same debug exporter, so those
sentences reappear throughout the stream as `Body: Str(…)` inside later dumps —
nine times in one 74 kB window. A substring test is therefore true in a window
whose head is long gone, and that run froze `evidence: observed, spans: 0` beside
`run_attributed_records: 5`: the failed-gate signature, live, past the first
correction.

The replacement is structural rather than lexical, and that is the transferable
part: a completeness signal must be something a payload cannot contain. Every
console record the exporter writes begins with an RFC-3339 instant and a tab, and
a batch's detailed dump is written as unstamped continuation lines, so *the first
line of the window* answers whether the window begins at a record boundary. A
line prefix can carry that claim; a substring anywhere cannot. The regression is
pinned by `COMPOSE-WINDOW: a re-exported start-up sentence does not make a cut
window whole`, which reproduces the live artifact deterministically.

Waiting longer is not the mechanism and the retention window was not enlarged:
neither can bring an evicted line back. The excerpt invariant the offline verifier
stands on is preserved exactly — the excerpt keeps every summary line and every
marker-bearing line in order, so block membership is identical in the excerpt and
in the full log.

## NC-RESTORE — a real publication race

Verdict `PRE_EXISTING_FILE_PUBLICATION_RACE`, and not environmental either: it has
a positive mechanism. The driver published its marker with `writeFileSync`, which
opens the final path with `O_CREAT|O_TRUNC` and *then* writes, and the reader's
readiness condition was `existsSync`. A concurrent probe observed the final path
at size zero in **300 of 300** attempts. The idle-host passes measured how often
the race is lost, not whether the window exists; the gate ran immediately after a
four-hour campaign and lost it.

Corrected on both sides, because writer-only would close this instance and leave
the shape for the next consumer, and reader-only would leave the non-atomic
publication in place:

- the writer serialises the complete bytes deterministically, writes them to a
  uniquely named temporary **in the destination directory** with `O_CREAT|O_EXCL`
  and mode `0600`, flushes, closes, and renames onto the final path — atomic
  within one filesystem, and never a cross-filesystem copy. A symlink at the final
  path is refused rather than published through, and a failed publication removes
  its own temporary and nothing else;
- the reader's readiness is *content*: bytes read whole, parsed, and an envelope
  naming the writer it is waiting for. Absent, empty and still-changing unparsable
  content stay transient; stably unparsable bytes, a foreign identity, an unsafe
  path, an unexpected filesystem error and a closed deadline all fail closed with a
  diagnostic that says which. The 50 ms poll interval is unchanged — it was never
  the fix.

## Campaign impact

Discovery goes from **147 to 150**. Nothing was deleted, merged or renamed to
offset the additions.

| new control | file | why it is not count inflation |
|---|---|---|
| `compose-observation-requires-coherent-span-count` | `packages/core/src/environment/telemetryObservation.ts` | its mutation is the pre-correction condition verbatim, and the named cases read the *frozen artifact* |
| `nc-marker-published-atomically` | `tests/support/atomicMarker.ts` | its mutation writes straight to the final path, which is the `writeFileSync` shape |
| `nc-marker-readiness-requires-valid-content` | `tests/support/atomicMarker.ts` | its mutation makes an existing empty file ready, which is the `existsSync` condition |

Each kill is deterministic and case-named. None depends on winning a race: the
writer's property is proven structurally between staging and committing, and the
reader's is total over a filesystem state constructed by hand.

Nineteen existing controls target the two changed production files — six on
`composeDriver.ts`, thirteen on `telemetryObservation.ts` — and none of their
preimages was touched. That is not carry-forward: a new candidate needs its own
campaign, and the scope of that is a decision for an independent review, not for
this package.
