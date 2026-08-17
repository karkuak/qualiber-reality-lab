/**
 * `erl2 declare-trusted-local-adapter` — writes down what an operator is
 * actually accepting, bound to the bytes they are accepting it for.
 *
 * ## Why this is a separate command
 *
 * The run command could compute a declaration itself and save the operator a
 * step. It deliberately does not. A declaration is the entire authority under
 * which foreign code executes with the operator's own permissions, so there
 * has to be a moment where it exists as reviewable bytes on disk — hashes
 * included — before anything runs. Generating it inside the run would mean the
 * only artefact stating the terms was produced by the same invocation that
 * acted on them.
 *
 * ## Why the acknowledgement is a sentence
 *
 * `--yes` and `--force` are not acknowledgements; they are the shape of a
 * prompt someone is trying to get past. The token here is a contract constant
 * the operator has to reproduce exactly, it names each thing being accepted,
 * and it is retained verbatim in the declaration and in every run record built
 * from it. Getting it wrong is a refusal, not a warning.
 *
 * This command starts no adapter, reads no adapter output, and forms no
 * opinion about the code. It hashes bytes and records a statement.
 */

import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  CODES,
  Erl2Error,
  assertContract,
  parseStrictJson,
  type Hash,
  type LocalObservationTrustedLocalPlanV1,
  type SubjectAdapterManifestV2,
  type TrustedLocalAdapterDeclarationV1,
} from "./contractsFacade.js";
import { coreHash, hashBytes } from "@erl2/integrity";
import {
  MAX_TRUSTED_LOCAL_DOCUMENT_BYTES,
  SystemClock,
  TRUSTED_LOCAL_ACKNOWLEDGEMENT_TOKEN,
  assertRegularFile,
  verifyTrustedLocalAdapterDeclaration,
} from "@erl2/core";
import { parseFlags, requireString } from "./args.js";

/** The claim ceiling every trusted-local document restates, in plan order. */
const EXCLUDED_CLAIMS = [
  "score",
  "qualification",
  "governor_authorization",
  "reveal",
  "judge_evaluation",
  "governed_finalization",
] as const;

const MAX_OWNER_EVIDENCE_BYTES = 1024 * 1024;

export interface DeclareTrustedLocalAdapterOutput {
  readonly declaration_path: string;
  readonly declaration_core_hash: string;
  readonly declaration_file_hash: string;
  readonly adapter_id: string;
  readonly adapter_owner: string;
  readonly adapter_artifact_hash: string;
  readonly adapter_manifest_core_hash: string;
  readonly adapter_manifest_file_hash: string;
  readonly trust_mode: "trusted_local_code";
  readonly tier: "development";
  readonly independent_certifier: null;
  readonly confinement: "absent";
  readonly sealed_plan_path?: string;
  readonly sealed_plan_core_hash?: string;
  /** Restated here so the terminal shows the ceiling, not only the file. */
  readonly trust_warning: readonly string[];
}

export function declareTrustedLocalAdapter(
  argv: readonly string[],
): DeclareTrustedLocalAdapterOutput {
  const flags = parseFlags(argv, [
    { name: "adapter-entry", kind: "string", required: true },
    { name: "manifest", kind: "string", required: true },
    { name: "acknowledge-trusted-local-code", kind: "string", required: true },
    { name: "acknowledged-by", kind: "string", required: true },
    { name: "declaration-id", kind: "string", required: true },
    { name: "output", kind: "string", required: true },
    { name: "source-repository", kind: "string" },
    { name: "source-commit", kind: "string" },
    { name: "source-tree", kind: "string" },
    { name: "owner-test-evidence", kind: "string" },
    { name: "owner-test-evidence-label", kind: "string" },
    { name: "seal-plan-draft", kind: "string" },
    { name: "plan-output", kind: "string" },
  ]);

  assertExactAcknowledgement(requireString(flags, "acknowledge-trusted-local-code"));

  const entryPath = assertRegularFile(requireString(flags, "adapter-entry"), "adapter entry");
  const manifestPath = assertRegularFile(requireString(flags, "manifest"), "adapter manifest");
  const manifestBytes = readBounded(manifestPath, "adapter manifest");
  const manifest = assertContract<SubjectAdapterManifestV2>(
    "SubjectAdapterManifestV2",
    parseDocument(manifestBytes, "adapter manifest"),
  );
  const manifestFileHash = hashBytes(manifestBytes);
  const manifestCoreHash = coreHash(manifest);
  if (manifestCoreHash !== manifest.core_hash) {
    throw new Erl2Error(CODES.ARTIFACT_HASH_MISMATCH, "the adapter manifest's core hash is stale");
  }
  const artifactHash = hashBytes(readFileSync(entryPath));

  const acknowledgedAt = new SystemClock().now();
  const base = {
    schema_version: "trusted-local-adapter-declaration/v1" as const,
    declaration_id: requireString(flags, "declaration-id"),
    adapter_id: manifest.adapter_id,
    adapter_owner: manifest.owner,
    protocol_version: "subject-adapter/v2" as const,
    subject_execution_mode: "local_observation" as const,
    trust_mode: "trusted_local_code" as const,
    tier: "development" as const,
    adapter_artifact_hash: artifactHash,
    adapter_manifest_file_hash: manifestFileHash,
    adapter_manifest_core_hash: manifestCoreHash,
    adapter_source: readSource(flags),
    operator_acknowledgement: {
      acknowledgement_token: TRUSTED_LOCAL_ACKNOWLEDGEMENT_TOKEN,
      acknowledged_artifact_hash: artifactHash,
      acknowledged_manifest_core_hash: manifestCoreHash,
      adapter_code_is_not_confined: true as const,
      adapter_runs_with_operator_user_permissions: true as const,
      adapter_is_not_independently_certified: true as const,
      results_are_development_only: true as const,
      results_are_unscored: true as const,
      results_are_unauthenticated: true as const,
      acknowledged_by: requireString(flags, "acknowledged-by"),
      acknowledged_at: acknowledgedAt,
    },
    independent_certifier: null,
    certifier_is_adapter_owner: "not_applicable" as const,
    owner_test_evidence: readOwnerEvidence(flags),
    excluded_claims: [...EXCLUDED_CLAIMS],
    not_scored: true as const,
    not_governor_authorized: true as const,
    not_independently_certified: true as const,
    not_confined: true as const,
    not_production_ready: true as const,
    evidence_authenticity: "owner_asserted_unauthenticated" as const,
    created_at: acknowledgedAt,
  };
  const declaration = assertContract<TrustedLocalAdapterDeclarationV1>(
    "TrustedLocalAdapterDeclarationV1",
    { ...base, core_hash: coreHash(base) },
  );

  // The declaration is admitted here, against the same bytes it names, before
  // it is written. A declaration that would be refused at run time must not
  // reach the operator's disk looking valid.
  const admission = verifyTrustedLocalAdapterDeclaration({
    manifest,
    declaration,
    entryDigest: artifactHash,
    manifestFileHash,
  });

  const declarationBytes = jsonBytes(declaration);
  const declarationPath = writeNew(
    requireString(flags, "output"),
    declarationBytes,
    "trusted-local declaration",
  );

  const sealed = sealPlanDraft(flags, declaration, manifest);

  return {
    declaration_path: declarationPath,
    declaration_core_hash: declaration.core_hash,
    declaration_file_hash: hashBytes(declarationBytes),
    adapter_id: admission.adapterId,
    adapter_owner: admission.adapterOwner,
    adapter_artifact_hash: admission.adapterArtifactHash,
    adapter_manifest_core_hash: admission.manifestHash,
    adapter_manifest_file_hash: manifestFileHash,
    trust_mode: admission.trustMode,
    tier: admission.tier,
    independent_certifier: null,
    confinement: admission.confinement,
    ...(sealed === undefined
      ? {}
      : { sealed_plan_path: sealed.planPath, sealed_plan_core_hash: sealed.coreHash }),
    trust_warning: TRUST_WARNING,
  };
}

/**
 * The ceiling, in the operator's terminal.
 *
 * Documentation that says this is not enough: an operator who never opens the
 * runbook still has to see it, and see it every time.
 */
export const TRUST_WARNING: readonly string[] = [
  "TRUST MODE trusted_local_code: these exact adapter bytes execute as a child process with your own user's permissions.",
  "The adapter is NOT sandboxed, NOT confined to a workspace, and NOT isolated from your filesystem or network.",
  "No independent party certified this adapter. There is no certifier, no signature and no review.",
  "Results are development-only: unscored, unauthenticated, not governor-authorized, and not evidence of production readiness.",
];

function assertExactAcknowledgement(supplied: string): void {
  if (supplied !== TRUSTED_LOCAL_ACKNOWLEDGEMENT_TOKEN) {
    throw new Erl2Error(
      CODES.ADAPTER_TRUSTED_LOCAL_ACKNOWLEDGEMENT_INVALID,
      "--acknowledge-trusted-local-code must be the exact acknowledgement sentence, quoted:\n" +
        TRUSTED_LOCAL_ACKNOWLEDGEMENT_TOKEN,
    );
  }
}

function readSource(
  flags: ReturnType<typeof parseFlags>,
): TrustedLocalAdapterDeclarationV1["adapter_source"] {
  const label = flags["source-repository"];
  const commit = flags["source-commit"];
  const tree = flags["source-tree"];
  if (label === undefined && commit === undefined && tree === undefined) return null;
  if (typeof label !== "string" || typeof commit !== "string" || typeof tree !== "string") {
    throw new Erl2Error(
      CODES.CFG_MISSING_REQUIRED,
      "a source coordinate needs --source-repository, --source-commit and --source-tree together",
    );
  }
  return { repository_label: label, commit, tree };
}

function readOwnerEvidence(
  flags: ReturnType<typeof parseFlags>,
): TrustedLocalAdapterDeclarationV1["owner_test_evidence"] {
  const file = flags["owner-test-evidence"];
  const label = flags["owner-test-evidence-label"];
  if (file === undefined && label === undefined) return null;
  if (typeof file !== "string" || typeof label !== "string") {
    throw new Erl2Error(
      CODES.CFG_MISSING_REQUIRED,
      "owner test evidence needs --owner-test-evidence and --owner-test-evidence-label together",
    );
  }
  const evidencePath = assertRegularFile(file, "owner test evidence");
  const bytes = readFileSync(evidencePath);
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_OWNER_EVIDENCE_BYTES) {
    throw new Erl2Error(
      CODES.ADAPTER_TRUSTED_LOCAL_RECORD_OVERSIZED,
      `owner test evidence must be between 1 and ${MAX_OWNER_EVIDENCE_BYTES} bytes`,
    );
  }
  // Only the digest and the length are retained, and both are labelled
  // owner-supplied. The Lab does not read the contents, and nothing downstream
  // may treat this as verification.
  return {
    label,
    evidence_digest: hashBytes(bytes),
    byte_length: bytes.byteLength,
    authenticity: "owner_supplied_unauthenticated",
  };
}

/**
 * The nested hashes an operator would otherwise compute by hand, in the order
 * the outer hash depends on them.
 *
 * `resource_limits` and `egress_policy` are sealed documents in their own
 * right, and the plan's `core_hash` covers them *including* their own
 * `core_hash` fields. So there is a strict order — limits, then egress, then
 * the plan — and getting it wrong produces a plan that validates and hashes to
 * a number nothing else agrees with. That is exactly the arithmetic a person
 * should not be doing with a calculator and a JSON canonicalizer, which is why
 * the draft omits all three and this command computes all three.
 */
const NESTED_PLAN_HASH_FIELDS = ["resource_limits", "egress_policy"] as const;

/**
 * Stamps a plan draft with the declaration it runs under and every hash it
 * needs.
 *
 * The draft carries everything a plan needs except the fields only this command
 * can compute. A plan whose authority binding an operator typed by hand would
 * be a plan whose binding nobody verified — and the same argument applies to a
 * nested hash, which nobody would notice was wrong until a run refused with a
 * message about a stale limits document.
 */
function sealPlanDraft(
  flags: ReturnType<typeof parseFlags>,
  declaration: TrustedLocalAdapterDeclarationV1,
  manifest: SubjectAdapterManifestV2,
): { readonly planPath: string; readonly coreHash: Hash } | undefined {
  const draftFlag = flags["seal-plan-draft"];
  const outputFlag = flags["plan-output"];
  if (draftFlag === undefined && outputFlag === undefined) return undefined;
  if (typeof draftFlag !== "string" || typeof outputFlag !== "string") {
    throw new Erl2Error(
      CODES.CFG_MISSING_REQUIRED,
      "sealing a plan needs --seal-plan-draft and --plan-output together",
    );
  }
  const draftPath = assertRegularFile(draftFlag, "plan draft");
  const draft = parseDocument(readBounded(draftPath, "plan draft"), "plan draft") as Record<
    string,
    unknown
  >;
  for (const computed of ["trusted_local_declaration_hash", "core_hash"]) {
    if (Object.hasOwn(draft, computed)) {
      throw new Erl2Error(
        CODES.SCHEMA_VALIDATION_FAILED,
        `the plan draft must not carry ${computed}; this command computes it`,
      );
    }
  }

  // A pre-carried nested hash is refused rather than overwritten. Silently
  // replacing one would mean an operator who computed it wrong — or who copied
  // it from a different plan — gets a valid plan back and never learns that the
  // number they supplied was ignored.
  const sealed: Record<string, unknown> = { ...draft };
  for (const field of NESTED_PLAN_HASH_FIELDS) {
    const nested = draft[field];
    if (nested === undefined) continue;
    if (nested === null || typeof nested !== "object" || Array.isArray(nested)) {
      throw new Erl2Error(
        CODES.SCHEMA_VALIDATION_FAILED,
        `the plan draft's ${field} must be a JSON object`,
      );
    }
    if (Object.hasOwn(nested, "core_hash")) {
      throw new Erl2Error(
        CODES.SCHEMA_VALIDATION_FAILED,
        `the plan draft must not carry ${field}.core_hash; this command computes it`,
      );
    }
    sealed[field] = { ...(nested as Record<string, unknown>), core_hash: coreHash(nested) };
  }

  const planBase = {
    ...sealed,
    trust_mode: "trusted_local_code" as const,
    adapter_id: manifest.adapter_id,
    adapter_version: manifest.version,
    adapter_manifest_hash: declaration.adapter_manifest_core_hash,
    adapter_artifact_hash: declaration.adapter_artifact_hash,
    trusted_local_declaration_hash: declaration.core_hash,
  };
  // Closed-schema validation last, over the completed plan: a draft that is
  // missing a field or carries an unknown one is refused here, and nothing
  // partially sealed reaches disk.
  const plan = assertContract<LocalObservationTrustedLocalPlanV1>(
    "LocalObservationTrustedLocalPlanV1",
    { ...planBase, core_hash: coreHash(planBase) },
  );
  const planBytes = jsonBytes(plan);
  const planPath = writeNew(outputFlag, planBytes, "sealed observation plan");
  return { planPath, coreHash: plan.core_hash };
}

/**
 * Writes bytes to a path that must not already exist, atomically.
 *
 * `existsSync` is not the guard, because it answers false for a dangling
 * symlink and a previous version replaced one silently. The write goes to a
 * sibling temporary and is renamed, and the temporary is created exclusively
 * so a predictable name cannot be pre-created by someone else.
 */
function writeNew(candidate: string, bytes: Buffer, label: string): string {
  const absolute = path.resolve(candidate);
  let exists = true;
  try {
    // `lstat` semantics: a dangling symlink at this path is an existing entry
    // and must be refused rather than followed or replaced.
    assertRegularFile(absolute, label);
  } catch (cause) {
    if (cause instanceof Erl2Error && cause.code === CODES.CFG_MISSING_REQUIRED) exists = false;
    else throw cause;
  }
  if (exists) {
    throw new Erl2Error(
      CODES.ADMISSION_RETENTION_FAILED,
      `${label} output already exists and will not be overwritten: ${absolute}`,
    );
  }
  const staging = `${absolute}.${String(process.pid)}.partial`;
  try {
    writeFileSync(staging, bytes, { mode: 0o600, flag: "wx" });
    renameSync(staging, absolute);
  } catch (cause) {
    try {
      unlinkSync(staging);
    } catch {
      /* the staging file may never have been created */
    }
    if (cause instanceof Erl2Error) throw cause;
    throw new Erl2Error(
      CODES.ADMISSION_RETENTION_FAILED,
      `${label} could not be written to ${absolute}`,
      { cause },
    );
  }
  return absolute;
}

function readBounded(absolute: string, label: string): Buffer {
  const bytes = readFileSync(absolute);
  if (bytes.byteLength > MAX_TRUSTED_LOCAL_DOCUMENT_BYTES) {
    throw new Erl2Error(
      CODES.ADAPTER_TRUSTED_LOCAL_RECORD_OVERSIZED,
      `${label} is ${bytes.byteLength} bytes, above the ${MAX_TRUSTED_LOCAL_DOCUMENT_BYTES}-byte ceiling`,
    );
  }
  return bytes;
}

export function parseDocument(bytes: Buffer, label: string): unknown {
  let value: unknown;
  try {
    value = parseStrictJson(bytes.toString("utf8"));
  } catch (cause) {
    if (cause instanceof Erl2Error) throw cause;
    throw new Erl2Error(CODES.SCHEMA_VALIDATION_FAILED, `${label} is not valid JSON`, { cause });
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Erl2Error(CODES.SCHEMA_VALIDATION_FAILED, `${label} must be a JSON object`);
  }
  return value;
}

export function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export { writeNew as writeNewFile, readBounded as readBoundedFile };

/** Re-exported so the runner refuses missing files with the same message. */
export function requireExisting(candidate: string, label: string): string {
  if (!existsSync(path.resolve(candidate))) {
    throw new Erl2Error(CODES.CFG_MISSING_REQUIRED, `${label} not found: ${candidate}`);
  }
  return path.resolve(candidate);
}
