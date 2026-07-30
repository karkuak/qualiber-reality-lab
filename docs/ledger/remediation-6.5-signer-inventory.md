# Remediation ledger — Slice 6.5 signer-inventory completeness (Step 5B)

Companion to [ADR-ERL2-030](../adr/ADR-ERL2-030.md). Successor to
[`remediation-6.5-offline-verifier.md`](remediation-6.5-offline-verifier.md),
whose §4 characterized this defect and deliberately left it open.

## 1. What was open, and why it could not be closed from one side

The previous package measured signer-inventory completeness and stopped. Its
reasoning was that the verifier half alone would be *a rule that refuses the
shipped goldens* — because the goldens were themselves wrong — and that is not a
defect being caught, it is a fixture being contradicted.

That reasoning was right, and it is why this package touches three layers at once:

| layer | defect | file |
|---|---|---|
| producer | derives entries from `artifact.value["signature"]` literally, over the whole run root, keyed by core hash | `workspace.ts:2783` (before) |
| fixture | hand-writes a **one-entry** inventory and asserts completeness beside it | `tests/support/fakeRun.ts:722` (before) |
| verifier | derives nothing; `complete_for_terminal_chain` is `true as const` in both finalizers | `finalize.ts:171`, `environmentFinalize.ts:199` (before) |

## 2. The measurement, before and after

Every one of these asserted `complete_for_terminal_chain: true`.

| terminal | how built | retained signed | applicable | listed **before** | listed **after** |
|---|---|---|---|---|---|
| `valid-pre-environment-run` | fixture | 9 | 7 | **1** | **7** |
| `generic-finalization-failed-verification` | shipped CLI | 9 | 7 | **6** | **7** |
| `generic-finalization-unsupported-verification` | shipped CLI | 9 | 7 | **6** | **7** |
| environment terminal | shipped CLI | 66 | 63 | **61** | **63** |
| `invalid-run-*` (×3) | fixture | — | n/a | no inventory | no inventory |

**What the CLI omitted was exactly what the review said it would.** On every
branch, the mirrored trust policy — signed under `root_signature` — and, on the
environment branch, the beacon association wrapper — signed under
`wrapper_signature`. Two members, and the producer could not see either because
it read one field name.

**What the fixture omitted was different in kind**, and worse: six of seven, with
no mechanism that could ever have noticed. This is the fourth instance of the
class ADR-ERL2-028's handoff §6 names — *a test fixture that names a condition it
does not contain*.

### 2.1 A second fixture defect the completeness rule exposed

Requiring every inventoried member to be lifecycle-reached (ADR-ERL2-030 §3.4)
found that `fakeRun.ts` left **three** of its retained signed members produced by
no event — the preregistration verification receipt, the adapter manifest and the
generic run policy — where the shipped producer's `acquisition_preregistered`
event produces all three.

The tempting fix was to widen the reachability exemption. It was refused: the
fixture is now faithful to the producer instead. This is why the *invalid*
goldens moved too — three added `produced` entries change the preregistration
event hash, and every event downstream of it.

## 3. The producer (ADR-ERL2-030 §4)

`packages/core/src/terminal/signerInventoryDerivation.ts`. It enumerates every
**file** beneath `retained/` — not one representative per core hash, because a
signature is excluded from the core and two files can agree on every hashed byte
and disagree on their authority — and for each:

- resolves the authority field from the **frozen schema that declares it**
  (`signedSchemaAuthorityFields()`), refusing an artifact carrying an authority
  field its contract does not declare, or two of them;
- refuses a signed contract with no declared producer signer role;
- refuses a malformed signature envelope, and one whose `signed_hash` is not the
  artifact's own `core_hash`;
- applies the branch's acyclic boundary, recording each exclusion with its reason;
- refuses two retained files claiming one core hash;
- sorts by `core_hash`, so the inventory's bytes never depend on how the retained
  subtree happened to be named.

`completeForTerminalChain` is **returned from the resulting set**, and the schema
pins the field to `const: true` — so there is no weaker inventory to fall back to
and the builders refuse to seal one they cannot certify. The gate is enforced in
three places: each builder, `assertFinalizable`/`assertEnvironmentFinalizable`,
and `assertInventoryCoversDerivation` re-run **after** the freeze, so a signed
artifact appearing between derivation and freeze cannot ride in uncovered.

**Cryptographic authorization is deliberately not done here.** Whether a key may
hold a role is re-decided by the offline verifier under its own pinned policy;
sharing a trust evaluation would make the verifier's agreement partly the
producer's own.

## 4. The verifier (ADR-ERL2-030 §3, §5)

`packages/public-verifier/src/library/inventoryCompleteness.ts`. It derives the
expected set from the retained bytes, its **own** role table, the authority field
each frozen schema declares, the terminal variant and the acyclic boundary — and
compares bijectively. `complete_for_terminal_chain` is not read anywhere in the
file.

Seven distinct refusals, each reachable on its own:

| divergence | code |
|---|---|
| an applicable member with no entry | `INVENTORY_ENTRY_MISSING` |
| an entry that is not an applicable member | `INVENTORY_ENTRY_EXTRA` |
| two entries for one artifact core hash | `INVENTORY_ENTRY_EXTRA` |
| an entry whose schema, key or signature hash contradicts the artifact | `INVENTORY_ENTRY_MISMATCH` |
| an entry whose key is not granted the contract's role | `TRUST_KEY_NOT_AUTHORIZED_FOR_ROLE` |
| an inventory naming another run, or a member from another run | `GRAPH_CLOSURE_TERMINAL_MISMATCH` |
| a member the lifecycle never reached | `GRAPH_CLOSURE_UNREACHABLE_ARTIFACT` |

Three things it also does that were not there before: it supplies its **own**
excluded-type list from the variant it derived (rather than reading the
inventory's), it requires the inventory to name *this* run, and it cross-checks
each entry's `signature_sha256` — the one entry field `verifySignedMembers` never
looked at.

### 4.1 The reachability exemption, and why it is exactly two contracts

`trust-policy-manifest/v2` and `trusted-timestamp-checkpoint/v1` are declared
`externallyAnchored` in the verifier's own table, with reasons. Measured on a real
environment terminal, the three *selection* checkpoints **are** lifecycle-reached
and only the terminal one is not — so the exemption is per contract and cannot be
narrowed further without refusing the shipped terminal.
`tests/architecture/signerInventoryIndependence.test.ts` pins the exempt set by
name, so widening it is a visible edit rather than a quiet one.

## 5. Independence, and the third implementation

Producer, verifier and fixture derive the applicable set **three separate times**.
An architecture suite asserts that neither package imports the other's derivation,
that the fixture scanner imports neither, and that the two role tables
nonetheless agree schema for schema and role for role — because a divergence is a
real defect (the producer would inventory a member the verifier refuses, or omit
one it requires) and it should fail there rather than in a golden.

## 6. Contracts

**No frozen schema changed shape or meaning, and no new contract identity was
added.** `packages/contracts/` is untouched for the third package in a row — no
schema, no registry entry, no generated type, no new error code. Every refusal
reuses a catalogued one.

The existing contract already expresses the complete inventory: `entries` admits
4096 members and the shipped maxima are 7 and 63.

The completeness report stays **internal**; a frozen contract does not change
shape to carry a diagnostic.

## 7. Goldens and the byte pin

142 golden files moved; **no file was added or removed**, so the pin stays at
**787 pinned / 7 excluded** and the exclusion-manifest digest is unchanged. The
seven exclusions were not widened.

The dependency chain, so any of it can be attributed:

```
signed-member set → signer inventory → inventory core hash
  → final attestation → attestation core hash
  → public bundle (+ member descriptors) → terminal lifecycle event → golden tree
```

The invalid goldens moved for the separate reason in §2.1: three added `produced`
entries on the fixture's preregistration event.

## 8. Semantic mutations

`tests/adversarial/signerInventoryCompleteness.test.ts` (pre-environment) and
`…Environment.test.ts` (environment). Each case starts from a terminal the shipped
CLI produced, changes **one** semantic relationship, and then rebuilds the chain
the way a dishonest producer would have to — inventory, attestation, bundle,
bundle member descriptors, and the terminal lifecycle event — so the bundle is
internally self-consistent, every signature verifies and every declared digest
matches. The asserted code is therefore evidence: it cannot come from a broken
hash, an invalidated signature, a schema violation or a missing file.

`INV-HARNESS: re-sealing the chain unchanged still verifies` is the case that
makes the rest of the file mean anything. Without it every refusal below could be
an artefact of the re-signing.

Raw-tamper cases stay in `offlineVerifierMutations.test.ts`, deliberately
separate: a byte edit is refused by the derivation layer long before any inventory
rule runs.

## 9. Negative controls

19 new controls, bringing the campaign to **72**. Results in §10.

Two design notes worth carrying forward:

- **The producer controls substitute the field list rather than deleting the
  loop.** Removing a guard usually removes a type narrowing with it, and a patched
  tree that does not compile measures nothing — the trap that broke two controls
  in the 6.5-B campaign, one in the lifecycle-ordering campaign and one in the
  offline-verifier campaign. Substituting *which fields the producer looks in* is
  also the more faithful reproduction: the defect was never "no enumeration", it
  was "an enumeration over one field name".
- **`signer-verifier-trusts-producer-flag` restores the exact status quo
  ADR-ERL2-029 §9 rejected** by guarding the derivation on
  `complete_for_terminal_chain`. Because the field is `const: true`, that guard
  disables the derivation entirely — which is the point.

### 9.1 A rule that had to move to become load-bearing

`INV-INVALID` (an invalid record retaining a signer inventory) first failed with
`GRAPH_CLOSURE_EXTRA_ARTIFACT`: the closure already refuses the inventory as an
unaccounted extra, because `signer-inventory/v2` is not one of the invalid
branch's supporting schemas. The named rule was therefore dead code sitting behind
a rule that fired first.

It was moved **before** the closure derivation rather than deleted. A reader
deserves the actual cause — *an invalid terminal has no chain for an inventory to
be complete for* — and the invalid branch has no terminal variant from which to
derive an applicable set, so this is the only place the category error can be
named. The control now kills the case.

### 9.2 The inherited control the campaign proved was dead

`pre-dispatch-intent` came back **7 pass / 0 fail** against `expect: "fail"`. It
compiled, its patch applied, and it killed nothing.

The cause is the one the previous package hit one file over. The control
anchored on

```
this.advance(spec.operationId, "dispatching");
```

which occurs **twice** in `mutationIntent.ts`. ADR-ERL2-028 added the earlier
occurrence — the resume path, taken only when an existing intent already sits at
`declared` — so `String.replace` had been disabling *that* branch instead of the
first-dispatch path every operation takes. The rule the control claims to
measure, "no external mutation without a durable intent recorded first", had
been unmeasured from ADR-ERL2-028 onward.

Re-anchored on the two comment lines the guard owns, which occur once. Verified
by the anchor checker (exactly one match, at the first-dispatch advance) and
re-measured: **3 pass / 4 fail**, agreeing.

**It was not re-scored.** `npm run negative-control` refuses to call a control
satisfied by changing its expectation, and the failure was real.

This is the **third** recorded instance of a control expiring because a later
package edited the file above its anchor — `62158c3`'s three, then
`invalid-finding-lab-attribution`, now this. Two of the three were found by
running the *full* set; neither was found by the focused subsets that ran in
between. That is the argument for §10's discipline, stated as evidence rather
than as a preference.

## 10. Campaign results

Run against the committed candidate `723935f`, in the repository, with the
harness's own worktree. **72 of 72 controls scored**, the working tree byte-identical
afterwards, no registered worktree, no temp directory and no orphan process left.

| | total | patch applied | build ok | load-bearing | disagreed |
|---|---|---|---|---|---|
| inherited | 53 | 53 | 53 | 51 + 2 recorded `expect: "pass"` | **1** (§9.2) |
| new (this package) | 19 | 19 | 19 | **19** | 0 |

The two inherited `expect: "pass"` rows are the pre-existing, deliberately
recorded ones — `baseline-repeatability` (the fake driver is deterministic, so
two probes agree by construction) and `case-selected-comparisons` (the producer
builds pool entries from the admitted manifests). Neither is new and neither is
claimed as proof.

### 10.1 The nineteen new controls

| Control | Result | Expected |
|---|---|---|
| `signer-producer-ordinary-signature` | 5 pass / **12 fail** | fail ✔ |
| `signer-producer-root-signature` | 15 pass / **2 fail** | fail ✔ |
| `signer-producer-wrapper-signature` | 16 pass / **1 fail** | fail ✔ |
| `signer-producer-unknown-contract` | 16 pass / **1 fail** | fail ✔ |
| `signer-producer-completeness-derivation` | 16 pass / **1 fail** | fail ✔ |
| `signer-producer-finalization-gate` | 16 pass / **1 fail** | fail ✔ |
| `signer-producer-postfreeze-recheck` | 16 pass / **1 fail** | fail ✔ |
| `signer-fixture-complete-set` | 4 pass / **2 fail** | fail ✔ |
| `signer-verifier-trusts-producer-flag` | 10 pass / **12 fail** | fail ✔ |
| `signer-verifier-missing-direction` | 17 pass / **5 fail** | fail ✔ |
| `signer-verifier-extra-detection` | 20 pass / **2 fail** | fail ✔ |
| `signer-verifier-duplicate-detection` | 21 pass / **1 fail** | fail ✔ |
| `signer-verifier-lifecycle-reachability` | 21 pass / **1 fail** | fail ✔ |
| `signer-verifier-member-run-binding` | 21 pass / **1 fail** | fail ✔ |
| `signer-verifier-inventory-run-scope` | 21 pass / **1 fail** | fail ✔ |
| `signer-verifier-entry-signature-binding` | 21 pass / **1 fail** | fail ✔ |
| `signer-invalid-record-inventory` | 21 pass / **1 fail** | fail ✔ |
| `signer-verifier-wrapper-field` | **0 pass / 4 fail** | fail ✔ |
| `signer-verifier-environment-completeness` | 1 pass / **3 fail** | fail ✔ |

Three of these are worth reading twice.

**`signer-verifier-trusts-producer-flag` kills 12 of 22.** It restores the exact
status quo ADR-ERL2-029 §9 rejected by guarding the derivation on
`complete_for_terminal_chain` — and because the field is `const: true`, that
guard disables the derivation entirely. Twelve cases is the size of what was
unverified.

**`signer-verifier-wrapper-field` kills 4 of 4**, including the baseline.
Removing wrapper-signature recognition does not hide the member; it makes the
honest environment inventory look like it lists something inapplicable. That is
the review's original finding, measured from the other side.

**The eight one-kill controls are the point of splitting them.** Each disables a
single rule and kills exactly the case written for that rule, so a reader can
tell which refusal is doing the work rather than being told the composition
refuses. That is the lesson `cutoff-milestone-resolution` taught in the previous
package, applied in advance.

### 10.2 Inherited results, in full

All 53 re-run against `723935f`. Load-bearing unless noted:

`activate-connect-guard` 10/1 · `freeze-output-outstanding-step-guard` 10/1 ·
`step-order-guard` 11/1 · `durable-substrate` 5/18 · `restore-receipt-status` 4/4 ·
`emergency-route` 5/3 · `subject-output-canary-scan` 11/1 ·
`environment-bundle-verifier` 10/7 · `baseline-repeatability` 12/0 *(expect pass)* ·
`case-selected-comparisons` 21/0 *(expect pass)* · `run-identity-validation` 4/7 ·
`substrate-binding-validation` 9/3 · `substrate-locator-conflict` 10/2 ·
**`pre-dispatch-intent` 7/0 → repaired → 3/4** · `intent-reconciliation` 5/2 ·
`frontier-action-derivation` 13/1 · `safe-action-completeness` 10/4 ·
`per-action-emergency-cleanup` 13/1 · `verifier-validity-derivation` 12/1 ·
`verifier-restoration-derivation` 12/1 · `verifier-teardown-derivation` 12/1 ·
`branch-specific-cancellation` 3/6 · `cancellation-cleanup-applicability` 12/1 ·
`locator-flag-development-gate` 11/1 · `narrow-enoent-substrate-read` 8/3 ·
`substrate-state-shape-validation` 10/1 · `compensation-mutation-binding` 3/5 ·
`independent-restoration-probe` 5/3 · `producer-claim-scope-derivation` 7/1 ·
`verifier-claim-scope-rederivation` 4/4 · `unconditional-bounded-destroy` 10/10 ·
`cleanup-residue-probe` 32/2 · `undeclared-destruction-detection` 19/2 ·
`actions-agree-with-residue` 19/1 · `invalid-finding-phase-gate` 36/5 ·
`invalid-finding-lab-attribution` 18/2 · `foreign-resource-classification` 36/5 ·
`journey-prerequisite-matrix` 23/1 · `post-capture-activation-requirement` 7/3 ·
`prerequisite-evidence-derivation` 19/3 · `refusal-before-cutoff-freeze` 5/7 ·
`lazy-operational-directories` 11/1 · `cancellation-branch-classification` 10/2 ·
`cleanup-continuation` 11/1 · `not-dispatched-proven` 19/1 ·
`crash-lease-reclamation` 9/18 · `invocation-count-not-dedup` 11/9 ·
`cutoff-milestone-resolution` 17/1 · `cutoff-bounds-derivation` 17/1 ·
`cutoff-clock-divergence` 17/1 · `cutoff-lifecycle-reachability` 17/1 ·
`payload-presence-accounting` 7/1 · `payload-directory-enumeration` 5/3.

**`invalid-finding-lab-attribution` is load-bearing again at 18/2**, so the
previous package's repair held — which is the only way to know it did.

### 10.3 Residue

`the working tree is byte-identical to how the campaign started`. Afterwards:
`git worktree list` shows only the repository; no `erl2-negative-control-*` temp
directory remains; no `node --test` or harness process survives; `git status
--short` is empty and `git diff --check` is clean.

## 11. What this package does not claim

- **Payload contents are still not scanned.** Secret canaries and forbidden
  identifiers on the environment subject-output surface remain unscanned, and the
  declared output-size ceiling remains unenforced. Producer-side, Step 6.
- **The cutoff's residual is unchanged** — a signed window commitment, producer
  side (ADR-ERL2-029 §9).
- **`mounted_file` scanning and the `lab_telemetry` negative control** are
  untouched.
- **The claims ceiling is unchanged: T1.** This package adds verifier refusals and
  corrects producer output. It measures no new environment, no new subject and no
  new robustness.
