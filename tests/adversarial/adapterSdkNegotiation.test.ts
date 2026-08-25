/**
 * `@erl2/adapter-sdk`'s own negotiation and dispatch behavior, driven by
 * hand-built wire frames against a real subprocess — no `AdapterHost`
 * involved. `AdapterHost` always sends a negotiate frame and its matching
 * operation frame together, from the same message, so it can never itself
 * produce the mismatched sequences these cases need; only a direct,
 * protocol-level drive can reach them.
 */

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { decodeFrame, encodeFrame } from "@erl2/contracts";
import { referenceAdapterEntry, repoRoot } from "../support/adapterFixtures.js";

const EXECUTION_ID = "018f1111-2222-7333-8444-555555555555";

function localOfferFrame(): Buffer {
  return encodeFrame({
    kind: "negotiate",
    schema_version: "adapter-host-negotiation-request/v2",
    offered_protocol_versions: ["subject-adapter/v2"],
    required_execution_mode: "local_observation",
    execution_id: EXECUTION_ID,
    max_request_bytes: 256 * 1024,
    max_response_bytes: 256 * 1024,
  });
}

function plainV1OfferFrame(): Buffer {
  return encodeFrame({
    kind: "negotiate",
    protocol_version: "subject-adapter/v1",
    run_id: EXECUTION_ID,
    max_request_bytes: 256 * 1024,
    max_response_bytes: 256 * 1024,
  });
}

function v2OperationFrame(): Buffer {
  return encodeFrame({
    kind: "operation",
    schema_version: "adapter-host-operation/v2",
    protocol_version: "subject-adapter/v2",
    execution_mode: "local_observation",
    execution_id: EXECUTION_ID,
    operation: "validate-package",
    operation_id: "op-validate-package",
    request: { schema_version: "validate-package-payload/v1", package_input_id: "package-input", package_kind: "archive" },
    deadline: "2099-01-01T00:00:00Z",
    granted_capability_ids: [],
    mounts: [],
    output_directory: mkdtempSync(path.join(tmpdir(), "erl2-sdk-negotiation-out-")),
    diagnostics_directory: mkdtempSync(path.join(tmpdir(), "erl2-sdk-negotiation-diag-")),
  });
}

function v1OperationFrame(): Buffer {
  return encodeFrame({
    kind: "operation",
    protocol_version: "subject-adapter/v1",
    run_id: EXECUTION_ID,
    operation: "validate-package",
    operation_id: "op-validate-package",
    request: { schema_version: "validate-package-payload/v1", package_input_id: "package-input", package_kind: "archive" },
    deadline: "2099-01-01T00:00:00Z",
    granted_capability_ids: [],
    mounts: [],
    output_directory: mkdtempSync(path.join(tmpdir(), "erl2-sdk-negotiation-out-")),
    diagnostics_directory: mkdtempSync(path.join(tmpdir(), "erl2-sdk-negotiation-diag-")),
  });
}

const SHUTDOWN_FRAME = encodeFrame({ kind: "shutdown" });

function run(entryPath: string, frames: readonly Buffer[]): { readonly status: number | null; readonly stderr: string; readonly responses: unknown[] } {
  const result = spawnSync(process.execPath, [entryPath], {
    input: Buffer.concat([...frames, SHUTDOWN_FRAME]),
    encoding: "buffer",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 15_000,
  });
  let buffer = result.stdout ?? Buffer.alloc(0);
  const responses: unknown[] = [];
  for (;;) {
    const frame = decodeFrame(buffer);
    if (!frame) break;
    buffer = buffer.subarray(frame.consumed);
    responses.push(frame.value);
  }
  return { status: result.status, stderr: (result.stderr ?? Buffer.alloc(0)).toString("utf8"), responses };
}

const LOCAL_ARCHIVE_OBSERVER = path.join(repoRoot, "fixtures", "neutral", "local-archive-observer.mjs");

test("ADAPTER-SDK: a V2-declaring adapter negotiates v2 and dispatches normally", () => {
  // The operation payload here is deliberately minimal, not a fully valid
  // `AdapterRequestV2` envelope (that full contract — ancestry, execution
  // context, core hash — is exercised end to end elsewhere, e.g.
  // trustedLocalOperator.test.ts). The point of this case is narrower and is
  // exactly what fix A/B touch: negotiation must still pick v2, and dispatch
  // must still run and answer with a real response frame, not silence.
  const { status, responses } = run(LOCAL_ARCHIVE_OBSERVER, [localOfferFrame(), v2OperationFrame()]);
  assert.equal(status, 0);
  assert.equal(responses.length, 2);
  const [negotiation, response] = responses as [Record<string, unknown>, Record<string, unknown>];
  assert.equal(negotiation["kind"], "negotiation");
  assert.equal(negotiation["selected_protocol_version"], "subject-adapter/v2");
  assert.equal(response["kind"], "response");
  assert.notEqual((response["error"] as Record<string, unknown> | undefined)?.["code"], "ADAPTER_PROTOCOL_VERSION_MISMATCH");
});

test("ADAPTER-SDK: an adapter that never declares supportedProtocolVersions refuses at negotiation instead of answering V1", () => {
  // `reference-correct` is a real SDK-built adapter that never sets
  // `supportedProtocolVersions`. Against a local, V2-only offer it must now
  // fail loudly inside the adapter process rather than fabricate a V1
  // negotiation and silently drop the operation frame that follows.
  const entryPath = referenceAdapterEntry("reference-correct");
  const { status, stderr, responses } = run(entryPath, [localOfferFrame(), v2OperationFrame()]);
  assert.notEqual(status, 0);
  assert.equal(responses.length, 0, "no frame — honest and loud, not a fabricated negotiation");
  assert.match(stderr, /ADAPTER_PROTOCOL_DOWNGRADE_REFUSED/);
  assert.match(stderr, /supportedProtocolVersions/);
});

test("ADAPTER-SDK: a V1-shaped operation frame after a V2 negotiation gets a typed refusal, not silence", () => {
  const { status, responses } = run(LOCAL_ARCHIVE_OBSERVER, [localOfferFrame(), v1OperationFrame()]);
  assert.equal(status, 0);
  assert.equal(responses.length, 2, "the mismatched operation must still get a response frame");
  const response = responses[1] as Record<string, unknown>;
  assert.equal(response["kind"], "response");
  assert.equal(response["status"], "failed");
  assert.equal((response["error"] as Record<string, unknown>)["code"], "ADAPTER_PROTOCOL_VERSION_MISMATCH");
});

test("ADAPTER-SDK: a V2-shaped operation frame after a plain V1 negotiation gets a typed refusal, not silence", () => {
  const { status, responses } = run(LOCAL_ARCHIVE_OBSERVER, [plainV1OfferFrame(), v2OperationFrame()]);
  assert.equal(status, 0);
  assert.equal(responses.length, 2, "the mismatched operation must still get a response frame");
  const response = responses[1] as Record<string, unknown>;
  assert.equal(response["kind"], "response");
  assert.equal(response["status"], "failed");
  assert.equal((response["error"] as Record<string, unknown>)["code"], "ADAPTER_PROTOCOL_VERSION_MISMATCH");
});
