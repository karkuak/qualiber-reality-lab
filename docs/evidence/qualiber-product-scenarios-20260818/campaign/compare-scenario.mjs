#!/usr/bin/env node
/**
 * compare-scenario.mjs — TASK-LOCAL CAMPAIGN EVIDENCE TOOLING.
 *
 * MUST NOT be promoted into Reality Lab packages or into Qualiber. It lives
 * only inside the campaign evidence bundle (plan revision 4.3 §10.3), following
 * the retained-but-never-promoted precedent of task-local-verify.mjs.
 *
 * It imports NOTHING from Qualiber. Its only non-builtin imports are two
 * generic Lab packages consumed as published — `@erl2/contracts` (envelope
 * schema) and `@erl2/integrity` (`coreHash`) — resolved through a REQUIRED
 * `--dependency-anchor` (§10.3.1). Neither carries Qualiber semantics.
 *
 * READING RULES (§10.5), normative:
 *   1. `runStatus`, `notRunReason`, `inconclusiveReason`, `collectorHealth` and
 *      `customerVisibleMessage` come ONLY from product-out/run-result.json.
 *   2. Finding types come ONLY from report.json `/result/findings[]/type`;
 *      target events from `/result/findings[]/detail/event`. Absent report.json
 *      means finding types are null — "not stated" is not "none".
 *   3. Exit codes are RECORDED and never consulted. No branch in this file
 *      compares any exit code against anything. See §10.5 rule 3.
 *   4. The adapter's outcome is TWO fields from operation_outcomes[] where
 *      operation === "interact": `state` and `response_status`. Both are
 *      compared in every scenario. A `completed` record has never meant the
 *      adapter succeeded.
 *   4a. Adapter error codes come from the retained response envelope at
 *      /error/code, /error/owner, /error/safe_message — never from
 *      operation_outcomes — and only after the four-step bind below.
 *   5. A missing/unreadable/runStatus-less run-result.json is `unavailable`.
 *      No fallback path exists; no branch can reach `clean` from a missing file.
 *   6. `forbidden_run_status`, when matched, forces `disagree`.
 *   7. Binding runs FIRST. A failed binding yields unavailable /
 *      lab_harness_failure and NO verdict is computed.
 *   `terminal_status` is never read to classify anything.
 *
 * RESPONSE-ENVELOPE BIND — four steps, in order (§10.6):
 *   1. bytes: file sha256 === `.frozen` sidecar file_sha256
 *   2. shape: schema-check as AdapterResponseEnvelopeV2 via @erl2/contracts
 *   3. recompute: coreHash(envelope) via @erl2/integrity
 *   4. identity: recomputed === envelope.core_hash === operation.response_envelope_hash
 *   The record stores the envelope's `core_hash`, NOT the file's sha256; the two
 *   differ on every real run. The recompute is NOT delegated to
 *   verifyTrustedLocalObservationRecord, whose input surface has no envelope path.
 *
 * Exit codes: 0 = a comparison was produced (any verdict). 3 = tooling failure
 * (anchor missing / package unresolvable) — a hard exit BEFORE any comparison,
 * deliberately not a verdict, because no scenario was evaluated.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const COMPARISON_SCHEMA = "qualiber-reality-lab/campaign-comparison/v1";
const INTERACT = "interact";

/** §10.7 — the only classification values this script may emit. */
const CLASSIFICATIONS = Object.freeze({
  AGREEMENT: "product_agreement",
  REFUSAL_EXPECTED: "product_refusal_expected",
  DISAGREEMENT: "product_disagreement",
  ADAPTER_OPERATIONAL: "adapter_operational_failure",
  HARNESS: "lab_harness_failure",
  UNAVAILABLE: "unavailable",
});

function toolingFailure(message) {
  process.stderr.write(`compare-scenario: TOOLING FAILURE: ${message}\n`);
  process.stderr.write("compare-scenario: no scenario was evaluated; this is not a verdict.\n");
  process.exit(3);
}

function usage(message) {
  process.stderr.write(`compare-scenario: ${message}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const out = {
    scenario: null, scenarioRoot: null, expected: null, oraclePrecommit: null,
    executionLock: null, campaignIndex: null, dependencyAnchor: null, output: null,
    mode: "scenario",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    switch (a) {
      case "--scenario": out.scenario = argv[++i]; break;
      case "--scenario-root": out.scenarioRoot = argv[++i]; break;
      case "--expected": out.expected = argv[++i]; break;
      case "--oracle-precommit": out.oraclePrecommit = argv[++i]; break;
      case "--execution-lock": out.executionLock = argv[++i]; break;
      case "--campaign-index": out.campaignIndex = argv[++i]; break;
      case "--dependency-anchor": out.dependencyAnchor = argv[++i]; break;
      case "--output": out.output = argv[++i]; break;
      case "--nc1-mode": out.mode = "nc1"; break;
      default: usage(`unknown flag ${a}`);
    }
  }
  for (const req of ["scenario", "scenarioRoot", "expected", "oraclePrecommit", "executionLock", "campaignIndex"]) {
    if (!out[req]) usage(`--${req.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} is required`);
  }
  // §10.3.1: required argument, NO DEFAULT. An anchor the script guessed would
  // be an anchor nobody recorded.
  if (!out.dependencyAnchor) {
    toolingFailure("--dependency-anchor <fresh-qualiber>/adapters/erl2-subject/package.json is required and has no default");
  }
  return out;
}

const sha256Hex = (buf) => createHash("sha256").update(buf).digest("hex");
const prefixed = (hex) => `sha256:${hex}`;
const bare = (v) => (typeof v === "string" && v.startsWith("sha256:") ? v.slice(7) : v);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
function maybeReadJson(file) {
  try {
    return readJson(file);
  } catch {
    return null;
  }
}
function fileDigest(file) {
  try {
    return sha256Hex(fs.readFileSync(file));
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * §10.3.1 — explicit anchor, no ambient resolution.
 * ------------------------------------------------------------------ */
async function resolveLabDependencies(anchorPath) {
  if (!fs.existsSync(anchorPath)) toolingFailure(`dependency anchor does not exist: ${anchorPath}`);
  if (path.basename(anchorPath) !== "package.json") {
    toolingFailure(`dependency anchor must be a package.json, got ${path.basename(anchorPath)}`);
  }
  let req;
  try {
    req = createRequire(anchorPath);
  } catch (err) {
    toolingFailure(`createRequire failed for anchor ${anchorPath}: ${err.message}`);
  }
  const resolved = [];
  const modules = {};
  for (const name of ["@erl2/contracts", "@erl2/integrity"]) {
    let entry;
    try {
      entry = req.resolve(name);
    } catch (err) {
      toolingFailure(`cannot resolve ${name} through anchor ${anchorPath}: ${err.code ?? err.message}`);
    }
    // `./package.json` is not in these packages' exports map, so the manifest is
    // located by walking up from the resolved entrypoint rather than resolved.
    const manifest = nearestPackageJson(entry);
    let mod;
    try {
      mod = await import(pathToFileURL(entry).href);
    } catch (err) {
      toolingFailure(`cannot import resolved entrypoint for ${name} (${entry}): ${err.message}`);
    }
    modules[name] = mod;
    resolved.push({
      name: manifest.json.name,
      version: manifest.json.version,
      entry_sha256: prefixed(sha256Hex(fs.readFileSync(entry))),
      // Absolute paths stay OUT of the lock and out of comparison.json; they
      // belong to the command log only (§10.3.1).
      absolute_entry: entry,
    });
  }
  return { resolved, modules };
}

function nearestPackageJson(from) {
  let dir = path.dirname(from);
  for (;;) {
    const candidate = path.join(dir, "package.json");
    if (fs.existsSync(candidate)) {
      const json = maybeReadJson(candidate);
      if (json && json.name) return { path: candidate, json };
    }
    const up = path.dirname(dir);
    if (up === dir) toolingFailure(`no package.json found above ${from}`);
    dir = up;
  }
}

/* ------------------------------------------------------------------ *
 * Binding (§10.6). Runs before any semantic read.
 * ------------------------------------------------------------------ */
function findInteractOutcome(record) {
  return (record.operation_outcomes ?? []).find((o) => o.operation === INTERACT) ?? null;
}
function findInteractCompletedRecord(record) {
  return (
    (record.operation_records ?? []).find(
      (r) => r.operation === INTERACT && r.state === "completed",
    ) ?? null
  );
}

function main() {
  return run().catch((err) => {
    process.stderr.write(`compare-scenario: unexpected error: ${err?.stack ?? err}\n`);
    process.exit(2);
  });
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const { resolved, modules } = await resolveLabDependencies(args.dependencyAnchor);
  const { coreHash } = modules["@erl2/integrity"];
  const { validateContract } = modules["@erl2/contracts"];
  if (typeof coreHash !== "function") toolingFailure("@erl2/integrity did not export coreHash");
  if (typeof validateContract !== "function") toolingFailure("@erl2/contracts did not export validateContract");

  const precommitBytes = fs.readFileSync(args.oraclePrecommit);
  const precommit = JSON.parse(precommitBytes.toString("utf8"));
  const precommitDigest = prefixed(sha256Hex(precommitBytes));
  const lockBytes = fs.readFileSync(args.executionLock);
  const lock = JSON.parse(lockBytes.toString("utf8"));
  const lockDigest = prefixed(sha256Hex(lockBytes));
  const campaignIndex = readJson(args.campaignIndex);

  const sub = [];
  const binding = {
    bound: false,
    dependency_triples_matched: null,
    expectation_digest_matched: null,
    expectation_binding_mode: args.mode,
    record_retained_output_refs_matched: [],
    record_retained_output_refs_mismatched: [],
    adapter_artifact_hashes_matched: null,
    frozen_sidecars_matched: null,
    response_envelope_bytes_matched: null,
    response_envelope_schema_valid: null,
    response_envelope_core_hash_recomputed: null,
    response_envelope_core_hash_matched: null,
    plan_hash: null,
    adapter_artifact_hash: null,
    capture_stimulus_sha256: null,
    contract_stimulus_sha256: null,
    oracle_precommit_digests_matched: null,
    execution_lock_digests_matched: null,
    campaign_index_observation_id_matched: null,
  };
  const evidenceRefs = [];
  const observed = {
    operation_state: null, response_status: null,
    envelope_error_code: null, envelope_error_owner: null, envelope_error_safe_message: null,
    run_status: null, not_run_reason: null, inconclusive_reason: null, collector_health: null,
    customer_visible_message: null,
    finding_count: null, finding_types: null, finding_events: null,
    // Recorded only. No branch below compares these against anything (§10.5 r3).
    recorded_exit_code: null, recorded_ci_exit_code: null,
    artifacts_present: [], artifacts_absent: [],
    terminal_status_recorded_not_used: null,
  };

  const emit = (verdict, classification) => {
    const out = {
      schema_version: COMPARISON_SCHEMA,
      scenario_id: args.scenario,
      mode: args.mode,
      observation_id: observedObservationId,
      oracle_precommit_sha256: precommitDigest,
      oracle_precommit_revision: precommit.revision ?? null,
      execution_lock_sha256: lockDigest,
      expectation_sha256: expectationDigest ? prefixed(expectationDigest) : null,
      comparator_dependencies_resolved: resolved.map(({ name, version, entry_sha256 }) => ({
        name, version, entry_sha256,
      })),
      binding,
      expected: expectedPublic,
      observed,
      verdict,
      classification,
      sub_reasons: sub,
      evidence_refs: evidenceRefs,
    };
    const json = `${JSON.stringify(out, null, 2)}\n`;
    if (args.output) {
      fs.mkdirSync(path.dirname(args.output), { recursive: true });
      fs.writeFileSync(args.output, json);
    } else {
      process.stdout.write(json);
    }
    process.stdout.write(`${args.scenario} [${args.mode}] verdict=${verdict} classification=${classification}` +
      `${sub.length ? ` sub_reasons=${sub.join(",")}` : ""}\n`);
    process.exit(0);
  };

  let observedObservationId = null;
  let expectationDigest = null;
  let expectedPublic = null;

  /* --- dependency triples must match the lock (§10.3.1) --- */
  const lockDeps = lock.comparator_dependencies?.resolved ?? null;
  if (!Array.isArray(lockDeps)) {
    binding.dependency_triples_matched = false;
    sub.push("execution_lock_missing_comparator_dependencies");
    return emit("unavailable", CLASSIFICATIONS.HARNESS);
  }
  const tripleMismatch = resolved.some((r) => {
    const want = lockDeps.find((d) => d.name === r.name);
    return !want || want.version !== r.version || bare(want.entry_sha256) !== bare(r.entry_sha256);
  });
  binding.dependency_triples_matched = !tripleMismatch;
  if (tripleMismatch) {
    sub.push("comparator_dependency_triple_mismatch");
    return emit("unavailable", CLASSIFICATIONS.HARNESS);
  }

  /* --- expectation digest binding --- */
  if (!fs.existsSync(args.expected)) {
    binding.expectation_digest_matched = false;
    sub.push("expectation_file_absent");
    return emit("unavailable", CLASSIFICATIONS.HARNESS);
  }
  const expectationBytes = fs.readFileSync(args.expected);
  expectationDigest = sha256Hex(expectationBytes);
  const expectation = JSON.parse(expectationBytes.toString("utf8"));
  const scenarioEntry = (precommit.scenarios ?? []).find((s) => s.scenario_id === args.scenario) ?? null;

  if (args.mode === "nc1") {
    // NC-1 mode accepts ONLY a counterfactual whose digest matches a
    // `negative_controls` entry for this scenario. It cannot be pointed at an
    // arbitrary expectation, so the mode is not a route around the gate (§11).
    const control = (precommit.negative_controls ?? []).find(
      (c) => c.targets_scenario === args.scenario &&
        bare(c.counterfactual_expectation_sha256) === expectationDigest,
    );
    binding.expectation_digest_matched = Boolean(control);
    if (!control) {
      sub.push("counterfactual_not_precommitted");
      return emit("unavailable", CLASSIFICATIONS.HARNESS);
    }
    binding.nc1_control_id = control.control_id;
  } else {
    binding.expectation_digest_matched = Boolean(
      scenarioEntry && bare(scenarioEntry.expectation_sha256) === expectationDigest,
    );
    if (!binding.expectation_digest_matched) {
      sub.push("expectation_digest_not_precommitted");
      return emit("unavailable", CLASSIFICATIONS.HARNESS);
    }
  }

  expectedPublic = {
    run_status: expectation.expected_run_status ?? null,
    forbidden_run_status: expectation.forbidden_run_status ?? [],
    required_finding_types: expectation.required_finding_types ?? null,
    permitted_additional_types: expectation.permitted_additional_types ?? null,
    target_event: expectation.target_event ?? null,
    max_finding_count: expectation.max_finding_count ?? null,
    operation_state: expectation.expected_operation_state ?? null,
    response_status: expectation.expected_response_status ?? null,
    product_reported: expectation.expected_product_reported ?? null,
    not_run_reason: expectation.expected_not_run_reason ?? null,
    envelope_error_code: expectation.expected_envelope_error_code ?? null,
    envelope_error_owner: expectation.expected_envelope_error_owner ?? null,
    diagnostic_names_field: expectation.expected_diagnostic_names_field ?? null,
    present_artifacts: expectation.expected_present_artifacts ?? null,
    absent_artifacts: expectation.expected_absent_artifacts ?? null,
    requires_inconclusive_reason: expectation.requires_inconclusive_reason ?? false,
  };

  /* --- record, plan, index --- */
  const runOutput = path.join(args.scenarioRoot, "run-output");
  const recordPath = path.join(runOutput, "trusted-local-observation-record.json");
  const sealedPlanPath = path.join(args.scenarioRoot, "plan", "plan-sealed.json");
  const record = maybeReadJson(recordPath);
  const sealedPlan = maybeReadJson(sealedPlanPath);
  if (!record || !sealedPlan) {
    sub.push(!record ? "observation_record_absent_or_unreadable" : "sealed_plan_absent_or_unreadable");
    return emit("unavailable", CLASSIFICATIONS.HARNESS);
  }
  observedObservationId = record.observation_id ?? null;
  observed.terminal_status_recorded_not_used = record.terminal_status ?? null;

  const indexEntry = (campaignIndex.scenarios ?? []).find((s) => s.scenario_id === args.scenario) ?? null;
  binding.campaign_index_observation_id_matched = Boolean(
    indexEntry &&
      indexEntry.observation_id === record.observation_id &&
      record.observation_id === sealedPlan.observation_id &&
      bare(indexEntry.sealed_plan_core_hash) === bare(sealedPlan.core_hash),
  );
  binding.plan_hash = record.plan_hash ?? null;
  const planHashMatched = bare(record.plan_hash) === bare(sealedPlan.core_hash);
  binding.adapter_artifact_hash = record.adapter_artifact_hash ?? null;
  const artifactMatched =
    bare(record.adapter_artifact_hash) === bare(lock.adapter?.artifact_sha256);
  binding.execution_lock_digests_matched = artifactMatched;

  if (!binding.campaign_index_observation_id_matched) sub.push("observation_identity_binding_failed");
  if (!planHashMatched) sub.push("plan_hash_binding_failed");
  if (!artifactMatched) sub.push("adapter_artifact_hash_binding_failed");

  /* --- input digests across four places --- */
  const interactRoot = path.join(runOutput, "store", "local-observation-output");
  const opOutcome = findInteractOutcome(record);
  const opRecord = findInteractCompletedRecord(record);
  if (!opOutcome || !opRecord) {
    sub.push("interact_operation_record_absent");
    return emit("unavailable", CLASSIFICATIONS.HARNESS);
  }
  const operationId = opOutcome.operation_id;
  const qualiberDir = path.join(interactRoot, operationId, "qualiber");
  const productOut = path.join(qualiberDir, "product-out");

  const stimulusIdentity = maybeReadJson(path.join(qualiberDir, "stimulus-identity.json"));
  const planInputs = sealedPlan.inputs ?? [];
  const inputChecks = [];
  for (const [role, fileName, precommitKey] of [
    ["capture-stimulus", "stimulus.json", "capture_stimulus_sha256"],
    ["contract-stimulus", "contract.json", "contract_stimulus_sha256"],
  ]) {
    const planInput = planInputs.find((i) => i.role === role) ?? null;
    const retained = path.join(runOutput, "inputs", role, fileName);
    const retainedDigest = fileDigest(retained);
    // Sealed plans carry the digest at inputs[].artifact.file_sha256.
    const planDigest = bare(planInput?.artifact?.file_sha256 ?? null);
    const precommitDigestForInput = bare(scenarioEntry?.[precommitKey] ?? null);
    const identityDigest = bare(
      stimulusIdentity?.[role === "capture-stimulus" ? "capture_stimulus" : "contract_stimulus"]?.sha256 ??
        stimulusIdentity?.[role]?.sha256 ?? null,
    );
    const agree =
      retainedDigest !== null &&
      planDigest === retainedDigest &&
      precommitDigestForInput === retainedDigest &&
      (identityDigest === null || identityDigest === retainedDigest);
    inputChecks.push({ role, retainedDigest, planDigest, precommitDigestForInput, identityDigest, agree });
    if (role === "capture-stimulus") binding.capture_stimulus_sha256 = retainedDigest ? prefixed(retainedDigest) : null;
    else binding.contract_stimulus_sha256 = retainedDigest ? prefixed(retainedDigest) : null;
    evidenceRefs.push({
      field: `input:${role}`,
      path: path.relative(args.scenarioRoot, retained),
      sha256: retainedDigest ? prefixed(retainedDigest) : null,
      json_pointer: null,
    });
  }
  binding.input_digest_checks = inputChecks.map(({ role, agree, retainedDigest }) => ({
    role, agreed: agree, sha256: retainedDigest ? prefixed(retainedDigest) : null,
  }));
  binding.oracle_precommit_digests_matched = inputChecks.every((c) => c.agree);
  if (!binding.oracle_precommit_digests_matched) sub.push("input_digest_binding_failed");

  /* --- retained_output_refs: primary binding for every artifact read --- */
  const refs = new Map();
  for (const r of opRecord.retained_output_refs ?? []) refs.set(r.path, r);
  const storeRoot = path.join(runOutput, "store");

  /** Binds one artifact to the record before its bytes may be interpreted. */
  const bindArtifact = (absPath) => {
    const logical = path.relative(storeRoot, absPath).split(path.sep).join("/");
    const ref = refs.get(logical);
    const actual = fileDigest(absPath);
    if (!ref || actual === null || bare(ref.file_sha256) !== actual) {
      binding.record_retained_output_refs_mismatched.push(logical);
      return { ok: false, logical, actual };
    }
    binding.record_retained_output_refs_matched.push(logical);
    return { ok: true, logical, actual };
  };

  // Product artifacts actually present under product-out (excluding host-written
  // .frozen sidecars, which are not subject output).
  const productFiles = fs.existsSync(productOut)
    ? fs.readdirSync(productOut).filter((f) => !f.endsWith(".frozen")).sort()
    : [];
  observed.artifacts_present = productFiles;

  const runResultPath = path.join(productOut, "run-result.json");
  const reportPath = path.join(productOut, "report.json");
  const runSummaryPath = path.join(qualiberDir, "run-summary.json");
  const capturePath = path.join(qualiberDir, "capture.json");

  const runResultBound = fs.existsSync(runResultPath) ? bindArtifact(runResultPath) : { ok: false, logical: null, actual: null };
  const reportBound = fs.existsSync(reportPath) ? bindArtifact(reportPath) : null;
  const runSummaryBound = fs.existsSync(runSummaryPath) ? bindArtifact(runSummaryPath) : null;
  if (fs.existsSync(capturePath)) bindArtifact(capturePath);
  const stimulusIdentityPath = path.join(qualiberDir, "stimulus-identity.json");
  if (fs.existsSync(stimulusIdentityPath)) bindArtifact(stimulusIdentityPath);

  /* --- secondary witness: adapter artifact_hashes (§6.7 scope) --- */
  const runSummary = runSummaryBound?.ok ? maybeReadJson(runSummaryPath) : maybeReadJson(runSummaryPath);
  if (runSummary && runSummary.artifact_hashes && typeof runSummary.artifact_hashes === "object") {
    let allAgree = true;
    const witnessed = [];
    for (const [rel, declared] of Object.entries(runSummary.artifact_hashes)) {
      if (rel.endsWith(".frozen") || rel === "qualiber/run-summary.json") {
        allAgree = false; // scope violation: the map must exclude these
        witnessed.push({ path: rel, agreed: false, note: "outside declared artifact_hashes scope" });
        continue;
      }
      const abs = path.join(interactRoot, operationId, rel);
      const actual = fileDigest(abs);
      const agreed = actual !== null && bare(declared) === actual;
      if (!agreed) allAgree = false;
      witnessed.push({ path: rel, agreed });
    }
    binding.adapter_artifact_hashes_matched = allAgree;
    binding.adapter_artifact_hashes_witnessed = witnessed;
    if (!allAgree) sub.push("adapter_artifact_hashes_binding_failed");
  } else {
    binding.adapter_artifact_hashes_matched = false;
    sub.push("adapter_run_summary_absent_or_hashless");
  }

  /* --- weak local check: .frozen sidecars --- */
  let frozenOk = true;
  const frozenChecks = [];
  for (const f of productFiles.concat(fs.existsSync(qualiberDir) ? [] : [])) {
    const abs = path.join(productOut, f);
    const side = `${abs}.frozen`;
    if (!fs.existsSync(side)) continue;
    const declared = bare(maybeReadJson(side)?.file_sha256 ?? null);
    const actual = fileDigest(abs);
    const agreed = declared !== null && declared === actual;
    if (!agreed) frozenOk = false;
    frozenChecks.push({ path: `product-out/${f}`, agreed });
  }
  binding.frozen_sidecars_matched = frozenOk;
  binding.frozen_sidecar_checks = frozenChecks;
  binding.frozen_sidecar_note =
    "weak local consistency check only; sidecars travel with their files and cannot detect a cross-scenario swap";

  if (binding.record_retained_output_refs_mismatched.length > 0) {
    sub.push("retained_output_refs_binding_failed");
  }

  /* --- response envelope: four-step bind, when the expectation names a code --- */
  const envelopePath = path.join(
    runOutput, "store", "retained", "local-observation-adapter", operationId, "response-envelope.json",
  );
  let envelope = null;
  if (expectedPublic.envelope_error_code !== null) {
    const sidecarPath = `${envelopePath}.frozen`;
    const sidecar = maybeReadJson(sidecarPath);
    const actualBytesDigest = fileDigest(envelopePath);
    // Step 1 — bytes.
    binding.response_envelope_bytes_matched = Boolean(
      sidecar && actualBytesDigest && bare(sidecar.file_sha256) === actualBytesDigest,
    );
    if (!binding.response_envelope_bytes_matched) {
      sub.push("response_envelope_bytes_binding_failed");
      return emit("unavailable", CLASSIFICATIONS.HARNESS);
    }
    // Step 2 — shape.
    const parsed = maybeReadJson(envelopePath);
    let schemaResult = { valid: false, problems: [{ message: "unparsable" }] };
    if (parsed) {
      try {
        schemaResult = validateContract("AdapterResponseEnvelopeV2", parsed);
      } catch (err) {
        schemaResult = { valid: false, problems: [{ message: err.message }] };
      }
    }
    binding.response_envelope_schema_valid = schemaResult.valid;
    if (!schemaResult.valid) {
      sub.push("response_envelope_schema_invalid");
      return emit("unavailable", CLASSIFICATIONS.HARNESS);
    }
    // Step 3 — recompute. NOT delegated to the offline verifier, which never
    // opens this file.
    const recomputed = coreHash(parsed);
    binding.response_envelope_core_hash_recomputed = recomputed;
    // Step 4 — identity: all three equal.
    binding.response_envelope_core_hash_matched =
      bare(recomputed) === bare(parsed.core_hash) &&
      bare(parsed.core_hash) === bare(opOutcome.response_envelope_hash);
    binding.response_envelope_file_sha256 = prefixed(actualBytesDigest);
    binding.response_envelope_declared_core_hash = parsed.core_hash ?? null;
    binding.response_envelope_record_hash = opOutcome.response_envelope_hash ?? null;
    if (!binding.response_envelope_core_hash_matched) {
      sub.push("response_envelope_core_hash_binding_failed");
      return emit("unavailable", CLASSIFICATIONS.HARNESS);
    }
    envelope = parsed;
    evidenceRefs.push({
      field: "envelope_error_code",
      path: path.relative(args.scenarioRoot, envelopePath),
      sha256: prefixed(actualBytesDigest),
      core_hash: parsed.core_hash,
      json_pointer: "/error/code",
    });
  }

  /* --- gate: binding must hold before any verdict (§10.5 rule 7) --- */
  const bindingHeld =
    binding.dependency_triples_matched === true &&
    binding.expectation_digest_matched === true &&
    binding.campaign_index_observation_id_matched === true &&
    planHashMatched &&
    artifactMatched &&
    binding.oracle_precommit_digests_matched === true &&
    binding.adapter_artifact_hashes_matched === true &&
    binding.record_retained_output_refs_mismatched.length === 0;
  binding.bound = bindingHeld;
  if (!bindingHeld) return emit("unavailable", CLASSIFICATIONS.HARNESS);

  /* --- §15: a record state of `failed` is a host fault, never the 005 refusal --- */
  observed.operation_state = opOutcome.state ?? null;
  observed.response_status = opOutcome.response_status ?? null;
  evidenceRefs.push({
    field: "operation_state",
    path: path.relative(args.scenarioRoot, recordPath),
    sha256: prefixed(fileDigest(recordPath)),
    json_pointer: `/operation_outcomes/${record.operation_outcomes.indexOf(opOutcome)}/state`,
  });
  evidenceRefs.push({
    field: "response_status",
    path: path.relative(args.scenarioRoot, recordPath),
    sha256: prefixed(fileDigest(recordPath)),
    json_pointer: `/operation_outcomes/${record.operation_outcomes.indexOf(opOutcome)}/response_status`,
  });
  if (observed.operation_state === "failed") {
    sub.push("record_state_failed_is_host_fault");
    return emit("unavailable", CLASSIFICATIONS.HARNESS);
  }

  if (envelope) {
    observed.envelope_error_code = envelope.error?.code ?? null;
    observed.envelope_error_owner = envelope.error?.owner ?? null;
    observed.envelope_error_safe_message = envelope.error?.safe_message ?? null;
  }

  /* --- §10.5 rule 1/5: run-result.json is the only source of run status --- */
  if (!runResultBound.ok) {
    sub.push("run_result_absent_or_unbound");
    return emit("unavailable", CLASSIFICATIONS.UNAVAILABLE);
  }
  const runResult = maybeReadJson(runResultPath);
  if (!runResult || typeof runResult.runStatus !== "string" || runResult.runStatus.length === 0) {
    sub.push("run_result_has_no_run_status");
    return emit("unavailable", CLASSIFICATIONS.UNAVAILABLE);
  }
  observed.run_status = runResult.runStatus;
  observed.not_run_reason = runResult.notRunReason ?? null;
  observed.inconclusive_reason = runResult.inconclusiveReason ?? null;
  observed.collector_health = runResult.collectorHealth ?? null;
  observed.customer_visible_message = runResult.customerVisibleMessage ?? null;
  // Recorded, never compared (§10.5 rule 3).
  observed.recorded_ci_exit_code = runResult.ciExitCode ?? null;
  observed.recorded_exit_code = runSummary?.product_cli?.exit_code ?? runSummary?.exit_code ?? null;
  evidenceRefs.push({
    field: "run_status",
    path: path.relative(args.scenarioRoot, runResultPath),
    sha256: prefixed(runResultBound.actual),
    json_pointer: "/runStatus",
  });

  /* --- §10.5 rule 2: findings only from report.json --- */
  if (reportBound && reportBound.ok) {
    const report = maybeReadJson(reportPath);
    const findings = report?.result?.findings ?? null;
    if (Array.isArray(findings)) {
      observed.finding_types = findings.map((f) => f?.type ?? null);
      observed.finding_events = findings.map((f) => f?.detail?.event ?? null);
      observed.finding_count = findings.length;
      evidenceRefs.push({
        field: "finding_types",
        path: path.relative(args.scenarioRoot, reportPath),
        sha256: prefixed(reportBound.actual),
        json_pointer: "/result/findings",
      });
    }
  }
  // "not stated" is not "none": finding_types stays null when report.json is absent.

  /* ---------------------------- verdict ---------------------------- */
  // §10.5 rule 6 — forbidden status forces disagree regardless of anything else.
  if ((expectedPublic.forbidden_run_status ?? []).includes(observed.run_status)) {
    sub.push("forbidden_run_status_observed");
    return emit("disagree", CLASSIFICATIONS.DISAGREEMENT);
  }

  let operational = false;
  if (expectedPublic.operation_state !== null && observed.operation_state !== expectedPublic.operation_state) {
    sub.push("operation_state_mismatch");
    operational = true;
  }
  if (expectedPublic.response_status !== null && observed.response_status !== expectedPublic.response_status) {
    sub.push("response_status_mismatch");
    operational = true;
  }

  let disagree = false;
  if (expectedPublic.run_status !== null && observed.run_status !== expectedPublic.run_status) {
    sub.push("run_status_mismatch");
    if (observed.run_status === "tool_error_non_blocking") sub.push("unexpected_failure_class");
    disagree = true;
  }

  // Finding-set discipline (§7.1), only where the product was expected to report.
  if (expectedPublic.product_reported === true) {
    const required = expectedPublic.required_finding_types ?? [];
    const permitted = expectedPublic.permitted_additional_types ?? [];
    const types = observed.finding_types;
    if (types === null) {
      sub.push("finding_types_not_stated");
      disagree = true;
    } else {
      for (const r of required) {
        if (!types.includes(r)) {
          sub.push(`required_finding_type_absent:${r}`);
          disagree = true;
        }
      }
      const allowed = new Set([...required, ...permitted]);
      for (const t of new Set(types)) {
        if (!allowed.has(t)) {
          sub.push(`finding_type_outside_allowlist:${t}`);
          disagree = true;
        }
      }
      if (expectedPublic.max_finding_count !== null && types.length > expectedPublic.max_finding_count) {
        sub.push("finding_count_over_bound");
        disagree = true;
      }
      if (expectedPublic.target_event !== null && required.length > 0) {
        const idx = types.indexOf(required[0]);
        const namedEvent = idx === -1 ? null : observed.finding_events[idx];
        if (namedEvent === null || namedEvent === undefined) {
          sub.push("target_event_not_stated_by_product");
        } else if (namedEvent !== expectedPublic.target_event) {
          // A named counterpart is legible as a labelling question, not a bare
          // mismatch (§8, QLB-EXT-003) — but it is still a disagreement.
          sub.push(
            namedEvent === "quote_requested_one" && expectedPublic.target_event === "quote_requested_three"
              ? "target_event_counterpart"
              : "target_event_mismatch",
          );
          disagree = true;
        }
      }
    }
    if (expectedPublic.requires_inconclusive_reason === true) {
      const hasReason =
        (typeof observed.inconclusive_reason === "string" && observed.inconclusive_reason.length > 0) ||
        (typeof observed.collector_health === "string" && observed.collector_health.length > 0);
      if (!hasReason) {
        sub.push("inconclusive_reason_absent");
        disagree = true;
      }
    }
  }

  // Refusal-specific assertions (QLB-EXT-005).
  if (expectedPublic.not_run_reason !== null && observed.not_run_reason !== expectedPublic.not_run_reason) {
    sub.push("not_run_reason_mismatch");
    disagree = true;
  }
  if (expectedPublic.envelope_error_code !== null && observed.envelope_error_code !== expectedPublic.envelope_error_code) {
    sub.push("envelope_error_code_mismatch");
    disagree = true;
  }
  if (expectedPublic.envelope_error_owner !== null && observed.envelope_error_owner !== expectedPublic.envelope_error_owner) {
    sub.push("envelope_error_owner_mismatch");
    disagree = true;
  }
  if (expectedPublic.diagnostic_names_field !== null) {
    const msg = observed.customer_visible_message ?? "";
    if (!msg.includes(expectedPublic.diagnostic_names_field)) {
      sub.push("refusal_diagnostic_unspecific");
      disagree = true;
    }
  }
  if (Array.isArray(expectedPublic.present_artifacts)) {
    for (const a of expectedPublic.present_artifacts) {
      if (!observed.artifacts_present.includes(a)) {
        sub.push(`expected_artifact_absent:${a}`);
        disagree = true;
      }
    }
  }
  if (Array.isArray(expectedPublic.absent_artifacts)) {
    observed.artifacts_absent = expectedPublic.absent_artifacts.filter(
      (a) => !observed.artifacts_present.includes(a),
    );
    for (const a of expectedPublic.absent_artifacts) {
      if (observed.artifacts_present.includes(a)) {
        sub.push(`expected_absent_artifact_present:${a}`);
        disagree = true;
      }
    }
  }

  if (disagree) return emit("disagree", CLASSIFICATIONS.DISAGREEMENT);
  if (operational) return emit("disagree", CLASSIFICATIONS.ADAPTER_OPERATIONAL);
  return emit(
    "agree",
    expectation.classification === CLASSIFICATIONS.REFUSAL_EXPECTED
      ? CLASSIFICATIONS.REFUSAL_EXPECTED
      : CLASSIFICATIONS.AGREEMENT,
  );
}

await main();
