# Slice 6R — Integrity and Recovery Remediation: finding-disposition ledger

> **Pass 4 (2026-07-26) — independent re-audit of the fixed build.** Every claim
> below was re-reproduced against the *current* build through the shipped CLI in
> fresh processes. Six further defects were found and fixed; they are recorded in
> the "Pass-4 findings" section at the end of this ledger and in
> [ADR-ERL2-019](../adr/ADR-ERL2-019.md). Four of them are the same invariants as
> P1-1 / P2-3 / §8.2, closed only along the exact path the review had walked.

Scope: remediate the independently reviewed defects in `Independent-Code-Review.md`
through Slice 6. Authority precedence per the remediation prompt (ADR > design >
plan > frozen schemas > remediation prompt > review-as-evidence). The review is
defect evidence, not normative.

Baseline (safe sequence `clean && install && build && typecheck && verify:generated && test && purity`,
run before any evidence generation): **355 tests pass / 0 fail / 0 skipped**
(contract 100, adversarial 126, integration 78, e2e 25, architecture 21,
integrity-age 5). `verify:generated` clean. Golden tree manifest captured at
`fixtures/golden` (781 files, sha256 `66e1e276…`) before any change.

Environment note: this host runs **Node v26.4.0**; the project targets **Node 22**
(`engines.node >=22`). Cross-platform / Node-22 byte-equivalence is therefore NOT
proven on this tree (review §9.5 / G). Recorded, not claimed.

Qualiber independence: neither `/Users/karthik/Claude/Projects/Qualiber` nor
`/Users/karthik/Developer/qualiber-2nd/qualiber` was inspected, searched, read,
executed or modified during this remediation. No Qualiber identifier, branch,
schema, fixture or assumption was added.

Disposition legend: **fixed** = root-caused + regression test green;
**in-progress** = partially landed; **pending** = analysed, not yet implemented;
**rejected** = reproduced and found not a defect against the normative sources.

---

## Release blockers (per remediation prompt §5)

| ID | Normalized sev | Normative requirement | Repro | Root cause | Disposition | Regression evidence |
|----|----|----|----|----|----|----|
| P1-1 | Blocker | ERL2-FR-020 / AC-023, design §14 step 6-7 | Confirmed by code read: `closure.ts:274` verdict ignored `rejected` | Pre-environment closure verdict folded only `missing`, not `rejected` extras — diverged from its 3 siblings | **fixed** | `MUT-P1-1` (adversarial, CLI fresh process): rogue self-consistent extra → `GRAPH_CLOSURE_EXTRA_ARTIFACT`, verdict invalid |
| P2-2 | Blocker | ERL2-AC-013 | Confirmed: `artifactIndex.ts` skipped non-JSON; `file_sha256` never consumed | Offline verifier never rehashed referenced raw bytes | **fixed** | New `referencedBytes.ts`; `MUT-P2-2`/`P2-2b` (byte flip, truncation) → `ARTIFACT_HASH_MISMATCH`; path-escape unit test → `PATH_ESCAPES_ROOT` |
| P2-3 | Blocker | trust boundary / design §16.3 | Confirmed: only final attestation sig verified | Signer-inventory signature unverified; attestation binding hashes not cross-checked | **fixed** | `MUT-P2-3`/`P2-3b` (re-signed-bundle isolation) → `TRUST_SIGNATURE_INVALID`; binding cross-checks added in `verify.ts` |
| P2-4 | Blocker | ERL2-AC-031 | Confirmed: `verifyRecord` returned ok unconditionally | CLI never consulted `closure.verdict` for the invalid-record path | **fixed** | `MUT-P2-4`: rogue extra in invalid record → `verify-record` exits nonzero `GRAPH_CLOSURE_EXTRA_ARTIFACT` (fail-closed now in `verifyInvalidRecord`) |
| P1-2 | Blocker | ERL2-FR-001, NFR-003, §20, Slice 2 gate | Reproduced via replay e2e (was: replay→`ARTIFACT_ALREADY_FROZEN`→fabricated adapter finding→wedge) | Port executes before idempotency/state check; records embed wall-clock; Lab conflict mapped to adapter finding; `invalidate()` demands unreached role | **mostly fixed** (6R-B) | **Fixed:** idempotent replay — `acquire()`/`verifyPackage()` return the durable record without re-invoking the port (replay e2e green); failure ownership — only `owner==="adapter"` becomes an adapter finding, Lab conflicts (`ARTIFACT_ALREADY_FROZEN` defaults owner `lab`, lease conflicts) re-throw as Lab errors; `subject-output-manifest` wedge removed; durable cross-process lease. **Remaining:** timestamp determinism for the crash-rebuild case, full crash matrix (§7.8), P2-5 pre-dispatch validation |
| P2-5 | Blocker | ERL2-FR-007 / AC-012 | Confirmed: reveal-check lived inside `runStep` after dispatch | No-execution-after-reveal / state validation ran after port dispatch | **fixed** (6R-B) | New `assertSubjectPortExecutable` (states.ts) called in `acquire()`/`verifyPackage()` *before* any port call or freeze; covers reveal + terminal + finalization + invalidation states. Tests: unit guard over every entrypoint state + e2e stray-command-on-finalized-run adds zero external evidence, no fabricated finding |
| Cancellation | Blocker | design §12 | Confirmed: no `cancel` command; `CFG_UNKNOWN_FLAG` | Mandatory terminal path unimplemented | **fixed** (6R-B) | New `cancellation-request/v1` schema (regenerated), `cancel` command, exit 12, signed request, exactly one invalid record, no fabricated finding, verifies offline, terminal refusal exits 11 (2 e2e tests) |

---

## 6R-A Offline verifier integrity — COMPLETE

- **P1-1** fixed: `closure.ts` pre-environment verdict now `missing===0 && rejected===0`.
- **P2-2** fixed: `referencedBytes.ts` rehashes every referenced descriptor
  (`path`/`logical_path` shapes) present on disk + every content-addressed store
  file (name=hash), with strict path confinement (absolute/traversal/symlink →
  `PATH_ESCAPES_ROOT`/`PATH_SYMLINK_REJECTED`), bounded reads. Wired into both
  bundle variants and the invalid-record path.
- **P2-3** fixed: signer-inventory Ed25519 signature verified under
  `final_attestation_signer`; attestation bindings (signer inventory, receipt,
  timestamp checkpoint, acquisition source/record, generic evaluation index,
  cleanup, adapter, generic run policy) cross-checked against the closure-derived
  retained artifacts.
- **P2-4** fixed: `verifyInvalidRecord` throws `GRAPH_CLOSURE_EXTRA_ARTIFACT` when
  the derived closure verdict is not valid (root-cause: library, so CLI + any
  caller fail closed).
- **§11.12** error specificity: CLI `verify` no longer collapses every closure
  failure to `GRAPH_CLOSURE_MISSING_ROLE`; it distinguishes rejected-extra from
  missing-role using the closure report.

Mutation battery `tests/adversarial/offlineVerifierMutations.test.ts` (10 cases,
run through the shipped CLI in fresh processes) all green; suite 355 → **365**.

Remaining 6R-A items (pending, tracked): signed-member inventory of **every**
retained signed artifact (§6.4 full inventory beyond inventory+attestation);
attestation-binding isolation test that survives the hash chain (currently the
chain/signature layers catch binding tamper first — cross-check is defense in
depth); environment-branch offline selection verification (§8.5, gated on 6.5).

---

## 6R-B Lifecycle — IN PROGRESS (cancellation + lease landed)

Delivered this pass:
- **Mandatory cancellation terminal.** New closed contract `cancellation-request/v1`
  (`ERL2-C-063`, additive — generated types regenerated, `verify:generated`
  clean). `RunWorkspace.cancel()` freezes signed cancellation evidence, records
  the observed phase, performs frontier cleanup, and freezes exactly one
  `InvalidLabRunRecordV1` with a cancellation reason and **no** finding. CLI
  `erl2 cancel --reason … [--actor …]`; exit 12 on success, refuses before
  acceptance (`CANCELLATION_BEFORE_ACCEPTANCE`, exit 2) and after terminal
  (`CANCELLATION_AFTER_TERMINAL`, exit 11). The record verifies offline via
  `verify-record`. Tests: `tests/e2e/cancellation.test.ts`.
- **P1-2 wedge fix.** The frontier cleanup no longer calls
  `requireHashForRole("subject-output-manifest")`; a run invalidated/cancelled
  before subject output gets `cleanup.variant:"none"` instead of a
  `GRAPH_CLOSURE_MISSING_ROLE` wedge. Shared `freezeFrontierCleanup` used by both
  `invalidate()` and `cancel()`.
- **Durable run lease.** `packages/core/src/lifecycle/lease.ts`: file lease
  (`state/lease.json`) created with `O_EXCL`; live foreign lease →
  `POLICY_RUN_LEASE_HELD` (Lab-owned, exit 2); stale lease recoverable under a
  bounded TTL; owner-checked release; wired into every mutating `--run` command
  via `withRunLease`. Tests: `tests/integration/runLease.test.ts` (concurrent
  refusal, stale recovery, foreign-release no-op, no-leak, CLI-level).

Delivered in a second 6R-B pass:
- **Idempotent replay.** `acquire()` and `verifyPackage()` return their durable
  record when it is already recorded in the lifecycle, without re-invoking the
  subject port or re-freezing bytes — so a retried/replayed command is a no-op
  and no external mutation is duplicated (§7.3). The exact review wedge is fixed
  and regression-tested. Tests: `tests/e2e/replay.test.ts`.
- **Failure ownership.** The `acquire` catch routes to the adapter-finding path
  **only** when `cause.owner === "adapter"`; a Lab-owned conflict
  (`ARTIFACT_ALREADY_FROZEN`, which defaults to owner `lab`; a lease conflict; a
  closure failure) re-throws as the Lab error it is, instead of fabricating an
  adapter finding (§7.5). Covered by the replay test's "no fabricated adapter
  finding" assertion.

- **P2-5 pre-dispatch state validation.** `assertSubjectPortExecutable(state)`
  (states.ts) is called at the top of `acquire()`/`verifyPackage()` — after the
  idempotency guard, before any port call or freeze — refusing subject/adapter
  execution on any revealed, finalized, cleanup or invalidating run with zero
  external effect. Tests: `tests/adversarial/postRevealExecution.test.ts`
  (unit over every entrypoint state) + a finalized-run stray-command e2e.

Delivered in a third 6R-B pass:
- **ADR-ERL2-018** (accepted) records the run transaction / recovery / run-lease /
  idempotency / pre-dispatch / cancellation model and the crash-boundary
  reconciliation rules.
- **Artifact-freeze crash-idempotency (§11.4).** `ArtifactStore.freeze` reconciles
  a markerless or corrupt-marker content file: identical bytes complete the
  freeze (marker rewritten), different bytes are a typed `ARTIFACT_ALREADY_FROZEN`.
  A markerless artifact never wedges.
- **Snapshot resilience (§11.9).** `LifecycleLog.snapshot()` is derived from the
  in-memory event state (never reads the cache file); `status` rebuilds from the
  event log when the cache is torn/missing; `RunWorkspace.index()` skips the
  derived `state/` dir and treats unparseable files as non-artifacts. A torn
  snapshot no longer crashes any command.
- **Crash/replay matrix (§7.8).** `tests/e2e/crashRecovery.test.ts`: markerless
  and corrupt-marker freeze recovery; torn/missing snapshot recovery for `status`
  and for a mutating command; out-of-order refusal without wedge; and the
  always-reachable cancel terminal. (Replay idempotency, concurrent-replay
  serialization and post-reveal refusal are in replay/runLease/postRevealExecution
  suites.)

Delivered in a fourth 6R-B pass — **byte-deterministic timestamps**:
- A run's post-acceptance artifacts are stamped by a `SteppingClock` anchored on
  the durable preregistration `registered_at` (CLI `openWorkspace`), so a
  replayed command rebuilds byte-identical records and step outcomes.
- `LifecycleLog.writeSnapshot()` derives `updated_at` from the just-appended
  event rather than a fresh clock read (a clock read there advanced only on real
  appends, diverging on idempotent replays).
- Result: the crash-**between**-record-freeze-**and**-outcome-event window now
  **auto-resumes** on the shipped development-tier path — replay → byte-identical
  rebuild → idempotent re-freeze → the missing event is appended → the run
  continues (`tests/e2e/replay.test.ts` "auto-resumes").

Remaining (Slice 7+, documented in ADR-ERL2-018): for a *real* out-of-process
adapter, re-invoking the port on that window is a genuine duplicate mutation; the
record-file reconcile (append the missing event from the frozen record without
re-dispatching the port) lands with the adapter path. On the shipped fake-port
path the port re-run is deterministic and side-effect-free, so no duplicate
external mutation occurs today.

## 6R-D Evidence reproducibility + independence — IN PROGRESS

Delivered:
- **P2-10 (primary defect).** Routine `npm run evidence` no longer mutates the
  approved goldens: `generate-evidence.mjs` defaults its output to a fresh temp
  directory, runs all 62 CLI invocations (including the offline `verify` /
  `verify-record`, exit 0) there, and leaves `fixtures/golden` untouched
  (verified: golden manifest `66e1e276…` unchanged before/after). Only the
  explicit `evidence:update` (`--update`) rewrites the goldens; `--out <dir>`
  targets a named dir. Determinism foundation: the CLI stamps post-acceptance
  artifacts with a clock anchored on `registered_at`, preregistration honors
  `ERL2_EVIDENCE_CLOCK`, and every CLI-driven evidence run uses a fixed UUIDv7 run
  id and a fixed working dir under `.erl2-work`. CI gains a
  `git diff --exit-code fixtures/golden` drift guard.
- **§9.2 expected refusals** are machine-asserted: `tests/e2e/expectedRefusals.test.ts`
  checks every recorded refusal has a nonzero exit, a stable error code, the Lab
  authority scope, no forbidden terminal artifact, and is one of the known
  expected refusals.
- **§9.5 runtime record.** `tests/architecture/nodeVersion.test.ts` records the
  actual Node version and enforces the `engines` floor (>= 22). This host runs
  Node v26.4.0; CI runs Node 22.

Delivered in a second 6R-D pass — **full byte-identical golden pinning**:
- **Governor hiding-commitment RNG seeded.** `ageEncrypt(plaintext, recipients,
  random = randomBytes)` now accepts an injected RNG (the file key, per-recipient
  ephemeral keys and payload nonce). Real runs use the CSPRNG default; the
  evidence build injects a seeded stream via `buildGovernorRegistry({ random })`
  → `commitJourneyStep({ random })`, so every hiding-commitment ciphertext and
  canary token — and the commitment hash that covers the ciphertext digest — is
  byte-reproducible. Regression: `integrity.test.ts` "DETERMINISM 6R-D".
- **Deterministic timestamp `checkpoint_id`.** `TimestampLog.anchor` derives the
  id from the checkpoint's own content (`log_id`/`run_id`/`sequence`/artifact
  hash/`at`) instead of `randomUUID()` — unique (sequence is monotonic) and
  reproducible. This was the sole remaining nondeterminism in the fake-run
  attestation/bundle chain.
- **`evidence:verify`** (`generate-evidence.mjs --verify`, wired as
  `npm run evidence:verify`): deterministically generates into a throwaway dir
  and **byte-compares** against the pinned `fixtures/golden` **without mutating
  it**. It **explicitly excludes and logs** two subtrees that cannot be byte
  stable: `adapter-platform/**` (a REAL out-of-process reference adapter whose
  `request.frames` bake the absolute adapter-workspace path and whose hostile
  fixture writes a real OS `grandchild.pid`) and `cli-transcript.json` (records
  absolute invocation paths) — the prompt's sanctioned "exclude those subtrees
  explicitly" option. Result: **615 files byte-pinned, 166 excluded**, byte-for
  -byte match. Generate-twice into two dirs is byte-identical over the pinned set.
- **Goldens regenerated once** via `evidence:update` (authorised). Recorded
  semantic diff: (1) seeded governor commitments → every `journey-step-commitment`
  hash and the events/artifacts referencing it; (2) content-derived
  `checkpoint_id` → every `trusted-timestamp-checkpoint` and its downstream
  attestation/bundle/signer-inventory; (3) §11.6 adapter-derived manifest hashes;
  (4) §11.11 doctor `subject_isolation.qualification` `qualified` →
  `locally_observed_unauthenticated`; (5) §11.13 doctor `registered_contracts`
  +2. **Golden tree manifest: `66e1e276…` → `5879fe1d66471f99…`.**
- **CI** now runs `evidence:verify` (byte-pin) plus the `git diff --exit-code`
  drift guard.

Remaining in 6R-D: none. The two nondeterminism sources are closed (governor)
and explicitly excluded-with-reason (real adapter subprocess).

- **P2-9 — done.** `tests/architecture/removability.test.ts` copies core packages
  into the isolated tree so `@erl2/*` resolution cannot escape to the repo's
  adapters, with a negative control asserting an adapter import fails to resolve
  there. `tests/architecture/purity.test.ts` scans every `@erl2/<pkg>` specifier
  form (single/double quote, side-effect, dynamic `import()`, `require`, aliased
  `createRequire`, subpath) and its seeded-sensitivity test exercises the real
  file scanner over a planted file.

## 6R-E Isolation-qualification authenticity — P2-1 done

- **Verifier-controlled authenticity chain.** `packages/core/src/adapter/isolationAuthenticity.ts`
  verifies the substrate lock's Ed25519 signature (signed-hash == `core_hash`,
  then `verifySignature`) and classifies the signer against a **pinned,
  verifier-controlled** authority set. A development key (repo-derivable) is
  explicitly not an authority, so a valid dev-signed lock is
  `locally_observed_unauthenticated`, not `authenticated`.
- **Doctor reports the distinguished outcome** (§10.2): `authenticated` /
  `locally_observed_unauthenticated` / `not_qualified`, plus
  `substrate_lock_signature` (valid / signer / reason) and `launcher_available:
  false`. On this checkout doctor now says `locally_observed_unauthenticated`
  (was the producer-assertable `qualified`).
- **Tests** (`tests/integration/isolationRetainedEvidence.test.ts`): the retained
  lock signature verifies, is dev-signed (not authority-signed), derives
  `locally_observed_unauthenticated`; a corrupted signature → `not_qualified`
  (the exact review repro); an unpinned/forged signer → `not_qualified`.
- **Docs aligned** (§11.11): README and `permitted-claims.md` now state the
  self-reported / unauthenticated scope and that opaque execution stays refused.
- **OQ-008 stays open** (§10.3): the container launcher is not implemented,
  adapter certification has not run under the qualified profile, and every
  opaque/third-party subject is still refused.

Delivered in a second 6R-E pass — **probe-result authenticity (§10.1)**:
- New signed contract `isolation-probe-signing-manifest/v1` (`ERL2-C-154`,
  additive): binds the ordered core hashes of all twenty probe results to the
  lock and probe suite, signed by the qualification authority.
- `buildIsolationProbeSigningManifest` / `verifyIsolationProbeManifest`
  (`isolationAuthenticity.ts`): verification checks the signature, the lock and
  suite binding, and that the manifest covers **exactly** the evaluated probe
  results (order-independent set equality). Distinguished status `absent` /
  `invalid` (tamper/substitution) / `valid_development` / `valid_authority`.
- `deriveIsolationAuthenticity` now takes the probe-manifest verification:
  `authenticated` requires BOTH a pinned-authority lock signature AND a
  `valid_authority` probe manifest; a present-but-broken manifest forces
  `not_qualified`; a dev-signed or absent manifest stays
  `locally_observed_unauthenticated`. So the probe *results*, not just the lock,
  must be authenticated for an authenticated qualification.
- `erl2 doctor` reads and verifies `environments/isolation/probe-signing-manifest.json`
  and reports the `probe_manifest` status/signer; the retained manifest is
  dev-signed → `valid_development` → the honest outcome stays
  `locally_observed_unauthenticated`. `qualify-isolation.mjs` now emits the
  manifest for future real qualifications.
- Regression: `isolationRetainedEvidence.test.ts` "ISOLATION-PROBE-AUTHENTICITY
  §10.1" — covers-exactly, dev vs authority signer, tampered → not_qualified,
  incomplete coverage → invalid, and that an authority manifest is required (not
  the lock alone) for `authenticated`.

Remaining in 6R-E: none for §10.1. The §11.5 environment-substrate-lock drift
symmetry + signature verification landed under §11.5 (see the P3 table).
OQ-008 stays open; launcher not built; opaque execution refused.

## Remaining P2 findings

| ID | Requirement | Disposition | Notes |
|----|----|----|----|
| P2-1 | ADR-016/017 "observed, never declared" | **fixed** (6R-E) | New `isolationAuthenticity.ts` verifies the substrate-lock Ed25519 signature and classifies the signer. `erl2 doctor` now reports the distinguished authenticity outcome — the retained lock is signed by the repo-derivable **development** governor key, so it reads `locally_observed_unauthenticated`, never the producer-assertable `qualified`. A tampered signature or an unpinned/forged signer → `not_qualified`. OQ-008 stays open; launcher not implemented; opaque execution still refused |
| P2-5 | FR-007/AC-012 | **fixed** (6R-B) | `assertSubjectPortExecutable(state)` runs at the top of `acquire()`/`verifyPackage()` — after the idempotency guard, before any port call or freeze — refusing subject/adapter execution on any revealed/finalized/cleanup/invalidating run with zero external effect. Tests: `postRevealExecution.test.ts` (every entrypoint state) + finalized-run stray-command e2e (ADR-ERL2-018) |
| P2-6 | §11.2 host contract | **fixed** | New `responseShape.ts` closed validator runs at frame decode, before any field/array is consumed → typed adapter-owned `ADAPTER_PROTOCOL_FRAME_INVALID`. Tests: `malformed-response` sabotage fixture in host + certification lanes; false-attribution now caught pre-consumption |
| P2-7 | OQ-007 | **fixed** | `assertDevelopmentTierOnly(request.requested_tier, policy.source_id)` now called inside **both** `runSelectionChain` (producer) and `verifySelectionChain` (verifier). Test: kernel-level blind-tier-on-dev-beacon refusal (`ERL2-OQ-007 wired`). Threshold VRF stays disabled |
| P2-8 | selection independence | **mostly fixed** (6R-C) | Frozen known-answer vectors for pool root, hiding commitment, source/request binding, selected index (3 cases) + rejection-limit formula, each three-way cross-checked: production == an independent raw-`node:crypto`+hand-JCS reference == a frozen literal (`tests/adversarial/selectionKnownAnswers.test.ts`). The reference never imports `derive.ts`/`@erl2/integrity` domain-hash. **Remaining (§8.5, gated on 6.5):** wiring `verifySelectionChain` into the environment offline verifier path so retained selection artifacts are independently re-derived (the chain verifier + KATs exist; the environment offline path is unshipped) |
| P2-9 | product independence evidence | **fixed** (6R-D) | Removability test now **copies** core packages into the isolated tree (was `symlinkSync`, whose realpath walked back into the repo's `node_modules/@erl2` where adapters live) + a **negative control** proving an adapter import fails to resolve there. Purity import scan is now form-agnostic (any quoted `@erl2/<pkg>` specifier → catches single/double quote, side-effect, dynamic `import()`, `require`, aliased `createRequire`, subpath); the seeded-sensitivity test exercises the real file scanner over a seeded file on disk |
| P2-10 | plan §19.3 | **fixed** (6R-D) | Routine `evidence` never mutates goldens; **`evidence:verify`** now byte-pins the deterministic generation (615 files) against `fixtures/golden` with the real-adapter subprocess subtree explicitly excluded-and-logged; governor hiding-commitment RNG seeded + content-derived `checkpoint_id` closed the last two nondeterminism sources; generate-twice is byte-identical; CI runs `evidence:verify` + the git-diff drift guard. Goldens regenerated once (manifest `66e1e276…` → `bbda627c0075…`) |
| P2-11 | FR-016 | **fixed (honest scope)** (6R-C) | Oracle surfaces reconciled honestly: `LIVE_ORACLE_SCAN_SURFACES = ["adapter_request"]` (the only surface scanned on the shipped path) vs `PENDING_ORACLE_SCAN_SURFACES` (the seven that become live with the 6.5 environment/journey orchestration) — the code no longer implies all eight are scanned. Test pins the split + proves the live surface is fail-closed on token detection with an empty known-id list (`tests/adversarial/oracleSurfaceCoverage.test.ts`). `assertTranslationTotality` is a complete gate with refusal tests (`capture.test.ts`); its live wiring is the recorded 6.5 connection |

## P3 findings (compact)

| Finding | Disposition | Owner workstream |
|----|----|----|
| Duplicate-key bypass via JSON escapes (`{"a\/b":1,"a/b":2}`) | **fixed** | §11.1 — `readJsonString` in `validate.ts` now **decodes** key tokens (`\/`, `\uXXXX`, surrogate pairs) before duplicate comparison; malformed escapes are fail-closed. Regression: `contracts.test.ts` decoded-collision cases |
| `coreHash` hardcoded signature exclusions | **fixed** | §11.2 — `signature`/`root_signature`/`wrapper_signature` are excluded from a core **only** for schema versions that legally declare them (`signedSchemaAuthorityFields()`, derived from the frozen schemas); a signature field on any other schema version is refused fail-closed. `core_hash` stays universally excluded (identity, not authority). Frozen bytes unchanged. Regression: `integrity.test.ts` "unknown closed contract cannot smuggle an unhashed authority field (§11.2)" |
| JCS no NFC / duplicate-key at hash layer | **fixed** | §11.3 — the single JCS path (`jcs.ts`) now rejects non-NFC strings (keys and values) as an ERL2 precondition beyond RFC 8785, so no hashing/verification entrypoint can hash a non-NFC string even if it bypassed `validateContract`. Label kept honest (RFC 8785 does not normalise; we reject, never silently normalise). Duplicate-key rejection at the text boundary is `parseStrictJson` (used by the offline verifier's `artifactIndex.ts`). Frozen bytes unchanged. Regression: `integrity.test.ts` "single JCS path rejects non-NFC strings (§11.3)" |
| Artifact freeze not crash-idempotent (linkSync before marker) | **fixed** | §11.4 — store reconciles markerless/corrupt-marker content (identical bytes complete, different bytes typed conflict); crash-matrix tests |
| `assertObservedMatchesLock` asymmetric drift; env lock sig unverified | **fixed** | §11.5 / 6R-E — env `assertObservedMatchesLock` now compares images **bijectively** (extra observed image → drift) and configs as **exact sets** (missing locked config → drift), and verifies the lock's Ed25519 signature first (`verifySubstrateLockSignature`, mirroring isolation; new code `ENV_SUBSTRATE_LOCK_SIGNATURE_INVALID`; tampered signature refused). The isolation `diffObservedAgainstIsolationLock` now also compares `runtime_configuration_hashes`/`policy_input_hashes` (single-sourced through `ObservedSubstrateState`). Inert behind OQ-005/OQ-008; frozen bytes unchanged. Regressions: `environment.test.ts` §11.5 cases + `isolationSubstrate.test.ts` array-drift cases |
| Hardcoded `fake-subject/v1` config/capability hashes in manifests | **fixed** | §11.6 — `freezePackageManifest` now derives `configuration_schema_hash` from the admitted adapter manifest's `{adapter_id, protocol_version, projection_schema}` and `capability_declaration_hash` from its `{adapter_id, version, supported_package_kinds, operations, required_broker_capabilities, network_allowlist_ids}`. `fake-subject` survives only as an explicit fake adapter fixture's `adapter_id`. Regression: `journeyRun.test.ts` recomputes the derivation from the frozen adapter manifest and asserts the manifest matches it and NOT the legacy literal. **Golden bytes change** (`subject-package-manifest.json`) → regenerated with the 6R-D evidence pin |
| `RESERVED_GENERIC_METRIC_IDS` drift (15 vs 17) | **fixed** | §11.7 — one authoritative registry `RESERVED_GENERIC_METRIC_IDS` in `@erl2/contracts` (17 ids). The SDK re-exports it (was a stale 15-id copy missing `authority-scope`/`mutation-compensation`); core asserts its `GENERIC_METRIC_DEFINITIONS` equals it at module load. Regressions: two-way registry-equality test + a neutered-metric override refusal for both previously-missing ids (`genericEvaluation.test.ts`) |
| `--fake-acquire`/`--fake-verify-package` reachable in release CLI | **fixed** | §11.8 — the fake-subject scripting flags now require an explicit development profile (`ERL2_DEVELOPMENT_FAKE_SUBJECT=1`); on the default release surface they are refused with new code `CFG_DEVELOPMENT_FLAG_UNAVAILABLE` (append-only). The real-adapter path is unchanged (it already refused the flags via `CFG_MISSING_REQUIRED`) and ADR-013 still forbids a fake successful verification from pre-environment finalization. Test harnesses + the evidence generator opt in; a new release-surface refusal regression (`journeyRun.test.ts` §11.8) spawns without the profile and asserts the refusal |
| Torn `state/snapshot.json` crashes every command | **fixed** | §11.9 — `snapshot()` is in-memory-derived; `status` rebuilds from events on a torn/missing cache; `RunWorkspace.index()` skips `state/` and treats unparseable files as non-artifacts; crash-matrix tests |
| `SelectionVerificationReceiptV2.checks` booleans producer-trusted (docstring lies) | **fixed** | §11.10 — docstring corrected: the verifier's independent re-derivation is the authority, never the receipt booleans (schema-pinned `const: true`). `verify.ts` now also reads and enforces every `checks` boolean as defense in depth — a receipt that drops a key or attests one as not-`true` is refused (`SELECTION_CHAIN_EDGE_UNCLOSED`). Regression: `selectionChain.test.ts` §11.10 negates a check and asserts refusal |
| README/doctor `qualified` vs `not_qualified` contradiction | **fixed** | §11.11 / 6R-E — the isolation half was already aligned in README + permitted-claims (`locally_observed_unauthenticated`). This pass fixed the remaining stale overstatement in `docs/decisions/open-questions.md` OQ-008 ("**Qualified**" / "the substrate qualifies" → "locally observed but unauthenticated"), and updated the OQ-005 drift line to reflect the §11.5 exact/bijective drift + lock-signature verification. The stale `"qualified"` string in `fixtures/golden/cli-transcript.json` is corrected by the authorised 6R-D `evidence:update` (doctor now emits `locally_observed_unauthenticated`). |
| CLI closure failures collapse to one code | **fixed** | §11.12 (done in 6R-A) |
| Handwritten wire types (`ThresholdEnvelopeV1`, beacon proofs) | **fixed** | §11.13 — **beacon proofs** (persisted PUBLIC artifacts) are now closed schema-governed contracts `BeaconSignatureProofV1` (`ERL2-C-152`) / `BeaconInclusionProofV1` (`ERL2-C-153`); core re-exports the generated types (single source), validates them at freeze (`chain.ts`) and provides schema-validating `parseBeacon*Proof` for the offline boundary. **ThresholdEnvelopeV1** is a raw AEAD/crypto container (no `core_hash`/signature; AEAD tags are its integrity), so per the prompt it keeps an explicit-format parser — now hardened to reject unknown fields, bad constants, non-base64 blobs, out-of-range numbers and duplicate/short shares fail-closed. Additive only; no frozen schema changed. Regression: `wireTypes.test.ts`. NOTE: `registered_contracts` in `doctor` increases by 2 → golden `cli-transcript.json` regenerated with the 6R-D evidence pin |
| Unbounded strings / missing `uniqueItems`; hard-safety consumer; concurrency; platform determinism; synthesized discrimination fields | **evaluated (mixed fix/record)** | §11.14 — see the per-item table below |

### §11.14 per-item disposition

| Item | Disposition | Detail |
|----|----|----|
| Missing `uniqueItems` on set arrays | **fixed** | New `common#/$defs/UniqueHashArray` (`uniqueItems: true`, §16.1) now backs the genuine hash *sets* — substrate `config_hashes`, isolation `runtime_configuration_hashes`/`policy_input_hashes` — matching the set-comparison logic added in §11.5. Regression: `wireTypes.test.ts` §11.14 SET-ARRAYS. Other `HashArray` uses stay ordered (they are sequences, not sets); a blanket sweep is deliberately not done. |
| Unbounded strings | **recorded (low risk)** | Almost every contract string is already bounded by a pattern/format (`Id`, `Hash`, `Instant`, `Base64`, `KeyId`, `MediaType`) or an explicit `maxLength` (free-text `safe_summary`, reason strings). A remaining-string maxLength audit is a mechanical follow-up owned by the Slice 6.5 contract-freeze pass; no unbounded string is on a shipped ingest path today (the CLI caps diagnostics per NFR-002). |
| `hardSafetyViolations` has no run-blocking consumer | **fixed (primitive) + recorded (consumer owner)** | The primitive is behaviour-pinned (`wireTypes.test.ts` §11.14 HARD-SAFETY). Its run-blocking consumer is the **domain-evaluation → validity claim-scope gate** that activates with the environment branch (Slice 6.5), where domain metrics are actually *measured*; the shipped pre-environment path freezes `domain-result-not-applicable/v1` and measures no domain metric, so there is nothing to gate yet. There is no dedicated hard-safety finding category — the design routes non-tradeable hard-safety through `threshold_satisfied` + claim-scope capping, so inventing a finding here would misstate the design. Owner: Slice 6.5 domain finalization. |
| Environment-concurrency test coverage (sequential) | **recorded** | The environment allocator/lease concurrency is exercised sequentially; true parallel environment provisioning is a Slice 6.5 (Compose/launcher) concern and is fail-closed today (OQ-005). The run-lease concurrency IS tested cross-process (`runLease.test.ts`). |
| Platform-specific determinism | **recorded** | This host runs Node v26; the project targets Node 22 (`engines`), enforced by `nodeVersion.test.ts` and CI. Cross-platform byte-equivalence is asserted by CI on Node 22, not on this host (review §9.5). |
| Synthesized discrimination fields (object-value / citation-digest / association harness-synthesized) | **recorded** | These discrimination inputs are harness-synthesized in the current pre-environment/fixture path rather than adapter-driven; adapter-driven synthesis lands with the Slice 6.5 environment/observation branch where the real adapter emits them. Fail-closed until then. |

## §8.5 production offline selection verification (6.5-gated — recorded, not forced)

`verifySelectionChain` (independent re-derivation of the complete V2 selection
chain) and the three-way known-answer vectors (`selectionKnownAnswers.test.ts`)
exist and are green. Its `checks`-boolean enforcement was corrected under §11.10.
The interface is **ready**: it takes a `SelectionChainEvidence` bundle and a
`TrustEvaluator` and returns the verified selected entry, re-deriving pool root,
source/request binding, selected index and rejection count, beacon proofs,
checkpoint ordering and the hiding-commitment opening.

**Exact remaining connection (deferred to Slice 6.5, per plan §8.5):** the
*environment* offline verifier path does not yet read the retained selection
artifacts from a finalized environment-branch bundle and feed them into
`verifySelectionChain`. The environment branch is unshipped, so there is no
selection bundle to verify on the shipped pre-environment path. Wiring
`verifySelectionChain` into the environment offline verifier is the one
connection that **must be complete before Slice 6.5 activates the environment
branch**. It is not wired live now (doing so would require the unshipped 6.5
orchestration). No production path is weakened: the selection chain producer
(`runSelectionChain`) and verifier both already enforce OQ-007
(`assertDevelopmentTierOnly`) and refuse threshold VRF.

## P0

None confirmed by the review; none introduced. Opaque execution remains refused
at two independent gates; threshold-VRF, held-out/blind, Compose, container
launcher all remain fail-closed. Not touched.


---

# Pass 4 — independent re-audit of the remediated build (2026-07-26)

Method: rather than re-reading the earlier passes' claims, an adversarial battery
was run against the **fixed** build through the shipped `erl2` binary in fresh
processes, plus a live CLI lifecycle probe. Baseline before this pass: **418
tests pass / 0 fail / 0 skipped**; goldens `229d0cda…`. Final: **443 pass / 0
fail / 0 skipped**; goldens `e5ca1028…`.

Every earlier claim that was re-tested held, with the exceptions below.

| ID | Finding (all reproduced first-hand through the CLI) | Class | Root cause | Fix | Regression evidence |
|----|----|----|----|----|----|
| 6R-P4-1 | **Unindexable retained extras escape the rejected-extra rule.** A rogue `.bin`, a duplicate-key `.json`, a `.json` with no `core_hash`, and a JSON array each left `erl2 verify --offline` at **exit 0 / `valid`** | Blocker (same invariant as P1-1: ERL2-FR-020 / AC-023, design §14 step 6-7) | `ArtifactIndex.walk` silently `continue`s on any file it cannot index, so the closure's `rejected_extra_hashes` rule never sees it. The P1-1 fix closed only the *indexable* extra | New `retainedFiles.ts`: every regular file under `retained/` must be an indexed artifact, a freeze marker of one, a referenced descriptor path, or a declared content-addressed payload. Runs **after** closure derivation so a missing role keeps its own cause (§11.12) | `MUT-6R-EXTRA-a…h` (8 cases, fresh-process CLI). 7 fail if the check is removed |
| 6R-P4-2 | **Five retained signed members were never signature-verified** — acquisition source manifest, preregistration, its receipt, subject adapter manifest, generic run policy. One flipped base64 character left the bundle at **exit 0 / `valid`** | Blocker (§6.4; completion gate "every applicable signed member is verified") | Only the attestation, inventory, trust root and checkpoints were verified. A signature is excluded from `core_hash` by design, so the hash chain *cannot* catch this | New `signedMembers.ts`: a **verifier-owned** schema → {role, signing domain, security instant} table; every signed retained artifact is verified; an undeclared signed contract is refused outright | `MUT-6R-SIGNER` (5 cases + an undeclared-contract case). All 5 fail if the pass is removed |
| 6R-P4-3 | **`verify-record` verified no signatures at all**, though an invalid record retains five-plus signed members | Blocker (§6.4) | `verifyInvalidRecord` accepted `localTrust` and never built a `TrustEvaluator` | Builds one from the mirrored `retained/trust-policy.json`, authorized only against the locally pinned head; refuses a record with no authorizable head rather than skipping verification. `fakeRun.ts` aligned with the shipped producer (which always mirrored the policy); three `invalid-run-*` goldens regenerated | `MUT-6R-SIGNER` invalid-record cases, incl. "removing the mirrored trust policy does not disable record signature checks" |
| 6R-P4-4 | **A *refused* post-terminal command still wrote retained evidence.** `freeze-output` on a cancelled run returned exit 11 **and** froze `retained/subject-output-manifest.json`, turning that run's verifying `InvalidLabRunRecordV1` into a `GRAPH_CLOSURE_EXTRA_ARTIFACT` refusal | Blocker (§8.2 "a refusal causes zero new retained evidence"; ADR-018 §4 stated this but did not implement it here) | `assertSubjectPortExecutable` was wired into the two *port-dispatching* entrypoints only. `freezePackage()` / `freezeSubjectOutput()` froze bytes first and only then appended the event that rejects the state — the review's own "freeze before lifecycle append" sub-finding, partially fixed | Pre-freeze guard at the top of both | `POST-TERMINAL-NO-WRITE`: every refused post-terminal command adds zero retained evidence. Fails if either guard is removed |
| 6R-P4-5 | **The CLI could still exit untyped.** A missing/malformed `--public-bundle`, `--record` or `--root-config` escaped as a raw `ENOENT`/`SyntaxError` stack trace, exit 1, no code, no envelope | Medium (design Appendix B/C; §9.2 "stable error code"; §11.9's general case) | `runCommand` rethrew non-`Erl2Error`; `bin.ts` had no top-level guard; `readFileSync`/`JSON.parse` throw plain errors | One typed `loadJsonDocument` helper; a `runCommand` backstop; a `bin.ts` guard; append-only `LAB_` prefix + `LAB_UNEXPECTED_FAILURE` | `tests/e2e/typedRefusals.test.ts` (8 cases): one parseable envelope, catalogued prefix, Lab scope, empty stderr, envelope exit == process exit |
| 6R-P4-6 | **The evidence byte-pin excluded 166 files when only 7 are nondeterministic.** The whole real-adapter subtree was unpinned | Medium (§9.1 honesty/coverage) | Whole-subtree exclusion instead of per-file | Per-file exclusions with printed causes: `request.frames` (absolute workspace path), `grandchild.pid` (real OS pid), `cli-transcript.json` (absolute CLI paths) | `evidence:verify` — **780 pinned / 7 excluded** (was 621 / 166); two independent generations byte-identical |

## Pass-4 re-reproductions of earlier claims (all held)

| Earlier claim | Independent re-check | Result |
|----|----|----|
| P1-1 rejected extra | rogue self-consistent JSON into a real-CLI valid bundle | exit 10 `GRAPH_CLOSURE_EXTRA_ARTIFACT` |
| P2-2 raw bytes | binary byte flip; truncation; in-root payload substitution; descriptor path escape with a *recomputed* `core_hash` | exit 10 `ARTIFACT_HASH_MISMATCH` / `PATH_ESCAPES_ROOT` |
| P2-3 inventory signature | surgical same-length tamper with the byte layer repaired first | exit 10 `TRUST_SIGNATURE_INVALID` (the existing `tamperSignedMember` isolation test is genuine) |
| P2-4 invalid-record closure | rogue extra in an invalid record | exit 10 `GRAPH_CLOSURE_EXTRA_ARTIFACT` |
| P1-2 delayed replay | live CLI: `acquire` → sleep 1.7 s → `acquire` | exit 0, idempotent, **no** fabricated adapter finding, run not wedged |
| Cancellation | live CLI `cancel` from a nonterminal state | exit 12 `CANCELLATION_REQUESTED`; 1 invalid record; **0** findings; 1 signed request; refusing again → exit 11 |
| §11.9 torn snapshot | truncated `state/snapshot.json`, then `status` | exit 0, rebuilt from the event log |
| P2-1 isolation | `doctor`; then substrate-lock signature tamper | `locally_observed_unauthenticated` / `launcher_available=false`; tampered → not qualified |
| Selection | `erl2 select` | exit 2 `POLICY_COMMAND_NOT_IMPLEMENTED` (unorchestrated, OQ-007 enforced in-kernel) |
| Lifecycle stream | event deletion / duplication / reorder | exit 10 `VERIFY_RECORD_LIFECYCLE_GAP` |
| Crossover | attestation into an invalid record; invalid record into a valid bundle | exit 11 `INVALID_TERMINAL_ATTESTATION_FORBIDDEN` / exit 10 `GRAPH_CLOSURE_EXTRA_ARTIFACT` |

One earlier ledger claim was **imprecise**: the P2-10 row and the 6R-D section
record two different post-`evidence:update` golden manifests (`5879fe1d…` vs
`bbda627c…`). Neither matches the tree as found (`229d0cda…`). The manifest is
now `e5ca1028…`; treat the earlier two values as stale.

## Remaining limitations after pass 4

- **§8.5 environment offline selection verification stays unwired** (Slice 6.5
  owns it), but the posture is now stronger than "recorded": retaining any signed
  selection contract is refused, because the verifier declares no authorized
  signer role for it. Declaring those roles is part of wiring
  `verifySelectionChain` into the environment offline path.
- **Attestation binding cross-checks are defense in depth, not independently
  exercised.** Re-pointing a binding at a different real retained artifact is
  caught first by the attestation's own stale `core_hash`; isolating the
  cross-check would require re-signing a self-consistent bundle with the
  finalizer key.
- **Node version.** This host runs Node v26.4.0; the project targets Node 22.
  Cross-platform / Node-22 byte equivalence is asserted by CI, not on this tree.
- **Seven evidence files remain unpinnable** for the named, structural reasons
  above.
