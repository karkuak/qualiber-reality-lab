/**
 * The verifier for the retained clean-gate and campaign evidence.
 *
 * ## What these controls are for
 *
 * The independent review of `07da5fe` did not find the validation harness wrong;
 * it found the *evidence* for it unfalsifiable. The 129-control campaign's only
 * complete record was git-ignored, so a fresh clone carried a prose summary of
 * three rows and nothing else; the exact-head clean gate was a paragraph naming
 * a log nobody kept. Neither could be checked, and neither could be checked
 * *against* — there was no commit binding, no manifest, no totals to reconcile.
 *
 * Retained evidence for a three-hour run has a particular failure mode: it is
 * believed on sight, because re-deriving it is expensive. That is exactly the
 * property that makes a forged or degraded record dangerous, so every control
 * below feeds the verifier a record that is *almost* right and requires it to
 * say no. The tampering is deliberately small — one flipped digest, one dropped
 * timestamp, one row whose counters do not sum — because a verifier that only
 * catches obvious damage is a verifier that catches nothing anybody would do.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");

interface VerifierModule {
  readonly verifyClosure: (input: Record<string, unknown>) => readonly string[];
  readonly DEFAULT_EVIDENCE_DIR: string;
}
interface EvidenceModule {
  readonly GATE_SCHEMA: string;
  readonly CAMPAIGN_SCHEMA: string;
  readonly EVIDENCE_VERSION: number;
  readonly writeManifest: (dir: string) => { readonly files: readonly string[] };
  readonly verifyManifest: (dir: string) => readonly string[];
  readonly verifyGateRecord: (record: unknown) => readonly string[];
  readonly verifyCampaignRecord: (record: unknown) => readonly string[];
  readonly repositoryIdentity: (root: string) => Record<string, unknown>;
}

const verifier = (await import(
  pathToFileURL(path.join(repoRoot, "scripts", "verify-validation-evidence.mjs")).href
)) as unknown as VerifierModule;
const evidence = (await import(
  pathToFileURL(path.join(repoRoot, "scripts", "lib", "validationEvidence.mjs")).href
)) as unknown as EvidenceModule;

const owned: string[] = [];
process.on("exit", () => {
  for (const dir of owned) rmSync(dir, { recursive: true, force: true });
});
function ownedDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "erl2-validation-evidence-"));
  owned.push(dir);
  return dir;
}

const COMMIT = "a".repeat(40);
const TREE = "b".repeat(40);
const IDENTITY = {
  repository: "qualiber-reality-lab",
  branch: "codex/external-adapter-receipt-admission",
  commit: COMMIT,
  tree: TREE,
  clean: true,
  status: [],
};

const gateRecord = (): Record<string, unknown> => ({
  schema: evidence.GATE_SCHEMA,
  version: evidence.EVIDENCE_VERSION,
  generated_by: "scripts/capture-validation-evidence.mjs",
  executable: { ...IDENTITY },
  after: { ...IDENTITY },
  started_at: "2026-08-11T10:00:00.000Z",
  ended_at: "2026-08-11T10:20:00.000Z",
  duration_ms: 1_200_000,
  steps: [
    {
      name: "test",
      command: "npm test",
      log: "logs/test.log",
      started_at: "2026-08-11T10:00:00.000Z",
      ended_at: "2026-08-11T10:18:00.000Z",
      duration_ms: 1_080_000,
      exit_status: 0,
      exit_signal: null,
      output_truncated: false,
      output_bytes: 12,
      output_sha256: "sha256:00",
    },
  ],
  totals: { tests: 10, pass: 8, fail: 0, cancelled: 0, skipped: 2 },
  skips: [{ name: "SOME: docker-gated case", reason: "LIVE SUBSTRATE UNPROVEN" }],
});

const controlRow = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  what: `the guard ${id} names`,
  expected: "fail",
  result: "named_tests_failed",
  harnessError: false,
  agreed: true,
  tests: 6,
  pass: 5,
  fail: 1,
  cancelled: 0,
  skipped: 0,
  command: "node --test --test-reporter=spec tests/dist/x.test.js",
  exitStatus: 1,
  exitSignal: null,
  outputTruncated: false,
  buildMs: 1000,
  suiteMs: 2000,
  stageTmpRemoved: true,
  log: `logs/controls/${id}.log`,
  ...over,
});

const campaignRecord = (rows = [controlRow("alpha"), controlRow("beta")]): Record<string, unknown> => ({
  schema: evidence.CAMPAIGN_SCHEMA,
  version: evidence.EVIDENCE_VERSION,
  generated_by: "scripts/negative-control.mjs",
  executable: { ...IDENTITY },
  command: "node scripts/negative-control.mjs",
  started_at: "2026-08-11T11:00:00.000Z",
  ended_at: "2026-08-11T14:09:00.000Z",
  duration_ms: 11_340_000,
  discovered: rows.length,
  controls: rows.map((r) => r["id"] as string),
  accounting: {
    discovered: rows.length,
    measured_agreements: rows.length,
    disagreements: 0,
    unmeasured: 0,
    harness_errors: 0,
  },
  reconciled: true,
  repository_byte_identical: true,
  residue: [],
  results: rows,
});

/** A complete, well-formed closure directory: two records, their logs, manifests. */
function closure(over: { gate?: Record<string, unknown>; campaign?: Record<string, unknown> } = {}): string {
  const dir = ownedDir();
  const gateDir = path.join(dir, "clean-gate");
  const campaignDir = path.join(dir, "negative-control-campaign");
  const gate = over.gate ?? gateRecord();
  const campaign = over.campaign ?? campaignRecord();

  mkdirSync(path.join(gateDir, "logs"), { recursive: true });
  for (const step of (gate["steps"] ?? []) as { log?: string }[]) {
    if (typeof step.log === "string") writeFileSync(path.join(gateDir, step.log), "ℹ pass 8\n");
  }
  writeFileSync(path.join(gateDir, "clean-gate.json"), `${JSON.stringify(gate, null, 2)}\n`);
  evidence.writeManifest(gateDir);

  mkdirSync(path.join(campaignDir, "logs", "controls"), { recursive: true });
  writeFileSync(path.join(campaignDir, "logs", "campaign.log"), "accounting: ok\n");
  for (const row of (campaign["results"] ?? []) as { log?: string }[]) {
    if (typeof row.log === "string") writeFileSync(path.join(campaignDir, row.log), "ℹ fail 1\n");
  }
  writeFileSync(path.join(campaignDir, "campaign.json"), `${JSON.stringify(campaign, null, 2)}\n`);
  evidence.writeManifest(campaignDir);
  return dir;
}

/** Verify without the tracked-file check, which needs a real repository. */
const check = (dir: string, extra: Record<string, unknown> = {}): readonly string[] =>
  verifier.verifyClosure({ dir, repoRoot, requireTracked: false, ...extra });

// -- the well-formed case ----------------------------------------------------

test("VALIDATION-EVIDENCE: a complete, consistent closure verifies", () => {
  assert.deepEqual(check(closure()), []);
});

test("VALIDATION-EVIDENCE: the manifest covers every retained file, in both directions", () => {
  const dir = closure();
  const campaignDir = path.join(dir, "negative-control-campaign");

  // A file nobody hashed is as much of a problem as a file that changed: it lets
  // an evidence directory grow content the manifest never saw.
  writeFileSync(path.join(campaignDir, "extra.json"), "{}\n");
  assert.ok(check(dir).some((p) => /extra\.json/.test(p) && /no line of SHA256SUMS/.test(p)));

  rmSync(path.join(campaignDir, "extra.json"));
  assert.deepEqual(check(dir), []);
});

test("VALIDATION-EVIDENCE: a single edited byte in a retained log fails the digest", () => {
  const dir = closure();
  const log = path.join(dir, "negative-control-campaign", "logs", "controls", "alpha.log");
  writeFileSync(log, "ℹ fail 0\n");
  const problems = check(dir);
  assert.ok(problems.some((p) => /alpha\.log is sha256:/.test(p)), problems.join("\n"));
});

test("VALIDATION-EVIDENCE: a log a record names but does not retain is refused", () => {
  const dir = closure();
  const campaignDir = path.join(dir, "negative-control-campaign");
  rmSync(path.join(campaignDir, "logs", "controls", "beta.log"));
  evidence.writeManifest(campaignDir);
  const problems = check(dir);
  assert.ok(problems.some((p) => /beta names logs\/controls\/beta\.log/.test(p)), problems.join("\n"));
});

test("VALIDATION-EVIDENCE: a missing subdirectory is refused before anything is parsed", () => {
  const dir = closure();
  rmSync(path.join(dir, "clean-gate"), { recursive: true });
  assert.deepEqual(check(dir), ["clean-gate/ is missing"]);
});

// -- the gate ----------------------------------------------------------------

test("VALIDATION-EVIDENCE: a gate record missing command, timestamps, exit status or totals is refused", () => {
  for (const drop of ["command", "started_at", "ended_at", "duration_ms", "log"] as const) {
    const gate = gateRecord();
    delete ((gate["steps"] as Record<string, unknown>[])[0] as Record<string, unknown>)[drop];
    assert.ok(
      evidence.verifyGateRecord(gate).length > 0,
      `a gate step with no ${drop} was accepted`,
    );
  }
  const noTotals = gateRecord();
  delete noTotals["totals"];
  assert.ok(evidence.verifyGateRecord(noTotals).length > 0, "a gate with no totals was accepted");
});

test("VALIDATION-EVIDENCE: a gate whose totals do not reconcile is refused", () => {
  const gate = gateRecord();
  gate["totals"] = { tests: 10, pass: 9, fail: 0, cancelled: 0, skipped: 2 };
  const problems = evidence.verifyGateRecord(gate);
  assert.ok(problems.some((p) => /do not reconcile/.test(p)), problems.join("\n"));
});

test("VALIDATION-EVIDENCE: a gate that failed, was signalled or was truncated is refused", () => {
  for (const [field, value] of [
    ["exit_status", 1],
    ["exit_signal", "SIGKILL"],
    ["output_truncated", true],
  ] as const) {
    const gate = gateRecord();
    ((gate["steps"] as Record<string, unknown>[])[0] as Record<string, unknown>)[field] = value;
    assert.ok(evidence.verifyGateRecord(gate).length > 0, `${field}=${String(value)} was accepted`);
  }
  const failing = gateRecord();
  failing["totals"] = { tests: 10, pass: 7, fail: 1, cancelled: 0, skipped: 2 };
  assert.ok(evidence.verifyGateRecord(failing).some((p) => /failing test/.test(p)));
});

test("VALIDATION-EVIDENCE: a gate that ran dirty, or left the tree changed, is refused", () => {
  const dirty = gateRecord();
  dirty["executable"] = { ...IDENTITY, clean: false, status: [" M packages/core/src/x.ts"] };
  assert.ok(evidence.verifyGateRecord(dirty).some((p) => /clean worktree/.test(p)));

  const moved = gateRecord();
  moved["after"] = { ...IDENTITY, tree: "c".repeat(40) };
  assert.ok(evidence.verifyGateRecord(moved).some((p) => /tree changed/.test(p)));
});

// -- the campaign ------------------------------------------------------------

test("VALIDATION-EVIDENCE: a record with no commit or tree is not bound to anything", () => {
  for (const drop of ["commit", "tree", "branch", "repository"] as const) {
    const campaign = campaignRecord();
    delete (campaign["executable"] as Record<string, unknown>)[drop];
    const problems = evidence.verifyCampaignRecord(campaign);
    assert.ok(problems.some((p) => p.includes(`no ${drop}`)), `a record with no ${drop} was accepted`);
  }
  const abbreviated = campaignRecord();
  (abbreviated["executable"] as Record<string, unknown>)["commit"] = "07da5fe";
  assert.ok(evidence.verifyCampaignRecord(abbreviated).some((p) => /full object name/.test(p)));
});

test("VALIDATION-EVIDENCE: accounting that does not reconcile is refused", () => {
  const campaign = campaignRecord();
  campaign["accounting"] = {
    discovered: 2,
    measured_agreements: 1,
    disagreements: 0,
    unmeasured: 0,
    harness_errors: 0,
  };
  const problems = evidence.verifyCampaignRecord(campaign);
  assert.ok(problems.some((p) => /does not reconcile/.test(p)), problems.join("\n"));
});

test("VALIDATION-EVIDENCE: a campaign missing a discovered control's result is refused", () => {
  const campaign = campaignRecord([controlRow("alpha")]);
  campaign["controls"] = ["alpha", "gamma"];
  const problems = evidence.verifyCampaignRecord(campaign);
  assert.ok(problems.some((p) => /gamma: discovered but carries no result/.test(p)), problems.join("\n"));
});

test("VALIDATION-EVIDENCE: duplicate control ids are refused", () => {
  const campaign = campaignRecord([controlRow("alpha"), controlRow("alpha")]);
  const problems = evidence.verifyCampaignRecord(campaign);
  assert.ok(problems.some((p) => /duplicate control id/.test(p)), problems.join("\n"));
});

test("VALIDATION-EVIDENCE: a row whose counters do not sum is impossible accounting", () => {
  const campaign = campaignRecord([controlRow("alpha", { tests: 9 }), controlRow("beta")]);
  const problems = evidence.verifyCampaignRecord(campaign);
  assert.ok(problems.some((p) => /impossible accounting/.test(p)), problems.join("\n"));
});

test("VALIDATION-EVIDENCE: agreement may not coexist with an incomplete observation", () => {
  // Each of these is a way of saying "the guard was proven load-bearing" while
  // also saying the run that proved it did not finish, did not end cleanly, or
  // lost a case on the way. The classifier makes them unreachable; the verifier
  // makes them unwriteable.
  const incomplete: readonly [string, Record<string, unknown>, RegExp][] = [
    ["a harness error", { harnessError: true }, /harness error/],
    ["truncated output", { outputTruncated: true }, /truncated/],
    ["a termination signal", { exitSignal: "SIGKILL" }, /termination by SIGKILL/],
    ["an abnormal exit", { exitStatus: 137 }, /exit status 137/],
    ["an undeclared skip", { undeclaredSkips: ["SOME: case"], skipped: 1, tests: 7 }, /undeclared skip/],
    ["an undeclared skip count", { skipped: 1, tests: 7 }, /undeclared skip/],
  ];
  for (const [what, over, expected] of incomplete) {
    const campaign = campaignRecord([controlRow("alpha", over), controlRow("beta")]);
    const problems = evidence.verifyCampaignRecord(campaign);
    assert.ok(problems.some((p) => expected.test(p)), `agreement with ${what} was accepted`);
  }

  // …and a skip the control declared in advance is fine, because it is published.
  const declared = campaignRecord([
    controlRow("alpha", {
      skipped: 1,
      tests: 7,
      expectedSkips: [{ case: "COMPOSE-ADV: the RENDERED configuration", reason: "RENDERED TOPOLOGY UNPROVEN" }],
      skippedCases: ["COMPOSE-ADV: the RENDERED configuration publishes one loopback port"],
    }),
    controlRow("beta"),
  ]);
  assert.deepEqual(evidence.verifyCampaignRecord(declared), []);
});

test("VALIDATION-EVIDENCE: a campaign that did not certify its tree or left residue is refused", () => {
  const changed = campaignRecord();
  changed["repository_byte_identical"] = false;
  assert.ok(evidence.verifyCampaignRecord(changed).some((p) => /byte-identical/.test(p)));

  const messy = campaignRecord();
  messy["residue"] = ["a worktree survived"];
  assert.ok(evidence.verifyCampaignRecord(messy).some((p) => /residue/.test(p)));
});

test("VALIDATION-EVIDENCE: a campaign whose per-control results are absent is refused", () => {
  // The exact defect: a record that summarises 129 controls and embeds none of
  // them, pointing instead at a file version control does not carry.
  const campaign = campaignRecord();
  campaign["results"] = [];
  const problems = evidence.verifyCampaignRecord(campaign);
  assert.ok(problems.some((p) => /embeds no per-control results/.test(p)), problems.join("\n"));
});

// -- the two runs must be about the same tree --------------------------------

test("VALIDATION-EVIDENCE: a gate and a campaign at different commits prove nothing together", () => {
  const campaign = campaignRecord();
  campaign["executable"] = { ...IDENTITY, commit: "c".repeat(40) };
  const problems = check(closure({ campaign }));
  assert.ok(problems.some((p) => /the gate ran at .* and the campaign at/.test(p)), problems.join("\n"));
});

test("VALIDATION-EVIDENCE: evidence claiming a commit other than the expected one is refused", () => {
  const problems = check(closure(), { expectCommit: "d".repeat(40) });
  assert.equal(problems.length, 2, problems.join("\n"));
  for (const problem of problems) assert.match(problem, /evidence claims .*, expected/);
});

// -- durability --------------------------------------------------------------

test("VALIDATION-EVIDENCE: evidence a fresh clone would not carry is refused", () => {
  // `docs/ledger/negative-controls.json` is git-ignored, which is what made the
  // previous campaign record undurable. Anything ignored inside the evidence
  // directory reproduces that defect, so the verifier asks git directly.
  const staged = path.join(repoRoot, "docs", "evidence", ".validation-evidence-durability-probe");
  rmSync(staged, { recursive: true, force: true });
  try {
    cpSync(closure(), staged, { recursive: true });
    const campaignDir = path.join(staged, "negative-control-campaign");
    // A file matching an existing ignore rule, retained as if it were evidence.
    cpSync(
      path.join(campaignDir, "campaign.json"),
      path.join(campaignDir, ".DS_Store"),
    );
    evidence.writeManifest(campaignDir);

    const problems = verifier.verifyClosure({ dir: staged, repoRoot, requireTracked: true });
    assert.ok(
      problems.some((p) => /\.DS_Store is excluded from version control/.test(p)),
      problems.join("\n"),
    );
  } finally {
    rmSync(staged, { recursive: true, force: true });
  }
});

test("VALIDATION-EVIDENCE: the verifier's default directory is the one the closure commits to", () => {
  assert.equal(
    verifier.DEFAULT_EVIDENCE_DIR,
    path.join("docs", "evidence", "validation-harness-closure"),
  );
  // …and the campaign's own writer must not point at the ignored ledger as its
  // authoritative record, which is the defect this whole correction answers.
  const harness = readFileSync(path.join(repoRoot, "scripts", "negative-control.mjs"), "utf8");
  assert.match(harness, /authoritative: false/);
  assert.match(harness, /--evidence-out/);
});
