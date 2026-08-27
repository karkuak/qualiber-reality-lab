#!/usr/bin/env node
/**
 * residue-scanner.mjs — independent residue-integrity scanner for NC-12R.
 *
 * Enumerates every regular file in a retained workspace tree and compares
 * the actual path set against the allowed path set derived from authoritative
 * sources:
 *   1. run-summary.json artifact_hashes (declared product artifacts)
 *   2. observation record retained_output_refs (if populated)
 *   3. Known structural files (run-summary.json itself, stimulus-identity.json)
 *   4. .frozen sidecars for every declared artifact
 *
 * The allowed path set is derived from data, NOT from scenario-specific literals.
 *
 * Exit 0 = clean (actual == allowed). Exit 1 = integrity failure.
 * Exit 2 = usage error. Exit 3 = internal error.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function usage(msg) {
  process.stderr.write(`residue-scanner: ${msg}\n`);
  process.stderr.write(
    "Usage: node residue-scanner.mjs " +
    "--tree <retained-workspace-root> " +
    "--record <observation-record.json> " +
    "[--run-summary <run-summary.json>] " +
    "[--output <result.json>]\n"
  );
  process.exit(2);
}

function parseArgs(argv) {
  const out = { tree: null, record: null, runSummary: null, output: null };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--tree": out.tree = argv[++i]; break;
      case "--record": out.record = argv[++i]; break;
      case "--run-summary": out.runSummary = argv[++i]; break;
      case "--output": out.output = argv[++i]; break;
    }
  }
  if (!out.tree) usage("--tree is required");
  if (!out.record && !out.runSummary) usage("--record or --run-summary is required");
  return out;
}

function sha256File(filePath) {
  const h = createHash("sha256");
  h.update(fs.readFileSync(filePath));
  return h.digest("hex");
}

function normalizePath(p) {
  return path.normalize(p).replace(/\\/g, "/");
}

function enumerateTree(root) {
  const results = [];
  const seen = new Set();

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      throw new Error(`Cannot read directory ${dir}: ${e.message}`);
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = normalizePath(path.relative(root, fullPath));

      if (relPath.startsWith("..")) {
        results.push({
          path: relPath,
          type: "traversal",
          error: "Path resolves outside the tree root"
        });
        continue;
      }

      if (seen.has(relPath)) {
        results.push({
          path: relPath,
          type: "duplicate",
          error: "Duplicate normalized path"
        });
        continue;
      }
      seen.add(relPath);

      if (entry.isSymbolicLink()) {
        results.push({
          path: relPath,
          type: "symlink",
          target: fs.readlinkSync(fullPath),
          error: "Symlinks are rejected"
        });
      } else if (entry.isFile()) {
        results.push({
          path: relPath,
          type: "file",
          sha256: sha256File(fullPath),
          bytes: fs.statSync(fullPath).size
        });
      } else if (entry.isDirectory()) {
        walk(fullPath);
      } else {
        results.push({
          path: relPath,
          type: "non_regular",
          error: "Non-regular entry rejected"
        });
      }
    }
  }

  walk(root);
  return results;
}

function deriveAllowedPaths(treeRoot, recordPath, runSummaryPath) {
  const allowed = new Set();

  if (runSummaryPath && fs.existsSync(runSummaryPath)) {
    const summary = JSON.parse(fs.readFileSync(runSummaryPath, "utf8"));
    if (summary.artifact_hashes && typeof summary.artifact_hashes === "object") {
      for (const relPath of Object.keys(summary.artifact_hashes)) {
        const norm = normalizePath(relPath);
        allowed.add(norm);
        allowed.add(norm + ".frozen");
      }
    }

    const summaryRelFromTree = normalizePath(path.relative(treeRoot, runSummaryPath));
    allowed.add(summaryRelFromTree);
    allowed.add(summaryRelFromTree + ".frozen");

    const summaryDir = path.dirname(runSummaryPath);
    const stimIdPath = path.join(summaryDir, "stimulus-identity.json");
    if (fs.existsSync(stimIdPath)) {
      const stimRel = normalizePath(path.relative(treeRoot, stimIdPath));
      allowed.add(stimRel);
      allowed.add(stimRel + ".frozen");
    }

    const capturePath = path.join(summaryDir, "capture.json");
    if (fs.existsSync(capturePath)) {
      const captureRel = normalizePath(path.relative(treeRoot, capturePath));
      allowed.add(captureRel);
      allowed.add(captureRel + ".frozen");
    }
  }

  if (recordPath && fs.existsSync(recordPath)) {
    const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));

    function addRefs(refs) {
      if (!Array.isArray(refs)) return;
      for (const ref of refs) {
        if (typeof ref === "object" && ref.logical_path) {
          const norm = normalizePath(ref.logical_path);
          allowed.add(norm);
          allowed.add(norm + ".frozen");
        }
      }
    }

    if (record.retained_output_refs) addRefs(record.retained_output_refs);
    if (record.result) {
      if (record.result.retained_output_refs) addRefs(record.result.retained_output_refs);
      if (record.result.retained_input_refs) addRefs(record.result.retained_input_refs);
      if (record.result.retained_evidence_refs) addRefs(record.result.retained_evidence_refs);
    }
  }

  return allowed;
}

function scan(treeRoot, recordPath, runSummaryPath) {
  const treeEntries = enumerateTree(treeRoot);

  let effectiveRunSummary = runSummaryPath;
  if (!effectiveRunSummary) {
    const candidates = [
      "qualiber/run-summary.json",
      "store/local-observation-output/interact-validate-stimulus/qualiber/run-summary.json",
    ];
    for (const c of candidates) {
      const full = path.join(treeRoot, c);
      if (fs.existsSync(full)) {
        effectiveRunSummary = full;
        break;
      }
    }
  }

  const allowedPaths = deriveAllowedPaths(treeRoot, recordPath, effectiveRunSummary);

  const actualFiles = new Map();
  const rejections = [];

  for (const entry of treeEntries) {
    if (entry.type === "symlink") {
      rejections.push({
        path: entry.path,
        reason: "symlink_rejected",
        detail: `Symlink target: ${entry.target}`
      });
    } else if (entry.type === "traversal") {
      rejections.push({
        path: entry.path,
        reason: "traversal_rejected",
        detail: entry.error
      });
    } else if (entry.type === "duplicate") {
      rejections.push({
        path: entry.path,
        reason: "duplicate_path_rejected",
        detail: entry.error
      });
    } else if (entry.type === "non_regular") {
      rejections.push({
        path: entry.path,
        reason: "non_regular_rejected",
        detail: entry.error
      });
    } else if (entry.type === "file") {
      actualFiles.set(entry.path, { sha256: entry.sha256, bytes: entry.bytes });
    }
  }

  const unexpected = [];
  for (const [p, info] of actualFiles) {
    if (!allowedPaths.has(p)) {
      unexpected.push({ path: p, sha256: info.sha256, bytes: info.bytes });
    }
  }

  const missing = [];
  for (const p of allowedPaths) {
    if (!actualFiles.has(p) && !p.endsWith(".frozen")) {
      const frozenPresent = actualFiles.has(p + ".frozen");
      if (!frozenPresent) {
        missing.push({ path: p });
      }
    }
  }

  const clean = unexpected.length === 0 &&
                missing.length === 0 &&
                rejections.length === 0;

  return {
    schema: "qualiber-reality-lab/residue-scan/v1",
    tree_root: treeRoot,
    record_path: recordPath || null,
    run_summary_path: effectiveRunSummary || null,
    allowed_path_count: allowedPaths.size,
    actual_file_count: actualFiles.size,
    clean,
    unexpected_files: unexpected,
    missing_files: missing,
    rejections,
    publishable: clean
  };
}

const args = parseArgs(process.argv.slice(2));
let result;
try {
  result = scan(args.tree, args.record, args.runSummary);
} catch (e) {
  process.stderr.write(`residue-scanner: INTERNAL ERROR: ${e.message}\n`);
  process.exit(3);
}

const json = JSON.stringify(result, null, 2);
if (args.output) {
  fs.writeFileSync(args.output, json + "\n");
}
process.stdout.write(json + "\n");
process.exit(result.clean ? 0 : 1);
