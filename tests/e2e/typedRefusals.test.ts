/**
 * Every CLI outcome is a typed, Lab-owned envelope (design Appendix B/C, §20).
 *
 * The review's P3 cluster noted that a torn `state/snapshot.json` crashed with an
 * uncatalogued exit; that specific path was repaired, but the *general* escape
 * hatch survived: `runCommand` rethrew any non-`Erl2Error` and `bin.ts` had no
 * top-level guard, so a missing or malformed `--public-bundle`, `--record` or
 * `--root-config` escaped as a raw `ENOENT`/`SyntaxError` stack trace on stderr
 * with exit 1, no `code`, no `authority_scope`, and no JSON envelope at all.
 * Reproduced against the shipped CLI before the fix.
 *
 * These cases pin the guarantee: whatever the input, stdout is one parseable
 * envelope carrying a catalogued code and the Lab authority scope.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ERL2_ERROR_PREFIXES } from "@erl2/contracts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const cli = path.join(repoRoot, "packages", "cli", "dist", "src", "bin.js");
const goldenValid = path.join(repoRoot, "fixtures", "golden", "valid-pre-environment-run");

interface Envelope {
  readonly schema_version?: string;
  readonly ok?: boolean;
  readonly exit_code?: number;
  readonly authority_scope?: string;
  readonly errors?: readonly { code: string; message: string }[];
}

function runCli(args: readonly string[]): { exitCode: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
  return { exitCode: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

/** Asserts the invocation produced exactly one typed, Lab-owned refusal envelope. */
function assertTypedRefusal(args: readonly string[], label: string): string {
  const result = runCli(args);
  assert.notEqual(result.exitCode, 0, `${label} must not succeed`);
  assert.equal(result.stderr, "", `${label} must not print a raw stack trace: ${result.stderr.slice(0, 300)}`);
  let body: Envelope;
  try {
    body = JSON.parse(result.stdout) as Envelope;
  } catch {
    assert.fail(`${label} did not emit a JSON envelope; stdout was: ${result.stdout.slice(0, 300)}`);
  }
  assert.equal(body.schema_version, "erl2-cli-response/v1", `${label} envelope shape`);
  assert.equal(body.ok, false, `${label} must report ok:false`);
  assert.equal(body.authority_scope, "lab_orchestration_only", `${label} authority scope`);
  assert.equal(body.exit_code, result.exitCode, `${label} envelope exit must match the process exit`);
  const code = body.errors?.[0]?.code;
  assert.ok(typeof code === "string" && code.length > 0, `${label} must carry an error code`);
  assert.ok(
    ERL2_ERROR_PREFIXES.some((prefix) => (code as string).startsWith(prefix)),
    `${label} code ${String(code)} must use a catalogued Appendix B prefix`,
  );
  return code as string;
}

function freshValidCopy(): string {
  const dest = mkdtempSync(path.join(tmpdir(), "erl2-typed-"));
  cpSync(goldenValid, dest, { recursive: true });
  return dest;
}

function overwrite(file: string, bytes: string): void {
  chmodSync(file, 0o644);
  writeFileSync(file, bytes);
}

function verifyArgs(dir: string): readonly string[] {
  return [
    "verify",
    "--public-bundle", path.join(dir, "public-bundle.json"),
    "--root-config", path.join(dir, "root-config.json"),
    "--artifact-root", path.join(dir, "artifacts"),
    "--lifecycle", path.join(dir, "lifecycle.json"),
    "--offline",
  ];
}

test("TYPED-REFUSAL: a missing --public-bundle is a catalogued refusal, not an ENOENT stack", () => {
  const dir = freshValidCopy();
  const args = [...verifyArgs(dir)];
  args[2] = path.join(dir, "does-not-exist.json");
  assert.equal(assertTypedRefusal(args, "missing public bundle"), "CFG_MISSING_REQUIRED");
});

test("TYPED-REFUSAL: a malformed --public-bundle is a catalogued refusal, not a SyntaxError", () => {
  const dir = freshValidCopy();
  overwrite(path.join(dir, "public-bundle.json"), "{ this is not json");
  assert.equal(assertTypedRefusal(verifyArgs(dir), "malformed public bundle"), "SCHEMA_VALIDATION_FAILED");
});

test("TYPED-REFUSAL: a malformed --root-config is a catalogued refusal", () => {
  const dir = freshValidCopy();
  overwrite(path.join(dir, "root-config.json"), "\u0000\u0001garbage");
  assert.equal(assertTypedRefusal(verifyArgs(dir), "malformed root config"), "SCHEMA_VALIDATION_FAILED");
});

test("TYPED-REFUSAL: a malformed --lifecycle is a catalogued refusal", () => {
  const dir = freshValidCopy();
  overwrite(path.join(dir, "lifecycle.json"), "[[[");
  assert.equal(assertTypedRefusal(verifyArgs(dir), "malformed lifecycle"), "SCHEMA_VALIDATION_FAILED");
});

test("TYPED-REFUSAL: a missing --record for verify-record is a catalogued refusal", () => {
  const dir = freshValidCopy();
  assertTypedRefusal(
    [
      "verify-record",
      "--record", path.join(dir, "absent-record.json"),
      "--lifecycle", path.join(dir, "lifecycle.json"),
      "--artifact-root", path.join(dir, "artifacts"),
      "--root-config", path.join(dir, "root-config.json"),
      "--offline",
    ],
    "missing invalid record",
  );
});

test("TYPED-REFUSAL: a malformed --record is a catalogued refusal", () => {
  const dir = freshValidCopy();
  const record = path.join(dir, "record.json");
  writeFileSync(record, "not json at all");
  assert.equal(
    assertTypedRefusal(
      [
        "verify-record",
        "--record", record,
        "--lifecycle", path.join(dir, "lifecycle.json"),
        "--artifact-root", path.join(dir, "artifacts"),
        "--root-config", path.join(dir, "root-config.json"),
        "--offline",
      ],
      "malformed invalid record",
    ),
    "SCHEMA_VALIDATION_FAILED",
  );
});

test("TYPED-REFUSAL: an unknown command and an unknown flag stay catalogued", () => {
  assert.equal(assertTypedRefusal(["not-a-command"], "unknown command"), "CFG_UNKNOWN_FLAG");
  assert.equal(assertTypedRefusal(["doctor", "--nope"], "unknown flag"), "CFG_UNKNOWN_FLAG");
});

test("TYPED-REFUSAL: LAB_UNEXPECTED_FAILURE is catalogued and Lab-owned", async () => {
  // The backstop code itself must be a legal Appendix B code with the Lab owner,
  // so an escaped throwable can never produce an uncatalogued envelope.
  const { Erl2Error, CODES } = await import("@erl2/contracts");
  const error = new Erl2Error(CODES.LAB_UNEXPECTED_FAILURE, "probe");
  assert.equal(error.owner, "lab");
  assert.ok(ERL2_ERROR_PREFIXES.some((p) => CODES.LAB_UNEXPECTED_FAILURE.startsWith(p)));
});
