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
import { existsSync } from "node:fs";
import path from "node:path";
import { erl2 } from "../support/cliRun.js";
import { ownedTempDir } from "../support/tempDirs.js";

const bareHelp = erl2(["--help"]);
const COMMANDS = ((bareHelp.body.data as { commands?: unknown } | undefined)?.commands ?? []) as string[];

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

test("a command with no authored usage still answers, pointing at the runbooks rather than staying silent", () => {
  // `provision` (the environment branch) has no COMMAND_USAGE entry; it must
  // still answer rather than refuse, and the fallback must not be empty.
  const result = erl2(["provision", "--help"]);
  const data = result.body.data as { usage?: { summary?: string } };
  assert.ok(typeof data.usage?.summary === "string" && data.usage.summary.length > 0);
  assert.match(data.usage.summary, /runbooks/);
});

test("--help performs no filesystem write, even when a scratch directory is named as --run-root", () => {
  const scratchParent = ownedTempDir("erl2-help-fs-");
  const neverCreated = path.join(scratchParent, "should-not-exist");
  const result = erl2(["provision", "--run-root", neverCreated, "--help"]);
  assert.equal(result.exitCode, 0);
  assert.equal(existsSync(neverCreated), false, "--help must not create the run root it was merely told about");
});

test("--help performs no filesystem write, even when a scratch directory is named as --output-root", () => {
  const scratchParent = ownedTempDir("erl2-help-fs-");
  const neverCreated = path.join(scratchParent, "should-not-exist");
  const result = erl2(["run-trusted-local-observation", "--output-root", neverCreated, "--help"]);
  assert.equal(result.exitCode, 0);
  assert.equal(existsSync(neverCreated), false, "--help must not create the output root it was merely told about");
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
