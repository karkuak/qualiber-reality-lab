/**
 * CONTRACT: every implemented `erl2` command answers `--help` without running.
 *
 * ## Why this exists
 *
 * Before this pass, all 36 implemented commands refused `--help` with
 * `CFG_UNKNOWN_FLAG`, because `--help` was never a flag any command's own
 * `parseFlags` call declared — the only place a caller could ask "what does
 * this command need?" was the top-level `erl2 --help` blob, which the trusted-
 * local documentation pass (M1) had already made the external front door point
 * at, but which does not answer for one command in isolation.
 *
 * The fix is a single pre-dispatch short-circuit in `runCommand`, not 36
 * separate per-command fixes: any recognised command's `--help` is intercepted
 * before its own flag parsing, run-lease acquisition, or dispatch, so it can
 * perform no filesystem write, start no adapter, and make no network call, and
 * needs none of the command's other required flags.
 *
 * This is a discoverability contract, not a prose-pinning test: it does not
 * assert exact wording for every command (most have no per-command usage
 * authored yet, and are not required to), only that every recognised command
 * answers `--help` cleanly, that answering never dispatches, that an
 * unrecognised command is not granted the same shortcut, and that ordinary
 * unknown-flag refusal is unaffected when `--help` is absent.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { erl2 } from "../support/cliRun.js";
import { ownedTempDir } from "../support/tempDirs.js";
import { COMMAND_REGISTRY } from "@erl2/cli";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const bareHelp = erl2(["--help"]);
const COMMANDS = ((bareHelp.body.data as { commands?: unknown } | undefined)?.commands ?? []) as string[];

/**
 * The production dispatch authority, imported directly from the CLI module — the
 * single object `runCommand` dispatches through — NOT derived from `--help`.
 *
 * This is the whole point of the M2 F-1 hardening: the discoverability contract
 * must compare TWO independent surfaces — what the CLI can actually dispatch
 * (this registry) versus what the top-level `--help` renders (`COMMANDS`, above)
 * — so a command that is dispatchable but unlisted (or listed but not
 * dispatchable) is a hard failure rather than an invisible gap. The original
 * suite derived both its actual and its expected set from `--help` alone; a
 * hidden dispatchable command therefore stayed green (reproduced by mutation
 * M03 / M-F1). `REGISTRY_NAMES` and `COMMANDS` never share a source.
 */
const REGISTRY_NAMES = Object.keys(COMMAND_REGISTRY);

interface FsEntrySnapshot {
  readonly type: "file" | "directory";
  readonly size?: number;
  readonly mode: number;
  readonly sha256?: string;
}

/**
 * A recursive manifest of every entry beneath `root`, keyed by the path
 * relative to `root`. Used to prove `--help` performs literally zero
 * filesystem writes anywhere beneath a scratch root it was merely told
 * about — new directories, new files, changed bytes and mode changes are all
 * detected — rather than the narrower, previously-shipped check of a single
 * named `--run-root`/`--output-root` path via `existsSync`, which an
 * unrelated write elsewhere beneath the same scratch root would have passed
 * silently. Deliberately scoped to the scratch roots this test file itself
 * creates via {@link ownedTempDir}, never a broader filesystem location.
 */
function snapshotTree(root: string): Record<string, FsEntrySnapshot> {
  const manifest: Record<string, FsEntrySnapshot> = {};
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const rel = path.relative(root, full);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        manifest[rel] = { type: "directory", mode: stat.mode };
        walk(full);
        continue;
      }
      manifest[rel] = {
        type: "file",
        size: stat.size,
        mode: stat.mode,
        sha256: createHash("sha256").update(readFileSync(full)).digest("hex"),
      };
    }
  };
  walk(root);
  return manifest;
}

test("erl2 --help lists at least one implemented command", () => {
  assert.equal(bareHelp.exitCode, 0);
  assert.equal(bareHelp.body.ok, true);
  assert.ok(Array.isArray(COMMANDS) && COMMANDS.length > 0, "expected a non-empty commands list");
  for (const command of COMMANDS) assert.equal(typeof command, "string");
});

test("every command erl2 --help lists answers <command> --help with ok:true and no dispatch", () => {
  for (const command of COMMANDS) {
    const result = erl2([command, "--help"]);
    assert.equal(result.exitCode, 0, `${command} --help: ${JSON.stringify(result.body.errors)}`);
    assert.equal(result.body.ok, true, `${command} --help should succeed`);
    assert.equal(result.body.errors.length, 0, `${command} --help should carry no errors`);
    // A help response never carries a run_id or state: those only appear once a
    // command actually dispatched into the journey/environment engine. Their
    // absence is the structural proof that help returned before dispatch, not
    // just an incidental detail of the response shape.
    assert.equal(result.body.run_id, undefined, `${command} --help must not dispatch (run_id present)`);
    assert.equal(result.body.state, undefined, `${command} --help must not dispatch (state present)`);
    const data = result.body.data as { command?: unknown; usage?: unknown } | undefined;
    assert.equal(data?.command, command, `${command} --help should name the command it is for`);
    assert.ok(data?.usage !== undefined, `${command} --help should carry a usage object`);
  }
});

test("--help is honoured wherever it appears among a command's arguments", () => {
  const result = erl2(["provision", "--archetype", "whatever", "--help"]);
  assert.equal(result.exitCode, 0);
  assert.equal(result.body.ok, true);
});

test("--help does not require a command's other flags, including its required ones", () => {
  // `provision` normally requires --run-root/--registry/--run/--archetype; none
  // of them is supplied here, and the earlier assertion already covers every
  // command taking zero extra flags, so this pins the point explicitly for one
  // command with several required flags.
  const result = erl2(["provision", "--help"]);
  assert.equal(result.exitCode, 0);
  assert.equal(result.body.ok, true);
});

test("commands with authored usage return that exact usage object under --help", () => {
  const usageBlob = (bareHelp.body.data as { usage?: Record<string, unknown> }).usage ?? {};
  for (const command of [
    "admit-adapter",
    "declare-trusted-local-adapter",
    "run-trusted-local-observation",
  ]) {
    const documented = usageBlob[command];
    assert.ok(documented !== undefined, `expected ${command} to carry authored usage in erl2 --help`);
    const perCommand = erl2([command, "--help"]);
    const data = perCommand.body.data as { usage?: unknown };
    assert.deepEqual(data.usage, documented, `${command} --help should match erl2 --help's own usage entry exactly`);
  }
});

test("a command with no authored usage still answers, pointing at a real, in-repo runbooks path rather than staying silent", () => {
  // `provision` (the environment branch) has no COMMAND_USAGE entry; it must
  // still answer rather than refuse, and the fallback must not be empty.
  const result = erl2(["provision", "--help"]);
  const data = result.body.data as { usage?: { summary?: string } };
  assert.ok(typeof data.usage?.summary === "string" && data.usage.summary.length > 0);
  // Strengthened past a substring regex (`assert.match(..., /runbooks/)`), which
  // would still pass if the pointer text were corrupted to a nonexistent path
  // that merely contained the word "runbooks". Extract the literal path segment
  // the summary names and resolve it against the repository root, exactly as
  // the documentation-truth contract already does for README links.
  const pointer = /\bunder\s+(\S+)\s+for\b/u.exec(data.usage.summary);
  assert.ok(pointer, `expected the generic fallback to name a runbooks path: ${data.usage.summary}`);
  const runbooksText = (pointer as RegExpExecArray)[1] as string;
  const resolved = path.resolve(repoRoot, runbooksText);
  assert.ok(
    resolved.startsWith(repoRoot + path.sep),
    `runbooks pointer "${runbooksText}" must resolve inside the repository`,
  );
  assert.ok(existsSync(resolved), `runbooks pointer must resolve to a real, tracked path (missing: ${resolved})`);
  assert.ok(statSync(resolved).isDirectory(), `runbooks pointer must resolve to a directory: ${resolved}`);
  assert.ok(readdirSync(resolved).length > 0, `runbooks pointer must resolve to a non-empty directory: ${resolved}`);
});

test("--help performs no filesystem write anywhere beneath the scratch root, even when it is named as --run-root", () => {
  const scratchParent = ownedTempDir("erl2-help-fs-");
  const neverCreated = path.join(scratchParent, "should-not-exist");
  const before = snapshotTree(scratchParent);
  const result = erl2(["provision", "--run-root", neverCreated, "--help"]);
  const after = snapshotTree(scratchParent);
  assert.equal(result.exitCode, 0);
  assert.equal(existsSync(neverCreated), false, "--help must not create the run root it was merely told about");
  // A before/after manifest diff over the whole scratch root, not just the one
  // named path: catches a new file or directory anywhere beneath the root, a
  // changed byte in an existing file, or a changed mode bit, all scoped to the
  // scratch root this test itself created (never a broader filesystem scan).
  assert.deepEqual(
    after,
    before,
    "--help must not create, modify, or change the mode of anything beneath the scratch root",
  );
});

test("--help performs no filesystem write anywhere beneath the scratch root, even when it is named as --output-root", () => {
  const scratchParent = ownedTempDir("erl2-help-fs-");
  const neverCreated = path.join(scratchParent, "should-not-exist");
  const before = snapshotTree(scratchParent);
  const result = erl2(["run-trusted-local-observation", "--output-root", neverCreated, "--help"]);
  const after = snapshotTree(scratchParent);
  assert.equal(result.exitCode, 0);
  assert.equal(existsSync(neverCreated), false, "--help must not create the output root it was merely told about");
  assert.deepEqual(
    after,
    before,
    "--help must not create, modify, or change the mode of anything beneath the scratch root",
  );
});

test("an unrecognised command is not granted the --help shortcut", () => {
  const result = erl2(["not-a-real-erl2-command", "--help"]);
  assert.equal(result.body.ok, false);
  assert.equal(result.exitCode, 2);
  assert.equal(result.body.errors[0]?.code, "CFG_UNKNOWN_FLAG");
  assert.match(result.body.errors[0]?.message ?? "", /unknown command/);
});

test("unknown-flag refusal is unaffected when --help is absent", () => {
  const result = erl2(["doctor", "--this-flag-does-not-exist"]);
  assert.equal(result.body.ok, false);
  assert.equal(result.body.errors[0]?.code, "CFG_UNKNOWN_FLAG");
  assert.match(result.body.errors[0]?.message ?? "", /unknown flag/);
});

test("bare erl2 --help is unchanged: no command key, full command list and usage blob", () => {
  assert.equal(bareHelp.exitCode, 0);
  const data = bareHelp.body.data as { commands?: unknown; usage?: unknown; command?: unknown };
  assert.equal(data.command, undefined, "bare --help must not carry a single-command key");
  assert.ok(Array.isArray(data.commands));
  assert.ok(typeof data.usage === "object" && data.usage !== null);
});

// -- M2 §B: top-level `--version` ----------------------------------------------

test("erl2 --version exits 0 and reports the authoritative package version, with no arguments needed", () => {
  const result = erl2(["--version"]);
  assert.equal(result.exitCode, 0);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.errors.length, 0);
  assert.equal(result.body.run_id, undefined, "--version must not dispatch (run_id present)");
  assert.equal(result.body.state, undefined, "--version must not dispatch (state present)");
  const data = result.body.data as { version?: unknown };
  assert.equal(typeof data.version, "string");
  assert.ok((data.version as string).length > 0);
  // Independently read the same authoritative source (packages/cli/package.json)
  // the CLI itself reads, so this pins equality against the committed source of
  // truth rather than merely asserting the CLI is self-consistent.
  const packageJson = JSON.parse(
    readFileSync(path.join(repoRoot, "packages", "cli", "package.json"), "utf8"),
  ) as { version: string };
  assert.equal(data.version, packageJson.version);
  // No local paths or build-machine data leaked: the reported value is exactly
  // the semver-shaped package version, nothing else.
  assert.match(data.version as string, /^\d+\.\d+\.\d+/u);
});

test("erl2 --version performs no filesystem write and needs no run lease or dispatch", () => {
  const scratchParent = ownedTempDir("erl2-version-fs-");
  const before = snapshotTree(scratchParent);
  const result = erl2(["--version"]);
  const after = snapshotTree(scratchParent);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(after, before, "--version must not write anything beneath an unrelated scratch root");
});

test("erl2 --version refuses rather than silently discarding an additional flag", () => {
  // Precedence chosen and documented in packages/cli/src/index.ts: --version
  // accepts no additional arguments or flags at all, so a malformed
  // combination refuses instead of being ignored.
  const result = erl2(["--version", "--run-root", "/foo"]);
  assert.equal(result.body.ok, false);
  assert.equal(result.exitCode, 2);
  assert.equal(result.body.errors[0]?.code, "CFG_UNKNOWN_FLAG");
  assert.match(result.body.errors[0]?.message ?? "", /--version accepts no additional arguments or flags/);
});

test("erl2 --version=1.0.0 is a different literal token and refuses through the ordinary unknown-command path", () => {
  // This parser has never supported `--flag=value` syntax anywhere; `--version`
  // is checked by exact string equality against argv[0], so this is not a new
  // inconsistency, and precedence here matches --help=true/--help=false.
  const result = erl2(["--version=1.0.0"]);
  assert.equal(result.body.ok, false);
  assert.equal(result.exitCode, 2);
  assert.equal(result.body.errors[0]?.code, "CFG_UNKNOWN_FLAG");
  assert.match(result.body.errors[0]?.message ?? "", /unknown command --version=1\.0\.0/);
});

test("erl2 <command> --version is unaffected: no command declares its own --version flag today", () => {
  // Top-level --version is only recognised as argv[0]; a command-position
  // --version reaches that command's own parseFlags call unchanged, and none
  // of the 36 implemented commands declares "version" as one of its own flags
  // (confirmed by source grep), so this refuses exactly like any other unknown
  // flag on that command — pre-existing, unaffected behaviour.
  const result = erl2(["doctor", "--version"]);
  assert.equal(result.body.ok, false);
  assert.equal(result.exitCode, 2);
  assert.equal(result.body.errors[0]?.code, "CFG_UNKNOWN_FLAG");
  assert.match(result.body.errors[0]?.message ?? "", /unknown flag --version/);
});

// -- M2 §C: `help <command>` narrowing -----------------------------------------

test("help <command> returns the exact same object as <command> --help, for every authored-usage command", () => {
  for (const command of ["admit-adapter", "declare-trusted-local-adapter", "run-trusted-local-observation"]) {
    const viaHelp = erl2(["help", command]);
    const viaFlag = erl2([command, "--help"]);
    assert.equal(viaHelp.exitCode, 0, command);
    assert.deepEqual(viaHelp.body, viaFlag.body, `help ${command} must equal ${command} --help exactly`);
  }
});

test("help <command> returns the exact same object as <command> --help, for representative generic commands", () => {
  // Representative, not exhaustive: one from each family (bare vertical-slice,
  // journey, environment) that carries no authored COMMAND_USAGE entry.
  for (const command of ["status", "acquire", "provision", "journey"]) {
    const viaHelp = erl2(["help", command]);
    const viaFlag = erl2([command, "--help"]);
    assert.equal(viaHelp.exitCode, 0, command);
    assert.deepEqual(viaHelp.body, viaFlag.body, `help ${command} must equal ${command} --help exactly`);
  }
});

test("help <unrecognised-command> refuses through the existing unknown-command path instead of returning the generic listing", () => {
  const viaHelp = erl2(["help", "made-up-command"]);
  const viaBare = erl2(["made-up-command"]);
  assert.equal(viaHelp.body.ok, false);
  assert.equal(viaHelp.exitCode, 2);
  assert.equal(viaHelp.body.errors[0]?.code, viaBare.body.errors[0]?.code);
  assert.equal(viaHelp.body.errors[0]?.code, "CFG_UNKNOWN_FLAG");
  // Same refusal cause (code and message) as invoking the unknown command
  // directly; only the envelope's own top-level `command` field differs
  // (`"help"`, the command that was actually invoked, versus the unknown name
  // itself) because `help` — not the unrecognised name — is what dispatched.
  assert.equal(viaHelp.body.errors[0]?.message, viaBare.body.errors[0]?.message);
  assert.match(viaHelp.body.errors[0]?.message ?? "", /unknown command made-up-command/);
});

test("help <command> is case-sensitive, matching every other command-name comparison in this CLI", () => {
  const result = erl2(["help", "DOCTOR"]);
  assert.equal(result.body.ok, false);
  assert.equal(result.exitCode, 2);
  assert.equal(result.body.errors[0]?.code, "CFG_UNKNOWN_FLAG");
  assert.match(result.body.errors[0]?.message ?? "", /unknown command DOCTOR/);
});

test("help <command> extra refuses rather than silently discarding the extra argument", () => {
  const result = erl2(["help", "admit-adapter", "extra-arg"]);
  assert.equal(result.body.ok, false);
  assert.equal(result.exitCode, 2);
  assert.equal(result.body.errors[0]?.code, "CFG_UNKNOWN_FLAG");
  assert.match(result.body.errors[0]?.message ?? "", /help accepts at most one command name argument/);
});

test("bare erl2 help (no argument) is unchanged: the top-level listing, not a single command's help", () => {
  const result = erl2(["help"]);
  assert.equal(result.exitCode, 0);
  const data = result.body.data as { commands?: unknown; command?: unknown };
  assert.equal(data.command, undefined, "bare help must not carry a single-command key");
  assert.ok(Array.isArray(data.commands) && (data.commands as unknown[]).length > 0);
  assert.deepEqual(result.body, bareHelp.body, "erl2 help must equal erl2 --help exactly");
});

test("this CLI defines no command aliases, so help <command> narrowing has no alias case to cover", () => {
  // Recorded explicitly rather than left silent: IMPLEMENTED_COMMANDS is a Set
  // of 36 distinct names with no alternate spelling mapped to the same
  // dispatch target anywhere in packages/cli/src (confirmed by source grep for
  // "alias"), so `help <command>` narrowing needs no alias-equivalence case.
  assert.equal(COMMANDS.length, new Set(COMMANDS).size, "no two listed command names should collapse to one");
});

// -- M2 CI-timeout rider (roadmap MP-20) ---------------------------------------

test("both required CI jobs declare a bounded timeout-minutes, and required check names are unchanged", () => {
  // A plain string scan rather than a YAML parser: the smallest focused
  // assertion for the one property the M2 rider requires, not a general
  // workflow-testing framework.
  const workflowPath = path.join(repoRoot, ".github", "workflows", "pr.yml");
  const workflow = readFileSync(workflowPath, "utf8");
  const prStart = workflow.indexOf("\n  pr:\n");
  const goldenStart = workflow.indexOf("\n  cross-platform-golden:\n");
  assert.ok(prStart >= 0 && goldenStart > prStart, "expected both required jobs in pr.yml");
  const prJobBlock = workflow.slice(prStart, goldenStart);
  const goldenJobBlock = workflow.slice(goldenStart);
  assert.match(
    prJobBlock,
    /^ {4}timeout-minutes: 60\s*$/mu,
    "the `pr` job must declare a bounded timeout-minutes",
  );
  assert.match(
    goldenJobBlock,
    /^ {4}timeout-minutes: 10\s*$/mu,
    "the `cross-platform-golden` job must declare a bounded timeout-minutes",
  );
  // Required check names must survive untouched (ruleset 21102689 names them
  // exactly): `pr`, `cross-platform-golden (ubuntu-latest)`, `cross-platform-golden (macos-latest)`.
  assert.match(workflow, /\n {2}pr:\n/u, "the `pr` job name must be unchanged");
  assert.match(workflow, /\n {2}cross-platform-golden:\n/u, "the `cross-platform-golden` job name must be unchanged");
  assert.match(
    workflow,
    /os:\s*\[ubuntu-latest,\s*macos-latest\]/u,
    "the cross-platform-golden matrix legs must be unchanged",
  );
});

// -- M2 F-1: command-inventory authority ---------------------------------------
//
// The hardening below is what closes M2 F-1. Every assertion in this section
// draws the "expected" set from the imported production registry (REGISTRY_NAMES)
// and the "actual" set from the rendered top-level `--help` (COMMANDS): two
// independently produced surfaces. A command that is dispatchable but not
// rendered — or rendered but not dispatchable — breaks set equality here, which
// the original `--help`-only derivation could never detect.

test("F-1: the rendered top-level inventory equals the production dispatch registry, exactly", () => {
  // Two independent surfaces: REGISTRY_NAMES is imported from the CLI module
  // (the object runCommand dispatches through); COMMANDS is parsed out of a
  // spawned `erl2 --help`. Exact set equality in BOTH directions is the core
  // anti-F-1 invariant: no dispatchable-but-hidden command, and no
  // listed-but-undispatchable command, can survive it.
  const rendered = new Set(COMMANDS);
  const registry = new Set(REGISTRY_NAMES);
  const dispatchableButHidden = REGISTRY_NAMES.filter((name) => !rendered.has(name));
  const listedButUndispatchable = COMMANDS.filter((name) => !registry.has(name));
  assert.deepEqual(
    dispatchableButHidden,
    [],
    `every dispatchable command must appear in top-level --help; hidden: ${JSON.stringify(dispatchableButHidden)}`,
  );
  assert.deepEqual(
    listedButUndispatchable,
    [],
    `every listed command must be backed by a dispatch registry entry; unbacked: ${JSON.stringify(listedButUndispatchable)}`,
  );
  // The set-equality statement itself, so a future reader sees the whole claim
  // in one line rather than only its two decompositions.
  assert.deepEqual([...registry].sort(), [...rendered].sort(), "registry and rendered inventory must be the same set");
});

test("F-1: neither the registry nor the rendered inventory contains a duplicate command", () => {
  assert.equal(REGISTRY_NAMES.length, new Set(REGISTRY_NAMES).size, "the dispatch registry must have no duplicate name");
  assert.equal(COMMANDS.length, new Set(COMMANDS).size, "the rendered inventory must have no duplicate name");
});

test("F-1: the rendered public inventory is in a deterministic, sorted order", () => {
  // The listing is intentionally public and stable (`[...IMPLEMENTED_COMMANDS].sort()`);
  // an unexpected reorder — e.g. reverting to insertion order — is a contract break.
  assert.deepEqual(COMMANDS, [...COMMANDS].sort(), "top-level --help must list commands in sorted order");
});

test("F-1: every registry command is dispatchable — recognised, never refused as an unknown command", () => {
  // Independent of --help: iterate the REGISTRY and prove each name reaches its
  // handler. A registered command may still refuse (missing required flags, an
  // unshipped slice), but it must NOT be rejected by the terminal
  // unknown-command path — that would mean a registry entry with no dispatch.
  for (const command of REGISTRY_NAMES) {
    const result = erl2([command]);
    const first = result.body.errors[0];
    const isUnknownCommand =
      first?.code === "CFG_UNKNOWN_FLAG" && /unknown command/.test(first?.message ?? "");
    assert.equal(isUnknownCommand, false, `${command} is in the registry but was refused as an unknown command`);
  }
});

test("F-1: every registry command answers its own --help, independently of the rendered listing", () => {
  // The same clean-help guarantee the suite already checks for COMMANDS, but
  // driven from REGISTRY_NAMES. If a command were ever dispatchable yet dropped
  // from the rendered listing, the --help-derived loop above would skip it;
  // this loop would not.
  for (const command of REGISTRY_NAMES) {
    const result = erl2([command, "--help"]);
    assert.equal(result.exitCode, 0, `${command} --help: ${JSON.stringify(result.body.errors)}`);
    assert.equal(result.body.ok, true, `${command} --help should succeed`);
    assert.equal(result.body.run_id, undefined, `${command} --help must not dispatch (run_id present)`);
    assert.equal(result.body.state, undefined, `${command} --help must not dispatch (state present)`);
    const data = result.body.data as { command?: unknown; usage?: unknown } | undefined;
    assert.equal(data?.command, command, `${command} --help should name the command it is for`);
    assert.ok(data?.usage !== undefined, `${command} --help should carry a usage object`);
  }
});

test("F-1: every command carrying authored usage is in the dispatch registry", () => {
  // The authored-usage set is a subset of the inventory, so it must also be a
  // subset of the registry; a command documented but not dispatchable would be
  // a dead entry.
  const usageBlob = (bareHelp.body.data as { usage?: Record<string, unknown> }).usage ?? {};
  for (const command of Object.keys(usageBlob)) {
    assert.ok(
      REGISTRY_NAMES.includes(command),
      `authored-usage command ${command} must be backed by a dispatch registry entry`,
    );
  }
});
