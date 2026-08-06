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
| ERL2-OQ-005 | OpenTelemetry Demo release and per-platform image digest lock | Environment Governor | before slice 3 | **Qualified, development-signed.** A two-service subset of release `3.0.0` is pinned by archive digest, source commit, per-platform image digests (`linux/amd64` + `linux/arm64`), five config hashes, SBOM and provenance, and the Compose driver is enabled by it. The lock is signed by the repo-derivable **development** governor key, so this is a self-qualification: no independent-qualification claim may be derived, and the claim ceiling is unaffected (tier and blindness still cap at T1) | `assertSubstrateQualified` accepts the retained lock; `verifySubstrateLockSignature` classifies the signer `signerIsDevelopmentKey`; `composeDriverManifestBody` emits `enabled: true`; `assertObservedMatchesLock` re-observes archive, config and both platforms' digests at `provision`; `erl2 doctor` derives `compose_substrate` from the lock on every call |
| ERL2-OQ-006 | Seven-year retention legal approval | Privacy/Legal | before slice 11 | No held-out production release | no held-out release path exists |
| ERL2-OQ-008 | Container or disposable-VM substrate for opaque subjects | Security + Core | before slice 7 execution of an opaque package | **Controls locally observed but unauthenticated; profile still disabled.** The twenty controls were `observed` against a digest-pinned container substrate, but the substrate lock is signed by the repo-derivable **development** governor key — not a pinned qualification authority — so the evidence is self-reported: `erl2 doctor` reports `locally_observed_unauthenticated`, **never** the producer-assertable `authenticated`/`qualified`. And no launcher can start an adapter inside the substrate, so `local-process` remains the only usable profile and every opaque-private or third-party subject is still refused (ADR-ERL2-017, review P2-1/6R-E) | `verifyIsolationLockSignature` verifies the lock's Ed25519 signature and classifies the signer; `deriveIsolationAuthenticity` returns `locally_observed_unauthenticated` for a valid dev-signed lock and `not_qualified` for a tampered/forged one; `qualifyIsolationProfile` returns `qualified` only as the *content* verdict (twenty *observed* controls) which the authenticity layer then downgrades; `assertQualifiedForExecution` re-derives and refuses on substrate drift; `assertSandboxProfileEnabled` refuses the container profile with `disabled_no_container_adapter_launcher_pending_erl2_oq_008`; `erl2 doctor` reports the lock signature, signer, per-control probe status and the distinguished authenticity outcome under `subject_isolation` |
| ERL2-OQ-007 | External beacon, locally pinned source registry entry, custodian roster, and any future audited threshold-VRF construction | Security + Environment Governor | before slice 2 selection freeze | **Non-blind `development` selection only.** Threshold VRF always fails with `THRESHOLD_VRF_NOT_ACTIVATED` | `assertDevelopmentTierOnly` refuses a held-out or blind tier against the development beacon; `assertActiveRandomnessVariant` refuses every threshold-VRF policy |
| ERL2-OQ-009 | Externally supplied environment: a lock-driven Compose service graph, external substrate qualification, and whether an archetype admission seam mirrors the external-adapter one (issue #8, EQ-L-002/EQ-L-003) | Environment Governor + Core | decide at slice 10 entry, before any brownfield archetype parameter set freezes (with ERL2-OQ-002) | **No external environment admission; the interim path is adapter-served-on-loopback.** The driver enum is closed and bound once per run; the Compose service graph is a code constant with, deliberately, no mechanism for describing a different environment; a run's archetype must be in its selected challenge's admissible set; and the environment mount plus loopback egress grant derive only from the run's own provisioned, lock-pinned, live container — access is withdrawn, not inherited. An externally authored subject runs against the qualified subset, and may serve its own application on loopback inside the `local-process` claim boundary, where the Lab's provisioning, baseline, restoration-observation, residue and egress guarantees extend to the Lab's environment and **not** to that application | `resolveDriverKind` refuses an unknown driver and any mid-run substitution; `OTEL_DEMO_SERVICES` is a constant (`composeSubstrate.ts`); `assertArchetypeAdmissible` refuses an archetype outside the selected challenge's set; `readComposeEndpoint` authorizes only the run's own live, lock-pinned endpoint; `tests/e2e/externalSubjectComposeRun.test.ts` pins the external-subject shape and its stated claim boundary |

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
plan's §9.4 rollback specifies. It is now qualified, and the rollback path is
still the mechanism: nothing about the enablement is hand-edited.

**What is qualified.** A two-service subset of OpenTelemetry Demo release
`3.0.0` — `quote` (a real HTTP application with real OpenTelemetry
auto-instrumentation) and `otel-collector` (which receives its OTLP and exports
through the base configuration's `debug` exporter). The full demo is **not**
deployed. `environments/otel-demo/substrate-lock.json` pins the archive SHA-256,
the source commit read from the archive's own pax header, image digests for
`linux/amd64` **and** `linux/arm64` for both services, the SHA-256 of all five
applied configuration files, an SBOM and a provenance record.

**Which platforms are required.** `linux/amd64` and `linux/arm64`. The previous
requirement named `darwin/arm64`, which is not an image-manifest platform at all:
Docker Desktop on an arm64 Mac runs Linux containers in a Linux VM, so the images
a macOS host executes are `linux/arm64`, and no registry publishes a Darwin
manifest for either repository. That requirement made a qualified lock
unreachable rather than strict. `darwin/arm64` stays in the `SubstrateLockV1`
enum because narrowing a shared contract's enum breaks artifacts already written.

**How it stays fail-closed.**

- `composeDriverManifestBody` still derives `enabled` from the lock, so an
  unqualified lock still produces a disabled driver and the state cannot drift
  through a hand-edited fixture.
- The lock's Ed25519 signature is verified before any observed byte is trusted
  against it; a tampered lock is `ENV_SUBSTRATE_LOCK_SIGNATURE_INVALID`.
- `assertObservedMatchesLock` runs at `provision`, before a container exists: a
  moved archive, a re-pushed image, a changed config, an **extra** observed image
  or a **missing** locked config invalidates the run (image comparison is
  bijective, config comparison is exact set equality; review §11.5).
- `--environment-driver` defaults to `fake`, and a run binds its driver once.

**What this is not.** The lock is signed by
`erl2-dev-challenge-governor-ed25519-1`, a repo-derivable development key.
`verifySubstrateLockSignature` classifies it `signerIsDevelopmentKey: true`,
`signerIsPinnedAuthority: false`, and `erl2 doctor` reports
`independently_qualified: false`. No third party attested the release, the
images, the SBOM or the lock; the archive was fetched over TLS and hashed, with
no detached signature, cosign attestation or transparency-log proof checked
(`syft` and `cosign` are not installed on the qualifying host). Qualification
resolved both required platforms; the live acceptance run executed
`linux/arm64` only.

**What it does not unlock.** T2 is still unreachable. A real substrate raises the
*environment-realism* claim component to T2, and the claim ceiling is the weakest
applicable component — the run remains `development` tier with non-blind
selection under ERL2-OQ-007. ERL2-OQ-008 is untouched: the subject that exercises
this environment is a trusted, repository-owned reference adapter under the
`local-process` profile, and no opaque, private or third-party subject claim
follows from any of it.

**Where the trust boundary sits at run time.** Three things are re-derived from
Docker rather than taken from a retained record, because each was a place a name or
a file used to stand in for an observation:

- **an expected container name is not ownership.** Before any expected-name
  container is treated as this run's, all three ownership labels must carry this
  run's exact values (`com.erl2.run_id`, `com.erl2.driver_id`,
  `com.docker.compose.project`), and the image it is running must resolve — through
  the daemon, in two independent directions — to the exact service/platform digest
  the lock pins. A missing label is a mismatch. A daemon that cannot answer is
  "not proven", which is refused. The baseline probe records the *observed* image
  identity, not the locked digest, so a probe cannot agree with the lock by
  construction; and provision adoption is gated on the same verified graph, so a
  stored receipt cannot carry a substituted container forward.
- **a retained endpoint record is not an egress grant.** The record `provision`
  writes is validated field by field against values derived from the run id — run,
  substrate, service, container, host exactly `127.0.0.1`, a real port — and then
  Docker is re-observed for *all four* of: the exact container's three ownership
  labels, a running state, the **image the lock pins** for the endpoint service on
  the executing platform (the same two-legged rule the driver uses, shared as one
  function so the two cannot drift), and the binding **`8090/tcp` on `127.0.0.1` at
  exactly the recorded host port**. A stale record, a restarted container with a new
  ephemeral port, a port some other process picked up, an exact-name container
  running substituted bytes, a binding on `0.0.0.0`, and the recorded port published
  under a different container port all yield no endpoint, therefore no mount and no
  allowlist. `loopbackEgressPolicy` independently refuses any host but `127.0.0.1`
  and any port that is not a host port, so the grant is refused even by a caller
  that skipped the reader — and in a record like `example.com:80` it is the *host*
  that is inadmissible; `80` is a valid port and is accepted on `127.0.0.1`.
- **the substrate's published exposure is one loopback port.** The *rendered*
  Compose configuration — not the overlay's source text — publishes `quote`'s
  `8090/tcp` as one ephemeral host port bound to `127.0.0.1`, and publishes the
  collector's `4317`/`4318` not at all. Upstream publishes all three with no
  `host_ip`, which means `0.0.0.0`, so the earlier loopback-only wording described
  an intention rather than the substrate. The overlay *replaces* those entries
  (`!override` for `quote`, `!reset` for the collector) because Compose merges
  `ports` across files and an added entry would have left upstream's publication
  standing beside the narrowed one. Asserted against `docker compose config`, so the
  rendered merge is what is proven. A published OTLP receiver would have been an
  ingestion point for anything on the host, accepting spans a run then attributed to
  itself; internal `quote` → collector traffic continues over the Compose network.
- **`--verify` does not write.** `scripts/qualify-otel-demo.mjs --verify`
  regenerated the tracked SBOM index, the four SPDX documents and the provenance
  record before deciding whether the lock had drifted, which made drift in them
  undetectable. It now writes nothing under version control, requires the archive
  to be present rather than fetching it, unpacks its comparison material into a
  temporary directory it removes, and checks the whole retained set: the lock's own
  core hash and signature classification, the archive digest and source commit, the
  exact image matrix, the exact configuration hash set, the SBOM index's content
  and hash, the complete two-services × two-platforms document matrix, every
  referenced SPDX document's hash *and* its own package count, and the provenance
  record's binding to the same archive, commit and images.

**Telemetry: what was observed and what is attested.** These are different
statements and the documents now keep them apart.

- The **live acceptance test** drives the reference adapter against the real
  endpoint and reads the collector's own output, asserting that spans arrived and
  that they carry this run's marker. That is a real observation of attributable
  telemetry.
- An **offline bundle attests no such thing.** The archetype's `service-metric`
  source is recorded `complete` because the collector reported that its OTLP
  pipelines started, and every source snapshot in this archetype freezes
  `records: 0`. Pipeline readiness is reachability of the metric path, not the
  receipt of a service metric; `complete` means the source was served and returned
  nothing.

**Deferred obligation — the first Qualiber integration package.** Retaining the
attributable-telemetry observation into a run's evidence, and gating on it, is that
package's work and is not in this one. It is a change to what a run keeps, not to
any derivation here, and no general evidence subsystem was introduced to
anticipate it. Until it lands, `docs/claims/permitted-claims.md` permits "the
acceptance test observed attributable telemetry at the collector" and forbids any
claim that retained evidence attests received telemetry.

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

## ERL2-OQ-009 in detail — externally supplied environments

Raised by the independent evaluator workspace as
[issue #8](https://github.com/karkuak/qualiber-reality-lab/issues/8)
(EQ-L-002/EQ-L-003), answered there on 2026-08-06. This entry records the
sequencing so the decision has an owner, a target and a fail-closed state the
implementation actually exhibits.

### What exists today, and what does not

The external-subject seam is adapter-only. `buildGovernorRegistry` admits
externally authored `SubjectAdapterManifestV1`s through the same `admit` path as
every built-in manifest; nothing equivalent admits an externally authored
`environment-archetype/v1`, and an archetype could not be admitted alone anyway:

- `assertArchetypeAdmissible` requires the archetype to be named by the
  *selected challenge's* `archetype_hashes`, so an external archetype implies an
  externally authored challenge/journey/step-commitment/vault graph — the unit
  of admission is the governor artifact graph, not one artifact;
- the Compose driver realizes exactly one service graph. `OTEL_DEMO_SERVICES`
  is a constant, and `composeSubstrate.ts` states the design position verbatim:
  *"there is no mechanism for describing a different environment"*;
- the environment mount and loopback egress grant derive from
  `readComposeEndpoint`, which authorizes only this run's own provisioned
  container, running the lock-pinned image, publishing on loopback at the moment
  of the check. The Lab cannot be pointed at an environment it did not
  provision, and that is a property, not a gap.

### The interim path, and its exact boundary

An externally authored adapter may serve its own application on loopback from
inside its operations. This is mechanically possible because the only enabled
sandbox profile is `local-process`, whose honest control report declares
`deny-by-default-egress` and `network-namespace-isolation`
`unsupported_on_this_host`. `tests/e2e/externalSubjectComposeRun.test.ts`
proves a full offline-valid terminal on exactly this shape.

On that path, every Lab guarantee still holds **for the Lab's environment**
(the qualified subset): provisioning receipts, inventory, baseline,
restoration observation, teardown, zero Docker-project residue. None of them
extends to the adapter-served application: it has no provisioning evidence, is
invisible to the baseline and the restoration probe, is outside the residue
enumeration (a process that outlives a cleanly exited operation is untracked
residue — the process group is SIGKILLed only on deadline or overflow), and its
loopback-only posture is the adapter's discipline, not a Lab-enforced or
receipted constraint. Its behaviour enters the record only as retained,
hash-accounted subject output and cited projection claims — first-party
evidence the Lab retains faithfully but does not observe independently. The
run's tier ceiling is unchanged (development, non-blind, T1, dev-signed
self-qualification), so this forfeits nothing the current surface ever offered.

### The seam, if the decision is to build it

The generic seam is **not** archetype admission — `erl2-clean-greenfield`
already describes a generic loopback service topology. The product-specific pin
is the qualified substrate. The seam is an externally supplied **substrate
lock**: make the service graph, endpoint service and container port
lock-declared data instead of code constants; generalize the qualification
script so any archive+overlay pair can be pinned and dev-signed; admit the lock
through the registry like any governor artifact; and mirror the external-subject
E2E against an externally supplied substrate. A lock is service ids, digests,
config hashes and a signature — the Lab learns nothing about what the
application is, which keeps this seam exactly as generic as the
adapter-manifest one. Claim ceiling unchanged (self-qualification, T1).

Estimated one slice-sized package (roughly 7–12 working days), owned by
Environment Governor + Core, decided and sequenced at slice 10 entry together
with ERL2-OQ-002 so brownfield archetypes and external substrates are designed
against the same framework. The interim path above is available now and does
not gate on this.
