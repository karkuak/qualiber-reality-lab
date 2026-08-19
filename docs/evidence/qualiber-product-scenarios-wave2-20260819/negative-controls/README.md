# Negative controls — the seven this Wave 2 campaign ran

Exactly seven, per plan revision 4.3 §11, adapted **prospectively** to the Wave 2 scenarios. No
eighth was smuggled in. **Every control ran against a disposable copy under campaign scratch.** No
published evidence file, and no byte of the frozen Wave 1 bundle, was mutated, deleted or swapped.

| control | target | what it mutates | required outcome | observed | gate that caught it |
|---|---|---|---|---|---|
| NC-1 | 006 | nothing — comparator NC-1 mode against the stage-1 precommitted counterfactual | `disagree` / `product_disagreement` | as required | `run_status` equality, reached because the counterfactual's digest binds under `oracle-precommit.json`'s `negative_controls` |
| NC-1b | 006 | 006's `expected.json`, edited in place | `unavailable` / `lab_harness_failure` | as required, `expectation_digest_not_precommitted` | expectation-digest binding, before any comparison |
| NC-2 | 006 | 006's `run-result.json`, deleted | `unavailable`; `clean` never observed; binding-first classification accepted | `unavailable` / `lab_harness_failure`, `run_status` null, `clean` absent | adapter `artifact_hashes` witness |
| NC-3 | 006 | nothing | exit 0 **and** violation **and** `agree`, simultaneously | all three | §10.5 rule 3 — no branch reads an exit code |
| NC-4a | 007 ↔ 008 | `product-out/` subtrees exchanged, sidecars included | both refuse | both `unavailable` / `lab_harness_failure` | record `retained_output_refs` **and** adapter `artifact_hashes`; the `.frozen` sidecars travelled with their files and did **not** fire, which is exactly why both bindings are required |
| NC-4b | 007 ↔ 008 | whole `qualiber/` subtrees exchanged | both refuse through plan / precommit / input binding | both `unavailable` / `lab_harness_failure`, `input_digest_binding_failed` | `stimulus-identity.json` against the sealed plan and precommit input digests, **and** `retained_output_refs` |
| NC-5 | 006 | one byte of a retained input stimulus | verifier and/or binding refuses; never `agree` | **both** legs refused | `verifyTrustedLocalObservationRecord` on the plan's declared input digest, **and** the comparator's input-digest binding |

## Two things precommitted in advance rather than rediscovered

**NC-2's classification was precommitted, not amended.** Wave 1 discovered that deleting
`run-result.json` never reaches §10.5 rule 5, because the deletion also breaks the adapter's
`artifact_hashes` witness and §10.5 rule 7 runs the binding gate first. Wave 2 wrote that outcome
into `oracle-precommit.json` **before execution**: `unavailable` required, a binding-first
`lab_harness_failure` classification **accepted**, `clean` never observable, and binding precedence
**not** to be weakened. The observed result matched the prospective precommit exactly. The
comparator was not edited. Rule 5 remains covered directly by tooling test T7, which passed.

**NC-5's procedure was corrected in advance.** Wave 1's first NC-5 attempt mutated nothing — the
host writes retained inputs mode `0400`/`0444`, the write was refused, and both legs passed
trivially. Wave 2 precommitted the corrected procedure and followed it: the copy was made writable,
exactly one byte was changed (offset 240), **the digest change was proven**
(`fef741e0…` → `3f2a8c46…`) and only then were the two legs run. Both refused. **No aborted attempt
occurred in Wave 2**, and the Wave 1 void-mutation mistake was not repeated.
