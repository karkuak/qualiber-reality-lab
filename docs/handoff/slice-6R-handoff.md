# Slice 6R — Integrity and Recovery Remediation: final handoff (§16)

Self-contained handoff for the completed Slice 6R remediation. It carries forward
the items fixed in earlier 6R passes and records the dispositions landed in this
continuation (the P3 cluster §11.1–§11.14, the evidence-determinism byte-pin, the
isolation probe-result authenticity chain, and the §8.5 record).

## 1. Normative design revision and accepted ADR set

- **Normative design:** `external-reality-lab-design-v2.md`, revision
  **`2.0.0-draft.11`**.
- **Accepted ADRs:** ADR-ERL2-001 … ADR-ERL2-018. **ADR-ERL2-018** (the run
  transaction / recovery / run-lease / idempotency / cancellation model) was
  added during this remediation. No ADR was superseded; ADR-018 extends ADR-001
  and re-affirms ADR-013.
- No frozen schema's shape or meaning was changed. Contracts added this
  remediation are **additive**: `cancellation-request/v1` (`ERL2-C-063`, earlier
  6R-B pass), `BeaconSignatureProofV1` (`ERL2-C-152`), `BeaconInclusionProofV1`
  (`ERL2-C-153`), `IsolationProbeSigningManifestV1` (`ERL2-C-154`), plus the
  additive `UniqueHashArray` common `$def` and the `RESERVED_GENERIC_METRIC_IDS`
  registry.

## 2. Baseline and final test totals

- **Baseline (inherited, start of this continuation):** 401 pass / 0 fail / 0 skipped.
- **Final:** **418 pass / 0 fail / 0 skipped** (full `npm test` lane) + **24
  architecture/purity** tests (`npm run purity`).
- Lanes: contract, integrity (CANON/PATH/TAMPER), architecture/purity,
  adversarial, integration, e2e (subprocess), plus the offline-verifier mutation,
  crash/recovery, cancellation, deterministic-evidence and isolation lanes.
- Golden tree manifest: `66e1e276b93f…` (baseline) →
  **`bbda627c0075615d4893888ea3a5f8cce92f0b284fe0d4acff27a97a68e5a49a`**
  (intentionally regenerated once via `evidence:update`; see §8).

## 3. Finding-disposition table (every review finding)

### Release blockers (carried forward, all fixed in earlier 6R passes)

| ID | Disposition | Evidence |
|----|----|----|
| P1-1 rejected-extra closure | **fixed** (6R-A) | `MUT-P1-1` mutation battery |
| P1-2 replay/crash wedge | **fixed** (6R-B) | replay/crash e2e, ADR-018 |
| Missing cancellation terminal | **fixed** (6R-B) | `cancellation.test.ts`, `cancellation-request/v1` |
| P2-1 isolation authenticity | **fixed** (6R-E) | `isolationAuthenticity.ts`, retained-evidence test |
| P2-2 referenced raw-byte rehash | **fixed** (6R-A) | `referencedBytes.ts`, `MUT-P2-2` |
| P2-3 signer-inventory signature | **fixed** (6R-A) | `MUT-P2-3` |
| P2-4 verify-record fail-closed | **fixed** (6R-A) | `MUT-P2-4` |
| P2-5 pre-dispatch state guard | **fixed** (6R-B) | `postRevealExecution.test.ts`, ADR-018 |
| P2-6 adapter response schema | **fixed** (6R-C) | `responseShape.ts` |
| P2-7 OQ-007 in both kernels | **fixed** (6R-C) | selection blind-tier refusal |
| P2-8 selection known-answers | **mostly fixed** (6R-C) | KATs; §8.5 wiring gated on 6.5 |
| P2-9 removability + purity | **fixed** (6R-D) | `removability.test.ts` copy + negative control |
| P2-10 evidence non-mutation + byte-pin | **fixed** (6R-D) | `evidence:verify`; this pass closed the byte-pin |
| P2-11 oracle-surface honesty | **fixed** (6R-C) | `oracleSurfaceCoverage.test.ts` |

### P3 cluster (this continuation)

| Finding | Disposition | Root-cause fix + regression |
|----|----|----|
| §11.1 duplicate keys via escapes | **fixed** | `readJsonString` decodes key tokens before comparison; `contracts.test.ts` decoded-collision + surrogate cases |
| §11.2 coreHash universal exclusions | **fixed** | signature exclusion only for schema versions that declare it (`signedSchemaAuthorityFields()`); smuggling refused; `integrity.test.ts` §11.2 |
| §11.3 JCS/NFC boundary | **fixed** | single JCS path rejects non-NFC strings (keys+values); `integrity.test.ts` §11.3 |
| §11.4 artifact-freeze crash-idempotency | **fixed** (earlier) | store reconciles markerless/corrupt marker |
| §11.5 substrate drift symmetry + env-lock signature | **fixed** | bijective image + exact-set config comparison; `verifySubstrateLockSignature`; isolation array comparison; `environment.test.ts`/`isolationSubstrate.test.ts` §11.5 |
| §11.6 hardcoded fake-subject hashes | **fixed** | manifest config/capability hashes derived from the admitted adapter manifest; `journeyRun.test.ts` recompute-and-compare |
| §11.7 reserved generic-metric drift | **fixed** | one authoritative `RESERVED_GENERIC_METRIC_IDS` registry; two-way equality + neuter refusal tests |
| §11.8 dev shortcut flags in release CLI | **fixed** | `--fake-*` gated behind `ERL2_DEVELOPMENT_FAKE_SUBJECT=1`; `CFG_DEVELOPMENT_FLAG_UNAVAILABLE`; release-surface refusal regression |
| §11.9 torn snapshot | **fixed** (earlier) | in-memory-derived snapshot; rebuild from events |
| §11.10 selection-receipt booleans | **fixed** | docstring corrected + verifier now reads/enforces every `checks` boolean as defense-in-depth; `selectionChain.test.ts` §11.10 |
| §11.11 docs/claims alignment | **fixed** | OQ-008 "qualified" overstatement corrected; env-lock drift note; README/permitted-claims aligned; golden transcript regenerated |
| §11.12 closure error-code specificity | **fixed** (6R-A) | CLI distinguishes rejected-extra from missing-role |
| §11.13 handwritten wire types | **fixed** | beacon proofs → closed schemas + generated types + freeze/parse validation; threshold envelope → hardened explicit-format parser; `wireTypes.test.ts` |
| §11.14 (unbounded strings / uniqueItems / hard-safety / concurrency / platform / synthesized fields) | **evaluated** | `UniqueHashArray` on genuine set arrays; hard-safety primitive pinned + owner recorded; rest recorded with owning slice (see the ledger §11.14 table) |

### Determinism and isolation follow-ups (this continuation)

| Item | Disposition |
|----|----|
| 6R-D governor RNG seeded | **fixed** — `ageEncrypt(…, random)` injectable; seeded in evidence build |
| 6R-D deterministic checkpoint id | **fixed** — content-derived, not `randomUUID()` |
| 6R-D `evidence:verify` byte-pin | **fixed** — 615 pinned, 166 excluded-and-logged (real-adapter subtree) |
| 6R-E probe-result authenticity §10.1 | **fixed** — signed `isolation-probe-signing-manifest/v1`; `authenticated` requires an authority-signed manifest |
| §8.5 offline selection verification | **recorded, 6.5-gated** — interface ready; env offline wiring deferred to 6.5 |

## 4. Reproductions performed before each fix

- §11.1: `parseStrictJson('{"a\\/b":1,"a/b":2}')` was accepted and collapsed to
  one field (raw-token comparison). Now rejected.
- §11.2: `coreHash({schema_version:"x/v1", signature:{…}})` silently dropped the
  authority field on every schema. Now refused fail-closed.
- §11.3: a non-NFC string reaching the hash layer would be hashed as-is. Now
  rejected in the single JCS path.
- §11.5: an extra observed image / a missing locked config passed
  `assertObservedMatchesLock`; a tampered env-lock signature was never checked;
  the isolation diff never compared the config/policy arrays. All now refused.
- §11.6: two different subjects produced identical `configuration_schema_hash` /
  `capability_declaration_hash` (fixed `fake-subject/v1` literal). Now
  adapter-derived and distinct.
- §11.7: `certifyPack` accepted a neutered `authority-scope` /
  `mutation-compensation` (SDK reserved-id list was two ids short). Now flagged.
- §11.8: `--fake-verify-package succeeded` was reachable on the release surface.
  Now refused without the explicit development profile.
- §11.10: the verifier docstring claimed the receipt booleans were re-derived and
  refused on mismatch; the verifier never read them. Now read and enforced.
- §11.13: `parseEnvelope` accepted unknown fields / non-base64 blobs; beacon
  proofs had no closed schema. Now hardened / schema-governed.
- 6R-D: a two-generation diff isolated three nondeterminism sources (governor
  ciphertexts, `checkpoint_id`, adapter subprocess). First two closed; the third
  (real subprocess absolute paths + PIDs) explicitly excluded from the pin.
- §10.1: the twenty probe results were unsigned — a fabricated set bound to the
  lock hash would pass. Now authenticated by a signed manifest.

## 5. Root-cause fixes implemented

See §3 and the remediation ledger (`docs/ledger/remediation-6R.md`) for the full
per-finding root cause. Each fix is at root cause in library code (validate.ts,
hash.ts, jcs.ts, substrateLock.ts, isolationSubstrateLock.ts, workspace.ts,
genericMetrics.ts, journeyCommands.ts, verify.ts, envelope.ts, beacon.ts,
log.ts, age.ts, isolationAuthenticity.ts), so the CLI and every caller inherit
the corrected behaviour, with an adversarial regression that fails if the
protection is removed.

## 6. Contracts added or changed

**Added (additive only):** `ERL2-C-152` `BeaconSignatureProofV1`, `ERL2-C-153`
`BeaconInclusionProofV1`, `ERL2-C-154` `IsolationProbeSigningManifestV1`, plus
the `UniqueHashArray` common `$def`. `verify:generated` is clean (219 generated
contract types). **No frozen schema's shape or meaning was silently mutated.**
New error codes (append-only, catalogued prefixes): `ENV_SUBSTRATE_LOCK_SIGNATURE_INVALID`,
`CFG_DEVELOPMENT_FLAG_UNAVAILABLE`.

## 7. ADRs added or superseded

- **Added:** ADR-ERL2-018 (earlier 6R-B pass; read for the lifecycle model).
- **Superseded:** none. No historical ADR conclusion was rewritten; docs gained
  superseding clarification where required (open-questions.md OQ-008/OQ-005).

## 8. Verifier / crash / cancellation / evidence / isolation evidence

- **Offline-verifier mutation battery** (`offlineVerifierMutations.test.ts`):
  green (P1-1/P2-2/P2-3/P2-4 + rejected-extra/raw-tamper/signer-tamper).
- **Crash/replay matrix** (`crashRecovery.test.ts`, `replay.test.ts`,
  `runLease.test.ts`): markerless/corrupt-marker freeze recovery, torn snapshot
  recovery, idempotent + auto-resuming replay, concurrent-replay serialization,
  post-reveal refusal.
- **Cancellation** (`cancellation.test.ts`): one signed record, no fabricated
  finding, verifies offline, terminal refusal.
- **Evidence determinism:** `evidence:verify` byte-pins 615 files against the
  goldens (166 excluded-and-logged: the real reference-adapter subprocess subtree
  + the path-baking cli-transcript); generate-twice is byte-identical over the
  pinned set; CI runs `evidence:verify` + the git-diff drift guard.
- **Isolation authenticity:** lock signature verified + signer classified; the
  twenty probe results authenticated by a signed manifest; doctor reports
  `locally_observed_unauthenticated` (dev-signed) with `probe_manifest:
  valid_development`; tamper/forgery → `not_qualified`.

## 9. Remaining limitations (6.5-gated and beyond)

- **§8.5 offline selection verification:** `verifySelectionChain` + KATs exist;
  wiring it into the environment offline verifier path is the one connection that
  must complete before Slice 6.5 activates the environment branch.
- **Pending oracle surfaces:** seven of eight scan surfaces (`PENDING_ORACLE_SCAN_SURFACES`)
  become live with the 6.5 environment/journey orchestration.
- **Translation-totality live wiring:** `assertTranslationTotality` is a complete
  gate with refusal tests; its live wiring is a 6.5 connection.
- **Container launcher / opaque execution:** not built; opaque and third-party
  subjects refused; OQ-008 open.
- **Adapter subprocess in the byte-pin:** the real reference-adapter subtree is
  intentionally outside the byte-pin (absolute workspace paths + OS PIDs).
- **Node 22 byte-equivalence:** enforced/asserted by CI on Node 22, not on this
  host (which runs a newer Node).
- **§11.14 recorded items:** unbounded-string maxLength audit, environment
  concurrency, and adapter-driven discrimination synthesis are Slice 6.5 concerns.

## 10. Exact permitted claims

Aligned in `docs/claims/permitted-claims.md`. Key boundaries unchanged and made
more precise: non-blind `development` selection only; Compose disabled (OQ-005);
opaque/third-party execution refused (OQ-008); the isolation claim is
**self-reported** (`locally_observed_unauthenticated`), with the lock **and** the
probe-result manifest dev-signed, never `authenticated`; only trusted reference
subjects run, under `local-process`.

## 11. Qualiber independence

Neither `/Users/karthik/Claude/Projects/Qualiber` nor
`/Users/karthik/Developer/qualiber-2nd/qualiber` was inspected, searched, read,
executed or modified during this remediation. No Qualiber identifier, branch,
schema, fixture or assumption was added. The product-independence checks
(`tests/architecture/purity.test.ts`, `tests/architecture/removability.test.ts`)
remain intact and green.

## 12. Exact final verification command and result

```
npm run clean && npm install && npm run build && npm run typecheck && \
  npm run verify:generated && npm test && npm run purity && npm run evidence
```

Result (this checkout, single uninterrupted run): **all steps exit 0** —
`clean` ok, `install` ok, `build` ok, `typecheck` ok, `verify:generated` current,
**`test` 418 pass / 0 fail / 0 skipped**, **`purity` 24 pass / 0 fail**,
`evidence` generated into a throwaway temp dir. `npm run evidence` did **not**
modify `fixtures/golden`: the golden manifest was
`bbda627c0075615d4893888ea3a5f8cce92f0b284fe0d4acff27a97a68e5a49a` both before
and after the routine `evidence` run. The stricter `npm run evidence:verify`
byte-pins 615 files against the goldens and reports OK (166 subprocess/transcript
files excluded-and-logged).

### Fresh-process CLI reproductions (cited to their regression tests)

Each confirmed reproduction has a regression that drives the shipped `erl2`
binary (or the real library path) in a fresh process and fails if the protection
is removed:

- valid pre-environment bundle verifies offline — `e2e/journeyRun.test.ts`,
  `generate-evidence` `verify` (exit 0).
- invalid record verifies offline — `e2e/journeyRun.test.ts` (`verify-record`),
  `e2e/cancellation.test.ts`.
- rejected extra artifact — `adversarial/offlineVerifierMutations.test.ts`
  (`MUT-P1-1`) → `GRAPH_CLOSURE_EXTRA_ARTIFACT`.
- raw binary tamper — `offlineVerifierMutations.test.ts` (`MUT-P2-2`/`P2-2b`) →
  `ARTIFACT_HASH_MISMATCH`.
- signer-inventory tamper — `offlineVerifierMutations.test.ts` (`MUT-P2-3`) →
  `TRUST_SIGNATURE_INVALID`.
- invalid-record extra — `offlineVerifierMutations.test.ts` (`MUT-P2-4`).
- delayed replay — `e2e/replay.test.ts` (idempotent + auto-resume).
- concurrent replay — `integration/runLease.test.ts` (`POLICY_RUN_LEASE_HELD`).
- post-reveal execution attempt — `adversarial/postRevealExecution.test.ts` +
  finalized-run stray-command e2e.
- hostile malformed adapter response — `adversarial/adapterHost.test.ts`
  (`ADAPTER_PROTOCOL_FRAME_INVALID`), `e2e/adapterJourney.test.ts` sabotage.
- cancellation — `e2e/cancellation.test.ts`.
- torn snapshot recovery — `e2e/crashRecovery.test.ts`.
- selection blind-tier misuse — `adversarial/selectionChain.test.ts`
  ("ERL2-OQ-007 wired").
- isolation signature tamper — `integration/isolationRetainedEvidence.test.ts`
  (tampered lock → `not_qualified`; tampered probe manifest → `not_qualified`).
- release-surface dev-flag refusal — `e2e/journeyRun.test.ts` §11.8
  (`CFG_DEVELOPMENT_FLAG_UNAVAILABLE`, spawned with the dev profile disabled).

## Readiness verdicts

- **Slice 6R:** complete.
- **Slices 1–6:** clean gate (full green: build, typecheck, verify:generated,
  test, purity, evidence non-mutating, evidence:verify byte-pin).
- **Slice 6.5:** ready to resume, with the recorded §8.5 selection-offline-verifier
  wiring as the first required connection.
- **Trusted reference-subject execution:** ready (`local-process`, with the
  recorded sandbox-control limitations).
- **Opaque private-subject execution:** not ready (OQ-008 open; no launcher).
- **ERL2-OQ-005:** fail-closed (Compose disabled; unqualified retained lock).
- **ERL2-OQ-008:** open. Exact remaining reason: no container-backed adapter
  launcher exists, the isolation evidence is dev-signed
  (`locally_observed_unauthenticated`, not authority-authenticated), and adapter
  certification has not run under the container profile.
- **Qualiber integration:** not started.
