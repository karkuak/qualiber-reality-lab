# Validation-harness closure — the exact-head gate and the full campaign

The two long validations that gate publication of the external-adapter receipt
admission branch, run once each at one commit, retained so that nobody has to
take them on trust.

Both ran at the **executable harness commit**

- commit `76933408980c79e7787f14366073ab24c9ed2c88`
- tree `e1d089e748bf80421e3cd289c30e7cf5881ee80d`
- branch `codex/external-adapter-receipt-admission`
- worktree clean before and after, tree unchanged by either run

## Why this directory exists

The independent review of `07da5fe` approved the production receipt-admission
implementation and blocked publication on the evidence for the harness. Its
finding was not that the numbers were wrong — it was that they could not be
checked. The 129-control campaign's only complete record was
`docs/ledger/negative-controls.json`, which `.gitignore` excludes: no commit, no
tree, no integrity binding, overwritten by any targeted run, and absent from a
fresh clone. The clean gate was a prose paragraph naming a log nobody kept.

Evidence for a three-hour run has an awkward property: it gets believed on
sight, because re-deriving it is expensive. That is exactly what makes an
unverifiable record dangerous. So both runs are retained here as a JSON record,
the logs it refers to, and a `SHA256SUMS` over everything.

## What is here

```
clean-gate/                     6 files, 148 KB
  clean-gate.json               the record
  logs/{test,verify-generated,evidence-verify,diff-check}.log
  SHA256SUMS
negative-control-campaign/    132 files, 1.0 MB
  campaign.json                 the record, with all 129 per-control results
  logs/campaign.log             the campaign's own complete output
  logs/controls/<id>.log        the retained tail of each control's suite output
  SHA256SUMS
```

Manifest digests, so a reader can check that the manifests themselves are the
ones this README describes:

| file | SHA-256 |
|---|---|
| `clean-gate/SHA256SUMS` | `2c0bb24ce63b902cde2ee7e93c5d5445e54c5c0433c7087b454f83ab79a0c0ac` |
| `clean-gate/clean-gate.json` | `125f3bd2351caeced5d9458bcb19a88e657b59a1fc61699fcc125a338ea3bdfe` |
| `negative-control-campaign/SHA256SUMS` | `8e216bb1e282b75e62d3ceceb72bfad25cde89f6f63e1cae558c3cd1baf823a8` |
| `negative-control-campaign/campaign.json` | `dee39cf427c498ae3c19637eb8ec3b94fb5d6ea675c56292a4699601e5ba9ad8` |

## The clean gate

Four commands, each with its own log, exit status and timing.

| step | command | exit | duration |
|---|---|---:|---:|
| test | `npm test` | 0 | 1,327 s |
| verify-generated | `npm run verify:generated` | 0 | 0.3 s |
| evidence-verify | `npm run evidence:verify` | 0 | 89 s |
| diff-check | `git diff --check` | 0 | 0.04 s |

**1,301 tests — 1,299 passed, 0 failed, 0 cancelled, 2 skipped**, in 1,416 s
wall clock (`2026-08-12T03:51:58Z` → `04:15:34Z`). The two skips are named in the
record rather than counted:

- `EXTERNAL-SUBJECT-E2E: an externally authored subject reaches an offline-valid terminal`
- `EXTERNAL-SUBJECT-CANCEL: the supported cancellation path leaves zero residue`

both `EXTERNAL SUBJECT UNPROVEN: no external adapter entry was supplied`. The
ordinary gate does not supply one, and must not require one.

`evidence:verify` reported 838 pinned files and 7 exclusions with no drift.

## The campaign

`node scripts/negative-control.mjs`, one run, `2026-08-12T04:16:06Z` →
`07:16:35Z` — **10,829 s (3 h 00 m 29 s)**.

| | |
|---|---:|
| discovered | **129** |
| measured agreements | **129** |
| disagreements | **0** |
| unmeasured | **0** |
| harness errors | **0** |
| output truncation | **0 rows** |
| termination signals | **none** |
| working tree afterwards | byte-identical |
| residue (worktree, temp, process, Docker) | none |

`129 = 125 named_tests_failed + 4 no_kill_as_declared`, and every one of the 129
discovered control ids carries exactly one result.

### The rows this closure is about

- **`substrate-loopback-only-rendered`** — 29 tests, 28 pass / 1 fail,
  `named_tests_failed`, agreed, `replacedCount: 1`. Its prerequisite
  `otel-demo-upstream` was **provisioned and verified**: release `3.0.0`, archive
  `sha256:1bf3ef8f…c051c`, extracted to
  `environments/otel-demo/upstream/extracted-1bf3ef8fbaffc049`, with each
  extracted file's digest recorded in the run's marker and matching
  `config_hashes` in the tracked `substrate-lock.json`. The designated
  rendered-topology case ran and failed, which is the measurement.
- **`adapter-mode-binding`** — 9 tests, 7 pass / 2 fail, agreed. The LIVE-001 red
  control, unaffected by any of this.
- **`container-deadline-kills-the-container`** — 2 tests, 0 pass / 2 fail,
  agreed, with `docker-daemon` satisfied on this host.

### The three skips that used to be invisible

`composeSubstrate.test.js` carries one case that skips itself when the upstream
fixture is absent. Four controls run that suite and only the last of them
declares the fixture, so for the three before it the case genuinely cannot run:

| control | result | agreed | skipped |
|---|---|---|---:|
| `telemetry-driver-verified-collector` | `named_tests_failed` | yes | 1 |
| `compose-ownership-label-verification` | `named_tests_failed` | yes | 1 |
| `compose-running-image-verification` | `named_tests_failed` | yes | 1 |

They were skipping on every previous campaign too. What is new is that the record
says so: each row carries the skipped case's name, its `RENDERED TOPOLOGY
UNPROVEN` reason, and the `expectedSkips` declaration that permits it. An
undeclared skip — or a declared one whose reason has since changed — is
`unexpected_case_skipped`, a harness error, and fails the campaign.

This is the question the previous record could not answer. It can now, and the
answer is three, all declared, none behind an agreement that hid it.

## Checking it

```
npm run evidence:validation
```

recomputes every digest in both manifests, requires the gate and the campaign to
name the same executable commit and tree, reconciles both sets of totals,
refuses any row whose agreement coexists with truncation, a signal, an abnormal
exit, a harness error or an undeclared skip, and asks `git check-ignore` whether
each retained file would survive a fresh clone. Add `--expect-commit <sha>` to
bind it to a particular head.

Or, without this repository's tooling:

```
cd clean-gate && shasum -c SHA256SUMS
cd ../negative-control-campaign && shasum -c SHA256SUMS
```

## What this evidence does not claim

It is not byte-pinned, and it must not be. `fixtures/golden` holds artifacts a
generator reproduces exactly; a three-hour campaign across 129 mutated worktrees
reproduces nothing byte-for-byte, and pinning it would be a lie about what kind
of thing it is. The claim retained here is narrower and checkable: *this run, at
this commit, produced these numbers, and here is the output they were read
from.*

It also says nothing about the limitations recorded elsewhere — B-129, B-130, the
unsigned real receipt, the absent independent certifier authority, and the
unexercised scored path all remain open, and no campaign result changes any of
them. See `docs/ledger/negative-control-harness.md` §9 for the harness design and
`docs/ledger/remediation-live-001-adapter-admission.md` for the admission work
this gated.
