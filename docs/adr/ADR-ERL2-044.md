# ADR-ERL2-044 — `Instant` is a calendar, not a shape

- **Status:** accepted
- **Date:** 2026-08-22
- **Deciders:** Lab Core Owner, Integrity/Security Owner, Public Verifier Owner
- **Extends:** ADR-ERL2-043
- **Supersedes:** nothing.

## Context

An independent adversarial review of PR #25 confirmed ADR-ERL2-043's four
checks and recorded one finding against B4, the check that refuses a public
bundle claiming to predate the attestation it carries.

`Instant` is the workspace's only timestamp type: one `$defs` entry in
`common.schema.json`, referenced from thirteen schemas. Its `$comment` has
always read "UTC RFC 3339 with second precision and a literal Z". The pattern
under it did not say that. It said four digits, a hyphen, two digits, a hyphen,
two digits, `T`, and three more two-digit fields:

```
^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$
```

That is a shape, and a shape admits dates that do not exist —
`2026-06-31T23:59:59Z`, `2026-02-30T00:00:00Z`, `2026-02-29T00:00:00Z` in a
common year, `2026-01-01T24:00:00Z`, `2026-12-31T23:59:60Z`.

`Date.parse` does not refuse those. It **rolls them forward**:

```
2026-06-31T23:59:59Z  ->  2026-07-01T23:59:59Z
2026-02-30T00:00:00Z  ->  2026-03-02T00:00:00Z
2026-01-01T24:00:00Z  ->  2026-01-02T00:00:00Z
```

Forward is the direction that matters. A stamp a reader parses as June was
compared as July, so a bundle whose `created_at` **read** as before the signed
`finalized_at` could satisfy `created_at >= finalized_at` and be accepted. B4
computed the ordering it was asked for; the document said something other than
what it was compared as. That is the same defect ADR-ERL2-043 exists to close —
a document that cannot be read as what it is verified as — one layer down.

**B4 is not the only site.** Roughly thirty-five places across five packages
turn an `Instant` into a number with `Date.parse`: trust-key validity windows
and revocation effective times, timestamp-checkpoint chain ordering, selection
round ordering against the pool anchor, environment lease expiry, adapter
request deadlines against plan expiry, evidence-window and cutoff arithmetic,
and the public bundle's back-dating check. Every one of them inherited the same
confusion. None of them is wrong; all of them were resting on a contract that
under-enforced its own stated meaning.

The gap is inherited rather than introduced. It predates ADR-ERL2-043, which
neither widened nor narrowed it.

## Decision

Make `Instant` mean what its `$comment` already claimed. The pattern becomes a
Gregorian calendar: correct month lengths, the full leap rule including the
century exceptions, hours `00`-`23`, minutes and seconds `00`-`59`, and no leap
second.

The whole change is the pattern. One `$defs` entry covers all thirteen schemas
and every `Instant` field in every contract.

### Why the contract layer

Because it is where the property belongs, and because it is the only
proportionate place. Repairing `assertBundleNotBackDated` would have closed B4
and left the other thirty-four comparison sites holding the identical gap, each
needing its own copy of a calendar the contract is the natural owner of. A
check placed at the boundary answers once, for every reader, including readers
that do not exist yet.

It is also the placement this repository already reaches for: `assertContract`
runs before any semantic branch, and the verifier's own defensive branches are
documented as defence in depth behind it, not as the primary gate.

### Why a pattern and not a keyword or a validator hook

`ajv-formats` is a dependency and `validateFormats` is deliberately `false`;
turning it on would change validation for every `format` in the workspace at
once, which is a far wider blast radius than this finding justifies. A custom
Ajv keyword would mean a new schema keyword, an Ajv configuration change, and a
generator that has to learn to ignore it.

A pattern needs none of that. It is declarative, it travels with the definition
it constrains, `strict` mode already accepts it, and
`packages/contracts/generated/` does not change because `Instant` generates
from `type: string` and never carried the pattern.

The cost is that the pattern is dense. That is paid for by testing rather than
by trust: `tests/contract/instantCalendarValidity.test.ts` sweeps it against an
independent Gregorian oracle written longhand — deliberately not `Date`, whose
`Date.UTC` maps years 0-99 into the 1900s and would have agreed with a wrong
answer — over every leap-rule case, both century directions, and the full clock
range.

### Why no schema version moves

A document that was always malformed becoming refused is not a change to the
data model. Every conforming document keeps its bytes, its canonical form, its
core hash and its signature; no producer emits a different field; no consumer
reads a different one. The new contract case asserts this by walking
`fixtures/` and `docs/evidence/` and requiring every instant-shaped literal in
the committed tree to survive, rather than by claiming it.

## Consequences

**Established.** A schema-admitted `Instant` denotes exactly the instant its own
text spells. Every `Date.parse` over an `Instant` — all thirty-five sites —
now compares the instant a reader would read. `permitted-claims.md`'s statement
that a public bundle is "not back-dated before signed finalization" becomes
true without qualification; the review had recorded that it was stated slightly
wider than the code proved, and the code now proves it.

**Not established, and unchanged.** This is a well-formedness property, not an
authority one. It says nothing about whether a timestamp is *honest*: an
unsigned producer stamp is still an unsigned producer stamp, the post-dating
direction of `created_at` is still non-authoritative residue, and nothing here
authenticates, confines, certifies or signs anything. No trust tier moves.

**Refusal precedence.** An impossible stamp is now refused by `assertContract`
with `SCHEMA_VALIDATION_FAILED`, before B4 is reached. That is the more
fundamental true statement — the document is not a bundle, rather than a bundle
in the wrong order — and B4 keeps every refusal it already owned: a real
back-dated instant still refuses with `GRAPH_CLOSURE_TERMINAL_MISMATCH`, and a
retained-only rewrite still refuses with ADR-ERL2-043 B3's
`GRAPH_CLOSURE_UNREACHABLE_ARTIFACT`. Both are pinned.

**No movement.** No schema version, no new key, no new signature, no evidence
regeneration, no new refusal code, no generated-type change, no trust tier, and
no existing test weakened, modified or deleted.

## Alternatives rejected

- **Caveat the claim instead of fixing the contract.** The review offered this
  as the cheaper option. It documents a gap rather than closing one, and it
  would have had to be repeated at each of the thirty-five sites for the
  documentation to be honest. Rejected.
- **Fix `assertBundleNotBackDated` only.** Closes the reported symptom, leaves
  thirty-four comparison sites carrying the cause, and puts a calendar in the
  public verifier where the contract already had one to state. Rejected.
- **Enable `validateFormats` and use `format: date-time`.** Changes validation
  for every `format` keyword in the workspace at once, and RFC 3339
  `date-time` additionally admits offsets and fractional seconds that `Instant`
  deliberately refuses. Rejected.
- **A custom Ajv keyword.** A new schema keyword, an Ajv configuration change
  and a generator exception, to express something a pattern already expresses.
  Rejected.
- **Widen the representable range while here.** Out of scope. The year range is
  unchanged at `0000`-`9999`; only impossible dates inside it are refused.
