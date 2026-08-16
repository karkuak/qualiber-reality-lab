/**
 * The operator's own experience of the two commands.
 *
 * Every case here runs the public CLI, most of them in a fresh process, so
 * what is measured is what an operator would actually get: the help text, the
 * refusals, the exit code, the machine-readable summary, and whether the
 * worked example in the runbook is a thing that runs or a thing that reads
 * like it would.
 */

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { CODES } from "@erl2/contracts";
import { TRUSTED_LOCAL_ACKNOWLEDGEMENT_TOKEN } from "@erl2/core";
import { runCommand } from "@erl2/cli";
import { ownedTempDir } from "../support/tempDirs.js";
import { repoRoot } from "../support/adapterFixtures.js";
import {
  ELEVEN_OPERATION_CLEAN_PLAN,
  writeTrustedLocalInputs,
} from "../support/trustedLocalFixtures.js";

const CLI = path.join(repoRoot, "packages", "cli", "dist", "src", "bin.js");

interface CliRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly json: Record<string, unknown>;
}

/** Runs the shipped CLI binary in a fresh process, as an operator would. */
function cli(argv: readonly string[]): CliRun {
  const child = spawnSync(process.execPath, [CLI, ...argv], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(child.stdout) as Record<string, unknown>;
  } catch {
    json = { unparsed: child.stdout.slice(0, 512), stderr: child.stderr.slice(0, 512) };
  }
  return { status: child.status, stdout: child.stdout, json };
}

test("TRUSTED-LOCAL-CLI: command-specific help works and names the trust ceiling", () => {
  const help = cli(["help"]);
  assert.equal(help.status, 0);
  const usage = (help.json["data"] as { usage: Record<string, Record<string, unknown>> }).usage;
  for (const command of ["declare-trusted-local-adapter", "run-trusted-local-observation"]) {
    const entry = usage[command];
    assert.ok(entry !== undefined, `${command} has no usage entry`);
    const text = JSON.stringify(entry).toLowerCase();
    assert.match(text, /not sandboxed|confinement/, `${command} does not mention confinement`);
    assert.match(text, /unscored/, `${command} does not mention scoring`);
    assert.match(text, /unauthenticated/, `${command} does not mention authentication`);
    assert.match(text, /not certif|no certifier/, `${command} does not mention certification`);
  }
  // The exact acknowledgement is discoverable from help, because an operator
  // cannot be asked to reproduce a sentence they were never shown.
  assert.equal(
    (usage["declare-trusted-local-adapter"] as { acknowledgement: string }).acknowledgement,
    TRUSTED_LOCAL_ACKNOWLEDGEMENT_TOKEN,
  );
});

test("TRUSTED-LOCAL-CLI: neither command requests a governor hash or a certifier identity", () => {
  const help = cli(["help"]);
  const usage = (help.json["data"] as { usage: Record<string, Record<string, unknown>> }).usage;
  for (const command of ["declare-trusted-local-adapter", "run-trusted-local-observation"]) {
    const flags = Object.keys({
      ...((usage[command] as { required_flags?: Record<string, string> }).required_flags ?? {}),
      ...((usage[command] as { optional_flags?: Record<string, string> }).optional_flags ?? {}),
    });
    for (const forbidden of [
      "governor",
      "preregistration",
      "certification-receipt",
      "certifier",
      "signature",
      "acquisition",
      "selected-challenge",
      "trust-policy",
    ]) {
      assert.ok(
        !flags.some((flag) => flag.includes(forbidden)),
        `${command} exposes a ${forbidden} flag: ${flags.join(", ")}`,
      );
    }
  }
});

test("TRUSTED-LOCAL-CLI: the worked neutral example executes end to end in a fresh process", () => {
  const root = ownedTempDir("erl2-tlo-worked-");
  const inputs = writeTrustedLocalInputs(root, ELEVEN_OPERATION_CLEAN_PLAN);

  // Step one: write the declaration. The plan draft is sealed in the same
  // step, because a plan whose authority binding an operator typed by hand is
  // a binding nobody verified.
  const draft = JSON.parse(readFileSync(inputs.planPath, "utf8")) as Record<string, unknown>;
  delete draft["trusted_local_declaration_hash"];
  delete draft["core_hash"];
  const draftPath = path.join(root, "plan-draft.json");
  writeFileSync(draftPath, `${JSON.stringify(draft, null, 2)}\n`);

  const declared = cli([
    "declare-trusted-local-adapter",
    "--adapter-entry", inputs.entryPath,
    "--manifest", inputs.manifestPath,
    "--acknowledge-trusted-local-code", TRUSTED_LOCAL_ACKNOWLEDGEMENT_TOKEN,
    "--acknowledged-by", "neutral fixture operator",
    "--declaration-id", "worked-example-declaration",
    "--output", path.join(root, "worked-declaration.json"),
    "--seal-plan-draft", draftPath,
    "--plan-output", path.join(root, "worked-plan.json"),
  ]);
  assert.equal(declared.status, 0, declared.stdout.slice(0, 1200));
  const declaredData = declared.json["data"] as Record<string, unknown>;
  assert.equal(declaredData["trust_mode"], "trusted_local_code");
  assert.equal(declaredData["independent_certifier"], null);
  assert.equal(declaredData["confinement"], "absent");
  assert.ok(
    (declaredData["trust_warning"] as readonly string[]).some((line) =>
      line.includes("NOT sandboxed"),
    ),
    "the declaration summary must carry a visible trust warning",
  );

  // Step two: run it.
  const ran = cli([
    "run-trusted-local-observation",
    "--adapter-entry", inputs.entryPath,
    "--manifest", inputs.manifestPath,
    "--plan", String(declaredData["sealed_plan_path"]),
    "--owner-declaration", String(declaredData["declaration_path"]),
    "--output-root", path.join(root, "worked-output"),
  ]);
  assert.equal(ran.status, 0, ran.stdout.slice(0, 2000));
  const data = ran.json["data"] as Record<string, unknown>;
  assert.equal((data["operations"] as readonly unknown[]).length, 11);
  assert.equal(data["terminal_status"], "observed_complete");
  assert.equal(data["independent_certification"], "absent");
  assert.equal(data["confinement"], "absent");
  assert.equal((data["offline_verification"] as { ok: boolean }).ok, true);
  assert.ok(
    (data["trust_warning"] as readonly string[]).some((line) => line.includes("NOT sandboxed")),
    "the run summary must carry a visible trust warning",
  );
});

test("TRUSTED-LOCAL-CLI: the machine-readable summary is the whole story", () => {
  const root = ownedTempDir("erl2-tlo-summary-");
  const inputs = writeTrustedLocalInputs(root, ELEVEN_OPERATION_CLEAN_PLAN);
  const ran = cli([
    "run-trusted-local-observation",
    "--adapter-entry", inputs.entryPath,
    "--manifest", inputs.manifestPath,
    "--plan", inputs.planPath,
    "--owner-declaration", inputs.declarationPath,
    "--output-root", inputs.outputRoot,
  ]);
  assert.equal(ran.status, 0, ran.stdout.slice(0, 1200));
  const data = ran.json["data"] as Record<string, unknown>;
  for (const field of [
    "observation_id",
    "trust_mode",
    "tier",
    "adapter_artifact_hash",
    "adapter_manifest_hash",
    "trusted_local_declaration_hash",
    "admission_authority",
    "plan_hash",
    "operations",
    "cleanup",
    "terminal_status",
    "record_path",
    "record_file_hash",
    "retained_plan_path",
    "offline_verification",
    "operator_acknowledgement",
  ]) {
    assert.ok(field in data, `the summary omits ${field}`);
  }
  // The acknowledgement is in the summary and in the record, not only in a
  // file the operator has to remember to open.
  const acknowledgement = data["operator_acknowledgement"] as Record<string, unknown>;
  assert.equal(acknowledgement["acknowledgement_token"], TRUSTED_LOCAL_ACKNOWLEDGEMENT_TOKEN);
  const record = JSON.parse(readFileSync(String(data["record_path"]), "utf8")) as Record<string, unknown>;
  assert.equal(record["confinement"], "absent");
  assert.equal(record["independent_certification"], "absent");
  // Nothing in the terminal describes this as certified, verified or ready.
  const text = JSON.stringify(record).toLowerCase();
  for (const forbidden of ['"certified"', '"independently_verified"', '"production_ready"']) {
    assert.ok(!text.includes(forbidden), `the retained record contains ${forbidden}`);
  }
});

test("TRUSTED-LOCAL-CLI: a refusal exits nonzero and names the missing input", () => {
  const missing = cli([
    "run-trusted-local-observation",
    "--adapter-entry", path.join(repoRoot, "fixtures", "neutral", "does-not-exist.mjs"),
    "--manifest", path.join(repoRoot, "package.json"),
    "--plan", path.join(repoRoot, "package.json"),
    "--owner-declaration", path.join(repoRoot, "package.json"),
    "--output-root", ownedTempDir("erl2-tlo-refuse-"),
  ]);
  assert.notEqual(missing.status, 0, "a refusal must not exit zero");
  assert.equal((missing.json["errors"] as readonly { code: string }[])[0]?.code, CODES.CFG_MISSING_REQUIRED);
});

test("TRUSTED-LOCAL-CLI: a governed input is refused by name", () => {
  const root = ownedTempDir("erl2-tlo-governed-");
  const inputs = writeTrustedLocalInputs(root, ELEVEN_OPERATION_CLEAN_PLAN);
  const refused = runCommand([
    "run-trusted-local-observation",
    "--adapter-entry", inputs.entryPath,
    "--manifest", inputs.manifestPath,
    "--plan", inputs.planPath,
    "--owner-declaration", inputs.declarationPath,
    "--output-root", inputs.outputRoot,
    "--registry-governor", "/somewhere",
  ]);
  assert.equal(refused.ok, false);
  assert.equal(refused.errors?.[0]?.code, CODES.ADAPTER_LOCAL_CONTEXT_FORBIDDEN);
  assert.match(String(refused.errors?.[0]?.message), /governed/);
});

test("TRUSTED-LOCAL-CLI: a certification receipt flag is refused by name", () => {
  const root = ownedTempDir("erl2-tlo-receiptflag-");
  const inputs = writeTrustedLocalInputs(root, ELEVEN_OPERATION_CLEAN_PLAN);
  const refused = runCommand([
    "run-trusted-local-observation",
    "--adapter-entry", inputs.entryPath,
    "--manifest", inputs.manifestPath,
    "--plan", inputs.planPath,
    "--owner-declaration", inputs.declarationPath,
    "--output-root", inputs.outputRoot,
    "--certification-receipt", "/somewhere",
  ]);
  assert.equal(refused.ok, false);
  assert.equal(refused.errors?.[0]?.code, CODES.ADAPTER_LOCAL_CONTEXT_FORBIDDEN);
});

test("TRUSTED-LOCAL-CLI: a near-miss acknowledgement is refused, and the refusal shows the exact sentence", () => {
  const root = ownedTempDir("erl2-tlo-ack-");
  const inputs = writeTrustedLocalInputs(root, ELEVEN_OPERATION_CLEAN_PLAN);
  for (const attempt of ["yes", "true", TRUSTED_LOCAL_ACKNOWLEDGEMENT_TOKEN.toLowerCase()]) {
    const refused = runCommand([
      "declare-trusted-local-adapter",
      "--adapter-entry", inputs.entryPath,
      "--manifest", inputs.manifestPath,
      "--acknowledge-trusted-local-code", attempt,
      "--acknowledged-by", "someone in a hurry",
      "--declaration-id", "hurried-declaration",
      "--output", path.join(root, `declaration-${attempt.slice(0, 4)}.json`),
    ]);
    assert.equal(refused.ok, false, `"${attempt.slice(0, 24)}" must not be accepted`);
    assert.equal(refused.errors?.[0]?.code, CODES.ADAPTER_TRUSTED_LOCAL_ACKNOWLEDGEMENT_INVALID);
    assert.match(String(refused.errors?.[0]?.message), /I ACCEPT THAT THESE EXACT ADAPTER BYTES/);
  }
});

test("TRUSTED-LOCAL-CLI: the run creates nothing outside its own output root", () => {
  const root = ownedTempDir("erl2-tlo-residue-");
  const inputs = writeTrustedLocalInputs(root, ELEVEN_OPERATION_CLEAN_PLAN);
  const before = readdirSync(root).sort();
  const ran = runCommand([
    "run-trusted-local-observation",
    "--adapter-entry", inputs.entryPath,
    "--manifest", inputs.manifestPath,
    "--plan", inputs.planPath,
    "--owner-declaration", inputs.declarationPath,
    "--output-root", inputs.outputRoot,
  ]);
  assert.equal(ran.ok, true, JSON.stringify(ran.errors));
  const after = readdirSync(root).sort();
  assert.deepEqual(
    after.filter((entry) => !before.includes(entry)),
    ["run-output"],
    "the run added something beside its output root",
  );
  // The retained set is exactly what the record names, and the record and its
  // plan sit together so offline verification needs nothing else.
  assert.ok(existsSync(path.join(inputs.outputRoot, "trusted-local-observation-record.json")));
  assert.ok(existsSync(path.join(inputs.outputRoot, "observation-plan.json")));
  assert.ok(existsSync(path.join(inputs.outputRoot, "registry")));
});

test("TRUSTED-LOCAL-CLI: an existing record is never silently overwritten", () => {
  const root = ownedTempDir("erl2-tlo-overwrite-");
  const inputs = writeTrustedLocalInputs(root, ELEVEN_OPERATION_CLEAN_PLAN);
  const first = runCommand([
    "run-trusted-local-observation",
    "--adapter-entry", inputs.entryPath,
    "--manifest", inputs.manifestPath,
    "--plan", inputs.planPath,
    "--owner-declaration", inputs.declarationPath,
    "--output-root", inputs.outputRoot,
  ]);
  assert.equal(first.ok, true, JSON.stringify(first.errors));
  const retained = readFileSync(path.join(inputs.outputRoot, "trusted-local-observation-record.json"));
  const second = runCommand([
    "run-trusted-local-observation",
    "--adapter-entry", inputs.entryPath,
    "--manifest", inputs.manifestPath,
    "--plan", inputs.planPath,
    "--owner-declaration", inputs.declarationPath,
    "--output-root", inputs.outputRoot,
  ]);
  assert.equal(second.ok, false, "a second run into the same root must refuse");
  assert.deepEqual(
    readFileSync(path.join(inputs.outputRoot, "trusted-local-observation-record.json")),
    retained,
    "the first run's evidence must survive the refusal byte for byte",
  );
});

test("TRUSTED-LOCAL-CLI: a symlinked adapter entry is refused rather than followed", () => {
  const root = ownedTempDir("erl2-tlo-symlink-");
  const inputs = writeTrustedLocalInputs(root, ELEVEN_OPERATION_CLEAN_PLAN);
  const link = path.join(root, "entry-link.mjs");
  // A symlink's target can be repointed between the check and the read, so the
  // path itself has to be the regular file rather than resolve to one.
  symlinkSync(inputs.entryPath, link);
  const refused = runCommand([
    "run-trusted-local-observation",
    "--adapter-entry", link,
    "--manifest", inputs.manifestPath,
    "--plan", inputs.planPath,
    "--owner-declaration", inputs.declarationPath,
    "--output-root", inputs.outputRoot,
  ]);
  assert.equal(refused.ok, false);
  assert.equal(refused.errors?.[0]?.code, CODES.PATH_SYMLINK_REJECTED);
});
