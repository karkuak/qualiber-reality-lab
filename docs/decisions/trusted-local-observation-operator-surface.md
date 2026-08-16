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
  draft with this declaration's hash and its own core hash. The draft must omit
  `trusted_local_declaration_hash` and `core_hash` — those are the two fields
  only this command can compute, and a binding you typed by hand is a binding
  nobody verified.

**Read the written declaration before continuing.** That is what this step is
for.

### 2. Run

```
erl2 run-trusted-local-observation \
  --adapter-entry /abs/path/to/adapter/dist/entry.mjs \
  --manifest /abs/path/to/adapter-manifest.v2.json \
  --plan ./observation-plan.json \
  --owner-declaration ./trusted-local-declaration.v1.json \
  --output-root ./observation-run
```

That is the whole workflow. No governor registry, no acquisition
preregistration, no governor hashes, no certification receipt, no certifier
identity, no signature. Reaching for one is refused by name rather than by
unknown-flag accident:

```
--registry-governor is a governed input; trusted-local observation accepts none
```

### What lands in `--output-root`

| path | what it is |
|---|---|
| `trusted-local-observation-record.json` | the retained run story, closed at every level |
| `observation-plan.json` | your exact plan bytes, copied so verification needs nothing else |
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
- the adapter's bytes, re-hashed now.

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

Remove `--output-root`. The declaration and plan are ordinary files you chose
the paths for. Neither command starts anything that outlives it, and neither
writes outside the paths you named.
