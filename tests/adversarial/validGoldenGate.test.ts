/**
 * The valid-golden evidence gate (review R-02).
 *
 * ## The blind spot this closes
 *
 * ADR-ERL2-029 §7's argument was never about invalidity. It was about *where the
 * result is recorded*: `generate-evidence.mjs` runs `erl2 verify --offline` over
 * `valid-pre-environment-run` and pushes the outcome into `transcript`, and
 * `cli-transcript.json` is the single file excluded from the byte pin. So a
 * verifier regression that started rejecting historically-pinned **valid**
 * bundles — a contract tightening, a new required role, a stricter closure —
 * changed no producer bytes and left `evidence:verify` green. The invalid half
 * of that argument was closed; this is the other half.
 *
 * ## What these cases prove, and what they do not
 *
 * The gate's acceptance condition is exactly `exit_code === 0 && data.verdict
 * === "valid"`, evaluated over a pinned fixture in a fresh `erl2 verify`
 * process. Each case below evaluates that same condition the same way over a
 * **copy**, so what is measured is the decision the gate makes rather than a
 * paraphrase of it.
 *
 * They do not re-run `generate-evidence.mjs --verify` itself: that script reads
 * `fixtures/golden` by construction, and pointing it at a sabotaged tree would
 * mean either writing to the real goldens or adding a root override whose only
 * caller is a test. The enumeration and the count assertion inside the gate are
 * what make the fixture list unfakeable; these cases are what make the
 * per-fixture verdict unfakeable. **The live goldens are never written to.**
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { chmodSync, cpSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { coreHash } from "@erl2/integrity";
import { erl2 } from "../support/cliRun.js";
import { ownedTempDir } from "../support/tempDirs.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const goldenRoot = path.join(repoRoot, "fixtures", "golden");

/** The exact count the shipped gate declares in `EXPECTED_VALID_GOLDENS`. */
const EXPECTED_VALID_GOLDENS = 1;

/**
 * Enumerated exactly as the gate enumerates: a golden directory carrying a
 * `public-bundle.json` at its root. One level deep, because
 * `**\/artifacts/retained/public-bundle.json` belongs to a run's own artifact
 * tree and is not a fixture root.
 */
function validGoldens(): readonly string[] {
  return readdirSync(goldenRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => statSync(path.join(goldenRoot, name, "public-bundle.json"), { throwIfNoEntry: false }) !== undefined)
    .sort();
}

/** A disposable copy of one golden; the live fixture is never touched. */
function copyGolden(name: string): string {
  const dest = ownedTempDir("erl2-valid-sabotage-");
  cpSync(path.join(goldenRoot, name), dest, { recursive: true });
  return dest;
}

/** The gate's own acceptance condition, evaluated the way the gate evaluates it. */
function gateAccepts(dir: string): { readonly accepted: boolean; readonly code: string } {
  const result = erl2([
    "verify",
    "--public-bundle", path.join(dir, "public-bundle.json"),
    "--root-config", path.join(dir, "root-config.json"),
    "--artifact-root", path.join(dir, "artifacts"),
    "--lifecycle", path.join(dir, "lifecycle.json"),
    "--offline",
  ]);
  const body = result.body as { data?: { verdict?: string }; errors: { code: string }[] };
  return {
    accepted: result.exitCode === 0 && body.data?.verdict === "valid",
    code: body.errors[0]?.code ?? "-",
  };
}

/** Every byte of every shipped valid golden, as one digest. */
function digestLiveGolden(): { readonly digest: string; readonly fileCount: number } {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else files.push(abs);
    }
  };
  for (const name of validGoldens()) walk(path.join(goldenRoot, name));
  return {
    digest: coreHash({
      files: files.map((f) => ({
        path: f.split(path.sep).join("/"),
        bytes: readFileSync(f).toString("base64"),
      })),
    }),
    fileCount: files.length,
  };
}

// Taken at module load, which is before the first case runs.
const { digest: LIVE_DIGEST_AT_IMPORT, fileCount: LIVE_FILE_COUNT_AT_IMPORT } = digestLiveGolden();

test("VALID-GATE: every valid golden the gate enumerates is accepted unsabotaged", () => {
  // The half a sabotage-only test cannot give: without it, a fixture broken from
  // the day it lands passes a gate that only checks that breaking things breaks
  // them.
  const goldens = validGoldens();
  assert.ok(goldens.length > 0, "the gate has fixtures to enumerate");
  for (const name of goldens) {
    const verdict = gateAccepts(copyGolden(name));
    assert.equal(verdict.accepted, true, `${name} must verify clean: ${verdict.code}`);
  }
});

test("VALID-GATE: enumeration and the declared count agree with the shipped tree", () => {
  // Count drift in either direction is detectable here and in the gate itself. A
  // valid golden that quietly leaves — or one that lands outside the gate — moves
  // this number, and the gate exits non-zero until `EXPECTED_VALID_GOLDENS` is
  // updated in the same commit.
  const goldens = validGoldens();
  assert.equal(
    goldens.length,
    EXPECTED_VALID_GOLDENS,
    `valid-golden coverage moved: ${goldens.join(", ")}. Update EXPECTED_VALID_GOLDENS in scripts/generate-evidence.mjs too.`,
  );
  assert.deepEqual(goldens, ["valid-pre-environment-run"]);

  // The enumeration rule is a property of the fixture root, not of a name
  // prefix, and it must not reach into a run's own artifact tree.
  const nested = path.join(goldenRoot, "valid-pre-environment-run", "artifacts", "retained", "public-bundle.json");
  assert.ok(
    statSync(nested, { throwIfNoEntry: false }) !== undefined,
    "the fixture carries a retained bundle inside its artifact tree",
  );
  assert.equal(goldens.includes("artifacts"), false, "enumeration must stay one level deep");
});

test("VALID-GATE-SABOTAGE: a mutated public bundle makes the gate reject the golden", () => {
  // The exact shape the gate exists to catch: a bundle whose bytes no longer
  // verify, in a file whose real verification outcome used to be recorded only
  // in the one file excluded from the byte pin.
  //
  // `final_attestation` rather than a scalar like `run_id`: the bundle's members
  // are what the verifier re-derives, and a scalar the verifier does not
  // cross-check would make this case pass for the wrong reason — it did, on the
  // first attempt.
  const dir = copyGolden(validGoldens()[0] as string);
  const bundlePath = path.join(dir, "public-bundle.json");
  const bundle = JSON.parse(readFileSync(bundlePath, "utf8")) as Record<string, unknown>;
  const attestation = bundle["final_attestation"] as Record<string, unknown>;
  chmodSync(bundlePath, 0o644);
  writeFileSync(
    bundlePath,
    JSON.stringify({
      ...bundle,
      final_attestation: { ...attestation, core_hash: `sha256:${"e".repeat(64)}` },
    }),
  );

  const verdict = gateAccepts(dir);
  assert.equal(verdict.accepted, false, "a mutated public bundle must not be accepted");
  assert.notEqual(verdict.code, "-", "the refusal must carry a typed code, not an empty verdict");
});

test("VALID-GATE-SABOTAGE: an unaccounted retained extra makes the gate reject the golden", () => {
  // Self-consistent and correctly hashed, so nothing catches it on bytes. It is
  // refused for being a retained artifact the closure never derived.
  const dir = copyGolden(validGoldens()[0] as string);
  const body = { schema_version: "rogue-artifact/v1", run_id: "rogue", note: "unaccounted" };
  writeFileSync(
    path.join(dir, "artifacts", "retained", "rogue.json"),
    JSON.stringify({ ...body, core_hash: coreHash(body) }),
  );

  const verdict = gateAccepts(dir);
  assert.equal(verdict.accepted, false, "an unaccounted retained extra must not be accepted");
});

test("VALID-GATE-SABOTAGE: a truncated lifecycle makes the gate reject the golden", () => {
  // The lifecycle is the verifier's only route to what the run reached. An empty
  // chain leaves every retained artifact unreachable — the shape a regression in
  // reachability derivation would produce.
  const dir = copyGolden(validGoldens()[0] as string);
  writeFileSync(path.join(dir, "lifecycle.json"), "[]\n");

  const verdict = gateAccepts(dir);
  assert.equal(verdict.accepted, false, "a golden with no lifecycle must not be accepted");
});

test("VALID-GATE: the live golden is byte-identical after every sabotage above", () => {
  // Sabotage runs against copies. This is the assertion that says so rather than
  // a comment claiming it, and it is load-bearing because `LIVE_DIGEST_AT_IMPORT`
  // was computed at module load — before the first case ran. A sabotage that
  // reached the shipped fixture instead of its copy moves this digest.
  //
  // It is the last case in the file on purpose: `node --test` runs a file's
  // top-level cases in declaration order in one process, so "after every
  // sabotage above" is exactly what it says.
  const { digest, fileCount } = digestLiveGolden();
  assert.ok(fileCount > 0, "the live golden has files to check");
  assert.equal(fileCount, LIVE_FILE_COUNT_AT_IMPORT, "no file was added to or removed from the shipped fixture");
  assert.equal(digest, LIVE_DIGEST_AT_IMPORT, "the live golden must not have moved while the sabotage cases ran");
});
