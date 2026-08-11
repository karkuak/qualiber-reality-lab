/**
 * External-adapter certification admission (LIVE-001, ADR-ERL2-036).
 *
 * `certifyAdapter` has always been able to *produce* a
 * `SubjectAdapterCertificationReceiptV1`. Nothing consumed one. An adapter
 * manifest could be placed in the governor registry and driven through the
 * whole journey, and the final validity report would still emit
 * `adapter-certified: passed: true` with the manifest hash as its only
 * evidence — a certified claim backed by no certification. This module is the
 * missing consumer.
 *
 * It keeps three facts apart, exactly as `isolationAuthenticity` does for the
 * substrate:
 *
 *   - **certification** — is the receipt contract-valid, core-hash-valid,
 *     bound to this exact manifest and these exact bytes, in scope, and
 *     `certified`?  This is content, and it is decided here.
 *   - **authentication** — did an authorized certifier's signature
 *     cryptographically verify?  A shape-valid signature is not an
 *     authenticated one, and a zero-filled placeholder is not a signature.
 *   - **admission policy** — may *this trust tier* run on *that* combination?
 *     Development may run on locally-observed, unauthenticated certification
 *     and must say so. A scored tier may not.
 *
 * Collapsing any two of those would reintroduce the defect in a new shape: an
 * unsigned but genuinely certified development adapter would become
 * indistinguishable from a forged one, or a signed forgery from a real
 * certification.
 *
 * ## The linkage direction, and the cycle that forbids the other one
 *
 * The authoritative binding is **receipt → manifest**:
 * `receipt.adapter_manifest_hash` is the manifest's `core_hash`, written by
 * `certifyAdapter` itself. That direction is settled, produced by the shipped
 * harness, and acyclic.
 *
 * The reverse direction cannot exist. A manifest's `core_hash` covers its
 * `certification_receipt_hash`, and the receipt's identity covers the manifest
 * `core_hash`; a manifest naming the receipt that certifies it is a hash cycle,
 * not a link. So `certification_receipt_hash` is necessarily a **prior or
 * bootstrap** reference — the all-zero sentinel when an adapter has never been
 * certified before — and admission classifies it, does not resolve it, and
 * never claims to have verified it. There is no refusal for the cycle because
 * a document exhibiting it cannot be built: satisfying both hashes at once
 * would mean finding a fixed point, and the recomputation above rejects any
 * forgery as a hash mismatch first.
 *
 * This is the one place the pack precedent (`bindDomainPack`, which *does*
 * require `manifest.certification_receipt_hash === receipt.core_hash`) does not
 * transfer: a pack receipt names the pack *body*, never the pack manifest, so
 * that triangle is acyclic and the adapter one is not.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  CODES,
  Erl2Error,
  assertContract,
  type Hash,
  type SubjectAdapterCertificationReceiptV1,
  type SubjectAdapterManifestV1,
  type Tier,
} from "@erl2/contracts";
import { coreHash, hashBytes, verifySignature, SIGNATURE_DOMAINS } from "@erl2/integrity";
import { createPublicKey } from "node:crypto";

/** The all-zero hash: "no prior receipt", the bootstrap sentinel. */
export const BOOTSTRAP_RECEIPT_SENTINEL = `sha256:${"0".repeat(64)}` as Hash;

/**
 * How a manifest's `certification_receipt_hash` relates to *prior*
 * certification. Never to the current receipt — see the module note.
 */
export type ReceiptLinkage = "bootstrap_no_prior_receipt" | "prior_receipt_not_resolved";

/**
 * Distinguished authenticity outcomes, named to match the substrate's
 * (`IsolationAuthenticity`) so a reader meets one vocabulary, not two.
 */
export type CertificationAuthenticity =
  | "not_certified"
  | "locally_observed_unauthenticated"
  | "authenticated";

/** A verifier-controlled, pinned certification authority (public key only). */
export interface PinnedCertificationAuthority {
  readonly keyId: string;
  readonly publicKeyPem: string;
}

export interface ReceiptSignatureVerification {
  readonly signaturePresent: boolean;
  readonly signatureValid: boolean;
  readonly signerKeyId: string;
  readonly signerIsPinnedAuthority: boolean;
  readonly reason?: string;
}

/**
 * Verifies a receipt's signature, if it carries one, and classifies the signer.
 *
 * An absent signature is reported as absent — not as invalid. That distinction
 * is the whole development allowance: unsigned evidence is honestly unsigned,
 * and it is the *policy* layer that decides whether unsigned is enough. A
 * present-but-unverifiable signature is a different and worse thing, and never
 * reaches `authenticated`.
 *
 * A zero-filled `signature_base64` is a development placeholder, and the
 * cryptographic verification below rejects it like any other set of bytes that
 * is not a signature. Nothing here treats "the field is shaped like a
 * signature" as evidence that it is one.
 */
export function verifyReceiptSignature(
  receipt: SubjectAdapterCertificationReceiptV1,
  pinnedAuthorities: readonly PinnedCertificationAuthority[] = [],
): ReceiptSignatureVerification {
  const signature = receipt.signature;
  if (signature === undefined || signature === null) {
    return {
      signaturePresent: false,
      signatureValid: false,
      signerKeyId: "absent",
      signerIsPinnedAuthority: false,
      reason: "CERTIFICATION_RECEIPT_UNSIGNED",
    };
  }
  const signerKeyId = signature.key_id;
  if (signature.signed_hash !== coreHash(receipt)) {
    return {
      signaturePresent: true,
      signatureValid: false,
      signerKeyId,
      signerIsPinnedAuthority: false,
      reason: "CERTIFICATION_RECEIPT_SIGNED_HASH_MISMATCH",
    };
  }
  const pinned = pinnedAuthorities.find((a) => a.keyId === signerKeyId);
  if (pinned === undefined) {
    return {
      signaturePresent: true,
      signatureValid: false,
      signerKeyId,
      signerIsPinnedAuthority: false,
      reason: "CERTIFICATION_RECEIPT_SIGNER_NOT_PINNED",
    };
  }
  let valid = false;
  try {
    valid = verifySignature(createPublicKey(pinned.publicKeyPem), SIGNATURE_DOMAINS.ERL2, signature);
  } catch {
    valid = false;
  }
  return {
    signaturePresent: true,
    signatureValid: valid,
    signerKeyId,
    signerIsPinnedAuthority: valid,
    ...(valid ? {} : { reason: "CERTIFICATION_RECEIPT_SIGNATURE_INVALID" }),
  };
}

/**
 * Combines the certification content verdict with the signature verification
 * into the single authenticity outcome the policy layer reads.
 *
 * Content that did not certify is `not_certified` whatever its signature says.
 * Only a pinned authority's verified signature reaches `authenticated`;
 * everything else that certified on content is
 * `locally_observed_unauthenticated` — self-reported, and labelled as such
 * wherever it is retained or reported.
 */
export function deriveCertificationAuthenticity(input: {
  readonly contentCertified: boolean;
  readonly signature: ReceiptSignatureVerification;
}): CertificationAuthenticity {
  if (!input.contentCertified) return "not_certified";
  if (input.signature.signaturePresent && !input.signature.signatureValid) return "not_certified";
  if (input.signature.signerIsPinnedAuthority) return "authenticated";
  return "locally_observed_unauthenticated";
}

/**
 * The tiers that may run on self-reported certification.
 *
 * `development` is the Lab's unscored tier. `held_out` and `blind` are the
 * scored ones, and they require an authenticated receipt — which is a stricter
 * rule than the one ERL2-OQ-007 currently enforces (it refuses those tiers
 * outright), and deliberately so: when OQ-007 lifts, this gate must already be
 * standing rather than have to be remembered.
 *
 * There is no flag that overrides this. Development acceptance derives from the
 * selected tier, never from an `--allow-unsigned` escape hatch.
 */
const UNSCORED_TIERS: ReadonlySet<Tier> = new Set<Tier>(["development"]);

/**
 * Applies the admission policy for a tier to an authenticity outcome.
 *
 * Fails closed: an unknown or scored tier requires `authenticated`.
 */
export function assertAdmissionPermittedForTier(
  tier: Tier,
  authenticity: CertificationAuthenticity,
  adapterId: string,
): void {
  if (authenticity === "authenticated") return;
  if (authenticity === "not_certified") {
    throw new Erl2Error(
      CODES.ADAPTER_NOT_CERTIFIED,
      `adapter ${adapterId} has no valid certification; it may not be admitted at any tier`,
      { owner: "adapter" },
    );
  }
  if (!UNSCORED_TIERS.has(tier)) {
    throw new Erl2Error(
      CODES.ADAPTER_CERTIFICATION_AUTHENTICATION_REQUIRED,
      `adapter ${adapterId} presents locally observed, unauthenticated certification; ` +
        `tier ${tier} is scored and requires a receipt signed by a pinned certification authority`,
      { owner: "lab" },
    );
  }
}

/** Everything admission decided, in the order it decided it. */
export interface AdapterAdmission {
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly manifestHash: Hash;
  readonly receiptHash: Hash;
  readonly adapterArtifactHash: Hash;
  readonly certifierId: string;
  readonly certifierIsAdapterOwner: false;
  readonly certifiedOperations: readonly string[];
  readonly certifiedPackageKinds: readonly string[];
  readonly authenticity: CertificationAuthenticity;
  readonly receiptLinkage: ReceiptLinkage;
  readonly tier: Tier;
}

export interface VerifyAdapterCertificationInput {
  readonly manifest: SubjectAdapterManifestV1;
  readonly receipt: SubjectAdapterCertificationReceiptV1;
  /**
   * The bytes actually on disk, when the caller has them.
   *
   * `admit-adapter` and the adapter host both do; preregistration binds the
   * certification before the host exists and so does not. Omitting it skips
   * only the disk comparison — never the manifest/receipt agreement — and the
   * host repeats the disk comparison at time of use regardless.
   */
  readonly entryDigest?: Hash;
  readonly tier: Tier;
  readonly pinnedAuthorities?: readonly PinnedCertificationAuthority[];
}

/**
 * The whole content check, then the authentication check, then the policy.
 *
 * Every refusal is typed and names the fact that failed, because "this adapter
 * was refused" is not an actionable message when there are ten reasons it
 * could have been.
 */
export function verifyAdapterCertification(
  input: VerifyAdapterCertificationInput,
): AdapterAdmission {
  const { manifest, receipt } = input;

  // 1. Both documents are what they claim to be, by their own bytes.
  assertContract<SubjectAdapterManifestV1>("SubjectAdapterManifestV1", manifest);
  assertContract<SubjectAdapterCertificationReceiptV1>(
    "SubjectAdapterCertificationReceiptV1",
    receipt,
  );
  const manifestHash = coreHash(manifest);
  if (manifestHash !== manifest.core_hash) {
    throw new Erl2Error(
      CODES.ARTIFACT_HASH_MISMATCH,
      "the adapter manifest declares a core_hash its bytes do not produce",
    );
  }
  const receiptHash = coreHash(receipt);
  if (receiptHash !== receipt.core_hash) {
    throw new Erl2Error(
      CODES.ARTIFACT_HASH_MISMATCH,
      "the certification receipt declares a core_hash its bytes do not produce",
    );
  }

  // 2. The receipt certifies *this* manifest. This is the authoritative link.
  if (receipt.adapter_manifest_hash !== manifestHash) {
    throw new Erl2Error(
      CODES.ADAPTER_CERTIFICATION_IDENTITY_MISMATCH,
      "the certification receipt describes a different adapter manifest",
      { owner: "adapter" },
    );
  }
  // The manifest's own receipt reference is prior/bootstrap only; see below.
  const receiptLinkage = classifyReceiptLinkage(manifest);

  // 3. Identity.
  if (receipt.adapter_id !== manifest.adapter_id) {
    throw new Erl2Error(
      CODES.ADAPTER_CERTIFICATION_IDENTITY_MISMATCH,
      `the receipt certifies adapter ${receipt.adapter_id}, not ${manifest.adapter_id}`,
      { owner: "adapter" },
    );
  }
  if (receipt.adapter_version !== manifest.version) {
    throw new Erl2Error(
      CODES.ADAPTER_CERTIFICATION_IDENTITY_MISMATCH,
      `the receipt certifies version ${receipt.adapter_version}, not ${manifest.version}`,
      { owner: "adapter" },
    );
  }

  // 4. The bytes. All three must agree: what the manifest declares, what the
  //    certifier measured, and what is on disk right now.
  if (receipt.adapter_artifact_hash !== manifest.adapter_artifact_hash) {
    throw new Erl2Error(
      CODES.ADAPTER_IDENTITY_MISMATCH,
      "the receipt certifies different adapter bytes than the manifest declares",
      { owner: "adapter" },
    );
  }
  if (input.entryDigest !== undefined && input.entryDigest !== manifest.adapter_artifact_hash) {
    throw new Erl2Error(
      CODES.ADAPTER_IDENTITY_MISMATCH,
      "the adapter entry on disk does not have the digest its certified manifest declares",
      { owner: "adapter" },
    );
  }

  // 5. The verdict, and the suite that produced it.
  if (receipt.suite !== "ADAPTER-CERT-V1") {
    throw new Erl2Error(
      CODES.ADAPTER_NOT_CERTIFIED,
      `certification suite ${receipt.suite} is not the suite this Lab recognises`,
      { owner: "adapter" },
    );
  }
  if (receipt.verdict !== "certified") {
    throw new Erl2Error(
      CODES.ADAPTER_NOT_CERTIFIED,
      `the certification receipt's verdict is ${receipt.verdict}`,
      { owner: "adapter" },
    );
  }
  if (receipt.refusal_codes.length > 0) {
    throw new Erl2Error(
      CODES.ADAPTER_NOT_CERTIFIED,
      `a certified verdict cannot carry refusal codes: ${receipt.refusal_codes.join(", ")}`,
      { owner: "adapter" },
    );
  }
  // A `certified` verdict whose own findings contain a failure is internally
  // inconsistent, whatever `refusal_codes` says.
  const failed = receipt.checks.filter((c) => c.status === "failed");
  if (failed.length > 0) {
    throw new Erl2Error(
      CODES.ADAPTER_NOT_CERTIFIED,
      `the receipt reports ${String(failed.length)} failed check(s) under a certified verdict`,
      { owner: "adapter" },
    );
  }

  // 6. Scope: certification covers exactly what the manifest declares. Not a
  //    subset — an adapter that declares an operation it was not certified for
  //    would be dispatched for it.
  assertSameSet(
    receipt.certified_operations,
    manifest.operations,
    "operations",
    manifest.adapter_id,
  );
  assertSameSet(
    receipt.certified_package_kinds,
    manifest.supported_package_kinds,
    "package kinds",
    manifest.adapter_id,
  );

  // 7. Certifier independence. The schema pins `certifier_is_adapter_owner` to
  //    false; this refuses the case the schema cannot see, where the certifier
  //    id *is* the adapter id.
  if (receipt.certifier_is_adapter_owner !== false) {
    throw new Erl2Error(
      CODES.ADAPTER_SELF_CERTIFICATION_REFUSED,
      "the receipt declares the certifier is the adapter owner",
      { owner: "adapter" },
    );
  }
  if (receipt.certifier_id === manifest.adapter_id) {
    throw new Erl2Error(
      CODES.ADAPTER_SELF_CERTIFICATION_REFUSED,
      `certifier ${receipt.certifier_id} is the adapter itself; certification must be independent`,
      { owner: "adapter" },
    );
  }

  // 8. Authentication, then policy — separately, and in that order.
  const signature = verifyReceiptSignature(receipt, input.pinnedAuthorities ?? []);
  const authenticity = deriveCertificationAuthenticity({
    contentCertified: true,
    signature,
  });
  assertAdmissionPermittedForTier(input.tier, authenticity, manifest.adapter_id);

  return {
    adapterId: manifest.adapter_id,
    adapterVersion: manifest.version,
    manifestHash,
    receiptHash,
    adapterArtifactHash: manifest.adapter_artifact_hash,
    certifierId: receipt.certifier_id,
    certifierIsAdapterOwner: false,
    certifiedOperations: [...receipt.certified_operations],
    certifiedPackageKinds: [...receipt.certified_package_kinds],
    authenticity,
    receiptLinkage,
    tier: input.tier,
  };
}

/**
 * Classifies the manifest's prior-receipt reference.
 *
 * There is deliberately no refusal here, because there is no reachable state to
 * refuse. The one value the field must never hold is the current receipt's own
 * hash — and a document holding it cannot exist: the manifest's `core_hash`
 * covers this field, and the receipt's `core_hash` covers the manifest's, so
 * satisfying both at once means finding a hash fixed point. Both hashes are
 * already recomputed and checked above, so a forged pair is rejected as a hash
 * mismatch before it reaches this function.
 *
 * Writing a refusal for it anyway would add a control that can never fire, and
 * a check no test can reach is documentation wearing a check's clothes. The
 * impossibility is the argument for using the receipt → manifest direction; it
 * is recorded in the module note and ADR-ERL2-036, not as dead code.
 */
function classifyReceiptLinkage(manifest: SubjectAdapterManifestV1): ReceiptLinkage {
  return manifest.certification_receipt_hash === BOOTSTRAP_RECEIPT_SENTINEL
    ? "bootstrap_no_prior_receipt"
    : "prior_receipt_not_resolved";
}

/** Set equality, reported with the exact difference rather than "mismatch". */
function assertSameSet(
  certified: readonly string[],
  declared: readonly string[],
  label: string,
  adapterId: string,
): void {
  const certifiedSet = new Set(certified);
  const declaredSet = new Set(declared);
  const uncertified = [...declaredSet].filter((v) => !certifiedSet.has(v)).sort();
  const uncdeclared = [...certifiedSet].filter((v) => !declaredSet.has(v)).sort();
  if (uncertified.length === 0 && uncdeclared.length === 0) return;
  const detail = [
    uncertified.length > 0 ? `declared but not certified: ${uncertified.join(", ")}` : "",
    uncdeclared.length > 0 ? `certified but not declared: ${uncdeclared.join(", ")}` : "",
  ]
    .filter((s) => s !== "")
    .join("; ");
  throw new Erl2Error(
    CODES.ADAPTER_CERTIFICATION_SCOPE_MISMATCH,
    `adapter ${adapterId} certified ${label} do not match its declared ${label} (${detail})`,
    { owner: "adapter" },
  );
}

/** What the `adapter-certified` validity gate resolves to, and on what. */
export interface AdapterCertifiedGate {
  readonly passed: boolean;
  readonly evidence_refs: readonly Hash[];
}

/**
 * Derives the `adapter-certified` validity gate from a run's retained evidence.
 *
 * This replaces a literal `passed: true`. The three outcomes are:
 *
 *   - the run bound a certification that still re-validates → **passed**, and
 *     the evidence names the receipt, because a manifest hash alone was never
 *     certification evidence;
 *   - the run dispatched a real adapter with no valid certification →
 *     **failed**. This is the state the defect made unreachable, and it is
 *     reachable now only because binding a receipt is mandatory for that path,
 *     so reaching it at all means something was removed or tampered with;
 *   - the run dispatched no adapter bytes at all (the development fake port) →
 *     **passed vacuously**, on the manifest, because there is no executed
 *     adapter to certify. The same shape `attributable-telemetry-retained`
 *     uses for a run that never declared telemetry.
 *
 * `certification` is passed already-validated (or `undefined` if validation
 * threw), so a tampered receipt fails the gate rather than throwing out of
 * finalization.
 */
export function deriveAdapterCertifiedGate(input: {
  readonly adapterManifestHash: Hash;
  readonly certification: AdapterAdmission | undefined;
  /**
   * Whether the run *bound* a certification receipt at preregistration,
   * independently of whether it still re-validates.
   *
   * Without this, a bound-then-tampered receipt on a run that dispatched no
   * adapter would be indistinguishable from a run that never bound one, and
   * would take the vacuous pass. A run that bound certification is held to it.
   */
  readonly boundCertificationHash: Hash | undefined;
  readonly dispatchedRealAdapter: boolean;
}): AdapterCertifiedGate {
  if (input.certification !== undefined) {
    return {
      passed: true,
      evidence_refs: [input.certification.receiptHash, input.adapterManifestHash],
    };
  }
  if (input.boundCertificationHash !== undefined) {
    return {
      passed: false,
      evidence_refs: [input.boundCertificationHash, input.adapterManifestHash],
    };
  }
  return {
    passed: !input.dispatchedRealAdapter,
    evidence_refs: [input.adapterManifestHash],
  };
}

/**
 * The registry subdirectory external admissions are published into.
 *
 * A governor-prepared registry is otherwise hand-assembled; keeping admitted
 * external adapters under one predictable prefix is what lets an operator see
 * which artifacts arrived through this path and remove them again.
 */
export const EXTERNAL_ADAPTER_DIR = "external-adapters";

export interface RetainedAdmission {
  /** Directory, relative to the registry root, holding both artifacts. */
  readonly logicalPath: string;
  readonly manifestHash: Hash;
  readonly receiptHash: Hash;
  /** True when this exact admission was already published. */
  readonly alreadyPresent: boolean;
}

/**
 * Publishes the validated manifest and receipt into the content-addressed
 * registry, atomically.
 *
 * Both artifacts land, or neither does. They are written into a staging
 * directory and moved into place with a single `rename`, so a crash or a
 * refusal mid-write cannot leave a registry holding a manifest whose receipt
 * never arrived — which is exactly the half-admitted state the defect made
 * indistinguishable from a certified one.
 *
 * Re-admitting the same adapter is idempotent: the directory is keyed by the
 * manifest hash, and identical bytes are a success rather than a conflict. A
 * *different* receipt for the same manifest is refused, because that is two
 * certifications disagreeing about the same bytes.
 */
export function retainAdmittedAdapter(input: {
  readonly registryRoot: string;
  readonly manifest: SubjectAdapterManifestV1;
  readonly receipt: SubjectAdapterCertificationReceiptV1;
}): RetainedAdmission {
  const root = path.resolve(input.registryRoot);
  const manifestHash = input.manifest.core_hash;
  const receiptHash = input.receipt.core_hash;
  const name = manifestHash.replace("sha256:", "");
  const logicalPath = `${EXTERNAL_ADAPTER_DIR}/${name}`;
  const destination = path.join(root, EXTERNAL_ADAPTER_DIR, name);

  if (existsSync(destination)) {
    const existing = readRetained(destination);
    if (existing.manifestHash === manifestHash && existing.receiptHash === receiptHash) {
      return { logicalPath, manifestHash, receiptHash, alreadyPresent: true };
    }
    throw new Erl2Error(
      CODES.ADMISSION_RETENTION_FAILED,
      `${logicalPath} already holds a different admission for this adapter manifest; ` +
        "remove it before admitting a different certification",
    );
  }

  let staging: string | undefined;
  try {
    mkdirSync(path.join(root, EXTERNAL_ADAPTER_DIR), { recursive: true });
    staging = mkdtempSync(path.join(root, EXTERNAL_ADAPTER_DIR, ".admit-"));
    writeFileSync(
      path.join(staging, "adapter-manifest.json"),
      `${JSON.stringify(input.manifest, null, 2)}\n`,
    );
    writeFileSync(
      path.join(staging, "certification-receipt.json"),
      `${JSON.stringify(input.receipt, null, 2)}\n`,
    );
    renameSync(staging, destination);
    staging = undefined;
  } catch (cause) {
    if (cause instanceof Erl2Error) throw cause;
    throw new Erl2Error(
      CODES.ADMISSION_RETENTION_FAILED,
      `the admitted adapter could not be published into the registry at ${logicalPath}`,
      { cause },
    );
  } finally {
    // A staging directory that survived is a failed admission; removing it is
    // what makes "no partial registry mutation" true rather than intended.
    if (staging !== undefined) rmSync(staging, { recursive: true, force: true });
  }
  return { logicalPath, manifestHash, receiptHash, alreadyPresent: false };
}

function readRetained(destination: string): {
  readonly manifestHash: string;
  readonly receiptHash: string;
} {
  const read = (name: string): string => {
    try {
      const parsed = JSON.parse(readFileSync(path.join(destination, name), "utf8")) as {
        core_hash?: unknown;
      };
      return typeof parsed.core_hash === "string" ? parsed.core_hash : "";
    } catch {
      return "";
    }
  };
  return {
    manifestHash: read("adapter-manifest.json"),
    receiptHash: read("certification-receipt.json"),
  };
}

/**
 * Re-reads the adapter entry and refuses if its bytes are no longer the ones
 * admission certified.
 *
 * Admission-time verification alone is a time-of-check/time-of-use window: the
 * file can be replaced between `admit-adapter` and the first dispatch, and the
 * host would then execute uncertified bytes under a certified manifest. This is
 * the time-of-use half, and it uses the digest the host already computes
 * (`AdapterHost.executableDigest`) rather than adding a second freeze
 * mechanism.
 */
export function assertEntryDigestUnchanged(input: {
  readonly entryPath: string;
  readonly certifiedArtifactHash: Hash;
}): Hash {
  let observed: Hash;
  try {
    observed = hashBytes(readFileSync(input.entryPath));
  } catch (cause) {
    throw new Erl2Error(
      CODES.ADAPTER_IDENTITY_MISMATCH,
      `the certified adapter entry could not be read for re-verification: ${input.entryPath}`,
      { owner: "adapter", cause },
    );
  }
  if (observed !== input.certifiedArtifactHash) {
    throw new Erl2Error(
      CODES.ADAPTER_IDENTITY_MISMATCH,
      "the adapter entry's bytes changed after certification; the certified digest no longer " +
        "describes what would execute",
      { owner: "adapter" },
    );
  }
  return observed;
}
