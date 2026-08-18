#!/usr/bin/env node
/**
 * oracle-absence-scan.mjs — TASK-LOCAL CAMPAIGN EVIDENCE TOOLING.
 *
 * MUST NOT be promoted into Reality Lab packages or into Qualiber. It exists
 * only inside the campaign evidence bundle, per plan revision 4.3 §10.3/§10.4
 * and the retained-but-never-promoted precedent of task-local-verify.mjs.
 *
 * WHAT IT SCANS FOR (plan §10.4): campaign-oracle identifiers only.
 *   1. The expectation file path string, and any campaign-relative path under
 *      `expectations/` or `campaign/`.
 *   2. The sha256 of expected.json, oracle-precommit.json (every revision),
 *      execution-lock.json and any tooling script — hex, with and without the
 *      `sha256:` prefix.
 *   3. The campaign schema identifiers.
 *   4. The campaign field names.
 *   5. The scenario identity strings QLB-EXT-001 … QLB-EXT-008.
 *
 * WHAT IT MUST NOT SCAN FOR: `expected_path` or any other contract field; the
 * bare words `expected`, `clean`, `verdict`, `agree`, `oracle`; or any bare
 * product status value. The product is *supposed* to receive the customer's
 * rule expectations — only the campaign oracle is withheld. Scanning for
 * contract vocabulary would abort valid scenarios or be pure theatre.
 *
 * Usage:
 *   node oracle-absence-scan.mjs --label <label> --output <result.json>
 *     --digest-source <oracle-precommit.json|execution-lock.json ...>
 *     [--expectation-path <string> ...]
 *     <target-file-or-directory> ...
 *
 * Exit 0 = scanned clean. Exit 1 = at least one hit (Lab-harness failure,
 * campaign-blocking). Exit 2 = usage/IO error.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const CAMPAIGN_SCHEMA_IDS = [
  "qualiber-reality-lab/campaign-expectation/v1",
  "qualiber-reality-lab/campaign-comparison/v1",
  "qualiber-reality-lab/oracle-precommit/v1",
  "qualiber-reality-lab/execution-lock/v1",
];

const CAMPAIGN_FIELD_NAMES = [
  "expected_run_status",
  "required_finding_types",
  "permitted_additional_types",
  "expected_operation_state",
  "forbidden_run_status",
  "expected_not_run_reason",
  "max_finding_count",
];

const SCENARIO_IDS = Array.from({ length: 8 }, (_, i) => `QLB-EXT-00${i + 1}`);

const CAMPAIGN_PATH_FRAGMENTS = ["expectations/", "campaign/"];

function usage(message) {
  process.stderr.write(`oracle-absence-scan: ${message}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const out = { targets: [], digestSources: [], expectationPaths: [], label: null, output: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--label") out.label = argv[++i];
    else if (a === "--output") out.output = argv[++i];
    else if (a === "--digest-source") out.digestSources.push(argv[++i]);
    else if (a === "--expectation-path") out.expectationPaths.push(argv[++i]);
    else if (a.startsWith("--")) usage(`unknown flag ${a}`);
    else out.targets.push(a);
  }
  if (!out.label) usage("--label is required");
  if (out.targets.length === 0) usage("at least one target is required");
  return out;
}

function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/** Every file under a directory, or the file itself. Symlinks are not followed. */
function walk(target) {
  const st = fs.lstatSync(target);
  if (st.isSymbolicLink()) return [{ file: target, symlink: true }];
  if (st.isFile()) return [{ file: target, symlink: false }];
  if (!st.isDirectory()) return [];
  const found = [];
  for (const name of fs.readdirSync(target).sort()) {
    found.push(...walk(path.join(target, name)));
  }
  return found;
}

/**
 * Needles are built from the digest sources themselves, so a scan cannot go
 * stale relative to what it is protecting.
 */
function buildNeedles(args) {
  const needles = [];
  const add = (value, kind) => {
    if (typeof value === "string" && value.length > 0) needles.push({ value, kind });
  };
  for (const id of CAMPAIGN_SCHEMA_IDS) add(id, "campaign_schema_id");
  for (const f of CAMPAIGN_FIELD_NAMES) add(f, "campaign_field_name");
  for (const s of SCENARIO_IDS) add(s, "scenario_id");
  for (const p of CAMPAIGN_PATH_FRAGMENTS) add(p, "campaign_path_fragment");
  for (const p of args.expectationPaths) add(p, "expectation_path");

  for (const src of args.digestSources) {
    const bytes = fs.readFileSync(src);
    const hex = sha256Hex(bytes);
    add(hex, `digest_of:${path.basename(src)}`);
    add(`sha256:${hex}`, `prefixed_digest_of:${path.basename(src)}`);
    // Every digest the source itself declares is also oracle material.
    let parsed = null;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch {
      parsed = null;
    }
    if (parsed) {
      for (const d of collectDeclaredDigests(parsed)) {
        const bare = d.startsWith("sha256:") ? d.slice(7) : d;
        add(bare, `declared_digest_in:${path.basename(src)}`);
        add(`sha256:${bare}`, `declared_prefixed_digest_in:${path.basename(src)}`);
      }
    }
  }
  // De-duplicate by value, keeping the first kind seen.
  const seen = new Map();
  for (const n of needles) if (!seen.has(n.value)) seen.set(n.value, n);
  return [...seen.values()];
}

/**
 * Expectation, counterfactual and tooling digests only. Stimulus and contract
 * digests are deliberately EXCLUDED: those bytes are the product's legitimate
 * input, they are mounted on purpose, and their digests appear inside the
 * sealed plan by design. Scanning for them would abort every scenario.
 */
function collectDeclaredDigests(node) {
  const out = [];
  const ORACLE_DIGEST_KEYS = new Set([
    "expectation_sha256",
    "counterfactual_expectation_sha256",
    "compare_scenario_mjs_sha256",
    "oracle_absence_scan_mjs_sha256",
    "compare_scenario_test_mjs_sha256",
    "tooling_test_result_sha256",
    "oracle_precommit_sha256",
    "plan_application_note_sha256",
    "reviewed_plan_sha256",
  ]);
  const visit = (value) => {
    if (Array.isArray(value)) {
      for (const v of value) visit(v);
      return;
    }
    if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) {
        if (typeof v === "string" && ORACLE_DIGEST_KEYS.has(k)) out.push(v);
        else visit(v);
      }
    }
  };
  visit(node);
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const needles = buildNeedles(args);
  const files = [];
  for (const t of args.targets) {
    if (!fs.existsSync(t)) usage(`target does not exist: ${t}`);
    files.push(...walk(t));
  }
  const hits = [];
  let scannedFiles = 0;
  let scannedBytes = 0;
  for (const { file, symlink } of files) {
    if (symlink) {
      hits.push({ file, needle: null, kind: "symlink_refused", note: "scan does not follow symlinks" });
      continue;
    }
    const bytes = fs.readFileSync(file);
    scannedFiles += 1;
    scannedBytes += bytes.length;
    const text = bytes.toString("latin1"); // byte-faithful substring search
    for (const n of needles) {
      const at = text.indexOf(n.value);
      if (at !== -1) hits.push({ file, needle: n.value, kind: n.kind, byte_offset: at });
    }
  }
  const result = {
    schema_version: "qualiber-reality-lab/campaign-oracle-scan/v1",
    label: args.label,
    targets: args.targets,
    needle_count: needles.length,
    needle_kinds: [...new Set(needles.map((n) => n.kind))].sort(),
    scanned_files: scannedFiles,
    scanned_bytes: scannedBytes,
    clean: hits.length === 0,
    hits,
  };
  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (args.output) {
    fs.mkdirSync(path.dirname(args.output), { recursive: true });
    fs.writeFileSync(args.output, json);
  } else {
    process.stdout.write(json);
  }
  process.stdout.write(
    `scan ${args.label}: ${result.clean ? "CLEAN" : `${hits.length} HIT(S)`} ` +
      `over ${scannedFiles} file(s), ${needles.length} needle(s)\n`,
  );
  process.exit(result.clean ? 0 : 1);
}

main();
