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

/**
 * One ownership set: a directory, plus the exact sibling paths a production
 * default derives from it.
 *
 * `companions` is always a list of **exact absolute paths registered at creation
 * time**. There is no globbing and no prefix rule anywhere in this module: a
 * cleanup that removed `${root}*` would, the first time a fixture named a root
 * that is a prefix of another, delete a directory it does not own.
 */
interface Ownership {
  readonly root: string;
  readonly companions: readonly string[];
}

/** Every ownership set this process holds, in creation order. */
const owned: Ownership[] = [];

function removePath(target: string): void {
  try {
    rmSync(target, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // Cleanup never speaks over the result of the test that owned it.
  }
}

function removeOwnership(entry: Ownership): void {
  // Companions first, root last. A companion is allowed not to exist — a run
  // that never reached the environment branch derives no substrate — and `force`
  // makes its absence a no-op rather than an error.
  for (const companion of entry.companions) removePath(companion);
  removePath(entry.root);
}

function removeOwned(): void {
  // Drained rather than iterated, so the `exit` fallback after a completed
  // `after` hook is a no-op instead of a second removal pass.
  while (owned.length > 0) removeOwnership(owned.pop() as Ownership);
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
  owned.push({ root: dir, companions: [] });
  return dir;
}

/**
 * The exact sibling paths `resolveLocators` derives from a run root when the
 * caller supplies neither `--substrate-root` nor `--reservation-root`.
 *
 * Mirrored from `packages/cli/src/environmentCommands.ts:330-331`:
 *
 *     substrateRoot   = suppliedSubstrate   ?? `${runRoot}.substrate`
 *     reservationRoot = suppliedReservation ?? `${runRoot}.reservations`
 *
 * Duplicated deliberately rather than imported: the alternative was to pass
 * explicit substrate and reservation roots *inside* the run root at every
 * support call site, which would have stopped the suites exercising the
 * production **default** locator path — the thing several of them exist to
 * test. The companions are documented and pinned by
 * `TMP-RUNROOT: the companion names still match the production defaults`, so a
 * change to either side fails a test rather than resuming the leak.
 */
export function runRootCompanions(runRoot: string): readonly string[] {
  return [`${runRoot}.substrate`, `${runRoot}.reservations`];
}

/**
 * A temporary directory that will be handed to the CLI as `--run-root`.
 *
 * Identical to `ownedTempDir` except that the ownership set also carries the two
 * companions above. Removing the run root cannot remove them — they are
 * siblings, not children — which is why a package that owned only the root left
 * 387 of them behind across one gate run.
 *
 * Use this **only** where the root really is passed to the CLI as `--run-root`.
 * An adapter workspace, an artifact store, a governor registry and a selection
 * fixture root are not run roots, derive no companions, and stay ordinary
 * `ownedTempDir` values.
 */
export function ownedRunRoot(prefix: string): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  owned.push({ root, companions: runRootCompanions(root) });
  return root;
}

/**
 * Remove one owned directory now, ahead of the end of the file.
 *
 * Removes the **whole ownership set** — the root and every companion registered
 * with it — so an early release and the end-of-file sweep cannot disagree about
 * what "this directory" meant.
 *
 * For a fixture that knows it is finished, and only for a root created here.
 */
export function releaseTempDir(dir: string): void {
  const at = owned.findIndex((entry) => entry.root === dir);
  if (at < 0) {
    // Not ours. Removing it anyway would make this helper a general-purpose
    // delete, which is exactly the blast radius the module is meant not to have.
    return;
  }
  const [entry] = owned.splice(at, 1);
  removeOwnership(entry as Ownership);
}

/** How many ownership sets this process still holds. Exposed for the cleanup tests. */
export function ownedTempDirCount(): number {
  return owned.length;
}
