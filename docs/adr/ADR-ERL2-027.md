# ADR-ERL2-027 — one cleanup discipline for every invalid environment terminal, and an independently probed residue

**Status:** accepted
**Date:** 2026-07-29
**Deciders:** Lab Core Owner, Integrity/Security Owner, Environment/Challenge Governor, Verifier Reviewer
**Extends:** ADR-ERL2-022 (the frontier-derived invalid terminal), ADR-ERL2-023 §2a (the Lab
derives an action's success by re-observing the substrate, never from what the receipt
claimed), ADR-ERL2-024 §4.5 (per-action emergency cleanup) and §4.6 (verifier-owned
derivation), ADR-ERL2-026 (the independently probed restoration, whose shape this ADR
reuses for residue). Nothing is superseded. ADR-ERL2-024 §4.5's scope is **widened** by §4.1
below — from the emergency branch to every invalid environment terminal — and by nothing
else.
**Normative source:** `external-reality-lab-design-v2.md` `2.0.0-draft.11` §12, §14, §16.3,
§20, §22; `external-reality-lab-implementation-plan.md` §9, §12; ERL2-FR-001/025/031,
ERL2-AC-029/031/035.
**Evidence of defect:** `Independent-Code-Review-Slice-6.5B.md` (2026-07-28), findings
**P1-1**, **P1-3**, **P1-5** and **P1-6**, which ADR-ERL2-024 §14 recorded as closed and
which were closed on one branch of two; plus the audit of what ADR-ERL2-024's implementation
actually delivered, recorded in §1.

---

## 1. Context

ADR-ERL2-024 §4.5 removed the unconditional whole-environment `driver.destroy()` from
`emergencyCleanup` and replaced it with per-action attempts derived from the frozen
frontier. That is real, it is load-bearing, and three negative controls
(`frontier-action-derivation`, `safe-action-completeness`, `per-action-emergency-cleanup`)
measure it.

It is also **half the branch**. `EnvironmentRun.invalidate` routes on one boolean:

```ts
const cleanup = input.emergency
  ? this.emergencyCleanup(frontier, trigger)     // per-action, receipted, frontier-derived
  : this.boundedEnvironmentCleanup(frontier);    // driver.destroy(), unconditionally
```

`emergency` is true only for `environment_restoration` and `teardown` failures. Every other
invalid environment terminal — provisioning, baseline, planning, activation, observation —
reaches `boundedEnvironmentCleanup`, which is, in full:

```ts
const receipt = this.driver.destroy({ runId: this.runId, operationId: "op-invalid-destroy" }).receipt;
```

The frontier is frozen on the line above and then **never read**. Four of the five defects
ADR-ERL2-024 §4.5 was written to remove are therefore still live on this path.

### 1.1 A frontier-unsafe resource is destroyed anyway (P1-1)

`freezeResourceFrontier` classifies a resource the driver reports as
`shared_with_other_runs` into a `contain_residual` action, `independently_safe: false`,
reason `RESOURCE_SHARED_WITH_ANOTHER_RUN`. That classification is the Lab saying: *do not
touch this*.

`FakeEnvironmentDriver.destroy` then destroys it, because its own filter is
`resources.filter((r) => !r.destroyable)` — sharing is not consulted. The resource is gone,
no retained artifact says an action was taken against it, and the invalid record reports
`variant: "environment"`, `status: "attempted_succeeded"`. This is P1-1's exact shape: the
record describes a world the action already contradicted. It is *worse* than the original
P1-1, because the original at least reported the resource as `skipped_unsafe`; this one
does not mention it at all.

### 1.2 A foreign resource aborts the branch (P1-5)

`FakeEnvironmentDriver.destroy` calls `assertOwnedByRun` over **every** live resource
before touching any. One resource not scoped to the run throws
`ENV_FOREIGN_RESOURCE_REJECTED` out of `boundedEnvironmentCleanup`, out of `invalidate`,
and out of the command. Zero safe actions attempted, no invalid record, no terminal, leases
retained. That is P1-5 verbatim, on the branch that carries five of the seven failure
phases.

### 1.3 The verifier does not look (P1-6)

`deriveInvalidEnvironmentSemantics` opens with:

```ts
if (options.record.cleanup.variant !== "emergency_environment") return;
```

So for a bounded terminal the verifier derives **no** expected safe-action set, checks **no**
receipt cardinality, and validates **no** unsafe skip. The `result_hash` is an
`environment-operation-receipt/v1`, which the closure derivation resolves and otherwise
ignores. P1-6's requirement — that the verifier independently derive what should have
happened — is unmet on this branch because there is nothing retained to derive it from.

### 1.4 The primary finding names a gate from the wrong branch (P1-3)

`invalidate` freezes its primary finding with:

```ts
failedGateIds: [input.emergency ? "restoration-verified" : "environment-baseline-clean"],
```

A provisioning failure emits a Lab invalidity finding naming `environment-baseline-clean` —
a gate that belongs to a later phase, that this run never evaluated, and that has no causal
relationship to what failed. A teardown failure names `restoration-verified`, which by
construction passed. The finding is retained, hash-linked, role-produced and cited by the
record, and every structural check passes; it simply names the wrong thing.

P1-3's other half — `invalidityFindingHashes: []` hardcoded in `freezeValidityAndIndex` —
**was** closed by ADR-ERL2-024, and the audit confirms it: the hashes are now
`failedGates.map(...)`, one finding per failed gate, and `deriveValidityOutcome` requires
the correspondence offline. This ADR does not revisit that. It closes the branch of P1-3
that reaches a terminal through `invalidate` rather than through the validity gates.

### 1.5 The regression test for "a foreign resource no longer aborts cleanup" uses a
resource that is not foreign

`tests/adversarial/emergencyCleanupAdversarial.test.ts` builds its mixed frontier with the
`failed-restore-shared` fault, whose comment reads "the foreign member whose presence used
to abort the whole branch". That fault sets `shared_with_other_runs: true` on a resource
whose `run_scoped_name` still embeds the run id — so `assertOwnedByRun` **passes** for it,
and `driver.destroy` would never have thrown on it.

The test proves that a *shared* resource does not abort the branch. It does not, and cannot,
prove anything about a foreign one, because `FakeEnvironmentDriver` has no way to produce a
resource that fails `assertOwnedByRun`. The invariant is real; the test is not measuring it.
This is the same class of defect the ADR-ERL2-024 campaign found four times
(`remediation-6.5-invariants.md` §8) and it is recorded on the same terms.

### 1.6 Nothing observes the substrate after cleanup

`emergencyCleanup` does call `driver.inspect` afterwards, but the observation is consumed
in-process to compute `containment_status` and is never retained as an independently
checkable artifact. The consequence is precise:

- `remaining_resources` is derived by the producer from its own action outcomes;
- a producer that marks every action `succeeded` produces an **empty** residue;
- the verifier's cross-check (`every unresolved action's target appears in
  remaining_resources`) is vacuous when nothing is unresolved.

So an empty residue is unfalsifiable offline, and — the sharper case — a resource that
**vanished without an authorized action** is undetectable. §12.3 of the remediation brief
names this exactly: *post-destroy emptiness cannot conceal an unauthorized action*. Today it
can. This is the same hole ADR-ERL2-026 closed for restoration, in the same shape, and it is
closed here the same way.

---

## 2. Scope and non-goals

### In scope

Every invalid environment terminal's cleanup: frontier enumeration, safe-action derivation,
per-action execution and receipting, unsafe skips, whole-environment authorization, the
post-cleanup residue observation, the invalid terminal's own primary finding, and the
verifier's independent derivation of all of it.

### Explicit non-goals

- The **valid** path's teardown (`EnvironmentRun.destroy`). It is analysed in §4.4 and
  deliberately left as it is, for a stated reason.
- The evaluated domain plane (ERL2-OQ-008), the Compose driver (ERL2-OQ-005), held-out and
  blind execution (ERL2-OQ-007). Untouched, still fail-closed.
- The general crash-recovery matrix. Replay is checked for exactly-one-terminal behaviour
  and no further.
- P1-9, P1-10, and every P2/P3 finding not named in §12. Still open, listed there as such.
- This ADR does not claim the independent review is remediated.

---

## 3. Definitions

**Pre-action frontier.** The `EnvironmentResourceFrontierV1` frozen *before* the first
cleanup dispatch, over an inventory observed before that dispatch. It is the only frontier
any cleanup derivation may use. An inventory taken after a destruction is a *result*, never
an expectation.

**Authorized target.** A resource that is the `target_resource_id` of a derived action with
`independently_safe: true`. Nothing else may be affected by a cleanup dispatch.

**Attempted action.** A derived safe action for which the Lab dispatched, or tried to
dispatch, its authorized external call. Every attempted action has exactly one retained
receipt, success or failure; a driver that throws still produces one, Lab-authored and
marked `failed` (ADR-ERL2-024 §4.5 step 3, unchanged).

**Undeclared destruction.** A resource present in the pre-action frontier and absent from
the post-cleanup observation, which was not the authorized target of an attempted action.
It is a Lab-integrity failure regardless of who caused it: the Lab cannot account for an
effect it did not authorize.

**Residue probe.** The retained observation of the substrate taken *after* the last cleanup
dispatch, bound to the pre-action frontier it closes over. The verifier's only independent
evidence of what cleanup actually did.

---

## 4. The decision

### 4.1 One cleanup discipline, for every invalid environment terminal

ADR-ERL2-024 §4.5's eight rules apply to **every** invalid environment terminal, not only to
the restoration- and teardown-failure branch. `boundedEnvironmentCleanup` is removed, and
`invalidate` routes every phase through one executor.

The `emergency` boolean survives, and its meaning narrows to what it always should have
been: **which trigger the frontier records and which lifecycle states the terminal passes
through**, never which safety rules apply.

| Phase | Trigger | Lifecycle route | Cleanup discipline |
|---|---|---|---|
| `environment_restoration` | `restoration_failure` | `emergency_cleanup_started` → `emergency_cleanup_terminal` | per-action |
| `teardown` | `teardown_failure` | `emergency_cleanup_started` → `emergency_cleanup_terminal` | per-action |
| provisioning, baseline, planning, activation, observation | `invalid_environment_failure` | `invalid_cleanup_terminal` | **per-action** — changed |

`EmergencyCleanupVerificationV1.trigger` already carries `invalid_environment_failure`: the
contract was written for this case and the producer never used it. No schema changes.

**The cleanup variant keeps its meaning and is unchanged.** `emergency_environment` says
the terminal came through the emergency lifecycle route; `environment` and
`partial_environment` say it came through the bounded route with, respectively, no residue
and some. The variant describes *where the run was*; the evidence shape is now uniform
because the *rules* are uniform. Collapsing all three into `emergency_environment` was
rejected (§9).

### 4.2 No whole-environment dispatch without proven authorization

Every whole-environment destruction path is enumerated in §4.4 and each is either removed,
made conditional, or recorded as out of scope with a reason. The conditional rule is
ADR-ERL2-024 §4.5's, restated because it now governs more paths, and with two conditions
made explicit that were implicit before:

A whole-environment dispatch is permitted only when, **before** the call:

1. the pre-action frontier is frozen and retained;
2. every observed member of it derives an `independently_safe: true` action;
3. therefore no unsafe, shared, foreign or unknown member exists;
4. the driver offers no narrower granularity (`destroyResource` is absent) — a driver that
   *can* act per-resource must, so the aggregate is a fallback and never an optimisation;
5. one declared aggregate action set accounts for every affected target, and the single
   receipt is attributed to each;
6. the residue probe of §4.3 makes the affected set checkable offline.

Otherwise every affected action is recorded `failed` with
`EMERGENCY_ACTION_UNDECLARED_TARGET` and **no dispatch is made**. Condition 4 is new and it
matters: without it, a driver could offer `destroyResource` and the producer could still
choose the sledgehammer whenever the frontier happened to be all-safe, which makes the
narrow path untested in exactly the configuration where it is cheapest to skip.

**A frontier with zero derived actions dispatches nothing at all.** There is no resource to
destroy, so a `driver.destroy()` over it is an unauthorized aggregate with an empty
authorization — the very shape §4.2 exists to refuse. The terminal is reached with a residue
probe and no cleanup verification (`EmergencyCleanupVerificationV1.actions` has
`minItems: 1`, so the contract already refuses to describe a cleanup that did nothing).

### 4.3 The residue is observed independently and retained

`ERL2-C-158` / `cleanup-residue-probe/v1`, additive, on exactly the terms ADR-ERL2-026 used
for `restoration-probe/v1`.

The probe retains, for one cleanup:

| Field | Why |
|---|---|
| `run_id`, `substrate_binding_hash`, `environment_instance_hash` | whose substrate was observed |
| `resource_frontier_hash` | which pre-action frontier this closes over |
| `observed_before` | the frontier's own observed resource identities, restated so the probe stands alone and so a probe built over a *post*-destruction inventory is detectable |
| `observed_after` | the substrate as it is after the last dispatch — **the observation nothing retained before** |
| `authorized_targets` | the resource ids the derived safe actions authorized |
| `probe_status` | `observed`, or `unavailable` for a driver that cannot be re-inspected |
| `outcome` | derived from the three sets above, never supplied |
| `probed_at` | when |

Four outcomes, and the two that used to be the same silence are now different retained
values:

| outcome | meaning | terminal |
|---|---|---|
| `clean` | nothing observed after; every disappearance authorized | invalid, cleanup complete |
| `residual` | something remains, and every disappearance was authorized | invalid, cleanup incomplete |
| `undeclared_destruction` | something the Lab did not authorize is gone | invalid, **Lab-integrity failure** |
| `unobservable` | the driver cannot be re-inspected | invalid, cleanup unproven |

`undeclared_destruction` is the one that did not exist before and is the point of the
contract. It is the offline-detectable form of "destroy first, classify the survivors".

The probe is **mandatory on every invalid environment terminal that enumerated a frontier**,
including one whose frontier was empty — an empty frontier that probes back non-empty is
itself evidence, and refusing to record it would be the silence the contract exists to
break.

### 4.4 Every whole-environment destruction path, and its disposition

| Path | Call site | Disposition |
|---|---|---|
| bounded invalid cleanup | `boundedEnvironmentCleanup` | **removed**; replaced by §4.1 |
| emergency cleanup, no `destroyResource` | `emergencyCleanup` aggregate fallback | **kept, conditional** under §4.2, now with condition 4 |
| emergency cleanup, with `destroyResource` | per-action loop | unchanged |
| valid-path teardown | `EnvironmentRun.destroy` | **out of scope, deliberately** — see below |
| cancellation | routes into `invalidate` | inherits §4.1 |
| restoration failure / teardown failure | route into `invalidate` with `emergency: true` | unchanged discipline, now shared |

**Why the valid path's teardown is left alone.** `destroy()` is not a cleanup-after-failure;
it is the run's declared final operation over an environment it provisioned, whose declared
inventory it holds, and it is already followed by an independent residue re-inspection whose
result `buildTeardownVerification` refuses to over-claim. A foreign resource there is not a
cleanup hazard to be routed around — it is a contaminated environment, and the correct
answer is the failure it already produces, which routes to §4.1's emergency branch and gets
the per-action treatment there. Extending frontier authorization to it would replace a
working fail-closed with a second implementation of the same rule, and would change the
valid path's evidence for a defect the review did not find in it. Recorded as a decision
rather than left as an omission.

### 4.5 The invalid terminal's primary finding names the gate its failure falsifies

The branch-keyed `failedGateIds` of §1.4 is replaced by a total, deterministic map from the
**failure phase** to the gate that phase's evidence supports. The map is a constant, it is
exhaustive over the phase union, and the verifier holds the same one.

| Failure phase | Gate the failure falsifies | Why |
|---|---|---|
| `provisioning` | `mandatory-graph-closed` | provisioning failed, so the artifact graph the terminal owes cannot close |
| `baseline` | `environment-baseline-clean` | the baseline is what failed |
| `planning` | `selection-chain-closed` | planning is where the selection chain closes into an execution plan |
| `activation` | `environment-not-contaminated` | activation mutates the environment; a failed activation leaves it in an unproven state |
| `observation` | `evidence-cutoff-realized` | observation is what realizes the cutoff |
| `environment_restoration` | `restoration-verified` | unchanged |
| `teardown` | `teardown-verified` | was `restoration-verified`; restoration passed |

Three properties, each of which the verifier re-derives:

1. **The gate named is the one the phase falsifies.** A finding naming any other gate is
   `INVALID_REASON_PHASE_MISMATCH`.
2. **The owner is the Lab or its infrastructure, never the subject.** An invalid environment
   terminal is a statement about the Lab's own environment, and a subject cannot be scored
   for the Lab's failure to provision, restore or tear down. `owner: "lab"`,
   `subject_attribution_proven: false` and an empty `scoreable_planes` are already what the
   producer writes; §4.6 makes the verifier **require** them rather than observe them.
3. **The cleanup consequence never replaces the original cause.** The primary finding is
   frozen from the *detected* failure, before the frontier is enumerated and before any
   cleanup dispatch. A cleanup that then fails adds its own evidence — the residue probe's
   outcome, the failed action receipts — and changes neither the primary finding nor the
   failed phase.

### 4.6 The verifier derives cleanup for every invalid environment terminal

`deriveInvalidEnvironmentSemantics`'s early return on
`variant !== "emergency_environment"` is removed. For every invalid terminal whose lifecycle
shows an environment, the verifier independently derives, from retained bytes only:

| Concern | Derivation |
|---|---|
| pre-action frontier | `assertFrontierActionsDerivable` — actions must follow from the observed resources |
| expected safe actions | `safeActions(frontier)` — the producer's action list is the thing under test, never the source |
| expected unsafe skips | the complement, each with the frontier's own reason code |
| receipt cardinality | one receipt per attempted action; none for a skip; each receipt this run's, this binding's, and naming the derived target |
| action ordering | the frontier's own stable order, recomputed |
| aggregate authorization | an aggregate receipt is accepted only when every observed member derives safe |
| residue probe presence | mandatory whenever a frontier was frozen |
| `observed_before` ≡ frontier | a probe over a reconstructed inventory is refused |
| undeclared destruction | `observed_before \ observed_after` ⊆ attempted authorized targets |
| succeeded ⇒ gone | an action reported `succeeded` whose target is in `observed_after` is refused |
| unresolved ⇒ present | an action skipped or failed whose target is absent from `observed_after` vanished undeclared |
| `remaining_resources` | must equal the frontier members still in `observed_after` |
| the record's `cleanup.status` | `attempted_succeeded` only over an empty observed residue; it summarises the same evidence the probe holds, so the two may not disagree |
| probe `outcome` | recomputed from the probe's own observations |
| primary finding | its `failed_gate_ids` must be §4.5's map applied to the record's own `failed_phase` |
| finding attribution | `owner: "lab"`, `subject_attribution_proven: false`, no scoreable plane |
| terminal exclusivity | exactly one invalid record; no attestation; no public bundle |

Producer and verifier continue to share `assertFrontierActionsDerivable`, `safeActions`,
`assertOwnedByRun` and the residue-outcome arithmetic — definitions, not judgements, on the
terms ADR-ERL2-024 §7.2 and ADR-ERL2-026 §7 already set. Every verdict on the table above is
verifier-owned.

### 4.7 The fake driver gains a genuinely foreign resource

`FakeDriverFaults` gains `foreignResourceKinds`, which seeds the substrate with a resource
whose `run_scoped_name` does **not** embed the run id and whose `identity_hash` is computed
over that name. `assertOwnedByRun` fails for it, `driver.destroy` throws on it, and
`freezeResourceFrontier` derives `contain_residual` /
`RESOURCE_NOT_PROVABLY_OWNED_BY_RUN` for it.

This is not a convenience. §1.5 records that the only test claiming to prove "a foreign
resource does not abort the branch" uses a resource that is not foreign, so the invariant
has never been measured. Without this fault it cannot be, and the negative control for it
cannot be load-bearing.

The seeding is development-gated on the same terms as every other fault and reaches no
release surface.

---

## 5. Lifecycle ordering

No new lifecycle **state**, no new event type, no new terminal. The bounded route keeps
`invalid_environment_cleanup_started` → `invalid_cleanup_terminal`; the emergency route
keeps `emergency_cleanup_started` → `emergency_cleanup_terminal`. Both then reach
`invalid_lab_run_record_frozen` → `invalidated`.

The ordering **within** the cleanup transition is now the same on both routes, and it is the
brief's §10 order:

```
detect the failure
freeze its Lab-owned primary finding          <- before any frontier, any dispatch
assert the substrate binding
observe the inventory, freeze the frontier    <- pre-action, retained
derive the safe-action / unsafe-skip plan     <- from the frozen frontier
for each safe action, in the frontier's order:
    declare durable intent -> dispatch -> receipt -> settle
    (a throw is caught here; the next action still runs)
re-inspect the substrate
freeze the residue probe                      <- new
freeze the cleanup verification               (when >= 1 action)
append the cleanup terminal event
freeze exactly one invalid run record
append invalid_lab_run_record_frozen, invalidated
release reservations
```

Two orderings are load-bearing and are stated so they can be tested as orderings: the
primary finding is frozen **before** the frontier, so a cleanup consequence cannot become
the recorded cause; and the residue probe is frozen **before** the cleanup verification, so
the verification's `remaining_resources` is checkable against an observation that already
existed when it was written.

---

## 6. Artifact and contract changes

### 6.1 One new contract identity; no frozen schema changed in place

`ERL2-C-158` — `CleanupResidueProbeV1`, `cleanup-residue-probe/v1`, in `erl2:environment`.
Additive on exactly the terms ADR-ERL2-026 §6 used for `restoration-probe/v1`,
ADR-ERL2-024 §6.1 for `substrate-binding/v1` and ADR-ERL2-023 §2 for
`challenge-activation-receipt/v1`.

**No frozen schema changes shape or meaning.** No existing field is repurposed, no optional
field is added to a frozen schema, and no retained historical bytes are rewritten.
`EmergencyCleanupVerificationV1` is frozen and could not carry the observation — its
`remaining_resources` is a producer-derived summary, which is precisely why an independent
observation needs its own identity.

`EnvironmentDriver` gains **no** operation. The residue probe reads `inspect`, which is
already required and already read-only by contract.

### 6.2 Registry, generated types, goldens, roles

- registry entry `ERL2-C-158`;
- `packages/contracts/schemas/environment.schema.json` gains `CleanupResidueProbeV1`;
- `packages/contracts/generated/types.ts` regenerated by `npm run generate` — never
  hand-edited;
- valid and invalid fixtures for the new contract;
- `ENVIRONMENT_ROLES` gains `cleanup-residue-probe`, required whenever a frontier was frozen;
- goldens regenerated deliberately under `evidence:update`, with byte-pin coverage constants
  moved in the same commit.

### 6.3 Signer and authority ownership

| Artifact | Author | Signer role | Why not another |
|---|---|---|---|
| `cleanup-residue-probe/v1` | Lab, during cleanup | **unsigned** | It is an observation the Lab makes with its own eyes, retained inside a run root that is already Lab-owned trusted storage, and it is cited by the invalid record which is itself in the hash-chained closure. `restoration-probe/v1` is signed because it supports a *valid* attestation that leaves the Lab; an invalid record produces no attestation and no public bundle, so there is no external reader for a signature to serve. Signing it would add a key to a path that publishes nothing. |
| the emergency per-action receipt | driver | unsigned (`environment-operation-receipt/v1`) | Unchanged. The Lab derives success by re-observing, never from the receipt's claim (ADR-ERL2-023 §2a). |
| the invalid terminal's primary finding | Lab | unsigned (`finding/v1`, `LabInvalidityV1`) | Unchanged, and now verifier-enforced as Lab-owned (§4.5.2). |

---

## 7. Offline-verifier responsibilities

Listed in §4.6. Three constraints on *how*, carried forward from ADR-ERL2-024 §7 because
they apply unchanged:

1. **The derivations are verifier-owned**, live in `packages/public-verifier`, and are the
   only implementation. The producer injects them.
2. **Shared low-level machinery is allowed** — canonicalization, `coreHash`, contract
   validation, `assertOwnedByRun`, `assertFrontierActionsDerivable`, `safeActions`, and the
   residue-outcome arithmetic. Definitions, not judgements.
3. **A mutation must be rejected for the reason under test.** Every case in the suite is
   applied so the intended semantic check fires, not so an incidental hash or schema check
   fires first.

`erl2 verify-record --offline` returns valid only for a correctly closed invalid run, and
its closure report lists missing roles and rejected extras deterministically.

---

## 8. CLI behaviour and refusal codes

| Code | Raised when |
|---|---|
| `EMERGENCY_ACTION_UNDECLARED_TARGET` | an aggregate dispatch would affect a target the derived action set does not authorize (existing; now also reached from the bounded route) |
| `EMERGENCY_ACTION_SAFE_ACTION_SKIPPED` | a derived safe action has no attempt, or is reported with a safety label the frontier does not derive (existing) |
| `EMERGENCY_ACTION_RECEIPT_MISSING` | an attempted action has no receipt, a skip carries one, or a receipt names another run, binding or target (existing) |
| `RESIDUE_PROBE_MISSING` | **new** — an invalid environment terminal that froze a frontier retains no residue probe, or retains one that is about another run, substrate or frontier, or whose retained outcome is not the one its own observations derive |
| `RESIDUE_UNDECLARED_DESTRUCTION` | **new** — a resource in the pre-action frontier is absent afterwards and was never an authorized target |
| `EMERGENCY_CLEANUP_INCOMPLETE` | an action's reported outcome contradicts the post-cleanup observation: `succeeded` over a target still present, or `failed` over one that is gone (existing code, new reach) |
| `RESIDUE_DETECTED` | the cleanup verification's `remaining_resources` and the observed residue name different survivors (existing code, new reach) |
| `INVALID_REASON_PHASE_MISMATCH` | the primary finding names a gate that is not the one its failure phase falsifies (existing code, new reach) |
| `INVALID_REASON_FABRICATED_FINDING` | an invalid environment terminal's finding is not Lab-owned, claims subject attribution, or declares a scoreable plane (existing code, new reach) |

Both new codes were first written under a `CLEANUP_` prefix and both were refused
at construction: `Erl2Error` rejects a code whose prefix is not in the catalogued
Appendix B family list. Recorded because it is the guard working — a new code
cannot quietly invent a new refusal family — and because the `RESIDUE_` family is
where a reader looking for post-cleanup refusals will already be.

---

## 9. Rejected alternatives

| Alternative | Rejected because |
|---|---|
| Leave `boundedEnvironmentCleanup` as it is; the frontier is frozen first, so P1-1 is closed | P1-1 is not "enumerate before you destroy", it is "the record must describe the action taken". A frontier frozen and then ignored is a *stronger* form of the defect: the Lab now holds a written classification saying do-not-touch and destroys the resource anyway. |
| Route the bounded branch through `emergencyCleanup` and call every invalid terminal `emergency_environment` | The variant is load-bearing evidence about *where the run was*, it is in a frozen enum, and three goldens and the claim-scope derivation read it. Collapsing it would rewrite the meaning of retained bytes to avoid writing one shared executor. |
| Give the bounded branch per-action cleanup but keep it a separate function | Two implementations of one safety rule is how the branch came to have one implementation and one hole. The rule is the same rule. |
| Derive the residue from `driver.inspect` at verification time | The verifier is offline and holds no substrate. This is the whole reason the observation must be *retained*. |
| Let `remaining_resources` be the post-cleanup evidence | It is producer-derived from the producer's own action outcomes. A producer that reports every action succeeded produces an empty one, and nothing contradicts it. That is the defect, not the fix. |
| Detect undeclared destruction by re-deriving the frontier after cleanup | The post-cleanup inventory cannot distinguish "authorized and destroyed" from "destroyed without authorization" — the resource is absent in both. Only the *pre-action* frontier plus the authorized-target set can, which is why both are retained and bound together. |
| Sign the residue probe | An invalid terminal produces no attestation and no public bundle. A signature with no external reader adds a key to a path that publishes nothing. |
| Keep `failedGateIds` branch-keyed and document that the gate is indicative | A finding that names a gate the run never evaluated is a false statement in signed-adjacent evidence, and "indicative" is not a property the closed finding union has. |
| Use `shared_with_other_runs` as the foreign-resource test case | It is not foreign; `assertOwnedByRun` passes for it. §1.5. |
| Make `destroyResource` mandatory on `EnvironmentDriver` | It would break the fail-closed posture ADR-ERL2-024 §6.2 chose deliberately, and the conditional aggregate rule exists precisely so a driver without it is handled rather than excluded. |

---

## 10. Migration and backward compatibility

- **No frozen schema changed in place**, so every retained artifact from every earlier slice
  still parses, still hashes to the same value and still verifies.
- **Pre-environment terminals are untouched.** `derivePreEnvironmentClosure`,
  `verifyPreEnvironmentBundle` and the pre-environment cancellation path are unchanged and
  their goldens are byte-unchanged.
- **Valid environment terminals are untouched.** The valid path's teardown, restoration,
  validity gates and attestation are unchanged (§4.4), so a valid environment bundle
  produced before this change still verifies.
- **Invalid environment records produced before this change do not carry a residue probe and
  will not verify.** That is the intended consequence and it is not softened: an invalid
  record with no residue probe is exactly the artifact whose cleanup cannot be checked. The
  only such artifacts in the repository are the regenerated development goldens and the
  synthetic evidence fixtures, and there is no external consumer. A compatibility mode would
  re-open §1.6 behind a flag.

---

## 11. Security analysis

**What this closes.**

- A cleanup can no longer destroy a resource its own frontier classified as unsafe, on any
  branch.
- A foreign resource can no longer strand a run without a terminal, on any branch.
- A cleanup can no longer report an outcome that the substrate contradicts, because the
  substrate is now re-observed into a retained artifact and the two are compared offline.
- An empty residue is no longer unfalsifiable: a resource that vanished without an
  authorized action is a typed refusal.
- An invalid terminal can no longer name a gate from a phase it never reached, or attribute
  a Lab environment failure to the subject.

**What this does not close, and why that is the right boundary.**

- **The substrate is still the environment.** An adversary with write access to the
  substrate root can forge both the pre-action inventory and the post-cleanup one, and the
  probe would compare two forgeries. Unchanged from ADR-ERL2-024 §11 and correct: writing to
  the substrate *is* manipulating the environment. The probe's job is to prove the Lab's
  record agrees with what the Lab observed, and it does that.
- **`inspect` is the only observation channel.** A driver that under-reports its inventory
  under-reports it to the frontier and to the probe alike. The probe narrows the window in
  which a driver can lie *differently* at two moments, which is the class of lie a
  destroy-then-classify cleanup produced; it does not make a consistently lying driver
  detectable, and nothing retained by one process can.
- **The fake driver remains a fake driver.** The claims ceiling is unchanged.
- **P1-9, P1-10 and the P2/P3 cluster** are untouched and still open.

---

## 12. Relationship to the review findings

| Finding | Disposition here |
|---|---|
| **P1-1** destroy before frontier | **Closed on every branch.** §4.1 removes the last unconditional dispatch; §4.2 states the aggregate rule; §4.3 makes an unauthorized effect offline-detectable. ADR-ERL2-024 §4.5 closed the emergency branch and is unchanged. |
| **P1-3** failed gate cannot reach a terminal | **Closed.** ADR-ERL2-024 closed the `invalidityFindingHashes: []` half and the audit confirms it. §4.5 closes the half that reaches a terminal through `invalidate`: the finding names the gate its phase falsifies, is Lab-owned, and survives a failing cleanup. |
| **P1-5** foreign resource aborts cleanup | **Closed on every branch**, and — §4.7 — measurable for the first time, because the fake driver can now produce a resource that is actually foreign. |
| **P1-6** verifier accepts omitted/relabelled safe actions | **Closed on every branch.** §4.6 removes the emergency-only early return and adds the residue derivations. |
| P1-9 post-capture intents before activation | **Open.** |
| P1-10 refused `journey` freezes a cutoff policy with no lifecycle event | **Open.** |
| P2 cluster beyond the two items §4.5 closes (`the invalid terminal's primary finding naming a gate from the cleanup branch`; `Lab attribution unenforced on an invalid environment terminal`) | **Open**, itemised in the ledger. |
| P3 documentation drift | **Partially addressed** — the ADR registry and requirements ledger are brought current. |

---

## 13. Acceptance tests and negative controls

**Acceptance.**

- frontier derivation: empty, one owned, many owned, dependency order, shared, foreign,
  mixed, unknown ownership, duplicate identity, wildcard selector, wrong run, wrong
  substrate, no cleanup capability.
- safe-action execution: all succeed; first fails and a later one still runs; a middle one
  fails and a later one still runs; all fail; the driver throws before returning a receipt;
  an unsafe resource receives no call; a foreign resource does not block an owned one.
  Measured by **counting driver invocations**, not retained artifacts.
- whole-environment destruction: an adversarial driver records every destruction target;
  no unconditional dispatch before authorization; a mixed frontier cannot invoke the
  aggregate; an undeclared extra target refuses; post-destroy emptiness cannot conceal it.
- findings: one failed gate → one Lab-owned finding; the phase→gate map, total; a finding
  for a passing gate; a duplicate; a wrong phase; subject attribution; a cleanup failure
  that does not replace the original cause.
- invalid terminals, through the shipped CLI: partial provision, contaminated baseline,
  restoration failure, teardown failure, residue, mixed foreign/owned frontier — each
  reaching exactly one invalid record that verifies offline, with no attestation and no
  bundle.
- verifier mutations: one semantic concern at a time from a real CLI-produced record, each
  rejected for its intended typed reason.

**Negative controls.** One per invariant, each required to make at least one **named** test
fail: pre-action frontier enumeration, no unconditional whole-environment destroy, continue
after an individual action failure, safe-action completeness, receipt cardinality, the
unsafe-skip reason/no-receipt rule, invalidity-finding derivation, verifier safe-set
rederivation, the residue probe, undeclared-destruction detection, and exactly-one invalid
terminal. A control that kills nothing is reported as a non-load-bearing invariant, never
quietly re-scored — the discipline `docs/ledger/remediation-6.5B.md` §10a established and
`remediation-6.5-invariants.md` §8 exercised.

---

## 14. Rollback boundary

Reverting this ADR's implementation restores a tree in which five of the seven invalid
environment failure phases destroy the whole environment without consulting the frontier
they froze, a foreign resource strands the run with no terminal, and an empty residue is
unfalsifiable offline. That is a **known integrity failure**, so the rollback is not a
supported operating posture; it exists as a bisect target.

The rollback is mechanically clean: one new contract identity, no frozen schema change, no
lifecycle state added, no retained bytes rewritten.

---

## 15. Consequences

- One new contract (`ERL2-C-158`), one new closure role, two new refusal codes. No frozen
  schema changed shape or meaning. No new signer key.
- `boundedEnvironmentCleanup` is deleted; one executor serves every invalid environment
  terminal.
- `FakeDriverFaults` gains `foreignResourceKinds`, development-gated.
- Every golden containing an invalid environment terminal is regenerated; the byte-pin
  coverage constants move in the same commit.
- Invalid environment records produced before this change no longer verify. Intended (§10).
- ERL2-OQ-005, ERL2-OQ-007 and ERL2-OQ-008 are unchanged and still fail-closed. This ADR
  does not touch the evaluated domain plane and does not widen the claims ceiling: it
  removes false claims, it does not add true ones. **The ceiling stays T1.**
