# Remediation ledger — Slice 6.5 offline-verifier strengthening

Companion to [ADR-ERL2-029](../adr/ADR-ERL2-029.md). Successor to
[`remediation-6.5-lifecycle-ordering.md`](remediation-6.5-lifecycle-ordering.md).

## 1. The audit that came first

`Independent-Code-Review-Slice-6.5B.md` was written against `62158c3`. Four
remediation packages have landed since, and three of them closed verifier
findings. So the first work of this package was **measuring what is actually
still open**, not implementing from the review's list — the same discipline
ADR-ERL2-028 §1 established after the third time an ADR's own §14 claimed more
than its implementation delivered.

Read in full: `verify.ts`, `environmentDerivation.ts`, `environmentClosure.ts`,
`signedMembers.ts`, `referencedBytes.ts`, `retainedFiles.ts`,
`selectionEvidence.ts`, `artifactIndex.ts`, `claimScope.ts`.

| Invariant | Review said | Actually |
|---|---|---|
| attestation ↔ run-record binding (11 bindings) | 9 of 13 missing (P1-11) | **closed** — `verify.ts` cross-checks all of them against the derived closure |
| terminal variant derived before belief | — | **closed** — `deriveTerminalVariant` |
| terminal stage derived from lifecycle | — | **closed** — `environmentClosure.ts:293,513` |
| package / selected-case binding | missing (P1-11) | **closed** — the environment path calls the real `verifySelectionChain` and refuses a producer-named entry the chain does not derive |
| every retained signed member signature-verified | — | **closed** — verifier-owned role table; three signature field names; an undeclared signed contract is refused outright |
| validity verdict, gates, findings | never re-derived (P2) | **closed** — `deriveValidityOutcome` |
| restoration / teardown verdicts | never re-derived (P2) | **closed** — `deriveRestorationOutcome` (with a mandatory probe), `deriveTeardownOutcome` |
| emergency-cleanup completeness + residue | accepted omissions (P1-6) | **closed** — ADR-ERL2-027 |
| controller activation receipt required | never required (P2) | **closed** — required as soon as the lifecycle shows `challenge_activated` |
| Lab attribution on an invalid terminal | not enforced (P2) | **closed** — `assertInvalidFindingAttribution` over two failing phase kinds |
| inherited Step 4 journey ordering | — | **closed** — `assertJourneyOrderingFromLifecycle` |
| **evidence cutoff re-derived offline** | never (P2) | **OPEN → closed here** |
| **subject-output payload accounting** | none (P2) | **OPEN → closed here** |
| **exposure event lifecycle-reachable** | — | **OPEN → closed here** |
| **invalid-golden direct verification** | — | **OPEN → closed here** |
| **signer-inventory completeness** | `complete_for_terminal_chain` omits members (P2) | **OPEN → measured, not closed. §4.** |

**Nine of the fourteen listed invariants were already closed.** Repeating the
review's list as a work plan would have re-implemented them.

## 2. The evidence cutoff (ADR-ERL2-029 §3)

`cutoff.runtime_milestone_hash` was a 32-byte string nothing resolved. The three
cutoff inputs sit in `SUPPORTING_SCHEMAS` with a comment saying a reader needs
them "to re-derive `ObservationBundleV2.cutoff`" — and no reader did.

`cutoffDerivation.ts` is the reader's own derivation. It resolves all three inputs
by exact hash **and** schema, requires the milestone to bind the receipt the
*cutoff* names (not the one the producer was handed), requires both to be
lifecycle-reached and run-bound, re-checks clock-domain agreement, wall/monotonic
divergence and process-milestone skew, and derives the two windows from three
separately signed instants before checking them against every committed bound.

**Bounds-exact, not scalar-exact, and the ADR says so at length.** `WARMUP_MS` and
`OBSERVATION_MS` are composition constants that are not retained anywhere, so no
reader can recompute the scalar. What is proven is consistency with three
independently signed clocks and every committed bound. What is not proven is that
the operator chose a 1-second warmup rather than a 900 ms one. Closing that needs
a signed window commitment on the producer side — recorded as the successor
question in ADR-ERL2-029 §9, not resolved silently in code.

## 3. Subject-output payload accounting (ADR-ERL2-029 §5)

Two layers each half-covered these bytes:

- `verifyRetainedFileAccounting` walks `retained/` only, and says so in passing
  while explaining a different rule — a step outcome's second copy "lives under
  `subject-output/`, **outside this subtree**";
- `verifyReferencedBytes` rehashes a declared payload **only if it is present**;
  a missing non-content-addressed reference is deliberately skipped.

So a declared payload could be absent and an undeclared file could sit beside the
real ones, and both verified at exit 0 / `valid`.

`payloadAccounting.ts` accounts the payload root in both directions, on the same
terms `retained/` already had, and is shared by the pre-environment, environment
and invalid branches — the rule is not branch-specific and is not duplicated.

## 4. Signer-inventory completeness — measured, not closed

This is the one listed item this package does **not** close, and the reason is
that measuring it found the defect is larger and in a different layer than the
review recorded.

The review says: `complete_for_terminal_chain: true` while "omitting signed
members whose authority field is not literally named `signature`". Half of that
is already stale — `verifySignedMembers` reads `signature`, `root_signature` and
`wrapper_signature`, so *verifying* a wrapper-signed member is not the gap.

Measured against the shipped `valid-pre-environment-run` golden:

| | count |
|---|---|
| retained signed members | **9** |
| applicable members (excluding the attestation and the inventory itself) | **7** |
| entries the inventory lists | **1** |
| `complete_for_terminal_chain` | `true` |

The inventory names `acquisition-preregistration/v1` and nothing else, while the
run retains the trust policy, the timestamp checkpoint, the acquisition source
manifest, the preregistration verification receipt, the adapter manifest and the
generic run policy — every one of them signed.

There are **three** layers to it, not one:

1. **The golden is fixture-built.** `tests/support/fakeRun.ts:722` hand-writes a
   one-entry inventory and asserts completeness. This is the fourth instance of
   the recurring failure ADR-ERL2-028's handoff §6 names — *a test fixture that
   names a condition it does not contain* — and it is the reason a completeness
   gate cannot simply be switched on: it would fail the goldens, not a defect.
2. **The producer reads one field.** `workspace.ts:2783` derives entries from
   `artifact.value["signature"]` literally, so a `wrapper_signature` member (the
   beacon association wrapper) is omitted by construction. This is the review's
   finding, and it is real.
3. **The verifier derives nothing.** `complete_for_terminal_chain` is
   `true as const` in both finalizers — the `lab_validity` tautology with a
   different field name — and the retained→inventory direction is unchecked.

Closing it is a **producer + fixture + verifier** change that regenerates the
signer inventory, moves the attestation that binds it, and moves the byte pin.
That is materially outside "offline-verifier strengthening", and shipping the
verifier half alone would be a guard that fails the correct goldens.

**Disposition: open, fully characterized, handed to Step 6 with the measurement
above.** ADR-ERL2-029 §4 records the definition of completeness the derivation
should use when the producer can satisfy it. Nothing in this package claims the
inventory is complete, and `permitted-claims.md` says so.

## 5. The invalid-golden evidence gate (ADR-ERL2-029 §7)

`runCli` records `exit_code` and never asserts it; `cli-transcript.json` is the
single file excluded from the byte pin. So the three `verify-record` invocations
over the three invalid goldens had their real outcome recorded in the one place
the pin cannot see, and a verifier regression against invalid records — which
changes no producer bytes — left `evidence:verify` green.

The gate obtains its own exit codes in its own child processes, from the pinned
fixtures, and requires exit 0 **and** a closure verdict of `valid` for each. The
fixture list is enumerated from the directory and its count is asserted, so a new
invalid golden is covered the day it lands and none can silently leave.

## 6. Contracts

**No frozen schema changed shape or meaning, and no new contract identity was
added.** `packages/contracts/` is untouched for the second package in a row — no
schema, no registry entry, no generated type, and **no new error code**: every
refusal reuses a catalogued one (ADR-ERL2-029 §8).

The byte pin does not move. Every new rule is a refusal the shipped goldens
already satisfy.

## 7. Negative controls

Six new controls, bringing the campaign to **53**. Results in §8.

The harness gains **SIGINT/SIGTERM/SIGHUP handling** (review, "Review-process
defect (P3)"): the `finally` block ran on a return and a throw and on neither of
the two ways a long campaign actually ends. Normal and interrupted exits now
release through one shared `releaseWorktree()`. `SIGKILL` stays uncatchable by
construction, and a run after one still starts cleanly because `worktree add`
into a fresh `mkdtemp` path never collides and the handler's `prune` removes a
stale registration.

## 8. Campaign results

*(filled in from the measured run — see the handoff for the command)*

## 9. What this package does not claim

- Payload **contents** are not scanned. The accounting is byte-correspondence
  against descriptors; secret canaries and forbidden identifiers on the
  environment subject-output surface remain unscanned, and the declared
  output-size ceiling remains unenforced. Both are producer-side and belong to
  Step 6.
- The cutoff derivation does not prove the operator's chosen window (§2).
- The signer inventory is not claimed complete (§4).
- The claims ceiling is **unchanged: T1**.
