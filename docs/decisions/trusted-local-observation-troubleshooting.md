# Trusted-local observation: troubleshooting and refusals

This is a reference for the refusals an operator can actually reach while
running [trusted-local observation](trusted-local-observation-operator-surface.md)
from the [README](../../README.md) — `erl2 declare-trusted-local-adapter` and
`erl2 run-trusted-local-observation` — plus the two general offline-verification
commands the README still lists as externally supported
(`erl2 verify --public-bundle` and `erl2 verify-record`), since an operator
following the trusted-local path may reach for either once a run is retained.

It does not list every refusal code in the workspace. `runbooks/adapter.md`
covers the adapter-admission and certified-journey refusals for the governed
path, which this document does not repeat. Codes are read from
[`packages/contracts/src/errors.ts`](../../packages/contracts/src/errors.ts);
none here is invented.

Every row answers the same nine questions: the refusal, which stage of the
workflow raises it, what causes it in plain language, what the operator does
about it, whether retrying with the same inputs could ever succeed, whether a
record or evidence bundle is written before the refusal is reported, what
cleanup is left to do, who the failure is actually about, and what it means
for the claim the run can make.

## Stages

The workflow has seven operator-reachable stages:

1. **declaration** — `erl2 declare-trusted-local-adapter`
2. **input binding** — `--bind-input` resolution and materialization, at the
   start of `erl2 run-trusted-local-observation`
3. **admission** — retaining and re-resolving the adapter manifest and
   declaration in the run's local registry
4. **adapter loading** — constructing the host and dispatching the adapter
   process
5. **operation dispatch** — running the plan's operations through the adapter
6. **cleanup** — the plan's cleanup-suffix operations and residue observation
7. **offline verification** — the self-check `run-trusted-local-observation`
   performs before it returns, and the standalone `verify` / `verify-record`
   commands

## Declaration

| Refusal | Cause | Operator action | Retry meaningful? | Record written? | Cleanup | Concerns | Claim consequence |
|---|---|---|---|---|---|---|---|
| `ADAPTER_TRUSTED_LOCAL_ACKNOWLEDGEMENT_INVALID` | `--acknowledge-trusted-local-code` was not the exact required sentence — `yes`, `true`, and a lowercased copy are all refused by name. | Copy the sentence the refusal prints, verbatim. | Yes, with the correct sentence. | No — nothing is written before the acknowledgement checks out. | None; no files were created. | Lab (the CLI refuses before touching disk). | None — no declaration exists. |
| `ARTIFACT_HASH_MISMATCH` | The `--seal-plan-draft` document already carries one of `trusted_local_declaration_hash`, `core_hash`, `resource_limits.core_hash` or `egress_policy.core_hash` — a pre-carried hash is refused rather than silently recomputed. | Remove the pre-carried hash fields from the draft and let `--plan-output` compute them. | Yes, once the draft is corrected. | No. | None. | Lab / operator authoring error. | None — no plan exists yet. |
| `ADAPTER_TRUSTED_LOCAL_RECORD_OVERSIZED` | The manifest or declaration document exceeds the trusted-local size ceiling. | Reduce the document to the closed schema's fields; it is likely carrying unexpected content. | Yes, once the document is within the ceiling. | No. | None. | Operator authoring error. | None. |
| `SCHEMA_VALIDATION_FAILED` | The manifest, declaration or plan draft is not valid JSON, is not a JSON object, or fails the closed contract — including an `Instant`-typed field (any timestamp) whose text is not a real calendar instant, refused since the schema fix in PR #26 rather than silently rolled forward by `Date.parse`. | Fix the document against the schema named in the message; for a timestamp, use a real UTC calendar instant (`YYYY-MM-DDThh:mm:ssZ`, valid month/day/hour/minute/second, correct leap-year length). | Yes, once corrected. | No. | None. | Operator authoring error. | None. |
| `CFG_MISSING_REQUIRED` | A required flag or file is missing — e.g. `--acknowledged-by`, `--declaration-id`, or a named path does not exist. | Supply the missing flag or fix the path. | Yes. | No. | None. | Operator invocation error. | None. |

## Input binding

Raised by `--bind-input` parsing and `materializeTrustedLocalInputs`, before
any host exists.

| Refusal | Cause | Operator action | Retry meaningful? | Record written? | Cleanup | Concerns | Claim consequence |
|---|---|---|---|---|---|---|---|
| `CFG_MISSING_REQUIRED` | An input the plan declares `host_provisioned` has no matching `--bind-input`. | Add the missing `--bind-input <input_id>=<absolute-path>`. | Yes. | No. | The output root may exist (created before bindings resolve) but holds nothing to remove. | Operator invocation error. | None — the run never started. |
| `CFG_DUPLICATE_FLAG` | The same `input_id` was bound twice. | Remove the duplicate binding. | Yes. | No. | Same as above. | Operator invocation error. | None. |
| `CFG_UNKNOWN_FLAG` | `--bind-input` names an id the plan does not declare, or names an `acquired` input (the adapter produces those; they cannot be host-provisioned). | Remove the extra binding, or check the input's `provenance_mode` in the plan. | Yes. | No. | Same as above. | Operator invocation error. | None. |
| `PATH_INVALID_COMPONENT` / `PATH_ESCAPES_ROOT` / `PATH_SYMLINK_REJECTED` / `PATH_NOT_REGULAR_FILE` | The bound source path is relative, is a symlink, is a directory, is not a regular file, or lies inside `--output-root`. | Bind an absolute path to a real, non-symlink file outside the output root. | Yes, once the source path is fixed. | No. | Same as above. | Operator invocation error. | None. |
| `ADAPTER_MOUNT_FORBIDDEN` | The bound path or the plan's mount layout names a forbidden mount target. | Check the plan's `resource_limits.input_root` and the bound path against it. | Depends on the plan; usually requires a plan correction, not just a new binding. | No. | Same as above. | Operator / plan authoring error. | None. |
| `PATH_CASE_COLLISION` | Two inputs would land on the same retained destination once compared case-insensitively. | Correct the plan's input paths so no two collide on a case-folding filesystem. | Only after the plan is fixed. | No. | Same as above. | Operator / plan authoring error. | None. |
| `ADAPTER_LOCAL_LIMIT_EXCEEDED` | The plan declares more than 64 host-provisioned inputs, a single input above 64 MiB, or a total above 256 MiB. | Reduce the input set or split the run; these are fixed internal ceilings, not plan fields. | Only after the plan or inputs are reduced. | No. | Same as above. | Operator / plan authoring error. | None. |
| `ARTIFACT_HASH_MISMATCH` | The bytes read from a bound source do not match the plan's declared `file_sha256` or `byte_length` for that input. | Confirm you bound the file the plan actually describes; a stale or wrong-version file is the usual cause. | **No** — rerunning against the same bytes reproduces the same refusal; the source file or the plan must change first. | No — this refuses before any admission byte or run record is retained. | The partially materialized `inputs/` tree beneath `--output-root` is removed automatically; the output root itself may remain and can be reused. | Operator (wrong file bound) or subject (an adapter that ships a mismatched fixture) — never the Lab. | None — the run never reached admission. |

## Admission

Raised by `retainTrustedLocalAdapterV2` / `resolveTrustedLocalAdapterV2`,
after inputs materialize and before a host is constructed.

| Refusal | Cause | Operator action | Retry meaningful? | Record written? | Cleanup | Concerns | Claim consequence |
|---|---|---|---|---|---|---|---|
| `ADMISSION_RETENTION_FAILED` (already-registered case) | `--output-root/registry` already holds a different declaration or manifest for the same manifest hash. | Point `--output-root` at a fresh directory, or remove the stale registry entry if it is genuinely superseded. | Yes, once the conflicting entry is resolved. | No. | The materialized `inputs/` tree from this attempt is retained (it was not the cause of the failure); the registry entry from the prior admission is untouched. | Operator (reused an output root across unrelated declarations). | None — this run's admission never completed. |
| `ADMISSION_RETENTION_FAILED` (unresolvable case) | `resolveTrustedLocalAdapterV2` finds no retained admission for the manifest hash the plan/declaration name — an unresolvable adapter artifact. | Re-run `declare-trusted-local-adapter` against the same manifest and adapter entry so an admission exists before `run-trusted-local-observation` is invoked against it. | Only after admission is re-established. | No. | Same as above. | Operator sequencing error, not a Lab or subject defect. | None. |
| `ARTIFACT_HASH_MISMATCH` | The retained manifest no longer hashes to the admission it was filed under — its bytes changed after admission. | Re-declare from the current manifest bytes; do not hand-edit a retained registry entry. | Only after re-declaration. | No. | Registry entry may need manual removal if corrupted. | Operator (edited retained bytes) or environment (disk corruption) — not the Lab. | None. |
| `ADAPTER_TRUSTED_LOCAL_AUTHORITY_MISMATCH` | The host did not resolve `trusted_local_code` authority for this run, or the coordinator produced a certified-style result for a trusted-local plan. | This indicates a Lab-side construction defect, not an operator error; file it rather than retrying blindly. | No — retrying the same invocation reproduces the same mismatch. | No — this is raised before the record is built. | None beyond removing the output root. | Lab. | None. |

## Adapter loading and operation dispatch

Raised while `AdapterHost` constructs the child process and dispatches each
planned operation. These codes are shared with the governed journey's adapter
host (see `runbooks/adapter.md`); the trusted-local-specific ones are listed
separately below.

| Refusal | Cause | Operator action | Retry meaningful? | Record written? | Cleanup | Concerns | Claim consequence |
|---|---|---|---|---|---|---|---|
| `ADAPTER_CAPABILITY_NOT_GRANTED` | The adapter requested a capability or credential handle the plan's `allowed_capability_ids` / `allowed_credential_handle_ids` does not list. | Add the capability to the plan if the adapter genuinely needs it, or fix the adapter if it should not be requesting it. | Only after the plan or adapter is corrected. | Yes — the record is still built and retained; the run's terminal status will not be `observed_complete`. | `--output-root` must be removed by hand; see [Cleanup](#cleanup) below. | Depends: a plan that under-declares is operator error, an adapter that over-requests is the adapter integration. | Terminal status is not `observed_complete`; the retained record documents the refusal but supports no completion claim. |
| `ADAPTER_MOUNT_NOT_READ_ONLY` | A mount the host fingerprinted before dispatch changed underneath it — the input tree was modified after materialization. | Do not modify `--output-root/inputs` while a run is in progress; start a fresh run. | No — the current run's evidence is already compromised. | Yes. | Remove `--output-root` and start over. | Operator (modified retained inputs mid-run) or a hostile local process — not the adapter or the Lab. | Terminal status is not `observed_complete`. |
| `ADAPTER_PROTOCOL_RESPONSE_MISMATCH` | The adapter's response did not match what its manifest declared for the operation, or arrived out of the manifest's declared order. Per the operator-surface document, a manifest whose operations are correct but differently **ordered** than what the adapter negotiates surfaces as this same refusal. | Compare your manifest's operation order against your adapter's actual negotiated order first; that is the most common cause. | Only after the manifest or adapter is corrected. | Yes. | Remove `--output-root`; see [Cleanup](#cleanup). | Adapter integration (manifest/adapter mismatch), not the Lab or the subject. | Terminal status is not `observed_complete`. |
| `ADAPTER_DEADLINE_EXCEEDED` | The adapter did not respond within its request deadline. | Check the adapter's own logs for the hang; increase `wall_clock_ms` in the plan only if the operation is legitimately slow. | Sometimes — a transient timeout may succeed on retry into a fresh output root; a systemic hang will not. | Yes. | Remove `--output-root`; see [Cleanup](#cleanup). | Adapter integration, unless the plan's deadline is unreasonably tight (operator). | Terminal status is not `observed_complete`. |
| `ADAPTER_PROCESS_CRASHED` | The adapter process exited or violated the protocol frame before completing the operation. | Inspect the adapter's own crash output; this is not something the Lab retries around. | Rarely — only if the crash was itself transient (e.g. resource exhaustion). | Yes. | Remove `--output-root`; see [Cleanup](#cleanup). | Adapter integration or the subject product it wraps — not the Lab. | Terminal status is not `observed_complete`. |
| `ADAPTER_LOCAL_CONTEXT_FORBIDDEN` | A governed-only flag (`--tier`, `--registry-governor`, `--certification-receipt`, etc.) was passed to a trusted-local command. | Remove the governed flag; trusted-local observation accepts none of them. | Yes, once removed. | No — this is refused before any flag parsing proceeds. | None. | Operator invocation error. | None. |

## Cleanup

| Refusal | Cause | Operator action | Retry meaningful? | Record written? | Cleanup | Concerns | Claim consequence |
|---|---|---|---|---|---|---|---|
| `ADAPTER_LOCAL_CLEANUP_INCOMPLETE` | The retained record's `terminal_status` is not `observed_complete`, or some operation did not reach `completed`. Commonly a plan that declares `start` but no matching `stop`, which the reducer will never treat as discharged — but an operation whose record state is `ambiguous_not_replayed` with a `recovery_observation` naming `ADAPTER_PROTOCOL_DOWNGRADE_REFUSED` reached this same refusal for an unrelated reason: the adapter does not declare `supportedProtocolVersions: ["subject-adapter/v2"]` (or otherwise cannot answer the host's V2-only local offer), so the host refused the negotiation. | Read the retained record at the path the refusal names, specifically each entry's `operation_records[].recovery_observation` — not just the top-level `terminal_status` — before assuming a missing `stop`. If the cause is a protocol refusal, add `supportedProtocolVersions: ["subject-adapter/v2"]` to the adapter's `AdapterDefinition`; if it is a missing cleanup operation, fix the plan for the next run. | Only after the plan or adapter defect is fixed; the same plan reproduces the same incomplete terminal. | **Yes** — the record is retained either way, and the command exits nonzero. | The adapter's own external side effects (if any) are the adapter's responsibility; the Lab's own bounded cleanup is always attempted regardless of how the loop ended. Remove `--output-root` once you are done reading the retained record. | Depends on which operation stalled — adapter integration, plan authoring, or (rarely) the Lab's own cleanup dispatch. | The run supports no completion claim; the retained record's `cleanup` field states exactly what was and was not discharged. |
| `ADAPTER_LOCAL_RESIDUE_REPORT_INVALID` | An operation's residue observation does not match the response shape the host expects. | This indicates an adapter that reported residue in a shape the SDK does not produce — check whether the adapter bypassed the SDK. | Only after the adapter is corrected. | Yes. | Remove `--output-root`. | Adapter integration — a conforming adapter using the SDK cannot produce this. | Terminal status is not `observed_complete`. |

## Offline verification

### The trusted-local record's own self-check

`run-trusted-local-observation` verifies its own retained record before
returning, using an independent reconstruction of the run from the plan bytes
and the retained admission — not by re-reading the record's own verdict.

| Refusal | Cause | Operator action | Retry meaningful? | Record written? | Cleanup | Concerns | Claim consequence |
|---|---|---|---|---|---|---|---|
| `ADAPTER_TRUSTED_LOCAL_RECORD_INVALID` | The independent reconstruction disagrees with the retained record on any of: the plan's own hash, the record's run identity, the admission binding, the retained input tree's re-hash, the operation chain, cleanup and terminal recomputation, the claim ceiling, or the record's own core hash. The refusal message lists every disagreement found in one pass. | Read the listed disagreements; a retained-input mismatch means a file under `inputs/` was altered after the run, and everything else points at a Lab defect worth filing rather than retrying. | No — the same retained bytes reproduce the same disagreements. | Yes — the record exists; it is the thing that failed to verify. | Remove `--output-root` once you have read the record; there is nothing else to clean up. | Usually the Lab (an independent-reconstruction disagreement it produced itself); a retained-input disagreement specifically is whoever altered the input tree. | The run supports no claim at all — offline verification did not pass. |

### The general `verify` and `verify-record` commands

These are the two commands the README lists as externally supported outside
the trusted-local flow — `erl2 verify --public-bundle ...` (offline
verification of a governed public bundle) and `erl2 verify-record ...`
(offline verification of a retained invalid run record). They share the
offline-verification stage and are worth knowing about here because an
operator working from committed fixtures may reach either.

| Refusal | Cause | Operator action | Retry meaningful? | Record written? | Cleanup | Concerns | Claim consequence |
|---|---|---|---|---|---|---|---|
| `BUNDLE_MEMBER_MISMATCH` | A supplied public bundle declares a member `path` other than the `logicalPath` the artifact index actually found that artifact at (ADR-ERL2-043, B1; closed by PR #25). | Supply the bundle exactly as the run retained it, or an export whose declared paths were not hand-edited. | Only after the bundle is corrected. | N/A — this is verification of already-retained evidence. | None; verification is read-only. | Whoever authored or edited the supplied bundle document — never the retained evidence itself. | The bundle does not verify; no claim can be made from it. |
| `ARTIFACT_HASH_MISMATCH` (bundle authority check, B2) | The supplied `core_hash` is not what the supplied canonical bytes actually produce. | Recompute the bundle from the retained evidence rather than editing fields by hand. | Only after the bundle is corrected. | N/A. | None. | Whoever authored the supplied bundle. | The bundle does not verify. |
| `GRAPH_CLOSURE_UNREACHABLE_ARTIFACT` (bundle authority check, B3) | The bundle's recomputed identity is not the independently indexed core hash of a `public-verification-bundle/v2` artifact retained beneath `retained/`. Refuses both a detached, never-retained bundle and one that exists only outside `retained/`. | Supply a bundle the run actually retained under `retained/`, not a re-authored or misplaced one. | Only with a genuinely retained bundle. | N/A. | None. | Whoever supplied a bundle the run never retained as evidence. | The bundle carries no authority; nothing it says is attributable to the run. |
| `GRAPH_CLOSURE_TERMINAL_MISMATCH` (bundle authority check, B4) | The bundle's `created_at` predates the signed attestation's `finalized_at` — including a stamp that is only impossible-calendar-forward of the attestation once parsed, the gap PR #26 closed at the schema layer. | Re-export the bundle from the actual retained run; do not hand-construct timestamps. | Only after the bundle is regenerated. | N/A. | None. | Whoever authored the supplied bundle. | The bundle does not verify. |
| `VERIFY_RECORD_EXPECTED_INVALID_RECORD` / `VERIFY_RECORD_ATTESTATION_PRESENT` / `VERIFY_RECORD_LIFECYCLE_GAP` | `verify-record` was pointed at a document that is not an invalid-run record, or one that carries an attestation (invalid records carry none), or whose lifecycle stream has a gap. | Supply the exact retained `invalid-run-record.json` and its matching lifecycle file. | Only after the correct files are supplied. | N/A. | None. | Whoever supplied the mismatched files. | The record does not verify. |

## What this document does not cover

It does not cover the governed journey's own admission and certification
refusals (`ADAPTER_CERTIFICATION_*`, `ADMISSION_ARTIFACT_UNKNOWN`, and the
rest of `runbooks/adapter.md`'s typed-refusals table) — those belong to a
journey this release does not offer externally. It also does not tell an
operator to disable a gate, edit retained evidence, weaken a hash comparison,
bypass offline verification, or reach into `tests/support/` internals to work
around a refusal; none of that is a supported response to anything in this
table.
