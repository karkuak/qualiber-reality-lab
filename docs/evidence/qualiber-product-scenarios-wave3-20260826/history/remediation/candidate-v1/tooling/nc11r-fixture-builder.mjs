#!/usr/bin/env node
/**
 * nc11r-fixture-builder.mjs — constructs a completely bound control fixture
 * for NC-11R where the observed run_status is genuinely inconclusive.
 *
 * Takes a disposable copy of a completed scenario and modifies run-result.json
 * to have runStatus=inconclusive, then updates all binding layers to be
 * internally consistent.
 *
 * This is a fixture construction tool, NOT a campaign execution tool.
 * Its output is a test fixture, clearly labelled non-campaign.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function sha256File(p) {
  return sha256(fs.readFileSync(p));
}

function usage(msg) {
  process.stderr.write(`nc11r-fixture-builder: ${msg}\n`);
  process.stderr.write(
    "Usage: node nc11r-fixture-builder.mjs " +
    "--scenario-root <path-to-disposable-copy> " +
    "--output-dir <fixture-output-dir>\n"
  );
  process.exit(2);
}

function parseArgs(argv) {
  const out = { scenarioRoot: null, outputDir: null };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--scenario-root": out.scenarioRoot = argv[++i]; break;
      case "--output-dir": out.outputDir = argv[++i]; break;
    }
  }
  if (!out.scenarioRoot) usage("--scenario-root is required");
  if (!out.outputDir) usage("--output-dir is required");
  return out;
}

function findRunResult(scenarioRoot) {
  const candidates = [
    path.join(scenarioRoot, "run-output", "product-out", "run-result.json"),
    path.join(scenarioRoot, "qualiber", "product-out", "run-result.json"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error(
    `Cannot find run-result.json in scenario root. Checked: ${candidates.join(", ")}`
  );
}

function findRunSummary(scenarioRoot) {
  const candidates = [
    path.join(scenarioRoot, "run-output", "qualiber", "run-summary.json"),
    path.join(scenarioRoot, "qualiber", "run-summary.json"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function findObservationRecord(scenarioRoot) {
  const candidates = [
    path.join(scenarioRoot, "run-output", "trusted-local-observation-record.json"),
    path.join(scenarioRoot, "declaration", "trusted-local-declaration.json"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function buildFixture(scenarioRoot, outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });

  const log = [];
  const record = { modifications: [], binding_proofs: [] };

  const runResultPath = findRunResult(scenarioRoot);
  const runResultRelative = path.relative(scenarioRoot, runResultPath);

  const originalBytes = fs.readFileSync(runResultPath);
  const originalDigest = sha256(originalBytes);
  const originalRunResult = JSON.parse(originalBytes.toString("utf8"));

  log.push(`Original run-result.json at: ${runResultRelative}`);
  log.push(`Original digest: ${originalDigest}`);
  log.push(`Original runStatus: ${originalRunResult.runStatus}`);

  const modifiedRunResult = { ...originalRunResult };
  modifiedRunResult.runStatus = "inconclusive";
  modifiedRunResult.inconclusiveReason = "nc11r_fixture_synthetic_inconclusive";

  const modifiedBytes = Buffer.from(JSON.stringify(modifiedRunResult, null, 2) + "\n");
  const modifiedDigest = sha256(modifiedBytes);

  if (originalDigest === modifiedDigest) {
    throw new Error("Modified run-result.json has same digest as original — modification not applied");
  }

  record.modifications.push({
    file: runResultRelative,
    field: "runStatus",
    original_value: originalRunResult.runStatus,
    modified_value: "inconclusive",
    original_digest: originalDigest,
    modified_digest: modifiedDigest,
    content_changed: true,
    digest_changed: originalDigest !== modifiedDigest
  });

  fs.writeFileSync(runResultPath, modifiedBytes);
  log.push(`Modified runStatus to inconclusive, new digest: ${modifiedDigest}`);

  const frozenPath = runResultPath + ".frozen";
  if (fs.existsSync(frozenPath)) {
    const frozenOriginal = JSON.parse(fs.readFileSync(frozenPath, "utf8"));
    const frozenOriginalDigest = sha256(fs.readFileSync(frozenPath));

    frozenOriginal.file_sha256 = modifiedDigest;
    frozenOriginal.byte_length = modifiedBytes.length;
    const frozenModifiedBytes = Buffer.from(JSON.stringify(frozenOriginal, null, 2) + "\n");
    const frozenModifiedDigest = sha256(frozenModifiedBytes);

    fs.writeFileSync(frozenPath, frozenModifiedBytes);

    record.binding_proofs.push({
      layer: "frozen_sidecar",
      file: runResultRelative + ".frozen",
      original_digest: frozenOriginalDigest,
      modified_digest: frozenModifiedDigest,
      updated_field: "file_sha256",
      updated_to: modifiedDigest
    });
    log.push(`Updated .frozen sidecar: file_sha256 → ${modifiedDigest}`);
  }

  const runSummaryPath = findRunSummary(scenarioRoot);
  if (runSummaryPath) {
    const summaryBytes = fs.readFileSync(runSummaryPath);
    const summaryOriginalDigest = sha256(summaryBytes);
    const summary = JSON.parse(summaryBytes.toString("utf8"));

    if (summary.artifact_hashes) {
      let updated = false;
      for (const [key, val] of Object.entries(summary.artifact_hashes)) {
        if (key.includes("run-result") || val === originalDigest) {
          summary.artifact_hashes[key] = modifiedDigest;
          updated = true;
        }
      }
      if (updated) {
        const summaryModifiedBytes = Buffer.from(JSON.stringify(summary, null, 2) + "\n");
        const summaryModifiedDigest = sha256(summaryModifiedBytes);
        fs.writeFileSync(runSummaryPath, summaryModifiedBytes);

        record.binding_proofs.push({
          layer: "run_summary_artifact_hashes",
          file: path.relative(scenarioRoot, runSummaryPath),
          original_digest: summaryOriginalDigest,
          modified_digest: summaryModifiedDigest,
          updated_field: "artifact_hashes entry for run-result.json",
          updated_to: modifiedDigest
        });
        log.push(`Updated run-summary.json artifact_hashes`);
      }
    }
  }

  const observationPath = findObservationRecord(scenarioRoot);
  if (observationPath) {
    const obsBytes = fs.readFileSync(observationPath);
    const obsOriginalDigest = sha256(obsBytes);
    const obs = JSON.parse(obsBytes.toString("utf8"));

    let updated = false;
    function updateRefs(refs) {
      if (!Array.isArray(refs)) return;
      for (const ref of refs) {
        if (ref.file_sha256 === originalDigest ||
            (ref.logical_path && ref.logical_path.includes("run-result"))) {
          ref.file_sha256 = modifiedDigest;
          ref.byte_length = modifiedBytes.length;
          updated = true;
        }
      }
    }

    if (obs.retained_output_refs) updateRefs(obs.retained_output_refs);
    if (obs.result && obs.result.retained_output_refs) {
      updateRefs(obs.result.retained_output_refs);
    }

    if (updated) {
      const obsModifiedBytes = Buffer.from(JSON.stringify(obs, null, 2) + "\n");
      const obsModifiedDigest = sha256(obsModifiedBytes);
      fs.writeFileSync(observationPath, obsModifiedBytes);

      record.binding_proofs.push({
        layer: "observation_record_retained_output_refs",
        file: path.relative(scenarioRoot, observationPath),
        original_digest: obsOriginalDigest,
        modified_digest: obsModifiedDigest,
        updated_field: "retained_output_refs entry for run-result.json",
        updated_to: modifiedDigest
      });
      log.push(`Updated observation record retained_output_refs`);
    }
  }

  const expectationPositive = {
    schema_version: "qualiber-reality-lab/campaign-expectation/v1",
    scenario_id: "NC-11R-POSITIVE-BOUND-CONTROL",
    fixture_note: "Positive bound control for NC-11R: expected matches observed, no forbidden check",
    expected_operation_state: "completed",
    expected_response_status: "supported",
    expected_run_status: "inconclusive",
    required_finding_types: [],
    permitted_additional_types: [],
    target_event: null,
    max_finding_count: 0,
    expected_product_reported: true,
  };

  const expectationForbidden = {
    schema_version: "qualiber-reality-lab/campaign-expectation/v1",
    scenario_id: "NC-11R-FORBIDDEN-PRECEDENCE",
    fixture_note: "NC-11R forbidden-status precedence test: expected_run_status=inconclusive AND forbidden_run_status=[inconclusive]; forbidden check must fire and force disagree even though expected==observed",
    expected_operation_state: "completed",
    expected_response_status: "supported",
    expected_run_status: "inconclusive",
    required_finding_types: [],
    permitted_additional_types: [],
    target_event: null,
    max_finding_count: 0,
    expected_product_reported: true,
    forbidden_run_status: ["inconclusive"],
  };

  const expectationNoForbidden = {
    schema_version: "qualiber-reality-lab/campaign-expectation/v1",
    scenario_id: "NC-11R-MUTATION-NO-FORBIDDEN",
    fixture_note: "NC-11R mutation test: forbidden_run_status removed; expected==observed should now agree, proving forbidden check was load-bearing",
    expected_operation_state: "completed",
    expected_response_status: "supported",
    expected_run_status: "inconclusive",
    required_finding_types: [],
    permitted_additional_types: [],
    target_event: null,
    max_finding_count: 0,
    expected_product_reported: true,
  };

  const fixtureDir = path.join(outputDir, "expectations");
  fs.mkdirSync(fixtureDir, { recursive: true });

  const files = {
    "positive-bound.expected.json": expectationPositive,
    "forbidden-precedence.expected.json": expectationForbidden,
    "mutation-no-forbidden.expected.json": expectationNoForbidden,
  };

  const expectationDigests = {};
  for (const [name, content] of Object.entries(files)) {
    const filePath = path.join(fixtureDir, name);
    const bytes = Buffer.from(JSON.stringify(content, null, 2) + "\n");
    fs.writeFileSync(filePath, bytes);
    expectationDigests[name] = sha256(bytes);
    log.push(`Wrote ${name}: ${expectationDigests[name]}`);
  }

  const fixtureRecord = {
    schema: "qualiber-reality-lab/nc11r-fixture/v1",
    fixture_type: "NON-CAMPAIGN REHEARSAL — NOT AN OFFICIAL CONTROL RESULT",
    base_scenario: "QLB-EXT-012 (disposable copy)",
    modifications: record.modifications,
    binding_proofs: record.binding_proofs,
    expectation_digests: expectationDigests,
    run_result_original_digest: originalDigest,
    run_result_modified_digest: modifiedDigest,
    run_result_modified_status: "inconclusive",
    construction_log: log
  };

  const recordPath = path.join(outputDir, "nc11r-fixture-record.json");
  fs.writeFileSync(recordPath, JSON.stringify(fixtureRecord, null, 2) + "\n");

  return fixtureRecord;
}

const args = parseArgs(process.argv.slice(2));
try {
  const result = buildFixture(args.scenarioRoot, args.outputDir);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.exit(0);
} catch (e) {
  process.stderr.write(`nc11r-fixture-builder: ERROR: ${e.message}\n`);
  process.exit(3);
}
