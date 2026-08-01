# Handoff — Slice 6.5 cleanup and invalid-terminal remediation

Companion to [ADR-ERL2-027](../adr/ADR-ERL2-027.md) and
[`remediation-6.5-cleanup.md`](../ledger/remediation-6.5-cleanup.md). Successor to
[`slice-6.5B-handoff.md`](slice-6.5B-handoff.md).

## 1. State

Findings **P1-1**, **P1-3**, **P1-5** and **P1-6** from
`Independent-Code-Review-Slice-6.5B.md` are closed on every branch. They were
recorded as closed by ADR-ERL2-024 §14 and were closed on one branch of two; the
audit that established this is `remediation-6.5-cleanup.md` §1.

This does **not** remediate the whole review. P1-9, P1-10, the remaining P2
cluster and the P3 drift are open and listed in §7.

## 2. What changed

| Concern | Before | Now |
|---|---|---|
| invalid-terminal cleanup | two executors; the non-emergency one issued an unconditional whole-environment `driver.destroy()` over a frontier it never read | one executor, `frontierDerivedCleanup`, for every failure phase; `emergency` selects lifecycle route and trigger only |
| a frontier-unsafe resource | destroyed anyway, with nothing retained saying so | survives, and is reported `skipped_unsafe` with its frontier-derived reason and no receipt |
| a foreign resource | threw out of the branch: no terminal, leases retained | fails or skips exactly its own action; the run reaches exactly one invalid record |
| post-cleanup residue | producer-derived from the producer's own action outcomes | `CleanupResidueProbeV1` (ERL2-C-158) retains the substrate as re-observed, beside the pre-action frontier |
| the invalid terminal's finding | named a gate chosen by *cleanup branch* | names the gate its own failure phase falsifies, re-derived offline from `failed_phase` |
| verifier coverage | returned early on any non-emergency cleanup variant | derives the safe-action set, receipts, skips, residue and attribution on every invalid environment terminal |
| the foreign-resource fixture | did not exist; the case that claimed it used a *shared* resource | `FakeDriverFaults.foreignResourceKinds`, reachable through two development-gated CLI faults |

## 3. Contracts

One new identity, `ERL2-C-158` / `cleanup-residue-probe/v1`, in
`erl2:environment`. Additive on the terms ADR-ERL2-026 §6 set for
`restoration-probe/v1`.

- **No frozen schema changed shape or meaning.** No field repurposed, no optional
  field added to a frozen schema, no retained bytes rewritten.
- `EnvironmentDriver` gains no operation. The probe reads `inspect`.
- No new signer key: the probe is unsigned, because an invalid terminal emits no
  attestation and no public bundle.
- Two new refusal codes, `RESIDUE_PROBE_MISSING` and
  `RESIDUE_UNDECLARED_DESTRUCTION`, both in the catalogued `RESIDUE_` family.

## 4. Goldens

`fixtures/golden/invalid-run-emergency-cleanup` is the only golden that changed.
The valid environment terminal, the pre-environment terminal and every other
fixture are byte-unchanged, which is the mechanical form of ADR-ERL2-027 §10's
claim that the valid path is untouched.

Three reasons, each an authorized semantic change:

1. the fixture gains `cleanup-residue-probe.json` — the new contract;
2. it gains `substrate-binding.json` and `environment-archetype.json` — the
   binding ADR-ERL2-024 §10 said these goldens would gain and never did, and the
   archetype it names;
3. its cleanup **actually happens** now. The builder previously fabricated a
   `succeeded` receipt per action and never called the driver, so it modelled a
   cleanup that destroyed nothing while claiming to have destroyed everything.
   `assertActionsAgreeWithResidue` refused it, which is how it was found.

`EXPECTED_PINNED` moves 781 → 787: three artifacts × content plus `.frozen`. The
exclusion manifest is unchanged; the pin grew and did not narrow.

## 5. Verify it yourself

```bash
npm run build && npm run typecheck && npm run verify:generated
npm test
npm run purity
npm run evidence:verify
```

The behavioural claims, individually:

```bash
node --test tests/dist/integration/cleanupDerivation.test.js
node --test tests/dist/adversarial/invalidCleanupDiscipline.test.js
node --test tests/dist/adversarial/emergencyCleanupAdversarial.test.js
```

## 6. Hazards to carry forward

- **A golden's own verification outcome is not pinned.** The exit codes of the
  harness's `verify-record` calls live only in
  `fixtures/golden/cli-transcript.json`, which is excluded from the byte pin
  because it carries absolute CLI paths. During this work the
  `invalid-run-emergency-cleanup` fixture began failing verification with
  `INVALID_REASON_PHASE_MISMATCH` and `evidence:verify` still reported OK. The
  fixture is repaired and named tests now assert the codes, but the pin does not
  cover them. Pinning the codes separately from the paths is the follow-up.
- **`shared_with_other_runs` is not ownership.** A shared resource still embeds
  this run's id, so `assertOwnedByRun` passes for it. Any future case about
  foreignness must use `foreignResourceKinds`; using sharing produces a test that
  cannot fail for the reason it names. This mistake was already in the tree and
  is documented at ADR-ERL2-027 §1.5.
- **The residue probe compares two observations by the same driver.** It narrows
  the window in which a driver can lie *differently* at two moments — the class of
  lie destroy-then-classify produced — and does not make a consistently lying
  driver detectable. Stated in ADR-ERL2-027 §11 and in the permitted claims.
- **A new refusal code must use a catalogued Appendix B prefix.** Both new codes
  were first written under `CLEANUP_` and both were rejected at construction. The
  guard works; expect it.

## 7. What remains

Unchanged by this package and still open:

- **P1-9** — post-capture intents can execute before challenge activation and
  before the evidence cutoff.
- **P1-10** — a refused `journey` freezes a cutoff policy with no lifecycle event.
- The P2 cluster beyond the two items §4 of the ledger closes: `mounted_file`
  scanned with metadata that cannot contain the mounted content; `lab_telemetry`
  with no negative control; secret canaries and forbidden identifiers unscanned on
  the environment subject-output surface; the declared subject-output size limit
  hashed but unenforced; the evidence cutoff never re-derived offline; retained
  subject-output payloads unaccounted in the verifier; the signer inventory's
  `complete_for_terminal_chain` omitting members whose authority field is not
  literally named `signature`.
- The remaining P3 documentation drift.
- ERL2-OQ-005, ERL2-OQ-007 and ERL2-OQ-008 — unchanged, still fail-closed.

**The claims ceiling is unchanged: T1.** This package removes false claims and
adds no true ones.

**The branch is not merge-ready.** Remaining P1 findings must be closed and the
branch re-reviewed independently.

## 8. Picking this up in a new session

### 8.1 What the tree is

This package is committed on branch **`slice-6.5-cleanup-remediation`**, on top of
`e48bdc2` on `main`. The working tree was **clean** when the package started and
is clean again now, so the branch's diff against `main` is exactly this work and
nothing else — there is no user-owned change mixed in, and a new session does not
have to guess which is which.

```bash
git log --oneline main..slice-6.5-cleanup-remediation
git diff --stat main..slice-6.5-cleanup-remediation   # 77 paths, 13 of them new
```

New source (5 files):

```
packages/core/src/environment/residueProbe.ts          the residue arithmetic and builder
packages/core/src/evaluation/invalidityAttribution.ts  the phase -> gate map
tests/integration/cleanupDerivation.test.ts            21 pure derivation cases
tests/adversarial/invalidCleanupDiscipline.test.ts     20 CLI + verifier cases
docs/adr/ADR-ERL2-027.md                               the decision
```

Changed source (10 files): `packages/contracts/{schemas/environment.schema.json,
src/registry.ts, src/errors.ts, generated/types.ts}`,
`packages/core/src/{index.ts, environment/fakeDriver.ts, run/environmentRun.ts}`,
`packages/public-verifier/src/{index.ts, library/environmentDerivation.ts}`,
`packages/cli/src/environmentCommands.ts`. Plus `scripts/generate-evidence.mjs`
(`EXPECTED_PINNED` 781 → 787), `scripts/negative-control.mjs` (+7 controls),
`tests/support/fakeRun.ts`, `tests/adversarial/emergencyCleanupAdversarial.test.ts`,
the `invalid-run-emergency-cleanup` golden, and the docs.

`packages/contracts/generated/types.ts` is generated — run `npm run generate`,
never hand-edit it.

### 8.2 Re-establish the gate in one block

Everything below was green at the state described above.

```bash
npm run build && npm run typecheck && npm run verify:generated && npm test && npm run purity && npm run evidence:verify
```

Expect **675 tests / 675 pass / 0 fail**, purity 24/24, and
`evidence:verify OK — pinned 787 files, excluded 7`. A different test total means
the tree moved; a byte mismatch means a golden moved and needs explaining, not
regenerating.

### 8.3 Negative controls

`npm run negative-control` checks a worktree out at `HEAD` and **refuses a dirty
tree**, so a campaign needs a commit containing the source it measures. During
development this package had none and measured its seven new controls in a
disposable clone; all seven are load-bearing, and
[`remediation-6.5-cleanup.md`](../ledger/remediation-6.5-cleanup.md) §9 records
both those numbers and the full 37-control campaign run in the repository once
this branch existed.

Step 4 can run the campaign directly:

```bash
npm run negative-control                      # all 37
npm run negative-control -- <id>,<id>         # a named subset
```

A control that kills nothing is a non-load-bearing invariant or a suite that is
not isolating it. Report which; never re-score the expectation to make the
campaign green. This package hit that case once and §9 records what it turned out
to mean.

### 8.4 Inputs Step 4 inherits from this package

Step 4 is lifecycle ordering and crash recovery. Three things it should know:

- **Artifacts are frozen before the event that produces them.**
  `frontierDerivedCleanup` freezes `cleanup-residue-probe.json` and then
  `emergency-cleanup-verification.json`, and only then appends the cleanup
  terminal event that names both. A crash in that window leaves retained bytes the
  lifecycle never reached, which the closure derivation rejects as unaccounted.
  This is a **pre-existing pattern**, not something this package introduced — the
  cleanup verification was already frozen ahead of its append — but there is now
  one more artifact inside the window, and it is squarely Step 4's question.
- **Replay is covered where it was already covered and nowhere new.**
  `ENV-CANCEL: replaying a completed cancellation writes nothing and returns the
  same record` still passes, and `BOUNDED-CLEANUP: a foreign resource does not
  prevent the run reaching a terminal` asserts *exactly one* invalid record. No
  new replay guard was added, and none was removed.
- **The residue probe reads `driver.inspect`,** which is read-only by contract and
  carries no durable mutation intent — deliberately, on the terms ADR-ERL2-024
  §4.3 set for `probe` and `inspect`. If Step 4 changes what an observation owes,
  this is one of the call sites.

### 8.5 Where to start reading

[ADR-ERL2-027](../adr/ADR-ERL2-027.md) §1 for what was wrong,
[`remediation-6.5-cleanup.md`](../ledger/remediation-6.5-cleanup.md) §1 for the
audit that found it and §9 for what was measured, then this file.
