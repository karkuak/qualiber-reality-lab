/**
 * Which cancellation branch a run is on, derived from its own durable evidence
 * (review P1-2, ADR-ERL2-024 §4.4, ADR-ERL2-028 §6).
 *
 * ## What this closes
 *
 * ADR-ERL2-024 made `erl2 cancel` branch-dispatched and chose the right
 * discriminator — the substrate binding, because `provision` freezes it *before*
 * it dispatches, so a run that crashed mid-provision has one. The dispatcher it
 * shipped read that discriminator like this:
 *
 * ```ts
 * return existsSync(path.join(runRoot, "retained", "environment", "substrate-binding.json"));
 * ```
 *
 * `existsSync` answers **false** for a permission fault on the file or on any
 * parent directory as readily as for a file that was never written. So an
 * ordinary `EACCES` or `EIO` on a live environment run routed the cancellation
 * through the *pre-environment* terminal, which enumerates only the Lab's own
 * acquisition temporaries — and froze cleanup variant `none` / status
 * `not_required` while the environment and its reservation leases were still
 * allocated. That is review P1-2's exact symptom, reached without any flag, by
 * the fail-open class ADR-ERL2-026 §2 had already removed from the substrate
 * reader and from the substrate's identity marker.
 *
 * Deleting the binding file did the same thing, and needed no fault at all.
 *
 * ## What it does instead
 *
 * Two independent witnesses, and `ENOENT` is the only condition that means "this
 * run never had an environment":
 *
 * 1. the retained `substrate-binding` artifact, read with an errno-discriminating
 *    read — the witness that covers the crash-mid-provision window, where the
 *    binding is frozen and its lifecycle event does not exist yet;
 * 2. the run's own lifecycle events, which name the roles they produced — the
 *    witness that survives the binding artifact being removed.
 *
 * Either one is enough to reach the environment branch. Neither being readable
 * for a reason other than absence is a typed refusal, never an answer.
 *
 * ## Why this is not just the CLI's problem
 *
 * The classification is exported and shared: the CLI dispatcher uses it to choose
 * a command, and `EnvironmentRun.cancel` uses it to assert it was reached on
 * purpose. A branch decision made in two places is a branch decision that can
 * disagree with itself.
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { CODES, Erl2Error, parseStrictJson } from "@erl2/contracts";

export type CancellationBranch = "pre_environment" | "environment";

/** The roles whose presence in the lifecycle proves the environment branch. */
const ENVIRONMENT_WITNESS_ROLES: ReadonlySet<string> = new Set([
  "substrate-binding",
  "environment-resource-inventory",
  "environment-reservation-lease",
  "environment-baseline",
  "execution-plan",
  "environment-resource-frontier",
]);

/** True only for the one condition that means "this was never written". */
function isAbsent(cause: unknown): boolean {
  return (cause as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

function unreadable(what: string, cause: unknown): Erl2Error {
  return new Erl2Error(
    CODES.ENV_SUBSTRATE_UNREADABLE,
    // Says what could not be read and never echoes the path: this message
    // reaches a CLI envelope, and a run root is deployment-local detail.
    `${what} exists but could not be read, so this run's cancellation branch cannot be ` +
      `established; an unreadable run is not a run without an environment`,
    { owner: "lab", cause },
  );
}

/**
 * Whether the retained substrate binding is present.
 *
 * Absent is `undefined`; unreadable throws. The bytes are not validated here —
 * the environment cancellation path validates the binding properly, against the
 * substrate. This answers only "did this run ever bind one", which is the
 * question the branch turns on.
 */
function bindingPresent(runRoot: string): boolean {
  try {
    readFileSync(path.join(runRoot, "retained", "environment", "substrate-binding.json"), "utf8");
    return true;
  } catch (cause) {
    if (isAbsent(cause)) return false;
    throw unreadable("this run's retained substrate binding", cause);
  }
}

/**
 * Whether the lifecycle chain shows an environment.
 *
 * Reads the event files directly rather than through `LifecycleLog`, because the
 * branch has to be decided *before* a workspace is opened — and a workspace is
 * opened by the very command this chooses between. An unreadable events
 * directory, or an unreadable event inside it, is a refusal: a run whose history
 * cannot be read is not a run without a history.
 */
function lifecycleShowsEnvironment(runRoot: string): boolean {
  let names: readonly string[];
  const dir = path.join(runRoot, "events");
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
  } catch (cause) {
    if (isAbsent(cause)) return false;
    throw unreadable("this run's lifecycle event directory", cause);
  }
  for (const name of names) {
    let event: { readonly produced?: readonly { readonly artifact_role?: string }[] };
    try {
      event = parseStrictJson(readFileSync(path.join(dir, name), "utf8")) as typeof event;
    } catch (cause) {
      throw unreadable("a lifecycle event of this run", cause);
    }
    for (const produced of event.produced ?? []) {
      if (produced.artifact_role !== undefined && ENVIRONMENT_WITNESS_ROLES.has(produced.artifact_role)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * The branch this run's cancellation belongs to.
 *
 * `environment` when either witness says so. The two are deliberately not
 * cross-checked against each other: a disagreement between them is a *reason to
 * take the environment branch*, not a reason to refuse, because the environment
 * branch is the one that enumerates a real frontier and can therefore discover
 * which witness was right.
 */
export function classifyCancellationBranch(options: { readonly runRoot: string }): CancellationBranch {
  const runRoot = path.resolve(options.runRoot);
  if (bindingPresent(runRoot)) return "environment";
  if (lifecycleShowsEnvironment(runRoot)) return "environment";
  return "pre_environment";
}
