# `subject-adapter/v2` protocol and local-observation contract design

**Status:** normative design, implementation not started

**Decision:** [ADR-ERL2-037](../adr/ADR-ERL2-037.md)

## 1. Repository-grounded trace

The design depends on these current facts, verified at commit
`0bc7c1cb5559b9a8d9c5bd6fe5839591d9acfa17`:

| Concern | Current implementation | V2 disposition |
|---|---|---|
| Protocol constant and framing | `packages/contracts/src/protocol.ts`; one v1 constant, length-prefixed UTF-8 JSON, 16 MiB absolute cap | Keep codec; add explicit v1/v2 constants and v2 message union. |
| Manifest validation | `SubjectAdapterManifestV1` in `acquisition.schema.json` has `protocol_version: const subject-adapter/v1` | Keep V1; add V2 manifest with scoped protocol profiles. |
| Wire envelopes | `HostNegotiateMessage`, `HostOperationMessage`, `AdapterNegotiationMessage`, `AdapterResponseMessage`; host derives `AdapterResponseEnvelopeV1` | Add distinct v2 messages/envelope; never reinterpret v1 frames. |
| V1 requests | three closed contracts in `acquisition.schema.json` | Unchanged. Add one closed `AdapterRequestV2`. |
| Operations | thirteen values in `ADAPTER_OPERATIONS` and `AdapterOperationId` | Same closed enum. Availability becomes mode/profile scoped. |
| SDK dispatch | `adapter-sdk/src/sdk.ts` dispatches after v1 phase, operation and oracle checks | Extend the same loop with protocol/mode-specific strict parsing. |
| Host construction | `AdapterHost` validates a v1 manifest, re-hashes certified bytes, builds v1 messages and retains host evidence | Extend in place; v1 remains the default compatibility path. |
| Certification | `ADAPTER-CERT-V1` uses governed-shaped v1 probes and binds manifest/artifact/operations/package kinds/controls | Preserve. Add `ADAPTER-CERT-V2` because assurance scope changes. |
| Artifact/output handling | `ArtifactStore`, `freezeAdapterOutput`, `freezeDiagnostics`, `markOutputFrozen` | Reuse unchanged except for v2 evidence types at the protocol boundary. |
| Mutation/cleanup | `MutationLedger`, compensation receipts, adapter residue operation, supervisors | Reuse. Local result reports uncertainty; it does not infer clean. |
| Replay | governed lifecycle log plus pre-dispatch mutation intent; host publishes deterministic operation evidence | Local coordinator uses declared/completed records and reconciliation, not the governed state graph. |
| Governed commitments | `RunWorkspace` builds acquire/verify requests; `EnvironmentRun` builds step requests from preregistration/plan/visible steps | Remain v1 and unchanged. Governed v2 is reserved but initially unsupported. |
| Reveal/evaluation/finalization | `RunWorkspace`/`EnvironmentRun`, evaluation modules, terminal finalizers and public verifier consume governed roles only | Unchanged; local schemas are never admitted to those roles. |
| Purity/removability | SDK depends only on contracts; core does not depend on adapter packages; adapter path is optional | Preserve with architecture tests and no product branch. |

The Independent-QA adapter at read-only commit
`a699383045d24c91876a8dd176ae8572612c7cb1` confirms the compatibility
boundary. It is `independent-analytics-validator` `0.1.0`, declares v1 and eleven
operations, omits `collect-outputs` and `stop` honestly, and uses v1 request
fields in package verification and translation. Its current artifact, manifest
core and receipt core hashes are respectively `sha256:b977ac2a…76893`,
`sha256:45d6428e…e9b07` and `sha256:24d75c1c…e6239b`. Those frozen identities are
v1-only.

## 2. V2 negotiation

### 2.1 Advertisement

`SubjectAdapterManifestV2.protocol_support` is a non-empty, unique array of
profiles supported by the artifact. A V2 receipt carries its own
`certified_profiles` array, which may be a strict subset and initially contains
only the v2 local profile:

```json
{
  "protocol_version": "subject-adapter/v2",
  "execution_modes": ["local_observation"],
  "operations": ["acquire", "validate-package", "report-residue"],
  "supported_package_kinds": ["archive"]
}
```

The exact rules are:

- V1-only: publish the unchanged `SubjectAdapterManifestV1`.
- V2-only: publish `SubjectAdapterManifestV2` with one v2 profile.
- Dual: publish a V2 manifest with distinct v1 and v2 profiles. To support an
  unchanged v1 host, also publish a V1 manifest and V1 receipt over the same new
  artifact bytes.
- No protocol entry may repeat. Modes and operations are unique closed enums.
- Initially a v2 profile may advertise `local_observation` only. Advertising
  v2 `governed` before its implementation/certification is a certification
  refusal.

### 2.2 Handshake

V1 retains its existing single-version handshake. The V2 handshake is:

```json
{
  "kind": "negotiate",
  "schema_version": "adapter-host-negotiation-request/v2",
  "offered_protocol_versions": ["subject-adapter/v2"],
  "required_execution_mode": "local_observation",
  "execution_id": "018f1111-2222-7333-8444-555555555555",
  "max_request_bytes": 1048576,
  "max_response_bytes": 1048576
}
```

```json
{
  "kind": "negotiation",
  "schema_version": "adapter-negotiation-response/v2",
  "selected_protocol_version": "subject-adapter/v2",
  "execution_mode": "local_observation",
  "adapter_id": "neutral-archive-observer",
  "adapter_version": "1.1.0",
  "supported_operations": ["acquire", "validate-package", "report-residue"],
  "supported_package_kinds": ["archive"]
}
```

Host selection is deterministic:

1. Filter offered versions by the desired mode.
2. Intersect with the manifest profile and certification scope.
3. Select the first host-preferred version in that intersection.
4. Require the adapter to return exactly that version, mode, identity,
   operations and package kinds.

For local observation the offer contains v2 only. A v1-only adapter receives no
operation frame and fails `ADAPTER_EXECUTION_MODE_UNSUPPORTED`. Returning v1 is
`ADAPTER_PROTOCOL_DOWNGRADE_REFUSED`. Returning an unknown version or mode is
`ADAPTER_PROTOCOL_VERSION_MISMATCH` or
`ADAPTER_EXECUTION_MODE_UNSUPPORTED`. No host silently retries another major.

## 3. `AdapterRequestV2`

### 3.1 Common envelope

Every request is a closed object with these and only these common fields:

| Field | Rule |
|---|---|
| `schema_version` | constant `adapter-request/v2` |
| `protocol_version` | constant `subject-adapter/v2` |
| `execution_id` | governed run id or local observation id; the context determines which |
| `adapter_manifest_hash` | exact selected V2 manifest |
| `operation_id` | host-authored, unique within the execution |
| `operation` | closed `AdapterOperationId` |
| `ancestry` | sequence plus exact predecessor operation-record/request/envelope identity, all host-verified |
| `deadline` | absolute instant, no later than plan/run expiry |
| `diagnostics_policy` | total byte/line caps, required scan and redaction behavior |
| `execution_context` | closed discriminator below |
| `operation_payload` | operation-correlated closed variant below |
| `core_hash` | host-derived canonical identity; never adapter-authored |

The first-request ancestry is:

```json
{
  "sequence": 0,
  "predecessor": null
}
```

For sequence greater than zero, `predecessor` is a closed union. Every variant
has `operation_id`, `operation_record_hash`, `request_hash` and `outcome`. A
`completed` predecessor also requires `response_envelope_hash`. A `failed`
predecessor permits a response-envelope hash only when the host froze one. An
`ambiguous_not_replayed` predecessor requires that value to be null. This lets
the cleanup suffix retain an exact chain after a crash without inventing a
response. There is no generic ancestor hash or metadata object through which
governed claims can be smuggled.

### 3.2 Governed context

The governed branch is a closed union by `phase`:

```json
{
  "mode": "governed",
  "phase": "post_plan",
  "execution_plan_hash": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "visible_step": {
    "artifact": {
      "path": "subject-visible/steps/step-3.json",
      "media_type": "application/json",
      "byte_length": 512,
      "file_sha256": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "classification": "PUBLIC"
    },
    "core_hash": "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
  },
  "prior_visible_interaction_hashes": [],
  "resource_limit_hash": "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
  "credential_handle_ids": []
}
```

The exact required equivalence is:

| Phase | Required fields |
|---|---|
| `acquisition` | `acquisition_preregistration_hash`, `acquisition_source_manifest_hash`, `visible_step`, `resource_limit_hash`, `credential_handle_ids` |
| `package_verification` | `acquisition_preregistration_hash`, `acquisition_record_hash`, `integrity_policy_hash`, `provenance_policy_hash`, `visible_step` |
| `post_plan` | `execution_plan_hash`, `visible_step`, `prior_visible_interaction_hashes`, `resource_limit_hash`, `credential_handle_ids`; canonical evidence ref/mount only when frozen |

The V2 schema does not make these optional by putting all fields in one object;
each phase is a separate `oneOf` member with `additionalProperties: false`.
Implementation is deferred, and the example is structural specification rather
than an executable path.

### 3.3 Local-observation context

```json
{
  "mode": "local_observation",
  "observation_plan_hash": "sha256:1111111111111111111111111111111111111111111111111111111111111111",
  "resource_limits": {
    "schema_version": "local-observation-limits/v1",
    "wall_clock_ms": 30000,
    "max_request_bytes": 1048576,
    "max_response_bytes": 1048576,
    "max_output_files": 128,
    "max_output_bytes": 16777216,
    "max_output_path_depth": 8,
    "max_diagnostic_bytes": 65536,
    "max_diagnostic_line_bytes": 4096,
    "environment_variable_names": [
      "ERL2_ADAPTER_PROTOCOL_VERSION",
      "ERL2_EXECUTION_ID",
      "ERL2_EXECUTION_MODE",
      "ERL2_OPERATION_ID"
    ],
    "input_root": "inputs",
    "workspace_root": "adapter-workspace",
    "output_root": "subject-output/adapter",
    "control_expectations": [
      {"control_id": "process-tree-termination", "required_state": "enforced"},
      {"control_id": "deny-by-default-egress", "required_state": "unsupported_permitted"}
    ],
    "core_hash": "sha256:2222222222222222222222222222222222222222222222222222222222222222"
  },
  "input_artifact_refs": [],
  "egress_policy": {
    "schema_version": "egress-allowlist-policy/v1",
    "policy_id": "observation-default-deny",
    "default_action": "deny",
    "allowed_schemes": ["https"],
    "allowed_hosts": [],
    "allowed_ports": [443],
    "max_redirects": 0,
    "revalidate_redirect_targets": true,
    "allow_loopback_hosts": [],
    "deny_link_local": true,
    "deny_metadata_service": true,
    "deny_proxy_bypass": true,
    "core_hash": "sha256:3333333333333333333333333333333333333333333333333333333333333333"
  },
  "allowed_capability_ids": [],
  "allowed_credential_handle_ids": [],
  "not_scored": true,
  "not_governor_authorized": true,
  "unsupported_claims": [
    "score",
    "qualification",
    "governor_authorization",
    "reveal",
    "judge_evaluation",
    "governed_finalization"
  ]
}
```

Each `input_artifact_refs` member is closed and contains `input_id`, `role`,
`provenance_mode` (`host_provisioned` or `acquired`), an exact `ArtifactRef`,
and, for acquired input, its producing completed-operation-record hash. An
acquired ref is absent until the host freezes the producing operation.

The local context permits only these hash roles: plan identity, the limits and
egress objects' own core hashes, selected manifest identity, exact frozen input
artifact identities in their typed references, and prior v2 request/envelope
identities. A free-form `*_hash`, `commitment_hash` or metadata object is not
representable.

The following field names are rejected recursively on the local branch even if
a future schema mistake exposes a container for them:
`governor_id`, `preregistration_hash`, `acquisition_preregistration_hash`,
`execution_plan_hash`, `visible_step`, `judge_expectation`,
`judge_expectation_hash`, `trust_policy_hash`, `score`, `qualification`,
`reveal_state` and `tier`.

### 3.4 Operation payloads

Each payload is a closed variant correlated with the top-level operation:

| Operation | Local payload | Prerequisite and retained meaning |
|---|---|---|
| `acquire` | `acquire-payload/v1`: `provenance_mode: acquired`, `source_descriptor_input_id`, `output_input_id`, `expected_package_kind`, `credential_handle_ids` | The source descriptor is a frozen host-provisioned input; credential ids are a subset of the plan allowance. Retained bytes become an acquired input for later steps. |
| `validate-package` | `validate-package-payload/v1`: `package_input_id`, `package_kind` | Input id resolves to one frozen acquired or host-provisioned artifact. |
| `install` | `install-payload/v1`: `package_input_id` | Package was structurally validated; mutation declarations remain mandatory. |
| `configure` | `configure-payload/v1`: `configuration_input_ids` | Every id resolves to a frozen plan input or prior retained output. |
| `start` | `start-payload/v1`: `input_ids` | Install/configure prerequisites selected by the plan hold. |
| `interact` | `interact-payload/v1`: `interaction_input_ids` | Start completed when the plan includes start. |
| `translate-evidence` | `translate-evidence-payload/v1`: `evidence_input_ids`, `evidence_mount_handle_id` | Inputs are retained artifacts mounted read-only. |
| `collect-outputs` | `collect-outputs-payload/v1`: `requested_output_role_ids` | Start/interact completed as required by the plan. |
| `project` | `project-payload/v1`: `evidence_input_ids`, `projection_schema` | Output is retained as an adapter draft only; never admitted to evaluation. |
| `stop` | `stop-payload/v1`: `start_operation_id` | Required if a start completed and the adapter declares stop. |
| `uninstall` | `uninstall-payload/v1`: `install_operation_id` | Runs after stop if a start completed. |
| `report-residue` | `report-residue-payload/v1`: `checkpoint` (`baseline`, `post_operation`, `final`) | Final checkpoint is required for cleanup-complete status when certified. |
| `compensate` | `compensate-payload/v1`: exact `mutation_receipt_hashes` | Every hash resolves to a retained, outstanding mutation receipt from this observation. |

Identifiers are bounded generic ids. There is no arbitrary JSON payload. An
adapter-specific interaction plan travels as a frozen input artifact, never as
a product field in the protocol.

### 3.5 Representative local request

```json
{
  "schema_version": "adapter-request/v2",
  "protocol_version": "subject-adapter/v2",
  "execution_id": "018f1111-2222-7333-8444-555555555555",
  "adapter_manifest_hash": "sha256:4444444444444444444444444444444444444444444444444444444444444444",
  "operation_id": "op-0001-acquire",
  "operation": "acquire",
  "ancestry": {
    "sequence": 0,
    "predecessor": null
  },
  "deadline": "2026-08-12T18:30:00Z",
  "diagnostics_policy": {
    "max_total_bytes": 65536,
    "max_line_bytes": 4096,
    "redact_secrets": true,
    "scan_forbidden_identifiers": true
  },
  "execution_context": {
    "mode": "local_observation",
    "observation_plan_hash": "sha256:1111111111111111111111111111111111111111111111111111111111111111",
    "resource_limits": {
      "schema_version": "local-observation-limits/v1",
      "wall_clock_ms": 30000,
      "max_request_bytes": 1048576,
      "max_response_bytes": 1048576,
      "max_output_files": 128,
      "max_output_bytes": 16777216,
      "max_output_path_depth": 8,
      "max_diagnostic_bytes": 65536,
      "max_diagnostic_line_bytes": 4096,
      "environment_variable_names": ["ERL2_ADAPTER_PROTOCOL_VERSION", "ERL2_EXECUTION_ID", "ERL2_EXECUTION_MODE", "ERL2_OPERATION_ID"],
      "input_root": "inputs",
      "workspace_root": "adapter-workspace",
      "output_root": "subject-output/adapter",
      "control_expectations": [{"control_id": "process-tree-termination", "required_state": "enforced"}],
      "core_hash": "sha256:2222222222222222222222222222222222222222222222222222222222222222"
    },
    "input_artifact_refs": [
      {
        "input_id": "public-source-descriptor",
        "role": "acquisition_source_descriptor",
        "provenance_mode": "host_provisioned",
        "artifact": {
          "path": "inputs/public-source.json",
          "media_type": "application/json",
          "byte_length": 192,
          "file_sha256": "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          "classification": "PUBLIC"
        }
      }
    ],
    "egress_policy": {
      "schema_version": "egress-allowlist-policy/v1",
      "policy_id": "observation-default-deny",
      "default_action": "deny",
      "allowed_schemes": ["https"],
      "allowed_hosts": [],
      "allowed_ports": [443],
      "max_redirects": 0,
      "revalidate_redirect_targets": true,
      "allow_loopback_hosts": [],
      "deny_link_local": true,
      "deny_metadata_service": true,
      "deny_proxy_bypass": true,
      "core_hash": "sha256:3333333333333333333333333333333333333333333333333333333333333333"
    },
    "allowed_capability_ids": [],
    "allowed_credential_handle_ids": [],
    "not_scored": true,
    "not_governor_authorized": true,
    "unsupported_claims": ["score", "qualification", "governor_authorization", "reveal", "judge_evaluation", "governed_finalization"]
  },
  "operation_payload": {
    "schema_version": "acquire-payload/v1",
    "provenance_mode": "acquired",
    "source_descriptor_input_id": "public-source-descriptor",
    "output_input_id": "observed-package",
    "expected_package_kind": "archive",
    "credential_handle_ids": []
  },
  "core_hash": "sha256:5555555555555555555555555555555555555555555555555555555555555555"
}
```

### 3.6 V2 response and host envelope

The adapter returns a closed `adapter-response-message/v2` draft with
`protocol_version`, `execution_mode`, `execution_id`, operation/id, one of
`supported`, `failed` or `unsupported`, an operation-correlated result draft,
mutation/compensation/credential/egress drafts, bounded unsupported-input and
error values, and active-operator time. As in v1, the adapter cannot author a
`core_hash`, artifact ref or trusted result identity.

The host validates the draft, derives and freezes any operation result and
receipts, then creates `AdapterResponseEnvelopeV2`:

```json
{
  "schema_version": "adapter-response-envelope/v2",
  "protocol_version": "subject-adapter/v2",
  "execution_mode": "local_observation",
  "execution_id": "018f1111-2222-7333-8444-555555555555",
  "operation_id": "op-0001-acquire",
  "operation": "acquire",
  "request_core_hash": "sha256:5555555555555555555555555555555555555555555555555555555555555555",
  "status": "supported",
  "result_core_hash": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "result_schema_version": "local-acquisition-observation/v1",
  "mutation_receipt_hashes": [],
  "compensation_receipt_hashes": [],
  "credential_use_receipt_hashes": [],
  "unsupported_inputs": [],
  "active_operator_ms": 0,
  "responded_at": "2026-08-12T18:00:03Z",
  "core_hash": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
}
```

The conditional v1 outcome rules are retained: a supported envelope has a
result identity and no error; failed/unsupported has a typed safe error; only
unsupported may list unsupported inputs. V2 additionally binds the exact
request hash and mode, eliminating cross-context envelope reuse. Diagnostics,
sandbox and egress records remain separately frozen and are referenced by the
completed operation record.

## 4. Limits and enforcement map

| Contract field | Existing enforcement/report mechanism |
|---|---|
| `wall_clock_ms` | supervisor deadline plus host ceiling; sandbox result records duration and termination |
| request/response bytes | `encodeFrame`/`decodeFrame` and supervisor stdout cap |
| output files/bytes/depth | `collectBoundedTree`/`freezeAdapterOutput` |
| diagnostic bytes | `freezeDiagnostics` truncation and manifest |
| diagnostic line bytes | SDK diagnostic line cap; V2 must take the value from the request instead of a divergent constant |
| environment names | V2 protocol-specific allowlist and exact child environment construction |
| logical roots | observation-root confinement, `ArtifactStore`, host-authored operation roots and mount checks |
| control expectations | `sandboxControlReport`; mismatch refuses before dispatch |
| egress policy | existing `EgressAllowlistPolicyV1` and `decideEgress`; local-process result continues to report kernel denial unsupported |
| capabilities | existing closed broker enum/grant and privileged refusal |

Memory, CPU and PID values are not added as numeric local limits. The
local-process host cannot enforce them. A container profile reports the
corresponding controls only when its existing qualification proves them; the
current contracts do not expose reliable per-invocation numeric enforcement,
so decorative numbers would overstate the mechanism.

## 5. Local plan

`LocalObservationPlanV1` is frozen before any dispatch and contains:

- observation id;
- exact adapter id/version, V2 manifest hash, V2 receipt hash, artifact hash,
  protocol and certification authenticity;
- exact ordered operation specs: sequence, stable operation id, operation,
  closed payload and timeout;
- input specifications discriminated as `host_provisioned` (role, confined
  logical path, media type, bytes and expected SHA-256) or `acquired` (role,
  expected kind, no invented output hash);
- the full limits contract, full egress policy and allowed capabilities;
- exact allowed credential-handle ids, if any;
- creation and expiry instants;
- `not_scored: true`, `not_governor_authorized: true`, the closed unsupported
  claim list and `evidence_authenticity: unauthenticated_local_record`;
- its core hash and no signature field.

An acquired artifact's actual ref and hash first appear in its completed
operation record and are then eligible as input to later operations. A
host-provisioned artifact is copied/frozen beneath the observation input root
and re-hashed before the plan freezes. Absolute source paths are operator input,
not retained protocol facts.

Plan validity rules include:

- expiry is after creation and every request deadline is at or before expiry;
- operation ids and input ids are unique;
- plan operations are a subset of manifest and receipt scope;
- every referenced input exists earlier or is host-provisioned;
- the cleanup suffix is explicit;
- final `report-residue` is present when the certified profile declares it;
- any completed start has a later stop when stop is certified, and any completed
  install has a later uninstall;
- compensation names only mutations retained during this observation;
- local claim constants and unsupported list are exact.

## 6. State machine and operation records

The local coordinator advances one immutable plan cursor:

```text
plan_frozen
  -> admission_verified
  -> ready
  -> operation_declared
  -> operation_dispatched
  -> operation_completed -> ready
  -> cleanup_started
  -> cleanup_observed
  -> output_frozen
  -> result_frozen
```

From `operation_declared`, recovery may return to `ready` only when dispatch is
provably absent. From `operation_dispatched`, recovery may move to
`operation_completed` only by reconciling already-frozen host evidence. If
neither is provable, it moves to `cleanup_started` with the operation marked
`ambiguous_not_replayed`. Main-sequence dispatch never resumes after failure or
ambiguity; only the frozen cleanup suffix does.

`LocalObservationOperationRecordV1` is a closed union:

- `declared`: request hash, plan hash, prior record hash, idempotency key and
  declared time;
- `dispatched`: declared-record hash and dispatch time, frozen before the host
  call;
- `completed`: exact request ref/hash, V2 response envelope, sandbox manifest
  and result, diagnostics, capability/egress/mutation/compensation refs, retained
  inputs/outputs, structural validation results, timings and completion time;
- `failed`: exact request ref/hash, any frozen V2 error envelope and host
  evidence, safe failure reason, cleanup requirement and failure time;
- `ambiguous_not_replayed`: dispatched-record hash, recovery observation and
  cleanup-required reason.

Same operation id plus same request hash returns its existing terminal record
without dispatch. Same id plus different bytes fails
`LOCAL_OBSERVATION_REPLAY_CONFLICT`. An ambiguous external effect is never
called “failed cleanly” and never retried merely to make progress.

### Operation availability and transitions

No operation gains implicit mutation authority. Every mutation must use an
existing declared mutation class, pass the capability broker and retain intent
before effect plus receipt after effect. The per-operation rules are:

| Operation | Available / prerequisite | Retained evidence | Mutation and cleanup rule | After freeze |
|---|---|---|---|---|
| `acquire` | Optional; frozen source descriptor exists | request/envelope, attempts, diagnostics, acquired artifact ref/hash | declared mutations reconcile; acquired bytes become immutable input | refused |
| `validate-package` | Exact acquired/host-provisioned package exists | frozen package identity, typed structural checks, request/envelope, diagnostics | expected read-only; any disclosed mutation still reconciles | refused |
| `install` | Certified op and structurally checked package | request/envelope, outputs, mutation intents/receipts, post-op residue | outstanding mutations require compensation or uninstall plan | refused |
| `configure` | Declared configuration inputs; install if plan requires | request/envelope, outputs, mutation intents/receipts, diagnostics | every change declared; cleanup preserves unresolved mutations | refused |
| `start` | Setup prerequisites completed | request/envelope, process/service descriptors, mutations, post-op residue | schedule stop when certified; never infer daemon ownership | refused |
| `interact` | Start completed if present; interaction inputs exist | request/envelope, bounded outputs/diagnostics, mutations, post-op residue | all effects declared; no result is evaluated | refused |
| `translate-evidence` | Frozen evidence inputs and read-only mount exist | request/envelope and bounded translation artifacts | output is a local translation draft, not canonical evidence | refused |
| `collect-outputs` | Producing operation completed and op certified | request/envelope and exact bounded output refs/hashes | collection adds no trusted role; disclosed effects still reconcile | refused |
| `project` | Frozen translation/evidence input exists | request/envelope and bounded projection artifacts | projection remains local, untrusted adapter output | refused |
| `stop` | Cleanup suffix; matching start completed | request/envelope, mutations and post-stop residue | unsupported/failed/ambiguous stop makes cleanup incomplete | refused |
| `uninstall` | Cleanup suffix; matching install completed; stop first if needed | request/envelope, compensation/mutation receipts and residue | unresolved installation mutation makes cleanup incomplete | refused |
| `report-residue` | Named baseline/post/final checkpoint; op certified | request/envelope, declared scope and residue items | final observation is necessary, not sufficient, for cleanup-complete | refused |
| `compensate` | Cleanup suffix; exact outstanding mutation receipts exist | request/envelope and compensation receipts per mutation | receipts reconcile only named mutations; failures remain outstanding | refused |

An operation missing from manifest/receipt scope is unavailable, not a no-op.
For the current Independent-QA v1 adapter, `collect-outputs` and `stop` would
remain unavailable unless its new V2 manifest implements and certifies them.

## 7. Local result

`LocalObservationResultV1` binds:

- plan hash and exact adapter/manifest/receipt/artifact/protocol identity;
- actual certification authenticity;
- ordered request, declared/dispatched/completed/ambiguous records and exact
  ancestry;
- start/end times and per-operation durations;
- bounded diagnostic refs and scan summaries;
- mutation intents/receipts, compensation receipts and outstanding ids;
- retained input, output and evidence refs/hashes;
- structural contract checks using only `conforms`, `does_not_conform` or
  `not_applicable`;
- baseline/final residue, stop, compensation and uninstall outcomes;
- cleanup status and reason codes;
- observation status: `observed_complete`, `observed_with_unsupported`,
  `observation_failed`, `cleanup_incomplete`, `observation_expired` or
  `observation_cancelled`;
- mandatory claim constants/list, `unauthenticated_local_record`, core hash and
  no signature.

Representative result excerpt:

```json
{
  "schema_version": "local-observation-result/v1",
  "observation_id": "018f1111-2222-7333-8444-555555555555",
  "plan_hash": "sha256:1111111111111111111111111111111111111111111111111111111111111111",
  "protocol_version": "subject-adapter/v2",
  "adapter_manifest_hash": "sha256:4444444444444444444444444444444444444444444444444444444444444444",
  "certification_receipt_hash": "sha256:6666666666666666666666666666666666666666666666666666666666666666",
  "adapter_artifact_hash": "sha256:7777777777777777777777777777777777777777777777777777777777777777",
  "certification_authenticity": "locally_observed_unauthenticated",
  "operation_record_hashes": ["sha256:8888888888888888888888888888888888888888888888888888888888888888"],
  "retained_input_refs": [],
  "retained_output_refs": [],
  "structural_validation": [{"contract": "AdapterResponseEnvelopeV2", "status": "conforms", "evidence_refs": []}],
  "cleanup": {
    "status": "cleanup_complete",
    "stop": "not_applicable",
    "compensation": "not_applicable",
    "uninstall": "not_applicable",
    "residue": "observed_clean"
  },
  "status": "observed_complete",
  "started_at": "2026-08-12T18:00:00Z",
  "ended_at": "2026-08-12T18:00:03Z",
  "not_scored": true,
  "not_governor_authorized": true,
  "unsupported_claims": ["score", "qualification", "governor_authorization", "reveal", "judge_evaluation", "governed_finalization"],
  "evidence_authenticity": "unauthenticated_local_record",
  "core_hash": "sha256:9999999999999999999999999999999999999999999999999999999999999999"
}
```

## 8. Host and SDK boundary

### Adapter SDK

The implementation changes the existing SDK loop, not adapter authority:

- parse v1 and v2 handshake/request/response messages strictly;
- expose `protocolVersion` and `executionMode` on the handler context;
- expose a typed `AdapterRequestV1 | AdapterRequestV2`, with a compatibility
  helper for shared operation inputs;
- validate the v2 context discriminator, operation-correlated payload,
  ancestry, claim constants and forbidden local fields before calling a handler;
- reject unknown versions/modes and never coerce a v1 request into v2;
- keep the no-shell, no-truth, no-selection, no-validity, no-finalizer export
  boundary and the contracts-only dependency.

### Adapter host

The existing host gains:

- deterministic version/mode selection bound to manifest and receipt scope;
- v2 negotiation and request construction;
- strict host-side request/context validation before executable-digest check and
  spawn;
- protocol-specific child environment names;
- `SandboxInvocationManifestV2` and `AdapterResponseEnvelopeV2` construction;
- exact plan/limits/input checks for local mode;
- the same deadlines, process-tree cleanup, artifact retention, output freeze,
  brokers, mutation ledger and supervisors;
- a separate observation artifact root and an irreversible local-mode marker so
  its results cannot be handed to governed finalization.

The host does not create plans, score outputs, validate product correctness or
authorize a governor. Product-specific logic remains impossible at this layer.

## 9. Claim firewall checks

The load-bearing negative path is:

```text
local schema/mode/root
  X governed lifecycle role
  X evaluator input selector
  X validity builder
  X generic index
  X finalizer
  X public bundle
```

Implementation MUST prove all six refusals. It MUST also prove that changing
either constant to false, adding a score/qualification field, injecting a
governed reference, renaming a local result to a governed schema, or selecting
v1 for local mode is rejected for the targeted reason. There is no import,
convert, certify-result or tier-upgrade command.

## 10. Example review

The examples above were manually checked for shape and semantics against the
proposed rules. Repeated hexadecimal values are conspicuous role placeholders,
not recomputed canonical hashes or executable golden fixtures:

- every object is closed and every hash has a named role;
- the local request contains no governed or judge field;
- both exclusion booleans and the complete unsupported-claim list are present;
- concrete limits agree with the diagnostics cap and existing host ceilings;
- default egress denies all named hosts and loopback;
- the first request ancestry contains no invented predecessor;
- adapter identity is host-derived and response drafts compute no core hash;
- the result uses observation language and has no signature, validity, score,
  qualification, reveal, attestation or public-bundle member.

No example is a production schema, canonical hash vector or executable fixture.
