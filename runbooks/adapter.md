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

## Admitting an external adapter

A certified adapter is not yet an admissible one. The receipt has to be
*admitted*, and a real adapter cannot be dispatched without it
(ADR-ERL2-036). Admission takes three inputs and produces two hashes.

```bash
npm run erl2 -- admit-adapter --registry REGISTRY_DIR --adapter-manifest PATH/manifest.json --certification-receipt PATH/receipt.json --adapter-entry PATH/main.mjs
```

Then run the journey with the receipt hash it printed:

```bash
npm run erl2 -- preregister-acquisition --run-root RUN_DIR --registry REGISTRY_DIR --tier development --adapter-entry PATH/main.mjs --adapter ADAPTER_MANIFEST_HASH --adapter-certification CERTIFICATION_RECEIPT_HASH --acquisition-source HASH --acquisition-actor-script HASH --acquisition-actor-schema HASH --acquisition-step HASH --package-verification-step HASH --generic-policy HASH --trust-policy HASH --limits HASH --expires 2026-12-31T00:00:00Z
```

### The three inputs, and where the hashes come from

| Input | What it is |
|---|---|
| `--adapter-manifest` | the adapter's signed `SubjectAdapterManifestV1` |
| `--certification-receipt` | the `SubjectAdapterCertificationReceiptV1` `certifyAdapter` produced |
| `--adapter-entry` | the entry module, whose bytes are re-hashed here and again before every dispatch |

You do not compute any hash yourself. `admit-adapter` recomputes both
`core_hash` values from the documents' own bytes and the entry's SHA-256 from
the file, prints them, and refuses if any disagree. The
`adapter_manifest_hash` and `certification_receipt_hash` it prints are the
values `--adapter` and `--adapter-certification` take.

### What it checks

Both contracts; both core hashes; the entry's digest against the manifest and
the receipt; that the receipt names this exact manifest; adapter id and version;
the verdict is `certified` with no refusal codes and no failed check; that the
certified operations and package kinds match the manifest's declarations
exactly; that the certifier is not the adapter; and the trust-tier policy below.

### Development versus scored

| Tier | Unsigned or unverifiable receipt | Signed by a pinned authority |
|---|---|---|
| `development` (default, unscored) | admitted, labelled `locally_observed_unauthenticated` | admitted, `authenticated` |
| `held_out`, `blind` (scored) | refused — `ADAPTER_CERTIFICATION_AUTHENTICATION_REQUIRED` | admitted |

`locally_observed_unauthenticated` means the receipt is genuine evidence that
nobody authenticated. No scored, blind or authenticated claim may be derived
from a run admitted that way, and the run's `adapter-certified` gate cites the
receipt so a reader can check for themselves.

A signature that is *present but does not verify* — a wrong signed hash, an
unpinned signer, or the all-zero development placeholder — is refused at **every**
tier, development included. Absent evidence is honest; forged evidence is not.

There is no `--allow-unsigned`. The development allowance comes from `--tier`,
not from a flag that could be pointed at a scored run.

### Where output goes, and how to clean it

The pair is published atomically to
`REGISTRY_DIR/external-adapters/<manifest-hash-without-prefix>/`, as
`adapter-manifest.json` and `certification-receipt.json`. Both land or neither
does. Re-admitting the identical pair is idempotent; a *different* receipt for
the same manifest is refused rather than silently overwritten.

Admission writes nothing else and starts no adapter. To undo it, delete that one
directory.

### Typed refusals

| Code | Cause |
|---|---|
| `ADAPTER_CERTIFICATION_RECEIPT_REQUIRED` | `--adapter-entry` without `--adapter-certification` |
| `ADMISSION_ARTIFACT_UNKNOWN` | the receipt hash is not in the registry |
| `SCHEMA_VALIDATION_FAILED` | the document is not a valid contract — including a `certified` verdict carrying refusal codes |
| `ARTIFACT_HASH_MISMATCH` | a document's bytes do not produce its declared `core_hash` |
| `ADAPTER_NOT_CERTIFIED` | verdict `refused`, a failed check, or a signature that does not verify |
| `ADAPTER_CERTIFICATION_IDENTITY_MISMATCH` | the receipt names a different manifest, id or version |
| `ADAPTER_IDENTITY_MISMATCH` | the entry's bytes are not the certified bytes — at admission or before any dispatch |
| `ADAPTER_CERTIFICATION_SCOPE_MISMATCH` | certified operations or package kinds differ from the manifest's |
| `ADAPTER_SELF_CERTIFICATION_REFUSED` | the certifier is the adapter |
| `ADAPTER_CERTIFICATION_AUTHENTICATION_REQUIRED` | unauthenticated certification at a scored tier |
| `ADMISSION_RETENTION_FAILED` | the registry already holds a different admission for this manifest |

### What still has to be done by hand

This closes the adapter-admission blocker; it does not make Lab onboarding two
commands. The governor registry, the challenge and journey commitments, the
policies, the limits and the trust policy are still prepared out of band, and
every `HASH` above other than the two admission outputs comes from that
preparation.

## Running a journey through an adapter

```bash
npm run erl2 -- preregister-acquisition --run-root RUN --registry REG --tier development --adapter-entry adapters/reference-correct/dist/src/main.js --adapter HASH --acquisition-source HASH --acquisition-actor-script HASH --acquisition-actor-schema HASH --acquisition-step HASH --package-verification-step HASH --generic-policy HASH --trust-policy HASH --limits HASH --expires 2026-12-31T00:00:00Z
```

Then `acquire`, `freeze-package`, `verify-package` with the same
`--adapter-entry`. After preregistration the run's own frozen preregistration
decides which adapter manifest is bound; passing a different `--adapter` is
`ADMISSION_ARTIFACT_UNKNOWN`, and pointing `--adapter-entry` at a different
adapter is `ADAPTER_IDENTITY_MISMATCH`.

The run also durably retains the certification it was admitted on, so the same
rule holds for it: a later `--adapter-certification` that differs from the
retained receipt is `ADAPTER_CERTIFICATION_IDENTITY_MISMATCH`. The entry's
digest is re-read and compared before **every** dispatch, not once at
admission — replacing the file mid-run is refused before the adapter is
spawned.

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
