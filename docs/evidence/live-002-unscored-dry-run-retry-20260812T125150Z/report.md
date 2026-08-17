# Bounded unscored Qualiber dry-run retry — merged Reality Lab

Verdict: **BLOCKED — ONBOARDING**

## 1. Run identity

- Evidence root: `/private/tmp/qualiber-unscored-live-dry-run-retry-20260812T125150Z`
- Window: 2026-08-12T14:03:08Z → 14:10Z (well inside the 60-minute bound)
- One scenario, one primary attempt, no retry needed (failure was deterministic, not transient)

## 2. Merged Lab coordinates

- merge commit `70b7e6e00aabba30bc07ca2c15d35404e40439b7`
- `origin/main` tree `b3b4e75f807608ff322f26649c9eacd5f8fef0fb` — identical to approved candidate
- Executed from a disposable clone at that commit; canonical checkout untouched

## 3. Frozen hashes (recomputed before and after — all unchanged)

| artifact | sha256 |
|---|---|
| adapter `main.mjs` | `b977ac2ad4698de7145ddc1d01b4aa27f2bc4c7a8d5b13d57ce997289b976893` |
| `manifest.json` | `7893d048f888ec24fdb9c311a7cd864e0b8782b0b56c414b72077d2b326dfb27` |
| `receipt.json` | `6f3087e7ed9a9fea916baeedbc55baf2b26749286daee5c799cc49a6c0d7f4ed` |
| r5 CLI tgz | `e95220cb516ac977a32b60bfc554cbf793f8c8a61b9330a4c2e5f9f963803887` |
| r5 collector tgz | `79b4e930d4e523749e843bb212adb839578212747cddcde26fc353d5c9f30820` |
| r5 schema | `b8c264d1e8077f6331b2671dde5eccbc106656d0bd1f69cdfdc5a282de0d244b` |
| r5 example | `e8c5368c8fc5c503dca92db2e72c765a382ec3a93fe8b473c5fdda1918e8f55f` |

Producer-declared Qualiber commit `bc0c2d1f6029294e8fea8dff8af30407fb331127`, tree `38611a2f39db799d3ba10ba2746f25a9a1eae22e`. No Qualiber source checkout was accessed.

## 4. Onboarding observation

Started from public documentation, as a new QA engineer.

- Starting command found in `README.md:203` — the receipt-aware `admit-adapter` invocation, reached without reading implementation.
- Prerequisites stated in advance: Node/npm, `npm install`, `npm run build`, development tier, governor-prepared registry.
- Prerequisites discovered through failure: none for admission — it worked first try, verbatim from the README.
- Undocumented intervention required: **none up to admission**; **unavailable beyond it** (§6).
- Elapsed to admission: **48 s** from clock start (build 8 s; admission ~1 s).
- Elapsed to first meaningful product result: **never reached**.

Usability defect retained from the prior run: subcommand `--help` is rejected with `CFG_UNKNOWN_FLAG`, so flag discovery depends entirely on prose.

## 5. Admission result — the LIVE-001 fix works

`admit-adapter` exit 0, first attempt, documented syntax:

| field | value |
|---|---|
| `adapter_id` / `version` | `independent-analytics-validator` / `0.1.0` |
| `adapter_manifest_hash` | `sha256:45d6428e…583e9b07` — matches frozen core hash |
| `certification_receipt_hash` | `sha256:24d75c1c…31e6239b` — matches frozen core hash |
| `adapter_artifact_hash` | `sha256:b977ac2a…76893` — matches adapter bytes |
| `certifier_id` / owner? | `independent-adapter-certifier` / `certifier_is_adapter_owner: false` |
| `certification_authenticity` | **`locally_observed_unauthenticated`** — exactly as designed for an unsigned receipt |
| `receipt_linkage` | `bootstrap_no_prior_receipt` |
| `tier` | `development` |

**Retained-receipt proof.** The registry now holds `external-adapters/45d6428e…/{adapter-manifest.json,certification-receipt.json}`, byte-identical to the frozen originals (`7893d048…`, `6f3087e7…`). The receipt is consumed *and retained*, which is precisely the LIVE-001 defect closed.

## 6. Deterministic blocker

`preregister-acquisition` refuses with `CFG_MISSING_REQUIRED: flag --acquisition-source is required`, and requires eight further governor-prepared hashes: `--acquisition-source`, `--acquisition-actor-script`, `--acquisition-actor-schema`, `--acquisition-step`, `--package-verification-step`, `--generic-policy`, `--trust-policy`, `--limits`.

There is no way to obtain them through any supported interface:

- the full CLI surface (34 commands) contains exactly one admission command, `admit-adapter`; nothing prepares a governor registry;
- `doctor` reports substrate/launcher health and says nothing about registry preparation;
- `fixtures/golden/valid-pre-environment-run/` ships `artifacts`, `lifecycle.json`, `public-bundle.json`, `root-config.json` — **no registry** to copy or learn from;
- `README.md:213` states the values "come from a governor-prepared registry, which is prepared out of band — admission removes one blocker, not the whole setup."

Proceeding would have required hand-authoring governor registry internals — undocumented intervention that recreates governor infrastructure. Per the anti-force-fitting rule, the run stopped here.

## 7. Lifecycle operations

| operation | status |
|---|---|
| `admit-adapter` (precondition) | **succeeded** |
| acquire, validate-package, install, configure, start, interact, translate-evidence, project, report-residue, compensate, uninstall | **not reached** — preregistration is the gate |

## 8. Qualiber artifact interaction

| question | answer |
|---|---|
| 1. Collector artifact is the frozen r5 collector | not reached |
| 2. Host CLI matches r5 CLI digest | not reached |
| 3. Admitted adapter identity and receipt match frozen certification | **yes — verified byte-identical** |
| 4. Real interaction reaches evaluator/collector path | **no** |
| 5. Actual evaluator output produced | **no** |
| 6. Translation/projection creates contract-valid evidence | not reached |
| 7. Provenance linked to run, receipt, adapter, artifacts | partial — receipt/adapter bound at admission; no run exists |
| 8. Cleanup completes without residue | **yes** |

No mocks were used and no product output was synthesized. **B-129 was not exercised** — the run never reached the r5 contract, so B-129 is neither confirmed nor cleared here.

## 9. Findings

### F-1 — Governor registry has no documented or discoverable preparation path
- Category: `ONBOARDING_OR_DOCUMENTATION_DEFECT` · Severity **P1**
- Reproduce: build merged Lab → `admit-adapter` (succeeds) → `preregister-acquisition` with only the two emitted hashes.
- Expected: a documented command or procedure yielding the eight artifact hashes.
- Actual: `CFG_MISSING_REQUIRED`; no CLI command, runbook, or fixture provides them.
- Evidence: `logs/preregister-attempt1.json`, `logs/doctor.json`, `README.md:182,213`
- Dimensions: usability/onboarding, functionality. Roles: QA engineer, QA manager, QA director, DevOps, product manager.
- Owner: Reality Lab onboarding/documentation (not the generic contract — delegation to a governor is deliberate design).
- Blocks another unscored run: **yes**, until a governor registry exists.
- Blocks scored operation: **yes**, independently of signing.

### F-2 — Subcommand `--help` rejected
- Category: `ONBOARDING_OR_DOCUMENTATION_DEFECT` · Severity **P3**
- `admit-adapter --help` → `CFG_UNKNOWN_FLAG`. Unchanged from the prior dry run.
- Owner: Reality Lab CLI. Blocks another unscored run: no. Blocks scored: no.

### F-3 — Receipt-aware admission works end to end (positive)
- Category: informational, no defect.
- First-try success, byte-identical retention, correct `locally_observed_unauthenticated` labelling, independent certifier recorded. The prior run's admission blocker is closed.

## 10. Timing

Build 8 s; admission ~1 s; total to blocker 48 s. No performance conclusion is available — nothing product-facing executed.

## 11. Cleanup and residue

Docker containers, networks, volumes and images identical before and after. No task-created process, container, network, volume, image, or temp root. No adapter process was ever dispatched. Both canonical repositories clean at their expected coordinates; all seven frozen artifacts unchanged. Evidence root preserved.

## 12. Limitations

Unsigned real receipt; no pinned certifier authority; scored execution prohibited and unreachable; development/local-process only, without container/kernel isolation; B-129 and B-130 remain open and unexercised; one run supports no product-quality generalization about Qualiber.

## 13. Recommended next action

**One action, owned by the Reality Lab onboarding stream:** publish a documented way to obtain a governor-prepared registry for a development-tier run — either a `prepare-registry`-style command or a runbook procedure producing the eight required hashes — then repeat this bounded unscored dry run unchanged. No Lab contract change, no adapter change, and no Qualiber change is indicated by this evidence.
