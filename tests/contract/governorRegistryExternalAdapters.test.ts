/**
 * The registry's external-adapter seam.
 *
 * Two properties, and they pull in opposite directions. The seam has to admit a
 * manifest this repository did not author — otherwise no externally built
 * subject can ever be bound by a run — and it has to leave a registry built
 * *without* one byte-identical, because every other suite in this tree asserts
 * against those bytes and those hashes.
 *
 * The third property is that ambiguity is refused rather than resolved. Two
 * manifests that a run could not tell apart are a configuration error, and
 * silently keeping the last one would decide, on the caller's behalf, which
 * bytes a subject binds.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { SubjectAdapterManifestV1 } from "@erl2/contracts";
import { adapterManifest } from "../support/adapterFixtures.js";
import { buildGovernorRegistry } from "../support/governorRegistry.js";

/** Every entry in a registry directory, as name -> exact bytes. */
function registryBytes(root: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const name of readdirSync(root).sort()) {
    entries.set(name, readFileSync(path.join(root, name), "utf8"));
  }
  return entries;
}

/**
 * A fixed randomness source, so two registries are comparable at all.
 *
 * The challenge chain draws real randomness for its journey commitments, so two
 * *unseeded* registries have never been byte-identical and are not made so by
 * anything here. `random` is the knob the builder already exposes for exactly
 * this, and pinning it is what turns "the external seam changed nothing" into a
 * statement a test can actually make.
 */
function seededRandom(): (size: number) => Buffer {
  let counter = 0;
  return (size: number) => Buffer.alloc(size, (counter++ % 251) + 1);
}

function external(adapterId: string, version = "0.1.0"): SubjectAdapterManifestV1 {
  return adapterManifest({
    adapterId,
    version,
    operations: ["acquire", "validate-package", "interact"],
    packageKinds: ["archive"],
  });
}

test("REGISTRY-EXTERNAL: a registry with no external manifest is unchanged, byte for byte", () => {
  const control = buildGovernorRegistry({ random: seededRandom() });
  const alsoControl = buildGovernorRegistry({ random: seededRandom() });

  assert.deepEqual(
    [...registryBytes(alsoControl.root).entries()],
    [...registryBytes(control.root).entries()],
    "two default registries must contain identical entries",
  );
  assert.deepEqual(control.externalAdapterHashes, {});

  // And every hash the rest of the suite depends on is still what it was.
  assert.equal(alsoControl.adapterManifestHash, control.adapterManifestHash);
  assert.equal(alsoControl.referenceCorrectAdapterHash, control.referenceCorrectAdapterHash);
  assert.equal(alsoControl.referenceLimitedAdapterHash, control.referenceLimitedAdapterHash);
  assert.equal(alsoControl.referenceOtelDemoAdapterHash, control.referenceOtelDemoAdapterHash);
  assert.equal(alsoControl.genericRunPolicyHash, control.genericRunPolicyHash);
  assert.equal(alsoControl.archetypeHash, control.archetypeHash);
});

test("REGISTRY-EXTERNAL: an external manifest is admitted, and adds exactly one entry", () => {
  const control = buildGovernorRegistry({ random: seededRandom() });
  const manifest = external("external-subject-one");
  const registry = buildGovernorRegistry({
    random: seededRandom(),
    externalAdapterManifests: [manifest],
  });

  assert.equal(registry.externalAdapterHashes["external-subject-one"], manifest.core_hash);

  const controlNames = [...registryBytes(control.root).keys()];
  const withExternal = registryBytes(registry.root);
  const added = [...withExternal.keys()].filter((name) => !controlNames.includes(name));
  assert.deepEqual(added, ["adapter-manifest-external-external-subject-one.json"]);

  // Every pre-existing entry is untouched.
  for (const [name, bytes] of registryBytes(control.root)) {
    assert.equal(withExternal.get(name), bytes, `entry ${name} changed`);
  }

  // The admitted bytes really are the manifest, resolvable by its core hash.
  const admitted = JSON.parse(
    withExternal.get("adapter-manifest-external-external-subject-one.json") as string,
  ) as SubjectAdapterManifestV1;
  assert.equal(admitted.core_hash, manifest.core_hash);
  assert.equal(admitted.adapter_id, "external-subject-one");
});

test("REGISTRY-EXTERNAL: several external manifests are each admitted under their own id", () => {
  const registry = buildGovernorRegistry({
    externalAdapterManifests: [external("external-subject-one"), external("external-subject-two")],
  });
  assert.deepEqual(Object.keys(registry.externalAdapterHashes).sort(), [
    "external-subject-one",
    "external-subject-two",
  ]);
});

test("REGISTRY-EXTERNAL: a duplicate adapter id is refused, not merged", () => {
  assert.throws(
    () =>
      buildGovernorRegistry({
        externalAdapterManifests: [external("external-subject-one"), external("external-subject-one", "0.2.0")],
      }),
    /supplied more than once/,
  );
});

test("REGISTRY-EXTERNAL: two identities over the same bytes are refused", () => {
  const manifest = external("external-subject-one");
  assert.throws(
    () => buildGovernorRegistry({ externalAdapterManifests: [manifest, manifest] }),
    /supplied more than once|share core hash/,
  );
});

test("REGISTRY-EXTERNAL: an id that collides with a built-in adapter is refused", () => {
  for (const builtIn of ["fake-subject", "reference-correct", "reference-limited", "reference-otel-demo"]) {
    assert.throws(
      () => buildGovernorRegistry({ externalAdapterManifests: [external(builtIn)] }),
      /collides with an adapter this registry already admits/,
      `${builtIn} must not be overwritable`,
    );
  }
});

test("REGISTRY-EXTERNAL: the contract itself refuses a malformed adapter id", () => {
  // The first line of defence, and the one that matters: a manifest built the
  // ordinary way cannot carry an id that is not an `Id`.
  for (const bad of ["../escape", "Has-Capitals", "trailing space", ""]) {
    assert.throws(
      () => external(bad),
      /adapter_id/,
      `${JSON.stringify(bad)} must be refused by the contract`,
    );
  }
});

test("REGISTRY-EXTERNAL: a hand-built manifest cannot smuggle a path into a registry entry name", () => {
  // Defence in depth for the case the contract cannot reach: a manifest that
  // arrived as plain data rather than through `adapterManifest`. The registry
  // writes `adapter-manifest-external-${adapter_id}.json`, so an id containing a
  // path separator would be a write outside the registry root.
  const smuggled = {
    ...external("external-subject-one"),
    adapter_id: "../../escape",
  } as unknown as SubjectAdapterManifestV1;

  assert.throws(
    () => buildGovernorRegistry({ externalAdapterManifests: [smuggled] }),
    /not a well-formed adapter id/,
  );
});
