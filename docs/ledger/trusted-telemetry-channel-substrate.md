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

Discovery **169 → 184**. Fifteen added, none removed, renamed or reordered.

Eleven against the lifecycle and the grammar: `trusted-channel-` ·
`stale-volume-refused` · `mount-ownership-verified` · `volume-run-scoped` ·
`single-file-enforced` · `artifact-stability-required` ·
`settle-requires-attribution` · `oversize-refused` · `encoding-verified` ·
`cleanup-scoped-to-created` · `cleanup-failure-reported`, plus
`trusted-telemetry-event-attributes-refused`.

Four against the **applied collector configuration**, which nothing mutated
before: `trusted-channel-` · `minimization-configured` ·
`event-attributes-stripped` · `debug-off-the-trusted-pipeline` ·
`logs-excluded-from-trusted-export`. The parser stays the authoritative
enforcement point, but "the parser refuses an unminimized record" and "the
pipeline still minimizes" are different claims and only the first had a control.

One existing control needed its anchor widened rather than its meaning changed:
`trusted-telemetry-field-bound-enforced` matched a single line that Package 2's
second `fieldOverBound` return — for a span event's name, at a deeper
indentation — contains as a substring. The harness reported
`ambiguous_patch_target` instead of patching whichever it found first, which is
the behaviour to want.

Two of the eleven exist because a live run found the defect first —
`settle-requires-attribution` and `event-attributes-refused`. Neither was
predicted by reading.

### Affected-control execution

Selector derived mechanically from the changed paths on both axes:
mutation-target **30**, designated-suite **20**, **union 31**.

```
negative controls: 31 of 184
31 discovered = 31 agreed + 0 disagreed + 0 unmeasured + 0 harness error(s)
the working tree is byte-identical to how the campaign started
```

Every one killed on a named case. No wording-only kill, no unexpected skip, no
harness error, byte-identical restoration. The two skips that appear in three
rows are the declared `RENDERED_TOPOLOGY_SKIP` pair. The full 184-control
campaign was **not** run.

### Broad suite

Run once at the final candidate, `TMPDIR=/tmp`, no retries:
**1 328 tests · 1 328 passed · 0 failed · 0 cancelled · 0 skipped · 917 880 ms**,
log terminating on `duration_ms`, exit 0.

Zero skips is a property of *this checkout*, not of the commit: the canonical
tree carries the git-ignored, network-fetched pinned archive under
`environments/otel-demo/upstream/` that the fixture-dependent tests gate on. A
fresh clone would skip them and say so. This is the same condition the
independent Package 1 review recorded as P3-16, restated rather than rediscovered.

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

---

## 9. Remediation — the four defects an independent review found (2026-08-14)

The independent Package 2 substrate and security review
(`reality-lab-package2-substrate-and-security-review.md`,
`sha256:5cea081d…c85028`) returned **CHANGES REQUIRED**. It approved the
architecture in substance — physical separation, volume isolation, exact-byte
hashing, the failure matrix and the lock — and found four implementation
defects. This section records their closure. It **appends**; nothing above is
rewritten, and no historical evidence changed.

### P0-1 — minimization was not recursive

The review ran one hostile OTLP payload through the pinned collector with this
package's own trusted pipeline. It correctly removed `host.name`, both
`session.token` attributes and the exception stack trace. It **retained**, whole
and unbounded, in an artifact the parser then **accepted**:

| surface | what it carried |
|---|---|
| `scope.attributes` | a `session.token`, 1 200 chars |
| `span.status.message` | `/Users/…/quote.php:42` + 1 200 chars |
| `span.name` | a URL with a token |
| `span.traceState` | subject-settable via the inbound `tracestate` header |
| `resourceSpans[].schemaUrl` | 1 200 chars |
| `scopeSpans[].schemaUrl` | 1 200 chars |

The subject is the OTLP producer, so every one is subject-controlled. Same class
as the span-event leak §2 records — a second attribute map, or a plain string,
that the allowlist did not name.

**The allowlist is now the whole record.** `transform/trusted` gained the
`scope` context and statements removing the span name, status message, trace
state, event name and both schema URLs. Removal rather than bounding, wherever
no ERL2-C-171 count reads the field: a bound keeps a privacy-bearing field for a
reader that does not exist.

`error_mode` is now **`propagate`**. `ignore` is precisely how
`set(span.events, [])` became a silent no-op, and every statement here is
load-bearing for a privacy bound, so one that cannot be applied must stop the
batch rather than quietly export more.

Measured against the pinned image, before → after on the same hostile payload:

```
8 118 B  →  695 B      13/13 sentinels removed
spans 1 → 1            run attribution 1/1 preserved
```

The retained record is now `service.name`, `url.full`, and structure.

### The recursive allowlist, stated exactly

| level | retained | removed | unknown key |
|---|---|---|---|
| document | `resourceSpans` only | — | refused (`malformed`) |
| resourceSpan | `resource`, `scopeSpans` | `schemaUrl` | refused |
| resource | `attributes` (`service.name`, ≤512), `droppedAttributesCount` | — | refused |
| scopeSpan | `scope`, `spans` | `schemaUrl` | refused |
| scope | `droppedAttributesCount` | `name`, `version`, `attributes` | refused |
| span | ids, `flags`, `kind`, timestamps, `attributes` (`url.full`, ≤512), dropped counts, `events`, `links`, `status` | `name`, `traceState` | refused |
| status | `code` | `message` | refused |
| event | `timeUnixNano`, `droppedAttributesCount` | `name`, `attributes` | refused |
| link | `traceId`, `spanId`, `flags`, `droppedAttributesCount` | `attributes`, `traceState` | refused |
| attribute | `key`, `value` | — | refused |

Forward compatibility is **fail-closed and versioned**, not implicit key
tolerance: a collector that starts emitting a new field changes the retained
bytes, and the privacy bound is a claim about exactly those bytes. The refusal
is the signal to review the field, not something to route around.

`url.full` remains the disclosed bounded MVP limit, unchanged and still the one
place a subject-derived value may appear.

### P1-1 — a settle timeout could become an authoritative zero

`close` ended its budget by finalizing whatever was stable, and the producer read
that as an observation. The review reproduced the consequence: telemetry arriving
after roughly twenty-two seconds was sealed as `evidence: observed, spans: 0` —
byte-identical to a genuine zero and indistinguishable from it by any reader. The
comment beside that line said asserting "the collector received nothing" when it
did is intolerable, and the next line did it.

**The distinction is in the type now.** A freeze carries `settledBy:
"attribution" | "budget"`, and exactly two things reach the `observed`
constructor:

| condition | result |
|---|---|
| this run's telemetry demonstrably arrived | `observed`, positive |
| run declared `zero-eligible` before observation, artifact empty | `observed` zero |
| budget expired, artifact empty, telemetry expected | `absent` · `telemetry_channel_expected_telemetry_missing` |
| budget expired, artifact non-empty, never attributed | `absent` · `telemetry_channel_settle_timeout` |
| foreign run's telemetry present | `absent` · `telemetry_foreign_run_record_present` |
| no trusted file / crash / copy failure | `absent`, as before |

Elapsed time, byte stability and an absence of spans justify nothing on their
own. `EXPECTS_TELEMETRY` is the default, so a caller that says nothing gets the
fail-closed answer.

**Two stable reads were never quiescence, and §4 should not have implied
otherwise.** They establish that the bytes stopped moving and nothing more. What
ends the wait positively is attribution; what ends it otherwise is a budget, and
a budget now yields an absence with a cause.

**Zero-eligibility is a typed input, and the one seam package 3 must supply.**
`TrustedChannelZeroEligibility` is bound *before* observation, by the caller that
knows the scenario's contract. Package 2 defines it and never wires it —
`environmentRun` is untouched.

**Residual, stated rather than hidden.** A run *declared* zero-eligible whose
telemetry arrives late still freezes a zero. That is inside its declared
contract, and no adversary can use it to bypass a positive telemetry requirement
because such a run is `expects-telemetry` and gets an absence. A stronger proof —
a quiesced source lifecycle plus a collector-derived completion signal — needs
lifecycle information Package 2 does not have. Deferred to Package 3 explicitly
rather than synthesized here.

### P2-1 — the copy path followed a symlink

The review planted a `traces.jsonl` symlink to `/etc/passwd`. `docker cp`
preserved it, `readdirSync` reported one entry with the expected name, and
`readFileSync` **followed it** — 9 350 bytes of the host's password file arrived
where the artifact should have been. Every check ran on the host, after the bytes
were materialised, against a name that told the truth.

`docker cp <container>:<path> -` answers with a **tar stream**, and a tar header
carries the entry type as a field. The channel now reads that archive and
classifies the entry from its own header, before anything is opened — and because
the payload rides in the same archive, the entry that is type-checked is the
entry the bytes come from. There is no window between the two, because there is
no second lookup.

Nothing is extracted. No name the collector chose ever becomes a path on this
host. Measured live against the exact reproduction:

| source entry | result |
|---|---|
| regular file | frozen, bytes are the entry's |
| symlink → `/etc/passwd` | `telemetry_channel_source_entry_not_regular` |
| relative symlink, dangling symlink | same |
| directory, FIFO, char/block device, undefined ustar type | same |
| two entries | `telemetry_channel_unexpected_file` |
| unexpected filename, empty directory | `telemetry_channel_artifact_missing` |

Absolute names and `..` traversal are refused, though with no extraction they had
nowhere to go. A hard link is refused when tar marks it type `1`; when its target
is outside the archive tar emits an ordinary regular file, and because a hard link
cannot cross devices it can only ever reference bytes already inside the trusted
tmpfs — measured, and not an escape.

The Docker-daemon administrator remains outside the threat boundary. What changes
is that a collector compromise, a configuration defect or a future topology change
can no longer turn a name into a host file read.

### P2-2 — span links: **partially closed, and the residue is stated**

The parser forbade link attributes the collector never stripped, so legitimately
linked instrumentation refused an otherwise valid artifact.

Measured against the pinned image, `otelcol-contrib` v0.157.0 **cannot** reach a
span link:

- `spanlink`, `link`, `links`, `span_link` are all `unknown context`, in the
  explicit `context:` form and the inferred flat form;
- `set(span.links, [])` parses and fails at runtime —
  `expects ptrace.SpanLinkSlice but got []interface {}` — the same silent-no-op
  class as `set(span.events, [])`, now loud under `propagate`;
- `keep_keys(span.links[0].attributes, [])` is refused: links do not support
  indexing;
- the `redaction` processor reaches scope and span-event attributes but does not
  traverse links.

Moving the collector pin is out of scope for this remediation.

So: **privacy is closed, availability is not.** The parser refuses link
attributes and link trace state with their own code
(`telemetry_trusted_record_link_not_minimized`), and accepts the minimized link
shape — identifiers, flags, dropped counts — with span count and run attribution
unmoved. No unbounded subject value survives. A span carrying link attributes
still refuses the artifact, and closing that needs a collector version with a
span-link context, which is an image-pin move and its own design review.

### Controls

Discovery **184 → 192**. Eight added, none removed, renamed or reordered.

| control | boundary |
|---|---|
| `trusted-telemetry-unknown-key-refused` | parser: unknown key at any depth |
| `trusted-telemetry-unminimized-field-refused` | parser: a stripped field arriving with content |
| `trusted-channel-settle-timeout-is-not-a-zero` | budget exhaustion cannot reach the observed constructor |
| `trusted-channel-zero-requires-declared-eligibility` | a zero needs a declaration bound before observation |
| `trusted-channel-source-entry-must-be-regular` | archive classification of a symlink |
| `trusted-channel-scope-minimized` | collector: scope statements |
| `trusted-channel-span-fields-minimized` | collector: span name / status message / trace state |
| `trusted-channel-minimization-fails-closed` | collector: `error_mode: propagate` |

`trusted-telemetry-event-attributes-refused` kept its meaning and moved its
anchor and named case: the event name is removed now rather than bounded.

One control had to be re-anchored after it **survived its own mutation**.
`trusted-channel-source-entry-must-be-regular` first targeted the channel's
`entry.type !== "regular-file"` guard, which is redundant — the archive reader
attaches no payload to a non-regular entry, so the guard refuses twice and
removing half of it changes no outcome. The redundancy is worth keeping; pointing
a control at the redundant half is not. It is anchored on the reader's typeflag
table, where the classification actually happens. Recorded because a control that
measures nothing is worse than one that does not exist.

### Configuration and lock

| file | before | after |
|---|---|---|
| `erl2-otelcol-extras.yaml` | `sha256:c206e406…5018595f` | `sha256:0468ab32…7a50f8c2` |
| lock `core_hash` | `sha256:be7ff2fc…6307efe4` | `sha256:a815e35f…c7152ea2` |

`erl2-overlay.yaml` is unchanged. Re-locked through `--relock-config`. **No image
pin moved, no archive, SBOM, SPDX or provenance record changed**, and the
collector digest is still `sha256:1fef9f07…98ea6`. Signer unchanged and still not
an independent authority. `recorded_at` moved, as a re-lock requires.

### Two pre-existing Package 2 defects the broad suite surfaced

Neither is among the four findings; both were found by running the broad suite at
the remediated candidate, and both reproduce at `8485b8a`.

**The `environmentRun` e2e inventory was stale.** `157cf04` admitted the trusted
volume into the live driver-contract test and did not reach
`tests/e2e/composeEnvironmentRun.test.ts`, which still expected five resources
against the six the driver has inventoried since this package added the volume.
Reproduced at `8485b8a`: the same `6 !== 5`. **Package 2's recorded broad run of
1 328 tests passed / 0 failed is therefore not reproducible**, and the
independent review that accepted that figure did not rerun the suite. Corrected
here.

**The trusted volume survives teardown, on every run — open.** With the count
corrected the run reaches `destroy` and fails
`TEARDOWN_FAILED: teardown left 2 resource(s)`. `TrustedTelemetryChannel#created`
is in-memory, and the CLI runs each lifecycle step in its own process, so the
`destroy` process builds a fresh channel with `created === false`, `cleanup()`
returns `{attempted: false, removed: false}`, and the memory-backed volume is
never removed. Measured: one `erl2-trusted-<uuid>` volume left behind per run.

This is left open deliberately. The fix is either persisting volume ownership in
`ComposeRunStore`, or letting cleanup remove a volume on name-ownership alone —
and the second weakens the property that a channel whose `provision` *refused* a
pre-existing name removes nothing, which §4 records as deliberate. That is a
design decision rather than a remediation one, and it is outside the four
findings this package was scoped to close. It means **cleanup cannot currently be
proven for a real environment run**, and it should be closed before Package 3
connects the lifecycle.

### Status after remediation

- P0-1 **closed** — recursive allowlist, both enforcement points, measured live
- P1-1 **closed** — a timeout is an absence with a cause; a zero needs a
  declaration; residual zero-eligible case stated and deferred
- P2-1 **closed** — classification before dereference, nothing extracted
- P2-2 **partially closed** — privacy closed, availability blocked on the pinned
  collector version
- `environmentRun` **untouched**; C-160 still authoritative there; Package 3
  unchanged in scope
- the full campaign, the clean gate and `evidence:update` remain **not run**
- Package 3 remains **blocked** pending focused re-review
