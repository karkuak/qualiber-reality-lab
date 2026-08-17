/**
 * What the trusted-local path will and will not admit.
 *
 * Every case here attacks the authority itself rather than the execution: a
 * missing acknowledgement, an altered one, bytes that changed after the
 * operator accepted them, a claim the path cannot support, and a certification
 * receipt offered where a declaration belongs. The run either happens under the
 * exact terms the operator wrote, or it does not happen.
 */

import { strict as assert } from "node:assert";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { CODES, Erl2Error, type SubjectAdapterManifestV2 } from "@erl2/contracts";
import { ArtifactStore, coreHash, hashBytes } from "@erl2/integrity";
import {
  AdapterHost,
  SystemClock,
  TRUSTED_LOCAL_ACKNOWLEDGEMENT_TOKEN,
  retainTrustedLocalAdapterV2,
  verifyTrustedLocalAdapterDeclaration,
} from "@erl2/core";
import { ownedTempDir } from "../support/tempDirs.js";
import { localManifest, localReceipt, ARCHIVE_SHAPE } from "../support/localObservationFixtures.js";
import {
  ELEVEN_OPERATION_CLEAN_PLAN,
  json,
  reseal,
  trustedLocalDeclaration,
  trustedLocalEntry,
  trustedLocalManifest,
  trustedLocalPlan,
  writeTrustedLocalInputs,
} from "../support/trustedLocalFixtures.js";

function refusal(fn: () => unknown): Erl2Error {
  try {
    fn();
  } catch (cause) {
    if (cause instanceof Erl2Error) return cause;
    throw cause;
  }
  throw new Error("expected a typed refusal");
}

function admit(
  declarationMutation: (declaration: Record<string, unknown>) => Record<string, unknown> = (d) => d,
  manifestOverride?: SubjectAdapterManifestV2,
): ReturnType<typeof verifyTrustedLocalAdapterDeclaration> {
  const manifest = manifestOverride ?? trustedLocalManifest();
  const manifestBytes = json(manifest);
  const declaration = trustedLocalDeclaration(manifest, manifestBytes);
  const mutated = declarationMutation({ ...(declaration as unknown as Record<string, unknown>) });
  return verifyTrustedLocalAdapterDeclaration({
    manifest,
    declaration: mutated as never,
    entryDigest: hashBytes(readFileSync(trustedLocalEntry())),
    manifestFileHash: hashBytes(manifestBytes),
  });
}

test("TRUSTED-LOCAL-ADMIT: an explicit owner declaration is admitted, and says what it is not", () => {
  const admission = admit();
  assert.equal(admission.trustMode, "trusted_local_code");
  assert.equal(admission.tier, "development");
  assert.equal(admission.authenticity, "owner_asserted_unauthenticated");
  assert.equal(admission.independentCertification, "absent");
  assert.equal(admission.confinement, "absent");
  // The host's own report travels with the admission, unsupported entries
  // included; a confinement claim would need those entries removed.
  assert.ok(
    admission.hostControlReport.some((control) => control.state === "unsupported_on_this_host"),
    "the retained control report must keep what this host cannot enforce",
  );
});

test("TRUSTED-LOCAL-ADMIT: a missing acknowledgement is refused", () => {
  const error = refusal(() =>
    admit((declaration) => {
      const copy = { ...declaration };
      delete copy["operator_acknowledgement"];
      return reseal(copy as never) as unknown as Record<string, unknown>;
    }),
  );
  assert.equal(error.code, CODES.SCHEMA_VALIDATION_FAILED);
});

test("TRUSTED-LOCAL-ADMIT: an altered acknowledgement token is refused", () => {
  const error = refusal(() =>
    admit((declaration) =>
      reseal({
        ...declaration,
        operator_acknowledgement: {
          ...(declaration["operator_acknowledgement"] as Record<string, unknown>),
          acknowledgement_token: `${TRUSTED_LOCAL_ACKNOWLEDGEMENT_TOKEN} (probably)`,
        },
      } as never) as unknown as Record<string, unknown>,
    ),
  );
  // The schema pins the token as a constant, so the contract refuses first;
  // the runtime re-check exists for the path a control can reach.
  assert.equal(error.code, CODES.SCHEMA_VALIDATION_FAILED);
});

test("TRUSTED-LOCAL-ADMIT: an acknowledgement of different bytes is refused", () => {
  const error = refusal(() =>
    admit((declaration) =>
      reseal({
        ...declaration,
        operator_acknowledgement: {
          ...(declaration["operator_acknowledgement"] as Record<string, unknown>),
          acknowledged_artifact_hash: `sha256:${"b".repeat(64)}`,
        },
      } as never) as unknown as Record<string, unknown>,
    ),
  );
  assert.equal(error.code, CODES.ADAPTER_TRUSTED_LOCAL_ACKNOWLEDGEMENT_INVALID);
});

test("TRUSTED-LOCAL-ADMIT: an artifact digest mismatch is refused", () => {
  const error = refusal(() =>
    admit((declaration) =>
      reseal({
        ...declaration,
        adapter_artifact_hash: `sha256:${"c".repeat(64)}`,
        operator_acknowledgement: {
          ...(declaration["operator_acknowledgement"] as Record<string, unknown>),
          acknowledged_artifact_hash: `sha256:${"c".repeat(64)}`,
        },
      } as never) as unknown as Record<string, unknown>,
    ),
  );
  assert.equal(error.code, CODES.ADAPTER_IDENTITY_MISMATCH);
});

test("TRUSTED-LOCAL-ADMIT: a manifest binding mismatch is refused", () => {
  const error = refusal(() =>
    admit((declaration) =>
      reseal({
        ...declaration,
        adapter_manifest_core_hash: `sha256:${"d".repeat(64)}`,
        operator_acknowledgement: {
          ...(declaration["operator_acknowledgement"] as Record<string, unknown>),
          acknowledged_manifest_core_hash: `sha256:${"d".repeat(64)}`,
        },
      } as never) as unknown as Record<string, unknown>,
    ),
  );
  assert.equal(error.code, CODES.ADAPTER_TRUSTED_LOCAL_BINDING_MISMATCH);
});

test("TRUSTED-LOCAL-ADMIT: manifest file bytes that changed after acceptance are refused", () => {
  const manifest = trustedLocalManifest();
  const manifestBytes = json(manifest);
  const declaration = trustedLocalDeclaration(manifest, manifestBytes);
  const error = refusal(() =>
    verifyTrustedLocalAdapterDeclaration({
      manifest,
      declaration,
      entryDigest: hashBytes(readFileSync(trustedLocalEntry())),
      // Same object, different bytes: whitespace is enough.
      manifestFileHash: hashBytes(Buffer.from(JSON.stringify(manifest), "utf8")),
    }),
  );
  assert.equal(error.code, CODES.ADAPTER_TRUSTED_LOCAL_BINDING_MISMATCH);
});

test("TRUSTED-LOCAL-ADMIT: artifact bytes changed before host construction are refused", () => {
  const root = ownedTempDir("erl2-tlo-swap-");
  const inputs = writeTrustedLocalInputs(root, ELEVEN_OPERATION_CLEAN_PLAN);
  const registryRoot = path.join(root, "registry");
  retainTrustedLocalAdapterV2({
    registryRoot,
    manifestBytes: readFileSync(inputs.manifestPath),
    declarationBytes: readFileSync(inputs.declarationPath),
    adapterEntryPath: inputs.entryPath,
  });
  // A copy of the entry, then a byte changed in the copy: the digest the
  // operator accepted no longer describes what would execute.
  const swapped = path.join(root, "swapped-entry.mjs");
  copyFileSync(inputs.entryPath, swapped);
  writeFileSync(swapped, `${readFileSync(swapped, "utf8")}\n// changed after acceptance\n`);
  const error = refusal(() =>
    new AdapterHost({
      runId: inputs.plan.observation_id,
      adapterManifest: inputs.manifest,
      localAuthorityV2: { mode: "trusted_local_code", declaration: inputs.declaration },
      localObservationPlan: inputs.plan,
      adapterEntryPath: swapped,
      workspaceRoot: path.join(root, "ws"),
      store: new ArtifactStore(path.join(root, "store")),
      clock: new SystemClock(),
    }),
  );
  assert.equal(error.code, CODES.ADAPTER_IDENTITY_MISMATCH);
});

test("TRUSTED-LOCAL-ADMIT: artifact bytes changed between dispatches are refused", () => {
  const root = ownedTempDir("erl2-tlo-swap2-");
  const inputs = writeTrustedLocalInputs(root, ELEVEN_OPERATION_CLEAN_PLAN);
  const entryCopy = path.join(root, "entry.mjs");
  copyFileSync(inputs.entryPath, entryCopy);
  const host = new AdapterHost({
    runId: inputs.plan.observation_id,
    adapterManifest: inputs.manifest,
    localAuthorityV2: { mode: "trusted_local_code", declaration: inputs.declaration },
    localObservationPlan: inputs.plan,
    adapterEntryPath: entryCopy,
    workspaceRoot: path.join(root, "ws"),
    store: new ArtifactStore(path.join(root, "store")),
    clock: new SystemClock(),
  });
  writeFileSync(entryCopy, `${readFileSync(entryCopy, "utf8")}\n// changed between dispatches\n`);
  const error = refusal(() =>
    host.run({
      operation: "acquire",
      operationId: "op-acquire",
      request: { schema_version: "adapter-request/v2" } as never,
      executionMode: "local_observation",
    }),
  );
  assert.equal(error.code, CODES.ADAPTER_IDENTITY_MISMATCH);
});

test("TRUSTED-LOCAL-ADMIT: a governed execution mode is refused", () => {
  const manifest = trustedLocalManifest();
  const governed = reseal({
    ...(manifest as unknown as Record<string, unknown>),
    protocol_support: [
      {
        protocol_version: "subject-adapter/v1",
        execution_modes: ["governed"],
        operations: ["acquire"],
        supported_package_kinds: ["archive"],
        required_controls: ["separate-process"],
      },
    ],
  } as never) as unknown as SubjectAdapterManifestV2;
  const error = refusal(() => admit((d) => d, governed));
  // The declaration binds a manifest hash, so a rebuilt manifest breaks the
  // binding before the mode question is reached; either refusal is a refusal
  // of governed execution, and the code names which gate caught it.
  assert.ok(
    [
      CODES.ADAPTER_TRUSTED_LOCAL_BINDING_MISMATCH,
      CODES.ADAPTER_EXECUTION_MODE_UNSUPPORTED,
      CODES.SCHEMA_VALIDATION_FAILED,
    ].includes(error.code as never),
    `unexpected code ${error.code}`,
  );
});

test("TRUSTED-LOCAL-ADMIT: a scored, authenticated or governor-authorized claim is refused", () => {
  for (const [field, value] of [
    ["not_scored", false],
    ["not_governor_authorized", false],
    ["not_independently_certified", false],
    ["not_confined", false],
    ["not_production_ready", false],
    ["evidence_authenticity", "authenticated"],
    ["certifier_is_adapter_owner", false],
  ] as const) {
    const error = refusal(() =>
      admit(
        (declaration) =>
          reseal({ ...declaration, [field]: value } as never) as unknown as Record<string, unknown>,
      ),
    );
    assert.equal(
      error.code,
      CODES.SCHEMA_VALIDATION_FAILED,
      `${field} must be unrepresentable, not merely refused at runtime`,
    );
  }
});

test("TRUSTED-LOCAL-ADMIT: a weakened claim ceiling is refused", () => {
  const error = refusal(() =>
    admit(
      (declaration) =>
        reseal({
          ...declaration,
          excluded_claims: ["score", "qualification", "governor_authorization", "reveal", "judge_evaluation", "reveal"],
        } as never) as unknown as Record<string, unknown>,
    ),
  );
  assert.equal(error.code, CODES.SCHEMA_VALIDATION_FAILED);
});

test("TRUSTED-LOCAL-ADMIT: a V1 manifest cannot fall back into this path", () => {
  const manifest = trustedLocalManifest();
  const declaration = trustedLocalDeclaration(manifest, json(manifest));
  // A genuine V1 manifest: the fallback this refuses is "the adapter has an
  // older manifest, run it anyway", not "the object was malformed".
  const v1 = {
    ...(manifest as unknown as Record<string, unknown>),
    schema_version: "subject-adapter-manifest/v1",
  } as unknown as SubjectAdapterManifestV2;
  const error = refusal(() =>
    verifyTrustedLocalAdapterDeclaration({
      manifest: v1,
      declaration,
      entryDigest: hashBytes(readFileSync(trustedLocalEntry())),
    }),
  );
  assert.equal(error.code, CODES.ADAPTER_EXECUTION_MODE_UNSUPPORTED);
});

test("TRUSTED-LOCAL-ADMIT: a certification receipt does not substitute for a declaration", () => {
  const receiptManifest = localManifest(ARCHIVE_SHAPE);
  const receipt = localReceipt(receiptManifest, ARCHIVE_SHAPE);
  const error = refusal(() =>
    verifyTrustedLocalAdapterDeclaration({
      manifest: trustedLocalManifest(),
      declaration: receipt as never,
      entryDigest: hashBytes(readFileSync(trustedLocalEntry())),
    }),
  );
  assert.equal(error.code, CODES.ADAPTER_TRUSTED_LOCAL_DECLARATION_REQUIRED);
  assert.match(error.message, /subject-adapter-certification-receipt\/v2/);
});

test("TRUSTED-LOCAL-ADMIT: the host retains which authority admitted the adapter", () => {
  const root = ownedTempDir("erl2-tlo-authority-");
  const inputs = writeTrustedLocalInputs(root, ELEVEN_OPERATION_CLEAN_PLAN);
  const host = new AdapterHost({
    runId: inputs.plan.observation_id,
    adapterManifest: inputs.manifest,
    localAuthorityV2: { mode: "trusted_local_code", declaration: inputs.declaration },
    localObservationPlan: inputs.plan,
    adapterEntryPath: inputs.entryPath,
    workspaceRoot: path.join(root, "ws"),
    store: new ArtifactStore(path.join(root, "store")),
    clock: new SystemClock(),
  });
  assert.equal(host.localAuthorityModeV2, "trusted_local_code");
});

test("TRUSTED-LOCAL-ADMIT: a plan bound to another declaration is refused", () => {
  const root = ownedTempDir("erl2-tlo-planbind-");
  const inputs = writeTrustedLocalInputs(root, ELEVEN_OPERATION_CLEAN_PLAN);
  const otherDeclaration = trustedLocalDeclaration(
    inputs.manifest,
    readFileSync(inputs.manifestPath),
    { declaration_id: "a-different-declaration" },
  );
  const otherPlan = trustedLocalPlan(
    inputs.manifest,
    otherDeclaration,
    ELEVEN_OPERATION_CLEAN_PLAN,
  );
  assert.notEqual(otherPlan.trusted_local_declaration_hash, inputs.plan.trusted_local_declaration_hash);
  const error = refusal(() =>
    new AdapterHost({
      runId: otherPlan.observation_id,
      adapterManifest: inputs.manifest,
      localAuthorityV2: { mode: "trusted_local_code", declaration: inputs.declaration },
      localObservationPlan: otherPlan,
      adapterEntryPath: inputs.entryPath,
      workspaceRoot: path.join(root, "ws"),
      store: new ArtifactStore(path.join(root, "store")),
      clock: new SystemClock(),
    }),
  );
  assert.equal(error.code, CODES.ADAPTER_TRUSTED_LOCAL_BINDING_MISMATCH);
});

test("TRUSTED-LOCAL-ADMIT: a certified plan cannot run under a trusted-local declaration", () => {
  const root = ownedTempDir("erl2-tlo-crossplan-");
  const inputs = writeTrustedLocalInputs(root, ELEVEN_OPERATION_CLEAN_PLAN);
  // A plan with the certification field instead of the declaration field: the
  // union makes these two different documents, and the host must not accept
  // the other arm's plan under this arm's authority.
  const certifiedShaped = { ...(inputs.plan as unknown as Record<string, unknown>) };
  delete certifiedShaped["trusted_local_declaration_hash"];
  delete certifiedShaped["trust_mode"];
  certifiedShaped["certification_receipt_hash"] = `sha256:${"e".repeat(64)}`;
  certifiedShaped["certification_authenticity"] = "locally_observed_unauthenticated";
  delete certifiedShaped["core_hash"];
  const resealed = { ...certifiedShaped, core_hash: coreHash(certifiedShaped) };
  const error = refusal(() =>
    new AdapterHost({
      runId: inputs.plan.observation_id,
      adapterManifest: inputs.manifest,
      localAuthorityV2: { mode: "trusted_local_code", declaration: inputs.declaration },
      localObservationPlan: resealed as never,
      adapterEntryPath: inputs.entryPath,
      workspaceRoot: path.join(root, "ws"),
      store: new ArtifactStore(path.join(root, "store")),
      clock: new SystemClock(),
    }),
  );
  assert.equal(error.code, CODES.ADAPTER_TRUSTED_LOCAL_BINDING_MISMATCH);
});
