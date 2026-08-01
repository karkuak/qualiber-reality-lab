/**
 * The named durability boundaries a crash can be injected at
 * (ADR-ERL2-028 §7).
 *
 * ## Why this exists
 *
 * ADR-ERL2-024 §9 named five injection points and the matrix that measured them
 * — `tests/e2e/mutationIntentCrashMatrix.test.ts` — injected them by **throwing
 * an exception and continuing in the same process**, constructing a second
 * `EnvironmentRun` over the same run root. That proves reconciliation logic. It
 * does not prove crash recovery, for three reasons:
 *
 *  1. a thrown error unwinds. `finally` blocks run, the run lease is released,
 *     buffers flush. A killed process does none of that, and the difference is
 *     exactly what a crash *is*;
 *  2. the invocation counters lived in the same process's memory, so a genuinely
 *     dead process would have taken the evidence with it — which means the
 *     measurement could only ever be taken in a way that made the crash fake;
 *  3. the resumed composition was built in the surviving process, so anything
 *     cached in module state, in the clock, or in the intent journal's own
 *     `reconciled` set carried across a boundary a real restart would have reset.
 *
 * The review's own P3 finding was blunter: "the published crash-resumability
 * claim is unbacked: the test cited as its evidence injects no crash".
 *
 * ## What a barrier does
 *
 * `SIGKILL` to the current process, which cannot be caught, blocked or ignored.
 * Every durable write in this codebase is synchronous (`writeFileSync`,
 * `renameSync`, `openSync`/`writeSync`), so the bytes that reached the filesystem
 * before the barrier are exactly the bytes a real crash at that instant would
 * have left, and nothing after it runs.
 *
 * ## Why it is injected and not read from the environment
 *
 * Core reads no environment variable — `tests/architecture` enforces that, and it
 * is the property that keeps a production code path from having a test-only mode
 * hidden inside it. The barrier arrives as an optional callback from the
 * composition root, which is the CLI, which gates it behind the explicit
 * development profile exactly as it gates `--fake-driver-fault`. Absent, every
 * call site is a no-op function call.
 */

/**
 * The eight boundaries, in the order a successful operation passes them.
 *
 * The names are the durable states of ADR-ERL2-024 §4.3's ordering
 * (`declare -> dispatch-marked -> call -> outcome -> freeze -> append -> settle`),
 * with a boundary either side of each externally visible transition.
 *
 * Two caveats, recorded here rather than left for a reader to discover:
 *
 *  - `after_intent_freeze` and `before_external_dispatch` are *distinct durable
 *    states* in this implementation, because the journal writes `declared` and
 *    then advances to `dispatching` — two separate temp-then-rename writes.
 *  - `after_receipt_freeze` and `before_lifecycle_append` denote the same instant
 *    for an operation that freezes exactly one artifact before its event. They
 *    are still both exercised, and both must produce the same outcome; a matrix
 *    that quietly dropped one would not say which of the two it had checked.
 */
export const CRASH_BOUNDARIES = [
  "before_intent_freeze",
  "after_intent_freeze",
  "before_external_dispatch",
  "after_external_dispatch",
  "before_receipt_freeze",
  "after_receipt_freeze",
  "before_lifecycle_append",
  "after_lifecycle_append",
] as const;

export type CrashBoundary = (typeof CRASH_BOUNDARIES)[number];

export function isCrashBoundary(value: string): value is CrashBoundary {
  return (CRASH_BOUNDARIES as readonly string[]).includes(value);
}

/**
 * Called at each boundary with the operation it belongs to.
 *
 * An implementation that returns is a no-op; an implementation that ends the
 * process is a crash. Nothing in core inspects the return value, so a barrier
 * cannot alter behaviour except by not returning.
 */
export type CrashBarrier = (boundary: CrashBoundary, operationId: string) => void;

/** The barrier used when none is injected: every boundary passes through. */
export const NO_CRASH: CrashBarrier = () => {
  /* production default: there is no crash seam on the release surface */
};
