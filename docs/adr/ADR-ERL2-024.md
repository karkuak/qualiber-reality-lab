# ADR-ERL2-024 — run identity, substrate binding, durable mutation intent, branch cancellation, and verifier-derived cleanup

**Status:** accepted
**Date:** 2026-07-28
**Deciders:** Lab Core Owner, Integrity/Security Owner, Environment/Challenge Governor, Verifier Reviewer
**Extends:** ADR-ERL2-019 (§2 a retained signed contract with no declared signer role is a
refusal; §4 a phase validates its departure state before any dispatch), ADR-ERL2-020 §6
(one durable transition at a time), ADR-ERL2-021 (environment signer roles, the durable
phase model, and the file-backed fake substrate), ADR-ERL2-022 (the environment terminal
and the frontier-derived invalid terminal), ADR-ERL2-023 (the signed controller receipt).
Nothing is superseded. ADR-ERL2-021 §5's statement that "`EnvironmentDriver` gains no
operation" is **amended** by §6.2 below.
**Normative source:** `external-reality-lab-design-v2.md` `2.0.0-draft.11` §8, §9, §12,
§14, §16.2, §16.3, §20, §22; `external-reality-lab-implementation-plan.md` §9, §12;
ERL2-FR-001/011/020/025/026/031/033, ERL2-AC-023/031/035.
**Evidence of defect:** `Independent-Code-Review-Slice-6.5B.md` (2026-07-28), findings
P0-1, P1-1, P1-2, P1-3, P1-4, P1-5, P1-6, P1-7, P1-8, P1-11, P1-12 and the related P2
cluster.

---

## 1. Context

Slice 6.5-B/C/D/E made the environment branch reach a signed terminal. An independent
review then showed that the branch's *integrity* rests on four assumptions the code never
established, and that the offline verifier re-derives the wrong things.

Four concrete failures, each reproduced against the shipped binary.

### 1.1 A valid attestation over an environment that was never torn down (P0-1)

`--substrate-root` is declared in `ENVIRONMENT_FLAGS` with no development gate and no
binding. `substrateRoot()` returns the caller's value or `<run-root>.substrate`, and a
repository-wide search finds the value in exactly two CLI sites: it reaches **no**
contract, **no** receipt and **no** attestation field.

```
# provision, baseline, plan, … against substrate A
erl2 provision --run R --run-root ./run  …
…
# tear down against a fresh empty directory
erl2 restore  --run R --run-root ./run --substrate-root ./empty
erl2 destroy  --run R --run-root ./run --substrate-root ./empty
erl2 finalize-generic --run R --run-root ./run --substrate-root ./empty
erl2 verify --public-bundle ./run/retained/public-bundle.json … --offline   # exit 0, valid
```

The driver observes an empty substrate, records a clean restoration and a clean teardown,
and the finalizer's own independent residue re-inspection (`driver.inspect`) also observes
nothing — because it is inspecting the wrong substrate. Substrate A remains fully
allocated. No retained artifact names the substrate that was observed, so an offline
verifier **cannot** detect the substitution. This is the definition of a false valid
attestation.

### 1.2 The Lab's own bookkeeping can be pointed at another run (P1-8)

`openWorkspace(flags, runId)` reads `--run` and `--run-root` independently and never
cross-validates them. `erl2 observe --run <any-uuid> --run-root <another run's root>`
acquires that root's lease, resolves that root's evidence and appends to that root's
lifecycle under a claimed identity that is not the run's. The defect lives in shared
pre-existing CLI code and therefore applies to Slice 6.5-A and to `main`.

### 1.3 External effects precede any durable record of intent (P1-7, P1-4)

`runStep` calls `this.ws.subject.step(...)` at `environmentRun.ts:703` and `activate`
calls `this.driver.mutate(...)` at `:782`, in both cases before anything durable says the
call is about to happen. A crash between the external call and the lifecycle append leaves
a run whose evidence says the step never ran. The next process re-dispatches. Proven by
instrumented invocation counting, not by counting artifacts — artifact deduplication hides
the second call rather than preventing it.

The same absence lets a compensation that provably reverted nothing be accepted:
restoration checks the receipt's own `status` and the before/after baselines, but nothing
records what the compensation was *supposed* to revert, so "reverted nothing" and "had
nothing to revert" are indistinguishable.

### 1.4 Cleanup destroys first and classifies afterwards (P1-1, P1-5, P1-2, P1-6)

`emergencyCleanup` issues an unconditional whole-environment `driver.destroy()` **before**
consulting the frontier it just froze, then reports every frontier-unsafe resource as
`skipped_unsafe` — a claim the action already contradicted. A foreign resource in the
frontier makes that single destroy throw, which aborts the whole branch: zero safe actions
attempted, no terminal reached, leases retained. And `erl2 cancel` is not branch-dispatched
at all, so cancelling a live environment run freezes a **pre-environment** cleanup terminal
claiming `not_required` while the environment and its reservation leases are still
allocated — which the shipped verifier accepts.

### 1.5 The verifier believes the producer (P1-11, P2 cluster)

`verifyEnvironmentBundle` checks `attestation.lab_validity !== "valid"`, but `lab_validity`
is a schema constant (`environmentFinalize.ts:395`, `lab_validity: "valid" as const`), so
the check is tautological for any well-formed attestation. The retained `validity-result`'s
own verdict, and the `passed` fields of `environment-restoration` and
`teardown-verification`, are hash-linked and role-required but **never inspected**. A
terminal whose validity says `invalid` with failed gates, and whose cleanup verdicts are
`passed: false`, verifies as `valid`.

---

## 2. Scope and non-goals

### In scope

The invariant foundation of the environment branch: run/workspace identity, substrate
binding, durable mutation intent and restart reconciliation, branch-specific cancellation,
frontier-driven emergency cleanup, and verifier-owned derivation of validity, restoration,
teardown and emergency cleanup.

### Explicit non-goals

- The evaluated domain plane (ERL2-OQ-008 and a subject emitting a revealed functional
  truth). Untouched.
- The Compose driver (ERL2-OQ-005) and container-backed launchers. Untouched and still
  fail-closed.
- Held-out and blind execution (ERL2-OQ-007). Untouched and still fail-closed.
- Every P2/P3 finding in the review that is not named in §14. They remain open and are
  listed there as such, and in `docs/ledger/remediation-6.5-invariants.md` §6.
- This ADR settles and implements the invariant foundation. It does **not** claim the
  independent review is remediated.

---

## 3. Definitions

**Run identity.** The UUID a run is durably accepted under. It is fixed at the first
durable lifecycle transition and never changes.

**Workspace identity.** The run identity **as recorded by the workspace itself**: the
`run_id` field of the workspace's first lifecycle event, `<run-root>/events/000000.json`.
The lifecycle stream is hash-chained, so this value cannot be edited without breaking the
chain every later command verifies. The derived `state/snapshot.json` also carries a
`run_id`, but it is a cache and is authoritative for nothing (§11.9); it is cross-checked,
never trusted.

**Substrate identity.** The canonical, locator-free identity of the substrate instance a
run's environment lives in: `substrate_instance_hash`. It is established **inside the
substrate** the first time a run provisions into it and read back by every later process.
A substrate that carries no such marker has no identity and can never satisfy a binding.

**Operational locator.** The local, deployment-specific handle used to reach the substrate
— for the file-backed fake substrate, an absolute directory path. It is **private**: it is
never a public identity, never signed, and never retained as evidence.

**Substrate binding.** The signed, retained `SubstrateBindingV1` (ERL2-C-156) that ties one
run identity to exactly one substrate identity, under one driver, one archetype and one
reservation namespace.

**Mutation intent.** A durable, run-private record written **before** an externally visible
call, naming the operation, its idempotency key, the canonical request it will make, the
before-state it observed, the probe that answers "did this already happen", and the
compensation or invalidation route if it cannot be answered.

**Reconciliation.** The act, on restart, of answering a declared-but-unsettled intent's
probe against **observed external state** and choosing exactly one of: adopt an
independently verified prior result; resume an explicitly idempotent operation under the
same idempotency key; perform the committed compensation; enter a typed invalid terminal.

**Resource frontier.** `EnvironmentResourceFrontierV1`: what the driver *observes*, plus
the action set the **Lab** derives from it. The driver supplies observations; it never
supplies actions.

**Independently safe action.** A frontier-derived action whose target is provably this
run's (`assertOwnedByRun`), is marked destroyable by the driver, and is not shared with
another run. Anything else is `contain_residual`, unsafe, with a reason.

**Cleanup derivation.** Recomputation, by the offline verifier and from retained bytes
alone, of the expected safe-action set, of restoration and teardown outcomes, and of
whether the retained results are consistent with them.

---

## 4. The invariant decisions

### 4.1 A run is permanently bound to the workspace that records it

Every command that **opens an existing workspace** derives the workspace identity from the
run root's first lifecycle event and refuses when `--run` disagrees.

The refusal is `POLICY_RUN_IDENTITY_MISMATCH`, and it happens **before** the run lease is
acquired or modified, before any substrate or reservation directory is created, before any
evidence is frozen, before any driver, subject port or adapter is constructed, and before
any lifecycle append. The check is performed in two places, deliberately:

1. `runCommand` in the CLI, ahead of `withRunLease`, so the lease is never touched; and
2. the `RunWorkspace` constructor, so a **library caller** that never goes through the CLI
   is refused on the same terms.

**Bootstrap.** A run root with no lifecycle event has no workspace identity yet.
`preregister-acquisition` is the only command that legitimately creates one, and it is the
only command exempted — it allocates a fresh run id when `--run` is absent, and when
`--run` is supplied it becomes the workspace identity by writing it. Every other command
opens an existing workspace and validates.

**Directory names are never identity.** A run root's basename is caller-chosen and unsigned.
The identity comes from the hash-chained event stream, and from nothing else.

### 4.2 A run is permanently bound to one substrate identity

At `provision`, before the first substrate-affecting dispatch, the run freezes a signed
`SubstrateBindingV1` and records its operational locator privately. Every later
environment phase re-derives the substrate identity from the substrate it is actually
about to talk to and refuses if it is not the bound one.

The binding carries exactly what a reader needs to check the binding and nothing that
would leak or fix a deployment detail:

| Field | Why |
|---|---|
| `run_id` | which run |
| `driver_id`, `driver_manifest_hash` | which driver, at which manifest |
| `archetype_hash` | which environment shape |
| `substrate_kind` | which substrate mechanism (`file-substrate-store`, later `compose-project`, …) |
| `substrate_instance_hash` | **the canonical substrate identity** |
| `reservation_namespace_hash` | which allocator namespace holds this run's leases |
| `substrate_lock_hash` (optional) | the qualified substrate lock, when one governs the substrate |
| `bound_at` | when |

**The locator is excluded from the public binding.** Options considered: public path,
hashed path, normalized path, excluded. Excluded wins. A path is deployment-local, is not
stable across hosts, and would bake an absolute filesystem path into signed public evidence
— the exact class of leak the byte-pin already has to exclude four files for. A *hashed*
path would be worse than useless: it is unverifiable by an offline reader (who has no path
to hash) while still being a covert channel. The public identity is the substrate instance
hash; the locator lives in `state/substrate-locator.json`, alongside the run lease and the
snapshot cache, in a subtree the artifact index, the closure derivation and the retained
file accounting all exclude by construction.

**How a fresh process resolves the locator without allowing substitution.** It reads
`state/substrate-locator.json`, which the run wrote at binding time. It does **not** read a
flag. `--substrate-root` and `--reservation-root` become development-only, refused on the
release surface with `CFG_DEVELOPMENT_FLAG_UNAVAILABLE`, and even under the development
profile they may only *establish* a locator — a flag that disagrees with an existing
private locator record is `ENV_SUBSTRATE_LOCATOR_CONFLICT`.

**What makes substitution detectable.** `substrate_instance_hash` is written into the
substrate at establishment and read back thereafter. A fresh empty substrate B carries no
marker: `driver.substrateInstance()` reports `undefined`, and the phase refuses with
`ENV_SUBSTRATE_BINDING_MISSING` before any cleanup evidence can freeze. A substrate that
carries a *different* marker refuses with `ENV_SUBSTRATE_BINDING_MISMATCH`. A run whose
lifecycle says it provisioned but whose substrate reports "never provisioned for this run"
refuses with `ENV_SUBSTRATE_NOT_PROVISIONED` — which also closes P1-12, because the
substrate loader now distinguishes "absent" from "unreadable" instead of returning
"never provisioned" for both.

**Change of any bound identity refuses.**

| What changed | Refusal |
|---|---|
| substrate directory (locator) | `ENV_SUBSTRATE_LOCATOR_CONFLICT` |
| substrate instance marker absent | `ENV_SUBSTRATE_BINDING_MISSING` |
| substrate instance marker different | `ENV_SUBSTRATE_BINDING_MISMATCH` |
| driver id or driver manifest | `ENV_SUBSTRATE_BINDING_MISMATCH` |
| archetype | `ENV_SUBSTRATE_BINDING_MISMATCH` |
| reservation namespace | `ENV_SUBSTRATE_BINDING_MISMATCH` |
| substrate present, run not provisioned in it | `ENV_SUBSTRATE_NOT_PROVISIONED` |
| retained binding bytes edited | `ARTIFACT_HASH_MISMATCH`, then the signature |

### 4.3 Every external mutation is preceded by a durable intent

The audit of externally visible mutations on the environment branch, and what each one
declares:

| Mutation | Operation id | Idempotency key | Reconciliation probe | Retry rule |
|---|---|---|---|---|
| environment provision | `op-provision` | run + operation id | the driver's operation log | idempotent by key |
| challenge activation mutate | `op-activate` | run + operation id | the driver's operation log | idempotent by key |
| subject step | `op-step-<n>` | step commitment hash | *none available* — the subject port is external and opaque | **fail closed** |
| compensation / restore | `op-restore` | run + operation id | the driver's operation log | idempotent by key |
| teardown destroy | `op-destroy` | run + operation id | the driver's operation log | idempotent by key |
| emergency action | `op-emergency-<action-id>` | run + operation id | the driver's operation log | idempotent by key |

**The probe is the driver's own operation log.** `SubstrateState.operations` records the
receipt of every operation the driver completed, keyed by operation id, and
`EnvironmentDriver.completedOperation` reads it. That is what makes reconciliation able to
*adopt* an independently verified prior result instead of re-dispatching or failing closed;
a real driver has the same thing under a different name (a labelled Compose project, a
namespace annotation). A driver that cannot offer one is not broken — its unsettled
operations simply fail closed, which is the correct posture rather than a gap to work
around by assuming idempotence.

Three operations are audited and found to need **no** journal entry, and the reasons are
recorded here rather than left implied:

- **`probe` and `inspect` are read-only by contract.** `probe` returns a fingerprint and
  `inspect` returns an inventory; neither mutates. They are observations, and an intent
  before an observation would record nothing.
- **Reservation acquire and release are already exactly-once by construction.** The lease
  file *is* the durable record: `acquire` creates it with `openSync(…, "wx")` — an atomic
  create — and returns the existing lease unchanged when this run already holds it;
  `release` is a no-op when the file is absent and refuses another run's lease. A journal
  entry would be a second, weaker copy of a record that is already atomic and durable.

Intent records are **run-private**, under `state/intents/`. They are Lab bookkeeping about
a dispatch, not evidence about a result: making them contracts would put a record of an
operation that may never have happened into the closure, and would require a lifecycle
state per mutation. The results those mutations produce are already contracts, already
role-produced, already in the closure. The intent journal is what makes the *result*
trustworthy; it is not a second result.

**The ordering is: declare → dispatch-marked → call → outcome → freeze → lifecycle append →
settle.** A crash at any point leaves an intent whose state names exactly how far the run
got, and the next process reconciles before it retries anything.

**A subject step is not blindly retried.** There is no probe that can ask an opaque subject
whether it already ran a step. An intent left in `dispatching`/`dispatched` for a subject
step is therefore *ambiguous*, and ambiguity fails closed: the run refuses with
`ENV_MUTATION_INTENT_AMBIGUOUS` and its authorized route is the invalid terminal. Choosing
"just run it again" would be choosing to double-install against a real subject to keep a
happy path green.

### 4.4 Cancellation is routed from the branch and state it is actually in

`erl2 cancel` becomes branch-dispatched, on the same terms as `freeze-output`, `reveal`,
`evaluate` and `finalize-generic`: the **run's own durable evidence** decides the variant,
never a flag. The discriminator is the substrate binding — a run that has one has, or may
have, external resources.

| Cancelled from | Route | Cleanup variant |
|---|---|---|
| before `provision` (no binding) | pre-environment | `none` / `pre_environment` |
| during provisioning (binding, no inventory) | environment, frontier-derived | `environment` / `partial_environment` |
| environment live (provisioned … `generic_precleanup_results_complete`) | environment, frontier-derived | `environment` / `partial_environment` |
| during journey execution | environment, frontier-derived | `environment` / `partial_environment` |
| after restoration begins (`lab_cleanup_started`, `environment_restored`) | **emergency** | `emergency_environment` |
| during teardown (`teardown_started`) | **emergency** | `emergency_environment` |
| during emergency cleanup | **emergency**, resumed | `emergency_environment` |
| replay of a completed cancellation | returns the same record, writes nothing | unchanged |
| after any terminal | `CANCELLATION_AFTER_TERMINAL` | — |

**A live environment never receives `not_required`.** The variant is derived from the
frontier the Lab observed, and a run with a substrate binding always enumerates one.

Cancellation freezes its signed `CancellationRequestV1` **before** any external cleanup
call, which is the durable cancellation intent §4.3 requires. Reservations are released
only after cleanup is proven, exactly as on the valid path.

### 4.5 Emergency cleanup is derived from the frontier, action by action

The unconditional pre-frontier `driver.destroy()` is removed.

For every frontier member, in the frontier's own stable order:

1. ownership and safety are classified independently (`assertOwnedByRun`, `destroyable`,
   `shared_with_other_runs`) — the driver's opinion is not consulted;
2. every independently safe action is **attempted**, individually;
3. every attempt retains exactly one receipt, success or failure;
4. success is derived by **re-observing** the target after the attempt, never from what the
   driver's receipt claimed;
5. a failure retains its receipt *and* a reason, and does not stop the remaining
   independent actions;
6. every unsafe skip retains its frontier-derived reason and **no** receipt;
7. the frontier is re-probed afterwards and the residue retained with an explicit
   containment status;
8. an incomplete cleanup still reaches the invalid terminal — `attempted_failed` is a
   result, not a reason to strand the run.

**Foreign resources never prevent safe actions on owned resources.** Each action is
attempted inside its own failure boundary.

**Whole-environment destruction is conditional.** A driver whose only destructive
granularity is the whole environment may be invoked only when the derived action set proves
that *every* observed frontier member is an authorized target — i.e. there is no unsafe
member — and the resulting receipt is then attributed to every action it covered.
Otherwise it is refused with `EMERGENCY_ACTION_UNDECLARED_TARGET` and the affected actions
are recorded as failed with that reason. The fake driver gains per-resource destruction so
that this is the exception rather than the rule.

### 4.6 The verifier derives; it does not read the producer's verdict

The offline verifier gains verifier-owned derivations and stops trusting five things it
currently trusts: `attestation.lab_validity`, `EnvironmentValidityResultV1.status`,
`EnvironmentRestorationVerificationV1.passed`, `TeardownVerificationV1.passed`, and the
producer's emergency safe/unsafe classification.

Rederived and cross-checked, from retained bytes and the hash-chained lifecycle only:

| Concern | Derivation |
|---|---|
| run identity | lifecycle `run_id` ≡ record ≡ attestation ≡ closure report |
| substrate binding | exactly one; its driver, archetype and run bind to the retained ones |
| driver / archetype binding | binding vs retained `environment-driver-manifest/v1`, `environment-archetype/v1` |
| lifecycle reachability | unchanged (`deriveEnvironmentClosure`) |
| terminal variant and stage | unchanged (`deriveTerminalVariant`, `deriveEnvironmentTerminalStage`) |
| Lab validity gates | recomputed from lifecycle order and retained evidence; every gate the verifier derives as failed must be failed in the retained result |
| invalidity findings | a failed gate must have a retained finding naming it; a `valid` status with any failed gate is refused |
| restoration | recomputed from `baseline_before_hash`/`baseline_after_hash`, `residual_resources`, and the cited compensation receipts' own statuses |
| teardown | recomputed from the checks' residue counts and selector narrowness |
| emergency expected action set | `assertFrontierActionsDerivable` + `safeActions` |
| safe-attempt completeness | every derived safe action has a `succeeded`/`failed` entry with a receipt |
| unsafe-skip validity | every `skipped_unsafe` entry corresponds to a frontier action the verifier *also* derives as unsafe, with the same reason and no receipt |
| post-cleanup residue | every unresolved action's target appears in `remaining_resources` |
| cancellation cleanup applicability | a cancellation terminal on a run with a substrate binding may not claim `none`/`not_required` |
| attestation ↔ record ↔ index ↔ inventory | every attestation binding cross-checked against the derived closure |
| required signed receipts | `challenge-activation-receipt` and `mutation-receipt` become closure-required as soon as the lifecycle shows `challenge_activated` — before this, a terminal that activated and then dropped the controller's receipt still verified valid, because the schema was only in the supporting set; `substrate-binding` is always required on the environment branch |

**Producer and verifier share hashing and schema validation, and nothing else.** The
finalizer already injects the verifier's own closure algorithm (ADR-ERL2-022 §1); it now
also injects the verifier's validity, restoration, teardown and emergency derivations, so
`assertEnvironmentFinalizable` refuses a terminal the verifier would reject. The semantic
derivations live in `packages/public-verifier` and are exercised independently by the
mutation suite, which starts from a real CLI-produced bundle and mutates one concern at a
time.

---

## 5. Lifecycle ordering and allowed transitions

No new lifecycle **state** is introduced. The environment phase table gains no row, and the
state machine stays acyclic with the same terminals.

What changes is what a phase does *within* its single durable transition:

```
provision:
    validate departure state
    validate run/workspace identity            (already done at open)
    resolve or establish operational locator   (private)
    resolve or establish substrate identity    (in the substrate)
    freeze SubstrateBindingV1                  <- new, before any dispatch
    declare reservation intents  -> acquire leases -> settle
    declare provision intent     -> driver.provision -> settle
    freeze inventory, receipt, mirrors
    append `environment_provisioned` (produced: … + `substrate-binding`)

every later environment phase:
    validate departure state
    assert substrate binding                   <- new, before any dispatch
    declare intent -> dispatch -> settle       <- new
    freeze -> append
```

Cancellation on the environment branch reuses the transitions ADR-ERL2-022 §2 already
authorized:

```
<any non-terminal environment state>
  -> invalid_failure_detected                    (event `environment_cancellation_requested`)
  -> invalid_environment_cleanup_started
  -> [ emergency_cleanup_started -> emergency_cleanup_terminal ]   (restore/teardown/emergency origin)
     [ invalid_cleanup_terminal ]                                  (otherwise)
  -> invalid_lab_run_record_frozen
  -> invalidated
```

Terminal closure remains reachable from every state named in §4.4, and both the valid and
the invalid environment terminals remain reachable.

---

## 6. Artifact and contract changes

### 6.1 One new contract identity; no frozen schema changed in place

`ERL2-C-156` — `SubstrateBindingV1`, `substrate-binding/v1`, in `erl2:environment`.
Additive, on exactly the terms ADR-ERL2-023 §2 used for `challenge-activation-receipt/v1`
and ADR-ERL2-018 used for `cancellation-request/v1`: **no existing schema changes shape or
meaning**, no existing field is repurposed, no optional field is added to a frozen schema,
and no retained historical bytes are rewritten. The signer role it uses
(`environment_governor`) is already in the frozen `trust-policy-manifest/v2` `SignerRole`
enum, and the development trust policy already grants it.

Everything else this ADR needs is either derivable from bytes that already exist, or
private run state that is not a contract:

- **Workspace identity** — derived from `lab-lifecycle-event/v1.run_id`, which is already
  frozen, already hash-chained, and already retained. No artifact was needed and none was
  invented.
- **Operational locator** — `state/substrate-locator.json`, private, no `schema_version`,
  no `core_hash`, in the subtree the index skips.
- **Mutation intents** — `state/intents/<operation-id>.json`, private, same terms.
- **Emergency per-action receipts** — existing `environment-operation-receipt/v1`, one per
  attempted action, exactly as the `invalid-run-emergency-cleanup` golden already models.

### 6.2 `EnvironmentDriver` gains four operations

ADR-ERL2-021 §5 recorded that the substrate seam was added *without* extending the driver
interface. That is no longer sufficient: §4.2 requires an identity "unambiguous for the
driver and substrate instance actually observed", which only the driver can report, and
§4.5 requires per-resource destruction to exist as a first-class capability rather than as
a whole-environment sledgehammer.

```ts
interface EnvironmentDriver {
  …
  /** The identity of the substrate this driver instance is operating against. */
  substrateInstance(): SubstrateInstance | undefined;
  /** Establishes that identity. Called once, by `provision`. */
  establishSubstrateInstance(runId: string): SubstrateInstance;
  /** The driver's own operation log — the reconciliation probe of §4.3. Optional. */
  completedOperation?(runId: string, operationId: string): EnvironmentOperationReceiptV1 | undefined;
  /** Destroys exactly one owned resource. Optional: a driver without it declares so. */
  destroyResource?(request: DestroyResourceRequest): EnvironmentOperationReceiptV1;
}
```

The two required methods carry the substrate identity; the two optional ones are
*capabilities*, and their absence has a defined, fail-closed consequence rather than a
silent one — no operation log means unsettled operations fail closed, and no per-resource
destruction means the conditional whole-environment rule of §4.5 applies.

`EnvironmentDriverManifestV1.supported_operations` is a **frozen enum** and is not
extended. Per-resource destruction is therefore signalled by the presence of the optional
method, and its absence is handled by §4.5's conditional whole-environment rule — which is
why that rule exists rather than being a footnote.

### 6.3 Registry, generated types, goldens, roles

- registry entry `ERL2-C-156`;
- `packages/contracts/schemas/environment.schema.json` gains `SubstrateBindingV1`;
- `packages/contracts/generated/types.ts` regenerated by `npm run generate` — never
  hand-edited;
- valid and invalid fixtures for the new contract;
- `SIGNED_MEMBER_RULES` gains `substrate-binding/v1 → environment_governor`;
- `ENVIRONMENT_ROLES` gains `substrate-binding`; `challenge-activation-receipt` and
  `mutation-receipt` become conditionally required (see §4.6);
- the environment signer inventory covers the binding;
- goldens regenerated deliberately under `evidence:update`, with the byte-pin coverage
  constants updated in the same commit.

### 6.4 Signer and authority ownership

| Artifact | Author | Signer role | Why not another |
|---|---|---|---|
| `substrate-binding/v1` | Lab, at `provision` | `environment_governor` | The governor is the authority that provisions the environment; recording *which* substrate it provisioned into is part of that act. The `controller` decides a challenge goes live (ADR-ERL2-023) and must not also vouch for where the environment is. The **driver** never signs it: a driver is untrusted infrastructure, and letting it attest its own substrate identity would make the binding a statement by the thing being bound. |
| `state/substrate-locator.json` | Lab, run-private | none — not evidence | A locator is deployment configuration, not a claim. Signing it would publish an absolute host path as attested fact. |
| `state/intents/*.json` | Lab, run-private | none — not evidence | An intent records that a call is about to be made. It is not a result and must never be readable as one. |
| emergency per-action receipt | driver | unsigned (`environment-operation-receipt/v1`) | Unchanged, and deliberately: the Lab derives the action's success by re-observing the substrate, not from the receipt's claim (ADR-ERL2-023 §2a's direction of trust). |

---

## 7. Offline-verifier responsibilities

Listed in §4.6. Three constraints on *how*:

1. **The derivations are verifier-owned.** They live in `packages/public-verifier` and are
   the only implementation. The finalizer injects them; it does not reimplement them. Two
   implementations agreeing proves the implementations agree, not that the run is sound.
2. **Shared low-level machinery is allowed.** JCS canonicalization, `coreHash`, contract
   validation and `assertOwnedByRun`/`assertNarrowSelector` are shared by design: they are
   definitions, not judgements. The *semantic* derivation is not shared.
3. **A mutation must be rejected for the reason under test.** Every mutation case in the
   suite is applied so that the intended semantic check fires, not so that an unrelated
   content-hash or schema check fires first — the discipline ADR-ERL2-022's consequences
   already established for the §15.4 mutations.

Pre-environment verification is unchanged, and V1 readability is unchanged: no frozen
schema moved, so every previously verifiable bundle and record still verifies.

---

## 8. CLI behaviour and refusal codes

| Code | Raised when |
|---|---|
| `POLICY_RUN_IDENTITY_MISMATCH` | `--run` disagrees with the workspace's own recorded run identity |
| `CFG_DEVELOPMENT_FLAG_UNAVAILABLE` | `--substrate-root` / `--reservation-root` without `ERL2_DEVELOPMENT_FAKE_SUBJECT=1` |
| `ENV_SUBSTRATE_LOCATOR_CONFLICT` | a locator flag disagrees with the run's own private locator record |
| `ENV_SUBSTRATE_BINDING_MISSING` | a bound run reaches a substrate that carries no instance identity |
| `ENV_SUBSTRATE_BINDING_MISMATCH` | substrate instance, driver, archetype or reservation namespace differs from the binding |
| `ENV_SUBSTRATE_NOT_PROVISIONED` | the lifecycle says provisioned, the substrate says the run was never provisioned in it |
| `ENV_SUBSTRATE_UNREADABLE` | the substrate exists but could not be read — no longer silently "never provisioned" |
| `ENV_MUTATION_INTENT_MISSING` | a dispatch was reached with no durable intent (a Lab defect; fails closed) |
| `ENV_MUTATION_INTENT_AMBIGUOUS` | a non-idempotent operation's intent is unsettled and its outcome cannot be observed |
| `EMERGENCY_ACTION_UNDECLARED_TARGET` | whole-environment destruction would affect a target the derived action set does not authorize |

Every refusal is typed, deterministic, and — for the identity and binding classes — occurs
before any lease, evidence, substrate or reservation side effect.

---

## 9. Crash and restart behaviour

For each external mutation, five injection points are exercised: before intent freeze;
after intent freeze but before dispatch; after dispatch but before receipt freeze; after
receipt freeze but before lifecycle append; after lifecycle append but before snapshot
update.

| Crash at | Restart does |
|---|---|
| before intent freeze | nothing external happened; the phase runs normally |
| after intent, before dispatch | probe says absent → dispatch under the same idempotency key |
| after dispatch, before receipt | probe answers; present → adopt, absent + idempotent → resume, absent + non-idempotent → fail closed |
| after receipt, before append | receipt is retained; the append is idempotent by `operation_id` (`LifecycleLog.append` dedupes with a byte comparison before the transition guard) |
| after append, before snapshot | the snapshot is a cache; it is rebuilt from the authoritative chain |

Invocation counts are measured with an instrumented driver and subject port. Artifact
deduplication is explicitly **not** accepted as evidence of exactly-once: it hides a second
call instead of preventing it.

---

## 10. Migration and backward compatibility

- **No frozen schema changed in place**, so every retained artifact from every earlier
  slice still parses, still hashes to the same value and still verifies.
- **Pre-environment terminals are untouched.** `derivePreEnvironmentClosure`,
  `verifyPreEnvironmentBundle` and the pre-environment cancellation path behave exactly as
  before, and their goldens are byte-unchanged.
- **Environment bundles produced before this change do not carry a substrate binding and
  will not verify.** That is the intended consequence and it is not softened: a bundle with
  no substrate binding is exactly the artifact whose cleanup cannot be checked. The only
  such artifacts in the repository are the regenerated development goldens, and there is no
  external consumer. A "legacy environment bundle" compatibility mode would re-open P0-1
  behind a flag.
- **The `invalid-run-emergency-cleanup` and `invalid-run-cancellation` goldens** are
  synthetic fixtures built by the evidence harness rather than by the environment CLI. They
  gain a substrate binding where they model a run that provisioned, and are otherwise
  unchanged. A legacy development fixture cannot silently receive a stronger claim: the
  verifier requires the binding whenever the lifecycle shows an environment.

---

## 11. Security analysis

**What this closes.**

- A caller can no longer redirect the Lab's observation channel. The substrate a phase
  talks to must be the one the run bound, and the binding is signed by a Lab role the
  caller does not hold.
- A caller can no longer operate on another run's workspace under a claimed identity.
- A crash can no longer produce a silent second external effect.
- Cleanup can no longer claim an action it did not take, or take one it recorded as skipped.
- An offline reader can no longer be told a run was valid by a field the producer set.

**What this does not close, and why that is the right boundary.**

- **The substrate is the environment.** An adversary with write access to the substrate
  root can forge substrate state, including the instance marker. That is not a defence
  failure: writing to the substrate *is* manipulating the environment, and no artifact the
  Lab signs can distinguish "the environment changed" from "someone changed the
  environment". The binding's job is to prove the Lab looked at **the substrate it said it
  would**, and it does that.
- **The fake driver remains a fake driver.** A binding over a fake substrate proves the
  mechanism, not any property of a real ecosystem. The claims ceiling is unchanged in that
  respect.
- **Intent records are unsigned private state.** An adversary who can write to
  `state/intents/` can suppress a reconciliation. They can equally write to `state/lease.json`
  and `state/snapshot.json` today; the run root is Lab-owned trusted storage, and the
  hash-chained lifecycle — not the private state — is what the terminal is derived from.
- **`--claim-scope` remains operator-supplied and ungated** (review P2). Out of scope here
  and explicitly still open.

---

## 12. Rejected alternatives

| Alternative | Rejected because |
|---|---|
| Trust the caller-provided `--substrate-root` and document the risk | This is the P0. A documented false-valid-attestation mechanism is still a false-valid-attestation mechanism. |
| Sign the path string as the substrate identity | A path is not an identity. It is unstable across hosts, unverifiable offline, publishes a host detail into signed evidence, and does not change when the directory is emptied and rebuilt. |
| Bind the substrate only at finalization | The exploit happens *before* finalization: `restore` and `destroy` observe the wrong substrate, and by the time the finalizer looks there is nothing left to detect. The binding must exist before the first substrate-affecting dispatch. |
| Use the run-root directory name as the run identity | Caller-chosen, unsigned, and trivially collides. The hash-chained event stream already carries the answer. |
| Compare `--run` against `state/snapshot.json` only | The snapshot is a derived cache and is authoritative for nothing (§11.9); a torn or forged snapshot must never decide identity. It is cross-checked, not trusted. |
| Write the intent after dispatch (or log it) | An intent that follows the call answers no question a crash can ask. The entire point is that the durable record precedes the effect. |
| Assume driver idempotence and retry blindly | Idempotence is a property of a specific driver and a specific operation, not of the interface. A subject step has no probe at all, so "assume idempotent" means "double-install on restart". |
| Destroy the whole environment, then reconstruct the frontier from what survived | This is P1-1 exactly. The record then describes the world *after* the action it claims not to have taken, and a foreign resource turns the single destroy into a total abort (P1-5). |
| Trust `passed` / `verdict` / `lab_validity` because the producer computed them honestly | `lab_validity` is a schema constant, so the check is tautological. A verifier that reads a producer's verdict verifies nothing about the run. |
| Fix the CLI and leave `RunWorkspace` / `EnvironmentRun` open to library callers | The CLI is one caller. The invariant belongs where the state is opened. Both layers check. |
| Add optional fields to the frozen environment run record / attestation to carry the binding | Forbidden by §6 of the brief and by the repository's contract-evolution rule. An optional field on a frozen schema also lets an old producer omit it and still validate — precisely the silent weakening the additive-contract rule exists to prevent. |
| Make the substrate binding a driver-signed receipt | The driver is untrusted infrastructure. A binding signed by the thing being bound proves nothing. |

---

## 13. Rollback boundary

Reverting this ADR's implementation restores the state at `bd71a7f`: `--substrate-root`
ungated and unattested, `--run` uncorrelated with `--run-root`, cleanup destroying before
classifying, and a verifier reading producer verdicts. That is a **known false-valid-
attestation mechanism**, so the rollback is not a supported operating posture — it exists
only as a bisect target.

The rollback is mechanically clean: one new contract identity, no frozen schema change, no
lifecycle state added, no retained bytes rewritten. Reverting the commit and regenerating
goldens returns the tree to its prior byte state.

---

## 14. Relationship to the review findings

| Finding | Disposition here |
|---|---|
| **P0-1** substrate substitution | **Closed.** §4.2 — signed binding, substrate-resident identity, gated development-only locator flags, offline binding consistency. |
| **P1-1** destroy before frontier | **Closed.** §4.5 — per-action attempts, observation-derived success. |
| **P1-2** `cancel` not branch-dispatched | **Closed.** §4.4. |
| **P1-3** `invalidityFindingHashes: []` hardcoded | **Closed.** §4.6 — findings derived from the failed-gate set, and the verifier requires the correspondence. |
| **P1-4** no-op compensation accepted | **Closed.** §4.3 — the restore intent records what it must revert; §4.6 — the verifier rederives restoration from the receipts' own statuses and the baselines. |
| **P1-5** foreign resource aborts cleanup | **Closed.** §4.5 — per-action failure boundaries. |
| **P1-6** verifier accepts omitted/relabelled safe actions | **Closed.** §4.6. |
| **P1-7** dispatch before durable intent | **Closed.** §4.3. |
| **P1-8** `--run` / `--run-root` uncorrelated | **Closed.** §4.1. |
| **P1-11** missing attestation/reachability cross-checks | **Closed.** §4.6. |
| **P1-12** substrate load swallows every error | **Closed.** §4.2 — reached because the binding necessarily touches substrate loading; made fail-closed rather than deferred. |
| P1-9 post-capture intents before activation | **Open.** Not an invariant this ADR settles. |
| P1-10 refused `journey` freezes a cutoff policy with no lifecycle event | **Open.** |
| P2 cluster beyond the verifier derivations | **Open**, itemised in the handoff. |
| P3 documentation drift | **Partially addressed** — the ADR registry is brought current as required by §5. |

---

## 15. Acceptance tests and negative controls

**Acceptance.**

- run identity: match succeeds; mismatch refuses before lease, evidence, substrate and
  reservation side effects; a direct library call refuses identically; repeated correct
  opens across fresh processes are stable.
- substrate substitution: the original exploit is reproduced against the pre-remediation
  behaviour, then proven to refuse; substrate A is proven still uncleared; no valid
  attestation is emitted; a mutated retained binding refuses offline; driver, lock,
  reservation namespace and locator each refuse independently.
- crash matrix: five injection points per external mutation, invocation-counted.
- cancellation matrix: every state in §4.4, each terminal verifying offline.
- emergency cleanup: owned/foreign/mixed frontiers; omitted, relabelled, receiptless and
  over-receipted actions; undeclared whole-environment destruction; wrong-binding receipts;
  post-cleanup residue; mid-sequence driver failure.
- verifier mutations: one concern at a time from a real CLI-produced bundle, each rejected
  for its intended semantic reason.

**Negative controls.** One per invariant, each required to make at least one *named* test
fail: run-identity validation, substrate-binding validation, pre-dispatch intent,
reconciliation, frontier classification, safe-action completeness, verifier validity
rederivation, verifier cleanup rederivation, branch-specific cancellation. A control that
kills nothing is reported as a non-load-bearing invariant, not quietly re-scored — the
discipline `docs/ledger/remediation-6.5B.md` §10a already established.

---

## 16. Consequences

- One new contract (`ERL2-C-156`), one new signer row, one new closure role, ten new
  refusal codes. No frozen schema changed shape or meaning.
- `EnvironmentDriver` gains `substrateInstance()` and an optional `destroyResource()`.
  ADR-ERL2-021 §5 is amended to that extent and to no other.
- Every golden that contains an environment run is regenerated; the byte-pin coverage
  constants move in the same commit, as the harness requires.
- Environment bundles produced before this change no longer verify. Intended (§10).
- ERL2-OQ-005, ERL2-OQ-007 and ERL2-OQ-008 are unchanged and still fail-closed. This ADR
  does not touch the evaluated domain plane and does not widen the claims ceiling: it
  removes false claims, it does not add true ones.
