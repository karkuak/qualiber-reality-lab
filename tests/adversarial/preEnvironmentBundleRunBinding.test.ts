/**
 * A pre-environment public bundle must name the run its attestation signs.
 *
 * ## How this was found
 *
 * Not by design review. The valid-golden gate (R-02) needed a sabotage case, and
 * the first one written mutated the bundle's top-level `run_id`. The verifier
 * returned **exit 0, verdict `valid`**. The sabotage case was rewritten to
 * mutate a bundle member instead — and the accepted mutation was the finding.
 *
 * ## What the defect is, and what it is not
 *
 * `bundle.run_id` is an unsigned scalar in an unsigned envelope. A reader can
 * edit it and recompute `bundle.core_hash`, and the document is then internally
 * self-consistent: no signature covers it, no hash contradicts it, and no schema
 * rejects it. The **environment** branch has always required
 * `attestation.run_id === bundle.run_id`; the pre-environment branch did not.
 *
 * It produced no wrong verdict about the run. Every derivation on this path
 * takes its run identity from `attestation.run_id`, which *is* signed, so the
 * closure, the signer inventory and the terminal were always derived from the
 * real run. What it permitted is a bundle that **presents itself** as a
 * different run than the one it attests — which is precisely what a reader
 * relies on when filing, indexing or citing evidence by run id. That makes it a
 * bundle-consistency defect, closed with the same typed code the environment
 * branch uses.
 *
 * ## What this file proves
 *
 * The exploit is built to be airtight rather than convenient: the mutation is
 * made self-consistent before the verifier sees it, and the test asserts that
 * self-consistency itself. A refusal that came from a stale `core_hash`, a
 * schema violation or an unreadable artifact would prove nothing about the
 * binding, so the typed code and its message are both asserted, and the
 * unmutated copy is verified clean in the same file. **The live goldens are
 * never written to.**
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { chmodSync, cpSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { coreHash } from "@erl2/integrity";
import { erl2 } from "../support/cliRun.js";
import { ownedTempDir } from "../support/tempDirs.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const GOLDEN = path.join(repoRoot, "fixtures", "golden", "valid-pre-environment-run");

/** A disposable copy of the shipped valid golden. */
function copyGolden(): string {
  const dest = ownedTempDir("erl2-runbind-");
  cpSync(GOLDEN, dest, { recursive: true });
  return dest;
}

/** The offline verifier, in a fresh process, exactly as an external consumer runs it. */
function verifyOffline(dir: string): { readonly exitCode: number; readonly code: string; readonly message: string; readonly verdict: string } {
  const result = erl2([
    "verify",
    "--public-bundle", path.join(dir, "public-bundle.json"),
    "--root-config", path.join(dir, "root-config.json"),
    "--artifact-root", path.join(dir, "artifacts"),
    "--lifecycle", path.join(dir, "lifecycle.json"),
    "--offline",
  ]);
  const body = result.body as { data?: { verdict?: string }; errors: { code: string; message: string }[] };
  return {
    exitCode: result.exitCode,
    code: body.errors[0]?.code ?? "-",
    message: body.errors[0]?.message ?? "",
    verdict: body.data?.verdict ?? "-",
  };
}

/**
 * Rewrites only the bundle's top-level `run_id` and restores self-consistency.
 *
 * Returns the attestation's run id so the caller can assert the two really do
 * differ — a "mismatch" test whose two values happened to agree would pass for
 * the wrong reason.
 */
function forgeBundleRunId(dir: string, forged: string): { readonly attestationRunId: string } {
  const bundlePath = path.join(dir, "public-bundle.json");
  const original = JSON.parse(readFileSync(bundlePath, "utf8")) as Record<string, unknown> & {
    core_hash: string;
    run_id: string;
  };
  const { core_hash: _discarded, ...body } = original;
  const forgedBody = { ...body, run_id: forged };
  // Recomputed, not stale: the document the verifier reads must be one that no
  // integrity check can refuse, so that the refusal can only come from the
  // binding under test.
  const forgedBundle = { ...forgedBody, core_hash: coreHash(forgedBody) };
  chmodSync(bundlePath, 0o644);
  writeFileSync(bundlePath, `${JSON.stringify(forgedBundle, null, 2)}\n`);

  const attestation = JSON.parse(
    readFileSync(path.join(dir, "artifacts", "retained", "final-attestation.json"), "utf8"),
  ) as { run_id: string };
  return { attestationRunId: attestation.run_id };
}

test("RUNBIND-BASELINE: the unmutated pre-environment golden verifies offline", () => {
  // Without this, a binding test proves only that breaking something breaks it.
  const outcome = verifyOffline(copyGolden());
  assert.equal(outcome.exitCode, 0, `${outcome.code}: ${outcome.message}`);
  assert.equal(outcome.verdict, "valid");
});

test("RUNBIND: a self-consistent bundle naming a different run than its attestation is refused", () => {
  const dir = copyGolden();
  const forged = "00000000-0000-7000-8000-ffffffffffff";
  const { attestationRunId } = forgeBundleRunId(dir, forged);
  assert.notEqual(attestationRunId, forged, "the exploit must actually create a mismatch");

  // The forged document is internally self-consistent before the verifier sees
  // it. Asserted here rather than assumed, because the whole value of the case
  // is that the refusal cannot be a stale-hash or schema refusal wearing the
  // right name.
  const written = JSON.parse(readFileSync(path.join(dir, "public-bundle.json"), "utf8")) as Record<
    string,
    unknown
  > & { core_hash: string; run_id: string };
  const { core_hash: declared, ...body } = written;
  assert.equal(coreHash(body), declared, "the forged bundle must be self-consistent");
  assert.equal(written.run_id, forged);

  // Nothing else moved: the signed attestation and every retained artifact are
  // byte-identical to the shipped fixture.
  for (const relative of [
    path.join("artifacts", "retained", "final-attestation.json"),
    path.join("artifacts", "retained", "signer-inventory.json"),
    path.join("artifacts", "retained", "trust-policy.json"),
    "lifecycle.json",
    "root-config.json",
  ]) {
    assert.deepEqual(
      readFileSync(path.join(dir, relative)),
      readFileSync(path.join(GOLDEN, relative)),
      `${relative} must be untouched by the exploit`,
    );
  }

  const outcome = verifyOffline(dir);
  assert.notEqual(outcome.exitCode, 0, `the forged bundle must be refused; verdict ${outcome.verdict}`);
  assert.equal(
    outcome.code,
    "GRAPH_CLOSURE_TERMINAL_MISMATCH",
    `the refusal must be the run binding, not a schema or hash refusal: ${outcome.message}`,
  );
  assert.match(outcome.message, /different runs/);
});

test("RUNBIND: the environment branch already refused the same shape, and still does", () => {
  // The binding was added to the pre-environment branch only. This asserts the
  // environment branch's copy is still there and still typed the same way, so a
  // future edit cannot close one and open the other.
  const source = readFileSync(
    path.join(repoRoot, "packages", "public-verifier", "src", "library", "verify.ts"),
    "utf8",
  );
  const occurrences = source.split("if (attestation.run_id !== bundle.run_id) {").length - 1;
  assert.equal(occurrences, 2, "both bundle variants must carry the binding");
  assert.equal(
    source.split('"the bundle and the attestation name different runs"').length - 1,
    2,
    "both must refuse with the same wording",
  );
});
