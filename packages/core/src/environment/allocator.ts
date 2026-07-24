/**
 * Global reservation allocator (design v2 §22).
 *
 * It stores **reservation leases only** — never resource state. Two concurrent
 * runs cannot reserve the same network, volume, port, tenant or project name,
 * and a lease from a crashed run is reclaimable once it expires, so a dead run
 * cannot deadlock the substrate forever.
 *
 * Leases are files under one directory, published with the same
 * create-or-fail semantics as the artifact store, so acquisition is atomic
 * across processes rather than merely across async tasks.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import {
  assertContract,
  CODES,
  Erl2Error,
  type EnvironmentReservationLeaseV1,
} from "@erl2/contracts";
import { coreHash, jcsBytes } from "@erl2/integrity";
import type { Clock } from "../runtime/seams.js";

export type ReservationKind = EnvironmentReservationLeaseV1["reservation_kind"];

export interface ReclaimedLease {
  readonly lease: EnvironmentReservationLeaseV1;
  readonly reason: "expired";
}

export class ReservationAllocator {
  private readonly root: string;
  private readonly clock: Clock;
  private readonly ttlMs: number;

  constructor(options: { readonly root: string; readonly clock: Clock; readonly ttlMs?: number }) {
    this.root = path.resolve(options.root);
    this.clock = options.clock;
    this.ttlMs = options.ttlMs ?? 3_600_000;
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }

  private leasePath(kind: ReservationKind, value: string): string {
    // The value is hashed into the file name so an attacker-controlled
    // reservation string can never escape the lease directory.
    const safe = Buffer.from(`${kind}:${value}`, "utf8").toString("base64url");
    return path.join(this.root, `${safe}.lease.json`);
  }

  /**
   * Acquires a reservation, reclaiming an expired lease first.  A live lease
   * held by another run is a hard conflict, not a wait.
   */
  acquire(options: {
    readonly runId: string;
    readonly kind: ReservationKind;
    readonly value: string;
    readonly leaseId: string;
  }): EnvironmentReservationLeaseV1 {
    const file = this.leasePath(options.kind, options.value);
    const now = this.clock.now();

    if (existsSync(file)) {
      const existing = this.read(file);
      if (existing.run_id === options.runId) return existing;
      if (Date.parse(existing.expires_at) > Date.parse(now)) {
        throw new Erl2Error(
          CODES.ENV_RESERVATION_CONFLICT,
          `${options.kind} reservation ${options.value} is held by another live run`,
        );
      }
      // Stale lease from a crashed run: reclaim it explicitly.
      unlinkSync(file);
    }

    const base = {
      schema_version: "environment-reservation-lease/v1" as const,
      lease_id: options.leaseId,
      run_id: options.runId,
      reservation_kind: options.kind,
      reserved_value: options.value,
      acquired_at: now,
      expires_at: new Date(Date.parse(now) + this.ttlMs)
        .toISOString()
        .replace(/\.\d{3}Z$/, "Z"),
    };
    const lease = assertContract<EnvironmentReservationLeaseV1>(
      "EnvironmentReservationLeaseV1",
      { ...base, core_hash: coreHash(base) },
    );

    let fd: number;
    try {
      fd = openSync(file, "wx", 0o600);
    } catch (cause) {
      throw new Erl2Error(
        CODES.ENV_RESERVATION_CONFLICT,
        `${options.kind} reservation ${options.value} was taken concurrently`,
        { cause },
      );
    }
    try {
      writeSync(fd, `${jcsBytes(lease).toString("utf8")}\n`);
    } finally {
      closeSync(fd);
    }
    return lease;
  }

  /** Releases a lease this run holds; releasing another run's lease is refused. */
  release(runId: string, kind: ReservationKind, value: string): void {
    const file = this.leasePath(kind, value);
    if (!existsSync(file)) return;
    const lease = this.read(file);
    if (lease.run_id !== runId) {
      throw new Erl2Error(
        CODES.ENV_RESERVATION_CONFLICT,
        `run ${runId} may not release a lease held by ${lease.run_id}`,
      );
    }
    unlinkSync(file);
  }

  /** Reclaims every expired lease and reports what was reclaimed. */
  reclaimExpired(): readonly ReclaimedLease[] {
    const now = Date.parse(this.clock.now());
    const reclaimed: ReclaimedLease[] = [];
    for (const name of readdirSync(this.root).sort()) {
      if (!name.endsWith(".lease.json")) continue;
      const file = path.join(this.root, name);
      const lease = this.read(file);
      if (Date.parse(lease.expires_at) <= now) {
        unlinkSync(file);
        reclaimed.push({ lease, reason: "expired" });
      }
    }
    return reclaimed;
  }

  held(runId: string): readonly EnvironmentReservationLeaseV1[] {
    return readdirSync(this.root)
      .filter((n) => n.endsWith(".lease.json"))
      .sort()
      .map((n) => this.read(path.join(this.root, n)))
      .filter((l) => l.run_id === runId);
  }

  private read(file: string): EnvironmentReservationLeaseV1 {
    return assertContract<EnvironmentReservationLeaseV1>(
      "EnvironmentReservationLeaseV1",
      JSON.parse(readFileSync(file, "utf8")) as unknown,
    );
  }
}
