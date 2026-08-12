# ADR-ERL2-036 — an external adapter is admitted on its certification receipt, and `adapter-certified` is derived from it

- **Status:** accepted
- **Date:** 2026-08-11
- **Supersedes:** nothing. Extends ADR-ERL2-014 (adapter identity) and follows
  the split ADR-ERL2-017/034 drew between a content verdict and its
  authenticity.

## Context

The first bounded live Reality Lab dry run stopped before preregistration with
`BLOCKED — NO SUPPORTED LIVE ADAPTER ADMISSION PATH`. Reproduced on settled
`main`:

- `certifyAdapter` produced a `SubjectAdapterCertificationReceiptV1`, and
  **nothing consumed one**. The contract was registered (ERL2-C-125), the
  harness shipped, and the receipt had no reader.
- `AdmissionRegistry` indexed any core-hashed JSON, with no adapter-receipt
  workflow.
- `preregisterAcquisition` required only `SubjectAdapterManifestV1`.
- The live external-adapter path (`subjectPort`) resolved only the manifest
  before constructing `AdapterHost`.
- Both validity paths emitted a literal
  `{ gate_id: "adapter-certified", passed: true, evidence_refs: [adapterHash] }`.

So an adapter could be represented as certified with no evidence that its
receipt existed, described those bytes, or passed. That is a false-attestation
path, recorded as `LIVE-001 — P1 — REALITY_LAB_DEFECT`, with the onboarding half
as `LIVE-002 — P2`.

A second hole was found while tracing it, and is closed here: `AdapterHost`
computed `executableDigest` and wrote it into every
`SandboxInvocationManifestV1`, but **never compared it to anything**. The entry
file could be replaced between admission and dispatch, and the host would
execute the new bytes and faithfully record their digest under the old
manifest's identity.

## Decision

### 1. The authoritative linkage is receipt → manifest

`receipt.adapter_manifest_hash` is the manifest's `core_hash`, written by
`certifyAdapter` itself. Admission requires it. It is settled, shipped and
acyclic.

The reverse linkage is **not** required, because it cannot exist. A manifest's
`core_hash` covers its `certification_receipt_hash`, and the receipt's identity
covers the manifest's `core_hash`. A manifest naming the receipt that certifies
it is a hash fixed point, not a reference.

`certification_receipt_hash` is therefore a **prior or bootstrap** reference:
the all-zero sentinel when an adapter has never been certified before.
Admission classifies it (`bootstrap_no_prior_receipt` /
`prior_receipt_not_resolved`), does not resolve it, and never reports it as
verified.

No refusal is written for the cycle. A document exhibiting it cannot be
constructed, and the recomputation of both `core_hash` values rejects any
attempt as a hash mismatch before the classification runs. A check no test can
reach is documentation wearing a check's clothes, and the Lab's convention is
that fail-closed states are executable.

This is the one place the pack precedent does not transfer. `bindDomainPack`
*does* require `manifest.certification_receipt_hash === receipt.core_hash` — but
a pack receipt names the pack **body**, never the pack manifest, so that
triangle is acyclic and the adapter one is not.

### 2. Certification, authentication and admission policy are three facts

Modelled exactly as `isolationAuthenticity` models the substrate, and named to
match so a reader meets one vocabulary:

| Fact | Question | Where |
|---|---|---|
| Certification | contract-valid, core-hash-valid, bound to this manifest and these bytes, in scope, verdict `certified`? | `verifyAdapterCertification` |
| Authentication | did an authorized certifier's signature cryptographically verify? | `verifyReceiptSignature` |
| Admission policy | may *this tier* run on *that* combination? | `assertAdmissionPermittedForTier` |

`CertificationAuthenticity` is `not_certified` /
`locally_observed_unauthenticated` / `authenticated`. Only a **pinned**
authority's verified signature reaches `authenticated`.

Collapsing any two would reintroduce the defect in a new shape: an unsigned but
genuinely certified development adapter would become indistinguishable from a
forged one.

### 3. The tier decides, and no flag overrides it

| Tier | Unsigned / unverifiable | Authenticated |
|---|---|---|
| `development` (unscored) | admitted as `locally_observed_unauthenticated`; no scored, blind or authenticated claim derivable | admitted |
| `held_out`, `blind` (scored) | refused — `ADAPTER_CERTIFICATION_AUTHENTICATION_REQUIRED` | admitted |

A present-but-unverifiable signature — wrong signed hash, unpinned signer, or a
zero-filled placeholder — is `not_certified` at **every** tier, including
development. It is worse than no signature: absent evidence is honest, forged
evidence is not.

There is deliberately no `--allow-unsigned`. The development allowance derives
from the selected tier. A bypass flag would be exactly the escape hatch that
makes a scored policy advisory.

This is stricter than ERL2-OQ-007 needs today — which refuses `held_out` and
`blind` outright — and that is the point. When OQ-007 lifts, this gate is
already standing.

### 4. Admission is a public command, and retention is atomic

`erl2 admit-adapter --registry --adapter-manifest --certification-receipt
--adapter-entry [--tier]` validates all three inputs together, then publishes
the manifest and receipt into `<registry>/external-adapters/<manifest-hash>/`.

Both artifacts land or neither does: they are staged in a temporary directory
and moved with a single `rename`. A registry holding a manifest whose receipt
never arrived is precisely the half-admitted state the defect made
indistinguishable from a certified one.

Everything is validated **before** the registry is touched, so a refusal leaves
no partial mutation.

### 5. The subject seam and the current receipt are frozen at preregistration

The first version of this decision bound the receipt only when a command
happened to carry `--adapter-entry`. The independent review of `e9718e0` showed
what that leaves open: a run preregistered *without* an adapter recorded nothing
saying so, and later commands could introduce a real adapter and authorize
receipt A on one command and receipt B on the next, with neither inside the
frozen boundary.

`AcquisitionPreregistrationV1` therefore carries two new members:

- `subject_execution_mode` — `development_fake_port` or `external_adapter`,
  required;
- `adapter_certification_receipt_hash` — the exact **current** receipt, present
  if and only if the mode is `external_adapter`, and forbidden otherwise, so
  "no adapter certification" cannot be confused with "certification omitted".

Both are inside the preregistrar's signature and the hash-chained lifecycle, so
the binding survives process exit, a fresh command, recovery and replay. CLI
memory never decides it.

`assertSubjectModeUnchanged` is the single authoritative enforcement point. A
fake-port run refuses a later `--adapter-entry` and a later
`--adapter-certification`; a real run refuses to run without its entrypoint,
because omission would otherwise downgrade it to the fake port. The receipt is
resolved **only** from the frozen field; a later flag must match it exactly or be
absent, and can never replace it.

The one moment the flag decides is preregistration itself, where no binding
exists yet — and that is why the pre-host `verifyAdapterCertification` call is
still load-bearing rather than redundant: the subject port constructs the host
before the workspace validates, so without it an uncertified receipt would build
a host. Every *later* command is answered by the binding alone. There are not
two independent defenses here, and this ADR does not claim any.

### 5a. `adapter-certified` applies only to a real adapter

`deriveAdapterCertifiedGate`:

- `development_fake_port` → the gate is **omitted entirely**. Not applicable, not
  passed. `requiredGateIds` drops it from the required set for that mode, exactly
  as `PRE_ENVIRONMENT_GATE_IDS` already omits the environment and selection gates
  on a run that reached neither.
- `external_adapter` with a certification that re-validates → **passed**, and the
  evidence always names the receipt.
- `external_adapter` otherwise → **failed**.

`passed: true` is now reachable only from a validated retained receipt. The
previous "vacuous pass on manifest-only evidence" was a certification claim
wearing a boolean, which is what the review rejected.

### 5b. Failure evidence names the receipt that authorized execution

`AdapterFailureV1.certification_receipt_hash` was populated from the *manifest's*
`certification_receipt_hash`, which is a bootstrap/prior reference — so the
hostile golden recorded the all-zero sentinel while its real authorizing receipt
was nonzero. It now comes from the frozen preregistration binding. An
`external_adapter` failure with no retained current receipt fails closed rather
than falling back; a fake-port failure carries the bootstrap sentinel, because
there is genuinely no adapter certification, and manufacturing one would be the
same lie in the other direction.

The three references are distinct and are used distinctly:

| Field | Means |
|---|---|
| manifest `certification_receipt_hash` | a **prior/bootstrap** receipt, unresolved |
| receipt `adapter_manifest_hash` | the manifest this **current** certification covers |
| preregistration `adapter_certification_receipt_hash` | the **current** receipt authorizing *this run* |
| finding `certification_receipt_hash` | the current receipt that authorized the **failed execution** |

### 6. Deterministic substitution detection — and what it is not

`AdapterHost` takes the certified artifact digest and re-reads the entry before
**every** dispatch, using the `executableDigest` it already computed rather than
a second freeze mechanism. Admission hashes the bytes once; the host re-hashes
them on each operation, before anything is spawned.

**The guarantee, stated exactly.** Under normal local-process operation, a
*deterministic* post-admission replacement of the adapter entry — an overwrite
at the same path, or a retargeted symlink — is detected before the next dispatch
and refused with `ADAPTER_IDENTITY_MISMATCH`. Both cases are proven by
`tests/adversarial/adapterModeBinding.test.ts`, which observes that the
substituted adapter never executed rather than that a helper returned an error.

**What this is not**, corrected from the first draft of this ADR, which claimed
the implementation "cannot execute different bytes":

- It is **not** atomic execution of frozen bytes. `host.ts` hashes a *path*,
  other work happens, and the same mutable path is later handed to the launcher.
  There is a window between the check and the spawn.
- It is therefore **not** protection against a malicious same-user adversary who
  races that window. Nothing here closes a check-to-use race.
- It is **not** container or kernel isolation, and it does not change the
  `local-process` profile's thirteen unsupported controls.
- It is **not** authenticated certification. No certifier authority is pinned on
  this checkout.

That residual race sits outside the local-process threat model, which treats a
trusted reference subject as a bug rather than an adversary (ADR-ERL2-016,
`assertSubjectMayRunUnderProfile`). It is recorded here rather than implied
away, and closing it would need an immutable file descriptor or an image-backed
execution path — deliberately out of scope for this package.

## Consequences

### The reference adapters are certified, and their evidence changed

The two dispatchable reference adapters are now certified by the same
`ADAPTER-CERT-V1` suite any external adapter must pass, and their receipts are
admitted alongside their manifests. Their manifests previously declared a
synthetic `adapter_artifact_hash` derived from the adapter id, which no longer
suffices: an admitted manifest must name the digest of the file that really
runs.

That legitimately changes the three `fixtures/golden/adapter-platform/` runs and
was regenerated through `evidence:update`.

The `hostile-adapter` fixture keeps demonstrating what it always did. An earlier
draft of this ADR said it had become an identity mismatch; that is wrong, and
the generator, ledger and golden all disagree with it. The sabotage timeout
fixture is admitted on a certified receipt over **its own** real bytes, so the
run is legitimate right up to dispatch and the refusal that follows is the
deadline — `ADAPTER_DEADLINE_EXCEEDED`, adapter-owned, with an invalid-run
record. Certification is not a promise of good behaviour, and the fixture says
so directly.

What that golden proves, precisely: the timeout/failure shape, adapter
ownership, and that a grandchild process was *spawned* (the retained PID). It
does **not** prove process-tree termination — no independent post-kill liveness
receipt is retained, so the PID is evidence of emission, not of death. Termination
is proven directly by `tests/adversarial/adapterHost.test.ts`, and that is the
only place this repository may cite for it.

### Bundled adapters keep their established rules

The development fake port executes no adapter bytes, so it has nothing to
certify and binds nothing. It passes `adapter-certified` vacuously and its
evidence does **not** name a receipt, so no reader can mistake it for a
certified adapter. `reference-otel-demo` is unchanged: the environment branch
does not dispatch it through this path.

### Verifier closure

`subject-adapter-certification-receipt/v1` is added to both closures'
`SUPPORTING_SCHEMAS`. The retained receipt is evidence a reader re-derives
certification from, not a separately roled terminal output.

An **unsigned** receipt is retained today. A signed one would need a
`SignedMemberRule`, and there is no `adapter_certifier` signer role — mapping it
to `adapter_owner` would assert the opposite of the independence the receipt
exists to prove. Introducing that role belongs with the pinned certification
authority it implies, and is deferred with the rest of §3's scored path.

## What this does not do

- It does not create key management, a certification authority, or a
  certificate chain. `authenticated` is reachable only when a caller supplies a
  pinned authority, and no such authority is pinned on this checkout.
- It does not make the Lab's onboarding one or two commands. Governor registry
  preparation, challenge admission, policy authorship and the r5 artifact drop
  remain manual. It removes one specific blocker.
- It does not change `adapter-authority-respected` or any unrelated gate.
- It resolves neither B-129 nor B-130.
