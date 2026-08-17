# Running an external `subject-adapter/v2` adapter under trusted-local observation

This is the complete public workflow for one bounded, unscored, owner-operated
local run. Read the first section before the commands.

## What this is, and what it is not

You own the adapter. You have read its source. You accept that its exact bytes
will run as a child process **with your own user's permissions**.

That acceptance is the entire authority. There is no certifier, no signature, no
review, and no second party. The Lab binds the bytes you name and enforces a
claim ceiling; it forms no opinion about what the code does.

| | |
|---|---|
| trust mode | `trusted_local_code` |
| tier | `development` |
| confinement | **absent** |
| independent certification | **absent** |
| scoring | absent |
| governor authorization | absent |
| evidence authenticity | `unauthenticated_local_record` |
| suitable for hostile third-party adapter code | **no** |

### What "confinement is absent" means precisely

`AdapterHost` really does enforce twelve controls: the adapter runs in a
separate process, under a wall-clock deadline, with request and response byte
ceilings, a writable-output-only workspace, an environment-variable allowlist,
bounded diagnostics, and egress adjudication at the broker seam.

Those are operational bounds on a **cooperating** adapter. They are not a
kernel boundary. The adapter process shares your filesystem and your network
authority, and an adapter that does not cooperate is outside what any of them
constrain. The retained record carries the host's control report verbatim,
including the thirteen controls it reports as `unsupported_on_this_host`, so a
reader can see the shape of that gap rather than infer it.

If you need a real boundary, this is not the path.

## The workflow

Two commands. The first writes down what you are accepting; the second runs it.
The split is deliberate: the declaration is the only artefact stating the terms,
so it exists as reviewable bytes on disk — hashes included — before anything
executes.

### 1. Declare

```
erl2 declare-trusted-local-adapter \
  --adapter-entry /abs/path/to/adapter/dist/entry.mjs \
  --manifest /abs/path/to/adapter-manifest.v2.json \
  --acknowledge-trusted-local-code "I ACCEPT THAT THESE EXACT ADAPTER BYTES EXECUTE WITH MY LOCAL USER PERMISSIONS, ARE NOT SANDBOXED AND ARE NOT INDEPENDENTLY CERTIFIED, AND THAT THE RESULTS ARE DEVELOPMENT-ONLY, UNSCORED AND UNAUTHENTICATED" \
  --acknowledged-by "your name" \
  --declaration-id my-adapter-declaration \
  --output ./trusted-local-declaration.v1.json \
  --seal-plan-draft ./observation-plan.draft.json \
  --plan-output ./observation-plan.json
```

The acknowledgement must be that exact sentence. There is no `--yes`, no
`--force`, and no boolean equivalent; `yes`, `true` and a lowercased copy are
all refused, and the refusal prints the sentence you need.

Optional:

- `--source-repository` / `--source-commit` / `--source-tree`, supplied
  together, record an exact source coordinate. It is an owner assertion; the
  Lab binds artifact bytes, never a repository.
- `--owner-test-evidence` / `--owner-test-evidence-label`, supplied together,
  retain a digest and a length of whatever testing you claim to have done,
  marked `owner_supplied_unauthenticated`. The Lab does not read it, run it, or
  conclude anything from it.
- `--seal-plan-draft` / `--plan-output`, supplied together, stamp your plan
  draft with this declaration's hash and every hash the plan needs. The draft
  must omit all four of

  ```
  trusted_local_declaration_hash
  core_hash
  resource_limits.core_hash
  egress_policy.core_hash
  ```

  A draft that pre-carries any of them is **refused, not overwritten** — if you
  computed one wrongly, or copied it from another plan, you should find out
  rather than get a valid plan back with your number silently discarded.

  The three hashes are computed in dependency order: `resource_limits`, then
  `egress_policy`, then the plan itself, whose `core_hash` covers both of the
  nested ones. Then the completed plan is validated against the closed schema
  before it is written. A binding or a hash you typed by hand is a number
  nobody verified, and the failure mode is a run refusing later with a message
  about a stale limits document.

**Read the written declaration before continuing.** That is what this step is
for.

### 2. Run

```
erl2 run-trusted-local-observation \
  --adapter-entry /abs/path/to/adapter/dist/entry.mjs \
  --manifest /abs/path/to/adapter-manifest.v2.json \
  --plan ./observation-plan.json \
  --owner-declaration ./trusted-local-declaration.v1.json \
  --output-root ./observation-run \
  --bind-input config-file=/abs/path/to/config.json \
  --bind-input fixture-archive=/abs/path/to/fixture.tar
```

`--bind-input` is repeatable and is covered in its own section below. A plan
that declares no host-provisioned inputs needs none of them.

That is the whole workflow. No governor registry, no acquisition
preregistration, no governor hashes, no certification receipt, no certifier
identity, no signature. Reaching for one is refused by name rather than by
unknown-flag accident:

```
--registry-governor is a governed input; trusted-local observation accepts none
```

### Supplying the inputs your plan declares: `--bind-input`

Every plan input whose `provenance_mode` is `host_provisioned` names bytes the
Lab has to put somewhere the adapter can read. The plan says *what* those bytes
are — a logical path, a length and a SHA-256 — and never says where they live on
your machine. `--bind-input` is where you say that:

```
--bind-input <input_id>=<absolute-source-path>
```

The set must be **exact**. One binding per host-provisioned input, no more and
no fewer. Each of these is a refusal:

| what you did | why it refuses |
|---|---|
| left an input unbound | the adapter would read a file that is not there |
| bound one input twice | two answers to one question |
| named an input the plan does not declare | you are supplying something nothing uses |
| bound an `acquired` input | the adapter produces it during the run; the plan shape cannot express provisioning it |
| wrote something other than `id=path` | there is no positional or inferred form |
| gave a relative path | the run must not depend on where you were standing |
| gave a symlink, a directory, or anything not a regular file | a symlink's target can be repointed between the check and the read |
| gave a path inside `--output-root` | a run may not provision itself out of the tree it is about to write |

An extra binding is refused as loudly as a missing one, and deliberately so: a
missing binding fails visibly, but an operator who believes they supplied a file
the run never used has been told nothing by that run succeeding.

#### The path convention

Each host-provisioned input's `artifact.path` is read as

```
<input_root>/<mount_id>/<relative-file-path>
```

where `input_root` is your plan's `resource_limits.input_root`. The first
segment beneath the input root names a **mount**; everything after it is a file
inside that mount. So a plan carrying

```
observation-inputs/fixtures/cases/first.json
observation-inputs/fixtures/cases/second.json
observation-inputs/config/settings.json
```

produces two mounts — `fixtures` and `config` — not three, and not one per file.

A path outside the input root, a path containing traversal, an empty mount id,
an empty relative path, a path that is only a mount root with no file in it, and
two inputs that would land on one destination are all refused before anything is
created.

#### Copy and retain

The bound bytes are **copied**, not referenced. For each input the run opens the
source once, streams it to a staging file beneath the output root, computes the
SHA-256 and the length *from those same streamed bytes*, compares both against
the plan, sets the file to mode `0400`, and publishes it atomically at

```
<output-root>/inputs/<mount_id>/<relative-file-path>
```

There is deliberately no hash-then-copy: reading the source twice would admit a
file swapped between the two reads, so what was retained would not be what was
checked.

A digest or length mismatch refuses **before** any admission byte or run record
is retained, and removes everything the attempt created. An existing
`inputs/` tree is never overwritten — a second run into the same root refuses,
and the first run's inputs survive byte for byte.

#### Ceilings

There are three, and they are internal constants rather than plan fields:

| ceiling | value |
|---|---|
| host-provisioned inputs per plan | 64 |
| bytes per input | 64 MiB |
| bytes in total | 256 MiB |

They are not derived from `max_output_files` or `max_output_bytes`. Those bound
what the *adapter produces*; reusing one because its number looked convenient
would mean raising an output ceiling silently raised an input ceiling nobody
reasoned about. The plan schema has no input-side limit today and this path does
not add one.

#### What the mount is, and is not

Each mount is read-only and its purpose is `subject-visible-input`. The adapter
is told the mount **root**, never an individual artifact path, which is what
lets several files share one mount. `AdapterHost` fingerprints every mount
before the adapter sees it and refuses the run if the tree changed.

That is not confinement. On the process profile nothing in the kernel prevents a
write; the fingerprint *detects* one afterwards. The mode bits and the
owner-only directories are the same kind of thing — bounds on a cooperating
adapter, not isolation from you.

A matching digest says the retained file is the file your plan described. It
confers no certification, no confinement, no scoring, no authentication, no
governor authorization and no production readiness, and it says nothing at all
about what the adapter does with the bytes.

### What lands in `--output-root`

| path | what it is |
|---|---|
| `trusted-local-observation-record.json` | the retained run story, closed at every level |
| `observation-plan.json` | your exact plan bytes, copied so verification needs nothing else |
| `inputs/<mount_id>/…` | the bytes you bound, copied and mode `0400` |
| `registry/trusted-local-adapters/<manifest-hash>/` | the exact manifest and declaration bytes as you supplied them |
| `workspace/`, `store/` | the host's own working directories |

Nothing is written outside this root by the Lab. The adapter's own reach is
bounded only by your user's permissions.

An existing record is never overwritten: a second run into the same root
refuses, and the first run's evidence survives byte for byte.

## What the run proves, and what it does not

The command verifies its own retained evidence offline before it returns, and
reports the result. That verification rebuilds the run from the plan bytes and
the retained admission rather than checking the record against itself:

- the plan's core hash and file hash, recomputed from the bytes you supplied;
- the run identity, against the plan;
- the declaration-to-manifest and declaration-to-artifact bindings;
- the exact ordered operation list the plan reaches, one outcome each;
- every operation record's own hash, request hash and response-envelope hash;
- the predecessor chain, derived rather than read;
- cleanup and residue, from the retained final report and nowhere else;
- the terminal status, recomputed from the outcomes;
- the claim ceiling, and that the embedded declaration is the retained one;
- the adapter's bytes, re-hashed now;
- **the retained input tree, re-hashed now** against the retained plan's own
  host-provisioned ArtifactRefs.

That last one is the plan-as-ledger property: the record does not carry a second
list of input claims, because the plan already names every one and the record is
bound to those exact plan bytes through `plan_hash` and `plan_file_hash`. Two
lists could disagree; one cannot. Modified bytes, a wrong length, a missing
file, a file nobody planned, a symlink and a non-regular file are each refused.

The retained input root is reported in the run summary as `retained_input_root`
so you can verify later. It is not written into the record: an absolute path on
your machine is not portable evidence, and a reader elsewhere could only mistake
it for one. It is always `inputs/` beneath the output root you chose.

It does **not** prove that the adapter is correct, safe, isolated, reviewed, or
ready for anything. Nothing converts this record into a score, a validity
verdict, a governor authorization or a public verification bundle, and there is
no command that would.

## Two things that will surprise you

### A plan with `start` and no `stop` never reaches a clean terminal

A successful `start` creates a stop obligation, and the reducer will not
discharge an obligation nothing discharged. If your profile declares `start` but
not `stop`, every operation can dispatch and complete and the terminal will
still be `cleanup_incomplete`. That is the honest answer. The record is retained
either way, and the command exits nonzero.

### Your manifest's operation order must match your adapter's

`AdapterHost` compares the operation list your adapter negotiates against your
manifest's **positionally**, not as a set. A manifest with the right operations
in a different order is refused — and refused as *"the adapter process ended
without a valid response"*, which names the symptom rather than the cause.

If you see that message and your adapter runs fine on its own, compare the two
orderings first.

## Cleanup

Remove `--output-root`. That is still the whole cleanup: the materialized inputs
live beneath it, so removing the root removes them too. The retained input files
are mode `0400` inside owner-only directories, which a recursive remove handles
— the directories are yours and writable.

The bytes you *bound* are your own files in your own locations and are never
touched; only the copies beneath the output root are. The declaration and plan
are likewise ordinary files you chose the paths for. Neither command starts
anything that outlives it, and neither writes outside the paths you named.
