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

No *new* contract was added. The receipt is already ERL2-C-125. The corrective
package did extend `AcquisitionPreregistrationV1` with two members — see §7 —
because the independent review showed the retained-role binding alone did not
make the real/fake choice durable.

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

**Exact counts, base → `e9718e0`** (established by the independent review; an
earlier draft of this ledger said "148 regenerated goldens", which is not a
figure Git produces):

| Measure | Count |
|---|---|
| logical changed entries | 178 |
| rename-aware `fixtures/golden/adapter-platform/**` entries | 147 |
| adapter-platform pathnames, rename detection **disabled** | 149 |
| `fixtures/golden/cli-transcript.json` | 1 |
| all other entries | 30 |

The two figures differ because two files were renamed, and a rename counts once
with detection on and twice with it off. The name-status inventory is preserved
at `docs/evidence/independent-review-e9718e0/changed-files.txt`.

**The `cli-transcript.json` baseline refresh is accepted, not attributed to this
package.** It is one of the seven byte-pin exclusions and had not been
regenerated since 2026-08-04. Verified before accepting it: `registered_contracts`
155 → 156 comes from `ERL2-C-160`, added 2026-08-06 in `9f22e30`; the
container-launcher fields come from ADR-ERL2-034, 2026-08-07; this package did
not touch `packages/contracts/src/registry.ts` in its first three commits; and no
load-bearing claim rests on the transcript, precisely because it is excluded from
the pin. Splitting it out would mean rewriting published candidate history,
which is a worse trade than documenting it.

No golden binds `reference-otel-demo`, and the `fake-subject` runs
(`valid-pre-environment-run`, both `generic-finalization-*`, the three
`invalid-run-*`, `journey-acquisition-to-frozen-output`) execute no adapter
bytes, so they are untouched.

## 5. What did not change

`adapter-authority-respected` and every unrelated gate. The fake port dispatches
nothing and certifies nothing; after the correction in §7 its `adapter-certified`
gate is **omitted** rather than passed, so no reader can mistake it for a
certified adapter.

B-129 and B-130 are untouched.

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
  requirement but **not executed** in the first package — it did not run Docker.
  They were executed in the corrective package; see §7.
- The first package ran no **full negative-control campaign**. It did run 25 new
  adversarial admission controls, which is a different thing, and the two are
  not interchangeable.

## 7. Corrective package — the independent review of `e9718e0`

An independent security and evidence-boundary review of the candidate returned
**CHANGES REQUIRED**, preserved at
[`docs/evidence/independent-review-e9718e0/`](../evidence/independent-review-e9718e0/README.md).
Its full-suite rerun was inconclusive and it ran no campaign; neither is cited
here as evidence either way.

### P1 — mode and receipt were not durable

Reproduced by the reviewer: preregister with no `--adapter-entry`, then
`acquire` with a real entry and receipt A, then `verify-package` with receipt B.
Both succeeded. No receipt was ever retained.

`AcquisitionPreregistrationV1` now carries `subject_execution_mode`
(`development_fake_port` | `external_adapter`, required) and
`adapter_certification_receipt_hash` (present **iff** the mode is
`external_adapter`, forbidden otherwise). Both sit inside the preregistrar's
signature and the hash-chained lifecycle, so the binding survives process exit,
a fresh command, recovery and replay — the property CLI memory could not give.

`assertSubjectModeUnchanged` is the single authoritative enforcement point. A
fake run refuses a later entrypoint and a later receipt; a real run refuses to
proceed without its entrypoint, because omission would be a silent downgrade;
and the receipt resolves **only** from the frozen field.

### P2 — failure evidence named the prior receipt

`freezeAdapterFailureFinding` read the manifest's bootstrap/prior field. It now
reads the frozen preregistration binding, and an `external_adapter` failure with
no retained current receipt fails closed. A fake-port failure carries the
bootstrap sentinel, because there genuinely is no adapter certification.

### P2 — "not applicable" was represented as a pass

`adapter-certified` is now **omitted** for a fake-port run, and `requiredGateIds`
drops it from the required set for that mode — the same representation
`PRE_ENVIRONMENT_GATE_IDS` already uses for the environment and selection gates
on a run that reached neither. No validity-contract change was needed:
`gate_results` is a list, and absence already meant "never exercised".
`passed: true` is now reachable only from a validated retained receipt.

### P2 — two enforcement points were not load-bearing

Both survivors were re-measured with the same mutations and are now caught:

| mutation | before | after |
|---|---|---|
| remove pre-host `verifyAdapterCertification` | survived 31 tests | **1 control fails** |
| remove per-dispatch `assertEntryDigestUnchanged` | survived 71 tests | **2 controls fail** |

The pre-host call was measured, not assumed, to be redundant for every *later*
command once the binding exists — removing it changed nothing observable there.
It is load-bearing at **preregistration**, the one moment no binding exists yet
and the subject port builds the host before the workspace validates. That is the
case the new control pins, and this ledger claims exactly one authoritative
enforcement point rather than two independent defenses.

The per-dispatch controls observe whether the substituted adapter *executed* —
it writes `SUBSTITUTE-EXECUTED` — rather than whether a helper returned an
error, and cover deterministic same-path replacement and symlink retargeting.

### P3 — prose exceeded the retained proof

ADR-ERL2-036 §6 now states the guarantee as deterministic post-admission
substitution detection, and explicitly disclaims atomic frozen-byte execution,
protection from a malicious same-user check-to-spawn race, container isolation
and authenticated certification. The stale claim that the hostile golden became
an identity mismatch is corrected — it remains a certified hostile timeout — and
the golden is no longer cited as proof of process-tree termination, only of the
timeout/failure shape and PID emission. Termination is proven in
`tests/adversarial/adapterHost.test.ts`.

### Campaign red control

`adapter-mode-binding` removes `assertSubjectModeUnchanged` and requires
`tests/dist/adversarial/adapterModeBinding.test.js` to fail. The campaign has
**129** controls after this addition, discovered from the harness rather than
assumed.

## 8. Second corrective package — the independent review of `90a0039`

The corrective package above was reviewed independently and approved:
**CORRECTIVE IMPLEMENTATION APPROVED — CAMPAIGN HARNESS FIX REQUIRED**. The
review is preserved at
[`docs/evidence/independent-review-90a0039/`](../evidence/independent-review-90a0039/README.md).
It recomputed the preregistration core hash and watched it move when either
frozen field is altered, so §7's P1 closure is proven rather than asserted, and
it confirmed exact receipt equality across preregistration, retained artifact and
failure finding in the hostile golden.

It raised exactly one new finding against this package, and one campaign-harness
defect that is **not** a receipt-admission defect.

### P3 — the applicability rule was enforced nowhere it was used

Removing *both* production calls to `assertAdapterCertificationApplicability` —
from `buildPreEnvironmentValidity` and `buildEnvironmentValidity` — left the
affected suite at 144/144 and the whole repository at 1,209 tests with zero
failures.

The reason is worth recording, because §7's own P2 entry above is what created
it. The control written there calls `assertAdapterCertificationApplicability`
**directly**, so deleting the wiring cannot break it: the helper still works, it
is simply never reached. And the one sub-case that *is* independently enforced —
an external run omitting the gate — belongs to `assertRequiredGatesPresent`,
which is why suppressing the producer did fail a test and hid the gap.

What was uncovered is everything the applicability rule uniquely says: the gate
appearing more than once, citing manifest-only evidence, citing the manifest's
bootstrap/prior receipt instead of the current one, or a fake-port run emitting
it at all. None is a missing gate, so nothing else objects — and each is a false
certification claim in retained evidence, the exact shape LIVE-001 was.

`tests/adversarial/adapterCertificationApplicability.test.ts` closes it by
driving `buildPreEnvironmentValidity` and `buildEnvironmentValidity` — the real
entry points that carry the call sites — with each malformed shape, asserting a
typed refusal **and** that no validity result was emitted. A baseline control
proves the honest shape of both modes still builds; a final control proves each
malformed shape is well-formed in every other respect, so the refusal is
uniquely applicability's rather than another guard firing first.

Re-measured with the reviewer's own mutation (`replacedCount=2`): **four of six
controls fail**, and the previously blind affected suite still passes 64/64 —
which is the point. No production behaviour changed.

### The campaign disagreement was not this package

`substrate-loopback-only-rendered` was the campaign's single recorded
disagreement. It is a pre-existing fixture-provisioning defect with a
classification defect behind it, identical at `e9718e0` and `90a0039`, and fully
load-bearing once the pinned upstream fixture is provisioned. It is fixed in the
harness, not here; see
[`negative-control-harness.md`](negative-control-harness.md) §8. Nothing in the
receipt-admission implementation was changed for it.
