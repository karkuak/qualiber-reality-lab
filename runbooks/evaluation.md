# Runbook — generic evaluation, terminal closure and finalization

Covers the Slice 6 commands: `reveal`, `evaluate` and `finalize-generic`, plus
the offline verification that follows them.

## The order, and why it is the order

```text
freeze-output  →  reveal  →  evaluate  →  finalize-generic  →  verify
```

Each arrow is enforced by the lifecycle state machine and re-derived by the
offline verifier; none of them is a convention.

1. **`freeze-output`** freezes the subject output. Nothing may be revealed
   before this, because a reveal before the freeze could change what the subject
   produced.
2. **`reveal`** opens the committed judge expectations for the *failed and
   unsupported* steps only. A succeeded step's expectation stays sealed, and an
   expectation whose committed `truth_scope` is `functional` is refused on this
   path — a pre-environment terminal never opens functional mechanism truth.
3. **`evaluate`** freezes the journey result, exactly one domain result and the
   pre-cleanup result join. The join is the **sole cleanup-entry guard**.
4. **`finalize-generic`** runs cleanup, evaluates Lab-owned validity, freezes the
   generic evaluation index and the terminal run record, derives the mandatory
   closure, and only then signs the attestation and freezes the public bundle.
5. **`verify`** re-derives everything in a fresh process with the network
   disabled and the trust head taken only from locally pinned configuration.

## Running it

```bash
erl2 reveal --run "$RUN_ID" --run-root "$RUN_ROOT" --registry "$REGISTRY" --tier development --vault "$VAULT"
```

```bash
erl2 evaluate --run "$RUN_ID" --run-root "$RUN_ROOT" --registry "$REGISTRY" --tier development
```

```bash
erl2 finalize-generic --run "$RUN_ID" --run-root "$RUN_ROOT" --registry "$REGISTRY" --tier development --claim-scope T1
```

```bash
erl2 verify --public-bundle "$RUN_ROOT/retained/public-bundle.json" --root-config "$TRUST_CONFIG" --artifact-root "$RUN_ROOT" --lifecycle "$LIFECYCLE_STREAM" --offline
```

`--claim-scope` accepts only `T1`, `T2` or `T3`. A base attestation can never
emit `T4`; that requires a separately verified customer bundle which does not
exist.

## What each command refuses, and what it means

| Refusal | Meaning | What to do |
|---|---|---|
| `REVEAL_BEFORE_OUTPUT_FREEZE` | `reveal` ran before `freeze-output` | Freeze the subject output first. This is an ordering invariant, not a retry. |
| `REVEAL_TRUTH_SCOPE_FORBIDDEN` | an expectation carrying functional truth was reached on the pre-environment path | The commitment is wrong for this terminal; do not widen the reveal. |
| `REVEAL_CIPHERTEXT_MISMATCH` | the retained ciphertext or its plaintext does not match the commitment | Treat as tampering. The run cannot be evaluated. |
| `EVALUATOR_STEP_OUTCOME_NOT_DERIVED` | the subject output's step array disagrees with the lifecycle-derived order | The producer array is a claim; the lifecycle is the source. Investigate the adapter or the store. |
| `EVALUATOR_CLEANUP_BEFORE_RESULT_JOIN` | cleanup started before the join | The join is the only cleanup entry. Do not re-order. |
| `EVALUATOR_RESULT_JOIN_INCOMPLETE` | a journey or domain result is missing, or the join event does not follow both | Run `evaluate` before `finalize-generic`. |
| `EVALUATOR_INVALID_VALIDITY_IN_GENERIC_INDEX` | validity is invalid | The run freezes an invalid terminal record instead. It will never produce a bundle. |
| `EVALUATOR_VALIDITY_GATE_NOT_LAB_OWNED` | a gate outside the Lab catalogue was scored | Validity may not read subject quality. Remove the gate. |
| `GRAPH_CLOSURE_MISSING_ROLE` | the derived closure is incomplete | A mandatory artifact was never produced. The refusal names the role. |
| `GRAPH_CLOSURE_EXTRA_ARTIFACT` | a retained artifact the run record does not account for | Every retained artifact must be reachable from the record. |
| `BUNDLE_FINALIZED_BEFORE_CLEANUP` | cleanup did not pass | A cleanup failure routes to the invalid terminal; it is not finalizable. |
| `RESIDUE_DETECTED` | residual resources are neither zero nor explicitly quarantined | Explicit quarantine is an accounted-for outcome; silence is not. |
| `DEEP_ANCESTRY_FIELD_IN_GENERIC_ARTIFACT` | a deep-plane field appeared in a generic or base artifact | The deep plane is a descendant only. |
| `PACK_NOT_CERTIFIED` | the pack has no passing certification receipt, or the receipt describes different bytes | Re-certify the exact body. |
| `PACK_GENERIC_METRIC_OVERRIDE` | a pack shipped its own definition for a Lab-owned metric | Reference the metric id; do not redefine it. |

## Reading the results

`evaluate` returns each metric with its status and threshold class. Three
statuses exist and they mean different things:

- **`measured`** — the metric computed a value from present inputs.
- **`not_applicable`** — the denominator was empty and the definition declares
  `not_applicable`. This is not a zero.
- **`inconclusive`** — a declared input was unavailable. The result names the
  missing selector and an inconclusive finding is produced. This is not a
  subject defect.

A `hard_safety` metric that is `measured` and fails its threshold cannot be
traded off against any other plane.

## What is not covered here

The **environment** terminal — a run that provisions an environment, selects a
challenge and captures observations — is not reachable through the CLI. Its
contracts and closure roles exist, but the selection, provisioning, activation
and observation commands belong to the slice 3/4 environment branch and have not
shipped. Every run this runbook covers ends at a pre-environment terminal and
produces `DomainResultNotApplicableV1` with the reason `pre_environment_terminal`.

Opaque private and third-party subjects must **not** be run under the
`local-process` profile. See `docs/decisions/open-questions.md` ERL2-OQ-008.
