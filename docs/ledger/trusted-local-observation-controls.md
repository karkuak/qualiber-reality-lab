# Ledger — negative controls for the trusted-local path

**Date:** 2026-08-16
**Companion to:** [ADR-ERL2-042](../adr/ADR-ERL2-042.md)
**Base:** `4d695bfb3d23e804cf89aafa2aa5033ab31a15e6`, 207 controls
**Head:** 229 controls — 206 retained unchanged, 1 re-anchored, 22 appended,
none removed, renamed, reordered or duplicated.

## 1. Migration from the withdrawn operator candidate

The unsafe operator branch `codex/v2-local-observation-operator`
(`3ded03c146cb6937118132757a8dc91a7359caa8`) appended fourteen controls to the
same 207-control base. That branch is preserved unchanged as review evidence and
none of its commits is an ancestor of this one, so its fourteen are not
"removed" here in any git sense — they were never on this branch. What follows
classifies each one against the enforcement points that exist now, because a
control disappearing must never be the way an enforcement property disappears.

| # | withdrawn control | disposition | why |
|---|---|---|---|
| 1 | certification command hashes the exact entry bytes | **migrated** | `trusted-local-artifact-binding` measures the same byte binding at the authority that now exists |
| 2 | certification command binds manifest core hash | **migrated** | `trusted-local-manifest-binding` |
| 3 | certification refuses a mismatched artifact | **migrated** | folded into `trusted-local-artifact-binding`; the two clauses were one enforcement point |
| 4 | certification refuses a v1 manifest | **replaced by a stronger control** | v1 fallback is now refused in admission and covered behaviourally by `TRUSTED-LOCAL-ADMIT: a V1 manifest cannot fall back into this path`; no separate control, because the check is a `schema_version` equality with no weaker form that compiles |
| 5 | certification refuses a governed profile | **removed — the feature is absent** | there is no certification command. Governed execution is unrepresentable in a v2 profile (schema-pinned `execution_modes`), and the reachable refusal is the host's, already covered by the retained `v2-local-mode-accepts-v1` |
| 6 | certification requires nonempty evidence | **removed — the feature is absent** | no receipt exists to bind evidence to. Owner-supplied evidence is now a labelled digest the Lab never reads, and its ceiling is a contract constant |
| 7 | receipt output refuses an existing file | **migrated** | `TRUSTED-LOCAL-CLI: an existing record is never silently overwritten` covers the retained record; the declaration writer uses the same refusal |
| 8 | receipt mode is `0600` | **retained unchanged in behaviour, no control** | still true of every file this path writes; it was not load-bearing on the old branch either and inventing a control for it would measure the filesystem, not the Lab |
| 9 | admission rehashes the artifact | **migrated** | `trusted-local-pre-host-entry-digest`, anchored inside the trusted-local arm |
| 10 | host rehashes before every dispatch | **retained unchanged** | the existing base control `v2-per-dispatch-digest` covers the shared host path and is untouched |
| 11 | plan binds the admitted receipt | **migrated** | `trusted-local-plan-binds-its-declaration` |
| 12 | run refuses governed flags | **migrated** | `trusted-local-governed-input-refusal`, widened to cover certification flags too |
| 13 | verifier refuses a stale receipt core hash | **replaced by a stronger control** | eight verifier controls now measure recomputation of the plan, the run identity, operation completeness, the chain, cleanup, the terminal, closed validation and the size bound. A stale-hash check was the weakest property the old verifier had |
| 14 | verifier refuses a weakened exclusion list | **replaced by a stronger control** | `trusted-local-certification-claim-is-unrepresentable` measures the contract constant, which is what makes the ceiling unweakenable rather than merely checked |

**No removed control conceals a still-present enforcement property.** Rows 5, 6
and 8 are the only removals, and rows 5 and 6 name features that do not exist
on this branch. Row 8's property is still true and still asserted, just not by a
control.

## 2. The twenty-two appended controls

Each mutates exactly one enforcement point, compiles, reaches the intended
runtime path, and fails a named behavioural case.

| id | enforcement point | named case that must notice |
|---|---|---|
| `trusted-local-acknowledgement-must-be-the-exact-sentence` | CLI acknowledgement comparison | near-miss acknowledgement refused |
| `trusted-local-acknowledgement-binds-the-bytes-it-accepted` | acknowledgement ↔ declaration hash binding | acknowledgement of different bytes refused |
| `trusted-local-artifact-binding` | declaration ↔ manifest artifact digest | artifact digest mismatch refused |
| `trusted-local-manifest-binding` | declaration ↔ manifest core hash | manifest binding mismatch refused |
| `trusted-local-pre-host-entry-digest` | entry re-hash before host construction | bytes changed before host construction refused |
| `trusted-local-plan-binds-its-declaration` | plan ↔ declaration hash | plan bound to another declaration refused |
| `trusted-local-governed-input-refusal` | named governed/certified flag refusal | governed input refused by name |
| `trusted-local-result-restates-its-two-absences` | mandatory ceiling in the retained result | eleven-operation plan completes |
| `trusted-local-compact-predecessor-construction` | compact predecessor derivation | eleven-operation plan completes; operation two's predecessor |
| `trusted-local-predecessor-chain-verification` | chain equality in the coordinator | altered / cross-run / cross-plan predecessor refused |
| `trusted-local-registry-retains-exact-bytes` | exact-byte retention | eleven-operation plan completes |
| `trusted-local-verifier-requires-plan-bytes` | mandatory plan bytes | omitted plan bytes refused |
| `trusted-local-verifier-recomputes-the-plan` | plan-hash recomputation | changed plan hash refused |
| `trusted-local-verifier-recomputes-the-run-identity` | run-identity recomputation | changed run id refused |
| `trusted-local-verifier-operation-completeness` | reachable-operation coverage | plan exceeding retained outcomes refused |
| `trusted-local-verifier-recomputes-cleanup` | residue derivation | false cleanup upgrade refused |
| `trusted-local-verifier-recomputes-the-terminal` | terminal derivation | contradictory terminal refused |
| `trusted-local-verifier-closed-record-validation` | closed-schema record validation | unknown top-level / nested field, nested verdict refused |
| `trusted-local-verifier-oversized-record-bound` | size bound before parse | oversized record refused |
| `trusted-local-result-cannot-stop-declaring-itself-unscored` | contract constant on the trusted-local result's `not_scored` | the embedded result's own ceiling cannot be weakened |
| `trusted-local-certification-claim-is-unrepresentable` | contract constant on `independent_certification` | false certification claim refused |
| `trusted-local-record-embeds-the-declaration-it-ran-under` | embedded ↔ retained declaration | replaced embedded declaration refused |

## 2a. One base control re-anchored, and one added because of it

`v2-not-scored-constant` anchored on `"LocalObservationResultV1": {` and found
the first `"not_scored": { "const": true },` after it. Making the result a union
turned that anchor into a two-line `oneOf` wrapper, so its window held three
matching constants instead of one and the campaign reported
`ambiguous_patch_target — found 3`. The broad suite caught it, which is what
the targeting proof exists for.

It is re-anchored on `"LocalObservationCertifiedResultV1": {`, measuring exactly
the enforcement point it always measured. Because an anchor's window runs to the
end of the file and three variants now carry the same constant, the preimage
reaches two lines further than the mutation; only the first line changes.

Two variants means two constants, so
`trusted-local-result-cannot-stop-declaring-itself-unscored` was added for the
one this package introduced. A constant nothing measures is a constant that can
quietly become a `boolean`.

Its first run reported `tests_passed_unexpectedly`, and the reason was a real
gap rather than a bad anchor: every forgery case weakened the ceiling on the
*record*, and none weakened it on the embedded *result*. The record's constant
was catching all of them, so widening the result's changed nothing observable.
The missing case was written — the result's four ceiling fields, each weakened
alone — and the control then killed. The gap is worth recording: a ceiling
carried in two places needs a forgery against each place, or one of the two
constants is decoration.

## 3. Three enforcement points deliberately without a control

The first two were **removed from production code** rather than given a control
that could not kill, which is the same disposition already recorded for the
receipt-linkage classifier in `admission.ts`. The third was written as a
control, measured, disproved by its own campaign, and withdrawn.

**The acknowledgement token re-check.** `acknowledgement_token` is a contract
constant, so `assertContract` refuses any other value before the runtime
comparison is reached. Re-checking it would have been a check no test could
reach. What survives in `verifyTrustedLocalAdapterDeclaration` is the part the
schema cannot express — the *relationship* between the acknowledged hashes and
the bound hashes — and that has a control.

**The governed-mode refusal in admission.** A `subject-adapter/v2` profile's
`execution_modes` is pinned by the schema to exactly `["local_observation"]`, so
a governed v2 profile cannot be written down. The reachable refusal is the
host's, which already has a base control.

**The plan-variant discrimination in the host.** This one was a control
(`trusted-local-refuses-the-certified-arms-plan`) until the campaign reported
`tests_passed_unexpectedly` against it. Disabling the discrimination changes
nothing observable, because a certification-variant plan has no
`trusted_local_declaration_hash` and no `trust_mode`, so the bindings below it
refuse the plan anyway — and a plan carrying both variants' fields satisfies
neither closed member of the contract's `oneOf` and never reaches the host at
all. What the expression buys is the narrowing TypeScript needs. The control was
withdrawn and the code comment that called it "separately measurable" was
corrected, because the campaign had just demonstrated it is not.

Recording any of these as `expect: "none"` rows would have kept the count
monotonic and told a reader nothing. Two deletions and one withdrawal keep every
remaining check reachable.

## 4. What the appended controls do not cover

- **Adapter confinement.** There is nothing to control, because nothing is
  claimed. The absence is a contract constant (`not_confined`), and the
  `trusted-local-certification-claim-is-unrepresentable` control demonstrates the
  same technique on the sibling field.
- **The `start`-without-`stop` terminal.** This is reducer semantics inherited
  unchanged from ADR-ERL2-037 and already covered by the base controls; the
  behavioural case here records it rather than re-measuring it.
- **Positional operation-order comparison in negotiation.** Pre-existing host
  behaviour, unchanged by this package, recorded in the ADR as a finding.
