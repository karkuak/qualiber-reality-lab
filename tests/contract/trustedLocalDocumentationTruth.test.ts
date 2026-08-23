/**
 * CONTRACT: the README front door tells an external reader the truth about
 * which operator journey actually works.
 *
 * ## Why this exists
 *
 * The base README routed every external reader's first command at the
 * governed journey (`preregister-acquisition` / `acquire` / `admit-adapter`),
 * which needs eight governor-prepared hashes with no public producer — it
 * cannot be completed from a clean clone. The same README asserted that
 * `fixtures/golden` contains a worked governed example, which is false: no
 * `registry*` directory exists there. Meanwhile the one journey that *is*
 * externally operable — trusted-local observation, documented in full at
 * `docs/decisions/trusted-local-observation-operator-surface.md` — was never
 * linked from the README at all.
 *
 * This is a documentation-truth contract, not a prose-pinning test: it does
 * not assert exact wording, only the load-bearing properties an external
 * reader depends on — that the working path is discoverable, that the
 * inoperable path is honestly labelled, that the false claim is gone, and
 * that every relative documentation link this repository ships actually
 * resolves to a tracked file.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const README_PATH = path.join(repoRoot, "README.md");
const OPERATOR_SURFACE_PATH = path.join(
  repoRoot,
  "docs",
  "decisions",
  "trusted-local-observation-operator-surface.md",
);
const TROUBLESHOOTING_PATH = path.join(
  repoRoot,
  "docs",
  "decisions",
  "trusted-local-observation-troubleshooting.md",
);

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

/** The body of the first `##`-level section whose heading matches `pattern`. */
function sectionBody(markdown: string, pattern: RegExp): string | undefined {
  const lines = markdown.split("\n");
  const headingIndex = lines.findIndex((line) => /^##\s+/u.test(line) && pattern.test(line));
  if (headingIndex < 0) return undefined;
  const rest = lines.slice(headingIndex + 1);
  const nextHeading = rest.findIndex((line) => /^##\s+/u.test(line));
  return (nextHeading < 0 ? rest : rest.slice(0, nextHeading)).join("\n");
}

// -- the two tracked documents this pass adds must exist -----------------------

test("the trusted-local operator-surface document is tracked", () => {
  assert.ok(existsSync(OPERATOR_SURFACE_PATH), "docs/decisions/trusted-local-observation-operator-surface.md must exist");
});

test("the trusted-local troubleshooting/refusal reference is tracked", () => {
  assert.ok(existsSync(TROUBLESHOOTING_PATH), "docs/decisions/trusted-local-observation-troubleshooting.md must exist");
});

// -- README: the trusted-local entrypoint --------------------------------------

test("README links to the trusted-local operator-surface document", () => {
  const readme = read(README_PATH);
  assert.match(
    readme,
    /docs\/decisions\/trusted-local-observation-operator-surface\.md/u,
    "README must link to the trusted-local operator-surface document",
  );
});

test("README links to the trusted-local troubleshooting reference", () => {
  const readme = read(README_PATH);
  assert.match(
    readme,
    /docs\/decisions\/trusted-local-observation-troubleshooting\.md/u,
    "README must link to the trusted-local troubleshooting/refusal reference",
  );
});

test("README names trusted-local observation as the supported external development-tier path", () => {
  const readme = read(README_PATH);
  assert.match(
    readme,
    /trusted-local observation/iu,
    "README must name trusted-local observation somewhere",
  );
  assert.match(
    readme,
    /supported external[^.]{0,60}development-tier/iu,
    "README must state that trusted-local observation is the supported external development-tier path",
  );
});

// -- README: the false worked-example claim is gone ----------------------------

test("README no longer claims fixtures/golden contains a worked governed example", () => {
  const readme = read(README_PATH);
  assert.doesNotMatch(
    readme,
    /fixtures\/golden.{0,40}contains a worked example/isu,
    "the false fixtures/golden worked-example claim must be removed",
  );
});

// -- README: the governed journey is honestly labelled internal-only -----------

test("README does not present the governed journey under an external Quick Start", () => {
  const readme = read(README_PATH);
  const quickStart = sectionBody(readme, /Quick start/iu);
  assert.ok(quickStart !== undefined, "README must still have a Quick start section");
  for (const governedMarker of ["preregister-acquisition", "admit-adapter", "registry-governor"]) {
    assert.ok(
      !(quickStart as string).includes(governedMarker),
      `Quick start must not present the governed command "${governedMarker}"`,
    );
  }
});

test("README labels the governed journey as internal / repository-owner-only", () => {
  const readme = read(README_PATH);
  assert.match(
    readme,
    /repository-owner[- ]only|internal[- ]only/iu,
    "README must label the governed journey as internal / repository-owner-only",
  );
});

test("README does not claim an external governor-registry provisioning command exists", () => {
  const readme = read(README_PATH);
  assert.match(
    readme,
    /not externally provisionable/iu,
    "README must state the governor registry is not externally provisionable from the committed public operator surface",
  );
  assert.doesNotMatch(
    readme,
    /governor[- ]registry[^.\n]{0,120}(npm run|node packages\/cli)/isu,
    "README must not pair the governor registry with a runnable provisioning command",
  );
});

// -- product neutrality ----------------------------------------------------------

test("the trusted-local documentation set carries no product-specific dependency", () => {
  for (const doc of [OPERATOR_SURFACE_PATH, TROUBLESHOOTING_PATH]) {
    if (!existsSync(doc)) continue;
    assert.doesNotMatch(read(doc), /Qualiber/u, `${path.relative(repoRoot, doc)} must not mention Qualiber`);
  }
  const readmeTrustedLocalSection = sectionBody(read(README_PATH), /trusted-local/iu);
  if (readmeTrustedLocalSection !== undefined) {
    assert.doesNotMatch(
      readmeTrustedLocalSection,
      /Qualiber/u,
      "README's trusted-local section must not mention Qualiber",
    );
  }
});

// -- link integrity: every relative documentation link this pass touches resolves --

test("every relative link in README, the operator-surface doc and the troubleshooting doc resolves to a tracked, in-repo file", () => {
  const documents = [README_PATH, OPERATOR_SURFACE_PATH, TROUBLESHOOTING_PATH].filter(existsSync);
  for (const doc of documents) {
    const dir = path.dirname(doc);
    const targets = markdownLinkTargets(read(doc));
    for (const target of targets) {
      if (/^[a-z]+:\/\//iu.test(target)) continue; // external URL
      if (target.startsWith("#")) continue; // in-page anchor
      const withoutAnchor = target.split("#")[0] as string;
      if (withoutAnchor === "") continue;
      assert.ok(
        !path.isAbsolute(withoutAnchor),
        `${path.relative(repoRoot, doc)}: link "${target}" must be relative, not absolute`,
      );
      assert.ok(
        !withoutAnchor.includes("/tmp/") && !withoutAnchor.startsWith("tmp/"),
        `${path.relative(repoRoot, doc)}: link "${target}" must not depend on a temporary path`,
      );
      const resolved = path.resolve(dir, withoutAnchor);
      assert.ok(
        resolved.startsWith(repoRoot + path.sep),
        `${path.relative(repoRoot, doc)}: link "${target}" must resolve inside the repository`,
      );
      assert.ok(
        existsSync(resolved),
        `${path.relative(repoRoot, doc)}: link "${target}" must resolve to a tracked file (missing: ${resolved})`,
      );
    }
  }
});

// -- navigation: the two tracked documents point at each other -----------------

test("the operator-surface document backlinks to the README trusted-local section", () => {
  if (!existsSync(OPERATOR_SURFACE_PATH)) return;
  assert.match(
    read(OPERATOR_SURFACE_PATH),
    /README\.md/u,
    "the operator-surface document must link back to the README",
  );
});

test("the operator-surface document links the troubleshooting reference", () => {
  if (!existsSync(OPERATOR_SURFACE_PATH)) return;
  assert.match(
    read(OPERATOR_SURFACE_PATH),
    /trusted-local-observation-troubleshooting\.md/u,
    "the operator-surface document must link the troubleshooting/refusal reference",
  );
});
