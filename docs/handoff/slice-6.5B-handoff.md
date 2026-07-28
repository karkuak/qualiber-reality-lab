# Slice 6.5-B handoff — environment and journey orchestration

Verify every claim here rather than trusting it. The commands to do so are in §5.

## 1. State

- Branch `slice-6.5b-environment-walk`, built on `slice-6.5a-selection-chain`
  (`fa41388`). `main` is still at the 6R commit `176b43b`.
- `npm run clean && npm install && npm run build && npm run typecheck && npm run verify:generated && npm test && npm run purity && npm run evidence && npm run evidence:verify`
  exits **0**.
- **518 tests pass / 0 fail / 0 skipped**; **24** architecture/purity tests.
- `evidence:verify` pins **780** files, **7** excluded by exact path — unchanged
  coverage.
- Golden tree manifest, **deliberately regenerated** (see §4):
  `2f88eb5ca70b0135fa2e13797c3a231a9029f53b015f268be9411cfa93206cf7`
- Host runs Node v26.4.0; the project targets Node 22. Node-22 byte equivalence is
  asserted by CI, not on this host.

## 2. What works end to end

A run advances from `case_selected` to `generic_evaluation_index_frozen` entirely
through the shipped binary, in separate processes:

```
provision → baseline → plan → install → configure → authenticate → connect
  → execute-subject(discover) → activate → journey → observe → freeze-observation
  → execute-subject(exercise) → execute-subject(observe) → remove
  → freeze-output → reveal → evaluate → restore → destroy → finalize-generic
```

Twenty-one durable phases. Crash injection at **every** boundary resumes from
retained evidence and completes, with exactly one of each once-only artifact
however the run was cut. A replayed finished run adds zero bytes. Every refused
command adds zero retained evidence, measured by full-tree byte manifest on a
fresh run and again mid-path.

`erl2 select` now also advances the design's own last selection transition,
`selection_receipt_verified → case_selected`, so `select`'s terminal is
`case_selected` and its step count is 14 rather than 13.

## 3. What compiles but is unexercised

Stated plainly, because dead code that compiles is not done. Each of these was
**measured** by disabling it and re-running, not inferred:

1. **`verifyEnvironmentBundle` is still dead code.** Making it `throw`
   unconditionally leaves 518/518 green. 6.5-B produces no environment run record,
   attestation, signer inventory or public bundle, so nothing reaches it. The
   three §15.4 mutations that need an environment terminal remain open. This is
   the whole of 6.5-E.
2. **`assertRepeatableBaseline` is not load-bearing.** The fake driver is
   deterministic, so two baseline probes agree by construction. Removing the
   assertion leaves the environment suite green. It will matter for the Compose
   driver; it is not evidence today.
3. **The five `case_selected` binding-vs-manifest comparisons are not
   load-bearing.** Removing all five leaves 18/18 green. The producer builds pool
   entries from the admitted manifests, so the opened payload agrees by
   construction, and tampering is caught earlier by the store's hash check. Same
   class as `assertNoSelectionArtifacts`; documented as such at the call site.
   **Do not "fix" this by claiming otherwise.**
4. **No invalid environment terminal.** A partial provision, a failed restoration
   and a failed teardown raise typed Lab-owned refusals that *name* the authorized
   route (`invalid_failure_detected`, receipt-backed emergency cleanup) rather than
   taking it. No shipped path reaches them — the fake driver only does so under a
   scripted fault — but a run that did would stop without an
   `InvalidLabRunRecordV1`, which ERL2-FR-001 requires. This is the largest
   correctness gap in the slice.
5. **The `pre_reveal_subject_cleanup_started` edge is unexercised.** The shipped
   journey runs every committed step before freezing output, so it takes the
   direct `step_outcome_frozen → subject_output_frozen` edge.
6. **The evaluated domain plane is unreachable.** `evaluateDomain` itself refuses:
   an evaluated result requires a revealed functional truth, and this run reveals
   only journey-scope expectations. The not-applicable reason is derived from the
   terminal stage by `buildDomainNotApplicable`, not chosen.
7. **No signed controller receipt.** Design §12 asks for one at activation; no V2
   contract carries it. Activation evidence is the unsigned
   `EnvironmentOperationReceiptV1`.
8. **No `SemanticEvidenceEquivalenceReceiptV1`.** Equivalence is a claim about two
   independently observed environments. A single run has nothing to be equivalent
   to, and `independent_equivalence_verifier_hash` names an unactivated component
   (Slice 9).

## 4. Why the goldens changed

Deliberately, and once. Three new keys enter the development trust policy
(`traffic_supervisor`, `runtime_attestor`, `vault_authorizer` — ADR-ERL2-021 §2),
the governor registry admits four new artifacts (archetype, comparison policy,
cutoff policy, equivalence profile), each challenge candidate now commits its own
full ordered journey, and `FIXED_PAYLOAD_PLAINTEXT_BYTES` rose from 1024 to 2048.
Each of those changes the run trust policy hash or a challenge hash, so every
golden changed. Byte-pin coverage is unchanged and two independent generations are
byte-identical.

## 5. Verify it yourself

```bash
npm run clean && npm install && npm run build && npm run typecheck \
  && npm run verify:generated && npm test && npm run purity \
  && npm run evidence && npm run evidence:verify
find fixtures/golden -type f | LC_ALL=C sort | xargs shasum -a 256 | shasum -a 256
node --test tests/dist/e2e/environmentRun.test.js
node --test tests/dist/adversarial/environmentCommands.test.js
```

The negative-control results are in [`docs/ledger/remediation-6.5B.md`](../ledger/remediation-6.5B.md) §2,
including the ones that did not fail.

## 6. Hazards to carry forward

1. **The substrate is not evidence.** `packages/core/src/environment/substrate.ts`
   deliberately carries no `schema_version` and no `core_hash`, and lives outside
   the run root. `ArtifactIndex.scan` walks the *whole* run root; anything under it
   with both fields is indexed as an artifact. Do not move the substrate inside the
   run root and do not give it a contract shape.
2. **Phase idempotency is answered from evidence, never from state ordering.**
   `step_outcome_frozen` recurs on every journey step, so `state !== X` cannot tell
   "not yet there" from "already past". A first draft did exactly that and made a
   run that never selected a case report a missing inventory.
3. **The capture artifacts are stamped from the realized cutoff, not the clock.**
   That is what makes the observation bundle, the envelope and the translation
   receipt byte-reproducible, and therefore what lets those three transitions be
   interrupted anywhere. Stamping them with `clock.now()` would reintroduce an
   unresumable window.
4. **A baseline fingerprint may only be compared within one probe phase.** The
   phase is part of the fingerprint. Restoration is re-measured in the `baseline`
   phase for exactly this reason.
5. **The byte pin's exclusion list is also its blind spot.**
   `cli-transcript.json` went stale for a whole slice because it is excluded and
   nothing else compared it — see the ledger §3.1. Any new exclusion needs its own
   assertion.
6. **Appendix C and the shipped `select` disagree on a flag** (`--request` vs
   `--run`). A contract decision, not an implementation one; now visible rather
   than buried in a stale golden.

## 7. What remains, in order

- **6.5-C** — production oracle-surface wiring. `LIVE_ORACLE_SCAN_SURFACES` is
  still `["adapter_request"]` and `PENDING_ORACLE_SCAN_SURFACES` still holds the
  rest; 6.5-B added no live surface, deliberately.
- **6.5-D** — the invalid environment terminal: §3 item 4, and the emergency
  cleanup branch behind restoration/teardown failure.
- **6.5-E** — the environment terminal proper: run record, signer inventory,
  attestation, public bundle. That makes `verifyEnvironmentBundle` live and closes
  the last three §15.4 mutations.
