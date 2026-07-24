# ADR-ERL2-015 — where generic evaluation authority lives, and how a data-only pack is bounded

**Status:** accepted
**Date:** 2026-07-23
**Deciders:** Lab Core Owner, Evaluation Reviewer, Integrity/Security Owner
**Normative source:** `external-reality-lab-design-v2.md` revision `2.0.0-draft.11` §8, §16.2, §17; implementation plan §4.1, §12

## Context

Design v2 §17 requires deterministic, product-independent generic evaluation
with four isolated result planes, and it forbids a pack from holding network,
filesystem, process, clock, randomness, mutation, threshold or validity
authority. It does not say *where* the evaluator lives, *how* a pack expresses a
rule without becoming code, or *who* owns a metric threshold.

Implementation plan §4.1 fixes the allowed dependency direction as
`contracts <- integrity <- core` and `contracts <- evaluation-sdk <- packs/*`.
Core may not depend on `evaluation-sdk`, and `evaluation-sdk` may not depend on
`integrity`. Slice 6 had to decide four things inside those constraints, and
each is expensive to reverse once packs and frozen results exist.

## Decisions

### 1. The evaluator lives in `@erl2/core`; the pack is data it reads

`@erl2/core` implements every predicate, input selector, measure, ordering key
and metric computation. A pack selects identifiers from closed vocabularies; it
never supplies behaviour.

This is what makes ERL2-OQ-004's fail-closed state structural rather than
procedural. There is no pack runtime to sandbox, because a pack is a closed
`EvaluationPackBodyV1` and the contract has no member of a code, path, URL,
clock, seed, validity or threshold shape. `tests/architecture/evaluationBoundary.test.ts`
asserts that directly against the schema.

The alternative — an evaluation-sdk that executes pack logic — would have put
the sandbox boundary inside a package that core cannot depend on, and would have
required core to trust an execution result rather than compute one.

### 2. Generic metric definitions are Lab-owned, and a pack may only reference them

`GENERIC_METRIC_DEFINITIONS` in `@erl2/core` holds the frozen
`MetricDefinitionV1` for every metric in design v2 §17's table. A pack's
`metric_ids` cite those identifiers; the pack ships no definition of its own for
them.

Design v2 §17 says "pack additions cannot overwrite generic metric IDs". If a
pack could ship its own definition under a reserved id, it would own that
metric's threshold, and a pack revision could silently relax a hard-safety gate.
`assertReferencedMetricsAreGeneric` refuses a definition whose id is reserved and
whose bytes differ from the Lab's, and certification refuses it again.

A post-hoc threshold change is therefore not a mutation but a *different
artifact*: the metric definition's `core_hash` changes, so every result derived
from it has a different `metric_definition_hash` and a different
`result_identity_hash`.

### 3. `evaluation-sdk` receives an injected canonical hasher

Certification must digest a pack body, but `evaluation-sdk` may depend only on
`@erl2/contracts`, and design v2 §16.1 requires exactly one canonical
JCS/SHA-256 implementation. `certifyPack` therefore takes a `hash` seam that the
caller supplies from `@erl2/integrity`.

Reimplementing JCS inside the SDK would have created a second canonicalizer that
could drift; adding an `integrity` dependency would have widened the declared
dependency graph for one function.

### 4. Metric arithmetic is exact integer division rendered to a fixed scale

`exactRatio` divides with `BigInt` and rounds half-up at four decimal places.
No `Number` division occurs on the path to a frozen `MetricResultV1`.

Design v2 §17 forbids "floating platform-specific behaviour" in attesting
generic evaluation. A ratio computed with IEEE-754 doubles can differ in its
last bits across platforms and would break the replay-equality property that
`result_identity_hash` exists to provide.

Zero denominators never reach this function: each definition declares
`not_applicable`, `zero`, `one`, or `one_only_when_correct_abstention`, and the
last of those is the design's rule that "no claims = 1 only when correct
abstention applies, else 0" — silence is only perfect when silence was right.

## Consequences

- A pack cannot perform I/O, read a clock, read randomness, mutate an
  environment, set validity or move a generic threshold, and this is provable
  from the schema rather than from a runtime policy.
- Adding a genuinely new generic metric is a core change with a new frozen
  definition and new goldens, not a pack edit.
- Packs remain removable: `@erl2/core` imports neither `evaluation-sdk` nor any
  `packs/*` package, and `tests/architecture/purity.test.ts` proves it.
- `evaluation-sdk` stays free of cryptography; a caller that forgets the hasher
  gets a type error rather than a second hash implementation.

## Alternatives considered

- **Executable pack modules under a restricted WASM runtime.** Deferred by
  ERL2-OQ-004. It would need an audited runtime, a capability broker for the
  host calls a pack legitimately needs, and determinism guarantees across
  engines. None of that is required to express the design's §17 metric table.
- **Packs owning their own metric definitions.** Rejected: it moves threshold
  authority into the pack, which design v2 §17 forbids.
- **Decimal arithmetic via a third-party library.** Rejected as an unnecessary
  dependency: the metrics are ratios of bounded integer counts, so `BigInt` long
  division is sufficient and has no supply-chain surface.
