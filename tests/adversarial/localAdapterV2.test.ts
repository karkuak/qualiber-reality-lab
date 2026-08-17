import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  CODES,
  Erl2Error,
  assertContract,
  type AdapterRequestV2,
  type AdapterOperation,
  type SubjectAdapterCertificationReceiptV1,
  type SubjectAdapterCertificationReceiptV2,
  type SubjectAdapterManifestV2,
} from "@erl2/contracts";
import { ArtifactStore, coreHash, developmentKey, hashBytes, sealSigned } from "@erl2/integrity";
import {
  AdapterHost,
  SteppingClock,
  assertEnvironmentAllowlisted,
  certifyAdapterV2Scope,
  sandboxControlReport,
  verifyLocalAdapterCertificationV2,
} from "@erl2/core";
import { REFERENCE_CORRECT_MANIFEST, referenceAdapterEntry } from "../support/adapterFixtures.js";
import {
  ARCHIVE_SHAPE,
  BUNDLE_SHAPE,
  LOCAL_NOW,
  LOCAL_RUN_ID,
  localFixture,
  localManifest,
  localPlan,
  localReceipt,
  localRequest,
  newLocalHost,
  type LocalFixtureShape,
} from "../support/localObservationFixtures.js";

function refusal(fn: () => unknown): Erl2Error {
  try {
    fn();
  } catch (cause) {
    if (cause instanceof Erl2Error) return cause;
    throw cause;
  }
  throw new Error("expected a typed refusal");
}

test("LOCAL-V2: both neutral fixture shapes use the real subprocess protocol path", () => {
  for (const shape of [ARCHIVE_SHAPE, BUNDLE_SHAPE]) {
    const fixture = newLocalHost(shape);
    const result = fixture.host.run({
      operation: fixture.request.operation,
      operationId: fixture.request.operation_id,
      request: fixture.request,
      executionMode: "local_observation",
    });
    assert.equal(result.envelope.schema_version, "adapter-response-envelope/v2");
    assert.equal(result.envelope.execution_mode, "local_observation");
    assert.equal(result.envelope.request_core_hash, fixture.request.core_hash);
    assert.equal(result.envelope.status, "supported");
    assert.equal(result.sandboxManifest.schema_version, "sandbox-invocation-manifest/v2");
    assert.deepEqual(
      result.sandboxManifest.environment_variable_names,
      fixture.plan.resource_limits.environment_variable_names,
    );
    assert.equal(result.retained.outputRefs.length, 1);
  }
});

test("LOCAL-V2: V1 remains the default and cannot be selected for local mode", () => {
  const v1 = REFERENCE_CORRECT_MANIFEST();
  const host = new AdapterHost({
    runId: LOCAL_RUN_ID,
    adapterManifest: v1,
    adapterEntryPath: referenceAdapterEntry("reference-correct"),
    workspaceRoot: mkdtempSync(path.join(tmpdir(), "erl2-v1-local-refusal-")),
    store: new ArtifactStore(mkdtempSync(path.join(tmpdir(), "erl2-v1-local-store-"))),
    clock: new SteppingClock(LOCAL_NOW, 1000),
  });
  const error = refusal(() =>
    host.run({
      operation: "acquire",
      operationId: "local-op-one",
      request: localFixture().request,
      executionMode: "local_observation",
    }),
  );
  assert.equal(error.code, CODES.ADAPTER_EXECUTION_MODE_UNSUPPORTED);
});

test("LOCAL-V2: a V1 SDK response to the V2-only offer is a downgrade refusal", () => {
  const shape: LocalFixtureShape = {
    ...ARCHIVE_SHAPE,
    adapterId: "reference-correct",
    operation: "acquire",
    payload: {
      schema_version: "acquire-payload/v1",
      provenance_mode: "acquired",
      source_descriptor_input_id: "package-input",
      output_input_id: "package-output",
      expected_package_kind: "archive",
      credential_handle_ids: [],
    },
    entryName: "unused",
  };
  const entryPath = referenceAdapterEntry("reference-correct");
  const manifest = localManifestForEntry(shape, entryPath);
  const receipt = localReceipt(manifest, shape);
  const plan = localPlan(manifest, receipt, shape);
  const request = localRequest(manifest, plan, shape);
  const host = new AdapterHost({
    runId: LOCAL_RUN_ID,
    adapterManifest: manifest,
    localAuthorityV2: { mode: "certified_external", receipt },
    localObservationPlan: plan,
    adapterEntryPath: entryPath,
    workspaceRoot: mkdtempSync(path.join(tmpdir(), "erl2-v2-downgrade-")),
    store: new ArtifactStore(mkdtempSync(path.join(tmpdir(), "erl2-v2-downgrade-store-"))),
    clock: new SteppingClock(LOCAL_NOW, 1000),
    wallClockMs: 10_000,
  });
  const error = refusal(() =>
    host.run({ operation: "acquire", operationId: request.operation_id, request, executionMode: "local_observation" }),
  );
  assert.equal(error.code, CODES.ADAPTER_PROTOCOL_DOWNGRADE_REFUSED);
});

test("LOCAL-V2: governed V2 is rejected before executable dispatch", () => {
  const fixture = newLocalHost();
  const governed = structuredClone(fixture.request) as unknown as Record<string, unknown>;
  governed["execution_context"] = {
    mode: "governed",
    phase: "post_plan",
    execution_plan_hash: `sha256:${"1".repeat(64)}`,
    visible_step: {
      artifact: { path: "step.json", media_type: "application/json", byte_length: 2, file_sha256: `sha256:${"2".repeat(64)}`, classification: "PUBLIC" },
      core_hash: `sha256:${"3".repeat(64)}`,
    },
    prior_visible_interaction_hashes: [],
    resource_limit_hash: `sha256:${"4".repeat(64)}`,
    credential_handle_ids: [],
  };
  const withoutHash = { ...governed };
  delete withoutHash["core_hash"];
  governed["core_hash"] = coreHash(withoutHash);
  const error = refusal(() =>
    fixture.host.run({
      operation: fixture.request.operation,
      operationId: fixture.request.operation_id,
      request: governed as unknown as AdapterRequestV2,
      executionMode: "local_observation",
    }),
  );
  assert.equal(error.code, CODES.ADAPTER_EXECUTION_MODE_UNSUPPORTED);
});

test("LOCAL-V2: V1 receipts and altered manifest/artifact/profile scope never authorize V2", () => {
  const fixture = localFixture();
  const v1Receipt = {
    schema_version: "subject-adapter-certification-receipt/v1",
  } as SubjectAdapterCertificationReceiptV1;
  assert.equal(
    refusal(() =>
      verifyLocalAdapterCertificationV2({
        manifest: fixture.manifest,
        receipt: v1Receipt as unknown as typeof fixture.receipt,
      }),
    ).code,
    CODES.ADAPTER_CERTIFICATION_SCOPE_MISMATCH,
  );

  const staleManifest = { ...fixture.manifest, owner: "altered owner" };
  assert.equal(
    refusal(() =>
      verifyLocalAdapterCertificationV2({ manifest: staleManifest, receipt: fixture.receipt }),
    ).code,
    CODES.ARTIFACT_HASH_MISMATCH,
  );
  assert.equal(
    refusal(() =>
      verifyLocalAdapterCertificationV2({
        manifest: fixture.manifest,
        receipt: fixture.receipt,
        entryDigest: `sha256:${"f".repeat(64)}`,
      }),
    ).code,
    CODES.ADAPTER_IDENTITY_MISMATCH,
  );
  const broadened = structuredClone(fixture.receipt) as unknown as Record<string, unknown>;
  broadened["certified_operations"] = [fixture.request.operation, "install"];
  const receiptBase = { ...broadened };
  delete receiptBase["core_hash"];
  broadened["core_hash"] = coreHash(receiptBase);
  assert.equal(
    refusal(() => verifyLocalAdapterCertificationV2({
      manifest: fixture.manifest,
      receipt: broadened as unknown as SubjectAdapterCertificationReceiptV2,
    })).code,
    CODES.ADAPTER_CERTIFICATION_SCOPE_MISMATCH,
  );
});

test("LOCAL-LIMITS: plan ceilings intersect with host, output, diagnostics and controls", () => {
  const fixture = localFixture();
  assert.equal(
    refusal(() =>
      new AdapterHost({
        runId: LOCAL_RUN_ID,
        adapterManifest: fixture.manifest,
        localAuthorityV2: { mode: "certified_external", receipt: fixture.receipt },
        localObservationPlan: fixture.plan,
        adapterEntryPath: path.join(process.cwd(), "fixtures", "neutral", "local-archive-observer.mjs"),
        workspaceRoot: mkdtempSync(path.join(tmpdir(), "erl2-limit-high-")),
        store: new ArtifactStore(mkdtempSync(path.join(tmpdir(), "erl2-limit-high-store-"))),
        clock: new SteppingClock(LOCAL_NOW, 1000),
        maxResponseBytes: fixture.plan.resource_limits.max_response_bytes - 1,
      }),
    ).code,
    CODES.ADAPTER_LOCAL_LIMIT_EXCEEDED,
  );

  const tighter = localFixtureWithLimits({ max_output_bytes: 1, max_diagnostic_line_bytes: 32 });
  const host = hostFor(tighter);
  assert.equal(
    refusal(() =>
      host.run({
        operation: tighter.request.operation,
        operationId: tighter.request.operation_id,
        request: tighter.request,
        executionMode: "local_observation",
      }),
    ).code,
    CODES.SUBJECT_OUTPUT_LIMIT_EXCEEDED,
  );

  const unavailable = localFixtureWithLimits({}, "enforced");
  assert.equal(refusal(() => hostFor(unavailable)).code, CODES.ADAPTER_SANDBOX_CONTROL_UNSUPPORTED);
  const report = sandboxControlReport("local-process");
  assert.equal(report.find((control) => control.control_id === "deny-by-default-egress")?.state, "unsupported_on_this_host");
});

test("LOCAL-LIMITS: timeout, response bomb and diagnostic-line bomb reuse existing host enforcement", () => {
  const timed = boundaryFixture("start", { wall_clock_ms: 100 });
  assert.equal(
    refusal(() =>
      timed.host.run({
        operation: timed.request.operation,
        operationId: timed.request.operation_id,
        request: timed.request,
        executionMode: "local_observation",
      }),
    ).code,
    CODES.ADAPTER_DEADLINE_EXCEEDED,
  );

  const diagnostic = boundaryFixture("interact", { max_diagnostic_line_bytes: 32 });
  const diagnosticResult = diagnostic.host.run({
    operation: diagnostic.request.operation,
    operationId: diagnostic.request.operation_id,
    request: diagnostic.request,
    executionMode: "local_observation",
  });
  assert.equal(diagnosticResult.envelope.status, "supported");
  assert.ok(diagnosticResult.diagnostics.entries[0]!.byte_length <= 33);

  const bombRoot = mkdtempSync(path.join(tmpdir(), "erl2-local-response-bomb-"));
  const bombEntry = path.join(bombRoot, "adapter.mjs");
  writeFileSync(bombEntry, 'process.stdout.write("x".repeat(1048576));\n');
  const bomb = fixtureForEntry(ARCHIVE_SHAPE, bombEntry);
  assert.equal(
    refusal(() =>
      bomb.host.run({
        operation: bomb.request.operation,
        operationId: bomb.request.operation_id,
        request: bomb.request,
        executionMode: "local_observation",
      }),
    ).code,
    CODES.ADAPTER_RESPONSE_OVERSIZED,
  );
});

test("LOCAL-CONTROLS: egress, redirect, proxy environment and capabilities fail closed", () => {
  const metadata = boundaryFixture("acquire");
  assert.equal(
    refusal(() =>
      metadata.host.run({
        operation: metadata.request.operation,
        operationId: metadata.request.operation_id,
        request: metadata.request,
        executionMode: "local_observation",
      }),
    ).code,
    CODES.ADAPTER_EGRESS_METADATA_SERVICE_DENIED,
  );

  const redirect = boundaryFixture("project", {}, true);
  assert.equal(
    refusal(() =>
      redirect.host.run({
        operation: redirect.request.operation,
        operationId: redirect.request.operation_id,
        request: redirect.request,
        executionMode: "local_observation",
      }),
    ).code,
    CODES.ADAPTER_EGRESS_REDIRECT_ESCAPED,
  );

  assert.equal(
    refusal(() =>
      assertEnvironmentAllowlisted(
        { HTTP_PROXY: "http://127.0.0.1:8080" },
        ["ERL2_ADAPTER_PROTOCOL_VERSION", "ERL2_EXECUTION_ID", "ERL2_EXECUTION_MODE", "ERL2_OPERATION_ID"],
      ),
    ).code,
    CODES.ADAPTER_ENVIRONMENT_VARIABLE_DENIED,
  );

  const ordinary = newLocalHost();
  assert.equal(
    refusal(() =>
      ordinary.host.run({
        operation: ordinary.request.operation,
        operationId: ordinary.request.operation_id,
        request: ordinary.request,
        executionMode: "local_observation",
        requestedCapabilityIds: ["network-egress"],
      }),
    ).code,
    CODES.ADAPTER_CAPABILITY_NOT_GRANTED,
  );
});

test("LOCAL-V2: per-dispatch artifact verification is load-bearing", () => {
  const source = path.join(process.cwd(), "fixtures", "neutral", "local-archive-observer.mjs");
  const entryPath = path.join(mkdtempSync(path.join(tmpdir(), "erl2-local-tamper-")), "adapter.mjs");
  const bytes = readFileSync(source);
  writeFileSync(entryPath, bytes);
  const manifest = localManifestForEntry(ARCHIVE_SHAPE, entryPath);
  const receipt = localReceipt(manifest, ARCHIVE_SHAPE);
  const plan = localPlan(manifest, receipt, ARCHIVE_SHAPE);
  const request = localRequest(manifest, plan, ARCHIVE_SHAPE);
  const host = new AdapterHost({
    runId: LOCAL_RUN_ID,
    adapterManifest: manifest,
    localAuthorityV2: { mode: "certified_external", receipt },
    localObservationPlan: plan,
    adapterEntryPath: entryPath,
    workspaceRoot: mkdtempSync(path.join(tmpdir(), "erl2-local-tamper-ws-")),
    store: new ArtifactStore(mkdtempSync(path.join(tmpdir(), "erl2-local-tamper-store-"))),
    clock: new SteppingClock(LOCAL_NOW, 1000),
    wallClockMs: 10_000,
  });
  writeFileSync(entryPath, Buffer.concat([bytes, Buffer.from("\n// altered after admission\n")]));
  const error = refusal(() =>
    host.run({
      operation: request.operation,
      operationId: request.operation_id,
      request,
      executionMode: "local_observation",
    }),
  );
  assert.equal(error.code, CODES.ADAPTER_IDENTITY_MISMATCH);
});

test("ADAPTER-CERT-V2: the neutral scope skeleton produces deterministic unsigned test receipts", () => {
  const fixture = localFixture();
  const negotiationBase = {
    schema_version: "adapter-protocol-negotiation/v2" as const,
    execution_id: LOCAL_RUN_ID,
    adapter_manifest_hash: fixture.manifest.core_hash,
    offered_protocol_versions: ["subject-adapter/v2"] as const,
    required_execution_mode: "local_observation" as const,
    selected_protocol_version: "subject-adapter/v2" as const,
    execution_mode: "local_observation" as const,
    adapter_id: fixture.manifest.adapter_id,
    adapter_version: fixture.manifest.version,
    adapter_artifact_hash: fixture.manifest.adapter_artifact_hash,
    supported_operations: [fixture.request.operation],
    supported_package_kinds: ["archive"] as const,
    max_request_bytes: fixture.plan.resource_limits.max_request_bytes,
    max_response_bytes: fixture.plan.resource_limits.max_response_bytes,
    negotiated_at: LOCAL_NOW as `${string}Z`,
  };
  const negotiation = { ...negotiationBase, core_hash: coreHash(negotiationBase) };
  const options = {
    adapterManifest: fixture.manifest,
    adapterEntryPath: path.join(process.cwd(), "fixtures", "neutral", "local-archive-observer.mjs"),
    clock: new SteppingClock(LOCAL_NOW, 0),
    certifierId: "neutral-certifier",
    negotiation,
    localRequest: fixture.request,
    enforcedControls: ["process-tree-termination"] as const,
    unsupportedControls: ["deny-by-default-egress"] as const,
    recoveryDeclared: true,
    cleanupDeclared: true,
  };
  const first = certifyAdapterV2Scope(options);
  const second = certifyAdapterV2Scope(options);
  assert.equal(first.verdict, "certified");
  assert.equal(first.signature_state, "unsigned");
  assert.equal(first.certification_authenticity, "locally_observed_unauthenticated");
  assert.equal(first.core_hash, second.core_hash);
  assert.equal(first.checks.length, 9);
});

function localManifestForEntry(
  shape: LocalFixtureShape,
  entryPath: string,
  operations: readonly AdapterOperation[] = [shape.operation],
): SubjectAdapterManifestV2 {
  return assertContract<SubjectAdapterManifestV2>(
    "SubjectAdapterManifestV2",
    sealSigned(
      {
        schema_version: "subject-adapter-manifest/v2" as const,
        adapter_id: shape.adapterId,
        version: "1.0.0",
        adapter_artifact_hash: hashBytes(readFileSync(entryPath)),
        protocol_support: [{
          protocol_version: "subject-adapter/v2" as const,
          execution_modes: ["local_observation"] as const,
          operations: [...operations],
          supported_package_kinds: [shape.packageKind],
          required_controls: ["process-tree-termination", "deny-by-default-egress"] as const,
        }],
        required_broker_capabilities: [],
        network_allowlist_ids: [],
        certification_receipt_hash: `sha256:${"0".repeat(64)}`,
        owner: "neutral fixture owner",
      },
      developmentKey("neutral-local-owner"),
    ),
  );
}

function localFixtureWithLimits(
  changes: Record<string, number>,
  denyState: "enforced" | "unsupported_permitted" = "unsupported_permitted",
) {
  const fixture = localFixture();
  const limitsBase = {
    ...fixture.plan.resource_limits,
    ...changes,
    control_expectations: fixture.plan.resource_limits.control_expectations.map((expectation) =>
      expectation.control_id === "deny-by-default-egress"
        ? { ...expectation, required_state: denyState }
        : expectation,
    ),
  } as unknown as Record<string, unknown>;
  delete limitsBase["core_hash"];
  const limits = { ...limitsBase, core_hash: coreHash(limitsBase) } as typeof fixture.plan.resource_limits;
  const planBase = { ...fixture.plan, resource_limits: limits } as unknown as Record<string, unknown>;
  delete planBase["core_hash"];
  const plan = { ...planBase, core_hash: coreHash(planBase) } as typeof fixture.plan;
  const request = localRequest(fixture.manifest, plan, ARCHIVE_SHAPE);
  return { ...fixture, plan, request };
}

function hostFor(fixture: ReturnType<typeof localFixtureWithLimits>) {
  return new AdapterHost({
    runId: LOCAL_RUN_ID,
    adapterManifest: fixture.manifest,
    localAuthorityV2: { mode: "certified_external", receipt: fixture.receipt },
    localObservationPlan: fixture.plan,
    adapterEntryPath: path.join(process.cwd(), "fixtures", "neutral", "local-archive-observer.mjs"),
    workspaceRoot: mkdtempSync(path.join(tmpdir(), "erl2-local-limit-")),
    store: new ArtifactStore(mkdtempSync(path.join(tmpdir(), "erl2-local-limit-store-"))),
    clock: new SteppingClock(LOCAL_NOW, 1000),
    wallClockMs: 10_000,
    maxRequestBytes: 1024 * 1024,
    maxResponseBytes: 1024 * 1024,
  });
}

const BOUNDARY_OPERATIONS = ["acquire", "start", "interact", "project"] as const;

function fixtureForEntry(
  shape: LocalFixtureShape,
  entryPath: string,
  certifiedOperations: readonly AdapterOperation[] = [shape.operation],
) {
  const manifest = localManifestForEntry(shape, entryPath, certifiedOperations);
  const one = localReceipt(manifest, shape);
  const receiptBase = {
    ...one,
    certified_profiles: [{
      ...one.certified_profiles[0]!,
      operations: [...certifiedOperations],
    }],
    certified_operations: [...certifiedOperations],
  } as unknown as Record<string, unknown>;
  delete receiptBase["core_hash"];
  const receipt = assertContract<SubjectAdapterCertificationReceiptV2>(
    "SubjectAdapterCertificationReceiptV2",
    { ...receiptBase, core_hash: coreHash(receiptBase) },
  );
  const plan = localPlan(manifest, receipt, shape);
  const request = localRequest(manifest, plan, shape);
  const host = new AdapterHost({
    runId: LOCAL_RUN_ID,
    adapterManifest: manifest,
    localAuthorityV2: { mode: "certified_external", receipt },
    localObservationPlan: plan,
    adapterEntryPath: entryPath,
    workspaceRoot: mkdtempSync(path.join(tmpdir(), "erl2-local-custom-")),
    store: new ArtifactStore(mkdtempSync(path.join(tmpdir(), "erl2-local-custom-store-"))),
    clock: new SteppingClock(LOCAL_NOW, 1000),
    wallClockMs: 10_000,
    maxRequestBytes: 1024 * 1024,
    maxResponseBytes: 1024 * 1024,
  });
  return { manifest, receipt, plan, request, host };
}

function boundaryFixture(
  operation: (typeof BOUNDARY_OPERATIONS)[number],
  limits: Record<string, number> = {},
  allowRedirect = false,
) {
  const payload: Record<(typeof BOUNDARY_OPERATIONS)[number], Record<string, unknown>> = {
    acquire: { schema_version: "acquire-payload/v1", provenance_mode: "acquired", source_descriptor_input_id: "package-input", output_input_id: "package-output", expected_package_kind: "archive", credential_handle_ids: [] },
    start: { schema_version: "start-payload/v1", input_ids: [] },
    interact: { schema_version: "interact-payload/v1", interaction_input_ids: [] },
    project: { schema_version: "project-payload/v1", evidence_input_ids: ["package-input"], projection_schema: "neutral-boundary-v1" },
  };
  const shape: LocalFixtureShape = {
    adapterId: "neutral-boundary-observer",
    operation,
    packageKind: "archive",
    payload: payload[operation],
    entryName: "local-boundary-observer.mjs",
  };
  const entryPath = path.join(process.cwd(), "fixtures", "neutral", shape.entryName);
  let fixture = fixtureForEntry(shape, entryPath, BOUNDARY_OPERATIONS);
  if (Object.keys(limits).length > 0) fixture = relimit(fixture, limits);
  if (allowRedirect) fixture = repolicy(fixture);
  return fixture;
}

function relimit<T extends ReturnType<typeof fixtureForEntry>>(fixture: T, changes: Record<string, number>): T {
  const limitsBase = { ...fixture.plan.resource_limits, ...changes } as unknown as Record<string, unknown>;
  delete limitsBase["core_hash"];
  const resourceLimits = { ...limitsBase, core_hash: coreHash(limitsBase) } as typeof fixture.plan.resource_limits;
  const planBase = { ...fixture.plan, resource_limits: resourceLimits } as unknown as Record<string, unknown>;
  delete planBase["core_hash"];
  const plan = { ...planBase, core_hash: coreHash(planBase) } as typeof fixture.plan;
  const request = localRequest(fixture.manifest, plan, {
    adapterId: fixture.manifest.adapter_id,
    operation: fixture.plan.operations[0]!.operation,
    packageKind: "archive",
    payload: fixture.plan.operations[0]!.payload as unknown as Record<string, unknown>,
    entryName: "unused",
  });
  const host = new AdapterHost({
    runId: LOCAL_RUN_ID,
    adapterManifest: fixture.manifest,
    localAuthorityV2: { mode: "certified_external", receipt: fixture.receipt },
    localObservationPlan: plan,
    adapterEntryPath: path.join(process.cwd(), "fixtures", "neutral", "local-boundary-observer.mjs"),
    workspaceRoot: mkdtempSync(path.join(tmpdir(), "erl2-local-relimit-")),
    store: new ArtifactStore(mkdtempSync(path.join(tmpdir(), "erl2-local-relimit-store-"))),
    clock: new SteppingClock(LOCAL_NOW, 1000),
    wallClockMs: 10_000,
    maxRequestBytes: 1024 * 1024,
    maxResponseBytes: 1024 * 1024,
  });
  return { ...fixture, plan, request, host } as T;
}

function repolicy<T extends ReturnType<typeof fixtureForEntry>>(fixture: T): T {
  const policyBase = {
    ...fixture.plan.egress_policy,
    allowed_hosts: ["allowed.example"],
    max_redirects: 1,
  } as unknown as Record<string, unknown>;
  delete policyBase["core_hash"];
  const egressPolicy = { ...policyBase, core_hash: coreHash(policyBase) } as typeof fixture.plan.egress_policy;
  const planBase = { ...fixture.plan, egress_policy: egressPolicy } as unknown as Record<string, unknown>;
  delete planBase["core_hash"];
  const plan = { ...planBase, core_hash: coreHash(planBase) } as typeof fixture.plan;
  const shape: LocalFixtureShape = {
    adapterId: fixture.manifest.adapter_id,
    operation: fixture.plan.operations[0]!.operation,
    packageKind: "archive",
    payload: fixture.plan.operations[0]!.payload as unknown as Record<string, unknown>,
    entryName: "local-boundary-observer.mjs",
  };
  const request = localRequest(fixture.manifest, plan, shape);
  const host = new AdapterHost({
    runId: LOCAL_RUN_ID,
    adapterManifest: fixture.manifest,
    localAuthorityV2: { mode: "certified_external", receipt: fixture.receipt },
    localObservationPlan: plan,
    adapterEntryPath: path.join(process.cwd(), "fixtures", "neutral", "local-boundary-observer.mjs"),
    workspaceRoot: mkdtempSync(path.join(tmpdir(), "erl2-local-policy-")),
    store: new ArtifactStore(mkdtempSync(path.join(tmpdir(), "erl2-local-policy-store-"))),
    clock: new SteppingClock(LOCAL_NOW, 1000),
    wallClockMs: 10_000,
    maxRequestBytes: 1024 * 1024,
    maxResponseBytes: 1024 * 1024,
  });
  return { ...fixture, plan, request, host } as T;
}
