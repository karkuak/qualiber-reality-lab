# ADR-ERL2-038 — attributable telemetry needs a trusted channel, not a better parser

- **Status:** accepted (decision), **implementation deferred** — see §8
- **Date:** 2026-08-13
- **Deciders:** Lab Core Owner, Integrity/Security Owner, Certification Owner
- **Extends:** ADR-ERL2-024, ADR-ERL2-033, ADR-ERL2-035
- **Supersedes:** nothing. It **bounds** the parser-authentication approach
  ADR-ERL2-035 §2 and the `6d28d543` remediation took, and rules it out as a
  security boundary.
- **Evidence:** `docs/ledger/remediation-parser-authentication-and-verifier-independence.md`
  (corrections §7); independent review
  `reality-lab-6d28d543-parser-verifier-rereview.md`
  (SHA-256 `26c60019a1332d90cc75bfd69c641f9fb5300f7b697b2672c3ddd2892f157508`,
  verdict `CHANGES REQUIRED`)

## Context

Two successive remediations tried to make the collector's **console debug
stream** a trustworthy source for an attributable span count.

1. `baa2d493` matched `/\bTraces\b.*"spans":\s*(\d+)/` anywhere on any line.
   An independent review forged it with one `Body: Str(…)` log body.
2. `6d28d543` replaced that with a structural grammar: a count is read only from
   a whole console record, anchored at column zero, message exactly `Traces`,
   signal `traces`, plain integer literal read from raw bytes. **That grammar is
   sound and this ADR does not disturb it.** The same commit added a
   payload-region state machine so a multi-line body's continuation could not
   impersonate a record.
3. The independent re-review forged *that*, live, against the pinned collector.
   The state machine closes a payload region on a line matching `^\t\{`. That
   token is subject-controlled: the exporter renders a subject's bytes verbatim
   at column zero, so a subject writes `\t{…}`, closes the region, and its next
   line is parsed as an authentic collector record.

Each round narrowed the pattern and each round was forged. That is the signal
this ADR responds to: the problem is not the pattern.

## The measurement that settles it

The `6d28d543` fix, and any successor to it, rests on an assumption that some
token in the stream is collector-exclusive. We tested the assumption directly
against the pinned image
(`otelcol-contrib` v0.157.0, digest `sha256:1fef9f07f04eb6775b4076ea4f817d6b7b9050e23e52941f0756ba08df798ea6`).

**Experiment E1 — is the exposure confined to the `logs` pipeline?**

The obvious cheap fix is to stop routing subject logs into the parsed stream.
We sent a hostile payload as a **span attribute value** on the `traces`
pipeline instead. The debug exporter rendered:

```
 53|      -> marker: Str(run-feas-9c31)
 54|      -> subject.note: Str(begin
 55| <TAB>{"closed": "region"}
 56| 2026-08-13T21:33:32.634Z<TAB>info<TAB>Traces<TAB>{"otelcol.signal": "traces", …, "spans": 9999}
 57|     -> marker: Str(run-feas-9c31)
 58| end)
```

Byte-identical to the log-body attack. **Removing the `logs` pipeline does not
help**, because the run marker requires `verbosity: detailed`, and detailed
verbosity renders subject-controlled *span attributes* into the same stream with
the same absence of escaping.

**The general result.** The debug exporter is line-oriented and does not escape.
Every byte a subject supplies reaches the stream unescaped, at column zero, with
its newlines intact. A subject can therefore emit **any sequence of lines the
collector can emit, in any order** — including balanced open/close sequences
that leave a line-based state machine in whatever state the subject chooses. No
grammar over these lines can distinguish collector framing from subject payload,
because at the byte level *there is no distinction to find*.

This disposes of the remaining candidate heuristics, including the strongest one
we could construct: "a `^\t{` line while no region is open is impossible." It is
defeated by a subject that re-opens a region with a record-opener line before the
genuine terminator arrives.

**Experiment E2 — does escaping restore the distinction?**

The same hostile payload through the contrib `file` exporter (present in the
pinned image, traces stability Alpha), writing newline-delimited OTLP JSON:

| property | result |
|---|---|
| physical lines produced by the hostile payload | **0 extra** |
| raw TAB bytes in the output | **none** |
| subject newlines | escaped as `\n` inside a JSON string |
| value fidelity after `JSON.parse` | exact, newlines recovered |

Record boundaries are now **structural**: a document per line, subject bytes
confined inside escaped string values that cannot produce a newline. This is a
real, non-forgeable distinction — but it does not exist in the current stream.

## Decision

### 1. Framing feasibility classification

> ### `NO NON-FORGEABLE FRAMING IN CURRENT STREAM`

The mixed console debug stream carries no token, prefix, ordering property or
state-machine invariant that subject payload cannot reproduce. Answers to the
feasibility questions are recorded in §3 of the ledger correction.

### 2. The text parser is closed to further extension as a security boundary

No further delimiter, anchor, region rule or ambiguity heuristic may be added to
`parseCollectorTelemetry` with the intent of resisting subject forgery. A more
specific regular expression is not a trust boundary. Anything in that direction
is now a defect, not a fix.

The record grammar itself (`parseTraceSummaryRecord`) remains correct for
*reading well-formed collector output* and is retained on that basis alone.

### 3. Attributable telemetry moves to a structurally framed channel

The span count, its run attribution, and the evidence retained for offline
re-derivation must come from a channel where **record framing is not expressible
in subject bytes**. The selected mechanism is newline-delimited OTLP JSON from
the collector's own `file` exporter, read from the Docker-verified collector
container. Rationale and rejected alternatives in §5–§6.

### 4. Shared parsing is not verifier independence

ADR-ERL2-024 §7.2 lets producer and verifier share a *definition*. That remains
correct **only when the definition's inputs are outside subject control**. At
`6d28d543` both authorities shared a forgeable framing definition, so the
verifier re-derived the attacker's own framing and agreed with it: the forged
`spans: 9999` artifact verified clean on its own hash-covered excerpt, with the
fixed-point check, the count-equality check, `forgedBoundaries`,
`malformedSummaries` and the coherence floor all passing.

Recorded as a standing rule: **a shared definition transmits a framing defect to
every authority that uses it.** Independence must be established at the inputs,
not at the arithmetic.

## Consequences

### 5. Selected design (implementation-ready, not implemented here)

| element | decision |
|---|---|
| trusted source | `file` exporter on the `traces` pipeline, newline-delimited OTLP JSON |
| framing | one JSON document per physical line; subject bytes escaped inside string values |
| span count | **counted structurally** from `resourceSpans[].scopeSpans[].spans[]`, never read from a rendered number |
| run attribution | the marker attribute read from parsed span attributes, compared as a decoded string |
| completeness | a trailing partial line is an incomplete document and fails closed; no textual window heuristic |
| read path | `docker cp <verified-collector>:<path>` — the Lab addresses the container it already Docker-verified |
| writable target | a **named volume** with ownership prepared for the collector's uid `10001` |
| retained material | the OTLP-JSON lines the counts derive from, bounded and hash-covered |
| debug exporter | may remain for diagnostics; it is no longer a source of truth |

Measured constraints that any implementation must honor — each established
experimentally, not assumed:

- the collector runs as **uid/gid `10001`**, so a default root-owned volume
  fails with `permission denied` at start-up;
- **`docker cp` cannot read a `tmpfs` mount** (`Could not find the file …`), so
  tmpfs is not a viable trusted transport;
- `docker cp` **does** work from a named volume once ownership is prepared —
  verified end-to-end: 585 bytes, exactly one newline, with a hostile payload
  containing raw newlines and tabs present in the span attributes;
- the collector image has no shell and no writable application directory, so
  `docker exec cat` is unavailable and ownership must be prepared by a separate
  short-lived container.

### 6. Rejected alternatives

| alternative | why rejected |
|---|---|
| another delimiter / stricter anchor | E1: subject reproduces any line shape. Forged in three successive rounds. |
| drop the `logs` pipeline from `debug` | E1: span attributes at `verbosity: detailed` carry the same attack. |
| `verbosity: basic` | Removes payload regions **and** run attribution — the marker rides in the detailed dump. Attribution is a required property. |
| "`^\t{` while no region is open" heuristic | Defeated by re-opening a region before the genuine terminator. |
| Docker `--timestamps` | Docker prefixes **every line**, continuations included; it carries no record-boundary information. |
| Docker multiplexed log API frames | Frames stream chunks, not collector records; the `json-file` driver splits on newlines, so write boundaries are not preserved. |
| collector self-metrics | No run attribution; cannot bind a count to this run's marker. |
| host bind mount for the trace file | Adds host filesystem exposure the overlay deliberately avoids. |

### 7. Impact analysis — why this is not a bounded remediation

| surface | impact |
|---|---|
| `erl2-otelcol-extras.yaml` | new exporter + traces pipeline change → file SHA-256 changes |
| `erl2-overlay.yaml` | new named volume + ownership preparation → file SHA-256 changes, and the overlay hash is pinned |
| `substrate-lock.json` | configuration digests change; an ownership-preparation image is a **new pinned image** requiring qualification, SBOM and provenance artifacts |
| `composeDriver.ts` | new `docker cp` verb in the driver's command surface |
| `telemetryObservation.ts` | parser replaced; `runAttributedBatches`, `collectorWindowComplete`, `forgedBoundaries` and three of four window reason codes lose their meaning |
| ERL2-C-160 | `log_excerpt` changes content type and semantics — a **contract change**, where the previous two packages changed none |
| canonicalization / privacy | subject bytes retained as JSON require a fresh NFC and retention analysis |
| `telemetryDerivation.ts` | verifier re-derivation rewritten against the new material |
| tests / fixtures | `attributableTelemetry.test.ts` (1 297 lines), `composeSubstrate.test.ts`, `composeStub.ts` |
| campaign | several of the 18 `telemetryObservation.ts` controls and 6 verifier controls target code that ceases to exist → genuine removals/replacements, not additions |

A new pinned substrate image with qualification artifacts is, on its own, a
separate package under this repository's substrate-qualification discipline.

### 8. Status of implementation

**Not implemented in this package, deliberately.** The two options available
inside a bounded remediation were (a) another textual heuristic, which §2
forbids and which the evidence shows would be forged again, or (b) a substrate,
driver, contract and campaign change of the scope in §7. Forcing (b) into a
remediation package would change a contract and the substrate lock under a
commit message about parser hardening.

**The `6d28d543` defect therefore remains open.** Until the channel lands, a
subject that can influence collector telemetry can turn an unavailable
observation into an observed one carrying a span count it chose, and that
artifact verifies offline. No campaign, clean gate, publication, merge or
Qualiber run may treat attributable telemetry as trustworthy.
