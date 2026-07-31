# ADR-ERL2-031 — the signed evidence-window commitment: an exact offline cutoff derivation, and the composition constant it replaces

- **Status:** accepted
- **Date:** 2026-07-30
- **Deciders:** Lab Architecture, Verification Audit, Evidence/Clock Authority
- **Supersedes:** nothing
- **Amends by record:** [ADR-ERL2-029](ADR-ERL2-029.md) §3.2 and §9 — its
  bounds-exact derivation is correct and stays; this ADR answers the successor
  question §9 recorded and closes the residual §3.2 named
- **Builds on:** [ADR-ERL2-021](ADR-ERL2-021.md), [ADR-ERL2-022](ADR-ERL2-022.md),
  [ADR-ERL2-023](ADR-ERL2-023.md), [ADR-ERL2-024](ADR-ERL2-024.md),
  [ADR-ERL2-027](ADR-ERL2-027.md), [ADR-ERL2-028](ADR-ERL2-028.md),
  [ADR-ERL2-029](ADR-ERL2-029.md), [ADR-ERL2-030](ADR-ERL2-030.md)
- **Findings closed:** the cutoff residual ADR-ERL2-029 §3.2 states and §9 records
  as the successor question — the exact evidence window is retained nowhere, so an
  offline reader can prove the cutoff is *consistent with* every committed bound
  and cannot rederive the window that was actually selected
- **Normative revision:** `2.0.0-draft.13`

---

## 1. Context

ADR-ERL2-029 §3 gave the offline verifier its own derivation of the evidence
cutoff and was explicit about where that derivation stops:

> **This boundary is stated rather than blurred.** What is proven is that the
> retained cutoff is consistent with three independently signed clocks and with
> every committed bound. What is *not* proven is that the operator chose a
> 1-second warmup rather than a 900 ms one.

### 1.1 The residual, exactly

`realizeCutoff` computes

```
instant = process_started_at + warmupMs + observationMs
```

and both durations arrive as `WARMUP_MS = 1_000` / `OBSERVATION_MS = 5_000` from
`environmentRun.ts:233` — **constants of the composition**, retained in no
contract. The verifier therefore cannot recompute the scalar. It decomposes
against a third independently signed instant instead:

```
warmup      := milestone.occurred_at − receipt.process_started_at
observation := bundle.cutoff.instant − milestone.occurred_at
```

That decomposition is sound, and the bounds it checks are real. But both derived
durations are read *out of the very instants under examination*. A producer that
selected a 900 ms warmup and a 5 100 ms observation, and moved the milestone to
match, produces a terminal in which every one of ADR-ERL2-029 §3.2's seven checks
passes. The cutoff moves, the milestone moves with it, the arithmetic closes, and
no retained byte disagrees.

This is the `lab_validity` shape one level down. ADR-ERL2-024 removed producer
*fields* the verifier was reading as findings; ADR-ERL2-030 removed the last one.
What is left here is not a field — it is a producer *choice* that leaves no trace
at all, which is strictly worse: a field can at least be contradicted.

### 1.2 Why this could not be closed inside the verifier

ADR-ERL2-029 §9 says so directly, and it is worth restating because it is the
reason this package is producer-side:

> a producer free to choose the durations is also free to choose ones that
> satisfy any recomputation. Closing it properly means *committing* the durations
> before the environment is seen, which is a producer change (a signed window
> commitment), not a verifier one.

No verifier-only rule can distinguish a window from a differently-chosen window
when neither is written down. The missing artifact is the point.

---

## 2. Scope and non-goals

### In scope

- A new additive signed contract carrying the **exact** evidence-window
  composition, frozen before capture.
- Producer construction, freeze ordering, and cutoff construction *from the
  frozen commitment* rather than from module constants.
- An **independent** verifier-side exact derivation of the cutoff, the milestone
  boundary and the observation window.
- Lifecycle reachability, closure applicability, signer-inventory inclusion, and
  invalid-terminal accounting for the new member.
- Golden and byte-pin migration.

### Explicit non-goals

- **Governance over *which* window is permissible.** See §3.4. A signed
  commitment proves what was committed and that later evidence matches it. It
  does not, and is not claimed to, stop an authorized signer from committing a
  different window on purpose. That is policy and signer authority, not
  arithmetic.
- **The producer-side scanning cluster.** `mounted_file` scanned with metadata
  that cannot contain the mount, `lab_telemetry` with no negative control, secret
  canaries and forbidden identifiers unscanned on the environment subject-output
  surface, and the declared subject-output size ceiling hashed and unenforced.
  All named open in ADR-ERL2-029 §2 and ADR-ERL2-030 §2, and all still open.
- **The remaining P3 drift**, and crash coverage for `provision`, `restore`,
  `destroy` and the emergency actions.
- **New evidence classes, live oracle surfaces, evaluated-domain activation.**
  ERL2-OQ-005, ERL2-OQ-007 and ERL2-OQ-008 stay fail-closed.
- **Any claims-ceiling movement.** This package adds a retained commitment and
  verifier refusals. It measures no new environment, subject or robustness, so
  the ceiling stays **T1**.

---

## 3. Decision: the exact window is committed, signed and retained

### 3.1 The artifact

**`evidence-window-commitment/v1`**, contract **ERL2-C-159**, defined in
`packages/contracts/schemas/evidence.schema.json` as `EvidenceWindowCommitmentV1`.

Additive. **No frozen schema changes shape or meaning** — the observation bundle,
the cutoff policy, the process-start receipt, the runtime milestone, the run
record, the attestation and the public bundle are all untouched. ADR-ERL2-029 §9
weighed "a new observation-bundle identity or major" and rejected it; a separate
additive contract buys the same invariant with no migration of an existing
identity, which is why the rejected alternative there is not the decision here.

Fields, and why each is present:

| field | why |
|---|---|
| `schema_version` | `evidence-window-commitment/v1` |
| `commitment_id` | stable id, run-scoped |
| `run_id` | run binding; a commitment from another run is refused |
| `cutoff_policy_hash` | the bounds this window claims to sit inside |
| `process_start_receipt_hash` | the instant the window is measured *from* |
| `monotonic_clock_domain_hash` | the clock domain both halves are read in |
| `comparison_policy_hash` | the observation policy the capture will run under |
| `environment_instance_hash` | environment/subject binding, as the bundle carries |
| `warmup_ms` | **the exact committed warmup** |
| `observation_ms` | **the exact committed observation window** |
| `instant_rule` | the rule the durations feed, pinned to the policy's own |
| `milestone_relationship` | pinned: the milestone marks the warmup boundary |
| `committed_at` | when the window was frozen |
| `core_hash` | canonical identity, as every contract |
| `signature` | `policy_author`, under `ERL2` |

The contract carries **no** candidate output, judge truth, post-observation fact,
filesystem path, or reference to itself. Every hash it carries names an artifact
that exists *before* it does, which is what makes the freeze orderable at all.

### 3.2 The durations are whole seconds, and the schema says so

`erl2:common#/$defs/Instant` is RFC 3339 with **second** precision and a literal
`Z`. The producer renders instants with

```js
new Date(instantMs).toISOString().replace(/\.\d{3}Z$/, "Z")
```

which does not round — it **truncates**. A 900 ms warmup would produce
`…T00:00:00.900Z`, the replace would silently yield `…T00:00:00Z`, and the
retained instant would disagree with the arithmetic that produced it by 900 ms.

So `warmup_ms` and `observation_ms` are `multipleOf: 1000` in the frozen schema,
and both the producer and the verifier check it again in integer arithmetic. This
is not tidiness: a commitment whose derived instants are not representable at the
contract's own precision is a commitment no reader can check, and the honest
place to refuse it is before it is signed.

Bounds: `warmup_ms` in `[0, 5_400_000]` and `observation_ms` in `[1_000,
5_400_000]`, matching `CutoffPolicyV1.maximum_warmup_ms` and
`maximum_observation_ms`, which share that ceiling. Every sum is checked against
`Number.MAX_SAFE_INTEGER` before it is taken.

### 3.3 What is now derivable, exactly

Given the commitment, the process-start receipt and the policy, an offline reader
recomputes with no freedom left:

```
cutoff.instant            === process_started_at + warmup_ms + observation_ms
milestone.occurred_at     === process_started_at + warmup_ms
observation window .from  === process_started_at
observation window .to_exclusive === cutoff.instant
```

The first is the residual, closed. The second is the milestone binding: the
runtime milestone is still an **observation** — the producer does not compute it
— but the commitment is the expectation that observation must satisfy, and a
producer whose milestone lands anywhere else refuses before it freezes. Deriving
the milestone instead of observing it would be the defect this repository keeps
removing, one contract further on.

### 3.4 What a commitment does not prove

Stated here rather than left to be inferred, on the same terms as ADR-ERL2-029
§3.2:

**A fully authorized `policy_author` that deliberately commits a 900 ms warmup
produces a terminal that verifies.** The commitment proves that a window was
fixed under an authorized key before capture, that its bytes are hash-bound into
the terminal chain, and that every later instant matches it exactly. It does not
prove the window was *the right one*. Which windows are permissible is the cutoff
policy's business — `maximum_warmup_ms`, `minimum_observation_ms`,
`maximum_observation_ms` — and who may commit one is the trust policy's.

What changes is that the choice is now **on the record and signed**, where before
it was a module constant that left no trace. A reader who disagrees with the
window can now see it and say so.

---

## 4. Decision: the signer is `policy_author`

No new key. `policy_author` already signs the cutoff policy that bounds this
window, the comparison policy the capture runs under, the evidence-equivalence
profile and the generic run policy. Committing the exact window inside bounds the
same authority already set is the same kind of statement one notch more specific.

It is **not** `traffic_supervisor` and **not** `runtime_attestor`, and that is the
load-bearing part. The verifier's signer table already says why:

> The cutoff is derived from three *separately* signed artifacts by design (§13),
> so they take three different roles. Collapsing them onto one signer would make
> "wall, monotonic, supervisor and runtime-attestor bounds must agree" a statement
> about one operator's own bookkeeping.

The window chooser must not also be a clock stamper. A `traffic_supervisor` that
both committed the window and signed the instant it is measured from could move
both together and leave the arithmetic closing — which is the residual, restored
under a different name.

`policy_author` gains no authority over challenge truth, subject output,
evaluation outcome, the final attestation or beacon randomness. It holds none of
those roles now and this ADR grants none.

Both role tables — the producer's `PRODUCER_SIGNED_MEMBER_ROLES` and the
verifier's `SIGNED_MEMBER_RULES` — gain the row independently, and
`tests/architecture/signerInventoryIndependence.test.ts` already asserts they
agree schema for schema.

---

## 5. Decision: the lifecycle position

The commitment is frozen inside the `journey` command, **after** the process-start
receipt exists and **before** the runtime milestone is observed. It is named in
the `produced` list of the `traffic_or_journey_started` event, under the role
`evidence-window-commitment`.

Order, as enforced:

1. environment prerequisites (activation, plan, baseline, binding);
2. cutoff policy and comparison policy resolved — already up front, since
   ADR-ERL2-028's `refusal-before-cutoff-freeze` rule;
3. monotonic clock domain and process-start receipt sealed;
4. exact durations resolved from committed configuration, and their bounds,
   integrality and whole-second representability checked;
5. **the commitment is sealed** — its bytes and its signature exist, and the
   window is fixed from this point on;
6. runtime milestone observed, and refused unless it lands exactly on the
   committed warmup boundary;
7. commitment and milestone written, and the lifecycle event
   `traffic_or_journey_started` names both as produced;
8. `observe` realizes the cutoff *from the frozen commitment*;
9. source snapshots use the derived window;
10. `freeze-observation` freezes the bundle.

### 5.1 Why the commitment is sealed at step 5 but written at step 7

The window must be fixed before the milestone is read, or the milestone could be
chosen to fit it — that is the residual. But writing the commitment before the
milestone check would mean a refused milestone leaves retained bytes no lifecycle
event ever reaches, which is exactly the P1-10 defect ADR-ERL2-028 §3 removed: *a
resolution that can throw must never sit between two freezes.*

Both hold at once because **sealing and writing are different acts**. The
commitment's bytes and signature are computed at step 5, before the milestone is
observed, so the window is genuinely fixed first. Nothing reaches the disk until
both artifacts exist and neither can still refuse. A run whose milestone misses
the committed boundary writes nothing at all.

What a reader gets from this is not a claim about which line ran first — that is
unobservable and would be worthless as evidence. It is the arithmetic in §3.3:
`milestone.occurred_at === process_started_at + warmup_ms`, checked against a
commitment signed by a party that stamps neither clock.

No new lifecycle state is introduced. `LAB_STATES` and the transition table are
design v2 §12 normative and adding a state to carry one artifact would be a
larger normative change than the artifact warrants; the commitment is a produced
artifact of an existing transition, exactly as the clock domain, the receipt and
the milestone already are.

**Pre-capture ordering is derived from the event chain**, not from timestamps:
the event that produced the commitment must precede `evidence_cutoff_realized`
and `observation_frozen`, and the reveal and terminal events come later by
construction of the state machine.

---

## 6. Decision: terminal applicability

`evidence-window-commitment` is an environment **optional role**, on exactly the
terms `challenge-activation-receipt` is (ADR-ERL2-023, and the review-P2 fix that
made it conditional rather than merely supporting):

| lifecycle | rule |
|---|---|
| reached `traffic_or_journey_started` | **exactly one** commitment is required |
| terminated before it | no commitment; none is fabricated |
| observation bundle retained | commitment required, and the bundle's window must match it |
| valid environment terminal | in closure when required |
| invalid environment terminal that reached it | accounted as a produced artifact, like every other reached role |
| invalid environment terminal before it | absent, and its absence is not a defect |
| pre-environment terminal | **forbidden role** — a pre-environment run has no environment window |

A run that reached traffic and dropped its commitment is
`GRAPH_CLOSURE_MISSING_ROLE`. A commitment that no lifecycle event produced is
`GRAPH_CLOSURE_UNREACHABLE_ARTIFACT`. Two commitments are
`GRAPH_CLOSURE_EXTRA_ARTIFACT`. A pre-environment terminal carrying one is
`GRAPH_CLOSURE_TERMINAL_MISMATCH`.

---

## 7. Decision: the two derivations stay independent

ADR-ERL2-030 §5's rule applies unchanged, and for the same reason: a verifier that
agreed with the producer because it called the producer would be re-reading a
producer field with extra steps.

**Permitted sharing:** frozen contract types and registered identities, canonical
hashing, signature primitives, and integer duration arithmetic that carries no
verdict.

**Forbidden:** importing the producer's expected-cutoff function; trusting any
scalar the producer wrote into the bundle; treating policy-bound consistency as
exact equality; accepting a missing commitment because an older environment
bundle lacked one.

The verifier's exact derivation lives beside its bounds derivation in
`cutoffDerivation.ts` and reads only retained evidence plus its own pinned trust
and policy. `tests/architecture/` asserts the non-import in both directions.

---

## 8. Contract and artifact impact

One new contract identity, one new registry entry, one new generated type. **No
frozen schema changes shape or meaning.** No new error code: every refusal reuses
a catalogued one.

| concern | code |
|---|---|
| commitment missing on a run that reached traffic | `GRAPH_CLOSURE_MISSING_ROLE` |
| two commitments, or one on a pre-environment terminal | `GRAPH_CLOSURE_EXTRA_ARTIFACT` / `GRAPH_CLOSURE_TERMINAL_MISMATCH` |
| commitment retained but never lifecycle-reached | `GRAPH_CLOSURE_UNREACHABLE_ARTIFACT` |
| commitment from another run | `GRAPH_CLOSURE_TERMINAL_MISMATCH` |
| wrong signer role, or a key not granted it | `TRUST_KEY_NOT_AUTHORIZED_FOR_ROLE` |
| invalid signature, undeclared authority field | `TRUST_SIGNATURE_INVALID` |
| commitment omitted from the signer inventory | `INVENTORY_ENTRY_MISSING` |
| policy / receipt / clock-domain / observation binding disagreement | `CUTOFF_MILESTONE_MISMATCH` |
| exact cutoff, milestone or observation-window mismatch | `CUTOFF_BOUND_EXCEEDED` |
| duration out of bounds, not a whole second, overflow | `CUTOFF_BOUND_EXCEEDED` |
| commitment frozen after capture began | `POLICY_CONFLICT` |

### 8.1 Goldens and the byte pin

The run gains a retained file and a `.frozen` marker, and the causal chain is:

```
evidence-window-commitment (new retained file + .frozen marker)
  → traffic_or_journey_started event `produced` gains a row
  → every lifecycle event hash downstream of it
  → signer inventory gains a member → inventory core hash
  → final attestation → attestation core hash
  → public bundle (+ member descriptors) → terminal lifecycle event
```

**The byte pin nonetheless does not move: `EXPECTED_PINNED` stays 787 and
`EXPECTED_EXCLUDED` stays 7, with the exclusion-manifest digest unchanged.**

This was measured rather than predicted, and the first draft of this section
predicted the opposite. The environment golden is a **shape-only closure summary**
(`fixtures/golden/environment-run/closure-summary.json`), not a byte-pinned copy
of the run tree — the generator says so in its own comment, because the tree
carries absolute paths and per-run identities. So a run that retains one more
artifact adds one *row* to that summary and no files at all.

The regenerated delta is exactly three files, and every one is accounted:

| file | change | pinned? |
|---|---|---|
| `environment-run/closure-summary.json` | `evidence-window-commitment` gains a `required_roles` row (count 1) and a `produced` entry | yes — the only pinned byte that moved |
| `cli-transcript.json` | `registered_contracts` 154 → 155, plus its usual instants and paths | no — excluded for absolute CLI path arguments |
| `…/op-acquire/output/grandchild.pid` | a fresh OS pid | no — excluded because it is a real pid |

**The seven exclusions are not widened**, and both excluded files churn in every
prior remediation package for the reasons already recorded against them.

**Pre-environment goldens do not move.** A pre-environment run reaches no
environment and freezes no commitment. Measured: `evidence:verify` reported one
mismatch, zero missing and zero unexpected, so nothing on that branch moved. Any
movement there would be unexplained and investigated rather than accepted.

---

## 9. Rejected alternatives

**Add `warmup_ms` / `observation_ms` to `ObservationBundleV2`.** ADR-ERL2-029 §9's
own formulation of the fix, and rejected here on the ground that ADR-ERL2-029
itself named: it needs a new observation-bundle identity or major, a compatibility
matrix and an ADR-ERL2-022-class migration. It is also **the wrong place**: the
bundle is frozen *after* capture, so durations carried there are a post-hoc
statement about a window that has already been used. The commitment must precede
the thing it governs or it commits nothing.

**Derive the runtime milestone from the committed warmup instead of observing
it.** Tempting — it would make the milestone boundary true by construction and
delete a refusal. Rejected: the milestone is a signed observation by the
`runtime_attestor`, and computing it from a value the `policy_author` chose would
make one party's arithmetic look like two parties' agreement. The producer
observes, then compares, then refuses.

**Let the producer keep `WARMUP_MS` / `OBSERVATION_MS` and merely *also* commit
them.** Rejected, and it is the subtle one. Two sources of the same value drift,
and the one the cutoff is actually built from is the one that matters. The
constants are removed; the frozen commitment is resolved by hash and is the only
input `realizeCutoff` receives. A negative control patches the producer back to
the constants specifically to prove the frozen commitment is load-bearing.

**Accept an environment bundle with no commitment, for compatibility.** Rejected
outright. A legacy-acceptance mode reopens exactly the residual this package
closes, and there is no deployed population to be compatible with — the goldens
are regenerated in the same commit. An environment terminal that reached traffic
and retains no commitment fails closed.

**Sub-second windows, with the instant rendered at millisecond precision.**
Rejected: it would change `erl2:common#/$defs/Instant`, which every retained
contract in the system uses. The whole-second rule in §3.2 costs a constraint on
one new contract instead of a major on all of them.

**A new `evidence_window_committed` lifecycle state.** Rejected: `LAB_STATES` and
the transition table are design v2 §12 normative, and the commitment is a produced
artifact of an existing transition exactly as the clock domain, the receipt and
the milestone already are. Pre-capture ordering is provable without it.

**Give the commitment its own signer key.** Rejected under §11's rule against
inventing a key for convenience. `policy_author` is the authority that already
bounds this window, and adding a key would grow the trust policy without adding a
separation that matters — the separation that matters is from the two clock
signers, and `policy_author` already has it.

---

## 10. Mutation and negative-control gates

The package is not accepted on the strength of the rules being written. It is
accepted on:

- a **semantic mutation matrix** over a real CLI-produced environment bundle,
  each case re-sealing the full chain — commitment → inventory → attestation →
  bundle → **member descriptors** → terminal lifecycle event — so that every
  refusal is the rule it names and not a stale hash;
- an **identity case** (`WINDOW-HARNESS`: re-sealing the chain unchanged still
  verifies), without which every other refusal in the file could be an artefact
  of the re-signing;
- **thirteen new negative controls**, each disabling exactly one guard;
- and one control that matters more than the rest: **replacing the verifier's
  exact comparison with ADR-ERL2-029's bounds-only derivation.** A within-bounds
  shifted window — warmup 2 000 / observation 4 000, milestone and cutoff moved to
  match, commitment left at 1 000 / 5 000 — must then verify, and the control must
  die. If it does not, the exact derivation is not doing the work this ADR claims
  and the residual is still open.

Every control patch targets through the hardened unique-target mechanism
(`scripts/lib/controlTarget.mjs`): a patch with zero or several matches is a
harness error and fails the campaign, never a result.

---

## 11. Consequences

- ADR-ERL2-029 §3.2's residual is closed. The offline verifier rederives the
  exact evidence window rather than proving it falls within bounds, and a
  within-bounds shifted window no longer escapes comparison.
- ADR-ERL2-024 §4.6's table gains a row that is not a producer field but a
  producer *choice*: the evidence window is now retained, signed and rederived.
- The composition constants `WARMUP_MS` and `OBSERVATION_MS` are gone. The window
  a run used is a signed artifact of that run.
- One member is added to every environment signer inventory, and the environment
  byte pin moves for the first time since ADR-ERL2-027.
- **The claims ceiling is unchanged: T1.** This package retains one more signed
  artifact and adds verifier refusals. It measures no new environment, no new
  subject and no new robustness. It does not make the Lab's window *correct* —
  see §3.4 — it makes it *checkable*.
