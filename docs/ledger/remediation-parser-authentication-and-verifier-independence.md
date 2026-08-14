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

**One existing control was narrowed, and not silently.**
`telemetry-count-representable` named two cases. The second — a digit run long
enough to reach `Infinity` — no longer belongs to the retention guard it
defends: the trace-summary parser refuses an unrepresentable count before it can
be summed into a total, so that case now passes under this control's mutation.
It is killed by `telemetry-malformed-summary-is-not-a-zero` instead. The
property moved earlier in the pipeline rather than out of the campaign, and the
row was narrowed to the case it can still kill rather than left naming one it
cannot. The campaign harness is what caught this: a control naming a renamed
case is a harness error, not a pass.

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

---

# Corrections — this remediation was overturned by independent review

Independent re-review of `6d28d5436705c59c854fb2faee570716c6dcd7a5`
(`reality-lab-6d28d543-parser-verifier-rereview.md`, SHA-256
`26c60019a1332d90cc75bfd69c641f9fb5300f7b697b2672c3ddd2892f157508`) returned
**`CHANGES REQUIRED`**. The sections above are kept as written, because a ledger
that edits away what it claimed is not a record. Everything below corrects them.

## 1. The framing above is forgeable — P1 and P2 are both still open

The payload-region state machine closes a region on a line matching `^\t\{`.
**That token is subject-controlled.** The exporter renders a subject's bytes
verbatim at column zero, so a subject writes `\t{…}`, the region closes, and its
next line is read as an authentic collector record.

Reproduced live against the pinned collector, on the bytes it actually rendered:

| window | decision | retained spans |
|---|---|---|
| rotated, this run's records, **no hostile payload** | `refuse` / `telemetry_span_count_outside_readable_window` | — |
| **same window + subject payload** | **`retain`** | **9999** |
| complete window + subject payload | **`retain`** | **9999** |

`forgedBoundaries` stays `0`, so `telemetry_observation_window_ambiguous` never
fires. **Rotation is not required** — a complete window is forgeable too.

The claim in §"Framing, because anchoring alone was not enough" that framing
answers the multi-line residual is **withdrawn**. It answers the two shapes it
was tested against and not the one that closes the region.

## 2. The verifier is not independent for this vector

The forged artifact verifies clean on its own hash-covered excerpt: excerpt
fixed-point, count equality, `forgedBoundaries`, `malformedSummaries` and the
coherence floor **all pass**, and the offline verifier accepts `spans: 9999`.

The §P2 claim that the verifier "does not read a producer-supplied counter to
decide" is accurate and is **not** withdrawn. What is withdrawn is the
conclusion drawn from it. Producer and verifier share the framing definition, so
the verifier re-derives the attacker's framing and agrees with it. Independence
in the *arithmetic* is not independence in the *framing*. See ADR-ERL2-038 §4.

## 3. Architecture feasibility result

Measured against the pinned image, not argued:

| question | answer |
|---|---|
| does the mixed debug stream expose a framing token subject payload cannot reproduce? | **no** |
| does the Docker log API preserve per-record boundaries? | no — `json-file` splits on newlines; frames are stream chunks, not records |
| does the Docker driver expose trusted metadata separate from message bytes? | only per-line timestamps, which prefix continuations too |
| does the exporter offer a structured mode with machine-readable boundaries? | **yes** — the contrib `file` exporter, but on a different channel |
| can traces and logs be separated before the observation channel? | yes, and **it does not help**: `verbosity: detailed` renders subject *span attributes* the same way |
| can rotation begin mid-payload, making initial state unknowable? | yes |
| would any proposed close token also be subject-writable? | **yes — every one tested** |
| valid across supported macOS/Linux Docker? | the weakness is platform-independent |

Classification: **`NO NON-FORGEABLE FRAMING IN CURRENT STREAM`.**

The text parser is closed to further extension as a security boundary
(ADR-ERL2-038 §2). The record grammar `parseTraceSummaryRecord` is retained
because it reads well-formed collector output correctly — not because it
resists forgery.

## 4. Privacy — the §"excerpt now keeps record-context lines" claim is wrong

That section states the retained context lines are "collector metadata … not
subject payload, so keeping them widens no privacy surface." **False.**
`contributesToTelemetryCounts` retains any line matching `^\t\{`, and a subject
can write one. A retained excerpt from the live exploit begins:

```
<TAB>{"closed": "region"}
```

— entirely subject-controlled bytes, inside `log_excerpt`, covered by
`core_hash`. **Subject-controlled bytes can be retained in `log_excerpt`.**
Privacy here is **bounded, not absent**: the `maxLength: 262144` ceiling and the
demote-rather-than-truncate rule still hold, and those are unchanged.

## 5. Fixture availability — the archive is present, not absent

§14 and §21.6 of the implementation report say the pinned OpenTelemetry Demo
3.0.0 archive is "absent on this host". It is **present**:
`environments/otel-demo/upstream/opentelemetry-demo-3.0.0.tar.gz`, 3 054 524
bytes. It is git-ignored (`.gitignore:16`), so it is absent from *disposable
clones*, which is why `substrate-loopback-only-rendered` was unmeasurable by
that method. The control was correctly recorded `UNMEASURED HERE` and claimed
for nothing; only the stated reason was wrong. Correcting the method may make
the control measurable.

## 6. Broad-suite totals

The prior broad run was:

| | |
|---|---:|
| total | 1 285 |
| **passed** | **1 265** |
| skipped | **20** |
| failed | 0 |

It is **not** "1 285 passed". The 20 skips are pre-declared. **No durable
record of that run exists** anywhere in the repository — `docs/evidence/` is
byte-identical to `270321c5` — so the only account of it is prose, and it
cannot be audited. Any future broad run must retain a durable record.

## 7. What still stands

Independently reproduced by the re-review and not disturbed:

- the single-record grammar, including rejection of negative, decimal,
  exponent, hexadecimal, leading-zero, duplicate and overflow counts;
- genuine zero positively parsed, never inferred;
- the five new controls, all killing deterministically with exact restoration
  and kill counts 50/2, 51/1, 51/1, 50/2, 51/1;
- discovery 150 → 155 as an exact ordered prefix, zero removed, renamed or
  reordered;
- the narrowing of `telemetry-count-representable`;
- fixture corrections, which made records realistic and weakened no assertion;
- the union-of-two-axes affected-control derivation (24 / 29 / union 29 /
  focused 33 / unaffected 122), including the two formerly omitted controls;
- the 33-control accounting, with `substrate-loopback-only-rendered` explicitly
  unmeasured;
- historical evidence byte-identity, `docs/evidence/` tree
  `cc64c2fdf67fced12692bfa27a407656c6d69e61` at both `270321c5` and `6d28d543`;
- the atomic marker correction.

**One coverage gap, and it is why the campaign did not catch this.** No control
in the canonical 155 mutates the region-**close** decision. Searching every
control's `find` string for `RECORD_CONTEXT_LINE` or `open = false` returns
none. `telemetry-record-payload-is-not-summary-text` mutates only the region
*open*. The boundary that failed had no control, so no mutation could survive to
report it.

## 8. Status

No production code changed in this package. The framing feasibility gate
(ADR-ERL2-038) returned `NO NON-FORGEABLE FRAMING IN CURRENT STREAM`, and the
smallest trusted correction is a substrate, driver, contract and campaign change
beyond a bounded remediation (ADR-ERL2-038 §7).

Canonical discovery is **unchanged at 155**: no control was added, removed,
renamed or reordered, and no mutation target or designated suite changed.

**The `6d28d543` defect remains open.** This candidate is not
campaign-certified, not publication-ready, not merge-ready, not
clean-gate-ready and not Qualiber-ready. The 147-control campaign remains bound
to `25aea768a09ff6ba2011e25a00000d5b152990d1` and no other candidate. A full
campaign and the clean gate remain pending, and are not authorized while
attributable telemetry rests on a forgeable channel.
