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
import { CODES, Erl2Error, type AdapterResponseMessage } from "@erl2/contracts";

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
