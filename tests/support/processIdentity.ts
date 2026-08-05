/**
 * Process *identity*, for the one test that has to ask "is the process I started
 * still running?" after something else was supposed to have killed it.
 *
 * ## Why a bare pid is not an answer
 *
 * `process.kill(pid, 0)` asks whether *a* process holds that number. It does not
 * ask whether it is the process you meant. A pid is a small recycled integer —
 * macOS wraps at 99999 and a full `npm test` spawns thousands of processes — so
 * between recording a pid and asking about it, an unrelated process can have
 * been assigned it. Two things then go wrong, and `NC-PROCTREE` hit both:
 *
 *  - the **assertion** reads "still alive" for a process that died correctly,
 *    turning a healthy publication gate red at random; and
 *  - the **cleanup** sends `SIGKILL` to that number, which is no longer a
 *    tidy-up of the test's own leftovers but a signal to a stranger.
 *
 * The production harness never had this problem: it reconciles on the process
 * *group* (`kill(-pid, 0)` in `scripts/negative-control.mjs`), and for a
 * recycled pid to answer that, the new process would have to be a group leader
 * of the same group. The test was simply asking a weaker question than the code
 * it was measuring. This module closes that gap.
 *
 * ## What identity is here
 *
 * A pid, plus two facts about the process holding it that a later process
 * cannot inherit by reusing the number: the moment it started, and the command
 * it is running. Both come from one `ps` query, which is the only portable place
 * macOS and Linux both publish them.
 *
 * `lstart` is deliberate. `etime` is elapsed time, which changes on every read
 * and so can never be compared against a recorded value; `start` abbreviates to
 * a date once a process is a day old and stops distinguishing anything. `lstart`
 * is an absolute wall-clock instant in a fixed five-token shape on both
 * platforms — `Wed Aug  5 08:49:30 2026` — so it is both stable and comparable.
 *
 * ## Fail closed
 *
 * Every way of *not* establishing identity means the same thing to the caller:
 * the captured process is not running. `ps` refusing, `ps` printing nothing,
 * output that does not parse, a start that differs, a command that differs — all
 * of them answer "no". The failure a fail-open would cause is the one that
 * matters: signalling, or asserting about, a process that is not ours.
 *
 * Deliberately not a process-management abstraction. It captures, it compares,
 * and it signals only what it can still identify. `NC-PROCTREE` is its only
 * caller.
 */
import { execFileSync } from "node:child_process";

/**
 * A process, identified well enough that a recycled pid cannot impersonate it.
 *
 * Serialisable on purpose: the probe captures this in one process and the
 * assertions read it back in another, through the probe's `pids.json`.
 */
export interface ProcessIdentity {
  readonly pid: number;
  /** `ps -o lstart`, whitespace-normalised: `Wed Aug  5 08:49:30 2026`. */
  readonly startedAt: string;
  /** `ps -o command`, whitespace-normalised and untruncated. */
  readonly command: string;
}

/**
 * The `ps` fields, for one pid, with nothing the environment can vary.
 *
 * `-ww` because macOS `ps` truncates the command to the terminal width by
 * default: a command captured from a child process and re-read from the test
 * runner would then differ for no reason but where it was read. `LC_ALL=C`
 * because `lstart` names a weekday and a month, and a comparison must not
 * depend on the locale being the same both times.
 */
function queryProcess(pid: number): string | undefined {
  try {
    return execFileSync("ps", ["-ww", "-o", "lstart=,command=", "-p", String(pid)], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    // A non-zero exit is how `ps` reports "no such process", which is the
    // commonest case here and not an error worth distinguishing from the rest.
    return undefined;
  }
}

/**
 * Parses one `ps -o lstart=,command=` line into an identity, or `undefined`.
 *
 * Separated from the query so the malformed cases are reachable from a test
 * without having to manufacture a process that produces them.
 *
 * `lstart` is exactly five whitespace-separated tokens on both platforms, so the
 * split point is fixed and the remainder is the command. Anything that does not
 * have those five tokens *and* a non-empty command establishes no identity.
 */
export function parseProcessIdentity(pid: number, raw: string | undefined): ProcessIdentity | undefined {
  if (raw === undefined) return undefined;
  const lines = raw.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  // Exactly one process was asked about, so exactly one line is an answer. Zero
  // means it is gone; more than one means this is not the output we think it is.
  if (lines.length !== 1) return undefined;
  const tokens = (lines[0] as string).split(/\s+/);
  if (tokens.length < 6) return undefined;
  const startedAt = tokens.slice(0, 5).join(" ");
  const command = tokens.slice(5).join(" ");
  if (command.length === 0) return undefined;
  return { pid, startedAt, command };
}

/**
 * This process's identity as the OS currently reports it, or `undefined` when
 * it cannot be established.
 *
 * Call it while the process is known to be alive. A captured identity is a
 * *record*: it stays true about what was running, which is exactly what makes it
 * comparable later.
 */
export function captureProcessIdentity(pid: number): ProcessIdentity | undefined {
  return parseProcessIdentity(pid, queryProcess(pid));
}

/**
 * Whether the process that was captured is the process running under that pid
 * now.
 *
 * `false` for a pid nobody holds, for a pid `ps` will not answer about, and for
 * a pid now held by a different process — the last being the case a bare
 * `process.kill(pid, 0)` gets wrong.
 */
export function capturedProcessIsRunning(identity: ProcessIdentity): boolean {
  const current = captureProcessIdentity(identity.pid);
  if (current === undefined) return false;
  return current.startedAt === identity.startedAt && current.command === identity.command;
}

/**
 * `SIGKILL`, but only to the process that was captured.
 *
 * The cleanup this replaces signalled a recorded number unconditionally. On a
 * recycled pid that is a signal to an unrelated process, sent from a `finally`
 * block on the failure path — where it is least likely to be noticed.
 *
 * The identity is re-checked immediately before the signal. That window cannot
 * be closed from user space without a pidfd, and it is not the risk being
 * managed: the recorded identity is seconds old by the time cleanup runs,
 * whereas this check is microseconds old.
 *
 * @returns `signalled` when the captured process was still there and was killed,
 *   `gone` when it was not — including when the pid now belongs to someone else.
 */
export function killCapturedProcess(identity: ProcessIdentity): "signalled" | "gone" {
  if (!capturedProcessIsRunning(identity)) return "gone";
  try {
    process.kill(identity.pid, "SIGKILL");
    return "signalled";
  } catch {
    // It exited between the check and the signal, which is the outcome wanted.
    return "gone";
  }
}
