/**
 * Deterministic provisioning of the pinned OTel Demo upstream fixture into a
 * campaign worktree.
 *
 * ## What these controls exist for
 *
 * The negative-control campaign patches a `git worktree` checked out at HEAD. A
 * worktree carries tracked files only, so `environments/otel-demo/upstream/` —
 * git-ignored, because it is a third-party release archive and its extraction —
 * is absent from it. `substrate-loopback-only-rendered` designates a case that
 * renders the real merged Compose configuration, that case skips itself when the
 * extraction is missing, and the campaign scored the resulting "0 failed" as a
 * disagreement. The control was never measured.
 *
 * The independent review of `90a0039` proved the control is fully load-bearing
 * once the fixture is present, and identical at `e9718e0` and `90a0039`. So the
 * fix is provisioning, and provisioning has exactly one hard requirement: it must
 * never be possible to satisfy the prerequisite with bytes nobody verified.
 * Every control below is a way of getting that wrong.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const fixturesModulePath = path.join(repoRoot, "scripts", "lib", "campaignFixtures.mjs");

interface ProvisionOutcome {
  readonly status: string;
  readonly reason?: string;
  readonly reused?: boolean;
  readonly fetched?: boolean;
  readonly archive?: string;
  readonly extractionRoot?: string;
  readonly archiveSha256?: string;
  readonly releaseTag?: string;
}

interface FixturesModule {
  readonly PREREQUISITE_STATUS: Record<string, string>;
  readonly OTEL_DEMO_UPSTREAM_PATHS: readonly string[];
  readonly CAMPAIGN_PREREQUISITES: Record<string, { readonly id: string; readonly describe: string }>;
  readonly sha256File: (file: string) => string;
  readonly extractionDirName: (digest: string) => string;
  readonly readOtelDemoPin: (root: string) => {
    readonly releaseTag: string;
    readonly archiveSha256: string;
    readonly archiveName: string;
    readonly extractionDir: string;
  };
  readonly upstreamDirFor: (root: string) => string;
  readonly extractionComplete: (root: string) => boolean;
  readonly provisionOtelDemoUpstream: (input: Record<string, unknown>) => ProvisionOutcome;
  readonly ensurePrerequisite: (
    id: string,
    context: Record<string, unknown>,
    cache?: Map<string, ProvisionOutcome>,
  ) => ProvisionOutcome;
}

interface HarnessModule {
  readonly CONTROLS: readonly { readonly id: string; readonly requiresPrerequisite?: string }[];
}

const fixtures = (await import(pathToFileURL(fixturesModulePath).href)) as unknown as FixturesModule;
const harness = (await import(
  pathToFileURL(path.join(repoRoot, "scripts", "negative-control.mjs")).href
)) as unknown as HarnessModule;

const { PREREQUISITE_STATUS, OTEL_DEMO_UPSTREAM_PATHS } = fixtures;
const PIN = fixtures.readOtelDemoPin(repoRoot);
const CANONICAL_ARCHIVE = path.join(fixtures.upstreamDirFor(repoRoot), PIN.archiveName);

/**
 * These controls need the pinned archive itself, and no environment variable
 * conjures a 3 MB release tarball. Absent it they take an announced skip — the
 * same three-state shape the live substrate suites use — rather than passing
 * vacuously.
 */
const ARCHIVE_REASON = existsSync(CANONICAL_ARCHIVE)
  ? fixtures.sha256File(CANONICAL_ARCHIVE) === PIN.archiveSha256
    ? undefined
    : `the archive at ${CANONICAL_ARCHIVE} does not match the pinned digest`
  : `the pinned archive is not present at ${CANONICAL_ARCHIVE} ` +
    "(run `node scripts/qualify-otel-demo.mjs --fetch-only`)";

const ARCHIVE_SKIP: { readonly skip?: string } =
  ARCHIVE_REASON === undefined ? {} : { skip: `PINNED ARCHIVE UNPROVEN: ${ARCHIVE_REASON}` };

const owned: string[] = [];
function ownedDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  owned.push(dir);
  return dir;
}
process.on("exit", () => {
  for (const dir of owned) rmSync(dir, { recursive: true, force: true });
});

/** A minimal stand-in repository carrying only what the provisioner reads. */
function fakeRepo(options: { readonly archive?: string } = {}): string {
  const root = ownedDir("erl2-fixture-repo-");
  mkdirSync(path.join(root, "environments", "otel-demo", "qualification"), { recursive: true });
  copyFileSync(
    path.join(repoRoot, "environments", "otel-demo", "qualification", "provenance.json"),
    path.join(root, "environments", "otel-demo", "qualification", "provenance.json"),
  );
  if (options.archive !== undefined) {
    mkdirSync(fixtures.upstreamDirFor(root), { recursive: true });
    copyFileSync(options.archive, path.join(fixtures.upstreamDirFor(root), PIN.archiveName));
  }
  return root;
}

// -- the pin itself ----------------------------------------------------------

test("CAMPAIGN-FIXTURE: the pin is read from the repository's committed provenance, not restated", () => {
  const provenance = JSON.parse(
    readFileSync(
      path.join(repoRoot, "environments", "otel-demo", "qualification", "provenance.json"),
      "utf8",
    ),
  ) as { archive_sha256: string; release_tag: string };
  assert.equal(PIN.archiveSha256, provenance.archive_sha256);
  assert.equal(PIN.releaseTag, provenance.release_tag);

  // …and the substrate lock agrees, so a re-pin cannot move one and not the other.
  const lock = JSON.parse(
    readFileSync(path.join(repoRoot, "environments", "otel-demo", "substrate-lock.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.ok(
    JSON.stringify(lock).includes(provenance.archive_sha256),
    "substrate-lock.json no longer names the pinned archive digest",
  );
});

test("CAMPAIGN-FIXTURE: the extraction path is derived from the digest, never configured", () => {
  assert.equal(fixtures.extractionDirName("sha256:" + "ab".repeat(32)), "extracted-abababababababab");
  // Bare hex and prefixed hex name the same directory.
  assert.equal(fixtures.extractionDirName("ab".repeat(32)), "extracted-abababababababab");
  // And the derived name is the one the Compose suite actually reads.
  assert.equal(PIN.extractionDir, `extracted-${PIN.archiveSha256.slice(7, 23)}`);
  const composeSuite = readFileSync(
    path.join(repoRoot, "tests", "adversarial", "composeSubstrate.test.ts"),
    "utf8",
  );
  assert.ok(
    composeSuite.includes(PIN.extractionDir),
    `composeSubstrate.test.ts does not read ${PIN.extractionDir}; the provisioner would fill a directory nothing consumes`,
  );
});

test("CAMPAIGN-FIXTURE: the extracted subset is exactly the qualifier's, and the release is not re-chosen", () => {
  const qualifier = readFileSync(path.join(repoRoot, "scripts", "qualify-otel-demo.mjs"), "utf8");
  const declared = /const UPSTREAM_CONFIG_PATHS = (\[[^\]]*\]);/.exec(qualifier);
  assert.ok(declared, "qualify-otel-demo.mjs no longer declares UPSTREAM_CONFIG_PATHS");
  const qualifierPaths = JSON.parse((declared[1] as string).replace(/'/g, '"')) as string[];
  assert.deepEqual(
    [...OTEL_DEMO_UPSTREAM_PATHS],
    qualifierPaths,
    "the campaign extracts a different subset than the qualifier pins",
  );
  assert.ok(
    qualifier.includes(`const RELEASE_TAG = "${PIN.releaseTag}"`),
    "the qualifier pins a different OTel Demo release than the provisioner would provision",
  );
});

// -- provisioning ------------------------------------------------------------

test("CAMPAIGN-FIXTURE: the pinned archive provisions the declared paths", ARCHIVE_SKIP, () => {
  const root = fakeRepo({ archive: CANONICAL_ARCHIVE });
  const worktree = ownedDir("erl2-fixture-wt-");
  const outcome = fixtures.provisionOtelDemoUpstream({ repoRoot: root, worktree });

  assert.equal(outcome.status, PREREQUISITE_STATUS["SATISFIED"], outcome.reason);
  assert.equal(outcome.reused, false);
  assert.equal(outcome.archiveSha256, PIN.archiveSha256);
  assert.equal(
    outcome.extractionRoot,
    path.join(fixtures.upstreamDirFor(worktree), PIN.extractionDir),
    "the extraction did not land at the digest-derived path",
  );
  for (const declared of OTEL_DEMO_UPSTREAM_PATHS) {
    assert.ok(
      existsSync(path.join(outcome.extractionRoot as string, declared)),
      `provisioning did not produce ${declared}`,
    );
  }
  assert.equal(fixtures.extractionComplete(outcome.extractionRoot as string), true);
});

test("CAMPAIGN-FIXTURE: an archive whose digest is wrong refuses before extraction", () => {
  const root = fakeRepo();
  mkdirSync(fixtures.upstreamDirFor(root), { recursive: true });
  const impostor = path.join(fixtures.upstreamDirFor(root), PIN.archiveName);
  writeFileSync(impostor, "this is not the pinned OpenTelemetry Demo release\n");
  const worktree = ownedDir("erl2-fixture-wt-");

  const outcome = fixtures.provisionOtelDemoUpstream({ repoRoot: root, worktree });

  assert.equal(outcome.status, PREREQUISITE_STATUS["UNAVAILABLE"]);
  assert.match(String(outcome.reason), /does not match the pinned digest/);
  assert.match(String(outcome.reason), /Refusing to extract unverified upstream bytes/);
  assert.equal(
    existsSync(path.join(fixtures.upstreamDirFor(worktree), PIN.extractionDir)),
    false,
    "a rejected archive still created an extraction root",
  );
});

test("CAMPAIGN-FIXTURE: a missing archive with no allowed fetch is unavailable, and fetches nothing", () => {
  const root = fakeRepo();
  const worktree = ownedDir("erl2-fixture-wt-");
  let fetched = 0;

  const outcome = fixtures.provisionOtelDemoUpstream({
    repoRoot: root,
    worktree,
    allowFetch: false,
    runFetch: () => {
      fetched += 1;
      return { status: 0 };
    },
  });

  assert.equal(outcome.status, PREREQUISITE_STATUS["UNAVAILABLE"]);
  assert.equal(fetched, 0, "provisioning reached the network without being allowed to");
  assert.match(String(outcome.reason), /ERL2_CAMPAIGN_ALLOW_FETCH=1/);
  assert.match(String(outcome.reason), /qualify-otel-demo\.mjs --fetch-only/);
});

test("CAMPAIGN-FIXTURE: an allowed fetch that yields unpinned bytes is still unavailable", () => {
  const root = fakeRepo();
  const worktree = ownedDir("erl2-fixture-wt-");

  const outcome = fixtures.provisionOtelDemoUpstream({
    repoRoot: root,
    worktree,
    allowFetch: true,
    // A "successful" fetch that produced nothing matching the pin — a moved
    // archive, a re-cut tag, a proxy serving something else.
    runFetch: () => ({ status: 0 }),
  });

  assert.equal(outcome.status, PREREQUISITE_STATUS["UNAVAILABLE"]);
  assert.match(String(outcome.reason), /not the pinned release/);
});

test("CAMPAIGN-FIXTURE: a complete extraction is reused rather than re-extracted", ARCHIVE_SKIP, () => {
  const root = fakeRepo({ archive: CANONICAL_ARCHIVE });
  const worktree = ownedDir("erl2-fixture-wt-");

  const first = fixtures.provisionOtelDemoUpstream({ repoRoot: root, worktree });
  assert.equal(first.status, PREREQUISITE_STATUS["SATISFIED"]);
  assert.equal(first.reused, false);

  const second = fixtures.provisionOtelDemoUpstream({
    repoRoot: root,
    worktree,
    // Proof it did not extract again: there is no archive to extract from now.
    archiveOverride: path.join(worktree, "definitely-absent.tar.gz"),
  });
  assert.equal(second.status, PREREQUISITE_STATUS["SATISFIED"]);
  assert.equal(second.reused, true, "a complete extraction was re-extracted");
  assert.equal(second.extractionRoot, first.extractionRoot);
});

test("CAMPAIGN-FIXTURE: an incomplete extraction is not trusted", ARCHIVE_SKIP, () => {
  const root = fakeRepo({ archive: CANONICAL_ARCHIVE });
  const worktree = ownedDir("erl2-fixture-wt-");

  const first = fixtures.provisionOtelDemoUpstream({ repoRoot: root, worktree });
  const extraction = first.extractionRoot as string;
  // The case a bare `existsSync` would pass and `docker compose config` would
  // then fail inside, where it looks like a substrate fault.
  rmSync(path.join(extraction, ".env"), { force: true });
  assert.equal(fixtures.extractionComplete(extraction), false);

  const second = fixtures.provisionOtelDemoUpstream({ repoRoot: root, worktree });
  assert.equal(second.status, PREREQUISITE_STATUS["SATISFIED"]);
  assert.equal(second.reused, false, "an incomplete extraction was reused");
  assert.equal(fixtures.extractionComplete(extraction), true);
});

test("CAMPAIGN-FIXTURE: a canonical extraction is never copied — only verified archives are extracted", ARCHIVE_SKIP, () => {
  const root = fakeRepo({ archive: CANONICAL_ARCHIVE });
  // A pre-existing ignored extraction in the *source* repository, carrying
  // content no archive would produce. The review's instruction was explicit:
  // do not copy an arbitrary ignored directory and assume it is valid.
  const canonicalExtraction = path.join(fixtures.upstreamDirFor(root), PIN.extractionDir);
  mkdirSync(path.join(canonicalExtraction, "src", "otel-collector"), { recursive: true });
  for (const declared of OTEL_DEMO_UPSTREAM_PATHS) {
    writeFileSync(path.join(canonicalExtraction, declared), "SENTINEL-NOT-FROM-THE-ARCHIVE\n");
  }

  const worktree = ownedDir("erl2-fixture-wt-");
  const outcome = fixtures.provisionOtelDemoUpstream({ repoRoot: root, worktree });
  assert.equal(outcome.status, PREREQUISITE_STATUS["SATISFIED"]);

  for (const declared of OTEL_DEMO_UPSTREAM_PATHS) {
    const provisioned = readFileSync(path.join(outcome.extractionRoot as string, declared), "utf8");
    assert.ok(
      !provisioned.includes("SENTINEL-NOT-FROM-THE-ARCHIVE"),
      `${declared} was copied from the source checkout instead of extracted from the verified archive`,
    );
  }
  // The source checkout is left exactly as it was.
  assert.equal(
    readFileSync(path.join(canonicalExtraction, ".env"), "utf8"),
    "SENTINEL-NOT-FROM-THE-ARCHIVE\n",
  );
});

test("CAMPAIGN-FIXTURE: provisioned state lives inside the worktree and dies with it", ARCHIVE_SKIP, () => {
  const root = fakeRepo({ archive: CANONICAL_ARCHIVE });
  const worktreeRoot = ownedDir("erl2-fixture-wt-");
  const worktree = path.join(worktreeRoot, "tree");
  mkdirSync(worktree, { recursive: true });

  const outcome = fixtures.provisionOtelDemoUpstream({ repoRoot: root, worktree });
  const extraction = outcome.extractionRoot as string;
  assert.ok(
    extraction.startsWith(worktree + path.sep),
    "provisioning wrote outside the worktree it was given",
  );

  // `createDisposableWorktree().release()` removes the whole temporary root, so
  // removing it here is the same disposal the campaign performs.
  rmSync(worktreeRoot, { recursive: true, force: true });
  assert.equal(existsSync(extraction), false, "provisioned fixture state outlived its worktree");
});

// -- who may ask -------------------------------------------------------------

test("CAMPAIGN-FIXTURE: only declared controls request a prerequisite, and only known ones", () => {
  const declaring = harness.CONTROLS.filter((c) => c.requiresPrerequisite !== undefined);
  assert.deepEqual(
    declaring.map((c) => `${c.id} -> ${String(c.requiresPrerequisite)}`).sort(),
    [
      "container-deadline-kills-the-container -> docker-daemon",
      "substrate-loopback-only-rendered -> otel-demo-upstream",
    ],
    "the set of controls declaring a prerequisite changed; a fixture must be requested only where it is needed",
  );
  for (const control of declaring) {
    assert.ok(
      fixtures.CAMPAIGN_PREREQUISITES[control.requiresPrerequisite as string] !== undefined,
      `${control.id} declares an unknown prerequisite`,
    );
  }
});

test("CAMPAIGN-FIXTURE: a prerequisite is satisfied once per campaign, not once per control", ARCHIVE_SKIP, () => {
  const root = fakeRepo({ archive: CANONICAL_ARCHIVE });
  const worktree = ownedDir("erl2-fixture-wt-");
  const cache = new Map<string, ProvisionOutcome>();

  const first = fixtures.ensurePrerequisite("otel-demo-upstream", { repoRoot: root, worktree }, cache);
  const second = fixtures.ensurePrerequisite(
    "otel-demo-upstream",
    // A context that could not possibly provision anything, to prove the second
    // call never ran the provisioner at all.
    { repoRoot: path.join(worktree, "absent"), worktree },
    cache,
  );
  assert.equal(first.status, PREREQUISITE_STATUS["SATISFIED"]);
  assert.equal(second, first, "the prerequisite was resolved a second time instead of memoised");
});

test("CAMPAIGN-FIXTURE: an unknown prerequisite is unavailable rather than silently satisfied", () => {
  const outcome = fixtures.ensurePrerequisite("no-such-fixture", { repoRoot }, new Map());
  assert.equal(outcome.status, PREREQUISITE_STATUS["UNAVAILABLE"]);
  assert.match(String(outcome.reason), /unknown prerequisite/);
});

test("CAMPAIGN-FIXTURE: the container daemon is detected, never provisioned", () => {
  const absent = fixtures.CAMPAIGN_PREREQUISITES["docker-daemon"] as unknown as {
    satisfy: (c: Record<string, unknown>) => ProvisionOutcome;
  };
  assert.equal(
    absent.satisfy({ dockerProbe: () => false }).status,
    PREREQUISITE_STATUS["UNAVAILABLE"],
  );
  assert.equal(
    absent.satisfy({ dockerProbe: () => true }).status,
    PREREQUISITE_STATUS["SATISFIED"],
  );
});
