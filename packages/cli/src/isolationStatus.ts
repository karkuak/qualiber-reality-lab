/**
 * `erl2 doctor`'s subject-isolation section (ERL2-OQ-008 §5.4).
 *
 * Doctor must report the *exact* lock, the observed probe status, the
 * qualification verdict and the refusal reason.  It does that by re-deriving
 * the verdict from the retained lock and probe evidence — it never reads the
 * `verdict` field of a stored report, because a stored report is an artifact
 * anyone can write and doctor's job is to say what is actually true.
 *
 * When no evidence directory exists, the honest answer is the fail-closed state
 * with the reason `SUBSTRATE_LOCK_NOT_PINNED`, which is exactly what an
 * unqualified host should show.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  assertContract,
  parseStrictJson,
  type IsolationEnforcementProbeResultV1,
  type IsolationProbeSigningManifestV1,
  type IsolationSubstrateLockV1,
} from "./contractsFacade.js";
import {
  NOT_QUALIFIED_STATE,
  PROBE_SUITE_ID,
  REQUIRED_ISOLATION_CONTROLS,
  buildIsolationQualificationReport,
  deriveIsolationAuthenticity,
  probeSuiteDigest,
  verifyIsolationLockSignature,
  verifyIsolationProbeManifest,
  type PinnedQualificationAuthority,
} from "@erl2/core";
import { coreHash } from "@erl2/integrity";

/** Where a qualification run publishes its evidence, relative to the workspace. */
export const ISOLATION_EVIDENCE_DIR = path.join("environments", "isolation");

export interface IsolationStatus {
  readonly qualification: string;
  /**
   * The distinguished authenticity outcome (§10.2): `authenticated` (a pinned
   * authority signed), `locally_observed_unauthenticated` (valid signature, but
   * by a non-authoritative development key — self-reported), or `not_qualified`.
   */
  readonly authenticity: string;
  readonly substrate_lock_signature: { readonly valid: boolean; readonly signer: string; readonly reason: string } | "absent";
  /**
   * The signed probe-result manifest that authenticates the twenty probe results
   * (review §10.1/6R-E): its verification status and signer. `authenticated`
   * requires this to be `valid_authority`; a present-but-broken manifest is
   * `invalid` and forces `not_qualified`.
   */
  readonly probe_manifest: { readonly status: string; readonly signer: string; readonly reason: string };
  readonly launcher_available: false;
  readonly profile: "container";
  readonly required_controls: number;
  readonly observed_controls: number;
  readonly missing_controls: readonly string[];
  readonly refusal_reasons: readonly string[];
  readonly probe_suite_id: string;
  readonly probe_suite_digest: string;
  readonly substrate_lock: Record<string, string> | "absent";
  readonly probe_evidence_dir: string;
  readonly probe_status: readonly { readonly control: string; readonly evidence: string; readonly enforced: boolean }[];
}

/**
 * Re-derives the isolation status from retained evidence.
 *
 * `evidenceRoot` defaults to the workspace's `environments/isolation`. A
 * missing directory is not an error: it is the ordinary state of a host that
 * has never qualified a substrate, and it must read as `not_qualified`.
 */
export function isolationStatus(
  evidenceRoot: string,
  pinnedAuthorities: readonly PinnedQualificationAuthority[] = [],
): IsolationStatus {
  const lockPath = path.join(evidenceRoot, "substrate-lock.json");
  const probesDir = path.join(evidenceRoot, "probes");

  const lock = existsSync(lockPath)
    ? assertContract<IsolationSubstrateLockV1>(
        "IsolationSubstrateLockV1",
        parseStrictJson(readFileSync(lockPath, "utf8")),
      )
    : undefined;

  const probeResults: IsolationEnforcementProbeResultV1[] = existsSync(probesDir)
    ? readdirSync(probesDir)
        .filter((f) => f.endsWith(".json"))
        .sort()
        .map((f) =>
          assertContract<IsolationEnforcementProbeResultV1>(
            "IsolationEnforcementProbeResultV1",
            parseStrictJson(readFileSync(path.join(probesDir, f), "utf8")),
          ),
        )
    : [];

  const manifestPath = path.join(evidenceRoot, "probe-signing-manifest.json");
  const probeManifest = existsSync(manifestPath)
    ? assertContract<IsolationProbeSigningManifestV1>(
        "IsolationProbeSigningManifestV1",
        parseStrictJson(readFileSync(manifestPath, "utf8")),
      )
    : undefined;

  // The verdict is derived here, not read: a retained report cannot enable a
  // profile, and doctor must not repeat a claim it did not check.
  const report = buildIsolationQualificationReport({
    reportId: "erl2-doctor-derived",
    profile: "container",
    lock,
    probeResults,
    evaluatedAt: "2026-01-01T00:00:00Z",
  });

  // Authenticity chain (P2-1/§10.1/§10.2): even 20/20 observed controls are only
  // *self-reported* unless a pinned authority signed the lock AND a covering
  // probe-signing manifest.  Doctor reports the distinguished outcome, never a
  // bare "qualified" for producer-writable evidence.
  const signature = lock === undefined ? undefined : verifyIsolationLockSignature(lock, pinnedAuthorities);
  const probeManifestVerification =
    lock === undefined
      ? { status: "absent" as const, signerKeyId: "absent" }
      : verifyIsolationProbeManifest(probeManifest, lock, probeResults, pinnedAuthorities);
  const authenticity = deriveIsolationAuthenticity({
    contentQualified: report.verdict === "qualified",
    signature: signature ?? {
      signatureValid: false,
      signerKeyId: "absent",
      signerIsPinnedAuthority: false,
      signerIsDevelopmentKey: false,
    },
    probeManifest: probeManifestVerification,
  });
  // The container-backed launcher is out of scope while OQ-008 is open, so even
  // an authenticated substrate cannot execute an opaque subject.
  const qualification =
    authenticity === "authenticated"
      ? "authenticated_substrate_qualified_launcher_unavailable"
      : authenticity === "locally_observed_unauthenticated"
        ? "locally_observed_unauthenticated"
        : NOT_QUALIFIED_STATE;
  const authenticityReasons =
    authenticity !== "authenticated"
      ? [
          ...(signature?.reason !== undefined ? [signature.reason] : []),
          ...(probeManifestVerification.reason !== undefined
            ? [`probe_manifest:${probeManifestVerification.reason}`]
            : probeManifestVerification.status !== "valid_authority"
              ? [`probe_manifest:${probeManifestVerification.status}`]
              : []),
        ]
      : [];

  const byControl = new Map(probeResults.map((r) => [r.control_id, r]));
  return {
    qualification,
    authenticity,
    substrate_lock_signature:
      signature === undefined
        ? "absent"
        : { valid: signature.signatureValid, signer: signature.signerKeyId, reason: signature.reason ?? "-" },
    probe_manifest: {
      status: probeManifestVerification.status,
      signer: probeManifestVerification.signerKeyId,
      reason: probeManifestVerification.reason ?? "-",
    },
    launcher_available: false,
    profile: "container",
    required_controls: REQUIRED_ISOLATION_CONTROLS.length,
    observed_controls: report.observed_controls.length,
    missing_controls: report.missing_controls,
    refusal_reasons: [...authenticityReasons, ...report.reasons].slice(0, 24),
    probe_suite_id: PROBE_SUITE_ID,
    probe_suite_digest: probeSuiteDigest(),
    substrate_lock:
      lock === undefined
        ? "absent"
        : {
            lock_id: lock.lock_id,
            core_hash: coreHash(lock),
            runtime: `${lock.runtime_id}/${lock.runtime_version}`,
            platform: `${lock.platform}/${lock.architecture}`,
            kernel: lock.kernel_version,
            image_reference: lock.image_reference,
            image_digest: lock.image_digest,
            seccomp: lock.required_security_profile.seccomp,
            cgroup_version: lock.required_security_profile.cgroup_version,
            default_runtime: lock.required_security_profile.default_runtime,
            pinned_probe_suite: `${lock.probe_suite_id}@${lock.probe_suite_digest}`,
          },
    probe_evidence_dir: existsSync(probesDir) ? probesDir : "absent",
    probe_status: REQUIRED_ISOLATION_CONTROLS.map((control) => {
      const found = byControl.get(control);
      return {
        control,
        evidence: found?.evidence ?? "absent",
        enforced: found?.enforced ?? false,
      };
    }),
  };
}
