# OpenTelemetry Demo substrate — QUALIFIED (development-signed)

`substrate-lock.json` is a qualified lock. `assertSubstrateQualified` accepts it
and `composeDriverManifestBody` emits a Compose manifest with `enabled: true`, so
`erl2 provision --environment-driver compose` can reach a real substrate.

**Read the limitations section before citing this anywhere.** The lock is signed
by the repository's own development environment-governor key. That is a real
Ed25519 signature over the lock's own core hash — a tampered lock is refused —
but the key is repo-derivable, so this is a **self-qualification**, not an
independent one.

## What is pinned

| Coordinate | Value |
| --- | --- |
| Release tag | `3.0.0` (immutable; never `main`, never a floating tag) |
| Source commit | `1755859a9de82c2e5e225be68abc401a5ebf2b4f` |
| Archive | `https://codeload.github.com/open-telemetry/opentelemetry-demo/tar.gz/refs/tags/3.0.0` |
| Archive SHA-256 | `sha256:1bf3ef8f…c86c051c` |

### The qualified subset

Two services out of the upstream demo's twenty-two, selected from the official
modular `compose.yaml` (upstream's own "core/minimal" file) by naming the
endpoint service — Compose pulls in its single declared dependency and nothing
else:

| Service | Why it is in the subset |
| --- | --- |
| `quote` | A real application with a reachable HTTP endpoint (`POST /getquote`) and real OpenTelemetry auto-instrumentation. Depends on `otel-collector` and nothing else. |
| `otel-collector` | Receives that telemetry over OTLP and exports it through the base configuration's `debug` exporter, which makes the collector path observable from its own stdout rather than inferred from a backend. |

No other upstream service runs. There is no Jaeger, no Prometheus, no OpenSearch,
no Grafana, no Kafka, no load generator and no frontend. **The full OTel Demo is
not deployed.**

### Digest-pinned platforms

Both required image-manifest platforms are pinned, for both services:

| Service | `linux/amd64` | `linux/arm64` |
| --- | --- | --- |
| `otel-collector` | `sha256:4eb84209…dfc17f48` | `sha256:1fef9f07…df798ea6` |
| `quote` | `sha256:87201885…461fd153` | `sha256:370d920d…402d2438` |

`darwin/arm64` is **not** required and is not pinned. Docker Desktop on an arm64
Mac runs Linux containers in a Linux VM, so the images a macOS developer executes
are `linux/arm64`; no registry publishes a `darwin/arm64` manifest for either
repository. `REQUIRED_PLATFORMS` was corrected accordingly (`linux/amd64` +
`linux/arm64`). The value stays in the `SubstrateLockV1` platform enum because
narrowing a shared contract's enum would break artifacts already written.

At runtime the driver pins the digest for the platform the *daemon* reports, so a
tag is never resolved during an attesting run.

### Applied configuration

Five files, each hashed into `config_hashes`:

| File | Owner |
| --- | --- |
| `compose.yaml` | upstream, unmodified |
| `.env` | upstream, unmodified |
| `src/otel-collector/otelcol-config.yml` | upstream, unmodified |
| `compose/erl2-overlay.yaml` | this repository |
| `compose/erl2-otelcol-extras.yaml` | this repository |

The overlay run-scopes the network and both container names, pins both images by
digest, adds the run's labels, and reduces the host exposure to one loopback port
(below). The collector extras file uses upstream's own documented extras seam to
reduce the pipelines to the OTLP receivers and the `debug` exporter — which is what
stops the `docker_stats`, `host_metrics`, `postgresql`, `redis`, `nginx` and
`prometheus/ad` receivers from being instantiated at all. The Docker socket and
host filesystem mounts upstream declares are additionally bound to `/dev/null`, so
the collector reaches neither. No container in the subset is privileged and none is
granted a capability; the collector runs as `user: 0:0` inside its own container,
which is upstream's configuration and is recorded here rather than glossed.

### Host exposure

This is the *rendered* topology — what `docker compose config` produces after the
overlay is merged, which is the only thing that describes the substrate's actual
exposure:

| Service | Container port | Host publication |
| --- | --- | --- |
| `quote` | `8090/tcp` | one **ephemeral** host port, bound to **`127.0.0.1`** |
| `otel-collector` | `4317/tcp`, `4318/tcp` | **none** — Compose network only |

Neither of those is upstream's default. Upstream publishes `quote` `8090` and the
collector's `4317`/`4318` with no `host_ip`, which means `0.0.0.0`: reachable from
the local network. The overlay therefore *replaces* those port entries rather than
adding to them — `!override` for `quote`, `!reset` for the collector — because
Compose merges `ports` across files, so an added entry would have left upstream's
publication in place alongside the narrowed one.

`quote` keeps an ephemeral host port on purpose: `host_ip` is pinned and
`published` is omitted, so two concurrent runs cannot collide on a fixed port. The
collector needs no publication at all — `quote` reaches it over the Compose network
by container name, and the Lab reads what arrived from the collector's own stdout
with `docker logs`. A published OTLP receiver would be an ingestion point for
anything on the host, accepting spans a run would then attribute to itself.

Both facts are asserted against the rendered configuration by
`tests/adversarial/composeSubstrate.test.ts`, and the live binding
(`8090/tcp` → `127.0.0.1:<ephemeral>`) is re-observed before the subject is granted
any mount or egress allowlist.

### SBOM and provenance

`qualification/sbom.json` indexes four SPDX 2.3 documents (one per service per
platform) generated with `docker scout sbom`. `qualification/provenance.json`
records the archive URL and digest, the qualifying platform, the tooling used and
what was *not* checked.

## Re-qualifying

```bash
node scripts/qualify-otel-demo.mjs           # fetch, resolve, hash, sign
node scripts/qualify-otel-demo.mjs --verify  # re-observe; refuse on drift
node scripts/qualify-otel-demo.mjs --fetch-only
```

The archive lives in `upstream/` and is git-ignored: it is an input the lock
re-verifies, not a document. Fetch it before any Compose run.

## Runtime admission

`provision` re-observes before it creates anything:

1. the archive on disk is hashed and compared to the lock;
2. all five applied configuration files are hashed and compared as an exact set;
3. images are pulled **by digest**, and the digests are read back — from the
   local image store for the executing platform, and from the registry by digest
   for the other required platform, so a lock whose `linux/amd64` slot holds an
   arm64 manifest is observed as arm64 and refused.

`assertObservedMatchesLock` compares images bijectively and configuration by
exact set equality, so a moved tag, a re-pushed image, a changed config, an extra
image or a missing locked config invalidates the run *before* provisioning.

## Limitations — read before citing

- **Not independently qualified.** The lock is signed by
  `erl2-dev-challenge-governor-ed25519-1`, a repo-derivable development key.
  `verifySubstrateLockSignature` classifies it `signerIsDevelopmentKey: true` and
  `signerIsPinnedAuthority: false`. No third party attested any of this.
- **Not independently authenticated.** The archive was fetched over TLS and
  hashed. No detached signature, no cosign attestation and no transparency-log
  inclusion proof was verified; `syft` and `cosign` are not installed on the
  qualifying host, and `provenance.json` records
  `independently_authenticated: false`.
- **The archive digest is a GitHub-generated tarball's digest.** It is stable in
  practice and is re-verified at admission, but it is not a signed release asset;
  the source commit read from the archive's own pax header is the stronger pin.
- **One host, one platform executed.** Qualification resolved digests for both
  required platforms; the live acceptance run executed `linux/arm64` only.
- **`provenance.json` is bound by content, not by hash.** `SubstrateLockV1` has no
  field for a hash of the provenance file — the lock carries its own inline
  provenance record instead — so `--verify` binds the two on the fields they share
  (substrate, release, source commit, archive URL and digest, the image matrix, and
  `independently_authenticated: false`) rather than cryptographically. That is the
  strongest available check, and it is weaker than the SBOM index's, which *is*
  hash-bound by the lock.
- **Telemetry is observed live and is not retained.** The live acceptance test
  reads the collector's own output and asserts that spans arrived carrying the
  run's marker. No run artifact retains that observation: the archetype's
  `service-metric` source is `complete` because the collector reported its OTLP
  pipelines started, and every source snapshot in this archetype freezes
  `records: 0`. Pipeline readiness is reachability of the metric path, not the
  receipt of a service metric. Do not cite an offline bundle as attesting received
  telemetry; retention and gating are the first Qualiber integration package's
  obligation (ERL2-OQ-005).
- **ERL2-OQ-008 remains open.** The subject that exercises this environment is a
  trusted, repository-owned reference adapter running under the `local-process`
  sandbox profile. Nothing here is evidence about an opaque, private or
  third-party subject.
- **No T2 or T3.** A real substrate raises the *environment-realism* claim
  component, and the overall ceiling is the weakest applicable component: the run
  is still `development` tier with non-blind selection (ERL2-OQ-007), so the
  attestation is T1.
