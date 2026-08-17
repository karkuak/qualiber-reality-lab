# Trusted telemetry — environment-run integration (Package 3)

The third and last half of ADR-ERL2-038. Package 1 defined ERL2-C-171 and who
may authorize a claim from one, and produced none. Package 2 built the channel
that produces them, and was deliberately not wired in. This package connects
`environmentRun` to that channel, and retires ERL2-C-160 as the authority for a
new run's telemetry claim.

**Scope.** No collector image, pin, configuration, SBOM, provenance or lock
changed. No Docker volume, ownership, trusted-file parsing, cleanup or C-171
verification logic was reimplemented in `environmentRun`. Qualiber was not
accessed and no Qualiber run was performed. The full campaign, the clean gate
and `evidence:update` remain **not run**.

---

## 1. The stale assertion, and what it cost

`EnvironmentRun.retainAttributableTelemetry` froze an **ERL2-C-160** record. Its
counts came from `parseCollectorTelemetry` over the collector's *debug* console
stream — and the Lab's own overlay runs a `logs` pipeline into that same
exporter, so a subject's log body is rendered into the very bytes the counts
were parsed from, at column zero:

```
Body: Str(2026-08-13T21:33:32.634Z\tinfo\tTraces\t{"resource spans": 1, "spans": 9999})
```

That line parsed. Measured at `6d28d543`, a forged `spans: 9999` verified clean.

ADR-ERL2-038 closed the forgery by building a physically separate channel, and
package 1 made ERL2-C-171 the only authoritative format —
`decideTrustedTelemetryAuthority` refuses v1 for any new claim. What was left
was that the producer still *produced* v1. Every run that declared an
attributable-telemetry observation obtainable therefore failed its own gate:

```
finalize-generic: EVALUATOR_INVALID_VALIDITY_IN_GENERIC_INDEX
retained/finding-environment-gate-attributable-telemetry-retained.json
failed_gate_ids: ["attributable-telemetry-retained"]
```

This was the sole remaining broad-suite failure at the package 2 closure, and
the independent package 2 review proved it pre-existing by reproducing it at
that package's parent with the three deciding files byte-identical.

---

## 2. What replaced it

`retainAttributableTelemetry` now retains what
`freezeTrustedTelemetryObservation` returns — an ERL2-C-171 record, sealed by
package 2 from bytes only the collector could write.

The run does **not** learn what a trusted volume is. Provisioning it, proving
durable ownership across the four processes a lifecycle spans, waiting out the
exporter, establishing the observation cutoff, copying, parsing, sealing and
removing all stay behind that one call. The run's whole contribution is deciding
*whether to ask*, retaining what comes back, and refusing to let anything else
answer the question.

| package 3 does | package 3 does not |
|---|---|
| choose applicability from the run's own declarations | inspect Docker labels |
| call one seam method and retain its result | read the ownership capability file |
| check the producer half of R4 cross-run binding | guess volume names, call `docker cp` |
| compose the gate from authority + verifier semantics | parse archive headers or trusted JSON |
| report cleanup honestly | recompute trusted counts, reimplement minimization |
| — | use debug output as a fallback, or reconstruct C-171 |

The freeze happens before the lifecycle event that anchors it, and that event is
`teardown_started` — the offline verifier requires exactly that placement,
because the placement is the proof the channel was read while this run's
containers still lived.

---

## 3. Applicability: one authoritative answer

`EnvironmentRun.attributableTelemetryApplicable()` is asked once and is the only
answer. It is the ADR-ERL2-033 declaration predicate:

- the driver kind is `compose`;
- the archetype declares an evidence source of kind `metric`;
- some journey step outcome is a **succeeded** `exercise`.

Every conjunct is re-derivable from retained bytes, which is what lets
`deriveAttributableTelemetry` recompute the identical predicate offline without
trusting the producer's.

**Nothing the channel reports is an input.** Not a timeout, not a refusal, not a
linked artifact, not a cleanup failure. A run cannot become inapplicable by
failing to observe, which is the property that keeps omission honest instead of
an escape hatch.

### The retired vacuous pass

Before this package the gate was evaluated on every environment terminal and
*passed vacuously* where the observation was never declared obtainable. A
fake-driver run published:

```
{ gate_id: "attributable-telemetry-retained", passed: true }
```

That is a boolean answering a question about applicability. A reader could not
tell "this run's trusted telemetry was independently verified" from "this run
could never have had any", and only one of those is a statement about evidence.
It is the same false-attestation shape the independent LIVE-001 review rejected
for `adapter-certified` — sitting one gate over, unnoticed because it always
said `true`.

The gate is **omitted** now, on exactly the terms `adapter-certified` already
uses. Omission is only safe if both directions are refused, and
`assertAttributableTelemetryApplicability` refuses both:

- an **inapplicable** run publishing the gate at all — so the old convention
  cannot creep back through a producer that keeps emitting it;
- an **applicable** run omitting it or evaluating two — so "not applicable"
  cannot decay into "optional", which would punch a hole in exactly the guard
  `assertRequiredGatesPresent` exists to be.

`requiredGateIds` defaults to **applicable** when not told. A caller that forgets
the question gets the stricter required set; the lenient answer has to be asked
for.

### A deviation from the brief, stated

The brief asks that applicability be "frozen before execution". Two of the three
conjuncts are frozen at provision — the driver kind and the archetype. The third
is a *succeeded exercising step*, which cannot be known before the run
exercises. Freezing a different predicate would have changed package 1's
approved declaration rule and desynchronised it from the verifier's mirror, so
the predicate is unchanged and the security property the freeze was asked for is
established directly instead: applicability is not a function of the
observation's outcome, and no caller input reaches it.

---

## 4. Authority and independent verification

Two authorities, neither reading the other's verdict.

**Producer.** `attributableTelemetryGatePassed` calls `trustedTelemetryClaim` →
`decideTrustedTelemetryAuthority`. v2 governs; v1 is readable and authorizes
nothing; an absent or invalid v2 refuses rather than falling back. The gate then
requires the record be `observed`, name this run, carry the run id as its marker,
and count at least one run-attributed record.

The gate reads the retained record **raw**. Pinning a schema would answer the
version question in the wrong place — and pinning v1 would make the read *throw*
on the authoritative format, while pinning v2 would make it throw on a
historical record it is supposed to refuse rather than crash on. The offline
verifier reads the same artifact the same way, for the same reason, so the two
cannot drift about which format governs.

**Verifier.** `deriveAttributableTelemetry` recomputes the declaration
predicate, requires production by `teardown_started`, takes its own authority
decision, and then re-derives *everything the record claims* from the retained
bytes: the content digest, the byte length, the record count, the termination
flag, the trace batches, the spans, the service names and the run-attributed
count. A producer that hashed one buffer and retained another is caught there
rather than believed.

**R4 cross-run binding is split, and package 3 closes its half.** The verifier
re-derives the archetype binding from bytes it holds and records that the
substrate-lock identity is "checked against the substrate lock by package 3,
which is what retains them". `trustedTelemetryBindingMatches` does that: it
compares the artifact's `environment_archetype_hash` against this run's
archetype and its `substrate_lock_core_hash` against this run's own retained
substrate binding. Both are read from the run's evidence, never from the
artifact — an artifact lifted from another run or another substrate carries that
run's identities and cannot satisfy these. A record with no binding block fails.

The collector image and configuration digests are not re-derived in
`environmentRun`. They are established where they are knowable: the channel
refuses to observe a collector Docker will not confirm runs the locked image,
and the digests it seals come from the lock the run is running against.
Re-deriving them here would mean teaching `environmentRun` what a collector is.

---

## 5. Gate truth table

| trusted-channel outcome | gate |
|---|---|
| valid positive C-171 for this run | **pass** |
| authentic zero, zero pre-authorized | does not satisfy a positive-telemetry requirement — `run_attributed_records >= 1` is required |
| expected telemetry missing | **fail** |
| settle budget exhausted | **fail** (`absent`, never a zero) |
| span links unsupported | **fail**, `telemetry_trusted_record_span_links_unsupported` |
| cross-run artifact | **fail** |
| malformed artifact | **fail** |
| oversized artifact | **fail** |
| hash / length mismatch | **fail** |
| finalization incomplete | **fail** |
| verifier disagreement | **fail** (offline, refuses the bundle) |
| trusted channel unavailable | **fail** |
| debug / C-160 evidence only | **fail**, `telemetry_authority_v1_not_authoritative` |
| telemetry inapplicable | **gate omitted**, never "passed" |

No failed state is encoded as a passed gate with an explanatory finding. A failed
gate freezes a Lab invalidity finding like every other environment gate, and the
run reaches an invalid terminal.

---

## 6. Diagnostics, and what stays separate from what

Every refusal reaching the gate is the channel's own typed reason code, carried
on the `absent` ERL2-C-171 record and readable in the retained artifact. Package
3 collapses none of them into a generic telemetry failure.

**Cleanup gained no artifact, deliberately.** An earlier draft of this package
froze a `trusted-channel-cleanup.json`; the closure derivation refused it as an
unaccounted retained file, and it was right to. A surviving trusted volume is
*already* a first-class run resource in the driver's inventory: already counted
as residue, already carrying a run-scoped teardown selector, already failing
`teardown-verified`. A second artifact restating that would be a second claim
about the same fact. What the channel adds that the inventory cannot is *why* —
the daemon's own words for a removal it refused — and that now rides on the
`TEARDOWN_FAILED` refusal an operator reads.

Cleanup success is not evidence validity and evidence validity is not cleanup
success. No gate consults the channel's cleanup outcome.

---

## 7. Cleanup and teardown

Unchanged from package 2, and that is the point: the channel's cleanup runs
inside `ComposeEnvironmentDriver.destroy`, which `environmentRun` calls on every
path that reaches teardown, so cleanup is attempted whatever the artifact turned
out to be. Ownership is proved from the durable cross-process handle; no
in-memory shortcut was reintroduced in `environmentRun`, which holds no channel
state at all.

---

## 8. Span links, and the exploratory prerequisite

Unchanged from package 2 and propagated without reinterpretation. A nonempty
`links` array refuses the whole artifact with
`telemetry_trusted_record_span_links_unsupported`; the record is `absent`; the
gate fails; no partial span count is retained as authoritative; C-160 cannot
substitute; cleanup still runs. There is no caller override, because the
limitation is a property of the pinned collector image rather than of the run
observing it.

**Before the first exploratory run against any real subject**, verify from the
trusted structured output that the selected scenario emits no span links. If it
does, the run is unsupported: evidence remains unavailable, **no product-quality
conclusion may be drawn from it**, and a collector-version upgrade becomes a
separately approved package rather than an in-flight fix.

---

## 9. Legacy ERL2-C-160: historical, and unreachable

Nothing was deleted and no historical evidence was rewritten. What changed is
that the v1 path has **no production caller**:

| symbol | status after package 3 |
|---|---|
| `retainAttributableTelemetryObservation` | no production caller; exercised only by its own suites |
| `supportsAttributableTelemetry` | no production caller; the run's guard is `supportsTrustedTelemetry` |
| `ComposeEnvironmentDriver.observeAttributableTelemetry` | no run calls it; operator diagnostics only |
| `parseCollectorTelemetry`, `excerptCollectorTelemetry` | retained — the readable statement of what v1 records meant |
| ERL2-C-160 contract | retained; historical bundles must stay readable |

Each is documented as historical at its definition. They are left standing
rather than removed because deleting them would not make existing v1 records
unreadable — it would only delete the executable statement of what they meant —
and because their own controls still measure that statement. Their
non-authority is structural, not a convention: any record they produce is
refused by `decideTrustedTelemetryAuthority`, which both the gate and the
offline verifier consult.

---

## 10. Controls

Discovery **199 → 204**. Five added, none removed, renamed or reordered.

| control | boundary |
|---|---|
| `telemetry-gate-composed-only-where-applicable` | the gate is composed from the run's own predicate, not a constant |
| `telemetry-inapplicable-run-may-not-publish-the-gate` | a non-declaring run publishing the gate is refused |
| `telemetry-applicable-run-evaluates-exactly-one-gate` | a declaring run may not evaluate two |
| `telemetry-required-set-follows-applicability` | the gate leaves the required set for exactly the runs that never declared |
| `telemetry-producer-retains-the-trusted-record` | the retained observation comes from the trusted seam |

`telemetry-gate-composed-only-where-applicable` mutates the *composition*
condition rather than the shared accessor. Moving the accessor would move both
call sites together, they would agree, and the mutation would measure something
weaker; mutating the composition alone makes a fake-driver run publish a gate its
own validity input says is inapplicable, which is the disagreement the guard
exists to catch.

`telemetry-applicable-run-evaluates-exactly-one-gate` declares the **duplicate**
case only. Omission is already caught by `assertRequiredGatesPresent`, so
claiming it here would credit this control for a kill the neighbouring guard
makes — the redundant-guard trap the package 2 campaign found twice, and the
reason each fixture there now gets exactly one thing wrong.

### Migration

`telemetry-producer-gate-wiring` was **re-anchored, not replaced**: the gate
composition moved inside the applicability spread and its old two-line anchor
ceased to exist. Its property and its disposition are unchanged, and the
disposition is still **UNMEASURED, deliberately** — no ordinary-suite test drives
a run in which that wiring evaluates false, which needs a live substrate whose
collector receives nothing, and the ordinary suite must never require a daemon.
What is different is that the surface it cannot reach is narrower: the boundary
around it is now measured by the four new controls, and the live matrix drives
the false case against a real substrate. No control was silently removed,
renamed or reordered.

---

## 11. Remaining hardening items, carried forward

Recorded, not closed, and none blocks the first bounded exploratory run:

1. `url.full` remains a bounded MVP privacy limitation.
2. Linux/amd64 volume-option qualification is required before publication.
3. Package 2 P2: the capability handle's temporary file is created with an
   ordinary `w` flag, so a pre-planted temp file or symlink defeats both the
   `0600` mode and symlink safety. The `0700` parent keeps it outside the
   declared subject threat model.
4. The label capability digest is a plain SHA-256 rather than domain-separated.
5. `telemetry-producer-gate-wiring` remains an unmeasured control (§10).

---

## 12. Status

- `environmentRun` **retains and gates on ERL2-C-171**; ERL2-C-160 is historical
  and cannot authorize a new run's claim
- the previously failing `attributable-telemetry-retained` gate **passes through
  valid C-171 evidence**
- telemetry-inapplicable runs **omit** the gate rather than passing it vacuously
- the full campaign, the clean gate and `evidence:update` remain **not run**
- **no Qualiber run has been performed and no Qualiber quality conclusion is
  drawn**
- package 3 is **not reviewed**; only a focused independent live-integration
  review may authorize the first bounded, unscored exploratory Qualiber run
