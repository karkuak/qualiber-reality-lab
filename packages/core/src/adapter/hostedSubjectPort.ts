/**
 * The `SubjectPort` backed by the real adapter host.
 *
 * This is the seam that makes the reference adapters and any future opaque
 * subject the *same thing* from the journey engine's point of view: the engine
 * dispatches a generic intent, the host runs an out-of-process adapter over the
 * certified protocol, and the port translates the adjudicated response envelope
 * back into the engine's step result.
 *
 * Nothing here is adapter-specific. There is no branch on adapter id, no
 * special case for a reference adapter, and no development shortcut: replacing
 * the entry path with a different certified adapter is the whole integration.
 */

import { CODES, Erl2Error, type AcquisitionAdapterRequestV1, type AdapterStepRequestV1, type JourneyIntent, type PackageVerificationRequestV1 } from "@erl2/contracts";
import type {
  SubjectAcquisitionResponse,
  SubjectPort,
  SubjectStepResponse,
} from "../journey/subjectPort.js";
import { AdapterHost, type AdapterOperationResult } from "./host.js";

/** Journey intent → protocol operation. The mapping is total and closed. */
const INTENT_OPERATION = {
  acquire: "acquire",
  verify_package: "validate-package",
  install: "install",
  configure: "configure",
  authenticate: "configure",
  connect: "start",
  discover: "interact",
  exercise: "interact",
  observe: "interact",
  diagnose_decide: "project",
  recover: "compensate",
  upgrade: "install",
  rollback: "compensate",
  remove: "uninstall",
} as const satisfies Record<JourneyIntent, string>;

export const HOSTED_SUBJECT_PORT_ID = "hosted-adapter";

interface AcquireResult {
  readonly package_base64?: string;
  readonly attempts?: readonly {
    readonly attempt_id: string;
    readonly status: "completed" | "failed";
    readonly bytes: number;
    readonly redirect_count: number;
    readonly error_codes: readonly string[];
  }[];
  readonly authentication_prompt_count?: number;
  readonly documentation_step_ids?: readonly string[];
  readonly elapsed_ms?: number;
}

/**
 * Adapts one host result into a step response.
 *
 * A `failed` or `unsupported` adapter envelope whose error is owned by the
 * *adapter* is an adapter finding, not a subject one; only an error the adapter
 * explicitly attributes to the subject it wraps becomes a subject-owned step
 * outcome, and even then the Lab re-checks attribution before any finding is
 * frozen (design v2 §20).
 */
function toStepResponse(result: AdapterOperationResult): SubjectStepResponse {
  const envelope = result.envelope;
  if (envelope.status === "supported") {
    return {
      status: "succeeded",
      activeOperatorMs: envelope.active_operator_ms,
      evidence: result.retained,
    };
  }
  if (envelope.error?.owner === "adapter") {
    throw new Erl2Error(
      envelope.error.code,
      `the adapter failed the operation: ${envelope.error.safe_message}`,
      { owner: "adapter" },
    );
  }
  // An `unsupported` or subject-owned `failed` envelope is a *retained* result
  // (ERL2-FR-005), so it carries its evidence exactly as a supported one does.
  // Dropping it here would mean the only steps with an adjudication trail were
  // the ones that went well.
  return {
    status: envelope.status === "unsupported" ? "unsupported" : "failed",
    activeOperatorMs: envelope.active_operator_ms,
    evidence: result.retained,
    ...(envelope.error === undefined ? {} : { errorCode: envelope.error.code }),
    ...(envelope.status === "unsupported"
      ? { unsupportedInputs: [...envelope.unsupported_inputs] }
      : {}),
  };
}

export class HostedSubjectPort implements SubjectPort {
  readonly portId = HOSTED_SUBJECT_PORT_ID;
  readonly host: AdapterHost;
  /**
   * Every host result, in dispatch order.
   *
   * Diagnostic only. The evidence each result carries is frozen by the host and
   * travels back through `SubjectStepResponse.evidence`; this array is not the
   * route by which anything is retained, and a reader must not treat it as one.
   */
  readonly results: AdapterOperationResult[] = [];

  constructor(host: AdapterHost) {
    if (host.manifest.schema_version !== "subject-adapter-manifest/v1") {
      throw new Erl2Error(
        CODES.ADAPTER_EXECUTION_MODE_UNSUPPORTED,
        "the governed SubjectPort accepts only the unchanged subject-adapter/v1 host",
      );
    }
    this.host = host;
  }

  /**
   * Closes the host for this run.
   *
   * The guard itself is the host's and always was. This method is the seam that
   * lets a run reach it without knowing it is talking to an adapter host.
   */
  markOutputFrozen(): void {
    this.host.markOutputFrozen();
  }

  acquire(request: AcquisitionAdapterRequestV1): SubjectAcquisitionResponse {
    const result = this.host.run({
      operation: "acquire",
      operationId: request.operation_id,
      request,
    });
    this.results.push(result);
    const step = toStepResponse(result);
    const payload = (result.result ?? {}) as AcquireResult;
    const attempts =
      payload.attempts ??
      ([
        {
          attempt_id: "attempt-1",
          status: step.status === "succeeded" ? ("completed" as const) : ("failed" as const),
          bytes: 0,
          redirect_count: 0,
          error_codes: [] as string[],
        },
      ] as const);

    return {
      ...step,
      ...(payload.package_base64 === undefined
        ? {}
        : { packageBytes: Buffer.from(payload.package_base64, "base64") }),
      attempts: attempts.map((a) => ({
        attemptId: a.attempt_id,
        status: a.status,
        bytes: a.bytes,
        redirectCount: a.redirect_count,
        errorCodes: [...a.error_codes],
      })),
      authenticationPromptCount: payload.authentication_prompt_count ?? 0,
      documentationStepIds: [...(payload.documentation_step_ids ?? [])],
      elapsedMs: payload.elapsed_ms ?? result.envelope.active_operator_ms,
    };
  }

  validatePackage(request: PackageVerificationRequestV1): SubjectStepResponse {
    const result = this.host.run({
      operation: "validate-package",
      operationId: request.operation_id,
      request,
    });
    this.results.push(result);
    return toStepResponse(result);
  }

  step(request: AdapterStepRequestV1, intent: JourneyIntent): SubjectStepResponse {
    const operation = INTENT_OPERATION[intent];
    const manifest = this.host.manifest;
    if (manifest.schema_version !== "subject-adapter-manifest/v1") {
      throw new Erl2Error(
        CODES.ADAPTER_EXECUTION_MODE_UNSUPPORTED,
        "a local-observation adapter cannot enter the governed SubjectPort",
      );
    }
    if (!manifest.operations.includes(operation)) {
      // An operation the adapter never declared is unsupported, not a failure:
      // an unsupported capability stays an admitted, retained result.
      return {
        status: "unsupported",
        activeOperatorMs: 0,
        errorCode: CODES.ADAPTER_OPERATION_UNSUPPORTED,
        unsupportedInputs: [`operation:${operation}`],
      };
    }
    const result = this.host.run({
      operation,
      operationId: request.operation_id,
      request,
    });
    this.results.push(result);
    return toStepResponse(result);
  }
}
