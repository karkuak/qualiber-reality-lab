/**
 * Durable, cross-process run lease (design v2 §20, review P1-2 §7.2).
 *
 * The in-process lease on `LifecycleLog` cannot protect a run across separate
 * `erl2` invocations — each CLI command is a fresh process.  A concurrent or
 * replayed command must not mutate a run another command is already mutating,
 * and a crash mid-command must not wedge the run forever.
 *
 * This lease is a single JSON file under the run's `state/` directory, created
 * atomically with `O_EXCL`.  A live lease held by another owner is a Lab-owned
 * conflict.  A lease older than its TTL is stale and may be recovered (stolen)
 * by the next command — the bounded-recovery policy §7.2 requires — so a crash
 * cannot permanently lock the run.  A different owner may never release an
 * active lease.
 */
import { mkdirSync, openSync, closeSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import { CODES, Erl2Error } from "@erl2/contracts";

const LEASE_PATH = "state/lease.json";

/** How long a lease is honoured before it is considered stale and recoverable. */
export const LEASE_TTL_MS = 300_000; // 5 minutes; a command that runs longer re-heartbeats.

interface LeaseRecord {
  readonly owner: string;
  readonly command: string;
  readonly acquired_at_ms: number;
  readonly expires_at_ms: number;
  readonly pid: number;
}

export class RunLease {
  private released = false;
  private readonly absolutePath: string;
  private readonly owner: string;

  private constructor(absolutePath: string, owner: string) {
    this.absolutePath = absolutePath;
    this.owner = owner;
  }

  /**
   * Acquires the run lease, or throws a Lab-owned conflict if another live
   * command holds it.  `nowMs` is injected so tests can drive expiry
   * deterministically; the CLI passes wall-clock time.
   */
  static acquire(
    runRoot: string,
    owner: string,
    command: string,
    nowMs: number,
    ttlMs: number = LEASE_TTL_MS,
  ): RunLease {
    const stateDir = path.join(runRoot, "state");
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const absolutePath = path.join(runRoot, LEASE_PATH);
    const record: LeaseRecord = {
      owner,
      command,
      acquired_at_ms: nowMs,
      expires_at_ms: nowMs + ttlMs,
      pid: process.pid,
    };
    const body = `${JSON.stringify(record)}\n`;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const fd = openSync(absolutePath, "wx", 0o600); // atomic create-if-absent.
        try {
          writeFileSync(fd, body);
        } finally {
          closeSync(fd);
        }
        return new RunLease(absolutePath, owner);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
        // A lease already exists: reacquire if ours, steal if stale, else refuse.
        const existing = RunLease.read(absolutePath);
        if (existing === undefined) {
          // Torn/unreadable lease file: treat as stale and reclaim.
          rmSync(absolutePath, { force: true });
          continue;
        }
        if (existing.owner === owner) {
          writeFileSync(absolutePath, body, { mode: 0o600 });
          return new RunLease(absolutePath, owner);
        }
        if (nowMs >= existing.expires_at_ms) {
          rmSync(absolutePath, { force: true });
          continue; // stale — retry the atomic create.
        }
        throw new Erl2Error(
          CODES.POLICY_RUN_LEASE_HELD,
          `run is locked by a live command (owner ${existing.owner}, command ${existing.command}); retry when it completes`,
          { owner: "lab" },
        );
      }
    }
    throw new Erl2Error(CODES.POLICY_RUN_LEASE_HELD, "run lease contended; could not acquire after recovery", {
      owner: "lab",
    });
  }

  private static read(absolutePath: string): LeaseRecord | undefined {
    try {
      const parsed = JSON.parse(readFileSync(absolutePath, "utf8")) as Partial<LeaseRecord>;
      if (typeof parsed.owner !== "string" || typeof parsed.expires_at_ms !== "number") return undefined;
      return parsed as LeaseRecord;
    } catch {
      return undefined;
    }
  }

  /** Releases the lease only if this owner still holds it; a foreign lease is left intact. */
  release(): void {
    if (this.released) return;
    this.released = true;
    if (!existsSync(this.absolutePath)) return;
    const current = RunLease.read(this.absolutePath);
    if (current !== undefined && current.owner !== this.owner) return; // never release a foreign lease.
    rmSync(this.absolutePath, { force: true });
  }
}
