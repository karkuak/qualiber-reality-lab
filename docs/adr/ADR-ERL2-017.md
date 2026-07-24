# ADR-ERL2-017 — a container substrate is qualified by observed enforcement; the sandbox profile stays disabled on a second, separate gate

**Status:** accepted
**Date:** 2026-07-23
**Deciders:** Integrity/Security Owner, Lab Core Owner, Adapter Reviewer
**Supersedes:** ADR-ERL2-016 §"Consequences" only. Every decision in ADR-ERL2-016 stands unchanged and is re-affirmed below.
**Normative source:** `external-reality-lab-design-v2.md` revision `2.0.0-draft.11` §21, §22; implementation plan §11.4; Slice 6.5 parallel safety track

## Context

ADR-ERL2-016 established the qualification *procedure* and recorded the honest
outcome at the time: **not qualified**, because no substrate was pinned on the
host and therefore no enforcement probe had been run against one.

It also named exactly what would have to change: "When a substrate is qualified,
`tests/adversarial/isolationQualification.test.ts` is the file that must change,
and it may only change because a real probe observed enforcement."

A substrate has now been pinned and probed. This ADR records that evidence, and
records a distinction the earlier ADR did not need to draw, because at the time
only one gate was failing.

## Evidence

A container runtime was made available on the authoring host with explicit
operator approval, and a minimal image was pinned **by digest**:

| Field | Value |
|---|---|
| runtime | `docker` 29.5.3 |
| platform / architecture | `linux` / `arm64` |
| kernel | `6.12.76-linuxkit` |
| image reference | `alpine@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce` |
| seccomp | `builtin` |
| cgroup version | `2` |
| default runtime | `runc` |
| probe suite | `erl2-container-enforcement-probes-v1` |

`npm run qualify:isolation -- --image <digest-pinned reference>` executed the
suite against that substrate. **All twenty required controls returned
`evidence: "observed"` with `enforced: true`**, and the derived verdict is
`qualified`. The retained evidence is `environments/isolation/`: the signed
`IsolationSubstrateLockV1`, one `IsolationEnforcementProbeResultV1` per control
recording what was attempted and what was observed, and the derived
`IsolationQualificationReportV1`.

Two properties of the suite are worth stating, because they are what make the
evidence load-bearing rather than decorative:

1. **Negative controls.** Where a control can be switched off, the probe also
   runs the unprotected variant and requires the protection to be what made the
   difference. `read-only-root-filesystem` observes a write refused under
   `--read-only` *and* the same write succeeding without it;
   `network-namespace-isolation` observes zero global addresses under
   `--network=none` against one on the default bridge. Observing a failure
   proves nothing if the operation would have failed anyway.

2. **A defect the suite caught in itself.** The first `wall-clock-deadline`
   probe attached to the container and relied on the harness's `spawnSync`
   timeout. That timeout sends `SIGTERM` to the runtime CLI, the CLI forwards it
   to PID 1, and PID 1 has no default signal handlers — so `sleep` ignored it
   and the CLI waited out the container's full 600 seconds. The probe reported
   `enforced: true` for a deadline that had bounded nothing, and the whole suite
   took 608 s. The probe now launches detached, `SIGKILL`s at the deadline,
   measures real elapsed time and **fails if the run exceeded its own bound**;
   observed elapsed time is now 167 ms and the suite completes in 14.3 s. This
   is recorded because it is precisely the failure mode ADR-ERL2-016 exists to
   prevent, and it was found by insisting the probe record a measurement rather
   than a conclusion.

Substrate drift was verified against a *real* second image present on the same
host: `assertQualifiedForExecution` accepts the locked substrate and refuses the
drifted one with `ENV_ISOLATION_SUBSTRATE_DRIFT` before any subject executes.

## Decisions

### 1. ADR-ERL2-016's decisions are re-affirmed, not relaxed

Enabled status is still derived and never declared; only `observed` evidence
counts; a pinned immutable lock is still a precondition; subject trust still
gates the profile; and this track still implements no privilege broker.
`fakeEnforcementProbes()` still returns every control as `mocked` and still
cannot qualify anything.

### 2. The substrate qualification verdict is `qualified`

`qualifyIsolationProfile` returns `qualified` for the `container` profile over
the retained lock and probe evidence. `erl2 doctor` reports it under
`subject_isolation`, and re-derives it on every invocation from the retained
artifacts rather than reading the stored report's `verdict` field.

### 3. Substrate qualification and profile usability are two separate gates

This is the new decision, and it is the reason ERL2-OQ-008 does **not** close.

- *Does a substrate enforce the twenty controls?* — answered `qualified`.
- *Can the Lab start an adapter inside that substrate?* — answered **no**.
  `packages/core/src/adapter/sandboxLauncher.ts` supervises a local child
  process and has no container backend. There is no code path that could
  execute an adapter under the `container` profile.

`CONTAINER_PROFILE_STATE` therefore changes from
`disabled_no_qualified_adapter_substrate` to
`disabled_no_container_adapter_launcher_pending_erl2_oq_008`, and
`assertSandboxProfileEnabled("container")` still refuses.

Collapsing the two gates into one state would be an overclaim in a new
direction: an enforcement guarantee with nothing running behind it protects
nothing, and a reader seeing "qualified" next to a usable-looking profile would
reasonably conclude an opaque subject could now be run.

### 4. ERL2-OQ-008 stays open

The continuation prompt's §5.5 gates require, in addition to a pinned substrate
and twenty observed controls, that *the adapter certification suite passes under
the qualified profile*. It has not, because no launcher can place an adapter
there. ERL2-OQ-008 therefore moves from
`open` to `open_substrate_qualified_launcher_missing` and its fail-closed state
is retained: **no opaque-private or third-party subject may execute**, and
`local-process` continues to refuse both.

## Consequences

- Slice 7 must still not execute an opaque package; Slice 9 must still not
  execute a third-party OSS subject.
- What remains for ERL2-OQ-008 is now a *named, bounded* piece of work rather
  than an open research question: a container-backed sandbox launcher, a
  digest-pinned runtime image capable of hosting the adapter protocol, and a
  re-run of `ADAPTER-CERT-V1` under that profile.
- The qualification is host-specific and lock-specific. On any host without
  `environments/isolation/`, the derivation returns `not_qualified` with
  `SUBSTRATE_LOCK_NOT_PINNED`, which is the correct answer there.
- Re-qualification is required whenever the runtime, the image digest, the
  security profile or the probe suite digest changes; the drift check enforces
  this before execution rather than at review time.

## Alternatives considered

- **Close ERL2-OQ-008 on the strength of twenty observed controls.** Rejected:
  §5.5 requires adapter certification under the profile, and a substrate that
  cannot host an adapter has not been shown to contain one.
- **Keep `CONTAINER_PROFILE_STATE` unchanged to avoid touching tests.**
  Rejected: the state would then assert "no qualified substrate", which is now
  false. A refusal that cites a reason which has become untrue is the first step
  toward the refusal being removed as obsolete.
- **Enable the profile and let the launcher fail at run time.** Rejected: the
  failure would surface after admission rather than before it, and admission is
  where the subject-trust gate lives.
