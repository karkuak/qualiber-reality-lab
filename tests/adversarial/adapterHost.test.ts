/**
 * MOUNT-NET-NEG / ADAPTER-CERT / PRIV-BROKER: the hostile adapter matrix.
 *
 * Every case here drives a *real out-of-process adapter* that ignores the SDK
 * and violates the protocol on purpose. The single invariant under test, on top
 * of each specific refusal, is ownership: a broken or malicious adapter yields a
 * typed adapter or Lab outcome and **never** a subject defect.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Erl2Error } from "@erl2/contracts";
import {
  assertMountPermitted,
  assertSandboxProfileEnabled,
  CredentialBroker,
  decideEgress,
  denyByDefaultEgressPolicy,
  grantCapabilities,
  MutationLedger,
  PRIVILEGED_CAPABILITIES,
  assertManifestCapabilitiesUnprivileged,
  collectBoundedTree,
  DEFAULT_OUTPUT_BOUNDS,
} from "@erl2/core";
import {
  acquisitionRequest,
  adapterManifest,
  mount,
  newHost,
  packageVerificationRequest,
  referenceAdapterEntry,
  REFERENCE_CORRECT_MANIFEST,
  sabotageAdapterEntry,
  stepRequest,
} from "../support/adapterFixtures.js";

/** Runs one operation and returns the typed refusal, or `undefined`. */
function refusalOf(fn: () => unknown): Erl2Error | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    if (error instanceof Erl2Error) return error;
    throw error;
  }
}

function sabotageHost(name: string, overrides = {}) {
  return newHost(
    adapterManifest({ adapterId: `sabotage-${name}`, operations: ["acquire", "validate-package", "install"] }),
    sabotageAdapterEntry(name),
    overrides,
  );
}

/** The ownership invariant every hostile case must satisfy. */
function assertNotSubjectAttributed(error: Erl2Error, what: string): void {
  assert.notEqual(error.owner, "subject", `${what} was attributed to the subject`);
  assert.ok(
    error.owner === "adapter" || error.owner === "lab",
    `${what} has owner ${error.owner}`,
  );
}

test("ADAPTER-CERT: a protocol version mismatch is refused before any operation runs", () => {
  const { host } = sabotageHost("protocol-mismatch");
  const error = refusalOf(() =>
    host.run({ operation: "acquire", operationId: "op-1", request: acquisitionRequest("op-1") }),
  );
  assert.ok(error, "a mismatched protocol must refuse");
  assert.equal(error.code, "ADAPTER_PROTOCOL_VERSION_MISMATCH");
  assertNotSubjectAttributed(error, "a protocol mismatch");
});

test("ADAPTER-CERT: an adapter whose running identity differs from its manifest is refused", () => {
  const { host } = sabotageHost("identity-mismatch");
  const error = refusalOf(() =>
    host.run({ operation: "acquire", operationId: "op-1", request: acquisitionRequest("op-1") }),
  );
  assert.equal(error?.code, "ADAPTER_IDENTITY_MISMATCH");
  assertNotSubjectAttributed(error as Erl2Error, "an identity mismatch");
});

test("ADAPTER-CERT: an unknown frame kind is a protocol failure, not an instruction", () => {
  const { host } = sabotageHost("unknown-frame");
  const error = refusalOf(() =>
    host.run({ operation: "acquire", operationId: "op-1", request: acquisitionRequest("op-1") }),
  );
  assert.equal(error?.code, "ADAPTER_PROTOCOL_FRAME_INVALID");
});

test("ADAPTER-CERT: an adapter that crashes before responding is a typed adapter crash", () => {
  const { host } = sabotageHost("crash-before-response");
  const error = refusalOf(() =>
    host.run({ operation: "acquire", operationId: "op-1", request: acquisitionRequest("op-1") }),
  );
  assert.equal(error?.code, "ADAPTER_PROCESS_CRASHED");
  assertNotSubjectAttributed(error as Erl2Error, "an adapter crash");
});

test("CRASH-MATRIX: a crash after an external mutation leaves the mutation observable for resume", () => {
  const { host, workspaceRoot } = sabotageHost("crash-after-mutation");
  const error = refusalOf(() =>
    host.run({ operation: "install", operationId: "op-install", request: stepRequest("op-install") }),
  );
  assert.equal(error?.code, "ADAPTER_PROCESS_CRASHED");
  // The side effect the adapter applied before dying is still on disk, so
  // reconciliation has something to find rather than assuming a clean slate.
  const applied = path.join(workspaceRoot, "op-install", "output", "mutation-applied.txt");
  assert.equal(existsSync(applied), true, "the pre-crash side effect must remain observable");
});

test("ADAPTER-CERT: an adapter that never responds is terminated with its whole process tree", () => {
  const { host, workspaceRoot } = sabotageHost("timeout", { wallClockMs: 1500 });
  const started = Date.now();
  const error = refusalOf(() =>
    host.run({ operation: "acquire", operationId: "op-1", request: acquisitionRequest("op-1") }),
  );
  const elapsed = Date.now() - started;
  assert.equal(error?.code, "ADAPTER_DEADLINE_EXCEEDED");
  assert.ok(elapsed < 30_000, `the deadline must bound the wait, took ${String(elapsed)}ms`);

  // The adapter forked a detached grandchild. Killing the process *group* must
  // have reached it; a surviving pid would mean only the direct child died.
  const pidFile = path.join(workspaceRoot, "op-1", "output", "grandchild.pid");
  if (existsSync(pidFile)) {
    const pid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
    let alive = true;
    for (let attempt = 0; attempt < 50 && alive; attempt += 1) {
      try {
        process.kill(pid, 0);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
      } catch {
        alive = false;
      }
    }
    if (alive) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    assert.equal(alive, false, "the grandchild survived process-tree termination");
  }
});

test("LIMIT-MATRIX: an oversized response is refused before it is parsed", () => {
  const { host } = sabotageHost("oversized-response", { maxResponseBytes: 64 * 1024 });
  const error = refusalOf(() =>
    host.run({ operation: "acquire", operationId: "op-1", request: acquisitionRequest("op-1") }),
  );
  assert.equal(error?.code, "ADAPTER_RESPONSE_OVERSIZED");
});

test("LIMIT-MATRIX: output beyond the declared bound is refused by the host itself", () => {
  // Asserted against `host.run`, not against `collectBoundedTree` called
  // afterwards by the test. Until the host froze its own output tree, this case
  // proved only that the bound *function* worked: the shipped path ran the
  // adapter, returned a supported envelope, and never consulted the bound at
  // all. The distinction is the whole defect — a bound nothing calls is not a
  // bound.
  const { host, workspaceRoot } = sabotageHost("oversized-output");
  const error = refusalOf(() =>
    host.run({ operation: "acquire", operationId: "op-1", request: acquisitionRequest("op-1") }),
  );
  assert.equal(error?.code, "SUBJECT_OUTPUT_LIMIT_EXCEEDED");
  assertNotSubjectAttributed(error as Erl2Error, "an output bound breach");
  // The refusal published nothing: an over-large tree leaves no retained bytes.
  assert.equal(
    existsSync(path.join(workspaceRoot, "op-1", "output")),
    true,
    "the host-owned working directory is untouched by the refusal",
  );
});

test("MOUNT-NET-NEG: writing into a read-only mount is detected and refused", () => {
  const mountRoot = mkdtempSync(path.join(tmpdir(), "erl2-mount-"));
  writeFileSync(path.join(mountRoot, "step.json"), '{"step":"acquire"}\n');
  const { host } = newHost(
    adapterManifest({ adapterId: "sabotage-undeclared-mutation" }),
    sabotageAdapterEntry("undeclared-mutation"),
    { mounts: [mount("subject-visible", mountRoot)] },
  );
  const error = refusalOf(() =>
    host.run({ operation: "acquire", operationId: "op-1", request: acquisitionRequest("op-1") }),
  );
  assert.equal(error?.code, "ADAPTER_MOUNT_NOT_READ_ONLY");
  assertNotSubjectAttributed(error as Erl2Error, "an undeclared mount write");
});

test("COMPENSATION: a succeeded mutation with no compensation receipt is refused", () => {
  const { host } = sabotageHost("missing-compensation");
  const error = refusalOf(() =>
    host.run({ operation: "install", operationId: "op-install", request: stepRequest("op-install") }),
  );
  assert.equal(error?.code, "ADAPTER_MUTATION_UNRECONCILED");
  assertNotSubjectAttributed(error as Erl2Error, "a missing compensation");
});

test("COMPENSATION: a compensation naming a different mutation is refused", () => {
  const { host } = sabotageHost("compensation-mismatch");
  const error = refusalOf(() =>
    host.run({ operation: "install", operationId: "op-install", request: stepRequest("op-install") }),
  );
  assert.equal(error?.code, "ADAPTER_COMPENSATION_TARGET_MISMATCH");
});

test("COMPENSATION: a mutation outside the permitted roots is refused", () => {
  const { host } = sabotageHost("out-of-scope-mutation");
  const error = refusalOf(() =>
    host.run({ operation: "install", operationId: "op-install", request: stepRequest("op-install") }),
  );
  assert.equal(error?.code, "ADAPTER_MUTATION_TARGET_NOT_PERMITTED");
});

test("SECRET-CANARY: a judge canary in diagnostics invalidates before subject attribution", () => {
  const { host } = sabotageHost("canary-in-diagnostics");
  const error = refusalOf(() =>
    host.run({ operation: "acquire", operationId: "op-1", request: acquisitionRequest("op-1") }),
  );
  assert.equal(error?.code, "JOURNEY_ORACLE_CANARY_LEAKED");
  assert.equal(error?.owner, "lab", "an oracle leak is a Lab invalidity, never a subject result");
});

test("SECRET-CANARY: a secret canary in retained output is refused by the host itself", () => {
  const { host, storeRoot } = sabotageHost("secret-in-output");
  const error = refusalOf(() =>
    host.run({ operation: "acquire", operationId: "op-1", request: acquisitionRequest("op-1") }),
  );
  assert.equal(error?.code, "SECRET_CANARY_IN_SUBJECT_OUTPUT");
  assert.equal(error?.owner, "lab");
  // Refused before publication: the scan is a gate, not a report on bytes that
  // are already retained.
  assert.equal(
    existsSync(path.join(storeRoot, "subject-output", "adapter", "op-1")),
    false,
    "a refused output tree must publish nothing",
  );
});

test("PATH-FUZZ: a symlink in adapter output is refused by the host itself", () => {
  const { host, storeRoot } = sabotageHost("symlink-output");
  const error = refusalOf(() =>
    host.run({ operation: "acquire", operationId: "op-1", request: acquisitionRequest("op-1") }),
  );
  assert.equal(error?.code, "PATH_SYMLINK_REJECTED");
  assert.equal(
    existsSync(path.join(storeRoot, "subject-output", "adapter", "op-1")),
    false,
    "a refused output tree must publish nothing",
  );
});

test("PATH-FUZZ: a traversal write never enters the admitted output tree", () => {
  const { host, workspaceRoot } = sabotageHost("path-escape-output");
  host.run({ operation: "acquire", operationId: "op-1", request: acquisitionRequest("op-1") });
  const files = collectBoundedTree(
    path.join(workspaceRoot, "op-1", "output"),
    DEFAULT_OUTPUT_BOUNDS,
  );
  // Whatever the adapter wrote outside its output directory is simply not
  // admitted: only the confined tree is inventoried and frozen. The operation
  // therefore *succeeds* — there is nothing forbidden inside the tree — which is
  // why this case reads the tree rather than expecting a refusal.
  assert.deepEqual(files.map((f) => f.relativePath), []);
});

test("PATH-FUZZ: a hard-linked output entry is refused", () => {
  const root = mkdtempSync(path.join(tmpdir(), "erl2-hardlink-"));
  const outside = path.join(root, "outside.txt");
  writeFileSync(outside, "bytes the adapter did not produce\n");
  const output = path.join(root, "output");
  mkdirSync(output);
  // A hard link publishes foreign bytes as if the adapter had written them.
  linkSync(outside, path.join(output, "linked.txt"));
  const error = refusalOf(() => collectBoundedTree(output, DEFAULT_OUTPUT_BOUNDS));
  assert.equal(error?.code, "PATH_HARD_LINK_REJECTED");
});

test("SSRF-SUITE: the metadata service is denied whatever the allowlist says", () => {
  const { host } = sabotageHost("ssrf-metadata");
  const error = refusalOf(() =>
    host.run({ operation: "acquire", operationId: "op-1", request: acquisitionRequest("op-1") }),
  );
  assert.equal(error?.code, "ADAPTER_EGRESS_METADATA_SERVICE_DENIED");
});

test("SSRF-SUITE: a redirect to an unallowlisted host is denied", () => {
  const policyHost = newHost(
    adapterManifest({ adapterId: "sabotage-ssrf-redirect" }),
    sabotageAdapterEntry("ssrf-redirect"),
  );
  const error = refusalOf(() =>
    policyHost.host.run({
      operation: "acquire",
      operationId: "op-1",
      request: acquisitionRequest("op-1"),
    }),
  );
  assert.ok(
    error?.code === "ADAPTER_EGRESS_HOST_NOT_ALLOWED" ||
      error?.code === "ADAPTER_EGRESS_REDIRECT_ESCAPED",
    `unexpected code ${String(error?.code)}`,
  );
});

test("SSRF-SUITE: DNS rebinding onto a private address is denied", () => {
  const base = denyByDefaultEgressPolicy("test-policy");
  const policy = { ...base, allowed_hosts: ["registry.example.test"] };
  const sealed = { ...policy, core_hash: base.core_hash };
  const receipt = decideEgress({
    runId: "01890000-0000-7000-8000-00000000000d",
    operationId: "op-1",
    decisionId: "egress-1",
    policy: sealed as never,
    url: "https://registry.example.test/package",
    redirectChain: [],
    // The name passed the allowlist; the address it resolved to did not.
    resolvedAddresses: ["10.0.0.7"],
    now: "2026-07-01T00:00:00Z",
  });
  assert.equal(receipt.decision, "denied");
  assert.equal(receipt.denial_code, "ADAPTER_EGRESS_DNS_REBOUND");
});

test("SECRET-CANARY: an over-broad credential scope is narrowed and its use denied", () => {
  const { host } = sabotageHost("credential-overreach");
  const error = refusalOf(() =>
    host.run({ operation: "acquire", operationId: "op-1", request: acquisitionRequest("op-1") }),
  );
  assert.equal(error?.code, "SECRET_CREDENTIAL_SCOPE_EXCEEDED");
});

test("SECRET-CANARY: replaying a credential handle past its use cap is denied", () => {
  const { host } = sabotageHost("credential-replay");
  const error = refusalOf(() =>
    host.run({ operation: "acquire", operationId: "op-1", request: acquisitionRequest("op-1") }),
  );
  assert.equal(error?.code, "SECRET_CREDENTIAL_HANDLE_REPLAYED");
});

test("SECRET-CANARY: an expired or cross-run handle use is denied", () => {
  const broker = new CredentialBroker();
  const runId = "01890000-0000-7000-8000-00000000000d";
  const otherRun = "01890000-0000-7000-8000-00000000000e";
  const adapterHash = `sha256:${"1".repeat(64)}` as const;
  const { grant } = broker.issue({
    runId,
    operationId: "op-1",
    adapterManifestHash: adapterHash,
    handleRequestId: "handle-request-1",
    credentialReferenceKind: "development-keychain-reference",
    requestedScopeIds: ["subject-registry-read"],
    requestedTtlSeconds: 60,
    requestedMaxUses: 4,
    targetDescriptor: "registry.example.test",
    purposeCode: "acquire-package",
    now: "2026-07-01T00:00:00Z",
  });
  assert.deepEqual(grant.granted_scope_ids, ["subject-registry-read"]);

  const expired = broker.use({
    runId,
    operationId: "op-1",
    adapterManifestHash: adapterHash,
    handleId: grant.handle_id,
    scopeId: "subject-registry-read",
    targetDescriptor: "registry.example.test",
    now: "2026-07-01T01:00:00Z",
  });
  assert.equal(expired.denial_code, "SECRET_CREDENTIAL_HANDLE_EXPIRED");

  const crossRun = broker.use({
    runId: otherRun,
    operationId: "op-1",
    adapterManifestHash: adapterHash,
    handleId: grant.handle_id,
    scopeId: "subject-registry-read",
    targetDescriptor: "registry.example.test",
    now: "2026-07-01T00:00:10Z",
  });
  assert.equal(crossRun.denial_code, "SECRET_CREDENTIAL_HANDLE_WRONG_RUN");
});

test("PRIV-BROKER: every privileged capability is refused while ERL2-OQ-001 is open", () => {
  for (const capability of PRIVILEGED_CAPABILITIES) {
    const error = refusalOf(() => assertManifestCapabilitiesUnprivileged([capability]));
    assert.equal(
      error?.code,
      "ADAPTER_PRIVILEGED_OPERATION_NOT_SUPPORTED",
      `${capability} was not refused`,
    );
    assertNotSubjectAttributed(error as Erl2Error, `privileged capability ${capability}`);
  }
  // A grant records the denial rather than emulating success.
  const grant = grantCapabilities({
    runId: "01890000-0000-7000-8000-00000000000d",
    operationId: "op-1",
    grantId: "grant-1",
    adapterManifestHash: `sha256:${"1".repeat(64)}`,
    requested: ["write-run-output", "elevate-to-root", "use-docker-socket"],
    grantedAt: "2026-07-01T00:00:00Z",
  });
  assert.deepEqual(grant.granted_capability_ids, ["write-run-output"]);
  assert.deepEqual(grant.denied_capability_ids, ["elevate-to-root", "use-docker-socket"]);
  assert.equal(grant.privileged_broker_state, "absent_pending_erl2_oq_001");
});

test("PRIV-BROKER: an adapter declaring a privileged capability cannot even be hosted", () => {
  const error = refusalOf(() =>
    newHost(
      adapterManifest({ adapterId: "privileged", capabilities: ["elevate-to-root"] }),
      referenceAdapterEntry("reference-correct"),
    ),
  );
  assert.equal(error?.code, "ADAPTER_PRIVILEGED_OPERATION_NOT_SUPPORTED");
});

test("MOUNT-NET-NEG: the Docker socket, host home and Lab authorities cannot be mounted", () => {
  for (const forbidden of [
    "/var/run/docker.sock",
    "/root/.ssh",
    "/srv/lab/vault/keys",
    "/srv/lab/truth/challenge-7",
    "/srv/lab/judge/expectations",
    "/srv/lab/selection/eligibility-pool",
    "/home/operator/.aws/credentials",
  ]) {
    const error = refusalOf(() => assertMountPermitted(forbidden, "/home/operator"));
    assert.equal(error?.code, "ADAPTER_MOUNT_FORBIDDEN", `${forbidden} was permitted`);
  }
  const error = refusalOf(() => assertMountPermitted("/home/operator", "/home/operator"));
  assert.equal(error?.code, "ADAPTER_MOUNT_FORBIDDEN");
});

test("ADAPTER-CERT: a response the adapter blames on the Lab is rejected by the closed envelope", () => {
  const { host } = sabotageHost("false-attribution");
  const error = refusalOf(() =>
    host.run({ operation: "acquire", operationId: "op-1", request: acquisitionRequest("op-1") }),
  );
  // `owner` is a closed enum of adapter|subject; the Lab is not an option an
  // adapter may select for itself.  The response-shape validator (P2-6) now
  // rejects the whole frame with a typed, adapter-owned refusal *before* any
  // field is consumed, rather than only downstream at the envelope.
  assert.equal(error?.code, "ADAPTER_PROTOCOL_FRAME_INVALID");
});

test("ADAPTER-CERT: a response missing a required array yields a typed refusal, not an untyped crash (P2-6)", () => {
  const { host } = sabotageHost("malformed-response");
  const error = refusalOf(() =>
    host.run({ operation: "acquire", operationId: "op-1", request: acquisitionRequest("op-1") }),
  );
  // Before P2-6 this threw `TypeError: response.mutations is not iterable` with
  // no code/owner and escaped the run path uncaught. It must now be a typed,
  // non-subject-attributed adapter refusal.
  assert.ok(error instanceof Erl2Error, "a malformed response must be a typed Erl2Error");
  assert.equal(error?.code, "ADAPTER_PROTOCOL_FRAME_INVALID");
  assertNotSubjectAttributed(error as Erl2Error, "a malformed adapter response");
});

test("UNSUPPORTED-HONESTY: claiming success for an undeclared package kind is caught by certification", async () => {
  const { certifyAdapter, SteppingClock } = await import("@erl2/core");
  const receipt = certifyAdapter({
    adapterManifest: adapterManifest({
      adapterId: "sabotage-false-success",
      operations: ["acquire", "validate-package"],
      packageKinds: ["archive"],
    }),
    adapterEntryPath: sabotageAdapterEntry("false-success"),
    clock: new SteppingClock("2026-07-01T00:00:00Z", 1000),
    certifierId: "erl2-certifier",
  });
  assert.equal(receipt.verdict, "refused");
  assert.ok(receipt.refusal_codes.includes("ADAPTER_PACKAGE_KIND_UNSUPPORTED"));
});

test("FAILURE-FIXTURES: a genuinely broken installer is the only case attributed to the subject", () => {
  const { host } = newHost(
    adapterManifest({
      adapterId: "sabotage-broken-installer",
      operations: ["acquire", "validate-package", "install"],
    }),
    sabotageAdapterEntry("broken-installer"),
  );
  const result = host.run({
    operation: "install",
    operationId: "op-install",
    request: stepRequest("op-install"),
  });
  assert.equal(result.envelope.status, "failed");
  assert.equal(result.envelope.error?.owner, "subject");
  assert.equal(result.envelope.error?.code, "SUBJECT_INSTALL_FAILED");
  // Ownership is the adapter's claim; the Lab still owns the finding, and the
  // typed report it would freeze can never assert subject attribution itself.
  const report = host.buildFailureReport({
    operationId: "op-install",
    code: "SUBJECT_INSTALL_FAILED",
    category: "adapter_protocol_failure",
    summary: "installer reported a subject-owned failure",
  });
  assert.equal(report.subject_attribution_proven, false);
});

test("REVEAL-REFUSAL: no adapter operation may run after subject output freezes", () => {
  const { host } = newHost(REFERENCE_CORRECT_MANIFEST(), referenceAdapterEntry("reference-correct"));
  host.markOutputFrozen();
  const error = refusalOf(() =>
    host.run({ operation: "acquire", operationId: "op-1", request: acquisitionRequest("op-1") }),
  );
  assert.equal(error?.code, "ADAPTER_EXECUTION_AFTER_OUTPUT_FREEZE");
  assert.equal(error?.owner, "lab");
});

test("REQUEST-ANCESTRY: a later-phase ancestor in an acquisition request is refused", async () => {
  const { assertRequestAncestry, assertExecutionPlan, assertOperationMatchesPhase } = await import(
    "@erl2/adapter-sdk"
  );
  assert.throws(
    () => assertRequestAncestry(acquisitionRequest("op-1", { execution_plan_hash: `sha256:${"a".repeat(64)}` })),
    /REQUEST_ANCESTRY_INVALID|later-phase ancestor/,
  );
  assert.throws(
    () =>
      assertRequestAncestry(
        packageVerificationRequest("op-1", "archive", { truth_commitment_hash: `sha256:${"a".repeat(64)}` }),
      ),
    /later-phase ancestor/,
  );
  // A post-plan request must carry the run's actual plan.
  assert.throws(
    () => assertExecutionPlan(stepRequest("op-1"), `sha256:${"f".repeat(64)}`),
    /execution plan the run did not freeze/,
  );
  assert.throws(
    () => assertOperationMatchesPhase("install", "acquisition"),
    /cannot be dispatched with a acquisition request/,
  );
});

test("TRANSLATION: omission, duplication, invention and reasonless loss are all refused", async () => {
  const { buildTranslationReceipt } = await import("@erl2/adapter-sdk");
  const envelope = { entry_ids: ["deploy-log", "trace-summary"] };
  assert.throws(
    () =>
      buildTranslationReceipt(envelope, "translated", [
        { entry_id: "deploy-log", disposition: "mapped_exact", target_paths: ["translated/a.json"] },
      ]),
    /TRANSLATION_ENTRY_OMITTED|omits/,
  );
  assert.throws(
    () =>
      buildTranslationReceipt(envelope, "translated", [
        { entry_id: "deploy-log", disposition: "mapped_exact", target_paths: ["translated/a.json"] },
        { entry_id: "deploy-log", disposition: "mapped_exact", target_paths: ["translated/b.json"] },
        { entry_id: "trace-summary", disposition: "unsupported", target_paths: [], loss_reason_code: "X" },
      ]),
    /accounted for more than once/,
  );
  assert.throws(
    () =>
      buildTranslationReceipt(envelope, "translated", [
        { entry_id: "deploy-log", disposition: "mapped_exact", target_paths: ["translated/a.json"] },
        { entry_id: "trace-summary", disposition: "mapped_exact", target_paths: ["translated/b.json"] },
        { entry_id: "invented", disposition: "mapped_exact", target_paths: ["translated/c.json"] },
      ]),
    /invents source entry/,
  );
  assert.throws(
    () =>
      buildTranslationReceipt(envelope, "translated", [
        { entry_id: "deploy-log", disposition: "mapped_exact", target_paths: ["translated/a.json"] },
        { entry_id: "trace-summary", disposition: "mapped_lossy", target_paths: ["translated/b.json"] },
      ]),
    /states no reason/,
  );
  assert.throws(
    () =>
      buildTranslationReceipt(envelope, "translated", [
        { entry_id: "deploy-log", disposition: "mapped_exact", target_paths: ["elsewhere/a.json"] },
        { entry_id: "trace-summary", disposition: "unsupported", target_paths: [], loss_reason_code: "X" },
      ]),
    /outside the translated tree/,
  );
  // The honest total mapping is accepted, and `unsupported` is retained.
  const receipt = buildTranslationReceipt(envelope, "translated", [
    { entry_id: "deploy-log", disposition: "mapped_exact", target_paths: ["translated/a.json"] },
    {
      entry_id: "trace-summary",
      disposition: "unsupported",
      target_paths: [],
      loss_reason_code: "EVIDENCE_CLASS_NOT_MODELLED",
    },
  ]);
  assert.equal(receipt.accounted_entries, 2);
  assert.equal(receipt.mappings.filter((m) => m.disposition === "unsupported").length, 1);
});

test("COMPENSATION: an undeclared mutation and an unreconciled one are both refused", () => {
  const ledger = new MutationLedger({
    runId: "01890000-0000-7000-8000-00000000000d",
    permittedTargetPrefixes: ["adapter-workspace/"],
    grantedCapabilities: ["write-adapter-workspace"],
  });
  assert.throws(
    () => ledger.assertDeclared("ghost-mutation", "adapter-workspace/x"),
    /an undeclared mutation/,
  );
  ledger.record(
    {
      mutationId: "m1",
      mutationClass: "filesystem",
      capabilityId: "write-adapter-workspace",
      targetDescriptor: "adapter-workspace/runtime",
      beforeStateDescriptor: "absent",
      afterStateDescriptor: "present",
      compensationId: "c1",
      compensationCapabilityId: "write-adapter-workspace",
      status: "succeeded",
    },
    "op-1",
    "2026-07-01T00:00:00Z",
  );
  assert.deepEqual(ledger.outstandingMutationIds(), ["m1"]);
  assert.throws(() => ledger.assertReconciled(), /no compensation receipt/);
  ledger.compensate(
    { compensationId: "c1", mutationId: "m1", afterStateDescriptor: "absent", status: "succeeded" },
    "2026-07-01T00:00:01Z",
  );
  ledger.assertReconciled();
  assert.deepEqual(ledger.outstandingMutationIds(), []);
});

test("ADAPTER-CERT: the container sandbox profile is disabled, not silently downgraded", () => {
  const error = refusalOf(() => assertSandboxProfileEnabled("container"));
  assert.equal(error?.code, "ADAPTER_SANDBOX_CONTROL_UNSUPPORTED");
  // The refusal names the gate that is actually shut. It has now moved twice
  // for the same reason: "no qualified substrate" stopped being true when one
  // qualified (ADR-ERL2-017), and "no container adapter launcher" stopped being
  // true when one landed (ADR-ERL2-034). A refusal citing a reason which had
  // become false would be the first step toward the profile quietly enabling
  // itself. What is shut here is that no qualification has been *derived for
  // this host* — no activation was supplied to this call.
  assert.match(
    error?.message ?? "",
    /disabled_until_container_substrate_qualification_derived_on_this_host/,
  );
  // ...and it still says the profile is not downgraded, because a refusal that
  // fell back to `local-process` would put an opaque subject on the operator's
  // own account.
  assert.match(error?.message ?? "", /not be silently downgraded to local-process/);
});

test("JOURNEY-ORACLE-CANARY: a canary in a mount is refused before the adapter sees it", () => {
  const mountRoot = mkdtempSync(path.join(tmpdir(), "erl2-canary-mount-"));
  writeFileSync(
    path.join(mountRoot, "step.json"),
    `{"expected":"erl2-canary-${"c".repeat(32)}"}\n`,
  );
  const { host } = newHost(REFERENCE_CORRECT_MANIFEST(), referenceAdapterEntry("reference-correct"), {
    mounts: [mount("subject-visible", mountRoot)],
  });
  const error = refusalOf(() =>
    host.run({ operation: "acquire", operationId: "op-1", request: acquisitionRequest("op-1") }),
  );
  assert.equal(error?.code, "JOURNEY_ORACLE_CANARY_LEAKED");
  assert.equal(error?.owner, "lab");

  // The same holds for a Lab secret placed in a mount.
  const secretRoot = mkdtempSync(path.join(tmpdir(), "erl2-secret-mount-"));
  writeFileSync(path.join(secretRoot, "creds"), `erl2-secret-${"d".repeat(32)}\n`);
  const secretHost = newHost(
    REFERENCE_CORRECT_MANIFEST(),
    referenceAdapterEntry("reference-correct"),
    { mounts: [mount("subject-visible", secretRoot)] },
  );
  const secretError = refusalOf(() =>
    secretHost.host.run({
      operation: "acquire",
      operationId: "op-1",
      request: acquisitionRequest("op-1"),
    }),
  );
  assert.equal(secretError?.code, "SECRET_CANARY_IN_DIAGNOSTICS");
});

test("JOURNEY-ORACLE-CANARY: a prefilled output directory is refused", () => {
  const { host, workspaceRoot } = newHost(
    REFERENCE_CORRECT_MANIFEST(),
    referenceAdapterEntry("reference-correct"),
  );
  // Bytes placed by anyone but the adapter would be attributed to the subject.
  mkdirSync(path.join(workspaceRoot, "op-prefilled", "output"), { recursive: true });
  writeFileSync(path.join(workspaceRoot, "op-prefilled", "output", "planted.txt"), "planted\n");
  const error = refusalOf(() =>
    host.run({
      operation: "acquire",
      operationId: "op-prefilled",
      request: acquisitionRequest("op-prefilled"),
    }),
  );
  assert.equal(error?.code, "SUBJECT_OUTPUT_PATH_ESCAPE");
  assert.equal(error?.owner, "lab");
});

test("MOUNT-NET-NEG: the adapter environment is deny-by-default", async () => {
  const { assertEnvironmentAllowlisted, ALLOWED_ENVIRONMENT_VARIABLE_NAMES } = await import(
    "@erl2/core"
  );
  // The allowlist itself passes.
  assertEnvironmentAllowlisted(
    Object.fromEntries(ALLOWED_ENVIRONMENT_VARIABLE_NAMES.map((n) => [n, "x"])),
  );
  for (const denied of [
    "HOME",
    "DOCKER_HOST",
    "AWS_SECRET_ACCESS_KEY",
    "HTTPS_PROXY",
    "GITHUB_TOKEN",
    "SSH_AUTH_SOCK",
  ]) {
    const error = refusalOf(() => assertEnvironmentAllowlisted({ [denied]: "value" }));
    assert.equal(
      error?.code,
      "ADAPTER_ENVIRONMENT_VARIABLE_DENIED",
      `${denied} was not denied`,
    );
  }
});

test("RESIDUE: the correct reference adapter leaves no residue outside its run-scoped workspace", () => {
  const { host, workspaceRoot, storeRoot } = newHost(
    REFERENCE_CORRECT_MANIFEST(),
    referenceAdapterEntry("reference-correct"),
  );
  const result = host.run({
    operation: "report-residue",
    operationId: "op-residue",
    request: stepRequest("op-residue"),
  });
  assert.equal(result.envelope.status, "supported");
  const payload = result.result as { status?: string; residual_paths?: string[] };
  assert.equal(payload.status, "clean");
  assert.deepEqual(payload.residual_paths, []);

  // Everything the adapter touched is inside the run-scoped roots.
  for (const root of [workspaceRoot, storeRoot]) {
    assert.ok(root.length > 0);
    assert.ok(existsSync(root));
  }
  const stray = readdirSync(workspaceRoot).filter((name) => !name.startsWith("op-"));
  assert.deepEqual(stray, [], `the adapter workspace holds unexpected entries: ${stray.join(", ")}`);
});

test("RESIDUE: every sabotage fixture is exercised by this suite", () => {
  const dir = path.join(
    path.dirname(sabotageAdapterEntry("x")),
  );
  const fixtures = readdirSync(dir)
    .filter((f) => f.endsWith(".mjs") && !f.startsWith("_"))
    .map((f) => f.replace(/\.mjs$/, ""))
    .sort();
  // Every adversarial suite, not this file alone. The property is "no sabotage
  // fixture exists that nothing drives"; scoping it to one file made adding a
  // fixture *and* a suite for it read as a coverage regression.
  const adversarialDir = path.join(dir, "..", "..", "..", "tests", "adversarial");
  const suite = readdirSync(adversarialDir)
    .filter((f) => f.endsWith(".test.ts"))
    .map((f) => readFileSync(path.join(adversarialDir, f), "utf8"))
    .join("\n");
  const unexercised = fixtures.filter((name) => !suite.includes(`"${name}"`));
  assert.deepEqual(unexercised, [], `sabotage fixtures with no test: ${unexercised.join(", ")}`);
});
