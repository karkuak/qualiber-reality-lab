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
Slices 7–12 are not started.

**The valid *environment* terminal is not reachable end to end.** Its contracts,
closure roles and refusals exist and are exercised, but producing one needs the
selection, provisioning, activation and observation commands that belong to the
slice 3/4 environment branch, which has not shipped. Every run the CLI can
complete today ends at a pre-environment terminal and produces
`DomainResultNotApplicableV1` with the reason `pre_environment_terminal`.

Four slices shipped under their documented rollbacks. **The Compose driver is
disabled** because ERL2-OQ-005 is unresolved, so the fake driver is the only
enabled driver. **Held-out and blind execution is refused** because ERL2-OQ-007
is unresolved, so the journey runs at `development` tier. **Privileged subject
operations are refused** because ERL2-OQ-001 is unresolved, so the platform
supports unprivileged operations only and the container sandbox profile is
disabled — read [`runbooks/adapter.md`](runbooks/adapter.md) for exactly which
isolation controls the enabled profile does and does not enforce. **Opaque and
third-party subjects are refused** because ERL2-OQ-008 is unresolved. A container
substrate has been pinned and its twenty controls were observed enforcing
(ADR-ERL2-017), with the results authenticated by a signed probe manifest — but
both the lock and that manifest are signed only by a repo-derivable development
governor key, not a pinned qualification authority — so `erl2 doctor` reports it
as **`locally_observed_unauthenticated`** (self-reported), never `authenticated`,
and the container-backed launcher does not exist. Opaque execution therefore
stays refused and only trusted reference subjects may run, under `local-process`
only. See
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
touching them (780 files pinned; 7 are excluded with a printed reason — the
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
