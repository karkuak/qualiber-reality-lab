/**
 * The three derivations every invalid environment terminal now rests on
 * (ADR-ERL2-027 §4.1/§4.3/§4.5).
 *
 * These are the *pure* halves: the frontier's action set, the residue probe's
 * outcome, and the phase→gate map. They run in-process in milliseconds, which is
 * what lets the matrix be a matrix — the CLI half of the same package costs ~13s
 * per case and proves behaviour rather than arithmetic.
 *
 * Nothing here reaches for the fake driver's internals. Every case builds the
 * observed resources by hand, because the point is what the *derivation* does
 * with an observation, not what the fake driver happens to observe.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { EnvironmentResourceV1, Hash } from "@erl2/contracts";
import { domainHash, HASH_DOMAINS } from "@erl2/integrity";
import {
  assertFrontierActionsDerivable,
  buildResidueProbe,
  deriveResidueProbeOutcome,
  ENVIRONMENT_PHASE_GATE,
  freezeResourceFrontier,
  gateForEnvironmentFailurePhase,
  isEnvironmentFailurePhase,
  resourceIdentityHash,
  safeActions,
} from "@erl2/core";

const RUN = "019f1af9-0000-7000-8000-000000000001";
const OTHER_RUN = "019f1af9-0000-7000-8000-0000000000ff";
const AT = "2026-07-29T00:00:00Z";

/** A resource that is genuinely this run's: named for it and hashed from that name. */
function owned(
  kind: string,
  overrides: Partial<EnvironmentResourceV1> = {},
): EnvironmentResourceV1 {
  const runScopedName = `erl2-${kind}-${RUN}`;
  return {
    resource_id: `${kind}-owned`,
    kind,
    run_scoped_name: runScopedName,
    identity_hash: resourceIdentityHash(RUN, kind, runScopedName),
    destroyable: true,
    ...overrides,
  };
}

/**
 * A resource belonging to another run.
 *
 * Internally consistent — named and hashed for `OTHER_RUN` — and therefore
 * provably not ours. This is the distinction ADR-ERL2-027 §1.5 records: a
 * `shared_with_other_runs` resource still embeds *this* run's id, so
 * `assertOwnedByRun` passes for it, and every case that used sharing to stand in
 * for foreignness was testing a different property.
 */
function foreign(kind: string): EnvironmentResourceV1 {
  const runScopedName = `erl2-${kind}-${OTHER_RUN}`;
  return {
    resource_id: `${kind}-foreign`,
    kind,
    run_scoped_name: runScopedName,
    identity_hash: resourceIdentityHash(OTHER_RUN, kind, runScopedName),
    destroyable: true,
  };
}

function frontierOf(resources: readonly EnvironmentResourceV1[]) {
  return freezeResourceFrontier({
    runId: RUN,
    environmentInstanceHash: domainHash(HASH_DOMAINS.TREE, { fixture: "instance" }),
    driverManifestHash: domainHash(HASH_DOMAINS.TREE, { fixture: "manifest" }),
    trigger: "invalid_environment_failure",
    observedResources: resources,
    frozenAt: AT,
  });
}

/** action_id -> whether the derivation calls it independently safe. */
function safety(resources: readonly EnvironmentResourceV1[]): Map<string, boolean> {
  return new Map(
    frontierOf(resources).derived_actions.map((a) => [a.target_resource_id, a.independently_safe]),
  );
}

// -- 1. frontier derivation --------------------------------------------------

test("FRONTIER-DERIVE: an empty frontier derives no action and authorizes nothing", () => {
  const frontier = frontierOf([]);
  assert.equal(frontier.derived_actions.length, 0);
  assert.equal(safeActions(frontier).length, 0);
  assertFrontierActionsDerivable(frontier);
});

test("FRONTIER-DERIVE: one owned destroyable resource derives one safe action", () => {
  const frontier = frontierOf([owned("container")]);
  assert.equal(frontier.derived_actions.length, 1);
  assert.equal(safeActions(frontier).length, 1);
  assert.equal(frontier.derived_actions[0]?.kind, "destroy_partial_resource");
  assert.equal(frontier.derived_actions[0]?.independently_safe, true);
  // A safe action carries no unsafe reason: the schema's conditional refuses one.
  assert.equal(frontier.derived_actions[0]?.unsafe_reason_code, undefined);
});

test("FRONTIER-DERIVE: many owned resources all derive safe actions, one each", () => {
  const resources = ["project", "network", "volume", "container", "port"].map((k) => owned(k));
  const frontier = frontierOf(resources);
  assert.equal(frontier.derived_actions.length, resources.length);
  assert.equal(safeActions(frontier).length, resources.length);
  assert.equal(
    new Set(frontier.derived_actions.map((a) => a.action_id)).size,
    resources.length,
    "every action id is distinct, so no two resources share an accounting slot",
  );
});

test("FRONTIER-DERIVE: the attempt order is deterministic and dependency-shaped", () => {
  const resources = ["port", "project", "container", "network", "volume"].map((k) => owned(k));
  const kinds = frontierOf(resources).derived_actions.map((a) => a.kind);
  // A workload before the network it sits on, and the whole project last: the
  // order is the frontier's, not the observation's.
  assert.deepEqual(kinds, [
    "isolate_network",
    "destroy_partial_resource",
    "destroy_partial_resource",
    "destroy_partial_resource",
    "teardown_remaining",
  ]);
  // Reversing the observation does not reorder the actions.
  assert.deepEqual(frontierOf([...resources].reverse()).derived_actions.map((a) => a.kind), kinds);
});

test("FRONTIER-DERIVE: a shared resource is contained, with a reason and no action", () => {
  const frontier = frontierOf([owned("volume", { shared_with_other_runs: true })]);
  const action = frontier.derived_actions[0];
  assert.equal(action?.independently_safe, false);
  assert.equal(action?.kind, "contain_residual");
  assert.equal(action?.unsafe_reason_code, "RESOURCE_SHARED_WITH_ANOTHER_RUN");
  assert.equal(safeActions(frontier).length, 0);
});

test("FRONTIER-DERIVE: a foreign resource is contained as not provably ours", () => {
  const frontier = frontierOf([foreign("volume")]);
  const action = frontier.derived_actions[0];
  assert.equal(action?.independently_safe, false);
  assert.equal(action?.unsafe_reason_code, "RESOURCE_NOT_PROVABLY_OWNED_BY_RUN");
});

test("FRONTIER-DERIVE: a foreign resource makes no owned resource unsafe", () => {
  // The property P1-5 is about, stated as a derivation rather than as a
  // behaviour: one foreign member must not contaminate the classification of
  // anything else in the frontier.
  const mixed = safety([owned("container"), foreign("volume"), owned("network")]);
  assert.equal(mixed.get("container-owned"), true);
  assert.equal(mixed.get("network-owned"), true);
  assert.equal(mixed.get("volume-foreign"), false);
  const alone = safety([owned("container"), owned("network")]);
  assert.equal(alone.get("container-owned"), true);
  assert.equal(alone.get("network-owned"), true);
});

test("FRONTIER-DERIVE: a resource whose identity does not derive from its name is not ours", () => {
  // Unknown ownership: the name says this run, the hash says something else.
  // `assertOwnedByRun` checks both, so a resource cannot be smuggled in under a
  // borrowed name.
  const tampered = owned("container", {
    identity_hash: domainHash(HASH_DOMAINS.TREE, { fixture: "not-derived" }) as Hash,
  });
  assert.equal(safety([tampered]).get("container-owned"), false);
});

test("FRONTIER-DERIVE: a resource the driver will not destroy is contained, not attempted", () => {
  const frontier = frontierOf([owned("volume", { destroyable: false })]);
  assert.equal(frontier.derived_actions[0]?.unsafe_reason_code, "RESOURCE_NOT_INDEPENDENTLY_DESTROYABLE");
  assert.equal(safeActions(frontier).length, 0);
});

test("FRONTIER-DERIVE: an edited action set no longer derives from its own resources", () => {
  const frontier = frontierOf([owned("container"), foreign("volume")]);
  assertFrontierActionsDerivable(frontier);
  // Relabel the foreign member safe, keeping the frontier internally consistent
  // by recomputing nothing: the hash check fires first, which is itself the
  // point — a frontier cannot be edited while keeping its original hash.
  const relabelled = {
    ...frontier,
    derived_actions: frontier.derived_actions.map((a) =>
      a.target_resource_id === "volume-foreign" ? { ...a, independently_safe: true } : a,
    ),
  };
  assert.throws(
    () => assertFrontierActionsDerivable(relabelled as typeof frontier),
    (error: unknown) =>
      ["ARTIFACT_HASH_MISMATCH", "EMERGENCY_ACTION_SAFE_ACTION_SKIPPED"].includes(
        (error as { code?: string }).code ?? "",
      ),
  );
});

// -- 2. residue probe --------------------------------------------------------

const R = (id: string): { resourceId: string; identityHash: Hash } => ({
  resourceId: id,
  identityHash: domainHash(HASH_DOMAINS.TREE, { fixture: id }),
});

test("RESIDUE-PROBE: everything authorized and gone is clean", () => {
  const verdict = deriveResidueProbeOutcome({
    observedBefore: [R("a"), R("b")],
    observedAfter: [],
    authorizedTargets: ["a", "b"],
    probeStatus: "observed",
  });
  assert.equal(verdict.outcome, "clean");
  assert.deepEqual(verdict.residual, []);
  assert.deepEqual(verdict.undeclaredDestroyed, []);
});

test("RESIDUE-PROBE: an unauthorized survivor is residue, not a failure of authorization", () => {
  const verdict = deriveResidueProbeOutcome({
    observedBefore: [R("a"), R("shared")],
    observedAfter: [R("shared")],
    authorizedTargets: ["a"],
    probeStatus: "observed",
  });
  assert.equal(verdict.outcome, "residual");
  assert.deepEqual(verdict.residual, ["shared"]);
  assert.deepEqual(verdict.undeclaredDestroyed, []);
});

test("RESIDUE-PROBE: a resource that vanished without authorization is the integrity failure", () => {
  // This is the case that did not exist before ADR-ERL2-027, and the one a
  // post-cleanup inventory alone can never see: `shared` is absent afterwards
  // and was never an authorized target.
  const verdict = deriveResidueProbeOutcome({
    observedBefore: [R("a"), R("shared")],
    observedAfter: [],
    authorizedTargets: ["a"],
    probeStatus: "observed",
  });
  assert.equal(verdict.outcome, "undeclared_destruction");
  assert.deepEqual(verdict.undeclaredDestroyed, ["shared"]);
});

test("RESIDUE-PROBE: an unauthorized destruction outranks leftover residue", () => {
  const verdict = deriveResidueProbeOutcome({
    observedBefore: [R("a"), R("shared"), R("stuck")],
    observedAfter: [R("stuck")],
    authorizedTargets: ["a", "stuck"],
    probeStatus: "observed",
  });
  assert.equal(verdict.outcome, "undeclared_destruction");
  assert.deepEqual(verdict.undeclaredDestroyed, ["shared"]);
  assert.deepEqual(verdict.residual, ["stuck"], "residue is still reported, not swallowed");
});

test("RESIDUE-PROBE: an unobservable substrate is a refusal, never a clean sheet", () => {
  const verdict = deriveResidueProbeOutcome({
    observedBefore: [R("a")],
    observedAfter: [],
    authorizedTargets: ["a"],
    probeStatus: "unavailable",
  });
  assert.equal(verdict.outcome, "unobservable");
});

test("RESIDUE-PROBE: an empty frontier that probes back empty is clean and still says so", () => {
  const probe = buildResidueProbe({
    runId: RUN,
    substrateBindingHash: domainHash(HASH_DOMAINS.TREE, { fixture: "binding" }),
    environmentInstanceHash: domainHash(HASH_DOMAINS.TREE, { fixture: "instance" }),
    resourceFrontierHash: frontierOf([]).core_hash,
    observedBefore: [],
    observedAfter: [],
    authorizedTargets: [],
    probeStatus: "observed",
    probedAt: AT,
  });
  assert.equal(probe.outcome, "clean");
  assert.deepEqual(probe.observed_after, []);
});

test("RESIDUE-PROBE: the frozen bytes do not depend on the driver's iteration order", () => {
  const build = (order: readonly string[]) =>
    buildResidueProbe({
      runId: RUN,
      substrateBindingHash: domainHash(HASH_DOMAINS.TREE, { fixture: "binding" }),
      environmentInstanceHash: domainHash(HASH_DOMAINS.TREE, { fixture: "instance" }),
      resourceFrontierHash: frontierOf([]).core_hash,
      observedBefore: order.map(R),
      observedAfter: order.map(R),
      authorizedTargets: [...order].reverse(),
      probeStatus: "observed",
      probedAt: AT,
    }).core_hash;
  assert.equal(build(["a", "b", "c"]), build(["c", "a", "b"]));
});

// -- 3. the phase -> gate map ------------------------------------------------

test("PHASE-GATE: every environment failure phase maps to exactly one distinct gate", () => {
  const gates = Object.values(ENVIRONMENT_PHASE_GATE);
  assert.equal(
    new Set(gates).size,
    gates.length,
    "two phases sharing a gate would make a finding ambiguous about what failed",
  );
  for (const phase of Object.keys(ENVIRONMENT_PHASE_GATE)) {
    assert.equal(gateForEnvironmentFailurePhase(phase), ENVIRONMENT_PHASE_GATE[phase as never]);
    assert.equal(isEnvironmentFailurePhase(phase), true);
  }
});

test("PHASE-GATE: a teardown failure does not name the restoration gate", () => {
  // The defect verbatim: the map used to be keyed on the cleanup branch, so both
  // emergency phases named `restoration-verified` — and for a teardown failure
  // that gate had already passed (ADR-ERL2-027 §1.4).
  assert.equal(gateForEnvironmentFailurePhase("teardown"), "teardown-verified");
  assert.notEqual(
    gateForEnvironmentFailurePhase("teardown"),
    gateForEnvironmentFailurePhase("environment_restoration"),
  );
});

test("PHASE-GATE: a provisioning failure does not name a baseline gate it never evaluated", () => {
  // The other half of the same defect: every non-emergency phase named
  // `environment-baseline-clean`, including provisioning, which fails before a
  // baseline is ever measured.
  assert.notEqual(gateForEnvironmentFailurePhase("provisioning"), "environment-baseline-clean");
  assert.equal(gateForEnvironmentFailurePhase("baseline"), "environment-baseline-clean");
});

test("PHASE-GATE: an unmapped phase is refused rather than defaulted", () => {
  // A default would reintroduce the defect one phase at a time as the union
  // grows, silently, which is exactly how the branch-keyed version survived.
  assert.equal(isEnvironmentFailurePhase("emergency_cleanup"), false);
  for (const phase of ["emergency_cleanup", "acquisition"]) {
    assert.throws(
      () => gateForEnvironmentFailurePhase(phase),
      (error: unknown) => (error as { code?: string }).code === "INVALID_REASON_PHASE_MISMATCH",
    );
  }
});
