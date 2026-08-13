# Subject Adapter Protocol v2 — Package A closure evidence

Executable candidate: `25aea768a09ff6ba2011e25a00000d5b152990d1`
Executable tree: `b3885321e96418e75e63c6b4f5f7f4c93c4a26ac`

This directory holds the two long validation runs for Package A. **The closure is
incomplete**: the campaign passed, the exact-candidate clean gate did not.

## What is here

| Directory | Run | Outcome |
|---|---|---|
| `negative-control-campaign/` | the full 147-control negative-control campaign | **passed** |
| `failed-clean-gate-20260813T174226Z/` | the exact-candidate clean gate | **failed** |

The failed gate is deliberately *not* stored at `clean-gate/`. `verifyClosure`
reads that name, and a failed gate parked there would present itself as this
closure's gate. Kept under its own timestamped name, the closure verifier reports
the truthful `clean-gate/ is missing` — the campaign is retained, the gate is
still owed.

## The campaign — passed

```
node scripts/capture-validation-evidence.mjs --mode campaign --out <task directory>
  → node scripts/negative-control.mjs --evidence-out …/campaign.json
```

Started `2026-08-13T12:52:07.927Z`, ended `2026-08-13T17:11:34.673Z`
(15,566,745 ms — 4 h 19 m 27 s).

```
accounting: 147 discovered = 147 agreed + 0 disagreed + 0 unmeasured + 0 harness errors
repository_byte_identical: true      residue: []      reconciled: true
```

Every control patched exactly one site (`replacedCount: 1`, 147/147), every
per-control counter reconciles, no output was truncated, no run was terminated by
a signal, and no exit status fell outside `{0, 1}`. Three cases skipped, all three
pre-declared through `expectedSkips` as `RENDERED TOPOLOGY UNPROVEN`; zero
undeclared skips. 143 controls classified `named_tests_failed` and 4
`no_kill_as_declared` — the latter are the four controls that declare
`expect: "pass"`, whose mutations must *not* be caught.

Prerequisites: `otel-demo-upstream` satisfied with `verified: true`,
`reused: false`, `fetched: false` — extracted fresh inside the campaign worktree
from the pinned archive `sha256:1bf3ef8fbaffc049…`, which matches
`environments/otel-demo/substrate-lock.json`. `docker-daemon` satisfied.

One field in `campaign.json` needs a reader's caution. `process_residue` carries a
single entry, and it is **not** a leaked campaign process: it is the reviewer's
own read-only health-check shell, matched because the wrapper's residue regex
(`/negative-control\.mjs|erl2-negative-control|node --test/`) is applied to `ps`
command *text*, and that shell's command line quoted those strings. It was a
`zsh` running `sleep`, it spawned no `node`, and it exited on schedule. The record
is retained unedited: correcting it would break the manifest, and evidence that
gets tidied after the fact is not evidence.

## The gate — failed

```
node scripts/capture-validation-evidence.mjs --mode gate --out <task directory>
```

Started `2026-08-13T17:42:26Z`, ended `2026-08-13T18:26:30Z`. The first step
failed, so by design the remaining three (`verify-generated`, `evidence-verify`,
`diff-check`) were not run.

```
npm test → exit 1 in 2,642,330 ms
totals: 1382 tests, 1378 pass, 2 fail, 0 cancelled, 2 skipped
```

`verifyGateRecord` refuses this record on three counts, all of them true:

- `step test: exited 1`
- `the gate recorded 2 failing test(s)`
- `the worktree was not clean after the gate`

### The two failing tests

**`COMPOSE-E2E: a run reaches an offline-valid terminal through a real Compose
substrate`** — `assert.ok(observation.spans > 0)`
(`tests/e2e/composeEnvironmentRun.test.ts:452`). The assertion reads the retained
production artifact `attributable-telemetry-observation.json`, written by
`packages/core/src/environment/telemetryObservation.ts`. Everything before it
passed: `evidence: "observed"`, the run id and marker matched, and
`run_attributed_records > 0` — the collector was reached and records naming this
run existed. Only the derived span count was zero.

Not attributable to Package A. `telemetryObservation.ts` is byte-identical to
`origin/main` and to `b22e9fb`, the last commit whose retained gate passed. The
only change to the e2e file since `b22e9fb` is the one-line call-site rewiring at
line 256 (`awaitDurableTelemetry({capturePath}) → ({capture})`), which feeds a
different assertion block. This is a live-substrate timing failure: the retained
excerpt carried run-marked records but no `Traces … "spans": N` summary line
inside the observation window.

**`NC-RESTORE: SIGINT releases the worktree before exiting`** —
`SyntaxError: Unexpected end of JSON input`
(`tests/integration/negativeControlHarness.test.ts:405`). The preceding
`assert.ok(existsSync(marker))` passed, so the marker file existed; the very next
`JSON.parse(readFileSync(marker))` found it empty. The test polls `existsSync`
every 50 ms and observed the file between the child's `writeFileSync` creating it
and its contents landing. A read/write race in the test's own polling.

Not attributable to Package A either: `negativeControlHarness.test.ts` and the
`scripts/lib/disposableWorktree.mjs` it exercises are both byte-identical to
`origin/main`. The test does not invoke `scripts/negative-control.mjs`.

Both failures are environmental rather than regressions — but an environmental
failure is still a failed gate. Nothing here is excluded, re-run or explained
away, and no claim of publication readiness follows from it.

### The unclean worktree

At `18:26:30Z` the working tree carried one untracked file at the repository
root:

```
?? market-research-verifiable-behavioral-testing-2026-08-13.md
```

It is not this task's. Nothing in the campaign, the gate or the surrounding
review writes to the repository root, and the campaign's own `after` snapshot at
`17:11:34Z` recorded `clean: true` with an empty status. The file therefore
arrived between those two snapshots, from another session; its birth timestamp
(`13:54:45Z`) predates its arrival, so it was moved or copied in with timestamps
preserved. It was left in place — it belongs to whoever created it.

A re-gate must start from a genuinely clean tree, or it will record
`after.clean: false` again for the same reason.

## Verifying this directory

```bash
shasum -c SHA256SUMS            # inside each subdirectory
node scripts/verify-validation-evidence.mjs --dir docs/evidence/subject-adapter-v2-package-a-closure
```

The closure verifier is expected to report exactly `clean-gate/ is missing` until
a passing exact-candidate gate is retained. The campaign subdirectory verifies
byte-for-byte and reconciles on its own.
