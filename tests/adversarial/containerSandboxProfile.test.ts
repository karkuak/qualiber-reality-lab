/**
 * Every refusal the container-backed launcher added (ERL2-OQ-008 gate 2,
 * ADR-ERL2-034).
 *
 * The launcher's whole risk is that it makes an overclaim *cheap*. Before it,
 * `sandboxControlReport("container")` threw and there was nothing to get wrong.
 * Now thirteen entries can read `enforced`, and the only thing standing between
 * that and a false attestation is that each one is derived from probe bytes
 * bound to a drift-checked lock.
 *
 * So these are the properties, and none of them may depend on a daemon being
 * present: a refusal that only holds on a correctly configured host is not a
 * refusal. Everything here runs against scripted evidence. The real substrate
 * is exercised in `tests/integration/containerAdapterCertification.test.ts` and
 * `tests/adversarial/containerDeadlineEnforcement.test.ts`, which announce
 * themselves loudly when they cannot run.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AdapterHost,
  CONTAINER_PROFILE_ENABLED_STATE,
  CONTAINER_PROFILE_STATE,
  HARDENED_CONTAINER_RUN_FLAGS,
  PROBE_SUITE_ID,
  REQUIRED_ISOLATION_CONTROLS,
  SteppingClock,
  assertControlReportMatchesProfile,
  assertSandboxProfileEnabled,
  buildIsolationSubstrateLock,
  containerObservedControls,
  containerRuntimeConfigurationInput,
  containerSubstrateLockHash,
  deriveContainerProfileActivation,
  enforcedControls,
  fakeEnforcementProbes,
  probeSuiteDigest,
  resolveAdapterModuleClosure,
  runtimeConfigurationHash,
  sandboxControlReport,
  unsupportedControls,
  type ContainerLauncherAvailability,
  type ObservedSubstrateState,
} from "@erl2/core";
import {
  Erl2Error,
  assertContract,
  type Hash,
  type IsolationEnforcementProbeResultV1,
  type SandboxInvocationManifestV1,
} from "@erl2/contracts";
import { ArtifactStore, coreHash, developmentKey } from "@erl2/integrity";
import {
  REFERENCE_CORRECT_MANIFEST,
  referenceAdapterEntry,
  repoRoot,
} from "../support/adapterFixtures.js";

const AT = "2026-08-06T00:00:00Z";
const RUN_ID = "01890000-0000-7000-8000-0000000000aa";

function observedState(overrides: Partial<ObservedSubstrateState> = {}): ObservedSubstrateState {
  return {
    runtimeId: "docker",
    runtimeVersion: "29.5.3",
    platform: "linux",
    architecture: "arm64",
    kernelVersion: "6.12.76-linuxkit",
    imageReference: `erl2-adapter-runtime@sha256:${"1".repeat(64)}`,
    imageDigest: `sha256:${"1".repeat(64)}` as Hash,
    seccomp: "builtin",
    cgroupVersion: "2",
    defaultRuntime: "runc",
    runtimeConfigurationHashes: [runtimeConfigurationHash(containerRuntimeConfigurationInput())],
    policyInputHashes: [runtimeConfigurationHash({ egress: "deny-by-default" })],
    ...overrides,
  };
}

function lockFor(observed = observedState()) {
  return buildIsolationSubstrateLock({
    lockId: "erl2-container-isolation-lock",
    profile: "container",
    observed,
    probeSuiteId: PROBE_SUITE_ID,
    probeSuiteDigest: probeSuiteDigest(),
    recordedAt: AT,
    signingKey: developmentKey("environment-governor"),
  });
}

function probeResult(
  controlId: (typeof REQUIRED_ISOLATION_CONTROLS)[number],
  lockHash: Hash,
  overrides: Partial<{ evidence: "observed" | "mocked"; enforced: boolean }> = {},
): IsolationEnforcementProbeResultV1 {
  const evidence = overrides.evidence ?? "observed";
  const enforced = overrides.enforced ?? true;
  const body = {
    schema_version: "isolation-enforcement-probe-result/v1" as const,
    probe_id: `probe-${controlId.slice(0, 40)}`,
    control_id: controlId,
    substrate_lock_hash: lockHash,
    evidence,
    enforced,
    method: "scripted evidence for a refusal property",
    observation: { attempted: "scripted", observed: "scripted", expectation: "scripted" },
    ...(enforced && evidence === "observed" ? {} : { reason_code: "SCRIPTED_NON_OBSERVATION" }),
    resources_cleaned_up: true,
    started_at: AT,
    ended_at: AT,
  };
  return assertContract<IsolationEnforcementProbeResultV1>(
    "IsolationEnforcementProbeResultV1",
    { ...body, core_hash: coreHash(body) },
  );
}

function fullyObserved(lockHash: Hash): IsolationEnforcementProbeResultV1[] {
  return REQUIRED_ISOLATION_CONTROLS.map((c) => probeResult(c, lockHash));
}

function availableLauncher(): ContainerLauncherAvailability {
  return {
    available: true,
    runtimeId: "docker",
    runtimeBinary: "docker",
    imageReference: `erl2-adapter-runtime@sha256:${"1".repeat(64)}`,
    observedRuntimeVersion: "v22.23.2",
  };
}

function throwsCode(fn: () => unknown, code: string, label: string): void {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof Erl2Error, `${label}: expected a typed refusal, got ${String(error)}`);
    assert.equal(error.code, code, `${label}: wrong refusal code — ${error.message}`);
    return;
  }
  assert.fail(`${label}: expected a refusal and none was raised`);
}

// -- the profile is refused until something derives it ------------------------

test("CONTAINER-PROFILE: with nothing derived, the profile is refused and reports why", () => {
  throwsCode(
    () => assertSandboxProfileEnabled("container"),
    "ADAPTER_SANDBOX_CONTROL_UNSUPPORTED",
    "an underived container profile",
  );
  throwsCode(
    () => sandboxControlReport("container"),
    "ADAPTER_SANDBOX_CONTROL_UNSUPPORTED",
    "a control report for an underived profile",
  );
  // The state string must describe the reason that is actually true now. The
  // launcher exists, so a state asserting it does not would be the first step
  // toward the refusal being deleted as obsolete (ADR-ERL2-017's own argument).
  assert.equal(
    CONTAINER_PROFILE_STATE,
    "disabled_until_container_substrate_qualification_derived_on_this_host",
  );
  assert.ok(!CONTAINER_PROFILE_STATE.includes("launcher_pending"));
  assert.equal(
    CONTAINER_PROFILE_ENABLED_STATE,
    "enabled_container_substrate_qualified_and_launcher_available",
  );
});

test("CONTAINER-PROFILE: the local-process profile is untouched by the container profile existing", () => {
  assert.equal(enforcedControls("local-process").length, 12);
  assert.equal(unsupportedControls("local-process").length, 13);
  for (const entry of sandboxControlReport("local-process")) {
    if (entry.state === "unsupported_on_this_host") {
      assert.ok(entry.reason_code !== undefined, `${entry.control_id} must say why it is absent`);
    }
  }
});

// -- the four gates the derivation applies ------------------------------------

test("CONTAINER-PROFILE: a drifted substrate is refused before anything executes", () => {
  const lock = lockFor();
  const probeResults = fullyObserved(coreHash(lock));
  for (const drift of [
    { imageDigest: `sha256:${"2".repeat(64)}` as Hash },
    { kernelVersion: "6.12.99-linuxkit" },
    { runtimeVersion: "30.0.0" },
    { seccomp: "unconfined" },
    { runtimeConfigurationHashes: [runtimeConfigurationHash({ hardened_flags: [] })] },
  ]) {
    throwsCode(
      () =>
        deriveContainerProfileActivation({
          lock,
          observed: observedState(drift),
          probeResults,
          launcher: availableLauncher(),
          subjectTrust: "trusted_reference",
        }),
      "ENV_ISOLATION_SUBSTRATE_DRIFT",
      `drift in ${Object.keys(drift).join(",")}`,
    );
  }
});

test("CONTAINER-PROFILE: mocked probes qualify nothing, launcher or no launcher", () => {
  const lock = lockFor();
  const lockHash = coreHash(lock);
  // `fakeEnforcementProbes()` reports every control enforced and every one
  // `mocked`. It must remain unable to enable the profile — that property is
  // ADR-ERL2-016 decision 1 and it does not weaken because a launcher landed.
  for (const probe of fakeEnforcementProbes()) {
    assert.equal(probe.evidence, "mocked");
    assert.equal(probe.enforced, true);
  }
  // Its output cannot even be frozen as a durable probe result: the contract
  // makes `enforced: true` unrepresentable without `evidence: "observed"`, so
  // the fake harness's own shape is refused before the derivation is reached.
  assert.throws(
    () => probeResult("seccomp-default-profile", lockHash, { evidence: "mocked", enforced: true }),
    (error: unknown) => error instanceof Erl2Error && error.code === "SCHEMA_VALIDATION_FAILED",
    "a mocked probe claiming enforcement must be unrepresentable",
  );

  const mocked = REQUIRED_ISOLATION_CONTROLS.map((c) =>
    probeResult(c, lockHash, { evidence: "mocked", enforced: false }),
  );
  throwsCode(
    () =>
      deriveContainerProfileActivation({
        lock,
        observed: observedState(),
        probeResults: mocked,
        launcher: availableLauncher(),
        subjectTrust: "trusted_reference",
      }),
    "ADAPTER_SANDBOX_CONTROL_UNSUPPORTED",
    "twenty mocked controls",
  );
  // And one mocked control among nineteen observed is still a refusal.
  const almost = fullyObserved(lockHash).map((r) =>
    r.control_id === "seccomp-default-profile"
      ? probeResult("seccomp-default-profile", lockHash, { evidence: "mocked", enforced: false })
      : r,
  );
  throwsCode(
    () =>
      deriveContainerProfileActivation({
        lock,
        observed: observedState(),
        probeResults: almost,
        launcher: availableLauncher(),
        subjectTrust: "trusted_reference",
      }),
    "ADAPTER_SANDBOX_CONTROL_UNSUPPORTED",
    "one mocked control among twenty",
  );
});

test("CONTAINER-PROFILE: a qualified substrate with no launcher is still refused", () => {
  const lock = lockFor();
  for (const launcher of [
    { available: false as const, runtimeId: "docker", runtimeBinary: "docker", imageReference: lock.image_reference, reason: "CONTAINER_RUNTIME_UNAVAILABLE" },
    { available: false as const, runtimeId: "docker", runtimeBinary: "docker", imageReference: lock.image_reference, reason: "LOCKED_IMAGE_CANNOT_HOST_THE_ADAPTER_PROTOCOL" },
  ]) {
    throwsCode(
      () =>
        deriveContainerProfileActivation({
          lock,
          observed: observedState(),
          probeResults: fullyObserved(coreHash(lock)),
          launcher,
          subjectTrust: "trusted_reference",
        }),
      "ADAPTER_SANDBOX_CONTROL_UNSUPPORTED",
      `launcher unavailable: ${launcher.reason}`,
    );
  }
});

test("CONTAINER-PROFILE: an opaque or third-party subject is refused a fully working profile", () => {
  const lock = lockFor();
  for (const subjectTrust of ["opaque_private", "third_party"] as const) {
    throwsCode(
      () =>
        deriveContainerProfileActivation({
          lock,
          observed: observedState(),
          probeResults: fullyObserved(coreHash(lock)),
          launcher: availableLauncher(),
          subjectTrust,
        }),
      "ADAPTER_SANDBOX_CONTROL_UNSUPPORTED",
      `a ${subjectTrust} subject`,
    );
  }
  // A trusted reference subject is the one case that derives.
  const activation = deriveContainerProfileActivation({
    lock,
    observed: observedState(),
    probeResults: fullyObserved(coreHash(lock)),
    launcher: availableLauncher(),
    subjectTrust: "trusted_reference",
  });
  assert.equal(activation.state, CONTAINER_PROFILE_ENABLED_STATE);
  assert.equal(containerObservedControls(activation).length, 13);
});

test("CONTAINER-PROFILE: probe evidence frozen against another lock licenses nothing", () => {
  const lock = lockFor();
  const otherLock = lockFor(observedState({ kernelVersion: "6.1.0-other" }));
  throwsCode(
    () =>
      deriveContainerProfileActivation({
        lock,
        observed: observedState(),
        probeResults: fullyObserved(coreHash(otherLock)),
        launcher: availableLauncher(),
        subjectTrust: "trusted_reference",
      }),
    "ENV_ISOLATION_SUBSTRATE_DRIFT",
    "probes bound to a different substrate",
  );
});

// -- the derived report cannot be talked up -----------------------------------

test("CONTAINER-PROFILE: the control report is derived per control, from the probe bytes", () => {
  const lock = lockFor();
  const activation = deriveContainerProfileActivation({
    lock,
    observed: observedState(),
    probeResults: fullyObserved(coreHash(lock)),
    launcher: availableLauncher(),
    subjectTrust: "trusted_reference",
  });
  const report = sandboxControlReport("container", activation);
  assert.equal(report.length, 25);
  assert.equal(report.filter((c) => c.state === "enforced").length, 25);

  // Every enforced entry among the thirteen traces to a probe that observed
  // that control on this lock, one at a time — not to the aggregate verdict.
  for (const entry of report.slice(12)) {
    const probe = activation.probeResults.find((r) => r.control_id === entry.control_id);
    assert.equal(probe?.evidence, "observed", `${entry.control_id} is claimed without an observation`);
    assert.equal(probe?.enforced, true);
  }

  // And the derivation is per control, not all-or-nothing: probe evidence that
  // covers nineteen controls yields twelve of the thirteen, never thirteen.
  // (Such an activation cannot pass the gates — the test below is what proves
  // that — so this is the derivation itself under test, not a reachable report.)
  assert.equal(
    containerObservedControls({
      ...activation,
      probeResults: activation.probeResults.filter(
        (r) => r.control_id !== "seccomp-default-profile",
      ),
    }).length,
    12,
  );
});

test("CONTAINER-PROFILE: an activation is re-derived from its evidence on every use", () => {
  // `ContainerProfileActivation` is a structural type, so the object literal is
  // writable by anyone. It grants nothing on its own: every gate re-runs over
  // the evidence it carries, so a fabricated activation has to carry a real
  // signed lock and twenty real probe results bound to it.
  const lock = lockFor();
  const activation = deriveContainerProfileActivation({
    lock,
    observed: observedState(),
    probeResults: fullyObserved(coreHash(lock)),
    launcher: availableLauncher(),
    subjectTrust: "trusted_reference",
  });
  assertSandboxProfileEnabled("container", activation);

  const forgeries: readonly (readonly [string, typeof activation, string])[] = [
    [
      "a label with no evidence behind it",
      { ...activation, probeResults: [] },
      "ADAPTER_SANDBOX_CONTROL_UNSUPPORTED",
    ],
    [
      "evidence for a substrate that is not the one observed",
      { ...activation, observed: observedState({ kernelVersion: "6.1.0-other" }) },
      "ENV_ISOLATION_SUBSTRATE_DRIFT",
    ],
    [
      "a trust class re-labelled after the fact",
      { ...activation, subjectTrust: "opaque_private" as const },
      "ADAPTER_SANDBOX_CONTROL_UNSUPPORTED",
    ],
    [
      "a launcher asserted rather than observed",
      {
        ...activation,
        launcher: { ...activation.launcher, available: false, reason: "FORGED" },
      },
      "ADAPTER_SANDBOX_CONTROL_UNSUPPORTED",
    ],
  ];
  for (const [label, forged, code] of forgeries) {
    throwsCode(() => assertSandboxProfileEnabled("container", forged), code, label);
    throwsCode(() => sandboxControlReport("container", forged), code, `${label} (report)`);
  }
});

test("CONTAINER-PROFILE: a container manifest that names no substrate lock is refused", () => {
  const lock = lockFor();
  const activation = deriveContainerProfileActivation({
    lock,
    observed: observedState(),
    probeResults: fullyObserved(coreHash(lock)),
    launcher: availableLauncher(),
    subjectTrust: "trusted_reference",
  });
  const base = {
    schema_version: "sandbox-invocation-manifest/v1" as const,
    run_id: RUN_ID,
    operation_id: "op-1",
    invocation_id: "invocation-0001",
    adapter_manifest_hash: `sha256:${"3".repeat(64)}` as Hash,
    adapter_artifact_hash: `sha256:${"4".repeat(64)}` as Hash,
    executable_file_sha256: `sha256:${"5".repeat(64)}` as Hash,
    protocol_version: "subject-adapter/v1" as const,
    working_directory_path: "adapter-workspace/op-1",
    read_only_mounts: [],
    writable_output_path: "adapter-workspace/op-1/output",
    sandbox_profile: "container" as const,
    isolation_substrate_lock_hash: containerSubstrateLockHash(activation),
    environment_variable_names: ["ERL2_RUN_ID"],
    enforced_controls: sandboxControlReport("container", activation).map((c) => ({
      control_id: c.control_id,
      state: c.state,
      ...(c.reason_code === undefined ? {} : { reason_code: c.reason_code }),
    })),
    resource_limits: {
      wall_clock_ms: 30_000,
      max_request_bytes: 1024,
      max_response_bytes: 1024,
      max_output_files: 8,
      max_output_bytes: 1024,
      max_output_path_depth: 4,
      max_diagnostic_bytes: 1024,
    },
    capability_ids: [] as never,
    credential_handle_ids: [],
    deadline: AT,
    created_at: AT,
  };
  const manifest = assertContract<SandboxInvocationManifestV1>("SandboxInvocationManifestV1", {
    ...base,
    core_hash: coreHash(base),
  });
  assertControlReportMatchesProfile(manifest, "container", activation);

  // The same manifest naming somebody else's lock is refused: a control report
  // is only meaningful against the evidence that licensed it.
  const foreign = { ...base, isolation_substrate_lock_hash: `sha256:${"9".repeat(64)}` as Hash };
  const foreignManifest = assertContract<SandboxInvocationManifestV1>(
    "SandboxInvocationManifestV1",
    { ...foreign, core_hash: coreHash(foreign) },
  );
  throwsCode(
    () => assertControlReportMatchesProfile(foreignManifest, "container", activation),
    "ADAPTER_SANDBOX_CONTROL_UNSUPPORTED",
    "a container manifest bound to a foreign lock",
  );
});

// -- the host refuses to be constructed without the derivation ----------------

test("CONTAINER-PROFILE: a host cannot be built on the container profile without an activation", () => {
  const options = {
    runId: RUN_ID,
    adapterManifest: REFERENCE_CORRECT_MANIFEST(),
    adapterEntryPath: referenceAdapterEntry("reference-correct"),
    workspaceRoot: mkdtempSync(path.join(tmpdir(), "erl2-container-refusal-")),
    store: new ArtifactStore(mkdtempSync(path.join(tmpdir(), "erl2-container-refusal-store-"))),
    clock: new SteppingClock(AT, 1000),
  };
  throwsCode(
    () => new AdapterHost({ ...options, profile: "container" }),
    "ADAPTER_SANDBOX_CONTROL_UNSUPPORTED",
    "a container host with no activation",
  );

  // With an activation but no adapter package, there is nothing to mount and
  // the refusal must say so rather than starting an empty container.
  const lock = lockFor();
  const activation = deriveContainerProfileActivation({
    lock,
    observed: observedState(),
    probeResults: fullyObserved(coreHash(lock)),
    launcher: availableLauncher(),
    subjectTrust: "trusted_reference",
  });
  throwsCode(
    () => new AdapterHost({ ...options, profile: "container", containerActivation: activation }),
    "ADAPTER_SANDBOX_CONTROL_UNSUPPORTED",
    "a container host with no adapter package",
  );

  // An entry outside its declared package root would not be inside the mounted
  // namespace, so it is refused rather than silently mounting something wider.
  throwsCode(
    () =>
      new AdapterHost({
        ...options,
        profile: "container",
        containerActivation: activation,
        containerAdapterPackage: {
          packageRoot: path.join(repoRoot, "adapters", "reference-limited"),
          moduleDirectories: [],
        },
      }),
    "ADAPTER_IDENTITY_MISMATCH",
    "an adapter entry outside its package root",
  );
});

// -- the mount surface --------------------------------------------------------

test("CONTAINER-PROFILE: the module closure is the declared graph, resolved and bounded", () => {
  const closure = resolveAdapterModuleClosure(path.join(repoRoot, "adapters", "reference-correct"));
  const names = closure.map((m) => m.name);
  assert.ok(names.includes("@erl2/adapter-sdk"));
  assert.ok(names.includes("@erl2/contracts"));
  // Nothing outside the declared graph is mounted — in particular, not the
  // repository root, which holds the vault, truth, judge and selection roots a
  // probe just observed to be unreachable from inside a container.
  for (const module of closure) {
    assert.ok(
      !/(^|\/)(vault|truth|judge|selection|fixtures)(\/|$)/.test(module.hostPath),
      `${module.name} resolves into a Lab authority root: ${module.hostPath}`,
    );
    assert.notEqual(path.resolve(module.hostPath), repoRoot);
  }
  // A package with no manifest declares no dependencies, which is a closure of
  // zero rather than a failure — that is how the single-file sabotage fixtures
  // run.
  assert.deepEqual(
    resolveAdapterModuleClosure(path.join(repoRoot, "fixtures", "sabotage", "adapters")),
    [],
  );
});

test("CONTAINER-PROFILE: the launcher and the probes apply the same hardened flags", () => {
  // The probe suite, the launcher and the hash the lock pins all read one
  // constant. If they did not, the evidence would describe a configuration no
  // adapter runs under, and nothing would compare the two.
  assert.deepEqual(containerRuntimeConfigurationInput(), {
    hardened_flags: [...HARDENED_CONTAINER_RUN_FLAGS],
  });
  for (const required of [
    "--read-only",
    "--cap-drop=ALL",
    "--network=none",
    "--pids-limit=64",
    "--memory=64m",
    "--cpus=0.5",
  ]) {
    assert.ok(
      HARDENED_CONTAINER_RUN_FLAGS.includes(required),
      `${required} must be part of the qualified configuration`,
    );
  }
  assert.ok(HARDENED_CONTAINER_RUN_FLAGS.includes("no-new-privileges"));
  assert.ok(HARDENED_CONTAINER_RUN_FLAGS.includes("65532:65532"));
  // Nothing that would open a writable surface the probes never saw.
  assert.ok(!HARDENED_CONTAINER_RUN_FLAGS.some((f) => f.startsWith("--tmpfs")));
  assert.ok(!HARDENED_CONTAINER_RUN_FLAGS.some((f) => f.includes("privileged")));
});
