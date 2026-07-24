# ADR-ERL2-014 — adapter protocol framing, sandbox profile, and where identity is computed

**Status:** accepted
**Date:** 2026-07-23
**Deciders:** Lab Core Owner, Integrity/Security Owner
**Normative source:** `external-reality-lab-design-v2.md` §11.2, §11.3, §21; implementation plan §11

## Context

Design v2 §11.2 fixes the shape of the adapter interface — "a separate process
over framed canonical JSON on stdin/stdout" — and §21 fixes the intended
isolation posture. It does not fix the framing bytes, where the codec lives,
how the host waits for a process while still terminating its whole tree, who
computes artifact identity, or what a host must report when the environment
cannot provide a promised control. Slice 5 had to decide all five, and each is
expensive to reverse once adapters exist.

## Decisions

### 1. The framing codec lives in `@erl2/contracts`

Frames are `<decimal byte length>\n<utf-8 JSON>`. There is no delimiter inside
the payload, so a message cannot be split or smuggled by embedding a newline,
and a declared length above the negotiated cap is refused **before** the body is
buffered.

The codec and the closed host↔adapter message set live in `@erl2/contracts`,
not in `@erl2/adapter-sdk`. Both sides — core's host and the SDK's runtime —
already depend on contracts, so this keeps exactly one implementation while
preserving the plan §4.1 direction (`contracts <- adapter-sdk <- adapters/*`,
`contracts <- integrity <- core`). Putting it in the SDK would have forced
`core -> adapter-sdk`; duplicating it would have created a framing disagreement,
which is a security bug rather than a compatibility inconvenience.

### 2. Identity is Lab-owned; adapters return drafts

No adapter computes a `core_hash`, and no adapter names a target by a hash.
Adapter responses carry *drafts*: descriptors, statuses and references. The host
canonicalises, derives every identity hash through the registered domain
separators, validates against the closed contract, and freezes.

This makes a whole class of attack unreachable rather than detected: an adapter
cannot assert an artifact identity, cannot claim an identity for an artifact it
never produced, and cannot pin a mutation to a target it never touched. It also
keeps `@erl2/adapter-sdk` dependent on contracts alone — it needs no access to
`@erl2/integrity`'s domain registry, because it never hashes anything.

### 3. A core-owned supervisor gives synchronous dispatch *and* tree termination

A run is a sequence of durable steps, not a concurrent pipeline, and every
existing CLI command and the journey engine are synchronous. Making the host
async would have coloured that entire call chain for no lifecycle benefit.

`spawnSync` alone cannot terminate a process *tree*: it has no `detached`
option, so a helper the adapter forked would outlive its deadline.

The host therefore `spawnSync`s a tiny core-owned supervisor
(`packages/core/src/adapter/sandboxLauncher.ts`), which launches the adapter
**detached, in its own process group**, forwards frames, caps stdout, captures
and truncates stderr, kills the negative pid on deadline or overflow, and emits
exactly one `ERL2-SUPERVISOR <json>` line describing the outcome. The supervisor
parses no frame, inspects no request and decides nothing the host could decide;
it exists solely to own the process group.

### 4. The sandbox profile reports *adjudicated* and *prevented* controls separately

The only enabled profile is `local-process`. It is a real process boundary, not
a container, and the report says exactly that. `SandboxControlId` distinguishes
what the host decides and receipts from what a kernel would have to enforce:

- **Enforced (13):** separate process, process-tree termination, wall-clock
  deadline, bounded request bytes, bounded response bytes, writable-output-only,
  environment-variable allowlist, bounded diagnostics, input-mount tamper
  detection, egress-policy adjudication, docker-socket capability denial,
  privileged-capability denial.
- **Unsupported on this host (13), each with a reason code:** read-only input
  mounts, no-ambient-home-directory, no-docker-socket, deny-by-default egress,
  numeric non-root user, read-only root filesystem, capability-drop-all,
  no-new-privileges, seccomp default profile, PID limit, memory limit, CPU
  limit, network-namespace isolation.

`egress-policy-adjudication` and `deny-by-default-egress` are deliberately
*different members*: the host really does decide and receipt every declared
egress, and it really cannot stop a same-user process from opening a socket.
Collapsing them into one control would let a downstream report imply the second
from evidence of the first.

The `container` profile is declared and
`disabled_no_qualified_adapter_substrate`. Requesting it raises
`ADAPTER_SANDBOX_CONTROL_UNSUPPORTED`; it is never silently downgraded to the
process profile.

### 5. Privilege is a closed capability enum with no shell member

`AdapterCapabilityId` contains no shell, glob, environment expansion or
free-form operation — there is nothing to sanitise because there is nothing to
pass. Nine members are privileged and, while ERL2-OQ-001 is open, every one is
denied with `ADAPTER_PRIVILEGED_OPERATION_NOT_SUPPORTED` and the denial is
recorded in `AdapterCapabilityGrantV1`. An adapter whose manifest declares one
cannot be constructed, so the refusal precedes any process launch.

### 6. Package kind travels as the frozen artifact's media type

An adapter must be able to see which package kind it was handed, but
`PackageVerificationRequestV1` must not gain a `subject_package_manifest_hash` —
the manifest is what verification *produces*. The frozen artifact's media type
(`application/vnd.erl2.package.<kind>`) is subject-visible, pre-verification
information, so it carries the kind without a forward reference.

## Alternatives rejected

- **Newline-delimited JSON.** Rejected: a payload containing a newline splits
  the frame, and the length cannot be checked before buffering.
- **Adapters computing `core_hash`.** Rejected: it would make artifact identity
  an adapter claim, and it would force the SDK to depend on `@erl2/integrity`.
- **An async host.** Rejected: it colours the whole run path for no lifecycle
  gain, and still needs the supervisor for tree termination.
- **`spawnSync` with no supervisor.** Rejected: no process-group termination,
  so a forked helper survives the deadline.
- **Reporting the container posture as enforced "in principle".** Rejected
  outright by the implementation prompt and by design §21's residual-risk
  discipline: a control that is not enforced here is reported unsupported.
- **A `run_command(text)` capability behind a validator.** Rejected: an enum
  whose payload is command text is a shell, and design §21 forbids one.

## Consequences and executable evidence

- `tests/architecture/adapterSurface.test.ts` reads the SDK's real export list
  and import graph, so decision 2's boundary cannot drift.
- `tests/adversarial/adapterHost.test.ts` drives 23 hostile adapters that ignore
  the SDK entirely, including a timeout fixture that forks a detached grandchild
  and asserts the grandchild is dead — decision 3's whole point.
- `tests/integration/adapterCertification.test.ts` asserts the enforced and
  unsupported control lists appear in the receipt and never overlap.
- `tests/architecture/removability.test.ts` proves core runs with no adapter
  package present and hashes identically either way.

## Rollback

Disable the adapter host by not passing `--adapter-entry`; the development fake
port remains. Reversing decisions 1, 2 or 6 requires a superseding ADR and a new
protocol major, because certified adapters depend on all three.
