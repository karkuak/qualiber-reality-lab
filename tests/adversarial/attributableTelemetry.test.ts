/**
 * The attributable-telemetry obligation (ADR-ERL2-033).
 *
 * Three surfaces, each with its own owner and its own negative control:
 *
 * 1. the shared *definitions* — `parseCollectorTelemetry` /
 *    `excerptCollectorTelemetry` — whose excerpt invariant is what lets the
 *    offline verifier recompute every count from retained bytes;
 * 2. the producer's `attributable-telemetry-retained` gate arithmetic, which
 *    binds to declaration and refuses a declared run whose retained
 *    observation is missing, not observed, not this run's, or unattributed;
 * 3. the verifier's `deriveAttributableTelemetry`, which re-derives the
 *    declaration predicate and every count from retained bytes and reads no
 *    producer verdict — the contract stores none.
 *
 * The verifier cases are applied to synthetic retained trees, deliberately:
 * a consistent lie — counts that disagree with the excerpt while every hash
 * still binds — cannot be reached by mutating a real bundle's bytes, because
 * the hash layer refuses first. The end-to-end wiring (a fake-driver run
 * declares nothing, passes the gate, and verifies offline) is asserted against
 * a real CLI run at the bottom.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  assertContract,
  CODES,
  type AttributableTelemetryObservationV1,
  type LabLifecycleEventV1,
} from "@erl2/contracts";
import { coreHash, hashBytes } from "@erl2/integrity";
import {
  attributableTelemetryDeclared,
  attributableTelemetryGatePassed,
  excerptCollectorTelemetry,
  parseCollectorTelemetry,
  supportsAttributableTelemetry,
} from "@erl2/core";
import { ArtifactIndex, deriveAttributableTelemetry } from "@erl2/public-verifier";
import { ownedTempDir } from "../support/tempDirs.js";
import { drive, selectedRun } from "../support/environmentCli.js";
import { verifyBundle } from "../support/cliRun.js";

const RUN_ID = "00000000-0000-7000-8000-000000000111";
const OTHER_RUN_ID = "00000000-0000-7000-8000-000000000222";

/** A collector log in the debug exporter's shape, with one marked record. */
function collectorLog(marker: string): string {
  return [
    "2026-08-03T00:00:00.000Z\tinfo\tservice@v0.0.1/service.go\tEverything is ready.",
    '2026-08-03T00:00:01.000Z\tinfo\tTraces\t{"otelcol.signal": "traces", "resource spans": 1, "spans": 3}',
    "     -> service.name: Str(quote)",
    `     -> url.full: Str(http://127.0.0.1:18090/getquote?erl2_run=${marker})`,
    "2026-08-03T00:00:02.000Z\tinfo\tsome unrelated collector chatter",
  ].join("\n");
}

// -- 1. the definitions ------------------------------------------------------

test("ATTR-TELEM: parsing the excerpt reproduces the counts of the full log", () => {
  for (const logs of [
    collectorLog(RUN_ID),
    "",
    "no telemetry at all",
    `${collectorLog(RUN_ID)}\n${collectorLog(RUN_ID)}`,
    `prefix ${RUN_ID} suffix ${RUN_ID} twice on one line`,
    '\tTraces\t{"spans": 7}\n     -> service.name: Str(other)',
  ]) {
    const full = parseCollectorTelemetry(logs, RUN_ID);
    const excerpt = excerptCollectorTelemetry(logs, RUN_ID);
    assert.deepEqual(parseCollectorTelemetry(excerpt, RUN_ID), full);
    // The excerpt is a fixed point: excerpting it again changes nothing.
    assert.equal(excerptCollectorTelemetry(excerpt, RUN_ID), excerpt);
  }
});

test("ATTR-TELEM: two markers on one line count as two run-attributed records", () => {
  const counts = parseCollectorTelemetry(`a ${RUN_ID} b ${RUN_ID} c`, RUN_ID);
  assert.equal(counts.runAttributedRecords, 2);
  assert.equal(parseCollectorTelemetry(collectorLog(RUN_ID), "").runAttributedRecords, 0);
});

test("ATTR-TELEM: service names are deduplicated and sorted", () => {
  const logs = "service.name: Str(zeta)\nservice.name: Str(alpha)\nservice.name: Str(zeta)";
  assert.deepEqual(parseCollectorTelemetry(logs, RUN_ID).serviceNames, ["alpha", "zeta"]);
});

// -- 2. the contract ---------------------------------------------------------

function observedRecord(
  mutate?: (base: Record<string, unknown>) => void,
): AttributableTelemetryObservationV1 {
  const excerpt = excerptCollectorTelemetry(collectorLog(RUN_ID), RUN_ID);
  const counts = parseCollectorTelemetry(excerpt, RUN_ID);
  const base: Record<string, unknown> = {
    schema_version: "attributable-telemetry-observation/v1",
    run_id: RUN_ID,
    marker: RUN_ID,
    evidence: "observed",
    observed_at: "2026-08-03T00:00:05Z",
    collector: {
      service_id: "otel-collector",
      container_name: `erl2-${RUN_ID}-otel-collector`,
      ownership_verified: true,
      image_id: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      observed_image_repo_digests: ["example/collector@sha256:bbbb"],
      image_matches_locked_digest: true,
    },
    trace_batches: counts.traceBatches,
    spans: counts.spans,
    service_names: counts.serviceNames,
    run_attributed_records: counts.runAttributedRecords,
    log_excerpt: excerpt,
  };
  mutate?.(base);
  return { ...base, core_hash: coreHash(base) } as AttributableTelemetryObservationV1;
}

test("ATTR-TELEM-CONTRACT: a valid observed record and a valid absent record both validate", () => {
  assertContract("AttributableTelemetryObservationV1", observedRecord());
  const absentBase = {
    schema_version: "attributable-telemetry-observation/v1",
    run_id: RUN_ID,
    marker: RUN_ID,
    evidence: "absent",
    observed_at: "2026-08-03T00:00:05Z",
    reason_code: "collector_not_verified",
  };
  assertContract("AttributableTelemetryObservationV1", {
    ...absentBase,
    core_hash: coreHash(absentBase),
  });
});

test("ATTR-TELEM-CONTRACT: an absent record cannot carry a count, an excerpt or a collector", () => {
  for (const smuggled of [
    { run_attributed_records: 1 },
    { trace_batches: 1 },
    { spans: 1 },
    { service_names: ["quote"] },
    { log_excerpt: "some collector line" },
  ]) {
    const base = {
      schema_version: "attributable-telemetry-observation/v1",
      run_id: RUN_ID,
      marker: RUN_ID,
      evidence: "absent",
      observed_at: "2026-08-03T00:00:05Z",
      reason_code: "collector_not_verified",
      ...smuggled,
    };
    assert.throws(
      () => assertContract("AttributableTelemetryObservationV1", { ...base, core_hash: coreHash(base) }),
      (error: { code?: string }) => error.code === CODES.SCHEMA_VALIDATION_FAILED,
    );
  }
});

test("ATTR-TELEM-CONTRACT: an observed record without its excerpt, or over an unverified collector, is unrepresentable", () => {
  for (const mutate of [
    (base: Record<string, unknown>): void => {
      delete base["log_excerpt"];
    },
    (base: Record<string, unknown>): void => {
      base["reason_code"] = "also_a_reason";
    },
    (base: Record<string, unknown>): void => {
      (base["collector"] as Record<string, unknown>)["ownership_verified"] = false;
    },
    (base: Record<string, unknown>): void => {
      (base["collector"] as Record<string, unknown>)["image_matches_locked_digest"] = false;
    },
  ]) {
    assert.throws(
      () => assertContract("AttributableTelemetryObservationV1", observedRecord(mutate)),
      (error: { code?: string }) => error.code === CODES.SCHEMA_VALIDATION_FAILED,
    );
  }
});

// -- 3. the producer gate ----------------------------------------------------

const DECLARING = {
  driverKind: "compose",
  evidenceSources: [{ source_id: "service-metric", kind: "metric", required: true }],
  outcomes: [{ intent: "exercise", status: "succeeded", run_id: RUN_ID }],
} as unknown as Parameters<typeof attributableTelemetryDeclared>[0];

test("ATTR-TELEM: the declaration predicate needs the driver, the source and the exercising step together", () => {
  assert.equal(attributableTelemetryDeclared(DECLARING), true);
  assert.equal(attributableTelemetryDeclared({ ...DECLARING, driverKind: "fake" }), false);
  assert.equal(
    attributableTelemetryDeclared({
      ...DECLARING,
      evidenceSources: [{ source_id: "deployment-log", kind: "deployment", required: true }],
    } as unknown as Parameters<typeof attributableTelemetryDeclared>[0]),
    false,
  );
  assert.equal(
    attributableTelemetryDeclared({
      ...DECLARING,
      outcomes: [{ intent: "exercise", status: "failed", run_id: RUN_ID }],
    } as unknown as Parameters<typeof attributableTelemetryDeclared>[0]),
    false,
  );
});

test("ATTR-TELEM: an undeclared run passes the gate with no observation at all", () => {
  assert.equal(
    attributableTelemetryGatePassed({ declared: false, runId: RUN_ID, observations: [] }),
    true,
  );
});

test("ATTR-TELEM: a declared run with no observation fails the gate", () => {
  assert.equal(
    attributableTelemetryGatePassed({ declared: true, runId: RUN_ID, observations: [] }),
    false,
  );
});

test("ATTR-TELEM: a declared run with an absent observation fails the gate", () => {
  const absentBase = {
    schema_version: "attributable-telemetry-observation/v1",
    run_id: RUN_ID,
    marker: RUN_ID,
    evidence: "absent",
    observed_at: "2026-08-03T00:00:05Z",
    reason_code: "collector_not_verified",
  };
  const absent = { ...absentBase, core_hash: coreHash(absentBase) } as AttributableTelemetryObservationV1;
  assert.equal(
    attributableTelemetryGatePassed({ declared: true, runId: RUN_ID, observations: [absent] }),
    false,
  );
});

test("ATTR-TELEM: a declared run with zero run-attributed records fails the gate", () => {
  const zero = observedRecord((base) => {
    base["run_attributed_records"] = 0;
  });
  assert.equal(
    attributableTelemetryGatePassed({ declared: true, runId: RUN_ID, observations: [zero] }),
    false,
  );
});

test("ATTR-TELEM: another run's observation, a foreign marker, or a second observation fails the gate", () => {
  const good = observedRecord();
  const foreignRun = observedRecord((base) => {
    base["run_id"] = OTHER_RUN_ID;
  });
  const foreignMarker = observedRecord((base) => {
    base["marker"] = OTHER_RUN_ID;
  });
  assert.equal(
    attributableTelemetryGatePassed({ declared: true, runId: RUN_ID, observations: [foreignRun] }),
    false,
  );
  assert.equal(
    attributableTelemetryGatePassed({ declared: true, runId: RUN_ID, observations: [foreignMarker] }),
    false,
  );
  assert.equal(
    attributableTelemetryGatePassed({ declared: true, runId: RUN_ID, observations: [good, good] }),
    false,
  );
  assert.equal(
    attributableTelemetryGatePassed({ declared: true, runId: RUN_ID, observations: [good] }),
    true,
  );
});

test("ATTR-TELEM: the fake driver does not offer the capability", () => {
  assert.equal(supportsAttributableTelemetry({}), false);
  assert.equal(supportsAttributableTelemetry(undefined), false);
  assert.equal(
    supportsAttributableTelemetry({ observeAttributableTelemetry: (): void => undefined }),
    true,
  );
});

// -- 4. the verifier derivation, over synthetic retained trees ---------------

interface SyntheticTree {
  readonly index: ArtifactIndex;
  readonly lifecycle: readonly LabLifecycleEventV1[];
}

interface SyntheticOptions {
  readonly driverKind?: string;
  readonly sourceKind?: string;
  readonly exerciseStatus?: string;
  readonly observation?: AttributableTelemetryObservationV1 | "none";
  /** A second observation produced under the same role, to test cardinality. */
  readonly secondObservation?: AttributableTelemetryObservationV1;
  readonly producedBy?: string;
  /** Extra driver manifests / archetypes produced, to test preconditions. */
  readonly duplicateManifest?: boolean;
  readonly duplicateArchetype?: boolean;
}

/** Writes a minimal retained tree the derivation can scan, and its lifecycle. */
function syntheticTree(options: SyntheticOptions = {}): SyntheticTree {
  const root = ownedTempDir("erl2-attr-telem-");
  const retained = path.join(root, "retained", "environment");
  mkdirSync(retained, { recursive: true });

  const write = (name: string, value: { readonly core_hash: string }): void => {
    writeFileSync(path.join(retained, name), `${JSON.stringify(value)}\n`);
  };

  const manifestBase = {
    schema_version: "environment-driver-manifest/v1",
    driver_id: "compose-driver",
    driver_kind: options.driverKind ?? "compose",
  };
  const manifest = { ...manifestBase, core_hash: coreHash(manifestBase) };
  write("driver-manifest.json", manifest);

  const archetypeBase = {
    schema_version: "environment-archetype/v1",
    evidence_sources: [
      { source_id: "service-metric", kind: options.sourceKind ?? "metric", required: true },
    ],
  };
  const archetype = { ...archetypeBase, core_hash: coreHash(archetypeBase) };
  write("archetype.json", archetype);

  const outcomeBase = {
    schema_version: "journey-step-outcome/v1",
    run_id: RUN_ID,
    intent: "exercise",
    status: options.exerciseStatus ?? "succeeded",
  };
  const outcome = { ...outcomeBase, core_hash: coreHash(outcomeBase) };
  write("step-outcome-exercise.json", outcome);

  const observation = options.observation === "none" ? undefined : options.observation ?? observedRecord();
  if (observation !== undefined) write("attributable-telemetry-observation.json", observation);
  if (options.secondObservation !== undefined) {
    write("attributable-telemetry-observation-2.json", options.secondObservation);
  }

  const event = (eventType: string, produced: readonly Record<string, string>[]): LabLifecycleEventV1 =>
    ({ event_type: eventType, produced }) as unknown as LabLifecycleEventV1;
  const lifecycle: LabLifecycleEventV1[] = [
    event("environment_provisioned", [
      {
        artifact_role: "environment-driver-manifest",
        artifact_core_hash: manifest.core_hash,
        artifact_schema_version: "environment-driver-manifest/v1",
      },
      ...(options.duplicateManifest === true
        ? [
            {
              artifact_role: "environment-driver-manifest",
              artifact_core_hash: manifest.core_hash,
              artifact_schema_version: "environment-driver-manifest/v1",
            },
          ]
        : []),
      {
        artifact_role: "environment-archetype",
        artifact_core_hash: archetype.core_hash,
        artifact_schema_version: "environment-archetype/v1",
      },
      ...(options.duplicateArchetype === true
        ? [
            {
              artifact_role: "environment-archetype",
              artifact_core_hash: archetype.core_hash,
              artifact_schema_version: "environment-archetype/v1",
            },
          ]
        : []),
    ]),
    event("subject_exercise_outcome_frozen", [
      {
        artifact_role: "journey-step-outcome",
        artifact_core_hash: outcome.core_hash,
        artifact_schema_version: "journey-step-outcome/v1",
      },
    ]),
    ...(observation === undefined
      ? []
      : [
          event(options.producedBy ?? "teardown_started", [
            {
              artifact_role: "attributable-telemetry-observation",
              artifact_core_hash: observation.core_hash,
              artifact_schema_version: "attributable-telemetry-observation/v1",
            },
            ...(options.secondObservation === undefined
              ? []
              : [
                  {
                    artifact_role: "attributable-telemetry-observation",
                    artifact_core_hash: options.secondObservation.core_hash,
                    artifact_schema_version: "attributable-telemetry-observation/v1",
                  },
                ]),
          ]),
        ]),
  ];

  return { index: ArtifactIndex.scan(root), lifecycle };
}

function refusalCode(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

test("ATTR-TELEM-VERIFY: a consistent declared observation derives observed and attributed", () => {
  const tree = syntheticTree();
  const report = deriveAttributableTelemetry({ ...tree, runId: RUN_ID });
  assert.deepEqual(report, { declared: true, observed: true, runAttributedRecords: 1 });
});

test("ATTR-TELEM-VERIFY: a declared run that retains no observation is refused", () => {
  const tree = syntheticTree({ observation: "none" });
  assert.equal(
    refusalCode(() => deriveAttributableTelemetry({ ...tree, runId: RUN_ID })),
    CODES.ENV_TELEMETRY_OBSERVATION_MISSING,
  );
});

test("ATTR-TELEM-VERIFY: an undeclared run with no observation derives nothing and refuses nothing", () => {
  for (const tree of [
    syntheticTree({ driverKind: "fake", observation: "none" }),
    syntheticTree({ sourceKind: "deployment", observation: "none" }),
    syntheticTree({ exerciseStatus: "failed", observation: "none" }),
  ]) {
    const report = deriveAttributableTelemetry({ ...tree, runId: RUN_ID });
    assert.deepEqual(report, { declared: false, observed: false, runAttributedRecords: 0 });
  }
});

test("ATTR-TELEM-VERIFY: an absent observation where declared is refused", () => {
  const absentBase = {
    schema_version: "attributable-telemetry-observation/v1",
    run_id: RUN_ID,
    marker: RUN_ID,
    evidence: "absent",
    observed_at: "2026-08-03T00:00:05Z",
    reason_code: "collector_not_verified",
  };
  const tree = syntheticTree({
    observation: { ...absentBase, core_hash: coreHash(absentBase) } as AttributableTelemetryObservationV1,
  });
  assert.equal(
    refusalCode(() => deriveAttributableTelemetry({ ...tree, runId: RUN_ID })),
    CODES.ENV_TELEMETRY_NOT_ATTRIBUTED,
  );
});

test("ATTR-TELEM-VERIFY: a declared observation with zero run-attributed records is refused", () => {
  const unmarked = excerptCollectorTelemetry(collectorLog(OTHER_RUN_ID), RUN_ID);
  const counts = parseCollectorTelemetry(unmarked, RUN_ID);
  const observation = observedRecord((base) => {
    base["trace_batches"] = counts.traceBatches;
    base["spans"] = counts.spans;
    base["service_names"] = counts.serviceNames;
    base["run_attributed_records"] = counts.runAttributedRecords;
    base["log_excerpt"] = unmarked;
  });
  assert.equal(counts.runAttributedRecords, 0);
  const tree = syntheticTree({ observation });
  assert.equal(
    refusalCode(() => deriveAttributableTelemetry({ ...tree, runId: RUN_ID })),
    CODES.ENV_TELEMETRY_NOT_ATTRIBUTED,
  );
});

test("ATTR-TELEM-VERIFY: counts that contradict the retained excerpt are refused", () => {
  const inflated = observedRecord((base) => {
    base["run_attributed_records"] = 5;
  });
  const tree = syntheticTree({ observation: inflated });
  assert.equal(
    refusalCode(() => deriveAttributableTelemetry({ ...tree, runId: RUN_ID })),
    CODES.ENV_TELEMETRY_OBSERVATION_MISMATCH,
  );
});

test("ATTR-TELEM-VERIFY: an excerpt padded with non-contributing lines is refused", () => {
  const excerpt = excerptCollectorTelemetry(collectorLog(RUN_ID), RUN_ID);
  const observation = observedRecord((base) => {
    base["log_excerpt"] = `${excerpt}\nan idle line that contributes to no count`;
  });
  const tree = syntheticTree({ observation });
  assert.equal(
    refusalCode(() => deriveAttributableTelemetry({ ...tree, runId: RUN_ID })),
    CODES.ENV_TELEMETRY_OBSERVATION_MISMATCH,
  );
});

test("ATTR-TELEM-VERIFY: another run's observation, a foreign marker, or a wrong producing event is refused", () => {
  const foreignRun = observedRecord((base) => {
    base["run_id"] = OTHER_RUN_ID;
  });
  assert.equal(
    refusalCode(() =>
      deriveAttributableTelemetry({ ...syntheticTree({ observation: foreignRun }), runId: RUN_ID }),
    ),
    CODES.ENV_TELEMETRY_OBSERVATION_MISMATCH,
  );

  const foreignMarker = observedRecord((base) => {
    base["marker"] = OTHER_RUN_ID;
  });
  assert.equal(
    refusalCode(() =>
      deriveAttributableTelemetry({
        ...syntheticTree({ observation: foreignMarker }),
        runId: RUN_ID,
      }),
    ),
    CODES.ENV_TELEMETRY_OBSERVATION_MISMATCH,
  );

  assert.equal(
    refusalCode(() =>
      deriveAttributableTelemetry({
        ...syntheticTree({ producedBy: "environment_restored" }),
        runId: RUN_ID,
      }),
    ),
    CODES.ENV_TELEMETRY_OBSERVATION_MISMATCH,
  );
});

test("ATTR-TELEM-VERIFY: a second retained observation is refused rather than silently ignored", () => {
  const second = observedRecord((base) => {
    base["run_attributed_records"] = 99;
    base["observed_at"] = "2026-08-03T00:00:09Z";
  });
  const tree = syntheticTree({ secondObservation: second });
  assert.equal(
    refusalCode(() => deriveAttributableTelemetry({ ...tree, runId: RUN_ID })),
    CODES.ENV_TELEMETRY_OBSERVATION_MISMATCH,
  );
});

test("ATTR-TELEM-VERIFY: an ambiguous driver manifest or archetype is refused before anything is derived", () => {
  for (const options of [{ duplicateManifest: true }, { duplicateArchetype: true }]) {
    assert.equal(
      refusalCode(() =>
        deriveAttributableTelemetry({ ...syntheticTree(options), runId: RUN_ID }),
      ),
      CODES.ENV_SUBSTRATE_BINDING_MISMATCH,
    );
  }
});

test("ATTR-TELEM-VERIFY: an observed record whose excerpt the index never validated is still refused", () => {
  // ArtifactIndex.typed checks the schema_version string and the recomputed
  // core hash and nothing else, so a record the contract would refuse still
  // reaches the derivation. The defensive branch is not dead code.
  const noExcerpt = observedRecord((base) => {
    delete base["log_excerpt"];
  });
  const tree = syntheticTree({ observation: noExcerpt });
  assert.equal(
    refusalCode(() => deriveAttributableTelemetry({ ...tree, runId: RUN_ID })),
    CODES.ENV_TELEMETRY_OBSERVATION_MISMATCH,
  );
});

// -- 5. end to end: the fake-driver path is untouched ------------------------

test("ATTR-TELEM-E2E: a fake-driver run declares nothing, retains nothing, and still verifies offline", () => {
  const run = selectedRun();
  assert.equal(drive(run), "generic_finalized");

  // No observation was produced, and the validity gate is present and passing.
  const validity = JSON.parse(
    readFileSync(path.join(run.runRoot, "retained", "validity-result.json"), "utf8"),
  ) as {
    readonly gate_results: readonly { readonly gate_id: string; readonly passed: boolean }[];
  };
  const gate = validity.gate_results.find((g) => g.gate_id === "attributable-telemetry-retained");
  assert.ok(gate, "the attributable-telemetry-retained gate is evaluated on every environment terminal");
  assert.equal(gate?.passed, true);
  assert.equal(
    existsSync(
      path.join(run.runRoot, "retained", "environment", "attributable-telemetry-observation.json"),
    ),
    false,
    "a fake-driver run must not retain a telemetry observation",
  );

  const verified = verifyBundle(run.runRoot, {
    sourceTrustPolicyHash: run.registry.sourceTrustPolicyHash,
  });
  assert.equal(verified.exitCode, 0, JSON.stringify(verified.body.errors));
});
