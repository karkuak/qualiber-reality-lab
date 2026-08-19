# Qualiber external product-scenario test plan — Reality Lab Wave 1

**Revision 4.3** — 2026-08-17. Errata only. The plan was substantively approved at revision 4.2; this applies the three mandatory textual corrections from the sixth review and changes nothing else. Architecture (Option B) untouched; Wave 1 not expanded; no Reality Lab product code modified. §0 maps every finding from all six reviews to its correction.

**§21 is now ready to hand to an implementation agent**, subject to the gate status below.

**Gate status — two gates, not one.**

| Gate | State | Meaning |
|---|---|---|
| Code / dependency merge | **closed** | Both integration branches are merged. Reality Lab `origin/main` = `69ace16`, tree `89988e55…` (PR #18). Qualiber `origin/preprod` = `b07746e`, tree `b9a7c66f…` (PR #369). These are the baselines this plan binds |
| Historical evidence-publication PR | **open** | Still running, and independent of the above. It publishes prior evidence and is not a prerequisite for Wave 1 implementation; nothing in this plan waits on it, and nothing in this plan may be cited by it |

Implementation is **not yet authorized** — the fourth review approved the architecture and withheld authorization pending this revision. §19 step 0 is now a baseline confirmation against the merged coordinates rather than a wait.

**Status:** design only. Nothing in either repository was created, edited, staged, committed, or run to produce this document. No service was started, no dependency installed, no product scenario executed.

---

## 0. Review disposition

### Sixth review → revision 4.3 (errata only; plan substantively approved at 4.2)

| # | Erratum | Correction | Where |
|---|---|---|---|
| E-1 | `comparator_dependencies` was defined in a later fragment but missing from the canonical stage-2 example | Added to the `execution-lock.json` example, and the sentence beneath it now names the block | §10.1 |
| E-2 | The implementation prompt still said "two task-local scripts" and bound only comparator and scanner digests | Rewritten to name all three scripts plus `tooling-test-result.json`, and to bind `comparator_dependencies` in stage 2 — matching §10.1 and the tooling paragraph above it | §21 |
| E-3 | The dependency-provenance claim was too strong: an entrypoint digest does not identify all executed code | Verified — `@erl2/integrity`'s `src/index.ts` re-exports `coreHash` from `./hash/hash.js`, so `dist/src/index.js` does not cover the implementing file. Narrowed to state exactly: name/version/entrypoint digest bind the entrypoint; the provisioning receipt records the pinned Lab commit (`69ace16`) and tarball digests; together they prove neither complete dependency closure nor absence of post-install mutation of internal files; the limitation is accepted under the trusted-local claim ceiling. No package-tree inventory added | §10.3.1, §13.2, §21 |

### Fifth review → revision 4.2

| # | Review finding | Correction | Where |
|---|---|---|---|
| B-1 | Comparator dependency resolution unspecified — Node resolves bare specifiers from the importing module's location, so the two Lab imports would fail from campaign scratch however correctly they were provisioned | New §10.3.1: required `--dependency-anchor <fresh-qualiber>/adapters/erl2-subject/package.json`, `createRequire(anchor).resolve()` for both packages, dynamic import via `pathToFileURL`, hard exit before any comparison on failure. Provenance bound in `execution-lock.json` as `comparator_dependencies` (name, version, entry digest; anchor repository-relative, absolute paths to the command log only). Every run re-resolves and asserts the triples match, so a mid-campaign swap of `@erl2/integrity` cannot pass unnoticed | §10.3, §10.3.1, §12, §20, §21 |
| B-2 | Comparator testing ordered before the comparator is authored | Step 0a now authors all three scripts, runs the tests, and writes `tooling-test-result.json` recording **the sha256 of the comparator tested**; stage 1 then binds all three tooling digests plus that result. A tooling freeze follows: no script edit after stage 1 without a recorded precommit revision, re-run tests and a rewritten result. §12's sequence reordered to match | §10.1, §12, §19 steps 0a and 1, §13 |
| S-1 | Three passages still said "three steps" or listed Node-only imports | §4.5 row, QLB-EXT-005's reading instruction, and the oracle-constraints table all updated to the four-step bind and the two anchored Lab imports | §4.5, §8 (005), §10.3 |

### Fourth review → revision 4.1

| # | Review finding | Correction | Where |
|---|---|---|---|
| B-1 | The offline verifier does not validate response-envelope bytes or recompute their core hash — revision 4's delegation was unfounded | Confirmed in source: `VerifyTrustedLocalRecordInput` is `recordBytes` / `planBytes` / `registryRoot` / `adapterEntryPath` / `retainedInputRoot` — **no retained-output or envelope path** — and `trustedLocalVerifier.ts:465` only checks that `outcome.response_envelope_hash` and `terminal.response_envelope_hash` agree, two fields of one record. An edited `/error/code` keeping its original declared `core_hash` would have passed. Bind is now four steps: bytes vs `.frozen` → schema-check `AdapterResponseEnvelopeV2` → **recompute `coreHash(envelope)`** → `recomputed === envelope.core_hash === response_envelope_hash`. Comparator imports `@erl2/contracts` and `@erl2/integrity` (`hash/hash.ts:103`), both generic and consumed as published; no Lab source changes and nothing from Qualiber. Required comparator test added for the stale-hash mutation | §4.5, §10.5, §10.6, §19, §20, §21 |
| B-2 | Pre-merge coordinates and the wrong Qualiber checkout | Baselines replaced with the merged ones, verified: Lab `origin/main` `69ace16` / tree `89988e55…` (PR #18); Qualiber `origin/preprod` `b07746e` / tree `b9a7c66f…` (PR #369). Mandatory hygiene added: fresh worktree from `b07746e`, **never** the primary checkout (33 dirty paths at verification), and the three Lab packages provisioned from a clean checkout pinned to `69ace16`. The header now separates the **closed** code/dependency gate from the **open**, unrelated historical evidence-publication PR | header, §4.1, §19 step 0 |
| C-1 | Step 9 could not run the comparator against the 2026-08-16 bundle | Replaced. That bundle predates every binding this comparator requires and has a different adapter and plan topology, so the gate would refuse it. Comparator confidence now comes from task-local unit tests at new **step 0a**, before stage 1; QLB-EXT-001 is the first compatible end-to-end exercise | §12, §19 steps 0a and 9 |
| C-2 | Scenario-local counterfactuals for 001 and 004 created unnamed extra controls | Both relabelled as **illustrative, not executed**, with the note that making either real requires a named eighth control and a stage-1 counterfactual. §2 corrected from six to seven, matching §11 | §2, §8 (001, 004) |
| C-3 | The stage-1 JSON example omitted the `negative_controls` block its own normative text requires | Added to the example and to the binding list above it | §10.1 |
| C-4 | The evidence-layout note still claimed pre-run commitment was established | Reworded: only oracle absence from retained product inputs is independently checkable; the ordering is asserted by the operator record. Claim ceiling aligned | §13, §13.2, §1 |
| C-5 | Date and final marker stale (“revision 2”) | Updated to revision 4.1, 2026-08-17 | header, end |

### Third review → revision 4

| # | Review finding | Correction | Where |
|---|---|---|---|
| 1 | The envelope binding compared the wrong hashes — the record stores `envelope.core_hash`, not the file's sha256 | Confirmed in source and measured against the retained baseline: record `response_envelope_hash` = `sha256:da6532e3…560c1b` = envelope `core_hash`; the file's sha256 is `sha256:0a24af24…0c661e`. The revision-3 check would have failed on **every** run, including correct ones. Replaced with a three-step bind: file bytes vs `.frozen` sidecar → parse → `envelope.core_hash === operation.response_envelope_hash`, leaving canonical core-hash validation to `verifyTrustedLocalObservationRecord`, which has already run. All seven sites updated | §4.5, §8 (005), §10.5, §10.6, §10.8, §20, §21 |
| 2 | NC-1 contradicted the mandatory binding gate: a mutated `expected.json` yields `lab_harness_failure`, not `product_disagreement` | Counterfactual expectations are now pre-authored at stage 1 and bound under a `negative_controls` block in `oracle-precommit.json`; the comparator's control mode accepts only a counterfactual whose digest matches an entry, so the mode cannot become a route around the gate. Added **NC-1b**, which mutates `expected.json` and *must* yield `lab_harness_failure` — proving the gate that makes the counterfactual necessary. The 001, 003 and 004 scenario-local controls are corrected the same way | §8 (001, 003, 004), §11 |
| 3 | 001 and 004 omitted `expected_response_status`, contradicting the both-fields rule | Added to both | §8 (001, 004) |
| 4 | 002's failure-ownership row still said `count > 2` | Corrected to `count > 1`, matching the tightened oracle; the adapter row in the same line now names `response_status` rather than a bare "failed" | §8 (002) |
| 5 | §12 listed build steps and then told the reader to author inputs "before step 1" | Rewritten as a single forward-only sequence mirroring §19: coordinates → author → stage 1 → spike → implement and build → comparator rehearsal → stage 2 | §12 |
| 6 | The evidence claim overstated what a self-authored precommit proves | Reworded throughout: the precommit and command log **record** that the operator fixed expectations before execution; they do not independently prove chronology, and nothing countersigns or timestamps them. The scans remain checkable from retained bytes. No signing, timestamping or new subsystem added | §13, §13.2, §16 |

### Second review → revision 3

| # | Review finding | Correction | Where |
|---|---|---|---|
| P0-1 | QLB-EXT-005 used the wrong Lab operation semantics: an adapter-returned `{status:"failed"}` does not produce record state `failed` | Confirmed in source and corrected. `complete()` writes `state: "completed"` with `response_status: envelope.status` and an in-source comment that a completed record never meant the adapter succeeded; `fail()` — the only route to `state: "failed"` — is for host/execution faults and carries `failure_code`, not an adapter error code. 005 now expects `state: completed`, `response_status: failed`, and `SUBJECT_PRODUCT_CLI_REFUSED` read from the retained response envelope at `/error/code`, bound through `response_envelope_hash`. The cleanup-only claim is withdrawn: `cleanupOnly` is set only by `fail()` and `markAmbiguous()`, so `report-residue` runs simply because it is next. **Consequence beyond 005:** the comparator now reads `state` *and* `response_status` in every scenario | §4.5, §8 (005), §10.5, §10.6, §10.8 |
| P0-2 | The precommit was circular — it bound adapter and manifest hashes that steps 3–6 had not yet produced, and required observation IDs that are minted later | Split into two commitments. `oracle-precommit.json` before the spike (stimuli, contracts, expectations, tooling digests, scenario definitions, the Qualiber baseline the spike used). `execution-lock.json` after implementation and build but before official runs (references the oracle-precommit digest; binds final coordinates and status, adapter artifact, manifest, runtime provenance). Observation IDs and sealed-plan hashes move to the campaign index, generated after sealing | §10.1, §10.2, §12, §13, §19 |
| P0-3 | QLB-EXT-003's oracle was wrong: a three-event path has two predecessor-ordering constraints, and the inversion targets `three`, not `one` | Confirmed against the retained baseline's `declaredConstructs` (`ordering:quote_requested_three.after_any`, `ordering:quote_requested_zero.after_any` — exactly two). Corrected to `target_event: quote_requested_three`, `max_finding_count: 1`, with the derivation written out. The "three ordering constraints" claim is removed | §8 (003) |
| T-4 | QLB-EXT-002 permitted a `missing_required_property` finding that `C-VALID` does not imply when the carrier event is absent | Tightened to `permitted_additional_types: []`, `max_finding_count: 1`. The tolerant variant is named as an operator policy choice, not as contract semantics | §8 (002) |
| T-5 | `artifact_hashes` was specified as "everything the subject wrote", which cannot include itself | Scope stated exactly: `capture.json`, `stimulus-identity.json`, and every `product-out/**` artifact; excluding `run-summary.json` itself and `.frozen` sidecars | §6.7, §10.6 |

### First review → revision 2 (retained)

| # | Review finding | Correction | Where |
|---|---|---|---|
| 1 | Oracle-absence scan forbids `expected`, which `C-VALID` must contain as `expected_path`; 001–004 would abort before sealing | Scan rewritten to campaign-specific identifiers only — expectation paths, expectation digests, campaign schema strings, precommit digest, scenario IDs. Generic words and status values are explicitly **not** scanned. The plan now states that the product *must* receive the customer's rule expectations, and that only the campaign oracle is withheld | §10.4 |
| 2 | Oracle not committed before product execution; the spike was licensed to revise expectations after observing Qualiber | `precommit.json` created and hashed **before any Qualiber execution, including the spike**, binding stimuli, contracts, expectations, comparator and scan-script digests, scenario definitions and coordinates. Amendment protocol added: a stimulus may be amended for failing to express the intended customer condition; an expectation may never be amended because the product disagreed. Both precommit versions publish | §10.1, §10.2, §19 |
| 3 | NC-4 doesn't break what it claims — sidecars travel with their files, and `stimulus-identity.json` sits outside the swapped subtree | Split into NC-4a (product-out only) and NC-4b (whole `qualiber/` subtree). Primary binding moved to the observation record's `retained_output_refs`, with the adapter's `artifact_hashes` as an independent second witness. Stated explicitly that `.frozen` sidecars alone catch nothing here | §10.6, §11 |
| 4 | QLB-EXT-005 accepts `tool_error_non_blocking`, which would mask an unexpected tool failure | Expectation tightened to exactly `not_run` + `notRunReason: config_invalid` + diagnostic naming `expected_path` + only `run-result.json` present + `SUBJECT_PRODUCT_CLI_REFUSED`. `tool_error_non_blocking` now **fails** the scenario. New classification `product_refusal_expected` added so campaign summaries stop reading a correct refusal as an operational failure | §8 (005), §10.7 |
| 5 | `must_contain` proves detection, not correctness, while the plan claims artifact agreement | Campaign declared an **outcome-correctness** campaign. Each scenario precommits `required_finding_types`, an explicit `permitted_additional_types` allowlist authored from contract semantics, a `target_event`, and `max_finding_count`. Any type outside required ∪ permitted, or a count over the bound, is a `disagree`. What is *not* evaluated is named | §7.1, §8, §16 |
| 6 | Contract materialization seam doesn't exist; `contractPath` takes a path but the adapter holds bytes, and cleanup ownership was unstated | `runProductValidation` gains a `contractBytes` option, mutually exclusive with `contractPath`, written into the scratch directory it already owns and already removes in `finally`. Byte-identity and cleanup tested. Wording corrected to "does not parse or interpret" | §6.5, §18 |
| S1 | Plan-skeleton refactor as a prerequisite touches the proven live generator too early | Removed from the critical path entirely. The second generator duplicates; extraction is an optional follow-up only if duplication proves unmaintainable | §18, §19 |
| S2 | File estimate inaccurate | Recounted: 8 new, 8 edited | §18 |
| S3 | "No network" overclaims | Replaced everywhere with "no `network-egress` capability requested, no brokered egress, and no HTTP operation intentionally performed; the local process remains unconfined" | §2, §6.1, §12 |
| S4 | Publication contradiction between publishing failures intact and not publishing partial scenarios | Resolved: a *verified* product disagreement publishes intact as admitted evidence; a missing record, failed offline verification or broken binding is quarantined under `failed-attempts/` as a failed attempt, never admitted as scenario evidence | §13, §15 |

Retained unchanged from revision 1, per review: separate Qualiber-owned validation entrypoint; no Qualiber core changes; no Lab package changes; request bodies through the real collector; `interact → report-residue`; no `network-egress` in the offline manifest; product artifacts rather than exit codes or terminal status; five scenarios with Wave 2 deferred; expected truth never in adapter inputs.

---

## 1. Executive objective

Establish, from outside Qualiber, that the product **discriminates between telemetry outcomes it is sold to discriminate between** — and that it refuses honestly when it cannot evaluate at all.

Today one thing is proven end to end: a *clean* journey against a real service produces `runStatus: clean` through the two public surfaces. A single passing case cannot distinguish "the product evaluated correctly" from "the product says clean". Wave 1 adds four more outcome classes driven entirely by **independently supplied input bytes**, compared against **expectations the operator record shows were committed before the product ran, and that the retained bytes show never reached it** — the second half is checkable, the first is asserted (§13.2).

Wave 1 succeeds when the product, driven only through `@qualgraph/collector` and `telemetrytest validate`, reports all three outcome classes (`clean`, `rule_violation_detected`, `inconclusive`) plus one exactly-specified operational refusal (`not_run` / `config_invalid`), each matching a precommitted Lab expectation, with every product artifact retained unmodified.

Five scenarios. Three deferred. No matrix, no sweep, no scoring.

---

## 2. Scope and non-goals

### In scope

- One new Qualiber-owned adapter entrypoint that validates a Lab-supplied telemetry stimulus against a Lab-supplied contract, through the same public surfaces the live baseline uses.
- Five Wave-1 scenarios (QLB-EXT-001 … 005), each an independent trusted-local observation run.
- A precommitted Lab-side oracle and a comparison convention producing `agree` / `disagree` / `unavailable`.
- Seven campaign negative controls that must fail in a specified way — exactly the seven in §11, and no others.
- One bounded evidence bundle, with failed attempts quarantined separately from admitted evidence.

### Explicitly out of scope

- Any change to Qualiber core (`src/**`). None is required; §17 makes needing one a stop condition.
- Any change to Reality Lab packages (`packages/**`).
- A generic command-runner, plugin system, scoring, certification, confinement, UI, or any Qualiber-specific semantic evaluator inside the Lab.
- Docker or environment provisioning. For the five controlled scenarios: **no `network-egress` capability is requested, no brokered egress occurs, and no HTTP operation is intentionally performed.** The adapter process nevertheless runs unconfined with the operator's own permissions under the `local-process` profile — it is not prevented from opening a socket, only given no reason and no grant to. The claim ceiling states this.
- Wave 2 (QLB-EXT-006 … 008) — specified in §9, unscheduled.
- Any claim of certification, independent assurance, confinement, production readiness, clean-checkout reproducibility, or correctness outside the tested scenarios.

### What the campaign claims about findings

This is an **outcome-correctness** campaign, bounded by what the oracle actually checks (§7.1): `runStatus`, the finding *type* set against a precommitted required set and allowlist, finding count against a precommitted bound, the target event where the product records one, and the adapter operation outcome. It does **not** evaluate finding severity, finding detail prose, finding ordering, evidence-pack contents, VQS scoring, or eligibility-gate behavior. Those are recorded and retained, never asserted upon.

---

## 3. Governing product/Lab boundary

| # | Rule | How it is checked in Wave 1 |
|---|---|---|
| 1 | Reality Lab is not over-engineered | Lab package diff is empty; the campaign is `docs/evidence/**` plus task-local scripts retained in the bundle |
| 2 | Qualiber is not reshaped for the Lab's convenience | Qualiber `src/**` diff is empty; the seam lives entirely under `adapters/erl2-subject/**` |
| 3 | The Lab tests Qualiber, not the reverse | Every expectation lives on the Lab side and is committed before the product runs |
| 4 | Same public surfaces as customers | `@qualgraph/collector`'s `CaptureAccumulator`, and one spawn of `telemetrytest validate --contract --capture --out` |
| 5 | Stimuli and expected truth belong to the Lab | Capture stimulus and contract are Lab-authored mounted bytes; expectations are Lab files never mounted |
| 6 | Qualiber and its adapter never receive the **campaign oracle** | Expectation files are absent from plan inputs, mounts and request bytes, verified by the scan in §10.4 |
| 7 | The adapter reports, it does not judge | Adapter quotes `runStatus` verbatim and composes no pass condition |
| 8 | Exit code is never a product verdict | Comparator reads `run-result.json`; exit code is recorded and never consulted |
| 9 | No hidden bug flags or scenario branches in core | The five scenarios differ **only** in mounted input bytes; adapter code path is identical across all five |
| 10 | Small ladder, not a broad campaign | Five scenarios, one run each, three deferred |

**Rule 6 restated precisely, because revision 1 got this wrong.** The product *must* receive the customer's rule expectations — that is what a contract is, and `expected_path` is a required field of it. What must never reach the product or its adapter is the **campaign oracle**: the expected `runStatus`, the expected finding types, the expected operation outcome, the scenario identity, and the precommit that binds them. §10.4 scans for those artifacts, not for words.

Rule 9 remains the strongest property here: **all five Wave-1 scenarios execute byte-identical adapter code and a byte-identical plan skeleton. Only two mounted files differ.**

---

## 4. Current proven baseline

### 4.1 Baselines — merged, verified 2026-08-17

Both integration branches have landed. These are the coordinates Wave 1 binds:

| Repository | Baseline ref | HEAD | Tree | Landed as |
|---|---|---|---|---|
| Reality Lab | `origin/main` | `69ace16fb7ee021dddbcf3fa70e4295c2e5a400b` | `89988e5588b04534316c73901e34c56861caa494` | PR #18 from `codex/v2-trusted-local-observation` |
| Qualiber | `origin/preprod` | `b07746e706c465f00f06c8fa25005fe9a7b1ba4b` | `b9a7c66fd83e80e8beb295f70bd7c6652131be72` | PR #369 from `feature/erl2-trusted-local-observation` |

Earlier revisions of this plan named the pre-merge branch tips (`6f6208e…`, `50178ad…`) and the original brief named earlier ones still (`561d782a…`, `6e7f5bbd…`). The latter pair is what the retained 2026-08-16 evidence bundle binds and remains correct **for that bundle**; it is not a baseline for this campaign.

**Checkout hygiene — mandatory.**

- **Implement on a fresh Qualiber worktree or branch cut from `b07746e`.**
- **Do not use the primary checkout at `/Users/karthik/Claude/Projects/Qualiber`.** It carries uncommitted work (33 paths at verification time), so a build from it would bind an adapter artifact whose provenance no coordinate describes — and `execution-lock.json` would record a clean tree that does not exist.
- **Provision the three Lab packages — `@erl2/adapter-sdk` (adapter peer), `@erl2/contracts` and `@erl2/integrity` (comparator) — from a clean Reality Lab checkout pinned to `69ace16`.** Mixing a package built from a dirty tree into a run whose evidence claims a pinned baseline is the same defect in the other repository.
- `execution-lock.json` binds both repositories' HEAD, tree **and** working-tree porcelain digest, so a dirty build surfaces in the evidence rather than being discovered later.

### 4.2 What the retained bundle proves

`docs/evidence/qualiber-trusted-local-product-run-20260816/` (117 files, 636 KB):

- One owner-trusted, unscored, development-tier local observation against a real OTel Demo `quote` service on `127.0.0.1:58113`.
- Operations `configure → interact → report-residue`, all `completed`; `terminal_status: observed_complete`; residue `clean`; cleanup complete.
- Three genuine `POST /getquote` requests; the collector captured the analytics envelope of the bodies as issued (one serialization, handed to both `fetch` and the collector).
- One spawn of `telemetrytest validate`; nine product artifacts retained unmodified with `.frozen` digest sidecars.
- `run-result.json` → `{"runStatus":"clean","collectorHealth":"healthy","findingCount":0,"ciExitCode":0,"blocking":false}`.
- Offline verification via `verifyTrustedLocalObservationRecord` passed pre-publication.
- Environment destroyed; independent residue scan retained.
- The adapter asserted no product verdict.

### 4.3 Why this baseline cannot be extended by environment faults

`JourneyRecorder.record()` (`src/pipeline.ts:79`) hands the collector each request **before** `fetch` (`src/adapter.ts:282` precedes `:290`). The captured event sequence is a function of `QUOTE_STEPS`, not of anything the service answers. Killing the service or corrupting its responses changes `http_observations` and can abort the run; it can never produce a missing, reordered or duplicated *event*. Hence stimulus bytes.

### 4.4 Product facts confirmed by source inspection

| Fact | Location |
|---|---|
| Statuses the adapter treats as "ran and reported": `clean`, `rule_violation_detected`, `inconclusive` | `adapters/erl2-subject/src/pipeline.ts:96` |
| Full vocabulary adds `not_run`, `tool_error_non_blocking` | `src/report/run-status.ts:23-24` |
| `notRun()` sets a machine-readable **`notRunReason`** alongside `runStatus: "not_run"`, always exit 0 | `src/report/run-status.ts:80-90` |
| An invalid contract → `notRun("config_invalid", …)`, exit 0 | `src/cli.ts:238-239`, `:229` |
| A contract failing the health check (absent `expected_path`) is refused before compilation, and the health diagnostic **names the field** | `src/cli.ts` CR-99 comment block |
| On a `not_run` path only `run-result.json` is written — the other five artifacts require `result` | `src/cli.ts:816-830` |
| `inconclusive` ⇔ unhealthy collector **or** zero eligible events | `src/validator/validate.ts:68-70` |
| An inconclusive run emits one `no_telemetry_observed` finding and marks every declared construct un-applied | `src/validator/validate.ts:75-105` |
| A body with no resolvable event name yields no raw event and degrades health | `src/collector/adapter.ts:111`, `:200` |
| Violation and clean both exit 0 in observe mode | `src/report/run-status.ts:150-168`, `src/cli.ts:848-850` |
| Finding types include `missing_required_event`, `wrong_order`, `duplicate_event`, `missing_required_property`, `property_type_mismatch`, `no_telemetry_observed` | `src/validator/types.ts:120-135` |
| Packs are built unconditionally after `validate()` — violation **and** inconclusive runs write all six artifacts | `src/cli.ts` (no status branch between `validate()` and `buildEvidencePack`) |

### 4.5 Lab facts confirmed by source inspection

| Fact | Location | Consequence |
|---|---|---|
| Plan input `role` is a free-form `Id` | `observation.schema.json` → `LocalObservationPlanInputV1` | New roles need **no Lab change** |
| `egress_policy` required, but its arrays have no `minItems` | same file, `EgressAllowlistPolicyV1` | A genuine deny-everything policy is expressible |
| Requested capabilities default to `manifest.required_broker_capabilities`; the plan must grant every requested one | `packages/core/src/adapter/host.ts:851`, `:417` | **Decides Option A vs B** (§5) |
| **An adapter-returned `{status:"failed"}` produces a `completed` record.** `complete()` sets `state: "completed"` and `response_status: result.envelope.status`, with an in-source comment that a completed record "has never meant the adapter succeeded" | `localObservation.ts:150-195` | **Decides the QLB-EXT-005 expectation.** The comparator must read `state` **and** `response_status`, in every scenario |
| `fail()` — the only path to record `state: "failed"` — is for host/execution faults, and carries `failure_code`, not an adapter error code | `localObservation.ts:199-218` | An adapter refusal never appears as `state: failed`; expecting it would fail every 005 run |
| The adapter's error is in the response envelope: `error: {code, owner, safe_message}` (snake_case) | `adapter.schema.json` → `AdapterResponseEnvelopeV2` | `SUBJECT_PRODUCT_CLI_REFUSED` is read from the envelope, not from `operation_outcomes` |
| **`response_envelope_hash` stores `result.envelope.core_hash`, not the envelope file's sha256.** Verified in the retained baseline: record `sha256:da6532e3…560c1b` = envelope `core_hash`; file sha256 is `sha256:0a24af24…0c661e` | `localObservation.ts:144`; measured against `docs/evidence/qualiber-trusted-local-product-run-20260816` | The envelope bind is four steps (§10.6). A file-digest comparison would fail on every correct run, and skipping the recompute would accept a stale declared hash |
| `cleanupOnly` is set **only** by `fail()` and `markAmbiguous()` | `localObservation.ts:217`, `:238` | An adapter-reported failure does **not** trigger cleanup-only mode; `report-residue` runs because it is the next planned operation |
| `terminal_status` derives from cleanup, not operation success | `localObservation.ts:434` | A refusal run can read `observed_complete`; the comparator must read the operation outcome, never the terminal status |
| Completed operation records carry **`retained_output_refs`**: `{path, media_type, byte_length, file_sha256, classification}` for every retained output, inside a hash-chained record bearing `observation_id` and `plan_hash` | `trusted-local-observation-record.json` (verified in the retained bundle) | **This is the binding that catches NC-4**; `.frozen` sidecars cannot |
| Bound inputs are digest-checked against the sealed plan before anything runs | `packages/cli/src/trustedLocalObservation.ts` | NC-5 comes free |
| `assertNoOracleFields` scans request bytes for judge-expectation field *names* | `packages/core/src/journey/oracle.ts:172`, `host.ts:849` | Necessary, not sufficient for the campaign oracle |

---

## 5. Architecture option comparison

### Option A — extend the existing live quote adapter

| Dimension | Assessment |
|---|---|
| Complexity | Low in code, high in meaning. The adapter's doc comment currently says one true thing; it would have to say "either that, or something else, depending on which mount exists." |
| Truthfulness of operation declarations | Damaged. `configure` reads `environment-endpoint`; a controlled run has no environment. Either `configure` is declared and does nothing real, or the operation list becomes conditional — and a manifest whose operations depend on which inputs happen to be mounted is not a declaration. |
| Truthfulness of capability declarations | **Structurally false, and enforced as such.** `host.ts:851` requests `manifest.required_broker_capabilities` by default; `assertLocalPlanScope` requires the plan to grant every requested capability. The shared manifest requires `network-egress`. Every offline scenario plan would therefore have to grant network to a run that issues no request — written into five retained bundles. |
| Risk of mixing two subject behaviors | High. The baseline's value is that it reads in one sitting. A second mode makes every future reader ask which path a bundle exercised, with the answer depending on plan inputs rather than the artifact. |
| Network falsely required offline | Yes. Decisive. |
| Baseline remains understandable | No. |
| Mode selection = disguised test flag | Yes — "if a capture mount is present, don't make HTTP requests" is a behavior switch keyed on test scaffolding, relocated from core to the adapter. |

**Verdict:** rejected, on Lab admission code rather than taste.

### Option B — a separate thin Qualiber validation adapter

| Dimension | Assessment |
|---|---|
| Additional files and maintenance | 8 new, 8 edited, all under `adapters/erl2-subject/**` (§18). No refactor of proven code on the critical path. |
| Duplication vs clarity | Favourable. Shared: `runProductValidation`, `locateProductCli`, the v2 gate, residue observation. Different: stimulus intake vs live HTTP — genuinely different, and *should* be separate. |
| Reuse without deep product imports | Satisfied. `pipeline.ts` imports `@qualgraph/collector` and resolves the CLI through the product `package.json`'s `bin.telemetrytest`. One small additive option (`contractBytes`, §6.5) is required and is the only edit to proven code. |
| Exact capability requirements | `write-run-output`, `write-adapter-workspace`, `read-subject-visible-input`. No `network-egress`. |
| Proportionality | An integration adapter, not a product modification. Adds no product behavior and no branch inside `src/**`. Qualiber gains a second way to be *observed*, not to *behave*. |

**Verdict:** recommended; conditionally approved on review.

### Option C — a generic command runner in Reality Lab

| Dimension | Assessment |
|---|---|
| Over-engineers the Lab? | Decisively. The adapter SDK deliberately offers no process execution (`pipeline.ts:22-24`). Adding one would be the largest capability expansion in the Lab, for five scenarios. |
| Weakens product ownership? | Yes. Entrypoints, capability requirements and refusal semantics would migrate from Qualiber's manifest into Lab configuration — the inversion principle 3 forbids. |
| Broader than needed? | Yes. "Run an arbitrary command" is an unbounded primitive under a profile that provides no confinement, needing its own threat model and qualification. |

**Verdict:** rejected. Do not build.

---

## 6. Recommended minimal seam

**Option B, sited inside `adapters/erl2-subject` as a second entrypoint and a second manifest.** One package, two honest artifacts.

### 6.1 Identity

| Property | Value |
|---|---|
| Adapter id | `qualiber-erl2-validation-subject` |
| Version | `0.1.0` |
| Artifact | `adapters/erl2-subject/dist/qualiber-erl2-validation-subject.mjs` |
| Manifest | `adapters/erl2-subject/certification/validation-adapter-manifest.v2.json` |
| Protocol / mode | `subject-adapter/v2`, `local_observation` only (existing `assertLocalObservation` gate) |
| Declared operations | `interact`, `report-residue` — nothing else |
| Broker capabilities | `write-run-output`, `write-adapter-workspace`, `read-subject-visible-input` |
| Egress | No `network-egress` capability requested; plan carries a deny-everything policy; no HTTP operation is intentionally performed. The process remains unconfined. |
| Declared entrypoint | `bin/qualiber-erl2-validation-subject` |

### 6.2 Lifecycle: `interact → report-residue`

**Chosen. No `configure`.** `configure` exists on the live adapter because there is an environment to point at. Here there is none, and the two mounts `interact` needs it reads itself — the same reasoning already recorded for why the live plan omits `start`/`stop`. A `configure` that re-reads a mount and reports that it read it is a fabricated environment step.

`report-residue` stays and stays honest: `runProductValidation` still creates and removes a `qualiber-erl2-validate-` scratch directory (`pipeline.ts:168`, `:252`), so the scan in `v2.ts:162` has something real to look for. It remains the frozen cleanup suffix (`cleanup: true`), which is what lets a failed `interact` (QLB-EXT-005) still reach cleanup.

### 6.3 Stimulus form — request bodies, not a pre-built capture

**The Lab supplies request stimuli (URL + method + exact body string), not a `TestRunCapture`.**

1. **It crosses both public surfaces.** A pre-built capture bypasses the collector and tests only the CLI, while the bundle would imply otherwise.
2. **It keeps QLB-EXT-004 honest.** "Degraded capture" is a *collector* outcome: a body with no resolvable event name returns `null` from `toRawEventFromParts`, records `unsupported_body_types_observed`, degrades health, and makes the validator inconclusive. Hand-authored into a capture file, it would be the Lab writing Qualiber-internal fields (`associationConfidence`, `eventClass`, `summary.health`) and then congratulating the product for reading them back.
3. **It keeps the stimulus in customer vocabulary.** A request body is what a browser sends; a `TestRunCapture` is a product-internal artifact the Lab has no business authoring.
4. **All eight scenarios reduce to stimulus bytes.**

Accumulator construction parameters (`browserContextId`, `workerIndex`, `testId`, `testRunId`, `ciRunId`) stay adapter-owned and mirror the live baseline: adapter configuration, not supplied truth.

### 6.4 Capture stimulus format (`erl2-capture-stimulus/v1`)

Mount `capture-stimulus`, file `stimulus.json`:

```json
{
  "schema_version": "erl2-capture-stimulus/v1",
  "journey_id": "erl2_ext_journey",
  "requests": [
    { "sequence": 1,
      "path_and_query": "/getquote?erl2_step=1",
      "method": "POST",
      "body_text": "{\"numberOfItems\":1,\"event\":\"quote_requested_one\",\"properties\":{\"numberOfItems\":1}}" }
  ]
}
```

- `body_text` is handed to `onRawRequest` **as the exact string supplied** — never parsed, re-serialized, normalized or repaired. This is what makes a malformed-JSON stimulus a genuine product input rather than an adapter error.
- URL composed as `http://erl2-stimulus.invalid` + `path_and_query`, matching the collector's `**/getquote*` glob and unmistakably non-routable. No request is issued: no `fetch`, no `attemptEgress`, no socket.
- `markStep("step-<sequence>")` before each `onRawRequest`, matching the live recorder.
- Requests are fed in array order; the adapter preserves and does not sort.
- Bounds (adapter-owned, refusal on breach): file ≤ 256 KiB, ≤ 64 requests, each `body_text` ≤ 16 KiB, `method` ∈ {`POST`}, `path_and_query` ≤ 2048 chars starting with `/`.
- `journey_id` is Lab-supplied and passed to `startJourney`. The Lab's contract must name the same journey; if they disagree the product reports whatever it reports, which is a real customer situation.

### 6.5 Contract stimulus and its materialization seam

Mount `contract-stimulus`, file `contract.json`.

The adapter obtains the bytes through `context.readInput`, which yields a `Buffer`, not a path. `runProductValidation` currently accepts only `contractPath` (`pipeline.ts:129`) and creates its own scratch directory afterwards (`:168`). Revision 1 asserted the mounted bytes could simply be "written into the scratch directory because `contractPath` exists" — that seam does not exist, and cleanup ownership was unstated.

**Correction — the smallest honest change:**

- Add `contractBytes?: Buffer` to `RunProductValidationOptions`, **mutually exclusive** with `contractPath`; supplying both is a programming error and throws.
- When `contractBytes` is given, `runProductValidation` writes those exact bytes to `<its own scratch>/contract.json` and passes that path to `--contract`. The scratch directory is created and removed by the function that already owns it (`mkdtempSync` at `:168`, `rmSync` in the `finally` at `:252`), so cleanup ownership is unchanged and unambiguous — including on every refusal and throw path.
- Tests: bytes written are byte-identical to bytes supplied; the scratch directory is removed after a reported run, after a refused run, and after a thrown error; the two options are mutually exclusive.

The adapter checks **presence and byte length only** (≤ 64 KiB). It **does not parse or interpret** the contract — it reads the bytes, because it must in order to pass them on, and inspects no field, validates no shape, and makes no decision from their content. That is what makes QLB-EXT-005 meaningful: an invalid contract reaches the CLI and is refused **by the product**, producing `SUBJECT_PRODUCT_CLI_REFUSED`, never a subject-side contract rejection.

### 6.6 Adapter refusal codes (all subject-owned, all operational)

| Code | Outcome | Meaning |
|---|---|---|
| `SUBJECT_CAPTURE_STIMULUS_ABSENT` | `unsupported` | mount or file missing |
| `SUBJECT_CAPTURE_STIMULUS_MALFORMED` | `failed` | stimulus **envelope** unparsable or outside declared bounds |
| `SUBJECT_CONTRACT_STIMULUS_ABSENT` | `unsupported` | mount or file missing |
| `SUBJECT_CONTRACT_STIMULUS_TOO_LARGE` | `failed` | contract bytes exceed the mount ceiling |
| `SUBJECT_PRODUCT_CLI_REFUSED` | `failed` | the product ran and refused to evaluate; reason quoted verbatim from `pipeline.ts` |

`SUBJECT_CAPTURE_STIMULUS_MALFORMED` applies to the envelope only. A `body_text` that is not valid JSON is a valid stimulus and must be forwarded.

### 6.7 What the adapter writes

```
qualiber/capture.json                  # the collector's output for this stimulus
qualiber/product-out/<every CLI artifact, unmodified>
qualiber/run-summary.json              # schema qualiber-erl2-validation-run-summary/v1
qualiber/stimulus-identity.json        # sha256 + byte length of both mounted files, as read
```

`run-summary.json` carries `run_status` quoted from `run-result.json`, `exit_code`, `completed`, `refusal_reason` when refused, `artifact_hashes`, and the `subject_role` sentence. No expectation, no comparison, no pass field.

**`artifact_hashes` scope, stated exactly** (revision 2 said "everything the subject wrote", which cannot include the file itself):

- **Included:** `qualiber/capture.json`, `qualiber/stimulus-identity.json`, and every `qualiber/product-out/**` artifact.
- **Excluded:** `run-summary.json` itself (a file cannot carry its own digest), and every `.frozen` sidecar (host-written, not subject-written).

That set is exactly what NC-4a and NC-4b need, and it is achievable — the live adapter already builds its hash map from the `written` map before emitting the summary separately (`adapter.ts:335-373`).

---

## 7. First-wave scenario matrix

| ID | Short name | Capture stimulus | Contract | Expected `runStatus` | Required finding types | Adapter operation | Exit code |
|---|---|---|---|---|---|---|---|
| QLB-EXT-001 | clean baseline | 3 events, correct order, numeric props | `C-VALID` | `clean` | none (count 0) | `completed` / `supported` | 0 |
| QLB-EXT-002 | missing required event | 2 events, `…_zero` omitted | `C-VALID` | `rule_violation_detected` | `missing_required_event` ×1 | `completed` / `supported` | 0 |
| QLB-EXT-003 | wrong order | `three` before `one` | `C-VALID` | `rule_violation_detected` | `wrong_order` ×1 on `…_three` | `completed` / `supported` | 0 |
| QLB-EXT-004 | degraded capture | 3 requests, no `event` field | `C-VALID` | `inconclusive` | `no_telemetry_observed` ×1 | `completed` / `supported` | 0 |
| QLB-EXT-005 | invalid contract refusal | identical bytes to 001 | `C-INVALID` | `not_run` / `config_invalid` | n/a — no evaluation | `completed` / **`failed`**, envelope `SUBJECT_PRODUCT_CLI_REFUSED` | 0 |

The operation column is `record state` / `response_status`. Only 005 differs, and it differs in the second field, not the first: the Lab records a completed exchange carrying the adapter's own `failed` verdict.

**Byte economy.** Two contracts total: `C-VALID` mounted by 001–004 with one sha256, `C-INVALID` by 005. Four capture stimuli, with 001's bytes reused verbatim by 005. Every inter-scenario difference is one changed mount, recorded in the precommit.

### 7.1 Finding-set discipline (replaces `must_contain`)

Each scenario precommits four fields. The comparator evaluates all four:

| Field | Meaning | Failure |
|---|---|---|
| `required_finding_types` | Every type here must appear | Missing → `disagree` |
| `permitted_additional_types` | Explicit allowlist, authored from the Lab's own contract semantics, empty unless justified | Any observed type outside required ∪ permitted → `disagree` |
| `target_event` | The event the required finding must name, where the product records one in `detail` | Mismatch → `disagree`; product not recording an event → recorded as `not_stated`, not a failure |
| `max_finding_count` | Upper bound on total findings | Exceeded → `disagree` |

Each `permitted_additional_types` entry carries a one-line written justification in the precommit, derived from the contract the Lab authored — never from Qualiber's behavior, never from its fixtures. If Wave 1 observes something outside the precommitted bounds, that is published as a `disagree` with the observed set recorded verbatim. It is **not** silently absorbed, and the precommit is **not** amended afterwards.

**What this does and does not claim.** It claims the product produced the right outcome class and the right kind of finding about the right event, within a bound the Lab set in advance. It does not claim anything about severity, detail prose, finding order, evidence-pack contents, scoring or eligibility.

### 7.2 Contract `C-VALID` (Lab-authored, customer-shaped)

```json
{
  "rule_contract_version": "erl2_ext_journey_v1",
  "rule_id": "erl2_ext_journey",
  "journey_id": "erl2_ext_journey",
  "source": "reality_lab_external_campaign",
  "owner": "reality_lab_external_campaign",
  "mode": "observe",
  "severity": "medium",
  "event_aliases": { "quote_requested_one": ["quote_requested_one"],
                     "quote_requested_three": ["quote_requested_three"],
                     "quote_requested_zero": ["quote_requested_zero"] },
  "expected_path": ["quote_requested_one", "quote_requested_three", "quote_requested_zero"],
  "optional_events": [],
  "occurrence_bounds": { "quote_requested_one": {"min":1,"max":1},
                         "quote_requested_three": {"min":1,"max":1},
                         "quote_requested_zero": {"min":1,"max":1} },
  "required_properties": { "quote_requested_one": {"numberOfItems":"number"},
                           "quote_requested_three": {"numberOfItems":"number"},
                           "quote_requested_zero": {"numberOfItems":"number"} },
  "forbidden_events": [], "property_consistency": [], "known_unknowns": [],
  "approved_by": "reality_lab_external_campaign_owner",
  "approved_at": "<campaign date>T00:00:00Z",
  "approved_for_version": "erl2_ext_journey_v1"
}
```

`expected_path` is a required customer field and is *supposed* to reach the product. It is not campaign-oracle material, and §10.4 does not scan for it.

**`C-INVALID`** — identical except `expected_path` is **absent**: a structurally meaningful defect in a required journey rule field, in a real file at a real mount. Not a missing path, not an empty file, not a non-JSON blob.

---

## 8. Full specification — QLB-EXT-001 … 005

Common to all five:

- **Adapter:** byte-identical artifact across all five runs; sha256 recorded in the precommit.
- **Plan:** `interact → report-residue`; two host-provisioned inputs; deny-everything egress policy; three capabilities; fresh UUIDv7 observation id; fresh output root.
- **Required product outputs when the product reports:** `run-result.json`, `report.json`, `report.md`, `report.junit.xml`, `evidence-pack.json`, `validation-evidence-pack.json`, plus the eligibility and decision-snapshot files the CLI emits.
- **Offline verification:** `verifyTrustedLocalObservationRecord` over record, sealed plan, registry, artifact and inputs directory, before the scenario is admitted.
- **Residue/cleanup:** `report-residue` at `final` reports `clean` with zero named paths; `cleanup.status: cleanup_complete`.
- **Evidence root:** `docs/evidence/qualiber-product-scenarios-<YYYYMMDD>/scenarios/<ID>/`.

---

### QLB-EXT-001 — clean baseline

**Customer question.** "If my app emits exactly the journey my contract describes, does the tool stay quiet?"
**Risk.** A tool that reports violations on correct telemetry is unusable. This anchors the first half of the discrimination claim.

**Capture stimulus** (`stimulus-001.json`):

| seq | path_and_query | body_text |
|---|---|---|
| 1 | `/getquote?erl2_step=1` | `{"numberOfItems":1,"event":"quote_requested_one","properties":{"numberOfItems":1}}` |
| 2 | `/getquote?erl2_step=2` | `{"numberOfItems":3,"event":"quote_requested_three","properties":{"numberOfItems":3}}` |
| 3 | `/getquote?erl2_step=3` | `{"numberOfItems":0,"event":"quote_requested_zero","properties":{"numberOfItems":0}}` |

**Contract.** `C-VALID`. **Bytes:** this scenario is the byte baseline; contract shared with 002–004, capture reused verbatim by 005.

**Precommitted oracle:**

```json
{ "scenario_id": "QLB-EXT-001",
  "expected_operation_state": "completed",
  "expected_response_status": "supported",
  "expected_run_status": "clean",
  "required_finding_types": [],
  "permitted_additional_types": [],
  "permitted_additional_justification": {},
  "target_event": null,
  "max_finding_count": 0,
  "expected_product_reported": true }
```

`max_finding_count: 0` is deliberate and strict: `clean` also covers a run whose findings all rolled up to `info` (`run-status.ts` CR-108), so a `clean` with `findingCount > 0` is a materially different result and must not pass silently.

**Expected.** `runStatus: clean`; zero findings; adapter `completed`/`supported`; exit `0`, recorded only. All six artifacts present.
**Evidence, verification, residue.** As common.
**Negative-control coverage.** The campaign's executed controls are exactly the seven in §11, and this scenario is covered by **NC-2**, which deletes its `run-result.json` and must yield `unavailable`. *Illustrative only, not executed:* a counterfactual flipping this expectation to `rule_violation_detected` would show the comparator is not hard-wired to agree with a clean run. Making it real would require an eighth named control with a stage-1 precommitted counterfactual; it is deliberately not smuggled in here.
**Failure ownership.** `runStatus ≠ clean` → **product disagreement** (re-read the stimulus first; the Lab authored it). `clean` with findings → **product disagreement**, count bound. Adapter `failed`/`unsupported` → **adapter operational failure**. Record missing / verification failed / binding broken → **Lab-harness failure**, quarantined. `run-result.json` absent → **unavailable**.

---

### QLB-EXT-002 — missing required event

**Customer question.** "If my app silently stops emitting a required event, will I be told?"
**Risk.** The most common real telemetry regression.

**Capture stimulus** (`stimulus-002.json`): requests 1 and 2 from 001, byte-identical; request 3 omitted.
**Contract.** `C-VALID`, same sha256. **Differs from 001** by exactly one removed array element.

**Precommitted oracle:**

```json
{ "scenario_id": "QLB-EXT-002",
  "expected_operation_state": "completed",
  "expected_response_status": "supported",
  "expected_run_status": "rule_violation_detected",
  "required_finding_types": ["missing_required_event"],
  "permitted_additional_types": [],
  "permitted_additional_justification": {},
  "target_event": "quote_requested_zero",
  "max_finding_count": 1,
  "expected_product_reported": true }
```

**Why the allowlist is now empty.** Revision 2 permitted a second `missing_required_property` finding, reasoning that `C-VALID` declares required properties for the absent event. On review that reasoning does not hold: a property constraint attached to an event does not, from contract semantics alone, establish that a separate property finding *should* exist when there is no carrier event to attach it to. Asserting it would have been the Lab guessing at product internals under the guise of contract derivation. The strict form — exactly one finding — is what `C-VALID` actually supports.

If the product does emit a secondary property finding, that is a `disagree` published with the observed set, and the campaign owner may then decide, as an explicit **operator policy** recorded in an amendment of class `oracle_error_independent_of_product`, that redundant secondary findings are tolerable. That would be a policy choice stated as one — never presented as something `C-VALID` implied.

**Expected.** `rule_violation_detected`; exactly one `missing_required_event` naming `quote_requested_zero`; record `state: completed` with `response_status: supported` — **a reported violation is a supported outcome, not an adapter failure**; exit `0`, never read.
**Negative control (scenario-local).** NC-3 lands here: `recorded_exit_code: 0` and `run_status: rule_violation_detected` and `verdict: agree`, simultaneously.
**Failure ownership.** `clean` → **product disagreement**, severe (a missed regression). `inconclusive` → **product disagreement**, distinct sub-case: the product declined to evaluate telemetry it should have evaluated; record `collectorHealth` and `inconclusiveReason` before attributing. A finding type outside required ∪ permitted, or count > 1 → **product disagreement**, published with the observed set. `response_status` other than `supported` → **adapter operational failure**.

---

### QLB-EXT-003 — wrong order

**Customer question.** "If my events arrive out of order, does the tool notice, or does it only count them?"
**Risk.** Order separates a sequence validator from a set-membership checker, and is what `expected_path` claims to enforce.

**Capture stimulus** (`stimulus-003.json`): the same three `body_text` strings as 001 with positions 1 and 2 swapped — `three`, `one`, `zero`. `path_and_query` follows emission order. **Same bytes, different order, different verdict** — the sharpest control in the wave.
**Contract.** `C-VALID`, same sha256.

**Precommitted oracle:**

```json
{ "scenario_id": "QLB-EXT-003",
  "expected_operation_state": "completed",
  "expected_response_status": "supported",
  "expected_run_status": "rule_violation_detected",
  "required_finding_types": ["wrong_order"],
  "permitted_additional_types": [],
  "permitted_additional_justification": {},
  "target_event": "quote_requested_three",
  "max_finding_count": 1,
  "expected_product_reported": true }
```

**Derivation, corrected.** Revision 2 claimed three ordering constraints and named `quote_requested_one` as the target. Both were wrong. `C-VALID`'s `expected_path` has three states, so it yields **two** predecessor-ordering constraints — one for each non-initial state. Against the stimulus `three, one, zero`: `quote_requested_three` occurs before its required predecessor `quote_requested_one`, violating its constraint; `quote_requested_zero` still follows both, so its constraint holds. Exactly one inversion, and the event out of position is **`quote_requested_three`**. The retained 2026-08-16 baseline corroborates the constraint count independently — its `declaredConstructs` list exactly `ordering:quote_requested_three.after_any` and `ordering:quote_requested_zero.after_any`.

Left uncorrected, this expectation would have turned a correct product result into a false disagreement — the campaign's worst possible failure mode, since it would have been published as a finding against the product.

If the product names the counterpart (`quote_requested_one`) instead, the comparator reports `disagree` with sub-reason `target_event_counterpart`, so the difference is legible as a labelling question rather than a bare mismatch. It is not silently accepted: the Lab asserted a target and either holds to it or reports that it did not hold.

**Expected.** `rule_violation_detected`; exactly one `wrong_order` naming `quote_requested_three`; `state: completed` / `response_status: supported`; exit `0`.
**Negative control (scenario-local).** NC-1 lands here, run against the precommitted counterfactual `NC-1.counterfactual.expected.json` (this expectation with `expected_run_status: clean`) rather than by editing `expected.json` — which NC-1b separately proves the binding gate rejects.
**Failure ownership.** `clean` → **product disagreement**, high severity: not order-sensitive despite an `expected_path` contract. Violation without `wrong_order` → **product disagreement**: detected but mischaracterized; record the actual types and never restate as a pass.

---

### QLB-EXT-004 — degraded / unclassifiable capture

**Customer question.** "If my instrumentation breaks and the tool can't see my events, does it say so — or report green?"
**Risk.** The worst failure mode in the category. Qualiber's own `health-report.ts` names it ("a run that passes while measuring nothing"); this tests that claim from outside.

**Capture stimulus** (`stimulus-004.json`): three requests to the same endpoint, valid JSON, plausible payloads, **no `event` key**:

| seq | body_text |
|---|---|
| 1 | `{"numberOfItems":1,"properties":{"numberOfItems":1}}` |
| 2 | `{"numberOfItems":3,"properties":{"numberOfItems":3}}` |
| 3 | `{"numberOfItems":0,"properties":{"numberOfItems":0}}` |

`toRawEventFromParts` returns `null`, the accumulator records `unsupported_body_types_observed`, health degrades, zero eligible events reach the validator, and `validate.ts:70` goes inconclusive on both legs at once.
**Contract.** `C-VALID`, same sha256. **Differs from 001** by exactly the removal of `"event"` from each body.

**Precommitted oracle:**

```json
{ "scenario_id": "QLB-EXT-004",
  "expected_operation_state": "completed",
  "expected_response_status": "supported",
  "expected_run_status": "inconclusive",
  "forbidden_run_status": ["clean"],
  "required_finding_types": ["no_telemetry_observed"],
  "permitted_additional_types": [],
  "permitted_additional_justification": {},
  "target_event": null,
  "max_finding_count": 1,
  "expected_product_reported": true,
  "requires_inconclusive_reason": true }
```

**Expected.** `inconclusive`, **never `clean`** — `forbidden_run_status` forces `disagree` on a clean result regardless of anything else. Exactly one `no_telemetry_observed` finding (the inconclusive arm emits one). `requires_inconclusive_reason` demands that `run-result.json` carry a non-empty `inconclusiveReason` or `collectorHealth` — the "evidence explains why" requirement satisfied from the product's own bytes, not a Lab narrative. Adapter `completed`/`supported`; exit `0`; all six artifacts present.
**Evidence.** Additionally retain `capture.json`, whose `summary` block carries the collector's own health determination.
**Negative-control coverage.** The campaign's executed controls are exactly the seven in §11, none of which targets this scenario. *Illustrative only, not executed:* a counterfactual flipping this expectation to `clean` would exercise the `forbidden_run_status` branch, which is otherwise proven only by its own specification. Making it real would require an eighth named control with a stage-1 precommitted counterfactual — a deliberate deferral, recorded here so the gap is visible rather than implied away.
**Failure ownership.** `clean` → **product disagreement**, highest severity in the wave: green on zero measurement. `rule_violation_detected` → **product disagreement**: "I could not see" converted into "you did wrong". `inconclusive` with no reason recorded → **product disagreement**, partial: honest status, unusable diagnosis.

---

### QLB-EXT-005 — invalid contract refusal

**Customer question.** "If I hand the tool a broken contract, does it refuse — or guess and give me a verdict I'll trust?"
**Risk.** A validator that evaluates against an unusable rule produces confident nonsense. Refusal is correct and must be distinguishable from every scenario outcome.

**Capture stimulus.** `stimulus-001.json`, **byte-identical, same sha256** — the only variable is the contract.
**Contract stimulus.** `C-INVALID`, `expected_path` absent.

**Precommitted oracle — exact, no alternatives accepted:**

```json
{ "scenario_id": "QLB-EXT-005",
  "expected_operation_state": "completed",
  "expected_response_status": "failed",
  "expected_envelope_error_code": "SUBJECT_PRODUCT_CLI_REFUSED",
  "expected_envelope_error_owner": "subject",
  "expected_run_status": "not_run",
  "expected_not_run_reason": "config_invalid",
  "expected_diagnostic_names_field": "expected_path",
  "expected_present_artifacts": ["run-result.json"],
  "expected_absent_artifacts": ["report.json", "report.md", "report.junit.xml",
                                "evidence-pack.json", "validation-evidence-pack.json"],
  "expected_product_reported": false,
  "classification": "product_refusal_expected" }
```

`tool_error_non_blocking` is **not** accepted. Revision 1 accepted it; that was wrong. For a known-good capture and a contract missing exactly one required field, `tool_error_non_blocking` would signal an unexpected capture or tool failure — a different defect wearing the same shape — and must fail the scenario, not satisfy it.

**Expected product behavior in detail.** `importContractJson` succeeds; the contract health check refuses on the absent `expected_path`, naming the field; the CLI returns `notRun("config_invalid", …)` at exit 0 with a machine-readable `notRunReason` (`run-status.ts:80-90`). Because `result` is undefined, only `run-result.json` is written — the other five artifacts are legitimately absent, and the comparator asserts their absence rather than tolerating it.

The diagnostic check reads `customerVisibleMessage` from `run-result.json` and requires the substring `expected_path`. If the product refuses correctly but does not name the field, the comparator reports `disagree` with sub-reason `refusal_diagnostic_unspecific` — a real usability finding about the product, not a harness fault.

**Expected Lab-side record — corrected.** Revision 2 expected `operation_outcomes[].state: "failed"` and read the error code from the outcome. That is not what the Lab writes. `host.run()` returns a response envelope successfully, so the coordinator calls `complete()`, which sets `state: "completed"` and `response_status: result.envelope.status` — the adapter's own verdict, deliberately kept distinct from the record state (`localObservation.ts:150-195`, comment in source). Record `state: "failed"` comes only from `fail()`, which is for a thrown host or execution fault and carries a `failure_code`, not an adapter error code. The revision-2 expectation would therefore have failed every correct 005 run.

The expected evidence is:

| Field | Location | Expected |
|---|---|---|
| `state` | `operation_outcomes[]` where `operation === "interact"` | `completed` |
| `response_status` | same entry | `failed` |
| `error.code` | the **retained response envelope**, `/error/code` | `SUBJECT_PRODUCT_CLI_REFUSED` |
| `error.owner` | same envelope | `subject` |
| `error.safe_message` | same envelope | quotes `pipeline.ts`'s refusal reason |
| `runStatus`, `notRunReason` | `run-result.json` | `not_run`, `config_invalid` |
| `terminal_status` | record root | `observed_complete` remains plausible and is not asserted |

The error code is **not** present in `operation_outcomes`. The comparator must locate the retained response envelope for that operation and bind it in the four steps of §10.6 — file bytes against the `.frozen` sidecar; parse and schema-check as `AdapterResponseEnvelopeV2`; recompute `coreHash(envelope)`; then require `recomputed === envelope.core_hash === operation.response_envelope_hash` — before reading `/error/code`. **`response_envelope_hash` is the envelope's `core_hash`, not the file's sha256** (`localObservation.ts:144`); the two are entirely different values in the retained baseline, so comparing the file digest would fail on every run. Note the envelope uses snake_case `safe_message`, unlike the SDK outcome's `safeMessage`.

`not_run ∉ REPORTED_STATUSES`, so the adapter's refusal branch precedes the artifact-completeness check and the absent reports are never misreported as incomplete output.

**Exit code.** `0` — the clearest demonstration in the wave that exit code carries no verdict: exit 0, no evaluation, operational refusal.

**Classification.** `product_refusal_expected`, **not** `adapter_operational_failure`. Revision 1 filed the correct anticipated refusal under operational failure, which would have made every campaign summary read as though something broke. The two are now distinct, and only `product_refusal_expected` counts toward wave success.

**Run-level consequences — corrected.** Revision 2 said the failed `interact` activates cleanup-only mode. It does not: `cleanupOnly` is set solely by `fail()` and `markAmbiguous()` (`localObservation.ts:217`, `:238`), and this operation produces a *completed* record. `report-residue` runs for the ordinary reason — it is the next, and only remaining, planned operation. `terminal_status` may still read `observed_complete`, because completeness derives from cleanup rather than from operation success (`:434`), and because `cleanupResult()` consults `stop`/`install`/`compensate` and residue, none of which this scenario engages.

**The comparator reads `state` and `response_status` from `operation_outcomes`, and the error code from the bound response envelope. It never infers refusal from `terminal_status`.** This is the most likely misreading in the campaign and is repeated in the checklist.

**Evidence, verification, residue.** As common, plus the `C-INVALID` bytes verbatim and the adapter's retained error envelope. Offline verification must pass — a failed operation is a valid, verifiable record. Residue `clean`; `runProductValidation`'s `finally` removes the scratch on the refusal path too.
**Failure ownership.** Product evaluates anyway and reports any status → **product disagreement**, severe. `tool_error_non_blocking` → **disagree**, sub-reason `unexpected_failure_class`, investigated as a possible capture or tool defect. Adapter refuses before spawning the CLI → **adapter operational failure** and a design regression (someone made it parse the contract); the scenario proves nothing until fixed.

---

## 9. Deferred specification — QLB-EXT-006 … 008 (Wave 2)

**Not scheduled. Blocked on Wave 1 passing every acceptance criterion in §16.** Deferral is not about effort — each is a one-file stimulus change — but about not multiplying whatever is wrong with an unproven seam.

| ID | Short name | Stimulus change from 001 | Expected `runStatus` | Expected finding | Discrimination added |
|---|---|---|---|---|---|
| QLB-EXT-006 | duplicate required event | `quote_requested_one` emitted twice (4 requests) | `rule_violation_detected` | `duplicate_event` | Wave 1 tests presence and order; this tests **cardinality** (`occurrence_bounds.max = 1`). A validator checking membership and sequence can still miss a double-fire — retry loops, double-mounted handlers. |
| QLB-EXT-007 | missing required property | `numberOfItems` removed from within `properties` on `quote_requested_three`, `properties` object retained | `rule_violation_detected` | `missing_required_property` | Wave 1 tests event-level structure; this tests **payload-level** enforcement. First scenario where the sequence is perfect and the defect is inside a body. |
| QLB-EXT-008 | wrong property type | `"numberOfItems":"3"` (string) on `quote_requested_three` | `rule_violation_detected` | `property_type_mismatch` | Tests **type** enforcement. A validator can check key presence without checking declared types; that gap passes 007 and fails here. |

**Note on 007.** Qualiber's own reference-oracle test records that a *carrier-absent* required-property case surfaces as `missing_required_event` on the carrier. The stimulus above deliberately retains the `properties` object and removes only the key inside it, which is the narrower test and avoids the ambiguity. The Wave-2 precommit is authored from `C-VALID`'s `required_properties` semantics — never from that fixture, which is Qualiber's own expected truth and disqualified as a Lab oracle.

Wave 2 requires **zero** new adapter code, plan machinery or comparator logic — three stimulus files and three expectation files. That property is itself a Wave-1 acceptance signal: if Wave 2 would need code, the seam was built wrong.

---

## 10. Independent oracle design

### 10.1 Two-stage commitment — the oracle is fixed before the product runs

Revision 2 used a single `precommit.json` that bound the adapter artifact and manifest digests. That was circular and unsatisfiable: those artifacts are not built until steps 3–6, while the precommit was required before the spike at step 2. It also required observation IDs that the plan generator mints later still. The property worth preserving — **expectations fixed before Qualiber runs** — does not need either.

Two small commitments, each binding only what exists when it is written.

**Stage 1 — `oracle-precommit.json`, before the spike, before any Qualiber execution against campaign inputs:**

```json
{
  "schema_version": "qualiber-reality-lab/oracle-precommit/v1",
  "campaign": "qualiber-product-scenarios-<YYYYMMDD>",
  "revision": 1,
  "qualiber_baseline": { "branch": "…", "head": "…", "tree": "…",
                         "note": "the checkout the spike will exercise" },
  "scenarios": [
    { "scenario_id": "QLB-EXT-001",
      "capture_stimulus_sha256": "sha256:…", "capture_stimulus_bytes": 512,
      "contract_stimulus_sha256": "sha256:…", "contract_stimulus_bytes": 1180,
      "expectation_sha256": "sha256:…",
      "definition": "three declared events in contract order, numeric numberOfItems" }
  ],
  "tooling": { "compare_scenario_mjs_sha256": "sha256:…",
               "oracle_absence_scan_mjs_sha256": "sha256:…",
               "compare_scenario_test_mjs_sha256": "sha256:…",
               "tooling_test_result_sha256": "sha256:…" },
  "negative_controls": [
    { "control_id": "NC-1", "targets_scenario": "QLB-EXT-003",
      "counterfactual_expectation_sha256": "sha256:…",
      "definition": "003's expectation with expected_run_status set to clean; must disagree" }
  ],
  "amendments": []
}
```

Binds: every stimulus and contract digest; every `expected.json` digest; every negative-control counterfactual digest in the `negative_controls` block; all three tooling digests plus the tooling test result — authored and tested at step 0a, *before* this file is written; each scenario's definition in words; and the Qualiber baseline the spike exercises. It binds **no** adapter artifact, **no** manifest, and **no** observation ID, because none exists yet.

**Stage 2 — `execution-lock.json`, after implementation and build, before the first official Lab run:**

```json
{
  "schema_version": "qualiber-reality-lab/execution-lock/v1",
  "campaign": "qualiber-product-scenarios-<YYYYMMDD>",
  "oracle_precommit_sha256": "sha256:…",
  "oracle_precommit_revision": 1,
  "coordinates": { "qualiber": {"branch": "…", "head": "…", "tree": "…", "porcelain_sha256": "sha256:…"},
                   "reality_lab": {"branch": "…", "head": "…", "tree": "…", "porcelain_sha256": "sha256:…"} },
  "adapter": { "artifact_sha256": "sha256:…", "manifest_sha256": "sha256:…",
               "runtime_dependency_provenance_sha256": "sha256:…" },
  "comparator_dependencies": {
    "anchor": "adapters/erl2-subject/package.json",
    "resolved": [
      { "name": "@erl2/contracts", "version": "…", "entry_sha256": "sha256:…" },
      { "name": "@erl2/integrity", "version": "…", "entry_sha256": "sha256:…" }
    ]
  }
}
```

References the stage-1 digest and binds what now exists: final coordinates and working-tree status, the adapter artifact, its manifest, runtime dependency provenance, and the comparator's two resolved Lab packages (§10.3.1). It restates no stimulus or expectation digest — stage 1 owns those, and duplicating them would create two places to disagree.

**Observation IDs and sealed-plan hashes belong to neither.** They are minted per scenario at draft time and recorded in `campaign-index.json`, generated after sealing. Revision 2 required the record's `observation_id` to match a precommit entry, which was impossible by construction; the binding check now compares the record against that scenario's **sealed plan** and the campaign index, which is where the ID actually originates.

Both files' digests are recorded in the command log at the moment they are written.

### 10.2 Amendment protocol

The spike (§19 step 2) may reveal that a **stimulus failed to express the intended customer condition** — a typo, a body the collector matches differently than intended, a journey-id mismatch. That is a stimulus defect and may be corrected. It may **not** reveal that correctness is different from what was committed.

| Amendment class | Permitted | Requires |
|---|---|---|
| `stimulus_did_not_express_condition` | yes | the intended condition restated, what the stimulus actually expressed, and why the new bytes express it; expectation unchanged |
| `oracle_error_independent_of_product` | yes, narrowly | a written derivation from `C-VALID`'s own semantics showing the original expectation contradicted the contract the Lab authored, with **no reference to any observed Qualiber output** |
| `product_disagreed` | **forbidden** | — |

Amendments apply to `oracle-precommit.json`. Every amendment increments its `revision`, appends to `amendments[]`, and **both** versions are published with their digests; `execution-lock.json` then references the final revision and digest. An amendment made after a scenario has executed invalidates that scenario, which must be re-run from a fresh observation id. "The product did something else, so we changed the expectation" is the failure mode this protocol exists to make visible and impossible to do quietly.

The QLB-EXT-002 and QLB-EXT-003 corrections in revision 3 are the model for what a *legitimate* pre-execution correction looks like: both were derived from `C-VALID`'s own semantics, both were made before any campaign execution existed, and neither referenced observed Qualiber output. Had either surfaced after a run, class `oracle_error_independent_of_product` would have applied — and QLB-EXT-003's would have invalidated that scenario's run rather than quietly relabelling its result.

### 10.3 What the oracle is

A per-scenario `expected.json` plus one task-local script `campaign/compare-scenario.mjs`. Both live in the campaign working directory, are digest-bound by the precommit, and are retained inside the evidence bundle. **Neither is Lab product code**, following the retained-but-never-promoted precedent of `task-local-substrate.mjs` and `task-local-verify.mjs`.

No new Lab schema is minted. `oracle-precommit.json`, `execution-lock.json`, `expected.json` and `comparison.json` carry campaign-scoped `schema_version` strings. Adding a Lab contract for five scenarios would be formality for its own sake.

### 10.3.1 How the comparator resolves its two Lab packages

The comparator lives in campaign scratch and is published into the evidence bundle. `@erl2/contracts` and `@erl2/integrity` are installed under the **fresh Qualiber adapter checkout**, somewhere else entirely. Node resolves bare ESM specifiers relative to the importing module's location, not the shell's working directory, so a plain `import { coreHash } from "@erl2/integrity"` inside the comparator would fail with `ERR_MODULE_NOT_FOUND` however correctly the packages were provisioned. Revision 4.1 named the imports without saying how they resolve; that gap is closed here.

**Mechanism — explicit anchor, no ambient resolution.**

1. The comparator requires `--dependency-anchor <fresh-qualiber>/adapters/erl2-subject/package.json`. It is a required argument with no default: an anchor the script guessed would be an anchor nobody recorded.
2. It builds `createRequire(anchorPath)` (`node:module`) and calls `.resolve()` for each of the two package names, yielding absolute entrypoint paths inside the anchor's dependency tree.
3. It dynamically imports each resolved path via `pathToFileURL()` (`node:url`).
4. It reads each resolved package's `name` and `version` from its own `package.json`, and computes the sha256 of the resolved entrypoint file.
5. Any failure — anchor missing, anchor not a `package.json`, either package unresolvable — is a hard exit before any comparison. It is **not** a `verdict`, because no scenario was evaluated; it is a tooling failure that stops the campaign.

**Provenance binding.** `execution-lock.json` gains a `comparator_dependencies` block:

```json
"comparator_dependencies": {
  "anchor": "adapters/erl2-subject/package.json",
  "resolved": [
    { "name": "@erl2/contracts",  "version": "…", "entry_sha256": "sha256:…" },
    { "name": "@erl2/integrity",  "version": "…", "entry_sha256": "sha256:…" }
  ]
}
```

The anchor is recorded **repository-relative**, and the resolved absolute paths are recorded in the command log only — not in the lock. An absolute location on one machine is not portable evidence, which is the same reasoning the plan generator already applies to the operator's endpoint path.

**What this provenance does and does not establish.** Stated precisely, because an entrypoint digest is easy to over-read:

- Name, version and `entry_sha256` bind **the resolved entrypoint file**, and nothing further. They do not cover the package's internal modules: `@erl2/integrity`'s entrypoint (`dist/src/index.js`) only re-exports `coreHash` from `./hash/hash.js`, so the file that actually computes the hash is *not* covered by the entrypoint digest.
- The bound provisioning receipt (`runtime-dependency-provenance.json`, whose digest the lock carries) records the **pinned Lab commit** the packages were built from — `69ace16` — and the package tarball digests.
- Together these do **not** prove complete dependency closure, and they do **not** detect arbitrary post-install mutation of internal package files. A tampered `dist/src/hash/hash.js` would leave every recorded digest unchanged.
- That limitation is **accepted** under the trusted-local claim ceiling. The adapter and the comparator already run unconfined with the operator's own permissions; a campaign that could not trust its own filesystem would have larger problems than this one check, and closing the gap would mean a package-tree inventory or verified install — new assurance machinery Wave 1 does not need and must not grow. Should later assurance require it, it is a bounded addition to this section, not a redesign.

Every comparison re-resolves through the same anchor and asserts that the resolved name/version/entry-digest triples match `execution-lock.json`; a mismatch is `unavailable` / `lab_harness_failure`. That catches the realistic failure — a comparator silently resolving a *different installed copy* mid-campaign, producing verdicts from two hash implementations with nothing in the evidence to show it. It does not, and does not claim to, catch an edit inside an already-resolved package.

This keeps the comparator task-local, imports nothing from Qualiber, and modifies no Lab source.

| Constraint | How satisfied |
|---|---|
| Does not import Qualiber code | Reads JSON. Imports `node:fs`, `node:path`, `node:crypto`, `node:module`, `node:url` — plus exactly two generic Lab packages, `@erl2/contracts` (envelope schema) and `@erl2/integrity` (`coreHash`), resolved through the anchor in §10.3.1. Neither carries Qualiber semantics, and nothing from Qualiber is imported |
| Does not use Qualiber's test assertions | No vitest, no fixtures, no product helpers |
| Does not travel in the adapter request | Not a plan input; never bound, copied, mounted or referenced |
| Absent from mounted bytes | Enforced by §10.4 |
| Compares only documented product artifacts | `run-result.json`, `report.json`, and the observation record |
| Produces `agree` / `disagree` / `unavailable` | Single `verdict` field |
| Distinguishes disagreement from refusal | Separate `classification` field (§10.7) |
| Never converts adapter `supported` into a product pass | The verdict is a function of `run_status` and findings; operation state is compared independently and can never supply a product verdict alone |
| Records exact evidence references | Every observed value carries path, sha256 and JSON pointer |

### 10.4 Oracle-absence scan — corrected

**Revision 1's scan was wrong.** It forbade the substrings `expected`, `clean` and `verdict` in mounted bytes, which would have aborted 001–004 before sealing, because `C-VALID` necessarily contains `expected_path`. It also confused two different things. The product **must** receive the customer's rule expectations; that is what a contract is. What must be withheld is the **campaign oracle**.

The scan therefore targets campaign-specific identifiers only:

**Scanned for (a hit aborts the scenario):**
1. The scenario's `expected.json` path string, and any campaign-relative path under `expectations/` or `campaign/`.
2. The sha256 of `expected.json`, of `oracle-precommit.json` (every revision), of `execution-lock.json`, and of either task-local script — as hex, with and without the `sha256:` prefix.
3. The campaign schema identifiers: `qualiber-reality-lab/campaign-expectation/v1`, `.../campaign-comparison/v1`, `.../oracle-precommit/v1`, `.../execution-lock/v1`.
4. Campaign field names: `expected_run_status`, `required_finding_types`, `permitted_additional_types`, `expected_operation_state`, `forbidden_run_status`, `expected_not_run_reason`, `max_finding_count`.
5. Scenario identity strings: `QLB-EXT-001` … `QLB-EXT-008`.

**Explicitly not scanned for:** `expected_path` or any other contract field; the words `expected`, `clean`, `verdict`, `agree`, `oracle`; or any bare status value such as `rule_violation_detected` or `inconclusive`. Those are product and contract vocabulary, and scanning for them would either abort valid scenarios or be pure theatre.

**Where it runs:** over both mounted files before the plan is drafted; over the sealed plan bytes before the run; over the retained `run-output/inputs/**` tree and the adapter's retained `response-envelope.json` files after the run. A hit at any point is a **Lab-harness failure**, quarantines the scenario, and blocks the wave — an expectation that leaked into a product input makes every subsequent result suspect.

This complements but does not replace the Lab's `assertNoOracleFields`, which scans request bytes for judge-expectation field *names* and would not fire on a leaked campaign expectation.

### 10.5 Reading rules (normative)

1. `run_status` is read **only** from `…/product-out/run-result.json`, field `runStatus`; `notRunReason` and `inconclusiveReason` from the same file.
2. Finding types are read **only** from the sibling `report.json` at `result.findings[].type`; the target event from `result.findings[].detail.event` where present. If `report.json` is absent, finding types are `null` — "not stated" is not "none".
3. `ciExitCode` and the adapter's `exit_code` are **recorded** and never consulted by any branch that sets `verdict`. The script contains no comparison of any kind against an exit code.
4. The adapter's outcome is read from `operation_outcomes[]` where `operation === "interact"`, as **two** fields: `state` (the Lab's record of whether the exchange completed) and `response_status` (the adapter's own verdict — `supported`, `failed` or `unsupported`). Both are compared in every scenario. A `completed` record does not mean the adapter succeeded, and the source says so at `localObservation.ts:150-195`. **`terminal_status` is never used to classify a refusal.**
4a. An adapter error code is read from the **retained response envelope** for that operation, at `/error/code`, `/error/owner`, `/error/safe_message` — never from `operation_outcomes`, which does not carry it. The envelope must pass the four-step bind in §10.6 — bytes, shape, **recompute**, identity — before its contents are read; if any step fails, the verdict is `unavailable` / `lab_harness_failure`. Note the envelope's snake_case `safe_message`.
5. A missing, unreadable, or `runStatus`-less `run-result.json` yields `unavailable` / `unavailable`. No fallback path exists, and no branch can reach `clean` from a missing file.
6. `forbidden_run_status`, when matched, forces `disagree` regardless of any other comparison.
7. Every comparison runs the §10.6 binding check first. A failed binding yields `unavailable` / `lab_harness_failure`, and no verdict is computed.

### 10.6 Binding check — corrected

Revision 1 relied on `.frozen` sidecars and `stimulus-identity.json`. Neither catches an artifact swap: sidecars travel with their files, and `stimulus-identity.json` sits outside `product-out/`. The primary binding is now the Lab's own record.

**Primary — observation record `retained_output_refs`.** Each completed operation record carries, for every retained output, `{path, byte_length, file_sha256}`, inside a hash-chained record (`declared_record_hash` → `dispatched_record_hash` → `core_hash`) bearing `observation_id` and `plan_hash`. Every product artifact the comparator reads must appear there with a matching digest at a matching logical path. Swapping any file into a different scenario breaks this immediately, because the map belongs to that scenario's record.

**Secondary — adapter `artifact_hashes`.** `run-summary.json` records the digests of `capture.json`, `stimulus-identity.json` and every `product-out/**` artifact — excluding itself and every `.frozen` sidecar (§6.7). An independent subject-side witness, produced inside the adapter process rather than by the host. Because `run-summary.json` is outside its own hash map, NC-4b's whole-subtree swap is caught by the host-side and plan-side checks below rather than by this map, which is why both bindings are required.

**Response envelope — four steps, in order.** Revision 3 said the envelope's sha256 must equal the record's `response_envelope_hash`. It must not: the record stores `result.envelope.core_hash` (`localObservation.ts:144`), a canonical hash over the envelope's semantic core, not a digest of the file. In the retained 2026-08-16 baseline the record's `response_envelope_hash` is `sha256:da6532e3…560c1b` while the file's sha256 is `sha256:0a24af24…0c661e` — the revision-3 check would have failed on every run, including correct ones.

**The delegation in revision 4 was unfounded.** It claimed `verifyTrustedLocalObservationRecord` already validates the envelope's canonical core hash. It does not, and cannot: its input surface is `recordBytes`, `planBytes`, `registryRoot`, `adapterEntryPath`, `retainedInputRoot` — there is **no retained-output root and no envelope path**, so it never opens the file. Its only involvement is `trustedLocalVerifier.ts:465`, which checks that `outcome.response_envelope_hash` and `terminal.response_envelope_hash` agree — two fields of the same record naming the same value. A declared `core_hash` that does not summarize the envelope's actual content would pass that check untouched, and an edited `/error/code` carrying its original declared hash would have been read as authentic.

For any scenario whose expectation names an adapter error code, **four steps, in order**:

1. **Bytes.** Verify the envelope file's sha256 against its `.frozen` sidecar `file_sha256`. Establishes these are the retained bytes.
2. **Shape.** Parse the verified bytes and schema-check them as `AdapterResponseEnvelopeV2`. Establishes the document is an envelope, not merely JSON.
3. **Recompute.** Compute `coreHash(envelope)` over the parsed document.
4. **Identity.** Require `recomputed === envelope.core_hash === operation.response_envelope_hash` — all three equal. Establishes both that the declared hash is honest and that the envelope belongs to that operation record.

**Dependencies this adds, and what they are not.** The comparator imports `@erl2/contracts` for the schema and `@erl2/integrity` for `coreHash` (`packages/integrity/src/hash/hash.ts:103`, generic over any object). Both are generic Lab packages consumed as published: no Lab source is modified, no Lab framework is built, no Qualiber code or semantics enters the comparator, and the comparator still imports nothing from Qualiber. Re-implementing canonicalization by hand in a task-local script would be strictly worse — a second, drifting copy of the Lab's own rules.

**Required comparator test.** Take a retained envelope, change `/error/code`, leave `core_hash` at its original declared value, and re-run the bind. Step 4 must refuse. Without step 3 this mutation passes every other check, which is precisely the hole revision 4 left open.

**Also checked:** record `observation_id` = sealed plan `observation_id` = this scenario's entry in `campaign-index.json` (the ID originates at draft time and is bound here, not in the oracle precommit); record `plan_hash` = sealed plan `core_hash`; record `adapter_artifact_hash` = `execution-lock.json`'s artifact digest; sealed plan input digests = retained `inputs/**` digests = `oracle-precommit.json`'s stimulus and contract digests = `stimulus-identity.json`; each artifact's `.frozen` sidecar (retained as a weak local consistency check, explicitly **not** relied on for cross-scenario binding).

### 10.7 Classification vocabulary

| Value | Meaning | Counts toward wave success |
|---|---|---|
| `product_agreement` | Observed matched the precommitted expectation | yes |
| `product_refusal_expected` | The product correctly refused where refusal was the precommitted expectation (QLB-EXT-005) | yes |
| `product_disagreement` | The product ran and reported something other than expected | no — published as the campaign's primary finding |
| `adapter_operational_failure` | The adapter failed for a reason other than an expected product refusal | no |
| `lab_harness_failure` | Binding, verification, scan or record failure | no — scenario quarantined |
| `unavailable` | Required artifact missing or unreadable | no |

### 10.8 `comparison.json` shape

```json
{
  "schema_version": "qualiber-reality-lab/campaign-comparison/v1",
  "scenario_id": "QLB-EXT-003",
  "observation_id": "<uuidv7>",
  "oracle_precommit_sha256": "sha256:…",
  "oracle_precommit_revision": 1,
  "execution_lock_sha256": "sha256:…",
  "expectation_sha256": "sha256:…",
  "binding": { "bound": true,
               "record_retained_output_refs_matched": ["run-result.json", "report.json"],
               "adapter_artifact_hashes_matched": true,
               "response_envelope_bytes_matched": null,
               "response_envelope_core_hash_matched": null,
               "plan_hash": "sha256:…", "adapter_artifact_hash": "sha256:…",
               "capture_stimulus_sha256": "sha256:…", "contract_stimulus_sha256": "sha256:…",
               "oracle_precommit_digests_matched": true,
               "execution_lock_digests_matched": true,
               "campaign_index_observation_id_matched": true },
  "expected": { "run_status": "rule_violation_detected",
                "required_finding_types": ["wrong_order"],
                "permitted_additional_types": [],
                "target_event": "quote_requested_three",
                "max_finding_count": 1,
                "operation_state": "completed", "response_status": "supported",
                "product_reported": true },
  "observed": { "operation_state": "completed", "response_status": "supported",
                "envelope_error_code": null, "envelope_error_owner": null,
                "run_status": "rule_violation_detected", "not_run_reason": null,
                "finding_count": 1, "finding_types": ["wrong_order"],
                "finding_events": ["quote_requested_three"],
                "collector_health": "healthy", "inconclusive_reason": null,
                "recorded_exit_code": 0, "recorded_ci_exit_code": 0,
                "artifacts_present": ["evidence-pack.json", "report.json", "…"],
                "artifacts_absent": [] },
  "verdict": "agree",
  "classification": "product_agreement",
  "sub_reasons": [],
  "evidence_refs": [
    { "field": "run_status", "path": "run-output/store/…/product-out/run-result.json",
      "sha256": "sha256:…", "json_pointer": "/runStatus" },
    { "field": "finding_types", "path": "run-output/store/…/product-out/report.json",
      "sha256": "sha256:…", "json_pointer": "/result/findings" },
    { "field": "operation_state", "path": "run-output/trusted-local-observation-record.json",
      "sha256": "sha256:…", "json_pointer": "/operation_outcomes/0/state" },
    { "field": "response_status", "path": "run-output/trusted-local-observation-record.json",
      "sha256": "sha256:…", "json_pointer": "/operation_outcomes/0/response_status" }
  ]
}
```

For QLB-EXT-005 the `observed` block additionally carries `envelope_error_code: "SUBJECT_PRODUCT_CLI_REFUSED"` and `envelope_error_owner: "subject"`, with an `evidence_refs` entry naming the retained response envelope, its **file sha256** (the byte identity, per step 1) and the pointer `/error/code` — plus `binding.response_envelope_bytes_matched: true` and `binding.response_envelope_core_hash_matched: true`. The record's `response_envelope_hash` is recorded separately in that entry as `core_hash`, so a reader can see both hashes and why they differ.

---

## 11. Negative-control matrix

Seven controls. All run against scratch copies, never against published evidence; results recorded in `negative-controls/`.

**Why counterfactuals are pre-authored.** Revision 3's NC-1 mutated `expected.json` and expected `product_disagreement`. That contradicted §10.5 rule 7: the binding gate runs before any comparison, the expectation digest is bound against `oracle-precommit.json`, and a mutated expectation therefore yields `lab_harness_failure` — the control would have "passed" for the wrong reason or been reported as a comparator bug. The disagreement branch is instead exercised against a counterfactual that is authored and committed **at stage 1, alongside the real expectations**, and bound in its own `negative_controls` block:

```json
"negative_controls": [
  { "control_id": "NC-1", "targets_scenario": "QLB-EXT-003",
    "counterfactual_expectation_sha256": "sha256:…",
    "definition": "003's expectation with expected_run_status set to clean; must disagree" }
]
```

The comparator's NC-1 mode accepts a counterfactual whose digest matches a `negative_controls` entry, and no other file. It cannot be pointed at an arbitrary expectation, so the mode cannot become a route around the gate. Every control below that exercises the disagreement branch uses this mechanism; every control that exercises the *gate* mutates evidence and expects `lab_harness_failure`.

| ID | Control | Method | Required outcome | Mechanism that must catch it |
|---|---|---|---|---|
| NC-1 | Wrong expectation must disagree | Run the comparator in **NC-1 mode** against the pre-authored, precommitted counterfactual `negative-controls/NC-1.counterfactual.expected.json` (003's expectation with `expected_run_status: clean`), whose digest is bound under `oracle-precommit.json`'s `negative_controls` block | `disagree` / `product_disagreement` | `run_status` equality, reached because the counterfactual binds |
| NC-1b | Mutated expectation must not reach comparison at all | Copy 003; edit `expected.json` in place; re-run the comparator normally | `unavailable` / `lab_harness_failure` | Expectation-digest binding against `oracle-precommit.json` — proving the gate that makes NC-1 mode necessary |
| NC-2 | Missing result must not be clean | Copy 001; delete `run-result.json`; re-run | `unavailable` / `unavailable`; `clean` never appears as observed | §10.5 rule 5 (no fallback) |
| NC-3 | Exit 0 must not mask a violation | Take 002's artifacts unmodified; assert `recorded_exit_code == 0` **and** `run_status == rule_violation_detected` **and** `agree` | all three true at once | §10.5 rule 3 (no branch reads exit code) |
| **NC-4a** | Swap `product-out/` only | Copy 002 and 003; exchange their `product-out/` subtrees, sidecars included; re-run both | both `unavailable` / `lab_harness_failure` | Record `retained_output_refs` digests **and** adapter `artifact_hashes` — sidecars alone would pass, which is the point |
| **NC-4b** | Swap the whole `qualiber/` subtree | Copy 002 and 003; exchange the complete subtree including `run-summary.json` and `stimulus-identity.json`; re-run both | both `unavailable` / `lab_harness_failure` | `stimulus-identity` vs sealed-plan and precommit input digests, plus record `retained_output_refs` — the internally-consistent swap still contradicts the scenario's own plan |
| NC-5 | Post-run mutation must be refused | Copy 001; flip one byte in retained `inputs/stimulus.json`; re-run offline verification and binding | verifier or binding refuses; comparison never `agree` | Sealed-plan input digest, precommit digest, `verifyTrustedLocalObservationRecord` |

Spanning assertion: after every control, the published bundle's `evidence-index.sha256` still verifies — proving no control touched published evidence.

---

## 12. Per-scenario run procedure

Each scenario runs in a fresh scratch directory `<WORK>/<SCENARIO_ID>/`. No `network-egress` capability is requested, no brokered egress occurs, and no HTTP operation is intentionally performed; the process remains unconfined.

**Once per campaign, in this order** (mirrors §19; no step refers backward to a later one)

1. Confirm the merged baselines; cut a fresh Qualiber worktree from `b07746e`; provision the three Lab packages from a clean Reality Lab checkout at `69ace16`. Record opening `git status --porcelain=v1 -uall`, HEAD and tree for both repositories.
2. Author all three task-local scripts — `compare-scenario.mjs`, `oracle-absence-scan.mjs`, `compare-scenario.test.mjs` — then run the tests and write `tooling-test-result.json`, which records the sha256 of the comparator it tested.
3. Author all stimuli, both contracts, all five `expected.json` files, and every precommitted negative-control counterfactual.
4. **Write `oracle-precommit.json`** binding those digests, the scenario definitions, the `negative_controls` block, all three tooling digests, and the Qualiber baseline; record its sha256 in the command log. No Qualiber execution against campaign inputs may precede this, and the tooling freeze (§19 step 1) begins here.
5. Run the throwaway feasibility spike (§19 step 2) and discard its artifacts.
6. Implement and build: the `contractBytes` seam, stimulus parser, validation adapter, build scripts, plan generator, docs — then `build:artifact:validation` (record sha256; assert determinism with `-- --check`) and `build:manifest:validation` (record sha256).
7. **Write `execution-lock.json`** referencing the stage-1 digest and revision and binding the just-built artifact, manifest, runtime provenance, final coordinates with working-tree status, and the `comparator_dependencies` block resolved through the anchor (§10.3.1). Record its sha256 in the command log. No official scenario run may precede this.

There is no rehearsal against the 2026-08-16 bundle at any point — it predates this comparator's binding topology and the gate would refuse it (§19 step 9).

**Per scenario**
1. `mkdir -p <WORK>/<ID>/{input,plan,declaration,run-output,verification,comparison}`.
2. Copy `stimulus.json` and `contract.json` into `input/`; recompute both digests and assert they match `oracle-precommit.json`.
3. Run the §10.4 scan over both files. Abort on any hit.
4. Generate the draft: `npm --prefix adapters/erl2-subject run plan:draft:validation -- --capture-stimulus <…> --contract-stimulus <…> --output <…>/plan/plan-draft.json`.
5. Seal: `node <LAB>/packages/cli/dist/src/bin.js declare-trusted-local-adapter --adapter-entry <validation artifact> --manifest <validation manifest> --acknowledge-trusted-local-code "<exact sentence>" --acknowledged-by "<operator>" --declaration-id qualiber-ext-<id> --output <…>/declaration/declaration.json --seal-plan-draft <…>/plan/plan-draft.json --plan-output <…>/plan/plan-sealed.json`.
6. Run the §10.4 scan over the sealed plan bytes.
7. Run: `… run-trusted-local-observation --adapter-entry <artifact> --manifest <manifest> --plan <…>/plan/plan-sealed.json --owner-declaration <…>/declaration/declaration.json --output-root <…>/run-output --bind-input capture-stimulus-input=<…>/input/stimulus.json --bind-input contract-stimulus-input=<…>/input/contract.json`.
8. Verify offline before reading anything else; write the result to `verification/`.
9. Re-run the §10.4 scan over `run-output/inputs/**` and retained response envelopes.
10. Append this scenario's observation id and sealed-plan `core_hash` to `campaign-index.json` — the ID originates here, not in either commitment file.
11. Run the comparator with `--dependency-anchor <fresh-qualiber>/adapters/erl2-subject/package.json`; it re-resolves its two Lab packages through that anchor and asserts the resolved name/version/entry-digest triples match `execution-lock.json`'s `comparator_dependencies` before comparing. Write `comparison/comparison.json`.
12. Record the command in the campaign log (start/end UTC, label, exit code, full command).

**Ordering and independence.** Scenarios run 001 → 005 for readability, but each is independent: fresh observation id, fresh output root, fresh scratch, no shared state, no reuse of another scenario's product output. Any scenario may be re-run alone. A scenario that fails does not stop or overwrite the others; §13 decides where its evidence lands.

---

## 13. Evidence-retention layout

```
docs/evidence/qualiber-product-scenarios-<YYYYMMDD>/
├── README.md                          # claim ceiling, coordinates, commands, what this does NOT prove
├── oracle-precommit.json              # stage 1 + every amended revision, each with its digest
├── oracle-precommit.sha256
├── execution-lock.json                # stage 2: references stage 1, binds built artifact + coordinates
├── execution-lock.sha256
├── campaign-index.json                # scenario IDs → observation ids, sealed-plan hashes, verdicts, classifications
├── commands/command-log.tsv
├── coordinates/                       # opening/closing HEAD, tree, porcelain status for both repos
├── adapter/                           # artifact, manifest, hashes, runtime-dependency provenance
├── campaign/
│   ├── compare-scenario.mjs           # task-local; MUST NOT be promoted into either repository
│   ├── oracle-absence-scan.mjs        # task-local; same rule
│   ├── compare-scenario.test.mjs      # task-local; the tests run at step 0a, retained as source
│   ├── tooling-test-result.json       # machine-readable outcome + sha256 of the comparator tested
│   └── fixtures/                      # hand-built inputs the tests run against
├── expectations/QLB-EXT-00{1..5}.expected.json
├── scenarios/QLB-EXT-00{1..5}/
│   ├── input/{stimulus.json,contract.json}
│   ├── plan/{plan-draft.generated.json,plan-sealed.json}
│   ├── declaration/trusted-local-declaration.json
│   ├── run-output/{trusted-local-observation-record.json,observation-plan.json,inputs/,registry/,store/}
│   ├── verification/verification-result.json
│   └── comparison/comparison.json
├── failed-attempts/<ID>-attempt-<n>/   # quarantined; see below
├── negative-controls/
│   ├── NC-{1,1b,2,3,4a,4b,5}.result.json
│   ├── NC-1.counterfactual.expected.json   # authored at stage 1, digest bound in oracle-precommit
│   └── README.md
├── evidence-index.json
└── evidence-index.sha256
```

### 13.1 Admitted evidence vs quarantined attempts

Revision 1 contradicted itself here. Resolved:

| Situation | Where it goes |
|---|---|
| Scenario ran, offline verification passed, binding held, comparator returned `agree` | `scenarios/<ID>/`, admitted |
| Scenario ran, verification passed, binding held, comparator returned **`disagree`** | `scenarios/<ID>/`, admitted **intact** — a verified product disagreement is the campaign's most valuable output and is published in full |
| Verification failed, binding broke, record missing, or an oracle-absence scan hit | `failed-attempts/<ID>-attempt-<n>/`, **quarantined** — retained for diagnosis, never cited as scenario evidence, never counted in the index's verdict tally |
| Scenario re-run after a quarantined attempt | New attempt directory; the successful run is admitted; the quarantined attempt stays |

The campaign README states the count of quarantined attempts. Silence about re-runs would misrepresent how the evidence was obtained.

**Not retained:** `node_modules`, build caches, the dependency closure, Docker artifacts, transcripts. `runtime-dependency-provenance.json` records dependency identities without their bytes, per the 2026-08-16 precedent.

**Expectations are published after the runs.** The pre-run scans establish that no expectation was present in any product input — that is a property of the retained bytes and is checkable by a reader. `oracle-precommit.json` and the command log **record that the operator fixed the expectations before execution**; they do not independently prove chronology. Both are self-authored by the same operator who ran the campaign, and nothing here countersigns, timestamps or witnesses them. A reader who does not trust the operator gains nothing from them, and the campaign does not ask to be trusted on that point — it states what the artifacts are and what they are not. Adding a signing or timestamping subsystem to close that gap would be a new assurance mechanism, which this campaign is explicitly not the place to introduce.

### 13.2 Claim ceiling (verbatim requirement for the campaign README)

> This campaign does **not** establish: certification; independent assurance; confinement or sandboxing; scoring or authentication; governor authorization; production readiness; reproducibility from a clean checkout; complete executable-dependency closure; or correctness of Qualiber outside the five scenarios tested here. No `network-egress` capability was requested and no HTTP operation was intentionally performed, but the adapter ran as an ordinary child process with the operator's own user permissions and was **not** isolated from the operator's filesystem or network. Finding-level claims are bounded by §7.1: outcome class, finding type against a precommitted set and allowlist, finding count, and target event. Severity, detail prose, finding order, evidence-pack contents, scoring and eligibility behavior were recorded but not asserted upon. On the comparator's own dependencies: `execution-lock.json` binds the name, version and **entrypoint** digest of `@erl2/contracts` and `@erl2/integrity`, and the provisioning receipt records the pinned Lab commit and package tarball digests. An entrypoint digest does not cover a package's internal modules — `@erl2/integrity`'s entrypoint re-exports `coreHash` from another file — so this establishes neither complete dependency closure nor the absence of post-install mutation inside a package. That limitation is accepted here rather than closed. On chronology: the campaign **records** that the operator fixed the expectations before execution, in a self-authored precommit and command log. It does not independently **prove** that ordering — nothing here is countersigned, timestamped or witnessed by a third party, and a reader who does not trust the operator should treat the ordering as asserted rather than demonstrated. What *is* checkable from the retained bytes alone is that no expectation appears in any product input.

What it does establish, from the retained bytes alone, is that for five independently supplied inputs the product's own artifacts matched or did not match a set of expectations, and that **no expectation appears anywhere in the product's inputs**. That those expectations were fixed *before* the product ran is **asserted by the operator record**, not demonstrated by the evidence.

---

## 14. Cleanup procedure

1. After each scenario's evidence is staged and digested, remove `<WORK>/<ID>/`.
2. After the campaign and evidence indexes are built, remove `<WORK>/`.
3. Assert no `qualiber-erl2-validate-` directories remain in the system temp directory — the same scan `v2.ts:162` performs, run independently by the operator.
4. Assert no Docker resource was created; the campaign starts none.
5. Assert Qualiber's closing `git status --porcelain=v1 -uall` is byte-identical to opening.
6. Assert the Lab's closing status differs from opening only under `docs/evidence/qualiber-product-scenarios-<date>/`.
7. Rename staging to the published name, recording the two steps that cannot appear in the command log (index rebuild, rename), as the 2026-08-16 bundle does.

---

## 15. Failure ownership and triage table

| Observation | Ownership | First action | Never do |
|---|---|---|---|
| `runStatus` differs from expectation, product reported | **Product disagreement** | Re-read the stimulus; confirm the expectation follows from `C-VALID`; publish intact with artifact paths and observed types | Do not amend the expectation (§10.2 forbids `product_disagreed`); do not re-run hoping for a different result |
| `clean` where a violation was expected | **Product disagreement**, severe | Publish as a missed regression | Do not downgrade to "coverage gap" |
| `clean` on QLB-EXT-004 | **Product disagreement**, most severe | Report immediately: green on zero measurement | Do not report the wave as passing |
| Finding type outside required ∪ permitted, or count over bound | **Product disagreement** | Publish observed set verbatim | Do not widen the allowlist after the fact |
| `response_status: failed` with `SUBJECT_PRODUCT_CLI_REFUSED` where a report was expected | **Adapter operational failure** (product refused) | Read the envelope's `safe_message` and `run-result.json`'s status | Do not classify as a scenario verdict |
| QLB-EXT-005 refusal exactly as precommitted | **`product_refusal_expected`** | Record as scenario success | Do not file under `adapter_operational_failure`, and do not call it a product pass |
| Record `state: failed` in **any** scenario | **Lab-harness failure** | This is a thrown host or execution fault with a `failure_code`, not an adapter refusal; quarantine and diagnose | Do not read it as the 005 refusal — the refusal arrives as `completed`/`failed` |
| QLB-EXT-005 returns `tool_error_non_blocking` | **Product disagreement**, sub-reason `unexpected_failure_class` | Investigate as a capture or tool defect | Do not accept as an equivalent refusal |
| Adapter `failed` with a `SUBJECT_*_STIMULUS_*` code | **Adapter operational failure** | Fix stimulus or bounds; the scenario proved nothing yet | Do not treat as a product finding |
| Record missing, verification failed, binding broken, plan expired, mount unbound | **Lab-harness failure** | Quarantine under `failed-attempts/`; re-run from step 1 with a fresh observation id | Do not admit as scenario evidence |
| `run-result.json` absent or unreadable | **Unavailable** | Retain everything; determine whether the CLI wrote nothing (exit 4) or the harness lost it | Do not infer any status |
| Oracle-absence scan hit | **Lab-harness failure**, campaign-blocking | Stop the wave; every subsequent result is suspect | Do not clean it up and continue |
| Product artifact digest ≠ record `retained_output_refs` | **Lab-harness failure** | Discard the scenario; investigate tampering or a copy bug | Do not compare anyway |

---

## 16. Acceptance criteria

Wave 1 succeeds **only** if all fourteen hold:

1. All five scenarios executed through public Qualiber surfaces only — the collector for capture, one `telemetrytest validate` spawn per run. No internal import, no private entry point.
2. The product reported all three outcome classes: `clean` (001), `rule_violation_detected` (002, 003), `inconclusive` (004).
3. QLB-EXT-005 produced exactly `runStatus: not_run` with `notRunReason: config_invalid`, a diagnostic naming `expected_path`, only `run-result.json` present, record `state: completed` with `response_status: failed`, and `SUBJECT_PRODUCT_CLI_REFUSED` read from a hash-bound response envelope — classified `product_refusal_expected`.
4. Exit-code-zero violations were classified correctly: NC-3 shows exit 0, a violation, and `agree` simultaneously.
5. Every product artifact was retained byte-for-byte and matched the observation record's `retained_output_refs`; the adapter rewrote none.
6. The campaign oracle was absent from every product input: all four scan points clean for all five scenarios; no expectation, digest or campaign identifier in any plan, binding or mounted tree.
7. All five comparisons yield `agree`, each within its precommitted finding-set bounds (required types present, no type outside the allowlist, count within bound, target event matched or product-unstated).
8. The record shows `oracle-precommit.json` existed and was digest-recorded **before** any Qualiber execution including the spike — an operator-recorded chronology, not an independently proven one (§13.2) — and that `execution-lock.json` existed before the first official run, references the stage-1 digest, and binds the built artifact and final coordinates; every scenario's observed digests match the appropriate file; any amendment is recorded with a permitted class and both revisions published.
9. All five observation records passed offline verification before admission.
10. All seven negative controls failed in the intended way, including NC-1b, NC-4a and NC-4b, with every disagreement-branch control run against a stage-1 precommitted counterfactual rather than a mutated expectation.
11. No residue: `clean` in all five records, no leftover scratch, `<WORK>` removed.
12. No Qualiber core changed: `git diff` over `src/**`, `packages/**`, `action*`, `schemas/**` is empty.
13. No Qualiber-specific semantic evaluator in Lab core: Lab package diff empty; comparator lives in the evidence bundle, importing only `@erl2/contracts` and `@erl2/integrity` as published packages through a recorded anchor, and nothing from Qualiber.
14. Quarantined attempts, if any, are published under `failed-attempts/`, counted in the README, and excluded from the verdict tally.

**Reporting rule.** Any criterion failing means the wave is reported as failed, with the criterion named. Partial success is reported as partial — never rounded up.

---

## 17. Stop conditions

Halt and request a decision if:

1. **Controlled inputs would require changing Qualiber core.** No flag, env var, test hook or scenario branch in `src/**`.
2. **The adapter would have to receive expected truth** — to select behavior, shape output, or decide a status.
3. **Reality Lab would need a generic arbitrary-command execution framework.**
4. **A clean adapter build cannot obtain its declared dependencies** without vendoring a path into the repository.
5. **Product artifacts lack enough documented information to classify outcomes independently** — specifically if `runStatus`, `notRunReason` or finding types cannot be read from artifacts without consulting Qualiber source or tests.
6. **The only available implementation would weaken existing fail-closed behavior** — relaxing `REPORTED_STATUSES`, making the artifact-completeness check conditional in a way that could mask a partial write, loosening the mode freeze, widening the environment allowlist, or granting an unneeded capability.
7. **The plan depends on hidden or self-authored Qualiber ground truth** — an expectation justifiable only from a Qualiber fixture. Record it as observed-not-predicted and say so plainly, or stop.
8. **The `journey_id` linkage would force the adapter to parse the contract**, breaking §6.5.
9. **A precommit amendment would need class `product_disagreed`.** That is the signal that the campaign was about to rewrite its own oracle. Stop and escalate.

---

## 18. Bounded file/change estimate by repository

### 18.1 Qualiber — all under `adapters/erl2-subject/`

**New (8):**

| Path | Est. lines | Purpose |
|---|---|---|
| `src/stimulus.ts` | ~110 | Parse and bound-check `erl2-capture-stimulus/v1`; never parse `body_text` |
| `src/validation-adapter.ts` | ~200 | Second `AdapterDefinition`: `interact` + `report-residue`, gated by `assertLocalObservation` |
| `src/validation-main.ts` | ~15 | Entry, mirroring `src/main.ts` |
| `certification/validation-adapter-manifest.v2.json` | ~55 | Generated, never hand-edited |
| `scripts/write-validation-plan-draft.mjs` | ~600 | Two mounts, deny-everything egress, three capabilities, `interact → report-residue`. Duplicates the live generator's skeleton by design (see below) |
| `tests/stimulus.test.ts` | ~180 | Bounds, refusal codes, "malformed `body_text` is forwarded, not rejected" |
| `tests/validation-adapter.test.ts` | ~280 | Both surfaces reached; no verdict composed; refusal path; artifacts unmodified; contract content never inspected |
| `tests/validation-plan-draft.test.ts` | ~220 | No network capability; deny-everything egress; two mounts; no `configure` |

**Edited (8):**

| Path | Est. lines | Purpose |
|---|---|---|
| `src/pipeline.ts` | ~+30 | `contractBytes` option, mutually exclusive with `contractPath`, written into the scratch it already owns and removes |
| `tests/pipeline.test.ts` | ~+90 | Byte identity of written contract; scratch removed on reported, refused and thrown paths; mutual exclusivity |
| `scripts/build-artifact.mjs` | ~+20 | Parameterize entry/output; existing default stays byte-identical |
| `scripts/build-manifest.mjs` | ~+20 | Same parameterization |
| `tests/v2-boundary.test.ts` | ~+60 | Governed-refusal and mode-freeze proofs against the second built artifact |
| `README.md` | ~+80 | Two adapters, why Option A was rejected |
| `ONBOARDING.md` | ~+90 | Second quickstart |
| `package.json` | ~+4 | Three script entries |

**Totals: 8 new, 8 edited, ~1660 net new lines, none outside `adapters/erl2-subject/`. Qualiber core: zero changes.**

**Plan-skeleton refactor removed from the critical path.** Revision 1 made extracting a shared `plan-skeleton.mjs` a prerequisite, which would touch the one generator already proven in retained evidence before the new seam had demonstrated any value. The second generator now duplicates the skeleton, and the ~600-line estimate reflects that. Extraction becomes a candidate only after Wave 1 passes, and only if the duplication proves unmaintainable — at which point it is its own change with its own byte-identity proof.

### 18.2 Reality Lab

| Path | New/Edit | Purpose |
|---|---|---|
| `docs/evidence/qualiber-product-scenarios-<date>/**` | new | Evidence, task-local scripts, precommit, expectations, controls, quarantined attempts |

**Lab packages, CLI, contracts, schemas: zero changes.** New plan-input roles need none (`role` is a free-form `Id`); an offline plan needs none (egress arrays have no `minItems`); the comparator needs none (task-local, retained not promoted).

---

## 19. Implementation sequence after the merge baselines land

**Step 0 — confirm the baselines and prepare clean checkouts.** The code/dependency merge gate is closed; this is a confirmation, not a wait. Re-verify that Reality Lab `origin/main` is `69ace16` / tree `89988e55…` and Qualiber `origin/preprod` is `b07746e` / tree `b9a7c66f…`; if either has moved, re-review this plan against the new coordinates before proceeding. Cut a **fresh Qualiber worktree or branch from `b07746e`** — never the dirty primary checkout — and provision `@erl2/adapter-sdk`, `@erl2/contracts` and `@erl2/integrity` from a **clean Reality Lab checkout pinned to `69ace16`**. The separate historical evidence-publication PR is unrelated and blocks nothing here.

**Step 0a — author the tooling, then test it.** Revision 4.1 ordered this incoherently: it said to write and test the comparator at step 0a and then to author it again at step 1. Correct order, in one step:

1. Author all three task-local scripts: `compare-scenario.mjs`, `oracle-absence-scan.mjs`, and `compare-scenario.test.mjs`.
2. Run the tests against hand-built fixtures: the four-step envelope bind including the mutated-`/error/code`-with-stale-`core_hash` refusal; the `--dependency-anchor` resolution path and its hard exit when the anchor is missing or a package is unresolvable; `state` and `response_status` read as separate fields; a missing `run-result.json` yielding `unavailable`; no branch reading an exit code; finding-set bounds; NC-1 mode accepting only a digest-matching counterfactual.
3. Write a machine-readable `tooling-test-result.json` recording the outcome **and the sha256 of the comparator it tested**, so a reader can confirm the tested script is the bound one rather than taking it on trust.

These run on fixtures, need no observation, and are the only comparator exercise available before a compatible run exists (step 9).

**Step 1 — author the oracle and commit stage 1.** Write all stimuli, both contracts, all five `expected.json` files (each finding-set field justified from `C-VALID`'s semantics alone — see the QLB-EXT-003 derivation for the standard) and every precommitted negative-control counterfactual. Write `oracle-precommit.json` binding those digests, the scenario definitions, the `negative_controls` block, **all three tooling digests from step 0a**, and the Qualiber baseline; record its sha256. **No Qualiber execution against campaign inputs may precede this.** It binds no adapter artifact and no observation id, because neither exists yet.

**Tooling freeze.** From stage 1 onward, no edit to any of the three scripts is permitted without a recorded `oracle-precommit.json` revision that rebinds the changed digest, re-runs the tests, and rewrites `tooling-test-result.json`. A comparator edited mid-campaign is a comparator whose earlier verdicts were produced by different code, and the evidence must show which.

**Step 2 — throwaway feasibility spike.** Outside both repositories, feed the four stimulus bodies through `CaptureAccumulator` and run `telemetrytest validate` against `C-VALID` and `C-INVALID`. Confirm from artifacts only: 001 `clean`; 002 violation with `missing_required_event`; 003 violation with `wrong_order`; 004 `inconclusive` with `no_telemetry_observed`; 005 `not_run` / `config_invalid` naming `expected_path` with only `run-result.json` written. Also confirm the `journey_id` linkage between contract and capture.

> **Spike discipline.** The spike may reveal that a *stimulus* failed to express its intended customer condition — amend under §10.2 class `stimulus_did_not_express_condition`, reissue the precommit, publish both revisions. It may **not** redefine correctness because Qualiber disagreed. A divergence that is not a stimulus defect is a **finding about the product**, carried into Wave 1 as a precommitted expectation the product is likely to fail, and reported. Discard the spike's artifacts; they are not evidence.

**Step 3 — `contractBytes` seam + tests** in `pipeline.ts`, landed alone. This is the only edit to proven code on the critical path.

**Step 4 — stimulus parser + tests**, including "malformed body is forwarded", which is what keeps QLB-EXT-004 honest.

**Step 5 — validation adapter + tests**, including an explicit test that the adapter never inspects contract content.

**Step 6 — build scripts, manifest generation, artifact determinism check.**

**Step 7 — validation plan-draft generator + tests.** Assert absence of `network-egress` in both manifest and plan.

**Step 8 — docs.** Second quickstart; README section on why the two adapters are separate.

**Step 9 — no rehearsal against the 2026-08-16 bundle.** Revision 4 proposed running the comparator over that bundle as a free end-to-end test. It cannot work: the bundle predates every binding this comparator requires — no `oracle-precommit.json`, no `execution-lock.json`, no `campaign-index.json`, no `stimulus-identity.json`, and a different adapter with a different plan topology (three operations, an environment mount, granted network egress). The binding gate would refuse it before any comparison, so the "rehearsal" would prove only that the gate fires.

Comparator confidence therefore comes from the step-0a unit tests, and **QLB-EXT-001 is the first compatible end-to-end exercise** — which is why step 10 runs it alone and stops.

**Step 9a — commit stage 2.** Write `execution-lock.json`: the stage-1 digest and revision, final coordinates with working-tree status, and the built artifact, manifest and runtime-provenance digests. Record its sha256. No official scenario run may precede this.

**Step 10 — dry run QLB-EXT-001 only.** Verify, compare, clean up. Do not proceed until green.

**Step 11 — run 002 … 005**, one at a time, verifying each before the next.

**Step 12 — negative controls** against scratch copies, including both NC-4 variants.

**Step 13 — assemble, index, publish, clean up** per §13/§14, with quarantined attempts separated.

**Step 14 — report.** State which of the fourteen criteria passed. If the product disagreed anywhere, report that first.

---

## 20. Review checklist

**Commitments and oracle**
- [ ] `oracle-precommit.json` predates every Qualiber execution, including the spike, and its digest is in the command log.
- [ ] It binds no adapter artifact, no manifest and no observation id — nothing that did not exist when it was written.
- [ ] `execution-lock.json` predates the first official run, references the stage-1 digest and revision, and binds the built artifact, manifest, runtime provenance and final coordinates.
- [ ] Observation ids and sealed-plan hashes appear in `campaign-index.json`, generated after sealing — not in either commitment file.
- [ ] Every scenario's observed stimulus/contract/expectation digest matches stage 1; artifact and coordinate digests match stage 2.
- [ ] Every amendment carries a permitted class; none is `product_disagreed`; both revisions are published.
- [ ] Each `permitted_additional_types` entry has a written justification derived from `C-VALID`, not from Qualiber's behavior or fixtures — and 002's and 003's allowlists are empty, with 003's target derived as `quote_requested_three` from the two predecessor-ordering constraints.

**Oracle absence**
- [ ] The scan targets campaign identifiers only, and does **not** forbid `expected_path` or any contract field.
- [ ] All four scan points ran and are retained clean for all five scenarios.
- [ ] `expected.json` appears in no plan, no binding and no mounted tree.
- [ ] The comparator imports nothing from Qualiber and uses no product fixture.

**Product truth**
- [ ] Every `run_status` cites a `run-result.json` path, digest and JSON pointer.
- [ ] No comparator branch reads an exit code.
- [ ] Every scenario compares **both** `state` and `response_status`; no scenario treats a `completed` record as evidence the adapter succeeded.
- [ ] 005 expects `state: completed` with `response_status: failed` — **not** `state: failed`.
- [ ] 005's `SUBJECT_PRODUCT_CLI_REFUSED` is read from the response envelope, not from `operation_outcomes`, and only after the four-step bind: file bytes vs `.frozen` → schema-check as `AdapterResponseEnvelopeV2` → **recompute `coreHash(envelope)`** → `recomputed === envelope.core_hash === response_envelope_hash`.
- [ ] No document claims `verifyTrustedLocalObservationRecord` validates envelope bytes or recomputes their core hash — its input surface has no retained-output or envelope path, and it only cross-checks two record fields (`trustedLocalVerifier.ts:465`).
- [ ] The comparator test exists that mutates `/error/code` while retaining the original declared `core_hash`, and it is refused at step 4.
- [ ] The comparator was authored **before** it was tested, and tested **before** `oracle-precommit.json` bound its digest; `tooling-test-result.json` records the sha256 of the comparator tested, and that digest equals the one stage 1 bound.
- [ ] No tooling script changed after stage 1 without a recorded precommit revision, re-run tests and a rewritten test result.
- [ ] Every comparator invocation passed `--dependency-anchor`, and each run's re-resolved `@erl2/contracts` and `@erl2/integrity` name/version/entry-digest triples matched `execution-lock.json`.
- [ ] `execution-lock.json`'s `comparator_dependencies` records the anchor repository-relative; no absolute path appears in the lock.
- [ ] No document or script compares the envelope's **file sha256** against `response_envelope_hash` — the record stores the envelope's `core_hash`, and the two differ.
- [ ] `terminal_status` is used nowhere to classify the 005 refusal.
- [ ] No document claims the failed response triggered cleanup-only mode.
- [ ] 005 is classified `product_refusal_expected`, not `adapter_operational_failure`, and not a product pass.
- [ ] 005's absent report artifacts are asserted absent, not tolerated.
- [ ] 005 did not return `tool_error_non_blocking`.

**Binding**
- [ ] Every consumed artifact matched the record's `retained_output_refs`.
- [ ] Adapter `artifact_hashes` agreed as an independent witness, and its scope is exactly `capture.json` + `stimulus-identity.json` + `product-out/**`, excluding `run-summary.json` itself and every `.frozen` sidecar.
- [ ] NC-4a and NC-4b both refused; neither relied on `.frozen` sidecars alone.

**Evidence**
- [ ] `evidence-index.sha256` verifies over the published tree.
- [ ] Verified disagreements are published intact under `scenarios/`.
- [ ] Harness failures are quarantined under `failed-attempts/`, counted in the README, excluded from the tally.
- [ ] No `node_modules`, build cache or dependency closure copied.
- [ ] The claim ceiling appears verbatim, including the finding-scope bound and the unconfined-process sentence.

**Boundary and cleanup**
- [ ] Qualiber `src/**` diff empty; Lab `packages/**` diff empty.
- [ ] Task-local scripts exist only in the bundle and say so in their own headers.
- [ ] No scenario-specific branch in adapter code; all five runs execute identical bytes.
- [ ] Residue `clean` in all five; `<WORK>` removed; Qualiber's closing porcelain status byte-identical to opening.

**Honesty**
- [ ] Nothing claims certification, confinement, scoring, authentication, governor authorization, production readiness or clean-checkout reproducibility.
- [ ] "No network" appears nowhere unqualified.
- [ ] Wave 2 is described as deferred, with no result implied.

---

## 21. Self-contained implementation prompt — Wave 1 only

> Implement Wave 1 of Qualiber's external product-scenario campaign.
>
> **Checkouts, before anything else.** Cut a **fresh Qualiber worktree or branch from `origin/preprod` = `b07746e706c465f00f06c8fa25005fe9a7b1ba4b`** (tree `b9a7c66fd8…`) and work only in its `adapters/erl2-subject/` plus a scratch directory outside both repositories. **Do not use the primary checkout at `/Users/karthik/Claude/Projects/Qualiber`** — it carries uncommitted work, and an artifact built from it would have provenance no coordinate describes. Provision `@erl2/adapter-sdk`, `@erl2/contracts` and `@erl2/integrity` from a **clean Reality Lab checkout pinned to `origin/main` = `69ace16fb7ee021dddbcf3fa70e4295c2e5a400b`** (tree `89988e5588…`). Re-verify both refs first; if either has moved, stop and re-review the plan against the new coordinates. Do not modify Qualiber core (`src/**`, `packages/**`, `action*`, `schemas/**`) or any Reality Lab package source.
>
> **Author the tooling, then test it, then commit stage 1 — in that order.** Write all three task-local scripts (`compare-scenario.mjs`, `oracle-absence-scan.mjs`, `compare-scenario.test.mjs`); run the tests on hand-built fixtures covering the four-step envelope bind including the mutated-`/error/code`-with-stale-`core_hash` refusal, the `--dependency-anchor` resolution path and its hard exit on failure, `state` and `response_status` as separate fields, a missing `run-result.json` yielding `unavailable`, no branch reading an exit code, finding-set bounds, and NC-1 mode accepting only a digest-matching counterfactual; then write `tooling-test-result.json` recording the outcome **and the sha256 of the comparator it tested**. Only then author the oracle and write `oracle-precommit.json`, which binds all three tooling digests and that result. After stage 1 the tooling is frozen: no script edit without a recorded precommit revision, re-run tests and a rewritten result. Do **not** rehearse the comparator against the retained `qualiber-trusted-local-product-run-20260816` bundle — it predates every binding this comparator requires and has a different adapter and plan topology, so the gate would refuse it. QLB-EXT-001 is the first compatible end-to-end exercise.
>
> **The comparator's two Lab imports need an explicit anchor.** It lives in campaign scratch while `@erl2/contracts` and `@erl2/integrity` are installed under the fresh Qualiber adapter checkout, and Node resolves bare specifiers from the importing module's location — a plain import would fail with `ERR_MODULE_NOT_FOUND` no matter how correctly the packages were provisioned. Require `--dependency-anchor <fresh-qualiber>/adapters/erl2-subject/package.json` (no default), resolve both packages with `createRequire(anchor).resolve()`, dynamically import the resolved entrypoints via `pathToFileURL()`, and exit hard before any comparison if the anchor is missing or either package is unresolvable — that is a tooling failure, not a scenario verdict. Record name, version and entrypoint sha256 for both in `execution-lock.json` under `comparator_dependencies`, with the anchor repository-relative and absolute paths confined to the command log. Every run re-resolves and asserts those triples match the lock; a mismatch is `unavailable` / `lab_harness_failure`. State the limit plainly in the campaign README rather than overselling it: the entrypoint digest binds the entrypoint only — `@erl2/integrity`'s entrypoint re-exports `coreHash` from `./hash/hash.js`, so the implementing file is not covered — and the provisioning receipt records the pinned Lab commit and tarball digests. Together they prove neither complete dependency closure nor the absence of post-install mutation inside a package, and that limitation is accepted under the trusted-local claim ceiling. Do not add a package-tree inventory.
>
> **Order matters: commit the oracle before running Qualiber at all.** With the three task-local scripts already authored and tested (see the tooling paragraph above), write the four capture stimuli, two contracts, five expectation files and every negative-control counterfactual expectation; then write `oracle-precommit.json` binding every stimulus, contract, expectation and counterfactual sha256, **all three tooling digests — `compare-scenario.mjs`, `oracle-absence-scan.mjs`, `compare-scenario.test.mjs` — plus `tooling-test-result.json`**, a one-line definition of each scenario, a `negative_controls` block naming each counterfactual and what it must produce, and the Qualiber baseline the spike will exercise; record its sha256. It binds **no** adapter artifact, manifest or observation id — those do not exist yet, and requiring them would make the commitment impossible to satisfy. Only then run anything against Qualiber, including the feasibility spike. After implementation and build, and before the first official Lab run, write `execution-lock.json` referencing the stage-1 digest and revision and binding the built artifact, manifest, runtime-dependency provenance, final coordinates with working-tree status, and the `comparator_dependencies` block. Observation ids and sealed-plan hashes go in `campaign-index.json`, generated after sealing, in neither commitment file. If the spike shows a stimulus failed to express its intended customer condition, amend the stimulus, reissue `oracle-precommit.json` with an `amendments[]` entry of class `stimulus_did_not_express_condition`, and publish both revisions. **Never amend an expectation because Qualiber disagreed** — that divergence is a finding about the product, carried into the wave and reported.
>
> **Build a second, separate Qualiber-owned subject adapter** — `qualiber-erl2-validation-subject` v0.1.0 — inside the existing `adapters/erl2-subject` package, with its own entrypoint (`dist/qualiber-erl2-validation-subject.mjs`) and its own generated manifest. Do **not** add a mode to the live quote adapter: `packages/core/src/adapter/host.ts:851` requests `manifest.required_broker_capabilities` by default and the plan must grant every requested capability, so a shared manifest would force `network-egress` into every offline plan.
>
> **What it does.** Declares exactly two operations, `interact` and `report-residue` (the frozen cleanup suffix) — no `configure`, because there is no environment. On `interact` it reads two host-provisioned read-only mounts, `capture-stimulus/stimulus.json` and `contract-stimulus/contract.json`. It feeds each stimulus request through `@qualgraph/collector`'s `CaptureAccumulator` (`markStep` then `onRawRequest`, in array order, URL composed as `http://erl2-stimulus.invalid<path_and_query>`, `body_text` passed **as the exact string supplied**, never re-serialized), then runs one spawn of the public `telemetrytest validate --contract … --capture … --out …`. It writes the capture, every CLI artifact unmodified under `qualiber/product-out/`, a `run-summary.json` quoting `runStatus` verbatim from `run-result.json` with `artifact_hashes` covering exactly `capture.json`, `stimulus-identity.json` and every `product-out/**` artifact — excluding `run-summary.json` itself, which cannot carry its own digest, and every `.frozen` sidecar, which the host writes — and a `stimulus-identity.json` recording both mounted files' sha256 and byte length as read. It requests no `network-egress` capability, performs no HTTP operation, and computes no verdict.
>
> **Contract materialization.** Add `contractBytes?: Buffer` to `RunProductValidationOptions` in `src/pipeline.ts`, mutually exclusive with `contractPath` (supplying both throws). When given, write those exact bytes to `<the scratch dir the function already creates at line 168>/contract.json` and pass that path to `--contract`; the existing `finally` at line 252 already removes it, so cleanup ownership is unchanged. Test byte identity, mutual exclusivity, and scratch removal on reported, refused and thrown paths.
>
> **Hard constraints.** The adapter checks the contract's presence and byte length (≤ 64 KiB) and **does not parse or interpret** its content — no field is inspected and no decision is made from it — so that an invalid contract is refused by the *product*, surfacing as `SUBJECT_PRODUCT_CLI_REFUSED`. A `body_text` that is not valid JSON is a valid stimulus and must be forwarded. Never read a product verdict from an exit code. Never accept or define any field carrying an expected outcome. Reuse `assertLocalObservation`, `observeResidue` and `operationPayload` from `src/v2.ts` unchanged. Do **not** refactor the existing live plan generator; duplicate its skeleton in the new one.
>
> **Stimulus format** `erl2-capture-stimulus/v1`: `{schema_version, journey_id, requests:[{sequence, path_and_query, method, body_text}]}`. Bounds: file ≤ 256 KiB, ≤ 64 requests, `body_text` ≤ 16 KiB, `method` must be `POST`, `path_and_query` ≤ 2048 chars beginning with `/`. Envelope violations are `SUBJECT_CAPTURE_STIMULUS_MALFORMED` (`failed`); missing mounts are `SUBJECT_CAPTURE_STIMULUS_ABSENT` / `SUBJECT_CONTRACT_STIMULUS_ABSENT` (`unsupported`); an oversized contract is `SUBJECT_CONTRACT_STIMULUS_TOO_LARGE` (`failed`).
>
> **Plan generator.** Add `scripts/write-validation-plan-draft.mjs` taking `--capture-stimulus`, `--contract-stimulus`, `--output`. It hashes both inputs, mints a fresh UUIDv7 observation id, stamps a two-hour expiry, and writes an unsealed draft carrying no hash it is not entitled to compute. Two `host_provisioned` inputs with roles `capture-stimulus` and `contract-stimulus` (roles are free-form `Id`s in the Lab schema — no Lab change needed); three capabilities (`write-run-output`, `write-adapter-workspace`, `read-subject-visible-input`); an egress policy with `default_action: deny` and empty `allowed_schemes`/`allowed_hosts`/`allowed_ports`/`allow_loopback_hosts` (the schema permits empty arrays); `deny-by-default-egress` kept as `unsupported_permitted` because the process is still unconfined; the same claim ceiling the live generator writes.
>
> **Tests:** stimulus bounds and refusal codes; malformed `body_text` forwarded; the adapter never inspects contract content; both public surfaces reached; artifacts retained unmodified; a product refusal maps to `failed`/`SUBJECT_PRODUCT_CLI_REFUSED` while a reported violation maps to `supported`; the generated plan grants no network capability and declares no `configure`; the built artifact refuses governed execution and mode changes as the live one does.
>
> **Then run the five scenarios**, one at a time, each with a fresh observation id and output root:
> - **001 clean**: `quote_requested_one` / `_three` / `_zero` in order with numeric `properties.numberOfItems` → `clean`, **zero** findings (a `clean` with findings fails: `clean` also covers all-`info` rollups).
> - **002 missing**: omit `_zero` → violation; required `missing_required_event` on `quote_requested_zero`; **empty allowlist**; **max 1 finding**. A property constraint attached to an event does not, from `C-VALID` alone, imply a separate property finding when the carrier event is absent — do not permit one. If the product emits a secondary finding, publish the `disagree` with the observed set.
> - **003 order**: `_three` before `_one` → violation; required `wrong_order` on **`quote_requested_three`**; empty allowlist; **max 1 finding**. Derivation: a three-state `expected_path` yields **two** predecessor-ordering constraints, and against `three, one, zero` only `quote_requested_three` precedes its required predecessor — `zero` still follows both. If the product names `quote_requested_one` instead, report `disagree` with sub-reason `target_event_counterpart`.
> - **004 degraded**: three bodies with no `event` key → `inconclusive`, never `clean`; exactly one `no_telemetry_observed`; `run-result.json` must carry a non-empty `inconclusiveReason` or `collectorHealth`.
> - **005 refusal**: 001's stimulus bytes **unchanged**, contract missing `expected_path` → exit 0, `runStatus: not_run`, `notRunReason: config_invalid`, `customerVisibleMessage` naming `expected_path`, **only** `run-result.json` present (assert the other five absent). On the Lab side expect record **`state: "completed"` with `response_status: "failed"`** — *not* `state: "failed"`, which is reserved for thrown host faults and carries a `failure_code` instead. Read `SUBJECT_PRODUCT_CLI_REFUSED` from the retained response envelope at `/error/code` (owner `subject`, snake_case `safe_message`), after a four-step bind: verify the file's bytes against its `.frozen` sidecar; parse and schema-check as `AdapterResponseEnvelopeV2`; recompute `coreHash(envelope)`; then require `recomputed === envelope.core_hash === operation.response_envelope_hash`. **The record stores the envelope's `core_hash`, not the file's sha256** — comparing the file digest fails on every run, and skipping the recompute would accept an edited `/error/code` that kept its original declared hash. Classify `product_refusal_expected`. **`tool_error_non_blocking` fails this scenario** — it would indicate an unexpected capture or tool failure, not the refusal under test. Do not claim the failure activated cleanup-only mode; `report-residue` runs because it is the next planned operation.
>
> Scenarios 001–004 share one Lab-authored contract (`rule_id`/`journey_id` `erl2_ext_journey`, `owner`/`source` `reality_lab_external_campaign`, `mode: observe`); 005 uses the same contract minus `expected_path`.
>
> **Per scenario:** copy both files into scratch and assert their digests against `oracle-precommit.json`; run the oracle-absence scan; draft the plan; seal it with `declare-trusted-local-adapter`; scan the sealed plan; run with `run-trusted-local-observation` and one `--bind-input` per mount; verify offline with `verifyTrustedLocalObservationRecord` before reading anything; re-scan the retained `run-output/inputs/**` and response envelopes; append the observation id and sealed-plan hash to `campaign-index.json`; run the comparator.
>
> **The oracle-absence scan** looks for campaign identifiers only: the expectation file path, the sha256 of `expected.json` / `oracle-precommit.json` (every revision) / `execution-lock.json` / either script (with and without the `sha256:` prefix), the campaign schema strings, the campaign field names (`expected_run_status`, `required_finding_types`, `permitted_additional_types`, `expected_operation_state`, `forbidden_run_status`, `expected_not_run_reason`, `max_finding_count`), and the scenario IDs. It must **not** scan for `expected_path` or any contract field, nor for generic words like `expected`, `clean` or `verdict`, nor for bare status values — the product is supposed to receive the customer's rule expectations; only the campaign oracle is withheld.
>
> **The comparator** (a script living only in the evidence bundle, never in either repository) reads `runStatus`, `notRunReason` and `inconclusiveReason` only from `run-result.json`; finding types and target events only from `report.json` at `result.findings[].type` and `.detail.event`; and the adapter's outcome from `operation_outcomes[]` where `operation === "interact"` as **two** fields — `state` (did the exchange complete) and `response_status` (the adapter's own verdict). Both are compared in **every** scenario: a `completed` record has never meant the adapter succeeded. Any adapter error code is read from the retained response envelope at `/error/code`, and only after a four-step bind — file bytes against the `.frozen` sidecar; parse and schema-check as `AdapterResponseEnvelopeV2` via `@erl2/contracts`; recompute `coreHash(envelope)` via `@erl2/integrity`; then require `recomputed === envelope.core_hash === operation.response_envelope_hash`. **The record stores the envelope's `core_hash`, not the file's sha256**; comparing the file digest would fail every run. **Do not delegate the recompute to `verifyTrustedLocalObservationRecord`** — it never opens the envelope (no retained-output or envelope path in its input surface) and only cross-checks two record fields at `trustedLocalVerifier.ts:465`. Those two imports are generic Lab packages consumed as published; the comparator still imports nothing from Qualiber. The error code is not present in `operation_outcomes`. It must never read `terminal_status` to classify the 005 refusal — that field derives from cleanup and reads `observed_complete` even when the adapter reported failure. It must contain no branch that reads an exit code. It emits `agree` / `disagree` / `unavailable` and one of `product_agreement`, `product_refusal_expected`, `product_disagreement`, `adapter_operational_failure`, `lab_harness_failure`, `unavailable`, with a path, sha256 and JSON pointer for every observed value. A missing or unreadable `run-result.json` is `unavailable`, never `clean`. **Before any verdict**, bind every artifact it reads to the observation record's `retained_output_refs` (path + `file_sha256`), cross-check the adapter's `run-summary.json` `artifact_hashes` as an independent witness (scope: `capture.json`, `stimulus-identity.json`, `product-out/**`; excluding `run-summary.json` itself and every `.frozen` sidecar), and confirm that `observation_id` and `plan_hash` agree between the record, the sealed plan and `campaign-index.json`; that the artifact digest matches `execution-lock.json`; and that both input digests agree across the sealed plan, the retained inputs, `stimulus-identity.json` and `oracle-precommit.json`. `.frozen` sidecars are a weak local check only — they travel with their files and cannot detect a swap.
>
> **Then run seven negative controls** against scratch copies, never against published evidence: (1) run the comparator in NC-1 mode against the stage-1 precommitted counterfactual (003's expectation with `expected_run_status: clean`, digest bound under `oracle-precommit.json`'s `negative_controls`) → `disagree` / `product_disagreement`; (1b) *edit* 003's `expected.json` in place and run normally → `unavailable` / `lab_harness_failure`, because the expectation digest no longer binds — this is why the counterfactual must be pre-authored rather than produced by mutation; (2) delete 001's `run-result.json` → `unavailable`, never clean; (3) confirm 002 shows exit 0 *and* a violation *and* `agree`; (4a) exchange 002's and 003's `product-out/` subtrees including sidecars → both must refuse on `retained_output_refs` and `artifact_hashes`; (4b) exchange the entire `qualiber/` subtrees including `run-summary.json` and `stimulus-identity.json` → both must refuse on the mismatch against their own sealed plan and precommit; (5) flip one byte of a retained stimulus → offline verification or binding must refuse.
>
> **Publish** to `docs/evidence/qualiber-product-scenarios-<YYYYMMDD>/` following the 2026-08-16 bundle's shape: README with the claim ceiling (including that finding-level claims are bounded to outcome class, type set, count and target event, and that the process was unconfined despite no egress), `oracle-precommit.json` with every revision and `execution-lock.json`, each with digests, campaign index, command log, coordinates, adapter artifact and manifest, one directory per admitted scenario, the expectation files, negative-control results, and a sorted `evidence-index.json` with byte lengths and sha256 plus its digest sidecar. **A verified product disagreement is published intact** under `scenarios/`. **A missing record, failed offline verification, broken binding or scan hit is quarantined** under `failed-attempts/<ID>-attempt-<n>/`, counted in the README, and excluded from the verdict tally. Copy no `node_modules`, build cache or dependency closure. Then delete all scratch, confirm no `qualiber-erl2-validate-` temp directories remain, and confirm Qualiber's `git status --porcelain=v1 -uall` is byte-identical to its opening listing.
>
> **Stop and ask** if: a scenario would require changing Qualiber core; the adapter would need to know the expected outcome; the Lab would need a generic command runner; the adapter cannot be built from declared dependencies without vendoring a path; `runStatus`, `notRunReason` or finding types cannot be read from documented artifacts without consulting Qualiber source or tests; the only workable implementation would weaken an existing fail-closed check; an expectation is justifiable only from a Qualiber fixture; or a precommit amendment would need the forbidden class `product_disagreed`.
>
> **Do not** implement Wave 2 (duplicate event, missing property, wrong property type). Do not add scoring, certification, confinement, a UI or a plugin system. Do not teach Reality Lab core anything about Qualiber's result semantics. Report plainly which of the fourteen acceptance criteria passed; if the product disagreed anywhere, report that first.

---

*End of plan, revision 4.3 — 2026-08-17.*
