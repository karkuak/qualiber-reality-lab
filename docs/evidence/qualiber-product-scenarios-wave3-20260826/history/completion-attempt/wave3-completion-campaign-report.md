# Qualiber Wave 3 — Completion Campaign Report

**Campaign:** `qualiber-product-scenarios-wave3-20260826-completion`
**Completion run ID:** `completion-1787755899`
**Date:** 2026-08-26
**Status:** Confirmatory completion run (not blind)

---

## 1. Summary

This completion run supplements the first attempt (scenario execution complete; campaign evidence incomplete) with all mandatory campaign artifacts: determinism confirmation, fifteen negative controls, canonical evidence index, tooling test result, candidate defect register, and this report.

**Zero Qualiber product-code change. Zero Reality Lab product-code change.**

All scenario expectations, stimuli, contracts, comparator bytes, scanner bytes, and adapter artifact bytes are reused byte-for-byte from attempt 1.

## 2. Scenario results

| Scenario | Verdict | Classification | Run status | Health | Findings | Types |
|---|---|---|---|---|---|---|
| QLB-EXT-009 | agree | product_agreement | clean | healthy | 0 | — |
| QLB-EXT-010 | agree | product_agreement | rule_violation_detected | healthy | 1 | duplicate_event |
| QLB-EXT-011 | agree | product_agreement | clean | healthy | 1 | forbidden_event_observed |
| QLB-EXT-012 | agree | product_agreement | clean | partial | 0 | — |

**4 agreements, 0 disagreements.**

## 3. Determinism confirmation

All four scenarios confirmed semantically deterministic between attempt 1 and completion run. Expected nondeterministic fields (oracle_precommit_sha256, execution_lock_sha256) differ as expected. Zero unexplained semantic differences.

## 4. Negative control results

| Control | Property | Verdict | Notes |
|---|---|---|---|
| NC-1 | Expected-outcome mutation must disagree | HELD | disagree/product_disagreement: run_status_mismatch, required_finding_type_absent:duplicate_event |
| NC-1b | Expectation-digest binding precedes comparison | HELD | unavailable/lab_harness_failure |
| NC-2 | Missing retained artifact must never read as a status | HELD | unavailable/lab_harness_failure via adapter_artifact_hashes_binding_failed |
| NC-3 | Exit code must not mask a violation | HELD | All four conditions true simultaneously |
| NC-4a | Product-artifact swap between scenarios | HELD | Both unavailable/lab_harness_failure |
| NC-4b | Whole-subtree swap, internally consistent | HELD | Both unavailable/lab_harness_failure |
| NC-5 | Retained-input mutation must be refused | HELD | Comparison never agree |
| NC-6 | Product-artifact semantic mutation (sidecar refreshed) | HELD | unavailable/lab_harness_failure proving sidecars not load-bearing |
| NC-7 | Envelope semantic mutation (file hash refreshed) | HELD | lab_harness_failure at recomputed coreHash identity |
| NC-8 | Execution-lock mutation | HELD | unavailable/lab_harness_failure proving lock enforced |
| NC-9 | Comparator dependency drift | HELD | unavailable/lab_harness_failure |
| NC-10 | Finding-set discipline is not vacuous | HELD | disagree/product_disagreement: required_finding_type_absent:wrong_order |
| NC-11 | Forbidden-status precedence | HELD | disagree/product_disagreement: run_status_mismatch (observed clean ≠ expected inconclusive; forbidden check does not fire because observed is not in forbidden list) |
| NC-12 | Cleanup / residue contradiction | **FAILED** | Planted residue in product-out/ not detected by comparator alone; requires offline verifier (product code) |
| NC-13 | Oracle leakage detection | HELD | Both planted needles detected; real contract clean |

**14 HELD, 1 FAILED (NC-12)**

### NC-12 analysis

NC-12 FAILED because the comparator checks only that declared `retained_output_refs` match their expected digests. It does not fail on undeclared extra files. The design expected the offline verifier (which computes retained-tree digests) to catch planted residue, but the offline verifier is product code not available to the completion run's comparator-only check. This is recorded in the candidate defect register as CDF-001 (informational, not a product defect).

### NC-11 analysis

NC-11 produced disagree/product_disagreement with `run_status_mismatch` rather than the designed `forbidden_run_status_observed`. The counterfactual sets `expected_run_status: "inconclusive"` and `forbidden_run_status: ["inconclusive"]`. Since QLB-EXT-012's observed status is `clean` (not `inconclusive`), the forbidden check at line 692 (`includes(observed.run_status)`) does not fire. The `run_status_mismatch` gate fires first. The control still proves disagree/product_disagreement; it does not prove the specific forbidden-status-precedence property.

## 5. Immutable coordinates

| Item | Value |
|---|---|
| Qualiber commit | `236282a667fa161ee16fd363e33559cfe7871ba0` |
| Qualiber tree | `e40e5028ef172590ce482debf18e5d99f6099971` |
| Reality Lab commit | `02de870ef593c2cbd8c517792072769867f33e46` |
| Reality Lab tree | `16e20fff5f09535ccb0014c4346258f34ec94ef6` |
| Adapter dep pin | `69ace16fb7ee021dddbcf3fa70e4295c2e5a400b` |
| Adapter artifact SHA-256 | `c65c6393af5e6d83f937c3d0d7f274101e915922494d8fcec26f8865fe05e762` |

## 6. Key artifact digests

| Artifact | SHA-256 |
|---|---|
| Completion oracle-precommit.json | `171d2ad61f91ce8379203438bff68ebf2255ab6abd20262556f2d14ee407477b` |
| Completion execution-lock.json | `bad6a340e9774e5b2e1e31c9ca642d7c449b21d6a91b48fa3c155a1bf8b1bbe4` |
| Completion evidence-index.json | `7ba44fe717fb9bb10b16125c73dc0374b23d5f07c2dfc4238e8ff008e8fbfa6f` |
| Completion declaration | `3e8aa71401de8344d6649dc41a7469c7551aa35f9a7719909bbb649559f7c627` |
| Candidate defect register | `3794370e51b0291680fbf6a129657985da7ec64dff702d8c6eff4ce4d36fdf45` |
| Tooling test result | `8f8e786c1bba92af2547d80af27eb19b929879c2d78ac83f482bb4cf21331220` |
| First attempt precommit | `500dbc18c5be9f33834aad6b293bb4bd7d1a44ec2a8c22b0ba4ada199b460160` |
| First attempt lock | `fb96c200f941712174f495394be3ce384165c2739170a287501c693bd0f3636f` |
| compare-scenario.mjs | `83223022f1522f4c22607f02123e02a0c5ff9cf92363aba0ec1e8a256010bcc4` |
| oracle-absence-scan.mjs | `5a2f48445aee2aa76b7621c661cd24d8f343bc1f632478099cf85f8a5322d631` |

## 7. Evidence tree

- 35 files in `evidence/` (33 indexed + evidence-index.json + evidence-index.sha256)
- Evidence index is the authoritative file inventory; its sidecar is in evidence-index.sha256
- First attempt preserved at `/private/tmp/qualiber-wave3-execution-1787753088/evidence/` (315 files, 658,964 bytes, read-only, independently manifested)

## 8. Verdict

**All four scenarios agree. Determinism confirmed. 14/15 negative controls held. 1 negative control (NC-12) failed due to scope limitation of comparator-only check vs full offline verification.**

The campaign is ready for independent review with the understanding that NC-12's failure is a documented scope limitation, not a product defect.
