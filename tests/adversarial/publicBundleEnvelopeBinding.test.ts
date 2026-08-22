/**
 * The caller-supplied public-bundle document, bound to the bundle the run
 * actually retained.
 *
 * ## The defect
 *
 * `erl2 verify --public-bundle PATH` reads a document the *caller* hands it.
 * Nothing tied that document to the run. Every derivation in the verifier takes
 * its facts from the artifact index, the lifecycle and the signed attestation,
 * so no accepted envelope mutation ever changed a semantic verdict — but the
 * envelope is the artifact a reader files, cites and re-publishes, and it could
 * be re-authored freely: `bundle_id`, `created_at`, every member `path`,
 * `file_sha256`, `byte_length`, `media_type` and `classification`, with
 * `core_hash` refreshed so the document stayed internally self-consistent.
 *
 * The sharpest statement of it is an asymmetry, and this file pins both halves:
 * falsifying a **retained** member's `file_sha256` is refused with
 * `ARTIFACT_HASH_MISMATCH`, and the identical mutation in the **supplied** copy
 * was accepted. A run that retained no public bundle at all still verified from
 * a detached copy, and so did one whose only indexed bundle had been moved out
 * of `retained/`.
 *
 * ## What the correction is, and what it is not
 *
 * Four checks, reusing four existing refusal codes, adding no schema, no key and
 * no signature:
 *
 *   - **B1** every declared member `path` must agree with the `logicalPath` the
 *     artifact index found that artifact at — `BUNDLE_MEMBER_MISMATCH`;
 *   - **B2** the supplied `core_hash` must be the one the supplied canonical
 *     bytes produce — `ARTIFACT_HASH_MISMATCH`;
 *   - **B3** the *recomputed* identity must equal that of a public bundle
 *     retained beneath `retained/` — `GRAPH_CLOSURE_UNREACHABLE_ARTIFACT`;
 *   - **B4** the bundle may not be back-dated before the signed
 *     `finalized_at` — `GRAPH_CLOSURE_TERMINAL_MISMATCH`.
 *
 * The public bundle is still **unsigned**, and nothing here treats it as signed.
 * The binding creates no authority; it ties the supplied document to authority
 * the run already retained.
 *
 * ## The `.frozen` half of this file
 *
 * A `.frozen` sidecar is a producer-side freeze-completion record. It has no
 * schema, no contract, no registry entry, and the verifier never opens one — it
 * accounts the *filename* and nothing else. That is easy to assume and easy to
 * get wrong, so the acceptance cases below are permanent: they record that
 * falsifying a sidecar's digest, length, path, media type or classification,
 * adding an unknown field, emptying it, filling it with non-JSON bytes, deleting
 * it or swapping two of them changes no verdict. Each one states that the value
 * is **not evidence**, not that it is trustworthy. Only an *orphan* marker is
 * refused, and only through the retained-file accounting that already existed.
 *
 * ## Method
 *
 * Every case drives the shipped `erl2` CLI in a fresh process over a disposable
 * copy, on both terminal variants: the committed pre-environment golden, and an
 * environment terminal built at test runtime by the repository's own CLI driver
 * (the repository ships no committed environment bundle). **No committed fixture
 * is ever written to.** Each mutated document is made self-consistent before the
 * verifier sees it wherever the case is not *about* self-consistency, so a
 * refusal can never be a stale-hash or schema refusal wearing the right name.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { coreHash } from "@erl2/integrity";
import {
  erl2,
  runToEnvironmentTerminal,
  writeLifecycle as writeDerivedLifecycle,
  writeTrustConfig,
} from "../support/cliRun.js";
import { ownedTempDir } from "../support/tempDirs.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PRE_ENVIRONMENT_GOLDEN = path.join(repoRoot, "fixtures", "golden", "valid-pre-environment-run");
const VERIFY_SOURCE = path.join(
  repoRoot,
  "packages",
  "public-verifier",
  "src",
  "library",
  "verify.ts",
);

type Json = Record<string, unknown>;

interface Terminal {
  /** The artifact root the verifier is pointed at. */
  readonly artifacts: string;
  readonly lifecycle: string;
  readonly rootConfig: string;
  /** The run's own retained public bundle, inside the artifact root. */
  readonly retainedBundle: string;
  /**
   * The exported, canonically identical copy a consumer is handed, when the
   * variant ships one. Serialized differently from the retained copy on purpose.
   */
  readonly exportedBundle: string | undefined;
}

interface Outcome {
  readonly exitCode: number;
  readonly code: string;
  readonly message: string;
  readonly verdict: string;
}

function readJson(file: string): Json {
  return JSON.parse(readFileSync(file, "utf8")) as Json;
}

/** Writes a document, defeating the read-only mode the freezer leaves behind. */
function overwrite(file: string, text: string): void {
  if (existsSync(file)) chmodSync(file, 0o644);
  writeFileSync(file, text);
}

/** The identity a document would carry if its producer had built it this way. */
function reseal(bundle: Json): Json {
  const body: Json = { ...bundle };
  delete body["core_hash"];
  return { ...body, core_hash: coreHash(body) };
}

// -- the two terminal variants ------------------------------------------------

function copyPreEnvironment(): Terminal {
  const dir = ownedTempDir("erl2-envb-pre-");
  cpSync(PRE_ENVIRONMENT_GOLDEN, dir, { recursive: true });
  return {
    artifacts: path.join(dir, "artifacts"),
    lifecycle: path.join(dir, "lifecycle.json"),
    rootConfig: path.join(dir, "root-config.json"),
    retainedBundle: path.join(dir, "artifacts", "retained", "public-bundle.json"),
    exportedBundle: path.join(dir, "public-bundle.json"),
  };
}

/**
 * One environment terminal, built on first use and copied per case.
 *
 * The build is real work through the shipped CLI — the repository commits no
 * environment bundle, because an environment run's bytes cannot be pinned — so
 * building one per case would multiply the suite's wall clock by its case count
 * for no added coverage. Each copy is mutated independently.
 */
let environmentTerminal: string | undefined;

function environmentTerminalRoot(): string {
  if (environmentTerminal === undefined) {
    const run = runToEnvironmentTerminal();
    writeDerivedLifecycle(run.runRoot);
    writeTrustConfig(run.runRoot, "trust-config.json", {
      sourceTrustPolicyHash: run.registry.sourceTrustPolicyHash,
    });
    environmentTerminal = run.runRoot;
  }
  return environmentTerminal;
}

function copyEnvironment(): Terminal {
  const dir = ownedTempDir("erl2-envb-env-");
  cpSync(environmentTerminalRoot(), dir, { recursive: true });
  return {
    artifacts: dir,
    lifecycle: path.join(dir, "lifecycle.json"),
    rootConfig: path.join(dir, "trust-config.json"),
    retainedBundle: path.join(dir, "retained", "public-bundle.json"),
    exportedBundle: undefined,
  };
}

const VARIANTS = [
  { name: "PRE", label: "pre-environment", copy: copyPreEnvironment },
  { name: "ENV", label: "environment", copy: copyEnvironment },
] as const;

// -- driving the shipped verifier ---------------------------------------------

/**
 * A caller-supplied bundle document, written **outside** the artifact root.
 *
 * Leaving it inside would make the artifact index find two
 * `public-verification-bundle/v2` artifacts, and every case would refuse for
 * that reason rather than for the mutation under test.
 */
function supply(bundle: Json): string {
  const file = path.join(ownedTempDir("erl2-envb-supplied-"), "supplied-bundle.json");
  writeFileSync(file, `${JSON.stringify(bundle, null, 2)}\n`);
  return file;
}

/** The offline verifier, in a fresh process, exactly as an external consumer runs it. */
function verify(t: Terminal, suppliedBundle: string): Outcome {
  const result = erl2([
    "verify",
    "--public-bundle", suppliedBundle,
    "--root-config", t.rootConfig,
    "--artifact-root", t.artifacts,
    "--lifecycle", t.lifecycle,
    "--offline",
  ]);
  const body = result.body as {
    data?: { verdict?: string };
    errors: { code: string; message: string }[];
  };
  return {
    exitCode: result.exitCode,
    code: body.errors[0]?.code ?? "-",
    message: body.errors[0]?.message ?? "",
    verdict: body.data?.verdict ?? "-",
  };
}

/** Verifies with an honest detached export of whatever the run currently retains. */
function verifyExported(t: Terminal): Outcome {
  return verify(t, supply(readJson(t.retainedBundle)));
}

function assertRefused(outcome: Outcome, code: string, note: string): void {
  assert.notEqual(outcome.exitCode, 0, `${note}: expected a refusal, got verdict ${outcome.verdict}`);
  assert.equal(outcome.code, code, `${note}: ${outcome.message}`);
}

function assertAccepted(outcome: Outcome, note: string): void {
  assert.equal(outcome.exitCode, 0, `${note}: ${outcome.code}: ${outcome.message}`);
  assert.equal(outcome.verdict, "valid", note);
}

// -- shared mutation vocabulary -----------------------------------------------

/**
 * The member every case mutates. Present on both terminal variants, and not the
 * member any pre-existing rule already cross-checks, so a refusal here can only
 * be the binding under test.
 */
const MEMBER = "signer_inventory";

function memberOf(bundle: Json): Json {
  const member = bundle[MEMBER];
  assert.ok(member !== undefined && typeof member === "object", `the bundle carries ${MEMBER}`);
  return member as Json;
}

function withMember(bundle: Json, artifact: Json): Json {
  return { ...bundle, [MEMBER]: { ...memberOf(bundle), artifact } };
}

function artifactOf(bundle: Json): Json {
  return memberOf(bundle)["artifact"] as Json;
}

/** A retained path that exists and is not the mutated member's own. */
function otherRetainedPath(t: Terminal): string {
  const candidate = "retained/trust-policy.json";
  assert.ok(
    existsSync(path.join(t.artifacts, candidate)),
    `${candidate} must exist for the substitution to mean anything`,
  );
  return candidate;
}

/** The signed instant the bundle may not claim to predate. */
function finalizedAt(t: Terminal): string {
  const attestation = readJson(path.join(t.artifacts, "retained", "final-attestation.json"));
  const value = attestation["finalized_at"];
  assert.equal(typeof value, "string", "the attestation carries a finalized_at");
  return value as string;
}

/** Rewrites the run's own retained bundle, re-sealing it as its producer would. */
function rewriteRetained(t: Terminal, mutate: (bundle: Json) => Json): Json {
  const rewritten = reseal(mutate(readJson(t.retainedBundle)));
  overwrite(t.retainedBundle, `${JSON.stringify(rewritten, null, 2)}\n`);
  return rewritten;
}

for (const variant of VARIANTS) {
  const id = (suffix: string): string => `${suffix} [${variant.label}]`;

  // -- baseline ---------------------------------------------------------------

  test(id("ENVB-BASELINE: an honest detached export of the retained bundle verifies"), () => {
    // Without this, every refusal below would prove only that breaking something
    // breaks it.
    const t = variant.copy();
    assertAccepted(verifyExported(t), "the honest export");
  });

  // -- B1/B2/B3/B4: authoritative refusals ------------------------------------

  test(id("ENVB-01: a wholly re-authored, self-consistent supplied envelope is refused"), () => {
    const t = variant.copy();
    const bundle = readJson(t.retainedBundle);
    // Every field the defect boundary named, moved at once, and then given a
    // consistent identity: `bundle_id`, `created_at` (forward, so the ordering
    // check is not what answers), and the member's whole `ArtifactRef`.
    const reauthored = reseal({
      ...withMember(bundle, {
        ...artifactOf(bundle),
        path: "retained/not-the-signer-inventory.json",
        file_sha256: `sha256:${"a".repeat(64)}`,
        byte_length: 1,
        media_type: "text/plain",
        classification: "PUBLIC",
      }),
      bundle_id: "wholly-re-authored-envelope",
      created_at: "2027-01-01T00:00:00Z",
    });
    assert.equal(coreHash(reauthored), reauthored["core_hash"], "the forgery is self-consistent");

    // B1 answers first, and deliberately: the most specific true statement about
    // this document is that a member names an artifact it is not.
    assertRefused(verify(t, supply(reauthored)), "BUNDLE_MEMBER_MISMATCH", "ENVB-01");
  });

  test(id("ENVB-02: a supplied bundle_id change with a refreshed core hash is refused"), () => {
    const t = variant.copy();
    const forged = reseal({ ...readJson(t.retainedBundle), bundle_id: "a-different-bundle-id" });
    assert.equal(coreHash(forged), forged["core_hash"], "the forgery is self-consistent");
    assertRefused(verify(t, supply(forged)), "GRAPH_CLOSURE_UNREACHABLE_ARTIFACT", "ENVB-02");
  });

  test(id("ENVB-03: a supplied created_at change with a refreshed core hash is refused"), () => {
    const t = variant.copy();
    // Moved *forward*, so the ordering check (B4) cannot be what answers: this
    // case is about identity, and only B3 can refuse a post-dated stamp.
    const forged = reseal({ ...readJson(t.retainedBundle), created_at: "2027-06-01T00:00:00Z" });
    assertRefused(verify(t, supply(forged)), "GRAPH_CLOSURE_UNREACHABLE_ARTIFACT", "ENVB-03");
  });

  test(id("ENVB-04: a falsified supplied core_hash is refused"), () => {
    const t = variant.copy();
    const bundle = readJson(t.retainedBundle);
    const forged = { ...bundle, core_hash: `sha256:${"c".repeat(64)}` };
    assert.notEqual(forged["core_hash"], bundle["core_hash"]);
    assertRefused(verify(t, supply(forged)), "ARTIFACT_HASH_MISMATCH", "ENVB-04");
  });

  test(id("ENVB-05: a supplied member path naming another retained path is refused"), () => {
    const t = variant.copy();
    const bundle = readJson(t.retainedBundle);
    const other = otherRetainedPath(t);
    assert.notEqual(artifactOf(bundle)["path"], other, "the substitution must actually move the path");
    // Re-sealed, so the refusal is the path binding rather than a stale hash.
    const forged = reseal(withMember(bundle, { ...artifactOf(bundle), path: other }));
    assertRefused(verify(t, supply(forged)), "BUNDLE_MEMBER_MISMATCH", "ENVB-05");
  });

  test(id("ENVB-06: a supplied member path naming a nonexistent path is refused"), () => {
    const t = variant.copy();
    const bundle = readJson(t.retainedBundle);
    const missing = "retained/no-such-artifact.json";
    assert.ok(!existsSync(path.join(t.artifacts, missing)), "the path must really not exist");
    const forged = reseal(withMember(bundle, { ...artifactOf(bundle), path: missing }));
    assertRefused(verify(t, supply(forged)), "BUNDLE_MEMBER_MISMATCH", "ENVB-06");
  });

  test(id("ENVB-07: a retained member path naming a nonexistent path is refused"), () => {
    // B1 proved independently of B3. The *retained* bundle is mutated and
    // re-sealed, and the supplied copy is an honest re-export of it — so the
    // supplied document and the retained document agree exactly, B3 is satisfied,
    // and the only remaining disagreement is between the declared path and the
    // artifact index.
    const t = variant.copy();
    const missing = "retained/no-such-artifact.json";
    const retained = rewriteRetained(t, (bundle) =>
      withMember(bundle, { ...artifactOf(bundle), path: missing }),
    );
    assert.ok(!existsSync(path.join(t.artifacts, missing)), "the path must really not exist");
    const outcome = verify(t, supply(retained));
    assert.equal(
      coreHash(retained),
      readJson(t.retainedBundle)["core_hash"],
      "the supplied copy is the retained document, so B3 cannot be what refuses",
    );
    assertRefused(outcome, "BUNDLE_MEMBER_MISMATCH", "ENVB-07");
  });

  test(id("ENVB-08: a falsified supplied member file_sha256 is refused"), () => {
    // The supplied half of the asymmetry this whole file exists for. Paired with
    // ENVB-09, which is the identical mutation on the retained side.
    const t = variant.copy();
    const bundle = readJson(t.retainedBundle);
    const forged = reseal(
      withMember(bundle, { ...artifactOf(bundle), file_sha256: `sha256:${"b".repeat(64)}` }),
    );
    assertRefused(verify(t, supply(forged)), "GRAPH_CLOSURE_UNREACHABLE_ARTIFACT", "ENVB-08");
  });

  test(id("ENVB-09: a falsified retained member file_sha256 is refused"), () => {
    const t = variant.copy();
    rewriteRetained(t, (bundle) =>
      withMember(bundle, { ...artifactOf(bundle), file_sha256: `sha256:${"b".repeat(64)}` }),
    );
    // The retained side keeps its own, older and more fundamental cause: the
    // referenced-bytes layer rehashes the named file and the digest disagrees.
    assertRefused(verifyExported(t), "ARTIFACT_HASH_MISMATCH", "ENVB-09");
  });

  test(id("ENVB-10: a falsified supplied member byte_length is refused"), () => {
    const t = variant.copy();
    const bundle = readJson(t.retainedBundle);
    const declared = artifactOf(bundle)["byte_length"] as number;
    const forged = reseal(withMember(bundle, { ...artifactOf(bundle), byte_length: declared + 1 }));
    assertRefused(verify(t, supply(forged)), "GRAPH_CLOSURE_UNREACHABLE_ARTIFACT", "ENVB-10");
  });

  test(id("ENVB-11: a falsified retained member byte_length is refused"), () => {
    const t = variant.copy();
    rewriteRetained(t, (bundle) =>
      withMember(bundle, {
        ...artifactOf(bundle),
        byte_length: (artifactOf(bundle)["byte_length"] as number) + 1,
      }),
    );
    assertRefused(verifyExported(t), "ARTIFACT_HASH_MISMATCH", "ENVB-11");
  });

  test(id("ENVB-12: a bundle back-dated before its signed finalization is refused"), () => {
    // B4 proved independently of B3: the retained bundle is moved too and the
    // supplied copy is an honest re-export, so the two documents agree and only
    // the ordering against the *signed* `finalized_at` is left to refuse.
    const t = variant.copy();
    const signed = finalizedAt(t);
    const backDated = "2000-01-01T00:00:00Z";
    assert.ok(Date.parse(backDated) < Date.parse(signed), "the case must really back-date");
    const retained = rewriteRetained(t, (bundle) => ({ ...bundle, created_at: backDated }));
    assertRefused(verify(t, supply(retained)), "GRAPH_CLOSURE_TERMINAL_MISMATCH", "ENVB-12");
  });

  // -- B3: the retained bundle has to exist, beneath `retained/` ---------------

  test(id("ENVB-13: a run retaining no public bundle cannot verify from a detached copy"), () => {
    const t = variant.copy();
    const honest = readJson(t.retainedBundle);
    // The marker goes with it: a freeze marker whose content file is gone is an
    // orphan, and would refuse through retained-file accounting instead — which
    // would prove nothing about the binding.
    rmSync(t.retainedBundle);
    rmSync(`${t.retainedBundle}.frozen`, { force: true });
    assertRefused(verify(t, supply(honest)), "GRAPH_CLOSURE_UNREACHABLE_ARTIFACT", "ENVB-13");
  });

  test(id("ENVB-14: a public bundle indexed only outside retained/ is not retained authority"), () => {
    const t = variant.copy();
    const honest = readJson(t.retainedBundle);
    const outside = path.join(t.artifacts, "elsewhere", "public-bundle.json");
    mkdirSync(path.dirname(outside), { recursive: true });
    chmodSync(t.retainedBundle, 0o644);
    renameSync(t.retainedBundle, outside);
    rmSync(`${t.retainedBundle}.frozen`, { force: true });
    assert.ok(existsSync(outside), "the bundle is still indexed, just not retained");
    assertRefused(verify(t, supply(honest)), "GRAPH_CLOSURE_UNREACHABLE_ARTIFACT", "ENVB-14");
  });

  test(id("ENVB-15: a correctly accounted bundle nested deeper beneath retained/ stays valid"), () => {
    // The rule is the `retained/` subtree, not the literal path
    // `retained/public-bundle.json`. A producer that nests its retained bundle
    // and accounts it correctly is not doing anything this correction is about.
    const t = variant.copy();
    const nested = path.join(path.dirname(t.retainedBundle), "nested", "public-bundle.json");
    mkdirSync(path.dirname(nested), { recursive: true });
    chmodSync(t.retainedBundle, 0o644);
    const honest = readJson(t.retainedBundle);
    renameSync(t.retainedBundle, nested);
    if (existsSync(`${t.retainedBundle}.frozen`)) {
      chmodSync(`${t.retainedBundle}.frozen`, 0o644);
      renameSync(`${t.retainedBundle}.frozen`, `${nested}.frozen`);
    }
    assertAccepted(verify(t, supply(honest)), "ENVB-15");
  });

  // -- compatibility ----------------------------------------------------------

  test(id("ENVB-COMPAT: the retained bundle verifies when supplied by its own path"), () => {
    // `erl2 verify --public-bundle <root>/retained/public-bundle.json` is how the
    // repository's own evidence run and CI lane verify a terminal.
    const t = variant.copy();
    assertAccepted(verify(t, t.retainedBundle), "the retained bundle supplied in place");
  });

  test(id("ENVB-COMPAT: a differently serialized copy of the same canonical bundle verifies"), () => {
    const t = variant.copy();
    const retained = readJson(t.retainedBundle);
    // Key order reversed and the whole document re-indented: different bytes,
    // same canonical projection. The binding compares identity, not bytes.
    const reordered: Json = {};
    for (const key of Object.keys(retained).reverse()) reordered[key] = retained[key];
    const file = path.join(ownedTempDir("erl2-envb-reser-"), "supplied.json");
    writeFileSync(file, JSON.stringify(reordered));
    assert.notDeepEqual(
      readFileSync(file),
      readFileSync(t.retainedBundle),
      "the two documents must really differ in bytes",
    );
    assert.equal(coreHash(reordered), retained["core_hash"], "and must really share an identity");
    assertAccepted(verify(t, file), "a re-serialized copy");
  });

  test(id("ENVB-COMPAT: cross-run substitution keeps its existing run-binding refusal"), () => {
    // The tail binding must not mask a cause an earlier rule already owns. A
    // bundle naming a different run than its attestation is refused by the run
    // binding, not by B3 — even though B3 would also have refused it.
    const t = variant.copy();
    const forged = reseal({
      ...readJson(t.retainedBundle),
      run_id: "00000000-0000-7000-8000-ffffffffffff",
    });
    const outcome = verify(t, supply(forged));
    assertRefused(outcome, "GRAPH_CLOSURE_TERMINAL_MISMATCH", "cross-run substitution");
    assert.match(outcome.message, /different runs/, "the run binding is what answered");
  });

  // -- deliberately residual producer-side metadata ---------------------------

  test(id("ENVB-RESIDUE: a consistently changed retained bundle_id is accepted"), () => {
    // `bundle_id` is non-authoritative at the trusted-local tier: no semantic
    // verdict consumes it, and no retained byte can contradict a producer that
    // chose a different name for its own envelope. Accepted here does **not**
    // mean the value is trustworthy — it means the verifier makes no claim about
    // it. What B3 does establish is that the supplied and retained documents are
    // the same canonical document, which this case keeps true.
    const t = variant.copy();
    const retained = rewriteRetained(t, (bundle) => ({ ...bundle, bundle_id: "a-renamed-envelope" }));
    assertAccepted(verify(t, supply(retained)), "a consistently renamed bundle");
  });

  test(id("ENVB-RESIDUE: consistently changed member media_type and classification are accepted"), () => {
    // Both fields are non-authoritative at this tier: no semantic verdict
    // consumes either, and neither is covered by a signature. The test does not
    // claim the declared values are true of the bytes.
    const t = variant.copy();
    const retained = rewriteRetained(t, (bundle) =>
      withMember(bundle, {
        ...artifactOf(bundle),
        media_type: "application/vnd.erl2-relabelled+json",
        classification: "PUBLIC",
      }),
    );
    assertAccepted(verify(t, supply(retained)), "a relabelled member");
  });

  test(id("ENVB-RESIDUE: a consistently post-dated created_at is accepted"), () => {
    // The post-dating direction is non-authoritative residue: an honest producer
    // creates the bundle after finalizing, so no retained byte contradicts a
    // later stamp. Only back-dating (ENVB-12) is refusable, and only because
    // `finalized_at` is signed. This is not a claim that the stamp is true.
    const t = variant.copy();
    const later = "2030-01-01T00:00:00Z";
    assert.ok(Date.parse(later) > Date.parse(finalizedAt(t)), "the case must really post-date");
    const retained = rewriteRetained(t, (bundle) => ({ ...bundle, created_at: later }));
    assertAccepted(verify(t, supply(retained)), "a consistently post-dated bundle");
  });
}

// -- `.frozen` sidecars are not evidence --------------------------------------

/**
 * A freeze marker beside a retained content file, and a second one for the swap
 * case. Both are asserted present, so a renamed producer convention fails these
 * tests loudly rather than passing them vacuously.
 */
function markers(t: Terminal): { readonly first: string; readonly second: string } {
  const first = `${t.retainedBundle}.frozen`;
  const second = path.join(path.dirname(t.retainedBundle), "final-attestation.json.frozen");
  assert.ok(existsSync(first), `${first} must exist for the sidecar cases to mean anything`);
  assert.ok(existsSync(second), `${second} must exist for the swap case to mean anything`);
  return { first, second };
}

/**
 * Every `.frozen` content mutation that must change nothing.
 *
 * A `.frozen` sidecar is a **producer-owned freeze-completion record**. It has
 * no evidence schema, no contract and no registry entry; the verifier never
 * opens one, so it carries no trustworthy digest, length, path, media type or
 * classification. These cases are permanent so that the absence of a reader
 * stays a recorded property rather than an assumption — each asserts that the
 * verdict does not move, and none asserts that the mutated value is true.
 */
const FROZEN_CONTENT_MUTATIONS: ReadonlyArray<readonly [string, (original: string) => string]> = [
  ["a false file_sha256", (o) => JSON.stringify({ ...JSON.parse(o), file_sha256: `sha256:${"d".repeat(64)}` })],
  ["a false byte_length", (o) => JSON.stringify({ ...JSON.parse(o), byte_length: 999_999 })],
  ["a false logical_path", (o) => JSON.stringify({ ...JSON.parse(o), logical_path: "retained/somewhere-else.json" })],
  ["a false media_type", (o) => JSON.stringify({ ...JSON.parse(o), media_type: "text/plain" })],
  ["a false classification", (o) => JSON.stringify({ ...JSON.parse(o), classification: "SECRET" })],
  ["an unknown field", (o) => JSON.stringify({ ...JSON.parse(o), authority: "trust me" })],
  ["an empty object", () => "{}"],
  ["non-JSON bytes", () => "this is not JSON at all\n"],
];

for (const variant of VARIANTS) {
  const id = (suffix: string): string => `${suffix} [${variant.label}]`;

  for (const [what, mutate] of FROZEN_CONTENT_MUTATIONS) {
    test(id(`FROZEN: a marker carrying ${what} changes no verdict`), () => {
      const t = variant.copy();
      const { first } = markers(t);
      overwrite(first, mutate(readFileSync(first, "utf8")));
      // The sidecar is not evidence: the verifier accounts its filename and never
      // reads its contents, so no semantic verdict consumes any value inside it.
      // This does not assert the mutated value is trustworthy — it asserts the
      // opposite, that nothing depends on it.
      assertAccepted(verifyExported(t), `a marker carrying ${what}`);
    });
  }

  test(id("FROZEN: a deleted marker changes no verdict"), () => {
    const t = variant.copy();
    const { first } = markers(t);
    rmSync(first);
    // The content file is still accounted as an indexed artifact in its own
    // right; the marker only ever rode along on it. Not a claim that the marker
    // was worth anything while it existed.
    assertAccepted(verifyExported(t), "a deleted marker");
  });

  test(id("FROZEN: two swapped markers change no verdict"), () => {
    const t = variant.copy();
    const { first, second } = markers(t);
    const a = readFileSync(first, "utf8");
    const b = readFileSync(second, "utf8");
    assert.notEqual(a, b, "the swap must really exchange two different documents");
    overwrite(first, b);
    overwrite(second, a);
    // Each marker now describes the other's content file. Nothing notices,
    // because nothing reads them. Not a claim that either marker is now correct.
    assertAccepted(verifyExported(t), "swapped markers");
  });

  test(id("FROZEN: an orphan marker keeps its existing unaccounted-file refusal"), () => {
    // The one thing a `.frozen` name can still do, and it is filename accounting
    // rather than content authority: a marker whose content file does not exist
    // is an unaccounted retained byte-stream like any other.
    const t = variant.copy();
    const orphan = path.join(path.dirname(t.retainedBundle), "no-such-artifact.json.frozen");
    writeFileSync(orphan, `${JSON.stringify({ logical_path: "retained/no-such-artifact.json" })}\n`);
    assert.ok(!existsSync(orphan.slice(0, -".frozen".length)), "the marker must really be an orphan");
    assertRefused(verifyExported(t), "GRAPH_CLOSURE_EXTRA_ARTIFACT", "an orphan marker");
  });
}

// -- refusal-cause preservation, at the level of the source -------------------

test("ENVB-ARCH: both terminal branches carry the same four checks", () => {
  // The correction is two shared helpers called from two branches. Asserted at
  // the source so a future edit cannot close one branch and leave the other
  // open — the shape the pre-environment run binding was in before PR #24.
  const source = readFileSync(VERIFY_SOURCE, "utf8");
  assert.equal(
    source.split("assertSuppliedBundleIsRetained(bundle, index);").length - 1,
    2,
    "B1-B3 must run on both terminal variants",
  );
  assert.equal(
    source.split("assertBundleNotBackDated(bundle.created_at, attestation.finalized_at);").length - 1,
    2,
    "B4 must run on both terminal variants",
  );
});

test("ENVB-ARCH: the supplied-to-retained binding runs at the tail of each branch", () => {
  // Placement is load-bearing, not stylistic. Run near `ArtifactIndex.scan` this
  // binding would answer first for mutations that already have their own, more
  // specific causes, and a reader would be told the envelope did not match when
  // the fault was in the evidence. Pinned structurally: in each branch the call
  // must appear after the semantic derivation and immediately before the valid
  // return.
  const source = readFileSync(VERIFY_SOURCE, "utf8");
  const scanAt = source.indexOf("ArtifactIndex.scan(options.artifactRoot)");
  assert.ok(scanAt > 0);
  for (const derivation of ["derivePreEnvironmentValidity({", "deriveEnvironmentSemantics({"]) {
    const derivedAt = source.indexOf(derivation);
    assert.ok(derivedAt > 0, `${derivation} must still exist`);
    const bindingAt = source.indexOf("assertSuppliedBundleIsRetained(bundle, index);", derivedAt);
    assert.ok(
      bindingAt > derivedAt,
      `the binding must run after ${derivation}, not before it`,
    );
    const returnAt = source.indexOf('verdict: "valid"', bindingAt);
    assert.ok(returnAt > bindingAt, "the binding must be the last thing before the valid return");
  }
});

test("ENVB-ARCH: the correction introduces no new refusal code", () => {
  // Four existing Appendix B codes, reused exactly. A new code would be a new
  // consumer-visible concept, and this correction is not one.
  const errors = readFileSync(
    path.join(repoRoot, "packages", "contracts", "src", "errors.ts"),
    "utf8",
  );
  for (const code of [
    "BUNDLE_MEMBER_MISMATCH",
    "ARTIFACT_HASH_MISMATCH",
    "GRAPH_CLOSURE_UNREACHABLE_ARTIFACT",
    "GRAPH_CLOSURE_TERMINAL_MISMATCH",
  ]) {
    assert.match(errors, new RegExp(`\\b${code}: "${code}"`), `${code} must still be declared as it was`);
  }
});

test("ENVB-COMPAT: the shipped exported pre-environment bundle still verifies byte-for-byte", () => {
  // The committed golden ships an exported copy alongside the retained one, and
  // the two are serialized differently while sharing a canonical identity. It is
  // the document an external consumer is actually handed, so it is verified here
  // exactly as shipped — copied, never written to.
  const t = copyPreEnvironment();
  const exported = t.exportedBundle;
  assert.ok(exported !== undefined, "the pre-environment golden ships an exported copy");
  assert.notDeepEqual(
    readFileSync(exported),
    readFileSync(t.retainedBundle),
    "the shipped export and the retained copy really are different bytes",
  );
  assert.equal(
    coreHash(readJson(exported)),
    coreHash(readJson(t.retainedBundle)),
    "and really do share one canonical identity",
  );
  assertAccepted(verify(t, exported), "the shipped exported bundle");
});

// -- the matrix: no previously refused mutation changed its cause -------------

/**
 * Mutations that were already refused before this correction existed, each
 * pinned to the code it refused with then.
 *
 * This is the cause-specificity half of the tail-placement argument. Placing
 * B1-B3 early is *known* to mask cases across `ARTIFACT_HASH_MISMATCH`,
 * `GRAPH_CLOSURE_TERMINAL_MISMATCH` and `GRAPH_CLOSURE_EXTRA_ARTIFACT`, because
 * the supplied envelope disagrees with the retained tree in every one of them —
 * so "it still refuses" is not the property that matters. What matters is that
 * it refuses for the same reason, and that is what these pin.
 */
const PRESERVED: ReadonlyArray<{
  readonly name: string;
  readonly code: string;
  readonly apply: (t: Terminal) => string;
}> = [
  {
    name: "a bundle naming a different run than its attestation",
    code: "GRAPH_CLOSURE_TERMINAL_MISMATCH",
    apply: (t) =>
      supply(reseal({ ...readJson(t.retainedBundle), run_id: "00000000-0000-7000-8000-ffffffffffff" })),
  },
  {
    name: "a bundle member the attestation does not attest",
    code: "GRAPH_CLOSURE_TERMINAL_MISMATCH",
    apply: (t) => {
      // Pointed at a real retained artifact read from disk, so the refusal is the
      // attestation binding rather than an unresolvable hash. B1 would refuse
      // this too — at the tail, which is exactly why the earlier, more specific
      // cause is the one a reader still sees.
      const policy = readJson(path.join(t.artifacts, "retained", "trust-policy.json"));
      const bundle = readJson(t.retainedBundle);
      const member = bundle["acquisition_preregistration_verification_receipt"] as Json;
      assert.notEqual(member["artifact_core_hash"], policy["core_hash"]);
      return supply(
        reseal({
          ...bundle,
          acquisition_preregistration_verification_receipt: {
            ...member,
            artifact_core_hash: policy["core_hash"],
          },
        }),
      );
    },
  },
  {
    name: "a falsified retained member digest",
    code: "ARTIFACT_HASH_MISMATCH",
    apply: (t) => {
      const retained = rewriteRetained(t, (bundle) =>
        withMember(bundle, { ...artifactOf(bundle), file_sha256: `sha256:${"b".repeat(64)}` }),
      );
      return supply(retained);
    },
  },
  {
    name: "an unaccounted retained file",
    code: "GRAPH_CLOSURE_EXTRA_ARTIFACT",
    apply: (t) => {
      const honest = readJson(t.retainedBundle);
      writeFileSync(path.join(path.dirname(t.retainedBundle), "rogue.bin"), "not an artifact\n");
      return supply(honest);
    },
  },
  {
    name: "an orphan freeze marker",
    code: "GRAPH_CLOSURE_EXTRA_ARTIFACT",
    apply: (t) => {
      const honest = readJson(t.retainedBundle);
      writeFileSync(path.join(path.dirname(t.retainedBundle), "gone.json.frozen"), "{}\n");
      return supply(honest);
    },
  },
  {
    // Refused by the closed schema's `const`, not by the verifier's own
    // `TRUST_HEAD_SELF_ANCHORED` branch — that branch is defence in depth behind
    // `assertContract` and is unreachable through the CLI. Recorded with the code
    // it actually produces rather than the one it looks like it should.
    name: "a bundle naming its own trust head source",
    code: "SCHEMA_VALIDATION_FAILED",
    apply: (t) =>
      supply(
        reseal({ ...readJson(t.retainedBundle), verification_trust_head_source: "bundle_declared" }),
      ),
  },
];

for (const variant of VARIANTS) {
  for (const preserved of PRESERVED) {
    test(`ENVB-MATRIX: ${preserved.name} keeps ${preserved.code} [${variant.label}]`, () => {
      const t = variant.copy();
      const outcome = verify(t, preserved.apply(t));
      assertRefused(outcome, preserved.code, preserved.name);
    });
  }
}

test("ENVB-MATRIX: the environment selection-receipt substitution keeps BUNDLE_MEMBER_MISMATCH", () => {
  // Named separately because it exists only on the environment variant, and
  // because it is the one pre-existing `BUNDLE_MEMBER_MISMATCH` case — the code
  // B1 now reuses. It is refused by the *attestation's* selection binding, well
  // before the tail, and must stay that way.
  const t = copyEnvironment();
  const bundle = readJson(t.retainedBundle);
  const member = bundle["selection_verification_receipt"] as Json;
  const forged = {
    ...bundle,
    selection_verification_receipt: { ...member, artifact_core_hash: `sha256:${"e".repeat(64)}` },
  };
  assert.notEqual(member["artifact_core_hash"], `sha256:${"e".repeat(64)}`);
  assertRefused(verify(t, supply(forged)), "BUNDLE_MEMBER_MISMATCH", "the selection receipt substitution");
});
