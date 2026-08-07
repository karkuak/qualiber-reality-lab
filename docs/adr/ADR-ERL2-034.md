# ADR-ERL2-034 — a container-backed sandbox launcher closes gate 2; the qualification is still self-reported, so ERL2-OQ-008 stays open

- **Status:** accepted
- **Date:** 2026-08-07
- **Deciders:** Integrity/Security Owner, Lab Core Owner, Adapter Reviewer
- **Supersedes:** ADR-ERL2-017 §Decision 3's *state string* only. Every decision
  in ADR-ERL2-016 and ADR-ERL2-017 stands and is re-affirmed below.
- **Builds on:** [ADR-ERL2-016](ADR-ERL2-016.md) (the qualification procedure;
  only `observed` counts; subject trust gates the profile),
  [ADR-ERL2-017](ADR-ERL2-017.md) (a substrate qualified; two gates, not one)
- **Normative source:** `external-reality-lab-design-v2.md` §21, §22;
  implementation plan §11.1–§11.4

## 1. Context

ADR-ERL2-017 split ERL2-OQ-008 into two questions and answered them separately:

- **Gate 1 — does a substrate enforce the twenty required controls?**
  `qualified`, against `alpine@sha256:14358309…`.
- **Gate 2 — can the Lab start an adapter inside that substrate?** **No.**
  `sandboxLauncher.ts` supervises a local child process and has no container
  backend, so no code path could execute an adapter under the `container`
  profile.

It also named what remained as "a *named, bounded* piece of work": a
container-backed sandbox launcher, a digest-pinned runtime image capable of
hosting the adapter protocol, and a re-run of `ADAPTER-CERT-V1` under that
profile. This ADR records that work and, more importantly, records exactly how
much it did **not** change.

## 2. What this package changes, and what it does not

**Gate 2 is closed.** A container-backed launcher exists, the twenty controls
were re-observed against a Node-capable image pinned by digest, and
`ADAPTER-CERT-V1` passes under the `container` profile against the correct
reference adapter — the §5.5 exit gate ADR-ERL2-017 §Decision 4 named as never
having been met.

**Gate 1b — is that evidence authenticated? — is untouched.** The substrate lock
and the probe-signing manifest are still signed by
`developmentKey("environment-governor")`, whose private key is derivable from
this repository. `deriveIsolationAuthenticity` still returns
`locally_observed_unauthenticated`, `erl2 doctor` still reports it, and
`authenticated` is still reachable only through a pinned qualification
authority that does not exist on this checkout. Nothing in this package could
change that, and nothing in it tries to.

So:

- **ERL2-OQ-008 does not close.** Its state narrows from
  `open_substrate_qualified_launcher_missing` to
  **`open_substrate_qualified_launcher_available_authentication_missing`**.
- Slice 7 must still not execute an opaque package; Slice 9 must still not
  execute a third-party OSS subject. Both are refused *under the container
  profile too*, by an explicit gate (§7), not by the profile being unusable.
- The claim ceiling stays **T1**.

What the launcher legitimately enables is narrower than it looks: **trusted,
repository-owned reference subjects may execute under the `container` profile on
a host whose substrate qualifies**, with an honest control report.

## 3. Evidence

The qualified substrate is a **new image**, and it had to be. Alpine cannot host
the adapter protocol — the protocol speaks over a Node child process and that
image has no Node runtime. ADR-ERL2-017's consequences make re-qualification
mandatory when the image digest changes, and
`assertObservedMatchesIsolationLock` enforces it before execution rather than at
review time, so reusing the alpine evidence here is precisely the substitution
the drift check exists to refuse.

| Field | Value |
|---|---|
| runtime | `docker` 29.5.3 |
| platform / architecture | `linux` / `arm64` |
| kernel | `6.12.76-linuxkit` |
| image reference | `erl2-adapter-runtime@sha256:cc3808ff40b19dd58f341019b0ddd827402346c657e05b1d7e95be90044a4440` |
| base image | `node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32` (`node:22-alpine`) |
| adapter runtime observed inside it | `v22.23.2` |
| seccomp | `builtin` |
| cgroup version | `2` |
| default runtime | `runc` |
| probe suite | `erl2-container-enforcement-probes-v1` (digest unchanged) |

`npm run qualify:isolation -- --image erl2-adapter-runtime@sha256:cc3808ff…`
executed the suite against that substrate. **All twenty required controls
returned `evidence: "observed"` with `enforced: true`**, and the derived verdict
is `qualified`. The retained evidence in `environments/isolation/` — signed lock,
twenty probe results, derived report, signed probe manifest — is *replaced*, not
added to: it now describes the image the adapter actually runs in. The alpine
evidence ADR-ERL2-017 recorded is superseded, and that ADR remains the record of
what was measured then.

### 3.1 A finding the probe suite produced about the chosen image, and what was changed in response

The obvious runtime image is `node:22-alpine`. It **fails**
`no-ambient-home-directory`: it creates the `node` user with `/home/node`, so the
probe observes `POPULATED=/home`.

The probe is arguably over-broad — `/home/node` is the image's own directory, not
the operator's home — but it is over-broad in the safe direction, and loosening a
probe so that a chosen image passes is the exact move this repository's review
history exists to prevent. The image was changed instead:
`environments/isolation/runtime-image/Dockerfile` derives from the digest-pinned
base, removes `/home/node` (and npm, npx and yarn, which an adapter has no use
for), and fails its own build if `/home` is not empty afterwards. No probe was
edited; the probe-suite digest is unchanged from ADR-ERL2-017.

### 3.2 The runtime image is not bit-reproducible, and the drift check is the answer

Two builds of that Dockerfile from the same base digest produce two different
image ids on this runtime. `SOURCE_DATE_EPOCH` removes one source of variance;
BuildKit's `rewrite-timestamp`, which would remove the rest, conflicts with the
docker exporter's unpack here.

This is recorded rather than worked around. A reviewer who rebuilds gets a
different id, `assertObservedMatchesIsolationLock` refuses with
`ENV_ISOLATION_SUBSTRATE_DRIFT`, and the twenty controls must be observed against
*their* bytes before anything runs. That is the drift check doing its job.
ADR-ERL2-017 already recorded that the qualification is host-specific and
lock-specific; this makes it image-build-specific too, which is a stronger
statement, not a weaker one.

## 4. Decision 1 — the launcher supervises, and decides nothing

`containerSupervisor.ts` is the container analogue of `sandboxLauncher.ts` and is
held to the same standard: "it never parses a frame, never inspects a request,
and never decides anything the host could decide instead."

Every flag, mount, container-side path, deadline and byte bound arrives in a
**host-authored spec file**. The supervisor creates a container, pipes the
pre-encoded frames through it, bounds it, observes how it ended, removes it, and
writes one `ERL2-SUPERVISOR <json>` line — the same line, in the same place, that
the local supervisor writes, so `host.ts` parses one report shape and the
adjudication above it is untouched.

The consequence worth naming: the *host* decides what a container may reach.
Mounting the repository root would have been one line and would have put the
vault, truth, judge and selection roots inside a namespace a probe had just
observed could not reach them. Instead the host mounts the adapter's package root
and its **declared** module closure, each read-only, each vetted by
`assertMountPermitted`. An import the adapter never declared is absent from the
container and fails there, which is the fail-closed direction.

## 5. Decision 2 — the deadline kills the container, and reports a measurement

ADR-ERL2-017 §Evidence records a probe that reported `enforced: true` for a
deadline that bounded nothing: it relied on `spawnSync`'s timeout, which sends
`SIGTERM` to the runtime CLI, which forwards it to PID 1, which has no default
signal handlers *because it is PID 1* — so the payload ignored it and a 4-second
deadline took 608 seconds.

The launcher is reachable by the identical mistake, and its subject is a Node
process that ignores `SIGTERM` for the same reason `sleep` did. So:

- the attached run is launched **detached**, so nothing about this process's own
  signal disposition is load-bearing;
- the deadline `SIGKILL`s the **container**, by id, through the runtime;
- real elapsed time is measured from arming the deadline to observing the
  container stopped, and **a run that overran its own bound is reported as a
  control failure** (`ADAPTER_SANDBOX_CONTROL_UNSUPPORTED`), not as an ordinary
  adapter timeout. The distinction is the point: `ADAPTER_DEADLINE_EXCEEDED` says
  the adapter ran too long; this says the profile's `wall-clock-deadline` control
  did not hold, which invalidates the control report and is the Lab's problem.

`deadline_span_ms` and `deadline_enforced` are both retained, so an offline
reader gets the measurement and can disagree with the verdict derived from it.
Measured here: **4063 ms against a 4000 ms deadline**, on a subject that answers
nothing and would otherwise run forever.

## 6. Decision 3 — the process-tree analogue is the pid namespace, observed, keyed on container id

`SupervisorReport` reports `process_tree_terminated` and
`terminated_descendant_count`. Their container meanings:

- **Identity is the full 64-hex container id**, read back from `create` before
  the container has run. Not the name, which a later run could reuse, and not a
  pid — `NC-PROCTREE` failed once in CI on exactly a pid-reuse defect (fixed in
  `939d804`), and that fix does not transfer for free just because the boundary
  moved.
- `terminated_descendant_count` is the number of processes the runtime **listed
  inside the container's pid namespace at the moment termination was ordered**.
  Taken before the kill, because `top` afterwards lists nothing whether or not
  the kill worked.
- `process_tree_terminated` is true only when a kill was ordered *and* the
  runtime subsequently reports nothing running under that id. Ordering a kill and
  the container being gone are different claims.

Retained alongside them, in a new optional `container_termination` object on
`sandbox-invocation-result/v1`: the container id, image digest, namespace process
count, post-termination running flag and runtime pid, removal and residue flags,
the deadline span and the OOM flag. A verdict whose measurement is not retained
cannot be re-derived offline, and offline re-derivation is the thesis of the
repository.

Measured against `fixtures/sabotage/adapters/timeout.mjs`, which forks a detached
grandchild before hanging: **2 processes in the namespace, both terminated,
container removed, no residue**.

A container the runtime still knows about after removal was ordered is
`RESIDUE_DETECTED` — a refusal, because `teardown-and-residue-inspection` is one
of the twenty controls this profile claims.

## 7. Decision 4 — the profile is derived per host and per control, and never declared

`CONTAINER_PROFILE_STATE` changes from
`disabled_no_container_adapter_launcher_pending_erl2_oq_008` to
**`disabled_until_container_substrate_qualification_derived_on_this_host`**.

The old string has to go for ADR-ERL2-017's own reason: "a refusal that cites a
reason which has become untrue is the first step toward the refusal being removed
as obsolete." A launcher now exists. What does *not* follow from a launcher
existing in the source tree is that a runtime is answering, that the locked image
is present, or that twenty controls were observed on the host about to execute
something.

`ContainerProfileActivation` carries **evidence, not conclusions** — the lock,
the observed substrate, the probe results, the launcher observation and the
subject's trust class — and every derived value (`containerObservedControls`,
`containerSubstrateLockHash`) is computed on use. It is a structural type, so an
object literal is writable by anyone; carrying evidence is what makes that
harmless, because `assertSandboxProfileEnabled` re-runs every gate over what the
object carries on every call. Forging an activation therefore means supplying a
signed lock and twenty probe results bound to it, which is not forgery. Same
argument as `IsolationQualificationReportV1`: the admission check re-derives
rather than reads.

The four gates, in order, all refusals:

1. **Substrate.** `assertQualifiedForExecution` re-compares the observed runtime
   against the lock (`ENV_ISOLATION_SUBSTRATE_DRIFT`), re-checks the probe-suite
   digest, re-binds every probe result to this lock, and re-derives the verdict
   rather than reading a stored one.
2. **Launcher.** Observed by starting a hardened container in the locked image
   and watching the adapter runtime answer. Not "the daemon is up" — gate 2
   existed precisely because a fully qualified substrate could be unable to host
   the protocol.
3. **Subject trust.** §8 below.
4. **Per-control observation.** The control report is assembled from the probe
   results, not from the fact that the verdict was `qualified`.

`sandboxControlReport("container", activation)` is therefore not a second
hard-coded table. It is the same ordering as `local-process` with the thirteen
kernel-prevented entries flipped to `enforced` **for exactly those controls the
activation observed on this lock**; anything else stays
`unsupported_on_this_host` with `CONTROL_NOT_OBSERVED_ON_LOCKED_SUBSTRATE`. All
twenty-five read `enforced` on this host, and each of the thirteen maps 1:1 onto
a probe — asserted at module load, so a `SandboxControlId` added without a probe
behind it fails immediately rather than being claimed.

The manifest carries `sandbox_profile: "container"` and
`isolation_substrate_lock_hash`, and the schema makes the second required
whenever the first is `container`: a container invocation that named no substrate
would claim kernel-prevented controls with nothing behind them. Both fields are
optional overall, so every manifest frozen before this package is byte-identical
and correctly reads as `local-process`.

### 7.1 One configuration, read by all three parties

The probes, the launcher and the runtime-configuration hash the lock pins all
read `HARDENED_CONTAINER_RUN_FLAGS` from `containerHardening.ts`. A launcher that
quietly added `--tmpfs /tmp`, dropped `--cap-drop=ALL` or raised `--memory` would
be running a substrate no probe ever saw, and the qualification evidence would
still read `qualified`, because nothing compares a flag vector to a probe.
Divergence is not caught by review here; it is unrepresentable.

### 7.2 What `writable-output-only` means under this profile

Two writable mounts, not one: the run-scoped output directory and the run-scoped
diagnostics directory, both host-created, host-read and host-frozen. The probe
observed the strict case (rootfs, `/tmp` and `:ro` input mounts all refuse
writes) and that substance is unchanged; the control is that the adapter cannot
write anywhere the host did not designate, and it cannot.

## 8. Decision 5 — subject trust still gates the profile, and now has to be enforced rather than implied

ADR-ERL2-016 §5 gated the profile on subject trust and ADR-ERL2-017 re-affirmed
it. Until now that gate cost nothing to honour, because the profile refused
everything.

It now has teeth: `deriveContainerProfileActivation` refuses any subject that is
not `trusted_reference`, citing ERL2-OQ-008's state and the
`locally_observed_unauthenticated` authenticity outcome. A qualified substrate
with a working launcher is still not *authenticated* evidence, and authentication
is the gate an opaque-private or third-party subject waits on. This is the
executable form of "closing gate 2 did not close ERL2-OQ-008", and it is covered
by a negative control (`container-profile-subject-trust`) rather than by
argument.

## 9. Failure ownership and refusal codes

| Situation | Code | Owner |
|---|---|---|
| container profile with nothing derived for this host | `ADAPTER_SANDBOX_CONTROL_UNSUPPORTED` | lab |
| observed substrate diverges from its lock | `ENV_ISOLATION_SUBSTRATE_DRIFT` | lab |
| probe evidence bound to another lock, or a drifted probe suite | `ENV_ISOLATION_SUBSTRATE_DRIFT` | lab |
| fewer than twenty observed controls, or any `mocked`/`declared` | `ADAPTER_SANDBOX_CONTROL_UNSUPPORTED` | lab |
| qualified substrate, no working launcher | `ADAPTER_SANDBOX_CONTROL_UNSUPPORTED` | lab |
| opaque-private or third-party subject | `ADAPTER_SANDBOX_CONTROL_UNSUPPORTED` | lab |
| container manifest naming the wrong substrate lock | `ADAPTER_SANDBOX_CONTROL_UNSUPPORTED` | lab |
| adapter's declared dependency does not resolve | `ADAPTER_SANDBOX_CONTROL_UNSUPPORTED` | lab |
| adapter entry outside its declared package root | `ADAPTER_IDENTITY_MISMATCH` | lab |
| the container outlived its own deadline | `ADAPTER_SANDBOX_CONTROL_UNSUPPORTED` | lab |
| the container was bounded and the adapter never answered | `ADAPTER_DEADLINE_EXCEEDED` | adapter |
| container still known to the runtime after removal | `RESIDUE_DETECTED` | lab |

## 10. What is explicitly not decided here

- **Authentication.** No pinned qualification authority is introduced, no key is
  rotated, and `authenticated` remains unreachable. This is the whole of what
  ERL2-OQ-008 still waits on.
- **The privilege broker.** ERL2-OQ-001 stays `absent_pending_erl2_oq_001`;
  `assertQualificationGrantsNoNewAuthority` is unchanged.
- **Egress.** Deny-by-default is unchanged, and the container profile makes it
  kernel-enforced rather than only adjudicated. No allowlist is widened.
- **The claim ceiling.** T1, unchanged.
- **A `disposable_vm` profile.** Still undeclared and unimplemented.

## 11. Rejected alternatives

- **Close ERL2-OQ-008 now that certification passes under the profile.**
  Rejected. The evidence licensing the profile is signed by a repo-derivable
  development key, so it is self-reported. Twenty controls observed by the party
  that benefits from the answer is exactly the shape of claim the authenticity
  layer was added to refuse, and a launcher does not change who signed.
- **Reuse the alpine lock and mount a Node runtime into it.** Rejected. The
  running substrate would then be a composition no probe observed, and the drift
  check would pass because the image digest had not moved. The check would be
  measuring the wrong thing while reporting the right one.
- **Loosen `no-ambient-home-directory` so `node:22-alpine` passes.** Rejected;
  see §3.1. The image was changed.
- **Let `sandboxControlReport("container")` return a second static table.**
  Rejected. It would be true on the authoring host and false everywhere else,
  and nothing in the type system or the tests would notice the difference.
- **Have `erl2 doctor` probe the launcher on every invocation.** Rejected: a
  diagnostic that starts containers by surprise is not a diagnostic. It reports
  `not_probed` by default and observes under `--probe-launcher`. `not_probed` is
  deliberately distinct from `unavailable` — "nobody asked" and "it was tried and
  failed" are different facts about a host.
- **Keep `launcher_available: false` in doctor's output.** Rejected for
  ADR-ERL2-017's reason: it has become capable of being false.
