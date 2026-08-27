#!/usr/bin/env node
/**
 * test-nc11r-binding.mjs — focused IRD-001 / NC-11R binding + precedence suite.
 *
 * Operates through the REAL comparator (compare-scenario.mjs) and REAL fixture
 * bytes (a clean copy of the committed QLB-EXT-012 scenario), building fixtures
 * with the v2 nc11r-fixture-builder. No test doubles, no Qualiber import.
 *
 * Required environment (all absolute paths — the suite is path-neutral and takes
 * every location from the environment, never from a baked-in path):
 *   NC11R_COMPARATOR      compare-scenario.mjs (digest 83223022…)
 *   NC11R_ANCHOR          real @erl2 dependency anchor package.json
 *   NC11R_SCENARIO_SRC    a clean copy of scenarios/QLB-EXT-012
 *   NC11R_EXECUTION_LOCK  the real campaign execution-lock.json
 *   NC11R_BUILDER         nc11r-fixture-builder.mjs (v2)
 *   NC11R_WORK_A          first scratch root
 *   NC11R_WORK_B          second scratch root (a DIFFERENT absolute path)
 *
 * Proves: (1) the exact runtime binding path is operation_records[interact/
 * completed].retained_output_refs, not result.retained_output_refs; (2) a
 * top-level empty refs array cannot hide a missing operation-record binding;
 * (3) zero matching refs → hard failure; (4) multiple matching refs → hard
 * failure; (5) every intended binding update is reported; (6) positive fixture
 * agrees; (7) NC-11R yields forbidden_run_status_observed; (8) ordinary
 * run_status_mismatch cannot satisfy NC-11R; (9) disabling precedence makes the
 * test red; (10) all through the real comparator + fixture bytes; (11) results
 * are path-neutral across two scratch roots.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const sha256File = (p) => sha256(fs.readFileSync(p));
const bare = (v) => (typeof v === "string" && v.startsWith("sha256:") ? v.slice(7) : v);

const ENV = (k) => {
  const v = process.env[k];
  if (!v) { console.error(`test-nc11r-binding: required env ${k} is unset`); process.exit(2); }
  return v;
};
const COMPARATOR = ENV("NC11R_COMPARATOR");
const ANCHOR = ENV("NC11R_ANCHOR");
const SCENARIO_SRC = ENV("NC11R_SCENARIO_SRC");
const EXECUTION_LOCK = ENV("NC11R_EXECUTION_LOCK");
const BUILDER = ENV("NC11R_BUILDER");
const WORK_A = ENV("NC11R_WORK_A");
const WORK_B = ENV("NC11R_WORK_B");

let PASS = 0, FAIL = 0;
const results = [];
function check(name, cond, detail) {
  if (cond) { PASS++; results.push({ name, ok: true }); console.log(`  PASS  ${name}`); }
  else { FAIL++; results.push({ name, ok: false, detail }); console.log(`  FAIL  ${name}  :: ${detail}`); }
}

function freshCopy(root) {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  const scenario = path.join(root, "scenario-root");
  fs.cpSync(SCENARIO_SRC, scenario, { recursive: true });
  // ensure writable copy
  for (const p of walk(scenario)) fs.chmodSync(p, 0o644);
  return scenario;
}
function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}
function buildFixture(root) {
  const scenario = freshCopy(root);
  const fixtureDir = path.join(root, "fixture");
  execFileSync("node", [BUILDER, "--scenario-root", scenario, "--output-dir", fixtureDir, "--execution-lock", EXECUTION_LOCK],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return { scenario, fixtureDir, record: JSON.parse(fs.readFileSync(path.join(fixtureDir, "nc11r-fixture-record.json"), "utf8")) };
}
function runComparator(scenarioRoot, fixtureDir, scenarioId, expectedFile, comparator = COMPARATOR) {
  const out = path.join(fixtureDir, `${scenarioId}.cmp.json`);
  let code = 0, stderr = "";
  try {
    execFileSync("node", [comparator, "--scenario", scenarioId, "--scenario-root", scenarioRoot,
      "--expected", expectedFile,
      "--oracle-precommit", path.join(fixtureDir, "oracle-precommit.json"),
      "--execution-lock", path.join(fixtureDir, "execution-lock.json"),
      "--campaign-index", path.join(fixtureDir, "campaign-index.json"),
      "--dependency-anchor", ANCHOR, "--output", out],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) { code = e.status ?? 1; stderr = (e.stderr ?? "").toString(); }
  const parsed = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, "utf8")) : null;
  return { code, stderr, parsed };
}
const findInteractCompleted = (rec) =>
  (rec.operation_records ?? []).find((r) => r.operation === "interact" && r.state === "completed") ?? null;

console.log("NC-11R binding + forbidden-precedence focused suite\n");

// ---- Build the canonical fixture in root A --------------------------------
const A = buildFixture(WORK_A);
const idPositive = "NC-11R-POSITIVE-BOUND-CONTROL";
const idForbidden = "NC-11R-FORBIDDEN-PRECEDENCE";
const idMutation = "NC-11R-MUTATION-NO-FORBIDDEN";
const expA = (id) => path.join(A.fixtureDir, "expectations", `${id}.expected.json`);

// T1 — the runtime binding path is operation_records[interact/completed].refs, and
// top-level result.retained_output_refs is empty (the layer IRD-001 inspected).
{
  const rec = JSON.parse(fs.readFileSync(path.join(A.scenario, "run-output", "trusted-local-observation-record.json"), "utf8"));
  const op = findInteractCompleted(rec);
  const topLevel = rec.result?.retained_output_refs ?? null;
  check("T1 comparator binding source is operation_records[interact/completed].retained_output_refs (>0 refs)",
    !!op && Array.isArray(op.retained_output_refs) && op.retained_output_refs.length > 0,
    JSON.stringify(op && op.retained_output_refs?.length));
  check("T1 top-level result.retained_output_refs is empty (the layer IRD-001 inspected)",
    Array.isArray(topLevel) && topLevel.length === 0, JSON.stringify(topLevel));
}

// T2 — an empty top-level refs array cannot hide a missing operation-record binding:
// the run-result ref in the operation record actually tracks the mutated digest.
{
  const rec = JSON.parse(fs.readFileSync(path.join(A.scenario, "run-output", "trusted-local-observation-record.json"), "utf8"));
  const op = findInteractCompleted(rec);
  const rr = op.retained_output_refs.find((r) => r.path.endsWith("product-out/run-result.json"));
  const rrAbs = path.join(A.scenario, "run-output", "store", rr.path.split("/").join(path.sep));
  check("T2 operation-record run-result ref == mutated file digest (binding is real, not hidden by empty top-level)",
    bare(rr.file_sha256) === sha256File(rrAbs) && A.record.run_result_modified_status === "inconclusive",
    `${rr.file_sha256} vs ${sha256File(rrAbs)}`);
}

// T3 — zero matching refs → hard tooling failure. Corrupt the copy so run-result
// ref path won't match, then the builder must exit non-zero (fail-closed).
{
  const root = path.join(WORK_A, "..", "nc11r-zero-match");
  fs.rmSync(root, { recursive: true, force: true }); fs.mkdirSync(root, { recursive: true });
  const scenario = path.join(root, "scenario-root");
  fs.cpSync(SCENARIO_SRC, scenario, { recursive: true });
  for (const p of walk(scenario)) fs.chmodSync(p, 0o644);
  const recPath = path.join(scenario, "run-output", "trusted-local-observation-record.json");
  const rec = JSON.parse(fs.readFileSync(recPath, "utf8"));
  const op = findInteractCompleted(rec);
  op.retained_output_refs = op.retained_output_refs.filter((r) => !r.path.endsWith("product-out/run-result.json"));
  fs.writeFileSync(recPath, JSON.stringify(rec, null, 2) + "\n");
  let failed = false, msg = "";
  try { execFileSync("node", [BUILDER, "--scenario-root", scenario, "--output-dir", path.join(root, "fixture"), "--execution-lock", EXECUTION_LOCK], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e) { failed = true; msg = (e.stderr ?? "").toString(); }
  check("T3 zero matching run-result refs → builder hard-fails", failed && /exactly one run-result|updated 0 times/.test(msg), msg.split("\n")[0] || "no failure");
}

// T4 — multiple matching refs → hard tooling failure (duplicate run-result ref).
{
  const root = path.join(WORK_A, "..", "nc11r-multi-match");
  fs.rmSync(root, { recursive: true, force: true }); fs.mkdirSync(root, { recursive: true });
  const scenario = path.join(root, "scenario-root");
  fs.cpSync(SCENARIO_SRC, scenario, { recursive: true });
  for (const p of walk(scenario)) fs.chmodSync(p, 0o644);
  const recPath = path.join(scenario, "run-output", "trusted-local-observation-record.json");
  const rec = JSON.parse(fs.readFileSync(recPath, "utf8"));
  const op = findInteractCompleted(rec);
  const rr = op.retained_output_refs.find((r) => r.path.endsWith("product-out/run-result.json"));
  op.retained_output_refs.push({ ...rr });   // duplicate
  fs.writeFileSync(recPath, JSON.stringify(rec, null, 2) + "\n");
  let failed = false, msg = "";
  try { execFileSync("node", [BUILDER, "--scenario-root", scenario, "--output-dir", path.join(root, "fixture"), "--execution-lock", EXECUTION_LOCK], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e) { failed = true; msg = (e.stderr ?? "").toString(); }
  check("T4 multiple matching run-result refs → builder hard-fails", failed && /exactly one run-result|updated 2 times/.test(msg), msg.split("\n")[0] || "no failure");
}

// T4b — stale run-result .frozen sidecar in the base copy → hard failure.
{
  const root = path.join(WORK_A, "..", "nc11r-stale-sidecar");
  fs.rmSync(root, { recursive: true, force: true }); fs.mkdirSync(root, { recursive: true });
  const scenario = path.join(root, "scenario-root");
  fs.cpSync(SCENARIO_SRC, scenario, { recursive: true });
  for (const p of walk(scenario)) fs.chmodSync(p, 0o644);
  const frozen = walk(scenario).find((p) => p.endsWith("product-out/run-result.json.frozen"));
  const j = JSON.parse(fs.readFileSync(frozen, "utf8"));
  j.file_sha256 = "sha256:" + "0".repeat(64);   // stale
  fs.writeFileSync(frozen, JSON.stringify(j));
  let failed = false, msg = "";
  try { execFileSync("node", [BUILDER, "--scenario-root", scenario, "--output-dir", path.join(root, "fixture"), "--execution-lock", EXECUTION_LOCK], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e) { failed = true; msg = (e.stderr ?? "").toString(); }
  check("T4b stale run-result .frozen sidecar in base copy → builder hard-fails", failed && /stale sidecar/.test(msg), msg.split("\n")[0] || "no failure");
}

// T4c — stale/absent run-summary witness in the base copy → hard failure.
{
  const root = path.join(WORK_A, "..", "nc11r-stale-witness");
  fs.rmSync(root, { recursive: true, force: true }); fs.mkdirSync(root, { recursive: true });
  const scenario = path.join(root, "scenario-root");
  fs.cpSync(SCENARIO_SRC, scenario, { recursive: true });
  for (const p of walk(scenario)) fs.chmodSync(p, 0o644);
  const rs = walk(scenario).find((p) => p.endsWith("qualiber/run-summary.json"));
  const j = JSON.parse(fs.readFileSync(rs, "utf8"));
  const k = Object.keys(j.artifact_hashes).find((x) => x.endsWith("product-out/run-result.json"));
  j.artifact_hashes[k] = "sha256:" + "0".repeat(64);   // stale witness (but run-summary ref would then also mismatch → caught either way)
  fs.writeFileSync(rs, JSON.stringify(j, null, 2) + "\n");
  let failed = false, msg = "";
  try { execFileSync("node", [BUILDER, "--scenario-root", scenario, "--output-dir", path.join(root, "fixture"), "--execution-lock", EXECUTION_LOCK], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e) { failed = true; msg = (e.stderr ?? "").toString(); }
  check("T4c stale run-summary witness in base copy → builder hard-fails", failed && /stale witness|copy is not clean/.test(msg), msg.split("\n")[0] || "no failure");
}

// T5 — every intended binding update is reported with an exact match count or an
// explicit source-backed inapplicability.
{
  const cov = A.record.binding_coverage;
  const byLayer = Object.fromEntries(cov.map((l) => [l.layer, l]));
  const req = ["run_result_content", "operation_record_ref_run_result", "run_summary_artifact_hashes", "operation_record_ref_run_summary"];
  const allUpdatedOnce = req.every((k) => byLayer[k] && byLayer[k].status === "updated" && (byLayer[k].match_count === undefined || byLayer[k].match_count === 1));
  const inapplicableHasReason = cov.filter((l) => l.status === "inapplicable").every((l) => typeof l.reason === "string" && l.reason.length > 0);
  check("T5 every intended binding layer updated exactly once and reported", allUpdatedOnce, JSON.stringify(cov));
  check("T5 every inapplicable layer carries source-backed reasoning", inapplicableHasReason, JSON.stringify(cov.filter((l) => l.status === "inapplicable")));
}

// T6 — positive fixture agrees (fully bound, inconclusive otherwise acceptable).
let positive;
{
  positive = runComparator(A.scenario, A.fixtureDir, idPositive, expA(idPositive));
  check("T6 positive-bound control agrees, bound=true, run_status=inconclusive",
    positive.parsed?.verdict === "agree" && positive.parsed?.binding?.bound === true && positive.parsed?.observed?.run_status === "inconclusive",
    JSON.stringify(positive.parsed?.verdict) + " bound=" + JSON.stringify(positive.parsed?.binding?.bound));
}

// T7 — NC-11R yields forbidden_run_status_observed / disagree / product_disagreement.
let forbidden;
{
  forbidden = runComparator(A.scenario, A.fixtureDir, idForbidden, expA(idForbidden));
  const sub = forbidden.parsed?.sub_reasons ?? [];
  check("T7 NC-11R disagrees via forbidden_run_status_observed (bound=true)",
    forbidden.parsed?.verdict === "disagree" && forbidden.parsed?.classification === "product_disagreement" &&
    forbidden.parsed?.binding?.bound === true && sub.includes("forbidden_run_status_observed"),
    JSON.stringify(forbidden.parsed?.verdict) + " sub=" + JSON.stringify(sub));
}

// T8 — ordinary run_status_mismatch cannot satisfy NC-11R. Author a mismatch-only
// expectation (expected=clean, no forbidden) that is precommitted, and show its
// disagree is run_status_mismatch WITHOUT forbidden_run_status_observed.
{
  // Craft a mismatch expectation + its own precommit/index so it binds, reusing
  // the positive scenario's input digests.
  const pre = JSON.parse(fs.readFileSync(path.join(A.fixtureDir, "oracle-precommit.json"), "utf8"));
  const idx = JSON.parse(fs.readFileSync(path.join(A.fixtureDir, "campaign-index.json"), "utf8"));
  const base = pre.scenarios.find((s) => s.scenario_id === idPositive);
  const idMismatch = "NC-11R-MISMATCH-ONLY";
  const exp = { schema_version: "qualiber-reality-lab/campaign-expectation/v1", scenario_id: idMismatch,
    expected_operation_state: "completed", expected_response_status: "supported",
    expected_run_status: "clean", required_finding_types: [], permitted_additional_types: [],
    target_event: null, max_finding_count: 0, expected_product_reported: true };
  const expBytes = Buffer.from(JSON.stringify(exp, null, 2) + "\n");
  const expPath = path.join(A.fixtureDir, "expectations", `${idMismatch}.expected.json`);
  fs.writeFileSync(expPath, expBytes);
  pre.scenarios.push({ ...base, scenario_id: idMismatch, expectation_sha256: "sha256:" + sha256(expBytes), expectation_bytes: expBytes.length });
  idx.scenarios.push({ ...idx.scenarios.find((s) => s.scenario_id === idPositive), scenario_id: idMismatch });
  fs.writeFileSync(path.join(A.fixtureDir, "oracle-precommit.json"), JSON.stringify(pre, null, 2) + "\n");
  fs.writeFileSync(path.join(A.fixtureDir, "campaign-index.json"), JSON.stringify(idx, null, 2) + "\n");
  const r = runComparator(A.scenario, A.fixtureDir, idMismatch, expPath);
  const sub = r.parsed?.sub_reasons ?? [];
  const satisfiesNC11R = sub.includes("forbidden_run_status_observed");
  check("T8 mismatch expectation disagrees via run_status_mismatch, NOT forbidden_run_status_observed",
    r.parsed?.verdict === "disagree" && sub.includes("run_status_mismatch") && !satisfiesNC11R,
    JSON.stringify(sub));
  // (No restore needed: the canonical NC-11R expectations remain present and
  // unchanged; T9 reuses idForbidden and T11 builds a wholly independent root.)
}

// T9 — disabling forbidden precedence makes the NC-11R test go red: with rule 6
// removed from a comparator copy, the forbidden expectation yields agree.
{
  const mutComparator = path.join(A.fixtureDir, "compare-scenario-NOFORBIDDEN.mjs");
  let src = fs.readFileSync(COMPARATOR, "utf8");
  const rule6 = `  if ((expectedPublic.forbidden_run_status ?? []).includes(observed.run_status)) {
    sub.push("forbidden_run_status_observed");
    return emit("disagree", CLASSIFICATIONS.DISAGREEMENT);
  }`;
  const mutated = src.replace(rule6, "  /* rule 6 disabled for precedence-removal test */");
  check("T9 precedence branch is present in the real comparator (mutation target found)", mutated !== src, "rule 6 text not found — comparator changed?");
  fs.writeFileSync(mutComparator, mutated);
  const r = runComparator(A.scenario, A.fixtureDir, idForbidden, expA(idForbidden), mutComparator);
  const sub = r.parsed?.sub_reasons ?? [];
  const stillProves = r.parsed?.verdict === "disagree" && sub.includes("forbidden_run_status_observed");
  check("T9 with precedence disabled, NC-11R no longer proves the property (goes red)",
    !stillProves && r.parsed?.verdict === "agree", JSON.stringify(r.parsed?.verdict) + " sub=" + JSON.stringify(sub));
}

// T10 — (implicit throughout) every verdict above came from the real comparator
// binary and real fixture bytes. Assert the comparator digest is the pinned one.
{
  const pinned = "83223022f1522f4c22607f02123e02a0c5ff9cf92363aba0ec1e8a256010bcc4";
  check("T10 comparator under test is the pinned real comparator", sha256File(COMPARATOR) === pinned, sha256File(COMPARATOR));
}

// T11 — path-neutrality: build+run the fixture in a SECOND scratch root at a
// different absolute path; verdicts, sub-reasons, and binding coverage match.
{
  const B = buildFixture(WORK_B);
  const expB = (id) => path.join(B.fixtureDir, "expectations", `${id}.expected.json`);
  const pB = runComparator(B.scenario, B.fixtureDir, idPositive, expB(idPositive));
  const fB = runComparator(B.scenario, B.fixtureDir, idForbidden, expB(idForbidden));
  const sameVerdicts = pB.parsed?.verdict === "agree" &&
    fB.parsed?.verdict === "disagree" && (fB.parsed?.sub_reasons ?? []).includes("forbidden_run_status_observed");
  check("T11 path-neutral: second root yields identical positive=agree, forbidden=disagree+forbidden_run_status_observed",
    sameVerdicts, `A!=B? posA=${positive.parsed?.verdict} posB=${pB.parsed?.verdict} forbA=${forbidden.parsed?.verdict} forbB=${fB.parsed?.verdict}`);
  const covA = JSON.stringify(A.record.binding_coverage.map((l) => [l.layer, l.status, l.match_count ?? null]));
  const covB = JSON.stringify(B.record.binding_coverage.map((l) => [l.layer, l.status, l.match_count ?? null]));
  check("T11 path-neutral: binding coverage structurally identical across roots", covA === covB, `A=${covA} B=${covB}`);
  // Absolute paths differ (proves the two roots really are different locations).
  check("T11 the two scratch roots are genuinely different absolute paths", path.resolve(WORK_A) !== path.resolve(WORK_B), `${WORK_A} vs ${WORK_B}`);
}

console.log(`\nNC-11R binding suite: ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) process.exit(1);
