#!/usr/bin/env node
/**
 * Reports the SHA-256 and byte length of a file, through `@erl2/integrity`.
 *
 * A trusted-local plan names every host-provisioned input by digest and length,
 * and no CLI command derives those two fields from a file: `--seal-plan-draft`
 * stamps the declaration- and policy-level hashes onto a draft, and leaves the
 * input ledger to the operator. This is the ten-line wrapper that fills the gap,
 * and it exists in the example so the two values committed in `plan.draft.json`
 * are *reproducible by a reader* rather than merely asserted.
 *
 * It uses the same `hashBytes` the Lab itself uses to check the bytes at run
 * time, so agreement here is agreement with the checker, not with a second
 * implementation that could drift from it.
 *
 *   node examples/trusted-local-neutral/hash-input.mjs examples/trusted-local-neutral/input/package.bin
 *
 * With no argument it describes this example's own committed input, which is
 * the case a reader verifying `plan.draft.json` actually wants.
 *
 * This script reads one file and prints two facts. It writes nothing, anywhere.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { hashBytes } from "@erl2/integrity";

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.resolve(process.argv[2] ?? path.join(here, "input", "package.bin"));

const bytes = readFileSync(target);

process.stdout.write(
  `${JSON.stringify(
    {
      path: target,
      file_sha256: hashBytes(bytes),
      byte_length: bytes.byteLength,
      use: "copy these two values into the plan draft's inputs[].artifact.file_sha256 and .byte_length",
    },
    null,
    2,
  )}\n`,
);
