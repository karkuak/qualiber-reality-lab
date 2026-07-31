# Ledger — Step 6A: the signed evidence-window commitment

Companion to [ADR-ERL2-031](../adr/ADR-ERL2-031.md). Successor to
[`remediation-6.5-signer-inventory.md`](remediation-6.5-signer-inventory.md).

Closes the residual ADR-ERL2-029 §3.2 stated and §9 recorded as the successor
question: the exact evidence window was retained nowhere, so an offline reader
could prove the cutoff *consistent with* every committed bound and could not
rederive the window that was actually selected.

---

## 1. What was open

ADR-ERL2-029 §3.2 said it in its own words rather than leaving it to be inferred:

> **This boundary is stated rather than blurred.** What is proven is that the
> retained cutoff is consistent with three independently signed clocks and with
> every committed bound. What is *not* proven is that the operator chose a
> 1-second warmup rather than a 900 ms one.

The cause was one line. `realizeCutoff` computes

```
instant = process_started_at + warmupMs + observationMs
```

and both durations arrived as `WARMUP_MS = 1_000` / `OBSERVATION_MS = 5_000` from
`environmentRun.ts:233` — **constants of the composition**, in no contract. So
the verifier decomposed them back out of the very instants it was checking:

```
warmup      := milestone.occurred_at − receipt.process_started_at
observation := bundle.cutoff.instant − milestone.occurred_at
```

That decomposition is anchored on three separately signed clocks and is sound as
far as it goes. What it cannot see is a producer that selected a different window
*and moved the milestone with it*. Every bound still holds; nothing disagrees.

This is the `lab_validity` shape one level down — and worse, because it is not a
producer *field* a verifier could contradict, it is a producer *choice* that left
no trace at all.

**No verifier-only rule could close it.** ADR-ERL2-029 §9 says so: a producer free
to choose the durations is free to choose ones that satisfy any recomputation.
The missing artifact was the point.

## 2. What changed

| Concern | Before | Now |
|---|---|---|
| the exact window | `WARMUP_MS` / `OBSERVATION_MS`, module constants, retained nowhere | a signed `evidence-window-commitment/v1`, frozen before capture |
| the cutoff's inputs | composition constants passed to `realizeCutoff` | the run's own **frozen** commitment, resolved by role |
| offline derivation | bounds-exact: durations read back out of the instants under examination | **exact**: cutoff, milestone boundary and capture window each recomputed from `process_started_at` + two committed durations |
| the milestone | observed, and checked only against bounds | observed, and required to land **exactly** on the committed warmup boundary |
| a within-bounds shifted window | verified valid | `CUTOFF_BOUND_EXCEEDED` |
| the window's authority | none — a constant has no signer | `policy_author`, the role that already bounds it, and pointedly not a clock-stamping role |
| signer inventory | n/a | an applicable signed member, via the general derivation |
| closure | n/a | an environment optional role, **required** once the lifecycle shows `traffic_or_journey_started`; forbidden on the pre-environment branch |

## 3. The contract (ADR-ERL2-031 §3.1)

`evidence-window-commitment/v1`, **ERL2-C-159**, additive. `packages/contracts/`
gains one `$defs` entry, one registry row and one generated type — 225 → **226**
contract types. **No frozen schema changes shape or meaning**, and no new error
code: every refusal reuses a catalogued one.

### 3.1 The durations are whole seconds, and that is not tidiness

`erl2:common#/$defs/Instant` is RFC 3339 at **second** precision, and the producer
renders instants with

```js
new Date(instantMs).toISOString().replace(/\.\d{3}Z$/, "Z")
```

which does not round — it **truncates**. A 900 ms warmup would produce
`…T00:00:00.900Z`, the replace would silently yield `…T00:00:00Z`, and the
retained instant would disagree with the arithmetic that produced it by 900 ms.

So both durations are `multipleOf: 1000` in the frozen schema, and both the
producer and the verifier restate it in integer arithmetic. A commitment whose
derived instants are not representable at the contract's own precision is a
commitment no reader can check, and the honest place to refuse it is before it is
signed.

This was found by reading the contract, not by a failing test — which is why it is
recorded here rather than in a fix note.

## 4. The producer

`packages/core/src/capture/evidenceWindow.ts`:

1. validates the configured durations on their own terms — integer, non-negative,
   whole seconds, within the contract's ceiling;
2. validates them against the **policy's** bounds, which is a different statement
   and can fail independently;
3. checks clock-domain and run binding;
4. proves the derived instants are representable, in checked integer arithmetic;
5. **seals** the commitment under `policy_author`;
6. and only then does the run observe the milestone and require it to land on the
   committed warmup boundary.

### 4.1 Sealed before the milestone, written after it

The window must be fixed before the milestone is read, or the milestone could be
chosen to fit it — that is the residual. But writing the commitment before the
milestone check would leave retained bytes behind on a refusal, which is exactly
the P1-10 defect ADR-ERL2-028 §3 removed: *a resolution that can throw must never
sit between two freezes.*

Both hold because **sealing and writing are different acts**. The bytes and the
signature exist before the milestone is observed; nothing reaches the disk until
both artifacts exist and neither can still refuse. A run whose milestone misses
its own committed boundary writes nothing at all.

### 4.2 What the producer deliberately does not do

**Compute the milestone.** Deriving `occurred_at` from the committed warmup would
make the boundary true by construction and delete a refusal. It is refused as a
design: the milestone is signed by the `runtime_attestor`, and computing it from a
value the `policy_author` chose would make one party's arithmetic look like two
parties' agreement. The run observes, compares, and refuses.

## 5. The verifier

`packages/public-verifier/src/library/windowDerivation.ts` — independent, with its
own arithmetic and its own role table. It resolves the commitment by hash,
authorizes its signer, and checks, in this order: run binding, cutoff-policy
binding, process-start binding, clock-domain binding, comparison-policy binding,
environment-instance binding, lifecycle reachability, pre-capture ordering,
duration bounds/integrality/representability, and then

```
milestone.occurred_at  === process_started_at + warmup_ms
cutoff.instant         === process_started_at + warmup_ms + observation_ms
snapshot.window.from   === process_started_at
snapshot.window.to_exclusive === cutoff.instant
```

Ordered **after** `deriveEvidenceCutoff`, so a missing or unresolvable cutoff
input keeps its own, more fundamental cause rather than surfacing as a window
mismatch.

### 5.1 Applicability is read from the lifecycle, never from the retained set

A run that reached `traffic_or_journey_started` must have exactly one commitment;
one that did not must have none. Deciding which case applies by looking at what is
*retained* would let an omission answer its own question — the shape ADR-ERL2-029
§1.1 names for `complete_for_terminal_chain`.

### 5.2 The invalid branch needs no special case

`deriveInvalidClosure` accounts a retained artifact if the record's
`available_evidence` names it, and `available_evidence` is built by walking every
lifecycle event's `produced` list. Naming the commitment there makes both halves
fall out of the general derivation: an invalid terminal that reached traffic
accounts for its commitment, and one that failed earlier fabricates none.

**This is why the commitment is a produced artifact rather than a supporting
schema.** A supporting-schema entry would have accounted for it unconditionally —
including on runs that never committed one, which is precisely the shape that
hides an omission.

## 6. Goldens and the byte pin

**787 pinned / 7 excluded, unchanged.** The exclusion-manifest digest is
unchanged and the seven exclusions are not widened.

That is not what this package expected. The ADR's first draft predicted the pin
would move, because the run genuinely retains one more file. It does not, and the
reason is worth recording: the environment golden is a **shape-only closure
summary**, not a byte-pinned copy of the run tree. A run that retains one more
artifact adds a *row* to that summary and no files.

The regenerated delta is three files:

| file | change | pinned? |
|---|---|---|
| `environment-run/closure-summary.json` | `evidence-window-commitment` gains a `required_roles` row and a `produced` entry | **yes** — the only pinned byte that moved |
| `cli-transcript.json` | `registered_contracts` 154 → 155, plus its usual instants and paths | no — excluded, absolute CLI path arguments |
| `…/op-acquire/output/grandchild.pid` | a fresh OS pid | no — excluded, a real pid |

Measured, not assumed: `evidence:verify` before regeneration reported **1
mismatch, 0 missing, 0 unexpected**, so no pre-environment golden moved and no
file was added or removed. The generator's own expected-refusal count is
unchanged at 91 CLI invocations / 11 expected refusals, with the same codes as
the baseline — so nothing that used to succeed now refuses, and nothing that used
to refuse now succeeds.

## 7. A defect this package's own verifier caught

The first end-to-end run refused with

```
CUTOFF_MILESTONE_MISMATCH: the evidence-window commitment and the observation
bundle name different environment instances
```

The producer had bound the commitment to `environment_fingerprint_hash` (the
baseline) where the observation bundle carries `environment_instance_hash` (the
resource inventory). Two different artifacts, one of them wrong.

Recorded because it is evidence about the binding check rather than an
embarrassment: the environment-instance binding is load-bearing, and it proved so
against its own producer within minutes of existing.

## 8. Claims

The cutoff claim moves from **bounds-exact** to **exact**, and gains two explicit
limits it does not earn:

- it does **not** stop an authorized `policy_author` from committing a different
  window on purpose. The commitment proves a window was fixed under an authorized
  key before capture and that every later instant matches it exactly — not that
  the window was the right one. Which windows are permissible is the cutoff
  policy's bounds; who may commit one is the trust policy's;
- it does **not** demonstrate key custody. The development composition holds the
  `policy_author` key in the same process as the run, as it already does for the
  governor, controller, supervisor and attestor keys.

**The claims ceiling is unchanged: T1.** This package retains one more signed
artifact and adds verifier refusals. It measures no new environment, no new
subject and no new robustness. It does not make the Lab's window *correct* — it
makes it *checkable*.

## 9. What this package does not claim

- **The producer-side scanning cluster is untouched**: `mounted_file` scanned with
  metadata that cannot contain the mount, `lab_telemetry` with no negative
  control, secret canaries and forbidden identifiers unscanned on the environment
  subject-output surface, and the declared subject-output size ceiling hashed and
  unenforced.
- **The remaining P3 drift** and crash coverage for `provision`, `restore`,
  `destroy` and the emergency actions.
- **ERL2-OQ-005, ERL2-OQ-007, ERL2-OQ-008** — unchanged, still fail-closed.
