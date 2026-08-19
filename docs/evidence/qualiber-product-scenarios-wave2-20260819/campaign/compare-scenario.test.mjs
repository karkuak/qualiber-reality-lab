#!/usr/bin/env node
/**
 * compare-scenario.test.mjs — TASK-LOCAL CAMPAIGN EVIDENCE TOOLING.
 *
 * MUST NOT be promoted into Reality Lab packages or into Qualiber. Retained as
 * source inside the campaign evidence bundle (plan revision 4.3 §13).
 *
 * Runs compare-scenario.mjs as a subprocess against hand-built fixtures. It
 * needs no observation and no Qualiber execution, which is why it can run before
 * `oracle-precommit.json` binds the comparator's digest (§19 step 0a).
 *
 * Coverage required by revision 4.3 §19 step 0a / §21:
 *   T1  four-step retained response-envelope bind, all four steps passing
 *   T2  /error/code mutated while `core_hash` keeps its stale declared value
 *   T3  --dependency-anchor resolution path (the happy case)
 *   T4  hard exit when the anchor is missing
 *   T5  hard exit when a package is unresolvable through the anchor
 *   T6  `state` and `response_status` read as SEPARATE fields
 *   T7  missing run-result.json yields `unavailable`, never `clean`
 *   T8  no branch reads a process exit code (behavioural + source scan)
 *   T9  finding-set bounds: allowlist and count
 *   T10 NC-1 mode accepts only a digest-bound precommitted counterfactual
 *   T11 a mutated expectation does not reach comparison at all (the NC-1b gate)
 *   T12 retained_output_refs mismatch refuses (the NC-4 mechanism)
 *
 * Usage: node compare-scenario.test.mjs --dependency-anchor <…/package.json>
 *        [--result <tooling-test-result.json>]
 */
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const COMPARATOR = path.join(HERE, "compare-scenario.mjs");

const argv = process.argv.slice(2);
let ANCHOR = null;
let RESULT_PATH = null;
let RETAIN_FIXTURES = null;
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === "--dependency-anchor") ANCHOR = argv[++i];
  else if (argv[i] === "--result") RESULT_PATH = argv[++i];
  else if (argv[i] === "--retain-fixtures") RETAIN_FIXTURES = argv[++i];
}
if (!ANCHOR) {
  process.stderr.write("compare-scenario.test: --dependency-anchor is required\n");
  process.exit(2);
}

const req = createRequire(ANCHOR);
const { coreHash } = await import(pathToFileURL(req.resolve("@erl2/integrity")).href);

const sha = (b) => createHash("sha256").update(b).digest("hex");
const pre = (h) => `sha256:${h}`;
const OPID = "interact-validation-stimulus";

/**
 * UUIDv7. The envelope schema pins `execution_id` to the v7 pattern, so a v4
 * fixture is rejected at step 2 — which is the schema check doing its job.
 */
function uuidv7() {
  const bytes = randomBytes(16);
  const ms = BigInt(Date.now());
  for (let i = 0; i < 6; i += 1) bytes[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  bytes[6] = 0x70 | (bytes[6] & 0x0f);
  bytes[8] = 0x80 | (bytes[8] & 0x3f);
  const h = bytes.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const FULL_PRODUCT_SET = [
  "run-result.json", "report.json", "report.md", "report.junit.xml",
  "evidence-pack.json", "validation-evidence-pack.json",
];

function writeFile(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return content;
}
function writeJson(p, obj) {
  return writeFile(p, `${JSON.stringify(obj, null, 2)}\n`);
}
function frozen(absPath, logicalPath) {
  const bytes = fs.readFileSync(absPath);
  writeFile(`${absPath}.frozen`, `${JSON.stringify({
    byte_length: bytes.length, classification: "INTERNAL",
    file_sha256: pre(sha(bytes)), logical_path: logicalPath, media_type: "application/json",
  })}\n`);
}

/**
 * Builds a complete, internally consistent scenario fixture plus the four
 * campaign files the comparator binds against. Every digest is computed from
 * the bytes actually written, so a fixture cannot drift from what it claims.
 */
function buildFixture(root, opts = {}) {
  const o = {
    scenario: "QLB-EXT-002",
    runStatus: "rule_violation_detected",
    notRunReason: null,
    inconclusiveReason: null,
    collectorHealth: "healthy",
    customerVisibleMessage: "1 telemetry rule violation detected (advisory; CI not affected).",
    ciExitCode: 0,
    findings: [{ type: "missing_required_event", detail: { event: "quote_requested_zero" } }],
    state: "completed",
    responseStatus: "supported",
    envelopeError: null,
    productFiles: FULL_PRODUCT_SET,
    omitRunResult: false,
    breakRetainedRef: false,
    mutateEnvelopeCodeKeepingStaleHash: false,
    expectation: null,
    counterfactual: null,
    tamperExpectationAfterPrecommit: false,
    ...opts,
  };

  const store = path.join(root, "run-output", "store");
  const qualiber = path.join(store, "local-observation-output", OPID, "qualiber");
  const productOut = path.join(qualiber, "product-out");

  /* ---- mounted inputs ---- */
  const stimulusBytes = writeFile(path.join(root, "input", "stimulus.json"),
    `${JSON.stringify({ schema_version: "erl2-capture-stimulus/v1", journey_id: "erl2_ext_journey", requests: [] }, null, 2)}\n`);
  const contractBytes = writeFile(path.join(root, "input", "contract.json"),
    `${JSON.stringify({ rule_id: "erl2_ext_journey", journey_id: "erl2_ext_journey", expected_path: ["a"] }, null, 2)}\n`);
  writeFile(path.join(root, "run-output", "inputs", "capture-stimulus", "stimulus.json"), stimulusBytes);
  writeFile(path.join(root, "run-output", "inputs", "contract-stimulus", "contract.json"), contractBytes);
  const capDigest = sha(stimulusBytes);
  const conDigest = sha(contractBytes);

  /* ---- product artifacts ---- */
  const present = o.productFiles.filter((f) => !(o.omitRunResult && f === "run-result.json"));
  for (const f of present) {
    if (f === "run-result.json") {
      writeJson(path.join(productOut, f), {
        runStatus: o.runStatus,
        ...(o.collectorHealth === null ? {} : { collectorHealth: o.collectorHealth }),
        ...(o.notRunReason === null ? {} : { notRunReason: o.notRunReason }),
        ...(o.inconclusiveReason === null ? {} : { inconclusiveReason: o.inconclusiveReason }),
        findingCount: o.findings ? o.findings.length : 0,
        ciExitCode: o.ciExitCode,
        blocking: false,
        customerVisibleMessage: o.customerVisibleMessage,
      });
    } else if (f === "report.json") {
      if (o.findings === null) continue; // absent report.json → types are null
      writeJson(path.join(productOut, f), {
        run: { journeyId: "erl2_ext_journey" },
        result: { validationStatus: o.runStatus, collectorHealth: o.collectorHealth, findings: o.findings },
      });
    } else {
      writeFile(path.join(productOut, f), `fixture ${f}\n`);
    }
  }

  writeJson(path.join(qualiber, "capture.json"), { schemaVersion: "fixture", events: [] });
  writeJson(path.join(qualiber, "stimulus-identity.json"), {
    schema_version: "qualiber-erl2-validation-stimulus-identity/v1",
    capture_stimulus: { mount: "capture-stimulus", file: "stimulus.json", sha256: pre(capDigest), byte_length: stimulusBytes.length },
    contract_stimulus: { mount: "contract-stimulus", file: "contract.json", sha256: pre(conDigest), byte_length: contractBytes.length },
  });

  /* ---- adapter artifact_hashes: capture + identity + product-out/**, nothing else ---- */
  const hashes = {};
  for (const rel of ["capture.json", "stimulus-identity.json"]) {
    hashes[`qualiber/${rel}`] = pre(sha(fs.readFileSync(path.join(qualiber, rel))));
  }
  for (const f of fs.readdirSync(productOut).filter((x) => !x.endsWith(".frozen")).sort()) {
    hashes[`qualiber/product-out/${f}`] = pre(sha(fs.readFileSync(path.join(productOut, f))));
  }
  writeJson(path.join(qualiber, "run-summary.json"), {
    schema_version: "qualiber-erl2-validation-run-summary/v1",
    run_id: "fixture-run",
    journey_id: "erl2_ext_journey",
    product_cli: { exit_code: o.ciExitCode, run_status: o.runStatus, completed: o.runStatus !== "not_run" },
    artifact_hashes: hashes,
    subject_role: "fixture",
  });

  /* ---- .frozen sidecars + retained_output_refs from the bytes on disk ---- */
  const refs = [];
  const addRef = (abs) => {
    const logical = path.relative(store, abs).split(path.sep).join("/");
    frozen(abs, logical);
    const bytes = fs.readFileSync(abs);
    refs.push({ path: logical, media_type: "application/json", byte_length: bytes.length, file_sha256: pre(sha(bytes)), classification: "INTERNAL" });
  };
  for (const rel of ["capture.json", "stimulus-identity.json", "run-summary.json"]) addRef(path.join(qualiber, rel));
  for (const f of fs.readdirSync(productOut).filter((x) => !x.endsWith(".frozen")).sort()) addRef(path.join(productOut, f));
  if (o.breakRetainedRef) {
    const target = refs.find((r) => r.path.endsWith("product-out/run-result.json")) ?? refs[0];
    target.file_sha256 = pre(sha(Buffer.from("a different scenario's bytes")));
  }

  /* ---- response envelope + four-step bind material ---- */
  const envDir = path.join(store, "retained", "local-observation-adapter", OPID);
  const requestCoreHash = pre(sha(Buffer.from("fixture-request")));
  let envelope = {
    active_operator_ms: 175,
    compensation_receipt_hashes: [],
    credential_use_receipt_hashes: [],
    diagnostics_manifest_hash: pre(sha(Buffer.from("fixture-diagnostics"))),
    execution_id: uuidv7(),
    execution_mode: "local_observation",
    mutation_receipt_hashes: [],
    operation: "interact",
    operation_id: OPID,
    protocol_version: "subject-adapter/v2",
    request_core_hash: requestCoreHash,
    responded_at: "2026-08-18T00:00:00Z",
    schema_version: "adapter-response-envelope/v2",
    status: o.responseStatus,
    unsupported_inputs: [],
  };
  if (o.envelopeError) envelope.error = o.envelopeError;
  else {
    envelope.result_core_hash = pre(sha(Buffer.from("fixture-result")));
    envelope.result_schema_version = "qualiber-erl2-validation-interaction/v1";
  }
  const honestCoreHash = coreHash(envelope);
  envelope.core_hash = honestCoreHash;
  if (o.mutateEnvelopeCodeKeepingStaleHash) {
    // The exact revision-4 hole: change /error/code, keep the original declared
    // core_hash. Only the recompute at step 3 catches this.
    envelope = { ...envelope, error: { ...envelope.error, code: "SUBJECT_CAPTURE_STIMULUS_MALFORMED" }, core_hash: honestCoreHash };
  }
  const envPath = path.join(envDir, "response-envelope.json");
  writeFile(envPath, `${JSON.stringify(envelope)}\n`);
  frozen(envPath, path.relative(store, envPath).split(path.sep).join("/"));

  /* ---- record, sealed plan, campaign index ---- */
  const observationId = uuidv7();
  const planSealed = {
    schema_version: "local-observation-plan/v1",
    observation_id: observationId,
    inputs: [
      { input_id: "capture-stimulus-input", role: "capture-stimulus", provenance_mode: "host_provisioned",
        artifact: { path: "observation-inputs/capture-stimulus/stimulus.json", media_type: "application/json", byte_length: stimulusBytes.length, file_sha256: pre(capDigest), classification: "INTERNAL" } },
      { input_id: "contract-stimulus-input", role: "contract-stimulus", provenance_mode: "host_provisioned",
        artifact: { path: "observation-inputs/contract-stimulus/contract.json", media_type: "application/json", byte_length: contractBytes.length, file_sha256: pre(conDigest), classification: "INTERNAL" } },
    ],
  };
  planSealed.core_hash = coreHash(planSealed);
  writeJson(path.join(root, "plan", "plan-sealed.json"), planSealed);

  const adapterArtifactHash = pre(sha(Buffer.from("fixture-adapter-artifact")));
  writeJson(path.join(root, "run-output", "trusted-local-observation-record.json"), {
    schema_version: "trusted-local-observation-record/v1",
    observation_id: observationId,
    plan_hash: planSealed.core_hash,
    adapter_artifact_hash: adapterArtifactHash,
    // Recorded here on purpose: the comparator must never read it to classify.
    terminal_status: "observed_complete",
    operation_outcomes: [
      { sequence: 0, operation_id: OPID, operation: "interact", state: o.state,
        request_hash: requestCoreHash, response_envelope_hash: honestCoreHash, response_status: o.responseStatus },
      { sequence: 1, operation_id: "report-residue-final", operation: "report-residue", state: "completed",
        request_hash: pre(sha(Buffer.from("residue"))), response_envelope_hash: pre(sha(Buffer.from("residue-env"))), response_status: "supported" },
    ],
    operation_records: [
      { schema_version: "local-observation-operation-record/v1", operation: "interact", operation_id: OPID, state: "declared" },
      { schema_version: "local-observation-operation-record/v1", operation: "interact", operation_id: OPID, state: "dispatched" },
      { schema_version: "local-observation-operation-record/v1", operation: "interact", operation_id: OPID,
        state: "completed", response_status: o.responseStatus, response_envelope_hash: honestCoreHash, retained_output_refs: refs },
    ],
    cleanup: { status: "cleanup_complete" },
  });

  /* ---- campaign files ---- */
  const camp = path.join(root, "campaign-files");
  const expectation = o.expectation ?? {
    schema_version: "qualiber-reality-lab/campaign-expectation/v1",
    scenario_id: o.scenario,
    expected_operation_state: "completed",
    expected_response_status: "supported",
    expected_run_status: "rule_violation_detected",
    required_finding_types: ["missing_required_event"],
    permitted_additional_types: [],
    permitted_additional_justification: {},
    target_event: "quote_requested_zero",
    max_finding_count: 1,
    expected_product_reported: true,
  };
  const expectedPath = path.join(camp, "expected.json");
  const expectationBytes = writeJson(expectedPath, expectation);
  const expectationDigest = sha(expectationBytes);

  let counterfactualPath = null;
  let counterfactualDigest = null;
  if (o.counterfactual) {
    counterfactualPath = path.join(camp, "NC-1.counterfactual.expected.json");
    counterfactualDigest = sha(writeJson(counterfactualPath, o.counterfactual));
  }

  writeJson(path.join(camp, "oracle-precommit.json"), {
    schema_version: "qualiber-reality-lab/oracle-precommit/v1",
    campaign: "fixture",
    revision: 1,
    scenarios: [{
      scenario_id: o.scenario,
      capture_stimulus_sha256: pre(capDigest), capture_stimulus_bytes: stimulusBytes.length,
      contract_stimulus_sha256: pre(conDigest), contract_stimulus_bytes: contractBytes.length,
      expectation_sha256: pre(expectationDigest),
      definition: "fixture scenario",
    }],
    negative_controls: counterfactualDigest
      ? [{ control_id: "NC-1", targets_scenario: o.scenario, counterfactual_expectation_sha256: pre(counterfactualDigest), definition: "fixture counterfactual" }]
      : [],
    amendments: [],
  });

  // Resolve the real triples so the fixture lock matches what the comparator finds.
  const resolvedTriples = [];
  for (const name of ["@erl2/contracts", "@erl2/integrity"]) {
    const entry = req.resolve(name);
    let dir = path.dirname(entry);
    let manifest = null;
    for (;;) {
      const c = path.join(dir, "package.json");
      if (fs.existsSync(c)) { const j = JSON.parse(fs.readFileSync(c, "utf8")); if (j.name) { manifest = j; break; } }
      const up = path.dirname(dir); if (up === dir) break; dir = up;
    }
    resolvedTriples.push({ name: manifest.name, version: manifest.version, entry_sha256: pre(sha(fs.readFileSync(entry))) });
  }
  writeJson(path.join(camp, "execution-lock.json"), {
    schema_version: "qualiber-reality-lab/execution-lock/v1",
    campaign: "fixture",
    oracle_precommit_revision: 1,
    adapter: { artifact_sha256: adapterArtifactHash, manifest_sha256: pre(sha(Buffer.from("fixture-manifest"))) },
    comparator_dependencies: { anchor: "adapters/erl2-subject/package.json", resolved: resolvedTriples },
    amendments: [],
  });
  writeJson(path.join(camp, "campaign-index.json"), {
    schema_version: "qualiber-reality-lab/campaign-index/v1",
    scenarios: [{ scenario_id: o.scenario, observation_id: observationId, sealed_plan_core_hash: planSealed.core_hash }],
  });

  if (o.tamperExpectationAfterPrecommit) {
    // NC-1b in miniature: edit the expectation in place AFTER the precommit
    // bound its digest.
    const tampered = { ...expectation, expected_run_status: "clean" };
    writeJson(expectedPath, tampered);
  }

  return { root, camp, expectedPath, counterfactualPath, scenario: o.scenario, observationId };
}

function runComparator({ fixture, anchor = ANCHOR, expected = null, nc1 = false, omitAnchor = false }) {
  const out = path.join(fixture.root, "comparison", `comparison${nc1 ? "-nc1" : ""}.json`);
  const args = [
    COMPARATOR,
    "--scenario", fixture.scenario,
    "--scenario-root", fixture.root,
    "--expected", expected ?? fixture.expectedPath,
    "--oracle-precommit", path.join(fixture.camp, "oracle-precommit.json"),
    "--execution-lock", path.join(fixture.camp, "execution-lock.json"),
    "--campaign-index", path.join(fixture.camp, "campaign-index.json"),
    "--output", out,
  ];
  if (!omitAnchor) args.push("--dependency-anchor", anchor);
  if (nc1) args.push("--nc1-mode");
  const r = spawnSync(process.execPath, args, { encoding: "utf8" });
  let comparison = null;
  try { comparison = JSON.parse(fs.readFileSync(out, "utf8")); } catch { comparison = null; }
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", comparison };
}

/* ------------------------------- runner ------------------------------- */
const results = [];
let failures = 0;
// With --retain-fixtures the hand-built inputs are written where they can be
// published as reviewable bytes instead of into a temp dir that is deleted.
const TMP = RETAIN_FIXTURES
  ? (fs.rmSync(RETAIN_FIXTURES, { recursive: true, force: true }), fs.mkdirSync(RETAIN_FIXTURES, { recursive: true }), RETAIN_FIXTURES)
  : fs.mkdtempSync(path.join(os.tmpdir(), "qlb-comparator-tests-"));

function test(name, fn) {
  const checks = [];
  const assert = (ok, detail) => { checks.push({ ok: Boolean(ok), detail }); if (!ok) throw new Error(`assertion failed: ${detail}`); };
  let passed = true;
  let error = null;
  try { fn({ assert, dir: (n) => path.join(TMP, `${results.length}-${n}`) }); }
  catch (err) { passed = false; error = err.message; failures += 1; }
  results.push({ name, passed, error, checks: checks.map((c) => c.detail) });
  process.stdout.write(`${passed ? "ok  " : "FAIL"}  ${name}${error ? ` — ${error}` : ""}\n`);
}

/* T1 — four-step envelope bind, all four passing (the 005 shape). */
test("T1 four-step response-envelope bind passes on honest bytes", ({ assert, dir }) => {
  const f = buildFixture(dir("t1"), {
    scenario: "QLB-EXT-005", runStatus: "not_run", notRunReason: "config_invalid", collectorHealth: null,
    customerVisibleMessage: "contract health check refused: expected_path is required",
    findings: null, productFiles: ["run-result.json"], responseStatus: "failed",
    envelopeError: { code: "SUBJECT_PRODUCT_CLI_REFUSED", owner: "subject", safe_message: "refused: expected_path missing" },
    expectation: {
      schema_version: "qualiber-reality-lab/campaign-expectation/v1", scenario_id: "QLB-EXT-005",
      expected_operation_state: "completed", expected_response_status: "failed",
      expected_envelope_error_code: "SUBJECT_PRODUCT_CLI_REFUSED", expected_envelope_error_owner: "subject",
      expected_run_status: "not_run", expected_not_run_reason: "config_invalid",
      expected_diagnostic_names_field: "expected_path",
      expected_present_artifacts: ["run-result.json"],
      expected_absent_artifacts: ["report.json", "report.md", "report.junit.xml", "evidence-pack.json", "validation-evidence-pack.json"],
      expected_product_reported: false, classification: "product_refusal_expected",
    },
  });
  const r = runComparator({ fixture: f });
  assert(r.status === 0, `exit 0, got ${r.status} (${r.stderr})`);
  assert(r.comparison.binding.response_envelope_bytes_matched === true, "step 1 bytes matched");
  assert(r.comparison.binding.response_envelope_schema_valid === true, "step 2 schema valid");
  assert(typeof r.comparison.binding.response_envelope_core_hash_recomputed === "string", "step 3 recomputed");
  assert(r.comparison.binding.response_envelope_core_hash_matched === true, "step 4 three-way identity");
  assert(r.comparison.binding.response_envelope_file_sha256 !== r.comparison.binding.response_envelope_record_hash,
    "file sha256 and record core_hash are different values (never compared to each other)");
  assert(r.comparison.observed.envelope_error_code === "SUBJECT_PRODUCT_CLI_REFUSED", "error code read from envelope");
  assert(r.comparison.verdict === "agree", `verdict agree, got ${r.comparison.verdict}`);
  assert(r.comparison.classification === "product_refusal_expected", `classification product_refusal_expected, got ${r.comparison.classification}`);
});

/* T2 — the revision-4 hole: mutated /error/code, stale declared core_hash. */
test("T2 mutated /error/code with stale core_hash is refused at step 4", ({ assert, dir }) => {
  const f = buildFixture(dir("t2"), {
    scenario: "QLB-EXT-005", runStatus: "not_run", notRunReason: "config_invalid", collectorHealth: null,
    customerVisibleMessage: "contract health check refused: expected_path is required",
    findings: null, productFiles: ["run-result.json"], responseStatus: "failed",
    envelopeError: { code: "SUBJECT_PRODUCT_CLI_REFUSED", owner: "subject", safe_message: "refused: expected_path missing" },
    mutateEnvelopeCodeKeepingStaleHash: true,
    expectation: {
      schema_version: "qualiber-reality-lab/campaign-expectation/v1", scenario_id: "QLB-EXT-005",
      expected_operation_state: "completed", expected_response_status: "failed",
      expected_envelope_error_code: "SUBJECT_PRODUCT_CLI_REFUSED", expected_envelope_error_owner: "subject",
      expected_run_status: "not_run", expected_not_run_reason: "config_invalid",
      expected_diagnostic_names_field: "expected_path", expected_product_reported: false,
      classification: "product_refusal_expected",
    },
  });
  const r = runComparator({ fixture: f });
  assert(r.comparison.binding.response_envelope_bytes_matched === true, "step 1 still passes — the sidecar travelled with the file");
  assert(r.comparison.binding.response_envelope_schema_valid === true, "step 2 still passes — it is still a valid envelope");
  assert(r.comparison.binding.response_envelope_core_hash_matched === false, "step 4 refuses");
  assert(r.comparison.sub_reasons.includes("response_envelope_core_hash_binding_failed"), "named sub_reason");
  assert(r.comparison.verdict === "unavailable", `unavailable, got ${r.comparison.verdict}`);
  assert(r.comparison.classification === "lab_harness_failure", `lab_harness_failure, got ${r.comparison.classification}`);
});

/* T3 — the anchor resolution path itself. */
test("T3 --dependency-anchor resolves both Lab packages and records triples", ({ assert, dir }) => {
  const f = buildFixture(dir("t3"));
  const r = runComparator({ fixture: f });
  assert(r.status === 0, `exit 0, got ${r.status}`);
  const names = r.comparison.comparator_dependencies_resolved.map((d) => d.name).sort();
  assert(names.join(",") === "@erl2/contracts,@erl2/integrity", `both resolved, got ${names.join(",")}`);
  assert(r.comparison.binding.dependency_triples_matched === true, "triples match the lock");
  assert(!JSON.stringify(r.comparison).includes(path.sep + "node_modules" + path.sep),
    "no absolute dependency path leaks into comparison.json");
});

/* T4 — missing anchor is a hard exit, not a verdict. */
test("T4 missing --dependency-anchor is a hard tooling exit, not a verdict", ({ assert, dir }) => {
  const f = buildFixture(dir("t4"));
  const r = runComparator({ fixture: f, omitAnchor: true });
  assert(r.status === 3, `exit 3, got ${r.status}`);
  assert(r.comparison === null, "no comparison.json written");
  assert(/not a verdict/.test(r.stderr), "stderr says it is not a verdict");
  const r2 = runComparator({ fixture: f, anchor: path.join(f.root, "no-such-package.json") });
  assert(r2.status === 3, `exit 3 for nonexistent anchor, got ${r2.status}`);
});

/* T5 — anchor that cannot resolve the packages is a hard exit. */
test("T5 unresolvable package through the anchor is a hard tooling exit", ({ assert, dir }) => {
  const f = buildFixture(dir("t5"));
  const lonely = path.join(f.root, "lonely", "package.json");
  writeJson(lonely, { name: "lonely-anchor", version: "0.0.0" });
  const r = runComparator({ fixture: f, anchor: lonely });
  assert(r.status === 3, `exit 3, got ${r.status}`);
  // The assertion detail is deliberately path-free: it is published verbatim in
  // tooling-test-result.json, and an absolute scratch path is not portable evidence.
  assert(/cannot resolve @erl2\//.test(r.stderr), "stderr names the unresolvable package");
  assert(r.comparison === null, "no comparison written");
});

/* T6 — state and response_status are separate fields. */
test("T6 state and response_status are compared as separate fields", ({ assert, dir }) => {
  // A completed record carrying the adapter's own `failed` verdict, where the
  // expectation wanted `supported`: the record state alone must not save it.
  const f = buildFixture(dir("t6"), {
    responseStatus: "failed",
    envelopeError: { code: "SUBJECT_PRODUCT_CLI_REFUSED", owner: "subject", safe_message: "x" },
  });
  const r = runComparator({ fixture: f });
  assert(r.comparison.observed.operation_state === "completed", "state read as completed");
  assert(r.comparison.observed.response_status === "failed", "response_status read as failed");
  assert(r.comparison.sub_reasons.includes("response_status_mismatch"), "response_status mismatch named");
  assert(!r.comparison.sub_reasons.includes("operation_state_mismatch"), "state itself agreed");
  assert(r.comparison.verdict === "disagree", `disagree, got ${r.comparison.verdict}`);
  assert(r.comparison.classification === "adapter_operational_failure",
    `adapter_operational_failure, got ${r.comparison.classification}`);
  assert(r.comparison.observed.terminal_status_recorded_not_used === "observed_complete",
    "terminal_status recorded for the reader but not used to classify");
});

/* T7 — missing run-result.json is unavailable, never clean. */
test("T7 missing run-result.json yields unavailable and never clean", ({ assert, dir }) => {
  const f = buildFixture(dir("t7"), { omitRunResult: true });
  const r = runComparator({ fixture: f });
  assert(r.comparison.verdict === "unavailable", `unavailable, got ${r.comparison.verdict}`);
  assert(r.comparison.classification === "unavailable", `classification unavailable, got ${r.comparison.classification}`);
  assert(r.comparison.observed.run_status === null, "run_status stays null");
  assert(!JSON.stringify(r.comparison.observed).includes('"clean"'), "the string clean never appears as an observed value");
  assert(r.comparison.sub_reasons.includes("run_result_absent_or_unbound"), "named sub_reason");
});

/* T8 — no branch reads an exit code. */
test("T8 no branch reads a process exit code", ({ assert, dir }) => {
  // Behavioural: a nonzero recorded exit code with agreeing semantics still agrees.
  const f = buildFixture(dir("t8"), { ciExitCode: 9 });
  const r = runComparator({ fixture: f });
  assert(r.comparison.observed.recorded_ci_exit_code === 9, "exit code is recorded");
  assert(r.comparison.verdict === "agree", `still agrees despite exit 9, got ${r.comparison.verdict}`);
  // Source scan: no comparison operator is applied to any exit-code identifier.
  const src = fs.readFileSync(COMPARATOR, "utf8");
  const offending = src.split("\n").map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => /exit_?[Cc]ode|ciExitCode|exitCode/.test(line))
    .filter(({ line }) => /(===|!==|==|!=|>=|<=|[^=!<>]>[^=]|[^=!<>]<[^=])/.test(line.replace(/^\s*\/\/.*$/, "")))
    .filter(({ line }) => !/^\s*\*/.test(line) && !/^\s*\/\//.test(line));
  assert(offending.length === 0, `no exit-code comparison in source; found: ${offending.map((o) => `L${o.n}`).join(",")}`);
});

/* T9 — finding-set bounds. */
test("T9 finding-set bounds: allowlist and count both enforced", ({ assert, dir }) => {
  const outside = buildFixture(dir("t9a"), {
    findings: [
      { type: "missing_required_event", detail: { event: "quote_requested_zero" } },
      { type: "missing_required_property", detail: { event: "quote_requested_zero" } },
    ],
  });
  const ra = runComparator({ fixture: outside });
  assert(ra.comparison.verdict === "disagree", "a type outside required ∪ permitted disagrees");
  assert(ra.comparison.sub_reasons.some((s) => s.startsWith("finding_type_outside_allowlist:")), "names the offending type");
  assert(ra.comparison.sub_reasons.includes("finding_count_over_bound"), "count bound also breached");
  assert(ra.comparison.classification === "product_disagreement", "published as a product disagreement");
  // Target-event mismatch is legible as the counterpart case.
  const counterpart = buildFixture(dir("t9b"), {
    scenario: "QLB-EXT-003",
    findings: [{ type: "wrong_order", detail: { event: "quote_requested_one" } }],
    expectation: {
      schema_version: "qualiber-reality-lab/campaign-expectation/v1", scenario_id: "QLB-EXT-003",
      expected_operation_state: "completed", expected_response_status: "supported",
      expected_run_status: "rule_violation_detected", required_finding_types: ["wrong_order"],
      permitted_additional_types: [], permitted_additional_justification: {},
      target_event: "quote_requested_three", max_finding_count: 1, expected_product_reported: true,
    },
  });
  const rb = runComparator({ fixture: counterpart });
  assert(rb.comparison.sub_reasons.includes("target_event_counterpart"), "counterpart sub_reason used");
  assert(rb.comparison.verdict === "disagree", "still a disagreement, not silently accepted");
});

/* T10 — NC-1 mode accepts only a precommitted counterfactual. */
test("T10 NC-1 mode accepts only a digest-bound precommitted counterfactual", ({ assert, dir }) => {
  const cf = {
    schema_version: "qualiber-reality-lab/campaign-expectation/v1", scenario_id: "QLB-EXT-003",
    expected_operation_state: "completed", expected_response_status: "supported",
    expected_run_status: "clean", required_finding_types: ["wrong_order"],
    permitted_additional_types: [], permitted_additional_justification: {},
    target_event: "quote_requested_three", max_finding_count: 1, expected_product_reported: true,
  };
  const f = buildFixture(dir("t10"), {
    scenario: "QLB-EXT-003",
    findings: [{ type: "wrong_order", detail: { event: "quote_requested_three" } }],
    expectation: { ...cf, expected_run_status: "rule_violation_detected" },
    counterfactual: cf,
  });
  const good = runComparator({ fixture: f, expected: f.counterfactualPath, nc1: true });
  assert(good.comparison.binding.expectation_digest_matched === true, "counterfactual binds");
  assert(good.comparison.binding.nc1_control_id === "NC-1", "control id recorded");
  assert(good.comparison.verdict === "disagree", `disagree, got ${good.comparison.verdict}`);
  assert(good.comparison.classification === "product_disagreement", `product_disagreement, got ${good.comparison.classification}`);
  assert(good.comparison.sub_reasons.includes("run_status_mismatch"), "reached run_status equality");
  // An arbitrary expectation cannot be smuggled through NC-1 mode.
  const arbitrary = path.join(f.camp, "arbitrary.expected.json");
  writeJson(arbitrary, { ...cf, expected_run_status: "inconclusive" });
  const bad = runComparator({ fixture: f, expected: arbitrary, nc1: true });
  assert(bad.comparison.verdict === "unavailable", "an unbound counterfactual is refused");
  assert(bad.comparison.classification === "lab_harness_failure", "as a harness failure");
  assert(bad.comparison.sub_reasons.includes("counterfactual_not_precommitted"), "named sub_reason");
});

/* T11 — the NC-1b gate: a mutated expectation never reaches comparison. */
test("T11 a mutated expectation is refused before any comparison (NC-1b gate)", ({ assert, dir }) => {
  const f = buildFixture(dir("t11"), { tamperExpectationAfterPrecommit: true });
  const r = runComparator({ fixture: f });
  assert(r.comparison.binding.expectation_digest_matched === false, "digest no longer binds");
  assert(r.comparison.verdict === "unavailable", `unavailable, got ${r.comparison.verdict}`);
  assert(r.comparison.classification === "lab_harness_failure", `lab_harness_failure, got ${r.comparison.classification}`);
  assert(r.comparison.observed.run_status === null, "no semantic read happened");
});

/* T12 — retained_output_refs mismatch refuses (the NC-4 mechanism). */
test("T12 a retained_output_refs digest mismatch refuses before any verdict", ({ assert, dir }) => {
  const f = buildFixture(dir("t12"), { breakRetainedRef: true });
  const r = runComparator({ fixture: f });
  assert(r.comparison.binding.record_retained_output_refs_mismatched.length > 0, "mismatch recorded");
  assert(r.comparison.sub_reasons.includes("retained_output_refs_binding_failed"), "named sub_reason");
  assert(r.comparison.verdict === "unavailable", `unavailable, got ${r.comparison.verdict}`);
  assert(r.comparison.classification === "lab_harness_failure", `lab_harness_failure, got ${r.comparison.classification}`);
  assert(r.comparison.observed.run_status === null, "binding gate ran before semantics");
});

/* ------------------------------ result ------------------------------ */
const comparatorDigest = pre(sha(fs.readFileSync(COMPARATOR)));
const summary = {
  schema_version: "qualiber-reality-lab/tooling-test-result/v1",
  generated_by: "compare-scenario.test.mjs",
  outcome: failures === 0 ? "passed" : "failed",
  test_count: results.length,
  passed_count: results.filter((r) => r.passed).length,
  failed_count: failures,
  // The whole point of recording this: a reader can confirm the comparator that
  // was tested is the one oracle-precommit.json bound, rather than taking it on trust.
  comparator_sha256_tested: comparatorDigest,
  oracle_absence_scan_mjs_sha256: pre(sha(fs.readFileSync(path.join(HERE, "oracle-absence-scan.mjs")))),
  compare_scenario_test_mjs_sha256: pre(sha(fs.readFileSync(new URL(import.meta.url)))),
  // Repository-relative only. The absolute anchor path on this machine is not
  // portable evidence and lives in the command log, per §10.3.1's reasoning.
  dependency_anchor_used: "adapters/erl2-subject/package.json",
  dependency_anchor_absolute_recorded_in_command_log_only: true,
  tests: results,
};
process.stdout.write(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILED`} — ${results.length} tests\n`);
process.stdout.write(`comparator tested: ${comparatorDigest}\n`);
if (RESULT_PATH) {
  fs.mkdirSync(path.dirname(RESULT_PATH), { recursive: true });
  fs.writeFileSync(RESULT_PATH, `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`result written: ${RESULT_PATH}\n`);
}
if (!RETAIN_FIXTURES) fs.rmSync(TMP, { recursive: true, force: true });
else process.stdout.write(`fixtures retained: ${RETAIN_FIXTURES}\n`);
process.exit(failures === 0 ? 0 : 1);
