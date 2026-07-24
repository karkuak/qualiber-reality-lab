/**
 * Slice 1 exit gate: the requirement ledger covers every P0 requirement and
 * ERL2-AC-001 through ERL2-AC-043, each with an owner, package, test family and
 * status; and every open question declares an enforced fail-closed state.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ledger = JSON.parse(
  readFileSync(path.join(repoRoot, "docs", "ledger", "requirements.json"), "utf8"),
) as {
  requirements: { requirement_id: string; priority: string; slice: number; status: string; owning_package: string; test_families: string[]; owner: string }[];
  acceptance_criteria: { acceptance_id: string; status: string; evidence: string }[];
  open_questions: { id: string; fail_closed: string; status: string }[];
  adrs: { id: string; status: string }[];
  normative_conflicts: { id: string; status: string; resolution_adr: string }[];
  generated_for_revision: string;
};

const VALID_STATUS = new Set(["implemented", "partial", "planned", "blocked_fail_closed"]);

test("LEDGER: every P0 requirement has an owner, package, test family and status", () => {
  const p0 = ledger.requirements.filter((r) => r.priority === "P0");
  assert.ok(p0.length >= 30, `expected the full P0 set, found ${p0.length}`);
  for (const requirement of ledger.requirements) {
    assert.ok(VALID_STATUS.has(requirement.status), `${requirement.requirement_id} has status ${requirement.status}`);
    assert.ok(requirement.owner.length > 0, `${requirement.requirement_id} has no owner`);
    assert.ok(requirement.owning_package.length > 0, `${requirement.requirement_id} has no package`);
    assert.ok(requirement.test_families.length > 0, `${requirement.requirement_id} has no test family`);
    assert.ok(requirement.slice >= 1 && requirement.slice <= 12, `${requirement.requirement_id} has no slice`);
  }
});

test("LEDGER: ERL2-AC-001 through ERL2-AC-043 are all present with evidence", () => {
  const present = new Set(ledger.acceptance_criteria.map((a) => a.acceptance_id));
  for (let i = 1; i <= 43; i += 1) {
    const id = `ERL2-AC-${String(i).padStart(3, "0")}`;
    assert.ok(present.has(id), `${id} is missing from the ledger`);
  }
  for (const ac of ledger.acceptance_criteria) {
    assert.ok(ac.evidence.length > 0, `${ac.acceptance_id} has no evidence pointer`);
  }
});

test("LEDGER: every open question declares an enforced fail-closed state", () => {
  const ids = ledger.open_questions.map((q) => q.id);
  for (let i = 1; i <= 7; i += 1) {
    assert.ok(ids.includes(`ERL2-OQ-${String(i).padStart(3, "0")}`), `ERL2-OQ-00${i} missing`);
  }
  for (const question of ledger.open_questions) {
    assert.ok(question.fail_closed.length > 0, `${question.id} declares no fail-closed state`);
  }
});

test("LEDGER: ADRs 001-006 and 011 are accepted before their contracts freeze", () => {
  const byId = new Map(ledger.adrs.map((a) => [a.id, a.status]));
  for (const n of ["001", "002", "003", "004", "005", "006", "011"]) {
    assert.equal(byId.get(`ADR-ERL2-${n}`), "accepted", `ADR-ERL2-${n} is not accepted`);
  }
});

test("LEDGER: every normative conflict names an accepted resolution ADR", () => {
  const byId = new Map(ledger.adrs.map((a) => [a.id, a.status]));
  for (const conflict of ledger.normative_conflicts) {
    assert.ok(conflict.resolution_adr.startsWith("ADR-ERL2-"), `${conflict.id} has no resolution ADR`);
    if (conflict.status.startsWith("resolved")) {
      assert.equal(
        byId.get(conflict.resolution_adr),
        "accepted",
        `${conflict.id} claims resolution by an ADR that is not accepted`,
      );
    }
  }
});

test("LEDGER: the ledger tracks the design revision it was generated against", () => {
  assert.equal(ledger.generated_for_revision, "2.0.0-draft.11");
  const revisions = readFileSync(
    path.join(repoRoot, "external-reality-lab-design-v2.md"),
    "utf8",
  ).match(/^\| (2\.0\.0-draft\.\d+) \|/gm);
  assert.ok(
    revisions?.[0]?.includes(ledger.generated_for_revision),
    "the ledger must pin the design's newest revision",
  );
});

test("LEDGER: ADR-ERL2-013 is accepted and the lifecycle-transition review is recorded", () => {
  const byId = new Map(ledger.adrs.map((a) => [a.id, a.status]));
  assert.equal(byId.get("ADR-ERL2-013"), "accepted");
  const adr = readFileSync(path.join(repoRoot, "docs", "adr", "ADR-ERL2-013.md"), "utf8");
  assert.match(adr, /\*\*Status:\*\* accepted/);
  assert.match(adr, /Resolution A/);
});
