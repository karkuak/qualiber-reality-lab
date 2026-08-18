# Qualiber external product-scenario campaign — Wave 1, prospective run, 2026-08-18

Five bounded scenarios (QLB-EXT-001 … 005) driven entirely by Lab-supplied input bytes through
Qualiber's own public surfaces, compared against expectations committed before the product ran, with
seven negative controls. **This campaign changed no Qualiber product code and no Reality Lab product
code.**

## Claim ceiling — verbatim, per plan §13.2

> This campaign does **not** establish: certification; independent assurance; confinement or sandboxing; scoring or authentication; governor authorization; production readiness; reproducibility from a clean checkout; complete executable-dependency closure; or correctness of Qualiber outside the five scenarios tested here. No `network-egress` capability was requested and no HTTP operation was intentionally performed, but the adapter ran as an ordinary child process with the operator's own user permissions and was **not** isolated from the operator's filesystem or network. Finding-level claims are bounded by §7.1: outcome class, finding type against a precommitted set and allowlist, finding count, and target event. Severity, detail prose, finding order, evidence-pack contents, scoring and eligibility behavior were recorded but not asserted upon. On the comparator's own dependencies: `execution-lock.json` binds the name, version and **entrypoint** digest of `@erl2/contracts` and `@erl2/integrity`, and the provisioning receipt records the pinned Lab commit and package tarball digests. An entrypoint digest does not cover a package's internal modules — `@erl2/integrity`'s entrypoint re-exports `coreHash` from another file — so this establishes neither complete dependency closure nor the absence of post-install mutation inside a package. That limitation is accepted here rather than closed. On chronology: the campaign **records** that the operator fixed the expectations before execution, in a self-authored precommit and command log. It does not independently **prove** that ordering — nothing here is countersigned, timestamped or witnessed by a third party, and a reader who does not trust the operator should treat the ordering as asserted rather than demonstrated. What *is* checkable from the retained bytes alone is that no expectation appears in any product input.

**What it does establish, from the retained bytes alone:** that for five independently supplied
inputs the product's own artifacts matched a set of expectations, and that **no campaign-oracle
identifier appears anywhere in the product's inputs**. That the expectations were fixed *before* the
product ran is **asserted by the operator record** (`oracle-precommit.json` and the command log),
not demonstrated by the evidence. Nothing here is countersigned, timestamped or witnessed.

## Coordinates

| | |
|---|---|
| Qualiber | `preprod` `d3ebf37fc2cd5741c25eac22eaa20777153730ce`, tree `0d2a8c4de0196972ef1ed8844b3746a4cfa5df3a` |
| Validation-adapter integration | `a4c6e2b5a7164ae52af8d855bb256dd927b26867`, tree `99fe6f518fcb03802dc1c5d5f8dfe1dea8eb108d` (ancestor of the above; the delta since is documentation-only and does not touch `adapters/erl2-subject/**`) |
| Reality Lab campaign baseline | `3d2655f67ad14c16dd6148e4654cc0fa872cb4a4`, tree `74c633fb5546085de055abb92095442e375a03c4` |
| Reality Lab dependency pin | `69ace16fb7ee021dddbcf3fa70e4295c2e5a400b`, tree `89988e5588b04534316c73901e34c56861caa494` |
| Validation artifact | `sha256:c65c6393af5e6d83f937c3d0d7f274101e915922494d8fcec26f8865fe05e762`, 41,472 bytes |
| Manifest (file / core) | `sha256:91e830d2…` / `sha256:504ab99b…` |
| Receipt input digest | `sha256:a0bc5288c9c8f960fdc6fa9d316cf171d7be2cd39d631b90a28c461f7bbbc96d` |
| Topology | `package-local-tarball (@qualgraph/collector@0.1.0)`, 2 of 2 declared artifacts |
| `oracle-precommit.json` | `sha256:b8f5fdb4786c1500d6d77454316c6e29a53d3cc51e3274ba0a425f1b30e62b69`, revision 1, `amendments: []` |
| `execution-lock.json` | `sha256:a379c02c1c0862daf84da47cbf743a6638dd59629a2df81ad7501ead391bcaae`, `amendments: []` |

All four canonical identities were reproduced independently by this campaign's own clean build and
match `docs/process/erl2-validation-adapter-handoff.md` §2 exactly.

## Results

| scenario | expected | observed | verdict | classification |
|---|---|---|---|---|
| QLB-EXT-001 clean baseline | `clean`, 0 findings | `clean`, 0 findings, healthy | `agree` | `product_agreement` |
| QLB-EXT-002 missing required event | `rule_violation_detected`, 1× `missing_required_event` on `quote_requested_zero` | exactly that | `agree` | `product_agreement` |
| QLB-EXT-003 wrong order | `rule_violation_detected`, 1× `wrong_order` on `quote_requested_three` | exactly that | `agree` | `product_agreement` |
| QLB-EXT-004 degraded capture | `inconclusive`, 1× `no_telemetry_observed`, reason recorded | `inconclusive`, health `degraded`, `inconclusiveReason: collector_unhealthy` | `agree` | `product_agreement` |
| QLB-EXT-005 invalid contract | `not_run` / `config_invalid`, only `run-result.json`, envelope `SUBJECT_PRODUCT_CLI_REFUSED` | exactly that, diagnostic names `expected_path` | `agree` | `product_refusal_expected` |

All five product artifacts sets bound to their record's `retained_output_refs`; all five records
passed offline verification; residue `clean` and `cleanup_complete` in all five.

**Quarantined attempts: 0.** `failed-attempts/` is empty. No scenario was re-run.

**Product disagreements: 0.** No Qualiber issue was filed by this campaign.

### The 005 hash distinction, measured

The record's `response_envelope_hash` is the envelope's `core_hash`, **not** the file's sha256.
On this run they are `sha256:267027fa…` and `sha256:2640e005…` respectively — different values, as
the plan's revision-4 correction predicted. The comparator recomputed `coreHash(envelope)` itself
and required `recomputed === envelope.core_hash === operation.response_envelope_hash`. It did **not**
delegate that recompute to `verifyTrustedLocalObservationRecord`, whose input surface contains no
retained-output or envelope path and which therefore never opens the file.

## What the comparator's dependency provenance does and does not establish

`execution-lock.json` binds the name, version and **entrypoint** digest of `@erl2/contracts` and
`@erl2/integrity`, resolved through the required
`--dependency-anchor adapters/erl2-subject/package.json`; the provisioning receipt records the
pinned Lab commit `69ace16` and the package tarball digests. An entrypoint digest does **not** cover
a package's internal modules — `@erl2/integrity`'s entrypoint re-exports `coreHash` from
`./hash/hash.js`, so the implementing file is not covered. This establishes neither complete
dependency closure nor the absence of post-install mutation inside a package. **That limitation is
accepted here rather than closed**; no package-tree inventory was added.

## Layout

- `plan/` — the reviewed Revision 4.3 plan verbatim, and `campaign-plan-application.md` explaining
  how a plan written before the integration merged is applied prospectively to the merged coordinate,
  including every recorded deviation.
- `oracle-precommit.json` (+ `.sha256`) — stage 1. Binds every stimulus, contract, expectation and
  counterfactual digest, all three tooling digests plus the tooling test result, and the Qualiber
  baseline. Binds no adapter artifact and no observation id, because neither existed when it was written.
- `execution-lock.json` (+ `.sha256`) — stage 2. References stage 1 and binds the built artifact,
  manifest, provenance, final coordinates with working-tree digests, and `comparator_dependencies`.
- `campaign-index.json` — observation ids and sealed-plan hashes, which belong in neither commitment.
- `campaign/` — the task-local scripts, their fixtures and `tooling-test-result.json`.
  **These must never be promoted into either repository**; each says so in its own header.
- `expectations/`, `scenarios/`, `negative-controls/`, `verification` and `scans` per scenario,
  `coordinates/`, `commands/command-log.tsv`, `adapter/`.
- `evidence-index.json` (+ `.sha256`) — every published file with byte length and sha256.

**Not retained:** `node_modules`, build caches, the dependency closure, and each run's
`run-output/workspace/` — the adapter's transient working tree, which duplicates `store/` outputs.
No paused-campaign evidence was copied.

## Honest notes

- **The command log's first eleven rows are `mtime_derived`**, not measured: they reconstruct
  Phase 0/0a/1 commands from artifact modification times because the log was opened after those
  phases ran. Every row from the clean build onward is `measured`. The reconstructed ordering does
  show `oracle-precommit.json` written after the tooling tests and before any Qualiber execution
  against campaign inputs, but that ordering is an operator record, not proof.
- **No feasibility spike was run.** See `plan/campaign-plan-application.md` §5.2.
- **NC-2 and NC-5 are reported as they happened**, including NC-5's aborted first attempt. See
  `negative-controls/README.md`.
- **Do not read "no network" unqualified.** No `network-egress` capability was requested, the plan
  carries a deny-everything egress policy, and no HTTP operation was intentionally performed — but
  the adapter ran as an ordinary child process with the operator's own permissions and was **not**
  isolated from the operator's filesystem or network. The plan records `deny-by-default-egress` as
  `unsupported_permitted` for exactly this reason.
- **Wave 2 (QLB-EXT-006 … 008) is deferred and no result is implied for it.**
