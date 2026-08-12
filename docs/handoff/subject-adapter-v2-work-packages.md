# `subject-adapter/v2` implementation work packages

**Status:** implementation blueprint only

**Authorization:** Package A is the only next package recommended for execution.
Packages B–F are sequenced scopes, not current authorization.

Every package must preserve `subject-adapter/v1`, use the existing adapter host,
and keep local observation outside governor, preregistration, journey, reveal,
evaluation, scoring and finalization roles. A stop condition ends the package;
it is not permission to invent a compatibility value.

## Package A — generic contracts, host/SDK seam and neutral fixtures

| Item | Plan |
|---|---|
| Repository owner | Qualiber Reality Lab; Contracts, Adapter Protocol, Core Host and Integrity owners |
| Estimate / risk | 5–8 engineering days; high because the protocol, certification scope and claim boundary are load-bearing |
| Allowed production scope | `packages/contracts/**`, `packages/adapter-sdk/**`, `packages/core/src/adapter/**`, and at most one new generic `packages/core/src/observation/**` module |
| Allowed support scope | matching tests, neutral test fixtures and documentation; no product adapter repository |
| Deliverables | ERL2-C-161…170; v2 codec messages; strict context union; manifest/receipt profiles; host selection; local state reducer; V2 certification harness skeleton; structural claim firewall |
| Required tests | every SA2 requirement allocated to Package A in the requirements-to-tests matrix, full current v1 adapter contract/host/certification regression, schema fixtures, architecture and generated-artifact checks |
| Frozen evidence | exact commit/tree, contract registry diff, generated checks, targeted test logs, v1 golden byte fixtures, v2 negative-control matrix and neutral fixture artifact hashes |

Stop immediately if implementation requires a second subprocess supervisor,
second mutation/output/freeze path, a product concept in a generic contract, an
optional v1 governed field, an invented signer, a local-to-governed converter,
or more than two new production modules outside existing adapter files. Return
to ADR review if an enforceable concrete limit cannot replace a commitment-only
field.

## Package B — independent architecture, security and certification review

| Item | Plan |
|---|---|
| Repository owner | Qualiber Reality Lab; independent Protocol, Integrity/Security and Certification reviewers |
| Estimate / risk | 2–3 reviewer days; high assurance risk, no production coding |
| Allowed files | Package A diff and frozen evidence; review findings under `docs/reviews/**`; normative docs only when a finding requires an explicit amendment |
| Deliverables | compatibility verdict, threat-model verdict, v1 regression verdict, receipt-scope verdict and resolved finding ledger |
| Required checks | trace each reserved contract and receipt field to enforcement; replay all forbidden-field negative controls; verify no local role is accepted by governed consumers; inspect dependency/removability graph |
| Frozen evidence | reviewer identities/roles, commit/tree reviewed, findings, dispositions and final signed-off review record as local repository evidence |

Stop on any unbound protocol/mode scope, downgrade path, role overlap, replayed
ambiguous operation, unenforced limit, or evidence that removal would alter v1.
Package C cannot start until all load-bearing findings are resolved.

## Package C — Independent-QA adapter v2 support

| Item | Plan |
|---|---|
| Repository owner | Independent-QA adapter repository and its maintainer; Lab repository remains read-only to that work |
| Estimate / risk | 3–5 engineering days; medium-high because dual parsing must preserve certified v1 behavior |
| Allowed files | adapter protocol/identity entry points, manifest fixtures and adapter tests in the Independent-QA repository; no Lab protocol redesign |
| Deliverables | new adapter version/digest, strict v2 local parser beside v1, unchanged handler reuse, v1 and v2 manifests, honest operation declarations |
| Required tests | all existing adapter tests; v1 byte/semantic regression; v2 negotiation and all advertised operations; forbidden governed-field rejection; limits; diagnostics; mutations; residue; unsupported `collect-outputs`/`stop` behavior |
| Frozen evidence | old and new artifact hashes, manifests, test logs, operation matrix and source commit/tree |

Stop if v2 support changes current v1 request interpretation, requires a
product-shaped generic field, silently advertises a missing operation, or
modifies Lab contracts outside an independently accepted Package A change.

## Package D — independent v1/v2 recertification

| Item | Plan |
|---|---|
| Repository owner | Lab Certification owner operating on frozen Package C bytes |
| Estimate / risk | 1–2 engineering days; high if any receipt scope is ambiguous |
| Allowed files | certification fixtures/evidence and new receipt artifacts; no adapter code changes during a certification run |
| Deliverables | a new V1 receipt for the new artifact's V1 manifest and a separate V2 receipt for its V2 manifest/local profile |
| Required tests | complete `ADAPTER-CERT-V1`; complete `ADAPTER-CERT-V2`; receipt verification; manifest/artifact identity recheck; negative altered-byte and altered-profile probes |
| Frozen evidence | suite versions, exact artifact/manifest/receipt hashes, host commit/tree, all probe results and authenticity classification |

Stop if executable bytes move after certification begins, one receipt appears to
authorize both manifests, V2 mode scope is absent, or a failure is waived. A
failed new certification leaves the current frozen v1 artifact as the only
admissible choice.

## Package E — neutral real-subprocess vertical slice

| Item | Plan |
|---|---|
| Repository owner | Qualiber Reality Lab; Core Host and Evidence owners |
| Estimate / risk | 3–5 engineering days; medium-high integration risk |
| Allowed files | generic observation entry point/coordinator already bounded by Package A, neutral certified adapter fixture, tests and an isolated evidence directory |
| Deliverables | one real subprocess local observation from frozen plan through cleanup and immutable result; no product adapter and no governed run |
| Required tests | acquire or host-provisioned input; structural package validation; one effectful step if certified; diagnostics/output bounds; mutation/compensation; final residue; crash recovery at declared/completed boundaries; freeze refusal |
| Frozen evidence | plan, every request/envelope, sandbox/control reports, artifacts, mutation/compensation/residue records, result, logs, commit/tree and deterministic rerun comparison where applicable |

Stop if the slice calls governor/preregistration/reveal/evaluation/finalization,
uses a fixture-only in-process adapter instead of the real host process, requires
a second engine, or cannot preserve cleanup uncertainty.

## Package F — bounded Qualiber dry run

| Item | Plan |
|---|---|
| Repository owner | Qualiber Reality Lab Evidence owner with the independently certified adapter owner |
| Estimate / risk | 1–2 engineering days; medium operational risk, no design work |
| Allowed files | a new timestamped observation evidence root and a concise evidence index; no contract, host, adapter or governed record edits |
| Deliverables | one bounded, frozen, explicitly unscored and non-governed observation using the exact Package D artifact and Package E path |
| Required checks | verify all artifact/manifest/receipt hashes; check concrete limits; verify claim exclusions in plan/request/result; confirm no scored or governed outputs; confirm cleanup or record incomplete cleanup honestly |
| Frozen evidence | all Package E evidence classes plus exact external adapter commit/tree and command transcript with secrets redacted |

Stop before dispatch if any production governor input is required or fabricated,
if the artifact or receipt differs from Package D, if the plan permits egress or
capabilities not independently reviewed, or if the requested conclusion exceeds
local structural and operational observation.

## Cross-package sequencing

```text
ADR-ERL2-037
  -> A generic implementation
  -> B independent review
  -> C external adapter update
  -> D separate recertification
  -> E neutral real-subprocess slice
  -> F bounded product-adapter observation
```

No package may collapse those gates. In particular, Package F is not evidence
for a score, qualification, governed validity, governor authorization, reveal,
judge evaluation or governed finalization.
