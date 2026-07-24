# External Reality Lab V2 — Full Implementation Prompt

You are the principal implementation engineer responsible for building the **External Reality Lab V2 (ERL2)** from its approved design and detailed implementation plan.

This is an implementation task, not another design exercise. Build the system incrementally, verify every security and lifecycle invariant with executable evidence, and continue slice-by-slice until the authorized scope is complete or a genuine external decision blocks progress.

The Reality Lab is an independent product. It is not a Qualiber subproject, test fixture, plugin, or internal package. Qualiber is only one future opaque subject under test.

## 1. Authoritative inputs and workspace

Use these paths exactly:

- **ERL implementation workspace:**
  `/Users/karthik/Developer/qualiber-reality-lab`
- **Normative detailed design:**
  `/Users/karthik/Developer/qualiber-reality-lab/external-reality-lab-design-v2.md`
- **Normative implementation plan:**
  `/Users/karthik/Developer/qualiber-reality-lab/external-reality-lab-implementation-plan.md`
- **Historical design, non-authoritative:**
  `/Users/karthik/Developer/qualiber-reality-lab/external-reality-lab-design.md`
- **Historical build plan, non-authoritative:**
  `/Users/karthik/Developer/qualiber-reality-lab/external-reality-lab-build-plan.md`

Develop all ERL code, packages, fixtures, tests, documentation, environments, adapters, packs, CLI behavior, and runbooks inside the ERL implementation workspace unless the approved V2 design explicitly assigns secret authority to a separate protected vault.

### 1.1 Absolute independence from the Qualiber workspace

Do not implement ERL inside any Qualiber checkout. In particular:

- do not write to `/Users/karthik/Claude/Projects/Qualiber`;
- do not write to `/Users/karthik/Developer/qualiber-2nd/qualiber`;
- do not import Qualiber source files, packages, schemas, tests, fixtures, CLI modules, or internal libraries;
- do not copy Qualiber implementation code into ERL;
- do not use Qualiber source behavior to define ERL core contracts, truth, validity, challenge eligibility, evidence classes, metrics, failure taxonomy, or release gates;
- do not add Qualiber-specific branches, commands, exit codes, schema discriminants, environment assumptions, or error categories to ERL core;
- do not require a Qualiber repository to build, test, package, verify, or release ERL core.

During Slices 1–6, do not inspect a Qualiber source checkout at all. Build and prove the independent system with fake and reference subjects first.

During Slice 7 only, a separately produced private Qualiber artifact may be supplied as an opaque archive, OCI image, native package, or bundle. Consume it through ERL's normal acquisition, package verification, adapter, sandbox, evidence, output-freeze, and cleanup contracts. The ERL must not learn or depend on the artifact's source checkout or authoring path.

If no opaque Qualiber package is supplied, complete all independent core/reference work, leave Slice 7 blocked with evidence, and continue any later work that does not require Qualiber. Do not substitute source-level integration.

### 1.2 Source precedence

Use this authority order when instructions conflict:

1. accepted ERL2 ADRs;
2. `external-reality-lab-design-v2.md`;
3. `external-reality-lab-implementation-plan.md`;
4. frozen ERL2 contract majors and approved golden fixtures;
5. this prompt's execution instructions;
6. historical ERL documents, only for context.

The historical 0.9.8 design and build plan are not authoritative when they make Qualiber the Lab's purpose, solver definition, evidence vocabulary, projector, importer, or completion condition.

If the design and implementation plan have a material normative conflict, stop the affected workstream, record the exact conflict and impacted requirements, and request an ADR/design decision. Continue independent workstreams that are not affected.

## 2. Mission and success condition

Build a domain-bounded, product-independent Reality Lab that independently constructs, operates, perturbs, and observes realistic software-delivery and production-operations ecosystems.

Any compatible product participates as an opaque **subject** through a versioned adapter. ERL core must not know a subject's feature model, internal architecture, proprietary vocabulary, scoring rules, or release authority.

The implementation is successful only when:

- an accepted run produces exactly one valid terminal record or one invalid terminal record;
- valid runs freeze all applicable evidence, results, cleanup, trust, and graph closure before attestation;
- invalid runs retain only reached evidence and cleanup attempts and can never produce an attestation or bundle;
- subject output freezes before truth or judge expectations are revealed;
- held-out selection uses a checkpointed, uniformly padded opaque pool, one precommitted verifier-authorized external beacon, deterministic selection, checkpointed commitment, threshold opening, checkpointed selected binding, proof, and verification receipt;
- external-beacon native proof and the ERL pool-association wrapper have distinct ownership and signing scopes;
- threshold VRF remains disabled unless a later audited ADR and new contract majors explicitly activate it;
- journey, domain, validity, and optional subject-deep results remain separate;
- cleanup or emergency containment completes before finalization;
- public bundles and invalid run records verify offline;
- core works with reference subjects when every Qualiber-owned integration is absent;
- the same released core digest can later run reference subjects, Qualiber, and a neutrally selected OSS subject;
- claims remain within the evidence level actually earned.

## 3. Mandatory working method

### 3.1 Inspect before modifying

At the start:

1. Read `external-reality-lab-design-v2.md` completely.
2. Read `external-reality-lab-implementation-plan.md` completely.
3. Inspect every existing file in the ERL workspace.
4. Determine whether the workspace already contains implementation code, generated artifacts, unrelated user changes, or only documents.
5. Inspect any `AGENTS.md`, repository-local instructions, package manifests, lockfiles, and CI configuration.
6. Record the current repository state without modifying or deleting user work.
7. Create or update a machine-readable implementation ledger mapping requirements, contracts, components, tests, owners, and status.

Do not assume the directory is a Git repository. Do not initialize Git, create branches, commit, publish, or push unless explicitly authorized or repository-local instructions already establish that workflow.

### 3.2 Plan and execute by slices

Follow the slices in the implementation plan:

1. Charter, decisions, and bootstrap.
2. Integrity, lifecycle, selection, trust, and offline-verification kernel.
3. Environment archetypes and clean ecosystem.
4. Journey, acquisition, blind selection, and capture.
5. Adapter SDK, sandbox host, and reference subjects.
6. Generic evaluation, terminal closure, and finalization.
7. Qualiber generic adapter and challenge suite.
8. Optional Qualiber deep-conformance supplement.
9. Reference subjects, neutral OSS subject, and independence proof.
10. Brownfield archetypes, chaos, and emergency cleanup.
11. Governance, calibration, customer verifier, and Core V2 release.
12. Optional OSS time-machine extension.

Do not skip forward in a way that causes later code to invent an unfrozen earlier contract. Independent work may run in parallel only after its prerequisite contracts and interfaces are frozen.

For every slice:

1. identify its design requirements and acceptance criteria;
2. confirm entry conditions;
3. freeze or explicitly version the required contracts;
4. implement producers and consumers;
5. add positive, negative, tamper, crash, and boundary tests;
6. produce CLI/verifier evidence;
7. update the implementation ledger;
8. run the slice gate on a clean workspace;
9. record the gate result, open risks, disabled features, and rollback path;
10. proceed only if the exit gate passes or the design explicitly permits a fail-closed reduced scope.

Do not ask for routine approval between slices. Continue when the plan and accepted ADRs already authorize the work. Stop only for a decision that materially changes security, architecture, public claims, external authority, or destructive scope.

### 3.3 Contract-first implementation

Before implementing a producer or consumer for any contract:

- add the closed JSON Schema or equivalent canonical schema;
- add a minimal valid fixture;
- add a representative valid fixture;
- add invalid fixtures for missing fields, unknown fields, bad discriminants, bad references, bad domains, incorrect ordering, and size limits;
- generate static types from the schema;
- generate or implement runtime validators;
- add canonicalization and hash goldens;
- declare compatibility and major-version behavior;
- add graph/reference invariants that cannot be expressed by local schema alone.

Do not maintain independent handwritten wire types that can drift from schemas.

Unknown fields must fail closed. Do not add `metadata`, extension maps, open inheritance, generic result bags, or product-defined fields to core contracts.

### 3.4 Evidence-driven completion

Do not report a work item complete merely because code exists. A work item is complete only when it has:

- passing tests;
- positive and adversarial fixtures;
- generated or captured CLI evidence;
- verifier output where applicable;
- updated traceability;
- documented rollback/disable behavior;
- no unresolved severity-one or severity-two defect in its authority boundary.

## 4. Implementation topology

Build toward this package topology inside the ERL workspace:

```text
packages/contracts
packages/integrity
packages/core
packages/adapter-sdk
packages/evaluation-sdk
packages/public-verifier
packages/cli

adapters/reference-correct
adapters/reference-limited
adapters/reference-misleading
adapters/qualiber              # Slice 7 only; removable
adapters/oss-selected          # after neutral selection

packs/operations
packs/qualiber-deep            # optional, removable descendant

environments/fake
environments/otel-demo
environments/archetypes

challenges/development
challenges/held-out-manifests
fixtures/golden
fixtures/invalid
fixtures/tampered
fixtures/sabotage
tests/architecture
tests/contract
tests/integration
tests/e2e
tests/adversarial
docs/adr
docs/decisions
docs/claims
runbooks
scripts
```

Allowed dependency direction:

```text
contracts <- integrity <- core
contracts <- adapter-sdk <- adapters/*
contracts <- evaluation-sdk <- packs/*
contracts + integrity <- public-verifier
core + public-verifier <- cli
```

Enforce this as executable architecture tests. Core must not depend on adapters, Qualiber packages, product-deep packs, consumer integrations, or vault plaintext.

## 5. Technical baseline

Follow accepted ADRs and existing repository choices. If the repository is implementation-empty and the ADRs do not decide a tooling detail, use conservative defaults consistent with the plan:

- Node.js 22;
- strict TypeScript;
- workspace-based packages;
- JSON Schema with generated TypeScript and runtime validation;
- RFC 8785 JCS;
- domain-separated SHA-256;
- Ed25519 signatures;
- age-X25519 for ordinary encrypted artifacts;
- threshold-X25519 envelope custody for blind selected-entry payloads;
- deterministic, injected clock/randomness/filesystem/process/transport seams;
- a test runner that supports unit, integration, fixtures, mutation-style negatives, and subprocess tests.

Record any new build, persistence, schema, sandbox, cryptography, or runtime decision in an ADR before it becomes difficult to reverse.

Do not invent a custom cryptographic protocol. Use audited libraries and explicit domain separation. Keep threshold VRF inactive.

## 6. Non-negotiable architecture and security invariants

### 6.1 Product independence

- Core terminology is subject-, ecosystem-, journey-, evidence-, and claim-oriented.
- Unsupported capability remains a retained result; it never removes or silently changes an admitted case.
- Environment and challenge admission require no candidate output.
- Truth cannot derive solely from a known-good subject.
- Core-purity tests scan imports, lockfiles, bundles, strings, CLI help, schemas, discriminants, exit codes, and generated files for named-subject coupling.

### 6.2 Identity and artifacts

- One canonical JCS implementation.
- One domain registry for hashes.
- Artifact publication is temporary write → validate → inventory → fsync → atomic publish → freeze marker.
- Frozen artifacts are immutable.
- Logical paths reject traversal, symlink escape, hard-link substitution where relevant, case collision, special files, and root escape.
- Retained V1 objects are never rewritten as V2.

### 6.3 Lifecycle and invalid terminals

- Every external mutation follows intent → receipt → event → snapshot.
- Events are append-only and hash-chained.
- Same operation ID and same bytes is idempotent; different bytes conflict.
- Recovery reconciles side effects before continuing.
- Every accepted unrecoverable failure or cancellation freezes exactly one `InvalidLabRunRecordV1`.
- Invalid phase and terminal reason are discriminated.
- Cancellation does not fabricate a finding.
- An invalid journey execution retains the exact intent, step commitment, and lifecycle event.
- Invalid records cannot reach generic index, final attestation, public bundle, deep bundle, or customer bundle.

### 6.4 Oracle and reveal isolation

- Subject-visible journey steps and encrypted judge expectations are different contracts.
- Adapter requests contain no success predicate, expected observation, truth selector, judge artifact, or future identity.
- Place unique canary tokens in judge expectations and scan adapter inputs, mounts, environment, diagnostics, output prefill, egress, and Lab telemetry.
- Truth or judge expectations reveal only after subject output freezes.
- No subject or adapter process runs after any reveal.

### 6.5 Acquisition before selection

The enforced order is:

```text
preregister acquisition source and adapter
→ measured acquisition
→ copy and freeze acquired bytes
→ verify package integrity and provenance
→ freeze exact subject package manifest
→ create challenge selection request
→ construct and checkpoint eligibility pool
→ obtain independent randomness
```

Acquisition/package requests cannot contain future plan, environment, challenge, truth, journey, or selected identity.

### 6.6 Blind selection

For held-out/blind mode:

- request binds family-level actor and journey policies only;
- exact challenge, persona, journey, step commitments, exposure epoch, and opening remain encrypted;
- selector-visible entries use one uniform fixed-size padded profile;
- exact recipient set, release policy, signer identity, path shape, serialized length, media type, encryption, and padding profile are pool-common;
- ordered pool freezes and receives an independent checkpoint;
- randomness policy names exactly one external beacon source before pool construction;
- source ID and source-trust identity enter the pool root and source request binding;
- no fallback, alternate source, parallel observation, retry, selector seed, caller nonce, or redraw exists;
- the first finalized beacon round after the pool checkpoint supplies randomness;
- beacon-native proof authenticates only its canonical round/output;
- an independently signed ERL wrapper associates that proof with the pool binding;
- verifier validates the source against locally pinned registry/current-head keys;
- selected index derives deterministically through domain-separated HMAC-SHA-256 rejection sampling;
- selection commitment freezes before a later checkpoint anchors it;
- threshold reveal shares are allowed only after the commitment checkpoint;
- only the selected entry opens;
- selected binding freezes before a later checkpoint anchors it;
- proof and verification receipt independently close every edge;
- held-out reports disclose the exact residual collusion limitation required by the design.

Threshold VRF must return `THRESHOLD_VRF_NOT_ACTIVATED`. Do not create a successful threshold-VRF golden, runtime path, alias, or claim. Activation requires a later audited ADR, security approval, and new contract majors.

### 6.7 Evidence and comparison modes

- Canonical evidence is Lab-owned, not adapter-authored.
- Replay comparison is development-only and non-blind.
- Replay mode uses byte-identical canonical envelope bytes across subjects.
- Live ecosystem mode uses independent live envelopes and a separately implemented semantic-equivalence verifier.
- Live semantic equivalence is not raw-byte equality.
- Every adapter translation maps each canonical entry exactly once as exact, lossy, or unsupported.

### 6.8 Evaluation authority

- Validity is Lab-owned.
- Journey evaluation measures lifecycle/setup/interaction outcomes.
- Domain evaluation uses subject-neutral committed packs.
- Optional subject-deep evaluation is a post-base descendant.
- No scalar score compensates for a safety or validity failure.
- Pack runtime has no network, filesystem, process, clock, randomness, mutation, threshold, or validity authority.
- Journey and domain results must join before cleanup.
- Only `ValidityResultV1.status="valid"` may enter `GenericEvaluationIndexV1`.

### 6.9 Cleanup and finalization

- Pre-environment terminals use only pre-environment cleanup.
- Environment terminals require restoration and teardown.
- Restoration or teardown failure enters emergency cleanup.
- Independently safe emergency actions must be attempted and carry receipts whether successful or failed.
- Unsafe skips require a reason and forbid an attempt receipt.
- Finalization occurs only after applicable cleanup, exposure, trust, timestamp, and graph closure.

### 6.10 Offline trust

- Public-bundle and invalid-record verification work with network disabled.
- Trust roots/current heads come from explicit verifier-controlled local configuration.
- Presented bundle keys, source registries, policies, inventories, and checkpoints cannot self-authorize.
- Report trust at creation and trust at verification separately where required.

## 7. Slice-specific execution requirements

### Slice 1 — Charter and bootstrap

- Create the implementation ledger.
- Create/complete ADR-ERL2-001 through 006 and 011 before their code freezes.
- Establish workspace tooling, CI, CODEOWNERS/reviewer policy where applicable, secret scanning, dependency review, and architecture-purity tests.
- Establish test-only development keys and trust fixtures.
- Resolve or fail-close OQ-005 and OQ-007 before active external-beacon selection code.
- Exit only when every P0 requirement and AC-001 through AC-043 has an owner, package, test family, and planned slice.

### Slice 2 — Integrity and selection kernel

Implement contract groups and their tests in the order specified by the implementation plan. Deliver:

- canonicalization/hash/artifact/path primitives;
- signatures, trust and acyclic checkpoints;
- append-only lifecycle and crash recovery;
- active external-beacon policy/receipt/wrapper/source-trust verification;
- uniformly padded opaque pool and complete selection chain;
- threshold reveal receipt and selected-only opening;
- threshold-VRF refusal marker;
- valid and invalid terminal unions;
- verifier-derived mandatory closure;
- offline public and invalid-record verifiers;
- fake valid and invalid CLI evidence.

Do not begin live environment work until this slice's security mutations pass.

### Slice 3 — Environments

Implement the fake driver first, then the Compose driver. Pin the OpenTelemetry Demo source archive and per-platform image digests before attesting runs. Prove clean baseline, two-run isolation, exact resource identity, repeatable teardown, partial-provision cleanup, and source-neutral admission.

If the substrate lock is unresolved, continue with the fake driver and mark Compose disabled.

### Slice 4 — Journey, acquisition, selection orchestration, and capture

Implement the full generic journey state machine, phase-specific requests, acquisition/package-before-selection, actor/journey hiding and opening, capture/cutoff/source states, replay/live envelopes, oracle canaries, and valid/invalid early terminals.

### Slice 5 — Adapter platform

Implement SDK, host, sandbox, capability/privilege broker, credential handles, mutation/compensation receipts, translation totality, output freezer, certification harness, and at least correct and limited reference subjects.

If safe privilege brokering is unresolved, support only unprivileged container subjects.

### Slice 6 — Generic evaluation and finalization

Implement the finding union, data-only pack DSL, generic operations pack, journey/domain results, precleanup join, validity gates, cleanup unions, generic index, run records, final attestations, public bundles, and complete offline verification.

### Slice 7 — Qualiber opaque adapter

Start only after Slices 1–6 pass without Qualiber. Require a supplied opaque private artifact with provenance/SBOM. Build the Qualiber adapter in `adapters/qualiber` using only supported external interfaces. Do not inspect or import Qualiber source. Removing this adapter must leave core tests green.

### Slice 8 — Optional Qualiber deep pack

Keep it in `packs/qualiber-deep`. Prove that toggling it changes only deep commitment/result/supplement/bundle artifacts. Generic and base-terminal bytes must remain identical.

### Slice 9 — Independence proof

Select the non-Qualiber OSS subject through the neutral procedure before adapter feasibility work. Run the unchanged released core against reference subjects, the available Qualiber opaque package, and the selected OSS subject. Withhold the independence claim if any prerequisite fails.

### Slice 10 — Brownfield and chaos

Implement at least three independently justified constrained archetypes, full crash/failure injection, multi-run isolation, resource-frontier derivation, and receipt-backed emergency cleanup.

### Slice 11 — Governance and release

Implement protected role-separated workflows, exposure governance, access-log review, claim-scope enforcement, customer-bundle verifier fixtures, retention, runbooks, reproducible release evidence, and at least ten calibration runs. Do not emit T4 from synthetic/OSS evidence.

### Slice 12 — Optional historical extension

Implement only after Core V2. Separate pre-cutoff subject-visible evidence from later judge-only evidence and limit claims to governed historical reproduction.

## 8. Mandatory test and CI expectations

Implement all named test families from design §24 and implementation-plan §19. Stable suites must include:

- contract/canonicalization/path/version closure;
- architecture purity;
- no-op valid and invalid lifecycle;
- acquisition binding and request ancestry;
- actor/journey hiding and oracle canaries;
- single external-beacon source, native-proof/wrapper ownership, source trust, no retry/fallback, and threshold-VRF refusal;
- acyclic selection checkpoints and full edge closure;
- pool metadata uniformity and role/non-collusion controls;
- adapter certification, sandbox, SSRF, secrets, privilege and residue;
- canonical evidence, replay/live modes and translation totality;
- deterministic evaluation, result join and failure ownership;
- early and invalid terminal closure;
- emergency cleanup action evidence;
- mandatory graph derivation, tamper and crash matrix;
- deep ancestry isolation;
- customer-bundle/external-trust verification;
- cross-subject independence and claim-scope enforcement.

CI lanes:

- **PR:** contract, canonicalization, architecture purity, fake lifecycle, unit, type and lint.
- **Nightly:** clean Compose, reference subjects, tamper and crash subset.
- **Weekly:** brownfield, full crash/security matrix, and private Qualiber development run if an opaque package is available.
- **Protected held-out:** role-separated live selection, reveal, exposure, audit and claim controls.
- **Manual independence:** replay cross-subject and live-equivalence suites.
- **Release:** all suites on supported platforms, SBOM/provenance, reproducible build and offline verification.

Do not weaken a failing security or integrity test to make progress. Fix the implementation or record the corresponding feature as disabled.

## 9. Handling external dependencies and blockers

Use fail-closed reduced scope rather than unsafe substitutes:

| Blocker | Continue with | Withhold |
|---|---|---|
| External beacon not qualified | non-blind development selection | held-out/blind claims |
| Threshold-VRF construction unavailable | external beacon only; refusal marker | every threshold-VRF success path |
| OTel Demo digest lock incomplete | fake driver | Compose attesting runs |
| Privilege broker unresolved | unprivileged container subjects | unsafe native installers |
| Pack runtime undecided | data-only DSL | executable pack modules |
| Qualiber opaque package unavailable | core/reference/OSS work | Qualiber integration evidence |
| Neutral OSS subject not selected | reference and Qualiber integrations | architectural-independence claim |
| Brownfield repeatability insufficient | clean preview | brownfield claims |
| Retention approval incomplete | development/local runs | held-out production release |
| Genuine customer outcomes unavailable | T1–T3 only | T4 emission |

Do not mark the overall project blocked while independent authorized work remains.

## 10. Prohibited shortcuts

Do not:

- build a Qualiber-specific core and rename it generic;
- use Trailhead, Qualiber, or any reference subject as the sole source of truth;
- filter cases by declared subject capability;
- reveal truth or expectations to help setup succeed;
- accept a mutable source checkout as an attesting subject package;
- run subjects with ambient home-directory, Docker socket, vault, judge, or broad network access;
- let adapters rewrite canonical evidence;
- let packs set validity or generic thresholds;
- treat infrastructure failure as subject failure;
- fabricate missing artifacts for invalid runs;
- skip cleanup because a run is invalid;
- trust producer-supplied closure arrays or trust heads;
- use randomized source selection, fallback, redraw, or selector-provided seed;
- claim a beacon signed ERL-specific data it never received;
- implement or activate a custom threshold VRF under the reserved V1 schemas;
- claim bias-free, collusion-proof, universal, or customer-valid results without the required evidence;
- rewrite retained artifacts after a contract correction;
- modify either Qualiber repository.

## 11. Progress reporting

Keep user-facing updates concise and evidence-based. For each material checkpoint report:

- slice and work package completed;
- contracts frozen or changed;
- tests executed and results;
- CLI/verifier evidence produced;
- files or packages created;
- open ADRs/OQs and fail-closed effects;
- next critical work.

Do not report a percentage based only on elapsed time or file count. If reporting progress, distinguish:

- design/decision readiness;
- contract completion;
- implementation completion;
- test/verification completion;
- calibration/release completion.

## 12. Required final handoff

At the end of the authorized implementation scope, provide:

1. a concise implementation outcome;
2. completed slices and exit-gate evidence;
3. exact commands for build, test, local run, offline bundle verification, and invalid-record verification;
4. package and dependency topology;
5. supported environments, adapters, packs, and deployment profiles;
6. known disabled features and their refusal codes;
7. open ADRs/OQs and claim limitations;
8. calibration and flake summary;
9. security/privacy review status;
10. a traceability summary from requirements to passing tests;
11. local-private opaque-package instructions for integrating Qualiber or another unpublished subject;
12. a statement confirming that ERL core builds and tests without either Qualiber workspace.

## 13. Definition of complete

The full task is complete only when the Core V2 release gate in the implementation plan passes, or when all safely executable work is complete and remaining items are explicitly blocked by external authority or unavailable artifacts.

Never convert a missing external dependency into invented evidence. Never broaden authority merely because the project is large. Build the independent Lab first, prove it with reference subjects, and integrate Qualiber only through the same opaque interfaces available to any other subject.
