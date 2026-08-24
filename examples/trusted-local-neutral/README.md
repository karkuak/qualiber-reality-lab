# A neutral trusted-local worked example

Everything here runs the supported trusted-local observation path end to end,
from files committed to this repository, against a product-neutral adapter that
is already committed here too. It exists so that "the trusted-local path is
externally operable" is something you can *execute* rather than something you
have to take on trust — and so that continuous integration executes it on every
change, which is what keeps the documented path from quietly rotting.

Read [the trusted-local operator surface](../../docs/decisions/trusted-local-observation-operator-surface.md)
for the complete procedure this example is one concrete instance of, and
[the troubleshooting and refusal reference](../../docs/decisions/trusted-local-observation-troubleshooting.md)
when a run refuses.

## Exactly what this proves, and exactly what it does not

It proves one thing: **a bounded, unscored, owner-operated, development-tier
local observation of an external `subject-adapter/v2` adapter completes, cleans
up, and verifies offline afterwards** — on this machine, for these bytes, under
a declaration written by the operator who ran it.

That is the whole claim. In particular this example is **not**:

- **not certification.** No party certified the adapter. `certification_receipt_hash`
  is a zeroed sentinel, `independent_certification` is `absent`, and there is no
  command anywhere in this repository that would turn this record into a receipt.
- **not independent assurance.** The operator is the only authority in the loop.
  Nobody reviewed the adapter, and nothing here is a second opinion about it.
- **not confinement.** The adapter runs as a child process **with your own
  user's permissions**, sharing your filesystem and your network authority. The
  host enforces operational bounds — a separate process, a wall-clock deadline,
  request and response ceilings, a writable-output-only workspace, an
  environment-variable allowlist, bounded diagnostics — on a *cooperating*
  adapter. Those are not a kernel boundary. The record carries the host's own
  control report verbatim, including the thirteen controls it reports as
  unsupported on this host, so the shape of the gap is visible rather than
  inferred.
- **not production key custody.** `build-manifest.mjs` signs the manifest with
  `developmentKey("trusted-local-neutral-example-owner")`, an Ed25519 key derived
  deterministically from that label by code committed in this repository. Anyone
  with a clone can regenerate the identical key and the identical signature. The
  `key_id` says so on its face — it begins `erl2-dev-`. It is not a production
  signing authority, it is not held in custody anywhere, and it is not evidence
  of authorship. On this path nothing verifies it cryptographically in any case:
  every check recomputes and compares `core_hash`.
- **not a statement that any product is correct.** The Lab forms no opinion
  about what adapter code does.
- **not a verdict on subject quality.** Nothing here scores, grades, qualifies or
  evaluates any subject. `not_scored` is `true` in the plan and in the record.
- **not governed admission.** This is the owner-operated development path.
  `not_governor_authorized` is `true`; no governor authorized anything, and no
  route converts this record into a governed one.
- **not readiness for opaque third-party code.** The entire authority is that
  *you read the adapter's source and accept its exact bytes*. An adapter you
  cannot read is outside what this path is for; it is not suitable for hostile
  or unreviewed third-party adapters.
- **not a claim about scale.** One adapter, one plan, twelve operations, one
  small input, one machine. Nothing here measures or implies broad scalability.

The full claim boundary is in [`docs/claims/permitted-claims.md`](../../docs/claims/permitted-claims.md);
the paragraphs above state it rather than only pointing at it, because a reader
who never follows the link has otherwise been told nothing.

## Prerequisites

- Node.js 22 or newer.
- A built workspace: run `npm ci && npm run build` from the repository root
  first. Both the CLI (`packages/cli/dist/src/bin.js`) and the bare-specifier
  imports in this example's own scripts (`@erl2/integrity`, `@erl2/contracts`,
  `@erl2/core`) depend on it. Node resolves those specifiers by walking up from
  each script's own directory, so these scripts must stay inside the workspace
  tree; that is the same constraint the CLI entrypoint already carries.
- Nothing else. No network access, no container runtime, no credentials, no
  configuration.

## Run it

```bash
./examples/trusted-local-neutral/run-example.sh
```

That is the whole example. It creates a fresh `mktemp -d` scratch root, prints
the path, performs the four steps below in order, and leaves the scratch root in
place so you can read what it produced.

The four steps, exactly as `run-example.sh` performs them:

**1. Seal the adapter manifest.**

```bash
node examples/trusted-local-neutral/build-manifest.mjs "$SCRATCH/manifest.json"
```

`SubjectAdapterManifestV2` requires `core_hash` and `signature`, and no CLI
command produces either — `declare-trusted-local-adapter` *consumes* an
already-signed manifest. This script reads `manifest.draft.json`, recomputes the
adapter's artifact hash from the fixture's actual bytes with `hashBytes`, applies
`sealSigned(draft, developmentKey(label))` — two public `@erl2/integrity`
exports, which together produce both required fields — validates the result with
`assertContract("SubjectAdapterManifestV2", …)`, and only then writes it to the
path you named. It writes nowhere by default and refuses to overwrite. Its output
is byte-identical across runs.

**2. Declare the adapter and seal the plan.**

```bash
node packages/cli/dist/src/bin.js declare-trusted-local-adapter \
  --adapter-entry fixtures/neutral/neutral-full-lifecycle-observer.mjs \
  --manifest "$SCRATCH/manifest.json" \
  --acknowledge-trusted-local-code "I ACCEPT THAT THESE EXACT ADAPTER BYTES EXECUTE WITH MY LOCAL USER PERMISSIONS, ARE NOT SANDBOXED AND ARE NOT INDEPENDENTLY CERTIFIED, AND THAT THE RESULTS ARE DEVELOPMENT-ONLY, UNSCORED AND UNAUTHENTICATED" \
  --acknowledged-by "trusted-local neutral example operator" \
  --declaration-id "trusted-local-neutral-example" \
  --output "$SCRATCH/declaration.json" \
  --seal-plan-draft examples/trusted-local-neutral/plan.draft.json \
  --plan-output "$SCRATCH/plan.sealed.json"
```

The acknowledgement is an exact sentence, not a `--yes`. `--seal-plan-draft`
stamps the draft with the declaration binding and the three nested hashes
(`resource_limits.core_hash`, `egress_policy.core_hash`, then the plan's own
`core_hash`, in that order), which is why `plan.draft.json` carries none of
them; supplying one by hand is refused rather than silently overwritten.

**3. Run the observation.**

```bash
node packages/cli/dist/src/bin.js run-trusted-local-observation \
  --adapter-entry fixtures/neutral/neutral-full-lifecycle-observer.mjs \
  --manifest "$SCRATCH/manifest.json" \
  --plan "$SCRATCH/plan.sealed.json" \
  --owner-declaration "$SCRATCH/declaration.json" \
  --output-root "$SCRATCH/output" \
  --bind-input "package-input=$PWD/examples/trusted-local-neutral/input/package.bin"
```

**4. Verify it independently.**

```bash
node examples/trusted-local-neutral/verify-example.mjs "$SCRATCH/output" "$SCRATCH/run-summary.json"
```

The run command verifies its own retained evidence before returning, and this
script asserts that it reported `terminal_status: "observed_complete"`,
`cleanup.status: "cleanup_complete"` and `offline_verification.ok: true`. Then it
throws that away and verifies the retained bytes from scratch, in its own fresh
process, through `@erl2/core`'s public `verifyTrustedLocalObservationRecord` —
which rebuilds the run from the retained plan bytes and the retained admission,
re-hashes the adapter and the retained input tree *now*, recomputes the terminal
status, and compares. Trusting the producer's own summary would prove nothing
about a producer that lied.

The CLI is invoked as `node packages/cli/dist/src/bin.js` throughout. Nothing in
the documented setup puts a bare `erl2` binary on your `PATH`.

## Committed here, versus generated by a run

**Committed** — nine files, all hand-authored, all readable before you run
anything:

| file | what it is |
|---|---|
| `README.md` | this document |
| `manifest.draft.json` | the manifest with every required field except the two `build-manifest.mjs` seals |
| `build-manifest.mjs` | the documented seal-and-validate step |
| `plan.draft.json` | the observation plan with every field except the ones `--seal-plan-draft` computes |
| `hash-input.mjs` | reproduces the input digest and length the plan draft declares |
| `input/package.bin` | 91 fixed, neutral bytes — a stand-in payload, not evidence |
| `run-example.sh` | the four steps above, in order |
| `verify-example.mjs` | the two-pass verification |
| `cleanup-example.sh` | the guarded removal of one scratch root |

**Generated, and deliberately never committed** — the sealed `manifest.json`,
the sealed plan, the owner `declaration.json`, and the whole observation output
tree including `trusted-local-observation-record.json`. Every one is produced
fresh on every run, into the scratch root, and none is compared against a stored
copy. A committed sealed artifact would be a second golden-evidence system that
could silently stop matching what the current code produces — and the
declaration and the record embed a real clock reading, so neither is
byte-reproducible run to run and committing either would be actively wrong. This
is also what makes the CI exercise meaningful: it re-derives everything from the
committed drafts each time, so the documented path cannot rot unnoticed.

The adapter is **reused, not copied**: this example authors no adapter code at
all. It points at
[`fixtures/neutral/neutral-full-lifecycle-observer.mjs`](../../fixtures/neutral/neutral-full-lifecycle-observer.mjs)
where that file already lives.

## Substituting your own adapter and your own input

Six edits, and three traps worth knowing before you make them.

1. **Point at your adapter.** Replace `fixtures/neutral/neutral-full-lifecycle-observer.mjs`
   in `run-example.sh` (both `--adapter-entry` occurrences and the constant at
   the top) with the path to your own built adapter entry file.
2. **Rewrite `manifest.draft.json`.** Set `adapter_id` and `version` to yours,
   set `adapter_artifact_hash` to your entry file's digest — `hash-input.mjs`
   prints it for any file — and set `protocol_support[0].operations` to your
   adapter's operations (see trap 2).
3. **Replace `input/package.bin`** with your own bytes, or add more inputs.
4. **Update the plan's input ledger.** Run
   `node examples/trusted-local-neutral/hash-input.mjs <your-file>` and copy the
   printed `file_sha256` and `byte_length` into the matching entry of
   `plan.draft.json`'s `inputs[]`. There is no command that derives them for you.
5. **Update the plan's operations** to the ones you want dispatched, with a
   payload each, in the manifest's declared order.
6. **Bind your input** by changing `--bind-input package-input=<absolute path>`
   in `run-example.sh` — one binding per host-provisioned input, no more and no
   fewer.

### Trap 1 — your adapter must truthfully declare `subject-adapter/v2`

A local observation offers **only** `subject-adapter/v2` and requires the
`local_observation` execution mode. Your adapter definition must therefore
declare

```js
supportedProtocolVersions: ["subject-adapter/v2"],
```

and it must be true — the field is the adapter's own statement about which
protocol it actually implements, and the operations it answers have to match.
This is a positive authoring requirement, not a formality: it is the field the
host's negotiation reads to decide whether this adapter can serve a v2-only
local offer at all. An adapter that omits it is not offering v2, and a v2-only
local offer has nothing to negotiate with. Declare it, and implement it.

### Trap 2 — the manifest's operation order must match your handler order

`@erl2/adapter-sdk` reports the operations your adapter supports as **the key
order of your `handlers` object**, and `AdapterHost` compares that list against
your manifest's `protocol_support[].operations` **positionally, not as a set**.
The right operations in a different order are refused — and refused as *"the
adapter process ended without a valid response"*, which names the symptom rather
than the cause.

Derive the list from your handler keys, in source order. Do **not** derive it
from `declaredEntrypoints`: in the very fixture this example reuses, the two
orders genuinely differ — `declaredEntrypoints` ends `…, "report-residue",
"compensate"` while the `handlers` object ends `…, compensate, "report-residue"`.
Copying the field with the more natural-looking name is exactly how this bites.

This example's manifest declares all thirteen handler keys, in handler order,
because that is what the adapter negotiates. Its *plan* drives twelve of them:
`compensate` is declared but not dispatched, because a compensation payload has
to name the receipt hash of a mutation being reversed, and this neutral observer
declares no mutations. A plan may drive a subset of the manifest's operations, in
the manifest's order; it may never reach past it.

### Trap 3 — resource limits and input binding

- **Three separate ceilings can produce `ADAPTER_LOCAL_LIMIT_EXCEEDED`,** and
  only some of them are plan fields: your plan's `resource_limits`, the host's
  own constructor ceilings, and the output freezer's defaults (64 files, 1 MiB
  total, path depth 6, 64 KiB of diagnostics). A plan whose `max_output_bytes`
  looks generous can still hit a freezer default nothing in the plan mentions.
  This example stays well beneath all three.
- **Input ceilings are internal constants, not plan fields:** 64 host-provisioned
  inputs per plan, 64 MiB per input, 256 MiB in total. They are not derived from
  the output limits.
- **`artifact.path` is `<input_root>/<mount_id>/<relative-path>`,** where
  `input_root` is your plan's `resource_limits.input_root`. This example's single
  input is `observation-inputs/package-mount/package.bin`: input root
  `observation-inputs`, mount `package-mount`, file `package.bin`. The first
  segment beneath the input root names a *mount*, so several files can share one.
- **The binding set must be exact.** A missing binding, a duplicate, an unknown
  id, an extra one, a relative path, a symlink, or a path inside `--output-root`
  is a refusal. An extra binding refuses as loudly as a missing one, deliberately:
  an operator who believes they supplied a file the run never used has learned
  nothing from that run succeeding.
- **`--output-root` must not already contain an `inputs/` tree.** A second run
  into the same root refuses rather than overwriting; use a fresh root each time,
  which is what `mktemp -d` is doing here.
- **Plan timestamps are not a freshness clock.** Each request's deadline is
  computed as the plan's own `created_at` plus that operation's `timeout_ms`, and
  must not exceed `expires_at`; nothing compares either field against the current
  time. So this example's committed `created_at`/`expires_at` pair stays valid
  indefinitely, and the run is reproducible rather than expiring on a calendar.

## Cleanup

`run-example.sh` writes nothing into the repository — everything it generates
lives under the scratch root it prints. Remove that root when you are done:

```bash
./examples/trusted-local-neutral/cleanup-example.sh /path/printed/by/run-example.sh
```

The script takes one absolute path and refuses everything else. It requires the
target to be a real directory rather than a symbolic link, to carry this
example's name prefix and the ownership stamp `run-example.sh` writes, to sit
directly beneath the temporary root, and not to be a filesystem root, a shared
temporary root, a home directory, a git repository, or an ancestor of one. If any
check fails it removes nothing and says which one.

The bytes you *bound* are never touched: only the copies beneath the output root
are. Neither command starts anything that outlives it — no daemon, no listener,
no container, no network and no volume — and neither writes outside the paths
named above.
