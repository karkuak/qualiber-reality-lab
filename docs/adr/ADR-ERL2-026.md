# ADR-ERL2-026 — independently probed restoration

**Status:** accepted
**Date:** 2026-07-29
**Deciders:** Lab Core Owner, Integrity/Security Owner, Environment/Challenge Governor, Verifier Reviewer
**Extends:** ADR-ERL2-023 §2a (the Lab derives an action's success by re-observing the
substrate, never from what the receipt claimed), ADR-ERL2-024 §4.2 (the substrate binding),
§4.3 (durable intent before every external mutation) and §4.6 (verifier-owned derivation).
Nothing is superseded. ADR-ERL2-024 §6.2's `EnvironmentDriver` extension is **extended
again** by §6.2 below, and by nothing else.
**Normative source:** `external-reality-lab-design-v2.md` `2.0.0-draft.11` §12, §14, §16.2;
`external-reality-lab-implementation-plan.md` §12; ERL2-FR-025/026, ERL2-AC-031.
**Evidence of defect:** `Independent-Code-Review-Slice-6.5B.md` (2026-07-28), finding
**P1-4**, which ADR-ERL2-024 §14 recorded as closed and which was closed only in part.

---

## 1. Context

ADR-ERL2-024 §4.3 gave the compensation a durable intent that names what it must revert,
and §4.6 had the verifier recompute restoration instead of reading `passed`. Both are
real, and neither answers the question P1-4 actually asked.

Restoration was derived — by the producer in `buildEnvironmentRestoration` and again by the
verifier in `deriveRestorationOutcome` — from four things:

1. `baseline_before_hash` vs `baseline_after_hash`;
2. `residual_resources`;
3. the cited compensation receipts' own `status`;
4. (producer only) a `driver.inspect` whose result was assigned to a variable and then
   discarded with `void inventory`.

**Not one of those can see a mutation.** The baseline fingerprint is built from probe
observations and evidence-source states — resource *health*. The inventory is resource
*existence*. A mutation changes neither: `FakeEnvironmentDriver.mutate` appends to
`SubstrateState.mutations` and touches nothing the fingerprint reads. So a driver that
returns `status: "succeeded"` and clears nothing produces two identical baselines, an
unchanged inventory, a succeeded receipt — and `passed: true` over a mutation that is
still applied. The verifier reaches the same conclusion from the same blind evidence.

The receipt is not an answer to this. A compensation receipt is a statement by the driver
about the driver's own work, and ADR-ERL2-023 §2a already fixed the direction of trust for
exactly this shape when it refused to let an emergency action's success come from its
receipt.

And the two cases the finding named as indistinguishable still were. `expected` lived only
inside `requestHash`, as an opaque digest in run-private state that reaches no contract, so
no retained evidence recorded whether the compensation had anything to revert. "Reverted
nothing" and "had nothing to revert" produced byte-identical terminals.

---

## 2. Scope and non-goals

### In scope

The independent post-compensation observation, the durable pre-compensation intent that
says what it is for, the binding between a compensation receipt and the compensation it is
cited for, and the verifier's rederivation of all three.

### Explicit non-goals

- **Emergency cleanup.** Already derived by re-observation (ADR-ERL2-024 §4.5). Untouched.
- **The claims ceiling.** This removes a false claim; it adds none. A probe over a fake
  substrate proves the mechanism, exactly as ADR-ERL2-024 §11 says of the binding.
- ERL2-OQ-005/007/008. Untouched, still fail-closed.

---

## 3. Definitions

**Applied-mutation set.** What the substrate reports as currently mutated, in the driver's
own vocabulary. An **observation**, read-only by contract, like `probe` and `inspect`.

**Expected reverted set.** What a compensation is declared to undo, derived from the run's
own retained `mutation-receipt` role — one entry per receipt, naming the mutation, the
receipt that recorded it applied, and the resource it was applied to.

**Restoration probe.** The signed, retained `RestorationProbeV1` (ERL2-C-157) holding the
expected set, the applied-mutation set observed before the compensation, the set observed
after it, and the outcome derived from them.

---

## 4. The decision

### 4.1 The substrate is asked again, and the answer is the verdict

A driver gains an applied-mutation observation. The Lab reads it immediately before
dispatching the compensation and immediately after it returns, and derives restoration from
the difference — never from the receipt.

A driver that cannot offer it is not broken; it simply cannot support a restoration claim.
Its probes record `probe_status: "unavailable"`, which derives `unobservable`, which
refuses. That is the same fail-closed posture ADR-ERL2-024 §4.3 takes for a driver with no
operation log, and for the same reason: an outcome nobody can observe is not an outcome
that may be signed.

### 4.2 The expected set is durable, retained, and derived from the run's own evidence

Before the compensation is dispatched:

- the **durable intent** (run-private, `state/intents/`) gains the mutation ids, the target
  identities, the post-condition that must hold, and the id of the probe that will answer
  it. `request_hash` already covered the same facts as a digest, which answers "was this
  the same request" and not "what was this run in the middle of undoing" — and the second
  question is the one a reconciliation asks;
- the **expected set** is derived from the retained `mutation-receipt` role, so it is
  exactly what the run durably recorded as applied and cannot be narrowed at compensation
  time. A mutation receipt that declares no `compensation_id` refuses the restoration
  rather than being dropped from the set: a mutation nobody can prove reverted is not a
  mutation to quietly stop counting.

The mutation id is recovered from `EnvironmentOperationReceiptV1.compensation_id`, which is
where a driver says "the way to undo this is …" when it applies a mutation. That is the
only place the Lab's vocabulary and the driver's meet, and it is a field the driver already
signs into a retained receipt.

### 4.3 Five outcomes, and the two that used to be one

`outcome` is derived from the sets, never supplied:

| outcome | derived when | supports a valid terminal |
|---|---|---|
| `residual` | an expected mutation is still in `observed_after` | no |
| `collateral` | something present before, never expected, is now gone | no |
| `unobservable` | `probe_status: "unavailable"` | no |
| `nothing_to_revert` | nothing was expected and nothing was observed applied | **yes** |
| `reverted` | every expected mutation is gone and nothing else was touched | **yes** |

Ordered most-specific-failure first, so a compensation that both missed its target and
removed something else is reported as the failure it was asked about.

`nothing_to_revert` and `reverted` are **distinct retained values**. That is the whole of
"reverted nothing must be distinguishable from there was nothing to revert": the terminal
now says which one happened, and a run that had no mutation cannot present itself as one
that undid something.

**`observed_before` is evidence, not a precondition.** A run resumed after a crash whose
compensation already completed adopts the prior receipt from the driver's operation log
(ADR-ERL2-024 §4.3), and legitimately observes an empty applied set before its own
dispatch. Requiring the expected mutations to appear there would refuse a correctly
reconciled restart. The load-bearing condition is the one that cannot be explained away:
**no expected mutation may remain in `observed_after`.**

### 4.4 A compensation receipt must be this compensation's

Four ways a receipt can be about something else, each of them a way for a genuine past
success to be replayed over a compensation that never happened, none of them caught by any
hash check because the receipt is retained, hash-linked and role-produced:

| The receipt | Refusal |
|---|---|
| belongs to another run | `RESTORATION_PROBE_MISSING` |
| settles another operation id | `RESTORATION_PROBE_MISSING` |
| records a `mutate`/`destroy`, not a `restore` | `RESTORATION_PROBE_MISSING` |
| was issued against a driver manifest this run never bound | `RESTORATION_PROBE_MISSING` |
| is observed by a probe naming another substrate binding | `RESTORATION_PROBE_MISSING` |

And a restoration citing **the same receipt twice** is refused: one receipt counted twice
is how a compensation that covered half its mutations comes to look complete.

### 4.5 Signer and authority

`restoration-probe/v1` is signed by the **environment governor**, the same authority and
the same argument as the substrate binding (ADR-ERL2-024 §6.4): the governor owns the
environment, so it owns the statement that the environment was observed back at its
baseline. The **driver signs nothing here** — it is the party whose compensation is being
checked, and a statement that a driver's compensation worked, signed by that driver, proves
nothing.

### 4.6 The verifier rederives it

`deriveRestorationOutcome` gains the probe and requires:

- the probe is this run's, over this restoration's environment instance, and
  names the one substrate binding the run froze — an observation of another
  substrate says nothing about this one, and the binding is the only artifact
  that names which substrate was observed at all (ADR-ERL2-024 §4.2);
- it settles the compensation the restoration actually cites, and the receipt it names
  settles the operation it claims;
- its expected set corresponds **one-for-one** to the retained `mutation-receipt` set —
  neither smaller (a compensation that did not cover every applied mutation), nor larger (a
  probe naming a mutation the run never made), nor duplicated;
- each expected entry names the target its own receipt named;
- the retained `outcome` is the one its own observations derive;
- and the probe supports restoration, or `passed` is false.

`restoration-probe` becomes a **required closure role** on the valid environment branch. A
terminal that carries a restoration without the observation that qualifies it is exactly
the artifact P1-4 produced.

The **set arithmetic** is shared with the producer, on the terms ADR-ERL2-024 §7.2 already
set for `safeActions` and `assertFrontierActionsDerivable`: it is set difference over two
retained arrays, a definition reproducible by any reader holding the bytes. Everything
*around* it — the correspondence to the retained receipts, the run and binding identity,
and the check that the retained `outcome` is the derived one — is verifier-owned and shared
with nothing.

---

## 5. Lifecycle ordering

No new lifecycle state, no new phase, no new transition. `restore` freezes one more
artifact inside its single durable transition:

```
restore:
    validate departure state
    assert substrate binding
    derive expected reverted set        <- from retained mutation receipts
    observe applied mutations           <- before
    declare intent -> dispatch -> settle
    assert the receipt is this compensation's
    observe applied mutations           <- after, independently
    freeze RestorationProbeV1           <- new
    refuse unless reverted / nothing_to_revert
    re-probe baseline, freeze restoration verification
    append `environment_restored` (produced: … + `restoration-probe`)
```

---

## 6. Artifact and contract changes

### 6.1 One new contract identity; no frozen schema changed in place

`ERL2-C-157` — `RestorationProbeV1`, `restoration-probe/v1`, in `erl2:environment`.
Additive on exactly the terms ADR-ERL2-024 §6.1 used for `substrate-binding/v1` and
ADR-ERL2-023 §2 for `challenge-activation-receipt/v1`: **no existing schema changes shape
or meaning**, no field is repurposed, no optional field is added to a frozen schema, and no
retained historical bytes are rewritten. The signer role (`environment_governor`) is
already in the frozen `trust-policy-manifest/v2` `SignerRole` enum and already granted by
the development trust policy, so no new key enters the trust head.

`EnvironmentRestorationVerificationV1` is frozen and could not carry the observation, which
is precisely why the observation gets its own identity instead of an optional field on a
frozen schema — the weakening the additive-contract rule exists to prevent.

### 6.2 `EnvironmentDriver` gains one optional observation

```ts
interface EnvironmentDriver {
  …
  /** Mutation ids the driver observes as currently applied. Optional; absence fails closed. */
  observedMutations?(runId: string): readonly string[];
}
```

Optional, and its absence has a defined fail-closed consequence rather than a silent one
(§4.1). `supported_operations` is a **frozen enum** and is not extended: the capability is
signalled by the presence of the method, exactly as ADR-ERL2-024 §6.2 did for
`destroyResource`.

### 6.3 Registry, generated types, goldens, roles

- registry entry `ERL2-C-157`;
- `packages/contracts/schemas/environment.schema.json` gains `RestorationProbeV1` and its
  `ExpectedRevertedMutation` entry type;
- `packages/contracts/generated/types.ts` regenerated by `npm run generate` — never
  hand-edited;
- `SIGNED_MEMBER_RULES` gains `restoration-probe/v1 → environment_governor`;
- `ENVIRONMENT_ROLES` gains `restoration-probe`;
- the environment signer inventory covers the probe;
- goldens regenerated deliberately under `evidence:update`.

---

## 7. Migration and backward compatibility

- **No frozen schema changed in place**, so every retained artifact from every earlier
  slice still parses, still hashes to the same value and still verifies.
- **Pre-environment terminals are untouched.**
- **Environment bundles produced before this change carry no restoration probe and will not
  verify.** Intended, and not softened, for the same reason ADR-ERL2-024 §10 gave: a
  bundle with no probe is exactly the artifact whose restoration cannot be checked. The
  only such artifacts are regenerated development goldens; there is no external consumer.
- **The invalid-terminal fixtures are unaffected.** A run that failed restoration never
  reached the valid branch, and `deriveRestorationOutcome` takes the probe as optional so
  the invalid-record pass still runs where a probe legitimately does not exist.

---

## 8. Security analysis

**What this closes.** A driver can no longer be the authority on whether its own
compensation worked. A compensation that reverted nothing, reverted the wrong thing,
reverted only some of what it should have, or was never required at all is now a different
retained artifact from one that succeeded, and both the producer and an offline reader
refuse the first four.

**What this does not close, and why that is the right boundary.**

- **The substrate is still the environment.** An adversary with write access to the
  substrate can forge the applied-mutation set as easily as the instance marker. ADR-ERL2-024
  §11 settled this: writing to the substrate *is* manipulating the environment, and the
  probe's job is to prove the Lab looked, which it does.
- **The observation is only as good as the driver's vocabulary.** A driver that reports a
  mutation id it never applied, or omits one it did, is lying about its own state. The
  Lab's defence is the correspondence to *its own* retained mutation receipts, which the
  driver does not sign — not an independent census of the substrate, which no driver
  interface can offer.
- **The fake driver remains a fake driver.** Unchanged.

---

## 9. Rejected alternatives

| Alternative | Rejected because |
|---|---|
| Trust the compensation receipt's `status` | It is the driver's statement about the driver's work. ADR-ERL2-023 §2a already refused this shape for emergency actions; restoration is the same shape. |
| Add the applied-mutation set to the baseline fingerprint | Changes the meaning of a frozen contract and of every retained fingerprint, and conflates "the environment is healthy" with "the environment is unmutated" — two questions with two different failure modes. |
| Add optional fields to `EnvironmentRestorationVerificationV1` | Forbidden by the contract-evolution rule, and an optional field on a frozen schema lets an old producer omit it and still validate — the silent weakening the additive rule exists to prevent. |
| Make the probe a driver-signed receipt | A statement that a driver's compensation worked, signed by that driver, proves nothing. |
| Require every expected mutation to appear in `observed_before` | Refuses a correctly reconciled restart: a run that adopts a completed compensation from the operation log legitimately observes nothing applied before its own dispatch. |
| Treat `collateral` as a pass because the target was reverted | A compensation that removed unrelated state did not return the environment to its baseline. Reporting it as restored would be the same category of false claim, one target over. |
| Fold `nothing_to_revert` into `reverted` | The two are the pair the finding named as indistinguishable. Collapsing them would reintroduce the defect while appearing to fix it. |
| Derive the outcome in the verifier only, and have the producer sign whatever | The producer must refuse before it signs; `assertEnvironmentFinalizable`'s whole posture is that the finalizer does not emit a terminal its reader would reject. |
| Keep `void inventory` and check the inventory instead | The inventory is resource existence. It cannot see a mutation, which is why discarding it changed nothing. |

---

## 10. Acceptance tests and negative controls

**Acceptance.** From a substrate holding a known applied mutation: a receipt reading
`succeeded` while the mutation remains fails restoration; a probe naming a different
mutation, only one of several, the wrong run, the wrong substrate binding or the wrong
operation is refused; a compensation that removes unrelated state but not the target fails;
an unavailable probe fails; a missing, duplicated or replayed compensation receipt is
refused; a genuine compensation succeeds and its terminal verifies offline; and the offline
verifier reaches the same conclusion independently in every case.

**Negative controls.** Two, each required to make at least one *named* test fail:
`compensation-mutation-binding` (the expected set is not derived from the retained mutation
receipts) and `independent-restoration-probe` (the post-compensation observation is
removed). The brief requires the second explicitly.

---

## 11. Consequences

- One new contract (`ERL2-C-157`), one new signer row, one new closure role, two new
  refusal codes. No frozen schema changed shape or meaning.
- `EnvironmentDriver` gains one optional observation. ADR-ERL2-024 §6.2 is extended to that
  extent and to no other.
- Every golden containing a valid environment run is regenerated; the byte-pin coverage
  constants move in the same commit.
- Environment bundles produced before this change no longer verify. Intended (§7).
- The claims ceiling is unchanged: this removes a false restoration claim and adds no true
  one. ERL2-OQ-005, ERL2-OQ-007 and ERL2-OQ-008 are untouched and still fail-closed.
