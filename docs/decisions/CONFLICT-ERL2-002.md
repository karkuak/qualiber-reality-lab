# CONFLICT-ERL2-002 — authorized signer roles for the V2 selection chain

**Status:** **resolved by [ADR-ERL2-020](../adr/ADR-ERL2-020.md)** (accepted 2026-07-27)
**Resolution:** C-1 → **option 1**, `confidential_selection_auditor`. C-2 →
report the distinct-key count alongside the role-separation verdict. C-3 →
`policy_author`, **provisional and unencoded** until the real producer proves it.
The sequencing correction was accepted: `erl2 select` moves into Slice 6.5-A.
This document is retained as the analysis of record; the decision lives in the ADR.
**Raised:** 2026-07-27, opening Slice 6.5-A (§8.5 selection verification)
**Normative source:** `external-reality-lab-design-v2.md` `2.0.0-draft.11` §8.5, §16.3;
ADR-ERL2-019 §2 (a retained signed contract with no declared role is refused);
Slice 6.5 brief §15.2 ("declare the exact permitted signer role for each signed
selection artifact… do not authorize a generic 'selection artifact' category").

## Why this is raised before any mapping is encoded

`SIGNED_MEMBER_RULES` in `packages/public-verifier/src/library/signedMembers.ts`
is the verifier's own authority table. Whatever role is written there *becomes*
the authorization rule for that contract, offline, for every consumer. Getting a
row wrong does not fail loudly — it silently authorizes the wrong signer for the
rest of the product's life. ADR-ERL2-019 §2 deliberately made retaining an
undeclared signed contract a refusal so that this table could never be filled in
by accident. Filling it in is therefore a decision, not an implementation detail.

## What was established (not assumed)

Every role the selection chain needs **already exists** in the frozen
`trust-policy-manifest/v2` `SignerRole` enum. **No frozen schema needs to change
and no new contract major is required.** The §15.2 contingency ("if existing
frozen trust contracts cannot express the required roles… use a new contract
major") is **not** triggered.

The mapping below was derived from the shipped producer, not from the fixture:
each `sealSigned(...)` call site in `packages/core/src/selection/chain.ts` and
`pool.ts`, cross-referenced with the role each key is granted in the development
trust policy (`tests/support/keys.ts:95-110`).

| Contract | Field | Producer key | Role granted | Domain |
|---|---|---|---|---|
| `selection-request/v2` | `signature` | challenge governor | `challenge_governor` | ERL2 |
| `selection-role-separation-audit/v1` | `signature` | challenge governor | `challenge_governor` | ERL2 |
| `journey-selection-policy/v1` | `signature` | **none — never constructed** | `policy_author` (provisional, C-3) | ERL2 |
| `external-beacon-randomness-policy/v1` | `signature` | policy author | `policy_author` | ERL2 |
| `eligibility-pool-manifest/v2` | `signature` | `governorKey` | `challenge_governor` | ERL2 |
| `eligibility-pool-entry/v2` | `signature` | `entrySignerKey` | `truth_custodian` | ERL2 |
| `external-beacon-randomness-receipt/v1` | `wrapper_signature` | `wrapperSigner` | `lab_verifier_association_signer` | `BEACON_ASSOCIATION` |
| `randomness-source-trust-verification-report/v1` | `signature` | `sourceTrustVerifier` | `confidential_selection_auditor` | ERL2 |
| `selection-commitment/v2` | `signature` | `selector` | `selector` | ERL2 |
| `selected-challenge-journey-binding/v1` | `signature` | `revealAuthority` | `reveal_service` | ERL2 |
| `selection-proof/v2` | `signature` | `selector` | `selector` | ERL2 |
| `selection-verification-receipt/v2` | `signature` | `verifier` | **see C-1** | ERL2 |
| `BeaconSignatureProofV1` | `signature` | beacon | `randomness_source` | `DEV-BEACON-ROUND-V1` |
| threshold reveal shares | share sigs | `custodianSigners` | `reveal_custodian` | `THRESHOLD_REVEAL` |

Nine rows are unambiguous: one producer key, one granted role, and the role name
matches the artifact's function. Three are not.

**Correction, 2026-07-27.** The first draft of this table assigned
`challenge_governor` to both policy rows by analogy with the selection request
and the role-separation audit. That was wrong. `external-beacon-randomness-policy/v1`
is signed by the **policy author** (`selectionFixture.ts:87-104`). The error was
caught while implementing, not in review — encoding it would have authorized the
challenge governor to author the randomness policy governing its own selection.
It is recorded here rather than quietly corrected because it is direct evidence
for why ADR-ERL2-019 §2's fail-closed refusal is worth its cost.

## C-1 — `selection-verification-receipt/v2` has no role that means "selection verifier"

`runSelectionChain` signs the receipt with `keys.verifier`
(`chain.ts:520-536`). The chain does not constrain what that key is; the
development fixture wires it to **`keyring.evaluator`**, whose only granted role
is `evaluator` (`selectionFixture.ts:258`, `keys.ts:104`).

Encoding `evaluator` in the verifier's role table would make the *evaluation*
authority the authority that attests the selection was correctly verified. That
conflates two roles the design separates everywhere else, and `verify.ts:511`
already lists `challenge_governor`, `selector`, `randomness_source`,
`reveal_custodian` and `evaluator` as the roles that must be held by **disjoint**
operators — so `evaluator` is a role the audit treats as separate from selection,
yet would become selection's final attestor.

The enum has no `selection_verifier`. The closest existing role with the right
meaning is **`confidential_selection_auditor`**, which already authorizes the
randomness-source trust report — the other independent-audit artifact in the
chain.

**Options.**

1. **Authorize `confidential_selection_auditor`** *(recommended)*. No contract
   change; the role's name and existing use both match "independent auditor of
   the selection". Cost: the development fixture must sign the receipt with the
   source-trust-verifier key instead of the evaluator key — **test support only,
   no frozen schema, no producer API change**.
2. **Authorize `evaluator`.** Zero code change, matches the fixture as written,
   and bakes the role conflation above into the offline verifier permanently.
   Not recommended.
3. **Add a `selection_verifier` role.** Requires a new `trust-policy-manifest`
   major and re-issuing every trust policy. Disproportionate: option 1 expresses
   the same separation with a frozen role that already exists.

## C-2 — the development keyring concentrates governor roles in one key

`keys.ts:100` grants **one** key both `challenge_governor` and
`environment_governor`. The environment branch will ask the same trust evaluator
to authorize both the challenge side (selection request, pool manifest) and the
environment side (driver manifest, archetype, substrate lock). Under the
development policy those are the same operator, so the role separation the audit
asserts is nominal, not real, for this pair.

This is a *development-tier* property, not a defect in the frozen contract — the
policy schema permits separate keys. It is recorded because §15.2 requires role
separation to be verified, and a green role-separation check against this keyring
must not be read as evidence that the two governor roles are independently held.

**Proposed disposition:** keep the concentration for the development tier, and
have the verifier's role-separation check report the *distinct key count* so the
weakened separation is visible in the receipt rather than implied to be strong.
No production tier is reachable (OQ-007 fail-closed).

## C-3 — `journey-selection-policy/v1` has no producer

The contract is signed per its schema, is referenced by `SelectionRequestV2`
(`journey_selection_policy_hash`) and by the eligibility pool, and is listed in
`deriveEnvironmentClosure`'s retained set — but **nothing anywhere constructs
one**. Every call site passes the placeholder `h("journey-selection-policy")`.

So there is no producer evidence from which to derive its authorized signer. Its
row is assigned by analogy to `external-beacon-randomness-policy/v1` — same
shape, same authorship — and marked **provisional**: it is *not* encoded into
`SIGNED_MEMBER_RULES`, so retaining one stays refused. The row must be
re-derived from the real producer when the challenge-preregistration path writes
one, which is inside Slice 6.5-A's revised scope.

This also means the selection request currently binds a **placeholder** journey
selection policy hash. A production `select` must bind a real admitted artifact,
or the binding is decorative.

## Blocking consequence for the Slice 6.5-A sequencing

Independent of C-1/C-2, §8.5 **cannot be gated first as the brief orders it.**

§15.1 requires the verifier to derive the selection artifacts "from lifecycle
events, selected commitments, environment run record, terminal closure". §15.5
requires "a valid environment selection subtree passes offline verification".

**No producer retains selection artifacts to an artifact root.** `runSelectionChain`
returns `SelectionChainEvidence` in memory; `packages/core/src/run/` and
`packages/cli/src/` contain no reference to any selection contract; `erl2 select`
is `POLICY_COMMAND_NOT_IMPLEMENTED`. `deriveEnvironmentClosure` already lists the
five selection roles as mandatory, so an environment closure would refuse today
for missing roles — correctly, but that proves nothing about §8.5.

So the §8.5 verifier has nothing to verify until the selection-freezing half of
Slice 6.5-B exists. The gate's *intent* — §8.5 wired and adversarially proven
before any environment terminal is activated, finalized or verified — is
preserved by pulling exactly that producer step forward into 6.5-A, rather than
by verifying a hand-built fixture and calling the gate passed. Verifying a
fixture the verifier's own test wrote would be the "fixture-built terminal
artifacts as completion evidence" the brief §14 forbids.

**Proposed 6.5-A scope, revised:**

1. Resolve C-1 (this document).
2. `erl2 select` — freeze the chain into `retained/` via the real `RunWorkspace`,
   under the run lease, emitting lifecycle events. Development tier only;
   `assertDevelopmentTierOnly` inside the chain (Independent-Code-Review.md:83).
3. Verifier-side derivation: assemble `SelectionChainEvidence` from
   closure-derived retained artifacts, never from a producer-supplied array.
4. Encode the role table above; keep every undeclared signed contract refused.
5. Invoke `verifySelectionChain`; use its returned entry, not producer fields.
6. The twenty §15.4 adversarial mutations, each failing offline.

Steps 3-6 are unchanged from the brief. Step 2 is the correction.

## Decision taken

**C-1 → option 1**, `confidential_selection_auditor`. Recorded in ADR-ERL2-020
§3, with C-2 (§4) and C-3 (§2a) riding along.

Nothing is encoded into `SIGNED_MEMBER_RULES` yet, by design: ADR-ERL2-020's
consequences require the table and the `verifySelectionChain` invocation to land
**atomically**. Encoding rows first would authorize a signed selection artifact
on its signature alone, without its chain position being verified — strictly
weaker than today's fail-closed refusal. The environment branch therefore stays
blocked exactly as intended until both land together.
