/**
 * JOURNEY-ORACLE-CANARY: the split between subject-visible steps and encrypted
 * judge expectations (design v2 §10, ERL2-FR-015, ERL2-AC-012).
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ageDecrypt,
  ArtifactStore,
  ageRecipientOf,
  developmentAgeIdentity,
  jcsBytes,
} from "@erl2/integrity";
import {
  assertNoCanaryLeak,
  assertNoOracleFields,
  assertVisibleStepMatchesCommitment,
  commitJourneyStep,
  FakeSubjectPort,
  ORACLE_SCAN_SURFACES,
  scanForCanaries,
  type OracleScanTarget,
} from "@erl2/core";
import { developmentKeyring } from "../support/keys.js";

const keyring = developmentKeyring();

function commit() {
  const root = mkdtempSync(path.join(tmpdir(), "erl2-oracle-"));
  const store = new ArtifactStore(root);
  const judge = developmentAgeIdentity("judge");
  const step = commitJourneyStep({
    visible: {
      stepId: "install",
      intent: "install",
      actorRole: "operations-engineer",
      interactionKinds: ["cli"],
      timeoutMs: 60_000,
      maxAttempts: 3,
      backoffId: "full-jitter-500ms",
    },
    expectation: {
      expectedObservations: [
        {
          observation_id: "install-succeeded",
          predicate_id: "process-running",
          required: true,
          proof_source_ids: ["service-metric"],
        },
      ],
      permittedFailureCategories: ["subject_installation_failure"],
      attributionRequirements: [],
      truthScope: "functional",
    },
    store,
    recipients: [ageRecipientOf(judge)],
    governorKey: keyring.challengeGovernor,
    committedAt: "2026-07-01T00:00:00Z",
  });
  return { root, store, judge, step };
}

test("JOURNEY-ORACLE-CANARY: the visible step carries no expectation and no canary", () => {
  const { step } = commit();
  const visibleText = jcsBytes(step.visibleStep).toString("utf8");
  assert.ok(!visibleText.includes(step.canaryId));
  for (const forbidden of ["expected_observations", "oracle_canary_id", "truth_scope", "predicate_id"]) {
    assert.ok(!visibleText.includes(forbidden), `visible step exposes ${forbidden}`);
  }
  assertNoOracleFields("visible step", step.visibleStep);
});

test("JOURNEY-ORACLE-CANARY: the commitment binds the expectation without revealing it", () => {
  const { step, judge, store } = commit();
  assertVisibleStepMatchesCommitment(step.visibleStep, step.commitment);
  const commitmentText = jcsBytes(step.commitment).toString("utf8");
  assert.ok(!commitmentText.includes(step.canaryId));
  assert.equal(step.commitment.encryption, "age-x25519");

  // Only the judge can open it, and what opens matches the commitment.
  const ciphertext = store.read(step.ciphertextRef.path);
  assert.throws(() => ageDecrypt(ciphertext, developmentAgeIdentity("selector")));
  const plaintext = ageDecrypt(ciphertext, judge);
  assert.equal(
    JSON.parse(plaintext.toString("utf8"))["oracle_canary_id"],
    step.canaryId,
  );
});

test("JOURNEY-ORACLE-CANARY: every design-named surface is scanned", () => {
  const { step } = commit();
  assert.deepEqual([...ORACLE_SCAN_SURFACES], [
    "adapter_request",
    "mounted_file",
    "environment_variable",
    "process_argument",
    "diagnostics",
    "subject_output_prefill",
    "network_egress",
    "lab_telemetry",
  ]);
  for (const surface of ORACLE_SCAN_SURFACES) {
    const targets: OracleScanTarget[] = [
      { surface, label: `${surface}-probe`, bytes: `noise ${step.canaryId} noise` },
    ];
    assert.equal(scanForCanaries(targets, [step.canaryId]).length, 1);
    assert.throws(
      () => assertNoCanaryLeak(targets, [step.canaryId]),
      (e: unknown) =>
        (e as { code: string }).code === "JOURNEY_ORACLE_CANARY_LEAKED" &&
        (e as { owner: string }).owner === "lab",
      `surface ${surface} was not scanned`,
    );
  }
});

test("JOURNEY-ORACLE-CANARY: an unknown but well-formed canary is still a leak", () => {
  const foreign = `erl2-canary-${"a".repeat(32)}`;
  assert.throws(
    () =>
      assertNoCanaryLeak(
        [{ surface: "adapter_request", label: "request", bytes: foreign }],
        ["erl2-canary-" + "b".repeat(32)],
      ),
    (e: unknown) => (e as { code: string }).code === "JOURNEY_ORACLE_CANARY_LEAKED",
  );
});

test("JOURNEY-ORACLE-FIELD: the subject port refuses an expectation-shaped request", () => {
  const port = new FakeSubjectPort();
  assert.throws(
    () =>
      port.step(
        {
          schema_version: "adapter-step-request/v1",
          expected_observations: [{ observation_id: "x" }],
        } as never,
        "install",
      ),
    (e: unknown) => (e as { code: string }).code === "JOURNEY_ORACLE_FIELD_PRESENT",
  );
  assert.equal(port.observedRequests.length, 0);
});

test("JOURNEY-ORACLE-CANARY: the ciphertext on disk leaks nothing in cleartext", () => {
  const { step, store } = commit();
  const raw = store.read(step.ciphertextRef.path).toString("latin1");
  assert.ok(raw.startsWith("age-encryption.org/v1\n"));
  assert.ok(!raw.includes(step.canaryId));
  assert.ok(!raw.includes("expected_observations"));
  assert.ok(!raw.includes("process-running"));
});

test("JOURNEY-ORACLE-CANARY: a tampered visible step no longer matches its commitment", () => {
  const { step } = commit();
  const tampered = { ...step.visibleStep, timeout_ms: 1 };
  assert.throws(
    () => assertVisibleStepMatchesCommitment(tampered, step.commitment),
    (e: unknown) => (e as { code: string }).code === "REQUEST_ANCESTRY_INVALID",
  );
});

test("JOURNEY-ORACLE-CANARY: nothing under a run root or registry matches the canary pattern", () => {
  const { root } = commit();
  // The vault store is the only place a ciphertext lives, and it is opaque.
  const text = readFileSync(path.join(root, "commitments", "visible-steps", "install.json"), "utf8");
  assert.equal(text.match(/erl2-canary-[0-9a-f]{32}/g), null);
});
