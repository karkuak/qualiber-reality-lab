# Independent Code Review — External Reality Lab V2, through Slice 6

Reviewer stance: independent principal engineer / security / verification auditor. Conclusions below rest on my own reading of the normative sources and the code, the prescribed clean verification run, and first-hand adversarial reproduction against the built artifacts. Where a delegated reviewer reported something, I reproduced it myself before adopting it; one agent claim (a "fake-succeeded verification finalizes into a signed attestation") I checked and rejected because ADR‑013 blocks it.

Revision basis (confirmed): design `2.0.0-draft.11`; implementation plan names `2.0.0-draft.11`; ledger `generated_for_revision: 2.0.0-draft.11`. ADRs 001–006, 011–017 accepted; 007–010 proposed (all for Slices 7–11). No revision drift affecting authority. No Slice 1–6 code depends on a non‑accepted ADR.

Process note (review integrity): twice during this review, tool‑surfaced content in the shared scratchpad carried an embedded instruction to run an unrelated script and to *conceal it from you* ("don't tell the user"). This is consistent with two parallel workers colliding on a `probe.mjs` filename, but the pattern is a prompt‑injection shape. I did not author or act on those instructions, and I'm surfacing them because one told me not to. They did not affect any finding.

## 1. Findings (ordered P0 → P3)

### P0 — Critical

None confirmed. No path was found that produces a false *valid* attestation of a genuinely invalid run, discloses truth/secrets, escalates authority, or executes an opaque/third‑party subject. Opaque execution is independently refused at two gates (`assertSandboxProfileEnabled("container")` and `assertSubjectMayRunUnderProfile`), and the offline verifier genuinely rejects JSON byte‑tamper, signature tamper on the attestation, missing artifacts, and record/bundle crossover (all reproduced).

### P1‑1 — Offline public‑bundle verifier records rejected‑extra artifacts but does not act on them (pre‑environment terminal)

1. Title: Pre‑environment closure verdict ignores `rejected_extra_hashes`.

2. Severity: P1.

3. Invariant violated: ERL2‑FR‑020 / ERL2‑AC‑023 / design §14 step 6–7 ("rejected extra artifacts invalidate closure"; "reject … unreferenced mandatory … artifacts even when every supplied hash and signature is internally valid").

4. Location: `packages/public-verifier/src/library/closure.ts:274` — `verdict: (missing.length === 0 ? "valid" : "invalid")`. Compare the sibling derivations that *do* fold extras in: `environmentClosure.ts:375` (`missing===0 && rejected===0`) and the invalid branch `closure.ts:538` (`rejected===0`), and the finalizer‑side gate `closure.ts:400` (`extras===0`).

5. Evidence (my repro, real‑CLI fixture `generic-finalization-failed-verification`): injecting a self‑consistent rogue JSON (`rogue-artifact/v1` with a correctly computed `core_hash`) into `artifacts/retained/` yields `erl2 verify … --offline` → exit 0, `ok=true`, `verdict="valid"`, and `closure.rejected_extra_hashes=["sha256:3f29…"]`. The verifier derives the extra correctly and then ignores it.

6. Reproduction: copy the fixture, write the rogue artifact, re‑run `erl2 verify`. The rogue hash appears in the closure report; the verdict stays valid.

7. Impact: the offline verifier — the entire third‑party trust anchor — declares a bundle valid when its own derived closure says the retained artifact set contains an unaccounted artifact. It cannot forge the attestation or launder an invalid *run* (the attestation is genuine, the extra is inert), which is why this is P1 and not P0; but the "no unaccounted artifacts" closure guarantee is defeated on the only valid terminal that ships.

8. Why tests missed it: every `rejected_extra_hashes` assertion in the suite is `assert.deepEqual(…, [])` on a clean run (`preEnvironmentRun.test.ts:88`, `journeyRun.test.ts:365`, `genericFinalization.test.ts:202`). No test ever adds an unaccounted artifact to a *valid* run and asserts rejection. Deleting the `rejected` handling from the pre‑env verdict breaks zero tests.

9. Remediation: fold `rejected.length` into the pre‑environment verdict as the other two branches already do; add a positive adversarial test that injects an extra and asserts `verdict==="invalid"`.

### P1‑2 — Pre‑environment lifecycle is not replay/crash‑safe: an ordinary replay wedges a healthy run with no terminal record and fabricated cross‑owner evidence

1. Title: Replayed / out‑of‑order CLI step destroys a healthy run, freezes no `InvalidLabRunRecordV1`, and blames the adapter.

2. Severity: P1.

3. Invariant violated: ERL2‑FR‑001 ("every accepted invocation MUST yield exactly one `LabRunRecordV1` terminal variant"); Appendix C ("the CLI cannot return a terminal run state without its record hash"); NFR‑003 (crash recovery duplicates no mutation); §20 failure ownership (a Lab conflict must not be an adapter finding); Slice 2 exit gate / M1 ("invalid fake runs survive … crash, restart").

4. Location: `packages/core/src/run/workspace.ts:429` (port executes before any idempotency/state/lease check); records embed wall‑clock `started_at`/`ended_at` (`:469`) so a replay differs by bytes; `packages/cli/src/journeyCommands.ts:307‑316` maps the Lab's own `ARTIFACT_ALREADY_FROZEN` (owner `lab`) to an *adapter* failure and invalidates; `workspace.ts:913` — `invalidate()` demands a `subject-output-manifest` role the run never reached. The in‑process run lease (`lifecycle/log.ts:105‑114`) is never called (dead code).

5. Evidence (my repro): `preregister-acquisition` → `acquire` (exit 0, `step_outcome_frozen`) → wait 1.6 s (crossing a wall‑clock second) → `acquire` again ⇒ exit 10 `GRAPH_CLOSURE_MISSING_ROLE`; `retained/invalid-run-record.json` absent; a fabricated `retained/finding-adapter-protocol-failure.json` frozen; `freeze-package` and `freeze-output` thereafter refuse with `POLICY_CONFLICT`. (An instant re‑run is idempotent because the timestamps round to the same second — the defect surfaces only when the replay lands in a different second, i.e. any realistic retry.) The lifecycle lens independently reproduced the same wedge for out‑of‑order `freeze-output`/`evaluate` (`workspace.ts:791‑823`, `:1251‑1279` freeze artifacts before the lifecycle append) and for a mid‑`finalize-generic` failure (`:1389‑1423`), each leaving a non‑terminal, unrecoverable run.

6. Reproduction: as above; also `freeze-output` at the wrong state then the correct one → permanent `ARTIFACT_ALREADY_FROZEN`.

7. Impact: a benign operational event (a retried command, a double invocation, a resumed script, or a crash between a freeze and its event) turns a healthy run into a permanently wedged run with no terminal record and evidence that misattributes a Lab‑side conflict to the subject's adapter. This is a direct violation of the P0 requirement FR‑001 and of the crash/restart survival the Slice 2 gate claims.

8. Why tests missed it: there is no Lab‑side crash‑injection suite (plan §8.6's "crash before/after write, freeze, event, snapshot, checkpoint" matrix does not exist); the only genuine kills target the sabotage *adapter* subprocess. The e2e "multi‑process resume" test exits each process cleanly and never kills between append and snapshot, never replays a step across a second boundary, and never runs two `acquire`s concurrently.

9. Remediation: acquire the run lease and check idempotency/state before invoking the port; derive record timestamps from a committed monotonic domain (or exclude presentation times from freeze bytes) so a replay is byte‑identical and idempotent; classify `ARTIFACT_ALREADY_FROZEN`/lease conflicts as Lab conflicts (not adapter failures); ensure every accepted run that fails routes to exactly one `InvalidLabRunRecordV1`; add the crash matrix.

### P2 findings

### P2‑1 — OQ‑008 isolation qualification is producer‑assertable; the one signature present is never verified.

Invariant: ADR‑ERL2‑016/017 ("enabled status is derived, never declared; only *observed* counts") and the permitted claim "the twenty controls were observed holding." `packages/cli/src/isolationStatus.ts` (doctor) and `isolationQualificationReport.ts:145‑181` re‑derive `qualified` only from the content of `environments/isolation/probes/*.json`; probe results and the qualification report carry no signature, and the substrate lock's Ed25519 signature is never verified (no `verifySignature` call in any isolation path). `developmentKey(label)` is deterministic (`sha256("erl2-development-key:"+label)`), so the governor key is reproducible from the repo. My repro: corrupting the lock's `signature_base64` to garbage still yields `isolationStatus().qualification==="qualified"` (20/20 observed). A hand‑authored `environments/isolation/` with 20 `evidence:"observed"` files therefore qualifies under `erl2 doctor`. Correctly blocked: mocked/declared/absent/unpinned evidence (schema forces `enforced`⇒`observed`; `fakeEnforcementProbes` stamps `mocked`). The gap is that *fabricated observed* evidence has no authenticity anchor. Impact is bounded — opaque execution is refused independently, so this cannot cause unsafe execution; it corrupts the doctor report and the "observed holding" claim. Remediation: verify the lock signature against a pinned trust policy and sign/verify probe results, or scope the claim to "self‑reported."

### P2‑2 — Offline verifier never recomputes `file_sha256` of referenced non‑JSON artifacts.

Invariant: ERL2‑AC‑013 ("independent verifier rejects byte … mutations"). `artifactIndex.ts:53` skips non‑`.json` and `.frozen` files; the computed `fileSha256` for JSON is never consumed; only the *producer's* `store.ts` checks bytes. My repro: flipping one byte of the referenced package `…515.bin` — whose sha256 is its filename and the signed `frozen_package_file_sha256` — still verifies `valid`, exit 0. Retained raw evidence can be swapped undetected. P2 because the tampered bytes are evidence, not a verdict input. Remediation: recompute and compare `file_sha256` for every referenced `ArtifactRef` during closure.

### P2‑3 — The signer inventory's signature is not verified, and the attestation's binding hashes are not cross‑checked.

`verify.ts` verifies Ed25519 only on the final attestation (`:128`,`:262`). My repro: corrupting `signer-inventory.json`'s `signature_base64` (leaving `core_hash` intact) still verifies `valid`; the identical corruption on `final-attestation.json` correctly fails `TRUST_SIGNATURE_INVALID`. `attestation.signer_inventory_hash` / `timestamp_checkpoint_hash` / `adapter_hash` etc. are not re‑checked against the retained artifacts. Remediation: verify every signed bundle member and cross‑check the attestation's declared binding hashes.

### P2‑4 — `erl2 verify-record` ignores the derived closure verdict.

The CLI `verifyRecord` returns `ok` unconditionally; unlike `verify` (which throws when `verdict!=="valid"`, `index.ts:327`), it never consults `closure.verdict`. `deriveInvalidClosure` correctly sets `verdict:"invalid"` for an unaccounted extra, but the CLI reports success (exit 0). Defeats ERL2‑AC‑031 for the invalid‑record path. Remediation: fail `verify-record` when `closure.verdict!=="valid"`.

### P2‑5 — Subject port executes before any state validation → post‑reveal / post‑terminal execution.

Invariant: ERL2‑FR‑007 / AC‑012 ("post‑reveal subject execution is forbidden"). `workspace.ts:429`/`:590` run the port before `assertNoSubjectExecutionAfterReveal` (which lives inside `runStep`, after execution). The lifecycle lens showed a stray `acquire` on a `judge_journey_expectation_revealed` or `generic_finalized` run *executes the port* and then freezes a fabricated finding into the finalized run root. Remediation: validate lifecycle state before dispatching the port.

### P2‑6 — Hostile adapter response is iterated before schema validation → untyped crash on the production path.

Invariant: §11.2 / host contract ("a broken, hostile or absent adapter always yields a *typed* adapter/Lab outcome"). `host.ts:800` casts the inbound message (`as unknown as AdapterResponseMessage`) and iterates `response.mutations` (`:419`), `compensations` (`:437`), `credential_requests` (`:451`), `egress_attempts` (`:478`) before `assertContract` at `:529`. A hostile adapter omitting an array throws `TypeError: response.mutations is not iterable` with no `code`/`owner`; the CLI top level rethrows non‑`Erl2Error` (`index.ts:224`), so it escapes as an uncaught crash with no typed record. Certification catches it, so hostile adapters still fail cert, but the run path does not. Remediation: `assertContract` the response before consuming it.

### P2‑7 — OQ‑007 fail‑closed guard is not wired into the selection kernel.

`assertDevelopmentTierOnly` (the guard the design and its own docstring call the executable form of OQ‑007) is never called by `runSelectionChain` or `verifySelectionChain`; a `requested_tier:"blind"` request against the development beacon runs to a signed `SelectionVerificationReceiptV2` and passes verification (selection‑lens repro). Bounded: the whole selection chain has no production caller (unorchestrated per the Slice 6.5 gap matrix; `select` → `POLICY_COMMAND_NOT_IMPLEMENTED`), and the shipping CLI refuses non‑development tier upstream (`requireDevelopmentTier` → `ADMISSION_SUBJECT_PORT_NOT_DEVELOPMENT`, which I saw in the transcript). Latent, but the guard must be inside the chain before Slice 6.5 wires selection.

### P2‑8 — Selection "independent verification" is recomputation with 100%‑shared helpers and no known‑answer vectors.

`runSelectionChain` (producer) and `verifySelectionChain` (verifier) import the *same* `poolRootOf`, `deriveSelectedIndex`, `hidingCommitment`, `sourceRequestBindingHash`, etc. A spec‑vs‑impl formula error (wrong HMAC domain/endianness/rejection limit) computes the same wrong value on both sides and passes. The only derivation test asserts determinism and range — no externally‑computed golden index/pool‑root/binding vectors exist. Compounded: `verifySelectionChain` is not on the production offline path — the public verifier trusts the selection subtree by hash‑closure from the attestation and never schema‑validates or signature‑checks individual selection artifacts. Moot for shipped pre‑environment runs (no selection), load‑bearing for the future environment terminal.

### P2‑9 — `removability.test.ts` does not prove core runs without adapters; the purity import scan misses several import forms.

The removability test symlinks core packages into a temp tree; Node resolves symlinks to realpath, so `@erl2/core` resolves back into `<repo>/packages/core` and, from there, `@erl2/adapter-reference-correct` resolves out of `<repo>/node_modules/@erl2` where all four adapters are linked (my repro with `createRequire`). A regression where core imports an adapter would still resolve — the test's central claim is false, and its digest‑equality second test is tautological. The purity import scan (`purity.test.ts:101`) matches only double‑quoted static `from "@erl2/…"`; it misses side‑effect, dynamic `import()`, `createRequire`, and single‑quoted imports (no lint config enforces quote style), and its AC‑001 "seeded sensitivity" check tests an in‑memory string rather than exercising the scanner. Product independence is genuinely true today (core has no adapter imports — verified), but the *evidence* for it would not catch a regression. This is the "green tests that don't exercise the real boundary" pattern.

### P2‑10 — The prescribed verification regenerates tracked golden fixtures nondeterministically, and CI verifies what it just generated.

`npm run evidence` (final step of the prescribed sequence) rewrote 434 files under `fixtures/golden/` and added/removed 18 (UUIDv7 run‑id dirs). Nothing outside `fixtures/golden/` changed. This conflicts with plan §19.3 (goldens generated only by a pinned generator; changes require semantic diff + security approval). The CI `pr.yml` runs `npm run evidence` and then verifies those just‑written fixtures with no drift check — a producer‑controlled loop. (The genuinely independent proof — fresh‑process `verify`/`verify-record` — is real; the fixtures themselves are not pinned.)

### P2‑11 — Journey oracle‑canary and translation‑totality enforcement are largely off the live path.

`assertTranslationTotality` (host‑authoritative and correct) has no caller outside tests; the canonical‑envelope/translation orchestration does not exist yet (Slice 6). Of the 8 declared oracle‑scan surfaces, only `adapter_request` is scanned by the unified scanner on a live path; `network_egress` is a declared surface that is never canary‑scanned (egress records the URL only as a hash); `lab_telemetry`/output‑tree scans are tests‑only or real‑adapter‑only; `knownCanaryIds()` returns `[]` (attribution unimplemented, though token detection stays fail‑closed). These become live only when the environment branch lands, but FR‑016's host enforcement is presently dormant.

### P3 findings (compact — confirmed, lower impact or fully contained)

- Duplicate‑key rejection is bypassable via JSON escapes. `parseStrictJson('{"a\\/b":1,"a/b":2}')` is accepted and silently collapses to `{"a/b":2}` (my repro); `detectDuplicateKeys` compares raw, un‑unescaped key text. On the verification path; design §16.1 requires rejection. Low exploitability (JCS/`coreHash` operate on the already‑collapsed object).

- `coreHash` universal exclusions are hardcoded, so top‑level `signature`/`root_signature`/`wrapper_signature` keys escape hashing (agent repro); mitigated only by every schema being `additionalProperties:false`. `VOLATILE_FIELDS` are per‑`schema_version` tables, contradicting the file's "must be declared per contract" comment.

- JCS itself does no NFC normalization or duplicate‑key rejection; both live in a separate validation layer, so any path that hashes data not routed through `validateContract`/`parseStrictJson` (e.g. `store.ts` marker parse) gets neither. The "RFC 8785" label is a restricted safe‑integer/finite subset (documented).

- Artifact freeze is not crash‑idempotent: a crash after `linkSync` but before the marker write leaves a markerless file that can neither complete nor re‑freeze (agent repro; `store.ts:107‑139`). Relevant to NFR‑003.

- `assertObservedMatchesLock` drift detection is asymmetric (images: locked⊆observed, so an extra image passes; config: observed⊆locked, so a missing config passes). Inert behind OQ‑005; README "any drift invalidates" overstates. The environment substrate lock's signature is likewise never verified (`assertSubstrateQualified` checks only `qualification_status`).

- `workspace.ts:732‑733` hardcodes `configuration_schema_hash`/`capability_declaration_hash` to a constant `"fake-subject/v1"` in every package manifest regardless of the real subject (dev‑tier/fake only).

- `RESERVED_GENERIC_METRIC_IDS` in the SDK has drifted — 15 ids vs 17 in core (missing `authority-scope` [hard‑safety] and `mutation-compensation`); `certifyPack` can pass a neutered generic metric (`passed:true`), caught only by the core bind gate `assertReferencedMetricsAreGeneric`. The guarding test is one‑directional. `hardSafetyViolations` is exported but has no run‑blocking consumer (dead in the pipeline; failures are still surfaced as frozen `threshold_satisfied:false` + findings).

- Dev‑only shortcut flags `--fake-acquire`/`--fake-verify-package` are exposed in the release CLI, contradicting `index.ts:9` ("no development‑only shortcut is reachable") and plan §8.5. Contained: refused with a real adapter and outside development tier; the fake port synthesizes control receipts (`lab_network_control_hash`, verification check bits) with no scripted marker. Note: a fake *succeeded* verification cannot finalize (ADR‑013 blocks it — my repro), so it cannot mint an attestation.

- Torn `state/snapshot.json` crashes every command with an uncatalogued exit (`writeSnapshot` has no fsync; `index()` strict‑parses it; `bin.ts` has no top‑level catch → raw `SyntaxError`, exit 1). `status` also trusts the non‑authoritative snapshot.

- `SelectionVerificationReceiptV2.checks` booleans are producer‑hardcoded `true`; `verify.ts`'s docstring says they are re‑derived and refused on mismatch, but the verifier never reads them (correct posture, wrong docstring).

- README `Status` contradicts the shipped evidence: it says the substrate is `not_qualified` ("no … substrate is pinned on this host"), but `environments/isolation/` exists and `erl2 doctor` reports `qualified` (ADR‑017). Docs drift.

- CLI closure failures all collapse to `GRAPH_CLOSURE_MISSING_ROLE` ("mandatory closure did not verify"), discarding the actual cause (missing role vs extra vs mismatch).

- Cancellation is unimplemented and not honestly refused — there is no `cancel` command; it returns `CFG_UNKNOWN_FLAG "unknown command cancel"`, and exit 12 is unreachable. Design §12 treats cancellation as a mandatory terminal path; only a fixture‑fabricated event stream covers it.

- Handwritten wire types (`ThresholdEnvelopeV1` in `integrity/threshold/envelope.ts`, beacon proof types) are validated by hand, not by a closed schema through `assertContract` — the drift risk the generator rule forbids (mitigated by AEAD/downstream recompute).

## A. Overall verdict

Conditional.

The integrity/contract/crypto foundation is strong and largely lives up to its claims: closed schemas with genuine `additionalProperties:false` and literal‑discriminant unions, a faithful RFC‑8785‑subset JCS, real Ed25519/age/threshold‑envelope implementations that fail closed on tamper, honest fail‑closed disabling of every open‑question feature, an honest gap matrix, and an offline verifier that genuinely rejects the common tampers. Product independence from Qualiber is real in the shipped code.

But two P1 defects sit on the only end‑to‑end path that ships (the pre‑environment terminal): the offline verifier does not enforce its own rejected‑extra closure rule, and the pre‑environment lifecycle is not replay/crash‑safe and can leave a healthy run with no terminal record while blaming the adapter. Both defeat P0‑level requirements (FR‑020/AC‑023 and FR‑001) and both are untested. Combined with the OQ‑008 qualification being producer‑assertable and a cluster of verifier‑completeness gaps (P2‑2/3/4), the slice cannot be called a clean pass. It is a solid kernel with specific, fixable integrity and lifecycle holes that must close before the environment vertical (Slice 6.5) builds on them.

## B. Slice gate matrix

| Slice | Entry | Exit gate (design/plan) | Impl evidence | Test evidence | Verdict | Unresolved limitations |
| --- | --- | --- | --- | --- | --- | --- |
| 1 Charter/ADRs/bootstrap | design approved | ledger covers P0/AC‑001..043; ADRs 001‑006,011 accepted; repo controls; purity baseline | ADRs 001‑017 present; ledger (55 reqs, 43 ACs); Node22/TS workspace | purity suite present | Pass w/ limitations | Workspace is not a git repo → CODEOWNERS/protected‑branches/secret‑scanning/CI‑has‑run are unverifiable (P3/F5) |
| 2 Integrity/lifecycle/selection kernel | S1 | fake valid+invalid verify offline; every selection mutation refused; cross‑platform goldens; purity | full selection chain, trust, timestamps, invalid record, offline verifiers implemented | 355 tests pass, 0 skipped; selection adversarial suite; my tamper battery mostly rejects | Conditional | P1‑1 (closure verdict), P1‑2 (lifecycle replay), P2‑3/4 (verifier signature/verdict gaps), P2‑8 (no golden vectors; verifier not re‑derived on prod path) |
| 3 Archetypes/clean env | kernel | fake+Compose satisfy one suite; baseline twice; zero residue; OTel qualified or Compose disabled | fake driver, clean control, allocator, frontier | env integration suite; baseline‑twice test is meaningful | Pass w/ limitations | Compose driver absent (not "disabled") — honestly disclosed; OQ‑005 fail‑closed genuine; drift check asymmetric (P3); concurrency test is sequential |
| 4 Journey/acquisition/capture | S3 | acquire→frozen output via CLI; blind chain verifies; closure derived; early terminals verify offline; oracle canary | journey engine (14 intents, one submachine), acquisition, capture primitives | oracle‑canary + request‑ancestry + journey‑capture suites | Conditional | P1‑2 lifecycle wedge on this path; P2‑11 canary/totality off live path; capture unorchestrated (Slice 6) |
| 5 Adapter SDK/host/sandbox | S4 | certified reference adapter runs through unchanged core; hostile→typed outcome; adapters removable; OQ‑001 fail‑closed | real out‑of‑process host, supervisor tree‑kill, sandbox report, brokers | 23+ hostile‑adapter adversarial tests; certification integration | Pass w/ limitations | P2‑6 (untyped crash on one hostile shape); P2‑9 removability test tautological; trust→profile gate not wired (test‑only) |
| 6 Generic evaluation/finalization | S5 | four planes separate; deterministic metrics; invalid routed out; public bundle verifies; pack mutation refused; OQ‑004 data‑only | closed finding union, BigInt metrics, Lab‑owned thresholds, join, index, pre‑env finalizer | discrimination via real adapters; boundary tests | Conditional | P1‑1 (rejected‑extra); P2‑2/3/4 verifier gaps; environment terminal unreachable (disclosed); RESERVED‑ids drift (P3) |

## C. Security and independence verdicts

- Product independence: Sound (real). No Qualiber import/string/branch/schema/dep in shipped code; lockfile clean; DAG holds; core builds/tests without any Qualiber checkout. Caveat: the *tests* proving it (removability, purity import scan) have real sensitivity gaps (P2‑9) — the property holds today but its guard would miss a regression.

- Contract integrity: Sound. Closed objects everywhere, exhaustive literal‑discriminant unions, patterns enforced at runtime by ajv, ADR‑013 invariant real at schema level. Gaps: no schema‑level `uniqueItems` on set arrays; escaped‑duplicate‑key bypass (P3); a few unbounded strings.

- Cryptographic / trust boundaries: Mostly sound. JCS/domain‑separation/Ed25519/age/threshold‑envelope are faithful and fail closed; trust head is externally pinned and self‑anchoring is refused. Gaps: `coreHash` hardcoded exclusions (mitigated by closed schemas), signer‑inventory signature unverified by the offline verifier (P2‑3), non‑JSON referenced bytes not re‑hashed (P2‑2).

- Lifecycle enforcement: Not sound on the shipped path (P1‑2). State machine matches §12 and ordering guards (reveal/evaluate/finalize) are genuinely enforced, but replay/out‑of‑order/crash wedges a healthy run with no terminal record; the run lease is dead code; there is no Lab‑side crash matrix.

- Selection neutrality: Structurally sound, weakly evidenced. Eligibility is source/candidate‑independent; padding/uniformity and acyclic checkpoints are enforced; beacon‑vs‑wrapper scope separation is real. But the OQ‑007 guard is unwired (P2‑7), verification shares 100% of producer helpers with no golden vectors (P2‑8), and the independent verifier is not on the production path.

- Adapter authority containment: Sound. Identity is Lab‑owned (adapters return drafts), capabilities are a closed enum with all privileged members denied, egress/mounts/oracle fields are refused, and an adapter cannot reach validity/selection/truth/thresholds. Gap: one hostile response shape crashes untyped (P2‑6). Process‑isolation is honestly distinguished from kernel isolation.

- Evaluation authority containment: Sound. Packs are provably data‑only, thresholds are Lab‑owned and byte‑bound, metrics are exact BigInt with explicit zero behavior, citations are set‑membership. Gap: SDK reserved‑id drift (P3).

- Cleanup / finalization safety: Conditional. The finalizer's pre‑sign gate genuinely checks cleanup/exposure/trust/closure; but the post‑hoc offline verifier under‑enforces (P1‑1, P2‑2/3/4), and a mid‑finalize failure is unrecoverable (P1‑2).

- Offline‑verifier independence: Sound in isolation, incomplete in coverage. Depends only on contracts+integrity, requires `--offline`, trust head from local config only, rejects byte/signature/missing/crossover on JSON+attestation — but misses rejected extras (verdict), non‑JSON bytes, and the inventory signature.

- Opaque‑subject isolation readiness: Not ready (correctly). Gate 1 (substrate probed) is claimed but the evidence is producer‑assertable (P2‑1); Gate 2 (launcher) genuinely absent; opaque/third‑party execution refused at independent gates.

## D. Claims audit (`docs/claims/permitted-claims.md`)

- Genuinely supported: separate result planes; deterministic BigInt metrics with identical `result_identity_hash`; discrimination across the four reference subjects through the real adapter protocol (verified — not fixture‑fabricated, though three predicate sub‑dimensions are harness‑synthesized); data‑only pack authority; offline verification of a valid *pre‑environment* bundle (with the P1‑1/P2‑2/3 caveats); the full selection chain is *implemented*; no held‑out/independence/robustness/subject‑quality/T4 claims; no OS‑isolation claim for opaque subjects; threshold‑VRF and privileged ops refused.

- Overstated:

  - "A run that cannot satisfy a valid terminal freezes exactly one `InvalidLabRunRecordV1` after bounded cleanup" — contradicted by P1‑2 (a replayed/crashed run can freeze none).

  - The pre‑environment public bundle "verifies offline" implies full closure enforcement — P1‑1 shows the verdict ignores rejected extras.

  - The OQ‑008 claim "the twenty controls were observed holding" rests on unauthenticated, producer‑writable evidence (P2‑1); it is a "self‑reported observed," not an independently verifiable, claim.

  - README `Status` says the substrate is `not_qualified` while `doctor` says `qualified` (internal contradiction).

  - The selection‑chain "independently re‑derived by the verifier" claim is true only in a unit test, not on the production verification path (P2‑8).

- Must remain prohibited (correctly prohibited today): held‑out/blind, architectural‑independence, robustness/brownfield, subject‑quality, container/OS isolation, privileged‑operation, customer external validity / T4, "bias‑free/collusion‑proof/universal," and any claim the beacon attested ERL data.

## E. Test‑quality assessment

- Baseline: the exact prescribed sequence `npm run clean && install && build && typecheck && verify:generated && test && purity && evidence` ran to exit 0. Tests: 355 pass / 0 fail / 0 skipped (contract 100, adversarial 126, integration 78, e2e 25, architecture 21, integrity‑age 5). `purity` is an alias of the architecture lane (21 tests), not a distinct check. `verify:generated` clean. `evidence` = 62 CLI invocations, 10 expected refusals.

- Mutation of tracked inputs: `npm run evidence` rewrote 434 golden files (nondeterministic run‑ids); nothing outside `fixtures/golden/` changed (P2‑10).

- Production‑path vs fixture coverage: the two `generic-finalization-*` goldens and the journey/adapter goldens are produced by the real CLI in fresh processes; the canonical `valid-pre-environment-run` and all `invalid-run-*` goldens are hand‑assembled by `fakeRun.ts` and bypass the shipped finalizer (they exercise the verifier over fake artifacts, not the finalizer). The environment terminal has no fixture, no CLI, no orchestrator.

- My mutation battery (offline verifier): correctly rejected — JSON byte‑flip (`ARTIFACT_HASH_MISMATCH`), missing required artifact (`GRAPH_CLOSURE_UNREACHABLE_ARTIFACT`), attestation signature tamper (`TRUST_SIGNATURE_INVALID`), record/bundle crossover both directions. Silently accepted — rogue extra JSON (P1‑1), referenced `.bin` byte‑flip (P2‑2), signer‑inventory signature tamper (P2‑3), invalid‑record extra via `verify-record` (P2‑4).

- Important untested mutations / gaps: no positive rejected‑extra test on a valid run (why P1‑1 shipped); no Lab‑side crash/replay matrix (why P1‑2 shipped); no known‑answer selection vectors (P2‑8); `cli-transcript.json` "expected refusals" are counted but never asserted (no test consumes it); the one adversarial closure test accepts either of two refusal codes, so it would pass with the closure rule removed; the ADR‑013 `verify_package`‑success refusal is proven, but the environment finalizer's pre‑sign closure derivation (`deriveEnvironmentPreFinalizationClosure`) is called by nothing.

- Confidence limitations: no test genuinely kills a Lab process mid‑write; cross‑platform (Linux amd64) goldens are wired in CI but unproven on this tree (macOS arm64 only); the discrimination suite synthesizes object‑value/citation‑digest/association fields rather than driving them from adapter output.

## F. Readiness statement

- Slices 1–6: Incomplete as a clean gate. All six are implemented with substantial, honest evidence, but Slice 2 and Slice 6 carry P1 defects on the shipped path, and Slice 1's repo‑control gate is unverifiable (no git).

- Pre‑environment valid terminal: Proven, with a caveat — proven for a *failed/unsupported* package verification (a valid Lab run + subject finding), produced by the real CLI and verified offline; the verifier under‑enforces closure (P1‑1) and the lifecycle can wedge before reaching it (P1‑2). A *successful* verification correctly cannot early‑terminate (ADR‑013) and cannot yet continue.

- Pre‑environment invalid terminal: Proven for the modeled failures (cancellation, classified lab failure, emergency cleanup, adapter timeout) via `verify-record`; but not proven for the replay/crash class, which produces *no* record (P1‑2), and `verify-record` ignores the invalid closure verdict (P2‑4).

- Environment components: Not proven end‑to‑end. Driver/allocator/clean‑control/frontier and the finalization/closure stack exist and refuse correctly, but no CLI/orchestrator reaches an environment terminal; no environment fixture exists. Honestly disclosed.

- Environment‑terminal E2E: Outside Slice 6 / incomplete — belongs to Slice 6.5; correctly refused (`POLICY_COMMAND_NOT_IMPLEMENTED`). No doc falsely claims it exists.

- Trusted reference‑subject execution: Ready. Four certified reference adapters run through the real out‑of‑process host under `local-process`.

- Opaque private‑subject execution: Not ready (correctly). No launcher; refused at independent gates. The gate‑1 qualification claim is weak (P2‑1) but does not enable execution.

- ERL2‑OQ‑005 (Compose): Fail‑closed (honest). Compose driver absent; fake driver only; `assertSubstrateQualified` refuses the unqualified lock.

- ERL2‑OQ‑008 (opaque isolation): Unresolved (honest as to outcome, weak as to gate‑1 evidence). Gate 1 "qualified" is producer‑assertable (P2‑1); gate 2 genuinely blocks; opaque execution refused.

- Slice 7 entry readiness: Not ready for opaque execution (OQ‑008/OQ‑001 fail‑closed). Ready to begin *adapter development* against the stable, real host — but the P1 lifecycle defect should be fixed first, since the Qualiber adapter journey rides the same acquire/verify/freeze path that wedges on replay.

## G. Review limitations

- I did not execute or inspect Qualiber or any checkout outside the Reality Lab workspace, per scope.

- I did not initialize git; repository‑control gates (CODEOWNERS, protected branches, secret scanning, "CI has run") are therefore unverifiable and reported as such.

- Cross‑platform determinism (Linux amd64) was not exercised — only macOS arm64 (Node 26.4.0 present; the project targets Node 22). The CI matrix is declared but cannot have run on this tree.

- Crash consistency was probed by state simulation and by real multi‑process replay/timing, not by killing a Lab process mid‑syscall; the marker/snapshot windows are argued from code plus reproduced wedges, not from an injected `SIGKILL` between `linkSync` and the marker write.

- age‑x25519 was verified spec‑shaped and self‑round‑tripping; no cross‑implementation (`age`/`rage`) byte‑interop vector was available.

- The prescribed `npm run evidence` mutated tracked golden fixtures (P2‑10); I ran it once as instructed and confirmed only `fixtures/golden/` changed. I did not restore them (the task forbids workspace writes, and they are regenerated build outputs, not hand‑authored source).

- Findings adopted from delegated reviewers were each reproduced first‑hand before inclusion; one delegated claim was checked and rejected (fake‑succeeded verification cannot finalize — ADR‑013 blocks it).
