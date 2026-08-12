# Independent review of candidate `e9718e0` — and what it changed

The first LIVE-001 package was reviewed independently, from outside both
canonical repositories, against candidate
`e9718e0332ff84becaed3d64bc39fc360e1a16f2`. The verdict was **CHANGES
REQUIRED**. This directory preserves that review, because it was produced
outside the repository and would otherwise not be reachable from the branch it
judged.

## Provenance

| Artifact | Original path | SHA-256 |
|---|---|---|
| `review.md` | `/Users/karthik/Documents/ChatGPT/qualiber-independent-qa/reports/reality-lab-e9718e0-independent-review.md` | `8b2c1b5afe4c46127f81880caded5589da7d18b6011db88fc49f470df1a45b13` |
| `changed-files.txt` | `/Users/karthik/Documents/ChatGPT/qualiber-independent-qa/reports/reality-lab-e9718e0-changed-files.txt` | `f78699494624dc8f4089bafed75bc533284ccffc764e08f6987aba8b0a15b792` |

Both copies are byte-identical to the originals; the hashes above were
recomputed from the copies in this directory. The review was taken against a
clean tree at `e9718e0`, tree `7250ffcdd08196cd0270a1c411a60fe310f6baec`, with
base `787281318c845c34d209127177b8355c66b47f5b`.

## What it found

| Finding | Substance |
|---|---|
| **P1** | A run preregistered without `--adapter-entry` recorded nothing durable saying so. A later command could introduce a real adapter and authorize receipt A; a still later command could authorize receipt B for the same manifest. Both executed; neither receipt was ever in the frozen preregistration boundary. |
| **P2** | `freezeAdapterFailureFinding` populated `AdapterFailureV1.certification_receipt_hash` from the *manifest's* bootstrap/prior field, so the hostile golden recorded the all-zero sentinel while its real authorizing receipt was nonzero. |
| **P2** | A no-adapter run represented "not applicable" as `adapter-certified: passed=true` over manifest-only evidence — a certification claim by another name. |
| **P2** | Deleting the pre-host `verifyAdapterCertification` call, and separately the per-dispatch `assertEntryDigestUnchanged` call, each left 31 and 71 affected tests passing. Neither enforcement point was load-bearing. |
| **P3** | ADR-ERL2-036 overstated the guarantee as atomic frozen-byte execution, and described the hostile golden as an identity mismatch when the shipped golden is a certified hostile timeout. |

The review also recorded that its own full-suite rerun was **inconclusive**, and
that the multi-hour negative-control campaign was never started. Neither is
evidence for or against the candidate, and neither is cited as such here.

## What answers it

The corrective package on this branch. See
[`docs/ledger/remediation-live-001-adapter-admission.md`](../../ledger/remediation-live-001-adapter-admission.md)
§7 for the closure evidence per finding, and
[ADR-ERL2-036](../../adr/ADR-ERL2-036.md) for the durable binding, the
applicability semantics and the corrected security claim.

The exact changed-file counts the review established for base → `e9718e0` are
reproduced in the ledger rather than restated here: 178 logical entries, of
which 147 are rename-aware `fixtures/golden/adapter-platform/**` entries (149
pathnames with rename detection disabled, because two renames count twice), one
`fixtures/golden/cli-transcript.json`, and 30 others.
