/**
 * The verifier's own **exact** re-derivation of the evidence window
 * (ADR-ERL2-031).
 *
 * ## What this adds to `cutoffDerivation.ts`
 *
 * That module decomposes the cutoff against three independently signed instants
 * and checks every committed bound. It is correct and it stays. What it cannot
 * do — and says so at length — is recompute the *scalar*:
 *
 * > What is **not** proven is that the operator chose a 1-second warmup rather
 * > than a 900 ms one: a producer free to select the durations is free to select
 * > ones that satisfy any recomputation.
 *
 * ADR-ERL2-031 closes that by making the producer commit the durations, under
 * `policy_author`, before the milestone is observed. This module is the reader's
 * side of it: given the commitment, the process-start receipt and the policy,
 * the cutoff, the milestone boundary and the observation window are all
 * recomputable with no freedom left.
 *
 * ## Independence
 *
 * Nothing here imports the producer's construction. The arithmetic is
 * re-implemented, the applicability rule is re-derived from the lifecycle, and
 * the signer role comes from the verifier's own `SIGNED_MEMBER_RULES`. A
 * verifier that agreed with the producer because it called the producer would be
 * re-reading a producer field with extra steps (ADR-ERL2-024 §7, ADR-ERL2-030
 * §5).
 *
 * ## What it does not claim
 *
 * A commitment proves a window was fixed under an authorized key before capture
 * and that every later instant matches it. It does not prove the window was the
 * right one — an authorized `policy_author` may commit a different window on
 * purpose, and that is governed by the cutoff policy's bounds and by who holds
 * the key, not by this arithmetic (ADR-ERL2-031 §3.4).
 */

import {
  CODES,
  Erl2Error,
  type EvidenceWindowCommitmentV1,
  type Hash,
  type LabLifecycleEventV1,
  type ObservationBundleV2,
  type RuntimeMilestoneV1,
  type SourceSnapshotV1,
  type TrafficProcessStartReceiptV1,
} from "@erl2/contracts";
import type { ArtifactIndex } from "./artifactIndex.js";

/**
 * What the exact derivation concluded, for the caller's report.
 *
 * The three instants are optional because a run may legitimately commit a window
 * and terminate before capture: the commitment then governs an observation that
 * never happened, and there is nothing to compare it against. Reporting empty
 * strings there would read as "derived, and empty", which is a different claim.
 */
export interface EvidenceWindowDerivation {
  readonly commitmentHash: Hash;
  readonly warmupMs: number;
  readonly observationMs: number;
  readonly compared: boolean;
  readonly processStartedAt?: string;
  readonly milestoneAt?: string;
  readonly cutoffInstant?: string;
}

/**
 * Instants are second-precision by contract, and the producer renders them by
 * **truncating** a millisecond ISO string rather than rounding. A window that is
 * not a whole number of seconds would therefore render an instant that disagrees
 * with the arithmetic that produced it, so the schema pins both durations to
 * `multipleOf: 1000` and this is the verifier's independent restatement of it.
 */
const MS_PER_SECOND = 1_000;

/** The ceiling both duration fields share with the cutoff policy's own maxima. */
const MAXIMUM_DURATION_MS = 5_400_000;

function parseInstant(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new Erl2Error(CODES.CUTOFF_BOUND_EXCEEDED, `${label} is not a parseable instant: ${value}`);
  }
  return parsed;
}

/** Renders an epoch-millisecond value at the contract's own second precision. */
function renderInstant(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Integer addition that refuses rather than silently losing precision.
 *
 * Every operand here is bounded by the schema, so the sum cannot reach
 * `Number.MAX_SAFE_INTEGER` in practice. It is checked anyway: a bound that
 * holds by construction and is asserted anyway is the one that survives the next
 * change to the construction.
 */
function addExact(left: number, right: number, label: string): number {
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right)) {
    throw new Erl2Error(CODES.CUTOFF_BOUND_EXCEEDED, `${label} is not exact integer arithmetic`);
  }
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) {
    throw new Erl2Error(CODES.CUTOFF_BOUND_EXCEEDED, `${label} overflows exact integer arithmetic`);
  }
  return sum;
}

/**
 * Checks one committed duration on the verifier's own terms.
 *
 * Deliberately re-stated rather than delegated to schema validation: a verifier
 * that trusted the schema for its numeric invariants would stop refusing the
 * moment a unit test constructed the object directly, which is exactly how §17's
 * boundary cases reach this code.
 */
function assertDuration(value: number, label: string, minimum: number): void {
  if (!Number.isInteger(value)) {
    throw new Erl2Error(CODES.CUTOFF_BOUND_EXCEEDED, `the committed ${label} ${String(value)} is not an integer`);
  }
  if (value < minimum) {
    throw new Erl2Error(
      CODES.CUTOFF_BOUND_EXCEEDED,
      `the committed ${label} is ${String(value)} ms, below the minimum of ${String(minimum)} ms`,
    );
  }
  if (value > MAXIMUM_DURATION_MS) {
    throw new Erl2Error(
      CODES.CUTOFF_BOUND_EXCEEDED,
      `the committed ${label} is ${String(value)} ms, beyond the maximum of ${String(MAXIMUM_DURATION_MS)} ms`,
    );
  }
  if (value % MS_PER_SECOND !== 0) {
    throw new Erl2Error(
      CODES.CUTOFF_BOUND_EXCEEDED,
      `the committed ${label} is ${String(value)} ms, which is not a whole number of seconds; ` +
        `retained instants are second-precision and the derived instant would not be representable`,
    );
  }
}

/** Every artifact core hash some lifecycle event names as produced. */
function reachedHashes(events: readonly LabLifecycleEventV1[]): Set<string> {
  const reached = new Set<string>();
  for (const event of events) {
    for (const produced of event.produced) reached.add(produced.artifact_core_hash);
  }
  return reached;
}

/**
 * The retained commitment for this run, or `undefined` when the run never
 * reached traffic.
 *
 * Applicability is decided by the **lifecycle**, not by whether a commitment
 * happens to be retained: a run that reached `traffic_or_journey_started` must
 * have one, and a run that did not must not, and reading the retained set to
 * decide which case applies would let an omission answer its own question.
 */
export function resolveEvidenceWindowCommitment(options: {
  readonly index: ArtifactIndex;
  readonly lifecycle: readonly LabLifecycleEventV1[];
  readonly runId: string;
}): { readonly commitment: EvidenceWindowCommitmentV1; readonly hash: Hash } | undefined {
  const retained = options.index.ofSchema("evidence-window-commitment/v1");
  const reachedTraffic = options.lifecycle.some(
    (event) => event.event_type === "traffic_or_journey_started",
  );

  if (!reachedTraffic) {
    if (retained.length > 0) {
      throw new Erl2Error(
        CODES.GRAPH_CLOSURE_EXTRA_ARTIFACT,
        `this run never started traffic, so it can have committed no evidence window; ` +
          `${String(retained.length)} evidence-window-commitment(s) are retained`,
      );
    }
    return undefined;
  }

  if (retained.length === 0) {
    throw new Erl2Error(
      CODES.GRAPH_CLOSURE_MISSING_ROLE,
      "this run started traffic, so it must retain exactly one signed evidence-window commitment; " +
        "without it the exact evidence window is unrecoverable and the cutoff can only be " +
        "bounds-checked (ADR-ERL2-031 §1.1)",
    );
  }
  if (retained.length > 1) {
    throw new Erl2Error(
      CODES.GRAPH_CLOSURE_EXTRA_ARTIFACT,
      `a run commits exactly one evidence window; ${String(retained.length)} are retained`,
    );
  }

  const found = retained[0] as { value: unknown; coreHash: Hash };
  const commitment = found.value as EvidenceWindowCommitmentV1;

  if (commitment.run_id !== options.runId) {
    throw new Erl2Error(
      CODES.GRAPH_CLOSURE_TERMINAL_MISMATCH,
      `the retained evidence-window commitment belongs to run ${commitment.run_id}, not ${options.runId}`,
    );
  }

  // Lifecycle reachability is **not** re-checked here, deliberately.
  //
  // It was, and the campaign showed the check could never be killed: a retained
  // artifact no lifecycle event produced is a rejected extra to the closure on
  // both branches — `deriveEnvironmentClosure` on the valid one, and
  // `deriveInvalidClosure` on the invalid one, whose `available_evidence` is
  // built from every event's `produced`. Both run before this derivation and
  // both refuse first, with the more fundamental cause.
  //
  // `WINDOW-UNREACHED` measures exactly that and asserts
  // `GRAPH_CLOSURE_EXTRA_ARTIFACT`. A second check standing behind the first
  // adds no refusal and makes neither measurable — the same lesson the
  // duplicated commitment requirement taught one function over.

  return { commitment, hash: commitment.core_hash };
}

/**
 * The commitment must be frozen **before** anything whose meaning depends on the
 * window, derived from the event chain rather than from any timestamp.
 */
export function assertCommitmentPrecedesCapture(
  events: readonly LabLifecycleEventV1[],
  commitmentHash: Hash,
): void {
  const producedAt = events.findIndex((event) =>
    event.produced.some((p) => p.artifact_core_hash === commitmentHash),
  );
  if (producedAt < 0) {
    throw new Erl2Error(
      CODES.GRAPH_CLOSURE_UNREACHABLE_ARTIFACT,
      "no lifecycle event produced the evidence-window commitment",
    );
  }
  for (const after of [
    "evidence_cutoff_realized",
    "observation_frozen",
    "truth_revealed",
    "judge_journey_expectation_revealed",
  ]) {
    const at = events.findIndex((event) => event.event_type === after);
    if (at >= 0 && at < producedAt) {
      throw new Erl2Error(
        CODES.POLICY_CONFLICT,
        `the evidence-window commitment was frozen after ${after}; a window committed after the ` +
          `evidence it governs commits nothing`,
      );
    }
  }
}

/**
 * Rederive the **exact** evidence window, and compare it with what was retained.
 *
 * Returns `undefined` when the run never started traffic — the capture group is
 * optional as a group, and a run that terminated earlier committed no window
 * (ADR-ERL2-029 §3.4, unchanged).
 *
 * Everything below is the verifier's own arithmetic over retained bytes. It does
 * not call the producer, and it does not read a scalar the producer wrote: the
 * cutoff instant, the milestone boundary and the observation window are each
 * recomputed from `process_started_at` plus the two committed durations, and
 * compared.
 */
export function deriveExactEvidenceWindow(options: {
  readonly index: ArtifactIndex;
  readonly lifecycle: readonly LabLifecycleEventV1[];
  readonly runId: string;
}): EvidenceWindowDerivation | undefined {
  const resolved = resolveEvidenceWindowCommitment(options);
  if (resolved === undefined) return undefined;
  const { commitment } = resolved;

  assertCommitmentPrecedesCapture(options.lifecycle, commitment.core_hash);

  // -- 1. the committed durations, on the verifier's own terms ---------------
  //
  // Restated rather than delegated to schema validation: a verifier that trusted
  // the schema for its numeric invariants would stop refusing the moment a caller
  // constructed the object directly.
  assertDuration(commitment.warmup_ms, "warmup", 0);
  assertDuration(commitment.observation_ms, "observation window", MS_PER_SECOND);

  if (commitment.instant_rule !== "traffic_process_started_at_plus_warmup_ms_plus_observation_ms") {
    throw new Erl2Error(
      CODES.CUTOFF_BOUND_EXCEEDED,
      `the commitment declares instant rule ${commitment.instant_rule}; this verifier derives the ` +
        `traffic_process_started_at_plus_warmup_ms_plus_observation_ms rule`,
    );
  }
  if (commitment.milestone_relationship !== "runtime_milestone_at_process_start_plus_warmup_ms") {
    throw new Erl2Error(
      CODES.CUTOFF_BOUND_EXCEEDED,
      `the commitment declares milestone relationship ${commitment.milestone_relationship}, which ` +
        `this verifier does not derive`,
    );
  }

  // -- 2. the observation bundle, and the cutoff it carries ------------------
  const bundles = options.index.ofSchema("observation-bundle/v2");
  if (bundles.length === 0) {
    // A run that committed a window and terminated before capture is legal: the
    // commitment governs an observation that never happened. Nothing to compare.
    return {
      commitmentHash: commitment.core_hash,
      warmupMs: commitment.warmup_ms,
      observationMs: commitment.observation_ms,
      compared: false,
    };
  }
  const bundle = (bundles[0] as { value: unknown }).value as ObservationBundleV2;
  const { cutoff } = bundle;

  // -- 3. bindings -----------------------------------------------------------
  //
  // Each of these is a substitution the arithmetic alone would not catch: a
  // commitment honestly describing some other policy, receipt, clock domain or
  // observation policy, cited by a cutoff that names this run's.
  if (commitment.cutoff_policy_hash !== cutoff.policy_hash) {
    throw new Erl2Error(
      CODES.CUTOFF_MILESTONE_MISMATCH,
      `the evidence-window commitment names cutoff policy ${commitment.cutoff_policy_hash}, but the ` +
        `cutoff was derived under ${cutoff.policy_hash}`,
    );
  }
  if (commitment.process_start_receipt_hash !== cutoff.process_start_receipt_hash) {
    throw new Erl2Error(
      CODES.CUTOFF_MILESTONE_MISMATCH,
      `the evidence-window commitment measures from process-start receipt ` +
        `${commitment.process_start_receipt_hash}, but the cutoff was derived from ` +
        `${cutoff.process_start_receipt_hash}`,
    );
  }
  if (commitment.comparison_policy_hash !== bundle.comparison_policy_hash) {
    throw new Erl2Error(
      CODES.CUTOFF_MILESTONE_MISMATCH,
      `the evidence-window commitment names comparison policy ${commitment.comparison_policy_hash}, ` +
        `but the observation was frozen under ${bundle.comparison_policy_hash}`,
    );
  }
  if (commitment.environment_instance_hash !== bundle.environment_instance_hash) {
    throw new Erl2Error(
      CODES.CUTOFF_MILESTONE_MISMATCH,
      "the evidence-window commitment and the observation bundle name different environment instances",
    );
  }

  const receipt = options.index.typed<TrafficProcessStartReceiptV1>(
    cutoff.process_start_receipt_hash,
    "traffic-process-start-receipt/v1",
  );
  const milestone = options.index.typed<RuntimeMilestoneV1>(
    cutoff.runtime_milestone_hash,
    "runtime-milestone/v1",
  );
  if (commitment.monotonic_clock_domain_hash !== receipt.monotonic_clock_domain_hash) {
    throw new Erl2Error(
      CODES.CUTOFF_CLOCK_DOMAIN_MISMATCH,
      "the evidence-window commitment and the process-start receipt are in different monotonic " +
        "clock domains",
    );
  }

  // -- 4. the arithmetic, in exact integers ----------------------------------
  const startedAtMs = parseInstant(receipt.process_started_at, "process_started_at");
  const milestoneMs = parseInstant(milestone.occurred_at, "milestone occurred_at");
  const cutoffMs = parseInstant(cutoff.instant, "cutoff instant");

  const derivedMilestoneMs = addExact(startedAtMs, commitment.warmup_ms, "committed warmup");
  const derivedCutoffMs = addExact(
    derivedMilestoneMs,
    commitment.observation_ms,
    "committed observation window",
  );

  // The milestone marks the warmup boundary. This is the check that stops a
  // producer from moving the window and moving the milestone to match — the
  // residual ADR-ERL2-029 §3.2 recorded and could not close, because it decomposed
  // the durations *out of* these same instants.
  if (derivedMilestoneMs !== milestoneMs) {
    throw new Erl2Error(
      CODES.CUTOFF_BOUND_EXCEEDED,
      `the runtime milestone is at ${milestone.occurred_at}, but this run committed a ` +
        `${String(commitment.warmup_ms)} ms warmup from ${receipt.process_started_at}, which is ` +
        `${renderInstant(derivedMilestoneMs)}`,
    );
  }
  if (derivedCutoffMs !== cutoffMs) {
    throw new Erl2Error(
      CODES.CUTOFF_BOUND_EXCEEDED,
      `the retained cutoff is ${cutoff.instant}, but the committed window ` +
        `(${String(commitment.warmup_ms)} ms warmup + ${String(commitment.observation_ms)} ms ` +
        `observation from ${receipt.process_started_at}) derives ${renderInstant(derivedCutoffMs)}`,
    );
  }

  // -- 5. the window the capture actually used -------------------------------
  //
  // The bundle's cutoff is checked above; the snapshots carry the window
  // separately, and a capture that read a different window from the one the
  // cutoff names is the same defect one layer out.
  for (const snapshot of options.index.ofSchema("source-snapshot/v1")) {
    const value = (snapshot as { value: unknown }).value as SourceSnapshotV1;
    if (value.run_id !== options.runId) continue;
    const fromMs = parseInstant(value.window.from, "snapshot window.from");
    const toMs = parseInstant(value.window.to_exclusive, "snapshot window.to_exclusive");
    if (fromMs !== startedAtMs) {
      throw new Erl2Error(
        CODES.CUTOFF_BOUND_EXCEEDED,
        `source snapshot ${value.snapshot_id} opens its window at ${value.window.from}, not at the ` +
          `process start ${receipt.process_started_at} the committed window is measured from`,
      );
    }
    if (toMs !== derivedCutoffMs) {
      throw new Erl2Error(
        CODES.CUTOFF_BOUND_EXCEEDED,
        `source snapshot ${value.snapshot_id} closes its window at ${value.window.to_exclusive}, not ` +
          `at the committed cutoff ${renderInstant(derivedCutoffMs)}`,
      );
    }
  }

  return {
    commitmentHash: commitment.core_hash,
    warmupMs: commitment.warmup_ms,
    observationMs: commitment.observation_ms,
    compared: true,
    processStartedAt: receipt.process_started_at,
    milestoneAt: milestone.occurred_at,
    cutoffInstant: cutoff.instant,
  };
}
