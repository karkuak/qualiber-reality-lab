# Stabilization 6.5-P3 — R-02, R-05, R-06, R-08

Four of the eight P3 findings from `Independent-Code-Review-Integrated-6.5R.md`
are closed here. The other four are not, and nothing else was touched.

| | |
|---|---|
| Base | `321da5a3da0c845203a7db170e4cb20c131e30e1` — the merge commit of PR #3, tree `c663c58c67b9416006730b29ae87dde86d278e0c` |
| Branch | `codex/6.5-stabilization` |
| Executable candidate | `eaf902d79cef51fd4f0c3557a6722e2314f3d49d` — what the campaign and the full gate measured |
| Final candidate | this commit; the only changes after `eaf902d` are this ledger and a comment block |
| Findings closed | R-02, R-05, R-06, R-08 |
| Findings still open | R-01, R-03, R-04, R-07 |

**No claim moved.** Claims remain **T1**. ERL2-OQ-005, OQ-007 and OQ-008 remain
open and fail-closed. No contract, schema version, signer role or lifecycle event
was added; no ADR was written; no evidence fixture was regenerated and
`evidence:update` was not run. The byte pin neither grew nor narrowed: 787
pinned, 7 excluded, the same exclusion-manifest digest.

---

## R-02 — the valid-golden verification gate

ADR-ERL2-029 §7's argument was never about invalidity; it was about *where a
verification result is recorded*. `generate-evidence.mjs` ran
`erl2 verify --offline` over `valid-pre-environment-run` and pushed the outcome
into `transcript`, and `cli-transcript.json` is the one file excluded from the
byte pin. A verifier regression against a historically-pinned **valid** bundle
therefore changed no producer bytes and left `evidence:verify` green. The invalid
half of that argument was closed by ADR-ERL2-029; this closes the other half.

**What it does.** `evidence:verify` now enumerates golden directories carrying a
root `public-bundle.json`, asserts the count against `EXPECTED_VALID_GOLDENS = 1`,
and for each one runs `erl2 verify --public-bundle … --root-config … --artifact-root
… --lifecycle … --offline` in a fresh process over the pinned bytes, requiring
`exit 0 && data.verdict === "valid"`. A fixture missing any of its four inputs is
reported as malformed rather than reaching the verifier as a usage error.

Enumeration is one level deep on purpose: `**/artifacts/retained/public-bundle.json`
belongs to a run's own artifact tree and is not a fixture root. The transcript is
consulted for nothing.

The acceptance condition is now produced by one helper, `verifyPinnedGolden`,
shared with the invalid gate so the two halves cannot drift. The invalid gate is
otherwise unchanged.

**Closure evidence.**

- `evidence:verify` prints `all 1 valid goldens verify at exit 0 / valid in a
  fresh process`, alongside the unchanged `787 pinned, 7 excluded` and `all 3
  invalid goldens`.
- `tests/adversarial/validGoldenGate.test.ts`, 6 cases, all passing:
  the shipped golden is accepted unsabotaged; enumeration and the declared count
  agree with the tree and stay one level deep; and three sabotages of a **copy**
  are each rejected — a mutated `final_attestation.core_hash`, an unaccounted
  retained extra, and a truncated lifecycle.
- The first sabotage attempted was a mutated top-level `run_id`, and the gate
  **accepted** it: that scalar is not cross-checked. The case now mutates a
  bundle member instead. Worth recording, because a sabotage test that passes for
  the wrong reason is indistinguishable from one that works.
- `VALID-GATE: the live golden is byte-identical after every sabotage above`
  digests every file of the shipped fixture at module load and again as the last
  case in the file. The live goldens are never written to.

## R-05 — kill granularity at the case, not the file

`classifyTestRun` scored a kill when `fail > 0` and every failing *file* was
declared. All six Step 6B controls name the same twelve-case suite, so
"1 of 12 failed" was read as proof of a specific invariant by a human comparing
counts in a ledger. That is review, not measurement.

**What it does.** A control may declare `mustFailCases: [...]`, a list of
test-name excerpts. When present, every declared case must appear among the cases
the spec reporter actually reported as failing; when absent, behaviour is exactly
as before. A mismatch is `declared_cases_not_failed` — a **harness error**, never
an agreement and never a kill — and the result carries both `missingCases` and
the `failingCases` that did occur, so the diagnosis does not need a rerun.

Precedence is unchanged where it already existed: a failure in an undeclared file
is still `unrelated_tests_failed`, whatever it is named.

Declaration validation rejects an empty list, an empty or non-string entry, a
repeated entry, and `mustFailCases` on a control that expects no failure at all.

Two supporting changes, both hardening rather than new behaviour: the suite stage
now names `--test-reporter=spec` instead of relying on the default, because the
spec reporter's format is precisely what the classifier parses; and `runStage`
strips `NODE_TEST_CONTEXT` from the child environment, because a nested
`node --test` that sees it silently runs no files at all.

**The six controls and the cases they now name.**

| control | declared case(s) | proved failed |
|---|---|---|
| `mounted-file-byte-scan` | `EB-MOUNT: a canary in the mounted file's bytes refuses…`; `EB-MOUNT: the run cannot step past a refused mount by retrying it` | 2 of 2 |
| `lab-telemetry-oracle-scan` | the three `EB-TELEMETRY:` cases | 3 of 3 |
| `subject-output-secret-canary-scan` | `EB-OUTPUT: a secret canary in the subject's output bytes refuses before the freeze` | 1 of 1 |
| `subject-output-forbidden-identifier-scan` | `EB-OUTPUT: a forbidden identifier in the subject's output bytes refuses before the freeze` | 1 of 1 |
| `subject-output-declared-byte-ceiling` | `EB-SIZE: one byte over the declared ceiling refuses before the manifest freezes` | 1 of 1 |
| `subject-output-byte-total-counts-payloads` | `EB-SIZE: one byte over the declared ceiling refuses before the manifest freezes` | 1 of 1 |

In the campaign every declared case was among the actual failures, and no control
failed a case it did not declare inside its declared file. `lab-telemetry-oracle-scan`'s
"3 of 12" is now the harness's finding rather than a reader's inference. **No
mutation was altered to make the classifier pass.**

**Closure evidence.** Seven cases in `tests/integration/negativeControlHarness.test.ts`:
the reporter's failing-case names parsed from a real `node --test` run over a
throwaway fixture (so the parser is checked against the reporter, not against a
hand-written string); the intended case failing; only an unrelated case in the
same file failing; a declared case absent from reporter output; all-of-several
versus some-of-several; a legacy control with no `mustFailCases` keeping exactly
its old behaviour; and the shape validation. A further case asserts each of the
six controls names a case its suite actually defines.

## R-06 — bounded campaign stages

Both `spawnSync` calls passed `{ cwd, encoding }` and nothing else. Every suite
here runs under `--test-timeout=0`, so a patched build whose designated suite
hangs — precisely what a disabled guard can cause, when a refusal becomes a wait
— hung the campaign indefinitely, and in a multi-hour run a hang and slow
progress look identical.

**What it does.** One helper, `runStage`, wraps both stages with an explicit
`timeout`, `killSignal: "SIGKILL"` and a 32 MiB `maxBuffer`, and reports
`{ status, pid, stdout, stderr, elapsedMs, timedOut, spawnError }` with the null
stdout of a failed or killed spawn normalised to `""`. A timeout is
`stage_timed_out`: a harness error, never a kill and never an agreement, naming
the control and the stage. It also **aborts the campaign** rather than continuing,
because a killed stage may still have descendants inside the worktree the next
control is about to patch. The `finally` that releases the disposable worktree is
unchanged, so a timeout leaves no worktree behind, and `spawnSync` reaps the child
it killed before returning.

The 1 MiB default `maxBuffer` was its own latent defect: truncating a chatty
suite's stdout loses the trailing `ℹ pass/fail` summary and downgrades a real
measurement to a harness error.

**The chosen values, and why.** `build: 5 min`, `suite: 60 min`.

| stage | median | worst observed | bound | margin |
|---|---|---|---|---|
| build | 10.0–11.4 s | 50.5 s | 300 s | 5.9x |
| suite | 81.8–89.0 s | 1,280.1 s | 3,600 s | 2.8x |

Taken from `buildMs`/`suiteMs` recorded for all 92 controls across two full
campaigns, not from one timed file. This mattered:

- `environmentEvidenceBoundaries` — the reference point the review named — runs
  in **126 s** in campaign. The real worst case is `environment-bundle-verifier`,
  which designates two heavy e2e files in one stage.
- The same stage measured **858.7 s** in the first campaign and **1,280.1 s** in
  the second, same machine, same tree. 1.5x run-to-run variance is normal here.
- The first bound chosen was 20 minutes, which looked like an 8x margin against a
  single timed suite. It would have aborted the second campaign outright. It was
  raised to 60 minutes on the measured evidence, and this ledger records the near
  miss rather than the tidied conclusion.

The two stages are bounded separately because their needs differ by more than an
order of magnitude. The bound is not a performance budget — a suite that got
twice as slow should surface as a slow campaign a human investigates, not as a
scored hang.

**Closure evidence.** Five cases: an injected hanging command killed at a 400 ms
bound and classified as a timeout; a killed stage leaving no surviving process,
checked by `process.kill(pid, 0)` on the reaped pid; an unspawnable stage reported
as `spawnError` with `""` stdout rather than a null-property crash; a timeout
being a harness error under both expectations; and the bounds being distinct,
positive and wide margins over the measured worst cases. None waits on a
production timeout — the whole group runs in under a second.

## R-08 — temporary-directory ownership

`grep -rn "rmSync\|after(\|afterEach" tests/support/*.ts` returned nothing. Every
`mkdtempSync` in the support layer was created and abandoned, and two of them were
production: `certification.ts` builds a workspace and an artifact store per host,
up to eight hosts per certification, and kept none of them.

**The ownership model.** A directory from `tests/support/tempDirs.ts` is owned by
the **test file's process**, not by the individual case and not by the fixture
that asked for it. `node --test` runs each file in its own process, so "the file
finished" is a real boundary, and it is the last moment at which every fixture,
every `spawnSync` child and every assertion reading those bytes is provably done.
Removing earlier would mean guessing when a shared fixture stopped being shared:
`buildGovernorRegistry()` hands its root to a CLI subprocess, and several suites
build one expensive run root that a dozen later cases copy from.

That gives two removal points and no more — a single root `after` hook, and a
single `process.on("exit")` fallback — **one listener each per process**, not one
per directory. A per-directory listener would trade a directory leak for a
listener leak.

Both are installed at module load, and that timing is load-bearing. The first
implementation installed them lazily on first use; `node:test`'s `after` binds to
whatever test is *currently running*, so the hook attached to the first case of
every suite that builds its shared fixture there and deleted that fixture before
the rest of the file ran. **108 tests failed.** The commit
`R-08: install the removal hook at module load, not on first use` is that fix, and
it is recorded here because the broken version looks identical in review.

`node:test` is `require`d rather than imported, and only when `NODE_TEST_CONTEXT`
says this process is a test-runner child: loading it arms the root test, so an
unconditional import would make every non-test importer of the support layer emit
a phantom `ℹ tests 0` report.

**Production.** `certifyAdapter` collects each host's two roots and removes them
in a `finally` around the whole run — certified, refused, deadline-probe SIGKILL
and thrown alike. Teardown is best-effort and swallows its own errors: rethrowing
would replace a refusal, or a certification, with a filesystem error. No
certification contract, receipt field, check, claim or retained artifact changed;
`newHost` gained a parameter and the suite body became `runCertification`.

**Closure evidence.** Seven cases in `tests/integration/temporaryDirectoryCleanup.test.ts`,
all measuring **residue** rather than implementation: each runs the real thing in
a child process with `TMPDIR` pointed at a directory the test created, then lists
what is left. Tracking and immediate release; one listener for forty directories;
the support layer through the `exit` fallback; the support layer through the
deterministic `after` hook in a real `node --test` run; and certification on the
success, refusal and throwing paths.

**Measured over a full `npm test` under an isolated `TMPDIR`**, every prefix owned
by the six named paths is at **zero**: `erl2-mut-`, `erl2-mid-`, `erl2-prereg-`,
`erl2-registry-`, `erl2-vault-`, `erl2-adapter-ws-`, `erl2-adapter-store-`,
`erl2-selection-`, `erl2-valid-`, `erl2-invalid-cancellation-`,
`erl2-invalid-classified_lab_failure-`, `erl2-emergency-`, `erl2-cert-`,
`erl2-cert-store-`.

**What is still left, and why it is out of this package.** 678 entries remained in
that isolated root:

- **291** from `mkdtempSync` calls made directly in test files — 57 call sites
  across 93 prefixes (`erl2-engine-`, `erl2-mutcopy-`, `erl2-invcopy-`, …). R-08
  names six ownership paths; these are not among them. Closing them is a
  mechanical sweep of the same helper across the test corpus and belongs to its
  own package.
- **387** sibling paths of the form `<runRoot>.substrate` and
  `<runRoot>.reservations`, created *beside* a support-owned run root by
  production path derivation. Removing the root does not remove them. This class
  is **newly discovered**: the review's own tally collapsed prefixes with a
  six-character suffix rule that these names do not match, so they were invisible
  in its table. It is not a regression — before this package the roots leaked too
  — and it is reported rather than improvised on, because guessing derived-path
  conventions inside a generic helper is exactly the expansion the package scope
  excludes.

Pre-existing historical `erl2-*` directories elsewhere on the machine were not
touched.

---

## What was run

Under a task-owned isolated `TMPDIR`, at executable candidate `eaf902d`:

| | |
|---|---|
| `npm run verify:generated` | generated types are current |
| `npm run purity` | **37 / 37** |
| `npm test` | **948 / 948** — 0 fail, 0 cancelled, 0 skipped, 0 todo (922 before this package, +26 new) |
| `npm run evidence:verify` | **787 pinned, 7 excluded**, exclusion digest unchanged; **3 / 3** invalid goldens and **1 / 1** valid golden at exit 0 / `valid` in fresh processes |
| `npm run negative-control` | **92 selected, 92 agreed, 0 disagreements, 0 harness errors**; working tree byte-identical to the start |

The complete campaign was required and run twice, not sampled: the classifier and
the subprocess behaviour changed, six control declarations changed, and shared
test-support behaviour used by designated suites changed.

Only two things exist after `eaf902d`: this ledger, and a comment block in
`scripts/negative-control.mjs` recording the second campaign's timings. No
control targets `scripts/` — all 30 distinct target files are under `packages/` —
and a comment changes no byte any test or gate reads. `verify:generated`,
`purity`, `evidence:verify` and the full `npm test` were re-run at the exact final
HEAD regardless; the campaign was not re-run a third time.

## Still open

R-01 (the `adapter_request` "shadowed" justification), R-03 (the development-flag
gate on `--adapter-entry`), R-04 (asymmetric producer-boundary rule sets) and
R-07 (the output ceiling as a retention bound) are untouched and remain
non-blocking follow-ups. So does the maintenance-surface observation the review
called its most important structural finding.
