# Ledger — EQ-L-004 … EQ-L-009: the attributable-telemetry package, remediated

**Date:** 2026-08-07 · **Branch:** `codex/telemetry-canonicalization-refusals`
off `main` at `2e943a6` · **Findings:** [issue #12](https://github.com/karkuak/qualiber-reality-lab/issues/12)
· **ADR:** [ADR-ERL2-034](../adr/ADR-ERL2-034.md)

This is a remediation. It removes a defect and **adds no claim**: the ceiling
stays T1, development tier, non-blind selection, development-signed
self-qualified substrate. `docs/claims/permitted-claims.md` is unchanged.

---

## 1. What was wrong, confirmed before anything was changed

Every link of the evaluator's chain was re-derived here at `2e943a6` against the
built packages, in a scratchpad outside the checkout, before one line moved:

```
service_names (all ASCII): ["quote"]
excerpt is a fixed point  : true
excerpt is NFC            : false
post-d803e66 shape (excerpt inline)  : THREW CanonicalizationError: string is not NFC  [Erl2Error: false]
pre-d803e66 shape (excerpt as a file): coreHash OK
control: plain ASCII excerpt         : coreHash OK
service.name of 300 chars            : Erl2Error SCHEMA_VALIDATION_FAILED  routableByDestroy=false
300 distinct service.name values     : Erl2Error SCHEMA_VALIDATION_FAILED  routableByDestroy=false
```

So: `coreHash(base)` refuses a non-NFC excerpt with a `CanonicalizationError`,
which is not an `Erl2Error`; `routed()` rethrows it because `destroy` passes only
`[TEARDOWN_FAILED]`; the throw precedes `teardown_started`, so no lifecycle
event, no emergency cleanup, no `driver.destroy`, and a live substrate. The two
schema triggers are typed but equally unroutable. All confirmed, none assumed.

**One trigger the issue does not name, found while reproducing the three it
does.** `parseCollectorTelemetry` sums `Number.parseInt` over collector text, and
a `Traces` line whose `"spans"` digit run is long enough parses to `Infinity`:

```
spans parsed from a 400-digit count: Infinity
non-finite span count              : THREW CanonicalizationError: non-finite number rejected: Infinity  [Erl2Error: false]
```

Same defect class, through the number path rather than the string path, and
reachable by a subject that can put text on a line the `Traces` pattern matches.
It is fixed by the same decision and has its own reason code and its own control.

### 1.1 Both framings, because both are honest

- **A regression `d803e66` introduced.** The reproduction above shows the
  pre-`d803e66` shape hashing cleanly on the same input: when the excerpt was a
  separate file its bytes never reached the canonicalizer. The crash-window fix
  is right and stays — one artifact, one freeze — but it moved
  subject-controlled bytes into a hash path nobody re-examined, and closing one
  failure mode opened another.
- **A mundane trigger, not an adversarial one.** macOS stores filenames
  decomposed, so a subject serving a URL derived from an accented filename emits
  NFD with nobody attacking anything. The ERL2-OQ-009 interim path this Lab
  *endorses* is exactly "the adapter serves its own application on loopback",
  whose URLs land in `url.full` — a marker-bearing field, which is precisely why
  the excerpt retains that line. One accented filename is enough.
  `OTEL_SERVICE_NAME` reaches the same place with no excerpt involved.

**Severity: liveness and residue, not attestation.** Nothing false was ever
signed. The run could reach no terminal at all and the substrate leaked.

## 2. What changed

| Surface | Before | After |
| --- | --- | --- |
| Preconditions of freezing | the excerpt's *length* only | every precondition the canonicalizer and ERL2-C-160 place on the `observed` branch — NFC and surrogates, string lengths, cardinality, numeric range — each answered before `base` exists, each with its own `reason_code` |
| A precondition that fails | untyped `CanonicalizationError`, or unroutable `SCHEMA_VALIDATION_FAILED` | an honest `absent` observation the gate refuses and the offline verifier refuses |
| Any other retention failure | rethrown by the CLI; no terminal, live substrate | `Erl2Error(TEARDOWN_FAILED)` carrying the original code; routed to receipt-backed emergency cleanup and an invalid terminal |
| Where the retention path lives | a private method of `EnvironmentRun`, reachable only through a live Compose run | `retainAttributableTelemetryObservation` in `telemetryObservation.ts`; `EnvironmentRun.destroy` calls it and decides nothing else |
| Executable coverage of that path | **none** — no CI run had ever executed it | 17 `ATTR-TELEM-RETAIN` cases over a real `ArtifactStore`, on every `npm test`, no daemon required |
| Negative controls on it | **none** | 13, one per guard |
| `ERL2-C-160`, every schema, every golden | — | byte-identical |

The eight reason codes, and what each says, are tabulated in ADR-ERL2-034 §2.

**The excerpt is never normalized.** A demoted record carries no excerpt at all,
so no retained field holds a rewritten copy of the collector's bytes. The
argument is in ADR-ERL2-034 §2 and §10, made rather than assumed, because the
alternative — quietly NFC-normalizing to make the hash succeed — is the exact
move this repository's review history exists to prevent.

**The canonicalizability question is answered by running the canonicalizer.**
`isCanonicalizableString` / `isCanonicalizableNumber` in `packages/integrity`
call `canonicalString` / `canonicalNumber` and read the refusal, so the
precondition cannot drift from the function it guards. Restating "NFC, no
unpaired surrogate" in `packages/core` was rejected for that reason.

### 2.1 The contract question, decided (ADR-ERL2-034 §3)

`reason_code` is `{"type": "string", "minLength": 1, "maxLength": 128}` on
ERL2-C-160 — **not an enum**. Nothing in the schema, the producer, the gate or
the offline verifier enumerates its values; the verifier reports the code in a
message and never matches on it. So the frozen-contract question — compatible
widening, or new version? — does not arise: a new value is a new *instance* of an
already-open field. No artifact already written changes meaning, no reader's
acceptance set narrows, `environment.schema.json` is byte-identical to `2e943a6`,
and `attributable-telemetry-observation/v1` stays `v1`.

Checked rather than assumed, and recorded because "the field was designed open"
is only credible if someone looked.

## 3. EQ-L-005 — the coverage gap, which is the finding that matters most

The crash-window fix had zero executable coverage: deleting the
read-what-you-wrote branch reintroduced the `ARTIFACT_ALREADY_FROZEN` wedge with
a fully green suite. That is *verbatim* the condition
[`qualiber-integration-telemetry.md`](qualiber-integration-telemetry.md) §7 gives
for why the original defect went unnoticed — *"the suite was green in both
shapes."* Fixing EQ-L-004 without closing it would have repeated the package's
own recorded mistake twice in one package.

The cause was structural: the retention path lived inside a private method
reached only through a live Compose run, so nothing without a Docker daemon
could execute it. Moving it to `retainAttributableTelemetryObservation` — driven
in `ATTR-TELEM-RETAIN` over a real `ArtifactStore` and a stand-in observer —
makes the property measurable, which is what the thirteen controls below then
measure.

## 4. Negative controls

Thirteen new controls in `scripts/negative-control.mjs`, all against
`packages/core/src/environment/telemetryObservation.ts`, all `expect: "fail"`,
each naming the exact case that must fail. The standing `NC-CAMPAIGN` targeting
test proves all 121 controls still land on their declared bytes.

<!-- CAMPAIGN TABLE -->

## 5. Documentation findings

| Finding | Disposition |
| --- | --- |
| **EQ-L-006** — `README.md` states the receipt claim with none of the three load-bearing conjuncts | Restated bounded: a **valid** Compose-driver run, **whose archetype declares a metric evidence source**, **whose exercising journey step succeeded**. Says the conditions are load-bearing and that a run failing any of them supports no receipt claim at all, and points at `permitted-claims.md` for the statement at its width rather than paraphrasing it again. |
| **EQ-L-007** — ADR-ERL2-033 §4 asserts coverage the ledger says it does not have | Corrected in **ADR-ERL2-034 §7**, which supersedes that one parenthetical and states the replacement in full. The ADR is accepted, and this repository supersedes accepted ADRs rather than rewriting them (ADR-ERL2-017 supersedes ADR-ERL2-016 §Consequences only). Correcting it in the ledger alone was considered and rejected: a reader who opens the ADR without the ledger beside them — which is the reading the finding is *about* — would still meet the overclaim. |
| **EQ-L-008** — the telemetry ledger §3 still calls the excerpt an `ArtifactRef` | §3 fixed to describe the inline bounded string it is, pointing at §7 for why the first shape was abandoned. §7's line 150 is **left alone**: it narrates the original shape historically and is correct. |
| **EQ-L-009** — the campaign anchor `2c69e9c` is unreachable from `main` | **Both** recorded: run at `2c69e9c`, replayed by the pre-merge rebase as `a5ad6e6`, with a pointer to the PR #10 correction comment's full remap. Substituting the new hash would misstate what was measured where. |
| **EQ-L-009, related** — §9's "untested on this host" reads as current | A dated note appended, not a rewrite: the assertion did later execute, reported in the second PR #10 comment. The ledger records what was true when written. |

## 6. The systemic finding (issue #12 §B.5), decided

The evaluator verified from run `31178507421` that **no CI run has ever executed
the producer's retention path**. The decision is recorded in full in
ADR-ERL2-034 §6 and is **both halves**:

1. **The path is now exercised in CI**, without a substrate. The
   observe/validate/demote/freeze sequence and its re-entry branch run on every
   `npm test` on every runner. That is the part EQ-L-004 lived in.
2. **What remains is recorded as a known limitation with its consequence
   stated.** A *live* Compose journey still runs nowhere but an operator's host:
   `ComposeEnvironmentDriver.observeAttributableTelemetry` — the Docker
   verification of the collector container and the reading of its logs — has no
   CI execution, and its coverage is `composeSubstrate.test.ts` over a stand-in
   daemon. **Consequence, stated plainly: a defect that lives in the driver's
   interaction with a real Docker daemon is not discoverable by this
   repository's CI, and would be found only by an operator run or by review.**

A substrate-bearing CI lane was **not** added here, and ADR-ERL2-034 §6 records
why it is a package of its own rather than a line in this one. What is not
acceptable, and what this decision ends, is documents describing that path as
verified while nothing verified it.

<!-- LIVE CONFIRMATION -->

## 8. Verification

<!-- VERIFICATION -->

## 9. What stays open

- **The producer gate's *wiring* is still unmeasured.** `telemetry-producer-gate-wiring`
  remains `expect: "pass"` / `no_kill_as_declared`. Nothing in this package
  changed that, and ADR-ERL2-034 §7 now states it in the ADR as well as the
  ledger. Driving it needs a live Compose substrate whose collector receives
  nothing, which the ordinary suite must never require.
- **No live Compose journey runs in CI.** §6.2, with its consequence stated.
- **The `absent` branch's own inputs are not demoted, only routed.** `marker`
  and `reason_code` ride both branches, so material carrying a marker the Lab
  cannot freeze has no honest `absent` to demote *to*. That case leaves as a
  routable `TEARDOWN_FAILED` and reaches an invalid terminal by emergency
  cleanup — worse than a demotion, far better than a wedge, and measured by
  `telemetry-retention-failures-routable`. The Compose driver sets the marker to
  the run id, which is Lab-derived and always canonicalizable, so no shipped path
  reaches it today.
- **`run_attributed_records` counts marker occurrences, not records** (the
  evaluator's §C). Sound at the `>= 1` threshold the gate and verifier use, so
  no claim is wrong; not renamed here, because renaming a contract field with no
  defect behind it is a change that should carry its own reason.
- **The shared parser cannot be checked against the collector it claims to come
  from** (the evaluator's §B.1 residual). Unchanged by this package and not
  overclaimed anywhere.
