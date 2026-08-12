#!/usr/bin/env node
/** Bounded Package-A negative controls. Never runs the repository-wide campaign. */
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repo = process.cwd();
const parent = mkdtempSync(path.join(tmpdir(), "erl2-v2-negative-controls-"));

const cases = [
  {
    id: "NC-V2-01",
    title: "local mode accepts V1",
    file: "packages/core/src/adapter/host.ts",
    test: "tests/dist/adversarial/localAdapterV2.test.js",
    mutate: (text) => once(text,
      "if (isLocal !== (input.executionMode === ADAPTER_LOCAL_EXECUTION_MODE)) {",
      "if (false && isLocal !== (input.executionMode === ADAPTER_LOCAL_EXECUTION_MODE)) {"),
  },
  {
    id: "NC-V2-02",
    title: "V1 receipt reaches the V2 validator",
    file: "packages/core/src/adapter/admission.ts",
    test: "tests/dist/adversarial/localAdapterV2.test.js",
    mutate: (text) => once(text,
      'if (receipt.schema_version !== "subject-adapter-certification-receipt/v2") {',
      'if (false && receipt.schema_version !== "subject-adapter-certification-receipt/v2") {'),
  },
  {
    id: "NC-V2-03",
    title: "local context permits governed fields",
    file: "packages/contracts/schemas/adapter.schema.json",
    test: "tests/dist/contract/localObservationContracts.test.js",
    mutateJson: (schema) => {
      schema.$defs.LocalObservationExecutionContextV2.additionalProperties = true;
      return schema;
    },
  },
  {
    id: "NC-V2-04",
    title: "not_scored is no longer constant true",
    file: "packages/contracts/schemas/observation.schema.json",
    test: "tests/dist/contract/localObservationContracts.test.js",
    mutateJson: (schema) => {
      schema.$defs.LocalObservationResultV1.properties.not_scored = { type: "boolean" };
      return schema;
    },
  },
  {
    id: "NC-V2-05",
    title: "local result enters governed finalization",
    file: "packages/contracts/src/validate.ts",
    test: "tests/dist/adversarial/localObservationFirewall.test.js",
    mutate: (text) => once(text,
      "export function validateContract(contractName: string, value: unknown): ValidationResult {",
      "export function validateContract(contractName: string, value: unknown): ValidationResult {\n" +
        "  if (contractName === \"LabRunRecordV1\" && (value as { schema_version?: string })?.schema_version === \"local-observation-result/v1\") return { valid: true, problems: [] };"),
  },
  {
    id: "NC-V2-06",
    title: "receipt operation scope is ignored",
    file: "packages/core/src/adapter/admission.ts",
    test: "tests/dist/adversarial/localAdapterV2.test.js",
    mutate: (text) => once(text,
      '  assertSameSet(receipt.certified_operations, certifiedProfile.operations, "certified operations", manifest.adapter_id);\n',
      ""),
  },
  {
    id: "NC-V2-07",
    title: "per-dispatch entry digest verification is skipped",
    file: "packages/core/src/adapter/host.ts",
    test: "tests/dist/adversarial/localAdapterV2.test.js",
    mutate: (text) => once(text,
      "      assertEntryDigestUnchanged({\n" +
        "        entryPath: this.entryPath,\n" +
        "        certifiedArtifactHash: this.certifiedArtifactHash,\n" +
        "      });",
      "      void this.certifiedArtifactHash;"),
  },
  {
    id: "NC-V2-08",
    title: "local output-byte limit is not enforced",
    file: "packages/core/src/adapter/host.ts",
    test: "tests/dist/adversarial/localAdapterV2.test.js",
    mutate: (text) => once(text,
      "maxTotalBytes: limits.max_output_bytes,",
      "maxTotalBytes: hostBounds.maxTotalBytes,"),
  },
  {
    id: "NC-V2-09",
    title: "ambiguous operation is treated as replayable terminal",
    file: "packages/core/src/observation/localObservation.ts",
    test: "tests/dist/integration/localObservationReducer.test.js",
    mutate: (text) => once(text,
      'if (existing.state === "ambiguous_not_replayed") {',
      'if (false && existing.state === "ambiguous_not_replayed") {'),
  },
  {
    id: "NC-V2-10",
    title: "post-freeze dispatch is allowed",
    file: "packages/core/src/observation/localObservation.ts",
    test: "tests/dist/integration/localObservationReducer.test.js",
    mutate: (text) => once(text, "if (this.outputFrozen) {", "if (false && this.outputFrozen) {"),
  },
  {
    id: "NC-V2-11",
    title: "cleanup is complete without required evidence",
    file: "packages/core/src/observation/localObservation.ts",
    test: "tests/dist/integration/localObservationReducer.test.js",
    mutate: (text) => once(text, "const complete =\n", "const complete =\n      true ||\n"),
  },
  {
    id: "NC-V2-12",
    title: "local coordinator imports subprocess authority",
    file: "packages/core/src/observation/localObservation.ts",
    test: "tests/dist/architecture/localObservationBoundary.test.js",
    mutate: (text) => once(text,
      'import { coreHash } from "@erl2/integrity";\n',
      'import { coreHash } from "@erl2/integrity";\nimport { spawnSync } from "node:child_process";\n'),
  },
];

const results = [];
try {
  for (const item of cases) {
    const worktree = path.join(parent, item.id.toLowerCase());
    run("git", ["worktree", "add", "--detach", worktree, "HEAD"], repo);
    try {
      // Copy the small installed dependency tree so its relative workspace
      // links resolve inside this disposable worktree. Symlinking the root
      // node_modules directory would make @erl2/* resolve back to the clean
      // source checkout and silently bypass the mutation under test.
      cpSync(path.join(repo, "node_modules"), path.join(worktree, "node_modules"), {
        recursive: true,
        dereference: false,
        verbatimSymlinks: true,
      });
      const target = path.join(worktree, item.file);
      if (item.mutateJson !== undefined) {
        const value = JSON.parse(readFileSync(target, "utf8"));
        writeFileSync(target, `${JSON.stringify(item.mutateJson(value), null, 2)}\n`);
      } else {
        writeFileSync(target, item.mutate(readFileSync(target, "utf8")));
      }

      const build = spawnSync("npm", ["run", "build"], {
        cwd: worktree,
        encoding: "utf8",
        env: process.env,
      });
      if (build.status !== 0) {
        throw new Error(`${item.id} did not compile:\n${build.stdout}\n${build.stderr}`);
      }
      const tested = spawnSync(
        process.execPath,
        ["--test", "--test-reporter=spec", item.test],
        { cwd: worktree, encoding: "utf8", env: process.env },
      );
      const output = `${tested.stdout ?? ""}\n${tested.stderr ?? ""}`;
      const failures = output
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("✖ ") && !line.startsWith("✖ failing tests"));
      if (tested.status === 0 || failures.length === 0) {
        throw new Error(`${item.id} survived its targeted test:\n${output}`);
      }
      results.push({ id: item.id, title: item.title, test: item.test, failures });
      process.stdout.write(`${item.id} KILLED ${failures.join(" | ")}\n`);
    } finally {
      run("git", ["worktree", "remove", "--force", worktree], repo);
    }
  }
  process.stdout.write(`${JSON.stringify({ verdict: "all-killed", results }, null, 2)}\n`);
} finally {
  rmSync(parent, { recursive: true, force: true });
  spawnSync("git", ["worktree", "prune"], { cwd: repo });
}

function once(text, from, to) {
  const first = text.indexOf(from);
  if (first < 0 || text.indexOf(from, first + from.length) >= 0) {
    throw new Error(`mutation anchor is absent or non-unique: ${from.slice(0, 96)}`);
  }
  return `${text.slice(0, first)}${to}${text.slice(first + from.length)}`;
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env: process.env });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  }
}
