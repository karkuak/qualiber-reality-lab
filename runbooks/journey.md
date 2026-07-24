# Runbook — the generic journey, acquisition to frozen output

## What the ordering guarantees

```text
acquisition preregistration
  -> measured acquisition
  -> acquired-byte freeze
  -> package verification
  -> exact subject package manifest
  -> [challenge preregistration and selection]
  -> subject output freeze
```

Each step is a separate CLI process. The workspace recovers its lifecycle from
frozen events, so ordering is enforced by the state machine, not by anything
held in memory. Skipping a stage fails with `GRAPH_CLOSURE_MISSING_ROLE`
because the next command cannot resolve the role its predecessor produces.

## Preparing the admission registry

The challenge governor authors artifacts **before any run exists** and places
them in a directory the Lab reads by core hash:

- `AcquisitionSourceManifestV1` — a redacted locator and delivery policy, never
  a Lab package path, and never a challenge identity
- `SubjectAdapterManifestV1`
- `GenericRunPolicyV1`
- one `SubjectVisibleJourneyStepV1` and one `JourneyStepCommitmentV1` per step

The commitments reference age-x25519 ciphertexts of the judge expectations.
Those ciphertexts live in the **vault**, not the registry and not any run root.
An artifact whose declared `core_hash` disagrees with its bytes is rejected when
the registry is opened.

## The oracle partition

A logical step is two different contracts. The adapter sees only
`SubjectVisibleJourneyStepV1`. `JudgeJourneyExpectationV1` carries a unique
canary and is encrypted to the judge.

Before any request reaches the subject port the Lab scans it, and the port
itself refuses a request carrying an expectation-shaped field. All eight
design-named surfaces are scanned: adapter requests, mounted files, environment
variables, process arguments, diagnostics, subject output prefill, network
egress and Lab telemetry.

A canary outside the judge boundary is `JOURNEY_ORACLE_CANARY_LEAKED`, owner
`lab`. It invalidates the run **before** any subject attribution. Do not
downgrade it and do not attribute it to the subject.

## Measurement

Acquisition is measured, not merely performed. `SubjectAcquisitionRecordV1`
retains attempts with per-attempt byte counts, redirect counts and error codes,
authentication prompt counts, documentation step ids, active operator time and
elapsed time. A subject that is hard to obtain shows up here.

## Terminals

Once a run id is durably accepted the CLI cannot return a terminal state without
its record hash.

- **Valid pre-environment terminal** — the run stops after `acquire` or
  `verify_package`. `freeze-output --terminal-stage` freezes the
  pre-environment output manifest, whose ordered step closure is derived from
  lifecycle events rather than read from a producer array.
- **Invalid terminal** — a failed acquisition freezes subject output, runs
  bounded pre-environment cleanup from the actual frontier, and freezes exactly
  one `InvalidLabRunRecordV1`. No attestation and no bundle may descend from it.
  Verify it with `erl2 verify-record ... --offline`.

## Fail-closed states on this surface

| Attempt | Refusal |
|---|---|
| `--tier held_out` or `--tier blind` | `ADMISSION_SUBJECT_PORT_NOT_DEVELOPMENT` (ERL2-OQ-007) |
| a keyring other than `development` | `CFG_MISSING_REQUIRED` |
| an artifact hash the registry does not hold | `ADMISSION_ARTIFACT_UNKNOWN` |
| a stage run out of order | `GRAPH_CLOSURE_MISSING_ROLE` |
| a step after any reveal | `STATE_POST_REVEAL_EXECUTION_FORBIDDEN` |
| replay comparison at a blind tier | `COMPARISON_MODE_REPLAY_IN_BLIND_TIER` |

The subject is a **development-only fake port**. Slice 5 replaces it with the
sandboxed adapter host, the capability and privilege broker and the
certification harness; until then no real subject package is executed.
