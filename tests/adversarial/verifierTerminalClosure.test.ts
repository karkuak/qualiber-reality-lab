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
import { erl2 } from "../support/cliRun.js";
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
