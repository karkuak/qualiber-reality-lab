/**
 * `--claim-scope` was an operator's authority to say anything (review P2,
 * ADR-ERL2-025).
 *
 * ## The defect
 *
 * ```ts
 * const claimScope = flags["claim-scope"] ?? "T1";      // the producer
 * if (!["T1","T2","T3"].includes(attestation.claim_scope)) { … }   // the verifier
 * ```
 *
 * So `erl2 finalize-generic --claim-scope T3` produced a signed, offline-valid
 * attestation asserting **historical-reproduction evidence** over a run that is
 * development tier, against the fake driver, with a trusted reference subject,
 * non-blind selection, and `DomainResultNotApplicableV1` — a run that measured
 * no domain outcome at all. Every other verdict in the system is derived; this
 * one was typed at a command line.
 *
 * ## The two halves
 *
 * The producer half is driven through the shipped binary, because that is where
 * the flag was. The verifier half has to mutate a **signed** attestation, so the
 * last test re-signs it with the development finalizer key, repairs the lifecycle
 * chain and the bundle member, and then runs the shipped `erl2 verify` in a fresh
 * process — the mutation has to reach the semantic ceiling rule rather than
 * tripping a content-hash or signature check first, which is the discipline
 * ADR-ERL2-024 §7.3 requires and which this file asserts explicitly by first
 * proving the *repaired* bundle still verifies at T1.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { chmodSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  ArtifactIndex,
  assertClaimScopeWithinCeiling,
  claimScopeExceeds,
  combineClaimScopeComponents,
  deriveClaimCeiling,
  type ClaimScopeComponent,
} from "@erl2/public-verifier";
import { coreHash, developmentKey, sealSigned } from "@erl2/integrity";
import type { ClaimScope, LabLifecycleEventV1 } from "@erl2/contracts";
import { erl2, runToValidTerminal, verifyBundle, writeLifecycle } from "../support/cliRun.js";
import {
  drive,
  environmentPlan,
  phaseIndex,
  producedRoles,
  selectedRun,
  type EnvironmentRun,
} from "../support/environmentCli.js";

function refusalCode(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

function lifecycle(runRoot: string): readonly LabLifecycleEventV1[] {
  return JSON.parse(readFileSync(writeLifecycle(runRoot), "utf8")) as LabLifecycleEventV1[];
}

/** Drives the environment plan up to `finalize-generic`, which is left to the caller. */
function environmentToFinalize(): EnvironmentRun {
  const run = selectedRun();
  drive(run, phaseIndex(run, "finalize-generic"));
  return run;
}

function finalizeArgv(run: EnvironmentRun): readonly string[] {
  return (environmentPlan(run)[phaseIndex(run, "finalize-generic")] as readonly [string, readonly string[]])[1];
}

// -- 1. the producer ---------------------------------------------------------

test("CLAIM-SCOPE: with no flag, an environment run derives T1 from its own evidence", () => {
  const run = environmentToFinalize();
  const result = erl2(finalizeArgv(run));
  assert.equal(result.exitCode, 0, JSON.stringify(result.body.errors));
  assert.equal((result.body.data as Record<string, unknown>)["claim_scope"], "T1");
});

test("CLAIM-SCOPE: T2 and T3 are typed refusals naming what holds the ceiling down", () => {
  const run = environmentToFinalize();
  for (const requested of ["T2", "T3"]) {
    const result = erl2([...finalizeArgv(run), "--claim-scope", requested]);
    assert.notEqual(result.exitCode, 0, `--claim-scope ${requested} must be refused`);
    const error = result.body.errors[0];
    assert.equal(
      error?.code,
      "POLICY_CLAIM_SCOPE_EXCEEDS_EVIDENCE",
      JSON.stringify(result.body.errors),
    );
    // The refusal has to say *why*, or an operator learns nothing from it.
    assert.match(error?.message ?? "", /supports at most T1/);
    assert.match(error?.message ?? "", /fake driver|development|not evaluated|non-blind/);
  }
  // And nothing was signed on the way out.
  const roles = new Set(producedRoles(run));
  assert.ok(!roles.has("final-attestation"), "a refused scope must not emit an attestation");
  assert.ok(!roles.has("run-record"), "a refused scope must not emit a terminal record");
});

test("CLAIM-SCOPE: T1 is accepted, and an out-of-range or T4 request is a typed refusal", () => {
  const accepted = environmentToFinalize();
  const ok = erl2([...finalizeArgv(accepted), "--claim-scope", "T1"]);
  assert.equal(ok.exitCode, 0, JSON.stringify(ok.body.errors));
  assert.equal((ok.body.data as Record<string, unknown>)["claim_scope"], "T1");

  const refused = environmentToFinalize();
  for (const value of ["T4", "t1", "", "T1 "]) {
    const result = erl2([...finalizeArgv(refused), "--claim-scope", value]);
    assert.notEqual(result.exitCode, 0, `--claim-scope ${JSON.stringify(value)} must be refused`);
    assert.equal(
      result.body.errors[0]?.code,
      "CFG_MISSING_REQUIRED",
      JSON.stringify(result.body.errors),
    );
  }
});

test("CLAIM-SCOPE: the pre-environment terminal cannot be operator-upgraded either", () => {
  // A pre-environment terminal provisioned no environment at all, so there is
  // nothing on which a robustness or regression claim could rest — and its
  // ceiling is T1 for that reason before any of the others are consulted.
  const run = runToValidTerminal();
  const index = ArtifactIndex.scan(run.runRoot);
  const report = deriveClaimCeiling({
    index,
    lifecycle: lifecycle(run.runRoot),
    terminalVariant: "pre_environment",
  });
  assert.equal(report.ceiling, "T1");
  assert.ok(
    report.binding.includes("terminal-variant"),
    `the variant itself must hold the ceiling; binding was ${report.binding.join(", ")}`,
  );
  for (const scope of ["T2", "T3"] as const) {
    assert.equal(
      refusalCode(() => assertClaimScopeWithinCeiling({ claimScope: scope, report, who: "t" })),
      "POLICY_CLAIM_SCOPE_EXCEEDS_EVIDENCE",
    );
  }
});

test("CLAIM-SCOPE: a direct library caller derives the same ceiling and cannot exceed it", () => {
  // The CLI is one caller. A caller that never goes through it reaches the same
  // derivation over the same retained bytes.
  const run = selectedRun();
  assert.equal(drive(run), "generic_finalized");
  const report = deriveClaimCeiling({
    index: ArtifactIndex.scan(run.runRoot),
    lifecycle: lifecycle(run.runRoot),
    terminalVariant: "environment",
    selectionAssurance: { mode: "non_blind_development", blindness_claim: "none" },
  });
  assert.equal(report.ceiling, "T1");
  assert.equal(
    refusalCode(() =>
      assertClaimScopeWithinCeiling({ claimScope: "T3", report, who: "a library caller" }),
    ),
    "POLICY_CLAIM_SCOPE_EXCEEDS_EVIDENCE",
  );
  // A lower or equal scope is never refused: under-claiming is honest.
  assert.equal(
    refusalCode(() =>
      assertClaimScopeWithinCeiling({ claimScope: "T1", report, who: "a library caller" }),
    ),
    undefined,
  );
});

test("CLAIM-SCOPE: every component that holds this run at T1 does so independently", () => {
  // The point of a minimum over components is that no single one of them is
  // load-bearing on its own. Each of these is a separate, checkable reason the
  // run cannot claim more, and the run's own retained evidence carries all of
  // them at once.
  const run = selectedRun();
  assert.equal(drive(run), "generic_finalized");
  const report = deriveClaimCeiling({
    index: ArtifactIndex.scan(run.runRoot),
    lifecycle: lifecycle(run.runRoot),
    terminalVariant: "environment",
    selectionAssurance: { mode: "non_blind_development", blindness_claim: "none" },
  });
  const byId = new Map(report.components.map((c) => [c.component_id, c]));
  for (const id of [
    "execution-tier",
    "selection-assurance",
    "environment-realism",
    "subject-containment",
    "domain-evaluation",
  ]) {
    const entry = byId.get(id);
    assert.ok(entry !== undefined, `${id} must be a derived component`);
    assert.equal(entry.applicable, true, `${id} must apply to an environment terminal`);
    assert.equal(entry.ceiling, "T1", `${id} must hold this run at T1: ${entry.observed}`);
  }
  // The fake driver is named for what it is, not inferred from a flag, and the
  // tier is the *selected* challenge's rather than "the" retained manifest's —
  // a run retains every admitted candidate, so counting them would reach T1 for
  // entirely the wrong reason.
  assert.match(byId.get("environment-realism")?.observed ?? "", /fake driver/);
  assert.match(byId.get("execution-tier")?.observed ?? "", /selected challenge .* tier development/);
  // And the one component that is *not* T1 still cannot lift the answer.
  assert.equal(byId.get("regression-evidence")?.ceiling, "T2");
  assert.equal(report.ceiling, "T1");
});

// -- 2. the combination rule -------------------------------------------------

test("CLAIM-SCOPE: the rule is a minimum, and no component can raise another", () => {
  const at = (id: string, ceiling: ClaimScope): ClaimScopeComponent => ({
    component_id: id,
    applicable: true,
    ceiling,
    observed: id,
  });
  const skipped = (id: string): ClaimScopeComponent => ({
    component_id: id,
    applicable: false,
    ceiling: "T3",
    observed: id,
  });

  assert.equal(combineClaimScopeComponents([at("a", "T3"), at("b", "T3")]).ceiling, "T3");
  assert.equal(combineClaimScopeComponents([at("a", "T3"), at("b", "T2")]).ceiling, "T2");
  // One T1 component holds the whole terminal at T1, whatever else is present.
  assert.equal(
    combineClaimScopeComponents([at("a", "T3"), at("b", "T3"), at("c", "T1")]).ceiling,
    "T1",
  );
  // Order is irrelevant: `min` is commutative, and a rule that depended on
  // component order would be a rule about the code rather than the evidence.
  assert.equal(
    combineClaimScopeComponents([at("c", "T1"), at("a", "T3"), at("b", "T3")]).ceiling,
    "T1",
  );
  // An inapplicable component is excluded rather than counted in either
  // direction: "there was no selection to be blind about" is not "the selection
  // was not blind".
  assert.equal(combineClaimScopeComponents([at("a", "T2"), skipped("b")]).ceiling, "T2");
  // But a minimum over *nothing* is the identity element — the strongest scope —
  // so an all-inapplicable set is refused rather than answered. Unreachable
  // through the real derivation, and refused anyway: "no evidence applies" must
  // never come back as "everything is permitted".
  assert.equal(
    refusalCode(() => combineClaimScopeComponents([skipped("a"), skipped("b")])),
    "POLICY_CLAIM_SCOPE_EXCEEDS_EVIDENCE",
  );
  assert.equal(refusalCode(() => combineClaimScopeComponents([])), "POLICY_CLAIM_SCOPE_EXCEEDS_EVIDENCE");
  // The binding set names every component actually holding the line.
  const report = combineClaimScopeComponents([at("a", "T1"), at("b", "T1"), at("c", "T3")]);
  assert.deepEqual([...report.binding].sort(), ["a", "b"]);

  assert.equal(claimScopeExceeds("T3", "T1"), true);
  assert.equal(claimScopeExceeds("T1", "T1"), false);
  assert.equal(claimScopeExceeds("T1", "T3"), false);
});

// -- 3. the verifier ---------------------------------------------------------

/**
 * Rewrites a frozen retained artifact in place, clearing the read-only bit
 * first: a tamperer would, and a test that only proves `chmod` works proves
 * nothing.
 */
function overwrite(file: string, value: unknown): void {
  chmodSync(file, 0o600);
  writeFileSync(file, JSON.stringify(value));
}

/** The event file that produced a given role, found by walking the run root. */
function eventFileProducing(runRoot: string, role: string): string {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const child = path.join(dir, name);
      if (statSync(child).isDirectory()) {
        walk(child);
        continue;
      }
      if (!name.endsWith(".json") || name.endsWith(".frozen")) continue;
      const value = JSON.parse(readFileSync(child, "utf8")) as {
        schema_version?: string;
        produced?: { artifact_role: string }[];
      };
      if (
        value.schema_version === "lab-lifecycle-event/v1" &&
        (value.produced ?? []).some((p) => p.artifact_role === role)
      ) {
        found.push(child);
      }
    }
  };
  walk(runRoot);
  assert.equal(found.length, 1, `expected exactly one event producing ${role}`);
  return found[0] as string;
}

test("CLAIM-SCOPE: the offline verifier rejects a self-consistent T3 bundle, for exceeding the ceiling", () => {
  const run = selectedRun();
  assert.equal(drive(run), "generic_finalized");

  // Baseline: the untouched bundle verifies. Everything after this is one
  // change, and if the repair below were incomplete this test would fail with a
  // hash or signature code instead — which is the outcome it exists to exclude.
  const before = verifyBundle(run.runRoot, {
    sourceTrustPolicyHash: run.registry.sourceTrustPolicyHash,
  });
  assert.equal(before.exitCode, 0, JSON.stringify(before.body.errors));

  const attestationPath = path.join(run.runRoot, "retained", "final-attestation.json");
  const attestation = JSON.parse(readFileSync(attestationPath, "utf8")) as Record<string, unknown>;
  assert.equal(attestation["claim_scope"], "T1");

  // 1. A fully self-consistent T3 attestation, re-signed by the finalizer key so
  //    the role-signature check passes and the semantic rule is what fires.
  const { core_hash: _drop, signature: _sig, ...body } = attestation as Record<string, unknown> & {
    core_hash: string;
    signature: unknown;
  };
  const forged = sealSigned({ ...body, claim_scope: "T3" }, developmentKey("finalizer"));
  overwrite(attestationPath, forged);

  // 2. The lifecycle event that produced it, re-hashed. The attestation is
  //    produced by the terminal event, so no later event's prior hash moves.
  const eventPath = eventFileProducing(run.runRoot, "final-attestation");
  const event = JSON.parse(readFileSync(eventPath, "utf8")) as Record<string, unknown> & {
    produced: { artifact_role: string; artifact_core_hash: string }[];
    sequence: number;
  };
  const maxSequence = Math.max(...lifecycle(run.runRoot).map((e) => e.sequence));
  assert.equal(event.sequence, maxSequence, "the attestation must be produced by the terminal event");
  const { core_hash: _eventHash, ...eventBody } = event;
  const repairedEvent = {
    ...eventBody,
    produced: event.produced.map((p) =>
      p.artifact_role === "final-attestation"
        ? { ...p, artifact_core_hash: forged.core_hash }
        : p,
    ),
  };
  overwrite(eventPath, { ...repairedEvent, core_hash: coreHash(repairedEvent) });

  // 3. The bundle member, with its byte descriptor and the bundle's own hash.
  const bundlePath = path.join(run.runRoot, "retained", "public-bundle.json");
  const bundle = JSON.parse(readFileSync(bundlePath, "utf8")) as Record<string, unknown> & {
    final_attestation: {
      artifact: Record<string, unknown>;
      artifact_core_hash: string;
    };
  };
  const forgedBytes = readFileSync(attestationPath);
  const { core_hash: _bundleHash, ...bundleBody } = bundle;
  const repairedBundle = {
    ...bundleBody,
    final_attestation: {
      artifact: {
        ...bundle.final_attestation.artifact,
        byte_length: forgedBytes.byteLength,
        file_sha256: `sha256:${createHash("sha256").update(forgedBytes).digest("hex")}`,
      },
      artifact_core_hash: forged.core_hash,
    },
  };
  overwrite(bundlePath, { ...repairedBundle, core_hash: coreHash(repairedBundle) });

  const verified = verifyBundle(run.runRoot, {
    sourceTrustPolicyHash: run.registry.sourceTrustPolicyHash,
  });
  assert.notEqual(verified.exitCode, 0, "a T3 attestation over a T1 run must not verify");
  assert.equal(
    verified.body.errors[0]?.code,
    "POLICY_CLAIM_SCOPE_EXCEEDS_EVIDENCE",
    `the refusal must be the ceiling rule, not an incidental check: ${JSON.stringify(
      verified.body.errors,
    )}`,
  );
});
