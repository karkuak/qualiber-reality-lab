/**
 * Ownership and deterministic removal for the test-support layer's temporary
 * directories.
 *
 * ## What was wrong
 *
 * Every `mkdtempSync` in `tests/support` was created and abandoned. There was no
 * `after` hook, no `t.after` and no `rmSync` anywhere in the layer, so a single
 * `npm test` left several thousand `$TMPDIR/erl2-*` directories behind and a
 * developer machine accumulated them without bound. It is not an integrity or
 * claim defect — it is inode pressure, slow `$TMPDIR` enumeration, and on a
 * tmpfs-backed CI runner a plausible route to a confusing out-of-space failure
 * in the middle of a half-hour suite.
 *
 * ## The ownership model
 *
 * A directory obtained here is owned by the **test file's process**, not by the
 * individual test and not by the fixture that asked for it. `node --test` runs
 * each test file in its own process, so "the file finished" is a real boundary
 * with a real hook, and it is the last moment at which every fixture, every
 * `spawnSync` child and every assertion that reads those bytes is provably done.
 * Removing earlier would mean guessing when a shared fixture stopped being
 * shared — `buildGovernorRegistry()` hands its root to a CLI subprocess, and
 * `runToEnvironmentTerminal()` builds one run root that a dozen cases copy from.
 *
 * That gives two removal points and no more:
 *
 *   - a single root `after` hook, which is the deterministic one; and
 *   - a single `process.on("exit")` fallback, for the paths that never reach a
 *     normal end of run.
 *
 * **One** listener each, registered once at module load, for the whole process —
 * not one per directory. A per-directory listener would trade a directory leak
 * for a listener leak and start printing `MaxListenersExceededWarning` a few
 * hundred fixtures in.
 *
 * Removal is best-effort by construction: a temporary directory that will not
 * delete must never turn a green suite red, and `force` already absorbs the
 * common races.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

/** Every directory this process owns, in creation order. */
const owned: string[] = [];

function removeOwned(): void {
  // Drained rather than iterated, so the `exit` fallback after a completed
  // `after` hook is a no-op instead of a second removal pass.
  while (owned.length > 0) {
    const dir = owned.pop() as string;
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // Cleanup never speaks over the result of the test that owned it.
    }
  }
}

// Both removal points are installed at module load, and that timing is
// load-bearing rather than incidental.
//
// `node:test`'s `after` attaches to whatever test is *currently running*. This
// module is imported at the top of the support layer, which is imported at the
// top of a test file, so at this point nothing is running and the hook attaches
// to the root — where it belongs. Registering it lazily on first use instead
// looks equivalent and is not: several suites build one expensive fixture inside
// their first case and copy it in every later case, so a hook installed then
// binds to that first case and deletes the shared fixture the rest of the file
// depends on. That is a broken suite, not a cleanup.
//
// `node:test` is required rather than imported, and only when this process *is*
// a test-runner child, because loading it has a side effect: it arms the root
// test, which then prints a runner summary at exit. A support module that did
// that unconditionally would make every non-test importer of this layer emit a
// phantom `ℹ tests 0` report. `NODE_TEST_CONTEXT` is what `node --test` sets in
// the processes it spawns, so inside the runner the module is already loaded and
// requiring it costs nothing.
if (process.env["NODE_TEST_CONTEXT"] !== undefined) {
  try {
    const { after } = createRequire(import.meta.url)("node:test") as { after: (fn: () => void) => void };
    after(removeOwned);
  } catch {
    // No root suite to hang a hook on; the `exit` fallback still covers it.
  }
}

// The fallback, for a process that never reaches a normal end of run — a test
// file executed directly, or one that exits before the hook.
process.on("exit", removeOwned);

/**
 * A temporary directory owned by this test process and removed when it ends.
 *
 * `prefix` is the same `erl2-…-` prefix the call site used before, so the
 * directories remain identifiable while they exist.
 */
export function ownedTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  owned.push(dir);
  return dir;
}

/**
 * Remove one owned directory now, ahead of the end of the file.
 *
 * For a fixture that knows it is finished — a certification host whose run has
 * returned — and only for one it created here.
 */
export function releaseTempDir(dir: string): void {
  const at = owned.indexOf(dir);
  if (at >= 0) owned.splice(at, 1);
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // Same discipline as the bulk path.
  }
}

/** How many directories this process still owns. Exposed for the cleanup tests. */
export function ownedTempDirCount(): number {
  return owned.length;
}
