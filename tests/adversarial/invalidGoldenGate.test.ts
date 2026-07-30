/**
 * The invalid-golden evidence gate is load-bearing (ADR-ERL2-029 §7).
 *
 * ## The blind spot this closes
 *
 * `npm run evidence:verify` byte-compares regenerated producer output against
 * `fixtures/golden`. It is a strong gate on producer bytes and it was **no gate at
 * all on verification**: the generator's `runCli` records `exit_code` into a
 * transcript and never asserts it, and `cli-transcript.json` is the single file
 * excluded from the byte pin. So the three `verify-record` invocations over the
 * three invalid goldens had their real outcome recorded in the one place the pin
 * cannot see — and a verifier regression against invalid records changes no
 * producer bytes, so it left the gate green.
 *
 * ## What these cases prove, and what they do not
 *
 * The gate's acceptance condition is exactly `exit_code === 0 && closure.verdict
 * === "valid"`, evaluated over a fixture in a fresh `erl2 verify-record` process.
 * Each case below sabotages a **copy** of a shipped invalid golden and evaluates
 * that same condition the same way, so what is measured is the decision the gate
 * makes — not a paraphrase of it.
 *
 * They do not re-run `generate-evidence.mjs --verify` itself: that script reads
 * `fixtures/golden` by construction, and pointing it at a sabotaged tree would
 * mean either writing to the real goldens or adding a root override whose only
 * caller is a test. The enumeration and the count assertion in the gate are what
 * make the fixture list unfakeable; these cases are what make the per-fixture
 * verdict unfakeable. **The live goldens are never written to.**
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { chmodSync, cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { coreHash } from "@erl2/integrity";
import { erl2 } from "../support/cliRun.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const goldenRoot = path.join(repoRoot, "fixtures", "golden");

/** Every invalid-run golden the mandatory gate enumerates. */
function invalidGoldens(): readonly string[] {
  return readdirSync(goldenRoot)
    .filter((name) => name.startsWith("invalid-run-"))
    .sort();
}

/** A disposable copy of one golden; the live fixture is never touched. */
function copyGolden(name: string): string {
  const dest = mkdtempSync(path.join(tmpdir(), "erl2-sabotage-"));
  cpSync(path.join(goldenRoot, name), dest, { recursive: true });
  return dest;
}

/** The gate's own acceptance condition, evaluated the way the gate evaluates it. */
function gateAccepts(dir: string): { readonly accepted: boolean; readonly code: string } {
  const result = erl2([
    "verify-record",
    "--record", path.join(dir, "invalid-record.json"),
    "--lifecycle", path.join(dir, "lifecycle.json"),
    "--artifact-root", path.join(dir, "artifacts"),
    "--root-config", path.join(dir, "root-config.json"),
    "--offline",
  ]);
  const body = result.body as {
    data?: { closure?: { verdict?: string } };
    errors: { code: string }[];
  };
  return {
    accepted: result.exitCode === 0 && body.data?.closure?.verdict === "valid",
    code: body.errors[0]?.code ?? "-",
  };
}

test("GOLDEN-GATE: every invalid golden the gate enumerates is accepted unsabotaged", () => {
  // The other half of the gate, and the half a sabotage-only test cannot give:
  // without it, a fixture that is broken from the day it lands passes a gate that
  // only ever checks that breaking things breaks them.
  const goldens = invalidGoldens();
  assert.ok(goldens.length > 0, "the gate has fixtures to enumerate");
  for (const name of goldens) {
    const verdict = gateAccepts(copyGolden(name));
    assert.equal(verdict.accepted, true, `${name} must verify clean: ${verdict.code}`);
  }
});

test("GOLDEN-GATE-SABOTAGE: deleting a retained artifact makes the gate reject the golden", () => {
  const name = invalidGoldens()[0] as string;
  const dir = copyGolden(name);
  const retained = path.join(dir, "artifacts", "retained");
  const victim = readdirSync(retained)
    .filter((f) => f.endsWith(".json") && !f.endsWith(".frozen"))
    .sort()[0] as string;
  chmodSync(path.join(retained, victim), 0o644);
  rmSync(path.join(retained, victim));

  const verdict = gateAccepts(dir);
  assert.equal(verdict.accepted, false, `a golden missing ${victim} must not be accepted`);
});

test("GOLDEN-GATE-SABOTAGE: an unaccounted retained extra makes the gate reject the golden", () => {
  // Self-consistent and correctly hashed, so nothing catches it on bytes. It is
  // refused for being a retained artifact the closure never derived — the P1-1
  // invariant, reached through the invalid branch.
  const name = invalidGoldens()[0] as string;
  const dir = copyGolden(name);
  const body = { schema_version: "rogue-artifact/v1", run_id: "rogue", note: "unaccounted" };
  writeFileSync(
    path.join(dir, "artifacts", "retained", "rogue.json"),
    JSON.stringify({ ...body, core_hash: coreHash(body) }),
  );

  const verdict = gateAccepts(dir);
  assert.equal(verdict.accepted, false, "an unaccounted retained extra must not be accepted");
  assert.equal(verdict.code, "GRAPH_CLOSURE_EXTRA_ARTIFACT");
});

test("GOLDEN-GATE-SABOTAGE: a truncated lifecycle makes the gate reject the golden", () => {
  // The lifecycle is the verifier's only route to what the run reached. An empty
  // chain leaves every retained artifact unreachable, which is the shape a
  // regression in reachability derivation would produce.
  const name = invalidGoldens()[0] as string;
  const dir = copyGolden(name);
  writeFileSync(path.join(dir, "lifecycle.json"), "[]\n");

  const verdict = gateAccepts(dir);
  assert.equal(verdict.accepted, false, "a golden with no lifecycle must not be accepted");
});
