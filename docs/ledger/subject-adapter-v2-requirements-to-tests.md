# `subject-adapter/v2` requirements-to-tests matrix

**Status:** planned tests; implementation not started

**Normative source:** ADR-ERL2-037 and the v2 protocol design

Test names are stable design targets. Implementers may choose the repository's
normal file layout, but each requirement must retain an automated positive or
negative test with equivalent force.

| ID | Requirement | Required test / evidence | Package |
|---|---|---|---|
| SA2-R-001 | V1 request, manifest, receipt, handshake and envelope schemas remain byte- and semantics-compatible. | `subject-adapter-v1-golden-compatibility`; validate all existing golden fixtures and compare canonical bytes. | A |
| SA2-R-002 | V1 governed execution remains the default and never enters local code. | `governed-v1-host-selection-regression`; assert selected protocol/mode and import/call trace. | A |
| SA2-R-003 | Local observation requires exactly `subject-adapter/v2`. | `local-mode-v2-only`; offer/return v1 and require no operation frame. | A |
| SA2-R-004 | Negotiation intersects receipt, manifest, host and request scopes. | `v2-profile-four-way-intersection`; independently mutate protocol, mode, operation and package kind. | A |
| SA2-R-005 | Protocol downgrade never retries silently. | `v2-downgrade-refusal`; assert typed refusal and one child process only. | A |
| SA2-R-006 | Governed v2 is defined but initially unadvertised and unsupported. | `v2-governed-not-yet-advertised`; manifest and dispatch negative fixtures. | A |
| SA2-R-007 | Local context has no governor/preregistration/plan/visible-step/judge/policy/score fields. | `local-context-forbidden-fields`; recursive injection of every forbidden name at every container. | A |
| SA2-R-008 | Plan, request and result repeat exact claim exclusions. | `local-claim-exclusion-constants`; omit, alter, reorder or extend the closed list and flip either constant. | A |
| SA2-R-009 | No arbitrary metadata or arbitrary operation payload is representable. | `v2-closed-object-fuzz`; add unknown properties and untyped hash roles to every object. | A |
| SA2-R-010 | Resource limits are concrete and host-enforceable/reportable. | `local-limits-enforcement-map`; boundary and over-limit probes for each numeric/path/environment/control field. | A |
| SA2-R-011 | Host clamps requested limits to manifest and host ceilings. | `v2-limit-intersection`; exercise lower plan limit and each higher-than-ceiling refusal. | A |
| SA2-R-012 | Existing process, deadline, framing and output bounds are reused. | `v2-existing-host-supervisor`; spies/architecture assertions plus timeout, response bomb and output-tree probes. | A |
| SA2-R-013 | Exact environment names, egress policy, capabilities and input mounts are honored. | `v2-host-boundary-controls`; undeclared env, proxy/redirect/network, capability and mount-tamper negatives. | A |
| SA2-R-014 | All thirteen operations have closed local payloads and prerequisites. | `v2-operation-contract-table`; positive/negative fixture per operation and prerequisite edge. | A |
| SA2-R-015 | Actual availability is the certified four-way intersection. | `v2-operation-scope-refusal`; host, manifest, receipt and handshake omissions independently refuse. | A |
| SA2-R-016 | Projection remains untrusted local output. | `local-projection-role-firewall`; attempt GenericClaimSet/evaluator import and require role/schema refusal. | A |
| SA2-R-017 | Scoring, reveal, evaluation, validity, terminal and public-bundle consumers reject local records. | `local-record-governed-consumer-negative-matrix`; every local type against every governed entry point. | A |
| SA2-R-018 | Local records are unsigned and labeled `unauthenticated_local_record`. | `local-record-authenticity`; reject signature/signer fields, altered label and tampered core. | A |
| SA2-R-019 | Adapter certification authenticity cannot promote a local result. | `cert-authenticity-no-result-promotion`; vary receipt authenticity and assert invariant result label/roles. | A |
| SA2-R-020 | Existing mutation intents, receipts and compensation are reused. | `v2-mutation-ledger-reuse`; architecture trace plus declared/undeclared/failed compensation probes. | A |
| SA2-R-021 | Cleanup is incomplete unless evidence proves all planned cleanup. | `local-cleanup-conservative`; omit stop/uninstall/compensation/final residue individually and in combination. | A |
| SA2-R-022 | No operation dispatches after output freeze. | existing post-freeze suite extended with all v2 operations. | A |
| SA2-R-023 | Terminal completed/failed operations recover without redispatch. | `local-recovery-terminal`; crash/restart after frozen envelope and after each terminal record. | A |
| SA2-R-024 | Declared/dispatched ambiguous operations never replay when absence of dispatch cannot be proved. | `local-recovery-ambiguous-no-replay`; kill at pre/post-spawn boundaries and count dispatches. | A |
| SA2-R-025 | A conflicting request under an existing operation id refuses. | `local-operation-id-conflict`; vary one byte under same id. | A |
| SA2-R-026 | After failure/ambiguity only the frozen cleanup suffix may proceed. | `local-cleanup-suffix-only`; attempt normal and cleanup operations after each terminal intermediate state. | A |
| SA2-R-027 | The local coordinator is linear and delegates effects to `AdapterHost`. | `observation-removability-and-dependency`; forbid supervisor/evaluator/governor imports and duplicate effect implementations. | A |
| SA2-R-028 | Removing v2/local code leaves v1 behavior intact. | compile/test a feature-disabled or export-removed fixture plus architecture dependency assertion. | A/B |
| SA2-R-029 | `ADAPTER-CERT-V2` receipt binds exact protocol/mode/operation/package/control scope. | receipt round-trip and one-field mutation matrix. | A/D |
| SA2-R-030 | A v1 receipt never authorizes v2. | `v1-receipt-v2-refusal` using a valid frozen V1 receipt. | A/D |
| SA2-R-031 | Changed executable bytes require new receipts, including the v1 side of a dual artifact. | altered-byte admission probes for both manifests. | C/D |
| SA2-R-032 | The Independent-QA adapter preserves v1 and advertises only implemented v2 operations. | external repository v1 regression plus per-declared/per-omitted v2 operation suite. | C |
| SA2-R-033 | A neutral certified adapter completes a real subprocess observation. | vertical slice with frozen plan, requests, envelopes, outputs, controls, cleanup and result. | E |
| SA2-R-034 | The vertical slice is not an in-process fixture path or second engine. | process identity evidence and architecture/import assertions. | E |
| SA2-R-035 | The bounded product-adapter dry run remains frozen, unscored and non-governed. | evidence verifier asserts hashes, roles, constants, absence from governed roots and cleanup disposition. | F |
| SA2-R-036 | No product-specific concepts enter generic contracts or core coordination. | schema/source forbidden-token review plus at least two neutral fixture shapes. | A/B |
| SA2-R-037 | No local-to-governed conversion, tier upgrade or import exists. | command/export/role registry negative scan and attempted import tests. | A/B |
| SA2-R-038 | Diagnostics/output cannot claim scored, qualified, certified or finalized status through a trusted role. | output role and diagnostics redaction/forbidden-role fixtures. | A |
| SA2-R-039 | Existing unsupported sandbox controls remain explicit, not implied. | compare requested expectations with sandbox control report; refuse unmet `enforced`, retain `unsupported_permitted`. | A/E |
| SA2-R-040 | Documentation and CLI use observation-only vocabulary. | docs/help snapshot forbidden-claim scan with explicit allowlist for negations and design discussions. | A/B |

## Load-bearing review evidence

Package B must manually confirm, in addition to automated tests:

- every V2 receipt field terminates in an admission or host comparison;
- every limits field terminates in enforcement or an explicit control report;
- the v1 golden fixtures and existing certification suite were not regenerated
  to hide a compatibility change;
- local result roles do not occur in governed schema unions or role registries;
- recovery never uses process exit alone as proof that an effect did not occur;
- the external adapter's declared operation omissions remain honest; and
- deleting the additive v2/local surface would not require a governed-data
  migration.

## Exit criteria

No requirement is satisfied by documentation alone. Package A exits only when
SA2-R-001 through SA2-R-030 and SA2-R-036 through SA2-R-040 that are allocated
to A pass, with Package B still required before external adapter work. Packages
C–F each freeze the evidence named in their work-package rows.
