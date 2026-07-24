# Subject-isolation substrate qualification (ERL2-OQ-008)

This directory holds the **evidence** for the container isolation qualification,
not a switch that enables anything. Nothing here can turn a profile on:
`qualifyIsolationProfile` has no input meaning "enabled", and `erl2 doctor`
re-derives the verdict from these artifacts on every call rather than reading
the stored report's `verdict` field.

Deleting this directory is a valid state. It is what an unqualified host looks
like, and the derivation then returns `not_qualified` with
`SUBSTRATE_LOCK_NOT_PINNED` — which is the correct answer there.

## What is here

| File | Contract | Meaning |
|---|---|---|
| `substrate-lock.json` | `IsolationSubstrateLockV1` | The immutable pin: runtime, version, platform, architecture, kernel, digest-pinned image, runtime configuration hashes, required security profile, probe-suite digest and policy inputs |
| `probes/<control>.json` | `IsolationEnforcementProbeResultV1` | One per required control: what the probe attempted, what it observed, what it expected, and whether the evidence is `observed` / `declared` / `mocked` / `absent` |
| `qualification-report.json` | `IsolationQualificationReportV1` | The derived verdict. Verifier output; never an input |

## Running a qualification

```bash
npm run qualify:isolation -- --image <reference@sha256:...>
```

The image reference **must** be digest-pinned. A tag can move, and enforcement
observed against a moved tag says nothing about the bytes a later run executes;
`resolveImageDigest` refuses an unpinned reference rather than resolving it.

Presence is then checked by **content digest**, not by the `repository@digest`
name. That is the correct dependency in principle — a lock must not rest on a
name — and it is also the more reliable one in practice: on this host
`docker image inspect alpine@sha256:…` and `docker image inspect alpine:3.22`
both fail intermittently against the containerd-backed image store, while the
bare digest resolves every time.

Exit codes: `0` qualified, `9` not qualified, `2` usage. A not-qualified run
publishes **nothing** and removes any previous evidence, so a partially
successful attempt can never be mistaken for progress.

The suite is not part of `npm test`: it needs a real runtime and it creates and
destroys containers. `npm test` checks the *retained evidence* instead
(`tests/integration/isolationRetainedEvidence.test.ts`), re-deriving the verdict
and requiring every control to be `observed`, so the hermetic suite stays fast
while qualification still depends on a real run.

## What the probes actually do

Each probe executes against the pinned substrate and records a measurement, not
a conclusion. Two rules make the evidence load-bearing:

**Negative controls.** Where a control can be switched off, the probe also runs
the unprotected variant and requires the protection to be what made the
difference. Observing that a write to `/` failed proves nothing if the write
would have failed anyway; observing that it *succeeds* without `--read-only` and
*fails* with it proves the flag is doing the work. The same pattern covers
network isolation (zero global addresses under `--network=none` against one on
the default bridge).

**Measurements, not verdicts.** `wall-clock-deadline` records real elapsed
milliseconds and fails if the run exceeded its own bound. This is not
theoretical: the first version of that probe attached to the container and
relied on the harness's `spawnSync` timeout, which sends `SIGTERM` to the
runtime CLI, which forwards it to PID 1 — and PID 1 has no default signal
handlers, so `sleep` ignored it and the CLI waited out the full 600 seconds. The
probe reported `enforced: true` for a deadline that had bounded nothing. It now
launches detached, `SIGKILL`s at the deadline and checks the clock.

## Drift

Before any qualified run, `assertQualifiedForExecution` re-checks:

1. the observed substrate still matches every pinned field of the lock;
2. the probe suite that produced the evidence is the one the lock pins;
3. every probe result is bound to *this* lock's hash;
4. the verdict re-derives as `qualified`.

Step 4 re-runs the decision rather than reading the report, so a hand-written
report claiming `qualified` grants nothing. Any divergence refuses with
`ENV_ISOLATION_SUBSTRATE_DRIFT` **before** a subject executes: an upgraded
engine, a re-pushed image, a changed seccomp profile or a weakened probe suite
is a different substrate, whatever the lock says.

## What qualification does *not* grant

Qualifying a substrate answers one question — "is this strong enough to contain
an adversarial subject?". It does not:

- **enable the sandbox profile.** `sandboxLauncher.ts` supervises a local child
  process and has no container backend, so no adapter can be started inside the
  qualified substrate. `CONTAINER_PROFILE_STATE` is
  `disabled_no_container_adapter_launcher_pending_erl2_oq_008` and
  `assertSandboxProfileEnabled("container")` refuses. This is why ERL2-OQ-008
  remains open (ADR-ERL2-017).
- **activate a privilege broker.** ERL2-OQ-001 is untouched and still
  fail-closed; `assertQualificationGrantsNoNewAuthority` enforces it.
- **open egress.** The deny-by-default policy is unchanged.
- **make `local-process` safe for an opaque subject.** A qualified profile
  admits an opaque subject **under that profile only**.

## Re-qualifying

Re-run the command whenever the runtime, its version, the image digest, the
security profile or the probe suite changes. The drift check will refuse the old
lock before it refuses anything else, so a stale qualification fails loudly
rather than silently licensing a substrate nobody probed.
