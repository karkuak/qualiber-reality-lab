# Ledger — Qualiber integration package 1: attributable telemetry is retained and gated

Companion to [ADR-ERL2-033](../adr/ADR-ERL2-033.md). Successor to
[`stabilization-6.5-p3.md`](stabilization-6.5-p3.md).

This package discharges the one obligation ERL2-OQ-005 deferred to "the first
Qualiber integration package": *retain the attributable-telemetry observation
into a run's evidence and gate on it* — recorded identically in
[`requirements.json`](requirements.json) (the
`deferred_to_first_qualiber_integration_package` field),
[`open-questions.md`](../decisions/open-questions.md) (the ERL2-OQ-005 detail)
and [`permitted-claims.md`](../claims/permitted-claims.md). Qualiber
independence, exactly as the disposition ledgers record it: no Qualiber
identifier was added to any module under `packages/` (`CORE-PURITY`); the name
appears in this ledger, the requirements ledger and ADR prose only, and the
artifact, gate, schema and refusal names are generic.

---

## 1. What was open

The corrective ERL2-OQ-005 package left the boundary in
`permitted-claims.md` deliberately narrow:

> So a permitted statement is "the acceptance test observed attributable
> telemetry at the collector"; a statement that the retained evidence *attests*
> received telemetry is not permitted, and neither is describing collector
> startup as a service metric.

The prepared seam was `ComposeEnvironmentDriver.observeTelemetry(marker)`
(`composeDriver.ts`), which reads the run's own Docker-verified collector's
logs and counts trace batches, spans, service names and marker occurrences.
Nothing retained it: `evidenceSourceState` mapped `service-metric` to pipeline
readiness, every source snapshot froze `records: 0`, and an offline bundle
carried no attestation that telemetry was received.

**Two measurements disagreed with the written record**, and are recorded here
because they were found by reading and grepping, not by a failing test:

- `observeTelemetry` had **zero call sites** in the repository. Its doc comment
  said "its only consumer today is the live acceptance test"; the acceptance
  test in fact re-implements the log parsing itself against
  `docker container logs`, with slightly different regexes. The seam was
  prepared, never consumed.
- The byte pin is **832 files / 7 excluded** (`EXPECTED_PINNED` in
  `scripts/generate-evidence.mjs`), while `README.md` still said 780 — three
  pin-growths stale, traced through the script's own history: 780 → 781 (slice
  6.5 close-out) → 787 (ADR-ERL2-027) → 832 (adapter adjudication became
  retained evidence). The README number is corrected in this package.

One ordering fact shaped the design: in the committed phase order the cutoff is
realized at `observe` **before** `execute-subject:exercise`, so the run's
telemetry post-dates the frozen evidence window by construction. The retained
observation is therefore a post-cutoff statement about receipt during the run,
and no wording anywhere is permitted to place it inside the window.

## 2. What changed

| Concern | Before | Now |
| --- | --- | --- |
| Receipt of run-attributed telemetry | Observed by the live test, retained by nothing | Retained as one `attributable-telemetry-observation/v1` carrying the counts and the exact log lines they derive from, frozen before `teardown_started` |
| Who may read collector logs | The driver, for a probe and an unconsumed counter | Unchanged (Docker-verified container only); the unverified/unreadable cases now stay distinct so an `absent` record can say why |
| Producer enforcement | none | Lab validity gate `attributable-telemetry-retained`, required on every environment terminal, vacuous where undeclared |
| Offline verification | none | `deriveAttributableTelemetry`: declaration predicate re-derived, every count recomputed from the retained excerpt bytes |
| Claim boundary | retained-telemetry claims forbidden | permitted at exactly the retained width; window/service-metric/independence claims still forbidden |
| `EnvironmentDriver` contract | six operations | unchanged — the capability is a separate structural seam the fake driver does not implement |

## 3. The contract

`ERL2-C-160` `AttributableTelemetryObservationV1`
(`attributable-telemetry-observation/v1`, group `environment`). Additive;
contract count 226 → **227**. **No frozen schema changes shape or meaning.**
Discriminated evidence in the ADR-ERL2-016 sense: `evidence: "observed"` is
required to carry the counts, the Docker-proven collector identity
(`ownership_verified` and `image_matches_locked_digest` are schema constants
`true`) and the `log_excerpt` — a bounded inline string
(`maxLength: 262144`), not a reference to a second file; §7 below records why
the first shape was abandoned. Anything else must carry a
`reason_code` and can carry none of them. **No field stores a verdict** —
"attributable telemetry was received" is derivable only, by the gate and the
verifier independently.

## 4. The producer

- `packages/core/src/environment/telemetryObservation.ts` — the shared
  *definitions* (`parseCollectorTelemetry`, `excerptCollectorTelemetry`; the
  excerpt keeps exactly the lines that contribute to a count, so re-parsing
  the excerpt reproduces the full log's counts and excerpting is a fixed
  point), the capability seam (`supportsAttributableTelemetry` — the fake
  driver honestly fails it), and the gate arithmetic.
- `packages/core/src/environment/composeDriver.ts` —
  `observeAttributableTelemetry(marker)`: verified-collector logs, bounded
  settle retry (at most 20 s while zero run-marked records are visible; an
  append-only log means waiting can only add records), `absent` with
  `collector_not_verified` / `collector_logs_unreadable` otherwise.
  `observeTelemetry` now delegates to the shared definition.
- `packages/core/src/run/environmentRun.ts` — `retainAttributableTelemetry()`
  inside `destroy()`: produced exactly where the capability and a declared
  `metric` source coexist; one artifact validated and frozen, then the
  `teardown_started` event that anchors it (freeze first, anchor second; the
  throwing validation runs before the freeze). On re-entry after a crash in
  that window the run **reads what it already wrote** instead of re-observing
  — see §7. The gate
  `attributable-telemetry-retained` is catalogued under
  `evidence_completeness` and required by `ENVIRONMENT_GATE_IDS`; a failing
  gate freezes a finding and the terminal goes invalid, like every other
  environment gate.

### 4.1 What the producer deliberately does not do

It does not write a verdict field, does not produce the artifact on fake-driver
runs (`ENOENT` there means *never produced*, recorded in ADR-ERL2-033 §2),
does not touch the cutoff machinery or the source snapshots, and does not sign
the observation — a repo-derivable development signature would add authority
theater, not authority.

## 5. The verifier

`packages/public-verifier/src/library/telemetryDerivation.ts`,
wired into `verifyEnvironmentBundle` after `deriveEnvironmentSemantics` so a
missing role keeps its more fundamental cause. In order: exactly one retained
driver manifest and archetype; the declaration predicate recomputed
(`driver_kind: "compose"`, a declared `metric` source, a succeeded `exercise`
outcome of this run); exactly one observation where declared
(`ENV_TELEMETRY_OBSERVATION_MISSING` when none is retained,
`ENV_TELEMETRY_OBSERVATION_MISMATCH` when more than one is); produced by
`teardown_started` and by nothing else — the placement *is* the liveness
proof; this run's id and this run's id as marker; an excerpt present at all
(`ArtifactIndex.typed` validates neither the contract nor the fields, so this
is a live check, not dead defensiveness), a fixed point of excerpting, and
every count recomputed from it (`ENV_TELEMETRY_OBSERVATION_MISMATCH` on any
disagreement, in both directions); at least one run-attributed record where
declared (`ENV_TELEMETRY_NOT_ATTRIBUTED`). The role is
`attributable-telemetry-observation` in `ENVIRONMENT_OPTIONAL_ROLES` — a
role, deliberately not a `SUPPORTING_SCHEMAS` entry. The invalid branch is
untouched: an invalid terminal claims nothing.

## 6. Goldens and the byte pin

**832 pinned / 7 excluded, unchanged.** No fake-driver run produces the
artifact, `teardown_started`'s `produced` array serializes identically when
empty, and the environment golden's `closure-summary.json` carries no gate
list — measured, not assumed: `npm run evidence:verify` byte-compared clean
against the pinned goldens after the change: `evidence:verify OK` over
**832 pinned / 7 excluded** (91 CLI invocations, 11 expected refusals), all
three invalid goldens and the valid golden re-verifying at exit 0 in fresh
processes.

## 7. A defect this package's own review caught

The first implementation retained the excerpt as a **second file** referenced
by an `ArtifactRef`. An adversarial review of the branch found the window that
makes unrecoverable: both files freeze before the `teardown_started` event that
anchors them, and a crash between the freezes and the append leaves either an
excerpt no artifact references or a reference to bytes that were never written
— the retained-file accounting refuses the first, the referenced-bytes pass the
second, so an *honest crash* produced a run with no reachable verifiable
terminal. Worse, a resumed `destroy` re-observed and re-froze with a fresh
`observed_at`, wedging the run on `ARTIFACT_ALREADY_FROZEN` on every retry
forever.

Two files cannot be frozen atomically, so the fix was structural rather than
defensive: the excerpt became a bounded, hash-covered field of the observation
— one artifact, one freeze, no window — and the re-entry path now reads the
already-frozen observation instead of re-observing, mirroring
`retainedSubstrateBinding`. Recorded here rather than in a fix note because it
was found by reading the crash matrix against the new code, not by a failing
test; the suite was green in both shapes.

## 8. Negative controls

Eight controls registered in `scripts/negative-control.mjs` — seven that kill,
one recorded as unmeasured — each proven to land on its declared bytes by the
standing `NC-CAMPAIGN` targeting test and scored by a focused campaign:

| Control | Patched lie | Result |
| --- | --- | --- |
| `telemetry-gate-satisfaction` | the producer gate accepts any observation set where declared | **22 pass / 3 fail — killed** |
| `telemetry-verifier-declared-requires-observation` | the verifier stops requiring an observation where the bytes declare it | **24 pass / 1 fail — killed** |
| `telemetry-verifier-count-derivation` | the verifier believes the observation's counts instead of recomputing them from the excerpt | **24 pass / 1 fail — killed** |
| `telemetry-verifier-attribution-floor` | a declared observation with zero run-marked records is recorded instead of refused | **24 pass / 1 fail — killed** |
| `telemetry-verifier-observation-cardinality` | a second retained observation is silently ignored rather than refused | **24 pass / 1 fail — killed** |
| `telemetry-verifier-excerpt-fixed-point` | an excerpt padded with non-contributing lines is accepted | **24 pass / 1 fail — killed** |
| `telemetry-driver-verified-collector` | the driver reads logs from a container Docker has not proven is this run's | **27 pass / 1 fail — killed** |

### 8.1 One rule recorded as unmeasured

`telemetry-producer-gate-wiring` patches the validity gate's `passed:` to a
constant `true` and is declared `expect: "pass"` — it kills nothing, and the
declaration says why rather than implying coverage it does not provide. The
gate's *arithmetic* is killed by `telemetry-gate-satisfaction` and its inputs
are unit-tested, but no test drives a run in which the wiring evaluates false:
that needs a live Compose substrate whose collector receives nothing, and the
ordinary suite must never require a daemon. The refusing side of the producer
gate is therefore **unmeasured on this branch**, stated here rather than
implied. The offline verifier's refusing side, which is the one an external
reader depends on, is measured four ways.

### 8.2 Fake-driver immunity

Measured separately rather than patched:
`ATTR-TELEM-E2E: a fake-driver run declares nothing, retains nothing, and
still verifies offline` drives a real fake-driver run to `generic_finalized`,
asserts the gate is present and passing with no artifact retained, and
verifies the bundle offline; `npm run evidence:verify` pins the same property
across every golden. Campaign: `npm run negative-control -- telemetry`, **9 of 108 scored, all nine
agreed** — the seven kills above, the one unmeasured rule below, and the
pre-existing `lab-telemetry-oracle-scan`, which the substring filter selects
and which still kills as declared (9 pass / 3 fail). Scored against commit
`2c69e9c` in a disposable worktree — that commit is not reachable from `main`,
because the pre-merge rebase replayed it as
[`a5ad6e6`](https://github.com/karkuak/qualiber-reality-lab/commit/a5ad6e6);
the campaign ran at `2c69e9c` and only its identity moved, so both are recorded
rather than one substituted for the other (the full remap is in the correction
comment on PR #10). The working tree was proven byte-identical
afterward, and the results were rewritten to
[`negative-controls.json`](negative-controls.json) per the harness's overwrite
convention. The standing `NC-CAMPAIGN` test re-proves all 108 controls'
targeting on every `npm test`.

## 9. The live acceptance run

`npm test` — the full suite, on a host with a live Docker daemon (29.5.3):
**1140 tests, 1138 pass, 0 fail, 2 skipped.** The two skips are the
external-subject E2E cases, which skip loudly (`EXTERNAL SUBJECT UNPROVEN: no
external adapter entry was supplied`) — their new retained-observation
assertion is therefore **untested on this host**, stated plainly rather than
implied.

> Later, and not a rewrite of the measurement above: that assertion did
> subsequently execute against a configured external adapter on a live
> substrate, reported in the second comment on PR #10. This ledger records what
> was true when it was written; the pointer is added because the record it
> supports carries no date of its own.

`COMPOSE-E2E: a run reaches an offline-valid terminal through a real Compose
substrate` passed with this package's new assertions: the retained
observation is `evidence: "observed"`, its marker is the run id, its
`run_attributed_records` is positive, its span and marker counts are
re-derived from the retained excerpt by the test's own arithmetic
(independent of the shared definition), and the offline `erl2 verify
--offline` of the bundle — whose environment path now includes
`deriveAttributableTelemetry` — returns exit 0, verdict `valid`, no missing
roles, no rejected extras. Zero Docker residue after teardown, observed
independently of the run's own report.

## 10. Claims

What moves: `permitted-claims.md` now permits the retained-telemetry statement
at exactly its width — a valid Compose-driver run on a metric-declaring
archetype **whose exercising step succeeded** retains an observation naming
this run in at least one record. Both enforcement points refuse such a run
whose observation is missing, is not an observation, or names the run in no
record; only the offline verifier additionally recomputes the counts from the
excerpt and refuses a contradiction, and only it owns the refusal codes. What does not move: no claim inside the frozen
evidence window (the observation is post-cutoff by construction), no
service-metric reading of pipeline startup, no independent qualification, no
ecosystem or subject-quality statement. **The claims ceiling is unchanged:
T1.**

## 11. What this package does not claim

- That telemetry arrives **inside the evidence window**. Making that claimable
  would mean moving the exercising step ahead of the cutoff, which is
  ADR-ERL2-031's machinery and deliberately untouched here.
- That an external subject's telemetry is attributable **unless it embeds the
  run id** in what it emits. The reference adapter does; an external adapter
  that does not will fail the gate on a declaring archetype, and that refusal
  is the design, not a defect.
- That the observation is authenticated by any authority: its integrity is the
  hash-chained lifecycle plus the byte-recomputable excerpt.
