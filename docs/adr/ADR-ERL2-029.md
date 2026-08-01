# ADR-ERL2-029 — the four verifier invariants a producer constant was standing in for: cutoff derivation, signer-inventory completeness, subject-output payload accounting, and a mandatory invalid-golden gate

- **Status:** accepted
- **Date:** 2026-07-30
- **Deciders:** Lab Architecture, Verification Audit, Evidence/Clock Authority
- **Supersedes:** nothing
- **Amends by record:** [ADR-ERL2-024](ADR-ERL2-024.md) §4.6 (the table of what the
  verifier rederives — this ADR adds four rows to it)
- **Builds on:** [ADR-ERL2-019](ADR-ERL2-019.md), [ADR-ERL2-021](ADR-ERL2-021.md),
  [ADR-ERL2-022](ADR-ERL2-022.md), [ADR-ERL2-023](ADR-ERL2-023.md),
  [ADR-ERL2-024](ADR-ERL2-024.md), [ADR-ERL2-025](ADR-ERL2-025.md),
  [ADR-ERL2-027](ADR-ERL2-027.md), [ADR-ERL2-028](ADR-ERL2-028.md)
- **Findings closed:** review P1-11 (remainder), and the P2 verifier cluster —
  evidence cutoff never re-derived offline; retained subject-output payloads
  unaccounted; `complete_for_terminal_chain` omitting members whose authority field
  is not literally named `signature`
- **Normative revision:** `2.0.0-draft.12`

---

## 1. Context

ADR-ERL2-024 §4.6 named five things the offline verifier had been trusting and
stopped trusting them. The list was right and the derivations it produced are
sound. But the *shape* of the defect it named — a producer field that reads like a
finding and is actually a constant — recurs four more times, and §4.6's table does
not have a row for any of them.

### 1.1 `complete_for_terminal_chain` is `lab_validity` again

ADR-ERL2-024's opening argument is that `attestation.lab_validity` proves nothing
because the producer writes `lab_validity: "valid" as const`. The identical
sentence is true of the signer inventory:

```
packages/core/src/terminal/environmentFinalize.ts:199   complete_for_terminal_chain: true as const,
packages/core/src/terminal/finalize.ts:171              complete_for_terminal_chain: true as const,
```

`verifySignedMembers` is genuinely strong in one direction: every retained file
carrying an authority-bearing signature is verified under a **verifier-owned** role
table, and a signed contract the table does not declare is refused outright. It also
checks that every inventory entry names a retained artifact, and that the entry's
schema and key match it.

What nothing checks is the other direction. An inventory that simply **omits** an
applicable signed member is not refused, and its own claim to be complete is a
schema constant. So the inventory's completeness — the one property a reader
consults it for — was the single unverified thing about it.

The review stated this as members "whose authority field is not literally named
`signature`". That framing is now half-stale and worth correcting rather than
repeating: `SIGNATURE_FIELDS` already covers `signature`, `root_signature` and
`wrapper_signature`, so the *verification* of a nested signed member is not the
gap. The gap is *completeness*, and it applies to every applicable member equally.

### 1.2 The cutoff is asserted, and only the producer ever derived it

`realizeCutoff` (`packages/core/src/capture/capture.ts:45`) is a careful function.
It refuses a milestone that does not reference the signed process-start receipt, a
milestone in a different monotonic clock domain, wall and monotonic views that
diverge beyond the committed bound, and a process-to-milestone skew beyond the
bound. It then derives the instant.

The offline verifier re-does none of it. `cutoff.runtime_milestone_hash` is a
32-byte string that nothing resolves, which is exactly the review's finding: *an
observation bundle naming a nonexistent runtime milestone verifies as valid.* The
three cutoff inputs are in `SUPPORTING_SCHEMAS` (`environmentClosure.ts:161-163`)
with a comment saying a reader needs them "to re-derive `ObservationBundleV2.cutoff`"
— and no reader did.

ADR-ERL2-028 §7 sharpened this deliberately: the producer now refuses a
post-capture intent before the realized cutoff, and the verifier checks the
*ordering* of the event that realized it, but not that the instant follows from its
own inputs.

### 1.3 The payload bytes are outside the subtree that is accounted

`verifyRetainedFileAccounting` walks `retained/` and requires every regular file
under it to be accounted by one of four rules. Subject-output payloads are not
under it — `retainedFiles.ts:149` says so in passing, parenthetically, while
explaining a different rule:

> a step outcome's second copy lives under `subject-output/`, outside this subtree

`verifyReferencedBytes` does rehash a subject-output payload's declared digest and
length *if the file is present*, and refuses symlinks and traversal. But a
**missing** declared payload is silently skipped unless its path is
content-addressed (`referencedBytes.ts:215-226`), and no pass enumerates the
payload directory, so an **extra undeclared** file there is invisible to every
layer.

So the manifest's JSON was validated and its payload directory was not accounted in
either direction.

### 1.4 The mandatory evidence gate cannot see an invalid golden fail

`npm run evidence:verify` compares regenerated bytes against `fixtures/golden`
byte-for-byte, and the comparison is pinned by count and by exclusion-manifest
digest. It is a strong gate for producer output.

It is not a gate on verification at all. The generator's `runCli`
(`scripts/generate-evidence.mjs:78`) records `exit_code` into a transcript and
**never asserts it**:

```js
function runCli(args) {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
  return { argv: ["erl2", ...args], exit_code: result.status, /* … */ };
}
```

The transcript lands in `cli-transcript.json`, which is the one file excluded from
the byte pin (absolute CLI path arguments). So the three `verify-record` invocations
over the three invalid goldens have their real outcome recorded in the single place
the pin cannot see. A verifier regression against invalid records changes no
producer bytes, and therefore leaves `evidence:verify` green.

This is the inverse of the P1-6 class: not a guard that checks the wrong thing, but
a result that is recorded and never read.

---

## 2. Scope and non-goals

### In scope

- Offline re-derivation of the evidence cutoff for a terminal that realized one.
- Independent derivation of signer-inventory completeness, both directions.
- Complete accounting of the subject-output payload root, both directions.
- Lifecycle reachability for the exposure event.
- A mandatory, semantic invalid-golden verification gate.

### Explicit non-goals

- **Producer-side scanning.** `mounted_file` scanned with metadata that cannot
  contain the mount, and secret canaries / forbidden identifiers unscanned on the
  environment subject-output surface, are producer defects. This ADR does not touch
  the scanners and makes no claim about them.
- **Output-size enforcement.** The declared subject-output limit is hashed into the
  adapter request and not enforced. The verifier here accounts *bytes against
  descriptors*; enforcing the declared ceiling on the producer side is Step 6.
- **Scalar recomputation of the cutoff instant.** See §3.2 — the warmup and
  observation durations are not retained, and this ADR deliberately does not add
  them to a frozen contract.
- **New evidence classes, live oracle surfaces, evaluated-domain activation.**
  ERL2-OQ-005, ERL2-OQ-007 and ERL2-OQ-008 stay fail-closed.

---

## 3. Decision: the cutoff is re-derived offline, bounds-exact

### 3.1 The authoritative milestone

**The authoritative milestone is the single `runtime-milestone/v1` that the
observation bundle's own `cutoff.runtime_milestone_hash` names** — not the newest
retained milestone, and not one selected by role. It must:

1. resolve by **exact core hash** to a retained artifact of schema
   `runtime-milestone/v1` (a well-formed hash naming nothing is a refusal, which is
   the review's case);
2. carry the run's `run_id`;
3. bind the same process-start receipt the cutoff names —
   `milestone.traffic_process_start_receipt_hash === cutoff.process_start_receipt_hash`,
   *and* that hash must itself resolve to a retained
   `traffic-process-start-receipt/v1`;
4. be **lifecycle-reached** — some event's `produced` names it. A snapshot-only
   milestone with no authoritative event is refused.

The cutoff policy is resolved on the same terms, and is already signature-verified
under `policy_author` by `verifySignedMembers`.

### 3.2 Why the derivation is bounds-exact and not scalar-exact

`realizeCutoff` computes

```
instant = process_started_at + warmupMs + observationMs
```

and `WARMUP_MS = 1_000` / `OBSERVATION_MS = 5_000` are **constants of the
composition** (`environmentRun.ts:233`), deliberately not caller inputs. They are
not carried in the observation bundle, the policy, the milestone or the receipt.
Design v2 §13 names them "the selected warmup and observation durations" — selected,
not attested.

A verifier therefore cannot recompute the scalar from retained bytes. It has two
honest options, and one dishonest one:

- **add them to a contract** so the scalar is recomputable — a new identity or major
  for `observation-bundle`, and an ADR-ERL2-022-class migration;
- **decompose against the retained instants** and check every bound;
- pretend the scalar is derivable by reading it back out of `instant`, which proves
  nothing.

This ADR chooses the second, on the §25 rule that a verifier should prefer no
contract change where existing evidence is sufficient — and it is sufficient,
because the decomposition is anchored on a *third* independently signed instant:

```
warmup      := milestone.occurred_at − receipt.process_started_at
observation := bundle.cutoff.instant − milestone.occurred_at
```

`occurred_at` is signed by the `runtime_attestor`, `process_started_at` by the
`traffic_supervisor`. Neither is the party that wrote the cutoff. So the two derived
durations are not read back out of `instant`; they are the intervals between three
separately authorized clocks, and the verifier then requires:

- `warmup ≥ 0` and `warmup ≤ policy.maximum_warmup_ms`;
- `observation ≥ policy.minimum_observation_ms` and
  `observation ≤ policy.maximum_observation_ms`;
- `instant === process_started_at + warmup + observation` — true by construction of
  the decomposition, and asserted anyway so a future change to either side is caught;
- `|wallElapsed − monotonicElapsed| ≤ policy.maximum_monotonic_wall_divergence_ms`;
- `|wallElapsed| ≤ policy.maximum_process_milestone_skew_ms`;
- `policy.instant_rule` is the rule this derivation implements, and
  `policy.clock` is `host_utc`;
- the cutoff instant lies within the policy's own `valid_from`/`valid_until`.

**This boundary is stated rather than blurred.** What is proven is that the
retained cutoff is consistent with three independently signed clocks and with every
committed bound. What is *not* proven is that the operator chose a 1-second warmup
rather than a 900 ms one. A producer that moved the window inside the committed
bounds, and moved the milestone with it, is not caught — and could not be by any
reader that does not hold the durations. That is a genuine residual, recorded in
§9 as a rejected alternative rather than hidden.

### 3.3 Ordering, and what the cutoff must not precede

Derived from the hash-chained lifecycle, not from any timestamp:

- the event that reached the milestone precedes `evidence_cutoff_realized`;
- `evidence_cutoff_realized` precedes the observation freeze;
- a reveal never precedes the subject-output freeze (already enforced; re-asserted
  here because the cutoff is the artifact that made it checkable).

### 3.4 Applicability

The capture group is optional **as a group** (`environmentClosure.ts:84-108`): a run
that terminated before `traffic_or_journey_started` never realized a cutoff, and
requiring one would force a synthetic observation — which design v2 §26 forbids. So:

- **observation bundle present** → the derivation is mandatory and total;
- **observation bundle absent** → the derivation is skipped, and
  `assertCaptureGroupComplete` continues to refuse a *partial* group.

A cutoff policy retained by a run that realized no cutoff stays legal: ADR-ERL2-028
§3 made the policy resolvable before the first freeze precisely so a refusal writes
nothing, and a retained policy with no realized cutoff is that state, not a defect.

---

## 4. Decision: signer-inventory completeness is derived, in both directions

### 4.1 What "applicable signed member" means

**Definition.** A retained file is an *applicable signed member of the terminal* when
all three hold:

1. it carries an authority-bearing signature object — a `signature`,
   `root_signature` or `wrapper_signature` with a `key_id` and a `signed_hash`;
2. its `schema_version` is declared in the verifier's own `SIGNED_MEMBER_RULES`
   table (an undeclared one is already a hard refusal, so this is not a widening);
3. its `schema_version` is **not** in the inventory's
   `excluded_public_terminal_types`.

Membership is decided by the **field**, never by the field's name being
`signature`, and never by any producer list.

### 4.2 The rule

The verifier derives that set and requires the inventory's entries to be **exactly**
it:

| Divergence | Refusal |
|---|---|
| an applicable member with no entry | `INVENTORY_ENTRY_MISSING` |
| an entry naming a non-retained artifact | `INVENTORY_ENTRY_MISSING` (unchanged) |
| an entry for an inapplicable or excluded type | `INVENTORY_ENTRY_EXTRA` (unchanged) |
| two entries for one artifact core hash | `INVENTORY_ENTRY_EXTRA` |
| an entry whose schema or key contradicts the artifact | `INVENTORY_ENTRY_MISMATCH` (unchanged) |

`complete_for_terminal_chain` is **never read as evidence.** The contract keeps the
field — it is frozen, and its `const: true` shape is honest as a *producer
assertion* — but the verifier's answer comes from the derivation, and a producer
that asserted completeness while omitting a member is refused by the derivation, not
by disagreeing with the boolean.

### 4.3 One derivation, two variants

Pre-environment and environment inventories differ only in which schemas can
legitimately appear, and that difference is already carried by what is retained.
So this is **one verifier-internal function** taking the retained set, the role
table and the excluded-type list as explicit inputs — not two copies. The
`terminal_variant` field is checked separately, as now.

---

## 5. Decision: subject-output payloads are referenced payload descendants, accounted in both directions

### 5.1 The classification

**A subject-output payload file is a referenced payload descendant, not a closure
member.** It has no lifecycle role, it is not derived by any closure rule, and it
must not become either: a payload is bytes named by an `ArtifactRef` inside an
artifact that *is* a closure member (the subject-output manifest), and its
authority is entirely the manifest's.

This is the same classification `retained/`'s rule 3 already gives referenced
payloads. What changes is that the rule is applied to the payload root as well, in
both directions.

### 5.2 The rule

For every subject-output manifest reached by the lifecycle, and for the payload root
it declares:

**Descriptor → bytes.** Every declared payload must exist as a **regular file**,
not a symlink and not a directory; resolve strictly beneath the payload root; match
its declared `byte_length` exactly; match its declared `file_sha256` exactly; and be
declared exactly once (no two descriptors sharing a logical or physical path).

**Bytes → descriptor.** Every regular file in the payload root must be either a
declared payload, or the `.frozen` marker of one. Anything else — an undeclared
file, an orphan marker, a symlink, a device node, a directory entry that is not a
directory — is a rejected extra.

A **missing** declared payload is now a refusal (`ARTIFACT_NOT_FOUND`) rather than a
skip. The `referencedBytes.ts` allowance that a working-copy reference "may
legitimately be scrubbed from a retained bundle" is correct for `raw/` and stays;
it does not extend to a payload the terminal's own manifest declares.

### 5.3 What this does not claim

The accounting is over **descriptors and bytes**. It does not scan payload contents
for secrets, canaries or forbidden identifiers, and it does not enforce the declared
output-size ceiling. Both remain open and are named as such in the claims file. A
reader must not read "payloads are completely accounted" as "payloads are
scanned" — the first is a byte-correspondence property, the second is a content
property this package does not touch.

---

## 6. Decision: the exposure event must be lifecycle-reached

`index.get(attestation.exposure_event_hash)` proves the bytes are retained. It does
not prove the run ever reached them. An attestation naming a retained exposure event
that no lifecycle event produced is the snapshot-only-artifact shape the closure
refuses everywhere else, and it is now refused here too: the exposure event must be
named by some event's `produced`, and must carry the run's `run_id`.

---

## 7. Decision: the invalid-golden gate is mandatory and semantic

`npm run evidence:verify` gains a pass that, for **every** invalid-run golden
fixture present under `fixtures/golden`:

1. locates its invalid record, lifecycle, artifact root and root config;
2. invokes the real offline invalid-record verifier — `erl2 verify-record --offline`
   — in a **fresh process**;
3. asserts **exit code 0** and a verdict of `valid` (a correctly constructed invalid
   terminal *verifies*; the record is valid evidence of an invalid run);
4. asserts no attestation and no public bundle is present;
5. fails the gate on any refusal — missing role, rejected extra, broken lifecycle,
   incorrect cleanup, bad trust or an inconsistent record.

The fixture list is **enumerated from the directory**, not hard-coded, so a new
invalid golden is covered the day it lands and cannot be added outside the gate.
The count is asserted too, so a fixture cannot silently leave the gate.

**The transcript is not evidence.** The gate reads exit codes it obtains itself, in
its own child processes. `cli-transcript.json` stays excluded from the byte pin for
the reason it always was, and nothing depends on it.

Volatile CLI formatting is **not** newly pinned. The gate asserts an exit code and a
verdict — two semantic facts — and not the shape of the JSON around them.

---

## 8. Contract and artifact impact

**No frozen schema changes shape or meaning, and no new contract identity is
added.** `packages/contracts/` is untouched for the second package in a row: no
schema, no registry entry, no generated type, no new error code.

Every refusal reuses an existing catalogued code:

| Concern | Code |
|---|---|
| milestone/receipt binding, unresolvable milestone | `CUTOFF_MILESTONE_MISMATCH` |
| clock domain disagreement | `CUTOFF_CLOCK_DOMAIN_MISMATCH` |
| wall/monotonic divergence | `CUTOFF_CLOCK_DIVERGENCE` |
| warmup, observation, skew or validity-window bound | `CUTOFF_BOUND_EXCEEDED` |
| cutoff artifact not lifecycle-reached | `GRAPH_CLOSURE_UNREACHABLE_ARTIFACT` |
| inventory omits an applicable member | `INVENTORY_ENTRY_MISSING` |
| inventory duplicates a member | `INVENTORY_ENTRY_EXTRA` |
| missing declared payload | `ARTIFACT_NOT_FOUND` |
| payload length or digest | `ARTIFACT_HASH_MISMATCH` |
| undeclared payload extra, orphan marker | `GRAPH_CLOSURE_EXTRA_ARTIFACT` |
| payload symlink / non-regular file | `PATH_SYMLINK_REJECTED` / `PATH_NOT_REGULAR_FILE` |
| payload path escape or duplicate logical path | `SUBJECT_OUTPUT_PATH_ESCAPE` |
| exposure event not lifecycle-reached | `GRAPH_CLOSURE_UNREACHABLE_ARTIFACT` |

Goldens do not move: every new rule is a *refusal* the shipped goldens already
satisfy. The byte pin stays at 787 pinned / 7 excluded. A pin change would mean a
producer change, and there is none.

---

## 9. Rejected alternatives

**Add `warmup_ms` / `observation_ms` to `ObservationBundleV2` so the cutoff instant
is scalar-recomputable.** This is the only way to close the residual in §3.2, and it
was rejected *for now* rather than on principle. It needs a new observation-bundle
identity or major, regenerated types, new goldens, a compatibility matrix and a
migration — and the invariant it would buy is strictly narrower than the one the
bounds derivation already buys, because a producer free to choose the durations is
also free to choose ones that satisfy any recomputation. Closing it properly means
*committing* the durations before the environment is seen, which is a producer
change (a signed window commitment), not a verifier one. Recorded as the successor
question; not silently resolved in code.

**Trust `complete_for_terminal_chain` and check only the entries present.** This is
the status quo. It makes the inventory's central claim the one thing about it that
is unverified, which is the `lab_validity` mistake with a different field name.

**Give subject-output payloads a closure role.** Rejected: it would make every
payload a mandatory graph member, so a run that legitimately produced no payload
would fail closure, and the role set would grow with the subject's output shape
rather than with the protocol. Payloads are descendants of a member, and the
member's manifest is their authority.

**Scan payload bytes for canaries here, since the payloads are now being read.**
Tempting and wrong. The producer-side scanners are a separate defect with separate
evidence, and closing a producer scanning gap from inside the verifier would let a
run that leaked a canary pass its own scan and be caught only by a reader — which
inverts the direction of the guarantee. Named as out of scope in §2 and left to
Step 6.

**Pin `cli-transcript.json` so the invalid goldens' exit codes are compared.**
Rejected: it pins absolute CLI path arguments, which is why it is excluded, and it
would make the gate depend on CLI output formatting rather than on the verification
result. The gate obtains its own exit codes instead.

**Assert only that `verify-record` exits non-zero on a sabotaged golden.** Too weak
in the other direction: the gate must prove the *unsabotaged* fixture verifies, or a
fixture that is broken from the day it lands passes a gate that only checks
sabotage.

---

## 10. Consequences

- ADR-ERL2-024 §4.6's table gains four rows: the evidence cutoff, signer-inventory
  completeness, subject-output payload accounting, and exposure-event reachability.
  With them, the list of producer fields the verifier trusts for a semantic verdict
  is empty.
- `evidence:verify` stops being a producer-bytes gate only. A verifier regression
  against an invalid record now fails it.
- The residual in §3.2 is real and is the sharpest remaining item in the cutoff
  story. It is a producer-side window commitment, and it is not in this package.
- The claims ceiling is **unchanged: T1.** This package adds verifier refusals; it
  measures no new environment, no new subject and no new robustness.
