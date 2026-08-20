import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  assertSourceBindings,
  bindingDigest,
  CLAUSE_SOURCE_BINDINGS,
  nextSemanticId,
  normalizeSource,
  readCeilingSources,
  semanticDigest,
  semanticProjection,
  validateCeiling,
  validateHistory,
  type Ceiling,
  type Clause,
  type History,
  type HistoryEntry,
  type SourceBindings,
} from "../support/claimCeiling.js";

const { rawCeiling, rawHistory, claimsMarkdown, readme } = readCeilingSources();

function parsed(): Ceiling {
  return JSON.parse(rawCeiling) as Ceiling;
}

const history: History = validateHistory(JSON.parse(rawHistory));

/**
 * The active revision is the history's final row — the same active-row semantics
 * {@link ../support/claimCeiling.ts assertIdentity} and the append-only check enforce.
 * `validateHistory` has already refused an empty entry list, so this names a revision
 * rather than assuming one. Nothing in this suite may name a revision ordinal instead:
 * a literal passes on the revision it was written for and fails the next honest mint.
 */
function activeRevision(): HistoryEntry {
  const entry = history.entries.at(-1);
  assert.ok(entry !== undefined, "the validated history names an active revision");
  return entry;
}

function validate(
  value: unknown,
  overrides: { sourceDocument?: string; history?: History; bindings?: SourceBindings } = {},
): void {
  validateCeiling(value, {
    sourceDocument: overrides.sourceDocument ?? claimsMarkdown,
    history: overrides.history ?? history,
    ...(overrides.bindings === undefined ? {} : { bindings: overrides.bindings }),
  });
}

/** The attacker's refreshed history: the digest literal updated to match a widening. */
function historyFor(ceiling: Record<string, unknown>): History {
  const active = history.entries.at(-1);
  assert.ok(active !== undefined);
  return {
    ...history,
    entries: [
      ...history.entries.slice(0, -1),
      {
        ...active,
        semantic_projection_digest: semanticDigest({ clauses: ceiling["clauses"] as Clause[] }),
      },
    ],
  };
}

test("the structured claim ceiling parses and satisfies its closed shape", () => {
  validate(parsed());
});

test("the append-only history is well formed, unique and sequentially numbered", () => {
  // Sequencing is a general rule over the declared entries; no ordinal is hardcoded,
  // so minting the next revision is an ordinary append rather than a test edit.
  const active = history.entries.at(-1);
  assert.ok(active !== undefined);
  assert.equal(parsed().claim_ceiling_id, active.claim_ceiling_id, "the active id is the last row");
  assert.equal(semanticDigest(parsed()), active.semantic_projection_digest);
  assert.match(nextSemanticId(history), /-[1-9][0-9]*$/, "the next id is derivable, not hardcoded");
});

// --- source binding: every clause, bound to the document it projects -------------

test("every declared clause is bound to an authoritative source, and every binding to a clause", () => {
  const clauses = parsed().clauses;
  assert.deepEqual(
    clauses.map((clause) => clause.clause_id).sort(),
    [...CLAUSE_SOURCE_BINDINGS.keys()].sort(),
    "the binding is a bijection over the whole declared clause set",
  );
  assertSourceBindings(clauses, claimsMarkdown);
});

test("each bound source statement occurs in the claims document exactly once", () => {
  const document = normalizeSource(claimsMarkdown);
  for (const [clauseId, binding] of CLAUSE_SOURCE_BINDINGS) {
    for (const statement of binding.statements) {
      const occurrences = document.split(normalizeSource(statement)).length - 1;
      assert.equal(occurrences, 1, `${clauseId}: ambiguous or missing authoritative source`);
    }
  }
});

test("no clause carries repository metadata, a product name or wording above the ceiling", () => {
  for (const { clause_id, statement } of parsed().clauses) {
    const where = `clause ${clause_id}`;
    assert.equal(/(^|\s)\/[A-Za-z]|[A-Za-z]:\\/.test(statement), false, `${where}: absolute path`);
    assert.equal(/\b[0-9a-f]{40}\b|\b[0-9a-f]{64}\b/.test(statement), false, `${where}: hash`);
    assert.equal(/\d{4}-\d{2}-\d{2}/.test(statement), false, `${where}: timestamp`);
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
  const byId = new Map(parsed().clauses.map((clause) => [clause.clause_id, clause.statement]));

  const t1 = byId.get("t1-ceiling-derived");
  assert.ok(t1 !== undefined && t1.includes("derives T1"), "T1 is still the derived ceiling");

  const higher = byId.get("no-t2-no-t3");
  assert.ok(higher !== undefined && /No T2 and no T3/.test(higher), "T2 and T3 stay refused");

  const blind = byId.get("development-tier-non-blind-selection");
  assert.ok(
    blind !== undefined && blind.includes("non-blind") && blind.includes("development tier"),
    "selection is still non-blind at development tier only",
  );

  const opaque = byId.get("no-strong-isolation-for-opaque-subjects");
  assert.ok(
    opaque !== undefined && opaque.includes("ERL2-OQ-008 is unresolved"),
    "ERL2-OQ-008 is still fail-closed",
  );

  const sandbox = byId.get("sandbox-profile-boundary");
  assert.ok(
    sandbox !== undefined && sandbox.includes("trusted, repository-owned reference subjects only"),
    "the container profile is still limited to trusted repository-owned reference subjects",
  );
});

test("the Markdown points at the structured file and names the active revision", () => {
  const active = parsed().claim_ceiling_id;
  assert.ok(claimsMarkdown.includes("claim-ceiling.json"), "the Markdown points at the JSON");
  assert.ok(claimsMarkdown.includes(active), "the Markdown names the active id");
  assert.ok(claimsMarkdown.includes("claim_ceiling_id"), "consumers are told what to pin");
  for (const entry of history.entries.slice(0, -1)) {
    assert.equal(
      claimsMarkdown.includes(entry.claim_ceiling_id),
      false,
      `the Markdown still advertises the superseded ${entry.claim_ceiling_id}`,
    );
  }
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
  ["a digest-shaped semantic id", () => mutant((v) => (v["claim_ceiling_id"] = "a".repeat(64)))],
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
  ["an unknown top-level field", () => mutant((v) => (v["signed_by"] = "some-authority"))],
  [
    "a malformed source path",
    () => mutant((v) => (v["source"] = "/Users/someone/docs/claims/permitted-claims.md")),
  ],
  [
    // The anchored form is not supported anywhere, so it is refused rather than advertised.
    "an anchored source path",
    () => mutant((v) => (v["source"] = "docs/claims/permitted-claims.md#what-may-not-be-claimed")),
  ],
  ["an empty clause list", () => mutant((v) => (v["clauses"] = []))],
  ["a status other than active", () => mutant((v) => (v["status"] = "draft"))],
  [
    "an unsupported schema version",
    () => mutant((v) => (v["schema_version"] = "reality-lab-claim-ceiling/v2")),
  ],
];

for (const [description, build] of REFUSALS) {
  test(`the contract refuses ${description}`, () => {
    assert.throws(() => validate(build()));
  });
}

// --- regression: the defects the independent review demonstrated -----------------

/** Case 1 — a projected clause moves while the identifier stays. */
test("a changed clause under the existing identifier is refused", () => {
  const widened = mutant((v) => {
    const clauses = v["clauses"] as Clause[];
    const first = clauseAt(clauses, 0);
    clauses[0] = { ...first, statement: `${first.statement} Also T2 is permitted.` };
  });
  assert.throws(() => validate(widened), /no longer agree|semantics the id was minted for/);
});

/** Case 3 — the clause moves, the authoritative source does not. */
test("a clause changed without its authoritative source fails the binding, not a schema rule", () => {
  const widened = mutant((v) => {
    const clauses = v["clauses"] as Clause[];
    const fifth = clauseAt(clauses, 4);
    clauses[4] = { ...fifth, statement: "Subject-quality claims are permitted." };
  });
  // The identity check would refuse this too; the binding refuses it first and on its
  // own grounds, which is the protection that survives a rewritten history.
  assert.throws(
    () => validate(widened, { history: historyFor(widened) }),
    /clause no-subject-quality-claim: the clause and its authoritative source no longer agree/,
  );
});

/** Case 4 — the authoritative source moves, the clause does not. */
test("an authoritative source changed without its clause fails the binding", () => {
  const bound = CLAUSE_SOURCE_BINDINGS.get("no-subject-quality-claim");
  assert.ok(bound !== undefined);
  const sentence = bound.statements[1];
  assert.ok(sentence !== undefined);
  const tampered = normalizeSource(claimsMarkdown).replace(
    normalizeSource(sentence),
    "it says nothing about the quality of the subject behind it, and real products have been run.",
  );
  assert.notEqual(tampered, normalizeSource(claimsMarkdown), "the fixture actually edits the source");
  assert.throws(
    () => validate(parsed(), { sourceDocument: tampered }),
    /its authoritative source statement occurs 0 times/,
  );
});

/** Case 13 — a source binding is dropped while its clause remains. */
test("removing any one of the nine source bindings is refused", () => {
  assert.equal(CLAUSE_SOURCE_BINDINGS.size, 9, "there are nine bindings to remove");
  for (const clauseId of CLAUSE_SOURCE_BINDINGS.keys()) {
    const reduced = new Map(CLAUSE_SOURCE_BINDINGS);
    reduced.delete(clauseId);
    assert.throws(
      () => validate(parsed(), { bindings: reduced }),
      new RegExp(`clause ${clauseId} has no authoritative source binding`),
      `dropping the ${clauseId} binding must be refused`,
    );
  }
});

/** Case 14 — a tenth clause arrives with no authoritative source. */
test("a tenth projected clause without an authoritative source is refused", () => {
  const extended = mutant((v) => {
    (v["clauses"] as Clause[]).push({
      clause_id: "newly-invented-permission",
      statement: "Claims may be made about any subject the Lab did not author.",
    });
  });
  assert.throws(
    () => validate(extended, { history: historyFor(extended) }),
    /clause newly-invented-permission has no authoritative source binding/,
  );
});

/** A clause removed leaves its binding orphaned. */
test("removing a projected clause leaves its binding unclaimed and is refused", () => {
  const reduced = mutant((v) => {
    (v["clauses"] as Clause[]).splice(4, 1);
  });
  assert.throws(
    () => validate(reduced, { history: historyFor(reduced) }),
    /source binding no-subject-quality-claim names no declared clause/,
  );
});

/** Case 12 — evaluator-owned wording added to the document, but never declared. */
test("evaluator-owned wording in the source document does not enter the projection", () => {
  const contaminated = `${claimsMarkdown}\n\nQualiber does not consume OpenTelemetry in these scenarios — it reads analytics-shaped JSON request bodies, whatever the substrate is named.\n`;
  validate(parsed(), { sourceDocument: contaminated });
  assert.equal(
    semanticDigest(parsed()),
    history.entries.at(-1)?.semantic_projection_digest,
    "text nobody declared as a clause cannot move the projection",
  );
});

test("the contract refuses the evaluator-owned phrase being absorbed as a clause", () => {
  const absorbed = mutant((v) => {
    (v["clauses"] as Clause[]).push({
      clause_id: "analytics-shaped-json-consumption",
      statement:
        "Qualiber does not consume OpenTelemetry in these scenarios — it reads analytics-shaped JSON request bodies, whatever the substrate is named.",
    });
  });
  assert.throws(
    () => validate(absorbed, { history: historyFor(absorbed) }),
    /no authoritative source binding/,
  );
  const added = (absorbed["clauses"] as Clause[]).at(-1);
  assert.ok(added !== undefined);
  assert.equal(/qualiber/i.test(added.statement), true, "the fixture is the phrase in question");
});

/**
 * Case 15 — the three widenings the independent reviewer demonstrated, each of
 * which previously kept `reality-lab-claim-ceiling-1` with every test green.
 *
 * Each is run twice: once against the published history, and once against a history
 * whose digest literal the attacker has already refreshed to match the widened
 * projection. The second run is the one that matters — it is exactly the bypass the
 * old mutable array literal permitted, and the source binding refuses it with no
 * help from the history at all.
 */
const DEMONSTRATED_BYPASSES: ReadonlyArray<readonly [string, number, string]> = [
  [
    "clause 5 widened to permit claims from runs against real products",
    4,
    "Subject-quality claims are permitted from runs against real products, including products the Lab did not author.",
  ],
  [
    "clause 7 replaced with contained opaque third-party subjects and a resolved ERL2-OQ-008",
    6,
    "Opaque third-party subjects are contained by the container profile, and ERL2-OQ-008 is resolved.",
  ],
  [
    "clause 9 replaced with a production certification",
    8,
    "This build is a production certification.",
  ],
];

for (const [description, index, statement] of DEMONSTRATED_BYPASSES) {
  test(`the demonstrated bypass is refused: ${description}`, () => {
    const widened = mutant((v) => {
      const clauses = v["clauses"] as Clause[];
      clauses[index] = { ...clauseAt(clauses, index), statement };
    });
    assert.equal(
      widened["claim_ceiling_id"],
      activeRevision().claim_ceiling_id,
      "the bypass keeps the reviewed identifier, which is what makes it a bypass",
    );

    // Against the published history: refused.
    assert.throws(() => validate(widened), /no longer agree|semantics the id was minted for/);

    // And with the adjacent digest literal already refreshed: still refused, on the
    // source binding, because the widened wording is in no authoritative sentence.
    assert.throws(
      () => validate(widened, { history: historyFor(widened) }),
      /the clause and its authoritative source no longer agree/,
    );
  });
}

// --- the legitimate evolution path -----------------------------------------------

/**
 * A tightening: it narrows what may be claimed and widens nothing. Kept out of the
 * published document, so this suite exercises the mint without performing one.
 */
const NEXT_REVISION_SENTENCE =
  "No release authority exists at this revision, and none may be asserted until that calibration work has completed.";

/**
 * A complete, legitimate next revision, built the way the authorized path builds one:
 * the authoritative source moves, the clause that projects it moves with it, the
 * binding is re-derived over both sides at once, the projection digest is whatever the
 * new semantics hash to, and the published rows are appended to rather than edited.
 * No revision ordinal is named anywhere in it.
 */
function nextMint(): {
  ceiling: Ceiling;
  history: History;
  bindings: SourceBindings;
  sourceDocument: string;
} {
  const clauseId = "no-production-certification";
  const bound = CLAUSE_SOURCE_BINDINGS.get(clauseId);
  assert.ok(bound !== undefined, `no source binding for ${clauseId}`);
  assert.equal(
    normalizeSource(claimsMarkdown).includes(normalizeSource(NEXT_REVISION_SENTENCE)),
    false,
    "the fixture sentence has entered the published document; give the fixture its own wording",
  );

  const ceiling = parsed();
  const clauses = ceiling.clauses.map((clause) =>
    clause.clause_id === clauseId
      ? { ...clause, statement: `${clause.statement} ${NEXT_REVISION_SENTENCE}` }
      : clause,
  );
  const moved = clauses.find((clause) => clause.clause_id === clauseId);
  assert.ok(moved !== undefined);

  const statements = [...bound.statements, NEXT_REVISION_SENTENCE];
  const bindings: SourceBindings = new Map([
    ...CLAUSE_SOURCE_BINDINGS,
    [clauseId, { statements, binding_digest: bindingDigest(clauseId, statements, moved.statement) }],
  ]);

  const nextId = nextSemanticId(history);
  return {
    ceiling: { ...ceiling, claim_ceiling_id: nextId, clauses },
    history: {
      ...history,
      entries: [
        ...history.entries,
        { claim_ceiling_id: nextId, semantic_projection_digest: semanticDigest({ clauses }) },
      ],
    },
    bindings,
    sourceDocument: `${claimsMarkdown}\n\n${NEXT_REVISION_SENTENCE}\n`,
  };
}

/**
 * Regression for the `reality-lab-claim-ceiling-1` literal this suite used to carry
 * beside the demonstrated bypasses. Those bypasses are refused because the semantics
 * moved, not because the ceiling happens to sit on its first revision — so the same
 * fixtures, re-based onto a legitimately minted next revision, must be refused on the
 * same grounds, and the mint itself must pass. A suite that names the current ordinal
 * is green today and red on the next honest mint; this one cannot be.
 */
test("the legitimate next mint is accepted and the demonstrated bypasses stay refused", () => {
  const mint = nextMint();
  const context = {
    sourceDocument: mint.sourceDocument,
    history: mint.history,
    bindings: mint.bindings,
  };

  // The evolution path is open: the next revision passes the identity gate whole.
  validate(mint.ceiling, context);
  assert.equal(mint.ceiling.claim_ceiling_id, nextSemanticId(history), "an ordinary append");
  assert.notEqual(
    mint.ceiling.claim_ceiling_id,
    activeRevision().claim_ceiling_id,
    "the fixture really moves the active revision",
  );
  assert.deepEqual(
    mint.history.entries.slice(0, -1),
    history.entries,
    "every already-published row is carried over unchanged",
  );
  assert.notEqual(
    semanticDigest(mint.ceiling),
    activeRevision().semantic_projection_digest,
    "the new revision means something new",
  );

  // And the shifted revision loosens none of the demonstrated bypasses.
  for (const [description, index, statement] of DEMONSTRATED_BYPASSES) {
    const clauses = mint.ceiling.clauses.map((clause, at) =>
      at === index ? { ...clause, statement } : clause,
    );
    const widened: Ceiling = { ...mint.ceiling, clauses };
    assert.equal(
      widened.claim_ceiling_id,
      mint.history.entries.at(-1)?.claim_ceiling_id,
      "the bypass keeps the newly active identifier, which is what makes it a bypass",
    );
    assert.throws(
      () => validate(widened, context),
      /no longer agree|semantics the id was minted for/,
      `still refused one revision on: ${description}`,
    );
  }
});

// --- stability: non-semantic change must not move the projection -----------------

/** Cases 10 and 11 — excluded metadata, formatting and property order are not meaning. */
test("formatting and non-semantic metadata do not move the semantic projection", () => {
  const ceiling = parsed();
  const baseline = semanticDigest(ceiling);
  assert.equal(baseline, history.entries.at(-1)?.semantic_projection_digest);

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
  assert.equal(semanticProjection(reordered), semanticProjection(ceiling));

  const rekeyed = { ...ceiling, status: "superseded", source: "docs/claims/somewhere-else.md" };
  assert.equal(semanticDigest(rekeyed), baseline, "excluded metadata is not meaning");

  const renamed = { ...ceiling, claim_ceiling_id: "reality-lab-claim-ceiling-99" };
  assert.equal(
    semanticDigest(renamed),
    baseline,
    "the id is outside the projection, which is what makes a bare rename detectable",
  );

  // The binding digests are likewise indifferent to how the source is wrapped.
  for (const [clauseId, binding] of CLAUSE_SOURCE_BINDINGS) {
    const rewrapped = binding.statements.map((sentence) => sentence.replace(/ /g, "\n   "));
    assert.equal(
      bindingDigest(clauseId, rewrapped, clauseStatement(ceiling, clauseId)),
      binding.binding_digest,
      `${clauseId}: rewrapping a bound sentence is not a semantic event`,
    );
  }
});

function clauseStatement(ceiling: Ceiling, clauseId: string): string {
  const clause = ceiling.clauses.find((candidate) => candidate.clause_id === clauseId);
  assert.ok(clause !== undefined, `no clause ${clauseId}`);
  return clause.statement;
}

/** Case 8, within a revision — a new id has to mean something new. */
test("a new identifier over an unchanged semantic projection has nowhere to land", () => {
  const renamed = mutant((v) => (v["claim_ceiling_id"] = nextSemanticId(history)));
  assert.throws(() => validate(renamed), /the active identifier is/);

  const appended: History = {
    ...history,
    entries: [
      ...history.entries,
      {
        claim_ceiling_id: nextSemanticId(history),
        semantic_projection_digest: semanticDigest(parsed()),
      },
    ],
  };
  assert.throws(
    () => validateHistory(appended),
    /semantic digests are unique/,
    "an id minted over unchanged semantics is refused by the history's own contract",
  );
});

test("the history refuses a non-sequential or foreign identifier", () => {
  assert.throws(
    () =>
      validateHistory({
        ...history,
        entries: [
          ...history.entries,
          { claim_ceiling_id: "reality-lab-claim-ceiling-7", semantic_projection_digest: "b".repeat(64) },
        ],
      }),
    /revision ordinals are sequential/,
  );
  assert.throws(
    () =>
      validateHistory({
        ...history,
        entries: [
          ...history.entries,
          { claim_ceiling_id: "some-other-ceiling-2", semantic_projection_digest: "b".repeat(64) },
        ],
      }),
    /one identifier stem/,
  );
});
