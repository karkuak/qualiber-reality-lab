# External Reality Lab — Detailed Design Document Authoring Prompt

You are the principal architect responsible for producing the implementation-grade **Detailed
Design Document (DDD)** for Qualiber's **External Reality Lab (ERL)**.

Use these filesystem roots exactly for this design task:

- **ERL design workspace:** `/Users/karthik/Developer/qualiber-reality-lab`
- **Primary build-plan input:**
  `/Users/karthik/Developer/qualiber-reality-lab/external-reality-lab-build-plan.md`
- **Required design output:**
  `/Users/karthik/Developer/qualiber-reality-lab/external-reality-lab-design.md`
- **Canonical Qualiber source checkout (read-only design evidence):**
  `/Users/karthik/Claude/Projects/Qualiber`

The ERL documents have deliberately moved out of the Qualiber repository. Do not write the design
back into Qualiber's `docs/` tree. Do not infer that the ERL design workspace is already an
initialized implementation repository merely because the directory exists.

The absolute paths above are authoring-time locations only. Do not bake `/Users/karthik/...` into
ERL schemas, runtime contracts, persisted identities, CI configuration or portable runbooks. The
design must define configurable symbolic roots and repository-relative artifact paths for the
implemented system.

At the beginning of the task, record the Qualiber checkout's branch, `HEAD` commit and worktree
status. Use that one checkout consistently for all current-product claims. Another checkout may
exist at `/Users/karthik/Developer/qualiber-2nd/qualiber`; do **not** mix evidence from it into the
design or silently switch to it. If the canonical checkout is unavailable, stop source-dependent
claims and report the missing input rather than substituting a different checkout.

Treat that build plan as the approved product and delivery direction. Your job is to convert it
into a precise, internally consistent and reviewable design from which engineers can implement the
ERL without inventing architecture, contracts, state transitions, security behavior, evaluation
semantics or operational policy during coding.

Do not implement the ERL in this task. Produce the design document only.

## 1. Required output

Create one document:

- `/Users/karthik/Developer/qualiber-reality-lab/external-reality-lab-design.md`

The document must be a detailed design spanning system architecture, component responsibilities,
data contracts, protocols, state transitions, security, bias isolation, deterministic evaluation,
failure semantics, deployment, operations, testing and phased implementation.

The document must be complete enough that a different implementation team could:

1. evolve the ERL design workspace into the proposed implementation repository and create the
   separately protected truth-vault repository;
2. implement the CLI and contracts;
3. provision the OpenTelemetry Demo substrate;
4. capture and freeze live evidence;
5. run a released Qualiber build through supported interfaces only;
6. reveal truth only after immutable commitments exist;
7. calculate deterministic evaluation results;
8. govern development and held-out experiments; and
9. verify and audit a run after its live environment has been destroyed.

Do not optimize for brevity. Optimize for precision, internal consistency, traceability and
buildability. Avoid filler, generic platform advice and aspirational statements without contracts
or enforcement mechanisms.

## 2. Working method

### 2.1 Read and inspect before designing

Read the primary build plan completely. Then inspect the canonical Qualiber source checkout at
`/Users/karthik/Claude/Projects/Qualiber`. All paths in the list below are relative to that checkout
unless explicitly stated otherwise:

1. `README.md` — product boundary and current customer surfaces.
2. `docs/architecture/decisions/adr-001-ai-deterministic-boundary.md` — deterministic authority
   boundary.
3. `docs/architecture/decisions/adr-002-rule-promotion-blocking-policy.md` — earned blocking and
   human approval.
4. `scenario-lab/docs/scenario-lab-strategy.md` — truth derivation, discrimination, held-out and
   external-validity boundary.
5. `scenario-lab/src/contracts/` and `scenario-lab/schemas/` — current contract conventions.
6. `scenario-lab/src/corpus/tierManifest.ts`, `heldOutGate.ts`, `rotation.ts` and
   `personaRecord.ts` — current corpus governance.
7. `scenario-lab/src/runtime/` and `scenario-lab/src/discrimination/` — loading, scoring and
   sabotage conventions.
8. `scenario-lab/src/adapters/telemetrytestAdapter.ts` — current black-box product adapter.
9. `scenario-lab/source-capsules/opentelemetry-demo.yaml` and
   `openobserve-otel-demo-dataset.yaml` — existing provenance decisions.
10. `src/phase3/connectors/`, especially transport, registry, normalization, HTTP pull and
    PostgreSQL warehouse readers — reusable connector machinery and security boundaries.
11. `docs/architecture/decisions/adr-005-warehouse-adapter-strategy.md` — warehouse adapter
    constraints.
12. `docs/reference-customer/reference-customer-app-plan.md` and the Trailhead real-journey
    records — lessons from the first external integration.
13. `.github/workflows/ci.yml`, `.github/workflows/scenario-lab.yml` and
    `.github/workflows/phase4-held-out.yml` — current CI authority and held-out process.
14. `docs/HANDOFF.md` and `docs/process/validation.md` for current product status and known
    operational constraints.

The build plan was originally authored while stored inside the Qualiber repository. Interpret its
section **6.3, "Changes expected in this repository,"** as changes expected in the canonical
Qualiber product repository. Interpret its proposed ERL repository layout and orchestration work as
belonging in the current `qualiber-reality-lab` workspace. Its section 18 repository references are
Qualiber-relative unless the reference names the ERL or vault explicitly. Do not resolve every
relative path in the moved build plan against its new directory.

Inspect actual code and schemas rather than relying on file names or plan summaries. Cite relevant
repository evidence using paths and line numbers. Because the design lives outside the product
repository, cite product sources as `Qualiber:<repo-relative-path>:<line>` (for example,
`Qualiber:src/phase3/connectors/registry.ts:42`) rather than writing links that incorrectly assume
the design and product share a repository root. Cite the build plan and future ERL-local files
relative to `/Users/karthik/Developer/qualiber-reality-lab`. Distinguish clearly among:

- behavior that already exists and can be reused;
- existing behavior that requires a compatible extension;
- entirely new ERL behavior;
- external-system behavior controlled by an upstream project; and
- proposed future behavior that is explicitly outside the first implementation.

If you cannot access the canonical Qualiber checkout, say so at the beginning of the document and
produce a `Repository Verification Required` register naming every claim that must be checked before
design approval. Do not pretend current behavior was verified.

### 2.2 Verify unstable external facts

For implementation-relevant details that may change—OpenTelemetry Demo deployment, fault-flag
names, image versions, Docker/Kubernetes requirements, SaaS API limits or security behavior—verify
against current official upstream documentation. Prefer pinned commits, image digests, schemas and
API versions over statements such as "latest." Record the verification date and source.

Do not turn the design into a purchasing document. External pricing may inform budgets but must not
define the architecture.

### 2.3 Handle conflicts correctly

The build plan is authoritative, but it may contain directional choices rather than resolved
implementation decisions. If it conflicts with a governing ADR, current product invariant or
verified source behavior:

1. identify the conflict explicitly;
2. describe its implementation consequence;
3. propose the smallest coherent resolution;
4. mark whether a new ADR or parent-document amendment is required; and
5. do not silently overwrite either side.

Classify unresolved items as:

- **Design-blocking:** implementation would require inventing a trust, authority, identity,
  persistence or evaluation decision.
- **Pre-implementation:** must be measured or selected before its implementation slice begins.
- **Operational:** may be configured at deployment time within a fully defined contract.
- **Deferred:** intentionally outside V1 with no hidden dependency from V1.

The final document must not use "TBD" for a core V1 contract or security decision without also
declaring the owner, deadline, decision procedure and safe blocked behavior.

## 3. Non-negotiable invariants

Preserve these throughout the design:

1. **Deterministic rules decide, AI assists, humans approve.** AI output cannot own a release,
   product-quality or ERL evaluation gate.
2. ERL cannot grant Qualiber new customer-CI authority or introduce a new non-zero customer exit.
3. The solver cannot access plaintext truth, reveal keys, post-cutoff evidence or evaluator-only
   records before its outputs are frozen.
4. The environment operator cannot modify solver artifacts after truth reveal.
5. The evaluator cannot mutate observations, solver outputs or truth.
6. Infrastructure, connector, evidence, solver and evaluator failures are distinct states.
7. Missing or unavailable evidence is never represented as an empty successful source.
8. Correct uncertainty must score better than unsupported certainty.
9. The evaluator scores structured facts, evidence support, confidence and authority—not prose
   similarity to a hand-written answer.
10. A clean negative control is mandatory and has equal status with positive fault cases.
11. A held-out case exposed to product development is automatically ineligible for future
    held-out use until governed rotation occurs.
12. The upstream application must not be modified to make Qualiber's conclusions easier. Any
    overlay is classified and behavior-changing overlays invalidate attestation.
13. Product runtime code cannot import ERL truth-vault, reveal or held-out implementation modules.
14. Raw secrets and unbounded telemetry cannot enter retained artifacts.
15. Every attesting artifact is schema-valid, content-addressed, provenance-bearing and
    independently verifiable.
16. T1–T3 experiments prove capability, robustness and regression safety; only a real customer
    correction plus later outcome can contribute T4 external-validity evidence.
17. Environment teardown does not erase the minimum artifacts needed for later verification.
18. A run never proceeds through truth reveal while observations or solver outputs remain mutable.

If the proposed design cannot enforce an invariant, call that a design-blocking defect. Do not
weaken the invariant for convenience.

## 4. Required design-document structure

Use the sections below. You may add sections, but do not omit any required section. Use stable
requirement and contract identifiers so later reviews and tests can cite them.

### 4.1 Document control

Include:

- title, status, revision and date;
- authorship/review roles;
- governing inputs and precedence;
- intended audience;
- approval requirements;
- change procedure;
- terminology and normative language conventions; and
- a revision history table.

Use RFC-style **MUST**, **MUST NOT**, **SHOULD** and **MAY** deliberately. Define what those words
mean in this document.

### 4.2 Executive summary and architectural decisions

State:

- the problem being solved;
- why Trailhead and Scenario Lab alone are insufficient;
- what V1 delivers;
- what V1 deliberately does not claim;
- the recommended architecture in one page; and
- the highest-consequence decisions.

Provide a decision table with at least:

- decision ID;
- decision;
- alternatives considered;
- rationale;
- consequences;
- reversibility; and
- whether a separate ADR is required.

### 4.3 Context, goals and requirements

Convert the build plan into explicit identifiers:

- `ERL-G-*` for goals;
- `ERL-FR-*` for functional requirements;
- `ERL-NFR-*` for non-functional requirements;
- `ERL-SEC-*` for security requirements;
- `ERL-INT-*` for integrity/bias requirements;
- `ERL-OPS-*` for operational requirements; and
- `ERL-AC-*` for top-level acceptance criteria.

Each requirement must be singular, testable and traceable. Include priority and V1/deferred scope.
Avoid requirements such as "be scalable" or "be secure" without measurable meaning.

### 4.4 System context and boundaries

Include Mermaid diagrams for:

1. system context;
2. trust boundaries;
3. repository/credential boundaries;
4. runtime containers/services;
5. data flow from selection through verification; and
6. the boundary between Qualiber, Scenario Lab, ERL, truth vault and external systems.

For every boundary, state:

- data crossing it;
- initiating principal;
- authentication and authorization;
- confidentiality/integrity requirements;
- failure behavior; and
- retained audit evidence.

### 4.5 Repository and ownership topology

Fully specify the proposed three-security-domain repository model:

- what remains in the existing `qualiber` product repository;
- what lives in the current `/Users/karthik/Developer/qualiber-reality-lab` workspace, which is the
  intended home of ERL design and orchestration work;
- what lives in the separately protected `qualiber-reality-vault`;
- where upstream forks/mirrors live;
- who can read/write each repository;
- which CI identities can access each repository;
- which credentials exist and where they are resolved;
- how local solo-operator development approximates separation; and
- what protection remains impossible for a solo administrator.

The build plan uses `qualiber-external-reality-lab` as a proposed logical repository name. The
current workspace is named `qualiber-reality-lab`. Do not propose creating a duplicate repository
merely to preserve the older proposed name. State the chosen logical/remote name as a naming
decision, but treat the current workspace as the canonical design location for this task.

Resolve whether the truth vault uses repository encryption, an external secret manager, envelope
encryption, or another mechanism. Specify key ownership, rotation, recovery and audit—not just the
word "encrypted."

Provide a concrete proposed directory tree for the current ERL workspace after it becomes an
implementation repository, a tree for the separately protected vault, and a file-level change map
for the existing Qualiber repository. Do not move the ERL design document back into Qualiber.

### 4.6 Component architecture

Define each component with:

- responsibility;
- owned data;
- inputs and outputs;
- dependencies;
- public interface;
- trust level;
- concurrency model;
- idempotency expectations;
- resource limits;
- failure modes; and
- test seams.

Cover at minimum:

- CLI and command dispatcher;
- experiment registry;
- blind selector;
- environment resolver;
- Docker Compose driver;
- future Kubernetes driver boundary;
- health-contract engine;
- fault/history controller;
- traffic driver;
- evidence capture coordinator;
- source adapters;
- observation-bundle builder;
- redaction/leak scanner;
- Qualiber black-box runner;
- artifact freezer;
- truth commitment/reveal service;
- structured-claim projector;
- deterministic evaluator;
- optional AI critic boundary;
- signer/verifier;
- corpus/exposure governor;
- teardown verifier; and
- report renderer.

State where existing Qualiber/Scenario Lab code is reused and where a new dependency boundary is
required. Do not duplicate existing connector security behavior without explaining why reuse is
unsafe or impossible.

### 4.7 Run lifecycle and state machines

Specify the authoritative run state machine. At minimum address:

- planned;
- selected/committed;
- provisioning;
- baseline checking;
- fault activated or historical state prepared;
- traffic running;
- observing;
- observation frozen;
- solver running;
- solver output frozen;
- truth revealed;
- evaluated;
- restoring;
- destroying;
- verified;
- invalidated; and
- terminal failure states.

For every transition define:

- command/API that requests it;
- preconditions;
- required prior hashes;
- side effects;
- atomic commit marker;
- retry/idempotency behavior;
- timeout behavior;
- allowed recovery path;
- forbidden transitions; and
- emitted audit event.

Include:

- a Mermaid state diagram;
- a happy-path sequence diagram;
- a provisioning-failure sequence;
- a connector-partial-failure sequence;
- a solver-failure sequence;
- a reveal/evaluation sequence; and
- a crash-and-resume sequence.

Resolve what can be resumed and what must be invalidated and restarted. In particular, prove that a
crash after reveal cannot lead to a mutable rerun using known truth.

### 4.8 Contracts and canonical identity

Define complete field-level contracts—not illustrative fragments—for at least:

1. `EnvironmentProfileV1`;
2. `EnvironmentFingerprintV1`;
3. `ExperimentManifestV1`;
4. `EligibilityPoolManifestV1`;
5. `SelectionCommitmentV1`;
6. `RunPlanV1`;
7. `RunLifecycleEventV1`;
8. `HealthContractV1`;
9. `FaultActivationRecordV1`;
10. `TrafficRunRecordV1`;
11. `EvidenceSourceSnapshotV1`;
12. `ConnectorHealthRecordV1`;
13. `ObservationBundleV1`;
14. `QualiberRunManifestV1`;
15. `FrozenArtifactManifestV1`;
16. `TruthEnvelopeV1`;
17. `TruthRevealRecordV1`;
18. `StructuredClaimSetV1`;
19. `EvaluationMetricResultV1`;
20. `EvaluationReportV1`;
21. `ExposureEventV1`;
22. `ExperimentRotationRecordV1`;
23. `TeardownVerificationV1`; and
24. `ExternalRealityRunRecordV1`.

For every contract specify:

- exact version string;
- TypeScript shape or equally precise pseudotype;
- required versus optional fields;
- enums and string/number bounds;
- identifier and timestamp formats;
- canonical ordering rules;
- self-identifying hash core;
- excluded volatile fields;
- cross-record referential invariants;
- maximum serialized size;
- producer;
- consumers;
- storage path/layout;
- redaction classification;
- retention class;
- validation failure behavior; and
- schema migration policy.

Resolve the canonical serialization and hashing algorithm. Specify whether hashes include a
`sha256:` prefix, how JSON object keys and arrays are ordered, how Unicode and numbers are encoded,
and how volatile timestamps are separated from identity. Hash descriptions such as "content
addressed" without canonical bytes are insufficient.

Include representative valid examples for the central contracts and at least one invalid example
for each integrity-critical contract.

### 4.9 Filesystem and artifact layout

Define exact run-scoped layouts for:

- working state;
- captured raw evidence;
- normalized evidence;
- observation bundles;
- frozen Qualiber outputs;
- truth commitments;
- reveal records;
- evaluation reports;
- teardown evidence;
- retained attestations; and
- temporary secrets.

Specify containment, symlink handling, permissions, atomic writes, temporary-file behavior,
cross-device rename behavior, fsync expectations where relevant, cleanup and retention.

State which directories may be mounted into the Qualiber runner. The truth vault and evaluator
state MUST NOT be reachable through those mounts.

### 4.10 Blind selection and commitment protocol

Design the exact selection algorithm:

- eligibility filtering;
- tier and exposure checks;
- environment capability matching;
- random seed generation;
- deterministic selection from a committed pool;
- pool-manifest hashing;
- selection commitment;
- experiment-ID concealment if required;
- replay protection;
- cancellation and retry; and
- proof that selection occurred after the Qualiber version was frozen.

Clarify which fields may be public before the run, which are encrypted and which are revealed
afterward. Explain how a solo operator is prevented from accidentally seeing truth and what a
malicious machine administrator could still do.

### 4.11 Evidence model and temporal cutoff

For each V1 evidence class—Git, CI, ticket, deployment, feature flag, trace, metric, log, business
event, warehouse row, ownership and connector health—define:

- source adapter;
- query or collection method;
- clock source;
- observation window;
- pagination/cursor behavior;
- deduplication identity;
- ordering;
- maximum rows/bytes;
- sampling/truncation representation;
- freshness;
- normalization;
- sensitive-data classification;
- redaction;
- provenance; and
- unavailable/partial/error representation.

Resolve time semantics precisely:

- authoritative cutoff clock;
- clock-skew measurement;
- inclusive/exclusive cutoff boundaries;
- late-arriving data;
- event time versus ingestion time;
- post-cutoff API mutation;
- how temporal holdout is verified; and
- how historical OSS evidence is partitioned at time `T`.

An empty array MUST NOT ambiguously mean both "source healthy with no records" and "source could
not be read."

### 4.12 OpenTelemetry Demo substrate design

Specify the first live environment in enough detail to implement it:

- upstream repository and pinning method;
- required services and optional services;
- Docker network and port layout;
- image-digest policy;
- health/readiness checks;
- minimum CPU, memory, disk and timeout budgets;
- load-generator configuration;
- OpenTelemetry Collector routing;
- trace/metric/log storage;
- feature-flag control path;
- environment fingerprinting;
- baseline proof;
- fault activation proof;
- fault restoration proof;
- permitted overlays; and
- teardown verification.

Fully design these experiments:

- `ERL-OTEL-000` clean control;
- `ERL-OTEL-001` payment service unreachable;
- `ERL-OTEL-002` Kafka queue problems; and
- `ERL-OTEL-003` recommendation cache leak.

For each experiment define:

- upstream mechanism;
- activation and rollback procedure;
- traffic profile;
- warmup, observation and cooldown windows;
- expected direct observations;
- expected missing/ambiguous evidence;
- causal non-consequences;
- misleading decoys;
- correct unknowns;
- supported claim ceiling;
- relevant sabotage solvers;
- cleanup proof; and
- deterministic evaluation mapping.

Do not assume a currently documented upstream flag exists without verification. If an upstream
scenario changed, design a version-pinned alternative without modifying business behavior for
Qualiber's convenience.

### 4.13 Qualiber integration boundary

Map every ERL evidence output to an existing supported Qualiber input or explicitly mark it
unsupported. Include:

- exact CLI/API entry point;
- schema/version expected by Qualiber;
- normalization responsibility;
- customer-plane versus product-plane classification;
- proof-scope mapping;
- tenant and anchor identity;
- connector profile and credential resolution;
- run/artifact output collection;
- deterministic versus AI-enabled mode; and
- authority implications.

Do not silently invent a direct internal call merely because it is easier than the customer
surface. If V1 needs a new public ingestion contract, identify it as a product change with its own
compatibility and acceptance requirements.

Explain whether the existing Scenario Lab `telemetrytest` engine adapter can be reused, wrapped or
must be extended. Include the dependency-direction test that prevents ERL truth or orchestration
from entering product runtime code.

### 4.14 Truth commitment, encryption and reveal

Specify:

- truth-envelope authoring and approval;
- truth-strength assignment;
- schema validation;
- encryption algorithm and envelope format;
- key generation, storage, access, rotation and recovery;
- ciphertext and plaintext content hashes;
- commitment timing;
- required observation/output hashes before reveal;
- reveal authorization;
- append-only reveal record;
- prevention of a second mutable solve after reveal;
- failed/partial reveal behavior;
- superseding truth corrections; and
- retained audit material.

Avoid security-by-obscurity. State the threat model. Be honest about what repository permissions
and encryption can and cannot protect from a solo machine administrator.

### 4.15 Structured-claim projection and deterministic evaluation

Define how Qualiber outputs become an evaluator-owned structured claim set. Specify:

- supported input artifacts;
- claim identity;
- fact, association, causal, unknown, confidence, recommendation and authority categories;
- citation binding;
- duplicate and contradictory claims;
- claim normalization;
- unsupported output handling;
- parser/version pinning; and
- failure behavior when projection is incomplete.

Define formulas and denominators for at least:

- evidence precision;
- evidence recall;
- cross-source link accuracy;
- causal overclaim rate;
- correct abstention;
- confidence calibration;
- misleading-evidence resistance;
- degradation honesty;
- authority safety;
- determinism; and
- infrastructure/product failure classification.

For every metric specify:

- unit of evaluation;
- numerator and denominator;
- zero-denominator behavior;
- excluded rows;
- severity weighting, if any;
- pass threshold and why;
- whether it can gate V1;
- aggregation across experiments; and
- resistance to gaming.

Do not collapse all metrics into a single score unless you can prove that the aggregation does not
hide overclaim, authority or clean-control failures. Safety invariants should normally be separate
hard gates.

Define the sabotage matrix. At minimum cover:

- ticket-trusting;
- recency-only;
- single-source;
- cluster-equals-RCA;
- always-confident;
- always-inconclusive;
- ignores-connector-health;
- ignores-temporal-cutoff; and
- leaks-post-cutoff-truth.

Each experiment must name the sabotage variants it can genuinely discriminate. A declared but
inapplicable sabotage must fail scenario admission rather than padding coverage.

### 4.16 Failure taxonomy, retries and recovery

Create a comprehensive matrix covering:

- invalid configuration;
- unsupported host/prerequisite;
- image pull/build failure;
- port conflict;
- health timeout;
- baseline application failure;
- fault activation failure;
- traffic failure;
- evidence-source unavailable;
- partial pagination;
- truncation limit;
- redaction failure;
- observation freeze failure;
- Qualiber process failure;
- Qualiber artifact validation failure;
- truth commitment mismatch;
- reveal failure;
- evaluator failure;
- restoration failure;
- teardown residue; and
- verification failure.

For each state define:

- owning subsystem;
- machine-readable code;
- retryability;
- maximum retries/backoff;
- state-machine destination;
- whether the run is scoreable;
- whether the result says anything about Qualiber;
- required cleanup; and
- operator-facing message.

The CLI may use non-zero exits for ERL's own orchestration failures, but these exits must not be
confused with Qualiber's customer-CI authority. Define the ERL CLI exit-code contract explicitly.

### 4.17 Security and privacy design

Produce a threat model covering:

- malicious or compromised upstream images;
- poisoned repositories or dependencies;
- truth leakage into solver inputs;
- solver escape into vault/evaluator state;
- symlink/path traversal;
- container/socket privilege;
- host filesystem exposure;
- credential leakage;
- log/trace PII;
- webhook forgery and replay;
- SSRF and unsafe external URLs;
- tenant crossover;
- artifact tampering;
- signing-key misuse;
- CI artifact exposure;
- dependency/supply-chain drift; and
- denial of service through unbounded evidence.

For each threat provide asset, actor, attack path, control, residual risk and verification test.

Specify:

- container user/capability policy;
- Docker socket policy;
- network egress policy;
- secret injection mechanism;
- allowlists;
- TLS verification;
- redaction order;
- log retention;
- SBOM/image scanning expectations;
- signature algorithms and trust roots; and
- keyless versus managed-key behavior.

Do not claim container execution proves resistance to a kernel/runtime escape. State the actual
isolation boundary and residual risk.

### 4.18 Deployment and environment profiles

Design:

- local developer profile;
- CI ephemeral profile;
- SaaS connector profile; and
- future Kubernetes profile boundary.

For each define prerequisites, resources, credentials, networking, storage, timeouts, concurrency,
cleanup and unsupported conditions. Resolve how multiple concurrent runs avoid port, network,
volume, tenant, cursor and artifact collisions.

### 4.19 Observability and operator experience

Define ERL's own telemetry without contaminating experiment evidence:

- lifecycle logs;
- structured events;
- metrics;
- correlation/run IDs;
- progress output;
- diagnostics bundle;
- sensitive-field handling;
- failure summaries; and
- cost/resource reporting.

Design command syntax and output for:

- `erl doctor`;
- `erl select`;
- `erl plan`;
- `erl provision`;
- `erl baseline`;
- `erl activate`;
- `erl traffic`;
- `erl observe`;
- `erl freeze-observation`;
- `erl solve`;
- `erl freeze-output`;
- `erl reveal`;
- `erl evaluate`;
- `erl restore`;
- `erl destroy`;
- `erl verify`;
- `erl rotate`; and
- `erl status`.

Specify JSON output and human output. Define safe defaults, dry-run behavior, confirmation rules and
which commands may mutate external SaaS state.

### 4.20 Performance, capacity and cost budgets

Set measurable V1 budgets for:

- local CPU/memory/disk;
- startup and health timeout;
- baseline/fault run duration;
- maximum evidence rows and bytes by source;
- maximum retained raw telemetry;
- concurrent runs;
- API requests;
- retries;
- CI runtime;
- artifact retention; and
- optional AI tokens/cost.

Explain behavior when a limit is reached. Limits must result in explicit truncation or a bounded
failure, never silent data loss.

Include a cost model for:

- local-only MVP;
- ephemeral hosted CI;
- optional SaaS connector lane; and
- future always-on/multi-environment operation.

### 4.21 Test and verification strategy

Provide a test matrix covering:

- pure contract/unit tests;
- property and fuzz tests;
- driver integration tests;
- real ephemeral-service tests;
- environment smoke tests;
- golden artifact tests;
- security/adversarial tests;
- sabotage discrimination tests;
- crash/recovery tests;
- temporal-cutoff tests;
- clean controls;
- chaos tests;
- held-out governance tests;
- deterministic replay; and
- end-to-end attestation verification.

For each top-level acceptance criterion, identify the exact test or runbook evidence that proves
it. Include negative tests and refusal behavior, not only happy paths.

Specify which tests run:

- on every ERL change;
- on relevant Qualiber PRs;
- nightly;
- weekly;
- manually; and
- on preprod-to-main release paths.

Infrastructure failure must not fail a Qualiber regression gate as if the product were wrong.
Define the rerun and adjudication policy.

### 4.22 CI/CD, versioning and release governance

Define:

- repository workflows;
- branch protections;
- required checks;
- version compatibility among ERL, Qualiber, contracts and environments;
- image/dependency update process;
- held-out workflow access;
- artifact signing and retention;
- release-attestation production;
- exposure recording;
- corpus rotation; and
- rollback.

State when ERL results are informational versus release-gating. No held-out gate becomes required
until a calibration period and explicit approval are complete.

### 4.23 OSS time-machine extension

Design `ERL-OSS-001` as a V1 extension or V1.1 slice:

- candidate discovery;
- pre-registration and random selection;
- licensing/provenance review;
- repository mirror and commit pinning;
- pre-fix reproduction proof;
- evidence availability cutoff;
- later fix/regression-test truth isolation;
- issue/PR identity mapping;
- reproducibility criteria;
- score mapping; and
- rotation after exposure.

Differentiate evidence that existed before cutoff from later historical evidence available only to
the judge. A bug-fix PR is not automatically causal truth; specify the evidence required to assign
T3.

### 4.24 Delivery slices and implementation map

Turn the build plan phases into mergeable implementation slices. For each slice provide:

- objective;
- prerequisites;
- exact repository and proposed files/modules;
- contracts introduced or changed;
- implementation tasks;
- tests;
- runbook evidence;
- exit criteria;
- rollback/removal strategy;
- estimated engineering effort; and
- parallelization constraints.

The first slice must be integrity contracts and a no-op lifecycle, not a partially governed live
fault. The clean control must land before positive fault scenarios. Held-out authority must land
after development-lane stability and evaluator calibration.

Include both:

- a three-week MVP path; and
- the complete 8–12-week V1 path.

### 4.25 Risks, open questions and required ADRs

Maintain three separate registers:

1. risks with likelihood, impact, mitigation, owner and trigger;
2. open questions with classification, owner, deadline and safe blocked behavior; and
3. required ADRs with decision scope and sequencing dependency.

At minimum evaluate whether separate ADRs are required for:

- ERL trust and repository boundary;
- truth commitment/reveal protocol;
- canonical artifact identity;
- deterministic evaluation authority;
- live-environment execution and supply-chain policy; and
- held-out ERL release authority.

### 4.26 Traceability matrix

End the main document with a traceability matrix mapping:

- every build-plan V1 scope item;
- every non-negotiable invariant;
- every `ERL-FR`, `ERL-NFR`, `ERL-SEC`, `ERL-INT`, `ERL-OPS` and `ERL-AC` requirement;
- design section;
- implementing component;
- verifying test/runbook; and
- delivery slice.

Missing traceability is a design defect.

## 5. Required appendices

Include:

### Appendix A — Complete artifact examples

Provide coherent examples from one run. IDs and hashes must cross-reference consistently. Do not
use ellipses in integrity-critical examples.

### Appendix B — Error-code catalog

List every machine-readable error code, owner, retryability, HTTP/CLI mapping if applicable and
safe operator message.

### Appendix C — CLI contract

Provide command grammar, required/optional flags, JSON response envelopes, exit codes and examples.

### Appendix D — Experiment admission checklist

Cover truth strength, reproducibility, provenance, license, decoys, clean baseline, discrimination,
resource bounds, cleanup and exposure tier.

### Appendix E — Security verification checklist

Cover secrets, mounts, network, paths, signatures, redaction, supply chain, tenant isolation and
truth leakage.

### Appendix F — Decision and claims vocabulary

Define observable fact, association, hypothesis, causal claim, known unknown, correct abstention,
claim ceiling, evidence support and action authority precisely.

## 6. Design quality bar

The design is not ready for approval if any of these are true:

- A builder must invent fields or state transitions.
- "Encrypted vault" is stated without a key and reveal protocol.
- "Random selection" is stated without a reproducible commitment algorithm.
- "Content addressed" is stated without canonical byte rules.
- Empty evidence can mean either healthy-empty or unavailable.
- Post-cutoff evidence can enter the observation bundle without detection.
- A run can be rerun with mutable output after truth reveal.
- Product, infrastructure and connector failures share one result state.
- Metrics lack formulas or zero-denominator rules.
- Prose similarity influences a deterministic gate.
- AI critique can override deterministic evaluation.
- A held-out exposure does not force demotion/rotation.
- The OpenTelemetry environment is described without a baseline and restoration proof.
- Teardown success is asserted without checking containers, volumes and run state.
- The Qualiber integration bypasses supported customer interfaces without declaring a product
  contract change.
- Security claims exceed the actual container/host boundary.
- The document claims synthetic or OSS testing proves customer value.
- V1 depends on a deferred component.
- Acceptance criteria are not tied to executable tests or auditable run evidence.

## 7. Required final self-review

Before delivering the document:

1. Check every section for contradictions with the build plan and governing ADRs.
2. Validate every Mermaid diagram syntactically.
3. Check all repository paths and current-behavior claims against source.
4. Verify that every producer has a consumer and every consumer input has a producer.
5. Verify every state has a representable failure and recovery outcome.
6. Verify IDs, hashes and references in artifact examples are internally consistent.
7. Verify all limits have explicit exceeded behavior.
8. Verify no secret or plaintext truth path is reachable by the solver.
9. Verify metrics reward honest uncertainty and punish unsupported certainty.
10. Verify clean-control failure is a hard safety signal.
11. Verify infrastructure failures cannot masquerade as product regressions.
12. Verify the traceability matrix has no missing V1 requirement.
13. Run any Markdown/link checks available in the ERL workspace. Do not use Qualiber's checks as if
    the design were stored inside the product repository.
14. If the ERL workspace is a Git repository, run `git diff --check` there. If it is not yet a Git
    repository, run an equivalent whitespace validation against the produced file and report that
    repository-level diff validation was unavailable.

End your response with:

- the path of the created design document;
- a concise summary of decisions made;
- all design-blocking questions, if any;
- any proposed deviations from the build plan;
- ADRs required before implementation; and
- the recommended first implementation slice.

Do not begin implementation. Do not create repositories, provision external systems, activate
faults, modify Qualiber runtime code or create paid resources as part of this design task.
