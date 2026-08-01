/**
 * Subject-output payload accounting (ADR-ERL2-029 §5, review P2: *retained
 * subject-output payloads have no presence or extra-file accounting in the
 * offline verifier*).
 *
 * Every case takes a run the shipped CLI produced, applies exactly one hostile
 * change to the **payload root**, and re-runs `erl2 verify` in a fresh process.
 *
 * The payload root is the subtree two existing layers each half-cover and neither
 * closes: `verifyRetainedFileAccounting` walks `retained/` and says in passing
 * that a step outcome's second copy lives "under `subject-output/`, outside this
 * subtree", and `verifyReferencedBytes` rehashes a declared payload's digest
 * *only if the file is present*. So a **missing** declared payload and an
 * **undeclared extra** were both invisible, and both verified at exit 0 / `valid`.
 *
 * Two of these cases are deliberately *not* new-rule cases and say so: altering a
 * payload's bytes is caught by the referenced-bytes layer first, which is correct
 * and already covered. They are kept as ordering anchors — if either ever starts
 * failing for the payload-accounting rule instead, the layers have been reordered.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { coreHash } from "@erl2/integrity";
import { runToValidTerminal, verifyBundle } from "../support/cliRun.js";

/** Built once; every mutation runs against a fresh copy. */
let baseRoot: string | undefined;
function freshCopy(): string {
  baseRoot ??= runToValidTerminal("failed").runRoot;
  const dest = mkdtempSync(path.join(tmpdir(), "erl2-payload-"));
  cpSync(baseRoot, dest, { recursive: true });
  return dest;
}

function firstError(body: { errors: { code: string; message: string }[] }): string {
  return body.errors[0]?.code ?? "-";
}

/** The payload files the run actually froze, excluding freeze markers. */
function payloads(root: string): readonly string[] {
  return readdirSync(path.join(root, "subject-output"))
    .filter((name) => !name.endsWith(".frozen"))
    .sort();
}

test("PAYLOAD-BASELINE: the unmutated run's payload root is completely accounted", () => {
  const root = freshCopy();
  assert.ok(payloads(root).length > 0, "the fixture contains the condition these cases mutate");
  const verify = verifyBundle(root);
  assert.equal(verify.exitCode, 0, JSON.stringify(verify.body.errors));
});

test("PAYLOAD-MUT: a declared payload that is not retained is refused", () => {
  // The gap this module exists for. `verifyReferencedBytes` skips a missing
  // non-content-addressed reference on the grounds that a working-copy reference
  // may legitimately be scrubbed — true for `raw/`, false for a payload the
  // terminal's own manifest declares.
  const root = freshCopy();
  const victim = payloads(root)[0] as string;
  rmSync(path.join(root, "subject-output", victim));
  const verify = verifyBundle(root);
  assert.notEqual(verify.exitCode, 0, "a declared payload is not optional");
  assert.equal(firstError(verify.body), "ARTIFACT_NOT_FOUND");
});

test("PAYLOAD-MUT: an undeclared extra file in the payload root is refused", () => {
  // Nothing enumerated this directory before, so a file could simply be added
  // beside the real ones. It is not indexed as an artifact and not referenced by
  // any descriptor, and it verified clean.
  const root = freshCopy();
  writeFileSync(path.join(root, "subject-output", "smuggled.txt"), "not declared by any manifest");
  const verify = verifyBundle(root);
  assert.notEqual(verify.exitCode, 0, "an undeclared payload-root file must be rejected");
  assert.equal(firstError(verify.body), "GRAPH_CLOSURE_EXTRA_ARTIFACT");
});

test("PAYLOAD-MUT: an extra file that is itself a well-formed artifact is still refused", () => {
  // Sharper than the previous case: the extra is valid JSON with a correct
  // `core_hash`, so the artifact index parses it happily. Being indexable is not
  // being declared.
  const root = freshCopy();
  const body = { schema_version: "rogue-artifact/v1", run_id: "rogue", note: "self-consistent" };
  writeFileSync(
    path.join(root, "subject-output", "rogue.json"),
    JSON.stringify({ ...body, core_hash: coreHash(body) }),
  );
  const verify = verifyBundle(root);
  assert.notEqual(verify.exitCode, 0);
  assert.equal(firstError(verify.body), "GRAPH_CLOSURE_EXTRA_ARTIFACT");
});

test("PAYLOAD-MUT: an orphan freeze marker in the payload root is refused", () => {
  // A marker is accounted by the payload it seals, never on its own — otherwise
  // a marker is a free unaccounted byte-stream with a name that looks official.
  const root = freshCopy();
  writeFileSync(
    path.join(root, "subject-output", "never-existed.json.frozen"),
    JSON.stringify({ logical_path: "subject-output/never-existed.json" }),
  );
  const verify = verifyBundle(root);
  assert.notEqual(verify.exitCode, 0);
  assert.equal(firstError(verify.body), "GRAPH_CLOSURE_EXTRA_ARTIFACT");
});

test("PAYLOAD-MUT: a declared payload replaced by a symlink is refused", () => {
  // The bytes at the far end of a link are not the retained bytes, whatever they
  // hash to. Refused for being a link, before anything reads through it.
  const root = freshCopy();
  const victim = payloads(root)[0] as string;
  const target = path.join(root, "subject-output", victim);
  const bytes = readFileSync(target);
  const decoy = path.join(root, "decoy-payload.json");
  writeFileSync(decoy, bytes);
  chmodSync(target, 0o644);
  rmSync(target);
  symlinkSync(decoy, target);
  const verify = verifyBundle(root);
  assert.notEqual(verify.exitCode, 0, "a symlinked payload must be rejected");
  assert.equal(firstError(verify.body), "PATH_SYMLINK_REJECTED");
});

test("PAYLOAD-MUT: a subdirectory of undeclared files in the payload root is refused", () => {
  const root = freshCopy();
  mkdirSync(path.join(root, "subject-output", "extra"), { recursive: true });
  writeFileSync(path.join(root, "subject-output", "extra", "hidden.json"), "{}");
  const verify = verifyBundle(root);
  assert.notEqual(verify.exitCode, 0);
  assert.equal(firstError(verify.body), "GRAPH_CLOSURE_EXTRA_ARTIFACT");
});

// -- ordering anchors, not new-rule cases ------------------------------------

test("PAYLOAD-ORDER: altered payload bytes are caught by the referenced-bytes layer", () => {
  // Deliberately not a payload-accounting case. `verifyReferencedBytes` runs
  // first and refuses the digest mismatch, which is correct and already covered
  // by the 6R battery. This case exists so that a future reordering that let the
  // tamper reach a *later* rule shows up as a changed error code here rather than
  // as silence.
  const root = freshCopy();
  const victim = payloads(root)[0] as string;
  const target = path.join(root, "subject-output", victim);
  chmodSync(target, 0o644);
  // Trailing whitespace: the file stays parseable JSON and its *canonical* form
  // is unchanged, so neither the artifact index's core-hash recomputation nor the
  // test harness's own lifecycle walk trips first. Only the stored bytes differ —
  // which is precisely what `file_sha256` and `byte_length` are for.
  //
  // A byte flip mid-document is the wrong instrument here: it corrupts the JSON
  // itself, and the harness that reads the run to build a lifecycle argument dies
  // before the verifier is ever invoked. That failure looks like a verifier
  // result and is not one.
  writeFileSync(target, Buffer.concat([readFileSync(target), Buffer.from(" ")]));
  const verify = verifyBundle(root);
  assert.notEqual(verify.exitCode, 0);
  assert.equal(firstError(verify.body), "ARTIFACT_HASH_MISMATCH");
});
