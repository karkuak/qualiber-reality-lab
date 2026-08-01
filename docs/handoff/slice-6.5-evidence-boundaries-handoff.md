# Handoff — Slice 6.5 producer evidence boundaries (Step 6B)

## 1. State

- Branch: `codex/6.5r-evidence-boundaries`, local only, no upstream.
- Parent: `codex/6.5r-cutoff-window-commitment @ eaeec8c` (Step 6A), which is the
  head of draft PR #3. **Nothing here was merged, rebased, pushed or opened as a
  PR**, and PR #3 was not touched. Its three checks were green before this work
  started.
- Working tree clean at the candidate commit.
- Claims ceiling: **T1**, unchanged.

## 2. What changed

Four producer evidence boundaries, each of which had a check that ran on the
shipped path and inspected something other than what crossed it.

1. **Mounted files are scanned as bytes, before they exist.**
   `RunWorkspace.freezeMountedFile` is now the only route into `subject-visible/`.
   It scans the canonical bytes in memory, freezes exactly those bytes, and then
   verifies the reference against the published file. The predecessor scanned
   `JSON.stringify(entry)` over an id, a state and two digests, which no leak in
   mounted content could ever reach.
2. **`lab_telemetry` has one scanner, an earlier boundary, and a control.**
   `assertTelemetryOracleClean` is called from `observe` — before any snapshot is
   retained — and from `freezeObservation`. It previously ran only at the second
   point, after the leaking bytes were already frozen.
3. **Retained subject-output bytes are scanned for secrets.** Secret canaries and
   forbidden identifiers, over the established `scanBytes` /
   `FORBIDDEN_OUTPUT_IDENTIFIERS` vocabulary, byte-wise, before the manifest
   freezes. Deliberately **not** a judge-canary gate — see §3.
4. **The declared output ceiling is enforced against actual bytes.**
   `SubjectExecutionPlanV1.limits.output_bytes`, counted from the payloads read
   back from the store, per occurrence, in bytes.

Plus one defect found while building the tests: **a refusal used to republish the
token it refused**, because the message names a label built from run data. Fixed
by redacting the label with the same patterns the scan matches on.

Decisions: [ADR-ERL2-032](../adr/ADR-ERL2-032.md).
Full record: [`remediation-6.5-evidence-boundaries.md`](../ledger/remediation-6.5-evidence-boundaries.md).

## 3. Read this before planning follow-up work

Four things that will look like omissions and are not.

- **The new subject-output content scan has no judge-canary branch, on purpose.**
  The `subject_output_prefill` oracle scan owns that rule and has a load-bearing
  control proving it. A second gate answering the same question with the same
  code would still refuse the run — and would therefore make that control kill
  nothing. Closing a gap must not cost an existing proof. Two ordering-anchor
  cases fail if this is ever "tidied up".
- **`adapter_request` is now *shadowed*, and the claim is downgraded.** Every
  field of a step request that could carry a token is a hash, an id or the
  visible-step path — and that step's bytes are now refused as a `mounted_file`
  one call earlier. The scan stays as defence in depth, but no shipped input
  reaches it, so it is not counted as load-bearing. Three surfaces are proven,
  not four. This is a consequence of fixing the ordering and it is the better
  trade.
- **The payload bytes are retained before they are scanned, and that is
  deliberate.** `runStep` freezes `subject-output/steps/<id>.out` when the subject
  returns it, because a run that discarded them would have had no subject output
  to scan, evaluate or attribute at all. What the refusal guarantees is that no
  *manifest* and no step-outcome copy is written.
- **A boundary refusal produces no terminal.** It is a pre-freeze refusal: state
  does not advance, nothing is written, and the run closes through the ordinary
  `cancel` route if the operator wants it closed. One case drives exactly that
  and verifies the resulting invalid record offline.

## 4. Verified

**Baseline** at `eaeec8c`, before any change: 883 tests / 0 fail, purity 37/37,
787 pinned / 7 excluded, 3/3 invalid goldens verified offline, 26 m 28 s. It
reproduces the Step 6A handoff exactly.

**Final gate**, from a `git clone` checked out at the candidate commit `1619fe0`
— not from the working tree:

| gate | result |
|---|---|
| `npm run clean && npm install && npm run build` | ok |
| `npm run typecheck` | ok |
| `npm run verify:generated` | generated types are current |
| `npm test` | **922 tests, 922 pass, 0 fail, 0 cancelled, 0 skipped** |
| `npm run purity` | **37 / 37** |
| `npm run evidence:verify` | **787 pinned, 7 excluded**, byte-for-byte; **3 / 3** invalid goldens verify at exit 0 / `valid` in a fresh process |
| `git status --short` / `git diff --check` | empty / clean |

23 m 15 s. 883 → 922 is exactly the 39 cases this package adds.

**Negative controls**, against `473b402`, 3 h 26 m: **92 of 92 scored, 92 agreed,
0 disagreed, 0 harness errors** — 89 behavioural kills and the 3 inherited,
honestly recorded `expect: "pass"` rows. All six new controls kill. The tree was
byte-identical afterwards, with no worktree, no temp directory and no surviving
process. Per-control table: §6.1 of the ledger.

**Pins.** No pinned golden byte changed, and that is a checkable claim rather
than a hope: `freezeMountedFile` composes exactly the bytes `freezeJson` wrote
before, and `EB-MOUNT-BIND: the scanned bytes are the exact published bytes`
asserts that equality directly. The exclusion manifest is unchanged at 7.

## 5. Verify it yourself

```bash
git checkout codex/6.5r-evidence-boundaries
npm run clean && npm install && npm run build
npm run typecheck && npm run verify:generated
npm test && npm run purity && npm run evidence:verify
npm run negative-control
```

To exercise only the new boundaries:

```bash
npm run build && node --test "tests/dist/e2e/environmentEvidenceBoundaries.test.js" "tests/dist/adversarial/evidenceBoundaries.test.js"
```

To run only the six new controls:

```bash
npm run negative-control -- mounted-file-byte-scan
```

## 6. Hazards to carry forward

- **Do not run the negative-control campaign concurrently with a build or a test
  suite.** The repository has already produced misleading failures from a `dist`
  replaced under a running suite.
- **The two ceiling cases really do write 64 MiB each.** That is the point — the
  bound is measured at the real declared ceiling rather than at an injected small
  one — but it makes those two cases the most expensive in the suite, and it
  means the designated suite for four of the six new controls is not cheap.
- **`--fake-output-bytes` is development-profile gated**, like every other
  `--fake-*` flag, and it is refused outright when `--adapter-entry` is present.
  It steers the *subject's* bytes; it cannot move the ceiling they are measured
  against, which is frozen in the run's execution plan.
- **A canary planted in admitted governor data stays in the records of that
  admission.** The archetype mirror and the baseline fingerprint legitimately
  carry it, because a run cannot un-admit its own input. The regression asserts
  the carrier set is *exactly* those two files. A future test that asserts "the
  token appears nowhere" will be wrong for this vector and right for the
  visible-step vector; the difference is real and is recorded in the ledger.

## 7. What remains

Untouched, and deliberately out of scope for this package:

- remaining P3/tooling drift;
- crash matrices for `provision`, `restore`, `destroy` and the emergency actions;
- the missing end-to-end mutation reaching the source-snapshot window comparison;
- ERL2-OQ-005 (Compose), ERL2-OQ-007 (held-out/blind), ERL2-OQ-008 (opaque
  subjects / container qualification);
- the container launcher, threshold VRF, any Qualiber adapter or execution;
- integrated independent re-review of the four stacked remediation packages.

Audited, recorded, not fixed:

- output **file count** and **path depth** on the environment subject-output path.
  `OutputBounds` enforces both on the adapter host's output *tree*; the
  environment path freezes one payload per step outcome from bytes the port
  returns, so there is no tree to walk. A future surface that writes a tree needs
  the bound restated, not inherited.
- the four pending oracle surfaces — `environment_variable`, `process_argument`,
  `diagnostics`, `network_egress` — still named and still unscanned.

## 8. Claims

**T1, unchanged.** Step 6B closes producer-side boundaries and produces no new
evidence about tier, driver, subject or selection. None of the six components
holding the derivation at T1 moves.

`permitted-claims.md` gains a corrected oracle-surface claim (three proven, one
shadowed, replacing "four scanned live"), a closure of the two producer gaps
ADR-ERL2-029 recorded as open, and a new line about refusals not republishing
what they refused.
