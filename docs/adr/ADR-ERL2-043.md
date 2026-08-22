# ADR-ERL2-043 — the supplied public-bundle document, bound to the bundle the run retained

- **Status:** accepted
- **Date:** 2026-08-22
- **Deciders:** Lab Core Owner, Integrity/Security Owner, Public Verifier Owner
- **Extends:** ADR-ERL2-029, ADR-ERL2-030, ADR-ERL2-033
- **Supersedes:** nothing.

## Context

`erl2 verify --public-bundle PATH` reads a document the **caller** supplies. The
retained tree, the lifecycle stream and the trust configuration are all
independently walked, rehashed and re-derived; the supplied envelope was not.
Nothing tied it to the run whose evidence it claimed to describe.

A caller could therefore hand the verifier a completely re-authored envelope and
be told `valid`. Every field of it was writable, and `core_hash` could be
refreshed so the document stayed internally self-consistent: `bundle_id`,
`created_at`, every member `path`, `file_sha256`, `byte_length`, `media_type` and
`classification`, and the declared `core_hash` itself, whether stale or
recomputed.

The clearest statement of the gap is an asymmetry. Falsifying a **retained**
member's `file_sha256` is refused with `ARTIFACT_HASH_MISMATCH`, because the
referenced-bytes layer rehashes the named file. The identical mutation in the
**supplied** copy was accepted, because nothing read the supplied copy that way.
Two structural cases were worse: a run that retained **no public bundle at all**
still verified from a detached copy, and so did one whose only indexed bundle had
been moved **out of `retained/`** — the authority removed, the claim intact.

Two things this is *not*:

- **The bundle being unsigned is not the defect.** It is a container citing
  artifacts that are themselves signed and hash-closed. Signing it at the
  trusted-local tier would mint an authority this tier does not have, and would
  be a new key, a schema change and a new consumer-visible concept.
- **`.frozen` sidecars have no authority to restore.** They have no schema, no
  contract, no registry entry and no verifier content reader. Their
  `file_sha256` is not trustworthy because nothing ever checks it. An
  independent mutation pass confirmed that falsifying, corrupting, emptying,
  deleting or swapping a sidecar's *contents* changes no verdict; only an
  **orphan** marker refuses, and only through the retained-file accounting that
  already existed.

No accepted envelope mutation changed a semantic verdict, because semantic
derivation consumes the artifact index, the lifecycle and the signed attestation
rather than the envelope. The envelope is nonetheless the document a reader
files, cites and re-publishes, and "the verdict was right anyway" is not a
property a consumer can check.

## Decision

Bind the supplied document to authority the run **already retained**. Create no
new authority, no new key, no new schema version and no new refusal code.

Four checks in `packages/public-verifier/src/library/verify.ts`, shared by both
terminal branches:

- **B1 — member path binding.** Every declared `BundleMember` resolves its
  `artifact_core_hash` through the artifact index, and its declared
  `artifact.path` must equal that entry's `logicalPath`. The authority is a
  filesystem fact, not another declaration.
  Refusal: `BUNDLE_MEMBER_MISMATCH`.
- **B2 — supplied core-hash recomputation.** `coreHash(bundle)` is recomputed
  from the supplied canonical object and must equal the supplied declared
  `core_hash` — the same rule `ArtifactIndex.walk` applies to every retained
  document, applied to the one document that was exempt.
  Refusal: `ARTIFACT_HASH_MISMATCH`.
- **B3 — supplied-to-retained binding.** The **recomputed** identity, never the
  declaration, must equal the independently indexed core hash of an artifact of
  schema `public-verification-bundle/v2` whose `logicalPath` begins with
  `retained/`. The retained subtree is filtered explicitly rather than resolved
  through a whole-root lookup, because a bundle indexed outside `retained/` is
  not retained evidence. Any path *beneath* `retained/` is admissible; the
  literal `retained/public-bundle.json` is not required.
  Refusal: `GRAPH_CLOSURE_UNREACHABLE_ARTIFACT`.
- **B4 — creation ordering.** `bundle.created_at >= attestation.finalized_at`,
  the one statement about `created_at` a signed artifact can contradict.
  Refusal: `GRAPH_CLOSURE_TERMINAL_MISMATCH`.

Serialization may differ between the supplied and retained documents: B3 compares
the canonical projection, so an exported pretty-printed copy and the retained
copy bind to each other, as the shipped pre-environment golden already does.

## Placement, and why it is load-bearing

**B4** sits with the existing envelope-to-signed-attestation cross-checks, beside
`attestation.run_id !== bundle.run_id`. It is the same kind of statement: an
unsigned scalar in the envelope required to agree with the signed side. It is
placed immediately *ahead* of the run binding rather than after it, so that the
`pre-environment-bundle-run-binding` negative control keeps the exact source
preimage it anchors on. Re-anchoring that control would have been a change to an
existing test to accommodate this one; moving four lines was not, and the two
placements are equivalent — the checks are independent and neither can mask the
other.

**B1–B3** run at the **tail** of both `verifyPreEnvironmentBundle` and
`verifyEnvironmentBundle` — immediately before the successful `valid` return, and
after contract validation, artifact hashing, referenced-byte verification,
retained-file accounting, lifecycle closure, signature verification, run binding
and semantic derivation.

Early placement was measured and rejected. The supplied envelope disagrees with
the retained tree in *every* case where the retained tree is itself broken, so a
check placed near `ArtifactIndex.scan` answers first and masks seven existing
cases across `ARTIFACT_HASH_MISMATCH`, `GRAPH_CLOSURE_TERMINAL_MISMATCH` and
`GRAPH_CLOSURE_EXTRA_ARTIFACT`. A reader would be told the envelope did not match
when the real fault was in the evidence. Refusal precedence is a consumer-visible
property, and tail placement preserves every pre-existing cause.

Within the tail block the order is B1, then B2, then B3, so the most specific
true statement about a re-authored document — that a member names an artifact it
is not — is the one a reader sees.

## Consequences

**Established by the new binding.** The supplied canonical public-bundle document
is the same canonical document as a public bundle this run retained and indexed;
every declared member path agrees with the retained artifact index; the supplied
`core_hash` identifies the supplied canonical document; the bundle is not
back-dated before signed finalization; and a run retaining no public bundle
cannot be verified from a detached copy alone.

**Deliberately residual, and documented as such.** `bundle_id`, member
`media_type`, member `classification`, and the *post-dating* direction of
`created_at` remain non-authoritative at the trusted-local tier. A producer that
changes one of them consistently across the retained and supplied documents is
still accepted, because no retained byte contradicts it and no semantic verdict
consumes it. That is recorded in `docs/claims/permitted-claims.md` and in
permanent tests, so it is a stated boundary rather than an unexamined one.

**Explicitly not claimed.** This establishes no signature over the bundle, no
authentication of any party, no custody or confinement property, no independent
signing authority, and no production assurance. It is a consistency binding at
the trusted-local tier.

**No version, key or evidence movement.** No schema version changes, no new
signing key is introduced, no committed evidence is regenerated, and no existing
test is weakened, modified or deleted. Schema edits are non-normative `$comment`
text only. Four existing refusal codes are reused; the documentation comment on
`BUNDLE_MEMBER_MISMATCH` is widened to cover a member whose declared
`ArtifactRef` disagrees with the retained artifact it names.

## Alternatives rejected

- **Sign the public bundle.** A new key and a new authority the trusted-local
  tier cannot justify, and a schema change. Rejected.
- **Give `.frozen` sidecars a schema and read them.** Would promote a
  producer-side cache to evidence and add a contract for a record no consumer
  needs. Rejected; the sidecar's non-authority is documented and tested instead.
- **Require the literal path `retained/public-bundle.json`.** Would refuse a
  correctly accounted bundle nested elsewhere beneath `retained/` for no
  integrity reason. Rejected in favour of the subtree rule.
- **Require `created_at == finalized_at`.** Honest producers create the bundle
  after finalizing. Rejected; only back-dating is refused.
- **Place B1–B3 early.** Masks seven pre-existing refusal causes. Rejected.
