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
 * ## What these controls prove, exactly
 *
 * That **the governed port performs its own early refusal**: offering a v2 host
 * to `HostedSubjectPort` is refused at construction, deterministically, with a
 * typed code, before the port exists to dispatch through.
 *
 * ## What they deliberately do not prove
 *
 * That neutralising this one guard causes adapter bytes to execute. It does not,
 * and an earlier version of this file said otherwise. Enforcement is layered:
 * with the constructor guard disabled, `AdapterHost.run` still refuses every
 * port method by its execution-mode binding, because the governed port never
 * dispatches with `executionMode: "local_observation"`. A second independent
 * review confirmed this by experiment — `acquire`, `validatePackage` and `step`
 * were each still refused, and the sentinel below did not move.
 *
 * The sentinel therefore measures the right thing but carries a narrower claim
 * than it was first given: it shows that no adapter bytes ran *while layered
 * enforcement held*, not that this guard alone is what stops them. Both facts
 * are worth pinning, and `HOST-MODE-BINDING` below pins the second one directly,
 * so the reason the sentinel stays still is itself under test rather than
 * assumed.
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

  // The exact boundary behaviour this control owns: construction itself is the
  // refusal. Neutralising the guard makes this line return a usable port, which
  // is the change the mutation must be caught by — not a message, not a
  // snapshot, and not some later layer's refusal.
  const error = refusalOf(() => new HostedSubjectPort(fixture.host));
  assert.equal(error.code, CODES.ADAPTER_EXECUTION_MODE_UNSUPPORTED);
  assert.equal(error.owner, "lab");

  // The sentinel: nothing was dispatched on the way to that refusal.
  assert.deepEqual(
    sentinel(fixture),
    before,
    "the refused port left a dispatch trace; adapter bytes may have executed",
  );
});

test("HOST-MODE-BINDING: the layer beneath the port refuses governed dispatch on its own", () => {
  // Why the sentinel above stays still even when the port's guard is removed.
  // The governed port dispatches without an execution mode; a v2 host refuses
  // exactly that, so adapter bytes are unreachable through the governed seam
  // whether or not the constructor guard is present. Pinned here so the layered
  // defence is a measured fact rather than a claim in a comment.
  const fixture = newLocalHost();
  const before = sentinel(fixture);

  const error = refusalOf(() =>
    fixture.host.run({
      operation: fixture.request.operation,
      operationId: fixture.request.operation_id,
      request: fixture.request,
      // No `executionMode` — precisely how HostedSubjectPort dispatches.
    }),
  );
  assert.equal(error.code, CODES.ADAPTER_EXECUTION_MODE_UNSUPPORTED);
  assert.deepEqual(sentinel(fixture), before, "a refused governed dispatch must run no adapter bytes");
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
