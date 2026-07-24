/**
 * Append-only, hash-chained lifecycle log with an atomically replaced derived
 * snapshot (design v2 §12, implementation plan §8.4).
 *
 * Invariants enforced here:
 *   - every event carries the hash of its predecessor;
 *   - the same operation id with the same bytes is idempotent;
 *   - the same operation id with different bytes is a conflict;
 *   - a mutator holds the run lease and compares the prior event hash;
 *   - a crash leaves either a complete event or none, because the event file is
 *     published through the artifact freeze protocol.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import path from "node:path";
import {
  assertContract,
  CODES,
  Erl2Error,
  type Hash,
  type LabLifecycleEventV1,
} from "@erl2/contracts";
import { ArtifactStore, coreHash, jcsBytes } from "@erl2/integrity";
import type { Clock } from "../runtime/seams.js";
import { assertTransitionAllowed, type LabState } from "./states.js";

export interface AppendEventInput {
  readonly eventType: string;
  readonly stateTo: LabState;
  readonly actorId: string;
  readonly commandId: string;
  readonly operationId: string;
  readonly requiredHashes?: readonly Hash[];
  readonly produced?: readonly {
    readonly artifact_role: string;
    readonly artifact_core_hash: Hash;
    readonly artifact_schema_version: string;
  }[];
  readonly failure?: {
    readonly code: string;
    readonly owner: "lab" | "external_dependency" | "adapter" | "subject" | "evaluator" | "inconclusive";
    readonly message: string;
  };
}

export interface RunSnapshot {
  readonly run_id: string;
  readonly state: LabState;
  readonly sequence: number;
  readonly lifecycle_head_hash: Hash;
  readonly updated_at: string;
}

const EVENT_DIR = "events";
const SNAPSHOT_PATH = "state/snapshot.json";

/** Event bytes with presentation-only fields removed, for idempotency comparison. */
function comparableCore(event: LabLifecycleEventV1): Buffer {
  const record = { ...event } as Record<string, unknown>;
  for (const key of ["event_id", "occurred_at", "core_hash"]) delete record[key];
  return jcsBytes(record);
}

export class LifecycleLog {
  private readonly runId: string;
  private readonly store: ArtifactStore;
  private readonly clock: Clock;
  private events: LabLifecycleEventV1[] = [];
  private headHash: Hash | undefined;
  private state: LabState = "created";
  private leaseHolder: string | undefined;

  constructor(options: { readonly runId: string; readonly store: ArtifactStore; readonly clock: Clock }) {
    this.runId = options.runId;
    this.store = options.store;
    this.clock = options.clock;
    mkdirSync(path.join(this.store.root, "state"), { recursive: true, mode: 0o700 });
    this.recover();
  }

  /** Rebuilds in-memory state from the frozen event files. */
  private recover(): void {
    const dir = path.join(this.store.root, EVENT_DIR);
    if (!existsSync(dir)) return;
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".json") && !f.endsWith(".frozen"))
      .sort();
    for (const file of files) {
      const event = assertContract<LabLifecycleEventV1>(
        "LabLifecycleEventV1",
        JSON.parse(readFileSync(path.join(dir, file), "utf8")) as unknown,
      );
      if (event.sequence !== this.events.length) {
        throw new Erl2Error(CODES.VERIFY_RECORD_LIFECYCLE_GAP, "lifecycle sequence gap during recovery");
      }
      if (event.prior_event_hash !== this.headHash) {
        throw new Erl2Error(CODES.VERIFY_RECORD_LIFECYCLE_GAP, "lifecycle chain broken during recovery");
      }
      this.events.push(event);
      this.headHash = coreHash(event);
      this.state = event.state_to as LabState;
    }
  }

  acquireLease(holder: string): void {
    if (this.leaseHolder !== undefined && this.leaseHolder !== holder) {
      throw new Erl2Error(CODES.POLICY_CONFLICT, `run lease already held by ${this.leaseHolder}`);
    }
    this.leaseHolder = holder;
  }

  releaseLease(holder: string): void {
    if (this.leaseHolder === holder) this.leaseHolder = undefined;
  }

  get currentState(): LabState {
    return this.state;
  }

  get head(): Hash | undefined {
    return this.headHash;
  }

  get sequence(): number {
    return this.events.length;
  }

  all(): readonly LabLifecycleEventV1[] {
    return [...this.events];
  }

  find(predicate: (event: LabLifecycleEventV1) => boolean): LabLifecycleEventV1 | undefined {
    return this.events.find(predicate);
  }

  /** Appends one event after validating the transition and idempotency rules. */
  append(input: AppendEventInput): LabLifecycleEventV1 {
    // Idempotency is checked BEFORE the transition guard: replaying a durable
    // operation must be a no-op, not a state-machine violation.
    const prior = this.events.find((e) => e.operation_id === input.operationId);
    if (prior) {
      const candidate = this.buildEvent(input, prior.sequence, prior.state_from as LabState, prior.prior_event_hash);
      if (comparableCore(prior).equals(comparableCore(candidate))) return prior;
      throw new Erl2Error(
        CODES.POLICY_CONFLICT,
        `operation ${input.operationId} was already applied with different bytes`,
      );
    }

    assertTransitionAllowed(this.state, input.stateTo, input.eventType);
    const event = this.buildEvent(input, this.events.length, this.state, this.headHash);

    this.store.freezeJson(
      `${EVENT_DIR}/${String(event.sequence).padStart(6, "0")}.json`,
      event,
      "INTERNAL",
    );
    this.events.push(event);
    this.headHash = coreHash(event);
    this.state = input.stateTo;
    this.writeSnapshot();
    return event;
  }

  private buildEvent(
    input: AppendEventInput,
    sequence: number,
    stateFrom: LabState,
    priorEventHash: Hash | undefined,
  ): LabLifecycleEventV1 {
    const base = {
      schema_version: "lab-lifecycle-event/v1" as const,
      run_id: this.runId,
      sequence,
      event_id: `evt-${String(sequence).padStart(6, "0")}`,
      event_type: input.eventType,
      state_from: stateFrom,
      state_to: input.stateTo,
      occurred_at: this.clock.now(),
      actor_id: input.actorId,
      command_id: input.commandId,
      operation_id: input.operationId,
      ...(priorEventHash === undefined ? {} : { prior_event_hash: priorEventHash }),
      required_hashes: [...(input.requiredHashes ?? [])],
      produced: [...(input.produced ?? [])],
      ...(input.failure === undefined ? {} : { failure: input.failure }),
    };
    return assertContract<LabLifecycleEventV1>("LabLifecycleEventV1", {
      ...base,
      core_hash: coreHash(base),
    });
  }

  /** Atomically replaces the derived snapshot; it is never authoritative. */
  private writeSnapshot(): void {
    // `updated_at` is the just-appended event's time, NOT a fresh clock read.
    // Reading the clock here would consume a tick only on real appends (not on
    // idempotent replays), so a deterministic clock would diverge between a
    // first run and a replay and break byte-identical recovery (P1-2 §7.3).
    const last = this.events[this.events.length - 1];
    const snapshot: RunSnapshot = {
      run_id: this.runId,
      state: this.state,
      sequence: this.events.length,
      lifecycle_head_hash: this.headHash ?? ("sha256:" + "0".repeat(64) as Hash),
      updated_at: last?.occurred_at ?? (`${"1970-01-01T00:00:00"}Z` as string),
    };
    const absolute = path.join(this.store.root, SNAPSHOT_PATH);
    const temp = `${absolute}.tmp`;
    writeFileSync(temp, `${jcsBytes(snapshot).toString("utf8")}\n`, { mode: 0o600 });
    renameSync(temp, absolute);
  }

  /**
   * The derived snapshot, rebuilt from the authoritative in-memory event state
   * (which `recover()` reconstructed from the event log).  It never reads the
   * `state/snapshot.json` cache, so a torn or missing snapshot file cannot crash
   * a caller — the cache is a convenience, never a source of truth (§11.9).
   */
  snapshot(): RunSnapshot | undefined {
    if (this.events.length === 0) return undefined;
    const last = this.events[this.events.length - 1] as LabLifecycleEventV1;
    return {
      run_id: this.runId,
      state: this.state,
      sequence: this.events.length,
      lifecycle_head_hash: this.headHash ?? (`sha256:${"0".repeat(64)}` as Hash),
      updated_at: last.occurred_at,
    };
  }
}

/**
 * Verifies a complete genesis-to-head lifecycle stream without any run state.
 * Used by `erl2 verify-record` and the offline bundle verifier.
 */
export function verifyLifecycleChain(events: readonly LabLifecycleEventV1[]): Hash {
  if (events.length === 0) {
    throw new Erl2Error(CODES.VERIFY_RECORD_LIFECYCLE_GAP, "empty lifecycle stream");
  }
  let head: Hash | undefined;
  let state = "created";
  for (const [index, event] of events.entries()) {
    if (event.sequence !== index) {
      throw new Erl2Error(CODES.VERIFY_RECORD_LIFECYCLE_GAP, `lifecycle sequence gap at ${String(index)}`);
    }
    if (event.prior_event_hash !== head) {
      throw new Erl2Error(CODES.VERIFY_RECORD_LIFECYCLE_GAP, `lifecycle fork at sequence ${String(index)}`);
    }
    if (event.state_from !== state) {
      throw new Erl2Error(CODES.VERIFY_RECORD_LIFECYCLE_GAP, `lifecycle state discontinuity at ${String(index)}`);
    }
    if (coreHash(event) !== event.core_hash) {
      throw new Erl2Error(CODES.ARTIFACT_HASH_MISMATCH, `lifecycle event ${String(index)} was mutated`);
    }
    head = event.core_hash;
    state = event.state_to;
  }
  return head as Hash;
}
