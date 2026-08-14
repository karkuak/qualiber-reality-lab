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

---

## 10. Closure — the cross-process teardown defect and the span-link decision (2026-08-14)

§9 closed four review findings and left two facts on the table: the trusted
volume survived every real teardown, and span links were closed for privacy and
open for availability. This section closes both. Nothing here moves the collector
pin, touches `environmentRun`, or begins package 3.

### 10.1 Why the volume survived every run

The proof that a channel had created the volume was a field on the channel
object:

```ts
private created = false;   // set in provision(), read in cleanup()
```

That is a correct proof inside one process and no proof at all across two. The
ERL2 CLI runs each lifecycle step in its own process — `environmentCommands.ts`
says so in as many words, "a run selects its driver once, at `provision`, and
every later process reads it from here" — so the process that runs `destroy`
constructs a fresh `TrustedTelemetryChannel`, reads `created === false`, returns
`{attempted: false, removed: false}` and removes nothing.

Measured on a clean daemon, one surviving object per run:

```
containers: []      networks: []
volumes:    erl2-trusted-01a001f5-48a0-7d19-9c2e-fa3545079b9f
```

and the environment's own teardown then failed on residue it had produced
itself: `TEARDOWN_FAILED: teardown left 2 resource(s)`.

**The fix is not "remove it by name anyway."** A name says what a volume is
called, not who created it. Cleanup that deletes on a name alone deletes the
pre-existing volume this run explicitly *refused* to adopt — which is the
property §4 records as deliberate, and the reason `provision` refuses a taken
name rather than reusing it. What was needed is a proof of ownership that
outlives the process that acquired it and that a different run, a stale record or
a spoofed resource cannot satisfy.

### 10.2 The ownership handle

A durable capability, in `packages/core/src/environment/trustedOwnership.ts`:

| field | why it cannot be re-derived |
|---|---|
| `schema_version` | a handle a later build cannot read is refused, not interpreted |
| `run_id` | binds the claim to one run; another run's handle authorizes nothing |
| `volume_name` | the exact resource. Never a prefix, never a pattern |
| `channel_version` | a build with a different notion of the resource does not inherit the claim |
| `mount_options` | what the daemon must echo back |
| `labels` | every label the resource must carry, exactly |
| `capability` | the raw nonce — retained **here and nowhere else** |
| `capability_digest` | what the Docker label carries |
| `phase` | `pending-create` → `created` → `released` |
| `core_hash` | integrity over all of the above |

There is deliberately **no timestamp**: nothing here is decided by elapsed time,
and a clock in this record would be a new source of nondeterminism for no gain.

**The capability is the proof.** `provision` mints 32 CSPRNG bytes, keeps the raw
value in a mode-0600 file beside the substrate, and publishes only
`hashBytes(capability)` as a Docker label. Removal re-derives the digest from the
retained nonce and must find it on the resource. So a different run holds a
different nonce; a volume spoofed under this run's (already unguessable,
UUID-bearing) name cannot carry the right digest, because the value it hashes
from was never published; and a stale handle whose volume is gone deletes
nothing. The raw value never enters a label, a command line, an environment
variable, the Compose graph, the inventory or any evidence record — the artifact
a run produces must not carry the value that authorizes deleting the resource it
came from.

**Where it lives, and why not in the run record.** `ComposeRunStore` is the
driver's existing durable record and this store is rooted in the same directory,
keyed by the same base64url run id, written by the same atomic temp-then-rename,
and handed to the channel by `ComposeRunStore.trustedOwnership()`. It is a
separate *document* because the intent has to be persisted in the narrow window
before `docker volume create`, and folding it into the receipts blob would make
that window a read-modify-write of every receipt the run has accumulated.

### 10.3 The sequence, and the crash windows

1. refuse if a live claim already exists — a second capability would orphan the
   first and strand the resource;
2. reconcile a pending intent, against the exact recorded resource and nothing
   else;
3. refuse a pre-existing name — never adopt, never remove;
4. **persist the intent**, atomically, *before* the resource exists;
5. create the volume with the labels and the digest;
6. read back name, options and labels; refuse on any mismatch;
7. **only then** mark ownership `created`.

Step 4 before step 5 is the whole crash-safety argument. Dying between them
leaves a handle naming a volume that may not exist — recoverable. The other order
would leave a resource nobody could prove they owned, which is not.

| crash window | what a later process finds | what it does |
|---|---|---|
| before the intent | no handle, no volume | nothing to clean up |
| after intent, before create | `pending-create`, no volume | reconciles to nothing, provisions |
| after create, before confirmation | `pending-create`, exact volume | removes that exact resource, provisions |
| after confirmation | `created`, volume | ordinary teardown |
| during use | `created`, volume | ordinary teardown |
| before destroy | `created`, volume | ordinary teardown |
| during destroy | `created`, volume | retries; capability intact |
| removal succeeded, tombstone lost | `created`, no volume | reports removed, retires the handle |
| tombstone written, process reported failure | `released` | no-op |
| repeated destroy | `released` | no-op |
| stale handle, no volume | `created`, no volume | reports removed, retires the handle |
| stale handle naming a spoofed volume | `created`, mismatched volume | **refuses**, reports it surviving |

Reconciliation is the only place this module removes a resource it did not watch
being created, and it is the narrowest possible act: exact name, exact labels,
exact capability. Anything else refuses with
`telemetry_channel_ownership_reconciliation_refused`.

### 10.4 Two checks, not one

Validation happens immediately before every removal, and it is **two** questions
answered by two statements:

- **is this the right resource?** — the observed label set must equal the
  handle's, by exact key-set equality. A missing label and an extra label both
  refuse; never a substring test, so a run id that merely *contains* the expected
  one does not match.
- **do I hold the capability?** — the ownership label must equal the digest
  re-derived from the handle's raw nonce. Re-derived, not read from the handle's
  own digest field: a record carrying a digest it cannot produce proves nothing.

They were one check to begin with, and the campaign caught it. With the digest
folded into the label comparison, removing *either* guard changed no outcome and
**both controls survived their own mutation** — and the fixtures made it worse by
getting two things wrong at once, so whichever guard survived still caught them.
Each fixture now gets exactly one thing wrong. This is the second redundant guard
in this package mistaken for a measured one; the first was
`trusted-channel-source-entry-must-be-regular` in §9.

New reason codes: `telemetry_channel_volume_labels_unexpected`,
`telemetry_channel_ownership_conflict`,
`telemetry_channel_ownership_reconciliation_refused`.

### 10.5 Cleanup semantics

- a missing or unreadable handle removes **nothing** and says which it was;
- a `released` handle is a no-op, so destroy is idempotent — and because the
  handle names one fixed volume, it can never reach a resource created later
  under the same name;
- a successful removal retires the handle through a single tombstone site, so
  "removed" and "the claim is retired" cannot come apart;
- a **failed** removal keeps the handle in its phase, reports the daemon's own
  words and lists the surviving resource. Tombstoning a failure would strand the
  capability exactly as the in-memory flag did;
- cleanup outcome remains a separate return value that no verdict consults.

The handle is read *before* the freeze root is deleted. The freeze root is
caller-supplied working material and the ownership store is caller-supplied
durable state, and this module cannot prove they are different directories — so
it reads the proof it needs first rather than depending on a separation it cannot
check.

### 10.6 Span links: an unsupported MVP capability

§9 left P2-2 half-closed: link attributes and link trace state refused, an
identifier-only link accepted. **That compromise only works if the collector can
strip the other half, and at this pin it cannot strip any of it.** Re-measured
against `otelcol-contrib` v0.157.0 at the locked arm64 digest: `spanlink`,
`link`, `links` and `span_link` are all unknown OTTL contexts in both forms;
`set(span.links, [])` fails at runtime against `ptrace.SpanLinkSlice`; indexed
link paths are refused; the `redaction` processor does not traverse links.

Accepting an identifier-only link was therefore accepting a *sample* rather than
a capability. Whether one link happens to carry a payload says nothing about the
next, and nothing upstream can make it not carry one.

**Decision: refuse, and do not move the pin.** Any nonempty `links` array refuses
the whole artifact with `telemetry_trusted_record_span_links_unsupported`.

| shape | result |
|---|---|
| `links` key absent | accepted, counts unmoved |
| `"links": []` — the exporter's canonical empty form | accepted, counts unmoved |
| a link reduced to identifiers | **refused** |
| a link carrying attributes or trace state | **refused** |
| some spans linked, others not | **refused whole** |

The code is deliberately none of its neighbours. The record parses, so this is
not malformed data. Nothing escaped, so it is not a privacy incident. It is not
cross-run contamination, not an absence of telemetry, and emphatically not an
authentic zero — the one misreading a reader is entitled to act on. It is a
declared limit of the image the bytes were exported through.

The refusal is checked before attributes, status, events and the marker scan, so
a linked artifact always reports the thing that actually blocks it rather than
sending a reader to fix a payload that was never the problem. It is
whole-artifact and not per-span: dropping the linked span and counting the rest
would make the count a number this grammar chose rather than the length of the
structure the collector wrote, which is the one property ADR-ERL2-038 §4 exists
to hold. Partial credit here is a forged count with an honest face.

There is no caller input that declares links safe. The limitation is a property
of the collector image, not of the run observing it, so no run-level assertion
could be true — and an override would be the one lever a subject could aim at,
since the subject is the OTLP producer and chooses whether to emit links.
`telemetry_trusted_record_link_not_minimized` is retired: it described a
distinction that no longer exists.

**No collector image, digest, SBOM, SPDX, provenance or qualification changed.**
`erl2-otelcol-extras.yaml` and `erl2-overlay.yaml` are byte-identical, the lock's
`core_hash` is still `sha256:a815e35f…c7152ea2`, and the collector digest is
still `sha256:1fef9f07…98ea6`. Moving the pin to a version with a span-link OTTL
context is a separate, separately approved package.

### 10.7 Prerequisite for the first exploratory run

Before the first exploratory run against any real subject, verify **from the
trusted structured output** that the selected scenario emits no span links. If it
does, the run is unsupported: evidence remains unavailable, no quality conclusion
may be drawn from it, and a collector-version upgrade becomes a separately
approved package rather than an in-flight fix.

### 10.8 Controls

Discovery **192 → 199**. Seven added, none removed, renamed or reordered —
derived mechanically by comparing the two ordered id lists; removing the seven
additions from the new list yields a list byte-identical in order to the old one.

| control | boundary |
|---|---|
| `trusted-channel-ownership-handle-integrity` | a handle must hash to what it claims |
| `trusted-channel-ownership-intent-precedes-creation` | the intent is durable before the resource |
| `trusted-channel-ownership-labels-verified` | the label set must match exactly |
| `trusted-channel-ownership-capability-verified` | the digest must match the retained nonce |
| `trusted-channel-ownership-reconciliation-exact` | recovery removes only what it proves |
| `trusted-channel-cleanup-tombstones-ownership` | a removal retires the claim |
| `trusted-telemetry-span-links-unsupported` | a linked artifact is refused whole |

Two anchors moved with the code they measure.
`trusted-channel-cleanup-scoped-to-created` targeted `this.created`; it targets
the durable handle now, because "only a volume this channel created" used to mean
"only while the creating process is alive" and now means "only a volume this run
holds a run-bound handle for". `trusted-channel-cleanup-failure-reported`
targeted a second `volumeExists` block that is a single expression now.

**Three controls needed correcting after the campaign measured them**, and all
three are recorded rather than quietly fixed:

- two survived their own mutation (§10.4);
- the durable-ownership anchor produced mutants the type checker rejected —
  twice. Assigning the read away narrows the local to `never`; an always-true
  early return discards the narrowing below it. A build failure is a harness
  error rather than a kill, so the control measured nothing. Withholding the
  handle from the accessor's return is the same defect and type-checks;
- `trusted-channel-ownership-capability-verified` killed on both its suites but
  declared one, so the harness scored the live spoof as collateral.

The durable-ownership mutation kills ten cases. That breadth is the honest result
for the most central guard in the module — withhold the handle and nothing
downstream can prove anything — and all ten are declared, because an undeclared
failure is not credited as a kill.

### 10.9 Affected-control map

Derived mechanically on both axes from the changed non-doc paths.

| path | role | mutation target? | designated suite? | discovery dep? |
|---|---|---|---|---|
| `trustedOwnership.ts` | **new** — durable ownership | yes (1) | no | no |
| `trustedChannel.ts` | lifecycle / producer | yes (17) | no | no |
| `trustedTelemetry.ts` | parser / verifier | yes (12) | no | no |
| `composeDriver.ts` | driver / store wiring | yes (6) | no | no |
| `index.ts` | exports | no | no | no |
| `negative-control.mjs` | mutation table | no | no | **yes** |
| `trustedOwnership.test.ts` | **new** — test | no | yes | no |
| `trustedSpanLinks.test.ts` | **new** — test | no | yes | no |
| `trustedCrossProcess.test.ts` | **new** — test | no | yes | no |
| `trustedChannel.test.ts` | test | no | yes | no |
| `trustedRemediation.test.ts` | test | no | yes | no |
| `composeEnvironmentRun.test.ts` | test | no | yes | no |
| `composeStub.ts` | fixture/stub | no | yes (via `composeSubstrate`, `composeEndpointEgress`) | no |

```
discovery 199 | mutation-target 36 | designated-suite 39 | UNION 47
```

Campaign at the final candidate, disposable clone, pinned archive supplied
through `ERL2_CAMPAIGN_OTEL_ARCHIVE`:

```
negative controls: 47 of 199
the working tree is byte-identical to how the campaign started
accounting: 47 discovered = 47 agreed + 0 disagreed + 0 unmeasured + 0 harness error(s)
all 47 measured control(s) matched their recorded expectation
```

Three controls report the declared `RENDERED_TOPOLOGY_SKIP` pair, unchanged from
§9. The full 199-control campaign was **not** run.

### 10.10 Cross-process measurement

`tests/integration/trustedCrossProcess.test.ts` drives each lifecycle step in a
child `node` process that exits before the next begins, against a real daemon.
Constructing two channel objects in one test process is exactly what let the
original defect through, so the boundary here is real and a regression to
in-memory ownership cannot be made to pass by sharing more state inside the test.

| case | result |
|---|---|
| provision in A, destroy in B | removed, zero residue |
| the prior defect's shape — destroy with no durable handle | **refuses**, volume survives, and the owning process still recovers it |
| repeated destroy in a third process | idempotent |
| a wrong-run handle against another run's volume | refuses; the other volume survives |
| a volume with the right name and a foreign capability digest | refuses, reported surviving |
| an unrelated labelled volume beside the run's | untouched |
| in-use volume, then retry once free | reported surviving with the daemon's words; removed on retry |
| full provision-and-destroy | daemon volume inventory unchanged |

### 10.11 Live matrix

Pinned collector at the locked arm64 digest, the committed `transform/trusted`
and `file/trusted` blocks, task-scoped names, all removed afterwards.

| case | ownership | C-171 | gate | diagnostic | cleanup | surviving |
|---|---|---|---|---|---|---|
| crash immediately after creation | `pending-create` | n/a | — | — | not attempted | the volume |
| recovery from pending intent | `pending-create` → reconciled → `created` | n/a | — | recovered | — | — |
| normal teardown | `created` → `released` | — | — | — | removed | none |
| repeated destroy | `released` | — | — | — | not attempted | none |
| wrong-label volume | `created`, retained | — | — | not this channel's to remove | refused | the volume |
| wrong-nonce volume | `created`, retained | — | — | not this channel's to remove | refused | the volume |
| cleanup while in use | `created`, retained | — | — | `volume is in use - [...]` | refused | the volume |
| retry once free | `created` → `released` | — | — | — | removed | none |
| **no-link telemetry** | full lifecycle | `observed` spans=1 attributed=1, 458 B, `settledBy: attribution` | **true** | — | removed | none |
| **linked-span telemetry** | full lifecycle | `absent` | false | `…_span_links_unsupported` | removed | none |
| **mixed linked and unlinked** | full lifecycle | `absent` | false | `…_span_links_unsupported` | removed | none |
| **hostile link attributes** | full lifecycle | `absent` | false | `…_span_links_unsupported` | removed | none |

Docker volume count before and after every case: **0 → 0**. No task-created
Docker resource remained.

The three linked cases are also the live confirmation that the pinned collector
does not strip links: the link content reached the trusted file, and the parser
is what refused it.

### 10.12 Broad suite

Run **once** at the final candidate, canonical checkout, `TMPDIR=/tmp`, pinned
fixture present at `sha256:1bf3ef8f…c051c`, **no retry**.

```
TMPDIR=/tmp npm test
ℹ tests 1520 · pass 1517 · fail 1 · cancelled 0 · skipped 2 · duration_ms 1 037 052
```

| field | value |
|---|---|
| total | 1 520 |
| passed | 1 517 |
| **failed** | **1** |
| cancelled | 0 |
| skipped | 2 |
| fixture state | pinned archive present, verified by digest |
| duration | 1 037 052 ms (~17.3 min) |
| truncation | none — the log terminates on its own trailer |
| retries | none |
| task-created volumes before / after | **0 / 0** |

The two skips are the self-declaring `EXTERNAL SUBJECT UNPROVEN: no external
adapter entry was supplied` pair. The single failure is §10.13.

This is the first broad run at this candidate and it is reported as run. Two
earlier broad attempts are reported rather than folded in: one was aborted by
hand once it had shown a stub gap that made its result meaningless (§10.13), and
one predates the control corrections. Neither is offered as evidence.

**Package 2's earlier recorded broad results remain not reproducible**, as §9
already records for the 1 328-test figure; the 1 477-test remediation figure is
likewise superseded rather than reproduced.

### 10.13 A third pre-existing defect, and two test-side gaps

Correcting the teardown unmasks the next layer, exactly as correcting the stale
resource count unmasked the teardown. `COMPOSE-E2E: a run reaches an
offline-valid terminal through a real Compose substrate` now reaches
`finalize-generic` and fails there:

```
EVALUATOR_INVALID_VALIDITY_IN_GENERIC_INDEX
retained/finding-environment-gate-attributable-telemetry-retained.json
```

**The failing gate is `attributable-telemetry-retained` — the ERL2-C-160 path in
`environmentRun`, which this package does not touch.** The retained v1
observation is `evidence: "observed"` over a `log_excerpt` containing only the
collector's own self-telemetry: the debug stream's window had moved past the
subject's spans. That is the rotating-mixed-stream fragility ADR-ERL2-038 §2
closed as a security boundary and package 3 retires.

**Measured at the parent rather than assumed.** At `adfe24e` the run cannot reach
`finalize-generic` at all — it fails one step earlier at `destroy` with
`TEARDOWN_FAILED: teardown left 2 resource(s)`, the exact leak §10.1 describes,
and no telemetry finding exists at that point because the finding is written at
`finalize-generic`. Clearing the leaked volume externally at the parent, so its
`destroy` succeeds, the parent's run reaches `finalize-generic` and fails with
**the same code and the same finding**. `telemetryObservation.ts`,
`telemetryAuthority.ts` and `environmentRun.ts` are byte-identical between
`adfe24e` and this candidate, and the only `composeDriver.ts` change is the
ownership-store wiring. So this is a pre-existing condition newly exposed, not a
regression — the third layer of masking in one test.

It is left open deliberately, and it is the one thing this package may not fix:
the gate is composed in `environmentRun`, and the remedy is the C-171 wiring that
is package 3's declared scope. Extending the v1 debug parser to make it pass
would be re-opening the boundary ADR-ERL2-038 §2 closed.

Two test-side gaps were corrected:

- `tests/support/composeStub.ts` recorded the labels a volume was created with
  and could not report them, so the driver's ownership read-back saw none and
  refused every provision the real daemon accepts. Thirty-four
  `COMPOSE-ADV`/`COMPOSE-WINDOW` cases failed on a fiction until the stub could
  answer `volume inspect --format '{{json .Labels}}'`.
- `COMPOSE-E2E: a run may not substitute its driver` provisions a real
  environment and never runs `destroy`, so nothing ever asks the channel to tear
  down and one `erl2-trusted-<run>` survived every execution — at the parent as
  well. It reaps its containers and network by exact name already; the volume
  goes with them now.

### 10.14 Status after closure

- the cross-process teardown defect is **closed**; the exact prior leak
  reproduces without a durable handle and is absent with one
- span links are **closed as an explicitly unsupported MVP capability**, with a
  dedicated diagnostic, no partial evidence, and no pin movement
- P0-1, P1-1 and P2-1 remain closed and regression-tested
- **the broad suite does not pass.** One case fails, and it is the C-160
  telemetry gate in `environmentRun` (§10.12) — pre-existing, measured at the
  parent, and outside this package's scope by the same rule that keeps
  `environmentRun` untouched
- `environmentRun` **untouched**; C-160 still authoritative there; package 3
  unchanged in scope
- the full campaign, the clean gate and `evidence:update` remain **not run**
- package 3 remains **blocked** pending focused re-review, and now has one more
  thing to close than it did
