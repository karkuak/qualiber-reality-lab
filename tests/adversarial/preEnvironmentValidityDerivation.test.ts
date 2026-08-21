/**
 * RL-D-028 — the retained pre-environment validity verdict, read instead of derived.
 *
 * ## The boundary this file measures
 *
 * The environment branch stopped believing its producer some time ago:
 * `deriveValidityOutcome` recomputes `status` from `gate_results` and refuses a
 * result that disagrees with its own gates. The pre-environment branch never
 * did. It reads the *signed constant* `attestation.lab_validity` and never opens
 * the retained `pre-environment-validity-result/v1` at all — so the gates that
 * decide whether the run was valid are, on this branch, evidence nobody checks.
 *
 * The attacker here is not an arbitrary reader: every case below is **fully
 * re-signed** with the repository's development finalizer key, because that is
 * the honest threat model. This is the compromised-or-careless *producer*, and
 * the point of an offline verifier is that holding the key must not be the same
 * thing as being believed. The producer-side invariant is weak in the same way —
 * `assertValidityAdmitsGenericIndex` checks `status` and never recomputes it —
 * so nothing upstream catches this either.
 *
 * ## Why the cascade is built the long way
 *
 * A doctored validity result changes its own core hash, which unbinds the run
 * record, which unbinds the attestation's `run_record_hash`, which is signed.
 * Each case therefore rebuilds the whole chain and re-signs the terminal, so the
 * bundle the verifier sees is **cryptographically impeccable**: every hash
 * recomputed, every signature valid under an authorized role, the signed freeze
 * head still satisfied. Cases C1 and C2 exist to prove that is true — they break
 * one link each and show the hash and signature refusals still fire *first*, so
 * a green result here can never be a crypto check wearing a semantic name.
 *
 * The shipped goldens are copied, never written to.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { chmodSync, cpSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { coreHash, hashBytes, sealSigned } from "@erl2/integrity";
import { deriveValidityOutcome } from "@erl2/public-verifier";
import { erl2 } from "../support/cliRun.js";
import { developmentKeyring } from "../support/keys.js";
import { ownedTempDir } from "../support/tempDirs.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const GOLDEN = path.join(repoRoot, "fixtures", "golden", "valid-pre-environment-run");

interface Copy {
  readonly dir: string;
  readonly artifacts: string;
  readonly lifecycle: string;
}

function copyGolden(): Copy {
  const dir = ownedTempDir("erl2-d028-");
  cpSync(GOLDEN, dir, { recursive: true });
  return { dir, artifacts: path.join(dir, "artifacts"), lifecycle: path.join(dir, "lifecycle.json") };
}

interface Outcome {
  readonly exitCode: number;
  readonly code: string;
  readonly message: string;
  readonly verdict: string;
}

function verifyOffline(c: Copy): Outcome {
  const result = erl2([
    "verify",
    "--public-bundle", path.join(c.dir, "public-bundle.json"),
    "--root-config", path.join(c.dir, "root-config.json"),
    "--artifact-root", c.artifacts,
    "--lifecycle", c.lifecycle,
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

type Json = Record<string, unknown>;

function readJson(file: string): Json {
  return JSON.parse(readFileSync(file, "utf8")) as Json;
}

function writeJson(file: string, value: Json): void {
  // The goldens are frozen read-only; a newly planted artifact has no mode yet.
  try {
    chmodSync(file, 0o644);
  } catch {
    /* the file does not exist yet */
  }
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** Recomputes `core_hash` over the body and writes the artifact back. */
function reseal(file: string, body: Json): string {
  const { core_hash: _drop, signature: _sig, ...rest } = body;
  const hash = coreHash(rest);
  writeJson(file, { ...rest, core_hash: hash });
  return hash;
}

interface GateRow {
  gate_id: string;
  passed: boolean;
  evidence_refs?: string[];
}

/**
 * Rebuilds the whole terminal chain around a doctored validity result and
 * re-signs it, so the bundle the verifier reads is internally impeccable.
 *
 * Returns the new attestation hash so a caller can assert the terminal really
 * was re-signed rather than left stale.
 */
function resignCascade(c: Copy, doctor: (validity: Json) => Json): { attestationHash: string } {
  const keyring = developmentKeyring();
  const retained = path.join(c.artifacts, "retained");

  type Event = Json & {
    produced: { artifact_role: string; artifact_core_hash: string; artifact_schema_version: string }[];
    core_hash: string;
    prior_event_hash?: string;
  };

  const readEvents = (): Event[] => JSON.parse(readFileSync(c.lifecycle, "utf8")) as Event[];
  const writeEvents = (events: readonly Event[]): void => {
    chmodSync(c.lifecycle, 0o644);
    writeFileSync(c.lifecycle, `${JSON.stringify(events, null, 2)}\n`);
  };
  const rechain = (events: readonly Event[]): Event[] => {
    const out: Event[] = [];
    let prior: string | undefined;
    for (const event of events) {
      const next = { ...event } as Event;
      if (prior === undefined) delete next.prior_event_hash;
      else next.prior_event_hash = prior;
      const { core_hash: _drop, ...body } = next;
      const sealed = { ...body, core_hash: coreHash(body) } as Event;
      out.push(sealed);
      prior = sealed.core_hash;
    }
    return out;
  };
  const remapProduced = (events: readonly Event[], role: string, hash: string): Event[] =>
    events.map((e) =>
      e.produced.some((p) => p.artifact_role === role)
        ? ({
            ...e,
            produced: e.produced.map((p) => (p.artifact_role === role ? { ...p, artifact_core_hash: hash } : p)),
          } as Event)
        : e,
    );

  // 1. the doctored validity result
  const validityPath = path.join(retained, "validity-result.json");
  const validityHash = reseal(validityPath, doctor(readJson(validityPath)));

  // 2. The event that *published* the validity result lies before the signed
  //    freeze point, so re-pointing it moves the freeze head. That is exactly
  //    what a producer doing this legitimately would do, and it is why the
  //    cascade has to run the chain twice: once to settle the head, and once to
  //    settle the terminal that commits to it.
  const settled = rechain(remapProduced(readEvents(), "validity-result", validityHash));
  const at = settled.findIndex((e) => e.produced.some((p) => p.artifact_role === "run-record"));
  const freezeHead = (settled[at - 1] as Event).core_hash;

  // 3. the run record rebinds to both the result and the new freeze head
  const recordPath = path.join(retained, "run-record.json");
  const recordHash = reseal(recordPath, {
    ...readJson(recordPath),
    validity_result_hash: validityHash,
    lifecycle_head_hash: freezeHead,
  });

  // 4. the terminal attestation is re-signed over the new record
  const attestationPath = path.join(retained, "final-attestation.json");
  const { core_hash: _ah, signature: _as, ...attBody } = readJson(attestationPath);
  const sealed = sealSigned({ ...attBody, run_record_hash: recordHash }, keyring.finalizer) as Json;
  writeJson(attestationPath, sealed);
  const attestationHash = sealed["core_hash"] as string;

  // 5. the publishing event re-states what it published. It is the last event,
  //    so this second re-chain cannot disturb the freeze head settled above.
  const republished = rechain(
    remapProduced(remapProduced(settled, "run-record", recordHash), "final-attestation", attestationHash),
  );
  assert.equal(
    (republished[at - 1] as Event).core_hash,
    freezeHead,
    "republishing the terminal must not move the signed freeze head",
  );
  writeEvents(republished);

  // 6. both bundle copies re-point at the re-signed attestation, byte
  //    descriptor included -- the outer one is the CLI argument, the retained
  //    one is what the index enumerates, and they must stay identical.
  const attestationBytes = readFileSync(attestationPath);
  for (const bundlePath of [path.join(c.dir, "public-bundle.json"), path.join(retained, "public-bundle.json")]) {
    const bundle = readJson(bundlePath);
    const member = bundle["final_attestation"] as Json;
    const artifact = member["artifact"] as Json;
    const { core_hash: _bh, ...rest } = bundle;
    const body: Json = {
      ...rest,
      final_attestation: {
        ...member,
        artifact: {
          ...artifact,
          byte_length: statSync(attestationPath).size,
          file_sha256: hashBytes(attestationBytes),
        },
        artifact_core_hash: attestationHash,
      },
    };
    writeJson(bundlePath, { ...body, core_hash: coreHash(body) });
  }
  return { attestationHash };
}

function gates(validity: Json): GateRow[] {
  return validity["gate_results"] as GateRow[];
}

// -- baseline ----------------------------------------------------------------

test("D028-BASELINE: the honest pre-environment golden verifies offline", () => {
  const outcome = verifyOffline(copyGolden());
  assert.equal(outcome.exitCode, 0, `${outcome.code}: ${outcome.message}`);
  assert.equal(outcome.verdict, "valid");
});

test("D028-BASELINE: the cascade itself preserves a valid bundle", () => {
  // Without this, every case below could be passing because the cascade breaks
  // something incidental rather than because of the contradiction under test.
  const c = copyGolden();
  const before = readJson(path.join(c.artifacts, "retained", "final-attestation.json"))["core_hash"];
  const { attestationHash } = resignCascade(c, (v) => v);
  // An identity doctor must land back on the shipped terminal: that is what
  // makes the cascade a faithful rebuild rather than a rewrite.
  assert.equal(attestationHash, before, "a faithful cascade must reproduce the shipped terminal");
  const outcome = verifyOffline(c);
  assert.equal(outcome.exitCode, 0, `a faithful re-sign must still verify: ${outcome.code}: ${outcome.message}`);
  assert.equal(outcome.verdict, "valid");
});

// -- attacks -----------------------------------------------------------------

test("D028-A1: a fully re-signed bundle whose retained result declares status invalid is refused", () => {
  const c = copyGolden();
  resignCascade(c, (v) => ({
    ...v,
    status: "invalid",
    gate_results: gates(v).map((g, i) => (i === 0 ? { ...g, passed: false } : g)),
  }));
  const outcome = verifyOffline(c);
  assert.notEqual(
    outcome.exitCode,
    0,
    `a bundle attesting a run its own gates invalidate must be refused; verdict ${outcome.verdict}`,
  );
  assert.ok(
    ["EVALUATOR_VALIDITY_GATE_FAILED", "BUNDLE_VARIANT_MISMATCH"].includes(outcome.code),
    `the refusal must be the semantic derivation: ${outcome.code}: ${outcome.message}`,
  );
});

test("D028-A2: a fully re-signed bundle claiming status valid over a failed gate is refused", () => {
  const c = copyGolden();
  // The exact contradiction the environment branch already refuses and this one
  // accepted: the result's own gate says the run failed, and its `status` says
  // otherwise. Nothing else in the bundle disagrees.
  resignCascade(c, (v) => ({
    ...v,
    status: "valid",
    gate_results: gates(v).map((g, i) => (i === 0 ? { ...g, passed: false } : g)),
  }));
  const outcome = verifyOffline(c);
  assert.notEqual(outcome.exitCode, 0, `a status/gate contradiction must be refused; verdict ${outcome.verdict}`);
  assert.equal(
    outcome.code,
    "EVALUATOR_VALIDITY_GATE_FAILED",
    `the refusal must be the derived-status mismatch: ${outcome.message}`,
  );
});

test("D028-A3: a missing retained validity result is refused", () => {
  const c = copyGolden();
  rmSync(path.join(c.artifacts, "retained", "validity-result.json"));
  const outcome = verifyOffline(c);
  assert.notEqual(outcome.exitCode, 0, "a bundle with no validity result must be refused");
  assert.equal(outcome.code, "GRAPH_CLOSURE_UNREACHABLE_ARTIFACT", outcome.message);
});

test("D028-A4: a second retained validity result is refused", () => {
  const c = copyGolden();
  const source = readJson(path.join(c.artifacts, "retained", "validity-result.json"));
  const { core_hash: _drop, ...body } = source;
  reseal(path.join(c.artifacts, "retained", "validity-result-second.json"), {
    ...body,
    evaluated_at: "2026-07-01T00:00:25Z",
  });
  const outcome = verifyOffline(c);
  assert.notEqual(outcome.exitCode, 0, "exactly one validity result may be admitted");
  assert.equal(outcome.code, "GRAPH_CLOSURE_EXTRA_ARTIFACT", outcome.message);
});

test("D028-A5: a malformed retained validity result is refused", () => {
  const c = copyGolden();
  // Still declares `pre-environment-validity-result/v1`; no longer satisfies it.
  resignCascade(c, (v) => {
    const { gate_results: _drop, ...rest } = v;
    return { ...rest, status: "valid" };
  });
  const outcome = verifyOffline(c);
  assert.notEqual(outcome.exitCode, 0, "a malformed validity result must be refused");
  assert.ok(
    ["GRAPH_CLOSURE_RETAINED_CONTRACT_INVALID", "SCHEMA_VALIDATION_FAILED"].includes(outcome.code),
    `the refusal must be contract validation: ${outcome.code}: ${outcome.message}`,
  );
});

test("D028-A6: invalidity findings cited by an all-passing validity result are refused", () => {
  const c = copyGolden();
  // The finding resolves -- it is the golden's own retained finding -- so this
  // is not a dangling-reference refusal. A result whose every gate passed has
  // nothing to explain, and citing an invalidity for it is a contradiction.
  const finding = readJson(
    path.join(c.artifacts, "retained", "subject-package-verification-finding.json"),
  )["core_hash"] as string;
  resignCascade(c, (v) => ({ ...v, status: "valid", invalidity_finding_hashes: [finding] }));
  const outcome = verifyOffline(c);
  assert.notEqual(outcome.exitCode, 0, "a valid result citing invalidity findings must be refused");
  assert.equal(outcome.code, "EVALUATOR_VALIDITY_GATE_FAILED", outcome.message);
});

// -- ordering controls -------------------------------------------------------

test("D028-C1: a stale artifact hash is refused before any semantic interpretation", () => {
  const c = copyGolden();
  const validityPath = path.join(c.artifacts, "retained", "validity-result.json");
  const validity = readJson(validityPath);
  // Doctored and left *unresealed*: the declared core hash no longer matches.
  writeJson(validityPath, {
    ...validity,
    gate_results: gates(validity).map((g, i) => (i === 0 ? { ...g, passed: false } : g)),
  });
  const outcome = verifyOffline(c);
  assert.notEqual(outcome.exitCode, 0, "a stale hash must be refused");
  assert.equal(
    outcome.code,
    "ARTIFACT_HASH_MISMATCH",
    `hash checks must precede semantic derivation: ${outcome.message}`,
  );
});

test("D028-C2: an invalid terminal signature is refused before any semantic interpretation", () => {
  const c = copyGolden();
  const retained = path.join(c.artifacts, "retained");
  const attestationPath = path.join(retained, "final-attestation.json");
  const original = readFileSync(attestationPath, "utf8");
  const signature = (readJson(attestationPath)["signature"] as Json)["signature_base64"] as string;
  // Byte-for-byte the same length, and the bundle's payload descriptor is
  // re-pointed at the forged bytes, so the referenced-bytes pass cannot be what
  // refuses. `signature` is excluded from the core hash by design, so the
  // attestation's identity -- and every binding to it -- is untouched: the only
  // thing wrong with this bundle is that the signature does not verify.
  const forged = Buffer.alloc(64, 7).toString("base64");
  assert.equal(forged.length, signature.length, "the forged signature must preserve byte length");
  chmodSync(attestationPath, 0o644);
  writeFileSync(attestationPath, original.replace(signature, forged));

  const bytes = readFileSync(attestationPath);
  assert.equal(bytes.byteLength, Buffer.byteLength(original), "byte length must be unchanged");
  const forgedAttestation = readJson(attestationPath);
  for (const bundlePath of [path.join(c.dir, "public-bundle.json"), path.join(retained, "public-bundle.json")]) {
    const bundle = readJson(bundlePath);
    const member = bundle["final_attestation"] as Json;
    const artifact = member["artifact"] as Json;
    const { core_hash: _bh, ...rest } = bundle;
    const body: Json = {
      ...rest,
      final_attestation: { ...member, artifact: { ...artifact, file_sha256: hashBytes(bytes) } },
    };
    writeJson(bundlePath, { ...body, core_hash: coreHash(body) });
  }
  assert.equal(
    forgedAttestation["core_hash"],
    readJson(path.join(c.dir, "public-bundle.json"))["final_attestation"] &&
      ((readJson(path.join(c.dir, "public-bundle.json"))["final_attestation"] as Json)[
        "artifact_core_hash"
      ] as string),
    "the forged attestation must keep the identity every binding already points at",
  );

  const outcome = verifyOffline(c);
  assert.notEqual(outcome.exitCode, 0, "a forged signature must be refused");
  assert.equal(
    outcome.code,
    "TRUST_SIGNATURE_INVALID",
    `signature checks must precede semantic derivation: ${outcome.message}`,
  );
});

// -- parity ------------------------------------------------------------------

test("D028-PARITY: the environment branch refuses the analogous contradiction, and still does", () => {
  // The pre-environment fix exists to reach parity with this. Asserting the
  // environment behaviour in the same file means a future edit cannot quietly
  // close one branch and reopen the other.
  const validity = {
    schema_version: "environment-validity-result/v1",
    status: "valid",
    gate_results: [
      // Both are real `ENVIRONMENT_GATE_IDS` members the shipped environment
      // producer emits (`environmentRun.ts`), so the contradiction under test is
      // between a declared status and rows this branch actually evaluates --
      // not between a status and fixture scaffolding. Two rows are not the
      // required set and are not claimed to be: completeness is RL-D-031.
      { gate_id: "trust-policy-resolved", passed: true, evidence_refs: [] },
      { gate_id: "cleanup-verified", passed: false, evidence_refs: [] },
    ],
    invalidity_finding_hashes: [],
  } as unknown as Parameters<typeof deriveValidityOutcome>[0]["validity"];

  assert.throws(
    () =>
      deriveValidityOutcome({
        index: { get: () => ({ value: {} }) } as unknown as Parameters<typeof deriveValidityOutcome>[0]["index"],
        validity,
        requireValid: true,
        outcomes: [],
        telemetryObservationRetained: false,
      }),
    (error: unknown) => (error as { code?: string }).code === "EVALUATOR_VALIDITY_GATE_FAILED",
    "the environment derivation must refuse a status/gate contradiction",
  );
});
