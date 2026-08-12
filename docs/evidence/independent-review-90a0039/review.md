# Targeted independent re-review of the LIVE-001 corrective candidate, and adjudication of the single campaign disagreement

Review target: Reality Lab `90a00399b5ff4516e323aead02957af064599132`
Prior review target: `e9718e0332ff84becaed3d64bc39fc360e1a16f2`
Review date: 2026-08-11
Reviewer workspace: outside both canonical repositories

## 1. Primary verdict

**CORRECTIVE IMPLEMENTATION APPROVED — CAMPAIGN HARNESS FIX REQUIRED**

The five corrective commits close the independent review's P1, both P2s, and the
P3, and they close them durably rather than by assertion. The frozen subject seam
and the current authorizing receipt are inside a signed, core-hashed, chain-covered
preregistration; I proved that by recomputing the core hash and observing it move
when either field is altered. The single campaign disagreement is **not** caused by
this candidate. It reproduces identically at `e9718e0` and at `90a0039`, and it
disappears at both revisions once the repository's own pinned upstream fixture is
provisioned.

One new, narrow finding is raised (P3, below): the `adapter-certified` applicability
assertion's *unique* contributions are not load-bearing at integration level.

Readiness answers are in §18.

## 2. Repository coordinates and clean-state proof

Every expected coordinate matched exactly.

| Item | Expected | Observed |
|---|---|---|
| Reality Lab branch | `codex/external-adapter-receipt-admission` | matched |
| Reality Lab HEAD | `90a0039…9132` | `90a00399b5ff4516e323aead02957af064599132` |
| Reality Lab tree | `31a5658…4a23bf2` | `31a565805c09de1d3726190708b5e6c534a23bf2` |
| Worktree | clean | clean, before and after review |
| Branch upstream | none | none (`fatal: no upstream configured`) |
| Branch pushed | no | no remote ref contains `90a0039` |
| Base / `main` / `origin/main` | `7872813…6b47f5b` | `787281318c845c34d209127177b8355c66b47f5b` |
| Independent-QA branch | `codex/stage3-adapter-certification` | matched |
| Independent-QA HEAD | `a699383…12c7cb1` | `a699383045d24c91876a8dd176ae8572612c7cb1` |
| Independent-QA tree | `2156bce…c50f25e16` | `2156bce3df5b468eec2ee6aabba30b1c50f25e16` |
| Independent-QA clean / no remote | yes | clean, no remote |

One clarification, not a discrepancy: the Reality Lab repository *does* have an
`origin` remote (`github.com/karkuak/qualiber-reality-lab`). The **branch** is
local, has no upstream, and is unpushed — no remote-tracking ref contains
`90a0039`. Both statements are true together.

Prior review report and inventory hashed to their expected values:

- `reality-lab-e9718e0-independent-review.md` → `8b2c1b5afe4c46127f81880caded5589da7d18b6011db88fc49f470df1a45b13` ✓
- `reality-lab-e9718e0-changed-files.txt` → `f78699494624dc8f4089bafed75bc533284ccffc764e08f6987aba8b0a15b792` ✓

The complete report was read before any corrective code was reviewed.

Frozen Independent-QA artifacts recomputed and matched:

| Artifact | Path | SHA-256 |
|---|---|---|
| Adapter entrypoint | `adapter/main.mjs` | `b977ac2ad4698de7145ddc1d01b4aa27f2bc4c7a8d5b13d57ce997289b976893` ✓ |
| Manifest file | `certification/manifest.json` | `7893d048f888ec24fdb9c311a7cd864e0b8782b0b56c414b72077d2b326dfb27` ✓ |
| Receipt file | `certification/receipt.json` | `6f3087e7ed9a9fea916baeedbc55baf2b26749286daee5c799cc49a6c0d7f4ed` ✓ |

**Unrelated worktree — inventoried only, not inspected or altered:**
`/Users/karthik/Developer/qualiber-reality-lab/.claude/worktrees/practical-mestorf-5e0215`,
branch `claude/practical-mestorf-5e0215`, HEAD `25d3f57c833f50f84d4eaba783900593719d651e`,
one pre-existing uncommitted change. Identical to the prior review's record.

## 3. Corrective commit and tree inventory

Ancestry is linear from the base, with no merges. The four original candidate
commits were **not** rewritten — `e9718e0` is still an ancestor of `HEAD` and
carries its original tree `7250ffcdd08196cd0270a1c411a60fe310f6baec`.

| # | Commit | Tree | Parent |
|---|---|---|---|
| 1 | `344b7b42052c39977bb14961d0965808806d023a` | `25dd44464d22d9e2413634d7e40dabd124f12970` | `787281318c845c34d209127177b8355c66b47f5b` |
| 2 | `c5af10dcb3b52bd4cbafbbc6989d41f0ecf199e3` | `0af2e86b84a4276c44f0c368eccd58e0ffc5b88a` | `344b7b42…` |
| 3 | `6d211871d59af87de9d9522905368e79d30a540e` | `5c2a0dbb769ee72152f0f47743f4f05efe4ac731` | `c5af10dc…` |
| 4 | `e9718e0332ff84becaed3d64bc39fc360e1a16f2` | `7250ffcdd08196cd0270a1c411a60fe310f6baec` | `6d211871…` |
| 5 | `793bce6376386fea82c0963d1deb3d5ba69d8ee2` | `a9f6ab39ce86cccd4a8526351124fc8c11096ea1` | `e9718e03…` |
| 6 | `a39f0434c85ea51ca1a47ad29b71a5314f8dfcfa` | `01f69aac453e05a7e06d3f04046bc2d93e579908` | `793bce63…` |
| 7 | `e0dfac05591aaa4fc4fd437954e3f323ab4370fb` | `c37529fc5a700cfd2f8feb9ac3d298771f2f57ad` | `a39f0434…` |
| 8 | `5c62b515de7f13d804e68f216bf16e87b78bf8f6` | `3465c2c2d22df0b39aee076782592384ec8e4223` | `e0dfac05…` |
| 9 | `90a00399b5ff4516e323aead02957af064599132` | `31a565805c09de1d3726190708b5e6c534a23bf2` | `5c62b515…` |

Commits 5–9 are the corrective package, in the expected order and with the
expected roles.

| Commit | Files | +/− | Character |
|---|---|---|---|
| `793bce6` | 10 | +441 / −57 | frozen mode + current receipt, failure evidence, applicability |
| `a39f043` | 12 | +882 / −46 | binding controls, neutral fixtures, campaign red control |
| `e0dfac0` | 6 | +718 / −51 | ADR/security corrections, preserved review |
| `5c62b51` | 573 | +1397 / −1397 | evidence regeneration **only** (symmetric; goldens exclusively) |
| `90a0039` | 1 | +5 / −1 | fake-port validity fixture correction |

The corrective diff is 601 changed paths: **573 goldens** and **28 non-golden**.
`5c62b51` is a single, clean, goldens-only regeneration, exactly as claimed.

## 4. Closure of the original P1 / P2 / P3 findings

### P1 — real adapter and receipt introduced/substituted after fake preregistration → **CLOSED**

The binding is now a contract fact, not a convention.

`packages/contracts/schemas/acquisition.schema.json:114,158-166,184-211` makes
`subject_execution_mode` **required** on `AcquisitionPreregistrationV1`, and an
`allOf`/`if`/`then`/`else` makes `adapter_certification_receipt_hash` required
when the mode is `external_adapter` and **forbidden** otherwise. Because the mode
is required, the `else` branch is never reached vacuously.

`packages/core/src/run/workspace.ts:468-482` enforces the same rule in code before
the artifact is built: external without a receipt raises
`ADAPTER_CERTIFICATION_RECEIPT_REQUIRED`; fake-port with a receipt raises
`CFG_MISSING_REQUIRED`.

**Both facts are provably inside the signature and the hash chain.** I recomputed
the hostile golden's preregistration core hash with the repository's own `coreHash`:

```
recorded    sha256:0279305a0802d5af6f3849c29e6c3eeda6f24e3daf9794f343a873962a333667
recomputed  sha256:0279305a0802d5af6f3849c29e6c3eeda6f24e3daf9794f343a873962a333667   MATCH
mode flipped to development_fake_port  → sha256:ec2ab2649a488b3499cde64e6f7a978dc867d01b758a24c3a14ac803145d0989  (changes)
receipt substituted                    → sha256:3801611d6795474868275c4ed9d32b8304b9e32721768593b491dbd2da274502  (changes)
```

The artifact carries a `signature` block, and its `core_hash` is referenced by
lifecycle event `000000.json` (`acquisition_preregistered`), the chain root. So
claims 1 and 2 — that fake/internal and external modes are explicit signed,
core-hashed preregistration facts — are independently proven, not accepted.

Resolution is now single-sourced. `packages/cli/src/journeyCommands.ts:493-517`
(`frozenSubjectBinding`) reads the retained, signed preregistration from disk —
not CLI memory — and `:520-556` (`assertSubjectModeUnchanged`) is invoked as the
*first statement* of `subjectPort()` at `:258`, before anything is constructed.
`adapterCertificationReceiptHash` at `:459-484` returns the frozen receipt
authoritatively and refuses a mismatched flag with
`ADAPTER_CERTIFICATION_IDENTITY_MISMATCH`.

`packages/core/src/run/workspace.ts:713` changes `adapterCertification()` to
resolve from `boundCertificationReceiptHash()` (the frozen preregistration field)
rather than the retained-file role — closing the "retained file absent ⇒ accept
any supplied receipt" path the review reproduced.

Claim-by-claim, all eleven verified:

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| 1 | fake/internal is a signed, core-hashed fact | ✔ | core-hash recomputation above; golden preregs show `development_fake_port` |
| 2 | external is a signed, core-hashed fact | ✔ | same; three adapter-platform preregs show `external_adapter` |
| 3 | external requires exactly one current receipt | ✔ | schema `if/then`; `workspace.ts:468-475`; test `MODE-FROZEN: a real preregistration requires a receipt…` |
| 4 | fake/internal forbids a receipt | ✔ | schema `else/not`; `workspace.ts:476-482`; all seven fake goldens show the field absent |
| 5 | no later `--adapter-entry` after fake prereg | ✔ | `journeyCommands.ts:531-537`; behavioural test observes no `adapter-workspace` and no marker file |
| 6 | no later `--adapter-certification` after fake prereg | ✔ | `journeyCommands.ts:538-544`; same test |
| 7 | receipt A cannot be replaced by receipt B | ✔ | `journeyCommands.ts:465-473`; test builds a second individually-valid receipt for the same manifest and is refused |
| 8 | external cannot downgrade to fake | ✔ | `journeyCommands.ts:548-555`; omitting `--adapter-entry` refused |
| 9 | survives restart / dropped snapshot / replay | ✔ (see note) | test deletes `state/snapshot.json` and re-asserts through fresh CLI processes |
| 10 | no CLI-memory-only fallback remains | ✔ | the only flag-decided path is preregistration itself, where no binding exists yet |
| 11 | every production `AdapterHost` construction is compatible | ✔ | exactly two: `journeyCommands.ts:319` (gated by `assertSubjectModeUnchanged` at `:258`) and `certification.ts:172` (the certifier harness, which necessarily precedes the receipt it produces) |

*Note on claim 9:* the repository has no separate `replay` command — a "replay" is
a fresh process reconstructing the run from its retained, hash-chained event log.
The test's `assertStillBound("replayed")` is therefore a second fresh-process
reconstruction, not a distinct command. Restart and dropped-snapshot recovery are
genuinely exercised. The claim holds; the wording "replay" means less than a
reader might assume, and I record it precisely rather than restating the claim.

**Adversarial probe — the one remaining fail-open, and why it is not reachable.**
`frozenSubjectBinding` returns `undefined` when the retained preregistration
carries no recognised `subject_execution_mode`, and enforcement then no-ops. I
tested whether that is reachable end-to-end: preregister as fake-port, strip the
field from the retained artifact, then attempt `acquire --adapter-entry` with a
*marker* adapter that writes an observable file if it ever executes.

First attempt failed with `EACCES` — retained artifacts are written **read-only**,
which is itself an unclaimed protection. After clearing the mode bit (as a
same-user attacker could), the result was:

```
PROBE-RESULT exitCode=10 code=ARTIFACT_HASH_MISMATCH adapterBytesRan=false
```

The artifact-integrity check refuses before dispatch and **no adapter bytes ran**.
The fail-open is not reachable; defence in depth holds. No finding is raised.

### P2 — failure evidence named the bootstrap/prior hash → **CLOSED**

`packages/core/src/run/workspace.ts:2247-2251` now populates the finding from
`currentAuthorizingReceiptHash()` (`:2264-2286`), which returns the frozen bound
receipt, **fails closed** with `ADAPTER_CERTIFICATION_RECEIPT_REQUIRED` (owner
`lab`) if an `external_adapter` run has none, and returns the bootstrap sentinel
only for a genuine fake-port run.

Exact equality verified in the hostile timeout golden — all three references
identical, and distinct from the manifest's bootstrap field:

| Reference | Value |
|---|---|
| preregistration `adapter_certification_receipt_hash` | `sha256:234c2e32de8579466f385c7c19d3be1cfdc6617d009f0c9c49f43bf318f8c2e9` |
| retained receipt artifact `core_hash` | `sha256:234c2e32de8579466f385c7c19d3be1cfdc6617d009f0c9c49f43bf318f8c2e9` |
| failure finding `certification_receipt_hash` | `sha256:234c2e32de8579466f385c7c19d3be1cfdc6617d009f0c9c49f43bf318f8c2e9` |
| manifest `certification_receipt_hash` (bootstrap, correctly unused) | `sha256:0000…0000` |

Survival across recovery/replay follows from the source: the value is read from
the frozen preregistration on every reconstruction, not cached.

### P2 — `adapter-certified: passed=true` could not represent "not applicable" → **CLOSED**

`deriveAdapterCertifiedGate` (`packages/core/src/adapter/admission.ts:526-531`)
now returns `undefined` for `development_fake_port`, and
`adapterCertifiedGateResults` (`:552-568`) spreads zero-or-one results into the
gate list. The vacuous `passed: !dispatchedRealAdapter` branch is gone; `passed:
true` is reachable only from a validated certification, and its evidence always
names the receipt.

`packages/core/src/evaluation/validity.ts:123-129` (`requiredGateIds`) drops the
gate from the required set for fake-port runs, and `:150-197`
(`assertAdapterCertificationApplicability`) enforces the full truth table.

**Retained evidence agrees.** The string `adapter-certified` appears in **no
golden anywhere in the repository**. The two fake-port goldens that build a full
gate set (`generic-finalization-failed-verification`,
`generic-finalization-unsupported-verification`) carry all fifteen other
pre-environment gates including `adapter-authority-respected`, and omit
`adapter-certified`. Consumers cannot read absence as passing, because absence is
now the catalogue's own established representation for "not exercised" — the same
shape it already uses for environment and selection gates.

### P3 — security and evidence prose exceeded retained proof → **CLOSED**

`docs/adr/ADR-ERL2-036.md` §6 is retitled "Deterministic substitution detection —
and what it is not", states the guarantee exactly, and then explicitly disclaims
all four overclaims the review named: it is **not** atomic frozen-byte execution,
**not** protection against a malicious same-user check-to-spawn race, **not**
container/kernel isolation, and **not** authenticated certification. The ADR also
volunteers that the pre-host and per-dispatch checks are not two independent
defences and does not claim they are.

The stale hostile-golden prose is corrected: the fixture is admitted on a
certified receipt over its **own** real bytes, so it remains a deadline
(`ADAPTER_DEADLINE_EXCEEDED`, adapter-owned), not an identity mismatch. I
confirmed that in the golden.

The termination claim is correctly narrowed. The hostile golden retains a
grandchild PID (`97961`) but **no independent post-kill liveness receipt** — I
verified the only "terminated" strings are the Lab's own message text, which is a
claim, not evidence. The ADR now says the golden proves emission, not
termination, and names `tests/adversarial/adapterHost.test.ts:124-155` as the only
citable source. That test does perform a real liveness check (`process.kill(pid,
0)`), so the narrowed claim is supported.

The provenance README's "four logs" error is corrected to "six artifacts (five
`.log` files plus one Markdown intervention log)".

The prior review is preserved at `docs/evidence/independent-review-e9718e0/` and
is **byte-identical** to the external original — both files hash to the expected
values.

## 5. Conditional external-gate assessment

The full applicability matrix is enforced, and enforced behaviourally (the tests
call the real function and assert typed refusals — not source-text matching):

| Mode / condition | Required result | Enforced at | Verified |
|---|---|---|---|
| Fake/internal | `adapter-certified` absent | `admission.ts:526-531`, `validity.ts:159-168` | ✔ tests + all 7 fake goldens |
| External, valid receipt | exactly one passing gate citing current receipt **and** manifest | `admission.ts:533-537` | ✔ test |
| External, gate omitted | validity failure | `validity.ts:170-176` (`GRAPH_CLOSURE_MISSING_ROLE`) | ✔ test |
| External, gate duplicated | validity failure | `validity.ts:170-176` ("exactly one") | ✔ test |
| External, manifest-only evidence | validity failure | `validity.ts:179-187` | ✔ test |
| External, bootstrap/prior receipt evidence | validity failure | `validity.ts:179-187` | ✔ test |
| External, invalid receipt | refusal before dispatch | `journeyCommands.ts:313-317` pre-host | ✔ mutation M1 |

**Where each row is actually proven — stated precisely, because the strength
differs.**

- *Integration level.* `tests/adversarial/adapterEvidenceRetention.test.ts:292`
  drives a real external adapter through `finalize-generic`, which builds
  validity. Mutation M4 confirmed this path is live: suppressing the producer
  failed with `GRAPH_CLOSURE_MISSING_ROLE: validity evaluation omitted required
  gate(s): adapter-certified`. So **"external run must emit the gate"** is
  genuinely load-bearing end to end.
- *Unit level only.* The remaining rows — **duplicate** gate, **manifest-only**
  evidence, **bootstrap/prior** evidence, and a fake-port run **emitting** the
  gate — are exercised only by tests that call
  `assertAdapterCertificationApplicability` directly. No integration test asserts
  the *content* of the external gate; `adapterEvidenceRetention` makes no
  assertion about `gate_results` or `evidence_refs` at all. This is the basis of
  the P3 finding in §6.
- *Golden level: absent.* The three `adapter-platform` golden runs are
  `external_adapter`, but none builds a validity result — each carries zero
  `gate_id` entries, terminating before validity is constructed. Every golden that
  *does* contain a validity result is a fake-port run. That is not a defect
  introduced here (the prior review found the same absence), but "838 pinned
  goldens" should not be read as covering the external gate.

## 6. Findings

### P3 (new) — the applicability assertion's unique contributions are not load-bearing

- **Location:** `packages/core/src/evaluation/validity.ts:258-263` and `:318-323`
  (the two `assertAdapterCertificationApplicability` call sites).
- **Evidence:** mutation **M5** removed both call sites (`replacedCount=2`). The
  tree built, and the affected suite passed **144/144**. Because a partial
  selection is not sufficient grounds to call a mutation surviving, I re-ran it
  against the **entire** compiled test suite:
  **1,209 tests, 1,201 pass, 0 fail, 0 cancelled, 8 skipped — SURVIVED.**
  No test in the repository detects the removal.
- **Why it survives:** the `GATE-APPLICABILITY` test calls
  `assertAdapterCertificationApplicability` **directly**, so deleting its call
  sites from `buildPreEnvironmentValidity`/`buildEnvironmentValidity` cannot break
  it. Separately, `assertRequiredGatesPresent` independently catches a *missing*
  external gate (proven by M4), so that one sub-case is covered elsewhere.
- **What is genuinely uncovered:** the assertion's *unique* contributions — the
  **duplicate** gate, the gate citing **manifest-only** or **bootstrap/prior**
  evidence, and a fake-port run **emitting** the gate — are enforced only when the
  function is called directly by a unit test. Remove the wiring and no test
  notices. Combined with §5's golden gap, nothing in retained evidence or
  integration tests would detect a future producer regression of exactly the kind
  LIVE-001 was.
- **Ownership:** Reality Lab, receipt-admission package.
- **Smallest remediation:** one integration-level control that drives
  `buildPreEnvironmentValidity` (or the workspace path) with
  `subjectExecutionMode: "external_adapter"` and a duplicated / manifest-only
  `adapter-certified` gate, asserting the typed refusal. This is a test-only
  addition.
- **Blocks merge:** no. It is a missing control on a defence-in-depth check whose
  removal changes no produced evidence, because the producers are independently
  correct and independently covered. It does not create a false attestation.
  **Blocks unscored retry:** no. **Blocks scored operation:** no, but it should be
  closed before any scored/authenticated claim rests on the external gate.

No P0, P1 or P2 findings are raised against the corrective implementation.

## 7. Five mutation results

All mutations were temporary, applied in a disposable exact-head clone, reverted
immediately, and the clone verified clean afterwards. **Nothing was committed.**

| # | Mutation | Site | Build | Result | Failing tests |
|---|---|---|---|---|---|
| M1 | remove preregistration-time / pre-host certification verification | `packages/cli/src/journeyCommands.ts:313-317` | ok | **CAUGHT** (143/144) | `PRE-HOST: an uncertified receipt cannot construct the host at preregistration` |
| M2 | remove per-dispatch entrypoint digest verification | `packages/core/src/adapter/host.ts:427-430` | ok | **CAUGHT** (141/144) | `FAILURE-EVIDENCE: an adapter failure cites the frozen current receipt…`; `PER-DISPATCH: deterministic replacement at the same path is refused before it executes`; `PER-DISPATCH: retargeting a symlinked entry is refused before it executes` |
| M3 | drop the external certification gate from the required set | `packages/core/src/evaluation/validity.ts:123-129` | ok | **CAUGHT** (142/144) | `GATE: a fake-port run omits adapter-certified entirely — not applicable, not passed`; `GATE-APPLICABILITY: omitting adapter-certified for a fake run does not make it optional for a real one` |
| M4 | suppress the external gate producer | `packages/core/src/adapter/admission.ts:566-567` | ok | **CAUGHT** (136/137) | `tests/dist/adversarial/adapterEvidenceRetention.test.js`, failing with `GRAPH_CLOSURE_MISSING_ROLE: validity evaluation omitted required gate(s): adapter-certified` at the real external run's `finalize-generic` — integration level |
| M5 | remove the exactly-one / applicability check | `packages/core/src/evaluation/validity.ts:258-263, 318-323` | ok | **SURVIVED** — affected suite 144/144, then **full suite 1,209 tests / 1,201 pass / 0 fail / 8 skipped** | none |

**Four of five are caught; M5 survives.** Both controls the prior review found
surviving (M1 and M2) are now caught, and caught *behaviourally*: those tests
observe that adapter bytes never executed — a marker fixture that writes
`SUBSTITUTE-EXECUTED` — rather than that a helper returned an error. That is a
materially stronger control than the prior package had.

A fairness note on the claim being tested. The candidate's own ledger
(`docs/ledger/remediation-live-001-adapter-admission.md:197-213`) claims only that
the **two previously surviving** mutations are now caught, and that claim is
accurate. The broader framing that "five temporary enforcement mutations are
caught" is not borne out: M5 is not caught, by any test in the repository. The
ledger is the more careful statement of the two.

M3's catch is real but unit-level (both failing tests call `requiredGateIds`
directly). M4's catch is integration-level. M5 is the subject of the P3 finding
in §6.

## 8. Targeted and Docker test results

Run in a disposable clone at exact head `90a0039`, clean worktree.

| Gate | Result |
|---|---|
| `npm run build` | pass |
| `adapterModeBinding` controls | **9/9** ✔ (as claimed) |
| `externalAdapterAdmission` controls | **26/26** ✔ (as claimed) |
| affected recovery/replay, adapter-host, CLI, evidence-retention, contract, purity/architecture, integration selection | **578 tests, 575 pass, 0 fail, 3 skipped** (Docker-gated) |
| `verify:generated` | pass — "generated types are current" |
| `evidence:verify` | pass — **838 pinned / 7 excluded**, byte-for-byte, plus 3 invalid + 1 valid golden gates re-verified in fresh processes |
| `git diff --check` | clean |
| worktree after all runs | clean |

Docker-gated files, run with `ERL2_REQUIRE_LIVE_DOCKER=1` and the repository's own
neutral external subject (`fixtures/neutral/adapters/external-subject.mjs`, added
by `a39f043` — the corrective package supplies the neutral fixture the prior
review had to improvise):

| File | Result | Duration |
|---|---|---|
| `tests/e2e/composeEnvironmentRun.test.ts` | **3/3** ✔ | 65.2 s |
| `tests/e2e/externalSubjectComposeRun.test.ts` | **3/3** ✔ | 65.0 s |

Both match the reported 3/3.

**Docker resource inventory — zero task-created residue.**

| | Before | After |
|---|---|---|
| Containers | `cranky_nobel`, `zealous_joliot` (both pre-existing, exited) | identical |
| Networks | `bridge`, `host`, `none` | identical |
| Volumes | none | none |
| Images | 9 | 9 |

No unrelated resource was altered.

## 9. Real-fixture admission-only result

The frozen Independent-QA artifacts were used **only** with `admit-adapter`. No
lifecycle command, no preregistration, no product execution.

| Tier | Result |
|---|---|
| `development` (explicit) | **admitted**, `certification_authenticity: locally_observed_unauthenticated` |
| default (no `--tier`) | **admitted**, identical — default is development |
| `held_out` | **refused**, `ADAPTER_CERTIFICATION_AUTHENTICATION_REQUIRED` |
| `blind` | **refused**, `ADAPTER_CERTIFICATION_AUTHENTICATION_REQUIRED` |

Admitted record: adapter `independent-analytics-validator` 0.1.0, certifier
`independent-adapter-certifier`, `certifier_is_adapter_owner: false`,
`adapter_artifact_hash` = the frozen entrypoint hash
`sha256:b977ac2a…76893`, `receipt_linkage: bootstrap_no_prior_receipt`, eleven
certified operations, `archive` package kind.

Both refusals created **zero** registry files — admission fails closed with no
partial publication. All scratch registries were deleted. The Independent-QA
repository was not modified.

## 10. Exact-head gate evidence assessment

**The reported normal clean gate is implementer-reported, not independently
proven.** No durable log or receipt of it exists anywhere in the repository: I
searched every tracked Markdown, JSON and text file for `20m50`, `1,209`/`1209`,
`1,207`/`1207` and `3h16` and found nothing. The ledger records the package's
reasoning and counts but not the gate run.

I therefore do **not** upgrade the figures (20m50s, 1,209 total, 1,207 passed, 0
failed/cancelled, 2 Docker-gated skips) to independently proven, and rely on
independent reproduction instead. The claim that the gate was run at exact
`90a0039` with a clean worktree after the final test-only commit cannot be
verified from repository state, because the evidence is not durable.

**However, the substance is now strongly corroborated.** In the course of
adjudicating mutation M5 I ran the **entire compiled test suite** at exact head
`90a0039` in a clean disposable clone, and observed:

```
# tests 1209   # pass 1201   # fail 0   # cancelled 0   # skipped 8
```

The **total of 1,209 and the zero failed / zero cancelled result match the report
exactly.** That run carried the M5 mutation, but M5 provably changed no test
outcome (it survived with zero failures), so the outcomes are those of the
unmutated tree. The pass/skip split differs — 1,201/8 rather than 1,207/2 —
because my clone lacked the git-ignored OTel Demo upstream fixture and the
external-subject environment variables, which turns six additional
Docker/fixture-gated cases into skips. `1,201 + 8 = 1,207 + 2 = 1,209`.

Together with §8 (`verify:generated` current, `evidence:verify` at exactly the
claimed 838 pinned / 7 excluded, no golden drift, both Docker files 3/3), the
recorded gate result is independently corroborated in substance even though its
execution remains implementer-reported.

**The campaign, by contrast, does have a durable local record.**
`docs/ledger/negative-controls.json` (git-ignored via `.gitignore:9`, mtime
2026-08-11 17:04) contains exactly:

- `selected: 129, of: 129`; 129 results
- 128 agreed, 1 disagreed, and the disagreement is
  `substrate-loopback-only-rendered` with `result: tests_passed_unexpectedly`,
  `harnessError: false`, `replacedCount: 1`, **28 pass / 0 fail**
- `adapter-mode-binding`: `agreed: true`, `named_tests_failed`, **7 pass / 2 fail**,
  `replacedCount: 1`

Every reported campaign figure matches this record. The record does not embed the
candidate SHA or a timestamp, so it corroborates the numbers but cannot itself
prove the campaign ran at `90a0039`; the mtime is consistent with a 3h16m run
started after the 13:26 commit.

## 11. Campaign record and `adapter-mode-binding` result

I independently reproduced the new red control at `90a0039` with the campaign's
own mutation (`assertSubjectModeUnchanged(flags, runRoot);` →
`void assertSubjectModeUnchanged;`, `replacedCount=1`):

```
ℹ tests 9  ℹ pass 7  ℹ fail 2  ℹ skipped 0
✖ MODE-FROZEN: a fake preregistration refuses a later real adapter and a later receipt
✖ MODE-FROZEN: mode and receipt survive a new process, replay and a dropped snapshot
```

**7 passing expectations / 2 expected failures — exactly as recorded.** The two
failures are the two cases that directly exercise the frozen-mode enforcement, so
the control kills what it declares. The control is well-formed: it uses `void`
rather than deletion so the patched tree still compiles, which is the right choice
(a control that cannot build is a harness error, not evidence).

## 12. Four-cell substrate-control matrix

Reproduced with the campaign's exact mutation and designated-test semantics, in
disposable clones. **The full 129-control campaign was not run.**

| Revision | Upstream fixture | Worktree | `replacedCount` | Designated test | Totals | Expected failure | Campaign classification | Cleanup |
|---|---|---|---|---|---|---|---|---|
| `e9718e0` | **absent** | `work/camp-e97` | 1 | **SKIPPED** (`RENDERED TOPOLOGY UNPROVEN`) | 29 tests, 28 pass, 0 fail, 1 skip | **no** | `tests_passed_unexpectedly` → **DISAGREED** | tracked files clean |
| `90a0039` | **absent** | `work/camp-90a` | 1 | **SKIPPED** (identical) | 29 tests, 28 pass, 0 fail, 1 skip | **no** | `tests_passed_unexpectedly` → **DISAGREED** | tracked files clean |
| `e9718e0` | **provisioned** | `work/camp-e97` | 1 | **RAN** | baseline 29/29; mutated 28 pass, **1 fail** | **yes** | `named_tests_failed` → **AGREED** | tracked files clean |
| `90a0039` | **provisioned** | `work/camp-90a` | 1 | **RAN** | baseline 29/29; mutated 28 pass, **1 fail** | **yes** | `named_tests_failed` → **AGREED** | tracked files clean |

The fixture-absent cells reproduce the recorded campaign outcome **exactly** —
28 pass / 0 fail, `tests_passed_unexpectedly`, `replacedCount: 1`.

All five load-bearing conditions are satisfied for both provisioned cells:

1. **Unmodified baseline passes** — 29/29, designated test ran and passed. ✔
2. **Mutation applied exactly once** — `replacedCount: 1`. ✔
3. **Mutation causes the designated assertion to fail for the intended reason** —
   the sole failure is `COMPOSE-ADV: the RENDERED configuration publishes one
   loopback port and nothing else`. ✔
4. **Reversing restores the pass** — re-run after revert: 29/29, designated test
   passed again. ✔
5. **No unrelated failure used as agreement** — exactly one failing test, the
   designated one. ✔

The control is therefore **fully load-bearing** when its prerequisite exists.

**Mechanism, confirmed at source.** `tests/adversarial/composeSubstrate.test.ts:850-878`
skips the designated case when Docker is unavailable **or** when
`environments/otel-demo/upstream/extracted-1bf3ef8fbaffc049/{.env,compose.yaml}`
are missing, emitting an explicit `RENDERED TOPOLOGY UNPROVEN` skip. That
directory is git-ignored (`.gitignore:16`), and the campaign patches a **fresh
`git worktree` checked out at HEAD** (`scripts/negative-control.mjs:19-25`), which
by construction does not carry ignored paths. I confirmed a fresh clone at either
revision contains **zero** entries under `environments/otel-demo/upstream/`.

## 13. Upstream fixture provenance and digest

The repository has a documented, immutable, pinned source. I did **not** copy the
ignored directory and assume validity; I verified the archive and re-extracted it
with the repository's own procedure. **No network access was used** — the pinned
archive was already present.

| Property | Value |
|---|---|
| Release tag | `3.0.0` (`scripts/qualify-otel-demo.mjs:101`) |
| Documented URL | `https://codeload.github.com/open-telemetry/opentelemetry-demo/tar.gz/refs/tags/3.0.0` |
| Archive file | `environments/otel-demo/upstream/opentelemetry-demo-3.0.0.tar.gz` |
| **Archive SHA-256** | **`1bf3ef8fbaffc049919b497a9174637dbee74ec1797ce5ff85d3d12dc86c051c`** |
| Extraction root | `extracted-<first 16 hex of digest>` = `extracted-1bf3ef8fbaffc049` (`:237`) |
| Extraction command | `tar -xzf <archive> -C <root> --strip-components=1 */compose.yaml */.env */src/otel-collector/otelcol-config.yml` (`:240-247`) |
| Provisioning entry point | `node scripts/qualify-otel-demo.mjs --fetch-only` |

The extraction directory name is **derived from the archive digest**, so the
local directory is provably the extraction of the archive I hashed. I reproduced
the extraction byte-for-byte into both disposable clones and confirmed all three
config paths materialised.

A reproducible pinned input therefore exists. `CAMPAIGN CONTROL UNMEASURABLE — NO
FROZEN UPSTREAM FIXTURE` does **not** apply.

## 14. Primary disagreement classification

### **`PRE-EXISTING FIXTURE-PROVISIONING DEFECT`**

Both required conditions are proven:

1. **Both revisions behave identically without the fixture** — cells 1 and 2 are
   byte-for-byte the same outcome. Corroborating this at source: the corrective
   commits touch **no** compose, substrate, otel or `environments/` path at all;
   `environments/otel-demo/compose/erl2-overlay.yaml` and
   `tests/adversarial/composeSubstrate.test.ts` are **identical** between
   `e9718e0` and `90a0039`; and the only change to `scripts/negative-control.mjs`
   is the addition of the `adapter-mode-binding` control — no classification logic
   was touched.
2. **The control becomes load-bearing when the frozen fixture is provisioned** —
   cells 3 and 4 satisfy all five load-bearing conditions.

`CANDIDATE REGRESSION` is **excluded**. `CONTROL NOT LOAD-BEARING` is **excluded**
— the mutation does trigger the designated assertion with a valid fixture.
`INCONCLUSIVE` is **excluded** — provenance and execution were both established.

## 15. Secondary harness issue

### **`CAMPAIGN-CLASSIFICATION DEFECT`** (independently proven, secondary)

`classifyTestRun` (`scripts/negative-control.mjs:2131-2215`) parses `ℹ tests`,
`ℹ pass`, `ℹ fail` and `ℹ cancelled` — and **never reads `ℹ skipped`**. I
confirmed by search that the token `skipped` does not appear anywhere in the
harness.

The consequence is a short-circuit. When the designated case skips, the other 28
cases pass, so `fail === 0`, and the classifier returns
`TESTS_PASSED_UNEXPECTEDLY` at `:2170-2178` — **before** ever reaching the
`mustFailCases` check at `:2195-2210` that exists precisely to detect "the
declared case did not fail". A declared, self-describing unavailable prerequisite
is thereby recorded as a disagreement rather than as unmeasured.

This is worth fixing on its own account, because the test is already honest: it
emits an explicit `RENDERED TOPOLOGY UNPROVEN` skip and even offers a three-state
design with `ERL2_REQUIRE_LIVE_DOCKER=1` to force a failure when a caller is
gating on the claim. The harness discards that signal. Any environment-dependent
control would be misreported the same way.

**Why fixture-provisioning is primary and this is secondary:** the proximate and
*sufficient* cause of the disagreement is the absent prerequisite — provision it
and the control measures correctly and agrees, with zero harness change and no
loss of coverage. The classification defect is a latent robustness gap that turns
an honest "unmeasured" into a false "disagreement"; it changes how the case is
*reported*, not whether it is *measured*. Restoring measurement is the more
fundamental repair. Both are real and both should be fixed.

## 16. Smallest separate remediation

**Not implemented** — this review made no repository change.

**Recommendation, in the prompt's preferred order:**

1. **Deterministically provision the pinned upstream fixture into the campaign
   worktree for the controls that require it.** The campaign already creates and
   `npm install`s a worktree (`scripts/negative-control.mjs:2607-2620`); the
   bounded change is to materialise
   `environments/otel-demo/upstream/extracted-1bf3ef8fbaffc049` there — by copying
   the verified archive and running the repository's own extraction, or by
   invoking `scripts/qualify-otel-demo.mjs --fetch-only` against it — gated on the
   archive's digest `1bf3ef8fbaffc049919b497a9174637dbee74ec1797ce5ff85d3d12dc86c051c`.
2. **Secondarily, and independently: teach `classifyTestRun` to read `ℹ skipped`**
   and represent a declared-unavailable prerequisite as `UNMEASURED HERE`,
   consistent with existing environment-dependent controls, rather than as
   agreement or disagreement. A skipped designated case must never be counted as
   agreement.

Explicitly **not** recommended, per the constraints and my own findings: do not
weaken `COMPOSE-ADV`; do not remove the control to reach 129/129; do not touch
receipt-admission behaviour for an unrelated substrate-fixture problem.

The separate P3 in §6 is a distinct, test-only addition and should not be bundled
with the harness fix.

## 17. Whether another full campaign is required

**Yes — once, at the final combined candidate.**

The current campaign's 128 agreements remain informative, but the disagreeing
control was never actually measured, so the campaign has not demonstrated
129/129, and repository policy of zero disagreement is not met by re-labelling.
Once the harness fix lands (and the P3 control, if it is included in the same
package), one full campaign should be run at the final combined head. A single
run is sufficient; the corrective commits do not otherwise invalidate the
campaign's coverage, since they change no control's target other than by adding
one.

## 18. Readiness answers

| Question | Answer |
|---|---|
| Receipt-admission corrective implementation approved | **Yes.** P1, both P2s and the P3 are closed, and the two previously surviving enforcement mutations are now caught behaviourally. |
| Merge / publication ready now | **No.** Not because of the implementation, but because the zero-disagreement campaign policy is unmet: one control remains unmeasured. Resolve the harness/fixture issue and rerun one full campaign. |
| Bounded unscored Qualiber dry-run ready now | **No** — not until publication. |
| Scored / authenticated ready | **No.** Unchanged and independent of this package: no certifier authority is pinned, so `authenticated` is unreachable for the real fixture; there is no `adapter_certifier` signer role; B-129 and B-130 stand. |

**A pre-existing campaign harness defect must not be misreported as a
receipt-admission failure.** It is not one. It does still block publication under
the zero-disagreement policy.

## 19. Final state and scope confirmation

Both canonical repositories are **clean and unchanged**:

- Reality Lab: `90a00399b5ff4516e323aead02957af064599132`, worktree clean.
- Independent-QA: `a699383045d24c91876a8dd176ae8572612c7cb1`, worktree clean.

Reality Lab tree is still `31a565805c09de1d3726190708b5e6c534a23bf2`.

All work was done in disposable clones under the session scratchpad
(`work/head90` at `90a0039`, `work/camp-e97` at `e9718e0`, `work/camp-90a` at
`90a0039`). Every mutation was reverted and each clone verified with zero
tracked-file changes afterwards; the one temporary probe test was deleted. All
three clones and the copied fixture material have since been removed — the
scratchpad is empty and no temporary artefact remains. All scratch admission
registries were deleted. No lingering test or adapter process remains.

Docker inventory is byte-identical before and after — containers `cranky_nobel`
and `zealous_joliot` (both pre-existing and exited), networks `bridge`/`host`/`none`,
zero volumes, 9 images — with **zero task-created residue** and no unrelated
resource altered.

The unrelated worktree was inventoried only and remains at
`25d3f57c833f50f84d4eaba783900593719d651e`.

Reproduction note: the four-cell matrix and every mutation are reproducible from
the coordinates, mutation strings and extraction command recorded in §7, §12 and
§13 without any network access, given the pinned archive already present at
`environments/otel-demo/upstream/opentelemetry-demo-3.0.0.tar.gz`.

**Explicit confirmation.** No Qualiber run occurred; Qualiber source was not
accessed and r5 product behaviour was not executed; the live Qualiber dry run was
not repeated. No evidence regeneration occurred and `evidence:update` was not
run. No implementation or campaign fix was made. No signer infrastructure was
added. No commit, branch, stash, rebase, push, pull request or merge occurred.
The full 129-control campaign was not run. The complete normal clean gate was not
re-run — targeted review found no discrepancy in the recorded exact-head evidence
that required it, and §10 records that evidence at its true strength rather than
upgrading it.

## 20. Exactly one next recommendation

Make one bounded, test-and-harness-only change that deterministically provisions
the digest-pinned OTel Demo upstream fixture
(`1bf3ef8fbaffc049919b497a9174637dbee74ec1797ce5ff85d3d12dc86c051c`) into the
campaign worktree, teaches `classifyTestRun` to read `ℹ skipped` so an
unavailable declared prerequisite is recorded as `UNMEASURED HERE` rather than as
agreement or disagreement, and adds the one integration-level
`adapter-certified` applicability control from §6; then rerun one full campaign at
that combined head before requesting merge.
