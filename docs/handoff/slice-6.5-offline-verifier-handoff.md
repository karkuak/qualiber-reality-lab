# Handoff — Slice 6.5 offline-verifier strengthening

Companion to [ADR-ERL2-029](../adr/ADR-ERL2-029.md) and
[`remediation-6.5-offline-verifier.md`](../ledger/remediation-6.5-offline-verifier.md).
Successor to [`slice-6.5-lifecycle-ordering-handoff.md`](slice-6.5-lifecycle-ordering-handoff.md).

## 1. State

Branch **`codex/6.5r-offline-verifier`**, cut from the Step 4 checkpoint on
`slice-6.5-cleanup-remediation`.

**Read §3 before planning any follow-up work.** The first act of this package was
auditing what the independent review's verifier findings still describe, and
**nine of the fourteen listed invariants were already closed** by ADR-ERL2-024,
-025, -026, -027 and -028. Treating the review's list as a work plan would have
re-implemented them.

Closed here: the **evidence cutoff**, **subject-output payload accounting**,
**exposure-event reachability**, and the **invalid-golden evidence gate**.

Open, and deliberately so: **signer-inventory completeness**, which measurement
showed is a three-layer defect that cannot be closed from the verifier alone. §4.

## 2. What changed

| Concern | Before | Now |
|---|---|---|
| `cutoff.runtime_milestone_hash` | a 32-byte string nothing resolved — *an observation bundle naming a nonexistent runtime milestone verified as valid* | resolved by exact hash **and** schema, must bind the receipt the cutoff names, must be lifecycle-reached and run-bound |
| the cutoff instant | asserted by the producer, never re-derived | decomposed against three separately signed instants and checked against every committed policy bound |
| clock evidence offline | unread | clock-domain agreement, wall/monotonic divergence and process-milestone skew all re-checked |
| `subject-output/` | outside the `retained/` accounting subtree entirely | accounted in both directions, by the same descriptor source `retainedFiles.ts` uses |
| a **missing** declared payload | silently skipped ("may have been scrubbed") | `ARTIFACT_NOT_FOUND` |
| an **undeclared extra** in the payload root | invisible to every layer | `GRAPH_CLOSURE_EXTRA_ARTIFACT` |
| `attestation.exposure_event_hash` | existence-only `index.get` | must be lifecycle-reached and run-bound |
| the invalid goldens' `verify-record` outcome | recorded in the one file excluded from the byte pin, never asserted | a mandatory gate that obtains its own exit codes in fresh processes |
| the negative-control harness | no signal handler; a killed campaign left a registered worktree and a temp dir | SIGINT/SIGTERM/SIGHUP release through the same path a normal exit does |

## 3. The audit — do not skip this

`Independent-Code-Review-Slice-6.5B.md` was written against `62158c3`. The table
in [`remediation-6.5-offline-verifier.md`](../ledger/remediation-6.5-offline-verifier.md)
§1 records, invariant by invariant, what is *actually* still open. Summary:
attestation↔run-record binding, package/selected-case binding, signed-member
verification, validity gates and findings, restoration, teardown,
emergency-cleanup completeness, the controller receipt and Lab attribution are
**all already closed**.

## 4. Signer-inventory completeness — measured, not closed

The one listed item this package does not close, and the reason it does not.

Measured on the shipped `valid-pre-environment-run` golden: **7** applicable
signed members, **1** listed, `complete_for_terminal_chain: true`.

Three layers, not one:

1. **The golden is fixture-built.** `tests/support/fakeRun.ts:722` hand-writes a
   one-entry inventory and asserts completeness. This is the **fourth** instance
   of the recurring failure the previous handoff §6 names — a test fixture that
   names a condition it does not contain — and it is why a completeness gate
   cannot simply be switched on: it would fail the goldens, which is a rule
   refusing the fixtures rather than a defect being caught.
2. **The producer reads one field.** `workspace.ts:2783` derives entries from
   `artifact.value["signature"]` literally, so a `wrapper_signature` member is
   omitted by construction. This is the review's finding and it is real.
3. **The verifier derives nothing.** `complete_for_terminal_chain` is
   `true as const` in both finalizers — the `lab_validity` tautology with a
   different field name.

Closing it regenerates the inventory, moves the attestation that binds it, and
moves the byte pin. ADR-ERL2-029 §4 records the definition of completeness the
derivation should use once the producer can satisfy it. **Nothing in this package
claims the inventory is complete**, and `permitted-claims.md` says so explicitly.

## 5. Verify it yourself

```bash
npm run build && npm run typecheck && npm run verify:generated
npm test
npm run purity
npm run evidence:verify
```

`evidence:verify` now prints a second block after the byte-pin result:

```
evidence:verify — directly verifying 3 invalid golden(s):
  ok   invalid-run-cancellation — exit 0, verdict valid
  ok   invalid-run-classified-lab-failure — exit 0, verdict valid
  ok   invalid-run-emergency-cleanup — exit 0, verdict valid
```

The behavioural claims, individually:

```bash
node --test tests/dist/integration/cutoffDerivation.test.js      # 18 pure derivation cases
node --test tests/dist/adversarial/subjectOutputPayloads.test.js #  8 CLI mutation cases
node --test tests/dist/adversarial/invalidGoldenGate.test.js     #  4 gate + sabotage cases
```

Expect **749 tests / 749 pass / 0 fail**, purity **24/24**, and
`evidence:verify OK — pinned 787 files, excluded 7`. The baseline was 719, so 30
cases are new. Verified from a clean `npm run clean && npm install` in a
disposable checkout of the branch tip.

## 6. Hazards to carry forward

- **Do not rebuild while a suite is running.** Inherited and still true.
- **A payload-root rule must account descriptors from every indexed artifact, not
  from the subject-output manifest alone.** The first version of
  `payloadAccounting.ts` accounted only against the manifest and refused the
  shipped environment run's `subject-output/steps/*.out` — which are declared one
  level down, by each step outcome's `output_refs`. The failure was correct
  behaviour from a wrong rule, and it surfaced only because `evidence:verify`
  drives a real environment walk. **A payload rule that passes the
  pre-environment fixtures is not yet tested.**
- **A byte flip is the wrong instrument for a payload-tamper test.** It corrupts
  the JSON, and the harness that walks the run to build a `--lifecycle` argument
  dies before the verifier is invoked — a failure that looks like a verifier
  result and is not one. Append whitespace instead: same canonical form, same
  `core_hash`, different stored bytes.
- **The cutoff derivation is bounds-exact.** Anyone quoting it must quote
  ADR-ERL2-029 §3.2 with it. A window moved inside the committed bounds, with its
  milestone moved to match, is not caught, and no reader that does not hold the
  durations can catch it.
- **`environmentDerivation.ts` contains literal NUL bytes** inside `join("\0")`
  string literals, so `rg` treats it as binary and skips it silently. Use `rg -a`.
  Pre-existing, not introduced here, and a real trap for any audit that greps.
- **Run the full 53 on the checkpoint.** `invalid-finding-lab-attribution` had been
  silently not applying since ADR-ERL2-028 — that package rewrote the exact lines
  the patch anchored on — and the campaign therefore proved nothing about Lab
  attribution for a whole package. It went unnoticed because the full set was
  never re-run after the change. Ledger §8.2.
- **Do not edit a tracked file while a campaign runs.** The harness digests the
  tree at start and refuses to certify a run whose tree moved. It fired once here,
  correctly, on a ledger edit of mine. The control *results* were still sound —
  mutations only ever happen in the worktree — but a run that cannot certify
  itself should not be quoted.
- **`npm run clean` dies on a stray `.DS_Store`.** `clean.mjs` treats every entry
  under `packages/`, `adapters/` and `packs/` as a directory, so one Finder visit
  makes the first step of the clean gate fail with `ENOTDIR`. Delete the
  `.DS_Store` files (they are gitignored) or the gate cannot start. Not fixed here
  — it is unrelated to this package — but it will cost the next session ten
  minutes if it is not written down.

## 7. What remains

- **Signer-inventory completeness** (§4) — producer + fixture + verifier.
- The producer-side P2 cluster, untouched here and named as out of scope in
  ADR-ERL2-029 §2: `mounted_file` scanned with metadata that cannot contain the
  mount; `lab_telemetry` with no negative control; secret canaries and forbidden
  identifiers unscanned on the environment subject-output surface; the declared
  subject-output size limit hashed and unenforced.
- The cutoff's residual (§6) — a signed window commitment, producer-side.
- The remaining P3 drift.
- ERL2-OQ-005, ERL2-OQ-007, ERL2-OQ-008 — unchanged, still fail-closed.
- Crash coverage for `provision`, `restore`, `destroy` and the emergency actions.

**The claims ceiling is unchanged: T1.** This package adds verifier refusals. It
measures no new environment, no new subject and no new robustness.

**The branch is not merge-ready.** Remaining independent-review findings must be
closed and the branch re-reviewed independently.
