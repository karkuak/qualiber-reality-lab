# Runbook — development key material and rotation

## What exists today

All key material in this repository is **development-only** and derived
deterministically from a public label:

- Ed25519 signing keys: `developmentKey(label)` in `@erl2/integrity`
- X25519 threshold custodians: `developmentCustodian(label)`

No private key bytes are committed. Any process can regenerate the identical
keypair from the label, which is exactly why these keys are unsuitable for any
held-out, blind or production use.

## Role separation

`SelectionRoleSeparationAuditV1` requires five disjoint roles — challenge
governor, selector, randomness source, reveal custodian and evaluator — with
disjoint operator identities and disjoint key ids. `assertDisjointRoles` refuses
any overlap with `NON_COLLUSION_ROLE_OVERLAP` or `NON_COLLUSION_KEY_OVERLAP`.

A solo operator using separate OS accounts and keychain ACLs must report this as
**process separation**, never personnel independence (design v2 §7).

## Rotation

1. Issue a new `trust-policy-manifest/v2` with `version` incremented and
   `prior_manifest_hash` set to the previous manifest's core hash.
2. Sign it with the trust root under `ERL-SIGN-V1`.
3. Update every verifier's locally pinned `currentTrustHeadHash`. Until they do,
   verification of new artifacts fails closed — which is the intended behaviour.
4. Retained artifacts are never re-signed. Historical verification continues
   under the trust verdicts recorded at signing time.

## Revocation

`revocations[]` supports three scopes, and `TrustEvaluator.evaluate` applies
them to the two verdicts independently:

| Scope | valid-when-signed | currently-trusted |
|---|---|---|
| `prospective` | false only at or after `effective_at` | false |
| `from_timestamp` | false only at or after `from_timestamp` | false |
| `all_historical` | false | false |

An `all_historical` revocation invalidates every past signature by that key.
Use it only for a proven key compromise.

## Before any production use

ERL2-OQ-007 must be resolved: a real external beacon must be qualified, its
registry entry pinned, and a custodian roster established with genuinely
independent operators. Until then `assertDevelopmentTierOnly` refuses any
held-out or blind selection.
