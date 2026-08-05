/**
 * The supported cancellation path's operation identifiers.
 *
 * ## The defect
 *
 * `executeFrontierDerivedCleanup` derived one operation id per emergency action
 * as `op-emergency-${action.action_id}`, and `action_id` is itself composed by
 * `freezeResourceFrontier` as `<action-kind>-<resource_id>`. Three prefixes
 * stacked — 13 characters for `op-emergency-`, up to 25 for the action kind, and
 * the substrate's own resource id — while
 * `EnvironmentOperationReceiptV1.operation_id` is `erl2:common#/$defs/Id`:
 * `^[a-z][a-z0-9-]{0,63}$`.
 *
 * On the qualified OpenTelemetry Demo subset that is not a theoretical overflow.
 * A `container` resource maps to the `destroy_partial_resource` action kind, so
 * a live cancellation derived
 *
 *   op-emergency-destroy-partial-resource-container-otel-collector-<runid8>
 *
 * at 71 characters. The frontier itself was valid; the id derived from it was
 * not, and the receipt failed contract validation *after* the destroy had been
 * dispatched — so the branch threw mid-sequence and left the remaining
 * resources behind.
 *
 * ## What is asserted
 *
 * The first three cases pin the derivation itself against the inputs a real
 * substrate produces, including the exact one that fired. The last two pin the
 * two properties a durable-intent key must have and that a sanitizer would not:
 * stability across retries, and distinctness across distinct actions.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { emergencyOperationId } from "@erl2/core";

/** The contract's identifier shape, written out rather than imported as prose. */
const ID = /^[a-z][a-z0-9-]{0,63}$/;

const RUN_ID = "01890000-0000-7000-8000-00000000000d";

/**
 * The action ids a real Compose frontier produces, worst case first.
 *
 * `destroy-partial-resource-container-otel-collector-01890000` is the one the
 * live run actually derived; the rest are the other resource kinds the driver
 * reports for the same environment.
 */
const REAL_COMPOSE_ACTION_IDS = [
  "destroy-partial-resource-container-otel-collector-01890000",
  "destroy-partial-resource-container-quote-01890000",
  "destroy-partial-resource-port-01890000",
  "isolate-network-challenge-network-01890000",
  "teardown-remaining-project-01890000",
  "contain-unverified-container-otel-collector-01890000",
] as const;

test("EMERGENCY-ID: every real Compose action id yields a schema-valid operation id", () => {
  for (const actionId of REAL_COMPOSE_ACTION_IDS) {
    const derived = emergencyOperationId(RUN_ID, actionId);
    assert.match(derived, ID, `${actionId} derived the schema-invalid id ${derived}`);
  }
  // The regression itself: the previous scheme is invalid for the live case, so
  // this case would have passed vacuously if the input were not the real one.
  const previous = `op-emergency-${REAL_COMPOSE_ACTION_IDS[0]}`;
  assert.equal(previous.length, 71);
  assert.equal(ID.test(previous), false, "the pinned regression input is no longer the failing one");
});

test("EMERGENCY-ID: an overlong resource id yields a schema-valid operation id", () => {
  // 512 characters, far beyond anything an `Id` may hold, so the derivation is
  // shown to be independent of its input's length rather than merely lucky.
  const derived = emergencyOperationId(RUN_ID, `destroy-partial-resource-${"z".repeat(512)}`);
  assert.match(derived, ID);
});

test("EMERGENCY-ID: unsafe characters in an action id yield a schema-valid operation id", () => {
  // The Compose driver strips these before the frontier sees them, and a future
  // driver need not. Underscores, uppercase, dots, slashes and spaces all
  // survive as a valid id because none of them reaches the name.
  for (const actionId of [
    "destroy_partial_resource_otel_collector_1",
    "Destroy-Resource-Container",
    "destroy/../resource",
    "destroy resource with spaces",
    "destroy.resource.v2",
  ]) {
    assert.match(emergencyOperationId(RUN_ID, actionId), ID, `unsafe input ${actionId} leaked`);
  }
});

test("EMERGENCY-ID: the same action derives the same id on every attempt", () => {
  // The id keys a durable intent. An id that moved between the first attempt and
  // the reconciliation after a crash would make the journal record two
  // operations for one destroy, which is the ambiguity the journal exists to
  // remove.
  const first = emergencyOperationId(RUN_ID, REAL_COMPOSE_ACTION_IDS[0]);
  for (let i = 0; i < 4; i += 1) {
    assert.equal(emergencyOperationId(RUN_ID, REAL_COMPOSE_ACTION_IDS[0]), first);
  }
  // …and it is scoped to the run, so two runs cleaning up the same-named
  // resource do not share an intent key.
  assert.notEqual(
    emergencyOperationId("01890000-0000-7000-8000-00000000000e", REAL_COMPOSE_ACTION_IDS[0]),
    first,
  );
});

test("EMERGENCY-ID: a second attempt at one action is a distinct operation", () => {
  // The executor makes a bounded second attempt at any safe action whose target
  // the substrate still reports — the frontier orders actions for *containment*,
  // with no knowledge of how the substrate's objects depend on one another, so a
  // first attempt can fail purely because a dependency had not been removed yet.
  // Measured live: the run's Compose network could not be removed while its two
  // containers were still attached to it, and both were destroyed afterwards.
  //
  // A driver may memoize a completed operation by its id, so the retry has to be
  // a distinct operation or it would be handed the first attempt's receipt
  // without re-dispatching anything.
  const first = emergencyOperationId(RUN_ID, REAL_COMPOSE_ACTION_IDS[0], 1);
  const second = emergencyOperationId(RUN_ID, REAL_COMPOSE_ACTION_IDS[0], 2);
  assert.notEqual(second, first, "the retry reused the first attempt's operation id");
  assert.match(second, ID);
  // …and the default is attempt 1, so a caller that does not say which attempt
  // it means gets the first one rather than a fourth distinct id.
  assert.equal(emergencyOperationId(RUN_ID, REAL_COMPOSE_ACTION_IDS[0]), first);
});

test("EMERGENCY-ID: distinct actions derive distinct ids, including near-collisions", () => {
  const inputs = [
    ...REAL_COMPOSE_ACTION_IDS,
    // The pairs a sanitizer collapses: one differing only in a stripped
    // character, and one differing only beyond the 64th.
    "destroy_partial_resource_a",
    "destroy-partial-resource-a",
    `destroy-partial-resource-${"a".repeat(60)}-one`,
    `destroy-partial-resource-${"a".repeat(60)}-two`,
  ];
  const derived = inputs.map((actionId) => emergencyOperationId(RUN_ID, actionId));
  assert.equal(new Set(derived).size, inputs.length, "two distinct actions share one operation id");
  for (const id of derived) assert.match(id, ID);
});
