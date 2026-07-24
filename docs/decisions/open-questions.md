# Open questions and their enforced fail-closed states

Each entry names the decision, its owner, its deadline and — critically — the
behaviour the implementation actually exhibits today. Every fail-closed state
below is executable, not aspirational: the linked check refuses the unsafe path.

| ID | Decision | Owner | Deadline | Enforced fail-closed state | Where enforced |
|---|---|---|---|---|---|
| ERL2-OQ-001 | Privilege broker host technology | Security + Core | before slice 5 | Unprivileged subject operations only; every privileged capability is denied and receipted; no shell capability exists | `assertManifestCapabilitiesUnprivileged` refuses a manifest declaring one; `grantCapabilities` records the denial in `AdapterCapabilityGrantV1`; `erl2 doctor` reports `privilege_broker: unprivileged_container_subjects_only_pending_erl2_oq_001` |
| ERL2-OQ-002 | First three constrained archetype parameter sets | Environment Governor | before slice 10 | Clean preview only; brownfield claims withheld | no archetype fixtures are admitted |
| ERL2-OQ-003 | Non-Qualiber OSS subject | Governor + independent QE | before slice 9 | Architectural-independence claim withheld | `docs/claims/permitted-claims.md` |
| ERL2-OQ-004 | Evaluation pack executable format | Evaluation + Security | before slice 6 | **Data-only DSL only.** A pack is a closed `EvaluationPackBodyV1` whose every predicate, input selector, measure, ordering key and finding category is drawn from a closed vocabulary the Lab implements; there is no pack runtime to sandbox | `packages/evaluation-sdk` exposes declarative data and `certifyPack` only; `bindDomainPack` reads a pack solely through the frozen contract; `tests/architecture/evaluationBoundary.test.ts` proves the contract has no code, I/O, clock, randomness, validity or threshold member |
| ERL2-OQ-005 | OpenTelemetry Demo release and per-platform image digest lock | Environment Governor | before slice 3 | Fake driver only; Compose driver disabled; no attesting Compose run | `assertSubstrateQualified` refuses the retained lock; `composeDriverManifestBody` emits `enabled: false`; `assertDriverEnabled` refuses it; `erl2 doctor` reports `compose_environment_driver: disabled_pending_erl2_oq_005` |
| ERL2-OQ-006 | Seven-year retention legal approval | Privacy/Legal | before slice 11 | No held-out production release | no held-out release path exists |
| ERL2-OQ-008 | Container or disposable-VM substrate for opaque subjects | Security + Core | before slice 7 execution of an opaque package | **Controls locally observed but unauthenticated; profile still disabled.** The twenty controls were `observed` against a digest-pinned container substrate, but the substrate lock is signed by the repo-derivable **development** governor key — not a pinned qualification authority — so the evidence is self-reported: `erl2 doctor` reports `locally_observed_unauthenticated`, **never** the producer-assertable `authenticated`/`qualified`. And no launcher can start an adapter inside the substrate, so `local-process` remains the only usable profile and every opaque-private or third-party subject is still refused (ADR-ERL2-017, review P2-1/6R-E) | `verifyIsolationLockSignature` verifies the lock's Ed25519 signature and classifies the signer; `deriveIsolationAuthenticity` returns `locally_observed_unauthenticated` for a valid dev-signed lock and `not_qualified` for a tampered/forged one; `qualifyIsolationProfile` returns `qualified` only as the *content* verdict (twenty *observed* controls) which the authenticity layer then downgrades; `assertQualifiedForExecution` re-derives and refuses on substrate drift; `assertSandboxProfileEnabled` refuses the container profile with `disabled_no_container_adapter_launcher_pending_erl2_oq_008`; `erl2 doctor` reports the lock signature, signer, per-control probe status and the distinguished authenticity outcome under `subject_isolation` |
| ERL2-OQ-007 | External beacon, locally pinned source registry entry, custodian roster, and any future audited threshold-VRF construction | Security + Environment Governor | before slice 2 selection freeze | **Non-blind `development` selection only.** Threshold VRF always fails with `THRESHOLD_VRF_NOT_ACTIVATED` | `assertDevelopmentTierOnly` refuses a held-out or blind tier against the development beacon; `assertActiveRandomnessVariant` refuses every threshold-VRF policy |

## ERL2-OQ-001 in detail

Slice 5 shipped the adapter platform **without** a privilege broker, exactly as
the implementation plan's §11.4 rollback specifies. What that means concretely:

- Privilege was never modelled as command text. `AdapterCapabilityId` is a
  closed enum and contains no shell, no glob, no environment expansion and no
  free-form operation. There is nothing to sanitise because there is nothing to
  pass.
- Nine members of that enum are privileged: `bind-loopback-port`,
  `install-package-into-host`, `write-host-configuration`,
  `register-host-service`, `host-package-manager`, `load-kernel-module`,
  `use-docker-socket`, `elevate-to-root` and `reboot-host`. Every one is denied
  with `ADAPTER_PRIVILEGED_OPERATION_NOT_SUPPORTED`.
- The denial is *recorded*, not emulated: `AdapterCapabilityGrantV1` lists
  requested, granted and denied capabilities separately and pins
  `privileged_broker_state: "absent_pending_erl2_oq_001"` as a schema constant.
- An adapter whose manifest declares a privileged capability cannot be
  constructed at all, so the refusal precedes any process launch.
- `ADAPTER-CERT-V1` fails such an adapter with the same code, and a refused
  receipt certifies no operation and no package kind.

Activation requires an audited broker that validates plan hash, exact target
root, one-time operation id, before-state precondition and compensation, and
returns a signed before/after receipt — plus a superseding ADR.

### The sandbox claim is capped, not assumed

A second, related limitation is recorded here because it shares the same
threat model. The only enabled sandbox profile is `local-process`. It enforces
thirteen controls and reports thirteen more as `unsupported_on_this_host` with
a reason code, in every `SandboxInvocationManifestV1` and in every
certification receipt. Kernel-level isolation — read-only root filesystem,
numeric non-root user, capability drop, no-new-privileges, seccomp,
PID/memory/CPU limits, network-namespace isolation, kernel-enforced read-only
mounts, and a block on opening a socket or reading the operator's home
directory — is **not** provided and is not claimed. The `container` profile is
declared and `disabled_no_qualified_adapter_substrate`; requesting it is a
refusal rather than a silent downgrade. Run untrusted subjects on a disposable
machine.

## ERL2-OQ-007 in detail

No external beacon has been qualified, and no locally pinned production source
registry entry exists. Slice 2 therefore implements the **complete** selection
protocol — native proof verification, wrapper ownership separation, pinned
source trust, acyclic checkpoints, threshold reveal custody, deterministic
rejection sampling, and independent chain verification — but drives it with an
explicitly labelled `DevelopmentBeaconSource`.

Consequences that are enforced, not merely documented:

- `assertDevelopmentTierOnly(tier, sourceId)` throws
  `RANDOMNESS_SOURCE_NOT_PINNED` for any tier other than `development`.
- The development beacon signs under `DEV-BEACON-ROUND-V1`. `signForeignDomain`
  refuses any ERL2 signing domain, so a beacon signature can never be replayed
  as a Lab/verifier association signature, and vice versa.
- The beacon refuses a second draw for the same pool, so no retry, redraw or
  alternate round is reachable.
- No blind or held-out claim appears anywhere in `docs/claims`.
- Slice 4's CLI refuses `--tier held_out` and `--tier blind` outright, and the
  fake subject port refuses to run at any tier but `development`.

Threshold VRF stays inactive regardless of ERL2-OQ-007's outcome: activation
additionally requires ADR-ERL2-011 to pin an audited construction *and* new
major contracts to pass security review. The draft suite contains no successful
threshold-VRF golden, by design.

## ERL2-OQ-005 in detail

Slice 3 shipped with the Compose driver disabled, exactly as the implementation
plan's §9.4 rollback specifies. What that means concretely:

- `environments/otel-demo/substrate-lock.json` carries
  `qualification_status: "unqualified_pending_erl2_oq_005"` and an explicit
  reason. `assertSubstrateQualified` refuses it.
- `composeDriverManifestBody` derives `enabled` from the lock, so the only way
  to produce an enabled Compose manifest is to supply a lock that qualifies.
  The disabled state cannot drift through a hand-edited fixture.
- `assertDriverEnabled` refuses a disabled manifest before provisioning.
- The fake driver is the only enabled driver and is the one every Slice 3 exit
  gate is proven against.
- `assertObservedMatchesLock` is implemented and tested now, so when the lock is
  qualified a moved tag, a re-pushed image, a changed config, an **extra**
  observed image or a **missing** locked config invalidates the run before
  provisioning rather than producing an attesting run against unknown bytes
  (image comparison is bijective and config comparison is exact set equality;
  review §11.5). The lock's own Ed25519 signature is verified first, so a
  tampered lock is refused with `ENV_SUBSTRATE_LOCK_SIGNATURE_INVALID` before any
  observed byte is trusted against it.

The qualification procedure is in `environments/otel-demo/README.md`.

## ERL2-OQ-008 in detail — stronger subject isolation

Slice 6's parallel safety track asked one question: *can this host enforce a
container or disposable-VM profile strong enough for an opaque private or
third-party subject?*

**Outcome: the controls were locally observed but the evidence is
unauthenticated, and the question stays open.**

Two gates have to pass before an opaque subject may run, and **neither** passes
in the authenticated sense the safety claim requires.

### Gate 1 — does a substrate enforce the twenty controls? **Locally observed, not authenticated.**

A container runtime was pinned by digest and probed with real enforcement
probes. All twenty controls returned `observed` / `enforced` — but the substrate
lock that binds this evidence is signed by the **repo-derivable development
governor key**, which the verifier explicitly does not treat as a qualification
authority. So the evidence is *self-reported*: `deriveIsolationAuthenticity`
returns `locally_observed_unauthenticated`, and `erl2 doctor` reports exactly
that, never `authenticated`. A tampered signature or an unpinned/forged signer
returns `not_qualified`.

The twenty probe results are themselves authenticated by a **signed
`isolation-probe-signing-manifest/v1`** (review §10.1/6R-E) that covers their
ordered core hashes and binds them to the lock and probe suite. `authenticated`
now requires BOTH the lock AND this manifest to be signed by a pinned authority;
a present-but-broken manifest (bad signature, wrong lock, or a hash set that does
not cover the evaluated results) forces `not_qualified`. On this checkout the
manifest is dev-signed, so it reads `valid_development` and the outcome stays
`locally_observed_unauthenticated`. The observed profile was:

- runtime `docker` 29.5.3 on `linux/arm64`, kernel `6.12.76-linuxkit`;
- image `alpine@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce`;
- seccomp `builtin`, cgroup v2, default runtime `runc`;
- probe suite `erl2-container-enforcement-probes-v1`.

Evidence is retained in `environments/isolation/`: the signed
`IsolationSubstrateLockV1`, one `IsolationEnforcementProbeResultV1` per control,
and the derived `IsolationQualificationReportV1`. `erl2 doctor` re-derives the
verdict from those artifacts on every call rather than reading the stored one.

The mechanism from ADR-ERL2-016 is unchanged and still binding:
`REQUIRED_ISOLATION_CONTROLS` enumerates the twenty controls;
`qualifyIsolationProfile` has no input meaning "enabled"; probe evidence is
discriminated `observed` / `declared` / `mocked` / `absent` and only `observed`
counts; `fakeEnforcementProbes()` returns every control as `mocked` and
therefore cannot qualify anything. The probe-result schema additionally makes
`enforced: true` unrepresentable unless `evidence` is `observed`.

Drift is enforced before execution, not at review time.
`assertObservedMatchesIsolationLock` compares every pinned field — runtime,
version, platform, architecture, kernel, image reference, image digest and the
whole security profile — and `assertProbeSuiteMatchesLock` refuses a suite whose
digest is not the one the lock pinned, so a weakened suite invalidates the lock
that licensed the old one.

### Gate 2 — can the Lab start an adapter inside it? **No.**

`packages/core/src/adapter/sandboxLauncher.ts` supervises a local child process.
It has no container backend, so there is no code path that could execute an
adapter under the `container` profile. `CONTAINER_PROFILE_STATE` is therefore
`disabled_no_container_adapter_launcher_pending_erl2_oq_008` and
`assertSandboxProfileEnabled("container")` still refuses.

The two gates are kept as separate states deliberately. A qualified substrate
with nothing running inside it protects nothing, and reporting one state would
let a reader conclude an opaque subject could now be run.

`tests/adversarial/isolationQualification.test.ts`,
`tests/adversarial/isolationSubstrate.test.ts` and
`tests/integration/isolationRetainedEvidence.test.ts` prove each refusal.

**Readiness consequence.** Unchanged: Slice 7 must not execute an opaque
package and Slice 9 must not execute a third-party OSS subject.

**What remains** is now bounded rather than open-ended: a container-backed
sandbox launcher, a digest-pinned runtime image able to host the adapter
protocol, and a passing `ADAPTER-CERT-V1` run under that profile. See
ADR-ERL2-017.
