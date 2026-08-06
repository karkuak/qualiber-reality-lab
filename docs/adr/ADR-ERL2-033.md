# ADR-ERL2-033 — attributable telemetry is retained evidence, and its gate binds to declaration

- **Status:** accepted
- **Date:** 2026-08-06
- **Deciders:** Lab Architecture, Environment Governor, Verification Audit
- **Supersedes:** nothing
- **Discharges:** the deferred obligation recorded against ERL2-OQ-005 in
  `docs/ledger/requirements.json` (`deferred_to_first_qualiber_integration_package`),
  `docs/decisions/open-questions.md` (the "Deferred obligation" paragraph of the
  ERL2-OQ-005 detail) and `docs/claims/permitted-claims.md` (~§"No
  retained-telemetry claim"): *retain the attributable-telemetry observation into
  a run's evidence and gate on it*
- **Builds on:** [ADR-ERL2-016](ADR-ERL2-016.md) (discriminated evidence: only
  `observed` counts), [ADR-ERL2-021](ADR-ERL2-021.md) (`EnvironmentDriver` gains
  no operation — respected, not amended), [ADR-ERL2-024](ADR-ERL2-024.md)
  (the offline verifier re-derives; producer fields are the thing under test),
  [ADR-ERL2-027](ADR-ERL2-027.md) (an independent observation gets its own
  identity), [ADR-ERL2-031](ADR-ERL2-031.md) (the evidence window is committed
  before it is used)
- **Normative revision:** `2.0.0-draft.13` (unchanged)

---

## 1. Context

The ERL2-OQ-005 corrective package left one gap open on purpose, and recorded it
in three places: the live acceptance test observes attributable telemetry at the
collector — spans carrying this run's marker — but **no retained artifact carries
that observation**, so an offline bundle attests no such thing. The archetype's
`service-metric` source is recorded `complete` on collector OTLP *pipeline
readiness*, every source snapshot freezes `records: 0`, and
`docs/claims/permitted-claims.md` forbids any claim that retained evidence
attests received telemetry. The seam was prepared:
`ComposeEnvironmentDriver.observeTelemetry(marker)` reads the run's own
Docker-verified collector container's logs and returns
`{traceBatches, spans, serviceNames, runAttributedRecords}`.

Two measured facts about that seam shaped the decisions below:

- **`observeTelemetry` has no callers.** Its doc comment says the live
  acceptance test consumes it; the test in fact re-implements the log parsing
  itself against `docker container logs`. The method was a prepared seam, not a
  consumed one, so its shape may change freely.
- **The run's telemetry post-dates the realized evidence cutoff.** The committed
  phase order runs `observe` (which realizes the cutoff from the signed
  evidence-window commitment, ADR-ERL2-031) and `freeze-observation` *before*
  `execute-subject:exercise`, the step whose request produces the telemetry. An
  observation of that telemetry therefore cannot back any claim inside the
  frozen evidence window, and this ADR does not let it: the retained observation
  is a post-cutoff statement about *receipt during the run*, stamped with its
  own `observed_at`, and the source snapshots' `records: 0` remain exactly as
  true as they were.

## 2. Decision 1 — the observation stays driver-concrete; `EnvironmentDriver` gains no operation

The `EnvironmentDriver` contract does not change. The capability is a separate
seam: `supportsAttributableTelemetry(driver)` is a structural guard over an
`AttributableTelemetryObserver` interface that only the Compose driver
implements. The fake driver does not implement it, honestly: a driver whose
resources are fixtures cannot observe telemetry, and a capability it pretended
to would be exactly the mocked-probe confusion ADR-ERL2-016 exists to prevent.

**The artifact is produced exactly where the capability and a declared metric
source coexist** — a driver that supports the observation *and* an archetype
declaring an evidence source of kind `metric` — and is never produced anywhere
else. On every other run — every fake-driver run, including every golden under
`fixtures/golden/` — the artifact's absence (`ENOENT` for its retained path, no
`attributable-telemetry-observation` role in the lifecycle) means *never
produced*, and this ADR is the place that records that meaning. We chose
never-produced over "the fake driver retains `absent`" because a retained
record named *attributable-telemetry observation* in a bundle whose driver
cannot observe telemetry attests nothing and invites the very conflation this
package closes; it would also churn every golden byte for no evidentiary gain.
Where the artifact *is* produced but the observation could not be made (the
collector container no longer Docker-verified, its logs unreadable), the
artifact honestly records `evidence: "absent"` with a typed reason — absence of
observation is then a retained fact, not a missing file.

## 3. Decision 2 — discriminated evidence, and no verdict field at all

A new contract, `AttributableTelemetryObservationV1` (ERL2-C-160,
`attributable-telemetry-observation/v1`, group `environment`), models the
observation with discriminated evidence in the ADR-ERL2-016 sense:

- `evidence: "observed" | "absent"`. Only `observed` may carry the counts
  (`trace_batches`, `spans`, `service_names`, `run_attributed_records`), the
  collector identity, and the log-excerpt reference; the schema requires all of
  them then and forbids all of them otherwise, and an `absent` record must say
  why (`reason_code`). A non-observation that carried a count would be
  unrepresentable, not merely refused.
- **No field stores a verdict.** "Attributable telemetry was received" is
  derivable only from an `observed` record whose `run_attributed_records` is
  positive and whose marker is this run's id — derived by the producer's
  validity gate and re-derived by the offline verifier, never read from the
  artifact. The artifact records observations; every verdict has an owner
  elsewhere.
- The collector identity records what Docker proved about the exact container
  the logs were read from — service id, run-scoped container name, the observed
  image id and repo digests — with `ownership_verified` and
  `image_matches_locked_digest` as schema constants `true`: the driver refuses
  to read logs from an unverified container, so an unverified observation is
  unrepresentable as `observed`.
- The `marker` is the run id itself, not an adapter-chosen string: any subject
  whose emitted telemetry embeds the run id is attributable, and the expected
  marker is re-derivable by every reader from the run id alone.

**The supporting log excerpt is retained bytes, and the counts are re-derivable
from it.** The parsing arithmetic lives in `@erl2/core` as *definitions* in the
ADR-ERL2-024 §7.2 sense (`parseCollectorTelemetry`,
`excerptCollectorTelemetry`): the excerpt keeps exactly the collector log lines
that contribute to any count (trace-batch lines, `service.name` lines, lines
carrying the marker), in order, so `parse(excerpt, marker)` equals
`parse(full logs, marker)` by construction. The excerpt is frozen under
`retained/` and referenced by an `ArtifactRef` inside the hash-covered
observation, so the referenced-bytes pass re-hashes it and the retained-file
accounting pass accounts for it. The offline verifier recomputes every count
from those bytes and refuses disagreement — in both directions.

## 4. Decision 3 — the gate binds to declaration, not to all runs

A run **declares the observation obtainable** exactly when all three hold, each
derivable from retained bytes alone:

1. the retained `environment-driver-manifest/v1` has `driver_kind: "compose"`
   (a closed enum, not a name);
2. the retained `environment-archetype/v1` declares an evidence source of kind
   `metric`;
3. a retained `journey-step-outcome/v1` of this run has `intent: "exercise"`
   with `status: "succeeded"` — the journey actually reached the step that
   produces telemetry.

Where all three hold and the observation is then missing, not `observed`,
unattributed (zero run-marked records), not this run's, or in contradiction
with its own excerpt bytes, the run is refused. Where any of the three does not
hold, nothing changes: a fake-driver development run receives no telemetry by
construction and remains exactly as valid as it was, and every golden is
byte-identical.

Two enforcement points, deliberately at different trust boundaries
(ADR-ERL2-024's pattern, not a duplicate guard — each is separately measured by
its own negative control):

- **Producer:** a new Lab-owned validity gate,
  `attributable-telemetry-retained` (catalogued under `evidence_completeness`,
  required on environment terminals). Passing means *not declared, or declared
  and satisfied*; failing freezes an invalidity finding and the terminal goes
  invalid. The gate never throws — it fails closed through the validity result
  like every other environment gate.
- **Offline verifier:** `deriveAttributableTelemetry` re-derives the
  declaration predicate from the retained driver manifest, archetype and step
  outcomes, requires exactly one observation where declared, checks the
  observation is this run's (`run_id`, `marker === run id`), that it was
  produced by the `teardown_started` event (the placement that proves the
  collector was read while the containers provably still lived), recomputes
  every count from the retained excerpt bytes, and refuses any disagreement
  with a typed code. It reads no producer verdict — there is none to read.

New refusal codes (append-only): `ENV_TELEMETRY_OBSERVATION_MISSING` (declared
and not retained, or the role count is wrong), `ENV_TELEMETRY_NOT_ATTRIBUTED`
(declared and the retained observation is `absent` or carries zero run-marked
records), `ENV_TELEMETRY_OBSERVATION_MISMATCH` (an observation that is not this
run's, whose marker is not the run id, whose counts contradict its excerpt,
whose excerpt carries non-contributing lines, or whose producing event is not
`teardown_started`).

The verifier role is `attributable-telemetry-observation` in
`ENVIRONMENT_OPTIONAL_ROLES` — optional as a role, required as soon as the
declaration predicate holds, which the derivation enforces. It is deliberately
**not** a `SUPPORTING_SCHEMAS` entry: a supporting schema is exempt from
reachability, and an observation no lifecycle event produced must invalidate
the closure, not slip past it.

## 5. Decision 4 — when the observation is taken, and what its timing can never claim

The observation is taken inside `destroy()`, **before** the `teardown_started`
lifecycle event is appended: observe, freeze the excerpt, freeze the
observation, and only then append `teardown_started` carrying the produced
entry — freeze first, anchor second, one durable transition at a time, with no
throwing resolution between two freezes (P1-10). Producing it on
`teardown_started` makes the ordering claim self-proving: the hash chain places
the observation before the event that begins teardown, so the collector was
read while this run's containers were provably alive. The driver's observation
retries briefly while zero run-marked records are visible — the collector's
exporter flushes on its own schedule — and then records honestly whatever it
last saw; waiting longer can only add records to an append-only log, never
remove them.

The observation post-dates the realized cutoff, and no wording anywhere is
permitted to launder that: it backs the claim *the run's own collector received
telemetry carrying this run's id, observed after the exercising step and before
teardown* — never a claim about the frozen evidence window, never a service
metric, and never anything above T1. The `service-metric` source mapping is
unchanged (`complete` still means pipeline reachability); its documentation now
says the receipt of telemetry is separately retained instead of saying nothing
retains it.

## 6. Failure ownership, ordering and refusal codes

| Code | Raised by | Raised when |
| --- | --- | --- |
| `ENV_TELEMETRY_OBSERVATION_MISSING` | offline verifier | declaration predicate holds and no `attributable-telemetry-observation` role is retained |
| `ENV_TELEMETRY_NOT_ATTRIBUTED` | offline verifier | declaration predicate holds and the retained observation is `absent`, or carries `run_attributed_records: 0` |
| `ENV_TELEMETRY_OBSERVATION_MISMATCH` | offline verifier | the observation is not this run's, its marker is not the run id, its counts disagree with the counts recomputed from its retained excerpt bytes, its excerpt carries a line that contributes to no count, there is more than one observation, or its producing event is not `teardown_started` |
| gate `attributable-telemetry-retained` failing | producer validity | the same declaration predicate holds and the retained observation is missing, not `observed`, not this run's, or unattributed — the terminal goes invalid through a frozen finding, like every environment gate |

All failures are Lab-owned. An invalid terminal is unaffected: it claims
nothing, so the derivation does not run on the invalid branch; the observation,
if a failed run retained one, stays accounted through the invalid record's
available evidence like every other produced artifact.

## 7. What is explicitly not decided here

No `EnvironmentDriver` operation is added and the driver enum is untouched. No
lifecycle event type, state or phase is added, reordered or removed —
`teardown_started` gains produced entries it was always allowed to carry. No
signer is added: the observation is unsigned on purpose; its integrity rests on
the core hash, the hash-chained lifecycle and the byte-recomputable excerpt,
and a repo-derivable development signature would add authority theater, not
authority. The claim ceiling does not move: T1, development tier, non-blind
selection, development-signed self-qualified substrate, exactly as before.
ERL2-OQ-007, ERL2-OQ-008 and ERL2-OQ-009 surfaces are untouched, and
`OTEL_DEMO_SERVICES` is unchanged. The cutoff machinery of ADR-ERL2-031 is
untouched; nothing about this observation participates in the evidence window.

## 8. Rejected alternatives

| Alternative | Rejected because |
| --- | --- |
| The fake driver retains an `absent` observation on every run | A record of a non-observation by a driver that cannot observe attests nothing, invites the retained-telemetry conflation this package closes, and rewrites every golden byte for no evidentiary gain. |
| A new lifecycle phase / CLI command for the observation | A new durable state on the shared phase machine for a driver-concrete observation widens every run's state space to serve one driver; `destroy()` already owns the last moment the substrate is provably alive. |
| Reorder the journey so exercise precedes the cutoff | The cutoff discipline (ADR-ERL2-031, remediation 6.5) is not this package's to move, and honest post-cutoff wording costs nothing but a narrower claim. |
| Sign the observation with the environment governor's key | A development-key signature on a self-observed record adds no authority the hash-chained lifecycle does not already carry, at the price of signer-inventory surface. |
| Register the schema in `SUPPORTING_SCHEMAS` instead of a role | Supporting schemas are exempt from reachability: an observation no event produced would be silently admitted. The activation-receipt regression (review P2) is the standing cautionary tale. |
| An adapter-supplied marker string | The marker would then be a subject-shaped free variable the verifier cannot re-derive; the run id is derivable by every reader and any subject that embeds it is attributable. |
| Gate on all Compose runs regardless of journey | A Compose run whose journey never reaches the exercising step receives no telemetry by construction; refusing it would punish a true statement. The declaration predicate names exactly the runs whose telemetry silence is a lie. |
