/**
 * `erl2` — the Lab orchestration CLI.
 *
 * Slice 2 exposes the read-only vertical slice named by the implementation plan
 * (§8.5): `doctor`, `status`, `resume`, `verify` and `verify-record`.  Journey
 * commands arrive with their slices; a command that is not implemented refuses
 * with a stable code rather than pretending to succeed.
 *
 * No development-only shortcut is reachable from this surface.
 */

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import {
  ADAPTER_PROTOCOL_VERSION,
  CODES,
  Erl2Error,
  parseStrictJson,
  registeredContractCount,
  type Hash,
  type LabLifecycleEventV1,
} from "./contractsFacade.js";
import { verifyInvalidRecord, verifyPublicBundle } from "@erl2/public-verifier";
import { ArtifactStore, registeredDomains, type LocalTrustConfiguration } from "@erl2/integrity";
import {
  CONTAINER_PROFILE_STATE,
  EVALUATOR_RELEASE,
  GENERIC_METRIC_DEFINITIONS,
  LAB_STATES,
  LifecycleLog,
  PRIVILEGED_CAPABILITIES,
  REQUIRED_ISOLATION_CONTROLS,
  RunLease,
  SystemClock,
  enforcedControls,
  unsupportedControls,
} from "@erl2/core";
import { parseFlags, requireString, type ParsedFlags } from "./args.js";
import { ISOLATION_EVIDENCE_DIR, isolationStatus } from "./isolationStatus.js";
import {
  acquire,
  cancel,
  evaluate,
  finalizeGeneric,
  freezeOutput,
  freezePackage,
  preregisterAcquisition,
  preregisterChallenge,
  reveal,
  select,
  verifyPackage,
  type JourneyCommandOutput,
} from "./journeyCommands.js";
import { AUTHORITY_SCOPE, EXIT, exitForCode } from "./exits.js";

export interface CommandResult {
  readonly schema_version: "erl2-cli-response/v1";
  readonly command: string;
  readonly ok: boolean;
  readonly exit_code: number;
  readonly authority_scope: typeof AUTHORITY_SCOPE;
  readonly run_id?: string;
  readonly state?: string;
  readonly record_hash?: Hash;
  readonly findings: readonly string[];
  readonly errors: readonly { readonly code: string; readonly message: string }[];
  readonly data?: unknown;
}

function ok(command: string, extra: Partial<CommandResult> = {}): CommandResult {
  return {
    schema_version: "erl2-cli-response/v1",
    command,
    ok: true,
    exit_code: EXIT.COMPLETED,
    authority_scope: AUTHORITY_SCOPE,
    findings: [],
    errors: [],
    ...extra,
  };
}

function fail(command: string, error: Erl2Error): CommandResult {
  return {
    schema_version: "erl2-cli-response/v1",
    command,
    ok: false,
    exit_code: exitForCode(error.code),
    authority_scope: AUTHORITY_SCOPE,
    findings: [],
    errors: [{ code: error.code, message: error.message.slice(0, 1024) }],
  };
}

/**
 * Reads a caller-supplied JSON document as a *typed* refusal on every failure
 * mode.  `readFileSync` and `JSON.parse` throw plain `Error`/`SyntaxError`,
 * which the top level used to rethrow — a missing or malformed `--public-bundle`,
 * `--record` or `--root-config` escaped as a raw stack trace with exit 1 and no
 * code, defeating the Appendix B/C guarantee that every outcome is a coded,
 * Lab-owned envelope.
 */
function loadJsonDocument(documentPath: string, label: string): unknown {
  const absolute = path.resolve(documentPath);
  if (!existsSync(absolute)) {
    throw new Erl2Error(CODES.CFG_MISSING_REQUIRED, `${label} not found: ${documentPath}`);
  }
  let text: string;
  try {
    text = readFileSync(absolute, "utf8");
  } catch (error) {
    throw new Erl2Error(CODES.CFG_MISSING_REQUIRED, `${label} could not be read: ${documentPath}`, {
      cause: error,
    });
  }
  try {
    return parseStrictJson(text);
  } catch (error) {
    if (error instanceof Erl2Error) throw error;
    throw new Erl2Error(CODES.SCHEMA_VALIDATION_FAILED, `${label} is not a valid JSON document`, {
      cause: error,
    });
  }
}

/** Verifier-controlled local trust configuration, loaded only from `--root-config`. */
function loadLocalTrust(configPath: string): LocalTrustConfiguration {
  const value = loadJsonDocument(configPath, "trust configuration") as Partial<LocalTrustConfiguration>;
  if (
    !Array.isArray(value.rootKeyIds) ||
    typeof value.currentTrustHeadHash !== "string" ||
    !Array.isArray(value.randomnessSources) ||
    typeof value.randomnessRegistryHeadHash !== "string"
  ) {
    throw new Erl2Error(CODES.CFG_MISSING_REQUIRED, "trust configuration is incomplete");
  }
  return value as LocalTrustConfiguration;
}

function loadLifecycle(streamPath: string): readonly LabLifecycleEventV1[] {
  const value = loadJsonDocument(streamPath, "lifecycle stream");
  if (!Array.isArray(value)) {
    throw new Erl2Error(CODES.VERIFY_RECORD_LIFECYCLE_GAP, "lifecycle stream must be a JSON array");
  }
  return value as LabLifecycleEventV1[];
}

const IMPLEMENTED_COMMANDS = new Set([
  "doctor",
  "status",
  "resume",
  "verify",
  "verify-record",
  "preregister-acquisition",
  "preregister-challenge",
  "select",
  "acquire",
  "freeze-package",
  "verify-package",
  "freeze-output",
  "reveal",
  "evaluate",
  "finalize-generic",
  "cancel",
]);

/** Journey, evaluation and finalization commands, keyed by their CLI name. */
const JOURNEY_COMMANDS: Readonly<Record<string, (argv: readonly string[]) => JourneyCommandOutput>> = {
  "preregister-acquisition": preregisterAcquisition,
  "preregister-challenge": preregisterChallenge,
  select,
  acquire,
  "freeze-package": freezePackage,
  "verify-package": verifyPackage,
  "freeze-output": freezeOutput,
  reveal,
  evaluate,
  "finalize-generic": finalizeGeneric,
  cancel,
};

/**
 * Commands the design defines but whose slice has not shipped.  They refuse
 * with a stable code so a caller can never mistake absence for success.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const PLANNED_COMMANDS = new Set([
  "commit-deep",
  "provision",
  "baseline",
  "plan",
  "install",
  "configure",
  "authenticate",
  "connect",
  "activate",
  "journey",
  "observe",
  "freeze-observation",
  "execute-subject",
  "recover",
  "rollback",
  "remove",
  "restore",
  "destroy",
  "evaluate-deep",
  "finalize-deep",
  "verify-customer",
]);

/** Bare flag lookup used only to key the run lease; full parsing happens in the command. */
function flagValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : undefined;
}

/**
 * Wraps a mutating journey command in the durable run lease so a concurrent or
 * replayed command on the same run is refused (Lab-owned) before it can mutate
 * (review P1-2 §7.2).  Commands that allocate a fresh run (`preregister`, which
 * carries no `--run`) need no lease — each creates its own run.
 */
function withRunLease<T>(command: string, argv: readonly string[], fn: () => T): T {
  const runId = flagValue(argv, "run");
  const runRoot = flagValue(argv, "run-root");
  if (runId === undefined || runRoot === undefined) return fn();
  const owner = `pid-${String(process.pid)}`;
  const lease = RunLease.acquire(runRoot, owner, command, Date.now());
  try {
    return fn();
  } finally {
    lease.release();
  }
}

export function runCommand(argv: readonly string[]): CommandResult {
  const command = argv[0];
  if (command === undefined || command === "--help" || command === "help") {
    return ok("help", { data: { commands: [...IMPLEMENTED_COMMANDS].sort() } });
  }
  const rest = argv.slice(1);
  try {
    switch (command) {
      case "doctor":
        return doctor(rest);
      case "status":
        return status(rest);
      case "resume":
        return resume(rest);
      case "verify":
        return verify(rest);
      case "verify-record":
        return verifyRecord(rest);
      default: {
        const journey = JOURNEY_COMMANDS[command];
        if (journey) {
          const output = withRunLease(command, rest, () => journey(rest));
          if (output.terminalError !== undefined) {
            // The run reached a terminal, so its record hashes are returned;
            // the exit code still names the failure that caused it.
            return {
              ...fail(command, output.terminalError),
              run_id: output.runId,
              state: output.state,
              data: output.data,
            };
          }
          return ok(command, { run_id: output.runId, state: output.state, data: output.data });
        }
        if (PLANNED_COMMANDS.has(command)) {
          throw new Erl2Error(
            "POLICY_COMMAND_NOT_IMPLEMENTED",
            `command ${command} belongs to a slice that has not shipped; it is not silently skipped`,
          );
        }
        throw new Erl2Error(CODES.CFG_UNKNOWN_FLAG, `unknown command ${command}`);
      }
    }
  } catch (error) {
    if (error instanceof Erl2Error) return fail(command, error);
    // Backstop: no command may terminate with an untyped exception.  An escaped
    // throwable is by definition a Lab-owned failure, never a subject or adapter
    // outcome, and is reported as a coded envelope with the Lab authority scope
    // (design Appendix B/C, §20 failure ownership).
    return fail(
      command,
      new Erl2Error(
        CODES.LAB_UNEXPECTED_FAILURE,
        `unexpected Lab failure while running ${command}: ${
          error instanceof Error ? error.message.slice(0, 512) : "non-error throwable"
        }`,
        { owner: "lab", cause: error },
      ),
    );
  }
}

function doctor(argv: readonly string[]): CommandResult {
  const flags: ParsedFlags = parseFlags(argv, [
    { name: "profile", kind: "string" },
    { name: "isolation-evidence", kind: "string" },
  ]);
  // The isolation section is *derived* from retained evidence on every call, so
  // doctor reports what is true rather than repeating a stored verdict.
  const isolation = isolationStatus(
    (flags["isolation-evidence"] as string | undefined) ?? ISOLATION_EVIDENCE_DIR,
  );
  return ok("doctor", {
    data: {
      subject_isolation: isolation,
      profile: flags["profile"] ?? "local-developer",
      node_version: process.version,
      registered_contracts: registeredContractCount(),
      lifecycle_states: LAB_STATES.length,
      separation_domains: registeredDomains().length,
      threshold_vrf: "THRESHOLD_VRF_NOT_ACTIVATED",
      held_out_selection: "disabled_pending_erl2_oq_007",
      fake_environment_driver: "enabled",
      compose_environment_driver: "disabled_pending_erl2_oq_005",
      otel_demo_substrate_lock: "unqualified_pending_erl2_oq_005",
      constrained_archetypes: "clean_greenfield_only_pending_erl2_oq_002",
      pack_runtime: "data_only_dsl_pending_erl2_oq_004",
      generic_evaluator: EVALUATOR_RELEASE,
      generic_metric_definitions: GENERIC_METRIC_DEFINITIONS.length,
      // Retained for callers that read the flat key. It is the derived
      // verdict above, never a separately maintained constant, so the two can
      // never disagree.
      subject_isolation_qualification: isolation.qualification,
      subject_isolation_required_controls: REQUIRED_ISOLATION_CONTROLS.length,
      privilege_broker: "unprivileged_container_subjects_only_pending_erl2_oq_001",
      adapter_protocol_version: ADAPTER_PROTOCOL_VERSION,
      adapter_sandbox_profile: "local-process",
      adapter_container_sandbox_profile: CONTAINER_PROFILE_STATE,
      // The honest split: what the enabled profile decides and receipts, and
      // what a kernel would have to enforce and this host cannot.
      adapter_sandbox_controls_enforced: enforcedControls("local-process").length,
      adapter_sandbox_controls_unsupported: unsupportedControls("local-process").length,
      adapter_privileged_capabilities_denied: PRIVILEGED_CAPABILITIES.length,
    },
  });
}

function status(argv: readonly string[]): CommandResult {
  const flags = parseFlags(argv, [
    { name: "run", kind: "string", required: true },
    { name: "artifact-root", kind: "string", required: true },
  ]);
  const root = path.resolve(requireString(flags, "artifact-root"));
  const runId = requireString(flags, "run");
  const snapshotPath = path.join(root, "state", "snapshot.json");

  // The derived snapshot is a cache, never authoritative.  Read it on the happy
  // path, but a torn or missing cache must not crash the command: fall back to
  // rebuilding state from the authoritative event log (§11.9).
  let snapshot: { run_id: string; state: string; lifecycle_head_hash: Hash } | undefined;
  if (existsSync(snapshotPath)) {
    try {
      snapshot = parseStrictJson(readFileSync(snapshotPath, "utf8")) as {
        run_id: string;
        state: string;
        lifecycle_head_hash: Hash;
      };
    } catch {
      snapshot = undefined; // torn cache — rebuild below.
    }
  }
  if (snapshot === undefined) {
    const rebuilt = new LifecycleLog({
      runId,
      store: new ArtifactStore(root),
      clock: new SystemClock(),
    }).snapshot();
    if (rebuilt === undefined) {
      throw new Erl2Error(CODES.ARTIFACT_NOT_FOUND, "no run state beneath the artifact root");
    }
    snapshot = { run_id: rebuilt.run_id, state: rebuilt.state, lifecycle_head_hash: rebuilt.lifecycle_head_hash };
  }
  if (snapshot.run_id !== runId) {
    throw new Erl2Error(CODES.CFG_MISSING_REQUIRED, "snapshot belongs to a different run");
  }
  return ok("status", {
    run_id: snapshot.run_id,
    state: snapshot.state,
    data: { lifecycle_head_hash: snapshot.lifecycle_head_hash },
  });
}

function resume(argv: readonly string[]): CommandResult {
  parseFlags(argv, [{ name: "run", kind: "string", required: true }]);
  throw new Erl2Error(
    "POLICY_COMMAND_NOT_IMPLEMENTED",
    "resume requires the journey engine from slice 4; a run may not be resumed by a stub",
  );
}

function verify(argv: readonly string[]): CommandResult {
  const flags = parseFlags(argv, [
    { name: "public-bundle", kind: "string", required: true },
    { name: "root-config", kind: "string", required: true },
    { name: "artifact-root", kind: "string", required: true },
    { name: "lifecycle", kind: "string", required: true },
    { name: "offline", kind: "boolean" },
  ]);
  if (flags["offline"] !== true) {
    throw new Erl2Error(CODES.VERIFY_OFFLINE_REQUIRED, "--offline is required; verification never uses the network");
  }
  const bundle = loadJsonDocument(requireString(flags, "public-bundle"), "public bundle");
  const result = verifyPublicBundle({
    bundle,
    artifactRoot: requireString(flags, "artifact-root"),
    lifecycle: loadLifecycle(requireString(flags, "lifecycle")),
    localTrust: loadLocalTrust(requireString(flags, "root-config")),
    verifiedAt: new SystemClock().now(),
    offline: true,
  });
  if (result.verdict !== "valid") {
    // Preserve the actual verifier cause rather than collapsing every closure
    // failure into one code (§11.12).  A rejected extra and a missing role are
    // different refusals a consumer must be able to tell apart.
    const closure = result.closure;
    const code =
      closure.rejected_extra_hashes.length > 0
        ? CODES.GRAPH_CLOSURE_EXTRA_ARTIFACT
        : CODES.GRAPH_CLOSURE_MISSING_ROLE;
    const detail =
      closure.rejected_extra_hashes.length > 0
        ? `${String(closure.rejected_extra_hashes.length)} unaccounted retained artifact(s)`
        : `missing roles: ${closure.missing_roles.join(", ") || "unknown"}`;
    throw new Erl2Error(code, `mandatory closure did not verify (${detail})`);
  }
  return ok("verify", {
    run_id: result.closure.run_id,
    record_hash: result.attestationHash,
    data: {
      verdict: result.verdict,
      trust_head_hash: result.trustHeadHash,
      valid_when_signed: result.validWhenSigned,
      currently_trusted: result.currentlyTrusted,
      closure: result.closure,
    },
  });
}

function verifyRecord(argv: readonly string[]): CommandResult {
  const flags = parseFlags(argv, [
    { name: "record", kind: "string", required: true },
    { name: "lifecycle", kind: "string", required: true },
    { name: "artifact-root", kind: "string", required: true },
    { name: "root-config", kind: "string", required: true },
    { name: "offline", kind: "boolean" },
  ]);
  if (flags["offline"] !== true) {
    throw new Erl2Error(CODES.VERIFY_OFFLINE_REQUIRED, "--offline is required; verification never uses the network");
  }
  const record = loadJsonDocument(requireString(flags, "record"), "invalid run record");
  const closure = verifyInvalidRecord({
    record,
    artifactRoot: requireString(flags, "artifact-root"),
    lifecycle: loadLifecycle(requireString(flags, "lifecycle")),
    localTrust: loadLocalTrust(requireString(flags, "root-config")),
    verifiedAt: new SystemClock().now(),
    offline: true,
  });
  return ok("verify-record", {
    run_id: closure.run_id,
    state: "invalidated",
    data: { closure },
  });
}

export { EXIT, AUTHORITY_SCOPE };
