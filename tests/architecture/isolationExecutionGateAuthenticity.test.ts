/**
 * The execution-gate authenticity wiring cannot silently regress, and the
 * container activation still has no production caller (EQ-L-010 / EQ-L-011).
 *
 * EQ-L-011's truth condition is executable: `permitted-claims.md` says the
 * pre-run gate verifies the lock signature and the probe manifest, so
 * `assertQualifiedForExecution` must actually invoke both verifiers. A behavioural
 * test proves it refuses a forgery; this static guard proves the two calls are
 * present in the gate, so a refactor that dropped one — leaving the forgery
 * refused only by luck of ordering — would fail here rather than in review.
 *
 * The second property keeps the reachability statement honest: the review found
 * `deriveContainerProfileActivation` has no production caller (only tests and an
 * `index.ts` re-export). If one is ever added, this test fails and the claim in
 * `permitted-claims.md` must be updated deliberately, not left stale.
 */
import { strict as assert } from "node:assert";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const GATE_PATH = path.join(
  repoRoot,
  "packages",
  "core",
  "src",
  "adapter",
  "isolationQualificationReport.ts",
);

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const child = path.join(dir, name);
    if (statSync(child).isDirectory()) out.push(...tsFiles(child));
    else if (child.endsWith(".ts")) out.push(child);
  }
  return out;
}

test("ISOLATION-GATE-ARCH: assertQualifiedForExecution invokes both isolation-authenticity verifiers", () => {
  const source = readFileSync(GATE_PATH, "utf8");

  // The gate function body — from its declaration to the next top-level export.
  const start = source.indexOf("export function assertQualifiedForExecution");
  assert.ok(start >= 0, "assertQualifiedForExecution must be defined in the gate module");
  const rest = source.slice(start);
  const end = rest.indexOf("\nexport function ", 1);
  const body = end >= 0 ? rest.slice(0, end) : rest;

  for (const verifier of ["verifyIsolationLockSignature", "verifyIsolationProbeManifest"]) {
    assert.ok(
      new RegExp(`${verifier}\\(`).test(body),
      `assertQualifiedForExecution must call ${verifier} — the pre-run gate the claim names must actually verify`,
    );
  }
  // Fail-closed on both distinguished manifest failures, not just a bad signature.
  assert.ok(body.includes("ENV_ISOLATION_LOCK_UNAUTHENTIC"), "the gate must refuse an unauthentic lock");
  assert.ok(
    body.includes("ENV_ISOLATION_PROBE_MANIFEST_UNAUTHENTIC"),
    "the gate must refuse an unauthentic or absent probe manifest",
  );
  assert.ok(
    /status === "absent" \|\| .*status === "invalid"/.test(body),
    "the gate must fail closed on both an absent and an invalid probe manifest",
  );
});

test("ISOLATION-GATE-ARCH: no production module imports deriveContainerProfileActivation", () => {
  const productionSources = tsFiles(path.join(repoRoot, "packages"))
    .map((file) => ({ file, rel: path.relative(repoRoot, file).split(path.sep).join("/") }))
    // Source only — never the compiled `dist/**` mirror or `.d.ts` declarations.
    .filter(({ rel }) => rel.includes("/src/") && !rel.includes("/dist/"))
    .filter(({ rel }) => !/(^|\/)(test|tests)(\/|$)/.test(rel));

  const importers = productionSources
    .filter(({ rel }) => {
      // The definition lives in sandbox.ts; the public surface re-exports it in
      // index.ts. Neither is a *caller* that reaches the activation path.
      if (rel === "packages/core/src/adapter/sandbox.ts") return false;
      if (rel === "packages/core/src/index.ts") return false;
      const source = readFileSync(path.join(repoRoot, rel), "utf8");
      // A real caller either calls it or imports the symbol — a prose mention in
      // a doc comment (e.g. host.ts's) is not a caller and must not trip this.
      return (
        /\bderiveContainerProfileActivation\s*\(/.test(source) ||
        /import[^;]*\bderiveContainerProfileActivation\b/.test(source)
      );
    })
    .map(({ rel }) => rel);

  assert.deepEqual(
    importers,
    [],
    "deriveContainerProfileActivation gained a production caller; the 'no production caller' " +
      "reachability statement in permitted-claims.md must be revisited before this passes",
  );
});
