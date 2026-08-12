/**
 * The governed `SubjectPort` refuses a local-observation host.
 *
 * ## Why this file exists
 *
 * `HostedSubjectPort` is the seam through which a governed run reaches a
 * subject adapter, so its refusal of a `subject-adapter/v2` host is the one
 * execution-path expression of "local observation never enters governed
 * execution". Every other proof of that boundary is a schema-shape assertion:
 * the claim-firewall matrix shows that no local artifact validates against a
 * governed contract, which is true and useful, and says nothing about whether
 * any code path would accept one.
 *
 * An independent review mutated the guard to `if (false)`, rebuilt, and watched
 * the entire targeted suite stay green — no test anywhere constructed a v2 host
 * and offered it to the governed port. The guard was correct and unproven, which
 * for a claim boundary is the same as unguarded: the next refactor deletes it
 * and nothing objects.
 *
 * ## What is asserted
 *
 * The refusal is proven behaviourally rather than by catching a string. A
 * dispatch sentinel — the per-operation working directory and the retained
 * artifact store that a real dispatch cannot avoid creating — is shown to be
 * untouched after the refusal, and shown to be populated by a genuine dispatch,
 * so "nothing ran" is a measurement and not an absence of evidence.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readdirSync } from "node:fs";
import { CODES, Erl2Error } from "@erl2/contracts";
import { HostedSubjectPort, LocalObservationCoordinator } from "@erl2/core";
import { LOCAL_NOW, newLocalHost } from "../support/localObservationFixtures.js";

function refusalOf(fn: () => unknown): Erl2Error {
  try {
    fn();
  } catch (cause) {
    if (cause instanceof Erl2Error) return cause;
    throw cause;
  }
  throw new Error("expected a typed refusal");
}

/** Everything a real dispatch leaves behind, as one comparable value. */
function sentinel(fixture: ReturnType<typeof newLocalHost>): {
  readonly workspace: readonly string[];
  readonly store: readonly string[];
} {
  const list = (root: string): readonly string[] => {
    try {
      return readdirSync(root).sort();
    } catch {
      return [];
    }
  };
  return { workspace: list(fixture.workspaceRoot), store: list(fixture.storeRoot) };
}

test("GOVERNED-PORT: a v2 local-observation host cannot enter the governed SubjectPort", () => {
  const fixture = newLocalHost();
  const before = sentinel(fixture);

  const error = refusalOf(() => new HostedSubjectPort(fixture.host));
  assert.equal(error.code, CODES.ADAPTER_EXECUTION_MODE_UNSUPPORTED);

  // The sentinel: refusal happened before anything was dispatched.
  assert.deepEqual(
    sentinel(fixture),
    before,
    "the refused port left a dispatch trace; adapter bytes may have executed",
  );
});

test("GOVERNED-PORT: the refusal is deterministic across repeated attempts", () => {
  const fixture = newLocalHost();
  const codes = [0, 1, 2].map(() => refusalOf(() => new HostedSubjectPort(fixture.host)).code);
  assert.deepEqual(codes, [
    CODES.ADAPTER_EXECUTION_MODE_UNSUPPORTED,
    CODES.ADAPTER_EXECUTION_MODE_UNSUPPORTED,
    CODES.ADAPTER_EXECUTION_MODE_UNSUPPORTED,
  ]);
  assert.equal(
    refusalOf(() => new HostedSubjectPort(fixture.host)).owner,
    refusalOf(() => new HostedSubjectPort(fixture.host)).owner,
  );
});

test("GOVERNED-PORT: the sentinel is real — a genuine local dispatch moves it", () => {
  // Without this, "nothing changed" above would be indistinguishable from
  // "this sentinel never changes".
  const fixture = newLocalHost();
  const before = sentinel(fixture);

  const coordinator = new LocalObservationCoordinator(fixture.plan);
  const terminal = coordinator.execute(
    fixture.host,
    fixture.request,
    LOCAL_NOW,
    () => "2026-08-12T18:00:03Z",
  );
  assert.equal(terminal.state, "completed");

  const after = sentinel(fixture);
  assert.notDeepEqual(after, before, "a real dispatch must move the sentinel");
  assert.ok(after.store.length > 0, "a real dispatch retains artifacts");
});

test("GOVERNED-PORT: the local host still dispatches normally on its own path", () => {
  // The refusal must be about the governed seam, not about the v2 host being
  // broken. The same host the port rejected completes a local observation.
  const fixture = newLocalHost();
  const coordinator = new LocalObservationCoordinator(fixture.plan);
  const terminal = coordinator.execute(
    fixture.host,
    fixture.request,
    LOCAL_NOW,
    () => "2026-08-12T18:00:03Z",
  );
  assert.equal(terminal.state, "completed");
  assert.equal(terminal.response_status, "supported");
  assert.equal(terminal.evidence_authenticity, "unauthenticated_local_record");
});
