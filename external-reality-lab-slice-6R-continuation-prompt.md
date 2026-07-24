# External Reality Lab V2 — Slice 6R Continuation (P3 cluster, determinism follow-ups, isolation probe-signing, and final handoff)

You are the principal implementation engineer continuing the **Slice 6R — Integrity and Recovery Remediation** of External Reality Lab V2. Most of Slice 6R has already landed (see “State inherited” below). Your job is to finish the **remaining, lower-severity remediation** — the confirmed P3 findings §11.1–§11.14, two evidence-determinism follow-ups, the isolation probe-authenticity follow-ups — and then produce the **final Slice 6R handoff (§16)**.

This is an implementation-and-verification task. For each remaining finding: reproduce it, fix it at root cause, add adversarial regression evidence, and update the remediation ledger. Do not declare completion merely because tests pass.

**Do not** continue into Slice 6.5, Slice 7, the environment terminal, the container launcher, opaque/third-party subjects, threshold VRF, held-out/blind, or Compose. Do not weaken a refusal to make a test pass.

---

## 1. Workspace and authoritative inputs

Work only in: `/Users/karthik/Developer/qualiber-reality-lab`

Authoritative sources (precedence: accepted ADRs → normative V2 design → implementation plan → frozen contract schemas → this prompt → independent review as defect evidence):

- Independent review (defect evidence, not normative): `Independent-Code-Review.md`
- Normative design: `external-reality-lab-design-v2.md` (revision `2.0.0-draft.11`)
- Normative plan: `external-reality-lab-implementation-plan.md`
- Accepted ADRs: `docs/adr/ADR-ERL2-001..018.md` (018 was added this remediation — the run transaction/recovery/lease/idempotency/cancellation model; read it)
- Open questions: `docs/decisions/open-questions.md`
- Permitted claims: `docs/claims/permitted-claims.md`
- Requirement ledger: `docs/ledger/requirements.json`
- **Remediation ledger (your running record): `docs/ledger/remediation-6R.md`** — update it as you go.
- The original full remediation brief this continues is the Slice 6R prompt (P3 items are its §11.1–§11.14; determinism is §9.1/§9.5; isolation authenticity is §10; handoff is §16).

## 2. Absolute independence from Qualiber

Do not inspect, search, read, execute, or modify `/Users/karthik/Claude/Projects/Qualiber` or `/Users/karthik/Developer/qualiber-2nd/qualiber`. Do not add Qualiber-specific identifiers, branches, schemas, fixtures, or assumptions. Preserve and strengthen the product-independence checks (`tests/architecture/purity.test.ts`, `tests/architecture/removability.test.ts`).

## 3. State inherited (already complete this remediation — do not redo)

Baseline was **355 tests**; the tree is now at **401 tests, 0 fail, 0 skipped**. The golden fixture tree manifest is byte-stable at `sha256 66e1e276…` (first 12 hex `66e1e276b93f`) and must stay so unless you deliberately, and with a recorded reason, regenerate goldens via `evidence:update`. No frozen schema was changed (only the additive `cancellation-request/v1` contract `ERL2-C-063` and append-only error codes were added). Neither Qualiber checkout was touched.

Completed workstreams (see `docs/ledger/remediation-6R.md` for the full disposition table):

- **6R-A offline verifier** — P1-1 (rejected-extra closure), P2-2 (referenced raw-byte rehash + path safety, `packages/public-verifier/src/library/referencedBytes.ts`), P2-3 (signer-inventory signature + attestation binding cross-checks), P2-4 (`verify-record` fail-closed), §11.12 (error-code specificity). Mutation battery: `tests/adversarial/offlineVerifierMutations.test.ts`.
- **6R-B lifecycle/replay/crash** — idempotent replay + failure ownership (P1-2 core), the P2-5 pre-dispatch guard (`assertSubjectPortExecutable`), mandatory `cancel` terminal (new contract), durable cross-process run lease (`packages/core/src/lifecycle/lease.ts`), §11.4 artifact-freeze crash-idempotency, §11.9 snapshot resilience, byte-deterministic timestamps, the crash/replay matrix (`tests/e2e/crashRecovery.test.ts`, `tests/e2e/replay.test.ts`, `tests/e2e/cancellation.test.ts`, `tests/integration/runLease.test.ts`, `tests/adversarial/postRevealExecution.test.ts`), and **ADR-ERL2-018**.
- **6R-C adapter/selection** — P2-6 (adapter response schema validation, `packages/core/src/adapter/responseShape.ts`), P2-7 (OQ-007 guard inside both selection kernels), P2-8 known-answer selection vectors (`tests/adversarial/selectionKnownAnswers.test.ts`), P2-11 honest oracle-surface reconciliation (`LIVE_ORACLE_SCAN_SURFACES` vs `PENDING_ORACLE_SCAN_SURFACES`, `tests/adversarial/oracleSurfaceCoverage.test.ts`).
- **6R-D evidence/independence** — P2-10 **primary** defect (routine `npm run evidence` now generates into a throwaway dir and never mutates goldens; deterministic clock/run-ids/working-dirs; CI golden-drift guard), §9.2 (expected refusals machine-asserted, `tests/e2e/expectedRefusals.test.ts`), §9.5 (Node version recorded/enforced, `tests/architecture/nodeVersion.test.ts`), P2-9 (genuine removability test + form-agnostic purity scanner).
- **6R-E isolation authenticity** — P2-1 verifier-controlled substrate-lock signature verification and distinguished doctor outcome (`packages/core/src/adapter/isolationAuthenticity.ts`; doctor now reports `locally_observed_unauthenticated`, never the producer-assertable `qualified`). README + permitted-claims aligned (part of §11.11). OQ-008 stays open; launcher not built; opaque execution refused.

Invariants that MUST remain true: OQ-008 open; opaque/third-party execution refused; threshold VRF, held-out/blind, Compose, container launcher all fail-closed; no frozen schema silently changed; goldens byte-stable; product independence intact.

## 4. Mandatory starting procedure

1. Read this prompt, `Independent-Code-Review.md`, `docs/ledger/remediation-6R.md`, `docs/adr/ADR-ERL2-018.md`, and the relevant design/plan sections.
2. Establish a clean baseline (the evidence generator is now non-mutating, but still confirm the gate):
   `npm run clean && npm install && npm run build && npm run typecheck && npm run verify:generated && npm test && npm run purity`
   Expect **401 pass / 0 fail**. Record any drift.
3. Confirm the golden manifest is unchanged: `find fixtures/golden -type f -exec shasum -a 256 {} \; | sort | shasum -a 256` → must start `66e1e276b93f`.
4. Do **not** initialise git, branch, commit, or push unless explicitly authorised.

## 5. Working conventions (how this tree is built and tested)

- **Build/gate:** `npm run build` (esbuild + tsc), `npm run typecheck`, `npm run verify:generated` (schemas → `packages/contracts/generated/types.ts` are current), `npm test` (full lane), `npm run purity` (architecture lane). Tests are compiled to `tests/dist/**` and `packages/*/dist/test/**`; run a single file with `node --test "tests/dist/<lane>/<file>.test.js"`. `erasableSyntaxOnly` is on — **no TypeScript parameter properties or other non-erasable syntax**.
- **Contracts:** schemas live in `packages/contracts/schemas/*.schema.json`; each `$defs` name generates a type; register a new contract in `packages/contracts/src/registry.ts` and run `npm run generate` then `verify:generated`. `assertContract("<Name>", value)` validates. Error codes live in `packages/contracts/src/errors.ts` (append-only; every code must use a catalogued prefix from `ERL2_ERROR_PREFIXES`). **Never change a frozen schema’s shape/meaning silently; use a new major + an accepted ADR; add V1/V2 crossover refusal tests; keep unknown fields fail-closed.**
- **Evidence/goldens:** `npm run evidence` (or `evidence:generate`) generates into a throwaway temp dir and prints its path — it does **not** touch `fixtures/golden`. `npm run evidence:update` (adds `--update`) is the only path that rewrites goldens; a byte-deterministic evidence clock is set via `ERL2_EVIDENCE_CLOCK` and the CLI accepts a fixed `--run` id. If you regenerate goldens, do a semantic diff, record the reason, and re-run the full suite; the golden manifest hash will change — call that out.
- **Determinism already in place:** the CLI stamps post-acceptance artifacts with a `SteppingClock` anchored on the durable preregistration `registered_at` (`runClock` in `packages/cli/src/journeyCommands.ts`); `LifecycleLog.writeSnapshot` derives `updated_at` from the last event (no fresh clock read).
- **Ledger:** update `docs/ledger/remediation-6R.md` for every finding you touch (disposition, code change, tests, remaining risk). Keep separate evidence per reported scenario.
- **Test lanes:** contract, integrity, architecture/purity, adversarial, integration, e2e (subprocess), plus the offline-verifier mutation, crash/recovery, and deterministic-evidence lanes. A regression test must fail if the protection is removed. Avoid producer/verifier tests that use the same helper to establish both expected and actual values (see the KAT pattern in `selectionKnownAnswers.test.ts` for genuine independence).

## 6. Remaining scope

### A. P3 cluster (§11.1–§11.14)

Already fixed (do not redo): **§11.4** (artifact-freeze crash-idempotency), **§11.9** (snapshot resilience), **§11.12** (closure error-code specificity), and the isolation half of **§11.11** (README/doctor/permitted-claims contradiction). The rest are pending:

- **§11.1 — strict-JSON duplicate keys via escapes.** `parseStrictJson`/`detectDuplicateKeys` in `packages/contracts/src/validate.ts` compare raw key token spelling, so `{"a\/b":1,"a/b":2}` is accepted and collapses to `{"a/b":2}`. Compare **decoded** property names. Add Unicode-escape and surrogate-pair cases. Design §16.1 requires rejection.
- **§11.2 — `coreHash` universal exclusions.** `packages/integrity/src/hash/hash.ts` hardcodes universal exclusions so top-level `signature`/`root_signature`/`wrapper_signature` escape hashing on every schema; `VOLATILE_FIELDS` are per-`schema_version` tables that contradict the “must be declared per contract” comment. Enforce that excluded authority-bearing fields are legal only for **explicitly recognised signed schema versions** (or version the hashing rule via an ADR). Add a test proving an unknown closed contract cannot smuggle an unhashed authority-bearing field. Do not change frozen bytes.
- **§11.3 — JCS/NFC boundary.** `packages/integrity/src/canonical/jcs.ts` does no NFC normalisation or duplicate-key rejection; those live in the validation layer (`validate.ts` `preCheck` does an NFC check). Determine the exact normative requirement, then ensure **every hashing/verification entrypoint** either validates NFC or rejects non-NFC consistently (e.g. the `store.ts` marker parse path that bypasses `validateContract`). Do not claim RFC 8785 performs NFC if it does not; keep the “restricted RFC-8785 subset” label honest.
- **§11.5 — substrate-drift symmetry + environment-lock signature.** `packages/core/src/environment/substrateLock.ts` (`assertObservedMatchesLock`) is asymmetric — images `locked ⊆ observed` (an extra image passes) and config `observed ⊆ locked` (a missing config passes). Make image/config-hash comparison **exact** (reject extra/missing/substituted; reorder only when order is not semantically relevant). Also verify the **environment** substrate lock’s signature where the trust model requires it (mirror the isolation-lock verification in `packages/core/src/adapter/isolationAuthenticity.ts`). This is inert behind OQ-005 but the README “any drift invalidates” must be true. (The isolation lock’s own `diffObservedAgainstIsolationLock` compares scalars exactly but does **not** compare its `runtime_configuration_hashes`/`policy_input_hashes` arrays — fix that too.)
- **§11.6 — hardcoded fake-subject hashes.** `packages/core/src/run/workspace.ts:769-770` hardcodes `configuration_schema_hash`/`capability_declaration_hash = coreHash({… "fake-subject/v1"})` in every package manifest regardless of the real subject. Derive them from the actual admitted subject/adapter declarations; keep `fake-subject/v1` only inside explicit fake fixtures. Do not weaken the real adapter path.
- **§11.7 — reserved generic-metric drift.** Core (`packages/core/src/evaluation/genericMetrics.ts`) has 17 reserved ids; the evaluation SDK (`packages/evaluation-sdk/src/…`) has 15 (missing `authority-scope` [hard-safety] and `mutation-compensation`), so `certifyPack` can pass a neutered generic metric. Create **one authoritative reserved-generic-metric registry** consumed by both core and the SDK; prove two-way equality with a test. Ensure a pack cannot certify a redefined/neutered generic metric. (Related: `hardSafetyViolations` is exported but has no run-blocking consumer — decide/record its pipeline owner under §11.14.)
- **§11.8 — dev-only shortcut flags in the release CLI.** `--fake-acquire`/`--fake-verify-package` (`packages/cli/src/journeyCommands.ts:52-53,148`) are reachable in the release CLI, contradicting `index.ts` (“no development-only shortcut is reachable”) and plan §8.5. Remove them from release reachability, or place them behind an explicitly separate development binary/profile the design authorises. Do not weaken the real adapter path; a fake succeeded verification must still be unable to finalize (ADR-013).
- **§11.10 — selection-receipt boolean docs.** `SelectionVerificationReceiptV2.checks` booleans are producer-hardcoded `true`; `verify.ts`’s docstring claims they are re-derived and refused on mismatch, but the verifier never reads them. Either re-derive and enforce every receipt check boolean, or remove the misleading documentation. Do not trust producer booleans as verification authority.
- **§11.11 — remaining docs/claims alignment.** The isolation contradiction is fixed. Sweep README, `docs/decisions/open-questions.md`, and `docs/claims/permitted-claims.md` for any other overstatement (substrate enforcement observed-vs-authenticated, launcher unavailable, OQ-008 open, environment-terminal E2E incomplete, pre-environment verifier limitations that are now fixed). Do not rewrite historical ADR conclusions; add superseding clarification where required. Note: the committed `fixtures/golden/cli-transcript.json` doctor entry still shows the old `"qualified"` string (stale until an authorised `evidence:update`); decide whether to regenerate or annotate.
- **§11.13 — handwritten wire types.** `packages/integrity/src/threshold/envelope.ts` (`ThresholdEnvelopeV1`) and the beacon-proof structures are validated by hand, not by a closed schema through `assertContract`. Where they are persisted or cross a trust boundary, add closed schemas + generated types; where JSON Schema is genuinely inapplicable (raw AEAD/crypto format), document and test the explicit format. Do not maintain independent handwritten JSON wire types that can drift.
- **§11.14 — remaining review observations (evaluate, don’t blindly change).** Unbounded strings / missing `uniqueItems` on set arrays; `hardSafetyViolations` having no run-blocking consumer; environment-concurrency test coverage (currently sequential); platform-specific determinism; synthesized discrimination fields (object-value/citation-digest/association harness-synthesized rather than adapter-driven). For each: implement a fix only if the design requires it, otherwise record why the current behaviour is correct and which later slice owns it.

### B. 6R-D evidence-determinism follow-ups (enable a true byte-pin)

The primary P2-10 defect (mutation on routine verify) is fixed; **full byte-identical golden pinning** (`evidence:verify` byte-compare) is blocked by two remaining nondeterminism sources, isolated by a two-generation diff:

1. **Test governor hiding-commitment salts** — `tests/support/governorRegistry.ts` produces randomized hiding commitments (correct by cryptographic design). Seed its randomness deterministically (an injected seeded RNG) so the CLI-driven evidence runs’ artifacts are byte-reproducible.
2. **Real reference-adapter subprocess** — the `adapter-platform` evidence runs drive a real out-of-process adapter that emits PIDs and its own wall-clock in `request.frames`. Make the reference adapter deterministic under an evidence flag (injected clock, no PID file), or exclude those subtrees from the byte-pin explicitly.

Then add `evidence:verify` (deterministic generate → byte-compare against pinned goldens; no source mutation), an `evidence:generate`/`evidence:verify`/`evidence:update`/`evidence` split matching plan §9.1, a **generate-twice byte-identical** proof, regenerate the goldens once via `evidence:update` (recording the semantic diff and the new manifest hash), and switch CI to verify pinned evidence.

### C. 6R-E isolation follow-ups (beyond P2-1, already done)

- **Individual probe-result authenticity (§10.1).** Today the lock is signature-verified and each probe is bound to the lock hash + suite digest, but the **probe results themselves are not independently signed**. Add either per-probe signatures or a signed manifest covering every one of the twenty result hashes, verified before an authenticated qualification is reported. Keep the honest outcome: dev-signed evidence stays `locally_observed_unauthenticated`.
- **§11.5 environment-lock** work above also lives in 6R-E’s orbit (drift symmetry + signature). Keep OQ-008 open; do not build the launcher.

### D. §8.5 production offline selection verification (6.5-gated — record, do not force)

`verifySelectionChain` and the known-answer vectors exist, but the environment offline verifier path does not yet independently re-derive retained selection artifacts (it is unreachable until Slice 6.5). Do **not** wire it live now; instead confirm the interface is ready and record the exact remaining connection in the ledger and handoff (§8.5 “must be complete before Slice 6.5 activates the environment branch”).

## 7. Do-not list

Do not: implement Slice 6.5 orchestration, the container launcher, or the environment terminal; enable opaque/third-party subjects; start the Qualiber adapter; activate held-out/blind, threshold VRF, or Compose; close ERL2-OQ-008; weaken any refusal to make a test pass; change a frozen schema’s meaning/shape silently; expose a production CLI flag that triggers test failpoints; or run `evidence:update` casually (it mutates goldens).

## 8. Completion gates for this continuation

- Every pending P3 (§11.1, §11.2, §11.3, §11.5, §11.6, §11.7, §11.8, §11.10, §11.11-remainder, §11.13, and each §11.14 item) is either fixed with a regression test that fails if the protection is removed, or explicitly rejected/deferred with recorded evidence and the owning slice.
- Evidence determinism: `evidence:verify` byte-compares deterministic generation against pinned goldens without mutating them; generate-twice is byte-identical; CI verifies pinned evidence.
- Isolation: probe results have an authenticated chain (or are explicitly reported unauthenticated); environment-lock drift is exact and its signature verified where required; OQ-008 remains open; opaque execution remains refused.
- Compatibility: no frozen schema silently changed; every contract-major change has an accepted ADR + V1/V2 crossover refusal tests; historical fixtures remain readable.
- Full clean gate green; golden manifest either unchanged or intentionally regenerated with a recorded reason and new hash.

## 9. Required handoff (§16)

After implementation, produce a self-contained handoff containing:

1. Normative design revision and accepted ADR set (note ADR-018 added this remediation).
2. Baseline and final test totals by lane.
3. Finding-disposition table for **every** review finding (P1-1, P1-2, P2-1..11, and every P3), carrying forward the already-fixed items and your new dispositions.
4. Reproductions performed before each fix.
5. Root-cause fixes implemented.
6. Contracts added or changed (and confirmation none was silently mutated).
7. ADRs added or superseded.
8. Verifier mutation results, crash/replay matrix results, cancellation evidence, evidence-determinism proof, isolation-authenticity status.
9. Remaining limitations (including any 6.5-gated items: §8.5 selection offline verification, pending oracle surfaces, translation-totality live wiring, launcher).
10. Exact permitted claims (align `docs/claims/permitted-claims.md`).
11. Confirmation neither Qualiber checkout was inspected or modified.
12. Exact final verification command and its result.

End the handoff with explicit readiness verdicts:

- Slice 6R: complete or incomplete
- Slices 1–6: clean gate or still conditional
- Slice 6.5: ready to resume or blocked
- Trusted reference-subject execution: ready or not ready
- Opaque private-subject execution: not ready
- ERL2-OQ-005: qualified or fail-closed
- ERL2-OQ-008: open, with the exact remaining reason
- Qualiber integration: not started

## 10. Final verification

Run and report exactly:
`npm run clean && npm install && npm run build && npm run typecheck && npm run verify:generated && npm test && npm run purity && npm run evidence`

Confirm `npm run evidence` did not modify `fixtures/golden` (it generates into a temp dir now). Then run fresh-process CLI reproductions for at least: valid pre-environment bundle; invalid record; rejected extra artifact; raw binary tamper; signer-inventory tamper; invalid-record extra; delayed replay; concurrent replay; post-reveal execution attempt; hostile malformed adapter response; cancellation; torn snapshot recovery; selection blind-tier misuse; isolation signature tamper. (Most already have regression tests; cite them.)

Do not declare completion because tests pass. Every confirmed reproduction must have a corresponding regression test and evidence that the production path now refuses or recovers correctly.
