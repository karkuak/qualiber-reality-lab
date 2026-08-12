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
 * It never trusts a directory because it exists — and, since the independent
 * review of `07da5fe`, it never trusts one because it is *complete* either. That
 * review placed a symlink at the digest-derived extraction path, pointed it at a
 * directory outside the worktree holding three arbitrary files with the right
 * names, and the prerequisite reported `satisfied`, `reused: true` while the
 * campaign went on to read `UNVERIFIED` bytes from outside the tree it was
 * measuring. Presence and pathname are not provenance.
 *
 * So reuse is now a *proof*, performed every time and from scratch:
 *
 *   1. no component of the extraction path is a symbolic link, and the resolved
 *      path is physically inside the campaign worktree;
 *   2. a marker written by this module names the pin the repository currently
 *      commits, the exact set of required paths, and a digest for each;
 *   3. every required file's digest is **recomputed** and compared to the marker.
 *
 * A marker alone proves nothing — it is a file an attacker could write — which is
 * why (3) is unconditional and why (1) runs before anything is read at all. What
 * the marker buys is the binding between bytes on disk and the archive digest the
 * repository committed; what the recomputation buys is that the binding is still
 * true. Fail any of the three and the extraction is rebuilt from a verified
 * archive, or the prerequisite is reported unavailable. There is no third branch,
 * and in particular no branch that proceeds with bytes nobody verified.
 *
 * It never reaches the network unless a caller explicitly says it may. Absent
 * that, an absent archive is an unavailable prerequisite — a reported,
 * first-class outcome — rather than a silent download of whatever the URL serves
 * today.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
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

/** The fixture identifier the marker carries, equal to the prerequisite id. */
export const OTEL_DEMO_FIXTURE_ID = "otel-demo-upstream";

/**
 * The file that binds an extraction to the archive it came from.
 *
 * Dotted and inside the extraction root, so it dies with the worktree and is
 * never mistaken for upstream content: the three required paths are the only
 * things `docker compose config` opens, and this is not one of them.
 */
export const FIXTURE_MARKER_NAME = ".erl2-campaign-fixture.json";
export const FIXTURE_MARKER_SCHEMA = "erl2.campaign-fixture-marker";
export const FIXTURE_MARKER_VERSION = 1;

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
    configHashes: readOtelDemoConfigHashes(repoRoot),
  };
}

/**
 * The digests of the applied configuration files, as the substrate lock pins them.
 *
 * This is the fixture's committed ground truth, and it is what makes the marker
 * more than a self-signed claim. A marker is a file: anything that can write
 * three plausible files into a directory can write a fourth describing them, and
 * every digest in it will recompute perfectly. What such a forgery cannot do is
 * match `config_hashes` — those live in `substrate-lock.json`, they are tracked,
 * and `scripts/qualify-otel-demo.mjs` produced them by hashing the real release.
 *
 * So verification asks two independent questions. The marker answers *which
 * archive and which paths this extraction claims to be*; the lock answers
 * *whether these bytes are the ones the repository qualified*. Only the second
 * requires trusting something the campaign worktree cannot write.
 */
export function readOtelDemoConfigHashes(repoRoot) {
  const lockPath = path.join(repoRoot, "environments", "otel-demo", "substrate-lock.json");
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  const hashes = lock.config_hashes;
  if (!Array.isArray(hashes) || hashes.length === 0 || hashes.some((h) => typeof h !== "string")) {
    throw new Error(`${lockPath} does not pin config_hashes`);
  }
  return Object.freeze([...hashes]);
}

/** Where the upstream fixture lives beneath a checkout root. */
export function upstreamDirFor(root) {
  return path.join(root, "environments", "otel-demo", "upstream");
}

/** The extraction root's path relative to a worktree, in POSIX form. */
export function extractionRelativePath(pin) {
  return ["environments", "otel-demo", "upstream", pin.extractionDir].join("/");
}

// -- containment -------------------------------------------------------------

function lstatOrUndefined(target) {
  try {
    return lstatSync(target);
  } catch {
    return undefined;
  }
}

/**
 * Resolve `relative` beneath `root`, proving nothing on the way out is a link.
 *
 * The proof is structural rather than after the fact. `root` is canonicalised
 * once with `realpathSync`, and then every component is `lstat`ed as it is
 * appended: if no component is a symbolic link, the path that comes out cannot
 * name a file outside `root`, because there is no mechanism left by which it
 * could. The final `realpathSync` equality is belt and braces — it costs one
 * syscall and it makes the containment claim something a test can read directly
 * rather than infer from the absence of links.
 *
 * `lstat`, never `stat`: the whole point is to see the link rather than what it
 * points at. A `stat`-based check answers "is there a directory there", which is
 * exactly the question the review's attack answered `yes` to.
 *
 * A path that simply does not exist yet is **not** an error — provisioning has to
 * be able to ask where it would write. That is reported as `exists: false`, and
 * the components that did exist were still proven link-free.
 */
export function resolveContained(root, relative) {
  let rootReal;
  try {
    rootReal = realpathSync(root);
  } catch {
    return { ok: false, reason: `the containment root ${root} cannot be resolved` };
  }
  if (path.isAbsolute(relative)) {
    return { ok: false, reason: `${relative} is an absolute path, not a path within ${root}` };
  }
  const parts = relative.split(/[/\\]/).filter((part) => part !== "" && part !== ".");
  if (parts.includes("..")) {
    return { ok: false, reason: `${relative} traverses upward out of ${root}` };
  }

  let current = rootReal;
  let missing = false;
  for (const part of parts) {
    current = path.join(current, part);
    // Nothing can exist beneath a component that does not exist, so the rest of
    // the path is built lexically. The caller still gets the *full* path it asked
    // about — provisioning needs to know where it would write, not where the
    // walk stopped.
    if (missing) continue;
    const stat = lstatOrUndefined(current);
    if (stat === undefined) {
      missing = true;
      continue;
    }
    if (stat.isSymbolicLink()) {
      return {
        ok: false,
        symlinkAt: current,
        // Named rather than followed. Reporting where the link is, and refusing
        // there, is what stops the campaign reading bytes from wherever it points.
        reason:
          `${current} is a symbolic link; the campaign never follows one into or out of ` +
          `the worktree it is measuring`,
      };
    }
  }

  if (missing) return { ok: true, exists: false, path: current };

  // No component is a link, so this is already canonical — asserted rather than
  // assumed, because "already canonical" is the entire containment argument.
  let real;
  try {
    real = realpathSync(current);
  } catch {
    return { ok: true, exists: false, path: current };
  }
  if (real !== current || !(real === rootReal || real.startsWith(rootReal + path.sep))) {
    return {
      ok: false,
      reason: `${current} resolves to ${real}, which is not physically inside ${rootReal}`,
    };
  }
  return { ok: true, exists: true, path: current, real };
}

/**
 * An extraction is usable only when every declared path is present.
 *
 * Retained because the shape of a *complete* extraction is still worth naming,
 * but it is no longer the trust decision — `verifyExtraction` is. A half
 * extraction is the case that would otherwise pass a bare `existsSync` and then
 * fail inside `docker compose config`, where the failure looks like a substrate
 * problem rather than a fixture problem.
 */
export function extractionComplete(extractionRoot) {
  return OTEL_DEMO_UPSTREAM_PATHS.every((p) => {
    const stat = lstatOrUndefined(path.join(extractionRoot, p));
    return stat !== undefined && stat.isFile();
  });
}

// -- the marker --------------------------------------------------------------

/**
 * The deterministic bytes that bind an extraction to a verified archive.
 *
 * Deterministic in the strict sense: the same extraction produces the same bytes
 * on any host, because every field is either read from the repository's committed
 * pin or computed from file content, and the file map is emitted in sorted order.
 * Nothing here records a timestamp, a hostname, or an absolute path — a marker
 * that varied with where it was written could not be compared against anything.
 */
export function fixtureMarker({ pin, extractionRelative, digests }) {
  const files = {};
  for (const key of Object.keys(digests).sort()) files[key] = digests[key];
  return {
    schema: FIXTURE_MARKER_SCHEMA,
    version: FIXTURE_MARKER_VERSION,
    fixture: OTEL_DEMO_FIXTURE_ID,
    release: pin.releaseTag,
    archive_sha256: pin.archiveSha256,
    extraction_root: extractionRelative,
    required_paths: [...OTEL_DEMO_UPSTREAM_PATHS],
    files,
  };
}

/**
 * Prove a pre-existing extraction is the pinned archive's, byte for byte.
 *
 * Order matters and is the design. Containment is settled before a single byte is
 * read, because reading a file through an attacker-placed link is already the
 * loss. The marker is parsed next and checked against the repository's *current*
 * committed pin, so an extraction left behind by a previous release cannot serve
 * a re-pinned campaign. Only then are digests recomputed — every one of them,
 * every time, with the marker used solely as the expectation to compare against.
 *
 * Never `marker.files` alone, and never a cached result: a marker is a file, and
 * anything that can write three files into a directory can write a fourth.
 */
export function verifyExtraction({ worktree, pin }) {
  const extractionRelative = extractionRelativePath(pin);
  const contained = resolveContained(worktree, extractionRelative);
  if (!contained.ok) {
    return { ok: false, escaped: true, extractionRelative, reason: contained.reason, ...(contained.symlinkAt === undefined ? {} : { symlinkAt: contained.symlinkAt }) };
  }
  const extractionRoot = contained.path;
  if (!contained.exists) {
    return { ok: false, absent: true, extractionRoot, extractionRelative, reason: `no extraction at ${extractionRelative}` };
  }
  if (!lstatSync(extractionRoot).isDirectory()) {
    return { ok: false, extractionRoot, extractionRelative, reason: `${extractionRelative} is not a directory` };
  }

  const markerAt = resolveContained(worktree, `${extractionRelative}/${FIXTURE_MARKER_NAME}`);
  if (!markerAt.ok) {
    return { ok: false, escaped: true, extractionRoot, extractionRelative, reason: markerAt.reason };
  }
  if (!markerAt.exists || !lstatSync(markerAt.path).isFile()) {
    return {
      ok: false,
      extractionRoot,
      extractionRelative,
      unmarked: true,
      reason:
        `${extractionRelative} carries no ${FIXTURE_MARKER_NAME}; a directory this campaign did not ` +
        `extract from the pinned archive is not evidence of anything`,
    };
  }

  let marker;
  try {
    marker = JSON.parse(readFileSync(markerAt.path, "utf8"));
  } catch (error) {
    return { ok: false, extractionRoot, extractionRelative, reason: `${FIXTURE_MARKER_NAME} is not readable JSON: ${String(error)}` };
  }

  // Agreement with the pin the repository commits *now*, not with whatever the
  // marker would like to claim. This is the check that stops a correctly formed
  // marker for a different archive — a stale release, a re-pin — from satisfying
  // a campaign measuring the current one.
  const disagreements = [];
  if (marker.schema !== FIXTURE_MARKER_SCHEMA) disagreements.push(`schema is ${String(marker.schema)}`);
  if (marker.version !== FIXTURE_MARKER_VERSION) disagreements.push(`version is ${String(marker.version)}`);
  if (marker.fixture !== OTEL_DEMO_FIXTURE_ID) disagreements.push(`fixture is ${String(marker.fixture)}`);
  if (marker.release !== pin.releaseTag) disagreements.push(`release is ${String(marker.release)}, pinned is ${pin.releaseTag}`);
  if (marker.archive_sha256 !== pin.archiveSha256) {
    disagreements.push(`archive is ${String(marker.archive_sha256)}, pinned is ${pin.archiveSha256}`);
  }
  if (marker.extraction_root !== extractionRelative) {
    disagreements.push(`extraction_root is ${String(marker.extraction_root)}, expected ${extractionRelative}`);
  }
  const required = [...OTEL_DEMO_UPSTREAM_PATHS].sort();
  if (
    !Array.isArray(marker.required_paths) ||
    JSON.stringify([...marker.required_paths].sort()) !== JSON.stringify(required)
  ) {
    disagreements.push(`required_paths is ${JSON.stringify(marker.required_paths)}`);
  }
  const files = marker.files;
  if (files === null || typeof files !== "object" || JSON.stringify(Object.keys(files).sort()) !== JSON.stringify(required)) {
    disagreements.push(`files names ${JSON.stringify(files === null || typeof files !== "object" ? files : Object.keys(files).sort())}`);
  }
  if (disagreements.length > 0) {
    return {
      ok: false,
      extractionRoot,
      extractionRelative,
      forged: true,
      reason: `${FIXTURE_MARKER_NAME} does not agree with the committed pin: ${disagreements.join("; ")}`,
    };
  }

  // Recomputed, always. The marker is the expectation; the bytes are the evidence.
  const mismatched = [];
  for (const required_ of OTEL_DEMO_UPSTREAM_PATHS) {
    const at = resolveContained(worktree, `${extractionRelative}/${required_}`);
    if (!at.ok) {
      return { ok: false, escaped: true, extractionRoot, extractionRelative, reason: at.reason, ...(at.symlinkAt === undefined ? {} : { symlinkAt: at.symlinkAt }) };
    }
    if (!at.exists || !lstatSync(at.path).isFile()) {
      mismatched.push(`${required_} is missing or not a regular file`);
      continue;
    }
    const observed = sha256File(at.path);
    if (observed !== files[required_]) {
      mismatched.push(`${required_} is ${observed}, the marker records ${String(files[required_])}`);
      continue;
    }
    // …and the marker itself is checked against something it cannot write. A
    // forged extraction whose marker describes it perfectly still fails here,
    // because these digests come from the tracked substrate lock.
    if (!pin.configHashes.includes(observed)) {
      mismatched.push(`${required_} is ${observed}, which substrate-lock.json does not pin`);
    }
  }
  if (mismatched.length > 0) {
    return {
      ok: false,
      extractionRoot,
      extractionRelative,
      tampered: true,
      reason: `the extracted files do not match ${FIXTURE_MARKER_NAME}: ${mismatched.join("; ")}`,
    };
  }

  return { ok: true, extractionRoot, extractionRelative, marker };
}

// -- the archive -------------------------------------------------------------

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
 * What the archive would write, checked before `tar` is allowed to write it.
 *
 * A verified digest says the bytes are the release the repository pinned. It does
 * not say the release is *safe to extract*, and those are different claims: an
 * archive member named `/etc/x`, or `../../x`, or a symbolic link pointing at
 * one, escapes the extraction root no matter how well the container hashes. The
 * digest check would still pass, because the escape is what the pinned bytes
 * legitimately contain.
 *
 * So the listing is read first, and the extraction is refused rather than
 * repaired. Two passes over one 3 MB tarball, both cheap:
 *
 *   - every member, anywhere in the archive, is rejected if it is absolute or
 *     carries a `..` component — a global signal that this is not the shape of
 *     archive we thought we pinned;
 *   - every member this campaign would actually *select* must be a regular file
 *     whose path, after one leading component is stripped, is exactly one of the
 *     declared required paths, and must be the only member that selects it.
 *
 * The second is the one that matters for containment; the first is the one that
 * would notice a re-pin to something strange.
 */
export function inspectArchiveMembers(archive, run = spawnSync) {
  const names = run("tar", ["-tzf", archive], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (names.status !== 0) {
    return { ok: false, reason: `listing ${archive} failed: ${String(names.stderr ?? "").slice(0, 400)}` };
  }
  const members = String(names.stdout ?? "")
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line !== "");

  const unsafe = [];
  const selected = new Map();
  for (const member of members) {
    if (member.startsWith("/") || /^[A-Za-z]:[\\/]/.test(member)) {
      unsafe.push(`${member} is an absolute path`);
      continue;
    }
    const parts = member.split("/").filter((part) => part !== "");
    if (parts.includes("..")) {
      unsafe.push(`${member} traverses upward`);
      continue;
    }
    if (parts.length < 2) continue;
    const stripped = parts.slice(1).join("/");
    if (!OTEL_DEMO_UPSTREAM_PATHS.includes(stripped)) continue;
    if (selected.has(stripped)) {
      unsafe.push(`${stripped} is carried by more than one member (${String(selected.get(stripped))}, ${member})`);
      continue;
    }
    selected.set(stripped, member);
  }
  if (unsafe.length > 0) {
    return { ok: false, reason: `${archive} carries unsafe members: ${unsafe.slice(0, 8).join("; ")}`, members: members.length };
  }

  const missing = OTEL_DEMO_UPSTREAM_PATHS.filter((p) => !selected.has(p));
  if (missing.length > 0) {
    return { ok: false, reason: `${archive} does not carry ${missing.join(", ")}`, members: members.length };
  }

  // Types, for the members that will actually be written. The verbose listing's
  // first character is the mode's type field; anything that is not `-` is a
  // directory, a link, or a device, and none of those are what a configuration
  // file looks like.
  const verbose = run("tar", ["-tvzf", archive], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (verbose.status !== 0) {
    return { ok: false, reason: `listing ${archive} verbosely failed: ${String(verbose.stderr ?? "").slice(0, 400)}` };
  }
  const wanted = new Set(selected.values());
  const notRegular = [];
  for (const line of String(verbose.stdout ?? "").split("\n")) {
    const trimmed = line.replace(/\r$/, "");
    if (trimmed === "") continue;
    const named = [...wanted].find((member) => trimmed.includes(member));
    if (named === undefined) continue;
    // `-> ` (symbolic) and ` link to ` (hard) are how both tar families render a
    // link's target, and either one means the member is not the file itself.
    if (trimmed[0] !== "-" || / -> /.test(trimmed) || / link to /.test(trimmed)) {
      notRegular.push(`${named} is not a regular file (${trimmed.slice(0, 120)})`);
    }
  }
  if (notRegular.length > 0) {
    return { ok: false, reason: `${archive} carries unexpected links: ${notRegular.join("; ")}`, members: members.length };
  }

  return { ok: true, members: members.length, selected: Object.fromEntries(selected) };
}

// -- provisioning ------------------------------------------------------------

/**
 * Make the pinned upstream configuration present inside `worktree`.
 *
 * Idempotent, and idempotent *by proof*: a second call verifies the extraction it
 * finds rather than recognising the path, so the cheap path and the safe path are
 * the same path. Nothing is ever written outside `worktree`, so the canonical
 * checkout's ignored fixture directory is read at most and never modified — and
 * because the destination is git-ignored, `restore()`'s `git status --porcelain`
 * cannot see it and the campaign's byte-identical-tree certification is
 * unaffected.
 *
 * The order of the rebuild path is deliberate: **nothing is removed until a
 * verified archive is in hand**. A campaign that deleted an unverifiable
 * extraction and then discovered it had nothing to rebuild from would have
 * destroyed state and reported unavailable, which is the worst of both.
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
  const extractionRelative = extractionRelativePath(pin);

  const existing = verifyExtraction({ worktree, pin });
  if (existing.ok) {
    return {
      status: PREREQUISITE_STATUS.SATISFIED,
      reused: true,
      verified: true,
      extractionRoot: existing.extractionRoot,
      extractionRelative,
      archiveSha256: pin.archiveSha256,
      releaseTag: pin.releaseTag,
      marker: existing.marker,
    };
  }

  // Everything below is the rebuild path. Why the escape case does not get its
  // own early refusal: `removeExtractionRoot` already draws the only distinction
  // that matters — a link *at* the extraction root is this campaign's to unlink,
  // and a link *above* it is not — and it draws it without following either one.
  // Refusing here as well would only duplicate that judgement in a second place.
  const rejectedReuse = existing.absent === true ? undefined : existing.reason;

  const { archive, rejected } = findPinnedArchive({ repoRoot, pin, archiveOverride });
  let source = archive;
  let fetched = false;

  const unavailable = (reason, extra = {}) => ({
    status: PREREQUISITE_STATUS.UNAVAILABLE,
    reason: rejectedReuse === undefined ? reason : `${reason} The existing extraction was refused: ${rejectedReuse}`,
    archiveSha256: pin.archiveSha256,
    ...(rejectedReuse === undefined ? {} : { reuseRefused: rejectedReuse }),
    ...extra,
  });

  if (source === undefined && rejected.length > 0) {
    return unavailable(
      `an archive is present but does not match the pinned digest ` +
        `${pin.archiveSha256}: ${rejected.map((r) => `${r.candidate} is ${r.digest}`).join("; ")}. ` +
        `Refusing to extract unverified upstream bytes.`,
    );
  }

  if (source === undefined) {
    if (!allowFetch) {
      return unavailable(
        `the pinned OpenTelemetry Demo ${pin.releaseTag} archive (${pin.archiveName}) was not ` +
          `found locally, and fetching was not explicitly allowed. Provide it with ` +
          `\`node scripts/qualify-otel-demo.mjs --fetch-only\`, or set ` +
          `ERL2_CAMPAIGN_ALLOW_FETCH=1 to permit this campaign to fetch it.`,
      );
    }
    const fetch = runFetch({ repoRoot });
    if (fetch.status !== 0) {
      return unavailable(
        `\`qualify-otel-demo.mjs --fetch-only\` failed: ${String(fetch.detail ?? "").slice(0, 400)}`,
      );
    }
    fetched = true;
    const after = findPinnedArchive({ repoRoot, pin, archiveOverride });
    source = after.archive;
    if (source === undefined) {
      return unavailable(
        `the fetch completed but no archive matching ${pin.archiveSha256} is present; ` +
          `the served bytes are not the pinned release.`,
      );
    }
  }

  const listing = inspectArchiveMembers(source);
  if (!listing.ok) {
    return unavailable(`${listing.reason}. Refusing to extract it.`);
  }

  // Only now, with verified bytes and a safe listing in hand.
  const removal = removeExtractionRoot({ worktree, extractionRelative });
  if (!removal.ok) return unavailable(removal.reason);

  const destination = resolveContained(worktree, extractionRelative);
  if (!destination.ok) return unavailable(`${destination.reason}. Refusing to extract through it.`);
  const extractionRoot = destination.path;
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
    return unavailable(`extracting ${source} failed: ${String(extract.stderr ?? "").slice(0, 400)}`);
  }

  // What landed, proven the same way a reused extraction is proven: contained,
  // regular, and hashed. The marker is written from these digests, so a marker
  // can never describe an extraction that was not measured to produce it.
  const digests = {};
  for (const required of OTEL_DEMO_UPSTREAM_PATHS) {
    const at = resolveContained(worktree, `${extractionRelative}/${required}`);
    if (!at.ok || !at.exists || !lstatSync(at.path).isFile()) {
      rmSync(extractionRoot, { recursive: true, force: true });
      return unavailable(
        at.ok ? `the pinned archive did not produce ${required}` : `extraction produced an uncontained ${required}: ${at.reason}`,
      );
    }
    digests[required] = sha256File(at.path);
    // The archive matched the pinned digest, so this should be unreachable — and
    // it is checked anyway, because "should be unreachable" is what the campaign
    // assumed about the extraction directory too.
    if (!pin.configHashes.includes(digests[required])) {
      rmSync(extractionRoot, { recursive: true, force: true });
      return unavailable(
        `the verified archive produced a ${required} that substrate-lock.json does not pin ` +
          `(${digests[required]}); the pin and the lock disagree.`,
      );
    }
  }

  const marker = fixtureMarker({ pin, extractionRelative, digests });
  writeFileSync(path.join(extractionRoot, FIXTURE_MARKER_NAME), `${JSON.stringify(marker, null, 2)}\n`);

  return {
    status: PREREQUISITE_STATUS.SATISFIED,
    reused: false,
    verified: true,
    fetched,
    archive: source,
    extractionRoot,
    extractionRelative,
    archiveSha256: pin.archiveSha256,
    releaseTag: pin.releaseTag,
    marker,
    ...(rejectedReuse === undefined ? {} : { rebuiltAfter: rejectedReuse }),
  };
}

/**
 * Remove whatever occupies the extraction path, without ever following a link.
 *
 * `rmSync(..., { recursive: true })` on a symbolic link deletes the link, but the
 * distinction is too load-bearing to leave to a flag's semantics: a link is
 * `unlink`ed explicitly, and only a directory proven contained by
 * `resolveContained` is ever removed recursively. Anything else — a link above
 * the root, a path that will not resolve — refuses, because a recursive delete
 * of an unresolved path is how a cleanup becomes an incident.
 */
export function removeExtractionRoot({ worktree, extractionRelative }) {
  const parentRelative = extractionRelative.split("/").slice(0, -1).join("/");
  const parent = resolveContained(worktree, parentRelative);
  if (!parent.ok) {
    return { ok: false, reason: `${parent.reason}. Refusing to remove or write through it.` };
  }
  if (!parent.exists) return { ok: true, removed: false };

  const target = path.join(parent.path, extractionRelative.split("/").slice(-1)[0]);
  const stat = lstatOrUndefined(target);
  if (stat === undefined) return { ok: true, removed: false };
  if (stat.isSymbolicLink()) {
    unlinkSync(target);
    return { ok: true, removed: true, wasSymlink: true };
  }
  if (!stat.isDirectory()) {
    unlinkSync(target);
    return { ok: true, removed: true };
  }
  rmSync(target, { recursive: true, force: true });
  return { ok: true, removed: true };
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
 *
 * `skipEvidence` is what makes a prerequisite able to *excuse* an observed skip.
 * The classifier will read `unmeasured_here` out of a skipped designated case
 * only when the case's own skip reason names one of these markers — so a control
 * that declares a prerequisite cannot launder an unrelated disappearance through
 * it, and a suite that changes its skip message stops agreeing rather than
 * quietly keeping the excuse.
 */
export const CAMPAIGN_PREREQUISITES = Object.freeze({
  "otel-demo-upstream": Object.freeze({
    id: "otel-demo-upstream",
    describe: "the pinned OpenTelemetry Demo upstream configuration, extracted into the worktree",
    // The markers the repository's own suites announce when this fixture is what
    // they are missing: `composeSubstrate.test.ts` says `RENDERED TOPOLOGY
    // UNPROVEN`, and the live Compose suites fold the archive into `LIVE
    // SUBSTRATE UNPROVEN`. Nothing else may borrow them.
    skipEvidence: Object.freeze(["RENDERED TOPOLOGY UNPROVEN", "LIVE SUBSTRATE UNPROVEN"]),
    satisfy: (context) => provisionOtelDemoUpstream(context),
  }),
  "docker-daemon": Object.freeze({
    id: "docker-daemon",
    describe: "a reachable container daemon",
    // The live-substrate suites' markers. `containerDeadlineEnforcement.test.ts`
    // is deliberately absent from this list: it does not skip on a daemonless
    // host, it *passes* by asserting the fail-closed refusal, and its control is
    // refused before execution by the prerequisite check rather than excused
    // after it.
    skipEvidence: Object.freeze([
      "LIVE SUBSTRATE UNPROVEN",
      "EXTERNAL SUBJECT UNPROVEN",
      "LIVE CONTAINER UNPROVEN",
    ]),
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
