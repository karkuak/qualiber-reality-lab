# ADR-ERL2-037 — `subject-adapter/v2` separates governed execution from local observation

- **Status:** accepted
- **Date:** 2026-08-12
- **Deciders:** Lab Core Owner, Adapter Protocol Owner, Integrity/Security Owner,
  Certification Owner
- **Extends:** ADR-ERL2-001, ADR-ERL2-002, ADR-ERL2-005,
  ADR-ERL2-014, ADR-ERL2-018, ADR-ERL2-025 and ADR-ERL2-036
- **Supersedes:** nothing
- **Evidence:**
  `docs/evidence/live-002-unscored-dry-run-retry-20260812T125150Z/` and
  `docs/evidence/local-observation-design-gate-20260812/`

## Context

The governed journey and the adapter protocol currently meet at three closed
`subject-adapter/v1` request contracts. Every one asserts governed ancestry:

| Request | Operations | Required governed ancestry |
|---|---|---|
| `AcquisitionAdapterRequestV1` | `acquire` | acquisition preregistration, acquisition source manifest, visible step, resource-limit hash |
| `PackageVerificationRequestV1` | `validate-package` | acquisition preregistration and record, integrity and provenance policy hashes, visible step |
| `AdapterStepRequestV1` | all later operations | execution plan, visible step and resource-limit hash |

The required visible step is the subject-visible half of a governed step whose
other half binds encrypted judge expectations. The development governor inputs
needed to produce that graph are not defined. The discovery evidence verified
that inventing them would require a trust root, signer-role assignments, judge
expectations and opaque policy hashes with no normative meaning.

Independent subprocess probes then showed that the real certified v1 adapter
refuses requests without those fields, including `report-residue`, and accepts
fixture-shaped requests that contain them. A local observation therefore cannot
dispatch v1 honestly. Reusing a local plan hash in a field named
`acquisition_preregistration_hash` would retain a false statement, not a useful
compatibility shim.

At the same time, the execution substrate is already reusable. `AdapterHost`
owns protocol framing, per-dispatch executable-digest verification, request and
response byte ceilings, deadlines, process-tree termination, environment
allowlisting, mount checks, capability/credential/egress adjudication, mutation
and compensation accounting, diagnostics, output retention and output freeze.
`ArtifactStore` already supplies crash-idempotent immutable publication. The
architectural defect is the request-context model, not the run substrate.

## Decision

### 1. Add `subject-adapter/v2`; do not change v1

The new identifier is exactly `subject-adapter/v2`.

`subject-adapter/v1`, its three requests, its negotiation, its response
envelope, its manifest and `ADAPTER-CERT-V1` remain byte- and
semantics-compatible. No v1 governed field becomes optional. Existing governed
v1 runs continue through the existing journey, reveal, evaluation, validity and
finalization path.

V2 has one closed `AdapterRequestV2` envelope and a closed, discriminated
`execution_context` union:

```text
AdapterRequestV2
  common, context-neutral request facts
  execution_context
    governed
      acquisition | package_verification | post_plan
      all semantic equivalents of the corresponding v1 governed ancestry
    local_observation
      local plan, concrete limits, frozen inputs and mandatory claim exclusions
  closed operation_payload
```

The governed v2 branch is normatively defined so the union cannot later grow by
reinterpretation. Its first implementation is deferred: a v2 manifest MUST NOT
advertise `governed` until the host, SDK and certification suite implement and
certify that mode. Governed execution continues on v1. A v2 governed request
sent before that support exists fails with
`ADAPTER_EXECUTION_MODE_UNSUPPORTED`; it never falls back to v1 or to local
observation.

### 2. Local observation is a separate evidence class, not a tier

The local branch is `mode: "local_observation"` and requires all of:

- the frozen `local-observation-plan/v1` hash;
- a concrete `LocalObservationLimitsV1`, not arbitrary commitment bytes;
- exact input artifact references the host has re-hashed;
- an existing closed egress policy and a closed capability set;
- `not_scored: true` and `not_governor_authorized: true` as schema constants;
- the complete, closed list of unsupported claims.

Its closed shape has no property capable of carrying a governor identity,
preregistration, execution plan, visible journey step, judge expectation,
trust-policy hash, score, qualification or reveal state. The host and SDK also
scan field names before dispatch so an implementation error cannot route a
forbidden governed field through the wrong branch.

Local observation produces `local-observation-result/v1`. It may report what
was invoked, retained, structurally validated, mutated and cleaned. Its status
vocabulary is observation-only. It cannot produce a validity result, journey or
domain result, generic evaluation index, final attestation, public verification
bundle, score or qualification.

### 3. Put protocol and observation contracts in `@erl2/contracts`

The framing codec and both protocol majors stay in `@erl2/contracts`, preserving
ADR-ERL2-014's single-codec decision. V2 protocol messages remain in
`adapter.schema.json`/`protocol.ts`. Local plan, limits, operation record and
result contracts live in a new closed `observation.schema.json` group in the
same package. A new npm package would add a dependency and removal boundary for
data contracts only; it is not justified.

Ten top-level additive contracts are reserved for the implementation package:

| Proposed ID | Contract |
|---|---|
| ERL2-C-161 | `SubjectAdapterManifestV2` |
| ERL2-C-162 | `SubjectAdapterCertificationReceiptV2` |
| ERL2-C-163 | `AdapterProtocolNegotiationV2` |
| ERL2-C-164 | `AdapterRequestV2` |
| ERL2-C-165 | `AdapterResponseEnvelopeV2` |
| ERL2-C-166 | `SandboxInvocationManifestV2` |
| ERL2-C-167 | `LocalObservationLimitsV1` |
| ERL2-C-168 | `LocalObservationPlanV1` |
| ERL2-C-169 | `LocalObservationOperationRecordV1` |
| ERL2-C-170 | `LocalObservationResultV1` |

The numbers are reservations in this ADR, not schemas or registry entries.
Nested payload/context variants are `$defs`, not independently frozen
contracts.

Existing host-authored records without a protocol claim — sandbox result,
capability grant, diagnostics manifest, egress decision, mutation intent and
receipt, and compensation receipt — are reused with the observation id as their
execution `run_id`. `SandboxInvocationManifestV1` cannot be reused because it
asserts `subject-adapter/v1`; its additive v2 counterpart is therefore required.

### 4. Resource limits are concrete and enforceable

`resource_limit_hash` is not accepted in the local branch. The new limits
contract exposes only values the existing host applies or reports:

- wall-clock, request, response, output-file, output-byte, output-depth,
  diagnostic-byte and diagnostic-line ceilings;
- exact environment-variable names;
- logical input, workspace and output roots confined beneath the observation
  root;
- sandbox-control expectations, each either `enforced` or explicitly
  `unsupported_permitted`.

The plan embeds the full existing `EgressAllowlistPolicyV1`, including explicit
loopback hosts, and its permitted capability ids. The result binds the actual
`SandboxInvocationManifestV2` and control report. A field with no enforcement
or report mechanism is excluded.

### 5. Version and mode negotiation is explicit and downgrade-safe

A v1-only adapter continues to publish `SubjectAdapterManifestV1`. A v2-capable
adapter publishes `SubjectAdapterManifestV2`, whose non-empty
`protocol_support` array binds protocol, modes, operations and package kinds as
one scope. A dual-protocol artifact lists both profiles in its v2 manifest and,
for compatibility with an unchanged v1 host, also publishes a v1 manifest and
receipt over the same new artifact bytes.

The v1 handshake is unchanged. The v2 host offers an ordered closed version
list plus a required execution mode. The adapter returns one version and the
same mode. The host independently chooses the highest mutually supported,
manifest-advertised, receipt-certified profile and rejects any other answer.
`local_observation` has a minimum and only permitted protocol of v2, so a v1
selection is a typed downgrade refusal. A v1-only adapter receives no operation
frame for a local request.

### 6. Certification assurance changes, so the suite changes

The existing `ADAPTER-CERT-V1` checks artifact identity, v1 negotiation,
operations, package kinds, bounds, determinism, ancestry, oracle partition,
mutation disclosure, deadline/tree termination, post-freeze refusal and
residue declaration. Its receipt does not explicitly bind a protocol/mode
matrix and it exercises only governed-shaped v1 requests.

V2 certification adds assurance semantics: exact protocol/mode/operation/package
scope, local request-shape controls, refusal of governed stand-ins in local
mode, claim-boundary controls, local lifecycle/cleanup and deterministic
recovery checks. The suite is therefore `ADAPTER-CERT-V2`, not merely because
the wire major changed. Its additive receipt binds those scopes explicitly.

A v1 receipt remains valid only for its frozen v1 manifest and artifact bytes.
It never authorizes v2. Any adapter code change yields a new artifact digest,
new manifest and new receipt. A dual artifact that must remain usable by an
unchanged v1 host is certified separately for its v1 manifest and its v2
manifest. Its V2 receipt certifies only the explicitly listed V2 profiles; the
companion V1 receipt alone authorizes governed V1 dispatch.

No signature is required for a local observation plan or result. This
repository has no normative authorized development signer for those records.
They are core-hashed and carry the constant authenticity label
`unauthenticated_local_record`. Existing certification authenticity remains a
separate field and may be `locally_observed_unauthenticated`; neither label can
be promoted by the observation.

### 7. Reuse the host; add no second run engine

`AdapterHost` is extended in place with a selected protocol/mode and strict
context validation. All sandbox, retention, mutation, compensation and freeze
primitives remain one implementation.

The local vertical slice may add one linear observation coordinator. It is not
a second journey engine: it has no selection, hidden state, reveal, evaluation,
validity, finalization, branching policy or scoring. It advances the exact
operation sequence frozen in the plan through a small pure state reducer and
delegates every external effect to `AdapterHost`.

Before dispatch it freezes a `declared` operation record; after the host has
frozen its evidence it freezes a `completed` record. On recovery:

- a completed operation is returned without dispatch;
- host evidence with no completed record is reconciled and completed without
  dispatch;
- a declared-only operation whose dispatch cannot be disproved is ambiguous and
  is never repeated;
- a different request under the same operation id is a conflict;
- after an ambiguity or failure only the plan's cleanup suffix may continue;
- output freezes after cleanup, and no adapter operation runs afterward.

The result says `cleanup_incomplete` whenever the retained evidence cannot prove
the planned cleanup. It never upgrades an unknown into clean.

### 8. The claim firewall is structural

Local evidence is written under a distinct observation root, uses distinct
schemas and repeats both exclusion constants in request, plan and result.
Governed evaluators and finalizers continue to consume only their current
closed governed contracts and lifecycle roles. Local schemas are not added to
any scoring selector, terminal closure, signer inventory, run record or public
bundle. Any attempt to pass a local plan/result to scoring or finalization is a
schema/role refusal.

There is no conversion command, tier upgrade, reveal operation or local-to-run
import. CLI and documentation use “observation”, “conforms/does not conform” and
“cleanup complete/incomplete”; they do not use pass, valid, qualified, scored or
certified for an observation outcome.

### 9. Operation availability is certified and plan-bounded

All thirteen protocol operations remain in the closed protocol enum. A local
plan may use only the intersection of the manifest profile, certification
scope, host support and the operation prerequisite table. No operation is
silently synthesized.

`acquire` is optional when an input is host-provisioned. `validate-package`,
install/configure/start/interact, translation/collection/projection and
stop/uninstall are available only when their specific prerequisites and
certified declarations hold. Projection output is retained as untrusted local
output and is never admitted as a governed `GenericClaimSetV1`. `compensate` is
available only for retained outstanding mutation receipts. `report-residue` is
a required final cleanup observation when certified; its absence or unsupported
outcome makes cleanup incomplete. Nothing is available after output freeze.

## Compatibility consequences

- Existing v1 request and response bytes, tests, manifests, receipts and
  governed behavior are unchanged.
- A v1-only adapter asked for local observation fails before dispatch with a
  typed version/mode error.
- A dual adapter receives v1 request shapes during governed v1 runs and v2
  request shapes during local observation; the SDK never rewrites one as the
  other.
- Unknown versions, modes, context fields, operation payload fields and response
  fields fail closed.
- Removing the local coordinator and its CLI entry leaves governed v1 fully
  operable. Removing all adapters still leaves the development fake port and
  core/evaluation packages independent, preserving the existing removability
  tests.

## Security boundary

V2 local observation detects accidental adapter substitution at the existing
per-dispatch check, mismatched manifests/receipts, artifact digest changes,
unsupported modes or operations, illegal ordering, output mutation after
freeze, declared cleanup failures and claim overreach.

It does not close the malicious same-user check-to-spawn race, provide kernel or
container isolation when the selected profile lacks it, authenticate an
unsigned certifier, establish product correctness, prove unobserved evidence is
complete, or prevent an operator from misdescribing the result outside the
system. Those limitations remain explicit in the result.

## Alternatives

The comparison uses six criteria: honesty of retained evidence, genericity,
implementation size, v1 compatibility, time to a first bounded product-adapter
observation, and preservation of the future formal-evaluation path.

| Alternative | Honesty / genericity | Size / compatibility | Time / formal path | Decision |
|---|---|---|---|---|
| Make v1 governed fields optional | Ambiguous ancestry weakens the meaning of every existing request. | Small edit but a broad certified semantic break. | Fast only by damaging the formal path. | Rejected. |
| Populate v1 governed hashes with local plan hashes | Retains false field-role claims and arbitrary stand-ins. | Superficially small and wire-compatible, semantically incompatible. | Fastest dishonest path; poisons later evidence. | Rejected. |
| Create a fake development governor | Invents trust, signer and judge decisions; product-neutral only in name. | Requires a second authority/configuration surface. | Delays local work and creates no valid formal authority. | Rejected. |
| Use test keys and golden registry fixtures | Fixture identities are not normative development inputs. | Low coding cost but silently imports test trust into production design. | Fast but neither local truth nor formal evidence. | Rejected. |
| Add an adapter-side special flag outside the protocol | Host and receipt cannot bind the context or claim boundary. | Small adapter change with a large compatibility/security blind spot. | Quick for one adapter, not generic and not a formal stepping stone. | Rejected. |
| Call adapter internals directly | Loses the certified subprocess, artifact identity, bounds and retention boundary. | Creates product coupling and a parallel execution path. | Short demo path with high migration cost back to formal execution. | Rejected. |
| Wait for full governed infrastructure | Honest and preserves the formal path. | No compatibility change, but requires unresolved trust/governance decisions outside this scope. | Defers all local integration evidence indefinitely. | Deferred for formal evaluation, not selected for observation. |
| Add v2 local observation | Truthful, generic and structurally separate from governed claims. | Thin additive extension; v1 remains exact. | Shortest honest path and leaves the formal path intact. | Accepted. |

## Thin-extension limit

The expected complete implementation is 24–32 Reality Lab files across
contracts, host/SDK, one coordinator/CLI seam and tests; ten new top-level
contracts; at most two new production modules (`localObservation.ts` and a CLI
command module); and targeted changes to one adapter followed by
re-certification. Existing `AdapterHost`, supervisors, `ArtifactStore`, output
freezer, brokers and mutation ledger are reused.

Stop and return
`CHANGES REQUIRED — V2 DESIGN EXCEEDS THIN EXTENSION BOUNDARY` if implementation
needs any of: a second orchestration engine, a duplicate lifecycle machine, a
product-specific contract field, a new signer/governor system, scoring work, UI
work, v1 semantic weakening, or more than one local coordinator.

## Consequences and required evidence

The implementation packages, ownership, tests and stop conditions are normative
in `docs/handoff/subject-adapter-v2-work-packages.md`. The load-bearing tests and
negative controls are mapped in
`docs/ledger/subject-adapter-v2-requirements-to-tests.md`.

This ADR approves the architecture only. It creates no schema, SDK behavior,
host behavior, adapter support, certification or runtime command.
