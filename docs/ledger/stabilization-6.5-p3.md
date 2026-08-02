# Stabilization 6.5-P3 — R-02, R-05, R-06, R-08

Four of the eight P3 findings from `Independent-Code-Review-Integrated-6.5R.md`
were taken up here. **Two of them were not closed at the first candidate**, and
this ledger says so before it says anything else, because the first version of
this document claimed all four were.

| finding | closed at | how |
|---|---|---|
| R-02 valid-golden gate | `eaf902d` | complete at the first candidate; unchanged since |
| R-05 case-level kill granularity | `eaf902d` | complete at the first candidate; extended to a seventh control below |
| R-06 bounded stages | **`e9614f5`** | **incomplete at `eaf902d`**: the bound killed and proved dead only the *direct* process, and both stages spawn descendants |
| R-08 temporary-directory ownership | **`dd1fbda`** | **incomplete at `eaf902d`**: the support layer owned each run root but not the two companions production derives beside it |

A defect **discovered by this package's own sabotage work** is also closed here:
the pre-environment public verifier accepted a bundle whose top-level `run_id`
disagreed with its signed attestation. See "The finding this package found".

| | |
|---|---|
| Base | `321da5a3da0c845203a7db170e4cb20c131e30e1` — the merge commit of PR #3, tree `c663c58c67b9416006730b29ae87dde86d278e0c` |
| Branch | `codex/6.5-stabilization` |
| First candidate | `eaf902d79cef51fd4f0c3557a6722e2314f3d49d` — R-02 and R-05 complete; R-06 and R-08 partial |
| Corrective candidate | `dd1fbda98201df198e0027119adcddcd8e7f5efd` — what the 93-control campaign and the full gate measured |
| Final candidate | this commit; the only change after `dd1fbda` is this ledger |
| Findings closed | R-02, R-05, R-06, R-08, plus the pre-environment run binding |
| Findings still open | R-01, R-03, R-04, R-07 |
| Deferred debt | 294 temporary directories from direct `mkdtempSync` calls in individual test files (see "Deferred") |

**No claim moved.** Claims remain **T1**. ERL2-OQ-005, OQ-007 and OQ-008 remain
open and fail-closed. No contract, schema version, signer role or lifecycle event
was added; no ADR was written; no evidence fixture was regenerated and
`evidence:update` was not run. The byte pin neither grew nor narrowed: 787
pinned, 7 excluded, the same exclusion-manifest digest. The run binding added
below reuses the existing `GRAPH_CLOSURE_TERMINAL_MISMATCH` code and the
environment branch's existing wording; it defines nothing new.

## The corrective commits

| commit | what |
|---|---|
| `9277aa0` | verifier: bind the pre-environment bundle to its signed run |
| `e9614f5` | negative-control: kill the complete timed-out stage process tree |
| `dd1fbda` | test-support: own environment locator companions |
| this commit | ledger: record corrected stabilization evidence |

---

## The finding this package found

Not by design review. The R-02 valid-golden gate needed a sabotage case, and the
first one written mutated the shipped bundle's top-level `run_id`. The verifier
returned **exit 0, verdict `valid`**. The sabotage case was rewritten to mutate a
bundle member instead, and the *accepted* mutation became this finding.

`bundle.run_id` is an unsigned scalar in an unsigned envelope. A reader can edit
it and recompute `bundle.core_hash`, and the document is then internally
self-consistent: no signature covers it, no hash contradicts it, no schema
rejects it. The **environment** branch has always required
`attestation.run_id === bundle.run_id`; `verifyPreEnvironmentBundle` did not.

It produced no wrong verdict about a run. Every derivation on that path takes its
run identity from `attestation.run_id`, which *is* signed, so the closure, the
signer inventory and the terminal were always derived from the real run. What it
permitted is a bundle that **presents itself** as a different run than the one it
attests — exactly what a reader relies on when filing, indexing or citing
evidence by run id. A P2 bundle-consistency defect, closed at
`packages/public-verifier/src/library/verify.ts` with the same typed code and the
same wording the environment branch uses, immediately after the attestation is
loaded and structurally validated. The environment branch is untouched.

**Exploit and refusal.** `tests/adversarial/preEnvironmentBundleRunBinding.test.ts`
copies the shipped valid golden, rewrites only the bundle's `run_id`, and
**recomputes `core_hash`** so the forged document is self-consistent before the
verifier sees it — asserted in the test, not assumed, so the refusal cannot be a
stale-hash or schema refusal wearing the right name. The signed attestation, the
signer inventory, the trust policy, the lifecycle and the root config are
asserted byte-identical to the fixture. The real offline verifier then runs in a
fresh process and refuses with `GRAPH_CLOSURE_TERMINAL_MISMATCH` and a message
matching `/different runs/`. The unmutated copy verifies clean in the same file.
**The live goldens are never written to.**

**Negative control.** `pre-environment-bundle-run-binding` removes the new
comparison. The identical comparison now exists on both branches, so its preimage
carries the following comment line to name *this* occurrence — without it the
targeting layer refuses the control as ambiguous, which is the behaviour that
exists to stop a control silently measuring the wrong one. Target outcome
`patch_applied`, `replacedCount 1`. It declares
`RUNBIND: a self-consistent bundle naming a different run than its attestation is refused`
and the campaign proved that case failed. It also trips
`RUNBIND: the environment branch already refused the same shape, and still does`,
which is expected: that case counts the comparison's occurrences in source
precisely so its removal is visible. The behavioural case is the one declared and
the one that carries the proof.

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

### What was incomplete at `eaf902d`, and why it mattered

The bound was real and it reached **exactly one process**. `spawnSync(… timeout,
killSignal: "SIGKILL")` kills and reaps the direct child, and both stages spawn
descendants: `npm run build` spawns node, and `node --test` spawns one process
per test file. The test written for it asserted `run.pid` was dead — which was
true, and was not the property that matters.

Measured directly, reproducing the old implementation exactly: a stage parent
that spawns a grandchild and hangs, bounded and SIGKILLed, gives
**`parent alive: false | grandchild alive: true`**. So a timed-out campaign stage
left a live process able to keep writing into the disposable worktree the next
control was about to patch — the precise hazard the abort path was added to
avoid.

### The corrective design (`e9614f5`)

- The stage is spawned `detached` on macOS and Linux, making it a process-group
  leader, with `shell: false` so nothing is word-split and there is no
  intermediate `sh` to swallow the signal.
- The bound SIGKILLs the **group** (`process.kill(-pid, "SIGKILL")`), falling
  back to the direct child if the group signal fails. Windows has no process
  groups, so it gets `taskkill /pid <pid> /T /F` rather than a negative pid,
  which there is not "the group" but a different pid or an error.
- The same discipline `packages/core/src/adapter/sandboxLauncher.ts` uses for
  adapter deadlines, **reimplemented rather than imported**: the harness must not
  depend on the tree it measures.
- After the direct child closes, the group is reconciled on *every* path, not
  only on timeout — a stage that returned cleanly while leaking a descendant is
  the same residue problem wearing a green tick. `stageTreeAlive` is a no-op when
  nothing survived; otherwise the kill is repeated, boundedly, and a group that
  outlives `STAGE_TREE_KILL_GRACE_MS` (5 s) is `stage_tree_termination_failed` —
  a harness error, never a kill, never an agreement — which aborts the campaign
  rather than patching a contended worktree.
- `spawnSync`'s `maxBuffer` is replaced by manual collection with the same 32 MiB
  bound, kept as a **tail**: everything the classifier reads is at the end of the
  stream, so discarding the head keeps a run classifiable where discarding the
  tail would downgrade a real measurement to a harness error.
- `NODE_TEST_CONTEXT` removal is preserved. `runStage` is now `async`; `main()`
  already was.
- Each stage gets its **own `TMPDIR`**, removed only *after* the tree is proven
  dead. Deleting a directory a surviving descendant is still writing to is how a
  cleanup becomes a corruption, so a stage whose termination failed keeps its
  root and reports the path instead.

**Closure evidence.** Seven cases, none waiting on a production timeout; the
whole group runs in about two seconds.

- `NC-PROCTREE: a timed-out stage kills its grandchild, not only its direct
  child` — the stage parent spawns a grandchild and writes **both pids to disk
  before it starts waiting**, so the proof survives the SIGKILL that removes
  every chance to report them. After a 1.5 s injected bound, both pids are dead
  by `process.kill(pid, 0)`, `treeTerminationFailed` is false, and the
  stage-owned temporary root is gone. Cleanup and kills in the `finally` are
  bounded on every failure path.
- `NC-PROCTREE: a stage that completes normally still leaves no descendant and no
  temporary root`.
- An injected hang killed at a 400 ms bound and classified as a timeout; an
  unspawnable stage reported as `spawnError` with `""` stdout; both timeout
  results being harness errors under either expectation; and the bounds being
  distinct, positive and wide margins over the measured worst cases.

**The bounds are unchanged**: build 5 min, suite 60 min. The 60-minute suite
bound is a **2.8x margin** over the worst suite stage measured locally
(1,280.1 s), and that margin is acknowledged as the thinnest number in this
package rather than widened speculatively. The corrective campaign's own worst
suite stage was 738.9 s and its worst build 20.7 s, consistent with the 1.5x
run-to-run variance already recorded.

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

### What was incomplete at `eaf902d`, and the correction (`dd1fbda`)

The support layer owned each run root. It did not own what production derives
*beside* it. `packages/cli/src/environmentCommands.ts:330-331`:

    substrateRoot   = suppliedSubstrate   ?? `${runRoot}.substrate`
    reservationRoot = suppliedReservation ?? `${runRoot}.reservations`

Those are **siblings, not children**, so removing the run root cannot remove
them. One full gate at `eaf902d` left **387** of them.

The correction adds an explicit ownership concept rather than a guess inside the
generic helper:

- `ownedRunRoot(prefix)` returns a root whose ownership set also carries the two
  companions, and is used **only** at the three `cliRun.ts` call sites whose
  roots are passed to the CLI as `--run-root` (`erl2-mut-`, `erl2-mid-`,
  `erl2-prereg-`). Adapter workspaces, artifact stores, governor registries and
  selection fixture roots are not run roots, derive no companions, and stay
  ordinary `ownedTempDir` values.
- Companions are **exact absolute paths registered at creation time**. There is
  no globbing and no prefix rule anywhere in the module: a cleanup that removed
  `${root}*` would, the first time one fixture root were a prefix of another,
  delete a directory it does not own.
- A companion may be absent — a run that never reached the environment branch
  derives no substrate — and `force` makes its absence a no-op.
- The deterministic `after` hook, the `process.on("exit")` fallback and
  `releaseTempDir` all remove the **whole** ownership set, so an early release
  and the end-of-file sweep cannot disagree about what "this directory" meant.
  `releaseTempDir` on a path this module never handed out is now a no-op rather
  than a delete.

The companion names are duplicated from the CLI rather than imported, and that is
the deliberate trade: passing explicit substrate and reservation roots *inside*
each run root would have stopped several suites exercising the production
**default** locator path — the thing they exist to test. Duplication is only safe
if a change on either side fails a test, so
`TMP-RUNROOT: the companion names still match the production defaults` pins both
the CLI source expressions and the helper's output.

**Closure evidence.** Three cases beyond the seven already there:

- the companion-name pin above;
- `TMP-RUNROOT: releasing a run root removes the whole ownership set` — one
  ownership set, not three; an existing companion removed; an absent one a no-op;
- `TMP-RUNROOT: a real environment CLI run leaves no root and no companion` —
  a child process with an isolated `TMPDIR` drives the shipped binary through
  freeze-package → verify-package → preregister-challenge → select → **provision**
  (the first command that resolves the locators), and **asserts both companions
  exist before it exits**, so an empty listing afterwards means "removed", not
  "never created". The parent then proves the run root, both companions and every
  support-owned prefix are gone, and that the isolated root is empty.

### Residue, measured at `dd1fbda`

Under two fresh task-owned roots — one for the full gate, one for the campaign:

| | full gate | campaign |
|---|---|---|
| support-owned roots | **0** | **0** |
| `.substrate` / `.reservations` companions | **0** | **0** |
| stage-owned temporary roots (`erl2-nc-stage-*`) | **0** | **0** |
| campaign worktrees (`erl2-negative-control-*`) | **0** | **0** |
| surviving stage processes or descendants | **0** | **0** |
| everything else | 294 | 1 |

The campaign root's single entry is Node's own `node-compile-cache`, not an
`erl2` directory. `stageTmpRemoved` is true on all 93 measured results, and no
stage output was truncated.

### Deferred

The **294** remaining entries in the gate root are `mkdtempSync` calls made
directly in individual test files — **57 call sites across 93 prefixes**
(`erl2-engine-` 60, `erl2-mutcopy-` 29, `erl2-invcopy-` 22, `erl2-windowcopy-`
18, `erl2-cutoff-` 18, …). They are **separate P3 hygiene debt**, deliberately
not swept in this branch: it is a mechanical application of the same helper
across the test corpus, and mixing it into a corrective package would bury the
corrections in 57 unrelated diffs. **The isolated `TMPDIR` is therefore not
empty, and this package does not claim it is.**

Pre-existing historical `erl2-*` directories elsewhere on the machine were not
touched.

---

## What was run

At corrective candidate `dd1fbda`, under two fresh task-owned isolated `TMPDIR`
roots:

| | |
|---|---|
| `npm run verify:generated` | generated types are current |
| `npm run purity` | **37 / 37** |
| `npm test` | **955 / 955** — 0 fail, 0 cancelled, 0 skipped, 0 todo |
| `npm run evidence:verify` | **787 pinned, 7 excluded**, exclusion digest unchanged; **3 / 3** invalid goldens and **1 / 1** valid golden at exit 0 / `valid` in fresh processes |
| `npm run negative-control` | **93 selected, 93 agreed, 0 disagreements, 0 harness errors**; working tree byte-identical to the start |

All **seven** `mustFailCases` controls proved their declared cases failed, the
new `pre-environment-bundle-run-binding` among them.

Test-count history across the package: 922 at the base → 948 at `eaf902d`
(+26) → 955 at `dd1fbda` (+7: three run-binding cases, two process-tree cases
replacing one direct-child case, three run-root companion cases).

The complete campaign was required and run three times, never sampled: a new
verifier enforcement point and control were added, the campaign's stage runner
changed, and test-support ownership changed again.

## Still open

R-01 (the `adapter_request` "shadowed" justification), R-03 (the development-flag
gate on `--adapter-entry`), R-04 (asymmetric producer-boundary rule sets) and
R-07 (the output ceiling as a retention bound) are untouched and remain
non-blocking follow-ups. So does the maintenance-surface observation the review
called its most important structural finding.

Carried forward as its own P3 item: the **294** temporary directories left by
`mkdtempSync` calls in individual test files, at **57 call sites across 93
prefixes**, outside the six support-layer ownership paths this package owns.

The thinnest number in the package remains the suite bound's **2.8x** margin over
the worst locally measured stage. Run-to-run variance on the same machine and
tree was 1.5x, so a CI runner roughly three times slower than this one would trip
it and abort a healthy campaign. It is recorded rather than widened, because
widening it on no evidence would trade a measured risk for an unmeasured one.
