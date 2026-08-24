/**
 * CONTRACT: the committed neutral trusted-local worked example stays true to
 * itself, to the adapter it reuses, and to the claim ceiling it inherits.
 *
 * ## Why this exists
 *
 * `examples/trusted-local-neutral/` exists so an outsider can execute the
 * supported trusted-local path from committed materials alone. That promise
 * decays silently in four distinct ways, and each one is asserted here:
 *
 *   - **The navigation rots.** A README link, a backlink, or the example's own
 *     pointer at the operator surface goes stale and the example stops being
 *     reachable from the front door — the exact defect
 *     `trustedLocalDocumentationTruth.test.ts` was written for one layer up.
 *   - **The claim ceiling erodes.** The example's README stops stating a
 *     disclaimer in its own words and merely links `permitted-claims.md`. A
 *     link is not a statement: a reader who never follows it has been told
 *     nothing, so the four central disclaimers are asserted as present text.
 *   - **The example stops matching the adapter.** The reused fixture's handler
 *     keys are what `@erl2/adapter-sdk` negotiates, and `AdapterHost` compares
 *     that list against the manifest's **positionally**. A handler added,
 *     removed or reordered in `fixtures/neutral/neutral-full-lifecycle-observer.mjs`
 *     silently invalidates the committed manifest draft. This test derives the
 *     expected order from the fixture's own source rather than restating it.
 *   - **Generated material leaks in.** The example's whole design is that the
 *     sealed manifest, sealed plan, declaration and observation record are
 *     produced fresh on every run and never committed. A committed one would be
 *     a second golden-evidence system that can rot without anything noticing.
 *
 * Like its M1 predecessor this is a documentation-*truth* contract, not a
 * prose-pinning test: it asserts load-bearing properties an external reader
 * depends on, not exact wording. The end-to-end behaviour of the example is
 * proved by running it — locally and in the `pr` workflow — not here.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const EXAMPLE_DIR = path.join(repoRoot, "examples", "trusted-local-neutral");
const EXAMPLE_README = path.join(EXAMPLE_DIR, "README.md");
const README_PATH = path.join(repoRoot, "README.md");
const OPERATOR_SURFACE_PATH = path.join(
  repoRoot,
  "docs",
  "decisions",
  "trusted-local-observation-operator-surface.md",
);
const NEUTRAL_FIXTURE = path.join(
  repoRoot,
  "fixtures",
  "neutral",
  "neutral-full-lifecycle-observer.mjs",
);

/** The example's committed file set, exactly as the design fixes it. */
const COMMITTED_FILES = [
  "README.md",
  "manifest.draft.json",
  "build-manifest.mjs",
  "plan.draft.json",
  "hash-input.mjs",
  path.join("input", "package.bin"),
  "run-example.sh",
  "verify-example.mjs",
  "cleanup-example.sh",
] as const;

/**
 * Names a run produces and must never commit.
 *
 * The declaration and the observation record additionally embed
 * `SystemClock().now()`, so neither is byte-reproducible run to run and
 * committing either would be wrong rather than merely redundant.
 */
const GENERATED_NAMES = [
  "manifest.json",
  "plan.sealed.json",
  "declaration.json",
  "trusted-local-observation-record.json",
  "observation-plan.json",
] as const;

function read(absolute: string): string {
  return readFileSync(absolute, "utf8");
}

/** Every `[text](target)` markdown link in a document, in order. */
function markdownLinkTargets(markdown: string): string[] {
  const targets: string[] = [];
  const re = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gu;
  let match: RegExpExecArray | null;
  while ((match = re.exec(markdown)) !== null) {
    targets.push(match[1] as string);
  }
  return targets;
}

/** Every file beneath `dir`, repository-relative, depth-first. */
function walk(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(absolute));
    else found.push(path.relative(repoRoot, absolute));
  }
  return found.sort();
}

/**
 * The operation order the SDK actually negotiates for the reused fixture.
 *
 * Derived from `handlers`' own key order in the fixture source — which is what
 * `Object.keys(definition.handlers)` yields at negotiation time — and
 * deliberately **not** from `declaredEntrypoints`, whose order differs. A test
 * that restated the list would pass while the fixture drifted; a test that read
 * the wrong field would encode the very trap the example documents.
 */
function fixtureHandlerOrder(): string[] {
  const source = read(NEUTRAL_FIXTURE);
  const start = source.indexOf("handlers: {");
  assert.ok(start >= 0, "the neutral fixture must declare a handlers object");
  let depth = 0;
  let end = -1;
  for (let i = source.indexOf("{", start); i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  assert.ok(end > start, "the neutral fixture's handlers object must be balanced");
  const body = source.slice(source.indexOf("{", start) + 1, end);
  const keys: string[] = [];
  let depthInBody = 0;
  for (const line of body.split("\n")) {
    // Only keys at the object's own top level are handler names; a key nested
    // inside a handler body is not one.
    const key = /^\s*(?:"([a-z-]+)"|([a-z-]+))\s*:/u.exec(line);
    if (depthInBody === 0 && key) keys.push((key[1] ?? key[2]) as string);
    for (const ch of line) {
      if (ch === "{" || ch === "[") depthInBody += 1;
      else if (ch === "}" || ch === "]") depthInBody -= 1;
    }
  }
  return keys;
}

// -- the example exists, with exactly the committed files it documents --------

test("the neutral trusted-local example directory is tracked", () => {
  assert.ok(existsSync(EXAMPLE_DIR), "examples/trusted-local-neutral/ must exist");
});

test("every committed file the example's design names is present", () => {
  for (const relative of COMMITTED_FILES) {
    const absolute = path.join(EXAMPLE_DIR, relative);
    assert.ok(existsSync(absolute), `examples/trusted-local-neutral/${relative} must exist`);
    assert.ok(
      statSync(absolute).isFile(),
      `examples/trusted-local-neutral/${relative} must be a regular file`,
    );
  }
});

test("the example commits nothing a run generates", () => {
  const tracked = walk(EXAMPLE_DIR);
  for (const relative of tracked) {
    const base = path.basename(relative);
    assert.ok(
      !(GENERATED_NAMES as readonly string[]).includes(base),
      `${relative} is produced by running the example and must not be committed`,
    );
  }
  const expected = COMMITTED_FILES.map((relative) =>
    path.join("examples", "trusted-local-neutral", relative),
  ).sort();
  assert.deepEqual(
    tracked,
    expected,
    "examples/trusted-local-neutral/ must contain exactly its committed file set",
  );
});

// -- navigation: root README -> example -> operator surface -> example ---------

test("the root README links to the example README", () => {
  assert.match(
    read(README_PATH),
    /examples\/trusted-local-neutral\/README\.md/u,
    "the root README must link to the neutral worked example",
  );
});

test("the example README links to the trusted-local operator surface", () => {
  assert.match(
    read(EXAMPLE_README),
    /trusted-local-observation-operator-surface\.md/u,
    "the example README must link to the operator-surface document",
  );
});

test("the operator-surface document links to the example", () => {
  assert.match(
    read(OPERATOR_SURFACE_PATH),
    /examples\/trusted-local-neutral/u,
    "the operator-surface document must link to the worked example",
  );
});

test("every relative link in the example README resolves to a tracked in-repo file", () => {
  const dir = path.dirname(EXAMPLE_README);
  for (const target of markdownLinkTargets(read(EXAMPLE_README))) {
    if (/^[a-z]+:\/\//iu.test(target)) continue; // external URL
    if (target.startsWith("#")) continue; // in-page anchor
    const withoutAnchor = target.split("#")[0] as string;
    if (withoutAnchor === "") continue;
    assert.ok(
      !path.isAbsolute(withoutAnchor),
      `example README: link "${target}" must be relative, not absolute`,
    );
    const resolved = path.resolve(dir, withoutAnchor);
    assert.ok(
      resolved.startsWith(repoRoot + path.sep),
      `example README: link "${target}" must resolve inside the repository`,
    );
    assert.ok(
      existsSync(resolved),
      `example README: link "${target}" must resolve to a tracked file (missing: ${resolved})`,
    );
  }
});

// -- product neutrality --------------------------------------------------------

test("no file in the example names a product", () => {
  for (const relative of walk(EXAMPLE_DIR)) {
    const absolute = path.join(repoRoot, relative);
    // Read as latin1 so the committed binary input is scanned as bytes too; a
    // product name hidden in a payload is still a product name in the tree.
    const contents = readFileSync(absolute, "latin1");
    assert.doesNotMatch(contents, /qualiber/iu, `${relative} must not mention Qualiber`);
    assert.doesNotMatch(contents, /qualgraph/iu, `${relative} must not mention QualGraph`);
  }
});

// -- the claim ceiling is stated, not merely linked -----------------------------

test("the example README states all four central disclaimers in its own words", () => {
  const readme = read(EXAMPLE_README);
  const required: readonly (readonly [string, RegExp])[] = [
    ["not certification", /\bnot\b[^.\n]{0,80}\bcertification\b/iu],
    ["not independent assurance", /\bnot\b[^.\n]{0,80}\bindependent assurance\b/iu],
    ["not confinement", /\bnot\b[^.\n]{0,80}\bconfine(?:ment|d)\b/iu],
    [
      "not a subject-quality verdict",
      /\bnot\b[^.\n]{0,120}\b(?:subject(?:'s)? quality|quality of your subject|verdict on)\b/iu,
    ],
  ];
  for (const [label, pattern] of required) {
    assert.match(readme, pattern, `the example README must state "${label}" in its own text`);
  }
});

test("the example README states the remaining claim boundaries it inherits", () => {
  const readme = read(EXAMPLE_README);
  for (const [label, pattern] of [
    ["production key custody", /production[- ]key custody|production signing (?:key|authority)/iu],
    ["governed admission", /governed admission|governor authoriz/iu],
    ["opaque third-party readiness", /opaque|hostile|third[- ]part(?:y|ies)/iu],
    ["broad scalability", /scalab|scale/iu],
  ] as const) {
    assert.match(readme, pattern, `the example README must disclaim ${label}`);
  }
});

// -- the example's scripts point at real committed files ------------------------

test("every repository path the example's scripts name exists", () => {
  const scripts = ["run-example.sh", "build-manifest.mjs", "hash-input.mjs", "verify-example.mjs"];
  const re = /(?:examples\/trusted-local-neutral|fixtures\/neutral|packages\/cli\/dist)[A-Za-z0-9._/-]*/gu;
  for (const script of scripts) {
    const contents = read(path.join(EXAMPLE_DIR, script));
    for (const named of contents.match(re) ?? []) {
      // `packages/cli/dist` is a build product; its presence is the build's
      // job, so only its source-tree siblings are asserted here.
      if (named.startsWith("packages/cli/dist")) continue;
      assert.ok(
        existsSync(path.join(repoRoot, named)),
        `${script} names ${named}, which must exist in the repository`,
      );
    }
  }
});

test("the example reuses the committed neutral fixture and adds no second adapter", () => {
  assert.ok(existsSync(NEUTRAL_FIXTURE), "the reused neutral fixture must exist");
  assert.match(
    read(path.join(EXAMPLE_DIR, "run-example.sh")),
    /fixtures\/neutral\/neutral-full-lifecycle-observer\.mjs/u,
    "run-example.sh must reuse the committed neutral fixture",
  );
  for (const relative of walk(EXAMPLE_DIR)) {
    assert.ok(
      !/from\s+"@erl2\/adapter-sdk"/u.test(readFileSync(path.join(repoRoot, relative), "latin1")),
      `${relative} must not import the adapter SDK; the example reuses the neutral fixture ` +
        "rather than defining a second adapter",
    );
  }
});

// -- the operation inventory matches the adapter the example reuses -------------

test("the manifest draft's operations are the fixture's handler keys, in negotiation order", () => {
  const draft = JSON.parse(read(path.join(EXAMPLE_DIR, "manifest.draft.json"))) as {
    protocol_support: readonly { protocol_version: string; operations: readonly string[] }[];
  };
  const v2 = draft.protocol_support.find(
    (profile) => profile.protocol_version === "subject-adapter/v2",
  );
  assert.ok(v2 !== undefined, "the manifest draft must declare a subject-adapter/v2 profile");
  assert.deepEqual(
    [...v2.operations],
    fixtureHandlerOrder(),
    "the manifest draft's operations must equal the fixture's handler keys, in the same order",
  );
});

test("the plan draft's operations are a manifest-ordered subsequence of the manifest's", () => {
  const manifest = JSON.parse(read(path.join(EXAMPLE_DIR, "manifest.draft.json"))) as {
    protocol_support: readonly { protocol_version: string; operations: readonly string[] }[];
  };
  const plan = JSON.parse(read(path.join(EXAMPLE_DIR, "plan.draft.json"))) as {
    operations: readonly { sequence: number; operation: string }[];
  };
  const declared = (
    manifest.protocol_support.find((p) => p.protocol_version === "subject-adapter/v2") as {
      operations: readonly string[];
    }
  ).operations;
  let cursor = -1;
  plan.operations.forEach((spec, index) => {
    assert.equal(spec.sequence, index, "plan operation sequences must be dense and ascending");
    const at = declared.indexOf(spec.operation);
    assert.ok(at >= 0, `plan operation ${spec.operation} is outside the manifest's profile`);
    assert.ok(
      at > cursor,
      `plan operation ${spec.operation} breaks the manifest's declared operation order`,
    );
    cursor = at;
  });
});

test("the plan draft carries no hash the sealing seam computes", () => {
  const plan = JSON.parse(read(path.join(EXAMPLE_DIR, "plan.draft.json"))) as Record<
    string,
    unknown
  >;
  for (const computed of ["core_hash", "trusted_local_declaration_hash"]) {
    assert.ok(
      !Object.hasOwn(plan, computed),
      `the plan draft must not carry ${computed}; --seal-plan-draft computes it`,
    );
  }
  for (const nested of ["resource_limits", "egress_policy"]) {
    assert.ok(
      !Object.hasOwn(plan[nested] as Record<string, unknown>, "core_hash"),
      `the plan draft must not carry ${nested}.core_hash; --seal-plan-draft computes it`,
    );
  }
});

test("the manifest draft carries neither field build-manifest.mjs seals", () => {
  const manifest = JSON.parse(read(path.join(EXAMPLE_DIR, "manifest.draft.json"))) as Record<
    string,
    unknown
  >;
  for (const sealed of ["core_hash", "signature"]) {
    assert.ok(
      !Object.hasOwn(manifest, sealed),
      `the manifest draft must not carry ${sealed}; build-manifest.mjs seals it`,
    );
  }
});

test("the plan draft's declared input is the committed example input", () => {
  const plan = JSON.parse(read(path.join(EXAMPLE_DIR, "plan.draft.json"))) as {
    resource_limits: { input_root: string };
    inputs: readonly {
      input_id: string;
      provenance_mode: string;
      artifact: { path: string; byte_length: number; file_sha256: string };
    }[];
  };
  assert.equal(plan.inputs.length, 1, "the example plan declares exactly one input");
  const input = plan.inputs[0] as (typeof plan.inputs)[number];
  assert.equal(input.provenance_mode, "host_provisioned");
  assert.ok(
    input.artifact.path.startsWith(`${plan.resource_limits.input_root}/`),
    "the input's logical path must sit beneath the plan's own input root",
  );
  const bytes = readFileSync(path.join(EXAMPLE_DIR, "input", "package.bin"));
  assert.equal(
    input.artifact.byte_length,
    bytes.byteLength,
    "the plan's declared byte length must match the committed input bytes",
  );
  assert.equal(
    input.artifact.file_sha256,
    `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    "the plan's declared digest must match the committed input bytes",
  );
});

// -- the README's command sequence is the executable script's ---------------------

test("the README's command sequence matches run-example.sh", () => {
  const readme = read(EXAMPLE_README);
  const script = read(path.join(EXAMPLE_DIR, "run-example.sh"));
  // The four steps the script performs, in order, each identified by the exact
  // token a reader would copy. A README that renamed, reordered or dropped one
  // would no longer describe the thing CI runs.
  const steps = [
    "build-manifest.mjs",
    "declare-trusted-local-adapter",
    "run-trusted-local-observation",
    "verify-example.mjs",
  ];
  const positionsIn = (text: string): number[] => steps.map((step) => text.indexOf(step));
  const readmeAt = positionsIn(readme);
  const scriptAt = positionsIn(script);
  steps.forEach((step, index) => {
    assert.ok((readmeAt[index] as number) >= 0, `the README must name ${step}`);
    assert.ok((scriptAt[index] as number) >= 0, `run-example.sh must invoke ${step}`);
  });
  for (let i = 1; i < steps.length; i += 1) {
    assert.ok(
      (readmeAt[i] as number) > (readmeAt[i - 1] as number),
      `the README must present ${steps[i] as string} after ${steps[i - 1] as string}`,
    );
    assert.ok(
      (scriptAt[i] as number) > (scriptAt[i - 1] as number),
      `run-example.sh must invoke ${steps[i] as string} after ${steps[i - 1] as string}`,
    );
  }
  assert.match(
    readme,
    /node packages\/cli\/dist\/src\/bin\.js/u,
    "the README must invoke the CLI exactly as the script does",
  );
  assert.doesNotMatch(
    readme,
    /^\s*\$?\s*erl2\s/mu,
    "the README must not tell a reader to run a bare `erl2` binary; the Quick Start puts none on PATH",
  );
});

test("the README names the two authoring traps the example exists to prevent", () => {
  const readme = read(EXAMPLE_README);
  assert.match(
    readme,
    /supportedProtocolVersions/u,
    "the README must state the positive supportedProtocolVersions authoring requirement",
  );
  assert.match(
    readme,
    /subject-adapter\/v2/u,
    "the README must name the v2 protocol version an adapter must declare",
  );
  assert.match(
    readme,
    /handler/iu,
    "the README must state that operation order follows the adapter's handler order",
  );
});

test("run-example.sh is bounded, scratch-rooted and self-describing about cleanup", () => {
  const script = read(path.join(EXAMPLE_DIR, "run-example.sh"));
  assert.match(script, /set -euo pipefail/u, "run-example.sh must fail closed");
  assert.match(script, /mktemp -d/u, "run-example.sh must create a fresh scratch root");
  assert.match(
    script,
    /cleanup-example\.sh/u,
    "run-example.sh must point the operator at the cleanup script",
  );
});

test("cleanup-example.sh refuses unsafe targets by name", () => {
  const script = read(path.join(EXAMPLE_DIR, "cleanup-example.sh"));
  assert.match(script, /set -euo pipefail/u, "cleanup-example.sh must fail closed");
  for (const guard of [/-L /u, /-d /u, /\/private\/tmp/u]) {
    assert.match(script, guard, "cleanup-example.sh must validate its target before removing it");
  }
});
