/**
 * Independent accounting of every *file* retained beneath the artifact root
 * (ERL2-FR-020 / ERL2-AC-023, design §14 step 6-7).
 *
 * `derivePreEnvironmentClosure` and its siblings fold `rejected_extra_hashes`
 * into the verdict, so a retained artifact the closure did not derive breaks
 * closure.  But that rule only ever sees artifacts the *index* produced, and
 * `ArtifactIndex.walk` silently skips any file it cannot index: a name that does
 * not end in `.json`, bytes that `parseStrictJson` refuses, a JSON array or
 * scalar, or an object without both `schema_version` and `core_hash`.  Every one
 * of those is an unaccounted retained byte-stream that the closure verdict never
 * observes — the same invariant P1-1 broke, reached through the skip path
 * instead of the index path.  Reproduced against the shipped CLI: a rogue
 * `.bin`, a rogue duplicate-key `.json`, a rogue `.json` without a `core_hash`
 * and a rogue JSON array each left `erl2 verify` reporting exit 0 / `valid`.
 *
 * This pass closes that hole by walking the retained subtree itself and
 * requiring every regular file to be *accounted for* by one of four rules:
 *
 *   1. it is an indexed JSON artifact (the closure's rejected-extra rule then
 *      governs whether its `core_hash` belongs to the terminal);
 *   2. it is the `.frozen` freeze marker of an accounted content file;
 *   3. its root-relative path is referenced by an `ArtifactRef` / logical byte
 *      descriptor carried by an indexed artifact (the referenced-bytes layer
 *      has already rehashed it);
 *   4. it is a content-addressed store file whose digest is declared as a
 *      `file_sha256` by an indexed artifact.
 *
 * Anything else — including a symlink, a device node or a stray directory entry
 * — is a rejected extra.  The check is offline, bounded by the retained subtree,
 * and never follows a link.
 */

import { lstatSync, readdirSync } from "node:fs";
import path from "node:path";
import { CODES, Erl2Error } from "@erl2/contracts";
import type { ArtifactIndex } from "./artifactIndex.js";
import { collectReferencedDescriptors } from "./referencedBytes.js";

/** A content-addressed store filename: `…/sha256/<64 lowercase hex>.<ext>`. */
const STORE_FILE = /(?:^|\/)sha256\/([0-9a-f]{64})\.[a-z0-9]+$/;

/** The freeze-marker suffix written beside a frozen content file. */
const MARKER_SUFFIX = ".frozen";

export interface RetainedAccountingReport {
  readonly filesChecked: number;
  readonly retainedRoot: string;
}

/** Collects every entry beneath `absolute`, refusing to follow symlinks. */
function walkRetained(absolute: string, relative: string, out: Map<string, "file" | "other">): void {
  let entries: string[];
  try {
    entries = readdirSync(absolute);
  } catch {
    return;
  }
  for (const name of entries.sort()) {
    const childAbs = path.join(absolute, name);
    const childRel = relative === "" ? name : `${relative}/${name}`;
    let info;
    try {
      info = lstatSync(childAbs);
    } catch {
      continue;
    }
    if (info.isSymbolicLink()) {
      // A symlink beneath the retained set is never accounted evidence: it can
      // point anywhere and its bytes are not the retained bytes.
      out.set(childRel, "other");
      continue;
    }
    if (info.isDirectory()) {
      walkRetained(childAbs, childRel, out);
      continue;
    }
    out.set(childRel, info.isFile() ? "file" : "other");
  }
}

/**
 * Refuses any file retained beneath the artifact root that the verifier cannot
 * account for.  Complements the closure's `rejected_extra_hashes` rule, which
 * only sees files the artifact index was able to parse.
 */
export function verifyRetainedFileAccounting(index: ArtifactIndex): RetainedAccountingReport {
  const root = index.root;
  const retainedRel = "retained";
  const retainedAbs = path.join(root, retainedRel);
  let info;
  try {
    info = lstatSync(retainedAbs);
  } catch {
    // No retained subtree: the closure derivation refuses the missing roles.
    return { filesChecked: 0, retainedRoot: retainedRel };
  }
  if (!info.isDirectory()) {
    throw new Erl2Error(
      CODES.PATH_NOT_REGULAR_FILE,
      `${retainedRel} beneath the artifact root is not a directory`,
    );
  }

  const entries = new Map<string, "file" | "other">();
  walkRetained(retainedAbs, retainedRel, entries);

  // Rule 3/4 inputs: every path and every declared payload digest an indexed
  // artifact references.
  const referencedPaths = new Set<string>();
  const referencedDigests = new Set<string>();
  for (const descriptor of collectReferencedDescriptors(index)) {
    referencedPaths.add(path.normalize(descriptor.declaredPath).split(path.sep).join("/"));
    referencedDigests.add(descriptor.fileSha256.toLowerCase());
  }

  const accounted = new Set<string>();
  for (const [relative, kind] of entries) {
    if (kind !== "file") continue;
    if (index.byLogicalPath(relative) !== undefined) {
      accounted.add(relative); // rule 1
      continue;
    }
    if (referencedPaths.has(relative)) {
      accounted.add(relative); // rule 3
      continue;
    }
    const store = STORE_FILE.exec(relative);
    if (store !== null && referencedDigests.has(`sha256:${store[1] as string}`)) {
      accounted.add(relative); // rule 4
      continue;
    }
  }
  // Rule 2, after the content files are known.
  for (const [relative, kind] of entries) {
    if (kind !== "file" || !relative.endsWith(MARKER_SUFFIX)) continue;
    const content = relative.slice(0, -MARKER_SUFFIX.length);
    if (accounted.has(content)) accounted.add(relative);
  }

  // Two retained files may not claim the same `core_hash`.  Rule 1 accounts a
  // file because it is *indexed*, and the closure's rejected-extra rule then
  // governs whether its hash belongs to the terminal — but that rule is
  // hash-keyed, so a byte-copy of a legitimate artifact satisfies both and adds
  // an unaccounted retained byte-stream for free.  Because signature fields are
  // excluded from `core_hash`, the copy may also differ from the original in
  // exactly the bytes that carry authority.  No shipped run retains the same
  // core hash twice beneath `retained/` (a step outcome's second copy lives
  // under `subject-output/`, outside this subtree).
  for (const [relative, kind] of entries) {
    if (accounted.has(relative)) continue;
    throw new Erl2Error(
      CODES.GRAPH_CLOSURE_EXTRA_ARTIFACT,
      kind === "file"
        ? `retained file ${relative} is not accounted for by any indexed artifact, freeze marker or referenced payload`
        : `retained entry ${relative} is not a regular file and cannot be accounted evidence`,
    );
  }

  // Checked last, so the more fundamental "this file is accounted for by
  // nothing" cause is never masked by a collision report.
  const byCoreHash = new Map<string, string>();
  for (const relative of accounted) {
    const indexed = index.byLogicalPath(relative);
    if (indexed === undefined) continue;
    const seen = byCoreHash.get(indexed.coreHash);
    if (seen !== undefined) {
      throw new Erl2Error(
        CODES.GRAPH_CLOSURE_EXTRA_ARTIFACT,
        `retained files ${seen} and ${relative} both claim core hash ${indexed.coreHash}; ` +
          `a retained core hash must identify exactly one retained file`,
      );
    }
    byCoreHash.set(indexed.coreHash, relative);
  }

  return { filesChecked: entries.size, retainedRoot: retainedRel };
}
