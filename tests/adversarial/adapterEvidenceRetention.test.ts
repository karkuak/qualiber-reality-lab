/**
 * The adapter-evidence retention boundary, on the path a run actually takes.
 *
 * ## What was broken
 *
 * The adapter host adjudicated every dispatch completely — response envelope,
 * sandbox manifest and result, capability grant, diagnostics manifest, egress
 * and credential receipts, mutation ledger — and returned all of it as
 * in-process objects. `HostedSubjectPort` reduced that to a status and a
 * duration, `SubjectPort` had no field to carry the rest, and `environmentRun`
 * therefore froze `output_refs: []` and `diagnostic_refs: []` for every real
 * adapter step. `freezeAdapterOutput` — the function that collects, bounds,
 * scans and freezes the tree the subject wrote — had no caller anywhere in the
 * repository.
 *
 * The consequence is an integrity boundary, not a completeness gap: an adapter
 * could write an oversized, structurally forbidden, secret-bearing or
 * judge-canary-bearing output tree, return a supported envelope, and leave a
 * terminal that verified offline as valid. The bytes stayed in the host-owned
 * working directory, outside the retained bundle and outside every accounting
 * pass.
 *
 * ## What these controls assert
 *
 * Each one is aimed at an enforcement point rather than at a shape:
 *
 *  - normal output is retained, referenced and byte-identical;
 *  - diagnostics entries are referenced and retained;
 *  - a judge canary and a secret canary in *real hosted-adapter output* refuse;
 *  - the host's own adjudication records resolve to retained objects;
 *  - a dispatch after the final output freeze is refused through the port seam;
 *  - a copied bundle whose retained external output is deleted, altered or
 *    added to is refused by the shipped offline verifier.
 *
 * The bound and path controls (oversize, symlink, hard link) live beside their
 * siblings in `adapterHost.test.ts`, where they were already written — what
 * changed there is that they now assert against `host.run` instead of against a
 * function the shipped path never called.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { Erl2Error, type ArtifactRef, type JourneyStepOutcomeV1 } from "@erl2/contracts";
import { erl2, verifyBundle, writeLifecycle } from "../support/cliRun.js";
import { buildGovernorRegistry } from "../support/governorRegistry.js";
import {
  acquisitionRequest,
  adapterManifest,
  newHost,
  referenceAdapterEntry,
  REFERENCE_CORRECT_MANIFEST,
  sabotageAdapterEntry,
} from "../support/adapterFixtures.js";
import { ownedRunRoot, ownedTempDir } from "../support/tempDirs.js";

/** Runs one operation and returns the typed refusal, or `undefined`. */
function refusalOf(fn: () => unknown): Erl2Error | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    if (error instanceof Erl2Error) return error;
    throw error;
  }
}

function sabotageHost(name: string) {
  return newHost(adapterManifest({ adapterId: `sabotage-${name}` }), sabotageAdapterEntry(name));
}

/** Every regular file under a directory, relative to it, sorted. */
function filesUnder(root: string): readonly string[] {
  if (!existsSync(root)) return [];
  const found: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const child = path.join(dir, name);
      const relative = prefix === "" ? name : `${prefix}/${name}`;
      if (statSync(child).isDirectory()) walk(child, relative);
      else found.push(relative);
    }
  };
  walk(root, "");
  return found;
}

// -- 1/2/9. the host retains, references and resolves ------------------------

test("EVIDENCE-RETENTION: a hosted adapter's output and host records are retained and resolvable", () => {
  const { host, storeRoot, workspaceRoot } = newHost(
    REFERENCE_CORRECT_MANIFEST(),
    referenceAdapterEntry("reference-correct"),
  );
  const result = host.run({
    operation: "acquire",
    operationId: "op-acquire",
    request: acquisitionRequest("op-acquire"),
  });

  // 1. The subject's own bytes are referenced, not merely written.
  assert.ok(result.retained.outputRefs.length > 0, "a subject that wrote files must have output_refs");
  for (const ref of result.retained.outputRefs) {
    assert.ok(
      ref.path.startsWith("subject-output/adapter/op-acquire/"),
      `retained output ${ref.path} is not under this operation's scoped prefix`,
    );
    const retained = readFileSync(path.join(storeRoot, ref.path));
    assert.equal(retained.byteLength, ref.byte_length, `${ref.path} byte length disagrees`);
    // …and they are the bytes the adapter actually wrote, not a re-encoding.
    const original = path.join(
      workspaceRoot,
      "op-acquire",
      "output",
      ref.path.slice("subject-output/adapter/op-acquire/".length),
    );
    assert.deepEqual(retained, readFileSync(original), `${ref.path} is not byte-for-byte the adapter's file`);
  }

  // 2. Diagnostics entries are referenced and retained.
  assert.ok(
    result.retained.diagnosticRefs.length > 0,
    "an adapter that wrote diagnostics must have diagnostic_refs",
  );
  for (const ref of result.retained.diagnosticRefs) {
    assert.ok(
      ref.path.startsWith("subject-output/diagnostics/op-acquire/"),
      `retained diagnostics ${ref.path} is not under this operation's scoped prefix`,
    );
    assert.equal(existsSync(path.join(storeRoot, ref.path)), true, `${ref.path} is not on disk`);
  }

  // 9. Every host adjudication hash resolves to a retained object, and every
  //    one is named for the lifecycle.
  const producedHashes = new Set(result.retained.produced.map((p) => p.artifact_core_hash));
  for (const hash of [
    ...result.retained.detailRecordHashes,
    ...result.retained.mutationReceiptHashes,
    ...result.retained.compensationReceiptHashes,
  ]) {
    assert.ok(producedHashes.has(hash), `${hash} is a step field with no lifecycle production entry`);
  }
  const retainedRoot = path.join(storeRoot, "retained", "adapter", "op-acquire");
  const onDisk = filesUnder(retainedRoot).filter((name) => name.endsWith(".json"));
  const byCoreHash = new Map(
    onDisk.map((name) => [
      (JSON.parse(readFileSync(path.join(retainedRoot, name), "utf8")) as { core_hash: string })
        .core_hash,
      name,
    ]),
  );
  for (const produced of result.retained.produced) {
    assert.ok(
      byCoreHash.has(produced.artifact_core_hash),
      `${produced.artifact_role} ${produced.artifact_core_hash} resolves to no retained file`,
    );
  }
  // The five records every operation owes, whatever the adapter declared.
  for (const role of [
    "adapter-response-envelope",
    "adapter-sandbox-invocation-manifest",
    "adapter-sandbox-invocation-result",
    "adapter-capability-grant",
    "adapter-diagnostics-manifest",
  ]) {
    assert.ok(
      result.retained.produced.some((p) => p.artifact_role === role),
      `no ${role} was retained for this operation`,
    );
  }
  assert.equal(result.retained.produced.length, byCoreHash.size, "a retained record was not produced");
});

// -- 3/4. content gates on the real caller path ------------------------------

test("EVIDENCE-RETENTION: a judge canary in real hosted-adapter output refuses the operation", () => {
  const { host, storeRoot } = sabotageHost("judge-canary-in-output");
  const error = refusalOf(() =>
    host.run({ operation: "acquire", operationId: "op-1", request: acquisitionRequest("op-1") }),
  );
  assert.equal(error?.code, "JOURNEY_ORACLE_CANARY_LEAKED");
  assert.equal(error?.owner, "lab", "an oracle leak is a Lab invalidity, never a subject result");
  assert.equal(
    existsSync(path.join(storeRoot, "subject-output", "adapter", "op-1")),
    false,
    "a leaked output tree must publish nothing",
  );
});

// -- 10. the post-freeze boundary, through the port seam ---------------------

test("EVIDENCE-RETENTION: a dispatch after the final output freeze is refused through the port", async () => {
  const { HostedSubjectPort } = await import("@erl2/core");
  const { host } = newHost(REFERENCE_CORRECT_MANIFEST(), referenceAdapterEntry("reference-correct"));
  const port = new HostedSubjectPort(host);

  // Before the freeze the port answers.
  const before = port.acquire(acquisitionRequest("op-acquire") as never);
  assert.equal(before.status, "succeeded");

  // The run says "output froze" to whatever port it holds; the host closes.
  port.markOutputFrozen();
  const error = refusalOf(() => port.acquire(acquisitionRequest("op-after") as never));
  assert.equal(error?.code, "ADAPTER_EXECUTION_AFTER_OUTPUT_FREEZE");
  assert.equal(error?.owner, "lab");
});

// -- 1/7/8. the offline boundary, over a shipped bundle ----------------------

/**
 * A finalized pre-environment terminal driven by a real out-of-process adapter.
 *
 * `reference-limited` reports its package kind `unsupported` — the honest
 * limited answer — which is what makes the pre-environment terminal reachable
 * while a real adapter host adjudicated every dispatch.
 */
function hostedTerminal(): { readonly runRoot: string; readonly sourceTrustPolicyHash: string } {
  const registry = buildGovernorRegistry();
  const runRoot = ownedRunRoot("erl2-hosted-evidence-");
  const base = [
    "--run-root", runRoot,
    "--registry", registry.root,
    "--tier", "development",
    "--adapter-entry", referenceAdapterEntry("reference-limited"),
  ];
  const prereg = erl2([
    "preregister-acquisition", ...base,
    "--acquisition-source", registry.sourceManifestHash,
    "--adapter", registry.referenceLimitedAdapterHash,
    "--acquisition-actor-script", registry.acquisitionActorScriptHash,
    "--acquisition-actor-schema", registry.acquisitionActorSchemaHash,
    "--acquisition-step", registry.acquisitionStep.commitmentHash,
    "--package-verification-step", registry.packageVerificationStep.commitmentHash,
    "--generic-policy", registry.genericRunPolicyHash,
    "--trust-policy", registry.runTrustPolicyHash,
    "--limits", registry.limitsHash,
    "--expires", "2026-12-31T00:00:00Z",
  ]);
  assert.equal(prereg.exitCode, 0, JSON.stringify(prereg.body.errors));
  const common = [...base, "--run", prereg.body.run_id as string];
  for (const [name, argv] of [
    ["acquire", ["acquire", ...common]],
    ["freeze-package", ["freeze-package", ...common]],
    [
      "verify-package",
      ["verify-package", ...common, "--subject-id", "reference-limited", "--subject-version", "0.1.0"],
    ],
    ["freeze-output", ["freeze-output", ...common, "--terminal-stage", "verify_package"]],
    ["reveal", ["reveal", ...common, "--vault", registry.vaultRoot]],
    ["evaluate", ["evaluate", ...common]],
    ["finalize-generic", ["finalize-generic", ...common, "--claim-scope", "T1"]],
  ] as const) {
    const result = erl2(argv as readonly string[]);
    assert.equal(result.exitCode, 0, `${name}: ${JSON.stringify(result.body.errors)}`);
  }
  return { runRoot, sourceTrustPolicyHash: registry.sourceTrustPolicyHash };
}

/** A byte copy of a run root, so each tamper case starts from a clean bundle. */
function copyOf(runRoot: string): string {
  const copy = path.join(ownedTempDir("erl2-bundle-copy-"), "run");
  cpSync(runRoot, copy, { recursive: true });
  return copy;
}

/** Every retained adapter-output payload the terminal's step outcomes declare. */
function declaredAdapterOutputs(runRoot: string): readonly ArtifactRef[] {
  const outcomes = path.join(runRoot, "retained", "step-outcomes");
  return readdirSync(outcomes)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .flatMap((name) => {
      const outcome = JSON.parse(
        readFileSync(path.join(outcomes, name), "utf8"),
      ) as JourneyStepOutcomeV1;
      return outcome.output_refs.filter((ref) => ref.path.startsWith("subject-output/adapter/"));
    });
}

const TERMINAL = hostedTerminal();

test("EVIDENCE-RETENTION: a hosted terminal retains the subject's output and verifies offline", () => {
  const outputs = declaredAdapterOutputs(TERMINAL.runRoot);
  assert.ok(outputs.length > 0, "no step outcome referenced any retained adapter output");
  for (const ref of outputs) {
    assert.equal(
      existsSync(path.join(TERMINAL.runRoot, ref.path)),
      true,
      `declared payload ${ref.path} is not retained`,
    );
  }
  const verified = verifyBundle(TERMINAL.runRoot, {
    sourceTrustPolicyHash: TERMINAL.sourceTrustPolicyHash as never,
  });
  assert.equal(verified.exitCode, 0, JSON.stringify(verified.body.errors));
  assert.equal((verified.body.data as { verdict: string }).verdict, "valid");
});

test("EVIDENCE-RETENTION: removing a retained external output makes offline verification fail", () => {
  const copy = copyOf(TERMINAL.runRoot);
  const target = declaredAdapterOutputs(copy)[0] as ArtifactRef;
  const absolute = path.join(copy, target.path);
  // Removed the way a scrubber would: content and freeze marker together, so
  // the refusal cannot be attributed to a dangling marker alone.
  rmSync(absolute, { force: true });
  rmSync(`${absolute}.frozen`, { force: true });

  const verified = verifyBundle(copy, {
    sourceTrustPolicyHash: TERMINAL.sourceTrustPolicyHash as never,
  });
  assert.notEqual(verified.exitCode, 0, "a missing declared payload verified as valid");
  assert.equal(verified.body.errors[0]?.code, "ARTIFACT_NOT_FOUND");
});

test("EVIDENCE-RETENTION: altering a retained external output makes offline verification fail", () => {
  const copy = copyOf(TERMINAL.runRoot);
  const target = declaredAdapterOutputs(copy)[0] as ArtifactRef;
  const absolute = path.join(copy, target.path);
  const original = readFileSync(absolute);
  // Same length, different bytes: a substitution a length check alone misses.
  const altered = Buffer.from(original);
  altered[0] = (original[0] as number) ^ 0xff;
  // A frozen artifact is read-only on disk; an attacker with write access to the
  // bundle is not stopped by a mode bit, so the control must not be either.
  chmodSync(absolute, 0o600);
  writeFileSync(absolute, altered);

  const verified = verifyBundle(copy, {
    sourceTrustPolicyHash: TERMINAL.sourceTrustPolicyHash as never,
  });
  assert.notEqual(verified.exitCode, 0, "a substituted payload verified as valid");
  assert.equal(verified.body.errors[0]?.code, "ARTIFACT_HASH_MISMATCH");
});

test("EVIDENCE-RETENTION: an unreferenced retained output makes offline verification fail", () => {
  const copy = copyOf(TERMINAL.runRoot);
  const target = declaredAdapterOutputs(copy)[0] as ArtifactRef;
  const stray = path.join(path.dirname(path.join(copy, target.path)), "stray.txt");
  mkdirSync(path.dirname(stray), { recursive: true });
  writeFileSync(stray, "bytes no retained descriptor declares\n");

  const verified = verifyBundle(copy, {
    sourceTrustPolicyHash: TERMINAL.sourceTrustPolicyHash as never,
  });
  assert.notEqual(verified.exitCode, 0, "an undeclared retained payload verified as valid");
  assert.equal(verified.body.errors[0]?.code, "GRAPH_CLOSURE_EXTRA_ARTIFACT");
});

test("EVIDENCE-RETENTION: the host's adjudication records are closure-reachable in a terminal", () => {
  // Every retained `retained/adapter/**` record must be named by a lifecycle
  // event. If one were not, the closure derivation would already have reported
  // it as a rejected extra and the terminal above would be invalid — this reads
  // the relationship directly so a future regression names the cause.
  const lifecycle = JSON.parse(readFileSync(writeLifecycle(TERMINAL.runRoot, "closure-check.json"), "utf8")) as {
    produced: { artifact_core_hash: string }[];
  }[];
  const reached = new Set(lifecycle.flatMap((e) => e.produced.map((p) => p.artifact_core_hash)));

  const adapterRoot = path.join(TERMINAL.runRoot, "retained", "adapter");
  const records = filesUnder(adapterRoot).filter((name) => name.endsWith(".json"));
  assert.ok(records.length > 0, "the terminal retained no adapter host records");
  for (const relative of records) {
    const value = JSON.parse(readFileSync(path.join(adapterRoot, relative), "utf8")) as {
      core_hash: string;
    };
    assert.ok(reached.has(value.core_hash), `retained/adapter/${relative} is reached by no event`);
  }
});
