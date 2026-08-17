# ADR-ERL2-042 — an owner-operated `trusted_local_code` path, in place of pretend independence

- **Status:** accepted
- **Date:** 2026-08-16
- **Deciders:** Lab Core Owner, Adapter Protocol Owner, Integrity/Security Owner
- **Extends:** ADR-ERL2-036, ADR-ERL2-037
- **Supersedes:** nothing. ADR-ERL2-041's operator surface is not adopted; the
  branch that proposed it is preserved unchanged as review evidence.

## Context

`subject-adapter/v2` local observation existed and worked, but nothing public
reached it: the only route to `LocalObservationCoordinator` was from a test. A
previous package built a public route by adding a certification command, so an
operator could issue a receipt for their own adapter and then run it.

An independent review of that candidate found five blocking classes. Four were
defects. The fifth was the framing itself, and it is the reason for this ADR.

The command was called certification. It produced a document called a
certification receipt, carrying a `certifier_id`, a `verdict`, a
`certifier_is_adapter_owner: false` field, and a list of enforced controls. In
an agent-operated local workflow every one of those is the operator wearing a
second hat:

- **the certifier was the owner.** Admission compared `receipt.certifier_id`
  against `manifest.adapter_id` but never against `manifest.owner`, so a receipt
  the owner self-issued was admitted. Because the receipt is unsigned, an
  unkeyed core hash was the only thing standing behind that separation, and a
  resealed receipt satisfied it.
- **the verdict was not earned.** A receipt could say `certified` while its own
  checks contained a failure, and admission did not look. A receipt could be
  issued after a negotiation handshake without exercising a single certified
  operation.
- **the enforced controls were not enforced.** The certification probe ran the
  adapter with `spawnSync(process.execPath, [entryPath])`, inheriting the
  reviewer's working directory and the user's filesystem and network authority.
  A neutral probe read the checkout, wrote outside any workspace, left a
  descendant alive after certification returned — and was certified, under a
  receipt reporting `process-tree-termination` as enforced.

Hardening that command would have produced a better-behaved version of a claim
the workflow cannot support. There is no second party here. Adding one by
writing a name into a field does not create one.

## Decision

### 1. Name the trust model what it is

The public path is `trusted_local_code`: owner-operated, local process,
development tier, unscored, unauthenticated, not governor authorized, not
independently certified, not confined, and unsuitable for hostile third-party
adapter code. The operator accepts that the adapter process has the host
permissions of the user running it.

The Lab still enforces exact artifact-byte binding, exact manifest binding,
protocol and mode binding, plan-to-run binding, the claim ceiling, operation
framing, evidence integrity, cleanup reporting, and offline recomputation of the
whole run story.

The Lab does **not** claim filesystem confinement, kernel or container
isolation, independent network confinement, process-tree confinement,
authenticated certifier identity, third-party review, or production safety.

That distinction needs stating precisely, because a nearby true statement makes
it easy to slide. `AdapterHost` genuinely enforces the twelve controls the
`local-process` profile reports as `enforced`: a separate process, a wall-clock
deadline, request and response byte ceilings, a writable-output-only workspace,
an environment-variable allowlist, bounded diagnostics, egress adjudication at
the broker seam. Those are real, and they are operational bounds on a
*cooperating* adapter. They are not a boundary against the operator's own
authority, and an adapter that does not cooperate is outside what any of them
constrain. The retained record therefore carries the host's control report
verbatim — including the thirteen controls it honestly reports as
`unsupported_on_this_host` — rather than the enforced subset, because the
enforced subset alone reads as a confinement claim.

### 2. The plan and the result become closed unions

`LocalObservationPlanV1` and `LocalObservationResultV1` each become a `oneOf` of
two closed variants. The certified variants are the originals, byte for byte;
no existing plan or result changes, and no existing fixture was touched.

The trusted-local variants carry `trusted_local_declaration_hash` and
`trust_mode`, and carry no certification field at all. Not an empty one, not a
sentinel, not a repurposed name. Writing an owner's unreviewed assertion into a
field called `certification_receipt_hash` is exactly the dishonesty this ADR
exists to remove, and it would have been the smaller diff.

### 3. `TrustedLocalAdapterDeclarationV1` shares nothing with a receipt

The declaration has no certifier identity, no verdict, no signature, no
refusal codes and no enforced-control claim. `independent_certifier` is `null`
and `certifier_is_adapter_owner` is `not_applicable`, because with no certifier
the question does not arise and answering `false` would imply one existed.

Its `operator_acknowledgement` is bound to the exact artifact digest and the
exact manifest core hash it was written for. Every limitation is a `const true`
in the contract, so a declaration cannot be weakened by flipping a boolean —
the weakened form is not a document the schema can express.

Optional owner-supplied test evidence is retained as a digest, a length and a
label, marked `owner_supplied_unauthenticated`. The Lab does not read it, run
it, or draw any conclusion from it. It is retained so a reader can see exactly
what was asserted and that nothing verified it.

### 4. The acknowledgement is a sentence

`--yes` and `--force` are the shape of a prompt someone is trying to get past.
The acknowledgement is a contract constant the operator must reproduce exactly:

> I ACCEPT THAT THESE EXACT ADAPTER BYTES EXECUTE WITH MY LOCAL USER
> PERMISSIONS, ARE NOT SANDBOXED AND ARE NOT INDEPENDENTLY CERTIFIED, AND THAT
> THE RESULTS ARE DEVELOPMENT-ONLY, UNSCORED AND UNAUTHENTICATED

It names each thing being accepted, it is refused if absent or altered, it is
rebound if either hash changes, and it appears in the terminal summary, in the
declaration, and in every run record built from it.

### 5. `AdapterHost` takes a closed authority union

`AdapterHostOptions.localAuthorityV2` is
`{mode: "certified_external", receipt} | {mode: "trusted_local_code", declaration}`
— not two optional documents. The host retains the discriminant, so *which*
authority admitted an adapter is a fact the host knows and can be asked, rather
than something a caller infers from which field happened to be populated.

Only the trusted-local arm is publicly reachable. The certified arm is the
existing receipt path, unchanged, and is where a genuinely independent external
authority would attach in future work.

The two arms cannot be crossed. Each verifier rejects the other's
`schema_version` outright, and each plan variant is refused by the other arm's
binding check.

### 6. Controls are settled against the host's own report

The certified path compared a manifest's control requirement against a
*certifier's claim* that the control was enforced. With no certifier there is no
claim, so the requirement is compared against `sandboxControlReport` — which is
both the only check available and the stronger one.

A control this host cannot enforce does not automatically stop the run, because
thirteen container-only controls are honestly unsupported and refusing on all of
them would make the path unreachable rather than safe. It stops the run unless
the *plan* named that control and declared `unsupported_permitted`: the operator
deciding, in frozen bytes, to proceed without it. Silence is a refusal.

### 7. Ancestry carries the compact predecessor the contract defines

`AdapterRequestAncestryV2.predecessor` is a five-field summary. The previous
runner passed the entire terminal operation record, so every plan refused its
second operation with `SCHEMA_VALIDATION_FAILED` and no multi-operation profile
was runnable at all.

The compact form is now derived in one place from the record the coordinator
retained. The coordinator also checks the link, comparing a request's
predecessor against one it derives itself from the operation this run finished
last. That single equality refuses an altered record hash, a predecessor from
another run, a predecessor from another plan, and a missing or unexpected one.

It runs *after* the plan-cursor checks. A reordered, omitted or duplicated
operation is a fault against the frozen plan and keeps reporting itself that
way; only a request already at the right cursor reaches the narrower question.

"The operation before this one" is what terminated last, not the plan entry one
sequence earlier, because after a failure the frozen cleanup suffix continues
from the operation that actually ran.

### 8. Offline verification rebuilds the run rather than checking it against itself

The previous verifier checked that a record's internal hashes agreed. An
attacker who can edit a record can also rehash it, and the review demonstrated
six resealed forgeries passing: a changed run identity, a cross-plan replay with
the plan omitted, a plan with two operations retained with one outcome, a
flipped terminal, an upgraded cleanup, and a nested adapter-written verdict.

So the verifier reconstructs the run from the plan bytes and the retained
admission and compares. Plan bytes are mandatory; without them `plan_hash` is a
number nobody can check, which is precisely how the cross-plan replay got
through. Cleanup and terminal status are recomputed by a second implementation
of the reducer's rules rather than by calling the producer — a shared
implementation would agree with the producer even when the producer was wrong.

Operation coverage is derived, not counted: every main-sequence operation up to
and including the first that did not complete, then every cleanup operation.
"All planned operations must appear" is too strong once a failure diverts to the
cleanup suffix; "any number is fine" is the hole the missing-outcome forgery
went through.

The record's own core hash is checked **last**. A matching outer hash proves
only that the forger recomputed it, so it is the least informative check here
and must never be the one carrying the verdict.

## Consequences

### What an operator can now do

Two commands. `declare-trusted-local-adapter` writes the declaration and
optionally seals a plan draft; `run-trusted-local-observation` runs it. No
governor registry, no acquisition preregistration, no eight governor hashes, no
certification receipt, no certifier identity, no signature, and no flag through
which any of those could be supplied.

### What is deliberately absent

The **public certification command** does not exist on this branch. Neither does
the negotiation probe that ran adapter code outside `AdapterHost`. Neither is
referenced by any documentation, and there is no test-only route that could be
mistaken for the public workflow. The shipped command list contains
`declare-trusted-local-adapter` and `run-trusted-local-observation` and no
`certify-adapter-v2`.

What *does* remain, byte-identical to the base at `4d695bfb` and untouched by
this package, is the internal `ADAPTER-CERT-V2` scope skeleton in
`packages/core/src/adapter/certification.ts` and the
`SubjectAdapterCertificationReceiptV2` contract it produces. Saying
"`ADAPTER-CERT-V2` does not exist" would be the kind of overstatement this ADR
exists to remove: the suite identifier, the receipt contract and the certified
arm of the host's authority union are all still here. They are simply
unreachable from any public command, and the trusted-local path never calls
them — `verifyTrustedLocalAdapterDeclaration` rejects a receipt's
`schema_version` outright rather than sharing a code path with it.

### Two checks were removed rather than kept

The acknowledgement token and every limitation the operator accepts are `const`
in the contract, so re-checking them after `assertContract` was a check no test
could reach. Governed execution is likewise unrepresentable in a v2 profile,
whose `execution_modes` the schema pins to exactly `["local_observation"]`. Both
were deleted rather than left as documentation wearing a check's clothes, which
is the same reasoning already recorded for the receipt-linkage classifier.

### A limitation this work found and did not fix

A profile that declares `start` without `stop` cannot reach a clean terminal: a
successful `start` creates a stop obligation, and the reducer will not discharge
an obligation nothing discharged. The eleven-operation profile under test is
exactly that shape. Every one of its operations dispatches and completes, and
the terminal is `cleanup_incomplete` — which is the honest answer, not a defect
in the run. It is recorded here because an operator meeting it will otherwise
read it as a Lab failure.

### A second limitation, in the protocol rather than this package

`AdapterHost` compares the negotiated operation list against the profile's
**positionally**. A manifest declaring the right operations in a different order
than the adapter's handlers is refused as "the adapter process ended without a
valid response", which names the symptom and not the cause. This package did not
change that comparison; it is recorded so the next reader loses minutes rather
than hours.

## Alternatives rejected

**Harden the certification command.** It would produce a better-behaved version
of a claim the workflow cannot support. The problem was never the probe's
rigour; it was that there is no second party.

**Keep `certification_receipt_hash` and put the declaration's hash in it.** The
smallest diff, and the dishonest one. Every downstream reader — and every
future reader of the retained evidence — would see certification vocabulary
describing a document nobody reviewed.

**Claim the twelve enforced controls as confinement.** They are real controls
and they are not confinement. Reporting them as isolation is the precise error
the review found in the previous receipt, reached by a different route.

**Fake a distinct certifier identity.** Considered only long enough to name it
here, because the previous design's `certifier_is_adapter_owner: false` is what
it looks like when this is done by accident.
