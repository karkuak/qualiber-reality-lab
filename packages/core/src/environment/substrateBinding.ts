/**
 * The permanent run-to-substrate binding (ADR-ERL2-024 §4.2, contract
 * ERL2-C-156).
 *
 * ## What this closes
 *
 * `--substrate-root` was caller-controlled, ungated, and bound into no contract,
 * no receipt and no attestation field. A caller could drive a normal environment
 * walk against substrate A and then run `destroy` and `finalize-generic` against
 * a fresh empty directory B: the driver observed no resources, recorded a clean
 * teardown, the finalizer's own independent residue re-inspection also observed
 * nothing — because it too was inspecting B — and the resulting bundle verified
 * offline at exit 0 while substrate A stayed fully allocated. No retained
 * artifact named the substrate that was observed, so an offline verifier could
 * not detect the substitution at all (review P0-1).
 *
 * ## The shape of the fix
 *
 * A run binds exactly one substrate identity, once, at `provision`, **before**
 * the first substrate-affecting dispatch. Every later phase re-derives the
 * identity from the substrate it is about to talk to and refuses if it is not
 * the bound one.
 *
 * The identity is `substrate_instance_hash`, a value the substrate carries
 * *inside itself* (see `substrate.ts`). A raw path is not an identity: it is
 * deployment-local, unverifiable offline, and unchanged when the directory is
 * emptied and rebuilt. The path is kept privately, as an operational locator,
 * and never appears in signed evidence.
 */

import {
  assertContract,
  CODES,
  Erl2Error,
  type EnvironmentDriverManifestV1,
  type Hash,
  type Instant,
  type SubstrateBindingV1,
} from "@erl2/contracts";
import { coreHash, domainHash, HASH_DOMAINS, sealSigned, type SigningKey } from "@erl2/integrity";
import type { EnvironmentDriver } from "./driver.js";

/**
 * The reservation namespace a run's leases live in.
 *
 * Bound because it is the *other* caller-supplied root: redirecting
 * `--reservation-root` at teardown would let a run release leases it never held
 * and leave the real ones allocated, which is the same substitution shape one
 * layer over.
 */
export function reservationNamespaceHash(reservationRoot: string): Hash {
  return domainHash(HASH_DOMAINS.DRIVER_STATE, {
    namespace: "erl2-reservation-allocator",
    locator: reservationRoot,
  });
}

export interface BuildSubstrateBindingInput {
  readonly runId: string;
  readonly driverManifest: EnvironmentDriverManifestV1;
  readonly archetypeHash: Hash;
  readonly substrateKind: string;
  readonly substrateInstanceHash: Hash;
  readonly reservationNamespaceHash: Hash;
  readonly substrateLockHash?: Hash;
  readonly boundAt: Instant;
  readonly signingKey: SigningKey;
}

/**
 * Builds and seals the binding.
 *
 * Signed by the **environment governor**, never by the driver: the governor is
 * the authority that provisions the environment, and a binding signed by the
 * thing being bound proves nothing (ADR-ERL2-023 §2a's direction of trust,
 * applied one level down).
 */
export function buildSubstrateBinding(input: BuildSubstrateBindingInput): SubstrateBindingV1 {
  const body = {
    schema_version: "substrate-binding/v1" as const,
    binding_id: `substrate-${input.runId.slice(0, 8)}`,
    run_id: input.runId,
    driver_id: input.driverManifest.driver_id,
    driver_manifest_hash: coreHash(input.driverManifest),
    archetype_hash: input.archetypeHash,
    substrate_kind: input.substrateKind,
    substrate_instance_hash: input.substrateInstanceHash,
    reservation_namespace_hash: input.reservationNamespaceHash,
    ...(input.substrateLockHash === undefined ? {} : { substrate_lock_hash: input.substrateLockHash }),
    bound_at: input.boundAt,
  };
  return assertContract<SubstrateBindingV1>(
    "SubstrateBindingV1",
    sealSigned(body, input.signingKey),
  );
}

export interface AssertBindingInput {
  readonly binding: SubstrateBindingV1;
  readonly runId: string;
  readonly driver: EnvironmentDriver;
  readonly archetypeHash: Hash;
  readonly reservationNamespaceHash: Hash;
  /**
   * True when the run's lifecycle says an environment was provisioned. The
   * substrate must then also know it: a substrate that reports "never
   * provisioned for this run" while the lifecycle says otherwise is either a
   * substitution or a destroyed substrate, and either way a teardown against it
   * would be a clean report over resources it never looked at.
   */
  readonly expectProvisioned: boolean;
}

/**
 * Refuses a phase whose substrate is not the one this run bound.
 *
 * Called at the top of every environment phase that will reach the driver,
 * **before** any dispatch and before any freeze — the same placement
 * ADR-ERL2-019 §4 already requires for departure-state validation.
 */
export function assertSubstrateBinding(input: AssertBindingInput): void {
  const { binding } = input;
  if (binding.run_id !== input.runId) {
    throw new Erl2Error(
      CODES.ENV_SUBSTRATE_BINDING_MISMATCH,
      `the retained substrate binding belongs to run ${binding.run_id}, not ${input.runId}`,
      { owner: "lab" },
    );
  }

  const observed = input.driver.substrateInstance();
  if (observed === undefined) {
    // The P0-1 exploit lands exactly here: a fresh empty substrate has no
    // identity to offer, so it can never satisfy a binding.
    throw new Erl2Error(
      CODES.ENV_SUBSTRATE_BINDING_MISSING,
      `this run is bound to substrate ${binding.substrate_instance_hash}, but the substrate ` +
        `this command reached carries no identity at all; a fresh or foreign substrate cannot ` +
        `stand in for the one the run provisioned`,
      { owner: "lab" },
    );
  }
  if (observed.instanceHash !== binding.substrate_instance_hash) {
    throw new Erl2Error(
      CODES.ENV_SUBSTRATE_BINDING_MISMATCH,
      `this run is bound to substrate ${binding.substrate_instance_hash}; the substrate this ` +
        `command reached is ${observed.instanceHash}`,
      { owner: "lab" },
    );
  }
  if (observed.kind !== binding.substrate_kind) {
    throw new Erl2Error(
      CODES.ENV_SUBSTRATE_BINDING_MISMATCH,
      `this run is bound to a ${binding.substrate_kind} substrate; it reached a ${observed.kind}`,
      { owner: "lab" },
    );
  }

  const manifestHash = coreHash(input.driver.manifest);
  if (input.driver.manifest.driver_id !== binding.driver_id) {
    throw new Erl2Error(
      CODES.ENV_SUBSTRATE_BINDING_MISMATCH,
      `this run bound driver ${binding.driver_id}; this command holds ${input.driver.manifest.driver_id}`,
      { owner: "lab" },
    );
  }
  if (manifestHash !== binding.driver_manifest_hash) {
    throw new Erl2Error(
      CODES.ENV_SUBSTRATE_BINDING_MISMATCH,
      "the driver manifest this command holds is not the one the run bound",
      { owner: "lab" },
    );
  }
  if (input.archetypeHash !== binding.archetype_hash) {
    throw new Erl2Error(
      CODES.ENV_SUBSTRATE_BINDING_MISMATCH,
      "the archetype this command resolved is not the one the run bound",
      { owner: "lab" },
    );
  }
  if (input.reservationNamespaceHash !== binding.reservation_namespace_hash) {
    throw new Erl2Error(
      CODES.ENV_SUBSTRATE_BINDING_MISMATCH,
      "the reservation namespace this command resolved is not the one the run bound",
      { owner: "lab" },
    );
  }

  if (input.expectProvisioned && input.driver.inspect(input.runId).resources.length === 0) {
    // Not conclusive on its own — a legitimately torn-down environment is also
    // empty — so callers pass `expectProvisioned` only while the run's own
    // lifecycle still says resources should exist.
    throw new Erl2Error(
      CODES.ENV_SUBSTRATE_NOT_PROVISIONED,
      `this run's lifecycle records a provisioned environment, but the bound substrate reports ` +
        `no resources for it; a cleanup verdict derived from this observation would be a clean ` +
        `report over an environment nobody looked at`,
      { owner: "lab" },
    );
  }
}
