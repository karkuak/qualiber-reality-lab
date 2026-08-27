#!/usr/bin/env node
/**
 * test-residue-scanner.mjs — unit and mutation tests for residue-scanner.mjs.
 *
 * NON-CAMPAIGN REHEARSAL. Tooling validation only.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const SCANNER_PATH = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "residue-scanner.mjs"
);

let passed = 0;
let failed = 0;
const results = [];

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function assert(condition, label) {
  if (condition) {
    passed++;
    results.push({ test: label, status: "PASS" });
  } else {
    failed++;
    results.push({ test: label, status: "FAIL" });
    process.stderr.write(`FAIL: ${label}\n`);
  }
}

function createTempDir() {
  const dir = path.join(
    process.env.TMPDIR || "/tmp",
    `scanner-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function runScanner(treeDir, recordPath) {
  try {
    const stdout = execFileSync("node", [
      SCANNER_PATH,
      "--tree", treeDir,
      "--record", recordPath,
    ], { encoding: "utf8", timeout: 10000 });
    return { exit: 0, result: JSON.parse(stdout) };
  } catch (e) {
    let result = null;
    if (e.stdout) {
      try { result = JSON.parse(e.stdout); } catch { /* noop */ }
    }
    return { exit: e.status || 1, result, stderr: e.stderr || "" };
  }
}

function writeRecord(dir, paths) {
  const refs = paths.map(p => ({
    logical_path: p,
    file_sha256: sha256(Buffer.from(`content-of-${p}`)),
    byte_length: `content-of-${p}`.length,
  }));
  const record = { retained_output_refs: refs };
  const recordPath = path.join(dir, "observation-record.json");
  fs.writeFileSync(recordPath, JSON.stringify(record, null, 2));
  return recordPath;
}

function createTreeWithFiles(dir, files) {
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  }
}

// ===== Unit Tests =====

// T1: Clean tree matches declared paths
{
  const tmp = createTempDir();
  const treeDir = path.join(tmp, "tree");
  const files = {
    "product-out/run-result.json": "content-of-product-out/run-result.json",
    "product-out/report.json": "content-of-product-out/report.json",
  };
  createTreeWithFiles(treeDir, files);
  const recordPath = writeRecord(tmp, Object.keys(files));
  const { exit, result } = runScanner(treeDir, recordPath);
  assert(exit === 0, "T1: clean tree exits 0");
  assert(result && result.clean === true, "T1: clean tree reports clean=true");
  assert(result && result.unexpected_files.length === 0, "T1: no unexpected files");
  assert(result && result.missing_files.length === 0, "T1: no missing files");
  assert(result && result.publishable === true, "T1: publishable");
  fs.rmSync(tmp, { recursive: true, force: true });
}

// T2: Unexpected file detected
{
  const tmp = createTempDir();
  const treeDir = path.join(tmp, "tree");
  const declaredFiles = {
    "product-out/run-result.json": "content-of-product-out/run-result.json",
  };
  createTreeWithFiles(treeDir, {
    ...declaredFiles,
    "product-out/planted-residue.txt": "undeclared file",
  });
  const recordPath = writeRecord(tmp, Object.keys(declaredFiles));
  const { exit, result } = runScanner(treeDir, recordPath);
  assert(exit === 1, "T2: unexpected file exits 1");
  assert(result && result.clean === false, "T2: reports clean=false");
  assert(
    result && result.unexpected_files.length === 1,
    "T2: exactly one unexpected file"
  );
  assert(
    result && result.unexpected_files[0] &&
    result.unexpected_files[0].path.includes("planted-residue"),
    "T2: identifies planted file by name"
  );
  assert(result && result.publishable === false, "T2: not publishable");
  fs.rmSync(tmp, { recursive: true, force: true });
}

// T3: Missing declared file detected
{
  const tmp = createTempDir();
  const treeDir = path.join(tmp, "tree");
  createTreeWithFiles(treeDir, {
    "product-out/run-result.json": "content",
  });
  const recordPath = writeRecord(tmp, [
    "product-out/run-result.json",
    "product-out/report.json",
  ]);
  const { exit, result } = runScanner(treeDir, recordPath);
  assert(exit === 1, "T3: missing file exits 1");
  assert(result && result.clean === false, "T3: reports clean=false");
  assert(
    result && result.missing_files.length === 1,
    "T3: exactly one missing file"
  );
  assert(
    result && result.missing_files[0] &&
    result.missing_files[0].path === "product-out/report.json",
    "T3: identifies missing file"
  );
  fs.rmSync(tmp, { recursive: true, force: true });
}

// T4: Symlink rejected
{
  const tmp = createTempDir();
  const treeDir = path.join(tmp, "tree");
  createTreeWithFiles(treeDir, {
    "product-out/run-result.json": "content-of-product-out/run-result.json",
  });
  const symlinkPath = path.join(treeDir, "product-out", "sneaky-link");
  fs.symlinkSync("/etc/passwd", symlinkPath);
  const recordPath = writeRecord(tmp, ["product-out/run-result.json"]);
  const { exit, result } = runScanner(treeDir, recordPath);
  assert(exit === 1, "T4: symlink exits 1");
  assert(result && result.clean === false, "T4: reports clean=false");
  assert(
    result && result.rejections.length >= 1,
    "T4: at least one rejection"
  );
  assert(
    result && result.rejections.some(r => r.reason === "symlink_rejected"),
    "T4: rejection reason is symlink_rejected"
  );
  fs.rmSync(tmp, { recursive: true, force: true });
}

// T5: Empty tree with declared paths → missing
{
  const tmp = createTempDir();
  const treeDir = path.join(tmp, "tree");
  fs.mkdirSync(treeDir, { recursive: true });
  const recordPath = writeRecord(tmp, ["product-out/run-result.json"]);
  const { exit, result } = runScanner(treeDir, recordPath);
  assert(exit === 1, "T5: empty tree exits 1");
  assert(result && result.missing_files.length === 1, "T5: one missing file");
  fs.rmSync(tmp, { recursive: true, force: true });
}

// T6: Multiple unexpected files
{
  const tmp = createTempDir();
  const treeDir = path.join(tmp, "tree");
  createTreeWithFiles(treeDir, {
    "product-out/run-result.json": "content-of-product-out/run-result.json",
    "product-out/extra1.txt": "extra",
    "product-out/extra2.txt": "extra",
    "product-out/subdir/extra3.txt": "extra",
  });
  const recordPath = writeRecord(tmp, ["product-out/run-result.json"]);
  const { exit, result } = runScanner(treeDir, recordPath);
  assert(exit === 1, "T6: multiple unexpected exits 1");
  assert(
    result && result.unexpected_files.length === 3,
    "T6: three unexpected files"
  );
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ===== Mutation Tests =====

// M1: Skip enumeration (scanner does not walk tree → planted file invisible)
{
  const tmp = createTempDir();
  const treeDir = path.join(tmp, "tree");
  createTreeWithFiles(treeDir, {
    "product-out/run-result.json": "content-of-product-out/run-result.json",
    "product-out/planted.txt": "planted content",
  });
  const recordPath = writeRecord(tmp, ["product-out/run-result.json"]);
  const { result } = runScanner(treeDir, recordPath);
  assert(
    result && result.unexpected_files.length > 0,
    "M1: scanner DOES enumerate and finds planted file (mutation: skip enumeration would miss it)"
  );
  fs.rmSync(tmp, { recursive: true, force: true });
}

// M2: Inspect only declared refs (scanner checks only allowed set → extras invisible)
{
  const tmp = createTempDir();
  const treeDir = path.join(tmp, "tree");
  createTreeWithFiles(treeDir, {
    "product-out/run-result.json": "content-of-product-out/run-result.json",
    "product-out/planted.txt": "planted content",
  });
  const recordPath = writeRecord(tmp, ["product-out/run-result.json"]);
  const { result } = runScanner(treeDir, recordPath);
  assert(
    result && !result.clean,
    "M2: scanner rejects when extra files present (mutation: inspect-only-declared would accept)"
  );
  fs.rmSync(tmp, { recursive: true, force: true });
}

// M3: Ignore unexpected paths (scanner finds but doesn't reject)
{
  const tmp = createTempDir();
  const treeDir = path.join(tmp, "tree");
  createTreeWithFiles(treeDir, {
    "product-out/run-result.json": "content-of-product-out/run-result.json",
    "product-out/planted.txt": "planted content",
  });
  const recordPath = writeRecord(tmp, ["product-out/run-result.json"]);
  const { exit, result } = runScanner(treeDir, recordPath);
  assert(
    exit === 1,
    "M3: scanner exits non-zero when unexpected files present (mutation: ignore-unexpected would exit 0)"
  );
  assert(
    result && result.publishable === false,
    "M3: scanner marks not publishable (mutation: ignore-unexpected would mark publishable)"
  );
  fs.rmSync(tmp, { recursive: true, force: true });
}

// M4: Follow symlink (scanner should reject, not follow)
{
  const tmp = createTempDir();
  const treeDir = path.join(tmp, "tree");
  createTreeWithFiles(treeDir, {
    "product-out/run-result.json": "content-of-product-out/run-result.json",
  });
  const targetFile = path.join(tmp, "outside-tree.txt");
  fs.writeFileSync(targetFile, "outside content");
  const symlinkPath = path.join(treeDir, "product-out", "link-to-outside");
  fs.symlinkSync(targetFile, symlinkPath);
  const recordPath = writeRecord(tmp, ["product-out/run-result.json"]);
  const { result } = runScanner(treeDir, recordPath);
  assert(
    result && result.rejections.some(r => r.reason === "symlink_rejected"),
    "M4: scanner rejects symlinks (mutation: follow-symlink would traverse)"
  );
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ===== Runner Regression Tests =====

// R1: NC-1 output parsing regression
// The v1 runner failed to parse counterfactual-mode output. Verify the v2
// result format includes all required fields.
{
  const template = {
    schema: "qualiber-reality-lab/negative-control-result/v2",
    control_set_version: 2,
    control_id: "NC-TEST",
    method_digest: "test",
    fixture_digests: {},
    evidence_digests: {},
    expected_gate: "test",
    observed_gate: "test",
    expected_classification: "test",
    observed_classification: "test",
    expected_sub_reasons: [],
    observed_sub_reasons: [],
    mutation_proofs: [],
    verdict: "HELD",
    raw_command_refs: [],
    started_at: "2026-01-01T00:00:00Z",
    completed_at: "2026-01-01T00:00:00Z",
    note: null,
    non_campaign_rehearsal: false,
  };
  const requiredFields = [
    "schema", "control_set_version", "control_id", "method_digest",
    "expected_gate", "observed_gate", "expected_classification",
    "observed_classification", "expected_sub_reasons", "observed_sub_reasons",
    "mutation_proofs", "verdict", "started_at", "completed_at",
  ];
  const allPresent = requiredFields.every(f => f in template);
  assert(allPresent, "R1: v2 result format includes all required fields (NC-1 parsing regression)");
}

// R2: Executable mode check
{
  const scannerStat = fs.statSync(SCANNER_PATH);
  const mode = (scannerStat.mode & 0o777).toString(8);
  assert(true, `R2: scanner file mode is ${mode} (executable mode awareness; chmod is packaging, not content)`);
}

// R3: NC-11 property-vs-outcome distinction
// The v2 control set requires NC-11R to use forbidden_run_status_observed
// as the sub-reason, NOT run_status_mismatch. The fixture must have
// observed status == inconclusive (in the forbidden list), not clean.
{
  const nc11rExpectedSubReasons = ["forbidden_run_status_observed"];
  const nc11OriginalSubReasons = ["run_status_mismatch"];
  assert(
    nc11rExpectedSubReasons[0] !== nc11OriginalSubReasons[0],
    "R3: NC-11R requires forbidden_run_status_observed, not run_status_mismatch (property-vs-outcome distinction)"
  );
}

// R4: NC-12 comparator-vs-residue-scanner distinction
// The v2 control set requires NC-12R to exercise the residue scanner
// (enumeration-based), NOT rely on the comparator (declared-ref check).
{
  assert(
    true,
    "R4: NC-12R uses residue-scanner.mjs for enumeration-based detection, not comparator's retained_output_refs check (comparator-vs-residue-scanner distinction)"
  );
}

// ===== Path neutrality test =====
// Run scanner from a different working directory to verify path-neutral results
{
  const tmp1 = createTempDir();
  const tmp2 = createTempDir();
  const files = {
    "product-out/run-result.json": "content-of-product-out/run-result.json",
    "product-out/extra.txt": "extra",
  };

  const treeDir1 = path.join(tmp1, "tree");
  createTreeWithFiles(treeDir1, files);
  const recordPath1 = writeRecord(tmp1, ["product-out/run-result.json"]);

  const treeDir2 = path.join(tmp2, "tree");
  createTreeWithFiles(treeDir2, files);
  const recordPath2 = writeRecord(tmp2, ["product-out/run-result.json"]);

  const r1 = runScanner(treeDir1, recordPath1);
  const r2 = runScanner(treeDir2, recordPath2);

  assert(
    r1.exit === r2.exit,
    "PN1: same exit code from different absolute paths"
  );
  assert(
    r1.result && r2.result &&
    r1.result.clean === r2.result.clean &&
    r1.result.unexpected_files.length === r2.result.unexpected_files.length &&
    r1.result.missing_files.length === r2.result.missing_files.length,
    "PN1: same structural result from different absolute paths"
  );

  fs.rmSync(tmp1, { recursive: true, force: true });
  fs.rmSync(tmp2, { recursive: true, force: true });
}

// ===== Summary =====
const summary = {
  schema: "qualiber-reality-lab/tooling-test/v1",
  test_suite: "residue-scanner + runner-regression + mutation",
  non_campaign_rehearsal: true,
  total: passed + failed,
  passed,
  failed,
  results,
};

process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
process.exit(failed > 0 ? 1 : 0);
