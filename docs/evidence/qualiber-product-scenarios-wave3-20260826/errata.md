# Wave 3 — errata

Known blemishes and historical defects in the evidence trail, each with its authoritative
replacement or compensating control. None is silently repaired; all source bytes are preserved.

## E-1 — Post-freeze runner digest mismatch (completion attempt)

- **Where:** `history/completion-attempt/oracle-precommit.json` vs
  `history/completion-attempt/tooling-test-result.json`; surfaced in
  `history/completion-attempt/independent-review-result.json`.
- **Defect:** the completion oracle-precommit committed
  `run-negative-control.mjs = a8f0d1b690a73299d5c639ea04f558150235b04efa0c531088f81ee78d735cb5`,
  but the runner actually on disk (and honestly recorded by the tooling-test-result) was
  `951326f76e438d7c7e4abea10d11ec147d9af660cc1ebe2a7f2aa259d074215c`. The script was edited
  **after** the precommit froze; the precommit `amendments` array is empty. This weakened the
  pre-registration of the completion attempt's negative-control tooling.
- **Authoritative replacement:** `control-set-v2` closure re-froze the on-disk v1 runner
  `951326f7…` in `control-closure/control-precommit.json` and
  `control-closure/control-execution-lock.json` (both binding `951326f7…`, mode 644) and
  re-executed all controls from the frozen methods; the FINAL review verified the digest and mode.

## E-2 — Original NC-11 property miss (completion attempt)

- **Where:** `history/completion-attempt/negative-controls/results/NC-11.json`.
- **Defect:** NC-11 produced `disagree/product_disagreement` via `run_status_mismatch`, not the
  designed `forbidden_run_status_observed`. Because QLB-EXT-012's observed run_status is `clean`
  (not `inconclusive`), the forbidden-status check never fired; the control did **not** prove
  forbidden-status precedence (rule 6).
- **Authoritative replacement:** **NC-11R** (`control-closure/results/NC-11R.json`,
  `control-closure/nc11r/`) — positive fixture agrees; forbidden fixture disagrees via
  `forbidden_run_status_observed` with `run_status_mismatch` provably excluded
  (expected == observed == inconclusive); disabling rule 6 turns the property red. Original
  NC-11 is **superseded, not counted** as a passing control.

## E-3 — Original NC-12 method miss / FAILED (completion attempt)

- **Where:** `history/completion-attempt/negative-controls/results/NC-12.json`;
  `history/completion-attempt/candidate-defect-register.json` (CDF-001).
- **Defect:** NC-12 **FAILED** — a residue file planted in `product-out/` was invisible to the
  comparator, which checks only declared `retained_output_refs`. The offline verifier / residue
  scanner (the surfaces the control's method required) were not exercised.
- **Authoritative replacement:** **NC-12R** (`control-closure/results/NC-12R.json`,
  `control-closure/nc12r/`) — HELD (`lab_harness_failure`): a clean scan passes and planted
  residue is refused and named (`undeclared_file_in_retained_tree`); the residue-scanner suite
  (33/33) exercises symlink / traversal / duplicate / missing / non-regular protections. Original
  NC-12 is **superseded, not counted** as a passing control.

## E-4 — Unindexed independent-review result (completion attempt)

- **Where:** `history/completion-attempt/independent-review-result.json`.
- **Defect:** this file is present on disk in the completion evidence root but is **absent from
  that attempt's own `evidence-index.json`** (which lists 33 entries; the file is the 34th,
  unlisted). The completion attempt's index is otherwise internally consistent, so the path set
  of that historical index does not equal the files on disk.
- **Disposition:** preserved **as-is** under `history/completion-attempt/`. It is not added to the
  historical index (that would edit source history). In **this** candidate's canonical
  `evidence-index.json` the file is a normal indexed content file, so it is fully covered here.

## E-5 — NC-10 precommit annotation looseness (control closure)

- **Where:** `control-closure/control-precommit.json` →
  `expected_outcomes["NC-10"].sub_reasons`.
- **Blemish:** the precommit's human-readable `sub_reasons` for NC-10 reads
  `["run_status_mismatch"]`, whereas the frozen method's own embedded `precommitted_outcome`
  and the reproduced result use `required_finding_type_absent:wrong_order`. The **verdict**
  (HELD / product_disagreement) is correct and reproducible; only the precommit's summary
  annotation is loose. Documentation blemish only — non-blocking per the FINAL review.

## E-6 — Undocumented `source_tree_sha256` algorithm (control closure)

- **Where:** `control-closure/source-scenario-bindings.json` and
  `control-closure/control-precommit.json` (`source_scenario_evidence_digests`).
- **Blemish:** the `source_tree_sha256` values are self-declared and could not be reproduced from
  standard canonical tree-hash recipes; the algorithm is undocumented. **Immaterial:** source
  integrity is independently established by byte-identical comparison of the source scenario trees
  to the immutable attempt-1 root (and, in this candidate, by `provenance/source-manifests/`).
  Non-blocking per the FINAL review.

---

**Summary of authoritative replacements:** runner re-frozen as `951326f7…` (E-1);
**NC-11 → NC-11R** (E-2); **NC-12 → NC-12R** (E-3). E-4/E-5/E-6 are documentation/index
blemishes with no effect on the four scenario verdicts, determinism, or the 15 active controls.
