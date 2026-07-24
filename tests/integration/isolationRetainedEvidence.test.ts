/**
 * Retained isolation qualification evidence (ERL2-OQ-008, ADR-ERL2-016).
 *
 * `npm test` must stay hermetic and fast, so it does not run containers. What
 * it does instead is check the evidence a real `npm run qualify:isolation`
 * left behind — and check it the way a sceptic would:
 *
 *   - the verdict is **re-derived** here, never read from the stored report;
 *   - every one of the twenty controls must be `observed` and enforced;
 *   - every probe must be bound to *this* lock's hash;
 *   - the lock must be digest-pinned and must pin the suite that is compiled
 *     into this build.
 *
 * When no evidence is retained the track is honestly unresolved, and the test
 * asserts the fail-closed state rather than passing vacuously: `erl2 doctor`
 * must report `disabled_no_qualified_adapter_substrate` and every opaque
 * subject must still be refused.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  NOT_QUALIFIED_STATE,
  PROBE_SUITE_ID,
  REQUIRED_ISOLATION_CONTROLS,
  assertSubjectMayRunUnderProfile,
  assertSuiteCoversEveryControl,
  buildIsolationProbeSigningManifest,
  buildIsolationQualificationReport,
  deriveIsolationAuthenticity,
  probeSuiteDigest,
  qualifyIsolationProfile,
  verifyIsolationLockSignature,
  verifyIsolationProbeManifest,
} from "@erl2/core";
import {
  assertContract,
  parseStrictJson,
  type IsolationEnforcementProbeResultV1,
  type IsolationProbeSigningManifestV1,
  type IsolationQualificationReportV1,
  type IsolationSubstrateLockV1,
} from "@erl2/contracts";
import { coreHash, developmentKey } from "@erl2/integrity";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const evidenceDir = path.join(repoRoot, "environments", "isolation");
const lockPath = path.join(evidenceDir, "substrate-lock.json");
const probesDir = path.join(evidenceDir, "probes");

const hasEvidence = existsSync(lockPath) && existsSync(probesDir);

function readLock(): IsolationSubstrateLockV1 {
  return assertContract<IsolationSubstrateLockV1>(
    "IsolationSubstrateLockV1",
    parseStrictJson(readFileSync(lockPath, "utf8")),
  );
}

function readProbes(): IsolationEnforcementProbeResultV1[] {
  return readdirSync(probesDir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) =>
      assertContract<IsolationEnforcementProbeResultV1>(
        "IsolationEnforcementProbeResultV1",
        parseStrictJson(readFileSync(path.join(probesDir, f), "utf8")),
      ),
    );
}

test("ISOLATION-EVIDENCE: retained evidence, if any, re-derives to a qualified verdict", (t) => {
  if (!hasEvidence) {
    t.diagnostic(
      `no isolation evidence at ${path.relative(repoRoot, evidenceDir)}; ERL2-OQ-008 is unresolved on this checkout`,
    );
    // The fail-closed state is the assertion in this branch.
    const verdict = qualifyIsolationProfile({
      profile: "container",
      substrate: { substrate_id: "none", image_digest: undefined, pinned: false },
      probes: [],
    });
    assert.equal(verdict.outcome, "not_qualified");
    assert.equal(verdict.outcome === "not_qualified" && verdict.state, NOT_QUALIFIED_STATE);
    for (const subjectTrust of ["opaque_private", "third_party"] as const) {
      assert.throws(() =>
        assertSubjectMayRunUnderProfile({ subjectTrust, profile: "container", verdict }),
      );
    }
    return;
  }

  const lock = readLock();
  const probes = readProbes();

  // 1. the suite is complete and every control was observed enforcing.
  assertSuiteCoversEveryControl(probes);
  assert.equal(probes.length, REQUIRED_ISOLATION_CONTROLS.length);
  for (const probe of probes) {
    assert.equal(probe.evidence, "observed", `${probe.control_id} must be observed, not asserted`);
    assert.equal(probe.enforced, true, `${probe.control_id} must have been seen holding`);
    assert.equal(
      probe.resources_cleaned_up,
      true,
      `${probe.control_id} must clean up after itself`,
    );
    assert.ok(
      probe.observation.observed.length > 0,
      `${probe.control_id} must record what it actually saw`,
    );
  }

  // 2. every probe is bound to this lock; foreign evidence proves nothing here.
  const lockHash = coreHash(lock);
  for (const probe of probes) {
    assert.equal(
      probe.substrate_lock_hash,
      lockHash,
      `${probe.control_id} was frozen against a different substrate`,
    );
  }

  // 3. the lock is a real pin, and pins the suite this build compiles.
  assert.equal(lock.pinned, true);
  assert.match(lock.image_reference, /@sha256:[0-9a-f]{64}$/);
  assert.equal(lock.image_digest, lock.image_reference.split("@")[1]);
  assert.equal(lock.probe_suite_id, PROBE_SUITE_ID);
  assert.equal(
    lock.probe_suite_digest,
    probeSuiteDigest(),
    "the retained lock pins a different probe suite than this build runs; re-qualify",
  );

  // 4. the verdict is re-derived, not read.
  const derived = buildIsolationQualificationReport({
    reportId: "erl2-retained-evidence-check",
    profile: "container",
    lock,
    probeResults: probes,
    evaluatedAt: "2026-01-01T00:00:00Z",
  });
  assert.equal(derived.verdict, "qualified", derived.reasons.join("; "));
  assert.deepEqual(derived.missing_controls, []);

  // 4b. AUTHENTICITY (P2-1): content-qualified is not enough. The lock signature
  //     must verify, and — crucially — the retained lock is signed by the
  //     *development* governor key, which is repo-derivable and therefore NOT a
  //     real qualification authority. So the honest outcome is
  //     `locally_observed_unauthenticated`, never `authenticated`.
  const signature = verifyIsolationLockSignature(lock);
  assert.equal(signature.signatureValid, true, "the retained lock signature must verify (not tampered)");
  assert.equal(signature.signerIsDevelopmentKey, true, "the retained lock is dev-signed, not authority-signed");
  assert.equal(signature.signerIsPinnedAuthority, false, "a development key is not a pinned authority");
  const authenticity = deriveIsolationAuthenticity({ contentQualified: true, signature });
  assert.equal(
    authenticity,
    "locally_observed_unauthenticated",
    "dev-signed observed evidence is self-reported, not authenticated (OQ-008 open)",
  );

  // 4c. A tampered signature is refused — the exact gap the review reproduced
  //     ("corrupting signature_base64 still yields qualified").
  const tampered = { ...lock, signature: { ...lock.signature, signature_base64: `A${lock.signature.signature_base64.slice(1)}` } };
  const tamperedSig = verifyIsolationLockSignature(tampered);
  assert.equal(tamperedSig.signatureValid, false, "a corrupted lock signature must not verify");
  assert.equal(
    deriveIsolationAuthenticity({ contentQualified: true, signature: tamperedSig }),
    "not_qualified",
    "a tampered lock is not_qualified, whatever the probes say",
  );

  // 4d. A hand-authored lock re-signed with a fabricated key the verifier does
  //     not hold cannot be authenticated (no pinned public key to verify it).
  const foreign = { ...lock, signature: { ...lock.signature, key_id: "attacker-forged-authority-1" } };
  const foreignSig = verifyIsolationLockSignature(foreign);
  assert.equal(foreignSig.signerIsPinnedAuthority, false);
  assert.equal(
    deriveIsolationAuthenticity({ contentQualified: true, signature: foreignSig }),
    "not_qualified",
    "an unpinned signer cannot authenticate a qualification",
  );

  // 5. and the stored report, if present, must agree with the derivation.
  const reportPath = path.join(evidenceDir, "qualification-report.json");
  if (existsSync(reportPath)) {
    const stored = assertContract<IsolationQualificationReportV1>(
      "IsolationQualificationReportV1",
      parseStrictJson(readFileSync(reportPath, "utf8")),
    );
    assert.equal(stored.verdict, derived.verdict);
    assert.equal(stored.substrate_lock_hash, lockHash);
    assert.deepEqual([...stored.observed_controls].sort(), [...derived.observed_controls].sort());
  }
});

test("ISOLATION-PROBE-AUTHENTICITY §10.1: the probe results are authenticated by a signed manifest", (t) => {
  if (!hasEvidence) {
    t.diagnostic("no retained evidence; probe-manifest authenticity is proven on scripted evidence below");
    return;
  }
  const lock = readLock();
  const probes = readProbes();
  const manifestPath = path.join(evidenceDir, "probe-signing-manifest.json");
  assert.ok(existsSync(manifestPath), "the retained evidence must carry a signed probe manifest (§10.1)");
  const manifest = assertContract<IsolationProbeSigningManifestV1>(
    "IsolationProbeSigningManifestV1",
    parseStrictJson(readFileSync(manifestPath, "utf8")),
  );

  // The honest chain: the manifest covers exactly the twenty probe results and
  // is signed by the *development* governor — so it is valid but self-reported.
  const verified = verifyIsolationProbeManifest(manifest, lock, probes);
  assert.equal(verified.status, "valid_development", "the retained manifest is dev-signed, not authority-signed");

  const sig = verifyIsolationLockSignature(lock);
  assert.equal(
    deriveIsolationAuthenticity({ contentQualified: true, signature: sig, probeManifest: verified }),
    "locally_observed_unauthenticated",
    "dev lock + dev probe manifest is self-reported, never authenticated",
  );

  // A tampered probe manifest signature is a broken chain → not_qualified.
  const tampered = {
    ...manifest,
    signature: { ...manifest.signature, signature_base64: `A${manifest.signature.signature_base64.slice(1)}` },
  } as IsolationProbeSigningManifestV1;
  assert.equal(verifyIsolationProbeManifest(tampered, lock, probes).status, "invalid");
  assert.equal(
    deriveIsolationAuthenticity({
      contentQualified: true,
      signature: sig,
      probeManifest: verifyIsolationProbeManifest(tampered, lock, probes),
    }),
    "not_qualified",
    "a tampered probe manifest breaks the authenticity chain",
  );

  // A manifest that does not cover all twenty evaluated results is refused.
  assert.equal(verifyIsolationProbeManifest(manifest, lock, probes.slice(1)).status, "invalid");

  // Even a hypothetical *pinned-authority* lock is NOT authenticated unless the
  // probe manifest is ALSO authority-signed — the exact §10.1 strengthening.
  const authorityKey = developmentKey("hypothetical-authority");
  const pinned = [{ keyId: authorityKey.keyId, publicKeyPem: authorityKey.publicKey.export({ type: "spki", format: "pem" }).toString() }];
  const lockSigByAuthority = verifyIsolationLockSignature(lock, pinned); // lock is dev-signed, so still not pinned here
  // Build an authority-signed manifest to show valid_authority is reachable and required.
  const authorityManifest = buildIsolationProbeSigningManifest({
    manifestId: "authority-manifest",
    lock,
    probeResults: probes,
    signedAt: lock.recorded_at,
    signingKey: authorityKey,
  });
  assert.equal(verifyIsolationProbeManifest(authorityManifest, lock, probes, pinned).status, "valid_authority");
  // With a dev-signed lock (not authority), authenticity is still not "authenticated".
  assert.equal(
    deriveIsolationAuthenticity({
      contentQualified: true,
      signature: lockSigByAuthority,
      probeManifest: verifyIsolationProbeManifest(authorityManifest, lock, probes, pinned),
    }),
    "locally_observed_unauthenticated",
  );
});

test("ISOLATION-EVIDENCE: a qualified profile admits an opaque subject under that profile only", (t) => {
  if (!hasEvidence) {
    t.diagnostic("no retained evidence; the admission property is proven on scripted evidence instead");
    return;
  }
  const lock = readLock();
  const verdict = qualifyIsolationProfile({
    profile: "container",
    substrate: {
      substrate_id: lock.runtime_id,
      image_digest: lock.image_digest,
      pinned: lock.pinned,
    },
    probes: readProbes().map((p) => ({
      control_id: p.control_id,
      enforced: p.enforced,
      evidence: p.evidence,
      method: p.method,
    })),
  });
  assert.equal(verdict.outcome, "qualified");

  assertSubjectMayRunUnderProfile({
    subjectTrust: "opaque_private",
    profile: "container",
    verdict,
  });
  // Qualifying the container profile does not retroactively make the
  // same-user process profile safe for an opaque subject.
  assert.throws(() =>
    assertSubjectMayRunUnderProfile({
      subjectTrust: "opaque_private",
      profile: "local-process",
      verdict,
    }),
  );
  assert.throws(() =>
    assertSubjectMayRunUnderProfile({
      subjectTrust: "third_party",
      profile: "local-process",
      verdict,
    }),
  );
});
