# External Reality Lab V2 — Slice 6.5-B continuation prompt

Self-contained brief for starting **Slice 6.5-B (environment and journey
orchestration)** in a fresh session. Everything needed to begin is here; verify
each claim rather than trusting it.

---

## 1. Workspace

Work in `/Users/karthik/Developer/qualiber-reality-lab`.

**Never** inspect, search, execute or modify:

- `/Users/karthik/Claude/Projects/Qualiber`
- `/Users/karthik/Developer/qualiber-2nd/qualiber`

Do not execute an opaque Qualiber artifact. Do not initialize Git if the
directory is not already a repository (it is one).

## 2. Authoritative inputs, in precedence order

1. Accepted ADRs under `docs/adr/` — **read ADR-ERL2-018, 019 and 020 before
   writing code**; 020 governs everything about selection and the staged walk
2. `external-reality-lab-design-v2.md`, revision **`2.0.0-draft.11`** (confirm
   independently at line 4)
3. `external-reality-lab-implementation-plan.md`
4. Frozen schemas under `packages/contracts/schemas/` and compatibility rules
5. `Independent-Code-Review.md` (note: **pre-6R**, several findings are stale)
6. `docs/ledger/remediation-6R.md`
7. `docs/handoff/slice-6R-handoff.md`
8. `docs/decisions/CONFLICT-ERL2-002.md`, `docs/decisions/open-questions.md`,
   `docs/claims/permitted-claims.md`, `docs/ledger/requirements.json`

There is no `AGENTS.md` or `CLAUDE.md`.

## 3. State as of this handoff — verify before trusting

- **Branch `slice-6.5a-selection-chain`**, HEAD `fa41388` — "Slice 6R pass 4 and
  Slice 6.5-A: selection chain wired end to end". The working tree is clean and
  everything is pushed.
- Remote `origin` is `https://github.com/karkuak/qualiber-reality-lab.git`.
  `main` sits at `176b43b` (the 6R commit) and has **not** been fast-forwarded —
  the 6.5-A work lives only on the branch, pending review or merge. Start 6.5-B
  from `slice-6.5a-selection-chain`, not from `main`, or you will be building on
  a tree without the selection chain.
- Confirm before starting: `git rev-parse --abbrev-ref HEAD` and
  `git status --porcelain` (expect a clean tree).
- `npm run clean && npm install && npm run build && npm run typecheck && npm run verify:generated && npm test && npm run purity && npm run evidence && npm run evidence:verify`
  exits **0**.
- **500 tests pass / 0 fail / 0 skipped**; **24** architecture/purity tests.
- `evidence:verify` pins **780** files, **7** excluded by exact path.
- Golden tree manifest:
  `e5ca10288edd2e1d98bafcb67a58644195d6959ea4d32f64bd8e378b27b42758`
  Reproduce with:
  `find fixtures/golden -type f | LC_ALL=C sort | xargs shasum -a 256 | shasum -a 256`
- Host runs Node v26.4.0; the project targets Node 22. Node-22 byte equivalence
  is asserted by CI, not on this host.

## 4. What already works

### Shipped CLI commands

`doctor`, `status`, `resume`, `verify`, `verify-record`,
`preregister-acquisition`, `preregister-challenge`, `acquire`, `freeze-package`,
`verify-package`, `select`, `freeze-output`, `reveal`, `evaluate`,
`finalize-generic`, `cancel`.

A run reaches **`selection_receipt_verified`** entirely through the shipped
binary in separate processes:

```
preregister-acquisition → acquire → freeze-package → verify-package
  → preregister-challenge → select
```

`erl2 select` advances 13 durable transitions, is resumable, and is idempotent
once complete.

### Slice 6.5-A, complete except where noted

- **Staged selection walk** — `packages/core/src/selection/stages.ts` holds ten
  stage functions; `runSelectionChain` is a fold over them, so the in-memory
  producer (KATs) and the durable CLI producer cannot diverge.
- **Durable walk** — `packages/core/src/run/selectionWalk.ts` is the step table;
  `RunWorkspace.advanceSelection` drives it. Resume rebuilds progress from
  retained evidence only.
- **The unresumable window** — `independent_randomness_requested` is a step with
  no artifact, recorded *before* the beacon is touched. Resuming there refuses
  with `SELECTION_RANDOMNESS_RETRY_FORBIDDEN` (`retry_policy: none_invalidate_run`).
- **Independent auditor** (ADR-020 §7) — `stageReceipt` runs
  `verifySelectionChainCore`, the *verifier* kernel, and signs only if its own
  derivation reproduces the producer's entry, index and rejection count.
- **Verifier-side derivation** — `packages/public-verifier/src/library/selectionEvidence.ts`
  assembles all 17 chain members from retained bytes, cross-checked against the
  lifecycle. No producer-supplied member list anywhere.
- **Signer-role table** — the V2 selection rows are encoded in
  `packages/public-verifier/src/library/signedMembers.ts` per ADR-020 §2.
- **§15.4 mutations** — 17 of 20 covered
  (`tests/adversarial/selectionChainMutations.test.ts`, `…SignerRoles.test.ts`,
  `…EvidenceDerivation.test.ts`).

## 5. Known gaps you inherit — do not rediscover these

1. **`verifyEnvironmentBundle`'s selection block is dead code.** It derives
   evidence and calls `verifySelectionChain`, but no environment bundle exists,
   so nothing executes it. Verified by making it `throw` unconditionally — all
   tests still passed. **Making it live is part of 6.5-B/E.**
2. **Three §15.4 mutations remain**, all needing an environment terminal: wrong
   package binding, wrong source, and an environment bundle that omits selection
   verification.
3. **`assertNoSelectionArtifacts` in the pre-environment path is defense in
   depth**, not load-bearing — the closure's rejected-extra rule fires first.
   Documented as such in code and test; do not "fix" it by claiming otherwise.
4. **`ofSchema` is a shadowing footgun.** It iterates the core-hash map, so a
   byte-copy is invisible to it. Correct for resolving a *reference*, wrong for
   any completeness claim — use `index.retainedFiles()` there. This caused a P1
   during the 6R audit and recurred once in 6.5-A.
5. **`@erl2/public-verifier` now imports `@erl2/core`** for the chain kernel.
   Purity passes, but the offline verifier is no longer independently packageable.
6. **Malformed trust-policy revocation entries fail open** —
   `TrustEvaluator.evaluate` switches on `scope`, so an entry missing it revokes
   nothing. Only matters for hand-built policies.
7. **The shared-formula risk is open** (`Independent-Code-Review.md:87`): the
   producer, auditor and offline verifier all call the same
   `deriveSelectedIndex`/`poolRootOf`. Known-answer vectors are the only defence.
8. **Repo hygiene, pre-existing and now public.** `Independent Code Review.docx`
   and a stray Word lock file `~$dependent Code Review.docx` are both *tracked*
   from earlier history. The development signing keys are derived from labels
   (`developmentKey("selector")`) and are repo-derivable **by design** — that is
   why the isolation claim is `locally_observed_unauthenticated` and no
   production tier is reachable. Neither is a leak; both are worth knowing about
   on a public remote.

## 6. Your task — Slice 6.5-B

Implement phase-specific CLI commands over durable state for the environment and
journey path. Items 1-3 are done; **start at 4**:

1. ~~successful package verification~~ ✅
2. ~~challenge preregistration~~ ✅
3. ~~selection~~ ✅
4. environment reservation
5. provisioning
6. clean baseline
7. execution-plan freeze
8. journey planning
9. install / configure / auth / connect
10. challenge activation
11. traffic or journey start
12. evidence cutoff
13. observation capture
14. subject-output freeze
15. expectation reveal
16. journey / domain evaluation
17. pre-cleanup result join
18. restoration
19. teardown
20. residue verification
21. environment validity
22. generic index
23. environment finalization
24. offline verification

`PLANNED_COMMANDS` in `packages/cli/src/index.ts` lists what is still unshipped:
`provision`, `baseline`, `plan`, `install`, `configure`, `authenticate`,
`connect`, `activate`, `journey`, `observe`, `freeze-observation`,
`execute-subject`, `recover`, `rollback`, `remove`, `restore`, `destroy`, plus
the deep/customer commands that are **out of scope**.

### Every command must

- operate in a **separate process**
- load durable state and acquire the run lease
- reconcile in-flight work
- **validate state before any external call or freeze** — ADR-019 §4; a refusal
  writes zero retained evidence
- preserve the 6R replay and crash guarantees
- return stable typed output (one parseable envelope, catalogued Appendix B
  code, `authority_scope: "lab_orchestration_only"`, empty stderr)

### Architectural constraints

- The fake environment driver is used **only** through `EnvironmentDriver`
  (`packages/core/src/environment/driver.ts`). **No fake-driver branches in the
  lifecycle, finalizer or verifier.**
- Follow the ADR-020 §6 pattern already proven by `select`: one durable
  transition at a time — validate → produce → freeze → append. Do **not** run a
  phase in memory and replay its lifecycle events afterwards.
- The lifecycle transition table (`packages/core/src/lifecycle/states.ts`) is
  the authority on ordering. From `case_selected` the path is
  `environment_provisioned → baseline_verified → execution_plan_frozen →
  step_planned → …`, ending at `environment_validity_result_frozen →
  generic_evaluation_index_frozen → generic_finalized`.

## 7. Method that has worked, and is expected

1. **Survey before writing.** Read the frozen schema and the existing producer
   for anything you are about to touch. Several defects in 6.5-A came from
   assuming a shape.
2. **Drive the shipped CLI in fresh processes.** Brief §14 forbids fixture-built
   artifacts as completion evidence. Tests that build their own evidence prove
   only that they agree with themselves.
3. **Write the negative control.** After every new guard, disable it and confirm
   the test fails. This repeatedly caught tests that passed for the wrong reason
   — including a "passing" mutation suite where 10 of 14 cases never reached the
   layer they claimed to test.
4. **Assert the specific code**, never "some error". A helper that accepted any
   error code hid an entire broken suite.
5. **Full-tree byte manifests** for refusal-writes-no-evidence, measured on both
   a fresh run and one stopped mid-phase.
6. **Never put literal control bytes in source.** `typedRefusals.test.ts`
   carried a real NUL inside deliberate test data, which made git treat the
   whole file as binary and therefore undiffable. Use escapes (`\u0000`) — the
   test data is identical and the file stays reviewable.
7. **Report what is unproven.** Dead code that compiles is not done.

## 8. Verification

Run after every meaningful increment:

```bash
npm run build && npm run typecheck && npm run verify:generated && npm test && npm run purity && npm run evidence:verify
```

Before declaring 6.5-B complete, run the full pipeline from §3 and confirm the
golden manifest is unchanged unless you deliberately regenerated evidence.

## 9. Out of scope — must stay refused

Do not implement or enable: container-backed adapter launcher, opaque-private
subject, third-party subject, Qualiber, Compose, held-out or blind execution,
threshold VRF, privileged broker operations, product-specific deep evaluation,
`commit-deep`, `evaluate-deep`, `finalize-deep`, `verify-customer`.

Preserve: **ERL2-OQ-005** fail-closed (Compose disabled), **ERL2-OQ-007**
fail-closed (development tier only), **ERL2-OQ-008** open (no container
launcher; isolation evidence is dev-signed `locally_observed_unauthenticated`),
`local-process` only for trusted reference subjects, and all existing
independence and purity checks.

## 10. Definition of done for 6.5-B

- Every command in §6 exists, is CLI-driven, and works across separate processes
- A run advances from `case_selected` to `generic_evaluation_index_frozen`
  through the shipped binary
- Each command refuses with zero retained evidence, proven by byte manifest
- Crash/resume is proven at each new phase boundary, as `select` is
- `LIVE_ORACLE_SCAN_SURFACES` / `PENDING_ORACLE_SCAN_SURFACES`
  (`packages/core/src/journey/oracle.ts`) are updated **only** where production
  wiring genuinely exists — that is 6.5-C, so expect to leave most pending
- No fake-driver branch outside `EnvironmentDriver`
- Full verification green; goldens unchanged or deliberately regenerated
- Neither Qualiber checkout inspected or modified

## 11. Report at the end

State plainly: what works end to end; what compiles but is unexercised; which
negative controls you ran and what they showed; any defect you found in existing
code; what remains for 6.5-C/D/E. If a gate cannot be met, say so and why rather
than working around it — the sequencing corrections in 6.5-A came from exactly
that.
