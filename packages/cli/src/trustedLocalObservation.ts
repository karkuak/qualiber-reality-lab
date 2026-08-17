/**
 * `erl2 run-trusted-local-observation` — one bounded, unscored, owner-operated
 * local run of an external `subject-adapter/v2` adapter.
 *
 * ## What it is for
 *
 * Every governed journey the Lab offers runs through `preregister-acquisition`,
 * which needs eight governor-prepared hashes with no public producer. A
 * development-tier observation needs none of them, and ADR-ERL2-037 built the
 * path that says so — but nothing public reached it, so the only way to drive
 * `LocalObservationCoordinator` was from a test.
 *
 * This command is that path. It requests no acquisition source, no verified
 * package, no selected challenge, no governor registry and no certification
 * receipt, and there is no flag through which one could be supplied.
 *
 * ## What it provisions
 *
 * Every input the plan declares `host_provisioned` is bound by the operator
 * with a repeatable `--bind-input <input_id>=<absolute-source-path>`, copied
 * beneath the output root, checked against the digest and length the plan
 * declares, and exposed to the adapter as a read-only mount. The binding set
 * must be exact: a missing binding, a duplicate, an unknown id or an extra one
 * is a refusal, because an operator who thinks they supplied a file the run
 * never used has been told nothing by the run succeeding.
 *
 * ## What it is not
 *
 * It is not certification, not assurance, not sandboxed execution, not scoring,
 * not governor authorization and not evidence of production readiness. The
 * adapter runs as a child process with the operator's own permissions, under
 * the declaration they wrote. The retained record says all of that in its own
 * bytes, and the terminal summary says it again.
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  CODES,
  Erl2Error,
  assertContract,
  type AdapterRequestPredecessorV2,
  type AdapterRequestV2,
  type LocalObservationTrustedLocalPlanV1,
  type TrustedLocalObservationRecordV1,
  type TrustedLocalOperationOutcomeV1,
} from "./contractsFacade.js";
import { ArtifactStore, coreHash, hashBytes } from "@erl2/integrity";
import {
  AdapterHost,
  LocalObservationCoordinator,
  SystemClock,
  assertBoundSource,
  assertRegularDirectory,
  assertRegularFile,
  materializeTrustedLocalInputs,
  resolveTrustedLocalAdapterV2,
  retainTrustedLocalAdapterV2,
  verifyTrustedLocalObservationRecord,
  type AdapterMount,
  type TrustedLocalInputBinding,
} from "@erl2/core";
import { parseFlags, requireString } from "./args.js";
import {
  TRUST_WARNING,
  jsonBytes,
  parseDocument,
  readBoundedFile,
} from "./trustedLocalDeclaration.js";

/**
 * Governed inputs this command must never accept.
 *
 * Named individually rather than pattern-matched, so the refusal tells the
 * operator which governed concept they reached for and the list is auditable
 * against the governed command surface.
 */
const FORBIDDEN_FLAGS = [
  "acquisition-source",
  "acquisition-actor-script",
  "acquisition-actor-schema",
  "acquisition-step",
  "package-verification-step",
  "generic-policy",
  "trust-policy",
  "limits",
  "registry-governor",
  "verified-package",
  "selected-challenge",
  "certification-receipt",
  "receipt",
  "certifier",
  "tier",
] as const;

export const RECORD_FILE = "trusted-local-observation-record.json";
export const RETAINED_PLAN_FILE = "observation-plan.json";

export interface RunTrustedLocalObservationOutput {
  readonly observation_id: string;
  readonly subject_execution_mode: "local_observation";
  readonly protocol_version: "subject-adapter/v2";
  readonly trust_mode: "trusted_local_code";
  readonly tier: "development";
  readonly adapter_id: string;
  readonly adapter_version: string;
  readonly adapter_artifact_hash: string;
  readonly adapter_manifest_hash: string;
  readonly trusted_local_declaration_hash: string;
  readonly admission_authority: "trusted_local_code";
  readonly admission_logical_path: string;
  readonly plan_hash: string;
  readonly operations: readonly TrustedLocalOperationOutcomeV1[];
  readonly cleanup: TrustedLocalObservationRecordV1["cleanup"];
  readonly residue: TrustedLocalObservationRecordV1["residue_observations"];
  readonly terminal_status: string;
  readonly record_path: string;
  readonly record_file_hash: string;
  readonly retained_plan_path: string;
  /**
   * Where the run copied its host-provisioned inputs.
   *
   * In the summary and not in the record: offline verification needs the path
   * to re-hash the tree, and an operator who did not keep this line can still
   * derive it — it is `inputs/` beneath the output root they chose. It stays
   * out of the record's core because an absolute path on one machine is not
   * portable evidence, and a reader elsewhere could only mistake it for one.
   */
  readonly retained_input_root: string;
  readonly retained_inputs: readonly {
    readonly input_id: string;
    readonly mount_id: string;
    readonly relative_path: string;
    readonly byte_length: number;
    readonly file_sha256: string;
  }[];
  readonly input_mounts: readonly {
    readonly mount_id: string;
    readonly logical_path: string;
    readonly mode: "read_only";
    readonly purpose: "subject-visible-input";
  }[];
  readonly offline_verification: { readonly ok: boolean; readonly refusals: readonly string[] };
  readonly independent_certification: "absent";
  readonly confinement: "absent";
  readonly not_scored: true;
  readonly not_governor_authorized: true;
  readonly not_authenticated: true;
  readonly not_production_ready: true;
  readonly evidence_authenticity: "unauthenticated_local_record";
  readonly excluded_claims: readonly string[];
  readonly operator_acknowledgement: TrustedLocalObservationRecordV1["trusted_local_declaration"]["operator_acknowledgement"];
  readonly trust_warning: readonly string[];
}

export function runTrustedLocalObservation(
  argv: readonly string[],
): RunTrustedLocalObservationOutput {
  assertNoGovernedFlags(argv);
  const flags = parseFlags(argv, [
    { name: "adapter-entry", kind: "string", required: true },
    { name: "manifest", kind: "string", required: true },
    { name: "plan", kind: "string", required: true },
    { name: "owner-declaration", kind: "string", required: true },
    { name: "output-root", kind: "string", required: true },
    // Repeatable: one per host-provisioned plan input, and the set must be
    // exact. The parser already accumulates a string list, so repetition is
    // the flag's own semantics rather than something this command re-invents.
    { name: "bind-input", kind: "string-list" },
  ]);

  const entryPath = assertRegularFile(requireString(flags, "adapter-entry"), "adapter entry");
  const manifestPath = assertRegularFile(requireString(flags, "manifest"), "adapter manifest");
  const declarationPath = assertRegularFile(
    requireString(flags, "owner-declaration"),
    "trusted-local declaration",
  );
  const planPath = assertRegularFile(requireString(flags, "plan"), "observation plan");

  const manifestBytes = readBoundedFile(manifestPath, "adapter manifest");
  const declarationBytes = readBoundedFile(declarationPath, "trusted-local declaration");
  const planBytes = readBoundedFile(planPath, "observation plan");

  // The plan is parsed and contract-validated before anything is created on
  // disk, so a malformed plan cannot leave an output tree behind.
  const plan = assertContract<LocalObservationTrustedLocalPlanV1>(
    "LocalObservationTrustedLocalPlanV1",
    parseDocument(planBytes, "observation plan"),
  );

  const outputRoot = assertRegularDirectory(requireString(flags, "output-root"), "output root");

  // Every binding is split, made absolute and proved to be a regular
  // non-symlink file outside the output tree *before* the output root is
  // created, so a malformed or unreachable binding leaves nothing behind.
  const bindings = parseBindings(flags["bind-input"], outputRoot);

  mkdirSync(outputRoot, { recursive: true, mode: 0o700 });

  // ---- the bound bytes, before admission and before any host --------------
  // A digest or length mismatch has to refuse here: after this point the
  // admission bytes are durable and a run record becomes possible, and a run
  // that retained evidence of an input it then rejected would be evidence of
  // something that never happened.
  const materialized = materializeTrustedLocalInputs({ plan, bindings, outputRoot });

  const registryRoot = path.join(outputRoot, "registry");

  // ---- durable admission, before any host exists --------------------------
  const retained = retainTrustedLocalAdapterV2({
    registryRoot,
    manifestBytes,
    declarationBytes,
    adapterEntryPath: entryPath,
  });

  // Re-derive authority from the retained bytes and re-hash the entry, so bytes
  // swapped between admission and host construction are refused before a host
  // exists — and again by the host before every dispatch.
  const resolved = resolveTrustedLocalAdapterV2({
    registryRoot,
    manifestCoreHash: retained.manifestCoreHash,
    adapterEntryPath: entryPath,
  });

  const clock = new SystemClock();
  const host = buildHost(plan, resolved, entryPath, outputRoot, clock, materialized.mounts);
  const coordinator = new LocalObservationCoordinator(plan);
  if (host.localAuthorityModeV2 !== "trusted_local_code") {
    throw new Erl2Error(
      CODES.ADAPTER_TRUSTED_LOCAL_AUTHORITY_MISMATCH,
      "the host did not resolve trusted-local authority for this run",
    );
  }

  const startedAt = clock.now();
  const outcomes = executePlan(coordinator, host, plan, clock);
  const result = coordinator.buildResult(startedAt, clock.now());
  if (!("trusted_local_declaration_hash" in result)) {
    throw new Erl2Error(
      CODES.ADAPTER_TRUSTED_LOCAL_AUTHORITY_MISMATCH,
      "the coordinator produced a certified result for a trusted-local plan",
    );
  }

  const residue = coordinator.operationRecords
    .filter(
      (record): record is Extract<typeof record, { readonly state: "completed" }> =>
        record.state === "completed",
    )
    .map((record) => record.residue_observation)
    .filter((observation): observation is NonNullable<typeof observation> => observation !== undefined);

  const recordBase = {
    schema_version: "trusted-local-observation-record/v1" as const,
    observation_id: result.observation_id,
    subject_execution_mode: "local_observation" as const,
    protocol_version: "subject-adapter/v2" as const,
    trust_mode: "trusted_local_code" as const,
    tier: "development" as const,
    plan_hash: plan.core_hash,
    plan_file_hash: hashBytes(planBytes),
    adapter_id: resolved.admission.adapterId,
    adapter_version: resolved.admission.adapterVersion,
    adapter_artifact_hash: resolved.admission.adapterArtifactHash,
    adapter_manifest_hash: resolved.admission.manifestHash,
    adapter_manifest_file_hash: resolved.manifestFileHash,
    trusted_local_declaration: resolved.declaration,
    trusted_local_declaration_hash: resolved.admission.declarationHash,
    trusted_local_declaration_file_hash: resolved.declarationFileHash,
    admission_logical_path: retained.logicalPath,
    host_sandbox_profile: "local-process" as const,
    // The host's own control states, verbatim — including the thirteen it
    // reports as unsupported. Copying only the enforced ones would turn an
    // honest report into a confinement claim.
    host_control_report: [...resolved.admission.hostControlReport],
    operation_outcomes: outcomes,
    operation_records: [...coordinator.operationRecords],
    residue_observations: residue,
    result,
    cleanup: result.cleanup,
    terminal_status: result.status,
    independent_certification: "absent" as const,
    confinement: "absent" as const,
    not_scored: true as const,
    not_governor_authorized: true as const,
    not_authenticated: true as const,
    not_production_ready: true as const,
    evidence_authenticity: "unauthenticated_local_record" as const,
    excluded_claims: [...plan.unsupported_claims],
  };
  const record = assertContract<TrustedLocalObservationRecordV1>(
    "TrustedLocalObservationRecordV1",
    { ...recordBase, core_hash: coreHash(recordBase) },
  );

  const recordBytes = jsonBytes(record);
  const recordPath = writeOnce(path.join(outputRoot, RECORD_FILE), recordBytes, "run record");
  // The exact plan bytes travel with the record, because offline verification
  // has no meaning without them and an operator should not have to keep the
  // input alive separately to check their own evidence later.
  const retainedPlanPath = writeOnce(
    path.join(outputRoot, RETAINED_PLAN_FILE),
    planBytes,
    "retained plan",
  );

  const verification = verifyTrustedLocalObservationRecord({
    recordBytes: readFileSync(recordPath),
    planBytes: readFileSync(retainedPlanPath),
    registryRoot,
    adapterEntryPath: entryPath,
    retainedInputRoot: materialized.retainedInputRoot,
  });

  const output: RunTrustedLocalObservationOutput = {
    observation_id: record.observation_id,
    subject_execution_mode: "local_observation",
    protocol_version: "subject-adapter/v2",
    trust_mode: "trusted_local_code",
    tier: "development",
    adapter_id: record.adapter_id,
    adapter_version: record.adapter_version,
    adapter_artifact_hash: record.adapter_artifact_hash,
    adapter_manifest_hash: record.adapter_manifest_hash,
    trusted_local_declaration_hash: record.trusted_local_declaration_hash,
    admission_authority: "trusted_local_code",
    admission_logical_path: record.admission_logical_path,
    plan_hash: record.plan_hash,
    operations: record.operation_outcomes,
    cleanup: record.cleanup,
    residue: record.residue_observations,
    terminal_status: record.terminal_status,
    record_path: recordPath,
    record_file_hash: hashBytes(recordBytes),
    retained_plan_path: retainedPlanPath,
    retained_input_root: materialized.retainedInputRoot,
    retained_inputs: materialized.files.map((file) => ({
      input_id: file.inputId,
      mount_id: file.mountId,
      relative_path: file.relativePath,
      byte_length: file.byteLength,
      file_sha256: file.fileSha256,
    })),
    input_mounts: materialized.mounts.map((mount) => ({
      mount_id: mount.mountId,
      logical_path: mount.logicalPath,
      mode: "read_only" as const,
      purpose: mount.purpose,
    })),
    offline_verification: { ok: verification.ok, refusals: verification.refusals },
    independent_certification: "absent",
    confinement: "absent",
    not_scored: true,
    not_governor_authorized: true,
    not_authenticated: true,
    not_production_ready: true,
    evidence_authenticity: "unauthenticated_local_record",
    excluded_claims: [...record.excluded_claims],
    operator_acknowledgement: record.trusted_local_declaration.operator_acknowledgement,
    trust_warning: TRUST_WARNING,
  };

  if (!verification.ok) {
    throw new Erl2Error(
      CODES.ADAPTER_TRUSTED_LOCAL_RECORD_INVALID,
      `the retained observation did not verify offline: ${verification.refusals.join("; ")}`,
    );
  }
  if (
    record.terminal_status !== "observed_complete" ||
    outcomes.some((outcome) => outcome.state !== "completed")
  ) {
    throw new Erl2Error(
      CODES.ADAPTER_LOCAL_CLEANUP_INCOMPLETE,
      `the observation did not complete cleanly (status ${record.terminal_status}); ` +
        `the record is retained at ${recordPath}`,
    );
  }
  return output;
}

/**
 * Splits every `--bind-input <input_id>=<absolute-source-path>` value.
 *
 * Only the *shape* is decided here — that there is one `=`, that both halves
 * are non-empty, that the path is absolute, and that it names a regular
 * non-symlink file outside the output tree. Whether the set of bindings matches
 * the plan is not this function's question: that comparison belongs with the
 * plan and lives in the materializer, so one implementation answers it for the
 * CLI and for anything else that ever calls in.
 */
function parseBindings(
  raw: string | boolean | readonly string[] | undefined,
  outputRoot: string,
): readonly TrustedLocalInputBinding[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new Erl2Error(
      CODES.CFG_MISSING_REQUIRED,
      "--bind-input takes <input_id>=<absolute-source-path>",
    );
  }
  return (raw as readonly string[]).map((value) => {
    const separator = value.indexOf("=");
    const inputId = separator < 0 ? "" : value.slice(0, separator);
    const source = separator < 0 ? "" : value.slice(separator + 1);
    if (separator < 0 || inputId === "" || source === "") {
      throw new Erl2Error(
        CODES.CFG_MISSING_REQUIRED,
        `--bind-input ${value} is malformed; the value is <input_id>=<absolute-source-path>`,
      );
    }
    return { inputId, sourcePath: assertBoundSource(source, inputId, outputRoot) };
  });
}

/** Refuses a governed input by name, before any flag is parsed. */
function assertNoGovernedFlags(argv: readonly string[]): void {
  for (const forbidden of FORBIDDEN_FLAGS) {
    if (argv.includes(`--${forbidden}`)) {
      throw new Erl2Error(
        CODES.ADAPTER_LOCAL_CONTEXT_FORBIDDEN,
        `--${forbidden} belongs to a governed or certified path; trusted-local observation accepts none`,
      );
    }
  }
}

function buildHost(
  plan: LocalObservationTrustedLocalPlanV1,
  resolved: ReturnType<typeof resolveTrustedLocalAdapterV2>,
  entryPath: string,
  outputRoot: string,
  clock: SystemClock,
  mounts: readonly AdapterMount[],
): AdapterHost {
  const workspaceRoot = path.join(outputRoot, "workspace");
  const storeRoot = path.join(outputRoot, "store");
  mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 });
  mkdirSync(storeRoot, { recursive: true, mode: 0o700 });
  return new AdapterHost({
    runId: plan.observation_id,
    adapterManifest: resolved.manifest,
    localAuthorityV2: { mode: "trusted_local_code", declaration: resolved.declaration },
    localObservationPlan: plan,
    adapterEntryPath: entryPath,
    workspaceRoot,
    store: new ArtifactStore(storeRoot),
    // Read-only by construction: the host fingerprints every mount before the
    // adapter sees it and refuses the run if the tree changed, and the retained
    // files are mode 0400 beneath owner-only directories.
    mounts,
    clock,
    wallClockMs: plan.resource_limits.wall_clock_ms,
    maxRequestBytes: plan.resource_limits.max_request_bytes,
    maxResponseBytes: plan.resource_limits.max_response_bytes,
  });
}

/**
 * Runs the plan in order, chaining each request to the operation before it.
 *
 * The predecessor comes from the coordinator, which derives it from the record
 * it retained. The runner never assembles a link of its own, so it cannot
 * offer one the coordinator would reject — the defect that made every second
 * operation refuse.
 */
function executePlan(
  coordinator: LocalObservationCoordinator,
  host: AdapterHost,
  plan: LocalObservationTrustedLocalPlanV1,
  clock: SystemClock,
): readonly TrustedLocalOperationOutcomeV1[] {
  const outcomes: TrustedLocalOperationOutcomeV1[] = [];
  // Set by the first main-sequence operation that does not complete. After
  // that only the frozen cleanup suffix runs — the same rule the coordinator
  // enforces, applied here so the runner does not dispatch operations it knows
  // will be refused and then report them as faults.
  let mainSequenceStopped = false;
  try {
    for (const spec of plan.operations) {
      if (mainSequenceStopped && !spec.cleanup) continue;
      const predecessor = coordinator.nextPredecessor();
      const record = coordinator.execute(
        host,
        buildRequest(plan, spec, predecessor),
        clock.now(),
        () => clock.now(),
      );
      outcomes.push(outcomeOf(spec, record, predecessor));
      if (record.state !== "completed" && !spec.cleanup) mainSequenceStopped = true;
    }
  } finally {
    // Bounded cleanup is always attempted: the output freeze is what stops any
    // further adapter dispatch, and it must happen whether the loop finished or
    // threw.
    try {
      coordinator.freezeOutput(host);
    } catch {
      /* the freeze is best-effort; the record below reports what was observed */
    }
  }
  return outcomes;
}

function outcomeOf(
  spec: LocalObservationTrustedLocalPlanV1["operations"][number],
  record: ReturnType<LocalObservationCoordinator["execute"]>,
  predecessor: AdapterRequestPredecessorV2 | null,
): TrustedLocalOperationOutcomeV1 {
  return {
    sequence: spec.sequence,
    operation_id: spec.operation_id,
    operation: spec.operation,
    state: record.state,
    request_hash: record.request_hash,
    operation_record_hash: record.core_hash,
    ...(record.state === "completed"
      ? {
          response_envelope_hash: record.response_envelope_hash,
          response_status: record.response_status,
        }
      : {}),
    ...(predecessor === null
      ? {}
      : {
          predecessor_operation_id: predecessor.operation_id,
          predecessor_operation_record_hash: predecessor.operation_record_hash,
        }),
  };
}

/**
 * One request per planned operation, built from the plan and nothing else.
 *
 * The plan is frozen and the host re-checks every field of this request against
 * it, so there is deliberately no way for a caller to widen limits, grants or
 * policy between planning and dispatch.
 */
function buildRequest(
  plan: LocalObservationTrustedLocalPlanV1,
  spec: LocalObservationTrustedLocalPlanV1["operations"][number],
  predecessor: AdapterRequestPredecessorV2 | null,
): AdapterRequestV2 {
  // Second precision: the contract's instant pattern admits no milliseconds.
  const deadline = new Date(Date.parse(plan.created_at) + spec.timeout_ms)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");
  const base = {
    schema_version: "adapter-request/v2" as const,
    protocol_version: "subject-adapter/v2" as const,
    execution_id: plan.observation_id,
    adapter_manifest_hash: plan.adapter_manifest_hash,
    operation_id: spec.operation_id,
    operation: spec.operation,
    ancestry: { sequence: spec.sequence, predecessor },
    deadline,
    diagnostics_policy: {
      max_total_bytes: plan.resource_limits.max_diagnostic_bytes,
      max_line_bytes: plan.resource_limits.max_diagnostic_line_bytes,
      redact_secrets: true as const,
      scan_forbidden_identifiers: true as const,
    },
    execution_context: {
      mode: "local_observation" as const,
      observation_plan_hash: plan.core_hash,
      resource_limits: plan.resource_limits,
      input_artifact_refs: [...plan.inputs],
      egress_policy: plan.egress_policy,
      allowed_capability_ids: [...plan.allowed_capability_ids],
      allowed_credential_handle_ids: [...plan.allowed_credential_handle_ids],
      not_scored: true as const,
      not_governor_authorized: true as const,
      unsupported_claims: [...plan.unsupported_claims],
    },
    operation_payload: spec.payload,
  };
  return assertContract<AdapterRequestV2>("AdapterRequestV2", {
    ...base,
    core_hash: coreHash(base),
  });
}

/** Writes a retained file that must not already exist, atomically. */
function writeOnce(absolute: string, bytes: Buffer, label: string): string {
  const staging = `${absolute}.${String(process.pid)}.partial`;
  try {
    writeFileSync(staging, bytes, { mode: 0o600, flag: "wx" });
  } catch (cause) {
    throw new Erl2Error(
      CODES.ADMISSION_RETENTION_FAILED,
      `${label} staging file could not be created at ${staging}`,
      { cause },
    );
  }
  try {
    // `wx` on the staging file, then a rename onto a destination that must not
    // exist. Checked with `link`-free semantics: an existing destination is a
    // refusal rather than a silent overwrite of somebody else's evidence.
    assertAbsent(absolute, label);
    renameSync(staging, absolute);
  } catch (cause) {
    try {
      unlinkSync(staging);
    } catch {
      /* nothing to clean up */
    }
    if (cause instanceof Erl2Error) throw cause;
    throw new Erl2Error(CODES.ADMISSION_RETENTION_FAILED, `${label} could not be written`, {
      cause,
    });
  }
  return absolute;
}

function assertAbsent(absolute: string, label: string): void {
  try {
    assertRegularFile(absolute, label);
  } catch (cause) {
    if (cause instanceof Erl2Error && cause.code === CODES.CFG_MISSING_REQUIRED) return;
    throw cause;
  }
  throw new Erl2Error(
    CODES.ADMISSION_RETENTION_FAILED,
    `${label} already exists and will not be overwritten: ${absolute}`,
  );
}
