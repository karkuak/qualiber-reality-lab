/**
 * Only `ENOENT` means "never provisioned" (review P1-12, ADR-ERL2-024 §4.2).
 *
 * ## The defect
 *
 * `FileSubstrateStore.load` wrapped every read in `catch { return undefined }`,
 * and `undefined` is the answer that means "this run was never provisioned
 * here". So a permission fault, an `EISDIR`, a truncated file or an ordinary I/O
 * error all presented as an empty substrate — and `destroy` then reported a
 * clean teardown over resources it had never looked at.
 *
 * The first pass at this file removed the `catch` and kept a second, quieter
 * copy of the same fail-open one layer in:
 *
 * ```ts
 * resources: Array.isArray(value.resources) ? value.resources : [],
 * mutations: Array.isArray(value.mutations) ? value.mutations : [],
 * ```
 *
 * Every document that was not substrate state — `{}`, `{"resources":"gone"}`, a
 * JSON array, a half-written temp file promoted by a crash — became a substrate
 * with no resources and no mutations in it. These tests exist because that is
 * indistinguishable, at the point where it matters, from the `catch` that had
 * already been removed.
 *
 * ## How the cases are built
 *
 * Six through the real filesystem, one through a deterministic I/O seam. The
 * seam is not there to avoid the filesystem: it is there because an *arbitrary*
 * fault is what the invariant is about, and because a permission test run as
 * root silently passes without testing anything. The real-filesystem cases stay
 * alongside it, and the mode-based one asserts up front that it is not running
 * as a user who can read a mode-0 file anyway.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FileSubstrateStore, type SubstrateIo } from "@erl2/core";
import { erl2 } from "../support/cliRun.js";
import {
  drive,
  phaseIndex,
  producedRoles,
  selectedRun,
  substrateRootOf,
} from "../support/environmentCli.js";

const RUN = "01890000-0000-7000-8000-0000000000aa";

function freshRoot(label: string): string {
  return mkdtempSync(path.join(tmpdir(), `erl2-substrate-${label}-`));
}

/** The state file a store would use for `RUN`, without asking the store. */
function stateFile(root: string): string {
  return path.join(root, `${Buffer.from(RUN, "utf8").toString("base64url")}.substrate.json`);
}

function refusalCode(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

test("SUBSTRATE-ERRORS: a missing state file is the only thing that means `never provisioned`", () => {
  const store = new FileSubstrateStore(freshRoot("absent"));
  assert.equal(store.load(RUN), undefined);
  // And the same for the identity marker: a fresh substrate has no identity,
  // which is what makes the P0-1 substitution detectable rather than invisible.
  assert.equal(store.instance(), undefined);
});

test("SUBSTRATE-ERRORS: malformed JSON is a typed corruption refusal, not an empty substrate", () => {
  const root = freshRoot("malformed");
  const store = new FileSubstrateStore(root);
  store.save(RUN, { resources: [], mutations: [] });
  writeFileSync(stateFile(root), '{"resources": [');
  assert.equal(refusalCode(() => store.load(RUN)), "ENV_SUBSTRATE_UNREADABLE");
});

test("SUBSTRATE-ERRORS: truncated state is a typed corruption refusal", () => {
  const root = freshRoot("truncated");
  const store = new FileSubstrateStore(root);
  store.save(RUN, { resources: [], mutations: ["m-1"] });
  const whole = readFileSync(stateFile(root), "utf8");
  writeFileSync(stateFile(root), whole.slice(0, Math.floor(whole.length / 2)));
  assert.equal(refusalCode(() => store.load(RUN)), "ENV_SUBSTRATE_UNREADABLE");
});

test("SUBSTRATE-ERRORS: a document that is not substrate state fails closed rather than reading as empty", () => {
  // The second fail-open. Every one of these parsed cleanly and coerced to
  // `{ resources: [], mutations: [] }` — an answer that says the run has no
  // environment, from bytes that say nothing of the kind.
  const root = freshRoot("shape");
  const store = new FileSubstrateStore(root);
  store.save(RUN, { resources: [], mutations: [] });
  for (const document of [
    "{}",
    '{"version": 1, "resources": "gone"}',
    '{"version": 1, "resources": [], "mutations": "none"}',
    '{"version": 1, "resources": [], "mutations": [7]}',
    '{"version": 1, "resources": [], "mutations": [], "operations": []}',
    '{"version": 1, "resources": [], "mutations": [], "instanceHash": 3}',
    "[]",
    '"a string"',
    "null",
  ]) {
    writeFileSync(stateFile(root), document);
    assert.equal(
      refusalCode(() => store.load(RUN)),
      "ENV_SUBSTRATE_UNREADABLE",
      `${document} must not read as an empty substrate`,
    );
  }
});

test("SUBSTRATE-ERRORS: an unsupported shape version fails closed", () => {
  const root = freshRoot("version");
  const store = new FileSubstrateStore(root);
  store.save(RUN, { resources: [], mutations: [] });
  const written = JSON.parse(readFileSync(stateFile(root), "utf8")) as Record<string, unknown>;
  assert.equal(written["version"], 1, "the store writes the version it will demand back");
  for (const version of [0, 2, "1", null]) {
    writeFileSync(stateFile(root), JSON.stringify({ ...written, version }));
    assert.equal(
      refusalCode(() => store.load(RUN)),
      "ENV_SUBSTRATE_UNREADABLE",
      `version ${JSON.stringify(version)} must fail closed`,
    );
  }
});

test("SUBSTRATE-ERRORS: a directory where the state file belongs is a typed I/O refusal", () => {
  const root = freshRoot("eisdir");
  const store = new FileSubstrateStore(root);
  mkdirSync(stateFile(root), { recursive: true });
  assert.equal(refusalCode(() => store.load(RUN)), "ENV_SUBSTRATE_UNREADABLE");

  // And the same for the marker, which used to be probed with `existsSync` —
  // which answers false for an unreadable parent as readily as for an absent
  // file, so an I/O fault could present as a substrate with no identity.
  const markerRoot = freshRoot("eisdir-marker");
  const markerStore = new FileSubstrateStore(markerRoot);
  mkdirSync(path.join(markerRoot, "substrate-instance.json"), { recursive: true });
  assert.equal(refusalCode(() => markerStore.instance()), "ENV_SUBSTRATE_UNREADABLE");
});

test("SUBSTRATE-ERRORS: an unreadable state file is a typed I/O refusal", (t) => {
  const root = freshRoot("eacces");
  const store = new FileSubstrateStore(root);
  store.save(RUN, { resources: [], mutations: [] });
  chmodSync(stateFile(root), 0o000);
  // A privileged user reads a mode-0 file regardless, and a test that quietly
  // passes for that reason is worse than no test. The deterministic case below
  // covers the same invariant without depending on who is running.
  let readable = true;
  try {
    readFileSync(stateFile(root), "utf8");
  } catch {
    readable = false;
  }
  if (readable) {
    t.skip("running as a user who can read a mode-0 file; the seam case covers this");
    return;
  }
  assert.equal(refusalCode(() => store.load(RUN)), "ENV_SUBSTRATE_UNREADABLE");
});

test("SUBSTRATE-ERRORS: an arbitrary injected I/O fault is a typed refusal, whatever the errno", () => {
  // The invariant is about *every* non-ENOENT condition, not the three a test
  // can arrange with file modes. Each of these is a real errno a filesystem can
  // raise, and none of them may read as an empty substrate.
  for (const code of ["EACCES", "EIO", "EMFILE", "ELOOP", "ENOTDIR", "EBUSY", "ENAMETOOLONG"]) {
    const failing: SubstrateIo = {
      readFile: () => {
        const error = new Error(`injected ${code}`) as NodeJS.ErrnoException;
        error.code = code;
        throw error;
      },
      writeFile: () => undefined,
      rename: () => undefined,
      mkdirp: () => undefined,
    };
    const store = new FileSubstrateStore(freshRoot(`io-${code}`), failing);
    assert.equal(
      refusalCode(() => store.load(RUN)),
      "ENV_SUBSTRATE_UNREADABLE",
      `${code} must fail closed`,
    );
    assert.equal(refusalCode(() => store.instance()), "ENV_SUBSTRATE_UNREADABLE");
  }
});

test("SUBSTRATE-ERRORS: an ENOENT from the seam is still `never provisioned`", () => {
  // The counterpart the suite would be worthless without: the narrow case must
  // stay narrow, or the fix is just "refuse everything".
  const absent: SubstrateIo = {
    readFile: () => {
      const error = new Error("injected ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    },
    writeFile: () => undefined,
    rename: () => undefined,
    mkdirp: () => undefined,
  };
  const store = new FileSubstrateStore(freshRoot("io-enoent"), absent);
  assert.equal(store.load(RUN), undefined);
  assert.equal(store.instance(), undefined);
});

test("SUBSTRATE-ERRORS: a write fault is typed and does not leak the substrate path", () => {
  const failing: SubstrateIo = {
    readFile: () => {
      const error = new Error("absent") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    },
    writeFile: () => {
      throw new Error("/private/var/folders/secret-host-path: disk full");
    },
    rename: () => undefined,
    mkdirp: () => undefined,
  };
  const store = new FileSubstrateStore(freshRoot("write"), failing);
  try {
    store.save(RUN, { resources: [], mutations: [] });
    assert.fail("a write fault must not be silent");
  } catch (error) {
    assert.equal((error as { code?: string }).code, "ENV_SUBSTRATE_UNREADABLE");
    assert.ok(
      !(error as Error).message.includes("/private/var/folders"),
      "the refusal message must not carry a host path into a CLI envelope",
    );
  }
});

test("SUBSTRATE-ERRORS: an unreadable substrate never yields a clean teardown", () => {
  // The end-to-end consequence, driven through the shipped binary: this is what
  // "no `never provisioned` interpretation is permitted" actually protects.
  const run = selectedRun();
  drive(run, phaseIndex(run, "restore"));
  const substrate = substrateRootOf(run);
  const file = readdirSync(substrate).find((name) => name.endsWith(".substrate.json"));
  assert.ok(file !== undefined, "the run must have durable substrate state to corrupt");
  const live = JSON.parse(readFileSync(path.join(substrate, file), "utf8")) as {
    resources: unknown[];
  };
  assert.ok(live.resources.length > 0, "the environment must still hold resources");

  writeFileSync(path.join(substrate, file), '{"resources": [}');

  const restored = erl2(["restore", ...run.base]);
  assert.notEqual(restored.exitCode, 0, "restore must refuse an unreadable substrate");
  assert.equal(
    restored.body.errors[0]?.code,
    "ENV_SUBSTRATE_UNREADABLE",
    JSON.stringify(restored.body.errors),
  );
  // The rest of the branch stays shut behind it. `destroy` and
  // `finalize-generic` refuse on their departure state, because the phase that
  // would have advanced it refused first — which is the correct order and the
  // reason a substrate fault cannot be walked past.
  for (const command of ["destroy", "finalize-generic"]) {
    const result = erl2([command, ...run.base]);
    assert.notEqual(result.exitCode, 0, `${command} must not proceed past a substrate fault`);
  }

  const roles = new Set(producedRoles(run));
  assert.ok(!roles.has("environment-restoration"), "no restoration may be recorded");
  assert.ok(!roles.has("teardown-verification"), "teardown must not report zero residue");
  assert.ok(!roles.has("final-attestation"), "no bundle may be emitted");
});
