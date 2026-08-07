# Ledger — EQ-L-004 … EQ-L-009: the attributable-telemetry package, remediated

**Date:** 2026-08-07 · **Branch:** `codex/telemetry-canonicalization-refusals`
off `main` at `2e943a6` · **Findings:** [issue #12](https://github.com/karkuak/qualiber-reality-lab/issues/12)
· **ADR:** [ADR-ERL2-035](../adr/ADR-ERL2-035.md)

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
| Executable coverage of that path | **none** — no CI run had ever executed it | 16 `ATTR-TELEM-RETAIN` cases over a real `ArtifactStore`, on every `npm test`, no daemon required |
| Negative controls on it | **none** | 12, one per guard, every one of them killing |
| `ERL2-C-160`, every schema, every golden | — | byte-identical |

The eight reason codes, and what each says, are tabulated in ADR-ERL2-035 §2.

**The excerpt is never normalized.** A demoted record carries no excerpt at all,
so no retained field holds a rewritten copy of the collector's bytes. The
argument is in ADR-ERL2-035 §2 and §10, made rather than assumed, because the
alternative — quietly NFC-normalizing to make the hash succeed — is the exact
move this repository's review history exists to prevent.

**The canonicalizability question is answered by running the canonicalizer.**
`isCanonicalizableString` / `isCanonicalizableNumber` in `packages/integrity`
call `canonicalString` / `canonicalNumber` and read the refusal, so the
precondition cannot drift from the function it guards. Restating "NFC, no
unpaired surrogate" in `packages/core` was rejected for that reason.

### 2.1 The contract question, decided (ADR-ERL2-035 §3)

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
makes the property measurable, which is what the twelve controls below then
measure.

## 4. Negative controls

Twelve new controls in `scripts/negative-control.mjs`, all against
`packages/core/src/environment/telemetryObservation.ts`, all `expect: "fail"`,
each naming the exact case that must fail. The standing `NC-CAMPAIGN` targeting
test proves all 120 controls still land on their declared bytes on every
`npm test`. (`docs/ledger/negative-controls.json` is the harness's generated
record and is gitignored by design; registration lives in the harness, which is
committed.)

`npm run negative-control -- telemetry-retention,telemetry-excerpt,telemetry-service-name,telemetry-count,telemetry-collector`
— **12 of 120 selected, 12 agreed, 0 disagreed, 0 harness errors.** Scored
against `92f30fd` in a disposable worktree; the working tree was proven
byte-identical afterwards.

| Control | Result |
| --- | --- |
| `telemetry-retention-reentry` | **40 pass / 1 fail — killed** |
| `telemetry-excerpt-retention-bound` | **40 pass / 1 fail — killed** |
| `telemetry-excerpt-canonicalizable` | **40 pass / 1 fail — killed** |
| `telemetry-service-name-cardinality` | **40 pass / 1 fail — killed** |
| `telemetry-service-name-length` | **40 pass / 1 fail — killed** |
| `telemetry-service-name-canonicalizable` | **39 pass / 2 fail — killed** |
| `telemetry-count-representable` | **39 pass / 2 fail — killed** |
| `telemetry-collector-service-id` | **40 pass / 1 fail — killed** |
| `telemetry-collector-digest-cardinality` | **40 pass / 1 fail — killed** |
| `telemetry-collector-identity-bound` | **40 pass / 1 fail — killed** |
| `telemetry-collector-identity-canonicalizable` | **40 pass / 1 fail — killed** |
| `telemetry-retention-failures-routable` | **40 pass / 1 fail — killed** |

`telemetry-retention-reentry` is the one EQ-L-005 asked for by name: deleting
the read-what-you-wrote branch makes a resumed retention re-observe, take a
fresh `observed_at`, and re-freeze different bytes at the same logical path. The
suite notices in seconds. It could not have, before this package.

### 4.1 The thirteenth control, which failed on its first run

Recorded because the brief asked for anything that failed first time, and
because it is the campaign catching this package's own new code hours after it
was written.

The first campaign scored **12 of 13**. `telemetry-count-canonicalizable` came
back **41 pass / 0 fail** against `expect: "fail"` — `tests_passed_unexpectedly`,
the harness's name for a guard that is not load-bearing. It was right: the guard
was an `isCanonicalizableNumber(count)` call sitting immediately above the
contract's range check, and every value the canonicalizer refuses — `Infinity`,
`NaN`, a non-integer, an unsafe integer — already fails
`Number.isInteger(count) && 0 <= count <= 100 000 000`. Disabling it changed
nothing because it decided nothing.

The guard was **removed**, not re-declared `expect: "pass"`. A guard nothing can
kill reads to the next person as a guard that may be deleted, and the harness
ledger records that reading as the most expensive way to be wrong. Both of its
cases survive under `telemetry-count-representable`, which kills — the two-fail
row above is those two cases. `isCanonicalizableNumber` was removed from
`packages/integrity` in the same change rather than left as an unused export
(ADR-ERL2-035 §5.1).

## 5. Documentation findings

| Finding | Disposition |
| --- | --- |
| **EQ-L-006** — `README.md` states the receipt claim with none of the three load-bearing conjuncts | Restated bounded: a **valid** Compose-driver run, **whose archetype declares a metric evidence source**, **whose exercising journey step succeeded**. Says the conditions are load-bearing and that a run failing any of them supports no receipt claim at all, and points at `permitted-claims.md` for the statement at its width rather than paraphrasing it again. |
| **EQ-L-007** — ADR-ERL2-033 §4 asserts coverage the ledger says it does not have | Corrected in **ADR-ERL2-035 §7**, which supersedes that one parenthetical and states the replacement in full. The ADR is accepted, and this repository supersedes accepted ADRs rather than rewriting them (ADR-ERL2-017 supersedes ADR-ERL2-016 §Consequences only). Correcting it in the ledger alone was considered and rejected: a reader who opens the ADR without the ledger beside them — which is the reading the finding is *about* — would still meet the overclaim. |
| **EQ-L-008** — the telemetry ledger §3 still calls the excerpt an `ArtifactRef` | §3 fixed to describe the inline bounded string it is, pointing at §7 for why the first shape was abandoned. §7's line 150 is **left alone**: it narrates the original shape historically and is correct. |
| **EQ-L-009** — the campaign anchor `2c69e9c` is unreachable from `main` | **Both** recorded: run at `2c69e9c`, replayed by the pre-merge rebase as `a5ad6e6`, with a pointer to the PR #10 correction comment's full remap. Substituting the new hash would misstate what was measured where. |
| **EQ-L-009, related** — §9's "untested on this host" reads as current | A dated note appended, not a rewrite: the assertion did later execute, reported in the second PR #10 comment. The ledger records what was true when written. |

## 6. The systemic finding (issue #12 §B.5), decided

The evaluator verified from run `31178507421` that **no CI run has ever executed
the producer's retention path**. The decision is recorded in full in
ADR-ERL2-035 §6 and is **both halves**:

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

A substrate-bearing CI lane was **not** added here, and ADR-ERL2-035 §6 records
why it is a package of its own rather than a line in this one. What is not
acceptable, and what this decision ends, is documents describing that path as
verified while nothing verified it.

## 7. The live confirmation

**A Docker daemon was available (29.5.3), and a live confirmation was made.**
EQ-L-004's reproduction is a constructed unit-level case; this is a real Compose
journey — real containers, a real collector, a real OpenTelemetry SDK — whose
collector output carried a decomposed accent on a marker-bearing line.

Driven against a **locally patched, never-committed** reference adapter that
sent one extra request carrying `cafe` + U+0301 raw. The patch was reverted, the
tree proven byte-identical, and every artifact below is from the run, not from a
fixture:

```
NFD LINES IN COLLECTOR LOG (5):
   "     -> user_agent.original: Str(erl2_run=019fdd33-…-0f28451e8afd café)"   # e + U+0301
destroy:      {"exit":0,"data":{"passed":true,"residue_after_teardown":0,"checks":5}}
residue:      {"containers":[],"networks":[],"volumes":[]}                      # re-inspected independently
observation:  {"evidence":"absent","reason_code":"telemetry_excerpt_not_canonicalizable","log_excerpt":"(absent)"}
validity:     {"status":"invalid","failedGates":["attributable-telemetry-retained"],"findings":1}
finalize-generic: exit 8  EVALUATOR_INVALID_VALIDITY_IN_GENERIC_INDEX
cancel:       exit 12  state=invalidated  cleanup_variant=environment  cleanup_status=attempted_succeeded
```

Every clause of the invariant, observed rather than argued: `destroy` completed
instead of throwing, both containers and the network were destroyed, the
observation demoted with its specific reason code and **carries no excerpt** —
the collector's bytes were not normalized into hashability — the gate refused it
with one invalidity finding, and the run reached the `invalidated` terminal with
environment cleanup recorded `attempted_succeeded`. Before the fix this run
wedged at `destroy` on an untyped `CanonicalizationError`, with both containers
still live.

`finalize-generic` refusing an invalid run is the design's refusal for **any**
failing environment gate (`assertValidityAdmitsGenericIndex`), not something
this package introduced; the terminal is then the invalid record, which is what
`cancel` froze.

### 7.1 What the exact `url.full` vector did, and did not, show

Two earlier attempts put the accent in the request target rather than a header.
Both are recorded because the negative result is informative:

- The reference subject's PHP auto-instrumentation **percent-encodes** the
  target before recording it: `url.full` came back as
  `…?erl2_run=…&n=cafe%CC%81`, which is ASCII. So the *shipped reference
  subject* cannot reach EQ-L-004 through `url.full`, whatever bytes are sent.
- The vector is not closed in general. `user_agent.original` records the header
  verbatim, and that is what this confirmation used. Any span attribute a
  subject fills with bytes the instrumentation does not re-encode reaches the
  same place — as does `OTEL_SERVICE_NAME`, with no excerpt involved at all.
  The evaluator's framing stands; the reference subject just happens not to be
  the subject that trips it.

### 7.2 A separate defect found while doing this, outside issue #12's scope

The first probe declared its egress with an NFD URL, through the ordinary
`context.attemptEgress({ url })` seam every adapter uses. That failed:

```
execute-subject: [{"code":"LAB_UNEXPECTED_FAILURE",
                   "message":"unexpected Lab failure while running execute-subject: string is not NFC"}]
```

Same class as EQ-L-004 — a subject-supplied string reaching the canonicalizer
with nothing validating it first — in a different subsystem: the **adapter
host's** egress adjudication, not the telemetry retention path. It is milder:
it surfaces as a typed `LAB_UNEXPECTED_FAILURE` at `execute-subject` rather than
as an untyped throw inside `destroy`, so it does not by itself strand a run
past the point where teardown would have run.

**Not fixed here**, deliberately: it is outside the scope issue #12 defines, it
is in a different subsystem with its own owner, and folding it in would make this
remediation a different change than the one under review. It is reported to the
evaluator workspace instead.


## 8. Verification

| Check | Result |
| --- | --- |
| `npm install && npm run build && npm test`, **with a live Docker daemon and the pinned archive present** | **1156 tests, 1153 pass, 0 fail, 3 skipped.** `COMPOSE-E2E: a run reaches an offline-valid terminal through a real Compose substrate` **passed** — the ordinary live path is unchanged by this package: a collector emitting ASCII still freezes `evidence: "observed"` and the run still reaches a valid terminal |
| `npm run evidence:verify` | **green — 832 files pinned, 7 excluded**, byte-identical to the goldens |
| `git diff -- fixtures/golden` | empty. **No golden changed**, as expected: a fake-driver run produces no observation, so no golden ever carried one |
| `git diff 2e943a6 HEAD -- packages/contracts` | empty. `ERL2-C-160` and every schema are byte-identical |
| `git diff 2e943a6 HEAD -- docs/claims/permitted-claims.md` | empty. **No claim moved** |
| negative-control campaign | 12 of 120 selected, **12 agreed, 0 harness errors**, tree byte-identical afterwards (§4) |
| live Compose confirmation | **made** — §7 |

The three skips are the two `EXTERNAL-SUBJECT-E2E` cases (no external adapter
entry was configured) and `COMPOSE-ADV: the RENDERED configuration publishes one
loopback port and nothing else`, which needs the *extracted* upstream tree rather
than the archive; `environments/otel-demo/upstream/` is git-ignored, and the
disposable worktree this package was built in carried only the archive. All three
skip loudly and none of them is evidence. An earlier run of the same suite with
no archive at all was also green at 1156 / 1151 / 0 / 5.

## 9. What stays open

- **The producer gate's *wiring* is still unmeasured.** `telemetry-producer-gate-wiring`
  remains `expect: "pass"` / `no_kill_as_declared`. Nothing in this package
  changed that, and ADR-ERL2-035 §7 now states it in the ADR as well as the
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
