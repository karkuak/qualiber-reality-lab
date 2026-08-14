# Trusted telemetry channel — collector, storage and lifecycle (Package 2)

The substrate half of ADR-ERL2-038. Package 1 defined ERL2-C-171 and who may
authorize a claim from one, and deliberately produced no artifact. This package
makes bytes of that shape exist, for the first time, from the pinned collector.

**It is not connected to `environmentRun`.** That composition still reads
retained observations as ERL2-C-160 and would throw on a v2 record; correcting
it is Package 3. Every environment run still fails its
`attributable-telemetry-retained` gate exactly as it did at Package 1. What
changed is that there is now something for Package 3 to connect.

---

## 1. The three properties, and where each is established

| property | established by | not by |
|---|---|---|
| subject-controlled bytes cannot create a physical record | the `file` exporter's JSON escaping; the count is the length of a structure | any parsing rule |
| trusted output is physically separate from debug output | two pipelines, two exporters, two byte streams | a promise that debug is "not a source of truth" |
| only the collector writes the trusted file | a named volume mounted into `otel-collector` and no other service | a filesystem permission alone |

---

## 2. Collector configuration — `erl2-otelcol-extras.yaml`

A second traces pipeline, alongside the existing one rather than replacing it:

```
traces:          otlp -> memory_limiter -> debug            (stdout, diagnostic)
traces/trusted:  otlp -> memory_limiter -> transform/trusted -> file/trusted
```

`debug` stays exactly where it was. R3 is satisfied by the topology, not by a
rule: the forgery the independent review demonstrated — a subject **log body**
producing a complete trusted record reading `spans: 9999` — requires the two to
share a byte stream, and they no longer can. Logs and metrics never enter the
trusted pipeline, because nothing ERL2-C-171 derives comes from either.

### The allowlist, stated exactly

| scope | keys kept | bound |
|---|---|---|
| resource attributes | `service.name` | 512 characters |
| span attributes | `url.full` | 512 characters |
| span **event** attributes | *none* | — |
| span **link** attributes | *none* | — |
| event name | (structure, kept) | 512 characters, enforced by the parser |

`url.full` is the marker-bearing field and is the one place a subject-derived
value may still appear — JSON-escaped and length-bounded. This does not claim
subject bytes are absent from the artifact. Saying where they may remain is the
honest bound.

### Measured, against `otelcol-contrib` v0.157.0 at the pinned digest

| input | unminimized | minimized | ratio |
|---|---:|---:|---:|
| one span, one 1 MB attribute | **1 000 590 B** | **430 B** | ~2 327× |
| 40 spans, 22 attributes each, realistic shape | **914 346 B** | **30 079 B** | ~30× |

In the 40-span case the structural span count stayed 40, marker attribution
stayed **40/40**, every retained value measured exactly ≤ 512 characters, and a
`session.token` attribute and `host.name` were both absent from the output.
The unminimized figure is 3.5× ERL2-C-171's 262 144-byte ceiling, which is why
R2 is a precondition for the channel working at all rather than a refinement.

### The hole a live run found

`keep_keys(span.attributes, …)` does **not** reach a span's events. The first
live artifact this package produced was 14 795 bytes and contained an
`exception` event carrying `exception.message` and a full
`exception.stacktrace` with host file paths — unbounded, unallowlisted,
subject-influenced bytes inside an artifact whose privacy bound never accounted
for them. Adding `keep_keys(spanevent.attributes, [])` took the same run to
**3 848 bytes** with the counts unchanged.

`set(span.events, [])` was tried first. Under `error_mode: ignore` it is
silently a no-op, so the statement that looks like it removes the most removes
nothing. Measured, not assumed.

The parser refuses event and link attributes independently, so a future
configuration regression is caught rather than trusted — the same discipline
the span allowlist already followed.

### One correction to the parser, in the other direction

`keep_keys` removing *every* resource attribute makes the marshaller emit
`"resource":{}` with no `attributes` key. Package 1's parser required the key
and refused a record the channel legitimately produces. A false refusal is its
own defect, not a safer version of a true one; absent is now empty, exactly as
it already was for span attributes.

---

## 3. Storage — the tmpfs-backed named volume

Created by the driver, never by Compose:

```
docker volume create --driver local \
  --opt type=tmpfs --opt device=tmpfs \
  --opt o=uid=10001,gid=10001,mode=0700,size=64m \
  --label com.erl2.run_id=<run> --label com.erl2.driver_id=compose-driver \
  --label com.docker.compose.project=<project> \
  erl2-trusted-<run-uuid>
```

| property | how |
|---|---|
| no helper image (R1) | ownership is a volume option; the collector starts writing with no preparation step |
| fails closed without it | a volume without those options: `open /trusted/traces.jsonl: permission denied`, exit 1 — reproduced |
| run-scoped, unguessable | the name carries the run's UUID, so `assertOwnedByRun` proves ownership from the name |
| never adopted | the overlay declares it `external`, so Compose creates nothing; the driver refuses a name already taken |
| collector-only | one mount in the rendered merge; `quote` renders no volumes at all |
| no host exposure | memory-backed inside the VM; the trusted bytes never touch the host filesystem |
| bounded | `size=64m`; exhaustion produces a torn final write, which the parser refuses as `telemetry_trusted_record_incomplete` — measured on a deliberately tiny volume |
| in the inventory | it is an owned `volume` resource, so it joins the resource inventory and the residue observation |

The assertion is made against `docker compose config` rather than the overlay's
source text, because `volumes` merges across files exactly as `ports` does — an
entry that reads as collector-only in one file can render onto a second service.

### The measurement that changed the finalization order

ADR-ERL2-038 R5 describes finalization as flush, close, then read. A literal
reading destroys the evidence here. The volume is tmpfs-backed, so the kernel
unmounts it when the collector stops, and `docker cp` from the stopped
container answers:

```
Error response from daemon: Could not find the file /trusted/traces.jsonl in
container <name>
```

The bytes are **gone, not stale**. The copy is therefore taken from the running
collector after the observation cutoff, and the container is stopped afterwards.
Two consecutive live reads of the same running container were byte-identical.

**This is a stated deviation from R5's ordering, not an oversight.** What R5
requires — that nothing is authoritative until the artifact is complete and
frozen — is preserved. What changes is how "the collector is no longer writing"
is established.

---

## 4. Lifecycle

| phase | what it establishes | refusal |
|---|---|---|
| provision | volume created with the expected options, read back from the daemon | `telemetry_channel_volume_stale`, `…_unprovisioned`, `…_mount_options_unexpected` |
| start | Compose refuses to come up without the external volume, so a channel that failed to provision fails the run rather than producing a collector with nowhere to write | `ENV_PROVISION_FAILED` |
| observe | the subject emits; nothing is authoritative while the collector writes | — |
| quiesce | the caller stops the run's telemetry — the observation cutoff | — |
| flush | one exporter `flush_interval` plus a margin | — |
| close | two consecutive copies byte-identical **and** this run's telemetry present | `telemetry_channel_not_finalized` |
| freeze | the whole directory enumerated, exactly one file, UTF-8 round trip, length, digest | `…_unexpected_file`, `…_artifact_missing`, `…_copy_failed`, `…_encoding_invalid`, `telemetry_trusted_artifact_exceeds_size_bound` |
| validate | parsed by Package 1's parser; counts recomputed; ERL2-C-171 sealed and `assertContract`ed | every `telemetry_trusted_*` code |
| retain | the exact bytes ride inside the record | — |
| cleanup | the volume this channel created is removed; outcome reported | reported, never thrown |

### Why `close` waits for attribution and not merely for stability

An empty file is stable the instant it is created. Reading two seconds after
the last request found exactly that, and freezing there produced an **authentic
observed zero for a run that had emitted spans** — a positive claim, and false.
The wait now ends on this run's telemetry having reached the file, or on a
bounded budget expiring.

The residual error is an *undercount*: a record arriving after the cutoff is
absent from the bytes rather than half-present in them. Completeness is
established structurally from the bytes — every physical line parses and the
sequence ends on a record boundary — never from a belief about what the
collector was doing.

### Invariants

- no authoritative artifact before a successful freeze;
- no copy while two reads still disagree;
- the exact frozen bytes are the bytes hashed, retained and verified;
- post-copy mutation of the source cannot reach the record, which carries bytes
  rather than a path;
- **cleanup success is not evidence validity and evidence validity is not
  cleanup success** — both are reported, neither is inferred;
- a collector crash cannot produce a finalized artifact;
- failure to copy, read, parse, hash or verify fails closed.

---

## 5. Configuration and substrate lock

Two of the five `config_hashes` moved. Nothing else in the lock did.

| file | before | after |
|---|---|---|
| `erl2-overlay.yaml` | `sha256:258dde9d…dc58035f` | `sha256:5bf984b2…13da273c` |
| `erl2-otelcol-extras.yaml` | `sha256:230f0829…cc38326d` | `sha256:c206e406…5018595f` |

| | before | after |
|---|---|---|
| lock `core_hash` | `sha256:a124cd47…4a967ec2` | `sha256:be7ff2fc…6307efe4` |

Re-locked through the repository's own `--relock-config` path, which carries the
images, the archive, the SBOM index, its four SPDX documents and the provenance
record across verbatim, and gates the candidate on the complete qualification
verifier before writing. **No image was added, no pin moved, no archive
changed**, and the collector digest is the same
`sha256:1fef9f07…98ea6` it has always been — the exporter and the transform are
components of that already-pinned image.

The signer is `erl2-dev-challenge-governor-ed25519-1`, which the lock's own
provenance block discloses is **not an independent authority**. Carried forward
unchanged.

`linux/amd64` remains **unqualified for the volume option**. Every measurement
here is `linux/arm64` on Docker Desktop 29.5.3. This is a follow-up gate, not a
claim.

---

## 6. Live results (pinned collector, real Compose subset)

| case | result |
|---|---|
| normal positive run | `observed`, 9 spans, 3 run-attributed, 1 record, 3 848 B, terminated, authority ✅, gate **true** |
| authentic zero (no traffic) | `observed`, 0 spans, 0 records, `final_record_terminated: false`, no reason code, authority ✅, gate **false** |
| hostile multiline attribute | 1 physical record, **0 raw TAB bytes**, structural span count 9 (not 9999, not 50), `url.full` exactly 512 chars, `host.name` absent |
| another-run substitution | gate **false** under the other run |
| stale/pre-existing volume | `ENV_PROVISION_FAILED` — `telemetry_channel_volume_stale`, never adopted |
| extra file planted in `/trusted` | `absent`, `telemetry_channel_unexpected_file`, gate **false** |
| collector SIGKILL before freeze | `absent`, `telemetry_channel_artifact_missing`, gate **false** |
| cleanup with the volume in use | `removed: false`, `surviving: [<volume>]`, the daemon's own reason retained |
| teardown | receipt `succeeded`, residue **0**, volume removed |

The forged `spans: 9999` and the copied OTLP-JSON document are present in the
retained bytes **as data inside `url.full`**, which is exactly what the contract
says may happen and exactly what makes the result meaningful: the numeral is
there and no reader believes it, because the count is the length of a structure.

A `session.token` supplied as a span **attribute** is removed by minimization
(measured). A token a subject puts in the request **URL** survives inside the
bounded `url.full`, because that field is retained for attribution. That is the
allowlist working as specified, and it is a limit worth stating rather than a
leak worth hiding.

---

## 7. Controls

Discovery **169 → 180**. Eleven added, none removed, renamed or reordered.

`trusted-channel-` · `stale-volume-refused` · `mount-ownership-verified` ·
`volume-run-scoped` · `single-file-enforced` · `artifact-stability-required` ·
`settle-requires-attribution` · `oversize-refused` · `encoding-verified` ·
`cleanup-scoped-to-created` · `cleanup-failure-reported`, plus
`trusted-telemetry-event-attributes-refused`.

Two of the eleven exist because a live run found the defect first —
`settle-requires-attribution` and `event-attributes-refused`. Neither was
predicted by reading.

`RENDERED_TOPOLOGY_SKIP` gained a second declared case: Package 2's
trusted-mount assertion reads the same rendered merge as the loopback one and is
unobservable under the same missing git-ignored fixture, for the same three
controls. Declaring it publishes it rather than excusing it.

---

## 8. Status

- the trusted channel **exists** and produces live ERL2-C-171 artifacts
- `environmentRun` is **untouched** and still asserts ERL2-C-160 — Package 3
- no environment run can reach the channel yet, so **end-to-end runs are still
  not valid**
- `linux/amd64` volume-option qualification is **outstanding**
- the full campaign, the clean gate and `evidence:update` remain **not run**
- exploratory Qualiber testing is **still not authorized** (ADR-ERL2-038 §11)
