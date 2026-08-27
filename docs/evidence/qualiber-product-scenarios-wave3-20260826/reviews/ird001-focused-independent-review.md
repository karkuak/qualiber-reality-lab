# Focused independent review — IRD-001 correction & NC-11R binding/precedence

**Review type:** focused, read-only. **Conducted in-session** as a fresh
re-derivation: a new scratch root, re-deriving the binding source directly from
comparator bytes and the immutable record rather than trusting the Sequence A
artifacts. No candidate tooling, evidence, repository, or GitHub was modified.

**Scratch root:** `/private/tmp/qualiber-wave3-ird001-focused-review-1787765184-93723/`

## Checks (all pass)

| # | Check | Result |
|---|---|---|
| 1 | Input manifests verified; preservation open==close aggregate consistent | ✓ |
| 2 | Comparator digest = `83223022…` (pinned) | ✓ |
| 2 | Binding source re-derived from source: `findInteractCompletedRecord` (line 208) → `operation_records[interact/completed].retained_output_refs` (line 469) → `bindArtifact` (line 473) | ✓ |
| 3 | Comparator references to top-level `result.retained_output_refs`: **0** → IRD-001 inspected the wrong layer | ✓ |
| 4 | Selected op record: `interact`/`completed`, `interact-validate-stimulus`, **11 refs**; run-result present (`sha256:3d496e9b…`) | ✓ |
| 5 | Fixture rebuilt from source (v2 builder) in the fresh root | ✓ |
| 6 | Every binding layer updated **exactly once** (run-result content; op-record run-result ref ×1; run-summary artifact_hashes ×1; op-record run-summary ref ×1; run-result `.frozen` ×1) or explicitly **inapplicable** with source-backed reasoning (run-summary `.frozen` — comparator only walks product-out sidecars) | ✓ |
| 7 | Builder fails closed on: zero matching primary refs; duplicate matching refs; unchanged digest; absent/stale run-summary witness; stale `.frozen` sidecar | ✓ |
| 8 | Positive-bound control → `agree`, `bound=true`, run_status=inconclusive | ✓ |
| 9 | NC-11R → observed inconclusive, expected inconclusive, forbidden includes inconclusive, **`disagree`/`product_disagreement`**, sub-reason **`forbidden_run_status_observed`**, and NOT `run_status_mismatch` | ✓ |
| 10 | Forbidden-precedence branch disabled in a comparator **copy** → NC-11R property goes red (verdict flips to `agree`) | ✓ |
| 11 | A mismatch-only expectation disagrees via `run_status_mismatch` and does **not** satisfy NC-11R | ✓ |
| 12 | All tooling digests + executable modes match `digest-mode-inventory.json`; comparator under test is the pinned one | ✓ |
| 13 | No scenario-specific semantic branch; no Qualiber import (only `node:*`) | ✓ |
| 14 | Full suite re-run from the fresh root: `test-nc11r-binding.mjs` **18/18**, `test-residue-scanner.mjs` **33/33**; NC-12R runner **HELD** | ✓ |
| 15 | Both evidence roots and **both** candidate versions (v1, v2) byte/path/mode unchanged after review | ✓ |
| 16 | Review result written outside every evidence/candidate directory | ✓ |

## Independent property matrix (real comparator `83223022…`, real `@erl2` `69ace16`, real QLB-EXT-012 bytes)

| Scenario | verdict | bound | observed run_status | sub_reasons |
|---|---|---|---|---|
| POSITIVE-BOUND-CONTROL | agree / product_agreement | true | inconclusive | `[]` |
| NC-11R FORBIDDEN-PRECEDENCE | **disagree / product_disagreement** | true | inconclusive | `[forbidden_run_status_observed]` |
| MUTATION-NO-FORBIDDEN | agree / product_agreement | true | inconclusive | `[]` |
| precedence disabled (comparator copy) | agree | true | inconclusive | property correctly red |

## Assessment

The Sequence A correction is sound. IRD-001's symptom was real (the v1 builder
silently failed to bind the retained output), but its diagnosis named the wrong
layer: the comparator binds `operation_records[interact/completed].retained_output_refs`,
never the empty top-level `result.retained_output_refs`. The v2 builder binds
every comparator-read layer exactly once, fails closed on zero/multiple/stale
inputs, reports every update, and QLB-EXT-012 supports complete binding. NC-11R
demonstrates forbidden-status precedence over a matching expectation through the
real comparator, with `run_status_mismatch` provably excluded as the cause;
NC-12R remains byte-identical to the confirmed v1 tooling and HELD. Both
candidate versions are preserved.

## Deliverables

- `qualiber-wave3-ird001-focused-review.md` (this file)
- `qualiber-wave3-ird001-focused-review/` — `ird001-focused-review-result.json`,
  `comparison-outputs/` (positive, forbidden, mutation, fixture-record, nc12r),
  `MANIFEST.sha256`
- Reproduction: follow `qualiber-wave3-ird001-REPRODUCTION.md`, substituting a
  fresh `$ROOT`; every verdict above is reproduced by steps 2–5 there.

---

**CONTROL REMEDIATION V2 READY TO FREEZE — NC-11R AND NC-12R CONFIRMED**
