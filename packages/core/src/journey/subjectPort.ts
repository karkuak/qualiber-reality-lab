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
  type ArtifactRef,
  type Hash,
  type JourneyIntent,
  type PackageVerificationRequestV1,
  type Tier,
} from "@erl2/contracts";
import { assertNoOracleFields } from "./oracle.js";

export const FAKE_SUBJECT_PORT_ID = "fake-subject";

/**
 * The fake subject's step output at exactly `byteLength` bytes, when one is
 * requested.
 *
 * Padding and truncation both happen on the *subject's* side of the boundary,
 * which is where a real subject's output length is decided. The Lab measures
 * whatever arrives, against a ceiling the subject cannot reach.
 */
function sizedOutput(natural: Buffer, byteLength: number | undefined): Buffer {
  if (byteLength === undefined) return natural;
  // 0xFF is deliberate: it is not valid UTF-8 in any position, so a sized output
  // is genuinely binary. A scanner that decoded before matching would mangle it
  // into replacement characters — and a token split by that mangling would stop
  // being found.
  const out = Buffer.alloc(byteLength, 0xff);
  natural.copy(out, 0, 0, Math.min(natural.byteLength, byteLength));
  return out;
}

/**
 * The adapter-manifest operation name each journey intent asks for.
 *
 * `SubjectAdapterManifestV1.operations` is the subject's own declaration of what
 * it implements; this is the mapping that lets a port answer `unsupported` from
 * that declaration instead of from a scripted flag.
 */
const OPERATION_FOR_INTENT: Readonly<Record<JourneyIntent, string>> = {
  acquire: "acquire",
  verify_package: "verify-package",
  install: "install",
  configure: "configure",
  authenticate: "authenticate",
  connect: "connect",
  discover: "discover",
  exercise: "exercise",
  observe: "observe",
  diagnose_decide: "diagnose-decide",
  recover: "recover",
  upgrade: "upgrade",
  rollback: "rollback",
  remove: "remove",
};

/** Executable fail-closed guard: a fake subject may never drive a real tier. */
export function assertDevelopmentSubjectPort(tier: Tier, portId: string): void {
  if (tier !== "development" && portId === FAKE_SUBJECT_PORT_ID) {
    throw new Erl2Error(
      CODES.ADMISSION_SUBJECT_PORT_NOT_DEVELOPMENT,
      "the fake subject port may not drive a held-out or blind run; slice 5 owns the real adapter host",
    );
  }
}

/**
 * One artifact a port retained for a step, as the lifecycle must name it.
 *
 * This is exactly the shape `LabLifecycleEventV1.produced` carries. A port that
 * freezes evidence has to hand back production metadata or the artifact is
 * retained and unreachable — the shape the closure derivation rejects
 * everywhere else.
 */
export interface SubjectProducedArtifact {
  readonly artifact_role: string;
  readonly artifact_core_hash: Hash;
  readonly artifact_schema_version: string;
}

/**
 * The evidence a port retained while answering one request.
 *
 * Every field maps onto a field `JourneyStepOutcomeV1` already declares. This
 * interface exists so the *engine* never has to know what kind of port it is
 * talking to: a port that adjudicates an out-of-process adapter fills it, the
 * development fake leaves it out, and the step outcome is assembled the same
 * way in both cases.
 *
 * Nothing here is adapter-specific and nothing here is optional evidence: the
 * hashes must resolve to artifacts the port actually froze, and `produced` is
 * what makes them lifecycle-reachable.
 */
export interface SubjectStepEvidence {
  /** Host adjudication records, published and reachable, for the lifecycle. */
  readonly produced: readonly SubjectProducedArtifact[];
  /** The same records, as the step's `detail_record_hashes`. */
  readonly detailRecordHashes: readonly Hash[];
  readonly mutationReceiptHashes: readonly Hash[];
  readonly compensationReceiptHashes: readonly Hash[];
  /** The subject's own retained output tree, as frozen references. */
  readonly outputRefs: readonly ArtifactRef[];
  /** The retained, redacted diagnostics entries. */
  readonly diagnosticRefs: readonly ArtifactRef[];
}

export interface SubjectStepResponse {
  readonly status: "succeeded" | "failed" | "unsupported";
  /** Bytes the subject produced for this step, if any. */
  readonly outputBytes?: Buffer;
  readonly errorCode?: string;
  readonly activeOperatorMs: number;
  readonly unsupportedInputs?: readonly string[];
  /** What the port retained while answering, if it retains anything. */
  readonly evidence?: SubjectStepEvidence;
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
  /**
   * Closes the port for this run: the subject's output has frozen.
   *
   * The rule is design v2 §14's — once subject output is frozen no subject or
   * adapter process may run again — and the enforcement already existed inside
   * the adapter host (`assertNoExecutionAfterOutputFreeze`). It was simply
   * unreachable from a run, because nothing on the port seam could tell the host
   * that the freeze had happened. Declaring it *here* rather than on the hosted
   * port is what keeps the boundary generic: the run says "output froze" to
   * whatever port it holds, and no caller branches on which one that is.
   *
   * Idempotent by construction: freezing twice is the replay case, and a port
   * that is already closed stays closed.
   */
  markOutputFrozen(): void;
}

export interface FakeSubjectBehaviour {
  /** Acquisition outcome; `failed` models an unreachable source. */
  readonly acquireStatus?: "succeeded" | "failed";
  readonly packageVerificationStatus?: "succeeded" | "failed" | "unsupported";
  /** Per-intent overrides for the environment journey. */
  readonly stepStatus?: Partial<Record<JourneyIntent, "succeeded" | "failed" | "unsupported">>;
  /**
   * The operations the subject's adapter manifest declares it supports.
   *
   * Supplied, an intent outside the list is answered `unsupported` — the honest
   * outcome for a step the subject never claimed to implement, and a real one
   * rather than a scripted failpoint. ERL2-FR-005: an unsupported result is a
   * retained result, never a removed case.
   */
  readonly declaredOperations?: readonly string[];
  /**
   * A token the fake subject writes into its own output bytes.
   *
   * Development-only, and the point of it is the *opposite* of a feature: it
   * makes the oracle leak reachable, so the canary scan on the subject-output
   * surface can be shown to be load-bearing rather than merely present.
   */
  readonly leakCanaryId?: string;
  /**
   * The exact byte length of the output this fake subject writes for one step.
   *
   * Development-only, and — like `leakCanaryId` — the point of it is to make an
   * invariant *reachable* rather than to add a capability. The declared
   * subject-output ceiling is 64 MiB; without a way to produce a payload of a
   * chosen size, "refused one byte over, admitted exactly at" is a property that
   * can only be asserted about a helper, never observed on the shipped path.
   *
   * It steers the subject's own bytes. It cannot move the ceiling those bytes are
   * measured against, which is frozen in the run's execution plan.
   */
  readonly outputByteLength?: number;
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
  private outputFrozen = false;
  /** Requests the port saw, retained so tests can scan them for canaries. */
  readonly observedRequests: unknown[] = [];

  constructor(behaviour: FakeSubjectBehaviour = {}) {
    this.behaviour = behaviour;
  }

  markOutputFrozen(): void {
    this.outputFrozen = true;
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
    const declared = this.behaviour.declaredOperations;
    const undeclared = declared !== undefined && !declared.includes(OPERATION_FOR_INTENT[intent]);
    const status = this.behaviour.stepStatus?.[intent] ?? (undeclared ? "unsupported" : "succeeded");
    const unsupportedInputs = this.behaviour.unsupportedInputs ?? [];
    const natural = Buffer.from(
      `${intent} output\n${this.behaviour.leakCanaryId === undefined ? "" : `${this.behaviour.leakCanaryId}\n`}`,
      "utf8",
    );
    return {
      status,
      activeOperatorMs: 750,
      outputBytes: sizedOutput(natural, this.behaviour.outputByteLength),
      ...(status === "failed" ? { errorCode: `SUBJECT_RUNTIME_${intent.toUpperCase()}_FAILED` } : {}),
      ...(status === "unsupported"
        ? { unsupportedInputs: undeclared ? [`operation:${OPERATION_FOR_INTENT[intent]}`] : unsupportedInputs }
        : {}),
    };
  }

  private observe(what: string, request: unknown): void {
    // The post-freeze boundary, enforced from inside the untrusted plane as well
    // as from the run. The hosted port inherits the same rule from the adapter
    // host; a development fake that answered after the freeze would make the
    // guard a property of one implementation rather than of the seam.
    if (this.outputFrozen) {
      throw new Erl2Error(
        CODES.ADAPTER_EXECUTION_AFTER_OUTPUT_FREEZE,
        `${what} is forbidden after subject output freezes`,
        { owner: "lab" },
      );
    }
    // Structural half of the oracle partition: an expectation-shaped field must
    // not exist at all, whatever its value.
    assertNoOracleFields(what, request);
    this.observedRequests.push(request);
  }
}
