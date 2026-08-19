# Reality Lab — Stage 1 friction log and findings register

**Status: ADOPTION CANDIDATE.** This file is adopted from Revision 2 (SHA-256
`65d230450848e435a7fd702a3ec2afd98005ff7b1fd965e14c7b2e3b9daab372`, preserved unchanged except for
the narrowly authorized adoption transformation described in this section) following the focused
independent review (SHA-256 `720a7d7e038870b2f68a87f8b7cee438f830b41922884a96544039d49bbb72f2`),
which concluded **"REVISION 2 READY FOR OWNER ADOPTION REVIEW."** The owner has approved **Reality
Lab** as the owning repository and this file's path,
`docs/ledger/stage1-friction-log-and-findings-register.md`, as canonical, adopted by **one
documentation-only pull request**. This record becomes **adopted** only when this file is present
at this path on Reality Lab `main` — not before. Merging this file accepts **Stage 1 documentary
closure**; it does **not** assert that operating plan §10's onboarding-duration target ("under 30
minutes") was met — **elapsed onboarding time remains explicitly unmeasured** (§0, F-14). Adoption
of this record does **not** adopt the operating plan, the productization strategy, or the TPM
orchestration runbook — all three remain untracked and unedited — and does not resolve **PS-5** or
the first-party-dogfood record-label policy (FR-13/F-13), both of which remain **owner decision
required**. Neither the correction report nor the focused review is itself a repository artifact;
both are cited above by digest only, as the task-local record of the review that authorized this
adoption.

**Revision 2.** This revision supersedes **Revision 1**
(SHA-256 `3bbc5e42f90d18e3bfe29c7a052c7e7f95d245c661ad7c141ccd44da29259273`), which is preserved
unchanged, and applies the corrections required by the independent documentary closure review
(SHA-256 `ae391d6fdb5dc26099ea9cac1481164cfce53dd8b36364d649ee6738bee4ca21`): **S-1 through S-5**,
plus that review's optional **S-6** terminology correction. It **makes no policy decision** beyond
the adoption decisions recorded above, and **does not close Stage 1** technically or resolve PS-5.

This document is authored **outside both repositories**, from retained evidence only. It writes the
two artifacts productization step 1's exit condition names but that no repository currently
contains: a **friction log** and a **findings register**.

It does not declare productization step 1 closed. It does not amend the operating plan, the
productization strategy or the TPM orchestration runbook — those three remain untracked, unedited
and byte-identical to their pre-task state. It makes no policy decision, resolves no PS-5, and
begins no workspace-compiler design.

## Scope and method

Read-only reconstruction. Every source below is classified as either **committed Reality Lab
evidence** — resolvable from the repository at the coordinate named — or **unpublished task-local
material**. Task-local reports can support reconstruction, but they are **not independently
resolvable from either repository**; wherever committed bundle bytes and sibling provenance establish
the same fact, those are preferred.

**Committed Reality Lab evidence:**

* the 2026-08-16 trusted-local product-run bundle
  `docs/evidence/qualiber-trusted-local-product-run-20260816/**` and its sibling provenance advisory;
* the Wave 1 published bundle `docs/evidence/qualiber-product-scenarios-20260818/**`
  (evidence index `ec00d60f…`, revalidated 732/732 at the opening of this task) and its sibling
  provenance note;
* the Wave 2 published bundle `docs/evidence/qualiber-product-scenarios-wave2-20260819/**`
  (evidence index `c71a02ab…`) and its sibling provenance note, now **merged to Reality Lab `main` at
  `b8a32a84d22ccb8f63a4fc1726a91bcab9358268` (tree `80fc60e9…`)**;
* all three bundles' command logs.

Revision 1 described the Wave 2 campaign as *"run in parallel with this draft, for recurrence
evidence only"*. Wave 2's publication and merge occurred **after Revision 1 was authored and after
Revision 1's first independent review**; as of this revision Wave 2 is committed evidence, and it was
**not** committed when Revision 1 was originally written.

**Unpublished task-local documents** — reconstruction support only, not repository-resolvable:

* the five retained Wave 1 execution, independent-review, independent-evidence-review, publication
  and merge reports;
* the two Qualiber issue external-confirmation advisories;
* `reality-lab-post-wave1-strategy-reconciliation.md` (`8c74b9efb164c83d1dd7e56a6baa86319321d1eb6eff67b280554afb4229b994`);
* the Wave 2 execution, review, publication and merge reports, wherever cited below.

Where retained bytes do not decide a question, this document says so rather than inventing an
answer.

---

## 0 · The onboarding-time measurement, stated exactly

**elapsed onboarding time: not measured**

No onboarding-duration figure exists in any bundle, any command log or any retained report. Operating
plan §10's "time to first run: under 30 minutes" target is unmeasured **in both directions** — it is
not established as met and not established as missed.

### 0.1 Non-authoritative chronology — explicitly not an elapsed-time measurement

The timestamps below are observed artifacts of retained logs. They are listed only so a reader is not
left guessing what exists. **None of them is an onboarding-time measurement**, and none may be
converted into one. They measure command wall-clock *inside an already-provisioned session*, by an
operator who already knew the system — not time-to-first-run from a fresh checkout by someone who did
not.

| observation | retained span | what it is NOT |
|---|---|---|
| 2026-08-16 run | bundle dated 2026-08-16; its command log carries no measured start-to-finish onboarding span | not onboarding time |
| Run A (2026-08-17) | `2026-08-17T01:54:02Z` → `02:02:32Z`, ≈8.5 min of command wall-clock | execution elapsed only; excludes all provisioning, reading, and setup |
| Wave 1 (2026-08-18) | `2026-08-18T17:35:46Z` → `2026-08-18T18:10:55Z`; **11 of 69 rows are `mtime_derived`, not measured** | not onboarding time; the first eleven rows are reconstructed from file mtimes |
| Wave 2 (2026-08-19) | first measured row `2026-08-19T02:50:49Z` → last `02:55:05Z`; provisioning rows are marked `reconstructed_retrospective` | not onboarding time; the log was opened after provisioning |

Deriving a duration from mtimes, UUIDv7 embedded timestamps, reconstructed command logs or report
timestamps would manufacture a number the evidence does not contain. This draft declines to do so.

---

# A1 · Friction log

Fourteen entries. Each carries the full field set. `owner decision required` appears wherever the
retained evidence does not decide a field.

---

### FR-01 — Task-local provisioning/materialization was required to reach the public driver

* **Friction ID:** FR-01
* **Observed:** 2026-08-16 — `qualiber-trusted-local-product-run-20260816`
* **Affected public surface:** Reality Lab governed provisioning command (`preregister-acquisition` / acquisition-run path); `ComposeEnvironmentDriver` from `@erl2/core`
* **Operator intent:** provision the external `quote` service substrate for one owner-trusted local observation
* **Observed friction:** the public governed provisioning command **could not be used**. It requires registry and acquired-run state that has no meaning for an owner-trusted local observation. The driver itself was perfectly capable; only its public entry path was unreachable.
* **Evidence reference:** `substrate/task-local-substrate.mjs` (197 lines, 7,133 bytes) retained in the 2026-08-16 bundle; bundle `README.md` lines 65–70 (*"the public governed provisioning command requires registry and acquired-run state unrelated to an owner-trusted local observation"*); `substrate/provision-result.json`; command-log row `substrate:provision`
* **Exact commands/files required:** `node scripts/task-local-substrate.mjs provision <substrateRoot> <runIdFile> <outDir>` and `… destroy …`; the script imports `ComposeEnvironmentDriver`, `composeProjectName`, `dockerAvailable`, `materializeUpstream`, `OTEL_DEMO_RELEASE_TAG`, `SpawnDockerCli`, `SteppingClock`, `uuidV7From`, `trustedVolumeName` from `@erl2/core`, plus `assertContract` and `coreHash`/`developmentKey`
* **Workaround used:** a bespoke driver harness constructing the **existing, unmodified** driver and calling its existing `provision` / `inspect` / `destroy` operations; it added no capability the driver did not already have
* **Task-local?** **Yes** — the script's own header states it "is NOT production code and must never be promoted into either repository"
* **Recurrence:** the *pattern* recurs (see FR-02); this specific substrate script was needed once, because Wave 1 and Wave 2 use synthetic stimuli and need no external service
* **Operator impact:** high — a bespoke script had to be authored, reviewed for capability-neutrality, and retained as evidence before the first product run could happen at all
* **Risk:** **onboarding failure.** A newcomer reaching this wall has no public path and no documentation telling them to write a harness. Evidence-correctness risk is low here — the script was retained and is auditable.
* **Classification:** Lab usability defect
* **Owner:** Reality Lab
* **Disposition:** open — recorded as a limitation in the bundle, never as friction with an owner
* **Productization requirement implied:** the workspace compiler must absorb owner-trusted local provisioning so that no operator writes a driver harness to reach an existing driver
* **Blocks workspace-compiler design?** **No — it is required input to it.** This script is one of the two concrete specifications of what the compiler must absorb.

---

### FR-02 — Task-local offline-verification runner required again, one campaign later

* **Friction ID:** FR-02
* **Observed:** 2026-08-16 (`task-local-verify.mjs`) and again 2026-08-18 — Wave 1 (`run-offline-verification.mjs`); reused byte-for-byte 2026-08-19 — Wave 2
* **Affected public surface:** `verifyTrustedLocalObservationRecord` in `@erl2/core`; the public CLI
* **Operator intent:** verify a retained observation record offline, before reading it semantically
* **Observed friction:** there is **no public invocation path** for offline verification in the campaign context. `@erl2/core` is neither of the comparator's two permitted imports nor one of the adapter's three provisioned peers, so it cannot be reached through the comparator's dependency anchor.
* **Evidence reference:** 2026-08-16 bundle `verification/task-local-verify.mjs` (README line 137); Wave 1 `campaign/run-offline-verification.mjs` (`9ff27ced…`), bound in `oracle-precommit.json` under `campaign_local_verification_runner` with a written justification for sitting **outside** the three-script `tooling` block; Wave 1 execution report §8 deviation 4
* **Exact commands/files required:** `node campaign/run-offline-verification.mjs --lab-checkout <LAB> --record <record> --plan <plan> --registry-root <registry> --adapter-entry <adapter> --retained-input-root <inputs> --label <ID> --output <result>`
* **Workaround used:** a fourth task-local script, deliberately kept out of the plan's three-script tooling block so that block still means what the plan says
* **Task-local?** **Yes**, twice — and the second one followed "the retained-but-never-promoted precedent" of the first
* **Recurrence:** **three campaigns** — authored 2026-08-16, re-authored 2026-08-18, reused unchanged 2026-08-19
* **Operator impact:** high — this is the clearest case of the same gap being papered over repeatedly rather than closed
* **Risk:** **both.** Onboarding failure (no public path exists to discover) and evidence correctness (each re-authoring is a fresh opportunity to get verification subtly wrong; only review caught FR-13's latent disjunct)
* **Classification:** Lab usability defect
* **Owner:** Reality Lab
* **Disposition:** open
* **Productization requirement implied:** a first-class public offline-verification invocation, reachable without a task-local runner and without depending on `@erl2/core` resolution through an adapter anchor
* **Blocks workspace-compiler design?** **No — required input.** Together with FR-01 these are, in the strategy reconciliation's words, "the concrete specification of what the compiler must absorb, and nobody has written down what they absorbed." This entry writes it down.

---

### FR-03 — Operator-authored scenario plans and the binding burden

* **Friction ID:** FR-03
* **Observed:** 2026-08-18 Wave 1; 2026-08-19 Wave 2
* **Affected public surface:** `plan:draft:validation` (Qualiber), `declare-trusted-local-adapter --seal-plan-draft`, `run-trusted-local-observation --bind-input` (Lab CLI)
* **Operator intent:** run one scenario against one stimulus and one contract
* **Observed friction:** a single scenario requires the operator to chain **eight** separate invocations and to carry the correct absolute paths between them by hand — draft, declare+seal, scan, run with two explicit `--bind-input` pairs, verify, scan, compare. The input bindings must be restated at run time even though the sealed plan already declares their digests.
* **Evidence reference:** Wave 1 `commands/command-log.tsv` — eight rows per scenario × 5 scenarios; Wave 2 command log, same eight-row shape × 3
* **Exact commands/files required:** retained verbatim in both command logs; the `--bind-input capture-stimulus-input=… --bind-input contract-stimulus-input=…` pair is emitted as a copyable hint by `plan:draft:validation` (`bind with :` line), which is the only reason it is tractable
* **Workaround used:** a per-scenario shell driver in campaign scratch (Wave 2: `run-scenario.sh`); Wave 1 drove it by hand
* **Task-local?** **Yes** — scratch only, never retained as campaign machinery
* **Recurrence:** **two campaigns**, unchanged
* **Operator impact:** medium — tractable but entirely manual, and every step is an opportunity to mis-paste a path
* **Risk:** evidence correctness — a wrong `--bind-input` would bind the wrong bytes. Mitigated (not removed) by digest binding, which refuses rather than misreports.
* **Classification:** Lab usability defect
* **Owner:** Reality Lab
* **Disposition:** open
* **Productization requirement implied:** the compiler should take a scenario definition and emit the sealed plan, bindings and verification legs as one operator-visible step
* **Blocks workspace-compiler design?** No — required input.

---

### FR-04 — Dependency-anchor and package provisioning burden

* **Friction ID:** FR-04
* **Observed:** 2026-08-18 Wave 1; 2026-08-19 Wave 2
* **Affected public surface:** `install:lab-packages` (Qualiber), `--dependency-anchor` (comparator)
* **Operator intent:** let the comparator resolve `@erl2/contracts` and `@erl2/integrity` as a consumer would
* **Observed friction:** the comparator cannot find the Lab packages on its own. The operator must provision them into the *adapter's* `node_modules` from a *pinned Lab checkout*, then pass the adapter's `package.json` as an explicit anchor on **every** comparator invocation. Omitting the anchor is a hard exit 3; so is an anchor that cannot resolve.
* **Evidence reference:** Wave 1/Wave 2 `adapter/runtime-dependency-provenance.json`; tooling tests **T3, T4, T5** exist solely to pin this behaviour; command-log rows `qualiber:install-lab-packages`
* **Exact commands/files required:** `npm --prefix adapters/erl2-subject run install:lab-packages -- --lab-checkout <LAB>`; then `--dependency-anchor <QUALIBER>/adapters/erl2-subject/package.json` on every compare
* **Workaround used:** none needed — the public path works, but it must be known
* **Task-local?** No
* **Recurrence:** **two campaigns**, identical
* **Operator impact:** medium — three undocumented-by-default facts must be known in the right order
* **Risk:** onboarding failure. Evidence risk is low: the tooling refuses loudly rather than guessing (T4/T5), and explicitly prints *"no scenario was evaluated; this is not a verdict."*
* **Classification:** Lab usability defect
* **Owner:** Reality Lab (anchor requirement); Qualiber (the provisioning script is product-owned)
* **Disposition:** open
* **Productization requirement implied:** dependency provisioning and anchoring should be a compiler responsibility, not an operator one
* **Blocks workspace-compiler design?** No — required input.

---

### FR-05 — Canonical package-local tarball topology must be established by hand

* **Friction ID:** FR-05
* **Observed:** 2026-08-17 (#374 confirmation); 2026-08-18 Wave 1; 2026-08-19 Wave 2
* **Affected public surface:** `install-collector-from-tarball.mjs`, `install:lab-packages`, the adapter build
* **Operator intent:** build the adapter from a topology the product will accept
* **Observed friction:** the build refuses non-canonical topology — a root `node_modules/@qualgraph/collector` **symlink** into `packages/collector` is rejected before bytes are written. The canonical package-local tarball topology must be provisioned first, and the distinction is invisible until the refusal fires.
* **Evidence reference:** `qualiber-issues-372-374-external-confirmation.md` §4 (non-canonical refuses before writing bytes; symlink resolution described exactly); both campaigns' `runtime-dependency-provenance.json` recording `topology: package-local-tarball`; Wave 2 explicitly confirmed all three `@erl2` peers are **real directories, not symlinks**
* **Exact commands/files required:** `npm ci`, then `install:lab-packages`, then `env QUALIBER_ERL2_LAB_CHECKOUT=<LAB> npm run test:adapters`
* **Workaround used:** none — the refusal is correct and the canonical path is documented in Qualiber's handoff
* **Task-local?** No
* **Recurrence:** **three campaigns**
* **Operator impact:** low once known; high the first time
* **Risk:** onboarding failure only. This refusal actively **protects** evidence correctness.
* **Classification:** expected limitation (the refusal), with a Qualiber usability component (discoverability)
* **Owner:** Qualiber
* **Disposition:** the refusal behaviour is confirmed correct and **closed** via issue #374; the discoverability aspect is open
* **Productization requirement implied:** the compiler should establish canonical topology, and surface the refusal reason in operator terms
* **Blocks workspace-compiler design?** No.

---

### FR-06 — Artifact / manifest / receipt identity preparation

* **Friction ID:** FR-06
* **Observed:** 2026-08-18 Wave 1; 2026-08-19 Wave 2
* **Affected public surface:** the adapter build (`npm run test:adapters`), `certification/validation-adapter-manifest.v2.json`, `dist/.provenance/*.json`
* **Operator intent:** prove the exact adapter bytes that executed
* **Observed friction:** five distinct identities must be gathered and cross-checked by hand before the execution lock can be written — artifact sha256 **and byte length**, manifest **file** sha256, manifest **core** hash, receipt **input digest**, and the runtime dependency provenance digest. Nothing gathers or presents them as a set.
* **Evidence reference:** Wave 1 `execution-lock.json` `adapter` block; Wave 2 lock reproduced every value exactly: artifact `c65c6393…` (41,472 bytes), manifest file `91e830d2…`, core `504ab99b…`, receipt input `a0bc5288…`; Wave 2 also reproduced Wave 1's receipt file digest `8294c780…` byte-for-byte, demonstrating determinism
* **Exact commands/files required:** `shasum -a 256` over `dist/qualiber-erl2-validation-subject.mjs`, `certification/validation-adapter-manifest.v2.json`, `dist/.provenance/validation-subject.json`, `node_modules/@erl2/.provenance.json`, plus JSON reads for `core_hash` and `input_digest`
* **Workaround used:** a scratch script assembling the lock (`write-lock.mjs`, Wave 2)
* **Task-local?** **Yes** — scratch only
* **Recurrence:** **two campaigns**
* **Operator impact:** medium; the distinction between manifest *file* hash and manifest *core* hash is a genuine trap (plan revision 4 records a real prior error of exactly this kind — comparing a file sha256 against a record's `core_hash`)
* **Risk:** evidence correctness — binding the wrong one of two similarly-named hashes produced a check that "would have failed on **every** run, including correct ones," per plan §0
* **Classification:** Lab usability defect
* **Owner:** Reality Lab
* **Disposition:** open
* **Productization requirement implied:** the compiler should emit the identity set as one deterministically emitted binding block using existing contracts — the five artifact, manifest, receipt and provenance identities gathered and presented as a single coherent, deterministic set. This introduces **no** signing authority, authentication, countersignature, certification, new trust tier or new evidence schema; the block re-emits identities the existing contracts already produce.
* **Blocks workspace-compiler design?** No — required input.

---

### FR-07 — Absolute-path and portability exposure

* **Friction ID:** FR-07
* **Observed:** 2026-08-16, 2026-08-18 Wave 1, **and materially again 2026-08-19 Wave 2**
* **Affected public surface:** every campaign script's CLI; `runtime-dependency-provenance.json`; retained fixtures
* **Operator intent:** produce portable evidence
* **Observed friction:** three separate manifestations.
  1. **Relative paths are silently unsupported in an anchor position.** Wave 2 passed `--retain-fixtures` as a *relative* path; the test-derived anchor became relative, and the comparator refused with `createRequire failed for anchor … must be … absolute path string` — a *different* legitimate tooling exit from the one test T5 asserts. The suite reported `T5 FAIL` for what was purely an operator-invocation defect. Diagnosis took several steps; nothing in the tooling says "pass absolute paths."
  2. **Retained fixtures embed per-run identity** — observation and execution ids and the plan, envelope and file digests derived from them — so fixture trees are not byte-comparable across campaigns even though the generator is unchanged. Seventy-four of 387 files differ; **zero of 382 retained fixture files contain an absolute path** (387 is the compared campaign file set: 382 retained fixture files plus five shared non-fixture tooling files common to both waves).
  3. **`runtime-dependency-provenance.json` embeds the campaign-local checkout path.** Wave 1 redacted it before publishing; Wave 2 could not, because its execution lock was written before execution and binds the unredacted digest.
* **Evidence reference:** Wave 2 `commands/command-log.tsv` rows `campaign:tooling-tests(FAILED-relative-anchor)` (exit 1) and `campaign:tooling-tests` (exit 0); Wave 2 `plan/campaign-plan-application.md` §3.1; Wave 1 independent evidence review **I-3**; Wave 1 `adapter/runtime-dependency-provenance.json` redaction
* **Exact commands/files required:** both invocations retained verbatim in the Wave 2 command log
* **Workaround used:** re-run with an absolute path — the form Wave 1's own command log used
* **Task-local?** No — this is an invocation convention, discovered by failure
* **Recurrence:** **three campaigns**, and it caused a false test failure in the third
* **Operator impact:** high on first encounter — a green, unchanged, byte-identical test suite reported a failure, and the operator had to prove the tooling was sound before proceeding
* **Risk:** **onboarding failure, and a specific evidence-integrity hazard**: the tempting fix is to edit the test. Wave 2 explicitly did not, and recorded why.
* **Classification:** Lab usability defect
* **Owner:** Reality Lab
* **Disposition:** open
* **Productization requirement implied:** anchors and fixture roots must either accept relative paths or refuse with a message naming *the operator's* mistake; fixtures should be identity-neutral, or carry a declared normalization for run-identity fields, so they are comparable across campaigns
* **Blocks workspace-compiler design?** **No**, but it is a direct compiler requirement — path handling is exactly what a compiler removes from the operator.

---

### FR-08 — Positional operation-order diagnostics

* **Friction ID:** FR-08
* **Observed:** recorded pre-2026-08-16 and carried unchanged through both campaigns
* **Affected public surface:** trusted-local observation operation dispatch
* **Operator intent:** declare an operation profile and have mismatches explained
* **Observed friction:** operation-order matching is **positional**, and a mismatch surfaces as *"the adapter process ended without a valid response"* — a message that describes a process failure when the actual cause is a declaration-order mismatch. The operator is pointed at the wrong subsystem.
* **Evidence reference:** `docs/decisions/trusted-local-observation-operator-surface.md`; `docs/adr/ADR-ERL2-042.md`; strategy reconciliation §4 item 8
* **Exact commands/files required:** not retained — no campaign triggered this path, because both used the correct `interact → report-residue` order
* **Workaround used:** avoidance (declare the right order)
* **Task-local?** Not applicable
* **Recurrence:** latent in **all** campaigns; never triggered
* **Operator impact:** unmeasured in these campaigns; documented as a known trap
* **Risk:** onboarding failure — a newcomer would debug the adapter instead of the profile
* **Classification:** Lab usability defect
* **Owner:** Reality Lab
* **Disposition:** open
* **Productization requirement implied:** name the mismatched operation and the expected position in the diagnostic
* **Blocks workspace-compiler design?** No.

---

### FR-09 — Cleanup and scratch-root handling

* **Friction ID:** FR-09
* **Observed:** 2026-08-16, 2026-08-18, 2026-08-19
* **Affected public surface:** run output roots, campaign scratch, retained-input file modes
* **Operator intent:** leave no residue and preserve exactly the evidence
* **Observed friction:** scratch-root discipline is entirely operator-carried. The 2026-08-17 confirmation task had to validate its scratch root against **seven** separate conditions by hand (newly created, real directory, not a symlink, empty, not a git repository, not `/private/tmp` itself, not a repository parent). Separately, retained inputs are written **read-only** (`0400`/`0444`), which silently defeats a mutation a negative control depends on (see FR-10 and F-08).
* **Evidence reference:** `qualiber-issues-372-374-external-confirmation.md` §3; Wave 1 `NC-5.result.json` (aborted first attempt); Wave 2 NC-5 recorded pre-mutation mode `0400` and made the copy writable before mutating; all six published records carry `cleanup.status: cleanup_complete`, `residue: observed_clean`
* **Exact commands/files required:** Wave 2 NC-5 retained the exact sequence: `chmod u+w`, one-byte write, digest recompute, comparison
* **Workaround used:** manual pre-flight validation; explicit `chmod` before mutation
* **Task-local?** Yes — scratch discipline is re-invented per task
* **Recurrence:** **three campaigns**
* **Operator impact:** medium
* **Risk:** **evidence correctness, demonstrated.** Wave 1's NC-5 first attempt passed *trivially* because the write was silently refused. A control that did not run nearly read as a control that held.
* **Classification:** Lab usability defect
* **Owner:** Reality Lab
* **Disposition:** open
* **Productization requirement implied:** the compiler should own scratch lifecycle and make read-only retention explicit to any tool that must mutate a copy
* **Blocks workspace-compiler design?** No — required input.

---

### FR-10 — Evidence indexing and publication burden

* **Friction ID:** FR-10
* **Observed:** 2026-08-16, 2026-08-18, 2026-08-19
* **Affected public surface:** none — there is no public evidence-indexing surface at all
* **Operator intent:** produce a sorted, hashed, path-complete evidence index with a sidecar
* **Observed friction:** every campaign hand-rolls its own indexer, its own exclusion list, its own sidecar format and its own path-set-equality check. There is also an inherent self-reference problem the operator must reason about unaided: the index cannot index itself, and the command log cannot log its own hashing.
* **Evidence reference:** 2026-08-16 index `4d37cb07…` (117 indexed of 119 files); Wave 1 index `ec00d60f…` (732 files, 1,203,136 bytes, excluding exactly two); Wave 2 index `c71a02ab…` (666 files, 1,091,242 bytes, same two exclusions); the closing `NOTE` row in both campaigns' command logs explaining the two unloggable steps
* **Exact commands/files required:** not retained as a tool in any bundle — reconstructed per campaign (Wave 2: `build-index.mjs`, scratch)
* **Workaround used:** a fresh scratch indexer each time
* **Task-local?** **Yes**, three times
* **Recurrence:** **three campaigns**
* **Operator impact:** medium-high, and it is pure repetition
* **Risk:** evidence correctness — an exclusion-list or sort-order divergence between campaigns would make two bundles non-comparable; only convention has kept them aligned
* **Classification:** Lab usability defect
* **Owner:** Reality Lab
* **Disposition:** open
* **Productization requirement implied:** a first-class evidence-index producer with a fixed exclusion rule and sidecar format
* **Blocks workspace-compiler design?** No — required input.

---

### FR-11 — Four different "did it work?" signals that must not be conflated

* **Friction ID:** FR-11
* **Observed:** designed-for in Wave 1; exercised in Wave 1 and Wave 2
* **Affected public surface:** observation record (`state`), adapter response envelope (`response_status`), product artifact (`runStatus`), record terminal (`terminal_status`)
* **Operator intent:** answer "did the product do the right thing?"
* **Observed friction:** there are **four** distinct status-like fields with different owners and different meanings, and they legitimately disagree. QLB-EXT-005 is `completed` / **`failed`** — a completed exchange carrying the adapter's own refusal verdict. `terminal_status` is recorded for the reader but must **not** be used to classify.
* **Evidence reference:** plan §7 (*"The operation column is `record state` / `response_status`. Only 005 differs, and it differs in the second field, not the first"*); tooling test **T6**; every `comparison.json` `observed` block carries `terminal_status_recorded_not_used`
* **Exact commands/files required:** the comparator encodes the distinction; no operator command exposes it
* **Workaround used:** encode the four fields separately in the expectation schema and test the distinction explicitly (T6)
* **Task-local?** No — it is in the retained comparator
* **Recurrence:** **two campaigns**
* **Operator impact:** high conceptually — this is the single most confusable part of the system
* **Risk:** **evidence correctness.** Reading `state: completed` as "the product agreed" would have called QLB-EXT-005 a pass.
* **Classification:** expected limitation, with a Lab usability component (the distinction is real and necessary, but undocumented outside the plan)
* **Owner:** Reality Lab
* **Disposition:** mitigated in tooling; **undocumented for operators** — open
* **Productization requirement implied:** the compiler must never collapse these four into one verdict, and must name which one it is reporting
* **Blocks workspace-compiler design?** **No — it constrains it.** Any compiler that emits a single "pass/fail" without naming the field is wrong by construction.

---

### FR-12 — The risk of reading a process exit code as a verdict

* **Friction ID:** FR-12
* **Observed:** Wave 1 and Wave 2
* **Affected public surface:** every CLI invocation
* **Operator intent:** know whether a scenario passed
* **Observed friction:** exit code and product verdict are **orthogonal**. A scenario can exit `0` while the product reports a rule violation and the comparator agrees — all three simultaneously. Conversely, a comparator tooling failure exits `3` and is explicitly *not* a verdict.
* **Evidence reference:** **NC-3** in both campaigns (Wave 2: `recorded_exit_code: 0` **and** `run_status: rule_violation_detected` **and** `verdict: agree`); tooling test **T8** asserts *"no branch reads a process exit code"* and greps the comparator source to prove it; the comparator's own stderr on tooling failure: *"no scenario was evaluated; this is not a verdict."*
* **Exact commands/files required:** retained in both command logs; note NC-5's verifier leg legitimately exits `1`
* **Workaround used:** structural — the comparator is tested to contain no exit-code branch
* **Task-local?** No
* **Recurrence:** **two campaigns**, tested both times
* **Operator impact:** high for a newcomer; the habit of reading `$?` is near-universal
* **Risk:** **evidence correctness**, and it is the most likely single mistake an unassisted operator would make
* **Classification:** expected limitation with a Lab usability component
* **Owner:** Reality Lab
* **Disposition:** mitigated in tooling and tested; **undocumented for operators** — open
* **Productization requirement implied:** the compiler must expose product outcome and process exit as separately-named results and must refuse to present exit code as a verdict
* **Blocks workspace-compiler design?** **No — it constrains it.**

---

### FR-13 — Missing first-party-dogfood relationship field in record bytes

* **Friction ID:** FR-13
* **Observed:** 2026-08-16 and 2026-08-18 (both publications)
* **Affected public surface:** the trusted-local observation record schema
* **Operator intent:** honour strategy §7.2 commitment 2 — *"Qualiber runs are labeled as first-party dogfood in retained evidence, not only in documentation"*
* **Observed friction:** **no observation-record byte carries the subject-relationship label** in either publication. Wave 1's label lives in a *sibling markdown provenance note*; the 2026-08-16 bundle carries a thorough authority ceiling but **no** first-party-dogfood or subject-zero label at all. The records do carry `independent_certification: "absent"` and `confinement: "absent"` — so the schema expresses trust properties but not the subject relationship.
* **Evidence reference:** strategy reconciliation §4 (`first-party dogfood / neutrality label in retained evidence` — **PARTIAL**), S-18, and §7.2 analysis; all six published records
* **Exact commands/files required:** not applicable — the field does not exist
* **Workaround used:** sibling provenance notes (Wave 1 and Wave 2); Wave 2's bundle `README.md` states all six labels explicitly
* **Task-local?** No
* **Recurrence:** **three campaigns** — Wave 2 repeats the workaround because no field exists to fill
* **Operator impact:** low to produce, high to consume — a reader of record bytes alone cannot tell the Lab tested its own product
* **Risk:** **misreading of evidence by a third party** — the exact failure mode the neutrality commitment exists to prevent
* **Classification:** Lab correctness defect (a stated commitment is not met in the medium it names)
* **Owner:** Reality Lab
* **Disposition:** **owner decision required** — the strategy reconciliation classifies this as a **policy choice**: either accept sibling-note labelling as satisfying the commitment and say so, or require future records to carry the label in their own bytes. **This draft does not make that choice.**
* **Productization requirement implied:** conditional on the owner decision above
* **Blocks workspace-compiler design?** No.

---

### FR-14 — Undocumented prerequisites supported by retained bytes

* **Friction ID:** FR-14
* **Observed:** across all three campaigns
* **Affected public surface:** several; each item below is separately evidenced
* **Operator intent:** run the system without prior insider knowledge
* **Observed friction:** the following prerequisites are **required, load-bearing, and documented nowhere an operator would look**:
  1. **Registry hashes "come from a governor-prepared registry, which is prepared out of band"** — `README.md:213`. A ten-`--hash` `preregister-acquisition` invocation is required, with values the operator cannot derive. The strategy reconciliation calls this *"a real onboarding wall."*
  2. **`QUALIBER_ERL2_LAB_CHECKOUT` must be set** for `npm run test:adapters` to build the adapter against the pinned Lab.
  3. **`--dependency-anchor` is mandatory on every comparator run** (FR-04); omission is exit 3.
  4. **Anchor and fixture-root paths must be absolute** (FR-07); relative silently produces a different refusal.
  5. **`--retain-fixtures` deletes and recreates its target directory** before writing — destructive by default, undocumented.
  6. **Retained inputs are written read-only** (FR-09).
  7. **`ajv` resolves to 8.20.0 against a declared 8.17.1**, and a **vendored `@erl2/contracts` diverges from current Lab bytes** — both recorded as limitations, neither as an onboarding prerequisite.
* **Evidence reference:** Lab `README.md:213`; both campaigns' command logs; Wave 2 `plan/campaign-plan-application.md` §3.1; `compare-scenario.test.mjs` `RETAIN_FIXTURES` branch; strategy reconciliation §4 item 8
* **Exact commands/files required:** items 2–6 are retained verbatim in the Wave 1 and Wave 2 command logs; item 1's ten-`--hash` invocation is described in the runbook but its **values** are not retained anywhere
* **Workaround used:** insider knowledge, carried forward by the same operator across all three campaigns
* **Task-local?** Not applicable
* **Recurrence:** **three campaigns**
* **Operator impact:** **this is the onboarding wall.** Every item is invisible until it fails.
* **Risk:** **onboarding failure — decisive.** Item 1 alone would stop a newcomer outright.
* **Classification:** Lab usability defect
* **Owner:** Reality Lab (items 1, 3–7); Qualiber (item 2)
* **Disposition:** open
* **Productization requirement implied:** **this list is the workspace compiler's requirements document.** Item 1 in particular defines what "prepared out of band" must stop meaning.
* **Blocks workspace-compiler design?** **No — it is the reason design is now unblocked.** Design should not have started before this list existed; it now does.

---

## A1.1 · Recurrence summary

| friction | 2026-08-16 | Wave 1 (08-18) | Wave 2 (08-19) | task-local workaround? |
|---|---|---|---|---|
| FR-01 provisioning/materialization | ● | — | — | yes |
| FR-02 offline-verification runner | ● | ● | ● (reused) | yes, twice authored |
| FR-03 scenario plan + binding burden | — | ● | ● | scratch only |
| FR-04 dependency anchor | — | ● | ● | no |
| FR-05 canonical topology | ● | ● | ● | no |
| FR-06 identity preparation | — | ● | ● | scratch only |
| FR-07 absolute-path exposure | ● | ● | ● **caused a false test failure** | no |
| FR-08 operation-order diagnostics | latent | latent | latent | n/a |
| FR-09 cleanup / scratch / file modes | ● | ● **NC-5 aborted** | ● **handled** | yes |
| FR-10 evidence indexing | ● | ● | ● | yes, three times |
| FR-11 four status signals | — | ● | ● | tested, not documented |
| FR-12 exit code ≠ verdict | — | ● | ● | tested, not documented |
| FR-13 dogfood label in record bytes | ● absent | ● sibling note | ● sibling note | no field exists |
| FR-14 undocumented prerequisites | ● | ● | ● | insider knowledge |

**Twelve of fourteen recur across two or more campaigns; FR-01 does not recur, and FR-08 is
latent in all three campaigns rather than observed. Four were papered over with task-local
scripts. Two (FR-01, FR-02) are, by the strategy reconciliation's own assessment, the concrete
specification of what the workspace compiler must absorb.**

---

# A2 · Findings register

Fields per the operating plan §6 required set. `owner decision required` is used wherever the
retained evidence does not decide a field; no severity, ownership or disposition is invented.

---

### F-01 — Qualiber #372: adapter artifact identity / two-artifact completeness

* **Finding ID:** F-01
* **Primary classification:** Qualiber product defect
* **Severity:** owner decision required *(no severity label appears in the retained advisories)*
* **Affected quality dimension:** artifact identity and build completeness
* **Exact reproduction scenario:** build the adapter from a clean checkout with canonical package-local tarball topology and assert `2 of 2 declared artifact(s)` with matching artifact/manifest/core/receipt-input digests
* **Evidence references:** `qualiber-issue-372-external-confirmation.md` (verdict `#372 EXTERNALLY CONFIRMED AND CLOSED`; `built : 2 of 2 declared artifact(s)`; `sealed : 2 of 2`; `12/255` adapter result; deterministic build and manifest reseal); independently re-established in Wave 2 — artifact `c65c6393…` (41,472 bytes), manifest file `91e830d2…`, core `504ab99b…`, receipt input `a0bc5288…`, all exact, with **255/255** product tests green
* **Affected coordinates:** Qualiber `preprod` `d3ebf37fc2cd5741c25eac22eaa20777153730ce` / tree `0d2a8c4de0196972ef1ed8844b3746a4cfa5df3a`; fix PR #377 merge `3afc760f…`
* **Assigned owner:** **Qualiber** — the fix was product-owned; the plan records that the merged product "deliberately has no per-artifact scripts (its `ARTIFACTS` declaration drives one build path — Qualiber's own fix for its issue #372)"
* **Disposition:** **CLOSED / COMPLETED**, closed `2026-08-18T16:04:55Z` after external confirmation
* **Regression requirement:** assert `2 of 2 declared artifact(s)` and the four identity digests on every campaign build. **Met in Wave 2.**

---

### F-02 — Qualiber #373: stale / corruption refusal

* **Finding ID:** F-02
* **Primary classification:** Qualiber product defect
* **Severity:** owner decision required
* **Affected quality dimension:** refusal correctness on stale or corrupt build inputs
* **Exact reproduction scenario:** `qualiber-issues-372-374-external-confirmation.md` §6, reproduced from four independent worktrees pinned to `3afc760…` (tree `8e6e30db…`), each with its own locked `npm ci` and four distinct `node_modules` inodes
* **Evidence references:** that advisory §6; issue comment `#373#issuecomment-5322794971`
* **Affected coordinates:** Qualiber `3afc760f336c938aba94cd557c94bf5e308d63da`
* **Assigned owner:** **Qualiber**
* **Disposition:** **CLOSED / COMPLETED** (`2026-08-18T02:37Z`) — external confirmation passed
* **Regression requirement:** owner decision required — no regression obligation is recorded in the retained advisories

---

### F-03 — Qualiber #374: topology completeness

* **Finding ID:** F-03
* **Primary classification:** Qualiber product defect
* **Severity:** owner decision required
* **Affected quality dimension:** build-input topology validation
* **Exact reproduction scenario:** provision Lab packages but deliberately skip `install-collector-from-tarball.mjs`, leaving root `node_modules/@qualgraph/collector` a symlink into `packages/collector`; the build must refuse **before writing bytes**
* **Evidence references:** `qualiber-issues-372-374-external-confirmation.md` §4 (refusal codes and "bytes written" columns); issue comment `#374#issuecomment-5322794825`; canonical topology independently re-established in Wave 1 and Wave 2 (`topology: package-local-tarball`, all peers real directories)
* **Affected coordinates:** Qualiber `3afc760f…`
* **Assigned owner:** **Qualiber**
* **Disposition:** **CLOSED / COMPLETED** (`2026-08-18T02:37Z`)
* **Regression requirement:** confirm `package-local-tarball` topology and absence of workspace symlink topology on every campaign build. **Met in Wave 2.**

---

### F-04 — Lifecycle / `start`-without-`stop` profile mismatch

* **Finding ID:** F-04
* **Primary classification:** Qualiber product defect *(corrected product-side)*
* **Severity:** owner decision required
* **Affected quality dimension:** adapter lifecycle declaration / clean-terminal reachability
* **Exact reproduction scenario:** declare an adapter profile containing `start` but not `stop`; every operation dispatches and completes, yet the run terminates `cleanup_incomplete`
* **Evidence references:** ADR-ERL2-042; `trusted-local-observation-operator-surface.md`; strategy reconciliation §5.1–§5.3 (L-1 … L-12). **Both published Qualiber profiles — the ten-operation live-service profile (manifest `984dfcbd…`) and the two-operation validation profile (`91e830d2…`) — declare no `start`.** All six published records carry `cleanup.stop: "not_applicable"`, `cleanup.status: "cleanup_complete"`, `terminal_status: "observed_complete"`. Wave 2's three records reproduce this.
* **Affected coordinates:** the superseded, **unpublished** eleven-operation profile revision recorded in ADR-ERL2-042; corrected in Qualiber's own adapter package
* **Assigned owner:** **Qualiber** — the correction was product-owned. The Lab neither made it nor requested a Lab-specific accommodation, and **Lab cleanup semantics were not weakened**: `start`/`stop` remain members of `AdapterOperationId` and the ADR rule remains true and enforced.
* **Disposition:** **RESOLVED product-side.** The Lab-side evidence independently confirms the *effect*; it cannot and does not confirm Qualiber-side deliberation.
* **Regression requirement:** confirm `cleanup.stop: not_applicable` and `cleanup.status: cleanup_complete` on every published record. **Met in Wave 2.**

---

### F-05 — Missing public provisioning / materialization path

* **Finding ID:** F-05
* **Primary classification:** Lab usability defect
* **Severity:** owner decision required
* **Affected quality dimension:** operator onboarding; public-surface completeness
* **Exact reproduction scenario:** attempt to provision an external-service substrate for an owner-trusted local observation using only public commands; the governed provisioning command demands registry and acquired-run state that does not apply
* **Evidence references:** FR-01; `substrate/task-local-substrate.mjs` and bundle `README.md` lines 65–70 in the 2026-08-16 bundle
* **Affected coordinates:** Reality Lab `561d782a92543b95246cce6405cf1cea258edd63` (2026-08-16 committed baseline); the gap persists at `87a87e535db6f74f95f6de5f14b4870d973b00d7`
* **Assigned owner:** **Reality Lab**
* **Disposition:** **open** — recorded as a bundle limitation, never as friction with an owner and a disposition. This register supplies both.
* **Regression requirement:** once a public path exists, a campaign must reach provisioning without any task-local script, and that must be asserted

---

### F-06 — Missing public offline-verification invocation path for the campaign context

* **Finding ID:** F-06
* **Primary classification:** Lab usability defect
* **Severity:** owner decision required
* **Affected quality dimension:** operator onboarding; verification reachability
* **Exact reproduction scenario:** from a campaign context, attempt to run `verifyTrustedLocalObservationRecord` without authoring a runner; `@erl2/core` is unreachable through the comparator's dependency anchor
* **Evidence references:** FR-02; Wave 1 execution report §8 deviation 4; `oracle-precommit.json` `campaign_local_verification_runner` block and its written justification; `run-offline-verification.mjs` `9ff27ced…` reused unchanged in Wave 2
* **Affected coordinates:** Reality Lab dependency pin `69ace16fb7ee021dddbcf3fa70e4295c2e5a400b`; campaign baseline `87a87e53…`
* **Assigned owner:** **Reality Lab**
* **Disposition:** **open** — worked around in three consecutive campaigns
* **Regression requirement:** once a public path exists, a campaign must verify without a fourth task-local script, and the precommit's `campaign_local_verification_runner` field should become unnecessary

---

### F-07 — NC-2 plan-label erratum

* **Finding ID:** F-07
* **Primary classification:** scenario defect *(a plan-table label, not a tooling or product defect)*
* **Severity:** owner decision required
* **Affected quality dimension:** plan accuracy
* **Exact reproduction scenario:** delete `run-result.json` from a disposable copy and compare; plan §11's row anticipates `unavailable` / `unavailable` via §10.5 rule 5, but the deletion **also** breaks the adapter's `artifact_hashes` witness, and §10.5 rule 7 requires the binding gate to run *before* any comparison — so the refusal classifies as `lab_harness_failure` and rule 5 is never reached
* **Evidence references:** Wave 1 `NC-2.result.json` and `negative-controls/README.md`; Wave 2 reproduced the same outcome having **precommitted it prospectively** (`oracle-precommit.json` NC-2 entry: `unavailable` required, binding-first `lab_harness_failure` **accepted**, `clean` never observable, binding precedence **not** to be weakened)
* **Affected coordinates:** plan revision 4.3 §11 (`b1105dc7…`), unamended
* **Assigned owner:** **Reality Lab**
* **Disposition:** **behaviour confirmed correct; the plan label is the erratum.** The comparator was **not** edited to match the table — the only way to do so would be to relax the binding-first rule the plan mandates. Rule 5 remains covered directly by tooling test **T7**, which passed in both campaigns. Whether to issue a plan erratum is **owner decision required**; this draft does not amend the plan.
* **Regression requirement:** NC-2 must continue to yield `unavailable` with `clean` never observed, and the binding-first ordering must remain unweakened. **Met in Wave 2.**

---

### F-08 — NC-5 void first mutation attempt, and the corrected procedure

* **Finding ID:** F-08
* **Primary classification:** Lab correctness defect *(campaign-procedure correctness)*
* **Severity:** owner decision required — but note this is the one finding where a control **nearly reported a false pass**
* **Affected quality dimension:** negative-control validity
* **Exact reproduction scenario:** attempt to flip one byte of a retained input stimulus without first making the copy writable; the host writes retained inputs `0400`/`0444`, the write is refused, the bytes are unchanged, and **both refusal legs pass trivially** — a control that did not run reads as a control that held
* **Evidence references:** Wave 1 `NC-5.result.json` (aborted first attempt recorded, not hidden; re-run with the flip verified by digest `78210e2e…` → `431f94c9…`); Wave 2 `NC-5.result.json` — corrected procedure **precommitted in advance**, copy made writable, one byte changed at offset 240, digest change **proven** (`fef741e0…` → `3f2a8c46…`) *before* either leg ran; both legs refused (verifier: *"retained input capture-stimulus/stimulus.json no longer hashes to the digest the plan declares"*; comparator: `input_digest_binding_failed`). **No aborted attempt occurred in Wave 2.**
* **Affected coordinates:** Wave 1 campaign scratch; Wave 2 campaign scratch
* **Assigned owner:** **Reality Lab**
* **Disposition:** **corrected and verified.** Wave 1 recorded the aborted attempt honestly rather than reporting it as a pass; Wave 2 precommitted the corrected procedure and executed it. The underlying file-mode friction (FR-09) remains **open**.
* **Regression requirement:** every future NC-5 must record pre- and post-mutation digests and prove the change before running either leg. **Met in Wave 2.**

---

### F-09 — Unsupported system-temp residue assertion in the unpublished report

* **Finding ID:** F-09
* **Primary classification:** Lab correctness defect *(report accuracy — scope is the report only)*
* **Severity:** **minor** *(as classified by the independent evidence review, M-1)*
* **Affected quality dimension:** report accuracy / claim support
* **Exact reproduction scenario:** search the Wave 1 bundle for a system-temp residue scan artifact and search the command log for a corresponding row; both are absent, yet execution report line 157 asserts *"zero `qualiber-erl2-validate-*` directories remain anywhere in the system temp tree"*. Plan §1057 requires that scan to be run independently by the operator.
* **Evidence references:** `qualiber-wave1-independent-evidence-review.md` **M-1**; Wave 1 `commands/command-log.tsv` (36 distinct labels, none matching)
* **Affected coordinates:** `qualiber-wave1-prospective-execution-report.md` line 157 — **an unpublished report**, not the published bundle
* **Assigned owner:** **Reality Lab**
* **Disposition:** **open.** Scope is strictly the execution report. The **bundle's own claim is supported**: all five records carry `residue_observations: [{checkpoint: final, status: clean, residual_resource_count: 0, residual_path_count: 0}]` and `cleanup.status: cleanup_complete`. The review's recommendation — run and retain the scan, or strike the sentence, in a separate correction step, **without modifying the bundle** — is **not executed here**, because this task must not amend Wave 1.
* **Regression requirement:** a report may assert only what a retained artifact or a command-log row supports. Wave 2's report asserts residue only from record bytes (`cleanup_complete` / `observed_clean`) and makes no system-temp claim.

---

### F-10 — Paused-campaign capture overstatement

* **Finding ID:** F-10
* **Primary classification:** Lab correctness defect *(bundle-document accuracy)*
* **Severity:** **minor** *(independent evidence review, M-2)*
* **Affected quality dimension:** provenance accuracy
* **Exact reproduction scenario:** Wave 1 `plan/campaign-plan-application.md` §4 states the paused 2026-08-17 campaign's "opening state is recorded in `coordinates/` and re-checked at close." `coordinates/` contains **no** paused-campaign record — its ten files cover only Qualiber and Reality Lab. The only supporting artifact is command-log row 69, a **close-time** read-only `git status` with **no captured output and no opening counterpart**.
* **Evidence references:** `qualiber-wave1-independent-evidence-review.md` **M-2**; Wave 1 `coordinates/` (ten files); command-log row 69 `phase9:preservation-checks`
* **Affected coordinates:** Wave 1 published bundle, `plan/campaign-plan-application.md` §4 — **inside the published bundle**
* **Assigned owner:** **Reality Lab**
* **Disposition:** **open.** The **substantive claim holds**: an exhaustive search for `20260817` / `ext-wave1` across the bundle returns only that prose sentence and that one command-log row — **no paused-campaign evidence was copied**. Correction requires a separate step and must not be made here.
* **Regression requirement:** provenance prose must describe what was actually captured. Wave 2 states plainly that no paused-campaign or Wave 1 scenario output was copied, and its `coordinates/` covers exactly the three worktrees it used.

---

### F-11 — Operation-order diagnostic quality

* **Finding ID:** F-11
* **Primary classification:** Lab usability defect
* **Severity:** owner decision required
* **Affected quality dimension:** diagnosability
* **Exact reproduction scenario:** declare operations in an order that does not positionally match the profile; observe the refusal *"the adapter process ended without a valid response"*, which names a process failure rather than the declaration-order mismatch that caused it
* **Evidence references:** FR-08; `trusted-local-observation-operator-surface.md`; ADR-ERL2-042; strategy reconciliation §4 item 8. **Not triggered in any campaign** — all three used the correct `interact → report-residue` order, so no retained bytes exercise it.
* **Affected coordinates:** Reality Lab `87a87e53…` (documented behaviour)
* **Assigned owner:** **Reality Lab**
* **Disposition:** **open**
* **Regression requirement:** owner decision required — a regression test would first require a deliberate order-mismatch fixture, which no campaign has authored

---

### F-12 — Dependency-closure limitation

* **Finding ID:** F-12
* **Primary classification:** expected limitation
* **Severity:** **accepted, not closed** *(explicitly, in both campaigns' claim ceilings)*
* **Affected quality dimension:** supply-chain / dependency integrity
* **Exact reproduction scenario:** inspect `execution-lock.json` `comparator_dependencies.resolved`; it binds `name`, `version` and **entrypoint** digest only. `@erl2/integrity`'s entrypoint re-exports `coreHash` from `./hash/hash.js`, so the implementing file is **not** covered by the entrypoint digest.
* **Evidence references:** Wave 1 and Wave 2 `execution-lock.json` `comparator_dependencies.limitation`; both `claim-ceiling.verbatim.txt`. Wave 2 resolved the identical entrypoint digests as Wave 1 — `@erl2/contracts` `da45bec0…`, `@erl2/integrity` `c927d02c…` — and the identical tarball digests, from the same pinned Lab commit.
* **Affected coordinates:** Reality Lab dependency pin `69ace16f…` / tree `89988e55…`
* **Assigned owner:** **Reality Lab**
* **Disposition:** **accepted under the trusted-local claim ceiling; explicitly not closed.** No package-tree inventory is added. Together with the provisioning receipt this establishes neither complete dependency closure nor the absence of post-install mutation inside a package.
* **Regression requirement:** the limitation must continue to be stated verbatim in the claim ceiling of every campaign. **Met in Wave 2.**

---

### F-13 — Unconfined execution

* **Finding ID:** F-13
* **Primary classification:** expected limitation
* **Severity:** **accepted and prominently disclosed**
* **Affected quality dimension:** isolation / trust tier
* **Exact reproduction scenario:** run any trusted-local observation; the adapter executes as an ordinary child process with the operator's own user permissions, not sandboxed, not confined to a workspace, not isolated from the operator's filesystem or network
* **Evidence references:** the CLI's own `trust_warning` block, emitted at both declare and run time and retained in every campaign's stdout; record bytes `independent_certification: "absent"`, `confinement: "absent"`; both claim ceilings; the operator acknowledgement token, which requires the operator to type the acceptance verbatim
* **Affected coordinates:** all three campaigns
* **Assigned owner:** **Reality Lab**
* **Disposition:** **accepted; disclosed in record bytes, in tool output and in the claim ceiling.** No `network-egress` capability was requested and no HTTP operation was intentionally performed — but that is a *capability declaration*, not confinement, and both campaigns say so explicitly.
* **Regression requirement:** the disclosure must remain in record bytes and in the claim ceiling. **Met in Wave 2.**

---

### F-14 — Missing onboarding-time measurement

* **Finding ID:** F-14
* **Primary classification:** Lab usability defect *(a measurement obligation, unmet)*
* **Severity:** owner decision required
* **Affected quality dimension:** operator experience — the dimension the strategy reconciliation records as having **"no operator-experience measurement of any kind"**
* **Exact reproduction scenario:** search every bundle, command log and retained report for a time-to-first-run figure from a fresh checkout; none exists. Operating plan §10's "under 30 minutes" target is unmeasured in both directions.
* **Evidence references:** strategy reconciliation §4 item 2 (**UNMET**), §6 usability row (**No**), §7 (`friction log present and adequate` — **NO — absent entirely**)
* **Affected coordinates:** all three campaigns
* **Assigned owner:** **Reality Lab**
* **Disposition:** **open — and not closable retrospectively.** The measurement requires a fresh operator on a fresh checkout; it cannot be reconstructed from mtimes, UUIDv7 timestamps, reconstructed logs or report timestamps, and this draft declines to manufacture it. Recorded exactly as **`elapsed onboarding time: not measured`** (§0).
* **Regression requirement:** the next genuinely-new onboarding must be measured prospectively, by wall-clock, from clean checkout to first admitted observation

---

### F-15 — Zero Wave 1 product disagreements *(observation, not a finding)*

* **Finding ID:** F-15
* **Primary classification:** **not a finding** — recorded here as an **observation**, because the register would otherwise be silent about the campaigns' headline result
* **Severity:** not applicable
* **Affected quality dimension:** not applicable
* **Exact reproduction scenario:** all five Wave 1 comparisons returned `agree` / `product_agreement`, each within its precommitted finding-set bounds; **no Qualiber issue was filed**
* **Evidence references:** Wave 1 execution report §4 and §9 criterion 7; five retained `comparison.json` files; independently re-derived at publication and again at merge
* **Affected coordinates:** Qualiber `d3ebf37f…`; Reality Lab `3d2655f6…` → `87a87e53…`
* **Assigned owner:** not applicable
* **Disposition:** **recorded as an observation.** It is **not a finding** and **not a broad product pass.** The Wave 1 report states the boundary in its own words: *"These are five bounded scenario outcomes. The campaign is not called 'passed' merely because every comparator agreed — five inputs matched five precommitted expectations, and that is the whole of it."* The claim ceiling refuses correctness claims outside those five scenarios, and five agreements from a **first-party dogfood** are not independent assurance.
* **Regression requirement:** not applicable
* **Wave 2 addendum:** Wave 2 likewise produced **zero candidate product disagreements** across QLB-EXT-006/007/008. The same boundary applies with equal force — three scenarios exercising cardinality, payload-presence and payload-type enforcement are **not** a broad product pass.

---

## A2.1 · Register summary by classification

| classification | findings |
|---|---|
| Qualiber product defect | F-01 (#372), F-02 (#373), F-03 (#374), F-04 (lifecycle) — **all four resolved or closed, all product-owned** |
| Qualiber usability defect | — *(none supported by retained evidence as distinct from F-01…F-04)* |
| adapter defect | — *(none; the adapter's own suite is green at 255/255 and every identity digest reproduced exactly)* |
| Lab correctness defect | F-08 (NC-5 void mutation), F-09 (unsupported residue assertion), F-10 (paused-campaign overstatement), and FR-13's commitment gap |
| Lab usability defect | F-05, F-06, F-11, F-14 |
| scenario defect | F-07 (NC-2 plan-label erratum) |
| expected limitation | F-12 (dependency closure), F-13 (unconfined execution) |
| observation, not a finding | F-15 (zero product disagreements) |

**Nothing in this register attributes a product defect to Qualiber that Qualiber did not already own
and close.** The open items are overwhelmingly Lab-side onboarding and reporting debt.

---

# A3 · Documentary-closure verdict

Assessed against productization step 1's named exit condition — *"operating plan §12's six conditions
hold; **friction log written**"* — and against strategy reconciliation §4 items 2, 8 and 9.

| required artifact | supplied by this draft? | assessment |
|---|---|---|
| **the missing friction log** | **Yes** | Fourteen entries, each with the full seventeen-field set, reconstructed from retained bytes across three campaigns. Twelve of the fourteen are shown to recur across two or more campaigns; FR-01 does not recur, and FR-08 is latent in all three campaigns rather than observed; four were papered over with task-local scripts. This closes §4 item 8's "**None is recorded as onboarding friction with an owner and a disposition**" — every entry now carries both. |
| **the findings register** | **Yes** | Fifteen entries carrying the operating plan §6 required fields. This closes §4 item 9's "no committed findings register carrying the operating plan §6 fields," subject to adoption. M-1…M-3 and I-1…I-6 no longer live only inside an unpublished report. |
| **an honest replacement for the missing onboarding-duration measurement** | **Yes — by refusal, which is the honest replacement** | §0 records exactly `elapsed onboarding time: not measured`, states the target is unmeasured **in both directions**, and lists observed timestamps only as explicitly non-authoritative chronology. No duration is derived from mtimes, UUIDv7 timestamps, reconstructed logs or report timestamps. F-14 records the gap as open and not closable retrospectively, with a prospective measurement obligation. **This does not make the measurement exist.** |
| **concrete workspace-compiler requirements** | **Yes** | FR-01 and FR-02 are the two task-local scripts the strategy reconciliation identified as "the concrete specification of what the compiler must absorb, and nobody has written down what they absorbed" — now written down, with their exact invocations and imports. FR-14 enumerates seven undocumented prerequisites, including `README.md:213`'s "prepared out of band" onboarding wall. FR-11 and FR-12 are **constraints**: any compiler that collapses the four status signals into one verdict, or presents a process exit code as a verdict, is wrong by construction. |

## What this draft deliberately does not do

* It **does not declare productization step 1 formally closed.** Step 1 remains *technically complete
  but awaiting named documentary closure*; closure requires **owner review and repository adoption**
  of these two artifacts, which has not occurred.
* It **does not begin workspace-compiler design.** It supplies the requirements input that design was
  missing; the design itself is out of scope and not started.
* It **does not decide PS-5**, and makes no policy decision of any kind. FR-13 identifies a genuine
  policy fork (accept sibling-note labelling, or require the label in record bytes) and leaves it
  explicitly as **owner decision required**.
* It **does not amend** the operating plan, the productization strategy, the TPM orchestration
  runbook, the reviewed test plan, or any Wave 1 byte. F-09 and F-10 identify corrections that are
  needed; each is marked for a **separate** step, and neither is executed here.
* It **invents no severity, ownership or disposition.** Every field the retained evidence does not
  decide is marked `owner decision required`.
* **This adoption resolves where these two artifacts live and how they are adopted; it does not
  resolve the outstanding policy or design questions found elsewhere in this document.** The owner
  has resolved:
  1. **repository and exact path** — Reality Lab, at
     `docs/ledger/stage1-friction-log-and-findings-register.md`;
  2. **adoption method** — **one documentation-only pull request**, not split;
  3. **documentary-closure effectiveness** — Stage 1 documentary closure becomes effective **on
     merge** of this file to Reality Lab `main`; the missing onboarding-duration measurement
     (§0, F-14) remains an **open measurement obligation** and is not, and cannot be, satisfied by
     this adoption — **no claim in this document states that the under-30-minute target (operating
     plan §10) was met.**
  This adoption does **not** resolve **PS-5**, the first-party-dogfood record-label fork
  (FR-13/F-13), any severity, ownership or disposition still marked `owner decision required`
  elsewhere in this document, or **workspace-compiler design**. These four states remain distinct
  and are not collapsed here: **technical Stage 1 exit**, **documentary draft completeness**,
  **formal owner acceptance**, and **repository adoption**. This file, once merged, is the record
  of repository adoption only.

## Residual gaps a reviewer should weigh

1. **F-14 is unclosable by documentation.** The friction log is written, but the onboarding-time
   measurement is not a documentation artifact — it requires a fresh operator on a fresh checkout.
   Step 1's exit condition names only the friction log, so this may not block closure; **that reading
   is the owner's to confirm.**
2. **F-09 and F-10 remain uncorrected**, by design. One touches an unpublished report, the other a
   published bundle document. Correcting the latter means touching Wave 1, which this task forbids.
3. **FR-13's policy fork is open** and blocks nothing, but leaves strategy §7.2 commitment 2 only
   partially honoured.
4. **F-11 has no retained reproduction** — no campaign triggered the operation-order path. Its entry
   rests on committed documentation, not on observed bytes.

---

**This line is conditional while this pull request remains open: it becomes true only upon merge
of this file to Reality Lab `main`. Until merged, Stage 1 documentary closure has not occurred, and
this document remains an adoption candidate, not an adopted record.**

STAGE 1 DOCUMENTARY CLOSURE — EFFECTIVE ON MERGE TO REALITY LAB MAIN
