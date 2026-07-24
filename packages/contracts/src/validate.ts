/**
 * Runtime validation for every closed ERL2 contract.
 *
 * Fail-closed rules implemented here:
 *   - unknown fields are rejected (every object schema sets
 *     `additionalProperties: false`);
 *   - duplicate JSON object keys are rejected before validation;
 *   - non-safe integers and non-finite numbers are rejected;
 *   - strings are required to be NFC;
 *   - diagnostics are capped at 100 problems / 16 KiB (ERL2-NFR-002).
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { AnySchemaObject, ErrorObject, ValidateFunction } from "ajv";

import { CONTRACTS, contractByName, type ContractDescriptor } from "./registry.js";
import { CODES, Erl2Error } from "./errors.js";

const MAX_PROBLEMS = 100;
const MAX_DIAGNOSTIC_BYTES = 16384;

const here = path.dirname(fileURLToPath(import.meta.url));
/** `dist/src` -> package root -> `schemas`. */
const schemaDir = path.resolve(here, "..", "..", "schemas");

function loadBundles(): AnySchemaObject[] {
  return readdirSync(schemaDir)
    .filter((f) => f.endsWith(".schema.json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(path.join(schemaDir, f), "utf8")) as AnySchemaObject);
}

const ajv = new Ajv2020({
  strict: true,
  strictTypes: true,
  strictRequired: false,
  allErrors: true,
  allowUnionTypes: false,
  validateFormats: false,
  // Contract schemas are authored in this repository and reviewed; refs never
  // resolve over the network.
  loadSchema: () => {
    throw new Erl2Error(CODES.SCHEMA_UNKNOWN_CONTRACT, "remote schema resolution is forbidden");
  },
});

for (const bundle of loadBundles()) {
  ajv.addSchema(bundle);
}

const compiled = new Map<string, ValidateFunction>();

function validatorFor(descriptor: ContractDescriptor): ValidateFunction {
  const existing = compiled.get(descriptor.ref);
  if (existing) return existing;
  const fn = ajv.compile({ $ref: descriptor.ref });
  compiled.set(descriptor.ref, fn);
  return fn;
}

/** Eagerly compile every registered contract; used by the contract test suite. */
export function compileAll(): void {
  for (const c of CONTRACTS) validatorFor(c);
}

export interface ValidationProblem {
  readonly instancePath: string;
  readonly keyword: string;
  readonly message: string;
}

export interface ValidationResult {
  readonly valid: boolean;
  readonly problems: readonly ValidationProblem[];
}

function summarize(errors: readonly ErrorObject[] | null | undefined): ValidationProblem[] {
  const problems: ValidationProblem[] = [];
  let budget = MAX_DIAGNOSTIC_BYTES;
  for (const e of errors ?? []) {
    if (problems.length >= MAX_PROBLEMS || budget <= 0) break;
    const problem: ValidationProblem = {
      instancePath: e.instancePath === "" ? "/" : e.instancePath,
      keyword: e.keyword,
      message: (e.message ?? "invalid").slice(0, 512),
    };
    budget -= problem.instancePath.length + problem.keyword.length + problem.message.length;
    problems.push(problem);
  }
  return problems;
}

/**
 * Structural pre-checks the JSON Schema vocabulary cannot express: safe
 * integers, finite numbers and NFC strings (design v2 §16.1).
 */
function preCheck(value: unknown, at: string, problems: ValidationProblem[]): void {
  if (problems.length >= MAX_PROBLEMS) return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      problems.push({ instancePath: at, keyword: "number", message: "non-finite number rejected" });
    } else if (!Number.isSafeInteger(value) && Number.isInteger(value)) {
      problems.push({ instancePath: at, keyword: "number", message: "non-safe integer rejected" });
    }
    return;
  }
  if (typeof value === "string") {
    if (value.normalize("NFC") !== value) {
      problems.push({ instancePath: at, keyword: "string", message: "string is not NFC" });
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) preCheck(v, `${at}/${i}`, problems);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) preCheck(v, `${at}/${k}`, problems);
  }
}

export function validateContract(contractName: string, value: unknown): ValidationResult {
  const descriptor = contractByName(contractName);
  if (!descriptor) {
    throw new Erl2Error(
      CODES.SCHEMA_UNKNOWN_CONTRACT,
      `no registered contract named ${contractName}`,
    );
  }
  const problems: ValidationProblem[] = [];
  preCheck(value, "", problems);
  const validate = validatorFor(descriptor);
  const ok = validate(value);
  if (!ok) problems.push(...summarize(validate.errors));
  return { valid: problems.length === 0, problems };
}

export function assertContract<T>(contractName: string, value: unknown): T {
  const result = validateContract(contractName, value);
  if (!result.valid) {
    const first = result.problems[0];
    throw new Erl2Error(
      CODES.SCHEMA_VALIDATION_FAILED,
      `${contractName} failed validation at ${first?.instancePath ?? "/"}: ${first?.message ?? "unknown"}`,
      { detail: JSON.stringify(result.problems).slice(0, MAX_DIAGNOSTIC_BYTES) },
    );
  }
  return value as T;
}

/**
 * Parses JSON while rejecting duplicate keys, which JSON.parse silently
 * collapses and which would otherwise let two different byte strings produce
 * one canonical object (design v2 §16.1).
 */
export function parseStrictJson(text: string): unknown {
  detectDuplicateKeys(text);
  return JSON.parse(text) as unknown;
}

interface Frame {
  readonly kind: "object" | "array";
  readonly keys: Set<string>;
  expectKey: boolean;
}

function detectDuplicateKeys(text: string): void {
  const stack: Frame[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "{") {
      stack.push({ kind: "object", keys: new Set(), expectKey: true });
      i += 1;
      continue;
    }
    if (ch === "[") {
      stack.push({ kind: "array", keys: new Set(), expectKey: false });
      i += 1;
      continue;
    }
    if (ch === "}" || ch === "]") {
      stack.pop();
      i += 1;
      continue;
    }
    const top = stack[stack.length - 1];
    if (ch === ",") {
      if (top && top.kind === "object") top.expectKey = true;
      i += 1;
      continue;
    }
    if (ch === ":") {
      if (top && top.kind === "object") top.expectKey = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      const { value, next } = readJsonString(text, i);
      if (top && top.kind === "object" && top.expectKey) {
        if (top.keys.has(value)) {
          throw new Erl2Error(
            CODES.SCHEMA_VALIDATION_FAILED,
            `duplicate JSON object key rejected: ${value.slice(0, 64)}`,
          );
        }
        top.keys.add(value);
      }
      i = next;
      continue;
    }
    i += 1;
  }
}

/**
 * Reads a JSON string token and returns its **decoded** value, so that two keys
 * whose byte spellings differ but whose decoded property names are equal (e.g.
 * `"a\/b"` and `"a/b"`, or `"a"` and `"a"`, or a surrogate pair and the
 * literal astral character) collapse to the same key and are rejected as
 * duplicates (design v2 §16.1). Comparing the raw token spelling — the previous
 * behaviour — let such a pair through and silently collapsed to one field.
 */
function readJsonString(text: string, start: number): { value: string; next: number } {
  let i = start + 1;
  let out = "";
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\") {
      const esc = text[i + 1];
      switch (esc) {
        case '"':
          out += '"';
          i += 2;
          continue;
        case "\\":
          out += "\\";
          i += 2;
          continue;
        case "/":
          out += "/";
          i += 2;
          continue;
        case "b":
          out += "\b";
          i += 2;
          continue;
        case "f":
          out += "\f";
          i += 2;
          continue;
        case "n":
          out += "\n";
          i += 2;
          continue;
        case "r":
          out += "\r";
          i += 2;
          continue;
        case "t":
          out += "\t";
          i += 2;
          continue;
        case "u": {
          const code = parseHex4(text, i + 2);
          out += String.fromCharCode(code);
          i += 6;
          continue;
        }
        default:
          throw new Erl2Error(
            CODES.SCHEMA_VALIDATION_FAILED,
            `invalid JSON string escape \\${esc ?? "<eof>"}`,
          );
      }
    }
    if (ch === '"') return { value: out, next: i + 1 };
    out += ch;
    i += 1;
  }
  throw new Erl2Error(CODES.SCHEMA_VALIDATION_FAILED, "unterminated JSON string");
}

/**
 * Parses exactly four hex digits of a `\uXXXX` escape, rejecting a truncated or
 * non-hex sequence fail-closed. Surrogate-pair halves each decode to their own
 * UTF-16 code unit via `String.fromCharCode`; concatenated they form the same
 * JS string the literal astral character produces, so the two spellings compare
 * equal as keys.
 */
function parseHex4(text: string, at: number): number {
  const hex = text.slice(at, at + 4);
  if (hex.length !== 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) {
    throw new Erl2Error(
      CODES.SCHEMA_VALIDATION_FAILED,
      `invalid JSON unicode escape \\u${hex}`,
    );
  }
  return parseInt(hex, 16);
}
