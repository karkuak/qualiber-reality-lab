# Ledger — Step 6B: the producer evidence boundaries

The independent review's producer cluster is four findings with one shape. In
every case a check was present, it ran on the shipped path, and **what it
inspected was not what crossed the boundary**.

That is worse than a missing check, because a present check is counted as
coverage. `permitted-claims.md` said four oracle surfaces were scanned live. The
honest number was two.

This ledger records what each boundary actually does now, where the scan sits
relative to publication, how bytes are counted, which tests reach each rule on
the shipped path, which negative control kills each one, and what is still open.

Decisions: [ADR-ERL2-032](../adr/ADR-ERL2-032.md).

---

## 1. What was open

| # | review finding | what the code did |
|---|---|---|
| 1 | `mounted_file` is scanned with metadata that cannot contain the mounted content | scanned `JSON.stringify({entryId, sourceContentHash, artifact, sourceState})` — an id, a state and two digests |
| 2 | `lab_telemetry` has a live scanner call but no load-bearing control | scanned real snapshots on a real path; nothing proved a run reached it, and it ran one phase *after* the snapshots were retained |
| 3 | secret canaries and forbidden identifiers are never scanned on the environment subject-output surface | no rule existed there at all, though both exist on the adapter host's output path |
| 4 | the declared subject-output size limit is hashed into the adapter request and never enforced | `SubjectExecutionPlanV1.limits.output_bytes` was frozen and hashed into every `resource_limit_hash`; no code compared it with a byte |

None of the four was already fixed at `eaeec8c`. Each was reproduced before it
was changed.

---

## 2. The real production byte path, boundary by boundary

Written out because "the scan is on the live path" is the claim that failed
twice, and the only way to check it is to say which bytes, from where, at which
call.

### 2.1 `mounted_file`

**The bytes.** Everything the Lab publishes beneath `subject-visible/`:

| logical path | content | produced by |
|---|---|---|
| `subject-visible/steps/<step_id>.json` | the admitted `SubjectVisibleJourneyStepV1` | `RunWorkspace.visibleStepRef`, from `acquire`, `verify-package` and every environment journey step |
| `subject-visible/canonical/<snapshot_id>.json` | the `SourceSnapshotV1` an adapter mounts as canonical evidence | `EnvironmentRun.freezeObservation` |
| `subject-visible/translated/<entry_id>.json` | the entry's projection | `EnvironmentRun.freezeObservation` |

**Where they come from.** Admitted governor data (the visible step) and the
run's own capture (the snapshots). Both are outside the Lab's control in the
sense that matters: a canary can enter through either.

**What is scanned now.** `RunWorkspace.freezeMountedFile` is the only route into
that tree. It builds the canonical bytes in memory, scans **those bytes** as a
`Buffer`, freezes exactly them, and then verifies the reference the freeze issued
— re-reading the published file and comparing length and digest with what was
scanned.

**Timing.** Before the file exists, and therefore before any dispatch: for a
journey step the scan is in `visibleStepRef`, called while the
`AdapterStepRequestV1` is still being constructed and well before
`this.intents.run(... dispatch ...)`. Nothing has been appended to the lifecycle
and nothing is on disk, so the refusal writes no evidence.

**Ordering against the old code.** The predecessor scan was *after* the
publication it was supposed to gate for canonical entries, and absent entirely
for visible steps.

**Error ownership.** Lab. `JOURNEY_ORACLE_CANARY_LEAKED`, `owner: "lab"`.

**Terminal.** None. A pre-dispatch refusal does not advance state; the run closes
through `cancel` if the operator chooses.

**Restart/replay.** Cannot bypass. The bytes are recomputed from the same
admitted artifact on every attempt, and `ArtifactStore.freeze` refuses a path
already frozen with different bytes rather than overwriting it.

### 2.2 `lab_telemetry`

**The bytes.** The canonical bytes of every `SourceSnapshotV1`.

**Where they come from.** `EnvironmentRun.observe` builds one snapshot per entry
in `baseline.evidence_source_states`, which the fake driver derives from the
admitted archetype's `evidence_sources`. `source_id` is the only field on that
path that carries governor-authored text; everything else is derived or hashed.

**What is scanned now.** `assertTelemetryOracleClean` — one definition, two call
sites: `observe`, before any snapshot is retained, and `freezeObservation`, over
the snapshots read back from the store that the bundle is built from.

**Timing.** The first call is before `retained/observation/<id>.json` is frozen
and before the lifecycle event that produces the `source-snapshot` role. The scan
previously ran only at the second point — one phase later, after the leaking
bytes were already frozen artifacts.

**Error ownership.** Lab. `JOURNEY_ORACLE_CANARY_LEAKED`.

**Terminal.** None; same as above.

**Restart/replay.** Cannot bypass: `observe` re-derives the snapshots and
re-scans on every attempt, and it never reaches the lifecycle append.

**What the refusal cannot undo.** The archetype and the baseline fingerprint are
records of *admitted input*, and both are retained before `observe` runs. A run
cannot un-admit its own governor data. The regression asserts the carrier set is
**exactly** those two files, which is what proves nothing derived from them
picked the token up.

### 2.3 environment subject output — content

**The bytes.** `subject-output/steps/<step_id>.out`, frozen in
`EnvironmentRun.runStep` from `response.outputBytes`: the bytes the subject
itself returned.

**What is scanned now.** In `freezeOutput`, before anything freezes, over the
payloads read back from the store:

1. the declared byte ceiling (§2.4);
2. the existing `subject_output_prefill` oracle scan — unchanged, and still the
   sole owner of the judge-canary rule here;
3. `assertSubjectOutputContentClean` — secret canaries
   (`SECRET_CANARY_IN_SUBJECT_OUTPUT`) and forbidden identifiers
   (`SECRET_PLAINTEXT_IN_CONTRACT`).

**Why the new scan has no judge-canary branch.** Because adding one would still
refuse the run — from the new gate — and would therefore make
`subject-output-canary-scan` kill nothing. Closing a gap must not cost the proof
that an existing guard works. `EB-CONTENT: the judge-canary rule is deliberately
not duplicated here` and `EB-OUTPUT: a judge canary still refuses under its own
rule` are the two ordering anchors that make a future regression visible.

**Vocabulary.** `scanBytes` and `FORBIDDEN_OUTPUT_IDENTIFIERS`, the same
definitions the adapter host's output and diagnostics paths enforce. No second
list.

**Binary safety.** Matching is over a `latin1` view, which is byte-preserving. A
UTF-8 decode would replace invalid bytes with `U+FFFD`, and a token adjacent to
that replacement can stop matching — so a subject could hide a secret by
surrounding it with malformed bytes. `EB-CONTENT: a token embedded in otherwise
invalid UTF-8 is still found` is that case.

**Error ownership.** Lab, both. A secret in retained bytes is an evidence-boundary
failure of the Lab's own partition; it is not a finding about the subject.

**Terminal.** None. Consistent with the refusal the `subject_output_prefill` scan
already produced; no shortcut terminal is added.

**Retained evidence on refusal.** The payload bytes were already frozen at
`runStep` — deliberately, and recorded there: a run that discarded them would
have had no subject output to scan at all. What the refusal guarantees is that
**no subject-output manifest and no step-outcome copy** is written, which the
regressions assert with a full-tree byte manifest and with `producedRoles`.

### 2.4 environment subject output — size

**The limit.** `SubjectExecutionPlanV1.limits.output_bytes`, resolved from the
run's own frozen execution plan by role. It is the value hashed into every step
request's `resource_limit_hash`, so it is the committed, request-bound limit and
not something a caller can move at the moment of enforcement. On this build it is
64 MiB.

**Explicitly not** the adapter response-frame bound, the diagnostics bound, the
adapter output tree's file count, path depth or total, or any flag.
[ADR-ERL2-032 §4](../adr/ADR-ERL2-032.md) has the table.

**Byte counting.** `Buffer.byteLength`, never characters; from the payloads read
back from the store, never from a descriptor, a manifest total, a hash or a name;
every occurrence counted separately, so two references to one path count twice;
no decoding, decompression or re-encoding first; and the running total asserted
to remain an exact integer at every step.

**Behaviour.** Exactly at the ceiling is admitted. One byte over is
`SUBJECT_OUTPUT_LIMIT_EXCEEDED`, before the manifest freezes. Nothing is
truncated — attesting to bytes the subject did not produce would be the worse
failure, and no accepted contract asks for it here. The message carries two
integers and no payload byte.

**Both halves are measured at the real ceiling**, end to end through the CLI,
not against an injected small limit. The last journey step is given exactly the
padding that carries the run's real total to 64 MiB, or to 64 MiB + 1.

---

## 3. A defect found while building the tests

`assertNoCanaryLeak` republished the token it refused.

The refusal message names the surface and the *label*, and a label is built from
run data — a source id, an entry id, a step id. When the leak lives in that
identifier, the message printed the exact canary into stderr, into the CLI's JSON
envelope, and into every log that captures either. The scan contained the leak
and the diagnostic released it.

Fixed by redacting the label with the same patterns the scan matches on — one
vocabulary, used in both directions ([ADR-ERL2-032 §6](../adr/ADR-ERL2-032.md)).
Every new end-to-end regression asserts the whole envelope is free of the token
it planted, so this cannot silently come back.

It is recorded here rather than fixed quietly because it is the same class as the
four findings: a control that is present and does not do what its name says.

---

## 4. A claim this package *downgrades*

`adapter_request` was counted as one of four load-bearing live surfaces. After
Step 6B it is recorded as **shadowed**, and not counted.

An `AdapterStepRequestV1` carries hashes, a run id, an operation id, a deadline
and an `ArtifactRef` to the visible step. The only field that can carry
attacker-influenced text is that reference's **path**, built from the step id —
and the same step's bytes are now refused as a `mounted_file` one call earlier.
So every input that could reach the Lab-side request scan is refused in front of
it, and no shipped input can demonstrate that call.

The scan stays: it is defence in depth and costs nothing. What changes is the
report. The alternative — leaving the ordering as it was so the request scan
remains demonstrable — would mean publishing the leaking mount and then refusing
the request that names it, which is the ordering the review found and is the
wrong one.

`tests/adversarial/oracleSurfaceCoverage.test.ts` now enforces this structurally:
a surface may be called live only when it names a production-path regression that
exists **and** a negative control in the shipped table, or when it declares a
non-empty shadowing reason and claims neither.

---

## 5. Tests

### 5.1 `tests/adversarial/evidenceBoundaries.test.ts` — 25 cases

Byte accounting (byte vs character · duplicate paths counted twice · empty set) ·
the ceiling (exactly at · one over · a total rather than a per-file bound · the
message quotes integers only · multibyte measured after encoding) · content
scanning (secret canary, Lab-owned · forbidden identifier · every declared
identifier refused individually · the judge rule deliberately absent · clean
binary · a token buried in invalid UTF-8 · clean text) · redaction (a refusal
never echoes its token · both vocabularies) · telemetry (a canary anywhere in a
snapshot's retained bytes · the refusal names `lab_telemetry` and not the canary ·
clean telemetry passes) · the mounted-file binding (a replaced mount fails closed
· a path frozen with different bytes is refused, not overwritten · a symlinked
path is refused before any read · a missing mount is an absence · the scanned
bytes are the exact published bytes).

### 5.2 `tests/e2e/environmentEvidenceBoundaries.test.ts` — 12 cases

Every one drives the shipped `erl2` binary in separate OS processes and plants
its leak in admitted governor data or in the subject's own bytes.

| case | rule under test |
|---|---|
| a canary in the mounted file's bytes refuses before the adapter is dispatched | `mounted_file`; asserts the message names the surface, the run root contains the token **nowhere**, the tree is byte-unchanged, and the envelope does not republish it |
| the run cannot step past a refused mount by retrying it | replay cannot skip a pending scan decision |
| a clean run publishes its mounts and the canonical entries are real files | positive control — "nothing was written" must not be satisfiable by a path that never writes |
| a canary in the telemetry bytes refuses before the telemetry is retained | `lab_telemetry`; no snapshot retained, no `source-snapshot` role produced, carriers exactly the admitted archetype and baseline |
| a refused capture cannot be stepped past by retrying observe | replay |
| the run still reaches exactly one invalid terminal that verifies offline | terminal semantics after a boundary refusal |
| a secret canary in the subject's output bytes refuses before the freeze | `SECRET_CANARY_IN_SUBJECT_OUTPUT` |
| a forbidden identifier in the subject's output bytes refuses before the freeze | `SECRET_PLAINTEXT_IN_CONTRACT` |
| a judge canary still refuses under its own rule, not the new one | ordering anchor for ADR-ERL2-032 §5 |
| clean binary output freezes and the run finalizes | no false positive on non-UTF-8 bytes; run reaches `generic_finalized` |
| one byte over the declared ceiling refuses before the manifest freezes | `SUBJECT_OUTPUT_LIMIT_EXCEEDED` at the real 64 MiB ceiling, exact message, nothing frozen, replay refuses again |
| exactly at the declared ceiling is admitted | the bound is a bound |

### 5.3 `tests/adversarial/oracleSurfaceCoverage.test.ts` — 2 new cases

Every live surface names a production regression and a control that kills it (or
a stated shadowing reason) · the mounted-file scan reads content, not a
descriptor about it — asserted against the source, because no runtime value can
show that a different value was once passed.

---

## 6. Negative controls

Six new controls, each disabling exactly one byte-level rule.

| control | file | what it disables | designated suite |
|---|---|---|---|
| `mounted-file-byte-scan` | `run/workspace.ts` | the scan, leaving the publication | `environmentEvidenceBoundaries` |
| `lab-telemetry-oracle-scan` | `capture/capture.ts` | the single shared telemetry scanner, so both call sites die together | `environmentEvidenceBoundaries` |
| `subject-output-secret-canary-scan` | `adapter/outputFreezer.ts` | the secret-canary branch only | `environmentEvidenceBoundaries` |
| `subject-output-forbidden-identifier-scan` | `adapter/outputFreezer.ts` | the forbidden-identifier branch only | `environmentEvidenceBoundaries` |
| `subject-output-declared-byte-ceiling` | `adapter/outputFreezer.ts` | the comparison against the declared ceiling | `environmentEvidenceBoundaries` |
| `subject-output-byte-total-counts-payloads` | `adapter/outputFreezer.ts` | counts path lengths instead of payload bytes — the ceiling still runs and is given a wrong number | `environmentEvidenceBoundaries` |

The last one is the sharpest of the six and it is the review's own finding in
miniature: a bound enforced against a proxy for the thing it governs. Deleting a
comparison is the obvious mutation; feeding it the wrong number is the one that
actually happened in production code.

Two patches use postimages that keep an identifier referenced (`void label;`,
`void total;`) or write `String(1) === "2"` rather than `false`. Neither is
decoration: a patched tree that does not compile reports `build_failure` and
measures nothing, and a literal `false` lets TypeScript drop a branch and stop
narrowing the code around it.

### 6.1 Campaign results

*(filled in below from the full inherited-plus-new run)*

---

## 7. Contracts, goldens and evidence pins

- **No frozen contract changed shape.** No schema was edited, no new artifact is
  retained, no signer or authority is added, and the contract registry count is
  unchanged.
- **No new error code.** All four refusals use codes the catalogue already
  carries: `JOURNEY_ORACLE_CANARY_LEAKED`, `SECRET_CANARY_IN_SUBJECT_OUTPUT`,
  `SECRET_PLAINTEXT_IN_CONTRACT`, `SUBJECT_OUTPUT_LIMIT_EXCEEDED`.
- **No pinned golden byte changed, and that is a checkable claim rather than a
  hope.** `freezeMountedFile` composes `jcsBytes(value)` with a trailing newline
  and freezes exactly that — byte-for-byte what `freezeJson` wrote before — so
  every published mount, its `ArtifactRef` and its freeze marker are identical.
  `EB-MOUNT-BIND: the scanned bytes are the exact published bytes` pins that
  equality directly.
- **The evidence exclusion manifest is unchanged**: still 7 exclusions, and none
  added.

## 8. Claims

The ceiling stays **T1**. Step 6B closes producer-side evidence boundaries; it
produces no new evidence about tier, driver, subject or selection, and none of
the six components that hold the derivation at T1 moves.

`permitted-claims.md` is amended in three places: the oracle-surface claim now
counts three proven surfaces and records the fourth as shadowed; the
ADR-ERL2-029 paragraph that recorded the subject-output content and size gaps as
open now records them closed and states exactly what each covers; and a new line
records that a refusal does not republish what it refused.

## 9. What this package does not claim, and what stays open

Not implemented here, and deliberately:

- the remaining P3/tooling drift;
- crash matrices for `provision`, `restore`, `destroy` or the emergency actions;
- the missing end-to-end mutation reaching the source-snapshot window comparison;
- ERL2-OQ-005 (Compose activation), ERL2-OQ-007 (held-out/blind execution),
  ERL2-OQ-008 (opaque/third-party substrate qualification);
- the container launcher, threshold VRF, and any Qualiber adapter or execution;
- any claims-level increase beyond T1;
- an integrated independent re-review.

Audited and recorded rather than fixed:

- **output file count and path depth on the environment subject-output path.**
  `OutputBounds` enforces both on the adapter host's output *tree*. The
  environment path freezes exactly one payload per step outcome from the bytes
  the port returns, so there is no tree to walk and neither bound has an
  unenforced counterpart here. This is a statement about the shipped fake port
  and the hosted port alike; a future surface that writes a tree would need the
  bound restated, not inherited.
- **the four pending oracle surfaces** — `environment_variable`,
  `process_argument`, `diagnostics`, `network_egress` — remain named in
  `PENDING_ORACLE_SCAN_SURFACES` and unscanned.
- **`adapter_request` is shadowed**, per §4. It is live and it is not counted.
