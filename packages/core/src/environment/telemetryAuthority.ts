/**
 * The single decision point for "may this retained record authorize a new
 * trusted telemetry claim?" (ADR-ERL2-038 correction R8).
 *
 * ## Why one function and not a check in each consumer
 *
 * Two authorities read the retained observation: the producer's
 * `attributable-telemetry-retained` validity gate, and the offline verifier's
 * `deriveAttributableTelemetry`. If each answered the version question for
 * itself, a package that updated one and not the other would open exactly the
 * window R8 forbids — an interval in which the forgeable v1 channel still
 * authorizes evidence somewhere. Both call this, and the migration is
 * therefore atomic by construction rather than by review discipline.
 *
 * This is a *policy* shared between producer and verifier, and sharing it is
 * sound on ADR-ERL2-024 §7.2's own terms: its input is a retained artifact's
 * declared version, which the Lab writes, not a subject. The thing ADR-ERL2-038
 * §4 forbids sharing is a *framing* definition whose inputs a subject controls,
 * and this is not one. Every count remains independently recomputed by each
 * authority from the retained bytes.
 *
 * ## What "authoritative" means here, and what it does not
 *
 * This answers only *which record governs*. It does not answer whether that
 * record satisfies a claim: a coherent `absent` record is the record that
 * governs, and it governs a refusal. The claim rule lives with the gate, which
 * is where it lived in v1.
 *
 * ## Status
 *
 * The trusted channel does not exist yet (packages 2 and 3). Nothing in this
 * repository produces a v2 record, so at this commit **every** run that
 * declares attributable telemetry obtainable is refused, and that is the
 * intended and honest state: the `6d28d543` defect is open, the v1 channel is
 * forgeable, and a Lab that kept authorizing claims from it while the ADR says
 * it cannot be trusted would be asserting what it cannot show.
 */

import {
  validateContract,
  type AttributableTelemetryObservationV1,
  type AttributableTelemetryObservationV2,
} from "@erl2/contracts";
import { coreHash, coreOf, hashBytes } from "@erl2/integrity";
import { parseTrustedTelemetryRecords, utf8ByteLength } from "./trustedTelemetry.js";

/** The schema version that may authorize a new trusted telemetry claim. */
export const TRUSTED_TELEMETRY_AUTHORITY_VERSION = "attributable-telemetry-observation/v2";

/**
 * The historical schema version.
 *
 * Retained, parseable and verifiable within its original scope, so evidence
 * frozen before the trusted channel existed keeps verifying and no historical
 * hash moves. Never authoritative for a new claim.
 */
export const HISTORICAL_TELEMETRY_VERSION = "attributable-telemetry-observation/v1";

/** Keys that exist only on v1, used to catch a record mixing the two shapes. */
const V1_ONLY_KEYS: readonly string[] = ["log_excerpt"];

/** Keys that exist only on v2. */
const V2_ONLY_KEYS: readonly string[] = ["channel", "binding", "artifact", "trusted_records"];

/** Why a retained record may not authorize a new trusted telemetry claim. */
export const TELEMETRY_AUTHORITY_REASONS = {
  /** Nothing of either version was retained. */
  absent: "telemetry_authority_no_trusted_observation",
  /**
   * Only a v1 record exists. Refused rather than downgraded to: v1 derives its
   * counts from a stream whose framing a subject can reproduce, so accepting it
   * "because it is all we have" is accepting the forgery this ADR closed.
   */
  v1NotAuthoritative: "telemetry_authority_v1_not_authoritative",
  /** A v2 record exists and does not satisfy ERL2-C-171. No fallback follows. */
  v2Invalid: "telemetry_authority_v2_invalid",
  /** A record declaring one version while carrying the other's fields. */
  mixedVersionFields: "telemetry_authority_mixed_version_fields",
  /** A retained record whose schema version this Lab does not know. */
  unknownVersion: "telemetry_authority_unknown_version",
  /** More than one v2 record; exactly one may govern. */
  cardinality: "telemetry_authority_observation_cardinality",
  /** The record's declared marker is not its own run id. */
  markerNotRunId: "telemetry_authority_marker_not_run_id",
  /** The declared counts, bounds or digest disagree with the retained bytes. */
  incoherent: "telemetry_authority_artifact_incoherent",
  /**
   * The record's own `core_hash` is not the hash of its own fields.
   *
   * R5's post-freeze mutation check, taken here rather than only at the artifact
   * index: a record edited after it was frozen — including one whose bytes and
   * digest were *both* updated consistently — no longer hashes to what it
   * claims, and a reader that resolved it by any other route than the index
   * would otherwise never notice.
   */
  freezeBroken: "telemetry_authority_core_hash_broken",
} as const;

/** The record that governs trusted telemetry for a run, or why none does. */
export type TrustedTelemetryAuthority =
  | {
      readonly authoritative: true;
      readonly observation: AttributableTelemetryObservationV2;
    }
  | { readonly authoritative: false; readonly refusal: string };

const refuse = (refusal: string): TrustedTelemetryAuthority => ({
  authoritative: false,
  refusal,
});

function declaredVersion(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const version = (value as Record<string, unknown>)["schema_version"];
  return typeof version === "string" ? version : undefined;
}

function carriesAny(value: unknown, keys: readonly string[]): boolean {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return keys.some((key) => Object.prototype.hasOwnProperty.call(record, key));
}

/**
 * Why this v2 record's declarations disagree with its own retained bytes, or
 * `undefined`.
 *
 * Every comparison recomputes the left-hand side rather than reading it. The
 * point is not that the producer might lie — it is that a producer and a
 * verifier that both *read* a count agree about nothing, which is how a forged
 * `spans: 9999` verified clean at `6d28d543`.
 */
export function trustedTelemetryCoherenceRefusal(
  observation: AttributableTelemetryObservationV2,
): string | undefined {
  if (observation.marker !== observation.run_id) {
    return TELEMETRY_AUTHORITY_REASONS.markerNotRunId;
  }
  if (observation.evidence !== "observed") return undefined;

  // Reachable: the schema requires these on `observed`, and `validateContract`
  // has already run — but this function is exported and the offline verifier
  // calls it on bytes it did not build, so it re-establishes its own premises.
  const artifact = observation.artifact;
  const bytes = observation.trusted_records;
  if (artifact === undefined || bytes === undefined) {
    return TELEMETRY_AUTHORITY_REASONS.incoherent;
  }

  const parsed = parseTrustedTelemetryRecords(bytes, observation.marker);
  if (!parsed.ok) return parsed.reasonCode;
  const counts = parsed.counts;

  if (artifact.byte_length !== counts.byteLength) return TELEMETRY_AUTHORITY_REASONS.incoherent;
  if (artifact.record_count !== counts.recordCount) return TELEMETRY_AUTHORITY_REASONS.incoherent;
  if (artifact.final_record_terminated !== counts.finalRecordTerminated) {
    return TELEMETRY_AUTHORITY_REASONS.incoherent;
  }
  if (artifact.content_digest !== hashBytes(Buffer.from(bytes, "utf8"))) {
    return TELEMETRY_AUTHORITY_REASONS.incoherent;
  }
  // Defence against a byte_length that agrees with a *recomputed* length while
  // disagreeing with the contract's bound: the schema caps the field, but the
  // cap is on UTF-16 length and the bound is on UTF-8 bytes.
  if (counts.byteLength !== utf8ByteLength(bytes)) return TELEMETRY_AUTHORITY_REASONS.incoherent;

  if (observation.trace_batches !== counts.traceBatches) {
    return TELEMETRY_AUTHORITY_REASONS.incoherent;
  }
  if (observation.spans !== counts.spans) return TELEMETRY_AUTHORITY_REASONS.incoherent;
  if (observation.run_attributed_records !== counts.runAttributedRecords) {
    return TELEMETRY_AUTHORITY_REASONS.incoherent;
  }
  const declaredNames = observation.service_names ?? [];
  if (
    declaredNames.length !== counts.serviceNames.length ||
    !declaredNames.every((name, position) => name === counts.serviceNames[position])
  ) {
    return TELEMETRY_AUTHORITY_REASONS.incoherent;
  }
  return undefined;
}

/**
 * The record that governs trusted telemetry, or why none does.
 *
 * Order matters and is fixed. An unknown version is answered before anything
 * else, because a Lab that cannot name what it is holding must not proceed to
 * ask whether it is satisfactory; and a v2 that fails validation refuses
 * outright rather than falling through to a v1 that would have passed, which
 * is the downgrade R8 exists to forbid.
 */
export function decideTrustedTelemetryAuthority(
  retained: readonly unknown[],
): TrustedTelemetryAuthority {
  const v2: unknown[] = [];
  let historical = 0;

  for (const candidate of retained) {
    const version = declaredVersion(candidate);
    if (version === TRUSTED_TELEMETRY_AUTHORITY_VERSION) {
      if (carriesAny(candidate, V1_ONLY_KEYS)) {
        return refuse(TELEMETRY_AUTHORITY_REASONS.mixedVersionFields);
      }
      v2.push(candidate);
      continue;
    }
    if (version === HISTORICAL_TELEMETRY_VERSION) {
      if (carriesAny(candidate, V2_ONLY_KEYS)) {
        return refuse(TELEMETRY_AUTHORITY_REASONS.mixedVersionFields);
      }
      historical += 1;
      continue;
    }
    return refuse(TELEMETRY_AUTHORITY_REASONS.unknownVersion);
  }

  if (v2.length === 0) {
    // A valid v1 beside no v2 is the whole point of R8: it is readable, it is
    // historically verifiable, and it authorizes nothing here.
    return refuse(
      historical > 0
        ? TELEMETRY_AUTHORITY_REASONS.v1NotAuthoritative
        : TELEMETRY_AUTHORITY_REASONS.absent,
    );
  }
  if (v2.length > 1) return refuse(TELEMETRY_AUTHORITY_REASONS.cardinality);

  const candidate = v2[0];
  if (!validateContract("AttributableTelemetryObservationV2", candidate).valid) {
    return refuse(TELEMETRY_AUTHORITY_REASONS.v2Invalid);
  }
  const observation = candidate as AttributableTelemetryObservationV2;
  if (coreHash(coreOf(observation)) !== observation.core_hash) {
    return refuse(TELEMETRY_AUTHORITY_REASONS.freezeBroken);
  }
  return { authoritative: true, observation };
}

/**
 * Why no retained record may support a new trusted telemetry claim, or
 * `undefined`.
 *
 * Authority *and* coherence, in that order — and they are deliberately two
 * functions rather than one. Authority is a question about the record's
 * version and provenance, and both authorities must answer it identically or
 * the migration has a hole. Coherence is a question about the record's
 * *content*, and each authority must answer that one **for itself**: a
 * verifier that delegated its arithmetic to a shared helper would be agreeing
 * with the producer rather than checking it, which is exactly the failure
 * ADR-ERL2-038 §4 recorded. So the producer's gate composes the two here, and
 * the offline verifier composes authority with its own recomputation.
 */
export function trustedTelemetryClaim(retained: readonly unknown[]): TrustedTelemetryAuthority {
  const authority = decideTrustedTelemetryAuthority(retained);
  if (!authority.authoritative) return authority;
  const incoherent = trustedTelemetryCoherenceRefusal(authority.observation);
  if (incoherent !== undefined) return refuse(incoherent);
  return authority;
}

/** The same decision as a reason, for callers that only need to say why. */
export function trustedTelemetryClaimRefusal(retained: readonly unknown[]): string | undefined {
  const claim = trustedTelemetryClaim(retained);
  return claim.authoritative ? undefined : claim.refusal;
}

/**
 * Whether a retained v1 record may still be *read* — always — restated as a
 * function so the historical-compatibility rule has a name a control can
 * mutate, rather than living only in prose.
 *
 * Reading is not authorizing. This returns the record for a historical reader;
 * nothing that calls it may treat the result as satisfying a new claim.
 */
export function readHistoricalTelemetryObservation(
  value: unknown,
): AttributableTelemetryObservationV1 | undefined {
  if (declaredVersion(value) !== HISTORICAL_TELEMETRY_VERSION) return undefined;
  if (carriesAny(value, V2_ONLY_KEYS)) return undefined;
  if (!validateContract("AttributableTelemetryObservationV1", value).valid) return undefined;
  return value as AttributableTelemetryObservationV1;
}
