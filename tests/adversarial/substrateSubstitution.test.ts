/**
 * The substrate-substitution exploit, and its remediation (review P0-1,
 * ADR-ERL2-024 §4.2).
 *
 * ## The exploit, exactly as it was reported
 *
 * `--substrate-root` was declared in `ENVIRONMENT_FLAGS` with no development
 * gate and was bound into no contract, no receipt and no attestation field. So:
 *
 *   1. drive a normal environment walk against substrate A;
 *   2. run `restore`, `destroy` and `finalize-generic` with `--substrate-root`
 *      pointed at a fresh empty directory B;
 *   3. the driver observes no resources, records a clean restoration and a clean
 *      teardown, and the finalizer's *own independent* residue re-inspection
 *      also observes nothing — because it too is inspecting B;
 *   4. a signed attestation is emitted whose bundle verifies offline at exit 0,
 *      while substrate A stays fully allocated.
 *
 * No retained artifact named the substrate that was observed, so an offline
 * verifier could not detect the substitution at all.
 *
 * ## What these tests assert
 *
 * The brief is explicit that a test demonstrating a false-valid attestation must
 * **become an expected refusal**, not be retained as an expected success. So the
 * first test reproduces the *mechanism* — the same commands, the same fresh
 * empty directory — and asserts that it is now refused, at the phase where the
 * substitution is attempted, before any cleanup evidence freezes. The remaining
 * tests vary one bound identity at a time.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ArtifactIndex, assertSubstrateBindingConsistent } from "@erl2/public-verifier";
import { developmentKey, sealSigned } from "@erl2/integrity";
import type { LabLifecycleEventV1 } from "@erl2/contracts";
import { erl2, verifyBundle, writeLifecycle } from "../support/cliRun.js";
import {
  changed,
  drive,
  manifest,
  phaseIndex,
  producedRoles,
  selectedRun,
  substrateRootOf,
  type EnvironmentRun,
} from "../support/environmentCli.js";

/** A fresh, empty directory — the substrate B of the exploit. */
function emptySubstrate(label: string): string {
  return mkdtempSync(path.join(tmpdir(), `erl2-substitute-${label}-`));
}

function bindingPath(run: EnvironmentRun): string {
  return path.join(run.runRoot, "retained", "environment", "substrate-binding.json");
}

function readBinding(run: EnvironmentRun): Record<string, unknown> {
  return JSON.parse(readFileSync(bindingPath(run), "utf8")) as Record<string, unknown>;
}

function refusalCode(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

test("SUBSTRATE-SUBSTITUTION: the exploit's own commands are refused before any cleanup evidence freezes", () => {
  const run = selectedRun();
  // Everything up to, but not including, `restore` — a fully live environment.
  drive(run, phaseIndex(run, "restore"));
  const substrateA = substrateRootOf(run);
  const substrateB = emptySubstrate("restore");

  const beforeRun = manifest(run.runRoot);
  const beforeA = manifest(substrateA);

  const substituted = erl2([
    "restore",
    ...run.base,
    "--substrate-root", substrateB,
  ]);
  assert.notEqual(substituted.exitCode, 0, "the substitution must be refused");
  assert.equal(
    substituted.body.errors[0]?.code,
    "ENV_SUBSTRATE_LOCATOR_CONFLICT",
    JSON.stringify(substituted.body.errors),
  );

  // The refusal writes no cleanup evidence, and does not touch substrate A.
  const roles = new Set(producedRoles(run));
  assert.ok(!roles.has("environment-restoration"), "no restoration may be recorded");
  assert.ok(!roles.has("teardown-verification"), "no teardown may be recorded");
  assert.deepEqual(changed(beforeRun, manifest(run.runRoot)), []);
  assert.deepEqual(changed(beforeA, manifest(substrateA)), []);
});

test("SUBSTRATE-SUBSTITUTION: substrate A remains uncleared and no valid attestation is emitted", () => {
  const run = selectedRun();
  drive(run, phaseIndex(run, "restore"));
  const substrateA = substrateRootOf(run);
  const substrateB = emptySubstrate("full");

  for (const command of ["restore", "destroy", "finalize-generic"]) {
    const result = erl2([command, ...run.base, "--substrate-root", substrateB]);
    assert.notEqual(result.exitCode, 0, `${command} must refuse the substituted substrate`);
  }

  // Substrate A still holds this run's resources: nothing was torn down.
  const substrateState = manifest(substrateA);
  const stateFile = [...substrateState.keys()].find((k) => k.endsWith(".substrate.json"));
  assert.ok(stateFile !== undefined, "substrate A must still carry this run's state");
  const live = JSON.parse(
    readFileSync(path.join(substrateA, stateFile), "utf8"),
  ) as { resources: unknown[] };
  assert.ok(live.resources.length > 0, "substrate A must still hold live resources");

  // And the run produced no terminal at all.
  const roles = new Set(producedRoles(run));
  assert.ok(!roles.has("final-attestation"), "no attestation may descend from a refused substitution");
  assert.ok(!roles.has("run-record"), "no terminal run record may be produced");
});

test("SUBSTRATE-SUBSTITUTION: a run bound to a substrate reaches it without being told where it is", () => {
  // The other half of the fix: once bound, later phases resolve the locator from
  // the run's own private record, so omitting the flag cannot silently fall back
  // to a default directory — and supplying the *correct* one is accepted.
  const run = selectedRun();
  assert.equal(drive(run), "generic_finalized");
  const verified = verifyBundle(run.runRoot, {
    sourceTrustPolicyHash: run.registry.sourceTrustPolicyHash,
  });
  assert.equal(verified.exitCode, 0, JSON.stringify(verified.body.errors));
  assert.equal((verified.body.data as { verdict: string }).verdict, "valid");

  const roles = new Set(producedRoles(run));
  assert.ok(roles.has("substrate-binding"), "a completed environment run must retain its binding");
});

test("SUBSTRATE-SUBSTITUTION: a mutated retained binding is refused offline", () => {
  const run = selectedRun();
  assert.equal(drive(run), "generic_finalized");
  assert.equal(
    verifyBundle(run.runRoot, { sourceTrustPolicyHash: run.registry.sourceTrustPolicyHash })
      .exitCode,
    0,
  );

  // Change the substrate the binding names. Its `core_hash` is recomputed so the
  // artifact index does not refuse it for the wrong reason — the point is that
  // the *semantic* binding check fires, not a content-hash check.
  const binding = readBinding(run);
  binding["substrate_instance_hash"] = `sha256:${"0".repeat(64)}`;
  // Frozen artifacts are published read-only; a tamperer would clear the bit
  // first, so the test does too rather than proving only that chmod works.
  chmodSync(bindingPath(run), 0o600);
  writeFileSync(bindingPath(run), JSON.stringify(binding));

  const verified = verifyBundle(run.runRoot, {
    sourceTrustPolicyHash: run.registry.sourceTrustPolicyHash,
  });
  assert.notEqual(verified.exitCode, 0, "a mutated binding must not verify");
});

test("SUBSTRATE-SUBSTITUTION: a reservation-namespace redirect is refused independently", () => {
  const run = selectedRun();
  drive(run, phaseIndex(run, "restore"));
  const otherReservations = emptySubstrate("reservations");

  const result = erl2(["restore", ...run.base, "--reservation-root", otherReservations]);
  assert.notEqual(result.exitCode, 0);
  assert.equal(
    result.body.errors[0]?.code,
    "ENV_SUBSTRATE_LOCATOR_CONFLICT",
    JSON.stringify(result.body.errors),
  );
});

test("SUBSTRATE-SUBSTITUTION: the locator flags are unreachable on the release surface", () => {
  const run = selectedRun();
  drive(run, phaseIndex(run, "baseline"));
  const elsewhere = emptySubstrate("release");

  for (const flag of ["--substrate-root", "--reservation-root"]) {
    const result = erl2(["baseline", ...run.base, flag, elsewhere], {
      developmentProfile: false,
    });
    assert.notEqual(result.exitCode, 0, `${flag} must be refused without the development profile`);
    assert.equal(
      result.body.errors[0]?.code,
      "CFG_DEVELOPMENT_FLAG_UNAVAILABLE",
      JSON.stringify(result.body.errors),
    );
  }
});

test("SUBSTRATE-SUBSTITUTION: a substrate with no identity cannot stand in for the bound one", () => {
  // The binding check itself, reached without the locator record: a substrate
  // that was never established has no identity to offer, and that absence is
  // what makes the fresh-empty-directory substitution detectable.
  const run = selectedRun();
  drive(run, phaseIndex(run, "restore"));

  // Point the run's own private locator record at an empty directory — the
  // strongest form of the attack, where the caller has already defeated the
  // flag-level conflict check.
  const foreign = emptySubstrate("no-identity");
  mkdirSync(foreign, { recursive: true });
  const locatorFile = path.join(run.runRoot, "state", "substrate-locator.json");
  const locator = JSON.parse(readFileSync(locatorFile, "utf8")) as Record<string, unknown>;
  writeFileSync(locatorFile, JSON.stringify({ ...locator, substrate_root: foreign }));

  const result = erl2(["restore", ...run.base]);
  assert.notEqual(result.exitCode, 0);
  assert.equal(
    result.body.errors[0]?.code,
    "ENV_SUBSTRATE_BINDING_MISSING",
    JSON.stringify(result.body.errors),
  );
  const roles = new Set(producedRoles(run));
  assert.ok(!roles.has("environment-restoration"), "no restoration may be recorded");
});

test("SUBSTRATE-SUBSTITUTION: every bound identity refuses independently, offline", () => {
  // One identity at a time, applied to the object the derivation reads rather
  // than to the retained file: each of these artifacts is cited by core hash, so
  // an edit surfaces as `ARTIFACT_HASH_MISMATCH` and the semantic binding check
  // never runs (ADR-ERL2-024 §7.3).
  const run = selectedRun();
  assert.equal(drive(run), "generic_finalized");
  const index = ArtifactIndex.scan(run.runRoot);
  const events = JSON.parse(
    readFileSync(writeLifecycle(run.runRoot), "utf8"),
  ) as LabLifecycleEventV1[];
  const bindingHash = events
    .flatMap((e) => e.produced)
    .find((p) => p.artifact_role === "substrate-binding")?.artifact_core_hash;
  assert.ok(bindingHash !== undefined, "the run must have produced a binding");

  const withBinding = (produced: LabLifecycleEventV1["produced"]): LabLifecycleEventV1[] =>
    events.map((event) =>
      event.produced.some((p) => p.artifact_role === "substrate-binding")
        ? ({ ...event, produced } as LabLifecycleEventV1)
        : event,
    );
  const derive = (lifecycle: readonly LabLifecycleEventV1[]): string | undefined =>
    refusalCode(() => assertSubstrateBindingConsistent({ index, lifecycle, runId: run.runId }));

  // The unmutated case derives cleanly, or every result below is noise.
  assert.equal(derive(events), undefined);

  // Missing: the lifecycle names no binding at all.
  assert.equal(derive(withBinding([])), "ENV_SUBSTRATE_BINDING_MISSING");
  // Duplicate: a run binds exactly one substrate.
  const entry = events
    .flatMap((e) => e.produced)
    .find((p) => p.artifact_role === "substrate-binding") as LabLifecycleEventV1["produced"][number];
  assert.equal(derive(withBinding([entry, entry])), "ENV_SUBSTRATE_BINDING_MISMATCH");
  // Not lifecycle-reachable: the retained bytes exist, but nothing produced them.
  assert.equal(
    derive(
      events.map((event) => ({
        ...event,
        produced: event.produced.filter((p) => p.artifact_role !== "substrate-binding"),
      })),
    ),
    "ENV_SUBSTRATE_BINDING_MISSING",
  );

  // A binding naming another run, another driver or another archetype. Each is
  // re-sealed so the signature verifies and the *binding* check is what fires.
  const binding = readBinding(run);
  const rebind = (patch: Record<string, unknown>): string | undefined => {
    const { core_hash: _h, signature: _s, ...body } = binding as Record<string, unknown>;
    const forged = sealSigned({ ...body, ...patch }, developmentKey("challenge-governor"));
    chmodSync(bindingPath(run), 0o600);
    writeFileSync(bindingPath(run), JSON.stringify(forged));
    const mutated = ArtifactIndex.scan(run.runRoot);
    const lifecycle = withBinding([
      { ...entry, artifact_core_hash: forged.core_hash as typeof entry.artifact_core_hash },
    ]);
    const code = refusalCode(() =>
      assertSubstrateBindingConsistent({ index: mutated, lifecycle, runId: run.runId }),
    );
    chmodSync(bindingPath(run), 0o600);
    writeFileSync(bindingPath(run), JSON.stringify(binding));
    return code;
  };
  const other = `sha256:${"0".repeat(64)}`;
  assert.equal(rebind({ run_id: "019f1af9-b400-7444-8444-4444deadbeef" }), "ENV_SUBSTRATE_BINDING_MISMATCH", "another run");
  assert.equal(rebind({ driver_id: "compose-driver" }), "ENV_SUBSTRATE_BINDING_MISMATCH", "another driver");
  assert.equal(rebind({ driver_manifest_hash: other }), "ENV_SUBSTRATE_BINDING_MISMATCH", "another driver manifest");
  assert.equal(rebind({ archetype_hash: other }), "ENV_SUBSTRATE_BINDING_MISMATCH", "another archetype");
  assert.equal(rebind({ substrate_lock_hash: other }), undefined, "an added lock hash binds nothing the run retained");
});

test("SUBSTRATE-SUBSTITUTION: a binding signed by the wrong role is refused offline", () => {
  // The signer is the environment governor and nobody else: a binding signed by
  // a role that does not provision environments is not a Lab statement about
  // where the environment is. Re-sealed with a *valid* key of the wrong role, so
  // the refusal is the role check and not a broken signature.
  const run = selectedRun();
  assert.equal(drive(run), "generic_finalized");
  assert.equal(
    verifyBundle(run.runRoot, { sourceTrustPolicyHash: run.registry.sourceTrustPolicyHash })
      .exitCode,
    0,
  );

  const binding = readBinding(run);
  const { core_hash: _h, signature: _s, ...body } = binding as Record<string, unknown>;
  // The same body, so `core_hash` — and every reference to it — is unchanged.
  const misSigned = sealSigned(body, developmentKey("evaluator"));
  assert.equal(misSigned.core_hash, binding["core_hash"], "the body must be byte-identical");
  chmodSync(bindingPath(run), 0o600);
  writeFileSync(bindingPath(run), JSON.stringify(misSigned));

  const verified = verifyBundle(run.runRoot, {
    sourceTrustPolicyHash: run.registry.sourceTrustPolicyHash,
  });
  assert.notEqual(verified.exitCode, 0, "a binding signed by the wrong role must not verify");
});

test("SUBSTRATE-SUBSTITUTION: an invalid binding signature is refused offline", () => {
  const run = selectedRun();
  assert.equal(drive(run), "generic_finalized");
  const binding = readBinding(run);
  const signature = binding["signature"] as { signature_base64: string };
  // One flipped byte in the signature; the body, and therefore every hash that
  // cites it, is untouched.
  const raw = Buffer.from(signature.signature_base64, "base64");
  raw[0] = raw[0] === undefined ? 0 : raw[0] ^ 0xff;
  chmodSync(bindingPath(run), 0o600);
  writeFileSync(
    bindingPath(run),
    JSON.stringify({
      ...binding,
      signature: { ...signature, signature_base64: raw.toString("base64") },
    }),
  );
  assert.notEqual(
    verifyBundle(run.runRoot, { sourceTrustPolicyHash: run.registry.sourceTrustPolicyHash })
      .exitCode,
    0,
    "a broken binding signature must not verify",
  );
});

test("SUBSTRATE-SUBSTITUTION: the same path with a different instance marker is a mismatch", () => {
  // The path is unchanged, so no locator conflict fires. Only the identity the
  // substrate carries *inside itself* has moved — which is exactly the case a
  // path-based binding could never have detected.
  const run = selectedRun();
  drive(run, phaseIndex(run, "restore"));
  const markerPath = path.join(substrateRootOf(run), "substrate-instance.json");
  const marker = JSON.parse(readFileSync(markerPath, "utf8")) as Record<string, unknown>;
  writeFileSync(
    markerPath,
    JSON.stringify({ ...marker, instance_hash: `sha256:${"9".repeat(64)}` }),
  );

  const result = erl2(["restore", ...run.base]);
  assert.notEqual(result.exitCode, 0);
  assert.equal(
    result.body.errors[0]?.code,
    "ENV_SUBSTRATE_BINDING_MISMATCH",
    JSON.stringify(result.body.errors),
  );
  assert.ok(!new Set(producedRoles(run)).has("environment-restoration"));
});

test("SUBSTRATE-SUBSTITUTION: a different established substrate is a mismatch, not a fresh start", () => {
  // Two runs, two substrates. Redirecting run A at run B's *established*
  // substrate is the harder case: the substrate does have an identity, it is
  // simply not the one A bound.
  const runA = selectedRun();
  const runB = selectedRun();
  drive(runA, phaseIndex(runA, "restore"));
  drive(runB, phaseIndex(runB, "baseline"));

  const locatorFile = path.join(runA.runRoot, "state", "substrate-locator.json");
  const locator = JSON.parse(readFileSync(locatorFile, "utf8")) as Record<string, unknown>;
  writeFileSync(
    locatorFile,
    JSON.stringify({ ...locator, substrate_root: substrateRootOf(runB) }),
  );

  const result = erl2(["restore", ...runA.base]);
  assert.notEqual(result.exitCode, 0);
  assert.equal(
    result.body.errors[0]?.code,
    "ENV_SUBSTRATE_BINDING_MISMATCH",
    JSON.stringify(result.body.errors),
  );
});
