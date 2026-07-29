# Slice 6.5 cleanup remediation — the branch ADR-ERL2-024 did not reach

Companion to [ADR-ERL2-027](../adr/ADR-ERL2-027.md), and successor to
[`remediation-6.5-invariants.md`](remediation-6.5-invariants.md) (the invariant
foundation) and
[`remediation-6.5-false-attestation.md`](remediation-6.5-false-attestation.md)
(the four false-attestation paths). This package closes the cleanup and
invalid-terminal findings on the branch the first package left open.

Source of the defects: `Independent-Code-Review-Slice-6.5B.md`, 2026-07-28,
findings **P1-1**, **P1-3**, **P1-5**, **P1-6** — plus an audit of what
ADR-ERL2-024's implementation actually delivered for them.

## 1. What was already closed, and what was not

ADR-ERL2-024 §14 records all four of these findings as **closed**. The audit ran
before anything was written, on the same terms the previous package audited P1-4
and P1-12, and found the same pattern: the fix is real, and it covers one branch
of two.

`EnvironmentRun.invalidate` routed on one boolean. `emergency` is true only for
restoration and teardown failures. The other five failure phases — provisioning,
baseline, planning, activation, observation — reached
`boundedEnvironmentCleanup`, which was, in full:

```ts
const receipt = this.driver.destroy({ runId, operationId: "op-invalid-destroy" }).receipt;
```

issued one line after the frontier was frozen, and without reading it.

| Finding | ADR-ERL2-024 left it | This package |
|---|---|---|
| **P1-1** destroy before frontier | **closed on the emergency branch** — per-action attempts, observation-derived success, three load-bearing controls | the bounded branch, where a frontier-unsafe resource was destroyed anyway and *nothing retained said so*; plus the offline half — see §2 and §5 |
| **P1-3** failed gate cannot reach a terminal | **closed** for `invalidityFindingHashes: []`; the audit confirms the hashes are now `failedGates.map(...)` and the verifier requires the correspondence | the other route to a terminal: `invalidate`'s own primary finding named a gate chosen by *cleanup branch* rather than by what failed — see §4 |
| **P1-5** foreign resource aborts cleanup | **closed on the emergency branch**, and **never measured** — the only test claiming to prove it used a *shared* resource, which is not foreign | the bounded branch, and the first fixture that can actually produce a foreign resource — see §3 |
| **P1-6** verifier accepts omitted/relabelled safe actions | **closed on the emergency branch** | `deriveInvalidEnvironmentSemantics` returned early on any non-emergency variant, so five of seven phases were unchecked — see §5 |

## 2. P1-1 — the frontier that was frozen and then ignored

`freezeResourceFrontier` classifies a `shared_with_other_runs` resource as
`contain_residual`, `independently_safe: false`, reason
`RESOURCE_SHARED_WITH_ANOTHER_RUN`. That is the Lab writing down *do not touch
this*.

`FakeEnvironmentDriver.destroy` then destroyed it, because its own filter is
`resources.filter((r) => !r.destroyable)` — sharing is not consulted. The
resource was gone, no retained artifact said an action had been taken against it,
and the record reported `variant: "environment"`,
`status: "attempted_succeeded"`.

This is **worse than the original P1-1**, and the ADR says so: the original at
least reported the resource as `skipped_unsafe`, so the record contradicted the
action. This one did not mention the resource at all.

`boundedEnvironmentCleanup` is deleted. One executor,
`frontierDerivedCleanup`, serves every invalid environment terminal;
`emergency` now decides only which lifecycle states the terminal passes through
and which trigger the frontier records, never which safety rules apply.
`EmergencyCleanupVerificationV1.trigger` already carried
`invalid_environment_failure` — the contract was written for this case and the
producer never used it, so no schema changed.

`BOUNDED-CLEANUP: a frontier-unsafe resource survives, and is reported as
skipped` checks the claim and the world separately: the resource is read back out
of the substrate file the driver writes, not out of anything the Lab said about
itself.

## 3. P1-5 — and the test that could not have failed

`FakeEnvironmentDriver.destroy` validates ownership of **every** live resource
before touching any. One resource not scoped to the run threw
`ENV_FOREIGN_RESOURCE_REJECTED` out of `boundedEnvironmentCleanup`, out of
`invalidate`, and out of the command: zero safe actions attempted, no invalid
record, leases retained.

The sharper finding is about the *emergency* branch, which was fixed. Its
regression case, `EMERGENCY-ADV: a foreign resource does not prevent safe cleanup
of the run's own`, was built with the `failed-restore-shared` fault, whose comment
read "the foreign member whose presence used to abort the whole branch".

**It is not foreign.** A shared resource's `run_scoped_name` still embeds *this*
run, so `assertOwnedByRun` passes for it and `destroy` would never have thrown on
it. The case proved something true about unsafe classification and nothing at all
about ownership, and `FakeEnvironmentDriver` had no way to produce a resource that
fails `assertOwnedByRun`, so the invariant had never been measured.

`FakeDriverFaults.foreignResourceKinds` seeds a resource named and hashed for
another run — internally consistent, and provably not ours. Two CLI faults reach
it (`failed-restore-foreign`, `contaminated-baseline-foreign`), the existing case
is renamed to what it actually tests, and a new one measures the real property on
each branch. This is the same class of defect the ADR-ERL2-024 campaign found four
times (`remediation-6.5-invariants.md` §8), found the same way and recorded on the
same terms.

## 4. P1-3 — the finding that named the wrong gate

```ts
failedGateIds: [input.emergency ? "restoration-verified" : "environment-baseline-clean"],
```

Keyed on the cleanup branch, not on what failed. A provisioning failure emitted a
Lab invalidity finding naming `environment-baseline-clean` — a gate belonging to a
later phase, which the run never evaluated. A teardown failure named
`restoration-verified`, which by construction had passed. Every structural check
passed over both: the findings are retained, hash-linked, role-produced and cited.

`ENVIRONMENT_PHASE_GATE` replaces it with a total, deterministic map from failure
phase to the gate that phase's evidence supports, and the offline verifier
re-applies the same map to the record's **own** `failed_phase` — so the producer's
choice is the thing under test rather than the input. An unmapped phase is refused
rather than defaulted, because a default reintroduces the defect one phase at a
time as the union grows, which is how the branch-keyed version survived.

Two properties travel with it, both now verifier-enforced rather than merely
produced: the finding is Lab-owned with no subject attribution and no scoreable
plane; and the primary finding is frozen **before** the frontier and before any
dispatch, so a cleanup that then fails adds evidence and never replaces the cause.
`BOUNDED-CLEANUP: the cleanup consequence never replaces the original cause` runs
the case where cleanup genuinely does not complete.

## 5. P1-6 — and the observation nothing retained

`deriveInvalidEnvironmentSemantics` opened with
`if (options.record.cleanup.variant !== "emergency_environment") return;`. The
early return is gone, and every invalid environment terminal now has its expected
safe-action set, receipt cardinality, unsafe-skip reasons and residue derived
from retained bytes.

That exposed the deeper hole. The only post-cleanup evidence was
`EmergencyCleanupVerificationV1.remaining_resources`, which the producer derives
from its own action outcomes:

- a cleanup that marked every action `succeeded` produced an **empty** residue,
  and the verifier's cross-check is vacuous when nothing is unresolved;
- a resource that **vanished without an authorized action** was undetectable,
  because a post-cleanup inventory cannot tell an authorized destruction from an
  unauthorized one — the resource is absent in both.

`ERL2-C-158` / `cleanup-residue-probe/v1` closes it on ADR-ERL2-026's shape: the
substrate is re-observed after the last dispatch and the observation retained
beside the pre-action frontier it closes over. The verdict is a set comparison an
offline reader reproduces:

```
destroyed  = observed_before \ observed_after
undeclared = destroyed \ authorized_targets
residual   = observed_before ∩ observed_after
```

Four outcomes, and the one that did not exist before is the point:

| outcome | meaning | terminal |
|---|---|---|
| `clean` | nothing remains; every disappearance authorized | invalid, cleanup complete |
| `residual` | something remains; every disappearance authorized | invalid, cleanup incomplete |
| `undeclared_destruction` | something the Lab never authorized is gone | invalid, **Lab-integrity failure** |
| `unobservable` | the substrate could not be re-observed | invalid, cleanup unproven |

`authorized_targets` is re-derived by the verifier from `safeActions(frontier)`
and never read from the probe: a probe that writes its own authorization would
authorize whatever it destroyed.

### What it caught on first contact

The repository's own `invalid-run-emergency-cleanup` golden. Its builder
fabricated a `status: "succeeded"` receipt per action and **never called the
driver at all**, so it modelled a cleanup that destroyed nothing while claiming to
have destroyed everything, and its residue was empty because it was derived from
those claims. `assertActionsAgreeWithResidue` refused it:

```
emergency action isolate-network-network-019f1af9 is recorded as succeeded,
but its target network-019f1af9 is still present in the post-cleanup observation
```

The fixture now actually attempts each action against the driver and derives
success by re-observing, exactly as the producer does.

A third defect in the same fixture surfaced from the same direction, and it is the
one the probe found rather than refused: the record read
`cleanup.status: "attempted_succeeded"` while the contained shared resource was
still sitting in the substrate. `status` summarises the same evidence the probe
holds, so nothing should have been able to let the two disagree — and until the
probe existed there was no second reading to disagree with. The verifier now
derives the status from the observed residue, and the fixture derives it too
rather than asserting it.

Two further fixture defects surfaced with it, both of them ADR-ERL2-024 claims
that were never implemented:

- **The fixture had no substrate binding.** ADR-ERL2-024 §10 states the
  `invalid-run-emergency-cleanup` and `invalid-run-cancellation` goldens "gain a
  substrate binding where they model a run that provisioned". This one did not, so
  its cleanup verdicts could be attributed to no substrate at all — the artifact
  P0-1 produced. It now carries one, and the archetype the binding names.
- **Its finding cited `environment-restoration`**, which is not a Lab validity
  gate id at all; `environmentGates()` names `restoration-verified`. §4's map
  refused it.

## 6. Contract evolution

One new contract identity, `ERL2-C-158` / `cleanup-residue-probe/v1`, additive on
exactly the terms ADR-ERL2-026 §6 used for `restoration-probe/v1`,
ADR-ERL2-024 §6.1 for `substrate-binding/v1` and ADR-ERL2-023 §2 for
`challenge-activation-receipt/v1`.

**No frozen schema changed shape or meaning.** No existing field was repurposed,
no optional field was added to a frozen schema, and no retained historical bytes
were rewritten. `EmergencyCleanupVerificationV1` is frozen and could not carry the
observation — its `remaining_resources` is a producer-derived summary, which is
precisely why an independent observation needs its own identity.

`EnvironmentDriver` gains **no** operation: the probe reads `inspect`, already
required and already read-only by contract. No new signer key: the probe is
unsigned, because an invalid terminal emits no attestation and no public bundle,
so a signature would serve no external reader (ADR-ERL2-027 §6.3).

Two new refusal codes, `RESIDUE_PROBE_MISSING` and
`RESIDUE_UNDECLARED_DESTRUCTION`. Both were first written under a `CLEANUP_`
prefix and both were rejected at construction — `Erl2Error` refuses a code whose
prefix is not in the catalogued Appendix B family list. Recorded because it is the
guard working: a new code cannot quietly invent a new refusal family.

## 7. Negative controls

Seven new controls, one per invariant this package establishes, each required to
make at least one **named** test fail. Results are in §9.

| Control | Guard disabled |
|---|---|
| `unconditional-bounded-destroy` | the bounded route derives its cleanup instead of destroying the environment |
| `cleanup-residue-probe` | the verifier requires the independent post-cleanup observation |
| `undeclared-destruction-detection` | a resource that vanished unauthorized is a refusal |
| `actions-agree-with-residue` | a reported outcome must agree with the substrate observed |
| `invalid-finding-phase-gate` | the finding names the gate its own phase falsifies |
| `invalid-finding-lab-attribution` | a Lab environment failure cannot be attributed to the subject |
| `foreign-resource-classification` | a resource not provably this run's is never an authorized target |

The three ADR-ERL2-024 controls that already cover the emergency branch
(`frontier-action-derivation`, `safe-action-completeness`,
`per-action-emergency-cleanup`) are unchanged and re-measured.

## 8. What is still open

This package closes four cleanup and invalid-terminal findings. It does **not**
remediate the whole review, and does not claim to.

Still open, and not claimed:

- **P1-9** — post-capture intents (exercise / observe / remove) can execute before
  challenge activation and before the evidence cutoff; `SETUP_INTENTS` is gated
  only on the first step.
- **P1-10** — a refused `journey` freezes `retained/environment/cutoff-policy.json`
  with no lifecycle event: a refusal that writes evidence.
- The P2 cluster beyond the two items §4 closes (the invalid terminal's primary
  finding naming a gate from the cleanup branch; Lab attribution unenforced on an
  invalid environment terminal): `mounted_file` scanned with metadata that cannot
  contain the mounted content; `lab_telemetry` with no negative control; secret
  canaries and forbidden identifiers unscanned on the environment subject-output
  surface; the declared subject-output size limit hashed but unenforced; the
  evidence cutoff never re-derived offline; retained subject-output payloads
  unaccounted in the verifier; the signer inventory's
  `complete_for_terminal_chain` omitting members whose authority field is not
  literally named `signature`.
- The remaining P3 documentation drift.
- ERL2-OQ-005, ERL2-OQ-007 and ERL2-OQ-008 are unchanged and still fail-closed.

**One gap this package found and did not close**, recorded rather than fixed
because closing it is a change to the evidence harness rather than to the
invariants: `fixtures/golden/cli-transcript.json` is excluded from the byte pin
(it carries absolute CLI paths), and it is the **only** place the goldens' own
`verify-record` exit codes are recorded. When this work first broke the
`invalid-run-emergency-cleanup` fixture, that fixture began failing verification
with `INVALID_REASON_PHASE_MISMATCH` and `evidence:verify` still reported OK. The
exit codes of a golden's verification are not pinned; a future change can alter
them silently. Worth a follow-up that pins the codes separately from the paths.

**The claims ceiling is unchanged: T1.** This package removes false claims; it
adds no true ones.

## 9. Results

The campaign ran against a **disposable clone**, on the same terms and for the
same reason as the previous two packages: the harness checks a worktree out at
`HEAD` and refuses a dirty tree, and this remediation was not authorized to
commit. The clone was proven byte-identical to the live working tree by content
hash over every file outside `.git`, `node_modules` and `dist` (1159 files, no
differences), the live tree was never patched, and the harness confirmed its own
tree byte-identical afterwards. `remediation-6.5-false-attestation.md` §6 records
that all ten controls measured both ways in the previous package returned
identical counts, which is the only independent check this methodology has.

**Seven of the thirty-seven controls were measured — the seven this package
introduces — and not the thirty it inherits.** That is a scope statement, not a
result: `remediation-6.5-false-attestation.md` §6 carries a full thirty-control
campaign run in the repository at `e48bdc2`, and nothing in this package changes
the guards those controls disable. A full campaign is thirty-seven builds and
thirty-seven suite runs; measuring the subset this package touches and saying
which is the alternative to a partial answer with no record of which part. The
next full campaign belongs to whoever commits this work, on the same terms
`remediation-6.5-invariants.md` §9 set.

| Control | Result | Expected |
|---|---|---|
| `unconditional-bounded-destroy` | **10 pass / 9 fail** | fail ✔ |
| `cleanup-residue-probe` | **32 pass / 1 fail** | fail ✔ (see below) |
| `undeclared-destruction-detection` | **19 pass / 2 fail** | fail ✔ |
| `actions-agree-with-residue` | **18 pass / 1 fail** | fail ✔ |
| `invalid-finding-phase-gate` | **33 pass / 5 fail** | fail ✔ |
| `invalid-finding-lab-attribution` | **17 pass / 2 fail** | fail ✔ |
| `foreign-resource-classification` | **33 pass / 5 fail** | fail ✔ |

**All seven are load-bearing.** One was not on the first run, and that is the part
worth recording.

### The one that killed nothing, and why

`cleanup-residue-probe` disables the verifier's requirement that an invalid
environment terminal retain the independent post-cleanup observation. On the first
campaign it returned **31 pass / 0 fail**.

The invariant was not the problem. **The suite was.** Every mutation case in
`invalidCleanupDiscipline.test.ts` called `deriveResidueProbe`,
`assertActionsAgreeWithResidue` or `assertInvalidFindingAttribution` *directly* —
the idiom `emergencyCleanupAdversarial.test.ts` established, and a sound one,
because the invalid record cites every artifact by core hash and editing a
retained file surfaces as `GRAPH_CLOSURE_UNREACHABLE_ARTIFACT` before the rule
under test runs. It proves the rules are **right**. It does not prove they are
**reached**, and the control disables the entry point that reaches them.

Two cases were added that go through the front door —
`deriveInvalidEnvironmentSemantics`, the function `verify-record` calls — with the
lifecycle's `cleanup-residue-probe` and `environment-resource-frontier` roles
filtered out in memory, which is a parameter rather than a retained byte, so no
hash layer fires first. The control then kills one named case, as it should.

The expectation was **not** re-scored to `pass`. This is the same distinction
`remediation-6.5B.md` §10a drew and the ADR-ERL2-024 campaign hit four times
(`remediation-6.5-invariants.md` §8): a load-bearing invariant whose tests were
not isolating it. It is why the campaign is worth running even when the code is
right, and it found a genuine hole — a whole class of "the verifier checks X"
claims in this package rested on tests that never asked the verifier.
