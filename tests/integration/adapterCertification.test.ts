/**
 * ADAPTER-CERT: the certification harness, run against real adapters.
 *
 * The correct and limited reference adapters are certified through exactly the
 * public SDK and protocol any future opaque subject would use. The hostile
 * fixtures are put through the *same* suite and refused, which is what proves
 * the suite discriminates rather than rubber-stamping.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { certifyAdapter, SteppingClock } from "@erl2/core";
import { Erl2Error } from "@erl2/contracts";
import {
  adapterManifest,
  referenceAdapterEntry,
  REFERENCE_CORRECT_MANIFEST,
  REFERENCE_LIMITED_MANIFEST,
  sabotageAdapterEntry,
} from "../support/adapterFixtures.js";

const clock = (): SteppingClock => new SteppingClock("2026-07-01T00:00:00Z", 1000);

test("ADAPTER-CERT: the correct reference adapter certifies through the public protocol", () => {
  const receipt = certifyAdapter({
    adapterManifest: REFERENCE_CORRECT_MANIFEST(),
    adapterEntryPath: referenceAdapterEntry("reference-correct"),
    clock: clock(),
    certifierId: "erl2-certifier",
  });
  assert.equal(receipt.verdict, "certified", JSON.stringify(receipt.refusal_codes));
  assert.deepEqual(receipt.refusal_codes, []);
  assert.equal(receipt.suite, "ADAPTER-CERT-V1");
  assert.equal(receipt.certifier_is_adapter_owner, false);

  const failed = receipt.checks.filter((c) => c.status === "failed");
  assert.deepEqual(failed, []);
  const byId = new Map(receipt.checks.map((c) => [c.check_id, c.status]));
  for (const required of [
    "immutable-artifact-identity",
    "no-privileged-broker-capability",
    "no-product-specific-core-change",
    "protocol-negotiation",
    "unsupported-retention",
    "diagnostics-bounds",
    "deterministic-projection",
    "phase-request-ancestry",
    "oracle-partition",
    "mutation-disclosure",
    "unsupported-package-kind",
    "deadline-and-process-tree-termination",
    "no-execution-after-output-freeze",
  ]) {
    assert.equal(byId.get(required), "passed", `check ${required} did not pass`);
  }

  // The receipt reports what the host actually enforces and what it cannot,
  // and never lists the same control in both places.
  assert.ok(receipt.enforced_controls.includes("process-tree-termination"));
  assert.ok(receipt.unsupported_controls.includes("no-docker-socket"));
  assert.ok(receipt.unsupported_controls.includes("read-only-input-mounts"));
  const overlap = receipt.enforced_controls.filter((c) => receipt.unsupported_controls.includes(c));
  assert.deepEqual(overlap, []);
});

test("ADAPTER-CERT: the limited reference adapter certifies, and its honesty is the reason", () => {
  const receipt = certifyAdapter({
    adapterManifest: REFERENCE_LIMITED_MANIFEST(),
    adapterEntryPath: referenceAdapterEntry("reference-limited"),
    clock: clock(),
    certifierId: "erl2-certifier",
  });
  assert.equal(receipt.verdict, "certified", JSON.stringify(receipt.refusal_codes));
  // Its declared kind is `oci`, so an archive must come back unsupported —
  // retained, not filtered, not faked.
  const kindCheck = receipt.checks.find((c) => c.check_id === "unsupported-package-kind");
  assert.equal(kindCheck?.status, "passed");
  assert.match(kindCheck?.detail ?? "", /archive/);
});

test("ADAPTER-CERT: an adapter cannot certify itself", () => {
  assert.throws(
    () =>
      certifyAdapter({
        adapterManifest: REFERENCE_CORRECT_MANIFEST(),
        adapterEntryPath: referenceAdapterEntry("reference-correct"),
        clock: clock(),
        certifierId: "reference-correct",
      }),
    (error: unknown) =>
      (error as Erl2Error).code === "ADAPTER_SELF_CERTIFICATION_REFUSED",
  );
});

test("ADAPTER-CERT: an adapter requiring a privileged capability is refused", () => {
  const receipt = certifyAdapter({
    adapterManifest: adapterManifest({
      adapterId: "privilege-seeking",
      capabilities: ["write-run-output", "install-package-into-host"],
    }),
    adapterEntryPath: referenceAdapterEntry("reference-correct"),
    clock: clock(),
    certifierId: "erl2-certifier",
  });
  assert.equal(receipt.verdict, "refused");
  assert.ok(receipt.refusal_codes.includes("ADAPTER_PRIVILEGED_OPERATION_NOT_SUPPORTED"));
  assert.deepEqual(receipt.certified_operations, []);
});

test("ADAPTER-CERT: an adapter declaring an operation outside the closed enum is refused", () => {
  const receipt = certifyAdapter({
    adapterManifest: adapterManifest({
      adapterId: "core-change-seeking",
      operations: ["acquire", "deep-conformance-scan"],
    }),
    adapterEntryPath: referenceAdapterEntry("reference-correct"),
    clock: clock(),
    certifierId: "erl2-certifier",
  });
  assert.equal(receipt.verdict, "refused");
  assert.ok(receipt.refusal_codes.includes("ADAPTER_OPERATION_UNSUPPORTED"));
  const check = receipt.checks.find((c) => c.check_id === "no-product-specific-core-change");
  assert.equal(check?.status, "failed");
});

const HOSTILE: readonly (readonly [string, string])[] = [
  ["protocol-mismatch", "ADAPTER_PROTOCOL_VERSION_MISMATCH"],
  ["identity-mismatch", "ADAPTER_IDENTITY_MISMATCH"],
  ["crash-before-response", "ADAPTER_PROCESS_CRASHED"],
  ["unknown-frame", "ADAPTER_PROTOCOL_FRAME_INVALID"],
  // The response-shape validator (P2-6) refuses a false Lab-ownership claim and a
  // missing required array as typed frame violations before any field is consumed.
  ["false-attribution", "ADAPTER_PROTOCOL_FRAME_INVALID"],
  ["malformed-response", "ADAPTER_PROTOCOL_FRAME_INVALID"],
];

for (const [fixture, expectedCode] of HOSTILE) {
  test(`ADAPTER-CERT: the ${fixture} adapter is refused with ${expectedCode}`, () => {
    const receipt = certifyAdapter({
      adapterManifest: adapterManifest({
        adapterId: `sabotage-${fixture}`,
        operations: ["acquire", "validate-package"],
      }),
      adapterEntryPath: sabotageAdapterEntry(fixture),
      clock: clock(),
      certifierId: "erl2-certifier",
    });
    assert.equal(receipt.verdict, "refused");
    assert.ok(
      receipt.refusal_codes.includes(expectedCode),
      `expected ${expectedCode}, got ${receipt.refusal_codes.join(", ")}`,
    );
    // A refused adapter certifies no operation and no package kind.
    assert.deepEqual(receipt.certified_operations, []);
    assert.deepEqual(receipt.certified_package_kinds, []);
  });
}

test("ADAPTER-CERT: a missing adapter artifact refuses rather than certifying an absence", () => {
  const receipt = certifyAdapter({
    adapterManifest: adapterManifest({ adapterId: "absent" }),
    adapterEntryPath: `${referenceAdapterEntry("reference-correct")}.missing`,
    clock: clock(),
    certifierId: "erl2-certifier",
  });
  assert.equal(receipt.verdict, "refused");
  assert.ok(receipt.refusal_codes.includes("ADAPTER_IDENTITY_MISMATCH"));
});
