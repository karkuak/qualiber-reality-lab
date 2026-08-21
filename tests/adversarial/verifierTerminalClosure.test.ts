/**
 * RL-D-027 — the lifecycle tail past the signed terminal.
 *
 * ## The boundary this file measures
 *
 * `run_record.lifecycle_head_hash` is signed, transitively, through the
 * attestation's `run_record_hash`. `verifyLifecycleChain` makes every event's
 * `core_hash` cover its own `prior_event_hash`, so events `0..freeze` are a hash
 * chain terminating in that signed head: altering any one of them changes the
 * head and the terminal refuses.
 *
 * That leaves exactly two unbound surfaces, and they are the whole finding:
 *
 *   - the **publishing event itself** — it sits *after* the freeze point, so its
 *     `produced[]` is covered by no signed value; and
 *   - **anything appended after it** — the stream has no signed length.
 *
 * A `produced` entry in either place enters the closure through
 * `derivedRolesFromLifecycle`, and the closure admits it on `index.get(hash)`
 * alone. The result is attacker-authored content accounted as evidence inside a
 * bundle the verifier reports `valid`.
 *
 * ## What closes it, and why it needs no new signed field
 *
 * The publishing event is identified by the **signed** `run_record_hash`, never
 * by an event label, so the attacker cannot move it. Pinning the two unbound
 * surfaces against it is therefore sufficient:
 *
 *   (a) nothing may follow the publishing event; and
 *   (b) its produced set must be *exactly* the terminal role set.
 *
 * Clause (b) is load-bearing on its own: case A4 injects into the existing
 * publishing event and appends nothing at all, so (a) alone would not see it.
 *
 * ## Reading the assertions
 *
 * Every attack is made self-consistent before the verifier sees it — chain
 * refreshed, hashes recomputed — and the test asserts that self-consistency
 * separately. A refusal that came from a stale hash or a schema violation would
 * prove nothing about the boundary, so each case pins the typed code. The
 * shipped goldens are copied, never written to.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { chmodSync, cpSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { coreHash } from "@erl2/integrity";
import { ArtifactIndex } from "@erl2/public-verifier";
import {
  erl2,
  runToEnvironmentTerminal,
  writeLifecycle as writeDerivedLifecycle,
  writeTrustConfig,
} from "../support/cliRun.js";
import { ownedTempDir } from "../support/tempDirs.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const GOLDEN_ROOT = path.join(repoRoot, "fixtures", "golden");

/** The three committed pre-environment public bundles. */
const PRE_ENVIRONMENT_GOLDENS = [
  "valid-pre-environment-run",
  "generic-finalization-failed-verification",
  "generic-finalization-unsupported-verification",
] as const;

/**
 * Where each golden keeps its bundle, artifact root and lifecycle.
 *
 * The two `generic-finalization-*` goldens are staged as a bare run root under
 * `artifacts/`, so their bundle, root config and lifecycle all live *inside* the
 * artifact root; `valid-pre-environment-run` keeps them alongside it. Both
 * shapes are what `scripts/generate-evidence.mjs` stages, so both are verified
 * exactly as the evidence run verifies them.
 */
function layoutOf(name: string): {
  bundle: string;
  artifacts: string;
  lifecycle: string;
  rootConfig: string;
} {
  if (name === "valid-pre-environment-run") {
    return {
      bundle: "public-bundle.json",
      artifacts: "artifacts",
      lifecycle: "lifecycle.json",
      rootConfig: "root-config.json",
    };
  }
  return {
    bundle: path.join("artifacts", "retained", "public-bundle.json"),
    artifacts: "artifacts",
    lifecycle: path.join("artifacts", "lifecycle.json"),
    rootConfig: path.join("artifacts", "root-config.json"),
  };
}

interface Copy {
  readonly dir: string;
  readonly bundle: string;
  readonly artifacts: string;
  readonly lifecycle: string;
  readonly rootConfig: string;
}

function copyGolden(name: string = "valid-pre-environment-run"): Copy {
  const dir = ownedTempDir("erl2-d027-");
  cpSync(path.join(GOLDEN_ROOT, name), dir, { recursive: true });
  const l = layoutOf(name);
  return {
    dir,
    bundle: path.join(dir, l.bundle),
    artifacts: path.join(dir, l.artifacts),
    lifecycle: path.join(dir, l.lifecycle),
    rootConfig: path.join(dir, l.rootConfig),
  };
}

interface Outcome {
  readonly exitCode: number;
  readonly code: string;
  readonly message: string;
  readonly verdict: string;
}

/** The offline verifier, in a fresh process, exactly as an external consumer runs it. */
function verifyOffline(c: Copy): Outcome {
  const result = erl2([
    "verify",
    "--public-bundle", c.bundle,
    "--root-config", c.rootConfig,
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

type Event = Record<string, unknown> & {
  sequence: number;
  state_from: string;
  state_to: string;
  prior_event_hash?: string;
  core_hash: string;
  produced: { artifact_role: string; artifact_core_hash: string; artifact_schema_version: string }[];
};

function readLifecycle(c: Copy): Event[] {
  return JSON.parse(readFileSync(c.lifecycle, "utf8")) as Event[];
}

function writeLifecycle(c: Copy, events: readonly Event[]): void {
  chmodSync(c.lifecycle, 0o644);
  writeFileSync(c.lifecycle, `${JSON.stringify(events, null, 2)}\n`);
}

/** Recomputes an event's `core_hash` over its own canonical bytes. */
function seal(event: Omit<Event, "core_hash"> & { core_hash?: string }): Event {
  const { core_hash: _drop, ...body } = event;
  return { ...body, core_hash: coreHash(body as Record<string, unknown>) } as Event;
}

/**
 * Re-chains a whole stream: every event's `prior_event_hash` is set to its
 * predecessor's recomputed `core_hash`, so the result passes
 * `verifyLifecycleChain` no matter what was edited inside it.
 */
function rechain(events: readonly Event[]): Event[] {
  const out: Event[] = [];
  let prior: string | undefined;
  for (const [i, event] of events.entries()) {
    const next = { ...event, sequence: i } as Event & { prior_event_hash?: string };
    if (prior === undefined) delete next.prior_event_hash;
    else next.prior_event_hash = prior;
    const sealed = seal(next);
    out.push(sealed);
    prior = sealed.core_hash;
  }
  return out;
}

/** Writes a retained artifact and returns its recomputed core hash. */
function freezeArtifact(c: Copy, relative: string, body: Record<string, unknown>): string {
  const hash = coreHash(body);
  const target = path.join(c.artifacts, relative);
  writeFileSync(target, `${JSON.stringify({ ...body, core_hash: hash }, null, 2)}\n`);
  return hash;
}

/** A trailing event that continues the chain from wherever it is appended. */
function tailEvent(
  template: Event,
  overrides: Partial<Event> & { produced?: Event["produced"] },
): Event {
  return {
    ...template,
    event_id: "evt-000099",
    event_type: "post_terminal_note",
    occurred_at: "2026-07-01T00:00:41Z",
    operation_id: "op-tail",
    required_hashes: [],
    produced: [],
    ...overrides,
  } as Event;
}

/** The index of the event that publishes the terminal run record. */
function publishingIndexOf(events: readonly Event[]): number {
  return events.findIndex((e) => e.produced.some((p) => p.artifact_role === "run-record"));
}

// -- baselines ---------------------------------------------------------------

for (const name of PRE_ENVIRONMENT_GOLDENS) {
  test(`D027-BASELINE: the committed golden ${name} verifies offline`, () => {
    const outcome = verifyOffline(copyGolden(name));
    assert.equal(outcome.exitCode, 0, `${outcome.code}: ${outcome.message}`);
    assert.equal(outcome.verdict, "valid");
  });
}

// -- attacks -----------------------------------------------------------------

test("D027-A1: a well-formed trailing event carrying an extra opaque artifact is refused", () => {
  const c = copyGolden();
  const events = readLifecycle(c);
  const last = events[events.length - 1] as Event;

  // A product artifact of a schema the Lab does not define: opaque by policy,
  // and admitted purely because an event said it was produced.
  const planted = freezeArtifact(c, path.join("retained", "planted-note.json"), {
    schema_version: "vendor-note/v1",
    note: "attacker authored, admitted as accounted evidence",
  });
  const appended = rechain([
    ...events,
    tailEvent(last, {
      state_from: last.state_to,
      state_to: "post_terminal_note",
      produced: [
        {
          artifact_role: "finding",
          artifact_core_hash: planted,
          artifact_schema_version: "vendor-note/v1",
        },
      ],
    }),
  ]);
  writeLifecycle(c, appended);

  // The stream the verifier reads is a valid chain before it is judged: this is
  // not a malformed-append test wearing the right name.
  for (const [i, e] of appended.entries()) {
    const { core_hash: declared, ...body } = e;
    assert.equal(coreHash(body), declared, `appended event ${String(i)} must be self-consistent`);
  }

  const outcome = verifyOffline(c);
  assert.notEqual(outcome.exitCode, 0, `a trailing event must be refused; verdict ${outcome.verdict}`);
  assert.equal(
    outcome.code,
    "GRAPH_CLOSURE_LIFECYCLE_TAIL_AFTER_TERMINAL",
    `the refusal must be the tail boundary: ${outcome.message}`,
  );
});

test("D027-A2: multiple well-formed trailing events are refused", () => {
  const c = copyGolden();
  const events = readLifecycle(c);
  const last = events[events.length - 1] as Event;
  const planted = freezeArtifact(c, path.join("retained", "planted-note.json"), {
    schema_version: "vendor-note/v1",
    note: "second-hop plant",
  });
  writeLifecycle(
    c,
    rechain([
      ...events,
      tailEvent(last, { state_from: last.state_to, state_to: "post_terminal_a", produced: [] }),
      tailEvent(last, {
        event_id: "evt-000100",
        state_from: "post_terminal_a",
        state_to: "post_terminal_b",
        produced: [
          { artifact_role: "finding", artifact_core_hash: planted, artifact_schema_version: "vendor-note/v1" },
        ],
      }),
    ]),
  );

  const outcome = verifyOffline(c);
  assert.notEqual(outcome.exitCode, 0, `trailing events must be refused; verdict ${outcome.verdict}`);
  assert.equal(outcome.code, "GRAPH_CLOSURE_LIFECYCLE_TAIL_AFTER_TERMINAL", outcome.message);
});

test("D027-A3: a backward state transition after finalization is refused", () => {
  const c = copyGolden();
  const events = readLifecycle(c);
  const last = events[events.length - 1] as Event;
  const earlier = events[10] as Event;
  writeLifecycle(
    c,
    rechain([
      ...events,
      // Produces nothing: the point is that the terminal is no longer terminal.
      tailEvent(last, { state_from: last.state_to, state_to: earlier.state_to, produced: [] }),
    ]),
  );

  const outcome = verifyOffline(c);
  assert.notEqual(outcome.exitCode, 0, `a post-terminal transition must be refused; verdict ${outcome.verdict}`);
  assert.equal(outcome.code, "GRAPH_CLOSURE_LIFECYCLE_TAIL_AFTER_TERMINAL", outcome.message);
});

test("D027-A4: a produced entry injected into the publishing event, with no trailing event, is refused", () => {
  const c = copyGolden();
  const events = readLifecycle(c);
  const at = publishingIndexOf(events);
  assert.ok(at >= 0, "the golden must publish a run record");
  assert.equal(at, events.length - 1, "the golden's publishing event is already last");

  const planted = freezeArtifact(c, path.join("retained", "planted-note.json"), {
    schema_version: "vendor-note/v1",
    note: "injected into the finalize event itself",
  });
  const injected = events.map((e, i) =>
    i === at
      ? ({
          ...e,
          produced: [
            ...e.produced,
            { artifact_role: "finding", artifact_core_hash: planted, artifact_schema_version: "vendor-note/v1" },
          ],
        } as Event)
      : e,
  );
  const sealed = rechain(injected);
  writeLifecycle(c, sealed);

  // The signed freeze head is untouched: the publishing event lies *after* the
  // freeze point, so editing it breaks no signed binding. That is the whole
  // reason clause (b) has to exist.
  const record = JSON.parse(
    readFileSync(path.join(c.artifacts, "retained", "run-record.json"), "utf8"),
  ) as { lifecycle_head_hash: string };
  assert.equal(
    record.lifecycle_head_hash,
    (sealed[at - 1] as Event).core_hash,
    "the injection must leave the signed freeze head satisfied",
  );
  assert.equal(sealed.length, events.length, "no event was appended");

  const outcome = verifyOffline(c);
  assert.notEqual(outcome.exitCode, 0, `an injected product must be refused; verdict ${outcome.verdict}`);
  assert.equal(
    outcome.code,
    "GRAPH_CLOSURE_TERMINAL_EVENT_EXTRA_PRODUCT",
    `the refusal must be the exact-terminal-role rule: ${outcome.message}`,
  );
});

test("D027-A5: a contract-invalid plant cited by a trailing event is refused", () => {
  const c = copyGolden();
  const events = readLifecycle(c);
  const last = events[events.length - 1] as Event;

  // `finding/v1` is a schema the Lab's own registry defines -- as a closed union
  // of six variants -- and this document satisfies none of them. Its `core_hash`
  // is recomputed, so no integrity check can be the refusal, and a trailing
  // event cites it, so the unaccounted-extra rule cannot be either.
  const planted = freezeArtifact(c, path.join("retained", "planted-finding.json"), {
    schema_version: "finding/v1",
    kind: "subject_finding",
    safe_summary: "declares a Lab contract and satisfies none of it",
  });
  writeLifecycle(
    c,
    rechain([
      ...events,
      tailEvent(last, {
        state_from: last.state_to,
        state_to: "post_terminal_note",
        produced: [
          { artifact_role: "finding", artifact_core_hash: planted, artifact_schema_version: "finding/v1" },
        ],
      }),
    ]),
  );

  const outcome = verifyOffline(c);
  assert.notEqual(outcome.exitCode, 0, `a contract-invalid plant must be refused; verdict ${outcome.verdict}`);
  // The tail rule fires first, and that is the correct precedence: the plant's
  // route into the closure is the structural violation, which is the more
  // fundamental cause. The contract gate is the second line, and it is measured
  // where it actually bites -- on an artifact admitted through a *legitimate*
  // role -- by D027-A5b below and by D028-A5.
  assert.equal(outcome.code, "GRAPH_CLOSURE_LIFECYCLE_TAIL_AFTER_TERMINAL", outcome.message);
});

test("D027-A5b: admitting a contract-invalid known-schema artifact to closure is refused", () => {
  const c = copyGolden();
  // The gate at its own boundary. `admit` is what every closure role calls, and
  // it is the moment an artifact stops being a file on disk and becomes
  // accounted evidence -- so this is the exact question the finding is about:
  // may attacker-authored content wearing a Lab contract's name be admitted?
  const planted = freezeArtifact(c, path.join("retained", "planted-finding.json"), {
    schema_version: "finding/v1",
    kind: "subject_finding",
    safe_summary: "declares a Lab contract and satisfies none of it",
  });
  const index = ArtifactIndex.scan(c.artifacts);

  // It resolves -- the bytes are on disk and the hash is honest. Resolving is
  // not admitting, and that distinction is the fix.
  assert.equal(index.get(planted as `sha256:${string}`).coreHash, planted);
  assert.throws(
    () => index.admit(planted as `sha256:${string}`),
    (error: unknown) => (error as { code?: string }).code === "GRAPH_CLOSURE_RETAINED_CONTRACT_INVALID",
    "a contract-invalid known-schema artifact must not be admitted",
  );

  // And the same call on a genuine retained artifact of the same schema admits
  // it, so the gate is discriminating rather than merely refusing.
  const genuine = readFileSync(
    path.join(c.artifacts, "retained", "subject-package-verification-finding.json"),
    "utf8",
  );
  const genuineHash = (JSON.parse(genuine) as { core_hash: `sha256:${string}` }).core_hash;
  assert.equal(index.admit(genuineHash).coreHash, genuineHash);
});

// -- controls ----------------------------------------------------------------

test("D027-C1: an earlier event edited with the chain refreshed still breaks the signed freeze head", () => {
  const c = copyGolden();
  const events = readLifecycle(c);
  // Edit an event well before the freeze point and refresh every downstream
  // hash. The chain is valid again -- and the *signed* head no longer matches.
  const edited = events.map((e, i) => (i === 6 ? ({ ...e, actor_id: "attacker" } as Event) : e));
  const sealed = rechain(edited);
  writeLifecycle(c, sealed);
  for (const [i, e] of sealed.entries()) {
    const { core_hash: declared, ...body } = e;
    assert.equal(coreHash(body), declared, `event ${String(i)} must be self-consistent`);
  }

  const outcome = verifyOffline(c);
  assert.notEqual(outcome.exitCode, 0, "a rewritten prefix must be refused");
  assert.equal(outcome.code, "GRAPH_CLOSURE_TERMINAL_MISMATCH", outcome.message);
});

test("D027-C2: an artifact of an unrecognized schema stays opaque and is refused only as an extra", () => {
  const c = copyGolden();
  // The lower bracket on the known-schema gate. `vendor-note/v1` is not a Lab
  // contract, so nothing may parse it as one -- it is product bytes. It is still
  // refused, but by the pre-existing unaccounted-extra rule, and the *code* is
  // the assertion: a `RETAINED_CONTRACT_INVALID` here would mean the gate had
  // started guessing at schemas it does not define.
  freezeArtifact(c, path.join("retained", "planted-note.json"), {
    schema_version: "vendor-note/v1",
    note: "no event cites this, and no Lab contract claims it",
  });
  const outcome = verifyOffline(c);
  assert.notEqual(outcome.exitCode, 0, "an uncited retained artifact must be refused");
  assert.equal(
    outcome.code,
    "GRAPH_CLOSURE_EXTRA_ARTIFACT",
    `an unknown schema must stay opaque, not be contract-checked: ${outcome.message}`,
  );
});

test("D027-C3: a malformed trailing event is refused", () => {
  const c = copyGolden();
  const events = readLifecycle(c);
  const last = events[events.length - 1] as Event;
  // Sequenced and chained correctly, so the refusal is the missing member
  // itself rather than a gap the append happened to create.
  const malformed = {
    ...tailEvent(last, {
      state_from: last.state_to,
      state_to: "post_terminal_note",
      sequence: events.length,
      prior_event_hash: last.core_hash,
    }),
  } as Record<string, unknown>;
  delete malformed["event_type"];
  const { core_hash: _drop, ...body } = malformed;
  writeLifecycle(c, [...events, { ...body, core_hash: coreHash(body) } as Event]);
  const outcome = verifyOffline(c);
  // The refusal itself is the invariant. Which code carries it is pre-existing
  // behaviour this change deliberately does not touch: a lifecycle event missing
  // a required member is refused untyped today, and retyping it would be an
  // unrelated edit to the refusal contract.
  assert.notEqual(outcome.exitCode, 0, "a malformed event must be refused");
  assert.notEqual(outcome.verdict, "valid", `a malformed event must not verify: ${outcome.code}`);
});

test("D027-C4: a trailing event with a stale core hash is refused", () => {
  const c = copyGolden();
  const events = readLifecycle(c);
  const last = events[events.length - 1] as Event;
  const appended = rechain([
    ...events,
    tailEvent(last, { state_from: last.state_to, state_to: "post_terminal_note" }),
  ]);
  // Break only the tail's own hash.
  const broken = appended.map((e, i) =>
    i === appended.length - 1 ? ({ ...e, core_hash: `sha256:${"0".repeat(64)}` } as Event) : e,
  );
  writeLifecycle(c, broken);
  const outcome = verifyOffline(c);
  assert.notEqual(outcome.exitCode, 0, "a stale event hash must be refused");
  assert.equal(outcome.code, "ARTIFACT_HASH_MISMATCH", outcome.message);
});

test("D027-C5: a trailing event with a broken prior-event hash is refused", () => {
  const c = copyGolden();
  const events = readLifecycle(c);
  const last = events[events.length - 1] as Event;
  const tail = seal(
    tailEvent(last, {
      state_from: last.state_to,
      state_to: "post_terminal_note",
      prior_event_hash: `sha256:${"1".repeat(64)}`,
      sequence: events.length,
    }),
  );
  writeLifecycle(c, [...events, tail]);
  const outcome = verifyOffline(c);
  assert.notEqual(outcome.exitCode, 0, "a forked chain must be refused");
  assert.equal(outcome.code, "VERIFY_RECORD_LIFECYCLE_GAP", outcome.message);
});

test("D027-C6: a duplicate terminal run-record role is refused", () => {
  const c = copyGolden();
  const events = readLifecycle(c);
  const at = publishingIndexOf(events);
  const runRecordEntry = (events[at] as Event).produced.find((p) => p.artifact_role === "run-record");
  assert.ok(runRecordEntry, "the golden must publish a run record");
  const last = events[events.length - 1] as Event;
  writeLifecycle(
    c,
    rechain([
      ...events,
      tailEvent(last, {
        state_from: last.state_to,
        state_to: "post_terminal_note",
        produced: [runRecordEntry],
      }),
    ]),
  );
  const outcome = verifyOffline(c);
  assert.notEqual(outcome.exitCode, 0, "a second run-record role must be refused");
  assert.equal(outcome.code, "GRAPH_CLOSURE_EXTRA_ARTIFACT", outcome.message);
});

test("D027-C7: a produced entry naming an artifact that does not exist is refused", () => {
  const c = copyGolden();
  const events = readLifecycle(c);
  const last = events[events.length - 1] as Event;
  writeLifecycle(
    c,
    rechain([
      ...events,
      tailEvent(last, {
        state_from: last.state_to,
        state_to: "post_terminal_note",
        produced: [
          {
            artifact_role: "finding",
            artifact_core_hash: `sha256:${"2".repeat(64)}`,
            artifact_schema_version: "vendor-note/v1",
          },
        ],
      }),
    ]),
  );
  const outcome = verifyOffline(c);
  assert.notEqual(outcome.exitCode, 0, "a dangling produced entry must be refused");
  assert.ok(
    ["GRAPH_CLOSURE_LIFECYCLE_TAIL_AFTER_TERMINAL", "GRAPH_CLOSURE_UNREACHABLE_ARTIFACT"].includes(outcome.code),
    `unexpected code ${outcome.code}: ${outcome.message}`,
  );
});

test("D027-C8: a contract-valid artifact of a recognized Lab schema passes admission untouched", () => {
  const c = copyGolden();
  // The upper bracket. A genuine, contract-valid `finding/v1` -- derived from the
  // golden's own finding so it is a real instance rather than a hand-built one --
  // must pass the admission gate and fall through to the ordinary closure rule.
  // If the gate refused this, it would be refusing legitimate Lab artifacts.
  const source = JSON.parse(
    readFileSync(path.join(c.artifacts, "retained", "subject-package-verification-finding.json"), "utf8"),
  ) as Record<string, unknown>;
  const { core_hash: _drop, ...body } = source;
  freezeArtifact(c, path.join("retained", "planted-valid-finding.json"), {
    ...body,
    finding_id: "planted-but-well-formed",
    safe_summary: "a genuine finding contract, retained under a name no event cites",
  });

  const outcome = verifyOffline(c);
  assert.notEqual(outcome.exitCode, 0, "an uncited retained artifact must still be refused");
  assert.equal(
    outcome.code,
    "GRAPH_CLOSURE_EXTRA_ARTIFACT",
    `a valid recognized contract must clear admission and be refused only as an extra: ${outcome.message}`,
  );
});

// -- invalid terminals -------------------------------------------------------

/**
 * The same boundary on the **invalid** branch, where it takes its other form.
 *
 * A valid terminal's publishing event is the last event outright. An invalid
 * terminal's is not: the producer freezes the record and then appends the
 * non-producing transition to `invalidated`. `assertTerminalClosure` therefore
 * permits exactly that one suffix, and the cases below pin both halves — the
 * suffix is accepted (`D027-INV-P1`, so a later simplification cannot tighten
 * "publishing event is last" onto this branch and break every honest invalid
 * run), and nothing else may follow or be injected.
 *
 * These goldens carry no attestation and no public bundle — `deriveInvalidClosure`
 * refuses both outright — so they are driven through `erl2 verify-record`, which
 * is the surface an external reader actually has for an invalid terminal.
 *
 * ## Recorded debt, deliberately not asserted here
 *
 * Three shape mutations past the terminal were measured on this head and are
 * **accepted**: a second `invalidated` transition, an `invalidated` transition
 * whose `state_to` is not `invalidated`, and an invalid terminal with the
 * transition removed altogether. All three produce nothing, so no artifact
 * enters the closure through them and the RL-D-027 invariant — *no artifact may
 * enter the closure past the signed terminal* — is intact; what is unpinned is
 * the shape of the non-producing tail, not the evidence set. They are recorded
 * as RL-D-032 rather than asserted, because asserting today's acceptance would
 * turn a gap into a fixture.
 */

const INVALID_GOLDENS = [
  "invalid-run-cancellation",
  "invalid-run-classified-lab-failure",
  "invalid-run-emergency-cleanup",
] as const;

interface InvalidCopy extends Copy {
  readonly record: string;
}

function copyInvalidGolden(name: string): InvalidCopy {
  const dir = ownedTempDir("erl2-d027-inv-");
  cpSync(path.join(GOLDEN_ROOT, name), dir, { recursive: true });
  const record = path.join(dir, "invalid-record.json");
  return {
    dir,
    record,
    // `verify-record` takes the record, not a bundle; the field is carried only
    // so the shared lifecycle helpers above apply unchanged.
    bundle: record,
    artifacts: path.join(dir, "artifacts"),
    lifecycle: path.join(dir, "lifecycle.json"),
    rootConfig: path.join(dir, "root-config.json"),
  };
}

function verifyRecordOffline(c: InvalidCopy): Outcome {
  const result = erl2([
    "verify-record",
    "--record", c.record,
    "--lifecycle", c.lifecycle,
    "--artifact-root", c.artifacts,
    "--root-config", c.rootConfig,
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

/** The index of the event publishing the terminal **invalid** run record. */
function invalidPublishingIndexOf(events: readonly Event[]): number {
  return events.findIndex((e) => e.produced.some((p) => p.artifact_role === "invalid-run-record"));
}

for (const name of INVALID_GOLDENS) {
  test(`D027-INV-P1: ${name} publishes its record and is followed only by a non-producing invalidated transition`, () => {
    const c = copyInvalidGolden(name);
    const events = readLifecycle(c);
    const at = invalidPublishingIndexOf(events);
    assert.ok(at >= 0, "the golden must publish an invalid run record");

    // The permitted suffix, asserted positively and structurally. If a later
    // change required the publishing event to be last on every branch, this is
    // the test that fails first rather than every honest invalid run silently
    // becoming unverifiable.
    const suffix = events.slice(at + 1);
    assert.equal(suffix.length, 1, "exactly one event may follow the invalid publishing event");
    const transition = suffix[0] as Event;
    assert.equal(transition["event_type"], "invalidated");
    assert.deepEqual(transition.produced, [], "the permitted suffix must produce nothing");
    assert.deepEqual(
      (events[at] as Event).produced.map((p) => p.artifact_role),
      ["invalid-run-record"],
      "the invalid terminal publishes exactly its record",
    );

    const outcome = verifyRecordOffline(c);
    assert.equal(outcome.exitCode, 0, `the permitted suffix must be accepted: ${outcome.code}: ${outcome.message}`);
  });
}

for (const name of INVALID_GOLDENS) {
  test(`D027-INV-A1: an event trailing the invalidated transition in ${name} is refused`, () => {
    const c = copyInvalidGolden(name);
    const events = readLifecycle(c);
    const last = events[events.length - 1] as Event;
    const planted = freezeArtifact(c, path.join("retained", "planted-note.json"), {
      schema_version: "vendor-note/v1",
      note: "appended past the invalid terminal",
    });
    const appended = rechain([
      ...events,
      tailEvent(last, {
        state_from: last.state_to,
        state_to: "post_terminal_note",
        produced: [
          { artifact_role: "finding", artifact_core_hash: planted, artifact_schema_version: "vendor-note/v1" },
        ],
      }),
    ]);
    writeLifecycle(c, appended);
    for (const [i, e] of appended.entries()) {
      const { core_hash: declared, ...body } = e;
      assert.equal(coreHash(body), declared, `appended event ${String(i)} must be self-consistent`);
    }

    const outcome = verifyRecordOffline(c);
    assert.notEqual(outcome.exitCode, 0, `a trailing event must be refused; verdict ${outcome.verdict}`);
    assert.equal(outcome.code, "GRAPH_CLOSURE_LIFECYCLE_TAIL_AFTER_TERMINAL", outcome.message);
  });
}

for (const name of INVALID_GOLDENS) {
  test(`D027-INV-A2: a produced entry injected into ${name}'s publishing event is refused`, () => {
    const c = copyInvalidGolden(name);
    const events = readLifecycle(c);
    const at = invalidPublishingIndexOf(events);
    const planted = freezeArtifact(c, path.join("retained", "planted-note.json"), {
      schema_version: "vendor-note/v1",
      note: "injected into the invalid publishing event itself",
    });
    // Nothing is appended: clause (b) is the only thing that can see this.
    writeLifecycle(
      c,
      rechain(
        events.map((e, i) =>
          i === at
            ? ({
                ...e,
                produced: [
                  ...e.produced,
                  { artifact_role: "finding", artifact_core_hash: planted, artifact_schema_version: "vendor-note/v1" },
                ],
              } as Event)
            : e,
        ),
      ),
    );

    const outcome = verifyRecordOffline(c);
    assert.notEqual(outcome.exitCode, 0, `an injected product must be refused; verdict ${outcome.verdict}`);
    assert.equal(outcome.code, "GRAPH_CLOSURE_TERMINAL_EVENT_EXTRA_PRODUCT", outcome.message);
  });
}

for (const name of INVALID_GOLDENS) {
  test(`D027-INV-A3: ${name}'s invalidated transition carrying a produced artifact is refused`, () => {
    const c = copyInvalidGolden(name);
    const events = readLifecycle(c);
    const at = events.length - 1;
    assert.equal((events[at] as Event)["event_type"], "invalidated");
    const planted = freezeArtifact(c, path.join("retained", "planted-note.json"), {
      schema_version: "vendor-note/v1",
      note: "smuggled in on the one event permitted to follow",
    });
    writeLifecycle(
      c,
      rechain(
        events.map((e, i) =>
          i === at
            ? ({
                ...e,
                produced: [
                  { artifact_role: "finding", artifact_core_hash: planted, artifact_schema_version: "vendor-note/v1" },
                ],
              } as Event)
            : e,
        ),
      ),
    );

    const outcome = verifyRecordOffline(c);
    assert.notEqual(outcome.exitCode, 0, `a producing suffix must be refused; verdict ${outcome.verdict}`);
    // The permitted-tail clause is `permitted type AND produces nothing`, so the
    // structural code is the tail boundary: the event is admissible by type and
    // is refused precisely because it carries a product.
    assert.equal(outcome.code, "GRAPH_CLOSURE_LIFECYCLE_TAIL_AFTER_TERMINAL", outcome.message);
  });
}

test("D027-INV-C1: an invalidated transition with the wrong predecessor state is refused", () => {
  const c = copyInvalidGolden("invalid-run-cancellation");
  const events = readLifecycle(c);
  const at = events.length - 1;
  writeLifecycle(
    c,
    rechain(events.map((e, i) => (i === at ? ({ ...e, state_from: "invalid_failure_detected" } as Event) : e))),
  );
  const outcome = verifyRecordOffline(c);
  assert.notEqual(outcome.exitCode, 0, "a discontinuous transition must be refused");
  assert.equal(outcome.code, "VERIFY_RECORD_LIFECYCLE_GAP", outcome.message);
});

test("D027-INV-C2: an invalidated transition with a broken prior-event hash is refused", () => {
  const c = copyInvalidGolden("invalid-run-cancellation");
  const events = readLifecycle(c);
  const at = events.length - 1;
  // Left un-rechained on purpose: the earlier structural control must answer,
  // not the terminal clause.
  writeLifecycle(
    c,
    events.map((e, i) => (i === at ? ({ ...e, prior_event_hash: `sha256:${"0".repeat(64)}` } as Event) : e)),
  );
  const outcome = verifyRecordOffline(c);
  assert.notEqual(outcome.exitCode, 0, "a forked chain must be refused");
  assert.equal(outcome.code, "VERIFY_RECORD_LIFECYCLE_GAP", outcome.message);
});

test("D027-INV-C3: an invalidated transition with a stale core hash is refused", () => {
  const c = copyInvalidGolden("invalid-run-cancellation");
  const events = readLifecycle(c);
  const at = events.length - 1;
  writeLifecycle(
    c,
    events.map((e, i) => (i === at ? ({ ...e, occurred_at: "2026-07-01T00:00:59Z" } as Event) : e)),
  );
  const outcome = verifyRecordOffline(c);
  assert.notEqual(outcome.exitCode, 0, "a mutated event must be refused");
  assert.equal(outcome.code, "ARTIFACT_HASH_MISMATCH", outcome.message);
});

// -- environment terminals ---------------------------------------------------

/**
 * The same boundary on the **environment** branch.
 *
 * `deriveEnvironmentClosure` took the same `assertTerminalClosure` call and the
 * same `admit` gate, and the repository ships **no committed environment
 * bundle**: `fixtures/golden/environment-run/` holds a `closure-summary.json`
 * only, because an environment run's bytes cannot be pinned (every
 * eligibility-pool entry is a threshold envelope drawn from the CSPRNG). Leaving
 * the branch untested was not acceptable and committing a new evidence bundle
 * for it was out of scope, so the terminal is **built at test runtime** by
 * `runToEnvironmentTerminal()` — the repository's own CLI driver, development
 * keyring and governor registry, no Docker and no external harness — and driven
 * through the real `erl2 verify` surface. Nothing generated here is committed.
 *
 * One terminal is built and copied per case: the build is ~20s and the property
 * under test is about the lifecycle tail, which each copy mutates independently.
 */

const ENVIRONMENT_TERMINAL_ROLES = ["final-attestation", "run-record", "signer-inventory"] as const;

let environmentTerminal: { runRoot: string } | undefined;

/** The one environment terminal every case below copies, built on first use. */
function environmentTerminalRoot(): string {
  if (environmentTerminal === undefined) {
    const run = runToEnvironmentTerminal();
    writeDerivedLifecycle(run.runRoot);
    writeTrustConfig(run.runRoot, "trust-config.json", {
      sourceTrustPolicyHash: run.registry.sourceTrustPolicyHash,
    });
    environmentTerminal = { runRoot: run.runRoot };
  }
  return environmentTerminal.runRoot;
}

function copyEnvironmentTerminal(): Copy {
  const dir = ownedTempDir("erl2-d027-env-");
  cpSync(environmentTerminalRoot(), dir, { recursive: true });
  return {
    dir,
    bundle: path.join(dir, "retained", "public-bundle.json"),
    artifacts: dir,
    lifecycle: path.join(dir, "lifecycle.json"),
    rootConfig: path.join(dir, "trust-config.json"),
  };
}

test("D027-ENV-BASELINE: a runtime-built environment terminal verifies offline", () => {
  const c = copyEnvironmentTerminal();
  const events = readLifecycle(c);
  const at = publishingIndexOf(events);
  assert.equal(at, events.length - 1, "a valid environment terminal's publishing event is last outright");
  assert.deepEqual(
    [...(events[at] as Event).produced.map((p) => p.artifact_role)].sort(),
    [...ENVIRONMENT_TERMINAL_ROLES],
    "the environment terminal publishes exactly its three roles",
  );

  const outcome = verifyOffline(c);
  assert.equal(outcome.exitCode, 0, `${outcome.code}: ${outcome.message}`);
  assert.equal(outcome.verdict, "valid");
});

test("D027-ENV-A1: an event trailing the environment terminal is refused", () => {
  const c = copyEnvironmentTerminal();
  const events = readLifecycle(c);
  const last = events[events.length - 1] as Event;
  const planted = freezeArtifact(c, path.join("retained", "planted-note.json"), {
    schema_version: "vendor-note/v1",
    note: "appended past the environment terminal",
  });
  writeLifecycle(
    c,
    rechain([
      ...events,
      tailEvent(last, {
        state_from: last.state_to,
        state_to: "post_terminal_note",
        produced: [
          { artifact_role: "finding", artifact_core_hash: planted, artifact_schema_version: "vendor-note/v1" },
        ],
      }),
    ]),
  );

  const outcome = verifyOffline(c);
  assert.notEqual(outcome.exitCode, 0, `a trailing event must be refused; verdict ${outcome.verdict}`);
  assert.equal(outcome.code, "GRAPH_CLOSURE_LIFECYCLE_TAIL_AFTER_TERMINAL", outcome.message);
});

test("D027-ENV-A2: a produced entry injected into the environment publishing event is refused", () => {
  const c = copyEnvironmentTerminal();
  const events = readLifecycle(c);
  const at = publishingIndexOf(events);
  const planted = freezeArtifact(c, path.join("retained", "planted-note.json"), {
    schema_version: "vendor-note/v1",
    note: "injected into the environment publishing event itself",
  });
  writeLifecycle(
    c,
    rechain(
      events.map((e, i) =>
        i === at
          ? ({
              ...e,
              produced: [
                ...e.produced,
                { artifact_role: "finding", artifact_core_hash: planted, artifact_schema_version: "vendor-note/v1" },
              ],
            } as Event)
          : e,
      ),
    ),
  );

  const outcome = verifyOffline(c);
  assert.notEqual(outcome.exitCode, 0, `an injected product must be refused; verdict ${outcome.verdict}`);
  assert.equal(outcome.code, "GRAPH_CLOSURE_TERMINAL_EVENT_EXTRA_PRODUCT", outcome.message);
});

test("D027-ENV-A3: an environment terminal missing one of its published roles is refused", () => {
  const c = copyEnvironmentTerminal();
  const events = readLifecycle(c);
  const at = publishingIndexOf(events);
  // The multiset comparison is exact in both directions: a terminal that
  // publishes *less* than its variant publishes is as refusable as one that
  // publishes more.
  writeLifecycle(
    c,
    rechain(
      events.map((e, i) =>
        i === at ? ({ ...e, produced: e.produced.slice(0, e.produced.length - 1) } as Event) : e,
      ),
    ),
  );

  const outcome = verifyOffline(c);
  assert.notEqual(outcome.exitCode, 0, `a missing terminal role must be refused; verdict ${outcome.verdict}`);
  assert.equal(outcome.code, "GRAPH_CLOSURE_TERMINAL_EVENT_EXTRA_PRODUCT", outcome.message);
});

test("D027-ENV-A4: a duplicated environment terminal product is refused", () => {
  const c = copyEnvironmentTerminal();
  const events = readLifecycle(c);
  const at = publishingIndexOf(events);
  writeLifecycle(
    c,
    rechain(
      events.map((e, i) =>
        i === at ? ({ ...e, produced: [...e.produced, e.produced[0]] } as Event) : e,
      ),
    ),
  );

  const outcome = verifyOffline(c);
  assert.notEqual(outcome.exitCode, 0, `a duplicated terminal role must be refused; verdict ${outcome.verdict}`);
  // Answered by the closure's role-multiplicity control, which runs ahead of the
  // terminal clause. Pinned as measured rather than assumed: a duplicate is
  // refused, and this records *which* control refuses it.
  assert.equal(outcome.code, "GRAPH_CLOSURE_EXTRA_ARTIFACT", outcome.message);
});

test("D027-ENV-A5: admitting a contract-invalid known-schema artifact from an environment run is refused", () => {
  const c = copyEnvironmentTerminal();
  // The admission gate at its own boundary on this branch. `deriveEnvironmentClosure`
  // calls `index.admit` in six places, and this is the question those calls ask.
  const planted = freezeArtifact(c, path.join("retained", "planted-finding.json"), {
    schema_version: "finding/v1",
    kind: "subject_finding",
    safe_summary: "declares a Lab contract and satisfies none of it",
  });
  const index = ArtifactIndex.scan(c.artifacts);
  assert.equal(index.get(planted as `sha256:${string}`).coreHash, planted, "resolving is not admitting");
  assert.throws(
    () => index.admit(planted as `sha256:${string}`),
    (error: unknown) => (error as { code?: string }).code === "GRAPH_CLOSURE_RETAINED_CONTRACT_INVALID",
    "a contract-invalid known-schema artifact must not be admitted",
  );
});

test("D027-ENV-C1: the environment terminal's own published contracts clear admission", () => {
  const c = copyEnvironmentTerminal();
  const events = readLifecycle(c);
  const at = publishingIndexOf(events);
  const index = ArtifactIndex.scan(c.artifacts);
  // The upper bracket on this branch: every artifact the terminal actually
  // publishes must pass the gate. If admission refused any of these, it would be
  // refusing legitimate environment evidence.
  for (const entry of (events[at] as Event).produced) {
    assert.equal(
      index.admit(entry.artifact_core_hash as `sha256:${string}`).coreHash,
      entry.artifact_core_hash,
      `${entry.artifact_role} must clear admission`,
    );
  }
});

test("D027-ENV-C2: an unknown-schema artifact in an environment run stays opaque", () => {
  const c = copyEnvironmentTerminal();
  // A schema the registry does not define is product output, not a Lab artifact.
  // It must be refused as an unaccounted extra -- the ordinary closure rule --
  // and never parsed or refused as a contract violation.
  const planted = freezeArtifact(c, path.join("retained", "opaque-note.json"), {
    schema_version: "vendor-note/v1",
    note: "opaque product bytes, not a Lab contract",
  });
  const index = ArtifactIndex.scan(c.artifacts);
  assert.equal(
    index.admit(planted as `sha256:${string}`).coreHash,
    planted,
    "an unknown schema must clear admission untouched",
  );

  const outcome = verifyOffline(c);
  assert.notEqual(outcome.exitCode, 0, "an uncited retained artifact must still be refused");
  assert.equal(
    outcome.code,
    "GRAPH_CLOSURE_EXTRA_ARTIFACT",
    `an unknown schema must be refused only as an extra: ${outcome.message}`,
  );
});
