#!/usr/bin/env node
// Generates packages/contracts/generated/types.ts from the JSON Schema bundles.
//
// Engineering rule 1 of the implementation plan (§5) forbids independently
// hand-written wire types that can drift from schemas, so the schemas are the
// single source of truth and this generator is deterministic.  `--check` fails
// when the committed output differs from a fresh generation; CI runs it on
// every change.

import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schemaDir = path.join(root, "packages", "contracts", "schemas");
const outFile = path.join(root, "packages", "contracts", "generated", "types.ts");

const bundles = readdirSync(schemaDir)
  .filter((f) => f.endsWith(".schema.json"))
  .sort()
  .map((f) => JSON.parse(readFileSync(path.join(schemaDir, f), "utf8")));

/** Every `$defs` name across all bundles must be globally unique. */
const defNames = new Map();
for (const bundle of bundles) {
  for (const name of Object.keys(bundle.$defs ?? {})) {
    if (defNames.has(name)) {
      throw new Error(`duplicate $defs name across bundles: ${name}`);
    }
    defNames.set(name, bundle.$id);
  }
}

const refName = (ref) => {
  const m = /^erl2:[a-z-]+#\/\$defs\/([A-Za-z0-9_]+)$/.exec(ref);
  if (!m) throw new Error(`unsupported $ref: ${ref}`);
  if (!defNames.has(m[1])) throw new Error(`dangling $ref: ${ref}`);
  return m[1];
};

const quote = (s) => JSON.stringify(s);
const indent = (depth) => "  ".repeat(depth);

function isIdentifier(key) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key);
}

function typeOf(schema, depth) {
  if (typeof schema !== "object" || schema === null) {
    return schema === false ? "never" : "unknown";
  }
  if (schema.$ref) return refName(schema.$ref);
  if ("const" in schema) return typeof schema.const === "string" ? quote(schema.const) : String(schema.const);
  if (schema.enum) {
    return schema.enum.map((v) => (typeof v === "string" ? quote(v) : String(v))).join(" | ");
  }
  if (schema.oneOf) return schema.oneOf.map((s) => typeOf(s, depth)).join("\n" + indent(depth + 1) + "| ");
  if (schema.anyOf) return schema.anyOf.map((s) => typeOf(s, depth)).join(" | ");

  switch (schema.type) {
    case "string":
      return "string";
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array": {
      if (Array.isArray(schema.prefixItems)) {
        const fixed = schema.prefixItems.map((s) => typeOf(s, depth));
        if (schema.items === false) return `readonly [${fixed.join(", ")}]`;
        return `readonly [${fixed.join(", ")}, ...${typeOf(schema.items ?? true, depth)}[]]`;
      }
      if (schema.maxItems === 0) return "readonly []";
      return `readonly ${wrapUnion(typeOf(schema.items ?? true, depth))}[]`;
    }
    case "object":
      return objectType(schema, depth);
    default:
      if (schema.properties) return objectType(schema, depth);
      return "unknown";
  }
}

function wrapUnion(t) {
  return /[|&\s]/.test(t) && !t.startsWith("readonly [") ? `(${t})` : t;
}

function objectType(schema, depth) {
  const props = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const keys = Object.keys(props);
  if (keys.length === 0) return "Record<string, never>";
  const lines = keys.map((key) => {
    const optional = required.has(key) ? "" : "?";
    const name = isIdentifier(key) ? key : quote(key);
    return `${indent(depth + 1)}readonly ${name}${optional}: ${typeOf(props[key], depth + 1)};`;
  });
  return `{\n${lines.join("\n")}\n${indent(depth)}}`;
}

const header = `// GENERATED FILE — DO NOT EDIT.
// Produced by scripts/generate-types.mjs from packages/contracts/schemas/*.schema.json.
// Run \`npm run generate\` after any schema change; \`npm run verify:generated\` proves
// the committed output matches the schemas (implementation plan §5 rule 1).
/* eslint-disable */

`;

/**
 * Scalar aliases the design states as template-literal types (design v2 §16.2).
 * Keeping them nominal-ish stops a plain string being passed where a hash or a
 * UTC instant is required.
 */
const SCALAR_OVERRIDES = {
  Hash: "`sha256:${string}`",
  Instant: "`${string}Z`",
};

const chunks = [header];
for (const bundle of bundles) {
  chunks.push(`// ---- ${bundle.$id} : ${bundle.title} ----\n\n`);
  for (const [name, schema] of Object.entries(bundle.$defs ?? {})) {
    const body = Object.hasOwn(SCALAR_OVERRIDES, name) ? SCALAR_OVERRIDES[name] : typeOf(schema, 0);
    chunks.push(`export type ${name} = ${body};\n\n`);
  }
}

const generated = chunks.join("");

if (process.argv.includes("--check")) {
  if (!existsSync(outFile)) {
    console.error("generated/types.ts is missing; run `npm run generate`");
    process.exit(1);
  }
  const current = readFileSync(outFile, "utf8");
  if (current !== generated) {
    console.error("generated/types.ts is stale; run `npm run generate`");
    process.exit(1);
  }
  console.log("generated types are current");
} else {
  writeFileSync(outFile, generated);
  console.log(`wrote ${path.relative(root, outFile)} (${defNames.size} contract types)`);
}
