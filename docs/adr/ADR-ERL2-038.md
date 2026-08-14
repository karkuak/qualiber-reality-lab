# ADR-ERL2-038 — attributable telemetry needs a trusted channel, not a better parser

- **Status:** accepted (decision), **implementation sequenced** — see §8–§11
- **Date:** 2026-08-13
- **Amended:** 2026-08-13 with corrections **R1–R8** (§9), required by independent
  design review `reality-lab-ff2c8c0-adr-038-design-review.md`
  (SHA-256 `2af8898ef4baaca7ec86772d2881426d561c6c608987c5e3b27f373b31c56453`,
  verdict `ADR-ERL2-038 APPROVED WITH REQUIRED DESIGN CORRECTIONS`). Decisions
  §1–§4 were approved unchanged. §5 is corrected by §9; nothing measured in §§
  "The measurement that settles it" or §6 is altered.
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
| retained material | the OTLP-JSON lines the counts derive from, bounded and hash-covered — **bound made achievable by R2** |
| debug exporter | may remain for diagnostics **only on a physically separate channel — R3**; it is no longer a source of truth |

> **§5 is corrected by §9.** Two rows above and two of the measured constraints
> below were scope-limited or wrong, and the independent review re-measured
> them. Read §5 with §9: `writable target` no longer requires an ownership
> preparation container (**R1**), `retained material` is unachievable without
> pre-export field minimization (**R2**), and `debug exporter` is safe only
> under the separation rule (**R3**).

Measured constraints that any implementation must honor — each established
experimentally, not assumed:

- the collector runs as **uid/gid `10001`**, so a default root-owned volume
  fails with `permission denied` at start-up;
- **`docker cp` cannot read a `tmpfs` *mount*** (`Could not find the file …`),
  so a `--tmpfs` / `--mount type=tmpfs` target is not a viable trusted
  transport. **Scope-limited — corrected by R1:** this does *not* generalize to
  a named volume whose `local` driver options specify a tmpfs backing. Docker
  reports that as `"Type": "volume"`, and the review read it with `docker cp`;
- `docker cp` **does** work from a named volume once ownership is prepared —
  verified end-to-end: 585 bytes, exactly one newline, with a hostile payload
  containing raw newlines and tabs present in the span attributes;
- the collector image has no shell and no writable application directory, so
  `docker exec cat` is unavailable. **Corrected by R1:** the conclusion drawn
  from this — that "ownership must be prepared by a separate short-lived
  container" — does not follow. Ownership is expressible declaratively as
  volume options, and no helper container is required. The image observation
  itself stands and was independently reproduced: `docker export` of the pinned
  image shows a filesystem that is entirely root-owned, with no shell, no
  `/tmp`, and no directory owned by uid 10001.

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

## 9. Corrections R1–R8 (independent design review)

Each correction below was required by measurement, not preference. Nothing in
§§1–4 changed; §5 is read through this section.

### R1 — no helper image

A separate ownership-preparation image is **unnecessary and is removed from the
design**. The measured mechanism is a Docker **named volume** created through
the `local` driver with `type=tmpfs` and `o=uid=10001,gid=10001,mode=0700`. The
collector starts with write access, `docker cp` reads the resulting file, and
`docker inspect` reports the mount as `"Type": "volume"`, which is why
`docker cp` can read it where a `--tmpfs` mount it cannot.

Removed from the critical path entirely: the helper image, its digest pin, its
SBOM, its provenance, its qualification tests, and its lifecycle and cleanup.
No new pinned image is introduced by the trusted channel. The exporter and the
minimizing processor are both components of the already-pinned collector
`sha256:1fef9f07f04eb6775b4076ea4f817d6b7b9050e23e52941f0756ba08df798ea6`.

Reproduced independently: a fresh named volume **without** ownership options
still fails closed at start-up (`open /trusted/traces.jsonl: permission
denied`, exit 1), so the problem §5 identified is real — only its remedy was
wrong.

The volume is **not** implemented here. It is Package 2 (§10).

### R2 — minimize fields before the trusted export

One realistic unminimized record measured **1 001 415 bytes** against the
retained-artifact cap of **262 144**. Under demote-rather-than-truncate that
makes the channel unusable on realistic input: every run would retain `absent`.

The trusted pipeline must therefore apply a **strict allowlist and bounded
field lengths before export** — measured with the collector's own `transform`
processor using `keep_keys` and `truncate_all`. The same 1 MB input reduced to
**~1 130 bytes**, and a 410 KB realistic-shaped input to **~3 190 bytes**,
while preserving the structural span count and 4/4 run-marker attribution. The
same reduction removed a session-token attribute, `host.name`, and every other
attribute not named by the allowlist.

Consequences:

- attributes are retained because the allowlist names them, never because they
  are available;
- the ADR §7 claim that "subject bytes retained as JSON require a fresh NFC and
  retention analysis" is **superseded**: no subject attribute value survives
  minimization except the bounded marker-bearing field;
- the contract states the **precise bounded fields** in which transformed
  subject-derived values may remain. It does not claim subject bytes are
  absent.

### R3 — physical separation from debug output

The debug exporter may remain for diagnostics **only on a channel physically
separate from the trusted export**. This is a decision, not a remark.

Measured: with a structurally framed trusted exporter and `debug` sharing one
stdout, a subject **log body** forged a complete, schema-valid trusted record
whose structural span count read **9999**. Structural framing does not survive
a shared byte stream with an exporter that renders subject bytes unescaped.

Forbidden:

- trusted structured records and debug output sharing one byte stream;
- a verifier accepting structured records recovered from the mixed debug
  stream;
- debug output serving as fallback authority;
- silent downgrade to debug evidence.

### R4 — cross-run substitution protection

The v2 artifact binds, and the verifier checks, the identities that make
another run's records unusable here: the run identity, the environment
identity, the collector image and configuration identity, and the trusted
channel identity. Records carrying a foreign run marker, or a mixture of
markers, are refused rather than ignored — an artifact that silently skips
foreign records still counted their bytes as this run's evidence.

### R5 — finalization and freeze

An authoritative artifact must be flushed, closed, complete, frozen and
hash-bound before it is read for evidence, and the contract must carry the
proof rather than a producer boolean:

- writing stops when the collector's trusted exporter has flushed and the read
  is taken before `teardown_started`, preserving the existing liveness proof;
- completeness is established structurally — every physical line parses, and
  the byte sequence terminates on a record boundary;
- the artifact becomes immutable by being retained inline and covered by
  `core_hash`, exactly as the v1 excerpt was, so one freeze carries both the
  counts and the bytes they derive from;
- a partial final record is detectable and fails closed;
- producer and verifier consume **the same exact retained bytes**, and the
  retained byte length and content digest are recomputed by the verifier;
- crash before freeze is represented as `absent` with a finalization reason
  code, never as a zero.

Package 1 defines this proof shape. Package 2 produces it.

### R6 — rotation forbidden

For the bounded MVP: **`rotation: forbidden`**. One bounded, run-scoped
artifact, one segment.

Rotation reintroduces the window-completeness ambiguity that produced this
defect in the first place, and field minimization (R2) removes the size
pressure that would have motivated it. If the artifact exceeds the contract
cap the observation **fails closed**; a completed artifact is never silently
truncated. A segmented design with an ordered, integrity-bound manifest remains
available if a future measurement shows minimization is insufficient, and would
require its own amendment.

### R7 — control migration, not control removal

`telemetry-record-payload-is-not-summary-text` mutates the payload-region
*open* decision, an enforcement point that ceases to exist when the mixed text
parser stops being authoritative. Its underlying security property is **mapped,
not dropped**, onto the trusted channel:

| old property | new enforcement point |
|---|---|
| subject payload cannot be read as a record | subject payload cannot create a structured physical record |
| subject payload cannot supply a count | subject payload cannot alter trusted record type, count or attribution |

The old control is removed only in the package that actually removes its
enforcement point (Package 3), never before.

### R8 — authority migration, with no dual-authority window

ERL2-C-160 v2 is the **only** format authoritative for a new trusted telemetry
claim. v1:

- remains parseable, for historical compatibility;
- remains verifiable only within its original historical scope;
- may **not** authorize a new run or a new claim;
- may **not** serve as fallback when v2 is absent, invalid or refused.

Absence of a valid v2 record is a refusal, not a downgrade. The decision is
taken at **one named enforcement point**, not scattered across consumers, so
that no ordering of packages opens a window in which both formats can authorize
evidence.

## 10. Implementation packages

| package | scope | status |
|---|---|---|
| **1 — contract and authority** | ERL2-C-160 v2 artifact format, validation, structured-record recomputation, the single authority decision point, fixtures and controls | **this package** |
| **2 — collector and storage** | trusted `file` exporter, the R2 minimizing processor, the tmpfs-backed named volume, overlay, extras, substrate lock | not started |
| **3 — driver, producer, verifier integration** | volume lifecycle, `docker cp` read path, live freeze, producer/verifier wiring, removal of the mixed-stream parser and of the R7 control | not started |

Package 3 may be combined with Package 2 only if the combined change can be
reviewed without an intermediate state in which both channels can authorize
evidence.

**The trusted channel does not exist until Package 2 and Package 3 land.**
Defining its contract does not create it, and no artifact conforming to v2 has
been produced by a collector.

## 11. Earliest exploratory Qualiber milestone

After Packages 1–3, targeted security tests, and a focused independent review
with zero known P0/P1 findings, **one bounded Qualiber run may be authorized**,
labelled unscored, unauthenticated, development-tier, diagnostic rather than
certification, carrying no release decision, and with findings requiring
independent reproduction.

That milestone sits **before** the publication-grade full campaign, the clean
gate, and publication or merge, and substitutes for none of them. It may not be
taken while the mixed-stream parser is still authoritative.
