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

### 5. The live path binds the receipt, and the gate derives from it

`preregister-acquisition` requires `--adapter-certification HASH` whenever
`--adapter-entry` is present, re-validates it against the manifest the run is
binding — a registry is a directory, and a directory can be edited between two
commands — retains it at `retained/adapter-certification-receipt.json`, and
records the `adapter-certification-receipt` role in the lifecycle. Later
commands read the retained receipt, so no flag can substitute a different
certification mid-run.

`adapter-certified` is now derived by `deriveAdapterCertifiedGate`:

- certification bound and still re-validating → **passed**, evidence names the
  **receipt** and the manifest;
- certification bound but no longer re-validating → **failed**;
- a real adapter dispatched with no certification → **failed**;
- no adapter bytes dispatched at all (the development fake port) → **passed
  vacuously** on the manifest, the same shape
  `attributable-telemetry-retained` uses for a run that never declared
  telemetry.

"Dispatched a real adapter" is read from the `adapter-sandbox-invocation-manifest`
artifacts the host freezes, so it answers what happened rather than what was
configured.

### 6. Time of check is not time of use

`AdapterHost` takes the certified artifact digest and re-reads the entry before
**every** dispatch, using the `executableDigest` it already computed rather than
a second freeze mechanism. Admission hashes the bytes once; the host re-hashes
them on each operation, before anything is spawned. Replacing the entry after
admission cannot execute different bytes under the admitted certification.

## Consequences

### The reference adapters are certified, and their evidence changed

The two dispatchable reference adapters are now certified by the same
`ADAPTER-CERT-V1` suite any external adapter must pass, and their receipts are
admitted alongside their manifests. Their manifests previously declared a
synthetic `adapter_artifact_hash` derived from the adapter id, which no longer
suffices: an admitted manifest must name the digest of the file that really
runs.

That legitimately changes the three `fixtures/golden/adapter-platform/` runs and
was regenerated once through `evidence:update`. The `hostile-adapter` fixture
changes what it demonstrates: pairing `reference-correct`'s certified manifest
with different bytes on disk is now caught *before* the adapter is spawned, so
its refusal is an identity mismatch rather than a deadline. That is the stronger
outcome and it is the point of §6 — but the runtime deadline and process-tree
termination path is no longer covered by a golden, and remains covered by
`tests/adversarial/adapterHost.test.ts` and `tests/e2e/adapterJourney.test.ts`.

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
