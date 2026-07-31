# Handoff — Slice 6.5 exact cutoff window (Step 6A)

Companion to [ADR-ERL2-031](../adr/ADR-ERL2-031.md) and
[`remediation-6.5-cutoff-window.md`](../ledger/remediation-6.5-cutoff-window.md).
Successor to [`slice-6.5-signer-inventory-handoff.md`](slice-6.5-signer-inventory-handoff.md).

## 1. State

Branch **`codex/6.5r-cutoff-window-commitment`**, cut from `9258d0f` on
`codex/6.5r-signer-inventory`.

This package closes the cutoff residual ADR-ERL2-029 §3.2 stated and §9 recorded
as the successor question. It closes nothing else and does not begin Step 6B.

Two commits precede it on the parent branch and are part of the same handoff,
because Step 6A could not have been measured without them:

| commit | what |
|---|---|
| `6985297` | negative-control harness: unique verified mutation targets |
| `9258d0f` | the 72-control campaign against the hardened harness |

## 2. What changed

| Concern | Before | Now |
|---|---|---|
| the exact evidence window | `WARMUP_MS` / `OBSERVATION_MS`, module constants retained in no contract | a signed `evidence-window-commitment/v1`, frozen before capture |
| the cutoff's durations | composition constants passed to `realizeCutoff` | the run's own **frozen** commitment, resolved by role |
| offline derivation | bounds-exact — the durations were read back out of the instants being checked | **exact** — cutoff, milestone boundary and capture window each recomputed |
| a window shifted *within* bounds, milestone moved to match | verified valid | `CUTOFF_BOUND_EXCEEDED` |
| the window's authority | none; a constant has no signer | `policy_author` — bounds it already, and stamps neither clock |
| signer inventory | n/a | an applicable signed member, through the general derivation |
| closure | n/a | environment optional role, required once traffic starts; forbidden pre-environment |

## 3. Read this before planning follow-up work

**`Instant` is second-precision and the producer *truncates* rather than
rounding.** `new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z")` turns a 900 ms
offset into `…T00:00:00Z` silently, so a sub-second window would render an instant
disagreeing with its own arithmetic by 900 ms. Both durations are `multipleOf:
1000` in the frozen schema and restated in integer arithmetic on both sides.
Anyone adding a duration to a retained contract needs this.

**The commitment is a *produced artifact*, not a supporting schema, and that is
load-bearing.** `available_evidence` is built by walking every lifecycle event's
`produced`, so an invalid terminal that reached traffic accounts for its
commitment and one that failed earlier fabricates none — both halves of the
applicability rule fall out of the general derivation. A supporting-schema entry
would have accounted for it *unconditionally*, including on runs that never
committed one, which is the shape that hides an omission.

**Sealing and writing are different acts, and the ordering depends on it.** The
window must be fixed before the milestone is observed or the milestone could be
chosen to fit it; but writing before the milestone check would leave retained
bytes on a refusal, which is the P1-10 defect ADR-ERL2-028 removed. The
commitment's bytes and signature exist before the milestone is read, and nothing
reaches the disk until neither artifact can still refuse.

**The byte pin does not move, and the first draft of the ADR said it would.** The
environment golden is a **shape-only closure summary**, not a byte-pinned run
tree, so a run retaining one more artifact adds a *row* and no files. 787 / 7
unchanged. Corrected in the ADR and the ledger rather than left to read as an
unexplained non-event.

## 4. Verified

| | |
|---|---|
| tests | **883 / 883 pass / 0 fail / 0 skipped** (838 inherited; 45 new) |
| purity | **37 / 37** (was 33; four new architecture cases) |
| `verify:generated` | clean |
| byte pin | **787 pinned / 7 excluded**, exclusion manifest unchanged |
| invalid goldens | 3 / 3 at exit 0 / verdict `valid`, in fresh processes |
| `git diff --check` | clean |

## 5. Verify it yourself

```bash
npm run build && npm run typecheck && npm run verify:generated
npm test
npm run purity
npm run evidence:verify
```

The behavioural claims, individually:

```bash
node --test tests/dist/integration/evidenceWindowDerivation.test.js       # the arithmetic, pure
node --test tests/dist/adversarial/evidenceWindowCommitment.test.js       # the semantic mutation battery
node --test tests/dist/contract/evidenceWindowContract.test.js            # the frozen schema's own refusals
node --test tests/dist/architecture/evidenceWindowIndependence.test.js    # producer/verifier independence
```

`WINDOW-SHIFTED-WITHIN-BOUNDS` is the one to read first: it executes
ADR-ERL2-029 §3.2's own sentence — warmup 1 s → 2 s inside the committed bounds,
milestone moved to match — and it now refuses.

## 6. Hazards to carry forward

- **Inherited and still true:** do not rebuild while a suite is running; do not
  edit a tracked file while a negative-control campaign runs; `npm run clean` dies
  on a stray `.DS_Store` under `packages/`, `adapters/` or `packs/`;
  `environmentDerivation.ts` contains literal NUL bytes so `rg` needs `-a`.
- **Retained artifacts are frozen read-only.** A mutation battery must `chmod`
  before writing and restore the mode after. The first run of this one failed with
  `EACCES` on every case.
- **The window commitment sits mid-lifecycle, so a mutation reseals far more than
  the signer-inventory battery does.** That battery rewrites the *last* event and
  stops. This one moves every later event's `prior_event_hash`, **and the run
  record's `lifecycle_head_hash`** — the head as it stood at the record's freeze
  point, which no earlier battery ever had to touch. Miss it and every case fails
  as `GRAPH_CLOSURE_TERMINAL_MISMATCH`, a real refusal from a rule that has nothing
  to do with the window.
- **The reseal must follow hashes into the run record generically.** It cites
  artifacts by hash across several role lists; a targeted rewrite of one field
  leaves the next case failing as "run record claims a `<role>` the lifecycle never
  produced".
- **An identity case is not optional.** `WINDOW-HARNESS` reseals the whole chain
  *unchanged* and requires the terminal to still verify. It failed twice before
  passing, and without it eleven resealing artefacts would have read as successful
  refusals.
- **A control can land on exactly the right bytes and still measure nothing.**
  See §7 — this cost five controls across two campaigns, and none of the five was a
  defect in a guard.

## 7. What the campaigns cost, and why they are worth it

Five controls across two campaigns measured nothing. **Not one was a defect in a
guard.** Two shapes recur, and unique targeting cannot see either:

**A patch that changes bytes without changing meaning.**
`window-producer-uses-frozen-commitment` substituted `2_000` / `4_000` for the
committed durations — and `2 000 + 4 000` is `1 000 + 5 000`, so the derived cutoff
was byte-identical. It scored 29 pass / 0 fail and read as a guard that is not
load-bearing.

**A guard standing behind another guard.** Three separate instances: the
commitment requirement was enforced twice on the valid branch, the window
derivation re-checked a reachability the closure already refuses, and one control
pointed at a *pure* suite whose fixtures contain no commitment at all. In each
case disabling one guard left another refusing, so neither could be killed and
neither was measured.

Both are only findable by running the **full** campaign. That is the same
conclusion the harness hardening reached from the other direction, and it is why
this package ran all 86 rather than the fifteen it believed it touched.

One further gap is recorded rather than papered over:
`window-verifier-capture-window` is an `expect: "pass"` control. No end-to-end
mutation reaches the source-snapshot window comparison, because resealing a
snapshot moves the observation bundle, the canonical envelope and the translation
receipt, and the closure refuses first with three unaccounted artifacts. The rule
is real and covered by the pure suite; what is missing is a mutation that reaches
it.

## 8. What remains

- The producer-side P2 cluster, untouched and named out of scope in ADR-ERL2-029
  §2, ADR-ERL2-030 §2 and ADR-ERL2-031 §2: `mounted_file` scanned with metadata
  that cannot contain the mount; `lab_telemetry` with no negative control; secret
  canaries and forbidden identifiers unscanned on the environment subject-output
  surface; the declared subject-output size limit hashed and unenforced.
- The remaining P3 drift.
- Crash coverage for `provision`, `restore`, `destroy` and the emergency actions.
- A mutation that reaches the source-snapshot window comparison (§7).
- ERL2-OQ-005, ERL2-OQ-007, ERL2-OQ-008 — unchanged, still fail-closed.

## 9. Claims

**The claims ceiling is unchanged: T1.**

The cutoff claim moves from *bounds-exact* to **exact**, and gains two limits it
does not earn:

- it does **not** stop a fully authorized `policy_author` from committing a
  different window on purpose. The commitment proves a window was fixed under an
  authorized key before capture and that every later instant matches it exactly —
  not that the window was the right one. Which windows are permissible is the
  cutoff policy's bounds; who may commit one is the trust policy's;
- it does **not** demonstrate key custody. This profile holds the `policy_author`
  key in the same process as the run, as it already does for the governor,
  controller, supervisor and attestor keys.

**The branch is not merge-ready.** Remaining independent-review findings must be
closed and the integrated remediation re-reviewed independently.
