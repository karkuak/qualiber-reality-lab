/**
 * The frozen subject seam, the current authorizing receipt, and the two
 * enforcement points that must stay load-bearing (ADR-ERL2-036, corrective
 * package for the independent review of `e9718e0`).
 *
 * ## What the review found
 *
 * The first LIVE-001 package closed the manifest-only final gate for a run that
 * preregistered an adapter normally. It did not make the *choice* durable. A run
 * preregistered without `--adapter-entry` recorded nothing saying so, and a
 * later command could supply a real entrypoint plus receipt A, then a still
 * later command could supply receipt B for the same manifest. Both executed.
 * Neither receipt was ever inside the frozen preregistration boundary.
 *
 * Two enforcement calls also survived deletion against 31 and 71 affected
 * tests, which means a future regression could remove either without breaking
 * anything.
 *
 * ## How these controls are written
 *
 * Through the shipped CLI, in fresh processes, with neutral identities. The
 * observable is not "a helper returned an error" — it is whether adapter bytes
 * ran at all: the substituted adapter writes `SUBSTITUTE-EXECUTED`, and the
 * host's own `adapter-workspace` directory only exists once a host was
 * constructed.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hashBytes } from "@erl2/integrity";
import { BOOTSTRAP_RECEIPT_SENTINEL } from "@erl2/core";
import { erl2 } from "../support/cliRun.js";
import {
  acquisitionRequest,
  adapterManifest,
  newHost,
  syntheticCertificationReceipt,
} from "../support/adapterFixtures.js";
import { buildGovernorRegistry } from "../support/governorRegistry.js";
import { ownedRunRoot, ownedTempDir } from "../support/tempDirs.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const NEUTRAL_ADAPTER_ID = "neutral-runtime-adapter";
const NEUTRAL_OPERATIONS = ["acquire", "validate-package"] as const;

function neutralFixture(name: "compliant" | "marker"): string {
  return path.join(repoRoot, "fixtures", "neutral", "adapters", `${name}.mjs`);
}

/**
 * A private copy of a neutral adapter, so a control may replace its bytes
 * without touching the repository fixture.
 */
function stagedAdapter(name: "compliant" | "marker"): string {
  const dir = ownedTempDir("erl2-neutral-entry-");
  mkdirSync(path.join(dir, "adapters"), { recursive: true });
  copyFileSync(
    path.join(repoRoot, "fixtures", "neutral", "adapters", "_frame.mjs"),
    path.join(dir, "adapters", "_frame.mjs"),
  );
  const entry = path.join(dir, "adapters", "main.mjs");
  copyFileSync(neutralFixture(name), entry);
  return entry;
}

/** Every file beneath `root`, recursively. */
function walk(root: string): readonly string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const name of readdirSync(root)) {
    const child = path.join(root, name);
    if (statSync(child).isDirectory()) out.push(...walk(child));
    else out.push(child);
  }
  return out;
}

function markerPresent(runRoot: string): boolean {
  return walk(runRoot).some((f) => path.basename(f) === "SUBSTITUTE-EXECUTED");
}

interface NeutralRun {
  readonly registry: ReturnType<typeof buildGovernorRegistry>;
  readonly adapterHash: string;
  readonly certificationHash: string;
  readonly entry: string;
  readonly runRoot: string;
}

/**
 * A governor registry admitting one neutral external adapter, plus a staged
 * private copy of its entry.
 */
function neutralRun(entryName: "compliant" | "marker" = "compliant"): NeutralRun {
  const entry = stagedAdapter(entryName);
  const manifest = adapterManifest({
    adapterId: NEUTRAL_ADAPTER_ID,
    artifactHash: hashBytes(readFileSync(entry)),
    certificationReceiptHash: BOOTSTRAP_RECEIPT_SENTINEL,
    operations: [...NEUTRAL_OPERATIONS],
    packageKinds: ["archive"],
  });
  const registry = buildGovernorRegistry({
    externalAdapterManifests: [manifest],
    externalAdapterCertifications: [syntheticCertificationReceipt(manifest, entry)],
  });
  return {
    registry,
    adapterHash: registry.externalAdapterHashes[NEUTRAL_ADAPTER_ID] as string,
    certificationHash: registry.externalAdapterCertificationHashes[NEUTRAL_ADAPTER_ID] as string,
    entry,
    runRoot: ownedRunRoot("erl2-mode-binding-"),
  };
}

function preregister(
  run: NeutralRun,
  options: { readonly entry?: string; readonly certification?: string } = {},
): ReturnType<typeof erl2> {
  return erl2([
    "preregister-acquisition",
    "--run-root", run.runRoot,
    "--registry", run.registry.root,
    "--tier", "development",
    ...(options.entry === undefined ? [] : ["--adapter-entry", options.entry]),
    ...(options.certification === undefined ? [] : ["--adapter-certification", options.certification]),
    "--acquisition-source", run.registry.sourceManifestHash,
    "--adapter", run.adapterHash,
    "--acquisition-actor-script", run.registry.acquisitionActorScriptHash,
    "--acquisition-actor-schema", run.registry.acquisitionActorSchemaHash,
    "--acquisition-step", run.registry.acquisitionStep.commitmentHash,
    "--package-verification-step", run.registry.packageVerificationStep.commitmentHash,
    "--generic-policy", run.registry.genericRunPolicyHash,
    "--trust-policy", run.registry.runTrustPolicyHash,
    "--limits", run.registry.limitsHash,
    "--expires", "2030-12-31T00:00:00Z",
  ]);
}

function frozenPrereg(runRoot: string): {
  subject_execution_mode?: string;
  adapter_certification_receipt_hash?: string;
} {
  return JSON.parse(
    readFileSync(path.join(runRoot, "retained", "acquisition-preregistration.json"), "utf8"),
  ) as { subject_execution_mode?: string; adapter_certification_receipt_hash?: string };
}

// -- 1/2/8. a fake-port run can never become a real one ----------------------

test("MODE-FROZEN: a fake preregistration refuses a later real adapter and a later receipt", () => {
  const run = neutralRun();
  const prereg = preregister(run);
  assert.equal(prereg.exitCode, 0, JSON.stringify(prereg.body.errors));
  const runId = prereg.body.run_id as string;

  assert.equal(frozenPrereg(run.runRoot).subject_execution_mode, "development_fake_port");
  assert.equal(
    frozenPrereg(run.runRoot).adapter_certification_receipt_hash,
    undefined,
    "a fake-port run must bind no certification at all",
  );

  const common = [
    "--run-root", run.runRoot,
    "--registry", run.registry.root,
    "--tier", "development",
    "--run", runId,
  ];

  // This is the exact reproduction from the review: receipt A on `acquire`.
  const withRealAdapter = erl2([
    "acquire", ...common,
    "--adapter-entry", run.entry,
    "--adapter-certification", run.certificationHash,
  ]);
  assert.notEqual(withRealAdapter.exitCode, 0, "a fake run must not acquire a real adapter");
  assert.equal(
    withRealAdapter.body.errors[0]?.code,
    "ADMISSION_SUBJECT_EXECUTION_MODE_FROZEN",
  );

  // A receipt alone, with no entrypoint, is refused for the same reason.
  const withReceiptOnly = erl2(["acquire", ...common, "--adapter-certification", run.certificationHash]);
  assert.notEqual(withReceiptOnly.exitCode, 0);
  assert.equal(withReceiptOnly.body.errors[0]?.code, "ADMISSION_SUBJECT_EXECUTION_MODE_FROZEN");

  // And no host was ever built, so no adapter bytes could have run.
  assert.equal(
    existsSync(path.join(run.runRoot, "adapter-workspace")),
    false,
    "a refused fake-port run must not have constructed an adapter host",
  );
  assert.equal(markerPresent(run.runRoot), false);
});

// -- 3/4. a real run must freeze its receipt at preregistration --------------

test("MODE-FROZEN: a real preregistration requires a receipt and freezes the exact one", () => {
  const run = neutralRun();

  const withoutReceipt = preregister(run, { entry: run.entry });
  assert.notEqual(withoutReceipt.exitCode, 0);
  assert.equal(
    withoutReceipt.body.errors[0]?.code,
    "ADAPTER_CERTIFICATION_RECEIPT_REQUIRED",
    "a real adapter may not preregister without its current receipt",
  );

  const fresh = neutralRun();
  const ok = preregister(fresh, { entry: fresh.entry, certification: fresh.certificationHash });
  assert.equal(ok.exitCode, 0, JSON.stringify(ok.body.errors));

  const frozen = frozenPrereg(fresh.runRoot);
  assert.equal(frozen.subject_execution_mode, "external_adapter");
  assert.equal(
    frozen.adapter_certification_receipt_hash,
    fresh.certificationHash,
    "the preregistration must name the exact current receipt",
  );
});

// -- 5. receipt A at preregistration, receipt B later ------------------------

test("MODE-FROZEN: a second valid receipt cannot replace the frozen one", () => {
  const run = neutralRun();
  const prereg = preregister(run, { entry: run.entry, certification: run.certificationHash });
  assert.equal(prereg.exitCode, 0, JSON.stringify(prereg.body.errors));
  const runId = prereg.body.run_id as string;

  // A second, individually valid receipt for the same certified manifest —
  // the review's substitution case. It differs only in `receipt_id`.
  const manifest = run.registry.externalAdapterManifestsById[NEUTRAL_ADAPTER_ID];
  assert.ok(manifest, "the neutral manifest must be retrievable");
  const receiptB = syntheticCertificationReceipt(manifest, run.entry, {
    receiptId: `cert-${NEUTRAL_ADAPTER_ID}-second`,
  });
  assert.notEqual(receiptB.core_hash, run.certificationHash, "the two receipts must differ");
  writeFileSync(
    path.join(run.registry.root, "adapter-certification-neutral-second.json"),
    `${JSON.stringify(receiptB, null, 2)}\n`,
  );

  const substituted = erl2([
    "acquire",
    "--run-root", run.runRoot,
    "--registry", run.registry.root,
    "--tier", "development",
    "--run", runId,
    "--adapter-entry", run.entry,
    "--adapter-certification", receiptB.core_hash,
  ]);
  assert.notEqual(substituted.exitCode, 0, "receipt B must not authorize this run");
  assert.equal(substituted.body.errors[0]?.code, "ADAPTER_CERTIFICATION_IDENTITY_MISMATCH");

  // The frozen binding is untouched.
  assert.equal(frozenPrereg(run.runRoot).adapter_certification_receipt_hash, run.certificationHash);
});

// -- 6/7/19. the binding survives a new process, replay and recovery ---------

test("MODE-FROZEN: mode and receipt survive a new process, replay and a dropped snapshot", () => {
  const run = neutralRun();
  const prereg = preregister(run, { entry: run.entry, certification: run.certificationHash });
  assert.equal(prereg.exitCode, 0, JSON.stringify(prereg.body.errors));
  const runId = prereg.body.run_id as string;
  const common = [
    "--run-root", run.runRoot,
    "--registry", run.registry.root,
    "--tier", "development",
    "--run", runId,
  ];

  // Every invocation below is a *fresh CLI process*: nothing about the binding
  // is held in memory between them, which is the property the review said CLI
  // memory could not provide.
  const assertStillBound = (label: string): void => {
    const frozen = frozenPrereg(run.runRoot);
    assert.equal(frozen.subject_execution_mode, "external_adapter", label);
    assert.equal(frozen.adapter_certification_receipt_hash, run.certificationHash, label);

    // A downgrade attempt: omit the entrypoint entirely.
    const downgrade = erl2(["acquire", ...common]);
    assert.notEqual(downgrade.exitCode, 0, `${label}: omission must not downgrade to the fake port`);
    assert.equal(downgrade.body.errors[0]?.code, "ADMISSION_SUBJECT_EXECUTION_MODE_FROZEN", label);

    // A substitution attempt: a syntactically fine but different receipt.
    const substitute = erl2([
      "acquire", ...common,
      "--adapter-entry", run.entry,
      "--adapter-certification", `sha256:${"f".repeat(64)}`,
    ]);
    assert.notEqual(substitute.exitCode, 0, `${label}: a different receipt must not authorize`);
    assert.equal(substitute.body.errors[0]?.code, "ADAPTER_CERTIFICATION_IDENTITY_MISMATCH", label);
  };

  assertStillBound("fresh process");
  assertStillBound("replayed");

  // Recovery: the derived snapshot is a cache and explicitly not authoritative.
  // Dropping it must not lose the binding, because the binding lives in the
  // signed preregistration and the hash-chained lifecycle.
  const snapshot = path.join(run.runRoot, "state", "snapshot.json");
  if (existsSync(snapshot)) rmSync(snapshot, { force: true });
  assertStillBound("after the derived snapshot was dropped");

  // And no adapter bytes ran at any point.
  assert.equal(markerPresent(run.runRoot), false);
});

// -- 14. the pre-host enforcement point is load-bearing ----------------------

test("PRE-HOST: an unadmitted certification never reaches the adapter host", () => {
  // The run's adapter *is* the marker fixture, so "the host was touched" is
  // directly observable: if the operation is dispatched at all, the adapter
  // writes `SUBSTITUTE-EXECUTED` before it answers. Removing the pre-host
  // enforcement lets the dispatch happen, and the marker appears.
  const run = neutralRun("marker");
  const prereg = preregister(run, { entry: run.entry, certification: run.certificationHash });
  assert.equal(prereg.exitCode, 0, JSON.stringify(prereg.body.errors));
  assert.equal(markerPresent(run.runRoot), false, "preregistration must dispatch nothing");
  const runId = prereg.body.run_id as string;

  // A receipt hash that was never admitted into this registry.
  const refused = erl2([
    "acquire",
    "--run-root", run.runRoot,
    "--registry", run.registry.root,
    "--tier", "development",
    "--run", runId,
    "--adapter-entry", run.entry,
    "--adapter-certification", `sha256:${"e".repeat(64)}`,
  ]);
  assert.notEqual(refused.exitCode, 0);
  assert.equal(refused.body.errors[0]?.code, "ADAPTER_CERTIFICATION_IDENTITY_MISMATCH");
  assert.equal(
    markerPresent(run.runRoot),
    false,
    "the adapter executed: an invalid certification reached the host",
  );

  // No per-operation host workspace was created either.
  const opDirs = existsSync(path.join(run.runRoot, "adapter-workspace"))
    ? readdirSync(path.join(run.runRoot, "adapter-workspace"))
    : [];
  assert.deepEqual(opDirs, [], "a refused certification must dispatch no operation");
});

test("PRE-HOST: an uncertified receipt cannot construct the host at preregistration", () => {
  // Preregistration is the one moment the frozen binding does not exist yet, so
  // the flag decides — and the subject port builds the host *before* the
  // workspace validates. This is what keeps the pre-host
  // `verifyAdapterCertification` call load-bearing rather than redundant: for
  // every later command the binding already answers, but here nothing else does.
  const entry = stagedAdapter("marker");
  const manifest = adapterManifest({
    adapterId: NEUTRAL_ADAPTER_ID,
    artifactHash: hashBytes(readFileSync(entry)),
    certificationReceiptHash: BOOTSTRAP_RECEIPT_SENTINEL,
    operations: [...NEUTRAL_OPERATIONS],
    packageKinds: ["archive"],
  });
  // Schema-valid, admitted, resolvable by hash — and refused by certification.
  const refusedReceipt = syntheticCertificationReceipt(manifest, entry, {
    verdict: "refused",
    refusalCodes: ["ADAPTER_PROTOCOL_VERSION_MISMATCH"],
  });
  const registry = buildGovernorRegistry({
    externalAdapterManifests: [manifest],
    externalAdapterCertifications: [refusedReceipt],
  });
  const runRoot = ownedRunRoot("erl2-prehost-prereg-");

  const prereg = erl2([
    "preregister-acquisition",
    "--run-root", runRoot,
    "--registry", registry.root,
    "--tier", "development",
    "--adapter-entry", entry,
    "--adapter", registry.externalAdapterHashes[NEUTRAL_ADAPTER_ID] as string,
    "--adapter-certification", registry.externalAdapterCertificationHashes[NEUTRAL_ADAPTER_ID] as string,
    "--acquisition-source", registry.sourceManifestHash,
    "--acquisition-actor-script", registry.acquisitionActorScriptHash,
    "--acquisition-actor-schema", registry.acquisitionActorSchemaHash,
    "--acquisition-step", registry.acquisitionStep.commitmentHash,
    "--package-verification-step", registry.packageVerificationStep.commitmentHash,
    "--generic-policy", registry.genericRunPolicyHash,
    "--trust-policy", registry.runTrustPolicyHash,
    "--limits", registry.limitsHash,
    "--expires", "2030-12-31T00:00:00Z",
  ]);

  assert.notEqual(prereg.exitCode, 0, "a refused verdict must not preregister");
  assert.equal(prereg.body.errors[0]?.code, "ADAPTER_NOT_CERTIFIED");
  assert.equal(
    existsSync(path.join(runRoot, "adapter-workspace")),
    false,
    "the adapter host was constructed for an uncertified receipt",
  );
  assert.equal(markerPresent(runRoot), false);
});

// -- 9/10. failure evidence names the CURRENT receipt ------------------------

test("FAILURE-EVIDENCE: an adapter failure cites the frozen current receipt, not the bootstrap sentinel", () => {
  const run = neutralRun();
  const prereg = preregister(run, { entry: run.entry, certification: run.certificationHash });
  assert.equal(prereg.exitCode, 0, JSON.stringify(prereg.body.errors));
  const runId = prereg.body.run_id as string;

  // The manifest's own `certification_receipt_hash` is the all-zero bootstrap
  // sentinel, and the frozen current receipt is not — so the two are
  // distinguishable, which is exactly what the old implementation could not be
  // tested for.
  const manifest = run.registry.externalAdapterManifestsById[NEUTRAL_ADAPTER_ID];
  assert.ok(manifest);
  assert.equal(manifest.certification_receipt_hash, BOOTSTRAP_RECEIPT_SENTINEL);
  assert.notEqual(run.certificationHash, BOOTSTRAP_RECEIPT_SENTINEL);

  // Force an adapter-owned failure: substitute the entry before the first
  // dispatch, so the host refuses on the digest and the run invalidates.
  copyFileSync(neutralFixture("marker"), run.entry);
  const failed = erl2([
    "acquire",
    "--run-root", run.runRoot,
    "--registry", run.registry.root,
    "--tier", "development",
    "--run", runId,
    "--adapter-entry", run.entry,
  ]);
  assert.notEqual(failed.exitCode, 0);
  assert.equal(failed.body.errors[0]?.code, "ADAPTER_IDENTITY_MISMATCH");
  assert.equal(failed.body.state, "invalidated", "an adapter-owned failure invalidates the run");
  assert.equal(markerPresent(run.runRoot), false, "the substituted adapter must not have run");

  const findings = walk(path.join(run.runRoot, "retained")).filter(
    (f) => path.basename(f).startsWith("finding-adapter-") && f.endsWith(".json"),
  );
  assert.ok(findings.length > 0, "an adapter failure must freeze a finding");
  const finding = JSON.parse(readFileSync(findings[0] as string, "utf8")) as {
    certification_receipt_hash?: string;
    kind?: string;
  };
  assert.equal(finding.kind, "adapter_failure");
  assert.equal(
    finding.certification_receipt_hash,
    run.certificationHash,
    "the finding must name the receipt that authorized the failed execution",
  );
  assert.notEqual(
    finding.certification_receipt_hash,
    BOOTSTRAP_RECEIPT_SENTINEL,
    "the finding named the manifest's bootstrap/prior sentinel instead of the current receipt",
  );
});

// -- 15/16/17. per-dispatch digest enforcement is load-bearing ---------------
//
// Driven straight at `AdapterHost`, because that is where the per-dispatch
// comparison lives and where removing it has to be caught. Both cases perform a
// real first dispatch, substitute an adapter that announces the *same* identity
// and would answer correctly, then dispatch again: the entry digest is the only
// thing that can refuse it.

function neutralHostFixture(entry: string): ReturnType<typeof newHost> {
  const manifest = adapterManifest({
    adapterId: NEUTRAL_ADAPTER_ID,
    artifactHash: hashBytes(readFileSync(entry)),
    certificationReceiptHash: BOOTSTRAP_RECEIPT_SENTINEL,
    operations: [...NEUTRAL_OPERATIONS],
    packageKinds: ["archive"],
  });
  return newHost(manifest, entry, {
    certifiedArtifactHash: hashBytes(readFileSync(entry)),
  });
}

function dispatchRefusedAfterSubstitution(
  label: string,
  substitute: (entry: string) => void,
  entry: string,
): void {
  const fixture = neutralHostFixture(entry);

  // 1. One valid dispatch through the admitted bytes.
  const first = fixture.host.run({
    operation: "acquire",
    operationId: "op-first",
    request: acquisitionRequest("op-first"),
  });
  assert.equal(first.envelope.status, "supported", `${label}: the admitted adapter must answer`);
  assert.equal(markerPresent(fixture.workspaceRoot), false, `${label}: no marker yet`);

  // 2. Substitute.
  substitute(entry);

  // 3/4. A second dispatch is refused, typed, before anything is spawned.
  let code = "";
  try {
    fixture.host.run({
      operation: "acquire",
      operationId: "op-second",
      request: acquisitionRequest("op-second"),
    });
  } catch (error) {
    code = (error as { code?: string }).code ?? "";
  }
  assert.equal(
    code,
    "ADAPTER_IDENTITY_MISMATCH",
    `${label}: the per-dispatch digest comparison did not refuse the substitution`,
  );

  // 5. And the substitute never executed.
  assert.equal(
    markerPresent(fixture.workspaceRoot),
    false,
    `${label}: the substituted adapter executed`,
  );
}

test("PER-DISPATCH: deterministic replacement at the same path is refused before it executes", () => {
  const entry = stagedAdapter("compliant");
  dispatchRefusedAfterSubstitution(
    "same-path replacement",
    (target) => copyFileSync(neutralFixture("marker"), target),
    entry,
  );
});

test("PER-DISPATCH: retargeting a symlinked entry is refused before it executes", () => {
  // The run's entry is a symlink; the admitted bytes are its target.
  const linkDir = ownedTempDir("erl2-neutral-link-");
  copyFileSync(
    path.join(repoRoot, "fixtures", "neutral", "adapters", "_frame.mjs"),
    path.join(linkDir, "_frame.mjs"),
  );
  const link = path.join(linkDir, "main.mjs");
  symlinkSync(stagedAdapter("compliant"), link);

  dispatchRefusedAfterSubstitution(
    "symlink retarget",
    (target) => {
      const substitute = stagedAdapter("marker");
      unlinkSync(target);
      symlinkSync(substitute, target);
    },
    link,
  );
});
