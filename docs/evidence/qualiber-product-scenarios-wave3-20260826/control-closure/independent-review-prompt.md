# Final independent evidence review — Wave 3 control-set-v2 closure

Read-only review of the control-closure evidence. Do not modify evidence,
tooling, repositories, or GitHub. Work from copies.

## Inputs
- This evidence root (control-closure `evidence/`)
- Immutable attempt-1 and completion evidence roots
- Remediation candidate v1 and v2
- Comparator `83223022…`, real @erl2 anchor (69ace16)

## Required checks
1. Verify `evidence-index.sha256` and `evidence-index.json`: exact path-set
   equality (index excludes only itself + sidecar), every indexed file digest
   verified (not sampled), no symlinks/non-regular/absolute/traversal/duplicate.
2. Verify `control-precommit.json` froze 15 active controls (NC-11/NC-12 absent
   as active), the tooling digests, and the source scenario-tree digests; confirm
   `control-execution-lock.json` binds the precommit and frozen tooling.
3. Re-execute all 15 controls from the frozen methods; require every verdict to
   match `control-precommit.json` expected_outcomes (13 HELD; NC-11R
   disagree/product_disagreement with forbidden_run_status_observed and NOT
   run_status_mismatch; NC-12R HELD with the planted path named).
4. Confirm each control applied its mutation/counterfactual before execution and
   revalidated the source scenarios intact afterward.
5. Confirm NC-11R positive fixture agrees and the forbidden fixture disagrees;
   disable rule 6 and confirm the property goes red.
6. Confirm NC-12R clean-pass / planted-refuse / exact-path, and the symlink /
   traversal / duplicate / missing / unexpected / non-regular protections.
7. Confirm attempt-1, completion, and both candidate versions are byte/path/mode
   identical to `preservation/` and the candidates' own manifests.
8. Confirm no repository/GitHub mutation and no scenario-specific semantic branch
   or Qualiber import in any frozen method.

## End with exactly one of:
WAVE 3 CONTROL CLOSURE ADMISSIBLE — CONTROL SET V2 CONFIRMED
or:
WAVE 3 CONTROL CLOSURE NOT ADMISSIBLE — EVIDENCE INSUFFICIENT
