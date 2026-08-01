# Independent Code Review — Integrated Slice 6.5R

**Scope:** the complete Slice 6.5 integrity-remediation stack, reviewed as one
composed system, plus an exact-HEAD checkpoint of the Step 6B evidence.

**Reviewer position:** independent. Every claim below was traced to source or to
a command I ran myself. Ledgers, ADRs and handoffs were read as *normative
requirements and claims under audit*, never as evidence for themselves.

---

## 1. Executive verdict

**MERGE-READY WITH NON-BLOCKING FOLLOW-UPS.**

- **No P0.** I could not construct a signed false attestation, a false-valid
  terminal, an undeclared destruction, or a secret/canary escape on any path I
  exercised. The four original false-attestation shapes (P0-1 substrate,
  P1-2 cancellation branch, P1-4 no-op compensation, P1-12 error-swallowing
  substrate load) are closed at real enforcement points, not at documentation.
- **No P1.** The cleanup, lifecycle-ordering, offline-verification,
  signer-inventory, cutoff-window and producer-boundary packages each close the
  finding they name, and each closes it in production code that a negative
  control kills.
- **Eight P3 findings**, all non-blocking: four are evidence-completeness or
  claim-precision defects, two are harness/test-hygiene robustness, one is a
  performance recommendation, and one is a leaked-temporary-directory defect that
  also touches production. None reopens a false-attestation path.
- The **most important structural observation** is not a finding but a pattern:
  the remediation now contains **at least two enforcement points that no shipped
  input can reach** (`adapter_request`, and the source-snapshot window comparison
  in `windowDerivation.ts`). Both are honestly recorded. A third would justify a
  standing policy; see §15.

The dominant risk in this stack is no longer integrity. It is **maintenance
surface**: `environmentRun.ts` is 4,227 lines with a 340-line method, two
hand-maintained role tables must agree, and the full test gate takes
approximately half an hour before the negative-control campaign is even started.

---
## 2. Exact repository coordinates

| | |
|---|---|
| Repository | `/Users/karthik/Developer/qualiber-reality-lab` |
| Branch | `codex/6.5r-evidence-boundaries` (local only, **no upstream**) |
| Candidate HEAD | `0aebf42be7d46732d3bbbdf8ec5add56e2e173a4` |
| Candidate tree | `c86761a68f5601ca2765f10b2ffdb0e1f97f9b92` |
| Base | `origin/main` = `e48bdc233f9399fa3315acf943f549a82f336077` |
| Working tree at review start | clean; `git diff --check` clean |
| Step 6B baseline | `eaeec8c` |
| Negative-control campaign candidate | `473b402` |
| Reported clean-checkout gate candidate | `1619fe0` |
| Node | 26.4.0 (repository targets `>=22.0.0`) |
| Qualiber checkouts | **not inspected, not searched, not executed, not imported from** |

Ancestry verified: `e48bdc2`, `eaeec8c`, `473b402` and `1619fe0` are all
ancestors of `0aebf42`. The branch contains exactly the six Step 6B commits after
`eaeec8c` that were reported, and no others:

```
1ca2676 ADR-ERL2-032: the four boundaries where a present check was not checking
13f84e3 scan the bytes that cross each boundary, and enforce the ceiling that was hashed
8b7bb43 development-only: let the fake subject emit an output of a chosen byte length
12d8743 tests and six controls that measure the boundaries rather than the helpers
473b402 ledger, claims and handoff for the producer evidence boundaries
1619fe0 ledger: the ninety-two-control campaign against the Step 6B candidate
0aebf42 handoff: the verified totals from the clean-checkout gate
```

No discrepancy against the reported starting state. Nothing was reset, cleaned,
stashed, discarded or overwritten; no commit, push, merge, rebase, branch or PR
operation was performed.

---

## 3. Independence and methodology

I read source before narrative, deliberately, and read the ledgers and handoffs
last. Where a document asserted a property, I looked for the property's
enforcement point and then asked what an attacker would have to construct to get
past it — not whether the document was internally consistent.

Specifically, I did **not** treat any of the following as evidence: an ADR calling
an invariant settled; a ledger calling a finding closed; a handoff reporting green
tests; a campaign reporting agreement; a schema validating; a hash being
internally consistent; a producer and verifier agreeing; an artifact being signed;
or a prior review having recommended the implementation.

For each important claim I traced the production path, separated the trusted
inputs from the independently derived facts, located the exact enforcement point,
and asked whether a self-consistent false package could be constructed. Where I
confirmed a closure by reading rather than by executing an exploit, the closure
matrix in §7 says so in the row.

**Things I checked rather than accepted, where accepting would have been easy:**

- The claim that no pinned golden byte could have moved. Rather than trusting
  `EB-MOUNT-BIND`, I compared `freezeMountedFile`'s byte composition
  (`Buffer.concat([jcsBytes(value), Buffer.from("\n")])`, `application/json`,
  `PUBLIC`) against `ArtifactStore.freezeJson`'s body and confirmed they are the
  same bytes, and then confirmed the pin count and exclusion digest independently
  from the gate output.
- The premise of ADR-ERL2-032 §5 — that the pre-existing `subject_output_prefill`
  scan already covered payload *bytes*. If it had covered only outcome metadata,
  the ADR's justification for omitting a judge-canary branch would have been
  inverted and a real rule would be missing. I checked
  `git show eaeec8c:packages/core/src/run/environmentRun.ts` directly; it did.
- The `adapter_request` shadowing claim, which I checked against **all four**
  `assertRequestOracleClean` call sites rather than the one the ADR reasons about.
  This produced **R-01**.
- That `freezeMountedFile` is the only writer into `subject-visible/`, by
  enumerating every write in the package tree rather than by trusting the ADR's
  "it is the only way".
- Whether the `evidence:verify` gate covers the *valid* golden's verification
  outcome as well as the invalid ones. It does not. This produced **R-02**.

**Commands I ran are listed in full in §20.** No production code, test, schema,
generated file, golden or evidence pin was modified. All destructive probing was
done in a disposable clone whose tracked bytes were proven identical to the
candidate before use.

**Limitations, stated plainly.**

- Node 26.4.0 against a Node 22 target. Byte equivalence on Node 22 is asserted by
  the project and was not verified here.
- I did not construct a full signed false bundle from scratch. Where the
  derivation layer makes direct retained-byte mutation impossible without the
  development signing keys, I verified the enforcement point at source and by
  reproducing the negative control that disables it, and I say so rather than
  implying an executed exploit.
- **R-03** rests on a source trace, not an executed refusal: the run-identity
  binding fires before the code path in question, so isolating it needs a
  genuinely preregistered run root, which I did not build.
- I reproduced twelve negative controls, not ninety-two. The selection is stated
  in §4.

---
## 4. Mission A — exact-HEAD checkpoint

### 4.1 Verdict

> **The Step 6B evidence carries to `0aebf42` in full, with no rerun required.**
> The two commits after the campaign candidate are provably non-executable and
> non-gating, and I re-ran the complete clean gate at exact `0aebf42` anyway.
> It is green.

### 4.2 What changed after the campaign candidate

`473b402..0aebf42` — two commits, two files, **84 insertions, 3 deletions**:

```
M  docs/handoff/slice-6.5-evidence-boundaries-handoff.md   31 +++++++++-
M  docs/ledger/remediation-6.5-evidence-boundaries.md      56 ++++++++++++++-
```

`1619fe0..0aebf42` — one commit, one file, 29 insertions, 2 deletions
(`docs/handoff/slice-6.5-evidence-boundaries-handoff.md`).

I read both diffs in full. Content: the ledger's §6.1 campaign-results table and
§6.2 residue statement, replacing the placeholder `*(filled in below …)*`; and
the handoff's §4 gate/campaign/pin numbers, replacing a cross-reference. Nothing
else.

### 4.3 Classification of every later change

| file | classification | executable? | gating? |
|---|---|---|---|
| `docs/handoff/slice-6.5-evidence-boundaries-handoff.md` | claims/handoff documentation | no | no |
| `docs/ledger/remediation-6.5-evidence-boundaries.md` | claims/ledger documentation | no | no |

"Documentation-only" is not sufficient on its own, so I checked each way
documentation bytes could reach a gate in this repository:

| could these bytes affect… | answer | how I checked |
|---|---|---|
| evidence pinning | **No** | the pin walks `fixtures/golden` only (`generate-evidence.mjs`); `docs/` is never read by the generator, and the two files are outside `fixtures/` |
| generated registries | **No** | `verify:generated` regenerates from `packages/contracts/schemas/**`; `docs/` is not an input |
| ledger tests | **No** | the only machine-read file under `docs/ledger/` is `requirements.json`, unchanged after `473b402`. `docs/ledger/negative-controls.json` is gitignored |
| claim-consistency tests | **No** | `grep -rn "docs/handoff\|docs/ledger\|docs/adr\|docs/claims" packages tests scripts` over `*.ts`/`*.mjs`/`*.js`/`*.json` returns two hits, both **comments**: a `$comment` in `trust.schema.json` and a doc-comment in `environmentCommands.test.ts` |
| design-revision checks | **No** | no check reads a `Normative revision:` line from a markdown file |
| negative-control target selection | **No** | every control's `file` is under `packages/` or `scripts/`; `tests` and `mustFail` name `tests/dist/**/*.test.js` |
| test discovery | **No** | `npm test` globs `tests/dist/**/*.test.js` and `packages/*/dist/test/**/*.test.js` |
| build output / contract generation / fixtures / harness classification or restoration | **No** | none of these has `docs/` on any input path |

The two changed files are **not executable, not gating, and not on any input path
of any check in the repository.** Under the §5.3 rule, the full 92-control
campaign against `473b402` is therefore inherited by `0aebf42` legitimately: no
later change touches production enforcement, designated tests, mutation targets
or postimages, build output, test discovery, contract generation, fixtures,
evidence generation, or harness classification or restoration. Nothing could
alter another control's reachability, because nothing altered any control's
inputs.

Re-running a 3½-hour campaign here would have been ceremony. I did not run it,
and the reason is above rather than asserted.

**One caveat worth stating.** The reported "final gate" in the handoff was run
from a clone at **`1619fe0`**, not at `0aebf42` — the handoff says so itself
("checked out at the candidate commit `1619fe0`"). So before my run, no gate had
ever been executed against the actual final HEAD. That is the specific gap
Mission A exists to close, and §4.4 closes it.

### 4.4 The exact-HEAD clean gate

Run in a disposable `git clone --no-hardlinks` of the repository, checked out at
`0aebf42`, with **byte identity to the candidate proven before use**:

```
tree(clone)    = c86761a68f5601ca2765f10b2ffdb0e1f97f9b92
tree(original) = c86761a68f5601ca2765f10b2ffdb0e1f97f9b92   ← identical
git status --short → empty
```

| gate | result | elapsed |
|---|---|---|
| `npm run clean` | ok | 1 s |
| `npm install` | ok | 1 s |
| `npm run build` | ok | 8 s |
| `npm run typecheck` | ok | 10 s |
| `npm run verify:generated` | generated types are current | 0 s |
| `npm test` | **922 tests, 922 pass, 0 fail, 0 cancelled, 0 skipped, 0 todo** | 1,754 s |
| `npm run purity` | **37 / 37** | 15 s |
| `npm run evidence:verify` | **787 pinned, 7 excluded**, byte-for-byte; **3 / 3** invalid goldens at exit 0 / `valid` in a fresh process | 86 s |
| `git diff --check` | clean | — |
| `git status --short` | empty | — |

**Total elapsed: 1,876 s (31 m 16 s.)** `evidence:update` was not run.

Additional checks required by §5.4:

| check | result |
|---|---|
| all three invalid goldens verify offline | **Yes** — `invalid-run-cancellation`, `invalid-run-classified-lab-failure`, `invalid-run-emergency-cleanup`, each exit 0 / verdict `valid`, each in a fresh process from the pinned bytes |
| pinned / excluded counts | **787 / 7**, matching `EXPECTED_PINNED` / `EXPECTED_EXCLUDED` |
| exclusion-manifest identity | **Unchanged.** Digest `5ac4efcb2a323dcfc93640a8bc7df819dd0126d165a990278b09a9da6da75342` verified by the gate; the same seven exact paths as before the branch. The pin **grew** 781 → 787 and did not narrow |
| generated drift | none — `verify:generated` clean |
| unexpected file-mode changes | none — `git status --short` empty, `git diff --check` clean |
| temporary directories | none surviving; the clone was removed after the run (§20) |
| surviving processes | none — verified with `pgrep` after the run |

### 4.5 Reconciliation with the reported evidence

| reported claim | verified? | note |
|---|---|---|
| baseline at `eaeec8c`: 883 tests, purity 37/37 | not re-run | out of Mission A's scope; the arithmetic 883 + 39 = 922 is consistent with what I measured at HEAD |
| final Step 6B total: 922 tests | **Yes** — 922 / 922 / 0 fail, measured at `0aebf42` | the reported figure was measured at `1619fe0`; it also holds at `0aebf42` |
| byte pin: 787 pinned / 7 excluded | **Yes** | |
| three invalid goldens verify offline | **Yes** | |
| negative controls: 92 / 92 agreed, zero harness errors | inherited, plus 12 reproduced (§4.6) | the shipped table contains exactly 92 controls at HEAD, which I counted independently |
| six new controls load-bearing | **Yes** — all six reproduced (§4.6) | |
| full campaign ran against `473b402` | consistent with the topology and inherited under §4.3 | |
| clean-checkout gate ran against `1619fe0` | **Yes, and that is the gap** — see §4.3's caveat; now closed at `0aebf42` | |
| final branch HEAD is `0aebf42` | **Yes** | |
| claims ceiling T1; OQ-005/007/008 open, fail-closed | **Yes** — §14, §17 | |
| PR #3 unmodified; no Step 6B branch pushed; no Step 6B PR | **Yes** — branch is local-only with no upstream | |

### 4.6 Independent negative-control reproduction

I reproduced **12 of the 92 controls** myself, in the disposable clone at exact
`0aebf42`, sampling from every remediation package rather than from Step 6B
alone. Elapsed **1,434 s (23 m 54 s)**.

Result: **12 of 12 scored, 12 agreed, 0 disagreed, 0 harness errors**, and the
harness certified `the working tree is byte-identical to how the campaign
started`.

| control | package | my result | ledger's recorded result | agrees |
|---|---|---|---|---|
| `durable-substrate` | false-attestation | 5 pass / 18 fail | 6 pass / 17 fail | ✔ kill, **counts drifted** — see below |
| `safe-action-completeness` | cleanup | 10 pass / 4 fail | 10 / 4 | ✔ exact |
| `invocation-count-not-dedup` | lifecycle ordering | 11 pass / 9 fail | 11 / 9 | ✔ exact |
| `signer-verifier-missing-direction` | signer inventory | 17 pass / 5 fail | 17 / 5 | ✔ exact |
| `signer-verifier-member-run-binding` | offline verifier binding | 21 pass / 1 fail | 21 / 1 | ✔ exact |
| `window-verifier-exact-cutoff` | cutoff window | 17 pass / 1 fail | 17 / 1 | ✔ exact |
| `mounted-file-byte-scan` | **Step 6B** | 10 pass / 2 fail | 10 / 2 | ✔ exact |
| `lab-telemetry-oracle-scan` | **Step 6B** | 9 pass / 3 fail | 9 / 3 | ✔ exact |
| `subject-output-secret-canary-scan` | **Step 6B** | 11 pass / 1 fail | 11 / 1 | ✔ exact |
| `subject-output-forbidden-identifier-scan` | **Step 6B** | 11 pass / 1 fail | 11 / 1 | ✔ exact |
| `subject-output-declared-byte-ceiling` | **Step 6B** | 11 pass / 1 fail | 11 / 1 | ✔ exact |
| `subject-output-byte-total-counts-payloads` | **Step 6B** | 11 pass / 1 fail | 11 / 1 | ✔ exact |

This covers everything §8.9 of the brief asked for: a false-attestation control,
a cleanup control, `invocation-count-not-dedup`, an offline-verifier binding, a
signer-inventory completeness control, a cutoff-window exactness control, and
**all six Step 6B controls**.

**All six Step 6B controls are load-bearing, and I measured that rather than
reading it.** Every one of the six matches the ledger's §6.1 table to the
individual case count.

Two observations worth recording.

**`lab-telemetry-oracle-scan` really does kill three.** The claim that the two
telemetry call sites are one rule rather than two copies is not an argument in
this campaign — disabling the single shared scanner takes down the refusal case,
the replay case and the invalid-terminal case together, and I reproduced exactly
that (9 / 3). Two copies would have killed at most one.

**`durable-substrate` drifted from its recorded counts, and that is a small live
illustration of R-05.** I measured 5 pass / 18 fail; the false-attestation,
invariants and cleanup ledgers each record 6 pass / 17 fail. The **total is 23 in
both**, so the designated suite has not grown — one case that survived the
mutation when that ledger was written now fails under it. Almost certainly a
later package strengthened a test in the same file, which is a strengthening and
entirely benign. But nothing in the harness ties a control's kill to *which*
cases it is supposed to kill, so the number moved silently and no gate noticed.
That is exactly the granularity gap **R-05** describes, observed rather than
hypothesised. The Step 6B ledger does not restate per-control rows for inherited
controls, so there is no HEAD-current figure for this control to have disagreed
with.
## 5. Diff and complexity inventory

`git diff --stat origin/main...0aebf42`: **270 files changed, 23,309 insertions,
1,255 deletions** — 60 files added, 210 modified, none deleted.

| category | added | removed |
|---|---|---|
| production source (`packages/*/src/**`) | 5,493 | 276 |
| tests (`tests/**`) | 7,794 | 134 |
| scripts (`scripts/**`) | 1,891 | 147 |
| schemas + generated types | 176 | 0 |
| docs + runbooks + README | 7,196 | 49 |
| fixtures (goldens) | 759 | 649 |

LOC is not a quality score; it is used here only to locate review concentration.
The concentration is unmistakable: **documentation is larger than the production
code it describes**, and tests are larger still.

**Contracts and authority surface — deliberately small:**

| dimension | delta |
|---|---|
| new contracts | **3** (`ERL2-C-157`, `ERL2-C-158` `cleanup-residue-probe/v1`, `ERL2-C-159`) |
| new error codes | **2** (`RESIDUE_PROBE_MISSING`, `RESIDUE_UNDECLARED_DESTRUCTION`) |
| new closure-required artifact roles | **1** — `evidence-window-commitment`, added to *both* branch closures (required on the environment branch when traffic started, forbidden on the pre-environment branch). `cleanup-residue-probe/v1` is a new retained contract enforced through `deriveInvalidEnvironmentSemantics` rather than through the closure's required-role set; `substrate-binding` and `environment-archetype` were already required at `origin/main` and merely *absent from the emergency-cleanup golden*, which is why that fixture gained them |
| new signer roles / authority paths | **0** |
| new lifecycle *states* | 0 |
| new lifecycle *event types* | 1 (`emergency_cleanup_resumed`, targeting the existing `emergency_cleanup_started` state) |
| new ADRs | 6 (ADR-ERL2-027 … 032) |
| new ledgers | 7 (six remediation + `negative-control-harness.md`) |
| new handoffs | 6 |
| new CLI flags / development seams | 3 (`--crash-at`, `--invocation-log`, `--fake-output-bytes`) |
| negative controls | **30 → 92** |

That a stack this large adds zero new signer roles and one retained role is the
clearest single argument that the remediation is closing gaps rather than growing
the trusted surface.

**New producer/verifier derivations** (each a genuine second, independent
computation rather than a re-read of a producer field):

| derivation | producer | verifier |
|---|---|---|
| applicable signed-member set | `terminal/signerInventoryDerivation.ts` (372) | `library/inventoryCompleteness.ts` (375) |
| evidence cutoff | `capture/evidenceWindow.ts` | `library/cutoffDerivation.ts` (357) |
| exact evidence window | `capture/evidenceWindow.ts` | `library/windowDerivation.ts` (442) |
| subject-output payload accounting | manifest | `library/payloadAccounting.ts` (312) |
| cleanup residue | `environment/residueProbe.ts` | `library/environmentDerivation.ts` (1,399) |

**Complexity concentration and the largest changed functions.**

| file | lines |
|---|---|
| `packages/core/src/run/environmentRun.ts` | **4,227** |
| `packages/core/src/run/workspace.ts` | 3,035 |
| `scripts/negative-control.mjs` | 1,780 |
| `packages/public-verifier/src/library/environmentDerivation.ts` | 1,399 |

The six largest methods in `environmentRun.ts`:

| method | lines |
|---|---|
| `frontierDerivedCleanup` | **340** |
| `cancel` | 280 |
| `finalizeTerminal` | 272 |
| `invalidate` | 250 |
| `freezeObservation` | 224 |
| `journeyStart` | 216 |

**Against the brief's over-engineering flags:**

| flag | assessment |
|---|---|
| functions with excessive responsibility | **Yes** — `frontierDerivedCleanup` at 340 lines does lifecycle appending, action derivation, per-action dispatch with intent, receipt recording, failure synthesis and residue probing |
| repeated role tables | **Yes, deliberately** — two signer role tables, justified by ADR-ERL2-030 §5 and enforced by an architecture test. A real trade, not an oversight; see §9 and §15 |
| duplicated lifecycle applicability logic | **No** — terminal-variant applicability is derived in `environmentClosure.ts` / `closure.ts` and consumed elsewhere |
| duplicated producer/verifier code masquerading as independence | **No** — the two derivations are written from different sources, do not import each other, and an architecture test enforces the non-import |
| test-only architecture leaking into production | **Borderline, and handled well.** `crashBarrier.ts` is a production module whose only purpose is testability. It is a no-op function call when absent, core reads no environment variable (enforced by `tests/architecture`), and the seam arrives from the composition root gated on the development profile. This is the right shape for the property being bought |
| invariants enforced in many inconsistent locations | **No** — the recurring pattern is one definition, several call sites (`assertTelemetryOracleClean`, `freezeMountedFile`), which is what makes the controls meaningful |
| large mechanisms whose claimed benefit is narrower than their complexity | **One candidate** — the exclusion-manifest digest, which the script itself downgrades to "a speed bump backed by code review, NOT a cryptographic authorization". Cheap enough to keep |

---
## 6. Findings, P0 → P3

No P0 findings. No P1 findings. No P2 findings.

Eight P3 findings follow. Every one is non-blocking; none reopens a
false-attestation path; none is severity-inflated for complexity.

---

### R-01 (P3) — the `adapter_request` "shadowed" justification covers one of four call sites, and no test checks it

| | |
|---|---|
| **Affected** | [`docs/adr/ADR-ERL2-032.md:83-100`](docs/adr/ADR-ERL2-032.md), [`tests/adversarial/oracleSurfaceCoverage.test.ts:76-95`](tests/adversarial/oracleSurfaceCoverage.test.ts), [`tests/adversarial/oracleSurfaceCoverage.test.ts:139-144`](tests/adversarial/oracleSurfaceCoverage.test.ts), [`packages/core/src/run/workspace.ts:2997`](packages/core/src/run/workspace.ts) |
| **Violates** | ADR-ERL2-032 §2.1's own standard — a surface's classification must be derived, not asserted |
| **Reproduced** | Yes, by source trace |
| **Merge-blocking** | No |

`assertRequestOracleClean` has four production call sites:

| call site | what it scans |
|---|---|
| `workspace.ts:622` | the sealed **acquisition adapter request** |
| `workspace.ts:801` | the **package-verification request** |
| `environmentRun.ts:946` | the **subject execution plan**, before it is retained |
| `environmentRun.ts:1099` | the **adapter step request** |

ADR-ERL2-032 §2.1 and the `shadowed` string in `LIVE_SURFACE_EVIDENCE` both
reason about exactly one of these — "An `AdapterStepRequestV1` carries hashes, a
run id, an operation id, a deadline, and an `ArtifactRef` to the visible step" —
and conclude the surface is unreachable because *the visible step's own bytes are
refused as a `mounted_file` one call earlier*.

I checked the other three and the **conclusion holds**, but for a different
reason in each case, and that reason is nowhere recorded:

- the execution plan (`environmentRun.ts:908-938`) is composed exclusively of
  hashes, a run id and three integers — there is no attacker-influenced text
  field for a token to occupy, and the `mounted_file` argument does not apply to
  it at all;
- the acquisition request's only text-bearing field is
  `visible_step.artifact`, produced by `visibleStepRef` → `freezeMountedFile`,
  so the `mounted_file` argument *does* apply;
- the package-verification request is the same shape.

**Why the tests missed it.** `oracleSurfaceCoverage.test.ts:139-144` is the only
check on the shadowed branch, and it asserts three things: that `shadowed` is
non-empty, that it does not also name a test, and that it does not also name a
control. It never evaluates whether the shadowing is *true*. The classification
is therefore a comment with a test that checks the comment exists.

**Failure sequence.** A future contract revision adds one free-text field to
`SubjectExecutionPlanV1` — a driver label, an archetype name, an operator note.
`adapter_request` becomes genuinely live and demonstrable on that path. Nothing
fails: the coverage test still passes, `permitted-claims.md` still reads "live,
and **shadowed** … No shipped input reaches it", and the surface is
under-reported rather than over-reported. The direction is safe; the drift is
silent.

**Smallest remediation.** Make the shadowing reason per-call-site rather than
per-surface, and add an architecture assertion that every
`assertRequestOracleClean` call site is enumerated in the shadowing record — the
same "named individually rather than derived" discipline the rest of that file
already uses for pending surfaces.

---

### R-02 (P3) — the invalid-golden verification gate has no counterpart on the valid branch, and ADR-ERL2-029 §7's own argument applies there verbatim

| | |
|---|---|
| **Affected** | [`scripts/generate-evidence.mjs:135-147`](scripts/generate-evidence.mjs) (the unasserted `verify` call), [`scripts/generate-evidence.mjs:1032-1112`](scripts/generate-evidence.mjs) (the gate that covers only invalid records), [`scripts/generate-evidence.mjs:925`](scripts/generate-evidence.mjs) (`cli-transcript.json` excluded) |
| **Violates** | ADR-ERL2-029 §7's stated rationale; review Slice 6.5B P2 (golden `verify-record` exit codes exist only in an excluded transcript) |
| **Reproduced** | Yes — I ran the verification myself; see below |
| **Merge-blocking** | No |

ADR-ERL2-029 §7 states the defect precisely: `runCli` records `exit_code` into
the transcript and never asserts it, `cli-transcript.json` is the single file
excluded from the byte pin, and *a verifier regression against these records
changes no producer bytes, so it leaves `evidence:verify` green*. The remediation
built a gate that re-verifies **every invalid-run golden** in a fresh process and
requires `exit 0 && closure.verdict === "valid"`, enumerated from the directory
with an asserted count. That part is excellent and it fully closes the invalid
half.

The identical argument applies to the **valid** goldens and that half is not
closed. `generate-evidence.mjs:135-147` invokes
`erl2 verify --public-bundle … --offline` over `valid-pre-environment-run` and
pushes the result into `transcript` — i.e. into the one excluded file. Nothing
in `evidence:verify` asserts it, and I found no test that runs the offline
bundle verifier over the *pinned* golden either (`grep -rn "verify-bundle" tests`
returns nothing; the golden is used by `typedRefusals.test.ts` and
`selectionEvidenceDerivation.test.ts` only as a copy source for mutations). The
same is true of the Slice-4 journey `verify` invocations at `:598`, `:792` and
`:806`, and of the negative "verify-record refuses a public bundle" case at
`:208-221`.

**Observed result.** The pinned golden verifies correctly today. I ran, from the
repository root at `0aebf42`:

```
node packages/cli/dist/src/bin.js verify \
  --public-bundle fixtures/golden/valid-pre-environment-run/public-bundle.json \
  --root-config   fixtures/golden/valid-pre-environment-run/root-config.json \
  --artifact-root fixtures/golden/valid-pre-environment-run/artifacts \
  --lifecycle     fixtures/golden/valid-pre-environment-run/lifecycle.json --offline
```

→ `exit 0`, `"verdict": "valid"`, no findings, no errors.

So this is a **missing gate, not a live regression**. The exposure is narrow and
specific: a change that made the verifier reject historically-pinned valid
bundles — a contract tightening, a new required role, a stricter closure — would
be caught by the e2e suite only if the suite happens to exercise the same shape
from a fresh run. It would not be caught by the evidence gate, which is the gate
whose whole purpose is to be the last word on the goldens.

**Why the controls missed it.** The negative-control table contains no control
for the evidence gate itself; the gate is script-level and outside the
controls' file/patch model.

**Smallest remediation.** Add `EXPECTED_VALID_GOLDENS` beside
`EXPECTED_INVALID_GOLDENS`: enumerate directories carrying a `public-bundle.json`,
run `erl2 verify … --offline` in a fresh process, require exit 0 and
`data.verdict === "valid"`, and assert the count. It is roughly twenty lines and
it reuses the machinery already there.

---

### R-03 (P3) — the development-flag gate is still inconsistent on the `--adapter-entry` path, and the Step 6B handoff overstates its uniformity

| | |
|---|---|
| **Affected** | [`packages/cli/src/journeyCommands.ts:226-250`](packages/cli/src/journeyCommands.ts), [`packages/cli/src/journeyCommands.ts:84-102`](packages/cli/src/journeyCommands.ts), [`docs/handoff/slice-6.5-evidence-boundaries-handoff.md:133-135`](docs/handoff/slice-6.5-evidence-boundaries-handoff.md) |
| **Violates** | design §11.8 (development shortcuts are not reachable on the release surface); carried over from review Slice 6.5B P3 |
| **Reproduced** | Partially — by source trace; not by execution (see limitation) |
| **Merge-blocking** | No |

`subjectPort()` branches on `--adapter-entry` **before** the development-profile
check:

```ts
const entry = flags["adapter-entry"] as string | undefined;
if (entry === undefined) {
  assertFakeFlagsUnavailableUnlessDevelopmentProfile(flags);   // only here
  return new FakeSubjectPort({ ... });
}
if (flags["fake-acquire"] !== undefined ||
    flags["fake-verify-package"] !== undefined ||
    flags["fake-output-bytes"] !== undefined) { throw … }       // three of five
```

With `--adapter-entry` present, the five `--fake-*` journey flags are treated
three different ways:

| flag | with `--adapter-entry`, no `ERL2_DEVELOPMENT_FAKE_SUBJECT` |
|---|---|
| `--fake-acquire` | refused (`CFG_MISSING_REQUIRED`) |
| `--fake-verify-package` | refused (`CFG_MISSING_REQUIRED`) |
| `--fake-output-bytes` | refused (`CFG_MISSING_REQUIRED`) — **added by Step 6B** |
| `--fake-leak-canary` | **accepted, no profile check, then silently ignored** |
| `--fake-step-status` | **accepted, no profile check, then silently ignored** |

Step 6B added `--fake-output-bytes` to both lists, which is correct, and in doing
so left the pre-existing asymmetry in place one commit longer. The handoff then
states:

> **`--fake-output-bytes` is development-profile gated**, like every other
> `--fake-*` flag, and it is refused outright when `--adapter-entry` is present.

The first half is true of `--fake-output-bytes` itself. "like every other
`--fake-*` flag" is not true of `--fake-leak-canary` or `--fake-step-status` on
the `--adapter-entry` path.

**Impact.** Cosmetic. `fakeSubjectBehaviour(flags)` is consumed only inside the
fake-port branch, so on the hosted-adapter path both flags are inert. There is no
capability, no evidence effect and no claim effect. What there is: a
development-only flag accepted without its gate on the release surface, and a
declared flag that is silently ignored — the same "declared and silently ignored"
class the prior review recorded for `freeze-output --terminal-stage`.

**Limitation on reproduction.** I attempted four CLI probes with and without
`--adapter-entry`. All four returned `POLICY_RUN_IDENTITY_MISMATCH` first: the
ADR-ERL2-024 §4.1 run-identity binding is checked at the CLI dispatcher, before
`subjectPort()` is constructed. That is the remediation working correctly, and it
means isolating this path needs a genuinely preregistered run root. I did not
build one, so this finding rests on the source trace above rather than on an
executed refusal, and I state that rather than implying otherwise.

**Smallest remediation.** Hoist
`assertFakeFlagsUnavailableUnlessDevelopmentProfile(flags)` above the
`--adapter-entry` branch, and derive the "cannot steer a real adapter" list from
the same flag set rather than restating three of five names.

---

### R-04 (P3) — the producer boundaries enforce asymmetric rule sets, and the asymmetry is not recorded

| | |
|---|---|
| **Affected** | [`packages/core/src/run/workspace.ts:2974-2988`](packages/core/src/run/workspace.ts) (`freezeMountedFile`), [`packages/core/src/capture/capture.ts:197-204`](packages/core/src/capture/capture.ts) (`assertTelemetryOracleClean`), [`packages/core/src/adapter/outputFreezer.ts:311-330`](packages/core/src/adapter/outputFreezer.ts), [`packages/core/src/adapter/host.ts:147-186`](packages/core/src/adapter/host.ts), [`docs/adr/ADR-ERL2-032.md:219-227`](docs/adr/ADR-ERL2-032.md) §8 |
| **Violates** | nothing normative; ADR-ERL2-032 §8's completeness discipline ("recorded as audited, not as fixed") is applied to file count and path depth but not here |
| **Reproduced** | Yes, by source trace |
| **Merge-blocking** | No |

Step 6B's central insight is that a boundary must enforce *the rules that boundary
needs*, not the rules that happen to exist there. Applied to subject output it
found two missing rules — secret canaries and forbidden identifiers — and closed
them. The same question was not asked of the other two boundaries the same
package touched:

| boundary | judge canary | secret canary | forbidden identifier |
|---|---|---|---|
| `mounted_file` (`freezeMountedFile`) | yes | **no** | **no** |
| `lab_telemetry` (`assertTelemetryOracleClean`) | yes | **no** | **no** |
| subject output (`assertSubjectOutputContentClean` + prefill scan) | yes | yes | yes |
| adapter host mount (`treeFingerprint`, `host.ts:165-181`) | yes | yes | no |

`assertNoCanaryLeak` → `scanForCanaries` matches `CANARY_PATTERN` only. So a
`erl2-secret-…` token, or a `BEGIN RSA PRIVATE KEY` header, in a Lab-authored
mount's content or in a source snapshot's canonical bytes is **published**, and
is caught later only if that tree is also mounted through the Slice-5 adapter
host — which the environment walk does not do.

Reachability is genuinely narrow: source snapshots are Lab telemetry derived
from admitted archetype evidence sources, and mounted files are derived from
those snapshots, so a secret would have to enter through admitted governor data.
That is the *same* vector `EB-TELEMETRY` uses for a judge canary, and it works —
which is exactly why the asymmetry is worth naming rather than assuming away.

ADR-ERL2-032 §8 is scrupulous about recording what it did not decide (file
count, path depth, the four pending surfaces). This gap is not in that list.

**Why the tests and controls missed it.** Every evidence-boundary regression on
the mount and telemetry surfaces plants a *judge* canary, because that is the
rule those surfaces own. Nothing plants a secret there.

**Smallest remediation.** Either extend the two scans to `scanBytes`'s full
vocabulary — the definitions already exist and are already shared — or record the
asymmetry in ADR-ERL2-032 §8 as audited-not-fixed with the reachability argument
written down. The second is cheap and honest; the first is about six lines.

---

### R-05 (P3) — a negative control's kill is measured at file granularity, not at the granularity of the invariant

| | |
|---|---|
| **Affected** | [`scripts/negative-control.mjs:1410-1470`](scripts/negative-control.mjs) (`classifyTestRun`), and the six Step 6B control declarations at [`scripts/negative-control.mjs:1261-1362`](scripts/negative-control.mjs) |
| **Violates** | `docs/ledger/negative-control-harness.md`'s own standard — a control must prove it measured *its* guard |
| **Reproduced** | Yes, by source trace |
| **Merge-blocking** | No |

The targeting layer (`scripts/lib/controlTarget.mjs`) is genuinely rigorous: it
proves the patch landed at the declared preimage, at the declared multiplicity,
with no collateral splice. That solves the *preimage* half of the problem, which
is the half that killed `pre-dispatch-intent`.

The *postcondition* half is still coarse. `classifyTestRun` returns
`NAMED_TESTS_FAILED` — a kill — when `fail > 0` and every failing **file** is in
`mustFail`. It never checks *which case* failed. All six Step 6B controls name
the same twelve-case suite (`environmentEvidenceBoundaries.test.js`), so:

- `subject-output-secret-canary-scan` is scored a kill on "1 of 12 failed"
  without the harness ever confirming the failing case is `EB-OUTPUT: a secret
  canary …` rather than, say, `EB-OUTPUT: clean binary output freezes and the run
  finalizes` breaking for an unrelated reason;
- symmetrically, `lab-telemetry-oracle-scan`'s "3 of 12" is read as evidence that
  the two call sites are one rule. That inference is sound — I checked it at
  source — but the harness did not make it; a human reading the counts did.

The mitigation in place is real: the per-control pass/fail counts are published
in the ledger and a human compared them against expectation. That is review, not
measurement, and the harness ledger's own thesis is that the difference matters.

**Smallest remediation.** Let a control optionally declare `mustFailCases: [...]`
(test-name substrings) and require the spec reporter's failing-test names to
match. The reporter already prints them; `classifyTestRun` already parses
`^test at (.+?):\d+:\d+$` for the file and can parse the name beside it.

---

### R-06 (P3) — the negative-control harness has no per-control timeout, so a hang is indistinguishable from progress

| | |
|---|---|
| **Affected** | [`scripts/negative-control.mjs:1650`](scripts/negative-control.mjs) (build), [`scripts/negative-control.mjs:1673`](scripts/negative-control.mjs) (suite run) |
| **Violates** | review Slice 6.5B "Review-process defect (P3)" in spirit — the signal half was fixed, the hang half was not |
| **Reproduced** | Yes, by source trace |
| **Merge-blocking** | No |

Both `spawnSync` calls pass `{ cwd, encoding }` and nothing else — no `timeout`,
no `killSignal`, no `maxBuffer`. The repository's own suites run under Node's
`--test-timeout=0` (confirmed from the running gate's process arguments), so a
patched build whose designated suite hangs — precisely what a disabled guard can
cause, when a refusal becomes a wait — hangs the campaign indefinitely with no
diagnostic. In a 3½-hour campaign a hang and slow progress look identical.

The related SIGINT/SIGTERM/SIGHUP residue defect the prior review found *by
killing a campaign by hand* is properly closed: `createDisposableWorktree`
installs handlers, `release()` is idempotent, and `worktreeResidue()` makes
"nothing was left behind" checkable. `7fff4fa` fixed one *test* that hung; the
*harness* still cannot detect the next one.

Two lesser notes on the same two calls, both fail-safe and neither worth its own
finding: the default 1 MiB `maxBuffer` would truncate a very chatty suite's
stdout, which loses the trailing `ℹ pass/fail` summary and classifies as
`test_runner_failed` (a harness error, correctly, not a false kill); and
`run.stdout` of `null` on spawn failure degrades to the same outcome.

**Smallest remediation.** `timeout: <n>` plus `killSignal: "SIGKILL"` on both
`spawnSync` calls, and classify a timed-out control as a harness error rather
than as a result. Pick `n` from the observed slowest suite with a wide margin;
the two 64 MiB cases make `environmentEvidenceBoundaries` the reference point.

---

### R-07 (P3) — the declared output ceiling is a retention bound, and the code comment claims an ordering benefit it does not deliver

| | |
|---|---|
| **Affected** | [`packages/core/src/run/environmentRun.ts:1934-1955`](packages/core/src/run/environmentRun.ts), [`packages/core/src/run/environmentRun.ts:1136-1148`](packages/core/src/run/environmentRun.ts) |
| **Violates** | nothing normative; ADR-ERL2-032 §4 does not claim an ingestion bound, and `permitted-claims.md` is correspondingly careful |
| **Reproduced** | Yes, by source trace |
| **Merge-blocking** | No |

Two related observations.

**(a) The comment's ordering rationale is wrong as written.** `freezeOutput`
says:

> 1. the declared byte ceiling, first — it is the one check that must not require
>    materialising an over-large payload as text to reach a verdict;

But the line immediately above it already materialises every payload:

```ts
const payloads = outcomes.flatMap((outcome) =>
  outcome.output_refs.map((ref) => ({ path: ref.path, bytes: this.ws.store.read(ref.path) })));
assertSubjectOutputWithinDeclaredBytes(payloads, this.plannedPlan().limits.output_bytes);
```

The ordering avoids the *second*, string-sized copy (`toString("latin1")` in
`assertSubjectOutputContentClean`, ~2 bytes per byte), which is a real and
worthwhile saving. It does not avoid materialisation. The comment reads as though
it does.

**(b) The bytes are read twice.** `payloads` reads every payload, and then the
`subject_output_prefill` scan at `:1968-1981` re-reads every payload through
`this.ws.store.read(ref.path)` a second time to build its own targets. At the
declared 64 MiB ceiling that is 128 MiB of I/O and two simultaneous full copies
plus the latin1 string — comfortably over 300 MiB resident for a run at the
ceiling. `EB-SIZE: exactly at the declared ceiling is admitted` exercises exactly
this.

**(c) There is no per-step or ingestion bound.** `runStep` (`:1136-1148`) accepts
`response.outputBytes` and freezes it with no size check at all. The ceiling is
compared only at manifest-freeze time, over the run total. So a subject returning
a payload far above the ceiling is fully received, held in memory and written to
disk, and is refused afterwards — or exhausts the process first, in which case
the operator gets an OOM rather than `SUBJECT_OUTPUT_LIMIT_EXCEEDED`.

None of this is a claim defect: ADR-ERL2-032 §4 is explicitly about the bytes the
run *retains*, and `permitted-claims.md` says "the bytes the subject actually
produced … read back from the store". It is a robustness gap and a misleading
comment.

**Smallest remediation.** Correct the comment; read each payload once and share
the buffer between the ceiling check, the prefill scan and the content scan; and
consider a per-step bound so the refusal arrives before the bytes do. The last of
the three is the only one with any design content and belongs in its own package.

---

### R-08 (P3) — every test-support temporary directory is leaked, and two production ones are too

| | |
|---|---|
| **Affected** | [`tests/support/cliRun.ts:80, 212, 242`](tests/support/cliRun.ts), [`tests/support/governorRegistry.ts:174-175`](tests/support/governorRegistry.ts), [`tests/support/fakeRun.ts:67`](tests/support/fakeRun.ts), [`tests/support/adapterFixtures.ts:135-136`](tests/support/adapterFixtures.ts), [`tests/support/selectionFixture.ts:64`](tests/support/selectionFixture.ts), and — in **production** — [`packages/core/src/adapter/certification.ts:135-136`](packages/core/src/adapter/certification.ts) |
| **Violates** | this review brief's own §5.4 / §12 hygiene requirement ("no temporary directories"), and the standard the negative-control harness already meets |
| **Reproduced** | Yes, observed directly |
| **Merge-blocking** | No |

Found while checking whether my own gate run left residue. It did — and so does
every other run.

```
$ ls "$TMPDIR" | grep '^erl2-' | sed 's/-[A-Za-z0-9]\{6\}$//' | sort | uniq -c | sort -rn
27938 erl2-vault          27938 erl2-registry       22321 erl2-mid
10632 erl2-engine          7706 erl2-cert-store      7706 erl2-cert
 6412 erl2-adapter-ws      6412 erl2-adapter-store   3363 erl2-mutcopy
 2028 erl2-selection       1774 erl2-journey         1628 erl2-invcopy
```

Well over 190,000 leaked directories on this machine. `du` and `ls -ltd` over
them both fail with an argument-list overflow, which is its own comment on the
scale. These accumulate across every run in this checkout over time, not from one
gate — but a single full `npm test` contributes several thousand, and my gate run
contributed its share.

The cause is uniform: `grep -rn "rmSync\|after(\|afterEach" tests/support/*.ts`
returns **nothing**. Every `mkdtempSync` in the support layer is created and
abandoned. There is no `after` hook, no `t.after`, no explicit removal anywhere.

Two of the prefixes are **not** test-only. `certification.ts:135-136` creates
`erl2-cert-` and `erl2-cert-store-` inside `newHost()` on the production adapter
certification path and never removes either — 7,706 of each observed. That is a
production resource leak, small per call and unbounded over time.

**Why nothing caught it.** The residue discipline this branch built is real but
scoped: `worktreeResidue()` checks the *campaign's own* temp root and git
worktree registration, and the `RESIDUE` suite checks that an adapter leaves
nothing outside its run-scoped workspace. Neither asks whether the harness that
ran them left `$TMPDIR` behind. The ledger's "no `erl2-negative-control-*` temp
directory remains" is true and is silent about the other 190,000.

**Impact.** No integrity or claim consequence. It is a developer-machine and
CI-runner hygiene defect: inode pressure, slower `$TMPDIR` enumeration, and — on
a CI runner with a tmpfs — a plausible route to a confusing out-of-space failure
in the middle of a 30-minute suite.

**Smallest remediation.** A shared `tempRoot()` helper in `tests/support` that
registers each directory with `t.after`/`process.on("exit")` removal, and an
explicit `rmSync(..., { recursive: true, force: true })` in `certification.ts`'s
host teardown. The isolation-probe path at `isolationProbes.ts:924` already
imports `rmSync` and is the pattern to copy.
## 7. Original-finding closure matrix

Rows are the findings of `Independent-Code-Review-Slice-6.5B.md` §2. "Production
enforcement" names the line I traced, not the line a ledger cites. "Independent
reproduction" means I confirmed the closure myself at source or by running
something; it does not claim I re-ran the original exploit end to end in every
row, and where I did not I say so.

### P0

| # | Original finding | Status | Production enforcement | Independent reproduction | Negative control | Residual risk |
|---|---|---|---|---|---|---|
| P0-1 | `--substrate-root` ungated and unattested: a valid attestation over an environment never torn down | **Closed** | `substrateBinding.ts` + `environmentRun.ts:588-665` (bind before first dispatch), `:2342`, `:3111`, `:3187` (later phases re-derive from the binding); `substrate.ts` `instance()` is read-only and never mints an identity | Source-traced all five enforcement points; confirmed `instance()` cannot create the marker, which is the specific affordance the exploit needed | `durable-substrate`, `substrate-binding-validation`, `substrate-locator-conflict`, `locator-flag-development-gate` | Development substrate remains file-backed; a locally privileged operator can still edit both sides. Out of scope by design (T1). |

### P1 — cleanup, cancellation, terminal reachability

| # | Original finding | Status | Production enforcement | Independent reproduction | Negative control | Residual risk |
|---|---|---|---|---|---|---|
| P1-1 | Unconditional whole-environment `destroy()` before consulting the frontier | **Closed** | `frontierDerivedCleanup` (`environmentRun.ts`, ~340 lines) derives `safeActions(frontier)` first and dispatches per action; `residueProbe.ts` independently re-observes and computes `undeclared = destroyed \ authorized_targets` | Read both in full; the residue probe is a genuine independent observation, not a restatement of action outcomes | `unconditional-bounded-destroy`, `undeclared-destruction-detection`, `cleanup-residue-probe`, `actions-agree-with-residue` | None material |
| P1-2 | `erl2 cancel` not branch-dispatched — pre-environment terminal over a live environment | **Closed** | `cancellationBranch.ts` (148 lines) selects the branch from lifecycle state; `verify.ts:869` calls `deriveInvalidEnvironmentSemantics` so the verifier refuses the mismatch independently | Source-traced both halves; the verifier-side check is the one that matters and it exists | `branch-specific-cancellation`, `cancellation-cleanup-applicability`, `cancellation-branch-classification` | None material |
| P1-3 | `invalidityFindingHashes: []` hardcoded → terminal-less accepted run | **Closed** | `invalidityAttribution.ts` derives Lab-owned invalidity per failed gate | Source-traced | `invalid-finding-phase-gate`, `invalid-finding-lab-attribution` | None material |
| P1-4 | Restoration accepts a compensation that reverted nothing | **Closed** | `independentRestorationProbe` path; `compensation-mutation-binding` | The gate run at `0aebf42` executes eight `COMPENSATION-ADV` cases including "a receipt reading `succeeded` over a mutation that is still applied is refused" and "`reverted nothing` and `had nothing to revert` are different answers" — I watched them pass | `compensation-mutation-binding`, `independent-restoration-probe`, `restore-receipt-status` | None material |
| P1-5 | A foreign resource aborts emergency cleanup entirely | **Closed** | per-action `try/catch` in `frontierDerivedCleanup`; a driver fault on one action is that action's failure, and a synthetic failed receipt is recorded so `buildEmergencyCleanup` still has something to bind | Read in full | `foreign-resource-classification`, `safe-action-completeness`, `per-action-emergency-cleanup` | None material |
| P1-6 | Verifier accepts an omitted safe action, and a safe action relabelled as an unsafe skip | **Closed** | `environmentDerivation.ts` (+488 lines) and `environmentClosure.ts` | Source-traced the derivation entry points | `safe-action-completeness`, `frontier-action-derivation`, `verifier-*-derivation` trio | None material |

### P1 — ordering, identity, exactly-once

| # | Original finding | Status | Production enforcement | Independent reproduction | Negative control | Residual risk |
|---|---|---|---|---|---|---|
| P1-7 | Subject steps and activation dispatched before any durable intent | **Closed** | `mutationIntent.ts` + `crashBarrier.ts`: eight named durability boundaries, real `SIGKILL`, durable invocation counters | `crashBoundaryMatrix.test.ts` proves it for **two** operations (`CRASH-STEP`, `CRASH-ACTIVATE`). Read the barrier module in full; the SIGKILL argument is sound and the counters are on disk, not in memory | `pre-dispatch-intent`, `intent-reconciliation`, `not-dispatched-proven`, `invocation-count-not-dedup`, `crash-lease-reclamation` | **Real.** `provision`, `restore`, `destroy` and the emergency actions have no real-crash coverage — only the in-process reconciliation matrix. The lifecycle ledger records this at line 453. See §10. |
| P1-8 | No run-identity binding between `--run` and `--run-root` | **Closed** | `runIdentity.ts`, enforced at three layers (CLI dispatcher, workspace opener, `RunWorkspace` constructor) | **Reproduced by execution.** Four CLI probes with mismatched `--run`/`--run-root` all returned `POLICY_RUN_IDENTITY_MISMATCH` before any other work — including before `subjectPort()` construction | `run-identity-validation` | None material |
| P1-9 | Post-capture intents can execute before activation and before the cutoff | **Closed** | `prerequisites.ts` + `JOURNEY_PREREQUISITES` matrix | Source-traced | `journey-prerequisite-matrix`, `post-capture-activation-requirement`, `prerequisite-evidence-derivation` | None material |
| P1-10 | A refused `journey` freezes cutoff policy with no lifecycle event | **Closed** | refusal now precedes the freeze | Source-traced | `refusal-before-cutoff-freeze`, `lazy-operational-directories` | None material |
| P1-11 | `verifyEnvironmentBundle` omits 9 of 13 cross-checks the pre-environment path performs | **Closed** | `verify.ts:463-700`: exposure-event lifecycle reachability + run binding, `verifySignerInventoryCompleteness`, `deriveEvidenceCutoff`, `deriveExactEvidenceWindow`, `verifySubjectOutputPayloads` | Read the whole diff of `verify.ts` | `environment-bundle-verifier` and the `signer-verifier-*` / `window-verifier-*` / `payload-*` families | None material |
| P1-12 | `FileSubstrateStore.load()` swallows every read error | **Closed** | `substrate.ts:167` — `ENOENT` is the *only* absence; an injectable `SubstrateIo` seam makes arbitrary faults testable without needing a root-sensitive permission test | Source-traced; the seam's justification is honest about why a permission test alone is insufficient | `narrow-enoent-substrate-read`, `substrate-state-shape-validation` | None material |

### P2 — selected

| Original finding | Status | Production enforcement | Independent reproduction | Negative control | Residual |
|---|---|---|---|---|---|
| Verifier never reads validity / restoration / teardown verdicts (`lab_validity` tautological) | **Closed** | `environmentDerivation.ts` re-derives all three | Source-traced | `verifier-validity-derivation`, `verifier-restoration-derivation`, `verifier-teardown-derivation` | None |
| `mounted_file` scanned with metadata that cannot contain the content | **Closed** | `workspace.ts:2974` `freezeMountedFile` — scan in memory → freeze → `store.verify(ref)` re-reads and compares length + digest against the *scanned* bytes | Verified the byte-equality claim myself: `freezeMountedFile` composes `Buffer.concat([jcsBytes(v), "\n"])`, which is exactly `ArtifactStore.freezeJson`'s body (`store.ts:187-196`) — so the pin genuinely cannot have moved | `mounted-file-byte-scan` | None |
| Only 2 of 4 claimed-live oracle surfaces load-bearing | **Closed, with a downgrade** | claim moved to three proven + one shadowed | Confirmed the downgrade is correct and honest | `lab-telemetry-oracle-scan`, `mounted-file-byte-scan`, `subject-output-canary-scan` | **R-01** |
| Secret canaries / forbidden identifiers never scanned on subject output | **Closed** | `outputFreezer.ts:311` `assertSubjectOutputContentClean`, called at `environmentRun.ts:1984` before any freeze | Source-traced; `latin1` byte-view justification is correct | `subject-output-secret-canary-scan`, `subject-output-forbidden-identifier-scan` | **R-04** (the same two rules are still absent on the two neighbouring boundaries) |
| Declared subject-output size limit hashed and never enforced | **Closed** | `outputFreezer.ts:273` against `plannedPlan().limits.output_bytes` | Source-traced; both halves (exact-at, one-over) are driven through the shipped CLI at the real 64 MiB ceiling | `subject-output-declared-byte-ceiling`, `subject-output-byte-total-counts-payloads` | **R-07** |
| Evidence cutoff never re-derived offline | **Closed** | `cutoffDerivation.ts` (357 lines) + `windowDerivation.ts` (442 lines) | Read both | `cutoff-*` (4) and `window-*` (14) | One rule unreachable end to end — recorded, see §12 |
| Retained subject-output payloads have no presence/extra-file accounting | **Closed** | `payloadAccounting.ts` (312 lines), both directions, on all three branches | Read in full | `payload-presence-accounting`, `payload-directory-enumeration` | None |
| `--claim-scope` operator-supplied and ungated | **Closed** | `claimScope.ts` derives the ceiling; producer and verifier each re-derive | The gate run executes eight `CLAIM-SCOPE` cases including "the offline verifier rejects a self-consistent T3 bundle" — I watched them pass | `producer-claim-scope-derivation`, `verifier-claim-scope-rederivation` | None |
| Invalid terminal's primary finding names the wrong gate | **Closed** | `invalidityAttribution.ts` | Source-traced | `invalid-finding-phase-gate` | None |
| Verifier does not enforce Lab attribution on an invalid environment terminal | **Closed** | `deriveInvalidEnvironmentSemantics` | Source-traced | `invalid-finding-lab-attribution` (repaired in `9ba1a01` after ADR-028 silently broke it) | None |
| ADR-ERL2-023 controller receipt never required by the environment closure | **Closed** | now a required role | Source-traced | covered by the closure family | None |
| Signer inventory asserts completeness while omitting non-`signature` authority fields | **Closed** | producer: `signerInventoryDerivation.ts` (372 lines) resolves the authority field from the frozen schema; verifier: `inventoryCompleteness.ts` (375 lines) re-derives independently and never consults `complete_for_terminal_chain` | Read both, plus `signedMembers.ts`'s verifier-owned role table (no role collapse — 17 distinct roles) | 19 `signer-*` controls | Two hand-maintained tables must agree; see §15 |

### P3 (prior review)

| Original finding | Status |
|---|---|
| `slice-6.5-gap-matrix.md` wholly stale | **Closed** — marked superseded rather than rewritten, which is the right call for a dated snapshot |
| ADR registry stops at ADR-ERL2-017 | **Closed** — `requirements.json` now registers through ADR-ERL2-032 |
| ERL2-FR-015 claims scanning on all eight surfaces | **Closed** — the note now says three proven, one shadowed, four pending, and says the earlier claim was wrong |
| "Three new keys" undercount | Not re-verified; out of the packages under review |
| "a refusal writes no evidence" overclaimed | **Closed** — P1-10 |
| crash-resumability claim unbacked | **Closed for two operations**, open for four; see §10 |
| development-flag gate bypassed when `--adapter-entry` present | **Open** — see **R-03** |
| `freeze-output --terminal-stage` / `evaluate --finding` declared and ignored | Not re-verified |
| refused environment commands create empty `.substrate` / `.reservations` | **Closed** — `lazy-operational-directories` |
| trailing blank line | Not checked |
| harness leaves worktree + temp dir on signal | **Closed** — `disposableWorktree.mjs` handles SIGINT/SIGTERM/SIGHUP idempotently and re-raises with default disposition. The **hang** case is still open: **R-06** |
## 8. Integrated invariant analysis

Reviewed as one system rather than as six packages.

**Run and substrate identity (§8.1).** The chain is: `--run` must equal the run
id of `<run-root>/events/000000.json` (`runIdentity.ts`), checked at three
layers before the lease, before any directory creation, before any freeze and
before any port or driver is constructed. Then the substrate's identity is
established once, by `provision`, and every later phase re-derives it from the
retained `substrate-binding/v1` rather than from a flag
(`environmentRun.ts:2342, 3111, 3187`). `instance()` is deliberately read-only,
which is the specific property the P0-1 exploit needed and did not have.
`ENOENT` is the only condition that means "never provisioned"; every other errno
is a fault (`substrate.ts:167`). I attempted the original false-attestation shape
in its cheapest form — a run id pointed at a foreign run root — and got
`POLICY_RUN_IDENTITY_MISMATCH` from the dispatcher, before anything else ran.

**Durable intent and crash recovery (§8.2).** Intent is durable before external
dispatch, operation identity is stable, and `crashBarrier.ts` injects a real
uncatchable `SIGKILL` at eight named boundaries with invocation counters that
live on disk rather than in the crashed process's memory. The module's own
argument for why the prior in-process matrix was insufficient is correct and I
would have made it. Two operations are covered by real crashes. Four are not.
See §10.

**Cleanup and invalid-terminal closure (§8.3).** `frontierDerivedCleanup`
classifies before acting, attempts every independently safe action, isolates a
per-action driver fault as that action's failure, records a synthetic failed
receipt so a failed attempt still has something to bind to, and then
`residueProbe.ts` **independently re-observes the substrate** and computes
`destroyed \ authorized_targets`. That last step is the one that turns "the
producer says it cleaned up" into a set comparison an offline reader can
reproduce, and it is the strongest single piece of engineering in the stack.
`unobservable` is a refusal, not a pass.

**Offline verification (§8.4).** The verifier now independently derives: the
exposure event's lifecycle reachability *and* its run binding (`verify.ts:463-478`
— `index.get` proving retention was explicitly not enough), signer-inventory
completeness in both directions without consulting the producer's
`complete_for_terminal_chain`, validity/restoration/teardown verdicts, the
evidence cutoff, the exact evidence window, and payload presence and extras. The
invalid branch gets the same treatment plus a named refusal for a stray signer
inventory — placed *before* the closure derivation specifically so the reader
gets the category error rather than an anonymous unaccounted artifact. That
ordering choice is the kind of thing that distinguishes a verifier written for
readers from one written for a test.

**Signer inventory and authority separation (§8.5).** Seventeen distinct signer
roles, no collapse. `policy_author`, `challenge_governor`, `controller`,
`traffic_supervisor`, `runtime_attestor` and `final_attestation_signer` are all
separate and separately authorized. The role table is **verifier-owned**: a
bundle that signs the adapter manifest with the preregistrar's key is refused
even though both keys are pinned. Authorization cannot be self-issued — the role
comes from the verifier's table and the key grant from the pinned trust policy,
never from the artifact. The randomness policy
(`external-beacon-randomness-policy/v1`) sits under `policy_author`, which is the
corrected assignment.

One honest observation rather than a finding: `policy_author` now signs eight
contract types including the evidence-window commitment. The cutoff ledger states
the consequence plainly — "it does not stop an authorized `policy_author` from
committing a different window on purpose" — which is the right disclosure. It is
a breadth-of-role question for a later slice, not a defect here.

**Evidence cutoff and clock semantics (§8.6).** The window is signed before
observation; durations are whole-second-representable integers with schema
bounds; the milestone, the cutoff and the source-snapshot window are each
re-derived from separately signed instants; applicability is read from the
lifecycle rather than from whether a commitment happens to be retained — the
ledger's phrasing for why ("letting the retained set answer that question would
let an omission answer for itself") is exactly right. The move from
*bounds-exact* to *exact* is real: the prior pass derived the durations out of
the same instants it was checking, and a producer that moved the window inside
bounds with a matching milestone satisfied it.

**Producer evidence boundaries (§8.7).** Assessed from source; see §12.

**Evidence pins, goldens and generated state (§8.8).** The exclusion manifest is
itself digest-pinned, the pinned and excluded counts are pinned, a stale
exclusion is a failure, and coverage is pinned so a file cannot leave the
comparison by any route. No exclusion was widened by this branch: the manifest
digest is unchanged at `5ac4efcb…` and the count is unchanged at 7; the pin grew
781 → 787 for three new retained artifacts in the emergency-cleanup fixture, each
with its `.frozen` marker. Verification is non-destructive by construction —
routine generation writes to `mkdtemp`, and only the explicit `--update` touches
`fixtures/golden`. The prior concern about `verify-record` exit codes living only
in an excluded transcript is closed for invalid goldens and open for valid ones:
**R-02**.

---

## 9. Producer/verifier independence assessment

Genuine, with one qualification.

The strongest case is the signer inventory. ADR-ERL2-030 §5 requires the producer
and the verifier to derive the applicable set independently, and the
implementation follows through: two separately written tables, sourced
differently (the producer's from each `sealSigned(…)` call site, the verifier's
from the contracts it is willing to authorize), and
`tests/architecture/signerInventoryIndependence.test.ts` asserts both that they
agree *and* that neither package imports the other's. What is shared is what §5
permits — frozen contract identities, `signedSchemaAuthorityFields()` derived
from the frozen schema bundles, and canonical hashing. Sharing "which field
carries authority" is correct: two opinions on that would be a bug, not
independence.

The qualification: independence of this shape defends against *substitution and
omission by the producer*, which is the modelled attack, and it does not defend
against a *shared misunderstanding*. If both tables were written from the same
wrong reading of the design, they would agree and both be wrong. That is not a
defect in the design of the check; it is the boundary of what two hand-written
tables can prove, and it is worth stating because the ledgers occasionally read as
though agreement between them were stronger than it is.

The same pattern, correctly applied, appears in the cutoff/window derivations
(the verifier recomputes from separately signed instants rather than reading the
producer's arithmetic) and in the residue probe (an independent observation of
the substrate, not a restatement of action outcomes). In each case the verifier's
input is *retained bytes plus pinned configuration*, never a producer verdict.
`complete_for_terminal_chain` and `lab_validity` — the two schema constants that
used to be read as results — are now both ignored by the verifier by design.

---

## 10. Lifecycle and crash-recovery assessment

**What is proven.** Eight named durability boundaries; real `SIGKILL`; resume in
a genuinely new process; durable invocation counters. Applied to two operations:
a subject step (`CRASH-STEP`) and challenge activation (`CRASH-ACTIVATE`), plus
the seam's own development gate and an unknown-boundary refusal. Activation
recovery is byte-stable. The `INTENT-CRASH` matrix adds seven in-process
reconciliation cases covering intent-before-dispatch, restart-reconciles-then-
retries, ambiguous-crash-fails-closed, receipt/append idempotence and terminal
reachability after a reconciled crash.

**What is not proven, and why it matters.** `provision`, `restore`, `destroy` and
the emergency actions have **no real-crash coverage**. They are covered by the
in-process matrix only — and `crashBarrier.ts`'s own three-point argument for why
that is insufficient (unwinding runs `finally`, counters die with the process,
module state carries across a boundary a restart would reset) applies to them
exactly as it applies to the two that were upgraded.

This matters more for these four than for the two that were done, because they
are the operations that mutate the *substrate* rather than the run's own
evidence. A duplicated subject step produces a duplicated outcome the closure can
see. A duplicated `destroy` acts on the world.

`docs/ledger/remediation-6.5-lifecycle-ordering.md:453` records this as remaining
work, in those words. The disclosure is honest and complete. My assessment is
that **the additional crash matrices are justified and should be the next
package** — see §19.

The `emergency_cleanup_resumed` handling deserves a note in its favour: the
ledger records that building the continuation case *found a real defect* —
re-appending `op-emergency-cleanup-start` deduped to a no-op, the state never
advanced, and the terminal append became an illegal transition, so an interrupted
cleanup reached **zero** terminals. That is a genuine reachability bug found by
strengthening a control rather than by reasoning, which is the behaviour the
whole harness exists to produce.

---

## 11. Cleanup and invalid-terminal assessment

Against the §8.3 checklist, item by item:

| requirement | status | where |
|---|---|---|
| derives from the resource frontier | yes | `safeActions(frontier)` is computed before the first dispatch |
| classifies before acting | yes | the frontier is frozen and appended as a produced role before any action |
| attempts every independently safe action | yes | loop over `safe`, per-action `try/catch` |
| skips unsafe resources with a reason and no receipt | yes | `buildEmergencyCleanup` refuses an attempt with no receipt, which is why a failed attempt gets a synthetic receipt rather than a bare throw |
| one receipt per attempted safe action | yes | `record()` dedupes by `core_hash` and produces one `emergency-attempt-receipt` role each |
| never performs undeclared whole-environment destruction | yes | the unconditional `driver.destroy()` is gone; `undeclared_destruction` is a named probe outcome |
| independently probes cleanup residue | yes | `residueProbe.ts`; `unobservable` is a refusal |
| records Lab-owned invalidity for each applicable failed gate | yes | `invalidityAttribution.ts` |
| exactly one offline-verifiable invalid terminal | yes | asserted end to end in `EB-TELEMETRY: the run still reaches exactly one invalid terminal that verifies offline` |

All seven mutation shapes the brief names (missing safe action; safe action
marked unsafe; undeclared destruction; receipt for a skipped action; attempted
action without a receipt; false success over residual resources; foreign-resource
classification) have a corresponding control in the shipped table.

---

## 12. Evidence-boundary assessment (Step 6B, reassessed from source)

**Mounted files.** `freezeMountedFile` is the only writer into `subject-visible/`
— I checked every write in the tree, and the three call sites
(`environmentRun.ts:1742`, `:1852`, `workspace.ts:2939`) all go through it. The
ordering is scan-in-memory → freeze → `store.verify(ref)`, and the binding is
real: `refFor` builds the reference from the *scanned* input bytes' digest, and
`verify` re-reads the published file and compares length and digest against it.
`resolveConfined` walks component by component and `lstat`s each one, so a
symlink, a hard link, a device, a FIFO or a socket is refused before any write;
`ArtifactStore.freeze` refuses a path already frozen with different bytes, so a
resumed run cannot publish a mount its first attempt did not scan. Visible step
references cannot bypass the scan because `visibleStepRef` *is* a
`freezeMountedFile` call. Leaked tokens are not repeated in diagnostics —
`redactOracleLabel` uses the scan's own patterns, and `EB-MOUNT` asserts the whole
CLI envelope is token-free.

I independently verified the pin-safety claim rather than taking it: the bytes
`freezeMountedFile` composes, `Buffer.concat([jcsBytes(value), "\n"])` with
`mediaType: "application/json"` and `classification: "PUBLIC"`, are byte-for-byte
what `ArtifactStore.freezeJson(path, value, "PUBLIC")` composed before. No pinned
golden could have moved, and `EB-MOUNT-BIND` asserts the equality directly rather
than relying on the argument.

**Lab telemetry.** One scanner, two call sites, and the control disables the
scanner rather than one copy — which is what makes "the two call sites are one
rule" a measurement (3 of 12 cases die) rather than a claim. A real run reaches
it: `EB-TELEMETRY` plants the canary in an admitted archetype evidence source,
which is the only production route into a `SourceSnapshotV1`. Scanning precedes
retention: the `observe`-time call at `environmentRun.ts:1654` sits above the
`store.freezeJson("retained/observation/…")` loop, and the test asserts
`retained/observation` is empty afterwards — so a regression that moved the scan
back to `freezeObservation` alone would fail the test even though no control
isolates that ordering specifically. The second scan cannot conceal a missing
first scan for the same reason. The bytes handed to the scan are `jcsBytes(snapshot)`
— the canonical retained bytes — not a `JSON.stringify` of the in-memory object.

**Subject output.** The ceiling uses actual bytes read back from the store, per
occurrence, with no decoding and no descriptor reads; `Number.isSafeInteger` is
asserted at every accumulation step. Exact-at is admitted and one-over is refused,
both driven end to end through the shipped CLI at the real 64 MiB ceiling with the
padding computed from the payloads already on disk — not at an injected small
limit. Multibyte text counts bytes (`Buffer.byteLength`). Binary output is handled
as bytes: `sizedOutput` pads with `0xFF`, which is invalid UTF-8 in every position,
so a scanner that decoded first would mangle it — and `assertSubjectOutputContentClean`
matches over a `latin1` byte-preserving view precisely so a token adjacent to a
`U+FFFD` replacement cannot stop matching. Secret-canary and forbidden-identifier
scanning happen before the freeze. Errors carry a Lab-authored path and two
integers, never payload bytes. Replay cannot bypass: every decision is recomputed
from the same retained bytes, and `EB-SIZE` and `EB-MOUNT` both assert a retry
re-decides.

**ADR-ERL2-032 §5's omission of a judge-canary branch — is it justified?** Yes,
and I verified the load-bearing premise rather than the argument. The claim is
that the pre-existing `subject_output_prefill` scan already owns the judge-canary
rule *on the payload bytes*, so adding a second gate would silently retire the
control that proves the first one works. The premise is the part worth checking,
because if the pre-existing scan had inspected only outcome metadata — the exact
defect found on `mounted_file` — the justification would be inverted and a real
rule would be missing. It does not:
`git show eaeec8c:packages/core/src/run/environmentRun.ts` already contained

```
label: `subject-output:${ref.path}`,
bytes: this.ws.store.read(ref.path),
```

inside the `assertNoCanaryLeak` target list. The scan was over the payload bytes
before Step 6B touched it. The omission is justified by a real pre-existing
branch, not by an aversion to duplication, and `EB-OUTPUT: a judge canary still
refuses under its own rule, not the new one` is a correct ordering anchor.

**The shadowed `adapter_request` surface.** Is it truly unreachable for every
shipped input? For the step-request path, yes, for the stated reason. For the
other three call sites, yes, but for reasons that are not the stated one — see
**R-01**. Was downgrading from four live surfaces to three correct? Yes, and it
is the single most creditable act of the package: it *removes* a claim under a
stricter standard the package itself introduced, at the cost of a number that
looked better. Is retaining the unreachable enforcement useful defence in depth or
misleading dead code? Useful, on balance — it costs one `JSON.stringify` per
request and it becomes live again the moment a text-bearing field is added — but
it is now one of **two** enforcement points no shipped input can reach, the other
being the source-snapshot window comparison at
`packages/public-verifier/src/library/windowDerivation.ts:412-430`, which
`window-verifier-capture-window` ships as a declared `expect: "pass"` with the
reason in the control itself. Do the tests distinguish live guarantees from
shadowed guards? Yes — `SurfaceEvidence.shadowed` is a distinct branch that
forbids claiming a test or a control alongside it. That is the right shape; it
just does not check the shadowing claim (**R-01**).

---

## 13. Negative-control harness assessment

The harness is the most improved component on the branch and, with two
exceptions, I would trust its output.

**What is genuinely strong.** Unique target resolution with a proven preimage
(`controlTarget.mjs`), a *positional* postimage check (bytes at each computed
offset are the postimage, every byte outside the spliced ranges is unchanged,
preimage residue accounted) rather than an occurrence count that `];` would
satisfy ten ways; ten distinct harness-error outcomes that are all classified as
"the campaign learned nothing" rather than as results; `no_kill_as_declared`
separated from `tests_passed_unexpectedly`; a `cancelled > 0` or `pass + fail === 0`
summary classified as `test_runner_failed` — the fix for the case where a patched
verifier died on a `TypeError` and read as "the guard killed nothing"; restoration
from the git object store with a *returned residual* so a half-restored tree stops
the campaign instead of contaminating every later control; a tracked-file digest
that makes "the tree is unchanged" checkable; signal handlers that release
idempotently and re-raise with the default disposition; and a dirty-tree refusal
scoped to build-relevant paths, with the reasoning for why "refuse on any dirt"
would be worse written out.

Mutations are semantic rather than textual where it counts:
`subject-output-byte-total-counts-payloads` leaves the ceiling running and hands
it path lengths instead of payload bytes — a guard computing over the wrong
quantity, which is the exact defect class the review found on that surface. The
`String(1) === "2"` postimage for `subject-output-declared-byte-ceiling` is a
deliberate choice to keep TypeScript's narrowing alive so the control measures
rather than reporting a build failure. Both show the authors understood that a
mutation which crashes has not proven anything.

**Whether a mutation can crash instead of disabling the invariant.** It can, and
the harness now detects it: that is what the `cancelled`/`0 pass 0 fail` rule is
for, and the ledger records the one case where it happened.

**Controls hidden behind earlier guards.** Three were found and repaired by
removing the redundancy rather than by re-scoring the control, which is the right
direction. One (`window-verifier-capture-window`) is honestly shipped as
`expect: "pass"` with the reason.

**Concurrency safety.** Each campaign creates its own `mkdtemp` worktree, so two
campaigns do not collide; the build and the suite are `spawnSync`, so nothing
inside a campaign runs concurrently. The documented hazard — building while a
suite runs — is a cross-tool hazard, not an intra-harness one, and it is written
into the handoff.

**The two exceptions:** kill granularity is per-file, not per-case (**R-05**), and
there is no per-control timeout (**R-06**).

**Independent reproduction.** Twelve controls, sampled from every remediation
package, reproduced in the disposable clone: 12 scored, 12 agreed, 0 harness
errors, tree byte-identical afterwards. Eleven of twelve matched their recorded
counts exactly; the twelfth (`durable-substrate`) drifted by one case with an
unchanged total, which is the R-05 gap observed rather than argued. §4.6.

---

## 14. Claims audit

`docs/claims/permitted-claims.md` is, at `0aebf42`, the most trustworthy document
in the repository, and it earned that by *removing* claims.

| claim | verdict |
|---|---|
| "Three oracle-canary surfaces are scanned live **and proven**", fourth shadowed | **Supported.** The standard it introduces — a surface is live only when a shipped run refuses on it *and* a control proves the refusal load-bearing — is stricter than what the code had to satisfy before, and it is applied against its author's own interest. |
| "a refusal may be claimed not to republish what it refused" | **Supported.** Asserted on the whole CLI envelope, in every new boundary regression. |
| "retained subject-output payload bytes are scanned for secret canaries and forbidden identifiers" | **Supported**, and correctly scoped to *retained* bytes. |
| "the declared subject-output byte ceiling is enforced against the bytes the subject actually produced" | **Supported for retention.** It is not an ingestion bound and the document does not say it is — see **R-07** for why that distinction is worth keeping visible. |
| "It may **not** be claimed that these scans see anything the subject chose not to return" | Correct, and the kind of negative claim that makes the rest credible. |
| "the mandatory evidence gate verifies invalid goldens semantically" | **Supported**, and precisely scoped to *invalid* — the document does not overreach to the valid branch. That is honest; **R-02** is that the valid branch deserves the same gate, not that this sentence is wrong. |
| `requirements.json` ERL2-FR-015: "The earlier claim of all eight was wrong" | **Supported**, and stated as a correction rather than a restatement. |
| Claims ceiling **T1**, unchanged | **Supported.** Step 6B retains no new artifact, adds no signer, adds no lifecycle event and changes no schema shape; the whole branch adds three contracts, two error codes, one retained role (`evidence-window-commitment`) and **zero** new signer roles. |
| ERL2-OQ-005 / OQ-007 / OQ-008 open and fail-closed | **Supported**, with executable guards, not prose: `assertDriverEnabled`, `assertDevelopmentTierOnly` / `assertActiveRandomnessVariant`, `assertSandboxProfileEnabled`. OQ-008's status line is unusually careful — "locally observed but unauthenticated", never the producer-assertable `authenticated`. |

One claim I would tighten: the Step 6B handoff's "`--fake-output-bytes` is
development-profile gated, **like every other `--fake-*` flag**" (**R-03**).

---

## 15. Over-engineering and maintainability assessment

Being candid, as asked.

**The complexity is mostly essential.** Nearly every mechanism here exists
because a specific, reproduced exploit needed it, and removing it reopens that
exploit. The residue probe, the substrate binding, the independent signer
derivation, the exact window and the branch-dispatched cancellation are all in
that category. I would not recommend simplifying any of them.

**Where accidental complexity has accumulated:**

1. **`environmentRun.ts` is 4,227 lines** with a 340-line `frontierDerivedCleanup`
   and five other methods over 190 lines. It is now the run walk, the cleanup
   discipline, the terminal builder, the evidence-window producer and the crash
   seam host. This is the single largest maintainability risk on the branch, and
   it is the file every future package will have to touch. **This is the most
   important over-engineering risk**, and it is a structural one rather than a
   conceptual one — the ideas are fine, the file is not.

2. **Two hand-maintained role tables that must agree.** The independence is real
   and justified (§9), but the cost is that adding one signed contract means
   editing `signerInventoryDerivation.ts`, `signedMembers.ts`, and a fixture
   table in `tests/contract/signerInventoryFixtures.test.ts`, with an
   architecture test enforcing agreement. "Can the system be extended without
   modifying many role tables?" — no, and that is a deliberate trade rather than
   an oversight. It should be *recorded* as a trade.

3. **Enforcement points no shipped input reaches: now two.** `adapter_request`
   and the source-snapshot window comparison. Both are honestly recorded, and
   both are cheap. A third would be a pattern rather than a coincidence, and the
   right response then is a standing rule — an ADR that says how a shadowed
   enforcement point is recorded, when it may be retained and when it must be
   removed — rather than a third bespoke explanation.

4. **The documentation is now larger than the production code it describes.**
   +7,196 lines of ADR/ledger/handoff/claims/runbook against +5,493 lines of
   production source. Individually every document earns its place; collectively,
   the operational burden of producing and reviewing one of these packages is now
   substantial, and a reviewer who reads the ledgers first will be anchored
   before they see a line of code. (I read them last, deliberately, for that
   reason.)

**Ceremony added solely to satisfy internal verification:** very little. The one
candidate is the exclusion-manifest digest, which the script itself labels
"a speed bump backed by code review, NOT a cryptographic authorization" — an
accurate self-assessment, and cheap enough to keep.

**Are failure states still understandable?** Mostly. The verifier's ordering
choices are made *for the reader* (the stray-inventory refusal placed before the
closure so the cause is named rather than anonymous), which is a good sign. The
counter-example is the number of distinct refusal codes a single misconfigured
run can produce; that is inherent to fail-closed design.

**Does the security value justify the mechanism?** For the T1 claim actually
earned — a development-tier run with a deterministic fake driver — the mechanism
is heavier than the claim needs. But the mechanism is not *for* T1; it is the
substrate on which T2/T3 would be built, and building it before the claim rather
than after is the correct order. I would not call this over-engineered for its
purpose. I would call it under-factored for its size.

---

## 16. Test-runtime and the 64 MiB fixture recommendation

**Assessment: the two 64 MiB fixtures are justified as they stand, and I
recommend keeping them.** Recorded as a recommendation only; nothing was changed.

The two cases are `EB-SIZE: one byte over the declared ceiling refuses before the
manifest freezes` and `EB-SIZE: exactly at the declared ceiling is admitted`.
Each drives a real run to `remove`, computes the padding from the payloads already
on disk, and pushes the run's true total to exactly `67108864` or `67108865`.

Could the same production path be exercised with a smaller committed limit? Only
by making the limit movable. `SubjectExecutionPlanV1.limits.output_bytes` is
hardcoded at `environmentRun.ts:936` and hashed into every step request's
`resource_limit_hash`; the whole point of ADR-ERL2-032 §4 is that "a limit a
caller can move at the moment of enforcement is not a commitment". A
purpose-built fixture with a smaller committed limit would require either a
test-only bypass — explicitly excluded by the brief and by the ADR — or a
production seam that makes the ceiling configurable, which weakens the very
property under test. The honest answer is that the cheap version costs the
guarantee.

**What I would do instead**, in rough order of value per unit of effort:

1. **Read each payload once.** `freezeOutput` currently reads every payload twice
   (`payloads`, then again inside the `subject_output_prefill` target list). At
   the ceiling that is 128 MiB of I/O and two full resident copies. Sharing one
   buffer is a local change with no semantic cost and roughly halves the
   dominant term in both `EB-SIZE` cases. This is the single best available win.
2. **Make the two cases share one fixture.** Both drive an identical run to
   `remove` and differ only in the final `--fake-output-bytes` value. They cannot
   share the *run* (one refuses and one finalizes), but the setup phases are
   identical and are the expensive part.
3. **Leave the ceiling alone.**

**Other runtime observations from the gate I ran:**

- The dominant cost is not the 64 MiB fixtures. It is **CLI-driven e2e breadth**:
  individual cases in `claimScopeEscalation` and `compensationAdversarial` take
  40–110 seconds each, because each spawns a long sequence of separate `erl2`
  processes. `CLAIM-SCOPE: T1 is accepted, and an out-of-range or T4 request is a
  typed refusal` alone took 110 s.
- **Avoidable repeated CLI walks** are the obvious target: many adversarial cases
  re-drive the same prefix of the environment walk from scratch. A cached,
  copy-on-write run root at a few named phases would cut this materially, at the
  cost of some independence between cases — a trade worth *evaluating*, not one I
  would make unilaterally, because "every case drives the shipped binary from
  scratch" is load-bearing for several claims.
- **Brittle wall-clock dependencies:** none found. The evidence clock is pinned
  (`ERL2_EVIDENCE_CLOCK`), run ids are fixed in evidence generation, and the
  window derivations compare committed integers rather than measured elapsed time.
- **Tests likely to hang:** none observed in the gate. The harness's lack of a
  timeout (**R-06**) is the place where a future hang would hurt most.
- **Mutation cost disproportionate to the guarded invariant:** four of the six
  Step 6B controls designate the suite containing both 64 MiB cases, so each of
  those four controls pays that cost once. That is roughly the most expensive
  control-to-invariant ratio in the table, and it is a direct consequence of the
  (correct) decision to measure at the real ceiling. Recommendation 1 above is
  also the fix for this.
## 17. Open questions and deliberately unclaimed behaviour

**Open questions, verified open and verified fail-closed with executable guards
rather than prose:**

| | status | executable guard |
|---|---|---|
| ERL2-OQ-005 (Compose driver) | open | `assertSubstrateQualified` refuses the retained lock; `composeDriverManifestBody` emits `enabled: false`; `assertDriverEnabled` refuses; `doctor` reports `compose_environment_driver: disabled_pending_erl2_oq_005` |
| ERL2-OQ-007 (external beacon / threshold VRF) | open | `assertDevelopmentTierOnly` refuses a held-out or blind tier; `assertActiveRandomnessVariant` refuses every threshold-VRF policy; `requireDevelopmentTier` refuses a non-development tier at the CLI |
| ERL2-OQ-008 (container / disposable-VM substrate) | open | `assertSandboxProfileEnabled` refuses the container profile; `deriveIsolationAuthenticity` returns `locally_observed_unauthenticated` for a valid development-signed lock and never the producer-assertable `authenticated` |

OQ-008's recorded status is worth singling out as a model of honest disclosure:
twenty isolation controls were *observed*, and because the substrate lock is
signed by the repo-derivable development governor key rather than by a pinned
qualification authority, the evidence is classified as self-reported and the
producer-assertable verdict is withheld. That is a stronger discipline than most
of what this stack was built to fix.

**Deliberately unclaimed, and correctly so:**

- Four oracle-canary surfaces remain unscanned and are named individually in
  `PENDING_ORACLE_SCAN_SURFACES` (`environment_variable`, `process_argument`,
  `diagnostics`, `network_egress`), with the reason each is not produced by the
  environment walk written out in the coverage test rather than derived.
- Output **file count** and **path depth** on the environment subject-output path:
  audited, not fixed, and recorded as such in ADR-ERL2-032 §8.
- The evidence-window commitment does not prove the window was the *right* one,
  only that one was fixed under an authorized key before capture; and it does not
  demonstrate key custody, because the development composition holds the
  `policy_author` key in the run's own process.
- The subject-output scans see only bytes the subject returned; a subject that
  withholds output withholds it from the evidence.
- Claims ceiling remains **T1**. No component of this branch claims otherwise.

**Unproven claims and residual risks I would carry forward:**

1. **Crash coverage for `provision`, `restore`, `destroy` and the emergency
   actions.** Recorded as remaining at
   `docs/ledger/remediation-6.5-lifecycle-ordering.md:453`. These are the four
   operations that mutate the substrate rather than the run's own evidence, so
   they are the four where duplication acts on the world. §10.
2. **The source-snapshot window comparison** (`windowDerivation.ts:412-430`) is
   not reachable by any end-to-end mutation — resealing a snapshot moves three
   dependent artifacts and the closure refuses first. `window-verifier-capture-window`
   ships as a declared `expect: "pass"` with the reason in the control. The rule
   is exercised by pure cases in `evidenceWindowDerivation.test.ts`. I confirmed
   the shadowing argument is correct: this cannot be reached without breaking an
   earlier prerequisite, which is exactly what §9 of the brief says disqualifies a
   reproduction. Honestly recorded; permanently defence-in-depth.
3. **`adapter_request` is similarly unreachable**, for a reason that covers one of
   its four call sites (**R-01**).
4. **Two hand-written role tables must be kept in agreement** by a human editing
   both. §9, §15.
5. **The valid-golden verification outcome is ungated** (**R-02**).
6. Byte equivalence on Node 22 was not verified here.

---

## 18. Merge-readiness verdict

**MERGE-READY WITH NON-BLOCKING FOLLOW-UPS.**

The base rate for a branch this size is that something in the P0/P1 band survives
review. Nothing did. The four original false-attestation shapes are closed at
enforcement points I traced myself; the exact-HEAD gate is green at `0aebf42`
from a clean checkout; the evidence pin did not narrow; the claims document
*removed* a claim under a standard the package itself introduced; and the open
questions are held closed by executable guards rather than by prose.

The eight findings are all P3. None reopens a false-attestation path. Four are
evidence-completeness or claim-precision defects, two are harness and test-hygiene
robustness, one is a performance recommendation, and one is a leaked-temporary-
directory defect that also touches production code.

**Step 6B is complete** as scoped by ADR-ERL2-032: all four boundaries close, the
fifth (refusal redaction) was found and closed while building the tests, six new
controls are load-bearing, and the claims moved in the honest direction.

**The integrated remediation is merge-ready.** I would merge it and open the
follow-ups as their own package.

**Caveats a merging maintainer should carry, not blockers:**

- PR #3 covers remediation only through Step 6A. Step 6B was never pushed and has
  no PR. Merging the integrated stack means either extending #3's scope
  explicitly or opening a second PR for `eaeec8c..0aebf42`; whichever is chosen,
  the review record should say which commits a reviewer actually approved.
- The branch has no upstream and no branch protection. The evidence for this
  stack lives in a local branch and in documents inside it. That is a
  process risk rather than a code risk, and it is the one I would fix first.

---

## 19. Prioritized next steps

**Should P3 cleanup begin? Yes — but not first.** The P3 backlog is genuine and
small, and every item in it is cheap. It should be one package, after the crash
matrices, because it touches many files shallowly and would collide with anything
structural.

Recommended order:

1. **Crash matrices for `provision`, `restore`, `destroy` and the emergency
   actions** (the next work package). This is the largest remaining *integrity*
   gap, the only residual risk that acts on the world rather than on evidence, and
   the seam it needs (`crashBarrier.ts`, `--crash-at <boundary>@<operation-id-prefix>`)
   already exists. Everything else on this list is bookkeeping by comparison.
2. **R-02** — the valid-golden verification gate. ~20 lines, reuses the
   `EXPECTED_INVALID_GOLDENS` machinery, and closes the second half of an argument
   the project already made in its own ADR.
3. **R-06 then R-05** — harness timeout, then per-case kill granularity. Both make
   every future campaign more trustworthy, so they compound.
4. **R-07(b)** — read each payload once in `freezeOutput`. Local, no semantic
   cost, and it is also the cheapest available reduction in the suite's worst
   case. Fix the comment in the same edit.
5. **R-08** — temp-directory cleanup. Independent of everything else, trivially
   safe, and it removes a whole class of confusing CI failures.
6. **R-01, R-03, R-04** — the P3 claim-precision package: per-call-site shadowing
   record with an enumeration assertion; hoist the development-flag gate above the
   `--adapter-entry` branch; and either extend the two scans or record the
   asymmetry in ADR-ERL2-032 §8.
7. **Split `environmentRun.ts`.** Not urgent, and it will only get more expensive.
   `frontierDerivedCleanup` and the terminal builders are the natural seams. Do
   this before the next package that needs to add a phase, not after.
8. **Then evaluate** whether a standing ADR on shadowed enforcement points is
   warranted. At two it is a coincidence; at three it is a pattern, and the rule
   is cheaper to write before it is needed.

Deliberately **not** recommended: reducing the 64 MiB ceiling fixtures (§16), and
any simplification of the residue probe, the substrate binding, the independent
signer derivation or the branch-dispatched cancellation.

---

## 20. Command and evidence appendix

Every command below was run by me during this review. Nothing in the repository
worktree was modified except the creation of this document.

### 20.1 Safety preconditions (repository worktree, read-only)

```
git status --short                                  → (empty)
git branch --show-current                           → codex/6.5r-evidence-boundaries
git rev-parse HEAD                                  → 0aebf42be7d46732d3bbbdf8ec5add56e2e173a4
git rev-parse origin/main                           → e48bdc233f9399fa3315acf943f549a82f336077
git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}'  → (none)
git diff --check                                    → (clean)
```

### 20.2 Mission A topology

```
git merge-base --is-ancestor e48bdc2 0aebf42        → yes
git merge-base --is-ancestor eaeec8c 0aebf42        → yes
git merge-base --is-ancestor 473b402 0aebf42        → yes
git merge-base --is-ancestor 1619fe0 0aebf42        → yes

git log --oneline --decorate eaeec8c..0aebf42       → 6 commits, listed in §2
git log --reverse --oneline origin/main..0aebf42    → 30 commits

git diff --stat        473b402..0aebf42             → 2 files, 84 insertions, 3 deletions
git diff --name-status 473b402..0aebf42             → M docs/handoff/…, M docs/ledger/…
git diff               473b402..0aebf42             → read in full
git diff --stat        1619fe0..0aebf42             → 1 file, 29 insertions, 2 deletions
git diff --name-status 1619fe0..0aebf42             → M docs/handoff/…
git diff               1619fe0..0aebf42             → read in full
```

### 20.3 Proving the later changes are non-gating

```
grep -rn "docs/handoff\|docs/ledger\|docs/adr\|docs/claims\|docs/decisions" \
     packages tests scripts --include='*.ts' --include='*.mjs' \
     --include='*.js' --include='*.json'
```
→ two hits, both comments (`packages/contracts/schemas/trust.schema.json:5`
`$comment`; `tests/adversarial/environmentCommands.test.ts:11` doc-comment).

```
grep -n "\.md" scripts/generate-evidence.mjs        → no markdown input
grep -n '^    id: "' scripts/negative-control.mjs   → 92 controls; every `file:` under packages/ or scripts/
cat package.json                                    → test globs are tests/dist/** and packages/*/dist/test/**
```

### 20.4 The disposable clone and its byte identity

```
git clone --no-hardlinks /Users/karthik/Developer/qualiber-reality-lab <scratch>/gate-0aebf42
cd <scratch>/gate-0aebf42 && git checkout 0aebf42
git rev-parse HEAD        → 0aebf42be7d46732d3bbbdf8ec5add56e2e173a4
git rev-parse HEAD^{tree} → c86761a68f5601ca2765f10b2ffdb0e1f97f9b92
git status --short        → (empty)
```
Original worktree `git rev-parse HEAD^{tree}` → `c86761a68f5601ca2765f10b2ffdb0e1f97f9b92`
— identical, so the clone's tracked bytes are the candidate's.

### 20.5 The exact-HEAD clean gate (in the clone)

```
npm run clean            rc=0     1 s
npm install              rc=0     1 s
npm run build            rc=0     8 s
npm run typecheck        rc=0    10 s
npm run verify:generated rc=0     0 s
npm test                 rc=0 1,754 s
npm run purity           rc=0    15 s
npm run evidence:verify  rc=0    86 s
git diff --check         (clean)
git status --short       (empty)
TOTAL                          1,876 s
```

`npm test` reporter totals:
```
ℹ tests 922   ℹ pass 922   ℹ fail 0   ℹ cancelled 0   ℹ skipped 0   ℹ todo 0
ℹ duration_ms 1746335.081667
```

`npm run purity` reporter totals:
```
ℹ tests 37    ℹ pass 37    ℹ fail 0   ℹ cancelled 0   ℹ skipped 0   ℹ todo 0
```

`npm run evidence:verify` tail:
```
evidence:verify — pinned 787 files, excluded 7:
  … the same seven exact paths, unchanged …
evidence:verify OK — deterministic evidence matches the pinned goldens byte-for-byte

evidence:verify — directly verifying 3 invalid golden(s):
  ok   invalid-run-cancellation            — exit 0, verdict valid
  ok   invalid-run-classified-lab-failure  — exit 0, verdict valid
  ok   invalid-run-emergency-cleanup       — exit 0, verdict valid
evidence:verify OK — all 3 invalid goldens verify at exit 0 / valid in a fresh process
```

`npm run evidence:update` was **not** run.

### 20.6 Negative-control reproduction (in the clone)

```
node scripts/negative-control.mjs \
  mounted-file-byte-scan,lab-telemetry-oracle-scan,\
subject-output-secret-canary-scan,subject-output-forbidden-identifier-scan,\
subject-output-declared-byte-ceiling,subject-output-byte-total-counts-payloads,\
durable-substrate,safe-action-completeness,invocation-count-not-dedup,\
signer-verifier-member-run-binding,signer-verifier-missing-direction,\
window-verifier-exact-cutoff
```
→ `negative controls: 12 of 92`; elapsed 1,434 s. Final harness output:
```
the working tree is byte-identical to how the campaign started
all 12 control(s) matched their recorded expectation
```
Per-control results in §4.6.

### 20.7 Direct verification probes (repository worktree, read-only)

Offline verification of the pinned valid golden — the outcome **R-02** observes is
ungated:
```
node packages/cli/dist/src/bin.js verify \
  --public-bundle fixtures/golden/valid-pre-environment-run/public-bundle.json \
  --root-config   fixtures/golden/valid-pre-environment-run/root-config.json \
  --artifact-root fixtures/golden/valid-pre-environment-run/artifacts \
  --lifecycle     fixtures/golden/valid-pre-environment-run/lifecycle.json --offline
```
→ `exit 0`, `"ok": true`, `"verdict": "valid"`, `"findings": []`, `"errors": []`.

Development-flag gate probes (four invocations, with and without
`--adapter-entry`, without `ERL2_DEVELOPMENT_FAKE_SUBJECT`) — all four returned
`POLICY_RUN_IDENTITY_MISMATCH` from the dispatcher before `subjectPort()` was
reached, which is the ADR-ERL2-024 §4.1 binding working. See **R-03**'s stated
reproduction limitation. Temporary run roots created under the scratchpad were
removed immediately afterwards; `git status --short` was empty before and after.

Confirming the pin-safety claim independently:
```
git show eaeec8c:packages/core/src/run/environmentRun.ts | grep -n "store.read(ref.path)"
```
→ present at `eaeec8c`, which is what makes ADR-ERL2-032 §5's omission justified
(§12).

### 20.8 Final verification

```
git diff --check      → (clean)
git status --short    → ?? Independent-Code-Review-Integrated-6.5R.md   (only)
git rev-parse HEAD    → 0aebf42be7d46732d3bbbdf8ec5add56e2e173a4  (unchanged)
git rev-parse origin/main → e48bdc233f9399fa3315acf943f549a82f336077  (unchanged)
git worktree list     → the repository only
pgrep -f "node --test" → (none)
```

Temporary artifacts: the disposable clone and the campaign's `mkdtemp` worktree
were removed. No branch, PR or remote was created, modified or deleted. Neither
Qualiber checkout was inspected, searched, executed, imported from or modified at
any point.
