# ADR-ERL2-039 — an unsuccessful required exercise is invalid, not inapplicable

- **Status:** accepted
- **Date:** 2026-08-15
- **Deciders:** Lab Core Owner, Integrity/Security Owner
- **Extends:** ADR-ERL2-033 (the declaration predicate), ADR-ERL2-038 R8 (ERL2-C-171 authority)
- **Supersedes:** nothing. It corrects a consequence of ADR-ERL2-038 R8's
  applicability rule; the rule itself is unchanged.
- **Evidence:** independent review
  `reality-lab-package3-independent-live-integration-review.md`
  (SHA-256 `440dfbfd9a03e42905e13ae76e0294e2a916ba1a56fbf5986fd31c2e40bed402`,
  verdict `CHANGES REQUIRED`), findings F-1 and F-2

## Context

ADR-ERL2-038 R8 retired a vacuous pass. The `attributable-telemetry-retained`
gate used to be evaluated on every environment terminal and to pass wherever
telemetry was never obtainable, which meant a fake-driver run published
`passed: true` for evidence it could not have had. Package 3 made the gate
**omitted** where telemetry is inapplicable, on the same terms `adapter-certified`
already used.

Telemetry applicability is the ADR-ERL2-033 declaration predicate: a compose
driver, an archetype declaring a metric evidence source, **and a succeeded
exercising step**. The third conjunct is the one this ADR is about.

The independent Package 3 live-integration review drove the real predicate and
the real `buildEnvironmentValidity` and measured this:

| exercise outcome | telemetry applicable | telemetry gate | terminal |
|---|---|---|---|
| succeeded | true | present | valid |
| **failed** | false | **omitted** | **valid** |
| **unsupported** | false | **omitted** | **valid** |
| **none committed** | false | omitted | valid |

The omission is correct — a run that never successfully exercised the subject is
owed no telemetry about the exercise. What was wrong is what happened next:
**nothing else in the gate catalogue could fail on an unsuccessful exercise**, so
the run reached a `valid` terminal. `packages/core/src/evaluation/validity.ts`
said so in its own header: the catalogue contained no reference to a journey
outcome status, and `invalidityFindingHashes` is derived solely from failed
gates. The omission was dominated by nothing.

A second defect sat underneath it. `EnvironmentRun.retainAttributableTelemetry`
guarded on **two** conjuncts (a trusted-telemetry capability and a declared
metric source) while the gate used **three**. A compose run with a metric source
whose exercise did not succeed therefore *froze an ERL2-C-171 record that no gate
ever evaluated* — and where that record was `absent` (collector crash, settle
timeout, channel unprovisioned), the offline verifier raised nothing either,
because a non-declared run's absent record is not an error.

### Why no test caught it

`revealJudgeExpectations` opens the committed expectation of every non-succeeded
step and refuses any whose `truth_scope` is `functional`. The shipped fixture
commits `exercise` and `diagnose_decide` as functional truth, so on that journey
a failed exercise cannot reveal, cannot evaluate, and never reaches a terminal at
all. Every existing test used that fixture.

That refusal is a real guard and it is now pinned by a test — but it is **not** a
substitute for this decision, and the difference is the whole reason this ADR
exists. `truth_scope` is a free per-step governor input. Nothing in the contracts
or in `packages/core` binds `exercise` to `functional`; `FUNCTIONAL_TRUTH_INTENTS`
is a constant of the test fixture. A governor committing a `journey_only`
exercise expectation reveals, evaluates and finalizes normally — and reached a
valid, telemetry-gate-less terminal.

## Decision

### 1. A required exercise that did not succeed makes the run invalid

`subject-exercise-succeeded` is a Lab validity gate in a new
`journey_execution` category, in `ENVIRONMENT_GATE_IDS` and not in
`PRE_ENVIRONMENT_GATE_IDS`.

- **Applicable** exactly where the committed journey ordered an exercising step.
- **Passes** where some retained `exercise` outcome has status `succeeded`.
- **Fails** where it is applicable and no such outcome exists — an unsuccessful
  adapter verdict, an `unsupported` result, or any other non-success.
- **Omitted**, never vacuously passed, where the journey ordered no exercise.

### 2. An unsuccessful exercise is not "not applicable"

Applicability reads *whether an exercising step exists*, never its status. A
failing run and an inapplicable run are different shapes, not the same shape with
a different boolean. `assertExerciseOutcomeApplicability` refuses both rots: an
exercising run omitting or duplicating the gate, and a non-exercising run
publishing it.

### 3. Finalization stays permitted; validity does not

`nextPermittedIntents` is unchanged, and deliberately: it derives successors from
journey position so that recovery, rollback and removal remain reachable and a
failed step can still finalize through its cleanup attempts. A run whose exercise
failed still tears down, still retains its diagnostics, and still reaches a
terminal record. **Permission to finalize is not a valid verdict.** This gate is
where the two stop being confused.

### 4. One applicability predicate, shared

`packages/core/src/journey/exerciseOutcome.ts` holds the exercise-success
conjunct once. It is read by the new gate, by `requiredGateIds`, by
`attributableTelemetryDeclared`, by `retainAttributableTelemetry`, and by the
offline verifier. Two expressions that are supposed to mean the same thing
eventually stop meaning it, and the failure is silent — that is exactly what F-2
was.

`assertTelemetryExerciseCoherence` refuses the contradiction rather than trusting
the sharing: telemetry applicable while the exercise did not succeed; a retained
observation while telemetry is inapplicable; telemetry applicable on a run that
committed no exercise.

### 5. Applicability is frozen *and* derivable, and one existing guard is why

The committed journey is frozen at `case_selected`; the step commitments live in
the admission registry, which an offline reader does not hold. The two coincide
because `EnvironmentRun.freezeOutput` refuses while any committed step is owed,
so a run cannot reach an environment terminal unless every committed step
produced an outcome. At the point these predicates are read, "the committed
journey required an exercise" and "a retained exercise outcome exists" are the
same statement.

`freeze-output-outstanding-step-guard` is the negative control that keeps them
equal. If that guard ever stopped requiring totality, applicability would
silently become a function of how far a run got.

### 6. The offline verifier recomputes, and refuses four shapes

`deriveValidityOutcome` recomputes the obligation from retained step outcomes and
refuses: the gate dropped by an exercising run; the gate published by a run that
never exercised; the gate reporting a verdict its own outcomes contradict; and a
retained attributable-telemetry observation with no gate over it.

It shares the *pure applicability primitives* with the producer on the same terms
`decideTrustedTelemetryAuthority` is already shared — their inputs are step
outcomes the Lab wrote, not bytes a subject controls — and recomputes every
verdict itself. ADR-ERL2-038 §4's rule is unchanged: what may never be shared is
a framing definition whose inputs a subject controls, and this is not one.

## Consequences

### Accepted

**Validity now reads one journey outcome status.** `validity.ts` previously
stated as an absolute that the catalogue referenced none. That absolute is now a
bounded exception, and the file says so. The justification is that the exception
is about the *experiment*, not the subject: the Lab promised to exercise the
subject and observe it, and a run that did not complete its exercising step did
not obtain the evidence it committed to obtain.

**A subject that fails its exercise makes the run invalid.** This is the cost,
and it is real: "the subject failed" and "the run is untrustworthy" are not the
same claim, and this decision makes the first imply the second. It is accepted
because the alternative measured worse — a `valid` attestation over a run whose
telemetry channel could have failed in any way at all, with no gate to say so.
A reader who needs "the subject failed, validly observed" is asking for a claim
this Lab does not currently make, and adding it is a larger decision than this
one.

**Three validity inputs became required rather than optional.**
`exerciseApplicable`, `exerciseSucceeded` and `telemetryObservationRetained` have
no defaults. A defaulted flag would let a producer reach the lenient answer by
silence, which is the shape of the defect this ADR corrects.

### Not decided here

- Whether an exercising step's expectation *should* be committed as
  `journey_only` or `functional`. That stays a governor choice; this ADR only
  refuses to depend on it.
- Live cases H, I and J (a positive-required run with no telemetry, delayed
  telemetry, a collector crash) remain **unstaged**. This package makes them
  semantically well-defined and testable; their live execution belongs to an
  independent review.
- ADR-ERL2-038 R4's collector-identity binding remains write-only (review F-9).
  Out of scope here and recorded as outstanding.
