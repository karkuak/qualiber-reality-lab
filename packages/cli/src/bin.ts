#!/usr/bin/env node
/**
 * `erl2` entry point.  Emits one JSON envelope on stdout and exits with the
 * design's Lab exit code.
 *
 * `runCommand` already converts every escaped throwable into a typed Lab-owned
 * refusal, but the envelope must hold even if the failure happens outside it
 * (argv handling, module init, serialization).  A raw stack trace on stdout with
 * exit 1 and no code is never an acceptable Lab outcome (design Appendix B/C).
 */
import { runCommand } from "./index.js";
import { AUTHORITY_SCOPE, EXIT } from "./exits.js";

function emit(result: unknown, exitCode: number): never {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(exitCode);
}

try {
  const result = runCommand(process.argv.slice(2));
  emit(result, result.exit_code);
} catch (error) {
  emit(
    {
      schema_version: "erl2-cli-response/v1",
      command: process.argv[2] ?? "(none)",
      ok: false,
      exit_code: EXIT.USAGE_OR_CONFIG,
      authority_scope: AUTHORITY_SCOPE,
      findings: [],
      errors: [
        {
          code: "LAB_UNEXPECTED_FAILURE",
          message: `unexpected Lab failure outside command dispatch: ${
            error instanceof Error ? error.message.slice(0, 512) : "non-error throwable"
          }`,
        },
      ],
    },
    EXIT.USAGE_OR_CONFIG,
  );
}
