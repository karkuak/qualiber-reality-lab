# `subject-adapter/v2` compatibility and recertification plan

**Status:** approved design; no implementation has begun

**Normative decision:** [ADR-ERL2-037](../adr/ADR-ERL2-037.md)

**Protocol design:**
[subject-adapter-v2-protocol.md](../decisions/subject-adapter-v2-protocol.md)

## Compatibility invariant

`subject-adapter/v1` remains byte- and semantics-compatible. Its closed request
contracts continue to require governed preregistration, execution-plan and
visible-step ancestry. No field becomes optional, no local value is placed in a
governed hash role, and an existing v1 manifest or certification receipt is not
reinterpreted as v2 authority.

V2 is additive. It introduces an explicit execution-mode discriminator and a
local-observation evidence class while extending the existing host, SDK and
framing implementation. Governed execution continues to select v1 until a
future, separately reviewed package implements and certifies governed v2.

## Compatibility matrix

| Host | Adapter artifact | Requested mode | Result |
|---|---|---|---|
| unchanged v1 | unchanged v1 | governed | Existing behavior, bytes and certification scope remain unchanged. |
| unchanged v1 | dual artifact with a v1 manifest and v1 receipt | governed | V1 selection succeeds only under the new artifact's separately issued v1 receipt. |
| unchanged v1 | v2-only | any | Typed unsupported protocol before an operation frame. |
| v2-capable | unchanged v1 | governed | Host selects v1; current governed behavior remains unchanged. |
| v2-capable | unchanged v1 | local observation | `ADAPTER_EXECUTION_MODE_UNSUPPORTED`; no v1 retry and no operation frame. |
| v2-capable | v2-only, local profile | local observation | V2 selection if manifest and `ADAPTER-CERT-V2` receipt authorize the exact scope. |
| v2-capable | dual, separately certified profiles | governed | Host selects v1 until governed v2 is implemented and advertised. |
| v2-capable | dual, separately certified profiles | local observation | Host selects v2; returning v1 is `ADAPTER_PROTOCOL_DOWNGRADE_REFUSED`. |
| v2-capable | v2 profile advertising uncertified governed mode | governed | Admission/certification refusal. |

Protocol, mode, operation and package-kind selection is one intersection. A host
does not negotiate a protocol and later discover that the selected receipt did
not authorize the mode.

## Manifest and receipt strategy

### V1-only artifacts

A frozen v1 artifact keeps its current `SubjectAdapterManifestV1` and
`SubjectAdapterCertificationReceiptV1`. Existing receipt validity is unchanged
provided its artifact bytes, manifest and admission policy have not changed.
It carries no v2 authority.

### V2-only artifacts

A v2 artifact publishes `SubjectAdapterManifestV2` and an
`SubjectAdapterCertificationReceiptV2`. The manifest binds non-empty supported
profiles and the receipt binds the exact certified subset. A selected profile
must occur identically in both and includes:

- protocol version;
- execution modes;
- operations;
- package kinds;
- required host controls; and
- adapter artifact identity.

The first implementation permits only `local_observation` under v2. A v2-only
artifact is intentionally unusable by an unchanged v1 host.

### Dual-protocol artifacts

A dual artifact publishes the v2 manifest with distinct protocol profiles. It
also publishes a v1 manifest for an unchanged v1 host. Because adding v2 support
changes executable bytes, the old v1 receipt cannot carry forward. The exact
new artifact is certified twice:

1. `ADAPTER-CERT-V1` issues a v1 receipt over its v1 manifest and v1 scope.
2. `ADAPTER-CERT-V2` issues a v2 receipt over its v2 manifest and local scope.

The two receipts do not cross-authorize. The host selects one complete certified
profile before negotiation and re-hashes the executable at every dispatch as it
does today.

## Components that change

The file names below are implementation scopes, not changes made by this design
package.

| Component | Planned additive change |
|---|---|
| `packages/contracts/src/protocol.ts` | Export explicit v1/v2 protocol constants and v2 frame types through the existing codec. |
| `packages/contracts/schemas/adapter.schema.json` | Add closed v2 negotiation, response envelope and sandbox-invocation definitions. |
| `packages/contracts/schemas/acquisition.schema.json` | Add V2 manifest/receipt and their scoped profile definitions; leave all v1 definitions untouched. |
| `packages/contracts/schemas/observation.schema.json` | Add limits, plan, operation-record and result contracts in a distinct schema group. |
| `packages/contracts/contract-registry.json` | Register the ten reserved additive contracts ERL2-C-161 through ERL2-C-170. |
| `packages/adapter-sdk/src/sdk.ts` | Select a strict v1 or v2 parser after negotiation; retain one dispatch loop. |
| `packages/adapter-sdk/src/ancestry.ts` | Add local v2 ordering/prerequisite checks and the forbidden-governed-field scan; preserve v1 tables. |
| `packages/core/src/adapter/host.ts` | Select a certified protocol/mode profile and build v2 frames while reusing all current process, limit, output, mutation and cleanup paths. |
| `packages/core/src/adapter/certification.ts` | Keep `ADAPTER-CERT-V1`; add a separate V2 suite and receipt. |
| `packages/core/src/adapter/admission.ts` | Admit a single exact certified profile; never promote local record authenticity. |
| one new core observation module, at most | Implement a linear plan reducer/coordinator that delegates every external effect to `AdapterHost`. |
| test fixtures and documentation | Add neutral v2 fixtures, negative controls, migration tests and operator wording. |

## Components that remain unchanged

| Boundary | Invariant |
|---|---|
| Governed v1 contracts and protocol | Exact existing schemas, negotiation, ancestry and request construction remain authoritative. |
| Governor, preregistration and selection | Local observation does not call, simulate or bypass them. |
| Journey lifecycle | No local state is introduced into selection, hidden state, reveal, evaluation, validity or finalization. |
| Evaluation and scoring | No local result is an input; no new score or aggregate is created. |
| Trust and signer inventories | No development signer is invented. Local plan/result records are unsigned and explicitly unauthenticated. |
| `ArtifactStore` | Existing atomic, immutable and crash-idempotent publication is reused. |
| Mutation/compensation primitives | Existing intent and receipt accounting is reused; uncertainty remains visible. |
| Sandbox supervisors | Existing deadline, process-tree, bounds, environment, egress, capability, mount and output controls are reused. |
| Adapter-package direction | Core still does not depend on a product or adapter implementation. |
| Public verification bundles | Local observation has no role in them and no conversion path to them. |

## `ADAPTER-CERT-V2`

The new suite is required because assurance semantics change, not merely because
the wire major changes. The current v1 suite exercises governed-shaped probes
and does not bind a protocol/mode matrix. V2 must prove all current applicable
host guarantees plus the new local claim boundary.

The exact additional certification checks are:

1. bind artifact digest, v2 manifest core hash and the exact
   protocol/mode/operation/package/control profile;
2. select v2 deterministically and reject version or mode downgrade;
3. reject `local_observation` when it is absent from the manifest or receipt;
4. reject every recursively forbidden governed field in a local request;
5. require both claim-exclusion constants and the exact closed unsupported-claim
   list in plan, request and result;
6. reject a request whose concrete limits exceed either manifest or host caps;
7. prove that request, response, diagnostics, output and process deadlines use
   the existing host enforcement path;
8. prove every operation is within the certified scope and satisfies its local
   prerequisites;
9. reject arbitrary operation payload properties and untyped hash roles;
10. retain projection only as untrusted local output and refuse it as a governed
    claim set;
11. preserve mutation intent, receipt, compensation and residue uncertainty;
12. refuse any adapter operation after output freeze;
13. prove completed-operation recovery is idempotent and declared-only ambiguity
    is never replayed;
14. prove local records cannot enter evaluation, scoring, reveal, terminal
    closure or public verification roles;
15. prove diagnostics and output cannot claim scored, qualified, certified,
    governor-authorized or finalized status;
16. rerun determinism checks for all advertised locally deterministic operations;
17. prove omitted operations remain honestly unsupported; and
18. issue no receipt when the local sandbox control report is weaker than the
    manifest's required controls.

Existing V1 certification tests continue unchanged and run beside these tests.
They are the primary regression guard against an accidental semantic migration.

## Independent-QA adapter migration

The Independent-QA repository was inspected read-only on branch
`codex/stage3-adapter-certification`, commit
`a699383045d24c91876a8dd176ae8572612c7cb1`, tree
`2156bce3df5b468eec2ee6aabba30b1c50f25e16`. Its current adapter is
`independent-analytics-validator` version `0.1.0`. It declares eleven operations
and honestly omits `collect-outputs` and `stop`.

Migration is deliberately later than the neutral Lab implementation:

1. keep the frozen v1 artifact, manifest and receipt available unchanged;
2. after Package A and independent review, add v2 parsing beside v1 parsing in
   one adapter process and retain its current operation handlers;
3. publish a new adapter version and new executable digest;
4. publish new v1 and v2 manifests for that new digest if dual-host support is
   required;
5. recertify the new digest under V1 and V2 independently;
6. preserve the exact honest operation list unless the repository separately
   implements and tests a missing operation; and
7. do not use its analytics vocabulary or behavior to shape the generic
   protocol contracts.

The current receipt core
`sha256:24d75c1c347f2c3444dc7bfe7f4f337c03f7b4eb72054717e3e47deb31e6239b`
remains evidence only for the current v1 artifact digest
`sha256:b977ac2ad4698de7145ddc1d01b4aa27f2bc4c7a8d5b13d57ce997289b976893`.
It cannot authorize the future bytes or v2.

## Migration and rollback

| Stage | Entry condition | Exit condition | Rollback |
|---|---|---|---|
| A. Generic substrate | Design approved | Neutral fixtures pass V1 regression and V2 claim-boundary tests | Remove additive v2 exports, schemas and coordinator; v1 is untouched. |
| B. Independent review | Package A evidence frozen | Protocol/security/certification owners accept exact surface | Amend design or implementation before external adapter work. |
| C. Adapter support | Review accepted | New adapter bytes pass its repository tests | Keep using frozen v1 artifact. |
| D. Recertification | New adapter digest frozen | Separate v1/v2 receipts issued | Reject new bytes; current v1 receipt remains scoped to current bytes. |
| E. Neutral vertical slice | Lab and neutral adapter receipts match | Real subprocess observation freezes result and cleanup evidence | Disable observation entry point; host v1 path remains. |
| F. Bounded product dry run | Neutral slice accepted | Frozen, unscored, non-governed local evidence only | Delete local observation root; no governed record is affected. |

There is no database or governed-record migration and no v1-to-v2 rewrite.
Removal deletes the additive contracts, v2 host selection and observation
coordinator without changing a governed v1 artifact or its verifier.

## Source trace used for this plan

- `packages/contracts/src/protocol.ts`
- `packages/contracts/schemas/acquisition.schema.json`
- `packages/contracts/schemas/adapter.schema.json`
- `packages/adapter-sdk/src/sdk.ts`
- `packages/adapter-sdk/src/ancestry.ts`
- `packages/core/src/adapter/host.ts`
- `packages/core/src/adapter/certification.ts`
- `packages/core/src/adapter/admission.ts`
- `packages/core/src/adapter/outputFreezer.ts`
- `packages/core/src/adapter/mutations.ts`
- `packages/core/src/adapter/sandbox.ts`
- `packages/core/src/adapter/containerSupervisor.ts`
- `packages/core/src/run/workspace.ts`
- `packages/core/src/run/environmentRun.ts`
- `packages/core/src/lifecycle/states.ts`
- `packages/core/src/evaluation/validity.ts`
- `packages/core/src/terminal/finalize.ts`
- `packages/integrity/src/artifacts/store.ts`
- `tests/contract/adapterContracts.test.ts`
- `tests/adversarial/adapterHost.test.ts`
- `tests/adversarial/adapterModeBinding.test.ts`
- `tests/integration/adapterCertification.test.ts`
- `tests/architecture/adapterSurface.test.ts`
- `tests/architecture/removability.test.ts`
- `docs/evidence/live-002-unscored-dry-run-retry-20260812T125150Z/`
- `docs/evidence/local-observation-design-gate-20260812/`
