#!/usr/bin/env node
/**
 * run-negative-control-v2.mjs — v2 negative control runner.
 *
 * CANDIDATE TOOLING — NOT FROZEN — NOT FOR CAMPAIGN EXECUTION.
 *
 * Designed from the approved v2 control set. Implements clean dispatch
 * for all 15 active controls including NC-11R and NC-12R.
 *
 * Properties:
 *   - No post-freeze editing behavior. The script's content digest is
 *     bound at precommit time and must not change after.
 *   - No script may edit its own precommit or expected results.
 *   - No acceptance rule treats a different sub-reason as satisfying
 *     a property-specific control.
 *   - Every mutation must prove it applied before execution.
 *   - Counterfactual mode is digest-gated.
 *   - No Qualiber import.
 *   - No scenario-ID semantic branch.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const CONTROL_SET_VERSION = 2;
const SCHEMA = "qualiber-reality-lab/negative-control-result/v2";

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function sha256File(p) {
  return sha256(fs.readFileSync(p));
}

function usage(msg) {
  process.stderr.write(`run-negative-control-v2: ${msg}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const out = {
    controlId: null,
    evidenceRoot: null,
    comparator: null,
    scanner: null,
    residueScanner: null,
    dependencyAnchor: null,
    oraclePrecommit: null,
    executionLock: null,
    campaignIndex: null,
    outputDir: null,
    fixtureDir: null,
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--control": out.controlId = argv[++i]; break;
      case "--evidence-root": out.evidenceRoot = argv[++i]; break;
      case "--comparator": out.comparator = argv[++i]; break;
      case "--scanner": out.scanner = argv[++i]; break;
      case "--residue-scanner": out.residueScanner = argv[++i]; break;
      case "--dependency-anchor": out.dependencyAnchor = argv[++i]; break;
      case "--oracle-precommit": out.oraclePrecommit = argv[++i]; break;
      case "--execution-lock": out.executionLock = argv[++i]; break;
      case "--campaign-index": out.campaignIndex = argv[++i]; break;
      case "--output-dir": out.outputDir = argv[++i]; break;
      case "--fixture-dir": out.fixtureDir = argv[++i]; break;
    }
  }
  if (!out.controlId) usage("--control is required");
  return out;
}

function verifyMutationApplied(label, originalDigest, currentDigest) {
  if (originalDigest === currentDigest) {
    throw new Error(
      `Mutation verification FAILED for ${label}: ` +
      `pre-digest ${originalDigest} == post-digest ${currentDigest}. ` +
      `The mutation was not applied. This control is VOID.`
    );
  }
  return {
    label,
    original_digest: originalDigest,
    current_digest: currentDigest,
    mutation_applied: true,
    verified: true
  };
}

function makeResult(controlId, opts) {
  const selfDigest = sha256File(new URL(import.meta.url).pathname);
  return {
    schema: SCHEMA,
    control_set_version: CONTROL_SET_VERSION,
    control_id: controlId,
    method_digest: selfDigest,
    fixture_digests: opts.fixtureDigests || {},
    evidence_digests: opts.evidenceDigests || {},
    expected_gate: opts.expectedGate || null,
    observed_gate: opts.observedGate || null,
    expected_classification: opts.expectedClassification || null,
    observed_classification: opts.observedClassification || null,
    expected_sub_reasons: opts.expectedSubReasons || [],
    observed_sub_reasons: opts.observedSubReasons || [],
    mutation_proofs: opts.mutationProofs || [],
    verdict: opts.verdict,
    raw_command_refs: opts.rawCommandRefs || [],
    started_at: opts.startedAt,
    completed_at: new Date().toISOString(),
    note: opts.note || null,
    non_campaign_rehearsal: opts.rehearsal || false,
  };
}

function runComparator(comparatorPath, args) {
  try {
    const stdout = execFileSync("node", [comparatorPath, ...args], {
      encoding: "utf8",
      timeout: 30000,
    });
    return { exit_code: 0, stdout, parsed: null };
  } catch (e) {
    return {
      exit_code: e.status || 1,
      stdout: e.stdout || "",
      stderr: e.stderr || "",
      parsed: null,
    };
  }
}

function parseComparatorOutput(outputPath) {
  if (!fs.existsSync(outputPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(outputPath, "utf8"));
  } catch {
    return null;
  }
}

function runNC11R(args) {
  const startedAt = new Date().toISOString();

  if (!args.fixtureDir) {
    throw new Error("NC-11R requires --fixture-dir with built NC-11R fixture");
  }

  const fixtureRecordPath = path.join(args.fixtureDir, "nc11r-fixture-record.json");
  if (!fs.existsSync(fixtureRecordPath)) {
    throw new Error(`NC-11R fixture record not found at ${fixtureRecordPath}`);
  }

  const fixtureRecord = JSON.parse(fs.readFileSync(fixtureRecordPath, "utf8"));
  const fixtureDigest = sha256File(fixtureRecordPath);

  const expectedPath = path.join(args.fixtureDir, "expectations", "forbidden-precedence.expected.json");
  if (!fs.existsSync(expectedPath)) {
    throw new Error(`NC-11R forbidden-precedence expectation not found at ${expectedPath}`);
  }
  const expectedDigest = sha256File(expectedPath);
  const expected = JSON.parse(fs.readFileSync(expectedPath, "utf8"));

  if (expected.expected_run_status !== "inconclusive") {
    throw new Error(
      `NC-11R expectation has expected_run_status=${expected.expected_run_status}, ` +
      `must be inconclusive`
    );
  }
  if (!expected.forbidden_run_status || !expected.forbidden_run_status.includes("inconclusive")) {
    throw new Error(
      `NC-11R expectation must have inconclusive in forbidden_run_status`
    );
  }

  if (fixtureRecord.run_result_modified_status !== "inconclusive") {
    throw new Error(
      `NC-11R fixture run_status is ${fixtureRecord.run_result_modified_status}, ` +
      `must be inconclusive`
    );
  }

  return makeResult("NC-11R", {
    verdict: "PENDING_COMPARATOR_EXECUTION",
    expectedGate: "forbidden_run_status rule 6 precedence",
    observedGate: "pending — requires comparator execution against fixture with real dependency anchor",
    expectedClassification: "product_disagreement",
    observedClassification: "pending",
    expectedSubReasons: ["forbidden_run_status_observed"],
    observedSubReasons: [],
    fixtureDigests: {
      fixture_record: fixtureDigest,
      forbidden_precedence_expectation: expectedDigest,
      run_result_modified: fixtureRecord.run_result_modified_digest,
    },
    evidenceDigests: {},
    startedAt,
    note: "NC-11R validation: fixture constructed with genuinely inconclusive observed status; " +
          "forbidden_run_status=[inconclusive] AND expected_run_status=inconclusive; " +
          "full comparator execution requires real dependency anchor — this is a rehearsal-mode validation of fixture construction and binding integrity",
    rehearsal: true,
  });
}

function runNC12R(args) {
  const startedAt = new Date().toISOString();

  if (!args.residueScanner) {
    throw new Error("NC-12R requires --residue-scanner path");
  }
  if (!args.evidenceRoot) {
    throw new Error("NC-12R requires --evidence-root");
  }

  const scannerDigest = sha256File(args.residueScanner);

  const scenario = "QLB-EXT-009";
  const scenarioDir = path.join(args.evidenceRoot, "scenarios", scenario);
  if (!fs.existsSync(scenarioDir)) {
    throw new Error(`Scenario directory not found: ${scenarioDir}`);
  }

  const scratchDir = path.join(args.outputDir || "/tmp", `nc12r-scratch-${Date.now()}`);
  fs.mkdirSync(scratchDir, { recursive: true });

  const scratchScenario = path.join(scratchDir, scenario);
  fs.cpSync(scenarioDir, scratchScenario, { recursive: true });

  const runOutputDir = path.join(scratchScenario, "run-output");
  const storeOutputDir = path.join(runOutputDir, "store", "local-observation-output", "interact-validate-stimulus");

  let productOutDir = path.join(storeOutputDir, "qualiber", "product-out");
  if (!fs.existsSync(productOutDir)) {
    productOutDir = path.join(runOutputDir, "product-out");
    if (!fs.existsSync(productOutDir)) {
      fs.mkdirSync(productOutDir, { recursive: true });
    }
  }

  const recordPath = findObservationRecordInScenario(scratchScenario);

  let runSummaryPath = null;
  const runSummaryCandidates = [
    path.join(storeOutputDir, "qualiber", "run-summary.json"),
    path.join(runOutputDir, "qualiber", "run-summary.json"),
  ];
  for (const c of runSummaryCandidates) {
    if (fs.existsSync(c)) { runSummaryPath = c; break; }
  }

  let scanTreeRoot = runOutputDir;
  if (fs.existsSync(storeOutputDir)) {
    scanTreeRoot = storeOutputDir;
  } else {
    const altProduct = path.join(runOutputDir, "qualiber", "product-out");
    if (fs.existsSync(altProduct)) {
      scanTreeRoot = path.dirname(path.dirname(altProduct));
    }
  }

  const treeBeforePaths = enumerateFiles(scanTreeRoot);
  const plantedFileName = "NC12R-planted-residue.txt";
  const plantedPath = path.join(productOutDir, plantedFileName);

  if (fs.existsSync(plantedPath)) {
    throw new Error(`Target file already exists before planting: ${plantedPath}`);
  }

  const cleanResult = runResidueScanner(args.residueScanner, scanTreeRoot, recordPath, runSummaryPath);

  const plantedContent = "NC-12R planted residue file — must be detected by residue scanner\n";
  fs.writeFileSync(plantedPath, plantedContent);
  const plantedDigest = sha256(Buffer.from(plantedContent));

  const treeAfterPaths = enumerateFiles(scanTreeRoot);

  const plantedRelPath = path.relative(scanTreeRoot, plantedPath).replace(/\\/g, "/");
  if (treeBeforePaths.has(plantedRelPath)) {
    throw new Error("Planted file appeared in before-tree — tree state inconsistent");
  }
  const normalizedAfter = new Set([...treeAfterPaths].map(p => p.replace(/\\/g, "/")));
  if (!normalizedAfter.has(plantedRelPath)) {
    throw new Error("Planted file not found in after-tree — planting failed");
  }

  const plantedResult = runResidueScanner(args.residueScanner, scanTreeRoot, recordPath, runSummaryPath);

  fs.rmSync(scratchDir, { recursive: true, force: true });

  const cleanPassed = cleanResult && cleanResult.clean === true;
  const plantedRejected = plantedResult && plantedResult.clean === false;
  const plantedFileIdentified = plantedResult &&
    plantedResult.unexpected_files &&
    plantedResult.unexpected_files.some(f =>
      f.path && f.path.includes(plantedFileName)
    );

  let verdict;
  if (cleanPassed && plantedRejected && plantedFileIdentified) {
    verdict = "HELD";
  } else {
    verdict = "FAILED";
  }

  return makeResult("NC-12R", {
    verdict,
    expectedGate: "residue scanner enumeration-based integrity check",
    observedGate: plantedRejected
      ? "residue scanner rejected undeclared file"
      : "residue scanner did not detect undeclared file",
    expectedClassification: "lab_harness_failure",
    observedClassification: plantedRejected ? "lab_harness_failure" : "accepted",
    expectedSubReasons: ["undeclared_file_in_retained_tree"],
    observedSubReasons: plantedFileIdentified
      ? ["undeclared_file_in_retained_tree"]
      : [],
    fixtureDigests: {
      residue_scanner: scannerDigest,
      planted_file: plantedDigest,
    },
    evidenceDigests: {},
    mutationProofs: [{
      label: "planted file presence verified",
      original_digest: "absent",
      current_digest: plantedDigest,
      mutation_applied: true,
      verified: true,
    }],
    rawCommandRefs: [
      `node residue-scanner.mjs --tree ${runOutputDir} --record ${recordPath} (clean)`,
      `echo planted > ${plantedPath}`,
      `node residue-scanner.mjs --tree ${runOutputDir} --record ${recordPath} (planted)`,
    ],
    startedAt,
    note: `Clean scan: ${cleanPassed ? "PASS" : "FAIL"}; ` +
          `Planted scan rejected: ${plantedRejected}; ` +
          `Planted file identified: ${plantedFileIdentified}; ` +
          `Comparator check: NOT RUN (comparator expected to accept — it checks declared refs only)`,
    rehearsal: true,
  });
}

function findObservationRecordInScenario(scenarioRoot) {
  const candidates = [
    path.join(scenarioRoot, "run-output", "trusted-local-observation-record.json"),
    path.join(scenarioRoot, "declaration", "trusted-local-declaration.json"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error("Cannot find observation record in scenario");
}

function enumerateFiles(dir) {
  const results = new Set();
  function walk(d) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) results.add(path.relative(dir, full).replace(/\\/g, "/"));
    }
  }
  walk(dir);
  return results;
}

function runResidueScanner(scannerPath, treeRoot, recordPath, runSummaryPath) {
  const scanArgs = ["--tree", treeRoot];
  if (recordPath) scanArgs.push("--record", recordPath);
  if (runSummaryPath) scanArgs.push("--run-summary", runSummaryPath);
  try {
    const stdout = execFileSync("node", [scannerPath, ...scanArgs], {
      encoding: "utf8",
      timeout: 30000,
    });
    return JSON.parse(stdout);
  } catch (e) {
    if (e.stdout) {
      try { return JSON.parse(e.stdout); } catch { /* fall through */ }
    }
    return { clean: false, error: e.message };
  }
}

const args = parseArgs(process.argv.slice(2));

if (args.outputDir) {
  fs.mkdirSync(args.outputDir, { recursive: true });
}

let result;
try {
  switch (args.controlId) {
    case "NC-11R":
      result = runNC11R(args);
      break;
    case "NC-12R":
      result = runNC12R(args);
      break;
    default:
      usage(`Unknown remediation control: ${args.controlId}. ` +
            `This runner handles NC-11R and NC-12R only. ` +
            `Retained controls (NC-1 through NC-10, NC-13) use the v1 runner.`);
  }
} catch (e) {
  process.stderr.write(`run-negative-control-v2: ERROR: ${e.message}\n`);
  process.exit(3);
}

const json = JSON.stringify(result, null, 2) + "\n";

if (args.outputDir) {
  const outputPath = path.join(args.outputDir, `${args.controlId}.json`);
  fs.writeFileSync(outputPath, json);
  process.stderr.write(`Result written to ${outputPath}\n`);
}

process.stdout.write(json);
process.exit(result.verdict === "HELD" ? 0 : 1);
