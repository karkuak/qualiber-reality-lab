# Provenance note — Wave 3 product-scenario publication candidate

**Subject:** `docs/evidence/qualiber-product-scenarios-wave3-20260826/`
**This note is a sibling of that directory. It is deliberately NOT inside the indexed
evidence directory and is NOT covered by that directory's `evidence-index.json`.**
It is provenance metadata about the candidate, not indexed campaign evidence.

## Source campaign roots (byte-preserving copies only)

- `qualiber-wave3-execution-1787753088/evidence/` — first attempt (authoritative scenario evidence).
- `qualiber-wave3-completion-1787755899/evidence/` — completion attempt (determinism evidence; historical).
- `qualiber-wave3-control-closure-1787765436-98932/evidence/` — control-set-v2 closure (authoritative control evidence).
- `qualiber-wave3-control-closure-independent-review-FINAL.md` — FINAL independent review.
- Remediation history: `qualiber-wave3-control-remediation-design.md`,
  `qualiber-wave3-control-set-v2.json`, `qualiber-wave3-control-remediation-candidate/`,
  `qualiber-wave3-control-remediation-candidate-v2/`, `qualiber-wave3-ird001-remediation-report.md`,
  `qualiber-wave3-ird001-focused-review.md`, and the related manifests / preservation records
  (`…-control-remediation-preservation/`, `…-ird001-preservation/`, the remediation and IRD-001
  SHA-256 manifests, review results/prompts, and test report).

Per-source `path|sha256|bytes|mode` manifests are inside the indexed directory at
`provenance/source-manifests/`; the composition map is at `provenance/composition-map.json`.

## Immutable coordinates

| Item | Value |
|---|---|
| Qualiber commit / tree | `236282a667fa161ee16fd363e33559cfe7871ba0` / `e40e5028ef172590ce482debf18e5d99f6099971` |
| Reality Lab commit / tree | `02de870ef593c2cbd8c517792072769867f33e46` / `16e20fff5f09535ccb0014c4346258f34ec94ef6` |
| Adapter dependency pin | `69ace16fb7ee021dddbcf3fa70e4295c2e5a400b` |
| Adapter artifact SHA-256 | `c65c6393af5e6d83f937c3d0d7f274101e915922494d8fcec26f8865fe05e762` |

## Assembly method

Byte-for-byte copy (`shutil.copy2`; each file's SHA-256 and mode re-verified against its
source). Every source directory lane is byte/path/mode identical to its source manifest.
**No source evidence was edited, renamed, reindexed, or repaired.** No scenarios were rerun,
no controls were rerun, nothing was published, committed, pushed, or filed. This assembly
session is **not** an independent review.

## Historical defects and supersession (preserved, not repaired)

- Post-freeze runner digest mismatch in the completion attempt (`a8f0d1b6…` committed vs
  `951326f7…` on disk); re-frozen as `951326f7…` at control closure.
- Original **NC-11** property miss → superseded by **NC-11R** (not counted as a passing control).
- Original **NC-12** FAILED → superseded by **NC-12R** (not counted as a passing control).
- The completion attempt's `independent-review-result.json` is **unindexed** in that attempt's
  own index; preserved as-is under `history/completion-attempt/`.

See `errata.md` and `supersession.json` inside the indexed directory for full detail.

## Final control-closure verdict

**WAVE 3 CONTROL CLOSURE ADMISSIBLE — CONTROL SET V2 CONFIRMED** (FINAL independent review):
all 15 active controls independently re-executed and reproduced their precommitted verdicts;
two non-blocking documentation observations (NC-10 annotation looseness; undocumented
`source_tree_sha256` algorithm).

## Bounded result

- Four Wave 3 scenarios (QLB-EXT-009…012): **agree / product_agreement**, **0 product disagreements**.
- Four semantic-determinism checks CONFIRMED. Fifteen active controls reproduced.
- **No Qualiber product-code change. No Reality Lab product-code change.**

## Status

This is **not** a certification and **not** independent assurance. The candidate is
**uncommitted and awaiting independent review**. This provenance note is **not** claimed to be
covered by the campaign evidence index.
