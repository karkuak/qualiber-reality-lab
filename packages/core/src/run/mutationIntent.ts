/**
 * Durable intent before every externally visible mutation, and reconciliation
 * before any retry (ADR-ERL2-024 §4.3).
 *
 * ## What this closes
 *
 * `runStep` called `subject.step(...)` and `activate` called `driver.mutate(...)`
 * with nothing durable recorded first. A crash between the external call and the
 * lifecycle append left a run whose retained evidence said the step never ran,
 * and the next process re-dispatched it. Proven by counting *invocations* of an
 * instrumented driver and subject port, not by counting artifacts — artifact
 * deduplication hides the second call rather than preventing it (review P1-7).
 *
 * ## Why this is private state and not a contract
 *
 * An intent records that a call is **about to be made**. It is not a result, and
 * it must never be readable as one. Making it a contract would put a record of
 * an operation that may never have happened into the mandatory closure, and
 * would need a lifecycle state per mutation. The *results* those mutations
 * produce are already contracts, already role-produced and already closed over.
 * The journal is what makes those results trustworthy; it is not a second copy
 * of them.
 *
 * It therefore lives under `state/`, beside the run lease and the derived
 * snapshot — a subtree the artifact index, the closure derivation and the
 * retained-file accounting all exclude by construction.
 *
 * ## The order
 *
 * ```
 *   declare  ->  dispatching  ->  [ the external call ]  ->  dispatched
 *                                                            -> freeze receipt
 *                                                            -> lifecycle append
 *                                                            -> settle
 * ```
 *
 * A crash at any point leaves an intent whose state names exactly how far the
 * run got. The next process **reconciles before it retries**: it asks the probe
 * whether the effect is observable in external state, and then does exactly one
 * of adopt / resume-under-the-same-key / fail closed. There is no fourth option,
 * and "assume the driver is idempotent" is not one of the three.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CODES, Erl2Error, parseStrictJson, type Hash } from "@erl2/contracts";
import { NO_CRASH, type CrashBarrier } from "./crashBarrier.js";

/** How far an intent got before the process that owned it stopped. */
export type MutationIntentState = "declared" | "dispatching" | "dispatched" | "settled";

/**
 * What a reconciliation probe can say about external state.
 *
 * `unknown` is a first-class answer, not a failure of the probe: an opaque
 * subject genuinely cannot be asked whether it already ran a step, and pretending
 * otherwise is how a restart comes to double-install.
 */
export type ProbeVerdict = "present" | "absent" | "unknown";

/** How an unsettled intent may be resumed. */
export type RetryRule = "idempotent_by_key" | "fail_closed";

export interface MutationIntent {
  readonly schema: "erl2-mutation-intent/v1";
  readonly run_id: string;
  readonly operation_id: string;
  /** `provision`, `mutate`, `restore`, `destroy`, `subject_step`, `reserve`, `release`, `emergency_action`. */
  readonly kind: string;
  /** The binding the mutation is scoped to, when the run has one. */
  readonly substrate_binding_hash?: Hash;
  /** The thing being mutated, in the driver's own vocabulary. */
  readonly target_identity: string;
  /** Canonical hash of the request that will be issued. */
  readonly request_hash: Hash;
  /** Stable across restarts, so a resumed dispatch is the same operation. */
  readonly idempotency_key: string;
  /** What the Lab observed before dispatching. */
  readonly precondition_hash: Hash;
  /**
   * For a compensation: exactly which mutations it must reverse, on which
   * targets, and what must be true afterwards (ADR-ERL2-026 §4.2).
   *
   * `request_hash` covers the same facts, but only as a digest — which answers
   * "was this the same request" and not "what was this run in the middle of
   * undoing". A reconciliation needs the second question answered.
   */
  readonly expected_reverted_mutations?: readonly string[];
  readonly expected_targets?: readonly Hash[];
  readonly expected_post_condition?: string;
  /** The observation that answers this intent's reconciliation question. */
  readonly probe_id?: string;
  readonly retry_rule: RetryRule;
  /** The committed route when the outcome cannot be established. */
  readonly compensation: string;
  readonly state: MutationIntentState;
  readonly outcome_hash?: Hash;
  readonly declared_at: string;
}

export interface MutationSpec<T> {
  readonly operationId: string;
  readonly kind: string;
  readonly targetIdentity: string;
  readonly requestHash: Hash;
  readonly idempotencyKey: string;
  readonly preconditionHash: Hash;
  readonly substrateBindingHash?: Hash;
  readonly expectedRevertedMutations?: readonly string[];
  readonly expectedTargets?: readonly Hash[];
  readonly expectedPostCondition?: string;
  readonly probeId?: string;
  readonly retry: RetryRule;
  readonly compensation: string;
  /** Answers, from **observed external state**, whether the effect already happened. */
  readonly probe: () => ProbeVerdict;
  /**
   * Rebuilds the result from an independently verified prior effect.
   *
   * Omitted when a prior effect cannot be turned back into a result — which
   * makes `present` ambiguous, and ambiguity fails closed.
   */
  readonly adopt?: () => T;
  readonly dispatch: () => T;
}

const DIR = path.join("state", "intents");

/**
 * The run's append-and-replace intent journal.
 *
 * Writes are temp-then-rename, so a crash mid-write leaves the previous state
 * rather than a truncated one — the same discipline the artifact store and the
 * substrate use.
 */
export class MutationIntentJournal {
  private readonly dir: string;
  private readonly runId: string;
  /**
   * Operations already reconciled in *this* process.
   *
   * Reconciliation is a statement about the state a process inherited. Running
   * it twice in one process would re-probe a dispatch this process itself just
   * made and, for a `fail_closed` operation, refuse the run for its own work.
   */
  private readonly reconciled = new Set<string>();
  /**
   * Where a crash may be injected, for the four boundaries this class owns.
   *
   * Injected rather than read from the environment, and a no-op in production
   * (ADR-ERL2-028 §7).
   */
  private readonly barrier: CrashBarrier;

  constructor(options: {
    readonly runRoot: string;
    readonly runId: string;
    readonly barrier?: CrashBarrier;
  }) {
    this.dir = path.join(path.resolve(options.runRoot), DIR);
    this.runId = options.runId;
    this.barrier = options.barrier ?? NO_CRASH;
  }

  private file(operationId: string): string {
    return path.join(this.dir, `${Buffer.from(operationId, "utf8").toString("base64url")}.json`);
  }

  read(operationId: string): MutationIntent | undefined {
    const file = this.file(operationId);
    if (!existsSync(file)) return undefined;
    let value: unknown;
    try {
      value = parseStrictJson(readFileSync(file, "utf8"));
    } catch (cause) {
      // A torn intent is not "no intent": answering it that way would let a
      // restart re-dispatch the very operation the record exists to protect.
      throw new Erl2Error(
        CODES.ENV_MUTATION_INTENT_AMBIGUOUS,
        `the durable intent for ${operationId} exists but could not be read; ` +
          `whether its external call was made cannot be established`,
        { owner: "lab", cause },
      );
    }
    return value as MutationIntent;
  }

  /** Every intent this run declared and has not settled. */
  unsettled(): readonly MutationIntent[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => parseStrictJson(readFileSync(path.join(this.dir, name), "utf8")) as MutationIntent)
      .filter((intent) => intent.state !== "settled");
  }

  private write(intent: MutationIntent): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const file = this.file(intent.operation_id);
    const temp = `${file}.tmp`;
    writeFileSync(temp, `${JSON.stringify(intent)}\n`, { mode: 0o600 });
    renameSync(temp, file);
  }

  private advance(operationId: string, state: MutationIntentState, outcomeHash?: Hash): void {
    const current = this.read(operationId);
    if (current === undefined) {
      throw new Erl2Error(
        CODES.ENV_MUTATION_INTENT_MISSING,
        `no durable intent exists for ${operationId}; an external mutation must never be reached without one`,
        { owner: "lab" },
      );
    }
    this.write({
      ...current,
      state,
      ...(outcomeHash === undefined ? {} : { outcome_hash: outcomeHash }),
    });
  }

  /**
   * Marks an operation complete, after its receipt is frozen and its lifecycle
   * event appended.
   *
   * Settling earlier would be a lie: an intent that says "done" while the
   * evidence is still unwritten describes a mutation nothing can prove happened.
   */
  settle(operationId: string, outcomeHash?: Hash): void {
    const current = this.read(operationId);
    if (current === undefined) return; // nothing was dispatched under this id.
    this.advance(operationId, "settled", outcomeHash);
  }

  /**
   * Runs one externally visible mutation under a durable intent, reconciling
   * first if a previous process left one unsettled.
   */
  run<T>(spec: MutationSpec<T>, declaredAt: string): T {
    const existing = this.read(spec.operationId);

    if (
      existing !== undefined &&
      existing.state !== "settled" &&
      !this.reconciled.has(spec.operationId)
    ) {
      this.reconciled.add(spec.operationId);
      if (existing.idempotency_key !== spec.idempotencyKey) {
        // The same operation id carrying different bytes is a conflict, not a
        // resume — the same rule the lifecycle log applies to a replayed event.
        throw new Erl2Error(
          CODES.ENV_MUTATION_INTENT_AMBIGUOUS,
          `operation ${spec.operationId} was declared with a different idempotency key; ` +
            `one operation id may name exactly one operation`,
          { owner: "lab" },
        );
      }
      // `declared` is `not_dispatched_proven`: the external call is made only
      // after the `dispatching` marker is durable, so an intent still sitting at
      // `declared` is positive evidence that no call was issued — not merely the
      // absence of a receipt (ADR-ERL2-028 §8).
      //
      // Probing here would have been wrong in both directions. For an idempotent
      // driver operation the probe answers `absent` and the dispatch proceeds, so
      // the outcome was right by luck. For a subject step the probe answers
      // `unknown` by construction and the run failed closed to an invalid
      // terminal over an operation that had **demonstrably not happened** — an
      // avoidable invalidation, which is not the same virtue as refusing to
      // double-install. `at most once because the Lab gave up` is only acceptable
      // when the ambiguity is real.
      if (existing.state === "declared") {
        this.advance(spec.operationId, "dispatching");
        this.barrier("before_external_dispatch", spec.operationId);
        const result = spec.dispatch();
        this.barrier("after_external_dispatch", spec.operationId);
        this.advance(spec.operationId, "dispatched");
        return result;
      }
      const observed = spec.probe();
      if (observed === "present") {
        if (spec.adopt === undefined) {
          throw new Erl2Error(
            CODES.ENV_MUTATION_INTENT_AMBIGUOUS,
            `operation ${spec.operationId} was dispatched and its effect is observable, but its ` +
              `result cannot be independently reconstructed; the authorized route is ${spec.compensation}`,
            { owner: "lab" },
          );
        }
        // Adopt an independently verified prior result: no second call.
        this.advance(spec.operationId, "dispatched");
        return spec.adopt();
      }
      if (observed === "unknown" || spec.retry === "fail_closed") {
        // Ambiguity fails closed. "Just run it again" would mean choosing to
        // double-install against a real subject to keep a happy path green.
        throw new Erl2Error(
          CODES.ENV_MUTATION_INTENT_AMBIGUOUS,
          `operation ${spec.operationId} was dispatched and its outcome cannot be observed ` +
            `(${observed}); it is not safe to repeat, so the authorized route is ${spec.compensation}`,
          { owner: "lab" },
        );
      }
      // `absent` and explicitly idempotent: resume under the *same* key.
    }

    // Boundary 1: nothing durable exists for this operation yet, and nothing
    // external has been called. A crash here must leave the run exactly as it
    // was.
    this.barrier("before_intent_freeze", spec.operationId);

    if (existing === undefined) {
      this.write({
        schema: "erl2-mutation-intent/v1",
        run_id: this.runId,
        operation_id: spec.operationId,
        kind: spec.kind,
        ...(spec.substrateBindingHash === undefined
          ? {}
          : { substrate_binding_hash: spec.substrateBindingHash }),
        target_identity: spec.targetIdentity,
        request_hash: spec.requestHash,
        idempotency_key: spec.idempotencyKey,
        precondition_hash: spec.preconditionHash,
        ...(spec.expectedRevertedMutations === undefined
          ? {}
          : { expected_reverted_mutations: [...spec.expectedRevertedMutations] }),
        ...(spec.expectedTargets === undefined ? {} : { expected_targets: [...spec.expectedTargets] }),
        ...(spec.expectedPostCondition === undefined
          ? {}
          : { expected_post_condition: spec.expectedPostCondition }),
        ...(spec.probeId === undefined ? {} : { probe_id: spec.probeId }),
        retry_rule: spec.retry,
        compensation: spec.compensation,
        state: "declared",
        declared_at: declaredAt,
      });
    }
    // Boundary 2: the intent is durable and says `declared`. Still nothing
    // external. A restart must find the intent and dispatch under the same key.
    this.barrier("after_intent_freeze", spec.operationId);

    // Durable *before* the call, so a crash during dispatch is distinguishable
    // from a crash before it.
    this.advance(spec.operationId, "dispatching");
    // Boundary 3: the intent says `dispatching`, which is the durable statement
    // "a call is about to be made and may already have been". This is the
    // boundary the whole journal exists for: before it, absence of a receipt
    // meant nothing happened; after it, absence of a receipt means nobody knows.
    this.barrier("before_external_dispatch", spec.operationId);
    const result = spec.dispatch();
    // Boundary 4: the external world has changed and the run's evidence has not.
    // For a probeable driver operation a restart adopts; for a subject step there
    // is no probe, so a restart fails closed (ADR-ERL2-024 §4.3).
    this.barrier("after_external_dispatch", spec.operationId);
    this.advance(spec.operationId, "dispatched");
    return result;
  }
}
