/**
 * One complete CLI journey through the real Compose environment, driven by a
 * subject adapter this repository did not write.
 *
 * ## Why this file exists separately from `composeEnvironmentRun.test.ts`
 *
 * That file proves the *substrate*: real containers, real telemetry, real
 * teardown, driven by a reference adapter that lives here. It cannot say
 * anything about a subject the Lab did not author, because there is no such
 * subject in this repository — by construction, and permanently.
 *
 * This file closes that gap without importing one. The adapter under test is
 * named entirely by the environment: an entry point, an id, and the operations
 * its manifest declares. Nothing here knows what the subject is, what it
 * measures, what vocabulary its outputs use, or which project it belongs to, and
 * nothing here may grow that knowledge — a subject-specific assertion in this
 * file would make the Lab's gate depend on one product.
 *
 * What it asserts is generic and is exactly what the Lab owes any subject: the
 * run bound the externally supplied manifest, every declared step reported a
 * real outcome against a real environment, the subject's own written files are
 * *retained* and referenced by the step that produced them, the host's
 * adjudication of every dispatch is retained and reachable, the frozen
 * subject-output manifest describes the bytes actually on disk, restoration and
 * teardown left nothing behind, the terminal is valid, an external reader
 * verifies the bundle offline, and a tampered copy of that bundle is refused.
 *
 * The claim boundary is unchanged and stated here so it cannot drift: this is a
 * development-tier, non-blind, trusted-source-and-adapter, local-process, T1 run
 * on a self-qualified development Compose substrate. It is not OQ-008
 * containment or isolation, and nothing here claims the subject consumed OTLP
 * or inspected collector telemetry — the subject consumed analytics request
 * JSON.
 *
 * ## When nothing is configured
 *
 * This file **skips**, loudly. The ordinary Lab gate must not depend on any
 * external checkout being present, so an unconfigured run is a skip and never a
 * failure. `ERL2_REQUIRE_LIVE_DOCKER=1` turns a *substrate* skip into a failure,
 * exactly as it does for the reference E2E.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ArtifactRef, JourneyIntent, JourneyStepOutcomeV1 } from "@erl2/contracts";
import { dockerAvailable, OTEL_DEMO_RELEASE_TAG } from "@erl2/core";
import { erl2, verifyBundle } from "../support/cliRun.js";
import { adapterManifest } from "../support/adapterFixtures.js";
import { buildGovernorRegistry, type GovernorRegistry } from "../support/governorRegistry.js";
import { ownedRunRoot, ownedTempDir } from "../support/tempDirs.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ARCHIVE = path.join(
  repoRoot,
  "environments",
  "otel-demo",
  "upstream",
  `opentelemetry-demo-${OTEL_DEMO_RELEASE_TAG}.tar.gz`,
);

/** The default operation set for a subject that runs the whole environment journey. */
const DEFAULT_OPERATIONS = [
  "acquire",
  "validate-package",
  "install",
  "configure",
  "start",
  "interact",
  "uninstall",
  "translate-evidence",
  "project",
  "report-residue",
  "compensate",
] as const;

/**
 * The environment journey this file selects.
 *
 * The standard fixture journey, plus `diagnose_decide` between `observe` and
 * `remove`. The position is the design's canonical order and not a preference:
 * `nextPermittedIntents` derives each step's successors from that order, and
 * `diagnose_decide` sits between `observe` and `recover`.
 */
const EXTERNAL_SUBJECT_JOURNEY: readonly JourneyIntent[] = [
  "install",
  "configure",
  "authenticate",
  "connect",
  "discover",
  "exercise",
  "observe",
  "diagnose_decide",
  "remove",
];

interface ExternalSubject {
  readonly entry: string;
  readonly adapterId: string;
  readonly operations: readonly string[];
}

/** The subject under test, or `undefined` when none was configured. */
function configuredSubject(): ExternalSubject | undefined {
  const entry = process.env["ERL2_EXTERNAL_ADAPTER_ENTRY"];
  const adapterId = process.env["ERL2_EXTERNAL_ADAPTER_ID"];
  if (entry === undefined || entry === "" || adapterId === undefined || adapterId === "") return undefined;
  const declared = process.env["ERL2_EXTERNAL_ADAPTER_OPERATIONS"];
  return {
    entry: path.resolve(entry),
    adapterId,
    operations:
      declared === undefined || declared === ""
        ? [...DEFAULT_OPERATIONS]
        : declared.split(",").map((name) => name.trim()).filter((name) => name.length > 0),
  };
}

/**
 * Why this file cannot make its claim, or `undefined` when it can.
 *
 * Two classes of precondition, kept apart on purpose. A missing *substrate* is
 * the same condition the reference E2E refuses under `ERL2_REQUIRE_LIVE_DOCKER`.
 * A missing *subject* is not: no environment variable makes an external
 * repository exist, and demanding one would couple this repository's gate to a
 * checkout it does not own.
 */
function substrateUnavailable(): string | undefined {
  if (!dockerAvailable()) return "no Docker daemon is reachable";
  if (!existsSync(ARCHIVE)) {
    return `the pinned OpenTelemetry Demo ${OTEL_DEMO_RELEASE_TAG} archive is not fetched ` +
      "(run `node scripts/qualify-otel-demo.mjs --fetch-only`)";
  }
  return undefined;
}

const SUBJECT = configuredSubject();
const SUBSTRATE_REASON = substrateUnavailable();

const SUBJECT_REASON =
  SUBJECT === undefined
    ? "no external adapter entry was supplied"
    : !existsSync(SUBJECT.entry)
      ? `the supplied external adapter entry does not exist: ${SUBJECT.entry}`
      : undefined;

const REASON = SUBJECT_REASON ?? SUBSTRATE_REASON;

const SKIP: { readonly skip?: string } =
  REASON === undefined ||
  (SUBJECT_REASON === undefined && process.env["ERL2_REQUIRE_LIVE_DOCKER"] === "1")
    ? {}
    : { skip: `EXTERNAL SUBJECT UNPROVEN: ${REASON}` };

test("EXTERNAL-SUBJECT-GATE: the external subject precondition is explicit", () => {
  // A missing substrate is refusable; a missing subject never is.
  if (
    SUBJECT_REASON === undefined &&
    SUBSTRATE_REASON !== undefined &&
    process.env["ERL2_REQUIRE_LIVE_DOCKER"] === "1"
  ) {
    assert.fail(`ERL2_REQUIRE_LIVE_DOCKER=1 was set but ${SUBSTRATE_REASON}; the live claim cannot be made`);
  }
  assert.ok(true);
});

function docker(args: readonly string[]): { status: number; stdout: string } {
  const result = spawnSync("docker", [...args], { encoding: "utf8" });
  return { status: result.status ?? -1, stdout: result.stdout ?? "" };
}

function projectObjects(project: string): {
  readonly containers: readonly string[];
  readonly networks: readonly string[];
  readonly volumes: readonly string[];
} {
  const list = (args: readonly string[]): readonly string[] =>
    docker([...args, "--filter", `label=com.docker.compose.project=${project}`, "--format", "{{.Name}}"])
      .stdout.split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  return {
    containers: docker([
      "ps",
      "--all",
      "--filter",
      `label=com.docker.compose.project=${project}`,
      "--format",
      "{{.Names}}",
    ])
      .stdout.split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
    networks: list(["network", "ls"]),
    volumes: list(["volume", "ls"]),
  };
}

interface ExternalRun {
  readonly runRoot: string;
  readonly runId: string;
  readonly registry: GovernorRegistry;
  readonly base: readonly string[];
  readonly project: string;
}

/**
 * Drives a run to `case_selected` bound to the externally supplied adapter.
 *
 * The manifest is built by the same generic helper every reference adapter uses
 * and admitted through the registry's external-manifest seam, so the subject is
 * bound by core hash exactly as a repository-owned one is.
 */
function selectedExternalRun(subject: ExternalSubject): ExternalRun {
  const registry = buildGovernorRegistry({
    externalAdapterManifests: [
      adapterManifest({
        adapterId: subject.adapterId,
        operations: subject.operations,
        packageKinds: ["archive"],
      }),
    ],
    // The one journey difference from the standard fixture, and the reason the
    // seam exists: `diagnose_decide` is the only intent that maps to the adapter
    // protocol's `project` operation. Without it a subject that implements
    // projection is never asked to project, so the operation was unit-tested and
    // never produced live. Configured here rather than in the standard journey,
    // which every other suite runs.
    environmentJourneyIntents: EXTERNAL_SUBJECT_JOURNEY,
  });
  const adapterHash = registry.externalAdapterHashes[subject.adapterId];
  assert.ok(adapterHash, `the registry did not admit a manifest for ${subject.adapterId}`);

  const runRoot = ownedRunRoot("erl2-external-e2e-");
  const base0 = [
    "--run-root", runRoot,
    "--registry", registry.root,
    "--tier", "development",
    "--adapter-entry", subject.entry,
  ];
  const prereg = erl2([
    "preregister-acquisition", ...base0,
    "--acquisition-source", registry.sourceManifestHash,
    "--adapter", adapterHash,
    "--acquisition-actor-script", registry.acquisitionActorScriptHash,
    "--acquisition-actor-schema", registry.acquisitionActorSchemaHash,
    "--acquisition-step", registry.acquisitionStep.commitmentHash,
    "--package-verification-step", registry.packageVerificationStep.commitmentHash,
    "--generic-policy", registry.genericRunPolicyHash,
    "--trust-policy", registry.runTrustPolicyHash,
    "--limits", registry.limitsHash,
    "--expires", "2026-12-31T00:00:00Z",
  ]);
  assert.equal(prereg.exitCode, 0, JSON.stringify(prereg.body.errors));
  const runId = prereg.body.run_id as string;
  const base = [...base0, "--run", runId];

  for (const [name, argv] of [
    ["acquire", ["acquire", ...base]],
    ["freeze-package", ["freeze-package", ...base]],
    [
      "verify-package",
      ["verify-package", ...base, "--subject-id", subject.adapterId, "--subject-version", "0.1.0"],
    ],
    [
      "preregister-challenge",
      [
        "preregister-challenge", ...base,
        "--journey-selection-policy", registry.journeySelectionPolicyHash,
        "--randomness-policy", registry.randomnessPolicyHash,
        ...registry.challengeCandidates.flatMap((c) => ["--challenge", c.challengeManifestHash]),
      ],
    ],
  ] as const) {
    const result = erl2(argv as readonly string[]);
    assert.equal(result.exitCode, 0, `${name}: ${JSON.stringify(result.body.errors)}`);
  }

  const sourceTrust = path.join(runRoot, "external-source-trust.json");
  writeFileSync(
    sourceTrust,
    JSON.stringify({
      sourceTrustPolicyHash: registry.sourceTrustPolicyHash,
      randomnessRegistryHeadHash: registry.sourceTrustPolicyHash,
    }),
  );
  const selected = erl2([
    "select", ...base,
    "--source-trust-config", sourceTrust,
    "--expires", "2026-12-31T00:00:00Z",
  ]);
  assert.equal(selected.exitCode, 0, JSON.stringify(selected.body.errors));
  assert.equal(selected.body.state, "case_selected");
  return { runRoot, runId, registry, base, project: `erl2-${runId}` };
}

function composePlan(run: ExternalRun): readonly (readonly [string, readonly string[]])[] {
  const env = [...run.base];
  return [
    ["provision", ["provision", ...env, "--archetype", run.registry.archetypeHash, "--environment-driver", "compose"]],
    ["baseline", ["baseline", ...env]],
    ["plan", ["plan", ...env]],
    ["install", ["install", ...env]],
    ["configure", ["configure", ...env]],
    ["authenticate", ["authenticate", ...env]],
    ["connect", ["connect", ...env]],
    ["execute-subject:discover", ["execute-subject", ...env]],
    ["activate", ["activate", ...env]],
    [
      "journey",
      [
        "journey", ...env,
        "--comparison-policy", run.registry.comparisonPolicyHash,
        "--cutoff-policy", run.registry.cutoffPolicyHash,
      ],
    ],
    ["observe", ["observe", ...env]],
    ["freeze-observation", ["freeze-observation", ...env]],
    ["execute-subject:exercise", ["execute-subject", ...env]],
    ["execute-subject:observe", ["execute-subject", ...env]],
    ["execute-subject:diagnose_decide", ["execute-subject", ...env]],
    ["remove", ["remove", ...env]],
    ["freeze-output", ["freeze-output", ...env]],
    ["reveal", ["reveal", ...env, "--vault", run.registry.vaultRoot]],
    ["evaluate", ["evaluate", ...env]],
    ["restore", ["restore", ...env]],
    ["destroy", ["destroy", ...env]],
    ["finalize-generic", ["finalize-generic", ...env]],
  ];
}

/** A byte copy of a run root, so each tamper control starts from a clean bundle. */
function copyOf(runRoot: string): string {
  const copy = path.join(ownedTempDir("erl2-external-bundle-copy-"), "run");
  cpSync(runRoot, copy, { recursive: true });
  return copy;
}

/** Every regular file under a directory, relative to it. */
function filesUnder(root: string): readonly string[] {
  if (!existsSync(root)) return [];
  const found: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const child = path.join(dir, name);
      const rel = prefix === "" ? name : `${prefix}/${name}`;
      if (statSync(child).isDirectory()) walk(child, rel);
      else found.push(rel);
    }
  };
  walk(root, "");
  return found;
}

test(
  "EXTERNAL-SUBJECT-E2E: an externally authored subject reaches an offline-valid terminal",
  SKIP,
  () => {
    const subject = SUBJECT as ExternalSubject;
    const run = selectedExternalRun(subject);

    const before = projectObjects(run.project);
    assert.deepEqual(
      [...before.containers, ...before.networks, ...before.volumes],
      [],
      "this run's project must not exist before it is provisioned",
    );

    for (const [name, argv] of composePlan(run)) {
      const result = erl2(argv);
      assert.equal(result.exitCode, 0, `${name}: ${JSON.stringify(result.body.errors)}`);

      if (name === "provision") {
        const live = projectObjects(run.project);
        assert.equal(live.containers.length, 2, "the qualified subset is exactly two containers");
      }
      if (name === "restore") {
        assert.equal(result.body.data?.["passed"], true);
        assert.equal(result.body.data?.["residual_resources"], 0);
      }
      if (name === "destroy") {
        assert.equal(result.body.data?.["passed"], true);
        assert.equal(result.body.data?.["residue_after_teardown"], 0);
      }
    }

    // Zero residue, observed independently of what the run reported.
    const after = projectObjects(run.project);
    assert.deepEqual(
      { containers: [...after.containers], networks: [...after.networks], volumes: [...after.volumes] },
      { containers: [], networks: [], volumes: [] },
      "the run left Docker resources behind",
    );

    // The run bound the external manifest, not a repository-owned one.
    const boundManifest = JSON.parse(
      readFileSync(path.join(run.runRoot, "retained", "adapter-manifest.json"), "utf8"),
    ) as { adapter_id: string; operations: string[] };
    assert.equal(boundManifest.adapter_id, subject.adapterId);
    for (const operation of subject.operations) {
      assert.ok(
        boundManifest.operations.includes(operation),
        `the bound manifest does not declare ${operation}`,
      );
    }

    // The subject's frozen output: the step outcomes, every one of them
    // accounted for by the manifest and matching the bytes on disk. Generic —
    // it checks the manifest describes what is actually there, never what any
    // particular subject put in it.
    const outputManifest = JSON.parse(
      readFileSync(path.join(run.runRoot, "retained", "subject-output-manifest.json"), "utf8"),
    ) as { entries: { path: string; file_sha256: string; byte_length: number }[] };
    assert.ok(outputManifest.entries.length > 0, "the subject output manifest is empty");
    for (const entry of outputManifest.entries) {
      const absolute = path.join(run.runRoot, entry.path);
      assert.ok(existsSync(absolute), `manifest entry ${entry.path} is not on disk`);
      const bytes = readFileSync(absolute);
      assert.equal(bytes.byteLength, entry.byte_length, `${entry.path} byte length disagrees`);
      assert.equal(
        `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
        entry.file_sha256,
        `${entry.path} digest disagrees with the manifest`,
      );
    }

    // Every step the subject was asked to perform reported a real outcome, and
    // every step that wrote something retained it. This is the assertion the
    // previous version of this file could not make: before the host froze its
    // own output tree, every `journey-step-outcome/v1` here carried
    // `output_refs: []` and the subject's files lived only in the host-owned
    // working directory, outside the bundle and outside every accounting pass.
    const outcomes = readdirSync(path.join(run.runRoot, "retained", "step-outcomes"))
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map(
        (name) =>
          JSON.parse(
            readFileSync(path.join(run.runRoot, "retained", "step-outcomes", name), "utf8"),
          ) as JourneyStepOutcomeV1,
      );
    assert.ok(outcomes.length > 0, "the subject produced no step outcomes");
    for (const outcome of outcomes) {
      assert.equal(outcome.status, "succeeded", `intent ${outcome.intent} did not succeed`);
    }

    // Every committed intent ran, including the projection one.
    const ranIntents = outcomes.map((o) => o.intent);
    for (const intent of EXTERNAL_SUBJECT_JOURNEY) {
      assert.ok(ranIntents.includes(intent), `the journey never ran its committed ${intent} step`);
    }

    // What the subject *wrote*, as the Lab retained it. Read from the host-owned
    // working directory first so the comparison is against the adapter's own
    // bytes rather than against the descriptor that claims to describe them.
    const workspaceRoot = path.join(run.runRoot, "adapter-workspace");
    const operationDirs = existsSync(workspaceRoot)
      ? readdirSync(workspaceRoot).filter((name) =>
          existsSync(path.join(workspaceRoot, name, "output")),
        )
      : [];
    let wroteSomething = false;
    const producedByOperation = new Map<string, readonly string[]>();
    for (const operation of operationDirs) {
      const outputRoot = path.join(workspaceRoot, operation, "output");
      const produced = filesUnder(outputRoot);
      producedByOperation.set(operation, produced);
      if (produced.length === 0) continue;
      wroteSomething = true;
      assert.ok(
        produced.length <= 64,
        `${operation} wrote ${produced.length} files, beyond the host's declared file bound`,
      );
      let totalBytes = 0;
      for (const relative of produced) {
        totalBytes += statSync(path.join(outputRoot, relative)).size;
        assert.ok(
          relative.split("/").length <= 6,
          `${operation} wrote ${relative}, beyond the host's declared depth bound`,
        );
      }
      assert.ok(
        totalBytes <= 1024 * 1024,
        `${operation} wrote ${totalBytes} bytes, beyond the host's declared byte bound`,
      );
    }
    assert.ok(wroteSomething, "the subject wrote nothing into any run-scoped output directory");

    // Retained, referenced and byte-identical. Every file the subject wrote into
    // an operation's output tree must appear as an `output_ref` on some step,
    // and the retained bytes must equal the bytes on the working copy.
    const retainedOutputs = new Map<string, ArtifactRef>();
    for (const outcome of outcomes) {
      for (const ref of outcome.output_refs) retainedOutputs.set(ref.path, ref);
    }
    assert.ok(retainedOutputs.size > 0, "no step outcome referenced any retained subject output");
    for (const [operation, produced] of producedByOperation) {
      for (const relative of produced) {
        const logical = `subject-output/adapter/${operation}/${relative}`;
        const ref = retainedOutputs.get(logical);
        assert.ok(ref, `the subject wrote ${operation}/${relative}, which no step outcome references`);
        const retained = readFileSync(path.join(run.runRoot, logical));
        assert.deepEqual(
          retained,
          readFileSync(path.join(workspaceRoot, operation, "output", relative)),
          `${logical} is not byte-for-byte what the subject wrote`,
        );
        assert.equal(retained.byteLength, ref.byte_length, `${logical} byte length disagrees`);
        assert.equal(
          `sha256:${createHash("sha256").update(retained).digest("hex")}`,
          ref.file_sha256,
          `${logical} digest disagrees with its descriptor`,
        );
      }
    }

    // Diagnostics are referenced where the subject wrote any, and resolve.
    const diagnosticRefs = outcomes.flatMap((o) => o.diagnostic_refs);
    assert.ok(diagnosticRefs.length > 0, "no step outcome referenced any retained diagnostics");
    for (const ref of diagnosticRefs) {
      const bytes = readFileSync(path.join(run.runRoot, ref.path));
      assert.equal(
        `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
        ref.file_sha256,
        `${ref.path} digest disagrees with its descriptor`,
      );
    }

    // The host's own adjudication of each dispatch: every detail-record hash a
    // step cites resolves to a retained object, and the response envelope is
    // among them.
    const retainedRecords = new Map<string, { schema_version: string }>();
    for (const relative of filesUnder(path.join(run.runRoot, "retained", "adapter"))) {
      if (!relative.endsWith(".json")) continue;
      const value = JSON.parse(
        readFileSync(path.join(run.runRoot, "retained", "adapter", relative), "utf8"),
      ) as { core_hash: string; schema_version: string };
      retainedRecords.set(value.core_hash, value);
    }
    assert.ok(retainedRecords.size > 0, "the run retained no adapter host records");
    const citedSchemas = new Set<string>();
    for (const outcome of outcomes) {
      for (const hash of outcome.detail_record_hashes) {
        const record = retainedRecords.get(hash);
        if (record === undefined) continue; // a Lab-side detail record, not a host one
        citedSchemas.add(record.schema_version);
      }
    }
    for (const schema of [
      "adapter-response-envelope/v1",
      "sandbox-invocation-manifest/v1",
      "sandbox-invocation-result/v1",
      "adapter-capability-grant/v1",
      "subject-diagnostics-manifest/v1",
    ]) {
      assert.ok(citedSchemas.has(schema), `no step outcome cites a retained ${schema}`);
    }
    // Nothing retained beneath `retained/adapter/` may be uncited: an unreachable
    // retained artifact is what the closure derivation refuses everywhere else.
    const citedHashes = new Set<string>(
      outcomes.flatMap((o) => [
        ...o.detail_record_hashes,
        ...o.mutation_receipt_hashes,
        ...o.compensation_receipt_hashes,
      ]),
    );
    for (const [hash, record] of retainedRecords) {
      assert.ok(
        citedHashes.has(hash),
        `retained ${record.schema_version} ${hash} is cited by no step outcome`,
      );
    }

    // Projection ran live, and its claims cite files the subject actually wrote.
    // Written as a loop over what is present rather than a hard-coded path, so
    // this stays a statement about *a* subject rather than about one product.
    const claimFiles = operationDirs
      .map((operation) => path.join(workspaceRoot, operation, "output", "claims", "generic.json"))
      .filter((candidate) => existsSync(candidate));
    assert.ok(
      claimFiles.length > 0,
      "the journey committed a diagnose_decide step but no operation produced a projection",
    );
    for (const claimFile of claimFiles) {
      const operation = path.basename(path.dirname(path.dirname(path.dirname(claimFile))));
      const projected = JSON.parse(readFileSync(claimFile, "utf8")) as {
        claims: { claim_id: string; citations: { locator: string }[] }[];
      };
      assert.ok(projected.claims.length > 0, "the subject projected no claims");
      for (const claim of projected.claims) {
        assert.ok(claim.citations.length > 0, `claim ${claim.claim_id} cites nothing`);
        for (const citation of claim.citations) {
          // Resolved across the whole run, not within the projecting operation.
          // The host gives every operation its own empty output directory, so a
          // projection necessarily cites bytes an *earlier* operation wrote —
          // and the question worth asking is whether those bytes are in the
          // retained bundle, which is what this resolves against.
          const cited = [...retainedOutputs.keys()].filter((logical) =>
            logical.endsWith(`/${citation.locator}`),
          );
          assert.equal(
            cited.length > 0,
            true,
            `claim ${claim.claim_id} cites ${citation.locator}, which this run retained nowhere`,
          );
        }
      }
      // …and the projection itself is retained, not merely written.
      assert.ok(
        retainedOutputs.has(`subject-output/adapter/${operation}/claims/generic.json`),
        `the projection from ${operation} is not retained`,
      );
    }

    // The environment really was the Compose one.
    const manifest = JSON.parse(
      readFileSync(path.join(run.runRoot, "retained", "environment", "driver-manifest.json"), "utf8"),
    ) as { driver_kind: string; enabled: boolean };
    assert.equal(manifest.driver_kind, "compose");
    assert.equal(manifest.enabled, true);

    // Offline verification, in a fresh process, as an external reader.
    const verified = verifyBundle(run.runRoot, {
      sourceTrustPolicyHash: run.registry.sourceTrustPolicyHash,
    });
    assert.equal(verified.exitCode, 0, JSON.stringify(verified.body.errors));
    const data = verified.body.data as {
      verdict: string;
      closure: { missing_roles: string[]; rejected_extra_hashes: string[] };
    };
    assert.equal(data.verdict, "valid");
    assert.deepEqual(data.closure.missing_roles, []);
    assert.deepEqual(data.closure.rejected_extra_hashes, []);

    // …and the same reader refuses a tampered copy. Each case starts from a
    // fresh byte copy of the bundle, so one control cannot mask another, and
    // each touches only the *subject's* retained output — the surface that was
    // previously outside the accounting altogether.
    const victim = [...retainedOutputs.keys()].sort()[0] as string;

    const removed = copyOf(run.runRoot);
    rmSync(path.join(removed, victim), { force: true });
    rmSync(`${path.join(removed, victim)}.frozen`, { force: true });
    const afterRemoval = verifyBundle(removed, {
      sourceTrustPolicyHash: run.registry.sourceTrustPolicyHash,
    });
    assert.notEqual(afterRemoval.exitCode, 0, "a bundle missing a declared payload verified valid");
    assert.equal(afterRemoval.body.errors[0]?.code, "ARTIFACT_NOT_FOUND");

    const altered = copyOf(run.runRoot);
    const originalBytes = readFileSync(path.join(altered, victim));
    const flipped = Buffer.from(originalBytes);
    flipped[0] = (originalBytes[0] as number) ^ 0xff;
    // A frozen artifact is read-only on disk; an attacker with write access to
    // the bundle is not stopped by a mode bit, so the control must not be.
    chmodSync(path.join(altered, victim), 0o600);
    writeFileSync(path.join(altered, victim), flipped);
    const afterAlteration = verifyBundle(altered, {
      sourceTrustPolicyHash: run.registry.sourceTrustPolicyHash,
    });
    assert.notEqual(afterAlteration.exitCode, 0, "a substituted payload verified valid");
    assert.equal(afterAlteration.body.errors[0]?.code, "ARTIFACT_HASH_MISMATCH");

    const padded = copyOf(run.runRoot);
    writeFileSync(
      path.join(path.dirname(path.join(padded, victim)), "unreferenced.txt"),
      "bytes no retained descriptor declares\n",
    );
    const afterAddition = verifyBundle(padded, {
      sourceTrustPolicyHash: run.registry.sourceTrustPolicyHash,
    });
    assert.notEqual(afterAddition.exitCode, 0, "an undeclared retained payload verified valid");
    assert.equal(afterAddition.body.errors[0]?.code, "GRAPH_CLOSURE_EXTRA_ARTIFACT");
  },
);

/**
 * The supported cancellation path, on its own real Compose environment.
 *
 * Separately provisioned on purpose: cancellation is a *terminal*, so it cannot
 * be appended to the run above without destroying the valid terminal that run
 * exists to prove. This one provisions, cancels, and is then asked the only
 * question that matters about a cleanup — whether anything is left.
 *
 * The defect it covers is the emergency operation id. `op-emergency-` plus the
 * frontier's `<action-kind>-<resource_id>` exceeded the 64-character contract
 * identifier for an ordinary Compose container, so the receipt failed validation
 * *after* the destroy had been dispatched and the branch threw part-way through
 * its action sequence. A unit control pins the derivation
 * (`emergencyOperationIds.test.ts`); this one pins the consequence.
 */
test(
  "EXTERNAL-SUBJECT-CANCEL: the supported cancellation path leaves zero residue",
  SKIP,
  () => {
    const subject = SUBJECT as ExternalSubject;
    const run = selectedExternalRun(subject);

    const before = projectObjects(run.project);
    assert.deepEqual(
      [...before.containers, ...before.networks, ...before.volumes],
      [],
      "this run's project must not exist before it is provisioned",
    );

    for (const [name, argv] of [
      [
        "provision",
        ["provision", ...run.base, "--archetype", run.registry.archetypeHash, "--environment-driver", "compose"],
      ],
      ["baseline", ["baseline", ...run.base]],
    ] as const) {
      const result = erl2(argv as readonly string[]);
      assert.equal(result.exitCode, 0, `${name}: ${JSON.stringify(result.body.errors)}`);
    }
    assert.equal(
      projectObjects(run.project).containers.length,
      2,
      "the qualified subset is exactly two containers",
    );

    // Cancellation exits on the cancellation class, not on success: a cancelled
    // run still freezes its record, and a caller must not read that as a pass.
    const cancelled = erl2(["cancel", ...run.base, "--reason", "operator_stop"]);
    assert.notEqual(cancelled.exitCode, 0, "a cancellation must not exit as a success");
    assert.equal(
      cancelled.body.errors.some((e) => e.code === "CANCELLATION_REQUESTED"),
      true,
      `cancellation reported ${JSON.stringify(cancelled.body.errors)}`,
    );

    // The invalid terminal exists, names the cancellation, and its cleanup
    // attempted every derived action rather than throwing part-way through.
    const record = JSON.parse(
      readFileSync(path.join(run.runRoot, "retained", "invalid-run-record.json"), "utf8"),
    ) as {
      failed_phase: { kind: string };
      cleanup: { variant: string; status: string; attempt_hashes: string[] };
    };
    assert.equal(record.failed_phase.kind, "cancellation");
    assert.ok(
      record.cleanup.attempt_hashes.length > 0,
      "the cancellation attempted no cleanup action at all",
    );
    assert.equal(
      record.cleanup.status,
      "attempted_succeeded",
      `cleanup reported ${record.cleanup.status} with variant ${record.cleanup.variant}`,
    );

    // Residue, observed from Docker rather than from what the run reported.
    const after = projectObjects(run.project);
    assert.deepEqual(
      { containers: [...after.containers], networks: [...after.networks], volumes: [...after.volumes] },
      { containers: [], networks: [], volumes: [] },
      "the cancelled run left Docker resources behind",
    );
  },
);
