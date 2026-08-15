/**
 * The exercising step's outcome, as one shared definition (ADR-ERL2-039).
 *
 * ## Why this is a module and not two boolean expressions
 *
 * Three separate decisions read "did this run's exercising step succeed?":
 *
 *   1. whether the run must retain an ERL2-C-171 observation at all;
 *   2. whether the `attributable-telemetry-retained` gate is composed;
 *   3. whether the `subject-exercise-succeeded` gate passes.
 *
 * Package 3 answered (1) and (2) with two independently written expressions —
 * retention checked a driver capability and a declared metric source, the gate
 * checked a compose driver, a declared metric source *and* a succeeded exercise
 * — and the independent live-integration review measured what that cost: a run
 * whose exercise did not succeed **retained an ERL2-C-171 record that no gate
 * ever evaluated**, because the two predicates disagreed about exactly one
 * conjunct. Two expressions that are supposed to mean the same thing will
 * eventually stop meaning the same thing, and the failure is silent.
 *
 * So the conjunct lives here once, and every consumer imports it. The offline
 * verifier imports the same primitives: sharing a *pure applicability*
 * definition is sound on ADR-ERL2-024 §7.2's own terms, because its inputs are
 * retained step outcomes the Lab wrote, not bytes a subject controls. What the
 * verifier must never share is a *verdict*, and it shares none — it recomputes
 * validity, coherence and every count for itself.
 *
 * ## Why "an exercise outcome exists" is the applicability rule
 *
 * The gate's applicability must be two things at once, and they look like they
 * are in tension: **frozen** (so a run cannot become inapplicable by failing),
 * and **re-derivable from retained bytes** (so an offline reader can check it).
 *
 * The committed journey is the frozen fact — `ordered_step_commitment_hashes` is
 * fixed at `case_selected`, long before anything executes. But the step
 * commitments live in the admission registry, not in the retained bundle, so an
 * offline reader cannot see them.
 *
 * The two coincide, and one existing guard is why. `EnvironmentRun.freezeOutput`
 * refuses while any committed step is still owed:
 *
 *     the selected journey still has a committed <intent> step;
 *     subject output freezes only when every step is terminal
 *
 * A run therefore cannot reach an environment terminal at all unless **every**
 * committed step has produced an outcome. At the point these predicates are
 * read, "the committed journey required an exercise" and "a retained exercise
 * outcome exists" are the same statement — the first is frozen, the second is
 * derivable, and `freeze-output-outstanding-step-guard` is the negative control
 * that keeps them equal.
 *
 * That equality is load-bearing, so it is stated here rather than left for a
 * reader to reconstruct: if `freezeOutput` ever stopped requiring totality,
 * applicability would silently become a function of how far a run got.
 */

import type { JourneyStepOutcomeV1 } from "@erl2/contracts";

/** The journey intent whose success this module is about. */
export const EXERCISE_INTENT = "exercise";

/**
 * Whether this run was required to exercise the subject.
 *
 * True exactly when the committed journey ordered an exercising step — see the
 * module note on why a retained outcome is the derivable form of that frozen
 * fact.
 *
 * **Not** a function of how the exercise turned out. A run cannot become
 * "inapplicable" by failing, which is the property that keeps the gate's
 * omission honest rather than an escape hatch; that is the same discipline
 * `attributableTelemetryDeclared` follows, and the reason both now read this.
 */
export function exerciseApplicable(outcomes: readonly JourneyStepOutcomeV1[]): boolean {
  return outcomes.some((outcome) => outcome.intent === EXERCISE_INTENT);
}

/**
 * Whether this run's required exercising step actually succeeded.
 *
 * `succeeded` is the only status that satisfies it. `failed` and `unsupported`
 * do not, and neither does the absence of an outcome — a step that threw, timed
 * out or was refused freezes no outcome at all, and `freezeOutput` then refuses
 * to let the run reach a terminal, so the absent case cannot quietly become a
 * pass here.
 */
export function exerciseSucceeded(outcomes: readonly JourneyStepOutcomeV1[]): boolean {
  return outcomes.some(
    (outcome) => outcome.intent === EXERCISE_INTENT && outcome.status === "succeeded",
  );
}

/**
 * The `subject-exercise-succeeded` gate's verdict, or `undefined` where the gate
 * is not composed at all.
 *
 * `undefined` means *this run never committed an exercising step*, which is a
 * statement about the selected challenge and not about the subject. It is the
 * same omission discipline `adapter-certified` and
 * `attributable-telemetry-retained` use: a boolean cannot honestly answer a
 * question about applicability, so where the question does not apply the gate is
 * absent rather than vacuously true.
 *
 * Where it *is* composed, `false` is the whole point of ADR-ERL2-039: a required
 * exercise that did not succeed makes the run **invalid**, rather than merely
 * being recorded in a step outcome nobody's verdict reads.
 */
export function exerciseOutcomeGateVerdict(
  outcomes: readonly JourneyStepOutcomeV1[],
): boolean | undefined {
  if (!exerciseApplicable(outcomes)) return undefined;
  return exerciseSucceeded(outcomes);
}
