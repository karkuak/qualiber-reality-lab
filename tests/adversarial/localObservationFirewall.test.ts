import { strict as assert } from "node:assert";
import { test } from "node:test";
import { validateContract } from "@erl2/contracts";
import { LocalObservationCoordinator, PRODUCER_SIGNED_MEMBER_ROLES } from "@erl2/core";
import { ARCHIVE_SHAPE, localFixture } from "../support/localObservationFixtures.js";

const fixture = localFixture(ARCHIVE_SHAPE);
const coordinator = new LocalObservationCoordinator(fixture.plan);
coordinator.declare(fixture.request, "2026-08-12T18:00:00Z");
const record = coordinator.operationRecords[0];
if (record === undefined) throw new Error("local record fixture missing");
const result = coordinator.buildResult("2026-08-12T18:00:00Z", "2026-08-12T18:00:01Z");

const localArtifacts = {
  "local plan": fixture.plan,
  "local request": fixture.request,
  "local operation record": record,
  "local result": result,
} as const;

const governedConsumers = {
  scoring: "MetricResultV1",
  reveal: "JudgeExpectationRevealRecordV1",
  evaluation: "GenericEvaluationIndexV1",
  validity: "ValidityResultV1",
  "terminal finalization": "LabRunRecordV1",
  "public bundle verification": "PublicVerificationBundleV2",
  "governed artifact admission": "ChallengeManifestV1",
  "generic claim import": "FindingV1",
  "evaluator result import": "DomainResultV1",
} as const;

test("LOCAL-FIREWALL: every local type is rejected by every governed consumer contract", () => {
  let checks = 0;
  for (const [localName, local] of Object.entries(localArtifacts)) {
    for (const [consumerName, contract] of Object.entries(governedConsumers)) {
      const validation = validateContract(contract, local);
      assert.equal(
        validation.valid,
        false,
        `${localName} entered ${consumerName} through ${contract}`,
      );
      checks += 1;
    }
  }
  assert.equal(checks, 36);
});

test("LOCAL-FIREWALL: local schemas have no signer role, tier upgrade or governed alias", () => {
  for (const schema of [
    "local-observation-limits/v1",
    "local-observation-plan/v1",
    "local-observation-operation-record/v1",
    "local-observation-result/v1",
    "adapter-response-envelope/v2",
    "sandbox-invocation-manifest/v2",
  ]) {
    assert.equal(PRODUCER_SIGNED_MEMBER_ROLES.has(schema), false, `${schema} gained a signer role`);
  }
  assert.equal("signature" in fixture.plan, false);
  assert.equal("signature" in result, false);
  assert.equal(result.certification_authenticity, "locally_observed_unauthenticated");
  assert.equal(result.evidence_authenticity, "unauthenticated_local_record");
});

test("LOCAL-FIREWALL: projection remains local output and cannot acquire a trusted role", () => {
  const projection = localFixture({
    ...ARCHIVE_SHAPE,
    operation: "project",
    payload: {
      schema_version: "project-payload/v1",
      evidence_input_ids: ["package-input"],
      projection_schema: "neutral-projection-v1",
    },
  });
  assert.equal(validateContract("MetricResultV1", projection.request.operation_payload).valid, false);
  assert.equal(validateContract("FindingV1", projection.request.operation_payload).valid, false);
  assert.equal(validateContract("GenericEvaluationIndexV1", projection.request.operation_payload).valid, false);
});
