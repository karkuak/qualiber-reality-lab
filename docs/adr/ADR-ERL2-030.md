# ADR-ERL2-030 — signer-inventory completeness: the exact applicable-member set, derived twice and compared bijectively

- **Status:** accepted
- **Date:** 2026-07-30
- **Deciders:** Lab Architecture, Verification Audit, Evidence/Clock Authority
- **Supersedes:** nothing
- **Amends by record:** [ADR-ERL2-029](ADR-ERL2-029.md) §4.1 — its three-condition
  definition of an *applicable signed member* omits the inventory's own schema,
  which has no fixpoint. §3.2 below records the omission and closes it.
- **Builds on:** [ADR-ERL2-012](ADR-ERL2-012.md), [ADR-ERL2-019](ADR-ERL2-019.md),
  [ADR-ERL2-020](ADR-ERL2-020.md), [ADR-ERL2-021](ADR-ERL2-021.md),
  [ADR-ERL2-024](ADR-ERL2-024.md), [ADR-ERL2-026](ADR-ERL2-026.md),
  [ADR-ERL2-027](ADR-ERL2-027.md), [ADR-ERL2-028](ADR-ERL2-028.md),
  [ADR-ERL2-029](ADR-ERL2-029.md)
- **Findings closed:** the review's P2 signer-inventory finding
  (`complete_for_terminal_chain: true` while omitting signed members whose
  authority field is not literally named `signature`), in all three layers the
  ADR-ERL2-029 measurement found it in
- **Normative revision:** `2.0.0-draft.12`

---

## 1. Context

ADR-ERL2-029 §4 decided that signer-inventory completeness would be derived in
both directions, and then deliberately did not implement it — because measuring
it found the defect was three defects in three layers, and the verifier half
alone would have been a rule that refuses the shipped goldens rather than a
defect being caught (`remediation-6.5-offline-verifier.md` §4).

This ADR is the decision that closes it. It exists rather than being folded into
ADR-ERL2-029 for one reason, in §3.2: ADR-ERL2-029 §4.1's definition of the
applicable set is **not satisfiable as written**, and discovering that is a
normative question, not an implementation detail.

### 1.1 What was measured

Three terminals, each asserting `complete_for_terminal_chain: true`:

| terminal | how built | retained signed | applicable | listed |
|---|---|---|---|---|
| `valid-pre-environment-run` | fixture (`fakeRun.ts`) | 9 | 7 | **1** |
| `generic-finalization-*` | shipped CLI | 9 | 7 | **6** |
| environment terminal | shipped CLI | 66 | 63 | **61** |

The CLI omissions are exactly the members whose authority field is not named
`signature`: the mirrored trust policy (`root_signature`, every run) and the
beacon association wrapper (`wrapper_signature`, environment branch). The fixture
omission is different in kind — it hand-wrote one entry and asserted completeness
beside it, which is the fourth instance of the recurring class ADR-ERL2-028's
handoff §6 names: *a test fixture that names a condition it does not contain.*

### 1.2 Why `complete_for_terminal_chain` proved nothing

The producer wrote `complete_for_terminal_chain: true as const` in both
finalizers, and the schema pins the field to `const: true`. So the inventory's
central property — the one a reader consults it for — was a schema constant. This
is `lab_validity` again (ADR-ERL2-024 §1) and ADR-ERL2-029 §1.1 said so.
`verifySignedMembers` checked that every *entry* named a retained artifact whose
schema and key matched; nothing checked that every applicable retained artifact
had an entry.

---

## 2. Scope and non-goals

### In scope

- The exact applicable-member set, for both valid terminal variants.
- Producer-side derivation of that set, and refusal to seal an inventory it
  cannot certify.
- Verifier-side **independent** derivation and bijective comparison.
- Fixture and golden correction, and the byte-pin consequences.

### Explicit non-goals

- **The producer-side scanning cluster.** `mounted_file` scanned with metadata
  that cannot contain the mount, secret canaries and forbidden identifiers
  unscanned on the environment subject-output surface, and the declared
  subject-output size ceiling hashed but unenforced. All three are named open in
  ADR-ERL2-029 §2 and stay open.
- **The signed cutoff-window commitment** (ADR-ERL2-029 §9). Unchanged.
- **New evidence classes, live oracle surfaces, evaluated-domain activation.**
  ERL2-OQ-005, ERL2-OQ-007 and ERL2-OQ-008 stay fail-closed.
- **Any claims-ceiling movement.** This package adds refusals and corrects
  producer output. It measures no new environment, subject or robustness, so the
  ceiling stays **T1**.

---

## 3. Decision: the applicable-member set

### 3.1 The definition

**A retained *file* is an applicable signed member of a terminal chain when all
four hold:**

1. it carries an **authority-bearing signature** — a `signature`,
   `root_signature` or `wrapper_signature` object with a `key_id` and a
   `signed_hash` — in a field its **registered contract legally declares**
   (`signedSchemaAuthorityFields()`, derived from the frozen schema bundles).
   Membership is decided by the contract, never by a property name that happens
   to contain "signature";
2. its `schema_version` is declared in the deriving party's own signer-role table
   (the verifier's `SIGNED_MEMBER_RULES`, the producer's
   `PRODUCER_SIGNED_MEMBER_ROLES`). An undeclared signed contract is a **hard
   refusal** on both sides, never a silent omission;
3. its `schema_version` is not one of the variant's
   `excluded_public_terminal_types`;
4. its `schema_version` is not `signer-inventory/v2`.

The enumeration is over **files**, not over one representative per core hash: a
signature field is excluded from `core_hash` by design, so two retained files can
agree on every hashed byte and disagree on their authority. Two retained files
claiming one core hash is itself a refusal.

### 3.2 Why condition 4 is here rather than in ADR-ERL2-029 §4.1

ADR-ERL2-029 §4.1 gives conditions 1–3 and stops. Taken literally, the retained
`signer-inventory/v2` is an applicable signed member of itself, and the inventory
must contain an entry for it.

**That set has no fixpoint.** An entry names an artifact by `core_hash`, so adding
an entry for the inventory changes the very hash the entry names. The producer had
always excluded it — `workspace.ts` said so in a comment, *"an inventory vouching
for itself vouches for nothing"* — but the ADR that defines the applicable set did
not, and an implementation that silently disagreed with the accepted definition is
exactly the shape of defect these packages exist to remove.

So it is recorded here, as an amendment by record, rather than resolved in code.

### 3.3 The acyclic boundary, per variant

| variant | excluded, and why |
|---|---|
| `pre_environment` | `pre-environment-final-lab-attestation/v1` — sealed **after** the inventory and binds its hash, so an inventory covering it could not exist |
| `environment` | the same attestation, plus `selection-verification-receipt/v2` — a mandatory public bundle member the reader holds independently |
| both | `signer-inventory/v2` — §3.2 |

The public bundle is absent from the table because it carries **no signature at
all**: it is a container of already-signed members, bound by hash. It is not an
applicable signed member under any variant, and it does not need an exclusion to
say so.

Both exclusion lists are pinned by the frozen schema as fixed tuples per variant
(`prefixItems` + `items: false`). The **verifier therefore supplies its own list
from the variant it independently derived**, and requires the retained one to
equal it. Reading the inventory's own list as the boundary would let a producer
widen its exclusions and call the result complete.

### 3.4 Lifecycle reachability, and the two contracts exempt from it

Every applicable member must be **lifecycle-reached** — named by some event's
`produced` — and must be **run-bound**: a contract carrying a run id (top-level
`run_id`, or `context.run_id` for a timestamp checkpoint) must carry *this* run's.
A retained signed artifact no event ever produced is the snapshot-only shape the
closure refuses everywhere else, and ADR-ERL2-029 §6 already applied that argument
to the exposure event.

Two contracts genuinely cannot satisfy reachability, and both are declared exempt
**by name, per contract, in the verifier's own table**:

- `trust-policy-manifest/v2` — the trust root predates the run and is mirrored in
  at preregistration, never *produced* by it. It is authorized against the
  verifier's own locally pinned head, which is a stronger binding than
  reachability, and it is not run-scoped at all.
- `trusted-timestamp-checkpoint/v1` — the **terminal** checkpoint anchors the run
  record during finalization, after the last event that could have produced it.
  The attestation's `timestamp_checkpoint_hash` and the bundle's checkpoint chain
  bind it instead.

The exemption is per **contract**, not per artifact, and it is narrow rather than
convenient: measured on a real environment terminal, the three *selection*
checkpoints are lifecycle-reached and only the terminal one is not, so the
exemption cannot be narrowed further without refusing the shipped terminal.
`tests/architecture/signerInventoryIndependence.test.ts` pins the exempt set to
exactly these two by name, so widening it is a visible edit.

**This obliged a fixture correction rather than a wider exemption.** `fakeRun.ts`
left three of its retained signed members — the preregistration verification
receipt, the adapter manifest and the generic run policy — produced by no event,
where the shipped producer's `acquisition_preregistered` event produces all
three. The fixture is now faithful to the producer; the exemption was not widened
to accommodate it.

### 3.5 Invalid terminals

**A signer inventory attests a terminal chain, and an invalid record has none** —
no attestation, no public bundle. Retaining one is therefore a category error
rather than a harmless extra, and `verify-record` refuses it
(`INVENTORY_ENTRY_EXTRA`). Without this rule the inventory would be the one signed
member no completeness derivation covers, because the invalid branch has no
variant from which to derive an applicable set.

No inventory is invented for an invalid record. The design excludes it and this
ADR does not change that.

---

## 4. Decision: the producer derives completeness

`RunWorkspace.signerInventoryEntries` read `artifact.value["signature"]`
literally, over the **whole run root**, keyed by core hash. It is replaced by
`packages/core/src/terminal/signerInventoryDerivation.ts`, which:

1. enumerates every **file** beneath `retained/`;
2. resolves each artifact's authority field from the frozen schema that declares
   it, refusing an artifact that carries an authority field its contract does not
   declare, or two of them;
3. refuses a signed contract with no declared producer signer role;
4. refuses a malformed signature envelope, and one whose `signed_hash` is not the
   artifact's own `core_hash`;
5. applies the §3.3 boundary, recording each exclusion with its reason;
6. refuses two retained files claiming one core hash;
7. sorts by `core_hash`, so the inventory's bytes never depend on how the retained
   subtree happened to be named;
8. returns `completeForTerminalChain` **derived from the resulting set**.

### 4.1 What the producer deliberately does not do

**Cryptographic authorization.** The producer proves the set is complete and that
each signature binds the artifact it sits on. Whether a key may hold a role is
re-decided by the offline verifier under its own pinned trust policy. Sharing a
trust evaluation would make the verifier's agreement partly the producer's own.

### 4.2 Finalization refuses rather than weakening the claim

`complete_for_terminal_chain` is `const: true` in the frozen schema, so an
*incomplete* inventory is not representable. The only honest behaviour when the
derivation cannot establish completeness is therefore to refuse to seal one, and
that is what both builders do — before any signature exists. `false` never
produces a weaker inventory that finalization continues past.

The gate is enforced in three places, deliberately: in each inventory builder, in
`assertFinalizable` / `assertEnvironmentFinalizable`, and — after the inventory is
frozen — by `assertSignerInventoryStillComplete`, which re-derives against the
tree *including* the sealed inventory so a signed artifact appearing between
derivation and freeze cannot ride in uncovered.

---

## 5. Decision: the two derivations stay independent

The producer's applicable-set derivation and the verifier's are **separately
implemented, with separate role tables**. A verifier that agreed with the producer
because it called the producer would be re-reading a producer field with extra
steps — the defect ADR-ERL2-024 named for `lab_validity`.

**Permitted sharing, and nothing else:**

- frozen contract types and registered identities;
- `signedSchemaAuthorityFields()` — which field carries authority is a fact about
  the frozen schema, not a second opinion;
- canonical hashing and signature primitives.

The fixture builder is a **third** implementation (`tests/support/signedMemberScan.ts`),
for the same reason one layer further out: a golden checked with the producer's
own derivation would prove only that the producer agrees with itself.

`tests/architecture/signerInventoryIndependence.test.ts` asserts that neither
package imports the other's derivation, that the fixture scanner imports neither,
and that the two role tables nonetheless **agree** schema for schema and role for
role — a divergence is a real defect (the producer would inventory a member the
verifier refuses, or omit one it requires) and must fail there rather than in a
golden.

---

## 6. Decision: fixtures contain what they claim

`fakeRun.ts` enumerates its own retained signed members and projects the inventory
from them, and then — over the **finished** tree, so it sees the attestation the
enumeration could not — asserts that the inventory is exactly the applicable set.
A fixture may not claim a condition it does not contain, and that is now checkable
inside the fixture rather than only in the verifier that reads its output.

`tests/contract/signerInventoryFixtures.test.ts` measures the shipped goldens on
the same terms, pins the counts (9 retained / 7 applicable / 7 listed on every
pre-environment golden), and carries a named regression asserting the fixture no
longer hand-writes an entry.

---

## 7. Contract and artifact impact

**No frozen schema changes shape or meaning, and no new contract identity is
added.** `packages/contracts/` is untouched for the third package in a row: no
schema, no registry entry, no generated type, no new error code.

The existing signer-inventory contract already expresses the complete inventory —
`entries` admits up to 4096 members and the shipped maxima are 7 and 63 — so
ADR-ERL2-029 §25's rule (prefer no contract change where existing evidence
suffices) applies and no major is cut.

The **completeness report is internal**. Adding it to `TrustVerificationReportV2`
would change a frozen contract to carry a diagnostic; it is returned from the
derivation for tests and callers instead.

Every refusal reuses an existing catalogued code:

| concern | code |
|---|---|
| an applicable member with no entry | `INVENTORY_ENTRY_MISSING` |
| an entry for an inapplicable, excluded or non-applicable artifact | `INVENTORY_ENTRY_EXTRA` |
| two entries for one artifact core hash | `INVENTORY_ENTRY_EXTRA` |
| an inventory retained by an invalid record | `INVENTORY_ENTRY_EXTRA` |
| an entry whose schema, key or signature hash contradicts the artifact | `INVENTORY_ENTRY_MISMATCH` |
| an entry whose key is not granted the contract's role | `TRUST_KEY_NOT_AUTHORIZED_FOR_ROLE` |
| a signed contract with no declared role, or an undeclared authority field | `TRUST_SIGNATURE_INVALID` |
| an inventory naming another run, or a member from another run | `GRAPH_CLOSURE_TERMINAL_MISMATCH` |
| a member the lifecycle never reached | `GRAPH_CLOSURE_UNREACHABLE_ARTIFACT` |
| finalization with an inventory the derivation cannot certify | `INVENTORY_ENTRY_MISSING` |

### 7.1 Goldens and the byte pin

**Goldens move; the pin does not.** The corrected inventories change the signer
inventory, the attestation that binds its hash, the bundle that carries both, and
the terminal lifecycle event that names them — and the fixture's three added
`produced` entries move every event hash downstream of preregistration, which is
why the invalid goldens move too. No file is added or removed, so
`EXPECTED_PINNED` stays **787**, `EXPECTED_EXCLUDED` stays **7**, and the
exclusion-manifest digest is unchanged.

The dependency chain, recorded so a future reader can attribute any of it:

```
signed-member set → signer inventory → inventory core hash
  → final attestation → attestation core hash
  → public bundle (+ member descriptors) → terminal lifecycle event
  → golden tree
```

**The seven exclusions are not widened.** The nondeterministic sealed-selection
bytes keep their existing shape-pinning decision, untouched.

---

## 8. Rejected alternatives

**Keep reading `complete_for_terminal_chain` and check only the entries present.**
The status quo, and the `lab_validity` mistake with a different field name. It
makes the inventory's central claim the one unverified thing about it.

**Let the producer emit `complete_for_terminal_chain: false` and finalize anyway.**
Rejected on the contract *and* on the argument. The schema pins the field to
`true`, so it is not representable; and even if it were, a terminal chain whose
own inventory says it is incomplete is not evidence a reader can use — the honest
outcome is that finalization stops.

**Share one derivation between the producer and the verifier.** Rejected: it would
make the verifier's agreement a tautology. The cost is two tables that must be
kept in step, which is why an architecture test asserts they agree rather than
leaving it to review.

**Exclude wrapper-signed members, since the wrapper is a foreign signing scope.**
Rejected. The wrapper signature *is* Lab authority — it is the Lab/verifier
association over a beacon round — and excluding it would remove precisely the
member the review found missing.

**Add a fixture-only exemption so the goldens pass.** Rejected, and it is the
specific thing ADR-ERL2-029 §4 said must not happen: a rule that exempts the
fixtures is a rule refusing nothing.

**Require lifecycle reachability of the trust policy and the terminal checkpoint
by adding `produced` entries for them.** Rejected: the trust root is not produced
by the run under any honest model, and a checkpoint that anchors the run record
cannot be produced by an event that precedes it without reintroducing the
self-anchoring `assertNotSelfAnchoring` exists to prevent. The exemption is
declared per contract with its reason instead, and pinned by name.

**Add the completeness report to `TrustVerificationReportV2` so a reader sees the
derivation.** Rejected: a frozen contract does not change shape to carry a
diagnostic. If a reader needs it, that is a new additive report and its own
decision.

---

## 9. Consequences

- ADR-ERL2-024 §4.6's table gains its last row. With signer-inventory
  completeness derived, the list of producer *fields* the verifier trusts for a
  semantic verdict is empty.
- Two members that had never been inventoried in the history of the system — the
  mirrored trust root on every run, and the beacon association wrapper on every
  environment run — are now covered on both branches.
- The fixture is faithful to the shipped producer's lifecycle for the first time;
  three retained signed members that no event reached are now reached.
- `tests/architecture/` gains five cases, so `npm run purity` reports **29**
  rather than 24. The number is not the invariant; the boundary is.
- **The claims ceiling is unchanged: T1.** This package adds verifier refusals and
  corrects producer output. It measures no new environment, no new subject and no
  new robustness.
