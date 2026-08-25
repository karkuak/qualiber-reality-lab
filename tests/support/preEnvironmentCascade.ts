/**
 * A faithful, fully re-signed rebuild of the shipped pre-environment terminal.
 *
 * Extracted from the RL-D-028 adversarial suite when RL-D-031 needed the same
 * machinery. Two copies of a re-signing cascade would drift, and a drifted
 * cascade fails in the direction that matters: a case would pass because the
 * rebuild broke something incidental, not because the semantic rule under test
 * refused. The identity control in each consuming suite is what proves it has
 * not drifted — an identity doctor must land back on the shipped terminal, byte
 * for byte.
 *
 * The attacker this models is the compromised-or-careless **producer**: every
 * mutation is re-signed with the repository's development finalizer key, so the
 * bundle the verifier reads is cryptographically impeccable. Holding the key
 * must not be the same thing as being believed.
 *
 * The shipped goldens are copied, never written to.
 */

import { strict as assert } from "node:assert";
import { chmodSync, cpSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { coreHash, hashBytes, sealSigned } from "@erl2/integrity";
import { erl2 } from "./cliRun.js";
import { developmentKeyring } from "./keys.js";
import { ownedTempDir } from "./tempDirs.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const PRE_ENVIRONMENT_GOLDEN = path.join(
  repoRoot,
  "fixtures",
  "golden",
  "valid-pre-environment-run",
);

export interface GoldenCopy {
  readonly dir: string;
  readonly artifacts: string;
  readonly lifecycle: string;
}

export function copyPreEnvironmentGolden(prefix = "erl2-cascade-"): GoldenCopy {
  const dir = ownedTempDir(prefix);
  cpSync(PRE_ENVIRONMENT_GOLDEN, dir, { recursive: true });
  return { dir, artifacts: path.join(dir, "artifacts"), lifecycle: path.join(dir, "lifecycle.json") };
}

export interface VerifyOutcome {
  readonly exitCode: number;
  readonly code: string;
  readonly message: string;
  readonly verdict: string;
}

/** The real shipped CLI, offline, over the rebuilt bundle. */
export function verifyOffline(c: GoldenCopy): VerifyOutcome {
  const result = erl2([
    "verify",
    "--public-bundle", path.join(c.dir, "public-bundle.json"),
    "--root-config", path.join(c.dir, "root-config.json"),
    "--artifact-root", c.artifacts,
    "--lifecycle", c.lifecycle,
    "--offline",
  ]);
  const body = result.body as { data?: { verdict?: string }; errors: { code: string; message: string }[] };
  return {
    exitCode: result.exitCode,
    code: body.errors[0]?.code ?? "-",
    message: body.errors[0]?.message ?? "",
    verdict: body.data?.verdict ?? "-",
  };
}

export type Json = Record<string, unknown>;

export function readJson(file: string): Json {
  return JSON.parse(readFileSync(file, "utf8")) as Json;
}

export function writeJson(file: string, value: Json): void {
  // The goldens are frozen read-only; a newly planted artifact has no mode yet.
  try {
    chmodSync(file, 0o644);
  } catch {
    /* the file does not exist yet */
  }
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** Recomputes `core_hash` over the body and writes the artifact back. */
export function reseal(file: string, body: Json): string {
  const { core_hash: _drop, signature: _sig, ...rest } = body;
  const hash = coreHash(rest);
  writeJson(file, { ...rest, core_hash: hash });
  return hash;
}

export interface GateRow {
  gate_id: string;
  passed: boolean;
  evidence_refs?: string[];
}

export function gatesOf(validity: Json): GateRow[] {
  return validity["gate_results"] as GateRow[];
}

type Event = Json & {
  produced: { artifact_role: string; artifact_core_hash: string; artifact_schema_version: string }[];
  core_hash: string;
  prior_event_hash?: string;
};

/**
 * Rebuilds the whole terminal chain around a doctored validity result and
 * re-signs it, so the bundle the verifier reads is internally impeccable.
 *
 * A doctored validity result changes its own core hash, which unbinds the run
 * record, which unbinds the attestation's `run_record_hash`, which is signed.
 * Each step below restores one of those links.
 *
 * Returns the new attestation hash so a caller can assert the terminal really
 * was re-signed rather than left stale.
 */
export function resignCascade(
  c: GoldenCopy,
  doctor: (validity: Json) => Json,
): { attestationHash: string } {
  const keyring = developmentKeyring();
  const retained = path.join(c.artifacts, "retained");

  const readEvents = (): Event[] => JSON.parse(readFileSync(c.lifecycle, "utf8")) as Event[];
  const writeEvents = (events: readonly Event[]): void => {
    chmodSync(c.lifecycle, 0o644);
    writeFileSync(c.lifecycle, `${JSON.stringify(events, null, 2)}\n`);
  };
  const rechain = (events: readonly Event[]): Event[] => {
    const out: Event[] = [];
    let prior: string | undefined;
    for (const event of events) {
      const next = { ...event } as Event;
      if (prior === undefined) delete next.prior_event_hash;
      else next.prior_event_hash = prior;
      const { core_hash: _drop, ...body } = next;
      const sealed = { ...body, core_hash: coreHash(body) } as Event;
      out.push(sealed);
      prior = sealed.core_hash;
    }
    return out;
  };
  const remapProduced = (events: readonly Event[], role: string, hash: string): Event[] =>
    events.map((e) =>
      e.produced.some((p) => p.artifact_role === role)
        ? ({
            ...e,
            produced: e.produced.map((p) => (p.artifact_role === role ? { ...p, artifact_core_hash: hash } : p)),
          } as Event)
        : e,
    );

  // 1. the doctored validity result
  const validityPath = path.join(retained, "validity-result.json");
  const validityHash = reseal(validityPath, doctor(readJson(validityPath)));

  // 2. The event that *published* the validity result lies before the signed
  //    freeze point, so re-pointing it moves the freeze head. That is exactly
  //    what a producer doing this legitimately would do, and it is why the
  //    cascade has to run the chain twice: once to settle the head, and once to
  //    settle the terminal that commits to it.
  const settled = rechain(remapProduced(readEvents(), "validity-result", validityHash));
  const at = settled.findIndex((e) => e.produced.some((p) => p.artifact_role === "run-record"));
  const freezeHead = (settled[at - 1] as Event).core_hash;

  // 3. the run record rebinds to both the result and the new freeze head
  const recordPath = path.join(retained, "run-record.json");
  const recordHash = reseal(recordPath, {
    ...readJson(recordPath),
    validity_result_hash: validityHash,
    lifecycle_head_hash: freezeHead,
  });

  // 4. the terminal attestation is re-signed over the new record
  const attestationPath = path.join(retained, "final-attestation.json");
  const { core_hash: _ah, signature: _as, ...attBody } = readJson(attestationPath);
  const sealed = sealSigned({ ...attBody, run_record_hash: recordHash }, keyring.finalizer) as Json;
  writeJson(attestationPath, sealed);
  const attestationHash = sealed["core_hash"] as string;

  // 5. the publishing event re-states what it published. It is the last event,
  //    so this second re-chain cannot disturb the freeze head settled above.
  const republished = rechain(
    remapProduced(remapProduced(settled, "run-record", recordHash), "final-attestation", attestationHash),
  );
  assert.equal(
    (republished[at - 1] as Event).core_hash,
    freezeHead,
    "republishing the terminal must not move the signed freeze head",
  );
  writeEvents(republished);

  // 6. both bundle copies re-point at the re-signed attestation, byte
  //    descriptor included -- the outer one is the CLI argument, the retained
  //    one is what the index enumerates, and they must stay identical.
  const attestationBytes = readFileSync(attestationPath);
  for (const bundlePath of [path.join(c.dir, "public-bundle.json"), path.join(retained, "public-bundle.json")]) {
    const bundle = readJson(bundlePath);
    const member = bundle["final_attestation"] as Json;
    const artifact = member["artifact"] as Json;
    const { core_hash: _bh, ...rest } = bundle;
    const body: Json = {
      ...rest,
      final_attestation: {
        ...member,
        artifact: {
          ...artifact,
          byte_length: statSync(attestationPath).size,
          file_sha256: hashBytes(attestationBytes),
        },
        artifact_core_hash: attestationHash,
      },
    };
    writeJson(bundlePath, { ...body, core_hash: coreHash(body) });
  }
  return { attestationHash };
}
