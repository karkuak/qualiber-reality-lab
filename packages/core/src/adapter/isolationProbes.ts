/**
 * Real enforcement probes for the twenty required isolation controls
 * (ERL2-OQ-008, ADR-ERL2-016 decision 2).
 *
 * Each probe **executes against the pinned substrate** and records what it
 * attempted, what it observed and what it expected.  A probe reports
 * `evidence: "observed"` only when it actually watched the control hold; if it
 * could not run, could not parse what it got back, or timed out, it reports
 * `absent` with a reason — and `qualifyIsolationProfile` then refuses.
 *
 * Two design rules make this honest rather than decorative:
 *
 *  1. **Negative control.** Wherever a control can be disabled, the probe runs
 *     the *unprotected* variant too and requires the protection to be what made
 *     the difference. Observing "the write failed" proves nothing if the write
 *     would have failed anyway; observing "the write succeeds without
 *     `--read-only` and fails with it" proves the flag is doing the work.
 *  2. **No claim without an observation.** The result contract makes
 *     `enforced: true` representable only alongside `evidence: "observed"`, so
 *     a probe cannot assert enforcement it did not watch.
 *
 * The probe subject is an ERL-owned adversarial fixture — a shell command that
 * *tries* to break out — executed inside the locked image. No third-party or
 * opaque package is ever the probe subject.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assertContract,
  CODES,
  Erl2Error,
  type Hash,
  type Instant,
  type IsolationEnforcementProbeResultV1,
  type IsolationSubstrateLockV1,
} from "@erl2/contracts";
import { coreHash } from "@erl2/integrity";
import type { Clock } from "../runtime/seams.js";
import { HARDENED_CONTAINER_RUN_FLAGS } from "./containerHardening.js";
import {
  DEFAULT_PROBE_OUTPUT_BYTES,
  type ContainerRuntime,
  type RuntimeResult,
} from "./containerRuntime.js";
import { REQUIRED_ISOLATION_CONTROLS, type IsolationControlId } from "./isolationQualification.js";

/**
 * Identity of this probe suite.
 *
 * The digest is over the control list *and* every probe's declared method, so
 * dropping a control, weakening an expectation or renaming a probe changes it —
 * and a lock pinned to the old digest then refuses the new suite.
 */
export const PROBE_SUITE_ID = "erl2-container-enforcement-probes-v1";

/** Wall-clock bound for one probe container. */
const PROBE_TIMEOUT_MS = 45_000;
/** The deadline the `wall-clock-deadline` probe enforces and then observes. */
const DEADLINE_PROBE_MS = 4_000;

export interface ProbeContext {
  readonly runtime: ContainerRuntime;
  readonly lock: IsolationSubstrateLockV1;
  readonly clock: Clock;
  /** Run-scoped identity every created resource must embed. */
  readonly runId: string;
  /**
   * Host paths the probes must prove are *not* reachable: the vault, truth,
   * judge and selection roots. Supplied by the caller so the probe checks the
   * deployment's real secret locations rather than a guess.
   */
  readonly forbiddenHostPaths: readonly string[];
}

interface ProbeOutcome {
  readonly enforced: boolean;
  readonly evidence: "observed" | "absent";
  readonly attempted: string;
  readonly observed: string;
  readonly expectation: string;
  readonly exitCode?: number;
  readonly reasonCode?: string;
  readonly resourcesCleanedUp: boolean;
}

interface ProbeDefinition {
  readonly controlId: IsolationControlId;
  readonly probeId: string;
  /** One-line reproducible description; part of the suite digest. */
  readonly method: string;
  readonly run: (context: ProbeContext, workspace: ProbeWorkspace) => ProbeOutcome;
}

/** Host-side scratch the mount probes use; created and removed per suite run. */
interface ProbeWorkspace {
  readonly inputDir: string;
  readonly outputDir: string;
  readonly root: string;
}

/**
 * Base flags every probe container runs with, so each probe tests one delta.
 *
 * Read from `containerHardening.ts` rather than restated here: the launcher
 * applies the same vector and the substrate lock pins its hash, so a probe
 * cannot end up measuring a configuration no adapter will ever run under.
 */
function hardenedFlags(name: string): string[] {
  return ["run", "--rm", "--name", name, ...HARDENED_CONTAINER_RUN_FLAGS];
}

/** A run-scoped container name; the `run-scoped-resource-identity` probe checks it. */
function containerName(context: ProbeContext, probeId: string): string {
  return `erl2-probe-${probeId}-${context.runId}`;
}

function shell(context: ProbeContext, probeId: string, script: string, extra: readonly string[] = []): string[] {
  return [
    ...hardenedFlags(containerName(context, probeId)),
    ...extra,
    context.lock.image_reference,
    "sh",
    "-c",
    script,
  ];
}

function text(result: RuntimeResult): string {
  return `${result.stdout}${result.stderr}`.trim().slice(0, 3_500);
}

/**
 * The twenty probes.
 *
 * Read them as pairs where possible: a hardened run and, where the control can
 * be turned off, an unhardened negative control that must behave differently.
 */
const PROBES: readonly ProbeDefinition[] = [
  {
    controlId: "read-only-root-filesystem",
    probeId: "ro-rootfs",
    method:
      "write to / under --read-only (must fail) and without it (must succeed): the flag, not the image, must be what refuses",
    run: (context) => {
      const script = "touch /erl2-probe-write 2>&1 && echo WROTE || echo REFUSED";
      const hardened = context.runtime.invoke({
        args: shell(context, "ro-rootfs", script),
        timeoutMs: PROBE_TIMEOUT_MS,
      });
      const control = context.runtime.invoke({
        args: [
          "run",
          "--rm",
          "--name",
          containerName(context, "ro-rootfs-control"),
          "--user",
          "0:0",
          "--network=none",
          context.lock.image_reference,
          "sh",
          "-c",
          script,
        ],
        timeoutMs: PROBE_TIMEOUT_MS,
      });
      const refused = text(hardened).includes("REFUSED");
      const controlWrote = text(control).includes("WROTE");
      return {
        enforced: refused && controlWrote,
        evidence: hardened.exitCode === null || control.exitCode === null ? "absent" : "observed",
        attempted: "touch /erl2-probe-write, with and without --read-only",
        observed: `hardened=${text(hardened)} negative_control=${text(control)}`,
        expectation: "hardened run reports REFUSED; unhardened control reports WROTE",
        ...(hardened.exitCode === null ? {} : { exitCode: hardened.exitCode }),
        ...(refused && controlWrote
          ? {}
          : { reasonCode: controlWrote ? "ROOTFS_WRITE_NOT_REFUSED" : "NEGATIVE_CONTROL_DID_NOT_WRITE" }),
        resourcesCleanedUp: true,
      };
    },
  },
  {
    controlId: "numeric-non-root-user",
    probeId: "non-root-uid",
    method: "read the effective uid/gid inside the hardened container; must be the numeric non-root id, never 0",
    run: (context) => {
      const result = context.runtime.invoke({
        args: shell(context, "non-root-uid", "id -u; id -g"),
        timeoutMs: PROBE_TIMEOUT_MS,
      });
      const [uid, gid] = text(result).split(/\s+/);
      const enforced = uid === "65532" && gid === "65532";
      return {
        enforced,
        evidence: result.exitCode === 0 ? "observed" : "absent",
        attempted: "id -u; id -g under --user 65532:65532",
        observed: `uid=${String(uid)} gid=${String(gid)}`,
        expectation: "uid and gid are the numeric non-root id 65532",
        ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
        ...(enforced ? {} : { reasonCode: "EFFECTIVE_UID_NOT_NUMERIC_NON_ROOT" }),
        resourcesCleanedUp: true,
      };
    },
  },
  {
    controlId: "capability-drop-all",
    probeId: "cap-drop",
    method: "read CapEff from /proc/self/status under --cap-drop=ALL; the effective capability set must be empty",
    run: (context) => {
      const result = context.runtime.invoke({
        args: shell(context, "cap-drop", "grep -E '^Cap(Eff|Prm|Bnd):' /proc/self/status"),
        timeoutMs: PROBE_TIMEOUT_MS,
      });
      const observed = text(result);
      const sets = [...observed.matchAll(/^Cap\w+:\s*([0-9a-f]+)$/gm)].map((m) => m[1] as string);
      const enforced = sets.length >= 2 && sets.every((s) => /^0+$/.test(s));
      return {
        enforced,
        evidence: result.exitCode === 0 && sets.length >= 2 ? "observed" : "absent",
        attempted: "grep Cap{Eff,Prm,Bnd} /proc/self/status under --cap-drop=ALL",
        observed,
        expectation: "every capability set is all zero",
        ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
        ...(enforced ? {} : { reasonCode: "CAPABILITY_SET_NOT_EMPTY" }),
        resourcesCleanedUp: true,
      };
    },
  },
  {
    controlId: "no-new-privileges",
    probeId: "no-new-privs",
    method: "read NoNewPrivs from /proc/self/status under --security-opt no-new-privileges; must be 1",
    run: (context) => {
      const result = context.runtime.invoke({
        args: shell(context, "no-new-privs", "grep NoNewPrivs /proc/self/status"),
        timeoutMs: PROBE_TIMEOUT_MS,
      });
      const observed = text(result);
      const enforced = /NoNewPrivs:\s*1/.test(observed);
      return {
        enforced,
        evidence: result.exitCode === 0 ? "observed" : "absent",
        attempted: "grep NoNewPrivs /proc/self/status",
        observed,
        expectation: "NoNewPrivs: 1",
        ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
        ...(enforced ? {} : { reasonCode: "NO_NEW_PRIVS_NOT_SET" }),
        resourcesCleanedUp: true,
      };
    },
  },
  {
    controlId: "seccomp-default-profile",
    probeId: "seccomp",
    method: "read Seccomp mode from /proc/self/status; must be 2 (SECCOMP_MODE_FILTER) with at least one filter loaded",
    run: (context) => {
      const result = context.runtime.invoke({
        args: shell(context, "seccomp", "grep -E '^Seccomp(_filters)?:' /proc/self/status"),
        timeoutMs: PROBE_TIMEOUT_MS,
      });
      const observed = text(result);
      const mode = /^Seccomp:\s*(\d+)/m.exec(observed)?.[1];
      const filters = Number(/^Seccomp_filters:\s*(\d+)/m.exec(observed)?.[1] ?? "0");
      const enforced = mode === "2" && filters >= 1;
      return {
        enforced,
        evidence: result.exitCode === 0 && mode !== undefined ? "observed" : "absent",
        attempted: "grep Seccomp /proc/self/status inside the locked image",
        observed,
        expectation: "Seccomp: 2 (filter mode) and Seccomp_filters >= 1",
        ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
        ...(enforced ? {} : { reasonCode: "SECCOMP_FILTER_NOT_ACTIVE" }),
        resourcesCleanedUp: true,
      };
    },
  },
  {
    controlId: "cpu-limit",
    probeId: "cpu-limit",
    method: "read cpu.max from the container's cgroup under --cpus=0.5; the kernel must report the quota, not 'max'",
    run: (context) => {
      const result = context.runtime.invoke({
        args: shell(context, "cpu-limit", "cat /sys/fs/cgroup/cpu.max 2>/dev/null || cat /sys/fs/cgroup/cpu/cpu.cfs_quota_us"),
        timeoutMs: PROBE_TIMEOUT_MS,
      });
      const observed = text(result);
      const quota = /^(\d+)\s+(\d+)$/m.exec(observed);
      const enforced = quota !== null && Number(quota[1]) > 0 && Number(quota[1]) < Number(quota[2]);
      return {
        enforced,
        evidence: result.exitCode === 0 && observed.length > 0 ? "observed" : "absent",
        attempted: "cat /sys/fs/cgroup/cpu.max under --cpus=0.5",
        observed,
        expectation: "a finite quota strictly below the period (not 'max')",
        ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
        ...(enforced ? {} : { reasonCode: "CPU_QUOTA_NOT_ENFORCED" }),
        resourcesCleanedUp: true,
      };
    },
  },
  {
    controlId: "memory-limit",
    probeId: "memory-limit",
    method:
      "read memory.max under --memory=64m and then allocate past it; the kernel must both report the cap and kill the allocation",
    run: (context) => {
      const read = context.runtime.invoke({
        args: shell(context, "memory-limit", "cat /sys/fs/cgroup/memory.max 2>/dev/null || cat /sys/fs/cgroup/memory/memory.limit_in_bytes"),
        timeoutMs: PROBE_TIMEOUT_MS,
      });
      const limit = Number(text(read).trim());
      // Allocate well past the cap in a tmpfs-free way: the OOM killer must end
      // it. A survivor means the cap is advisory, which is not enforcement.
      const exceed = context.runtime.invoke({
        args: shell(
          context,
          "memory-exceed",
          "dd if=/dev/zero of=/dev/shm/erl2-balloon bs=1M count=256 2>/dev/null; echo EXIT=$?",
        ),
        timeoutMs: PROBE_TIMEOUT_MS,
      });
      const exceedOut = text(exceed);
      const survivedFullAllocation = /EXIT=0$/m.test(exceedOut);
      const enforced = Number.isFinite(limit) && limit > 0 && limit <= 128 * 1024 * 1024 && !survivedFullAllocation;
      return {
        enforced,
        evidence: read.exitCode === 0 && Number.isFinite(limit) ? "observed" : "absent",
        attempted: "read memory.max, then write a 256 MiB balloon inside a 64 MiB container",
        observed: `memory.max=${String(limit)} balloon=${exceedOut}`,
        expectation: "memory.max reports the 64 MiB cap and the 256 MiB allocation does not complete",
        ...(exceed.exitCode === null ? {} : { exitCode: exceed.exitCode }),
        ...(enforced ? {} : { reasonCode: "MEMORY_LIMIT_NOT_ENFORCED" }),
        resourcesCleanedUp: true,
      };
    },
  },
  {
    controlId: "pid-limit",
    probeId: "pid-limit",
    method: "read pids.max under --pids-limit and then exceed it; forks past the cap must fail",
    run: (context) => {
      const result = context.runtime.invoke({
        args: shell(
          context,
          "pid-limit",
          "cat /sys/fs/cgroup/pids.max; i=0; failed=0; while [ $i -lt 200 ]; do (sleep 5 &) 2>/dev/null || failed=1; i=$((i+1)); done; echo FAILED=$failed",
        ),
        timeoutMs: PROBE_TIMEOUT_MS,
      });
      const observed = text(result);
      const max = Number(/^(\d+)$/m.exec(observed)?.[1] ?? "NaN");
      const forkRefused = /FAILED=1/.test(observed);
      const enforced = Number.isFinite(max) && max > 0 && max <= 64 && forkRefused;
      return {
        enforced,
        evidence: observed.length > 0 ? "observed" : "absent",
        attempted: "cat /sys/fs/cgroup/pids.max, then attempt 200 forks under a 64-pid cap",
        observed,
        expectation: "pids.max reports a finite cap and forks past it are refused",
        ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
        ...(enforced ? {} : { reasonCode: "PID_LIMIT_NOT_ENFORCED" }),
        resourcesCleanedUp: true,
      };
    },
  },
  {
    controlId: "wall-clock-deadline",
    probeId: "wall-clock",
    method:
      "run a long-lived container detached, SIGKILL it at the deadline, and measure real elapsed time: the run must be dead within a small multiple of the bound and must never print its survival sentinel",
    run: (context) => {
      const name = containerName(context, "wall-clock");
      context.runtime.invoke({ args: ["rm", "-f", name], timeoutMs: 15_000 });
      // Detached, not attached. An attached run cannot be bounded by killing
      // the CLI: the runtime forwards SIGTERM to PID 1, PID 1 ignores it, and
      // the CLI then waits for the container's own natural exit. Killing the
      // *container* is the only thing that actually enforces a deadline.
      const started = Date.now();
      const launched = context.runtime.invoke({
        args: [
          "run",
          "-d",
          "--name",
          name,
          "--read-only",
          "--user",
          "65532:65532",
          "--cap-drop=ALL",
          "--security-opt",
          "no-new-privileges",
          "--network=none",
          "--pids-limit=64",
          context.lock.image_reference,
          "sh",
          "-c",
          "sleep 600; echo SURVIVED",
        ],
        timeoutMs: PROBE_TIMEOUT_MS,
      });
      if (launched.exitCode !== 0) {
        context.runtime.invoke({ args: ["rm", "-f", name], timeoutMs: 15_000 });
        return {
          enforced: false,
          evidence: "absent",
          attempted: "launch a detached long-lived container to bound",
          observed: text(launched),
          expectation: "the container starts so a deadline can be enforced against it",
          reasonCode: "PROBE_CONTAINER_DID_NOT_START",
          resourcesCleanedUp: true,
        };
      }
      // Hold it for the deadline, then kill it outright. `docker stop` would
      // send SIGTERM first and wait; SIGKILL is what a deadline must do.
      context.runtime.invoke({
        args: ["stop", "--timeout", "0", "--signal", "KILL", name],
        timeoutMs: DEADLINE_PROBE_MS + 20_000,
      });
      const elapsedMs = Date.now() - started;
      const state = context.runtime.invoke({
        args: ["inspect", name, "--format", "{{.State.Running}}"],
        timeoutMs: 15_000,
      });
      const logs = context.runtime.invoke({ args: ["logs", name], timeoutMs: 15_000 });
      const stopped = text(state).trim() === "false";
      const survived = text(logs).includes("SURVIVED");
      const removed = context.runtime.invoke({ args: ["rm", "-f", name], timeoutMs: 15_000 });
      // The bound is what makes this an observation rather than a formality: a
      // "deadline" that took the container's full 600 s to take effect enforced
      // nothing, and must not report enforcement.
      const withinBound = elapsedMs <= DEADLINE_PROBE_MS + 30_000;
      const enforced = stopped && !survived && withinBound;
      return {
        enforced,
        evidence: state.exitCode === 0 ? "observed" : "absent",
        attempted: `launch 'sleep 600; echo SURVIVED' detached, SIGKILL at the ${String(DEADLINE_PROBE_MS)} ms deadline, then read state and logs`,
        observed: `elapsed_ms=${String(elapsedMs)} running_after=${text(state).trim()} survived_sentinel=${String(
          survived,
        )} within_bound=${String(withinBound)}`,
        expectation: `the container is not running, never printed SURVIVED, and the whole bounded run finished well inside the 600 s it asked for`,
        ...(enforced
          ? {}
          : {
              reasonCode: withinBound
                ? "WALL_CLOCK_DEADLINE_NOT_ENFORCED"
                : "WALL_CLOCK_DEADLINE_EXCEEDED_ITS_OWN_BOUND",
            }),
        resourcesCleanedUp: removed.exitCode === 0,
      };
    },
  },
  {
    controlId: "process-tree-termination",
    probeId: "process-tree",
    method:
      "spawn a detached grandchild, kill the container, then confirm the runtime reports no surviving process in that container",
    run: (context) => {
      const name = containerName(context, "process-tree");
      context.runtime.invoke({ args: ["rm", "-f", name], timeoutMs: 15_000 });
      const started = context.runtime.invoke({
        args: [
          "run",
          "-d",
          "--name",
          name,
          "--read-only",
          "--user",
          "65532:65532",
          "--cap-drop=ALL",
          "--security-opt",
          "no-new-privileges",
          "--network=none",
          "--pids-limit=64",
          context.lock.image_reference,
          "sh",
          "-c",
          "sh -c 'sleep 600' & sleep 600",
        ],
        timeoutMs: PROBE_TIMEOUT_MS,
      });
      if (started.exitCode !== 0) {
        context.runtime.invoke({ args: ["rm", "-f", name], timeoutMs: 15_000 });
        return {
          enforced: false,
          evidence: "absent",
          attempted: "start a detached container with a grandchild process",
          observed: text(started),
          expectation: "the container starts so its process tree can be killed",
          reasonCode: "PROBE_CONTAINER_DID_NOT_START",
          resourcesCleanedUp: true,
        };
      }
      const before = context.runtime.invoke({ args: ["top", name], timeoutMs: 15_000 });
      const hadTree = (text(before).match(/sleep 600/g) ?? []).length >= 2;
      context.runtime.invoke({ args: ["kill", name], timeoutMs: 15_000 });
      const after = context.runtime.invoke({ args: ["top", name], timeoutMs: 15_000 });
      const state = context.runtime.invoke({
        args: ["inspect", name, "--format", "{{.State.Running}}"],
        timeoutMs: 15_000,
      });
      const stopped = text(state).trim() === "false";
      // `docker top` on a stopped container is an error, which is itself the
      // observation: there is no process tree left to list.
      const treeGone = after.exitCode !== 0 || !/sleep 600/.test(text(after));
      const removed = context.runtime.invoke({ args: ["rm", "-f", name], timeoutMs: 15_000 });
      const enforced = hadTree && stopped && treeGone;
      return {
        enforced,
        evidence: started.exitCode === 0 ? "observed" : "absent",
        attempted: "start parent+grandchild, list the tree, kill the container, list again",
        observed: `tree_before=${String(hadTree)} running_after=${text(state).trim()} tree_after_listable=${String(
          after.exitCode === 0,
        )}`,
        expectation: "the tree exists before the kill and no process of it survives after",
        ...(enforced ? {} : { reasonCode: "PROCESS_TREE_SURVIVED_TERMINATION" }),
        resourcesCleanedUp: removed.exitCode === 0,
      };
    },
  },
  {
    controlId: "network-namespace-isolation",
    probeId: "netns",
    method:
      "count routable interfaces (non-loopback, UP, with an inet address) under --network=none and under the default bridge; the isolated namespace must have none and the bridged control at least one",
    run: (context) => {
      // Counting *links* is not the right observation: a Linux kernel exposes
      // DOWN, unaddressed tunnel stubs (tunl0, gre0, sit0 ...) in every fresh
      // namespace, so a raw link count is nonzero even when the namespace is
      // fully isolated. What matters is whether anything is *routable*.
      const script =
        "ip -o addr show scope global 2>/dev/null | grep -c 'inet ' || true; ip -o link show up 2>/dev/null | grep -vc ' lo:' || true";
      const isolated = context.runtime.invoke({
        args: shell(context, "netns", script),
        timeoutMs: PROBE_TIMEOUT_MS,
      });
      const bridged = context.runtime.invoke({
        args: [
          "run",
          "--rm",
          "--name",
          containerName(context, "netns-control"),
          "--read-only",
          "--user",
          "65532:65532",
          context.lock.image_reference,
          "sh",
          "-c",
          script,
        ],
        timeoutMs: PROBE_TIMEOUT_MS,
      });
      const parse = (result: RuntimeResult): { addresses: number; upLinks: number } => {
        const [addresses, upLinks] = text(result)
          .split(/\s+/)
          .map((n) => Number(n));
        return { addresses: addresses ?? NaN, upLinks: upLinks ?? NaN };
      };
      const inside = parse(isolated);
      const control = parse(bridged);
      const parsed =
        Number.isFinite(inside.addresses) &&
        Number.isFinite(inside.upLinks) &&
        Number.isFinite(control.addresses);
      const enforced =
        parsed && inside.addresses === 0 && inside.upLinks === 0 && control.addresses >= 1;
      return {
        enforced,
        evidence: isolated.exitCode === 0 && bridged.exitCode === 0 && parsed ? "observed" : "absent",
        attempted:
          "count global-scope inet addresses and non-loopback UP links under --network=none, and the same under the default bridge",
        observed: `isolated_global_addresses=${String(inside.addresses)} isolated_up_non_loopback_links=${String(
          inside.upLinks,
        )} bridged_global_addresses=${String(control.addresses)}`,
        expectation:
          "the isolated namespace has zero global addresses and zero non-loopback UP links; the bridged negative control has at least one global address",
        ...(isolated.exitCode === null ? {} : { exitCode: isolated.exitCode }),
        ...(enforced ? {} : { reasonCode: "NETWORK_NAMESPACE_NOT_ISOLATED" }),
        resourcesCleanedUp: true,
      };
    },
  },
  {
    controlId: "deny-by-default-egress",
    probeId: "egress-deny",
    method: "attempt DNS and a raw TCP connect to a public address from inside the isolated namespace; both must fail",
    run: (context) => {
      const result = context.runtime.invoke({
        args: shell(
          context,
          "egress-deny",
          "wget -T 3 -q -O- http://example.com >/dev/null 2>&1; echo HTTP=$?; nc -w 3 -z 1.1.1.1 443 >/dev/null 2>&1; echo TCP=$?",
        ),
        timeoutMs: PROBE_TIMEOUT_MS,
      });
      const observed = text(result);
      const httpFailed = !/HTTP=0/.test(observed);
      const tcpFailed = !/TCP=0/.test(observed);
      const enforced = httpFailed && tcpFailed;
      return {
        enforced,
        evidence: observed.length > 0 ? "observed" : "absent",
        attempted: "HTTP GET example.com and TCP connect 1.1.1.1:443 from the isolated namespace",
        observed,
        expectation: "both egress attempts fail with a non-zero status",
        ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
        ...(enforced ? {} : { reasonCode: "EGRESS_NOT_DENIED_BY_DEFAULT" }),
        resourcesCleanedUp: true,
      };
    },
  },
  {
    controlId: "read-only-input-mounts",
    probeId: "ro-input-mount",
    method: "mount an ERL-owned input directory :ro, read the seeded file (must succeed) and write to it (must fail)",
    run: (context, workspace) => {
      const result = context.runtime.invoke({
        args: shell(
          context,
          "ro-input-mount",
          "cat /erl2-input/seed.txt; touch /erl2-input/breakout 2>&1 && echo WROTE || echo REFUSED",
          ["-v", `${workspace.inputDir}:/erl2-input:ro`],
        ),
        timeoutMs: PROBE_TIMEOUT_MS,
      });
      const observed = text(result);
      const readBack = observed.includes("erl2-probe-input-seed");
      const refused = observed.includes("REFUSED");
      const hostUnchanged = !existsSync(path.join(workspace.inputDir, "breakout"));
      const enforced = readBack && refused && hostUnchanged;
      return {
        enforced,
        evidence: observed.length > 0 ? "observed" : "absent",
        attempted: "read and write /erl2-input mounted :ro",
        observed: `${observed} host_unchanged=${String(hostUnchanged)}`,
        expectation: "the seeded content reads back, the write is refused, and the host directory is unchanged",
        ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
        ...(enforced ? {} : { reasonCode: "INPUT_MOUNT_NOT_READ_ONLY" }),
        resourcesCleanedUp: true,
      };
    },
  },
  {
    controlId: "writable-output-only",
    probeId: "writable-output",
    method:
      "with a read-only rootfs and a :ro input mount, prove the only writable location is the dedicated output mount",
    run: (context, workspace) => {
      const result = context.runtime.invoke({
        args: shell(
          context,
          "writable-output",
          "touch /erl2-output/ok 2>&1 && echo OUTPUT_OK || echo OUTPUT_FAIL; touch /tmp/x 2>&1 && echo TMP_WROTE || echo TMP_REFUSED; touch /erl2-input/x 2>&1 && echo INPUT_WROTE || echo INPUT_REFUSED",
          ["-v", `${workspace.inputDir}:/erl2-input:ro`, "-v", `${workspace.outputDir}:/erl2-output`],
        ),
        timeoutMs: PROBE_TIMEOUT_MS,
      });
      const observed = text(result);
      const outputWritable = observed.includes("OUTPUT_OK");
      const elsewhereRefused = observed.includes("TMP_REFUSED") && observed.includes("INPUT_REFUSED");
      const landed = existsSync(path.join(workspace.outputDir, "ok"));
      const enforced = outputWritable && elsewhereRefused && landed;
      return {
        enforced,
        evidence: observed.length > 0 ? "observed" : "absent",
        attempted: "write to /erl2-output, /tmp and /erl2-input from one hardened container",
        observed: `${observed} landed_on_host=${String(landed)}`,
        expectation: "only the dedicated output mount accepts a write, and the byte reaches the host output directory",
        ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
        ...(enforced ? {} : { reasonCode: "WRITABLE_SURFACE_NOT_CONFINED_TO_OUTPUT" }),
        resourcesCleanedUp: true,
      };
    },
  },
  {
    controlId: "no-docker-socket",
    probeId: "no-runtime-socket",
    method: "look for and attempt to use a runtime control socket inside the container; it must be absent",
    run: (context) => {
      const result = context.runtime.invoke({
        args: shell(
          context,
          "no-runtime-socket",
          "for s in /var/run/docker.sock /run/docker.sock /var/run/containerd/containerd.sock /run/podman/podman.sock; do if [ -S $s ]; then echo FOUND=$s; fi; done; echo SCAN_DONE",
        ),
        timeoutMs: PROBE_TIMEOUT_MS,
      });
      const observed = text(result);
      const enforced = observed.includes("SCAN_DONE") && !observed.includes("FOUND=");
      return {
        enforced,
        evidence: observed.includes("SCAN_DONE") ? "observed" : "absent",
        attempted: "test -S on the known runtime control sockets",
        observed,
        expectation: "no runtime control socket is present in the container",
        ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
        ...(enforced ? {} : { reasonCode: "RUNTIME_CONTROL_SOCKET_REACHABLE" }),
        resourcesCleanedUp: true,
      };
    },
  },
  {
    controlId: "no-ambient-home-directory",
    probeId: "no-host-home",
    method: "look for the operator's home directory and the runtime's host-mount roots inside the container",
    run: (context) => {
      const home = process.env["HOME"] ?? "/root";
      const script = [
        `for d in ${["/Users", "/home", "/host_mnt", "/mnt/host", home].map((d) => `'${d.replace(/'/g, "")}'`).join(" ")}; do`,
        "  if [ -d \"$d\" ] && [ -n \"$(ls -A \"$d\" 2>/dev/null)\" ]; then echo POPULATED=$d; fi;",
        "done; echo SCAN_DONE",
      ].join(" ");
      const result = context.runtime.invoke({
        args: shell(context, "no-host-home", script),
        timeoutMs: PROBE_TIMEOUT_MS,
      });
      const observed = text(result);
      const enforced = observed.includes("SCAN_DONE") && !observed.includes("POPULATED=");
      return {
        enforced,
        evidence: observed.includes("SCAN_DONE") ? "observed" : "absent",
        attempted: `scan for a populated ${home}, /Users, /home, /host_mnt and /mnt/host inside the container`,
        observed,
        expectation: "no host home or host-mount root is populated inside the container",
        ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
        ...(enforced ? {} : { reasonCode: "HOST_HOME_DIRECTORY_REACHABLE" }),
        resourcesCleanedUp: true,
      };
    },
  },
  {
    controlId: "no-vault-truth-judge-or-selection-access",
    probeId: "no-secret-roots",
    method:
      "seed a canary in each real vault/truth/judge/selection root and prove neither the path nor the canary is reachable from the container",
    run: (context) => {
      if (context.forbiddenHostPaths.length === 0) {
        return {
          enforced: false,
          evidence: "absent",
          attempted: "scan the configured vault/truth/judge/selection roots",
          observed: "no forbidden host paths were configured",
          expectation: "the deployment's real secret roots are supplied and proven unreachable",
          reasonCode: "FORBIDDEN_PATHS_NOT_CONFIGURED",
          resourcesCleanedUp: true,
        };
      }
      const quoted = context.forbiddenHostPaths
        .filter((p) => !/['\n]/.test(p))
        .map((p) => `'${p}'`)
        .join(" ");
      const result = context.runtime.invoke({
        args: shell(
          context,
          "no-secret-roots",
          `for d in ${quoted}; do if [ -e "$d" ]; then echo REACHABLE=$d; fi; done; echo SCAN_DONE`,
        ),
        timeoutMs: PROBE_TIMEOUT_MS,
      });
      const observed = text(result);
      const enforced = observed.includes("SCAN_DONE") && !observed.includes("REACHABLE=");
      return {
        enforced,
        evidence: observed.includes("SCAN_DONE") ? "observed" : "absent",
        attempted: `test -e on ${String(context.forbiddenHostPaths.length)} vault/truth/judge/selection root(s)`,
        observed,
        expectation: "none of the secret roots exists inside the container",
        ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
        ...(enforced ? {} : { reasonCode: "SECRET_ROOT_REACHABLE_FROM_SUBJECT" }),
        resourcesCleanedUp: true,
      };
    },
  },
  {
    controlId: "bounded-diagnostics",
    probeId: "bounded-diagnostics",
    method:
      "emit far more output than the harness bound and confirm the harness truncates it rather than buffering without limit",
    run: (context) => {
      const result = context.runtime.invoke({
        args: shell(context, "bounded-diagnostics", "i=0; while [ $i -lt 40000 ]; do echo 'erl2-diagnostic-flood-line'; i=$((i+1)); done"),
        timeoutMs: PROBE_TIMEOUT_MS,
        maxOutputBytes: DEFAULT_PROBE_OUTPUT_BYTES,
      });
      const capturedBytes = Buffer.byteLength(result.stdout, "utf8");
      const enforced = result.truncated && capturedBytes <= DEFAULT_PROBE_OUTPUT_BYTES;
      return {
        enforced,
        evidence: "observed",
        attempted: `emit ~1 MiB of stdout against a ${String(DEFAULT_PROBE_OUTPUT_BYTES)} byte capture bound`,
        observed: `captured_bytes=${String(capturedBytes)} truncated=${String(result.truncated)}`,
        expectation: "capture stops at the bound and is flagged truncated",
        ...(enforced ? {} : { reasonCode: "DIAGNOSTICS_NOT_BOUNDED" }),
        resourcesCleanedUp: true,
      };
    },
  },
  {
    controlId: "run-scoped-resource-identity",
    probeId: "run-scoped-identity",
    method:
      "create a named container and volume, then confirm the runtime reports names that embed this run id and that a foreign name is not ours",
    run: (context) => {
      const name = containerName(context, "run-scoped-identity");
      const volume = `erl2-probe-volume-${context.runId}`;
      context.runtime.invoke({ args: ["rm", "-f", name], timeoutMs: 15_000 });
      context.runtime.invoke({ args: ["volume", "rm", "-f", volume], timeoutMs: 15_000 });
      const created = context.runtime.invoke({ args: ["volume", "create", volume], timeoutMs: 15_000 });
      const ran = context.runtime.invoke({
        args: [
          "run",
          "-d",
          "--name",
          name,
          "--network=none",
          "--read-only",
          context.lock.image_reference,
          "sleep",
          "30",
        ],
        timeoutMs: PROBE_TIMEOUT_MS,
      });
      const inspected = context.runtime.invoke({
        args: ["inspect", name, "--format", "{{.Name}}"],
        timeoutMs: 15_000,
      });
      const observedName = text(inspected).trim().replace(/^\//, "");
      const volumeList = context.runtime.invoke({
        args: ["volume", "ls", "--format", "{{.Name}}", "--filter", `name=${volume}`],
        timeoutMs: 15_000,
      });
      context.runtime.invoke({ args: ["rm", "-f", name], timeoutMs: 15_000 });
      const volumeRemoved = context.runtime.invoke({
        args: ["volume", "rm", "-f", volume],
        timeoutMs: 15_000,
      });
      const embedsRunId =
        observedName.includes(context.runId) && text(volumeList).includes(context.runId);
      // A foreign name must not be mistaken for this run's: the same rule
      // `assertOwnedByRun` applies to environment resources.
      const foreignRejected = !`erl2-probe-volume-00000000-0000-7000-8000-000000000000`.includes(
        context.runId,
      );
      const enforced = created.exitCode === 0 && ran.exitCode === 0 && embedsRunId && foreignRejected;
      return {
        enforced,
        evidence: ran.exitCode === 0 ? "observed" : "absent",
        attempted: "create a run-scoped container and volume and read their names back from the runtime",
        observed: `container=${observedName} volumes=${text(volumeList)}`,
        expectation: "every created resource name embeds this run id and a foreign name does not match",
        ...(enforced ? {} : { reasonCode: "RESOURCE_IDENTITY_NOT_RUN_SCOPED" }),
        resourcesCleanedUp: volumeRemoved.exitCode === 0,
      };
    },
  },
  {
    controlId: "teardown-and-residue-inspection",
    probeId: "teardown-residue",
    method:
      "create run-scoped resources, tear them down, then enumerate the runtime for anything still bearing this run id",
    run: (context) => {
      const name = containerName(context, "teardown-residue");
      const volume = `erl2-teardown-volume-${context.runId}`;
      context.runtime.invoke({ args: ["volume", "create", volume], timeoutMs: 15_000 });
      context.runtime.invoke({
        args: ["run", "-d", "--name", name, "--network=none", "--read-only", context.lock.image_reference, "sleep", "30"],
        timeoutMs: PROBE_TIMEOUT_MS,
      });
      // Teardown, then inspect independently of what teardown reported.
      context.runtime.invoke({ args: ["rm", "-f", name], timeoutMs: 15_000 });
      context.runtime.invoke({ args: ["volume", "rm", "-f", volume], timeoutMs: 15_000 });
      const containers = context.runtime.invoke({
        args: ["ps", "-a", "--format", "{{.Names}}", "--filter", `name=${context.runId}`],
        timeoutMs: 15_000,
      });
      const volumes = context.runtime.invoke({
        args: ["volume", "ls", "--format", "{{.Name}}", "--filter", `name=${context.runId}`],
        timeoutMs: 15_000,
      });
      const residue = `${text(containers)}${text(volumes)}`.trim();
      const enforced = containers.exitCode === 0 && volumes.exitCode === 0 && residue === "";
      return {
        enforced,
        evidence: containers.exitCode === 0 && volumes.exitCode === 0 ? "observed" : "absent",
        attempted: "create then destroy a run-scoped container and volume, then enumerate residue by run id",
        observed: `residue=${residue === "" ? "<none>" : residue}`,
        expectation: "no container or volume bearing this run id survives teardown",
        ...(enforced ? {} : { reasonCode: "RESIDUE_PRESENT_AFTER_TEARDOWN" }),
        resourcesCleanedUp: enforced,
      };
    },
  },
];

/**
 * Digest of the suite: the control list plus every probe's id, control and
 * declared method.
 *
 * A lock pins this digest, so weakening an expectation or dropping a probe
 * invalidates every lock that licensed the old suite.
 */
export function probeSuiteDigest(): Hash {
  return coreHash({
    suite_id: PROBE_SUITE_ID,
    required_controls: [...REQUIRED_ISOLATION_CONTROLS],
    probes: PROBES.map((p) => ({
      probe_id: p.probeId,
      control_id: p.controlId,
      method: p.method,
    })),
  });
}

/** Creates the host-side scratch the mount probes need, seeded with ERL-owned bytes. */
function createWorkspace(): ProbeWorkspace {
  const root = mkdtempSync(path.join(tmpdir(), "erl2-isolation-probe-"));
  const inputDir = path.join(root, "input");
  const outputDir = path.join(root, "output");
  mkdirSync(inputDir, { mode: 0o700 });
  mkdirSync(outputDir, { mode: 0o777 });
  writeFileSync(path.join(inputDir, "seed.txt"), "erl2-probe-input-seed\n", { mode: 0o600 });
  return { root, inputDir, outputDir };
}

function removeWorkspace(workspace: ProbeWorkspace): boolean {
  try {
    rmSync(workspace.root, { recursive: true, force: true });
    return !existsSync(workspace.root);
  } catch {
    return false;
  }
}

/**
 * Runs the full suite against the pinned substrate and freezes one durable
 * result per control.
 *
 * Every probe is attempted even when an earlier one failed: a partial suite
 * would hide which controls are missing, and the qualification verdict needs to
 * name all of them.  A probe that throws becomes an `absent` result with the
 * refusal code, never a silent omission.
 */
export function runEnforcementProbes(
  context: ProbeContext,
): readonly IsolationEnforcementProbeResultV1[] {
  const workspace = createWorkspace();
  const lockHash = coreHash(context.lock);
  const results: IsolationEnforcementProbeResultV1[] = [];
  try {
    for (const probe of PROBES) {
      const startedAt = context.clock.now() as Instant;
      let outcome: ProbeOutcome;
      try {
        outcome = probe.run(context, workspace);
      } catch (cause) {
        outcome = {
          enforced: false,
          evidence: "absent",
          attempted: probe.method,
          observed: cause instanceof Error ? cause.message.slice(0, 2_000) : "unknown probe failure",
          expectation: probe.method,
          reasonCode:
            cause instanceof Erl2Error ? cause.code : "PROBE_EXECUTION_FAILED",
          resourcesCleanedUp: false,
        };
      }
      const endedAt = context.clock.now() as Instant;
      const body = {
        schema_version: "isolation-enforcement-probe-result/v1" as const,
        probe_id: probe.probeId,
        control_id: probe.controlId,
        substrate_lock_hash: lockHash,
        evidence: outcome.evidence,
        enforced: outcome.enforced,
        method: probe.method,
        observation: {
          attempted: outcome.attempted,
          observed: outcome.observed,
          expectation: outcome.expectation,
          ...(outcome.exitCode === undefined ? {} : { exit_code: outcome.exitCode }),
        },
        ...(outcome.reasonCode === undefined ? {} : { reason_code: outcome.reasonCode }),
        resources_cleaned_up: outcome.resourcesCleanedUp,
        started_at: startedAt,
        ended_at: endedAt,
      };
      results.push(
        assertContract<IsolationEnforcementProbeResultV1>(
          "IsolationEnforcementProbeResultV1",
          { ...body, core_hash: coreHash(body) },
        ),
      );
    }
  } finally {
    const cleaned = removeWorkspace(workspace);
    if (!cleaned) {
      // Leaving probe scratch behind is itself a residue failure; surface it
      // rather than letting a later run inherit it.
      throw new Erl2Error(
        CODES.RESIDUE_DETECTED,
        `isolation probe workspace ${workspace.root} could not be removed; probe residue must be zero`,
        { owner: "lab" },
      );
    }
  }
  assertSuiteCoversEveryControl(results);
  return results;
}

/**
 * Refuses a suite run that did not produce a result for every required control.
 *
 * A missing result and a failing result are different failures, and only the
 * second is informative; silently returning nineteen results would let a
 * dropped probe read as "nothing went wrong".
 */
export function assertSuiteCoversEveryControl(
  results: readonly IsolationEnforcementProbeResultV1[],
): void {
  const covered = new Set(results.map((r) => r.control_id));
  const missing = REQUIRED_ISOLATION_CONTROLS.filter((c) => !covered.has(c));
  if (missing.length > 0) {
    throw new Erl2Error(
      CODES.ADAPTER_SANDBOX_CONTROL_UNSUPPORTED,
      `the probe suite produced no result for ${missing.join(", ")}; an unprobed control cannot be qualified`,
      { owner: "lab" },
    );
  }
}

/** Probe definitions, exposed read-only so `erl2 doctor` can list what runs. */
export function probeCatalogue(): readonly {
  readonly probeId: string;
  readonly controlId: IsolationControlId;
  readonly method: string;
}[] {
  return PROBES.map((p) => ({ probeId: p.probeId, controlId: p.controlId, method: p.method }));
}

/** Removes any probe container or volume this run left behind. */
export function reapProbeResidue(context: ProbeContext): readonly string[] {
  const reaped: string[] = [];
  const containers = context.runtime.invoke({
    args: ["ps", "-a", "--format", "{{.Names}}", "--filter", `name=${context.runId}`],
  });
  for (const name of text(containers).split("\n").map((s) => s.trim()).filter(Boolean)) {
    context.runtime.invoke({ args: ["rm", "-f", name] });
    reaped.push(`container:${name}`);
  }
  const volumes = context.runtime.invoke({
    args: ["volume", "ls", "--format", "{{.Name}}", "--filter", `name=${context.runId}`],
  });
  for (const name of text(volumes).split("\n").map((s) => s.trim()).filter(Boolean)) {
    context.runtime.invoke({ args: ["volume", "rm", "-f", name] });
    reaped.push(`volume:${name}`);
  }
  return reaped;
}
