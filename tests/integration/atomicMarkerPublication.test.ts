/**
 * Marker publication, measured on both sides of the window that broke a gate.
 *
 * A clean-gate run recorded `SyntaxError: Unexpected end of JSON input` from a
 * test whose preceding `assert.ok(existsSync(marker))` had just passed. The file
 * existed and was empty: `writeFileSync` creates the final path and *then*
 * writes it, and the reader's readiness condition was existence. An independent
 * probe drove the two concurrently and caught the file at size zero in 300 of
 * 300 attempts, so the window is unconditional — the idle-host passes measured
 * how often it is lost, not whether it exists.
 *
 * The cases below are deliberately *not* timing arguments. The writer's property
 * is structural (the final name is never the file being written to) and the
 * reader's is total (an empty or unparsable file is never accepted, however it
 * came to be there). The one concurrency arm is a bounded corroboration with its
 * cap declared up front, not the proof.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  awaitMarker,
  commitMarker,
  markerTemporaryResidue,
  MarkerUnavailableError,
  publishMarker,
  readMarker,
  serializeMarker,
  stageMarker,
} from "../support/atomicMarker.js";
import { ownedTempDir } from "../support/tempDirs.js";

const KIND = "erl2-marker-case";
const ID = "run-0001";
const IDENTITY = { kind: KIND, id: ID } as const;
const PAYLOAD = { worktree: "/tmp/erl2-x/tree", worktreeRoot: "/tmp/erl2-x" } as const;

function markerPath(): string {
  return path.join(ownedTempDir("erl2-marker-"), "worktree.json");
}

/** A sleep that resolves on the macrotask queue, for the bounded waits below. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// -- 1. the writer -----------------------------------------------------------

test("MARKER-WRITE: a published marker is complete, valid, deterministic and private", () => {
  const marker = markerPath();
  publishMarker(marker, { ...IDENTITY, payload: PAYLOAD });
  const bytes = readFileSync(marker, "utf8");
  assert.deepEqual(JSON.parse(bytes), { id: ID, kind: KIND, payload: PAYLOAD });
  // The same marker is the same bytes, so a reader comparing two observations
  // is comparing content rather than key order.
  assert.equal(bytes, serializeMarker({ ...IDENTITY, payload: PAYLOAD }));
  assert.equal(statSync(marker).mode & 0o777, 0o600);
  assert.deepEqual(markerTemporaryResidue(marker), []);
});

test("MARKER-WRITE: the final path is never the file being written to", () => {
  // The structural proof, and the one that needs no race: between staging and
  // committing, the complete bytes exist under a *different* name in the same
  // directory, and the final name does not exist at all. A `writeFileSync`
  // writer cannot satisfy this — its final name exists, empty, at this point.
  const marker = markerPath();
  const temporary = stageMarker(marker, { ...IDENTITY, payload: PAYLOAD });
  assert.equal(existsSync(marker), false, "the final path existed before the marker was complete");
  assert.equal(path.dirname(temporary), path.dirname(marker), "the temporary is not beside the final path");
  assert.deepEqual(JSON.parse(readFileSync(temporary, "utf8")), {
    id: ID,
    kind: KIND,
    payload: PAYLOAD,
  });
  commitMarker(temporary, marker);
  assert.equal(existsSync(temporary), false, "the temporary survived its own commit");
  assert.equal(readMarker(marker, IDENTITY).ready, true);
  assert.deepEqual(markerTemporaryResidue(marker), []);
});

test("MARKER-WRITE: publishing over an existing marker replaces it in one step", () => {
  const marker = markerPath();
  publishMarker(marker, { ...IDENTITY, payload: { generation: 1 } });
  publishMarker(marker, { ...IDENTITY, payload: { generation: 2 } });
  const state = readMarker<{ generation: number }>(marker, IDENTITY);
  assert.equal(state.ready, true);
  if (!state.ready) return;
  assert.equal(state.envelope.payload.generation, 2);
  assert.deepEqual(markerTemporaryResidue(marker), []);
});

test("MARKER-WRITE: a failed publication removes its own temporary and nothing else", () => {
  const marker = markerPath();
  const directory = path.dirname(marker);
  // An unrelated file and an unrelated temporary-looking file, both of which a
  // cleanup that reached past its own work would take with it.
  const unrelated = path.join(directory, "unrelated.json");
  const foreignTemporary = path.join(directory, ".someone-elses.tmp");
  writeFileSync(unrelated, "{}\n");
  writeFileSync(foreignTemporary, "not mine\n");
  // The final name is a non-empty directory, so `rename` onto it fails.
  mkdirSync(marker);
  writeFileSync(path.join(marker, "occupant"), "x");

  assert.throws(() => {
    publishMarker(marker, { ...IDENTITY, payload: PAYLOAD });
  });
  assert.deepEqual(markerTemporaryResidue(marker), [], "the failed publication left its temporary behind");
  assert.equal(existsSync(unrelated), true);
  assert.equal(existsSync(foreignTemporary), true);
  assert.equal(existsSync(path.join(marker, "occupant")), true);
});

test("MARKER-WRITE: a symlink at the final path is refused, not followed", () => {
  const marker = markerPath();
  const elsewhere = path.join(path.dirname(marker), "elsewhere.json");
  writeFileSync(elsewhere, "{}\n");
  symlinkSync(elsewhere, marker);
  assert.throws(
    () => {
      publishMarker(marker, { ...IDENTITY, payload: PAYLOAD });
    },
    /symlink/,
    "publication followed a symlink at the final path",
  );
  assert.equal(readFileSync(elsewhere, "utf8"), "{}\n", "the symlink's target was written through");
  assert.equal(lstatSync(marker).isSymbolicLink(), true);
  assert.deepEqual(markerTemporaryResidue(marker), []);
});

// -- 2. the reader -----------------------------------------------------------

test("MARKER-READ: an absent marker is not ready, and waiting for it is bounded", async () => {
  const marker = markerPath();
  assert.deepEqual(readMarker(marker, IDENTITY), { ready: false, why: { state: "absent" } });
  await assert.rejects(
    awaitMarker({ path: marker, expected: IDENTITY, timeoutMs: 100, pollMs: 10, sleep }),
    (error: unknown) =>
      error instanceof MarkerUnavailableError && error.why.state === "absent",
    "an absent marker must time out honestly rather than hang or resolve",
  );
});

test("MARKER-READ: an empty file is never a marker", async () => {
  const marker = markerPath();
  // Exactly the state the non-atomic writer made observable: the path exists
  // and carries nothing. The old reader's condition — `existsSync` — is true
  // here, which is the whole defect.
  writeFileSync(marker, "");
  assert.equal(existsSync(marker), true);
  assert.equal(statSync(marker).size, 0);
  assert.deepEqual(readMarker(marker, IDENTITY), { ready: false, why: { state: "empty" } });
  await assert.rejects(
    awaitMarker({ path: marker, expected: IDENTITY, timeoutMs: 60, pollMs: 20, sleep }),
    (error: unknown) => error instanceof MarkerUnavailableError && error.why.state === "empty",
  );
});

test("MARKER-READ: the exact failed-gate failure is unreachable through the reader", async () => {
  const marker = markerPath();
  writeFileSync(marker, "");
  // The failure as the gate recorded it, reproduced: existence passes, and the
  // parse that followed it threw.
  assert.equal(existsSync(marker), true);
  assert.throws(
    () => JSON.parse(readFileSync(marker, "utf8")) as unknown,
    /Unexpected end of JSON input/,
    "the pre-correction reader shape no longer reproduces the observed failure",
  );
  // The corrected reader, over the identical filesystem state: not ready, and
  // when the deadline closes it fails closed with a diagnostic that names the
  // state — never a `SyntaxError` out of a parse it should not have attempted.
  const failure = await awaitMarker({
    path: marker,
    expected: IDENTITY,
    timeoutMs: 40,
    pollMs: 20,
    sleep,
  }).then(
    () => undefined,
    (error: unknown) => error,
  );
  assert.ok(failure instanceof MarkerUnavailableError, `${String(failure)} is not a marker diagnostic`);
  assert.equal((failure as Error).name, "MarkerUnavailableError");
  assert.equal((failure as MarkerUnavailableError).why.state, "empty");
});

test("MARKER-READ: partial JSON is waited through while it is still changing", async () => {
  const marker = markerPath();
  const complete = serializeMarker({ ...IDENTITY, payload: PAYLOAD });
  writeFileSync(marker, complete.slice(0, 12));
  const state = readMarker(marker, IDENTITY);
  assert.equal(state.ready, false);
  if (state.ready) return;
  assert.equal(state.why.state, "unparsable");

  // A publication that lands while the reader is waiting is picked up, and the
  // reader never observed anything between the two.
  let polls = 0;
  const resolved = await awaitMarker<typeof PAYLOAD>({
    path: marker,
    expected: IDENTITY,
    timeoutMs: 2_000,
    pollMs: 10,
    sleep: async (ms) => {
      polls += 1;
      if (polls === 1) writeFileSync(marker, complete.slice(0, 20));
      if (polls === 2) publishMarker(marker, { ...IDENTITY, payload: PAYLOAD });
      await sleep(ms);
    },
  });
  assert.deepEqual(resolved.payload, PAYLOAD);
});

test("MARKER-READ: stably malformed content fails closed instead of waiting out the deadline", async () => {
  const marker = markerPath();
  writeFileSync(marker, "{not json");
  const started = Date.now();
  await assert.rejects(
    awaitMarker({ path: marker, expected: IDENTITY, timeoutMs: 30_000, pollMs: 10, sleep }),
    (error: unknown) =>
      error instanceof MarkerUnavailableError && error.why.state === "unparsable",
    "stably unparsable content must fail closed, not be waited out",
  );
  assert.ok(Date.now() - started < 5_000, "the reader waited out a deadline for bytes that never change");
});

test("MARKER-READ: parseable is not enough — the marker must name this reader's writer", async () => {
  const marker = markerPath();
  // Valid JSON, a valid envelope, and another run's. Accepting it is how a
  // stale marker from an earlier run gets adopted as this one's report.
  publishMarker(marker, { kind: KIND, id: "run-0002", payload: PAYLOAD });
  const state = readMarker(marker, IDENTITY);
  assert.equal(state.ready, false);
  if (state.ready) return;
  assert.equal(state.why.state, "foreign");
  await assert.rejects(
    awaitMarker({ path: marker, expected: IDENTITY, timeoutMs: 1_000, pollMs: 10, sleep }),
    (error: unknown) => error instanceof MarkerUnavailableError && error.why.state === "foreign",
  );

  // And a shape that parses but is not an envelope at all — the old writer's
  // payload-only marker, which carries no identity to check.
  const bare = markerPath();
  writeFileSync(bare, JSON.stringify(PAYLOAD));
  const bareState = readMarker(bare, IDENTITY);
  assert.equal(bareState.ready, false);
  if (bareState.ready) return;
  assert.equal(bareState.why.state, "malformed");
});

test("MARKER-READ: an unsafe path and an unreadable one are refused, not polled", async () => {
  const marker = markerPath();
  const target = path.join(path.dirname(marker), "target.json");
  publishMarker(target, { ...IDENTITY, payload: PAYLOAD });
  symlinkSync(target, marker);
  const state = readMarker(marker, IDENTITY);
  assert.equal(state.ready, false);
  if (state.ready) return;
  assert.equal(state.why.state, "unsafe", "a symlink was resolved instead of refused");
  await assert.rejects(
    awaitMarker({ path: marker, expected: IDENTITY, timeoutMs: 1_000, pollMs: 10, sleep }),
    (error: unknown) => error instanceof MarkerUnavailableError && error.why.state === "unsafe",
  );

  // A filesystem error that is not "not there yet" is a fact, not a poll.
  const denied = markerPath();
  writeFileSync(denied, serializeMarker({ ...IDENTITY, payload: PAYLOAD }));
  chmodSync(denied, 0o000);
  try {
    const deniedState = readMarker(denied, IDENTITY);
    // Skipped rather than asserted when the runner can read anything (root).
    if (!deniedState.ready) assert.equal(deniedState.why.state, "unreadable");
  } finally {
    chmodSync(denied, 0o600);
  }
});

// -- 3. concurrency, bounded and declared ------------------------------------

/**
 * Caps declared before execution, so the arm reports what it found rather than
 * being run until it agrees: 200 publications, each sampled by a tight reader
 * loop in this process, and 4 concurrent child readers over 200 more.
 */
const PUBLICATION_ITERATIONS = 200;
const CONCURRENT_READERS = 4;

test("MARKER-CONCURRENT: a sampling reader never observes the final path incomplete", () => {
  const marker = markerPath();
  let zeroByte = 0;
  let partial = 0;
  let complete = 0;
  let absent = 0;
  for (let iteration = 0; iteration < PUBLICATION_ITERATIONS; iteration += 1) {
    publishMarker(marker, { ...IDENTITY, payload: { ...PAYLOAD, iteration } });
    // Sampled immediately after the rename returns, which is the moment the old
    // shape's window closed. Every observation must be a whole marker.
    const state = readMarker<{ iteration: number }>(marker, IDENTITY);
    if (!state.ready) {
      if (state.why.state === "empty") zeroByte += 1;
      else if (state.why.state === "unparsable") partial += 1;
      else if (state.why.state === "absent") absent += 1;
    } else {
      complete += 1;
    }
  }
  assert.equal(zeroByte, 0, `${String(zeroByte)} zero-byte observations of the final path`);
  assert.equal(partial, 0, `${String(partial)} partial-JSON observations of the final path`);
  assert.equal(absent, 0);
  assert.equal(complete, PUBLICATION_ITERATIONS);
  assert.deepEqual(markerTemporaryResidue(marker), []);
});

test("MARKER-CONCURRENT: concurrent readers see no file or a whole marker, never a fragment", async () => {
  const marker = markerPath();
  const probe = [
    `import { readFileSync, existsSync } from 'node:fs';`,
    `const marker = ${JSON.stringify(marker)};`,
    "let zeroByte = 0, partial = 0, complete = 0, absent = 0;",
    "const deadline = Date.now() + 4000;",
    "while (Date.now() < deadline) {",
    "  if (!existsSync(marker)) { absent += 1; continue; }",
    "  let bytes;",
    "  try { bytes = readFileSync(marker, 'utf8'); } catch { absent += 1; continue; }",
    "  if (bytes.length === 0) { zeroByte += 1; continue; }",
    "  try { JSON.parse(bytes); complete += 1; } catch { partial += 1; }",
    "}",
    "process.stdout.write(JSON.stringify({ zeroByte, partial, complete, absent }));",
  ].join("\n");

  // The children read *while* this process publishes — spawned first, awaited
  // after, so the two really do overlap. They use the *old* reader shape
  // deliberately: what is being measured is whether the corrected writer can
  // still expose a state that shape could trip on.
  const readers = Array.from({ length: CONCURRENT_READERS }, () => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", probe], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      child.once("close", (code) => {
        resolve({ code, stdout, stderr });
      });
    });
  });
  // Republish for as long as the probes are sampling, so the overlap is real.
  const publishingUntil = Date.now() + 4_000;
  let iteration = 0;
  while (Date.now() < publishingUntil) {
    for (let batch = 0; batch < PUBLICATION_ITERATIONS; batch += 1) {
      publishMarker(marker, { ...IDENTITY, payload: { ...PAYLOAD, iteration: (iteration += 1) } });
    }
    await sleep(1);
  }
  let zeroByte = 0;
  let partial = 0;
  let observed = 0;
  for (const reader of await Promise.all(readers)) {
    assert.equal(reader.code, 0, reader.stderr);
    const counted = JSON.parse(reader.stdout) as {
      zeroByte: number;
      partial: number;
      complete: number;
    };
    zeroByte += counted.zeroByte;
    partial += counted.partial;
    observed += counted.complete;
  }
  assert.equal(zeroByte, 0, `${String(zeroByte)} concurrent readers saw the final path at size zero`);
  assert.equal(partial, 0, `${String(partial)} concurrent readers saw partial JSON`);
  assert.ok(observed > 0, "no reader ever observed the marker, so the arm proved nothing");
  assert.deepEqual(markerTemporaryResidue(marker), []);
});

test("MARKER-CONCURRENT: the non-atomic shape is what the corrected writer removed", () => {
  // The counter-example, so the arm above is not an unfalsifiable claim about a
  // fast machine. `writeFileSync` is modelled by its two observable steps —
  // create, then write — which is exactly what it does, and the sampling reader
  // that saw zero incomplete states above sees them all here.
  const marker = markerPath();
  writeFileSync(marker, ""); // O_CREAT|O_TRUNC lands here
  assert.equal(existsSync(marker), true, "the non-atomic shape does not expose its final path early");
  assert.equal(readMarker(marker, IDENTITY).ready, false);
  assert.equal(statSync(marker).size, 0);
  writeFileSync(marker, serializeMarker({ ...IDENTITY, payload: PAYLOAD })); // ...and the bytes here
  assert.equal(readMarker(marker, IDENTITY).ready, true);
});

// -- 4. residue --------------------------------------------------------------

test("MARKER-RESIDUE: no publication path leaves a temporary behind", () => {
  const marker = markerPath();
  const directory = path.dirname(marker);
  publishMarker(marker, { ...IDENTITY, payload: PAYLOAD });
  publishMarker(marker, { ...IDENTITY, payload: { ...PAYLOAD, again: true } });
  const staged = stageMarker(marker, { ...IDENTITY, payload: PAYLOAD });
  assert.deepEqual(markerTemporaryResidue(marker), [staged], "a staged temporary must be visible as residue");
  commitMarker(staged, marker);
  assert.deepEqual(markerTemporaryResidue(marker), []);
  assert.deepEqual(
    readdirSync(directory).filter((entry) => entry.endsWith(".tmp")),
    [],
    "the directory still carries a temporary",
  );
});
