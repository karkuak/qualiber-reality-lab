# Qualiber Reality Lab Wave 3 — Campaign Execution Report

**Date:** 2026-08-26
**Status:** COMPLETE — 4 agreements, 0 disagreements, 0 quarantined
**Authorization:** Owner-authorized 2026-08-26T13:50:00Z
**Evidence root:** `/private/tmp/qualiber-wave3-execution-1787753088/evidence/`
**Publication:** NOT PUBLISHED. Awaiting independent evidence review.

---

## Verdict

**QUALIBER WAVE 3 CAMPAIGN COMPLETE — 4 agreements, 0 disagreements, 0 quarantined; AWAITING INDEPENDENT EVIDENCE REVIEW**

---

## 1. Immutable coordinates

| Coordinate | Value |
|---|---|
| Qualiber commit | `236282a667fa161ee16fd363e33559cfe7871ba0` |
| Qualiber tree | `e40e5028ef172590ce482debf18e5d99f6099971` |
| Reality Lab commit | `02de870ef593c2cbd8c517792072769867f33e46` |
| Reality Lab tree | `16e20fff5f09535ccb0014c4346258f34ec94ef6` |
| Adapter dependency pin | `69ace16fb7ee021dddbcf3fa70e4295c2e5a400b` |

Both remote tips confirmed at designated positions at freeze time. Execution used detached
checkouts at the exact commits, never a branch name.

---

## 2. Scenario results

| ID | Short name | Verdict | Classification | runStatus | collectorHealth | Findings | Target event |
|---|---|---|---|---|---|---|---|
| QLB-EXT-009 | occurrence bound at equality | **agree** | product_agreement | `clean` | `healthy` | 0 | — |
| QLB-EXT-010 | ambiguous valid subsequence | **agree** | product_agreement | `rule_violation_detected` | `healthy` | 1 `duplicate_event` | `quote_requested_three` |
| QLB-EXT-011 | clean with an info finding | **agree** | product_agreement | `clean` | `healthy` | 1 `forbidden_event_observed` | `quote_requested_cancel` |
| QLB-EXT-012 | partial capture judged | **agree** | product_agreement | `clean` | `partial` | 0 | — |

### What each scenario proved

- **QLB-EXT-009**: The occurrence check uses strict `>` (not `>=`). Two observations against max=2
  produced zero findings and `clean`. Paired with Wave 2's QLB-EXT-006 (same stimulus, max=1,
  one finding), this isolates the comparison operator at the equality boundary.

- **QLB-EXT-010**: Ordering uses existence semantics. Stimulus `[three, one, three, zero]`
  produced only `duplicate_event` on `quote_requested_three` — no spurious `wrong_order`. This
  is the first scenario where two contract constructs are simultaneously in play on the same
  event and the expected answer is "exactly one fires."

- **QLB-EXT-011**: An info-severity `forbidden_event_observed` was emitted and recorded in
  `report.json` while `runStatus` correctly rolled up to `clean`. First scenario where `clean`
  and a non-empty finding set coexist, and the first to exercise a contract-supplied severity.
  Seventh finding type in the programme.

- **QLB-EXT-012**: A request with no resolvable `event` field produced `collectorHealth: partial`.
  The three recognized events satisfied C-VALID, yielding `clean` with zero findings. `partial`
  is correctly excluded from `UNHEALTHY`. First scenario with a mixed capture.

---

## 3. Cumulative programme status (Waves 1–3)

| ID | Wave | Verdict | runStatus | Key property |
|---|---|---|---|---|
| QLB-EXT-001 | 1 | agree | clean | baseline: 3 events, no findings |
| QLB-EXT-002 | 1 | agree | rule_violation_detected | missing_required_event |
| QLB-EXT-003 | 1 | agree | rule_violation_detected | wrong_order |
| QLB-EXT-004 | 1 | agree | inconclusive | degraded / collector_unhealthy |
| QLB-EXT-005 | 1 | agree | not_run | config_invalid (refusal) |
| QLB-EXT-006 | 2 | agree | rule_violation_detected | duplicate_event (max+1) |
| QLB-EXT-007 | 2 | agree | rule_violation_detected | missing_required_property |
| QLB-EXT-008 | 2 | agree | rule_violation_detected | property_type_mismatch |
| QLB-EXT-009 | 3 | agree | clean | occurrence bound at equality |
| QLB-EXT-010 | 3 | agree | rule_violation_detected | existence-based ordering |
| QLB-EXT-011 | 3 | agree | clean | info finding + clean coexistence |
| QLB-EXT-012 | 3 | agree | clean | partial capture judged |

**Twelve of twelve agreed across three waves. Zero product disagreements.**

Finding types exercised: 7 of 11 (`missing_required_event`, `wrong_order`, `duplicate_event`,
`missing_required_property`, `property_type_mismatch`, `no_telemetry_observed`,
`forbidden_event_observed`). Four remain uncovered: `timing_violation` (infeasible through
honest surface), `forbidden_event_unprovable`, `inconsistent_property_value`,
`consistency_group_unprovable` (deferred to Wave 4).

---

## 4. Integrity

### Oracle-absence scanning
- **Pre-execution**: 13 files, 30 needles, 0 hits — CLEAN
- **Per-scenario (3 scans each × 4 scenarios = 12 scans)**: all CLEAN, 40 needles each, 0 hits

### Binding
- All four scenarios' binding gates passed (bytes → shape → recompute → identity)
- All comparator dependency resolutions matched execution-lock pins
- Every sealed plan's core hash equals its retained record's plan hash (no plan drift)

### Comparator
- G1 (`expected_collector_health`) asserted correctly on all four scenarios
- G2 (generic `target_event_mismatch` token) — no scenario-specific literal in comparator
- Dependencies resolved through explicit `--dependency-anchor`, not a global lookup

### No mutation
- Both detached worktrees: 0 dirty files at close
- Persistent checkouts were not entered
- No branch created, no push, no PR, no GitHub mutation
- No evidence published

---

## 5. Tooling identity

| Artifact | SHA-256 |
|---|---|
| `compare-scenario.mjs` | `83223022f1522f4c22607f02123e02a0c5ff9cf92363aba0ec1e8a256010bcc4` |
| `compare-scenario.test.mjs` | `c92de1f3b37f39a3292903cd39084c23f59c592400197bb76778628514e562b4` |
| `oracle-absence-scan.mjs` | `5a2f48445aee2aa76b7621c661cd24d8f343bc1f632478099cf85f8a5322d631` |
| `@erl2/contracts` entry | `da45bec05eada150c6006c64cf51a41f7bcfa233eb1d299b8adb341adb9dc00c` |
| `@erl2/integrity` entry | `c927d02cb33fa1c8f0a08a78fedcfe8137d0954180ed07ceaa8f2e1112feff13` |

---

## 6. Adapter identity

| Field | Value |
|---|---|
| Adapter ID | `qualiber-erl2-validation-subject` |
| Artifact SHA-256 | `c65c6393af5e6d83f937c3d0d7f274101e915922494d8fcec26f8865fe05e762` |
| Artifact bytes | 41472 |
| Manifest SHA-256 | `91e830d253e23194ecb9bbd0a206c20699b610333821c25074a6dc6345c9e85a` |
| Manifest core hash | `504ab99b85804ad900bc56fac89d3e64da5295a772dfaef1be4848eef9b5b393` |
| Topology | package-local-tarball |
| Determinism | byte-identical rebuild confirmed at designation |

---

## 7. Evidence tree

313 files across the evidence directory:

- `oracle-precommit.json` — stage 1 precommit with all four scenario digest bindings
- `execution-lock.json` — stage 2 lock with coordinates, adapter, tooling, and dependency pins
- `campaign-index.json` — observation IDs and plan hashes for all four scenarios
- `oracle-absence-scan-result.json` — pre-execution scanner result
- `wave3-scenario-execution-log.md` — detailed per-scenario execution log
- `scenarios/QLB-EXT-{009..012}/` — per-scenario evidence trees (76 files each):
  - `input/` — contract.json and stimulus.json (retained copies)
  - `declaration/` — trusted-local-declaration.json
  - `plan/` — plan-draft, sealed plan, seal log
  - `run-output/` — complete run output tree (inputs, registry, store, workspace)
  - `comparison/` — comparator output (comparison.json)
  - `scans/` — 3 scanner results per scenario

---

## 8. Stop conditions — none triggered

| # | Condition | Result |
|---|---|---|
| 1 | Oracle-absence scan hit | **NOT TRIGGERED** — 13 of 13 scans clean |
| 2 | Binding gate failure | **NOT TRIGGERED** — all 4 scenarios bound |
| 3 | Comparator dependency mismatch | **NOT TRIGGERED** — all pins matched |
| 4 | Expectation amended after run | **NOT TRIGGERED** — all agreed on first attempt |
| 5 | Pin mismatch | **NOT TRIGGERED** — all coordinates confirmed |

---

## 9. What this campaign does NOT establish

This campaign does **not** establish: certification; independent assurance; confinement or
sandboxing; scoring or authentication; governor authorization; production readiness;
reproducibility from a clean checkout; complete executable-dependency closure; or correctness
of Qualiber outside the four scenarios tested here. Wave 3 is **first-party dogfood** against
**subject zero**, run **trusted-local**, **unconfined**, over **synthetic** stimuli; it is not
certification, not adoption evidence, and not a T3 or T4 claim. Twelve scenarios agreeing
across Waves 1–3 is a bounded observation over twelve synthetic captures against one
Lab-authored journey contract; it is not evidence about any customer journey, any other
contract shape, or any of the four finding types the programme has still never exercised.

---

## 10. Next steps

1. **Independent evidence review** of this campaign's 313-file evidence tree.
2. If review passes: publication as `docs/evidence/qualiber-product-scenarios-wave3-20260826/`
   in `karkuak/qualiber-reality-lab`, with no Lab product code change.
3. Negative controls (NC-1 through NC-13 and Wave 3 additions) — to be executed as a separate
   campaign step if required by the evidence reviewer.
4. Determinism check (QLB-EXT-009 re-run) — to be executed if required.

---

**QUALIBER WAVE 3 CAMPAIGN COMPLETE — 4 agreements, 0 disagreements, 0 quarantined; AWAITING INDEPENDENT EVIDENCE REVIEW**
