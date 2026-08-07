/**
 * The one place the hardened container configuration is written down
 * (ERL2-OQ-008 gate 2, ADR-ERL2-034).
 *
 * Three things need to agree about how a container is run, and if any two of
 * them disagree the evidence stops describing the thing that executes:
 *
 *   1. the **enforcement probes**, which observe the twenty controls holding;
 *   2. the **runtime-configuration hash** the substrate lock pins, which is what
 *      `assertObservedMatchesIsolationLock` re-compares before every run;
 *   3. the **launcher**, which is what actually starts an adapter.
 *
 * ADR-ERL2-016's whole argument is that a control is only enforced if something
 * watched it hold. A launcher that quietly added `--tmpfs /tmp`, or dropped
 * `--cap-drop=ALL`, or raised `--memory`, would be running a substrate no probe
 * ever saw — and the qualification evidence would still read `qualified`,
 * because nothing compares a flag vector to a probe. So the flag vector is a
 * constant here, all three read it, and the lock pins its hash. Divergence is
 * not caught by review; it is unrepresentable.
 *
 * Nothing in this module is a claim. It is the configuration whose *effects*
 * the probes measure.
 */

/** The numeric, non-root uid:gid every hardened container runs as. */
export const CONTAINER_NUMERIC_USER = "65532:65532";

/**
 * Flags applied to every hardened container, probe and adapter alike.
 *
 * Deliberately excludes `--name`, `--rm` and any mount: those are per-invocation
 * and per-caller, and they do not change what the kernel enforces. Everything
 * here does.
 */
export const HARDENED_CONTAINER_RUN_FLAGS: readonly string[] = [
  "--read-only",
  "--user",
  CONTAINER_NUMERIC_USER,
  "--cap-drop=ALL",
  "--security-opt",
  "no-new-privileges",
  "--network=none",
  "--pids-limit=64",
  "--memory=64m",
  "--cpus=0.5",
];

/**
 * The configuration object whose digest the substrate lock pins.
 *
 * Derived from the flag vector rather than restated beside it: a lock pinned
 * against one flag set cannot license a run under another, and the only way to
 * change the run configuration is to change the hash and re-qualify.
 */
export function containerRuntimeConfigurationInput(): {
  readonly hardened_flags: readonly string[];
} {
  return { hardened_flags: [...HARDENED_CONTAINER_RUN_FLAGS] };
}

/**
 * Paths the launcher maps into a container.
 *
 * The adapter is handed container-side paths in its operation message, because
 * the host paths it would otherwise be told about do not exist inside the
 * namespace. Everything under `/erl2` is either an ERL-owned read-only mount or
 * one of the two run-scoped writable directories the host created, reads back
 * and freezes.
 */
export const CONTAINER_ADAPTER_ROOT = "/erl2";
/** The adapter package, mounted read-only. */
export const CONTAINER_APP_ROOT = "/erl2/app";
/** The adapter's resolved module closure, laid out for the node resolver. */
export const CONTAINER_MODULES_ROOT = "/erl2/node_modules";
/** Read-only subject-visible inputs, one directory per mount id. */
export const CONTAINER_MOUNTS_ROOT = "/erl2/mounts";
/** The run-scoped writable output directory. */
export const CONTAINER_OUTPUT_ROOT = "/erl2/output";
/** The run-scoped writable diagnostics directory. */
export const CONTAINER_DIAGNOSTICS_ROOT = "/erl2/diagnostics";
