# ADR-ERL2-020 — authorized signer roles for the V2 selection chain, and the §8.5 gate ordering

**Status:** accepted
**Date:** 2026-07-27
**Deciders:** Lab Core Owner, Integrity/Security Owner, Verifier Reviewer
**Supersedes:** nothing. Extends ADR-ERL2-019 §2, which made a retained signed
contract with no declared signer role a refusal precisely so that this table
could not be filled in by accident.
**Analysis:** [CONFLICT-ERL2-002](../decisions/CONFLICT-ERL2-002.md)
**Normative source:** `external-reality-lab-design-v2.md` `2.0.0-draft.11` §8.5,
§16.3; Slice 6.5 brief §15.1-§15.5.

## Context

Slice 6.5-A wires §8.5 offline selection verification. Two things had to be
settled before any code changed.

First, `SIGNED_MEMBER_RULES` is the verifier's own authority table: whatever role
is written there *becomes* the offline authorization rule for that contract, and
a wrong row authorizes the wrong signer silently and permanently.

Second, the brief orders §8.5 as the first implementation task and a hard gate
before any environment terminal is activated, finalized or verified — but §15.1
requires deriving selection artifacts from a *terminal closure*, and no producer
retains selection artifacts to an artifact root. `runSelectionChain` returns
evidence in memory; `packages/core/src/run/` and `packages/cli/src/` reference no
selection contract; `erl2 select` refuses with `POLICY_COMMAND_NOT_IMPLEMENTED`.

## Decision

### 1. No frozen schema changes

Every role the chain needs already exists in the frozen `trust-policy-manifest/v2`
`SignerRole` enum. The §15.2 contingency ("use a new contract major where
required") is **not** triggered. No trust policy is re-issued.

### 2. The exact signer role for each signed selection artifact

Derived from each `sealSigned(...)` call site in the shipped producer
(`selection/chain.ts`, `selection/pool.ts`), not from a fixture:

| Contract | Field | Required role | Domain |
|---|---|---|---|
| `selection-request/v2` | `signature` | `challenge_governor` | ERL2 |
| `selection-role-separation-audit/v1` | `signature` | `challenge_governor` | ERL2 |
| `journey-selection-policy/v1` | `signature` | `policy_author` (see §2a) | ERL2 |
| `external-beacon-randomness-policy/v1` | `signature` | `policy_author` | ERL2 |
| `eligibility-pool-manifest/v2` | `signature` | `challenge_governor` | ERL2 |
| `eligibility-pool-entry/v2` | `signature` | `truth_custodian` | ERL2 |
| `external-beacon-randomness-receipt/v1` | `wrapper_signature` | `lab_verifier_association_signer` | `BEACON_ASSOCIATION` |
| `randomness-source-trust-verification-report/v1` | `signature` | `confidential_selection_auditor` | ERL2 |
| `selection-commitment/v2` | `signature` | `selector` | ERL2 |
| `selected-challenge-journey-binding/v1` | `signature` | `reveal_service` | ERL2 |
| `selection-proof/v2` | `signature` | `selector` | ERL2 |
| `selection-verification-receipt/v2` | `signature` | **`confidential_selection_auditor`** | ERL2 |
| `BeaconSignatureProofV1` | `signature` | `randomness_source` | `DEV-BEACON-ROUND-V1` |
| threshold reveal shares | share signatures | `reveal_custodian` | `THRESHOLD_REVEAL` |

There is no generic "selection artifact" authorization. A signed selection
contract absent from this table stays refused, exactly as ADR-ERL2-019 §2 leaves
every other undeclared signed contract refused.

### 2a. Two policy rows are `policy_author`, and one has no producer at all

A first draft of this table assigned `challenge_governor` to both policy rows by
analogy with the request and the audit. That was wrong, and it was caught while
implementing rather than by review — which is the reason the fail-closed gate
exists at all.

`external-beacon-randomness-policy/v1` is signed by the **policy author**
(`selectionFixture.ts:87-104`, `keyring.policyAuthor` → `policy_author`), the
same role that already signs `acquisition-source-manifest/v1` and
`generic-run-policy/v1`. A randomness *policy* is a policy document, so
`policy_author` is both the observed signer and the coherent one. Encoding
`challenge_governor` would have authorized the challenge governor to author the
randomness policy that governs its own selection — a role collapse in the
direction the chain is specifically designed to prevent.

`journey-selection-policy/v1` has **no producer anywhere**: every call site passes
a bare placeholder hash (`h("journey-selection-policy")`), and the artifact is
never constructed. Its row is therefore assigned by analogy to
`external-beacon-randomness-policy/v1` — same shape, same authorship — and is
explicitly **provisional**. It must be re-derived from the real producer when one
is written, before any run retains one. Until then, retaining a
`journey-selection-policy/v1` is refused like any other undeclared contract,
because a provisional row is not encoded.

### 3. `selection-verification-receipt/v2` is authorized to `confidential_selection_auditor`, not `evaluator`

The development fixture signed the receipt with the `evaluator` key. Encoding
that would make the evaluation authority the attestor that selection was
correctly verified — conflating two roles `selection/verify.ts:511` already
requires to be held by *disjoint* operators.

`confidential_selection_auditor` is the frozen role whose meaning matches, and it
already authorizes the randomness-source trust report — the chain's other
independent-audit artifact. `tests/support/selectionFixture.ts` is changed to
sign the receipt with the source-trust-verifier key. That is **test support
only**: no frozen schema, no producer API, and no retained golden byte changes,
because no shipped run retains a selection chain yet.

### 4. Development-tier role concentration is reported, not assumed away

The development trust policy grants one key both `challenge_governor` and
`environment_governor`. The role-separation check therefore reports the number of
**distinct signing keys** alongside its verdict, so a green separation result
against this keyring cannot be read as evidence that the two governor roles are
independently held. No production tier is reachable (ERL2-OQ-007 fail-closed).

### 5. §8.5 is gated before environment activation, and `erl2 select` moves into 6.5-A

The gate's ordering intent is kept; its literal ordering cannot be. The minimum
producer step — freezing the selection chain into `retained/` through the real
`RunWorkspace`, under the run lease, emitting lifecycle events — moves from
6.5-B into 6.5-A, so §8.5 is proven against a **real retained subtree produced by
the shipped CLI** rather than a hand-built fixture.

Verifying a fixture the verifier's own test wrote would be the "fixture-built
terminal artifacts as completion evidence" the brief §14 forbids, and would make
the gate a statement about the test harness rather than about the product.

### 6. Selection advances one durable stage at a time; it is never replayed after the fact

A draft plan called `runSelectionChain` once, froze its ten returned artifacts,
then appended the thirteen lifecycle transitions afterwards. **Rejected.**

That ordering makes the lifecycle decorative: the events would describe a
sequence that had already completed in memory, so a crash anywhere inside the
chain leaves a run with no durable evidence of how far it got. Recovery would
have only two options, both wrong — discard and re-run the chain (drawing a
**second beacon round**, violating "exactly one randomness observation" and the
pool's single-draw rule), or accept partial in-memory state it cannot verify.
ADR-ERL2-018's run-transaction model exists precisely to make that impossible.

`select` therefore advances **one stage at a time**, each stage being: validate
the current state → produce exactly that stage's artifact(s) → freeze → append
its lifecycle transition. The durable order is:

```
pool → pool checkpoint → randomness → source trust → commitment
     → commitment checkpoint → reveal → binding → binding checkpoint → proof
```

Consequences that are enforced, not documented:

- **Resume reads retained evidence, never memory.** Re-invoking `select` on a
  partially advanced run continues from the retained artifacts and the lifecycle
  head. A completed stage is never redone.
- **The beacon is observed exactly once per run, across crashes.** Once the
  randomness stage is durable, resume binds the retained receipt; it never
  requests a round. The pool's existing single-draw refusal is the second gate,
  not the only one.
- **The reveal is never repeated.** Same rule: once the threshold reveal receipt
  is retained, resume binds it.
- **Crash injection at every stage boundary** is part of the exit gate, not a
  follow-up — including between "beacon observed" and "receipt frozen", the one
  window where a second draw would otherwise be reachable.

`runSelectionChain` is decomposed into per-stage functions. The monolithic entry
point is kept for the existing in-memory KAT and adversarial suites, implemented
as a fold over the same stage functions, so the producer used in tests and the
producer used by the CLI cannot diverge.

### 7. The auditor's receipt is independently derived, not self-issued

`runSelectionChain` currently signs `SelectionVerificationReceiptV2` from the
same in-memory values it just produced. A receipt that attests only "I agree with
what I just computed" carries no independent evidence, whichever key signs it —
so §3's role choice would be cosmetic on its own.

The confidential selection auditor therefore **re-derives the chain from the
retained artifacts** — pool root, source/request binding, derived index,
rejection count — and signs only if its own derivation matches. The offline
public verifier re-derives a third time in Slice 6.5-A steps 2-6. Three
independent derivations, one shared formula: this does not close the
common-formula risk at `Independent-Code-Review.md:87` (a spec-vs-impl error
computes the same wrong value in all three), which stays open and is why the
known-answer vectors remain load-bearing.

## Consequences

- The environment branch stays blocked until the table above is encoded *and*
  `verifySelectionChain` is invoked on a verifier-derived `SelectionChainEvidence`.
  Encoding the table alone would weaken ADR-ERL2-019 §2's fail-closed posture, so
  the two land together or not at all.
- A future signed selection contract must add a row here before it can be
  retained — the deliberate speed bump is preserved, not spent.
- `erl2 select` becomes reachable on the release surface at `development` tier
  only. `assertDevelopmentTierOnly` is **already inside both kernels** —
  `selection/chain.ts:129` and `selection/verify.ts:125`, closed by 6R-C (review
  P2-7). A draft of this ADR said it "moves inside the chain", quoting
  `Independent-Code-Review.md:83`; that finding is **pre-6R and stale**. The
  guard is preserved as-is and must not be reimplemented.

  What is genuinely missing is *coverage through the kernels*:
  `selectionChain.test.ts:194` calls `assertDevelopmentTierOnly` directly, so no
  test drives a `held_out` or `blind` tier through `runSelectionChain` or
  `verifySelectionChain`. Slice 6.5-A adds that, so the guard is proven at the
  boundary a caller actually crosses.
- ERL2-OQ-007 remains fail-closed; held-out and blind tiers stay refused.

## Evidence

To be recorded when 6.5-A lands:

- A fresh-process CLI run reaching `case_selected` with **no placeholder hashes**
  — every `SelectionRequestV2` binding resolved from the run's own retained role
  hashes.
- Crash injection at **every** selection stage boundary, each resuming from
  retained evidence, with an asserted **beacon invocation count of exactly one**
  across the whole crash/recovery matrix, and no repeated reveal.
- Replay of a completed `select` is byte-idempotent; a refused `select` writes
  zero retained evidence.
- `held_out` and `blind` tiers refused **through** `runSelectionChain` and
  `verifySelectionChain`, not only by calling the guard directly.
- Wrong-role refusals, specifically a governor-signed
  `external-beacon-randomness-policy/v1` and a governor-signed
  `journey-selection-policy/v1` — the two rows §2a corrects.
- The auditor's receipt refused when its independent re-derivation disagrees with
  the producer's.
- Then, in steps 2-6: the twenty §15.4 adversarial mutations failing offline; a
  valid environment selection subtree verifying offline; and the pre-environment
  verifier still forbidding selection artifacts.
