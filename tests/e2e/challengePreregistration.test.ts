/**
 * `erl2 preregister-challenge` — the one authorized continuation of a successful
 * package verification (ADR-ERL2-013), and the state `select` departs from.
 *
 * Every case drives the shipped binary in a fresh process.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { erl2, runToAcquired } from "../support/cliRun.js";
import type { GovernorRegistry } from "../support/governorRegistry.js";

/** Full-tree byte manifest; the run lease is Lab bookkeeping, not evidence. */
function manifest(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const rec = (dir: string, base: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const absolute = path.join(dir, entry.name);
      const relative = base + entry.name;
      if (entry.isDirectory()) {
        out.set(`${relative}/`, "dir");
        rec(absolute, `${relative}/`);
        continue;
      }
      out.set(relative, createHash("sha256").update(readFileSync(absolute)).digest("hex"));
    }
  };
  rec(root, "");
  return out;
}
function changed(before: Map<string, string>, after: Map<string, string>): readonly string[] {
  const out: string[] = [];
  for (const [key, value] of after) if (before.get(key) !== value) out.push(key);
  for (const key of before.keys()) if (!after.has(key)) out.push(`-${key}`);
  return out.filter((p) => !p.includes("lease"));
}

function preregistered(): {
  readonly runRoot: string;
  readonly registry: GovernorRegistry;
  readonly base: readonly string[];
  readonly policyFlags: readonly string[];
  readonly challengeFlags: readonly string[];
} {
  const run = runToAcquired();
  const base = [
    "--run-root", run.runRoot,
    "--registry", run.registry.root,
    "--tier", "development",
    "--run", run.runId,
  ];
  assert.equal(erl2(["freeze-package", ...base]).exitCode, 0);
  assert.equal(
    erl2([
      "verify-package", ...base,
      "--fake-verify-package", "succeeded",
      "--subject-id", "s",
      "--subject-version", "0.1.0",
    ]).exitCode,
    0,
  );
  return {
    runRoot: run.runRoot,
    registry: run.registry,
    base,
    policyFlags: [
      "--journey-selection-policy", run.registry.journeySelectionPolicyHash,
      "--randomness-policy", run.registry.randomnessPolicyHash,
    ],
    challengeFlags: run.registry.challengeCandidates.flatMap((c) => [
      "--challenge",
      c.challengeManifestHash,
    ]),
  };
}

test("CHALLENGE-PREREG: the admitted family is frozen and the run reaches challenge_preregistered", () => {
  const ctx = preregistered();
  const result = erl2([
    "preregister-challenge", ...ctx.base, ...ctx.policyFlags, ...ctx.challengeFlags,
  ]);
  assert.equal(result.exitCode, 0, JSON.stringify(result.body.errors));
  assert.equal(result.body.state, "challenge_preregistered");

  const retained = path.join(ctx.runRoot, "retained");
  const present = (relative: string): boolean =>
    manifest(retained).has(relative.replace(/^retained\//, ""));
  assert.ok(present("journey-selection-policy.json"), "the journey selection policy is mirrored");
  assert.ok(present("selection-randomness-policy.json"), "the randomness policy is mirrored");

  // The whole family is frozen — selection must remain free to draw any member.
  for (const candidate of ctx.registry.challengeCandidates) {
    assert.ok(
      present(`challenge-manifests/erl2-development-challenge-${candidate.challengeId}.json`),
      `challenge ${candidate.challengeId} is frozen`,
    );
    assert.ok(
      present(`journey-definitions/erl2-development-journey-${candidate.challengeId}.json`),
      `journey ${candidate.challengeId} is frozen`,
    );
  }
  // Nothing here selects: no binding, commitment or proof exists yet.
  for (const forbidden of ["selection-commitment.json", "selection-proof.json", "selected-binding.json"]) {
    assert.ok(!present(forbidden), `${forbidden} must not exist before select`);
  }
});

test("CHALLENGE-PREREG: the mirrored policies are the admitted bytes, policy_author-signed", () => {
  const ctx = preregistered();
  assert.equal(
    erl2(["preregister-challenge", ...ctx.base, ...ctx.policyFlags, ...ctx.challengeFlags]).exitCode,
    0,
  );
  const retained = path.join(ctx.runRoot, "retained");
  for (const [file, expected] of [
    ["journey-selection-policy.json", ctx.registry.journeySelectionPolicyHash],
    ["selection-randomness-policy.json", ctx.registry.randomnessPolicyHash],
  ] as const) {
    const value = JSON.parse(readFileSync(path.join(retained, file), "utf8")) as {
      core_hash: string;
      signature: { key_id: string };
    };
    assert.equal(value.core_hash, expected, `${file} is the admitted artifact`);
    // ADR-ERL2-020 §2a: the challenge governor must not author the policies that
    // govern its own selection.
    assert.match(value.signature.key_id, /policy-author/, `${file} is policy_author-signed`);
  }
});

/*
 * ADR-ERL2-019 §4 — a refusal adds zero retained evidence.
 *
 * A first cut of `preregisterChallenge` froze both policies before the challenge
 * loop validated admission, so an unadmitted challenge hash was refused
 * correctly and still left four files behind. The method now resolves and checks
 * every input before writing one byte; this fails if that phasing is undone.
 */
test("CHALLENGE-PREREG-NO-WRITE: every refused preregistration adds zero retained evidence", () => {
  const ctx = preregistered();
  const absent = `sha256:${"0".repeat(64)}`;
  const good = ctx.registry.challengeCandidates[0]?.challengeManifestHash as string;
  const cases: readonly (readonly [string, readonly string[]])[] = [
    ["unadmitted challenge", [...ctx.policyFlags, "--challenge", absent]],
    [
      "unadmitted journey selection policy",
      ["--journey-selection-policy", absent, "--randomness-policy", ctx.registry.randomnessPolicyHash, ...ctx.challengeFlags],
    ],
    ["duplicate --challenge", [...ctx.policyFlags, "--challenge", good, "--challenge", good]],
    [
      "a policy hash where a challenge belongs",
      ["--journey-selection-policy", good, "--randomness-policy", ctx.registry.randomnessPolicyHash, ...ctx.challengeFlags],
    ],
    // The partial-family case: the first challenge resolves, the second does not.
    ["one admitted and one unadmitted", [...ctx.policyFlags, "--challenge", good, "--challenge", absent]],
  ];
  for (const [label, tail] of cases) {
    const before = manifest(ctx.runRoot);
    const result = erl2(["preregister-challenge", ...ctx.base, ...tail]);
    assert.notEqual(result.exitCode, 0, `${label} must be refused`);
    assert.deepEqual(changed(before, manifest(ctx.runRoot)), [], `${label} must write nothing`);
  }
});

test("CHALLENGE-PREREG: a second preregistration is refused and writes nothing", () => {
  const ctx = preregistered();
  const argv = ["preregister-challenge", ...ctx.base, ...ctx.policyFlags, ...ctx.challengeFlags];
  assert.equal(erl2(argv).exitCode, 0);
  const after = manifest(ctx.runRoot);
  const replay = erl2(argv);
  assert.notEqual(replay.exitCode, 0, "the run has already left package_manifest_frozen");
  assert.deepEqual(changed(after, manifest(ctx.runRoot)), [], "a refused replay writes nothing");
});
