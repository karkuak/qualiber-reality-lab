# Wave 3 control-set-v2 closure — FINAL independent evidence review

**Reviewer:** independent (read-only). **Date:** 2026-08-26.
**Evidence root reviewed:** `/private/tmp/qualiber-wave3-control-closure-1787765436-98932/evidence/`
**Review output location:** this file (outside every indexed evidence root). No evidence, tooling,
repository, or GitHub state was modified; all re-execution ran on fresh copies in a scratch dir.

## Verdict

**WAVE 3 CONTROL CLOSURE ADMISSIBLE — CONTROL SET V2 CONFIRMED**

All eight required checks pass. Every one of the 15 active controls was independently
re-executed from the frozen methods and reproduced its precommitted verdict exactly.

---

## Check-by-check

### 1. Index integrity — PASS
- `evidence-index.sha256` (1 line) verifies `evidence-index.json` = `246ff64c…`.
- `excluded` = exactly {`evidence-index.json`, `evidence-index.sha256`}.
- Exact path-set equality: 83 regular files on disk = 81 indexed + 2 excluded; no missing, no extra.
- All 81 indexed digests **and** byte lengths recomputed and matched (not sampled).
- No symlink, non-regular, absolute, traversal (`..`), or duplicate path anywhere.

### 2. Precommit freeze + execution-lock binding — PASS
- `active_controls` = 15; NC-11 and NC-12 **absent** as active (superseded, not active).
- `expected_outcomes` covers exactly the 15 active controls: 13 base HELD + NC-12R HELD +
  NC-11R disagree/product_disagreement.
- Frozen tooling on disk matches precommit digests **and** mode 644: comparator `83223022…`,
  v1 runner `951326f7…`, v2 runner `f59f3127…`, fixture-builder `b74e6571…`,
  residue-scanner `53b8c3f5…`, oracle-absence-scan `5a2f4844…`.
- `control-execution-lock.json` binds the **actual** `control-precommit.json` (`529f7cdd…`) and
  every frozen tool digest; dependency anchor contracts/integrity entries match; RL pin
  `69ace16f…` (real @erl2).

### 3. Independent re-execution of all 15 controls — PASS
Re-ran the frozen v1 runner (13 retained) and v2 runner (NC-11R, NC-12R) on fresh copies of the
attempt-1 scenario trees + completion oracle-precommit + attempt-1 campaign-index + real @erl2
anchor. **Every verdict, classification, sub-reason, and leg exit code reproduced the recorded
results exactly.**
- 13 retained → HELD (identical classification/sub_reasons/legs).
- NC-11R → `disagree/product_disagreement`, sub `forbidden_run_status_observed`;
  property_checks all true incl. `forbidden_not_via_mismatch` (expected==observed==inconclusive,
  so **not** run_status_mismatch).
- NC-12R → HELD, sub `undeclared_file_in_retained_tree`; clean scan passes, planted residue
  refused and **named**.

### 4. Mutation applied before execution + source revalidated intact — PASS
- Digest-changing mutations record before≠after with `mutationApplied:true`; the frozen runner
  throws VOID if pre==post. Swaps/deletes are structurally recorded; counterfactuals bind a
  precommitted expectation. Re-execution reproduced every mutation identically.
- The runners operate exclusively on scratch copies. The four source scenario trees in the
  re-execution copy are **byte-identical** to the immutable preserved attempt-1 root
  (`qualiber-wave3-execution-1787753088/evidence/scenarios`) — source never mutated.

### 5. NC-11R fixtures + rule-6 dependency — PASS
- `nc11r-positive` → agree (bound); `nc11r-forbidden` → disagree via
  `forbidden_run_status_observed` (bound, modified run_status = inconclusive);
  `nc11r-mutation` (forbidden list removed) → agree.
- Frozen suite `test-nc11r-binding.mjs` re-run: **18/18 PASS**, including T8 (mismatch disagrees
  via run_status_mismatch, NOT forbidden — distinct property), T9 (**precedence disabled → goes
  red**), T10 (pinned real comparator), T11 (path-neutral).

### 6. NC-12R clean/planted/exact-path + protections — PASS
- Clean-pass / planted-refuse / exact planted path named, reproduced.
- Frozen `residue-scanner.mjs` implements symlink_rejected, traversal_rejected,
  duplicate_path_rejected, non_regular_rejected + unexpected/missing enumeration.
- Frozen suite `test-residue-scanner.mjs` re-run: **33/33 PASS** (symlink/unexpected/missing/
  duplicate/multiple/path-neutral + 4 mutation-kills).

### 7. Preservation identity — PASS
All four prior roots byte/path/mode identical to their manifests (independently hashed):
attempt-1 (`qualiber-wave3-execution-1787753088`, 315 files), completion
(`qualiber-wave3-completion-1787755899`, 46), candidate-v1
(`qualiber-wave3-control-remediation-candidate`, 5), candidate-v2
(`qualiber-wave3-control-remediation-candidate-v2`, 12). Both manifest copies
(`prior-manifests/` and `evidence/preservation/`) byte-identical; `prior-open.sha256` verifies.

### 8. No repo/GitHub mutation; no scenario-specific semantic branch or Qualiber import — PASS
- Zero git/GitHub/network surface in any frozen method (no git/gh/http/fetch/octokit/clone/commit).
- Comparator header states "No scenario-id branch"; its logic is purely property-driven. Scenario
  IDs in runners only select which scenario directory to read (dispatch/data lookup), not
  comparison semantics.
- `@erl2/contracts` + `@erl2/integrity` resolved only through the required pinned
  `--dependency-anchor` (createRequire); no static import of Qualiber product code.

### Supersession — PASS
Explicit in `supersession-history.json` and the precommit: NC-11 (orig HELD) → NC-11R;
NC-12 (orig FAILED) → NC-12R. Both originals inactive. The only historically-FAILED control
(NC-12) is **not counted** — its active replacement NC-12R independently re-executes to HELD.

---

## Non-blocking observations (do not affect admissibility)
1. **NC-10 precommit annotation.** `expected_outcomes["NC-10"].sub_reasons` reads
   `["run_status_mismatch"]`, but the frozen method's own definition and the reproduced result use
   `required_finding_type_absent:wrong_order` (the method's embedded `precommitted_outcome` = "missing
   wrong_order"). The **verdict** (HELD/product_disagreement) is correct and reproducible; the
   mismatch is only in the precommit's human-readable summary field, not in the frozen method or
   result. Documentation blemish.
2. **Source-tree digest algorithm undocumented.** The `source_tree_sha256` values in
   `source-scenario-bindings.json` / precommit are self-declared and could not be reproduced from
   three canonical tree-hash recipes. Immaterial: source integrity is independently established by
   byte-identical comparison of the source trees to the preserved attempt-1 root.

---

**WAVE 3 CONTROL CLOSURE ADMISSIBLE — CONTROL SET V2 CONFIRMED**
