/**
 * Minimal raw framing for the sabotage adapters.
 *
 * These fixtures deliberately do NOT use `@erl2/adapter-sdk`: an adapter that
 * misbehaves is one that ignores the SDK, so testing the host against
 * SDK-shaped adapters would only prove the SDK works. Everything here speaks
 * the wire format directly and is free to violate it — that is the point.
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

/** Every frame the host wrote, read synchronously from stdin. */
export function hostFrames() {
  try {
    return decodeFrames(readFileSync(0));
  } catch {
    return [];
  }
}

/** The single dispatched operation message, or `undefined`. */
export function operationMessage() {
  return hostFrames().find((f) => f.kind === "operation");
}

export function negotiation(overrides = {}) {
  return {
    kind: "negotiation",
    protocol_version: "subject-adapter/v1",
    adapter_id: "sabotage",
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
    result_schema_version: "sabotage/v1",
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
