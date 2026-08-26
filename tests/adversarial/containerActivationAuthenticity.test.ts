/**
 * The execution gate authenticates the substrate lock and the probe results it
 * runs on, not just their content (EQ-L-010).
 *
 * `assertQualifiedForExecution` used to compare caller-supplied fields against
 * other caller-supplied fields and two recomputable constants, and never called
 * the two Ed25519 verifiers that already existed for `erl2 doctor`. A structural
 * forgery — a lock with a garbage signature, a nonexistent image, `unconfined`
 * seccomp, and twenty probe results that observed nothing — was therefore
 * accepted, and reported twenty-five enforced controls for a substrate that
 * never existed. These are the properties that close that gap:
 *
 *   - the lock's Ed25519 signature must verify (garbage, tampered or
 *     untrusted-signer locks are refused);
 *   - a covering signed probe-signing manifest must be present and authenticate
 *     exactly the evaluated probe results (an absent or substituted manifest is
 *     refused, fail-closed);
 *   - caller-supplied equality never substitutes for a verified signature.
 *
 * None of this needs Docker: it exercises the assertion functions over authentic
 * dev-signed material and object-literal forgeries, exactly as the retained
 * reproduction (`review-package/reproduction/repro-eql010.mjs`) does. The
 * accepted signer here is the repo-derivable development governor key, so a
 * passing result is `locally_observed_unauthenticated`, never `authenticated`
 * (ERL2-OQ-008 stays open) — this refuses an unsigned forgery, it is not
 * confinement or certification.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  CONTAINER_PROFILE_ENABLED_STATE,
  PROBE_SUITE_ID,
  assertQualifiedForExecution,
  assertSandboxProfileEnabled,
  buildIsolationProbeSigningManifest,
  buildIsolationSubstrateLock,
  deriveContainerProfileActivation,
  enforcedControls,
  probeSuiteDigest,
  REQUIRED_ISOLATION_CONTROLS,
  runtimeConfigurationHash,
  containerRuntimeConfigurationInput,
  sandboxControlReport,
  type ContainerLauncherAvailability,
  type ObservedSubstrateState,
} from "@erl2/core";
import {
  Erl2Error,
  assertContract,
  type Hash,
  type IsolationEnforcementProbeResultV1,
  type IsolationProbeSigningManifestV1,
  type IsolationSubstrateLockV1,
} from "@erl2/contracts";
import { coreHash, developmentKey } from "@erl2/integrity";

const AT = "2026-08-06T00:00:00Z";

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

/** A real substrate lock, signed by the named development key (governor by default). */
function lockFor(
  observed = observedState(),
  signingKey = developmentKey("environment-governor"),
): IsolationSubstrateLockV1 {
  return buildIsolationSubstrateLock({
    lockId: "erl2-container-isolation-lock",
    profile: "container",
    observed,
    probeSuiteId: PROBE_SUITE_ID,
    probeSuiteDigest: probeSuiteDigest(),
    recordedAt: AT,
    signingKey,
  });
}

function probeResult(
  controlId: (typeof REQUIRED_ISOLATION_CONTROLS)[number],
  lockHash: Hash,
  overrides: Partial<{ method: string }> = {},
): IsolationEnforcementProbeResultV1 {
  const body = {
    schema_version: "isolation-enforcement-probe-result/v1" as const,
    probe_id: `probe-${controlId.slice(0, 40)}`,
    control_id: controlId,
    substrate_lock_hash: lockHash,
    evidence: "observed" as const,
    enforced: true,
    method: overrides.method ?? "scripted evidence for an authenticity property",
    observation: { attempted: "scripted", observed: "scripted", expectation: "scripted" },
    resources_cleaned_up: true,
    started_at: AT,
    ended_at: AT,
  };
  return assertContract<IsolationEnforcementProbeResultV1>("IsolationEnforcementProbeResultV1", {
    ...body,
    core_hash: coreHash(body),
  });
}

function fullyObserved(lockHash: Hash): IsolationEnforcementProbeResultV1[] {
  return REQUIRED_ISOLATION_CONTROLS.map((c) => probeResult(c, lockHash));
}

/** A dev-signed manifest covering exactly these probe results, bound to this lock. */
function manifestFor(
  lock: IsolationSubstrateLockV1,
  probeResults: readonly IsolationEnforcementProbeResultV1[],
  signingKey = developmentKey("environment-governor"),
): IsolationProbeSigningManifestV1 {
  return buildIsolationProbeSigningManifest({
    manifestId: "erl2-container-probe-signing-manifest",
    lock,
    probeResults,
    signedAt: AT,
    signingKey,
  });
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

// -- T1: the positive control -------------------------------------------------

test("ISOLATION-AUTHENTIC: a valid activation with a covering manifest is accepted", () => {
  const lock = lockFor();
  const probeResults = fullyObserved(coreHash(lock));
  const probeManifest = manifestFor(lock, probeResults);

  assert.doesNotThrow(() =>
    assertQualifiedForExecution({
      profile: "container",
      lock,
      observed: observedState(),
      probeResults,
      probeManifest,
    }),
  );

  const activation = deriveContainerProfileActivation({
    lock,
    observed: observedState(),
    probeResults,
    probeSigningManifest: probeManifest,
    launcher: availableLauncher(),
    subjectTrust: "trusted_reference",
  });
  assert.equal(activation.state, CONTAINER_PROFILE_ENABLED_STATE);
  assertSandboxProfileEnabled("container", activation);
  const report = sandboxControlReport("container", activation);
  assert.equal(report.length, 25);
  assert.equal(report.filter((c) => c.state === "enforced").length, 25);
  assert.equal(enforcedControls("container", activation).length, 25);
});

// -- T2 / T3 / T8 / T9: the lock signature is authority, not the fields --------

test("ISOLATION-AUTHENTIC: an unsigned/garbage-signed lock is refused at the execution gate", () => {
  const lock = lockFor();
  const probeResults = fullyObserved(coreHash(lock));
  // A covering, valid manifest, so ONLY the lock-signature gate can refuse this.
  const probeManifest = manifestFor(lock, probeResults);
  // `signed_hash` no longer equals the lock's core hash: an unsigned fabrication.
  const forged: IsolationSubstrateLockV1 = {
    ...lock,
    signature: {
      ...lock.signature,
      signed_hash: `sha256:${"0".repeat(64)}` as Hash,
      signature_base64: Buffer.from("not-a-real-signature").toString("base64"),
    },
  };
  throwsCode(
    () =>
      assertQualifiedForExecution({
        profile: "container",
        lock: forged,
        observed: observedState(),
        probeResults,
        probeManifest,
      }),
    "ENV_ISOLATION_LOCK_UNAUTHENTIC",
    "a garbage-signed lock",
  );
});

test("ISOLATION-AUTHENTIC: a corrupted lock signature is refused", () => {
  const lock = lockFor();
  const probeResults = fullyObserved(coreHash(lock));
  const probeManifest = manifestFor(lock, probeResults);
  // Flip one byte of an otherwise-valid signature; `signed_hash` still matches
  // (core hash excludes the signature), so only the Ed25519 check can catch it.
  const raw = Buffer.from(lock.signature.signature_base64, "base64");
  raw[0] = raw[0]! ^ 0xff;
  const corrupted: IsolationSubstrateLockV1 = {
    ...lock,
    signature: { ...lock.signature, signature_base64: raw.toString("base64") },
  };
  throwsCode(
    () =>
      assertQualifiedForExecution({
        profile: "container",
        lock: corrupted,
        observed: observedState(),
        probeResults,
        probeManifest,
      }),
    "ENV_ISOLATION_LOCK_UNAUTHENTIC",
    "a one-byte-corrupted lock signature",
  );
});

test("ISOLATION-AUTHENTIC: caller-supplied equality does not substitute for authority", () => {
  // Every caller-vs-caller comparison agrees: the observed state is derived from
  // the (forged) lock, the twenty probes are bound to it, the suite digest is the
  // real recomputable constant, and a dev-signed manifest even covers the probes.
  // Only the lock's own signature is missing — and that is enough to refuse.
  const lock = lockFor();
  const probeResults = fullyObserved(coreHash(lock));
  const probeManifest = manifestFor(lock, probeResults);
  const unsigned: IsolationSubstrateLockV1 = {
    ...lock,
    signature: {
      ...lock.signature,
      signed_hash: `sha256:${"0".repeat(64)}` as Hash,
      signature_base64: Buffer.from("mutually-consistent-but-unsigned").toString("base64"),
    },
  };
  throwsCode(
    () =>
      assertQualifiedForExecution({
        profile: "container",
        lock: unsigned,
        observed: observedState(),
        probeResults,
        probeManifest,
      }),
    "ENV_ISOLATION_LOCK_UNAUTHENTIC",
    "a mutually-consistent but unsigned activation",
  );
});

test("ISOLATION-AUTHENTIC: an untrusted (non-pinned, non-dev) signer key is refused", () => {
  // The lock is validly signed — by a key the verifier does not hold. A valid
  // signature by an unknown key is not authority.
  const observed = observedState();
  const lock = lockFor(observed, developmentKey("intruder"));
  const probeResults = fullyObserved(coreHash(lock));
  const probeManifest = manifestFor(lock, probeResults);
  throwsCode(
    () =>
      assertQualifiedForExecution({
        profile: "container",
        lock,
        observed,
        probeResults,
        probeManifest,
      }),
    "ENV_ISOLATION_LOCK_UNAUTHENTIC",
    "a lock signed by an unpinned, non-development key",
  );
});

// -- T4 / T5 / T6: the probe manifest must authenticate the evidence ----------

test("ISOLATION-AUTHENTIC: an activation with no probe manifest is refused", () => {
  const lock = lockFor();
  const probeResults = fullyObserved(coreHash(lock));
  throwsCode(
    () =>
      assertQualifiedForExecution({
        profile: "container",
        lock,
        observed: observedState(),
        probeResults,
        probeManifest: undefined,
      }),
    "ENV_ISOLATION_PROBE_MANIFEST_UNAUTHENTIC",
    "a real lock and probes but no covering manifest",
  );
});

test("ISOLATION-AUTHENTIC: a manifest that does not cover a substituted probe is refused", () => {
  const lock = lockFor();
  const probeResults = fullyObserved(coreHash(lock));
  const probeManifest = manifestFor(lock, probeResults);
  // Swap in a different probe body for the same control: it still qualifies on
  // content, but its recomputed hash is not one the manifest signed.
  const substituted = [...probeResults];
  substituted[0] = probeResult(probeResults[0]!.control_id, coreHash(lock), {
    method: "a substituted probe the manifest never signed",
  });
  throwsCode(
    () =>
      assertQualifiedForExecution({
        profile: "container",
        lock,
        observed: observedState(),
        probeResults: substituted,
        probeManifest,
      }),
    "ENV_ISOLATION_PROBE_MANIFEST_UNAUTHENTIC",
    "a probe substituted after the manifest was signed",
  );
});

test("ISOLATION-AUTHENTIC: a probe lying about its own core_hash cannot be covered", () => {
  const lock = lockFor();
  const probeResults = fullyObserved(coreHash(lock));
  const probeManifest = manifestFor(lock, probeResults);
  // The body is substituted (a different `method`), so its true recomputed hash
  // differs — but its stored `core_hash` field is set back to the original, the
  // exact lie the manifest coverage defeats by recomputing rather than reading.
  const original = probeResults[0]!;
  const substitutedBody = probeResult(original.control_id, coreHash(lock), {
    method: "a body the manifest never signed",
  });
  const lying = [...probeResults];
  lying[0] = { ...substitutedBody, core_hash: original.core_hash };
  throwsCode(
    () =>
      assertQualifiedForExecution({
        profile: "container",
        lock,
        observed: observedState(),
        probeResults: lying,
        probeManifest,
      }),
    "ENV_ISOLATION_PROBE_MANIFEST_UNAUTHENTIC",
    "a probe whose stored core_hash lies about a substituted body",
  );
});

// -- T7: the subject-trust gate is preserved and orthogonal -------------------

test("ISOLATION-AUTHENTIC: an untrusted subject is still refused even with authentic evidence", () => {
  const lock = lockFor();
  const probeResults = fullyObserved(coreHash(lock));
  const probeSigningManifest = manifestFor(lock, probeResults);
  for (const subjectTrust of ["opaque_private", "third_party"] as const) {
    throwsCode(
      () =>
        deriveContainerProfileActivation({
          lock,
          observed: observedState(),
          probeResults,
          probeSigningManifest,
          launcher: availableLauncher(),
          subjectTrust,
        }),
      "ADAPTER_SANDBOX_CONTROL_UNSUPPORTED",
      `a ${subjectTrust} subject with authentic evidence`,
    );
  }
});

// -- the forged full activation cannot reach the consumer ---------------------

test("ISOLATION-AUTHENTIC: a structurally forged activation is refused at the consumer seam", () => {
  // The object literal carries a garbage-signed lock and an absent manifest, the
  // exact EQ-L-010 forgery. `assertSandboxProfileEnabled` re-runs the gate over
  // the evidence, so the label grants nothing and no control report is produced.
  const realLock = lockFor();
  const realProbes = fullyObserved(coreHash(realLock));
  const forgedLock: IsolationSubstrateLockV1 = {
    ...realLock,
    image_digest: `sha256:${"0".repeat(64)}` as Hash,
    required_security_profile: { ...realLock.required_security_profile, seccomp: "unconfined" },
    signature: {
      ...realLock.signature,
      signed_hash: `sha256:${"0".repeat(64)}` as Hash,
      signature_base64: Buffer.from("not-a-real-signature").toString("base64"),
    },
  };
  const forgedProbes = fullyObserved(coreHash(forgedLock));
  const forgedActivation = {
    state: CONTAINER_PROFILE_ENABLED_STATE,
    lock: forgedLock,
    observed: observedState({
      imageDigest: `sha256:${"0".repeat(64)}` as Hash,
      seccomp: "unconfined",
    }),
    probeResults: forgedProbes,
    probeSigningManifest: manifestFor(forgedLock, forgedProbes),
    launcher: availableLauncher(),
    subjectTrust: "trusted_reference" as const,
  };
  // The manifest here is dev-signable over the forged material, so the refusal is
  // the LOCK signature — proving the manifest alone is not the whole gate.
  throwsCode(
    () => assertSandboxProfileEnabled("container", forgedActivation),
    "ENV_ISOLATION_LOCK_UNAUTHENTIC",
    "a forged activation at assertSandboxProfileEnabled",
  );
  throwsCode(
    () => sandboxControlReport("container", forgedActivation),
    "ENV_ISOLATION_LOCK_UNAUTHENTIC",
    "a forged activation at sandboxControlReport",
  );
});
