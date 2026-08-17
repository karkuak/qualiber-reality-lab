/**
 * The subject-adapter runtime: what an adapter author writes against.
 *
 * The SDK exposes **only** subject-adapter responsibilities (continuation
 * prompt §7.2): validate the package kind and declared entrypoints, translate
 * generic journey intents into subject operations, accept only subject-visible
 * inputs, request scoped credential handles, declare mutations and
 * compensations, collect bounded outputs and diagnostics, project frozen output
 * into generic claims, produce a total evidence-translation receipt, and report
 * supported/failed/unsupported.
 *
 * It exposes no API for challenge selection or pool handles, truth or judge
 * expectations, canonical-evidence mutation, Lab validity, generic metric
 * thresholds, environment-wide shell execution, finalization or attestation, or
 * post-reveal execution — and `tests/architecture` enumerates the export
 * surface and the import graph to keep it that way.
 *
 * Identity is Lab-owned. Every artifact an adapter produces leaves here as a
 * *draft* with no `core_hash`: the host canonicalises, hashes, validates and
 * freezes. An adapter therefore cannot assert an artifact identity, and cannot
 * forge one for an artifact it never produced.
 */

import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  ADAPTER_LOCAL_EXECUTION_MODE,
  ADAPTER_PROTOCOL_VERSION,
  ADAPTER_PROTOCOL_VERSION_V2,
  CODES,
  Erl2Error,
  decodeFrame,
  encodeFrame,
  isAdapterOperation,
  type AdapterOperation,
  type AdapterResponseMessage,
  type AdapterResponseMessageV2,
  type AnyHostMessage,
  type CompensationDraft,
  type CredentialHandleRequestDraft,
  type CredentialUseDraft,
  type EgressAttemptDraft,
  type HostMessage,
  type HostOperationMessage,
  type HostOperationMessageV2,
  type MutationDraft,
} from "@erl2/contracts";
import {
  assertNoOracleCanary,
  assertNoOracleFields,
  assertLocalObservationRequestV2,
  assertOperationMatchesPhase,
  assertRequestAncestry,
  type AdapterRequestPhase,
} from "./ancestry.js";

/** What a handler returns for one operation. */
export interface AdapterOperationOutcome {
  readonly status: "supported" | "failed" | "unsupported";
  /** Operation payload the host validates against its own contract. */
  readonly result?: unknown;
  readonly resultSchemaVersion?: string;
  readonly unsupportedInputs?: readonly string[];
  readonly error?: { readonly code: string; readonly safeMessage: string; readonly owner?: "adapter" | "subject" };
  readonly activeOperatorMs?: number;
}

/**
 * The only surface a handler has.
 *
 * Everything a handler can reach is here; there is no ambient path, no shell,
 * and no route to truth, selection or validity.
 */
export interface AdapterOperationContext {
  readonly runId: string;
  readonly protocolVersion: typeof ADAPTER_PROTOCOL_VERSION | typeof ADAPTER_PROTOCOL_VERSION_V2;
  readonly executionMode: "governed" | typeof ADAPTER_LOCAL_EXECUTION_MODE;
  readonly operation: AdapterOperation;
  readonly operationId: string;
  readonly phase: AdapterRequestPhase | typeof ADAPTER_LOCAL_EXECUTION_MODE;
  /** The validated, phase-appropriate request. */
  readonly request: Record<string, unknown>;
  readonly deadline: string;
  readonly grantedCapabilityIds: readonly string[];

  /** Reads a file from a host-declared read-only mount. */
  readInput(mountId: string, relativePath: string): Buffer;
  /** Lists a host-declared read-only mount. */
  listInput(mountId: string): readonly string[];
  /** Writes into the run-scoped output directory; the host bounds and freezes it. */
  writeOutput(relativePath: string, bytes: Buffer | string): void;
  /** Appends a bounded diagnostic line; the host scans and redacts it. */
  diagnostic(message: string): void;

  /** Declares a mutation *before* performing it, and its compensation identity. */
  declareMutation(draft: MutationDraft): void;
  /** Records the compensation that reverses a previously declared mutation. */
  declareCompensation(draft: CompensationDraft): void;
  /** Requests a scoped, short-lived credential handle. Never a plaintext secret. */
  requestCredentialHandle(draft: CredentialHandleRequestDraft): void;
  /** Records a use of a granted handle, bound to one scope and target. */
  useCredentialHandle(draft: CredentialUseDraft): void;
  /** Records an intended egress; the host decides and receipts it. */
  attemptEgress(draft: EgressAttemptDraft): void;
}

/**
 * One operation.
 *
 * A handler may be synchronous or return a promise. The asynchronous form exists
 * because a subject that interacts with a *real* environment has to perform real
 * I/O, and every I/O primitive Node offers is asynchronous — a sync-only handler
 * type would have forced such an adapter to spawn a child process, which is
 * precisely the privileged reach a subject must not have. The wire protocol is
 * unchanged: the response frame is still written once, after the handler settles.
 */
export type AdapterHandler = (
  context: AdapterOperationContext,
) => AdapterOperationOutcome | Promise<AdapterOperationOutcome>;

export interface AdapterDefinition {
  readonly adapterId: string;
  readonly version: string;
  readonly supportedPackageKinds: readonly ("archive" | "oci" | "native" | "bundle")[];
  readonly declaredEntrypoints: readonly string[];
  readonly handlers: Partial<Record<AdapterOperation, AdapterHandler>>;
  /** Opt-in only. Omission preserves the byte-compatible V1 SDK behavior. */
  readonly supportedProtocolVersions?: readonly (typeof ADAPTER_PROTOCOL_VERSION | typeof ADAPTER_PROTOCOL_VERSION_V2)[];
}

const MAX_DIAGNOSTIC_LINE_BYTES = 4096;

class OperationContext implements AdapterOperationContext {
  readonly runId: string;
  readonly protocolVersion: typeof ADAPTER_PROTOCOL_VERSION | typeof ADAPTER_PROTOCOL_VERSION_V2;
  readonly executionMode: "governed" | typeof ADAPTER_LOCAL_EXECUTION_MODE;
  readonly operation: AdapterOperation;
  readonly operationId: string;
  readonly phase: AdapterRequestPhase | typeof ADAPTER_LOCAL_EXECUTION_MODE;
  readonly request: Record<string, unknown>;
  readonly deadline: string;
  readonly grantedCapabilityIds: readonly string[];

  readonly mutations: MutationDraft[] = [];
  readonly compensations: CompensationDraft[] = [];
  readonly credentialRequests: CredentialHandleRequestDraft[] = [];
  readonly credentialUses: CredentialUseDraft[] = [];
  readonly egressAttempts: EgressAttemptDraft[] = [];

  private readonly mounts: ReadonlyMap<string, { absolute: string; purpose: string }>;
  private readonly outputDirectory: string;
  private readonly diagnosticsFile: string;

  private readonly maxDiagnosticLineBytes: number;

  constructor(
    message: HostOperationMessage | HostOperationMessageV2,
    phase: AdapterRequestPhase | typeof ADAPTER_LOCAL_EXECUTION_MODE,
  ) {
    const v2 = "execution_id" in message;
    this.runId = v2 ? message.execution_id : message.run_id;
    this.protocolVersion = v2 ? ADAPTER_PROTOCOL_VERSION_V2 : ADAPTER_PROTOCOL_VERSION;
    this.executionMode = v2 ? ADAPTER_LOCAL_EXECUTION_MODE : "governed";
    this.operation = message.operation;
    this.operationId = message.operation_id;
    this.phase = phase;
    this.request = message.request as Record<string, unknown>;
    this.deadline = message.deadline;
    this.grantedCapabilityIds = [...message.granted_capability_ids];
    this.mounts = new Map(
      message.mounts.map((m) => [m.mount_id, { absolute: m.absolute_path, purpose: m.purpose }]),
    );
    this.outputDirectory = message.output_directory;
    this.diagnosticsFile = path.join(message.diagnostics_directory, `${message.operation_id}.log`);
    const request = message.request as {
      execution_context?: { resource_limits?: { max_diagnostic_line_bytes?: unknown } };
    };
    const requestedLineLimit = request.execution_context?.resource_limits?.max_diagnostic_line_bytes;
    this.maxDiagnosticLineBytes =
      v2 && typeof requestedLineLimit === "number"
        ? Math.min(requestedLineLimit, MAX_DIAGNOSTIC_LINE_BYTES)
        : MAX_DIAGNOSTIC_LINE_BYTES;
    mkdirSync(this.outputDirectory, { recursive: true });
    mkdirSync(message.diagnostics_directory, { recursive: true });
  }

  /**
   * Resolves a path inside a declared root and refuses anything that leaves it.
   * The host enforces the real boundary; this is the adapter-side check, so an
   * SDK-built adapter fails on its own traversal bug instead of relying on the
   * host to catch it.
   */
  private confine(root: string, relativePath: string): string {
    if (path.isAbsolute(relativePath)) {
      throw new Erl2Error(CODES.PATH_ESCAPES_ROOT, "an adapter path must be root-relative");
    }
    const resolved = path.resolve(root, relativePath);
    const rootWithSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
    if (resolved !== root && !resolved.startsWith(rootWithSep)) {
      throw new Erl2Error(CODES.PATH_ESCAPES_ROOT, `path ${relativePath} escapes its root`);
    }
    return resolved;
  }

  private mount(mountId: string): { absolute: string; purpose: string } {
    const found = this.mounts.get(mountId);
    if (!found) {
      throw new Erl2Error(
        CODES.ADAPTER_MOUNT_FORBIDDEN,
        `mount ${mountId} was not granted to this operation`,
      );
    }
    return found;
  }

  readInput(mountId: string, relativePath: string): Buffer {
    const mount = this.mount(mountId);
    return readFileSync(this.confine(mount.absolute, relativePath));
  }

  listInput(mountId: string): readonly string[] {
    const mount = this.mount(mountId);
    const out: string[] = [];
    const walk = (dir: string, prefix: string): void => {
      for (const name of readdirSync(dir).sort()) {
        const child = path.join(dir, name);
        if (statSync(child).isDirectory()) walk(child, `${prefix}${name}/`);
        else out.push(`${prefix}${name}`);
      }
    };
    walk(mount.absolute, "");
    return out;
  }

  writeOutput(relativePath: string, bytes: Buffer | string): void {
    const absolute = this.confine(this.outputDirectory, relativePath);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes, {
      flag: "wx",
    });
  }

  diagnostic(message: string): void {
    const bytes = Buffer.from(message, "utf8").subarray(0, this.maxDiagnosticLineBytes);
    const line = `${bytes.toString("utf8")}\n`;
    appendFileSync(this.diagnosticsFile, line, "utf8");
  }

  declareMutation(draft: MutationDraft): void {
    if (!this.grantedCapabilityIds.includes(draft.capability_id)) {
      throw new Erl2Error(
        CODES.ADAPTER_CAPABILITY_NOT_GRANTED,
        `capability ${draft.capability_id} was not granted to this operation`,
      );
    }
    this.mutations.push(draft);
  }

  declareCompensation(draft: CompensationDraft): void {
    this.compensations.push(draft);
  }

  requestCredentialHandle(draft: CredentialHandleRequestDraft): void {
    this.credentialRequests.push(draft);
  }

  useCredentialHandle(draft: CredentialUseDraft): void {
    this.credentialUses.push(draft);
  }

  attemptEgress(draft: EgressAttemptDraft): void {
    this.egressAttempts.push(draft);
  }
}

/**
 * Validates the package kind and declared entrypoints a package-verification
 * request implies.  An unsupported kind is an honest `unsupported` outcome, not
 * a failure and not a silent success.
 */
export function checkPackageKind(
  definition: AdapterDefinition,
  packageKind: string,
): { readonly supported: boolean; readonly reason?: string } {
  if ((definition.supportedPackageKinds as readonly string[]).includes(packageKind)) {
    return { supported: true };
  }
  return { supported: false, reason: `package-kind:${packageKind}` };
}

/** Builds one response message from a handler outcome and its context. */
function buildResponse(
  context: OperationContext,
  outcome: AdapterOperationOutcome,
): AdapterResponseMessage {
  const base = {
    kind: "response" as const,
    protocol_version: ADAPTER_PROTOCOL_VERSION,
    run_id: context.runId,
    operation: context.operation,
    operation_id: context.operationId,
    status: outcome.status,
    mutations: context.mutations,
    compensations: context.compensations,
    credential_requests: context.credentialRequests,
    credential_uses: context.credentialUses,
    egress_attempts: context.egressAttempts,
    unsupported_inputs: [...(outcome.unsupportedInputs ?? [])],
    active_operator_ms: outcome.activeOperatorMs ?? 0,
  };
  if (outcome.status === "supported") {
    return {
      ...base,
      ...(outcome.result === undefined ? {} : { result: outcome.result }),
      ...(outcome.resultSchemaVersion === undefined
        ? {}
        : { result_schema_version: outcome.resultSchemaVersion }),
    };
  }
  return {
    ...base,
    error: {
      code: outcome.error?.code ?? CODES.ADAPTER_EXECUTION_FAULT,
      owner: outcome.error?.owner ?? "adapter",
      safe_message: (outcome.error?.safeMessage ?? "the adapter reported no detail").slice(0, 1024),
    },
  };
}

function buildResponseV2(
  context: OperationContext,
  outcome: AdapterOperationOutcome,
): AdapterResponseMessageV2 {
  const base = {
    kind: "response" as const,
    schema_version: "adapter-response-message/v2" as const,
    protocol_version: ADAPTER_PROTOCOL_VERSION_V2,
    execution_mode: ADAPTER_LOCAL_EXECUTION_MODE,
    execution_id: context.runId,
    operation: context.operation,
    operation_id: context.operationId,
    status: outcome.status,
    mutations: context.mutations,
    compensations: context.compensations,
    credential_requests: context.credentialRequests,
    credential_uses: context.credentialUses,
    egress_attempts: context.egressAttempts,
    unsupported_inputs: [...(outcome.unsupportedInputs ?? [])],
    active_operator_ms: outcome.activeOperatorMs ?? 0,
  };
  if (outcome.status === "supported") {
    return {
      ...base,
      ...(outcome.result === undefined ? {} : { result: outcome.result }),
      ...(outcome.resultSchemaVersion === undefined
        ? {}
        : { result_schema_version: outcome.resultSchemaVersion }),
    };
  }
  return {
    ...base,
    error: {
      code: outcome.error?.code ?? CODES.ADAPTER_EXECUTION_FAULT,
      owner: outcome.error?.owner ?? "adapter",
      safe_message: (outcome.error?.safeMessage ?? "the adapter reported no detail").slice(0, 1024),
    },
  };
}

export interface RunAdapterStreams {
  readonly input: NodeJS.ReadableStream;
  readonly output: NodeJS.WritableStream;
}

/**
 * Runs the adapter's message loop until the host sends `shutdown` or closes the
 * stream.  Every failure inside a handler becomes a typed `failed` response
 * owned by the adapter — never a silent success and never a subject defect.
 */
export async function runAdapter(
  definition: AdapterDefinition,
  streams: RunAdapterStreams,
): Promise<void> {
  let buffer = Buffer.alloc(0);
  let maxResponseBytes = 1024 * 1024;
  let negotiatedProtocol: typeof ADAPTER_PROTOCOL_VERSION | typeof ADAPTER_PROTOCOL_VERSION_V2 | undefined;
  const write = (message: unknown): void => {
    streams.output.write(encodeFrame(message, maxResponseBytes));
  };

  for await (const chunk of streams.input as AsyncIterable<Buffer>) {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const frame = decodeFrame(buffer);
      if (!frame) break;
      buffer = buffer.subarray(frame.consumed);
      const message = frame.value as AnyHostMessage;
      if (message.kind === "shutdown") return;
      if (message.kind === "negotiate") {
        maxResponseBytes = message.max_response_bytes;
        if ("offered_protocol_versions" in message) {
          const optsIn = definition.supportedProtocolVersions?.includes(ADAPTER_PROTOCOL_VERSION_V2) === true;
          if (!optsIn || message.required_execution_mode !== ADAPTER_LOCAL_EXECUTION_MODE) {
            negotiatedProtocol = undefined;
            write({
              kind: "negotiation",
              schema_version: "adapter-negotiation-response/v2",
              selected_protocol_version: ADAPTER_PROTOCOL_VERSION,
              execution_mode: "governed",
              adapter_id: definition.adapterId,
              adapter_version: definition.version,
              supported_operations: Object.keys(definition.handlers).filter(isAdapterOperation),
              supported_package_kinds: definition.supportedPackageKinds,
            });
          } else {
            negotiatedProtocol = ADAPTER_PROTOCOL_VERSION_V2;
            write({
              kind: "negotiation",
              schema_version: "adapter-negotiation-response/v2",
              selected_protocol_version: ADAPTER_PROTOCOL_VERSION_V2,
              execution_mode: ADAPTER_LOCAL_EXECUTION_MODE,
              adapter_id: definition.adapterId,
              adapter_version: definition.version,
              supported_operations: Object.keys(definition.handlers).filter(isAdapterOperation),
              supported_package_kinds: definition.supportedPackageKinds,
            });
          }
        } else {
          negotiatedProtocol = ADAPTER_PROTOCOL_VERSION;
          write({
            kind: "negotiation",
            protocol_version: ADAPTER_PROTOCOL_VERSION,
            adapter_id: definition.adapterId,
            adapter_version: definition.version,
            supported_operations: Object.keys(definition.handlers).filter(isAdapterOperation),
            supported_package_kinds: definition.supportedPackageKinds,
          });
        }
        continue;
      }
      if ("execution_id" in message) {
        if (negotiatedProtocol === ADAPTER_PROTOCOL_VERSION_V2) {
          write(await dispatchV2(definition, message));
        }
      } else if (negotiatedProtocol === ADAPTER_PROTOCOL_VERSION) {
        write(await dispatch(definition, message));
      }
    }
  }
}

async function dispatchV2(
  definition: AdapterDefinition,
  message: HostOperationMessageV2,
): Promise<AdapterResponseMessageV2> {
  let context: OperationContext | undefined;
  try {
    if (
      message.protocol_version !== ADAPTER_PROTOCOL_VERSION_V2 ||
      message.execution_mode !== ADAPTER_LOCAL_EXECUTION_MODE ||
      message.schema_version !== "adapter-host-operation/v2"
    ) {
      throw new Erl2Error(
        message.execution_mode === ADAPTER_LOCAL_EXECUTION_MODE
          ? CODES.ADAPTER_PROTOCOL_VERSION_MISMATCH
          : CODES.ADAPTER_EXECUTION_MODE_UNSUPPORTED,
        "the operation frame does not match the negotiated local V2 profile",
      );
    }
    const request = assertLocalObservationRequestV2(message.request);
    if (
      request.execution_id !== message.execution_id ||
      request.operation_id !== message.operation_id ||
      request.operation !== message.operation
    ) {
      throw new Erl2Error(
        CODES.ADAPTER_PROTOCOL_RESPONSE_MISMATCH,
        "the V2 operation frame and request identifiers differ",
      );
    }
    context = new OperationContext(message, ADAPTER_LOCAL_EXECUTION_MODE);
    const handler = definition.handlers[message.operation];
    if (!handler) {
      return buildResponseV2(context, {
        status: "unsupported",
        unsupportedInputs: [`operation:${message.operation}`],
        error: {
          code: CODES.ADAPTER_OPERATION_UNSUPPORTED,
          safeMessage: `this adapter does not implement ${message.operation}`,
        },
      });
    }
    return buildResponseV2(context, await handler(context));
  } catch (cause) {
    const code = cause instanceof Erl2Error ? cause.code : CODES.ADAPTER_EXECUTION_FAULT;
    const safeMessage = cause instanceof Error ? cause.message.slice(0, 512) : "unknown adapter fault";
    const fallback =
      context ?? new OperationContext(message, ADAPTER_LOCAL_EXECUTION_MODE);
    return buildResponseV2(fallback, { status: "failed", error: { code, safeMessage } });
  }
}

async function dispatch(
  definition: AdapterDefinition,
  message: HostOperationMessage,
): Promise<AdapterResponseMessage> {
  let context: OperationContext | undefined;
  try {
    // The adapter checks its own request before touching it: an ancestry or
    // oracle violation is caught on both sides of the boundary.
    const phase = assertRequestAncestry(message.request);
    assertOperationMatchesPhase(message.operation, phase);
    assertNoOracleFields(`${message.operation} request`, message.request);
    assertNoOracleCanary(`${message.operation} request`, JSON.stringify(message.request));

    context = new OperationContext(message, phase);
    const handler = definition.handlers[message.operation];
    if (!handler) {
      return buildResponse(context, {
        status: "unsupported",
        unsupportedInputs: [`operation:${message.operation}`],
        error: {
          code: CODES.ADAPTER_OPERATION_UNSUPPORTED,
          safeMessage: `this adapter does not implement ${message.operation}`,
        },
      });
    }
    return buildResponse(context, await handler(context));
  } catch (cause) {
    const code = cause instanceof Erl2Error ? cause.code : CODES.ADAPTER_EXECUTION_FAULT;
    const safeMessage =
      cause instanceof Error ? cause.message.slice(0, 512) : "unknown adapter fault";
    if (context) return buildResponse(context, { status: "failed", error: { code, safeMessage } });
    return {
      kind: "response",
      protocol_version: ADAPTER_PROTOCOL_VERSION,
      run_id: message.run_id,
      operation: message.operation,
      operation_id: message.operation_id,
      status: "failed",
      mutations: [],
      compensations: [],
      credential_requests: [],
      credential_uses: [],
      egress_attempts: [],
      unsupported_inputs: [],
      error: { code, owner: "adapter", safe_message: safeMessage },
      active_operator_ms: 0,
    };
  }
}

/** Convenience entry point for an adapter's `main` module. */
export async function main(definition: AdapterDefinition): Promise<void> {
  await runAdapter(definition, { input: process.stdin, output: process.stdout });
}
