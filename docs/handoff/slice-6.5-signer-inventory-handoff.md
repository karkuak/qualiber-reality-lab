# Handoff — Slice 6.5 signer-inventory completeness (Step 5B)

Companion to [ADR-ERL2-030](../adr/ADR-ERL2-030.md) and
[`remediation-6.5-signer-inventory.md`](../ledger/remediation-6.5-signer-inventory.md).
Successor to [`slice-6.5-offline-verifier-handoff.md`](slice-6.5-offline-verifier-handoff.md).

## 1. State

Branch **`codex/6.5r-signer-inventory`**, cut from the Step 5 checkpoint
`18ff237` on `codex/6.5r-offline-verifier`.

This package closes the one item Step 5 measured and deliberately left open. It
closes nothing else, and it does not begin Step 6.

## 2. What changed

| Concern | Before | Now |
|---|---|---|
| producer enumeration | `artifact.value["signature"]`, over the whole run root, keyed by core hash | every **file** under `retained/`, authority field resolved from the **frozen schema that declares it** |
| `complete_for_terminal_chain` | `true as const` in both finalizers | derived from the actual set; the builders refuse to seal an inventory they cannot certify |
| the fixture's inventory | one hand-written entry, completeness asserted beside it | projected from what the fixture actually retained, with a consistency assertion over the finished tree |
| the fixture's lifecycle | three retained signed members produced by no event | faithful to the shipped producer's `acquisition_preregistered` |
| verifier completeness | nothing derived; only entry → artifact | the expected set derived **independently** and compared bijectively |
| an inventory naming another run | unchecked | `GRAPH_CLOSURE_TERMINAL_MISMATCH` |
| an entry's `signature_sha256` | never read | cross-checked against the artifact's authority signature |
| the excluded-type list | read from the inventory | supplied by the verifier from the variant it derived, and the retained list must equal it |
| an invalid record retaining an inventory | an anonymous closure extra | a named refusal, before the closure |

## 3. The measurement

Every terminal below asserted `complete_for_terminal_chain: true`.

| terminal | retained signed | applicable | listed before | listed now |
|---|---|---|---|---|
| `valid-pre-environment-run` (fixture) | 9 | 7 | **1** | 7 |
| `generic-finalization-failed-verification` (CLI) | 9 | 7 | **6** | 7 |
| `generic-finalization-unsupported-verification` (CLI) | 9 | 7 | **6** | 7 |
| environment terminal (CLI) | 66 | 63 | **61** | 63 |
| `invalid-run-*` ×3 | — | n/a | no inventory | no inventory |

The CLI omissions were exactly the two members whose authority field is not named
`signature`: the mirrored trust root (`root_signature`, every run) and the beacon
association wrapper (`wrapper_signature`, environment branch).

## 4. Read this before planning follow-up work

**ADR-ERL2-029 §4.1's definition of the applicable set is unsatisfiable as
written.** Its three conditions make the retained `signer-inventory/v2` an
applicable member of itself, and an entry names an artifact by `core_hash`, so
adding one changes the hash the entry names. The producer had always excluded it
in a comment; the accepted ADR had not. ADR-ERL2-030 §3.2 records the omission and
closes it. Anyone re-deriving the applicable set from ADR-ERL2-029 alone will
build something that cannot exist.

**The reachability exemption is exactly two contracts, and it is load-bearing.**
`trust-policy-manifest/v2` and the *terminal* `trusted-timestamp-checkpoint/v1`
are the only signed contracts no lifecycle event produces. Measured: the three
*selection* checkpoints **are** reached, so the exemption cannot be narrowed by
schema. It is pinned by name in
`tests/architecture/signerInventoryIndependence.test.ts`; widening it is a visible
edit.

## 5. Verified

The full gate, run in a **disposable checkout of `b5650bb`** — `npm run clean`,
a fresh `npm install`, then every step including a from-scratch `npm run
evidence`:

| | |
|---|---|
| tests | **808 / 808 pass / 0 fail** (baseline 749; 59 new) |
| purity | **29 / 29** (was 24; five new architecture cases) |
| `verify:generated` | clean |
| byte pin | **787 pinned / 7 excluded**, exclusion manifest unchanged |
| invalid goldens | 3 / 3 at exit 0 / verdict `valid`, in fresh processes |
| `git diff --check` | clean |

Negative controls: **72 of 72 scored** against the committed candidate, working
tree byte-identical afterwards, no worktree, temp directory or process left. All
19 new controls load-bearing; one inherited control disagreed and was repaired
and re-measured (§6, ledger §9.2).

## 6. Verify it yourself

```bash
npm run build && npm run typecheck && npm run verify:generated
npm test
npm run purity
npm run evidence:verify
```

The behavioural claims, individually:

```bash
node --test tests/dist/integration/signerInventoryDerivation.test.js      # producer derivation, pure
node --test tests/dist/adversarial/signerInventoryCompleteness.test.js    # pre-environment CLI mutations
node --test tests/dist/adversarial/signerInventoryEnvironment.test.js     # environment CLI mutations
node --test tests/dist/contract/signerInventoryFixtures.test.js           # the goldens, measured
node --test tests/dist/architecture/signerInventoryIndependence.test.js   # producer/verifier independence
```

## 7. Hazards to carry forward

- **Inherited and still true:** do not rebuild while a suite is running; do not
  edit a tracked file while a negative-control campaign runs; `npm run clean` dies
  on a stray `.DS_Store`; `environmentDerivation.ts` contains literal NUL bytes so
  `rg` needs `-a`.
- **A raw byte edit is the wrong instrument for an inventory test.** It is refused
  by the derivation layer — the stored `core_hash` stops matching its bytes — long
  before any inventory rule runs. Every semantic case must reseal the chain:
  inventory → attestation → bundle → **bundle member descriptors** → the terminal
  lifecycle event. The descriptors are the step that is easy to forget; the bundle
  carries `byte_length` and `file_sha256` for the inventory and the attestation,
  and `verifyReferencedBytes` rehashes both.
- **A mutation battery needs an identity case.** `INV-HARNESS: re-sealing the
  chain unchanged still verifies` is what stops every other refusal in the file
  from being an artefact of the re-signing.
- **A rule behind a rule that fires first is dead code.** The invalid-record
  inventory refusal was written after the closure derivation, where the closure's
  rejected-extra rule reached it first; it had to move *before* the closure to
  become load-bearing. Ledger §9.1.
- **The producer's negative controls substitute the field list rather than
  deleting the loop.** Deleting a guard usually deletes a type narrowing with it,
  and a patched tree that does not compile measures nothing — the fourth time this
  campaign has hit that trap.
- **`pre-dispatch-intent` had been dead since ADR-ERL2-028.** Its anchor occurs
  twice in `mutationIntent.ts`; ADR-ERL2-028 added the earlier occurrence, so
  `String.replace` had been disabling the resume branch instead of the
  first-dispatch path. The full campaign found it at 7 pass / 0 fail; it is
  re-anchored on the comment the guard owns and re-measured at 3 pass / 4 fail.
  Ledger §9.2. **Two of the three controls that have died this way were found by
  running the full set, and neither by the focused subsets in between.**

## 8. What remains

- The producer-side P2 cluster, untouched and named out of scope in ADR-ERL2-029
  §2 and ADR-ERL2-030 §2: `mounted_file` scanned with metadata that cannot contain
  the mount; `lab_telemetry` with no negative control; secret canaries and
  forbidden identifiers unscanned on the environment subject-output surface; the
  declared subject-output size limit hashed and unenforced.
- The cutoff's residual — a **signed window commitment**, producer-side
  (ADR-ERL2-029 §9).
- The remaining P3 drift.
- ERL2-OQ-005, ERL2-OQ-007, ERL2-OQ-008 — unchanged, still fail-closed.
- Crash coverage for `provision`, `restore`, `destroy` and the emergency actions.

**The claims ceiling is unchanged: T1.** This package adds verifier refusals and
corrects producer output. It measures no new environment, no new subject and no
new robustness.

**The branch is not merge-ready.** Remaining independent-review findings must be
closed and the integrated remediation re-reviewed independently.
