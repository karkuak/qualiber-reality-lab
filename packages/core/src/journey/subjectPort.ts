/**
 * The subject port seam, and the development-only fake subject.
 *
 * **Slice 5 owns the real adapter host** — the sandbox, the capability and
 * privilege broker, the credential handles and the certification harness. This
 * slice needs *a* subject so the journey, capture and terminal paths are
 * executable end to end, so it defines the narrow interface the host will
 * implement and ships one fake implementation behind a tier gate.
 *
 * The fake port receives only `SubjectVisibleJourneyStepV1`-derived requests.
 * It has no route to truth, judge expectations, selection handles or the vault,
 * and `assertDevelopmentSubjectPort` refuses it outside development tier.
 */

import {
  CODES,
  Erl2Error,
  type AcquisitionAdapterRequestV1,
  type AdapterStepRequestV1,
  type JourneyIntent,
  type PackageVerificationRequestV1,
  type Tier,
} from "@erl2/contracts";
import { assertNoOracleFields } from "./oracle.js";

export const FAKE_SUBJECT_PORT_ID = "fake-subject";

/** Executable fail-closed guard: a fake subject may never drive a real tier. */
export function assertDevelopmentSubjectPort(tier: Tier, portId: string): void {
  if (tier !== "development" && portId === FAKE_SUBJECT_PORT_ID) {
    throw new Erl2Error(
      CODES.ADMISSION_SUBJECT_PORT_NOT_DEVELOPMENT,
      "the fake subject port may not drive a held-out or blind run; slice 5 owns the real adapter host",
    );
  }
}

export interface SubjectStepResponse {
  readonly status: "succeeded" | "failed" | "unsupported";
  /** Bytes the subject produced for this step, if any. */
  readonly outputBytes?: Buffer;
  readonly errorCode?: string;
  readonly activeOperatorMs: number;
  readonly unsupportedInputs?: readonly string[];
}

export interface SubjectAcquisitionResponse extends SubjectStepResponse {
  readonly packageBytes?: Buffer;
  readonly attempts: readonly {
    readonly attemptId: string;
    readonly status: "completed" | "failed";
    readonly bytes: number;
    readonly redirectCount: number;
    readonly errorCodes: readonly string[];
  }[];
  readonly authenticationPromptCount: number;
  readonly documentationStepIds: readonly string[];
  readonly elapsedMs: number;
}

/**
 * The narrow surface the Slice 5 adapter host will implement. Each method takes
 * exactly its closed, phase-appropriate request contract.
 */
export interface SubjectPort {
  readonly portId: string;
  acquire(request: AcquisitionAdapterRequestV1): SubjectAcquisitionResponse;
  validatePackage(request: PackageVerificationRequestV1): SubjectStepResponse;
  step(request: AdapterStepRequestV1, intent: JourneyIntent): SubjectStepResponse;
}

export interface FakeSubjectBehaviour {
  /** Acquisition outcome; `failed` models an unreachable source. */
  readonly acquireStatus?: "succeeded" | "failed";
  readonly packageVerificationStatus?: "succeeded" | "failed" | "unsupported";
  /** Per-intent overrides for the environment journey. */
  readonly stepStatus?: Partial<Record<JourneyIntent, "succeeded" | "failed" | "unsupported">>;
  readonly unsupportedInputs?: readonly string[];
  readonly packageBytes?: Buffer;
}

/**
 * A deterministic fake subject.
 *
 * It asserts on every request it receives that no judge-expectation field is
 * present — the subject side of the oracle partition, checked from inside the
 * untrusted plane rather than only from the Lab side.
 */
export class FakeSubjectPort implements SubjectPort {
  readonly portId = FAKE_SUBJECT_PORT_ID;
  private readonly behaviour: FakeSubjectBehaviour;
  /** Requests the port saw, retained so tests can scan them for canaries. */
  readonly observedRequests: unknown[] = [];

  constructor(behaviour: FakeSubjectBehaviour = {}) {
    this.behaviour = behaviour;
  }

  acquire(request: AcquisitionAdapterRequestV1): SubjectAcquisitionResponse {
    this.observe("acquisition adapter request", request);
    const status = this.behaviour.acquireStatus ?? "succeeded";
    if (status === "failed") {
      return {
        status: "failed",
        errorCode: CODES.SUBJECT_ACQUIRE_SOURCE_UNREACHABLE,
        activeOperatorMs: 1500,
        elapsedMs: 1500,
        authenticationPromptCount: 1,
        documentationStepIds: ["doc-install-overview"],
        attempts: [
          {
            attemptId: "attempt-1",
            status: "failed",
            bytes: 0,
            redirectCount: 0,
            errorCodes: [CODES.SUBJECT_ACQUIRE_SOURCE_UNREACHABLE],
          },
        ],
      };
    }
    const packageBytes =
      this.behaviour.packageBytes ?? Buffer.from("fake subject package bytes\n", "utf8");
    return {
      status: "succeeded",
      packageBytes,
      activeOperatorMs: 2000,
      elapsedMs: 2400,
      authenticationPromptCount: 0,
      documentationStepIds: ["doc-install-overview", "doc-quickstart"],
      attempts: [
        {
          attemptId: "attempt-1",
          status: "completed",
          bytes: packageBytes.byteLength,
          redirectCount: 0,
          errorCodes: [],
        },
      ],
    };
  }

  validatePackage(request: PackageVerificationRequestV1): SubjectStepResponse {
    this.observe("package verification request", request);
    const status = this.behaviour.packageVerificationStatus ?? "succeeded";
    if (status === "succeeded") return { status: "succeeded", activeOperatorMs: 500 };
    if (status === "unsupported") {
      // Unsupported is a retained result, never a removed case (ERL2-FR-005).
      return {
        status: "unsupported",
        errorCode: CODES.SUBJECT_PACKAGE_KIND_UNSUPPORTED,
        activeOperatorMs: 500,
        unsupportedInputs: ["package-kind:archive"],
      };
    }
    return {
      status: "failed",
      errorCode: CODES.SUBJECT_PACKAGE_VERIFICATION_FAILED,
      activeOperatorMs: 500,
    };
  }

  step(request: AdapterStepRequestV1, intent: JourneyIntent): SubjectStepResponse {
    this.observe(`adapter step request (${intent})`, request);
    const status = this.behaviour.stepStatus?.[intent] ?? "succeeded";
    const unsupportedInputs = this.behaviour.unsupportedInputs ?? [];
    return {
      status,
      activeOperatorMs: 750,
      outputBytes: Buffer.from(`${intent} output\n`, "utf8"),
      ...(status === "failed" ? { errorCode: `SUBJECT_RUNTIME_${intent.toUpperCase()}_FAILED` } : {}),
      ...(status === "unsupported" ? { unsupportedInputs } : {}),
    };
  }

  private observe(what: string, request: unknown): void {
    // Structural half of the oracle partition: an expectation-shaped field must
    // not exist at all, whatever its value.
    assertNoOracleFields(what, request);
    this.observedRequests.push(request);
  }
}
