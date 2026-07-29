# Slice 6.5 invariant remediation — run identity, substrate binding, mutation intent, cancellation, cleanup derivation

Companion to [ADR-ERL2-024](../adr/ADR-ERL2-024.md). It records what the
independent review of 6.5-B/C/D/E found, what was changed, what was measured, and
— the part that matters — what is **still open**.

Source of the defects: `Independent-Code-Review-Slice-6.5B.md`, 2026-07-28, at
`bd71a7f`.

## 1. The four invariants, and the defect each one closes

| Invariant | Defect it closes | Where it lives |
|---|---|---|
| A run is permanently bound to the workspace that records it | **P1-8** — `--run` and `--run-root` were independent inputs, so a command could operate on another run's root under a claimed identity | `packages/core/src/run/runIdentity.ts`, checked in the CLI dispatcher, the CLI workspace opener and the `RunWorkspace` constructor |
| A run is permanently bound to one substrate identity | **P0-1** — `--substrate-root` was caller-controlled, ungated and unattested, so a run could be torn down and finalized against a fresh empty directory and its bundle verified at exit 0 | `SubstrateBindingV1` (ERL2-C-156), `packages/core/src/environment/substrateBinding.ts` |
| Every external mutation is preceded by a durable intent, and a restart reconciles before it retries | **P1-7** (dispatch before intent) and **P1-4** (a compensation that reverted nothing) | `packages/core/src/run/mutationIntent.ts`, the driver operation log in `substrate.ts` |
| Cleanup is derived — by the producer from the frontier, by the verifier from retained bytes | **P1-1**, **P1-2**, **P1-5**, **P1-6**, **P1-11** | `environmentRun.emergencyCleanup`, `packages/public-verifier/src/library/environmentDerivation.ts` |

## 2. What the P0 actually was, and what it is now

The review reproduced this against the shipped binary:

```
erl2 provision … --run-root ./run           # substrate A
…
erl2 restore   … --run-root ./run --substrate-root ./empty
erl2 destroy   … --run-root ./run --substrate-root ./empty
erl2 finalize-generic … --substrate-root ./empty
erl2 verify --public-bundle … --offline     # exit 0, verdict valid
```

Substrate A stayed fully allocated. Two things made it invisible: the driver
observed the wrong substrate, and the finalizer's own *independent* residue
re-inspection observed the same wrong substrate. No retained artifact named what
was observed, so no offline reader could tell.

Three changes, each of which is separately load-bearing:

1. **The substrate carries an identity inside itself.** A fresh empty directory
   has none, and `assertSubstrateBinding` refuses `ENV_SUBSTRATE_BINDING_MISSING`
   before any cleanup evidence freezes.
2. **The run records which identity it bound**, in a signed
   `SubstrateBindingV1` frozen *before* the first substrate-affecting dispatch,
   and the offline verifier requires and cross-checks it.
3. **The locator is private and cannot be replaced.** `--substrate-root` and
   `--reservation-root` become development-only, and even under the development
   profile a flag that disagrees with the run's own record is
   `ENV_SUBSTRATE_LOCATOR_CONFLICT`.

`tests/adversarial/substrateSubstitution.test.ts` runs the exploit's own commands
and asserts the refusal, that substrate A is still holding live resources, and
that no attestation was emitted. Per the brief, the case that used to demonstrate
a false-valid attestation is now an **expected refusal**, not a retained success.

## 3. Exactly-once, and the one place it is honestly not claimed

The driver gained an operation log keyed by operation id, which is what lets a
restart *adopt* a prior result instead of re-dispatching or failing closed. So a
crash between the external call and the receipt freeze resolves as:

| Mutation | Probe | Restart does |
|---|---|---|
| provision, activation mutate, restore, destroy, emergency action, reservation acquire/release | the driver's own operation log | adopt the stored receipt — **zero** further invocations |
| subject step | *none exists* | **fail closed** with `ENV_MUTATION_INTENT_AMBIGUOUS` |

The asymmetry is deliberate and is the claim, not a gap in it: an opaque subject
cannot be asked whether it already ran a step, and "assume it is idempotent" means
choosing to double-install against a real subject to keep a happy path green.

`tests/e2e/mutationIntentCrashMatrix.test.ts` measures this by **counting driver
and subject-port invocations**, not artifacts — artifact deduplication hides a
second call rather than preventing it, which is why the review's own finding used
invocation counting.

## 4. Two fixtures that were quietly wrong

Both were found by the new verifier derivations, not by inspection, and both are
corrected rather than accommodated.

- **`tests/support/fakeRun.ts` residue named a fabricated identity.** The
  synthetic emergency-cleanup fixture built `remaining_resources` with
  `identity_hash: h("target-<resource id>")` — a hash that identified nothing —
  so its residue accounted for no actual resource. It now reads the identity from
  the frontier's own observations. This is exactly the "silence is not
  containment" failure the contract exists to refuse; the fixture had been
  bypassing `buildEmergencyCleanup` and so was never checked.
- **`resource_frontier_event_hash` had two honest readings.** The shipped
  producer fills it with the frontier's core hash; the synthetic fixture filled it
  with the hash of the lifecycle event that produced the frontier. Both bind the
  cleanup to the same frozen frontier. The verifier accepts either **and only
  either** — an unrelated hash is still refused — rather than picking one and
  invalidating retained evidence built on the other.

## 5. Contract evolution

One new contract identity, `ERL2-C-156` / `substrate-binding/v1`, additive on the
same terms as `challenge-activation-receipt/v1` (ADR-ERL2-023) and
`cancellation-request/v1` (ADR-ERL2-018).

**No frozen schema changed shape or meaning.** No existing field was repurposed,
no optional field was added to a frozen schema, and no retained historical bytes
were rewritten. The signer role (`environment_governor`) was already in the frozen
`trust-policy-manifest/v2` enum and already granted by the development trust
policy, so no new key enters the trust head.

Two things that are *not* contracts, deliberately:

- `state/substrate-locator.json` — the operational locator. A path is deployment
  configuration, not a claim; publishing an absolute host path as signed evidence
  would be a leak, and hashing it would be unverifiable by a reader who has no
  path to hash.
- `state/intents/*.json` — the mutation intent journal. An intent records that a
  call is *about to be made*; it is not a result and must never be readable as
  one. Making it a contract would put a record of an operation that may never
  have happened into the mandatory closure.

Both live in the `state/` subtree that the artifact index, the closure derivation
and the retained-file accounting all exclude by construction — beside the run
lease and the derived snapshot.

## 6. What is still open

> **Superseded in part**, and deliberately not rewritten. A later audit of this
> package's own implementation found that its P1-4 closure rested on three
> observations that cannot see a mutation, and that its P1-12 closure left a
> second copy of the same fail-open one layer in. Those, and the `--claim-scope`
> item this section lists as open, are closed by
> [ADR-ERL2-025](../adr/ADR-ERL2-025.md), [ADR-ERL2-026](../adr/ADR-ERL2-026.md)
> and [`remediation-6.5-false-attestation.md`](remediation-6.5-false-attestation.md).
> Editing this section into something it never said would destroy the record of
> what was claimed when — which is the point of keeping it.

This package settles the invariant foundation. It does **not** remediate the whole
review. Still open, and not claimed:

- **P1-9** — post-capture intents (exercise / observe / remove) can execute before
  challenge activation and before the evidence cutoff; `SETUP_INTENTS` is gated
  only on the first step.
- **P1-10** — a refused `journey` freezes `retained/environment/cutoff-policy.json`
  with no lifecycle event: a refusal that writes evidence.
- The P2 cluster beyond the verifier derivations: `mounted_file` scanned with
  metadata that cannot contain the mounted content; `lab_telemetry` with no
  negative control; secret canaries and forbidden identifiers unscanned on the
  environment subject-output surface; the declared subject-output size limit
  hashed but unenforced; the evidence cutoff never re-derived offline; retained
  subject-output payloads unaccounted in the verifier; `--claim-scope` operator-
  supplied and ungated; the invalid terminal's primary finding naming a gate from
  the cleanup branch; Lab attribution unenforced on an invalid environment
  terminal; the signer inventory's `complete_for_terminal_chain` omitting members
  whose authority field is not literally named `signature`.
- The remaining P3 documentation drift not listed in §7.
- ERL2-OQ-005, ERL2-OQ-007 and ERL2-OQ-008 are unchanged and still fail-closed.

## 7. Documentation corrected here

- the requirements-ledger ADR registry stopped at ADR-ERL2-017; ADR-ERL2-018
  through -024 are now registered;
- `docs/decisions/slice-6.5-gap-matrix.md` is marked **superseded** rather than
  rewritten: it is a dated snapshot of the pre-6.5 gap, and editing it into
  something it never was would destroy the record;
- `docs/claims/permitted-claims.md` states the new claims and, explicitly, the two
  places the evidence stops short — the subject-step exactly-once asymmetry, and
  the fact that the verifier checks the retained gate set for self-consistency
  rather than re-running every Lab validity gate.

## 8. Negative controls

Every invariant above was disabled in turn, in a `git worktree` at a snapshot of
this work, and the named suite re-run. The campaign ran against a **disposable
clone**, not the live working tree: the harness needs a committed HEAD to check a
worktree out from, and this remediation was not authorized to commit to the
repository. The clone is byte-identical to the working tree; the live tree was
never patched, and the harness confirmed it was byte-identical afterwards.

### What the first campaign found

Nineteen of twenty-three controls agreed with their recorded expectation on the
first run. **Four did not, and all four were defects in the controls or the tests
rather than in the invariants.** They are recorded here because the whole point
of the campaign is that this is what it is for.

| Disagreement | Cause | Fix |
|---|---|---|
| `environment-bundle-verifier` — BUILD FAILED | the control inserted a `throw` as the function's first statement. ADR-ERL2-024 added `chain[chain.length - 1]` to that function; under `noUncheckedIndexedAccess` that is `T \| undefined`, and TypeScript does not narrow inside a block it has already proven unreachable — so the *patched* tree stopped compiling | the control now diverts the dispatch instead of throwing, which tests the same property and leaves both functions typechecking |
| `intent-reconciliation` — BUILD FAILED | the control replaced the probe with a literal; TypeScript narrows a `const` to its initializer's literal type even through a type annotation, so two later comparisons became "no overlap" errors | the control now disables the *adopt* path, so an unsettled operation is re-dispatched instead of reconciled — which is the defect itself |
| `frontier-action-derivation` — killed nothing | the test flipped every action to `independently_safe`, which the **per-action** comparison then caught for a different reason. The frontier-derivation check was never isolated | the test now changes an action's `kind` in the frontier **and** in the cleanup, so the two agree with each other and disagree only with the observed resources. Nothing but re-deriving the action set can catch it |
| `verifier-validity-derivation` — killed nothing | the test's mutation (`valid` over a failed gate) *also* trips the failed-gate-needs-a-finding rule | an isolating case was added: all gates pass, the producer says `invalid`, no findings. Only recomputing the verdict from the gates catches that |

Neither of the two "killed nothing" results was re-scored to `expect: "pass"`.
Both were genuinely load-bearing invariants whose *tests* were not isolating them,
which is exactly the distinction §10a of the 6.5-B ledger drew — and it is why the
campaign is worth running even when the code is right.

## 9. Negative-control results

> **Superseded by a measurement this table could not make**, and left as the
> dated record it is. Every number below was taken in a disposable clone, because
> the harness checks a worktree out at `HEAD` and this package had no commit to
> check out. The full thirty controls have since been run **in the repository**,
> and `remediation-6.5-false-attestation.md` §6 carries that result — including
> the fact that all ten controls measured both ways returned identical counts,
> which is the first independent check this clone methodology has ever had.
> One count below has since moved for a stated reason (`restore-receipt-status`,
> 5 kills → 4), and six rose because their suites grew.

Measured against the repaired controls and the strengthened tests. `expect: pass`
is a legitimate value and is never assigned to make a campaign green: it means the
guard was disabled and **nothing failed**, which is reported rather than hidden.

### The invariants ADR-ERL2-024 establishes

| Control | Guard disabled | Result | Expected |
|---|---|---|---|
| `run-identity-validation` | `--run` must match the run the workspace records | **2 pass / 5 fail** | fail ✔ |
| `substrate-binding-validation` | every environment phase checks the substrate before it dispatches | **6 pass / 2 fail** | fail ✔ |
| `substrate-locator-conflict` | a locator flag may not replace an established binding | **6 pass / 2 fail** | fail ✔ |
| `pre-dispatch-intent` | the durable record written *before* the external call | **5 pass / 2 fail** | fail ✔ |
| `intent-reconciliation` | adopt a verified prior result instead of re-dispatching | **5 pass / 2 fail** | fail ✔ |
| `frontier-action-derivation` | a frontier cannot vouch for its own action set | **12 pass / 1 fail** | fail ✔ |
| `safe-action-completeness` | every safe action attempted, and correctly labelled | **9 pass / 4 fail** | fail ✔ |
| `per-action-emergency-cleanup` | each safe action attempted separately | **12 pass / 1 fail** | fail ✔ |
| `verifier-validity-derivation` | the verifier recomputes the verdict from the gates | **12 pass / 1 fail** | fail ✔ |
| `verifier-restoration-derivation` | the verifier recomputes `passed` from the evidence | **11 pass / 1 fail** | fail ✔ |
| `verifier-teardown-derivation` | the verifier recomputes `passed` from the residue | **11 pass / 1 fail** | fail ✔ |
| `branch-specific-cancellation` | `cancel` routed by the run's own evidence | **3 pass / 6 fail** | fail ✔ |
| `cancellation-cleanup-applicability` | a live environment may not claim `not_required` | **11 pass / 1 fail** | fail ✔ |

**Every one of the thirteen new invariants is load-bearing.** Two only became so
after the campaign showed their tests were not isolating them (§8).

### The pre-existing controls, re-measured on this tree

| Control | Result | Expected |
|---|---|---|
| `activate-connect-guard` | 10 pass / 1 fail | fail ✔ |
| `freeze-output-outstanding-step-guard` | 10 pass / 1 fail | fail ✔ |
| `step-order-guard` | 11 pass / 1 fail | fail ✔ |
| `durable-substrate` | 6 pass / 17 fail | fail ✔ |
| `restore-receipt-status` | 3 pass / 5 fail | fail ✔ |
| `emergency-route` | 4 pass / 4 fail | fail ✔ |
| `subject-output-canary-scan` | 11 pass / 1 fail | fail ✔ |
| `environment-bundle-verifier` | **10 pass / 7 fail** | fail ✔ |
| `baseline-repeatability` | 12 pass / 0 fail | pass ✔ — still not load-bearing; the fake driver is deterministic, so two probes agree by construction. Kept for the Compose driver, and stated for what it is. |
| `case-selected-comparisons` | 21 pass / 0 fail | pass ✔ — still not load-bearing; the producer builds pool entries from the admitted manifests, so they agree by construction |

`environment-bundle-verifier` is worth a note: it was recorded as **not**
load-bearing in the 6.5-B ledger (`verifyEnvironmentBundle` was dead code, so
making it throw changed nothing) and then as load-bearing once 6.5-E produced real
bundles. It now kills seven cases, because the verifier does considerably more.

### Where these numbers live

The table above is the authoritative record. `docs/ledger/negative-controls.json`
is **not** updated by this package and still holds the ten-control result set from
6.5-B.

That is a deliberate, stated gap rather than an oversight. The harness regenerates
that file only from a full campaign run, and a campaign requires a committed
`HEAD` to check a worktree out from — this remediation was not authorized to
commit. The campaign therefore ran against a disposable clone, and its JSON was
written there. Re-running the whole campaign in the repository is the first thing
to do after this work is committed; until then, the JSON is stale and says so
here rather than being hand-assembled into something that claims to be generated.
