/**
 * Independent artifact index.
 *
 * The verifier does not trust any producer-supplied list of artifacts.  It
 * walks the retained artifact root itself, parses every JSON object, and
 * indexes it by its independently recomputed `core_hash`.  A file whose stored
 * `core_hash` disagrees with its canonical bytes is rejected on sight.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { CODES, Erl2Error, parseStrictJson, type Hash } from "@erl2/contracts";
import { coreHash, hashBytes } from "@erl2/integrity";

export interface IndexedArtifact {
  readonly logicalPath: string;
  readonly coreHash: Hash;
  readonly fileSha256: Hash;
  readonly schemaVersion: string;
  readonly value: Record<string, unknown>;
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
      this.byCore.set(recomputed, artifact);
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

  tryGet(hash: Hash): IndexedArtifact | undefined {
    return this.byCore.get(hash);
  }

  byLogicalPath(logicalPath: string): IndexedArtifact | undefined {
    return this.byPath.get(logicalPath);
  }

  ofSchema(schemaVersion: string): readonly IndexedArtifact[] {
    return [...this.byCore.values()].filter((a) => a.schemaVersion === schemaVersion);
  }

  all(): readonly IndexedArtifact[] {
    return [...this.byCore.values()];
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
