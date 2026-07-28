# Slice 6.5-B ledger — environment and journey orchestration

Companion to [ADR-ERL2-021](../adr/ADR-ERL2-021.md). This records what was built,
what was measured, and — the part that matters — what turned out **not** to be
load-bearing when it was tested.

## 1. What ships

Seventeen new commands, plus four existing commands that now dispatch on the run's
own evidence:

| Command | Durable transition | Produced roles |
|---|---|---|
| `provision` | `case_selected → environment_provisioned` | `environment-reservation-lease` ×4, `environment-resource-inventory`, `environment-operation-receipt` |
| `baseline` | `environment_provisioned → baseline_verified` | `environment-baseline` |
| `plan` | `baseline_verified → execution_plan_frozen` | `execution-plan` |
| `install` / `configure` / `authenticate` / `connect` / `recover` / `rollback` / `remove` / `execute-subject` | `… → step_planned → step_started → step_{succeeded,failed,unsupported} → step_outcome_frozen` | `journey-step-outcome` |
| `activate` | `step_outcome_frozen → challenge_activated` | `mutation-receipt` |
| `journey` | `challenge_activated → traffic_or_journey_started` | `monotonic-clock-domain`, `traffic-process-start-receipt`, `runtime-milestone` |
| `observe` | `traffic_or_journey_started → evidence_cutoff_realized` | `source-snapshot` ×N |
| `freeze-observation` | `→ observation_frozen → canonical_evidence_envelope_frozen → adapter_translation_frozen` | `observation-bundle`, `canonical-evidence-envelope`, `adapter-translation-receipt` |
| `freeze-output` (env variant) | `step_outcome_frozen → subject_output_frozen` | `subject-output-manifest` |
| `reveal` (env variant) | `subject_output_frozen → judge_journey_expectation_revealed` | `judge-expectation-reveal`, `exposure-event` |
| `evaluate` (env variant) | `→ nonfunctional_journey_result_frozen → domain_not_applicable_frozen → generic_precleanup_results_complete` | `metric-result` ×N, `journey-result`, `domain-result`, `precleanup-result-join` |
| `restore` | `generic_precleanup_results_complete → lab_cleanup_started → environment_restored` | `compensation-receipt`, `environment-restoration` |
| `destroy` | `environment_restored → teardown_started → teardown_verified` | `environment-operation-receipt`, `teardown-verification` |
| `finalize-generic` (env variant) | `teardown_verified → environment_validity_result_frozen → generic_evaluation_index_frozen` | `validity-result`, `generic-evaluation-index` |

The named step commands are guards, not selectors: each may only run the step the
selected journey ordered next. `execute-subject` runs whichever comes next.
`discover`, `exercise` and the `observe` *intent* have no named command — the
`observe` command name belongs to the capture phase — and run through
`execute-subject`.

## 2. Negative controls

Every new guard was disabled in turn, the suite re-run, and the result recorded.
Two of them did **not** produce a failure. Those are reported as defense in depth
rather than quietly kept as if they were proven.

| Guard | Disabled how | Result |
|---|---|---|
| `activate` requires a **succeeded connect outcome** | condition forced false | `ENV-MUT: activation is refused until the journey has actually connected` fails (8 pass / 1 fail) |
| `freeze-output` requires **no committed step outstanding** | condition forced false | `ENV-MUT: subject output cannot freeze while a committed step is still owed` fails (8 pass / 1 fail) |
| a named step command may not **reorder** the journey | intent comparison forced false | `ENV-ORDER` fails (8 pass / 1 fail) |
| the driver's **durable substrate** | `FileSubstrateStore` replaced by the in-memory one | 8 of 9 e2e cases and 5 of 9 adversarial cases fail — the whole path collapses |
| **`assertRepeatableBaseline`** (two baseline probes must agree) | removed, second probe aliased to the first | **suite stays green (9 pass / 0 fail)** |
| the five **`case_selected`** binding-vs-manifest comparisons | all five removed | **suite stays green (18 pass / 0 fail)** |
| `verifyEnvironmentBundle` (inherited gap 1) | made to `throw` unconditionally | **suite stays green (518 pass / 0 fail)** — still dead code |

### The two that are not load-bearing, and why

**`assertRepeatableBaseline`.** The fake driver is deterministic, so two baseline
probes of the same clean environment agree by construction. The check would fire
against a nondeterministic driver — which is exactly what the Compose driver will
be — so it is kept and stated for what it is. It is not evidence that the
environment is reproducible; it is evidence that this driver is deterministic.

**The `case_selected` comparisons.** The producer builds each pool entry *from*
the admitted challenge manifest and journey definition, so the opened payload
agrees with them by construction, and a run whose retained copies were tampered
with fails earlier on the artifact store's own hash check. They would fire against
a pool forged outside the shipped producer. This is the same class as
`assertNoSelectionArtifacts` in the pre-environment path, and it is documented at
the call site so a later reader does not restate it as proven.

## 3. Defects found in existing code

1. **The CLI transcript golden silently went stale for a whole slice.**
   `fixtures/golden/cli-transcript.json` is one of the byte-pin's seven
   exclusions, so nothing compared it. When Slice 6.5-A shipped `erl2 select`, the
   committed transcript kept claiming `select` refused with
   `POLICY_COMMAND_NOT_IMPLEMENTED`, and `tests/e2e/expectedRefusals.test.ts`
   pinned that stale expectation, so the drift-detector agreed with the drift.
   Corrected here. The general hazard remains: an excluded file gets no drift
   detection at all, and the exclusion list is the one place where "unpinnable"
   and "unchecked" are the same thing.

2. **Design Appendix C and the shipped `select` disagree on a flag.** Appendix C
   spells `erl2 select --request HASH --source-trust-config PATH`. ADR-ERL2-020 §5
   made `select` advance a *run*, so the shipped flag is `--run`. Not fixed here —
   which spelling is authoritative is a contract decision, not an implementation
   one — but it is now visible rather than buried in a stale golden.

3. **The baseline fingerprint cannot be compared across probe phases.** The probe
   phase is part of the fingerprint, so a `restoration`-phase measurement can
   never equal the `baseline` it is supposed to have returned to. Restoration is
   therefore re-measured in the baseline phase. This is a real trap for the
   Compose driver: the comparison would have failed for a reason that has nothing
   to do with the environment.

4. **`journey-selection-policy/v1` still has the provisional signer row**
   ADR-ERL2-020 §2a left it with. It now has a real producer (the governor
   registry), signed by `policy_author`, which is what §2a assigned by analogy —
   so the analogy held, but the row should be re-derived and marked non-provisional
   in whichever slice next touches ADR-ERL2-020.

## 4. Deliberate golden regeneration

Three new keys enter the development trust policy (`traffic_supervisor`,
`runtime_attestor`, `vault_authorizer`), the governor registry admits four new
artifacts (archetype, comparison policy, cutoff policy, equivalence profile), the
challenge family's journeys were rebuilt per candidate, and
`FIXED_PAYLOAD_PLAINTEXT_BYTES` rose to 2048. Every one of those changes the run
trust policy hash or a challenge hash, so every golden changed.

`npm run evidence:update` was run once, deliberately. Coverage is unchanged:
**780 pinned files, 7 excluded by exact path**. Two independent generations are
byte-identical, and `npm run evidence:verify` passes.

New golden tree manifest:

```
find fixtures/golden -type f | LC_ALL=C sort | xargs shasum -a 256 | shasum -a 256
```

## 5. What is not here

- **No environment terminal.** The path stops at `generic_evaluation_index_frozen`.
  No `EnvironmentLabRunRecordV1`, attestation, signer inventory or public bundle is
  produced, so `verifyEnvironmentBundle` is still unreachable (measured, §2) and
  the three §15.4 mutations that need an environment terminal are still open.
- **No invalid environment terminal.** A partial provision, a failed restoration
  and a failed teardown are typed, loud refusals that name the authorized route
  (`invalid_failure_detected` / emergency cleanup) rather than taking it. The fake
  driver only reaches those states under a scripted fault, so no shipped path hits
  them — but a run that did would stop without an invalid record, which
  ERL2-FR-001 requires.
- **No `pre_reveal_subject_cleanup_started` route.** The shipped journey ends every
  committed step before freezing output, so it uses the direct
  `step_outcome_frozen → subject_output_frozen` edge. The cleanup-entry edge exists
  in the transition table and is unexercised.
- **No evaluated domain plane.** `evaluateDomain` itself refuses: an evaluated
  domain result requires a revealed functional truth, and this run reveals only
  journey-scope expectations. The not-applicable reason is *derived* from the
  terminal stage, not chosen.
- **No signed controller receipt.** Design §12 asks for "signed controller and
  traffic receipts" at activation. The traffic receipt is signed; the activation
  evidence is `EnvironmentOperationReceiptV1`, which the frozen schema does not
  sign. No V2 contract carries a signed controller receipt.
