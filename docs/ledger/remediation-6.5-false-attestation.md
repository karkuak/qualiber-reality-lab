# Slice 6.5 false-attestation remediation — the four paths that were still open

Companion to [ADR-ERL2-025](../adr/ADR-ERL2-025.md) and
[ADR-ERL2-026](../adr/ADR-ERL2-026.md), and successor to
[`remediation-6.5-invariants.md`](remediation-6.5-invariants.md), which settled
the invariant foundation. This package closes the paths by which the Lab could
still sign a result inconsistent with the environment it operated on or with the
strength of evidence it collected.

Source of the defects: `Independent-Code-Review-Slice-6.5B.md`, 2026-07-28, at
`bd71a7f`, plus the audit of what ADR-ERL2-024's implementation actually
delivered.

## 1. What was already closed, and what was not

ADR-ERL2-024's implementation was audited before anything was written. Three of
the four named findings were genuinely closed by it, and the audit is recorded
because "closed" was not uniformly true.

| Finding | ADR-ERL2-024 left it | This package |
|---|---|---|
| **P0-1** substrate substitution | **closed** — signed `SubstrateBindingV1`, substrate-resident identity, development-gated locator flags, offline binding consistency, checked before every dispatch | the missing *mutations* proven: duplicate binding, lifecycle-unreachable binding, wrong signer role, invalid signature, another driver, another archetype, and the same path with a different instance marker |
| **P1-8** run/workspace identity | **closed** — identity read from the hash-chained first lifecycle event, checked at three layers before any lease, write or dispatch | the missing cases proven: two real runs rather than a synthetic UUID, a snapshot disagreeing with the chain, a torn snapshot still tolerated, and three partially-initialized workspaces |
| **P1-12** fail-open substrate loading | **half closed** — the `catch { return undefined }` was removed, and a second copy of the same fail-open was left one layer in | see §2 |
| **P1-4** false restoration | **not closed** — the intent recorded the expected set only as an opaque digest in run-private state, and the verdict still came from three observations that cannot see a mutation | see §3 |
| **`--claim-scope`** | explicitly **still open**, and recorded as such in ADR-ERL2-024 §11 | see §4 |

## 2. P1-12 — the fail-open that survived the fix for the fail-open

`FileSubstrateStore.load` no longer swallowed errors. It still did this:

```ts
resources: Array.isArray(value.resources) ? value.resources : [],
mutations: Array.isArray(value.mutations) ? value.mutations : [],
```

`{}`, `{"resources":"gone"}`, a JSON array, a half-written temp file promoted by
a crash — every one of them became a substrate with no resources and no
mutations in it. At the point where it matters, that is indistinguishable from
the `catch` that had been removed: a teardown over live resources passes.

Four changes:

1. **Shape validation replaces coercion.** A document that is not substrate state
   is `ENV_SUBSTRATE_UNREADABLE`, not an empty environment.
2. **The state carries a shape version**, and an absent or unknown one fails
   closed. "I do not understand these bytes" and "there is nothing here" are the
   two answers this file exists to keep apart.
3. **`existsSync` is gone from the identity marker.** It answers false for a
   permission fault on the parent directory as readily as for an absent file, so
   an I/O fault could present as a substrate with no identity — and `provision`
   would then have minted a *second* identity over an established substrate. The
   marker is now read with the same ENOENT-discriminating read as everything
   else.
4. **Writes are typed too**, and their messages carry no host path: an untyped
   errno with an absolute path in it is both an untyped refusal and a leak.

`tests/adversarial/substrateErrorClassification.test.ts` covers absence,
malformed JSON, truncation, nine wrong shapes, four wrong versions, `EISDIR` on
both the state file and the marker, a real mode-0 file, seven injected errnos,
a write fault, and — the case the suite would be worthless without — that
`ENOENT` still means "never provisioned". The permission case **skips** rather
than passing when run as a user who can read a mode-0 file.

## 3. P1-4 — the observation that could not see a mutation

Restoration was derived, by the producer and again by the verifier, from the
before/after baseline fingerprints, the residual resource set and the
compensation receipts' own `status`. The producer also called `driver.inspect`
and discarded the result with `void inventory`.

**Not one of those can see a mutation.** The fingerprint is built from probe
observations and evidence-source states — resource *health*. The inventory is
resource *existence*. A mutation changes neither. So a driver returning
`status: "succeeded"` while clearing nothing produced two identical baselines,
an unchanged inventory, a succeeded receipt and `passed: true` over a mutation
that was still applied.

ADR-ERL2-026 adds the observation that is not blind: the substrate is asked for
its applied-mutation set immediately before the compensation and again
immediately after, and the verdict is the difference. `RestorationProbeV1`
(ERL2-C-157) retains both observations, the expected set derived from the run's
own retained `mutation-receipt` role, and the outcome derived from them.

Five outcomes, and the two that used to be the same silence are now different
retained values:

| outcome | meaning | valid terminal |
|---|---|---|
| `reverted` | every expected mutation gone, nothing else touched | yes |
| `nothing_to_revert` | there was nothing to revert, and the run says so | yes |
| `residual` | an expected mutation is **still applied** | no |
| `collateral` | unrelated state was reverted | no |
| `unobservable` | the driver cannot be asked | no |

Two scripted driver faults reproduce the lie end to end through the shipped
binary: `--fake-driver-fault no-op-restore` returns `succeeded` and reverts
nothing, and `collateral-restore` seeds a mutation the run never applied and lets
an ordinary compensation clear it too. Both are typed refusals
(`RESTORATION_NOT_INDEPENDENTLY_OBSERVED`), both leave no restoration
verification and no attestation, and both reach the authorized emergency
terminal instead.

The compensation receipt is bound as well: another run, another operation id, a
`mutate` receipt cited as a compensation, a driver manifest the run never bound,
and the same receipt cited twice are five separate refusals, none of which any
hash check catches — the receipt is retained, hash-linked and role-produced in
every one of them.

## 4. `--claim-scope` — the one verdict that was typed in

Every other verdict in the system is derived. This one was
`flags["claim-scope"] ?? "T1"` on one side and `["T1","T2","T3"].includes(...)`
on the other, so `erl2 finalize-generic --claim-scope T3` signed an
offline-valid attestation asserting historical-reproduction evidence over a
development-tier fake-driver run whose domain plane was never evaluated.

ADR-ERL2-025 makes the scope a **monotonic minimum over eight components** of
the run's own retained evidence. On this tree the answer is **T1**, held there
by six of them independently:

| Component | Observed | Ceiling |
|---|---|---|
| `terminal-variant` | environment | T3 |
| `execution-tier` | `development` | **T1** |
| `selection-assurance` | `non_blind_development` | **T1** |
| `environment-realism` | `driver_kind: "fake"` | **T1** |
| `subject-containment` | no qualification report retained | **T1** |
| `domain-evaluation` | `domain-result-not-applicable/v1` | **T1** |
| `metric-ceilings` | nine journey-plane metrics, weakest T1 | **T1** |
| `regression-evidence` | none retained | T2 |

`--claim-scope` survives as a requested upper bound. A request above the ceiling
is **refused, not capped**: an operator who typed `T3` and got a signed `T1`
back has been told nothing and would go on believing the run earned it.

T2 is unreachable while ERL2-OQ-005 keeps the only non-fake driver signed
`enabled: false`. T3 is unreachable because the historical-reproduction
contracts design §26 and plan §18 require are slice-12 work that does not exist —
expressed as a derivation over an absent artifact rather than as a hardcoded
constant, so the day those contracts land the function reads them.

The offline verifier recomputes the ceiling from retained bytes and refuses a
signed scope above it. The mutation case re-signs the attestation with the
development finalizer key, repairs the terminal lifecycle event's hash and the
bundle member's byte descriptor, and asserts the refusal is
`POLICY_CLAIM_SCOPE_EXCEEDS_EVIDENCE` — and asserts first that the *repaired*
bundle still verifies at T1, so a pass cannot come from an incidental check.

## 5. Contract evolution

One new contract identity, `ERL2-C-157` / `restoration-probe/v1`, additive on the
same terms as `substrate-binding/v1` (ADR-ERL2-024) and
`challenge-activation-receipt/v1` (ADR-ERL2-023).

**No frozen schema changed shape or meaning.** No existing field was repurposed,
no optional field was added to a frozen schema, and no retained historical bytes
were rewritten. `EnvironmentRestorationVerificationV1` is frozen and could not
carry the observation, which is exactly why the observation has its own identity.
The signer role (`environment_governor`) was already in the frozen
`trust-policy-manifest/v2` enum and already granted, so no new key enters the
trust head.

`EnvironmentDriver` gains one optional observation, `observedMutations`. Its
absence is fail-closed, the same posture ADR-ERL2-024 §6.2 took for
`destroyResource`. `supported_operations` is a frozen enum and is not extended.

**ADR-ERL2-025 introduces no contract at all.** Every component reads evidence the
terminals already close over, and the ceiling is recomputable by any reader
holding the artifact root — which is what makes writing it into the attestation
unnecessary.

## 6. Negative controls

Every invariant in this package was disabled in turn and the named suite re-run.
As in the previous package, the campaign ran against a **disposable clone**: the
harness needs a committed `HEAD` to check a worktree out from, and this
remediation was not authorized to commit. The clone is byte-identical to the live
working tree (tracked and untracked alike), the live tree was never patched, and
the harness confirmed it byte-identical afterwards.

The brief names eight invariants that must have load-bearing controls. Nine
controls cover them — narrow `ENOENT` handling needs two, because the fail-open
had two independent halves — plus `substrate-locator-conflict`, which is the
other half of P0-1's locator story.

| Control | Guard disabled | Result | Expected |
|---|---|---|---|
| `run-identity-validation` | `--run` must match the run the workspace records | **4 pass / 7 fail** | fail ✔ |
| `substrate-binding-validation` | every environment phase checks the substrate before it dispatches | **9 pass / 3 fail** | fail ✔ |
| `substrate-locator-conflict` | a locator flag may not replace an established binding | **10 pass / 2 fail** | fail ✔ |
| `locator-flag-development-gate` | `--substrate-root` / `--reservation-root` are development-only | **11 pass / 1 fail** | fail ✔ |
| `narrow-enoent-substrate-read` | only `ENOENT` means "never provisioned" | **8 pass / 3 fail** | fail ✔ |
| `substrate-state-shape-validation` | a document that is not substrate state is a fault | **10 pass / 1 fail** | fail ✔ |
| `compensation-mutation-binding` | the expected set comes from the retained mutation receipts | **3 pass / 5 fail** | fail ✔ |
| `independent-restoration-probe` | the substrate is re-read after the compensation | **5 pass / 3 fail** | fail ✔ |
| `producer-claim-scope-derivation` | the producer refuses a scope stronger than the evidence | **7 pass / 1 fail** | fail ✔ |
| `verifier-claim-scope-rederivation` | the verifier re-derives the ceiling | **4 pass / 4 fail** | fail ✔ |

**All ten are load-bearing**, and each agreed with its recorded expectation on the
first run — unlike the previous campaign, where four disagreed and all four
turned out to be defects in the controls or the tests rather than in the
invariants (`remediation-6.5-invariants.md` §8). No expectation was re-scored to
make anything green, and none needed to be.

Two of the ten measure guards ADR-ERL2-024 introduced (`run-identity-validation`,
`substrate-binding-validation`) and are re-measured here because their suites
grew: run-identity now kills 7 cases rather than 5, and substrate-binding 3
rather than 2. The remaining twenty pre-existing controls were not re-run by this
package; their last measurement is the table in
`remediation-6.5-invariants.md` §9.

`compensation-mutation-binding` and `verifier-claim-scope-rederivation` are worth
a note: they kill 5 of 8 and 4 of 8 cases respectively. A control that kills half
its suite is not a stronger control than one that kills a single named case — but
it does say the invariant is reached from several independent directions, which
is what the derivation was designed for.

The harness gained one change: its filter now accepts a comma-separated list, so
a package can measure exactly the controls it touches and say which. A full
thirty-control campaign is thirty builds and thirty suite runs; the alternative
to naming a subset was a partial answer with no record of which part.

## 7. What is still open

This package closes four false-attestation paths. It does **not** remediate the
whole review, and does not claim to.

Still open, and not claimed:

- **P1-9** — post-capture intents (exercise / observe / remove) can execute
  before challenge activation and before the evidence cutoff; `SETUP_INTENTS` is
  gated only on the first step.
- **P1-10** — a refused `journey` freezes `retained/environment/cutoff-policy.json`
  with no lifecycle event: a refusal that writes evidence.
- The P2 cluster beyond the verifier derivations and the claim scope closed here:
  `mounted_file` scanned with metadata that cannot contain the mounted content;
  `lab_telemetry` with no negative control; secret canaries and forbidden
  identifiers unscanned on the environment subject-output surface; the declared
  subject-output size limit hashed but unenforced; the evidence cutoff never
  re-derived offline; retained subject-output payloads unaccounted in the
  verifier; the invalid terminal's primary finding naming a gate from the cleanup
  branch; Lab attribution unenforced on an invalid environment terminal; the
  signer inventory's `complete_for_terminal_chain` omitting members whose
  authority field is not literally named `signature`.
- The remaining P3 documentation drift.
- ERL2-OQ-005, ERL2-OQ-007 and ERL2-OQ-008 are unchanged and still fail-closed.

**The claims ceiling is unchanged and is now mechanically enforced: T1.** Neither
ADR removes a limitation or adds a true claim; both remove the ability to state
something the evidence never supported.

## 8. Where the numbers live

`docs/ledger/negative-controls.json` is **not** updated by this package and still
holds the ten-control result set from 6.5-B. That is the same deliberate, stated
gap the previous package recorded: the harness regenerates that file only from a
full campaign run, and a campaign requires a committed `HEAD`. The campaign
therefore ran against a disposable clone and its JSON was written there.
Re-running the whole campaign in the repository is the first thing to do after
this work is committed; until then the JSON is stale and says so here rather than
being hand-assembled into something that claims to be generated.
