# Qualiber trusted-local product run — retained evidence, 2026-08-16

One owner-trusted, unscored, development-tier local observation of the Qualiber
`subject-adapter/v2` adapter against a **real** OpenTelemetry Demo `quote`
service. This directory exists to retain the actual bytes of that run. An
earlier, identical run succeeded and its temporary output was discarded; this
one was repeated solely so the evidence survives.

Nothing here is a product change, a Lab change, or a step toward either. No
repository file outside this directory was created or edited, and nothing was
staged, committed, or pushed.

---

## Authority ceiling

This evidence establishes **only** the following:

1. One owner-trusted development observation occurred.
2. The exact named adapter, manifest, plan, input, and record bytes were used.
3. Three operations completed against the real `quote` service.
4. The public offline verifier accepted the retained record.
5. The task-owned environment was cleaned up.

It does **not** establish, and must not be cited as: certification; independent
assurance; confinement or sandboxing; scoring or authentication; governor
authorization; production readiness; reproducibility from a clean checkout;
complete runtime-closure verification; or any dependence of Qualiber on this
particular Lab substrate.

The record says so in its own bytes: `independent_certification: "absent"`,
`confinement: "absent"`, `not_scored: true`, `not_governor_authorized: true`,
`not_authenticated: true`, `not_production_ready: true`,
`evidence_authenticity: "unauthenticated_local_record"`.

The adapter ran as an ordinary child process with the operator's own user
permissions. It was not isolated from the operator's filesystem or network.

---

## Coordinates

| Repository  | Branch | HEAD | Committed tree |
|---|---|---|---|
| Qualiber | `codex/erl2-subject-adapter-v2` | `6e7f5bbdbb70397922bd8fee923fcc2db321ead9` | `169e0aaaba6c0611cd33f16b3f57ccd3d6d170c6` |
| Reality Lab | `codex/v2-trusted-local-observation` | `561d782a92543b95246cce6405cf1cea258edd63` | `5871e2d834f7c61ea221c5b750916765203b9fd3` |

Both repositories carried accepted uncommitted work at the accepted paths only.
Opening and closing listings are in `coordinates/`. Qualiber's status is
byte-for-byte identical between them.

---

## Environment

The `quote` service is an **external prerequisite** of Qualiber, and is treated
as one. Qualiber gained no provisioning capability, and the Lab gained no
Qualiber-specific environment feature.

The run used the Lab's pre-existing qualified substrate at
`environments/otel-demo/` (OTel Demo 3.0.0, upstream commit `1755859a…`,
services `quote` and `otel-collector`, `quote` target port 8090 published on
`127.0.0.1` at an ephemeral host port).

Provisioning went through the **existing, unmodified** `ComposeEnvironmentDriver`
from `@erl2/core`, called by a task-local script
(`substrate/task-local-substrate.mjs`). That script is retained here for
inspection and is **not** production code; it must never be promoted into either
repository. The bounded approach was necessary because the public governed
provisioning command requires registry and acquired-run state unrelated to an
owner-trusted local observation. Only locally present images were used; no
registry pull or other network access was required.

Resolved run coordinates:

- run id `01a01180-0e00-716c-a232-303236303831`
- project `erl2-01a01180-0e00-716c-a232-303236303831`
- quote container `erl2-01a01180-0e00-716c-a232-303236303831-quote`
- published endpoint `127.0.0.1:58113`
- daemon platform `linux/arm64`; both running images matched the lock's pinned
  digests on both legs (locked digest → image id, and running image → repo digest)

---

## Exact commands

Recomputation of the three known byte values, before anything else ran:

```
shasum -a 256 adapters/erl2-subject/dist/qualiber-erl2-subject.mjs
shasum -a 256 adapters/erl2-subject/certification/adapter-manifest.v2.json
```

Lab build (outputs land only in git-ignored `dist/`):

```
npm run build
```

Provision, via the task-local driver script:

```
node scripts/task-local-substrate.mjs provision <substrateRoot> <runIdFile> <outDir>
```

Qualiber's unchanged public plan generator:

```
npm --prefix adapters/erl2-subject run plan:draft -- --endpoint <endpoint.json> --output <plan-draft.json>
```

Declare the trusted-local adapter and seal the plan:

```
npm run --silent erl2 -- declare-trusted-local-adapter \
  --adapter-entry <artifact> --manifest <manifest> \
  --acknowledge-trusted-local-code "<the exact acknowledgement sentence>" \
  --acknowledged-by "<operator>" --declaration-id qualiber-trusted-local-product-run-20260816 \
  --output <declaration.json> \
  --source-repository qualiber --source-commit 6e7f5bb… --source-tree 169e0aa… \
  --seal-plan-draft <plan-draft.json> --plan-output <plan-sealed.json>
```

Run the observation:

```
npm run --silent erl2 -- run-trusted-local-observation \
  --adapter-entry <artifact> --manifest <manifest> \
  --plan <plan-sealed.json> --owner-declaration <declaration.json> \
  --output-root <run-output> \
  --bind-input environment-endpoint-input=<endpoint.json>
```

Independent offline verification:

```
node verification/task-local-verify.mjs <record> <plan> <registryRoot> <adapterEntry> <retainedInputRoot>
```

Destroy:

```
node scripts/task-local-substrate.mjs destroy <substrateRoot> <runIdFile> <outDir>
```

`commands/command-log.tsv` is the ordered log with UTC timestamps and exit
codes. Every logged command exited `0`. It carries no credentials, environment
secrets, or unrelated environment variables.

`translate-evidence`, `project`, scoring, certification, governed execution,
publication, UI work, and a broad test campaign were **not** run.

---

## Bound bytes

| Thing | Hash |
|---|---|
| Adapter artifact | `sha256:3af5a4f0bee08d65f7730d8b5825dd4637141a5bc00f3b4c48711bb17e5a4548` |
| Manifest file | `sha256:984dfcbdc84f496aad6ac78fcc0b79faf9d534d8a669313d7cc680af2a2ef38a` |
| Manifest core | `sha256:dc062eeacf498030b5a0b85608b40ebd95a2b82781abc75bbfb8771720df9a47` |
| Declaration core | `sha256:535592877c8e17a675a6dd8cf9701c4b83fd6837279459271336aef126d8d1cf` |
| Declaration file | `sha256:39847e1b3fd0a82e46b2384339425268159eaa6c4b494039560a5dbfaf4f0b47` |
| Sealed plan core | `sha256:7ac4b9b654c8d3bc6f9fd3ce25eb09d3cebd44d595c5545889fb3db37d0fdbba` |
| Sealed plan file | `sha256:2e2227fa281274c8736431a54e68f85bcc1aecc3b7e2656c526653fbadcfde66` |
| Endpoint input | `sha256:9c6283e9587620a042b8e1f7662f3dfd4db9c4e58b6a21ef35e3e3ff04a7b34d` (95 bytes) |
| Observation record file | `sha256:8a57bc16ac38ffbe0cbbe9529c072896d15d991d0bdadbe43941aea260e1677b` |
| Observation record core | `sha256:825e02e1fde5ed719f3e84b3676e392255ee85bca9d91fc510f44c21c3f4b8a7` |

The first three were recomputed from current bytes before the run and matched
the expected values exactly; `adapter/adapter-hashes.json` recomputes them again
from the copies retained here. Nothing was rebuilt or repaired.

---

## Operation summary

Observation `01a00d6f-4c3c-7b54-9f66-e0adb70adf6b`, terminal status
**`observed_complete`**. Plan: `configure → interact → report-residue`. All three
operations completed, each `supported`, chained by predecessor record hash.

| # | Operation id | Operation | State | Response |
|---|---|---|---|---|
| 0 | `configure-environment-endpoint` | configure | completed | supported |
| 1 | `interact-quote-journey` | interact | completed | supported |
| 2 | `report-residue-final` | report-residue | completed | supported |

### Real product observations

Qualiber issued three genuine HTTP requests to the discovered loopback quote
endpoint and recorded what came back. These bytes are the adapter's own output —
no instrumentation was added to produce them. Source:
`run-output/store/local-observation-output/interact-quote-journey/qualiber/run-summary.json`.

| Step | Event | Path and query | HTTP | Quote value | Elapsed |
|---|---|---|---|---|---|
| 1 | `quote_requested_one` | `/getquote?erl2_run=01a00d6f…&erl2_step=1` | 200 | 8.99 | 51 ms |
| 2 | `quote_requested_three` | `/getquote?erl2_run=01a00d6f…&erl2_step=2` | 200 | 26.97 | 5 ms |
| 3 | `quote_requested_zero` | `/getquote?erl2_run=01a00d6f…&erl2_step=3` | 200 | 0 | 3 ms |

Three egress decision receipts
(`run-output/store/retained/local-observation-adapter/interact-quote-journey/egress-decision-receipt-000{1,2,3}.json`)
each record `decision: "allowed"`, `scheme: "http"`, `host: "127.0.0.1"`,
`port: 58113`, and an empty redirect chain. Every request went to the discovered
loopback endpoint and to nothing else.

Qualiber's own CLI then ran to completion inside the observation
(`telemetrytest validate`, exit 0, `runStatus: clean`), retaining eight product
artifacts under
`run-output/store/local-observation-output/interact-quote-journey/qualiber/product-out/`.
The subject reports what the product emitted; it asserts nothing about whether
that constitutes a pass, and neither does this bundle.

One additional request — a single operator `curl` to `/` on the same port,
answered `404` — was made before the observation purely to confirm the substrate
was listening. It is not part of the adapter's three requests and is noted here
so the count in the logs is not mistaken for a fourth product request.

---

## Verifier result

`verification/verification-pre-publication.json` records the run of
`@erl2/core`'s own unmodified `verifyTrustedLocalObservationRecord` against the
completed record and its required bytes:

- `ok: true`
- `refusals: []` (zero)
- `terminalStatus: "observed_complete"`
- `independentCertification: "absent"`
- `confinement: "absent"`

Alongside it, independently recomputed from the same bytes and all agreeing:
record file digest, record **core** hash, retained plan file digest against the
record's `plan_file_hash`, and the adapter artifact digest against the record's
`adapter_artifact_hash`.

The run's own summary reported the same verdict
(`offline_verification: { ok: true, refusals: [] }`).

---

## Cleanup result

The substrate was destroyed through the same existing driver: receipt status
`succeeded`, `residue: []`, and a post-destroy driver inventory holding nothing.

`substrate/independent-residue-scan.txt` re-asks the question with plain
`docker`, `lsof`, and `ps` rather than the driver, and finds:

- no task container in any state (by run label and by name substring)
- no task network
- no task volume
- published port 58113 free — no listener
- no task child process, and no adapter or harness process

Verdict: `CLEAN`.

---

## Runtime provenance

Resolved from the adapter entry actually executed; see
`adapter/runtime-dependency-provenance.json` for physical paths.

| Package | Version | Resolved from |
|---|---|---|
| `@erl2/adapter-sdk` | 0.1.0 | `…/adapters/erl2-subject/node_modules/@erl2/adapter-sdk/dist/src/index.js` |
| `@erl2/contracts` | 0.1.0 | `…/adapters/erl2-subject/node_modules/@erl2/contracts/dist/src/index.js` |
| `@erl2/integrity` | 0.1.0 | `…/adapters/erl2-subject/node_modules/@erl2/integrity/dist/src/index.js` |
| `@qualgraph/collector` | 0.1.0 | `…/adapters/erl2-subject/node_modules/@qualgraph/collector/dist/collector/index.js` |
| `ajv` | 8.20.0 | `…/Qualiber/node_modules/ajv/dist/ajv.js` |

---

## Known limitations

Disclosed, deliberately **not** fixed by this task:

1. **The external runtime closure is not named by a Lab-retained closure digest.**
   The bundle binds the adapter artifact and manifest exactly; it does not bind
   the ~120-file dependency closure the adapter loaded at runtime.
2. **Package-local `@erl2/contracts` differs from current Lab bytes.** Verified
   during this task: a rollup digest over each side's built `dist` JavaScript
   differs. The adapter ran against its own vendored copy.
3. **Ajv resolves as 8.20.0 while the `@erl2/contracts` package declares 8.17.1.**
   Confirmed: that package's `dependencies` pin `"ajv": "8.17.1"`, and the
   resolution actually used was 8.20.0 from Qualiber's root `node_modules`.
4. **`@qualgraph/collector` is bundled from an ignored build input.** Its
   resolution path sits under a git-ignored `node_modules`, so its bytes are not
   tracked by either repository.

Further limitations worth stating plainly:

- The full dependency closure is deliberately **not** copied into this bundle.
  This run demonstrates product behavior and bounded owner-trusted evidence, not
  complete executable-closure assurance.
- The substrate lock is signed by the repository's **development** governor, not
  by an independent authority. `substrate/substrate-lock.json` says so.
- The ephemeral host port (58113) is specific to this run. The endpoint input,
  the sealed plan's egress policy, and the egress receipts all name it, so the
  bundle is internally consistent but not re-runnable as-is.
- `coordinates/reality-lab-closing-status.txt` was captured after teardown and
  before this directory was published, because a status listing stored inside the
  directory it enumerates cannot describe itself without changing its own bytes.
  The sole intended difference from the opening listing is this directory.

---

## Contents

```
README.md                     this file
coordinates/                  opening and closing branch, HEAD, tree, status
adapter/                      exact artifact and manifest executed, recomputed
                              hashes, runtime dependency provenance
declaration/                  the exact trusted-local declaration
plan/                         original generated draft, and the sealed plan
input/                        endpoint input supplied, and the materialized bytes
run-output/                   the complete successful Lab output tree, internal
                              paths preserved
verification/                 verifier script and its complete result
substrate/                    provision result, lock bytes, resolved digests,
                              resource identities, destroy result, residue scan,
                              task-local driver script
commands/                     ordered command log with timestamps and exit codes
evidence-index.json           every retained regular file: relative POSIX path,
                              byte length, SHA-256; sorted bytewise
evidence-index.sha256         SHA-256 of the exact evidence-index.json bytes
```

Cryptographically bound documents — the record, the sealed plan, the
declaration, the manifest, the frozen artifact descriptors — are retained
verbatim and were not rewritten.
