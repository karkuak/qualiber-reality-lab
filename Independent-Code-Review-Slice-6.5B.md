# Independent Code Review — Slice 6.5-B/C/D/E (environment walk)

**Reviewer role:** independent principal engineer, security reviewer, verification auditor
**Review type:** focused, read-only review of the incremental 6.5-B/C/D/E work
**Date:** 2026-07-28
**Normative revision:** `2.0.0-draft.11` (confirmed independently)

---

## 0. Workspace facts

Recorded from the repository, not assumed from the handoff.

| Item | Value |
|---|---|
| Base branch | `slice-6.5a-selection-chain` @ `fa41388` |
| Review head at review start | `slice-6.5b-environment-walk` @ `62158c3` |
| **Head at report time** | **`bd71a7f`** |
| Merge base | `fa41388` — so `...` and `..` are equivalent |
| `main` | `176b43b` |
| Working tree | only `external-reality-lab-slice-6.5B-continuation-prompt.md` (the permitted pre-existing change) |
| Node / platform | v26.4.0 / darwin arm64 (project targets `>=22`) |
| Diff size | 528 files, +10216 / −1019 |
| New source/test files | 9 |
| New ADRs | ADR-ERL2-021, -022, -023 |
| `git diff --check` | one hit: new blank line at EOF, `packages/cli/src/environmentCommands.ts:631` |

### 0.1 The head moved during this review

The brief expected the head at `74d1741`. It was already three commits further on (`9378af2`, `7a3937f`, `62158c3`), and **two more commits landed from the repository owner at 17:45 while the review was running**:

- `b2c0ea7` — *negative-control: repair three controls the campaign proved were measuring nothing*
- `bd71a7f` — *ledger: record what the negative-control campaign found on its first real run*

At review start, three source files were uncommitted (`packages/cli/src/journeyCommands.ts`, `scripts/negative-control.mjs`, `tests/adversarial/environmentCommands.test.ts`). `b2c0ea7` promoted exactly those. The tree measured throughout this review was verified **byte-identical to `bd71a7f`** for all three files, so every measurement below applies to the current head.

### 0.2 Review hygiene

- No file in the repository was modified, created, staged or deleted during the review, with the single exception of this report file.
- All builds, mutations and negative-control campaigns ran in scratch copies and in a `git clone` outside the repository.
- The Qualiber directories were not inspected, searched or executed.
- Live-tree state was digest-checked before and after; it is unchanged apart from the pre-existing continuation-prompt edit.

---

## 1. Verification gate

`npm run clean && npm install && npm run build && npm run typecheck && npm run verify:generated && npm test && npm run purity && npm run evidence && npm run evidence:verify` → **exit 0** on every step.

| Claim under test | Measured | Verdict |
|---|---|---|
| tests pass / fail / skipped | **541 / 0 / 0** | confirmed |
| architecture/purity tests | **24** | confirmed |
| byte pin | **781 pinned, 7 excluded** | confirmed |
| golden tree manifest | **`b84b9275b3bfa6fe8c11270c26e5ea7ccbb1e5e42845b41c423fabc6c3bd268c`** | confirmed |
| 21 durable CLI processes | 21 separate `erl2` invocations, each exit 0 | confirmed |
| `erl2 verify --offline` | exit 0, verdict `valid`, variant `environment`, stage `remove`, 0 missing roles, 0 rejected extras | confirmed |
| fail-closed without pinned beacon | exit 3 `RANDOMNESS_SOURCE_NOT_PINNED` | confirmed |
| `select --request` refused | exit 2 `CFG_UNKNOWN_FLAG` | confirmed |
| evidence generation is non-destructive | full gate, **including the regenerating `npm run evidence`**, rewrote **zero** files | confirmed |

The handoff's numbers were stale at `62158c3` (535 tests, 780 pinned, manifest `2f88eb5c…`). I computed the manifest at each commit: `2f88eb5c…` was correct at `74d1741` and broke at `9378af2`, which added `fixtures/golden/environment-run/closure-summary.json` (787 → 788 files). **`bd71a7f` corrects all of these**, and every corrected number was re-verified against the tree.

### 1.1 Negative-control campaign

Run in a `git clone` at head. **All ten controls matched their recorded expectations; the tree was byte-identical afterwards.**

| Control | Result | Proves |
|---|---|---|
| `activate-connect-guard` | 10 pass / **1 fail** | succeeded-connect requirement exercised |
| `freeze-output-outstanding-step-guard` | 10 pass / **1 fail** | no freeze while a step is owed |
| `step-order-guard` | 11 pass / **1 fail** | journey reordering refused |
| `durable-substrate` | 6 pass / **17 fail** | cross-process substrate |
| `restore-receipt-status` | 3 pass / **5 fail** | restoration receipt status enforced |
| `emergency-route` | 4 pass / **4 fail** | mandatory emergency cleanup |
| `subject-output-canary-scan` | 11 pass / **1 fail** | output scanned before freeze |
| `environment-bundle-verifier` | 10 pass / **7 fail** | verifier reached by real bundles |
| `baseline-repeatability` | 12 pass / 0 fail | honestly recorded as *not* load-bearing |
| `case-selected-comparisons` | 21 pass / 0 fail | honestly recorded as *not* load-bearing |

Method note: the campaign was first run at `62158c3`, where it **failed** with three disagreements — the connect guard's *succeeded* half was not load-bearing (9 pass / 0 fail where a failure was expected), and two patches no longer compiled. The owner's concurrent commits repair exactly those and document them in ledger §10a. **Remediated at head.**

---

## 2. Findings

Ordered by severity. Every P0/P1 was verified at source by the reviewer directly; the wider set came from a 13-dimension fan-out in which each candidate finding was independently adversarially refuted. Verdicts are marked.

### P0

#### P0-1 — `--substrate-root` is ungated and unattested: a valid attestation over an environment that was never torn down

- **Severity:** P0 (false valid attestation)
- **Normative requirement:** design v2 §14 / ERL2-AC-031 — cleanup verdicts must derive from the Lab's own observation of the environment; ADR-ERL2-021 §2 — development-only shortcuts are refused on the release surface.
- **Location:** `packages/cli/src/environmentCommands.ts:56-64` (declaration), `:109-112` (resolution), `:250` (use).
- **Evidence:** `{ name: "substrate-root", kind: "string" }` is declared in `ENVIRONMENT_FLAGS` with **no** development-profile check. The flag immediately below it, `--fake-driver-fault`, *is* explicitly gated at `:85-95` with `CFG_DEVELOPMENT_FLAG_UNAVAILABLE`. `substrateRoot()` returns the caller's value or defaults to `<run-root>.substrate`. A repository-wide grep for `substrate_root` / `substrateRoot` returns only those two CLI sites: **the substrate path is bound into no contract, no receipt and no attestation field.**
- **Reproduction:** drive a normal environment walk; then run `destroy` and `finalize-generic` with `--substrate-root` pointed at a fresh empty directory. The driver observes no resources, records a clean teardown, and finalization emits a signed attestation whose bundle verifies offline at exit 0.
- **Impact:** the Lab's own observation channel is caller-redirectable and unrecorded. An offline verifier cannot detect the substitution because no retained artifact names the substrate that was observed. This is a mechanism for a false valid attestation, which is the P0 definition in the brief.
- **Why tests missed it:** every test passes the default substrate root and never varies it *between phases* of one run.
- **Minimal remediation:** gate the flag behind the development profile, and bind the resolved substrate identity into the provision receipt so later phases must observe the same substrate or refuse.

### P1 — cleanup, cancellation and terminal reachability

| # | Finding | Location | Verdict |
|---|---|---|---|
| P1-1 | `emergencyCleanup` issues an unconditional whole-environment `driver.destroy()` **before** consulting its frontier, then records frontier-unsafe resources as skipped and untouched — the attestation contradicts the action taken | `environmentRun.ts:~2457` vs `:2466-2479` | CONFIRMED |
| P1-2 | `erl2 cancel` is not branch-dispatched: cancelling a live environment run freezes a **pre-environment** cleanup terminal claiming `not_required` while the environment and its reservation leases are still allocated — and the shipped verifier accepts it | `packages/cli/src/index.ts`, `JOURNEY_COMMANDS.cancel` (undispatched, unlike the four branch-dispatched commands at `:233-237`) | CONFIRMED ×2 |
| P1-3 | `invalidityFindingHashes: []` is hardcoded, so an environment run with **any** failing validity gate can never reach a terminal — `finalize-generic` dies with `INVALID_REASON_FABRICATED_FINDING` | `environmentRun.ts:1904` | CONFIRMED ×2 |
| P1-4 | Restoration accepts a compensation receipt that provably reverted nothing; the run finalizes to a signed valid attestation | `environmentRun.ts:1666-1776` | CONFIRMED |
| P1-5 | A foreign resource in the frontier aborts emergency cleanup entirely: zero safe actions attempted, no terminal reached, leases retained | `environmentRun.ts:2433+` | CONFIRMED |
| P1-6 | The public verifier accepts an emergency cleanup that **omits** an independently safe action, and accepts a safe action **relabelled** as an unsafe skip — ERL2-AC-035 explicitly requires refusal | `packages/public-verifier/src/library/` | CONFIRMED ×2 |

**P1-3 detail.** `freezeValidityAndIndex` computes `gates: this.environmentGates(input)` at `:1901` and then, on the next line but one, hardcodes `invalidityFindingHashes: []`. A run whose gates fail therefore freezes a validity result asserting failure with zero supporting findings, which the finalizer rejects as a fabricated invalid reason. The result is a durably accepted run with no reachable terminal — the brief's own P1 definition ("terminal-less accepted run").

### P1 — ordering, identity and exactly-once

| # | Finding | Location | Verdict |
|---|---|---|---|
| P1-7 | Subject steps and the challenge-activation mutation are dispatched **before** any durable intent record; a crash between the external call and the lifecycle append re-invokes the driver/port. Proven by instrumented invocation counting, not by artifact counting | `environmentRun.ts:703` (subject), `:782` (activation) | CONFIRMED ×2 |
| P1-8 | No run-identity binding: `openWorkspace(flags, runId)` takes `--run` and `--run-root` independently and never cross-validates them, so `--run <any-uuid>` against another run's root operates on that root under a different claimed identity | `packages/cli/src/journeyCommands.ts:150-163` | CONFIRMED |
| P1-9 | Post-capture intents (exercise / observe / remove) can execute before challenge activation and before the evidence cutoff; the run still finalizes `valid` and verifies offline. `SETUP_INTENTS` is gated only on `state === "execution_plan_frozen"`, i.e. the first step only | `environmentRun.ts:665-670` | CONFIRMED |
| P1-10 | A refused `journey` freezes `retained/environment/cutoff-policy.json` with **no** lifecycle event — a refusal that writes evidence, and one that makes the run's terminal record fail offline verification | `environmentCommands.ts:440-445` | CONFIRMED |
| P1-11 | `verifyEnvironmentBundle` omits attestation-binding and reachability cross-checks that the pre-environment path performs (fan-out measured 9 of 13 missing), including the package binding and the signer-inventory binding | `verify.ts:331-541` vs `:111-330` | CONFIRMED |
| P1-12 | `FileSubstrateStore.load()` swallows **every** read error and returns "never provisioned", so an ordinary permission or I/O fault yields a passing teardown over live resources — no flag required | `packages/core/src/environment/substrate.ts:75-78` | CONFIRMED |

**P1-12 detail.** `try { text = readFileSync(...) } catch { return undefined }`. The caller cannot distinguish "this run was never provisioned" from "I could not read the file". This is the broad-exception-swallowing class the brief asked to be searched for in §8.

### P2 — selected

- **The offline verifier never reads the run's own validity, restoration or teardown verdicts.** Found independently by the reviewer before the fan-out corroborated it. `verify.ts:383` checks `attestation.lab_validity !== "valid"`, but `lab_validity` is a **schema constant** (`packages/core/src/terminal/environmentFinalize.ts:395`, `lab_validity: "valid" as const`), so the check is tautological for any well-formed attestation. The retained `validity-result` artifact's own verdict, and the `passed` fields of `environment-restoration` and `teardown-verification`, are hash-linked and role-required but never inspected. A terminal whose validity says `invalid` with failed gates, and whose cleanup verdicts are `passed: false`, verifies as `valid`. §18 of the brief requires these be independently re-derived.
- **`mounted_file` is scanned with metadata that cannot contain the mounted content.** `environmentRun.ts:1182-1189` scans `JSON.stringify(entry)`, not the entry bytes; the scan can never fire on a real mount leak.
- **Only 2 of the 4 claimed-live oracle surfaces have proven-load-bearing scans.** `adapter_request` (`packages/adapter-sdk/src/sdk.ts:345`) and `subject_output_prefill` (`environmentRun.ts:1368`, covered by a negative control) are load-bearing. `lab_telemetry` (`packages/core/src/capture/capture.ts:206`) is genuinely on the live path — verified — but has no negative control; `mounted_file` is defective per above. The coverage test at `tests/adversarial/oracleSurfaceCoverage.test.ts:58-68` proves only that the *scanner function* detects a canary when handed a target labelled with that surface; it does not prove production *calls* the scanner for that surface, so it cannot catch a dropped scan.
- **Secret canaries and forbidden identifiers are never scanned** on the environment subject-output surface.
- **The declared subject-output size limit is hashed into the adapter request and never enforced.**
- **The evidence cutoff is never re-derived offline**; an observation bundle naming a nonexistent runtime milestone verifies as valid.
- **Retained subject-output payloads have no presence or extra-file accounting** in the offline verifier.
- **`--claim-scope` is operator-supplied and ungated**, so a development-tier fake-driver run can emit an attestation asserting T2/T3 robustness-strength evidence.
- **The invalid terminal's primary finding names a gate derived from the cleanup branch**, not the phase that failed — provably false on the teardown terminal.
- **The offline verifier does not enforce Lab attribution on an invalid environment terminal**: a record blaming the *subject* for a restoration failure verifies exit 0 / valid.
- **ADR-ERL2-023's signed controller receipt is never required by the environment closure**, so an environment terminal without it still verifies valid.
- **The environment signer inventory asserts `complete_for_terminal_chain: true`** while omitting signed members whose authority field is not literally named `signature`.

### P3 — documentation and hygiene

Most of the documentation drift found at `62158c3` was **self-corrected by `bd71a7f` mid-review** and re-verified:

- handoff §1 numbers (535 → 541 tests, 780 → 781 pinned, `2f88eb5c…` → `b84b9275…`) — **fixed**
- handoff §3.5 "No signed controller receipt" — **wrong at head**; it ships, `environmentRun.ts:801-820`, signed with `keys.controller`, per ADR-ERL2-023 §2 — **fixed**
- handoff §3.8 / §7 "No golden environment run" — **superseded**; `9378af2` added one — **fixed**

Remaining P3 drift:

- `docs/decisions/slice-6.5-gap-matrix.md` is wholly stale — still states no selection or environment CLI command exists
- the requirements-ledger ADR registry stops at ADR-ERL2-017; the three ADRs accepted on this branch are unregistered
- ERL2-FR-015 is marked implemented on the strength of "canary scanning on all eight design-named surfaces"; four are scanned
- "Three new keys enter the development trust policy" undercounts — four new root-signed keys, including the controller key
- `permitted-claims.md` and the handoff overclaim "a refusal writes no evidence" for the environment commands (see P1-10)
- the published crash-resumability claim is unbacked: the test cited as its evidence injects no crash
- development-flag gate is bypassed when `--adapter-entry` is present
- `freeze-output --terminal-stage` and `evaluate --finding` are declared and silently ignored
- refused environment commands create empty `<run-root>.substrate` / `.reservations` directories
- trailing blank line at `packages/cli/src/environmentCommands.ts:631`

### Review-process defect (P3)

The negative-control harness has **no signal or timeout handler**. I killed a run mid-campaign and confirmed it leaves a registered `git worktree` and a temp directory behind — the `finally` block does not run on SIGKILL/SIGTERM.

**Critically, the measured tree stayed byte-clean.** Mutations only ever occur inside the disposable worktree, restoration is `git checkout -- .` from the object store, and a tracked-file digest gate proves the tree is unchanged. The earlier "left the source tree patched" incident is genuinely fixed, and the campaign's results are trustworthy. The residue is hygiene, not correctness.

---

## 3. What was verified correct

Stated explicitly, because the brief asked for several of these specifically and a clean result is a result.

- **Phase idempotence is answered from evidence, never from state ordering (§9's critical check).** No phase decides idempotence from a repeated state alone. All thirteen pass an evidence-derived predicate to `enter()` (`environmentRun.ts:281-292`). The one apparent exception, `freeze-observation` (`:1115-1137`), tests three states that each have exactly one producing phase (`states.ts:141-144`), and still falls through to the `observation-bundle` role. Handoff hazard #2 confirmed.
- **Durable operation identity is stable across restarts.** All `operationId`s are phase-derived literals; `LifecycleLog.append` dedupes by `operation_id` with a byte comparison before the transition guard (`packages/core/src/lifecycle/log.ts:139-148`), so a replayed phase is a true no-op.
- **Run lease enforcement.** A foreign live lease written into `state/lease.json` made `erl2 observe` refuse `POLICY_RUN_LEASE_HELD` with zero evidence written.
- **Resumed-phase byte reproducibility.** A crash injected between the `runtime-milestone` freeze and its lifecycle append, resumed >2s later, reproduced the artifact byte-identically. `workspace.productionClock()` (`:284-309`) anchors a stepping clock to the run's own latest durable instant. Handoff hazard #3 confirmed — this is what makes the capture transitions interruptible.
- **Pre-dispatch state validation.** From `execution_plan_frozen`, all six of activate/journey/observe/freeze-observation/restore/destroy refuse with `POLICY_CONFLICT` naming the departing state, before any driver call.
- **Verifier-side closure derivation is genuinely independent.** `deriveEnvironmentClosure` and `deriveEnvironmentPreFinalizationClosure` (`packages/public-verifier/src/library/environmentClosure.ts`) derive required roles from the hash-chained lifecycle, not from any producer array, and the finalizer uses the verifier's own algorithm injected as `deriveClosure`. Pre-environment/environment crossover is refused by explicit forbidden-role lists on both sides.
- **The selection chain is re-derived a third time offline** (`verify.ts:505-531`), and the verified entry — not any producer field — decides what the run answered.
- **CLI tests spawn genuine fresh OS processes** (`tests/support/cliRun.ts:45`, `spawnSync(process.execPath, [cli, ...args])`), so the "21 separate durable CLI processes" claim is architecturally sound and the evidence transcript confirms it empirically.
- **`lab_telemetry` scanning is on a live production path**, not a declaration (`capture.ts:204-211`, called from `environmentRun.freezeObservation`).
- **README and `permitted-claims.md` are correctly bounded** to development tier / fake driver / trusted reference subject / non-blind selection, and the stale "no valid environment terminal claim" limit was properly removed.
- **The golden environment run is CLI-produced**, and the evidence pipeline is deterministic and non-destructive.

---

## 4. Design discrepancies (brief §23)

Both are **resolved by an accepted ADR on this branch** — ADR-ERL2-023, which amends the design by record rather than editing it in place (the precedent set by ADR-ERL2-020 §5).

1. **Appendix C `select --request` vs shipped `select --run`.** Classification: **documentation drift, resolved.** The ADR amends Appendix C, refuses `--request` outright rather than aliasing it (an alias would reintroduce the caller-supplied request that ADR-ERL2-020 §6 removed to prevent a second beacon round), and pins the refusal in `tests/e2e/expectedRefusals.test.ts`. Verified: `select --request` → exit 2 `CFG_UNKNOWN_FLAG`. **Not a merge blocker.**
2. **Design §12 signed controller activation receipt vs unsigned `EnvironmentOperationReceiptV1`.** Classification: **resolved, with one residual gap.** ADR-ERL2-023 §2 adds `challenge-activation-receipt/v1` (ERL2-C-155), signed by `controller`, additively — no frozen schema changed shape. §2a keeps the driver receipt unsigned deliberately: the driver is untrusted infrastructure, and the Lab-side signed receipt cites it by hash, which is the correct direction of trust. Verified in code at `environmentRun.ts:801-820`. **Residual gap (P2):** the environment closure never *requires* the receipt, so a terminal without it still verifies valid.

---

## 5. Required verdicts

### A. Merge recommendation — **Do not merge**

One confirmed P0 (a false-valid-attestation mechanism over an environment that was never torn down) and a P1 cluster spanning cleanup, cancellation, terminal reachability, exactly-once and verifier binding. These are integrity defects in exactly the paths this slice exists to establish, not polish.

### B. Branch verdicts

- **Slice 6.5-A → main:** not re-reviewed here (out of scope). This review found no regression introduced into it, and ADR-ERL2-023 properly closes the `select` flag discrepancy. Note that P1-8 (run-identity binding) lives in shared, pre-existing CLI code and applies to 6.5-A and to `main` as well.
- **Slice 6.5-B/C/D/E → Slice 6.5-A:** **not ready.** The P0 and the P1 cluster must be closed first.
- **Retargeting the second PR to main later:** yes — the branches are cleanly stacked on a linear merge base, so retargeting is mechanically safe once 6.5-A lands and the blocking cluster is closed.

### C. Functional verdicts

| Property | Verdict |
|---|---|
| Valid environment terminal | **Proven** — 21 separate CLI processes to `generic_finalized`, bundle verifies offline |
| Invalid environment terminal | **Partially proven** — all four reachable, but attribution and primary-finding derivation are defective; no CLI coverage of partial provisioning |
| Offline environment verification independent | **Partially** — closure and selection chain genuinely re-derived (strong); validity, cleanup verdicts, evidence cutoff and most attestation bindings are not |
| Crash / replay sufficiently proven | **No** — external actions precede durable intent; the test cited as crash-resumability evidence injects no crash |
| Restoration / teardown trustworthy | **No** — no-op compensation accepted, frontier-unsafe resources destroyed then attested skipped, error-swallowing substrate load |
| Oracle scans load-bearing | **2 of 4** (`adapter_request`, `subject_output_prefill`) |
| Golden environment evidence | **Present but shape-only** — CLI-produced, honestly documented; bytes unpinned for a sound cryptographic reason (CSPRNG in `sealThresholdEnvelope`) |

### D. Claims ceiling

The exact strongest claim the evidence supports:

> A development-tier run using the deterministic fake environment driver and a trusted reference subject advances from `case_selected` to `generic_finalized` through 21 separate invocations of the shipped CLI, and the resulting `EnvironmentPublicVerificationBundleV2` verifies offline in a fresh process with zero missing roles and zero rejected extras, against a trust head and randomness-source registry taken only from locally pinned, verifier-controlled configuration.

Not currently supported, and asserted in the docs: crash-resumability of the environment walk; "a refusal writes no evidence" for the environment commands; trustworthy restoration/teardown; four load-bearing oracle surfaces.

### E. Deferred work

Genuine follow-ups, none penalised in this review:

- evaluated domain plane (needs a subject emitting a claim set and a revealed functional truth)
- `recover` / `rollback` coverage (needs a fixture journey committing those intents)
- the four pending oracle surfaces — `environment_variable`, `process_argument`, `diagnostics`, `network_egress`
- semantic evidence equivalence (needs two independently observed environments)
- controller receipt: **decision closed** by ADR-ERL2-023; residual work is making the closure require it
- Compose driver (ERL2-OQ-005)
- container launcher and opaque subjects (ERL2-OQ-008)
- byte-level golden for the environment run
- the `pre_reveal_subject_cleanup_started` edge

### F. Review limitations

- **The review head moved mid-review** (`62158c3` → `bd71a7f`, owner's commits). All measurements were re-confirmed against the new head; findings are stated at `bd71a7f` unless noted.
- Node 26.4.0 against a Node 22 target — byte equivalence on Node 22 is asserted by CI and was not verified here.
- No CI evidence available; no Docker used. Compose and opaque-subject paths are disabled by design and were not exercised.
- Qualiber directories were not inspected or executed, per instruction.
- Findings beyond those re-verified at source by the reviewer came from a 13-dimension fan-out with adversarial refutation; three returned `PARTIAL` and are flagged rather than asserted. Notably, `provision()` is also intent-less (`environmentRun.ts:334`) but was downgraded to `PARTIAL`/P3 — a crash there is contained by a driver-internal guard and surfaces as a mis-attributed provisioning failure rather than a duplicated environment. It is deliberately excluded from P1-7.
- The repository has no branch protections; both review branches are local only.
- The only working-tree state affecting the review was the pre-existing continuation-prompt edit and the three then-uncommitted source files, both accounted for above.
