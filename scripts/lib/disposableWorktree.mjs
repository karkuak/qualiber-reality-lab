/**
 * The disposable tree a negative-control campaign mutates, and the proof that it
 * left nothing behind.
 *
 * Extracted from `scripts/negative-control.mjs` so the three things that only
 * happen when something goes wrong — restoration after a failed control, cleanup
 * after `SIGINT`, cleanup after `SIGTERM` — can be driven by a test against a
 * throwaway repository instead of being asserted by reading the code. The
 * independent review found the signal case by killing a campaign by hand; a
 * property discovered that way should not stay discoverable only that way.
 *
 * Nothing here knows what a control is. It creates a worktree, restores it from
 * the object store, proves the restoration took, and releases everything exactly
 * once.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** Run git in `cwd` and return its trimmed stdout. */
export function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/**
 * A digest of every tracked file, so "the tree is unchanged" is checkable.
 *
 * Tracked files only: the build writes `dist/` and `npm install` writes
 * `node_modules/`, both ignored, and neither is evidence about the source the
 * campaign measured.
 */
export function treeDigest(repoRoot) {
  const status = git(["status", "--porcelain"], repoRoot);
  const files = git(["ls-files"], repoRoot).split("\n").filter(Boolean);
  const hash = createHash("sha256");
  for (const file of files.sort()) {
    hash.update(file);
    hash.update("\0");
    try {
      hash.update(readFileSync(path.join(repoRoot, file)));
    } catch {
      hash.update("<unreadable>");
    }
  }
  return { digest: hash.digest("hex"), status };
}

/**
 * Whether the measured tree is byte-identical to how the campaign found it.
 *
 * Pure, and separate from {@link treeDigest}, so the refusal can be tested
 * without arranging a real mutation of a real repository.
 */
export function certifyTreeUnchanged(before, after) {
  if (before.digest !== after.digest) {
    return { certified: false, reason: "tracked-file digest changed", before: before.digest, after: after.digest };
  }
  if (before.status !== after.status) {
    return { certified: false, reason: "git status changed", before: before.status, after: after.status };
  }
  return { certified: true };
}

/**
 * Check out `commit` into a fresh temp directory and hand back the handles a
 * campaign needs.
 *
 * `release` is idempotent and safe to call from a signal handler and from a
 * `finally` in the same run — which is exactly how it is used, so that a normal
 * exit and an interrupted one release the same things.
 */
export function createDisposableWorktree(options) {
  const { repoRoot, commit = "HEAD", prefix = "erl2-negative-control-" } = options;
  const worktreeRoot = mkdtempSync(path.join(tmpdir(), prefix));
  const worktree = path.join(worktreeRoot, "tree");
  git(["worktree", "add", "--detach", worktree, commit], repoRoot);

  let released = false;
  function release() {
    if (released) return;
    released = true;
    try {
      git(["worktree", "remove", "--force", worktree], repoRoot);
    } catch {
      /* the prune below covers a worktree that was already gone */
    }
    try {
      git(["worktree", "prune"], repoRoot);
    } catch {
      /* a prune failure must not mask the original cause */
    }
    rmSync(worktreeRoot, { recursive: true, force: true });
  }

  /**
   * Restore from the object store and prove it took.
   *
   * `git checkout -- .` restores tracked files from an immutable original. What
   * it does not do is *say* whether it worked, and a campaign that continues over
   * a half-restored tree measures the previous control as much as the current
   * one. So the residual status is returned, and a caller that gets one must
   * stop rather than contaminate every control after it.
   */
  function restore() {
    git(["checkout", "--", "."], worktree);
    const residual = git(["status", "--porcelain"], worktree);
    return residual === "" ? undefined : residual;
  }

  /**
   * Release on `SIGINT`/`SIGTERM`/`SIGHUP`, then re-raise with the default
   * disposition so the exit status stays the signal's own — a caller
   * distinguishing "interrupted" from "failed" must still be able to.
   *
   * `SIGKILL` remains uncatchable by construction; the next campaign still starts
   * cleanly, because `worktree add` into a fresh `mkdtemp` path never collides
   * and `release`'s `prune` removes the stale registration.
   */
  function installSignalHandlers(onSignal) {
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
      process.once(signal, () => {
        onSignal?.(signal);
        release();
        process.kill(process.pid, signal);
      });
    }
  }

  return { worktree, worktreeRoot, release, restore, installSignalHandlers };
}

/**
 * What a released worktree must leave behind, which is nothing.
 *
 * Returns the list of things that survived; empty means clean.
 */
export function worktreeResidue({ repoRoot, worktree, worktreeRoot }) {
  const residue = [];
  if (existsSync(worktreeRoot)) residue.push(`the temp directory ${worktreeRoot} still exists`);
  let registered = "";
  try {
    registered = git(["worktree", "list"], repoRoot);
  } catch {
    residue.push("`git worktree list` could not be read");
    return residue;
  }
  if (registered.includes(worktree)) residue.push(`git still lists the worktree ${worktree}`);
  return residue;
}

/** Convenience for a temp root that is not a worktree, used by the tests. */
export function makeTempDir(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix));
}
