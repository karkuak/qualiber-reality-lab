# Compose E2E telemetry observation: why the gate stopped reading a rotating log

Date: 2026-08-12

Corrected at: `b22e9fb4cb24b030ecaf84fa5d721ed0bf649d6a` (parent
`b6fc61f6982bdb8202a0d77902e0a4982309f712`)

## The defect

`COMPOSE-E2E: a run reaches an offline-valid terminal through a real Compose
substrate` derived its span count by repeatedly running `docker container logs`
against the run's collector and matching the console exporter's `Traces` summary
line.

The pinned collector container is created with upstream's rotating `json-file`
options — `max-size=5m`, `max-file=2` — and the Lab's own collector extras keep
the `debug` exporter at `verbosity: detailed`, which is what makes a span's
attributes visible for run attribution. The collector also exports its own
self-telemetry back through that exporter, so a slow run writes megabytes in
seconds.

A diagnosed failure under host contention had:

- three `POST /getquote` requests, all answered `200`;
- spans emitted by the quote service;
- a trace batch received and exported by the collector at `19:44:16.065`, with
  `resource spans: 1`, `spans: 3`, `service.name: Str(quote)`;
- the run marker `erl2_run=` present 63 times.

and still asserted *"the collector received no spans; telemetry was not actually
emitted"*. The container had started at `19:43:50.02`, but the earliest console
record still retrievable through `docker logs` was `19:44:38.92`: the first 48.9
seconds — including the line carrying the count — had rotated out before the
polling loop read it. The message named a conclusion its evidence contradicted.

The classification was `PRE_EXISTING_FLAKY_TEST`. The test, the Compose
substrate, the driver, the overlay, the lock, the archive and the whole
telemetry path are byte-identical between merged `main`
(`70b7e6e00aabba30bc07ca2c15d35404e40439b7`) and Package A `b6fc61f`; six
controlled attempts passed 3/3 on each revision, and the failure reproduced on
demand only under host saturation.

## What was rejected

| Candidate | Why not |
|---|---|
| Longer poll / larger deadline | Reads the same evicted window. Moves nothing. |
| Larger `max-size` / `max-file` | Moves the cliff instead of removing it, and changes the substrate's configuration hash. |
| Existing `observeTelemetry` / `observeAttributableTelemetry` | Same source. Both parse `docker container logs`, and the retained observation is captured at `destroy` — *later* than the test's own read, so strictly more exposed to rotation, not less. |
| Retained `attributable-telemetry-observation.json` | Durable as an artifact, but its counts come from that same late read of the same rotating log. |
| Test-only collector `file` exporter on a mounted path | Genuinely durable, but it requires editing `erl2-otelcol-extras.yaml` and adding a writable bind mount to `erl2-overlay.yaml`. Both digests feed `observeComposeSubstrate`'s `configHashes`, and the overlay exists precisely to keep the collector's exposure minimal. A new writable mount into the collector to make a test easier is a substrate and security change, and a larger one than the defect warrants. |
| Collector self-telemetry counts | Present and durable, but they are the collector describing itself. Treating them as proof of subject traces without per-batch correlation is exactly the conflation the pipeline-readiness probe was renamed to avoid. |

## What was done

`docker container logs --follow` is attached once, as soon as the collector
container exists, and its output is copied to a task-owned file as it is
produced. Rotation inside the container cannot evict what has already been
written there, so durability is structural rather than a matter of reading
quickly enough.

This changes no substrate. No collector configuration, no Compose overlay, no
mount, no image, no release tag, no digest, no lock, and no product code path:
`substrate-lock.json`, `erl2-overlay.yaml`, `erl2-otelcol-extras.yaml`,
`composeSubstrate.ts`, `composeDriver.ts` and `telemetryObservation.ts` are
byte-identical to both `b6fc61f` and `origin/main`. `docker logs` is read-only —
it copies output the container already produced — so the observed environment is
the one the product provisions.

Attribution is per batch, not document-wide. A batch belongs to this run exactly
when the detailed dump *between its summary line and the next signal summary*
names this run. The block boundary is the next signal summary rather than the
next console record because, at `verbosity: detailed`, the dump's own first line
carries a console prefix — ending the block there would count the batch and then
attribute it to nobody.

## What the observation refuses to collapse

A count cannot distinguish defects that have different owners, so the result is
structured and the assertion reports the first missing transition:

| Code | Means |
|---|---|
| `TRACE_OBSERVATION_UNAVAILABLE` | The capture could not be read. Nothing is claimed about telemetry. |
| `TRACE_NOT_EMITTED` | The capture is readable and holds no trace batch at all. |
| `TRACE_RUN_ATTRIBUTION_MISSING` | Trace batches arrived; none carries this run's marker. |
| `TRACE_OBSERVATION_TIMEOUT` | The bounded deadline closed before any batch arrived. |
| `CURRENT_RUN_SPANS_OBSERVED` | This run's spans were durably observed. |

`otherRunSpanCount` is reported separately so a previous Compose project's
output can never satisfy this run, and `collectorReceivedTraceData` stays true
when traces arrived unattributed — sending a reader to the observer rather than
to the producer.

## Scope

Test and test-support only: `tests/support/durableTelemetry.ts`,
`tests/integration/durableTelemetryObservation.test.ts`, and the assertion site
in `tests/e2e/composeEnvironmentRun.test.ts`. No Package A contract, SDK, host,
reducer, certification or claim-firewall code was touched, and the
driver-substitution test keeps its semantics unchanged.
