/**
 * The environment and journey commands (design v2 Appendix C, Slice 6.5-B).
 *
 * Each one is a separate process over durable run state: it opens the workspace,
 * rebuilds the environment composition from the run's own retained evidence, and
 * advances exactly one phase of `ENVIRONMENT_PHASES`. Nothing is held between
 * commands.
 *
 * ## Where the environment lives
 *
 * The driver's substrate and the global reservation allocator are **not** part of
 * the run root. They default to sibling directories (`<run-root>.substrate`,
 * `<run-root>.reservations`) and may be pointed anywhere with a flag. That is not
 * a convenience: an artifact index scans the whole run root, so substrate state
 * inside it would be indexed as evidence, and a Compose project inside the
 * evidence tree would be the same category error.
 *
 * ## Where the environment's identity comes from
 *
 * The archetype, comparison policy and cutoff policy are named by hash *once* and
 * mirrored into the run. Every later command resolves them from `retained/` and
 * refuses a flag that names something else — the same rule that stops a run
 * substituting its adapter after preregistration.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseStrictJson } from "@erl2/contracts";
import { CODES, Erl2Error, type Hash } from "./contractsFacade.js";
import type {
  ChallengeManifestV1,
  ComparisonPolicyV1,
  CutoffPolicyV1,
  EnvironmentArchetypeV1,
  EnvironmentJourneyIntent,
  JourneyIntent,
  SelectedChallengeJourneyBindingV1,
} from "@erl2/contracts";
import {
  CRASH_BOUNDARIES,
  EnvironmentRun,
  FakeEnvironmentDriver,
  FileSubstrateStore,
  ReservationAllocator,
  RunWorkspace,
  isCrashBoundary,
  type CrashBarrier,
  type EnvironmentDriver,
  type EnvironmentKeyring,
  type FakeDriverFaults,
  type SubjectPort,
} from "@erl2/core";
import {
  ArtifactIndex,
  deriveEnvironmentClosureProgress,
  deriveEnvironmentPreFinalizationClosure,
  VERIFIER_RELEASE_HASH,
} from "@erl2/public-verifier";
import { developmentAgeIdentity, developmentKey } from "@erl2/integrity";
import { parseFlags, requireString, type FlagSpec, type ParsedFlags } from "./args.js";
import {
  COMMON_FLAGS,
  openWorkspace,
  resolveClaimScope,
  type JourneyCommandOutput,
} from "./journeyCommands.js";

/** Flags every environment command accepts on top of the common ones. */
const ENVIRONMENT_FLAGS: readonly FlagSpec[] = [
  ...COMMON_FLAGS,
  { name: "substrate-root", kind: "string" },
  { name: "reservation-root", kind: "string" },
  { name: "archetype", kind: "string" },
  { name: "comparison-policy", kind: "string" },
  { name: "cutoff-policy", kind: "string" },
  { name: "fake-driver-fault", kind: "string" },
  { name: "crash-at", kind: "string" },
  { name: "invocation-log", kind: "string" },
];

/**
 * Where this process must die, and where every external invocation is recorded
 * (ADR-ERL2-028 §7).
 *
 * Both are development-only, on exactly the terms `--fake-driver-fault` is: the
 * explicit development profile or `CFG_DEVELOPMENT_FLAG_UNAVAILABLE`. Neither is
 * reachable on the release surface, and with neither supplied the composition
 * below is byte-for-byte the production one — `NO_CRASH` is an empty function and
 * the driver and subject port are unwrapped.
 *
 * ## Why the invocation log is a file
 *
 * Because the process it measures is about to be `SIGKILL`ed. A counter in memory
 * is evidence that dies with its witness, which is why the previous matrix could
 * only count invocations in a process that survived — and a process that survives
 * did not crash. Every entry is appended with a synchronous write before *and*
 * after the call, so the log distinguishes "the call was entered" from "the call
 * returned", and a crash inside the external call is visible as an unmatched
 * `enter`.
 */
function developmentOnlyFlag(flags: ParsedFlags, name: string): string | undefined {
  const value = flags[name] as string | undefined;
  if (value === undefined) return undefined;
  if (process.env["ERL2_DEVELOPMENT_FAKE_SUBJECT"] !== "1") {
    throw new Erl2Error(
      CODES.CFG_DEVELOPMENT_FLAG_UNAVAILABLE,
      `--${name} is a development-only shortcut; it requires the explicit development profile ` +
        "(ERL2_DEVELOPMENT_FAKE_SUBJECT=1) and is not reachable on the release surface",
    );
  }
  return value;
}

/** Appends one external-invocation record, synchronously, before the process can die. */
function invocationRecorder(logPath: string | undefined): (entry: Record<string, unknown>) => void {
  if (logPath === undefined) return () => undefined;
  const absolute = path.resolve(logPath);
  mkdirSync(path.dirname(absolute), { recursive: true, mode: 0o700 });
  return (entry) => {
    appendFileSync(absolute, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  };
}

/**
 * The barrier that ends this process at a named boundary.
 *
 * `SIGKILL`, not `process.exit` and not a thrown error: `exit` runs `process.on`
 * handlers and a throw unwinds through every `finally` in the stack, releasing the
 * run lease and flushing whatever the real crash would have lost.
 */
function crashBarrier(flags: ParsedFlags): CrashBarrier | undefined {
  const requested = developmentOnlyFlag(flags, "crash-at");
  if (requested === undefined) return undefined;
  // `<boundary>` fires at the first operation to reach that boundary;
  // `<boundary>@<operation-id-prefix>` fires only for a matching operation.
  //
  // The prefix form exists because some durable states are reachable only *past*
  // an earlier operation's boundary of the same name. A cleanup interrupted after
  // its frontier is frozen and before its terminal is one: the failing `op-restore`
  // passes `after_external_dispatch` first, so an unqualified boundary can never
  // reach the emergency actions behind it. The negative-control campaign found this
  // by way of `cleanup-continuation` killing nothing (ADR-ERL2-028 §7.1).
  const [name, prefix] = requested.split("@", 2) as [string, string | undefined];
  if (!isCrashBoundary(name)) {
    throw new Erl2Error(
      CODES.CFG_MISSING_REQUIRED,
      `--crash-at must be one of ${[...CRASH_BOUNDARIES].join(", ")}, optionally suffixed ` +
        `with @<operation-id-prefix>`,
    );
  }
  return (boundary, operationId) => {
    if (boundary !== name) return;
    if (prefix !== undefined && !operationId.startsWith(prefix)) return;
    process.kill(process.pid, "SIGKILL");
  };
}

/**
 * Scripted environment-driver faults, for exercising the invalid terminal from
 * the CLI.
 *
 * Same posture as `--fake-acquire`: a development-only shortcut that steers a
 * failpoint of the *fake* driver, refused unless the explicit development
 * profile is enabled, and unreachable on the release surface. Without it the
 * emergency-cleanup branch could only be reached by a real substrate failure,
 * which is not a thing a test can arrange.
 */
const DRIVER_FAULTS: Readonly<Record<string, FakeDriverFaults>> = {
  "partial-provision": { provisionPartialAfter: 2 },
  "contaminated-baseline": { contaminationCodes: ["PREEXISTING_RESIDUE"] },
  "failed-probe": { failProbeIds: ["probe-network"] },
  "failed-restore": { failRestore: true },
  // A failed restoration *and* a resource the driver reports as shared with
  // another run. The frontier must then derive one `contain_residual`/unsafe
  // action alongside the safe ones — the mixed frontier whose foreign member
  // used to abort emergency cleanup entirely (review P1-5).
  "failed-restore-shared": { failRestore: true },
  // A failed restoration and a resource belonging to **another run**, sitting in
  // the same substrate. Distinct from `failed-restore-shared`, and the
  // distinction is the whole point: a *shared* resource still embeds this run's
  // id, so `assertOwnedByRun` passes for it and a whole-environment destroy
  // never throws — which means the only case claiming to prove P1-5 was proving
  // something about shared resources and nothing about foreign ones. A foreign
  // resource fails `assertOwnedByRun`, so `driver.destroy` throws on it
  // (ADR-ERL2-027 §1.5, §4.7).
  "failed-restore-foreign": { failRestore: true },
  // The bounded route: a contaminated baseline is a non-emergency failure, and
  // until ADR-ERL2-027 it reached an unconditional whole-environment
  // `driver.destroy()` over a frontier that had just been frozen and never read.
  // With a shared resource present, that destroy removed a resource the frontier
  // had classified `contain_residual` and left no record of having done so
  // (review P1-1); with a foreign one it threw, and the run reached no terminal
  // at all (review P1-5).
  "contaminated-baseline-shared": { contaminationCodes: ["PREEXISTING_RESIDUE"] },
  "contaminated-baseline-foreign": { contaminationCodes: ["PREEXISTING_RESIDUE"] },
  // The compensation returns `succeeded` and reverts nothing (review P1-4). Not
  // a variant of `failed-restore`: a failed restoration is honest and already
  // routes to emergency cleanup, while this one produces a receipt that reads
  // exactly like a clean compensation over a mutation that is still applied.
  "no-op-restore": { restoreWithoutReverting: true },
  // The environment already carried a mutation this run never applied, and the
  // compensation clears it too.
  "collateral-restore": { preexistingMutationId: "preexisting-operator-change" },
  "failed-teardown": { failTeardown: true },
  residue: { residualResourceIds: [] },
};

function driverFaults(flags: ParsedFlags, runId: string): FakeDriverFaults {
  const name = flags["fake-driver-fault"] as string | undefined;
  if (name === undefined) return {};
  if (process.env["ERL2_DEVELOPMENT_FAKE_SUBJECT"] !== "1") {
    throw new Erl2Error(
      CODES.CFG_DEVELOPMENT_FLAG_UNAVAILABLE,
      "--fake-driver-fault is a development-only shortcut; it requires the explicit development profile " +
        "(ERL2_DEVELOPMENT_FAKE_SUBJECT=1) and is not reachable on the release surface",
    );
  }
  const fault = DRIVER_FAULTS[name];
  if (fault === undefined) {
    throw new Erl2Error(
      CODES.CFG_MISSING_REQUIRED,
      `--fake-driver-fault must be one of ${Object.keys(DRIVER_FAULTS).sort().join(", ")}`,
    );
  }
  // The residue fault names a concrete resource of *this* run, so it cannot be
  // written as a static table entry.
  if (name === "residue") return { residualResourceIds: [`volume-${runId.slice(0, 8)}`] };
  if (name === "failed-restore-shared") {
    return { failRestore: true, sharedResourceIds: [`volume-${runId.slice(0, 8)}`] };
  }
  if (name === "contaminated-baseline-shared") {
    return { ...fault, sharedResourceIds: [`volume-${runId.slice(0, 8)}`] };
  }
  // The foreign resource is another run's, so it is named by *kind* rather than
  // by one of this run's resource ids — there is no id of ours that could name
  // something that is not ours.
  if (name === "failed-restore-foreign" || name === "contaminated-baseline-foreign") {
    return { ...fault, foreignResourceKinds: ["volume"] };
  }
  return fault;
}

/**
 * The private, run-local record of where this run's substrate and reservations
 * actually live (ADR-ERL2-024 §4.2).
 *
 * It lives in `state/`, beside the run lease and the derived snapshot: a
 * subtree the artifact index, the closure derivation and the retained-file
 * accounting all exclude by construction. That is deliberate. An operational
 * locator is deployment configuration, not a claim — publishing an absolute
 * host path as signed evidence would be a leak, and hashing it would be
 * unverifiable by an offline reader who has no path to hash. The *public*
 * identity is `SubstrateBindingV1.substrate_instance_hash`; this file is only
 * how a fresh process finds the substrate again without trusting a flag.
 */
interface SubstrateLocatorRecord {
  readonly run_id: string;
  readonly substrate_root: string;
  readonly reservation_root: string;
}

function locatorPath(runRoot: string): string {
  return path.join(path.resolve(runRoot), "state", "substrate-locator.json");
}

function readLocator(runRoot: string): SubstrateLocatorRecord | undefined {
  const file = locatorPath(runRoot);
  if (!existsSync(file)) return undefined;
  try {
    return parseStrictJson(readFileSync(file, "utf8")) as SubstrateLocatorRecord;
  } catch (cause) {
    // A torn locator is not "no locator": answering it that way would send the
    // next phase to a default directory that may not be the bound substrate.
    throw new Erl2Error(
      CODES.ENV_SUBSTRATE_UNREADABLE,
      "the run's substrate locator record exists but could not be read",
      { cause },
    );
  }
}

function writeLocator(runRoot: string, record: SubstrateLocatorRecord): void {
  const file = locatorPath(runRoot);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp`;
  writeFileSync(temp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  renameSync(temp, file);
}

/**
 * The locator flags are development-only shortcuts, on the same terms as
 * `--fake-driver-fault` and `--fake-acquire`.
 *
 * `--substrate-root` used to be ungated and unattested, which is the whole of
 * P0-1: a caller drove the environment against substrate A, then ran `destroy`
 * and `finalize-generic` against a fresh empty directory and obtained an
 * offline-valid attestation while A stayed allocated. Gating the flag is not
 * the fix — the binding is — but an ungated redirection flag has no business on
 * a release surface either way.
 */
function assertLocatorFlagsAvailable(flags: ParsedFlags): void {
  const supplied =
    flags["substrate-root"] !== undefined || flags["reservation-root"] !== undefined;
  if (supplied && process.env["ERL2_DEVELOPMENT_FAKE_SUBJECT"] !== "1") {
    throw new Erl2Error(
      CODES.CFG_DEVELOPMENT_FLAG_UNAVAILABLE,
      "--substrate-root and --reservation-root redirect the Lab's own observation channel; " +
        "they are development-only shortcuts requiring the explicit development profile " +
        "(ERL2_DEVELOPMENT_FAKE_SUBJECT=1) and are not reachable on the release surface",
    );
  }
}

/**
 * Resolves the substrate and reservation locators for one command.
 *
 * A run establishes them once and then owns them. A later flag may not replace
 * them: this is the rule that stops the second half of the substitution — even
 * a developer with the profile enabled cannot point an already-bound run at a
 * different directory, they can only fail to.
 */
function resolveLocators(flags: ParsedFlags, runId: string): {
  readonly substrateRoot: string;
  readonly reservationRoot: string;
} {
  assertLocatorFlagsAvailable(flags);
  const runRoot = path.resolve(requireString(flags, "run-root"));
  const suppliedSubstrate = flags["substrate-root"] as string | undefined;
  const suppliedReservation = flags["reservation-root"] as string | undefined;
  const substrateRoot = path.resolve(suppliedSubstrate ?? `${runRoot}.substrate`);
  const reservationRoot = path.resolve(suppliedReservation ?? `${runRoot}.reservations`);

  const bound = readLocator(runRoot);
  if (bound === undefined) {
    return { substrateRoot, reservationRoot };
  }
  if (bound.run_id !== runId) {
    throw new Erl2Error(
      CODES.POLICY_RUN_IDENTITY_MISMATCH,
      `the substrate locator recorded in this run root belongs to run ${bound.run_id}`,
    );
  }
  if (suppliedSubstrate !== undefined && path.resolve(suppliedSubstrate) !== bound.substrate_root) {
    throw new Erl2Error(
      CODES.ENV_SUBSTRATE_LOCATOR_CONFLICT,
      `--substrate-root names ${path.resolve(suppliedSubstrate)}, but this run is bound to the ` +
        `substrate at ${bound.substrate_root}; a binding may be established once, never replaced`,
    );
  }
  if (
    suppliedReservation !== undefined &&
    path.resolve(suppliedReservation) !== bound.reservation_root
  ) {
    throw new Erl2Error(
      CODES.ENV_SUBSTRATE_LOCATOR_CONFLICT,
      `--reservation-root names ${path.resolve(suppliedReservation)}, but this run is bound to the ` +
        `reservation namespace at ${bound.reservation_root}`,
    );
  }
  // The run's own record wins over any default: a later command that omits the
  // flags must still reach the substrate the run bound, not `<run-root>.substrate`.
  return { substrateRoot: bound.substrate_root, reservationRoot: bound.reservation_root };
}

function hashFlag(flags: ParsedFlags, name: string): Hash | undefined {
  const value = flags[name] as string | undefined;
  if (value === undefined) return undefined;
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new Erl2Error(CODES.CFG_MISSING_REQUIRED, `--${name} must be a sha256 core hash`);
  }
  return value as Hash;
}

/**
 * Resolves an admission input that a run binds once and then owns.
 *
 * If the run already retains it, that is the answer and a flag naming anything
 * else is refused. Otherwise the flag is required and resolved from the governor
 * registry — never from the run, which does not have it yet.
 */
function resolveAdmitted<T>(options: {
  readonly workspace: RunWorkspace;
  readonly flags: ParsedFlags;
  readonly flagName: string;
  readonly contract: string;
  readonly retainedHash: Hash | undefined;
  readonly label: string;
}): T {
  const supplied = hashFlag(options.flags, options.flagName);
  if (options.retainedHash !== undefined) {
    if (supplied !== undefined && supplied !== options.retainedHash) {
      throw new Erl2Error(
        CODES.ADMISSION_ARTIFACT_UNKNOWN,
        `--${options.flagName} does not match the ${options.label} this run already bound; a run cannot substitute it`,
      );
    }
    return options.workspace.artifact<T>(options.retainedHash, options.contract);
  }
  if (supplied === undefined) {
    throw new Erl2Error(
      CODES.CFG_MISSING_REQUIRED,
      `--${options.flagName} is required: this run has not yet bound its ${options.label}`,
    );
  }
  return options.workspace.registry.require<T>(supplied, options.contract);
}

/** The core hash of a retained artifact of the given schema, if the run has one. */
function retainedHashOfSchema(workspace: RunWorkspace, schemaVersion: string): Hash | undefined {
  return ArtifactIndex.scan(workspace.store.root)
    .all()
    .find((artifact) => artifact.schemaVersion === schemaVersion)?.coreHash;
}

/**
 * The environment signing roles.
 *
 * Three distinct keys, because the cutoff must be checkable without trusting any
 * one of them, and the exposure record must not be issued by the authority whose
 * challenge it demotes (ADR-ERL2-021).
 */
function environmentKeyring(): EnvironmentKeyring {
  return {
    // The authority that provisions the environment is the one that records
    // which substrate it provisioned into (ADR-ERL2-024 §6.4). The development
    // policy grants `environment_governor` to the challenge-governor key, which
    // is the same key the driver manifest is signed with.
    environmentGovernor: developmentKey("challenge-governor"),
    // Its own key, not the governor's: the governor provisions the environment,
    // the controller decides a challenge goes live in it (ADR-ERL2-023).
    controller: developmentKey("controller"),
    trafficSupervisor: developmentKey("traffic-supervisor"),
    runtimeAttestor: developmentKey("runtime-attestor"),
    vaultAuthorizer: developmentKey("vault-authorizer"),
    timestampAuthority: developmentKey("timestamp"),
    finalizer: developmentKey("finalizer"),
  };
}

/**
 * Records every subject-port step invocation to the durable log.
 *
 * A decorator rather than a change to `FakeSubjectPort`, so what is counted is
 * the *port the run actually calls* — including, when `--adapter-entry` is used,
 * a real out-of-process adapter. Counting inside the fake would measure the
 * fake.
 */
function countingSubjectPort(
  port: SubjectPort,
  record: (entry: Record<string, unknown>) => void,
): SubjectPort {
  return {
    get portId(): string {
      return port.portId;
    },
    acquire: (...args) => port.acquire(...args),
    validatePackage: (...args) => port.validatePackage(...args),
    step: (request, intent) => {
      record({
        surface: "subject_port",
        phase: "enter",
        operation_id: request.operation_id,
        request_hash: request.core_hash,
        intent,
      });
      const response = port.step(request, intent);
      record({
        surface: "subject_port",
        phase: "return",
        operation_id: request.operation_id,
        request_hash: request.core_hash,
        intent,
      });
      return response;
    },
  };
}

/**
 * Records every mutating driver invocation to the durable log.
 *
 * Read-only operations (`probe`, `inspect`, `substrateInstance`,
 * `completedOperation`) are passed through uncounted: they carry no durable
 * intent by contract (ADR-ERL2-024 §4.3), and counting them would drown the
 * signal the matrix is looking for. `completedOperation` in particular is the
 * *reconciliation probe*, so counting it as an invocation would make a correct
 * adopt-instead-of-redispatch look like a second call.
 */
function countingDriver(
  driver: FakeEnvironmentDriver,
  record: (entry: Record<string, unknown>) => void,
): EnvironmentDriver {
  const counted = <T>(operationId: string, kind: string, call: () => T): T => {
    record({ surface: "driver", phase: "enter", operation_id: operationId, kind });
    const result = call();
    record({ surface: "driver", phase: "return", operation_id: operationId, kind });
    return result;
  };
  return {
    get manifest() {
      return driver.manifest;
    },
    provision: (r) => counted(r.operationId, "provision", () => driver.provision(r)),
    probe: (r) => driver.probe(r),
    mutate: (r) => counted(r.operationId, "mutate", () => driver.mutate(r)),
    restore: (r) => counted(r.operationId, "restore", () => driver.restore(r)),
    destroy: (r) => counted(r.operationId, "destroy", () => driver.destroy(r)),
    destroyResource: (r) =>
      counted(r.operationId, "destroy_resource", () => driver.destroyResource(r)),
    inspect: (runId) => driver.inspect(runId),
    substrateInstance: () => driver.substrateInstance(),
    establishSubstrateInstance: (runId) => driver.establishSubstrateInstance(runId),
    completedOperation: (runId, operationId) => driver.completedOperation(runId, operationId),
    observedMutations: (runId) => driver.observedMutations(runId),
  };
}

export interface EnvironmentContext {
  readonly workspace: RunWorkspace;
  readonly run: EnvironmentRun;
  readonly runId: string;
  readonly runRoot: string;
  readonly flags: ParsedFlags;
  /**
   * Records the run's operational locators, so a later process reaches the same
   * substrate without trusting a flag. Called by `provision` only, immediately
   * before the phase that establishes the binding.
   */
  readonly recordLocators: () => void;
}

/**
 * Builds the environment composition for one command.
 *
 * The archetype is checked against the *selected challenge's* admissible
 * archetype set the first time it is bound: a run may not be provisioned into an
 * environment its own challenge never admitted.
 */
export function openEnvironment(argv: readonly string[], extra: readonly FlagSpec[] = []): EnvironmentContext {
  const flags = parseFlags(argv, [...ENVIRONMENT_FLAGS, ...extra]);
  const runId = requireString(flags, "run");
  const runRoot = requireString(flags, "run-root");
  // Locators are resolved before the workspace is opened, so a flag that
  // contradicts the run's binding refuses before any directory is created —
  // including the substrate and reservation roots themselves.
  const locators = resolveLocators(flags, runId);
  // The crash seam and the invocation log, both development-gated. With neither
  // flag supplied `record` is a no-op, `barrier` is undefined, and the driver and
  // subject port below are the unwrapped production ones.
  const record = invocationRecorder(developmentOnlyFlag(flags, "invocation-log"));
  const barrier = crashBarrier(flags);
  const counting = developmentOnlyFlag(flags, "invocation-log") !== undefined;
  const workspace = openWorkspace(flags, runId, {
    ...(counting ? { wrapSubjectPort: (port) => countingSubjectPort(port, record) } : {}),
  });
  const clock = workspace.productionClock();

  const archetype = resolveAdmitted<EnvironmentArchetypeV1>({
    workspace,
    flags,
    flagName: "archetype",
    contract: "EnvironmentArchetypeV1",
    retainedHash: retainedHashOfSchema(workspace, "environment-archetype/v1"),
    label: "environment archetype",
  });
  assertArchetypeAdmissible(workspace, archetype);

  // Resolved lazily: a run binds these at `journey`, so `provision`, `baseline`
  // and `plan` must not demand them.
  const comparisonPolicy = (): ComparisonPolicyV1 =>
    resolveAdmitted<ComparisonPolicyV1>({
      workspace,
      flags,
      flagName: "comparison-policy",
      contract: "ComparisonPolicyV1",
      retainedHash: retainedHashOfSchema(workspace, "comparison-policy/v1"),
      label: "comparison policy",
    });
  const cutoffPolicy = (): CutoffPolicyV1 =>
    resolveAdmitted<CutoffPolicyV1>({
      workspace,
      flags,
      flagName: "cutoff-policy",
      contract: "CutoffPolicyV1",
      retainedHash: retainedHashOfSchema(workspace, "cutoff-policy/v1"),
      label: "cutoff policy",
    });

  const fakeDriver = new FakeEnvironmentDriver({
    clock,
    // The driver manifest is the environment governor's, and the development
    // policy grants that role to the challenge-governor key (ADR-ERL2-020 §4).
    signingKey: developmentKey("challenge-governor"),
    archetypeHash: archetype.core_hash,
    resourceKinds: archetype.topology.map((node) => node.node_id),
    evidenceSourceIds: archetype.evidence_sources.map((source) => source.source_id),
    substrate: new FileSubstrateStore(locators.substrateRoot),
    faults: driverFaults(flags, runId),
  });
  const driver: EnvironmentDriver = counting ? countingDriver(fakeDriver, record) : fakeDriver;

  const run = new EnvironmentRun({
    workspace,
    driver,
    allocator: new ReservationAllocator({ root: locators.reservationRoot, clock }),
    archetype,
    comparisonPolicy,
    cutoffPolicy,
    keys: environmentKeyring(),
    clock,
    ...(barrier === undefined ? {} : { barrier }),
  });
  return {
    workspace,
    run,
    runId,
    runRoot,
    flags,
    recordLocators: () =>
      writeLocator(runRoot, {
        run_id: runId,
        substrate_root: locators.substrateRoot,
        reservation_root: locators.reservationRoot,
      }),
  };
}

/**
 * The archetype must be one the selected challenge admits.
 *
 * Checked from the run's own retained challenge manifest, so an operator cannot
 * provision a different environment than the one the selected case was admitted
 * for by passing a different `--archetype`.
 */
function assertArchetypeAdmissible(workspace: RunWorkspace, archetype: EnvironmentArchetypeV1): void {
  const bindingHash = workspace.hashForRole("selected-challenge-journey-binding");
  if (bindingHash === undefined) return;
  const binding = workspace.artifact<SelectedChallengeJourneyBindingV1>(
    bindingHash,
    "SelectedChallengeJourneyBindingV1",
  );
  const challenge = workspace.artifact<ChallengeManifestV1>(
    binding.challenge_manifest_hash,
    "ChallengeManifestV1",
  );
  if (!challenge.archetype_hashes.includes(archetype.core_hash)) {
    throw new Erl2Error(
      CODES.ADMISSION_ARTIFACT_UNKNOWN,
      `archetype ${archetype.archetype_id} is not in the selected challenge's admissible archetype set`,
    );
  }
}

function output(ctx: EnvironmentContext, data: Record<string, unknown>): JourneyCommandOutput {
  return { runId: ctx.runId, state: ctx.workspace.lifecycle.currentState, data };
}

// -- the phase commands ------------------------------------------------------

/**
 * Routes a Lab-owned environment failure to the invalid terminal.
 *
 * ERL2-FR-001: every durably accepted run that cannot reach a valid terminal must
 * still reach *a* terminal. The command still returns its record hashes, because
 * Appendix C forbids returning a terminal run state without them, and still exits
 * on the failure's own code so a caller cannot read it as success.
 */
function invalidateEnvironmentAfter(
  ctx: EnvironmentContext,
  cause: Erl2Error,
  phase: Parameters<EnvironmentRun["invalidate"]>[0]["phase"],
  classification: Parameters<EnvironmentRun["invalidate"]>[0]["classification"],
  emergency: boolean,
): JourneyCommandOutput {
  const record = ctx.run.invalidate({
    phase,
    classification,
    failure: { code: cause.code, owner: "lab", message: cause.message.slice(0, 512) },
    emergency,
  });
  return {
    ...output(ctx, {
      invalid_run_record_hash: record.core_hash,
      terminal_state: record.terminal_state,
      cleanup_variant: record.cleanup.variant,
      cleanup_status: record.cleanup.status,
      refusal_code: cause.code,
    }),
    terminalError: cause,
  };
}

/** The Lab-owned failure codes each environment phase routes to its terminal. */
function routed(
  ctx: EnvironmentContext,
  cause: unknown,
  codes: readonly string[],
  phase: Parameters<EnvironmentRun["invalidate"]>[0]["phase"],
  classification: Parameters<EnvironmentRun["invalidate"]>[0]["classification"],
  emergency: boolean,
): JourneyCommandOutput {
  if (!(cause instanceof Erl2Error) || !codes.includes(cause.code)) throw cause;
  return invalidateEnvironmentAfter(ctx, cause, phase, classification, emergency);
}

export function provision(argv: readonly string[]): JourneyCommandOutput {
  const ctx = openEnvironment(argv);
  // The locator is recorded before the binding is established, not after: a
  // crash between the two must leave a run that can still *find* the substrate
  // it may have created, rather than one that silently falls back to a default
  // directory (ADR-ERL2-024 §4.2).
  ctx.recordLocators();
  let result;
  try {
    result = ctx.run.provision();
  } catch (cause) {
    return routed(ctx, cause, [CODES.ENV_PROVISION_FAILED], "provisioning", "lab_invalidity", false);
  }
  return output(ctx, {
    environment_instance_hash: result.inventory.core_hash,
    resource_count: result.inventory.resources.length,
    reservation_lease_count: result.leases,
  });
}

export function baseline(argv: readonly string[]): JourneyCommandOutput {
  const ctx = openEnvironment(argv);
  let fingerprint;
  try {
    fingerprint = ctx.run.baseline();
  } catch (cause) {
    // A contaminated or failing baseline is Lab-owned and never a subject defect
    // (design §9): the environment was not clean, so nothing about the subject
    // was measured.
    return routed(
      ctx,
      cause,
      [
        CODES.BASELINE_CONTAMINATION_DETECTED,
        CODES.BASELINE_PROBE_FAILED,
        CODES.BASELINE_FINGERPRINT_MISMATCH,
      ],
      "baseline",
      "lab_invalidity",
      false,
    );
  }
  return output(ctx, {
    baseline_hash: fingerprint.core_hash,
    fingerprint_hash: fingerprint.fingerprint_hash,
    contamination_detected: fingerprint.contamination.detected,
    probe_count: fingerprint.probes.length,
    evidence_source_count: fingerprint.evidence_source_states.length,
  });
}

export function plan(argv: readonly string[]): JourneyCommandOutput {
  const ctx = openEnvironment(argv);
  const executionPlan = ctx.run.plan();
  return output(ctx, {
    execution_plan_hash: executionPlan.core_hash,
    actor_script_hash: executionPlan.actor_script_hash,
    journey_hash: executionPlan.journey_hash,
  });
}

/**
 * Runs the next committed step of the selected journey.
 *
 * An intent-named command passes its own intent, which acts as a guard: the
 * journey's order decides what runs next, and a command that names a different
 * intent is refused rather than reordering the journey.
 */
function step(argv: readonly string[], intent?: JourneyIntent): JourneyCommandOutput {
  const ctx = openEnvironment(argv);
  // The occurrence is read *before* the step runs, because the step is what may
  // fail: an ambiguous dispatch leaves no outcome to read the intent and the
  // commitment off afterwards, and those are exactly what
  // `InvalidJourneyExecutionPhaseV1` requires.
  const owed = ctx.run.nextStep();
  let outcome;
  try {
    outcome = intent === undefined ? ctx.run.runStep() : ctx.run.runStep(intent);
  } catch (cause) {
    // An ambiguous subject dispatch is Lab-owned and reaches a terminal.
    //
    // Before this it propagated as an ordinary CLI error: the run refused
    // correctly, never re-invoked the subject — and was then a durably accepted
    // run with no reachable terminal, which is the brief's own P1 definition. The
    // ambiguity is recorded as what it is, and the subject is not blamed for it
    // (ADR-ERL2-024 §4.3, ADR-ERL2-028 §5.2).
    if (owed === undefined) throw cause;
    return routed(
      ctx,
      cause,
      [CODES.ENV_MUTATION_INTENT_AMBIGUOUS, CODES.ENV_MUTATION_INTENT_MISSING],
      {
        kind: "journey_execution" as const,
        intent: owed.intent as EnvironmentJourneyIntent,
        stepCommitmentHash: owed.commitment.core_hash,
      },
      // Not `subject`: the Lab cannot establish what the subject did, and
      // `lab_invalidity` is the honest owner of "I do not know".
      "lab_invalidity",
      false,
    );
  }
  const next = ctx.run.nextStep();
  return output(ctx, {
    step_id: outcome.step_id,
    intent: outcome.intent,
    status: outcome.status,
    step_outcome_hash: outcome.core_hash,
    unsupported_inputs: outcome.status === "unsupported" ? outcome.detail_record_hashes.length : 0,
    ...(next === undefined ? { journey_complete: true } : { next_intent: next.intent }),
  });
}

export const executeSubject = (argv: readonly string[]): JourneyCommandOutput => step(argv);
export const install = (argv: readonly string[]): JourneyCommandOutput => step(argv, "install");
export const configure = (argv: readonly string[]): JourneyCommandOutput => step(argv, "configure");
export const authenticate = (argv: readonly string[]): JourneyCommandOutput => step(argv, "authenticate");
export const connect = (argv: readonly string[]): JourneyCommandOutput => step(argv, "connect");
export const recover = (argv: readonly string[]): JourneyCommandOutput => step(argv, "recover");
export const rollback = (argv: readonly string[]): JourneyCommandOutput => step(argv, "rollback");
export const remove = (argv: readonly string[]): JourneyCommandOutput => step(argv, "remove");

export function activate(argv: readonly string[]): JourneyCommandOutput {
  const ctx = openEnvironment(argv);
  let result;
  try {
    result = ctx.run.activate();
  } catch (cause) {
    // A failed activation mutation, and an activation whose prior dispatch cannot
    // be reconciled, both reach the activation terminal rather than stranding the
    // run. `activation` is the phase, and `environment-not-contaminated` the gate
    // it falsifies: a failed or unknown activation leaves the environment in an
    // unproven state, which is precisely what that gate asserted.
    return routed(
      ctx,
      cause,
      [
        CODES.ENV_PROVISION_FAILED,
        CODES.ENV_MUTATION_INTENT_AMBIGUOUS,
        CODES.ENV_MUTATION_INTENT_MISSING,
      ],
      "activation",
      "lab_invalidity",
      false,
    );
  }
  return output(ctx, {
    mutation_receipt_hash: result.receiptHash,
    activation_receipt_hash: result.activationReceiptHash,
  });
}

export function journey(argv: readonly string[]): JourneyCommandOutput {
  const ctx = openEnvironment(argv);
  const result = ctx.run.journeyStart();
  return output(ctx, { runtime_milestone_hash: result.milestoneHash });
}

export function observe(argv: readonly string[]): JourneyCommandOutput {
  const ctx = openEnvironment(argv);
  const result = ctx.run.observe();
  return output(ctx, {
    cutoff_instant: result.cutoffInstant,
    source_snapshot_count: result.snapshots.length,
    source_states: result.snapshots.map((snapshot) => ({
      source_id: snapshot.source_id,
      state: snapshot.state,
    })),
  });
}

export function freezeObservation(argv: readonly string[]): JourneyCommandOutput {
  const ctx = openEnvironment(argv);
  const result = ctx.run.freezeObservation();
  return output(ctx, {
    observation_bundle_hash: result.observation.core_hash,
    canonical_evidence_envelope_hash: result.envelope.core_hash,
    envelope_entry_count: result.envelope.entries.length,
    adapter_translation_receipt_hash: ctx.workspace.hashForRole("adapter-translation-receipt"),
  });
}

export function restore(argv: readonly string[]): JourneyCommandOutput {
  const ctx = openEnvironment(argv);
  let restoration;
  try {
    restoration = ctx.run.restore();
  } catch (cause) {
    // Design §12: a restoration failure MUST enter receipt-backed emergency
    // cleanup. It has exactly one authorized route and this is it.
    return routed(ctx, cause, [CODES.RESTORATION_FAILED], "environment_restoration", "cleanup_failure", true);
  }
  return output(ctx, {
    environment_restoration_hash: restoration.core_hash,
    passed: restoration.passed,
    residual_resources: restoration.residual_resources.length,
  });
}

export function destroy(argv: readonly string[]): JourneyCommandOutput {
  const ctx = openEnvironment(argv);
  let result;
  try {
    result = ctx.run.destroy();
  } catch (cause) {
    return routed(ctx, cause, [CODES.TEARDOWN_FAILED], "teardown", "teardown_failure", true);
  }
  return output(ctx, {
    teardown_hash: result.teardown.core_hash,
    passed: result.teardown.passed,
    residue_after_teardown: result.residue,
    checks: result.teardown.checks.length,
  });
}

// -- shared commands, environment branch ------------------------------------

/** True once the run has an execution plan: the point of no return into the environment branch. */
export function isEnvironmentBranch(workspace: RunWorkspace): boolean {
  return workspace.hashForRole("execution-plan") !== undefined;
}

/**
 * `erl2 cancel` on the environment branch (ADR-ERL2-024 §4.4).
 *
 * Reached through the same branch dispatch the other four shared commands use,
 * but on a *wider* discriminator: `freeze-output`, `reveal`, `evaluate` and
 * `finalize-generic` key off the execution plan, which a run only has once it
 * has provisioned, baselined and planned. Cancellation has to be routed
 * correctly from `environment_provisioned` too — a run that provisioned and then
 * stopped has four reservation leases and a live environment, and that is
 * exactly the case that used to freeze `not_required` (review P1-2).
 */
export function cancelEnvironment(argv: readonly string[]): JourneyCommandOutput {
  const ctx = openEnvironment(argv, [
    { name: "reason", kind: "string", required: true },
    { name: "actor", kind: "string" },
  ]);
  const record = ctx.run.cancel({
    reasonCode: requireString(ctx.flags, "reason"),
    requestedByActorId: (ctx.flags["actor"] as string | undefined) ?? "operator",
  });
  return {
    ...output(ctx, {
      invalid_run_record_hash: record.core_hash,
      terminal_state: record.terminal_state,
      cleanup_variant: record.cleanup.variant,
      cleanup_status: record.cleanup.status,
      cancelled_during:
        record.failed_phase.kind === "cancellation" ? record.failed_phase.cancelled_during : undefined,
    }),
    // A cancelled run still returns its record hash (Appendix C) but exits on
    // the cancellation class so a caller cannot read it as success.
    terminalError: new Erl2Error(CODES.CANCELLATION_REQUESTED, "run cancelled at operator request"),
  };
}

export function freezeEnvironmentOutput(argv: readonly string[]): JourneyCommandOutput {
  const ctx = openEnvironment(argv, [{ name: "terminal-stage", kind: "string" }]);
  const manifest = ctx.run.freezeOutput();
  return output(ctx, {
    subject_output_hash: manifest.core_hash,
    terminal_stage: manifest.terminal_stage,
    step_outcome_hashes: manifest.step_outcome_hashes,
    unsupported_inputs: manifest.unsupported_inputs,
    tree_hash: manifest.tree_hash,
  });
}

/**
 * `erl2 reveal` on the environment branch.
 *
 * The exposure event is produced in the *same* durable transition as the reveal:
 * opening the sealed case and recording that it is open are one act, so a reader
 * can never find a run that opened a challenge without saying so.
 */
export function revealEnvironment(argv: readonly string[]): JourneyCommandOutput {
  const ctx = openEnvironment(argv, [
    { name: "vault", kind: "string", required: true },
    { name: "judge-identity", kind: "string" },
  ]);
  const label = (ctx.flags["judge-identity"] as string | undefined) ?? "judge";
  let exposureHash: Hash | undefined;
  const revealed = ctx.workspace.revealJudgeExpectations({
    vaultRoot: requireString(ctx.flags, "vault"),
    judgeIdentity: developmentAgeIdentity(label),
    alsoProduce: () => {
      const exposure = ctx.run.freezeExposure();
      exposureHash = exposure.core_hash;
      return [
        {
          artifact_role: "exposure-event",
          artifact_core_hash: exposure.core_hash,
          artifact_schema_version: "exposure-event/v1",
        },
      ];
    },
  });
  return output(ctx, {
    reveal_record_hash: revealed.recordHash,
    revealed_expectation_hashes: revealed.revealedExpectationHashes,
    revealed_count: revealed.revealedExpectationHashes.length,
    exposure_event_hash: exposureHash,
  });
}

export function evaluateEnvironment(argv: readonly string[]): JourneyCommandOutput {
  const ctx = openEnvironment(argv, [{ name: "finding", kind: "string" }]);
  const result = ctx.run.evaluate();
  return output(ctx, {
    journey_result_hash: result.journeyResult.core_hash,
    journey_status: result.journeyResult.status,
    domain_result_hash: result.domainResult.core_hash,
    domain_status: result.domainResult.status,
    domain_not_applicable_reason: result.domainResult.reason,
    precleanup_result_join_hash: result.join.core_hash,
    metric_result_hashes: result.metricResults.map((metric) => metric.core_hash),
  });
}

/**
 * `erl2 finalize-generic` on the environment branch: validity, then the generic
 * evaluation index.
 *
 * The closure verdict the `mandatory-graph-closed` gate scores is derived by the
 * offline verifier's own algorithm over this run's retained tree — not by a
 * producer assertion, and not by a second implementation of the same check.
 */
export function finalizeEnvironment(argv: readonly string[]): JourneyCommandOutput {
  const ctx = openEnvironment(argv, [{ name: "claim-scope", kind: "string" }]);
  // Derived from the run's own retained evidence, with `--claim-scope` reduced
  // to a requested upper bound (ADR-ERL2-025 §4.4). It used to be
  // `flags["claim-scope"] ?? "T1"`, which let an operator sign T3 over a
  // development-tier fake-driver run whose domain plane was never evaluated.
  const claimScope = resolveClaimScope({
    requested: ctx.flags["claim-scope"] as string | undefined,
    index: ArtifactIndex.scan(ctx.runRoot),
    lifecycle: ctx.workspace.lifecycle.all(),
    terminalVariant: "environment",
    selectionAssurance: ctx.run.selectionAssurance(),
  });
  const progress = deriveEnvironmentClosureProgress({
    lifecycle: ctx.workspace.lifecycle.all(),
    index: ArtifactIndex.scan(ctx.runRoot),
    verifierReleaseHash: VERIFIER_RELEASE_HASH,
    verifiedAt: ctx.workspace.productionClock().now(),
  });
  const result = ctx.run.freezeValidityAndIndex({
    derivedClosureVerdict:
      progress.missingRoles.length === 0 && progress.extraHashes.length === 0 ? "valid" : "invalid",
    derivedMissingRoles: progress.missingRoles,
    derivedExtraHashes: progress.extraHashes,
  });
  // Validity, index and terminal are one command, in the design's order: the
  // index cites the validity result, the record cites the index, and nothing is
  // signed until the closure derived by the verifier's own algorithm is complete.
  const terminal = ctx.run.finalizeTerminal({
    claimScope,
    deriveClosure: (runRecord) =>
      deriveEnvironmentPreFinalizationClosure({
        lifecycle: ctx.workspace.lifecycle.all(),
        index: ArtifactIndex.scan(ctx.runRoot),
        verifierReleaseHash: VERIFIER_RELEASE_HASH,
        verifiedAt: ctx.workspace.productionClock().now(),
        runRecord,
      }),
  });
  return output(ctx, {
    validity_result_hash: result.validity.core_hash,
    validity_status: result.validity.status,
    generic_evaluation_index_hash: result.index.core_hash,
    run_record_hash: terminal.runRecord.core_hash,
    terminal_stage: terminal.runRecord.terminal_stage,
    final_attestation_hash: terminal.attestation.core_hash,
    claim_scope: terminal.attestation.claim_scope,
    signer_inventory_hash: terminal.inventory.core_hash,
    public_bundle_hash: terminal.bundle.core_hash,
    public_bundle_path: "retained/public-bundle.json",
    derived_missing_roles: progress.missingRoles,
    derived_extra_hashes: progress.extraHashes,
  });
}

