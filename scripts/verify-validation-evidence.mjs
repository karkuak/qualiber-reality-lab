/**
 * Check the retained clean-gate and campaign evidence, and refuse anything that
 * cannot support the claim it makes.
 *
 * ## What it is for
 *
 * Retained evidence answers a question nobody can re-run cheaply: the gate takes
 * about twenty minutes and the campaign a little over three hours. That is
 * exactly why it has to be checkable — evidence expensive enough to be believed
 * on sight is evidence expensive enough to be worth forging, and a record that
 * only says what it would like to be true is not better than no record.
 *
 * So this verifier is bounded and mechanical. It recomputes every digest, it
 * requires the two records to name the same executable commit and tree, it makes
 * the accounting add up, and it refuses the specific combinations the classifier
 * correction made unrepresentable — an agreement that coexists with truncation, a
 * signal, a harness error or an undeclared skip. It takes seconds and it runs in
 * the ordinary suite, which is the point: the long runs happen once, and their
 * evidence is checked on every commit thereafter.
 *
 * It also asks the durability question directly. Every retained file must be
 * *tracked*: the defect the independent review of `07da5fe` named was a campaign
 * whose only complete record was git-ignored, so a record that points at
 * something a fresh clone will not carry is refused here by construction.
 *
 *     node scripts/verify-validation-evidence.mjs [--dir <path>] [--expect-commit <sha>]
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  isGitIgnored,
  verifyCampaignRecord,
  verifyGateRecord,
  verifyManifest,
  walkFiles,
} from "./lib/validationEvidence.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const flag = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : process.argv[at + 1];
};

export const DEFAULT_EVIDENCE_DIR = path.join("docs", "evidence", "validation-harness-closure");

/**
 * Verify one closure directory: a clean gate, a campaign, and their agreement.
 *
 * Returns problems rather than throwing or exiting, so the same function backs
 * both the CLI and the tests that feed it tampered records.
 */
export function verifyClosure({ dir, repoRoot = root, expectCommit, requireTracked = true }) {
  const problems = [];
  const gateDir = path.join(dir, "clean-gate");
  const campaignDir = path.join(dir, "negative-control-campaign");

  for (const [label, sub] of [["clean-gate", gateDir], ["negative-control-campaign", campaignDir]]) {
    if (!existsSync(sub) || !statSync(sub).isDirectory()) problems.push(`${label}/ is missing`);
  }
  if (problems.length > 0) return problems;

  problems.push(...verifyManifest(gateDir).map((p) => `clean-gate: ${p}`));
  problems.push(...verifyManifest(campaignDir).map((p) => `negative-control-campaign: ${p}`));

  const readRecord = (file, label) => {
    if (!existsSync(file)) {
      problems.push(`${label}: ${path.basename(file)} is missing`);
      return undefined;
    }
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      problems.push(`${label}: ${path.basename(file)} is not readable JSON: ${String(error)}`);
      return undefined;
    }
  };

  const gate = readRecord(path.join(gateDir, "clean-gate.json"), "clean-gate");
  const campaign = readRecord(path.join(campaignDir, "campaign.json"), "negative-control-campaign");

  if (gate !== undefined) {
    problems.push(...verifyGateRecord(gate).map((p) => `clean-gate: ${p}`));
    // Every log a step names has to be there, because a step's exit status is
    // only as good as the output it was read from.
    for (const step of gate.steps ?? []) {
      if (typeof step?.log === "string" && !existsSync(path.join(gateDir, step.log))) {
        problems.push(`clean-gate: step ${String(step.name)} names ${step.log}, which is not retained`);
      }
    }
  }
  if (campaign !== undefined) {
    problems.push(...verifyCampaignRecord(campaign).map((p) => `negative-control-campaign: ${p}`));
    for (const result of campaign.results ?? []) {
      if (typeof result?.log === "string" && !existsSync(path.join(campaignDir, result.log))) {
        problems.push(`negative-control-campaign: ${String(result.id)} names ${result.log}, which is not retained`);
      }
    }
  }

  // The two runs have to be about the same tree. A gate that passed at one commit
  // and a campaign that ran at another prove two things about nothing in
  // particular.
  if (gate !== undefined && campaign !== undefined) {
    if (gate.executable?.commit !== campaign.executable?.commit) {
      problems.push(
        `the gate ran at ${String(gate.executable?.commit)} and the campaign at ` +
          `${String(campaign.executable?.commit)}`,
      );
    }
    if (gate.executable?.tree !== campaign.executable?.tree) {
      problems.push("the gate and the campaign ran against different trees");
    }
  }
  if (expectCommit !== undefined) {
    for (const [label, record] of [["clean-gate", gate], ["negative-control-campaign", campaign]]) {
      if (record !== undefined && record.executable?.commit !== expectCommit) {
        problems.push(`${label}: evidence claims ${String(record.executable?.commit)}, expected ${expectCommit}`);
      }
    }
  }

  if (requireTracked) {
    for (const sub of [gateDir, campaignDir]) {
      for (const rel of walkFiles(sub)) {
        const full = path.join(sub, rel);
        if (isGitIgnored(repoRoot, full)) {
          problems.push(`${path.relative(dir, full)} is excluded from version control; a fresh clone would not carry it`);
        }
      }
    }
  }

  return problems;
}

const invokedDirectly = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const dir = path.resolve(root, flag("dir", DEFAULT_EVIDENCE_DIR));
  const problems = verifyClosure({
    dir,
    repoRoot: root,
    ...(flag("expect-commit") === undefined ? {} : { expectCommit: flag("expect-commit") }),
  });
  if (problems.length > 0) {
    console.error(`\nvalidation-evidence FAILED: ${String(problems.length)} problem(s) in ${dir}\n`);
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
  }
  console.log(`validation-evidence OK — ${dir} verifies byte-for-byte and reconciles`);
}
