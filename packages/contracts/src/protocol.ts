/**
 * The `subject-adapter/v1` wire protocol: framing and the closed message set
 * exchanged between the core-owned adapter host and a subject adapter
 * (design v2 §11.2).
 *
 * It lives in `@erl2/contracts` because both sides — `@erl2/core`'s host and
 * `@erl2/adapter-sdk`'s adapter runtime — must use exactly one implementation.
 * A second copy could drift, and a framing disagreement is a security bug, not
 * a compatibility inconvenience.
 *
 * Framing is a decimal byte length, a newline, then exactly that many bytes of
 * UTF-8 JSON. There is no delimiter inside the payload, so a message cannot be
 * split or smuggled by embedding a newline, and a length that exceeds the
 * negotiated cap is refused before any parsing happens.
 *
 * Identity stays Lab-owned: adapter messages carry *drafts* with no
 * `core_hash`. The host canonicalises, hashes, validates and freezes. An
 * adapter therefore cannot assert an artifact identity at all.
 */

import { CODES, Erl2Error } from "./errors.js";

export const ADAPTER_PROTOCOL_VERSION = "subject-adapter/v1" as const;

/** Absolute ceiling for one frame, independent of what a manifest negotiates. */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

/** Operations the host may dispatch, mirroring `SubjectAdapterV1`. */
export const ADAPTER_OPERATIONS = [
  "acquire",
  "validate-package",
  "install",
  "configure",
  "start",
  "interact",
  "translate-evidence",
  "collect-outputs",
  "project",
  "stop",
  "uninstall",
  "report-residue",
  "compensate",
] as const;

export type AdapterOperation = (typeof ADAPTER_OPERATIONS)[number];

export function isAdapterOperation(value: string): value is AdapterOperation {
  return (ADAPTER_OPERATIONS as readonly string[]).includes(value);
}

/**
 * Package kind is carried as the frozen artifact's media type.
 *
 * It has to travel *somewhere* an adapter can read: a package-verification
 * request must not gain a `subject_package_manifest_hash`, because the manifest
 * is what verification produces. The media type of the already-frozen bytes is
 * subject-visible, pre-verification information, so it is the right carrier.
 */
export const PACKAGE_MEDIA_TYPE_PREFIX = "application/vnd.erl2.package." as const;

export const PACKAGE_KINDS = ["archive", "oci", "native", "bundle"] as const;
export type PackageKind = (typeof PACKAGE_KINDS)[number];

export function packageMediaType(kind: PackageKind): string {
  return `${PACKAGE_MEDIA_TYPE_PREFIX}${kind}`;
}

/** Reads the package kind from a media type, or `undefined` when absent. */
export function packageKindFromMediaType(mediaType: string): PackageKind | undefined {
  if (!mediaType.startsWith(PACKAGE_MEDIA_TYPE_PREFIX)) return undefined;
  const kind = mediaType.slice(PACKAGE_MEDIA_TYPE_PREFIX.length);
  return (PACKAGE_KINDS as readonly string[]).includes(kind) ? (kind as PackageKind) : undefined;
}

// -- host -> adapter ---------------------------------------------------------

export interface HostNegotiateMessage {
  readonly kind: "negotiate";
  readonly protocol_version: typeof ADAPTER_PROTOCOL_VERSION;
  readonly run_id: string;
  readonly max_request_bytes: number;
  readonly max_response_bytes: number;
}

/**
 * One dispatched operation.
 *
 * `request` is exactly the closed phase contract for this operation — an
 * acquisition request, a package-verification request or a post-plan step
 * request — and nothing else. `mounts` and `output_directory` are absolute
 * paths the host has already confined; the adapter may not construct others.
 */
export interface HostOperationMessage {
  readonly kind: "operation";
  readonly protocol_version: typeof ADAPTER_PROTOCOL_VERSION;
  readonly run_id: string;
  readonly operation: AdapterOperation;
  readonly operation_id: string;
  readonly request: unknown;
  readonly mounts: readonly {
    readonly mount_id: string;
    readonly absolute_path: string;
    readonly purpose: "subject-visible-input" | "canonical-evidence" | "frozen-package";
  }[];
  readonly output_directory: string;
  readonly diagnostics_directory: string;
  readonly granted_capability_ids: readonly string[];
  readonly deadline: string;
}

export interface HostShutdownMessage {
  readonly kind: "shutdown";
}

export type HostMessage = HostNegotiateMessage | HostOperationMessage | HostShutdownMessage;

// -- adapter -> host ---------------------------------------------------------

export interface AdapterNegotiationMessage {
  readonly kind: "negotiation";
  readonly protocol_version: string;
  readonly adapter_id: string;
  readonly adapter_version: string;
  readonly supported_operations: readonly string[];
  readonly supported_package_kinds: readonly string[];
}

/**
 * A declared mutation, before it happens.
 *
 * Descriptors are short strings; the host derives every identity hash from
 * them, so an adapter cannot name a target by a hash it invented.
 */
export interface MutationDraft {
  readonly mutation_id: string;
  readonly mutation_class:
    | "filesystem"
    | "service"
    | "configuration"
    | "package"
    | "credential"
    | "environment";
  readonly capability_id: string;
  readonly target_descriptor: string;
  readonly before_state_descriptor: string;
  readonly after_state_descriptor: string;
  readonly compensation_id: string;
  readonly compensation_capability_id: string;
  readonly status: "succeeded" | "failed";
  readonly error_code?: string;
}

export interface CompensationDraft {
  readonly compensation_id: string;
  readonly mutation_id: string;
  readonly after_state_descriptor: string;
  readonly status: "succeeded" | "failed" | "not_required";
  readonly reason_code?: string;
}

export interface CredentialHandleRequestDraft {
  readonly handle_request_id: string;
  readonly credential_reference_kind:
    | "development-keychain-reference"
    | "workload-identity-reference"
    | "short-lived-token-reference";
  readonly requested_scope_ids: readonly string[];
  readonly requested_ttl_seconds: number;
  readonly requested_max_uses: number;
  readonly target_descriptor: string;
  readonly purpose_code: string;
}

export interface CredentialUseDraft {
  readonly handle_id: string;
  readonly used_scope_id: string;
  readonly target_descriptor: string;
}

export interface EgressAttemptDraft {
  readonly decision_id: string;
  readonly url: string;
  readonly redirect_chain: readonly string[];
  readonly resolved_addresses: readonly string[];
}

/** The adapter's answer to one operation. */
export interface AdapterResponseMessage {
  readonly kind: "response";
  readonly protocol_version: string;
  readonly run_id: string;
  readonly operation: string;
  readonly operation_id: string;
  readonly status: "supported" | "failed" | "unsupported";
  /** Operation-specific payload; the host validates it against its contract. */
  readonly result?: unknown;
  readonly result_schema_version?: string;
  readonly mutations: readonly MutationDraft[];
  readonly compensations: readonly CompensationDraft[];
  readonly credential_requests: readonly CredentialHandleRequestDraft[];
  readonly credential_uses: readonly CredentialUseDraft[];
  readonly egress_attempts: readonly EgressAttemptDraft[];
  readonly unsupported_inputs: readonly string[];
  readonly error?: {
    readonly code: string;
    readonly owner: "adapter" | "subject";
    readonly safe_message: string;
  };
  readonly active_operator_ms: number;
}

export type AdapterMessage = AdapterNegotiationMessage | AdapterResponseMessage;

// -- framing -----------------------------------------------------------------

/** Encodes one message as `<byte length>\n<utf-8 json>`. */
export function encodeFrame(message: unknown, maxBytes: number = MAX_FRAME_BYTES): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  if (body.byteLength > maxBytes) {
    throw new Erl2Error(
      CODES.ADAPTER_RESPONSE_OVERSIZED,
      `frame of ${String(body.byteLength)} bytes exceeds the negotiated ${String(maxBytes)}`,
    );
  }
  return Buffer.concat([Buffer.from(`${String(body.byteLength)}\n`, "ascii"), body]);
}

export interface DecodedFrame {
  readonly value: unknown;
  readonly consumed: number;
  readonly byteLength: number;
}

/**
 * Decodes the first complete frame in `buffer`, or returns `undefined` when
 * more bytes are needed.  A malformed header or an oversized declared length
 * is refused immediately: the payload is never buffered.
 */
export function decodeFrame(buffer: Buffer, maxBytes: number = MAX_FRAME_BYTES): DecodedFrame | undefined {
  const newline = buffer.indexOf(0x0a);
  if (newline < 0) {
    if (buffer.byteLength > 24) {
      throw new Erl2Error(
        CODES.ADAPTER_PROTOCOL_FRAME_INVALID,
        "frame header has no length terminator",
      );
    }
    return undefined;
  }
  const header = buffer.subarray(0, newline).toString("ascii");
  if (!/^[0-9]{1,9}$/.test(header)) {
    throw new Erl2Error(
      CODES.ADAPTER_PROTOCOL_FRAME_INVALID,
      `frame header ${JSON.stringify(header.slice(0, 32))} is not a decimal byte length`,
    );
  }
  const declared = Number.parseInt(header, 10);
  if (declared > maxBytes) {
    throw new Erl2Error(
      CODES.ADAPTER_RESPONSE_OVERSIZED,
      `frame declares ${String(declared)} bytes; the negotiated maximum is ${String(maxBytes)}`,
    );
  }
  const start = newline + 1;
  if (buffer.byteLength < start + declared) return undefined;
  const body = buffer.subarray(start, start + declared).toString("utf8");
  let value: unknown;
  try {
    value = JSON.parse(body) as unknown;
  } catch (cause) {
    throw new Erl2Error(CODES.ADAPTER_PROTOCOL_FRAME_INVALID, "frame body is not valid JSON", {
      cause,
    });
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Erl2Error(CODES.ADAPTER_PROTOCOL_FRAME_INVALID, "frame body is not a JSON object");
  }
  return { value, consumed: start + declared, byteLength: declared };
}
