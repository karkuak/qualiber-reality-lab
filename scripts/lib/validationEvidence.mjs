/**
 * Durable, content-addressed evidence for the two long validation runs.
 *
 * ## Why this exists
 *
 * The independent review of `07da5fe` found the validation-harness closure
 * blocked on evidence rather than on behaviour. The 129-control campaign's only
 * complete record was `docs/ledger/negative-controls.json`, which `.gitignore`
 * excludes: it disappears in a fresh clone, carries no commit or tree, is
 * overwritten by any targeted run, and has no integrity binding at all. The
 * exact-head clean gate fared worse — a prose paragraph referring to a log
 * nobody retained, with no command, no timestamps and no exit status.
 *
 * Both runs cost hours. Evidence that expensive should not be the one thing in
 * the repository that cannot be checked.
 *
 * ## What this is, and what it deliberately is not
 *
 * It is three things: a JSON record, whatever bounded logs that record refers
 * to, and a `SHA256SUMS` manifest over both. That is the whole format. There is
 * no evidence platform here, no schema registry, no generator — the repository
 * already has a byte-pinned evidence generator for deterministic artifacts, and
 * a three-hour campaign is not deterministic, so pinning its bytes would be a
 * lie. What can honestly be claimed is *this run, at this commit, produced these
 * numbers, and here is the output they were read from* — so that, and nothing
 * more.
 *
 * The manifest is what makes it durable. Every retained file is hashed, the
 * digests are committed, and the verifier recomputes them; a record whose log was
 * edited afterwards stops verifying. The commit and tree fields are what make it
 * *bound*: evidence that does not name the executable commit it measured is a
 * number without a subject.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

export const EVIDENCE_VERSION = 1;
export const GATE_SCHEMA = "erl2.validation-evidence.clean-gate";
export const CAMPAIGN_SCHEMA = "erl2.validation-evidence.negative-control-campaign";
export const MANIFEST_NAME = "SHA256SUMS";

export const sha256 = (data) =>
  `sha256:${createHash("sha256").update(typeof data === "string" ? Buffer.from(data, "utf8") : data).digest("hex")}`;

export const sha256OfFile = (file) => sha256(readFileSync(file));

/** `JSON.stringify` with a trailing newline, so a record is a well-formed file. */
export const renderRecord = (record) => `${JSON.stringify(record, null, 2)}\n`;

const git = (repoRoot, args) => {
  const run = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  return run.status === 0 ? String(run.stdout ?? "").trim() : undefined;
};

/**
 * Who the repository was when a run started — and, run again, when it ended.
 *
 * `status --porcelain` is retained in full rather than reduced to a boolean.
 * "Clean" is a claim; the empty list is the proof of it, and a reader who
 * disagrees about what should have been ignored can see exactly what was.
 */
export function repositoryIdentity(repoRoot) {
  const status = git(repoRoot, ["status", "--porcelain"]) ?? "";
  const entries = status.split("\n").filter((line) => line !== "");
  return {
    repository: path.basename(path.resolve(repoRoot)),
    branch: git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]),
    commit: git(repoRoot, ["rev-parse", "HEAD"]),
    tree: git(repoRoot, ["rev-parse", "HEAD^{tree}"]),
    clean: entries.length === 0,
    status: entries,
  };
}

/** Whether a path is excluded from version control — the durability question. */
export function isGitIgnored(repoRoot, target) {
  const run = spawnSync("git", ["check-ignore", "-q", "--", target], { cwd: repoRoot });
  return run.status === 0;
}

/** Every file beneath `dir`, as repository-style relative POSIX paths, sorted. */
export function walkFiles(dir, base = dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walkFiles(full, base));
    else found.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return found.sort();
}

/**
 * Write a `SHA256SUMS` over everything in `dir` except the manifest itself.
 *
 * Same shape the repository already uses for retained run evidence
 * (`docs/evidence/live-001-…/SHA256SUMS`): bare hex, two spaces, relative path.
 * A reader with `shasum -c` and no knowledge of this codebase can check it.
 */
export function writeManifest(dir) {
  const files = walkFiles(dir).filter((rel) => rel !== MANIFEST_NAME);
  const lines = files.map((rel) => `${sha256OfFile(path.join(dir, rel)).slice(7)}  ${rel}`);
  const body = `${lines.join("\n")}\n`;
  writeFileSync(path.join(dir, MANIFEST_NAME), body);
  return { files, digest: sha256(body) };
}

/**
 * Recompute every digest the manifest claims, and refuse anything it omits.
 *
 * Both directions matter. A changed file is the obvious attack; an *added* file
 * the manifest never mentioned is the quieter one, because it lets an evidence
 * directory grow content nobody hashed.
 */
export function verifyManifest(dir) {
  const problems = [];
  const manifestPath = path.join(dir, MANIFEST_NAME);
  if (!existsSync(manifestPath)) return [`${dir} has no ${MANIFEST_NAME}`];

  const claimed = new Map();
  for (const line of readFileSync(manifestPath, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    const matched = /^([0-9a-f]{64})[ \t]+(.+)$/.exec(line);
    if (matched === null) {
      problems.push(`${MANIFEST_NAME} has an unparseable line: ${line.slice(0, 80)}`);
      continue;
    }
    claimed.set(matched[2], `sha256:${matched[1]}`);
  }

  const present = new Set(walkFiles(dir).filter((rel) => rel !== MANIFEST_NAME));
  for (const [rel, digest] of claimed) {
    if (!present.has(rel)) {
      problems.push(`${MANIFEST_NAME} names ${rel}, which is not present`);
      continue;
    }
    const observed = sha256OfFile(path.join(dir, rel));
    if (observed !== digest) problems.push(`${rel} is ${observed}, the manifest records ${digest}`);
  }
  for (const rel of present) {
    if (!claimed.has(rel)) problems.push(`${rel} is present but no line of ${MANIFEST_NAME} covers it`);
  }
  return problems;
}

// -- record shape ------------------------------------------------------------

const isWholeNumber = (value) => Number.isInteger(value) && value >= 0;

function requireIdentity(record, problems, where) {
  for (const field of ["commit", "tree", "branch", "repository"]) {
    const value = record?.[field];
    if (typeof value !== "string" || value === "") problems.push(`${where}: no ${field}`);
  }
  if (typeof record?.commit === "string" && !/^[0-9a-f]{40}$/.test(record.commit)) {
    problems.push(`${where}: commit is not a full object name`);
  }
  if (typeof record?.tree === "string" && !/^[0-9a-f]{40}$/.test(record.tree)) {
    problems.push(`${where}: tree is not a full object name`);
  }
}

/**
 * Everything a clean-gate record has to establish before it counts as one.
 *
 * The list is the review's, not an invention: command, timestamps, exit status
 * and totals are exactly what the previous prose record left out, which is why a
 * reader could not tell a gate that passed from one that was reported as having
 * passed.
 */
export function verifyGateRecord(record) {
  const problems = [];
  if (record?.schema !== GATE_SCHEMA) problems.push(`schema is ${String(record?.schema)}, expected ${GATE_SCHEMA}`);
  if (record?.version !== EVIDENCE_VERSION) problems.push(`version is ${String(record?.version)}`);
  requireIdentity(record?.executable, problems, "executable");
  if (record?.executable?.clean !== true) problems.push("the gate did not run on a clean worktree");
  if (record?.after?.commit !== record?.executable?.commit) {
    problems.push("the repository was at a different commit after the gate than before it");
  }
  if (record?.after?.tree !== record?.executable?.tree) {
    problems.push("the repository tree changed while the gate ran");
  }
  if (record?.after?.clean !== true) problems.push("the worktree was not clean after the gate");

  const steps = record?.steps;
  if (!Array.isArray(steps) || steps.length === 0) {
    problems.push("no steps recorded");
    return problems;
  }
  for (const step of steps) {
    const where = `step ${String(step?.name)}`;
    if (typeof step?.command !== "string" || step.command === "") problems.push(`${where}: no command`);
    if (typeof step?.started_at !== "string" || typeof step?.ended_at !== "string") {
      problems.push(`${where}: no start/end timestamp`);
    }
    if (!isWholeNumber(step?.duration_ms)) problems.push(`${where}: no duration`);
    if (step?.exit_status !== 0) problems.push(`${where}: exited ${String(step?.exit_status)}`);
    if (step?.exit_signal !== null && step?.exit_signal !== undefined) {
      problems.push(`${where}: terminated by ${String(step.exit_signal)}`);
    }
    if (step?.output_truncated === true) problems.push(`${where}: output was truncated`);
    if (typeof step?.log !== "string" || step.log === "") problems.push(`${where}: retains no log`);
  }

  const totals = record?.totals;
  for (const counter of ["tests", "pass", "fail", "cancelled", "skipped"]) {
    if (!isWholeNumber(totals?.[counter])) problems.push(`totals.${counter} is not a whole number`);
  }
  if (
    isWholeNumber(totals?.tests) &&
    totals.tests !== totals.pass + totals.fail + totals.cancelled + totals.skipped
  ) {
    problems.push(
      `totals do not reconcile: ${String(totals.tests)} ≠ ${String(totals.pass)} + ${String(totals.fail)} + ` +
        `${String(totals.cancelled)} + ${String(totals.skipped)}`,
    );
  }
  if (totals?.fail !== 0) problems.push(`the gate recorded ${String(totals?.fail)} failing test(s)`);
  if (totals?.cancelled !== 0) problems.push(`the gate recorded ${String(totals?.cancelled)} cancelled test(s)`);
  return problems;
}

/**
 * Everything a campaign record has to establish, control by control.
 *
 * The checks that matter most are the cross-field ones at the end. A row may not
 * claim agreement while also carrying truncation, an abnormal exit, a harness
 * error or an undeclared skip — that combination is precisely the defect the
 * classifier correction closed, and evidence is the second place it must be
 * impossible to express.
 */
export function verifyCampaignRecord(record) {
  const problems = [];
  if (record?.schema !== CAMPAIGN_SCHEMA) problems.push(`schema is ${String(record?.schema)}, expected ${CAMPAIGN_SCHEMA}`);
  if (record?.version !== EVIDENCE_VERSION) problems.push(`version is ${String(record?.version)}`);
  requireIdentity(record?.executable, problems, "executable");
  if (typeof record?.command !== "string" || record.command === "") problems.push("no campaign command");
  if (typeof record?.started_at !== "string" || typeof record?.ended_at !== "string") {
    problems.push("no start/end timestamp");
  }
  if (!isWholeNumber(record?.duration_ms)) problems.push("no duration");
  if (record?.repository_byte_identical !== true) problems.push("the repository was not certified byte-identical");
  if (!Array.isArray(record?.residue) || record.residue.length > 0) {
    problems.push(`residue: ${JSON.stringify(record?.residue)}`);
  }

  const results = record?.results;
  if (!Array.isArray(results) || results.length === 0) {
    problems.push("the record embeds no per-control results");
    return problems;
  }

  const accounting = record?.accounting;
  for (const column of ["discovered", "measured_agreements", "disagreements", "unmeasured", "harness_errors"]) {
    if (!isWholeNumber(accounting?.[column])) problems.push(`accounting.${column} is not a whole number`);
  }
  if (isWholeNumber(accounting?.discovered)) {
    const summed =
      accounting.measured_agreements + accounting.disagreements + accounting.unmeasured + accounting.harness_errors;
    if (summed !== accounting.discovered) {
      problems.push(`accounting does not reconcile: ${String(summed)} accounted, ${String(accounting.discovered)} discovered`);
    }
    if (results.length !== accounting.discovered) {
      problems.push(
        `the record carries ${String(results.length)} result(s) for ${String(accounting.discovered)} discovered control(s)`,
      );
    }
  }
  if (record?.reconciled !== true) problems.push("the campaign did not reconcile its own accounting");

  const ids = new Set();
  for (const result of results) {
    const id = result?.id;
    if (typeof id !== "string" || id === "") {
      problems.push("a result has no control id");
      continue;
    }
    if (ids.has(id)) problems.push(`${id}: duplicate control id`);
    ids.add(id);

    if (typeof result?.result !== "string" || result.result === "") problems.push(`${id}: no classification`);
    const agreed = result?.agreed;
    if (agreed !== true && agreed !== false && agreed !== null) problems.push(`${id}: \`agreed\` is ${String(agreed)}`);

    // Counters are only required where the control was actually run: a control
    // whose prerequisite was unavailable before execution has no suite to count,
    // and demanding zeros from it would be demanding a fiction.
    const ran = result?.exitStatus !== undefined;
    if (ran) {
      const counters = ["tests", "pass", "fail", "cancelled", "skipped"];
      const missing = counters.filter((counter) => !isWholeNumber(result?.[counter]));
      if (missing.length > 0) problems.push(`${id}: ${missing.join(", ")} is not a whole number`);
      else if (result.tests !== result.pass + result.fail + result.cancelled + result.skipped) {
        problems.push(
          `${id}: impossible accounting — ${String(result.tests)} tests ≠ ${String(result.pass)} + ` +
            `${String(result.fail)} + ${String(result.cancelled)} + ${String(result.skipped)}`,
        );
      }
    }

    if (agreed === true) {
      // The combinations that must not be expressible.
      if (result?.harnessError === true) problems.push(`${id}: agreement coexists with a harness error`);
      if (result?.outputTruncated === true) problems.push(`${id}: agreement coexists with truncated output`);
      if (result?.exitSignal !== null && result?.exitSignal !== undefined) {
        problems.push(`${id}: agreement coexists with termination by ${String(result.exitSignal)}`);
      }
      if (ran && result?.exitStatus !== 0 && result?.exitStatus !== 1) {
        problems.push(`${id}: agreement coexists with exit status ${String(result.exitStatus)}`);
      }
      if (Array.isArray(result?.undeclaredSkips) && result.undeclaredSkips.length > 0) {
        problems.push(`${id}: agreement coexists with ${String(result.undeclaredSkips.length)} undeclared skip(s)`);
      }
      // A skip is permitted only where the control declared it in advance.
      const skipped = isWholeNumber(result?.skipped) ? result.skipped : 0;
      if (skipped > 0 && (!Array.isArray(result?.expectedSkips) || result.expectedSkips.length === 0)) {
        problems.push(`${id}: agreement coexists with ${String(skipped)} undeclared skip(s)`);
      }
    }
  }

  for (const declared of record?.controls ?? []) {
    if (!ids.has(declared)) problems.push(`${declared}: discovered but carries no result`);
  }
  return problems;
}

/** Write a record, its logs and a manifest into a fresh evidence directory. */
export function writeEvidenceDirectory({ dir, recordName, record, logs = {} }) {
  mkdirSync(dir, { recursive: true });
  for (const [rel, body] of Object.entries(logs)) {
    const target = path.join(dir, rel);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, body);
  }
  writeFileSync(path.join(dir, recordName), renderRecord(record));
  return writeManifest(dir);
}
