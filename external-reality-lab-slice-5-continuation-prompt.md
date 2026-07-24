# External Reality Lab V2 — New-Session Continuation Prompt for Slice 5

You are continuing implementation of the independent **External Reality Lab V2 (ERL2)** in a new session with no prior conversational context.

Your immediate responsibility is to verify the existing Slice 1–4 implementation, resolve one lifecycle-transition discrepancy, and then implement, test, and verify **Slice 5 — Adapter SDK, sandbox host, and reference subjects**.

This is an implementation task. Do not produce another design or implementation plan unless a genuine normative conflict requires a focused amendment.

## 1. Workspace and mandatory inputs

Use these paths exactly:

- **ERL workspace:**
  `/Users/karthik/Developer/qualiber-reality-lab`
- **Master implementation prompt — read completely first:**
  `/Users/karthik/Developer/qualiber-reality-lab/external-reality-lab-implementation-prompt.md`
- **Normative detailed design:**
  `/Users/karthik/Developer/qualiber-reality-lab/external-reality-lab-design-v2.md`
- **Normative implementation plan:**
  `/Users/karthik/Developer/qualiber-reality-lab/external-reality-lab-implementation-plan.md`
- **Requirement ledger:**
  `/Users/karthik/Developer/qualiber-reality-lab/docs/ledger/requirements.json`
- **Open-question register:**
  `/Users/karthik/Developer/qualiber-reality-lab/docs/decisions/open-questions.md`
- **Accepted ADRs and design decisions:**
  `/Users/karthik/Developer/qualiber-reality-lab/docs/adr/`
  `/Users/karthik/Developer/qualiber-reality-lab/docs/decisions/`

The master implementation prompt is mandatory context. Follow its independence rules, source precedence, contract-first workflow, evidence requirements, prohibited shortcuts, slice gates, blocker behavior, and completion criteria.

If this continuation prompt conflicts with an accepted ADR or the current detailed design, the ADR/design wins. If it conflicts with the master implementation prompt only about the immediate work scope, this continuation prompt wins because it records later Slice 4 evidence and the next authorized task.

## 2. Absolute Qualiber independence

Do not inspect, read, modify, import, or execute either Qualiber checkout:

- `/Users/karthik/Claude/Projects/Qualiber`
- `/Users/karthik/Developer/qualiber-2nd/qualiber`

Slice 5 must be completed with independent reference subjects. Do not create `adapters/qualiber`, a Qualiber deep pack, a Qualiber-specific core branch, or any source-level integration.

The only legitimate mentions of the product name in the independent core workspace are documentation explaining the separation and architecture-purity tests that scan for forbidden coupling.

## 3. Reported implementation state to verify

Do not trust this summary blindly; verify it against the clean workspace and executable evidence.

### 3.1 Completed work

- ADR-ERL2-012 option 1 was accepted.
- `CONFLICT-ERL2-001` was resolved.
- The design was updated to revision `2.0.0-draft.10`.
- V2 trust/lifecycle majors are frozen:
  - `trust-policy-manifest/v2`;
  - `signer-inventory/v2`;
  - `trust-verification-report/v2`;
  - `lab-lifecycle-event/v1`.
- Retained V1 identities remain readable and unmodified.
- Slices 1–4 are reported complete.
- 115 tests reportedly pass with zero failures on a clean checkout.
- The ledger pins the design revision.
- Core builds without either Qualiber workspace.

### 3.2 Slice 1–2 capabilities

- contract generation and validation;
- JCS, hashing, signatures, trust, timestamps, artifact freezing and path confinement;
- append-only lifecycle and recovery;
- valid and invalid terminal records;
- mandatory graph closure;
- offline public-bundle and invalid-record verification;
- complete development selection chain with independent re-derivation;
- fail-closed held-out/blind refusal;
- threshold-VRF refusal.

### 3.3 Slice 3 capabilities

- environment contracts and six-operation `EnvironmentDriver` interface;
- deterministic fake driver;
- reservation allocator;
- clean control and resource frontier;
- partial-provision, contamination, mutation/compensation, restoration/teardown failure and residue fixtures;
- Compose remains disabled pending ERL2-OQ-005;
- substrate-lock qualification and drift detection exist.

### 3.4 Slice 4 capabilities

- 30 journey/acquisition/capture contracts;
- subject-visible step and encrypted judge-expectation split;
- age v1 X25519 commitment encryption;
- one generic submachine for all 14 journey intents;
- durable multi-process acquisition → freeze → verify → package-manifest flow;
- candidate-independent challenge registry;
- cutoff/clock/source-state capture;
- replay/live evidence envelopes and total translation rules;
- early valid/invalid terminals;
- CLI journey commands;
- oracle-canary, lifecycle-closure and capture tests.

### 3.5 Existing fail-closed states

- Compose disabled pending `ERL2-OQ-005`.
- Held-out/blind selection refused pending `ERL2-OQ-007`.
- Development beacon only.
- Threshold VRF returns `THRESHOLD_VRF_NOT_ACTIVATED`.
- Privilege broker absent pending `ERL2-OQ-001`; unprivileged subjects only.
- Executable evaluation packs absent pending `ERL2-OQ-004`; data-only DSL only.
- No Qualiber integration exists.

## 4. Preflight verification

Before editing:

1. Read the master implementation prompt completely.
2. Read the current design sections relevant to lifecycle, journey, adapter protocol, security, testing, and phased implementation.
3. Read Slice 5 in the implementation plan completely.
4. Inspect repository-local instructions and current worktree status.
5. Preserve unrelated user changes.
6. Run the existing clean baseline:

   ```text
   npm install
   npm run build
   npm test
   npm run evidence
   npm run purity
   npm run verify:generated
   ```

7. Confirm the reported 115-test baseline or explain any difference with exact evidence.
8. Confirm that architecture-purity tests pass without inspecting either Qualiber workspace.
9. Confirm the design, plan, ledger, ADR-012 and conflict-resolution revisions agree.

Do not begin Slice 5 on an unexplained failing baseline.

## 5. Mandatory lifecycle-transition review before Slice 5

The Slice 4 handoff reported two implementation transitions:

1. `package_manifest_frozen → subject_output_frozen`;
2. `invalidate() → invalid_failure_detected` before cleanup routing.

The second transition is consistent with the design requirement that invalid runs pass through `invalid_failure_detected`; ensure it is represented in the transition table, tests, ledger, and any appropriate design clarification.

The first transition requires critical review before it can remain.

### 5.1 Required analysis

Verify the current design and schemas for the `verify_package` terminal:

- The normal successful path is expected to be:

  ```text
  step_outcome_frozen
  → package_manifest_frozen
  → challenge_preregistered
  ```

- A failed or unsupported package-verification terminal is already expected to reach subject-output freezing through the generic terminal step-outcome path.
- The pre-environment run-record/bundle variant must not contain a selected challenge or synthetic environment artifacts.
- Determine whether it permits or forbids a successful package-manifest artifact in a pre-environment terminal.

Inspect actual schemas, lifecycle transitions, closure derivation and fixtures. Do not decide from the handoff summary alone.

### 5.2 Required resolution

Choose the evidence-supported resolution:

#### Resolution A — expected default

If successful package verification is not an authorized early terminal:

- remove `package_manifest_frozen → subject_output_frozen`;
- retain `package_manifest_frozen → challenge_preregistered`;
- ensure failed/unsupported verification uses the generic terminal step-outcome route;
- add negative tests proving a successful package manifest cannot silently finalize through the pre-environment branch;
- preserve existing retained artifacts; regenerate only development fixtures permitted by the golden policy.

#### Resolution B — only if explicitly intended by the design owner

If “successful package verification only” is intended as a valid early stop:

- do not preserve it through code comments alone;
- record a focused design amendment or ADR;
- define the terminal discriminant, run-record ancestry, cleanup, validity, attestation and bundle members;
- decide whether the package manifest is mandatory and how closure treats it;
- add positive and negative fixtures;
- bump any contract major whose closed shape or invariant changes;
- update the ledger and design revision before continuing.

Do not fabricate a package manifest omission merely to fit the current pre-environment variant.

### 5.3 Gate

Proceed to Slice 5 only after:

- the transition table has one unambiguous authorized path;
- closure rejects the unauthorized alternative;
- tests cover successful, failed and unsupported package verification;
- design/ADR, schemas, implementation and ledger agree;
- the full baseline is green.

## 6. Slice 5 objective

Implement a product-independent adapter platform that can execute opaque, untrusted subjects through certified, versioned interfaces without transferring Lab, truth, selection, evidence, validity, cleanup, or evaluation authority to the adapter.

The Slice 5 exit state must include at least:

- a versioned adapter SDK;
- a core-owned adapter host;
- an unprivileged sandbox/process boundary;
- phase-specific request validation;
- capability and credential-handle enforcement;
- mutation intent/receipt/compensation tracking;
- canonical-evidence translation totality;
- output freezing and bounded diagnostic scanning;
- certification harness;
- independently useful correct and limited reference adapters;
- malicious/broken adapter fixtures and typed ownership outcomes.

## 7. Slice 5 implementation order

Implement in this order unless an accepted ADR requires otherwise.

### 7.1 Freeze adapter contracts and protocol

Review existing contract shapes before adding anything. Freeze or complete:

- `SubjectAdapterManifestV1`;
- adapter certification receipt;
- protocol/version negotiation;
- `AcquisitionAdapterRequestV1`;
- `PackageVerificationRequestV1`;
- `AdapterStepRequestV1`;
- operation and attempt identifiers;
- adapter result/response envelopes;
- mutation intent, mutation receipt and compensation receipt;
- credential-handle request/use receipt;
- sandbox invocation manifest and result;
- evidence translation receipt;
- subject-output and bounded diagnostics contracts;
- adapter failure and certification finding contracts.

For each contract add valid, invalid, cross-phase, unknown-field, forward-reference, oversized and wrong-version fixtures.

Acquisition, package verification and post-plan requests must remain structurally disjoint. Do not create one generic request with optional future fields.

### 7.2 Implement the adapter SDK

The SDK may expose only subject-adapter responsibilities:

- validate package kind and declared entrypoints;
- translate generic journey intents into subject operations;
- accept only subject-visible inputs;
- request scoped credential handles;
- declare mutations and compensations;
- collect bounded outputs and diagnostics;
- project frozen output into generic claims;
- produce a total evidence-translation receipt;
- report supported, failed or unsupported outcomes.

The SDK must not expose APIs for:

- challenge selection or pool handles;
- truth or judge expectations;
- canonical evidence mutation;
- Lab validity;
- generic metric thresholds;
- environment-wide arbitrary shell execution;
- finalization or attestation;
- post-reveal execution.

### 7.3 Implement the core-owned adapter host

Use a separate process or equally strong local boundary with:

- exact executable/package identity;
- fixed protocol version;
- bounded request and response sizes;
- deterministic deadlines and process-tree termination;
- read-only subject-visible inputs;
- read-only canonical evidence when the journey phase permits it;
- writable run-scoped output only;
- no ambient home-directory access;
- no Docker socket;
- no truth/judge/vault/selection mounts;
- deny-by-default environment variables;
- deny-by-default egress;
- capped and redacted stdout/stderr;
- explicit lifecycle and attempt receipts;
- crash-safe reconciliation and idempotent resume.

Do not claim OS/container security controls that are not actually enforced. If the current environment cannot provide a promised isolation control, record it as unsupported/disabled and cap the claim.

### 7.4 Preserve OQ-001 fail-closed behavior

`ERL2-OQ-001` is unresolved. Therefore:

- implement no general privileged shell;
- support only unprivileged subject operations;
- reject root, host mutation, reboot, kernel, broad service-manager, Docker socket, and unrestricted native-installer requests;
- expose a stable refusal code for unsupported privileged operations;
- keep any future broker interface behind an inactive boundary;
- do not silently emulate privileged success.

### 7.5 Implement credential handles and egress enforcement

- Credentials are short-lived scoped handles, not plaintext contract fields.
- Record requested, granted and used scopes separately.
- Bind each use to run, adapter, operation and target.
- Prevent handle reuse outside scope or after expiry.
- Apply scheme/host/port/DNS allowlists and redirect revalidation.
- Deny metadata-service, loopback exceptions not explicitly granted, and arbitrary proxy bypass.
- Add secret canaries and verify they do not enter retained diagnostics or output.

### 7.6 Implement mutation and compensation control

For every filesystem, service, configuration, package, credential, or environment mutation:

1. require a declared intent;
2. validate target and authority;
3. execute through the permitted host capability;
4. freeze a receipt;
5. record compensation identity;
6. reconcile on crash/resume;
7. verify cleanup/residue.

Hidden or undeclared mutation is an adapter/Lab integrity failure, never a subject-quality result.

### 7.7 Implement translation totality

The canonical envelope remains Lab-owned and immutable.

For every admitted envelope entry, require exactly one mapping:

- `mapped_exact` with target references;
- `mapped_lossy` with target references and loss reason;
- `unsupported` with reason.

Reject omission, duplication, unknown entry, target outside the translated tree, envelope rewrite, invented source entry, or deletion disguised as compatibility.

### 7.8 Implement output freezing and diagnostics

- Write to a temporary run-scoped output directory.
- Enforce file count, byte, path, type and depth limits.
- Reject symlink/hard-link/special-file/path escape behavior.
- Scan diagnostics for secrets, truth/judge canaries and forbidden identifiers.
- Validate output contracts.
- Inventory, fsync, atomically publish and freeze.
- Forbid adapter/subject execution after output freeze or reveal.

### 7.9 Build the certification harness

Certification must verify:

- immutable adapter artifact and provenance;
- supported package kinds and operations;
- phase-specific request ancestry;
- no forbidden mounts, egress or APIs;
- declared mutations and compensations;
- deterministic behavior for identical inputs where required;
- complete evidence translation;
- output and diagnostics bounds;
- timeout/crash behavior;
- cleanup and residue reporting;
- unsupported retention;
- absence of product-specific core changes.

An adapter cannot self-certify.

### 7.10 Implement reference adapters

Implement at minimum:

- **reference-correct:** consumes allowed generic evidence and produces supported, well-cited generic claims;
- **reference-limited:** honestly reports unsupported inputs and produces only the claims justified by supported evidence.

If stubs already exist, replace or extend them through the same external protocol used by any future subject. Do not special-case them inside core.

Reference adapters must be removable packages. Core must still build and pass its independent tests without loading them.

## 8. Mandatory Slice 5 adversarial fixtures

Add tests for at least:

- broken installer;
- unsupported package kind or operation;
- protocol/version mismatch;
- acquisition request containing plan/challenge/truth fields;
- post-plan request missing or mismatching the execution plan;
- judge canary in request, mount, environment, output prefill, diagnostics or egress;
- truth/selection/vault path access;
- symlink, hard-link, traversal and special-file escape;
- Docker socket or host-home access;
- hidden/undeclared mutation;
- missing compensation;
- compensation target mismatch;
- privilege request while OQ-001 is unresolved;
- excessive credential scope;
- credential handle replay/expiry/cross-run use;
- SSRF, DNS rebinding and redirect escape;
- timeout and process-tree termination;
- adapter crash before and after mutation receipt;
- oversized output or diagnostics;
- omitted, duplicate, unknown or rewritten evidence entry;
- lossy mapping without reason;
- unsupported input silently deleted;
- adapter execution after output freeze or reveal;
- cleanup residue;
- malicious adapter failure incorrectly classified as subject defect.

Run architecture-purity scans after adding every adapter fixture.

## 9. Slice 5 CLI and evidence

Expose only commands already authorized by the master prompt/design. Add or complete the journey commands necessary to invoke the adapter host through durable state.

Produce evidence for:

- certified correct reference adapter;
- certified limited reference adapter;
- one unsupported operation;
- one broken/malicious adapter refusal;
- one timeout/crash and successful resume or typed invalid terminal;
- translation-totality success and failure;
- output freeze followed by refusal of post-freeze execution;
- offline verification of the resulting valid or invalid terminal artifacts.

CLI responses must retain stable Lab-owned exit codes and must not introduce subject-specific exit semantics.

## 10. Required verification commands

Run the repository's actual scripts discovered during preflight. At minimum run the equivalents of:

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

Run offline public-bundle and invalid-record verification in fresh processes for new Slice 5 fixtures.

If Docker or network access is unavailable, do not weaken tests or claim container/network enforcement. Use deterministic fake transports/process boundaries, keep unavailable profiles disabled, and record the limitation.

## 11. Slice 5 exit gate

Slice 5 is complete only when:

- the lifecycle-transition review in §5 is resolved and verified;
- correct and limited reference adapters use the same public SDK/protocol and certification suite;
- core owns and enforces adapter process, mount, output, credential, mutation and timing boundaries that are actually supported;
- unsupported inputs remain in evidence and results;
- every canonical envelope entry receives exactly one translation disposition;
- malicious/broken adapter behavior produces typed adapter/Lab findings, not false subject defects;
- all unprivileged cleanup and compensation tests pass;
- privileged operations remain refused under OQ-001;
- post-freeze/reveal execution is impossible;
- removing or disabling all adapter packages leaves core/integrity/contracts/verifier tests green;
- the complete test suite passes on a clean workspace;
- the ledger, ADR/OQ status, runbook and evidence are updated;
- no Qualiber workspace was inspected or modified.

## 12. Stop and decision conditions

Stop the affected workstream and request a decision only if:

- preserving the successful package-verification early terminal requires a new normative terminal variant;
- the adapter host requires privilege broader than OQ-001 permits;
- a promised sandbox control cannot be enforced and removing the promise changes the approved threat model;
- a frozen contract requires a breaking change;
- user-owned unrelated changes prevent safe implementation.

Do not stop merely because Compose, held-out selection, threshold VRF, Qualiber, or a privilege broker is unavailable. Their fail-closed states are already defined.

## 13. Final handoff

When Slice 5 is complete, report:

1. lifecycle-transition resolution and its evidence;
2. contracts added/changed and compatibility impact;
3. adapter SDK/host/sandbox boundaries actually enforced;
4. certification results for correct and limited adapters;
5. adversarial tests and stable refusal codes;
6. test totals and exact commands;
7. new CLI/evidence fixtures and offline verification results;
8. architecture-purity/removability result;
9. remaining fail-closed features and open ADRs/OQs;
10. security limitations, especially process/container/egress enforcement;
11. confirmation that neither Qualiber workspace was inspected or modified;
12. readiness assessment for Slice 6.

Do not report Slice 5 complete if any exit-gate item is supported only by prose rather than executable evidence.
