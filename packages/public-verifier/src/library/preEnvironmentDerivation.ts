/**
 * The semantic derivation the pre-environment verifier owns (RL-D-028).
 *
 * ## What was wrong
 *
 * The environment branch stopped believing its producer some time ago:
 * `deriveValidityOutcome` recomputes `status` from `gate_results` and refuses a
 * result that disagrees with its own gates. The pre-environment branch never
 * did. It read the signed constant `attestation.lab_validity`, found it equal to
 * `"valid"`, and never opened the retained `pre-environment-validity-result/v1`
 * at all -- so on the branch the README quick-start actually runs, the gates that
 * decide whether a run was valid were evidence nobody checked.
 *
 * A producer holding the finalizer key could therefore sign a bundle whose own
 * retained result said the run failed, and the offline verifier reported
 * `valid`. That is the threat model this closes: holding the key must not be the
 * same thing as being believed. The producer-side invariant was weak in the same
 * way -- `assertValidityAdmitsGenericIndex` checks `status` and never recomputes
 * it -- so nothing upstream caught it either.
 *
 * ## What this module does and does not claim
 *
 * It re-derives the **verdict**, not the gates. Several gates read evidence a
 * public reader does not hold, so the verifier cannot re-run them; what it can
 * require is that the retained gate set be self-consistent, that the declared
 * status be the one those gates produce, and that the retained findings
 * corroborate every failure. That boundary is stated rather than blurred, and it
 * is exactly the boundary the environment path already draws.
 *
 * The status arithmetic is the same *definition* the producer uses -- gates all
 * pass or the run is invalid -- and definitions may be shared. The **verdict**
 * is computed here, from bytes this verifier holds, and no producer function is
 * called to reach it. A focused pre-environment derivation rather than a
 * generalised one is deliberate: the environment result carries exercise and
 * telemetry obligations a pre-environment result has no member for, and folding
 * both into one function would mean one branch's obligations silently governing
 * the other.
 */

import {
  assertContract,
  CODES,
  Erl2Error,
  type Hash,
  type PreEnvironmentValidityResultV1,
} from "@erl2/contracts";
import type { ArtifactIndex } from "./artifactIndex.js";

/** The two fields this module reads off a retained gate row. */
interface GateLike {
  readonly gate_id: string;
  readonly passed: boolean;
}

/**
 * The status definition, applied to bytes the verifier holds.
 *
 * Total, and deliberately trivial: a run is valid exactly when every gate it
 * recorded passed. Duplicated here rather than imported from the producer's
 * `@erl2/core` evaluation module, which does not export it, and which is the
 * side whose answer this function exists not to trust.
 */
function statusOf(gates: readonly GateLike[]): "valid" | "invalid" {
  return gates.every((g) => g.passed) ? "valid" : "invalid";
}

export interface PreEnvironmentValidityDerivation {
  readonly status: "valid" | "invalid";
  readonly failedGateIds: readonly string[];
}

/**
 * Re-derives the pre-environment validity verdict from the retained result the
 * closure already bound, and refuses every way it can contradict itself.
 *
 * Must run **after** hash, graph, contract and signature validation -- so a
 * doctored or unsigned bundle keeps its own, more fundamental cause -- and
 * **before** claim derivation, so no claim is ever computed over a run whose
 * validity has not been re-derived.
 */
export function derivePreEnvironmentValidity(options: {
  readonly index: ArtifactIndex;
  /**
   * `run_record.validity_result_hash`, already bound by the derived closure.
   *
   * Typed optional because the closure's role lookup is: a terminal that closed
   * without a validity result would have been refused as a missing role long
   * before this, and refusing explicitly is cheaper than asserting it away.
   */
  readonly validityResultHash: Hash | undefined;
  /** True when the caller is verifying a bundle presented as a valid terminal. */
  readonly requireValid: boolean;
}): PreEnvironmentValidityDerivation {
  if (options.validityResultHash === undefined) {
    throw new Erl2Error(
      CODES.GRAPH_CLOSURE_MISSING_ROLE,
      "the derived closure carries no validity result to re-derive this run's verdict from",
    );
  }

  // Resolved through the closure-bound reference, never by scanning for
  // something of the right shape: `ofSchema` is a lossy by-core-hash view, and
  // picking a validity result out of it would let a second one steer the answer.
  const validity = options.index.typed<PreEnvironmentValidityResultV1>(
    options.validityResultHash,
    "pre-environment-validity-result/v1",
  );
  assertContract("PreEnvironmentValidityResultV1", validity);

  const gates = validity.gate_results as readonly GateLike[];

  // A gate evaluated twice is not a gate: one row would have to lose, and which
  // one lost would be decided by array order the producer chose.
  const seen = new Set<string>();
  for (const gate of gates) {
    if (seen.has(gate.gate_id)) {
      throw new Erl2Error(
        CODES.EVALUATOR_VALIDITY_GATE_FAILED,
        `the retained validity result evaluates gate ${gate.gate_id} more than once`,
      );
    }
    seen.add(gate.gate_id);
  }

  const failed = gates.filter((g) => !g.passed).map((g) => g.gate_id);
  const derived = statusOf(gates);

  if (derived !== validity.status) {
    throw new Erl2Error(
      CODES.EVALUATOR_VALIDITY_GATE_FAILED,
      `the retained validity result declares status ${validity.status}, but ${String(failed.length)} ` +
        `of its own gates failed (${failed.join(", ") || "none"}); the verifier derives ${derived}`,
    );
  }

  // Every failed gate must be named by a retained invalidity finding, and a
  // result with nothing to explain may not cite one. Both directions, because
  // an unexplained failure and a fabricated invalidity are the same defect seen
  // from either end.
  const namedGates = new Set<string>();
  for (const hash of validity.invalidity_finding_hashes) {
    const finding = options.index.get(hash);
    for (const gate of (finding.value["failed_gate_ids"] as string[] | undefined) ?? []) {
      namedGates.add(gate);
    }
  }
  for (const gate of failed) {
    if (!namedGates.has(gate)) {
      throw new Erl2Error(
        CODES.EVALUATOR_VALIDITY_GATE_FAILED,
        `validity gate ${gate} failed but no retained invalidity finding names it`,
      );
    }
  }
  if (derived === "valid" && validity.invalidity_finding_hashes.length > 0) {
    throw new Erl2Error(
      CODES.EVALUATOR_VALIDITY_GATE_FAILED,
      "a valid validity result cites invalidity findings; every gate passed",
    );
  }

  if (options.requireValid && derived !== "valid") {
    throw new Erl2Error(
      CODES.BUNDLE_VARIANT_MISMATCH,
      `a public bundle cannot carry an invalid verdict; the retained validity result derives ` +
        `${derived} (failed gates: ${failed.join(", ")})`,
    );
  }

  return { status: derived, failedGateIds: failed };
}
