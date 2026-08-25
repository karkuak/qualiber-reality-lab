#!/usr/bin/env node
/**
 * Development-signs this example's `SubjectAdapterManifestV2`.
 *
 * ## Why a script exists at all
 *
 * `SubjectAdapterManifestV2` requires `core_hash` and `signature`, and no CLI
 * command on this repository's public surface produces either:
 * `declare-trusted-local-adapter` *consumes* an already-signed manifest and
 * checks its `core_hash` for staleness; it does not author or sign one. The
 * shortest supported route is two public exports of `@erl2/integrity`:
 * `sealSigned(draft, developmentKey(label))` computes both required fields in a
 * single call. That is all this script does, plus the validation `sealSigned`
 * deliberately does not do.
 *
 * ## What the signature is, and is not
 *
 * `developmentKey(label)` derives an Ed25519 key **deterministically from the
 * label alone**, using only code committed to this repository. Anyone holding a
 * clone can regenerate the identical key and produce an identical signature, so
 * this signature is a structural artefact, not evidence of authorship: it
 * proves nothing about who built the manifest and confers no certification, no
 * independent authenticity, and no production key custody. The `key_id` it
 * writes says so on its face — it begins `erl2-dev-`.
 *
 * That is also all the trusted-local path asks of it. Every check on this route
 * — `verifyTrustedLocalAdapterDeclaration`, `retainTrustedLocalAdapterV2`,
 * `resolveTrustedLocalAdapterV2`, `verifyTrustedLocalObservationRecord` —
 * recomputes and compares `core_hash`; none verifies this signature
 * cryptographically. The bar the field has to clear here is structural
 * validity. That is a reason to be precise about what the field means, not a
 * reason to relax the check: this script validates the sealed manifest against
 * the real closed schema before a single byte reaches disk, because
 * `sealSigned` seals whatever object it is handed and would otherwise happily
 * write a schema-invalid manifest that only refused one command later.
 *
 * ## Usage
 *
 *   node examples/trusted-local-neutral/build-manifest.mjs <output-path>
 *
 * The output path is explicit and mandatory: this script never guesses a
 * destination, never writes into the repository, and refuses to overwrite an
 * existing file. Run it from inside a built workspace tree (`npm ci &&
 * npm run build`) — Node resolves `@erl2/integrity` by walking up from *this
 * file's* directory, which is the same precondition the `erl2` binary carries.
 *
 * Output is byte-identical across runs: `coreHash` canonicalizes, the key is
 * derived from a fixed label, and Ed25519 signing is deterministic. Nothing
 * here reads the clock, the environment, or a random source.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertContract } from "@erl2/contracts";
import { developmentKey, hashBytes, sealSigned } from "@erl2/integrity";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

/** The adapter this example reuses. No second adapter is authored anywhere. */
const ADAPTER_ENTRY = path.join(
  repoRoot,
  "fixtures",
  "neutral",
  "neutral-full-lifecycle-observer.mjs",
);
const DRAFT = path.join(here, "manifest.draft.json");

/**
 * The development-key label, specific to this example.
 *
 * Distinct from the label the repository's own test fixtures use, so a manifest
 * produced by this example is never mistaken for one produced by the suite.
 */
const KEY_LABEL = "trusted-local-neutral-example-owner";

const output = process.argv[2];
if (output === undefined || output === "") {
  process.stderr.write(
    "usage: node examples/trusted-local-neutral/build-manifest.mjs <output-path>\n" +
      "the output path is mandatory; this script writes nowhere by default\n",
  );
  process.exit(2);
}
const outputPath = path.resolve(output);

const draft = JSON.parse(readFileSync(DRAFT, "utf8"));

// The artifact hash is derived from the adapter's actual committed bytes, right
// now, rather than trusted from the draft. The draft still carries the value so
// a reader can check it without running anything — and a disagreement between
// the two is a refusal, because it means either the fixture changed under this
// example or the draft was edited by hand into a claim about bytes that no
// longer exist.
const artifactHash = hashBytes(readFileSync(ADAPTER_ENTRY));
if (draft.adapter_artifact_hash !== artifactHash) {
  process.stderr.write(
    `the committed draft declares adapter_artifact_hash ${String(draft.adapter_artifact_hash)},\n` +
      `but ${path.relative(repoRoot, ADAPTER_ENTRY)} currently hashes to ${artifactHash}.\n` +
      "The reused adapter changed. Update manifest.draft.json (and re-check the manifest's\n" +
      "operation list against the fixture's handler-key order) rather than ignoring this.\n",
  );
  process.exit(1);
}

// Two public calls. `sealSigned` adds `core_hash` and `signature`; nothing else
// in the manifest is touched.
const manifest = sealSigned({ ...draft, adapter_artifact_hash: artifactHash }, developmentKey(KEY_LABEL));

// Validate *before* writing. `sealSigned` performs no validation of its own.
assertContract("SubjectAdapterManifestV2", manifest);

writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });

process.stdout.write(
  `${JSON.stringify(
    {
      manifest_path: outputPath,
      adapter_id: manifest.adapter_id,
      adapter_artifact_hash: manifest.adapter_artifact_hash,
      core_hash: manifest.core_hash,
      signature_key_id: manifest.signature.key_id,
      signature_authority:
        "development key derived from a fixed label in this repository; regenerable by anyone " +
        "with a clone, and therefore not evidence of authorship, certification or authenticity",
    },
    null,
    2,
  )}\n`,
);
