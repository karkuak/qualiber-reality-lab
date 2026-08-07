# External Reality Lab V2

A domain-bounded, **product-independent** reality lab. It constructs, operates,
perturbs and observes realistic software-delivery and production-operations
ecosystems. Any compatible product participates as an opaque **subject** through
a versioned adapter; the core does not know a subject's feature model, internal
architecture, vocabulary, scoring rules or release authority.

Normative sources, in precedence order:

1. accepted ADRs in [`docs/adr/`](docs/adr)
2. [`external-reality-lab-design-v2.md`](external-reality-lab-design-v2.md)
3. [`external-reality-lab-implementation-plan.md`](external-reality-lab-implementation-plan.md)

## Status

Slices 1 through 6 are implemented: the charter, ADRs and requirement ledger; the
integrity, lifecycle, selection, trust and offline-verification kernel; the
environment driver interface, fake driver, clean control, reservation allocator
and resource frontier; the generic journey — split oracle steps, measured
acquisition, package verification, capture and evidence envelopes, and both
early terminals; the adapter platform — SDK, core-owned host, sandbox profile,
capability, credential and egress brokers, mutation/compensation ledger, output
freezer and `ADAPTER-CERT-V1`; and generic evaluation — the closed finding
union, the data-only evaluation pack DSL, the Lab-owned deterministic metric
catalogue, journey and domain evaluation, the pre-cleanup result join, Lab-owned
validity gates, the generic evaluation index, and a valid pre-environment
terminal whose public bundle verifies offline. Four certified reference subjects
now exist: correct, limited, misleading and inconclusive.

Slice 6.5 adds the selection and environment branches: `select` advances the
durable selection walk to `case_selected`, and seventeen phase commands take a run
from there to a finalized environment terminal whose
`EnvironmentPublicVerificationBundleV2` verifies offline. A run whose environment
fails freezes exactly one `InvalidLabRunRecordV1` after frontier-derived cleanup,
with restoration and teardown failures routed through receipt-backed emergency
cleanup. Slices 7–12 are not started.

An independent review of that work found a false-valid-attestation mechanism and
a cluster of integrity defects in exactly the paths the slice exists to establish.
[ADR-ERL2-024](docs/adr/ADR-ERL2-024.md) settles and implements the invariant
foundation underneath them: a run is permanently bound to the workspace that
records it and to **one** substrate identity, every externally visible mutation is
preceded by a durable intent and reconciled against observed state before any
retry, cancellation is routed from the branch the run is actually in, emergency
cleanup attempts each independently safe action separately, and the offline
verifier **re-derives** validity, restoration, teardown and the emergency action
set instead of reading the producer's verdict. That package closes the P0 and the
blocking P1 cluster; it does not remediate the whole review, and
[`docs/ledger/remediation-6.5-invariants.md`](docs/ledger/remediation-6.5-invariants.md) §6
lists what stays open.

A follow-up audit of that implementation found three false-attestation paths still
open, and two ADRs close them.
[ADR-ERL2-026](docs/adr/ADR-ERL2-026.md) makes restoration rest on an
**observation** rather than a receipt: the substrate is read for its
applied-mutation set before the compensation and again afterwards, because the
baseline fingerprint and the resource inventory are both blind to a mutation and
a driver reporting `succeeded` while reverting nothing produced `passed: true`.
[ADR-ERL2-025](docs/adr/ADR-ERL2-025.md) makes `claim_scope` **derived from
retained evidence** rather than supplied by `--claim-scope`, which had let an
operator sign historical-reproduction evidence over a fake-driver development run.
And the substrate loader's remaining fail-open — the coercion that turned any
unrecognised document into an empty substrate — is closed, so only `ENOENT` means
"never provisioned".
[`docs/ledger/remediation-6.5-false-attestation.md`](docs/ledger/remediation-6.5-false-attestation.md)
records what was measured and §7 lists what is still open.

A third audit found that the cleanup findings recorded as closed were closed on
**one branch of two**. `emergency` selected which safety rules applied, so the
five failure phases that are not restoration or teardown still issued an
unconditional whole-environment `driver.destroy()` over a frontier frozen one line
above and never read — which destroyed resources that frontier had classified
"do not touch", and aborted outright on a resource belonging to another run.
[ADR-ERL2-027](docs/adr/ADR-ERL2-027.md) gives **every** invalid environment
terminal the same discipline, and adds the observation none of them had: the
substrate is re-observed after the last dispatch and the result retained beside
the pre-action frontier, so a fabricated empty residue and a resource that
vanished without an authorized action are both offline-detectable. It also fixes
a regression test that could not have failed — the only case claiming to prove
"a foreign resource no longer aborts cleanup" used a *shared* resource, which
passes the ownership check. [`docs/ledger/remediation-6.5-cleanup.md`](docs/ledger/remediation-6.5-cleanup.md)
records what was measured, including the negative control that killed nothing on
its first run and what that turned out to mean.

**What that environment terminal is, exactly.** It is a **development-tier** run
against the **fake environment driver** with a **trusted reference subject** and
**non-blind** selection. It is evidence that the mechanism closes — one archetype,
one driver, one journey shape, evidence sources that produce zero records by
construction. It is not evidence about any real ecosystem, any subject's quality,
or robustness of any kind. `DomainResultEvaluatedV1` remains unreachable: a
development run reveals only journey-scope judge expectations, so every completed
run produces `DomainResultNotApplicableV1` — `pre_environment_terminal` on the
early branch, `functional_evidence_unavailable` on the environment branch.

Since ADR-ERL2-025 that boundary is **enforced rather than described**: every
terminal this build can produce derives `claim_scope: "T1"`, held there
independently by the development tier, the non-blind selection, the fake driver,
the absent containment qualification, the unevaluated domain plane and the
metrics' own declared ceilings. `--claim-scope T2` or `T3` is a typed refusal in
the producer, and an attestation carrying either is refused by the offline
verifier. See [`docs/claims/permitted-claims.md`](docs/claims/permitted-claims.md)
for the claim boundary in full.

Four slices shipped under their documented rollbacks. **The Compose driver is
enabled** on a qualified ERL2-OQ-005 substrate lock — a two-service subset of
OpenTelemetry Demo `3.0.0`, digest-pinned for `linux/amd64` and `linux/arm64` —
but the lock is signed by this repository's own development governor key, so it
is a self-qualification and `erl2 doctor` reports
`independently_qualified: false`. The fake driver remains the default; a run
selects its driver once with `--environment-driver` and may not substitute it.
A **valid** Compose-driver run **whose archetype declares a metric evidence
source** and **whose exercising journey step succeeded** retains the
**attributable-telemetry observation** — the run's own collector received
records carrying the run's id, frozen with the log lines the counts derive from
before teardown begins — and an offline bundle attests received telemetry
exactly that far: the validity gate and the offline verifier each refuse such a
run whose observation is missing or unattributed. All three conditions are
load-bearing and none may be dropped: a Compose run that fails any of them
declares nothing, and its retained observation — which may honestly report zero,
or report `absent` with a reason code — supports **no** receipt claim at all.
Read [`docs/claims/permitted-claims.md`](docs/claims/permitted-claims.md) for
the statement at exactly its width, including what it still may not say
(ADR-ERL2-033, discharging the ERL2-OQ-005 deferred obligation; ADR-ERL2-035 for
what happens to collector bytes the Lab cannot freeze; the evidence window and
the T1 ceiling are unchanged).
**Held-out and blind execution is refused** because ERL2-OQ-007
is unresolved, so the journey runs at `development` tier. **Privileged subject
operations are refused** because ERL2-OQ-001 is unresolved, so the platform
supports unprivileged operations only — read
[`runbooks/adapter.md`](runbooks/adapter.md) for exactly which isolation
controls each profile does and does not enforce. **Opaque and third-party
subjects are refused** because ERL2-OQ-008 is unresolved. A Node-capable
container substrate is pinned by digest, its twenty controls were observed
enforcing, a container-backed launcher starts adapters inside it, and
`ADAPTER-CERT-V1` passes under the `container` profile against a reference
adapter (ADR-ERL2-034). What has **not** changed is who signed the evidence:
both the substrate lock and the probe manifest are signed only by a
repo-derivable development governor key, not a pinned qualification authority,
so `erl2 doctor` reports the qualification as
**`locally_observed_unauthenticated`** (self-reported), never `authenticated`.
The container profile is therefore available to **trusted, repository-owned
reference subjects only**, and only on a host where the qualification derives;
every opaque-private and third-party subject is refused under it by an explicit
subject-trust gate. See
[`docs/ledger/requirements.json`](docs/ledger/requirements.json)
for per-requirement status and [`docs/claims/permitted-claims.md`](docs/claims/permitted-claims.md)
for what the current evidence does and does not support.

Several features are **disabled fail-closed** because their open question is
unresolved — held-out and blind selection, the Compose environment driver, the
privilege broker, executable evaluation packs, stronger subject isolation, and
threshold VRF. Run
`erl2 doctor` to see the live list, or read [`docs/decisions/open-questions.md`](docs/decisions/open-questions.md).

## Quick start

```bash
npm install
npm run build
npm test
```

Generate the CLI and verifier evidence. Routine generation writes to a fresh
temporary directory and **never** mutates the approved goldens under
`fixtures/golden/`; only the explicit `evidence:update` rewrites them:

```bash
npm run evidence
```

Byte-compare a deterministic generation against the pinned goldens without
touching them (832 files pinned; 7 are excluded with a printed reason — the
adapter `request.frames` bake an absolute workspace path, `grandchild.pid` is a
real OS pid, and `cli-transcript.json` records absolute CLI paths):

```bash
npm run evidence:verify
```

Run the generic journey from acquisition to frozen subject output. The registry
is a governor-prepared directory of admitted artifacts; `fixtures/golden`
contains a worked example produced by `npm run evidence:update`:

```bash
node packages/cli/dist/src/bin.js preregister-acquisition --run-root ./run --registry ./registry --tier development --acquisition-source HASH --adapter HASH --acquisition-actor-script HASH --acquisition-actor-schema HASH --acquisition-step HASH --package-verification-step HASH --generic-policy HASH --trust-policy HASH --limits HASH --expires 2026-12-31T00:00:00Z
```

Run the same journey against a real out-of-process adapter instead of the
development fake port by adding `--adapter-entry`:

```bash
node packages/cli/dist/src/bin.js acquire --run-root ./run --registry ./registry --tier development --run RUN_ID --adapter-entry adapters/reference-correct/dist/src/main.js
```

Verify a public bundle offline, exactly as an external consumer would:

```bash
node packages/cli/dist/src/bin.js verify --public-bundle fixtures/golden/valid-pre-environment-run/public-bundle.json --root-config fixtures/golden/valid-pre-environment-run/root-config.json --artifact-root fixtures/golden/valid-pre-environment-run/artifacts --lifecycle fixtures/golden/valid-pre-environment-run/lifecycle.json --offline
```

Verify a retained invalid run record offline — no attestation and no bundle are
required or accepted:

```bash
node packages/cli/dist/src/bin.js verify-record --record fixtures/golden/invalid-run-cancellation/invalid-record.json --lifecycle fixtures/golden/invalid-run-cancellation/lifecycle.json --artifact-root fixtures/golden/invalid-run-cancellation/artifacts --root-config fixtures/golden/invalid-run-cancellation/root-config.json --offline
```

## Package topology

```text
contracts <- integrity <- core
contracts <- adapter-sdk <- adapters/*
contracts <- evaluation-sdk <- packs/*
contracts + integrity + core <- public-verifier
core + public-verifier <- cli
```

`tests/architecture/purity.test.ts` enforces this direction and scans package
manifests, the lockfile, sources, schemas, generated types, compiled bundles and
CLI output for any named-subject coupling.
`tests/architecture/removability.test.ts` runs core, integrity, contracts and the
verifier in a module tree that contains **no adapter package at all**, and proves
the core digest is identical with and without adapters.

| Package | Owns |
|---|---|
| `packages/contracts` | closed JSON Schemas, generated types, runtime validators, refusal codes |
| `packages/integrity` | RFC 8785 JCS, domain-separated hashing, artifact freeze, path confinement, Ed25519, trust, timestamps, threshold envelope, age-x25519 |
| `packages/core` | lifecycle state machine, append-only event chain, the V2 selection chain, environment drivers, clean control, allocator, resource frontier, the generic step engine, acquisition and capture, the adapter host, sandbox profile, capability/credential/egress brokers, mutation ledger, output freezer, certification harness, isolation qualification, the generic evaluator (findings, metrics, journey, domain, validity, join, index), cleanup and finalization, seams |
| `packages/adapter-sdk` | the adapter runtime, phase-specific request validation, oracle-canary scanner, translation totality |
| `packages/evaluation-sdk` | data-only pack DSL and its certification harness; no pack runtime exists |
| `packages/public-verifier` | independent artifact index, `erl2-mandatory-closure/v1`, offline bundle and record verification |
| `packages/cli` | the `erl2` command surface |

| Directory | Holds |
|---|---|
| `environments/archetypes` | admitted archetype definitions; `clean-greenfield` is the required clean control |
| `environments/fake` | fake-driver notes and fixtures |
| `environments/otel-demo` | the **unqualified** substrate lock and its qualification procedure |
| `adapters/reference-correct` | reference subject: supported, well-cited generic claims |
| `adapters/reference-limited` | reference subject: honest `unsupported` reporting |
| `adapters/reference-misleading` | reference subject: plausible conclusions the evidence does not support |
| `adapters/reference-inconclusive` | reference subject: explicit abstention where evidence is insufficient |
| `fixtures/sabotage/adapters` | hostile adapters that violate the protocol on purpose; they never import the SDK |

## Independence from Qualiber

ERL core builds, tests and verifies with no Qualiber workspace present. Nothing
in `packages/`, `adapters/reference-*` or `packs/operations` imports, names or
branches on Qualiber, and the purity suite fails if that ever changes. Qualiber,
when it arrives, is one opaque subject consumed through the same acquisition,
package-verification, adapter and sandbox contracts available to any other
subject.

## Repository conventions

- Contract first: schema, valid fixture, invalid fixture, generated type,
  validator and compatibility test precede producer or consumer code.
- Unknown fields fail closed. There is no `metadata` bag anywhere.
- Canonical bytes come from exactly one JCS implementation.
- Artifacts freeze before any checkpoint anchors them; nothing anchors itself.
- A work item is complete only with tests and generated evidence, not code.
