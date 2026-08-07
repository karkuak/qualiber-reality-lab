# ADR-ERL2-034 — collector bytes the Lab cannot freeze demote to an honest `absent`; retention failures are routable

- **Status:** accepted
- **Date:** 2026-08-07
- **Deciders:** Lab Architecture, Environment Governor, Verification Audit
- **Supersedes:** [ADR-ERL2-033](ADR-ERL2-033.md) §4, one sentence only — the
  parenthetical *"each is separately measured by its own negative control"*
  about the two enforcement points. Every decision in ADR-ERL2-033 stands
  unchanged and is re-affirmed below; §7 records what replaces that sentence
  and why the ADR is corrected here rather than edited in place.
- **Builds on:** [ADR-ERL2-033](ADR-ERL2-033.md) (the observation, its gate and
  its crash window), [ADR-ERL2-016](ADR-ERL2-016.md) (discriminated evidence:
  only `observed` counts), [ADR-ERL2-024](ADR-ERL2-024.md) (two enforcement
  points at different trust boundaries)
- **Normative revision:** `2.0.0-draft.13` (unchanged)
- **Claim ceiling:** unchanged. This is a remediation. It removes a defect and
  adds no claim.

---

## 1. Context — one accented character was enough

The independent evaluator's EQ-L-004 (issue #12) found, and this workspace
reproduced at `2e943a6` before changing anything, that subject-controlled
collector bytes could make `destroy()` throw an error nothing catalogued,
strictly before `teardown_started`.

The chain, confirmed one link at a time:

1. `freezeTelemetryObservation` inlined `log_excerpt: material.excerpt` — raw
   collector log text — into `base`, alongside `service_names` parsed out of the
   same output. Both are subject-influenced.
2. `coreHash(base)` runs the canonicalizer, and `canonicalString` refuses a
   non-NFC string fail-closed with a `CanonicalizationError`. Nothing validated
   the excerpt first.
3. `CanonicalizationError extends Error`, **not** `Erl2Error`.
4. `routed()` rethrows anything that is not an `Erl2Error` carrying one of the
   phase's codes, and `destroy` passes exactly `[TEARDOWN_FAILED]`.

So the throw escaped before `this.ws.lifecycle.append({ eventType:
"teardown_started" })`. No lifecycle event, so the receipt-backed emergency
cleanup that catch exists to reach was never entered; `this.driver.destroy(...)`
never ran, so the run project, its network, both containers and the published
loopback port stayed live; and retry was no remedy, because the observation was
never frozen and a resumed `destroy` re-read the same log and threw identically.

Four triggers reach the same place. Three are the evaluator's; the fourth this
workspace found while reproducing the first three:

| trigger, all subject-influenced | what was raised | typed? |
| --- | --- | --- |
| any non-NFC character on any line the excerpt retains | `CanonicalizationError: string is not NFC` | no |
| a `service.name` longer than 256 characters | `SCHEMA_VALIDATION_FAILED` | yes, and unroutable |
| more than 256 distinct `service.name` values | `SCHEMA_VALIDATION_FAILED` | yes, and unroutable |
| a `Traces` line whose `"spans"` digit run overflows the double | `CanonicalizationError: non-finite number rejected: Infinity` | no |

The fourth is worth stating on its own: `parseCollectorTelemetry` sums
`Number.parseInt` over text a subject writes into, so a long enough digit run
reaches `Infinity` before it reaches any bound the schema states. It is the same
defect class through the number path rather than the string path.

**Two framings, both honest, both load-bearing.**

- **This is a regression `d803e66` introduced.** Before the crash-window fix the
  excerpt was a separate file and its bytes never reached the canonicalizer; the
  reproduction confirms the pre-`d803e66` shape hashes cleanly on the same
  input. The fix closed one failure mode and opened another. That is not an
  argument against the fix — it is one artifact, one freeze, and it is right —
  but the record should say that a correct structural change moved
  subject-controlled bytes into a hash path nobody re-examined.
- **The trigger is mundane, not adversarial.** macOS filesystems store filenames
  in NFD, so a subject serving a URL derived from an accented filename emits NFD
  with no attacker anywhere. The ERL2-OQ-009 interim path this Lab *endorses* is
  exactly "the adapter serves its own application on loopback", whose URLs land
  in `url.full` — a marker-bearing field, which is precisely why the excerpt
  retains that line. One accented filename is sufficient. `OTEL_SERVICE_NAME`
  reaches the same place with no excerpt involved at all.

**Severity is liveness and residue, not attestation.** Nothing false was ever
signed. The run could reach no terminal of any kind and the substrate leaked.

## 2. Decision 1 — every precondition of freezing demotes, and the excerpt is never rewritten to fit the hash

ADR-ERL2-033 §3 already reasoned about exactly this hazard once and got it
right, for one bound out of several: an excerpt past the retention bound yields
an honest `absent` with `telemetry_excerpt_exceeds_retention_bound` rather than
a truncated excerpt, because *"an excerpt cut short derives counts that are not
this run's."* That reasoning applies unchanged to every other precondition on
content of the same provenance.

So **every** precondition the canonicalizer and ERL2-C-160 place on the
`observed` branch is now answered *before* `base` is constructed, each with its
own specific reason code:

| reason code | precondition |
| --- | --- |
| `telemetry_excerpt_exceeds_retention_bound` | the excerpt's length (pre-existing) |
| `telemetry_excerpt_not_canonicalizable` | the canonicalizer will accept the excerpt |
| `telemetry_service_names_exceed_cardinality_bound` | at most 256 distinct service names |
| `telemetry_service_name_exceeds_length_bound` | each service name at most 256 characters |
| `telemetry_service_name_not_canonicalizable` | the canonicalizer will accept each service name |
| `telemetry_count_not_representable` | each count is finite, integral and within the contract's range |
| `telemetry_collector_identity_exceeds_bound` | the collector identity's pattern, lengths and cardinality |
| `telemetry_collector_identity_not_canonicalizable` | the canonicalizer will accept each collector identity string |

Codes are specific rather than one shared "could not retain" because a reader of
the retained bytes should be able to tell an excerpt past the size bound from an
excerpt the canonicalizer refuses: those say different things about the run.

Two things this deliberately is **not**.

**Not a parallel validation seam.** `ec345d3` already recorded that the
observation is validated before any byte freezes, honoring P1-10. That seam is
`coreHash` + `assertContract` immediately before the single `freezeJson`, and it
still runs unchanged. What is added is the same seam widened to the *inputs*, so
that a refusal happens where a reason code can be attached to it instead of as a
throw nobody catalogued. The restated bounds are not a second contract:
`assertContract` would still refuse anything they missed.

**Not normalization.** The excerpt is never rewritten into NFC to make it
hashable. It is meant to be what the collector emitted, and normalizing it would
substitute a convenient artifact for an observed one — the exact move this
repository's review history exists to prevent, and the reason the canonicalizer
refuses rather than normalizes in the first place (`jcs.ts`: *"normalisation
would mask a hash-identity mismatch"*). A demoted record carries no excerpt at
all, so no retained field holds a rewritten copy of the collector's bytes.

**The invariant this holds.** A run whose collector emitted bytes the Lab cannot
canonicalize reaches an honest terminal with cleanup performed. Where the
archetype declared telemetry and the exercising step succeeded, the `absent`
observation fails the `attributable-telemetry-retained` gate and the run goes
**invalid** through the ordinary path — and the offline verifier refuses it
independently with `ENV_TELEMETRY_NOT_ATTRIBUTED`. Invalid-with-cleanup is the
correct outcome and no pass is engineered out of it.

The canonicalizability question is answered by **running the canonicalizer**:
`isCanonicalizableString` in `packages/integrity` calls `canonicalString` and
reads its refusal. A second copy of "NFC, no unpaired surrogate" in
`packages/core` would have been free to drift from the copy that actually
decides, and a precondition that disagrees with the function it guards is worse
than no precondition. This is the ADR-ERL2-024 §7.2 shared-definition pattern,
not a duplicate guard.

There is deliberately **no** `isCanonicalizableNumber` beside it. The numeric
precondition is `Number.isInteger(count) && 0 <= count <= 100 000 000`, and
every value that satisfies it is finite and safely representable by arithmetic,
so a canonicalizer call there would guard nothing. §5.1 records how that was
established, because it was not established by reasoning.

## 3. Decision 2 — the new reason codes are not a contract change at all

`reason_code` on ERL2-C-160 is `{"type": "string", "minLength": 1,
"maxLength": 128}`. It is **not an enum**. Nothing in the schema, the producer,
the validity gate or the offline verifier enumerates its values: the verifier
reports the code in a refusal message and never matches on it.

So the question the frozen-contract discipline asks — *widening or new
version?* — does not arise. Adding a value here is neither: it is a new
*instance* of an already-open field. No artifact already written changes
meaning, no reader's acceptance set narrows, and `environment.schema.json` is
byte-identical to `2e943a6`. ERL2-C-160 is untouched, the contract count is
unchanged, and `attributable-telemetry-observation/v1` stays `v1`.

Recorded explicitly because the honest answer to a frozen-contract question is
sometimes *"the field was designed open, and here is the proof"*, and that is
only credible if someone checked rather than assumed. If a later package ever
closes this field into an enum, that is the change that must reason about
compatibility, and it inherits this list.

## 4. Decision 3 — every failure of the retention path leaves as a code the caller can route

Defence in depth, because the fix above closes the triggers known today and
`destroy`'s catch will still rethrow anything uncatalogued tomorrow.

`retainAttributableTelemetryObservation` now converts every escaping failure
into `Erl2Error(CODES.TEARDOWN_FAILED, …)` carrying the original code and
message in its text. `destroy` routes that code to a receipt-backed emergency
cleanup and an invalid terminal, so the worst case becomes *invalid, cleaned up,
with the original failure recorded* rather than *no terminal, containers live*.

`TEARDOWN_FAILED` is the honest classification and not a convenience: retention
runs inside `destroy` and nowhere else, and a retention that cannot complete is
a teardown that could not begin. The marker rides both the `observed` and the
`absent` branch, so an unretainable marker is a failure no demotion can absorb —
it is the concrete case this decision exists for.

The boundary lives with the retention function rather than at its call site in
`EnvironmentRun` so that it can be **measured without a substrate**. That is not
a stylistic preference; §5 is why.

## 5. Decision 4 — the crash-window closure and every new guard get executable coverage

EQ-L-005 is the finding that matters most, and it is recorded here as such. The
crash-window fix (`d803e66`) is structurally correct and had **zero** executable
coverage: removing the read-what-you-wrote branch reintroduced the
`ARTIFACT_ALREADY_FROZEN` wedge with a fully green suite. That is *verbatim* the
condition the telemetry ledger gives for why the original defect went unnoticed
— *"the suite was green in both shapes."* Fixing EQ-L-004 without closing it
would have repeated the package's own recorded mistake twice in one package.

The producer's retention path was unreachable from any test that did not have a
Docker daemon, because it lived inside a private method of `EnvironmentRun`
reached only through a live Compose run. `retainAttributableTelemetryObservation`
is that path, moved into `telemetryObservation.ts` — the module that already
owns the telemetry vocabulary — and driven in `ATTR-TELEM-RETAIN` over a real
`ArtifactStore` and a stand-in observer. `EnvironmentRun.destroy` calls it and
decides nothing else. One seam, now reachable.

Twelve negative controls are registered and every one of them kills (§4 of the
remediation ledger records the campaign): one on the re-entry branch, one on the
routable boundary, and ten on the preconditions of freezing — including the
excerpt retention bound that ADR-ERL2-033 shipped without a control of its own.

### 5.1 The thirteenth control, and why it is not here

The campaign was run before this ADR was final, and it killed twelve of thirteen.
`telemetry-count-canonicalizable` scored **41 pass / 0 fail** against an
`expect: "fail"` — `tests_passed_unexpectedly`, the harness's name for a guard
that is not load-bearing.

It was right. The guard it patched was an `isCanonicalizableNumber(count)` call
sitting immediately above the contract's range check, and every value the
canonicalizer would refuse — `Infinity`, `NaN`, a non-integer, an unsafe integer
— fails `Number.isInteger(count) && 0 <= count <= 100 000 000` as well. Disabling
it changed nothing because it decided nothing.

The guard was **removed**, not re-declared `expect: "pass"`. A guard nothing can
kill reads to the next person as a guard that may be deleted, which is the
reading the negative-control harness ledger records as the most expensive way to
be wrong. Its two cases (`Infinity` from a 400-digit `"spans"` run, and a count
one above the contract's maximum) both remain, now under the one control that
does kill. `isCanonicalizableNumber` was removed from `packages/integrity` in the
same change rather than left as an unused export.

Recorded because the brief asked for anything that failed on its first attempt,
and because this is the campaign doing exactly what it is for — on this
package's own new code, hours after it was written.

## 6. Decision 5 — the unexercised production path in CI, decided rather than deferred

The evaluator verified from run `31178507421` that **no CI run has ever executed
the producer's retention path**: `COMPOSE-E2E` and `EXTERNAL-SUBJECT-E2E` both
skip there, and `.github/workflows/pr.yml` fetches no substrate archive and sets
no `ERL2_REQUIRE_LIVE_DOCKER`. That is why a defect reachable by one accented
character survived a 1140-test suite and three green CI runs.

The decision is **both**, in the order that makes each honest:

1. **The path is now exercised in CI without a substrate**, by the change above.
   `retainAttributableTelemetryObservation` — the observe/validate/demote/freeze
   sequence and its re-entry branch — runs on every `npm test` on every runner.
   This is the part that could be fixed, and it is the part EQ-L-004 lived in.
2. **The remaining gap is recorded as a known limitation with its consequence
   stated**, and not called anything else. A *live* Compose journey still runs
   nowhere but an operator's host: `ComposeEnvironmentDriver.observeAttributableTelemetry`
   — the Docker verification of the collector container and the reading of its
   logs — has no CI execution, and its coverage is `composeSubstrate.test.ts`
   over a stand-in daemon. The consequence, stated plainly: **a defect that
   lives in the driver's interaction with a real Docker daemon is not
   discoverable by this repository's CI, and would be found only by an operator
   run or by review.**

A substrate-bearing lane was not added in this package, and the reason is
recorded rather than implied. It would fetch and extract a 3 MB digest-pinned
archive, pull two digest-pinned images and run a multi-minute Compose journey on
a hosted runner, and the qualification it re-proves is one this repository
already reports as `independently_qualified: false`. That is a package of its
own, with its own failure modes (flaky pulls read as red suites) and its own
decision about what a green run there would mean. What is *not* acceptable — and
what this decision ends — is documents describing that path as verified while
nothing verified it. §7 of the remediation ledger states exactly what the live
confirmation on one operator host did and did not establish — including that the
shipped reference subject's own instrumentation percent-encodes the request
target, so it cannot reach EQ-L-004 through `url.full` even though other
attributes and `OTEL_SERVICE_NAME` still can.

## 7. What replaces ADR-ERL2-033 §4's coverage sentence (EQ-L-007)

ADR-ERL2-033 §4 introduces the two enforcement points with the parenthetical
*"ADR-ERL2-024's pattern, not a duplicate guard — each is separately measured by
its own negative control."* The package's own ledger says otherwise about the
producer side, in the same package: *"no test drives a run in which the wiring
evaluates false … The refusing side of the producer gate is therefore
**unmeasured on this branch**"*, matching `telemetry-producer-gate-wiring`
(`expected: "pass"`, `result: "no_kill_as_declared"`).

Both statements are defensible in isolation — the gate's *arithmetic* is killed
by `telemetry-gate-satisfaction`, and the ADR may have meant the arithmetic. But
the ADR is the normative record, it is read without the ledger beside it, and
"each is separately measured" is materially more confident than "the refusing
side is unmeasured." The ledger's candour on this exact point is what made the
evaluator's fourth question answerable; the ADR should not be the document that
undoes it.

**The corrected statement, which supersedes that parenthetical:**

> Two enforcement points, deliberately at different trust boundaries
> (ADR-ERL2-024's pattern, not a duplicate guard). The **offline verifier's**
> refusing side is measured four ways. The **producer gate's** refusing side is
> measured on its arithmetic (`telemetry-gate-satisfaction`) and **unmeasured on
> its wiring**: `telemetry-producer-gate-wiring` is registered `expect: "pass"`
> and kills nothing, because driving it needs a live Compose substrate whose
> collector receives nothing and the ordinary suite must never require a daemon.
> The gap is narrower than it looks — the scenario that control cannot drive is
> refused offline by two *measured* verifier controls, so the verifier is
> independently sufficient exactly where the producer side is unmeasured — but
> it is a gap, and it is stated rather than implied.

**Why a superseding ADR rather than an edit.** ADR-ERL2-033 is **accepted**, and
this repository supersedes accepted ADRs rather than silently rewriting them —
the standing precedent is ADR-ERL2-017, which supersedes ADR-ERL2-016
§"Consequences" only and re-affirms everything else. An edit would leave no
trace that the sentence was ever wrong, which is the same failure mode as an
unconditioned claim: it makes the record look like it was always right. The
alternative considered and rejected was recording the correction in the
remediation ledger alone. Ledgers are dated measurement records; a reader who
opens the ADR without the ledger beside them — which is the reading the finding
is *about* — would still meet the overclaim. The correction belongs where the
overclaim is read.

## 8. Failure ownership and refusal codes

No new error code, no new contract, no new lifecycle event, no new gate.

| Code | Raised by | Raised when |
| --- | --- | --- |
| `TEARDOWN_FAILED` | producer, `retainAttributableTelemetryObservation` | any failure of the retention path that is not a demotion — including a marker or a driver-supplied reason code the Lab cannot freeze, and anything unanticipated. Routed by `destroy` to receipt-backed emergency cleanup and an invalid terminal. |
| gate `attributable-telemetry-retained` failing | producer validity | unchanged from ADR-ERL2-033 §6, and now also where the retained observation is `absent` because the collector's bytes could not be frozen |
| `ENV_TELEMETRY_NOT_ATTRIBUTED` | offline verifier | unchanged; a demoted observation on a declared run is refused offline exactly as any other `absent` is |

## 9. What is explicitly not decided here

The claim ceiling does not move: T1, development tier, non-blind selection,
development-signed self-qualified substrate, exactly as before. No claim is
added; a defect is removed. `EnvironmentDriver` is untouched, no signer is
added, no lifecycle event type or state changes, `ERL2-C-160` and every other
frozen schema are byte-identical, and no golden changes (a fake-driver run
produces no observation, so no golden ever carried one). The evidence window,
the cutoff machinery and the `service-metric` source mapping are untouched.
Whether `run_attributed_records` should count records rather than marker
occurrences — the evaluator's §C observation — is not decided here; the field is
sound at the `>= 1` threshold the gate and the verifier actually use, and
renaming it is a contract change with no defect behind it.

## 10. Rejected alternatives

| Alternative | Rejected because |
| --- | --- |
| Normalize the excerpt into NFC so it hashes | It substitutes a convenient artifact for an observed one. The excerpt is meant to be what the collector emitted, and the canonicalizer refuses rather than normalizes precisely so a hash-identity mismatch cannot be masked. Argued here rather than done quietly, as the remediation brief required. |
| Truncate or sanitize the offending lines | Same objection as truncating an over-long excerpt, which ADR-ERL2-033 already rejected: an excerpt cut short or scrubbed derives counts that are not this run's. |
| Catch `CanonicalizationError` in `routed()` and add it to `destroy`'s codes | Treats the symptom at the wrong boundary. The CLI would then route an untyped canonicalization failure from *any* phase, and the run would still lose an observation it could have recorded honestly. Demotion keeps the fact; this would only keep the terminal. |
| A single `telemetry_not_retainable` reason code | Cheaper and less honest. A reader of the retained bytes could not tell a chatty collector from one emitting bytes the Lab refuses, and those support different follow-ups. |
| Restate the canonicalizer's NFC and surrogate rules in `packages/core` | A second copy of the rule is free to drift from the copy that decides. `isCanonicalizableString` runs the canonicalizer itself, so the answer is the canonicalizer's own by construction. |
| Leave the retention path inside `EnvironmentRun` and cover it only through a live Compose run | That is precisely the condition that let EQ-L-004 survive a green 1140-test suite and three green CI runs. A guard nothing can execute without a daemon is a guard CI cannot measure. |
| Add the substrate-bearing CI lane in this package | See §6.2. It is a package of its own, and pretending otherwise would trade one undecided gap for a flaky lane and a claim nobody scoped. Recorded as a stated limitation instead, which is the honest half of the same decision. |
| Edit ADR-ERL2-033 §4 in place | See §7. The repository supersedes accepted ADRs; an edit would erase that the sentence was ever wrong. |
