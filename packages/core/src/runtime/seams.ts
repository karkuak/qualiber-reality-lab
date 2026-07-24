/**
 * Injected clock, randomness, identity and process seams.
 *
 * Implementation-plan rule 13: no core calculation reads an ambient value.
 * Every non-deterministic input arrives through one of these interfaces so a
 * run can be replayed exactly and crash injection can be scripted.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Instant } from "@erl2/contracts";

export interface Clock {
  /** UTC RFC 3339 with second precision, as every contract requires. */
  now(): Instant;
  /** Monotonic milliseconds, used only for durations, never for identity. */
  monotonicMs(): number;
}

export interface RandomSource {
  bytes(count: number): Buffer;
  uuidV7(): string;
}

export interface Seams {
  readonly clock: Clock;
  readonly random: RandomSource;
}

export class SystemClock implements Clock {
  now(): Instant {
    return new Date().toISOString().replace(/\.\d{3}Z$/, "Z") as Instant;
  }
  monotonicMs(): number {
    return Math.round(performance.now());
  }
}

/** Deterministic clock that advances by a fixed step on each read. */
export class SteppingClock implements Clock {
  private current: number;
  private readonly stepMs: number;

  constructor(startIso: string, stepMs = 1000) {
    this.current = Date.parse(startIso);
    this.stepMs = stepMs;
  }

  now(): Instant {
    const value = new Date(this.current).toISOString().replace(/\.\d{3}Z$/, "Z") as Instant;
    this.current += this.stepMs;
    return value;
  }

  monotonicMs(): number {
    return this.current;
  }

  /** Reads the current instant without advancing. */
  peek(): Instant {
    return new Date(this.current).toISOString().replace(/\.\d{3}Z$/, "Z") as Instant;
  }
}

export class SystemRandom implements RandomSource {
  bytes(count: number): Buffer {
    return randomBytes(count);
  }
  uuidV7(): string {
    return uuidV7From(Date.now(), randomBytes(10));
  }
}

/** Deterministic randomness for fixtures. Never used for held-out selection. */
export class SeededRandom implements RandomSource {
  private counter = 0;
  private readonly seed: string;

  constructor(seed: string) {
    this.seed = seed;
  }

  bytes(count: number): Buffer {
    const out = Buffer.alloc(count);
    let written = 0;
    while (written < count) {
      const block = blake(`${this.seed}:${String(this.counter)}`);
      this.counter += 1;
      const take = Math.min(block.length, count - written);
      block.copy(out, written, 0, take);
      written += take;
    }
    return out;
  }

  uuidV7(): string {
    const ms = 1_800_000_000_000 + this.counter * 1000;
    return uuidV7From(ms, this.bytes(10));
  }
}

function blake(input: string): Buffer {
  // SHA-256 used purely as a deterministic byte stream for fixtures.
  return createHash("sha256").update(input, "utf8").digest();
}

export function uuidV7From(unixMs: number, entropy: Buffer): string {
  const bytes = Buffer.alloc(16);
  bytes.writeUIntBE(unixMs, 0, 6);
  entropy.copy(bytes, 6, 0, 10);
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function newRunId(): string {
  const raw = randomUUID().replace(/-/g, "");
  return uuidV7From(Date.now(), Buffer.from(raw.slice(0, 20), "hex"));
}
