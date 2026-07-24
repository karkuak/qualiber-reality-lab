/**
 * Runtime version record (6R-D §9.5, review G).
 *
 * The project targets Node 22 (`engines.node >= 22`). The review noted the gate
 * was authored on a different runtime and that this was not recorded. This test
 * records the actual runtime and enforces the declared floor, so a run on an
 * unsupported Node fails loudly rather than silently claiming cross-platform
 * completion.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";

test("NODE-VERSION: the runtime satisfies the declared engines floor (>= 22)", () => {
  const version = process.versions.node;
  const major = Number.parseInt(version.split(".")[0] as string, 10);
  // Recorded in the test log for the evidence trail.
  console.log(`# runtime node ${version} (target: >= 22)`);
  assert.ok(Number.isFinite(major), `unparseable node version ${version}`);
  assert.ok(major >= 22, `this workspace targets Node >= 22; running on ${version}`);
});
