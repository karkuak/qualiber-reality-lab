# ADR-ERL2-025 — evidence-derived claim-scope ceiling

**Status:** accepted
**Date:** 2026-07-29
**Deciders:** Lab Core Owner, Integrity/Security Owner, Claims Owner, Verifier Reviewer
**Extends:** ADR-ERL2-019 (§4 a phase validates its departure state before any dispatch),
ADR-ERL2-022 §1 (the finalizer injects the verifier's own closure algorithm rather
than reimplementing it), ADR-ERL2-024 §4.6 and §7 (verifier-owned derivation).
Nothing is superseded. ADR-ERL2-024 §11 recorded `--claim-scope` as **"operator-supplied
and ungated … out of scope here and explicitly still open"**; this ADR decides it, and
does not restate ADR-024 as having covered it.
**Normative source:** `external-reality-lab-design-v2.md` `2.0.0-draft.11` §6, §17, §19,
§25, §26; `external-reality-lab-implementation-plan.md` §3.1, §18; ERL2-AC-015.
**Evidence of defect:** `Independent-Code-Review-Slice-6.5B.md` (2026-07-28), the P2
cluster entry recorded in `docs/ledger/remediation-6.5-invariants.md` §6 as
"`--claim-scope` operator-supplied and ungated".

---

## 1. Context

`claim_scope` is the one field in a signed attestation that states how strongly the run
may be spoken about. Every other verdict in the system is derived: the closure is
recomputed by the verifier's own algorithm before the finalizer signs anything
(ADR-ERL2-022 §1), validity, restoration, teardown and the emergency action set are
recomputed from retained bytes (ADR-ERL2-024 §4.6), and `deriveTerminalVariant` refuses to
read the record's account of itself. `claim_scope` was typed in at the command line:

```ts
const claimScope = flags["claim-scope"] ?? "T1";           // packages/cli/src/environmentCommands.ts:771
const claimScope = (flags["claim-scope"] as string) ?? "T1"; // packages/cli/src/journeyCommands.ts:672
```

and read back like this:

```ts
if (!["T1", "T2", "T3"].includes(attestation.claim_scope)) { … }   // verify.ts:172, :398
```

So `erl2 finalize-generic --claim-scope T3` produced a signed, offline-valid attestation
asserting **historical-reproduction evidence** over a run that is, by the repository's own
`docs/claims/permitted-claims.md`: development tier, the fake environment driver, a
trusted reference subject, non-blind selection, and `DomainResultNotApplicableV1` — a run
that measured no domain outcome at all. Nothing in the producer or the verifier disagreed.

This is a false-attestation path of the same shape as P0-1, one level up: P0-1 let a run
sign a cleanup verdict about an environment it never looked at; this let a run sign a
*strength* claim about evidence it never collected.

---

## 2. Scope and non-goals

### In scope

The derivation of `claim_scope` from retained run evidence, its CLI semantics, its
verifier-side rederivation, and the refusal when the two disagree.

### Explicit non-goals

- **Widening any claim.** This ADR removes an unearned claim; it adds none. Every scope
  the repository can currently emit stays exactly T1, and §5 states why.
- **T4.** Out of reach at schema level and unchanged: `ClaimScope` is `T1|T2|T3`,
  `FinalLabAttestationV1` has no T4 encoding, and design v2 §25 puts contextual T4 behind
  a separately verified `CustomerVerificationBundleV1` that does not exist.
- ERL2-OQ-005, ERL2-OQ-007 and ERL2-OQ-008 are untouched and still fail-closed. Two of the
  components below are held at T1 *because* they are open, which is a consequence of their
  state, not a change to it.
- The evaluated domain plane. Untouched. It is an input to the derivation, not a target.

---

## 3. Definitions

**Claim scope.** The strength of statement a terminal authorises, ordered **T1 < T2 < T3**,
from design v2 §25 ("T1–T3: capability/robustness/regression evidence only"):

| Scope | Evidence class | Source |
|---|---|---|
| **T1** | **capability** — this run did this thing, under the conditions recorded | design §25 |
| **T2** | **robustness** — the behaviour survives conditions the run did not choose | design §25; plan §3.1 "Core V2 release … design-authorized T1–T3 claims" |
| **T3** | **regression / historical reproduction** | design §26 (slice 12: "T3 reproduction and no future leak"); plan §3.1 "OSS time-machine extension — T3 historical reproduction only", §18 "historical truth admission and T3 claim policy" |

**Component.** One constraint the run's own retained evidence places on the scope. A
component is *applicable* or not; an applicable one carries a ceiling.

**Ceiling.** The strongest scope the evidence supports: the minimum over applicable
component ceilings.

**Earned scope.** The ceiling. What a terminal is signed with when no flag is given.

**Requested bound.** `--claim-scope`, when supplied: an upper bound the operator asks for,
never an authority.

---

## 4. The decision

### 4.1 `claim_scope` is derived, and the derivation is a monotonic minimum

```
ceiling = min over applicable components of component.ceiling
```

Four properties, stated because each of them is a way the rule could have been got wrong:

1. **No component raises another's ceiling.** Combination is `min`, never `max` and never
   an average. A blind selection does not buy back a fake driver.
2. **Missing evidence lowers or refuses; it never raises.** A component whose evidence is
   absent reports T1 with the reason, unless the component is genuinely *inapplicable* to
   the terminal variant — in which case it is **excluded** from the minimum rather than
   defaulted in either direction. "There was no selection to be blind about" and "the
   selection was not blind" are different statements and are recorded differently.
3. **T1 is the floor, not zero.** The derivation runs only on a terminal that is already
   *valid*; a valid terminal is capability evidence by construction. There is no
   representable scope below T1 and none is invented.
4. **The ceiling is data, not a boolean.** The report names every component, its
   applicability, its ceiling and what was observed, and names which components are
   actually holding the ceiling down — so a refusal says *why*, and so the handoff can
   state the claims ceiling without anyone reconstructing it by hand.

### 4.2 The components

| Component | Evidence, from retained bytes | Ceiling |
|---|---|---|
| `terminal-variant` | derived terminal variant | `pre_environment` → **T1** (no environment was provisioned, so there is no robustness or regression evidence to constrain); `environment` → T3 |
| `execution-tier` | the **selected** challenge's `challenge-manifest/v1.tier`, reached through the run's `selected-challenge-journey-binding` | `development` → **T1**; `held_out` → T2; `blind` → T3; no selection → **T1** |
| `selection-assurance` | the attestation's own `selection_assurance` | `non_blind_development` → **T1**; `blind_or_held_out` → T3; **inapplicable** when the variant runs no selection |
| `environment-realism` | `environment-driver-manifest/v1.driver_kind` / `.enabled`, and `substrate-binding/v1.substrate_lock_hash` | fake driver → **T1**; disabled → T1; real, enabled, no qualified substrate lock → T1; real, enabled, locked → **T2** (robustness, never regression: infrastructure is not history); **inapplicable** with no environment |
| `subject-containment` | `isolation-qualification-report/v1.verdict` | `qualified` → T3; `not_qualified` → T1; **absent → T1** |
| `domain-evaluation` | the `domain-result` role's schema and status | `domain-result-not-applicable/v1` → **T1**; `evaluated` → T3; `unsupported` / `inconclusive` → T1 |
| `metric-ceilings` | every `metric-result` role | see §4.3 |
| `regression-evidence` | a historical-reproduction record | absent → **T2**; present → T3 |

### 4.3 How metric ceilings combine

Each `MetricDefinitionV1` declares the strongest claim its metric can support and
`MetricResultV1` carries it forward as `claim_ceiling`. The component is the **weakest
applicable** measurement:

- `measured` counts, at its declared `claim_ceiling`;
- `inconclusive` counts, at **T1** — a measurement that concluded nothing cannot support a
  stronger claim than one that concluded something;
- `not_applicable` is **excluded**. A metric that did not apply is not a weak result; it is
  not a result. Counting it would let the number of inapplicable metrics decide the claim.
- **zero denominator** is already resolved before this point: `MetricZeroDenominatorBehaviour`
  is explicit and mandatory at contract level, so a zero-denominator metric arrives here as
  `not_applicable`, `measured` at 0, or `measured` at 1, and is treated as whichever it is.
- a **`hard_safety`** metric with `threshold_satisfied: false` caps the whole component at
  **T1 unconditionally**, whatever else is measured, and short-circuits. Design v2 §17 makes
  hard safety non-tradeable, and `docs/ledger/remediation-6R.md` already recorded
  claim-scope capping as the route the design gives it. This is the run-blocking consumer
  that entry named as owed.
- with **no metric results at all**, the component is inapplicable — a run that froze no
  measurement is constrained by its other components, not by an absence dressed as a
  measurement.

**One T1-limited applicable metric does hold the terminal at T1.** That is the intended
reading of "no stronger than the weakest applicable constraint", and it is why
`not_applicable` is excluded rather than scored: the exclusion is what keeps the rule from
being either vacuous or absurd.

### 4.4 CLI semantics

- **No `--claim-scope`:** the earned scope is derived and signed.
- **`--claim-scope` supplied:** it is a *requested upper bound*.
  - **weaker than the ceiling → accepted, exactly as asked.** Under-claiming is honest, and
    an operator who wants to say less than the evidence permits is never refused.
  - **equal → accepted.**
  - **stronger → refused**, `POLICY_CLAIM_SCOPE_EXCEEDS_EVIDENCE`, before anything is signed.
  - **not T1/T2/T3 (including `T4`) → refused**, `CFG_MISSING_REQUIRED`.

**Refused rather than silently capped**, deliberately. Capping is the more dangerous of the
two: an operator who typed `T3` and got a signed `T1` back has been told nothing and would
go on believing the run supported the claim. A refusal that names the binding components is
the only outcome that transfers the information.

### 4.5 The verifier derives it again

`verifyPublicBundle` recomputes the ceiling from the retained artifact index and the
hash-chained lifecycle, and refuses

```
attestation.claim_scope > independently_derived_ceiling
```

with `POLICY_CLAIM_SCOPE_EXCEEDS_EVIDENCE`. A lower honest scope is accepted. The
producer's selected scope is never an input to the verifier's derivation.

The derivation is **verifier-owned** and lives in `packages/public-verifier`; the CLI
*injects* it, exactly as `assertEnvironmentFinalizable` injects the closure and the cleanup
derivations (ADR-ERL2-022 §1, ADR-ERL2-024 §7.1). Two implementations agreeing would prove
only that the implementations agree.

### 4.6 No frozen contract changes

`claim_scope` already exists on both attestation variants, `ClaimScope` already enumerates
`T1|T2|T3`, and every component reads evidence the terminals already close over:
`challenge-manifest/v1`, `environment-driver-manifest/v1`, `substrate-binding/v1`,
`domain-result`, `metric-result`, and the attestation's own `selection_assurance`. **No
schema is added, changed, or given a new optional field**, and no derivation metadata is
written into a frozen terminal — the ceiling is recomputable by any reader holding the
artifact root, which is the property that makes writing it down unnecessary.

---

## 5. What this repository can currently emit

Applying §4.2 to the shipped environment terminal:

| Component | Observed | Ceiling |
|---|---|---|
| `terminal-variant` | environment | T3 |
| `execution-tier` | the selected challenge was admitted at `development` | **T1** |
| `selection-assurance` | `non_blind_development` | **T1** |
| `environment-realism` | `fake-driver`, `driver_kind: "fake"` | **T1** |
| `subject-containment` | no qualification report retained | **T1** |
| `domain-evaluation` | `domain-result-not-applicable/v1`, `functional_evidence_unavailable` | **T1** |
| `metric-ceilings` | nine journey-plane metrics, weakest declared ceiling T1 | **T1** |
| `regression-evidence` | none retained | T2 |

**Ceiling: T1**, held down by six independent components. The pre-environment terminal is
T1 for the same reasons plus its variant.

**T2 is unreachable** on this tree: it needs a real, enabled driver on a locked substrate,
and ERL2-OQ-005 keeps the Compose driver signed `enabled: false`.

**T3 is unreachable** on this tree: `regression-evidence` caps at T2 because the historical
mirror, cutoff-reachability manifest and pre-fix/fix archive that design §26 and plan §18
require are slice-12 contracts that do not exist. That is expressed as a derivation over an
absent artifact and not as a hardcoded constant, so the day those contracts exist this
function reads them; until then it says exactly why it cannot.

Six components would each have to change for a T1 run to become T2. That redundancy is not
an accident of the design — it is the point. A single check can be wrong; six independent
ones holding the same line cannot all be wrong in the same direction.

---

## 6. Rejected alternatives

| Alternative | Rejected because |
|---|---|
| Leave `--claim-scope` operator-supplied and document the limit | This is the defect. A documented false-claim mechanism is still a false-claim mechanism, and the claims file already documented the limit while the binary happily signed T3. |
| Silently cap a too-strong request to the ceiling | Tells the operator nothing. They asked for T3, got a valid-looking bundle, and still believe the run earned T3. A refusal is the only outcome that transfers the information. |
| Hardcode `claim_scope = "T1"` and delete the flag | Correct today and wrong permanently: it makes the honest answer indistinguishable from a stuck constant, and there would be nothing to strengthen when held-out execution or a real driver lands. The whole failure being fixed is a claim that was not derived from anything. |
| Derive the scope in the producer and have the verifier trust it | The exact shape of P1-11: a verifier that reads a producer's verdict verifies nothing. |
| Two implementations, one per side | Proves the implementations agree. The finalizer injects the verifier's function, as ADR-ERL2-022 §1 already established for closure. |
| Add a `claim_scope_derivation` member to the frozen attestation | Forbidden by the contract-evolution rule, and unnecessary: the ceiling is recomputable from retained bytes, so recording it would add a field a reader must ignore. |
| Score `not_applicable` metrics at T1 | Would let the *count of inapplicable metrics* decide the claim, and would cap every run at T1 for a reason unrelated to what it measured — a rule that is always right by accident is not a rule. |
| Take the tier from `SelectionRequestV2.requested_tier` | That is what was *asked for*. `ChallengeManifestV1.tier` is what the challenge was admitted at, and admission is the authority (ADR-ERL2-013). |
| Look for "the" retained challenge manifest and give up when there is more than one | A run retains **every admitted candidate** — that is what makes the eligibility pool checkable. Counting them reaches T1 on this tree for entirely the wrong reason, and would keep reaching it after a real held-out run. The tier that matters is the *selected* challenge's, reached through the binding. |
| Use the run-root or a CLI flag to say "this was a real driver" | The same substitution P0-1 turned on. The driver manifest is signed, retained and closure-required; a flag is not. |
| Cap on `hard_safety` by emitting an invalidity finding instead | There is no hard-safety finding category, and inventing one would misstate the design: §17 routes non-tradeable hard safety through `threshold_satisfied` plus claim-scope capping, which is what this does. |

---

## 7. Acceptance tests and negative controls

**Acceptance.** Against a real CLI-produced development run: no flag derives T1;
`--claim-scope T1` is accepted; `T2` and `T3` are typed refusals naming the binding
components; `T4` and a malformed value are typed refusals; a direct library call cannot
emit T3; the pre-environment terminal cannot be operator-upgraded; a bundle mutated to
carry T2 or T3 — with every hash and signature repaired so the mutation reaches the
semantic rule rather than an incidental check — is refused by the offline verifier *for
exceeding the derived ceiling*; a lower honest scope is accepted; each component is
independently shown to hold the ceiling at T1; `not_applicable` metrics are excluded; one
T1-limited applicable metric holds the terminal at T1; an unsatisfied `hard_safety`
threshold caps at T1 whatever else is measured.

**Negative controls.** Two, each required to make at least one *named* test fail:
`producer-claim-scope-derivation` (the producer accepts the requested scope unchecked) and
`verifier-claim-scope-rederivation` (the verifier accepts the producer's scope). A control
that kills nothing is reported as a non-load-bearing invariant, never quietly re-scored —
the discipline `docs/ledger/remediation-6.5B.md` §10a established.

---

## 8. Consequences

- One new refusal code, `POLICY_CLAIM_SCOPE_EXCEEDS_EVIDENCE`. No new contract, no schema
  change, no new signer role, no new closure role, no lifecycle state.
- `--claim-scope` survives as a requested upper bound, so every existing invocation that
  passes `--claim-scope T1` — the evidence harness, the CLI transcript golden, the e2e
  suites — keeps working and keeps meaning what it said.
- Every environment and pre-environment bundle this build produces carries T1, which is
  what they carried before. **No retained bytes change meaning and no golden's claim scope
  moves**: the field's *authority* changed, not its value.
- The claims ceiling is unchanged. This ADR removes the ability to state a claim the
  evidence never supported; it grants nothing.
