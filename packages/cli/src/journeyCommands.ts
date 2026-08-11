/**
 * Journey commands: acquisition through frozen subject output (design v2
 * Appendix C).
 *
 * Each command is a separate process operating on durable run state. The
 * workspace recovers its lifecycle from frozen events, so ordering is enforced
 * by the state machine and the role-resolution rules rather than by anything
 * held in memory between commands.
 *
 * Fail-closed states this surface preserves:
 *   - only `--tier development` is accepted, because the fake subject port and
 *     the development beacon are the only ones qualified (ERL2-OQ-007);
 *   - `--keyring development` is the only keyring, and it derives deterministic
 *     labelled development keys — there is no production key path here.
 */

import {
  Erl2Error,
  CODES,
  parseStrictJson,
  type Hash,
  type LabLifecycleEventV1,
  type SelectionAssuranceV1,
  type SubjectAdapterCertificationReceiptV1,
  type SubjectAdapterManifestV1,
  type SubjectExecutionMode,
  type Tier,
} from "@erl2/contracts";
import {
  AdapterHost,
  AdmissionRegistry,
  verifyAdapterCertification,
  FakeSubjectPort,
  HostedSubjectPort,
  JOURNEY_PLANE_METRICS,
  loopbackEgressPolicy,
  type FakeSubjectBehaviour,
  RunWorkspace,
  SteppingClock,
  SystemClock,
  assertWorkspaceRunIdentity,
  newRunId,
  type Clock,
  type SubjectPort,
  type WorkspaceKeyring,
} from "@erl2/core";
import {
  ArtifactIndex,
  VERIFIER_RELEASE_HASH,
  assertClaimScopeWithinCeiling,
  deriveClaimCeiling,
  derivePreFinalizationClosure,
} from "@erl2/public-verifier";
import { ArtifactStore, developmentAgeIdentity, developmentKey } from "@erl2/integrity";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseFlags, requireString, type FlagSpec, type ParsedFlags } from "./args.js";
import { assembleSelection, loadSourceTrustConfig } from "./selectCommand.js";

export const COMMON_FLAGS: readonly FlagSpec[] = [
  { name: "run-root", kind: "string", required: true },
  { name: "registry", kind: "string", required: true },
  { name: "run", kind: "string" },
  { name: "tier", kind: "string" },
  { name: "keyring", kind: "string" },
  { name: "fake-acquire", kind: "string" },
  { name: "fake-verify-package", kind: "string" },
  { name: "adapter-entry", kind: "string" },
  { name: "adapter-certification", kind: "string" },
  { name: "fake-leak-canary", kind: "string" },
  { name: "fake-output-bytes", kind: "string" },
  { name: "fake-step-status", kind: "string" },
];

/**
 * The fake-subject-port scripting flags (`--fake-acquire`/`--fake-verify-package`)
 * are development-only shortcuts that steer test failpoints of the fake port.
 * They are NOT reachable on the default release surface (review §11.8, plan
 * §8.5, index.ts "no development-only shortcut is reachable"); they are enabled
 * only under an explicit, separate development profile signalled by the
 * `ERL2_DEVELOPMENT_FAKE_SUBJECT=1` environment variable.  A caller who passes a
 * fake flag without that profile is refused with a stable code — the flag can
 * never silently script a run on the release surface.
 */
function developmentFakeSubjectProfileEnabled(): boolean {
  return process.env["ERL2_DEVELOPMENT_FAKE_SUBJECT"] === "1";
}

function assertFakeFlagsUnavailableUnlessDevelopmentProfile(flags: ParsedFlags): void {
  const usesFakeFlag =
    flags["fake-acquire"] !== undefined ||
    flags["fake-verify-package"] !== undefined ||
    flags["fake-leak-canary"] !== undefined ||
    flags["fake-output-bytes"] !== undefined ||
    flags["fake-step-status"] !== undefined;
  if (usesFakeFlag && !developmentFakeSubjectProfileEnabled()) {
    throw new Erl2Error(
      CODES.CFG_DEVELOPMENT_FLAG_UNAVAILABLE,
      "--fake-acquire, --fake-verify-package, --fake-leak-canary, --fake-output-bytes and " +
        "--fake-step-status are " +
        "development-only shortcuts; they " +
        "require the explicit development profile (ERL2_DEVELOPMENT_FAKE_SUBJECT=1) and are not reachable " +
        "on the release surface",
    );
  }
}

function requireDevelopmentTier(flags: ParsedFlags): Tier {
  const tier = (flags["tier"] as string | undefined) ?? "development";
  if (tier !== "development") {
    throw new Erl2Error(
      CODES.ADMISSION_SUBJECT_PORT_NOT_DEVELOPMENT,
      `tier ${tier} is refused: held-out and blind execution is disabled pending ERL2-OQ-007`,
    );
  }
  return tier;
}

function developmentKeyring(flags: ParsedFlags): WorkspaceKeyring {
  const keyring = (flags["keyring"] as string | undefined) ?? "development";
  if (keyring !== "development") {
    throw new Erl2Error(
      CODES.CFG_MISSING_REQUIRED,
      `keyring ${keyring} is not available; only the labelled development keyring exists in this slice`,
    );
  }
  return {
    preregistrar: developmentKey("preregistrar"),
    finalizer: developmentKey("finalizer"),
    timestampAuthority: developmentKey("timestamp"),
    evaluator: developmentKey("evaluator"),
  };
}

/**
 * A run's post-acceptance artifacts are stamped by a clock anchored
 * deterministically on the durable preregistration time (`registered_at`), so a
 * replayed command rebuilds byte-identical records and step outcomes — the
 * re-freeze is idempotent rather than an `ARTIFACT_ALREADY_FROZEN` conflict
 * (P1-2 §7.3).  Preregistration itself (no prior run) is stamped with wall time
 * and is never replayed (each preregistration allocates a fresh run).
 */
function runClock(runRoot: string): Clock {
  const preregPath = path.join(path.resolve(runRoot), "retained", "acquisition-preregistration.json");
  if (existsSync(preregPath)) {
    try {
      const prereg = parseStrictJson(readFileSync(preregPath, "utf8")) as { registered_at?: unknown };
      if (typeof prereg.registered_at === "string") {
        return new SteppingClock(prereg.registered_at, 1000);
      }
    } catch {
      // Fall through to wall time; a torn prereg is caught later by the workspace.
    }
  }
  // Deterministic-evidence anchor: when generating pinned evidence, the
  // composition root sets `ERL2_EVIDENCE_CLOCK` to a fixed instant so
  // preregistration (which has no prior run to anchor on) is byte-reproducible.
  // This is an evidence/CI mechanism read only by the CLI composition root; core
  // still receives an injected clock (P2-10, plan §19.3).
  const evidenceClock = process.env["ERL2_EVIDENCE_CLOCK"];
  if (evidenceClock !== undefined && evidenceClock.length > 0) {
    return new SteppingClock(evidenceClock, 1000);
  }
  return new SystemClock();
}

/**
 * Opens an existing run workspace.
 *
 * The run identity is validated **first**, before the admission registry is
 * opened, before the subject port is constructed (which, with `--adapter-entry`,
 * creates an adapter workspace directory) and before `RunWorkspace` creates the
 * run root at all. `--run` and `--run-root` are one identity, not two
 * independent inputs (ADR-ERL2-024 §4.1, review P1-8).
 *
 * `allowBootstrap` is passed only by `preregister-acquisition`.
 */
export function openWorkspace(
  flags: ParsedFlags,
  runId: string,
  options: {
    readonly allowBootstrap?: boolean;
    /**
     * Wraps the subject port before the workspace holds it.
     *
     * Used only by the development-gated crash matrix, to count subject
     * invocations into a durable log that survives the `SIGKILL` the matrix
     * injects (ADR-ERL2-028 §7). Absent, the port is the production one,
     * unwrapped.
     */
    readonly wrapSubjectPort?: (port: SubjectPort) => SubjectPort;
    /**
     * How a real adapter reaches the run's real environment (ERL2-OQ-005).
     *
     * Supplied only by the environment commands, and only once a Compose run has
     * provisioned: the endpoint's host port is ephemeral, so it cannot be known
     * before then and cannot be guessed after. Absent — which is every fake-driver
     * run and every pre-provision command — the adapter host is constructed with
     * no mounts and the deny-by-default egress policy, exactly as before.
     */
    readonly environmentAccess?: EnvironmentAccess;
  } = {},
): RunWorkspace {
  const runRoot = requireString(flags, "run-root");
  assertWorkspaceRunIdentity({
    runRoot,
    runId,
    ...(options.allowBootstrap === true ? { allowBootstrap: true } : {}),
  });
  const registry = AdmissionRegistry.open(requireString(flags, "registry"));
  const clock = runClock(runRoot);
  return new RunWorkspace({
    runId,
    runRoot,
    registry,
    clock,
    keyring: developmentKeyring(flags),
    tier: requireDevelopmentTier(flags),
    subjectPort: (options.wrapSubjectPort ?? ((port: SubjectPort) => port))(
      subjectPort(flags, runId, runRoot, registry, clock, options.environmentAccess),
    ),
    ...(options.allowBootstrap === true ? { allowBootstrap: true } : {}),
  });
}

/**
 * The subject seam.
 *
 * With `--adapter-entry` the run drives a real, certified, out-of-process
 * adapter through the Slice 5 host — the same public protocol any opaque
 * subject uses. Without it the development-only fake port stands in, which the
 * tier gate confines to `--tier development`.
 */
/**
 * The one read-only mount and the one egress destination a subject needs to
 * interact with a real Compose environment (ERL2-OQ-005).
 *
 * Deliberately not an environment variable: the adapter environment allowlist is
 * a fail-closed gate and widening it would be a weakening. A read-only mount is
 * a surface the host already fingerprints and canary-scans, so the locator
 * travels the same way canonical evidence does.
 */
export interface EnvironmentAccess {
  readonly mountId: string;
  readonly mountRoot: string;
  readonly host: string;
  readonly port: number;
}

function subjectPort(
  flags: ParsedFlags,
  runId: string,
  runRoot: string,
  registry: AdmissionRegistry,
  clock: SystemClock,
  environmentAccess?: EnvironmentAccess,
): SubjectPort {
  // The frozen binding decides, before anything is constructed. This is the
  // single authoritative point at which a run's seam is enforced (ADR-ERL2-036).
  assertSubjectModeUnchanged(flags, runRoot);
  const entry = flags["adapter-entry"] as string | undefined;
  if (entry === undefined) {
    // A certification supplied to a run that dispatches no adapter would be
    // accepted, ignored, and never appear in the run's evidence — an operator
    // could reasonably read the exit code as "my adapter was certified". It is
    // refused rather than dropped.
    if (flags["adapter-certification"] !== undefined) {
      throw new Erl2Error(
        CODES.CFG_MISSING_REQUIRED,
        "--adapter-certification applies to a real adapter; without --adapter-entry this run " +
          "drives the development fake port, which executes no adapter bytes and certifies nothing",
      );
    }
    // The scripting flags are refused unless the explicit development profile is
    // enabled — they are not reachable on the release surface (§11.8).
    assertFakeFlagsUnavailableUnlessDevelopmentProfile(flags);
    return new FakeSubjectPort({
      ...fakeSubjectBehaviour(flags),
      // The fake subject answers `unsupported` for any journey intent its own
      // adapter manifest does not declare. That is a real outcome derived from
      // the subject's admitted declaration, not a scripted failpoint — and it is
      // what makes "every intent has a legal unsupported outcome" reachable on
      // the release surface, where the `--fake-*` flags are not.
      ...declaredOperations(flags, runRoot, registry),
    });
  }
  if (
    flags["fake-acquire"] !== undefined ||
    flags["fake-verify-package"] !== undefined ||
    flags["fake-output-bytes"] !== undefined
  ) {
    throw new Erl2Error(
      CODES.CFG_MISSING_REQUIRED,
      "--fake-acquire, --fake-verify-package and --fake-output-bytes script the development fake port; they cannot steer a real adapter",
    );
  }
  const manifest = registry.require<SubjectAdapterManifestV1>(
    adapterManifestHash(flags, runRoot),
    "SubjectAdapterManifestV1",
  );
  // Certification is required *before* the host exists, not checked afterwards:
  // constructing an `AdapterHost` is the point past which adapter bytes can be
  // dispatched, so an uncertified adapter must be refused on this side of it
  // (LIVE-001, ADR-ERL2-036).
  const receipt = registry.require<SubjectAdapterCertificationReceiptV1>(
    adapterCertificationReceiptHash(flags, runRoot),
    "SubjectAdapterCertificationReceiptV1",
  );
  // Certification is decided here — before the host exists. The entry's bytes
  // are re-verified by the host on every dispatch instead of once here, which
  // is the tighter place for it: it closes the window between this check and
  // the spawn, and the window between one operation and the next.
  verifyAdapterCertification({
    manifest,
    receipt,
    tier: requireDevelopmentTier(flags),
  });
  return new HostedSubjectPort(
    new AdapterHost({
      runId,
      adapterManifest: manifest,
      adapterEntryPath: entry,
      certifiedArtifactHash: receipt.adapter_artifact_hash,
      workspaceRoot: path.join(path.resolve(runRoot), "adapter-workspace"),
      store: new ArtifactStore(runRoot),
      clock,
      ...evidenceFixtureSandboxMeasurement(runRoot),
      ...(environmentAccess === undefined
        ? {}
        : {
            mounts: [
              {
                mountId: environmentAccess.mountId,
                absolutePath: environmentAccess.mountRoot,
                logicalPath: `environment/${environmentAccess.mountId}`,
                purpose: "subject-visible-input" as const,
              },
            ],
            egressPolicy: loopbackEgressPolicy(
              "erl2-environment-endpoint",
              environmentAccess.host,
              environmentAccess.port,
            ),
          }),
    }),
  );
}

/**
 * The retained `wall_clock_ms` a generated evidence fixture carries.
 *
 * Zero, because it is not a measurement and must not be mistaken for one. A real
 * sandbox invocation spawns two processes and exchanges frames, so it never
 * measures zero; a reader who sees this value is looking at a deliberately
 * generated fixture, not at how long anything took.
 */
const EVIDENCE_FIXTURE_SANDBOX_WALL_CLOCK_MS = 0;

/**
 * The evidence-fixture sandbox measurement override — an EVIDENCE MECHANISM, not
 * a timing control, and deliberately not a flag.
 *
 * `sandbox-invocation-result/v1` is retained, integrity-bound evidence, and its
 * `wall_clock_ms` is what the supervisor really measured. That is correct
 * production evidence and it is also, by construction, not byte-reproducible
 * between two generations of the pinned goldens. So the evidence harness — and
 * only the evidence harness — supplies one fixture value for the retained field.
 *
 * ## The activation condition, and why the obvious one was wrong
 *
 * The first version activated on the mere presence of `ERL2_EVIDENCE_CLOCK`, and
 * justified itself by saying the variable is set by the evidence harness and by
 * nothing on the release surface. That describes where the variable is *read*,
 * not what it *implies*, and the independent review measured the gap: `runClock`
 * prefers the durable preregistration's `registered_at`, so on any run that
 * already preregistered, setting the variable changes no timestamp — it only
 * zeroed the retained measurement. A run preregistered at real wall time could
 * therefore retain `wall_clock_ms: 0` between two timestamps two seconds apart,
 * and still verify.
 *
 * So presence is not enough. The run must **durably belong** to the same evidence
 * clock: its preregistration — written once, at preregistration time, and never
 * rewritten here — must be stamped with exactly this instant. An evidence run is
 * preregistered under the evidence clock, so `registered_at` is that instant
 * verbatim; a real run's `registered_at` is real wall time and can never be. The
 * condition is therefore unforgeable without fabricating the run's entire time
 * base, which is the same thing as generating evidence.
 *
 * Absent, malformed, real-time-stamped or mismatched preregistration all mean the
 * same thing: no override, and the observed supervisor duration is retained.
 *
 * There is no `--wall-clock-ms`-shaped flag and there must not be one: a
 * user-facing control over a retained measurement would let a run misstate what
 * it observed. Deadlines, process-tree termination, the spawn ceiling, response
 * byte caps, sandbox controls and certification are unaffected in every mode
 * (see `AdapterHostOptions`).
 */
function evidenceFixtureSandboxMeasurement(
  runRoot: string,
): { readonly evidenceFixtureWallClockMs?: number } {
  const evidenceClock = process.env["ERL2_EVIDENCE_CLOCK"];
  if (evidenceClock === undefined || evidenceClock.length === 0) return {};

  const preregPath = path.join(path.resolve(runRoot), "retained", "acquisition-preregistration.json");
  if (!existsSync(preregPath)) return {};
  let registeredAt: unknown;
  try {
    // Read, never rewritten or reinterpreted: this is the run's durable record
    // and the condition is a comparison against it, not an adjustment of it.
    registeredAt = (
      parseStrictJson(readFileSync(preregPath, "utf8")) as { registered_at?: unknown }
    ).registered_at;
  } catch {
    // A torn or malformed preregistration cannot establish evidence mode. The
    // workspace refuses it on its own account moments later.
    return {};
  }
  if (typeof registeredAt !== "string" || registeredAt !== evidenceClock) return {};
  return { evidenceFixtureWallClockMs: EVIDENCE_FIXTURE_SANDBOX_WALL_CLOCK_MS };
}

/**
 * Resolves the adapter manifest from durable state.
 *
 * After preregistration the run itself records which adapter it bound, so a
 * later command cannot substitute a different one by passing a flag.
 */
function adapterManifestHash(flags: ParsedFlags, runRoot: string): Hash {
  const preregPath = path.join(path.resolve(runRoot), "retained", "acquisition-preregistration.json");
  if (existsSync(preregPath)) {
    const prereg = parseStrictJson(readFileSync(preregPath, "utf8")) as {
      adapter_manifest_hash?: string;
    };
    const bound = prereg.adapter_manifest_hash;
    if (typeof bound === "string") {
      const supplied = flags["adapter"] as string | undefined;
      if (supplied !== undefined && supplied !== bound) {
        throw new Erl2Error(
          CODES.ADMISSION_ARTIFACT_UNKNOWN,
          "--adapter does not match the adapter this run preregistered; a run cannot substitute its adapter",
        );
      }
      return bound as Hash;
    }
  }
  return hash(flags, "adapter");
}

/**
 * Resolves the adapter certification receipt this run is bound to.
 *
 * Same discipline as {@link adapterManifestHash}: once the run has durably
 * retained a receipt, that is the one it uses, and a later command cannot
 * substitute a different certification by passing a flag. Only
 * `preregister-acquisition` — which has nothing retained yet — reads the flag.
 *
 * A real adapter with no receipt is refused here, before the host is built.
 */
function adapterCertificationReceiptHash(flags: ParsedFlags, runRoot: string): Hash {
  const supplied = flags["adapter-certification"] as string | undefined;
  const frozen = frozenSubjectBinding(runRoot);
  if (frozen?.receiptHash !== undefined) {
    // Authoritative. The receipt comes from the signed preregistration, never
    // from a flag: the independent review showed a run could otherwise
    // authorize receipt A on one command and receipt B on the next, with
    // neither inside the frozen boundary.
    if (supplied !== undefined && supplied !== frozen.receiptHash) {
      throw new Erl2Error(
        CODES.ADAPTER_CERTIFICATION_IDENTITY_MISMATCH,
        "--adapter-certification does not match the certification this run froze at " +
          "preregistration; a run cannot substitute its adapter's certification",
      );
    }
    return frozen.receiptHash;
  }
  if (supplied === undefined) {
    throw new Erl2Error(
      CODES.ADAPTER_CERTIFICATION_RECEIPT_REQUIRED,
      "--adapter-entry drives a real out-of-process adapter, which may not be dispatched " +
        "without its certification receipt: pass --adapter-certification HASH, admitted with " +
        "`erl2 admit-adapter`",
    );
  }
  return supplied as Hash;
}

/**
 * The subject seam and current receipt this run froze at preregistration.
 *
 * `undefined` only before preregistration — the one moment the run has not
 * chosen yet, and the only moment a flag may decide. Read from the retained,
 * signed `AcquisitionPreregistrationV1` rather than held in memory, so it
 * survives process exit, a fresh command, recovery and replay.
 */
interface FrozenSubjectBinding {
  readonly mode: SubjectExecutionMode;
  readonly receiptHash?: Hash;
}

function frozenSubjectBinding(runRoot: string): FrozenSubjectBinding | undefined {
  const preregPath = path.join(
    path.resolve(runRoot),
    "retained",
    "acquisition-preregistration.json",
  );
  if (!existsSync(preregPath)) return undefined;
  const prereg = parseStrictJson(readFileSync(preregPath, "utf8")) as {
    subject_execution_mode?: unknown;
    adapter_certification_receipt_hash?: unknown;
  };
  const mode = prereg.subject_execution_mode;
  if (mode !== "development_fake_port" && mode !== "external_adapter") return undefined;
  const receipt = prereg.adapter_certification_receipt_hash;
  return {
    mode,
    ...(typeof receipt === "string" ? { receiptHash: receipt as Hash } : {}),
  };
}

/**
 * Refuses any later command that tries to change the seam the run froze.
 *
 * This is the **single authoritative enforcement point** for LIVE-001's P1: a
 * fake-port run cannot acquire a real adapter, and a real run cannot quietly
 * drop back to the fake port by omitting a flag. Removing it is what the
 * campaign red control and `MODE-FROZEN` tests detect.
 */
function assertSubjectModeUnchanged(flags: ParsedFlags, runRoot: string): void {
  const frozen = frozenSubjectBinding(runRoot);
  if (frozen === undefined) return;
  const entry = flags["adapter-entry"] as string | undefined;
  if (frozen.mode === "development_fake_port") {
    if (entry !== undefined) {
      throw new Erl2Error(
        CODES.ADMISSION_SUBJECT_EXECUTION_MODE_FROZEN,
        "this run preregistered the development fake port, which executes no adapter bytes; " +
          "--adapter-entry cannot introduce a real adapter into it",
      );
    }
    if (flags["adapter-certification"] !== undefined) {
      throw new Erl2Error(
        CODES.ADMISSION_SUBJECT_EXECUTION_MODE_FROZEN,
        "this run preregistered the development fake port and bound no certification; " +
          "--adapter-certification cannot be added to it",
      );
    }
    return;
  }
  if (entry === undefined) {
    throw new Erl2Error(
      CODES.ADMISSION_SUBJECT_EXECUTION_MODE_FROZEN,
      "this run preregistered a real external adapter; omitting --adapter-entry would run it " +
        "on the development fake port, which is a downgrade the frozen binding forbids",
    );
  }
}

/**
 * The operations the run's own adapter manifest declares, when the run has
 * durably bound one. Before preregistration there is nothing to read, and the
 * port simply has no declaration to answer from.
 */
function declaredOperations(
  flags: ParsedFlags,
  runRoot: string,
  registry: AdmissionRegistry,
): { readonly declaredOperations?: readonly string[] } {
  let manifestHash: Hash;
  try {
    manifestHash = adapterManifestHash(flags, runRoot);
  } catch {
    return {};
  }
  if (registry.tryGet(manifestHash) === undefined) return {};
  const manifest = registry.require<SubjectAdapterManifestV1>(manifestHash, "SubjectAdapterManifestV1");
  return { declaredOperations: manifest.operations };
}

/**
 * Scripted fake-subject behaviour, for exercising failure paths from the CLI.
 * It exists only because the fake port is development-only; the slice 5 adapter
 * host has no such flag.
 */
function fakeSubjectBehaviour(flags: ParsedFlags): FakeSubjectBehaviour {
  const acquire = flags["fake-acquire"] as string | undefined;
  const verify = flags["fake-verify-package"] as string | undefined;
  if (acquire !== undefined && acquire !== "succeeded" && acquire !== "failed") {
    throw new Erl2Error(CODES.CFG_MISSING_REQUIRED, "--fake-acquire must be succeeded or failed");
  }
  if (
    verify !== undefined &&
    verify !== "succeeded" &&
    verify !== "failed" &&
    verify !== "unsupported"
  ) {
    throw new Erl2Error(
      CODES.CFG_MISSING_REQUIRED,
      "--fake-verify-package must be succeeded, failed or unsupported",
    );
  }
  const leak = flags["fake-leak-canary"] as string | undefined;
  return {
    ...stepStatus(flags),
    ...(acquire === undefined ? {} : { acquireStatus: acquire }),
    ...(verify === undefined ? {} : { packageVerificationStatus: verify }),
    ...(leak === undefined ? {} : { leakCanaryId: leak }),
    ...outputByteLength(flags),
  };
}

/**
 * `--fake-output-bytes <n>`, the development-only way to give the fake subject's
 * step output an exact byte length.
 *
 * The declared subject-output ceiling is 64 MiB and is frozen in the run's own
 * execution plan. Without a way to produce a payload of a chosen size, "one byte
 * over is refused, exactly at the ceiling is admitted" could only ever be
 * asserted about a helper function. This steers the *subject's* bytes; it cannot
 * move the ceiling they are measured against.
 */
function outputByteLength(flags: ParsedFlags): { readonly outputByteLength?: number } {
  const raw = flags["fake-output-bytes"] as string | undefined;
  if (raw === undefined) return {};
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Erl2Error(
      CODES.CFG_MISSING_REQUIRED,
      "--fake-output-bytes must be a non-negative safe integer",
    );
  }
  return { outputByteLength: value };
}

/**
 * `--fake-step-status <intent>=<status>`, the development-only way to make one
 * journey intent fail or come back unsupported.
 *
 * It exists so a property like "activation requires a *succeeded* connect" can be
 * proven rather than asserted. Without it the only reachable case is a connect
 * that never ran, which exercises the guard's undefined half and leaves its
 * succeeded half untested — which is exactly what the negative-control campaign
 * caught.
 */
function stepStatus(flags: ParsedFlags): {
  readonly stepStatus?: NonNullable<FakeSubjectBehaviour["stepStatus"]>;
} {
  const raw = flags["fake-step-status"] as string | undefined;
  if (raw === undefined) return {};
  const [intent, status] = raw.split("=");
  if (
    intent === undefined ||
    (status !== "succeeded" && status !== "failed" && status !== "unsupported")
  ) {
    throw new Erl2Error(
      CODES.CFG_MISSING_REQUIRED,
      "--fake-step-status must be <intent>=succeeded|failed|unsupported",
    );
  }
  return {
    stepStatus: { [intent]: status } as NonNullable<FakeSubjectBehaviour["stepStatus"]>,
  };
}

/** A repeated `--flag <hash>`, validated exactly as a single `hash()` is. */
function hashList(flags: ParsedFlags, name: string): readonly Hash[] {
  const values = flags[name];
  if (!Array.isArray(values) || values.length === 0) {
    throw new Erl2Error(CODES.CFG_MISSING_REQUIRED, `flag --${name} is required`);
  }
  const seen = new Set<string>();
  return values.map((value) => {
    if (!/^sha256:[0-9a-f]{64}$/.test(value)) {
      throw new Erl2Error(CODES.CFG_MISSING_REQUIRED, `--${name} must be a sha256 core hash`);
    }
    if (seen.has(value)) {
      throw new Erl2Error(CODES.CFG_DUPLICATE_FLAG, `--${name} names ${value} more than once`);
    }
    seen.add(value);
    return value as Hash;
  });
}

function hash(flags: ParsedFlags, name: string): Hash {
  const value = requireString(flags, name);
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new Erl2Error(CODES.CFG_MISSING_REQUIRED, `--${name} must be a sha256 core hash`);
  }
  return value as Hash;
}

export interface JourneyCommandOutput {
  readonly runId: string;
  readonly state: string;
  readonly data: Record<string, unknown>;
  /**
   * Set when the run reached a *terminal* through a typed failure.
   *
   * The command still returns its record hashes — Appendix C forbids returning
   * a terminal run state without them — but the CLI exits on the failure's own
   * code so a caller cannot mistake "invalidated cleanly" for "succeeded".
   */
  readonly terminalError?: Erl2Error;
}

/**
 * Freezes the invalid terminal for an adapter-owned failure.
 *
 * The order is the design's: detection, then bounded cleanup from the actual
 * resource frontier, then exactly one invalid record. No attestation and no
 * bundle can descend from it.
 */
function invalidateAfterAdapterFailure(
  workspace: RunWorkspace,
  runId: string,
  phase: "acquisition" | "package_verification",
  cause: Erl2Error,
): JourneyCommandOutput {
  const findingHash = workspace.freezeAdapterFailureFinding({
    findingId: "adapter-protocol-failure",
    category: "adapter_protocol_failure",
    summary: `${cause.code}: ${cause.message}`,
    proofRefs: [workspace.requireHashForRole("acquisition-preregistration")],
  });
  const failureEvent = workspace.lifecycle.find((e) => e.failure !== undefined);
  const invalid = workspace.invalidate({
    phase,
    // An adapter that never produced a response left no step event behind, so
    // the detection event carries the failure itself.
    ...(failureEvent === undefined
      ? {
          failure: {
            code: cause.code,
            owner: "adapter" as const,
            message: cause.message.slice(0, 512),
          },
        }
      : { failureEventHash: failureEvent.core_hash }),
    primaryFindingHash: findingHash,
    classification: "adapter_failure",
  });
  return {
    runId,
    state: workspace.lifecycle.currentState,
    data: {
      invalid_run_record_hash: invalid.core_hash,
      terminal_state: invalid.terminal_state,
      cleanup_variant: invalid.cleanup.variant,
      adapter_failure_finding_hash: findingHash,
      refusal_code: cause.code,
    },
    terminalError: cause,
  };
}

export function preregisterAcquisition(argv: readonly string[]): JourneyCommandOutput {
  const flags = parseFlags(argv, [
    ...COMMON_FLAGS,
    { name: "acquisition-source", kind: "string", required: true },
    { name: "adapter", kind: "string", required: true },
    { name: "acquisition-actor-script", kind: "string", required: true },
    { name: "acquisition-actor-schema", kind: "string", required: true },
    { name: "acquisition-step", kind: "string", required: true },
    { name: "package-verification-step", kind: "string", required: true },
    { name: "generic-policy", kind: "string", required: true },
    { name: "trust-policy", kind: "string", required: true },
    { name: "limits", kind: "string", required: true },
    { name: "expires", kind: "string", required: true },
  ]);
  const runId = (flags["run"] as string | undefined) ?? newRunId();
  // The one command that legitimately brings a run root into being: it is what
  // writes the workspace identity every later command validates against.
  const workspace = openWorkspace(flags, runId, { allowBootstrap: true });
  const preregistration = workspace.preregisterAcquisition({
    sourceManifestHash: hash(flags, "acquisition-source"),
    adapterManifestHash: hash(flags, "adapter"),
    genericRunPolicyHash: hash(flags, "generic-policy"),
    runTrustPolicyHash: hash(flags, "trust-policy"),
    acquisitionActorScriptHash: hash(flags, "acquisition-actor-script"),
    acquisitionActorSchemaHash: hash(flags, "acquisition-actor-schema"),
    acquisitionStepCommitmentHash: hash(flags, "acquisition-step"),
    packageVerificationStepCommitmentHash: hash(flags, "package-verification-step"),
    limitsHash: hash(flags, "limits"),
    expiresAt: requireString(flags, "expires"),
    // Bound only when this run will drive a real adapter. The development fake
    // port executes no adapter bytes, so it has nothing to certify — and
    // binding a receipt it never uses would be a claim, not evidence.
    subjectExecutionMode:
      flags["adapter-entry"] === undefined ? "development_fake_port" : "external_adapter",
    ...(flags["adapter-entry"] === undefined
      ? {}
      : { adapterCertificationReceiptHash: adapterCertificationReceiptHash(flags, requireString(flags, "run-root")) }),
  });
  return {
    runId,
    state: workspace.lifecycle.currentState,
    data: {
      acquisition_preregistration_hash: preregistration.core_hash,
      selected_case_identity: preregistration.selected_case_identity,
    },
  };
}

export function acquire(argv: readonly string[]): JourneyCommandOutput {
  const flags = parseFlags(argv, COMMON_FLAGS);
  const runId = requireString(flags, "run");
  const workspace = openWorkspace(flags, runId);

  let record;
  try {
    record = workspace.acquire();
  } catch (cause) {
    // Failure ownership (design §20, review §7.5): only an *adapter*-owned
    // failure (timeout, crash, protocol violation) becomes an adapter finding
    // and invalid record.  A Lab-owned failure — a lease conflict, an
    // `ARTIFACT_ALREADY_FROZEN` persistence conflict (which defaults to owner
    // `lab`), a closure failure — must NOT be laundered into a fabricated
    // adapter finding; it propagates as the Lab error it is.  A subject-owned
    // outcome is handled on the normal path, not here.
    if (!(cause instanceof Erl2Error) || cause.owner !== "adapter") throw cause;
    return invalidateAfterAdapterFailure(workspace, runId, "acquisition", cause);
  }

  const data: Record<string, unknown> = {
    acquisition_record_hash: record.core_hash,
    status: record.status,
    attempts: record.attempts.length,
    active_operator_ms: record.active_operator_ms,
    elapsed_ms: record.elapsed_ms,
    documentation_step_ids: record.documentation_step_ids,
    authentication_prompt_count: record.authentication_prompt_count,
  };

  if (record.status !== "completed") {
    // Design v2 Appendix C: once a run id is durably accepted, the CLI may not
    // return a terminal state without its record hash. A failed acquisition
    // freezes subject output, runs bounded pre-environment cleanup and freezes
    // exactly one invalid record.
    workspace.freezeSubjectOutput({ terminalStage: "acquire" });
    const failureEvent = workspace.lifecycle.find((e) => e.failure !== undefined);
    const findingHash = workspace.freezeInvalidityFinding({
      findingId: "subject-acquisition-failure",
      category: "lab_evidence_failure",
      summary: "Acquisition did not complete; the run has no package to verify.",
      failedGateIds: ["acquisition-completed"],
      proofRefs: [record.core_hash],
    });
    const invalid = workspace.invalidate({
      phase: "acquisition",
      failureEventHash: failureEvent?.core_hash ?? record.core_hash,
      primaryFindingHash: findingHash,
      classification: "dependency_failure",
    });
    data["invalid_run_record_hash"] = invalid.core_hash;
    data["terminal_state"] = invalid.terminal_state;
    data["cleanup_variant"] = invalid.cleanup.variant;
  }

  return { runId, state: workspace.lifecycle.currentState, data };
}

export function freezePackage(argv: readonly string[]): JourneyCommandOutput {
  const flags = parseFlags(argv, COMMON_FLAGS);
  const runId = requireString(flags, "run");
  const workspace = openWorkspace(flags, runId);
  const ref = workspace.freezePackage();
  return {
    runId,
    state: workspace.lifecycle.currentState,
    data: { frozen_package_path: ref.path, frozen_package_file_sha256: ref.file_sha256 },
  };
}

export function verifyPackage(argv: readonly string[]): JourneyCommandOutput {
  const flags = parseFlags(argv, [
    ...COMMON_FLAGS,
    { name: "subject-id", kind: "string", required: true },
    { name: "subject-version", kind: "string", required: true },
  ]);
  const runId = requireString(flags, "run");
  const workspace = openWorkspace(flags, runId);
  const record = workspace.verifyPackage();
  const data: Record<string, unknown> = {
    package_verification_record_hash: record.core_hash,
    status: record.status,
  };
  if (record.status === "completed") {
    const manifest = workspace.freezePackageManifest({
      subjectId: requireString(flags, "subject-id"),
      subjectVersion: requireString(flags, "subject-version"),
    });
    data["subject_package_manifest_hash"] = manifest.core_hash;
    data["package_file_sha256"] = manifest.package_file_sha256;
    // ADR-ERL2-013: a successful package manifest has exactly one authorized
    // continuation, so the response says so rather than leaving a caller to
    // discover it by attempting a forbidden early terminal.
    data["next_authorized_state"] = "challenge_preregistered";
  }
  return { runId, state: workspace.lifecycle.currentState, data };
}

/**
 * `erl2 reveal` — opens the committed judge expectations for the failed and
 * unsupported steps, after the subject output has frozen.
 *
 * The judge identity is a development-only, label-derived age identity, and the
 * vault is a directory the governor prepared; neither is reachable from a
 * subject or an adapter. Functional truth stays sealed: the workspace refuses to
 * open an expectation whose committed `truth_scope` is `functional`.
 */
export function reveal(argv: readonly string[]): JourneyCommandOutput {
  const flags = parseFlags(argv, [
    ...COMMON_FLAGS,
    { name: "vault", kind: "string", required: true },
    { name: "judge-identity", kind: "string" },
  ]);
  const runId = requireString(flags, "run");
  const workspace = openWorkspace(flags, runId);
  const label = (flags["judge-identity"] as string | undefined) ?? "judge";
  const revealed = workspace.revealJudgeExpectations({
    vaultRoot: requireString(flags, "vault"),
    judgeIdentity: developmentAgeIdentity(label),
  });
  return {
    runId,
    state: workspace.lifecycle.currentState,
    data: {
      reveal_record_hash: revealed.recordHash,
      revealed_expectation_hashes: revealed.revealedExpectationHashes,
      revealed_count: revealed.revealedExpectationHashes.length,
    },
  };
}

/**
 * `erl2 evaluate` — freezes the journey result, exactly one domain result and
 * the pre-cleanup result join.
 *
 * A pre-environment terminal has no functional evidence, so the domain plane is
 * not applicable with the exact reason `pre_environment_terminal`. The join is
 * the sole cleanup-entry guard, and its ordering is re-derived from the
 * lifecycle chain before this command returns.
 */
export function evaluate(argv: readonly string[]): JourneyCommandOutput {
  const flags = parseFlags(argv, [...COMMON_FLAGS, { name: "finding", kind: "string" }]);
  const runId = requireString(flags, "run");
  const workspace = openWorkspace(flags, runId);
  const revealed = workspace.hashForRole("judge-expectation-reveal");
  const revealRecord =
    revealed === undefined
      ? { revealed_expectation_hashes: [] as Hash[] }
      : workspace.artifact<{ revealed_expectation_hashes: Hash[] }>(
          revealed,
          "JudgeExpectationRevealRecordV1",
        );
  const result = workspace.evaluatePreEnvironment({
    revealedExpectationHashes: revealRecord.revealed_expectation_hashes,
    journeyMetricDefinitions: JOURNEY_PLANE_METRICS,
    findingHashes: workspace.retainedFindingHashes(),
  });
  return {
    runId,
    state: workspace.lifecycle.currentState,
    data: {
      journey_result_hash: result.journeyResult.core_hash,
      journey_status: result.journeyResult.status,
      domain_result_hash: result.domainResult.core_hash,
      domain_status: result.domainResult.status,
      domain_not_applicable_reason: result.domainResult.reason,
      precleanup_result_join_hash: result.join.core_hash,
      domain_variant: result.join.domain_variant,
      metric_result_hashes: result.metricResults.map((m) => m.core_hash),
      metric_results: result.metricResults.map((m) => ({
        metric_id: m.metric_id,
        status: m.status,
        value: m.value ?? null,
        threshold_class: m.threshold_class,
      })),
    },
  };
}

/**
 * Resolves the scope a terminal is signed with (ADR-ERL2-025 §4.4).
 *
 * With no `--claim-scope`, the earned scope is derived and used. With one, it is
 * a **requested upper bound**: a request weaker than the evidence is honoured
 * exactly as asked, and a request stronger than the evidence is refused rather
 * than quietly capped. Capping would be the worse behaviour of the two — an
 * operator who typed `T3` and got a signed `T1` back has been told nothing, and
 * would go on believing the run supported the claim.
 *
 * The derivation is the offline verifier's, injected rather than reimplemented,
 * so a scope this accepts is a scope that verifier accepts.
 */
export function resolveClaimScope(options: {
  readonly requested: string | undefined;
  readonly index: ArtifactIndex;
  readonly lifecycle: readonly LabLifecycleEventV1[];
  readonly terminalVariant: "pre_environment" | "environment";
  readonly selectionAssurance?: SelectionAssuranceV1;
}): "T1" | "T2" | "T3" {
  const report = deriveClaimCeiling({
    index: options.index,
    lifecycle: options.lifecycle,
    terminalVariant: options.terminalVariant,
    ...(options.selectionAssurance === undefined
      ? {}
      : { selectionAssurance: options.selectionAssurance }),
  });
  if (options.requested === undefined) return report.ceiling;
  if (options.requested !== "T1" && options.requested !== "T2" && options.requested !== "T3") {
    throw new Erl2Error(
      CODES.CFG_MISSING_REQUIRED,
      "--claim-scope must be T1, T2 or T3; a base attestation never emits T4",
    );
  }
  assertClaimScopeWithinCeiling({
    claimScope: options.requested,
    report,
    who: "--claim-scope",
  });
  return options.requested;
}

/**
 * `erl2 finalize-generic` — cleanup, validity, generic index, terminal run
 * record, attestation and public bundle, in the design's order.
 *
 * The closure is derived by the *offline verifier's own algorithm* before the
 * finalizer signs anything, so a missing role or an unaccounted retained
 * artifact refuses finalization rather than producing a bundle that fails
 * verification later.
 */
export function finalizeGeneric(argv: readonly string[]): JourneyCommandOutput {
  const flags = parseFlags(argv, [...COMMON_FLAGS, { name: "claim-scope", kind: "string" }]);
  const runId = requireString(flags, "run");
  const runRoot = requireString(flags, "run-root");
  const workspace = openWorkspace(flags, runId);
  const claimScope = resolveClaimScope({
    requested: flags["claim-scope"] as string | undefined,
    index: ArtifactIndex.scan(runRoot),
    lifecycle: workspace.lifecycle.all(),
    terminalVariant: "pre_environment",
  });
  const finalized = workspace.finalizeGeneric({
    claimScope,
    deriveClosure: (runRecord) =>
      derivePreFinalizationClosure({
        lifecycle: workspace.lifecycle.all(),
        index: ArtifactIndex.scan(runRoot),
        verifierReleaseHash: VERIFIER_RELEASE_HASH,
        verifiedAt: new SystemClock().now(),
        runRecord,
      }),
  });
  return {
    runId,
    state: workspace.lifecycle.currentState,
    data: {
      run_record_hash: finalized.runRecord.core_hash,
      terminal_stage: finalized.runRecord.terminal_stage,
      validity_result_hash: finalized.validity.core_hash,
      validity_status: finalized.validity.status,
      generic_evaluation_index_hash: finalized.index.core_hash,
      final_attestation_hash: finalized.attestation.core_hash,
      claim_scope: finalized.attestation.claim_scope,
      public_bundle_hash: finalized.bundle.core_hash,
      public_bundle_path: "retained/public-bundle.json",
    },
  };
}

export function freezeOutput(argv: readonly string[]): JourneyCommandOutput {
  const flags = parseFlags(argv, [
    ...COMMON_FLAGS,
    { name: "terminal-stage", kind: "string", required: true },
  ]);
  const runId = requireString(flags, "run");
  const workspace = openWorkspace(flags, runId);
  const stage = requireString(flags, "terminal-stage");
  if (stage !== "acquire" && stage !== "verify_package") {
    throw new Erl2Error(
      CODES.CFG_MISSING_REQUIRED,
      "--terminal-stage must be acquire or verify_package for a pre-environment terminal",
    );
  }
  const manifest = workspace.freezeSubjectOutput({ terminalStage: stage });
  return {
    runId,
    state: workspace.lifecycle.currentState,
    data: {
      subject_output_hash: manifest.core_hash,
      terminal_stage: manifest.terminal_stage,
      step_outcome_hashes: manifest.step_outcome_hashes,
      tree_hash: manifest.tree_hash,
    },
  };
}

/**
 * `erl2 cancel` — the mandatory cancellation terminal (design v2 §12).
 *
 * Any durably accepted, non-terminal run may be cancelled: it freezes signed
 * cancellation evidence and exactly one `InvalidLabRunRecordV1` (no fabricated
 * finding), then exits on the cancellation class (12).  Cancelling a run that
 * was never accepted, or one already terminal, is refused with its own code.
 */
export function cancel(argv: readonly string[]): JourneyCommandOutput {
  const flags = parseFlags(argv, [
    ...COMMON_FLAGS,
    { name: "reason", kind: "string", required: true },
    { name: "actor", kind: "string" },
  ]);
  const runId = requireString(flags, "run");
  const workspace = openWorkspace(flags, runId);
  const record = workspace.cancel({
    reasonCode: requireString(flags, "reason"),
    requestedByActorId: (flags["actor"] as string | undefined) ?? "operator",
  });
  return {
    runId,
    state: workspace.lifecycle.currentState,
    data: {
      invalid_run_record_hash: record.core_hash,
      terminal_state: record.terminal_state,
      cleanup_variant: record.cleanup.variant,
      cancelled_during: record.failed_phase.kind === "cancellation" ? record.failed_phase.cancelled_during : undefined,
    },
    // A cancelled run still returns its record hash (Appendix C) but exits on the
    // cancellation class so a caller cannot read it as success.
    terminalError: new Erl2Error(CODES.CANCELLATION_REQUESTED, "run cancelled at operator request"),
  };
}

/**
 * `erl2 preregister-challenge` — the one authorized continuation of a
 * successful package verification (ADR-ERL2-013), and the state `select`
 * departs from.
 *
 * `--challenge` is repeatable and names the admitted challenge family by core
 * hash. The whole family is frozen; nothing here picks a member. Which one the
 * run answers is decided only by `select`, from beacon randomness, which is what
 * makes the later selection checkable offline.
 */
export function preregisterChallenge(argv: readonly string[]): JourneyCommandOutput {
  const flags = parseFlags(argv, [
    ...COMMON_FLAGS,
    { name: "journey-selection-policy", kind: "string", required: true },
    { name: "randomness-policy", kind: "string", required: true },
    { name: "challenge", kind: "string-list", required: true },
  ]);
  const runId = requireString(flags, "run");
  const workspace = openWorkspace(flags, runId);
  const challengeManifestHashes = hashList(flags, "challenge");
  const result = workspace.preregisterChallenge({
    journeySelectionPolicyHash: hash(flags, "journey-selection-policy"),
    randomnessPolicyHash: hash(flags, "randomness-policy"),
    challengeManifestHashes,
  });
  return {
    runId,
    state: workspace.lifecycle.currentState,
    data: {
      challenge_family_size: result.challengeFamilyHashes.length,
      challenge_manifest_hashes: result.challengeFamilyHashes,
    },
  };
}

/**
 * `erl2 select` — advance the durable selection walk (ADR-ERL2-020 §6).
 *
 * Idempotent and resumable by construction: it continues from whatever the last
 * process durably reached, and a completed selection is a no-op. `--max-steps`
 * exists so an operator (and the crash suite) can stop at a chosen boundary; it
 * bounds work, it never skips a step.
 */
export function select(argv: readonly string[]): JourneyCommandOutput {
  const flags = parseFlags(argv, [
    ...COMMON_FLAGS,
    { name: "source-trust-config", kind: "string", required: true },
    { name: "expires", kind: "string", required: true },
    { name: "max-steps", kind: "string" },
  ]);
  const runId = requireString(flags, "run");
  const workspace = openWorkspace(flags, runId);

  const rawMax = flags["max-steps"] as string | undefined;
  const maxSteps = rawMax === undefined ? Number.POSITIVE_INFINITY : Number(rawMax);
  if (!Number.isInteger(maxSteps) && maxSteps !== Number.POSITIVE_INFINITY) {
    throw new Erl2Error(CODES.CFG_MISSING_REQUIRED, "--max-steps must be an integer");
  }

  const { ctx, prelude } = assembleSelection({
    workspace,
    sourceTrust: loadSourceTrustConfig(requireString(flags, "source-trust-config")),
    expiresAt: requireString(flags, "expires"),
  });
  const result = workspace.advanceSelection(ctx, maxSteps, prelude);
  // The design's own last selection transition: `selection_receipt_verified ->
  // case_selected`, which checks the opened binding against the admitted
  // challenge family. It counts against `--max-steps` like every other durable
  // transition, so the crash matrix can stop in front of it.
  const cased =
    result.stepsRun < maxSteps
      ? workspace.advanceCaseSelection()
      : { state: result.state, stepsRun: 0 };
  const stepsRun = result.stepsRun + cased.stepsRun;

  const bindingHash = workspace.hashForRole("selected-challenge-journey-binding");
  return {
    runId,
    state: cased.state,
    data: {
      steps_run: stepsRun,
      selection_complete: cased.state === "case_selected",
      ...(bindingHash === undefined ? {} : { selected_binding_hash: bindingHash }),
      ...(workspace.hashForRole("selection-verification-receipt") === undefined
        ? {}
        : { selection_receipt_hash: workspace.hashForRole("selection-verification-receipt") }),
    },
  };
}
