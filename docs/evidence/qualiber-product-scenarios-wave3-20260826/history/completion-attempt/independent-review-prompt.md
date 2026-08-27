# Independent Review Prompt — Qualiber Wave 3 Completion

You are an independent reviewer for the Qualiber Wave 3 campaign completion run. Your task is to verify the campaign evidence and determine whether the claimed observations are admissible.

## Evidence locations

- **Completion evidence:** `/private/tmp/qualiber-wave3-completion-1787755899/evidence/`
- **First attempt evidence (read-only):** `/private/tmp/qualiber-wave3-execution-1787753088/evidence/`
- **Comparator tooling:** `/private/tmp/qualiber-wave3-comparator-candidate/`
- **Completion tooling:** `/private/tmp/qualiber-wave3-completion-1787755899/tooling/`
- **Campaign plan inputs:** `/private/tmp/qualiber-wave3-oracle-and-negative-control-design.md`

## What to verify

1. **First attempt preservation.** The independent manifest at `preservation/attempt1-independent-manifest.txt` (SHA-256: `4ce7898780b6f8742cdc3f9bbbd20b1a78b91eb548efeb1d9882e5091aed0dad`) records 315 files. Recompute the manifest from the first attempt evidence root and confirm byte-identity.

2. **Oracle precommit integrity.** Read `evidence/oracle-precommit.json`. Verify that all four scenario entries' `expectation_sha256` fields match the files in the first attempt's `expectations/` directory. Verify that the three counterfactual files in `negative-controls/` match their `counterfactual_expectation_sha256` digests. Verify that tooling digests match the actual tooling files.

3. **Execution lock integrity.** Read `evidence/execution-lock.json`. Verify `oracle_precommit_sha256` matches the precommit. Verify coordinates, adapter identity, and dependency entry digests against the actual repositories at the pinned commits.

4. **Scenario comparisons.** For each of QLB-EXT-009 through 012:
   - Read `scenarios/<id>/comparison/comparison.json`
   - Verify `verdict: "agree"` and `classification: "product_agreement"`
   - Verify `binding.bound: true` and all binding checks pass
   - Verify that the comparison was produced by the frozen comparator against the first attempt's scenario evidence

5. **Determinism.** Read `determinism/<id>-determinism.json` for all four scenarios. Confirm `semantic_determinism: "CONFIRMED"` and zero unexplained differences. Verify that nondeterministic fields (precommit/lock digests) are the only differences.

6. **Negative controls.** Read all 15 results in `negative-controls/results/`. Verify:
   - 14 HELD, 1 FAILED (NC-12)
   - NC-12's failure is a scope limitation (comparator doesn't detect extra files; needs offline verifier)
   - NC-11's HELD is via `run_status_mismatch` not `forbidden_run_status_observed` (documented)
   - Each HELD control's precommitted outcome matches or is explained

7. **Evidence index.** Verify `evidence-index.json` covers all files. Recompute the sidecar SHA-256 from the index bytes and confirm it matches `evidence-index.sha256`.

8. **Tooling test result.** Verify that script digests in `tooling-test-result.json` match the actual scripts in the `tooling/` directory.

9. **Candidate defect register.** Read `candidate-defect-register.json`. Confirm CDF-001 accurately describes the NC-12 finding and does not affect the campaign verdict.

## What to report

- Whether the 4 scenario observations (all agree/product_agreement) are admissible
- Whether the determinism confirmation holds
- Whether the 14/15 negative control result is acceptable given NC-12's documented scope limitation
- Any discrepancies found in digest verification
- Whether the evidence tree is complete and internally consistent

## Constraints

- Zero Qualiber product-code change. Zero Reality Lab product-code change.
- The first attempt evidence is read-only. Never modify it.
- The completion run is confirmatory, not blind.
