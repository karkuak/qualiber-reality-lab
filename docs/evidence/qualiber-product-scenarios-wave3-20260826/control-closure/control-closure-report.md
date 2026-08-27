# Wave 3 — control-set-v2 closure campaign report

**Verdict:** `WAVE 3 CONTROL CLOSURE COMPLETE — READY FOR FINAL INDEPENDENT EVIDENCE REVIEW`

**Scope:** control-only. No Qualiber scenario re-run, no comparator semantic change,
no repository or GitHub mutation, no evidence publication, no issues filed. All
work on copies. Attempt-1, completion, and both remediation candidates preserved
byte/path/mode identical.

## 1. Freeze (Phase 2)

`control-precommit.json` and `control-execution-lock.json` were written before any
control executed. The precommit binds: control-set-v2 (15 active methods), the
supersession history (NC-11→NC-11R, NC-12→NC-12R), the v1 and v2 runner digests,
the NC-11R fixture-builder digest, the NC-12R residue-scanner digest, the
comparator (`83223022…`) and dependency-anchor entry digests, the test files and
`tooling-test-result.json`, the four source scenario-tree digests, and the
Sequence-B review verdict + document digest. Active set is exactly:

NC-1, NC-1b, NC-2, NC-3, NC-4a, NC-4b, NC-5, NC-6, NC-7, NC-8, NC-9, NC-10,
NC-13, NC-11R, NC-12R — original NC-11 and NC-12 are superseded, not active.

## 2. Execution (Phase 3) — all fifteen HELD

Retained 13 executed with the frozen v1 runner against a copy of the attempt-1
scenario trees (full scenarios; completion scenarios are comparison-stubs only),
using the completion oracle-precommit (a superset of attempt-1's, adding the
`negative_controls` that NC-1/NC-10 counterfactuals bind to) and the attempt-1
campaign-index; NC-11R and NC-12R with the frozen v2 runner.

| Control | verdict | classification | key sub-reasons |
|---|---|---|---|
| NC-1 | HELD | product_disagreement | run_status_mismatch, required_finding_type_absent:duplicate_event |
| NC-1b | HELD | lab_harness_failure | post-precommit expectation tamper refused |
| NC-2 | HELD | lab_harness_failure | adapter_artifact_hashes_binding_failed |
| NC-3 | HELD | (binding-mismatch) | tampered report unbinds |
| NC-4a | HELD | (binding-mismatch) | 009↔012 product-out swap refused |
| NC-4b | HELD | (binding-mismatch) | 009↔012 qualiber subtree swap refused |
| NC-5 | HELD | lab_harness_failure | retained-input mutation → input_digest_binding_failed |
| NC-6 | HELD | lab_harness_failure | binding tamper refused |
| NC-7 | HELD | lab_harness_failure | harness fault surfaced |
| NC-8 | HELD | lab_harness_failure | harness fault surfaced |
| NC-9 | HELD | lab_harness_failure | harness fault surfaced |
| NC-10 | HELD | product_disagreement | counterfactual disagree |
| NC-13 | HELD | (binding-mismatch) | integrity refusal |
| **NC-11R** | **disagree / product_disagreement** | product_disagreement | **forbidden_run_status_observed** (positive fixture agrees; active fixture disagrees; not run_status_mismatch) |
| **NC-12R** | **HELD** | lab_harness_failure | clean scan passes; planted residue refused and named (`undeclared_file_in_retained_tree`) |

Every control operated on a disposable copy, recorded before-state, applied its
mutation/counterfactual, proved it applied (digest change; counterfactuals bind a
precommitted expectation), executed the exact frozen method, and revalidated the
source scenarios intact afterward (all four trees byte-identical to the immutable
attempt-1 root). No aggregate threshold substitutes for any property.

**NC-11R special requirements:** positive fixture → `agree`/`bound=true`; active
(forbidden) fixture → `disagree`/`product_disagreement`; `forbidden_run_status_observed`
present; `run_status_mismatch` provably NOT the cause (expected==observed==inconclusive);
disabling rule 6 turns the property red. See `nc11r/`.

**NC-12R special requirements:** clean scan passes; planted-residue scan refuses
and reports the exact planted path; symlink / traversal / duplicate / missing /
unexpected / non-regular protections are exercised by the residue-scanner suite
(33/33); the comparator's declared-ref behaviour is recorded separately and is
**not** assigned the residue-scanner's responsibility. See `nc12r/`.

## 3. Evidence layout (Phase 4)

`control-precommit.json`, `control-execution-lock.json`, `tooling-test-result.json`,
`control-set-v2.json`, `results/` (15), `logs/` (raw stdout/stderr),
`mutation-proofs/`, `nc11r/` (fixture record + binding coverage + 3 comparison
outputs), `nc12r/` (scan reports), `supersession-history.json`,
`source-scenario-bindings.json`, `command-log.txt`, `preservation/` (prior-root
manifests), this report, `independent-review-prompt.md`, `evidence-index.json`,
`evidence-index.sha256`. The index excludes only itself and its sidecar; every
indexed file is fully verified; the path set is exact; no symlinks, non-regular,
absolute, traversal, or duplicate entries.

## 4. Closing preservation (Phase 5)

Attempt-1, completion, remediation candidate v1, and candidate v2 are all
byte/path/mode identical open→close. Frozen tooling unchanged. No repository or
GitHub mutation. No surviving processes/listeners/containers. Disposable copies
removed.

---

**WAVE 3 CONTROL CLOSURE COMPLETE — READY FOR FINAL INDEPENDENT EVIDENCE REVIEW**
