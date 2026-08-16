/**
 * Fully resealed semantic forgeries against the offline verifier.
 *
 * Every mutation below recomputes every enclosing `core_hash`, so nothing here
 * fails merely because an outer hash went stale. That is the whole point: an
 * attacker who can edit a record can also rehash it, and the previous verifier
 * accepted six different resealed forgeries because it checked internal
 * consistency rather than rebuilding the run.
 *
 * ## Where the forgeries live
 *
 * In an isolated temporary directory, deleted when the file's process ends.
 * They are never written into a durable run or certification artifact
 * directory, and none of them is authoritative for anything: what is retained
 * from these cases is the mutation recipe in the test name, the expected
 * refusal, and the refusal the verifier actually produced.
 */

import { strict as assert } from "node:assert";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { coreHash, hashBytes } from "@erl2/integrity";
import { verifyTrustedLocalObservationRecord } from "@erl2/core";
import { runCommand } from "@erl2/cli";
import { ownedTempDir } from "../support/tempDirs.js";
import {
  ELEVEN_OPERATION_CLEAN_PLAN,
  writeTrustedLocalInputs,
} from "../support/trustedLocalFixtures.js";

type Doc = Record<string, unknown>;

/** Re-seals an object after a mutation, so no outer hash is ever stale. */
function seal(value: Doc): Doc {
  const base = { ...value };
  delete base["core_hash"];
  return { ...base, core_hash: coreHash(base) };
}

interface Bed {
  readonly outputRoot: string;
  readonly entryPath: string;
  readonly recordPath: string;
  readonly planPath: string;
  readonly registryRoot: string;
  readonly record: Doc;
  readonly plan: Doc;
}

/**
 * One genuine run, then a scratch copy of its evidence to mutate.
 *
 * The genuine run is produced once per case rather than shared, because a
 * forgery that mutated shared bytes would make later cases depend on earlier
 * ones and a passing suite would stop meaning anything.
 */
function bed(observationId?: string): Bed {
  const root = ownedTempDir("erl2-tlo-forge-");
  const inputs = writeTrustedLocalInputs(
    root,
    ELEVEN_OPERATION_CLEAN_PLAN,
    observationId === undefined ? {} : { planOverrides: { observation_id: observationId } },
  );
  const result = runCommand([
    "run-trusted-local-observation",
    "--adapter-entry", inputs.entryPath,
    "--manifest", inputs.manifestPath,
    "--plan", inputs.planPath,
    "--owner-declaration", inputs.declarationPath,
    "--output-root", inputs.outputRoot,
  ]);
  assert.equal(result.ok, true, `the genuine run must succeed: ${JSON.stringify(result.errors)}`);
  // The forgery bed is a copy. The genuine evidence is never edited, so a
  // mutation cannot leak into future run evidence.
  const forgeryRoot = path.join(root, "forgery");
  cpSync(inputs.outputRoot, forgeryRoot, { recursive: true });
  const recordPath = path.join(forgeryRoot, "trusted-local-observation-record.json");
  const planPath = path.join(forgeryRoot, "observation-plan.json");
  return {
    outputRoot: forgeryRoot,
    entryPath: inputs.entryPath,
    recordPath,
    planPath,
    registryRoot: path.join(forgeryRoot, "registry"),
    record: JSON.parse(readFileSync(recordPath, "utf8")) as Doc,
    plan: JSON.parse(readFileSync(planPath, "utf8")) as Doc,
  };
}

function verify(
  b: Bed,
  record: Doc = b.record,
  planBytes?: Buffer,
): ReturnType<typeof verifyTrustedLocalObservationRecord> {
  return verifyTrustedLocalObservationRecord({
    recordBytes: Buffer.from(`${JSON.stringify(record, null, 2)}\n`, "utf8"),
    planBytes: planBytes ?? readFileSync(b.planPath),
    registryRoot: b.registryRoot,
    adapterEntryPath: b.entryPath,
  });
}

function refusalOf(result: ReturnType<typeof verifyTrustedLocalObservationRecord>): string {
  assert.equal(result.ok, false, "the forgery must be refused");
  assert.ok(result.refusals.length > 0, "a refusal must say what it refused");
  return result.refusals.join("; ");
}

test("TRUSTED-LOCAL-VERIFY: a genuine retained record verifies, and reports its ceiling", () => {
  const b = bed();
  const result = verify(b);
  assert.equal(result.ok, true, result.refusals.join("; "));
  assert.equal(result.verified?.trustMode, "trusted_local_code");
  assert.equal(result.verified?.independentCertification, "absent");
  assert.equal(result.verified?.confinement, "absent");
  assert.equal(result.verified?.terminalStatus, "observed_complete");
});

test("TRUSTED-LOCAL-VERIFY: a changed run id, fully resealed, is refused", () => {
  const b = bed();
  const forged = seal({
    ...b.record,
    observation_id: "018f9999-8888-7777-8666-555555555555",
    result: seal({
      ...(b.record["result"] as Doc),
      observation_id: "018f9999-8888-7777-8666-555555555555",
    }),
  });
  assert.match(refusalOf(verify(b, forged)), /run id the plan froze/);
});

test("TRUSTED-LOCAL-VERIFY: a changed plan hash, fully resealed, is refused", () => {
  const b = bed();
  const forged = seal({ ...b.record, plan_hash: `sha256:${"1".repeat(64)}` });
  assert.match(refusalOf(verify(b, forged)), /plan hash is not the hash of the plan supplied/);
});

test("TRUSTED-LOCAL-VERIFY: omitted plan bytes are refused", () => {
  const b = bed();
  const result = verifyTrustedLocalObservationRecord({
    recordBytes: readFileSync(b.recordPath),
    planBytes: Buffer.alloc(0),
    registryRoot: b.registryRoot,
    adapterEntryPath: b.entryPath,
  });
  assert.match(refusalOf(result), /plan bytes are required/);
});

test("TRUSTED-LOCAL-VERIFY: a plan whose operations exceed the retained outcomes is refused", () => {
  const b = bed();
  // A genuine resealed plan with one more operation than the run retained an
  // outcome for. Every hash recomputes; only the story is wrong.
  const operations = [...(b.plan["operations"] as Doc[])];
  const extra = { ...operations[operations.length - 1] } as Doc;
  extra["sequence"] = operations.length;
  extra["operation_id"] = "op-extra-residue";
  operations.push(extra);
  const forgedPlan = seal({ ...b.plan, operations });
  const planBytes = Buffer.from(`${JSON.stringify(forgedPlan, null, 2)}\n`, "utf8");
  const forgedRecord = seal({
    ...b.record,
    plan_hash: forgedPlan["core_hash"],
    plan_file_hash: hashOf(planBytes),
    result: seal({ ...(b.record["result"] as Doc), plan_hash: forgedPlan["core_hash"] }),
  });
  assert.match(
    refusalOf(verify(b, forgedRecord, planBytes)),
    /the plan reaches \d+ operations and the record retains \d+ outcomes/,
  );
});

test("TRUSTED-LOCAL-VERIFY: reordered outcomes are refused", () => {
  const b = bed();
  const outcomes = [...(b.record["operation_outcomes"] as Doc[])];
  const swapped = [outcomes[1] as Doc, outcomes[0] as Doc, ...outcomes.slice(2)];
  assert.match(
    refusalOf(verify(b, seal({ ...b.record, operation_outcomes: swapped }))),
    /where the plan has|not chained to the operation that ran before it/,
  );
});

test("TRUSTED-LOCAL-VERIFY: an altered predecessor chain is refused", () => {
  const b = bed();
  const outcomes = [...(b.record["operation_outcomes"] as Doc[])];
  outcomes[3] = {
    ...(outcomes[3] as Doc),
    predecessor_operation_record_hash: `sha256:${"2".repeat(64)}`,
  };
  assert.match(
    refusalOf(verify(b, seal({ ...b.record, operation_outcomes: outcomes }))),
    /not chained to the operation that ran before it/,
  );
});

test("TRUSTED-LOCAL-VERIFY: a cross-run replay is refused", () => {
  const a = bed();
  // A second genuine run of the same adapter under a different observation id.
  // Two runs with identical inputs would be byte-identical, and pairing those
  // would prove nothing.
  const c = bed("018f2222-3333-7444-8555-666666666666");
  assert.notEqual(a.record["observation_id"], c.record["observation_id"]);
  // `c`'s record, verified against `a`'s plan bytes and registry. Both are
  // genuine; the pairing is the forgery.
  assert.match(
    refusalOf(
      verifyTrustedLocalObservationRecord({
        recordBytes: readFileSync(c.recordPath),
        planBytes: readFileSync(a.planPath),
        registryRoot: a.registryRoot,
        adapterEntryPath: a.entryPath,
      }),
    ),
    /plan/,
  );
});

test("TRUSTED-LOCAL-VERIFY: a false cleanup upgrade is refused", () => {
  const b = bed();
  const cleanup = { ...(b.record["cleanup"] as Doc), residue: "observed_clean", status: "cleanup_complete" };
  const forged = seal({
    ...b.record,
    residue_observations: [],
    cleanup,
    result: seal({ ...(b.record["result"] as Doc), cleanup }),
  });
  // With no residue observation retained, `observed_clean` is unsupported —
  // and there is deliberately no branch that derives clean from operations
  // having ended.
  assert.match(refusalOf(verify(b, forged)), /residue observed_clean; the retained observations support not_observed/);
});

test("TRUSTED-LOCAL-VERIFY: a contradictory terminal status is refused", () => {
  const b = bed();
  const forged = seal({
    ...b.record,
    terminal_status: "observation_failed",
    result: seal({ ...(b.record["result"] as Doc), status: "observation_failed" }),
  });
  assert.match(refusalOf(verify(b, forged)), /terminal status is observation_failed/);
});

test("TRUSTED-LOCAL-VERIFY: a nested adapter-written verdict is refused", () => {
  const b = bed();
  const forged = seal({ ...b.record, verdict: "valid" });
  assert.match(refusalOf(verify(b, forged)), /closed trusted-local record/);
});

test("TRUSTED-LOCAL-VERIFY: an unknown top-level field is refused", () => {
  const b = bed();
  assert.match(
    refusalOf(verify(b, seal({ ...b.record, arbitrary_metadata: { note: "hello" } }))),
    /closed trusted-local record/,
  );
});

test("TRUSTED-LOCAL-VERIFY: an unknown nested field is refused", () => {
  const b = bed();
  const forged = seal({
    ...b.record,
    trusted_local_declaration: seal({
      ...(b.record["trusted_local_declaration"] as Doc),
      reviewed_by: "nobody",
    }),
  });
  assert.match(refusalOf(verify(b, forged)), /closed trusted-local record/);
});

test("TRUSTED-LOCAL-VERIFY: an oversized record is refused before it is parsed", () => {
  const b = bed();
  const padded = Buffer.concat([
    Buffer.from("["),
    Buffer.alloc(5 * 1024 * 1024, 0x20),
    Buffer.from("]"),
  ]);
  const result = verifyTrustedLocalObservationRecord({
    recordBytes: padded,
    planBytes: readFileSync(b.planPath),
    registryRoot: b.registryRoot,
    adapterEntryPath: b.entryPath,
  });
  assert.match(refusalOf(result), /above the \d+-byte ceiling/);
});

test("TRUSTED-LOCAL-VERIFY: a false independent-certification claim is refused", () => {
  const b = bed();
  assert.match(
    refusalOf(verify(b, seal({ ...b.record, independent_certification: "present" }))),
    /closed trusted-local record/,
  );
});

test("TRUSTED-LOCAL-VERIFY: a false confinement claim is refused", () => {
  const b = bed();
  assert.match(
    refusalOf(verify(b, seal({ ...b.record, confinement: "enforced" }))),
    /closed trusted-local record/,
  );
});

test("TRUSTED-LOCAL-VERIFY: scored, authenticated and production-ready claims are refused", () => {
  const b = bed();
  for (const field of ["not_scored", "not_governor_authorized", "not_authenticated", "not_production_ready"]) {
    assert.match(
      refusalOf(verify(b, seal({ ...b.record, [field]: false }))),
      /closed trusted-local record/,
      `${field} must be unrepresentable`,
    );
  }
});

test("TRUSTED-LOCAL-VERIFY: the embedded result's own ceiling cannot be weakened either", () => {
  const b = bed();
  // The record and its result each carry the ceiling, and each is pinned by its
  // own contract constant. A forgery that weakens only the inner one has to be
  // refused by the inner constant, not by the outer one happening to survive.
  for (const field of [
    "not_scored",
    "not_governor_authorized",
    "not_independently_certified",
    "not_confined",
  ]) {
    const forged = seal({
      ...b.record,
      result: seal({ ...(b.record["result"] as Doc), [field]: false }),
    });
    assert.match(
      refusalOf(verify(b, forged)),
      /closed trusted-local record/,
      `the result's ${field} must be unrepresentable`,
    );
  }
});

test("TRUSTED-LOCAL-VERIFY: an altered artifact or manifest binding is refused", () => {
  const b = bed();
  assert.match(
    refusalOf(verify(b, seal({ ...b.record, adapter_artifact_hash: `sha256:${"3".repeat(64)}` }))),
    /one artifact digest/,
  );
  assert.match(
    refusalOf(verify(b, seal({ ...b.record, adapter_manifest_file_hash: `sha256:${"4".repeat(64)}` }))),
    /manifest file bytes the registry does not hold/,
  );
});

test("TRUSTED-LOCAL-VERIFY: an embedded declaration replaced with another is refused", () => {
  const b = bed();
  const forged = seal({
    ...b.record,
    trusted_local_declaration: seal({
      ...(b.record["trusted_local_declaration"] as Doc),
      declaration_id: "a-different-declaration",
    }),
  });
  assert.match(refusalOf(verify(b, forged)), /not the declaration that was retained/);
});

test("TRUSTED-LOCAL-VERIFY: an adapter whose bytes changed after the run is refused", () => {
  const b = bed();
  const moved = path.join(b.outputRoot, "entry-copy.mjs");
  cpSync(b.entryPath, moved);
  writeFileSync(moved, `${readFileSync(moved, "utf8")}\n// changed after the run\n`);
  const result = verifyTrustedLocalObservationRecord({
    recordBytes: readFileSync(b.recordPath),
    planBytes: readFileSync(b.planPath),
    registryRoot: b.registryRoot,
    adapterEntryPath: moved,
  });
  assert.match(refusalOf(result), /no longer the bytes this observation ran/);
});

/** The verifier compares file digests, so a forged plan needs a real one. */
function hashOf(bytes: Buffer): string {
  return hashBytes(bytes);
}
