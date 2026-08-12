/**
 * Minimal local-observation reducer (ADR-ERL2-037).
 *
 * This module owns only immutable cursor transitions. AdapterHost remains the
 * sole process boundary and the existing host remains the sole owner of
 * mutation, evidence, diagnostics and output freezing.
 */
import {
  ADAPTER_LOCAL_EXECUTION_MODE,
  CODES,
  Erl2Error,
  assertContract,
  assertLocalObservationClaimExclusions,
  assertNoLocalObservationGovernedFields,
  type AdapterOperation,
  type AdapterRequestV2,
  type Hash,
  type Instant,
  type LocalCleanupResultV1,
  type LocalInputArtifactRefV1,
  type LocalObservationOperationRecordV1,
  type LocalObservationPlanV1,
  type LocalObservationResultV1,
} from "@erl2/contracts";
import { coreHash } from "@erl2/integrity";
import { AdapterHost, type LocalAdapterOperationResult } from "../adapter/host.js";

const EFFECTFUL = new Set<AdapterOperation>([
  "acquire",
  "install",
  "configure",
  "start",
  "interact",
  "stop",
  "uninstall",
  "compensate",
]);

type TerminalRecord = Extract<
  LocalObservationOperationRecordV1,
  { readonly state: "completed" | "failed" | "ambiguous_not_replayed" }
>;

export class LocalObservationCoordinator {
  readonly plan: LocalObservationPlanV1;
  private readonly records: LocalObservationOperationRecordV1[] = [];
  private readonly currentByOperation = new Map<string, LocalObservationOperationRecordV1>();
  private cleanupOnly = false;
  private outputFrozen = false;

  constructor(plan: LocalObservationPlanV1) {
    this.plan = assertContract<LocalObservationPlanV1>("LocalObservationPlanV1", plan);
    if (coreHash(plan) !== plan.core_hash) {
      throw new Erl2Error(CODES.ARTIFACT_HASH_MISMATCH, "local observation plan core hash is stale");
    }
    assertNoLocalObservationGovernedFields(plan);
    assertLocalObservationClaimExclusions(plan);
    assertPlanSequence(plan);
  }

  get operationRecords(): readonly LocalObservationOperationRecordV1[] {
    return [...this.records];
  }

  declare(request: AdapterRequestV2, at: Instant): LocalObservationOperationRecordV1 {
    const parsed = this.assertDispatchable(request);
    const existing = this.currentByOperation.get(parsed.operation_id);
    if (existing !== undefined) {
      if (existing.request_hash !== parsed.core_hash) {
        throw new Erl2Error(
          CODES.ADAPTER_LOCAL_REPLAY_CONFLICT,
          `operation id ${parsed.operation_id} was already declared for different request bytes`,
        );
      }
      return existing;
    }
    const spec = this.plan.operations.find((operation) => operation.operation_id === parsed.operation_id);
    const previous = this.records.at(-1);
    const base = {
      schema_version: "local-observation-operation-record/v1" as const,
      state: "declared" as const,
      observation_id: this.plan.observation_id,
      plan_hash: this.plan.core_hash,
      operation_id: parsed.operation_id,
      operation: parsed.operation,
      sequence: parsed.ancestry.sequence,
      request_hash: parsed.core_hash,
      ...(previous === undefined ? {} : { prior_record_hash: previous.core_hash }),
      idempotency_key: coreHash({
        observation_id: this.plan.observation_id,
        operation_id: parsed.operation_id,
        request_hash: parsed.core_hash,
      }).slice("sha256:".length),
      cleanup_eligible: spec?.cleanup ?? false,
      declared_at: at,
      evidence_authenticity: "unauthenticated_local_record" as const,
    };
    return this.append({ ...base, core_hash: coreHash(base) });
  }

  markDispatched(operationId: string, at: Instant): LocalObservationOperationRecordV1 {
    const declared = this.currentByOperation.get(operationId);
    if (declared?.state !== "declared") {
      throw new Erl2Error(
        CODES.ADAPTER_LOCAL_OPERATION_ORDER_INVALID,
        `operation ${operationId} must be declared before dispatch`,
      );
    }
    const base = {
      schema_version: "local-observation-operation-record/v1" as const,
      state: "dispatched" as const,
      observation_id: declared.observation_id,
      plan_hash: declared.plan_hash,
      operation_id: declared.operation_id,
      operation: declared.operation,
      sequence: declared.sequence,
      request_hash: declared.request_hash,
      declared_record_hash: declared.core_hash,
      cleanup_eligible: declared.cleanup_eligible,
      dispatched_at: at,
      evidence_authenticity: "unauthenticated_local_record" as const,
    };
    return this.append({ ...base, core_hash: coreHash(base) });
  }

  complete(
    operationId: string,
    result: LocalAdapterOperationResult,
    startedAt: Instant,
    endedAt: Instant,
    inputRefs: readonly LocalInputArtifactRefV1[] = [],
  ): TerminalRecord {
    const dispatched = this.dispatched(operationId);
    const base = {
      schema_version: "local-observation-operation-record/v1" as const,
      state: "completed" as const,
      observation_id: dispatched.observation_id,
      plan_hash: dispatched.plan_hash,
      operation_id: dispatched.operation_id,
      operation: dispatched.operation,
      sequence: dispatched.sequence,
      request_hash: dispatched.request_hash,
      dispatched_record_hash: dispatched.core_hash,
      response_envelope_hash: result.envelope.core_hash,
      sandbox_manifest_hash: result.sandboxManifest.core_hash,
      sandbox_result_hash: result.sandboxResult.core_hash,
      diagnostics_manifest_hash: result.diagnostics.core_hash,
      mutation_receipt_hashes: result.mutationReceipts.map((receipt) => receipt.core_hash),
      compensation_receipt_hashes: result.compensationReceipts.map((receipt) => receipt.core_hash),
      retained_input_refs: [...inputRefs],
      retained_output_refs: [...result.retained.outputRefs],
      cleanup_eligible: dispatched.cleanup_eligible,
      started_at: startedAt,
      ended_at: endedAt,
      evidence_authenticity: "unauthenticated_local_record" as const,
    };
    return this.append({ ...base, core_hash: coreHash(base) }) as TerminalRecord;
  }

  fail(operationId: string, code: string, startedAt: Instant, failedAt: Instant): TerminalRecord {
    const dispatched = this.dispatched(operationId);
    const base = {
      schema_version: "local-observation-operation-record/v1" as const,
      state: "failed" as const,
      observation_id: dispatched.observation_id,
      plan_hash: dispatched.plan_hash,
      operation_id: dispatched.operation_id,
      operation: dispatched.operation,
      sequence: dispatched.sequence,
      request_hash: dispatched.request_hash,
      dispatched_record_hash: dispatched.core_hash,
      failure_code: code,
      cleanup_required: EFFECTFUL.has(dispatched.operation),
      started_at: startedAt,
      failed_at: failedAt,
      evidence_authenticity: "unauthenticated_local_record" as const,
    };
    this.cleanupOnly = true;
    return this.append({ ...base, core_hash: coreHash(base) }) as TerminalRecord;
  }

  markAmbiguous(operationId: string, observation: string, at: Instant): TerminalRecord {
    const dispatched = this.dispatched(operationId);
    const base = {
      schema_version: "local-observation-operation-record/v1" as const,
      state: "ambiguous_not_replayed" as const,
      observation_id: dispatched.observation_id,
      plan_hash: dispatched.plan_hash,
      operation_id: dispatched.operation_id,
      operation: dispatched.operation,
      sequence: dispatched.sequence,
      request_hash: dispatched.request_hash,
      dispatched_record_hash: dispatched.core_hash,
      recovery_observation: observation.slice(0, 1024),
      cleanup_required: true as const,
      observed_at: at,
      evidence_authenticity: "unauthenticated_local_record" as const,
    };
    this.cleanupOnly = true;
    return this.append({ ...base, core_hash: coreHash(base) }) as TerminalRecord;
  }

  execute(
    host: AdapterHost,
    request: AdapterRequestV2,
    startedAt: Instant,
    endedAt: () => Instant,
  ): TerminalRecord {
    const existing = this.currentByOperation.get(request.operation_id);
    if (existing !== undefined) {
      if (existing.request_hash !== request.core_hash) {
        throw new Erl2Error(CODES.ADAPTER_LOCAL_REPLAY_CONFLICT, "operation id request conflict");
      }
      if (isTerminal(existing)) {
        if (existing.state === "ambiguous_not_replayed") {
          throw new Erl2Error(
            CODES.ADAPTER_LOCAL_AMBIGUOUS_REPLAY_REFUSED,
            "an ambiguous local effect is never replayed blindly",
          );
        }
        return existing;
      }
    }
    this.declare(request, startedAt);
    this.markDispatched(request.operation_id, startedAt);
    try {
      const result = host.run({
        operation: request.operation,
        operationId: request.operation_id,
        request,
        executionMode: ADAPTER_LOCAL_EXECUTION_MODE,
        requestedCapabilityIds: request.execution_context.mode === ADAPTER_LOCAL_EXECUTION_MODE
          ? request.execution_context.allowed_capability_ids
          : [],
      });
      const inputs = request.execution_context.mode === ADAPTER_LOCAL_EXECUTION_MODE
        ? request.execution_context.input_artifact_refs
        : [];
      return this.complete(request.operation_id, result, startedAt, endedAt(), inputs);
    } catch (cause) {
      const code = cause instanceof Erl2Error ? cause.code : CODES.ADAPTER_EXECUTION_FAULT;
      if (EFFECTFUL.has(request.operation)) {
        return this.markAmbiguous(
          request.operation_id,
          `host dispatch ended without a reconciled terminal (${code})`,
          endedAt(),
        );
      }
      return this.fail(request.operation_id, code, startedAt, endedAt());
    }
  }

  freezeOutput(host: AdapterHost): void {
    host.markOutputFrozen();
    this.outputFrozen = true;
  }

  cleanupResult(): LocalCleanupResultV1 {
    const terminal = [...this.currentByOperation.values()].filter(isTerminal);
    const completed = (operation: AdapterOperation): boolean =>
      terminal.some((record) => record.operation === operation && record.state === "completed");
    const failed = (operation: AdapterOperation): boolean =>
      terminal.some((record) => record.operation === operation && record.state !== "completed");
    const needsStop = completed("start");
    const needsUninstall = completed("install");
    const needsCompensation = terminal.some(
      (record) => record.state === "completed" && record.mutation_receipt_hashes.length > 0,
    );
    const finalResiduePlanned = this.plan.operations.some(
      (spec) =>
        spec.operation === "report-residue" &&
        (spec.payload as { checkpoint?: string }).checkpoint === "final",
    );
    const residueObserved = finalResiduePlanned && completed("report-residue");
    const complete =
      (!needsStop || completed("stop")) &&
      (!needsUninstall || completed("uninstall")) &&
      (!needsCompensation || completed("compensate") || completed("uninstall")) &&
      (!finalResiduePlanned || residueObserved) &&
      !terminal.some((record) => record.state === "ambiguous_not_replayed") &&
      !(needsStop && failed("stop")) &&
      !(needsUninstall && failed("uninstall"));
    const reasonCodes = complete ? [] : [CODES.ADAPTER_LOCAL_CLEANUP_INCOMPLETE];
    return {
      status: complete ? "cleanup_complete" : "cleanup_incomplete",
      stop: needsStop ? (completed("stop") ? "completed" : failed("stop") ? "failed" : "not_applicable") : "not_applicable",
      compensation: needsCompensation
        ? completed("compensate")
          ? "completed"
          : failed("compensate")
            ? "failed"
            : "not_applicable"
        : "not_applicable",
      uninstall: needsUninstall
        ? completed("uninstall")
          ? "completed"
          : failed("uninstall")
            ? "failed"
            : "not_applicable"
        : "not_applicable",
      residue: residueObserved ? "observed_clean" : "not_observed",
      reason_codes: reasonCodes,
    };
  }

  buildResult(startedAt: Instant, endedAt: Instant): LocalObservationResultV1 {
    const cleanup = this.cleanupResult();
    const base = {
      schema_version: "local-observation-result/v1" as const,
      observation_id: this.plan.observation_id,
      plan_hash: this.plan.core_hash,
      protocol_version: "subject-adapter/v2" as const,
      adapter_id: this.plan.adapter_id,
      adapter_version: this.plan.adapter_version,
      adapter_manifest_hash: this.plan.adapter_manifest_hash,
      certification_receipt_hash: this.plan.certification_receipt_hash,
      adapter_artifact_hash: this.plan.adapter_artifact_hash,
      certification_authenticity: this.plan.certification_authenticity,
      operation_record_hashes: this.records.map((record) => record.core_hash),
      retained_input_refs: [],
      retained_output_refs: [],
      retained_evidence_refs: this.records.map((record) => record.core_hash),
      structural_validation: [],
      cleanup,
      status: cleanup.status === "cleanup_complete" ? ("observed_complete" as const) : ("cleanup_incomplete" as const),
      started_at: startedAt,
      ended_at: endedAt,
      not_scored: true as const,
      not_governor_authorized: true as const,
      unsupported_claims: [...this.plan.unsupported_claims],
      evidence_authenticity: "unauthenticated_local_record" as const,
    };
    return assertContract<LocalObservationResultV1>("LocalObservationResultV1", {
      ...base,
      core_hash: coreHash(base),
    });
  }

  private assertDispatchable(request: AdapterRequestV2): AdapterRequestV2 {
    if (this.outputFrozen) {
      throw new Erl2Error(
        CODES.ADAPTER_EXECUTION_AFTER_OUTPUT_FREEZE,
        "no local subject operation may run after output freeze",
      );
    }
    const parsed = assertContract<AdapterRequestV2>("AdapterRequestV2", request);
    if (coreHash(parsed) !== parsed.core_hash) {
      throw new Erl2Error(CODES.ARTIFACT_HASH_MISMATCH, "local request core hash is stale");
    }
    assertNoLocalObservationGovernedFields(parsed);
    if (parsed.execution_context.mode !== ADAPTER_LOCAL_EXECUTION_MODE) {
      throw new Erl2Error(
        CODES.ADAPTER_EXECUTION_MODE_UNSUPPORTED,
        "the local coordinator does not execute governed V2 requests",
      );
    }
    assertLocalObservationClaimExclusions(parsed.execution_context);
    const spec = this.plan.operations.find((operation) => operation.operation_id === parsed.operation_id);
    if (
      parsed.execution_id !== this.plan.observation_id ||
      parsed.adapter_manifest_hash !== this.plan.adapter_manifest_hash ||
      parsed.execution_context.observation_plan_hash !== this.plan.core_hash ||
      spec === undefined ||
      spec.operation !== parsed.operation ||
      spec.sequence !== parsed.ancestry.sequence ||
      coreHash({ payload: spec.payload }) !== coreHash({ payload: parsed.operation_payload })
    ) {
      throw new Erl2Error(
        CODES.ADAPTER_LOCAL_OPERATION_ORDER_INVALID,
        "local request is not the exact operation at its frozen plan cursor",
      );
    }
    if (this.cleanupOnly && !spec.cleanup) {
      throw new Erl2Error(
        CODES.ADAPTER_LOCAL_OPERATION_ORDER_INVALID,
        "only the frozen cleanup suffix may run after failure or ambiguity",
      );
    }
    const priorSpecs = this.plan.operations.filter((operation) => operation.sequence < spec.sequence);
    const requiredPrior = this.cleanupOnly
      ? priorSpecs.filter((operation) => operation.cleanup)
      : priorSpecs.filter((operation) => !operation.cleanup);
    for (const prior of requiredPrior) {
      const priorRecord = this.currentByOperation.get(prior.operation_id);
      if (!isTerminalRecord(priorRecord)) {
        throw new Erl2Error(
          CODES.ADAPTER_LOCAL_OPERATION_ORDER_INVALID,
          `operation ${spec.operation_id} cannot skip prior operation ${prior.operation_id}`,
        );
      }
      if (!this.cleanupOnly && priorRecord.state !== "completed") {
        throw new Erl2Error(
          CODES.ADAPTER_LOCAL_OPERATION_ORDER_INVALID,
          `main sequence cannot continue after ${priorRecord.state}`,
        );
      }
    }
    const priorPlanOperations = this.plan.operations.filter((operation) => operation.sequence < spec.sequence);
    for (const prerequisite of prerequisitesFor(spec.operation, priorPlanOperations.map((operation) => operation.operation))) {
      const satisfied = [...this.currentByOperation.values()].some(
        (record) => record.operation === prerequisite && record.state === "completed",
      );
      if (!satisfied) {
        throw new Erl2Error(
          CODES.ADAPTER_LOCAL_OPERATION_ORDER_INVALID,
          `operation ${spec.operation} requires completed ${prerequisite}`,
        );
      }
    }
    return parsed;
  }

  private dispatched(operationId: string): Extract<LocalObservationOperationRecordV1, { state: "dispatched" }> {
    const record = this.currentByOperation.get(operationId);
    if (record?.state !== "dispatched") {
      throw new Erl2Error(
        CODES.ADAPTER_LOCAL_OPERATION_ORDER_INVALID,
        `operation ${operationId} has no dispatched record`,
      );
    }
    return record;
  }

  private append<T extends LocalObservationOperationRecordV1>(record: T): T {
    const parsed = assertContract<T>("LocalObservationOperationRecordV1", record);
    this.records.push(parsed);
    this.currentByOperation.set(parsed.operation_id, parsed);
    return parsed;
  }
}

function isTerminal(record: LocalObservationOperationRecordV1): record is TerminalRecord {
  return record.state === "completed" || record.state === "failed" || record.state === "ambiguous_not_replayed";
}

function isTerminalRecord(
  record: LocalObservationOperationRecordV1 | undefined,
): record is TerminalRecord {
  return record !== undefined && isTerminal(record);
}

function assertPlanSequence(plan: LocalObservationPlanV1): void {
  if (Date.parse(plan.expires_at) <= Date.parse(plan.created_at)) {
    throw new Erl2Error(CODES.ADAPTER_LOCAL_OPERATION_ORDER_INVALID, "local plan expires before creation");
  }
  const ids = new Set<string>();
  const inputIds = new Set<string>();
  for (const input of plan.inputs) {
    if (inputIds.has(input.input_id)) {
      throw new Erl2Error(CODES.ADAPTER_LOCAL_OPERATION_ORDER_INVALID, "local plan input ids must be unique");
    }
    inputIds.add(input.input_id);
  }
  const controlIds = new Set<string>();
  for (const expectation of plan.resource_limits.control_expectations) {
    if (controlIds.has(expectation.control_id)) {
      throw new Erl2Error(CODES.ADAPTER_LOCAL_LIMIT_EXCEEDED, "local control expectations must be unique by id");
    }
    controlIds.add(expectation.control_id);
  }
  let cleanupStarted = false;
  plan.operations.forEach((operation, index) => {
    if (operation.sequence !== index || ids.has(operation.operation_id)) {
      throw new Erl2Error(
        CODES.ADAPTER_LOCAL_OPERATION_ORDER_INVALID,
        "local plan operations require unique ids and contiguous sequence numbers",
      );
    }
    ids.add(operation.operation_id);
    if (operation.cleanup) cleanupStarted = true;
    else if (cleanupStarted) {
      throw new Erl2Error(
        CODES.ADAPTER_LOCAL_OPERATION_ORDER_INVALID,
        "local plan cleanup operations must form one frozen suffix",
      );
    }
    if (operation.timeout_ms > plan.resource_limits.wall_clock_ms) {
      throw new Erl2Error(
        CODES.ADAPTER_LOCAL_LIMIT_EXCEEDED,
        `operation ${operation.operation_id} timeout exceeds the plan wall-clock limit`,
      );
    }
  });
}

function prerequisitesFor(
  operation: AdapterOperation,
  earlier: readonly AdapterOperation[],
): readonly AdapterOperation[] {
  const present = (candidate: AdapterOperation): AdapterOperation[] =>
    earlier.includes(candidate) ? [candidate] : [];
  switch (operation) {
    case "validate-package": return present("acquire");
    case "install": return present("validate-package");
    case "configure": return present("install");
    case "start": return [...present("install"), ...present("configure")];
    case "interact": return present("start");
    case "collect-outputs": return earlier.includes("interact") ? ["interact"] : present("start");
    case "stop": return present("start");
    case "uninstall": return [...present("install"), ...present("stop")];
    default: return [];
  }
}
