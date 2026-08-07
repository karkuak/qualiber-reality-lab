/**
 * `ADAPTER-CERT-V1` under the **container** profile — the §5.5 exit gate
 * (ERL2-OQ-008 gate 2, ADR-ERL2-017 §Decision 4, ADR-ERL2-034).
 *
 * ADR-ERL2-017 named this as the gate that had never been met: "the
 * certification suite passes under the qualified profile ... It has not,
 * because no launcher can place an adapter there." This file is where that
 * stops being true, and it is deliberately the same suite, run against the same
 * reference adapter, through the same public protocol — only the launcher
 * underneath is different.
 *
 * What passing here does *not* mean is set out in ADR-ERL2-034 and re-asserted
 * at the bottom of this file: the retained evidence is still dev-signed and
 * therefore self-reported, so an opaque-private or third-party subject is still
 * refused, under this profile as under the other one.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  CONTAINER_PROFILE_STATE,
  REQUIRED_ISOLATION_CONTROLS,
  SteppingClock,
  assertSandboxProfileEnabled,
  certifyAdapter,
  containerObservedControls,
  containerSubstrateLockHash,
  deriveContainerProfileActivation,
  enforcedControls,
  unsupportedControls,
} from "@erl2/core";
import { Erl2Error, type IsolationEnforcementProbeResultV1 } from "@erl2/contracts";
import { REFERENCE_CORRECT_MANIFEST, referenceAdapterEntry } from "../support/adapterFixtures.js";
import {
  announceContainerSkip,
  containerAdapterPackage,
  containerProfile,
} from "../support/containerProfile.js";

const clock = (): SteppingClock => new SteppingClock("2026-08-06T00:00:00Z", 1000);

test("ADAPTER-CERT-V1 §5.5: the suite passes under the container profile", (t) => {
  const profile = containerProfile();
  if (!profile.available) {
    announceContainerSkip(t, profile.reason);
    // The fail-closed state is the assertion in this branch: with nothing
    // derived, the profile refuses rather than degrading to local-process.
    assert.throws(
      () => assertSandboxProfileEnabled("container"),
      (error: unknown) =>
        error instanceof Erl2Error &&
        error.code === "ADAPTER_SANDBOX_CONTROL_UNSUPPORTED" &&
        error.message.includes(CONTAINER_PROFILE_STATE),
    );
    return;
  }

  const receipt = certifyAdapter({
    adapterManifest: REFERENCE_CORRECT_MANIFEST(),
    adapterEntryPath: referenceAdapterEntry("reference-correct"),
    clock: clock(),
    certifierId: "erl2-certifier",
    profile: "container",
    containerActivation: profile.activation,
    containerAdapterPackage: containerAdapterPackage(
      "adapters/reference-correct",
    ),
  });

  assert.equal(receipt.verdict, "certified", JSON.stringify(receipt.refusal_codes));
  assert.deepEqual(receipt.refusal_codes, []);
  assert.equal(receipt.suite, "ADAPTER-CERT-V1");
  assert.deepEqual(
    receipt.checks.filter((c) => c.status === "failed"),
    [],
  );

  // Every check the local profile passes, passed here too — including the two
  // that exercise the launcher rather than the adapter.
  const byId = new Map(receipt.checks.map((c) => [c.check_id, c.status]));
  for (const required of [
    "immutable-artifact-identity",
    "no-privileged-broker-capability",
    "no-product-specific-core-change",
    "protocol-negotiation",
    "unsupported-retention",
    "diagnostics-bounds",
    "deterministic-projection",
    "phase-request-ancestry",
    "oracle-partition",
    "mutation-disclosure",
    "unsupported-package-kind",
    "deadline-and-process-tree-termination",
    "no-execution-after-output-freeze",
  ]) {
    assert.equal(byId.get(required), "passed", `check ${required} did not pass in a container`);
  }

  // The receipt reports the controls of the profile it ran under. This is the
  // difference the whole package is about: the thirteen entries that read
  // `unsupported_on_this_host` on a process host are enforced here, and each of
  // them is enforced because a probe observed it on this exact substrate.
  assert.deepEqual([...receipt.unsupported_controls], [], "a container run supports every control");
  for (const control of [
    "read-only-root-filesystem",
    "capability-drop-all",
    "no-new-privileges",
    "seccomp-default-profile",
    "network-namespace-isolation",
    "no-docker-socket",
    "numeric-non-root-user",
    "pid-limit",
    "memory-limit",
    "cpu-limit",
  ] as const) {
    assert.ok(
      receipt.enforced_controls.includes(control),
      `${control} must be enforced under the container profile`,
    );
    assert.ok(
      unsupportedControls("local-process").includes(control),
      `${control} must still be unsupported under local-process; the profiles must not converge`,
    );
  }

  // And the local profile is unchanged by any of this.
  assert.equal(enforcedControls("local-process").length, 12);
  assert.equal(unsupportedControls("local-process").length, 13);
});

test("ADAPTER-CERT-V1 §5.5: an opaque or third-party subject is refused the profile it certified under", (t) => {
  const profile = containerProfile();
  if (!profile.available) {
    announceContainerSkip(t, profile.reason);
    assert.throws(() => assertSandboxProfileEnabled("container"));
    return;
  }
  // The substrate qualifies, the launcher works, and the certification above
  // passed — and these are still refused. Closing gate 2 did not close
  // ERL2-OQ-008, because the retained evidence is signed by a repo-derivable
  // development key and is therefore self-reported.
  for (const subjectTrust of ["opaque_private", "third_party"] as const) {
    assert.throws(
      () =>
        deriveContainerProfileActivation({
          lock: profile.lock,
          observed: {
            runtimeId: profile.lock.runtime_id,
            runtimeVersion: profile.lock.runtime_version,
            platform: profile.lock.platform,
            architecture: profile.lock.architecture,
            kernelVersion: profile.lock.kernel_version,
            imageReference: profile.lock.image_reference,
            imageDigest: profile.lock.image_digest,
            seccomp: profile.lock.required_security_profile.seccomp,
            cgroupVersion: profile.lock.required_security_profile.cgroup_version,
            defaultRuntime: profile.lock.required_security_profile.default_runtime,
            runtimeConfigurationHashes: [...profile.lock.runtime_configuration_hashes],
            policyInputHashes: [...profile.lock.policy_input_hashes],
          },
          probeResults: profile.probeResults,
          launcher: {
            available: true,
            runtimeId: profile.lock.runtime_id,
            runtimeBinary: profile.runtimeBinary,
            imageReference: profile.lock.image_reference,
          },
          subjectTrust,
        }),
      (error: unknown) =>
        error instanceof Erl2Error &&
        error.code === "ADAPTER_SANDBOX_CONTROL_UNSUPPORTED" &&
        error.message.includes(subjectTrust),
      `a ${subjectTrust} subject must not reach the container profile`,
    );
  }
});

test("ADAPTER-CERT-V1 §5.5: the profile claims exactly the controls the probes observed", (t) => {
  const profile = containerProfile();
  if (!profile.available) {
    announceContainerSkip(t, profile.reason);
    return;
  }
  // Every control the container profile flips to `enforced` is one of the
  // twenty the probe suite covers, and each was observed on *this* lock. The
  // report is derived from those bytes, so a substrate that qualified on
  // nineteen could not produce a report claiming twenty.
  const probed = new Set<string>(REQUIRED_ISOLATION_CONTROLS);
  const observedControls = containerObservedControls(profile.activation);
  for (const control of observedControls) {
    assert.ok(probed.has(control), `${control} is claimed with no probe behind it`);
    const evidence: IsolationEnforcementProbeResultV1 | undefined = profile.probeResults.find(
      (r) => r.control_id === control,
    );
    assert.equal(evidence?.evidence, "observed", `${control} must be observed, not asserted`);
    assert.equal(evidence?.enforced, true, `${control} must have been seen holding`);
  }
  assert.equal(observedControls.length, 13);
  assert.equal(containerSubstrateLockHash(profile.activation).startsWith("sha256:"), true);
});
