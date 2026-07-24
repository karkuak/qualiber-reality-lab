#!/usr/bin/env node
/**
 * `erl2` entry point.  Emits one JSON envelope on stdout and exits with the
 * design's Lab exit code.
 */
import { runCommand } from "./index.js";

const result = runCommand(process.argv.slice(2));
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exit(result.exit_code);
