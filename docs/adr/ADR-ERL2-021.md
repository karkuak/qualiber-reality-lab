# ADR-ERL2-021 — authorized signer roles for the V2 environment branch, the durable environment phase model, and the comparison mode a self-observing run may claim

**Status:** accepted
**Date:** 2026-07-28
**Deciders:** Lab Core Owner, Integrity/Security Owner, Environment/Challenge Governor, Verifier Reviewer
**Extends:** ADR-ERL2-019 §2 (a retained signed contract with no declared signer role is a
refusal) and ADR-ERL2-020 §6 (a phase advances one durable transition at a time).
Neither is superseded; this fills in the environment branch's rows and applies the
same walk model to it.
**Normative source:** `external-reality-lab-design-v2.md` `2.0.0-draft.11` §9,
§12, §13, §15, §16.3, §22; Slice 6.5 brief §6.

## Context

Slice 6.5-B implements the environment and journey path over durable state. Four
things had to be settled before code could land, because each of them is either
irreversible or silently wrong if guessed.

1. **The environment branch retains five signed contracts the verifier declares
   no role for.** ADR-ERL2-019 §2 makes retaining one a refusal, on purpose, so
   that this table cannot be filled in by accident.
2. **The fake driver had no substrate.** It held its resources, instance identity
   and applied mutations in a `Map` on the instance. That is correct for an
   in-process contract suite and wrong for a CLI where `provision`, `restore` and
   `destroy` are three separate processes: a fresh `destroy` saw an empty
   resource set and reported a clean teardown over resources it had never looked
   at.
3. **The environment validity gate set includes `mandatory-graph-closed`**, but
   the closure cannot be derived against the terminal run record at the moment
   validity is computed — the record cites the index, the index cites the validity
   result, and the validity result is what is being computed.
4. **`ComparisonPolicyV1` has two modes and they are not interchangeable.** A run
   that observes the environment it just provisioned has to claim one of them.

## Decision

### 1. No frozen schema changes

Every role the environment branch needs already exists in the frozen
`trust-policy-manifest/v2` `SignerRole` enum, and every contract it retains
already exists. No schema changed shape or meaning.

### 2. The exact signer role for each signed environment artifact

Derived from each `sealSigned(...)` call site in the shipped producer, not from a
fixture:

| Contract | Field | Required role | Domain |
|---|---|---|---|
| `comparison-policy/v1` | `signature` | `policy_author` | ERL2 |
| `cutoff-policy/v1` | `signature` | `policy_author` | ERL2 |
| `evidence-equivalence-profile/v1` | `signature` | `policy_author` | ERL2 |
| `traffic-process-start-receipt/v1` | `signature` | `traffic_supervisor` | ERL2 |
| `runtime-milestone/v1` | `signature` | `runtime_attestor` | ERL2 |
| `exposure-event/v1` | `signature` | **`vault_authorizer`** | ERL2 |

`environment-driver-manifest/v1`, `environment-archetype/v1`, `substrate-lock/v1`
and `environment-cleanup-contract/v1` were already declared as
`environment_governor` and are unchanged.

There is still no generic "environment artifact" authorization. A signed
environment contract absent from this table stays refused.

### 2a. The cutoff's three inputs take three different roles, and that is the point

Design §13 requires that "wall, monotonic, supervisor, runtime-attestor, and
timestamp-service bounds must agree" before a cutoff is real. Signing the traffic
start receipt and the runtime milestone with one key would make that agreement a
statement about one operator's own bookkeeping rather than a cross-check. The
enum already separates `traffic_supervisor` from `runtime_attestor`; the producer
uses two distinct keys, and the development trust policy grants each of them
exactly one role.

`MonotonicClockDomainV1` is deliberately **unsigned** — it carries no signature
field in the frozen schema. Its authority comes from being referenced by both
signed receipts, which is what makes a clock-domain substitution detectable.

### 2b. `exposure-event/v1` is `vault_authorizer`, not `challenge_governor`

An exposure event demotes the challenge governor's own challenge. An authority
that can silently record its own demotion is precisely what an append-only
exposure ledger exists to prevent, and design §15 makes exposure the thing that
must happen "before another selection". `vault_authorizer` is the frozen role
whose meaning matches: the authority that governs access to sealed truth is the
one that records that a seal was broken.

The exposure event is produced in the **same durable transition** as the reveal,
through `revealJudgeExpectations`'s `alsoProduce` hook. Opening the sealed case
and recording that it is open are one act; recording the exposure in a later
event would leave a window in which a challenge was open and nothing said so.

### 3. `traffic-process-start-receipt/v1` and `runtime-milestone/v1` are supporting schemas

Both are added to the environment closure's `SUPPORTING_SCHEMAS`. A reader must
hold them to re-derive `ObservationBundleV2.cutoff`, but neither is a separately
roled output of the terminal — exactly the definition that set already carries for
`monotonic-clock-domain/v1`.

### 4. The environment path is a phase table, and each phase is one durable transition

`ENVIRONMENT_PHASES` is data, for the same reason `SELECTION_STEPS` is: the
sequence is the thing being asserted, so it should be readable, and a phase can be
neither skipped nor reordered without editing the table. Each phase validates the
state it departs from, produces only its own artifacts, freezes them, and only
then appends its lifecycle event.

**Whether a phase has already run is answered from retained evidence, never from
state ordering.** Several phases depart from a state the run visits more than once
— `step_outcome_frozen` recurs on every journey step — and a state-order test
cannot tell "not yet there" from "already past". A first draft asked
`state !== "case_selected"`, and a run that had never selected a case reported a
missing inventory instead of the wrong state it was actually in.

Three consequences are enforced rather than documented:

- **Resume reads retained evidence.** Re-invoking any phase continues from the
  retained artifacts and the lifecycle head; a completed phase returns what it
  already produced and runs nothing.
- **A phase that executes the subject is refused, not replayed, on a finished
  run.** `assertSubjectPortExecutable` forbids subject execution in every
  post-reveal, cleanup and terminal state, so a "harmless" replay of `install` on
  a finalized run is exactly the post-terminal execution that guard exists to
  stop. Evidence-producing phases replay as no-ops; subject-executing phases
  refuse. Both write nothing.
- **Crash injection at every phase boundary is part of the exit gate**, not a
  follow-up.

### 5. The driver's substrate is durable, and it lives outside the run root

`EnvironmentDriver` gains no operation. The *fake* driver gains a `SubstrateStore`
seam and a file-backed implementation, so its substrate survives process death the
way a Compose project or a Kubernetes namespace does.

The substrate is **not** an ERL2 contract: it carries no `schema_version` and no
`core_hash`, so neither the artifact index nor the offline verifier can mistake
substrate state for evidence. It lives under its own root — by default a sibling
of the run root — because `ArtifactIndex.scan` walks the *whole* run root, and
substrate state inside it would be indexed as evidence. A Compose project inside
the evidence tree would be the same category error.

Nothing in the lifecycle, the finalizer or the verifier knows the file exists. No
fake-driver branch was added outside the driver.

### 6. `deriveEnvironmentClosureProgress` closes the validity/closure circularity

Rather than inventing a second, weaker completeness check for the moment validity
is computed, the verifier exposes the *same* role derivation with the three
finalizer-produced roles and the two not-yet-produced ones
(`validity-result`, `generic-evaluation-index`) excluded. A role missing there is
missing in the final derivation too.

The finalization path also had to become idempotent for a reason worth recording:
recomputing the closure on an already-finalized run derives it against a tree that
now contains the validity result and the index themselves, scores
`mandatory-graph-closed` false, and turns a replay of a *valid* run into an
invalid one. The guard returns the retained pair instead.

### 7. A run that observes its own environment claims `live_ecosystem`, not `replay_comparison`

`replay_comparison` means every run binds one **pre-admitted** comparison-level
envelope whose bytes are identical across subjects (§13), and the schema enforces
it: the mode requires `replay_envelope_hash` and forbids the equivalence fields.
A run that observes the environment it just provisioned does not have that
envelope and must not claim it.

So the development comparison policy is `live_ecosystem` + `blind_capable`, and
the run freezes its own `LiveCanonicalEvidenceEnvelopeV1` under an admitted
`EvidenceEquivalenceProfileV1`.

**No `SemanticEvidenceEquivalenceReceiptV1` is produced.** Equivalence is a claim
about two independently observed environments; a single run has nothing to be
equivalent to, and emitting a receipt would be fabricating the comparison. The
`independent_equivalence_verifier_hash` names an unactivated component. Live
equivalence remains realism/calibration evidence, cannot satisfy ERL2-AC-010, and
its verifier is Slice 9 work.

### 8. The fake subject answers `unsupported` from the adapter's own declaration

`FakeSubjectBehaviour` gains `declaredOperations`. An intent outside the run's
admitted `SubjectAdapterManifestV1.operations` is answered `unsupported` — a real
outcome derived from the subject's own declaration rather than a scripted
failpoint, and the only way "every intent has a legal unsupported outcome" is
reachable on the release surface, where the `--fake-*` flags are refused.

## Consequences

- The environment branch reaches `generic_evaluation_index_frozen` through the
  shipped binary. It does **not** reach `generic_finalized`: no environment run
  record, attestation, signer inventory or public bundle is produced, so
  `verifyEnvironmentBundle` remains dead code and the three §15.4 mutations that
  need an environment terminal remain open. That is 6.5-E.
- A future signed environment contract must add a row to §2 before it can be
  retained. The deliberate speed bump is preserved, not spent.
- Three new keys enter the development trust policy (`traffic_supervisor`,
  `runtime_attestor`, `vault_authorizer`), which changes the run trust policy hash
  and therefore every golden. The evidence pin was regenerated deliberately under
  `evidence:update`; coverage is unchanged at 780 pinned / 7 excluded.
- `FIXED_PAYLOAD_PLAINTEXT_BYTES` rises from 1024 to 2048. A candidate whose
  payload did not fit would be *refused* rather than padded, which would make
  journey length a selection-visible property. It is raised, never narrowed
  towards the current maximum, because the padding is what makes every entry's
  selector-visible length identical.
- ERL2-OQ-005 stays fail-closed (Compose disabled, fake driver only), ERL2-OQ-007
  stays fail-closed (development tier only), and ERL2-OQ-008 stays open (no
  container launcher; isolation evidence remains dev-signed
  `locally_observed_unauthenticated`).

## Evidence

- `tests/e2e/environmentRun.test.ts` — the full path from `case_selected` to
  `generic_evaluation_index_frozen` through the shipped binary in separate
  processes; crash injection at all 21 phase boundaries, each resuming from
  retained evidence with exactly one of each once-only artifact; a replayed
  finished run adding zero bytes; every refused command adding zero retained
  evidence, measured by full-tree byte manifest on a fresh run and again mid-path.
- `tests/adversarial/environmentCommands.test.ts` — nine mutations, each asserting
  a specific Appendix B code.
- `docs/ledger/remediation-6.5B.md` — the negative control for every new guard:
  each was disabled in turn and the result recorded, **including the two that
  turned out not to be load-bearing**.
