# Ledger — the container-backed sandbox launcher (ERL2-OQ-008 gate 2)

**Date:** 2026-08-07
**Companion to:** [ADR-ERL2-034](../adr/ADR-ERL2-034.md)
**Predecessors:** [ADR-ERL2-016](../adr/ADR-ERL2-016.md) (the qualification
procedure), [ADR-ERL2-017](../adr/ADR-ERL2-017.md) (a substrate qualified; two
gates, not one)

This package closes **gate 2** of ERL2-OQ-008: the Lab can now start an adapter
inside a qualified container substrate, and `ADAPTER-CERT-V1` passes there. It
does **not** close ERL2-OQ-008. Everything measured below sits behind evidence
signed by a repo-derivable development key, and no line of this package changes
who signed it.

Recorded state change: `open_substrate_qualified_launcher_missing` →
`open_substrate_qualified_launcher_available_authentication_missing`.

Independence, as the disposition ledgers record it: no subject identifier was
added to any module under `packages/` (`CORE-PURITY`); every new artifact, flag,
refusal and schema field is generic.

---

## 1. What was open

ADR-ERL2-017 recorded a qualified substrate and an unusable profile, and named
the remaining work exactly:

> a container-backed sandbox launcher, a digest-pinned runtime image capable of
> hosting the adapter protocol, and a re-run of `ADAPTER-CERT-V1` under that
> profile.

`sandboxLauncher.ts` supervised a local child process via
`spawn(process.execPath, [entryPath])`. `CONTAINER_PROFILE_STATE` read
`disabled_no_container_adapter_launcher_pending_erl2_oq_008` and
`assertSandboxProfileEnabled("container")` refused.

---

## 2. What was measured

### 2.1 The runtime image had to change, and the probe suite said why

`alpine@sha256:14358309…`, the substrate ADR-ERL2-017 qualified, has no Node
runtime. The adapter protocol speaks over a Node child process, so that image
cannot host it — twenty observed controls with nothing able to run behind them.

The obvious replacement, `node:22-alpine`, **failed a probe**:

```
POPULATED=/home
SCAN_DONE
```

`no-ambient-home-directory` scans for a populated `/home`, and `node:22-alpine`
creates the `node` user with `/home/node`. The probe is arguably over-broad —
that is the image's own directory, not the operator's — but it is over-broad in
the safe direction, and editing a probe so a chosen image passes is the move this
repository's review history exists to prevent.

**The image was changed, not the probe.**
`environments/isolation/runtime-image/Dockerfile` derives from the digest-pinned
base, removes `/home/node` (and npm, npx and yarn, which an adapter has no use
for), and fails its own build if `/home` is not empty afterwards. The probe-suite
digest is unchanged from ADR-ERL2-017.

### 2.2 Twenty controls, re-observed against the image the adapter runs in

```
== running erl2-container-enforcement-probes-v1 against the locked substrate ==
   finished in 8.7s

PASS  read-only-root-filesystem                  evidence=observed
PASS  numeric-non-root-user                      evidence=observed
PASS  capability-drop-all                        evidence=observed
PASS  no-new-privileges                          evidence=observed
PASS  seccomp-default-profile                    evidence=observed
PASS  cpu-limit                                  evidence=observed
PASS  memory-limit                               evidence=observed
PASS  pid-limit                                  evidence=observed
PASS  wall-clock-deadline                        evidence=observed
PASS  process-tree-termination                   evidence=observed
PASS  network-namespace-isolation                evidence=observed
PASS  deny-by-default-egress                     evidence=observed
PASS  read-only-input-mounts                     evidence=observed
PASS  writable-output-only                       evidence=observed
PASS  no-docker-socket                           evidence=observed
PASS  no-ambient-home-directory                  evidence=observed
PASS  no-vault-truth-judge-or-selection-access   evidence=observed
PASS  bounded-diagnostics                        evidence=observed
PASS  run-scoped-resource-identity               evidence=observed
PASS  teardown-and-residue-inspection            evidence=observed

== verdict: qualified ==
residue reaped after the suite: (none)
```

| Field | Value |
|---|---|
| runtime | `docker` 29.5.3, `linux/arm64`, kernel `6.12.76-linuxkit` |
| image | `erl2-adapter-runtime@sha256:cc3808ff40b19dd58f341019b0ddd827402346c657e05b1d7e95be90044a4440` |
| base | `node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32` |
| adapter runtime observed inside it | `v22.23.2` |
| seccomp / cgroup / runtime | `builtin` / `2` / `runc` |

`environments/isolation/` is **replaced**, not extended. The alpine evidence is
superseded; ADR-ERL2-017 remains the record of what was measured then. Reusing it
for a different image is the exact substitution
`assertObservedMatchesIsolationLock` exists to refuse.

### 2.3 `ADAPTER-CERT-V1` under the container profile — the §5.5 exit gate

ADR-ERL2-017 §Decision 4 named this as the gate that had never been met. Against
`reference-correct`, through the public protocol, with the launcher underneath:

```
verdict: certified in 2.9s
refusals: []
 passed  immutable-artifact-identity
 passed  no-privileged-broker-capability
 passed  no-product-specific-core-change
 passed  protocol-negotiation
 passed  unsupported-retention
 passed  diagnostics-bounds
 passed  deterministic-projection
 passed  phase-request-ancestry
 passed  oracle-partition
 passed  mutation-disclosure
 passed  unsupported-package-kind
 passed  deadline-and-process-tree-termination
 passed  no-execution-after-output-freeze
 passed  residue-reporting
enforced: 25   unsupported: 0
```

Twenty-five of twenty-five controls `enforced`, against twelve of twenty-five
under `local-process`. The thirteen that differ are the kernel-prevented ones,
and each reads `enforced` because a probe observed *that control* on *this* lock.

### 2.4 The deadline trap, reproduced and bounded

ADR-ERL2-017 §Evidence records a probe that reported `enforced: true` for a
deadline that bounded nothing: `spawnSync`'s timeout sent SIGTERM to the runtime
CLI, the CLI forwarded it to PID 1, PID 1 had no default signal handlers, and a
4-second deadline took 608 seconds.

The launcher's subject is a Node process that ignores SIGTERM for the same
reason. Against `fixtures/sabotage/adapters/timeout.mjs` — which answers nothing
and forks a detached grandchild first — with a 4000 ms deadline:

```
{
 "outcome": "timed_out",
 "process_tree_terminated": true,
 "terminated_descendant_count": 2,
 "container_termination": {
  "container_id": "c783f76ac1b9d6a162104b58518a941f067c75e00c0a63c486b4be21e86cc501",
  "image_digest": "sha256:cc3808ff40b19dd58f341019b0ddd827402346c657e05b1d7e95be90044a4440",
  "namespace_processes_at_termination": 2,
  "running_after_termination": false,
  "runtime_pid_after_termination": 0,
  "removed": true,
  "residue_after_removal": false,
  "deadline_span_ms": 4063,
  "deadline_enforced": true,
  "oom_killed": false
 }
}
```

**4063 ms against a 4000 ms bound**, both processes in the pid namespace gone,
container removed, no residue. Through the full host path the refusal arrived in
**5437 ms** with code `ADAPTER_DEADLINE_EXCEEDED` (the host path adds container create and teardown either side of the bound).

Three things make this a measurement rather than a formality, and all three are
retained: the container is killed by **id** (read from `create`, before it ran —
not a name a later run could reuse, and not a pid, which is the defect
`NC-PROCTREE` caught in the local supervisor and `939d804` fixed); the namespace
process count is read from the runtime **before** the kill, because `top`
afterwards lists nothing whether or not the kill worked; and a run that overran
its own bound is reported as `ADAPTER_SANDBOX_CONTROL_UNSUPPORTED` — the
profile's control did not hold — rather than as an ordinary adapter timeout.

### 2.5 The launcher observation is not "is the daemon up"

`probeContainerLauncher` starts a hardened container in the locked image and
watches the adapter runtime answer (`v22.23.2`). Gate 2 existed precisely because
a fully qualified substrate can be unable to host the protocol; a runtime-version
check would have reported the alpine substrate as launchable.

---

## 3. What did **not** change, and how that is enforced

| Property | Before | After |
|---|---|---|
| authenticity outcome | `locally_observed_unauthenticated` | `locally_observed_unauthenticated` |
| `authenticated` reachable? | only via a pinned authority | only via a pinned authority |
| opaque-private subject | refused | refused |
| third-party subject | refused | refused |
| claim ceiling | T1 | T1 |
| privilege broker | `absent_pending_erl2_oq_001` | `absent_pending_erl2_oq_001` |
| ERL2-OQ-008 | open | open |

The two subject refusals changed *mechanism*, which is worth stating plainly.
They used to hold because the profile refused everything; they now hold because
`deriveContainerProfileActivation` refuses any subject that is not
`trusted_reference`, citing the `locally_observed_unauthenticated` outcome. A
refusal that used to be free now costs a line of code, and that line is covered
by a negative control rather than by argument.

---

## 4. The negative-control campaign

Eight controls were added, seven of them hermetic. Registered in
[`negative-controls.json`](negative-controls.json) per
[`negative-control-harness.md`](negative-control-harness.md); each declares its
`mustFail` suite and the exact case names that must die.

| control | invariant it removes | expected |
|---|---|---|
| `container-profile-requires-derivation` | the profile is refused until a qualification is derived here | fail |
| `container-profile-substrate-qualification` | drift, suite digest, lock binding and twenty *observed* controls are re-derived before activation | fail |
| `container-profile-subject-trust` | an opaque or third-party subject is refused a fully working profile | fail |
| `container-profile-launcher-observed` | a qualified substrate with no working launcher is still refused | fail |
| `container-control-report-derived-per-control` | each control reads `enforced` only because a probe observed *it* | fail |
| `container-activation-rederived-from-evidence` | an activation is re-derived on every use, so the structural type cannot be forged into a permission | fail |
| `container-manifest-names-its-substrate` | a container manifest must name the lock licensing its report | fail |
| `container-deadline-kills-the-container` | the deadline SIGKILLs the container, not the CLI (§2.4) | fail |

`container-profile-substrate-qualification` is the one that covers
`fakeEnforcementProbes()`: removing `assertQualifiedForExecution` kills
*CONTAINER-PROFILE: mocked probes qualify nothing, launcher or no launcher*,
which is the property ADR-ERL2-016 decision 1 rests on.

**`container-deadline-kills-the-container` needs a daemon.** On a host without
one, the deadline tests take their announced skip branch, the control kills
nothing, and the campaign records `no_test_failed`. That must be read as
**UNMEASURED HERE**, not as a guard that is not load-bearing — the same reading
`telemetry-gate-satisfaction` carries and for the same reason. The control's
`note` field says so, because the harness ledger's own lesson is that a control
which silently measures nothing is the most expensive way to be wrong.

### Campaign results

`npm run negative-control -- container`, against a disposable worktree at
`265eb39`, 8 of 116 controls selected. **All eight matched their recorded
expectation, and the working tree was byte-identical afterwards.**

| control | result | pass / fail |
|---|---|---|
| `container-profile-requires-derivation` | `named_tests_failed` | 12 / 1 |
| `container-profile-substrate-qualification` | `named_tests_failed` | 9 / 4 |
| `container-profile-subject-trust` | `named_tests_failed` | 11 / 2 |
| `container-profile-launcher-observed` | `named_tests_failed` | 11 / 2 |
| `container-control-report-derived-per-control` | `named_tests_failed` | 12 / 1 |
| `container-activation-rederived-from-evidence` | `named_tests_failed` | 12 / 1 |
| `container-manifest-names-its-substrate` | `named_tests_failed` | 12 / 1 |
| `container-deadline-kills-the-container` | `named_tests_failed` | 0 / 2 |

Two readings worth making explicit:

- `container-profile-substrate-qualification` killed **four** cases against three
  named. That is the expected shape rather than a surprise: removing
  `assertQualifiedForExecution` removes drift, suite-digest, lock-binding *and*
  observed-not-mocked in one line, and the fourth casualty is the
  container-certification file's own derivation. A single guard carrying four
  properties is worth knowing about.
- `container-deadline-kills-the-container` scored **0 pass / 2 fail** because
  the authoring host has a daemon, so both deadline tests ran for real and both
  died. On a host without one they would take their announced skip branch and
  this control would score `no_test_failed` — **UNMEASURED HERE**, never "not
  load-bearing". The control's `note` field carries that reading so a later
  reader of the results file does not have to reconstruct it.

---

## 5. Anything that failed first

1. **`node:22-alpine` failed `no-ambient-home-directory`** (§2.1). Found by
   running the probe suite, not by review. The image was changed.
2. **The runtime image is not bit-reproducible** (ADR-ERL2-034 §3.2). Two builds
   of the same Dockerfile from the same base digest produce different image ids;
   `SOURCE_DATE_EPOCH` removes one source of variance and BuildKit's
   `rewrite-timestamp`, which would remove the rest, conflicts with the docker
   exporter's unpack here. The initial build script claimed reproducibility and
   the claim was removed rather than the property being asserted: a rebuilt image
   is `ENV_ISOLATION_SUBSTRATE_DRIFT` until re-qualified, which is the drift check
   working.
3. **The first attempt at a container-side path map was wrong in a way that
   would have failed silently.** `exchange()` derived the request-frames path and
   the supervisor's working directory from `message.output_directory`, which the
   container profile rewrites to `/erl2/output` — so the host would have written
   its request file to a container path on the host filesystem. Caught while
   wiring, before any test existed for it; the fix is an explicit
   `ExchangeContext` carrying host paths that the adapter is never told about.
4. **`qualify:isolation` deleted this directory's documentation, and the first
   run of this package proved it.** The script did
   `rmSync(outDir, { recursive: true, force: true })` before publishing, so that
   a not-qualified run could not leave a lock behind. `outDir` is
   `environments/isolation`, so it also removed `README.md` — and would have
   removed `runtime-image/Dockerfile`, the source of the substrate being
   qualified, on the next run. Nothing failed; the files simply went away, and it
   surfaced as an unexplained deletion in `git status`. The script now removes
   exactly the four evidence artifacts by name.
5. **The container supervisor could not report its own worst failure.** `emit`
   closes over `stdout`, which was declared after the create step, so the
   create-failure path — a bad image reference, an unmountable path — read a
   `let` in its temporal dead zone and died with a `ReferenceError` instead of
   writing its report. The host would have seen no supervisor line, reported
   `crashed` with empty stderr, and discarded the one diagnostic that says what
   went wrong. Found by re-reading the file, not by a test; the declarations moved
   above the create step.
6. **An interrupted teardown could orphan a container.** If the host's own
   ceiling fires, `spawnSync` SIGKILLs the supervisor, and a supervisor that is
   dead cannot remove the container it created. The
   `teardown-and-residue-inspection` claim would then have held on every path
   except the one where teardown was interrupted. The host now reaps by the
   run-scoped container name whenever a container-profile exchange produced no
   supervisor report.
7. **The activation started out storing conclusions, which made it forgeable.**
   Its first shape carried `observedControls`, `imageDigest` and
   `substrateLockHash` as fields. `ContainerProfileActivation` is a structural
   type, so an object literal with `state` set and a plausible lock hash would
   have opened the profile and produced a manifest naming its own fabricated
   hash — a "derived, never declared" gate that could be declared. It now
   carries the lock, the observed substrate and the probe results, every derived
   value is computed on use, and `assertSandboxProfileEnabled` re-runs all four
   gates on every call. Forging one therefore means supplying a signed lock and
   twenty probe results bound to it, which is the evidence. Caught in
   self-review; `container-activation-rederived-from-evidence` is the control
   that keeps it caught.

---

## 6. Where each property is proven

| Property | Test |
|---|---|
| the suite passes under the container profile | `tests/integration/containerAdapterCertification.test.ts` |
| the profile claims exactly the observed controls | same |
| opaque/third-party refused under a working profile | same, and `tests/adversarial/containerSandboxProfile.test.ts` |
| drift, mocked probes, foreign lock binding, absent launcher | `tests/adversarial/containerSandboxProfile.test.ts` |
| the report is derived per control | same |
| a container manifest names its substrate | same |
| the host refuses to be constructed without a derivation | same |
| the module closure excludes Lab authority roots | same |
| one hardened flag vector for probes, launcher and lock | same |
| the deadline bounds a signal-ignoring subject | `tests/adversarial/containerDeadlineEnforcement.test.ts` |
| termination and residue are observed, keyed on container id | same |
| the retained evidence still re-derives and stays dev-signed | `tests/integration/isolationRetainedEvidence.test.ts` (unchanged) |
| the qualification procedure still refuses everything it did | `tests/adversarial/isolationQualification.test.ts`, `tests/adversarial/isolationSubstrate.test.ts` (unchanged) |

The two container-dependent files announce a skip on stderr **and** assert the
fail-closed refusal in that branch. The ordinary gate never requires a daemon,
and a skipped branch that asserts nothing would read as coverage.
