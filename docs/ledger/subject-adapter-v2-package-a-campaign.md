# Subject Adapter v2 Package A — the 147-control campaign and the gate that followed it

Executable candidate `25aea768a09ff6ba2011e25a00000d5b152990d1`, tree
`b3885321e96418e75e63c6b4f5f7f4c93c4a26ac`.

Two runs, one outcome each. **The campaign passed. The exact-candidate clean gate
failed.** Package A is therefore not publication-ready, and this record exists so
that nobody has to reconstruct why.

## The campaign

Run once, at the candidate, through the repository's own wrapper:

```
node scripts/capture-validation-evidence.mjs --mode campaign --out <task directory>
```

4 h 19 m 27 s. `147 discovered = 147 agreed + 0 disagreed + 0 unmeasured +
0 harness errors`, `repository_byte_identical: true`, `residue: []`.

Independently reconciled from all 147 per-control records rather than read off the
summary: 147 agreements, zero disagreements, zero unmeasured, zero harness errors,
zero truncations, zero signals, zero exit statuses outside `{0, 1}`, zero
undeclared skips, `replacedCount: 1` on 147 of 147, and every control's
`tests = pass + fail + cancelled + skipped`. Three skipped cases, all three
pre-declared. Four controls classified `no_kill_as_declared`, which is what the
four `expect: "pass"` controls are supposed to record.

The count is the one the discovery integration promised: 129 controls at
`d18364d`, plus the 12 v2 controls made discoverable at `ed67eaa`, plus the 6
remediation controls — 147, all ids unique, none of the original 129 removed and
their order preserved.

`otel-demo-upstream` was provisioned from the pinned archive
`sha256:1bf3ef8fbaffc049…` (matching `environments/otel-demo/substrate-lock.json`)
and extracted fresh into the campaign worktree: `verified: true`, `reused: false`,
`fetched: false`. No unverified extraction was reused and the campaign never
reached the network.

Evidence: `docs/evidence/subject-adapter-v2-package-a-closure/negative-control-campaign/`.
It passes `verifyManifest` and `verifyCampaignRecord` with no problems.

## The gate

Run once, at the same candidate, so that the two records name the same commit and
tree — which is what `verifyClosure` requires of a closure, and why the gate was
not run at the campaign-evidence commit instead.

```
node scripts/capture-validation-evidence.mjs --mode gate --out <task directory>
```

`npm test` exited 1 after 44 minutes: **1382 tests, 1378 pass, 2 fail, 0
cancelled, 2 skipped**. The wrapper stops at the first failing step, so
`verify-generated`, `evidence-verify` and `diff-check` did not run. Their status
at this candidate is therefore **unknown**, not passing.

Two tests failed, and neither is attributable to Package A:

- **`COMPOSE-E2E`** failed at `assert.ok(observation.spans > 0)`. The retained
  production observation had `evidence: "observed"`, the right run id and marker,
  and `run_attributed_records > 0` — the collector was reached — but a derived
  span count of zero. `packages/core/src/environment/telemetryObservation.ts`,
  which writes that artifact, is byte-identical to `origin/main` and to
  `b22e9fb`, the last commit with a passing retained gate.
- **`NC-RESTORE`** failed at `JSON.parse` of a marker file whose existence had
  just been asserted successfully — the test's 50 ms `existsSync` poll caught the
  file between creation and content. Its suite and the
  `scripts/lib/disposableWorktree.mjs` it drives are both byte-identical to
  `origin/main`, and it does not invoke `scripts/negative-control.mjs`.

Both read as environmental: one a live-substrate timing window, one a read/write
race in a test's own polling. Neither was re-run, and neither is excluded from the
result. An environmental failure is still a failed gate.

The gate also recorded `after.clean: false`. One untracked file —
`market-research-verifiable-behavioral-testing-2026-08-13.md` — appeared at the
repository root between the campaign's `after` snapshot (`17:11:34Z`, clean) and
the gate's (`18:26:30Z`). It is not this work's; nothing in the campaign or the
gate writes to the repository root. It was left where it is.

Evidence:
`docs/evidence/subject-adapter-v2-package-a-closure/failed-clean-gate-20260813T174226Z/`.
It is stored under that name rather than `clean-gate/` precisely so it cannot be
mistaken for a gate this closure passed.

## What this package does and does not claim now

- The 147-control campaign at `25aea768` **has run and passed**, once, with
  retained evidence that verifies.
- The exact-candidate clean gate **has not passed**. No claim of a clean gate at
  this candidate is made anywhere.
- Package A is **not** publication-ready and **not** merge-ready.
- Nothing was re-run to obtain a better result, no timeout was changed, no
  assertion weakened, and no control added, removed, renamed or reclassified.
- No production, test, script, schema, fixture, generator, configuration or
  lockfile byte changed. The executable tree is still
  `b3885321e96418e75e63c6b4f5f7f4c93c4a26ac`.

## What is owed next

A separate review of the two failures — enough to establish that each is
genuinely environmental and not a latent defect the live substrate only sometimes
exposes — and then one further exact-candidate gate from a clean tree. Until that
gate passes and is retained beside the campaign, this closure stays open.
