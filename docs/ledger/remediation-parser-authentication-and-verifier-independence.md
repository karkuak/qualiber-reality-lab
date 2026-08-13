# Remediation — trace-summary authentication, and an independent verifier

Two findings from the independent review of `baa2d493`, corrected here. Neither
reopens the coherent-window correction or the atomic marker: both stand.

## P1 — a subject's log body could state this run's span count

The trace-summary pattern was `/\bTraces\b.*"spans":\s*(\d+)/`: unanchored,
matching anywhere on any line. The Lab's collector overlay runs a `logs`
pipeline into the same `debug` exporter the counts are parsed from, so a
subject's log record is rendered into that stream — and the pinned collector
(`otelcol-contrib` v0.157.0, `sha256:1fef9f07…`) renders it at column zero:

```
Body: Str(2026-08-13T21:33:32.634Z	info	Traces	{"resource spans": 1, "spans": 9999})
```

That line matched. Adding one to the rotated window the observer correctly
refuses turned the refusal into a retained observation:

| readable window | decision | retained `spans` |
|---|---|---:|
| rotated, this run's records only | refused, `…outside_readable_window` | *(absent)* |
| **the same window + one hostile log body** | **retained** | **9999** |

**Why it mattered more than it used to.** Before the coherent-window correction,
a forged count only inflated a field nothing read. After it,
`runAttributedBatches >= 1` decides whether evidence is retained at all — and a
forged summary opens a batch. The pattern had become an integrity boundary while
still being written as a convenience.

### The rule now

A count is read only from a whole console record the collector framed:

1. the line begins a record — the RFC-3339 UTC instant and tab the collector
   stamps, at column zero;
2. the record ends on that line, its structured context present as the final
   tab-separated field;
3. the zap message field is exactly `Traces`;
4. the context parses as a JSON object and names the `traces` signal, which is
   what separates a trace batch's summary from a `Logs` or `Metrics` one;
5. `spans` appears exactly once as a plain non-negative integer literal, read
   from the raw bytes — `JSON.parse` alone would take `1e3` as 1000, `1.0` as 1,
   and the last of two `"spans"` keys;
6. the value is a safe integer, so a long enough digit run is refused rather
   than becoming `Infinity`.

A line satisfying (1)–(3) and failing a later conjunct is **malformed**, not
ignored: a record shaped like one the collector writes and unreadable as one is
a fact about the window.

### Framing, because anchoring alone was not enough

A multi-line log body puts its continuation at column zero, so it can carry a
byte-exact copy of a real summary. A record whose message runs on therefore
opens a **payload region**, closed by its context line, and nothing inside one
is read as a summary. A window that lost its head begins inside a region by
construction — which is the case rotation actually produces, and the one that
matters most.

A record-shaped line found *inside* payload is something the collector cannot
have written. The window then reports that its boundaries are unknown rather
than guessing.

### Supported format, stated as a boundary

Read with `docker container logs` and **no** `--timestamps`: Docker contributes
no prefix, the collector's zap console encoder writes all of it.

```
<RFC-3339 UTC>\t<level>\t[caller\t]<message>\t{<structured context>}
```

Accepted: `Z`-suffixed instants with or without fractional seconds; `\n` and
`\r\n`. **Not** accepted, deliberately: numeric UTC offsets, lower-case `z`, a
space where the grammar wants a tab, or any record shape a future collector
introduces. Every one fails closed — an unreadable window states no count.

Two new reason codes, both fail-closed:
`telemetry_observation_window_ambiguous` and
`telemetry_summary_record_malformed`. `reason_code` is an open string on
ERL2-C-160, so **no schema or contract changed**.

### The excerpt now keeps record-context lines

They carry no count, which is why it did not keep them before. Framing needs
them: an excerpt that dropped the line ending a cut window's opening region
would re-frame as though the window had begun at a record boundary, and read the
first summary after it under different rules than the producer did. They are
collector metadata — resource identity and component ids — not subject payload,
so this widens no privacy surface, and the retention bound is unchanged.

## P2 — the offline verifier trusted the producer's coherence

The producer enforced the coherent-window invariant; the verifier did not
re-derive it. The literal artifact the failed clean gate recorded —
`evidence: observed, spans: 0` beside `run_attributed_records: 2` — verified
clean, because every counter agreed with the excerpt and nothing checked the
*relationship* between them.

The verifier now re-derives, from the excerpt it already parses:

- **attribution without a counting batch is refused** — records naming this run
  with no batch that stated a count for them is the pre-correction shape;
- an excerpt carrying a record boundary inside payload is refused;
- a summary-shaped record whose count cannot be read is refused.

An honest zero is untouched: a whole window that received nothing states zero
with no attribution, and the floor is about attribution without a counting
batch.

**What is not independently derivable, stated plainly.** Window completeness
stays producer-only: `collectorWindowComplete` reads the raw window and the
excerpt keeps only counting lines. That is sound rather than a gap —
completeness only ever chooses between refusal shapes for a window with no
attribution at all, and such an observation fails the attribution floor
regardless. No derivation proof was added, because none was needed: the excerpt
is already required on every `observed` record, bounded, and hash-covered.

## Test fixtures

Fixtures gained the structured context every real record carries. A record
without one is a shape the collector never emits, and under a parser that
authenticates records rather than matching substrings, such a fixture tests
something that cannot occur. No assertion was weakened.

## Campaign impact

Discovery goes from **150 to 155**. Nothing was deleted, merged or renamed.

| new control | file | boundary |
|---|---|---|
| `telemetry-summary-must-be-a-framed-record` | `telemetryObservation.ts` | only a framed record states a count |
| `telemetry-record-payload-is-not-summary-text` | `telemetryObservation.ts` | payload states nothing, even copied byte for byte |
| `telemetry-ambiguous-window-is-refused` | `telemetryObservation.ts` | an unframable window is refused, not totalled |
| `telemetry-malformed-summary-is-not-a-zero` | `telemetryObservation.ts` | an unreadable summary is not a zero |
| `telemetry-verifier-recomputes-coherence` | `telemetryDerivation.ts` | the verifier re-derives rather than trusts |

Each mutation is a single narrow edit with exactly one replacement, and each
kill is named at case level.

### Corrected affected-control inventory

The previous inventory was derived by **mutation-target file only**, which the
review found incomplete: it omitted two controls whose *designated suite*
changed. The derivation is now the union of both axes.

| path | role | mutation target | designated suite | discovery dep. | affected controls |
|---|---|---|---|---|---|
| `packages/core/src/environment/telemetryObservation.ts` | production | ✅ 18 | — | — | 18 |
| `packages/public-verifier/src/library/telemetryDerivation.ts` | verifier | ✅ 6 | — | — | 6 |
| `packages/core/src/index.ts` | re-export | ❌ 0 | — | — | 0 |
| `tests/adversarial/attributableTelemetry.test.ts` | test | — | ✅ 24 | — | 24 |
| `tests/adversarial/composeSubstrate.test.ts` | test | — | ✅ 5 | — | 5 |
| `tests/support/composeStub.ts` | test support | ❌ 0 | — | — | 0 |
| `tests/architecture/negativeControlDiscovery.test.ts` | test | — | ❌ 0 | ✅ pins discovery | 0 |
| `scripts/negative-control.mjs` | campaign definitions | — | — | ✅ source | — |
| `docs/ledger/…` (this file) | documentation | — | — | — | — |

- controls targeting a changed production or verifier file: **24**
- controls whose designated suite changed: **29**
- union of both axes: **29**
- adjacent controls included defensively: **4** (the marker pair, the durable
  telemetry pair)
- **focused review set: 33**
- unaffected: **122**
- canonical discovery: **155**

**The two previously omitted controls.** `telemetry-producer-gate-wiring`
(mutation target `packages/core/src/run/environmentRun.ts`) and
`substrate-loopback-only-rendered` (mutation target
`environments/otel-demo/compose/erl2-overlay.yaml`) are affected because their
designated suites — `attributableTelemetry.test.js` and
`composeSubstrate.test.js` — changed. Neither mutation target changed, in this
package or the last, which is exactly why a target-only derivation missed them.
Both are now included by the rule rather than by hand.

## What this correction does *not* claim

The focused controls measured here are implementation evidence. They are **not**
a campaign and they certify nothing.

The 147-control campaign remains valid evidence for
`25aea768a09ff6ba2011e25a00000d5b152990d1` and no other candidate. The failed
clean gate at `failed-clean-gate-20260813T174226Z/` remains historical evidence
of that candidate. Neither is touched, and neither carries forward.

This candidate is **not campaign-certified, not publication-ready, not
merge-ready, not clean-gate-ready and not Qualiber-ready.** A full 155-control
campaign remains required, and remains pending independent review of the parser
authentication, the verifier's independence, the corrected affected-control
inventory, and the final discovery count.
