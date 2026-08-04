# Runbook — environments and the clean control

## Which driver is active

```bash
node packages/cli/dist/src/bin.js doctor --profile local-developer
```

Today it reports:

```text
fake_environment_driver:      enabled
compose_environment_driver:   disabled_pending_erl2_oq_005
otel_demo_substrate_lock:     unqualified_pending_erl2_oq_005
constrained_archetypes:       clean_greenfield_only_pending_erl2_oq_002
```

The fake driver is deterministic, needs no substrate, and models every lifecycle
and failure path the Compose driver will have to handle. Both satisfy the same
`EnvironmentDriver` contract suite.

## The clean control

`clean-greenfield` is the required control archetype (design v2 §9). A run is
only admissible from a clean baseline:

1. `provision` creates run-scoped resources. Every resource name embeds the run
   id, and `resourceIdentityHash` refuses one that does not.
2. `probe --phase baseline` produces an `EnvironmentBaselineFingerprintV1`.
3. `assertBaselineClean` refuses a contaminated baseline or a failed probe. The
   failure is Lab-owned; no subject finding may be derived from it.
4. `assertRepeatableBaseline` compares two clean provisions. The fingerprint is
   derived from ordered probe observations and evidence-source states only — not
   from run id, instance identity or timestamps — so two clean runs of the same
   archetype must produce **identical** fingerprint bytes.

If two clean provisions disagree, the archetype is not repeatable. Do not
attest against it; fix the archetype or the driver.

## Isolation between concurrent runs

The global allocator stores **reservation leases only** — never resource state.

- Two runs cannot reserve the same network, volume, port, tenant or project.
  The second gets `ENV_RESERVATION_CONFLICT`; it does not wait.
- A lease from a crashed run is reclaimable once it expires, so a dead run
  cannot deadlock the substrate. `reclaimExpired()` reports exactly what it
  reclaimed.
- A run cannot release another run's lease.

## The evidence window

`erl2 journey` freezes a signed `evidence-window-commitment/v1` before the run
observes the runtime milestone. It carries the **exact** warmup and observation
durations — 1 000 ms and 5 000 ms in the development profile — and every later
phase reads it rather than a module constant.

Three things follow that an operator should know:

- **The window is fixed before the milestone is observed, and the milestone must
  land on it.** A run whose milestone does not fall exactly at
  `process_started_at + warmup_ms` refuses with `CUTOFF_BOUND_EXCEEDED` and
  freezes nothing — the commitment is sealed in memory and written only once both
  artifacts exist.
- **The durations must be whole seconds.** Retained instants are second-precision
  and the renderer truncates rather than rounds, so a sub-second window would
  produce an instant that disagrees with its own arithmetic. It is refused before
  it is signed.
- **The window is signed by `policy_author`**, the authority that already bounds
  it in `cutoff-policy/v1` — never by the traffic supervisor or the runtime
  attestor, whose clocks the cutoff derivation is anchored on.

An offline reader then rederives the cutoff exactly rather than checking it
against bounds (ADR-ERL2-031). What that does **not** do is stop an authorized
`policy_author` from committing a different window deliberately; which windows are
permissible is the cutoff policy's business, and who may commit one is the trust
policy's.

## Cleanup and the resource frontier

Cleanup targets exact validated identities. A wildcard or unscoped selector is
refused with `ENV_BROAD_DELETE_REJECTED`; ambient project discovery does not
exist.

**Every** invalid environment terminal takes the same route — not only a
restoration or teardown failure (ADR-ERL2-027 §4.1). The `emergency` flag decides
which lifecycle states the terminal passes through and which trigger the frontier
records; it does not decide which safety rules apply. Until ADR-ERL2-027 it did,
and the other five failure phases reached an unconditional whole-environment
`driver.destroy()` issued one line after the frontier was frozen and without
reading it.

1. Freeze the failure's own Lab-owned finding, **before** anything else. It names
   the gate its phase falsifies (`ENVIRONMENT_PHASE_GATE`), so a cleanup that
   later fails adds evidence and never replaces the cause.
2. Freeze the frontier with `freezeResourceFrontier`. It records what the driver
   *observed*, before any dispatch.
3. The safe-action set is **derived here**, not supplied by the driver. A
   resource is independently safe to act on only when it is provably this run's,
   marked destroyable, and not shared with another run. Anything else becomes a
   `contain_residual` action marked unsafe with a reason.
4. Attempt every independently safe action, each inside its own failure boundary,
   and freeze a receipt for each — for failures as well as successes. A foreign
   or unsafe resource fails or skips exactly one action; it never stops the
   others.
5. Record each unsafe skip with a reason and **no** receipt.
6. Re-observe the substrate and freeze `CleanupResidueProbeV1`. This is the
   independent post-cleanup observation: without it the residue is derived by the
   producer from its own action outcomes, so an empty one cannot be contradicted.
7. Freeze `EmergencyCleanupVerificationV1` (skipped when the frontier derived no
   action — the contract's `actions` has `minItems: 1`), and only then the
   invalid record.

A whole-environment dispatch is permitted only when the driver offers no narrower
granularity **and** every observed frontier member derives an authorized action.
Otherwise the affected actions are recorded `failed` with
`EMERGENCY_ACTION_UNDECLARED_TARGET` and nothing is dispatched.

`erl2 verify-record` refuses a restoration or teardown failure that reached the
invalid record without this path (`EMERGENCY_CLEANUP_BYPASSED`),
`assertFrontierActionsDerivable` refuses a frontier whose action list was edited,
and the residue probe makes two further lies offline-detectable:
`RESIDUE_PROBE_MISSING` when the observation is absent or is about another run,
substrate or frontier, and `RESIDUE_UNDECLARED_DESTRUCTION` when a resource left
the substrate without an authorized action against it.

## Cancelling a run

`erl2 cancel` is dispatched from the run's **own durable evidence**, never from a
flag. `classifyCancellationBranch` is shared by the CLI dispatcher and the library
so the decision cannot disagree with itself, and it consults two independent
witnesses:

1. the retained `substrate-binding` artifact, read so that `ENOENT` is the only
   condition meaning "this run never had an environment";
2. the run's own lifecycle events, which name the roles they produced.

Either one is enough to take the environment branch. **Anything other than
absence is a typed refusal** (`ENV_SUBSTRATE_UNREADABLE`), never an answer: the
previous `existsSync` read reported false for a permission fault as readily as for
a missing file, and routed a live environment run to the pre-environment terminal
where it froze cleanup status `not_required` over allocated resources.

| Cancelled from | Route | Cleanup |
|---|---|---|
| before `provision` | pre-environment | `none` / `pre_environment` |
| any state with a binding, including mid-provision | environment, frontier-derived | never `not_required` |
| during restoration or teardown | emergency | continued, not restarted |
| during emergency cleanup | emergency, **continued** | the existing frontier is adopted and its trigger kept |
| after a terminal | the same record, idempotently | unchanged |

### What "continued" means

The frontier is **adopted by role** rather than re-observed, and the cleanup keeps
the frontier's own trigger. A cancellation must not relabel the failure it is
cleaning up after: freezing a second frontier with `trigger: teardown_failure`
over a restoration failure's frontier produced different bytes at the same logical
path, raised `ARTIFACT_ALREADY_FROZEN`, and left the run with no terminal and its
leases still held.

Completed driver actions are not re-dispatched — each runs under a durable intent
whose probe is the driver's own operation log — so continuation is about the
evidence, not the dispatch.

### Pending operations

Before any cleanup call, every unsettled operation is reconciled and anything that
cannot be established is recorded in the **hash-chained lifecycle**, as the
detection event's Lab-owned `failure`. The intent journal is run-private and an
offline reader never sees it, so an ambiguity recorded only there is recorded
nowhere.

Three answers, not two: an intent at `declared` proves nothing was dispatched; a
subject step with a frozen outcome is complete whatever its marker says; anything
else the driver's log cannot confirm is genuinely ambiguous.

## Recovering a crashed run

A command that dies mid-phase leaves a durable intent naming exactly how far it
got. The next process reconciles before it retries.

```bash
erl2 status --run <run-id> --artifact-root <run-root>
```

Then re-run the same command. Three things make that safe:

- **the lease does not block you.** A killed process leaves its run lease held;
  `RunLease.acquire` reclaims a lease whose pid the kernel reports absent, so
  recovery does not wait out the five-minute TTL. Every ambiguity — including PID
  reuse — resolves to *alive*, so a live holder is never displaced;
- **a driver operation is adopted, not repeated.** Its probe is the driver's own
  operation log, so the external invocation count stays at one;
- **a subject step fails closed if it is genuinely ambiguous**, and reaches the
  invalid terminal with `failed_phase.kind = "journey_execution"`, owned by the
  **Lab**. The Lab cannot establish what the subject did and does not pretend to.

To exercise this deliberately, under the development profile only:

```bash
ERL2_DEVELOPMENT_FAKE_SUBJECT=1 erl2 install ... \
  --crash-at after_external_dispatch \
  --invocation-log /tmp/invocations.jsonl
```

`--crash-at` ends the process with `SIGKILL` at one of the eight boundaries in
`CRASH_BOUNDARIES`; `--invocation-log` appends one record before and after every
external call, so the count survives the process. Both are refused on the release
surface with `CFG_DEVELOPMENT_FLAG_UNAVAILABLE`, and an unknown boundary name is
`CFG_MISSING_REQUIRED` rather than being ignored.

## Running Compose (ERL2-OQ-005)

The OpenTelemetry Demo substrate is qualified. `erl2 doctor` derives the state
from the retained lock on every call — read `compose_substrate` there rather than
trusting this paragraph.

```bash
node scripts/qualify-otel-demo.mjs --fetch-only     # the pinned archive is an input
erl2 provision --run <id> --run-root <root> --registry <reg> --tier development \
  --archetype <hash> --environment-driver compose
```

`--environment-driver` defaults to `fake`, and a run binds its driver **once**: a
later command naming the other one is refused with
`ENV_SUBSTRATE_LOCATOR_CONFLICT`, and every later command with no flag reaches the
substrate the run bound. `--substrate-lock` and `--otel-demo-archive` override the
shipped paths; both are re-verified, so overriding them cannot weaken admission.

What the qualified subset is, what is pinned, and what it does **not** prove is in
`environments/otel-demo/README.md`. In short: two services (`quote` and
`otel-collector`) out of the upstream demo's twenty-two, digest-pinned for
`linux/amd64` and `linux/arm64`, with the lock signed by the repository's own
*development* environment-governor key — a self-qualification, never an
independent one.

`darwin/arm64` is not a required platform and never was an image-manifest
platform: Docker Desktop on macOS runs Linux containers, so the images a macOS
host executes are `linux/arm64`. `REQUIRED_PLATFORMS` is `linux/amd64` +
`linux/arm64`.

There is no flag that skips qualification. `composeDriverManifestBody` derives
`enabled` from the lock, so an unqualified lock always produces a disabled driver,
and `assertObservedMatchesLock` re-observes the archive, the five applied
configuration files and both platforms' image digests at `provision` — before a
single container exists.

### What is re-derived from Docker on every operation

Admission covers the bytes that are *about* to run. Three things about what is
*actually* running are re-derived instead of read back from a name or a file:

- **ownership.** A container is treated as this run's only when it carries
  `com.erl2.run_id=<this run>`, `com.erl2.driver_id=compose-driver` and
  `com.docker.compose.project=erl2-<this run>` exactly, and only when the image it
  is running resolves through the daemon to the exact service/platform digest the
  lock pins — checked in both directions, so an unresolvable image is "not proven"
  rather than assumed. A container that fails is still inventoried, as
  `unverified-container-…`, but it fails the baseline probe, counts as preexisting
  residue, withholds the endpoint record, blocks adoption of the provision receipt,
  and refuses every write with `ENV_FOREIGN_RESOURCE_REJECTED`. An expected name is
  not ownership.
- **the endpoint.** The record `provision` writes under the substrate root is a
  hint, not a grant. `readComposeEndpoint` checks every field against a value
  derived from the run id — including `host` exactly `127.0.0.1` — and then
  re-inspects live Docker for all four of: this run's three ownership labels, a
  running state, the **locked image** (the same two-legged rule the driver uses, so
  an exact-name container running other bytes is authorized nothing), and the
  binding **`8090/tcp` on `127.0.0.1` at exactly the recorded host port**. A stale
  record after teardown, a restarted container with a new ephemeral port, a port
  another process took over, a binding on `0.0.0.0`, and the recorded port
  published under some other container port all yield no endpoint — so the subject
  gets no mount and no allowlist. The record is deleted on a clean `destroy`; that
  is hygiene, and the revalidation is the control.
- **the egress grant.** `loopbackEgressPolicy` refuses any host but `127.0.0.1`
  (`ADAPTER_EGRESS_HOST_NOT_ALLOWED`) and any port that is not an integer in
  `1..65535` (`ADAPTER_EGRESS_PORT_NOT_ALLOWED`), independently of the reader. Note
  which of the two is doing the work in a record like `example.com:80`: it is the
  **host**. `80` is a valid port and is accepted on `127.0.0.1`.

### The substrate's host exposure

The rendered configuration — `docker compose config` after the overlay merge, not
the overlay's source text — publishes exactly one host port:

| Service | Container port | Host publication |
| --- | --- | --- |
| `quote` | `8090/tcp` | one ephemeral host port, bound to `127.0.0.1` |
| `otel-collector` | `4317/tcp`, `4318/tcp` | none; Compose network only |

Upstream publishes all three with no `host_ip`, which is `0.0.0.0`. The overlay
replaces those entries — `!override` for `quote`, `!reset` for the collector —
rather than adding to them, because Compose merges `ports` across files and an
added entry leaves upstream's publication standing. `quote`'s host port stays
ephemeral so two concurrent runs cannot collide.

### Verifying the retained qualification

```bash
node scripts/qualify-otel-demo.mjs --verify
```

`--verify` writes nothing under version control: it requires the archive to be
present rather than fetching it, unpacks its comparison material into a temporary
directory it removes, and generates no SBOM. It checks the lock's own core hash and
signature classification, the archive digest and source commit, the exact image
matrix, the exact five-file configuration hash set, the SBOM index's content and
hash, the complete two-services × two-platforms document matrix, every referenced
SPDX document's hash *and* its own package count, and the provenance record's
binding to the same archive, commit and images. A successful run leaves the tree
byte-identical.

Regenerating the qualification is the other mode, and it does rewrite tracked
files — including the signed lock. It also refuses a partial SBOM matrix: four
documents or none.

Between the two there is a third mode, for the case where a repository-owned
configuration file changed and nothing else did:

```bash
node scripts/qualify-otel-demo.mjs --relock-config
```

`--relock-config` re-signs the lock for a new configuration hash set and writes
**only** the lock. It re-observes the archive, the source commit and both platforms'
image digests exactly as `--verify` does; it reuses the retained SBOM index, the
four SPDX documents and the provenance record byte for byte; and it seals a
candidate lock and then puts that candidate through the *complete* verifier over
the whole retained set, writing only if that reports nothing. So it cannot assert a
qualification — it can only record one the verifier already agrees with — and a
drift in anything but the configuration hashes is a refusal. Use it instead of a
full regeneration so a port-binding change does not produce four rewritten SPDX
documents whose only difference is a fresh timestamp.
