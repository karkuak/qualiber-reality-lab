# ADR-ERL2-032 — the producer evidence boundaries: scanning the bytes that cross, and enforcing the ceiling that was only ever hashed

- **Status:** accepted
- **Date:** 2026-07-31
- **Deciders:** Lab Architecture, Integrity/Security Owner, Verification Audit
- **Supersedes:** nothing
- **Amends by record:** [ADR-ERL2-029](ADR-ERL2-029.md) §5 — its subject-output
  payload accounting is byte *correspondence against descriptors* and says so;
  this ADR adds the content and size rules it explicitly left open
- **Builds on:** [ADR-ERL2-019](ADR-ERL2-019.md), [ADR-ERL2-021](ADR-ERL2-021.md),
  [ADR-ERL2-024](ADR-ERL2-024.md), [ADR-ERL2-027](ADR-ERL2-027.md),
  [ADR-ERL2-028](ADR-ERL2-028.md), [ADR-ERL2-029](ADR-ERL2-029.md),
  [ADR-ERL2-030](ADR-ERL2-030.md), [ADR-ERL2-031](ADR-ERL2-031.md)
- **Findings closed:** the producer half of `Independent-Code-Review-Slice-6.5B.md`
  §2 P2 — `mounted_file` scanned with metadata that cannot contain the mounted
  content; `lab_telemetry` live but with no load-bearing control; secret canaries
  and forbidden identifiers never scanned on the environment subject-output
  surface; the declared subject-output size limit hashed into every request and
  never enforced
- **Normative revision:** `2.0.0-draft.13`

---

## 1. Context

Four findings, and one sentence that covers all four: **the check was present and
it was not checking the thing.**

That is a different failure from a missing check, and it is worse, because a
present check is reported as coverage. `permitted-claims.md` said four oracle
surfaces were scanned live. Two of the four were not doing what the claim
described:

| surface | what the code did | what a leak would have to do to be caught |
|---|---|---|
| `mounted_file` | scanned `JSON.stringify({entryId, sourceContentHash, artifact, sourceState})` | live in an id or a state — never in the mounted file's content |
| `lab_telemetry` | scanned real snapshots, on a real path | nothing; the scan was correct, and nothing proved a run reached it |

And two rules did not exist at all on the environment subject-output surface,
though both exist and are enforced on the adapter host's output path:

- secret canaries and forbidden identifiers were never scanned;
- `SubjectExecutionPlanV1.limits.output_bytes` was frozen into the plan and
  hashed into every step request's `resource_limit_hash`, and no code ever
  compared it with a byte.

This ADR records the four decisions those closures required. It records nothing
else: no schema changes shape, no new artifact is retained, no signer is added,
no lifecycle event is added, reordered or removed, and every refusal uses an
error code the catalogue already carries.

---

## 2. Decision 1 — a mount is scanned as bytes, before it exists, and the scan is
bound to what is published

Publication into the adapter-visible tree becomes one operation,
`RunWorkspace.freezeMountedFile`, and it is the only way Lab-authored bytes enter
that tree. It does three things in this order:

1. builds the canonical bytes **in memory** and scans those bytes, so a refusal
   happens before the file exists — an adapter cannot read what was never
   written, and the refusal writes no evidence;
2. freezes exactly the bytes that were scanned;
3. verifies the reference the freeze issued, which re-reads the published file
   and compares its length and digest with the scanned bytes.

Step 3 is the part that is easy to skip and is the point. Scanning and exposing
are two operations over a mutable filesystem, and without a binding between them
the scan is a statement about a value that is no longer necessarily the value on
disk. The binding turns a substitution between the two into
`ARTIFACT_HASH_MISMATCH` rather than a silent exposure.

The remaining fail-closed behaviour is inherited rather than re-implemented:
`resolveConfined` refuses a path resolving through a symlink or a hard link
before any write, and `ArtifactStore.freeze` refuses a path already frozen with
different bytes (`ARTIFACT_ALREADY_FROZEN`) rather than overwriting — so a
resumed run cannot publish a mount its first attempt did not scan.

Matching is over a `Buffer`, not a string built by `JSON.stringify`. The bytes
are scanned as bytes.

### 2.1 What this shadows, and why that is the right trade

`assertRequestOracleClean` scans the adapter request. An `AdapterStepRequestV1`
carries hashes, a run id, an operation id, a deadline, and an `ArtifactRef` to
the visible step. The only field that can carry attacker-influenced text is that
reference's **path**, which is built from the step id — and the same step's bytes
are now refused as a `mounted_file` one call earlier.

So every input that could reach the Lab-side request scan is refused in front of
it. The request scan stays: it is defence in depth and it costs nothing. But it
can no longer be demonstrated by any shipped input, and `adapter_request` is
therefore recorded as **shadowed** rather than as a fourth load-bearing surface.

That is a downgrade of a claim and it is the honest one. The alternative reading
— that the ordering should be left as it was so the request scan stays
demonstrable — would mean publishing the leaking mount and then refusing the
request that names it, which is the ordering the review found and is the wrong
one.

## 3. Decision 2 — one telemetry scanner, two boundaries, one control

`assertTelemetryOracleClean` is the single definition of the `lab_telemetry`
rule. It is called from two places:

- `EnvironmentRun.observe`, **before** any snapshot is retained. This is new. The
  scan previously ran only at `freeze-observation`, one phase later, by which
  point the leaking snapshots were already frozen artifacts: the refusal was real
  and it arrived after the bytes were written;
- `freezeObservation`, over the snapshots the bundle is actually built from —
  which are read back from the store and are therefore not, by construction, the
  objects the first scan saw.

Two call sites and **one** scanner, deliberately. A second copy of the rule would
mean a control that disables one of them proves nothing about the other, which is
precisely the "a scan exists somewhere" reasoning this package exists to replace.

The bytes handed to the scan are the canonical bytes the snapshot is retained as,
as a `Buffer`, not a `JSON.stringify` of the in-memory object.

## 4. Decision 3 — the applicable subject-output ceiling, and what a byte is

The authoritative limit for the environment subject-output surface is
`SubjectExecutionPlanV1.limits.output_bytes`: the value the run froze into its own
execution plan and hashed into every step request's `resource_limit_hash`.

It is deliberately none of the neighbours it is easy to confuse it with:

| not this | what that one is |
|---|---|
| `AdapterHostOptions.maxResponseBytes` | one adapter response *frame* |
| `OutputBounds.maxDiagnosticBytes` | redacted diagnostics |
| `OutputBounds.maxFiles` / `maxPathDepth` | the adapter's own output *tree* shape |
| `OutputBounds.maxTotalBytes` | the adapter's own output tree, not the run's retained payloads |
| any CLI flag | nothing; a limit a caller can move at the moment of enforcement is not a commitment |

**Byte counting is defined as follows**, because every loose reading of it is a
way to hide a total:

- the unit is the byte (`Buffer.byteLength`), never the JavaScript character. A
  multibyte payload counts more bytes than it has characters;
- the bytes counted are read back from the store, never a descriptor's
  `byte_length`, a manifest total, a hash or a file name;
- every **occurrence** counts. Two references naming one path are two exposures
  and count twice; deduplicating by path would let a duplicated reference report
  a total below the bytes the run holds;
- nothing is decoded, decompressed or re-encoded first. The retained bytes are
  what the ceiling governs, whatever they encode;
- the running total is asserted to remain an exact integer at every step, so the
  comparison is never made against a value that silently lost precision.

Exactly at the ceiling is **admitted**; one byte over is refused with
`SUBJECT_OUTPUT_LIMIT_EXCEEDED`, before the manifest freezes. Nothing is
truncated: no accepted contract asks this surface to attest to a truncated
payload, and attesting to bytes the subject did not produce would be the worse
failure. The refusal message carries two integers and no payload byte.

## 5. Decision 4 — the content scan closes the two rules that were missing, and
deliberately does not duplicate the one that was not

`assertSubjectOutputContentClean` refuses a secret canary
(`SECRET_CANARY_IN_SUBJECT_OUTPUT`) and a forbidden identifier
(`SECRET_PLAINTEXT_IN_CONTRACT`) in retained subject-output payload bytes. Both
are **Lab-owned**: a secret in retained bytes is a failure of the Lab's own
evidence partition, not a finding about the subject's behaviour, and it must
never be attributed as one.

It is **not** a judge-canary gate, and that is a decision rather than an
oversight. The `subject_output_prefill` oracle scan owns that rule on this
surface and has a negative control proving it is load-bearing. A second gate
answering the same question with the same code would still refuse the run — and
would therefore make that control kill nothing, retiring the only evidence that
the first scan works. Closing a gap must not cost an existing proof.

The vocabulary is the established one — `scanBytes` and
`FORBIDDEN_OUTPUT_IDENTIFIERS`, the same definitions the adapter host's output
and diagnostics paths enforce. A second forbidden-token list would be two answers
to one question.

Matching is over a byte-preserving `latin1` view. A scanner that decoded as UTF-8
first would replace invalid bytes with `U+FFFD`, and a token adjacent to that
replacement can stop matching — so a subject could hide a secret by surrounding
it with malformed bytes.

## 6. Decision 5 — a refusal never republishes what it refused

A scan label is built from run data: a source id, an entry id, a step id. When
the leak lives *in* that identifier, the naive refusal message reprints the exact
token into stderr, the CLI envelope and every log that captures them —
undoing the containment the refusal exists to provide.

`assertNoCanaryLeak` therefore redacts its label with the same patterns the scan
matches on. One vocabulary, used in both directions.

This was found while building the tests for the decisions above, and it is
recorded here rather than silently fixed because it is the same class of defect
as the four: a control that is present and does not do what its name says.

## 7. Failure ownership, ordering and terminals

Every refusal in this ADR is:

- **Lab-owned** (`owner: "lab"`), never a subject finding;
- a **pre-freeze refusal**, not an accepted-run invalidity. Each happens before
  the artifact it governs is written, so the run's state does not advance and no
  terminal is produced. This matches the behaviour the `subject_output_prefill`
  scan already had, and no shortcut terminal is added;
- **replay-stable**. Each decision is recomputed from the same retained or
  admitted bytes on every attempt, so retrying the refused phase re-decides
  rather than skipping;
- **closable**. A run left standing by one of these refusals still reaches
  exactly one invalid terminal through the ordinary `cancel` route, and that
  record verifies offline.

Lifecycle ordering is unchanged. The only ordering that moved is *within* two
phases: a scan that ran after a write now runs before it.

## 8. What is explicitly not decided here

- Nothing about `environment_variable`, `process_argument`, `diagnostics` or
  `network_egress`. They stay in `PENDING_ORACLE_SCAN_SURFACES`, named.
- Nothing about output **file count** or **path depth** on the environment
  subject-output path. `OutputBounds` enforces both on the adapter host's output
  tree; the environment path freezes one payload per step outcome from bytes the
  port returns, so neither bound has an unenforced counterpart here. Recorded as
  audited, not as fixed.
- No claims-ceiling change. Step 6B closes producer-side boundaries; it produces
  no new evidence about tier, driver, subject or selection, and T1 stands.
