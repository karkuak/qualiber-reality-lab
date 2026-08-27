# Independent review prompt — Wave 3 control remediation candidate

**This review must occur before any control-set v2 precommit or execution.**

You are an independent reviewer. You have not participated in the design,
implementation, or testing of the candidate tooling. Your task is to verify
the remediation candidate's correctness, completeness, and binding integrity.

---

## Context

Wave 3's completion run (evidence root:
`/private/tmp/qualiber-wave3-completion-1787755899/evidence/`) identified
four defects in the negative-control and evidence-review chain:

1. `run-negative-control.mjs` was modified after the precommit bound its
   digest (precommit: `a8f0d1b6…`, executed: `951326f7…`), with no amendment.

2. NC-11 did not exercise forbidden-status precedence: the observed run
   status was `clean`, not `inconclusive`, so `forbidden_run_status_observed`
   never fired; `run_status_mismatch` fired instead.

3. NC-12 did not execute its precommitted method: only the comparator
   was exercised; the offline verifier and residue scanner were not run.

4. The independent review wrote its result inside the indexed evidence root,
   creating an unlisted file (`independent-review-result.json`).

A control remediation candidate has been produced. Your review covers:

---

## Review scope

### 1. Control-set v2 design

**Input:** `/private/tmp/qualiber-wave3-control-remediation-design.md`

Verify:
- The source-first control audit (Phase 2) correctly derives each control's
  intended property and gate from the approved design.
- The three post-freeze runner edits are correctly classified.
- The supersession mapping (NC-11 → NC-11R, NC-12 → NC-12R) is accurate.
- The thirteen retained controls are correctly identified as method-valid.
- The reclassifications (Phase 7) are supported by evidence and correctly
  assigned (not filed against Qualiber, correctly assessed for Lab audit queue).
- No original control is described as having proved a property it did not exercise.

### 2. Control-set v2 JSON

**Input:** `/private/tmp/qualiber-wave3-control-set-v2.json`

Verify:
- 15 active controls (13 retained + NC-11R + NC-12R).
- Supersession records accurately describe original control outcomes.
- NC-11R and NC-12R specifications match the design document.
- Runner digest discrepancy is honestly recorded.
- No sixteenth control is smuggled in.

### 3. NC-11R fixture and binding

**Input:** `/private/tmp/qualiber-wave3-control-remediation-candidate/tooling/nc11r-fixture-builder.mjs`

Verify:
- The fixture builder constructs a scenario where observed `run_status` is
  genuinely `inconclusive`.
- All four binding gates would pass after fixture construction:
  - `.frozen` sidecar updated with correct digest
  - `run-summary.json` `artifact_hashes` updated
  - Observation record `retained_output_refs` updated
  - Cross-identity bindings remain intact
- The counterfactual expectation correctly sets `expected_run_status=inconclusive`
  AND `forbidden_run_status=[inconclusive]`.
- The positive bound control (no forbidden list) would produce `agree`.
- The mutation (remove forbidden) would produce `agree`, proving the
  forbidden check is load-bearing.
- The fixture does NOT mutate a Wave 3 result if binding would fail first.
- No committed scenario has `inconclusive` observed status (confirming
  the fixture approach is necessary).

### 4. NC-12R residue scanner

**Input:** `/private/tmp/qualiber-wave3-control-remediation-candidate/tooling/residue-scanner.mjs`

Verify:
- The allowed path set is derived from `run-summary.json artifact_hashes`
  (authoritative retained-record/lock data), NOT scenario-specific literals.
- The scanner enumerates every regular file in the tree.
- Unexpected files (present but not allowed) are rejected.
- Missing declared files (allowed but not present) are rejected.
- Symlinks are rejected (not followed).
- Non-regular entries are rejected.
- Path traversal (`..`) is rejected.
- Duplicate normalized paths are rejected.
- The scanner reports exact unexpected and missing path sets.
- The comparator's declared-ref limitation is documented, not hidden.

### 5. V2 runner

**Input:** `/private/tmp/qualiber-wave3-control-remediation-candidate/tooling/run-negative-control-v2.mjs`

Verify:
- The runner handles NC-11R and NC-12R dispatch.
- No acceptance rule treats `run_status_mismatch` as satisfying
  `forbidden_run_status_observed`.
- Every mutation proof requires `original_digest !== current_digest`.
- Results include control-set version, method digest, fixture digests,
  evidence digests, expected/observed gates and classifications.
- Counterfactual mode remains digest-gated.
- No Qualiber import.
- No scenario-ID semantic branch.

### 6. Mutation coverage

**Input:** `/private/tmp/qualiber-wave3-control-remediation-candidate/tooling/tests/test-residue-scanner.mjs`

Verify the test suite covers:
- 4 mutation tests (skip-enumeration, inspect-only-declared, ignore-unexpected, follow-symlink).
- Each mutation is killed for its intended reason.
- Regression tests for the three original runner defects (NC-1 parsing,
  executable mode, NC-11 property-vs-outcome, NC-12 comparator-vs-scanner).
- Path-neutrality test (different absolute paths produce same results).

### 7. Exact digest/mode bindings

**Input:** `/private/tmp/qualiber-wave3-control-remediation-test-report.md`

Verify:
- Candidate digests in the test report match the actual file digests.
- Rehearsal digests match the candidate digests.
- No discrepancy between reported and actual values.

### 8. Proposed evidence layout

**Input:** `/private/tmp/qualiber-wave3-control-remediation-design.md` (Phase 6)

Verify:
- Evidence index excludes only itself and its sidecar (2 files exactly).
- Exact path-set equality is mandatory (no unlisted files, no missing indexed).
- Full SHA-256 verification (not spot-checked).
- Reviewer output placement: sibling of evidence directory, never inside.
- `evidence_complete` failure conditions are exhaustive.

---

## What to check (minimum)

1. Read all four tooling scripts byte-for-byte.
2. Independently compute SHA-256 of each script; compare against the
   test report's candidate digests.
3. Run the test suite independently: `node tooling/tests/test-residue-scanner.mjs`
4. Run the NC-12R rehearsal independently against the attempt 1 evidence root.
5. Verify the NC-11R fixture builder's binding-update logic against the
   observation record structure in the attempt 1 evidence.
6. Confirm no file in either evidence root was modified.

---

## What NOT to do

- Do not execute official negative controls.
- Do not freeze the candidate tooling into a campaign precommit.
- Do not modify either evidence root.
- Do not modify either repository.
- Do not write your review result inside any evidence root.
- Do not treat the 14/15 completion-run aggregate as a substitute for
  property-level review.

---

## Reviewer output

Write your review result as a sibling of the remediation working directory:
`/private/tmp/qualiber-wave3-control-remediation-independent-review-result.json`

Your result must include:
- Per-section pass/fail with specific findings
- Digest verification results
- Independent test run results
- Any defects found in the candidate tooling
- Final verdict: APPROVED / APPROVED WITH CAVEATS / REJECTED

---

## Immutable coordinates (for reference)

| Coordinate | Value |
|---|---|
| Qualiber commit | `236282a667fa161ee16fd363e33559cfe7871ba0` |
| Qualiber tree | `e40e5028ef172590ce482debf18e5d99f6099971` |
| Reality Lab commit | `02de870ef593c2cbd8c517792072769867f33e46` |
| Reality Lab tree | `16e20fff5f09535ccb0014c4346258f34ec94ef6` |
| Adapter dependency pin | `69ace16fb7ee021dddbcf3fa70e4295c2e5a400b` |
| Comparator | `83223022f1522f4c22607f02123e02a0c5ff9cf92363aba0ec1e8a256010bcc4` |
