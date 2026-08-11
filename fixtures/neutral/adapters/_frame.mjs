/**
 * Minimal raw framing for the **neutral** control adapters.
 *
 * Deliberately separate from `fixtures/sabotage/adapters/_frame.mjs`: those
 * fixtures exist to misbehave, and `tests/architecture/adapterSurface.test.ts`
 * enumerates that directory as the hostile set. The adapters here are
 * well-behaved by construction — they exist so a control can observe whether
 * bytes executed at all, which needs an adapter that *would* succeed if the Lab
 * let it.
 */

import { readFileSync } from "node:fs";

export function decodeFrames(buffer) {
  const frames = [];
  let rest = buffer;
  for (;;) {
    const newline = rest.indexOf(0x0a);
    if (newline < 0) break;
    const length = Number.parseInt(rest.subarray(0, newline).toString("ascii"), 10);
    if (!Number.isFinite(length)) break;
    const start = newline + 1;
    if (rest.length < start + length) break;
    frames.push(JSON.parse(rest.subarray(start, start + length).toString("utf8")));
    rest = rest.subarray(start + length);
  }
  return frames;
}

export function writeFrame(value) {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  process.stdout.write(Buffer.concat([Buffer.from(`${body.byteLength}\n`, "ascii"), body]));
}

export function operationMessage() {
  try {
    return decodeFrames(readFileSync(0)).find((f) => f.kind === "operation");
  } catch {
    return undefined;
  }
}

/** One neutral identity, shared by both fixtures. */
export const NEUTRAL_ADAPTER_ID = "neutral-runtime-adapter";

export function negotiation(overrides = {}) {
  return {
    kind: "negotiation",
    protocol_version: "subject-adapter/v1",
    adapter_id: NEUTRAL_ADAPTER_ID,
    adapter_version: "0.1.0",
    supported_operations: ["acquire", "validate-package"],
    supported_package_kinds: ["archive"],
    ...overrides,
  };
}

export function response(message, overrides = {}) {
  return {
    kind: "response",
    protocol_version: "subject-adapter/v1",
    run_id: message.run_id,
    operation: message.operation,
    operation_id: message.operation_id,
    status: "supported",
    result: { ok: true },
    result_schema_version: "neutral/v1",
    mutations: [],
    compensations: [],
    credential_requests: [],
    credential_uses: [],
    egress_attempts: [],
    unsupported_inputs: [],
    active_operator_ms: 1,
    ...overrides,
  };
}
