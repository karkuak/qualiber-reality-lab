/**
 * Structural validation of the adapter *response* wire frame (review P2-6).
 *
 * `AdapterResponseMessage` is a handwritten protocol type (`@erl2/contracts`
 * `protocol.ts`), not a generated closed schema, so nothing validated it before
 * the host iterated `response.mutations` / `compensations` / `credential_requests`
 * / `egress_attempts`.  A hostile adapter that omitted an array crashed the
 * production path with an untyped `TypeError: … is not iterable` — escaping as an
 * uncaught error with no `code`/`owner` (§11.2 host contract: a broken or hostile
 * adapter must always yield a *typed* adapter/Lab outcome).
 *
 * This validator closes that gap: it rejects a malformed, mistyped or
 * unknown-field response with a typed, adapter-owned refusal *before* any field
 * is read or any array iterated.  It is a closed validator — unexpected keys are
 * refused, exactly as a generated schema's `additionalProperties:false` would.
 * (§11.13 tracks replacing this with a generated closed schema; until then the
 * host owns this check explicitly.)
 */
import {
  CODES,
  Erl2Error,
  type AdapterResponseMessage,
  type AdapterResponseMessageV2,
  type LocalResidueObservationDraft,
} from "@erl2/contracts";

function refuse(detail: string): never {
  throw new Erl2Error(CODES.ADAPTER_PROTOCOL_FRAME_INVALID, `malformed adapter response: ${detail}`, {
    owner: "adapter",
  });
}

function asObject(value: unknown, at: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) refuse(`${at} is not an object`);
  return value as Record<string, unknown>;
}

function closedKeys(record: Record<string, unknown>, allowed: readonly string[], at: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) refuse(`${at} has unexpected field ${JSON.stringify(key)}`);
  }
}

function str(record: Record<string, unknown>, key: string, at: string): void {
  if (typeof record[key] !== "string") refuse(`${at}.${key} is not a string`);
}

function optionalStr(record: Record<string, unknown>, key: string, at: string): void {
  if (record[key] !== undefined && typeof record[key] !== "string") refuse(`${at}.${key} is not a string`);
}

function num(record: Record<string, unknown>, key: string, at: string): void {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) refuse(`${at}.${key} is not a finite number`);
}

function enumStr(record: Record<string, unknown>, key: string, values: readonly string[], at: string): void {
  if (typeof record[key] !== "string" || !values.includes(record[key] as string)) {
    refuse(`${at}.${key} is not one of ${values.join("|")}`);
  }
}

function arrayOf(
  record: Record<string, unknown>,
  key: string,
  at: string,
  each: (element: Record<string, unknown>, elementAt: string) => void,
): void {
  const value = record[key];
  if (!Array.isArray(value)) refuse(`${at}.${key} is not an array`);
  (value as unknown[]).forEach((element, i) => each(asObject(element, `${at}.${key}[${String(i)}]`), `${at}.${key}[${String(i)}]`));
}

function stringArray(record: Record<string, unknown>, key: string, at: string): void {
  const value = record[key];
  if (!Array.isArray(value)) refuse(`${at}.${key} is not an array`);
  (value as unknown[]).forEach((element, i) => {
    if (typeof element !== "string") refuse(`${at}.${key}[${String(i)}] is not a string`);
  });
}

const MUTATION_KEYS = [
  "mutation_id", "mutation_class", "capability_id", "target_descriptor", "before_state_descriptor",
  "after_state_descriptor", "compensation_id", "compensation_capability_id", "status", "error_code",
];
const COMPENSATION_KEYS = ["compensation_id", "mutation_id", "after_state_descriptor", "status", "reason_code"];
const CRED_REQ_KEYS = [
  "handle_request_id", "credential_reference_kind", "requested_scope_ids", "requested_ttl_seconds",
  "requested_max_uses", "target_descriptor", "purpose_code",
];
const CRED_USE_KEYS = ["handle_id", "used_scope_id", "target_descriptor"];
const EGRESS_KEYS = ["decision_id", "url", "redirect_chain", "resolved_addresses"];
const RESPONSE_KEYS = [
  "kind", "protocol_version", "run_id", "operation", "operation_id", "status", "result",
  "result_schema_version", "mutations", "compensations", "credential_requests", "credential_uses",
  "egress_attempts", "unsupported_inputs", "error", "active_operator_ms",
];
const RESPONSE_KEYS_V2 = [
  "kind", "schema_version", "protocol_version", "execution_mode", "execution_id", "operation",
  "operation_id", "status", "result", "result_schema_version", "mutations", "compensations",
  "credential_requests", "credential_uses", "egress_attempts", "unsupported_inputs", "error",
  "active_operator_ms",
];

/**
 * Validates the complete adapter response frame and returns it typed.  Throws a
 * typed, adapter-owned refusal on any structural defect.
 */
export function assertAdapterResponseShape(value: unknown): AdapterResponseMessage {
  const record = asObject(value, "response");
  closedKeys(record, RESPONSE_KEYS, "response");
  if (record["kind"] !== "response") refuse("kind is not \"response\"");
  str(record, "protocol_version", "response");
  str(record, "run_id", "response");
  str(record, "operation", "response");
  str(record, "operation_id", "response");
  enumStr(record, "status", ["supported", "failed", "unsupported"], "response");
  optionalStr(record, "result_schema_version", "response");
  num(record, "active_operator_ms", "response");

  arrayOf(record, "mutations", "response", (m, at) => {
    closedKeys(m, MUTATION_KEYS, at);
    str(m, "mutation_id", at);
    enumStr(m, "mutation_class", ["filesystem", "service", "configuration", "package", "credential", "environment"], at);
    str(m, "capability_id", at);
    str(m, "target_descriptor", at);
    str(m, "before_state_descriptor", at);
    str(m, "after_state_descriptor", at);
    str(m, "compensation_id", at);
    str(m, "compensation_capability_id", at);
    enumStr(m, "status", ["succeeded", "failed"], at);
    optionalStr(m, "error_code", at);
  });
  arrayOf(record, "compensations", "response", (c, at) => {
    closedKeys(c, COMPENSATION_KEYS, at);
    str(c, "compensation_id", at);
    str(c, "mutation_id", at);
    str(c, "after_state_descriptor", at);
    enumStr(c, "status", ["succeeded", "failed", "not_required"], at);
    optionalStr(c, "reason_code", at);
  });
  arrayOf(record, "credential_requests", "response", (r, at) => {
    closedKeys(r, CRED_REQ_KEYS, at);
    str(r, "handle_request_id", at);
    enumStr(r, "credential_reference_kind",
      ["development-keychain-reference", "workload-identity-reference", "short-lived-token-reference"], at);
    stringArray(r, "requested_scope_ids", at);
    num(r, "requested_ttl_seconds", at);
    num(r, "requested_max_uses", at);
    str(r, "target_descriptor", at);
    str(r, "purpose_code", at);
  });
  arrayOf(record, "credential_uses", "response", (u, at) => {
    closedKeys(u, CRED_USE_KEYS, at);
    str(u, "handle_id", at);
    str(u, "used_scope_id", at);
    str(u, "target_descriptor", at);
  });
  arrayOf(record, "egress_attempts", "response", (e, at) => {
    closedKeys(e, EGRESS_KEYS, at);
    str(e, "decision_id", at);
    str(e, "url", at);
    stringArray(e, "redirect_chain", at);
    stringArray(e, "resolved_addresses", at);
  });
  stringArray(record, "unsupported_inputs", "response");

  if (record["error"] !== undefined) {
    const error = asObject(record["error"], "response.error");
    closedKeys(error, ["code", "owner", "safe_message"], "response.error");
    str(error, "code", "response.error");
    enumStr(error, "owner", ["adapter", "subject"], "response.error");
    str(error, "safe_message", "response.error");
  }

  return value as AdapterResponseMessage;
}

/** The same closed draft validation with the V2 mode/execution discriminators. */
export function assertAdapterResponseShapeV2(value: unknown): AdapterResponseMessageV2 {
  const record = asObject(value, "response");
  closedKeys(record, RESPONSE_KEYS_V2, "response");
  if (record["kind"] !== "response") refuse("kind is not \"response\"");
  if (record["schema_version"] !== "adapter-response-message/v2") {
    refuse("schema_version is not adapter-response-message/v2");
  }
  str(record, "protocol_version", "response");
  str(record, "execution_mode", "response");
  str(record, "execution_id", "response");
  str(record, "operation", "response");
  str(record, "operation_id", "response");
  enumStr(record, "status", ["supported", "failed", "unsupported"], "response");
  optionalStr(record, "result_schema_version", "response");
  num(record, "active_operator_ms", "response");

  arrayOf(record, "mutations", "response", (m, at) => {
    closedKeys(m, MUTATION_KEYS, at);
    str(m, "mutation_id", at);
    enumStr(m, "mutation_class", ["filesystem", "service", "configuration", "package", "credential", "environment"], at);
    str(m, "capability_id", at);
    str(m, "target_descriptor", at);
    str(m, "before_state_descriptor", at);
    str(m, "after_state_descriptor", at);
    str(m, "compensation_id", at);
    str(m, "compensation_capability_id", at);
    enumStr(m, "status", ["succeeded", "failed"], at);
    optionalStr(m, "error_code", at);
  });
  arrayOf(record, "compensations", "response", (c, at) => {
    closedKeys(c, COMPENSATION_KEYS, at);
    str(c, "compensation_id", at);
    str(c, "mutation_id", at);
    str(c, "after_state_descriptor", at);
    enumStr(c, "status", ["succeeded", "failed", "not_required"], at);
    optionalStr(c, "reason_code", at);
  });
  arrayOf(record, "credential_requests", "response", (r, at) => {
    closedKeys(r, CRED_REQ_KEYS, at);
    str(r, "handle_request_id", at);
    enumStr(r, "credential_reference_kind",
      ["development-keychain-reference", "workload-identity-reference", "short-lived-token-reference"], at);
    stringArray(r, "requested_scope_ids", at);
    num(r, "requested_ttl_seconds", at);
    num(r, "requested_max_uses", at);
    str(r, "target_descriptor", at);
    str(r, "purpose_code", at);
  });
  arrayOf(record, "credential_uses", "response", (u, at) => {
    closedKeys(u, CRED_USE_KEYS, at);
    str(u, "handle_id", at);
    str(u, "used_scope_id", at);
    str(u, "target_descriptor", at);
  });
  arrayOf(record, "egress_attempts", "response", (e, at) => {
    closedKeys(e, EGRESS_KEYS, at);
    str(e, "decision_id", at);
    str(e, "url", at);
    stringArray(e, "redirect_chain", at);
    stringArray(e, "resolved_addresses", at);
  });
  stringArray(record, "unsupported_inputs", "response");
  if (record["error"] !== undefined) {
    const error = asObject(record["error"], "response.error");
    closedKeys(error, ["code", "owner", "safe_message"], "response.error");
    str(error, "code", "response.error");
    enumStr(error, "owner", ["adapter", "subject"], "response.error");
    str(error, "safe_message", "response.error");
  }
  if (record["status"] === "supported" && record["error"] !== undefined) {
    refuse("supported response carries an error");
  }
  if (record["status"] !== "supported" && record["error"] === undefined) {
    refuse("failed or unsupported response omits its error");
  }
  const unsupported = record["unsupported_inputs"] as unknown[];
  if (record["status"] === "unsupported" ? unsupported.length === 0 : unsupported.length !== 0) {
    refuse("unsupported_inputs do not match response status");
  }
  return value as AdapterResponseMessageV2;
}

const RESIDUE_KEYS = [
  "schema_version", "checkpoint", "status", "residual_resources", "residual_paths",
];

/**
 * Validates the adapter's residue draft for one `report-residue` operation.
 *
 * Refusals here are typed `ADAPTER_LOCAL_RESIDUE_REPORT_INVALID` rather than the
 * generic frame code, because "the adapter's residue report is unusable" is a
 * different fact from "the frame is malformed", and the cleanup reducer must be
 * able to tell them apart without guessing.
 *
 * The consistency rules are the load-bearing part. A report is refused when it
 * says `clean` while naming residual resources or paths, and when it says
 * `residue_detected` while naming none. Without them an adapter could report
 * fifty leftover artifacts under a `clean` status, or an empty
 * `residue_detected`, and the reducer would faithfully propagate a contradiction.
 * There is no "believe the status and ignore the evidence" path.
 */
export function assertLocalResidueObservationDraft(
  value: unknown,
  checkpoint: string,
): LocalResidueObservationDraft {
  const bad = (detail: string): never => {
    throw new Erl2Error(
      CODES.ADAPTER_LOCAL_RESIDUE_REPORT_INVALID,
      `unusable local residue report: ${detail}`,
      { owner: "adapter" },
    );
  };
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return bad("the report is not an object");
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!RESIDUE_KEYS.includes(key)) return bad(`unexpected field ${JSON.stringify(key)}`);
  }
  for (const key of RESIDUE_KEYS) {
    if (record[key] === undefined) return bad(`missing field ${key}`);
  }
  if (record["schema_version"] !== "local-residue-observation/v1") {
    return bad("schema_version is not local-residue-observation/v1");
  }
  if (!["baseline", "post_operation", "final"].includes(record["checkpoint"] as string)) {
    return bad("checkpoint is not one of baseline|post_operation|final");
  }
  // The report must describe the checkpoint the host actually requested;
  // otherwise a baseline observation could be retained as the final one.
  if (record["checkpoint"] !== checkpoint) {
    return bad(`report describes checkpoint ${String(record["checkpoint"])}, not the dispatched ${checkpoint}`);
  }
  if (!["clean", "residue_detected", "unknown"].includes(record["status"] as string)) {
    return bad("status is not one of clean|residue_detected|unknown");
  }
  const resources = record["residual_resources"];
  if (!Array.isArray(resources) || resources.length > 1024) return bad("residual_resources is not a bounded array");
  resources.forEach((element, i) => {
    if (element === null || typeof element !== "object" || Array.isArray(element)) {
      return bad(`residual_resources[${String(i)}] is not an object`);
    }
    const entry = element as Record<string, unknown>;
    for (const key of Object.keys(entry)) {
      if (key !== "kind" && key !== "identity_hash") {
        return bad(`residual_resources[${String(i)}] has unexpected field ${JSON.stringify(key)}`);
      }
    }
    if (typeof entry["kind"] !== "string" || typeof entry["identity_hash"] !== "string") {
      return bad(`residual_resources[${String(i)}] is not a kind/identity_hash pair`);
    }
    return undefined;
  });
  const paths = record["residual_paths"];
  if (!Array.isArray(paths) || paths.length > 256) return bad("residual_paths is not a bounded array");
  paths.forEach((element, i) => {
    if (typeof element !== "string" || element.length === 0 || element.length > 256) {
      return bad(`residual_paths[${String(i)}] is not a bounded non-empty string`);
    }
    return undefined;
  });

  const named = resources.length + paths.length;
  if (record["status"] === "clean" && named > 0) {
    return bad(`status clean contradicts ${String(named)} named residual item(s)`);
  }
  if (record["status"] === "residue_detected" && named === 0) {
    return bad("status residue_detected names no residual item");
  }
  return value as LocalResidueObservationDraft;
}
