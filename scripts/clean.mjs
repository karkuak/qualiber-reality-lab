#!/usr/bin/env node
import { rmSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const roots = ["packages", "adapters", "packs"];
for (const group of roots) {
  const dir = path.join(root, group);
  if (!existsSync(dir)) continue;
  for (const entry of readdirSync(dir)) {
    rmSync(path.join(dir, entry, "dist"), { recursive: true, force: true });
    rmSync(path.join(dir, entry, "tsconfig.tsbuildinfo"), { force: true });
  }
}
rmSync(path.join(root, "tests", "dist"), { recursive: true, force: true });
rmSync(path.join(root, ".erl2-work"), { recursive: true, force: true });
console.log("clean ok");
