# Remediation — LIVE-001: receipt-aware external-adapter admission

Answers the P1 finding from the first bounded unscored live dry run, preserved
in [`docs/evidence/live-001-unscored-live-dry-run-20260811T031410Z/`](../evidence/live-001-unscored-live-dry-run-20260811T031410Z/README.md).
The decision is ADR-ERL2-036.

## 1. What was wrong

`certifyAdapter` produced a `SubjectAdapterCertificationReceiptV1` that nothing
consumed. Traced in source, before any change:

| Stage | Before |
|---|---|
| CLI | no admission command; `--certification-receipt` was `CFG_UNKNOWN_FLAG` |
| registry | `AdmissionRegistry` indexed any core-hashed JSON; no adapter-receipt workflow |
| preregistration | required `SubjectAdapterManifestV1` only |
| subject port | resolved the manifest, then built `AdapterHost` |
| host | computed `executableDigest`, recorded it, **compared it to nothing** |
| validity | `{ gate_id: "adapter-certified", passed: true, evidence_refs: [adapterHash] }`, literal, in two places |

So an adapter was reported certified on the strength of its own manifest. The
receipt need not have existed.

The host hole is the one the finding did not name and this change also closes:
the entry file could be swapped between admission and dispatch, and the host
would execute the new bytes and faithfully record their digest under the old
identity.

## 2. What it is now

| Stage | After |
|---|---|
| CLI | `erl2 admit-adapter --registry --adapter-manifest --certification-receipt --adapter-entry [--tier]` |
| registry | manifest + receipt published atomically under `external-adapters/<manifest-hash>/` |
| preregistration | `--adapter-certification HASH` required whenever `--adapter-entry` is present; re-validated, retained, roled into the lifecycle |
| subject port | certification decided **before** `AdapterHost` is constructed |
| host | re-reads and compares the entry digest before **every** dispatch |
| validity | `deriveAdapterCertifiedGate(...)`, evidence names the receipt |

Certification, authentication and admission policy stay three facts, named to
match `isolationAuthenticity`: `not_certified`,
`locally_observed_unauthenticated`, `authenticated`.

`development` may run on unauthenticated certification and is labelled as such.
`held_out` and `blind` require a pinned authority's verified signature. A
present-but-unverifiable signature — including an all-zero placeholder — is
`not_certified` at every tier. There is no `--allow-unsigned`.

## 3. The linkage question, and why it did not need a new schema

The receipt names the manifest (`adapter_manifest_hash`), written by the
harness. That direction is settled and acyclic, and it is what admission
requires.

The reverse cannot exist: a manifest's `core_hash` covers its
`certification_receipt_hash` and the receipt's identity covers the manifest's
`core_hash`, so a manifest naming its own certifying receipt is a hash fixed
point. `certification_receipt_hash` is therefore a prior/bootstrap reference,
classified and never resolved.

No contract changed. The receipt is already ERL2-C-125; the run retains it by
artifact role, the way every other retained artifact is bound, so
`registeredContractCount()` and the generated types are untouched.

## 4. Evidence that legitimately changed, and why

Receipt enforcement means a real adapter cannot be dispatched without an
admitted receipt. The three `fixtures/golden/adapter-platform/` runs did exactly
that, so they had to change; `evidence:update` was run **once**, at the final
executable commit, under the repository's normal deterministic workflow.

Two consequences worth stating plainly:

- The reference adapters' manifests previously declared a synthetic
  `adapter_artifact_hash` derived from the adapter id. An admitted manifest must
  name the digest of the file that really runs, so they now do — which changes
  their core hashes and everything downstream of them in those three runs.
- The `hostile-adapter` fixture is now admitted through a **certified** receipt
  over the sabotage fixture's own real bytes, rather than borrowing
  `reference-correct`'s manifest. Without that it would have collapsed into an
  admission refusal, and the deadline and process-tree-kill behaviour it exists
  to demonstrate would have stopped being covered by a golden. Certification is
  not a promise of good behaviour, and the fixture now says so directly: an
  adapter can be legitimately admitted and still hang.

Nothing outside `fixtures/golden/adapter-platform/` and the exclusion
manifest's own counts was expected to move, and the published diff was reviewed
against that prediction.

No golden binds `reference-otel-demo`, and the `fake-subject` runs
(`valid-pre-environment-run`, both `generic-finalization-*`, the three
`invalid-run-*`, `journey-acquisition-to-frozen-output`) execute no adapter
bytes, so they are untouched.

## 5. What did not change

`adapter-authority-respected` and every unrelated gate. The fake port's rules:
it dispatches nothing, so it certifies nothing, passes the gate vacuously, and
its evidence does not name a receipt — no reader can mistake it for a certified
adapter.

B-129 and B-130 are untouched. The missing adapter-path campaign red control is
not added; the receipt-bypass regression required by this remediation is, in
`tests/adversarial/externalAdapterAdmission.test.ts`.

## 6. Honest limits

- `authenticated` is unreachable on this checkout. No certification authority is
  pinned, so every real receipt here is `locally_observed_unauthenticated`. The
  scored path is enforced but unexercised by a real signed receipt; the controls
  cover it with a test key.
- Retaining a **signed** receipt would need a `SignedMemberRule`, and there is
  no `adapter_certifier` signer role. Mapping it to `adapter_owner` would assert
  the opposite of the independence the receipt proves. Deferred with the pinned
  authority it implies.
- The cycle refusal was written and then removed: no document can exhibit it, so
  it was a control that could never fire. The impossibility is recorded in
  ADR-ERL2-036 instead.
- This does not make Lab onboarding two commands. The governor registry,
  challenge admission, policies and limits are still prepared out of band.
- The Docker-gated compose end-to-end tests were updated for the new admission
  requirement but **not executed** — this package does not run Docker.
