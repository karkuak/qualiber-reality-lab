# `subject-adapter/v2` local-observation claim and threat matrix

**Status:** normative claim boundary for implementation

**Applies to:** `mode: local_observation` only

## Allowed claim vocabulary

A local result may make only claims directly supported by retained host evidence:

| Claim | Minimum retained evidence | Permitted result vocabulary |
|---|---|---|
| exact adapter invoked | executable digest, selected manifest/receipt, negotiation and sandbox invocation | `invoked` / `not_invoked` |
| request structurally accepted | frozen request and signed-free response envelope identity | `accepted` / `rejected` / `unknown` |
| package structurally checked | request, envelope and retained validation diagnostics/output | `conforms` / `does_not_conform` / `not_observed` |
| operation completed | declared/completed operation record and host evidence | `completed` / `failed` / `ambiguous` / `not_dispatched` |
| artifacts retained | host output manifest and artifact hashes | exact artifact references only |
| host controls applied | sandbox invocation/result and control report | per-control `enforced` / `unsupported_permitted` / `failed` |
| mutation observed | mutation intents and receipts | exact disclosed mutations only |
| compensation observed | compensation request and receipts | exact attempted/completed compensation only |
| residue observed | baseline/post-operation/final residue envelopes | exact observations and scope only |
| cleanup disposition | complete operation/evidence set | `cleanup_complete` / `cleanup_incomplete` |

“Conforms” means only that the observed artifact satisfied the adapter's local,
structural check under the frozen plan. It is not validity, correctness,
fitness, quality, certification, qualification or a score.

## Claims that are structurally unavailable

Every local plan, request and result contains `not_scored: true`,
`not_governor_authorized: true` and the closed unsupported-claim list:

- score;
- qualification;
- governor authorization;
- reveal;
- judge evaluation; and
- governed finalization.

The schemas have no tier, grade, pass/fail, validity, generic evaluation index,
judge expectation, hidden state, trust-policy claim, public-verification role or
authorized signer field. Projection output remains an untrusted retained local
artifact and cannot be represented as a governed claim set.

## Structural firewall

| Layer | Required separation |
|---|---|
| Protocol | `execution_context.mode` is a closed discriminator. Local context cannot represent governed ancestry fields. |
| Schema | Local records use `local-observation-*/v1` schemas in an observation schema group; governed consumers do not list these roles. |
| Filesystem | Local evidence is rooted beneath a distinct observation id, never a governed run workspace. |
| Host | Selected manifest and receipt must authorize v2 plus local mode before dispatch. No downgrade retry. |
| SDK | Strict parsing plus recursive forbidden-field scan occurs before a handler receives the request. |
| Lifecycle | The local coordinator is a linear reducer with no selection, hidden, reveal, evaluation, validity or finalization transition. |
| Authenticity | Local plan/result use the constant `unauthenticated_local_record`; certification authenticity remains separate and cannot promote them. |
| Evaluation | Scoring, evaluator, terminal and public-bundle entry points reject local schema roles before content inspection. |
| Language | CLI/docs use observation vocabulary and never label a local outcome passed, valid, qualified, scored or certified. |
| Conversion | No import, promotion, tier-upgrade or local-to-governed conversion command exists. |

## Threat matrix

| ID | Threat | Preventive control | Required negative control | Residual statement |
|---|---|---|---|---|
| SA2-T-001 | Put a local plan hash in a governed preregistration field | V1 stays closed; local uses a distinct v2 branch with no such property | Try every governed hash role in a local request; schema and SDK reject before dispatch | Malicious prose inside an input artifact is untrusted content, not a protocol claim. |
| SA2-T-002 | Downgrade local observation to v1 | Host offers v2 only for local mode and selects certified scope before handshake | Adapter returns v1; host returns downgrade refusal and sends no operation | A compromised host is outside adapter-protocol assurance. |
| SA2-T-003 | Advertise an uncertified mode/operation/package kind | Receipt binds the exact profile and admission intersects all four dimensions | Alter each manifest dimension independently; admission refuses | Receipt authenticity still depends on the configured certification policy. |
| SA2-T-004 | Reuse a v1 receipt for v2 | Distinct receipt contract and `ADAPTER-CERT-V2` suite | Pair a v1 receipt with a v2 profile; admission refuses | None within correctly implemented admission. |
| SA2-T-005 | Smuggle score/qualification through generic metadata | No arbitrary metadata/payload object; recursively forbidden names; closed result roles | Inject forbidden names at every object depth and in adapter output role ids | Free-text output may contain words; it never gains a governed role. |
| SA2-T-006 | Route local result into evaluation/finalization | Consumers retain closed governed input roles | Submit each local record type to every scoring, reveal, terminal and verifier entry point | A future consumer must preserve the same closed-role test. |
| SA2-T-007 | Treat projection as a governed claim set | Projection output has an observation-only artifact role | Attempt role substitution/import; schema and role registry refuse | Human readers can still over-interpret raw output; labeling and docs mitigate this. |
| SA2-T-008 | Bypass resource controls with commitment-only values | Local plan carries concrete bounded limits; host clamps to manifest/host ceilings | Exceed every limit individually and combine limits; host refuses or terminates | Current local sandbox reports some kernel/container controls as unsupported. |
| SA2-T-009 | Escape through environment, egress, credentials or capabilities | Exact environment names, existing egress policy, capability grants and credential handles; default deny | Probe undeclared environment, proxy, redirect, loopback, link-local, metadata, socket and privileged capability paths | Unsupported OS isolation controls remain explicitly visible; local observation is not hostile-code containment. |
| SA2-T-010 | Modify mounted inputs after host hashing | Existing mount fingerprints before/after dispatch | Mutate an input during each operation; host records/refuses tamper | Filesystem and kernel guarantees are limited to the current host control report. |
| SA2-T-011 | Hide mutation or cleanup failure | Existing intent/receipt ledger, compensation and residue records; result defaults incomplete | Omit mutation declaration, fail compensation, omit/unsupported residue and crash during cleanup | External side effects outside declared/observable scopes may remain undetected. |
| SA2-T-012 | Replay a side-effectful operation after a crash | Declared/completed records and ambiguous-no-replay rule | Crash after declaration, dispatch and evidence freeze; ensure no second dispatch | Manual remediation may be required after ambiguity. |
| SA2-T-013 | Dispatch after output freeze | Existing host freeze guard | Attempt every operation after freeze | None within the host boundary. |
| SA2-T-014 | Invent authenticity for local records | No signature field; constant unauthenticated label | Add signer/signature/authorized label or tamper bytes | Integrity is local core hashing, not identity-backed authenticity. |
| SA2-T-015 | Turn local observation into a second run engine | At most one linear coordinator; all external effects delegate to `AdapterHost` | Architecture test forbids local selection/reveal/evaluator/finalizer imports and duplicate supervisors | Workflow logic still requires normal code review. |
| SA2-T-016 | Couple generic contracts to one adapter/product | Generic ids, typed artifact refs and operation payloads only | Fixture set uses at least two neutral shapes; scan schemas for product identifiers | Adapter-specific semantics can live only in frozen input/output artifacts. |
| SA2-T-017 | Carry old certification over changed executable bytes | Per-dispatch artifact digest and receipt binding | Flip one executable byte; admission/host refuse | None if digest verification remains mandatory. |
| SA2-T-018 | Misreport unsupported operation as success | Manifest/receipt/handshake intersection and typed unsupported response | Invoke every omitted operation; require typed unsupported and no side effect | Honest declaration remains an adapter certification property. |

## What the design protects

- truthfulness of the local request context;
- separation from governed lifecycle and claim roles;
- exact artifact, manifest, receipt and operation identity at the host boundary;
- host-enforced bounds that already have an enforcement/report path;
- retention of operation, diagnostics, output, mutation, compensation and
  cleanup evidence;
- conservative crash recovery without blind replay; and
- removable, adapter-neutral implementation scope.

## What the design does not protect

- it does not score, validate or qualify a product or subject;
- it does not provide governor authorization, reveal, judge evaluation or
  governed finalization;
- it does not create a trustworthy judge expectation, trust root or signer;
- it does not prove semantic correctness of an adapter's private analysis;
- it does not make unsigned local records authentic to a third party;
- it does not claim containment controls the current sandbox reports as
  unsupported;
- it does not guarantee cleanup outside the host's declared and observable
  residue scopes; and
- it does not authorize untrusted hostile-code execution.

Any implementation or operator output that implies one of these excluded
protections is a claim-boundary failure, even if all software tests pass.
