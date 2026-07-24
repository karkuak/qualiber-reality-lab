#!/usr/bin/env node
// Deterministic topological build for the ERL2 workspace.
//
// The workspace deliberately avoids TypeScript project references so the
// dependency order below is an explicit, reviewable statement of the allowed
// dependency direction declared in the design (§7) and implementation plan
// (§4.1).  `tests/architecture` proves the real import graph matches it.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Build order. Each entry must only depend on entries above it. */
const BUILD_ORDER = [
  "packages/contracts",
  "packages/integrity",
  "packages/core",
  "packages/adapter-sdk",
  "packages/evaluation-sdk",
  "packages/public-verifier",
  "packages/cli",
  "adapters/reference-correct",
  "adapters/reference-limited",
  "adapters/reference-misleading",
  "adapters/reference-inconclusive",
  "packs/operations",
  "tests",
];

const typecheckOnly = process.argv.includes("--typecheck-only");
const tsc = path.join(root, "node_modules", "typescript", "bin", "tsc");

if (!existsSync(tsc)) {
  console.error("typescript is not installed; run `npm install` first");
  process.exit(2);
}

for (const pkg of BUILD_ORDER) {
  const dir = path.join(root, pkg);
  if (!existsSync(path.join(dir, "tsconfig.json"))) continue;
  const args = ["-p", dir];
  if (typecheckOnly) args.push("--noEmit");
  const result = spawnSync(process.execPath, [tsc, ...args], {
    cwd: root,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    console.error(`build failed in ${pkg}`);
    process.exit(result.status ?? 1);
  }
}

console.log(typecheckOnly ? "typecheck ok" : "build ok");
