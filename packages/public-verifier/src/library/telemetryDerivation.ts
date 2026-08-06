/**
 * The attributable-telemetry derivation (ADR-ERL2-033 decision 3).
 *
 * Everything below is recomputed from retained bytes and the hash-chained
 * lifecycle. The retained observation stores no verdict — there is nothing to
 * trust even by accident — so what is under test here is its *observations*:
 * whether this run declared the observation obtainable, whether exactly one
 * observation was produced where declared, whether it is this run's, and
 * whether every count it declares is the count its own inline log excerpt
 * derives. The parsing arithmetic (`parseCollectorTelemetry`,
 * `excerptCollectorTelemetry`) is shared with the producer on purpose: it is a
 * *definition*, not a judgement (ADR-ERL2-024 §7.2). Every refusal on this
 * page is verifier-owned and shared with nothing.
 *
 * The invalid branch is deliberately not derived: an invalid terminal claims
 * nothing, so telemetry silence there is not a lie. An observation a failed
 * run retained stays accounted like every other produced artifact.
 */

import {
  CODES,
  Erl2Error,
  type AttributableTelemetryObservationV1,
  type EnvironmentArchetypeV1,
  type EnvironmentDriverManifestV1,
  type Hash,
  type JourneyStepOutcomeV1,
  type LabLifecycleEventV1,
} from "@erl2/contracts";
import { excerptCollectorTelemetry, parseCollectorTelemetry } from "@erl2/core";
import type { ArtifactIndex } from "./artifactIndex.js";

const OBSERVATION_ROLE = "attributable-telemetry-observation";
const OBSERVATION_SCHEMA = "attributable-telemetry-observation/v1";

/** Groups every `produced` entry of the lifecycle by role. */
function rolesOf(events: readonly LabLifecycleEventV1[]): Map<string, readonly Hash[]> {
  const roles = new Map<string, Hash[]>();
  for (const event of events) {
    for (const produced of event.produced) {
      const existing = roles.get(produced.artifact_role) ?? [];
      existing.push(produced.artifact_core_hash);
      roles.set(produced.artifact_role, existing);
    }
  }
  return roles;
}

/** The event type that produced `hash` under the observation role. */
function producingEventType(
  events: readonly LabLifecycleEventV1[],
  hash: Hash,
): string | undefined {
  for (const event of events) {
    for (const produced of event.produced) {
      if (produced.artifact_role === OBSERVATION_ROLE && produced.artifact_core_hash === hash) {
        return event.event_type;
      }
    }
  }
  return undefined;
}

export interface AttributableTelemetryReport {
  /** Whether this run declared the observation obtainable. */
  readonly declared: boolean;
  /** Whether an `observed` observation of this run is retained and consistent. */
  readonly observed: boolean;
  /** Recomputed from the retained excerpt bytes, never read from a count. */
  readonly runAttributedRecords: number;
}

/**
 * Re-derives the attributable-telemetry obligation from retained bytes.
 *
 * The declaration predicate is recomputed here from the retained driver
 * manifest, archetype and step outcomes — never read from the producer's gate
 * result, which this derivation does not even resolve. Where the predicate
 * holds, exactly one observation must exist, be this run's, be `observed`,
 * carry the run id as its marker, agree with its own excerpt bytes on every
 * count, and count at least one run-attributed record. Where it does not
 * hold, a retained observation is still checked for internal consistency —
 * a smuggled artifact must not become less checkable by being unnecessary.
 */
export function deriveAttributableTelemetry(options: {
  readonly index: ArtifactIndex;
  readonly lifecycle: readonly LabLifecycleEventV1[];
  readonly runId: string;
}): AttributableTelemetryReport {
  const roles = rolesOf(options.lifecycle);

  const manifestHashes = roles.get("environment-driver-manifest") ?? [];
  if (manifestHashes.length !== 1) {
    throw new Erl2Error(
      CODES.ENV_SUBSTRATE_BINDING_MISMATCH,
      `the telemetry derivation needs exactly one retained driver manifest and the lifecycle produced ${String(manifestHashes.length)}`,
    );
  }
  const manifest = options.index.typed<EnvironmentDriverManifestV1>(
    manifestHashes[0] as Hash,
    "environment-driver-manifest/v1",
  );

  const archetypeHashes = roles.get("environment-archetype") ?? [];
  if (archetypeHashes.length !== 1) {
    throw new Erl2Error(
      CODES.ENV_SUBSTRATE_BINDING_MISMATCH,
      `the telemetry derivation needs exactly one retained archetype and the lifecycle produced ${String(archetypeHashes.length)}`,
    );
  }
  const archetype = options.index.typed<EnvironmentArchetypeV1>(
    archetypeHashes[0] as Hash,
    "environment-archetype/v1",
  );

  const outcomes = (roles.get("journey-step-outcome") ?? [])
    .map((hash) =>
      options.index.typed<JourneyStepOutcomeV1>(hash, "journey-step-outcome/v1"),
    )
    .filter((outcome) => outcome.run_id === options.runId);

  // The declaration predicate, recomputed — the same three conjuncts the
  // producer's gate binds to, each answered from retained bytes alone.
  const declared =
    manifest.driver_kind === "compose" &&
    archetype.evidence_sources.some((source) => source.kind === "metric") &&
    outcomes.some((outcome) => outcome.intent === "exercise" && outcome.status === "succeeded");

  const observationHashes = roles.get(OBSERVATION_ROLE) ?? [];
  if (observationHashes.length === 0) {
    if (declared) {
      throw new Erl2Error(
        CODES.ENV_TELEMETRY_OBSERVATION_MISSING,
        "this run declares an obtainable attributable-telemetry observation — a compose driver, " +
          "an archetype declaring a metric source and a succeeded exercising step — and retains none",
      );
    }
    return { declared: false, observed: false, runAttributedRecords: 0 };
  }
  if (observationHashes.length > 1) {
    throw new Erl2Error(
      CODES.ENV_TELEMETRY_OBSERVATION_MISMATCH,
      `this run retains ${String(observationHashes.length)} attributable-telemetry observations; exactly one may exist`,
    );
  }
  const observationHash = observationHashes[0] as Hash;
  const observation = options.index.typed<AttributableTelemetryObservationV1>(
    observationHash,
    OBSERVATION_SCHEMA,
  );

  // The placement is the liveness proof: an observation produced by any event
  // but `teardown_started` does not show the collector was read while the
  // containers still lived, so the ordering claim would be asserted, not derived.
  const producedBy = producingEventType(options.lifecycle, observationHash);
  if (producedBy !== "teardown_started") {
    throw new Erl2Error(
      CODES.ENV_TELEMETRY_OBSERVATION_MISMATCH,
      `the retained telemetry observation was produced by ${producedBy ?? "no lifecycle event"}; ` +
        "only teardown_started may produce it, because that placement is the proof the collector " +
        "was read before teardown began",
    );
  }

  if (observation.run_id !== options.runId) {
    throw new Erl2Error(
      CODES.ENV_TELEMETRY_OBSERVATION_MISMATCH,
      "the retained telemetry observation names another run; an observation of another run says nothing about this one",
    );
  }
  if (observation.marker !== options.runId) {
    throw new Erl2Error(
      CODES.ENV_TELEMETRY_OBSERVATION_MISMATCH,
      "the retained telemetry observation's marker is not the run id; a marker a reader cannot re-derive attributes nothing",
    );
  }

  if (observation.evidence !== "observed") {
    if (declared) {
      throw new Erl2Error(
        CODES.ENV_TELEMETRY_NOT_ATTRIBUTED,
        `this run declares an obtainable attributable-telemetry observation and the retained record is absent (${observation.reason_code ?? "no reason recorded"})`,
      );
    }
    return { declared: false, observed: false, runAttributedRecords: 0 };
  }

  // Defensive reads below the schema, deliberately: `ArtifactIndex.typed`
  // checks the schema_version string and the recomputed core hash and nothing
  // else, so "the schema would have caught it" is not a check here.
  const excerpt = observation.log_excerpt;
  if (excerpt === undefined) {
    throw new Erl2Error(
      CODES.ENV_TELEMETRY_OBSERVATION_MISMATCH,
      "an observed telemetry record carries no log excerpt; counts with no derivable source attest nothing",
    );
  }

  // The excerpt must be a fixed point of excerpting: a line that contributes
  // to no count has no business in the bytes the counts are derived from.
  if (excerptCollectorTelemetry(excerpt, observation.marker) !== excerpt) {
    throw new Erl2Error(
      CODES.ENV_TELEMETRY_OBSERVATION_MISMATCH,
      "the retained telemetry log excerpt carries lines that contribute to no count; an excerpt is exactly the lines the counts derive from",
    );
  }

  const derived = parseCollectorTelemetry(excerpt, observation.marker);
  const declaredNames = observation.service_names ?? [];
  const namesAgree =
    declaredNames.length === derived.serviceNames.length &&
    declaredNames.every((name, position) => name === derived.serviceNames[position]);
  if (
    observation.trace_batches !== derived.traceBatches ||
    observation.spans !== derived.spans ||
    observation.run_attributed_records !== derived.runAttributedRecords ||
    !namesAgree
  ) {
    throw new Erl2Error(
      CODES.ENV_TELEMETRY_OBSERVATION_MISMATCH,
      `the retained telemetry observation declares ${String(observation.trace_batches)} trace ` +
        `batches, ${String(observation.spans)} spans and ${String(observation.run_attributed_records)} ` +
        `run-attributed records, but the verifier derives ${String(derived.traceBatches)}, ` +
        `${String(derived.spans)} and ${String(derived.runAttributedRecords)} from its own retained excerpt`,
    );
  }

  if (declared && derived.runAttributedRecords < 1) {
    throw new Erl2Error(
      CODES.ENV_TELEMETRY_NOT_ATTRIBUTED,
      "this run declares an obtainable attributable-telemetry observation and the retained record carries zero records naming this run's marker",
    );
  }

  return { declared, observed: true, runAttributedRecords: derived.runAttributedRecords };
}
