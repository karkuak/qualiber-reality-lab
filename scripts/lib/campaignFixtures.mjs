/**
 * Prerequisites a control may declare, and how the campaign satisfies them.
 *
 * ## Why this exists
 *
 * Controls are applied to a `git worktree` checked out at HEAD. A worktree
 * carries tracked files and nothing else, so every input the repository
 * deliberately keeps *out* of version control is absent from it — including
 * `environments/otel-demo/upstream/`, which `.gitignore` excludes because it is
 * a 3 MB third-party release archive and its extraction.
 *
 * `substrate-loopback-only-rendered` designates `COMPOSE-ADV: the RENDERED
 * configuration publishes one loopback port and nothing else`, and that case
 * skips itself — explicitly, with `RENDERED TOPOLOGY UNPROVEN` — when the
 * extracted upstream configuration is missing. In the campaign worktree it was
 * therefore never measured, while the other 28 cases in its file passed. The
 * classifier read "0 failed" and recorded `tests_passed_unexpectedly`: a
 * disagreement manufactured out of an unmeasured control.
 *
 * The independent review of `90a0039` reproduced this at both `e9718e0` and
 * `90a0039` and proved the control is fully load-bearing once the fixture is
 * present — baseline passes, the mutated overlay fails the intended loopback
 * assertion, and reverting restores the pass. The defect is provisioning, not
 * the control and not receipt admission.
 *
 * ## What this module will not do
 *
 * It is not a fixture framework. There are exactly two prerequisites, one field
 * declares them, and a control that declares nothing asks for nothing. Adding a
 * third should feel like a decision, not a registration.
 *
 * It never trusts a directory because it exists. The only thing it trusts is the
 * archive digest the repository already committed in
 * `environments/otel-demo/qualification/provenance.json`, and every extraction
 * is performed from an archive that matched it. A pre-existing extraction is
 * reused only when it is complete, and re-made from the verified archive when it
 * is not.
 *
 * It never reaches the network unless a caller explicitly says it may. Absent
 * that, an absent archive is an unavailable prerequisite — a reported,
 * first-class outcome — rather than a silent download of whatever the URL serves
 * today.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

/** Whether a declared prerequisite could be made true for this campaign. */
export const PREREQUISITE_STATUS = Object.freeze({
  SATISFIED: "satisfied",
  UNAVAILABLE: "unavailable",
});

/**
 * The upstream files `docker compose config` opens, and the only ones extracted.
 *
 * Must stay equal to `UPSTREAM_CONFIG_PATHS` in `scripts/qualify-otel-demo.mjs`;
 * `tests/integration/campaignFixtures.test.ts` reads both and fails if they
 * drift, because a subset extracted here that the qualifier does not recognise
 * would provision a fixture the repository does not actually pin.
 */
export const OTEL_DEMO_UPSTREAM_PATHS = Object.freeze([
  "compose.yaml",
  ".env",
  "src/otel-collector/otelcol-config.yml",
]);

/** `sha256:`-prefixed digest of a file, in the form the lock records. */
export function sha256File(file) {
  return `sha256:${createHash("sha256").update(readFileSync(file)).digest("hex")}`;
}

/**
 * The extraction directory name for a digest.
 *
 * Derived, never configured: `qualify-otel-demo.mjs` names the directory after
 * the first 16 hex characters of the archive digest, so a different archive
 * cannot land in the directory the tests read. Reproduced here rather than
 * imported because that script is a CLI with no exports; the drift test pins
 * them together.
 */
export function extractionDirName(archiveSha256) {
  const hex = archiveSha256.startsWith("sha256:") ? archiveSha256.slice(7) : archiveSha256;
  return `extracted-${hex.slice(0, 16)}`;
}

/**
 * The release the repository pins, read from its own committed provenance.
 *
 * Read rather than restated. The digest lives in
 * `qualification/provenance.json` and `substrate-lock.json`, both tracked; if
 * this module carried its own copy, a re-pin would leave the campaign
 * provisioning the previous release while every other consumer moved.
 */
export function readOtelDemoPin(repoRoot) {
  const provenancePath = path.join(
    repoRoot,
    "environments",
    "otel-demo",
    "qualification",
    "provenance.json",
  );
  const provenance = JSON.parse(readFileSync(provenancePath, "utf8"));
  const releaseTag = provenance.release_tag;
  const archiveSha256 = provenance.archive_sha256;
  if (typeof releaseTag !== "string" || typeof archiveSha256 !== "string") {
    throw new Error(`${provenancePath} does not pin release_tag and archive_sha256`);
  }
  return {
    releaseTag,
    archiveSha256,
    archiveName: `opentelemetry-demo-${releaseTag}.tar.gz`,
    extractionDir: extractionDirName(archiveSha256),
    archiveUrl: provenance.archive_url,
  };
}

/** Where the upstream fixture lives beneath a checkout root. */
export function upstreamDirFor(root) {
  return path.join(root, "environments", "otel-demo", "upstream");
}

/**
 * An extraction is usable only when every declared path is present.
 *
 * The review's instruction was explicit: do not copy an arbitrary ignored
 * directory and assume it is valid. A half-extracted root is the case that
 * would otherwise pass a bare `existsSync` and then fail inside `docker compose
 * config`, where the failure looks like a substrate problem rather than a
 * fixture problem.
 */
export function extractionComplete(extractionRoot) {
  return OTEL_DEMO_UPSTREAM_PATHS.every((p) => existsSync(path.join(extractionRoot, p)));
}

/**
 * A local archive whose digest matches the pin, or `undefined`.
 *
 * Search order is explicit-caller, then the repository the campaign is measuring.
 * A candidate that exists but hashes to something else is *reported*, not
 * silently skipped: a stale or truncated archive at the expected path is exactly
 * the case that should stop provisioning rather than fall through to a fetch.
 */
export function findPinnedArchive({ repoRoot, pin, archiveOverride }) {
  const candidates = [
    ...(archiveOverride === undefined || archiveOverride === "" ? [] : [archiveOverride]),
    path.join(upstreamDirFor(repoRoot), pin.archiveName),
  ];
  const rejected = [];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const digest = sha256File(candidate);
    if (digest === pin.archiveSha256) return { archive: candidate, rejected };
    rejected.push({ candidate, digest });
  }
  return { archive: undefined, rejected };
}

/**
 * Make the pinned upstream configuration present inside `worktree`.
 *
 * Idempotent: a complete extraction at the digest-derived path is reused, and
 * the archive is not re-hashed for a second declaring control. Nothing is ever
 * written outside `worktree`, so the canonical checkout's ignored fixture
 * directory is read at most and never modified — and because the destination is
 * git-ignored, `restore()`'s `git status --porcelain` cannot see it and the
 * campaign's byte-identical-tree certification is unaffected.
 *
 * Cleanup is the worktree's: `release()` removes the whole temporary root, so
 * provisioned state cannot outlive the campaign that created it.
 */
export function provisionOtelDemoUpstream({
  repoRoot,
  worktree,
  allowFetch = false,
  archiveOverride,
  runFetch = defaultFetch,
}) {
  const pin = readOtelDemoPin(repoRoot);
  const extractionRoot = path.join(upstreamDirFor(worktree), pin.extractionDir);

  if (extractionComplete(extractionRoot)) {
    return {
      status: PREREQUISITE_STATUS.SATISFIED,
      reused: true,
      extractionRoot,
      archiveSha256: pin.archiveSha256,
      releaseTag: pin.releaseTag,
    };
  }

  // Present but incomplete is not a base to build on. Removing it keeps the
  // digest-derived path meaning exactly one thing: the full extraction of the
  // archive that hashes to the pin.
  if (existsSync(extractionRoot)) rmSync(extractionRoot, { recursive: true, force: true });

  const { archive, rejected } = findPinnedArchive({ repoRoot, pin, archiveOverride });
  let source = archive;
  let fetched = false;

  if (source === undefined && rejected.length > 0) {
    return {
      status: PREREQUISITE_STATUS.UNAVAILABLE,
      reason:
        `an archive is present but does not match the pinned digest ` +
        `${pin.archiveSha256}: ${rejected
          .map((r) => `${r.candidate} is ${r.digest}`)
          .join("; ")}. Refusing to extract unverified upstream bytes.`,
      archiveSha256: pin.archiveSha256,
    };
  }

  if (source === undefined) {
    if (!allowFetch) {
      return {
        status: PREREQUISITE_STATUS.UNAVAILABLE,
        reason:
          `the pinned OpenTelemetry Demo ${pin.releaseTag} archive (${pin.archiveName}) was not ` +
          `found locally, and fetching was not explicitly allowed. Provide it with ` +
          `\`node scripts/qualify-otel-demo.mjs --fetch-only\`, or set ` +
          `ERL2_CAMPAIGN_ALLOW_FETCH=1 to permit this campaign to fetch it.`,
        archiveSha256: pin.archiveSha256,
      };
    }
    const fetch = runFetch({ repoRoot });
    if (fetch.status !== 0) {
      return {
        status: PREREQUISITE_STATUS.UNAVAILABLE,
        reason: `\`qualify-otel-demo.mjs --fetch-only\` failed: ${String(fetch.detail ?? "").slice(0, 400)}`,
        archiveSha256: pin.archiveSha256,
      };
    }
    fetched = true;
    const after = findPinnedArchive({ repoRoot, pin, archiveOverride });
    source = after.archive;
    if (source === undefined) {
      return {
        status: PREREQUISITE_STATUS.UNAVAILABLE,
        reason:
          `the fetch completed but no archive matching ${pin.archiveSha256} is present; ` +
          `the served bytes are not the pinned release.`,
        archiveSha256: pin.archiveSha256,
      };
    }
  }

  mkdirSync(extractionRoot, { recursive: true });
  // The qualifier's own extraction, path for path: only the declared config
  // files, one leading component stripped.
  const extract = spawnSync(
    "tar",
    [
      "-xzf",
      source,
      "-C",
      extractionRoot,
      "--strip-components=1",
      ...OTEL_DEMO_UPSTREAM_PATHS.map((p) => `*/${p}`),
    ],
    { encoding: "utf8" },
  );
  if (extract.status !== 0) {
    rmSync(extractionRoot, { recursive: true, force: true });
    return {
      status: PREREQUISITE_STATUS.UNAVAILABLE,
      reason: `extracting ${source} failed: ${String(extract.stderr ?? "").slice(0, 400)}`,
      archiveSha256: pin.archiveSha256,
    };
  }
  if (!extractionComplete(extractionRoot)) {
    const missing = OTEL_DEMO_UPSTREAM_PATHS.filter(
      (p) => !existsSync(path.join(extractionRoot, p)),
    );
    rmSync(extractionRoot, { recursive: true, force: true });
    return {
      status: PREREQUISITE_STATUS.UNAVAILABLE,
      reason: `the pinned archive does not carry ${missing.join(", ")}`,
      archiveSha256: pin.archiveSha256,
    };
  }

  return {
    status: PREREQUISITE_STATUS.SATISFIED,
    reused: false,
    fetched,
    archive: source,
    extractionRoot,
    archiveSha256: pin.archiveSha256,
    releaseTag: pin.releaseTag,
  };
}

function defaultFetch({ repoRoot }) {
  const run = spawnSync("node", [path.join(repoRoot, "scripts", "qualify-otel-demo.mjs"), "--fetch-only"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return { status: run.status ?? 1, detail: `${run.stdout ?? ""}${run.stderr ?? ""}` };
}

/** Whether a container daemon is reachable, for the one control that needs one. */
export function dockerDaemonAvailable(probe = defaultDockerProbe) {
  return probe();
}

function defaultDockerProbe() {
  const run = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return run.status === 0 && String(run.stdout ?? "").trim() !== "";
}

/**
 * The prerequisites a control may name, and how each is satisfied.
 *
 * Two entries, deliberately. `otel-demo-upstream` is *provisioned* — the
 * campaign can make it true. `docker-daemon` is only *detected* — nothing the
 * campaign does can conjure a daemon, and pretending otherwise would turn a
 * host fact into a harness failure. Both share one outcome shape so the
 * classifier does not care which kind it is looking at.
 */
export const CAMPAIGN_PREREQUISITES = Object.freeze({
  "otel-demo-upstream": Object.freeze({
    id: "otel-demo-upstream",
    describe: "the pinned OpenTelemetry Demo upstream configuration, extracted into the worktree",
    satisfy: (context) => provisionOtelDemoUpstream(context),
  }),
  "docker-daemon": Object.freeze({
    id: "docker-daemon",
    describe: "a reachable container daemon",
    satisfy: (context) =>
      dockerDaemonAvailable(context.dockerProbe)
        ? { status: PREREQUISITE_STATUS.SATISFIED, reused: true }
        : {
            status: PREREQUISITE_STATUS.UNAVAILABLE,
            reason: "no container daemon is reachable on this host",
          },
  }),
});

/**
 * Satisfy a declared prerequisite once per campaign, memoised in `cache`.
 *
 * Memoisation is the point of the cache rather than an optimisation: the
 * campaign runs one reusable worktree, so provisioning belongs to the worktree,
 * not to each of the 129 controls.
 */
export function ensurePrerequisite(id, context, cache) {
  if (cache?.has(id)) return cache.get(id);
  const prerequisite = CAMPAIGN_PREREQUISITES[id];
  const outcome =
    prerequisite === undefined
      ? {
          status: PREREQUISITE_STATUS.UNAVAILABLE,
          reason: `unknown prerequisite \`${id}\``,
          unknown: true,
        }
      : prerequisite.satisfy(context);
  cache?.set(id, outcome);
  return outcome;
}
