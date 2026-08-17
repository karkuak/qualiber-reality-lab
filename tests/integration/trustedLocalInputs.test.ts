/**
 * Host-provisioned inputs for a trusted-local observation.
 *
 * The property under test is not "the runner copied a file". It is that the
 * bytes an adapter can read are the bytes the operator bound, that the plan is
 * the only ledger of what should be there, and that every way of getting that
 * wrong is a refusal which leaves nothing behind.
 *
 * The end-to-end cases run the shipped CLI in a fresh process against a neutral
 * observer that reads its mounts back and reports the digests it saw, so a pass
 * means an actual separate process actually read the actual bytes. A fixture
 * that returned a constant would pass whether or not anything reached the
 * mount, which is why the adapter fails the operation on a mismatch as well.
 */

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { CODES } from "@erl2/contracts";
import { coreHash, hashBytes } from "@erl2/integrity";
import {
  TRUSTED_LOCAL_ACKNOWLEDGEMENT_TOKEN,
  TRUSTED_LOCAL_INPUT_CEILINGS,
  materializeTrustedLocalInputs,
  trustedLocalInputMappings,
  verifyRetainedTrustedLocalInputs,
  verifyTrustedLocalObservationRecord,
} from "@erl2/core";
import { runCommand } from "@erl2/cli";
import { ownedTempDir } from "../support/tempDirs.js";
import { repoRoot } from "../support/adapterFixtures.js";
import {
  INPUT_READER_PLAN,
  TRUSTED_LOCAL_INPUT_BYTES,
  TRUSTED_LOCAL_INPUT_ID,
  TRUSTED_LOCAL_INPUT_MOUNT,
  trustedLocalPlanInput,
  writeTrustedLocalInputs,
} from "../support/trustedLocalFixtures.js";

const CLI = path.join(repoRoot, "packages", "cli", "dist", "src", "bin.js");

interface CliRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly json: Record<string, unknown>;
}

/** Runs the shipped CLI binary in a fresh process, as an operator would. */
function cli(argv: readonly string[]): CliRun {
  const child = spawnSync(process.execPath, [CLI, ...argv], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(child.stdout) as Record<string, unknown>;
  } catch {
    json = { unparsed: child.stdout.slice(0, 512), stderr: child.stderr.slice(0, 512) };
  }
  return { status: child.status, stdout: child.stdout, json };
}

/** Every file beneath a root, as slash-separated relative paths. */
function tree(root: string): readonly string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const child = path.join(dir, name);
      const relative = prefix === "" ? name : `${prefix}/${name}`;
      if (statSync(child).isDirectory()) walk(child, relative);
      else out.push(relative);
    }
  };
  walk(root, "");
  return out;
}

/** The observation the input-reading adapter wrote, wherever the host froze it. */
function observedInputs(outputRoot: string): Record<string, unknown> {
  const found = tree(outputRoot).filter((entry) => entry.endsWith("observed-inputs.json"));
  assert.ok(found.length > 0, "the adapter wrote no observation of its inputs");
  return JSON.parse(readFileSync(path.join(outputRoot, found[0] as string), "utf8")) as Record<
    string,
    unknown
  >;
}

/** The whole offline verification, over one run's retained output root. */
function verifyTrustedLocal(
  outputRoot: string,
  entryPath: string,
): ReturnType<typeof verifyTrustedLocalObservationRecord> {
  return verifyTrustedLocalObservationRecord({
    recordBytes: readFileSync(path.join(outputRoot, "trusted-local-observation-record.json")),
    planBytes: readFileSync(path.join(outputRoot, "observation-plan.json")),
    registryRoot: path.join(outputRoot, "registry"),
    adapterEntryPath: entryPath,
    retainedInputRoot: path.join(outputRoot, "inputs"),
  });
}

/** Nothing durable was retained: no inputs, no admission registry, no record. */
function assertNothingRetained(outputRoot: string): void {
  assert.equal(existsSync(path.join(outputRoot, "inputs")), false, "an input tree survived");
  assert.equal(existsSync(path.join(outputRoot, "registry")), false, "admission bytes survived");
  assert.equal(
    existsSync(path.join(outputRoot, "trusted-local-observation-record.json")),
    false,
    "a run record survived",
  );
}

// ---------------------------------------------------------------------------
// 1 & 2. The adapter reads the exact bound bytes, and several files share one
// mount.
// ---------------------------------------------------------------------------

test("TRUSTED-LOCAL-INPUT: a fresh-process adapter reads the exact bound bytes through one shared mount", () => {
  const root = ownedTempDir("erl2-tli-read-");
  const first = Buffer.from("first bound fixture\n", "utf8");
  const second = Buffer.from("second bound fixture, same mount\n", "utf8");
  const inputs = writeTrustedLocalInputs(root, INPUT_READER_PLAN, {
    fixture: "input-reader",
    planOverrides: {
      inputs: [
        trustedLocalPlanInput({ inputId: "first-input", relativePath: "a/first.bin", bytes: first }),
        trustedLocalPlanInput({
          inputId: "second-input",
          relativePath: "b/second.bin",
          bytes: second,
        }),
      ],
    },
    sourceBytes: new Map([
      ["first-input", first],
      ["second-input", second],
    ]),
  });

  const ran = cli([
    "run-trusted-local-observation",
    "--adapter-entry", inputs.entryPath,
    "--manifest", inputs.manifestPath,
    "--plan", inputs.planPath,
    "--owner-declaration", inputs.declarationPath,
    "--output-root", inputs.outputRoot,
    ...inputs.bindArgs,
  ]);
  assert.equal(ran.status, 0, ran.stdout.slice(0, 2000));
  const data = ran.json["data"] as Record<string, unknown>;
  assert.equal(data["terminal_status"], "observed_complete");
  assert.equal((data["offline_verification"] as { ok: boolean }).ok, true);

  // Two inputs, one mount, one mount root — named to the adapter as the mount
  // itself and never as either artifact path.
  const mounts = data["input_mounts"] as readonly Record<string, unknown>[];
  assert.equal(mounts.length, 1, "two files in one mount must produce one mount");
  assert.equal(mounts[0]?.["mount_id"], TRUSTED_LOCAL_INPUT_MOUNT);
  assert.equal(
    mounts[0]?.["logical_path"],
    `observation-inputs/${TRUSTED_LOCAL_INPUT_MOUNT}`,
    "the logical path must be the mount root, not an artifact path",
  );
  assert.equal(mounts[0]?.["mode"], "read_only");
  assert.equal(mounts[0]?.["purpose"], "subject-visible-input");

  // The retained tree is exactly the two files, at the convention's paths.
  assert.deepEqual(tree(String(data["retained_input_root"])), [
    `${TRUSTED_LOCAL_INPUT_MOUNT}/a/first.bin`,
    `${TRUSTED_LOCAL_INPUT_MOUNT}/b/second.bin`,
  ]);

  // And what the *adapter* saw, in its own separate process.
  const observed = observedInputs(inputs.outputRoot);
  const seen = observed["inputs"] as readonly Record<string, unknown>[];
  assert.equal(seen.length, 2);
  const byId = new Map(seen.map((entry) => [String(entry["input_id"]), entry]));
  assert.equal(byId.get("first-input")?.["observed_sha256"], hashBytes(first));
  assert.equal(byId.get("second-input")?.["observed_sha256"], hashBytes(second));
  assert.equal(byId.get("first-input")?.["observed_prefix_utf8"], first.toString("utf8"));
  assert.equal(byId.get("second-input")?.["observed_prefix_utf8"], second.toString("utf8"));
  const listings = observed["mount_listings"] as readonly Record<string, unknown>[];
  assert.equal(listings.length, 1);
  assert.deepEqual(listings[0]?.["files"], ["a/first.bin", "b/second.bin"]);
});

// ---------------------------------------------------------------------------
// 3 & 4. Digest and length mismatches, before anything durable exists.
// ---------------------------------------------------------------------------

test("TRUSTED-LOCAL-INPUT: a sha-256 mismatch refuses before admission, host or record", () => {
  const root = ownedTempDir("erl2-tli-digest-");
  const inputs = writeTrustedLocalInputs(root, INPUT_READER_PLAN, {
    fixture: "input-reader",
    planOverrides: {
      inputs: [trustedLocalPlanInput({ fileSha256: `sha256:${"b".repeat(64)}` })],
    },
  });
  const refused = runCommand([
    "run-trusted-local-observation",
    "--adapter-entry", inputs.entryPath,
    "--manifest", inputs.manifestPath,
    "--plan", inputs.planPath,
    "--owner-declaration", inputs.declarationPath,
    "--output-root", inputs.outputRoot,
    ...inputs.bindArgs,
  ]);
  assert.equal(refused.ok, false);
  assert.equal(refused.errors?.[0]?.code, CODES.ARTIFACT_HASH_MISMATCH);
  assert.match(String(refused.errors?.[0]?.message), /hashes to/);
  assertNothingRetained(inputs.outputRoot);
});

test("TRUSTED-LOCAL-INPUT: a byte-length mismatch refuses before admission, host or record", () => {
  const root = ownedTempDir("erl2-tli-length-");
  // The digest is the real one, so only the declared length is wrong. Checked
  // separately because a length taken from the bytes rather than compared
  // against the plan would pass every digest case and still be a defect.
  const inputs = writeTrustedLocalInputs(root, INPUT_READER_PLAN, {
    fixture: "input-reader",
    planOverrides: { inputs: [trustedLocalPlanInput({ byteLength: 4096 })] },
  });
  const refused = runCommand([
    "run-trusted-local-observation",
    "--adapter-entry", inputs.entryPath,
    "--manifest", inputs.manifestPath,
    "--plan", inputs.planPath,
    "--owner-declaration", inputs.declarationPath,
    "--output-root", inputs.outputRoot,
    ...inputs.bindArgs,
  ]);
  assert.equal(refused.ok, false);
  assert.equal(refused.errors?.[0]?.code, CODES.ARTIFACT_HASH_MISMATCH);
  assert.match(String(refused.errors?.[0]?.message), /bytes; the plan declares/);
  assertNothingRetained(inputs.outputRoot);
});

// ---------------------------------------------------------------------------
// 5. Every shape of a wrong binding set.
// ---------------------------------------------------------------------------

test("TRUSTED-LOCAL-INPUT: missing, duplicate, unknown, extra, malformed, relative and ineligible bindings all refuse", () => {
  const root = ownedTempDir("erl2-tli-bindings-");
  const inputs = writeTrustedLocalInputs(root, INPUT_READER_PLAN, {
    fixture: "input-reader",
    planOverrides: {
      inputs: [
        trustedLocalPlanInput({}),
        {
          input_id: "acquired-input",
          role: "package-input",
          provenance_mode: "acquired" as const,
          expected_package_kind: "archive" as const,
        },
      ],
    },
  });
  const source = inputs.boundSources.get(TRUSTED_LOCAL_INPUT_ID) as string;
  const run = (bind: readonly string[], outputName: string): ReturnType<typeof runCommand> =>
    runCommand([
      "run-trusted-local-observation",
      "--adapter-entry", inputs.entryPath,
      "--manifest", inputs.manifestPath,
      "--plan", inputs.planPath,
      "--owner-declaration", inputs.declarationPath,
      "--output-root", path.join(root, outputName),
      ...bind,
    ]);

  const cases: readonly {
    readonly name: string;
    readonly bind: readonly string[];
    readonly code: string;
    readonly message: RegExp;
  }[] = [
    {
      name: "missing",
      bind: [],
      code: CODES.CFG_MISSING_REQUIRED,
      message: /needs a --bind-input binding; missing: package-input/,
    },
    {
      name: "duplicate",
      bind: [
        "--bind-input", `${TRUSTED_LOCAL_INPUT_ID}=${source}`,
        "--bind-input", `${TRUSTED_LOCAL_INPUT_ID}=${source}`,
      ],
      code: CODES.CFG_DUPLICATE_FLAG,
      message: /more than once/,
    },
    {
      name: "unknown",
      bind: [
        "--bind-input", `${TRUSTED_LOCAL_INPUT_ID}=${source}`,
        "--bind-input", `no-such-input=${source}`,
      ],
      code: CODES.CFG_UNKNOWN_FLAG,
      message: /does not declare as an input/,
    },
    {
      name: "ineligible",
      bind: [
        "--bind-input", `${TRUSTED_LOCAL_INPUT_ID}=${source}`,
        "--bind-input", `acquired-input=${source}`,
      ],
      code: CODES.CFG_UNKNOWN_FLAG,
      message: /provenance_mode acquired/,
    },
    {
      name: "malformed",
      bind: ["--bind-input", source],
      code: CODES.CFG_MISSING_REQUIRED,
      message: /is malformed/,
    },
    {
      name: "empty input id",
      bind: ["--bind-input", `=${source}`],
      code: CODES.CFG_MISSING_REQUIRED,
      message: /is malformed/,
    },
    {
      name: "empty source",
      bind: ["--bind-input", `${TRUSTED_LOCAL_INPUT_ID}=`],
      code: CODES.CFG_MISSING_REQUIRED,
      message: /is malformed/,
    },
    {
      name: "relative source path",
      bind: ["--bind-input", `${TRUSTED_LOCAL_INPUT_ID}=./bound-sources/package-input.bin`],
      code: CODES.PATH_INVALID_COMPONENT,
      message: /absolute source path/,
    },
  ];

  for (const [index, entry] of cases.entries()) {
    const refused = run(entry.bind, `refused-${String(index)}`);
    assert.equal(refused.ok, false, `${entry.name} must refuse`);
    assert.equal(refused.errors?.[0]?.code, entry.code, `${entry.name} refused with the wrong code`);
    assert.match(String(refused.errors?.[0]?.message), entry.message, entry.name);
    assert.equal(
      existsSync(path.join(root, `refused-${String(index)}`, "inputs")),
      false,
      `${entry.name} left an input tree behind`,
    );
  }
});

test("TRUSTED-LOCAL-INPUT: a symlinked, directory or self-sourced binding refuses", () => {
  const root = ownedTempDir("erl2-tli-source-");
  const inputs = writeTrustedLocalInputs(root, INPUT_READER_PLAN, { fixture: "input-reader" });
  const source = inputs.boundSources.get(TRUSTED_LOCAL_INPUT_ID) as string;

  const link = path.join(root, "source-link.bin");
  symlinkSync(source, link);
  const directory = path.join(root, "source-directory");
  mkdirSync(directory, { recursive: true });

  // A source inside the output root the run is about to write: a run may not
  // provision itself from its own evidence tree.
  const selfSourced = path.join(inputs.outputRoot, "self-source.bin");
  mkdirSync(inputs.outputRoot, { recursive: true });
  writeFileSync(selfSourced, TRUSTED_LOCAL_INPUT_BYTES);

  const cases: readonly { readonly name: string; readonly source: string; readonly code: string }[] = [
    { name: "symlink", source: link, code: CODES.PATH_SYMLINK_REJECTED },
    { name: "directory", source: directory, code: CODES.PATH_NOT_REGULAR_FILE },
    { name: "inside the output root", source: selfSourced, code: CODES.ADAPTER_MOUNT_FORBIDDEN },
    { name: "absent", source: path.join(root, "not-here.bin"), code: CODES.CFG_MISSING_REQUIRED },
  ];
  for (const [index, entry] of cases.entries()) {
    const refused = runCommand([
      "run-trusted-local-observation",
      "--adapter-entry", inputs.entryPath,
      "--manifest", inputs.manifestPath,
      "--plan", inputs.planPath,
      "--owner-declaration", inputs.declarationPath,
      "--output-root", index === 2 ? inputs.outputRoot : path.join(root, `src-${String(index)}`),
      "--bind-input", `${TRUSTED_LOCAL_INPUT_ID}=${entry.source}`,
    ]);
    assert.equal(refused.ok, false, `a ${entry.name} source must refuse`);
    assert.equal(refused.errors?.[0]?.code, entry.code, `${entry.name} refused with the wrong code`);
  }
});

// ---------------------------------------------------------------------------
// 6. Logical paths the convention cannot express.
// ---------------------------------------------------------------------------

test("TRUSTED-LOCAL-INPUT: traversal, escape, a mount root and a destination collision refuse", () => {
  const bytes = TRUSTED_LOCAL_INPUT_BYTES;
  const root = ownedTempDir("erl2-tli-paths-");
  const source = path.join(root, "source.bin");
  writeFileSync(source, bytes);

  const attempt = (
    planInputs: readonly ReturnType<typeof trustedLocalPlanInput>[],
    name: string,
  ): { readonly ok: boolean; readonly code: string | undefined; readonly message: string | undefined } => {
    const caseRoot = path.join(root, name);
    const inputs = writeTrustedLocalInputs(caseRoot, INPUT_READER_PLAN, {
      fixture: "input-reader",
      planOverrides: { inputs: [...planInputs] },
    });
    const result = runCommand([
      "run-trusted-local-observation",
      "--adapter-entry", inputs.entryPath,
      "--manifest", inputs.manifestPath,
      "--plan", inputs.planPath,
      "--owner-declaration", inputs.declarationPath,
      "--output-root", inputs.outputRoot,
      ...planInputs.flatMap((input) => ["--bind-input", `${input.input_id}=${source}`]),
    ]);
    return { ok: result.ok, code: result.errors?.[0]?.code, message: result.errors?.[0]?.message };
  };

  // Outside the plan's own input root.
  const escaped = attempt(
    [trustedLocalPlanInput({ logicalPath: "somewhere-else/mount/file.bin", bytes })],
    "escaped",
  );
  assert.equal(escaped.ok, false);
  assert.equal(escaped.code, CODES.PATH_ESCAPES_ROOT);

  // A mount root rather than a file inside one.
  const mountRoot = attempt(
    [trustedLocalPlanInput({ logicalPath: "observation-inputs/only-a-mount", bytes })],
    "mount-root",
  );
  assert.equal(mountRoot.ok, false);
  assert.equal(mountRoot.code, CODES.PATH_INVALID_COMPONENT);
  assert.match(String(mountRoot.message), /mount root rather than a file/);

  // Two inputs, one destination.
  const collision = attempt(
    [
      trustedLocalPlanInput({ inputId: "one", relativePath: "shared.bin", bytes }),
      trustedLocalPlanInput({ inputId: "two", relativePath: "shared.bin", bytes }),
    ],
    "collision",
  );
  assert.equal(collision.ok, false);
  assert.equal(collision.code, CODES.PATH_INVALID_COMPONENT);
  assert.match(String(collision.message), /collide on retained destination/);

  // Traversal is refused by the contract's own LogicalPath pattern before this
  // module sees it, and by this module if it ever arrives another way. Both
  // paths are checked: the plan below cannot even be sealed.
  assert.throws(
    () =>
      writeTrustedLocalInputs(path.join(root, "traversal"), INPUT_READER_PLAN, {
        fixture: "input-reader",
        planOverrides: {
          inputs: [trustedLocalPlanInput({ logicalPath: "observation-inputs/../escape.bin", bytes })],
        },
      }),
    /must match pattern/,
    "a traversing logical path must not produce a valid plan",
  );
});

test("TRUSTED-LOCAL-INPUT: a traversing logical path is refused by the mapper itself", () => {
  // The contract refuses this shape first, so the mapper is exercised directly
  // — a defence that only ever runs behind another defence is a defence nobody
  // has measured.
  const root = ownedTempDir("erl2-tli-mapper-");
  const inputs = writeTrustedLocalInputs(root, INPUT_READER_PLAN, { fixture: "input-reader" });
  const traversing = {
    ...inputs.plan,
    inputs: [trustedLocalPlanInput({ logicalPath: "observation-inputs/../escape.bin" })],
  };
  assert.throws(
    () => trustedLocalInputMappings(traversing as typeof inputs.plan),
    (error: { code?: string }) => error.code === CODES.PATH_ESCAPES_ROOT,
  );

  const emptyMount = {
    ...inputs.plan,
    inputs: [trustedLocalPlanInput({ logicalPath: "observation-inputs/mount//file.bin" })],
  };
  assert.throws(
    () => trustedLocalInputMappings(emptyMount as typeof inputs.plan),
    (error: { code?: string }) => error.code === CODES.PATH_INVALID_COMPONENT,
  );
});

// ---------------------------------------------------------------------------
// 7. The materialization ceilings.
// ---------------------------------------------------------------------------

test("TRUSTED-LOCAL-INPUT: the input-count, single-size and aggregate-size ceilings refuse safely", () => {
  const root = ownedTempDir("erl2-tli-ceilings-");
  const bytes = Buffer.from("0123456789abcdef", "utf8");
  const source = path.join(root, "source.bin");
  writeFileSync(source, bytes);
  const base = writeTrustedLocalInputs(path.join(root, "base"), INPUT_READER_PLAN, {
    fixture: "input-reader",
  });

  const planWith = (
    planInputs: readonly ReturnType<typeof trustedLocalPlanInput>[],
  ): typeof base.plan => ({ ...base.plan, inputs: [...planInputs] }) as typeof base.plan;

  const bindingsFor = (
    planInputs: readonly ReturnType<typeof trustedLocalPlanInput>[],
  ): readonly { inputId: string; sourcePath: string }[] =>
    planInputs.map((input) => ({ inputId: input.input_id, sourcePath: source }));

  // The real count ceiling, at its real value: one over refuses.
  const tooMany = Array.from({ length: TRUSTED_LOCAL_INPUT_CEILINGS.maxInputCount + 1 }, (_, i) =>
    trustedLocalPlanInput({ inputId: `input-${String(i)}`, relativePath: `f${String(i)}.bin`, bytes }),
  );
  assert.throws(
    () =>
      materializeTrustedLocalInputs({
        plan: planWith(tooMany),
        bindings: bindingsFor(tooMany),
        outputRoot: path.join(root, "count"),
      }),
    (error: { code?: string; message?: string }) =>
      error.code === CODES.ADAPTER_LOCAL_LIMIT_EXCEEDED &&
      /input trusted-local ceiling/.test(String(error.message)),
  );
  assert.equal(existsSync(path.join(root, "count", "inputs")), false);

  // Exactly the ceiling is accepted, which is what makes "one over" a boundary
  // rather than a coincidence. Measured on the byte ceilings, where a run at
  // the real 64 MiB value would be pure I/O for no extra confidence.
  const one = [trustedLocalPlanInput({ bytes })];
  const tight = {
    maxInputCount: 8,
    maxInputBytes: bytes.byteLength,
    maxTotalInputBytes: bytes.byteLength,
  };
  const atCeiling = materializeTrustedLocalInputs({
    plan: planWith(one),
    bindings: bindingsFor(one),
    outputRoot: path.join(root, "at-ceiling"),
    ceilings: tight,
  });
  assert.equal(atCeiling.files.length, 1);

  // One byte over the single-input ceiling.
  assert.throws(
    () =>
      materializeTrustedLocalInputs({
        plan: planWith(one),
        bindings: bindingsFor(one),
        outputRoot: path.join(root, "single"),
        ceilings: { ...tight, maxInputBytes: bytes.byteLength - 1 },
      }),
    (error: { code?: string; message?: string }) =>
      error.code === CODES.ADAPTER_LOCAL_LIMIT_EXCEEDED &&
      /single-input trusted-local ceiling/.test(String(error.message)),
  );
  assert.equal(existsSync(path.join(root, "single", "inputs")), false);

  // Two inputs that each fit and together do not.
  const two = [
    trustedLocalPlanInput({ inputId: "one", relativePath: "one.bin", bytes }),
    trustedLocalPlanInput({ inputId: "two", relativePath: "two.bin", bytes }),
  ];
  assert.throws(
    () =>
      materializeTrustedLocalInputs({
        plan: planWith(two),
        bindings: bindingsFor(two),
        outputRoot: path.join(root, "aggregate"),
        ceilings: { ...tight, maxTotalInputBytes: bytes.byteLength + 1 },
      }),
    (error: { code?: string; message?: string }) =>
      error.code === CODES.ADAPTER_LOCAL_LIMIT_EXCEEDED &&
      /aggregate/.test(String(error.message)),
  );
  // Refused safely: the first input had already been published when the second
  // exceeded the aggregate, and neither survives.
  assert.equal(existsSync(path.join(root, "aggregate", "inputs")), false);
});

test("TRUSTED-LOCAL-INPUT: the shipped ceilings are the conservative documented ones", () => {
  // Pinned so a change to any of them is a deliberate edit to a test that says
  // what they are, rather than a number nobody notices moving.
  assert.deepEqual(TRUSTED_LOCAL_INPUT_CEILINGS, {
    maxInputCount: 64,
    maxInputBytes: 64 * 1024 * 1024,
    maxTotalInputBytes: 256 * 1024 * 1024,
  });
});

// ---------------------------------------------------------------------------
// 8 & 9. Offline re-verification of the retained tree.
// ---------------------------------------------------------------------------

test("TRUSTED-LOCAL-INPUT: offline verification refuses a modified, deleted, extra or symlinked retained input", () => {
  const root = ownedTempDir("erl2-tli-verify-");
  const inputs = writeTrustedLocalInputs(root, INPUT_READER_PLAN, { fixture: "input-reader" });
  const ran = runCommand([
    "run-trusted-local-observation",
    "--adapter-entry", inputs.entryPath,
    "--manifest", inputs.manifestPath,
    "--plan", inputs.planPath,
    "--owner-declaration", inputs.declarationPath,
    "--output-root", inputs.outputRoot,
    ...inputs.bindArgs,
  ]);
  assert.equal(ran.ok, true, JSON.stringify(ran.errors));

  const retainedRoot = path.join(inputs.outputRoot, "inputs");
  const retained = path.join(
    retainedRoot,
    TRUSTED_LOCAL_INPUT_MOUNT,
    "package.bin",
  );
  const plan = inputs.plan;
  const clean = (): void => {
    rmSync(retainedRoot, { recursive: true, force: true });
    mkdirSync(path.dirname(retained), { recursive: true, mode: 0o700 });
    writeFileSync(retained, TRUSTED_LOCAL_INPUT_BYTES, { mode: 0o600 });
  };

  // A genuine tree verifies.
  clean();
  assert.deepEqual(verifyRetainedTrustedLocalInputs({ plan, retainedInputRoot: retainedRoot }), []);

  // Modified bytes.
  clean();
  chmodSync(retained, 0o600);
  writeFileSync(retained, Buffer.from("tampered\n", "utf8"));
  const modified = verifyRetainedTrustedLocalInputs({ plan, retainedInputRoot: retainedRoot });
  assert.ok(
    modified.some((refusal) => /no longer hashes to|is \d+ bytes/.test(refusal)),
    `a modified retained input must refuse: ${modified.join("; ")}`,
  );

  // Bytes of the right length but the wrong content, so length alone cannot
  // carry the refusal.
  clean();
  writeFileSync(
    retained,
    Buffer.alloc(TRUSTED_LOCAL_INPUT_BYTES.byteLength, 0x41),
  );
  const swapped = verifyRetainedTrustedLocalInputs({ plan, retainedInputRoot: retainedRoot });
  assert.ok(
    swapped.some((refusal) => refusal.includes("no longer hashes to")),
    `same-length tampering must refuse on the digest: ${swapped.join("; ")}`,
  );

  // Deleted.
  clean();
  rmSync(retained);
  assert.ok(
    verifyRetainedTrustedLocalInputs({ plan, retainedInputRoot: retainedRoot }).some((refusal) =>
      refusal.includes("is missing from the retained input tree"),
    ),
  );

  // An unexpected file nobody planned.
  clean();
  writeFileSync(path.join(path.dirname(retained), "extra.bin"), "unplanned\n");
  assert.ok(
    verifyRetainedTrustedLocalInputs({ plan, retainedInputRoot: retainedRoot }).some((refusal) =>
      refusal.includes("which the plan does not declare"),
    ),
  );

  // A symlink where the file should be: its bytes are somewhere else, and
  // following it would verify a file the run never retained.
  clean();
  rmSync(retained);
  symlinkSync(inputs.boundSources.get(TRUSTED_LOCAL_INPUT_ID) as string, retained);
  const linked = verifyRetainedTrustedLocalInputs({ plan, retainedInputRoot: retainedRoot });
  assert.ok(
    linked.some((refusal) => refusal.includes("symbolic link")),
    `a symlinked retained input must refuse: ${linked.join("; ")}`,
  );
});

test("TRUSTED-LOCAL-INPUT: the whole-record verification carries the input refusal", () => {
  const root = ownedTempDir("erl2-tli-record-");
  const inputs = writeTrustedLocalInputs(root, INPUT_READER_PLAN, { fixture: "input-reader" });
  const ran = runCommand([
    "run-trusted-local-observation",
    "--adapter-entry", inputs.entryPath,
    "--manifest", inputs.manifestPath,
    "--plan", inputs.planPath,
    "--owner-declaration", inputs.declarationPath,
    "--output-root", inputs.outputRoot,
    ...inputs.bindArgs,
  ]);
  assert.equal(ran.ok, true, JSON.stringify(ran.errors));

  const retained = path.join(inputs.outputRoot, "inputs", TRUSTED_LOCAL_INPUT_MOUNT, "package.bin");
  chmodSync(retained, 0o600);
  writeFileSync(retained, Buffer.from("edited after the run\n", "utf8"));

  const verification = verifyTrustedLocal(inputs.outputRoot, inputs.entryPath);
  assert.equal(verification.ok, false, "an edited retained input must fail the whole verification");
  assert.ok(
    verification.refusals.some((refusal) => refusal.includes("retained input")),
    verification.refusals.join("; "),
  );
});

// ---------------------------------------------------------------------------
// 10. Zero inputs.
// ---------------------------------------------------------------------------

test("TRUSTED-LOCAL-INPUT: a zero-input plan runs with no --bind-input and verifies", () => {
  const root = ownedTempDir("erl2-tli-zero-");
  const inputs = writeTrustedLocalInputs(root, INPUT_READER_PLAN, {
    fixture: "input-reader",
    planOverrides: { inputs: [] },
  });
  assert.deepEqual(inputs.bindArgs, [], "a zero-input plan must need no bindings");

  const ran = cli([
    "run-trusted-local-observation",
    "--adapter-entry", inputs.entryPath,
    "--manifest", inputs.manifestPath,
    "--plan", inputs.planPath,
    "--owner-declaration", inputs.declarationPath,
    "--output-root", inputs.outputRoot,
  ]);
  assert.equal(ran.status, 0, ran.stdout.slice(0, 2000));
  const data = ran.json["data"] as Record<string, unknown>;
  assert.equal(data["terminal_status"], "observed_complete");
  assert.equal((data["offline_verification"] as { ok: boolean }).ok, true);
  assert.deepEqual(data["retained_inputs"], []);
  assert.deepEqual(data["input_mounts"], []);
  // Nothing provisioned, so nothing created: an absent tree and an empty one
  // mean the same thing to the verifier, and not creating it keeps the run's
  // footprint honest.
  assert.equal(existsSync(String(data["retained_input_root"])), false);

  // And an extra binding against a plan that wants none is still a refusal:
  // "no inputs" is not a mode in which bindings are quietly ignored.
  const extraSource = path.join(root, "unused.bin");
  writeFileSync(extraSource, TRUSTED_LOCAL_INPUT_BYTES);
  const refused = runCommand([
    "run-trusted-local-observation",
    "--adapter-entry", inputs.entryPath,
    "--manifest", inputs.manifestPath,
    "--plan", inputs.planPath,
    "--owner-declaration", inputs.declarationPath,
    "--output-root", path.join(root, "extra-binding"),
    "--bind-input", `${TRUSTED_LOCAL_INPUT_ID}=${extraSource}`,
  ]);
  assert.equal(refused.ok, false, "an extra binding must refuse");
  assert.equal(refused.errors?.[0]?.code, CODES.CFG_UNKNOWN_FLAG);
});

// ---------------------------------------------------------------------------
// 11 & 12. Nested plan-hash sealing.
// ---------------------------------------------------------------------------

interface SealedDraft {
  readonly ok: boolean;
  readonly code: string | undefined;
  readonly message: string | undefined;
  readonly planPath: string | undefined;
}

function sealDraft(
  root: string,
  planPath: string,
  name: string,
  mutate: (draft: Record<string, unknown>) => void,
  entryPath: string,
  manifestPath: string,
): SealedDraft {
  const draft = JSON.parse(readFileSync(planPath, "utf8")) as Record<string, unknown>;
  delete draft["trusted_local_declaration_hash"];
  delete draft["core_hash"];
  delete (draft["resource_limits"] as Record<string, unknown>)["core_hash"];
  delete (draft["egress_policy"] as Record<string, unknown>)["core_hash"];
  mutate(draft);
  const draftPath = path.join(root, `${name}-draft.json`);
  writeFileSync(draftPath, `${JSON.stringify(draft, null, 2)}\n`);
  const result = runCommand([
    "declare-trusted-local-adapter",
    "--adapter-entry", entryPath,
    "--manifest", manifestPath,
    "--acknowledge-trusted-local-code", TRUSTED_LOCAL_ACKNOWLEDGEMENT_TOKEN,
    "--acknowledged-by", "neutral fixture operator",
    "--declaration-id", `${name}-declaration`,
    "--output", path.join(root, `${name}-declaration.json`),
    "--seal-plan-draft", draftPath,
    "--plan-output", path.join(root, `${name}-plan.json`),
  ]);
  return {
    ok: result.ok,
    code: result.errors?.[0]?.code,
    message: result.errors?.[0]?.message,
    planPath: (result.data as { sealed_plan_path?: string } | undefined)?.sealed_plan_path,
  };
}

test("TRUSTED-LOCAL-SEAL: a draft pre-carrying either nested core hash is refused, not overwritten", () => {
  const root = ownedTempDir("erl2-tls-precarried-");
  const inputs = writeTrustedLocalInputs(root, INPUT_READER_PLAN, { fixture: "input-reader" });

  for (const [field, name] of [
    ["resource_limits", "pre-limits"],
    ["egress_policy", "pre-egress"],
  ] as const) {
    const refused = sealDraft(
      root,
      inputs.planPath,
      name,
      (draft) => {
        (draft[field] as Record<string, unknown>)["core_hash"] = `sha256:${"c".repeat(64)}`;
      },
      inputs.entryPath,
      inputs.manifestPath,
    );
    assert.equal(refused.ok, false, `a pre-carried ${field}.core_hash must refuse`);
    assert.equal(refused.code, CODES.SCHEMA_VALIDATION_FAILED);
    assert.match(String(refused.message), new RegExp(`must not carry ${field}\\.core_hash`));
    assert.equal(
      existsSync(path.join(root, `${name}-plan.json`)),
      false,
      "a refused draft must not leave a sealed plan behind",
    );
  }
});

test("TRUSTED-LOCAL-SEAL: the sealer computes both nested hashes and the plan hash correctly", () => {
  const root = ownedTempDir("erl2-tls-computed-");
  const inputs = writeTrustedLocalInputs(root, INPUT_READER_PLAN, { fixture: "input-reader" });
  const sealed = sealDraft(
    root,
    inputs.planPath,
    "computed",
    () => {
      /* nothing beyond removing the four computed fields */
    },
    inputs.entryPath,
    inputs.manifestPath,
  );
  assert.equal(sealed.ok, true, `${sealed.code ?? ""} ${sealed.message ?? ""}`);

  const plan = JSON.parse(readFileSync(String(sealed.planPath), "utf8")) as Record<string, unknown>;
  // Each nested hash is the core hash of its own document, and the plan hash
  // covers the plan *including* both of them. Recomputed here rather than
  // compared against the fixture, so this measures the arithmetic and not
  // whether two copies of the fixture agree.
  for (const field of ["resource_limits", "egress_policy"]) {
    const nested = plan[field] as Record<string, unknown>;
    const withoutHash = { ...nested };
    delete withoutHash["core_hash"];
    assert.equal(nested["core_hash"], coreHash(withoutHash), `${field}.core_hash is wrong`);
  }
  const withoutPlanHash = { ...plan };
  delete withoutPlanHash["core_hash"];
  assert.equal(plan["core_hash"], coreHash(withoutPlanHash), "the plan core hash is wrong");

  // The declaration binding is the sealer's, not the draft's.
  assert.equal(
    plan["trusted_local_declaration_hash"],
    JSON.parse(readFileSync(path.join(root, "computed-declaration.json"), "utf8"))["core_hash"],
  );

  // And the sealed plan is one an actual run accepts.
  const ran = runCommand([
    "run-trusted-local-observation",
    "--adapter-entry", inputs.entryPath,
    "--manifest", inputs.manifestPath,
    "--plan", String(sealed.planPath),
    "--owner-declaration", path.join(root, "computed-declaration.json"),
    "--output-root", path.join(root, "sealed-run"),
    ...inputs.bindArgs,
  ]);
  assert.equal(ran.ok, true, JSON.stringify(ran.errors));
});

// ---------------------------------------------------------------------------
// 13. Staging material.
// ---------------------------------------------------------------------------

test("TRUSTED-LOCAL-INPUT: no staging file survives a success or a controlled failure", () => {
  const root = ownedTempDir("erl2-tli-staging-");

  const good = writeTrustedLocalInputs(path.join(root, "good"), INPUT_READER_PLAN, {
    fixture: "input-reader",
  });
  const ran = runCommand([
    "run-trusted-local-observation",
    "--adapter-entry", good.entryPath,
    "--manifest", good.manifestPath,
    "--plan", good.planPath,
    "--owner-declaration", good.declarationPath,
    "--output-root", good.outputRoot,
    ...good.bindArgs,
  ]);
  assert.equal(ran.ok, true, JSON.stringify(ran.errors));
  assert.deepEqual(
    tree(good.outputRoot).filter((entry) => entry.includes(".partial")),
    [],
    "a successful run left staging material behind",
  );
  // The retained input is read-only for the owner and nobody else.
  const mode =
    statSync(path.join(good.outputRoot, "inputs", TRUSTED_LOCAL_INPUT_MOUNT, "package.bin")).mode &
    0o777;
  assert.equal(mode, 0o400, `retained input mode is ${mode.toString(8)}`);

  // A controlled failure: the second of two inputs does not match its digest,
  // so the first has already been published when the refusal happens.
  const bad = writeTrustedLocalInputs(path.join(root, "bad"), INPUT_READER_PLAN, {
    fixture: "input-reader",
    planOverrides: {
      inputs: [
        trustedLocalPlanInput({ inputId: "first-input", relativePath: "first.bin" }),
        trustedLocalPlanInput({
          inputId: "second-input",
          relativePath: "second.bin",
          fileSha256: `sha256:${"d".repeat(64)}`,
        }),
      ],
    },
  });
  const refused = runCommand([
    "run-trusted-local-observation",
    "--adapter-entry", bad.entryPath,
    "--manifest", bad.manifestPath,
    "--plan", bad.planPath,
    "--owner-declaration", bad.declarationPath,
    "--output-root", bad.outputRoot,
    ...bad.bindArgs,
  ]);
  assert.equal(refused.ok, false);
  assert.deepEqual(
    tree(bad.outputRoot),
    [],
    "a refused run left material beneath its output root",
  );
});

test("TRUSTED-LOCAL-INPUT: an existing retained input tree is never overwritten", () => {
  const root = ownedTempDir("erl2-tli-nooverwrite-");
  const inputs = writeTrustedLocalInputs(root, INPUT_READER_PLAN, { fixture: "input-reader" });
  const argv = [
    "run-trusted-local-observation",
    "--adapter-entry", inputs.entryPath,
    "--manifest", inputs.manifestPath,
    "--plan", inputs.planPath,
    "--owner-declaration", inputs.declarationPath,
    "--output-root", inputs.outputRoot,
    ...inputs.bindArgs,
  ];
  assert.equal(runCommand(argv).ok, true);
  const retained = readFileSync(
    path.join(inputs.outputRoot, "inputs", TRUSTED_LOCAL_INPUT_MOUNT, "package.bin"),
  );
  const second = runCommand(argv);
  assert.equal(second.ok, false, "a second run into the same root must refuse");
  assert.deepEqual(
    readFileSync(path.join(inputs.outputRoot, "inputs", TRUSTED_LOCAL_INPUT_MOUNT, "package.bin")),
    retained,
    "the first run's retained input must survive the refusal byte for byte",
  );
});
