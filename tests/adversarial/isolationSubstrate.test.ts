/**
 * The isolation substrate lock, its drift check, and the derived qualification
 * report (ERL2-OQ-008, ADR-ERL2-016).
 *
 * The previous file proves the *decision procedure* cannot be talked into
 * qualifying a profile. This one proves the two things that sit either side of
 * it:
 *
 *   - the **lock** actually pins a substrate, and any divergence between the
 *     lock and what is observed now is a refusal before a subject executes;
 *   - the **report** is derived output, so writing one by hand grants nothing.
 *
 * Every test here runs against a scripted `ContainerRuntime`, never a real one:
 * these are refusal properties, and a refusal that depended on a particular
 * host's misconfiguration would not be a property at all. The real substrate is
 * exercised separately in `tests/integration/isolationRealSubstrate.test.ts`,
 * which is skipped unless a runtime is actually present.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  PROBE_SUITE_ID,
  QUALIFIER_RELEASE,
  REQUIRED_ISOLATION_CONTROLS,
  SteppingClock,
  assertObservedMatchesIsolationLock,
  assertProbeSuiteMatchesLock,
  assertQualificationGrantsNoNewAuthority,
  assertQualifiedForExecution,
  assertSuiteCoversEveryControl,
  buildIsolationQualificationReport,
  buildIsolationSubstrateLock,
  diffObservedAgainstIsolationLock,
  probeCatalogue,
  probeSuiteDigest,
  type ObservedSubstrateState,
} from "@erl2/core";
import { assertContract, type Hash, type IsolationEnforcementProbeResultV1 } from "@erl2/contracts";
import { coreHash, developmentKey } from "@erl2/integrity";

const AT = "2026-07-23T00:00:00Z";

function observedState(overrides: Partial<ObservedSubstrateState> = {}): ObservedSubstrateState {
  return {
    runtimeId: "docker",
    runtimeVersion: "29.5.3",
    platform: "linux",
    architecture: "arm64",
    kernelVersion: "6.12.76-linuxkit",
    imageReference: `alpine@sha256:${"1".repeat(64)}`,
    imageDigest: `sha256:${"1".repeat(64)}` as Hash,
    seccomp: "builtin",
    cgroupVersion: "2",
    defaultRuntime: "runc",
    runtimeConfigurationHashes: [`sha256:${"a".repeat(64)}` as Hash],
    policyInputHashes: [`sha256:${"b".repeat(64)}` as Hash],
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

/** A durable probe result, built through the closed contract like a real one. */
function probeResult(
  controlId: (typeof REQUIRED_ISOLATION_CONTROLS)[number],
  lockHash: Hash,
  overrides: Partial<{
    evidence: "observed" | "declared" | "mocked" | "absent";
    enforced: boolean;
    reason_code: string;
  }> = {},
): IsolationEnforcementProbeResultV1 {
  const clock = new SteppingClock(AT, 1_000);
  const evidence = overrides.evidence ?? "observed";
  const enforced = overrides.enforced ?? true;
  const body = {
    schema_version: "isolation-enforcement-probe-result/v1" as const,
    probe_id: `probe-${controlId.slice(0, 40)}`,
    control_id: controlId,
    substrate_lock_hash: lockHash,
    evidence,
    enforced,
    method: "scripted runtime for a refusal property",
    observation: {
      attempted: "scripted",
      observed: "scripted",
      expectation: "scripted",
    },
    ...(enforced && evidence === "observed"
      ? overrides.reason_code === undefined
        ? {}
        : { reason_code: overrides.reason_code }
      : { reason_code: overrides.reason_code ?? "SCRIPTED_NON_OBSERVATION" }),
    resources_cleaned_up: true,
    started_at: clock.now(),
    ended_at: clock.now(),
  };
  return assertContract<IsolationEnforcementProbeResultV1>(
    "IsolationEnforcementProbeResultV1",
    { ...body, core_hash: coreHash(body) },
  );
}

function fullyObserved(lockHash: Hash): IsolationEnforcementProbeResultV1[] {
  return REQUIRED_ISOLATION_CONTROLS.map((c) => probeResult(c, lockHash));
}

function throwsCode(fn: () => unknown, code: string, label = ""): void {
  try {
    fn();
  } catch (error) {
    assert.equal((error as { code?: string }).code, code, `${label}: ${String(error)}`);
    return;
  }
  assert.fail(`${label}: expected refusal ${code}, but nothing was thrown`);
}

test("ISOLATION-LOCK: the suite covers exactly the twenty required controls, once each", () => {
  const catalogue = probeCatalogue();
  assert.equal(catalogue.length, REQUIRED_ISOLATION_CONTROLS.length);
  const covered = catalogue.map((p) => p.controlId).sort();
  assert.deepEqual(covered, [...REQUIRED_ISOLATION_CONTROLS].sort());
  assert.equal(new Set(catalogue.map((p) => p.probeId)).size, catalogue.length);
});

test("ISOLATION-LOCK: a probe suite missing one control cannot be presented as complete", () => {
  const lock = lockFor();
  const partial = fullyObserved(coreHash(lock)).slice(1);
  throwsCode(
    () => assertSuiteCoversEveryControl(partial),
    "ADAPTER_SANDBOX_CONTROL_UNSUPPORTED",
    "a nineteen-control suite",
  );
});

test("ISOLATION-LOCK: an unchanged substrate shows no drift", () => {
  const observed = observedState();
  const lock = lockFor(observed);
  assert.deepEqual(diffObservedAgainstIsolationLock(lock, observed), []);
  assertObservedMatchesIsolationLock(lock, observed);
});

test("ISOLATION-DRIFT: every pinned field is compared, and any divergence refuses", () => {
  const lock = lockFor();
  const drifts: readonly [string, Partial<ObservedSubstrateState>][] = [
    ["runtime_version", { runtimeVersion: "30.0.0" }],
    ["image_digest", { imageDigest: `sha256:${"9".repeat(64)}` as Hash }],
    ["image_reference", { imageReference: "alpine:latest" }],
    ["kernel_version", { kernelVersion: "6.13.0-linuxkit" }],
    ["architecture", { architecture: "amd64" }],
    ["required_security_profile.seccomp", { seccomp: "unconfined" }],
    ["required_security_profile.cgroup_version", { cgroupVersion: "1" }],
    ["required_security_profile.default_runtime", { defaultRuntime: "crun" }],
    // §11.5: the config/policy hash arrays are pinned fields — a substituted
    // config hash and an extra/missing policy hash are all drift.
    ["runtime_configuration_hashes", { runtimeConfigurationHashes: [`sha256:${"c".repeat(64)}` as Hash] }],
    ["policy_input_hashes", { policyInputHashes: [] }],
    ["policy_input_hashes", { policyInputHashes: [`sha256:${"b".repeat(64)}` as Hash, `sha256:${"d".repeat(64)}` as Hash] }],
  ];
  for (const [field, override] of drifts) {
    const observed = observedState(override);
    const diff = diffObservedAgainstIsolationLock(lock, observed);
    assert.ok(
      diff.some((d) => d.field === field),
      `${field} must be reported as drift`,
    );
    throwsCode(
      () => assertObservedMatchesIsolationLock(lock, observed),
      "ENV_ISOLATION_SUBSTRATE_DRIFT",
      field,
    );
  }
});

test("ISOLATION-DRIFT: a weakened probe suite invalidates the lock that pinned the old one", () => {
  const lock = lockFor();
  // Same suite: accepted.
  assertProbeSuiteMatchesLock(lock, PROBE_SUITE_ID, probeSuiteDigest());
  // A suite that dropped a control, or renamed itself, is a different suite.
  throwsCode(
    () => assertProbeSuiteMatchesLock(lock, PROBE_SUITE_ID, `sha256:${"c".repeat(64)}` as Hash),
    "ENV_ISOLATION_SUBSTRATE_DRIFT",
    "weakened suite digest",
  );
  throwsCode(
    () => assertProbeSuiteMatchesLock(lock, "some-other-suite", probeSuiteDigest()),
    "ENV_ISOLATION_SUBSTRATE_DRIFT",
    "renamed suite",
  );
});

test("ISOLATION-REPORT: no lock means not_qualified, whatever the probes say", () => {
  const report = buildIsolationQualificationReport({
    reportId: "r-no-lock",
    profile: "container",
    lock: undefined,
    probeResults: fullyObserved(`sha256:${"0".repeat(64)}` as Hash),
    evaluatedAt: AT,
  });
  assert.equal(report.verdict, "not_qualified");
  assert.equal(report.not_qualified_state, "disabled_no_qualified_adapter_substrate");
  assert.ok(report.reasons.includes("SUBSTRATE_LOCK_NOT_PINNED"));
  assert.equal(report.qualifier_release, QUALIFIER_RELEASE);
});

test("ISOLATION-REPORT: a single declared, mocked, absent or failing control refuses", () => {
  const lock = lockFor();
  const lockHash = coreHash(lock);
  const cases: readonly [string, IsolationEnforcementProbeResultV1[]][] = [
    [
      "declared",
      fullyObserved(lockHash).map((r, i) =>
        i === 0 ? probeResult(r.control_id, lockHash, { evidence: "declared", enforced: false }) : r,
      ),
    ],
    [
      "mocked",
      fullyObserved(lockHash).map((r, i) =>
        i === 1 ? probeResult(r.control_id, lockHash, { evidence: "mocked", enforced: false }) : r,
      ),
    ],
    [
      "absent",
      fullyObserved(lockHash).map((r, i) =>
        i === 2 ? probeResult(r.control_id, lockHash, { evidence: "absent", enforced: false }) : r,
      ),
    ],
    [
      "observed-but-not-enforced",
      fullyObserved(lockHash).map((r, i) =>
        i === 3
          ? probeResult(r.control_id, lockHash, { enforced: false, reason_code: "ESCAPED" })
          : r,
      ),
    ],
    ["missing", fullyObserved(lockHash).slice(1)],
  ];
  for (const [label, probeResults] of cases) {
    const report = buildIsolationQualificationReport({
      reportId: `r-${label.slice(0, 40)}`,
      profile: "container",
      lock,
      probeResults,
      evaluatedAt: AT,
    });
    assert.equal(report.verdict, "not_qualified", label);
    assert.ok(report.missing_controls.length >= 1, label);
    assert.ok(report.reasons.length >= 1, label);
    assert.equal(report.not_qualified_state, "disabled_no_qualified_adapter_substrate", label);
  }
});

test("ISOLATION-REPORT: probe evidence frozen against another substrate does not count", () => {
  const lock = lockFor();
  const foreignLock = lockFor(observedState({ runtimeVersion: "28.0.0" }));
  const report = buildIsolationQualificationReport({
    reportId: "r-foreign-evidence",
    profile: "container",
    lock,
    // Every control observed and enforced — but against a different substrate.
    probeResults: fullyObserved(coreHash(foreignLock)),
    evaluatedAt: AT,
  });
  assert.equal(report.verdict, "not_qualified");
  assert.ok(
    report.reasons.some((r) => r.startsWith("PROBE_BOUND_TO_ANOTHER_SUBSTRATE:")),
    "evidence about one runtime is not evidence about another",
  );
});

test("ISOLATION-REPORT: all twenty observed over an exact lock is the only way to qualify", () => {
  const lock = lockFor();
  const report = buildIsolationQualificationReport({
    reportId: "r-qualified",
    profile: "container",
    lock,
    probeResults: fullyObserved(coreHash(lock)),
    evaluatedAt: AT,
  });
  assert.equal(report.verdict, "qualified");
  assert.deepEqual(report.missing_controls, []);
  assert.deepEqual(report.reasons, []);
  assert.equal(report.observed_controls.length, REQUIRED_ISOLATION_CONTROLS.length);
  assert.equal(report.substrate_lock_hash, coreHash(lock));
  assert.equal(
    (report as { not_qualified_state?: string }).not_qualified_state,
    undefined,
    "a qualified report carries no fail-closed state",
  );
});

test("ISOLATION-EXECUTION: the pre-execution gate re-derives rather than reading a report", () => {
  const observed = observedState();
  const lock = lockFor(observed);
  const probeResults = fullyObserved(coreHash(lock));

  // The honest path passes.
  assertQualifiedForExecution({ profile: "container", lock, observed, probeResults });

  // Drift refuses even though the evidence itself is untouched.
  throwsCode(
    () =>
      assertQualifiedForExecution({
        profile: "container",
        lock,
        observed: observedState({ imageDigest: `sha256:${"e".repeat(64)}` as Hash }),
        probeResults,
      }),
    "ENV_ISOLATION_SUBSTRATE_DRIFT",
    "drifted image digest",
  );

  // A single downgraded control refuses even with an exact lock.
  const weakened = probeResults.map((r, i) =>
    i === 5 ? probeResult(r.control_id, coreHash(lock), { evidence: "mocked", enforced: false }) : r,
  );
  throwsCode(
    () =>
      assertQualifiedForExecution({ profile: "container", lock, observed, probeResults: weakened }),
    "ADAPTER_SANDBOX_CONTROL_UNSUPPORTED",
    "one mocked control",
  );
});

test("ISOLATION-SCOPE: qualification grants no credential, privilege or egress", () => {
  // The state a qualified run must still exhibit: ERL2-OQ-001 untouched and
  // egress still denied by default (ADR-ERL2-016 decision 5).
  assertQualificationGrantsNoNewAuthority({
    grantedCapabilities: [],
    deniedCapabilities: ["elevate-to-root"],
    privilegedBrokerState: "absent_pending_erl2_oq_001",
    egressDecisions: [{ allowed: false }],
  });
  throwsCode(
    () =>
      assertQualificationGrantsNoNewAuthority({
        grantedCapabilities: [],
        deniedCapabilities: [],
        privilegedBrokerState: "active",
        egressDecisions: [],
      }),
    "ADAPTER_PRIVILEGED_OPERATION_NOT_SUPPORTED",
    "a qualified profile must not activate the privilege broker",
  );
  throwsCode(
    () =>
      assertQualificationGrantsNoNewAuthority({
        grantedCapabilities: [],
        deniedCapabilities: [],
        privilegedBrokerState: "absent_pending_erl2_oq_001",
        egressDecisions: [{ allowed: true }],
      }),
    "ADAPTER_EGRESS_DENIED",
    "a qualified profile must not open egress",
  );
});

test("ISOLATION-CONTRACT: a non-observed probe result cannot claim enforcement at all", () => {
  const lock = lockFor();
  // The schema, not the procedure, makes this unrepresentable: `enforced: true`
  // is only valid alongside `evidence: "observed"`.
  for (const evidence of ["declared", "mocked", "absent"] as const) {
    const body = {
      schema_version: "isolation-enforcement-probe-result/v1" as const,
      probe_id: "p-forged",
      control_id: "seccomp-default-profile" as const,
      substrate_lock_hash: coreHash(lock),
      evidence,
      enforced: true,
      method: "forged",
      observation: { attempted: "a", observed: "b", expectation: "c" },
      reason_code: "FORGED",
      resources_cleaned_up: true,
      started_at: AT,
      ended_at: AT,
    };
    throwsCode(
      () =>
        assertContract("IsolationEnforcementProbeResultV1", { ...body, core_hash: coreHash(body) }),
      "SCHEMA_VALIDATION_FAILED",
      `${evidence} claiming enforcement`,
    );
  }
});
