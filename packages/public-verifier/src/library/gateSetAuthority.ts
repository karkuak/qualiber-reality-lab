/**
 * The required validity gate set, decided by the verifier rather than supplied
 * by the producer (RL-D-031).
 *
 * ## What was wrong
 *
 * RL-D-028 stopped the verifier trusting the producer's *verdict*: both terminal
 * branches now recompute `status` from `gate_results` and refuse a result that
 * disagrees with its own gates. What neither branch checked is whether those
 * gates are the gates the run owed.
 *
 * `statusOf` is `gates.every((g) => g.passed)`, and `every` over an empty array
 * is `true`. So a producer holding the finalizer key could delete the one row
 * that failed, narrow the array to a single passing gate, supply no gates at
 * all, or substitute identifiers the Lab does not own — and the offline verifier
 * derived `valid` from each, with the bundle cryptographically impeccable in
 * every other respect. Re-deriving a verdict from an attacker-chosen set of
 * inputs is not an independent derivation; it is the producer's answer reached
 * by a longer route.
 *
 * ## Where the authority comes from
 *
 * Two sources, both outside the compromised finalizer's control:
 *
 *   1. **The Lab gate catalogue**, which is not producer data at all. It ships
 *      inside the verifier as a frozen compile-time constant, exactly like the
 *      `statusOf` definition the pre-environment derivation already re-states
 *      verifier-side. No retained byte can redefine it, because nothing reads a
 *      retained byte to build it.
 *
 *   2. **`acquisition-preregistration/v1`**, for the one bit of applicability the
 *      required set depends on. It is signed by the **preregistrar** — a key
 *      distinct from the finalizer in the pinned trust policy — frozen before
 *      the run under ADR-ERL2-036, a mandatory closure role on both branches,
 *      and bound to this run by the signed run-record chain and by the
 *      signer-inventory foreign-run refusal. A producer that could re-sign it
 *      would already hold the preregistrar key, and holding *that* key is a
 *      different compromise than the one this module defends against.
 *
 * Deliberately **not** used: the retained validity result's own fields (that is
 * the array under attack), the attestation (the finalizer signs both sides of
 * it), and `generic_run_policy_hash` (RL-D-030 — it binds no retained artifact
 * and carries no authority today; see the decision record).
 *
 * ## What completeness does and does not claim
 *
 * It claims the **retained set** is complete and internally consistent: every
 * gate the branch owes is present exactly once, nothing outside the Lab
 * catalogue is scored, nothing outside *this branch's* catalogue is scored, and
 * applicability is enforced rather than assumed. It does **not** claim any gate
 * was independently re-executed — several read evidence a public reader does not
 * hold, and that boundary is the one the pre-environment derivation already
 * draws and this module does not move.
 *
 * ## Order
 *
 * A gate set is a **set**. The catalogue's array order is a reading order for
 * humans, not a semantic commitment: nothing in the producer or the verifier has
 * ever derived anything from the position of a row, and `statusOf` is
 * order-free. So membership is compared through sets and a re-ordered honest set
 * is accepted — stated here rather than left implicit, because "we happened not
 * to check" and "order is irrelevant" are different claims.
 */

import { CODES, Erl2Error, type SubjectExecutionMode } from "@erl2/contracts";
import { ENVIRONMENT_GATE_IDS, LAB_VALIDITY_GATES, PRE_ENVIRONMENT_GATE_IDS } from "@erl2/core";

/**
 * The catalogue, flattened once.
 *
 * Imported rather than re-typed: a catalogue is a *definition*, and this
 * repository already shares definitions with the producer while sharing no
 * verdicts (`exerciseApplicable`, `decideTrustedTelemetryAuthority`). A second
 * hand-maintained copy would drift, and a drifted copy fails open — it would
 * stop requiring a gate the Lab had added. The import is a build-time constant;
 * no producer runtime input reaches it.
 */
const ALL_LAB_GATE_IDS: ReadonlySet<string> = new Set(
  Object.values(LAB_VALIDITY_GATES).flat() as readonly string[],
);

/** Which catalogue a terminal branch is answerable to. */
const BRANCH_CATALOGUE: Readonly<Record<TerminalBranch, readonly string[]>> = {
  pre_environment: PRE_ENVIRONMENT_GATE_IDS,
  environment: ENVIRONMENT_GATE_IDS,
};

export type TerminalBranch = "pre_environment" | "environment";

/**
 * Gates whose *presence* is decided by an applicability rule rather than by
 * branch membership alone.
 *
 * They are excluded from the completeness set here and required — or refused —
 * by the rule that owns each:
 *
 *   - `adapter-certified` — decided by the signed `subject_execution_mode`, and
 *     enforced below, because this module is the only place the signed mode is
 *     read;
 *   - `subject-exercise-succeeded` and `attributable-telemetry-retained` —
 *     decided by ADR-ERL2-039/038 applicability, which `deriveValidityOutcome`
 *     already recomputes from retained step outcomes and which
 *     `deriveAttributableTelemetry` already recomputes from the retained driver
 *     manifest and archetype. Requiring them again here would put two guards on
 *     one property, and this repository has already measured what that costs:
 *     disabling either leaves the other refusing, so both score zero and neither
 *     is proven load-bearing.
 */
const APPLICABILITY_GOVERNED: ReadonlySet<string> = new Set([
  "adapter-certified",
  "subject-exercise-succeeded",
  "attributable-telemetry-retained",
]);

/** The one field this module reads off a retained gate row. */
export interface GateIdentity {
  readonly gate_id: string;
}

/**
 * The set a terminal on this branch owes, given the signed execution mode.
 *
 * A pure function of the verifier's own catalogue and one preregistrar-signed
 * enum. Nothing the finalizer writes appears in it.
 */
export function verifierRequiredGateIds(
  branch: TerminalBranch,
  subjectExecutionMode: SubjectExecutionMode,
): readonly string[] {
  const catalogue = BRANCH_CATALOGUE[branch];
  const core = catalogue.filter((id) => !APPLICABILITY_GOVERNED.has(id));
  return subjectExecutionMode === "external_adapter" ? [...core, "adapter-certified"] : core;
}

/**
 * Refuses every way a retained gate set can fail to be the set the run owed.
 *
 * Ordered most-fundamental-first, so a refusal names the worst thing true of the
 * set rather than the first thing checked: an identifier the Lab does not own is
 * a worse defect than one belonging to the other branch, which is worse than a
 * row evaluated twice, which is worse than a row simply absent.
 *
 * Runs **before** the status arithmetic in both callers. A verdict derived from
 * a set that is not the run's set is not a verdict about the run, and computing
 * one first would mean reporting a derived status the reader could not use.
 */
export function assertRetainedGateSetComplete(options: {
  readonly gates: readonly GateIdentity[];
  readonly branch: TerminalBranch;
  /** Read by the caller from the closure-bound, preregistrar-signed preregistration. */
  readonly subjectExecutionMode: SubjectExecutionMode;
}): void {
  const { gates, branch } = options;
  const catalogue = new Set(BRANCH_CATALOGUE[branch]);

  // 1. Every retained identifier must be a gate this branch owes an answer
  //    about. This is the executable statement of "validity may inspect only
  //    Lab-owned integrity and experimental-control evidence", and of the branch
  //    catalogues' own rule that a terminal may not score a control it never
  //    exercised: a gate named `subject-claims-correct` has no catalogue entry,
  //    and `environment-baseline-clean` on a pre-environment terminal is a
  //    control that was never reached.
  //
  //    One check rather than two, and the difference was measured rather than
  //    reasoned about. Splitting "not a Lab gate at all" from "a Lab gate of the
  //    other branch" left the first one **unmeasurable**: every identifier the
  //    Lab does not own is also outside the branch catalogue, so disabling the
  //    Lab-ownership check changed nothing a test could see -- the branch check
  //    answered for every case, with the same refusal code. A mutant that
  //    survives is a guard nothing measures. So the property is stated once, and
  //    `ALL_LAB_GATE_IDS` is kept only to tell the reader *which* kind of
  //    mistake they made. It classifies the message; it does not decide the
  //    refusal.
  const offBranch = gates.filter((g) => !catalogue.has(g.gate_id));
  if (offBranch.length > 0) {
    const unowned = offBranch.filter((g) => !ALL_LAB_GATE_IDS.has(g.gate_id)).map((g) => g.gate_id);
    const otherBranch = offBranch.filter((g) => ALL_LAB_GATE_IDS.has(g.gate_id)).map((g) => g.gate_id);
    const said: string[] = [];
    if (unowned.length > 0) said.push(`gate(s) the Lab does not own: ${unowned.join(", ")}`);
    if (otherBranch.length > 0) {
      said.push(
        `Lab gate(s) outside this ${branch === "pre_environment" ? "pre-environment" : "environment"} ` +
          `terminal's catalogue: ${otherBranch.join(", ")}`,
      );
    }
    throw new Erl2Error(
      CODES.EVALUATOR_VALIDITY_GATE_NOT_LAB_OWNED,
      `the retained validity result evaluates ${said.join("; and ")}`,
    );
  }

  // 2. A gate evaluated twice is not a gate: one row would have to lose, and
  //    which one lost would be decided by array order the producer chose.
  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const gate of gates) {
    if (seen.has(gate.gate_id)) duplicated.add(gate.gate_id);
    seen.add(gate.gate_id);
  }
  if (duplicated.size > 0) {
    throw new Erl2Error(
      CODES.EVALUATOR_VALIDITY_GATE_FAILED,
      `the retained validity result evaluates gate(s) more than once: ${[...duplicated].join(", ")}`,
    );
  }

  // 3. The completeness check itself, and the whole point of the module: an
  //    omitted gate is not a pass, and deleting the row that failed must not be
  //    cheaper than retaining it.
  const missing = verifierRequiredGateIds(branch, options.subjectExecutionMode).filter(
    (id) => !seen.has(id),
  );
  if (missing.length > 0) {
    throw new Erl2Error(
      CODES.GRAPH_CLOSURE_MISSING_ROLE,
      `the retained validity result omits required gate(s): ${missing.join(", ")}; a gate the run ` +
        `owed and did not evaluate is not a gate it passed`,
    );
  }

  // 4. The other direction of the one applicability rule this module owns. A run
  //    that selected no external adapter executes no adapter bytes, so there is
  //    nothing to certify — and `passed: true` over that is a boolean answering
  //    a question about applicability, which is the shape ADR-ERL2-036 rejected.
  if (options.subjectExecutionMode !== "external_adapter" && seen.has("adapter-certified")) {
    throw new Erl2Error(
      CODES.EVALUATOR_VALIDITY_GATE_NOT_LAB_OWNED,
      "this run's signed preregistration selected no external adapter, and its retained validity " +
        "result publishes adapter-certified; certification is not applicable, and a boolean cannot say so",
    );
  }
}
