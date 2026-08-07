/**
 * The stronger-isolation qualification track (Slice 6 parallel safety track).
 *
 * These tests exist to make one thing impossible: qualifying a profile from
 * anything other than observed enforcement. A manifest that says "enabled", a
 * mocked probe harness, and a missing probe must all leave the profile in its
 * fail-closed state, and an opaque subject must be refused under it.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  CONTAINER_PROFILE_STATE,
  NOT_QUALIFIED_STATE,
  REQUIRED_ISOLATION_CONTROLS,
  assertSandboxProfileEnabled,
  assertSubjectMayRunUnderProfile,
  fakeEnforcementProbes,
  qualifyIsolationProfile,
  unsupportedControls,
  type IsolationProbeResult,
} from "@erl2/core";
import type { Hash } from "@erl2/contracts";

const DIGEST = `sha256:${"7".repeat(64)}` as Hash;
const PINNED = { substrate_id: "candidate-container-runtime", image_digest: DIGEST, pinned: true };

function observedProbes(): IsolationProbeResult[] {
  return REQUIRED_ISOLATION_CONTROLS.map((control_id) => ({
    control_id,
    enforced: true,
    evidence: "observed" as const,
    method: "probe observed the control holding inside the runtime",
  }));
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

test("ISOLATION: the container profile is disabled and cannot be silently downgraded", () => {
  // Two independent gates, deliberately not collapsed into one state:
  // `NOT_QUALIFIED_STATE` answers "does a substrate enforce the twenty
  // controls?", while `CONTAINER_PROFILE_STATE` answers "may the Lab launch an
  // adapter inside one *here*?". A qualified substrate does not make the
  // profile usable.
  //
  // The state string moved with ADR-ERL2-034, for the reason the original
  // comment gave: a launcher now exists, so a state asserting one does not
  // would be a refusal citing a false reason — the first step toward the
  // profile quietly enabling itself. What is still true, and is what this
  // string now says, is that nothing has been *derived for this host*.
  assert.equal(
    CONTAINER_PROFILE_STATE,
    "disabled_until_container_substrate_qualification_derived_on_this_host",
  );
  assert.notEqual(CONTAINER_PROFILE_STATE, NOT_QUALIFIED_STATE);
  throwsCode(
    () => assertSandboxProfileEnabled("container"),
    "ADAPTER_SANDBOX_CONTROL_UNSUPPORTED",
  );
  // The enabled profile reports what it cannot do rather than claiming it.
  const unsupported = unsupportedControls("local-process");
  for (const kernelControl of [
    "read-only-root-filesystem",
    "numeric-non-root-user",
    "capability-drop-all",
    "no-new-privileges",
    "seccomp-default-profile",
    "pid-limit",
    "memory-limit",
    "cpu-limit",
    "network-namespace-isolation",
    "deny-by-default-egress",
    "read-only-input-mounts",
    "no-ambient-home-directory",
  ] as const) {
    assert.ok(
      unsupported.includes(kernelControl),
      `${kernelControl} must be reported unsupported, not claimed`,
    );
  }
});

test("ISOLATION: a mocked probe harness proves nothing and cannot qualify a profile", () => {
  const verdict = qualifyIsolationProfile({
    profile: "container",
    substrate: PINNED,
    probes: fakeEnforcementProbes(),
  });
  assert.equal(verdict.outcome, "not_qualified");
  assert.equal(verdict.outcome === "not_qualified" && verdict.state, NOT_QUALIFIED_STATE);
  assert.equal(
    verdict.outcome === "not_qualified" && verdict.missingControls.length,
    REQUIRED_ISOLATION_CONTROLS.length,
    "every mocked control is missing, because a mock is not evidence",
  );
  assert.ok(
    verdict.outcome === "not_qualified" &&
      verdict.reasons.every((r) => r.includes("PROBE_NOT_OBSERVED")),
  );
});

test("ISOLATION: a declared-but-unobserved control cannot qualify a profile", () => {
  const probes = observedProbes();
  probes[0] = { ...(probes[0] as IsolationProbeResult), evidence: "declared" };
  const verdict = qualifyIsolationProfile({ profile: "container", substrate: PINNED, probes });
  assert.equal(verdict.outcome, "not_qualified");
  assert.ok(
    verdict.outcome === "not_qualified" &&
      verdict.reasons.some((r) => r.startsWith("PROBE_NOT_OBSERVED:read-only-root-filesystem")),
    "a manifest's own assertion is not enforcement",
  );
});

test("ISOLATION: an unpinned substrate lock cannot qualify a profile", () => {
  const verdict = qualifyIsolationProfile({
    profile: "container",
    substrate: { substrate_id: "candidate-container-runtime", image_digest: undefined, pinned: false },
    probes: observedProbes(),
  });
  assert.equal(verdict.outcome, "not_qualified");
  assert.ok(
    verdict.outcome === "not_qualified" && verdict.reasons.includes("SUBSTRATE_LOCK_NOT_PINNED"),
  );
});

test("ISOLATION: a missing or failing probe cannot qualify a profile", () => {
  const missing = qualifyIsolationProfile({
    profile: "container",
    substrate: PINNED,
    probes: observedProbes().slice(1),
  });
  assert.equal(missing.outcome, "not_qualified");
  assert.ok(
    missing.outcome === "not_qualified" &&
      missing.reasons.some((r) => r.startsWith("PROBE_ABSENT:")),
  );

  const failing = observedProbes();
  failing[3] = {
    ...(failing[3] as IsolationProbeResult),
    enforced: false,
    reason_code: "SYSCALL_ESCAPED_SECCOMP",
  };
  const verdict = qualifyIsolationProfile({ profile: "container", substrate: PINNED, probes: failing });
  assert.equal(verdict.outcome, "not_qualified");
  assert.ok(
    verdict.outcome === "not_qualified" &&
      verdict.reasons.some((r) => r.startsWith("CONTROL_NOT_ENFORCED:")),
  );
});

test("ISOLATION: only fully observed enforcement over a pinned substrate qualifies", () => {
  const verdict = qualifyIsolationProfile({
    profile: "container",
    substrate: PINNED,
    probes: observedProbes(),
  });
  assert.equal(verdict.outcome, "qualified");
  assert.equal(verdict.outcome === "qualified" && verdict.profile, "container");
});

test("ISOLATION: an opaque or third-party subject is refused under an unqualified profile", () => {
  const unqualified = qualifyIsolationProfile({
    profile: "container",
    substrate: PINNED,
    probes: fakeEnforcementProbes(),
  });

  // Trusted reference fixtures may use the local-process profile: their source
  // is in this repository and the threat model there is a bug, not an adversary.
  assertSubjectMayRunUnderProfile({
    subjectTrust: "trusted_reference",
    profile: "local-process",
    verdict: unqualified,
  });

  for (const subjectTrust of ["opaque_private", "third_party"] as const) {
    throwsCode(
      () =>
        assertSubjectMayRunUnderProfile({
          subjectTrust,
          profile: "local-process",
          verdict: unqualified,
        }),
      "ADAPTER_SANDBOX_CONTROL_UNSUPPORTED",
      subjectTrust,
    );
    throwsCode(
      () =>
        assertSubjectMayRunUnderProfile({
          subjectTrust,
          profile: "container",
          verdict: unqualified,
        }),
      "ADAPTER_SANDBOX_CONTROL_UNSUPPORTED",
      `${subjectTrust} under container`,
    );
  }

  // Once qualified, the opaque subject is admitted under that profile only.
  const qualified = qualifyIsolationProfile({
    profile: "container",
    substrate: PINNED,
    probes: observedProbes(),
  });
  assertSubjectMayRunUnderProfile({
    subjectTrust: "opaque_private",
    profile: "container",
    verdict: qualified,
  });
  throwsCode(
    () =>
      assertSubjectMayRunUnderProfile({
        subjectTrust: "opaque_private",
        profile: "local-process",
        verdict: qualified,
      }),
    "ADAPTER_SANDBOX_CONTROL_UNSUPPORTED",
    "a qualified container profile does not enable the process profile",
  );
});

test("ISOLATION: an unqualified host stays fail-closed, and a qualified substrate still does not enable the profile", () => {
  // A host with no pinned substrate: the original fail-closed state.
  const verdict = qualifyIsolationProfile({
    profile: "container",
    substrate: { substrate_id: "none-qualified", image_digest: undefined, pinned: false },
    probes: [],
  });
  assert.equal(verdict.outcome, "not_qualified");
  assert.equal(verdict.outcome === "not_qualified" && verdict.state, NOT_QUALIFIED_STATE);

  // And the property that survives qualification: even a fully qualified
  // substrate leaves the sandbox profile unusable, because qualification says
  // the substrate would contain an adapter, not that the Lab can start one
  // inside it. Until a container-backed launcher exists, requesting the
  // profile is a refusal rather than a downgrade.
  const qualified = qualifyIsolationProfile({
    profile: "container",
    substrate: PINNED,
    probes: observedProbes(),
  });
  assert.equal(qualified.outcome, "qualified");
  throwsCode(
    () => assertSandboxProfileEnabled("container"),
    "ADAPTER_SANDBOX_CONTROL_UNSUPPORTED",
    "a qualified substrate is not a usable sandbox profile",
  );
});
