/**
 * The claim-ceiling identity model, shared by the identity contract and the
 * base-relative append-only check.
 *
 * Two independent protections live here, and a change has to defeat both before
 * the published ceiling can move while keeping the identifier it was minted for.
 *
 * **Source binding.** Every clause in `docs/claims/claim-ceiling.json` is bound to
 * the exact sentences in `docs/claims/permitted-claims.md` it projects. The
 * binding is a bijection over the *whole* declared clause set, each bound sentence
 * must occur in the document exactly once, and a per-clause binding digest covers
 * the sentences and the clause statement together. So a clause cannot move without
 * its source, a source sentence cannot move without its clause, and a clause with
 * no authoritative sentence cannot exist at all — which is what keeps
 * evaluator-owned wording out of the Lab-owned projection.
 *
 * **Append-only history.** `docs/claims/claim-ceiling-history.json` binds each
 * semantic id, once, to the digest of the projection it was minted for. Within a
 * revision this file says which id is active and what it must mean; across
 * revisions {@link ../contract/claimCeilingAppendOnly.test.ts} compares it with an
 * independently obtained prior state, so the rows already published cannot be
 * rewritten, renamed or dropped by the same change that would benefit from it.
 *
 * Neither is signing, authentication or certification, and neither creates a trust
 * tier. They make the identifier durable by construction rather than by
 * convention; nothing here says who wrote the ceiling or vouches for it.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export const CEILING_PATH = path.join("docs", "claims", "claim-ceiling.json");
export const HISTORY_PATH = path.join("docs", "claims", "claim-ceiling-history.json");
export const CLAIMS_PATH = path.join("docs", "claims", "permitted-claims.md");

export const SUPPORTED_SCHEMA_VERSION = "reality-lab-claim-ceiling/v1";
export const SUPPORTED_HISTORY_SCHEMA_VERSION = "reality-lab-claim-ceiling-history/v1";

const TOP_LEVEL_FIELDS = ["schema_version", "claim_ceiling_id", "status", "source", "clauses"];
const CLAUSE_FIELDS = ["clause_id", "statement"];
const HISTORY_FIELDS = ["schema_version", "append_only_base", "entries"];
const HISTORY_ENTRY_FIELDS = ["claim_ceiling_id", "semantic_projection_digest"];

/** A semantic id: lowercase words, hyphen separated, ending in a revision ordinal. */
export const SEMANTIC_ID = /^[a-z][a-z0-9]*(-[a-z0-9]+)*-[1-9][0-9]*$/;
/** A clause id: lowercase words, hyphen separated. No ordinal required. */
export const CLAUSE_ID = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export const SHA256_SHAPED = /^[0-9a-f]{64}$/;
export const COMMIT_SHAPED = /^[0-9a-f]{7,40}$/;
export const FULL_COMMIT_SHAPED = /^[0-9a-f]{40}$/;
export const DATE_SHAPED = /\d{4}-\d{2}-\d{2}/;
export const BRANCH_SHAPED = /^(main|master|HEAD)$|\//;

export type Clause = { clause_id: string; statement: string };
export type Ceiling = {
  schema_version: string;
  claim_ceiling_id: string;
  status: string;
  source: string;
  clauses: Clause[];
};
export type HistoryEntry = { claim_ceiling_id: string; semantic_projection_digest: string };
export type History = {
  schema_version: string;
  append_only_base: string;
  entries: HistoryEntry[];
};

/**
 * The authoritative sentence, or sentences, each clause projects.
 *
 * These are exact text from `docs/claims/permitted-claims.md`, compared after
 * whitespace normalization so that rewrapping a paragraph is not a semantic event.
 * `binding_digest` covers the clause id, these sentences and the clause statement
 * together: neither side of a binding can move alone.
 */
export const CLAUSE_SOURCE_BINDINGS: ReadonlyMap<
  string,
  { readonly statements: readonly string[]; readonly binding_digest: string }
> = new Map([
  [
    "t1-ceiling-derived",
    {
      statements: [
        "**Every terminal this build can produce derives T1**, held there independently by six components",
        "`claim_scope` is **derived from the run's own retained evidence** and re-derived independently by the offline verifier",
      ],
      binding_digest: "9e3c705abdd80de75e94839c7b111deb409e13fba094cea87081f950f6b85ec9",
    },
  ],
  [
    "no-t2-no-t3",
    {
      statements: [
        "- **No T2 and no T3.** Not as a matter of restraint but of derivation",
        "The **ceiling is the weakest applicable component**, and two others still cap at T1 on every run this repository can produce: the selected case is drawn at `development` tier and selection is non-blind, both pending ERL2-OQ-007.",
        "T3 additionally needs historical-reproduction evidence whose contracts belong to slice 12 and do not exist.",
      ],
      binding_digest: "38e84a477d501245fd1b0bec3205a9c5831322b8e0ad2e4963a3c35aa9b1d2a1",
    },
  ],
  [
    "development-tier-non-blind-selection",
    {
      statements: [
        "- **No held-out or blind claim.** ERL2-OQ-007 is unresolved; no external beacon is qualified. Selection runs non-blind at `development` tier only.",
      ],
      binding_digest: "37559cc47fcdf6c57475496e85aa708609f02757876b1349ef1352f0948f79a4",
    },
  ],
  [
    "four-part-environment-bound",
    {
      statements: [
        "- **No claim beyond the four-part bound.** The environment terminal above is development tier, fake driver, trusted reference subject, non-blind selection. It is evidence that the *mechanism* closes, not that any environment, subject or ecosystem was measured.",
      ],
      binding_digest: "779fa0a7c81707d89467b96f2a1609f6d83e41959c54c8e9c97a1b87953b5e10",
    },
  ],
  [
    "no-subject-quality-claim",
    {
      statements: [
        "- **No subject-quality claim of any kind.** The only subjects are the two reference adapters, which exist to exercise the platform.",
        "it says nothing about the quality of the subject behind it, and no real product has been run.",
      ],
      binding_digest: "da9680cb0b9423d6b1f004655ca3cbf0d0c7dd14dce76f9c9b12bcbc748e36db",
    },
  ],
  [
    "sandbox-profile-boundary",
    {
      statements: [
        "- **No OS-level or container isolation claim for any subject the Lab did not author.**",
        "it is available to **trusted, repository-owned reference subjects only** (ADR-ERL2-034)",
        "For every other subject, and on every host without a derived qualification, the only usable profile is `local-process`.",
      ],
      binding_digest: "dee2acdcb62ee86f3530799e64ff4723905e1ec482f393c28473a578dbe4a115",
    },
  ],
  [
    "no-strong-isolation-for-opaque-subjects",
    {
      statements: [
        "- **No strong-isolation claim for opaque subjects.** ERL2-OQ-008 is still unresolved",
        "*What is not earned:* no claim that an **opaque or third-party** subject has been contained, or could be.",
        "the lock and the probe manifest are still development-signed, so the qualification licensing the profile is self-reported",
      ],
      binding_digest: "c658bfb4d464f7448ab96327db2a625034dfb5096c8182160d5157e08a47d63d",
    },
  ],
  [
    "compose-substrate-self-qualified",
    {
      statements: [
        "The substrate lock is signed by the repository's own development governor key, so no independent qualification may be claimed from it either.",
      ],
      binding_digest: "af3b408431f3c1b7e974c5f2d48d0e4218b25ae6a535593541af836b8702a56f",
    },
  ],
  [
    "no-production-certification",
    {
      statements: [
        "Zero calibration runs. Design v2 §25 requires at least ten stable clean or constrained runs before any release authority; that work belongs to Slice 11.",
      ],
      binding_digest: "2b9f825f9ad2499cfcf2caed9be0d62db8e245b42e7077d4b1e2c7fa8455954d",
    },
  ],
]);

export type SourceBindings = typeof CLAUSE_SOURCE_BINDINGS;

/** Whitespace is layout, not meaning: a rewrapped paragraph is the same sentence. */
export function normalizeSource(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * The semantic projection: ordered clause ids and statements, and nothing else.
 * Deliberately excludes the identifier itself (so a new id cannot buy a new digest),
 * the source path, the status, formatting and every byte of repository metadata.
 */
export function semanticProjection(value: { clauses: ReadonlyArray<Clause> }): string {
  return JSON.stringify(value.clauses.map((clause) => [clause.clause_id, clause.statement]));
}

export function semanticDigest(value: { clauses: ReadonlyArray<Clause> }): string {
  return sha256(semanticProjection(value));
}

/** Covers both sides of a binding at once, so neither can move without the other. */
export function bindingDigest(
  clauseId: string,
  statements: readonly string[],
  clauseStatement: string,
): string {
  return sha256(JSON.stringify([clauseId, statements.map(normalizeSource), clauseStatement]));
}

/** The stem of a semantic id: everything before the trailing revision ordinal. */
export function idStem(id: string): string {
  return id.replace(/-[1-9][0-9]*$/, "");
}

/** The revision ordinal of a semantic id. */
export function idOrdinal(id: string): number {
  const match = /-([1-9][0-9]*)$/.exec(id);
  if (match === null) throw new Error(`not a semantic id: ${id}`);
  return Number(match[1]);
}

/** The id a legitimate next revision must use, derived rather than hardcoded. */
export function nextSemanticId(history: History): string {
  const last = history.entries.at(-1);
  if (last === undefined) throw new Error("history is empty");
  return `${idStem(last.claim_ceiling_id)}-${idOrdinal(last.claim_ceiling_id) + 1}`;
}

class ClaimCeilingError extends Error {}

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new ClaimCeilingError(message);
}

function closedShape(record: Record<string, unknown>, fields: readonly string[], what: string): void {
  check(
    JSON.stringify(Object.keys(record).slice().sort()) === JSON.stringify(fields.slice().sort()),
    `${what} is closed: no unknown and no missing fields`,
  );
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  check(typeof value === "object" && value !== null && !Array.isArray(value), `${what} is an object`);
  return value as Record<string, unknown>;
}

/**
 * The append-only history's own contract. Sequencing is a general rule over the
 * declared entries — no revision ordinal is hardcoded — so minting the next id is
 * an ordinary operation rather than a test edit.
 */
export function validateHistory(value: unknown): History {
  const record = asRecord(value, "the history");
  closedShape(record, HISTORY_FIELDS, "the history");
  check(record["schema_version"] === SUPPORTED_HISTORY_SCHEMA_VERSION, "supported history schema");
  const base = record["append_only_base"];
  check(typeof base === "string", "append_only_base is a string");
  check(FULL_COMMIT_SHAPED.test(base), "append_only_base is a full commit sha");

  const entries = record["entries"];
  check(Array.isArray(entries), "the history has an entry list");
  check((entries as unknown[]).length > 0, "the history has at least one entry");

  const parsedEntries: HistoryEntry[] = [];
  for (const raw of entries as unknown[]) {
    const entry = asRecord(raw, "a history entry");
    closedShape(entry, HISTORY_ENTRY_FIELDS, "a history entry");
    const id = entry["claim_ceiling_id"];
    const digest = entry["semantic_projection_digest"];
    check(typeof id === "string", "a history id is a string");
    check(SEMANTIC_ID.test(id), "a history id is a semantic id");
    check(SHA256_SHAPED.test(id) === false, "a history id is not a sha256");
    check(COMMIT_SHAPED.test(id) === false, "a history id is not a commit hash");
    check(DATE_SHAPED.test(id) === false, "a history id is not a date");
    check(BRANCH_SHAPED.test(id) === false, "a history id is not a branch name");
    check(typeof digest === "string", "a history digest is a string");
    check(SHA256_SHAPED.test(digest), "a history digest is a sha256");
    parsedEntries.push({ claim_ceiling_id: id, semantic_projection_digest: digest });
  }

  const ids = parsedEntries.map((entry) => entry.claim_ceiling_id);
  check(new Set(ids).size === ids.length, "semantic ids are unique");
  const digests = parsedEntries.map((entry) => entry.semantic_projection_digest);
  check(
    new Set(digests).size === digests.length,
    "semantic digests are unique, so a new id for unchanged semantics has nowhere to land",
  );

  const stems = new Set(ids.map(idStem));
  check(stems.size === 1, "every revision of this ceiling shares one identifier stem");
  ids.forEach((id, index) => {
    check(idOrdinal(id) === index + 1, `revision ordinals are sequential: ${id} is entry ${index + 1}`);
  });

  return {
    schema_version: record["schema_version"] as string,
    append_only_base: base,
    entries: parsedEntries,
  };
}

/**
 * The whole within-revision contract, so a mutated copy can be put through exactly
 * what the published file is.
 */
export function validateCeiling(
  value: unknown,
  context: { sourceDocument: string; history: History; bindings?: SourceBindings },
): void {
  const bindings = context.bindings ?? CLAUSE_SOURCE_BINDINGS;
  const record = asRecord(value, "the ceiling");
  closedShape(record, TOP_LEVEL_FIELDS, "the top-level object");

  check(record["schema_version"] === SUPPORTED_SCHEMA_VERSION, "supported schema version");
  check(record["status"] === "active", "the published ceiling is active");
  check(
    record["source"] === CLAIMS_PATH.split(path.sep).join("/"),
    "source is the repository-relative document path, with no fragment or anchor",
  );

  const id = record["claim_ceiling_id"];
  check(typeof id === "string", "the identifier is a string");
  check(SEMANTIC_ID.test(id), "the identifier is a semantic id");
  check(SHA256_SHAPED.test(id) === false, "the identifier is not a sha256");
  check(COMMIT_SHAPED.test(id) === false, "the identifier is not a commit hash");
  check(DATE_SHAPED.test(id) === false, "the identifier is not a date");
  check(BRANCH_SHAPED.test(id) === false, "the identifier is not a branch name");

  const rawClauses = record["clauses"];
  check(Array.isArray(rawClauses), "the ceiling has a clause list");
  check((rawClauses as unknown[]).length > 0, "the clause list is non-empty");
  const clauses: Clause[] = [];
  for (const raw of rawClauses as unknown[]) {
    const entry = asRecord(raw, "a clause");
    closedShape(entry, CLAUSE_FIELDS, "each clause");
    const clauseId = entry["clause_id"];
    const statement = entry["statement"];
    check(typeof clauseId === "string", "a clause id is a string");
    check(CLAUSE_ID.test(clauseId), "a clause id is a clause id");
    check(typeof statement === "string", "a statement is a string");
    check(statement.trim().length > 0, "statements are non-empty");
    clauses.push({ clause_id: clauseId, statement });
  }

  const clauseIds = clauses.map((clause) => clause.clause_id);
  check(new Set(clauseIds).size === clauseIds.length, "clause ids are unique");
  const statements = clauses.map((clause) => clause.statement);
  check(new Set(statements).size === statements.length, "statements are unique");

  assertSourceBindings(clauses, context.sourceDocument, bindings);
  assertIdentity(id, clauses, context.history);
}

/**
 * Every declared clause, bound to its authoritative source. A bijection, so the
 * check cannot be satisfied by a subset: an unbound clause and an unclaimed
 * binding are both failures.
 */
export function assertSourceBindings(
  clauses: readonly Clause[],
  sourceDocument: string,
  bindings: SourceBindings = CLAUSE_SOURCE_BINDINGS,
): void {
  const document = normalizeSource(sourceDocument);
  const seen = new Set<string>();

  for (const clause of clauses) {
    const binding = bindings.get(clause.clause_id);
    check(
      binding !== undefined,
      `clause ${clause.clause_id} has no authoritative source binding`,
    );
    check(binding.statements.length > 0, `clause ${clause.clause_id} binds no source statement`);
    seen.add(clause.clause_id);

    for (const statement of binding.statements) {
      const needle = normalizeSource(statement);
      check(needle.length > 0, `clause ${clause.clause_id} binds an empty source statement`);
      const occurrences = document.split(needle).length - 1;
      check(
        occurrences === 1,
        `clause ${clause.clause_id}: its authoritative source statement occurs ${occurrences} times in ${CLAIMS_PATH}, not once — the source moved without the clause`,
      );
    }

    check(
      bindingDigest(clause.clause_id, binding.statements, clause.statement) === binding.binding_digest,
      `clause ${clause.clause_id}: the clause and its authoritative source no longer agree — one moved without the other`,
    );
  }

  for (const boundId of bindings.keys()) {
    check(seen.has(boundId), `source binding ${boundId} names no declared clause`);
  }
}

/** The active id means what the history says it was minted to mean. */
export function assertIdentity(id: string, clauses: readonly Clause[], history: History): void {
  const active = history.entries.at(-1);
  check(active !== undefined, "the history names an active revision");
  check(
    id === active.claim_ceiling_id,
    `the active identifier is ${active.claim_ceiling_id}, not ${id}`,
  );
  check(
    semanticDigest({ clauses }) === active.semantic_projection_digest,
    "the semantics under this id are the semantics the id was minted for",
  );
}

export function readCeilingSources(): {
  rawCeiling: string;
  rawHistory: string;
  claimsMarkdown: string;
  readme: string;
} {
  return {
    rawCeiling: readFileSync(path.join(repoRoot, CEILING_PATH), "utf8"),
    rawHistory: readFileSync(path.join(repoRoot, HISTORY_PATH), "utf8"),
    claimsMarkdown: readFileSync(path.join(repoRoot, CLAIMS_PATH), "utf8"),
    readme: readFileSync(path.join(repoRoot, "README.md"), "utf8"),
  };
}
