# Negative controls — the seven this campaign ran

Exactly seven, per plan revision 4.3 §11. No eighth was smuggled in, and the two *illustrative*
counterfactuals the plan describes for QLB-EXT-001 and QLB-EXT-004 were **not executed** — making
either real would require a named eighth control with a stage-1 precommitted counterfactual, which is
a deliberate, recorded gap rather than one implied away.

**Every control ran against a disposable copy under campaign scratch.** No published evidence file
was mutated, deleted or swapped. The spanning assertion is checked at the end of the campaign: after
all seven controls, `evidence-index.sha256` still verifies over the published tree.

| control | what it mutates | required outcome | observed | gate that caught it |
|---|---|---|---|---|
| NC-1 | nothing — comparator NC-1 mode against the stage-1 precommitted counterfactual | `disagree` / `product_disagreement` | as required | `run_status` equality, reached because the counterfactual's digest binds under `oracle-precommit.json`'s `negative_controls` |
| NC-1b | 003's `expected.json`, edited in place | `unavailable` / `lab_harness_failure` | as required | expectation-digest binding, before any comparison |
| NC-2 | 001's `run-result.json`, deleted | `unavailable`; `clean` never observed | `unavailable`, `clean` absent | adapter `artifact_hashes` witness — see the note below |
| NC-3 | nothing | exit 0 **and** violation **and** `agree`, simultaneously | all three | §10.5 rule 3 — no branch reads an exit code |
| NC-4a | 002↔003 `product-out/` subtrees, sidecars included | both `unavailable` / `lab_harness_failure` | both | record `retained_output_refs` **and** adapter `artifact_hashes`; the `.frozen` sidecars travelled with their files and did **not** fire, which is exactly why both bindings are required |
| NC-4b | 002↔003 whole `qualiber/` subtrees | both `unavailable` / `lab_harness_failure` | both | `stimulus-identity.json` against the sealed plan and precommit input digests, **and** `retained_output_refs` — the swap is internally consistent yet still contradicts its own scenario's plan |
| NC-5 | one byte of a retained input stimulus | verifier or binding refuses; never `agree` | **both** legs refused | `verifyTrustedLocalObservationRecord` on the sealed plan's declared input digest, **and** the comparator's four-way input-digest binding |

## Two things reported as they happened, not as the table predicted

**NC-2's classification.** The plan's §11 row anticipates `unavailable` / `unavailable`, reached via
§10.5 rule 5 (no fallback from a missing `run-result.json`). What actually happens is stronger:
deleting the file also breaks the adapter's `artifact_hashes` witness, and §10.5 rule 7 requires the
binding gate to run *before* any comparison — so the refusal is classified `lab_harness_failure` and
rule 5 is never reached. The control's required property holds exactly: the verdict is `unavailable`
and `clean` never appears as an observed value. **The comparator was not edited to make the
classification match the table**, because the only way to do that would be to relax the binding-first
rule the plan mandates. Rule 5 remains covered by tooling test T7, which exercises it directly.

**NC-5's aborted first attempt.** The first attempt mutated nothing: the host writes retained inputs
mode `0444`, the write was refused, and both legs trivially passed. A control that did not run must
not be reported as one that held, so that attempt is recorded in `NC-5.result.json` and the control
was re-run on a fresh disposable copy with the flip verified by digest (`78210e2e…` → `431f94c9…`)
before either leg executed.
