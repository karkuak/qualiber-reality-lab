/**
 * `ADAPTER-CERT-V1` — the certification harness (design v2 §11.3,
 * implementation plan §11.2).
 *
 * Certification runs a **fake core** and hostile fixtures against a candidate
 * adapter through exactly the public protocol any subject would use. It
 * certifies an adapter version and digest; it never certifies subject quality,
 * and it grants no authority over truth, selection or validity.
 *
 * An adapter cannot self-certify: `certifier_id` must differ from the adapter's
 * owner, and `certifier_is_adapter_owner` is a schema constant `false`.
 *
 * Every check is a `AdapterCertificationFindingV1`. A failed check carries a
 * stable refusal code, and any failure makes the verdict `refused` — there is
 * no score, no partial credit and no override.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assertContract,
  CODES,
  Erl2Error,
  type AdapterCertificationFindingV1,
  type Hash,
  type SubjectAdapterCertificationReceiptV1,
  type SubjectAdapterManifestV1,
} from "@erl2/contracts";
import { ArtifactStore, coreHash, hashBytes, sealSigned, type SigningKey } from "@erl2/integrity";
import type { Clock } from "../runtime/seams.js";
import { AdapterHost } from "./host.js";
import { isPrivilegedCapability } from "./capabilities.js";
import type { AdapterModuleDirectory } from "./containerLauncher.js";
import {
  enforcedControls,
  unsupportedControls,
  type ContainerProfileActivation,
  type SandboxProfileId,
} from "./sandbox.js";

export interface CertifyAdapterOptions {
  readonly adapterManifest: SubjectAdapterManifestV1;
  readonly adapterEntryPath: string;
  readonly clock: Clock;
  /** Must not be the adapter owner; an adapter cannot certify itself. */
  readonly certifierId: string;
  readonly certifierKey?: SigningKey;
  readonly runId?: string;
  /**
   * The sandbox profile every check runs under; defaults to `local-process`.
   *
   * ADR-ERL2-017 §Decision 4 named "the certification suite passes under the
   * qualified profile" as the §5.5 exit gate that had never been met, because
   * no launcher could place an adapter there. Running the suite under
   * `container` is what meets it — and the receipt then records the controls
   * *that* profile enforced, not the process profile's, so a container
   * certification cannot be read off a local one or the reverse.
   */
  readonly profile?: SandboxProfileId;
  /** Required when `profile` is `container`; see `AdapterHostOptions`. */
  readonly containerActivation?: ContainerProfileActivation;
  /** Required when `profile` is `container`; see `AdapterHostOptions`. */
  readonly containerAdapterPackage?: {
    readonly packageRoot: string;
    readonly moduleDirectories: readonly AdapterModuleDirectory[];
  };
}

type Finding = AdapterCertificationFindingV1;

const CERT_RUN_ID = "01890000-0000-7000-8000-0000000000ce";

function pass(check_id: string, detail: string, severity: Finding["severity"] = "info"): Finding {
  return { check_id, status: "passed", severity, detail };
}

function fail(
  check_id: string,
  detail: string,
  refusal_code: string,
  severity: Finding["severity"] = "high",
): Finding {
  return { check_id, status: "failed", severity, detail: detail.slice(0, 1024), refusal_code };
}

function notApplicable(check_id: string, detail: string): Finding {
  return { check_id, status: "unsupported", severity: "info", detail };
}

/** A minimal, structurally valid acquisition request for the fake core. */
function fakeAcquisitionRequest(runId: string, operationId: string, extra: Record<string, unknown> = {}): unknown {
  const base = {
    schema_version: "acquisition-adapter-request/v1" as const,
    protocol_version: "subject-adapter/v1" as const,
    run_id: runId,
    operation_id: operationId,
    acquisition_preregistration_hash: `sha256:${"1".repeat(64)}`,
    acquisition_source_manifest_hash: `sha256:${"2".repeat(64)}`,
    adapter_manifest_hash: `sha256:${"3".repeat(64)}`,
    visible_step: {
      artifact: {
        path: "subject-visible/steps/certification.json",
        media_type: "application/json",
        byte_length: 2,
        file_sha256: `sha256:${"4".repeat(64)}`,
        classification: "PUBLIC" as const,
      },
      core_hash: `sha256:${"5".repeat(64)}`,
    },
    credential_handle_ids: [] as string[],
    resource_limit_hash: `sha256:${"6".repeat(64)}`,
    deadline: "2030-01-01T00:00:00Z",
    ...extra,
  };
  return { ...base, core_hash: coreHash(base) };
}

/** A minimal package-verification request naming a package kind. */
function fakePackageRequest(runId: string, operationId: string, packageKind: string): unknown {
  const base = {
    schema_version: "package-verification-request/v1" as const,
    protocol_version: "subject-adapter/v1" as const,
    run_id: runId,
    operation_id: operationId,
    acquisition_preregistration_hash: `sha256:${"1".repeat(64)}`,
    acquisition_record_hash: `sha256:${"2".repeat(64)}`,
    frozen_acquired_artifact: {
      path: `retained/package-store/sha256/${"7".repeat(64)}.bin`,
      media_type: "application/octet-stream",
      byte_length: 8,
      file_sha256: `sha256:${"7".repeat(64)}`,
      classification: "INTERNAL" as const,
    },
    frozen_package_file_sha256: `sha256:${"7".repeat(64)}`,
    integrity_policy_hash: `sha256:${"8".repeat(64)}`,
    provenance_policy_hash: `sha256:${"9".repeat(64)}`,
    adapter_manifest_hash: `sha256:${"3".repeat(64)}`,
    visible_step: {
      artifact: {
        path: `subject-visible/steps/certification-${packageKind}.json`,
        media_type: "application/json",
        byte_length: 2,
        file_sha256: `sha256:${"4".repeat(64)}`,
        classification: "PUBLIC" as const,
      },
      core_hash: `sha256:${"5".repeat(64)}`,
    },
    deadline: "2030-01-01T00:00:00Z",
  };
  return { ...base, core_hash: coreHash(base) };
}

/**
 * A certification host, with both of its temporary roots recorded for teardown.
 *
 * A certification run builds up to eight hosts, each with a workspace and an
 * artifact store, and every one of them used to be abandoned where it was
 * created. Small per call and unbounded over time — this is the production half
 * of review R-08. The roots are collected rather than removed here because a
 * host's bytes are live until the run that produced them has been read.
 */
function newHost(
  options: CertifyAdapterOptions,
  runId: string,
  wallClockMs: number,
  hostRoots: string[],
): AdapterHost {
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "erl2-cert-"));
  const storeRoot = mkdtempSync(path.join(tmpdir(), "erl2-cert-store-"));
  hostRoots.push(workspaceRoot, storeRoot);
  return new AdapterHost({
    runId,
    adapterManifest: options.adapterManifest,
    adapterEntryPath: options.adapterEntryPath,
    workspaceRoot,
    store: new ArtifactStore(storeRoot),
    clock: options.clock,
    wallClockMs,
    ...(options.profile === undefined ? {} : { profile: options.profile }),
    ...(options.containerActivation === undefined
      ? {}
      : { containerActivation: options.containerActivation }),
    ...(options.containerAdapterPackage === undefined
      ? {}
      : { containerAdapterPackage: options.containerAdapterPackage }),
  });
}

/**
 * Runs the suite and freezes the receipt.
 *
 * The harness never throws for a candidate's misbehaviour — misbehaviour is the
 * thing it measures. It throws only when the *request to certify* is itself
 * invalid, such as an adapter trying to certify itself.
 *
 * Every temporary root the run created is removed on the way out — on the
 * certified path, on every refusal, on the deadline probe that SIGKILLs its
 * adapter, and on a throw. Teardown lives in a `finally` around the suite and
 * never in the suite itself, because there is exactly one way to be sure a check
 * has finished reading a host's bytes, and that is for the run to be over.
 */
export function certifyAdapter(
  options: CertifyAdapterOptions,
): SubjectAdapterCertificationReceiptV1 {
  if (options.certifierId === options.adapterManifest.adapter_id) {
    throw new Erl2Error(
      CODES.ADAPTER_SELF_CERTIFICATION_REFUSED,
      "an adapter cannot certify itself; the certifier must be an independent party",
    );
  }
  const hostRoots: string[] = [];
  try {
    return runCertification(options, hostRoots);
  } finally {
    for (const dir of hostRoots) {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        // A temporary directory that will not delete is a hygiene problem, and
        // the receipt is the certification result. Rethrowing here would replace
        // a refusal — or a certification — with a filesystem error, which is the
        // one outcome teardown must never produce.
      }
    }
  }
}

function runCertification(
  options: CertifyAdapterOptions,
  hostRoots: string[],
): SubjectAdapterCertificationReceiptV1 {
  const runId = options.runId ?? CERT_RUN_ID;
  const manifest = options.adapterManifest;
  const checks: Finding[] = [];

  // 1. Immutable artifact identity ------------------------------------------
  let executableDigest: Hash;
  try {
    executableDigest = hashBytes(readFileSync(options.adapterEntryPath));
    checks.push(
      pass("immutable-artifact-identity", `adapter entry digest ${executableDigest.slice(0, 23)}…`),
    );
  } catch (cause) {
    return refuse(options, runId, [
      fail(
        "immutable-artifact-identity",
        `adapter entry is unreadable: ${String(cause).slice(0, 200)}`,
        CODES.ADAPTER_IDENTITY_MISMATCH,
        "critical",
      ),
    ]);
  }

  // 2. Declared privileges --------------------------------------------------
  const privileged = manifest.required_broker_capabilities.filter(isPrivilegedCapability);
  checks.push(
    privileged.length === 0
      ? pass("no-privileged-broker-capability", "the adapter declares only unprivileged capabilities")
      : fail(
          "no-privileged-broker-capability",
          `adapter requires privileged capabilities: ${privileged.join(", ")}`,
          CODES.ADAPTER_PRIVILEGED_OPERATION_NOT_SUPPORTED,
          "critical",
        ),
  );

  // 3. Closed operation and package-kind enums ------------------------------
  //    A candidate that needs a new operation or package kind would need a core
  //    change; certification is where that becomes visible.
  const declaredOperations = manifest.operations.filter((op) =>
    (
      [
        "acquire",
        "validate-package",
        "install",
        "configure",
        "start",
        "interact",
        "translate-evidence",
        "collect-outputs",
        "project",
        "stop",
        "uninstall",
        "report-residue",
        "compensate",
      ] as readonly string[]
    ).includes(op),
  );
  checks.push(
    declaredOperations.length === manifest.operations.length
      ? pass("no-product-specific-core-change", "every declared operation is in the closed enum")
      : fail(
          "no-product-specific-core-change",
          `adapter declares operations outside the closed enum: ${manifest.operations
            .filter((op) => !declaredOperations.includes(op))
            .join(", ")}`,
          CODES.ADAPTER_OPERATION_UNSUPPORTED,
          "critical",
        ),
  );

  // 4. Protocol negotiation and identity ------------------------------------
  const acquireOperation = declaredOperations.includes("acquire") ? "acquire" : undefined;
  const verifyOperation = declaredOperations.includes("validate-package")
    ? "validate-package"
    : undefined;

  if (acquireOperation === undefined && verifyOperation === undefined) {
    checks.push(
      fail(
        "protocol-negotiation",
        "the adapter declares neither acquire nor validate-package, so nothing can be exercised",
        CODES.ADAPTER_OPERATION_UNSUPPORTED,
        "critical",
      ),
    );
    return refuse(options, runId, checks);
  }

  const probeOperation = (acquireOperation ?? verifyOperation) as "acquire" | "validate-package";
  const probeRequest = (operationId: string): unknown =>
    probeOperation === "acquire"
      ? fakeAcquisitionRequest(runId, operationId)
      : fakePackageRequest(runId, operationId, manifest.supported_package_kinds[0] ?? "archive");

  const firstRun = attempt(() => {
    const host = newHost(options, runId, 30_000, hostRoots);
    return host.run({
      operation: probeOperation,
      operationId: "cert-probe-1",
      request: probeRequest("cert-probe-1"),
    });
  });

  if (!firstRun.ok) {
    checks.push(
      fail(
        "protocol-negotiation",
        `the adapter did not complete a negotiated exchange: ${firstRun.code}`,
        firstRun.code,
        "critical",
      ),
    );
    return refuse(options, runId, checks);
  }
  checks.push(pass("protocol-negotiation", "negotiated subject-adapter/v1 and repeated identifiers"));
  checks.push(
    pass(
      "unsupported-retention",
      firstRun.value.envelope.status === "unsupported"
        ? `unsupported inputs retained: ${firstRun.value.envelope.unsupported_inputs.join(", ")}`
        : "the probe operation reported a supported or failed outcome, both of which are retained",
    ),
  );

  // 5. Diagnostics and output bounds ----------------------------------------
  const diagnostics = firstRun.value.diagnostics;
  checks.push(
    diagnostics.scan.judge_canaries_found === 0 && diagnostics.scan.secret_canaries_found === 0
      ? pass("diagnostics-bounds", `diagnostics scanned: ${String(diagnostics.total_bytes)} bytes retained`)
      : fail(
          "diagnostics-bounds",
          "a judge or secret canary reached retained diagnostics",
          CODES.SECRET_CANARY_IN_DIAGNOSTICS,
          "critical",
        ),
  );

  // 6. Deterministic behaviour for identical inputs -------------------------
  const secondRun = attempt(() => {
    const host = newHost(options, runId, 30_000, hostRoots);
    return host.run({
      operation: probeOperation,
      operationId: "cert-probe-1",
      request: probeRequest("cert-probe-1"),
    });
  });
  if (!secondRun.ok) {
    checks.push(
      fail(
        "deterministic-projection",
        `the identical request failed on replay: ${secondRun.code}`,
        secondRun.code,
      ),
    );
  } else {
    const a = firstRun.value.envelope;
    const b = secondRun.value.envelope;
    const same =
      a.status === b.status &&
      a.result_core_hash === b.result_core_hash &&
      JSON.stringify(a.unsupported_inputs) === JSON.stringify(b.unsupported_inputs);
    checks.push(
      same
        ? pass("deterministic-projection", "identical inputs produced an identical result identity")
        : fail(
            "deterministic-projection",
            "the same request produced two different results",
            CODES.ADAPTER_PROJECTION_NONDETERMINISTIC,
          ),
    );
  }

  // 7. Phase-specific request ancestry --------------------------------------
  const poisoned = attempt(() => {
    const host = newHost(options, runId, 30_000, hostRoots);
    return host.run({
      operation: probeOperation,
      operationId: "cert-ancestry",
      request:
        probeOperation === "acquire"
          ? fakeAcquisitionRequest(runId, "cert-ancestry", {
              execution_plan_hash: `sha256:${"a".repeat(64)}`,
            })
          : { ...(fakePackageRequest(runId, "cert-ancestry", "archive") as object), execution_plan_hash: `sha256:${"a".repeat(64)}` },
    });
  });
  checks.push(
    !poisoned.ok || poisoned.value.envelope.status !== "supported"
      ? pass(
          "phase-request-ancestry",
          "a later-phase ancestor injected into an earlier request is refused",
        )
      : fail(
          "phase-request-ancestry",
          "the adapter accepted a request carrying a later-phase ancestor",
          CODES.REQUEST_ANCESTRY_INVALID,
          "critical",
        ),
  );

  // 8. Judge canary in the request ------------------------------------------
  const canaried = attempt(() => {
    const host = newHost(options, runId, 30_000, hostRoots);
    return host.run({
      operation: probeOperation,
      operationId: "cert-canary",
      request: probeOperation === "acquire"
        ? fakeAcquisitionRequest(runId, "cert-canary", {
            expected_observations: [`erl2-canary-${"0".repeat(32)}`],
          })
        : { ...(fakePackageRequest(runId, "cert-canary", "archive") as object), judge_expectation_hash: `sha256:${"b".repeat(64)}` },
    });
  });
  checks.push(
    !canaried.ok
      ? pass("oracle-partition", "an oracle field in an adapter request is refused before dispatch")
      : fail(
          "oracle-partition",
          "an adapter request carrying an oracle field was dispatched",
          "JOURNEY_ORACLE_FIELD_PRESENT",
          "critical",
        ),
  );

  // 9. Mutation disclosure and compensation ---------------------------------
  const mutations = firstRun.value.envelope.mutation_receipt_hashes;
  const compensations = firstRun.value.envelope.compensation_receipt_hashes;
  checks.push(
    mutations.length === 0
      ? pass("mutation-disclosure", "the probe operation declared no external mutation")
      : mutations.length === compensations.length
        ? pass(
            "mutation-disclosure",
            `${String(mutations.length)} declared mutation(s), each with a compensation receipt`,
          )
        : fail(
            "mutation-disclosure",
            `${String(mutations.length)} mutation(s) but ${String(compensations.length)} compensation(s)`,
            CODES.ADAPTER_COMPENSATION_MISSING,
            "critical",
          ),
  );

  // 10. Unsupported package kind stays a retained result ---------------------
  if (verifyOperation !== undefined) {
    // `archive` is probed first: it is the form the Lab's own freezer produces,
    // so an adapter that does not declare it is the case most likely to arise.
    const unsupportedKind = (["archive", "oci", "native", "bundle"] as const).find(
      (k) => !manifest.supported_package_kinds.includes(k),
    );
    if (unsupportedKind === undefined) {
      checks.push(
        notApplicable("unsupported-package-kind", "the adapter declares every package kind"),
      );
    } else {
      const probe = attempt(() => {
        const host = newHost(options, runId, 30_000, hostRoots);
        return host.run({
          operation: "validate-package",
          operationId: "cert-unsupported-kind",
          request: fakePackageRequest(runId, "cert-unsupported-kind", unsupportedKind),
        });
      });
      checks.push(
        probe.ok && probe.value.envelope.status === "unsupported"
          ? pass(
              "unsupported-package-kind",
              `package kind ${unsupportedKind} is honestly reported unsupported`,
            )
          : probe.ok && probe.value.envelope.status === "supported"
            ? fail(
                "unsupported-package-kind",
                `the adapter reported success for the undeclared package kind ${unsupportedKind}`,
                CODES.ADAPTER_PACKAGE_KIND_UNSUPPORTED,
                "critical",
              )
            : pass(
                "unsupported-package-kind",
                `package kind ${unsupportedKind} is refused rather than silently accepted`,
              ),
      );
    }
  } else {
    checks.push(notApplicable("unsupported-package-kind", "the adapter declares no validate-package"));
  }

  // 11. Deadline and process-tree termination -------------------------------
  const timed = attempt(() => {
    const host = newHost(options, runId, 1, hostRoots);
    return host.run({
      operation: probeOperation,
      operationId: "cert-deadline",
      request: probeRequest("cert-deadline"),
    });
  });
  checks.push(
    !timed.ok && (timed.code === CODES.ADAPTER_DEADLINE_EXCEEDED || timed.code === CODES.ADAPTER_PROCESS_CRASHED)
      ? pass("deadline-and-process-tree-termination", `a 1ms deadline terminated the adapter (${timed.code})`)
      : fail(
          "deadline-and-process-tree-termination",
          "the adapter completed an operation whose deadline had already passed",
          CODES.ADAPTER_DEADLINE_EXCEEDED,
          "critical",
        ),
  );

  // 12. No execution after output freeze ------------------------------------
  const afterFreeze = attempt(() => {
    const host = newHost(options, runId, 30_000, hostRoots);
    host.markOutputFrozen();
    return host.run({
      operation: probeOperation,
      operationId: "cert-post-freeze",
      request: probeRequest("cert-post-freeze"),
    });
  });
  checks.push(
    !afterFreeze.ok && afterFreeze.code === CODES.ADAPTER_EXECUTION_AFTER_OUTPUT_FREEZE
      ? pass("no-execution-after-output-freeze", "dispatch after output freeze is refused")
      : fail(
          "no-execution-after-output-freeze",
          "the host dispatched an operation after subject output froze",
          CODES.ADAPTER_EXECUTION_AFTER_OUTPUT_FREEZE,
          "critical",
        ),
  );

  // 13. Residue -------------------------------------------------------------
  checks.push(
    declaredOperations.includes("report-residue")
      ? pass("residue-reporting", "the adapter declares report-residue")
      : notApplicable(
          "residue-reporting",
          "the adapter declares no report-residue operation; residue is reported by the Lab only",
        ),
  );

  return build(options, runId, checks, executableDigest);
}

interface Attempted<T> {
  readonly ok: boolean;
  readonly value: T;
  readonly code: string;
}

function attempt<T>(fn: () => T): Attempted<T> {
  try {
    return { ok: true, value: fn(), code: "" };
  } catch (cause) {
    return {
      ok: false,
      value: undefined as T,
      code: cause instanceof Erl2Error ? cause.code : CODES.ADAPTER_EXECUTION_FAULT,
    };
  }
}

function refuse(
  options: CertifyAdapterOptions,
  runId: string,
  checks: readonly Finding[],
): SubjectAdapterCertificationReceiptV1 {
  return build(options, runId, checks, `sha256:${"0".repeat(64)}`);
}

function build(
  options: CertifyAdapterOptions,
  runId: string,
  checks: readonly Finding[],
  executableDigest: Hash,
): SubjectAdapterCertificationReceiptV1 {
  void runId;
  const failures = checks.filter((c) => c.status === "failed");
  const refusalCodes = [...new Set(failures.map((c) => c.refusal_code as string))].sort();
  const manifest = options.adapterManifest;
  const base = {
    schema_version: "subject-adapter-certification-receipt/v1" as const,
    receipt_id: `cert-${manifest.adapter_id}`,
    suite: "ADAPTER-CERT-V1" as const,
    adapter_manifest_hash: manifest.core_hash,
    adapter_artifact_hash: executableDigest,
    adapter_id: manifest.adapter_id,
    adapter_version: manifest.version,
    certified_operations: (failures.length === 0 ? manifest.operations : []) as never,
    certified_package_kinds: (failures.length === 0 ? manifest.supported_package_kinds : []) as never,
    checks: [...checks],
    verdict: (failures.length === 0 ? "certified" : "refused") as "certified" | "refused",
    refusal_codes: refusalCodes,
    certifier_id: options.certifierId,
    certifier_is_adapter_owner: false as const,
    // The controls of the profile the suite actually ran under. Hard-coding
    // `local-process` here would have made a container certification claim the
    // process profile's thirteen `unsupported_on_this_host` entries — and, worse,
    // let a local certification be read as covering the container profile.
    enforced_controls: [
      ...enforcedControls(options.profile ?? "local-process", options.containerActivation),
    ],
    unsupported_controls: [
      ...unsupportedControls(options.profile ?? "local-process", options.containerActivation),
    ],
    certified_at: options.clock.now(),
  };
  const sealed =
    options.certifierKey === undefined
      ? { ...base, core_hash: coreHash(base) }
      : sealSigned(base, options.certifierKey);
  return assertContract<SubjectAdapterCertificationReceiptV1>(
    "SubjectAdapterCertificationReceiptV1",
    sealed,
  );
}
