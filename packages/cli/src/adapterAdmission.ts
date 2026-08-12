/**
 * `erl2 admit-adapter` — the supported way an external adapter enters the Lab
 * (LIVE-001/LIVE-002, ADR-ERL2-036).
 *
 * Before this command there was no public path that consumed a
 * `SubjectAdapterCertificationReceiptV1`. An adapter manifest could be dropped
 * into a governor registry by hand and driven through a whole journey, and the
 * validity report would still call it certified. The registry is still a
 * governor-prepared directory — this command does not replace that — but the
 * *certified external adapter* case now has one command that validates the
 * three inputs together and publishes them atomically.
 *
 * It admits. It does not execute: nothing here starts an adapter, and the
 * command returns before any lifecycle operation could be dispatched.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  CODES,
  Erl2Error,
  parseStrictJson,
  type SubjectAdapterCertificationReceiptV1,
  type SubjectAdapterManifestV1,
  type Tier,
} from "./contractsFacade.js";
import { hashBytes } from "@erl2/integrity";
import { retainAdmittedAdapter, verifyAdapterCertification } from "@erl2/core";
import { parseFlags, requireString } from "./args.js";

/** The tiers this command will admit for; anything else is refused up front. */
const TIERS: ReadonlySet<string> = new Set<string>(["development", "held_out", "blind"]);

export interface AdmitAdapterOutput {
  readonly adapter_id: string;
  readonly adapter_version: string;
  readonly adapter_manifest_hash: string;
  readonly certification_receipt_hash: string;
  readonly adapter_artifact_hash: string;
  readonly certifier_id: string;
  readonly certifier_is_adapter_owner: false;
  readonly certified_operations: readonly string[];
  readonly certified_package_kinds: readonly string[];
  /**
   * `locally_observed_unauthenticated` or `authenticated` — never a bare
   * "certified". Certification and authentication are two facts and the output
   * reports both, so a reader cannot mistake an unsigned development receipt
   * for a signed one.
   */
  readonly certification_authenticity: string;
  readonly receipt_linkage: string;
  readonly tier: string;
  readonly registry_path: string;
  readonly already_admitted: boolean;
}

export function admitAdapter(argv: readonly string[]): AdmitAdapterOutput {
  const flags = parseFlags(argv, [
    { name: "registry", kind: "string", required: true },
    { name: "adapter-manifest", kind: "string", required: true },
    { name: "certification-receipt", kind: "string", required: true },
    { name: "adapter-entry", kind: "string", required: true },
    { name: "tier", kind: "string" },
  ]);

  const tier = (flags["tier"] as string | undefined) ?? "development";
  if (!TIERS.has(tier)) {
    throw new Erl2Error(CODES.CFG_MISSING_REQUIRED, `unknown tier ${tier}`);
  }

  const manifest = readContractDocument<SubjectAdapterManifestV1>(
    requireString(flags, "adapter-manifest"),
    "adapter manifest",
  );
  const receipt = readContractDocument<SubjectAdapterCertificationReceiptV1>(
    requireString(flags, "certification-receipt"),
    "certification receipt",
  );
  const entryPath = path.resolve(requireString(flags, "adapter-entry"));
  if (!existsSync(entryPath)) {
    throw new Erl2Error(
      CODES.ADAPTER_IDENTITY_MISMATCH,
      `adapter entry not found: ${requireString(flags, "adapter-entry")}`,
    );
  }

  // Validate everything before touching the registry. A refusal must leave the
  // registry exactly as it was, so the write is the last thing that happens.
  const admission = verifyAdapterCertification({
    manifest,
    receipt,
    entryDigest: hashBytes(readFileSync(entryPath)),
    tier: tier as Tier,
  });

  const registryRoot = path.resolve(requireString(flags, "registry"));
  if (!existsSync(registryRoot)) {
    throw new Erl2Error(
      CODES.CFG_MISSING_REQUIRED,
      `registry root not found: ${requireString(flags, "registry")}`,
    );
  }
  const retained = retainAdmittedAdapter({ registryRoot, manifest, receipt });

  return {
    adapter_id: admission.adapterId,
    adapter_version: admission.adapterVersion,
    adapter_manifest_hash: admission.manifestHash,
    certification_receipt_hash: admission.receiptHash,
    adapter_artifact_hash: admission.adapterArtifactHash,
    certifier_id: admission.certifierId,
    certifier_is_adapter_owner: false,
    certified_operations: admission.certifiedOperations,
    certified_package_kinds: admission.certifiedPackageKinds,
    certification_authenticity: admission.authenticity,
    receipt_linkage: admission.receiptLinkage,
    tier: admission.tier,
    registry_path: retained.logicalPath,
    already_admitted: retained.alreadyPresent,
  };
}

/** Strict JSON, typed on every failure mode — never a raw parse error. */
function readContractDocument<T>(documentPath: string, label: string): T {
  const absolute = path.resolve(documentPath);
  if (!existsSync(absolute)) {
    throw new Erl2Error(CODES.CFG_MISSING_REQUIRED, `${label} not found: ${documentPath}`);
  }
  let text: string;
  try {
    text = readFileSync(absolute, "utf8");
  } catch (cause) {
    throw new Erl2Error(CODES.CFG_MISSING_REQUIRED, `${label} could not be read: ${documentPath}`, {
      cause,
    });
  }
  let value: unknown;
  try {
    value = parseStrictJson(text);
  } catch (cause) {
    if (cause instanceof Erl2Error) throw cause;
    throw new Erl2Error(
      CODES.SCHEMA_VALIDATION_FAILED,
      `${label} is not a valid JSON document: ${documentPath}`,
      { cause },
    );
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Erl2Error(
      CODES.SCHEMA_VALIDATION_FAILED,
      `${label} must be a JSON object: ${documentPath}`,
    );
  }
  return value as T;
}
