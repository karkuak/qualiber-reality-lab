/**
 * Run one of the two long validations and retain durable evidence of it.
 *
 * ## Why a wrapper rather than a flag
 *
 * The campaign can describe itself — it knows its controls, its accounting and
 * its own residue — and it now writes that record itself under `--evidence-out`.
 * What it cannot describe is the world around it: who the repository was before
 * and after, what Docker held on either side, when the run started in wall-clock
 * terms, and what the whole of its output actually was. Those are the wrapper's,
 * because a process cannot honestly certify the state it was launched from.
 *
 * The clean gate has no such self-knowledge at all. It is four ordinary commands,
 * and the previous closure recorded it as a paragraph of remembered numbers. Here
 * it is four steps, each with its command, timestamps, exit status, signal and
 * complete log.
 *
 * ## Deliberately not general
 *
 * Two modes, both named after the thing they run. There is no step DSL and no
 * configuration file: a wrapper that could run anything would need its own
 * evidence explaining what it ran.
 *
 *     node scripts/capture-validation-evidence.mjs --mode gate --out <dir>
 *     node scripts/capture-validation-evidence.mjs --mode campaign --out <dir>
 *
 * Nothing here writes inside the repository. `--out` is expected to be outside
 * the tracked tree, so the evidence exists *before* anybody decides whether to
 * commit it — which is what keeps the claim from being circular.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CAMPAIGN_SCHEMA,
  EVIDENCE_VERSION,
  GATE_SCHEMA,
  repositoryIdentity,
  sha256,
  writeEvidenceDirectory,
} from "./lib/validationEvidence.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const flag = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : process.argv[at + 1];
};

/** Everything the gate is, in the order a human runs it. */
const GATE_STEPS = [
  { name: "test", command: "npm", args: ["test"] },
  { name: "verify-generated", command: "npm", args: ["run", "verify:generated"] },
  { name: "evidence-verify", command: "npm", args: ["run", "evidence:verify"] },
  { name: "diff-check", command: "git", args: ["diff", "--check"] },
];

/**
 * Run one step to completion, retaining all of its output.
 *
 * Unbounded on purpose, and the one place in this repository where that is the
 * right choice: the campaign's stage collector keeps a tail because a runaway
 * stage must not exhaust memory across 129 controls, but a gate step is run once
 * by a human who has already decided to wait for it. Truncating the evidence of
 * a run whose whole point is to be evidence would be the same mistake in a new
 * place — so the byte count is reported instead, and `truncated` is always false.
 */
function runStep({ command, args, cwd }) {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => chunks.push(chunk));
    let signal = null;
    child.on("error", (error) => {
      chunks.push(Buffer.from(`\n[capture] spawn error: ${String(error)}\n`, "utf8"));
      resolve(finish(null));
    });
    child.on("close", (code, closedBy) => {
      signal = closedBy ?? null;
      resolve(finish(code));
    });

    function finish(status) {
      const endedAtMs = Date.now();
      const output = Buffer.concat(chunks).toString("utf8");
      // Echoed as it completes rather than streamed, so an operator watching a
      // multi-hour run sees each step land.
      console.log(
        `[capture] ${command} ${args.join(" ")} → exit ${String(status)}` +
          `${signal === null ? "" : ` (${signal})`} in ${String(endedAtMs - startedAtMs)} ms`,
      );
      return {
        command: `${command} ${args.join(" ")}`,
        started_at: startedAt,
        ended_at: new Date(endedAtMs).toISOString(),
        duration_ms: endedAtMs - startedAtMs,
        exit_status: status,
        exit_signal: signal,
        output_truncated: false,
        output_bytes: Buffer.byteLength(output),
        output_sha256: sha256(output),
        output,
      };
    }
  });
}

/**
 * The `node --test` summary, read from the log rather than remembered.
 *
 * The last block wins: `npm test` builds first, and a build that happens to echo
 * a matching line must not be mistaken for the run's own epilogue.
 */
function parseTotals(log) {
  const read = (label) => {
    const all = [...log.matchAll(new RegExp(`^ℹ ${label} (\\d+)$`, "gm"))];
    return all.length === 0 ? undefined : Number(all[all.length - 1][1]);
  };
  return {
    tests: read("tests"),
    pass: read("pass"),
    fail: read("fail"),
    cancelled: read("cancelled"),
    skipped: read("skipped"),
  };
}

/** Every skip the gate announced, so "2 skips" is a list rather than a number. */
function parseSkips(log) {
  return [...log.matchAll(/^\s*﹣ (.+?)(?: \([\d.]+ms\))?(?: # (.*))?[ \t]*$/gm)].map((m) => ({
    name: m[1],
    reason: m[2] ?? "",
  }));
}

/** A bounded inventory of what Docker holds, for the before/after comparison. */
function dockerInventory() {
  const ask = (args) => {
    const run = spawnSync("docker", args, { encoding: "utf8" });
    return run.status === 0
      ? String(run.stdout ?? "").split("\n").filter((line) => line.trim() !== "").sort()
      : null;
  };
  return {
    containers: ask(["ps", "-a", "--format", "{{.ID}} {{.Image}} {{.Names}} {{.State}}"]),
    networks: ask(["network", "ls", "--format", "{{.ID}} {{.Name}} {{.Driver}}"]),
    volumes: ask(["volume", "ls", "--format", "{{.Name}}"]),
    images: ask(["images", "--format", "{{.ID}} {{.Repository}}:{{.Tag}}"]),
  };
}

/** Campaign and gate leftovers this host should not be carrying afterwards. */
function processResidue() {
  const run = spawnSync("ps", ["-Ao", "pid=,command="], { encoding: "utf8" });
  if (run.status !== 0) return null;
  const mine = String(process.pid);
  return String(run.stdout ?? "")
    .split("\n")
    .filter((line) => /negative-control\.mjs|erl2-negative-control|node --test/.test(line))
    .filter((line) => line.trim().split(/\s+/)[0] !== mine)
    .map((line) => line.trim());
}

const main = async () => {
  const mode = flag("mode");
  const out = flag("out");
  if (mode !== "gate" && mode !== "campaign") {
    console.error("usage: capture-validation-evidence.mjs --mode gate|campaign --out <directory>");
    process.exit(2);
  }
  if (out === undefined) {
    console.error("--out <directory> is required; point it outside the tracked tree");
    process.exit(2);
  }
  const outDir = path.resolve(out);
  if (existsSync(outDir) && readdirSync(outDir).length > 0) {
    console.error(`${outDir} already holds evidence; refusing to overwrite a completed capture`);
    process.exit(2);
  }

  const before = repositoryIdentity(root);
  const dockerBefore = dockerInventory();
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  console.log(`[capture] ${mode} at ${String(before.commit)} (tree ${String(before.tree)}), clean=${String(before.clean)}`);

  if (mode === "gate") {
    const steps = [];
    const logs = {};
    for (const step of GATE_STEPS) {
      const outcome = await runStep({ ...step, cwd: root });
      const logName = `logs/${step.name}.log`;
      logs[logName] = outcome.output;
      const { output, ...rest } = outcome;
      steps.push({ name: step.name, log: logName, ...rest });
      if (outcome.exit_status !== 0) {
        console.error(`[capture] ${step.name} failed; the remaining steps are not run`);
        break;
      }
    }
    const testLog = logs["logs/test.log"] ?? "";
    const record = {
      schema: GATE_SCHEMA,
      version: EVIDENCE_VERSION,
      generated_by: "scripts/capture-validation-evidence.mjs",
      executable: before,
      after: repositoryIdentity(root),
      started_at: startedAt,
      ended_at: new Date().toISOString(),
      duration_ms: Date.now() - startedAtMs,
      steps,
      totals: parseTotals(testLog),
      skips: parseSkips(testLog),
      docker: { before: dockerBefore, after: dockerInventory() },
      process_residue: processResidue(),
    };
    const manifest = writeEvidenceDirectory({ dir: outDir, recordName: "clean-gate.json", record, logs });
    console.log(`\n[capture] wrote ${String(manifest.files.length)} file(s) to ${outDir}`);
    console.log(`[capture] totals: ${JSON.stringify(record.totals)}`);
    process.exit(steps.every((s) => s.exit_status === 0) ? 0 : 1);
  }

  // -- campaign --------------------------------------------------------------
  const recordPath = path.join(outDir, "campaign.json");
  const filter = flag("controls");
  const args = ["scripts/negative-control.mjs", ...(filter === undefined ? [] : [filter]), "--evidence-out", recordPath];
  const outcome = await runStep({ command: "node", args, cwd: root });

  const logs = { "logs/campaign.log": outcome.output };
  let campaign;
  try {
    campaign = JSON.parse(readFileSync(recordPath, "utf8"));
  } catch (error) {
    console.error(`[capture] the campaign wrote no readable record: ${String(error)}`);
  }
  // The campaign wrote its record directly into the output directory; it is
  // re-emitted below with the wrapper's fields merged in, so remove the
  // intermediate rather than leaving two versions of the same claim.
  rmSync(recordPath, { force: true });

  const perControlLogs = {};
  for (const result of campaign?.results ?? []) {
    if (typeof result.suiteOutputTail !== "string") continue;
    perControlLogs[`logs/controls/${result.id}.log`] = result.suiteOutputTail;
  }
  const { output, ...step } = outcome;
  const record = {
    ...(campaign ?? { schema: CAMPAIGN_SCHEMA, version: EVIDENCE_VERSION, results: [] }),
    captured_by: "scripts/capture-validation-evidence.mjs",
    before,
    after: repositoryIdentity(root),
    capture: { ...step, log: "logs/campaign.log" },
    docker: { before: dockerBefore, after: dockerInventory() },
    process_residue: processResidue(),
    // The tails now live as files under `logs/controls/`, hashed by the manifest.
    results: (campaign?.results ?? []).map(({ suiteOutputTail, ...rest }) => ({
      ...rest,
      ...(typeof suiteOutputTail === "string" ? { log: `logs/controls/${rest.id}.log` } : {}),
    })),
  };
  const manifest = writeEvidenceDirectory({
    dir: outDir,
    recordName: "campaign.json",
    record,
    logs: { ...logs, ...perControlLogs },
  });
  console.log(`\n[capture] wrote ${String(manifest.files.length)} file(s) to ${outDir}`);
  console.log(`[capture] accounting: ${JSON.stringify(record.accounting)}`);
  process.exit(outcome.exit_status === 0 ? 0 : 1);
};

await main();
