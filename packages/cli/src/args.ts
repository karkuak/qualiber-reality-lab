/**
 * Flag parsing for the `erl2` CLI (design v2 Appendix C).
 *
 * Unknown and duplicate flags fail.  There is no positional-argument fallback
 * and no environment-variable fallback: every input is explicit.
 */

import { CODES, Erl2Error } from "@erl2/contracts";

export interface FlagSpec {
  readonly name: string;
  readonly kind: "string" | "boolean" | "string-list";
  readonly required?: boolean;
}

export type ParsedFlags = Readonly<Record<string, string | boolean | readonly string[] | undefined>>;

export function parseFlags(argv: readonly string[], specs: readonly FlagSpec[]): ParsedFlags {
  const byName = new Map(specs.map((s) => [s.name, s]));
  const out = new Map<string, string | boolean | string[]>();
  const seen = new Set<string>();

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] as string;
    if (!token.startsWith("--")) {
      throw new Erl2Error(CODES.CFG_UNKNOWN_FLAG, `unexpected argument ${token}`);
    }
    const name = token.slice(2);
    const spec = byName.get(name);
    if (!spec) throw new Erl2Error(CODES.CFG_UNKNOWN_FLAG, `unknown flag --${name}`);
    if (spec.kind === "boolean") {
      if (seen.has(name)) throw new Erl2Error(CODES.CFG_DUPLICATE_FLAG, `duplicate flag --${name}`);
      seen.add(name);
      out.set(name, true);
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Erl2Error(CODES.CFG_MISSING_REQUIRED, `flag --${name} needs a value`);
    }
    i += 1;
    if (spec.kind === "string") {
      if (seen.has(name)) throw new Erl2Error(CODES.CFG_DUPLICATE_FLAG, `duplicate flag --${name}`);
      seen.add(name);
      out.set(name, value);
      continue;
    }
    const list = (out.get(name) as string[] | undefined) ?? [];
    list.push(value);
    out.set(name, list);
  }

  for (const spec of specs) {
    if (spec.required === true && !out.has(spec.name)) {
      throw new Erl2Error(CODES.CFG_MISSING_REQUIRED, `flag --${spec.name} is required`);
    }
  }
  return Object.fromEntries(out) as ParsedFlags;
}

export function requireString(flags: ParsedFlags, name: string): string {
  const value = flags[name];
  if (typeof value !== "string") {
    throw new Erl2Error(CODES.CFG_MISSING_REQUIRED, `flag --${name} is required`);
  }
  return value;
}
