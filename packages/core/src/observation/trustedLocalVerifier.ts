/**
 * Offline verification of a retained trusted-local observation.
 *
 * ## What "verify" has to mean here
 *
 * The previous verifier checked that the hashes inside a record were internally
 * consistent. That is a weaker property than it sounds: an attacker who edits a
 * record can also recompute every hash inside it, and an independent review
 * demonstrated exactly that — a changed run identity, a plan replaced with one
 * from another observation, a plan with two operations retained with one
 * outcome, a terminal status flipped, a cleanup upgraded to clean, and an
 * adapter-written `{verdict: "valid"}` all passed.
 *
 * So this module does not check that the record agrees with itself. It rebuilds
 * the run's story from the plan bytes and the retained admission, and compares
 * that reconstruction against the record. A resealed forgery survives only if
 * the attacker can also make the plan produce the operations they claim ran,
 * which is the property the plan hash exists to prevent.
 *
 * ## Independence from the producer
 *
 * This module shares schema definitions, `coreHash`/`hashBytes`, and pure type
 * guards with the runner. It calls no function that produced any part of the
 * record's verdict: it does not build a coordinator, does not call
 * `buildResult`, and does not ask the runner what the terminal status should
 * have been. The cleanup and terminal recomputation below are a second,
 * independent implementation of the same rules, which is the point — a shared
 * implementation would agree with the producer even when the producer was
 * wrong.
 *
 * ## Why plan bytes are mandatory
 *
 * Without them the record's `plan_hash` is a number nobody can check, and the
 * previous verifier accepted a cross-plan replay for exactly that reason. There
 * is no mode of this function that runs without the plan.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import {
  CODES,
  Erl2Error,
  LOCAL_OBSERVATION_UNSUPPORTED_CLAIMS,
  assertContract,
  parseStrictJson,
  validateContract,
  type Hash,
  type LocalCleanupResultV1,
  type LocalObservationOperationRecordV1,
  type LocalObservationTrustedLocalPlanV1,
  type SubjectAdapterManifestV2,
  type TrustedLocalAdapterDeclarationV1,
  type TrustedLocalObservationRecordV1,
} from "@erl2/contracts";
import { coreHash, hashBytes } from "@erl2/integrity";

import {
  TRUSTED_LOCAL_ADAPTER_DIR,
  TRUSTED_LOCAL_DECLARATION_FILE,
  TRUSTED_LOCAL_MANIFEST_FILE,
  assertRegularFile,
} from "../adapter/trustedLocalRegistry.js";
import { compactPredecessorOf } from "./ancestry.js";

/**
 * Ceiling for a retained record, checked before it is parsed.
 *
 * A record holds a bounded plan's worth of operations and their hashes. The
 * previous verifier accepted a 2.1 MiB record with an unknown field, because
 * it parsed first and validated later; here the length of the buffer is the
 * first thing examined and an oversized file never reaches `JSON.parse`.
 */
export const MAX_TRUSTED_LOCAL_RECORD_BYTES = 4 * 1024 * 1024;

export const MAX_TRUSTED_LOCAL_PLAN_BYTES = 1024 * 1024;

export interface TrustedLocalVerification {
  readonly ok: boolean;
  /** Every refusal found, so one pass reports the whole picture. */
  readonly refusals: readonly string[];
  /** What the record is, when it verified. Absent on refusal. */
  readonly verified?: {
    readonly observationId: string;
    readonly planHash: Hash;
    readonly adapterArtifactHash: Hash;
    readonly declarationHash: Hash;
    readonly trustMode: "trusted_local_code";
    readonly terminalStatus: string;
    readonly independentCertification: "absent";
    readonly confinement: "absent";
  };
}

export interface VerifyTrustedLocalRecordInput {
  readonly recordBytes: Buffer;
  /** Mandatory. There is no verification of a plan nobody can read. */
  readonly planBytes: Buffer;
  readonly registryRoot: string;
  readonly adapterEntryPath: string;
}

export function verifyTrustedLocalObservationRecord(
  input: VerifyTrustedLocalRecordInput,
): TrustedLocalVerification {
  const refusals: string[] = [];
  const refuse = (message: string): void => {
    refusals.push(message);
  };

  // ---- 0. bounds, before any parse ----------------------------------------
  if (input.recordBytes.byteLength > MAX_TRUSTED_LOCAL_RECORD_BYTES) {
    return {
      ok: false,
      refusals: [
        `retained record is ${input.recordBytes.byteLength} bytes, above the ` +
          `${MAX_TRUSTED_LOCAL_RECORD_BYTES}-byte ceiling`,
      ],
    };
  }
  if (input.planBytes.byteLength === 0) {
    return { ok: false, refusals: ["plan bytes are required and were empty"] };
  }
  if (input.planBytes.byteLength > MAX_TRUSTED_LOCAL_PLAN_BYTES) {
    return {
      ok: false,
      refusals: [
        `plan is ${input.planBytes.byteLength} bytes, above the ` +
          `${MAX_TRUSTED_LOCAL_PLAN_BYTES}-byte ceiling`,
      ],
    };
  }

  // ---- 1. closed-schema validation of both documents ----------------------
  let record: TrustedLocalObservationRecordV1;
  let plan: LocalObservationTrustedLocalPlanV1;
  try {
    record = assertContract<TrustedLocalObservationRecordV1>(
      "TrustedLocalObservationRecordV1",
      parseJson(input.recordBytes, "retained record"),
    );
  } catch (cause) {
    return { ok: false, refusals: [describe(cause, "retained record is not a closed trusted-local record")] };
  }
  try {
    plan = assertContract<LocalObservationTrustedLocalPlanV1>(
      "LocalObservationTrustedLocalPlanV1",
      parseJson(input.planBytes, "plan"),
    );
  } catch (cause) {
    return { ok: false, refusals: [describe(cause, "plan is not a closed trusted-local observation plan")] };
  }

  // ---- 2. the plan, recomputed from its own bytes -------------------------
  const planFileHash = hashBytes(input.planBytes);
  const planCoreHash = coreHash(plan);
  if (planCoreHash !== plan.core_hash) refuse("the plan's own core hash is stale");
  if (record.plan_file_hash !== planFileHash) {
    refuse("the record names plan file bytes that are not the plan supplied");
  }
  if (record.plan_hash !== planCoreHash) {
    refuse("the record's plan hash is not the hash of the plan supplied");
  }
  if (record.result.plan_hash !== planCoreHash) {
    refuse("the result's plan hash is not the hash of the plan supplied");
  }

  // ---- 3. run identity, recomputed rather than read -----------------------
  // The record, its result and the plan must all name one observation. A
  // resealed record that changed its run id has to change the plan too, and
  // the plan hash above is what makes that impossible.
  if (
    record.observation_id !== plan.observation_id ||
    record.result.observation_id !== plan.observation_id
  ) {
    refuse("the record's run id is not the run id the plan froze");
  }

  // ---- 4. the retained admission ------------------------------------------
  const admission = readRetainedAdmission(input.registryRoot, record, refuse);
  if (admission !== undefined) {
    verifyAdmissionBinding(record, plan, admission, input.adapterEntryPath, refuse);
  }

  // ---- 5. the operation chain, rebuilt from the plan ----------------------
  verifyOperationStory(record, plan, refuse);

  // ---- 6. cleanup and terminal, recomputed independently ------------------
  verifyCleanupAndTerminal(record, plan, refuse);

  // ---- 7. the claim ceiling and the trust labels --------------------------
  verifyClaimCeiling(record, refuse);

  // ---- 8. the record's own core hash, last --------------------------------
  // Last deliberately: an outer hash that matches proves only that the forger
  // recomputed it, so it is the least informative check here and must never be
  // the one that carries the verdict.
  if (coreHash(stripCoreHash(record)) !== record.core_hash) {
    refuse("the record's own core hash is stale");
  }
  if (coreHash(stripCoreHash(record.result)) !== record.result.core_hash) {
    refuse("the result's own core hash is stale");
  }

  if (refusals.length > 0) return { ok: false, refusals };
  return {
    ok: true,
    refusals: [],
    verified: {
      observationId: record.observation_id,
      planHash: record.plan_hash,
      adapterArtifactHash: record.adapter_artifact_hash,
      declarationHash: record.trusted_local_declaration_hash,
      trustMode: record.trust_mode,
      terminalStatus: record.terminal_status,
      independentCertification: record.independent_certification,
      confinement: record.confinement,
    },
  };
}

/** Reads the admission the record says it ran under, from retained bytes. */
function readRetainedAdmission(
  registryRoot: string,
  record: TrustedLocalObservationRecordV1,
  refuse: (message: string) => void,
):
  | {
      readonly manifest: SubjectAdapterManifestV2;
      readonly declaration: TrustedLocalAdapterDeclarationV1;
      readonly manifestFileHash: Hash;
      readonly declarationFileHash: Hash;
    }
  | undefined {
  const dir = path.join(
    path.resolve(registryRoot),
    TRUSTED_LOCAL_ADAPTER_DIR,
    record.adapter_manifest_hash.replace("sha256:", ""),
  );
  try {
    const manifestBytes = readFileSync(
      assertRegularFile(path.join(dir, TRUSTED_LOCAL_MANIFEST_FILE), "retained manifest"),
    );
    const declarationBytes = readFileSync(
      assertRegularFile(path.join(dir, TRUSTED_LOCAL_DECLARATION_FILE), "retained declaration"),
    );
    return {
      manifest: assertContract<SubjectAdapterManifestV2>(
        "SubjectAdapterManifestV2",
        parseJson(manifestBytes, "retained manifest"),
      ),
      declaration: assertContract<TrustedLocalAdapterDeclarationV1>(
        "TrustedLocalAdapterDeclarationV1",
        parseJson(declarationBytes, "retained declaration"),
      ),
      manifestFileHash: hashBytes(manifestBytes),
      declarationFileHash: hashBytes(declarationBytes),
    };
  } catch (cause) {
    refuse(describe(cause, "the retained admission could not be read and validated"));
    return undefined;
  }
}

function verifyAdmissionBinding(
  record: TrustedLocalObservationRecordV1,
  plan: LocalObservationTrustedLocalPlanV1,
  admission: {
    readonly manifest: SubjectAdapterManifestV2;
    readonly declaration: TrustedLocalAdapterDeclarationV1;
    readonly manifestFileHash: Hash;
    readonly declarationFileHash: Hash;
  },
  adapterEntryPath: string,
  refuse: (message: string) => void,
): void {
  const { manifest, declaration } = admission;
  const manifestHash = coreHash(manifest);
  const declarationHash = coreHash(declaration);

  if (manifestHash !== manifest.core_hash) refuse("the retained manifest's core hash is stale");
  if (declarationHash !== declaration.core_hash) {
    refuse("the retained declaration's core hash is stale");
  }
  if (record.adapter_manifest_hash !== manifestHash) {
    refuse("the record names a manifest hash the retained manifest does not have");
  }
  if (record.adapter_manifest_file_hash !== admission.manifestFileHash) {
    refuse("the record names manifest file bytes the registry does not hold");
  }
  if (record.trusted_local_declaration_hash !== declarationHash) {
    refuse("the record names a declaration hash the retained declaration does not have");
  }
  if (record.trusted_local_declaration_file_hash !== admission.declarationFileHash) {
    refuse("the record names declaration file bytes the registry does not hold");
  }
  // The record embeds the declaration as well as naming it. Both must be the
  // same document, or a reader of the record alone sees different terms than
  // the run was admitted under.
  if (coreHash(record.trusted_local_declaration) !== declarationHash) {
    refuse("the declaration embedded in the record is not the declaration that was retained");
  }

  // Declaration-to-artifact and declaration-to-manifest binding, recomputed.
  if (
    declaration.adapter_artifact_hash !== manifest.adapter_artifact_hash ||
    record.adapter_artifact_hash !== manifest.adapter_artifact_hash ||
    plan.adapter_artifact_hash !== manifest.adapter_artifact_hash
  ) {
    refuse("the manifest, declaration, plan and record do not agree on one artifact digest");
  }
  if (declaration.adapter_manifest_core_hash !== manifestHash) {
    refuse("the declaration is bound to a different manifest than the one retained");
  }
  if (declaration.adapter_manifest_file_hash !== admission.manifestFileHash) {
    refuse("the declaration is bound to different manifest file bytes than the ones retained");
  }
  if (
    declaration.operator_acknowledgement.acknowledged_artifact_hash !==
      declaration.adapter_artifact_hash ||
    declaration.operator_acknowledgement.acknowledged_manifest_core_hash !== manifestHash
  ) {
    refuse("the operator acknowledged different bytes than the declaration binds");
  }
  if (plan.trusted_local_declaration_hash !== declarationHash) {
    refuse("the plan is bound to a different declaration than the one retained");
  }
  if (record.result.trusted_local_declaration_hash !== declarationHash) {
    refuse("the result is bound to a different declaration than the one retained");
  }

  // The artifact on disk, now.
  try {
    const observed = hashBytes(readFileSync(assertRegularFile(adapterEntryPath, "adapter entry")));
    if (observed !== record.adapter_artifact_hash) {
      refuse("the adapter entry's bytes are no longer the bytes this observation ran");
    }
  } catch (cause) {
    refuse(describe(cause, "the adapter entry could not be re-hashed"));
  }
}

/**
 * Rebuilds the exact ordered operation story the plan requires and compares.
 *
 * This is where the previous verifier's gap was. It checked each operation
 * record's own core hash and stopped; it never asked whether the operations
 * present were the operations the plan named, in the plan's order, exactly
 * once each, chained to one another.
 */
function verifyOperationStory(
  record: TrustedLocalObservationRecordV1,
  plan: LocalObservationTrustedLocalPlanV1,
  refuse: (message: string) => void,
): void {
  const outcomes = record.operation_outcomes;

  // Every operation the plan names must have exactly one outcome, in order.
  // A plan with two operations and one retained outcome is refused here.
  const planned = plan.operations;
  const reachable = reachableOperations(planned, outcomes);
  if (outcomes.length !== reachable.length) {
    refuse(
      `the plan reaches ${reachable.length} operations and the record retains ${outcomes.length} outcomes`,
    );
    return;
  }
  const seen = new Set<string>();
  for (const [index, outcome] of outcomes.entries()) {
    const spec = reachable[index];
    if (spec === undefined) {
      refuse(`outcome ${index} has no operation in the plan`);
      continue;
    }
    if (outcome.operation_id !== spec.operation_id || outcome.operation !== spec.operation) {
      refuse(
        `outcome ${index} reports ${outcome.operation_id}/${outcome.operation} where the plan has ` +
          `${spec.operation_id}/${spec.operation}`,
      );
    }
    if (outcome.sequence !== spec.sequence) {
      refuse(`outcome for ${outcome.operation_id} reports sequence ${outcome.sequence}, plan says ${spec.sequence}`);
    }
    if (seen.has(outcome.operation_id)) {
      refuse(`operation ${outcome.operation_id} appears more than once in the retained outcomes`);
    }
    seen.add(outcome.operation_id);
  }

  // Every outcome must be backed by a retained operation record whose own core
  // hash recomputes, whose request hash matches, and which belongs to this
  // plan and this run.
  const byHash = new Map<Hash, LocalObservationOperationRecordV1>();
  for (const operationRecord of record.operation_records) {
    if (coreHash(stripCoreHash(operationRecord)) !== operationRecord.core_hash) {
      refuse(`operation record ${operationRecord.operation_id} has a stale core hash`);
      continue;
    }
    if (operationRecord.observation_id !== plan.observation_id) {
      refuse(`operation record ${operationRecord.operation_id} belongs to another run`);
    }
    if (operationRecord.plan_hash !== plan.core_hash) {
      refuse(`operation record ${operationRecord.operation_id} belongs to another plan`);
    }
    byHash.set(operationRecord.core_hash, operationRecord);
  }

  // The chain. Each outcome's predecessor must be the compact form of the
  // operation record the previous outcome names — derived here, not read.
  let previous: LocalObservationOperationRecordV1 | undefined;
  for (const outcome of outcomes) {
    const terminal = byHash.get(outcome.operation_record_hash);
    if (terminal === undefined) {
      refuse(`outcome for ${outcome.operation_id} names an operation record the run did not retain`);
      previous = undefined;
      continue;
    }
    if (terminal.operation_id !== outcome.operation_id || terminal.state !== outcome.state) {
      refuse(`outcome for ${outcome.operation_id} disagrees with its own operation record`);
    }
    if (terminal.request_hash !== outcome.request_hash) {
      refuse(`outcome for ${outcome.operation_id} names a request the record does not`);
    }
    if (
      terminal.state === "completed" &&
      outcome.response_envelope_hash !== terminal.response_envelope_hash
    ) {
      refuse(`outcome for ${outcome.operation_id} names a response envelope the record does not`);
    }
    if (
      terminal.state === "completed" &&
      outcome.response_status !== terminal.response_status
    ) {
      refuse(`outcome for ${outcome.operation_id} reports a response status the record does not`);
    }
    if (previous === undefined) {
      if (outcome.predecessor_operation_record_hash !== undefined) {
        refuse(`outcome for ${outcome.operation_id} claims a predecessor but is first`);
      }
    } else {
      const expected = compactPredecessorOf(previous);
      if (
        outcome.predecessor_operation_id !== expected.operation_id ||
        outcome.predecessor_operation_record_hash !== expected.operation_record_hash
      ) {
        refuse(
          `outcome for ${outcome.operation_id} is not chained to the operation that ran before it`,
        );
      }
    }
    previous = terminal;
  }

  // The result's own operation-record list must be exactly the records
  // retained, in order.
  const retainedHashes = record.operation_records.map((entry) => entry.core_hash);
  if (
    record.result.operation_record_hashes.length !== retainedHashes.length ||
    record.result.operation_record_hashes.some((hash, index) => hash !== retainedHashes[index])
  ) {
    refuse("the result's operation-record hashes are not the records the run retained");
  }
}

/**
 * Which planned operations a run was allowed to reach.
 *
 * A plan's cleanup suffix runs after a main-sequence failure and the remaining
 * main-sequence operations do not. So "every planned operation must have an
 * outcome" is too strong, and "however many outcomes exist is fine" is far too
 * weak — that is the hole the plan-with-two-operations-and-one-outcome forgery
 * went through. The rule is: every main-sequence operation up to and including
 * the first non-completed one, then every cleanup operation.
 */
function reachableOperations(
  planned: LocalObservationTrustedLocalPlanV1["operations"],
  outcomes: TrustedLocalObservationRecordV1["operation_outcomes"],
): LocalObservationTrustedLocalPlanV1["operations"] {
  const stateOf = new Map(outcomes.map((outcome) => [outcome.operation_id, outcome]));
  const main = planned.filter((spec) => !spec.cleanup);
  const cleanup = planned.filter((spec) => spec.cleanup);
  const reached: typeof main = [];
  for (const spec of main) {
    reached.push(spec);
    const outcome = stateOf.get(spec.operation_id);
    // A main-sequence operation that did not complete stops the main sequence.
    // An operation with no outcome at all also stops it — and then the count
    // comparison in the caller refuses, because this one is still counted.
    if (outcome === undefined || outcome.state !== "completed") break;
  }
  return [...reached, ...cleanup];
}

/**
 * Recomputes cleanup and the terminal status from the operation outcomes.
 *
 * A second implementation of the reducer's rules, deliberately. The two rules
 * that carry it are the same two the reducer states: an operation "succeeded"
 * only when its record completed *and* the adapter's envelope said `supported`,
 * and residue comes from a validated final residue report and nowhere else.
 */
function verifyCleanupAndTerminal(
  record: TrustedLocalObservationRecordV1,
  plan: LocalObservationTrustedLocalPlanV1,
  refuse: (message: string) => void,
): void {
  const outcomes = record.operation_outcomes;
  const succeeded = (operation: string): boolean =>
    outcomes.some(
      (outcome) =>
        outcome.operation === operation &&
        outcome.state === "completed" &&
        outcome.response_status === "supported",
    );
  const unsuccessful = (operation: string): boolean =>
    outcomes.some(
      (outcome) =>
        outcome.operation === operation &&
        (outcome.state !== "completed" || outcome.response_status !== "supported"),
    );

  // Residue: from the final checkpoint's report, or `not_observed`. There is
  // deliberately no branch that derives clean from operations having ended,
  // which is exactly the upgrade the previous verifier accepted.
  const finalResiduePlanned = plan.operations.some(
    (spec) =>
      spec.operation === "report-residue" &&
      (spec.payload as { readonly checkpoint?: string }).checkpoint === "final",
  );
  const finalResidue = record.residue_observations.find(
    (observation) => observation.checkpoint === "final",
  );
  const residue: LocalCleanupResultV1["residue"] =
    finalResidue === undefined
      ? "not_observed"
      : finalResidue.status === "clean"
        ? "observed_clean"
        : finalResidue.status === "residue_detected"
          ? "residue_detected"
          : "not_observed";
  if (record.cleanup.residue !== residue) {
    refuse(
      `the record reports residue ${record.cleanup.residue}; the retained observations support ${residue}`,
    );
  }

  // A residue observation the record claims must also appear in the operation
  // record that produced it. Two representations of one fact have to agree, or
  // the record is quoting a report that never came back.
  for (const observation of record.residue_observations) {
    const backed = record.operation_records.some(
      (entry) =>
        entry.state === "completed" &&
        entry.residue_observation !== undefined &&
        coreHash(entry.residue_observation) === coreHash(observation),
    );
    if (!backed) {
      refuse(
        `the record reports a ${observation.checkpoint} residue observation no operation record contains`,
      );
    }
  }

  const needsStop = succeeded("start");
  const needsUninstall = succeeded("install");
  const complete =
    (!needsStop || succeeded("stop")) &&
    (!needsUninstall || succeeded("uninstall")) &&
    (!finalResiduePlanned || residue === "observed_clean") &&
    !outcomes.some((outcome) => outcome.state === "ambiguous_not_replayed") &&
    !(needsStop && unsuccessful("stop")) &&
    !(needsUninstall && unsuccessful("uninstall"));
  const expectedCleanupStatus = complete ? "cleanup_complete" : "cleanup_incomplete";
  if (record.cleanup.status !== expectedCleanupStatus) {
    refuse(
      `the record reports ${record.cleanup.status}; the retained outcomes support ${expectedCleanupStatus}`,
    );
  }

  const expectedTerminal = complete ? "observed_complete" : "cleanup_incomplete";
  if (record.terminal_status !== expectedTerminal) {
    refuse(
      `the record's terminal status is ${record.terminal_status}; the retained outcomes support ${expectedTerminal}`,
    );
  }
  if (record.result.status !== record.terminal_status) {
    refuse("the result's status and the record's terminal status disagree");
  }
  if (coreHash(record.result.cleanup) !== coreHash(record.cleanup)) {
    refuse("the result's cleanup and the record's cleanup are two different documents");
  }
}

/** The claims a trusted-local record may never make about itself. */
function verifyClaimCeiling(
  record: TrustedLocalObservationRecordV1,
  refuse: (message: string) => void,
): void {
  if (record.trust_mode !== "trusted_local_code" || record.tier !== "development") {
    refuse("the record does not describe an owner-operated development observation");
  }
  if (record.independent_certification !== "absent") {
    refuse("the record claims independent certification, which this path never produces");
  }
  if (record.confinement !== "absent") {
    refuse("the record claims confinement, which this path never provides");
  }
  if (
    record.not_scored !== true ||
    record.not_governor_authorized !== true ||
    record.not_authenticated !== true ||
    record.not_production_ready !== true ||
    record.evidence_authenticity !== "unauthenticated_local_record"
  ) {
    refuse("the record does not restate the full trusted-local claim ceiling");
  }
  if (
    record.result.not_independently_certified !== true ||
    record.result.not_confined !== true ||
    record.result.not_scored !== true ||
    record.result.not_governor_authorized !== true
  ) {
    refuse("the result does not restate the full trusted-local claim ceiling");
  }
  const claims = record.excluded_claims;
  if (
    claims.length !== LOCAL_OBSERVATION_UNSUPPORTED_CLAIMS.length ||
    claims.some((claim, index) => claim !== LOCAL_OBSERVATION_UNSUPPORTED_CLAIMS[index])
  ) {
    refuse("the record's excluded claims are not the closed local claim ceiling");
  }
  const declaration = record.trusted_local_declaration;
  if (
    declaration.independent_certifier !== null ||
    declaration.certifier_is_adapter_owner !== "not_applicable" ||
    declaration.not_confined !== true ||
    declaration.not_independently_certified !== true ||
    declaration.evidence_authenticity !== "owner_asserted_unauthenticated"
  ) {
    refuse("the embedded declaration claims more than an owner assertion can support");
  }
  // The declaration must still validate on its own, so a record cannot embed a
  // document the contract would refuse if it were presented alone.
  if (!validateContract("TrustedLocalAdapterDeclarationV1", declaration).valid) {
    refuse("the embedded declaration is not a valid trusted-local declaration");
  }
}

function stripCoreHash(value: object): Record<string, unknown> {
  const copy = { ...(value as Record<string, unknown>) };
  delete copy["core_hash"];
  return copy;
}

function parseJson(bytes: Buffer, label: string): unknown {
  let value: unknown;
  try {
    value = parseStrictJson(bytes.toString("utf8"));
  } catch (cause) {
    if (cause instanceof Erl2Error) throw cause;
    throw new Erl2Error(CODES.SCHEMA_VALIDATION_FAILED, `${label} is not valid JSON`, { cause });
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Erl2Error(CODES.SCHEMA_VALIDATION_FAILED, `${label} must be a JSON object`);
  }
  return value;
}

function describe(cause: unknown, fallback: string): string {
  if (cause instanceof Erl2Error) return `${fallback}: ${cause.code} ${cause.message}`;
  return fallback;
}
