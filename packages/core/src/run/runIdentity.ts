/**
 * Durable run/workspace identity (ADR-ERL2-024 §4.1).
 *
 * `--run` and `--run-root` used to be independent inputs. `openWorkspace(flags,
 * runId)` took both and never cross-validated them, so `erl2 observe --run
 * <any-uuid> --run-root <another run's root>` acquired that root's lease,
 * resolved that root's evidence and appended to that root's lifecycle under a
 * claimed identity that was not the run's (review P1-8).
 *
 * ## Where the identity comes from
 *
 * The **workspace identity** is the `run_id` of the workspace's first lifecycle
 * event, `<run-root>/events/000000.json`. That stream is hash-chained and every
 * command already verifies it, so the value cannot be edited without breaking
 * the chain. Nothing new is written and no contract was invented for this: the
 * answer was already retained, it was simply never asked for.
 *
 * Three things are deliberately *not* the identity:
 *
 *   - **the run-root directory name** — caller-chosen, unsigned, trivially
 *     collides;
 *   - **`state/snapshot.json`** — a derived cache, authoritative for nothing
 *     (§11.9). It is cross-checked here, never trusted: a torn or forged
 *     snapshot must not be able to decide identity, but a snapshot that
 *     disagrees with the chain is still a refusal;
 *   - **anything a flag says** — that is the input being validated.
 *
 * ## When it is checked
 *
 * Before the run lease is acquired or modified, before any substrate or
 * reservation directory is created, before any evidence is frozen, before a
 * driver, subject port or adapter is constructed, and before any lifecycle
 * append. The check is cheap (one file read) and is applied at three layers —
 * the CLI dispatcher, the CLI workspace opener and the `RunWorkspace`
 * constructor — so a library caller that never goes through the CLI is refused
 * on exactly the same terms.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { CODES, Erl2Error, parseStrictJson } from "@erl2/contracts";

const EVENT_DIR = "events";
const SNAPSHOT_PATH = path.join("state", "snapshot.json");

/** What a run root says about itself. */
export interface WorkspaceIdentity {
  /**
   * `bootstrap` when the root holds no durable lifecycle event yet: the run has
   * not been accepted, so there is no identity to contradict. Only
   * `preregister-acquisition` legitimately reaches a workspace in this state.
   */
  readonly kind: "bootstrap" | "durable";
  /** The recorded run id; absent only for `bootstrap`. */
  readonly runId?: string;
  /** The event file the identity was read from, for the refusal message. */
  readonly source?: string;
}

/**
 * Reads the run identity a workspace durably records, without writing anything.
 *
 * Never creates the run root, never creates `state/`, never touches the lease.
 */
export function readWorkspaceIdentity(runRoot: string): WorkspaceIdentity {
  const root = path.resolve(runRoot);
  const eventDir = path.join(root, EVENT_DIR);
  if (!existsSync(eventDir)) return { kind: "bootstrap" };

  let files: string[];
  try {
    files = readdirSync(eventDir)
      .filter((name) => name.endsWith(".json") && !name.endsWith(".frozen"))
      .sort();
  } catch (cause) {
    // An events directory that exists but cannot be read is not "no run here".
    // Treating it as bootstrap would be the same fail-open shape as P1-12.
    throw new Erl2Error(
      CODES.VERIFY_RECORD_LIFECYCLE_GAP,
      `the run root's lifecycle directory exists but could not be read: ${root}`,
      { owner: "lab", cause },
    );
  }
  const first = files[0];
  if (first === undefined) return { kind: "bootstrap" };

  let value: unknown;
  try {
    value = parseStrictJson(readFileSync(path.join(eventDir, first), "utf8"));
  } catch (cause) {
    throw new Erl2Error(
      CODES.VERIFY_RECORD_LIFECYCLE_GAP,
      `the run root's first lifecycle event is unreadable; its run identity cannot be established`,
      { owner: "lab", cause },
    );
  }
  const runId = (value as { run_id?: unknown } | null)?.run_id;
  if (typeof runId !== "string" || runId.length === 0) {
    throw new Erl2Error(
      CODES.VERIFY_RECORD_LIFECYCLE_GAP,
      "the run root's first lifecycle event carries no run identity",
      { owner: "lab" },
    );
  }
  return { kind: "durable", runId, source: `${EVENT_DIR}/${first}` };
}

/**
 * Refuses a command whose `--run` disagrees with the workspace's own recorded
 * run identity.
 *
 * `allowBootstrap` is true only for the one command that legitimately creates a
 * new run root (`preregister-acquisition`). Every other command opens an
 * existing workspace, and a workspace with no durable event is not one it may
 * bring into being — that would let a typo in `--run-root` silently start a
 * second run rather than refuse.
 */
export function assertWorkspaceRunIdentity(options: {
  readonly runRoot: string;
  readonly runId: string;
  readonly allowBootstrap?: boolean;
}): WorkspaceIdentity {
  const identity = readWorkspaceIdentity(options.runRoot);
  if (identity.kind === "bootstrap") {
    if (options.allowBootstrap === true) return identity;
    // A root with no lifecycle is not an error by itself — `preregister` is
    // about to create one, and several read-only paths tolerate it. What must
    // never happen is a *mutating* command inventing a workspace, so the
    // caller decides by passing `allowBootstrap`.
    throw new Erl2Error(
      CODES.POLICY_RUN_IDENTITY_MISMATCH,
      `run root ${path.resolve(options.runRoot)} holds no durably accepted run; ` +
        `--run ${options.runId} names a run this workspace has never recorded`,
      { owner: "lab" },
    );
  }
  if (identity.runId !== options.runId) {
    throw new Erl2Error(
      CODES.POLICY_RUN_IDENTITY_MISMATCH,
      `--run ${options.runId} does not match the run this workspace records ` +
        `(${identity.runId as string}, from ${identity.source as string}); ` +
        `a run root and a run id are one identity, not two independent inputs`,
      { owner: "lab" },
    );
  }
  assertSnapshotAgrees(options.runRoot, identity.runId as string);
  return identity;
}

/**
 * The derived snapshot is a cache, so it decides nothing — but it must not
 * *disagree* with the chain either. A snapshot naming a different run is either
 * a crossed workspace or a tampered cache, and both are refusals.
 *
 * A missing or torn snapshot is explicitly fine: §11.9 already requires every
 * command to rebuild from the authoritative event log when the cache cannot be
 * read.
 */
function assertSnapshotAgrees(runRoot: string, chainRunId: string): void {
  const snapshotPath = path.join(path.resolve(runRoot), SNAPSHOT_PATH);
  if (!existsSync(snapshotPath)) return;
  let value: unknown;
  try {
    value = parseStrictJson(readFileSync(snapshotPath, "utf8"));
  } catch {
    return; // torn cache; the chain remains authoritative.
  }
  const runId = (value as { run_id?: unknown } | null)?.run_id;
  if (typeof runId !== "string") return;
  if (runId !== chainRunId) {
    throw new Erl2Error(
      CODES.POLICY_RUN_IDENTITY_MISMATCH,
      `the derived snapshot names run ${runId} while the lifecycle chain records ${chainRunId}; ` +
        `the workspace holds two run identities`,
      { owner: "lab" },
    );
  }
}
