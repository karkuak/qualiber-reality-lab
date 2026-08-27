# Wave 3 — IRD-001 remediation report

**Task:** Resolve IRD-001 in the Wave 3 control-remediation candidate and prove
NC-11R's complete binding and forbidden-status precedence.

**Verdict:** `IRD-001 RESOLVED — CONTROL REMEDIATION V2 READY FOR FOCUSED INDEPENDENT REVIEW`

**Scope respected:** corrected/tested candidate tooling in scratch only. No
campaign frozen, no official controls executed, no retained evidence altered, no
repository or GitHub write. All work on copies under
`/private/tmp/qualiber-wave3-ird001-remediation-1787763639-79931/`.

---

## 1. IRD-001 disposition — CONFIRMED defect, wrong original diagnosis

The independent review saw `result.retained_output_refs = []` on QLB-EXT-012's
top-level result and inferred the fixture builder silently skips the retained
binding. **That inspected the wrong record layer.**

The comparator (`83223022…`) binds artifacts from
`record.operation_records[]` where `operation==="interact" && state==="completed"`
→ `retained_output_refs` (`findInteractCompletedRecord` → `bindArtifact`). It
**never reads** top-level `result.retained_output_refs`. QLB-EXT-012's operation
record carries **11 populated refs**, `run-result.json` included — so the base
scenario *can* support complete binding, and the flagged empty array is cosmetic.

The v1 builder was nonetheless genuinely broken, on a more serious axis:
- `findRunResult` could not locate run-result in the real nested layout → exit 3
  (empirically reproduced).
- `updateRefs` touched only the absent top-level and the empty
  `result.retained_output_refs` — never `operation_records[].retained_output_refs`.
- match predicate compared bare vs `sha256:`-prefixed digests and used
  `logical_path` where refs use `path`.
- no cascade re-bind of run-summary after editing its `artifact_hashes`.

**Proven consequence:** a run-result mutated without updating the operation-record
ref fails `bindArtifact` → `bound=false` (rule-7 gate) → comparator returns
`unavailable`; **rule 6 is never reached** and NC-11R proves nothing. (Run
through the real comparator: `unavailable`/`lab_harness_failure`.)

## 2. Correction (candidate v2)

`nc11r-fixture-builder.mjs` v2 locates files from the record's own refs and binds
every comparator-read layer **exactly once, fail-closed** (0 or >1 match → hard
exit 3): the run-result operation-record ref (PRIMARY), run-summary
`artifact_hashes` (SECONDARY), run-summary's cascade ref, and the run-result
`.frozen` sidecar. run-summary `.frozen` is explicitly **inapplicable** with
source-backed reasoning (the comparator only walks product-out sidecars). The
top-level empty array is intentionally left untouched. The record `core_hash` is
not recomputed (the comparator never validates it). The builder emits a
self-consistent fixture oracle so the fixture runs end-to-end through the real
comparator, and reports every intended binding update.

`run-negative-control-v2.mjs` v2's `runNC11R` now **actually invokes the real
comparator** (v1 returned `PENDING_COMPARATOR_EXECUTION`) and asserts the full
property set. NC-12R tooling (`residue-scanner.mjs`, its test) is preserved
**byte-identical** to v1.

## 3. End-to-end proof (real comparator `83223022…`, real `@erl2` anchor `69ace16`, real QLB-EXT-012 bytes)

| Scenario | expected | forbidden | verdict | bound | sub_reasons |
|---|---|---|---|---|---|
| Baseline QLB-EXT-012 (unmutated) | clean | [inconclusive] | agree | true | `[]` |
| Naive mutation (no ref update) | inconclusive | [inconclusive] | **unavailable** | false | binding failure — rule 6 unreached |
| POSITIVE-BOUND-CONTROL | inconclusive | — | **agree** | true | `[]` |
| **NC-11R FORBIDDEN-PRECEDENCE** | inconclusive | [inconclusive] | **disagree / product_disagreement** | true | `[forbidden_run_status_observed]` |
| MUTATION-NO-FORBIDDEN | inconclusive | — | **agree** | true | `[]` |
| precedence branch disabled | inconclusive | [inconclusive] | agree | true | property correctly red |

`run_status_mismatch` is never the operative reason (expected == observed ==
inconclusive); removing the forbidden list flips the verdict to `agree`.

## 4. Tests — 51/51

- `test-nc11r-binding.mjs` — **18/18**: exact binding path; empty top-level cannot
  hide a missing op-record binding; zero-match hard fail; multi-match hard fail;
  every update reported; positive agrees; NC-11R `forbidden_run_status_observed`;
  `run_status_mismatch` cannot satisfy NC-11R; precedence-disable goes red; real
  comparator + real bytes; path-neutral across two scratch roots.
- `test-residue-scanner.mjs` — **33/33** (NC-12R, unchanged).
- Runner control checks: NC-11R `disagree/product_disagreement` (exit 0);
  NC-12R `HELD` (exit 0).

## 5. Preservation

Both immutable evidence roots and every remediation input (including the v1
candidate) are byte/path/mode identical open→close (empty diffs; identical
aggregate manifest digests `106d7cad…`, `df7963ec…`, `c8d2bbba…`). v1 candidate
preserved; v2 is a new sibling directory — neither overwritten.

## 6. Deliverables

- `qualiber-wave3-ird001-remediation-report.md` (this file)
- `qualiber-wave3-control-remediation-candidate-v2/` (design v2, control-set v2,
  corrected builder + runner, preserved scanner, tests, tooling-test-result,
  digest-mode inventory, IRD-001 disposition, REPRODUCTION, binding-coverage)
- `qualiber-wave3-ird001-binding-coverage.json`
- `qualiber-wave3-ird001-focused-review-prompt.md`
- `qualiber-wave3-ird001-preservation/` (open+close manifests, empty diffs)
- `qualiber-wave3-ird001-SHA256-MANIFEST.txt` + `REPRODUCTION.md`

---

**IRD-001 RESOLVED — CONTROL REMEDIATION V2 READY FOR FOCUSED INDEPENDENT REVIEW**
