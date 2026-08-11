# Independent review of candidate `90a0039` — and what it changed

The corrective LIVE-001 package was reviewed independently, from outside both
canonical repositories, against candidate
`90a00399b5ff4516e323aead02957af064599132`. The verdict was **CORRECTIVE
IMPLEMENTATION APPROVED — CAMPAIGN HARNESS FIX REQUIRED**. This directory
preserves that review for the same reason the previous one is preserved: it was
produced outside the repository and would otherwise not be reachable from the
branch it judged.

## Provenance

| Artifact | Original path | SHA-256 |
|---|---|---|
| `review.md` | `/Users/karthik/Documents/ChatGPT/qualiber-independent-qa/reports/reality-lab-90a0039-corrective-review.md` | `14a4a4af4929e1c948c33c33143eaea093fac30b2a25da7209b6ea2e52540c6b` |

The copy is byte-identical to the original; the hash above was recomputed from
the copy in this directory. The review was taken against a clean tree at
`90a0039`, tree `31a565805c09de1d3726190708b5e6c534a23bf2`, with base
`787281318c845c34d209127177b8355c66b47f5b`.

It supersedes nothing in
[`../independent-review-e9718e0/`](../independent-review-e9718e0/README.md),
which remains the record of what was found in the first package.

## What it confirmed

The corrective package closes the earlier P1, both P2s and the P3 — and closes
them durably rather than by assertion. The review recomputed the preregistration
core hash and observed it move when either `subject_execution_mode` or
`adapter_certification_receipt_hash` is altered, so the frozen binding is
provably inside the signature and the chain rather than merely stated to be. It
verified exact receipt equality across preregistration, retained artifact and
failure finding in the hostile golden, and confirmed that `adapter-certified`
appears in no golden at all while the two full-gate fake-port goldens keep every
other gate.

It also confirmed both mutations that survived the first package are now caught,
and caught behaviourally — the controls observe that adapter bytes never
executed rather than that a helper returned an error.

## What it raised

| Finding | Substance | Answered by |
|---|---|---|
| **P3** | Removing *both* production calls to `assertAdapterCertificationApplicability` passed the affected suite 144/144 and the full suite at 1,209 tests with zero failures. The existing control calls the helper directly, so the wiring was never load-bearing; the assertion's unique cases — a duplicate gate, manifest-only or bootstrap/prior evidence, a fake-port run emitting the gate — were enforced nowhere. | `tests/adversarial/adapterCertificationApplicability.test.ts` |
| **Campaign harness** | `substrate-loopback-only-rendered` was recorded as the campaign's single disagreement. A four-cell reproduction proved the behaviour is identical at `e9718e0` and `90a0039`, that the designated case skips itself when the git-ignored upstream fixture is absent from the campaign worktree, and that the control is fully load-bearing once the pinned fixture is provisioned. Primary cause: a pre-existing fixture-provisioning defect. Secondary: the classifier never read `skipped`, so an unmeasured control became a disagreement. | `scripts/lib/campaignFixtures.mjs`, `scripts/negative-control.mjs` |

Both are answered by the validation-harness closure on this branch. Neither was
a receipt-admission defect, and the review says so explicitly: *"A pre-existing
campaign harness defect must not be misreported as a receipt-admission
failure."*

## What it deliberately did not claim

The review recorded the reported exact-head clean gate as **implementer-reported
rather than independently proven**, because no durable log or receipt of it
existed anywhere in the repository. It corroborated the substance — its own full
compiled-suite run at `90a0039` returned 1,209 tests with zero failures,
matching the reported total — without upgrading the execution evidence.

That gap is closed going forward: the clean gate for the validation-harness
closure was captured to a durable log, and its result is recorded in
[`docs/ledger/negative-control-harness.md`](../../ledger/negative-control-harness.md)
§8 alongside the campaign it gated.

## What answers it

See
[`docs/ledger/negative-control-harness.md`](../../ledger/negative-control-harness.md)
§8 for the provisioning design, the third classification column and the campaign
evidence, and
[`docs/ledger/remediation-live-001-adapter-admission.md`](../../ledger/remediation-live-001-adapter-admission.md)
§7 for the receipt-admission closure the review approved.
