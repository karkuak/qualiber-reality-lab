/**
 * TASK-LOCAL offline verifier harness — evidence-retention task 2026-08-16.
 *
 * NOT production code. It adds no verification logic of its own: it reads the
 * retained bytes off disk and calls the Lab's own, unmodified public offline
 * verification function `verifyTrustedLocalObservationRecord` from @erl2/core.
 * Everything else it prints is an INDEPENDENT recomputation (file digests and
 * the record's own core hash) done here so the verifier's verdict can be
 * checked against bytes rather than trusted.
 *
 * Usage:
 *   node task-local-verify.mjs <record> <plan> <registryRoot> <adapterEntry> <retainedInputRoot>
 *
 * Exit code 0 only when the verifier reports ok with zero refusals AND every
 * independent recomputation agrees.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { coreHash } from "@erl2/integrity";
import { verifyTrustedLocalObservationRecord } from "@erl2/core";

const [, , recordPath, planPath, registryRoot, adapterEntryPath, retainedInputRoot] = process.argv;
if (!recordPath || !planPath || !registryRoot || !adapterEntryPath || !retainedInputRoot) {
  console.error(
    "usage: task-local-verify.mjs <record> <plan> <registryRoot> <adapterEntry> <retainedInputRoot>",
  );
  process.exit(2);
}

const sha256 = (buf) => `sha256:${createHash("sha256").update(buf).digest("hex")}`;

const recordBytes = readFileSync(recordPath);
const planBytes = readFileSync(planPath);
const adapterBytes = readFileSync(adapterEntryPath);

// -- the Lab's own public offline verification, unmodified --------------------
const verification = verifyTrustedLocalObservationRecord({
  recordBytes,
  planBytes,
  registryRoot,
  adapterEntryPath,
  retainedInputRoot,
});

// -- independent recomputation, from the same bytes ---------------------------
const record = JSON.parse(recordBytes.toString("utf8"));
const { core_hash: declaredCore, ...body } = record;
const recomputedCore = coreHash(body);

const independent = {
  record_file_sha256: sha256(recordBytes),
  record_byte_length: recordBytes.byteLength,
  record_core_hash_declared: declaredCore,
  record_core_hash_recomputed: recomputedCore,
  record_core_hash_agrees: recomputedCore === declaredCore,
  plan_file_sha256: sha256(planBytes),
  plan_byte_length: planBytes.byteLength,
  plan_file_hash_in_record: record.plan_file_hash,
  plan_file_hash_agrees: sha256(planBytes) === record.plan_file_hash,
  adapter_artifact_sha256: sha256(adapterBytes),
  adapter_artifact_hash_in_record: record.adapter_artifact_hash,
  adapter_artifact_agrees: sha256(adapterBytes) === record.adapter_artifact_hash,
};

const terminalChecks = {
  ok: verification.ok === true,
  zero_refusals: verification.refusals.length === 0,
  terminal_status_observed_complete: record.terminal_status === "observed_complete",
  independent_certification_absent: record.independent_certification === "absent",
  confinement_absent: record.confinement === "absent",
};

const allAgree =
  Object.values(terminalChecks).every(Boolean) &&
  independent.record_core_hash_agrees &&
  independent.plan_file_hash_agrees &&
  independent.adapter_artifact_agrees;

const result = {
  verifier: "@erl2/core verifyTrustedLocalObservationRecord (unmodified Lab code)",
  inputs: { recordPath, planPath, registryRoot, adapterEntryPath, retainedInputRoot },
  verification,
  independent_recomputation: independent,
  terminal_checks: terminalChecks,
  overall_pass: allAgree,
};

console.log(JSON.stringify(result, null, 2));
process.exit(allAgree ? 0 : 1);
