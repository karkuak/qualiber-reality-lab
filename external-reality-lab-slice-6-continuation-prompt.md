# External Reality Lab V2 — New-Session Continuation Prompt for Slice 6

You are continuing implementation of the independent **External Reality Lab V2 (ERL2)** in a new session with no prior conversational context.

Your immediate responsibility is to verify the existing Slice 1–5 implementation, align all normative metadata with design revision `2.0.0-draft.11` and accepted ADR-ERL2-013, and then implement, test, and verify:

- **Slice 6 — Generic evaluation, terminal closure, and finalization**; and
- a parallel, non-blocking qualification track for a stronger adapter container/disposable-machine execution profile needed before genuinely opaque Qualiber or third-party OSS execution.

This is an implementation task. Do not produce another broad design or implementation plan. Make only focused normative amendments when executable evidence reveals a genuine conflict.

## 1. Workspace and mandatory inputs

Use these paths exactly:

- **ERL workspace:**
  `/Users/karthik/Developer/qualiber-reality-lab`
- **Master implementation prompt — read completely before acting:**
  `/Users/karthik/Developer/qualiber-reality-lab/external-reality-lab-implementation-prompt.md`
- **Normative detailed design:**
  `/Users/karthik/Developer/qualiber-reality-lab/external-reality-lab-design-v2.md`
- **Normative implementation plan:**
  `/Users/karthik/Developer/qualiber-reality-lab/external-reality-lab-implementation-plan.md`
- **Requirement ledger:**
  `/Users/karthik/Developer/qualiber-reality-lab/docs/ledger/requirements.json`
- **Open-question register:**
  `/Users/karthik/Developer/qualiber-reality-lab/docs/decisions/open-questions.md`
- **ADRs:**
  `/Users/karthik/Developer/qualiber-reality-lab/docs/adr/`
- **Decision/conflict records:**
  `/Users/karthik/Developer/qualiber-reality-lab/docs/decisions/`
- **Claim limits:**
  `/Users/karthik/Developer/qualiber-reality-lab/docs/claims/permitted-claims.md`

The master implementation prompt remains mandatory authority for independence, source precedence, contract-first delivery, security invariants, blocker handling, evidence, testing, and completion.

Authority order:

1. accepted ERL2 ADRs;
2. current `external-reality-lab-design-v2.md`;
3. current `external-reality-lab-implementation-plan.md`;
4. frozen contract majors and approved goldens;
5. the master implementation prompt;
6. this continuation prompt for immediate Slice 6 scope and verified handoff context;
7. historical ERL documents for context only.

If this prompt's handoff summary differs from the workspace, trust executable workspace evidence after explaining the discrepancy.

## 2. Absolute Qualiber independence

Do not inspect, read, modify, import, execute, package, or otherwise access either Qualiber checkout:

- `/Users/karthik/Claude/Projects/Qualiber`
- `/Users/karthik/Developer/qualiber-2nd/qualiber`

Do not create `adapters/qualiber` or `packs/qualiber-deep` during Slice 6.

Slice 6 must be completed entirely with generic contracts, generic operations packs, fake environments, and independent reference subjects. No Qualiber artifact is required or permitted for this task.

The only acceptable occurrences of the product name are documentation describing separation and architecture-purity tests containing forbidden-token lists.

## 3. Reported implementation state to verify

Do not trust this report blindly. Reproduce it from a clean workspace before editing.

### 3.1 Normative state

- ADR-ERL2-012 is accepted.
- `CONFLICT-ERL2-001` is resolved.
- ADR-ERL2-013 is accepted.
- The design is revision `2.0.0-draft.11` dated 2026-07-23.
- ADR-ERL2-013 removed the unauthorized successful transition:

  ```text
  package_manifest_frozen → subject_output_frozen
  ```

- Successful package verification proceeds to challenge preregistration.
- Failed or unsupported package verification reaches the early terminal through the generic terminal step-outcome path.
- `invalidate()` routes through `invalid_failure_detected` before cleanup.
- The pre-environment output/run/bundle branch cannot contain `subject_package_manifest_hash`.

### 3.2 Reported verification baseline

- Slices 1–5 are complete.
- 263 tests pass with zero failures on a clean workspace.
- 118 contracts existed before Slice 5; Slice 5 added 18 adapter contracts, ERL2-C-125 through C-142.
- Generated contracts, architecture purity, CLI evidence, valid bundles, and invalid-record verification pass.
- Neither Qualiber workspace was inspected or modified.

### 3.3 Implemented capabilities

#### Slices 1–2

- contracts, JCS, domain-separated hashing, signatures, trust and acyclic timestamps;
- content-addressed artifacts, path confinement and freezing;
- append-only lifecycle and crash recovery;
- development selection protocol and independent verification;
- valid and invalid terminal records;
- mandatory graph closure;
- offline bundle and invalid-record verification;
- threshold-VRF fail-closed refusal.

#### Slice 3

- environment contracts and one shared `EnvironmentDriver` suite;
- deterministic fake driver;
- reservation allocator, clean controls and resource frontier;
- partial-provision, contamination, mutation/compensation, restoration/teardown failure and residue fixtures;
- Compose disabled pending OQ-005.

#### Slice 4

- journey/oracle split and encrypted judge expectations;
- one generic submachine for all fourteen intents;
- durable acquisition → byte freeze → verification → package-manifest flow;
- candidate-independent challenge admission;
- cutoff/source-state capture;
- replay and live evidence-envelope contracts;
- early valid/invalid terminals;
- oracle-canary and lifecycle-derived closure.

#### Slice 5

- eighteen adapter contracts;
- versioned SDK and protocol;
- local-process adapter host with bounded framing, deadlines and process-tree termination;
- capability grants and privileged-operation denial;
- credential-handle and egress adjudication;
- mutation, receipt and compensation tracking;
- output freezing and bounded diagnostics;
- translation totality;
- certification harness;
- reference-correct and reference-limited adapters;
- hostile adapter fixtures and typed ownership outcomes;
- adapter removability with identical core digest.

### 3.4 Current sandbox limitation

The enabled `local-process` profile does **not** provide kernel-enforced isolation from the operator account. It reports unsupported controls rather than claiming them:

- no read-only root filesystem;
- no guaranteed non-root numeric UID;
- no capability drop/no-new-privileges/seccomp;
- no cgroup/PID/memory/CPU enforcement;
- no network namespace or kernel socket denial;
- no kernel-enforced read-only mounts;
- no reliable home-directory isolation.

The container profile is disabled because no adapter substrate has been qualified. Trusted reference fixtures may use the local-process profile. Do not run opaque Qualiber or third-party OSS packages under it and do not describe it as strong isolation.

### 3.5 Existing fail-closed states

- OQ-001: no privilege broker; all privileged operations refused.
- OQ-004: data-only pack DSL; no executable pack modules.
- OQ-005: Compose disabled; fake driver only.
- OQ-007: development beacon only; held-out/blind refused.
- Threshold VRF: `THRESHOLD_VRF_NOT_ACTIVATED`.
- OQ-002: no brownfield claims.
- OQ-003: no architectural-independence claim.
- OQ-006: no held-out production release.
- No Qualiber integration or product-specific deep pack.

## 4. Preflight and normative alignment

Before editing:

1. Read the master implementation prompt completely.
2. Read the current design sections covering result planes, evaluation packs, finding taxonomy, lifecycle, cleanup, finalization, bundles, verification, tests, Slice 6, and migration/versioning.
3. Read Slice 6 and the Slice 7 entry gate in the implementation plan.
4. Read ADR-ERL2-012 and ADR-ERL2-013.
5. Inspect repository-local instructions and current worktree status.
6. Preserve unrelated user work.
7. Verify that design, implementation plan, ledger, and generated evidence all name revision `2.0.0-draft.11`.
8. If the plan still names draft.10, update its normative-source metadata and entry references to draft.11 without changing Slice 6 semantics.
9. Ensure the ledger pins draft.11 and accepted ADR-013.
10. Run the clean baseline using the repository's actual scripts. At minimum:

   ```text
   npm run clean
   npm install
   npm run build
   npm run typecheck
   npm run verify:generated
   npm test
   npm run purity
   npm run evidence
   ```

11. Confirm the reported 263-test baseline or explain the exact difference.
12. Confirm the package-verification transition is rejected at transition-table, schema, workspace, and graph-closure layers.
13. Confirm neither Qualiber workspace is required or accessed.

Do not begin Slice 6 with an unexplained failing baseline or unresolved normative revision drift.

## 5. Slice 6 objective and boundaries

Implement deterministic, product-independent evaluation and terminal closure without introducing a scalar product score or giving evaluation packs authority over Lab validity.

Slice 6 must produce four isolated result planes:

1. **Lab validity:** whether the experimental run and evidence are trustworthy enough to attest.
2. **Journey result:** acquisition, installation, configuration, connection, operation, recovery, assistance and unsupported behavior.
3. **Generic domain result:** subject-neutral software-delivery/operations claims, citations, facts and safety assertions.
4. **Optional deep result:** not implemented in Slice 6; only its ancestry boundary must be protected for Slice 8.

No scalar leaderboard score may combine these planes.

The generic evaluator may not infer arbitrary product semantics. It evaluates only committed generic contracts and certified domain-pack rules.

## 6. Slice 6 implementation order

### 6.1 Review and complete the finding union

Inspect existing finding contracts before modifying them. Complete the closed, discriminated union for:

- subject finding;
- dependency failure;
- adapter failure;
- evaluator failure;
- Lab invalidity;
- inconclusive finding;
- cancellation evidence where represented separately by terminal reason.

Enforce literal owner/category combinations. A finding cannot change owner through optional fields.

Required behavior:

- infrastructure or Lab failure never becomes a subject defect;
- adapter protocol/projection/mutation failure never becomes a subject defect;
- unsupported is retained and is not Lab invalidity;
- subject attribution requires its committed prerequisites;
- invalid runs cannot attest subject defects, even if diagnostic measurements exist;
- contradictory owner/category/status combinations fail schema and runtime validation.

Add contract fixtures and mutation tests for every union branch and prohibited crossover.

### 6.2 Freeze the data-only evaluation-pack DSL

OQ-004 remains fail-closed. Implement only a declarative, data-only pack format.

The pack may declare:

- pack identity, version, domain and scope;
- vocabulary and truth schema hashes;
- input contract identities;
- assertion and metric identifiers;
- deterministic fact/citation predicates;
- inclusions and exclusions;
- numerator, denominator and zero behavior;
- thresholds and threshold classes;
- claim ceilings;
- reviewer and bias-review identities;
- applicable challenge/archetype families;
- deterministic output ordering.

The pack must not contain or invoke:

- arbitrary JavaScript, shell, WASM or native code;
- filesystem/network/process APIs;
- ambient clock or randomness;
- environment mutation;
- selection, truth reveal or adapter APIs;
- validity setters;
- generic threshold mutation;
- candidate-specific shortcuts in a subject-neutral pack.

Implement certification that scans for product names, candidate tokens, shortcut predicates, undeclared vocabulary, unknown metric IDs and forbidden authority.

If the existing evaluation SDK already exposes declarative structures, extend them compatibly rather than replacing them with executable code.

### 6.3 Implement deterministic metric primitives

Implement a pure evaluator library for:

- exact fact support;
- citation existence and reachability;
- precision/recall/coverage where defined;
- unsupported retention;
- causal-overclaim checks;
- secret/credential safety checks;
- operator intervention counts and severity;
- elapsed and active journey time;
- retry and failure counts;
- recovery/rollback/remove outcomes;
- explicit inconclusive behavior;
- safe zero-denominator handling.

Every metric must define:

- inputs and canonical ordering;
- numerator and denominator;
- zero behavior;
- missing/unavailable input behavior;
- threshold class;
- claim ceiling;
- stable result identity;
- reason codes.

Do not use prose similarity, nondeterministic models, ambient time, floating platform-specific behavior, or post-hoc thresholds in attesting generic evaluation.

### 6.4 Implement journey evaluation

Produce the correct terminal variant:

- `PreSelectionJourneyResultV1` for acquisition/package terminals;
- `SelectedJourneyResultV1` for selected environment journeys.

Derive exact ordered step outcomes from commitments and lifecycle events rather than trusting subject-output arrays.

Journey evaluation must account for:

- succeeded, failed and unsupported intents;
- attempts and retries;
- active versus elapsed time;
- documentation use and prompts;
- credential requests/grants/use;
- assistance events and manual interventions;
- declared mutations and compensations;
- recover/rollback/remove behavior;
- setup/connection failure attribution;
- cancellation and invalid-run boundaries.

Failed or unsupported steps reveal only their committed judge expectations. Functional truth remains unrevealed when the design forbids it.

### 6.5 Implement generic domain evaluation

Produce exactly one:

- `DomainResultEvaluatedV1`; or
- `DomainResultNotApplicableV1`.

An evaluated result requires all design-mandated ancestors, including frozen observation/evidence/output and permitted truth reveal. A not-applicable result must carry the exact reason and journey-result reference.

Do not invent functional scoring for:

- failed acquisition/package verification;
- failed setup or connection where functional evidence is unavailable;
- missing or invalid evidence;
- invalid Lab runs.

Retain unsupported inputs and explicit inconclusive outcomes.

### 6.6 Implement reference evaluation subjects/fixtures

In addition to existing correct and limited reference adapters, add independent behavior needed to prove discrimination:

- **reference-misleading:** produces plausible but unsupported or causally excessive claims;
- **reference-inconclusive:** honestly cannot reach a conclusion;
- **fabricated-citation sabotage fixture:** cites missing, altered or unreachable evidence.

Use the same public adapter protocol, evidence envelope and generic evaluation path. Do not add core branches for these subjects.

These may be separate removable adapter packages or certified test fixtures, but architecture-purity and removability tests must prove core independence.

### 6.7 Implement the precleanup result join

`GenericPrecleanupResultJoinV1` is the sole cleanup-entry guard.

Require:

- journey result frozen;
- exactly one evaluated-or-not-applicable domain result frozen;
- both hashes match the run and policy;
- join lifecycle event follows both results;
- cleanup starts only after the join;
- no duplicate, reordered, missing or cross-run result;
- no producer boolean substitutes for lifecycle-derived ordering.

Add negative tests for cleanup-before-join, one missing branch, duplicate result, wrong run/policy, wrong domain variant and forged ordering.

### 6.8 Implement Lab-owned validity evaluation

Validity gates may inspect only Lab-owned integrity and experimental-control evidence.

Implement pre-environment and environment validity variants. Gate categories should cover the design's required controls, including as applicable:

- contract/schema closure;
- lifecycle/state integrity;
- acquisition/package integrity;
- selection/reveal integrity;
- environment baseline and contamination;
- cutoff and evidence completeness;
- adapter certification and authority compliance;
- output freeze;
- result-join closure;
- cleanup/restoration/teardown;
- exposure/trust/timestamp/graph closure prerequisites.

Validity must not depend on whether subject claims are correct, useful, complete or favorable.

Only `status="valid"` may reach `GenericEvaluationIndexV1`. `status="invalid"` must freeze an invalid terminal record and stop before generic finalization.

### 6.9 Complete cleanup and emergency-cleanup evaluation

Reuse and complete the Slice 3/5 cleanup primitives:

- pre-environment cleanup verification;
- environment restoration verification;
- teardown verification;
- emergency cleanup verification;
- discriminated emergency action union.

Enforce:

- safe succeeded/failed actions require receipts;
- failed actions also require reasons;
- unsafe skips require a reason and forbid receipts;
- independently safe actions cannot be skipped;
- remaining resources and containment state are explicit;
- restoration/teardown failure cannot transition directly to invalid record;
- cleanup result matches the actual resource frontier.

### 6.10 Implement the generic evaluation index

For a valid run only, bind:

- generic run policy;
- validity result;
- journey result;
- domain result;
- precleanup result join;
- evaluator release/version.

The index must contain no deep-pack commitment/result and no product-specific field.

Reject invalid validity, wrong variants, stale results, cross-run references and result hashes not derived from the lifecycle closure.

### 6.11 Implement valid run records and finalization

Implement/complete both valid run-record variants:

- pre-environment;
- environment.

Then implement finalization in this order:

1. verify terminal run-record variant;
2. independently derive mandatory graph closure;
3. verify applicable cleanup and zero/explicitly contained residue;
4. verify exposure state;
5. verify signer inventory;
6. verify trust at creation under the correct V2 trust contracts;
7. verify acyclic timestamp checkpoints;
8. freeze final attestation;
9. freeze `PublicVerificationBundleV2` matching the terminal variant;
10. verify the bundle offline in a fresh process.

The finalizer must refuse:

- incomplete graph;
- invalid run;
- cleanup failure without invalid terminal routing;
- missing result join;
- trust, timestamp, signer or exposure failure;
- terminal-variant crossover;
- V1/V2 member crossover;
- extra mandatory-reachable artifacts omitted by the run record;
- early finalization containing synthetic selection/environment artifacts.

### 6.12 Protect the future deep-result boundary

Do not implement the Qualiber deep pack in Slice 6. Ensure generic/base contracts and code have no dependency on deep packs.

Add architecture and fixture tests proving that an optional deep descendant can only reference a frozen valid environment base and that no generic/base object contains a deep commitment, policy, pack or result field.

## 7. Parallel safety track — qualify stronger subject isolation

This track must not block Slice 6's trusted reference evaluation, but it controls readiness for Slice 7 and Slice 9.

### 7.1 Goal

Determine and document whether the available host can enforce a container or disposable-VM profile suitable for opaque private or third-party subjects.

Required controls to assess:

- read-only root filesystem;
- numeric non-root user;
- dropped capabilities;
- no-new-privileges;
- seccomp or equivalent syscall restriction;
- CPU, memory, PID and wall-clock limits;
- process-tree termination;
- network namespace and deny-by-default egress;
- read-only input mounts and isolated writable output;
- no Docker socket, host home, vault, truth, judge or selection access;
- bounded diagnostics;
- run-scoped filesystem/network/resource identity;
- teardown and residue inspection.

### 7.2 Honest outcomes

Choose one evidence-based outcome:

- **qualified container profile:** all required controls are actually enforced and tested;
- **qualified disposable-VM profile:** equivalent isolation is enforced and tested;
- **not qualified:** retain `disabled_no_qualified_adapter_substrate`, document missing controls and keep opaque subjects blocked.

Do not enable a profile because a manifest says it is enabled. Derive enabled status from a qualified immutable substrate lock and passing enforcement probes.

### 7.3 Scope constraints

- Do not implement a privilege broker as part of this track.
- Do not run Qualiber or an OSS subject.
- Do not weaken OQ-001.
- Do not claim kernel isolation from mocked tests alone.
- If Docker/VM access is unavailable, complete the qualification procedure, fake enforcement harness and refusal paths, but keep the profile disabled.

Record any new blocking decision in the open-question register with owner, deadline and executable fail-closed state.

## 8. Mandatory Slice 6 adversarial fixtures

Add at least:

- correct subject;
- limited/unsupported subject;
- always-inconclusive subject;
- misleading/causal-overclaim subject;
- fabricated-citation subject;
- contradictory finding owner/category;
- unsupported relabeled invalid;
- Lab failure relabeled subject defect;
- adapter failure relabeled subject defect;
- empty source and zero denominator;
- missing/unreachable/altered citation;
- duplicate or reordered step outcome;
- result join missing journey or domain result;
- cleanup before result join;
- cross-run or cross-policy result;
- domain evaluated when functional evidence is unavailable;
- not-applicable result with wrong reason;
- pack attempts I/O, clock, randomness, process, mutation, validity or threshold access;
- pack contains product-specific shortcut vocabulary;
- post-hoc threshold mutation;
- invalid validity routed to generic index;
- valid index with stale/wrong result hash;
- pre-environment terminal containing package manifest, selection, environment, restoration, teardown or exposure artifacts;
- environment terminal missing package/selection/plan/environment ancestry;
- safe emergency action missing receipt;
- unsafe skip missing reason or carrying a receipt;
- restoration/teardown failure bypassing emergency cleanup;
- finalizer signature before cleanup, exposure, trust or graph closure;
- producer closure array omitting a mandatory reachable artifact;
- public bundle with extra execution body;
- V1/V2 contract or terminal-variant crossover;
- invalid record producing any attestation/bundle;
- deep field injected into generic/base artifact.

Each mutation must yield a stable refusal code and the correct failure owner.

## 9. CLI and evidence requirements

Complete only CLI commands already authorized by the design and master prompt. Provide durable multi-process execution for evaluation, cleanup and generic finalization.

Produce evidence for at least:

- correct reference valid environment run and offline bundle verification;
- limited/unsupported valid run;
- inconclusive valid run;
- misleading subject findings;
- fabricated-citation refusal/finding;
- domain-not-applicable setup/connection path;
- invalid validity path producing exactly one invalid record and no bundle;
- result-join refusal;
- emergency-cleanup invalid terminal;
- V1/V2 crossover refusal;
- deep-ancestry injection refusal;
- isolation-profile qualification or explicit disabled refusal.

Run offline verification in fresh processes with network disabled where the harness supports it.

## 10. Verification commands

Use the actual scripts discovered in preflight. At minimum run equivalents of:

```text
npm run clean
npm install
npm run build
npm run typecheck
npm run verify:generated
npm run test:contract
npm run test:architecture
npm run test:adversarial
npm run test:e2e
npm test
npm run purity
npm run evidence
```

Additionally:

- run public-bundle verification on every new valid terminal variant;
- run `verify-record` on every new invalid terminal class;
- run generated-schema drift checks;
- run adapter removability after adding reference-misleading/inconclusive fixtures;
- confirm the core digest is independent of installed adapter packages;
- confirm neither Qualiber checkout is accessed.

Do not weaken tests to pass. Fix the implementation or leave the affected feature disabled.

## 11. Slice 6 exit gate

Slice 6 is complete only when:

- design, plan and ledger agree on draft.11 and ADR-013;
- the full pre-Slice-6 baseline remains green;
- correct, limited, misleading and inconclusive subjects produce expected typed outcomes;
- fabricated citations are detected deterministically;
- data-only packs cannot perform I/O/nondeterminism or alter validity/thresholds;
- journey and exactly one domain result join before cleanup;
- validity remains independent of subject quality;
- invalid validity cannot enter generic index/finalization;
- valid pre-environment and environment terminal variants close correctly;
- public bundles verify offline;
- invalid records verify offline and cannot generate a bundle;
- emergency cleanup action evidence is closed and resource-frontier-derived;
- finalizer refuses graph/trust/timestamp/exposure/cleanup/version crossover defects;
- generic/base artifacts contain no deep dependency;
- architecture purity and adapter removability pass;
- the test suite is green on a clean workspace;
- ledger, runbooks, claim limits and evidence are updated;
- no Qualiber workspace was inspected or modified.

The stronger-isolation track may remain fail-closed without blocking Slice 6, but Slice 7 is **not ready to execute an opaque Qualiber package** unless a suitable container or disposable-VM profile is qualified. Report this readiness separately.

## 12. Stop and decision conditions

Stop the affected workstream and request a decision only if:

- a frozen contract requires a breaking change;
- evaluation requires product-specific semantics in the generic pack;
- the data-only DSL cannot express a required generic rule without gaining prohibited authority;
- validity and generic evaluation cannot remain independent under the current contract graph;
- environment finalization exposes a new normative lifecycle conflict;
- user-owned unrelated changes prevent safe implementation.

Do not stop merely because Compose, held-out selection, threshold VRF, privilege brokering, strong container isolation, Qualiber, or OSS integration is unavailable. Preserve their defined fail-closed states and continue independent Slice 6 work.

## 13. Final handoff

When complete, report:

1. normative revision/ADR alignment;
2. baseline and final test totals;
3. contracts added or changed and compatibility impact;
4. finding ownership and evaluation-pack authority boundaries;
5. journey/domain/validity/index/finalization implementation;
6. correct, limited, misleading, inconclusive and fabricated-citation outcomes;
7. result-join, cleanup and emergency-cleanup evidence;
8. valid bundle and invalid-record offline verification evidence;
9. V1/V2, graph, trust, timestamp and deep-ancestry adversarial results;
10. exact build/test/evidence commands;
11. stronger-isolation qualification result and enforceable controls;
12. open ADRs/OQs and disabled features;
13. architecture-purity and adapter-removability result;
14. confirmation that neither Qualiber workspace was inspected or modified;
15. a separate readiness verdict for:
    - completing Slice 6;
    - beginning Slice 7 adapter development;
    - executing an opaque Qualiber package safely.

Do not report Slice 6 complete if any exit-gate claim is supported only by prose or producer booleans rather than executable, independently derived evidence.
