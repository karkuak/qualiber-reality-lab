# External Reality Lab V2 — False-Attestation Remediation Prompt

You are working on External Reality Lab V2 in:

`/Users/karthik/Developer/qualiber-reality-lab`

Your task is to close the remaining false-attestation paths identified by the independent Slice 6.5-B/C/D/E review. These defects can allow the Lab to sign a result that is inconsistent with the environment it actually operated on or with the strength of evidence it actually collected.

This is a focused integrity-remediation task. Audit and finish the existing work before adding new abstractions. Do not inspect, search, execute, or modify either Qualiber repository.

## 1. Objective

Close these findings end to end:

1. **P0-1 — substrate substitution**
   - `--substrate-root` must be development-only.
   - A run must bind permanently to one substrate identity at provisioning.
   - Every subsequent environment phase must verify that it is operating on that same substrate.
   - The substrate binding must be retained, signed, lifecycle-reachable, and independently checked offline.

2. **P1-8 — run/workspace identity substitution**
   - `--run` must match the durable run identity already recorded by `--run-root`.
   - The mismatch must be detected before leases, filesystem writes, retained evidence, substrate/reservation creation, or external dispatch.

3. **P1-12 — fail-open substrate loading**
   - Only `ENOENT` may mean “not provisioned.”
   - Permission, corruption, malformed content, wrong file type, and other I/O errors must fail closed with typed Lab-owned errors.

4. **P1-4 — false restoration**
   - Compensation evidence must identify the exact mutation it was expected to reverse.
   - Restoration must independently probe the substrate after compensation.
   - A successful-looking receipt must not pass if the expected mutation remains.
   - “Reverted nothing” must be distinguishable from “there was nothing to revert.”

5. **Operator-controlled claim-scope escalation**
   - `--claim-scope` must not let an operator convert development/fake/limited evidence into T2 or T3 evidence.
   - Claim scope must be derived from, or capped by, retained and independently verifiable run evidence.
   - The public verifier must reject an attestation whose claim scope exceeds the independently derived ceiling.

Each defect must have a regression test reproducing the original exploit or false claim, followed by proof that the remediated implementation refuses or safely caps it.

## 2. Expected repository state

The last observed repository state was:

- Branch: `slice-6.5b-environment-walk`
- Committed HEAD: `bd71a7f`
- ADR-ERL2-024 and its implementation existed as uncommitted work.
- The working tree contained extensive user-owned remediation changes.
- Relevant new or untracked files included:
  - `Independent-Code-Review-Slice-6.5B.md`
  - `docs/adr/ADR-ERL2-024.md`
  - `docs/ledger/remediation-6.5-invariants.md`
  - `packages/core/src/environment/substrateBinding.ts`
  - `packages/core/src/run/runIdentity.ts`
  - `packages/core/src/run/mutationIntent.ts`
  - `packages/public-verifier/src/library/environmentDerivation.ts`
  - new identity, substitution, cancellation, crash, and verifier tests
- `external-reality-lab-slice-6.5B-continuation-prompt.md` was a pre-existing user-owned modification.
- Typecheck had passed, but a complete final clean-checkout gate had not yet been established for the entire working tree.

This state may have changed. Verify it rather than assuming it.

Before editing:

1. Read `AGENTS.md` and other repository instructions, if present.
2. Run:
   - `git status --short --branch`
   - `git rev-parse HEAD`
   - `git log --oneline --decorate -10`
3. Record all pre-existing modified and untracked files.
4. Do not reset, clean, stash, discard, or overwrite existing work.
5. Do not switch branches, rebase, merge, commit, push, or create a PR unless explicitly instructed.
6. Inspect the current implementation before deciding what remains.
7. Treat a partially implemented fix as user-owned work to complete, not replace wholesale.

If HEAD, branch ancestry, or ADR status materially differs from the expected state, report the difference before making assumptions.

## 3. Normative material

Read these sources before implementation:

1. `/Users/karthik/Developer/qualiber-reality-lab/external-reality-lab-design-v2.md`
2. `/Users/karthik/Developer/qualiber-reality-lab/external-reality-lab-implementation-plan.md`
3. `/Users/karthik/Developer/qualiber-reality-lab/Independent-Code-Review-Slice-6.5B.md`
4. `/Users/karthik/Developer/qualiber-reality-lab/docs/adr/ADR-ERL2-024.md`
5. `/Users/karthik/Developer/qualiber-reality-lab/docs/ledger/remediation-6.5-invariants.md`, if present
6. `/Users/karthik/Developer/qualiber-reality-lab/docs/ledger/remediation-6.5B.md`
7. `/Users/karthik/Developer/qualiber-reality-lab/docs/claims/permitted-claims.md`
8. Relevant accepted ADRs, particularly:
   - ADR-ERL2-004
   - ADR-ERL2-015
   - ADR-ERL2-019
   - ADR-ERL2-020
   - ADR-ERL2-021
   - ADR-ERL2-022
   - ADR-ERL2-023
   - ADR-ERL2-024
9. Relevant contract schemas, registries, and generated types.
10. Current environment runner, workspace identity logic, substrate store, fake driver, CLI finalizers, and public verifier.

Use this authority order:

1. Accepted ADRs
2. Current V2 design
3. Implementation plan
4. Frozen contract schemas and identities
5. Requirements ledger
6. Independent review as defect evidence
7. Existing implementation and tests

Do not silently contradict an accepted ADR.

## 4. ADR requirement for claim scope

ADR-ERL2-024 was observed to say explicitly:

> `--claim-scope` remains operator-supplied and ungated … out of scope here and explicitly still open.

Therefore, do not silently implement claim-scope semantics as though ADR-024 had already decided them.

Before implementing the claim-scope correction:

1. Determine the next available ADR number.
2. Prefer a narrowly scoped new ADR unless repository convention supports an explicit accepted amendment.
3. Do not change ADR-024’s historical decision text to pretend claim scope was already covered.
4. Record the relationship between the new decision and ADR-024.
5. Update the ADR registry and requirements ledger according to repository convention.

Suggested ADR title:

> Evidence-Derived Claim-Scope Ceiling

The ADR must define:

- the ordering of claim scopes: T1 < T2 < T3;
- whether `claim_scope` is the exact earned scope or an operator-requested maximum;
- the evidence required to earn each level;
- how multiple evidence components combine;
- how metric-specific `claim_ceiling` values constrain the terminal ceiling;
- how missing, inapplicable, unsupported, or unevaluated evidence affects the ceiling;
- how development tier, fake driver, trusted reference subject, non-blind selection, and a non-evaluated domain plane constrain the ceiling;
- how held-out/blind assurance, real-environment qualification, repeated runs, robustness evidence, and regression evidence affect future ceilings;
- how the producer derives the scope;
- how the offline verifier independently derives the maximum allowed scope;
- what happens when an operator requests a scope above the ceiling;
- whether requesting a lower scope is allowed;
- typed refusal behavior;
- compatibility with frozen terminal schemas;
- why T4 remains impossible in base Lab attestations.

Conservative current-state requirement:

- A current Slice 6.5 development run using the fake environment driver, a trusted reference subject, non-blind selection, and `DomainResultNotApplicableV1` must not emit T2 or T3.
- Unless stronger criteria are already normatively defined and implemented, its maximum claim scope is T1.
- T3 must remain non-emittable until the repository has explicit, testable regression or historical-reproduction criteria.
- Do not invent higher-scope authority merely because the schema allows the string.

Preferred CLI behavior:

- With no `--claim-scope`, derive the earned scope.
- If `--claim-scope` is retained, treat it only as a requested upper bound.
- A request above the earned ceiling should fail explicitly rather than silently issuing an apparently stronger attestation.
- A lower requested bound may be allowed if the ADR explicitly defines it.
- The public verifier must accept a lower honest scope but reject a scope above its independently derived ceiling.

Do not modify a frozen terminal contract merely to add derivation metadata. Prefer deriving from already retained, closure-required evidence. If additional evidence is genuinely necessary, introduce an additive artifact or new major according to repository rules.

## 5. Required implementation

Implement only after auditing what ADR-024’s work already provides.

### 5.1 P0-1 — permanent substrate binding

The solution must ensure:

- `--substrate-root` and equivalent observation-channel redirects such as `--reservation-root` are development-only.
- The release surface refuses them with a typed error.
- A run binds to exactly one substrate during provisioning.
- The binding is established before any substrate-affecting dispatch.
- The binding identifies:
  - run ID;
  - substrate instance;
  - driver manifest;
  - driver identity;
  - archetype;
  - substrate lock or qualification identity where applicable;
  - reservation namespace where applicable.
- Deployment-local paths are not treated as public substrate identity.
- If a private operational locator is persisted, it must be stored in Lab-owned private state and cannot be replaced by later CLI input.
- Every later phase verifies both:
  - the retained binding;
  - the identity read back from the substrate itself.
- A fresh empty substrate has no matching identity and must be rejected.
- Finalization must not be able to redirect the final independent probe.
- The environment terminal closure must require exactly one substrate binding.
- The signer inventory must identify the authoritative Lab signer.
- The public verifier must verify:
  - signature;
  - role authorization;
  - run binding;
  - driver/archetype/lock binding;
  - lifecycle reachability;
  - consistency with all environment receipts.

Do not:

- sign only a caller-provided path;
- trust the directory name;
- bind the substrate only at finalization;
- let an untrusted driver attest its own authority;
- add optional fields to a frozen schema and treat omission as valid.

If ADR-024’s `ERL2-C-156` substrate-binding contract already implements this, audit and finish it rather than introducing a duplicate contract.

### 5.2 P1-8 — run/workspace identity

A workspace must have one durable run identity.

For existing workspaces:

1. Read the authoritative run ID from durable, hash-chained workspace evidence.
2. Cross-check any derived snapshot as a cache, not as authority.
3. Compare the durable ID with CLI `--run`.
4. Refuse on mismatch before:
   - lease acquisition or renewal;
   - directory creation;
   - reservation access;
   - substrate access;
   - retained evidence writes;
   - lifecycle writes;
   - adapter, subject, or driver dispatch.

For new-workspace bootstrap:

- define exactly when the first run identity becomes durable;
- prevent an attacker from reusing a root initialized for another run;
- handle empty, partial, and corrupt roots explicitly;
- do not infer identity from the root’s basename.

Enforce the invariant at both:

- the CLI/workspace-open boundary;
- the library boundary used by non-CLI callers.

Use a typed error such as `POLICY_RUN_IDENTITY_MISMATCH` if that is what ADR-024 specifies.

A mismatch refusal must be observationally side-effect free.

### 5.3 P1-12 — substrate-store error handling

Audit every substrate load/read path.

Required behavior:

- `ENOENT` for the expected state file may return “not provisioned.”
- All other errors must fail closed.
- Malformed JSON must fail closed.
- Schema-invalid substrate state must fail closed.
- Reading a directory instead of a file must fail closed.
- Permission errors must fail closed.
- Truncated or corrupt content must fail closed.
- Unknown version or state shape must fail closed.
- Errors must be mapped to typed Lab-owned error codes with safe diagnostics.
- Do not leak raw stack traces or sensitive absolute paths into public evidence.

Do not use:

```ts
catch {
  return undefined;
}
```

Use narrow error classification and preserve the cause internally where appropriate.

Audit callers for logic that still interprets an arbitrary read failure as an empty substrate.

### 5.4 P1-4 — compensation identity and independent restoration

Before compensation runs, durable intent must identify:

- run ID;
- substrate binding hash;
- operation ID;
- mutation IDs expected to be reverted;
- mutation target or resource identities;
- expected pre-compensation state;
- expected post-compensation condition;
- compensation operation or strategy;
- idempotency key;
- reconciliation probe.

Compensation evidence must identify:

- the compensation operation;
- the exact mutation or ordered mutation set it claims to reverse;
- the same run and substrate binding;
- target identity;
- status;
- observed result;
- reason on failure.

After compensation:

1. Re-inspect the substrate independently.
2. Compare the actual applied-mutation set with the durable intent.
3. Confirm every expected mutation disappeared.
4. Confirm unrelated mutation state was not falsely claimed as reverted.
5. Confirm restoration baseline and residue rules.
6. Freeze restoration verification only from the independently observed result.

A receipt reporting `succeeded` is insufficient if:

- the named mutation remains;
- the receipt names another mutation;
- the receipt names another substrate;
- the receipt names another run;
- the expected mutation set is incomplete;
- no compensation was required but the run falsely claims one occurred;
- the post-compensation probe failed or was unavailable.

The public verifier must independently rederive restoration from:

- durable and reached evidence included in terminal closure;
- before/after baselines;
- expected mutation identities;
- compensation receipts;
- post-compensation observations.

Do not trust `passed: true` or receipt status by itself.

If recording the expected mutation set requires a new retained contract, follow frozen-contract evolution rules. Do not mutate an existing frozen receipt in place.

### 5.5 Evidence-derived claim scope

Replace direct operator authority such as:

```ts
const claimScope = flags["claim-scope"] ?? "T1";
```

with a single core policy that derives the maximum earned scope from retained evidence.

The derivation must be used by:

- pre-environment finalization;
- environment finalization;
- any generic finalizer;
- the public offline verifier.

The derivation must consider all applicable evidence, including:

- terminal variant;
- tier: development, held-out, or blind;
- selection assurance;
- driver kind and qualification;
- fake versus real environment;
- subject trust classification;
- isolation qualification;
- evaluated versus not-applicable domain result;
- applicable metric claim ceilings;
- source completeness and unavailable or partial states;
- robustness and calibration evidence;
- repeated or regression evidence;
- any hard-safety cap;
- open fail-closed questions that prohibit stronger claims.

Use a monotonic minimum or ceiling rule:

- no component may raise another component’s ceiling;
- the final maximum is no stronger than the weakest applicable constraint;
- missing required evidence lowers or refuses; it never raises;
- `unsupported`, `not_applicable`, `unavailable`, zero-denominator, or unqualified states must follow explicit policy.

The public verifier must independently compute the ceiling and reject:

```text
attestation.claim_scope > independently_derived_ceiling
```

Do not rely solely on the producer’s selected scope.

A caller may never obtain T2 or T3 by:

- passing `--claim-scope T2` or `T3`;
- editing a CLI fixture;
- calling the library directly;
- mutating the attestation and recomputing only its internal hash;
- using the fake driver;
- using development tier;
- omitting domain evaluation;
- substituting a weaker signer inventory or qualification report.

## 6. Required regression tests

Each test must reproduce the original exploit or false statement, not merely test a helper.

### 6.1 Substrate substitution exploit

Drive a real CLI environment run through separate processes:

1. Provision and operate against substrate A.
2. Before restore, destroy, or finalize, provide a fresh empty substrate B.
3. Demonstrate that the pre-remediation path could produce a valid attestation over B.
4. Verify that the remediated path refuses before writing cleanup or terminal evidence.
5. Verify that substrate A still contains the actual resources.
6. Verify that no valid environment bundle is emitted.
7. Verify that B is not silently initialized as the run’s substrate.
8. Verify the refusal is typed.

Additional mutations:

- same path, different substrate instance marker;
- same substrate, wrong run binding;
- different driver;
- different archetype;
- different lock hash;
- different reservation namespace;
- missing binding;
- duplicate binding;
- invalid binding signature;
- signer with the wrong role;
- binding not lifecycle-reachable.

Each must fail for the intended reason.

### 6.2 Run identity exploit

1. Create run A and run B.
2. Invoke a command with `--run A` and `--run-root` belonging to B.
3. Verify refusal before any state change.
4. Byte-compare the run root before and after.
5. Confirm no:
   - lease write;
   - snapshot change;
   - event append;
   - retained artifact;
   - substrate directory;
   - reservation directory;
   - driver invocation.
6. Repeat using the direct library API.
7. Test malformed or partially initialized workspaces.
8. Test a snapshot whose run ID disagrees with the hash-chained first lifecycle event.
9. Test correct repeated opens across fresh processes.

### 6.3 Substrate error classification

Test separately:

- missing state file → “not provisioned”;
- malformed JSON → typed corruption error;
- schema-invalid JSON → typed corruption or state error;
- permission denied → typed I/O error;
- path is a directory → typed I/O error;
- truncated state → typed corruption error;
- unsupported version → typed state or version error;
- unrelated I/O error injected through a test seam → typed I/O error.

For every non-`ENOENT` case:

- teardown must not report zero residue;
- finalization must not emit a valid bundle;
- no “never provisioned” interpretation is permitted.

Avoid permission tests that silently pass when executed as an unusually privileged user. Use a deterministic test seam where necessary while still retaining at least one real filesystem case.

### 6.4 No-op and mismatched compensation

Start from a substrate containing a known applied mutation.

Test:

- receipt says succeeded but mutation remains;
- receipt names a different mutation;
- receipt names only one of multiple expected mutations;
- receipt names the wrong run;
- receipt names the wrong substrate binding;
- compensation removes an unrelated mutation but not the committed target;
- compensation probe fails;
- compensation receipt is missing;
- duplicated compensation receipt;
- stale compensation receipt replayed from another operation;
- compensation genuinely removes all expected mutations.

Expected outcomes:

- every false, no-op, or mismatched case fails restoration;
- applicable cases enter the authorized invalid or emergency path;
- no false valid attestation is emitted;
- the genuine compensation case succeeds;
- offline verification independently reaches the same conclusion.

At least one negative control must remove the independent post-compensation probe and cause a named test to fail.

### 6.5 Claim-scope escalation

Using a CLI-produced current Slice 6.5 development and fake run:

- no flag → derived T1;
- `--claim-scope T1` → accepted if lower or equal requests remain supported;
- `--claim-scope T2` → typed refusal or safely capped exactly as the ADR specifies;
- `--claim-scope T3` → typed refusal or safely capped;
- invalid or T4 value → typed refusal;
- direct library call requesting T3 → cannot emit T3;
- pre-environment terminal → cannot be operator-upgraded;
- environment terminal with `DomainResultNotApplicableV1` → cannot be operator-upgraded;
- fake driver → cannot emit real-environment robustness claims;
- development or non-blind selection → cannot emit a stronger assurance-derived claim.

Verifier mutations:

1. Start from a valid T1 bundle.
2. Create a fully self-consistent caller-supplied document whose attestation says T2 or T3.
3. Update hashes and signatures as required so the mutation reaches the semantic claim-ceiling rule rather than failing an earlier incidental check.
4. Verify the public verifier rejects it specifically because the claim exceeds the derived ceiling.

Also test:

- lower honest scope is accepted if allowed;
- missing evidence does not default upward;
- metric ceilings combine conservatively;
- one T1-limited applicable metric prevents a stronger terminal claim when policy says it should;
- inapplicable metrics follow the ADR’s explicit rule.

## 7. Negative controls

Add load-bearing negative controls for:

1. development gating of `--substrate-root`;
2. substrate binding check before later phases;
3. run/workspace identity cross-check;
4. narrow `ENOENT` handling;
5. compensation-to-mutation binding;
6. independent post-compensation probe;
7. producer claim-scope derivation;
8. verifier claim-scope rederivation.

Each negative control must make at least one specifically named test fail.

Run mutation campaigns only in a disposable clone or worktree. Never patch the live working tree.

The campaign must leave:

- the live tree byte-identical;
- no registered worktrees;
- no temporary directories;
- no modified generated files.

If a control kills no test, do not change the expectation to make it green. Strengthen the test or report the invariant as non-load-bearing.

## 8. Contract and compatibility rules

Before editing schemas:

1. Inventory every frozen contract touched.
2. Confirm whether ADR-024 already introduced the required additive substrate-binding contract.
3. Reuse it if correct.
4. Do not introduce a competing substrate identity contract.

Never:

- change a frozen schema in place;
- repurpose an existing field;
- add an optional field and claim older artifacts provided the invariant;
- rewrite historical retained bytes;
- make an untrusted driver the authority for Lab truth.

When a new contract is necessary:

- assign a new contract identity or major;
- add schema;
- generate types using repository tooling;
- add registry entry;
- declare signer ownership;
- update signer inventory;
- add closure role;
- add contract goldens;
- update verification;
- add compatibility tests.

Existing pre-environment V1 and readability behavior must remain intact where normatively required.

ADR-024 may intentionally make pre-ADR environment bundles unverifiable because they lack a substrate binding. Preserve that fail-closed decision if it is accepted.

## 9. Scope boundaries

In scope:

- P0-1;
- P1-8;
- P1-12;
- P1-4;
- operator-controlled claim-scope escalation;
- directly required contracts, closure, signer, and verifier work;
- regression and negative-control tests;
- documentation and ledger updates for these findings.

Out of scope unless necessary to keep the build correct:

- P1-1, P1-2, P1-3, P1-5, P1-6, P1-7, P1-9, P1-10, and P1-11 as independent work packages;
- evaluated-domain activation;
- Qualiber integration;
- Compose enablement;
- container launcher;
- opaque or third-party subject execution;
- held-out or blind enablement;
- threshold VRF;
- deep evaluation;
- customer T4 evidence.

Do not reopen OQ-005, OQ-007, or OQ-008.

Do not claim the whole independent review is remediated.

## 10. Verification

First establish the pre-edit baseline that is feasible without disturbing user work.

After implementation, run at minimum:

```bash
npm run clean
npm install
npm run build
npm run typecheck
npm run verify:generated
npm test
npm run purity
npm run evidence
npm run evidence:verify
```

Also run:

- substrate-substitution regression suite;
- run-identity regression suite;
- substrate error-classification suite;
- compensation and restoration adversarial suite;
- claim-scope escalation suite;
- public-verifier mutation suite;
- applicable negative controls;
- `git diff --check`;
- evidence non-destructiveness check;
- final working-tree audit.

Run the final clean gate from a disposable checkout containing the exact candidate source state if necessary. Do not clean the user’s live working tree.

If a test fails, diagnose the invariant. Do not weaken the assertion, skip the test, or update a golden without explaining the semantic reason for the change.

## 11. Completion conditions

This task is complete only when:

- `--substrate-root` and equivalent redirect flags are development-only.
- An established substrate binding cannot be replaced by CLI input.
- Every later phase proves it is using the bound substrate.
- A fresh empty substrate cannot produce a valid cleanup result for another substrate.
- `--run` mismatch refuses before any write, lease, or dispatch.
- Only `ENOENT` means “not provisioned.”
- Corrupt, unreadable, or malformed substrate state fails closed.
- Compensation intent identifies exactly what must be reverted.
- Successful-looking no-op compensation cannot pass.
- Post-compensation substrate state is independently probed.
- Offline verification independently reaches the same restoration result.
- Claim scope is evidence-derived or evidence-capped.
- A fake, development, or non-evaluated run cannot emit T2 or T3.
- The public verifier rejects an independently over-scoped attestation.
- All new invariants have load-bearing regression tests.
- All new invariants have load-bearing negative controls.
- No frozen contract changed in place.
- Full verification passes.
- User-owned changes remain preserved.
- Neither Qualiber repository was inspected or modified.

## 12. Required handoff

Return a detailed handoff with:

### 12.1 Baseline

- branch;
- starting commit;
- observed working-tree state;
- baseline test and typecheck status.

### 12.2 ADR decision

- ADR number;
- status;
- exact claim-scope policy;
- compatibility decision;
- rejected alternatives.

### 12.3 P0-1

- how substrate identity is established;
- where it is retained;
- signer role;
- how later phases resolve and verify it;
- original exploit result after remediation.

### 12.4 P1-8

- authoritative workspace identity;
- validation order;
- proof mismatch writes nothing.

### 12.5 P1-12

- exact `ENOENT` handling;
- typed error mapping;
- corruption and I/O cases tested.

### 12.6 P1-4

- durable expected-mutation evidence;
- compensation receipt binding;
- independent post-compensation probe;
- no-op exploit result.

### 12.7 Claim scope

- producer derivation;
- CLI semantics;
- current T1, T2, and T3 eligibility;
- verifier derivation;
- escalation mutation results.

### 12.8 Contract impact

- new identities or majors;
- registry and goldens;
- signer and closure changes;
- proof frozen contracts were not edited in place.

### 12.9 Tests

- pass, fail, and skip totals;
- each exploit regression;
- verifier mutations;
- negative-control kill results;
- clean-checkout gate.

### 12.10 Remaining findings

- explicitly list every independent-review finding still open;
- preserve OQ-005, OQ-007, and OQ-008 state;
- state the exact remaining claims ceiling.

### 12.11 Repository state

- final `git status --short`;
- files changed;
- confirmation that pre-existing user changes were preserved;
- confirmation that neither Qualiber checkout was accessed.

### 12.12 Verdict

- whether this false-attestation remediation is complete;
- whether the branch is ready for the next remediation package;
- do not call the branch merge-ready unless every remaining P0 and P1 merge blocker is separately closed.
