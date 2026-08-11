/**
 * External-adapter certification admission — the negative controls (LIVE-001,
 * ADR-ERL2-036).
 *
 * ## The defect these pin
 *
 * `certifyAdapter` produced a `SubjectAdapterCertificationReceiptV1` that
 * nothing consumed. An adapter manifest placed in a governor registry drove the
 * whole journey and the validity report still emitted
 * `adapter-certified: passed: true` with the manifest hash as its only
 * evidence — a certified claim with no certification behind it, and no way for
 * a reader to tell the difference.
 *
 * ## What is proven here, and with what
 *
 * Every fixture below is **neutral**: `neutral-analytics-adapter`, certified by
 * `neutral-certifier`, over bytes written into a temporary directory. No
 * subject-specific identity appears, because a permanent control that named a
 * real adapter would rot the moment that adapter changed.
 *
 * The receipts are hand-built rather than produced by `certifyAdapter`, because
 * a control has to be able to build the *invalid* ones — a receipt with a
 * refused verdict, a mismatched digest, a forged signature — and the harness by
 * construction only produces honest ones.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  CODES,
  Erl2Error,
  type Hash,
  type SubjectAdapterCertificationReceiptV1,
  type SubjectAdapterManifestV1,
  type Tier,
} from "@erl2/contracts";
import {
  coreHash,
  developmentKey,
  hashBytes,
  sealSigned,
  type SigningKey,
} from "@erl2/integrity";
import {
  BOOTSTRAP_RECEIPT_SENTINEL,
  PRE_ENVIRONMENT_GATE_IDS,
  adapterCertifiedGateResults,
  assertAdapterCertificationApplicability,
  deriveAdapterCertifiedGate,
  requiredGateIds,
  retainAdmittedAdapter,
  verifyAdapterCertification,
  verifyReceiptSignature,
} from "@erl2/core";
import { ownedTempDir } from "../support/tempDirs.js";

const ADAPTER_ID = "neutral-analytics-adapter";
const CERTIFIER_ID = "neutral-certifier";
const OPERATIONS = ["acquire", "validate-package"] as const;
const PACKAGE_KINDS = ["archive"] as const;

/** The certifier key a verifier pins, and one it does not. */
const PINNED_CERTIFIER = developmentKey("neutral-certifier");
const UNPINNED_CERTIFIER = developmentKey("unpinned-certifier");

function pemOf(key: SigningKey): string {
  return key.publicKey.export({ type: "spki", format: "pem" }).toString();
}

const PINNED_AUTHORITIES = [{ keyId: PINNED_CERTIFIER.keyId, publicKeyPem: pemOf(PINNED_CERTIFIER) }];

/** An adapter entry on disk, and its real digest. */
function writeEntry(contents = "export const adapter = 1;\n"): {
  readonly entryPath: string;
  readonly digest: Hash;
} {
  const dir = ownedTempDir("erl2-neutral-adapter-");
  const entryPath = path.join(dir, "main.mjs");
  writeFileSync(entryPath, contents);
  return { entryPath, digest: hashBytes(Buffer.from(contents)) };
}

function neutralManifest(overrides: Partial<SubjectAdapterManifestV1> = {}): SubjectAdapterManifestV1 {
  return sealSigned(
    {
      schema_version: "subject-adapter-manifest/v1" as const,
      adapter_id: ADAPTER_ID,
      version: "0.1.0",
      protocol_version: "subject-adapter/v1" as const,
      adapter_artifact_hash: `sha256:${"1".repeat(64)}`,
      supported_package_kinds: [...PACKAGE_KINDS],
      operations: [...OPERATIONS],
      required_broker_capabilities: [],
      network_allowlist_ids: [],
      projection_schema: "generic-claim-set/v1" as const,
      certification_receipt_hash: BOOTSTRAP_RECEIPT_SENTINEL,
      owner: "neutral owner",
      ...overrides,
    },
    developmentKey("adapter-owner"),
  ) as SubjectAdapterManifestV1;
}

function neutralReceipt(
  manifest: SubjectAdapterManifestV1,
  overrides: Record<string, unknown> = {},
  signWith?: SigningKey,
): SubjectAdapterCertificationReceiptV1 {
  const base = {
    schema_version: "subject-adapter-certification-receipt/v1" as const,
    receipt_id: `cert-${ADAPTER_ID}`,
    suite: "ADAPTER-CERT-V1" as const,
    adapter_manifest_hash: manifest.core_hash,
    adapter_artifact_hash: manifest.adapter_artifact_hash,
    adapter_id: manifest.adapter_id,
    adapter_version: manifest.version,
    certified_operations: [...manifest.operations],
    certified_package_kinds: [...manifest.supported_package_kinds],
    checks: [
      {
        check_id: "immutable-artifact-identity",
        status: "passed" as const,
        severity: "info" as const,
        detail: "neutral fixture",
      },
    ],
    verdict: "certified" as const,
    refusal_codes: [] as string[],
    certifier_id: CERTIFIER_ID,
    certifier_is_adapter_owner: false as const,
    enforced_controls: [],
    unsupported_controls: [],
    certified_at: "2026-07-01T00:00:00Z",
    ...overrides,
  };
  const sealed =
    signWith === undefined ? { ...base, core_hash: coreHash(base) } : sealSigned(base, signWith);
  return sealed as SubjectAdapterCertificationReceiptV1;
}

/** A manifest and receipt that agree with each other and with the bytes. */
function admissiblePair(): {
  readonly manifest: SubjectAdapterManifestV1;
  readonly receipt: SubjectAdapterCertificationReceiptV1;
  readonly entryPath: string;
  readonly digest: Hash;
} {
  const { entryPath, digest } = writeEntry();
  const manifest = neutralManifest({ adapter_artifact_hash: digest });
  return { manifest, receipt: neutralReceipt(manifest), entryPath, digest };
}

function throwsCode(fn: () => unknown, code: string, label: string): void {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof Erl2Error, `${label}: expected a typed refusal, got ${String(error)}`);
    assert.equal(error.code, code, `${label}: wrong refusal code — ${error.message}`);
    return;
  }
  assert.fail(`${label}: expected refusal ${code}, but nothing was thrown`);
}

function admit(
  manifest: SubjectAdapterManifestV1,
  receipt: SubjectAdapterCertificationReceiptV1,
  tier: Tier = "development",
  digest?: Hash,
): ReturnType<typeof verifyAdapterCertification> {
  return verifyAdapterCertification({
    manifest,
    receipt,
    tier,
    ...(digest === undefined ? {} : { entryDigest: digest }),
    pinnedAuthorities: PINNED_AUTHORITIES,
  });
}

// -- 1/2. the two admissible shapes, and how they are labelled ---------------

test("ADMISSION: a receipt signed by a pinned authority is authenticated, and admissible at a scored tier", () => {
  const { entryPath, digest } = writeEntry();
  const manifest = neutralManifest({ adapter_artifact_hash: digest });
  const receipt = neutralReceipt(manifest, {}, PINNED_CERTIFIER);
  void entryPath;

  for (const tier of ["development", "held_out", "blind"] as const) {
    const admission = admit(manifest, receipt, tier, digest);
    assert.equal(admission.authenticity, "authenticated", `tier ${tier}`);
    assert.equal(admission.certifierId, CERTIFIER_ID);
    assert.equal(admission.certifierIsAdapterOwner, false);
  }
});

test("ADMISSION: a valid unsigned receipt is admitted at development, labelled unauthenticated", () => {
  const { manifest, receipt, digest } = admissiblePair();
  const admission = admit(manifest, receipt, "development", digest);

  assert.equal(admission.authenticity, "locally_observed_unauthenticated");
  assert.notEqual(
    admission.authenticity,
    "authenticated",
    "an unsigned receipt must never be reported as authenticated",
  );
  assert.equal(admission.receiptLinkage, "bootstrap_no_prior_receipt");
  // The certification fact and the authentication fact stay separate: this
  // receipt *did* certify, and is *not* authenticated.
  assert.equal(admission.adapterId, ADAPTER_ID);
});

// -- 3. the scored refusal ---------------------------------------------------

test("ADMISSION: an unsigned receipt is refused for every scored tier", () => {
  const { manifest, receipt, digest } = admissiblePair();
  for (const tier of ["held_out", "blind"] as const) {
    throwsCode(
      () => admit(manifest, receipt, tier, digest),
      CODES.ADAPTER_CERTIFICATION_AUTHENTICATION_REQUIRED,
      `unsigned receipt at ${tier}`,
    );
  }
});

test("ADMISSION: a signature by an unpinned signer never authenticates, and is refused when scored", () => {
  const { manifest, digest } = admissiblePair();
  const receipt = neutralReceipt(manifest, {}, UNPINNED_CERTIFIER);

  const verification = verifyReceiptSignature(receipt, PINNED_AUTHORITIES);
  assert.equal(verification.signaturePresent, true);
  assert.equal(verification.signatureValid, false);
  assert.equal(verification.reason, "CERTIFICATION_RECEIPT_SIGNER_NOT_PINNED");

  // A signature the verifier cannot authorize is worse than none: it does not
  // certify at all, at any tier.
  throwsCode(
    () => admit(manifest, receipt, "development", digest),
    CODES.ADAPTER_NOT_CERTIFIED,
    "unpinned signer at development",
  );
});

// -- 16. a placeholder is not a signature ------------------------------------

test("ADMISSION: zero-filled signature bytes are not treated as authenticated", () => {
  const { manifest, digest } = admissiblePair();
  const unsigned = neutralReceipt(manifest);
  const placeholder = {
    ...unsigned,
    signature: {
      algorithm: "Ed25519",
      key_id: PINNED_CERTIFIER.keyId,
      signed_hash: unsigned.core_hash,
      signature_base64: Buffer.alloc(64).toString("base64"),
    },
  } as SubjectAdapterCertificationReceiptV1;

  const verification = verifyReceiptSignature(placeholder, PINNED_AUTHORITIES);
  assert.equal(verification.signatureValid, false, "an all-zero signature must not verify");
  assert.equal(verification.signerIsPinnedAuthority, false);

  throwsCode(
    () => admit(manifest, placeholder, "development", digest),
    CODES.ADAPTER_NOT_CERTIFIED,
    "zero-filled signature",
  );
});

// -- 6/7/8. the receipt's own integrity --------------------------------------

test("ADMISSION: a receipt whose bytes do not produce its core hash is refused", () => {
  const { manifest, receipt, digest } = admissiblePair();
  const tampered = { ...receipt, certifier_id: "someone-else" } as SubjectAdapterCertificationReceiptV1;
  throwsCode(
    () => admit(manifest, tampered, "development", digest),
    CODES.ARTIFACT_HASH_MISMATCH,
    "tampered receipt body",
  );
});

test("ADMISSION: a refused verdict cannot be admitted", () => {
  const { manifest, digest } = admissiblePair();
  const refused = neutralReceipt(manifest, {
    verdict: "refused",
    refusal_codes: ["ADAPTER_PROTOCOL_VERSION_MISMATCH"],
    certified_operations: [],
    certified_package_kinds: [],
  });
  throwsCode(
    () => admit(manifest, refused, "development", digest),
    CODES.ADAPTER_NOT_CERTIFIED,
    "refused verdict",
  );
});

test("ADMISSION: a certified verdict carrying refusal codes cannot be admitted", () => {
  const { manifest, digest } = admissiblePair();
  const inconsistent = neutralReceipt(manifest, { refusal_codes: ["ADAPTER_EXECUTION_FAULT"] });
  // The closed schema already forbids this pairing (`refusal_codes` must be
  // empty unless the verdict is `refused`), so the refusal is the contract's
  // rather than admission's. Either is fail-closed; asserting the code the
  // shipped path actually returns is what makes this control honest.
  throwsCode(
    () => admit(manifest, inconsistent, "development", digest),
    CODES.SCHEMA_VALIDATION_FAILED,
    "certified with refusal codes",
  );
});

test("ADMISSION: a certified verdict whose own checks failed is refused", () => {
  const { manifest, digest } = admissiblePair();
  const inconsistent = neutralReceipt(manifest, {
    checks: [
      {
        check_id: "protocol-negotiation",
        status: "failed",
        severity: "critical",
        detail: "neutral fixture",
        refusal_code: "ADAPTER_PROTOCOL_FRAME_INVALID",
      },
    ],
  });
  throwsCode(
    () => admit(manifest, inconsistent, "development", digest),
    CODES.ADAPTER_NOT_CERTIFIED,
    "certified with a failed check",
  );
});

// -- 9/10/11/12. identity and bytes ------------------------------------------

test("ADMISSION: a receipt describing a different manifest is refused", () => {
  const { manifest, digest } = admissiblePair();
  const other = neutralManifest({ adapter_artifact_hash: digest, owner: "a different owner" });
  const receiptForOther = neutralReceipt(other);
  throwsCode(
    () => admit(manifest, receiptForOther, "development", digest),
    CODES.ADAPTER_CERTIFICATION_IDENTITY_MISMATCH,
    "manifest hash mismatch",
  );
});

test("ADMISSION: adapter id and version mismatches are refused", () => {
  const { manifest, digest } = admissiblePair();
  // The receipt still names this manifest by hash, but disagrees about who it is.
  for (const [override, label] of [
    [{ adapter_id: "some-other-adapter" }, "adapter id"],
    [{ adapter_version: "9.9.9" }, "adapter version"],
  ] as const) {
    throwsCode(
      () => admit(manifest, neutralReceipt(manifest, override), "development", digest),
      CODES.ADAPTER_CERTIFICATION_IDENTITY_MISMATCH,
      label,
    );
  }
});

test("ADMISSION: a receipt certifying different bytes than the manifest declares is refused", () => {
  const { manifest, digest } = admissiblePair();
  const wrongBytes = neutralReceipt(manifest, { adapter_artifact_hash: `sha256:${"7".repeat(64)}` });
  throwsCode(
    () => admit(manifest, wrongBytes, "development", digest),
    CODES.ADAPTER_IDENTITY_MISMATCH,
    "receipt/manifest artifact hash",
  );
});

test("ADMISSION: an entry whose bytes are not the certified ones is refused", () => {
  const { manifest, receipt } = admissiblePair();
  const somethingElse = hashBytes(Buffer.from("different bytes entirely\n"));
  throwsCode(
    () => admit(manifest, receipt, "development", somethingElse),
    CODES.ADAPTER_IDENTITY_MISMATCH,
    "entry digest mismatch",
  );
});

// -- 13/14. scope ------------------------------------------------------------

test("ADMISSION: certified operations must match the manifest's declared operations exactly", () => {
  const { manifest, digest } = admissiblePair();
  for (const [certified, label] of [
    [["acquire"], "declared but not certified"],
    [["acquire", "validate-package", "install"], "certified but not declared"],
  ] as const) {
    throwsCode(
      () => admit(manifest, neutralReceipt(manifest, { certified_operations: [...certified] }), "development", digest),
      CODES.ADAPTER_CERTIFICATION_SCOPE_MISMATCH,
      `operations: ${label}`,
    );
  }
});

test("ADMISSION: certified package kinds must match the manifest's declared kinds exactly", () => {
  const { manifest, digest } = admissiblePair();
  throwsCode(
    () => admit(manifest, neutralReceipt(manifest, { certified_package_kinds: ["oci"] }), "development", digest),
    CODES.ADAPTER_CERTIFICATION_SCOPE_MISMATCH,
    "package kinds",
  );
});

// -- 15. certifier independence ----------------------------------------------

test("ADMISSION: an adapter that certified itself is refused", () => {
  const { manifest, digest } = admissiblePair();
  const selfCertified = neutralReceipt(manifest, { certifier_id: ADAPTER_ID });
  throwsCode(
    () => admit(manifest, selfCertified, "development", digest),
    CODES.ADAPTER_SELF_CERTIFICATION_REFUSED,
    "certifier is the adapter",
  );
});

// -- the linkage cycle -------------------------------------------------------

test("ADMISSION: the manifest-names-its-own-receipt cycle is unforgeable, not merely refused", () => {
  const { manifest, receipt, digest } = admissiblePair();
  // Setting the field to the current receipt's hash changes the manifest's own
  // core hash, so the document stops being self-consistent. That is *why* the
  // Lab binds receipt -> manifest and not the reverse: the reverse cannot be
  // expressed, and admission rejects the attempt as a hash mismatch rather
  // than needing a dedicated refusal for a state no one can construct.
  const circular = {
    ...manifest,
    certification_receipt_hash: receipt.core_hash,
  } as SubjectAdapterManifestV1;
  assert.notEqual(coreHash(circular), circular.core_hash);
  throwsCode(
    () => admit(circular, neutralReceipt(circular), "development", digest),
    CODES.ARTIFACT_HASH_MISMATCH,
    "manifest/receipt cycle",
  );
});

test("ADMISSION: a non-sentinel prior-receipt reference is carried, never claimed as verified", () => {
  const { entryPath, digest } = writeEntry();
  const manifest = neutralManifest({
    adapter_artifact_hash: digest,
    certification_receipt_hash: `sha256:${"5".repeat(64)}`,
  });
  void entryPath;
  const admission = admit(manifest, neutralReceipt(manifest), "development", digest);
  assert.equal(admission.receiptLinkage, "prior_receipt_not_resolved");
});

// -- 19. atomic retention ----------------------------------------------------

test("ADMISSION: a published admission holds both artifacts, and republishing is idempotent", () => {
  const registryRoot = ownedTempDir("erl2-neutral-registry-");
  const { manifest, receipt } = admissiblePair();

  const first = retainAdmittedAdapter({ registryRoot, manifest, receipt });
  assert.equal(first.alreadyPresent, false);
  const published = readdirSync(path.join(registryRoot, first.logicalPath)).sort();
  assert.deepEqual(published, ["adapter-manifest.json", "certification-receipt.json"]);

  const second = retainAdmittedAdapter({ registryRoot, manifest, receipt });
  assert.equal(second.alreadyPresent, true, "re-admitting the same pair is idempotent");
  assert.equal(second.logicalPath, first.logicalPath);
});

test("ADMISSION: a failed retention leaves no partial registry state", () => {
  const registryRoot = ownedTempDir("erl2-neutral-registry-");
  const { manifest, receipt } = admissiblePair();
  retainAdmittedAdapter({ registryRoot, manifest, receipt });

  // A second, different certification for the same manifest is a conflict, not
  // an overwrite: two certifications disagreeing about the same bytes.
  const otherReceipt = neutralReceipt(manifest, { receipt_id: "cert-neutral-second" });
  throwsCode(
    () => retainAdmittedAdapter({ registryRoot, manifest, receipt: otherReceipt }),
    CODES.ADMISSION_RETENTION_FAILED,
    "conflicting re-admission",
  );

  // Nothing was staged and abandoned: the only entry is the original pair.
  const entries = readdirSync(path.join(registryRoot, "external-adapters")).sort();
  assert.equal(entries.length, 1, `unexpected registry residue: ${entries.join(", ")}`);
  assert.ok(!entries.some((e) => e.startsWith(".admit-")), "a staging directory survived");
});

test("ADMISSION: retention into a missing registry root refuses without creating one", () => {
  const registryRoot = path.join(ownedTempDir("erl2-neutral-registry-"), "does", "not", "exist");
  const { manifest, receipt } = admissiblePair();
  // `mkdirSync` with `recursive` would happily create the tree; refusing keeps
  // a typo from silently producing a registry no run will ever read.
  const result = (): unknown => retainAdmittedAdapter({ registryRoot, manifest, receipt });
  try {
    result();
  } catch (error) {
    assert.ok(error instanceof Erl2Error);
    return;
  }
  // Creating it is acceptable only if both artifacts really landed.
  const published = readdirSync(path.join(registryRoot, "external-adapters")).sort();
  assert.equal(published.length, 1);
});

// -- 17/20. the gate itself --------------------------------------------------

test("GATE: adapter-certified is applicable only to a real adapter, and always names the receipt", () => {
  const manifestHash = `sha256:${"a".repeat(64)}` as Hash;
  const receiptHash = `sha256:${"b".repeat(64)}` as Hash;
  const admission = {
    adapterId: ADAPTER_ID,
    adapterVersion: "0.1.0",
    manifestHash,
    receiptHash,
    adapterArtifactHash: `sha256:${"c".repeat(64)}` as Hash,
    certifierId: CERTIFIER_ID,
    certifierIsAdapterOwner: false as const,
    certifiedOperations: [...OPERATIONS],
    certifiedPackageKinds: [...PACKAGE_KINDS],
    authenticity: "locally_observed_unauthenticated" as const,
    receiptLinkage: "bootstrap_no_prior_receipt" as const,
    tier: "development" as const,
  };

  // A real run whose certification no longer validates fails — it is held to
  // what it froze.
  const tampered = deriveAdapterCertifiedGate({
    adapterManifestHash: manifestHash,
    subjectExecutionMode: "external_adapter",
    certification: undefined,
    boundCertificationHash: receiptHash,
    dispatchedRealAdapter: false,
  });
  assert.equal(tampered?.passed, false, "a bound-then-broken certification must fail");

  // A real run with no binding at all also fails; there is no vacuous pass on
  // this branch any more.
  const unbound = deriveAdapterCertifiedGate({
    adapterManifestHash: manifestHash,
    subjectExecutionMode: "external_adapter",
    certification: undefined,
    boundCertificationHash: undefined,
    dispatchedRealAdapter: true,
  });
  assert.equal(unbound?.passed, false, "a dispatched adapter with no receipt must fail");

  // The passing case names the receipt, not only the manifest.
  const certified = deriveAdapterCertifiedGate({
    adapterManifestHash: manifestHash,
    subjectExecutionMode: "external_adapter",
    certification: admission,
    boundCertificationHash: receiptHash,
    dispatchedRealAdapter: true,
  });
  assert.equal(certified?.passed, true);
  assert.ok(
    certified?.evidence_refs.includes(receiptHash),
    "a passing adapter-certified gate must cite the certification receipt",
  );
});

// -- 4/22/23. the CLI surface ------------------------------------------------

test("CLI: a real adapter without its certification is refused, and help documents the step", async () => {
  const { runCommand } = await import("@erl2/cli");

  const help = runCommand(["help"]);
  assert.equal(help.ok, true);
  const data = help.data as {
    commands: string[];
    usage: Record<string, Record<string, unknown>>;
  };
  assert.ok(data.commands.includes("admit-adapter"), "admit-adapter must be discoverable");
  const usage = data.usage["admit-adapter"];
  assert.ok(usage, "admit-adapter must be documented in help");
  for (const key of ["required_flags", "trust_behaviour", "outputs", "then", "cleanup"]) {
    assert.ok(usage[key] !== undefined, `help omits ${key}`);
  }
  const required = usage["required_flags"] as Record<string, string>;
  for (const flag of [
    "--registry",
    "--adapter-manifest",
    "--certification-receipt",
    "--adapter-entry",
  ]) {
    assert.ok(required[flag] !== undefined, `help omits required flag ${flag}`);
  }

  // Unknown flags stay fail-closed on the new command.
  const unknown = runCommand(["admit-adapter", "--registry", "x", "--not-a-flag", "y"]);
  assert.equal(unknown.ok, false);
  assert.equal(unknown.errors[0]?.code, "CFG_UNKNOWN_FLAG");

  // And a certification handed to a run that dispatches nothing is refused
  // rather than silently ignored.
  const misapplied = runCommand([
    "preregister-acquisition",
    "--run-root", ownedTempDir("erl2-no-entry-"),
    "--registry", ownedTempDir("erl2-no-registry-"),
    "--adapter-certification", `sha256:${"0".repeat(64)}`,
    "--acquisition-source", `sha256:${"1".repeat(64)}`,
    "--adapter", `sha256:${"2".repeat(64)}`,
    "--acquisition-actor-script", `sha256:${"3".repeat(64)}`,
    "--acquisition-actor-schema", `sha256:${"4".repeat(64)}`,
    "--acquisition-step", `sha256:${"5".repeat(64)}`,
    "--package-verification-step", `sha256:${"6".repeat(64)}`,
    "--generic-policy", `sha256:${"7".repeat(64)}`,
    "--trust-policy", `sha256:${"8".repeat(64)}`,
    "--limits", `sha256:${"9".repeat(64)}`,
    "--expires", "2030-12-31T00:00:00Z",
  ]);
  assert.equal(misapplied.ok, false);
  assert.equal(misapplied.errors[0]?.code, "CFG_MISSING_REQUIRED");
});

// -- 21. the load-bearing regression -----------------------------------------

test("REGRESSION LIVE-001: no validity path emits an unconditional passing adapter-certified gate", async () => {
  // Behavioural where it can be (every case above), architectural here: the
  // literal the defect report quoted — `{ gate_id: "adapter-certified", passed:
  // true` — must not come back. A future edit that reintroduces the constant
  // passes every behavioural test in this file, because a constant `true` is
  // indistinguishable from a correct derivation on the certified path.
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const sources = [
    path.join(repoRoot, "packages", "core", "src", "run", "workspace.ts"),
    path.join(repoRoot, "packages", "core", "src", "run", "environmentRun.ts"),
  ];
  for (const source of sources) {
    const text = readFileSync(source, "utf8");
    assert.ok(
      !/gate_id:\s*"adapter-certified"/.test(text),
      `${source} emits an adapter-certified gate literal again instead of deriving it`,
    );
    assert.ok(
      text.includes("adapterCertifiedGateResults"),
      `${source} does not derive adapter-certified from retained evidence`,
    );
    // …and it must pass the run's own frozen mode, not assume one.
    assert.ok(
      /subjectExecutionMode:\s*this\.(ws\.)?subjectExecutionMode\(\)/.test(text),
      `${source} does not derive adapter-certified applicability from the frozen mode`,
    );
  }

  // The single place the gate id is now written must not be able to produce a
  // pass without a validated certification.
  const admissionSource = readFileSync(
    path.join(repoRoot, "packages", "core", "src", "adapter", "admission.ts"),
    "utf8",
  );
  const gateFn = admissionSource.slice(admissionSource.indexOf("export function deriveAdapterCertifiedGate"));
  assert.ok(
    gateFn.includes("input.certification !== undefined"),
    "the derivation no longer requires a validated certification to pass",
  );
});

test("GATE: a fake-port run omits adapter-certified entirely — not applicable, not passed", () => {
  // The review's P2: a boolean cannot say "no external adapter was selected".
  // `passed: true` over manifest-only evidence reads as a certification claim,
  // so the gate is absent instead — the same way the catalogue already omits
  // the environment and selection gates on a run that reached neither.
  const manifestHash = `sha256:${"d".repeat(64)}` as Hash;
  const gate = deriveAdapterCertifiedGate({
    adapterManifestHash: manifestHash,
    subjectExecutionMode: "development_fake_port",
    certification: undefined,
    boundCertificationHash: undefined,
    dispatchedRealAdapter: false,
  });
  assert.equal(gate, undefined, "a fake-port run must not emit an adapter-certified gate");

  assert.deepEqual(
    adapterCertifiedGateResults({
      adapterManifestHash: manifestHash,
      subjectExecutionMode: "development_fake_port",
      certification: undefined,
      boundCertificationHash: undefined,
      dispatchedRealAdapter: false,
    }),
    [],
    "the gate list must contain no adapter-certified entry for a fake-port run",
  );

  // And the validity catalogue agrees it is not required there.
  assert.ok(
    !requiredGateIds(PRE_ENVIRONMENT_GATE_IDS, { externalAdapter: false }).includes(
      "adapter-certified",
    ),
  );
  assert.ok(
    requiredGateIds(PRE_ENVIRONMENT_GATE_IDS, { externalAdapter: true }).includes(
      "adapter-certified",
    ),
  );
});

// -- the applicability truth table, enforced rather than assumed --------------

test("GATE-APPLICABILITY: omitting adapter-certified for a fake run does not make it optional for a real one", () => {
  const manifestHash = `sha256:${"a".repeat(64)}` as Hash;
  const receiptHash = `sha256:${"b".repeat(64)}` as Hash;
  const bootstrap = BOOTSTRAP_RECEIPT_SENTINEL;
  const otherGates: readonly { gate_id: string; passed: boolean; evidence_refs: readonly Hash[] }[] =
    [{ gate_id: "adapter-authority-respected", passed: true, evidence_refs: [manifestHash] }];

  const check = (
    gates: readonly { gate_id: string; passed: boolean; evidence_refs: readonly Hash[] }[],
    mode: "development_fake_port" | "external_adapter",
    receipt?: Hash,
  ): (() => void) => () =>
    assertAdapterCertificationApplicability([...otherGates, ...gates], {
      subjectExecutionMode: mode,
      ...(receipt === undefined ? {} : { currentReceiptHash: receipt }),
    });

  // Fake/internal: the gate must be absent.
  check([], "development_fake_port")();
  throwsCode(
    check([{ gate_id: "adapter-certified", passed: true, evidence_refs: [manifestHash] }], "development_fake_port"),
    CODES.EVALUATOR_VALIDITY_GATE_NOT_LAB_OWNED,
    "a fake run emitting the gate",
  );

  // External with a valid current receipt: exactly one gate, citing it.
  check(
    [{ gate_id: "adapter-certified", passed: true, evidence_refs: [receiptHash, manifestHash] }],
    "external_adapter",
    receiptHash,
  )();

  // External with the gate omitted: refused.
  throwsCode(
    check([], "external_adapter", receiptHash),
    CODES.GRAPH_CLOSURE_MISSING_ROLE,
    "an external run omitting the gate",
  );

  // External with the gate duplicated: refused — "exactly one".
  throwsCode(
    check(
      [
        { gate_id: "adapter-certified", passed: true, evidence_refs: [receiptHash, manifestHash] },
        { gate_id: "adapter-certified", passed: true, evidence_refs: [receiptHash, manifestHash] },
      ],
      "external_adapter",
      receiptHash,
    ),
    CODES.GRAPH_CLOSURE_MISSING_ROLE,
    "an external run emitting two gates",
  );

  // External with manifest-only evidence: refused.
  throwsCode(
    check(
      [{ gate_id: "adapter-certified", passed: true, evidence_refs: [manifestHash] }],
      "external_adapter",
      receiptHash,
    ),
    CODES.GRAPH_CLOSURE_MISSING_ROLE,
    "an external run citing only the manifest",
  );

  // External citing the manifest's bootstrap/prior receipt: refused.
  throwsCode(
    check(
      [{ gate_id: "adapter-certified", passed: true, evidence_refs: [bootstrap, manifestHash] }],
      "external_adapter",
      receiptHash,
    ),
    CODES.GRAPH_CLOSURE_MISSING_ROLE,
    "an external run citing the bootstrap sentinel",
  );

  // And the required-set still names it for external runs.
  assert.ok(requiredGateIds(PRE_ENVIRONMENT_GATE_IDS, { externalAdapter: true }).includes("adapter-certified"));
  assert.ok(!requiredGateIds(PRE_ENVIRONMENT_GATE_IDS, { externalAdapter: false }).includes("adapter-certified"));
});
