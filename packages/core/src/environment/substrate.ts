/**
 * Durable substrate state, and the substrate's own identity.
 *
 * A Compose or Kubernetes driver rediscovers what it provisioned by asking the
 * substrate. The fake driver has no substrate to ask, so until 6.5-B it held its
 * resources, instance identity and applied mutations in a `Map` on the instance
 * — which is correct for an in-process contract suite and wrong for the CLI,
 * where `provision`, `restore` and `destroy` are three separate processes. A
 * `destroy` in a fresh process saw an empty resource set and reported a clean
 * teardown over resources it had never looked at.
 *
 * This is that substrate, as a file. It is deliberately **not** an ERL2
 * contract: it carries no `schema_version` and no `core_hash`, so neither the
 * artifact index nor the offline verifier can mistake substrate state for
 * evidence. It lives under its own root, outside the run root, for the same
 * reason a Compose project lives outside the run root: the environment is the
 * thing being observed, never part of the observation.
 *
 * ## The substrate's identity (ADR-ERL2-024 §4.2)
 *
 * 6.5-B left the substrate *addressable* but not *identifiable*. `--substrate-root`
 * was caller-controlled, ungated and recorded nowhere, so a caller could drive a
 * run against substrate A and then destroy and finalize against a fresh empty
 * substrate B: the driver observed nothing, recorded a clean teardown, and the
 * bundle verified offline while the real environment stayed allocated (P0-1).
 *
 * A substrate therefore carries an identity **inside itself**, established the
 * first time a run provisions into it and read back by every later process. A
 * fresh empty substrate carries none, and that absence is what makes the
 * substitution detectable rather than invisible.
 *
 * The identity is derived, not random, so evidence stays byte-reproducible: it
 * is a domain-separated hash of the substrate kind, its normalized locator, and
 * the run that established it. Two different directories therefore have two
 * different identities, and the same directory keeps one across processes.
 *
 * ## Reading failures are not "nothing here"
 *
 * `load()` used to `catch { return undefined }` around every read, so an
 * ordinary permission or I/O fault was indistinguishable from "this run was
 * never provisioned" — and a teardown over live resources then passed (P1-12).
 * Absence (`ENOENT`) is the only condition that means "never provisioned";
 * everything else is `ENV_SUBSTRATE_UNREADABLE` and fails closed.
 *
 * Absence has one precise definition and one only: `readFileSync` raised
 * `ENOENT` for the state file this run's own locator names. Not `existsSync`
 * returning false — that answers false for a permission fault on the parent
 * directory too, and a probe that cannot see a marker is not a substrate that
 * has none. Not a document that parses but does not have the shape of substrate
 * state — coercing `{"resources": "gone"}` to an empty resource list is the
 * same fail-open one layer in, and it was still live after the first pass at
 * this file: a truncated-then-rewritten or hand-edited state answered "nothing
 * provisioned here" and a teardown over live resources passed again.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  CODES,
  Erl2Error,
  parseStrictJson,
  type EnvironmentOperationReceiptV1,
  type EnvironmentResourceV1,
  type Hash,
} from "@erl2/contracts";
import { domainHash, HASH_DOMAINS } from "@erl2/integrity";

/**
 * The on-disk shape version of one run's substrate state.
 *
 * A state document that carries no version is a document written by something
 * other than this store, and a document carrying a version this build does not
 * know is a document this build cannot interpret. Both fail closed: "I do not
 * understand these bytes" and "there is nothing here" are the two answers this
 * file exists to keep apart.
 */
const STATE_VERSION = 1;

/** Everything a driver must remember about one run's environment. */
export interface SubstrateState {
  readonly resources: readonly EnvironmentResourceV1[];
  readonly instanceHash?: Hash;
  readonly mutations: readonly string[];
  /**
   * The receipt of every operation this driver has completed for the run, keyed
   * by operation id.
   *
   * This is the driver's own operation log, and it is what makes restart
   * reconciliation able to *adopt* a prior result instead of failing closed
   * (ADR-ERL2-024 §4.3). A crash between the external call and the receipt
   * freeze leaves the effect applied and the evidence unwritten; without a log
   * the two are indistinguishable from "nothing happened", and the next process
   * re-dispatches. A real driver has the same thing — a labelled Compose
   * project, a Kubernetes annotation — for the same reason.
   */
  readonly operations?: Readonly<Record<string, EnvironmentOperationReceiptV1>>;
}

/**
 * The identity of a substrate instance: what a binding names, and what a later
 * process compares against.
 */
export interface SubstrateInstance {
  /** The substrate mechanism — `file-substrate-store`, `memory-substrate`, later `compose-project`. */
  readonly kind: string;
  /** The canonical, locator-free identity. */
  readonly instanceHash: Hash;
}

/** The seam a driver uses to remember its substrate across processes. */
export interface SubstrateStore {
  load(runId: string): SubstrateState | undefined;
  save(runId: string, state: SubstrateState): void;
  /**
   * The substrate's own identity, or `undefined` when this substrate has never
   * been established — the fresh empty directory of the P0-1 exploit.
   *
   * Read-only: it never creates the marker, so a phase that merely *checks* a
   * binding cannot accidentally mint the identity it was supposed to find.
   */
  instance(): SubstrateInstance | undefined;
  /**
   * Establishes the identity if absent and returns it. Called once, by
   * `provision`, before the first substrate-affecting dispatch.
   */
  establishInstance(runId: string): SubstrateInstance;
}

const MARKER = "substrate-instance.json";

/**
 * The filesystem calls the file substrate makes, as an injectable seam.
 *
 * It exists for exactly one reason: the brief requires that an *arbitrary* I/O
 * fault — not just the two or three a test can arrange with file modes — is
 * classified as a fault rather than as an empty substrate, and requires that the
 * classification is proven rather than asserted. A permission test that runs as
 * root silently passes without testing anything, so the deterministic case goes
 * through this seam and at least one real-filesystem case stays alongside it.
 *
 * It is *not* a general abstraction over storage: the store still resolves its
 * own paths, still writes temp-then-rename, and still owns every decision about
 * what an error means. Only the four syscalls are replaceable.
 */
export interface SubstrateIo {
  readFile(file: string): string;
  writeFile(file: string, text: string): void;
  rename(from: string, to: string): void;
  mkdirp(dir: string): void;
}

const NODE_IO: SubstrateIo = {
  readFile: (file) => readFileSync(file, "utf8"),
  writeFile: (file, text) => {
    writeFileSync(file, text, { mode: 0o600 });
  },
  rename: (from, to) => {
    renameSync(from, to);
  },
  mkdirp: (dir) => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  },
};

/** True only for the one condition that means "this file was never written". */
function isAbsent(cause: unknown): boolean {
  return (cause as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

function unreadable(what: string, why: string): Erl2Error {
  return new Erl2Error(
    CODES.ENV_SUBSTRATE_UNREADABLE,
    // Deliberately says what is wrong with the *shape* and never echoes the
    // bytes or the locator: this message reaches a CLI envelope, and a
    // substrate path is deployment-local detail that has no business there.
    `${what} is not valid substrate state (${why}); an unreadable substrate is not an empty one`,
    { owner: "lab" },
  );
}

/**
 * Validates a substrate-state document instead of coercing it.
 *
 * The previous reading was `Array.isArray(value.resources) ? value.resources :
 * []`, which turned every shape it did not recognise into an empty substrate —
 * exactly the answer P1-12 exists to forbid, arrived at by a different route
 * than the `catch` that had already been removed. A document that is not
 * substrate state is a fault, and a fault is not an environment with no
 * resources in it.
 */
function parseSubstrateState(value: unknown, what: string): SubstrateState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw unreadable(what, "not a JSON object");
  }
  const record = value as Record<string, unknown>;
  const version = record["version"];
  if (version !== STATE_VERSION) {
    throw unreadable(
      what,
      version === undefined
        ? "no shape version"
        : `unsupported shape version ${JSON.stringify(version)}`,
    );
  }
  if (!Array.isArray(record["resources"])) throw unreadable(what, "`resources` is not an array");
  if (!Array.isArray(record["mutations"])) throw unreadable(what, "`mutations` is not an array");
  for (const mutation of record["mutations"]) {
    if (typeof mutation !== "string") throw unreadable(what, "`mutations` holds a non-string");
  }
  const instanceHash = record["instanceHash"];
  if (instanceHash !== undefined && typeof instanceHash !== "string") {
    throw unreadable(what, "`instanceHash` is not a hash");
  }
  const operations = record["operations"];
  if (
    operations !== undefined &&
    (typeof operations !== "object" || operations === null || Array.isArray(operations))
  ) {
    throw unreadable(what, "`operations` is not an operation log");
  }
  return {
    resources: record["resources"] as readonly EnvironmentResourceV1[],
    ...(instanceHash === undefined ? {} : { instanceHash: instanceHash as Hash }),
    mutations: record["mutations"] as readonly string[],
    ...(operations === undefined
      ? {}
      : { operations: operations as Readonly<Record<string, EnvironmentOperationReceiptV1>> }),
  };
}

/** A substrate that lives only in this process; the pre-6.5-B behaviour. */
export class MemorySubstrateStore implements SubstrateStore {
  private readonly states = new Map<string, SubstrateState>();
  private established: SubstrateInstance | undefined;
  private readonly namespace: string;

  /**
   * `namespace` distinguishes two in-process substrates in the same test, the
   * way two directories distinguish two file substrates. It defaults to a
   * constant so the in-process contract suite stays byte-deterministic.
   */
  constructor(namespace = "memory") {
    this.namespace = namespace;
  }

  load(runId: string): SubstrateState | undefined {
    return this.states.get(runId);
  }

  save(runId: string, state: SubstrateState): void {
    this.states.set(runId, state);
  }

  instance(): SubstrateInstance | undefined {
    return this.established;
  }

  establishInstance(runId: string): SubstrateInstance {
    if (this.established !== undefined) return this.established;
    this.established = {
      kind: "memory-substrate",
      instanceHash: domainHash(HASH_DOMAINS.DRIVER_STATE, {
        substrate_kind: "memory-substrate",
        locator: this.namespace,
        established_by_run: runId,
      }),
    };
    return this.established;
  }
}

/**
 * A substrate that survives process death, published with the same
 * temp-then-rename discipline the artifact store uses so a crash mid-write
 * leaves the previous state rather than a truncated one.
 */
export class FileSubstrateStore implements SubstrateStore {
  private readonly root: string;
  private readonly io: SubstrateIo;

  constructor(root: string, io: SubstrateIo = NODE_IO) {
    this.root = path.resolve(root);
    this.io = io;
  }

  /**
   * Creates the substrate directory, on the first write and never before.
   *
   * The constructor used to do it, and the constructor runs in
   * `openEnvironment` — so every refused environment command left an empty
   * `<run-root>.substrate` behind. `readDocument` already reads `ENOENT` as
   * absence, so an unwritten substrate needs no directory to be readable as
   * empty; only a write needs one (ADR-ERL2-028 §4).
   */
  private ensureRoot(): void {
    this.io.mkdirp(this.root);
  }

  /** The absolute directory this substrate lives in. Private; never public evidence. */
  get locator(): string {
    return this.root;
  }

  private file(runId: string): string {
    // The run id is a UUID, but it arrives from a flag, so it is encoded rather
    // than interpolated: a substrate path can never escape its own root.
    return path.join(this.root, `${Buffer.from(runId, "utf8").toString("base64url")}.substrate.json`);
  }

  private markerPath(): string {
    return path.join(this.root, MARKER);
  }

  /**
   * Reads a document from the substrate, distinguishing "was never written"
   * from "could not be read".
   *
   * Every other caller in this file goes through here, so there is exactly one
   * place where an errno becomes a meaning — which is the whole of P1-12. A
   * directory where a file was expected raises `EISDIR`, a mode-0 file raises
   * `EACCES`, an injected fault raises whatever the seam raises; none of them is
   * `ENOENT`, so none of them is absence.
   */
  private readDocument(file: string, what: string): unknown | undefined {
    let text: string;
    try {
      text = this.io.readFile(file);
    } catch (cause) {
      if (isAbsent(cause)) return undefined;
      throw new Erl2Error(
        CODES.ENV_SUBSTRATE_UNREADABLE,
        `${what} exists but could not be read; an unreadable substrate is not an empty one`,
        { owner: "lab", cause },
      );
    }
    try {
      return parseStrictJson(text);
    } catch (cause) {
      // Truncation, a duplicated key, a half-written temp file promoted by a
      // crash: all of them arrive here, and all of them are faults.
      throw new Erl2Error(
        CODES.ENV_SUBSTRATE_UNREADABLE,
        `${what} is not a readable document`,
        { owner: "lab", cause },
      );
    }
  }

  load(runId: string): SubstrateState | undefined {
    const what = `the substrate state for run ${runId}`;
    const value = this.readDocument(this.file(runId), what);
    // Only absence means "this run was never provisioned here" (review P1-12).
    if (value === undefined) return undefined;
    return parseSubstrateState(value, what);
  }

  save(runId: string, state: SubstrateState): void {
    const absolute = this.file(runId);
    const temp = `${absolute}.tmp`;
    // A write fault is a fault too. Left untyped it surfaced as a raw errno
    // with an absolute host path in its message, which is both an untyped
    // refusal and a path leak.
    try {
      this.ensureRoot();
      this.io.writeFile(temp, `${JSON.stringify({ version: STATE_VERSION, ...state })}\n`);
      this.io.rename(temp, absolute);
    } catch (cause) {
      throw new Erl2Error(
        CODES.ENV_SUBSTRATE_UNREADABLE,
        `the substrate state for run ${runId} could not be written`,
        { owner: "lab", cause },
      );
    }
  }

  instance(): SubstrateInstance | undefined {
    const value = this.readDocument(this.markerPath(), "the substrate's identity marker");
    // Absence is the fresh empty substrate of the P0-1 exploit, and it is the
    // only reading that returns `undefined`. `existsSync` used to stand here,
    // which answers false for an unreadable parent directory as well — so an
    // I/O fault could present as a substrate with no identity, and `provision`
    // would then have minted a second identity over an established substrate.
    if (value === undefined) return undefined;
    const record = value as { kind?: unknown; instance_hash?: unknown };
    if (typeof record.kind !== "string" || typeof record.instance_hash !== "string") {
      throw new Erl2Error(
        CODES.ENV_SUBSTRATE_UNREADABLE,
        "the substrate's identity marker is malformed; its identity cannot be established",
        { owner: "lab" },
      );
    }
    return { kind: record.kind, instanceHash: record.instance_hash as Hash };
  }

  establishInstance(runId: string): SubstrateInstance {
    const existing = this.instance();
    if (existing !== undefined) return existing;
    const instance: SubstrateInstance = {
      kind: "file-substrate-store",
      // Derived, never random: evidence must stay byte-reproducible. Two
      // directories differ because their locators differ; the same directory
      // keeps one identity across processes because the marker persists.
      instanceHash: domainHash(HASH_DOMAINS.DRIVER_STATE, {
        substrate_kind: "file-substrate-store",
        locator: this.root,
        established_by_run: runId,
      }),
    };
    const marker = this.markerPath();
    const temp = `${marker}.tmp`;
    try {
      this.ensureRoot();
      this.io.writeFile(
        temp,
        `${JSON.stringify({ kind: instance.kind, instance_hash: instance.instanceHash })}\n`,
      );
      this.io.rename(temp, marker);
    } catch (cause) {
      throw new Erl2Error(
        CODES.ENV_SUBSTRATE_UNREADABLE,
        "the substrate's identity marker could not be written; a substrate whose identity cannot " +
          "be established cannot be bound",
        { owner: "lab", cause },
      );
    }
    return instance;
  }
}
