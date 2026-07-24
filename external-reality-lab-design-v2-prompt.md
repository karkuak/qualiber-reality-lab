# External Reality Lab V2 — Independent Architecture Design Prompt

You are the principal architect responsible for producing revision 2 of the implementation-grade
Detailed Design Document for the **External Reality Lab (ERL)**.

The current design contains a strong integrity, isolation, evidence-freezing, blind-reveal and
attestation model, but its mission, terminology, workflow, adapters, evaluation and release plan
are conceptually centered on Qualiber. V2 must correct that architectural coupling.

The desired result is a **domain-bounded, product-independent Reality Lab** in which Qualiber is
the first and deepest subject under test, but not part of the Lab core and not the source of the
Lab's environment, truth, scenario selection or validity rules.

This is a design task only. Do not implement the Lab or modify either product repository.

## 1. Filesystem inputs and output

Use these locations exactly during the authoring task:

- **ERL workspace:** `/Users/karthik/Developer/qualiber-reality-lab`
- **Current detailed design:**
  `/Users/karthik/Developer/qualiber-reality-lab/external-reality-lab-design.md`
- **Current implementation plan:**
  `/Users/karthik/Developer/qualiber-reality-lab/external-reality-lab-implementation-plan.md`
- **Original build plan:**
  `/Users/karthik/Developer/qualiber-reality-lab/external-reality-lab-build-plan.md`
- **Original design-authoring prompt:**
  `/Users/karthik/Developer/qualiber-reality-lab/external-reality-lab-design-doc-prompt.md`
- **Required V2 output:**
  `/Users/karthik/Developer/qualiber-reality-lab/external-reality-lab-design-v2.md`
- **Canonical Qualiber checkout, read-only evidence for the Qualiber adapter/deep pack only:**
  `/Users/karthik/Claude/Projects/Qualiber`

Do not overwrite `external-reality-lab-design.md`. V2 must be written as a separate document so
architectural reviewers can compare it with revision 0.9.8 before declaring it superseded.

The absolute authoring paths above must never appear in portable runtime contracts, persisted
identities, manifests, CI configuration or production runbooks. Use symbolic roots and
repository-relative paths in the proposed implementation.

At the start of the task:

1. read all four ERL input documents completely;
2. record their revisions/dates and identify their authority relationship;
3. record the canonical Qualiber checkout branch, `HEAD` and worktree status;
4. use only that checkout for current Qualiber claims;
5. do not use Qualiber architecture as authority for the independent Lab core; and
6. do not silently reuse a second Qualiber checkout.

If an input is unavailable, record the limitation and identify which design claims remain blocked.

Use this precedence when sources conflict:

1. the independent-Lab architectural mandate and honesty constraints in this prompt;
2. accepted ERL V2 ADRs and generally applicable security/integrity requirements;
3. the revision 0.9.8 cryptographic, artifact, cutoff, reveal and trust invariants explicitly
   preserved by this prompt;
4. `external-reality-lab-design.md` as the detailed source design to migrate;
5. `external-reality-lab-implementation-plan.md` and `external-reality-lab-build-plan.md` as
   historical delivery direction to revise; and
6. Qualiber ADRs and source behavior only for the Qualiber adapter, deep-conformance pack and
   consumer integration.

The old build plan and implementation plan are not authoritative when they make Qualiber the
purpose, vocabulary or completion condition of the Lab. Record those conflicts and replace them
explicitly rather than attempting to satisfy both directions simultaneously.

## 2. Architectural mandate

V2 must embody this north star:

> The External Reality Lab independently constructs, operates, perturbs and observes realistic
> software-delivery and production-operations ecosystems. Any compatible product can participate
> as an opaque subject through a standard subject adapter. The Lab core does not know the
> product's feature model, internal architecture, proprietary terminology, scoring rules or
> release authority. Product-specific knowledge exists only in separately owned adapters and
> evaluation packs.

The Lab is not a universal test platform. Bound V2 to products that consume software-delivery,
operational or organizational evidence and produce findings, diagnoses, hypotheses,
recommendations, actions or decisions. Explain why this is a coherent domain boundary and name
what remains outside V2.

The following distinction is mandatory:

- **Lab core:** product-independent orchestration, environment management, journey execution,
  evidence capture, immutable artifacts, truth isolation, evaluation protocol, failure ownership,
  attestation and verification.
- **Subject adapter:** acquisition, packaging, installation interface, configuration interface,
  invocation/interaction translation, health protocol, output collection and projection into a
  generic result contract.
- **Evaluation pack:** domain- or product-specific semantic assertions, while remaining unable to
  change run validity, evidence, truth, selection or generic scoring mechanics.
- **Qualiber deep pack:** additional Qualiber-specific conformance, authority, determinism,
  regression, security and product-contract tests outside the Lab core.

It is acceptable—and necessary—for the Qualiber adapter and deep pack to understand Qualiber.
It is not acceptable for the core to contain Qualiber feature assumptions.

## 3. Honesty constraints

The design must explicitly prevent these misleading claims:

1. **Black-box execution is not sufficient proof of independence.** Independence also requires
   generic mission, contracts, terminology, scenario admission, truth, evaluation mechanics,
   failure taxonomy and release criteria.
2. **Simulation is not bias-free.** V2 may reduce, expose and measure design bias; it must not claim
   to eliminate bias.
3. **Synthetic and OSS cases are not customer external validity.** Retain the T1–T4 distinction;
   only real customer correction plus later outcome may contribute T4 evidence.
4. **A generic evaluator cannot judge arbitrary product semantics.** Product/domain-specific
   projections and evaluation packs are required but must be isolated from core validity.
5. **Unsupported capability is a result.** The Lab must not reshape, remove or silently downgrade a
   case merely because Qualiber or another subject cannot consume its evidence.
6. **Clean reproducibility is not the status quo.** Clean controls validate the experiment, but V2
   must also model brownfield, incomplete, inconsistent and constrained environments.
7. **Lab failure is not subject failure.** Setup/configuration failures can be subject findings,
   but only after proving that the environment and journey were valid.
8. **A reference implementation can bias the benchmark.** Truth and cases must not be derived only
   from a known-good Qualiber run or another candidate's output.
9. **More abstraction is not automatically better.** Every V2 abstraction must have at least two
   concrete uses or a clearly declared V1 extension need.
10. **Architectural independence must be demonstrated.** V2 cannot claim it until the same core
    runs unchanged against Qualiber, a deliberately limited reference subject and at least one
    independently chosen non-Qualiber subject.

## 4. Preserve versus replace

### 4.1 Preserve and generalize

Preserve the intent and rigor of these revision 0.9.8 mechanisms unless a documented defect is
found:

- operator/subject/judge trust separation;
- immutable observation and subject-output freezing;
- typed clock domains and evidence-cutoff enforcement;
- pre-seed policy commitment and deterministic selection;
- reveal only after observation and subject output freeze;
- encrypted truth and held-out exposure governance;
- RFC 8785 JCS, domain-separated SHA-256 identities and Ed25519 signatures;
- independent timestamp checkpoints and dual trust verdicts;
- content-addressed mandatory artifact graphs;
- append-only lifecycle events and crash-safe state recovery;
- source states distinguishing complete, healthy-empty, partial, unavailable and error;
- redaction, secret canaries, path confinement and bounded diagnostics;
- separate activation and restoration receipts;
- zero-residue teardown verification;
- deterministic structured evaluation and explicit uncertainty;
- final-only attestation and offline public verification;
- clean controls, sabotage, chaos and cross-platform replay;
- claim-scope distinction among capability, robustness and external validity.

Generalize names and bindings from `Qualiber`/`solver` to `subject`, `candidate` or another precisely
defined neutral term. The identity chain must bind the exact subject artifact, adapter, evaluation
pack and configuration without assuming a Qualiber-specific mode or schema.

### 4.2 Replace or move out of core

The following must not remain core V2 concepts:

- Qualiber as the definition of a solver;
- Qualiber artifact/config/interface/deterministic/AI tuple as a universal contract;
- Qualiber customer CI exit rules in the generic CLI envelope;
- telemetry/warehouse projections selected because Qualiber already accepts them;
- `unsupported-for-Qualiber` as an evidence attribute;
- projectors embedded in core for Qualiber output schemas;
- Qualiber release policy as a Lab authority;
- a Qualiber importer as a prerequisite for complete ERL V1;
- a compatibility tuple tied to current/previous Qualiber minor releases;
- known-good Qualiber output as truth or admission authority;
- scenario selection based on Qualiber's currently supported evidence classes.

Move any still-useful form of these into the Qualiber subject adapter, Qualiber deep pack or a
separate consumer-integration document.

## 5. Required V2 product model

Design the following concepts precisely and show their ownership boundaries.

### 5.1 Environment archetype

An independently admitted description of a realistic ecosystem, including topology, services,
versions, evidence sources, organizational metadata, access constraints, normal disorder,
resource budgets and cleanup behavior.

At minimum V2 must support or deliberately stage these archetypes:

- clean greenfield;
- brownfield with stale or conflicting configuration;
- partial telemetry/instrumentation;
- inconsistent identifiers and service naming;
- incomplete ownership and deployment metadata;
- restricted permissions and least-privilege credentials;
- dependency and collector version skew;
- rate-limited, delayed or intermittently unavailable APIs;
- misleading alerts, tickets and coincident changes;
- multi-tenant isolation and contamination hazards;
- upgrade, rollback and recovery;
- dirty residual state from an earlier failed attempt.

OpenTelemetry Demo may remain the first live substrate, but the environment model must not assume
Qualiber or observability telemetry is the only subject input.

### 5.2 Journey/challenge

An independently authored sequence representing what an ordinary evaluator or customer team tries
to accomplish. The challenge is defined in ecosystem/domain terms, not product feature names.

Model the full subject journey where applicable:

```text
Acquire → Verify package → Install → Configure → Authenticate → Connect
→ Discover → Exercise → Observe → Diagnose/Decide → Recover → Upgrade → Remove
```

The design must capture:

- elapsed and active operator time;
- prerequisites discovered before and during execution;
- configuration attempts and changes;
- documentation steps and ambiguity;
- credential scopes requested and actually needed;
- warnings, errors and retry behavior;
- manual interventions and undocumented workarounds;
- time to first valid evidence and first useful result;
- recovery from a wrong configuration;
- residue after uninstall/teardown;
- final functional and operational output.

Do not assume every journey is fully automated. Define how human-assisted or agent-assisted steps
are recorded without allowing subjective narration to become deterministic truth.

### 5.3 Subject under test

An opaque packaged product identified by immutable artifact and provenance. A subject declares
domain capabilities and required resources through a bounded manifest, but those declarations may
not modify scenario truth, evidence or generic scoring.

Define strict isolation so the subject cannot access hidden truth, future evidence, fault controls,
judge state, other tenants, host secrets or mutable frozen artifacts.

### 5.4 Subject adapter

Define a small versioned interface for:

- validate package;
- install;
- configure;
- start/health;
- execute a generic interaction step;
- capture subject-visible inputs;
- collect outputs and bounded diagnostics;
- project outputs into a generic subject-result/claim representation;
- stop/uninstall;
- report residue and compensation.

Adapters must expose every external mutation and compensation. They may translate I/O but may not:

- choose or filter hidden cases;
- inspect truth;
- alter environment evidence;
- change evaluation thresholds;
- label the Lab valid;
- hide unsupported inputs;
- map infrastructure failure into subject success/failure;
- run after reveal or output freeze.

Specify an adapter certification suite and an architecture test that proves the Lab core has no
imports, path references, switches or schema branches for a named subject.

### 5.5 Evaluation pack

Separate these layers:

1. **Run validity:** Lab-owned integrity, environment, cutoff, isolation, contamination,
   restoration and artifact-chain gates.
2. **Journey outcome:** generic acquisition/setup/configuration/integration/operation findings.
3. **Domain outcome:** challenge-specific structured facts, associations, uncertainty,
   recommendations and prohibited overclaims.
4. **Subject deep conformance:** optional product-specific invariants such as Qualiber authority,
   deterministic mode or supported contract behavior.

Evaluation packs must be committed before case selection, versioned, content-addressed and unable
to modify core validity. Define how packs are independently reviewed and how a pack is prevented
from encoding a favorable product-specific shortcut.

### 5.6 Evidence consumer

The Lab produces a neutral public verification bundle. Any product, dashboard, CI system or audit
tool may consume it through a generic verifier/library or its own adapter.

Qualiber import must be a separate consumer integration, not a Lab-core dependency or ERL V1
completion condition.

## 6. Required generic contracts

Specify implementation-grade JSON Schema/TypeScript-like contracts, required fields, invariants,
content identities, confidentiality, size bounds, producer, consumer, freeze point and retention
for at least:

- `EnvironmentArchetypeV1`
- `EnvironmentInstanceV1`
- `JourneyDefinitionV1`
- `JourneyStepV1`
- `ChallengeManifestV1`
- `SubjectPackageManifestV1`
- `SubjectAdapterManifestV1`
- `SubjectCapabilityDeclarationV1`
- `SubjectExecutionPlanV1`
- `SubjectInstallationRecordV1`
- `SubjectConfigurationRecordV1`
- `SubjectInteractionRecordV1`
- `SubjectOutputManifestV1`
- `SourceSnapshotV1`
- `ObservationBundleV1`
- `GenericClaimSetV1`
- `FindingV1`
- `EvaluationPackManifestV1`
- `ProvisionalEvaluationV1`
- `RestorationVerificationV1`
- `LabRunRecordV1`
- `FinalLabAttestationV1`
- `PublicVerificationBundleV1`
- trust, timestamp, selection, activation, restoration, reveal and exposure contracts retained
  from V1 under generalized names.

Do not create a large inheritance hierarchy. Prefer explicit closed contracts and composition.
Identify which revision 0.9.8 contracts can be renamed/generalized compatibly, which require a new
major version and which should be removed.

At minimum, `FindingV1` must distinguish:

- `subject_acquisition_failure`
- `subject_package_verification_failure`
- `subject_installation_failure`
- `subject_configuration_failure`
- `subject_authentication_failure`
- `subject_integration_failure`
- `subject_compatibility_failure`
- `subject_runtime_failure`
- `subject_output_contract_failure`
- `subject_functional_miss`
- `subject_misdiagnosis`
- `subject_recovery_failure`
- `subject_upgrade_failure`
- `subject_uninstall_residue`
- `subject_documentation_friction`
- `subject_unsupported`
- `external_dependency_failure`
- `lab_invalid`
- `inconclusive`

Define ownership and proof requirements for each category so a Lab fault cannot be mislabeled as a
subject defect.

## 7. Bias-resistance and realism design

V2 must contain a concrete bias-threat model and enforceable mitigations.

Address:

- cases authored from Qualiber strengths or weaknesses;
- capability filtering that excludes unsupported cases;
- truth derived from candidate output;
- a known-good subject becoming the oracle;
- adapters changing semantics during projection;
- evaluation packs rewarding product-specific vocabulary;
- environment cleanliness favoring products with narrow assumptions;
- manual operators unconsciously helping one subject;
- documentation or configuration hints leaked from hidden truth;
- repeated held-out exposure;
- post-hoc threshold changes;
- omission of setup/configuration failures;
- survivorship bias in OSS/public incident selection;
- simulated-team behavior that reflects the author rather than typical users.

Require mechanisms such as:

- environment and challenge admission independent of candidate behavior;
- pre-registration before subject execution;
- source-grounded truth from environment controls, public incident evidence or independent
  behavioral probes;
- blinded selection and post-freeze reveal;
- unchanged cases across subjects where domain compatibility permits;
- explicit unsupported results instead of case removal;
- separate adapter and truth reviewers;
- actor/persona scripts derived from external evidence and retained as versioned inputs;
- measurement of manual interventions;
- declared simulation limitations;
- calibration using deliberately correct, limited, misleading and broken reference subjects;
- at least one independently selected non-Qualiber subject before an independence claim.

Do not use the phrase “bias-free.” Define residual bias and the claims it prevents.

## 8. Qualiber above-and-beyond track

Design Qualiber as the first comprehensive subject without allowing it to shape core architecture.

### 8.1 Generic Reality Lab suite

Qualiber must experience the same product-independent environment and journey protocol as other
subjects, including:

- private/local package acquisition;
- clean and brownfield installation;
- configuration and credential discovery;
- partial/inconsistent evidence;
- connector degradation and version skew;
- live faults and misleading evidence;
- output usefulness and honest uncertainty;
- recovery, upgrade, rollback and uninstall;
- isolation, performance, resource and secret-handling behavior.

### 8.2 Qualiber adapter

The adapter may know Qualiber packaging, supported public interfaces, deterministic/AI modes,
output schemas and credential references. It must be a separately owned plugin/package and must
pass the generic adapter certification suite.

It must not cause the core to:

- accept only telemetry/warehouse evidence;
- embed Qualiber exit codes;
- use Qualiber terminology in generic contracts;
- alter case eligibility;
- import Qualiber internals;
- classify unsupported evidence as invalid Lab input.

### 8.3 Qualiber deep-conformance pack

Define a separately versioned pack for:

- deterministic/AI/human authority boundaries;
- customer versus product CI authority;
- exact supported input contracts;
- known product invariants and regression rules;
- output schema completeness and determinism;
- unsupported-evidence honesty;
- secret/tenant isolation;
- Qualiber-specific functional assertions;
- compatibility across supported packaged releases;
- optional final-attestation import behavior.

Deep-pack findings must remain distinguishable from generic journey and domain findings. A deep
pack cannot make an invalid Lab run valid.

### 8.4 Local private-product workflow

Qualiber is not yet public. Specify how a local packaged Qualiber artifact is passed explicitly to
the Lab without publishing it, reading from its source tree, relying on a dirty worktree or baking
authoring paths into artifacts.

## 9. Independence proof

Define an executable acceptance test for architectural independence.

At minimum, the same released Lab core and the same admitted environment/challenge must run without
core changes against:

1. Qualiber;
2. a deliberately limited reference subject that truthfully reports unsupported capabilities;
3. a deliberately misleading/broken reference subject used for sabotage; and
4. at least one independently selected non-Qualiber OSS subject in the declared domain.

The design must define:

- how the OSS subject is selected without choosing one merely because it fits the Lab;
- what “same challenge” means when subjects expose different interaction interfaces;
- the permitted adapter differences;
- core binary/package digest equality across the runs;
- evidence that no named-subject branches exist in core;
- expected results for unsupported, correct, partially correct and misleading subjects;
- the exact claim allowed after passing this test.

If selecting the exact OSS subject is pre-implementation rather than a design decision, provide an
owner, deadline, neutral selection procedure, minimum criteria and safe blocked behavior.

## 10. Required state machine and lifecycle

Redesign the V1 state machine around the generic subject journey. Include legal transitions,
guards, immutable artifacts, idempotency, compensation, crash recovery and forbidden transitions.

The lifecycle must cover at least:

```text
created
→ preregistered
→ subject_package_frozen
→ case_selected
→ environment_provisioned
→ baseline_verified
→ subject_install_started/completed/failed
→ subject_config_started/completed/failed
→ subject_connected
→ challenge_activated
→ traffic_or_journey_started
→ evidence_cutoff_realized
→ observation_frozen
→ subject_output_frozen
→ truth_revealed
→ provisional_evaluation_completed
→ subject_recovery_completed
→ environment_restored
→ subject_uninstalled
→ teardown_verified
→ finalized
```

Do not force a failed setup journey to masquerade as a successfully executed functional case.
Define when a setup/configuration finding can be finalized without functional scoring and which
truth may safely be revealed in that path.

Preserve the rule that post-reveal subject execution or output mutation is forbidden.

## 11. Required evaluation model

Retain deterministic structured evaluation, exact citations, vocabulary/version binding,
abstention, causal-overclaim prevention and hard safety gates. Generalize it into four result
planes:

1. **Lab validity:** was the experiment trustworthy?
2. **Journey quality:** could the subject be acquired, installed, configured, connected, operated,
   recovered and removed under the declared archetype?
3. **Domain capability:** did the subject produce supported findings/decisions for the challenge?
4. **Deep conformance:** did it meet optional subject-specific invariants?

Do not collapse these into one scalar score. Define deterministic metrics and zero-denominator
behavior for at least:

- time to install/configure/connect/first evidence/first useful result;
- number and severity of manual interventions;
- least-privilege credential sufficiency and overreach;
- configuration recovery;
- documentation-step success/friction;
- evidence precision/recall and cross-source linking;
- unsupported causal claims;
- correct abstention and degradation honesty;
- functional conclusion coverage;
- recovery/upgrade/uninstall correctness;
- determinism and output contract compliance;
- secret, tenant and authority safety.

Specify which are measurements, informational thresholds, ordinary gates and hard safety gates.
Explain how subject-specific packs add metrics without overriding generic results.

## 12. Security and trust requirements

Generalize the existing threat model. Address:

- malicious or compromised subject packages;
- adapters with excessive host access;
- installation scripts and supply-chain provenance;
- subject attempts to detect hidden cases or future evidence;
- credential exfiltration;
- network egress and SSRF;
- package/container/image tampering;
- cross-subject and cross-tenant contamination;
- truth/reveal leakage;
- adapter or evaluation-pack collusion;
- malicious diagnostics and path traversal;
- human-assisted setup exposing secrets;
- revocation and verification-time trust;
- teardown residue and persistence mechanisms.

The subject must not receive the Docker socket, vault credentials, evaluator code, fault controls,
host root, unrelated user files or unrestricted network access. If installation genuinely requires
privilege, define a narrow brokered capability and retained audit record rather than granting the
subject general host authority.

## 13. Required document structure

Produce `external-reality-lab-design-v2.md` with at least these sections:

1. Document control, authority, source snapshots and revision history
2. Executive summary
3. V2 problem statement and domain boundary
4. Goals, non-goals, requirements and acceptance criteria
5. Architectural principles and decision record
6. System context and trust boundaries
7. Repository/package ownership topology
8. Generic component architecture
9. Environment archetype model
10. Journey and challenge model
11. Subject package and adapter protocol
12. Lifecycle and state machine
13. Evidence capture, time and cutoff model
14. Filesystem, artifact graph and freeze protocol
15. Blind selection, truth, reveal and exposure governance
16. Generic contracts and schema invariants
17. Evaluation packs, finding taxonomy and deterministic metrics
18. Qualiber adapter and deep-conformance pack
19. Independence proof and reference subjects
20. Failure taxonomy, retries, compensation and crash recovery
21. Security, privacy and supply-chain threat model
22. Deployment profiles and local-private-subject workflow
23. Observability, performance, cost and retention
24. Test strategy and adversarial/sabotage matrix
25. CI, calibration, release and claim-scope policy
26. Migration from revision 0.9.8
27. Phased implementation plan and estimates
28. Risks, open questions and required ADRs
29. Requirement-to-component-to-test traceability
30. Approval checklist
31. Appendices with schema examples and executable golden-fixture expectations

Use stable identifiers:

- `ERL2-G-*`
- `ERL2-FR-*`
- `ERL2-NFR-*`
- `ERL2-SEC-*`
- `ERL2-INT-*`
- `ERL2-OPS-*`
- `ERL2-AC-*`
- `ERL2-C-*` for contracts
- `ERL2-D-*` for architectural decisions
- `ERL2-OQ-*` for open questions
- `ADR-ERL2-*` for required ADRs.

## 14. Minimum acceptance criteria

V2 must include precise verification for at least:

- **ERL2-AC-001 Core purity:** Lab-core source, package graph, CLI contracts and bundled output
  contain no named Qualiber branches, imports, paths, exit codes or schema assumptions.
- **ERL2-AC-002 No-op lifecycle:** Generic fake subject completes the immutable lifecycle and
  verifies offline.
- **ERL2-AC-003 Setup finding:** A valid environment plus deliberately broken subject installer
  produces `subject_installation_failure`, not `lab_invalid`.
- **ERL2-AC-004 Lab failure separation:** Broken provisioning produces `lab_invalid` and no subject
  defect.
- **ERL2-AC-005 Unsupported honesty:** A limited subject reports unsupported evidence/capability;
  the case remains admitted and the result is retained.
- **ERL2-AC-006 Status-quo archetypes:** Clean and at least three brownfield/constrained
  archetypes execute with independently frozen configuration.
- **ERL2-AC-007 Functional discrimination:** Correct, limited, always-inconclusive and misleading
  subjects are distinguished by deterministic evaluation.
- **ERL2-AC-008 Qualiber generic run:** Qualiber completes a generic Lab journey through only its
  adapter.
- **ERL2-AC-009 Qualiber deep run:** The separate deep pack adds Qualiber-specific verification
  without changing core validity or generic results.
- **ERL2-AC-010 Cross-subject run:** The same core/environment/challenge executes against the
  required non-Qualiber subjects with identical core digest.
- **ERL2-AC-011 Setup/config capture:** Attempts, interventions, credentials, documentation steps,
  time-to-value and residue are retained without leaking secrets.
- **ERL2-AC-012 Reveal isolation:** No subject or adapter accesses truth/future evidence before
  output freeze.
- **ERL2-AC-013 Tamper resistance:** Offline verification detects byte, path, order, graph,
  signature, trust, timestamp and commitment mutation.
- **ERL2-AC-014 Crash recovery:** Every state resumes or invalidates without duplicate mutation or
  post-reveal execution.
- **ERL2-AC-015 Claim honesty:** Outputs state T1–T3 scope and never claim simulated customer
  external validity.

Add any other acceptance criteria required for a buildable design.

## 15. Migration from revision 0.9.8

Provide an explicit migration matrix for every major V1 component/contract:

- retain unchanged;
- rename/generalize with compatible schema evolution;
- replace with V2 major version;
- move to Qualiber adapter/deep pack;
- move to generic consumer integration;
- defer;
- delete.

At minimum cover:

- CLI and run record;
- selection request/pool/commitment/proof;
- environment profile and fingerprint;
- evidence and cutoff policies;
- observation bundle;
- Qualiber invocation contract;
- solver input/output manifests;
- claim vocabulary/projector/evaluation policy;
- truth, activation, restoration and reveal;
- final attestation and public bundle;
- trust policies and timestamp checkpoints;
- evaluator, runner, capture, registry, governance and verifier modules;
- proposed Qualiber importer;
- existing OTel cases 000–003;
- implementation-plan phases and estimates.

Do not claim the migration is mostly editorial. Identify semantic breaks and required new golden
fixtures.

## 16. Delivery-plan requirements

The V2 design must include an updated delivery plan that does not let generalization become an
open-ended platform program.

Use approximately these dependency-ordered slices, refining estimates as evidence supports:

1. V2 charter, domain boundary, terminology and ADRs
2. Generic integrity/attestation kernel
3. Environment-archetype framework and clean control
4. Journey/setup/configuration capture
5. Generic subject adapter protocol and certification
6. Generic deterministic evaluation/finding model
7. Qualiber adapter and generic Reality Lab suite
8. Qualiber deep-conformance pack
9. Reference subjects and independence proof
10. Brownfield archetypes, chaos and recovery
11. Governance, calibration and V2 release
12. OSS historical/time-machine extension after core V2

For each slice provide:

- objective;
- prerequisites;
- contracts frozen first;
- repositories/packages changed;
- work packages;
- tests and evidence;
- exit gate;
- rollback/disable strategy;
- effort and critical-path dependencies.

Compare the revised estimate with the existing 8–12-week design. Treat 10–16 weeks for one
engineer as an initial hypothesis to validate, not a guaranteed schedule. Identify the smallest
three- to four-week proof that demonstrates generic core + Qualiber adapter without claiming V2
completion.

## 17. Source verification

Use repository evidence for current behavior. Cite Qualiber sources only in the Qualiber adapter,
deep pack, migration or compatibility sections unless explaining why a former core dependency is
being removed.

For unstable upstream facts—OTel Demo release/image/fault flags, external APIs, package formats,
security behavior, runtime support—verify current official primary sources. Record source, version,
commit/digest and verification date. Do not use marketing summaries as implementation authority.

If proposing a non-Qualiber OSS subject, use official repository/documentation evidence and record
the neutral selection criteria. Do not select it merely because integration is easy.

## 18. Required diagrams and tables

Include at least:

- product-independent system-context diagram;
- operator/subject/judge/vault trust-boundary diagram;
- generic subject-adapter boundary diagram;
- end-to-end journey and reveal sequence diagram;
- lifecycle state diagram including setup/configuration failure paths;
- artifact/mandatory-graph diagram;
- Lab validity versus subject finding decision table;
- environment-archetype matrix;
- generic versus Qualiber deep-pack evaluation matrix;
- threat/control/test matrix;
- V1-to-V2 migration matrix;
- phased dependency diagram;
- requirement traceability matrix.

Diagrams must use generic terminology in core architecture. Qualiber should appear only as an
example subject/adapter or consumer.

## 19. Design quality bar

The completed design must be precise enough that an implementation team can build V2 without
inventing:

- what the Lab core knows about a subject;
- how a subject is packaged, installed, configured and invoked;
- which setup and configuration problems count as subject findings;
- how Lab invalidity is proven and separated;
- how adapters and evaluation packs are isolated;
- how cases remain independent of Qualiber capabilities;
- how unsupported functionality is represented;
- how setup/configuration attempts and manual intervention are measured;
- how truth is derived without candidate output;
- how semantic product testing remains possible through deep packs;
- how independence is demonstrated across subjects;
- how public verification works after teardown;
- what V2 may honestly claim.

Avoid filler such as “use best practices,” “ensure scalability,” or “support plugins” without an
interface, owner, invariant, threat, test and failure behavior.

## 20. Mandatory final self-review

Before completing `external-reality-lab-design-v2.md`, perform and document a final audit:

1. Search the core architecture, core requirements and generic contracts for `Qualiber`,
   `telemetrytest`, Qualiber exit codes, product-specific modes and current Qualiber schema names.
   Every occurrence must be removed or justified as an example/adapter/migration reference.
2. Confirm that no generic evidence class is labeled by whether Qualiber supports it.
3. Confirm that an unsupported subject does not cause case removal or Lab invalidity.
4. Confirm that acquisition, installation, configuration, authentication, integration, recovery,
   upgrade and uninstall are observable lifecycle stages rather than prerequisites hidden outside
   the Lab.
5. Confirm that environment and truth can be admitted without running Qualiber.
6. Confirm that adapters cannot change truth, selection, run validity or generic thresholds.
7. Confirm that the Qualiber deep pack cannot turn an invalid generic run into a pass.
8. Confirm that Lab, external dependency, adapter and subject failures are mechanically distinct.
9. Confirm that the same core digest is required by the independence proof.
10. Confirm that no synthetic/OSS result is described as customer external validity.
11. Confirm that the design is domain-bounded and does not promise arbitrary product support.
12. Confirm every P0/V2 requirement maps to a component, contract, test and delivery slice.
13. Confirm all design-blocking choices have an owner, deadline, procedure and fail-closed state.
14. Confirm all cryptographic, artifact and timestamp invariants preserved from revision 0.9.8 are
    represented or explicitly replaced through an ADR.

End the document with:

- a concise approval checklist;
- a list of remaining design-blocking decisions;
- the exact first implementation slice;
- the honest claims permitted after the three- to four-week proof, after core V2, after the
  independence proof and after any future T4 customer evidence.
