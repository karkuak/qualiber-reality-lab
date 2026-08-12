# Package A exact-head clean gate, with the Compose telemetry observation corrected

Verdict: **PASSED**

Executable commit: `b22e9fb4cb24b030ecaf84fa5d721ed0bf649d6a`
Executable tree: `b3df8f28d319343e85ac3aff9e0a6fbe3ca71f22`
Parent (Package A candidate): `b6fc61f6982bdb8202a0d77902e0a4982309f712`

Run once, in a fresh disposable clone carrying only tracked Git content, with
the repository's own wrapper:

```
node scripts/capture-validation-evidence.mjs --mode gate --out <task-owned directory>
```

which runs the ordinary four-step gate: `npm test`, `npm run verify:generated`,
`npm run evidence:verify`, `git diff --check`.

## Result

| | |
|---|---|
| Started / ended | `2026-08-12T20:15:21.210Z` → `2026-08-12T20:37:45.093Z` |
| Duration | 1 343 883 ms (22 min 24 s) |
| Steps | all four exit 0, signal `null`, output not truncated |
| Tests | **1345 — 1342 pass, 0 fail, 0 cancelled, 3 skipped** |
| Generated types | current |
| Evidence | 838 pinned files / 7 exclusions, byte-identical to the goldens |
| Golden gates | 3/3 invalid + 1/1 valid verify at exit 0 in fresh processes |
| `git diff --check` | clean |
| Tree before / after | `b3df8f28…` / `b3df8f28…`, clean both sides |
| Process residue | none |

### Skips, each named and justified

1. `EXTERNAL-SUBJECT-E2E: an externally authored subject reaches an offline-valid terminal` — *no external adapter entry was supplied*. Expected; the same skip the previous closure recorded.
2. `EXTERNAL-SUBJECT-CANCEL: the supported cancellation path leaves zero residue` — same reason. Expected.
3. `COMPOSE-ADV: the RENDERED configuration publishes one loopback port and nothing else` — *the extracted upstream configuration is absent*. **Fixture-dependent.** Only the pinned archive was provisioned into the clone (digest verified through `readOtelDemoPin`/`sha256File` against the tracked substrate lock); the git-ignored `extracted-1bf3ef8fbaffc049/` directory was not. Materialising it with `node scripts/qualify-otel-demo.mjs --fetch-only` removes this skip.

No stale prototype test was discovered: the clone carried no
`localObservation.test.*` before install, after a clean build, or after the full
gate, and it compiled 112 test files.

## What changed, and what did not

The executable commit differs from the Package A candidate `b6fc61f` by three
test files and nothing else:

```
M tests/e2e/composeEnvironmentRun.test.ts
A tests/integration/durableTelemetryObservation.test.ts
A tests/support/durableTelemetry.ts
```

`git diff --name-only b6fc61f..b22e9fb -- packages adapters packs scripts fixtures environments docs`
returns zero files. The substrate is untouched: `substrate-lock.json`,
`erl2-overlay.yaml`, `erl2-otelcol-extras.yaml`, `composeSubstrate.ts`,
`composeDriver.ts`, `telemetryObservation.ts` and the `reference-otel-demo`
adapter are byte-identical to **both** `b6fc61f` and `origin/main`. The pinned
OpenTelemetry Demo release (`3.0.0`, commit `1755859a…`, archive
`sha256:1bf3ef8f…c051c`) is unchanged.

## Why the correction was needed

`COMPOSE-E2E` previously derived its span count by re-reading
`docker container logs` and matching the console exporter's `Traces` line. The
pinned collector rotates its json-file log (`max-size=5m`, `max-file=2`) and
exports its own self-telemetry through the detailed `debug` exporter, so a
loaded run writes past the retention window in seconds. A diagnosed failure had
three `POST /getquote` 200 responses, spans emitted, a batch of 3 spans received
from `service.name: Str(quote)`, and 63 run-marked records — and still asserted
"telemetry was not actually emitted", because the line carrying the count had
rotated away with the first 48.9 seconds of output.

The observation now attaches `docker container logs --follow` once, when the
collector appears, and copies the stream to a task-owned file. Rotation cannot
evict what is already written there.

`telemetry-regression/` retains the proof that the pass no longer depends on the
container's log retention. In the loaded regression the collector started at
`20:12:52.05`, the earliest console record still retrievable through
`docker logs` was `20:13:40.77` — **48.7 seconds evicted, zero surviving console
`Traces` lines** — and the replaced regex scores **0 spans** on that same view.
The test passed. In this gate the same test passed at 102.4 s under the full
suite's concurrency, which is the contention that produced the original failure.

## Campaign

Not run. Package A invalidates the earlier campaign carry-forward because it
alters the adapter host and protocol boundary; Package B must identify the exact
affected and new controls; the full campaign remains pending independent review
authorization. The targeted mutation and regression checks are not a substitute
for it.

## Layout

- `clean-gate/` — the wrapper's record, its four step logs, and its `SHA256SUMS`, exactly as written outside the tracked tree before anything was committed.
- `telemetry-regression/` — base-compatibility proof, the three normal-condition attempts, the loaded-condition attempt and its conditions, the rotation-independence proof, a bounded excerpt of the loaded run's rotating view, the deterministic observation controls, and their `SHA256SUMS`.
