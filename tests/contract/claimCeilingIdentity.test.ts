import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CEILING_PATH = path.join("docs", "claims", "claim-ceiling.json");
const CLAIMS_PATH = path.join("docs", "claims", "permitted-claims.md");

const SUPPORTED_SCHEMA_VERSION = "reality-lab-claim-ceiling/v1";
const TOP_LEVEL_FIELDS = ["schema_version", "claim_ceiling_id", "status", "source", "clauses"];
const CLAUSE_FIELDS = ["clause_id", "statement"];

/**
 * Append-only. Each semantic id is bound, once and forever, to the digest of the
 * semantic projection it was minted for. Adding a row is how the ceiling's meaning
 * is allowed to change; rewriting one is not.
 */
const KNOWN_SEMANTIC_DIGESTS: ReadonlyArray<readonly [string, string]> = [
  [
    "reality-lab-claim-ceiling-1",
    "af783569d9186b1504d1488c6f0d2bc29d8ca43baa74fbf9a71ebe96811a298c",
  ],
];

/** A semantic id: lowercase words, hyphen separated, ending in a revision ordinal. */
const SEMANTIC_ID = /^[a-z][a-z0-9]*(-[a-z0-9]+)*-[1-9][0-9]*$/;
/** A clause id: lowercase words, hyphen separated. No ordinal required. */
const CLAUSE_ID = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

const SHA256_SHAPED = /^[0-9a-f]{64}$/;
const COMMIT_SHAPED = /^[0-9a-f]{7,40}$/;
const DATE_SHAPED = /\d{4}-\d{2}-\d{2}/;
const BRANCH_SHAPED = /^(main|master|HEAD)$|\//;

type Clause = { clause_id: string; statement: string };
type Ceiling = {
  schema_version: string;
  claim_ceiling_id: string;
  status: string;
  source: string;
  clauses: Clause[];
};

const rawCeiling = readFileSync(path.join(repoRoot, CEILING_PATH), "utf8");
const claimsMarkdown = readFileSync(path.join(repoRoot, CLAIMS_PATH), "utf8");
const readme = readFileSync(path.join(repoRoot, "README.md"), "utf8");

/**
 * The semantic projection: ordered clause ids and statements, and nothing else.
 * Deliberately excludes the identifier itself (so a new id cannot buy a new digest),
 * the source anchor, the status, formatting and every byte of repository metadata.
 */
function semanticProjection(value: { clauses: ReadonlyArray<Clause> }): string {
  return JSON.stringify(value.clauses.map((clause) => [clause.clause_id, clause.statement]));
}

function semanticDigest(value: { clauses: ReadonlyArray<Clause> }): string {
  return createHash("sha256").update(semanticProjection(value), "utf8").digest("hex");
}

function parsed(): Ceiling {
  return JSON.parse(rawCeiling) as Ceiling;
}

/** The whole contract, so a mutated copy can be put through exactly what the file is. */
function validate(value: unknown): void {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
  const record = value as Record<string, unknown>;

  assert.deepEqual(
    Object.keys(record).slice().sort(),
    TOP_LEVEL_FIELDS.slice().sort(),
    "the top-level object is closed: no unknown and no missing fields",
  );
  assert.equal(typeof record["schema_version"], "string");
  assert.equal(typeof record["claim_ceiling_id"], "string");
  assert.equal(typeof record["status"], "string");
  assert.equal(typeof record["source"], "string");
  assert.equal(Array.isArray(record["clauses"]), true);

  assert.equal(record["schema_version"], SUPPORTED_SCHEMA_VERSION);
  assert.equal(record["status"], "active");
  assert.equal(record["source"], "docs/claims/permitted-claims.md");

  const id = record["claim_ceiling_id"] as string;
  assert.match(id, SEMANTIC_ID, "the identifier is a semantic id");
  assert.equal(SHA256_SHAPED.test(id), false, "the identifier is not a sha256");
  assert.equal(COMMIT_SHAPED.test(id), false, "the identifier is not a commit hash");
  assert.equal(DATE_SHAPED.test(id), false, "the identifier is not a date");
  assert.equal(BRANCH_SHAPED.test(id), false, "the identifier is not a branch name");

  const clauses = record["clauses"] as unknown[];
  assert.ok(clauses.length > 0, "the clause list is non-empty");
  for (const clause of clauses) {
    assert.equal(typeof clause, "object");
    assert.notEqual(clause, null);
    const entry = clause as Record<string, unknown>;
    assert.deepEqual(
      Object.keys(entry).slice().sort(),
      CLAUSE_FIELDS.slice().sort(),
      "each clause is closed",
    );
    assert.equal(typeof entry["clause_id"], "string");
    assert.equal(typeof entry["statement"], "string");
    assert.match(entry["clause_id"] as string, CLAUSE_ID);
    assert.ok((entry["statement"] as string).trim().length > 0, "statements are non-empty");
  }

  const ids = clauses.map((c) => (c as Clause).clause_id);
  assert.equal(new Set(ids).size, ids.length, "clause ids are unique");
  const statements = clauses.map((c) => (c as Clause).statement);
  assert.equal(new Set(statements).size, statements.length, "statements are unique");

  const known = new Map(KNOWN_SEMANTIC_DIGESTS);
  const digest = known.get(id);
  assert.ok(digest !== undefined, `no known semantic digest is bound to ${id}`);
  assert.equal(
    semanticDigest({ clauses: clauses as Clause[] }),
    digest,
    "the semantics under this id are the semantics the id was minted for",
  );
}

test("the structured claim ceiling parses and satisfies its closed shape", () => {
  validate(parsed());
});

test("the semantic id map is append-only and one id per meaning", () => {
  const ids = KNOWN_SEMANTIC_DIGESTS.map(([id]) => id);
  assert.equal(new Set(ids).size, ids.length, "semantic ids are unique");
  const digests = KNOWN_SEMANTIC_DIGESTS.map(([, digest]) => digest);
  assert.equal(
    new Set(digests).size,
    digests.length,
    "semantic digests are unique, so a new id for unchanged semantics has nowhere to land",
  );
  for (const [id, digest] of KNOWN_SEMANTIC_DIGESTS) {
    assert.match(id, SEMANTIC_ID);
    assert.match(digest, SHA256_SHAPED);
  }
});

test("no clause carries repository metadata, a product name or wording above the ceiling", () => {
  for (const { clause_id, statement } of parsed().clauses) {
    const where = `clause ${clause_id}`;
    assert.equal(/(^|\s)\/[A-Za-z]|[A-Za-z]:\\/.test(statement), false, `${where}: absolute path`);
    assert.equal(/\b[0-9a-f]{40}\b|\b[0-9a-f]{64}\b/.test(statement), false, `${where}: hash`);
    assert.equal(DATE_SHAPED.test(statement), false, `${where}: timestamp`);
    assert.equal(/\d{2}:\d{2}:\d{2}/.test(statement), false, `${where}: timestamp`);
    assert.equal(/qualiber/i.test(statement), false, `${where}: product-specific statement`);
    for (const forbidden of [
      "bias-free",
      "collusion-proof",
      "universal",
      "production-ready",
      "architecturally independent",
      "architectural independence",
      "is certified",
      "authenticated certification",
      "held-out claim",
      "blind claim may",
    ]) {
      assert.equal(
        statement.toLowerCase().includes(forbidden),
        false,
        `${where}: wording above the current ceiling (${forbidden})`,
      );
    }
  }
});

test("the evaluator-owned analytics-shaped-JSON phrase is absent", () => {
  const all = parsed()
    .clauses.map((clause) => `${clause.clause_id} ${clause.statement}`)
    .join("\n")
    .toLowerCase();
  assert.equal(all.includes("analytics-shaped"), false);
  assert.equal(all.includes("opentelemetry in these scenarios"), false);
  assert.equal(all.includes("request bodies"), false);
  assert.equal(rawCeiling.toLowerCase().includes("qualiber"), false);
});

test("the active ceiling is still T1, development tier and non-blind, and widens nothing", () => {
  const ceiling = parsed();
  assert.equal(ceiling.claim_ceiling_id, "reality-lab-claim-ceiling-1");
  const byId = new Map(ceiling.clauses.map((clause) => [clause.clause_id, clause.statement]));

  const t1 = byId.get("t1-ceiling-derived");
  assert.ok(t1 !== undefined && t1.includes("derives T1"), "T1 is still the derived ceiling");

  const higher = byId.get("no-t2-no-t3");
  assert.ok(higher !== undefined && /No T2 and no T3/.test(higher), "T2 and T3 stay refused");

  const blind = byId.get("development-tier-non-blind-selection");
  assert.ok(
    blind !== undefined && blind.includes("non-blind") && blind.includes("development tier"),
    "selection is still non-blind at development tier only",
  );

  // Every clause is a bound, so each one must be sourced by the document it cites.
  assert.ok(claimsMarkdown.includes("Every terminal this build can produce derives T1"));
  assert.ok(claimsMarkdown.includes("No T2 and no T3"));
  assert.ok(claimsMarkdown.includes("No held-out or blind claim"));
  assert.ok(claimsMarkdown.includes("Zero calibration runs"));
});

test("the Markdown points at the structured file and names the active id exactly once", () => {
  assert.ok(claimsMarkdown.includes("claim-ceiling.json"), "the Markdown points at the JSON");
  const occurrences = claimsMarkdown.split("reality-lab-claim-ceiling-1").length - 1;
  assert.equal(occurrences, 1, "the active id is named exactly once");
  assert.ok(claimsMarkdown.includes("claim_ceiling_id"), "consumers are told what to pin");
});

test("the README links the structured file", () => {
  assert.ok(readme.includes("docs/claims/claim-ceiling.json"));
});

// --- negative cases: each mutation must be refused ------------------------------

function mutant(mutate: (value: Record<string, unknown>) => void): Record<string, unknown> {
  const copy = JSON.parse(rawCeiling) as Record<string, unknown>;
  mutate(copy);
  return copy;
}

/** Indexed access under `noUncheckedIndexedAccess`, for fixtures that know their own shape. */
function clauseAt(clauses: Clause[], index: number): Clause {
  const clause = clauses[index];
  assert.ok(clause !== undefined, `fixture expects a clause at ${index}`);
  return clause;
}

const REFUSALS: ReadonlyArray<readonly [string, () => Record<string, unknown>]> = [
  ["a missing semantic id", () => mutant((v) => delete v["claim_ceiling_id"])],
  [
    "a digest-shaped semantic id",
    () => mutant((v) => (v["claim_ceiling_id"] = "a".repeat(64))),
  ],
  [
    "a duplicate clause id",
    () =>
      mutant((v) => {
        const clauses = v["clauses"] as Clause[];
        clauses[1] = { ...clauseAt(clauses, 1), clause_id: clauseAt(clauses, 0).clause_id };
      }),
  ],
  [
    "a duplicate statement",
    () =>
      mutant((v) => {
        const clauses = v["clauses"] as Clause[];
        clauses[1] = { ...clauseAt(clauses, 1), statement: clauseAt(clauses, 0).statement };
      }),
  ],
  [
    "a changed statement under the existing id",
    () =>
      mutant((v) => {
        const clauses = v["clauses"] as Clause[];
        const first = clauseAt(clauses, 0);
        clauses[0] = { ...first, statement: `${first.statement} Also T2 is permitted.` };
      }),
  ],
  [
    "a new id over an unchanged semantic projection",
    () => mutant((v) => (v["claim_ceiling_id"] = "reality-lab-claim-ceiling-2")),
  ],
  [
    "an unknown top-level field",
    () => mutant((v) => (v["signed_by"] = "some-authority")),
  ],
  [
    "a malformed source path",
    () => mutant((v) => (v["source"] = "/Users/someone/docs/claims/permitted-claims.md")),
  ],
  ["an empty clause list", () => mutant((v) => (v["clauses"] = []))],
  ["a status other than active", () => mutant((v) => (v["status"] = "draft"))],
  ["an unsupported schema version", () => mutant((v) => (v["schema_version"] = "reality-lab-claim-ceiling/v2"))],
];

for (const [description, build] of REFUSALS) {
  test(`the contract refuses ${description}`, () => {
    assert.throws(() => validate(build()));
  });
}

test("the contract refuses the evaluator-owned phrase being absorbed", () => {
  const absorbed = mutant((v) => {
    (v["clauses"] as Clause[]).push({
      clause_id: "analytics-shaped-json-consumption",
      statement:
        "Qualiber does not consume OpenTelemetry in these scenarios — it reads analytics-shaped JSON request bodies, whatever the substrate is named.",
    });
  });
  // It is refused twice over: the semantics no longer match the minted id, and the
  // phrase itself is one this file may not carry.
  assert.throws(() => validate(absorbed));
  const added = (absorbed["clauses"] as Clause[]).at(-1);
  assert.ok(added !== undefined);
  assert.equal(/qualiber/i.test(added.statement), true, "the fixture is the phrase in question");
});

// --- stability: non-semantic change must not move the digest ---------------------

test("formatting and non-semantic metadata do not move the semantic projection", () => {
  const ceiling = parsed();
  const baseline = semanticDigest(ceiling);

  const reformatted = JSON.parse(JSON.stringify(ceiling, null, 8)) as Ceiling;
  assert.equal(semanticDigest(reformatted), baseline, "indentation is not meaning");

  const reordered = JSON.parse(
    JSON.stringify({
      clauses: ceiling.clauses,
      source: ceiling.source,
      status: ceiling.status,
      claim_ceiling_id: ceiling.claim_ceiling_id,
      schema_version: ceiling.schema_version,
    }),
  ) as Ceiling;
  assert.equal(semanticDigest(reordered), baseline, "top-level key order is not meaning");

  const reanchored = { ...ceiling, source: "docs/claims/permitted-claims.md#what-may-not-be-claimed" };
  assert.equal(semanticDigest(reanchored), baseline, "a source anchor is not meaning");

  const renamed = { ...ceiling, claim_ceiling_id: "reality-lab-claim-ceiling-99" };
  assert.equal(
    semanticDigest(renamed),
    baseline,
    "the id is outside the projection, which is what makes a bare rename detectable",
  );
});
