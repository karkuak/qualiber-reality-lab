# Exercise-outcome validity — the false-valid terminal, and its correction

The remediation ADR-ERL2-039 sequences. It closes one defect the independent
Package 3 live-integration review found, and it closes it without touching the
trusted telemetry channel: no ERL2-C-171 authority, no package 2 parsing,
minimization, binding, finalization, span-link refusal or trusted-volume
lifecycle changed.

**Scope.** No collector image, pin, configuration, SBOM, provenance or lock
changed. No contract schema changed and no generated file was hand-edited.
Neither Qualiber checkout was accessed and no Qualiber run was performed. The
full canonical campaign, the clean gate and `evidence:update` remain **not run**.
Live cases H, I and J remain **unstaged**.

---

## 1. What was wrong

The review, at Package 3 candidate `74bc3e9`, drove the production predicate and
the production validity entry point and reached a **`valid`** terminal on a run
whose exercising step did not succeed — with the `attributable-telemetry-retained`
gate omitted and nothing failing in its place.

Two independent defects, and both mattered:

**F-1 — the omission was dominated by nothing.** Telemetry applicability
contains exercise success (ADR-ERL2-033 decision 3), so an unsuccessful exercise
correctly omits the telemetry gate. But no gate in the catalogue could fail on an
unsuccessful exercise — `validity.ts` said so in its own header — and
`invalidityFindingHashes` derives solely from failed gates. So the run was valid.

**F-2 — retention and gating used different predicates.**
`retainAttributableTelemetry` guarded on two conjuncts where the gate used three.
A compose run with a metric source whose exercise did not succeed froze an
ERL2-C-171 record that no gate evaluated; where that record was `absent`, the
offline verifier raised nothing either.

## 2. Why every test passed anyway

`revealJudgeExpectations` opens the committed expectation of every non-succeeded
step and refuses any whose `truth_scope` is `functional`. The shipped fixture
commits `exercise` and `diagnose_decide` as functional truth, so on that journey
a failed exercise cannot reveal, cannot evaluate, and never reaches a terminal.
Every existing test used that fixture, so the composition-level hole was
invisible end to end.

This is now pinned by `ENV-TELEM-TERMINAL: a failed exercise carrying functional
truth is refused at reveal`, and it is worth being precise about what it is: a
second, independent guard **on one journey shape**. `truth_scope` is a free
per-step governor input — nothing in the contracts or in `packages/core` binds
`exercise` to `functional`, and `FUNCTIONAL_TRUTH_INTENTS` is a fixture constant.
A governor committing a `journey_only` exercise expectation reveals, evaluates
and finalizes normally.

**Correction to the review's reachability claim.** The review argued F-1 was
reachable end to end via `nextPermittedIntents` and `freezeOutput`, and did not
examine the reveal path. On the shipped fixture the false-valid terminal is *not*
reachable; on a journey whose exercise expectation is `journey_only` it is. The
defect is real and the correction is warranted; the reachability was narrower
than reported, and this record says so rather than leaving the stronger claim
standing.

## 3. What changed

| change | file |
|---|---|
| the shared exercise-outcome primitives | `packages/core/src/journey/exerciseOutcome.ts` (new) |
| `subject-exercise-succeeded` gate, `journey_execution` category, applicability + coherence refusals | `packages/core/src/evaluation/validity.ts` |
| the third conjunct imported rather than restated | `packages/core/src/environment/telemetryObservation.ts` |
| gate composition, retention conjunct, validity inputs | `packages/core/src/run/environmentRun.ts` |
| the obligation recomputed offline, four shapes refused | `packages/public-verifier/src/library/environmentDerivation.ts` |

### The truth table this package establishes

| driver / source | exercise | retention | telemetry gate | exercise gate | terminal |
|---|---|---|---|---|---|
| compose + metric | **succeeded** | C-171 frozen | required, evaluated | pass | valid if all gates pass |
| compose + metric | **failed / unsupported** | **nothing frozen** | **omitted** | **fail** | **invalid** |
| no exercise committed | — | nothing frozen | omitted | **omitted** | valid if all gates pass |
| fake driver / no metric source | succeeded | nothing frozen | omitted | pass | valid if all gates pass |
| any | any | a C-160 record | never authorizes; no fallback | — | invalid |

Retention and gate applicability agree in every row, and
`assertTelemetryExerciseCoherence` refuses any row that could disagree.

## 4. Producer and verifier independence

The verifier imports `exerciseApplicable` and `exerciseSucceeded` — *pure
applicability primitives* whose inputs are step outcomes the Lab wrote — on the
same terms `decideTrustedTelemetryAuthority` is already shared. ADR-ERL2-038 §4
forbids sharing a framing definition whose inputs a subject controls; this is not
one.

Every **verdict** stays independently recomputed. `deriveValidityOutcome` reads
no producer answer: it recomputes applicability and success from retained
outcomes and refuses four serialized shapes a producer could emit — the gate
dropped, the gate published by a run that never exercised, the gate reporting a
verdict its own outcomes contradict, and a retained observation with no gate over
it.

## 5. Controls

### `telemetry-producer-gate-wiring`: declared no-kill → measured genuine kill

Written `expect: "pass"` on the reasoning that driving the gate's false branch
needed a live Compose substrate the ordinary suite must never require. The review
measured what that cost: hard-coding the one wire that decides whether a real
run's telemetry is believed broke no test.

The premise was the wrong half. The false branch needs a driver that *declares* a
compose kind and implements the package 2 seam — not a daemon.
`environmentExerciseTelemetryTerminal` supplies one.

**Measured before the declaration changed**, against the mutation verbatim
(replacement count 1): `1 pass / 1 fail`, failing on `Missing expected exception:
an invalid run must be refused entry to the generic evaluation index`. The
positive case still passed under the mutant, so the kill is the property rather
than collateral breakage.

### Two new controls, and one declared unmeasured

`exercise-outcome-failure-invalidates` and
`exercise-outcome-applicability-is-not-the-verdict` anchor on the shared
primitive, which is where the enforcement lives. Both mutants type-check, so both
are semantic kills rather than build failures.

`telemetry-retention-follows-one-applicability-answer` is **declared unmeasured**
and its note says exactly why: reaching the mutant needs a run that declares a
compose driver *and* fails its exercising step, which the shipped fixture refuses
at reveal (§2). The contradiction the mutant creates is refused by the producer
and independently by the verifier, and both refusals *are* measured — the note
names the cases. What is unmeasured is only this call site's own guard. Closing
it needs a fixture whose exercise expectation is `journey_only`, and that fixture
change is deliberately not made here.

### `compose-observation-requires-coherent-span-count`: stale metadata repaired

Pre-existing validation-metadata drift, not a Package 3 regression. The control
carried a hand-written one-entry allowed-skip list naming only the first
rendered-topology case. Package 2 added a second assertion over the same merge
and updated `RENDERED_TOPOLOGY_SKIP`; this copy was not updated with it. Its
three sibling controls reference the constant and were unaffected.

The independent review ran this control for the first time since and it
harness-errored on the undeclared skip — the guard killed correctly (both
declared `mustFailCases` failed), but an undeclared skip is coverage the campaign
cannot account for, so it refused to record an agreement. The repair is to
reference the constant: a copy drifts, a reference cannot.

## 6. What this package does not claim

- **Live cases H, I and J are not staged.** A positive-required run with no
  telemetry, delayed telemetry, and a collector crash remain outstanding. Their
  gate-side behaviour is measured at artifact level and their semantics are now
  well-defined, but no end-to-end run against a daemon was performed.
- **No Qualiber readiness follows from this package.** No Qualiber checkout was
  accessed, no scenario was run, and no product conclusion is drawn.
- **The full canonical campaign and the clean gate were not run.** The affected
  set was derived from this change's own surface, not carried over from the
  previous package's 71.
- **ADR-ERL2-038 R4's collector-identity binding is still write-only** (review
  F-9): `collector_image_digest` and `collector_config_digest` are written into
  the binding block and read by no consumer. Out of scope here, still open.
- **No historical evidence was edited.** `docs/evidence/` is byte-identical and
  `evidence:update` was not run; nothing was changed to make earlier runs appear
  to have tested this behaviour.
