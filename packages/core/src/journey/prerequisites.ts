/**
 * The prerequisite every canonical journey intent owes before it may dispatch
 * (review P1-9, ADR-ERL2-028 §2).
 *
 * ## What this closes
 *
 * `EnvironmentRun.runStep` gated the setup/post-capture split on one state:
 *
 * ```ts
 * if (state === "execution_plan_frozen" && !SETUP_INTENTS.has(step.intent)) throw …
 * ```
 *
 * The `execute-subject` phase departs from three states, and
 * `step_outcome_frozen` recurs after *every* step. So the gate fired on the
 * first step of the journey and on no other. A run that had connected and
 * discovered sat in `step_outcome_frozen`, and the next `erl2 execute-subject`
 * ran the committed `exercise` step — before the challenge was activated and
 * before the evidence cutoff existed. The run then finalized `valid` and
 * verified offline, because nothing downstream re-asked the question
 * (review P1-9).
 *
 * ## Why a table
 *
 * The ordering *is* the thing being asserted, so it is written as data — the
 * same reason `ENVIRONMENT_PHASES` and `TRANSITIONS` are data. A row per intent
 * also means the compiler is the completeness check: `JOURNEY_PREREQUISITES` is
 * a `Record<JourneyIntent, …>`, so adding an intent to the frozen contract
 * without deciding its prerequisites does not build.
 *
 * ## Where the rows come from
 *
 * Design v2 §12's state machine, not from the intent names:
 *
 * ```
 *   execution_plan_frozen   --> step_planned: install through connect
 *   step_outcome_frozen     --> step_planned: next permitted step
 *   step_outcome_frozen     --> challenge_activated: connected
 *   adapter_translation_frozen --> step_planned: exercise through remove
 * ```
 *
 * `install` through `connect` may open the journey. `discover` is in neither
 * range, and departs from `step_outcome_frozen` only — it cannot be a journey's
 * first step. `exercise` through `remove` depart from `adapter_translation_frozen`,
 * which is reachable only through activation, traffic, the realized cutoff and
 * the frozen observation, and that is what makes them post-capture.
 *
 * ## Why the checks are evidence-derived and not state-derived
 *
 * Requiring departure from `adapter_translation_frozen` would already imply
 * activation and the cutoff, because the only path into that state runs through
 * both. It is still not what this module checks. A state is a summary; the
 * retained artifact is the fact. The same discipline the review confirmed for
 * phase idempotence — "answered from evidence, never from state ordering" —
 * applies here, and it is what makes the prerequisite survive any future edge
 * added to the transition table.
 */

import type { JourneyIntent } from "@erl2/contracts";
import { CODES, Erl2Error } from "@erl2/contracts";
import type { LabState } from "../lifecycle/states.js";

/**
 * One fact a journey intent may owe before it dispatches.
 *
 * Reveal, terminal and cleanup prohibitions are deliberately **absent**:
 * `assertSubjectPortExecutable` already refuses every one of those states
 * before the port is reached, for every intent, and duplicating the rule here
 * would create two places for it to drift.
 */
export type JourneyPrerequisite =
  /** A verified subject package manifest exists. */
  | "verified_package"
  /** The selection chain reached a verified case. */
  | "selected_challenge"
  /** The environment was provisioned and its inventory retained. */
  | "provisioned_environment"
  /** A baseline fingerprint was taken and found clean. */
  | "stable_baseline"
  /** The execution plan is frozen. */
  | "execution_plan"
  /** A `connect` step exists and *succeeded*. */
  | "successful_connection"
  /** The challenge is activated, with the controller's signed receipt. */
  | "challenge_activation"
  /** The evidence cutoff was realized and its snapshots retained. */
  | "evidence_cutoff"
  /** The observation bundle is frozen. */
  | "observation_bundle"
  /** At least one committed step of this journey already produced an outcome. */
  | "prior_committed_step";

/** Which walk an intent belongs to. */
export type JourneyBranch = "pre_environment" | "environment";

export interface JourneyIntentRow {
  /**
   * The states this intent may depart from on the environment walk.
   *
   * Empty for a pre-environment intent: the acquisition path runs through its
   * own commands and never through `execute-subject`.
   */
  readonly departsFrom: readonly LabState[];
  readonly branch: JourneyBranch;
  readonly requires: readonly JourneyPrerequisite[];
  /**
   * Set when design v2 §12 permits a departure this Lab does not yet enable.
   *
   * `recover`, `rollback` and `remove` are reachable from
   * `pre_reveal_subject_cleanup_started` in the design — the pre-reveal subject
   * cleanup edge — and that edge has never shipped. It is recorded here rather
   * than silently widened: `departsFrom` is the enabled set, this field is the
   * design's, and the difference is asserted by a test rather than left to be
   * rediscovered.
   */
  readonly designAlsoPermits?: readonly LabState[];
}

/** Every prerequisite the setup intents share. */
const SETUP_REQUIREMENTS: readonly JourneyPrerequisite[] = [
  "verified_package",
  "selected_challenge",
  "provisioned_environment",
  "stable_baseline",
  "execution_plan",
];

/**
 * Every prerequisite a post-capture intent owes.
 *
 * The three that the setup intents do not owe are the point of this module:
 * a succeeded connection, the activated challenge and the realized cutoff.
 */
const POST_CAPTURE_REQUIREMENTS: readonly JourneyPrerequisite[] = [
  ...SETUP_REQUIREMENTS,
  "prior_committed_step",
  "successful_connection",
  "challenge_activation",
  "evidence_cutoff",
  "observation_bundle",
];

/** States an intent that may open the journey departs from. */
const OPENS_JOURNEY: readonly LabState[] = ["execution_plan_frozen", "step_outcome_frozen"];

/**
 * The states a post-capture intent departs from.
 *
 * Both, and this is the crux of why the prerequisites are evidence-derived.
 * `adapter_translation_frozen` is how the post-capture *sequence* is entered;
 * every step after the first one in that sequence departs from
 * `step_outcome_frozen`, under the design's
 * `step_outcome_frozen --> step_planned: next permitted step`. A journey
 * committing `exercise, observe, remove` therefore departs from
 * `adapter_translation_frozen` once and from `step_outcome_frozen` twice.
 *
 * So the departure state cannot be what separates a post-capture intent from a
 * pre-activation one: `step_outcome_frozen` is common to both, and it is exactly
 * the state the old single-state gate did not cover. What separates them is
 * whether the activation receipt, the realized cutoff and the observation bundle
 * are *retained* — facts a state cannot express and a run cannot fake.
 */
const AFTER_CAPTURE: readonly LabState[] = ["adapter_translation_frozen", "step_outcome_frozen"];

/**
 * The matrix.
 *
 * A `Record<JourneyIntent, …>` on purpose: the frozen contract's intent union is
 * the key set, so a new canonical intent that arrives without a prerequisite row
 * fails to compile rather than defaulting to permitted.
 */
export const JOURNEY_PREREQUISITES: Readonly<Record<JourneyIntent, JourneyIntentRow>> = {
  // -- the pre-environment walk ---------------------------------------------
  // Neither runs through `execute-subject`; both are refused on the environment
  // step path outright rather than given an environment departure state.
  acquire: { departsFrom: [], branch: "pre_environment", requires: [] },
  verify_package: {
    departsFrom: [],
    branch: "pre_environment",
    requires: ["prior_committed_step"],
  },

  // -- setup: "install through connect" may open the journey ----------------
  install: { departsFrom: OPENS_JOURNEY, branch: "environment", requires: SETUP_REQUIREMENTS },
  configure: { departsFrom: OPENS_JOURNEY, branch: "environment", requires: SETUP_REQUIREMENTS },
  authenticate: { departsFrom: OPENS_JOURNEY, branch: "environment", requires: SETUP_REQUIREMENTS },
  connect: { departsFrom: OPENS_JOURNEY, branch: "environment", requires: SETUP_REQUIREMENTS },

  // `discover` is in neither of the design's two ranges. It follows a step and
  // cannot be a journey's first, and it is still pre-activation.
  discover: {
    departsFrom: ["step_outcome_frozen"],
    branch: "environment",
    requires: [...SETUP_REQUIREMENTS, "prior_committed_step"],
  },

  // -- post-capture: "exercise through remove" ------------------------------
  exercise: { departsFrom: AFTER_CAPTURE, branch: "environment", requires: POST_CAPTURE_REQUIREMENTS },
  observe: { departsFrom: AFTER_CAPTURE, branch: "environment", requires: POST_CAPTURE_REQUIREMENTS },
  diagnose_decide: {
    departsFrom: AFTER_CAPTURE,
    branch: "environment",
    requires: POST_CAPTURE_REQUIREMENTS,
  },
  upgrade: { departsFrom: AFTER_CAPTURE, branch: "environment", requires: POST_CAPTURE_REQUIREMENTS },
  recover: {
    departsFrom: AFTER_CAPTURE,
    branch: "environment",
    requires: POST_CAPTURE_REQUIREMENTS,
    designAlsoPermits: ["pre_reveal_subject_cleanup_started"],
  },
  rollback: {
    departsFrom: AFTER_CAPTURE,
    branch: "environment",
    requires: POST_CAPTURE_REQUIREMENTS,
    designAlsoPermits: ["pre_reveal_subject_cleanup_started"],
  },
  remove: {
    departsFrom: AFTER_CAPTURE,
    branch: "environment",
    requires: POST_CAPTURE_REQUIREMENTS,
    designAlsoPermits: ["pre_reveal_subject_cleanup_started"],
  },
};

/**
 * The intents in the design's canonical order.
 *
 * Exported so a test can assert the matrix and the contract union agree in
 * *both* directions: the `Record` type catches a missing row, and this catches a
 * row for an intent the contract does not declare.
 */
export const CANONICAL_JOURNEY_INTENTS: readonly JourneyIntent[] = [
  "acquire",
  "verify_package",
  "install",
  "configure",
  "authenticate",
  "connect",
  "discover",
  "exercise",
  "observe",
  "diagnose_decide",
  "recover",
  "upgrade",
  "rollback",
  "remove",
];

/**
 * What the run has actually retained, as the matrix needs to see it.
 *
 * A predicate set rather than a workspace, so the enforcement is pure and can be
 * exercised against a table of states without building a run.
 */
export interface JourneyPrerequisiteEvidence {
  readonly state: LabState;
  /** True when the hash-chained lifecycle produced this role. */
  readonly hasRole: (role: string) => boolean;
  /** True when a `connect` step outcome exists and its status is `succeeded`. */
  readonly connectSucceeded: boolean;
  /** How many committed steps of this journey already produced an outcome. */
  readonly completedStepCount: number;
}

/** The retained role, or other fact, each prerequisite is satisfied by. */
const SATISFIED_BY: Readonly<
  Record<JourneyPrerequisite, (evidence: JourneyPrerequisiteEvidence) => boolean>
> = {
  verified_package: (e) => e.hasRole("package-verification-record"),
  selected_challenge: (e) => e.hasRole("selected-challenge-journey-binding"),
  provisioned_environment: (e) => e.hasRole("environment-resource-inventory"),
  stable_baseline: (e) => e.hasRole("environment-baseline"),
  execution_plan: (e) => e.hasRole("execution-plan"),
  successful_connection: (e) => e.connectSucceeded,
  // Both, and for different reasons: the driver receipt says the substrate was
  // mutated, and the controller's signed receipt says who authorized it
  // (ADR-ERL2-023 §2). A run holding only the first activated nothing anyone is
  // accountable for.
  challenge_activation: (e) => e.hasRole("mutation-receipt") && e.hasRole("challenge-activation-receipt"),
  // The realized cutoff, not the *intent* to realize one: `runtime-milestone` is
  // frozen by `journey` and is the cutoff's input, while a retained
  // `source-snapshot` is the observation the cutoff actually stamped.
  evidence_cutoff: (e) => e.hasRole("runtime-milestone") && e.hasRole("source-snapshot"),
  observation_bundle: (e) => e.hasRole("observation-bundle"),
  prior_committed_step: (e) => e.completedStepCount > 0,
};

/** Human-readable reason for each unmet prerequisite. */
const UNMET_REASON: Readonly<Record<JourneyPrerequisite, string>> = {
  verified_package: "no verified subject package manifest is retained",
  selected_challenge: "the selection chain has not reached a verified case",
  provisioned_environment: "no environment resource inventory is retained",
  stable_baseline: "no environment baseline fingerprint is retained",
  execution_plan: "the execution plan is not frozen",
  successful_connection: "the selected journey has no succeeded connect step",
  challenge_activation: "the challenge is not activated",
  evidence_cutoff: "the evidence cutoff has not been realized",
  observation_bundle: "the observation bundle is not frozen",
  prior_committed_step: "no committed step of this journey has produced an outcome yet",
};

/**
 * Refuses a journey intent that has not earned its dispatch.
 *
 * Called at the library boundary — inside `EnvironmentRun.runStep`, before the
 * step request is built and long before the durable intent — so a caller that
 * drives `EnvironmentRun` directly is held to the same matrix as one that goes
 * through the CLI. That is the half of P1-9 that a CLI-only fix would have left
 * open.
 */
export function assertJourneyPrerequisites(
  intent: JourneyIntent,
  evidence: JourneyPrerequisiteEvidence,
): void {
  const row = JOURNEY_PREREQUISITES[intent];

  if (row.branch === "pre_environment") {
    throw new Erl2Error(
      CODES.POLICY_CONFLICT,
      `${intent} belongs to the pre-environment walk and cannot run as an environment journey step`,
    );
  }

  if (!row.departsFrom.includes(evidence.state)) {
    const alsoPermitted = row.designAlsoPermits ?? [];
    const note = alsoPermitted.includes(evidence.state)
      ? `; design v2 §12 permits ${intent} from ${evidence.state}, and that edge is not enabled`
      : "";
    throw new Erl2Error(
      CODES.POLICY_CONFLICT,
      `${intent} departs from ${row.departsFrom.join(" or ")}; this run is in ${evidence.state}${note}`,
    );
  }

  const unmet = row.requires.filter((prerequisite) => !SATISFIED_BY[prerequisite](evidence));
  if (unmet.length > 0) {
    throw new Erl2Error(
      CODES.POLICY_CONFLICT,
      `${intent} requires ${unmet.join(", ")}: ${unmet
        .map((prerequisite) => UNMET_REASON[prerequisite])
        .join("; ")}`,
    );
  }
}

/** Whether an intent is one the design runs after the evidence cutoff. */
export function isPostCaptureIntent(intent: JourneyIntent): boolean {
  return JOURNEY_PREREQUISITES[intent].requires.includes("evidence_cutoff");
}
