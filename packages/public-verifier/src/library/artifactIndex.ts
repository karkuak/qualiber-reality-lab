/**
 * Independent artifact index.
 *
 * The verifier does not trust any producer-supplied list of artifacts.  It
 * walks the retained artifact root itself, parses every JSON object, and
 * indexes it by its independently recomputed `core_hash`.  A file whose stored
 * `core_hash` disagrees with its canonical bytes is rejected on sight.
 *
 * **Two files can share a `core_hash`.**  `signature`, `root_signature` and
 * `wrapper_signature` are excluded from the core hash by design (they are
 * authority, not identity), so two files may agree on every hashed byte and
 * still carry different signatures.  The hash-keyed map therefore cannot be the
 * enumeration used by any *completeness* check: a `Map.set` collision silently
 * drops one of the two, and the walk order (per-directory `sort()`) is chosen by
 * whoever names the file.  An attacker who forged the signature at a canonical
 * retained path and dropped a pristine byte-copy under a later-sorting name had
 * the forged file accounted for as a retained file and never signature-verified
 * — `erl2 verify` and `erl2 verify-record` reported exit 0 / `valid`.
 *
 * So the index exposes two distinct views, and callers must pick deliberately:
 *
 *   - {@link ArtifactIndex.all} / {@link ArtifactIndex.get} — **by core hash**,
 *     one entry per hash, for resolving a *reference* (a closure role, a bundle
 *     member, an attestation binding).
 *   - {@link ArtifactIndex.retainedFiles} — **every indexed file** beneath
 *     `retained/`, collisions included, for anything that must hold of every
 *     retained byte-stream (signature verification, file accounting).
 *
 * A legitimate run does contain one cross-directory collision: a step outcome is
 * published both under `retained/step-outcomes/` and under `subject-output/`.
 * Hash lookup therefore prefers the `retained/` copy, so a reference can never be
 * steered to a subject-visible file by naming.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import {
  CODES,
  CONTRACTS,
  Erl2Error,
  parseStrictJson,
  validateContract,
  type Hash,
} from "@erl2/contracts";
import { coreHash, hashBytes } from "@erl2/integrity";

export interface IndexedArtifact {
  readonly logicalPath: string;
  readonly coreHash: Hash;
  readonly fileSha256: Hash;
  readonly schemaVersion: string;
  readonly value: Record<string, unknown>;
}

/** The retained subtree, the only place a signed Lab artifact may live. */
const RETAINED_PREFIX = "retained/";

function isRetained(logicalPath: string): boolean {
  return logicalPath.startsWith(RETAINED_PREFIX);
}

/**
 * Every `schema_version` the Lab's contract registry defines, mapped to the
 * contracts registered under it.
 *
 * **A schema version names a family, not a single contract.** `finding/v1` has
 * six registered variants; `signer-inventory/v2`, `subject-output-manifest/v1`
 * and `public-verification-bundle/v2` each have a pre-environment and an
 * environment one. An artifact is a valid member of the family when it
 * satisfies *any* of them -- validating against one arbitrarily chosen variant
 * would refuse the shipped goldens, which is how this was caught.
 *
 * The lookup is an exact string match against the registry, deliberately. No
 * normalisation, no prefix matching, no similarity: a `schema_version` the
 * registry does not define is opaque product output, and staying opaque is what
 * keeps a Unicode-confusable or aliased name from being treated as a Lab
 * contract, in either direction.
 */
const CONTRACTS_BY_SCHEMA_VERSION: ReadonlyMap<string, readonly string[]> = (() => {
  const map = new Map<string, string[]>();
  for (const contract of CONTRACTS) {
    if (contract.schemaVersion === undefined) continue;
    const bucket = map.get(contract.schemaVersion) ?? [];
    bucket.push(contract.name);
    map.set(contract.schemaVersion, bucket);
  }
  return map;
})();

/**
 * Refuses a retained artifact that wears a Lab contract's name without being one
 * (RL-D-027, option C).
 *
 * Closure admitted a lifecycle-`produced` artifact on `index.get(hash)` -- pure
 * existence, no contract check -- so a contract-invalid document declaring a
 * known schema entered a bundle reported `valid` and was listed under a real
 * role in the verifier's own closure output.
 *
 * ## Where this runs, and why not earlier
 *
 * At **closure admission**, via {@link ArtifactIndex.admit} -- the moment an
 * artifact stops being a file on disk and becomes accounted evidence. Not during
 * the index walk: the walk is a general-purpose scan that several derivations
 * and unit fixtures drive over partial trees, and refusing there would make the
 * index refuse artifacts nothing ever admits. Admission is the boundary the
 * property is actually about, and refusing at it is still strictly before graph
 * closure and before anything semantic reads the artifact.
 *
 * Scope is the retained subtree, matching `RETAINED_PREFIX`'s existing meaning:
 * subject-visible and product bytes are not Lab artifacts and are not parsed as
 * any. The artifact has already been read, parsed under the strict JSON rules
 * and hash-checked during the walk, so this adds validation but no second read.
 */
function assertRetainedContract(artifact: IndexedArtifact): void {
  if (!isRetained(artifact.logicalPath)) return;
  const candidates = CONTRACTS_BY_SCHEMA_VERSION.get(artifact.schemaVersion);
  if (candidates === undefined) return;

  let firstProblem: string | undefined;
  for (const contract of candidates) {
    const result = validateContract(contract, artifact.value);
    if (result.valid) return;
    firstProblem ??= `${contract}: ${result.problems[0]?.message ?? "unknown"}`;
  }
  throw new Erl2Error(
    CODES.GRAPH_CLOSURE_RETAINED_CONTRACT_INVALID,
    `retained artifact ${artifact.logicalPath} declares ${artifact.schemaVersion}, which this ` +
      `verifier defines, and satisfies none of its ${String(candidates.length)} registered contract(s)`,
    { detail: firstProblem ?? "no registered contract" },
  );
}

export class ArtifactIndex {
  private readonly byCore = new Map<string, IndexedArtifact>();
  private readonly byPath = new Map<string, IndexedArtifact>();
  readonly root: string;

  private constructor(root: string) {
    this.root = root;
  }

  static scan(root: string): ArtifactIndex {
    const index = new ArtifactIndex(path.resolve(root));
    index.walk(index.root, "");
    return index;
  }

  private walk(absolute: string, relative: string): void {
    let entries: string[];
    try {
      entries = readdirSync(absolute);
    } catch {
      return;
    }
    for (const name of entries.sort()) {
      const child = path.join(absolute, name);
      const childRelative = relative === "" ? name : `${relative}/${name}`;
      const st = statSync(child);
      if (st.isDirectory()) {
        this.walk(child, childRelative);
        continue;
      }
      if (!st.isFile() || !name.endsWith(".json") || name.endsWith(".frozen")) continue;
      const bytes = readFileSync(child);
      let value: unknown;
      try {
        value = parseStrictJson(bytes.toString("utf8"));
      } catch {
        continue;
      }
      if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
      const record = value as Record<string, unknown>;
      const schemaVersion = record["schema_version"];
      const declared = record["core_hash"];
      if (typeof schemaVersion !== "string" || typeof declared !== "string") continue;
      const recomputed = coreHash(record);
      if (recomputed !== declared) {
        throw new Erl2Error(
          CODES.ARTIFACT_HASH_MISMATCH,
          `artifact ${childRelative} declares a core_hash its canonical bytes do not produce`,
        );
      }
      const artifact: IndexedArtifact = {
        logicalPath: childRelative,
        coreHash: recomputed,
        fileSha256: hashBytes(bytes),
        schemaVersion,
        value: record,
      };
      // Hash lookup is collision-stable and never steerable by filename: the
      // first entry wins, except that a `retained/` copy always outranks a
      // non-retained one (the legitimate step-outcome duplication).  Every
      // *file* stays reachable through `byPath` / `retainedFiles()`.
      const incumbent = this.byCore.get(recomputed);
      if (incumbent === undefined || (!isRetained(incumbent.logicalPath) && isRetained(childRelative))) {
        this.byCore.set(recomputed, artifact);
      }
      this.byPath.set(childRelative, artifact);
    }
  }

  get(hash: Hash): IndexedArtifact {
    const found = this.byCore.get(hash);
    if (!found) {
      throw new Erl2Error(
        CODES.GRAPH_CLOSURE_UNREACHABLE_ARTIFACT,
        `no retained artifact has core hash ${hash}`,
      );
    }
    return found;
  }

  /**
   * Resolves an artifact **and** admits it to graph closure.
   *
   * `get` answers "does this hash resolve"; `admit` answers "may this become
   * accounted evidence", which is a stronger question and the one every closure
   * role must ask. A retained artifact declaring a `schema_version` this
   * verifier's registry defines must satisfy one of the contracts registered
   * under it, or it is refused here -- before the closure records it under a
   * role and before anything downstream interprets it (RL-D-027).
   */
  admit(hash: Hash): IndexedArtifact {
    const artifact = this.get(hash);
    assertRetainedContract(artifact);
    return artifact;
  }

  tryGet(hash: Hash): IndexedArtifact | undefined {
    return this.byCore.get(hash);
  }

  byLogicalPath(logicalPath: string): IndexedArtifact | undefined {
    return this.byPath.get(logicalPath);
  }

  ofSchema(schemaVersion: string): readonly IndexedArtifact[] {
    return [...this.byCore.values()].filter((a) => a.schemaVersion === schemaVersion);
  }

  /**
   * One artifact per core hash.  Use this to resolve a *reference*; never to
   * assert something of every retained byte-stream — a core-hash collision is
   * representable, so this view is lossy by construction.
   */
  all(): readonly IndexedArtifact[] {
    return [...this.byCore.values()];
  }

  /**
   * **Every** indexed file beneath `retained/`, core-hash collisions included,
   * in walk order.  This is the enumeration every completeness check must use:
   * signature verification and retained-file accounting have to hold of each
   * retained file individually, not of one representative per hash.
   */
  retainedFiles(): readonly IndexedArtifact[] {
    return [...this.byPath.values()].filter((a) => isRetained(a.logicalPath));
  }

  typed<T>(hash: Hash, schemaVersion: string): T {
    const artifact = this.get(hash);
    if (artifact.schemaVersion !== schemaVersion) {
      throw new Erl2Error(
        CODES.VERSION_CLOSURE_MEMBER_CROSSOVER,
        `expected ${schemaVersion} at ${hash}, found ${artifact.schemaVersion}`,
      );
    }
    return artifact.value as T;
  }
}
