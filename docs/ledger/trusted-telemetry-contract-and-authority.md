# Package 1 — ERL2-C-171 and the trusted-telemetry authority boundary

Implementation ledger for the first of the three packages ADR-ERL2-038 §10
defines. Scope: **the contract and the authority boundary only.** No collector
exporter, no minimizing processor, no named volume, no overlay, no driver
lifecycle, no live freeze or read path.

- **ADR:** `docs/adr/ADR-ERL2-038.md`, amended with corrections R1–R8
- **Independent design review:** `reality-lab-ff2c8c0-adr-038-design-review.md`
  (SHA-256 `2af8898ef4baaca7ec86772d2881426d561c6c608987c5e3b27f373b31c56453`,
  verdict `ADR-ERL2-038 APPROVED WITH REQUIRED DESIGN CORRECTIONS`)
- **Feasibility gate:** `reality-lab-ff2c8c0-trusted-framing-feasibility.md`
  (SHA-256 `bb0fe374c87c604dfc118bf62cdef106db13dbd66c6d28be838c319be0c926ec`)

## 1. What this package claims, and what it does not

**Claims.** ERL2-C-171 exists, is registered, and is the only format
authoritative for a new trusted telemetry claim. ERL2-C-160 remains parseable
and historically verifiable and authorizes nothing new. The migration has one
decision point, so no package ordering can open a window in which both formats
authorize evidence.

**Does not claim.** That the trusted channel exists. It does not. No collector
has written an ERL2-C-171 artifact, and every byte under test was built by a
fixture. Defining a contract does not create the thing it describes.

**Does not claim.** That the `6d28d543` defect is closed. It is not. What
changed is that the forgeable channel can no longer authorize a claim — which
is a refusal, not a repair.

## 2. The consequence worth stating plainly

At this commit, **a run that declares attributable telemetry obtainable fails
its `attributable-telemetry-retained` gate.** Nothing produces a v2 record yet,
and a v1 record is refused.

That is intended. A v1 record states a span count derived from a stream a
subject can reproduce byte for byte; the independent review reproduced a
complete forged trusted record from a subject log body. A Lab that kept passing
the gate on such a record while its own ADR says the channel cannot be trusted
would be certifying what it cannot show. The honest state is a refusal with a
named reason (`telemetry_authority_v1_not_authoritative`), and that is what a
declaring run now gets.

Runs that never declare the observation obtainable are **untouched** — the gate
is vacuous for them exactly as before, and a fake-driver run still verifies
offline end to end.

## 3. Contract delta

| | |
|---|---|
| new contract | **ERL2-C-171** `AttributableTelemetryObservationV2` (`attributable-telemetry-observation/v2`) |
| unchanged | **ERL2-C-160** `AttributableTelemetryObservationV1`, still registered |
| registry entries | 165 → 166 |
| generated contract types | 279 → 280 |

**Why a new identity rather than a version bump on ERL2-C-160.** The two must be
representable at once — one historical, one authoritative — and a single
identity spanning both is exactly the dual authority R8 exists to prevent.
Repointing C-160 at v2 would also make every frozen bundle that declared C-160
coverage read as a claim about a channel that did not exist when it was written.
Same reasoning ERL2-C-159 was added under.

**Shape.** v1's fields carried forward, plus four blocks:

| block | what it settles |
|---|---|
| `channel` | R3. `kind`, `record_format`, `encoding`, `rotation` and `segment_count` are schema constants, so a record whose bytes came from the mixed debug stream, a rotated file or any other format is **unrepresentable**, not merely refused. |
| `binding` | R4. Environment archetype, substrate lock, collector image and collector configuration identity. |
| `artifact` | R5. `byte_length`, `content_digest`, `record_count`, `finalization: "frozen"`, `final_record_terminated`. Every one recomputed, never read. |
| `trusted_records` | The exact NDJSON bytes, bounded at 262 144 as v1's excerpt was. |

`log_excerpt` is absent from `properties`, and `additionalProperties` is false,
so a record mixing v1 and v2 fields fails the schema itself.

## 4. Authority migration

One decision point, `decideTrustedTelemetryAuthority`, called by the producer's
gate and the offline verifier alike.

| input | new trusted claim |
|---|---|
| valid v2 | eligible, subject to every other gate |
| missing v2, valid v1 | **refused** — `telemetry_authority_v1_not_authoritative` |
| invalid v2, valid v1 | **refused** — `telemetry_authority_v2_invalid`, no fallback |
| valid v2 plus v1 | v2 authoritative; the report is identical with and without the v1 |
| unknown version | **refused** — fails closed |
| mixed-version fields | **refused** |
| two v2 records | **refused** |
| nothing retained | **refused** |
| historical verification | v1 readable through `readHistoricalTelemetryObservation`, within its original scope only |

**Authority and coherence are two functions, deliberately.** Authority is a
question about a record's version and provenance, and both authorities must
answer it identically or the migration has a hole — so it is shared. Coherence
is a question about the record's *content*, and a verifier that delegated that
to a helper the producer also calls would be agreeing with the producer rather
than checking it. That is the failure ADR-ERL2-038 §4 recorded, and folding the
two together reintroduced it one layer up. The campaign is what found it: three
verifier controls stopped killing, because the shared helper refused an
incoherent artifact before the verifier ever compared a count.

## 5. What the verifier establishes independently

From the retained bytes, with no producer counter consulted: authentic
structured records; span count as the length of a structure; run attribution by
decoded comparison; record count; byte length; content digest; completeness;
environment binding; another-run rejection; size and field bounds; producer
counter equality; genuine zero read rather than inferred.

Producer-only residue, and why none of it can forge: a failed channel
provisioning aborts collector start-up, so no observation exists to verify; the
collector identity is hash-covered with both proof booleans as schema
constants; and settle-loop timing can only *understate* a count, never
overstate one.

## 6. Control migration

Discovery **155 → 169**. Zero controls removed, zero renamed, zero reordered.

**Three controls kept their ids and moved their enforcement points**, so the
record shows one property relocating rather than one disappearing and an
unrelated one appearing:

| control | old enforcement point | new enforcement point |
|---|---|---|
| `telemetry-verifier-excerpt-fixed-point` | the v1 excerpt fixed point | the verifier's digest recomputation over the retained bytes |
| `telemetry-verifier-recomputes-coherence` | attribution with no counting batch | attribution exceeding the spans it was drawn from |
| `telemetry-gate-satisfaction` | unchanged arithmetic, v1 cases | unchanged arithmetic, v2 cases — only a v2 record now reaches it |

`telemetry-record-payload-is-not-summary-text` is **untouched and still
killing.** R7 defers its removal to the package that actually retires the mixed
parser (package 3). Its property already has a successor measuring the same
thing at the boundary that will outlive it:
`trusted-telemetry-untrusted-payload-cannot-create-a-record`.

**Fourteen controls added**, one per load-bearing Package 1 enforcement point:
v1 cannot authorize; invalid v2 does not downgrade; unknown version fails
closed; freeze integrity; artifact digest; untrusted payload cannot create a
record; cross-run record refused; partial record refused; size bound;
minimization enforced; sensitive field refused; field bound enforced; run
binding verified; genuine zero not inferred.

## 7. Fixtures

Four valid fixtures are checked in under `fixtures/trusted-telemetry/` and
asserted byte-identical to their builders, so a reviewer can read the artifact
and packages 2 and 3 have a fixed target. The size-boundary fixture is built
rather than checked in — a quarter-megabyte file in the repository would be
duplication with no reader.

The twenty-eight invalid cases are expressed as deltas. Twenty-eight
near-identical files would hide the one field that differs, which is the only
thing each case is about.

## 8. Privacy

The contract does **not** say subject bytes are absent from the retained
artifact. It says where they may remain: inside one allowlisted, JSON-escaped,
length-bounded field (`url.full`, ≤ 512 characters), and nowhere else. The
parser enforces the allowlist rather than assuming package 2 configured the
minimizing processor — a record carrying a key nobody allowed is a record the
pipeline did not minimize, and reading it would retain bytes the privacy bound
never accounted for.

## 9. Status

- v2 is contractually defined; the live trusted channel is **not implemented**
- v1 is historical and **non-authoritative** for new claims
- **no live v2 artifact has been produced** by any collector
- Package 1 targeted tests certify the contract, **not the substrate**
- the full campaign and the clean gate remain **pending**
- exploratory Qualiber testing is **not yet authorized** (ADR-ERL2-038 §11)
- **Package 2 and Package 3 are still required**

---

## 10. Corrections appended by Package 2 (2026-08-14)

Nothing above is rewritten. The independent Package 1 review
(`reality-lab-package1-independent-contract-and-authority-review.md`, SHA-256
`c02cbf4e66a27b4bc7e2204af02ab6f869dea93fce2dbc112d2bfe774a36c941`, verdict
`PACKAGE 1 APPROVED — PACKAGE 2 AUTHORIZED`) recorded four **P2** findings
against this record and the report beside it. They are corrected here, in
place, because this ledger is the document written to outlive the report.

| # | what this ledger said | what is true |
|---|---|---|
| 1 | §3: registry entries **165 → 166** | **166 → 167.** Runtime `CONTRACTS.length` was 166 before ERL2-C-171 and is 167 after. The delta (+1), the uniqueness (167 unique ids) and the generated-type count (279 → 280) were all correct; only the endpoints were wrong. |
| 2 | §6: **three** controls moved their enforcement points | **Two** moved. `telemetry-gate-satisfaction`'s `find`/`replace` are byte-identical to the parent's — only its *declared cases* migrated from v1 to v2 names. |
| 3 | §6 named four existing controls as changed | **Five** changed. `telemetry-verifier-count-derivation` and `telemetry-verifier-attribution-floor` also had their declared cases migrated to `TRUSTED-VERIFY: …`, and were not disclosed at all. |
| 4 | §6: `telemetry-verifier-recomputes-coherence`'s new enforcement point is *"attribution exceeding the spans it was drawn from"* | That is the `runAttributedRecords > spans` guard **deleted as structurally unreachable in the same commit** (`aeebdc4`). The control's actual target is the **artifact-block recomputation** — byte length, record count and final-record termination. This ledger claimed coverage that did not exist. |

Two further corrections to the Package 1 record, neither of which this ledger
made but both of which a reader of it should have:

- **The reproducible broad result at Package 1 was 1 300 total / 1 280 passed /
  20 fixture-dependent skips / zero failures**, not 1 300 / 1 300. The
  zero-skip result depended on a git-ignored, network-fetched archive under
  `environments/otel-demo/upstream/` that a fresh checkout does not carry. Every
  skip is self-declaring, none touches contract, authority, grammar or verifier
  code, and there were no failures either way — but "green on the first run,
  zero skipped" described the author's machine rather than the commit.
- **ERL2-C-160 is contract compatibility, not an operational
  historical-verification workflow.** `readHistoricalTelemetryObservation` is
  exported and unit-tested and has **no production caller**;
  `deriveAttributableTelemetry` applies the v2 authority rule unconditionally.
  A previously frozen bundle that declared attributable telemetry and retained a
  valid v1 record would fail offline verification today. No such bundle exists
  in this repository, and the exposure is any bundle frozen outside it. §8's
  "v1 verifies in its original scope" is evidenced by contract registration and
  evidence immutability — which is not the same as a verification path.

## 11. What Package 2 changed about §9's status

§9 is superseded on two lines and stands on the rest. The live trusted channel
**is** now implemented and live v2 artifacts **have** been produced by the
pinned collector — see
`docs/ledger/trusted-telemetry-channel-substrate.md`. Everything else in §9
still holds: the full campaign and the clean gate remain pending, exploratory
Qualiber testing is still not authorized, and **Package 3 is still required**
before an environment run can reach the channel at all.
