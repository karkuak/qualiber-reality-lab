#!/usr/bin/env node
/**
 * Checks what this example actually produced — twice, and never on the run
 * command's word.
 *
 *   node examples/trusted-local-neutral/verify-example.mjs <output-root> <run-summary.json>
 *
 * ## Two passes, deliberately
 *
 * **Pass one** reads the run command's own JSON summary and asserts the three
 * facts the example claims: the terminal status is `observed_complete`, cleanup
 * reached `cleanup_complete`, and the run's embedded offline verification
 * reported `ok`.
 *
 * **Pass two** ignores all of that and verifies the retained bytes from scratch,
 * in this fresh process, through `@erl2/core`'s public
 * `verifyTrustedLocalObservationRecord`. That function is the repository's
 * offline verifier for this record type: it rebuilds the run's story from the
 * retained plan bytes and the retained admission — the ordered operation list,
 * the predecessor chain derived rather than read, cleanup and residue from the
 * final report, the terminal status recomputed, the adapter's bytes re-hashed
 * now, and the retained input tree re-hashed now against the plan's own
 * ArtifactRefs — and compares that reconstruction with the record.
 *
 * Pass one alone would be worthless: a run command that lied about its own
 * result would say `ok: true` and this script would agree. The point of pass
 * two is that it does not ask the producer anything. It is also why this script
 * runs as its own process rather than inside the run: a verifier sharing a
 * process with the thing it verifies shares that process's state.
 *
 * This script reads files and exits 0 or 1. It writes nothing and removes
 * nothing — cleanup is `cleanup-example.sh`, run explicitly by a human who has
 * seen the scratch path.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { verifyTrustedLocalObservationRecord } from "@erl2/core";

const [, , outputRootArg, summaryArg] = process.argv;
if (outputRootArg === undefined || summaryArg === undefined) {
  process.stderr.write(
    "usage: node examples/trusted-local-neutral/verify-example.mjs <output-root> <run-summary.json>\n",
  );
  process.exit(2);
}

const outputRoot = path.resolve(outputRootArg);
const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};

// ---- pass one: what the run command said about itself -----------------------

const envelope = JSON.parse(readFileSync(path.resolve(summaryArg), "utf8"));
const summary = envelope.data ?? envelope;

check(
  summary.terminal_status === "observed_complete",
  `terminal_status is ${JSON.stringify(summary.terminal_status)}, expected "observed_complete"`,
);
check(
  summary.cleanup?.status === "cleanup_complete",
  `cleanup.status is ${JSON.stringify(summary.cleanup?.status)}, expected "cleanup_complete"`,
);
check(
  summary.offline_verification?.ok === true,
  `offline_verification.ok is ${JSON.stringify(summary.offline_verification?.ok)}, expected true`,
);

// ---- pass two: the retained bytes, verified here, from nothing but bytes -----

const verification = verifyTrustedLocalObservationRecord({
  recordBytes: readFileSync(path.join(outputRoot, "trusted-local-observation-record.json")),
  planBytes: readFileSync(path.join(outputRoot, "observation-plan.json")),
  registryRoot: path.join(outputRoot, "registry"),
  adapterEntryPath: path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "fixtures",
    "neutral",
    "neutral-full-lifecycle-observer.mjs",
  ),
  retainedInputRoot: path.join(outputRoot, "inputs"),
});

check(
  verification.ok === true,
  `independent offline verification refused: ${verification.refusals.join("; ")}`,
);
// The producer's terminal status is not evidence for itself; the independent
// reconstruction has to reach the same one.
check(
  verification.verified?.terminalStatus === "observed_complete",
  `independent verification recomputed terminal status ` +
    `${JSON.stringify(verification.verified?.terminalStatus)}, expected "observed_complete"`,
);
check(
  verification.verified?.trustMode === "trusted_local_code",
  "the independently verified record must be a trusted-local record",
);
check(
  verification.verified?.confinement === "absent" &&
    verification.verified?.independentCertification === "absent",
  "the record must continue to report confinement and independent certification as absent",
);

if (failures.length > 0) {
  process.stderr.write(`${failures.map((line) => `REFUSED: ${line}`).join("\n")}\n`);
  process.exit(1);
}

process.stdout.write(
  `${JSON.stringify(
    {
      run_summary: {
        terminal_status: summary.terminal_status,
        cleanup_status: summary.cleanup.status,
        offline_verification_ok: summary.offline_verification.ok,
      },
      independent_verification: {
        ok: verification.ok,
        observation_id: verification.verified.observationId,
        plan_hash: verification.verified.planHash,
        terminal_status: verification.verified.terminalStatus,
        trust_mode: verification.verified.trustMode,
        confinement: verification.verified.confinement,
        independent_certification: verification.verified.independentCertification,
      },
      claim_ceiling:
        "a development-tier, unscored, unauthenticated, unconfined, uncertified local " +
        "observation; not certification, not independent assurance, and not a verdict on any subject",
    },
    null,
    2,
  )}\n`,
);
