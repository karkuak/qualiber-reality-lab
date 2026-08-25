# Validity gate-set completeness — RL-D-031

The correction that stops the offline verifier deriving a verdict from a gate set
the producer chose. It closes RL-D-031 on **both** terminal branches, and it
closes it without a schema change, a new key, a new trust tier or a new claim.

**Scope.** No contract schema changed and no generated file was hand-edited. No
error code was added. No collector image, pin, configuration, SBOM, provenance
or lock changed. Neither Qualiber checkout was accessed and no Qualiber run was
performed. No committed product-campaign evidence under `docs/evidence/**`
changed. The M3 trusted-local example, its operator-surface and troubleshooting
documents, and the workflow that gates them, are untouched.

---

## 1. What was wrong

RL-D-028 stopped both branches trusting the producer's **verdict**:
`derivePreEnvironmentValidity` and `deriveValidityOutcome` recompute `status`
from `gate_results` and refuse a result that disagrees with its own gates.

Neither checked whether those gates were the gates the run owed.

The status definition is `gates.every((g) => g.passed)`, and `every` over an
empty array is `true`. So a producer holding the finalizer key could:

- delete the one row that failed, and keep `status: "valid"`;
- narrow the array to a single passing gate;
- retain no gates at all;
- substitute identifiers the Lab does not own;
- publish `adapter-certified: true` on a run that executed no adapter bytes.

Reproduced independently against the merge base `62e7116d` with the shipped CLI,
every mutation fully re-signed — core hashes recomputed, lifecycle re-chained,
terminal re-signed under an authorized role, signed freeze head preserved.
**Seven of ten refuse-intent pre-environment cases reached exit 0 / `valid`.**
The environment branch had the same class: its retained set was never compared
with any catalogue, and it did not even carry the duplicate refusal the
pre-environment branch had.

Re-deriving a verdict from an attacker-chosen set of inputs is not an
independent derivation. It is the producer's answer reached by a longer route.

## 2. Where the required set comes from

Two sources, and the point of both is that the compromised party cannot reach
either.

**The Lab gate catalogue.** `LAB_VALIDITY_GATES`, `PRE_ENVIRONMENT_GATE_IDS` and
`ENVIRONMENT_GATE_IDS` are frozen compile-time constants that ship inside the
verifier. No retained byte can redefine them, because nothing reads a retained
byte to build them. They are imported rather than re-typed verifier-side, on the
same terms this repository already shares `exerciseApplicable` and
`decideTrustedTelemetryAuthority`: a catalogue is a *definition*, and definitions
may be shared where verdicts may not. A second hand-maintained copy would drift,
and a drifted copy fails **open** — it would stop requiring a gate the Lab had
added.

**`acquisition-preregistration/v1`**, for the single bit of applicability the
required set depends on. `subject_execution_mode` is a two-value enum that
decides whether `adapter-certified` is owed. That artifact is:

- signed by the **preregistrar**, a key distinct from the finalizer in the
  pinned trust policy, and verified against the verifier's own role table rather
  than against any producer claim;
- frozen before the run under ADR-ERL2-036, with `registered_at` as its security
  instant;
- a **mandatory** closure role on both branches, resolved through the
  closure-bound reference rather than by scanning for something of the right
  shape;
- bound to this run by the signed run-record chain, and by the signer-inventory
  refusal of any retained signed member belonging to another run.

**Deliberately not used.** The retained validity result's own fields — that is
the array under attack. The attestation — the finalizer signs both sides of it,
which is what RL-D-028 exists not to trust. And
`generic_run_policy_hash`; see §6.

**The finalizer cannot narrow the set.** Every input to the required set is
either a constant inside the verifier or a field of an artifact signed by a
different role. A producer that could re-sign the preregistration would already
hold the preregistrar key, and holding *that* key is a different compromise than
the one this correction defends against.

**What the key separation is, and is not, in this tier.** Every pinned key in
this repository's development configuration is derived deterministically from
its own public label: `developmentKey("preregistrar")` and
`developmentKey("finalizer")` are one line each, and anyone holding the
repository can recreate the entire keyring. They are nonetheless distinct
keypairs — distinct by label, and separated by role in the pinned trust policy —
and that distinction is what the argument above rests on: a party holding only
the finalizer key cannot produce a preregistration this verifier will read, and
so cannot choose the gate set its own terminal is measured against. What the
distinction is **not** is a secrecy boundary. It establishes nothing against a
party who can derive every development key, which in this tier is anyone with a
checkout, and it supplies no production secrecy or custody. What this correction
proves is therefore role-separated, run-bound authority under development
assumptions — not independent authority, and not production authority. No
certification, no production key custody and no new trust tier is claimed here
or in §7.

## 3. What was implemented

One new verifier-owned module,
`packages/public-verifier/src/library/gateSetAuthority.ts`, called from both
branches before any status arithmetic. It refuses, most-fundamental-first:

1. gate identifiers outside the Lab catalogue;
2. real catalogue members belonging to the **other** branch;
3. any gate evaluated more than once;
4. any required gate absent;
5. `adapter-certified` present on a run whose signed mode is not
   `external_adapter`.

Both branches use the same module and the same authority rules, because closing
one terminal and leaving the other open would leave the class open.

**Order is irrelevant, and that is a claim rather than an omission.** A gate set
is a set; nothing in the producer or the verifier derives anything from a row's
position, and the status definition is order-free. Membership is compared through
sets, a re-ordered honest set is accepted, and there is a test that says so.

**One property, one guard.** `subject-exercise-succeeded` and
`attributable-telemetry-retained` are excluded from the completeness set and left
to the ADR-ERL2-039/038 rules that already recompute their applicability from
retained bytes. This repository has already measured what a duplicate guard
costs: disabling either leaves the other refusing, so both score zero and neither
is proven load-bearing.

## 4. What completeness means, and what it does not

It means the **retained set** is complete and internally consistent: every gate
the branch owed is present, present exactly once, drawn only from that branch's
Lab catalogue, and consistent with the signed applicability answer.

It does **not** mean every gate was independently re-executed. Several gates read
evidence a public reader does not hold, and the verifier cannot re-run them.
That boundary is the one `preEnvironmentDerivation.ts` already drew for the
verdict, and this correction does not move it: what the verifier now additionally
requires is that the set be the run's set, not that it be re-measured.

## 5. Catalogue evolution and compatibility

The required set is a property of the **declared schema generation**. Today both
branches are `v1`, and the catalogue this verifier enforces is the catalogue the
shipped producer emits — verified against the two CLI-produced pre-environment
goldens, which pass **unchanged**.

Widening the catalogue for an existing schema version would make previously
honest bundles of that version refuse. So the rule is: a gate added to
`LAB_VALIDITY_GATES` for a branch that already has published terminals is a
**new schema version**, not an in-place edit. Narrowing is the dangerous
direction and is guarded from the other side — the fixture writer generates its
rows from `requiredGateIds` and throws on an identifier it has no evidence for,
so a catalogue change that this repository's own fixtures cannot satisfy fails
loudly at fixture-generation time.

No grandfathering clause was added. There is no knowingly incomplete verifier
class to grandfather: the only committed artifact that did not satisfy the rule
was the hand-built `valid-pre-environment-run` fixture, and it was regenerated
through the deterministic fixture-generation path rather than excused.

## 6. RL-D-030 remains separate and open

`pre-environment-validity-result/v1.generic_run_policy_hash` is never compared
with the attestation's, the run record's or the index's. The verifier resolves
`attestation.generic_run_policy_hash` and nothing else; setting the validity
result's copy to a hash that resolves to no retained artifact leaves the bundle
verifying. Confirmed independently here, on the merge base and after this
correction.

Severity today is low, because nothing derives anything from that field. It is
recorded because it is the exact binding a policy-driven gate-set strategy would
have had to rely on — and it does not hold, which is one of the reasons the
authority in §2 is a verifier-local catalogue instead.

**RL-D-030 is not fixed here, is not used as gate-set authority here, and this
correction does not expand to bind it.** It stays an open residual.

## 7. What this correction does not claim

No new trust tier, certification level or assurance claim exists as a result of
this change. The active claim ceiling is unchanged in meaning and in identity.
In particular this correction does **not** claim:

- that any validity gate was independently re-executed;
- independent certification of anything;
- production key custody;
- confinement;
- product correctness;
- subject quality.

What it claims is narrower and is the whole point: a verdict the offline verifier
reports is now derived from the set of controls the run owed, decided by the
verifier, rather than from the set the producer chose to retain.
