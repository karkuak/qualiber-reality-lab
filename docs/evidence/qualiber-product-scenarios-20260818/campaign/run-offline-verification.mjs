#!/usr/bin/env node
/**
 * run-offline-verification.mjs — TASK-LOCAL CAMPAIGN EVIDENCE TOOLING.
 *
 * MUST NOT be promoted into Reality Lab packages or into Qualiber.
 *
 * WHY THIS EXISTS AND WHY IT IS NOT THE COMPARATOR. The Lab's offline verifier,
 * `verifyTrustedLocalObservationRecord`, is exported from `@erl2/core` — which
 * is neither one of the two packages the comparator is permitted to import
 * (`@erl2/contracts`, `@erl2/integrity`) nor one of the three Lab peers the
 * Qualiber adapter is provisioned with. It therefore cannot be reached through
 * the comparator's `--dependency-anchor`, and it is deliberately kept out of
 * the comparator: §10.6 requires the comparator to recompute the response
 * envelope's core hash ITSELF rather than delegate to this verifier, whose
 * input surface (recordBytes / planBytes / registryRoot / adapterEntryPath /
 * retainedInputRoot) contains no retained-output or envelope path at all.
 *
 * This runner resolves `@erl2/core` through the pinned Lab checkout, exactly as
 * the retained 2026-08-16 bundle's `task-local-verify.mjs` did — the same
 * retained-but-never-promoted precedent the plan cites for the comparator.
 * It adds no assurance machinery: it calls one Lab function and records what
 * that function returned.
 *
 * Usage:
 *   node run-offline-verification.mjs --lab-checkout <dir> --record <f>
 *     --plan <f> --registry-root <dir> --adapter-entry <f>
 *     --retained-input-root <dir> --label <s> --output <f>
 *
 * Exit 0 = verification reported ok. Exit 1 = verification refused.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

function usage(m) {
  process.stderr.write(`run-offline-verification: ${m}\n`);
  process.exit(2);
}

const a = { labCheckout: null, record: null, plan: null, registryRoot: null, adapterEntry: null, retainedInputRoot: null, label: null, output: null };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  switch (argv[i]) {
    case "--lab-checkout": a.labCheckout = argv[++i]; break;
    case "--record": a.record = argv[++i]; break;
    case "--plan": a.plan = argv[++i]; break;
    case "--registry-root": a.registryRoot = argv[++i]; break;
    case "--adapter-entry": a.adapterEntry = argv[++i]; break;
    case "--retained-input-root": a.retainedInputRoot = argv[++i]; break;
    case "--label": a.label = argv[++i]; break;
    case "--output": a.output = argv[++i]; break;
    default: usage(`unknown flag ${argv[i]}`);
  }
}
for (const k of Object.keys(a)) if (!a[k]) usage(`--${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} is required`);

const sha = (b) => `sha256:${createHash("sha256").update(b).digest("hex")}`;
const req = createRequire(path.join(a.labCheckout, "package.json"));
let core;
try {
  core = await import(pathToFileURL(req.resolve("@erl2/core")).href);
} catch (err) {
  usage(`cannot resolve @erl2/core through ${a.labCheckout}: ${err.message}`);
}
const verify = core.verifyTrustedLocalObservationRecord;
if (typeof verify !== "function") usage("@erl2/core did not export verifyTrustedLocalObservationRecord");

const recordBytes = fs.readFileSync(a.record);
const planBytes = fs.readFileSync(a.plan);

let outcome;
let threw = null;
try {
  outcome = await verify({
    recordBytes,
    planBytes,
    registryRoot: a.registryRoot,
    adapterEntryPath: a.adapterEntry,
    retainedInputRoot: a.retainedInputRoot,
  });
} catch (err) {
  threw = { name: err?.name ?? "Error", message: err?.message ?? String(err), code: err?.code ?? null };
  outcome = null;
}

const ok = Boolean(outcome && (outcome.ok === true || outcome.verified === true)) && !threw;
const result = {
  schema_version: "qualiber-reality-lab/campaign-offline-verification/v1",
  label: a.label,
  verifier: "verifyTrustedLocalObservationRecord",
  verifier_package: "@erl2/core",
  lab_checkout_resolved_from: a.labCheckout,
  inputs: {
    record_sha256: sha(recordBytes),
    plan_sha256: sha(planBytes),
    adapter_entry_sha256: sha(fs.readFileSync(a.adapterEntry)),
    registry_root: a.registryRoot,
    retained_input_root: a.retainedInputRoot,
  },
  // Stated so nobody re-reads this file as more than it is.
  scope_note:
    "This verifier's input surface has no retained-output or response-envelope path. It does not " +
    "open or validate any response envelope, and it does not recompute an envelope core hash. The " +
    "four-step envelope bind is performed independently by compare-scenario.mjs.",
  ok,
  threw,
  outcome: outcome ?? null,
};
fs.mkdirSync(path.dirname(a.output), { recursive: true });
fs.writeFileSync(a.output, `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`offline-verification ${a.label}: ${ok ? "OK" : "REFUSED"}\n`);
if (!ok) process.stdout.write(`${JSON.stringify(threw ?? outcome, null, 2).slice(0, 2000)}\n`);
process.exit(ok ? 0 : 1);
