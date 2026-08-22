/**
 * A public bundle stamped with a date that does not exist.
 *
 * ## The gap
 *
 * ADR-ERL2-043 B4 refuses a bundle that claims to have been created before the
 * attestation it carries was signed, comparing `created_at` with the signed
 * `finalized_at` through `Date.parse`. That check is only as honest as the
 * contract beneath it, and `Instant` used to be a shape check rather than a
 * calendar. `2026-06-31T23:59:59Z` satisfied it; June has thirty days; and
 * `Date.parse` does not refuse the thirty-first — it rolls forward to
 * `2026-07-01T23:59:59Z`.
 *
 * So a bundle whose `created_at` **reads** as June could be compared as July
 * and accepted against a July finalization. The verifier was not wrong about
 * the ordering it computed; the document said something other than what it was
 * compared as, which is the same defect ADR-ERL2-043 exists to close, one layer
 * down.
 *
 * ## What these cases pin
 *
 * The stamp is written into **both** the retained and the supplied copy and
 * both are resealed, so the supplied-to-retained binding (B3) is satisfied by
 * construction and cannot be the thing answering. What is left is exactly the
 * timestamp.
 *
 * They also pin the two directions B4 still owns, so that closing this cannot
 * quietly swallow it: a genuinely back-dated *real* instant keeps
 * `GRAPH_CLOSURE_TERMINAL_MISMATCH`, and a post-dated one stays accepted as the
 * non-authoritative residue `permitted-claims.md` names.
 *
 * Pre-environment only, deliberately: the refusal is in `assertContract`, which
 * both terminal branches enter through the same shared `Instant` definition,
 * and `tests/contract/instantCalendarValidity.test.ts` pins that definition
 * directly. Building an environment terminal here would add two minutes of wall
 * clock and no coverage.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { chmodSync, cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { coreHash } from "@erl2/integrity";
import { erl2 } from "../support/cliRun.js";
import { ownedTempDir } from "../support/tempDirs.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const GOLDEN = path.join(repoRoot, "fixtures", "golden", "valid-pre-environment-run");

type Json = Record<string, unknown>;

interface Terminal {
  readonly artifacts: string;
  readonly lifecycle: string;
  readonly rootConfig: string;
  readonly retainedBundle: string;
  readonly dir: string;
}

function copyGolden(): Terminal {
  const dir = ownedTempDir("erl2-instant-");
  cpSync(GOLDEN, dir, { recursive: true });
  return {
    artifacts: path.join(dir, "artifacts"),
    lifecycle: path.join(dir, "lifecycle.json"),
    rootConfig: path.join(dir, "root-config.json"),
    retainedBundle: path.join(dir, "artifacts", "retained", "public-bundle.json"),
    dir,
  };
}

const readJson = (file: string): Json => JSON.parse(readFileSync(file, "utf8")) as Json;

function overwrite(file: string, text: string): void {
  if (existsSync(file)) chmodSync(file, 0o644);
  writeFileSync(file, text);
}

/** The identity the document would carry if its producer had built it this way. */
function reseal(bundle: Json): Json {
  const body: Json = { ...bundle };
  delete body["core_hash"];
  return { ...body, core_hash: coreHash(body) };
}

/** The signed instant the bundle may not claim to predate. */
function finalizedAt(t: Terminal): string {
  const attestation = readJson(path.join(t.artifacts, "retained", "final-attestation.json"));
  const value = attestation["finalized_at"];
  assert.equal(typeof value, "string", "the attestation carries a finalized_at");
  return value as string;
}

/** Writes the caller-supplied document outside the artifact root, as a consumer holds it. */
function supply(bundle: Json): string {
  const file = path.join(ownedTempDir("erl2-instant-supplied-"), "supplied-bundle.json");
  writeFileSync(file, `${JSON.stringify(bundle, null, 2)}\n`);
  return file;
}

interface Outcome {
  readonly exitCode: number;
  readonly code: string;
  readonly message: string;
  readonly verdict: string;
}

function verify(t: Terminal, suppliedBundle: string): Outcome {
  const result = erl2([
    "verify",
    "--public-bundle", suppliedBundle,
    "--root-config", t.rootConfig,
    "--artifact-root", t.artifacts,
    "--lifecycle", t.lifecycle,
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

/** Rewrites `created_at` in the retained copy and returns the identical supplied copy. */
function stampBothCopies(t: Terminal, createdAt: string): string {
  const rewritten = reseal({ ...readJson(t.retainedBundle), created_at: createdAt });
  overwrite(t.retainedBundle, `${JSON.stringify(rewritten, null, 2)}\n`);
  return supply(rewritten);
}

/**
 * Stamps a reader would misread: each satisfied the old shape check, and each
 * is rolled *forward* by `Date.parse` past the instant its own text names.
 */
const ROLLOVER_STAMPS: ReadonlyArray<readonly [string, string]> = [
  ["2026-06-31T23:59:59Z", "a thirty-first of June"],
  ["2026-02-30T00:00:00Z", "a thirtieth of February"],
  ["2026-02-29T00:00:00Z", "a twenty-ninth of February in a common year"],
  ["2026-04-31T00:00:00Z", "a thirty-first of April"],
  ["2026-01-01T24:00:00Z", "an hour twenty-four"],
];

test("ROLLOVER-BASELINE: the unmodified golden verifies", () => {
  // Without this, every refusal below would prove only that breaking something
  // breaks it.
  const t = copyGolden();
  const outcome = verify(t, supply(readJson(t.retainedBundle)));
  assert.equal(outcome.exitCode, 0, `${outcome.code}: ${outcome.message}`);
  assert.equal(outcome.verdict, "valid");
});

for (const [stamp, what] of ROLLOVER_STAMPS) {
  test(`ROLLOVER: a bundle stamped ${stamp} — ${what} — is refused`, () => {
    const t = copyGolden();

    // The case is only about the rollover if the rollover is real: the stamp
    // must parse to something other than the instant it spells, and must read
    // as no later than the signed finalization it would otherwise have to
    // follow.
    const parsed = Date.parse(stamp);
    assert.equal(Number.isNaN(parsed), false, `${stamp} must still parse`);
    assert.notEqual(
      new Date(parsed).toISOString().replace(/\.\d{3}Z$/u, "Z"),
      stamp,
      `${stamp} must still be a stamp that parses as something else`,
    );

    const outcome = verify(t, stampBothCopies(t, stamp));
    assert.notEqual(outcome.exitCode, 0, `expected a refusal, got verdict ${outcome.verdict}`);
    // Refused as a malformed document rather than as a mis-ordered one, because
    // that is what it is: `assertContract` answers before B4 is reached, and the
    // most fundamental true statement about the document is that it is not a
    // bundle.
    assert.equal(outcome.code, "SCHEMA_VALIDATION_FAILED", outcome.message);
  });
}

test("ROLLOVER-RETAINED: an impossible stamp in the retained copy alone is refused", () => {
  // The supplied document is an honest export of the run's *original* bundle,
  // so the caller has done nothing wrong; the retained artifact is the one that
  // is not what it says. It must still refuse, with a typed code.
  const t = copyGolden();
  const honest = readJson(t.retainedBundle);
  const rewritten = reseal({ ...honest, created_at: "2026-06-31T23:59:59Z" });
  overwrite(t.retainedBundle, `${JSON.stringify(rewritten, null, 2)}\n`);
  const outcome = verify(t, supply(honest));
  assert.notEqual(outcome.exitCode, 0, `expected a refusal, got verdict ${outcome.verdict}`);
  // Already refused before this change, by ADR-ERL2-043 B3: rewriting the
  // retained copy moved its canonical identity away from the document the
  // caller holds. Pinned here so that closing the calendar gap cannot take
  // that cause over — the caller's document is honest, and the cause a reader
  // is given must still say the run's own bundle is the thing that moved.
  assert.equal(outcome.code, "GRAPH_CLOSURE_UNREACHABLE_ARTIFACT", outcome.message);
});

test("ROLLOVER-BACKDATED: a genuinely back-dated real instant keeps its B4 refusal", () => {
  // Closing the calendar gap must not swallow the check it sits under. A real
  // instant one second before the signed finalization is still B4's to refuse,
  // with B4's own cause.
  const t = copyGolden();
  const before = new Date(Date.parse(finalizedAt(t)) - 1000).toISOString().replace(/\.\d{3}Z$/u, "Z");
  const outcome = verify(t, stampBothCopies(t, before));
  assert.equal(outcome.code, "GRAPH_CLOSURE_TERMINAL_MISMATCH", outcome.message);
});

test("ROLLOVER-POSTDATED: a real post-dated instant is still accepted residue", () => {
  // The other direction is documented as non-authoritative in
  // `docs/claims/permitted-claims.md`, and stays that way. This is not a claim
  // that the stamp is true — it is a claim that nothing refuses it.
  const t = copyGolden();
  const after = new Date(Date.parse(finalizedAt(t)) + 3_600_000).toISOString().replace(/\.\d{3}Z$/u, "Z");
  const outcome = verify(t, stampBothCopies(t, after));
  assert.equal(outcome.exitCode, 0, `${outcome.code}: ${outcome.message}`);
  assert.equal(outcome.verdict, "valid");
});
