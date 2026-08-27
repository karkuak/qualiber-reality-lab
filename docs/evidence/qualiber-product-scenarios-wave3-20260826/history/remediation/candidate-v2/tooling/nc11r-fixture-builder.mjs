#!/usr/bin/env node
/**
 * nc11r-fixture-builder.mjs (v2 — IRD-001 corrected)
 * ==================================================
 * Constructs a COMPLETELY BOUND NC-11R control fixture in which the observed
 * run_status is genuinely `inconclusive`, so that forbidden-status precedence
 * (comparator §10.5 rule 6) can be exercised against a fixture that the
 * comparator fully binds.
 *
 * IRD-001 background
 * ------------------
 * The v1 independent review flagged that `result.retained_output_refs` on the
 * top-level observation record is `[]` for QLB-EXT-012 and concluded the
 * builder might silently skip the retained-output binding update.
 *
 * That conclusion inspected the WRONG record layer. The comparator
 * (compare-scenario.mjs, digest 83223022…) never reads
 * `record.result.retained_output_refs`. Its primary artifact binding is:
 *
 *     const opRecord = findInteractCompletedRecord(record)      // §binding
 *     for (const r of opRecord.retained_output_refs ?? []) refs.set(r.path, r)
 *     bindArtifact(runResultPath)  // logical path relative to run-output/store
 *
 * i.e. `record.operation_records[] where operation==="interact" &&
 * state==="completed"`. For QLB-EXT-012 that record carries 11 populated refs,
 * run-result.json among them. The empty top-level `result.retained_output_refs`
 * is never consulted.
 *
 * The v1 builder was nonetheless genuinely defective — but on a different, more
 * serious axis than the review named:
 *   1. `findRunResult` did not know the nested store path, so it could not even
 *      locate run-result.json in a real QLB-EXT-012 tree (hard exit 3).
 *   2. `updateRefs` iterated only `obs.retained_output_refs` (absent) and
 *      `obs.result.retained_output_refs` (empty) — never
 *      `obs.operation_records[].retained_output_refs`, the real binding source.
 *   3. Its match predicate compared a bare hex digest against the record's
 *      `sha256:`-prefixed `file_sha256`, and keyed on `logical_path` where the
 *      refs use `path`. Both would have failed to match even if reached.
 *   4. It never re-bound run-summary.json after editing its artifact_hashes,
 *      so that cascade would have left run-summary's own ref mismatched.
 *
 * Consequence: a run-result mutated by the v1 builder would fail
 * `bindArtifact` → `record_retained_output_refs_mismatched.length > 0` →
 * `bound=false` → the comparator returns `unavailable` at the rule-7 binding
 * gate and NEVER reaches rule 6. NC-11R could not have demonstrated its
 * property. See IRD-001-DISPOSITION.md.
 *
 * This v2 builder binds every authoritative layer the comparator reads, proves
 * each update happened exactly once (fail-closed on zero or multiple matches),
 * reports every intended binding, and emits a self-consistent fixture oracle so
 * the fixture can be run end-to-end through the real comparator.
 *
 * This is a FIXTURE construction tool, NOT a campaign execution tool. Its output
 * is clearly labelled NON-CAMPAIGN.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const PREFIX = "sha256:";
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const sha256File = (p) => sha256(fs.readFileSync(p));
const prefixed = (hex) => PREFIX + hex;
const bare = (v) => (typeof v === "string" && v.startsWith(PREFIX) ? v.slice(PREFIX.length) : v);

function fail(msg) {
  process.stderr.write(`nc11r-fixture-builder: FATAL: ${msg}\n`);
  process.exit(3);
}

function usage(msg) {
  process.stderr.write(`nc11r-fixture-builder: ${msg}\n`);
  process.stderr.write(
    "Usage: node nc11r-fixture-builder.mjs " +
    "--scenario-root <disposable-copy-of-scenario> " +
    "--output-dir <fixture-output-dir> " +
    "--execution-lock <path-to-real-execution-lock.json> " +
    "[--scenario-id-base NC-11R]\n"
  );
  process.exit(2);
}

function parseArgs(argv) {
  const out = { scenarioRoot: null, outputDir: null, executionLock: null, base: "NC-11R" };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--scenario-root": out.scenarioRoot = argv[++i]; break;
      case "--output-dir": out.outputDir = argv[++i]; break;
      case "--execution-lock": out.executionLock = argv[++i]; break;
      case "--scenario-id-base": out.base = argv[++i]; break;
      default: usage(`unknown flag ${argv[i]}`);
    }
  }
  if (!out.scenarioRoot) usage("--scenario-root is required");
  if (!out.outputDir) usage("--output-dir is required");
  if (!out.executionLock) usage("--execution-lock is required");
  return out;
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function findInteractCompletedRecord(record) {
  return (record.operation_records ?? []).find(
    (r) => r.operation === "interact" && r.state === "completed",
  ) ?? null;
}

/**
 * Update exactly the refs in `refs` matching `predicate`, setting file_sha256
 * (prefixed) and byte_length. Returns the count of refs updated. The caller
 * asserts the count is exactly the number of layers it intended to touch — a
 * zero or multiple match is a hard failure, never a silent no-op.
 */
function updateRefsExact(refs, predicate, newDigest, newLen) {
  let matched = 0;
  for (const ref of refs) {
    if (predicate(ref)) {
      ref.file_sha256 = prefixed(newDigest);
      ref.byte_length = newLen;
      matched += 1;
    }
  }
  return matched;
}

function buildFixture(args) {
  const { scenarioRoot, outputDir, executionLock, base } = args;
  fs.mkdirSync(outputDir, { recursive: true });

  const log = [];
  const bindingProofs = [];
  const coverage = { layers: [] };
  const note = (m) => { log.push(m); };

  // ---- locate authoritative files from the record, not from guessed paths ----
  const recordPath = path.join(scenarioRoot, "run-output", "trusted-local-observation-record.json");
  const planPath = path.join(scenarioRoot, "plan", "plan-sealed.json");
  if (!fs.existsSync(recordPath)) fail(`observation record not found: ${recordPath}`);
  if (!fs.existsSync(planPath)) fail(`sealed plan not found: ${planPath}`);
  if (!fs.existsSync(executionLock)) fail(`execution lock not found: ${executionLock}`);

  const record = readJson(recordPath);
  const plan = readJson(planPath);
  const storeRoot = path.join(scenarioRoot, "run-output", "store");

  const op = findInteractCompletedRecord(record);
  if (!op) fail("no interact/completed operation record — cannot bind");
  if (!Array.isArray(op.retained_output_refs) || op.retained_output_refs.length === 0) {
    fail("interact/completed operation record has no retained_output_refs — scenario cannot support complete binding");
  }
  note(`interact/completed operation record selected: operation_id=${op.operation_id}, refs=${op.retained_output_refs.length}`);

  const abs = (ref) => path.join(storeRoot, ref.path.split("/").join(path.sep));
  const runResultRef = op.retained_output_refs.filter((r) => r.path.endsWith("product-out/run-result.json"));
  const runSummaryRef = op.retained_output_refs.filter((r) => r.path.endsWith("qualiber/run-summary.json"));
  if (runResultRef.length !== 1) fail(`expected exactly one run-result.json ref, found ${runResultRef.length}`);
  if (runSummaryRef.length !== 1) fail(`expected exactly one run-summary.json ref, found ${runSummaryRef.length}`);

  const runResultPath = abs(runResultRef[0]);
  const runSummaryPath = abs(runSummaryRef[0]);
  if (!fs.existsSync(runResultPath)) fail(`run-result.json referenced but absent on disk: ${runResultPath}`);
  if (!fs.existsSync(runSummaryPath)) fail(`run-summary.json referenced but absent on disk: ${runSummaryPath}`);

  // ---- pre-mutation consistency: the copy must be internally consistent -------
  const rrOriginalDigest = sha256File(runResultPath);
  if (bare(runResultRef[0].file_sha256) !== rrOriginalDigest) {
    fail(`pre-mutation run-result ref digest ${runResultRef[0].file_sha256} != file digest ${rrOriginalDigest}; copy is not clean`);
  }
  const rsOriginalDigest = sha256File(runSummaryPath);
  if (bare(runSummaryRef[0].file_sha256) !== rsOriginalDigest) {
    fail(`pre-mutation run-summary ref digest ${runSummaryRef[0].file_sha256} != file digest ${rsOriginalDigest}; copy is not clean`);
  }
  // The base disposable copy must be internally consistent before we mutate it:
  // a stale run-result .frozen sidecar, or a stale/absent run-summary witness,
  // means the copy is corrupt and the builder must refuse rather than silently
  // "repair" a layer whose prior value we cannot trust.
  const rrFrozenPre = runResultPath + ".frozen";
  if (fs.existsSync(rrFrozenPre)) {
    const side = JSON.parse(fs.readFileSync(rrFrozenPre, "utf8"));
    if (bare(side.file_sha256) !== rrOriginalDigest) {
      fail(`pre-mutation run-result .frozen sidecar file_sha256 ${side.file_sha256} != run-result digest ${rrOriginalDigest}; stale sidecar, copy is not clean`);
    }
  }
  {
    const preSummary = readJson(runSummaryPath);
    if (!preSummary.artifact_hashes || typeof preSummary.artifact_hashes !== "object") {
      fail("pre-mutation run-summary.json has no artifact_hashes witness map; copy cannot be completely bound");
    }
    const preKeys = Object.keys(preSummary.artifact_hashes).filter((k) => k.endsWith("product-out/run-result.json"));
    if (preKeys.length !== 1) fail(`pre-mutation run-summary artifact_hashes has ${preKeys.length} run-result witnesses; require exactly 1 (absent/duplicate witness)`);
    if (bare(preSummary.artifact_hashes[preKeys[0]]) !== rrOriginalDigest) {
      fail(`pre-mutation run-summary artifact_hashes[run-result] ${preSummary.artifact_hashes[preKeys[0]]} != run-result digest ${rrOriginalDigest}; stale witness, copy is not clean`);
    }
  }

  // ---- Layer 1: mutate run-result.json -> inconclusive ------------------------
  const rrOriginal = readJson(runResultPath);
  if (rrOriginal.runStatus === "inconclusive") {
    fail("base scenario is already inconclusive; NC-11R needs a genuine status flip from a non-inconclusive base");
  }
  const rrModified = { ...rrOriginal, runStatus: "inconclusive", inconclusiveReason: "nc11r_fixture_synthetic_inconclusive" };
  const rrModifiedBytes = Buffer.from(JSON.stringify(rrModified, null, 2) + "\n");
  const rrModifiedDigest = sha256(rrModifiedBytes);
  if (rrModifiedDigest === rrOriginalDigest) fail("run-result mutation produced identical digest — not applied");
  fs.writeFileSync(runResultPath, rrModifiedBytes);
  note(`run-result.json runStatus ${rrOriginal.runStatus} -> inconclusive; digest ${rrOriginalDigest} -> ${rrModifiedDigest}`);
  coverage.layers.push({ layer: "run_result_content", status: "updated", from: rrOriginalDigest, to: rrModifiedDigest });

  // ---- Layer 2: operation-record ref for run-result (THE primary binding) -----
  const rrRefMatches = updateRefsExact(
    op.retained_output_refs,
    (r) => r.path.endsWith("product-out/run-result.json"),
    rrModifiedDigest, rrModifiedBytes.length,
  );
  if (rrRefMatches !== 1) fail(`operation-record run-result ref updated ${rrRefMatches} times; require exactly 1`);
  bindingProofs.push({
    layer: "operation_record_retained_output_refs[run-result]",
    file: path.relative(scenarioRoot, recordPath),
    json_pointer: "/operation_records/<interact-completed>/retained_output_refs[path=…/run-result.json]/file_sha256",
    updated_to: prefixed(rrModifiedDigest), byte_length: rrModifiedBytes.length, match_count: rrRefMatches,
  });
  coverage.layers.push({ layer: "operation_record_ref_run_result", status: "updated", match_count: rrRefMatches, to: prefixed(rrModifiedDigest) });

  // ---- Layer 3: run-summary.json artifact_hashes[run-result] ------------------
  const summary = readJson(runSummaryPath);
  if (!summary.artifact_hashes || typeof summary.artifact_hashes !== "object") {
    fail("run-summary.json has no artifact_hashes map — cannot rebind adapter witness");
  }
  const ahKeys = Object.keys(summary.artifact_hashes).filter((k) => k.endsWith("product-out/run-result.json"));
  if (ahKeys.length !== 1) fail(`run-summary artifact_hashes has ${ahKeys.length} run-result keys; require exactly 1`);
  summary.artifact_hashes[ahKeys[0]] = prefixed(rrModifiedDigest);
  const rsModifiedBytes = Buffer.from(JSON.stringify(summary, null, 2) + "\n");
  const rsModifiedDigest = sha256(rsModifiedBytes);
  if (rsModifiedDigest === rsOriginalDigest) fail("run-summary artifact_hashes edit produced identical digest — not applied");
  fs.writeFileSync(runSummaryPath, rsModifiedBytes);
  note(`run-summary.json artifact_hashes[${ahKeys[0]}] -> ${prefixed(rrModifiedDigest)}; digest ${rsOriginalDigest} -> ${rsModifiedDigest}`);
  bindingProofs.push({
    layer: "run_summary_artifact_hashes[run-result]",
    file: path.relative(scenarioRoot, runSummaryPath),
    updated_field: ahKeys[0], updated_to: prefixed(rrModifiedDigest), match_count: 1,
  });
  coverage.layers.push({ layer: "run_summary_artifact_hashes", status: "updated", match_count: 1, to: prefixed(rrModifiedDigest) });

  // ---- Layer 4: operation-record ref for run-summary (cascade re-bind) ---------
  const rsRefMatches = updateRefsExact(
    op.retained_output_refs,
    (r) => r.path.endsWith("qualiber/run-summary.json"),
    rsModifiedDigest, rsModifiedBytes.length,
  );
  if (rsRefMatches !== 1) fail(`operation-record run-summary ref updated ${rsRefMatches} times; require exactly 1`);
  bindingProofs.push({
    layer: "operation_record_retained_output_refs[run-summary]",
    file: path.relative(scenarioRoot, recordPath),
    updated_to: prefixed(rsModifiedDigest), byte_length: rsModifiedBytes.length, match_count: rsRefMatches,
    reason: "run-summary bytes changed when its artifact_hashes was rebound; its own ref must track the new digest or the comparator would mismatch it",
  });
  coverage.layers.push({ layer: "operation_record_ref_run_summary", status: "updated", match_count: rsRefMatches, to: prefixed(rsModifiedDigest) });

  // ---- persist the record with both refs updated ------------------------------
  const recordOriginalDigest = sha256File(recordPath);
  const recordModifiedBytes = Buffer.from(JSON.stringify(record, null, 2) + "\n");
  const recordModifiedDigest = sha256(recordModifiedBytes);
  fs.writeFileSync(recordPath, recordModifiedBytes);
  note(`observation record rewritten with 2 ref updates; digest ${recordOriginalDigest} -> ${recordModifiedDigest}`);
  bindingProofs.push({
    layer: "observation_record_file",
    file: path.relative(scenarioRoot, recordPath),
    original_digest: recordOriginalDigest, modified_digest: recordModifiedDigest,
    note: "record core_hash is NOT recomputed: the comparator does not validate record.core_hash (coreHash is applied only to the response envelope), and the record file is not itself a bound artifact under run-output/store.",
  });

  // ---- Layer 5: run-result.json .frozen sidecar (weak local check) ------------
  const frozenPath = runResultPath + ".frozen";
  if (fs.existsSync(frozenPath)) {
    const frozenText = fs.readFileSync(frozenPath, "utf8");
    const frozen = JSON.parse(frozenText);
    const frozenOriginalDigest = sha256(Buffer.from(frozenText));
    frozen.file_sha256 = prefixed(rrModifiedDigest);
    frozen.byte_length = rrModifiedBytes.length;
    // preserve the original compact (single-line, no trailing newline) sidecar shape
    const trailingNL = frozenText.endsWith("\n") ? "\n" : "";
    const frozenModifiedBytes = Buffer.from(JSON.stringify(frozen) + trailingNL);
    fs.writeFileSync(frozenPath, frozenModifiedBytes);
    bindingProofs.push({
      layer: "frozen_sidecar[run-result]",
      file: path.relative(scenarioRoot, frozenPath),
      original_digest: frozenOriginalDigest, modified_digest: sha256(frozenModifiedBytes),
      updated_to: prefixed(rrModifiedDigest), match_count: 1,
    });
    coverage.layers.push({ layer: "frozen_sidecar_run_result", status: "updated", match_count: 1, to: prefixed(rrModifiedDigest) });
    note(`run-result.json.frozen sidecar rebound to ${prefixed(rrModifiedDigest)}`);
  } else {
    coverage.layers.push({ layer: "frozen_sidecar_run_result", status: "inapplicable", reason: "no .frozen sidecar present for run-result.json in this scenario" });
  }

  // ---- run-summary .frozen: explicitly inapplicable ---------------------------
  // The comparator's frozen-sidecar loop iterates ONLY product-out files
  // (compare-scenario.mjs: `for (const f of productFiles ...)`), so run-summary's
  // sidecar (under qualiber/, not product-out/) is never validated. Record the
  // reasoning rather than performing a binding nobody checks.
  const rsFrozen = runSummaryPath + ".frozen";
  coverage.layers.push({
    layer: "frozen_sidecar_run_summary",
    status: "inapplicable",
    reason: fs.existsSync(rsFrozen)
      ? "run-summary.json.frozen exists but lives outside product-out/; the comparator's frozen check only walks product-out, so it is never read"
      : "no run-summary.json.frozen sidecar present, and the comparator would not read it if there were one",
  });

  // ---- post-mutation verification: every bound layer must now agree -----------
  const verify = [];
  const check = (label, ok, detail) => { verify.push({ label, ok, detail }); if (!ok) fail(`post-mutation verification failed: ${label} :: ${detail}`); };
  const record2 = readJson(recordPath);
  const op2 = findInteractCompletedRecord(record2);
  const rr2 = op2.retained_output_refs.find((r) => r.path.endsWith("product-out/run-result.json"));
  const rs2 = op2.retained_output_refs.find((r) => r.path.endsWith("qualiber/run-summary.json"));
  check("run-result file == run-result ref", bare(rr2.file_sha256) === sha256File(runResultPath), `${rr2.file_sha256} vs ${sha256File(runResultPath)}`);
  check("run-summary file == run-summary ref", bare(rs2.file_sha256) === sha256File(runSummaryPath), `${rs2.file_sha256} vs ${sha256File(runSummaryPath)}`);
  const summary2 = readJson(runSummaryPath);
  check("run-summary artifact_hashes[run-result] == run-result file", bare(summary2.artifact_hashes[ahKeys[0]]) === sha256File(runResultPath), "artifact_hashes cascade");
  check("run-result observed status is inconclusive", readJson(runResultPath).runStatus === "inconclusive", "status flip");
  if (fs.existsSync(frozenPath)) check("frozen sidecar == run-result file", bare(JSON.parse(fs.readFileSync(frozenPath, "utf8")).file_sha256) === sha256File(runResultPath), "frozen cascade");

  // ---- oracle set: expectations + precommit + campaign-index + lock -----------
  const captureRef = (plan.inputs ?? []).find((i) => i.role === "capture-stimulus");
  const contractRef = (plan.inputs ?? []).find((i) => i.role === "contract-stimulus");
  if (!captureRef || !contractRef) fail("sealed plan is missing capture/contract stimulus inputs — cannot bind oracle-precommit input digests");
  const captureSha = captureRef.artifact.file_sha256;
  const contractSha = contractRef.artifact.file_sha256;
  const observationId = record.observation_id;
  const planCoreHash = plan.core_hash;

  const commonExpectation = {
    schema_version: "qualiber-reality-lab/campaign-expectation/v1",
    expected_operation_state: "completed",
    expected_response_status: "supported",
    expected_run_status: "inconclusive",
    required_finding_types: [],
    permitted_additional_types: [],
    target_event: null,
    max_finding_count: 0,
    expected_product_reported: true,
  };
  const idPositive = `${base}-POSITIVE-BOUND-CONTROL`;
  const idForbidden = `${base}-FORBIDDEN-PRECEDENCE`;
  const idMutation = `${base}-MUTATION-NO-FORBIDDEN`;

  const expectations = {
    [idPositive]: {
      ...commonExpectation, scenario_id: idPositive,
      fixture_note: "Positive bound control: expected_run_status=inconclusive, NO forbidden list. Observed==expected==inconclusive => agree. Proves the fixture is fully bound and inconclusive is otherwise acceptable.",
    },
    [idForbidden]: {
      ...commonExpectation, scenario_id: idForbidden,
      forbidden_run_status: ["inconclusive"],
      fixture_note: "NC-11R forbidden-status precedence: expected_run_status=inconclusive AND forbidden_run_status=[inconclusive]. Rule 6 must force disagree/product_disagreement with sub-reason forbidden_run_status_observed even though expected==observed. run_status_mismatch is NOT triggered (expected==observed).",
    },
    [idMutation]: {
      ...commonExpectation, scenario_id: idMutation,
      fixture_note: "Mutation control: forbidden_run_status removed. Observed==expected==inconclusive => agree. Proves the forbidden branch (not run_status_mismatch) is load-bearing for the NC-11R disagree.",
    },
  };

  const expectationsDir = path.join(outputDir, "expectations");
  fs.mkdirSync(expectationsDir, { recursive: true });
  const expectationDigests = {};
  const precommitScenarios = [];
  const indexScenarios = [];
  for (const [id, content] of Object.entries(expectations)) {
    const bytes = Buffer.from(JSON.stringify(content, null, 2) + "\n");
    const fp = path.join(expectationsDir, `${id}.expected.json`);
    fs.writeFileSync(fp, bytes);
    const dg = sha256(bytes);
    expectationDigests[id] = dg;
    precommitScenarios.push({
      scenario_id: id,
      expectation_sha256: prefixed(dg),
      expectation_bytes: bytes.length,
      capture_stimulus_sha256: captureSha,
      contract_stimulus_sha256: contractSha,
    });
    indexScenarios.push({ scenario_id: id, observation_id: observationId, sealed_plan_core_hash: planCoreHash });
    note(`expectation ${id}.expected.json digest ${dg}`);
  }

  const precommit = {
    schema_version: "qualiber-reality-lab/nc11r-fixture-precommit/v1",
    fixture_type: "NON-CAMPAIGN REHEARSAL — NOT AN OFFICIAL CONTROL PRECOMMIT",
    base_scenario: "QLB-EXT-012 (disposable copy)",
    revision: 1,
    scenarios: precommitScenarios,
    negative_controls: [],
  };
  const index = {
    schema_version: "qualiber-reality-lab/nc11r-fixture-campaign-index/v1",
    fixture_type: "NON-CAMPAIGN REHEARSAL",
    scenarios: indexScenarios,
  };
  const precommitPath = path.join(outputDir, "oracle-precommit.json");
  const indexPath = path.join(outputDir, "campaign-index.json");
  const lockCopyPath = path.join(outputDir, "execution-lock.json");
  fs.writeFileSync(precommitPath, JSON.stringify(precommit, null, 2) + "\n");
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2) + "\n");
  fs.copyFileSync(executionLock, lockCopyPath);

  const manifest = {
    schema: "qualiber-reality-lab/nc11r-fixture-manifest/v1",
    fixture_type: "NON-CAMPAIGN REHEARSAL — NOT AN OFFICIAL CONTROL RESULT",
    scenario_root: path.relative(outputDir, scenarioRoot) || ".",
    scenario_root_abs: scenarioRoot,
    oracle_precommit: "oracle-precommit.json",
    campaign_index: "campaign-index.json",
    execution_lock: "execution-lock.json",
    scenario_ids: { positive: idPositive, forbidden: idForbidden, mutation_no_forbidden: idMutation },
    expectations: {
      [idPositive]: `expectations/${idPositive}.expected.json`,
      [idForbidden]: `expectations/${idForbidden}.expected.json`,
      [idMutation]: `expectations/${idMutation}.expected.json`,
    },
    expected_verdicts: { [idPositive]: "agree", [idForbidden]: "disagree", [idMutation]: "agree" },
  };
  fs.writeFileSync(path.join(outputDir, "fixture-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  const fixtureRecord = {
    schema: "qualiber-reality-lab/nc11r-fixture/v2",
    fixture_type: "NON-CAMPAIGN REHEARSAL — NOT AN OFFICIAL CONTROL RESULT",
    ird_001: "corrected — operation_records[interact/completed].retained_output_refs is the real comparator binding and is now updated; top-level result.retained_output_refs (empty) is not read by the comparator and is intentionally NOT the binding target",
    base_scenario: "QLB-EXT-012 (disposable copy)",
    observation_id: observationId,
    run_result_original_digest: rrOriginalDigest,
    run_result_modified_digest: rrModifiedDigest,
    run_result_modified_status: "inconclusive",
    binding_proofs: bindingProofs,
    binding_coverage: coverage.layers,
    post_mutation_verification: verify,
    expectation_digests: expectationDigests,
    oracle: { precommit: "oracle-precommit.json", campaign_index: "campaign-index.json", execution_lock: "execution-lock.json" },
    construction_log: log,
  };
  fs.writeFileSync(path.join(outputDir, "nc11r-fixture-record.json"), JSON.stringify(fixtureRecord, null, 2) + "\n");
  return fixtureRecord;
}

const args = parseArgs(process.argv.slice(2));
try {
  const result = buildFixture(args);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.exit(0);
} catch (e) {
  process.stderr.write(`nc11r-fixture-builder: ERROR: ${e.stack || e.message}\n`);
  process.exit(3);
}
