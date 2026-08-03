# Claims permitted by the evidence actually earned

Design v2 §25 fixes the claim ceiling for each release level. This file records
what the current implementation may and may not state.

Since ADR-ERL2-025 it is no longer only checked by review. `claim_scope` is
**derived from the run's own retained evidence** and re-derived independently by
the offline verifier, so the ceiling this file describes is the ceiling the
binary emits. `--claim-scope` survives as a requested *upper bound*: a request
above the derived ceiling is a typed refusal
(`POLICY_CLAIM_SCOPE_EXCEEDS_EVIDENCE`) before anything is signed, and an
attestation carrying a scope above the ceiling an offline reader derives is
refused at verification. The attestation schema still mechanically restricts
`claim_scope` to T1–T3, and T4 remains unrepresentable.

**Every terminal this build can produce derives T1**, held there independently by
six components: development tier, non-blind selection, the fake environment
driver, no qualified containment report, an unevaluated domain plane, and nine
journey-plane metrics whose weakest declared ceiling is T1. A seventh —
regression evidence — caps at T2 because the historical-reproduction contracts
design §26 and plan §18 require belong to slice 12 and do not exist, which is why
**T3 is structurally non-emittable** rather than merely unclaimed.

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
- **Crash-resumability may be claimed for a subject step and for challenge
  activation, across real process death.** Since ADR-ERL2-028 each of eight named
  durability boundaries is exercised by ending the executing `erl2` process with
  `SIGKILL` and resuming in a genuinely new one, and external invocations are
  counted from a **file written before and after each call**, so the count survives
  the process that made it.

  It may **not** be claimed for `provision`, `restore`, `destroy` or the emergency
  actions. Those keep the coverage ADR-ERL2-024 gave them — reconciliation against
  observed state before any retry, measured in-process — and the eight boundaries
  are not run for them.

  The earlier form of this claim, which cited a suite that injected no crash, is
  withdrawn: an injected *exception* unwinds through every `finally`, so it never
  reached the stale-lease path, the unreproducible-receipt path or the
  terminal-less-ambiguity path, all three of which were live defects
  (`remediation-6.5-lifecycle-ordering.md` §4).
- **Three exactly-once categories, and they may not be combined.**
  - *Invocation-level exactly once* — external invocation count measured at one —
    may be claimed for **challenge activation** at all eight boundaries, and for a
    **subject step** at the three boundaries where the evidence is decisive
    (nothing declared, the intent proves nothing was dispatched, or the outcome is
    already frozen). Also for the other driver operations at the boundaries
    ADR-ERL2-024 measured.
  - *Evidence-backed idempotent reconciliation* — the transport may repeat while
    the logical effect does not — is **not** claimed anywhere. No tested path
    reaches a second transport invocation.
  - *Fail-closed ambiguous outcome* is the honest description for a **subject
    step** at the five remaining boundaries. No second invocation, the ambiguity is
    retained, and the run reaches exactly one invalid terminal whose
    `failed_phase.kind` is `journey_execution` and whose owner is the **Lab**, not
    the subject.

  One of those five is a *conservative* refusal and is not counted as an
  exactly-once win: at `before_external_dispatch` the subject was not called, and
  the run still fails closed, because the `dispatching` marker is durable before
  the call and the evidence cannot separate "about to call" from "called and died".
- **"A refusal writes no evidence" may now be claimed for the environment
  commands**, measured by a full-tree byte manifest over the run root **and both
  operational siblings**, including directory entries, across representative
  refusal causes. P1-10 is closed: a refused `journey` freezes no cutoff policy,
  and a refused command no longer creates `<run-root>.substrate` or
  `<run-root>.reservations`. The two documented exceptions are the bounded run
  lease and the derived snapshot, both excluded from every closure derivation by
  construction.
- **Every canonical journey intent may be claimed to enforce its own
  prerequisites.** All fourteen have an explicit row keyed by the frozen contract's
  own intent union, enforced at the library boundary from **retained evidence**
  rather than from the departure state, so a post-capture intent refuses before
  activation and before the evidence cutoff wherever it is invoked from. The
  offline verifier re-derives the same ordering from the hash-chained event stream.
- **Cancellation may be claimed to be dispatched from the run's own durable
  evidence.** Two independent witnesses, `ENOENT` as the only absence, a typed
  refusal for anything else, and a classifier shared by the CLI and the library. A
  live or partially provisioned environment cannot receive a pre-environment
  cancellation terminal, and a cancellation that interrupts a cleanup continues it
  rather than restarting it under a relabelled trigger.
- **The substrate a cleanup verdict was observed against may be claimed to be the
  one the run provisioned into.** `SubstrateBindingV1` is frozen before the first
  substrate-affecting dispatch, checked by every later phase before it dispatches,
  and re-derived offline. Redirecting a later phase at a fresh or foreign
  substrate is a typed refusal before any cleanup evidence freezes. This closes
  the review's P0-1: before it, a run could be torn down and finalized against an
  empty directory and the resulting bundle verified at exit 0.
- **One cleanup discipline may be claimed for every invalid environment
  terminal.** Every failure phase — not only restoration and teardown — freezes
  its frontier before it acts, attempts every independently safe action
  **individually** and receipts each attempt, and skips every unsafe action with
  a reason and no receipt. A foreign or shared resource fails or skips exactly its
  own action rather than aborting the branch, and a run that meets one still
  reaches exactly one invalid record. A whole-environment dispatch happens only
  when the driver offers no narrower granularity and every observed frontier
  member is an authorized target. Before ADR-ERL2-027 this held on the emergency
  branch only: the other five phases issued an unconditional whole-environment
  destroy over a frontier they had just frozen and never read, which destroyed
  resources that frontier had classified `contain_residual` and aborted outright
  on a foreign one (review P1-1, P1-5).
- **The post-cleanup residue may be claimed to rest on an observation rather than
  on the producer's own account of what it did.** The substrate is re-observed
  after the last dispatch and a `CleanupResidueProbeV1` retains that observation
  beside the pre-action frontier and the derived authorized-target set, so an
  offline reader recomputes both what survived and what left without
  authorization. A fabricated empty residue and a resource that vanished with no
  authorized action against it are typed refusals. It may **not** be claimed that
  the Lab takes an independent census of the substrate: the observation is the
  driver's `inspect`, and what the Lab owns is that its record agrees with what it
  observed at two separate moments. A consistently lying driver remains
  undetectable, and nothing retained by one process can change that.
- **The invalid terminal's finding may be claimed to name what actually failed.**
  The gate it cites is a total, deterministic function of the run's own failure
  phase, re-applied offline to the record's own `failed_phase`; it is Lab-owned
  with no subject attribution and no scoreable plane; and it is frozen before the
  frontier, so a cleanup that then fails adds evidence and never replaces the
  cause. Before this the gate was chosen by *cleanup branch*, so a provisioning
  failure cited a baseline gate the run never evaluated (review P1-3).
- **Branch-specific cancellation may be claimed.** `erl2 cancel` routes on the
  run's own evidence: a run holding an environment enumerates its actual frontier
  and can never record cleanup as `not_required`.
- **Offline verification of environment validity and cleanup may be claimed to be
  independent.** The verifier re-derives the validity verdict, the restoration and
  teardown outcomes and the cleanup action set from retained bytes — on **every**
  invalid environment terminal since ADR-ERL2-027, where it previously returned
  early on any non-emergency variant (review P1-6) — and refuses a producer field
  that disagrees with them. It may **not** be claimed that the
  verifier re-runs every Lab validity *gate*: several read evidence a public
  reader does not hold, so what is checked is that the retained gate set is
  self-consistent and corroborated by the retained findings.
- **Restoration may be claimed to rest on an observation rather than on a
  receipt.** The substrate is read for its applied-mutation set immediately
  before the compensation and again immediately after it, and the verdict is the
  difference; a `RestorationProbeV1` retains both observations, the mutation set
  the compensation was declared to revert, and the outcome derived from them.
  A compensation that returns `succeeded` and reverts nothing is a typed refusal
  (ADR-ERL2-026, review P1-4). Before this, restoration was derived from the
  before/after baseline fingerprints, the residual resource set and the receipt's
  own status — none of which can see a mutation — and "reverted nothing" and
  "had nothing to revert" produced byte-identical terminals. It may **not** be
  claimed that the Lab takes an independent census of the substrate: the
  observation is the driver's, and what the Lab owns is its correspondence to the
  Lab's own retained mutation receipts.
- **The claim scope may be claimed to be derived rather than asserted.** It is
  computed from the terminal variant, the challenge tier, the selection
  assurance, the driver kind and substrate lock, the containment qualification,
  whether the domain plane was evaluated, every applicable metric's declared
  ceiling and hard-safety threshold, and the presence of regression evidence —
  as a monotonic minimum in which no component can raise another's ceiling and
  missing evidence never raises. It may **not** be claimed that this widens
  anything: it removes a claim the evidence never supported and adds none
  (ADR-ERL2-025).
- **Three oracle-canary surfaces are scanned live *and proven***, and the fourth
  is recorded as shadowed rather than counted (ADR-ERL2-032). Since Step 6B a
  surface may be called live only when a shipped run refuses on it and a negative
  control proves that refusal is load-bearing; the previous form of this claim
  counted four on the strength of a coverage test that proved only that the
  *scanner* recognises a target labelled with each surface.

  - **`mounted_file`** — the exact bytes of every file the Lab publishes into the
    adapter-visible tree are scanned **before the file exists**, and the published
    bytes are then verified against the bytes that were scanned. A mount whose
    descriptor, commitment and adapter request are all clean and whose *content*
    carries a canary is refused before dispatch, and nothing is written. It could
    **not** be claimed before: the scan read `JSON.stringify(entry)` over an id, a
    state and two digests, so no leak in mounted content could appear in it.
  - **`lab_telemetry`** — one scanner, called before any source snapshot is
    retained and again over the snapshots the observation bundle is built from. A
    canary in an admitted evidence-source id refuses `observe` with no snapshot
    frozen and nothing derived. The scan was already live and correct; what was
    missing, and is now present, is a production-path regression and a control
    that kills it.
  - **`subject_output_prefill`** — unchanged, and deliberately still the sole
    owner of the judge-canary rule on the subject-output surface.
  - **`adapter_request`** — live, and **shadowed**. Every request field that could
    carry a token is a hash, an id or the visible-step path, and that step's own
    bytes are now refused as a `mounted_file` one call earlier. No shipped input
    reaches it, so no control can kill it and it is not counted. This is a
    consequence of fixing the ordering, and the better trade: the alternative was
    to keep publishing the leaking mount and then refuse the request naming it.

  Four surfaces remain unscanned and are named individually in
  `PENDING_ORACLE_SCAN_SURFACES`.
- **A refusal may be claimed not to republish what it refused.** A scan label is
  built from run data, and where the leak lives in that identifier the refusal
  message used to reprint the exact token into stderr and the CLI envelope. Every
  new evidence-boundary regression asserts the whole envelope is free of the token
  it planted.
- **The evidence cutoff may be claimed to be re-derived offline, exactly.** Since
  ADR-ERL2-029 the verifier resolves all three cutoff inputs by exact hash *and*
  schema, requires the runtime milestone to bind the process-start receipt the
  **cutoff** names, requires both to be lifecycle-reached and run-bound, and
  re-checks clock-domain agreement, wall/monotonic divergence and
  process-milestone skew.

  ADR-ERL2-031 adds the value that made the rest bounds-exact rather than exact.
  Before capture, the run freezes a signed `evidence-window-commitment/v1`
  carrying the **exact** warmup and observation durations, sealed under
  `policy_author` — the authority that already bounds the window in
  `cutoff-policy/v1`, and deliberately not either of the two roles that stamp the
  clocks the derivation is anchored on. The offline verifier resolves it by hash,
  authorizes its signer under its own role table, checks its run, cutoff-policy,
  process-start, clock-domain and observation bindings, requires it to be
  lifecycle-reached and to precede the capture it governs, and then recomputes in
  integer arithmetic:

  - `cutoff.instant === process_started_at + warmup_ms + observation_ms`;
  - `milestone.occurred_at === process_started_at + warmup_ms`;
  - the observation bundle's window, and every source snapshot's.

  **The residual ADR-ERL2-029 §3.2 recorded is closed.** A producer that moves the
  window *within* the committed bounds and moves its milestone with it is now
  caught, because the durations are signed bytes hash-bound into the terminal
  chain and the shift contradicts them rather than leaving no trace. An
  observation bundle naming a **nonexistent** runtime milestone was valid before
  ADR-ERL2-029; a within-bounds shifted window was valid before ADR-ERL2-031. Both
  are typed refusals.

  It may **not** be claimed that this stops a fully authorized `policy_author`
  from committing a different window on purpose. The commitment proves that a
  window was fixed under an authorized key before capture and that every later
  instant matches it exactly — **not** that the window was the right one. Which
  windows are permissible is the cutoff policy's bounds; who may commit one is the
  trust policy's. What changed is that the choice is now on the record and signed,
  where before it was a module constant that left no trace at all (ADR-ERL2-031
  §3.4).

  It may **not** be claimed that key custody is demonstrated. The development
  composition holds the `policy_author` key in the same process as the run, as it
  already does for the governor, controller, supervisor and attestor keys.
  Separating custody is a deployment property this profile does not exhibit.
- **Subject-output payload bytes may be claimed to be completely accounted, in
  both directions.** Every declared payload must exist as a regular file inside
  the authorized payload root, match its declared length and digest exactly, and
  be declared exactly once; and every file in that root must be a declared payload
  or the freeze marker of one. Before this the payload root was outside the
  `retained/` accounting subtree entirely, and a *missing* declared payload was
  silently skipped, so both an absent payload and an undeclared extra verified at
  exit 0 / `valid`.

  ADR-ERL2-029's payload accounting is byte correspondence against descriptors,
  and the two producer-side gaps it recorded as open are **closed by
  ADR-ERL2-032**:

  - **Retained subject-output payload bytes may be claimed to be scanned for
    secret canaries and forbidden identifiers**, over the same definitions the
    adapter host's output and diagnostics paths already enforce, before the
    subject-output manifest freezes. Both refusals are Lab-owned evidence-boundary
    invalidity, never a subject finding. Matching is byte-wise: a token
    surrounded by invalid UTF-8 is still found.
  - **The declared subject-output byte ceiling may be claimed to be enforced
    against the bytes the subject actually produced.** The limit is the run's own
    `SubjectExecutionPlanV1.limits.output_bytes` — the value hashed into every
    step request's `resource_limit_hash`, not an adapter frame bound, a
    diagnostics bound, a file count, a path depth or a flag. Bytes are counted
    from the payloads read back from the store, per occurrence, with no decoding;
    a payload one byte over is refused before the manifest freezes and a payload
    exactly at the ceiling is admitted. Both halves are measured end to end
    through the shipped CLI at the real 64 MiB ceiling, not at an injected one.

  It may **not** be claimed that these scans see anything the subject chose not to
  return. They govern the bytes the run retains, which is what the ceiling and the
  partition are about; a subject that withholds output withholds it from the
  evidence too, and that is a separate, already-recorded limit.
- **The mandatory evidence gate may be claimed to verify invalid goldens
  semantically.** `evidence:verify` now invokes the real offline invalid-record
  verifier in a fresh process for every invalid-run golden and requires exit 0 and
  a derived closure verdict of `valid`, with the fixture list enumerated from the
  directory and its count asserted. Previously those exit codes were recorded only
  in `cli-transcript.json`, the single file excluded from the byte pin, so a
  verifier regression against invalid records — which changes no producer bytes —
  left the gate green.
- **Signer-inventory completeness MAY now be claimed, in both directions**
  (ADR-ERL2-030). The producer derives the applicable signed-member set from the
  retained evidence and refuses to seal an inventory it cannot certify; the
  offline verifier derives the expected set *independently*, from its own role
  table and the authority field each frozen schema declares, and compares it with
  the retained inventory bijectively. `complete_for_terminal_chain` is **never
  read as evidence** — an inventory that omitted a member while asserting
  completeness is refused by the derivation, not by disagreeing with a boolean.
  Measured before and after, on terminals that all asserted completeness:
  `valid-pre-environment-run` 7 applicable / **1** listed → 7; the CLI-produced
  pre-environment goldens 7 / **6** → 7; a CLI-produced environment terminal 63 /
  **61** → 63. The two the producer had never listed were exactly the two whose
  authority field is not named `signature`: the mirrored trust root
  (`root_signature`) and the beacon association wrapper (`wrapper_signature`).
- **What completeness does NOT claim.** It is a statement about the *set* of
  signed members and about each member's schema, key, signature binding, role
  authorization, run scope and lifecycle reachability. It is not a statement about
  what those members say. Two contracts — the trust policy manifest and the
  terminal timestamp checkpoint — are exempt from lifecycle reachability by name,
  because neither is produced by any lifecycle event; both are bound to the
  terminal by hash instead, and the exemption is pinned by an architecture test.

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
- **No robustness or brownfield claim.** Two drivers exist — the fake one and the
  Compose one qualified under ERL2-OQ-005 — but one archetype
  (clean-greenfield), one two-service substrate and one journey shape are not
  robustness evidence, and no brownfield or constrained archetype exists
  (ERL2-OQ-002).
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
- **No T2 and no T3.** Not as a matter of restraint but of derivation
  (ADR-ERL2-025 §5). A Compose run on the qualified OQ-005 substrate does raise
  the *environment-realism* component to T2 — that component is what "a real,
  enabled driver on a qualified substrate lock" means, and it is now satisfiable.
  The **ceiling is the weakest applicable component**, and two others still cap
  at T1 on every run this repository can produce: the selected case is drawn at
  `development` tier and selection is non-blind, both pending ERL2-OQ-007. T3
  additionally needs historical-reproduction evidence whose contracts belong to
  slice 12 and do not exist. Requesting either is a typed refusal in the producer
  and in the offline verifier.
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
- **No real-ecosystem claim.** The default environment is the deterministic fake
  driver, whose resources, probes and evidence sources are fixtures. The Compose
  driver (ERL2-OQ-005) does provision a real substrate — two containers of
  OpenTelemetry Demo `3.0.0`, real OTLP telemetry observed at a real collector —
  and that is still not an ecosystem: two services out of twenty-two, one
  archetype, one endpoint, one request. It is evidence that the *driver* reaches
  a real substrate, never that any ecosystem was measured. The substrate lock is
  signed by the repository's own development governor key, so no independent
  qualification may be claimed from it either.
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
- **No claim that a golden's own verification outcome is pinned.** The exit codes
  of the `verify-record` and `verify` calls the evidence harness makes are
  recorded only in `fixtures/golden/cli-transcript.json`, which is **excluded**
  from the byte pin because it carries absolute CLI paths. ADR-ERL2-027's work
  broke the `invalid-run-emergency-cleanup` fixture badly enough that its
  verification began failing with `INVALID_REASON_PHASE_MISMATCH`, and
  `evidence:verify` still reported OK. The fixture is repaired and the codes are
  now asserted by named tests, but the *pin* does not cover them and a future
  change can move them silently. Recorded as an open gap rather than closed.

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
