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
 * real outcome against a real environment, the frozen subject-output manifest
 * describes the bytes actually on disk, the subject wrote into its host-owned
 * run-scoped output directory within the host's declared bounds, restoration and
 * teardown left nothing behind, the terminal is valid, and an external reader
 * verifies the bundle offline.
 *
 * Two things it deliberately does **not** assert, because the Lab does not do
 * them today and this file must not pretend otherwise:
 *
 *   - the subject's written files are not frozen into retained evidence. Every
 *     `journey-step-outcome/v1` here carries `output_refs: []`, and
 *     `freezeAdapterOutput` has no caller, so the host's output bounds are never
 *     enforced against a real subject either.
 *   - the subject is never asked to project. `diagnose_decide` is the only
 *     intent mapping to the adapter's `project` operation, and the fixture
 *     journey commits no such step.
 *
 * Both are `packages/core` concerns and are out of scope here.
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
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dockerAvailable, OTEL_DEMO_RELEASE_TAG } from "@erl2/core";
import { erl2, verifyBundle } from "../support/cliRun.js";
import { adapterManifest } from "../support/adapterFixtures.js";
import { buildGovernorRegistry, type GovernorRegistry } from "../support/governorRegistry.js";
import { ownedRunRoot } from "../support/tempDirs.js";

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
    ["remove", ["remove", ...env]],
    ["freeze-output", ["freeze-output", ...env]],
    ["reveal", ["reveal", ...env, "--vault", run.registry.vaultRoot]],
    ["evaluate", ["evaluate", ...env]],
    ["restore", ["restore", ...env]],
    ["destroy", ["destroy", ...env]],
    ["finalize-generic", ["finalize-generic", ...env]],
  ];
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

    // Every step the subject was asked to perform reported a real outcome.
    const outcomes = filesUnder(path.join(run.runRoot, "subject-output"))
      .filter((rel) => rel.endsWith(".json"))
      .map(
        (rel) =>
          JSON.parse(readFileSync(path.join(run.runRoot, "subject-output", rel), "utf8")) as {
            intent: string;
            status: string;
            output_refs: unknown[];
          },
      );
    assert.ok(outcomes.length > 0, "the subject produced no step outcomes");
    for (const outcome of outcomes) {
      assert.equal(outcome.status, "succeeded", `intent ${outcome.intent} did not succeed`);
    }

    // What the subject *wrote* — as opposed to the outcomes the Lab froze about
    // it — lands in the host-owned, run-scoped, empty-at-dispatch output
    // directory. Asserted here because it is the only evidence that the subject
    // did work rather than merely returning a status.
    //
    // NOTE, and it is a limitation of the Lab rather than of any subject: these
    // files are **not frozen into retained evidence**. Every
    // `journey-step-outcome/v1` this journey produces carries `output_refs: []`,
    // and `freezeAdapterOutput` — the function that would collect, bound, scan
    // and freeze them — has no caller. So the host's declared output bounds are
    // never actually enforced against a real subject either. Both are recorded
    // in the session report; closing them is a `packages/core` change and is
    // deliberately out of this file's scope.
    const workspaceRoot = path.join(run.runRoot, "adapter-workspace");
    const operationDirs = existsSync(workspaceRoot)
      ? readdirSync(workspaceRoot).filter((name) =>
          existsSync(path.join(workspaceRoot, name, "output")),
        )
      : [];
    let wroteSomething = false;
    for (const operation of operationDirs) {
      const outputRoot = path.join(workspaceRoot, operation, "output");
      const produced = filesUnder(outputRoot);
      if (produced.length === 0) continue;
      wroteSomething = true;
      assert.ok(
        produced.length <= 64,
        `${operation} wrote ${produced.length} files, beyond the host's declared file bound`,
      );
      let totalBytes = 0;
      for (const rel of produced) {
        totalBytes += statSync(path.join(outputRoot, rel)).size;
        assert.ok(
          rel.split("/").length <= 6,
          `${operation} wrote ${rel}, beyond the host's declared depth bound`,
        );
      }
      assert.ok(
        totalBytes <= 1024 * 1024,
        `${operation} wrote ${totalBytes} bytes, beyond the host's declared byte bound`,
      );
    }
    assert.ok(wroteSomething, "the subject wrote nothing into any run-scoped output directory");

    // Projection, when the journey reaches it. The fixture journey commits no
    // `diagnose_decide` step, and that is the only intent that maps to the
    // adapter's `project` operation — so on this journey a subject is never
    // asked to project, and there is nothing to check. Written as a conditional
    // rather than deleted so that a journey which *does* dispatch it is covered,
    // and asserted loudly when it is present.
    const claimFiles = operationDirs
      .map((operation) => path.join(workspaceRoot, operation, "output", "claims", "generic.json"))
      .filter((candidate) => existsSync(candidate));
    for (const claimFile of claimFiles) {
      const outputRoot = path.dirname(path.dirname(claimFile));
      const produced = filesUnder(outputRoot);
      const projected = JSON.parse(readFileSync(claimFile, "utf8")) as {
        claims: { claim_id: string; citations: { locator: string }[] }[];
      };
      assert.ok(projected.claims.length > 0, "the subject projected no claims");
      for (const claim of projected.claims) {
        assert.ok(claim.citations.length > 0, `claim ${claim.claim_id} cites nothing`);
        for (const citation of claim.citations) {
          assert.ok(
            produced.includes(citation.locator),
            `claim ${claim.claim_id} cites ${citation.locator}, which the subject did not write`,
          );
        }
      }
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
  },
);
