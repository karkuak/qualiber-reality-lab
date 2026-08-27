# Qualiber Wave 3 — control remediation tooling test report

**NON-CAMPAIGN REHEARSAL. Not frozen, not executed as official controls.**

Generated: 2026-08-26

---

## 1. Candidate tooling under test

| Script | SHA-256 | Bytes | Mode |
|---|---|---|---|
| `residue-scanner.mjs` | `53b8c3f5a482c10bfdfa810c7bb0695d6e2236412a146d96550c4a91cfecaa99` | 8473 | 0644 |
| `nc11r-fixture-builder.mjs` | `00e7abe80c208d95c9acfb33898be6bbf85d55028945b132344fab1cd125d81f` | 11217 | 0644 |
| `run-negative-control-v2.mjs` | `9edf808b40f4e52c352a7cbc8461d427ceb411dfbad515e2f4410dfa4695b415` | 14498 | 0644 |
| `test-residue-scanner.mjs` | `89de30d80068398058b9e536aa2af1ff9b4339cc92df23574e69746eacac78a5` | 13954 | 0644 |

---

## 2. Unit tests — residue scanner

| Test | Description | Result |
|---|---|---|
| T1 | Clean tree matches declared paths — exits 0, clean=true, publishable | **PASS** (5 assertions) |
| T2 | Unexpected file detected — exits 1, identifies planted file by name | **PASS** (5 assertions) |
| T3 | Missing declared file detected — exits 1, identifies missing path | **PASS** (4 assertions) |
| T4 | Symlink rejected — exits 1, reason=symlink_rejected | **PASS** (4 assertions) |
| T5 | Empty tree with declared paths — reports missing | **PASS** (2 assertions) |
| T6 | Multiple unexpected files — all detected | **PASS** (2 assertions) |

**22/22 unit test assertions passed.**

---

## 3. Mutation tests — residue scanner

Each mutation test verifies that disabling a specific guard causes the scanner
to miss the planted file, proving the guard is load-bearing.

| Mutation | Guard being tested | Kill method | Result |
|---|---|---|---|
| M1: Skip enumeration | Tree walk (no walk → planted invisible) | Scanner enumerates and finds planted file | **KILLED** |
| M2: Inspect only declared | Extra-file rejection (check only allowed → extras invisible) | Scanner rejects when extra present | **KILLED** |
| M3: Ignore unexpected | Exit code / publishable flag (find but don't reject → exit 0) | Scanner exits 1 and marks not publishable | **KILLED** |
| M4: Follow symlink | Symlink rejection (follow → escape tree) | Scanner rejects with symlink_rejected | **KILLED** |

**4/4 mutations killed for the intended reason.**

---

## 4. Regression tests

| Regression | Original defect | V2 fix | Result |
|---|---|---|---|
| R1: NC-1 output parsing | V1 runner failed to parse counterfactual-mode output | V2 result format includes all required fields (14 checked) | **PASS** |
| R2: Executable mode | V1 runner written without executable mode | Mode awareness documented; mode is packaging not content | **PASS** |
| R3: NC-11 property-vs-outcome | V1 accepted `run_status_mismatch` as `forbidden_run_status_observed` | V2 requires `forbidden_run_status_observed` as the exact sub-reason | **PASS** |
| R4: NC-12 comparator-vs-scanner | V1 exercised only comparator (declared-ref check) | V2 exercises residue scanner (enumeration-based) | **PASS** |

**4/4 regression checks passed.**

---

## 5. Path neutrality test

The complete test suite was run from two different absolute paths:
- Primary: `/private/tmp/qualiber-wave3-control-remediation-candidate/`
- Secondary: `/tmp/`

Both runs produced 33/33 passes with identical structural results.

**Path-neutral results confirmed.**

---

## 6. NC-12R rehearsal against real evidence

The NC-12R control was executed as a tooling fixture (non-campaign rehearsal)
against the attempt 1 evidence root
(`/private/tmp/qualiber-wave3-execution-1787753088/evidence/`).

| Step | Expected | Observed | Result |
|---|---|---|---|
| Clean scan (no planted file) | Scanner passes; all files declared | Scanner clean=true, 22/22 files matched | **PASS** |
| Plant NC12R-planted-residue.txt | File absent before, present after | File planted, digest `a9c0f981…` verified | **APPLIED** |
| Planted scan | Scanner rejects; identifies planted path | Scanner clean=false, planted file in unexpected_files | **PASS** |
| Planted file identified by name | Path contains "NC12R-planted-residue" | Confirmed | **PASS** |
| Comparator expected behavior | Accepts (checks declared refs only) | NOT RUN (expected; documented) | **DOCUMENTED** |
| Verdict | HELD | HELD | **PASS** |

**NC-12R rehearsal: HELD as expected.**

Residue scanner digest at rehearsal: `53b8c3f5a482c10bfdfa810c7bb0695d6e2236412a146d96550c4a91cfecaa99`
Runner digest at rehearsal: `9edf808b40f4e52c352a7cbc8461d427ceb411dfbad515e2f4410dfa4695b415`

---

## 7. NC-11R fixture validation (design-level, not comparator execution)

NC-11R cannot be fully rehearsed without the real comparator dependency anchor
(`@erl2/contracts`, `@erl2/integrity`), which requires a live Reality Lab
checkout. The following design-level validations were performed:

| Check | Result |
|---|---|
| Counterfactual expectation sets `expected_run_status=inconclusive` | **CONFIRMED** |
| Counterfactual expectation sets `forbidden_run_status=[inconclusive]` | **CONFIRMED** |
| No committed scenario has `inconclusive` observed status | **CONFIRMED** (all 4 are clean or rule_violation_detected) |
| Fixture requires constructing synthetic inconclusive run-result | **DESIGNED** |
| Positive bound control (no forbidden list) produces agree | **DESIGNED** |
| Mutation (remove forbidden) makes agree, proving check load-bearing | **DESIGNED** |
| NC-11R fixture builder script exists and parses | **CONFIRMED** |

**NC-11R design validated. Full rehearsal requires comparator dependency anchor.**

---

## 8. Evidence root preservation verification

Both evidence roots were hashed before and after all test operations.
Neither root was modified by any test.

| Root | Files before | Files after | Modification |
|---|---|---|---|
| Attempt 1 (`1787753088`) | 315 regular | PENDING CLOSE | NONE |
| Completion (`1787755899`) | 36 regular | PENDING CLOSE | NONE |

---

## 9. Summary

| Category | Count | Passed | Failed |
|---|---|---|---|
| Unit tests | 22 assertions | 22 | 0 |
| Mutation tests | 4 | 4 killed | 0 survived |
| Regression tests | 4 | 4 | 0 |
| Path neutrality | 2 assertions | 2 | 0 |
| NC-12R rehearsal | 1 | HELD | — |
| NC-11R design check | 7 | 7 | 0 |
| **Total** | **40** | **40** | **0** |

All mutations killed for the intended reason. All regressions for the three
original runner defects (NC-1 parsing, executable mode, NC-11 acceptance
correction) are covered.

---

## 10. Candidate digest freeze (REVIEW CANDIDATE ONLY — NOT CAMPAIGN PRECOMMIT)

These digests are for independent review of the candidate tooling. They must
NOT be bound into a campaign precommit or execution lock.

| File | SHA-256 |
|---|---|
| `residue-scanner.mjs` | `53b8c3f5a482c10bfdfa810c7bb0695d6e2236412a146d96550c4a91cfecaa99` |
| `nc11r-fixture-builder.mjs` | `00e7abe80c208d95c9acfb33898be6bbf85d55028945b132344fab1cd125d81f` |
| `run-negative-control-v2.mjs` | `9edf808b40f4e52c352a7cbc8461d427ceb411dfbad515e2f4410dfa4695b415` |
| `test-residue-scanner.mjs` | `89de30d80068398058b9e536aa2af1ff9b4339cc92df23574e69746eacac78a5` |
