# Wave 3 — chronology

All phases share the same immutable product coordinates (Qualiber
`236282a6…` / tree `e40e5028…`, Reality Lab `02de870e…` / tree `16e20fff…`,
adapter dependency pin `69ace16f…`). No Qualiber and no Reality Lab product-code
change occurred at any phase.

## 1. First attempt — scenario execution (authoritative scenario evidence)

Source: `qualiber-wave3-execution-1787753088/evidence/` → `campaign/` and `history/attempt-1/`.

The four scenarios QLB-EXT-009…012 were executed under an owner-authorized execution
lock (`campaign/execution-lock.json`, locked 2026-08-26T13:50:00Z). All four produced
**agree / product_agreement** with complete binding, full inputs/outputs/comparisons,
expectations, oracle pre-commit, and oracle-absence scans. The scenario execution was
**complete and correct**; the surrounding *campaign wrapper* (determinism confirmation,
negative-control battery, canonical index) was **not yet assembled**. Attempt-1
expectations retain chronology authority for the campaign.

## 2. Completion attempt — incomplete campaign wrapper (superseded)

Source: `qualiber-wave3-completion-1787755899/evidence/` → `history/completion-attempt/`
(and its determinism evidence → `determinism/`).

A confirmatory (non-blind) completion run supplied the missing wrapper: four
semantic-determinism checks (all **CONFIRMED**), fifteen negative controls, a canonical
index, a tooling-test result, a candidate defect register, and a completion report.
Results: **4/4 agreements**, **determinism confirmed**, **14/15 controls HELD**. Three
historical defects entered the record here and remain visible (see `errata.md`):

- **Post-freeze runner digest mismatch** — the completion oracle-precommit committed
  `run-negative-control.mjs = a8f0d1b6…`, but the on-disk runner (and the honestly-recorded
  tooling-test-result) was `951326f7…`; no precommit amendment was recorded.
- **Original NC-11 property miss** — produced `run_status_mismatch`, not the designed
  `forbidden_run_status_observed`; the forbidden-status-precedence property was not proven.
- **Original NC-12 method miss (FAILED)** — planted residue was invisible to the
  comparator's declared-ref check; the offline verifier / residue scanner were not exercised.

An **independent review** of this attempt (`ADMISSIBLE_WITH_CAVEATS`) surfaced all three,
but its result file (`independent-review-result.json`) was written into the completion
evidence **without being added to that attempt's evidence-index.json** — i.e. it is
**unindexed** in the source. It is preserved here under `history/completion-attempt/`.

## 3. Control remediation — candidate v1 → IRD-001 → candidate v2

Sources: `qualiber-wave3-control-remediation-candidate/` (v1),
`qualiber-wave3-control-remediation-candidate-v2/` (v2), plus designs, reviews, and
preservation manifests → `history/remediation/`.

A remediation designed **NC-11R** (forbidden-status precedence) and **NC-12R** (residue
enumeration integrity) to supersede the two missed controls. Candidate **v1** was found
genuinely broken by independent review (**IRD-001**): the NC-11R fixture-builder failed to
bind the comparator-read `operation_records[interact/completed].retained_output_refs`
layer, so a mutated run-result unbound the artifact → `unavailable` → rule 6 never reached.
Candidate **v2** corrected the builder (binds every comparator-read layer exactly once,
fail-closed) and made the runner actually invoke the real comparator; the NC-12R
`residue-scanner.mjs` was preserved **byte-identical** to v1. A **focused independent
review** confirmed the fix (tests 18/18 + 33/33; NC-11R disagree via
`forbidden_run_status_observed` with `run_status_mismatch` provably excluded).

## 4. Control-set-v2 closure (authoritative control evidence)

Source: `qualiber-wave3-control-closure-1787765436-98932/evidence/` → `control-closure/`.

The control-only closure froze `control-set-v2` (15 active controls; NC-11/NC-12 superseded,
not active), pinning the on-disk v1 runner `951326f7…` and the v2 tooling in
`control-precommit.json` / `control-execution-lock.json` — **resolving** the completion
attempt's unregistered runner edit. All fifteen controls executed to their precommitted
verdicts on disposable copies, with the four source scenario trees revalidated byte-identical
to the immutable attempt-1 root afterward.

## 5. FINAL independent evidence review

Source: `qualiber-wave3-control-closure-independent-review-FINAL.md` → `reviews/`.

Independent re-execution of all 15 active controls reproduced every verdict, classification,
sub-reason, and exit code exactly. Verdict: **WAVE 3 CONTROL CLOSURE ADMISSIBLE — CONTROL
SET V2 CONFIRMED**, with two non-blocking observations (NC-10 precommit annotation looseness;
undocumented `source_tree_sha256` algorithm — see `errata.md`).

## 6. Final assembly (this candidate)

Byte-preserving composition of all of the above into this immutable publication candidate.
No source edits, no reruns, no publication, no repository or GitHub mutation. The candidate
is **uncommitted and awaiting independent review**. This assembly is not itself a review.
