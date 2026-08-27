# Qualiber Wave 3 — control remediation design

**Versioned remediation candidate, 2026-08-26. NOT FROZEN. NOT EXECUTED.**

This document designs a v2 control set that corrects four defects in the completion
run's negative-control and evidence-review chain. It does not alter either existing
campaign bundle, freeze a new campaign, execute the official control-closure run,
modify either repository, publish evidence, or write to GitHub.

Working directory: `/private/tmp/qualiber-wave3-control-remediation-1787760250`

---

## Phase 2 — source-first control audit

### 2.1 Original control property derivation

Each of the fifteen original controls was designed to exercise one load-bearing
property of the comparator, binding chain, or evidence-integrity surface. The
properties and their gates, re-derived from the approved design
(`qualiber-wave3-oracle-and-negative-control-design.md` §6):

| ID | Intended property | Comparator | Offline verifier | Residue scanner | Orchestration |
|---|---|---|---|---|---|
| NC-1 | Expected-outcome mutation disagrees | YES — semantic comparison | — | — | Counterfactual mode dispatch |
| NC-1b | Expectation-digest binding precedes comparison | YES — binding gate | — | — | — |
| NC-2 | Missing artifact never reads as status | YES — binding gate (unavailable) | — | — | — |
| NC-3 | Exit code not consulted for verdict | YES — recorded-not-asserted rule | — | — | Assertion over comparison.json |
| NC-4a | Product-artifact swap detected | YES — binding gate (retained_output_refs + artifact_hashes) | — | — | Two-scenario copy/swap |
| NC-4b | Whole-subtree swap detected | YES — binding gate (input digests + retained_output_refs) | — | — | Two-scenario copy/swap |
| NC-5 | Retained-input mutation refused | YES — binding gate | YES — verifyTrustedLocalObservationRecord | — | Pre-verify mutation applied |
| NC-6 | Product-artifact semantic mutation caught (sidecar not load-bearing) | YES — binding gate (retained_output_refs + artifact_hashes, NOT .frozen) | — | — | Sidecar refresh + pre-verify |
| NC-7 | Envelope semantic mutation with refreshed file hash caught | YES — four-step bind step (iv) identity | — | — | Sidecar refresh + pre-verify |
| NC-8 | Execution-lock mutation caught | YES — cross-identity gate | — | — | Lock mutation + pre-verify |
| NC-9 | Comparator dependency drift caught | YES — dependency digest check | — | — | Entry mutation + pre-verify |
| NC-10 | Finding-set discipline not vacuous | YES — semantic comparison | — | — | Counterfactual mode dispatch |
| NC-11 | Forbidden-status precedence beats matching expectation | YES — §10.5 rule 6 | — | — | Counterfactual mode dispatch |
| NC-12 | Planted residue makes evidence unpublishable | — (comparator checks declared refs only) | YES — retained-tree digests | YES — independent residue scan | Copy + plant + pre-verify |
| NC-13 | Oracle leakage detection | — | — | — | Scanner invocation + false-positive check |

### 2.2 Responsibility partitioning

The design (§6) assigned NC-12 to three distinct surfaces:

1. **Comparator:** checks declared `retained_output_refs` digests. By design,
   it does not enumerate undeclared files. An extra file in `product-out/` is
   invisible to this check.

2. **Offline verifier (product code):** computes retained-tree digests and
   compares against the observation record's declared refs. This was the
   primary detection mechanism for undeclared files.

3. **Independent residue scanner:** enumeration-based scan of the retained
   workspace tree against the declared path set. This was the secondary
   detection mechanism.

The completion runner exercised ONLY the comparator (surface 1). Surfaces 2
and 3 were not available to the completion runner: the offline verifier is
product code, and no independent residue scanner was implemented.

### 2.3 Why the runner required three post-freeze edits

The oracle precommit bound `run_negative_control_mjs` to digest
`a8f0d1b690a73299d5c639ea04f558150235b04efa0c531088f81ee78d735cb5`.
The executed script has digest
`951326f76e438d7c7e4abea10d11ec147d9af660cc1ebe2a7f2aa259d074215c`.
No amendment was recorded. The three edits:

#### Edit 1: NC-1 output parsing

- **Classification:** runner defect.
- **Nature:** the runner failed to parse the comparator's structured JSON
  output correctly for counterfactual-mode controls (NC-1, NC-10, NC-11).
  The parser expected a different output shape than what the comparator
  actually produced.
- **Evidence:** the runner's first execution of NC-1 failed with a parsing
  error, was edited to fix the parser, and re-run successfully. The edit
  corrected the runner to match the comparator's actual output contract.

#### Edit 2: Executable mode/chmod correction

- **Classification:** packaging defect.
- **Nature:** the runner script was written without executable mode (`0644`
  instead of `0755`). Node.js can still execute it via `node run-negative-control.mjs`,
  but the design's command invocations used `./run-negative-control.mjs`,
  requiring executable permission. The chmod was applied after the precommit
  bound the file's content digest.
- **Note:** chmod does not alter file content or its SHA-256. However, the
  mode was not recorded in the precommit, so the packaging defect was not
  surfaced by the digest-binding constraint.

#### Edit 3: NC-11 acceptance correction

- **Classification:** incorrect expected result / attempt to accept a different code path.
- **Nature:** the original runner expected NC-11's sub-reason to be
  `forbidden_run_status_observed`. When the comparator returned
  `run_status_mismatch` instead (because the observed status was `clean`,
  not `inconclusive`), the runner was edited to accept `run_status_mismatch`
  as satisfying NC-11's property.
- **Problem:** this is the most consequential edit. NC-11's stated property
  is "forbidden-status precedence beats a matching expectation." Accepting
  `run_status_mismatch` as satisfying this property conflates two distinct
  mechanisms: (a) forbidden-status precedence (rule 6), and (b) ordinary
  expected-status inequality. The observed code path was (b), not (a). The
  runner was edited to accept a different code path than the one the control
  was designed to exercise, then reported the control as HELD.

### 2.4 Edit classification summary

| Edit | Classification | Content change | Digest change |
|---|---|---|---|
| NC-1 parsing | Runner defect (output parser wrong) | YES | YES |
| chmod | Packaging defect (mode, not content) | NO | NO |
| NC-11 acceptance | Incorrect expected result / code-path substitution | YES | YES |

The combined effect of edits 1 and 3 changed the file content, producing the
observed digest mismatch (`a8f0d1b6…` → `951326f7…`). No amendment was recorded
in the precommit, violating the amendment protocol (design §1.3).

### 2.5 Aggregate success is not property-level correctness

14/15 controls HELD. But:

- NC-11 HELD via `run_status_mismatch`, not via `forbidden_run_status_observed`.
  The intended precedence property was never exercised.
- NC-12 FAILED because the comparator (the only surface exercised) does not
  enumerate undeclared files.
- The runner was modified after precommit without amendment.

Reporting 14/15 as "the controls held" obscures that two distinct properties
were not tested through their intended mechanisms.

---

## Phase 3 — control set v2 design

### 3.1 Active control set

The v2 control set contains fifteen active controls:

- **Thirteen original controls whose methods remain valid:**
  NC-1, NC-1b, NC-2, NC-3, NC-4a, NC-4b, NC-5, NC-6, NC-7, NC-8, NC-9, NC-10, NC-13.

- **NC-11R** replacing NC-11 (remediation).
- **NC-12R** replacing NC-12 (remediation).

### 3.2 Supersession mapping

| Original | Status | Superseded by | Reason |
|---|---|---|---|
| NC-11 | Did not exercise intended gate | NC-11R | Observed status was `clean`, not `inconclusive`; `forbidden_run_status_observed` never fired; `run_status_mismatch` satisfied a different property than forbidden-status precedence |
| NC-12 | Did not execute precommitted method | NC-12R | Only comparator (declared-ref check) was exercised; offline verifier and residue scanner were not executed; CDF-001 therefore reclassified as orchestration/method-execution defect |

### 3.3 Historical record

Original NC-11 remains recorded as:
- Verdict: HELD (disagree/product_disagreement)
- Sub-reason: `run_status_mismatch` (NOT `forbidden_run_status_observed`)
- Assessment: the control proved that a counterfactual expectation with
  `expected_run_status=inconclusive` against an observed `clean` status
  produces `disagree`. It did NOT prove that forbidden-status precedence
  (rule 6) fires when the observed status matches a forbidden value AND
  the expected status simultaneously matches.

Original NC-12 remains recorded as:
- Verdict: FAILED
- Classification: `product_agreement` (comparator accepted the planted residue)
- Assessment: the comparator correctly checked only declared references. The
  planted file was invisible to `retained_output_refs` checks. The control's
  stated property required surfaces (offline verifier, residue scanner) that
  were not exercised by the completion runner.

Neither original control is described as having proved its stated property.

### 3.4 NC-11R design

**Purpose:** prove forbidden-status precedence using an actually observed
forbidden status.

**Required scenario state:** the observed `run_status` must be genuinely
`inconclusive`, so that:
- `inconclusive` is in `forbidden_run_status` → forbidden check fires
- `expected_run_status` is also `inconclusive` → expected-status equality
  would otherwise pass
- The control proves that the forbidden check forces `disagree` EVEN THOUGH
  expected == observed for run_status

**Fixture construction:**

No committed Wave 3 scenario has `inconclusive` observed run status. QLB-EXT-004
(Wave 1) was investigated: its observed status is `clean` with
`product_agreement/agree`. No committed scenario across Waves 1–3 has an
`inconclusive` observed run status. Therefore, a contract-valid, completely
bound control fixture must be constructed.

The NC-11R fixture is a synthetic scenario tree that:

1. Starts from a disposable copy of QLB-EXT-012's completed scenario data
   (which has the closest expected semantics — `clean` with `partial` health).

2. Constructs a modified `run-result.json` with `runStatus: "inconclusive"`
   and `inconclusiveReason: "nc11r_fixture_synthetic_inconclusive"`.

3. Updates all binding layers to be internally consistent:
   - `.frozen` sidecar for the modified `run-result.json`
   - `run-summary.json` artifact_hashes for the modified file
   - Observation record `retained_output_refs` for the modified digest
   - The fixture's own expectation file

4. The counterfactual expectation sets:
   - `expected_run_status: "inconclusive"`
   - `forbidden_run_status: ["inconclusive"]`

5. With binding intact, the comparator reaches semantic comparison and:
   - Checks forbidden_run_status: observed `inconclusive` IS in
     `["inconclusive"]` → rule 6 forces `disagree`
   - Would also check expected_run_status: `inconclusive` == `inconclusive`
     → would normally pass, but rule 6 has already forced disagree

6. Required output:
   - `verdict: "disagree"`
   - `classification: "product_disagreement"`
   - Sub-reasons MUST include `forbidden_run_status_observed`
   - The ordinary expected-status equality must NOT mask or replace the
     forbidden-status reason

7. Mutation that removes forbidden-status precedence:
   - Remove `inconclusive` from `forbidden_run_status` (set to `[]`)
   - Re-run: now expected == observed for run_status → `agree`
   - This proves the forbidden check was load-bearing

8. Positive bound control:
   - Run the fixture with an expectation that has
     `expected_run_status: "inconclusive"` and NO forbidden_run_status
   - Result: `agree` (expected matches observed, no forbidden check)
   - This proves the fixture itself is admissible (binding passes,
     semantics are reachable)

**Binding integrity requirements:**

The fixture must pass all four binding gates (design §3):
- Gate 1 (retained_output_refs): fixture's observation record must declare
  the modified `run-result.json` digest
- Gate 2 (artifact_hashes): fixture's `run-summary.json` must declare the
  modified file's digest
- Gate 3 (cross-identity): observation_id, plan_hash, adapter_artifact_hash,
  input digests must chain correctly
- Gate 4 (response envelope): not applicable (no error code expected)

The fixture construction must be independently reviewable: every binding
modification is recorded with before/after digests.

### 3.5 NC-12R design

**Purpose:** prove an undeclared planted residue file makes the evidence
unpublishable through the explicitly assigned residue-integrity surface.

**Method:**

1. Start from a disposable copy of a valid completed scenario (QLB-EXT-009).

2. Run a clean positive control first:
   - The residue scanner passes (all files are declared, none unexpected)
   - The offline verifier (if available) passes
   - The comparator passes

3. Plant one undeclared file (`NC12R-planted-residue.txt`) inside the retained
   workspace/output tree (`run-output/product-out/`).

4. Record and prove:
   - Complete tree/path-set BEFORE planting
   - Target path absence BEFORE planting
   - Planted file digest
   - Complete tree/path-set AFTER planting

5. Run three surfaces separately:
   a. **The shipped offline verifier** — if available and exercisable
      without Qualiber imports, run it. Record its typed reason if it refuses.
      If it accepts (expected, since it checks declared refs), record that.
   b. **Task-local independent residue scanner** — the primary NC-12R surface.
      This is a new tool purpose-built for this control.
   c. **The comparator** — run separately. Expected: `agree` (the comparator
      checks only declared refs and does not enumerate undeclared files).
      Record honestly that the comparator accepts.

6. The residue scanner MUST:
   - Derive its allowed path set from authoritative retained-record/lock data
     (the observation record's `retained_output_refs` declared paths), NOT
     from scenario-specific literals
   - Enumerate every regular file in the retained workspace tree
   - Reject unexpected files (files present but not in the allowed set)
   - Reject missing declared files (files in the allowed set but not present)
   - Reject symlinks and non-regular entries
   - Reject path traversal (`..`) and duplicate normalized paths
   - Report exact unexpected and missing path sets

7. Precommitted result:
   - Clean copy: scanner passes, comparator passes → publishable
   - Planted copy: scanner rejects (unexpected file detected),
     comparator accepts → NOT publishable
   - Classification: `lab_harness_failure`
   - The scanner MUST identify the planted path by name

8. If the shipped offline verifier also refuses, record its typed reason.
   If the verifier accepts but the scanner refuses, state that division
   honestly — the scanner caught what the verifier missed, which is the
   reason the scanner exists.

9. Mutations (each must be proven applied before execution):
   a. **Skip enumeration:** scanner does not walk the tree, only checks
      declared files exist → planted file invisible → test MUST fail
   b. **Inspect only declared refs:** scanner checks only files in the
      allowed set, does not reject extras → planted file invisible → MUST fail
   c. **Ignore unexpected paths:** scanner enumerates but does not reject
      unexpected files → planted file found but not rejected → MUST fail
   d. **Follow a symlink:** scanner follows symlinks instead of rejecting
      them → planted symlink could point outside the tree → MUST fail

---

## Phase 6 — evidence-index and review protocol design

### 6.1 Evidence index rules for the next control-closure run

1. The evidence index (`evidence-index.json`) MUST list every regular file
   in the evidence directory EXCEPT exactly two files:
   - `evidence-index.json` itself
   - `evidence-index.sha256` (its sidecar)

2. **Exact path-set equality is mandatory.** The set of files physically
   present in the evidence directory (minus the two exclusions) MUST equal
   exactly the set of paths in the evidence index. No unlisted files. No
   missing indexed files.

3. Every indexed file MUST have its SHA-256 and byte length verified by the
   indexer — not spot-checked, not sampled. The indexer computes the digest
   by reading the file; it does not trust any previously recorded value.

4. The evidence-index sidecar (`evidence-index.sha256`) contains ONLY the
   SHA-256 of `evidence-index.json`, computed after the index is finalized.

### 6.2 Reviewer output placement

1. The independent reviewer's output MUST be a **sibling** of the evidence
   directory, NEVER inside it. Example:
   - Evidence: `evidence/`
   - Review: `independent-review-result.json` (sibling of `evidence/`)

2. Writing any file inside the evidence directory after the index is built
   is a failure condition that voids the index's path-set integrity.

### 6.3 Independent reviewer protocol

The independent reviewer MUST:

1. **Capture the source evidence manifest before review:**
   enumerate and hash every regular file in the evidence directory.

2. **Work on copies for any mutation testing:**
   never modify any file inside the evidence directory.

3. **Re-run the manifest after review:**
   re-enumerate and re-hash every regular file in the evidence directory.

4. **Require an empty diff:**
   the before and after manifests must be byte-identical. Any difference
   is a failure — the review process modified the evidence.

5. **Verify path-set equality:**
   confirm the evidence-index's path set equals the actual file set
   (minus the two declared exclusions). Any unlisted file is a failure.

6. **Full digest verification:**
   verify every indexed file's SHA-256 and byte length, not a spot check.

### 6.4 Failure conditions for `evidence_complete`

`evidence_complete` CANNOT be `true` if:

- Any control failed (verdict != HELD)
- Any tooling digest differs from the precommit without a recorded amendment
- Any predicted property was not exercised (sub-reason differs from precommit)
- Any unlisted file exists in the evidence root
- Any indexed file is missing or has a digest mismatch
- The reviewer output was written inside the evidence root

---

## Phase 7 — reclassification of findings

### 7.1 Post-freeze runner edits

**Classification:** control-chronology / tooling-integrity defect.

The runner was modified after the precommit bound its digest. The precommit's
`amendments[]` is empty, so the modification was not formally recorded. This
violates the amendment protocol (design §1.3) and breaks the digest chain
for the negative-control orchestration tooling. The tooling-test-result
honestly records the actual digest (`951326f7…`), which creates an internal
inconsistency: the precommit says one thing, the tooling-test-result says
another, and no amendment bridges them.

**Not filed against Qualiber.** This is a campaign-tooling defect in the
control-orchestration layer.

**Reality Lab audit queue consideration:** this is an orchestration-process
defect, not a Lab code defect. It belongs in the campaign's own defect
register, not the Lab audit queue. The defect is that the amendment protocol
was not followed, not that any Lab code is wrong.

### 7.2 NC-11

**Classification:** control-design defect; intended precedence untested.

The original NC-11 was designed to prove forbidden-status precedence
(design §6 rule 6: "forbidden_run_status, when matched, forces disagree
REGARDLESS of any other comparison"). The counterfactual set
`expected_run_status=inconclusive` against QLB-EXT-012's observed `clean`
status. Since `clean` ≠ `inconclusive`, the forbidden-status check could
not fire (the observed status was not in the forbidden list). Instead,
`run_status_mismatch` fired — a different mechanism that proves ordinary
expected-status inequality, not forbidden-status precedence.

The control HELD for the correct verdict (`disagree/product_disagreement`)
but via a different code path than the one it was designed to exercise.
The runner was then edited to accept `run_status_mismatch` as satisfying
the forbidden-status precedence property, compounding the defect.

**Not filed against Qualiber.** The comparator's forbidden-status logic is
not shown to be wrong — it was never reached. The defect is in the control
design (wrong scenario choice for the intended property) and the runner's
acceptance criteria.

**Reality Lab audit queue consideration:** not a Lab code defect. The Lab's
comparator implements rule 6 correctly (as verified by the producer test
suite and adversarial tests). The defect is that the campaign's negative
control did not create conditions under which rule 6 would fire.

### 7.3 NC-12

**Classification:** orchestration / method-execution defect.

The design (§6) assigned NC-12 to three surfaces: comparator, offline
verifier, and independent residue scanner. The completion runner exercised
only the comparator, which by design checks only declared retained_output_refs
and does not enumerate undeclared files. The planted residue was invisible
to this check, and the comparator correctly returned `agree`.

CDF-001 in the candidate defect register describes this as "a scope limitation
of the campaign's comparator tooling vs the full offline verification pipeline"
and marks `affects_verdict: false`. This characterization is reclassified:

- **CDF-001 is a completion-harness / control-method defect**, not merely
  a scope limitation. The design required three surfaces; only one was
  exercised. The control's stated property ("planted residue makes evidence
  unpublishable") was not tested.

- The reclassification holds unless source evidence proves a separate Lab
  defect prevented the offline verifier or residue scanner from being
  exercised. No such evidence is present in the completion evidence root.

**Not filed against Qualiber.** The comparator behaves correctly within its
documented scope. The defect is that the control's method was not fully
executed.

**Reality Lab audit queue consideration:** this MAY belong in the Lab audit
queue IF the offline verifier's absence from the completion runner is caused
by a Lab code issue (e.g., the verifier requires Lab infrastructure not
available in the campaign context). However, the residue scanner is a
campaign-level tool that should have been implemented as part of the
negative-control tooling, making this primarily an orchestration defect.

### 7.4 Independent review

**Classification:** incomplete index / path-set validation and source-tree
mutation.

Two defects:

1. **Unlisted file:** the independent review wrote `independent-review-result.json`
   inside the indexed evidence root (`evidence/`). This file is not in
   `evidence-index.json`. Exact path-set equality now fails: 36 files on
   disk vs 33 indexed + 2 exclusions = 35 expected.

2. **Incomplete path-set validation:** the review checked indexed-file
   existence (all 33 present) and spot-checked 12 digests, but did not
   verify exact path-set equality. It did not detect that the evidence root
   contained a file not in the index. The review's own output was the
   unlisted file, creating a self-referential integrity violation.

**Not filed against Qualiber.** These are review-process defects.

**Reality Lab audit queue consideration:** not a Lab defect. These are
campaign-review-protocol defects that the v2 evidence-index and review
protocol (Phase 6) corrects.

---

## Immutable coordinates

All coordinates are carried forward unchanged from the completion run:

| Coordinate | Value |
|---|---|
| Qualiber commit | `236282a667fa161ee16fd363e33559cfe7871ba0` |
| Qualiber tree | `e40e5028ef172590ce482debf18e5d99f6099971` |
| Reality Lab commit | `02de870ef593c2cbd8c517792072769867f33e46` |
| Reality Lab tree | `16e20fff5f09535ccb0014c4346258f34ec94ef6` |
| Adapter dependency pin | `69ace16fb7ee021dddbcf3fa70e4295c2e5a400b` |
| Comparator | `83223022f1522f4c22607f02123e02a0c5ff9cf92363aba0ec1e8a256010bcc4` |

---

## Status

**CONTROL REMEDIATION CANDIDATE — NOT FROZEN — AWAITING INDEPENDENT REVIEW**

---

# Addendum — IRD-001 resolution (control-set v2, NC-11R complete binding)

This addendum supersedes the NC-11R fixture-construction guidance above wherever
they conflict. See `IRD-001-DISPOSITION.md` for the full trace.

## A. Real comparator binding path

The comparator's primary artifact binding is
`record.operation_records[]` where `operation==="interact" && state==="completed"`
→ `retained_output_refs` (`findInteractCompletedRecord`, then `bindArtifact`
against logical paths relative to `run-output/store`). It **does not** read
top-level `record.result.retained_output_refs`. For QLB-EXT-012 the operation
record carries 11 populated refs (run-result.json included); the empty top-level
array flagged by IRD-001 is cosmetic and is not a binding target.

## B. NC-11R fixture — layers bound (each exactly once, fail-closed)

1. `run-result.json` → `runStatus: inconclusive` (+ synthetic `inconclusiveReason`).
2. `operation_records[interact/completed].retained_output_refs[run-result].file_sha256` — PRIMARY.
3. `run-summary.json artifact_hashes[…/run-result.json]` — SECONDARY (`adapter_artifact_hashes_matched`).
4. `operation_records[…].retained_output_refs[run-summary].file_sha256` — cascade (run-summary bytes changed).
5. `run-result.json.frozen` sidecar — weak local check.
6. `run-summary.json.frozen` — explicitly **inapplicable** (comparator walks only product-out sidecars).
7. top-level `result.retained_output_refs` — **not read**, left untouched.

The builder emits a self-consistent fixture oracle (`oracle-precommit.json`,
`campaign-index.json`, copied `execution-lock.json`, three expectations) so the
fixture runs end-to-end through the real comparator. It is labelled
NON-CAMPAIGN and carries no precommit or execution lock into the campaign.

## C. Active control set v2 (unchanged, 15 controls)

NC-1, NC-1b, NC-2, NC-3, NC-4a, NC-4b, NC-5, NC-6, NC-7, NC-8, NC-9, NC-10,
NC-13, NC-11R, NC-12R. Original NC-11 and NC-12 remain superseded, not active.

## D. Proven properties

Positive fixture agrees; NC-11R yields `forbidden_run_status_observed` /
`disagree` / `product_disagreement` with `bound=true`; ordinary
`run_status_mismatch` does not satisfy NC-11R; disabling rule 6 turns the
property red. All via the pinned real comparator (`83223022…`) and real fixture
bytes, path-neutral across two scratch roots. See `tooling-test-result.json`
(51/51) and `ird001-binding-coverage.json`.
