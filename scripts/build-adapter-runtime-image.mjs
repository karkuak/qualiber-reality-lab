#!/usr/bin/env node
// Builds the adapter runtime image and prints the digest-pinned reference to
// qualify against (ERL2-OQ-008 gate 2, ADR-ERL2-034).
//
// The reference printed is `<tag>@sha256:<image id>` — the runtime's own content
// address for the built image, which `resolveImageDigest` resolves and the
// substrate lock pins. A registry digest would be preferable and is not
// available for an image that was never pushed; what matters for the drift check
// is that the reference names bytes rather than a tag, and an image id does.
//
// The build is **not** bit-reproducible, and saying so is the point: two builds
// from the same base digest and the same Dockerfile produce two different image
// ids on this runtime. `SOURCE_DATE_EPOCH` is set because it removes one source
// of variance, not because it removes them all — BuildKit's `rewrite-timestamp`
// exporter option, which would handle the rest, conflicts with the docker
// exporter's unpack here.
//
// So a reviewer who rebuilds gets a different id, and
// `assertObservedMatchesIsolationLock` then refuses the run with
// `ENV_ISOLATION_SUBSTRATE_DRIFT` until the twenty controls have been observed
// against *their* bytes. That is the drift check working, not a defect: what is
// reproducible is the qualification procedure, and ADR-ERL2-017 already records
// that the qualification itself is host-specific and lock-specific.
//
// Usage: node scripts/build-adapter-runtime-image.mjs [--tag erl2-adapter-runtime]

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contextDir = path.join(repoRoot, "environments", "isolation", "runtime-image");

function flag(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

const tag = flag("tag", "erl2-adapter-runtime");
const binary = flag("runtime", process.env.ERL2_ISOLATION_RUNTIME ?? "docker");

const build = spawnSync(
  binary,
  ["build", "--tag", tag, "--pull=false", contextDir],
  {
    stdio: "inherit",
    env: { ...process.env, SOURCE_DATE_EPOCH: "0", DOCKER_BUILDKIT: "1" },
  },
);
if (build.status !== 0) {
  console.error("adapter runtime image build failed");
  process.exit(build.status ?? 1);
}

const inspect = spawnSync(binary, ["image", "inspect", tag, "--format", "{{.Id}}"], {
  encoding: "utf8",
});
const id = (inspect.stdout ?? "").trim();
if (inspect.status !== 0 || !/^sha256:[0-9a-f]{64}$/.test(id)) {
  console.error(`could not read the built image id: ${(inspect.stderr ?? "").trim()}`);
  process.exit(1);
}

console.log(`\nadapter runtime image: ${tag}@${id}`);
console.log(`qualify with:\n  npm run qualify:isolation -- --image ${tag}@${id}`);
