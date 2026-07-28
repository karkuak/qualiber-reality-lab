# ADR-ERL2-019 — complete artifact accounting, complete signed-member verification, and a totally typed CLI surface

**Status:** accepted
**Date:** 2026-07-26
**Deciders:** Lab Core Owner, Integrity/Security Owner, Verifier Reviewer
**Supersedes:** nothing. Completes ADR-ERL2-018 (whose §4 "zero new retained
evidence" guarantee was stated but only implemented for the port-dispatching
entrypoints) and closes the remaining verifier gaps behind review P1-1, P2-2 and
P2-3.
**Normative source:** `external-reality-lab-design-v2.md` revision
`2.0.0-draft.11` §14 steps 6-7 (mandatory closure: unreferenced artifacts
invalidate closure), §16.2-16.3 (byte and signature verification), §20 (failure
ownership), Appendix B (error-code catalog), Appendix C (CLI contract);
remediation prompt §6.1, §6.3, §6.4, §8.2, §9.1, §11.9, §11.12.

## Context

Slice 6R's first passes closed the specific defects the independent review
reproduced. Re-running an adversarial battery against the *fixed* build showed
that four of them were closed only along the exact path the review had walked,
and that two further defects of the same class had never been reported. All six
were reproduced first-hand through the shipped CLI in fresh processes.

1. **Unindexable retained extras escaped the rejected-extra rule.**
   `derivePreEnvironmentClosure` folds `rejected_extra_hashes` into the verdict
   (the P1-1 fix), but that rule only ever sees artifacts the *index* produced.
   `ArtifactIndex.walk` silently skips any file it cannot index: a name that is
   not `.json`, bytes `parseStrictJson` refuses, a JSON array or scalar, or an
   object without both `schema_version` and `core_hash`. A rogue `.bin`, a rogue
   duplicate-key `.json`, a rogue `.json` with no `core_hash` and a rogue JSON
   array each left `erl2 verify … --offline` reporting **exit 0 / `valid`**. The
   P1-1 invariant was defeated through the skip path instead of the index path.

2. **Five retained signed members were never signature-verified.** The verifier
   checked Ed25519 on the final attestation, the signer inventory, the trust
   policy root and the timestamp checkpoints. The acquisition source manifest,
   the acquisition preregistration, its verification receipt, the subject adapter
   manifest and the generic run policy rode in on hash closure alone — and a
   signature field is excluded from `core_hash` by design, so no hash anywhere
   changes when one is corrupted. Flipping a single base64 character of any of
   the five left the bundle verifying **exit 0 / `valid`**. All five are named by
   the run's own signer inventory as `complete_for_terminal_chain`.

3. **The invalid-record path verified no signatures at all.**
   `verifyInvalidRecord` accepted `localTrust` and never constructed a
   `TrustEvaluator`, though an invalid record retains five-plus signed members
   (including, on a cancellation, the signed cancellation request).

4. **A refused command still wrote retained evidence.** ADR-ERL2-018 §4 requires
   a refusal to cause "zero external calls and zero new retained evidence", but
   `assertSubjectPortExecutable` was wired only into `acquire()` and
   `verifyPackage()`. `freezePackage()` and `freezeSubjectOutput()` froze their
   bytes first and only then appended the lifecycle event that rejects an
   ineligible state. A post-terminal `freeze-output` was therefore correctly
   refused with exit 11 **and still** froze `retained/subject-output-manifest.json`
   into a finished run — turning that run's previously verifying
   `InvalidLabRunRecordV1` into a `GRAPH_CLOSURE_EXTRA_ARTIFACT` refusal. A
   benign operator retry destroyed the verifiability of a terminal record.

5. **The CLI could still exit untyped.** The review's P3 torn-snapshot crash was
   repaired at its own site, but `runCommand` rethrew any non-`Erl2Error` and
   `bin.ts` had no top-level guard. A missing or malformed `--public-bundle`,
   `--record` or `--root-config` escaped as a raw `ENOENT`/`SyntaxError` stack
   trace on stderr with exit 1, no code, no `authority_scope` and no envelope —
   defeating the Appendix B/C guarantee for the verifier's own entrypoints.

6. **The evidence byte-pin excluded far more than it needed to.** The pin
   excluded the whole `adapter-platform/**` subtree (166 files). Generating twice
   and diffing shows only **seven** files are genuinely unstable, so 159
   deterministic files — including the real out-of-process adapter protocol
   evidence — were unpinned without cause.

## Decision

### 1. Every retained *file* is accounted for, not only every indexed artifact

`verifyRetainedFileAccounting` walks the `retained/` subtree itself and requires
each regular file to be accounted for by exactly one of: an indexed JSON
artifact; the `.frozen` freeze marker of an accounted content file; a path
referenced by an `ArtifactRef`/logical byte descriptor carried by an indexed
artifact; or a content-addressed store file whose digest an indexed artifact
declares. Anything else — including a symlink or a non-regular entry — is a
`GRAPH_CLOSURE_EXTRA_ARTIFACT` refusal. It reuses the *same* descriptor set
`verifyReferencedBytes` rehashes, so the two checks cannot drift.

It runs **after** the closure derivation in all three paths, so a genuinely
missing mandatory role keeps its own, more fundamental cause
(`GRAPH_CLOSURE_UNREACHABLE_ARTIFACT`) rather than surfacing as its orphaned
freeze marker (§11.12 cause specificity).

### 2. Every signed member is verified against a verifier-owned role table

`verifySignedMembers` verifies the signature of **every** retained artifact
carrying `signature`, `root_signature` or `wrapper_signature`. The expected
signer role and signing domain come from a table owned by the **verifier**, never
from the producer's claim, so a bundle that signs the adapter manifest with the
preregistrar's key is refused even though both keys are pinned. For each member
it recomputes the core hash, enforces the `signed_hash` binding, checks the
pinned policy grants the key that role, verifies the Ed25519 bytes under the
declared domain, and evaluates revocation at the security instant.

A retained artifact that carries a signature field for a contract **not** in the
table is refused outright. This is the fail-closed gate the environment and
selection branches inherit: retaining a `selection-verification-receipt/v2` (or
any other signed contract) before Slice 6.5 declares its authorized signer role
refuses rather than waves through.

The signer inventory is read as **evidence, never authority**: each entry must
name a retained artifact of the declared schema signed by the declared key, and
an entry naming an absent artifact is `INVENTORY_ENTRY_MISSING`.

### 3. `verify-record` authorizes an invalid record's signed members

`verifyInvalidRecord` now builds a `TrustEvaluator` from the trust policy the run
mirrors into `retained/trust-policy.json` at preregistration — authorized only
against the verifier's own locally pinned head, never on its own say-so — and
runs the same signed-member pass.

**Compatibility.** An invalid record that does not retain exactly one mirrored
trust policy is refused with `TRUST_HEAD_NOT_LOCALLY_PINNED`. This is a
deliberate tightening: without a pinned head there is no way to authorize any of
the record's signatures offline, and silently skipping verification when the
policy is absent would let an attacker disable signature checking by deleting one
file. The shipped producer (`RunWorkspace.preregisterAcquisition`) has always
mirrored the policy, so every real record satisfies this. Only the hand-assembled
`fakeRun.ts` invalid fixtures did not; they have been aligned with the producer
and the three `invalid-run-*` goldens regenerated under an authorized
`evidence:update`. No frozen schema changed shape or meaning.

### 4. State validation precedes every freeze, not only every port dispatch

`assertSubjectPortExecutable(state)` is called at the top of `freezePackage()`
and `freezeSubjectOutput()`, before any read or freeze — making ADR-ERL2-018 §4's
"zero new retained evidence" guarantee true of the artifact-freezing entrypoints
as well as the port-dispatching ones.

### 5. No CLI outcome is untyped

`runCommand` converts any escaped throwable into a Lab-owned
`LAB_UNEXPECTED_FAILURE`, and `bin.ts` wraps dispatch so nothing can print a raw
stack trace. Caller-supplied JSON documents load through one helper that maps a
missing file to `CFG_MISSING_REQUIRED` and unparseable bytes to
`SCHEMA_VALIDATION_FAILED`. `LAB_` is an **append-only** addition to the
Appendix B prefix catalog; an unexpected Lab failure has no dedicated Appendix B
exit, so it takes the documented fallback (2) and the *code*, not the exit,
carries the true cause.

### 6. Evidence exclusions are per-file with a named cause

`evidence:verify` excludes individual files, each with a printed reason, instead
of whole subtrees: `**/request.frames` (absolute adapter-workspace path baked
into the frames), `**/grandchild.pid` (a real OS pid from the supervisor
tree-kill fixture) and `cli-transcript.json` (absolute CLI path arguments).

## Consequences

- The offline verifier refuses a strictly larger set of hostile inputs. Nothing
  that verified before and is genuinely well-formed stops verifying: the full
  suite and the byte-pin are green.
- Byte-pin coverage rises from 621 files (166 excluded) to **780 files (7
  excluded)**, and each exclusion is named and printed rather than implied.
- A signed contract cannot be added to a retained closure without also declaring
  its authorized signer role — a deliberate speed bump on the Slice 6.5 branch.
- Historical invalid records produced before the trust policy was mirrored would
  be refused. No such record exists outside the regenerated fixtures.

## Evidence

- `tests/adversarial/offlineVerifierMutations.test.ts` — 26 cases through the
  shipped CLI in fresh processes; 12 of them fail if the corresponding protection
  is removed (verified by disabling each in turn).
- `tests/adversarial/postRevealExecution.test.ts` — `POST-TERMINAL-NO-WRITE`
  asserts every refused post-terminal command adds zero retained evidence; fails
  if either pre-freeze guard is removed.
- `tests/e2e/typedRefusals.test.ts` — eight cases asserting one parseable
  envelope, a catalogued Appendix B code, the Lab authority scope, an empty
  stderr, and an envelope `exit_code` equal to the process exit.
- `npm run evidence:verify` — 780 files byte-identical to the pin; two
  independent generations into separate directories are byte-identical.
