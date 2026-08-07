# Runbook — the adapter platform

## What the boundary actually is

Core owns every boundary; the adapter owns none of them. In one sentence: the
adapter is an untrusted program that answers closed, phase-specific requests
over `subject-adapter/v1`, and everything it says is adjudicated before it
becomes evidence.

The host enforces, per operation:

| Control | How |
|---|---|
| exact executable identity | the entry file's digest is read on every launch and pinned in `SandboxInvocationManifestV1` |
| one protocol version | `subject-adapter/v1` is offered; any other answer is `ADAPTER_PROTOCOL_VERSION_MISMATCH` |
| identity match | the negotiated adapter id/version must equal the certified manifest's |
| bounded frames | a declared length above the cap is refused before the body is buffered |
| deterministic deadline | a supervisor kills the whole process **group**, so a forked helper cannot outlive it |
| deny-by-default environment | five allowlisted names; no `HOME`, no proxy, no credential, nothing inherited |
| read-only inputs | mounts are fingerprinted and canary-scanned before dispatch and re-fingerprinted after |
| one writable path | a run-scoped output directory, required to be empty at dispatch |
| capability adjudication | closed enum; every privileged member denied and recorded |
| credential handles | scoped, short-lived, use-capped, bound to run/adapter/operation/target |
| egress adjudication | deny by default, every redirect hop revalidated, DNS rebinding and metadata denied |
| mutation control | intent → receipt → compensation, reconciled before the operation closes |
| output and diagnostics | counted, sized, depth-limited, symlink/hard-link/special-file refused, canary-scanned, redacted |
| post-freeze refusal | no operation dispatches after subject output freezes |

## What it is *not*

The default sandbox profile is `local-process`. It is a real process boundary,
not a container. `sandboxControlReport("local-process")` lists twelve controls it
enforces and thirteen it cannot, each with a reason code, and the certification
receipt copies both lists. Read them before you claim isolation.

Specifically **not** enforced here: read-only root filesystem, numeric non-root
user, capability drop, no-new-privileges, seccomp, PID/memory/CPU limits,
network-namespace isolation, kernel-enforced read-only mounts, and a kernel-level
block on sockets or on reading the operator's home directory. A same-user adapter
process can read whatever the operator can read.

**Therefore: run an untrusted subject on a disposable machine.**

The `container` profile does enforce all thirteen — but only where it derives,
and only for a subject this repository authored. It is
`disabled_until_container_substrate_qualification_derived_on_this_host` unless
`deriveContainerProfileActivation` has re-derived the qualification here
(ADR-ERL2-034), and requesting it without that is a refusal, never a silent
downgrade. It is not a route around the paragraph above for anything the Lab did
not write: ERL2-OQ-008 is still open on authentication, so an `opaque_private` or
`third_party` subject is refused the container profile explicitly.

## ERL2-OQ-001: privileged operations are refused

There is no privilege broker. There is also no shell capability anywhere in the
enum — privilege was never modelled as command text. Every privileged capability
is denied with `ADAPTER_PRIVILEGED_OPERATION_NOT_SUPPORTED`, and the denial is
recorded in `AdapterCapabilityGrantV1` rather than emulated:

```text
bind-loopback-port        install-package-into-host   write-host-configuration
register-host-service     host-package-manager        load-kernel-module
use-docker-socket         elevate-to-root             reboot-host
```

An adapter whose *manifest* declares one cannot even be constructed, so the
refusal happens before any process starts.

## Writing an adapter

Depend on `@erl2/adapter-sdk` and `@erl2/contracts`, nothing else.

```ts
import { main, checkPackageKind, type AdapterDefinition } from "@erl2/adapter-sdk";

const ADAPTER: AdapterDefinition = {
  adapterId: "my-subject",
  version: "1.0.0",
  supportedPackageKinds: ["archive"],
  declaredEntrypoints: ["bin/my-subject"],
  handlers: {
    acquire(context) { /* … */ },
    "validate-package"(context) { /* … */ },
  },
};

await main(ADAPTER);
```

Rules the SDK enforces on your behalf, and that certification re-checks:

- **Identity is Lab-owned.** You return drafts; you never compute a `core_hash`.
  You describe a mutation target with a *descriptor*, and the host derives its
  identity hash.
- **Declare before you mutate.** `context.declareMutation` refuses a capability
  you were not granted, and an uncompensated succeeded mutation fails the whole
  operation with `ADAPTER_MUTATION_UNRECONCILED`.
- **Unsupported is an answer.** Return `status: "unsupported"` with
  `unsupportedInputs`. It is retained. Never return `supported` for something you
  did not do.
- **Account for every evidence entry.** `buildTranslationReceipt` refuses an
  omission, a duplicate, an invented entry, a reasonless lossy mapping, and a
  target outside the translated tree.
- **Attribute honestly.** An error's `owner` may be `adapter` or `subject`. It
  cannot be `lab`; the schema has no such option.

## Certifying an adapter

`ADAPTER-CERT-V1` runs a fake core and hostile fixtures through the public
protocol. An adapter cannot certify itself: `certifier_id` must differ from the
adapter id, and `certifier_is_adapter_owner` is a schema constant `false`.

```ts
const receipt = certifyAdapter({
  adapterManifest,
  adapterEntryPath,
  clock,
  certifierId: "your-independent-certifier",
});
```

Any failed check makes the verdict `refused`, and a refused receipt certifies no
operation and no package kind. There is no score and no override.

## Running a journey through an adapter

```bash
npm run erl2 -- preregister-acquisition --run-root RUN --registry REG --tier development --adapter-entry adapters/reference-correct/dist/src/main.js --adapter HASH --acquisition-source HASH --acquisition-actor-script HASH --acquisition-actor-schema HASH --acquisition-step HASH --package-verification-step HASH --generic-policy HASH --trust-policy HASH --limits HASH --expires 2026-12-31T00:00:00Z
```

Then `acquire`, `freeze-package`, `verify-package` with the same
`--adapter-entry`. After preregistration the run's own frozen preregistration
decides which adapter manifest is bound; passing a different `--adapter` is
`ADMISSION_ARTIFACT_UNKNOWN`, and pointing `--adapter-entry` at a different
adapter is `ADAPTER_IDENTITY_MISMATCH`.

`--fake-acquire` and `--fake-verify-package` script the development fake port
only. Combining them with `--adapter-entry` is refused.

## When an adapter fails

The run id is durable from preregistration onwards, so an adapter timeout, crash
or protocol violation does not simply error out: the CLI freezes an
`AdapterFailureV1` finding — `owner: "adapter"`,
`subject_attribution_proven: false`, empty `scoreable_planes` — routes through
`invalid_failure_detected`, performs bounded pre-environment cleanup, and freezes
exactly one `InvalidLabRunRecordV1`. The exit code is the failure's own; the
response carries the record hash.

Verify it offline in a fresh process:

```bash
npm run erl2 -- verify-record --record RUN/retained/invalid-run-record.json --lifecycle LIFECYCLE.json --artifact-root RUN --root-config ROOT.json --offline
```

## The hostile fixtures

`fixtures/sabotage/adapters/` holds adapters that violate the protocol on
purpose. They deliberately do **not** use the SDK — an adapter that misbehaves is
one that ignores it. Each is exercised by
`tests/adversarial/adapterHost.test.ts`, and a fixture with no test fails that
suite.


## Which subjects may run under which profile

The `local-process` profile is a same-user child process. It enforces a real
process boundary and adjudicates every capability, credential and egress the
adapter declares — but the operator account's filesystem, sockets and
credentials remain reachable in principle.

| Subject trust | `local-process` | `container` | disposable VM |
|---|---|---|---|
| `trusted_reference` — source is in this repository and reviewed | permitted | permitted where the qualification derives | permitted once qualified |
| `opaque_private` — a supplied artifact whose source the Lab never sees | **refused** | **refused** — pending authentication | permitted once qualified |
| `third_party` — a neutrally selected OSS subject | **refused** | **refused** — pending authentication | permitted once qualified |

`assertSubjectMayRunUnderProfile` and `deriveContainerProfileActivation` both
enforce this. The second column is the one that changed: the container profile
now works, and the two refusals in it are an explicit subject-trust gate rather
than a side effect of the profile being unusable. They stay because ERL2-OQ-008
is open on **gate 1b** — the substrate lock and probe manifest are signed by a
repo-derivable development key, so the qualification licensing the profile is
self-reported, and `erl2 doctor` reports
`locally_observed_unauthenticated`. The disposable-VM profile is undeclared and
unimplemented.

To use the container profile you must derive it on the host that will execute
the adapter:

```
node scripts/build-adapter-runtime-image.mjs
npm run qualify:isolation -- --image <the digest-pinned reference it prints>
npm run erl2 -- doctor --probe-launcher
```

Nothing about that sequence grants anything by itself. `doctor` re-derives from
the retained bytes on every call, and `deriveContainerProfileActivation` re-runs
the whole derivation — drift, probe suite, lock binding, twenty observed
controls, an observed launcher, subject trust — before any adapter starts.

### Qualifying a stronger profile

1. Pin an immutable substrate lock recording the runtime and its image digest.
2. Run an enforcement probe for each of the twenty controls in
   `REQUIRED_ISOLATION_CONTROLS`, recording `evidence: "observed"` only when the
   probe actually saw the control hold.
3. Pass both to `qualifyIsolationProfile`.

A probe that reports `declared` (a manifest said so) or `mocked` (a fake harness
produced it) does not qualify anything, by construction —
`fakeEnforcementProbes()` returns every control as `mocked` and always yields
`not_qualified`. There is no input to `qualifyIsolationProfile` that means
"enabled", so a substrate cannot enable itself.

See ADR-ERL2-016 and `tests/adversarial/isolationQualification.test.ts`.
