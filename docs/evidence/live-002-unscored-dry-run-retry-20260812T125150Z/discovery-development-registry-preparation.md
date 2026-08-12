# Discovery: can a generic development-tier registry preparation command be built?

Verdict: **BLOCKED — DEVELOPMENT GOVERNOR INPUTS UNDEFINED**

Traced at merged `main` `70b7e6e00aabba30bc07ca2c15d35404e40439b7` through CLI
parsing (`packages/cli/src/journeyCommands.ts:758-782`), preregistration
validation (`packages/core/src/run/workspace.ts:485-520`), the admission
registry (`packages/core/src/registry/admission.ts`), the contract registry and
JSON schemas, and the test-only builder `tests/support/governorRegistry.ts`.

## The eight hashes are not one class of thing

| # | Flag | Contract | How preregistration treats it | Producer | Signature | Normative dev default | Generic? |
|---|---|---|---|---|---|---|---|
| 1 | `--acquisition-source` | `AcquisitionSourceManifestV1` | `registry.require` | none public | **required** | no | subject-specific |
| 2 | `--generic-policy` | `GenericRunPolicyV1` | `registry.require` | none public | **required** | no | generic |
| 3 | `--acquisition-step` | `JourneyStepCommitmentV1` | `registry.require` | `commitJourneyStep` (public) | **required** | no | generic |
| 4 | `--package-verification-step` | `JourneyStepCommitmentV1` | `registry.require` | `commitJourneyStep` (public) | **required** | no | generic |
| 5 | `--trust-policy` | `TrustPolicyManifestV2` | `registry.tryGet`, mirrored if present | **test-only** `developmentTrustPolicy` | **required** | no | generic |
| 6 | `--acquisition-actor-script` | none | recorded only; never resolved | n/a | n/a | no | generic |
| 7 | `--acquisition-actor-schema` | none | recorded only; never resolved | n/a | n/a | no | generic |
| 8 | `--limits` | none | recorded only; never resolved | n/a | n/a | no | generic |

Items 6–8 appear only in `workspace.ts`; nothing else in `packages/core` or
`packages/contracts` reads them. They are opaque commitments, not admitted
artifacts.

## Answers to the discovery questions

1. **Can every artifact be created using settled public APIs?** No. `commitJourneyStep`,
   `sealSigned`, `coreHash`, `developmentKey` and `developmentAgeIdentity` are public,
   but there is no public producer for `AcquisitionSourceManifestV1`,
   `GenericRunPolicyV1` or `TrustPolicyManifestV2`, and no package exports any
   registry-preparation API.
2. **Are all required development defaults normative and present?** No. None exist.
3. **Does any artifact require an unprovisioned identity, key, authority or policy
   decision?** Yes — four separate ones (below).
4. **Can development artifacts be labelled unauthenticated?** Only partly. Adapter
   admission has a real `locally_observed_unauthenticated` semantic. The four
   registry-required artifacts have no equivalent: their schemas make `signature`
   **required**, with no unauthenticated variant.
5. **Does preparing them change a security or evidence boundary?** Yes. Items 3–5
   sit on the blind-evaluation and trust-root boundaries.
6. **Can preregistration consume a prepared config without duplicating validation?**
   Yes — it re-resolves everything by core hash, so a preparation command would not
   need to duplicate validation. This part is not the blocker.
7. **Is the internal fixture producer safe to reuse?** No. `tests/support/governorRegistry.ts`
   depends on `tests/support/keys.ts`, which is test-only and not exported by any package.

## The four undefined inputs

### D1 — Judge expectations for the two step commitments
`JourneyStepCommitmentV1` requires `judge_expectation_core_hash`,
`judge_expectation_plaintext_file_sha256`, an age-x25519 `judge_expectation_ciphertext`
and `recipient_key_ids`. `commitJourneyStep` requires a `JudgeExpectationInput`
(`expectedObservations`, `permittedFailureCategories`, `attributionRequirements`,
`truthScope`, `canaryId`). These are the **blind evaluation criteria** for a step.
No normative default exists for what an acquisition or package-verification step
expects. Smallest operator input: an authored judge expectation per step, plus a
judge age recipient. A runbook alone cannot resolve it — the content is a real
evaluation-design decision.

### D2 — Run trust policy is a trust root
`TrustPolicyManifestV2` pins signer roles to keys. Its only builder is test-only.
Emitting one from a production command mints a trust authority, which this package
is explicitly forbidden to do. Smallest input: a governance decision about who the
development trust root is and how it is provisioned.

### D3 — Signer role authority for the four registry-required artifacts
Every one requires a `signature`. The production CLI keyring
(`journeyCommands.ts:127-132`) has only `preregistrar`, `finalizer`,
`timestampAuthority` and `evaluator`. It has no `policyAuthor` or
`challengeGovernor` — the roles that would sign a generic run policy and step
commitments. The 20-role keyring exists only in `tests/support/keys.ts`. Choosing
which role signs what is a governance decision. A runbook could record the mapping
once decided, but cannot invent it.

### D4 — Nine transitive policy hashes with no contract and no producer
`AcquisitionSourceManifestV1` additionally needs `locator_hash`,
`integrity_policy_hash`, `provenance_policy_hash`, `network_profile_hash` and a
`limits` object. `GenericRunPolicyV1` additionally needs `evidence_policy_hash`,
`cutoff_policy_hash`, `journey_policy_hash`, `generic_evaluation_policy_hash`,
`domain_pack_hashes` and `run_trust_policy_hash`. Of these, only `CutoffPolicyV1`
has a contract in the registry; the rest are opaque `Hash` fields nothing
validates. A preparation command would have to choose bytes for each with no
defined meaning, producing commitments that look authoritative and mean nothing.

## What is *not* blocked

Preregistration's own validation is sound and re-resolves by core hash, so once
the four decisions above exist, a preparation command is mechanically
straightforward and would not need to duplicate or bypass validation. The blocker
is governance content, not plumbing.

## Smallest unblocking decision

Decide and provision a **development governor profile**: the signer-role → key
mapping for policy-author and challenge-governor, a development trust-policy root,
a judge age recipient, and one worked pair of judge expectations for the
acquisition and package-verification steps. Once those exist as public, non-test
inputs, `prepare-development-run` becomes implementable with no invented semantics.
