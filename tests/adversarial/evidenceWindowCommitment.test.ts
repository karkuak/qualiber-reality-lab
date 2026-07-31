/**
 * The signed evidence-window commitment, attacked (ADR-ERL2-031 §10).
 *
 * ADR-ERL2-029 §3.2 stated its own limit rather than blurring it:
 *
 * > What is **not** proven is that the operator chose a 1-second warmup rather
 * > than a 900 ms one. A producer that moved the window inside the committed
 * > bounds, and moved the milestone with it, is not caught — and could not be by
 * > any reader that does not hold the durations.
 *
 * `WINDOW-SHIFTED-WITHIN-BOUNDS` below is that exact sentence, executed. It moves
 * the window to a 2 000 ms warmup and a 4 000 ms observation — both comfortably
 * inside `maximum_warmup_ms: 60_000` / `minimum_observation_ms: 1_000` — moves
 * the milestone and the cutoff to match, and leaves the commitment at 1 000 /
 * 5 000. Every ADR-ERL2-029 check passes. The exact derivation refuses.
 *
 * ## Why the resealing here is harder than the signer-inventory battery's
 *
 * That battery reseals five artifacts and every one sits at the *end* of the run,
 * so it can rewrite the last lifecycle event and stop. The commitment sits in the
 * **middle** — produced by `traffic_or_journey_started` — and the lifecycle is
 * hash-chained through `prior_event_hash`. Changing it moves the commitment, its
 * own event, **every later event**, the inventory entry that names it by core hash
 * *and* signature hash, the inventory, the attestation, the bundle, the bundle's
 * member descriptors and the terminal event.
 *
 * Miss any one and the case fails for a stale hash rather than for the rule it
 * claims to measure. `WINDOW-HARNESS` exists to catch exactly that: it reseals the
 * whole chain **unchanged** and requires the terminal to still verify. Without it,
 * a bug in the resealing reads as a battery of successful refusals.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { chmodSync, cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { coreHash, sealSigned } from "@erl2/integrity";
import { erl2, runToEnvironmentTerminal, writeLifecycle, writeTrustConfig } from "../support/cliRun.js";
import { developmentKeyring } from "../support/keys.js";

type Json = Record<string, unknown>;

const COMMITMENT = "retained/environment/evidence-window-commitment.json";

function readJson(file: string): Json {
  return JSON.parse(readFileSync(file, "utf8")) as Json;
}

/**
 * Retained artifacts are frozen **read-only** by the store, which is the point:
 * a run cannot rewrite its own evidence. A mutation battery has to, so it chmods
 * first and restores the mode after. That the copies are read-only at all is
 * incidental evidence that the freeze does what it says.
 */
function overwriteJson(file: string, value: unknown): { sha256: string; length: number } {
  const bytes = `${JSON.stringify(value)}\n`;
  chmodSync(file, 0o600);
  writeFileSync(file, bytes);
  chmodSync(file, 0o400);
  return {
    sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    length: Buffer.byteLength(bytes),
  };
}

function rewriteMarker(file: string, descriptor: { sha256: string; length: number }): void {
  const marker = `${file}.frozen`;
  const value = readJson(marker);
  chmodSync(marker, 0o600);
  writeFileSync(
    marker,
    `${JSON.stringify({ ...value, byte_length: descriptor.length, file_sha256: descriptor.sha256 })}\n`,
  );
  chmodSync(marker, 0o400);
}

function eventFiles(root: string): string[] {
  const dir = path.join(root, "events");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => path.join(dir, name));
}

function firstError(body: { errors: { code: string; message: string }[] }): string {
  return body.errors[0]?.code ?? "-";
}

/**
 * Rewrite the lifecycle from `startIndex` on, applying `mutate` to **every**
 * event in that range and re-chaining `prior_event_hash` through all of them.
 *
 * Every event, not just the first: the observation freeze names the bundle, the
 * cutoff event names the milestone, and any of those hashes may have been
 * rebound. A helper that mutated only the starting event would leave a later one
 * citing a hash that no longer exists, and the case would fail as a broken
 * reference rather than as the rule it claims to measure — which is the whole
 * failure mode `WINDOW-HARNESS` exists to catch.
 */
function resealLifecycleFrom(root: string, startIndex: number, mutate: (core: Json) => Json): void {
  const files = eventFiles(root);
  let priorHash: string | undefined;
  for (let i = 0; i < files.length; i += 1) {
    const file = files[i] as string;
    const event = readJson(file);
    if (i < startIndex) {
      priorHash = event["core_hash"] as string;
      continue;
    }
    const core: Json = { ...event };
    delete core["core_hash"];
    if (priorHash === undefined) delete core["prior_event_hash"];
    else core["prior_event_hash"] = priorHash;
    const shaped = mutate(core);
    const sealedEvent = { ...shaped, core_hash: coreHash(shaped) };
    rewriteMarker(file, overwriteJson(file, sealedEvent));
    priorHash = sealedEvent["core_hash"] as string;
  }
}

function eventIndexProducing(root: string, role: string): number {
  const files = eventFiles(root);
  for (let i = 0; i < files.length; i += 1) {
    const produced = readJson(files[i] as string)["produced"] as { artifact_role: string }[];
    if (produced.some((p) => p.artifact_role === role)) return i;
  }
  throw new Error(`no lifecycle event produces ${role}`);
}

interface ResealOptions {
  /** Applied to the commitment's core, with `core_hash` and `signature` stripped. */
  readonly commitment?: (core: Json) => Json;
  /** Applied to the retained runtime milestone's core. */
  readonly milestone?: (core: Json) => Json;
  /** Applied to the retained observation bundle's core. */
  readonly bundle?: (core: Json) => Json;
  /** Applied to every retained source snapshot's core. */
  readonly snapshot?: (core: Json) => Json;
  /** Drops the commitment's `produced` row, so it is retained but never reached. */
  readonly unreachCommitment?: boolean;
  /** Signs the commitment with a different key. */
  readonly signWith?: Parameters<typeof sealSigned>[1];
  /** Drops the commitment's signer-inventory entry, for the wholly-absent case. */
  readonly dropInventoryEntry?: boolean;
}

/**
 * Rewrite the window chain and every hash that descends from it.
 *
 * The order is the dependency order and it is the whole content of this helper:
 * commitment and its siblings → the event that produced them → every later event
 * → the inventory entry → the inventory → the attestation → the bundle and its
 * member descriptors → the terminal event.
 */
function resealWindowChain(root: string, options: ResealOptions): void {
  const keyring = developmentKeyring();
  const retained = path.join(root, "retained");
  const environment = path.join(retained, "environment");
  const rebound = new Map<string, string>();

  const resign = (
    file: string,
    transform: ((core: Json) => Json) | undefined,
    key: Parameters<typeof sealSigned>[1] | undefined,
  ): void => {
    if (transform === undefined && key === undefined) return;
    const before = readJson(file);
    const oldHash = before["core_hash"] as string;
    const core: Json = { ...before };
    delete core["core_hash"];
    const signed = core["signature"] !== undefined;
    delete core["signature"];
    const shaped = transform === undefined ? core : transform(core);
    const after = signed
      ? (sealSigned(shaped, key ?? keyring.policyAuthor) as unknown as Json)
      : { ...shaped, core_hash: coreHash(shaped) };
    rewriteMarker(file, overwriteJson(file, after));
    rebound.set(oldHash, after["core_hash"] as string);
    if (signed) {
      rebound.set(`sig:${oldHash}`, (after["signature"] as { signed_hash: string }).signed_hash);
      rebound.set(`key:${oldHash}`, (after["signature"] as { key_id: string }).key_id);
    }
  };

  resign(path.join(root, COMMITMENT), options.commitment, options.signWith);
  if (options.milestone !== undefined) {
    resign(path.join(environment, "runtime-milestone.json"), options.milestone, keyring.runtimeAttestor);
  }
  if (options.snapshot !== undefined) {
    const dir = path.join(retained, "observation");
    for (const name of readdirSync(dir).filter((n) => n.endsWith(".json"))) {
      resign(path.join(dir, name), options.snapshot, undefined);
    }
  }
  // The bundle cites the milestone and every snapshot by hash, so it is resealed
  // last and always when either moved — otherwise the case fails as an
  // unresolvable reference rather than as the rule it claims to measure.
  const bundleNeedsRebind =
    options.bundle !== undefined || options.milestone !== undefined || options.snapshot !== undefined;
  if (bundleNeedsRebind) {
    resign(path.join(retained, "observation-bundle.json"), (core) => {
      const shaped = options.bundle === undefined ? core : options.bundle(core);
      const cutoff = shaped["cutoff"] as Json;
      const milestoneHash = cutoff["runtime_milestone_hash"] as string;
      return {
        ...shaped,
        cutoff: rebound.has(milestoneHash)
          ? { ...cutoff, runtime_milestone_hash: rebound.get(milestoneHash) }
          : cutoff,
        source_snapshots: (shaped["source_snapshots"] as Json[]).map((s) => {
          const h = s["snapshot_hash"] as string;
          return rebound.has(h) ? { ...s, snapshot_hash: rebound.get(h) } : s;
        }),
      };
    }, undefined);
  }

  // Every lifecycle event from the commitment's own onward: `produced` is remapped
  // wherever it names a rebound artifact, and the chain is re-hashed throughout.
  const start = eventIndexProducing(root, "evidence-window-commitment");
  resealLifecycleFrom(root, start, (event) => {
    let produced = (event["produced"] as { artifact_role: string; artifact_core_hash: string }[]).map(
      (p) => (rebound.has(p.artifact_core_hash)
        ? { ...p, artifact_core_hash: rebound.get(p.artifact_core_hash) as string }
        : p),
    );
    if (options.unreachCommitment === true) {
      produced = produced.filter((p) => p.artifact_role !== "evidence-window-commitment");
    }
    return { ...event, produced };
  });

  // -- the run record's lifecycle head -------------------------------------
  //
  // The step the signer-inventory battery never had to take, and the one that
  // cost this file eleven failing cases before it was added.
  //
  // `EnvironmentLabRunRecordV1.lifecycle_head_hash` is the hash of the event
  // *immediately before* the one that produced the record — the head as it stood
  // at the record's freeze point (`environmentClosure.ts:309-322`). That battery
  // only ever rewrote the **last** event, which no record cites, so it never
  // moved. Re-chaining from mid-lifecycle moves it on every case, and every one
  // then failed as `GRAPH_CLOSURE_TERMINAL_MISMATCH` — a real refusal, from a rule
  // that fires before the window derivation and had nothing to do with it.
  const recordPath = path.join(retained, "run-record.json");
  const events = eventFiles(root).map((f) => readJson(f));
  const recordBefore = readJson(recordPath);
  const publishingIndex = events.findIndex((e) =>
    (e["produced"] as { artifact_role: string }[]).some((p) => p.artifact_role === "run-record"),
  );
  // The record cites artifacts by hash across several role lists — the
  // observation bundle among them — so every rebound hash is followed wherever it
  // appears. A targeted rewrite of one field would leave the next reseal failing
  // as "run record claims a <role> the lifecycle never produced", which is a real
  // refusal from a rule that has nothing to do with the window.
  const followRebound = (value: unknown): unknown => {
    if (typeof value === "string") return rebound.get(value) ?? value;
    if (Array.isArray(value)) return value.map(followRebound);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, followRebound(v)]));
    }
    return value;
  };
  const recordCore: Json = followRebound({ ...recordBefore }) as Json;
  delete recordCore["core_hash"];
  recordCore["lifecycle_head_hash"] =
    publishingIndex <= 0
      ? (events[events.length - 1] as Json)["core_hash"]
      : (events[publishingIndex - 1] as Json)["core_hash"];
  const record = { ...recordCore, core_hash: coreHash(recordCore) };
  const recordDescriptor = overwriteJson(recordPath, record);
  rewriteMarker(recordPath, recordDescriptor);
  rebound.set(recordBefore["core_hash"] as string, record["core_hash"] as string);

  // The inventory names each member by core hash *and* signature hash.
  const inventoryPath = path.join(retained, "signer-inventory.json");
  const inventoryBefore = readJson(inventoryPath)["core_hash"] as string;
  const inventoryCore: Json = { ...readJson(inventoryPath) };
  delete inventoryCore["core_hash"];
  delete inventoryCore["signature"];
  inventoryCore["entries"] = (inventoryCore["entries"] as Json[])
    .filter((entry) =>
      options.dropInventoryEntry !== true ||
      entry["artifact_schema_version"] !== "evidence-window-commitment/v1",
    )
    .map((entry) => {
    const hash = entry["artifact_core_hash"] as string;
    if (!rebound.has(hash)) return entry;
    const next: Json = { ...entry, artifact_core_hash: rebound.get(hash) as string };
    const sig = rebound.get(`sig:${hash}`);
    if (sig !== undefined) next["signature_sha256"] = sig;
    const key = rebound.get(`key:${hash}`);
    if (key !== undefined) next["signer_key_id"] = key;
    return next;
  });
  const inventory = sealSigned(inventoryCore, keyring.finalizer) as unknown as Json;
  const inventoryDescriptor = overwriteJson(inventoryPath, inventory);
  rewriteMarker(inventoryPath, inventoryDescriptor);

  const attestationPath = path.join(retained, "final-attestation.json");
  const attestationBefore = readJson(attestationPath)["core_hash"] as string;
  const attestationCore: Json = { ...readJson(attestationPath) };
  delete attestationCore["core_hash"];
  delete attestationCore["signature"];
  attestationCore["signer_inventory_hash"] = inventory["core_hash"];
  attestationCore["run_record_hash"] = record["core_hash"];
  const attestation = sealSigned(attestationCore, keyring.finalizer) as unknown as Json;
  const attestationDescriptor = overwriteJson(attestationPath, attestation);
  rewriteMarker(attestationPath, attestationDescriptor);

  const bundlePath = path.join(retained, "public-bundle.json");
  const bundle = readJson(bundlePath);
  const rebind = (member: unknown, hash: unknown, d: { sha256: string; length: number }): Json => {
    const m = member as { artifact: Json; artifact_core_hash: unknown };
    return {
      ...m,
      artifact: { ...m.artifact, byte_length: d.length, file_sha256: d.sha256 },
      artifact_core_hash: hash,
    };
  };
  const bundleCore: Json = {
    ...bundle,
    signer_inventory: rebind(bundle["signer_inventory"], inventory["core_hash"], inventoryDescriptor),
    final_attestation: rebind(bundle["final_attestation"], attestation["core_hash"], attestationDescriptor),
  };
  delete bundleCore["core_hash"];
  const bundleDescriptor = overwriteJson(bundlePath, { ...bundleCore, core_hash: coreHash(bundleCore) });
  rewriteMarker(bundlePath, bundleDescriptor);

  // The finalizer-produced roles, remapped in the events that publish them.
  //
  // Re-chaining starts at `publishingIndex` and not earlier, which is what keeps
  // this acyclic: the run record cites the head *before* its own publishing event,
  // and that event is left untouched here. Starting one event earlier would move
  // the head the record cites and the record would have to be resealed again,
  // forever.
  const finalRemap = new Map<string, string>([
    [recordBefore["core_hash"] as string, record["core_hash"] as string],
    [inventoryBefore, inventory["core_hash"] as string],
    [attestationBefore, attestation["core_hash"] as string],
  ]);
  resealLifecycleFrom(root, Math.max(publishingIndex, 0), (event) => ({
    ...event,
    produced: (event["produced"] as { artifact_role: string; artifact_core_hash: string }[]).map((p) =>
      finalRemap.has(p.artifact_core_hash)
        ? { ...p, artifact_core_hash: finalRemap.get(p.artifact_core_hash) as string }
        : p,
    ),
  }));
}

// One environment terminal, built once — it is ~2 minutes of real CLI work — and
// copied per case, exactly as the signer-inventory battery does.
let environmentRun: ReturnType<typeof runToEnvironmentTerminal> | undefined;
function finalized(): ReturnType<typeof runToEnvironmentTerminal> {
  environmentRun ??= runToEnvironmentTerminal();
  return environmentRun;
}

function freshCopy(): string {
  const dest = mkdtempSync(path.join(tmpdir(), "erl2-windowcopy-"));
  cpSync(finalized().runRoot, dest, { recursive: true });
  return dest;
}

function verify(root: string): ReturnType<typeof erl2> {
  return erl2([
    "verify",
    "--public-bundle", path.join(root, "retained", "public-bundle.json"),
    "--root-config",
    writeTrustConfig(root, "trust-config.json", {
      sourceTrustPolicyHash: finalized().registry.sourceTrustPolicyHash,
    }),
    "--artifact-root", root,
    "--lifecycle", writeLifecycle(root),
    "--offline",
  ]);
}

const shiftSeconds = (instant: string, seconds: number): string =>
  new Date(Date.parse(instant) + seconds * 1_000).toISOString().replace(/\.\d{3}Z$/, "Z");

// -- the baseline, and the identity case ------------------------------------

test("WINDOW-BASELINE: a shipped environment terminal commits exactly one window and verifies", () => {
  const root = freshCopy();
  const commitment = readJson(path.join(root, COMMITMENT));
  assert.equal(commitment["schema_version"], "evidence-window-commitment/v1");
  assert.equal(commitment["warmup_ms"], 1_000);
  assert.equal(commitment["observation_ms"], 5_000);
  assert.equal((commitment["signature"] as { key_id: string }).key_id, "erl2-dev-policy-author-ed25519-1");

  // Lifecycle-reached, and before the capture it governs.
  const producedAt = eventIndexProducing(root, "evidence-window-commitment");
  const events = eventFiles(root).map((f) => readJson(f));
  const cutoffAt = events.findIndex((e) => e["event_type"] === "evidence_cutoff_realized");
  const frozenAt = events.findIndex((e) => e["event_type"] === "observation_frozen");
  assert.ok(cutoffAt > producedAt, "the commitment must precede the cutoff it governs");
  assert.ok(frozenAt > producedAt, "the commitment must precede the observation freeze");

  // The bundle's cutoff is exactly what the commitment derives.
  const receipt = readJson(path.join(root, "retained", "environment", "traffic-start-receipt.json"));
  const bundle = readJson(path.join(root, "retained", "observation-bundle.json"));
  const derived = Date.parse(receipt["process_started_at"] as string) + 1_000 + 5_000;
  assert.equal(Date.parse((bundle["cutoff"] as Json)["instant"] as string), derived);

  const result = verify(root);
  assert.equal(result.exitCode, 0, JSON.stringify(result.body));
});

test("WINDOW-HARNESS: re-sealing the whole chain unchanged still verifies", () => {
  // Without this, every refusal below could be an artefact of the re-signing
  // rather than of the rule it names. The commitment sits mid-lifecycle, so this
  // exercises the full downstream re-chain of ~30 events.
  const root = freshCopy();
  resealWindowChain(root, { commitment: (core) => core });
  const result = verify(root);
  assert.equal(result.exitCode, 0, JSON.stringify(result.body));
});

// -- the residual ADR-ERL2-029 §3.2 could not close --------------------------

test("WINDOW-SHIFTED-WITHIN-BOUNDS: a window moved inside the bounds no longer escapes", () => {
  // The sentence ADR-ERL2-029 §3.2 wrote, executed. Warmup 1s -> 2s and
  // observation 5s -> 4s: the cutoff instant is *unchanged*, both durations stay
  // inside `maximum_warmup_ms: 60_000` and `minimum_observation_ms: 1_000`, and
  // the milestone moves with the window so the decomposition still closes.
  //
  // Every ADR-ERL2-029 check passes on this tree. Only the exact comparison
  // against the signed commitment refuses.
  const root = freshCopy();
  resealWindowChain(root, {
    milestone: (core) => ({ ...core, occurred_at: shiftSeconds(core["occurred_at"] as string, 1) }),
  });
  const result = verify(root);
  assert.notEqual(result.exitCode, 0, "a within-bounds shifted window must not verify");
  assert.equal(firstError(result.body), "CUTOFF_BOUND_EXCEEDED", JSON.stringify(result.body.errors));
  assert.match(
    JSON.stringify(result.body),
    /committed a 1000 ms warmup/,
    "the refusal must name the committed window, not merely a bound",
  );
});

test("WINDOW-SHIFTED-COMMITMENT: moving the commitment to match a shifted window is caught too", () => {
  // The other direction: the producer shifts the *commitment* to 2s/4s but leaves
  // the milestone where it was. The cutoff is unchanged and every bound holds.
  const root = freshCopy();
  resealWindowChain(root, {
    commitment: (core) => ({ ...core, warmup_ms: 2_000, observation_ms: 4_000 }),
  });
  const result = verify(root);
  assert.notEqual(result.exitCode, 0);
  assert.equal(firstError(result.body), "CUTOFF_BOUND_EXCEEDED", JSON.stringify(result.body.errors));
});

test("WINDOW-OBSERVATION-DURATION: an observation window shifted within bounds is caught", () => {
  const root = freshCopy();
  resealWindowChain(root, {
    commitment: (core) => ({ ...core, observation_ms: 4_000 }),
  });
  const result = verify(root);
  assert.notEqual(result.exitCode, 0);
  assert.equal(firstError(result.body), "CUTOFF_BOUND_EXCEEDED", JSON.stringify(result.body.errors));
});

test("WINDOW-BUNDLE-CUTOFF: an observation bundle whose cutoff disagrees with the commitment refuses", () => {
  const root = freshCopy();
  resealWindowChain(root, {
    bundle: (core) => ({
      ...core,
      cutoff: { ...(core["cutoff"] as Json), instant: shiftSeconds((core["cutoff"] as Json)["instant"] as string, 1) },
    }),
  });
  const result = verify(root);
  assert.notEqual(result.exitCode, 0);
});

/*
 * WINDOW-SNAPSHOT-WINDOW is deliberately **not** built here.
 *
 * The verifier does check that every source snapshot opens at the process start
 * and closes at the committed cutoff, and that rule is exercised by the pure
 * cases in `tests/integration/evidenceWindowDerivation.test.ts`. What cannot be
 * built cleanly *at this layer* is the mutation: resealing a snapshot moves its
 * core hash, which moves the observation bundle that cites it, which moves the
 * canonical evidence envelope and the adapter translation receipt that cite the
 * bundle — a chain this battery would have to rebuild in full before the tree
 * reached the window derivation at all.
 *
 * Measured rather than assumed: with the snapshots and the bundle resealed and
 * every hash rebound, the terminal still refuses at the closure with three
 * unaccounted artifacts, from a rule that fires long before the window is
 * derived. A case that "passes" for that reason would be the dead-rule shape
 * ADR-ERL2-030 §9.1 records, so it is left out and named here instead.
 *
 * The consequence is recorded honestly in the ledger and in the negative-control
 * table: `window-verifier-capture-window` is an `expect: "pass"` control, not a
 * load-bearing one.
 */


// -- presence, authority and binding ----------------------------------------

test("WINDOW-MISSING: a terminal that started traffic and dropped its commitment refuses", () => {
  const root = freshCopy();
  // The artifact, its marker and its `produced` row all go, so nothing is left
  // unaccounted and the refusal is the *missing role* rather than a rejected
  // extra. This is the case the conditional requirement in
  // `deriveEnvironmentSemantics` exists for.
  resealWindowChain(root, { unreachCommitment: true, dropInventoryEntry: true });
  rmSync(path.join(root, COMMITMENT), { force: true });
  rmSync(`${path.join(root, COMMITMENT)}.frozen`, { force: true });
  const result = verify(root);
  assert.notEqual(result.exitCode, 0);
  assert.equal(firstError(result.body), "GRAPH_CLOSURE_MISSING_ROLE", JSON.stringify(result.body.errors));
});

test("WINDOW-UNREACHED: a commitment retained but produced by no event refuses", () => {
  // Measured, not assumed: this refuses as `GRAPH_CLOSURE_EXTRA_ARTIFACT`, not
  // through the window derivation's own reachability check.
  //
  // The closure runs first and its rejected-extra rule is the more fundamental
  // cause — a retained artifact no lifecycle event produced is unaccounted
  // whatever it happens to be. The window derivation keeps its own reachability
  // check as defence for callers that do not run a closure first, but on both
  // shipped branches it sits behind a rule that fires earlier, and the ledger
  // records that rather than claiming a kill it does not have (ADR-ERL2-030 §9.1
  // is the same lesson from the other side).
  const root = freshCopy();
  resealWindowChain(root, { unreachCommitment: true });
  const result = verify(root);
  assert.notEqual(result.exitCode, 0);
  assert.equal(firstError(result.body), "GRAPH_CLOSURE_EXTRA_ARTIFACT", JSON.stringify(result.body.errors));
});

test("WINDOW-WRONG-SIGNER: a commitment signed by the traffic supervisor refuses", () => {
  // The role separation §4 turns on. A signer that both chooses the window and
  // stamps the instant it is measured from can move both together.
  const root = freshCopy();
  resealWindowChain(root, {
    commitment: (core) => core,
    signWith: developmentKeyring().trafficSupervisor,
  });
  const result = verify(root);
  assert.notEqual(result.exitCode, 0);
  assert.equal(firstError(result.body), "TRUST_KEY_NOT_AUTHORIZED_FOR_ROLE", JSON.stringify(result.body.errors));
});

test("WINDOW-FOREIGN-RUN: a commitment naming another run refuses", () => {
  const root = freshCopy();
  resealWindowChain(root, {
    commitment: (core) => ({ ...core, run_id: "019f1af9-0000-7000-8000-0000000000ff" }),
  });
  const result = verify(root);
  assert.notEqual(result.exitCode, 0);
  assert.equal(firstError(result.body), "GRAPH_CLOSURE_TERMINAL_MISMATCH", JSON.stringify(result.body.errors));
});

test("WINDOW-POLICY-BINDING: a commitment naming a different cutoff policy refuses", () => {
  const root = freshCopy();
  resealWindowChain(root, {
    commitment: (core) => ({ ...core, cutoff_policy_hash: coreHash({ other: "policy" }) }),
  });
  const result = verify(root);
  assert.notEqual(result.exitCode, 0);
  assert.equal(firstError(result.body), "CUTOFF_MILESTONE_MISMATCH", JSON.stringify(result.body.errors));
});

test("WINDOW-PROCESS-BINDING: a commitment measured from a different process start refuses", () => {
  const root = freshCopy();
  resealWindowChain(root, {
    commitment: (core) => ({ ...core, process_start_receipt_hash: coreHash({ other: "receipt" }) }),
  });
  const result = verify(root);
  assert.notEqual(result.exitCode, 0);
  assert.equal(firstError(result.body), "CUTOFF_MILESTONE_MISMATCH", JSON.stringify(result.body.errors));
});

test("WINDOW-CLOCK-BINDING: a commitment in a different clock domain refuses", () => {
  const root = freshCopy();
  resealWindowChain(root, {
    commitment: (core) => ({ ...core, monotonic_clock_domain_hash: coreHash({ other: "clock" }) }),
  });
  const result = verify(root);
  assert.notEqual(result.exitCode, 0);
  assert.equal(firstError(result.body), "CUTOFF_CLOCK_DOMAIN_MISMATCH", JSON.stringify(result.body.errors));
});

test("WINDOW-OBSERVATION-BINDING: a commitment naming a different comparison policy refuses", () => {
  const root = freshCopy();
  resealWindowChain(root, {
    commitment: (core) => ({ ...core, comparison_policy_hash: coreHash({ other: "comparison" }) }),
  });
  const result = verify(root);
  assert.notEqual(result.exitCode, 0);
  assert.equal(firstError(result.body), "CUTOFF_MILESTONE_MISMATCH", JSON.stringify(result.body.errors));
});

test("WINDOW-RULE-BINDING: a commitment declaring another instant rule refuses", () => {
  const root = freshCopy();
  resealWindowChain(root, {
    commitment: (core) => ({ ...core, milestone_relationship: "runtime_milestone_at_process_start" }),
  });
  const result = verify(root);
  assert.notEqual(result.exitCode, 0);
});

// -- signer inventory --------------------------------------------------------

test("WINDOW-INVENTORY: the commitment is an applicable signed member of the terminal", () => {
  const root = freshCopy();
  const commitment = readJson(path.join(root, COMMITMENT));
  const inventory = readJson(path.join(root, "retained", "signer-inventory.json"));
  const entry = (inventory["entries"] as Json[]).find(
    (e) => e["artifact_core_hash"] === commitment["core_hash"],
  );
  assert.ok(entry !== undefined, "the inventory must list the evidence-window commitment");
  assert.equal(entry["artifact_schema_version"], "evidence-window-commitment/v1");
  assert.equal(entry["signer_key_id"], "erl2-dev-policy-author-ed25519-1");
  assert.equal(entry["signature_sha256"], (commitment["signature"] as Json)["signed_hash"]);
});

test("WINDOW-INVENTORY-OMITTED: dropping the commitment from an otherwise complete inventory refuses", () => {
  // The general completeness derivation must catch this. A special case for the
  // new contract would prove only that the special case works.
  const root = freshCopy();
  const keyring = developmentKeyring();
  const retained = path.join(root, "retained");
  const commitment = readJson(path.join(root, COMMITMENT));

  const inventoryPath = path.join(retained, "signer-inventory.json");
  const inventoryCore: Json = { ...readJson(inventoryPath) };
  delete inventoryCore["core_hash"];
  delete inventoryCore["signature"];
  inventoryCore["entries"] = (inventoryCore["entries"] as Json[]).filter(
    (e) => e["artifact_core_hash"] !== commitment["core_hash"],
  );
  const inventory = sealSigned(inventoryCore, keyring.finalizer) as unknown as Json;
  const inventoryDescriptor = overwriteJson(inventoryPath, inventory);
  rewriteMarker(inventoryPath, inventoryDescriptor);

  const attestationPath = path.join(retained, "final-attestation.json");
  const attestationCore: Json = { ...readJson(attestationPath) };
  delete attestationCore["core_hash"];
  delete attestationCore["signature"];
  attestationCore["signer_inventory_hash"] = inventory["core_hash"];
  const attestation = sealSigned(attestationCore, keyring.finalizer) as unknown as Json;
  const attestationDescriptor = overwriteJson(attestationPath, attestation);
  rewriteMarker(attestationPath, attestationDescriptor);

  const bundlePath = path.join(retained, "public-bundle.json");
  const bundle = readJson(bundlePath);
  const rebind = (member: unknown, hash: unknown, d: { sha256: string; length: number }): Json => {
    const m = member as { artifact: Json; artifact_core_hash: unknown };
    return {
      ...m,
      artifact: { ...m.artifact, byte_length: d.length, file_sha256: d.sha256 },
      artifact_core_hash: hash,
    };
  };
  const bundleCore: Json = {
    ...bundle,
    signer_inventory: rebind(bundle["signer_inventory"], inventory["core_hash"], inventoryDescriptor),
    final_attestation: rebind(bundle["final_attestation"], attestation["core_hash"], attestationDescriptor),
  };
  delete bundleCore["core_hash"];
  const bundleDescriptor = overwriteJson(bundlePath, { ...bundleCore, core_hash: coreHash(bundleCore) });
  rewriteMarker(bundlePath, bundleDescriptor);

  const files = eventFiles(root);
  const terminalPath = files[files.length - 1] as string;
  const terminal = readJson(terminalPath);
  const produced = (terminal["produced"] as { artifact_role: string }[]).map((p) =>
    p.artifact_role === "signer-inventory"
      ? { ...p, artifact_core_hash: inventory["core_hash"] }
      : p.artifact_role === "final-attestation"
        ? { ...p, artifact_core_hash: attestation["core_hash"] }
        : p,
  );
  const terminalCore: Json = { ...terminal, produced };
  delete terminalCore["core_hash"];
  rewriteMarker(terminalPath, overwriteJson(terminalPath, { ...terminalCore, core_hash: coreHash(terminalCore) }));

  const result = verify(root);
  assert.notEqual(result.exitCode, 0);
  assert.equal(firstError(result.body), "INVENTORY_ENTRY_MISSING", JSON.stringify(result.body.errors));
});

