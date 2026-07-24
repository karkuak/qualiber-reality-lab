import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from "node:crypto";

const ed25519PrivateKey = (label) => createPrivateKey({
  key: Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    createHash("sha256").update(`erl-fixture-key:${label}`).digest(),
  ]),
  format: "der",
  type: "pkcs8",
});
const signerKeys = Object.fromEntries(["root", "timestamp", "operations", "supervisor", "controller", "auditor", "finalizer"].map((role) => {
  const privateKey = ed25519PrivateKey(role);
  return [role, {
    keyId: `erl-fixture-${role}-ed25519-1`,
    privateKey,
    publicKey: createPublicKey(privateKey),
  }];
}));

function jcs(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(jcs).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${jcs(value[key])}`).join(",")}}`;
}

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function coreOf(value) {
  const core = structuredClone(value);
  delete core.core_hash;
  delete core.signature;
  delete core.root_signature;
  if (core.schema_version === "evaluation-report/v1") delete core.recorded_at;
  return core;
}

function seal(value) {
  const result = structuredClone(value);
  result.core_hash = sha256(Buffer.from(jcs(coreOf(result)), "utf8"));
  return result;
}

function sealSigned(value, signerRole = "operations") {
  const result = seal(value);
  const signerKey = signerKeys[signerRole];
  const message = Buffer.from(`ERL-SIGN-V1\n${result.core_hash}`, "ascii");
  result.signature = {
    algorithm: "Ed25519",
    key_id: signerKey.keyId,
    signed_hash: result.core_hash,
    signature_base64: sign(null, message, signerKey.privateKey).toString("base64"),
  };
  return result;
}

function sealRootSigned(value) {
  const result = seal(value);
  const message = Buffer.from(`ERL-SIGN-V1\n${result.core_hash}`, "ascii");
  result.root_signature = {
    algorithm: "Ed25519",
    key_id: signerKeys.root.keyId,
    signed_hash: result.core_hash,
    signature_base64: sign(null, message, signerKeys.root.privateKey).toString("base64"),
  };
  return result;
}

const fileBytes = (value) => Buffer.from(`${jcs(value)}\n`, "utf8");
const artifactRef = (path, mediaType, bytes, classification = "INTERNAL") => ({
  path,
  media_type: mediaType,
  byte_length: bytes.length,
  file_sha256: sha256(bytes),
  classification,
});
const treeHash = (entries) => sha256(Buffer.from(jcs([...entries].sort((a, b) => Buffer.from(a.path).compare(Buffer.from(b.path)))), "utf8"));
const runId = "019b0000-0000-7000-8000-000000000001";

const dependency = (dependencyId, kind) => seal({
  schema_version: "fixture-dependency/v1",
  dependency_id: dependencyId,
  kind,
});
const redactionPolicy = dependency("redaction-policy", "policy");
const capability = dependency("otel-demo-capability", "capability");
const qualiberRelease = dependency("qualiber-0.4.2", "released-artifact");
const qualiberConfig = dependency("qualiber-fixture-config", "configuration");
const substrate = dependency("otel-demo-2.2.0", "substrate");
const baseline = dependency("clean-baseline", "health-baseline");
const postRestoreBaseline = dependency("post-restore-baseline", "health-baseline");
const cutoffPolicy = sealSigned({
  schema_version: "cutoff-policy/v1",
  policy_id: "fixture-cutoff",
  version: 1,
  clock: "host_utc",
  instant_rule: "traffic_process_started_at_plus_warmup_ms_plus_observation_ms",
  inclusion: "event_time_lt_and_ingestion_time_lte",
  max_skew_ms: 2000,
  late_arrival_grace_ms: 30000,
  maximum_selection_to_traffic_start_ms: 1800000,
  maximum_timestamp_submission_delay_ms: 5000,
  maximum_process_milestone_skew_ms: 1000,
  maximum_monotonic_wall_divergence_ms: 250,
  maximum_warmup_ms: 300000,
  maximum_observation_ms: 720000,
  minimum_observation_ms: 60000,
  event_time_required: true,
  ingestion_time_required: true,
  valid_from: "2026-07-01T00:00:00Z",
  valid_until: "2027-07-01T00:00:00Z",
});

const environmentProfile = seal({
  schema_version: "environment-profile/v1",
  profile_id: "fixture-otel",
  driver: "docker_compose",
  substrate: {
    project: "opentelemetry-demo",
    release: "2.2.0",
    commit: "b74a7bc7bbe66099c61951f42b24dab8b6f02d18",
    source_archive_sha256: "sha256:66ca407246d20595f4d6f4c7b922d274d915674cca5ec0ec07b4fa6eb5109bbe",
    license: "Apache-2.0",
  },
  symbolic_roots: { workspace_root: "${ERL_WORKSPACE}", run_root: "${ERL_RUN_ROOT}", cache_root: "${ERL_CACHE_ROOT}" },
  compose_files: ["environments/otel-demo/compose.yaml"],
  image_lock_path: "environments/otel-demo/images.lock.json",
  required_services: ["checkout", "flagd", "frontend"],
  optional_services: [],
  loopback_ports: [{ name: "frontend", container_port: 8080, protocol: "tcp" }],
  resources: { cpu_millis: 4000, memory_mib: 4096, disk_mib: 8192 },
  timeouts: { provision_ms: 900000, health_ms: 300000, destroy_ms: 300000 },
  capabilities: ["otel-demo"],
  overlay_classifications: ["evidence_export_only", "fault_control_only"],
});

const publicPem = (role) => signerKeys[role].publicKey.export({ format: "pem", type: "spki" });
const trustPolicy = sealRootSigned({
  schema_version: "trust-policy-manifest/v1",
  manifest_id: "fixture-trust-policy",
  version: 1,
  issued_at: "2026-07-01T00:00:00Z",
  keys: [
    {
      key_id: signerKeys.root.keyId,
      public_key_pem: publicPem("root"),
      signer_roles: ["trust_root"],
      permitted_contract_types: ["trust-policy-manifest/v1"],
      permitted_encryption_recipient_ids: [],
      valid_from: "2026-07-01T00:00:00Z",
      valid_until: "2027-07-01T00:00:00Z",
      status: "active",
      environment_profile_hashes: ["*"],
      tiers: ["development", "held_out", "blind"],
    },
    {
      key_id: signerKeys.timestamp.keyId,
      public_key_pem: publicPem("timestamp"),
      signer_roles: ["timestamp_authority"],
      permitted_contract_types: ["trusted-timestamp-checkpoint/v1"],
      permitted_encryption_recipient_ids: [],
      valid_from: "2026-07-01T00:00:00Z",
      valid_until: "2027-07-01T00:00:00Z",
      status: "active",
      environment_profile_hashes: ["*"],
      tiers: ["development", "held_out", "blind"],
    },
    {
      key_id: signerKeys.operations.keyId,
      public_key_pem: publicPem("operations"),
      signer_roles: ["policy_author", "preregistrar", "corpus_governor", "selector", "truth_custodian", "vault_authorizer", "runtime_attestor", "reveal_service"],
      permitted_contract_types: [
        "activation-capsule-envelope/v1", "activation-capsule/v1", "claim-vocabulary/v1", "cutoff-policy/v1", "eligibility-pool-manifest/v1",
        "evaluation-policy/v1", "evidence-policy/v1", "exposure-event/v1", "selection-commitment/v1", "selection-proof/v1",
        "runtime-milestone/v1", "selection-request/v1", "truth-commitment/v1", "truth-reveal-record/v1",
      ],
      permitted_encryption_recipient_ids: [],
      valid_from: "2026-07-01T00:00:00Z",
      valid_until: "2027-07-01T00:00:00Z",
      status: "active",
      environment_profile_hashes: [environmentProfile.core_hash],
      tiers: ["development", "held_out", "blind"],
    },
    {
      key_id: signerKeys.supervisor.keyId,
      public_key_pem: publicPem("supervisor"),
      signer_roles: ["traffic_supervisor"],
      permitted_contract_types: ["traffic-process-start-receipt/v1"],
      permitted_encryption_recipient_ids: [],
      valid_from: "2026-07-01T00:00:00Z",
      valid_until: "2027-07-01T00:00:00Z",
      status: "active",
      environment_profile_hashes: [environmentProfile.core_hash],
      tiers: ["development", "held_out", "blind"],
    },
    {
      key_id: signerKeys.controller.keyId,
      public_key_pem: publicPem("controller"),
      signer_roles: ["controller"],
      permitted_contract_types: ["controller-execution-receipt/v1", "controller-restoration-receipt/v1"],
      permitted_encryption_recipient_ids: ["fixture-controller-key-1"],
      valid_from: "2026-07-01T00:00:00Z",
      valid_until: "2027-07-01T00:00:00Z",
      status: "active",
      environment_profile_hashes: [environmentProfile.core_hash],
      tiers: ["development", "held_out", "blind"],
    },
    {
      key_id: signerKeys.auditor.keyId,
      public_key_pem: publicPem("auditor"),
      signer_roles: ["confidential_selection_auditor"],
      permitted_contract_types: ["product-safe-signer-inventory/v1", "selection-verification-receipt/v1"],
      permitted_encryption_recipient_ids: [],
      valid_from: "2026-07-01T00:00:00Z",
      valid_until: "2027-07-01T00:00:00Z",
      status: "active",
      environment_profile_hashes: [environmentProfile.core_hash],
      tiers: ["held_out", "blind"],
    },
    {
      key_id: signerKeys.finalizer.keyId,
      public_key_pem: publicPem("finalizer"),
      signer_roles: ["final_attestation_signer"],
      permitted_contract_types: ["final-run-attestation/v1"],
      permitted_encryption_recipient_ids: [],
      valid_from: "2026-07-01T00:00:00Z",
      valid_until: "2027-07-01T00:00:00Z",
      status: "active",
      environment_profile_hashes: [environmentProfile.core_hash],
      tiers: ["held_out", "blind"],
    },
  ],
  revocations: [],
  root_key_id: signerKeys.root.keyId,
});
const verificationTrustHead = sealRootSigned({
  schema_version: "trust-policy-manifest/v1",
  manifest_id: "fixture-trust-policy-head",
  version: 2,
  issued_at: "2026-08-02T00:00:00Z",
  keys: trustPolicy.keys,
  revocations: [{
    revocation_id: "revoke-finalizer-prospectively",
    key_id: signerKeys.finalizer.keyId,
    scope: "prospective",
    announced_at: "2026-08-02T00:00:00Z",
    effective_at: "2026-08-03T00:00:00Z",
    reason_code: "fixture_rotation",
  }],
  prior_manifest_hash: trustPolicy.core_hash,
  root_key_id: signerKeys.root.keyId,
});

const healthContract = seal({
  schema_version: "health-contract/v1",
  contract_id: "fixture-health",
  environment_profile_hash: environmentProfile.core_hash,
  probes: [{
    probe_id: "frontend-ready",
    phase: "readiness",
    target_service: "frontend",
    kind: "http",
    endpoint_ref: "frontend-health",
    expected_status: 200,
    assertion: "status=200",
    interval_ms: 1000,
    timeout_ms: 5000,
    attempts: 3,
    required: true,
  }],
  minimum_journeys: [{ journey_id: "checkout", attempts: 10, success_min: 9 }],
});

const evidencePolicy = sealSigned({
  schema_version: "evidence-policy/v1",
  policy_id: "fixture-evidence",
  version: 1,
  source_rules: [{
    source_type: "trace",
    source_schema: "otel-span/v1",
    allowed_fields: ["end_time", "service.name", "span_id", "start_time", "trace_id"],
    solver_visible: true,
    controller_owned: false,
    maximum_records: 50000,
    maximum_bytes: 104857600,
    permitted_states: ["complete", "healthy_empty", "partial", "unavailable", "error"],
  }],
  cutoff_rule: "event_time_lt_and_ingestion_time_lte",
  health_projection_version: "1.0.0",
  redaction_policy_hash: redactionPolicy.core_hash,
  unsupported_class_rule: "explicit_sorted_set",
  controller_key_exclusion: "all_active_capsule_keys",
});

const vocabulary = sealSigned({
  schema_version: "claim-vocabulary/v1",
  vocabulary_id: "fixture-claims",
  version: 1,
  entity_kinds: ["run"],
  value_types: ["boolean"],
  predicates: [{
    predicate_id: "run.is-clean",
    subject_kinds: ["run"],
    object_type: "boolean",
    categories: ["fact"],
    temporal_rule: "run_window",
    citation_rule: { kind: "source_state", source_schemas: ["observation-bundle/v1"] },
  }],
  subsumptions: [],
  normalization_rules: ["nfc", "utc", "decimal-canonical"],
});

const evaluationPolicy = sealSigned({
  schema_version: "evaluation-policy/v1",
  policy_id: "fixture-evaluation",
  version: 1,
  claim_vocabulary_hash: vocabulary.core_hash,
  matcher_version: "claim-matcher/v1",
  projector_allowlist: [{ projector_id: "fixture-projector", version: "1.0.0", output_schema: "fixture-output/v1" }],
  metrics: [{
    metric_id: "causal-overclaim-rate",
    version: 1,
    formula_id: "causal-overclaim-rate/v1",
    weight_table: [{ key: "causal", value: 4 }],
    zero_denominator: "pass",
    threshold_operator: "=",
    threshold: "0",
    severity: "hard_gate",
  }],
  aggregation_rule: "metric-vector-no-scalar/v1",
  safety_gate_ids: ["authority-safe", "no-unsupported-causal-claim"],
});

const makeTruth = (experimentId, authoredAt) => seal({
  schema_version: "truth-envelope/v1",
  experiment_id: experimentId,
  truth_version: 1,
  truth_strength: "T1",
  substrate_hash: substrate.core_hash,
  claim_vocabulary_hash: vocabulary.core_hash,
  mechanism: { kind: "flagd", source_ref: "fixture-controller", affected_services: ["checkout"] },
  expected_facts: [],
  supported_links: [],
  permitted_causal_claims: [],
  causal_non_consequences: [],
  correct_unknowns: [],
  misleading_evidence_ids: [],
  supported_claim_ceiling: "observable_only",
  required_sabotages: [],
  admission_approval_ids: ["fixture-qe"],
  authored_at: authoredAt,
});
const makeTruthCommitment = (truthValue, ciphertextValue, committedAt) => sealSigned({
  schema_version: "truth-commitment/v1",
  experiment_id: truthValue.experiment_id,
  truth_version: 1,
  truth_core_hash: truthValue.core_hash,
  plaintext_file_sha256: sha256(fileBytes(truthValue)),
  ciphertext_file_sha256: sha256(ciphertextValue),
  encryption: "age-x25519",
  recipient_key_ids: ["fixture-recipient"],
  committed_at: committedAt,
});
const truthA = makeTruth("erl-fixture-payment", "2026-07-21T13:00:00Z");
const truthB = makeTruth("erl-fixture-kafka", "2026-07-21T13:00:01Z");
const truthABytes = fileBytes(truthA);
const truthBBytes = fileBytes(truthB);
const ciphertextABytes = Buffer.from("age-encrypted-fixture-truth-a\n", "utf8");
const ciphertextBBytes = Buffer.from("age-encrypted-fixture-truth-b\n", "utf8");
const truthCommitmentA = makeTruthCommitment(truthA, ciphertextABytes, "2026-07-21T13:01:00Z");
const truthCommitmentB = makeTruthCommitment(truthB, ciphertextBBytes, "2026-07-21T13:01:01Z");

const trafficProfile = {
  profile_id: "fixture",
  users: 1,
  spawn_rate_per_second: "1",
  warmup_ms: 60000,
  observation_ms: 600000,
  cooldown_ms: 60000,
};
const makeExperiment = (experimentId, title, key, truthCommitmentValue) => seal({
  schema_version: "experiment-manifest/v1",
  experiment_id: experimentId,
  version: 1,
  title,
  tier: "held_out",
  truth_strength: "T1",
  substrate_profile_hash: environmentProfile.core_hash,
  required_capabilities: ["otel-demo"],
  public_before_selection: false,
  activation: { kind: "flagd", logical_mechanism: key, source_control_key: key, on_variant: "on", off_variant: "off" },
  traffic_profile: trafficProfile,
  evidence_policy_hash: evidencePolicy.core_hash,
  health_contract_hash: healthContract.core_hash,
  truth_commitment_hash: truthCommitmentValue.core_hash,
  sabotage_ids: [],
  exposure_epoch: 7,
});
const experimentA = makeExperiment("erl-fixture-payment", "Fixture payment fault", "paymentUnreachable", truthCommitmentA);
const experimentB = makeExperiment("erl-fixture-kafka", "Fixture Kafka fault", "kafkaQueueProblems", truthCommitmentB);
const experimentABytes = fileBytes(experimentA);
const experimentBBytes = fileBytes(experimentB);
const assertExperimentCutoffCompatible = (experiment, policy) => {
  if (experiment.traffic_profile.warmup_ms > policy.maximum_warmup_ms
    || experiment.traffic_profile.observation_ms < policy.minimum_observation_ms
    || experiment.traffic_profile.observation_ms > policy.maximum_observation_ms) throw new Error("pool entry is incompatible with frozen cutoff policy");
};
for (const experiment of [experimentA, experimentB]) assertExperimentCutoffCompatible(experiment, cutoffPolicy);

const requestNonce = "fixture-nonce-0001";
const selectionRequest = sealSigned({
  schema_version: "selection-request/v1",
  request_id: "request-fixture-1",
  request_nonce: requestNonce,
  requested_tier: "held_out",
  frozen_qualiber_hash: qualiberRelease.core_hash,
  qualiber_version: "0.4.2",
  qualiber_config_hash: qualiberConfig.core_hash,
  interface_id: "telemetrytest-action/v1",
  deterministic_mode: true,
  ai_mode: "off",
  cutoff_policy_hash: cutoffPolicy.core_hash,
  run_trust_policy_hash: trustPolicy.core_hash,
  evidence_policy_hash: evidencePolicy.core_hash,
  evaluation_policy_hash: evaluationPolicy.core_hash,
  claim_vocabulary_hash: vocabulary.core_hash,
  required_capability_hash: capability.core_hash,
  requested_at: "2026-07-21T13:49:00Z",
  expires_at: "2026-07-22T13:49:00Z",
});

const pool = sealSigned({
  schema_version: "eligibility-pool-manifest/v1",
  pool_id: "fixture-pool",
  tier: "held_out",
  epoch: 7,
  selection_request_hash: selectionRequest.core_hash,
  frozen_qualiber_hash: selectionRequest.frozen_qualiber_hash,
  cutoff_policy_hash: selectionRequest.cutoff_policy_hash,
  run_trust_policy_hash: selectionRequest.run_trust_policy_hash,
  evidence_policy_hash: selectionRequest.evidence_policy_hash,
  evaluation_policy_hash: selectionRequest.evaluation_policy_hash,
  claim_vocabulary_hash: selectionRequest.claim_vocabulary_hash,
  created_at: "2026-07-21T13:50:00Z",
  entries: [
    { opaque_handle: "fixture-a", experiment_manifest_hash: experimentA.core_hash, capability_hash: capability.core_hash, exposure_epoch: 7, weight: 1 },
    { opaque_handle: "fixture-b", experiment_manifest_hash: experimentB.core_hash, capability_hash: capability.core_hash, exposure_epoch: 7, weight: 1 },
  ],
});
const poolBytes = fileBytes(pool);

let seed;
let digest;
for (let candidate = 0; candidate < 1000; candidate += 1) {
  const candidateSeed = createHash("sha256").update(`fixture-seed-${candidate}`).digest();
  const candidateDigest = createHmac("sha256", candidateSeed).update(Buffer.concat([Buffer.from("ERL-SELECT-V1\n", "ascii"), Buffer.from(pool.core_hash), Buffer.alloc(8)])).digest();
  if (candidateDigest.readBigUInt64BE(0) % 2n === 0n) {
    seed = candidateSeed;
    digest = candidateDigest;
    break;
  }
}
if (!seed || !digest) throw new Error("could not select fixture-a deterministically");
const seedCommitment = sha256(Buffer.concat([Buffer.from("ERL-SEED-V1\n", "ascii"), seed, Buffer.from(requestNonce), Buffer.from(pool.core_hash)]));
const selectedIndex = Number(digest.readBigUInt64BE(0) % 2n);
const selectedEntry = pool.entries[selectedIndex];
if (selectedEntry.experiment_manifest_hash !== experimentA.core_hash) throw new Error("fixture-a was not selected");
const indexBytes = Buffer.alloc(8);
indexBytes.writeBigUInt64BE(BigInt(selectedIndex));
const indexCommitment = sha256(Buffer.concat([Buffer.from("ERL-INDEX-V1\n", "ascii"), indexBytes, seed, Buffer.from(pool.core_hash)]));

const selectionCommitment = sealSigned({
  schema_version: "selection-commitment/v1",
  selection_id: "sel-fixture-1",
  selection_request_hash: selectionRequest.core_hash,
  pool_hash: pool.core_hash,
  pool_epoch: 7,
  frozen_qualiber_hash: selectionRequest.frozen_qualiber_hash,
  qualiber_version: selectionRequest.qualiber_version,
  qualiber_config_hash: selectionRequest.qualiber_config_hash,
  interface_id: selectionRequest.interface_id,
  deterministic_mode: selectionRequest.deterministic_mode,
  ai_mode: selectionRequest.ai_mode,
  cutoff_policy_hash: selectionRequest.cutoff_policy_hash,
  run_trust_policy_hash: selectionRequest.run_trust_policy_hash,
  evidence_policy_hash: selectionRequest.evidence_policy_hash,
  evaluation_policy_hash: selectionRequest.evaluation_policy_hash,
  claim_vocabulary_hash: selectionRequest.claim_vocabulary_hash,
  request_nonce: requestNonce,
  seed_commitment: seedCommitment,
  algorithm: "hmac-sha256-rejection-v1",
  eligible_count: 2,
  selected_index_commitment: indexCommitment,
  selected_handle_ciphertext_base64: "YWdlLWVuY3J5cHRlZC1oYW5kbGU=",
  truth_ciphertext_file_sha256: sha256(ciphertextABytes),
  selected_at: "2026-07-21T13:55:00Z",
  expires_at: "2026-07-22T13:55:00Z",
});

const plan = seal({
  schema_version: "run-plan/v1",
  run_id: runId,
  created_at: "2026-07-21T13:56:00Z",
  selection_request_hash: selectionRequest.core_hash,
  selection_commitment_hash: selectionCommitment.core_hash,
  experiment_manifest_hash: experimentA.core_hash,
  environment_profile_hash: environmentProfile.core_hash,
  qualiber: { artifact_hash: qualiberRelease.core_hash, qualiber_version: "0.4.2", config_hash: qualiberConfig.core_hash, interface_id: "telemetrytest-action/v1", deterministic_mode: true, ai_mode: "off" },
  cutoff_policy_hash: cutoffPolicy.core_hash,
  run_trust_policy_hash: trustPolicy.core_hash,
  evidence_policy_hash: evidencePolicy.core_hash,
  evaluation_policy_hash: evaluationPolicy.core_hash,
  claim_vocabulary_hash: vocabulary.core_hash,
  cutoff_rule: {
    clock: cutoffPolicy.clock,
    derivation: cutoffPolicy.instant_rule,
    inclusion: cutoffPolicy.inclusion,
    max_skew_ms: cutoffPolicy.max_skew_ms,
    late_arrival_grace_ms: cutoffPolicy.late_arrival_grace_ms,
    maximum_timestamp_submission_delay_ms: cutoffPolicy.maximum_timestamp_submission_delay_ms,
    maximum_process_milestone_skew_ms: cutoffPolicy.maximum_process_milestone_skew_ms,
    maximum_monotonic_wall_divergence_ms: cutoffPolicy.maximum_monotonic_wall_divergence_ms,
  },
  limits: { runtime_ms: 2700000, raw_bytes: 1073741824, normalized_bytes: 268435456, api_requests: 1000, ai_tokens: 0 },
});

const environmentFingerprint = seal({
  schema_version: "environment-fingerprint/v1",
  run_id: runId,
  profile_hash: environmentProfile.core_hash,
  host: { os: "linux", arch: "amd64", docker_version: "26.1.0", compose_version: "2.27.0" },
  images: [{ service_id: "checkout", platform: "linux/amd64", digest: sha256(Buffer.from("fixture-checkout-image", "utf8")) }],
  configs: [],
  services: [{ service_id: "checkout", container_id_hash: sha256(Buffer.from("fixture-checkout-container", "utf8")), network_alias: "checkout" }],
  baseline_hash: baseline.core_hash,
  created_at: "2026-07-21T13:58:00Z",
});
const monotonicClockDomain = seal({
  schema_version: "monotonic-clock-domain/v1",
  domain_id: "fixture-host-boot-clock-1",
  run_id: runId,
  environment_fingerprint_hash: environmentFingerprint.core_hash,
  host_identity_hash: sha256(Buffer.from("fixture-host-1", "utf8")),
  boot_id_hash: sha256(Buffer.from("fixture-boot-1", "utf8")),
  clock_id: "CLOCK_MONOTONIC",
  clock_epoch_token_hash: sha256(Buffer.from("fixture-clock-epoch-1", "utf8")),
  observed_at: "2026-07-21T13:58:01Z",
});

const beforeFlagValue = { type: "string", value: "off" };
const requestedFlagValue = { type: "string", value: "on" };
const capsuleValueHash = (value) => sha256(Buffer.from(jcs(value), "utf8"));
const beforeFlagHash = capsuleValueHash(beforeFlagValue);
const requestedFlagHash = capsuleValueHash(requestedFlagValue);
const activationCapsule = sealSigned({
  schema_version: "activation-capsule/v1",
  capsule_id: "capsule-fixture-1",
  run_id: runId,
  selection_commitment_hash: selectionCommitment.core_hash,
  experiment_manifest_hash: experimentA.core_hash,
  recipient_controller_key_id: "fixture-controller-key-1",
  activation_replay_nonce: "fixture-controller-activation-nonce-1",
  restoration_replay_nonce: "fixture-controller-restoration-nonce-1",
  activation_idempotency_key: "fixture-activation-1",
  restoration_idempotency_key: "fixture-restoration-1",
  issued_at: "2026-07-21T14:00:00Z",
  expires_at: "2026-07-21T14:10:00Z",
  allowed_action: {
    kind: "set_flag",
    provider_profile_hash: environmentProfile.core_hash,
    flag_key: "paymentUnreachable",
    expected_before: beforeFlagValue,
    requested_value: requestedFlagValue,
    restore_value: beforeFlagValue,
  },
});
const capsuleCiphertextBytes = Buffer.from("age-encrypted-activation-capsule-fixture\n", "utf8");
const activationEnvelope = sealSigned({
  schema_version: "activation-capsule-envelope/v1",
  envelope_id: "capsule-envelope-fixture-1",
  run_id: runId,
  capsule_core_hash: activationCapsule.core_hash,
  recipient_controller_key_id: activationCapsule.recipient_controller_key_id,
  activation_replay_nonce: activationCapsule.activation_replay_nonce,
  restoration_replay_nonce: activationCapsule.restoration_replay_nonce,
  encryption: "age-x25519",
  ciphertext: artifactRef("commitments/activation-capsule.age", "application/age", capsuleCiphertextBytes, "SECRET"),
  issued_at: activationCapsule.issued_at,
  expires_at: activationCapsule.expires_at,
});
const controllerReceipt = sealSigned({
  schema_version: "controller-execution-receipt/v1",
  execution_id: "controller-execution-fixture-1",
  run_id: runId,
  activation_capsule_hash: activationCapsule.core_hash,
  capsule_envelope_hash: activationEnvelope.core_hash,
  selection_commitment_hash: selectionCommitment.core_hash,
  controller_id: "fixture-controller",
  recipient_controller_key_id: activationCapsule.recipient_controller_key_id,
  activation_replay_nonce: activationCapsule.activation_replay_nonce,
  activation_idempotency_key: activationCapsule.activation_idempotency_key,
  action_kind: "set_flag",
  result: "applied",
  started_at: "2026-07-21T14:01:00Z",
  finished_at: "2026-07-21T14:01:02Z",
  before_value_hash: beforeFlagHash,
  requested_value_hash: requestedFlagHash,
  observed_value_hash: requestedFlagHash,
  proof_artifacts: [],
}, "controller");
const faultActivation = seal({
  schema_version: "fault-activation-record/v1",
  run_id: runId,
  experiment_manifest_hash: experimentA.core_hash,
  kind: "flagd",
  activation_capsule_hash: activationCapsule.core_hash,
  capsule_envelope_hash: activationEnvelope.core_hash,
  controller_execution_receipt_hash: controllerReceipt.core_hash,
  controller_key_hash: sha256(Buffer.from("paymentUnreachable", "utf8")),
  before_value_hash: beforeFlagHash,
  requested_value_hash: requestedFlagHash,
  observed_value_hash: requestedFlagHash,
  activated_at: "2026-07-21T14:01:02Z",
  proof_artifacts: [],
  visibility: "judge_only_until_reveal",
  restoration_required: true,
});
const trafficProfileHash = sha256(Buffer.from(jcs(trafficProfile), "utf8"));
const trafficProcessStartReceipt = sealSigned({
  schema_version: "traffic-process-start-receipt/v1",
  receipt_id: "traffic-process-start-fixture-1",
  run_id: runId,
  selection_commitment_hash: selectionCommitment.core_hash,
  experiment_manifest_hash: experimentA.core_hash,
  environment_fingerprint_hash: environmentFingerprint.core_hash,
  traffic_profile_hash: trafficProfileHash,
  process_identity_hash: sha256(Buffer.from("fixture-traffic-process-1", "utf8")),
  supervisor_boot_id_hash: monotonicClockDomain.boot_id_hash,
  monotonic_clock_domain_hash: monotonicClockDomain.core_hash,
  process_started_at: "2026-07-21T14:02:00Z",
  process_start_monotonic_ms: 420000,
}, "supervisor");
const runtimeMilestone = sealSigned({
  schema_version: "runtime-milestone/v1",
  milestone_id: "traffic-started-fixture-1",
  run_id: runId,
  milestone: "traffic_started",
  selection_commitment_hash: selectionCommitment.core_hash,
  experiment_manifest_hash: experimentA.core_hash,
  environment_fingerprint_hash: environmentFingerprint.core_hash,
  traffic_profile_hash: trafficProfileHash,
  traffic_process_start_receipt_hash: trafficProcessStartReceipt.core_hash,
  monotonic_clock_domain_hash: monotonicClockDomain.core_hash,
  occurred_at: "2026-07-21T14:02:00Z",
  monotonic_elapsed_ms: 420000,
});
const cutoffInstant = new Date(new Date(trafficProcessStartReceipt.process_started_at).getTime() + trafficProfile.warmup_ms + trafficProfile.observation_ms).toISOString().replace(".000Z", "Z");
const traffic = seal({
  schema_version: "traffic-run-record/v1",
  run_id: runId,
  traffic_run_id: "traffic-fixture-1",
  traffic_process_start_receipt_hash: trafficProcessStartReceipt.core_hash,
  runtime_milestone_hash: runtimeMilestone.core_hash,
  profile_hash: trafficProfileHash,
  started_at: trafficProcessStartReceipt.process_started_at,
  ended_at: "2026-07-21T14:14:00Z",
  users: 1,
  request_count: 100,
  journey_attempts: [{ journey_id: "checkout", attempted: 10, completed: 9, failed: 1 }],
  generator_exit_code: 0,
  truncated: false,
  artifacts: [],
});

const observation = seal({
  schema_version: "observation-bundle/v1",
  run_id: runId,
  run_plan_hash: plan.core_hash,
  environment_fingerprint_hash: environmentFingerprint.core_hash,
  cutoff: {
    clock: plan.cutoff_rule.clock,
    instant: cutoffInstant,
    inclusion: plan.cutoff_rule.inclusion,
    max_skew_ms: plan.cutoff_rule.max_skew_ms,
    late_arrival_grace_ms: plan.cutoff_rule.late_arrival_grace_ms,
    traffic_process_start_receipt_hash: trafficProcessStartReceipt.core_hash,
    runtime_milestone_hash: runtimeMilestone.core_hash,
    traffic_profile_hash: trafficProfileHash,
  },
  source_snapshots: [],
  connector_health_hashes: [],
  unsupported_evidence_classes: [],
  cutoff_policy_hash: cutoffPolicy.core_hash,
  evidence_policy_hash: evidencePolicy.core_hash,
  redaction_policy_hash: redactionPolicy.core_hash,
  leak_scan: { scanner_version: "1.0.0", findings: 0, canaries_found: 0 },
  artifacts: [],
  frozen_at: "2026-07-21T14:21:00Z",
});

const stdoutBytes = Buffer.from('{"ok":true}\n', "utf8");
const stderrBytes = Buffer.alloc(0);
const reportBytes = Buffer.from('{"claims":[]}\n', "utf8");
const qualiberRun = seal({
  schema_version: "qualiber-run-manifest/v1",
  run_id: runId,
  attempt_id: "solver-attempt-1",
  observation_bundle_hash: observation.core_hash,
  qualiber_artifact_hash: qualiberRelease.core_hash,
  config_hash: qualiberConfig.core_hash,
  qualiber_version: "0.4.2",
  interface_id: "telemetrytest-action/v1",
  command_argv_hash: sha256(Buffer.from("telemetrytest validate --capture", "utf8")),
  deterministic_mode: true,
  ai_mode: "off",
  started_at: "2026-07-21T14:22:00Z",
  ended_at: "2026-07-21T14:23:00Z",
  exit_code: 0,
  timed_out: false,
  stdout: artifactRef("solver-output/stdout.txt", "application/json", stdoutBytes),
  stderr: artifactRef("solver-output/stderr.txt", "text/plain", stderrBytes),
  resource_usage: { cpu_ms: 12000, max_rss_mib: 256 },
  output_root: "solver-output",
});
const outputEntries = [
  artifactRef("solver-output/report.json", "application/json", reportBytes),
  qualiberRun.stderr,
  qualiberRun.stdout,
].sort((a, b) => Buffer.from(a.path).compare(Buffer.from(b.path)));
const frozenOutput = seal({
  schema_version: "frozen-artifact-manifest/v1",
  run_id: runId,
  purpose: "solver_output",
  producer_manifest_hash: qualiberRun.core_hash,
  entries: outputEntries,
  tree_hash: treeHash(outputEntries),
  file_count: outputEntries.length,
  total_bytes: outputEntries.reduce((sum, entry) => sum + entry.byte_length, 0),
  frozen_at: "2026-07-21T14:23:10Z",
  filesystem_mode: "read_only",
});

const selectionProof = sealSigned({
  schema_version: "selection-proof/v1",
  selection_request_hash: selectionRequest.core_hash,
  selection_commitment_hash: selectionCommitment.core_hash,
  pool_manifest: artifactRef("selection/pool.json", "application/json", poolBytes, "CONFIDENTIAL"),
  pool_manifest_core_hash: pool.core_hash,
  request_nonce: requestNonce,
  seed_base64: seed.toString("base64"),
  algorithm: "hmac-sha256-rejection-v1",
  rejection_counter: 0,
  selected_index: selectedIndex,
  selected_entry: selectedEntry,
  experiment_manifest: artifactRef("selection/experiment.json", "application/json", experimentABytes, "CONFIDENTIAL"),
  experiment_manifest_core_hash: experimentA.core_hash,
  truth_ciphertext_file_sha256: sha256(ciphertextABytes),
  proved_at: "2026-07-21T14:23:20Z",
});

const reveal = sealSigned({
  schema_version: "truth-reveal-record/v1",
  reveal_id: "reveal-fixture-1",
  run_id: runId,
  selection_commitment_hash: selectionCommitment.core_hash,
  selection_proof_hash: selectionProof.core_hash,
  truth_commitment_hash: truthCommitmentA.core_hash,
  truth_core_hash: truthA.core_hash,
  truth_plaintext_file_sha256: sha256(truthABytes),
  cutoff_policy_hash: cutoffPolicy.core_hash,
  traffic_process_start_receipt_hash: trafficProcessStartReceipt.core_hash,
  runtime_milestone_hash: runtimeMilestone.core_hash,
  traffic_profile_hash: trafficProfileHash,
  evidence_policy_hash: evidencePolicy.core_hash,
  evaluation_policy_hash: evaluationPolicy.core_hash,
  claim_vocabulary_hash: vocabulary.core_hash,
  observation_bundle_hash: observation.core_hash,
  solver_output_manifest_hash: frozenOutput.core_hash,
  revealed_at: "2026-07-21T14:24:00Z",
  authorizer_ids: ["custodian-1", "qe-1"],
  decrypt_key_id: "age-reveal-2026-1",
  outcome: "revealed",
});

const exposure = sealSigned({
  schema_version: "exposure-event/v1",
  exposure_id: "exposure-fixture-1",
  corpus_id: "fixture-held-out",
  experiment_manifest_hash: experimentA.core_hash,
  prior_tier: "held_out",
  resulting_tier: "development",
  occurred_at: "2026-07-21T14:24:01Z",
  reason: "truth_reveal",
  actor_id: "fixture-governor",
  run_id: runId,
});
const claimSet = seal({
  schema_version: "structured-claim-set/v1",
  run_id: runId,
  projector_id: "fixture-projector",
  projector_version: "1.0.0",
  claim_vocabulary_hash: vocabulary.core_hash,
  solver_output_manifest_hash: frozenOutput.core_hash,
  claims: [],
  contradictions: [],
  unprojected: [],
  complete: true,
});
const metric = seal({
  schema_version: "evaluation-metric-result/v1",
  metric_id: "causal-overclaim-rate",
  version: 1,
  unit: "ratio",
  numerator: "0",
  denominator: "0",
  value: "0",
  zero_denominator: "pass",
  threshold_operator: "=",
  threshold: "0",
  passed: true,
  severity: "hard_gate",
  included_ids: [],
  excluded: [],
});
const evaluation = seal({
  schema_version: "evaluation-report/v1",
  report_id: "report-fixture-1",
  run_id: runId,
  status: "provisional",
  truth_reveal_hash: reveal.core_hash,
  selection_proof_hash: selectionProof.core_hash,
  cutoff_policy_hash: cutoffPolicy.core_hash,
  traffic_process_start_receipt_hash: trafficProcessStartReceipt.core_hash,
  runtime_milestone_hash: runtimeMilestone.core_hash,
  traffic_profile_hash: trafficProfileHash,
  evidence_policy_hash: evidencePolicy.core_hash,
  evaluation_policy_hash: evaluationPolicy.core_hash,
  claim_vocabulary_hash: vocabulary.core_hash,
  observation_bundle_hash: observation.core_hash,
  solver_output_manifest_hash: frozenOutput.core_hash,
  claim_set_hash: claimSet.core_hash,
  metric_results: [{ metric_id: "causal-overclaim-rate", result_hash: metric.core_hash }],
  safety_gates: [
    { gate_id: "authority-safe", passed: true, evidence_ids: [] },
    { gate_id: "no-unsupported-causal-claim", passed: true, evidence_ids: [] },
  ],
  classification: "product_pass",
  claim_scope: "T1_capability",
  deterministic_pass: true,
  recorded_at: "2026-07-21T14:24:10Z",
  evaluator_version: "1.0.0",
});
const controllerRestorationReceipt = sealSigned({
  schema_version: "controller-restoration-receipt/v1",
  restoration_execution_id: "controller-restoration-fixture-1",
  run_id: runId,
  activation_capsule_hash: activationCapsule.core_hash,
  capsule_envelope_hash: activationEnvelope.core_hash,
  activation_execution_receipt_hash: controllerReceipt.core_hash,
  selection_commitment_hash: selectionCommitment.core_hash,
  controller_id: "fixture-controller",
  recipient_controller_key_id: activationCapsule.recipient_controller_key_id,
  restoration_replay_nonce: activationCapsule.restoration_replay_nonce,
  restoration_idempotency_key: activationCapsule.restoration_idempotency_key,
  action_kind: "set_flag",
  result: "restored",
  started_at: "2026-07-21T14:27:00Z",
  finished_at: "2026-07-21T14:27:02Z",
  before_restore_value_hash: requestedFlagHash,
  requested_restore_value_hash: beforeFlagHash,
  observed_restore_value_hash: beforeFlagHash,
  proof_artifacts: [],
}, "controller");
const restoration = seal({
  schema_version: "restoration-verification/v1",
  restoration_id: "restoration-fixture-1",
  run_id: runId,
  environment_fingerprint_hash: environmentFingerprint.core_hash,
  fault_activation_record_hash: faultActivation.core_hash,
  activation_execution_receipt_hash: controllerReceipt.core_hash,
  controller_restoration_receipt_hash: controllerRestorationReceipt.core_hash,
  health_contract_hash: healthContract.core_hash,
  restored_at: "2026-07-21T14:28:00Z",
  control_readback_hash: beforeFlagHash,
  post_restore_baseline_hash: postRestoreBaseline.core_hash,
  checks: [
    { check_id: "flag-off", kind: "control_state", passed: true, evidence_hashes: [beforeFlagHash] },
    { check_id: "checkout-recovered", kind: "journey", passed: true, evidence_hashes: [postRestoreBaseline.core_hash] },
  ],
  passed: true,
});
const teardown = seal({
  schema_version: "teardown-verification/v1",
  run_id: runId,
  environment_fingerprint_hash: environmentFingerprint.core_hash,
  checked_at: "2026-07-21T14:30:00Z",
  checks: [
    { kind: "container", selector: `label=erl.run=${runId}`, residue_count: 0, residue_hashes: [] },
    { kind: "network", selector: `label=erl.run=${runId}`, residue_count: 0, residue_hashes: [] },
    { kind: "volume", selector: `label=erl.run=${runId}`, residue_count: 0, residue_hashes: [] },
    { kind: "secret_file", selector: `label=erl.run=${runId}`, residue_count: 0, residue_hashes: [] },
    { kind: "port", selector: `label=erl.run=${runId}`, residue_count: 0, residue_hashes: [] },
    { kind: "working_state", selector: `label=erl.run=${runId}`, residue_count: 0, residue_hashes: [] },
  ],
  restoration_verification_hash: restoration.core_hash,
  passed: true,
});
const assertedTimestampForFixture = (value) => value.finished_at ?? value.revealed_at ?? value.proved_at ?? value.process_started_at ?? value.occurred_at
  ?? value.selected_at ?? value.requested_at ?? value.committed_at ?? value.created_at ?? value.issued_at;
const timestampLogId = "fixture-independent-timestamp-log";
const makeTimestampEntry = (value, sequence, securityTimestamp) => ({
  sequence,
  artifact_schema_version: value.schema_version,
  artifact_core_hash: value.core_hash,
  signer_key_id: value.signature.key_id,
  signature_sha256: sha256(Buffer.from(jcs(value.signature), "utf8")),
  security_timestamp: securityTimestamp,
});
const inventorySourceArtifacts = [
  cutoffPolicy, evidencePolicy, vocabulary, evaluationPolicy, truthCommitmentA, selectionRequest, pool, selectionCommitment,
  activationCapsule, activationEnvelope, controllerReceipt, trafficProcessStartReceipt, runtimeMilestone, selectionProof, reveal, exposure, controllerRestorationReceipt,
];
const preInventoryTimestampEntries = inventorySourceArtifacts.map((value, index) => {
  const asserted = assertedTimestampForFixture(value);
  const observedMs = asserted === undefined
    ? new Date("2026-07-21T12:00:00Z").getTime() + index * 1000
    : new Date(asserted).getTime() + 1000;
  return makeTimestampEntry(value, index + 1, new Date(observedMs).toISOString().replace(".000Z", "Z"));
});
const signerInventory = sealSigned({
  schema_version: "product-safe-signer-inventory/v1",
  inventory_id: "signer-inventory-fixture-1",
  run_id: runId,
  selection_commitment_hash: selectionCommitment.core_hash,
  entries: preInventoryTimestampEntries.map((entry) => ({
    artifact_schema_version: entry.artifact_schema_version,
    artifact_core_hash: entry.artifact_core_hash,
    signer_key_id: entry.signer_key_id,
    signature_sha256: entry.signature_sha256,
    security_timestamp: entry.security_timestamp,
    timestamp_log_id: timestampLogId,
    timestamp_sequence: entry.sequence,
  })).sort((a, b) => a.artifact_schema_version.localeCompare(b.artifact_schema_version) || a.artifact_core_hash.localeCompare(b.artifact_core_hash)),
  excluded_public_terminal_types: ["selection-verification-receipt/v1", "final-run-attestation/v1"],
  complete_for_selected_run_chain: true,
  inventoried_at: "2026-07-21T14:30:01Z",
}, "auditor");
const selectionVerificationReceipt = sealSigned({
  schema_version: "selection-verification-receipt/v1",
  receipt_id: "selection-verification-fixture-1",
  run_id: runId,
  selection_request_hash: selectionRequest.core_hash,
  selection_commitment_hash: selectionCommitment.core_hash,
  confidential_selection_proof_hash: selectionProof.core_hash,
  pool_core_hash: pool.core_hash,
  frozen_qualiber_hash: selectionRequest.frozen_qualiber_hash,
  cutoff_policy_hash: cutoffPolicy.core_hash,
  run_trust_policy_hash: trustPolicy.core_hash,
  evidence_policy_hash: evidencePolicy.core_hash,
  evaluation_policy_hash: evaluationPolicy.core_hash,
  claim_vocabulary_hash: vocabulary.core_hash,
  selection_valid: true,
  exposure_event_hash: exposure.core_hash,
  demotion_verified: true,
  signer_inventory_hash: signerInventory.core_hash,
  signer_inventory_complete: true,
  audited_at: "2026-07-21T14:30:02Z",
}, "auditor");
const evaluationBytes = fileBytes(evaluation);
const restorationBytes = fileBytes(restoration);
const teardownBytes = fileBytes(teardown);
const lifecycleEvents = [];
function appendLifecycle(eventType, stateFrom, stateTo, occurredAt, requiredHashes, producedHashes) {
  const event = seal({
    schema_version: "run-lifecycle-event/v1",
    run_id: runId,
    sequence: lifecycleEvents.length + 1,
    event_id: `event-${String(lifecycleEvents.length + 1).padStart(2, "0")}`,
    event_type: eventType,
    state_from: stateFrom,
    state_to: stateTo,
    occurred_at: occurredAt,
    actor_id: "fixture-orchestrator",
    command_id: `command-${String(lifecycleEvents.length + 1).padStart(2, "0")}`,
    ...(lifecycleEvents.length ? { prior_event_hash: lifecycleEvents.at(-1).core_hash } : {}),
    required_hashes: requiredHashes,
    produced_hashes: producedHashes,
  });
  lifecycleEvents.push(event);
}
appendLifecycle("SELECTION_PREREGISTERED", "none", "preregistered", "2026-07-21T13:49:00Z", [], [selectionRequest.core_hash]);
appendLifecycle("SELECTION_COMMITTED", "preregistered", "selected_committed", "2026-07-21T13:55:00Z", [selectionRequest.core_hash, pool.core_hash], [selectionCommitment.core_hash]);
appendLifecycle("RUN_PLANNED", "selected_committed", "planned", "2026-07-21T13:56:00Z", [selectionCommitment.core_hash], [plan.core_hash]);
appendLifecycle("PROVISIONED", "provisioning", "baseline_checking", "2026-07-21T13:58:00Z", [plan.core_hash], [environmentFingerprint.core_hash]);
appendLifecycle("FAULT_ACTIVATED", "baseline_checking", "fault_prepared", "2026-07-21T14:01:02Z", [environmentFingerprint.core_hash, activationEnvelope.core_hash], [controllerReceipt.core_hash, faultActivation.core_hash]);
appendLifecycle("TRAFFIC_COMPLETED", "fault_prepared", "observing", "2026-07-21T14:14:00Z", [faultActivation.core_hash, trafficProcessStartReceipt.core_hash, runtimeMilestone.core_hash], [traffic.core_hash]);
appendLifecycle("OBSERVATION_FROZEN", "observing", "observation_frozen", "2026-07-21T14:21:00Z", [traffic.core_hash], [observation.core_hash]);
appendLifecycle("SOLVER_OUTPUT_FROZEN", "solver_running", "solver_output_frozen", "2026-07-21T14:23:10Z", [observation.core_hash], [qualiberRun.core_hash, frozenOutput.core_hash]);
appendLifecycle("TRUTH_REVEALED", "solver_output_frozen", "truth_revealed", "2026-07-21T14:24:01Z", [selectionProof.core_hash, frozenOutput.core_hash], [reveal.core_hash, exposure.core_hash]);
appendLifecycle("EVALUATED_PROVISIONAL", "truth_revealed", "provisionally_evaluated", "2026-07-21T14:24:10Z", [reveal.core_hash], [evaluation.core_hash]);
appendLifecycle("RESTORE_VERIFIED", "restoring", "destroying", "2026-07-21T14:28:00Z", [faultActivation.core_hash, controllerReceipt.core_hash, controllerRestorationReceipt.core_hash], [restoration.core_hash]);
appendLifecycle("DESTROYED", "destroying", "finalizing", "2026-07-21T14:30:00Z", [restoration.core_hash], [teardown.core_hash]);
appendLifecycle("READY_TO_ATTEST", "finalizing", "ready_to_attest", "2026-07-21T14:30:10Z", [teardown.core_hash, exposure.core_hash], [selectionVerificationReceipt.core_hash]);
const lifecycleHead = lifecycleEvents.at(-1);

const selectionReceiptBytes = fileBytes(selectionVerificationReceipt);
const runRecord = seal({
  schema_version: "external-reality-run-record/v1",
  run_id: runId,
  state: "ready_to_attest",
  created_at: "2026-07-21T13:49:00Z",
  terminal_at: "2026-07-21T14:30:10Z",
  selection_request_hash: selectionRequest.core_hash,
  run_plan_hash: plan.core_hash,
  selection_commitment_hash: selectionCommitment.core_hash,
  selection_proof_hash: selectionProof.core_hash,
  selection_verification_receipt_hash: selectionVerificationReceipt.core_hash,
  signer_inventory_hash: signerInventory.core_hash,
  environment_fingerprint_hash: environmentFingerprint.core_hash,
  fault_activation_record_hash: faultActivation.core_hash,
  traffic_process_start_receipt_hash: trafficProcessStartReceipt.core_hash,
  runtime_milestone_hash: runtimeMilestone.core_hash,
  traffic_profile_hash: trafficProfileHash,
  traffic_run_record_hash: traffic.core_hash,
  observation_bundle_hash: observation.core_hash,
  solver_output_manifest_hash: frozenOutput.core_hash,
  reveal_record_hash: reveal.core_hash,
  evaluation_report_hash: evaluation.core_hash,
  controller_restoration_receipt_hash: controllerRestorationReceipt.core_hash,
  restoration_verification_hash: restoration.core_hash,
  teardown_verification_hash: teardown.core_hash,
  exposure_event_hash: exposure.core_hash,
  cutoff_policy_hash: cutoffPolicy.core_hash,
  run_trust_policy_hash: trustPolicy.core_hash,
  lifecycle_head_hash: lifecycleHead.core_hash,
  classification: "product_pass",
  failures: [],
  retained_artifacts: [
    artifactRef("evaluation/provisional-report.json", "application/json", evaluationBytes),
    artifactRef("restoration/verification.json", "application/json", restorationBytes),
    artifactRef("selection/verification-receipt.json", "application/json", selectionReceiptBytes),
    artifactRef("teardown/verification.json", "application/json", teardownBytes),
  ],
});
const finalAttestation = sealSigned({
  schema_version: "final-run-attestation/v1",
  attestation_id: "attestation-fixture-1",
  run_id: runId,
  run_record_hash: runRecord.core_hash,
  selection_request_hash: selectionRequest.core_hash,
  run_plan_hash: plan.core_hash,
  selection_commitment_hash: selectionCommitment.core_hash,
  confidential_selection_proof_hash: selectionProof.core_hash,
  selection_verification_receipt_hash: selectionVerificationReceipt.core_hash,
  signer_inventory_hash: signerInventory.core_hash,
  cutoff_policy_hash: cutoffPolicy.core_hash,
  run_trust_policy_hash: trustPolicy.core_hash,
  evidence_policy_hash: evidencePolicy.core_hash,
  evaluation_policy_hash: evaluationPolicy.core_hash,
  claim_vocabulary_hash: vocabulary.core_hash,
  environment_fingerprint_hash: environmentFingerprint.core_hash,
  fault_activation_record_hash: faultActivation.core_hash,
  traffic_process_start_receipt_hash: trafficProcessStartReceipt.core_hash,
  runtime_milestone_hash: runtimeMilestone.core_hash,
  traffic_profile_hash: trafficProfileHash,
  traffic_run_record_hash: traffic.core_hash,
  observation_bundle_hash: observation.core_hash,
  solver_output_manifest_hash: frozenOutput.core_hash,
  truth_reveal_hash: reveal.core_hash,
  evaluation_report_hash: evaluation.core_hash,
  controller_restoration_receipt_hash: controllerRestorationReceipt.core_hash,
  restoration_verification_hash: restoration.core_hash,
  teardown_verification_hash: teardown.core_hash,
  exposure_event_hash: exposure.core_hash,
  lifecycle_head_hash: lifecycleHead.core_hash,
  classification: "product_pass",
  verified_at: "2026-07-21T14:30:20Z",
  importable: true,
}, "finalizer");
const terminalTimestampEntries = [
  makeTimestampEntry(signerInventory, preInventoryTimestampEntries.length + 1, "2026-07-21T14:30:03Z"),
  makeTimestampEntry(selectionVerificationReceipt, preInventoryTimestampEntries.length + 2, "2026-07-21T14:30:04Z"),
  makeTimestampEntry(finalAttestation, preInventoryTimestampEntries.length + 3, "2026-07-21T14:30:21Z"),
];
const timestampCheckpoint = sealSigned({
  schema_version: "trusted-timestamp-checkpoint/v1",
  checkpoint_id: "timestamp-checkpoint-fixture-1",
  log_id: timestampLogId,
  context: { scope: "selected_run_public", run_id: runId },
  first_sequence: 1,
  last_sequence: preInventoryTimestampEntries.length + terminalTimestampEntries.length,
  entries: [...preInventoryTimestampEntries, ...terminalTimestampEntries],
  checkpointed_at: "2026-07-21T14:30:30Z",
}, "timestamp");
const confidentialAdmissionTimestampCheckpoint = sealSigned({
  schema_version: "trusted-timestamp-checkpoint/v1",
  checkpoint_id: "confidential-admission-timestamp-checkpoint-fixture-1",
  log_id: "fixture-confidential-admission-timestamp-log",
  context: { scope: "confidential_admission", admission_context_id: "fixture-held-out-admission-epoch-1" },
  first_sequence: 1,
  last_sequence: 1,
  entries: [makeTimestampEntry(truthCommitmentB, 1, "2026-07-21T13:01:02Z")],
  checkpointed_at: "2026-07-21T13:01:03Z",
}, "timestamp");
const independentTimestampByArtifact = new Map([
  ...timestampCheckpoint.entries,
  ...confidentialAdmissionTimestampCheckpoint.entries,
].map((entry) => [entry.artifact_core_hash, entry]));
const publicVerificationMember = (path, value) => ({
  artifact: artifactRef(path, "application/json", fileBytes(value), "PUBLIC"),
  artifact_core_hash: value.core_hash,
});
const publicVerificationBundle = seal({
  schema_version: "public-verification-bundle/v1",
  bundle_id: "public-verification-bundle-fixture-1",
  run_id: runId,
  final_attestation: publicVerificationMember("verification/final-attestation.json", finalAttestation),
  selection_verification_receipt: publicVerificationMember("selection/verification-receipt.json", selectionVerificationReceipt),
  signer_inventory: publicVerificationMember("verification/signer-inventory.json", signerInventory),
  run_trust_policy: publicVerificationMember("trust/run-policy.json", trustPolicy),
  selected_run_timestamp_checkpoint_chain: [
    publicVerificationMember("trust/timestamps/selected-run-checkpoint.json", timestampCheckpoint),
  ],
  verification_trust_head_source: "local_root_pinned_configuration",
  execution_verification_mode: "finalizer_verdict_only",
  execution_artifacts: [],
  created_at: "2026-07-21T14:30:31Z",
});
const trustVerificationReport = seal({
  schema_version: "trust-verification-report/v1",
  report_id: "trust-verification-fixture-1",
  run_id: runId,
  verification_scope: "public_product",
  public_verification_bundle_hash: publicVerificationBundle.core_hash,
  final_attestation_hash: finalAttestation.core_hash,
  selection_verification_receipt_hash: selectionVerificationReceipt.core_hash,
  signer_inventory_hash: signerInventory.core_hash,
  timestamp_checkpoint_hash: timestampCheckpoint.core_hash,
  run_trust_policy_hash: trustPolicy.core_hash,
  verification_trust_head_hash: verificationTrustHead.core_hash,
  head_descends_from_run_policy: true,
  valid_when_signed: true,
  currently_trusted: true,
  signer_results: [
    ...timestampCheckpoint.entries.map((entry) => ({
      artifact_hash: entry.artifact_core_hash,
      key_id: entry.signer_key_id,
      security_timestamp: entry.security_timestamp,
      valid_when_signed: true,
      currently_trusted: true,
      applied_revocation_ids: [],
    })),
    {
      artifact_hash: timestampCheckpoint.core_hash,
      key_id: timestampCheckpoint.signature.key_id,
      security_timestamp: timestampCheckpoint.checkpointed_at,
      valid_when_signed: true,
      currently_trusted: true,
      applied_revocation_ids: [],
    },
  ],
  verified_at: "2026-08-02T00:05:00Z",
});
const lifecycleArtifacts = Object.fromEntries(lifecycleEvents.map((event) => [`lifecycle_event_${String(event.sequence).padStart(2, "0")}`, event]));
const artifacts = {
  redaction_policy_dependency: redactionPolicy,
  cutoff_policy: cutoffPolicy,
  run_trust_policy_manifest: trustPolicy,
  verification_trust_head: verificationTrustHead,
  capability_dependency: capability,
  qualiber_release_dependency: qualiberRelease,
  qualiber_config_dependency: qualiberConfig,
  substrate_dependency: substrate,
  baseline_dependency: baseline,
  post_restore_baseline_dependency: postRestoreBaseline,
  environment_profile: environmentProfile,
  health_contract: healthContract,
  monotonic_clock_domain: monotonicClockDomain,
  evidence_policy: evidencePolicy,
  claim_vocabulary: vocabulary,
  evaluation_policy: evaluationPolicy,
  truth_a: truthA,
  truth_b: truthB,
  truth_commitment_a: truthCommitmentA,
  truth_commitment_b: truthCommitmentB,
  experiment_a: experimentA,
  experiment_b: experimentB,
  selection_request: selectionRequest,
  eligibility_pool: pool,
  selection_commitment: selectionCommitment,
  run_plan: plan,
  environment_fingerprint: environmentFingerprint,
  traffic_process_start_receipt: trafficProcessStartReceipt,
  runtime_milestone: runtimeMilestone,
  activation_capsule: activationCapsule,
  activation_capsule_envelope: activationEnvelope,
  controller_execution_receipt: controllerReceipt,
  controller_restoration_receipt: controllerRestorationReceipt,
  fault_activation_record: faultActivation,
  traffic_run_record: traffic,
  observation_bundle: observation,
  qualiber_run: qualiberRun,
  frozen_output: frozenOutput,
  selection_proof: selectionProof,
  truth_reveal: reveal,
  exposure_event: exposure,
  product_safe_signer_inventory: signerInventory,
  selection_verification_receipt: selectionVerificationReceipt,
  claim_set: claimSet,
  metric,
  provisional_evaluation: evaluation,
  restoration_verification: restoration,
  teardown,
  ...lifecycleArtifacts,
  terminal_run_record: runRecord,
  final_attestation: finalAttestation,
  trusted_timestamp_checkpoint: timestampCheckpoint,
  confidential_admission_timestamp_checkpoint: confidentialAdmissionTimestampCheckpoint,
  public_verification_bundle: publicVerificationBundle,
  trust_verification_report: trustVerificationReport,
};

const artifactCoreHashes = new Set(Object.values(artifacts).map((value) => value.core_hash));
const opaqueOrRawHashFields = new Set([
  "expected_before_hash", "requested_value_hash", "restore_value_hash", "before_value_hash", "observed_value_hash",
  "before_restore_value_hash", "requested_restore_value_hash", "observed_restore_value_hash",
  "container_id_hash", "controller_key_hash", "tree_hash", "command_argv_hash", "control_readback_hash", "profile_hash",
  "traffic_profile_hash", "process_identity_hash", "supervisor_boot_id_hash", "host_identity_hash", "boot_id_hash", "clock_epoch_token_hash",
]);
const assertSemanticHashReferencesResolve = (value, path = "artifacts") => {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertSemanticHashReferencesResolve(entry, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    const entryPath = `${path}.${key}`;
    if (key.endsWith("_hash") && typeof entry === "string" && !opaqueOrRawHashFields.has(key) && !artifactCoreHashes.has(entry)) {
      throw new Error(`${entryPath}: unresolved semantic hash reference`);
    }
    assertSemanticHashReferencesResolve(entry, entryPath);
  }
};
assertSemanticHashReferencesResolve(artifacts);

const requiredSignerRole = new Map([
  ["activation-capsule-envelope/v1", "vault_authorizer"],
  ["activation-capsule/v1", "vault_authorizer"],
  ["claim-vocabulary/v1", "policy_author"],
  ["controller-execution-receipt/v1", "controller"],
  ["controller-restoration-receipt/v1", "controller"],
  ["cutoff-policy/v1", "policy_author"],
  ["eligibility-pool-manifest/v1", "corpus_governor"],
  ["evaluation-policy/v1", "policy_author"],
  ["evidence-policy/v1", "policy_author"],
  ["exposure-event/v1", "corpus_governor"],
  ["final-run-attestation/v1", "final_attestation_signer"],
  ["product-safe-signer-inventory/v1", "confidential_selection_auditor"],
  ["runtime-milestone/v1", "runtime_attestor"],
  ["traffic-process-start-receipt/v1", "traffic_supervisor"],
  ["selection-commitment/v1", "selector"],
  ["selection-proof/v1", "reveal_service"],
  ["selection-request/v1", "preregistrar"],
  ["selection-verification-receipt/v1", "confidential_selection_auditor"],
  ["truth-commitment/v1", "truth_custodian"],
  ["truth-reveal-record/v1", "reveal_service"],
  ["trusted-timestamp-checkpoint/v1", "timestamp_authority"],
]);
const timestampEvidenceFor = (value, override) => {
  if (value.schema_version === "trusted-timestamp-checkpoint/v1") return {
    artifact_schema_version: value.schema_version,
    artifact_core_hash: value.core_hash,
    signer_key_id: value.signature.key_id,
    signature_sha256: sha256(Buffer.from(jcs(value.signature), "utf8")),
    security_timestamp: value.checkpointed_at,
  };
  return override ?? independentTimestampByArtifact.get(value.core_hash);
};
const appliedRevocations = (manifest, keyId, signedAt) => manifest.revocations.filter((revocation) => {
  if (revocation.key_id !== keyId) return false;
  if (revocation.scope === "all_historical") return true;
  if (revocation.scope === "from_timestamp") return signedAt >= revocation.from_timestamp;
  return signedAt >= revocation.effective_at;
});
const authorizationResult = (value, manifest, tier = "held_out", environmentHash = environmentProfile.core_hash, timestampOverride) => {
  const signature = value.signature;
  if (!signature || signature.signed_hash !== value.core_hash) return { valid: false, applied_revocation_ids: [] };
  const timestampEvidence = timestampEvidenceFor(value, timestampOverride);
  const timestampEvidenceValid = timestampEvidence
    && timestampEvidence.artifact_schema_version === value.schema_version
    && timestampEvidence.artifact_core_hash === value.core_hash
    && timestampEvidence.signer_key_id === signature.key_id
    && timestampEvidence.signature_sha256 === sha256(Buffer.from(jcs(signature), "utf8"));
  if (!timestampEvidenceValid) return { valid: false, applied_revocation_ids: [] };
  const trustEntry = manifest.keys.find((entry) => entry.key_id === signature.key_id);
  if (!trustEntry) return { valid: false, applied_revocation_ids: [] };
  const requiredRole = requiredSignerRole.get(value.schema_version);
  const signedAt = timestampEvidence.security_timestamp;
  const revocations = appliedRevocations(manifest, signature.key_id, signedAt);
  const statusValid = trustEntry.status === "active"
    ? trustEntry.retired_at === undefined
    : trustEntry.status === "retired" && trustEntry.retired_at !== undefined && signedAt < trustEntry.retired_at;
  const controllerRecipientValid = !["controller-execution-receipt/v1", "controller-restoration-receipt/v1"].includes(value.schema_version)
    || trustEntry.permitted_encryption_recipient_ids.includes(value.recipient_controller_key_id);
  const message = Buffer.from(`ERL-SIGN-V1\n${value.core_hash}`, "ascii");
  const valid = trustEntry.permitted_contract_types.includes(value.schema_version)
    && requiredRole !== undefined
    && trustEntry.signer_roles.includes(requiredRole)
    && trustEntry.tiers.includes(tier)
    && (trustEntry.environment_profile_hashes.includes("*") || trustEntry.environment_profile_hashes.includes(environmentHash))
    && signedAt >= trustEntry.valid_from
    && signedAt <= trustEntry.valid_until
    && statusValid
    && revocations.length === 0
    && controllerRecipientValid
    && verify(null, message, createPublicKey(trustEntry.public_key_pem), Buffer.from(signature.signature_base64, "base64"));
  return { valid, applied_revocation_ids: revocations.map((entry) => entry.revocation_id) };
};
const authorizationFromInventory = (inventoryEntry, manifest, tier = "held_out", environmentHash = environmentProfile.core_hash) => {
  const trustEntry = manifest.keys.find((entry) => entry.key_id === inventoryEntry.signer_key_id);
  const timestampEntry = timestampCheckpoint.entries.find((entry) => entry.sequence === inventoryEntry.timestamp_sequence);
  if (!trustEntry || !timestampEntry || inventoryEntry.timestamp_log_id !== timestampCheckpoint.log_id
    || timestampEntry.artifact_schema_version !== inventoryEntry.artifact_schema_version
    || timestampEntry.artifact_core_hash !== inventoryEntry.artifact_core_hash
    || timestampEntry.signer_key_id !== inventoryEntry.signer_key_id
    || timestampEntry.signature_sha256 !== inventoryEntry.signature_sha256
    || timestampEntry.security_timestamp !== inventoryEntry.security_timestamp) return { valid: false, applied_revocation_ids: [] };
  const requiredRole = requiredSignerRole.get(inventoryEntry.artifact_schema_version);
  const revocations = appliedRevocations(manifest, inventoryEntry.signer_key_id, inventoryEntry.security_timestamp);
  const statusValid = trustEntry.status === "active"
    ? trustEntry.retired_at === undefined
    : trustEntry.status === "retired" && inventoryEntry.security_timestamp < trustEntry.retired_at;
  const valid = trustEntry.permitted_contract_types.includes(inventoryEntry.artifact_schema_version)
    && requiredRole !== undefined
    && trustEntry.signer_roles.includes(requiredRole)
    && trustEntry.tiers.includes(tier)
    && (trustEntry.environment_profile_hashes.includes("*") || trustEntry.environment_profile_hashes.includes(environmentHash))
    && inventoryEntry.security_timestamp >= trustEntry.valid_from
    && inventoryEntry.security_timestamp <= trustEntry.valid_until
    && statusValid
    && revocations.length === 0;
  return { valid, applied_revocation_ids: revocations.map((entry) => entry.revocation_id) };
};
const assertAuthorizedSignature = (value, manifest = trustPolicy, timestampOverride) => {
  const result = authorizationResult(value, manifest, "held_out", environmentProfile.core_hash, timestampOverride);
  if (!result.valid) throw new Error(`${value.schema_version}: signature is not authorized`);
};
const assertHeldOutSignerSeparation = (receipt, attestation, manifest = trustPolicy) => {
  if (receipt.signature.key_id === attestation.signature.key_id) throw new Error("held-out auditor and finalizer keys must differ");
  const auditor = manifest.keys.find((entry) => entry.key_id === receipt.signature.key_id);
  const finalizer = manifest.keys.find((entry) => entry.key_id === attestation.signature.key_id);
  if (!auditor || !finalizer || auditor.signer_roles.includes("final_attestation_signer") || finalizer.signer_roles.includes("confidential_selection_auditor")) throw new Error("held-out auditor and finalizer roles must be disjoint");
};
const validateRevocations = (manifest, priorManifest) => {
  const keyIds = new Set(manifest.keys.map((entry) => entry.key_id));
  const revocationIds = new Set();
  for (const revocation of manifest.revocations) {
    if (revocationIds.has(revocation.revocation_id) || !keyIds.has(revocation.key_id)) throw new Error("invalid revocation identity");
    revocationIds.add(revocation.revocation_id);
    if (revocation.scope === "prospective" && (revocation.effective_at === undefined || revocation.from_timestamp !== undefined || revocation.effective_at < revocation.announced_at)) throw new Error("invalid prospective revocation");
    if (revocation.scope === "from_timestamp" && (revocation.from_timestamp === undefined || revocation.effective_at !== undefined)) throw new Error("invalid from-timestamp revocation");
    if (revocation.scope === "all_historical" && (revocation.effective_at !== undefined || revocation.from_timestamp !== undefined)) throw new Error("invalid all-historical revocation");
  }
  if (priorManifest) {
    for (const priorRevocation of priorManifest.revocations) {
      const retained = manifest.revocations.find((entry) => entry.revocation_id === priorRevocation.revocation_id);
      if (!retained || jcs(retained) !== jcs(priorRevocation)) throw new Error("trust head dropped or rewrote a prior revocation");
    }
  }
};
const validateKeyEvolution = (manifest, priorManifest) => {
  const keyIds = new Set();
  for (const entry of manifest.keys) {
    if (keyIds.has(entry.key_id)) throw new Error("duplicate trust key ID");
    keyIds.add(entry.key_id);
    if (entry.status === "active" && entry.retired_at !== undefined) throw new Error("active key has retired_at");
    if (entry.status === "retired" && (entry.retired_at === undefined || entry.retired_at < entry.valid_from || entry.retired_at > entry.valid_until)) throw new Error("invalid key retirement");
  }
  if (!priorManifest) return;
  const immutableFields = ["key_id", "public_key_pem", "signer_roles", "permitted_contract_types", "permitted_encryption_recipient_ids", "valid_from", "valid_until", "environment_profile_hashes", "tiers"];
  for (const priorEntry of priorManifest.keys) {
    const nextEntry = manifest.keys.find((entry) => entry.key_id === priorEntry.key_id);
    if (!nextEntry) throw new Error("descendant trust head deleted prior key");
    for (const field of immutableFields) {
      if (jcs(nextEntry[field]) !== jcs(priorEntry[field])) throw new Error(`descendant trust head mutated key field: ${field}`);
    }
    if (priorEntry.status === "retired" && (nextEntry.status !== "retired" || nextEntry.retired_at !== priorEntry.retired_at)) throw new Error("retirement was changed or undone");
    if (priorEntry.status === "active" && !["active", "retired"].includes(nextEntry.status)) throw new Error("invalid key status transition");
    if (priorEntry.status === "active" && nextEntry.status === "retired" && nextEntry.retired_at < manifest.issued_at) throw new Error("backdated key retirement");
  }
};
const verifyRootSignedManifest = (manifest, priorManifest) => {
  const rootEntry = manifest.keys.find((entry) => entry.key_id === signerKeys.root.keyId);
  const message = Buffer.from(`ERL-SIGN-V1\n${manifest.core_hash}`, "ascii");
  if (!rootEntry || rootEntry.public_key_pem !== publicPem("root") || manifest.root_key_id !== signerKeys.root.keyId
    || manifest.root_signature.key_id !== signerKeys.root.keyId || manifest.root_signature.signed_hash !== manifest.core_hash
    || manifest.prior_manifest_hash !== priorManifest?.core_hash
    || !verify(null, message, signerKeys.root.publicKey, Buffer.from(manifest.root_signature.signature_base64, "base64"))) {
    throw new Error("trust policy root/prior verification failed");
  }
  validateRevocations(manifest, priorManifest);
  validateKeyEvolution(manifest, priorManifest);
};
verifyRootSignedManifest(trustPolicy, undefined);
verifyRootSignedManifest(verificationTrustHead, trustPolicy);

const validateTimestampCheckpoint = (checkpoint, priorCheckpoint, expectedContext) => {
  const context = checkpoint.context;
  const selectedRunScopeValid = context?.scope === "selected_run_public"
    && typeof context.run_id === "string" && context.run_id.length > 0
    && context.admission_context_id === undefined;
  const confidentialAdmissionScopeValid = context?.scope === "confidential_admission"
    && context.run_id === undefined
    && typeof context.admission_context_id === "string" && context.admission_context_id.length > 0;
  const expectedContextValid = expectedContext === undefined
    || jcs(context) === jcs(expectedContext);
  if ((!selectedRunScopeValid && !confidentialAdmissionScopeValid)
    || !expectedContextValid
    || checkpoint.entries.length === 0
    || checkpoint.first_sequence !== (priorCheckpoint ? priorCheckpoint.last_sequence + 1 : 1)
    || checkpoint.last_sequence !== checkpoint.first_sequence + checkpoint.entries.length - 1
    || (priorCheckpoint && (checkpoint.prior_checkpoint_hash !== priorCheckpoint.core_hash
      || checkpoint.log_id !== priorCheckpoint.log_id
      || jcs(checkpoint.context) !== jcs(priorCheckpoint.context)
      || new Date(checkpoint.checkpointed_at).getTime() < new Date(priorCheckpoint.checkpointed_at).getTime()))) {
    throw new Error("timestamp checkpoint chain invalid");
  }
  const checkpointedAt = new Date(checkpoint.checkpointed_at).getTime();
  if (!Number.isFinite(checkpointedAt)) throw new Error("timestamp checkpoint time invalid");
  let priorSecurityTime = priorCheckpoint
    ? Math.max(
      new Date(priorCheckpoint.entries.at(-1).security_timestamp).getTime(),
      new Date(priorCheckpoint.checkpointed_at).getTime(),
    )
    : Number.NEGATIVE_INFINITY;
  checkpoint.entries.forEach((entry, index) => {
    const securityTime = new Date(entry.security_timestamp).getTime();
    if (entry.sequence !== checkpoint.first_sequence + index
      || !Number.isFinite(securityTime)
      || securityTime < priorSecurityTime
      || securityTime > checkpointedAt) throw new Error("timestamp checkpoint chronology invalid");
    priorSecurityTime = securityTime;
  });
};
const selectedRunTimestampContext = { scope: "selected_run_public", run_id: runId };
const confidentialAdmissionTimestampContext = { scope: "confidential_admission", admission_context_id: "fixture-held-out-admission-epoch-1" };
validateTimestampCheckpoint(timestampCheckpoint, undefined, selectedRunTimestampContext);
validateTimestampCheckpoint(confidentialAdmissionTimestampCheckpoint, undefined, confidentialAdmissionTimestampContext);

for (const [name, value] of Object.entries(artifacts)) {
  if (value.core_hash !== sha256(Buffer.from(jcs(coreOf(value)), "utf8"))) throw new Error(`${name}: core hash mismatch`);
  if (value.signature) assertAuthorizedSignature(value, trustPolicy);
}
assertHeldOutSignerSeparation(selectionVerificationReceipt, finalAttestation);
const receiptWhenSigned = authorizationResult(selectionVerificationReceipt, trustPolicy);
const finalWhenSigned = authorizationResult(finalAttestation, trustPolicy);
const timestampCheckpointWhenSigned = authorizationResult(timestampCheckpoint, trustPolicy);
const receiptCurrent = authorizationResult(selectionVerificationReceipt, verificationTrustHead);
const finalCurrent = authorizationResult(finalAttestation, verificationTrustHead);
const timestampCheckpointCurrent = authorizationResult(timestampCheckpoint, verificationTrustHead);
const inventoryWhenSigned = signerInventory.entries.map((entry) => authorizationFromInventory(entry, trustPolicy));
const inventoryCurrent = signerInventory.entries.map((entry) => authorizationFromInventory(entry, verificationTrustHead));
const timestampSequencesValid = (() => {
  try { validateTimestampCheckpoint(timestampCheckpoint, undefined, selectedRunTimestampContext); return true; } catch { return false; }
})();
const inventoryCoreSet = new Set(signerInventory.entries.map((entry) => entry.artifact_core_hash));
const artifactByCoreHash = new Map(Object.values(artifacts).map((value) => [value.core_hash, value]));
const inventoryExcludedContractTypes = new Set([
  "final-run-attestation/v1",
  "product-safe-signer-inventory/v1",
  "selection-verification-receipt/v1",
]);
const mandatoryGraphLeafContractTypes = new Set([
  "eligibility-pool-manifest/v1",
  "product-safe-signer-inventory/v1",
]);
const deriveExpectedInventoryCoreSet = (roots) => {
  const visited = new Set();
  const expected = new Set();
  const visit = (value) => {
    if (!value || typeof value !== "object" || visited.has(value.core_hash)) return;
    if (value.core_hash) visited.add(value.core_hash);
    if (value.signature && !inventoryExcludedContractTypes.has(value.schema_version)) expected.add(value.core_hash);
    if (mandatoryGraphLeafContractTypes.has(value.schema_version)) return;
    const scan = (node) => {
      if (Array.isArray(node)) { node.forEach(scan); return; }
      if (!node || typeof node !== "object") return;
      for (const [key, entry] of Object.entries(node)) {
        if (key.endsWith("_hash") && typeof entry === "string" && artifactByCoreHash.has(entry)) visit(artifactByCoreHash.get(entry));
        else scan(entry);
      }
    };
    scan(value);
  };
  roots.forEach(visit);
  return expected;
};
const expectedInventoryCoreSet = deriveExpectedInventoryCoreSet([finalAttestation, selectionVerificationReceipt]);
const inventoryComplete = inventoryCoreSet.size === expectedInventoryCoreSet.size
  && [...expectedInventoryCoreSet].every((hash) => inventoryCoreSet.has(hash));
const unselectedMetadataExcluded = !inventoryCoreSet.has(truthCommitmentB.core_hash)
  && !timestampCheckpoint.entries.some((entry) => entry.artifact_core_hash === truthCommitmentB.core_hash)
  && confidentialAdmissionTimestampCheckpoint.entries.some((entry) => entry.artifact_core_hash === truthCommitmentB.core_hash);
if (!receiptWhenSigned.valid || !finalWhenSigned.valid || !timestampCheckpointWhenSigned.valid
  || !receiptCurrent.valid || !finalCurrent.valid || !timestampCheckpointCurrent.valid
  || inventoryWhenSigned.some((result) => !result.valid) || inventoryCurrent.some((result) => !result.valid)
  || !timestampSequencesValid || !inventoryComplete || !unselectedMetadataExcluded
  || timestampCheckpoint.signature.key_id === selectionVerificationReceipt.signature.key_id
  || timestampCheckpoint.signature.key_id === finalAttestation.signature.key_id
  || selectionVerificationReceipt.signer_inventory_hash !== signerInventory.core_hash
  || finalAttestation.signer_inventory_hash !== signerInventory.core_hash
  || !trustVerificationReport.valid_when_signed || !trustVerificationReport.currently_trusted
  || trustVerificationReport.signer_inventory_hash !== signerInventory.core_hash
  || trustVerificationReport.timestamp_checkpoint_hash !== timestampCheckpoint.core_hash
  || trustVerificationReport.run_trust_policy_hash !== trustPolicy.core_hash
  || trustVerificationReport.verification_trust_head_hash !== verificationTrustHead.core_hash
  || verificationTrustHead.prior_manifest_hash !== trustPolicy.core_hash) {
  throw new Error("dual trust verdict mismatch");
}
const expectAuthorizationFailure = (label, callback) => {
  try { callback(); } catch { return; }
  throw new Error(`${label}: negative fixture unexpectedly authorized`);
};
const gappedTimestampCheckpoint = structuredClone(timestampCheckpoint);
gappedTimestampCheckpoint.entries.splice(1, 1);
expectAuthorizationFailure("timestamp checkpoint sequence gap", () => validateTimestampCheckpoint(gappedTimestampCheckpoint));
const rollbackTimestampCheckpoint = structuredClone(timestampCheckpoint);
rollbackTimestampCheckpoint.entries[1].security_timestamp = new Date(new Date(rollbackTimestampCheckpoint.entries[0].security_timestamp).getTime() - 1).toISOString();
expectAuthorizationFailure("timestamp checkpoint clock rollback", () => validateTimestampCheckpoint(rollbackTimestampCheckpoint));
const futureEntryTimestampCheckpoint = structuredClone(timestampCheckpoint);
futureEntryTimestampCheckpoint.entries.at(-1).security_timestamp = new Date(new Date(futureEntryTimestampCheckpoint.checkpointed_at).getTime() + 1).toISOString();
expectAuthorizationFailure("timestamp entry after checkpoint", () => validateTimestampCheckpoint(futureEntryTimestampCheckpoint));
const descendantTimestampCheckpoint = sealSigned({
  schema_version: "trusted-timestamp-checkpoint/v1",
  checkpoint_id: "timestamp-checkpoint-fixture-descendant-1",
  log_id: timestampCheckpoint.log_id,
  context: timestampCheckpoint.context,
  prior_checkpoint_hash: timestampCheckpoint.core_hash,
  first_sequence: timestampCheckpoint.last_sequence + 1,
  last_sequence: timestampCheckpoint.last_sequence + 1,
  entries: [makeTimestampEntry(finalAttestation, timestampCheckpoint.last_sequence + 1, "2026-07-21T14:30:31Z")],
  checkpointed_at: "2026-07-21T14:30:32Z",
}, "timestamp");
validateTimestampCheckpoint(descendantTimestampCheckpoint, timestampCheckpoint, selectedRunTimestampContext);
const crossCheckpointRollback = structuredClone(descendantTimestampCheckpoint);
crossCheckpointRollback.entries[0].security_timestamp = "2026-07-21T14:30:29Z";
expectAuthorizationFailure("cross-checkpoint timestamp rollback", () => validateTimestampCheckpoint(crossCheckpointRollback, timestampCheckpoint));
const descendantScopeMutation = structuredClone(descendantTimestampCheckpoint);
descendantScopeMutation.context = { scope: "confidential_admission", admission_context_id: "mutated-admission-context" };
expectAuthorizationFailure("timestamp descendant scope mutation", () => validateTimestampCheckpoint(descendantScopeMutation, timestampCheckpoint));
const descendantRunMutation = structuredClone(descendantTimestampCheckpoint);
descendantRunMutation.context.run_id = "019b0000-0000-7000-8000-000000000099";
expectAuthorizationFailure("timestamp descendant run mutation", () => validateTimestampCheckpoint(descendantRunMutation, timestampCheckpoint));
const missingSelectedRunId = structuredClone(timestampCheckpoint);
delete missingSelectedRunId.context.run_id;
expectAuthorizationFailure("selected-run checkpoint without run ID", () => validateTimestampCheckpoint(missingSelectedRunId));
const wrongStandaloneRunId = structuredClone(timestampCheckpoint);
wrongStandaloneRunId.context.run_id = "019b0000-0000-7000-8000-000000000099";
expectAuthorizationFailure("selected-run checkpoint for wrong run", () => validateTimestampCheckpoint(wrongStandaloneRunId, undefined, selectedRunTimestampContext));
const incompleteSignerInventory = structuredClone(signerInventory);
incompleteSignerInventory.entries.pop();
expectAuthorizationFailure("incomplete product-safe signer inventory", () => {
  const hashes = new Set(incompleteSignerInventory.entries.map((entry) => entry.artifact_core_hash));
  if (hashes.size !== expectedInventoryCoreSet.size || [...expectedInventoryCoreSet].some((hash) => !hashes.has(hash))) throw new Error("signer inventory incomplete");
});
if (!expectedInventoryCoreSet.has(runtimeMilestone.core_hash) || expectedInventoryCoreSet.has(truthCommitmentB.core_hash)) {
  throw new Error("mandatory inventory graph selected-chain derivation mismatch");
}
const constructionListOmissionInventory = structuredClone(signerInventory);
constructionListOmissionInventory.entries = constructionListOmissionInventory.entries.filter((entry) => entry.artifact_core_hash !== runtimeMilestone.core_hash);
expectAuthorizationFailure("inventory construction-list omission", () => {
  const hashes = new Set(constructionListOmissionInventory.entries.map((entry) => entry.artifact_core_hash));
  if ([...expectedInventoryCoreSet].some((hash) => !hashes.has(hash))) throw new Error("mandatory graph detected construction omission");
});
const backdatedMilestoneCore = coreOf(runtimeMilestone);
backdatedMilestoneCore.milestone_id = "forged-backdated-milestone";
backdatedMilestoneCore.occurred_at = "2026-07-01T00:00:01Z";
const backdatedMilestone = sealSigned(backdatedMilestoneCore, "operations");
expectAuthorizationFailure("signer-controlled backdating without independent timestamp", () => assertAuthorizedSignature(backdatedMilestone));
const wrongRoleReceipt = sealSigned(coreOf(selectionVerificationReceipt), "finalizer");
expectAuthorizationFailure("wrong-role signer", () => assertAuthorizedSignature(wrongRoleReceipt, trustPolicy, makeTimestampEntry(wrongRoleReceipt, 9001, "2026-07-21T14:30:05Z")));
const sameKeyFinalAttestation = sealSigned(coreOf(finalAttestation), "auditor");
expectAuthorizationFailure("same-key held-out signer", () => assertHeldOutSignerSeparation(selectionVerificationReceipt, sameKeyFinalAttestation));
const wrongRecipientReceiptCore = coreOf(controllerReceipt);
wrongRecipientReceiptCore.recipient_controller_key_id = "unmapped-controller-recipient";
const wrongRecipientReceipt = sealSigned(wrongRecipientReceiptCore, "controller");
expectAuthorizationFailure("controller recipient mapping", () => assertAuthorizedSignature(wrongRecipientReceipt, trustPolicy, makeTimestampEntry(wrongRecipientReceipt, 9002, "2026-07-21T14:01:03Z")));
const wrongRestorationRecipientCore = coreOf(controllerRestorationReceipt);
wrongRestorationRecipientCore.recipient_controller_key_id = "unmapped-controller-recipient";
const wrongRestorationRecipientReceipt = sealSigned(wrongRestorationRecipientCore, "controller");
expectAuthorizationFailure("controller restoration recipient mapping", () => assertAuthorizedSignature(wrongRestorationRecipientReceipt, trustPolicy, makeTimestampEntry(wrongRestorationRecipientReceipt, 9003, "2026-07-21T14:27:03Z")));
const concealedSignerRevocationHead = sealRootSigned({
  ...coreOf(verificationTrustHead),
  manifest_id: "fixture-concealed-signer-revocation-head",
  version: 3,
  issued_at: "2026-08-03T00:00:00Z",
  prior_manifest_hash: verificationTrustHead.core_hash,
  revocations: [...verificationTrustHead.revocations, {
    revocation_id: "revoke-controller-all-history",
    key_id: signerKeys.controller.keyId,
    scope: "all_historical",
    announced_at: "2026-08-03T00:00:00Z",
    reason_code: "fixture_controller_compromise",
  }],
});
verifyRootSignedManifest(concealedSignerRevocationHead, verificationTrustHead);
const concealedControllerInventoryEntry = signerInventory.entries.find((entry) => entry.artifact_schema_version === "controller-execution-receipt/v1");
const concealedControllerCurrent = authorizationFromInventory(concealedControllerInventoryEntry, concealedSignerRevocationHead);
if (concealedControllerCurrent.valid || !concealedControllerCurrent.applied_revocation_ids.includes("revoke-controller-all-history")) {
  throw new Error("product-safe inventory did not surface concealed signer revocation");
}
const mutatedKeyHeadCore = coreOf(verificationTrustHead);
mutatedKeyHeadCore.manifest_id = "fixture-mutated-key-head";
mutatedKeyHeadCore.version = 99;
mutatedKeyHeadCore.issued_at = "2026-08-04T00:00:00Z";
mutatedKeyHeadCore.prior_manifest_hash = verificationTrustHead.core_hash;
mutatedKeyHeadCore.keys = structuredClone(verificationTrustHead.keys);
mutatedKeyHeadCore.keys.find((entry) => entry.key_id === signerKeys.controller.keyId).permitted_contract_types.push("final-run-attestation/v1");
const mutatedKeyHead = sealRootSigned(mutatedKeyHeadCore);
expectAuthorizationFailure("descendant key permission mutation", () => verifyRootSignedManifest(mutatedKeyHead, verificationTrustHead));
const deletedKeyHeadCore = coreOf(verificationTrustHead);
deletedKeyHeadCore.manifest_id = "fixture-deleted-key-head";
deletedKeyHeadCore.version = 100;
deletedKeyHeadCore.issued_at = "2026-08-04T00:00:01Z";
deletedKeyHeadCore.prior_manifest_hash = verificationTrustHead.core_hash;
deletedKeyHeadCore.keys = deletedKeyHeadCore.keys.filter((entry) => entry.key_id !== signerKeys.controller.keyId);
const deletedKeyHead = sealRootSigned(deletedKeyHeadCore);
expectAuthorizationFailure("descendant key deletion", () => verifyRootSignedManifest(deletedKeyHead, verificationTrustHead));
const backdatedRetirementHeadCore = coreOf(verificationTrustHead);
backdatedRetirementHeadCore.manifest_id = "fixture-backdated-retirement-head";
backdatedRetirementHeadCore.version = 101;
backdatedRetirementHeadCore.issued_at = "2026-08-04T00:00:02Z";
backdatedRetirementHeadCore.prior_manifest_hash = verificationTrustHead.core_hash;
backdatedRetirementHeadCore.keys = structuredClone(verificationTrustHead.keys);
const backdatedRetirementEntry = backdatedRetirementHeadCore.keys.find((entry) => entry.key_id === signerKeys.controller.keyId);
backdatedRetirementEntry.status = "retired";
backdatedRetirementEntry.retired_at = "2026-08-03T00:00:00Z";
const backdatedRetirementHead = sealRootSigned(backdatedRetirementHeadCore);
expectAuthorizationFailure("backdated key retirement", () => verifyRootSignedManifest(backdatedRetirementHead, verificationTrustHead));
const retroactiveTrustHead = sealRootSigned({
  ...coreOf(verificationTrustHead),
  manifest_id: "fixture-retroactive-trust-head",
  version: 3,
  issued_at: "2026-08-03T00:00:00Z",
  prior_manifest_hash: verificationTrustHead.core_hash,
  revocations: [...verificationTrustHead.revocations, {
    revocation_id: "revoke-finalizer-all-history",
    key_id: signerKeys.finalizer.keyId,
    scope: "all_historical",
    announced_at: "2026-08-03T00:00:00Z",
    reason_code: "fixture_compromise",
  }],
});
verifyRootSignedManifest(retroactiveTrustHead, verificationTrustHead);
const retroactiveFinalCurrent = authorizationResult(finalAttestation, retroactiveTrustHead);
const retroactiveTrustVerdict = {
  valid_when_signed: authorizationResult(finalAttestation, trustPolicy).valid,
  currently_trusted: retroactiveFinalCurrent.valid,
  applied_revocation_ids: retroactiveFinalCurrent.applied_revocation_ids,
};
if (!retroactiveTrustVerdict.valid_when_signed || retroactiveTrustVerdict.currently_trusted
  || !retroactiveTrustVerdict.applied_revocation_ids.includes("revoke-finalizer-all-history")) {
  throw new Error("all-historical revocation did not produce historical-valid/currently-distrusted verdict");
}


if (treeHash(outputEntries) !== frozenOutput.tree_hash) throw new Error("tree hash mismatch");
if (qualiberRun.stderr.file_sha256 !== "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855") throw new Error("empty digest mismatch");
if (selectionCommitment.seed_commitment !== seedCommitment || selectionCommitment.selected_index_commitment !== indexCommitment) throw new Error("selection commitment mismatch");
if (selectionProof.selected_index !== selectedIndex || jcs(selectionProof.selected_entry) !== jcs(pool.entries[selectedIndex])) throw new Error("selection proof mismatch");
if (selectionProof.pool_manifest.file_sha256 !== sha256(poolBytes) || selectionProof.experiment_manifest.file_sha256 !== sha256(experimentABytes)) throw new Error("selection proof file mismatch");
const poolHandles = new Set(pool.entries.map((entry) => entry.opaque_handle));
const poolManifests = new Set(pool.entries.map((entry) => entry.experiment_manifest_hash));
if (poolHandles.size !== pool.entries.length || poolManifests.size !== pool.entries.length) throw new Error("duplicate pool sampling unit");
if (experimentA.experiment_id === experimentB.experiment_id && experimentA.version === experimentB.version) throw new Error("duplicate resolved experiment version");
const cutoffIncompatibleExperiment = structuredClone(experimentB);
cutoffIncompatibleExperiment.traffic_profile.warmup_ms = cutoffPolicy.maximum_warmup_ms + 1;
expectAuthorizationFailure("pool cutoff incompatibility", () => assertExperimentCutoffCompatible(cutoffIncompatibleExperiment, cutoffPolicy));
for (const value of [pool, selectionCommitment, plan, reveal, selectionVerificationReceipt, evaluation, finalAttestation]) {
  if (value.evaluation_policy_hash !== evaluationPolicy.core_hash || value.claim_vocabulary_hash !== vocabulary.core_hash) throw new Error("evaluation policy chain mismatch");
}
for (const value of [pool, selectionCommitment, plan, observation, reveal, selectionVerificationReceipt, evaluation, finalAttestation]) {
  if (value.evidence_policy_hash !== evidencePolicy.core_hash) throw new Error("evidence policy chain mismatch");
}
for (const value of [selectionRequest, pool, selectionCommitment, plan, observation, reveal, selectionVerificationReceipt, evaluation, runRecord, finalAttestation]) {
  if (value.cutoff_policy_hash !== cutoffPolicy.core_hash) throw new Error("cutoff policy chain mismatch");
}
for (const value of [selectionRequest, pool, selectionCommitment, plan, selectionVerificationReceipt, runRecord, finalAttestation]) {
  if (value.run_trust_policy_hash !== trustPolicy.core_hash) throw new Error("run trust policy chain mismatch");
}
if (pool.selection_request_hash !== selectionRequest.core_hash || selectionCommitment.selection_request_hash !== selectionRequest.core_hash || plan.selection_request_hash !== selectionRequest.core_hash) throw new Error("selection request chain mismatch");
if (selectionRequest.requested_at >= selectionCommitment.selected_at) throw new Error("policy preregistration was not pre-seed");
const requestInvocation = {
  artifact_hash: selectionRequest.frozen_qualiber_hash,
  qualiber_version: selectionRequest.qualiber_version,
  config_hash: selectionRequest.qualiber_config_hash,
  interface_id: selectionRequest.interface_id,
  deterministic_mode: selectionRequest.deterministic_mode,
  ai_mode: selectionRequest.ai_mode,
};
const commitmentInvocation = {
  artifact_hash: selectionCommitment.frozen_qualiber_hash,
  qualiber_version: selectionCommitment.qualiber_version,
  config_hash: selectionCommitment.qualiber_config_hash,
  interface_id: selectionCommitment.interface_id,
  deterministic_mode: selectionCommitment.deterministic_mode,
  ai_mode: selectionCommitment.ai_mode,
};
const runInvocation = {
  artifact_hash: qualiberRun.qualiber_artifact_hash,
  qualiber_version: qualiberRun.qualiber_version,
  config_hash: qualiberRun.config_hash,
  interface_id: qualiberRun.interface_id,
  deterministic_mode: qualiberRun.deterministic_mode,
  ai_mode: qualiberRun.ai_mode,
};
if (jcs(requestInvocation) !== jcs(commitmentInvocation) || jcs(requestInvocation) !== jcs(plan.qualiber) || jcs(requestInvocation) !== jcs(runInvocation)) throw new Error("Qualiber invocation binding mismatch");
const assertSubstrateBinding = (experiment, runPlan, fingerprint, health) => {
  if (experiment.substrate_profile_hash !== runPlan.environment_profile_hash
    || runPlan.environment_profile_hash !== fingerprint.profile_hash
    || fingerprint.profile_hash !== health.environment_profile_hash) throw new Error("selected substrate execution mismatch");
};
assertSubstrateBinding(experimentA, plan, environmentFingerprint, healthContract);
const substitutedProfileHash = sha256(Buffer.from("substituted-profile", "utf8"));
const substitutedProfileExperiment = structuredClone(experimentA);
substitutedProfileExperiment.substrate_profile_hash = substitutedProfileHash;
expectAuthorizationFailure("experiment profile substitution", () => assertSubstrateBinding(substitutedProfileExperiment, plan, environmentFingerprint, healthContract));
const substitutedProfilePlan = structuredClone(plan);
substitutedProfilePlan.environment_profile_hash = substitutedProfileHash;
expectAuthorizationFailure("plan profile substitution", () => assertSubstrateBinding(experimentA, substitutedProfilePlan, environmentFingerprint, healthContract));
const substitutedProfileFingerprint = structuredClone(environmentFingerprint);
substitutedProfileFingerprint.profile_hash = substitutedProfileHash;
expectAuthorizationFailure("fingerprint profile substitution", () => assertSubstrateBinding(experimentA, plan, substitutedProfileFingerprint, healthContract));
const substitutedProfileHealth = structuredClone(healthContract);
substitutedProfileHealth.environment_profile_hash = substitutedProfileHash;
expectAuthorizationFailure("health profile substitution", () => assertSubstrateBinding(experimentA, plan, environmentFingerprint, substitutedProfileHealth));
const assertRuntimeTimeConsistency = (processReceipt, milestone, processTimestampEntry, milestoneTimestampEntry) => {
  const processStartedMs = new Date(processReceipt.process_started_at).getTime();
  const milestoneOccurredMs = new Date(milestone.occurred_at).getTime();
  const processWitnessDelayMs = new Date(processTimestampEntry.security_timestamp).getTime() - processStartedMs;
  const milestoneWitnessDelayMs = new Date(milestoneTimestampEntry.security_timestamp).getTime() - milestoneOccurredMs;
  const wallDeltaMs = milestoneOccurredMs - processStartedMs;
  const monotonicDeltaMs = milestone.monotonic_elapsed_ms - processReceipt.process_start_monotonic_ms;
  if (processReceipt.selection_commitment_hash !== selectionCommitment.core_hash
    || processReceipt.experiment_manifest_hash !== experimentA.core_hash
    || processReceipt.environment_fingerprint_hash !== environmentFingerprint.core_hash
    || processReceipt.traffic_profile_hash !== trafficProfileHash
    || monotonicClockDomain.run_id !== runId
    || monotonicClockDomain.environment_fingerprint_hash !== environmentFingerprint.core_hash
    || processReceipt.supervisor_boot_id_hash !== monotonicClockDomain.boot_id_hash
    || processReceipt.monotonic_clock_domain_hash !== monotonicClockDomain.core_hash
    || milestone.monotonic_clock_domain_hash !== monotonicClockDomain.core_hash
    || milestone.monotonic_clock_domain_hash !== processReceipt.monotonic_clock_domain_hash
    || milestone.traffic_process_start_receipt_hash !== processReceipt.core_hash
    || milestone.signature.key_id === processReceipt.signature.key_id
    || processWitnessDelayMs < 0 || processWitnessDelayMs > cutoffPolicy.maximum_timestamp_submission_delay_ms
    || milestoneWitnessDelayMs < 0 || milestoneWitnessDelayMs > cutoffPolicy.maximum_timestamp_submission_delay_ms
    || Math.abs(wallDeltaMs) > cutoffPolicy.maximum_process_milestone_skew_ms
    || Math.abs(monotonicDeltaMs - wallDeltaMs) > cutoffPolicy.maximum_monotonic_wall_divergence_ms
    || milestoneTimestampEntry.sequence < processTimestampEntry.sequence
    || new Date(milestoneTimestampEntry.security_timestamp).getTime() < new Date(processTimestampEntry.security_timestamp).getTime()) {
    throw new Error("runtime milestone/process/timestamp consistency mismatch");
  }
};
const assertCutoffRealization = (processReceipt, milestone, profile, bundle) => {
  const selectionToTrafficMs = new Date(processReceipt.process_started_at).getTime() - new Date(selectionCommitment.selected_at).getTime();
  const realizedCutoffMs = new Date(processReceipt.process_started_at).getTime() + profile.warmup_ms + profile.observation_ms;
  if (selectionToTrafficMs < 0 || selectionToTrafficMs > cutoffPolicy.maximum_selection_to_traffic_start_ms
    || profile.warmup_ms > cutoffPolicy.maximum_warmup_ms
    || profile.observation_ms < cutoffPolicy.minimum_observation_ms
    || profile.observation_ms > cutoffPolicy.maximum_observation_ms
    || milestone.traffic_profile_hash !== sha256(Buffer.from(jcs(profile), "utf8"))
    || milestone.experiment_manifest_hash !== experimentA.core_hash
    || milestone.environment_fingerprint_hash !== environmentFingerprint.core_hash
    || milestone.traffic_process_start_receipt_hash !== processReceipt.core_hash
    || bundle.cutoff.traffic_process_start_receipt_hash !== processReceipt.core_hash
    || bundle.cutoff.runtime_milestone_hash !== milestone.core_hash
    || bundle.cutoff.traffic_profile_hash !== milestone.traffic_profile_hash
    || new Date(bundle.cutoff.instant).getTime() !== realizedCutoffMs
    || plan.cutoff_rule.clock !== cutoffPolicy.clock
    || plan.cutoff_rule.derivation !== cutoffPolicy.instant_rule
    || plan.cutoff_rule.inclusion !== cutoffPolicy.inclusion
    || plan.cutoff_rule.max_skew_ms !== cutoffPolicy.max_skew_ms
    || plan.cutoff_rule.late_arrival_grace_ms !== cutoffPolicy.late_arrival_grace_ms
    || plan.cutoff_rule.maximum_timestamp_submission_delay_ms !== cutoffPolicy.maximum_timestamp_submission_delay_ms
    || plan.cutoff_rule.maximum_process_milestone_skew_ms !== cutoffPolicy.maximum_process_milestone_skew_ms
    || plan.cutoff_rule.maximum_monotonic_wall_divergence_ms !== cutoffPolicy.maximum_monotonic_wall_divergence_ms) throw new Error("cutoff milestone realization mismatch");
};
if (selectionRequest.requested_at < cutoffPolicy.valid_from || selectionCommitment.selected_at > cutoffPolicy.valid_until) throw new Error("cutoff policy outside validity");
const processTimestampEntry = independentTimestampByArtifact.get(trafficProcessStartReceipt.core_hash);
const milestoneTimestampEntry = independentTimestampByArtifact.get(runtimeMilestone.core_hash);
assertRuntimeTimeConsistency(trafficProcessStartReceipt, runtimeMilestone, processTimestampEntry, milestoneTimestampEntry);
const crossDomainMilestone = structuredClone(runtimeMilestone);
crossDomainMilestone.monotonic_clock_domain_hash = sha256(Buffer.from("different-host-boot-clock-domain", "utf8"));
expectAuthorizationFailure("runtime monotonic clock domain substitution", () => assertRuntimeTimeConsistency(
  trafficProcessStartReceipt, crossDomainMilestone, processTimestampEntry, milestoneTimestampEntry,
));
assertCutoffRealization(trafficProcessStartReceipt, runtimeMilestone, experimentA.traffic_profile, observation);
const forgedMilestoneCore = coreOf(runtimeMilestone);
forgedMilestoneCore.milestone_id = "timestamped-false-milestone";
forgedMilestoneCore.occurred_at = "2026-07-21T13:42:00Z";
forgedMilestoneCore.monotonic_elapsed_ms = 420000;
const forgedMilestone = sealSigned(forgedMilestoneCore, "operations");
const forgedMilestoneTimestampCheckpoint = sealSigned({
  schema_version: "trusted-timestamp-checkpoint/v1",
  checkpoint_id: "timestamped-false-milestone-checkpoint",
  log_id: "fixture-negative-runtime-timestamp-log",
  context: { scope: "selected_run_public", run_id: runId },
  first_sequence: 1,
  last_sequence: 1,
  entries: [makeTimestampEntry(forgedMilestone, 1, "2026-07-21T14:02:02Z")],
  checkpointed_at: "2026-07-21T14:02:03Z",
}, "timestamp");
validateTimestampCheckpoint(forgedMilestoneTimestampCheckpoint, undefined, selectedRunTimestampContext);
assertAuthorizedSignature(forgedMilestoneTimestampCheckpoint);
assertAuthorizedSignature(forgedMilestone, trustPolicy, forgedMilestoneTimestampCheckpoint.entries[0]);
expectAuthorizationFailure("timestamped false runtime milestone", () => assertRuntimeTimeConsistency(
  trafficProcessStartReceipt, forgedMilestone, processTimestampEntry, forgedMilestoneTimestampCheckpoint.entries[0],
));
const lateProcessReceipt = structuredClone(trafficProcessStartReceipt);
lateProcessReceipt.process_started_at = new Date(new Date(selectionCommitment.selected_at).getTime() + cutoffPolicy.maximum_selection_to_traffic_start_ms + 1).toISOString();
expectAuthorizationFailure("cutoff process-start timing bound", () => assertCutoffRealization(lateProcessReceipt, runtimeMilestone, experimentA.traffic_profile, observation));
const excessiveWarmupProfile = { ...experimentA.traffic_profile, warmup_ms: cutoffPolicy.maximum_warmup_ms + 1 };
expectAuthorizationFailure("cutoff warmup bound", () => assertCutoffRealization(trafficProcessStartReceipt, runtimeMilestone, excessiveWarmupProfile, observation));
const shortObservationProfile = { ...experimentA.traffic_profile, observation_ms: cutoffPolicy.minimum_observation_ms - 1 };
expectAuthorizationFailure("cutoff minimum observation bound", () => assertCutoffRealization(trafficProcessStartReceipt, runtimeMilestone, shortObservationProfile, observation));
const longObservationProfile = { ...experimentA.traffic_profile, observation_ms: cutoffPolicy.maximum_observation_ms + 1 };
expectAuthorizationFailure("cutoff maximum observation bound", () => assertCutoffRealization(trafficProcessStartReceipt, runtimeMilestone, longObservationProfile, observation));
const substitutedTrafficProfile = { ...experimentA.traffic_profile, users: experimentA.traffic_profile.users + 1 };
expectAuthorizationFailure("cutoff traffic profile substitution", () => assertCutoffRealization(trafficProcessStartReceipt, runtimeMilestone, substitutedTrafficProfile, observation));
if (activationEnvelope.capsule_core_hash !== activationCapsule.core_hash || controllerReceipt.activation_capsule_hash !== activationCapsule.core_hash || faultActivation.controller_execution_receipt_hash !== controllerReceipt.core_hash) throw new Error("activation chain mismatch");
if (activationCapsule.recipient_controller_key_id !== activationEnvelope.recipient_controller_key_id || activationCapsule.activation_replay_nonce !== controllerReceipt.activation_replay_nonce || activationCapsule.activation_idempotency_key !== controllerReceipt.activation_idempotency_key) throw new Error("controller activation recipient/replay/idempotency mismatch");
if (activationCapsule.allowed_action.kind !== "set_flag" || capsuleValueHash(activationCapsule.allowed_action.requested_value) !== controllerReceipt.requested_value_hash || capsuleValueHash(activationCapsule.allowed_action.restore_value) !== controllerRestorationReceipt.requested_restore_value_hash) throw new Error("capsule typed value execution mismatch");
if (controllerRestorationReceipt.activation_execution_receipt_hash !== controllerReceipt.core_hash || controllerRestorationReceipt.restoration_replay_nonce !== activationCapsule.restoration_replay_nonce || controllerRestorationReceipt.restoration_idempotency_key !== activationCapsule.restoration_idempotency_key || controllerRestorationReceipt.result !== "restored") throw new Error("controller restoration receipt mismatch");
if (traffic.traffic_process_start_receipt_hash !== trafficProcessStartReceipt.core_hash || traffic.runtime_milestone_hash !== runtimeMilestone.core_hash || traffic.started_at !== trafficProcessStartReceipt.process_started_at || traffic.profile_hash !== sha256(Buffer.from(jcs(experimentA.traffic_profile), "utf8"))) throw new Error("traffic process/milestone/profile mismatch");
if (restoration.environment_fingerprint_hash !== environmentFingerprint.core_hash || restoration.fault_activation_record_hash !== faultActivation.core_hash || restoration.activation_execution_receipt_hash !== controllerReceipt.core_hash || restoration.controller_restoration_receipt_hash !== controllerRestorationReceipt.core_hash || !restoration.passed) throw new Error("restoration chain mismatch");
if (teardown.restoration_verification_hash !== restoration.core_hash || !teardown.passed || teardown.checks.some((check) => check.residue_count !== 0)) throw new Error("teardown chain mismatch");
if (selectionVerificationReceipt.exposure_event_hash !== exposure.core_hash || exposure.resulting_tier !== "development" || !selectionVerificationReceipt.demotion_verified) throw new Error("exposure chain mismatch");
for (let index = 1; index < lifecycleEvents.length; index += 1) {
  if (lifecycleEvents[index].prior_event_hash !== lifecycleEvents[index - 1].core_hash) throw new Error("lifecycle chain mismatch");
}
if (runRecord.lifecycle_head_hash !== lifecycleHead.core_hash || finalAttestation.lifecycle_head_hash !== lifecycleHead.core_hash) throw new Error("lifecycle head mismatch");
const retainedExpected = new Map([
  ["evaluation/provisional-report.json", sha256(evaluationBytes)],
  ["restoration/verification.json", sha256(restorationBytes)],
  ["selection/verification-receipt.json", sha256(selectionReceiptBytes)],
  ["teardown/verification.json", sha256(teardownBytes)],
]);
for (const ref of runRecord.retained_artifacts) {
  if (retainedExpected.get(ref.path) !== ref.file_sha256) throw new Error(`retained file mismatch: ${ref.path}`);
}
const finalBindings = {
  selection_request_hash: selectionRequest.core_hash,
  run_plan_hash: plan.core_hash,
  selection_commitment_hash: selectionCommitment.core_hash,
  confidential_selection_proof_hash: selectionProof.core_hash,
  selection_verification_receipt_hash: selectionVerificationReceipt.core_hash,
  signer_inventory_hash: signerInventory.core_hash,
  environment_fingerprint_hash: environmentFingerprint.core_hash,
  fault_activation_record_hash: faultActivation.core_hash,
  traffic_process_start_receipt_hash: trafficProcessStartReceipt.core_hash,
  runtime_milestone_hash: runtimeMilestone.core_hash,
  traffic_profile_hash: trafficProfileHash,
  traffic_run_record_hash: traffic.core_hash,
  observation_bundle_hash: observation.core_hash,
  solver_output_manifest_hash: frozenOutput.core_hash,
  truth_reveal_hash: reveal.core_hash,
  evaluation_report_hash: evaluation.core_hash,
  controller_restoration_receipt_hash: controllerRestorationReceipt.core_hash,
  restoration_verification_hash: restoration.core_hash,
  teardown_verification_hash: teardown.core_hash,
  exposure_event_hash: exposure.core_hash,
  cutoff_policy_hash: cutoffPolicy.core_hash,
  run_trust_policy_hash: trustPolicy.core_hash,
};
for (const [field, expected] of Object.entries(finalBindings)) {
  if (finalAttestation[field] !== expected || runRecord[field.replace("truth_reveal_hash", "reveal_record_hash").replace("confidential_selection_proof_hash", "selection_proof_hash")] !== expected) throw new Error(`terminal binding mismatch: ${field}`);
}
for (const value of [reveal, evaluation, runRecord, finalAttestation]) {
  if (value.traffic_process_start_receipt_hash !== trafficProcessStartReceipt.core_hash || value.runtime_milestone_hash !== runtimeMilestone.core_hash || value.traffic_profile_hash !== trafficProfileHash) throw new Error("cutoff process/milestone/profile chain mismatch");
}
const assertPublicVerificationBundleClosure = (bundle) => {
  const expectedMembers = [
    [bundle.final_attestation, finalAttestation],
    [bundle.selection_verification_receipt, selectionVerificationReceipt],
    [bundle.signer_inventory, signerInventory],
    [bundle.run_trust_policy, trustPolicy],
    [bundle.selected_run_timestamp_checkpoint_chain?.[0], timestampCheckpoint],
  ];
  for (const [member, value] of expectedMembers) {
    if (member?.artifact_core_hash !== value.core_hash || member.artifact.file_sha256 !== sha256(fileBytes(value))) throw new Error("public verification bundle member mismatch");
  }
  if (bundle.run_id !== runId
    || bundle.selected_run_timestamp_checkpoint_chain.length !== 1
    || bundle.verification_trust_head_source !== "local_root_pinned_configuration"
    || bundle.execution_verification_mode !== "finalizer_verdict_only"
    || bundle.execution_artifacts.length !== 0) throw new Error("public verification bundle closure mismatch");
};
assertPublicVerificationBundleClosure(publicVerificationBundle);
if (trustVerificationReport.public_verification_bundle_hash !== publicVerificationBundle.core_hash) throw new Error("trust report bundle binding mismatch");
const missingBundleMember = structuredClone(publicVerificationBundle);
delete missingBundleMember.signer_inventory;
expectAuthorizationFailure("public verification bundle missing member", () => assertPublicVerificationBundleClosure(missingBundleMember));
const executionBodyBundle = structuredClone(publicVerificationBundle);
executionBodyBundle.execution_artifacts = [publicVerificationMember("state/environment-fingerprint.json", environmentFingerprint)];
expectAuthorizationFailure("public verification bundle execution body", () => assertPublicVerificationBundleClosure(executionBodyBundle));
const productObjects = [selectionVerificationReceipt, finalAttestation, publicVerificationBundle];
for (const value of productObjects) {
  const encoded = jcs(value);
  for (const forbidden of ["seed_base64", "pool_manifest", "experiment_manifest", "selected_entry", "truth_plaintext_file_sha256", "allowed_action", "flag_key"]) {
    if (encoded.includes(`"${forbidden}"`)) throw new Error(`product boundary contains ${forbidden}`);
  }
}
const replay = structuredClone(evaluation);
replay.recorded_at = "2030-01-01T00:00:00Z";
if (sha256(Buffer.from(jcs(coreOf(replay)), "utf8")) !== evaluation.core_hash) throw new Error("volatile timestamp changed report core");

console.log(jcs({
  schema_version: "appendix-a-golden/v9",
  generator: "design-fixtures/appendix-a-golden.mjs",
  public_keys_pem: Object.fromEntries(Object.entries(signerKeys).map(([role, key]) => [role, key.publicKey.export({ format: "pem", type: "spki" })])),
  raw_file_digests: {
    "solver-output/stderr.txt": { byte_length: stderrBytes.length, file_sha256: sha256(stderrBytes) },
    "solver-output/stdout.txt": { byte_length: stdoutBytes.length, file_sha256: sha256(stdoutBytes) },
    "solver-output/report.json": { byte_length: reportBytes.length, file_sha256: sha256(reportBytes) },
    "commitments/activation-capsule.age": { byte_length: capsuleCiphertextBytes.length, file_sha256: sha256(capsuleCiphertextBytes) },
  },
  artifacts,
  checks: ["all_core_hashes", "all_semantic_hash_references_resolve", "all_signatures", "signer_role_authorization", "run_trust_policy_authorization", "verification_trust_head_chain", "independent_timestamp_checkpoint", "timestamp_checkpoint_chronology_negative", "timestamp_cross_checkpoint_rollback_negative", "timestamp_scope_run_negative", "signer_backdating_negative", "product_safe_signer_inventory", "inventory_mandatory_graph_completeness", "unselected_metadata_exclusion", "concealed_signer_revocation_negative", "trust_key_immutability_negative", "dual_trust_verdicts", "retroactive_revocation_negative", "held_out_auditor_finalizer_key_separation", "wrong_role_negative", "same_key_negative", "controller_recipient_mapping", "controller_recipient_mapping_negative", "all_file_digests", "output_tree_hash", "pre_seed_policy_preregistration", "qualiber_invocation_binding", "selected_substrate_binding", "profile_substitution_negative", "traffic_process_start_receipt", "monotonic_clock_domain_binding", "runtime_time_consistency_negative", "cutoff_milestone_realization", "cutoff_timing_bound_negative", "pool_cutoff_compatibility", "unique_pool_sampling_units", "selection_recomputation", "confidential_public_verification_split", "public_verification_bundle_closure", "activation_capsule_typed_values", "activation_capsule_chain", "controller_restoration_receipt", "traffic_binding", "restoration_binding", "zero_residue_teardown", "exposure_demotion", "lifecycle_chain", "final_attestation_bindings", "volatile_timestamp_exclusion"],
}));
