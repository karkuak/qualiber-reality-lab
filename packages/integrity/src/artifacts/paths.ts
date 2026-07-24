/**
 * Logical path confinement (design v2 §14, ERL2-SEC-004).
 *
 * A logical path is NFC, slash-relative and root-contained.  Resolution walks
 * component by component and `lstat`s each one, so a symlink, hard link to an
 * outside inode, device, FIFO or socket is rejected before any read or write.
 */

import { lstatSync, mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { CODES, Erl2Error } from "@erl2/contracts";

const FORBIDDEN_COMPONENTS = new Set([".", "..", ""]);
const WINDOWS_RESERVED =
  /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

export interface ConfinedPathOptions {
  /**
   * Reject a component whose case-folded form already exists with different
   * casing.  Default true; case collisions on case-insensitive filesystems
   * would otherwise let two logical paths address one file.
   */
  readonly rejectCaseCollision?: boolean;
}

/** Validates the *shape* of a logical path without touching the filesystem. */
export function assertLogicalPath(logicalPath: string): void {
  if (logicalPath.length === 0 || logicalPath.length > 512) {
    throw new Erl2Error(CODES.PATH_INVALID_COMPONENT, "logical path length out of bounds");
  }
  if (logicalPath.normalize("NFC") !== logicalPath) {
    throw new Erl2Error(CODES.PATH_INVALID_COMPONENT, "logical path is not NFC");
  }
  if (logicalPath.includes("\0")) {
    throw new Erl2Error(CODES.PATH_INVALID_COMPONENT, "logical path contains NUL");
  }
  if (logicalPath.includes("\\")) {
    throw new Erl2Error(CODES.PATH_INVALID_COMPONENT, "logical path contains a backslash");
  }
  if (logicalPath.startsWith("/")) {
    throw new Erl2Error(CODES.PATH_ESCAPES_ROOT, "logical path must be root-relative");
  }
  if (/^[A-Za-z]:/.test(logicalPath)) {
    throw new Erl2Error(CODES.PATH_ESCAPES_ROOT, "logical path contains a drive letter");
  }
  const components = logicalPath.split("/");
  for (const component of components) {
    if (FORBIDDEN_COMPONENTS.has(component)) {
      throw new Erl2Error(
        component === ".." ? CODES.PATH_ESCAPES_ROOT : CODES.PATH_INVALID_COMPONENT,
        `forbidden path component: ${JSON.stringify(component)}`,
      );
    }
    if (WINDOWS_RESERVED.test(component)) {
      throw new Erl2Error(CODES.PATH_INVALID_COMPONENT, `reserved device name: ${component}`);
    }
    for (const ch of component) {
      const code = ch.codePointAt(0) ?? 0;
      if (code < 0x20 || code === 0x7f) {
        throw new Erl2Error(CODES.PATH_INVALID_COMPONENT, "control character in path component");
      }
    }
  }
}

function assertNotSpecial(absolute: string): void {
  const st = lstatSync(absolute);
  if (st.isSymbolicLink()) {
    throw new Erl2Error(CODES.PATH_SYMLINK_REJECTED, `symlink rejected: ${absolute}`);
  }
  if (st.isFile()) {
    if (st.nlink > 1) {
      throw new Erl2Error(
        CODES.PATH_NOT_REGULAR_FILE,
        `hard-linked file rejected (nlink=${String(st.nlink)})`,
      );
    }
    return;
  }
  if (st.isDirectory()) return;
  throw new Erl2Error(CODES.PATH_NOT_REGULAR_FILE, `special filesystem entry rejected: ${absolute}`);
}

function assertNoCaseCollision(dir: string, component: string): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  const folded = component.toLowerCase();
  for (const entry of entries) {
    if (entry !== component && entry.toLowerCase() === folded) {
      throw new Erl2Error(
        CODES.PATH_CASE_COLLISION,
        `case-colliding entry already exists: ${entry}`,
      );
    }
  }
}

/**
 * Resolves `logicalPath` beneath `root`, rejecting traversal, symlink escape,
 * hard-link substitution, case collision and special files.  Existing
 * components are checked; missing components are permitted so the caller can
 * create them.
 */
export function resolveConfined(
  root: string,
  logicalPath: string,
  options: ConfinedPathOptions = {},
): string {
  assertLogicalPath(logicalPath);
  const rejectCaseCollision = options.rejectCaseCollision ?? true;
  const absoluteRoot = path.resolve(root);
  const rootStat = statSync(absoluteRoot);
  if (!rootStat.isDirectory()) {
    throw new Erl2Error(CODES.PATH_NOT_REGULAR_FILE, "artifact root is not a directory");
  }

  let current = absoluteRoot;
  const components = logicalPath.split("/");
  for (const [index, component] of components.entries()) {
    const next = path.join(current, component);
    if (!next.startsWith(absoluteRoot + path.sep)) {
      throw new Erl2Error(CODES.PATH_ESCAPES_ROOT, "resolved path escapes the artifact root");
    }
    let exists = true;
    try {
      lstatSync(next);
    } catch {
      exists = false;
    }
    if (exists) {
      assertNotSpecial(next);
      const isLast = index === components.length - 1;
      if (!isLast) {
        const st = lstatSync(next);
        if (!st.isDirectory()) {
          throw new Erl2Error(CODES.PATH_INVALID_COMPONENT, "intermediate component is not a directory");
        }
      }
    } else if (rejectCaseCollision) {
      assertNoCaseCollision(current, component);
    }
    current = next;
  }
  return current;
}

/** Creates the parent directory chain of a confined path with mode 0700. */
export function ensureConfinedParent(root: string, logicalPath: string): string {
  const absolute = resolveConfined(root, logicalPath);
  mkdirSync(path.dirname(absolute), { recursive: true, mode: 0o700 });
  return absolute;
}
