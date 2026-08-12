# Design gate: can a local-observation workflow be separated from the governed journey?

Verdict: **BLOCKED — LOCAL OBSERVATION CANNOT BE SEPARATED SAFELY**

Traced and probed at merged `main` `70b7e6e00aabba30bc07ca2c15d35404e40439b7`
(discovery branch commit `d3616b4fb99e58e7bad1e72f9787e9e17d7f2241`).

This directory records why the non-governed local-observation path stopped at
its own design gate, and names the one architectural seam that would unblock it.
No implementation is retained: a command that cannot dispatch a single operation
without fabricating governor references would be a parallel Lab with a hole in
it, and the gate exists precisely to stop that.

## What was proven possible

The orchestration layer is genuinely separable, and most of it needs nothing new:

| Capability | Reuse unchanged | New observation equivalent | Prohibited |
|---|---|---|---|
| Adapter admission | `verifyAdapterCertification`, `retainAdmittedAdapter`, `AdmissionRegistry` | — | — |
| Per-dispatch entry digest | `AdapterHost.certifiedArtifactHash` | — | — |
| Dispatch, sandbox, deadlines, process-tree kill | `AdapterHost.run` | — | — |
| Artifact retention | `ArtifactStore.freezeJson` | — | — |
| Output freeze | `AdapterHost.markOutputFrozen` | — | — |
| Mutation / compensation / residue records | `AdapterOperationResult` | — | — |
| Plan and result documents | — | `local-observation-plan/v1`, `local-observation-result/v1` | — |
| Claim exclusion | — | `not_scored` / `not_governor_authorized` as schema constants | — |
| Preregistration, finalization, reveal, judging, scoring | — | — | never called |
| Governor artifacts, trust roots, judge expectations | — | — | never synthesised |

A prototype of the two contracts, the core orchestration and `erl2 observe-local`
was built and did compile, and the claim boundary was demonstrably enforceable:
`not_scored` and `not_governor_authorized` as `const: true` inside the hashed
core make a lying result fail validation rather than merely be discouraged.

## Where it stops, and why that is not fixable here

`AdapterHost.run` is separable. The **request contracts it carries are not.**

Every operation a certified `subject-adapter/v1` adapter accepts requires a
protocol request that names governed artifacts:

| Request contract | Used by | Governed references it mandates |
|---|---|---|
| `AcquisitionAdapterRequestV1` | `acquire` | `acquisition_preregistration_hash`, `acquisition_source_manifest_hash`, `visible_step`, `resource_limit_hash` |
| `PackageVerificationRequestV1` | `validate-package` | `acquisition_preregistration_hash`, `acquisition_record_hash`, `integrity_policy_hash`, `provenance_policy_hash`, `visible_step` |
| `AdapterStepRequestV1` | every other operation, **including `report-residue` and `compensate`** | `execution_plan_hash`, `visible_step`, `resource_limit_hash` |

`visible_step` is a `SubjectVisibleJourneyStepV1` — the governed journey's step,
the visible half of the pair whose hidden half is the encrypted judge
expectation. `acquisition_preregistration_hash`, `acquisition_source_manifest_hash`
and `resource_limit_hash` are three of the eight governor artifacts LIVE-002
already proved cannot be produced without undefined governance.

### Empirical proof, not inference

Against the real certified `reference-correct` adapter, dispatched as a real
subprocess (`probe-acquire.txt`, `probe-step-ops.txt`):

```text
MINIMAL acquire status: failed          # request without governed references
FIXTURE acquire status: supported       # request carrying them

report-residue MINIMAL => failed        # even pure cleanup
report-residue FIXTURE => supported
```

There is no operation — not even `report-residue` — that a certified adapter
will answer without a request carrying governed references. Supplying them means
fabricating a preregistration hash, a source-manifest hash, a limits hash and a
visible journey step for a run that has none of those things. That is
"fake journey commitments" and "arbitrary opaque commitment hashes" by name, and
it is the stop condition this gate was written to catch.

Repurposing the fields — putting the local plan's own hash into
`acquisition_preregistration_hash` — is worse, not better: the retained request
would then assert a preregistration that does not exist, in a field whose name is
the claim.

## The smallest architectural seam

**The adapter protocol needs an explicitly non-governed request variant.** The
governance references must become discriminated rather than mandatory — for
example a `mode: "local_observation"` discriminator under which
`acquisition_preregistration_hash`, `acquisition_source_manifest_hash`,
`execution_plan_hash`, `resource_limit_hash` and `visible_step` are absent rather
than fabricated.

That is a protocol decision, and it is not this package's to take:

- it changes `subject-adapter/v1`, which every certification receipt names;
- adapters certified against v1 would need re-certification under the new
  version, and the Independent-QA adapter must not be modified here;
- it touches the request contracts the governed path also uses, so it must be
  done additively and proven not to weaken them.

Until that decision is made, the honest options are the governed journey (which
needs the governor inputs LIVE-002 enumerated) or no run at all.

## What was not done

No implementation is retained on this branch — the prototype was reverted rather
than committed, so the repository carries no command that cannot work. No
governor artifact, trust root, judge expectation or signer was created. No
Qualiber source was accessed, no r5 artifact executed, no adapter modified. The
governed journey is byte-for-byte unchanged.

## Next decision

Decide whether `subject-adapter/v1` gains a non-governed request variant (new
protocol version, re-certification path defined), or whether early integration
waits for the governor profile LIVE-002 asked for. Either answer unblocks a real
implementation; neither can be assumed by an implementer.
