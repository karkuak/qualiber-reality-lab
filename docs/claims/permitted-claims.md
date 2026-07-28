# Claims permitted by the evidence actually earned

Design v2 §25 fixes the claim ceiling for each release level. This file records
what the current implementation may and may not state. It is checked by review,
and the attestation schema mechanically restricts `claim_scope` to T1–T3.

## What may be claimed today

> The External Reality Lab V2 integrity, lifecycle and selection kernel is
> implemented. A fake no-op run reaches a valid pre-environment terminal,
> produces a closed `PublicVerificationBundleV2`, and verifies offline in a
> fresh process. A run that cannot satisfy a valid terminal freezes exactly one
> `InvalidLabRunRecordV1` after bounded cleanup and verifies offline without any
> attestation or bundle. The complete V2 selection chain — request, role audit,
> uniformly padded threshold-encrypted pool, pool checkpoint, single-source
> beacon round, Lab/verifier association wrapper, pinned source-trust
> verification, deterministic commitment, commitment checkpoint, threshold
> reveal, selected-only opening, binding checkpoint, proof and verification
> receipt — is implemented and independently re-derived by the verifier.
>
> Slice 6.5 adds the environment branch. A run driven entirely through the
> shipped CLI advances from `case_selected` to `generic_finalized` — reservation,
> provisioning, clean baseline, execution plan, the committed journey, challenge
> activation, traffic start, evidence cutoff, observation, canonical envelope,
> translation, subject-output freeze, reveal, evaluation, restoration, teardown,
> residue verification, validity, generic index and the environment terminal —
> and its `EnvironmentPublicVerificationBundleV2` verifies offline in a fresh
> process. A run whose environment fails freezes exactly one
> `InvalidLabRunRecordV1` after frontier-derived cleanup, with restoration and
> teardown failures routed through receipt-backed emergency cleanup.
>
> Every word of that is bounded by the scope below: **development tier, the fake
> environment driver, a trusted reference subject, non-blind selection.**

Slice 3 adds the environment driver interface, a deterministic fake driver, a
repeatable clean control, run-scoped resource isolation and the independently
derived resource frontier. Slice 4 adds the generic journey: split
subject-visible steps and age-x25519 encrypted judge expectations, measured
acquisition through package manifest, capture and evidence envelopes,
translation totality, and both early terminals — driven end to end through the
CLI.

Slice 5 adds the adapter platform. Two reference subjects — one correct, one
truthfully limited — are certified by `ADAPTER-CERT-V1` and drive the journey
out of process through the public `subject-adapter/v1` protocol, with core
owning the process boundary, the executable identity, the deadline and
process-tree termination, the frame bounds, the environment allowlist, the
read-only mount scan and tamper check, the capability, credential and egress
adjudication, the mutation/compensation ledger, and the bounded, scanned,
redacted output and diagnostics. A hostile adapter produces a typed adapter or
Lab finding and exactly one invalid terminal that verifies offline.

That is **engineering feasibility evidence for the integrity, environment,
journey and adapter kernels only**.

### Slice 6.5 — the environment branch, end to end

The one claim this slice earns, stated at exactly its width:

> A **development-tier** run against the **fake environment driver** with a
> **trusted reference subject** reaches an offline-verifiable environment
> terminal, and a failing one reaches an offline-verifiable invalid terminal.

- **A valid *environment* terminal may be claimed** — but only as above. The run
  is produced by the shipped commands in separate processes, its bundle verifies
  offline with the trust head and the randomness-source registry taken only from
  locally pinned configuration, and the derived closure reports zero missing roles
  and zero rejected extras.
- **Crash-resumability of the environment walk may be claimed.** Every one of the
  twenty-one phase boundaries has been interrupted and resumed from retained
  evidence, with exactly one of each once-only artifact however the run was cut.
- **"A refusal writes no evidence" may be claimed for the environment commands**,
  measured by full-tree byte manifest on a fresh run and again mid-path.
- **The mandatory emergency route may be claimed.** A restoration or teardown
  failure enters receipt-backed emergency cleanup: every independently safe action
  the frontier derived is attempted and receipted, every unsafe action skipped with
  a reason and no receipt.
- **Four oracle-canary surfaces are scanned live** — adapter request, Lab
  telemetry, mounted evidence entry, and subject output — and a canary planted in
  a subject's own output bytes refuses the run before anything freezes. Four
  surfaces remain unscanned and are named individually in
  `PENDING_ORACLE_SCAN_SURFACES`.

### Slice 6 — generic evaluation, terminal closure and finalization

- **Separate result planes may be claimed.** Lab validity, journey result and
  domain result are three different frozen contracts bound by
  `GenericEvaluationIndexV1`. No value in the system combines them, and
  `tests/architecture/evaluationBoundary.test.ts` asserts the index binds exactly
  those planes, the run policy and the join.
- **Deterministic generic metrics may be claimed.** Every metric is an exact
  integer computation over canonically ordered frozen inputs, rendered by
  `BigInt` long division to a fixed scale. Identical evidence produces an
  identical `result_identity_hash`. No prose similarity, model, ambient clock or
  randomness is on the path.
- **Discrimination between correct, limited, misleading and inconclusive
  reference subjects may be claimed.** It is measured through the public adapter
  protocol and the shipped operations pack, with no core branch naming a subject
  (`tests/integration/genericDomainEvaluation.test.ts`).
- **Deterministic fabricated-citation detection may be claimed.** A citation is
  checked by set membership against the frozen canonical evidence envelope.
- **Data-only pack authority may be claimed.** A pack is closed data with no
  code, filesystem, network, process, clock, randomness, mutation, validity or
  threshold member, and its certification scans for subject vocabulary,
  candidate tokens, shortcut predicates, forbidden inputs and generic-metric
  override.
- **Offline verification of a valid *pre-environment* terminal may be claimed.**
  A run driven entirely through the shipped CLI finalizes and its
  `PublicVerificationBundleV2` verifies in a fresh process with the trust head
  taken only from locally pinned configuration.
- **Complete retained-artifact accounting may be claimed** (ADR-ERL2-019). The
  offline verifier refuses any file retained beneath the artifact root that is
  not an indexed artifact, the freeze marker of one, a referenced descriptor
  path, or a declared content-addressed payload — including files the artifact
  index cannot parse (non-JSON bytes, strict-JSON refusals, JSON arrays, objects
  without a `core_hash`).
- **Complete signed-member verification may be claimed for the shipped terminals**
  (ADR-ERL2-019). Every retained artifact carrying a signature is verified
  against a *verifier-owned* expected signer role and signing domain — on the
  valid bundle and on the invalid record — and a retained signed contract for
  which the verifier declares no authorized role is refused. This is verified for
  the nine signed members of a pre-environment bundle and the six of an invalid
  record. Since Slice 6.5 it also covers the environment bundle's signed members
  and the selection chain's, each against a role declared in ADR-ERL2-020 §2,
  ADR-ERL2-021 §2 or ADR-ERL2-023.
- **A totally typed CLI surface may be claimed.** Every `erl2` invocation emits
  exactly one parseable envelope carrying a catalogued Appendix B code and
  `authority_scope: "lab_orchestration_only"`; no input produces an untyped exit
  or a raw stack trace.
- **"A refusal writes no evidence" may be claimed for the shipped commands.**
  Every post-terminal command is refused before any freeze and adds zero retained
  artifacts (ADR-ERL2-019 §4).

## What may NOT be claimed

- **No held-out or blind claim.** ERL2-OQ-007 is unresolved; no external beacon
  is qualified. Selection runs non-blind at `development` tier only.
- **No architectural-independence claim.** ERL2-OQ-003 is unresolved and no
  reference, OSS or opaque subject has been run through the core.
- **No robustness or brownfield claim.** Only the fake environment driver
  exists (ERL2-OQ-005).
- **No subject-quality claim of any kind.** The only subjects are the two
  reference adapters, which exist to exercise the platform. Certification
  permits an adapter version and digest; it says nothing about the quality of
  the subject behind it, and no real product has been run.
- **No OS-level or container isolation claim.** The only enabled sandbox profile
  is `local-process`. It genuinely enforces a separate process, process-tree
  termination, a wall-clock deadline, bounded request/response frames, a
  deny-by-default environment allowlist, bounded diagnostics, a single writable
  output path, read-only-mount tamper detection, and capability, credential and
  egress *adjudication*. It does **not** provide a read-only root filesystem, a
  numeric non-root user, dropped capabilities, no-new-privileges, a seccomp
  profile, PID/memory/CPU limits, a network namespace, kernel-enforced read-only
  mounts, or a kernel-level block on opening a socket or reading the operator's
  home directory. Every one of those is reported
  `unsupported_on_this_host` with a reason in each
  `SandboxInvocationManifestV1` and copied verbatim into every certification
  receipt. A same-user adapter process can still read what the operator can
  read; run untrusted subjects on a disposable machine.
- **No privileged-operation claim.** ERL2-OQ-001 is unresolved, so the audited
  privilege broker does not exist. Every privileged capability — root, host
  package management, host configuration, service registration, kernel modules,
  the Docker socket, loopback binding, reboot — is refused with
  `ADAPTER_PRIVILEGED_OPERATION_NOT_SUPPORTED` and the refusal is recorded.
  Unprivileged subject operations only.
- **No customer external validity, and no T4.** `FinalLabAttestationV1` cannot
  encode T4; a contextual T4 statement requires a separately verified
  `CustomerVerificationBundleV1` that does not exist.
- **No "bias-free", "collusion-proof" or "universal" language.** Design v2 §6
  forbids it unconditionally. Blind reports, when they eventually exist, must
  carry the literal residual-collusion limitation, which
  `BlindSelectionAssuranceV1` requires at schema level.
- **No claim that the beacon attested ERL data.** The beacon authenticates only
  its canonical round and output; the ERL association is a separate Lab/verifier
  signature.

### Slice 6 / 6.5 limits

- **No claim beyond the four-part bound.** The environment terminal above is
  development tier, fake driver, trusted reference subject, non-blind selection.
  It is evidence that the *mechanism* closes, not that any environment, subject or
  ecosystem was measured.
- **No real-ecosystem claim.** The environment is the deterministic fake driver.
  Its resources, probes and evidence sources are fixtures; no substrate was
  provisioned, no service ran, and the three "evidence sources" the observation
  captures produce zero records by construction. The Compose driver stays disabled
  (ERL2-OQ-005).
- **No robustness claim from the environment branch.** One archetype
  (clean-greenfield), one driver, one journey shape. Failure paths are reached by
  scripted driver faults, not by an environment that failed on its own.
- **No claim that the retained environment run is byte-reproducible.** It is not,
  and deliberately: every eligibility-pool entry is a threshold envelope whose key
  material comes from the CSPRNG. The pinned golden is the *shape* — ordered
  walk, closure roles and multiplicities, terminal variant and stage, verdict —
  not the bytes.
- **No subject-quality claim from an unsupported step.** Three of the journey's
  intents come back `unsupported` because the fixture adapter manifest does not
  declare them. That is a true statement about a declaration, not about a
  subject's capability.

- **No evaluated-domain claim from a real run.** `DomainResultEvaluatedV1` is
  implemented and exercised against real reference-adapter projections, but no
  run the CLI can complete produces one. `evaluateDomain` itself refuses without a
  revealed functional truth, and a development run reveals only journey-scope
  judge expectations, so every completed run produces
  `DomainResultNotApplicableV1` — `pre_environment_terminal` on the
  pre-environment branch, `functional_evidence_unavailable` on the environment
  branch. That is the honest outcome, not a score.
- **No deep-plane claim.** `DeepResultV1` is not implemented. Only its ancestry
  boundary is protected: no generic or base contract has a deep member.
- **No strong-isolation claim for opaque subjects.** ERL2-OQ-008 is still
  unresolved, but the reason has narrowed and the claim boundary must be stated
  precisely, because half of it is now earned and half is not.

  *What is earned:* a container substrate has been pinned by digest and probed,
  and all twenty required controls returned `observed` / `enforced`. The
  permitted claim is exactly this and no more, and it is a **self-reported**
  claim: **"on the host and lock recorded in
  `environments/isolation/substrate-lock.json`, the twenty controls in
  `REQUIRED_ISOLATION_CONTROLS` were observed holding by
  `erl2-container-enforcement-probes-v1`, as attested by the *development*
  environment-governor key."** The lock's signature now verifies (a corrupted or
  unpinned-signer lock is refused), but the signer is a repo-derivable
  development key, not a pinned qualification authority — so `erl2 doctor`
  reports the evidence as **`locally_observed_unauthenticated`**, never
  `authenticated` (review P2-1, 6R-E). The twenty probe *results* are themselves
  authenticated by a signed `isolation-probe-signing-manifest/v1` that covers
  their ordered core hashes (review §10.1): `authenticated` requires BOTH the
  lock and this manifest to be signed by a pinned authority, and a
  present-but-broken manifest forces `not_qualified`; on this checkout the
  manifest is dev-signed (`valid_development`), so the outcome stays
  self-reported. It is a claim about one runtime, one image digest and one
  security profile, checked before every run by `assertQualifiedForExecution`;
  on any other host, or after any drift, or if the lock or probe-manifest
  signature does not verify, the derivation returns `not_qualified`.

  *What is not earned:* no claim that an opaque subject has been contained, or
  could be. The Lab has **no launcher that can start an adapter inside the
  qualified substrate**, so nothing has ever run there. The container sandbox
  profile stays `disabled_no_container_adapter_launcher_pending_erl2_oq_008`,
  the adapter certification suite has not run under it, and every
  opaque-private and third-party subject is still refused. Trusted reference
  subjects continue to run under `local-process` with the limitations recorded
  above. See ADR-ERL2-017.

  A mocked probe harness still cannot qualify a profile, by construction:
  `fakeEnforcementProbes()` returns every control as `mocked`, and the
  probe-result contract makes `enforced: true` unrepresentable without
  `evidence: "observed"`.
- **No threshold authority claim for packs.** Generic metric thresholds are
  Lab-owned. A pack that ships its own definition for a reserved metric id is
  refused; a relaxed threshold is a different artifact with a different digest,
  not a mutation.

## Calibration status

Zero calibration runs. Design v2 §25 requires at least ten stable clean or
constrained runs before any release authority; that work belongs to Slice 11.
