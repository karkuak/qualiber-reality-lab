# Slice 6.5-B/C/D/E handoff — environment and journey orchestration

Verify every claim here rather than trusting it. The commands to do so are in §5.

## 1. State

- Branch `slice-6.5b-environment-walk`, built on `slice-6.5a-selection-chain`
  (`fa41388`). `main` is still at the 6R commit `176b43b`. The branch carries
  6.5-B, C, D and E.
- `npm run clean && npm install && npm run build && npm run typecheck && npm run verify:generated && npm test && npm run purity && npm run evidence && npm run evidence:verify`
  exits **0**.
- **541 tests pass / 0 fail / 0 skipped**; **24** architecture/purity tests.
- `evidence:verify` pins **781** files, **7** excluded by exact path. The one
  added file is the environment run's deterministic closure summary; no exclusion
  was widened.
- `npm run negative-control` runs all ten controls in a disposable worktree and
  proves the working tree is unchanged afterwards. Its first real run found two
  defects in the controls themselves — see the ledger §10a.
- Golden tree manifest, **deliberately regenerated** (see §4):
  `b84b9275b3bfa6fe8c11270c26e5ea7ccbb1e5e42845b41c423fabc6c3bd268c`
- Host runs Node v26.4.0; the project targets Node 22. Node-22 byte equivalence is
  asserted by CI, not on this host.

## 2. What works end to end

A run advances from `case_selected` to a **finalized, offline-verifiable
environment terminal** entirely through the shipped binary, in separate
processes:

```
provision → baseline → plan → install → configure → authenticate → connect
  → execute-subject(discover) → activate → journey → observe → freeze-observation
  → execute-subject(exercise) → execute-subject(observe) → remove
  → freeze-output → reveal → evaluate → restore → destroy → finalize-generic
```

Twenty-one durable phases, ending at `generic_finalized`. `erl2 verify --offline`
on the resulting public bundle returns exit 0, verdict `valid`, variant
`environment`, terminal stage `remove`, no missing roles and no rejected extras.

Crash injection at **every** boundary resumes from retained evidence and
completes, with exactly one of each once-only artifact however the run was cut. A
replayed finished run adds zero bytes: evidence-producing phases replay as no-ops,
subject-executing phases are refused. Every refused command adds zero retained
evidence, measured by full-tree byte manifest on a fresh run and again mid-path.

**A failing run reaches a terminal too.** A partial provision, a contaminated
baseline, a failed restoration and a failed teardown each freeze exactly one
`InvalidLabRunRecordV1` after frontier-derived cleanup; restoration and teardown
take the mandatory receipt-backed emergency branch, and the record verifies
through `erl2 verify-record --offline`.

**Three more oracle surfaces are canary-scanned on live paths** —
`lab_telemetry`, `mounted_file` and `subject_output_prefill` join
`adapter_request`. A canary planted in the subject's own output bytes refuses
before anything freezes, proven end to end through the CLI.

`erl2 select` now also advances the design's own last selection transition,
`selection_receipt_verified → case_selected`, so `select`'s terminal is
`case_selected` and its step count is 14 rather than 13.

## 3. What compiles but is unexercised

Stated plainly, because dead code that compiles is not done. Each of these was
**measured** by disabling it and re-running, not inferred:

1. **`assertRepeatableBaseline` is not load-bearing.** The fake driver is
   deterministic, so two baseline probes agree by construction. Removing the
   assertion leaves the environment suite green. It will matter for the Compose
   driver; it is not evidence today.
2. **The five `case_selected` binding-vs-manifest comparisons are not
   load-bearing.** Removing all five leaves 18/18 green. The producer builds pool
   entries from the admitted manifests, so the opened payload agrees by
   construction, and tampering is caught earlier by the store's hash check. Same
   class as `assertNoSelectionArtifacts`; documented as such at the call site.
   **Do not "fix" this by claiming otherwise.**
3. **The `pre_reveal_subject_cleanup_started` edge is unexercised.** The shipped
   journey runs every committed step before freezing output, so it takes the
   direct `step_outcome_frozen → subject_output_frozen` edge.
4. **The evaluated domain plane is unreachable.** `evaluateDomain` itself refuses:
   an evaluated result requires a revealed functional truth, and this run reveals
   only journey-scope expectations. The not-applicable reason is derived from the
   terminal stage by `buildDomainNotApplicable`, not chosen.
5. **No signed controller receipt.** Design §12 asks for one at activation; no V2
   contract carries it. Activation evidence is the unsigned
   `EnvironmentOperationReceiptV1`.
6. **No `SemanticEvidenceEquivalenceReceiptV1`.** Equivalence is a claim about two
   independently observed environments. A single run has nothing to be equivalent
   to, and `independent_equivalence_verifier_hash` names an unactivated component
   (Slice 9).
7. **`recover` and `rollback` are shipped but unexercised.** The fixture journey
   commits neither intent, so both commands can only refuse.
8. **No golden environment run.** The pinned evidence set still holds only
   pre-environment and emergency-cleanup fixtures. A CLI-driven environment run
   with its public bundle is the natural next golden.
9. **Four oracle surfaces remain pending** — `environment_variable`,
   `process_argument`, `diagnostics`, `network_egress` — each named individually
   in `PENDING_ORACLE_SCAN_SURFACES` and asserted there, because none of them is
   a surface any shipped run produces.

## 4. Why the goldens changed

In 6.5-B only. 6.5-C, D and E changed no golden: `evidence:verify` still passes
byte-for-byte at 780 pinned / 7 excluded, and the tree manifest is unchanged.

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
node --test tests/dist/e2e/environmentInvalidTerminal.test.js
node --test tests/dist/adversarial/environmentCommands.test.js
node --test tests/dist/adversarial/environmentTerminalMutations.test.js
```

The negative-control results are in [`docs/ledger/remediation-6.5B.md`](../ledger/remediation-6.5B.md)
§2 and §7, including the three that did not fail.

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
7. **An environment bundle needs the verifier's pinned beacon.** A pre-environment
   bundle carries no selection chain, so an empty `randomnessSources` is enough.
   An environment bundle carries the selection verification receipt as a mandatory
   member, so a verifier without the pinned entry refuses with
   `RANDOMNESS_SOURCE_NOT_PINNED`. That is the fail-closed answer, not a
   configuration inconvenience.
8. **The signer inventory is built before the closure and frozen after it.**
   Freezing it first made finalization refuse its own working file as an
   unaccounted artifact.
9. **A caller-supplied bundle must be written outside the run root.** The artifact
   index scans the whole run root; a mutated bundle left inside makes every case
   refuse for "two public bundles" rather than for the mutation under test.
10. **A mutation test must give the mutated document a consistent identity.**
    Otherwise the refusal is `ARTIFACT_HASH_MISMATCH` and the case passes with the
    rule under test entirely absent.

## 7. What remains

6.5-B, C, D and E are all on this branch. What is left is named in §3 and, in
priority order, is:

- **A golden environment run** in the pinned evidence set, with its public bundle
  verified in the CLI transcript. Everything needed exists; nothing pins it yet.
- **The evaluated domain plane**, which needs a subject that emits a claim set and
  a revealed functional truth — the last plane that is refused rather than run.
- **`recover` / `rollback` coverage**, which needs a fixture journey that commits
  those intents.
- **The remaining four oracle surfaces**, each of which needs a run that actually
  produces it: the adapter host's environment and process surfaces, a subject that
  emits diagnostics, and a run that egresses.
- **The `pre_reveal_subject_cleanup_started` edge**, unexercised on both branches.
