/**
 * Admission registry (design v2 §8, ERL2-FR-002).
 *
 * A read-only, content-addressed store of artifacts the governor admitted out
 * of band: archetypes, challenges, journeys, visible steps, step commitments,
 * policies and manifests. The Lab resolves everything by core hash, so a run
 * can never smuggle in an unadmitted artifact.
 *
 * Admission is independent of any candidate: no method here takes a subject,
 * a capability declaration or a candidate output. Eligibility that consulted
 * declared subject support would be a capability filter, which the design
 * forbids — `assertNoCandidateDerivedEligibility` makes that executable.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import {
  CODES,
  Erl2Error,
  parseStrictJson,
  validateContract,
  type ChallengeManifestV1,
  type Hash,
  type Tier,
} from "@erl2/contracts";
import { coreHash } from "@erl2/integrity";

export interface AdmittedArtifact {
  readonly logicalPath: string;
  readonly coreHash: Hash;
  readonly schemaVersion: string;
  readonly value: Record<string, unknown>;
}

export class AdmissionRegistry {
  private readonly byHash = new Map<string, AdmittedArtifact>();
  readonly root: string;

  private constructor(root: string) {
    this.root = root;
  }

  /** Scans a governor-prepared directory and indexes by recomputed core hash. */
  static open(root: string): AdmissionRegistry {
    const registry = new AdmissionRegistry(path.resolve(root));
    registry.walk(registry.root, "");
    return registry;
  }

  private walk(absolute: string, relative: string): void {
    let entries: string[];
    try {
      entries = readdirSync(absolute);
    } catch {
      return;
    }
    for (const name of entries.sort()) {
      const child = path.join(absolute, name);
      const childRelative = relative === "" ? name : `${relative}/${name}`;
      const st = statSync(child);
      if (st.isDirectory()) {
        this.walk(child, childRelative);
        continue;
      }
      if (!name.endsWith(".json")) continue;
      const value = parseStrictJson(readFileSync(child, "utf8"));
      if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
      const record = value as Record<string, unknown>;
      const schemaVersion = record["schema_version"];
      const declared = record["core_hash"];
      if (typeof schemaVersion !== "string" || typeof declared !== "string") continue;
      const recomputed = coreHash(record);
      if (recomputed !== declared) {
        throw new Erl2Error(
          CODES.ARTIFACT_HASH_MISMATCH,
          `admitted artifact ${childRelative} declares a core_hash its bytes do not produce`,
        );
      }
      this.byHash.set(recomputed, {
        logicalPath: childRelative,
        coreHash: recomputed,
        schemaVersion,
        value: record,
      });
    }
  }

  has(hash: Hash): boolean {
    return this.byHash.has(hash);
  }

  /** Resolves an admitted artifact and validates it against its contract. */
  require<T>(hash: Hash, contractName: string): T {
    const found = this.byHash.get(hash);
    if (!found) {
      throw new Erl2Error(
        CODES.ADMISSION_ARTIFACT_UNKNOWN,
        `no admitted artifact with core hash ${hash}`,
      );
    }
    const result = validateContract(contractName, found.value);
    if (!result.valid) {
      throw new Erl2Error(
        CODES.SCHEMA_VALIDATION_FAILED,
        `admitted artifact ${found.logicalPath} is not a valid ${contractName}`,
        { detail: JSON.stringify(result.problems).slice(0, 4096) },
      );
    }
    return found.value as T;
  }

  /** Resolves an admitted artifact without asserting a contract, or `undefined`. */
  tryGet(hash: Hash): AdmittedArtifact | undefined {
    return this.byHash.get(hash);
  }

  ofSchema(schemaVersion: string): readonly AdmittedArtifact[] {
    return [...this.byHash.values()].filter((a) => a.schemaVersion === schemaVersion);
  }

  all(): readonly AdmittedArtifact[] {
    return [...this.byHash.values()];
  }
}

/**
 * Challenge admission. Nothing here consults a subject: a challenge is
 * admitted because it represents the declared domain, not because a candidate
 * can consume its evidence.
 */
export interface ChallengeAdmissionOptions {
  readonly challenge: ChallengeManifestV1;
  readonly requestedTier: Tier;
  readonly admissibleArchetypeHashes: readonly Hash[];
  readonly currentExposureEpoch: number;
}

export function assertChallengeAdmissible(options: ChallengeAdmissionOptions): void {
  const { challenge } = options;
  if (challenge.domain !== "software_delivery_operations") {
    throw new Erl2Error(
      CODES.ADMISSION_ARTIFACT_UNKNOWN,
      `challenge ${challenge.challenge_id} is outside the declared domain`,
    );
  }
  const archetypeAdmitted = challenge.archetype_hashes.some((h) =>
    options.admissibleArchetypeHashes.includes(h),
  );
  if (!archetypeAdmitted) {
    throw new Erl2Error(
      CODES.ADMISSION_ARTIFACT_UNKNOWN,
      `challenge ${challenge.challenge_id} names no admissible archetype`,
    );
  }
  if (challenge.journey_step_commitment_hashes.length === 0) {
    throw new Erl2Error(
      CODES.ADMISSION_ARTIFACT_UNKNOWN,
      `challenge ${challenge.challenge_id} commits to no journey steps`,
    );
  }
  // A challenge already exposed at this epoch has been demoted and may not be
  // drawn again at a held-out or blind tier.
  if (options.requestedTier !== "development" && challenge.exposure_epoch < options.currentExposureEpoch) {
    throw new Erl2Error(
      CODES.ADMISSION_EXPOSED_CHALLENGE,
      `challenge ${challenge.challenge_id} was exposed before the current epoch`,
    );
  }
}

/**
 * Refuses eligibility that consulted a candidate.
 *
 * `required_domain_capabilities` describes the *domain*, so it is fine. Any
 * reference to a subject id, a capability declaration or a candidate output is
 * a capability filter and fails admission (ERL2-AC-005/AC-019).
 */
export function assertNoCandidateDerivedEligibility(
  eligibilityInputs: readonly { readonly key: string; readonly value: unknown }[],
): void {
  const forbiddenKeys = [
    "subject_id",
    "subject_package_manifest_hash",
    "capability_declaration_hash",
    "declared_support",
    "supported_evidence_kinds",
    "candidate_output_hash",
    "subject_capability",
  ];
  for (const input of eligibilityInputs) {
    if (forbiddenKeys.includes(input.key)) {
      throw new Erl2Error(
        CODES.ADMISSION_CANDIDATE_DERIVED_ELIGIBILITY,
        `eligibility may not depend on ${input.key}; unsupported is a result, not a filter`,
      );
    }
  }
}
