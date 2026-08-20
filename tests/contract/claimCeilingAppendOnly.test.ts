/**
 * Cross-revision enforcement: the identifier-to-projection history may only grow.
 *
 * The within-revision contract cannot supply this on its own. A history that lives
 * inside the change being proposed can always be rewritten by that change — edit a
 * clause, refresh the digest beside it, keep the identifier, merge. So the rows are
 * compared against an **independently obtained prior repository state**: the same
 * file as it exists at an explicit, immutable base commit, read out of the object
 * database rather than from the working tree.
 *
 * The base coordinate is explicit and never a moving branch tip:
 *
 * - `CLAIM_CEILING_BASE` — a full commit sha. The PR lane supplies the pull request's
 *   own base sha here, which is the authoritative comparison point; a pull request
 *   that supplies none fails closed rather than falling back.
 * - otherwise `append_only_base` from `docs/claims/claim-ceiling-history.json` — an
 *   in-repository, immutable anchor so a local `npm test` is not vacuous.
 *
 * Either way the commit must be resolvable and an ancestor of `HEAD`; a missing
 * object, a shallow clone or a checkout with no git directory is a failure, not a
 * skip. No network call and no service is involved: this reads the local object
 * database only.
 */

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import {
  bindingDigest,
  CLAUSE_SOURCE_BINDINGS,
  FULL_COMMIT_SHAPED,
  HISTORY_PATH,
  nextSemanticId,
  readCeilingSources,
  repoRoot,
  semanticDigest,
  validateCeiling,
  validateHistory,
  type Ceiling,
  type History,
  type SourceBindings,
} from "../support/claimCeiling.js";

const { rawCeiling, rawHistory, claimsMarkdown } = readCeilingSources();
const head: History = validateHistory(JSON.parse(rawHistory));

function git(args: readonly string[]): string {
  return execFileSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** The explicit, immutable base coordinate. Missing context fails; it never skips. */
function resolveBase(history: History): { sha: string; origin: string } {
  const explicit = (process.env["CLAIM_CEILING_BASE"] ?? "").trim();
  if (explicit !== "") {
    assert.match(
      explicit,
      FULL_COMMIT_SHAPED,
      "CLAIM_CEILING_BASE must be a full 40-character commit sha",
    );
    return { sha: explicit, origin: "CLAIM_CEILING_BASE" };
  }
  assert.notEqual(
    (process.env["GITHUB_EVENT_NAME"] ?? "").trim(),
    "pull_request",
    "a pull request must supply CLAIM_CEILING_BASE (its own base sha): the append-only rule is a property of the proposed change, so it may not fall back to an anchor that change can itself move",
  );
  return { sha: history.append_only_base, origin: `${HISTORY_PATH}#append_only_base` };
}

/** The history as it stood at `sha`, or null if the ceiling did not exist there yet. */
function historyAt(sha: string): History | null {
  try {
    git(["rev-parse", "--git-dir"]);
  } catch {
    assert.fail(
      "the append-only check needs the git object database and found none; run it in a git checkout",
    );
  }
  try {
    git(["cat-file", "-e", `${sha}^{commit}`]);
  } catch {
    assert.fail(
      `the append-only base commit ${sha} is not in this checkout; fetch it (git fetch origin ${sha}) rather than skipping the check`,
    );
  }
  try {
    git(["merge-base", "--is-ancestor", sha, "HEAD"]);
  } catch {
    assert.fail(`the append-only base commit ${sha} is not an ancestor of HEAD`);
  }
  let raw: string;
  try {
    raw = git(["cat-file", "-p", `${sha}:${HISTORY_PATH.split("\\").join("/")}`]);
  } catch {
    return null;
  }
  return validateHistory(JSON.parse(raw));
}

/** The whole cross-revision rule, so a fixture can be put through exactly what HEAD is. */
export function assertAppendOnly(base: History | null, proposed: History): void {
  validateHistory(proposed);
  if (base === null) return; // the ceiling did not exist at the base: every row is an append.

  if (proposed.entries.length < base.entries.length) {
    throw new Error(
      `a historical mapping was deleted: ${base.entries.length} rows at the base, ${proposed.entries.length} now`,
    );
  }
  base.entries.forEach((was, index) => {
    const now = proposed.entries[index];
    if (now === undefined) throw new Error(`a historical mapping was deleted at row ${index}`);
    if (now.claim_ceiling_id !== was.claim_ceiling_id) {
      throw new Error(
        `a historical identifier was renamed: ${was.claim_ceiling_id} became ${now.claim_ceiling_id}`,
      );
    }
    if (now.semantic_projection_digest !== was.semantic_projection_digest) {
      throw new Error(
        `a historical mapping was rewritten: ${was.claim_ceiling_id} no longer means what it was minted for`,
      );
    }
  });
}

// --- the published history, against the real base ------------------------------

const base = resolveBase(head);

test("the append-only base is explicit, resolvable and an ancestor of HEAD", () => {
  assert.match(base.sha, FULL_COMMIT_SHAPED, `base coordinate came from ${base.origin}`);
  const at = historyAt(base.sha); // asserts resolvability and ancestry, or fails.
  assert.equal(at === null || at.entries.length >= 1, true);
});

test("the published history only appends to the history at the base commit", () => {
  assertAppendOnly(historyAt(base.sha), head);
});

test("the active identifier and the current projection agree with the history's last row", () => {
  validateCeiling(JSON.parse(rawCeiling), { sourceDocument: claimsMarkdown, history: head });
});

// --- fixtures: every rewrite of an already-published history is refused ----------

const PUBLISHED: History = {
  schema_version: head.schema_version,
  append_only_base: head.append_only_base,
  entries: [
    { claim_ceiling_id: "reality-lab-claim-ceiling-1", semantic_projection_digest: "a".repeat(64) },
    { claim_ceiling_id: "reality-lab-claim-ceiling-2", semantic_projection_digest: "b".repeat(64) },
  ],
};

function proposal(entries: History["entries"]): History {
  return { ...PUBLISHED, entries };
}

/** Case 2 — a clause changes and the stored digest is refreshed in the same change. */
test("refreshing an existing identifier's digest in the same change is refused", () => {
  const rewritten = proposal([
    { claim_ceiling_id: "reality-lab-claim-ceiling-1", semantic_projection_digest: "c".repeat(64) },
    ...PUBLISHED.entries.slice(1),
  ]);
  assert.throws(
    () => assertAppendOnly(PUBLISHED, rewritten),
    /a historical mapping was rewritten: reality-lab-claim-ceiling-1/,
  );
});

/** Case 6 — the same, for a row that is not the first. */
test("rewriting any historical mapping is refused", () => {
  const rewritten = proposal([
    ...PUBLISHED.entries.slice(0, 1),
    { claim_ceiling_id: "reality-lab-claim-ceiling-2", semantic_projection_digest: "d".repeat(64) },
  ]);
  assert.throws(
    () => assertAppendOnly(PUBLISHED, rewritten),
    /a historical mapping was rewritten: reality-lab-claim-ceiling-2/,
  );
});

/** Case 5 — a historical mapping is dropped. */
test("deleting a historical mapping is refused", () => {
  // Dropping the newest row shortens the history against the base.
  assert.throws(
    () => assertAppendOnly(PUBLISHED, proposal(PUBLISHED.entries.slice(0, 1))),
    /a historical mapping was deleted: 2 rows at the base, 1 now/,
  );
  // Dropping the oldest leaves the survivors misnumbered — the same refusal, seen
  // from the other side, and equally on the deletion's own grounds.
  assert.throws(
    () => assertAppendOnly(PUBLISHED, proposal(PUBLISHED.entries.slice(1))),
    /revision ordinals are sequential: reality-lab-claim-ceiling-2 is entry 1/,
  );
});

/** Case 7 — a historical identifier is renamed in place. */
test("renaming a historical identifier is refused", () => {
  const renamed = proposal([
    { claim_ceiling_id: "reality-lab-claim-ceiling-1", semantic_projection_digest: "a".repeat(64) },
    { claim_ceiling_id: "reality-lab-claim-ceiling-2", semantic_projection_digest: "b".repeat(64) },
  ]);
  const first = renamed.entries[0];
  assert.ok(first !== undefined);
  renamed.entries[0] = { ...first, claim_ceiling_id: "reality-lab-ceiling-1" };
  assert.throws(() => assertAppendOnly(PUBLISHED, renamed), /one identifier stem|renamed/);
});

/** Case 8 — a new identifier is minted over semantics that did not change. */
test("minting a new identifier over unchanged semantics is refused", () => {
  const restamped = proposal([
    ...PUBLISHED.entries,
    { claim_ceiling_id: "reality-lab-claim-ceiling-3", semantic_projection_digest: "b".repeat(64) },
  ]);
  assert.throws(() => assertAppendOnly(PUBLISHED, restamped), /semantic digests are unique/);
});

test("reordering the published rows is refused", () => {
  const swapped = proposal([...PUBLISHED.entries].reverse());
  assert.throws(() => assertAppendOnly(PUBLISHED, swapped), /renamed|ordinals are sequential/);
});

// --- case 9: the legitimate next revision, end to end ---------------------------

/**
 * Changed semantics, every earlier mapping preserved, one new sequential id, and
 * that id active. This is the operation the mechanism must *not* obstruct, so it is
 * asserted to pass rather than merely to be untested.
 */
test("a legitimate next identifier with changed semantics and a preserved history passes", () => {
  const NEW_SOURCE_SENTENCE =
    "- **No calibration claim.** Zero calibration runs have completed, and no release authority exists.";
  const NEW_STATEMENT =
    "Not a production certification, and not a calibration claim. Zero calibration runs have completed and no release authority exists.";

  const ceiling = JSON.parse(rawCeiling) as Ceiling;
  const index = ceiling.clauses.findIndex((clause) => clause.clause_id === "no-production-certification");
  assert.notEqual(index, -1);
  const previous = ceiling.clauses[index];
  assert.ok(previous !== undefined);

  const nextId = nextSemanticId(head);
  const nextCeiling: Ceiling = {
    ...ceiling,
    claim_ceiling_id: nextId,
    clauses: ceiling.clauses.map((clause, at) =>
      at === index ? { ...clause, statement: NEW_STATEMENT } : clause,
    ),
  };
  const nextDigest = semanticDigest(nextCeiling);
  assert.notEqual(
    nextDigest,
    head.entries.at(-1)?.semantic_projection_digest,
    "the fixture actually changes meaning",
  );

  // The clause's authoritative source moves with it, and so does its binding.
  const nextDocument = `${claimsMarkdown}\n\n${NEW_SOURCE_SENTENCE}\n`;
  const nextBindings: SourceBindings = new Map([
    ...CLAUSE_SOURCE_BINDINGS,
    [
      "no-production-certification",
      {
        statements: [NEW_SOURCE_SENTENCE],
        binding_digest: bindingDigest("no-production-certification", [NEW_SOURCE_SENTENCE], NEW_STATEMENT),
      },
    ],
  ]);

  const nextHistory: History = {
    ...head,
    entries: [...head.entries, { claim_ceiling_id: nextId, semantic_projection_digest: nextDigest }],
  };

  // Every earlier mapping is preserved, the new row is an append, and the new id is
  // the active one with the projection it was minted for.
  assertAppendOnly(head, nextHistory);
  validateCeiling(nextCeiling, {
    sourceDocument: nextDocument,
    history: nextHistory,
    bindings: nextBindings,
  });

  // And the same mint without the new row, or with the old id, is still refused.
  assert.throws(
    () => validateCeiling(nextCeiling, { sourceDocument: nextDocument, history: head, bindings: nextBindings }),
    /the active identifier is/,
  );
  assert.throws(
    () =>
      validateCeiling(
        { ...nextCeiling, claim_ceiling_id: head.entries.at(-1)?.claim_ceiling_id },
        { sourceDocument: nextDocument, history: nextHistory, bindings: nextBindings },
      ),
    /the active identifier is/,
  );
});
