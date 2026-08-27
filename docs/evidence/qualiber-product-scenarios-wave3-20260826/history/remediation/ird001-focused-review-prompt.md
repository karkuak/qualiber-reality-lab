# Focused independent review prompt — IRD-001 correction & NC-11R binding/precedence

Perform a focused, independent, **read-only** review of the IRD-001 correction
and the NC-11R complete-binding / forbidden-status-precedence proof. Do not
modify candidate tooling, evidence, repositories, or GitHub. Work from copies in
a fresh `/private/tmp` root.

## Inputs
- `/private/tmp/qualiber-wave3-ird001-remediation-report.md`
- `/private/tmp/qualiber-wave3-control-remediation-candidate-v2/`
- `/private/tmp/qualiber-wave3-ird001-binding-coverage.json`
- `/private/tmp/qualiber-wave3-ird001-preservation/`
- `/private/tmp/qualiber-wave3-control-remediation-independent-review-result.json` (v1 review that raised IRD-001)
- Both immutable evidence roots:
  - `/private/tmp/qualiber-wave3-execution-1787753088/evidence/`
  - `/private/tmp/qualiber-wave3-completion-1787755899/evidence/`
- Real comparator: `/private/tmp/qualiber-wave3-comparator-candidate/compare-scenario.mjs` (`83223022…`)
- Real `@erl2` anchor: `/private/tmp/qualiber-wave3-comparator-freeze-readiness-1787714909978-15540/pkg-src/real-anchor/package.json`

## Required checks
1. Verify every input manifest (`qualiber-wave3-ird001-preservation/*.sha256`,
   open==close, empty diffs). Confirm both evidence roots and **both** candidate
   versions (v1 and v2) are unchanged.
2. Re-derive the comparator's real retained-output binding source from
   `compare-scenario.mjs` bytes: `findInteractCompletedRecord` →
   `operation_records[interact/completed].retained_output_refs` → `bindArtifact`.
   Confirm top-level `result.retained_output_refs` is not read.
3. Confirm the original IRD-001 analysis inspected the wrong layer, and that
   QLB-EXT-012's operation record has populated refs (enumerate them; confirm
   run-result.json present).
4. Rebuild the NC-11R fixture from source with the v2 builder on a disposable
   copy. Confirm each intended layer updates **exactly once** or is explicitly
   proven inapplicable, and that the builder fails closed on: zero matching
   primary refs; duplicate matching refs; unchanged digest; absent run-summary
   witness; stale/absent sidecar.
5. Run the positive control (require `agree`, `bound=true`).
6. Run NC-11R and require: observed inconclusive; expected inconclusive;
   forbidden includes inconclusive; `disagree`/`product_disagreement`;
   `forbidden_run_status_observed`; and that `run_status_mismatch` is NOT the
   operative reason.
7. Disable the forbidden-precedence branch in a comparator **copy** and require
   the NC-11R property to go red (verdict flips to `agree`).
8. Confirm `run_status_mismatch` (a mismatch-only expectation) cannot satisfy
   NC-11R.
9. Confirm all tooling digests and executable modes against
   `digest-mode-inventory.json`; confirm the comparator under test is the pinned
   `83223022…`.
10. Confirm no scenario-specific semantic branch and no Qualiber import in the
    v2 tooling.
11. Re-run the complete suite: `test-nc11r-binding.mjs` (18/18) and
    `test-residue-scanner.mjs` (33/33); re-run NC-12R (`HELD`).
12. Confirm results are path-neutral across two scratch roots.
13. Write the review result **outside** every evidence/candidate directory.

## Deliverables
- `/private/tmp/qualiber-wave3-ird001-focused-review.md`
- `/private/tmp/qualiber-wave3-ird001-focused-review/`
- SHA-256 manifest and reproduction instructions.

## End with exactly one of:
```
CONTROL REMEDIATION V2 READY TO FREEZE — NC-11R AND NC-12R CONFIRMED
```
or:
```
CONTROL REMEDIATION V2 NEEDS CHANGES — PROPERTY CLOSURE NOT PROVEN
```
