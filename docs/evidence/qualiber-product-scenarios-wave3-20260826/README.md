# Qualiber Wave 3 — product-scenario publication candidate

**Campaign:** `qualiber-product-scenarios-wave3-20260826`
**State:** immutable, byte-preserving **publication candidate** — uncommitted, awaiting independent review.
**Assembly date:** 2026-08-26.

This directory is a composed, byte-for-byte assembly of the complete Wave 3 evidence
trail (scenario execution, determinism, control closure, and the full remediation
history). No source evidence was edited, rerun, republished, committed, or repaired
during assembly. This assembly session is **not** an independent review.

---

## 1. Bounded result (four Wave 3 scenarios)

| Scenario | Verdict | Classification | Run status | Health | Findings |
|---|---|---|---|---|---|
| QLB-EXT-009 | agree | product_agreement | clean | healthy | 0 |
| QLB-EXT-010 | agree | product_agreement | rule_violation_detected | healthy | 1 (duplicate_event) |
| QLB-EXT-011 | agree | product_agreement | clean | healthy | 1 (forbidden_event_observed, info) |
| QLB-EXT-012 | agree | product_agreement | clean | partial | 0 |

- **4 / 4 product agreements, 0 product disagreements.**
- **4 / 4 semantic-determinism checks CONFIRMED** (completion run vs first attempt).
- **15 / 15 active control-set-v2 negative controls** reproduced their precommitted
  verdicts under independent re-execution (FINAL review: *ADMISSIBLE — CONTROL SET V2 CONFIRMED*).
- Original **NC-11** (property miss) and **NC-12** (FAILED) are **superseded** by
  **NC-11R** and **NC-12R**; the originals do **not** count as passing controls.

See [claim-ceiling.md](claim-ceiling.md) for exactly what these observations do and do not assert.

## 2. Immutable product coordinates

| Item | Value |
|---|---|
| Qualiber commit | `236282a667fa161ee16fd363e33559cfe7871ba0` |
| Qualiber tree | `e40e5028ef172590ce482debf18e5d99f6099971` |
| Reality Lab commit | `02de870ef593c2cbd8c517792072769867f33e46` |
| Reality Lab tree | `16e20fff5f09535ccb0014c4346258f34ec94ef6` |
| Adapter dependency pin | `69ace16fb7ee021dddbcf3fa70e4295c2e5a400b` |
| Adapter artifact SHA-256 | `c65c6393af5e6d83f937c3d0d7f274101e915922494d8fcec26f8865fe05e762` |

Full identities: [coordinates.json](coordinates.json). No Qualiber and no Reality Lab product-code change.

## 3. Composed evidence structure

```
qualiber-product-scenarios-wave3-20260826/
├── README.md                    ← this file
├── chronology.md                ← attempt 1 → completion → remediation → closure → assembly
├── supersession.json            ← NC-11→NC-11R, NC-12→NC-12R, runner history
├── claim-ceiling.md             ← what is and is NOT claimed
├── coordinates.json             ← product/Lab/adapter/tooling/dependency identities
├── errata.md                    ← known historical blemishes + authoritative replacements
├── publication-readiness.json   ← counts, integrity results, outstanding blockers
├── evidence-index.json          ← canonical index (excludes only itself + its sidecar)
├── evidence-index.sha256        ← sidecar digest of evidence-index.json
├── campaign/                    ← AUTHORITATIVE scenario evidence (attempt-1 full trees)
├── determinism/                 ← AUTHORITATIVE determinism evidence (completion run)
├── control-closure/             ← AUTHORITATIVE control evidence (control-set-v2, 15 controls)
├── history/
│   ├── attempt-1/               ← immutable first attempt (byte-identical to campaign/)
│   ├── completion-attempt/      ← immutable completion attempt (incl. UNINDEXED review result)
│   └── remediation/             ← v1/v2 designs, corrected tooling, reviews, manifests
├── reviews/                     ← independent review reports (byte-identical copies)
└── provenance/                  ← composition map, coordinate lock, source manifests
```

**Authoritative lanes** (`campaign/`, `determinism/`, `control-closure/`) carry the evidence
that supports the verdict. **`history/`** preserves the full trail — including defects — for
audit. See [provenance/composition-map.json](provenance/composition-map.json) for the exact
source→destination map and per-file provenance in
[provenance/composition-file-map.json](provenance/composition-file-map.json).

## 4. How to verify

1. **Index integrity.** Confirm `evidence-index.sha256` verifies `evidence-index.json`.
   Recompute the SHA-256 and byte length of **every** file under this directory except
   `evidence-index.json` and `evidence-index.sha256`; require exact path-set equality with
   the index (no missing, no extra, no duplicates, no symlinks, no absolute/traversal paths).
2. **Source fidelity.** For each source root, rebuild a `path|sha256|bytes|mode` manifest and
   compare to `provenance/source-manifests/*.open.manifest`; confirm each composed lane is
   byte/path/mode identical to its source (`campaign/` and `history/attempt-1/` both equal
   attempt-1; `control-closure/` equals the closure evidence; etc.).
3. **Semantic outcomes.** Re-derive the four scenario verdicts from `campaign/scenarios/*/comparison/comparison.json`.
4. **Determinism.** Re-derive the four CONFIRMED results from `determinism/`.
5. **Controls.** Re-execute or independently validate the 15 active controls from
   `control-closure/`; confirm NC-11 and NC-12 are **not** counted and NC-11R/NC-12R are the
   authoritative replacements. The frozen methods are of **two different kinds** — see §5a.

### 5a. Where the frozen control methods actually live

**Embedded in this bundle** (indexed evidence bytes, verifiable from the bundle alone), under
`history/remediation/candidate-v2/tooling/`: the v2 remediation tools only —
`run-negative-control-v2.mjs` (`f59f3127…`), `nc11r-fixture-builder.mjs` (`b74e6571…`),
`residue-scanner.mjs` (`53b8c3f5…`) and their test files.

**Not embedded in this bundle** — these three are **digest-pinned executable tooling**, resolved
from the preserved authority named by the frozen locks:

| Tool | Pinned SHA-256 | Bytes | Resolved from (authority recorded in this bundle) |
|---|---|---|---|
| `compare-scenario.mjs` (generalized comparator) | `83223022f1522f4c22607f02123e02a0c5ff9cf92363aba0ec1e8a256010bcc4` | 36999 | `qualiber-wave3-comparator-candidate/compare-scenario.mjs` — the frozen source path recorded in `campaign/oracle-precommit.json` (`tooling_digests.compare_scenario_mjs.source`), preserved as a `path\|sha256\|bytes\|mode` record in `history/remediation/ird001-preservation/inputs-open.manifest` / `inputs-close.manifest` |
| `run-negative-control.mjs` (v1 negative-control runner) | `951326f76e438d7c7e4abea10d11ec147d9af660cc1ebe2a7f2aa259d074215c` | 30954 | the completion run's `tooling/` tree — preserved as `tooling/run-negative-control.mjs` in `control-closure/preservation/completion-open.manifest` and `history/remediation/ird001-preservation/completion-open.manifest` / `completion-close.manifest` |
| `oracle-absence-scan.mjs` (oracle-absence scanner) | `5a2f48445aee2aa76b7621c661cd24d8f343bc1f632478099cf85f8a5322d631` | 8038 | `qualiber-wave3-comparator-candidate/oracle-absence-scan.mjs` — the frozen source path recorded in `campaign/oracle-precommit.json` (`tooling_digests.oracle_absence_scan_mjs.source`), preserved in the same `ird001-preservation` input manifests |

These three are **not** under `history/remediation/candidate-v2/tooling/` and are **not present
anywhere else** in this bundle. They are **reconstructed campaign tooling**, not committed
repository source and not generated evidence output: the comparator is the committed Wave 2 base
comparator (`89e92a03…`) plus exactly the owner-approved G1/G2 changes; the scanner is the
committed Wave 1/2 scanner (`5a17321b…`) plus exactly two mechanical additions; the v1 runner is
the retained on-disk completion-run runner, re-frozen at control closure (see `errata.md` E-1).
The Reality Lab tree at the pinned commit `02de870e…` therefore does **not** contain these exact
bytes; it contains only the earlier same-named Wave 1/2 files, whose digests differ.

Binding rules for a reviewer resolving them:

- **Digest-verify before use.** Recompute SHA-256 and byte length and require an exact match with
  the pinned value above and with `campaign/execution-lock.json`,
  `campaign/oracle-precommit.json`, `control-closure/control-precommit.json` and
  `control-closure/control-execution-lock.json`. On any mismatch, **abort** — do not proceed.
- **No fallback substitution.** Resolution by live `main`, by any moving branch or tag, by `PATH`
  lookup, or by a similarly named local file is **not permitted** — including the same-named
  `compare-scenario.mjs` (`89e92a03…`) and `oracle-absence-scan.mjs` (`5a17321b…`) committed under
  the Wave 1/2 evidence directories at Reality Lab `02de870e…`.
- **Dependency anchor (comparator only).** `compare-scenario.mjs` requires a real
  `--dependency-anchor` `package.json` whose resolved `@erl2/contracts` and `@erl2/integrity`
  entries hash to `da45bec0…` and `c927d02c…`, built from Reality Lab `69ace16fb7ee021dddbcf3fa70e4295c2e5a400b`
  (see `coordinates.json` / `provenance/coordinate-lock.json`). The scanner and the v1 runner need
  only Node ≥ 22 and no build step.
- **If a pinned tool cannot be resolved and digest-verified**, the affected control re-execution is
  **not reproducible from this bundle alone** and must be reported as such rather than substituted.
  The bundle-only path remains available: all four scenario semantics are re-derivable from the
  retained product artifacts, NC-11R from the recorded `control-closure/nc11r/*.comparison.json`,
  and NC-12R from the embedded frozen residue-scanner suite.
6. **Claim ceiling & chronology.** Confirm [claim-ceiling.md](claim-ceiling.md) and
   [chronology.md](chronology.md) against the evidence; confirm no local paths or secrets leak.

The self-contained reviewer prompt is delivered **outside** this indexed directory at
`/private/tmp/qualiber-wave3-composed-publication-independent-review-prompt.md`.
