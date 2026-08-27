# Qualiber Reality Lab Wave 3 — Scenario Execution Log

Campaign: `qualiber-product-scenarios-wave3-20260826`
Executed: 2026-08-26
Executor: Claude Code agent, owner-authorized

## Coordinates

| Repository | Commit | Tree |
|---|---|---|
| Qualiber (detached) | `236282a667fa161ee16fd363e33559cfe7871ba0` | `e40e5028ef172590ce482debf18e5d99f6099971` |
| Reality Lab (detached) | `02de870ef593c2cbd8c517792072769867f33e46` | `16e20fff5f09535ccb0014c4346258f34ec94ef6` |
| Adapter dependency pin | `69ace16fb7ee021dddbcf3fa70e4295c2e5a400b` | — |

## Adapter Identity

- Adapter ID: `qualiber-erl2-validation-subject`
- Artifact SHA256: `c65c6393af5e6d83f937c3d0d7f274101e915922494d8fcec26f8865fe05e762` (41472 bytes)
- Manifest SHA256: `91e830d253e23194ecb9bbd0a206c20699b610333821c25074a6dc6345c9e85a`
- Manifest core hash: `504ab99b85804ad900bc56fac89d3e64da5295a772dfaef1be4848eef9b5b393`

## Tooling Identity

- compare-scenario.mjs SHA256: `83223022f1522f4c22607f02123e02a0c5ff9cf92363aba0ec1e8a256010bcc4`
- oracle-absence-scan.mjs SHA256: `5a2f48445aee2aa76b7621c661cd24d8f343bc1f632478099cf85f8a5322d631`
- Comparator dependencies: @erl2/contracts 0.1.0 (entry `da45bec0...`), @erl2/integrity 0.1.0 (entry `c927d02c...`)

---

## QLB-EXT-009 — occurrence upper bound at equality

**Purpose:** Prove the cardinality ceiling is strict `>` (not `>=`) at the equality boundary.

### Inputs
- Stimulus: Wave 2 stimulus-006 reused verbatim
  - SHA256: `fef741e0984dbd52b445386e6c6ef22a6493614c5c6e2cd9bf49ae7ffe2b2073` (994 bytes)
- Contract: C-BOUND2 (max=2 on quote_requested_one)
  - SHA256: `2666c8539fc4c1e4eb40d35528e15e4e32bcdab932f629ab7ddea41b59ea776d` (1180 bytes)
- Expectation: SHA256 `7bb957fe1d0eb9603da7c6731e81ec2847f17899896778b85f484857c3969b70` (464 bytes)

### Pipeline
- Observation ID: `01a03e6f-6d64-7b3e-8160-04c21596611e`
- Declaration core hash: `sha256:3d731bf13823d9745c38682a05c20d07969d42087c2e8a8122a8101c419babce`
- Sealed plan core hash: `sha256:a010671f1cdd7382e044ad889498f7904382db04d5e68a008572b23f18278e7a`

### Scanner Results (all CLEAN, 40 needles, 0 hits)
- Scan 1 (mounted inputs): 2 files, CLEAN
- Scan 2 (sealed plan): 1 file, CLEAN
- Scan 3 (retained): 4 files, CLEAN

### Run Outcome
- Terminal status: `observed_complete`
- interact: state=`completed`, response=`supported`
- report-residue-final: state=`completed`, response=`supported`
- Residue: clean

### Comparator Result
- **Verdict: AGREE**
- **Classification: product_agreement**
- Binding: bound=true, all gates passed
- Observed: runStatus=`clean`, collectorHealth=`healthy`, findingCount=0, findingTypes=[]
- Sub-reasons: none

---

## QLB-EXT-010 — ambiguous valid subsequence under duplication

**Purpose:** Prove ordering uses existence semantics; a duplicate event causes only a cardinality finding, not a spurious ordering finding.

### Inputs
- Stimulus: NEW (three, one, three, zero)
  - SHA256: `3b59babc3b3776bb67b35107e2b4eff53dfa5010624e4962b6c2d24e2ef2efe1` (996 bytes)
- Contract: C-VALID reused verbatim
  - SHA256: `abf5fc9bad051e7f1fe7008b2f7b2236e448fc1343098bc86459718816b2a3f4` (1180 bytes)
- Expectation: SHA256 `20a1b5648108afb07d02c7f11ec5d173d9e0315bee01b2af8ca2c595902726b3` (518 bytes)

### Pipeline
- Observation ID: `01a03e72-1d27-728b-9744-6da5b4bf9ede`
- Declaration core hash: `sha256:2d41847238be5e0a396c954071d1d4473deffed23387585e8898c404402af2d0`
- Sealed plan core hash: `sha256:e3bb1426b22c508b66263978039e418778d4c1f42a731ddf7e46f675a8d79c8b`

### Scanner Results (all CLEAN, 40 needles, 0 hits)
- Scan 1 (mounted inputs): 2 files, CLEAN
- Scan 2 (sealed plan): 1 file, CLEAN
- Scan 3 (retained): 4 files, CLEAN

### Run Outcome
- Terminal status: `observed_complete`
- interact: state=`completed`, response=`supported`
- report-residue-final: state=`completed`, response=`supported`
- Residue: clean

### Comparator Result
- **Verdict: AGREE**
- **Classification: product_agreement**
- Binding: bound=true, all gates passed
- Observed: runStatus=`rule_violation_detected`, collectorHealth=`healthy`, findingCount=1, findingTypes=[`duplicate_event`], findingEvents=[`quote_requested_three`]
- Sub-reasons: none

---

## QLB-EXT-011 — clean with an info finding

**Purpose:** Prove that an info-severity forbidden event is emitted and recorded, while runStatus rolls up to clean.

### Inputs
- Stimulus: NEW (one, three, zero, cancel)
  - SHA256: `842ece52378d161c0839c3806ddc1047d79f607d8cfd99650e8bb416af7ead30` (997 bytes)
- Contract: C-FORBID-INFO (forbidden_events with severity info)
  - SHA256: `61da9cbc5f487efdced5cde60301885d96d1fc704e6984d1a31972159db1bbc8` (1295 bytes)
- Expectation: SHA256 `d8631a32c74996305e15da3f26e755645abd1db5456d4558e038585ed352bb4e` (510 bytes)

### Pipeline
- Observation ID: `01a03e72-ee8e-70de-a019-6f09ae4faa9f`
- Declaration core hash: (scenario-specific, in declaration file)
- Sealed plan core hash: `sha256:925cc4573661e61ee4a7ac2e93afa959767f2240ace5c54532b86005d4774f10`

### Scanner Results (all CLEAN, 40 needles, 0 hits)
- Scan 1 (mounted inputs): 2 files, CLEAN
- Scan 2 (sealed plan): 1 file, CLEAN
- Scan 3 (retained): 4 files, CLEAN

### Run Outcome
- Terminal status: `observed_complete`
- interact: state=`completed`, response=`supported`
- report-residue-final: state=`completed`, response=`supported`
- Residue: clean

### Comparator Result
- **Verdict: AGREE**
- **Classification: product_agreement**
- Binding: bound=true, all gates passed
- Observed: runStatus=`clean`, collectorHealth=`healthy`, findingCount=1, findingTypes=[`forbidden_event_observed`], findingEvents=[`quote_requested_cancel`]
- Sub-reasons: none

---

## QLB-EXT-012 — partial capture must still be judged

**Purpose:** Prove the degraded/partial boundary: an incomplete but non-empty capture is judged, not abandoned.

### Inputs
- Stimulus: NEW (one, three, zero, event-less body)
  - SHA256: `a49ec1f1c21a9a004659ac1435051bd765ab6d1ac5c1c65f7428a45577effb43` (960 bytes)
- Contract: C-VALID reused verbatim
  - SHA256: `abf5fc9bad051e7f1fe7008b2f7b2236e448fc1343098bc86459718816b2a3f4` (1180 bytes)
- Expectation: SHA256 `a59337580a2654246fd0f2f50241757308e6835d81dcab5d167dfa46104eb21b` (508 bytes)

### Pipeline
- Observation ID: `01a03e73-6d25-7cfd-b259-75f8cc56f85a`
- Declaration core hash: (scenario-specific, in declaration file)
- Sealed plan core hash: `sha256:afc1060f78af970faf3a96237b29258efe2044a8ef3e9ec29e133e27256fcd5b`

### Scanner Results (all CLEAN, 40 needles, 0 hits)
- Scan 1 (mounted inputs): 2 files, CLEAN
- Scan 2 (sealed plan): 1 file, CLEAN
- Scan 3 (retained): 4 files, CLEAN

### Run Outcome
- Terminal status: `observed_complete`
- interact: state=`completed`, response=`supported`
- report-residue-final: state=`completed`, response=`supported`
- Residue: clean

### Comparator Result
- **Verdict: AGREE**
- **Classification: product_agreement**
- Binding: bound=true, all gates passed
- Observed: runStatus=`clean`, collectorHealth=`partial`, findingCount=0, findingTypes=[], inconclusiveReason=null
- forbidden_run_status `["inconclusive"]` NOT triggered (correct: runStatus was clean, not inconclusive)
- Sub-reasons: none

---

## Summary

| ID | Verdict | Classification | runStatus | collectorHealth | Findings | Target Event |
|---|---|---|---|---|---|---|
| QLB-EXT-009 | **agree** | product_agreement | `clean` | `healthy` | 0 | -- |
| QLB-EXT-010 | **agree** | product_agreement | `rule_violation_detected` | `healthy` | 1 `duplicate_event` | `quote_requested_three` |
| QLB-EXT-011 | **agree** | product_agreement | `clean` | `healthy` | 1 `forbidden_event_observed` | `quote_requested_cancel` |
| QLB-EXT-012 | **agree** | product_agreement | `clean` | `partial` | 0 | -- |

**Four of four agreed. Zero product disagreements in Wave 3.**

Oracle-absence scans: **12 of 12 CLEAN** (40 needles each, 0 hits total).

All binding gates passed on every scenario. No stop condition triggered. No scanner hit. No pin mismatch.

## Stop Conditions Checked
- No oracle-absence scan hit at any of the three points: PASSED
- All binding gates passed on every scenario: PASSED
- No comparator dependency resolved to a different digest: PASSED
- No expectation was amended after a run: N/A (all agreed on first attempt)

## Evidence Artifacts

All evidence under: `/private/tmp/qualiber-wave3-execution-1787753088/evidence/`

- `oracle-precommit.json` — stage 1 precommit with all scenario expectations bound
- `execution-lock.json` — stage 2 lock with adapter, coordinates, and dependency pins
- `campaign-index.json` — observation IDs and plan hashes for all four scenarios
- `expectations/QLB-EXT-{009..012}.expected.json` — precommitted expectation files
- `scenarios/QLB-EXT-{009..012}/` — per-scenario evidence trees:
  - `input/` — stimulus.json and contract.json
  - `declaration/` — trusted-local-declaration.json
  - `plan/` — plan-draft.generated.json and plan-sealed.json
  - `scans/` — scan-1-mounted-inputs.json, scan-2-sealed-plan.json, scan-3-retained.json
  - `run-output/` — full observation record, retained inputs, retained outputs
  - `comparison/` — comparison.json with verdict and full binding report
