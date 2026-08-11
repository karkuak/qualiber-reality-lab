# Independent security, evidence-boundary, and merge-readiness review

Review target: Reality Lab candidate `e9718e0332ff84becaed3d64bc39fc360e1a16f2`  
Review date: 2026-08-11  
Reviewer workspace: outside both canonical repositories

## Primary verdict

**CHANGES REQUIRED**

- Merge/publication readiness: **no**.
- Bounded unscored Qualiber dry-run readiness after merge: **no**.
- Scored/authenticated campaign readiness: **no**.

The candidate closes the original manifest-only final-gate path for a normally preregistered real adapter, but it does not make the real/fake adapter choice durable at preregistration. A run preregistered without a receipt can later dispatch a real adapter and can substitute a different valid receipt on a later command. It also writes the manifest's bootstrap/prior receipt field into adapter-failure evidence as though it were the current authorizing receipt, and represents “no adapter was applicable” as a passing `adapter-certified` boolean.

No Qualiber quality conclusion is drawn. The Qualiber source and r5 evaluator were not accessed or executed.

## Frozen coordinates and repository state

Reality Lab canonical checkout was clean on `codex/external-adapter-receipt-admission`:

- base/local `main`/`origin/main`: `787281318c845c34d209127177b8355c66b47f5b`, tree `386b40da3a2151e56bb272226b110c67c3586649`;
- candidate: `e9718e0332ff84becaed3d64bc39fc360e1a16f2`, tree `7250ffcdd08196cd0270a1c411a60fe310f6baec`;
- all four candidate commits form a clean linear ancestry from the base.

| commit | tree | parent | rename-aware stat |
|---|---|---|---|
| `344b7b42052c39977bb14961d0965808806d023a` | `25dd44464d22d9e2413634d7e40dabd124f12970` | `787281318c845c34d209127177b8355c66b47f5b` | 8 files, +863/-3 |
| `c5af10dcb3b52bd4cbafbbc6989d41f0ecf199e3` | `0af2e86b84a4276c44f0c368eccd58e0ffc5b88a` | `344b7b42052c39977bb14961d0965808806d023a` | 12 files, +1060/-1 |
| `6d211871d59af87de9d9522905368e79d30a540e` | `5c2a0dbb769ee72152f0f47743f4f05efe4ac731` | `c5af10dcb3b52bd4cbafbbc6989d41f0ecf199e3` | 157 files, +1554/-553 |
| `e9718e0332ff84becaed3d64bc39fc360e1a16f2` | `7250ffcdd08196cd0270a1c411a60fe310f6baec` | `6d211871d59af87de9d9522905368e79d30a540e` | 3 files, +11/-3 |

The base-to-candidate diff is 178 logical changed entries, +3488/-560: 147 rename-aware entries under `fixtures/golden/adapter-platform/**`, one `fixtures/golden/cli-transcript.json`, and 30 other entries. With rename detection disabled, the adapter-platform pathname count is 149 because two renames count as an old and a new pathname. Therefore “148 adapter-platform files” / “148 regenerated goldens” is not an exact Git count. The exact name-status inventory is in `reality-lab-e9718e0-changed-files.txt` beside this report.

The unrelated pre-existing worktree was inventoried only: `/Users/karthik/Developer/qualiber-reality-lab/.claude/worktrees/practical-mestorf-5e0215`, branch `claude/practical-mestorf-5e0215`, HEAD `25d3f57c833f50f84d4eaba783900593719d651e`. It was not inspected or altered.

Independent-QA remained clean and read-only on `codex/stage3-adapter-certification`, HEAD `a699383045d24c91876a8dd176ae8572612c7cb1`, parent `02fea7a4578473574ad1b80334c1e7083dfaca94`, tree `2156bce3df5b468eec2ee6aabba30b1c50f25e16`, with one worktree and no remote. Independent recomputation matched the frozen adapter, manifest-file, receipt-file, manifest-core, and receipt-core hashes stated in the review prompt. The receipt is unsigned, independently certified, owner=false, and contains 14 passed checks.

## Architecture and evidence-boundary trace

The normal intended path is sound in several important respects:

1. `packages/cli/src/adapterAdmission.ts:57-120` parses the manifest, receipt, entry, registry, and optional tier, hashes the entry, verifies certification, and retains both documents.
2. `packages/core/src/adapter/admission.ts:264-422` recomputes both core hashes, enforces receipt→manifest linkage, ID/version/byte/scope/verdict/check/owner rules, derives signature authenticity, then applies tier policy.
3. `packages/core/src/adapter/admission.ts:564-614` stages both registry files and publishes by rename; ordinary and fault-injected tests prove all-or-nothing behavior.
4. `packages/core/src/run/workspace.ts:456-474,595-612` revalidates the selected receipt during preregistration and records the exact current receipt as a produced lifecycle artifact role. Recovery reconstructs that core-hashed event chain.
5. `packages/cli/src/journeyCommands.ts:293-320` resolves and verifies the receipt before constructing the execution host.
6. Both final gate producers rederive from retained evidence: `packages/core/src/run/workspace.ts:2867-2873` and `packages/core/src/run/environmentRun.ts:3909-3915`.

The boundary breaks when preregistration is invoked without `--adapter-entry`. `packages/cli/src/journeyCommands.ts:703-720` then omits the receipt role. On later commands, `adapterCertificationReceiptHash()` at lines 455-485 accepts any supplied receipt whenever the retained receipt file is absent. Nothing durable says the run selected the fake port, and nothing prohibits a later real `--adapter-entry`. The late command can therefore validate receipt A, execute, and a later command can validate receipt B for the same manifest. Neither receipt becomes part of the preregistration event.

### `AdapterHost` constructions

Production constructions found:

- `packages/cli/src/journeyCommands.ts:315`: the normal live journey path; receipt verification is immediately before it, but the late-binding defect described above lets the receipt remain outside the frozen preregistration boundary.
- `packages/core/src/adapter/certification.ts:172`: the certification harness. This host necessarily precedes the receipt it is producing and is not an admitted live-run bypass.

Other constructions are test/support uses in `tests/support/adapterFixtures.ts`, `tests/adversarial/evidenceStagingPaths.test.ts`, `tests/adversarial/containerDeadlineEnforcement.test.ts`, and `tests/adversarial/containerSandboxProfile.test.ts`.

### `adapter-certified` producers

- `packages/core/src/run/workspace.ts:2867-2873`;
- `packages/core/src/run/environmentRun.ts:3909-3915`.

Both use `deriveAdapterCertifiedGate`. No remaining literal production `passed: true` producer was found. However, the shared derivation at `packages/core/src/adapter/admission.ts:525-528` returns `passed: !dispatchedRealAdapter` with manifest-only evidence when no receipt is bound.

## Certification, authentication, and tier policy

The implementation keeps content validity, signer authentication, and tier policy separate. The selected tier reaches `assertAdmissionPermittedForTier`; changing a later run command cannot turn a retained unsigned receipt into authenticated evidence because authenticity is rederived from the receipt and pinned authorities, not from the tier label.

| evidence | development | held-out / blind |
|---|---|---|
| valid unsigned | admitted as `locally_observed_unauthenticated` | typed `ADAPTER_CERTIFICATION_AUTHENTICATION_REQUIRED` refusal |
| zero-filled placeholder signature | `not_certified`, refused | refused |
| signature from unpinned key | `not_certified`, refused | refused |
| valid pinned authorized test signature | `authenticated` | `authenticated` |
| refused verdict / failed check | refused | refused |

No `--allow-unsigned` path exists. Certifier string inequality is only an independence check and is not authentication. No signer is mapped to `adapter_owner`; there is no `adapter_certifier` signer role. The public checkout pins no real adapter-certifier authority, so `authenticated` is unreachable for the frozen real fixture. Synthetic pinned-key controls do not change scored readiness.

Actual admission syntax is `erl2 admit-adapter --registry ... --adapter-manifest ... --certification-receipt ... --adapter-entry ... [--tier development|held_out|blind]`; omission of `--tier` defaults to `development`. Explicit development gives the same unauthenticated result. Admission and preregistration enforce the selected tier in `verifyAdapterCertification`; live journey commands independently remain development-only under the existing OQ-007 restriction.

## Receipt linkage

Both manifest and receipt core hashes are recomputed. Receipt→manifest is the authoritative acyclic current-certification link and matches the certifier producer. The manifest's all-zero `certification_receipt_hash` is classified only as `bootstrap_no_prior_receipt`; a nonzero value is classified `prior_receipt_not_resolved`. Neither suppresses current receipt validation on the normal path.

The new prior/bootstrap interpretation is not carried consistently into existing evidence semantics. `AdapterFailureV1` requires a field named `certification_receipt_hash` (`packages/contracts/schemas/results.schema.json:190-250`), but `freezeAdapterFailureFinding` populates it from `adapter.certification_receipt_hash` (`packages/core/src/run/workspace.ts:2171-2184`) instead of the retained current receipt. The hostile golden therefore records the all-zero bootstrap sentinel while its actual retained current receipt is nonzero. That is an ambiguous/false current-authority reference, not merely a naming concern.

## Entrypoint substitution and TOCTOU

Independent neutral-fixture reproductions established:

- replacement after admission is refused with `ADAPTER_IDENTITY_MISMATCH`;
- replacement between two operations is refused before the second operation;
- symlink retargeting is refused.

This is deterministic post-admission substitution protection. It is not atomic execution of frozen bytes. `packages/core/src/adapter/host.ts:426-430` hashes the path, other work occurs, and the mutable path is passed to the launcher/spawn at lines 1129-1145. Invocation evidence uses `this.executableDigest` at line 1001, which is another read-derived value rather than an open immutable file handle used for execution. A same-user filesystem swap remains possible between check and execution.

The repository's local-process threat model explicitly treats the subject as a same-user child and accepts it only for trusted reference fixtures where the threat is a bug, not an adversary (`ADR-ERL2-016:10-20`; `isolationQualification.ts:163-165`). Thus this residual race is outside that narrowly stated adversarial model, but ADR-ERL2-036:151-152 overstates the implementation as “cannot execute different bytes.” The accurate guarantee is deterministic next-dispatch detection, not atomic frozen-byte execution or protection from a malicious same-user race.

## Independent adversarial reproductions

| case | independent result |
|---|---|
| no receipt on real preregistration | exit 6, `ADAPTER_CERTIFICATION_RECEIPT_REQUIRED` |
| unknown receipt hash | exit 3, `ADMISSION_ARTIFACT_UNKNOWN` |
| receipt core-hash tamper | refused |
| refused verdict / refusal codes / failed check | refused |
| manifest link, adapter ID, or version mismatch | refused |
| entry digest, certified operations, or package-kind mismatch | refused |
| self-certification / owner violation | refused |
| unsigned development | admitted, explicitly `locally_observed_unauthenticated` |
| unsigned held-out and blind | typed authentication-required refusals |
| zero-filled or unpinned signature | never authenticated; refused |
| pinned authorized test signature | authenticated in all tiers |
| failed atomic retention | zero partial published artifacts |
| manifest-only registry / no receipt selection | cannot preregister a selected real adapter |
| deterministic entry replacement / between-operation replacement / symlink retarget | refused before the affected dispatch |
| passing real-adapter validity evidence | includes exact receipt and manifest hashes on the normally bound path |
| real adapter with no retained receipt at final gate | shared derivation returns false; the old final false-positive is closed |
| no-adapter/fake path | returns `adapter-certified: passed=true` with manifest-only evidence; unsafe applicability semantics |
| fake preregistration followed by real commands | **unexpected success**; receipt A authorized acquire, receipt B authorized verify-package, no receipt was retained |

The late-binding reproduction used two different, individually valid receipts for the same certified manifest. Preregistration produced no adapter-certification role. `acquire` with receipt A executed a sandbox operation successfully. A later `verify-package` with receipt B also succeeded. The run's `retained/adapter-certification-receipt.json` remained absent throughout.

The frozen Independent-QA artifacts were used only with `admit-adapter`: default and explicit development succeeded as unauthenticated; held-out and blind were refused. No lifecycle or product execution was attempted.

## Load-bearing mutations

All mutations were temporary and confined to the disposable exact-head clone.

| mutation | result |
|---|---|
| force the final unbound real-adapter gate to pass | caught by `GATE: adapter-certified is derived, and a manifest alone never satisfies it` |
| replace passing receipt+manifest evidence with manifest-only evidence | caught by the same gate test |
| admit unsigned held-out/blind evidence | caught by `ADMISSION: an unsigned receipt is refused for every scored tier` |
| publish one destination artifact before retention throws | caught by the idempotent-publish and failed-retention tests |
| remove the pre-host `verifyAdapterCertification` call | **survived** build plus all 31 affected external-admission/journey tests |
| remove per-dispatch `assertEntryDigestUnchanged` | **survived** build plus all 71 affected admission/host/journey tests |

The two survivors are material missing controls. Existing tests validate helper behavior and source shape but do not prove that the public host construction is gated or that the per-dispatch comparison remains load-bearing.

## Docker-gated Compose coverage

The diff touched `tests/e2e/composeEnvironmentRun.test.ts` and `tests/e2e/externalSubjectComposeRun.test.ts`. With the already-present pinned upstream archive copied into the disposable clone and the repository's live-test preconditions enabled:

- compose environment file: 3/3 passed, including the offline-valid terminal and bound-driver substitution cases, about 63.7 s;
- external-subject file: 3/3 passed with a neutral external adapter ID, including offline-valid terminal and cancellation-zero-residue cases, about 69.5 s.

The first external-subject attempt used a built-in adapter ID and correctly stopped at a fixture-ID collision before Docker; it was not counted as candidate behavior. The neutral retry exercised the intended generic path.

Before the run, Docker contained exactly two unrelated exited containers (`cranky_nobel`, `zealous_joliot`), the standard `bridge`/`host`/`none` networks, and zero volumes. After the dedicated runs, the inventory was identical. No task-created container, network, or volume remained.

## Golden and preserved-evidence audit

- `evidence:verify` passed: 838 pinned files, exactly seven exclusions.
- The 832→838 change is exactly six new receipt files: one JSON and one `.frozen` file for each of three adapter-platform run shapes.
- All three distinct shapes were sampled: hostile timeout/adapter-owned invalid result, reference-correct verified package, and reference-limited unsupported behavior.
- The hostile golden retains `ADAPTER_DEADLINE_EXCEEDED`, adapter ownership, and a grandchild PID artifact. It does **not** retain an independent post-kill liveness/termination receipt; the excluded PID proves emission, not termination. Process-tree termination remains directly tested in `adapterHost.test.ts`, but the golden alone does not prove that claim.
- The six receipt files are byte-pinned. Exclusions remain the two reference frame pairs, hostile request frames, hostile grandchild PID, and CLI transcript; no excluded file is the sole proof for receipt admission. The excluded PID is insufficient as sole proof of termination, so that claim must be narrowed.
- `cli-transcript.json` changed from 155 to 156 registered contracts because the base transcript was stale relative to pre-existing ERL2-C-160. Container-launcher/lock fields originate in pre-existing ADR-ERL2-034. Temporary paths, verification timestamps, and dependent core hashes are nondeterministic refresh effects. Contract registry source and schemas did not change in this candidate. The unrelated transcript refresh should be separated from the LIVE-001 package or explicitly accepted as a documented baseline refresh; it adds review noise without implementing receipt admission.
- Preserved LIVE-001 `SHA256SUMS` independently hashed to `1d8f7da3c02403510d9d7f0eb5a7fb243d7a2f8613eb710b6257c3b080c840c4`. `report.md` independently hashed to its recorded `22134d7d3902367cf5d3a31ccbb3f44f77bbd4504f19e50be98d2ba35a386118`. The report stops before preregistration and does not overstate execution.
- The provenance README accurately distinguishes the copied report/inventory from omitted runtime artifacts and preserves their hashes, but says “four logs” while listing six omitted artifacts (five `.log` files plus one Markdown intervention log).
- ADR-ERL2-036:165-172 says the hostile golden became an identity mismatch and no longer covers deadline termination; the actual generator, ledger, and golden deliberately certify the sabotage bytes and retain the timeout. This is stale contradictory prose.

## Tests, clean gates, and campaign status

- build: passed;
- 25 new external-admission controls: 25/25 passed;
- affected core/adapter/wall-clock/evidence-retention/CLI/contract/purity/removability selection: 173/173 passed;
- changed Docker files: both executed under their live preconditions and passed as described above;
- real frozen fixture: admission-only matrix passed;
- `verify:generated`: passed;
- `evidence:verify`: passed, 838 pinned / 7 excluded;
- `git diff --check`: passed;
- normal full compiled test gate: **inconclusive**. The first spec-reporter invocation produced only green output before its session closed without a recoverable final summary. A duplicate compact-reporter invocation progressed through large passing batches, then produced no output for more than 22 minutes in its final long case—beyond the repository's documented ~21-minute worst-case stage—and was manually interrupted. No failure marker appeared, but this is not recorded as a pass.

The phrase “25 negative controls executed” refers to the 25 new adversarial admission tests, not the multi-hour `npm run negative-control` campaign. The full campaign was not run. Carry-forward is not valid because this candidate changes enforcement, host dispatch checks, validity derivation, fixtures, and evidence generation. Per the requested conditional method, the current campaign was not started after static review and mutation testing found material issues requiring code changes. The candidate ledger itself records that the adapter-path campaign red control remains absent (`docs/ledger/remediation-live-001-adapter-admission.md:102-104`).

## Findings

### P1 — real adapter and receipt can be introduced and substituted after fake preregistration

- Location: `packages/cli/src/journeyCommands.ts:455-485,703-720`; boundary: preregistration → recovery/replay → pre-host validation.
- Reproduction: preregister without `--adapter-entry`, then acquire with real entry+receipt A, then verify-package with receipt B. Both commands succeeded; neither receipt was retained or present in the preregistration event.
- Expected: adapter mode and exact receipt become immutable at preregistration; later commands cannot introduce a real host or substitute a receipt.
- Actual/shape: CLI memory validates each supplied receipt, but the lifecycle has no authorizing receipt. Restart/replay can select another valid receipt for the same manifest, and real bytes execute outside the frozen binding.
- Existing tests: no; the 25-test file does not exercise this transition.
- Smallest remediation: make real-vs-fake mode a core-hashed preregistration/lifecycle fact; if preregistration omitted the receipt, reject every later `--adapter-entry` and receipt; if present, resolve only the retained role and never a later flag. Add restart/replay and receipt-substitution end-to-end controls.
- Blocks merge: yes. Blocks unscored retry: yes. Blocks scored operation: yes.

### P2 — adapter-failure evidence names the bootstrap/prior hash, not the authorizing current receipt

- Location: `packages/core/src/run/workspace.ts:2171-2184`; contract field at `packages/contracts/schemas/results.schema.json:190-250`; boundary: dispatch failure → retained finding/golden.
- Reproduction: hostile golden retains a nonzero current receipt but its adapter-failure finding records the all-zero manifest sentinel.
- Expected: the finding's `certification_receipt_hash` names the exact receipt that authorized the failed adapter execution.
- Actual/shape: it names a bootstrap/prior value, permitting false or ambiguous attestation about which certification authorized execution.
- Existing tests: no; current golden verification pins the wrong value.
- Smallest remediation: populate the finding from the retained `adapter-certification-receipt` role, fail closed if a real adapter failure lacks it, and add an exact-equality control; clarify prior/current contract semantics.
- Blocks merge: yes. Blocks unscored retry: yes. Blocks scored operation: yes.

### P2 — `adapter-certified: passed=true` cannot represent “not applicable” safely

- Location: `packages/core/src/adapter/admission.ts:525-528`; both gate producers listed above; boundary: fake/internal subject → public validity claims.
- Reproduction: the existing fake-port test explicitly returns `passed:true` and manifest-only evidence with no receipt.
- Expected: downstream evidence distinguishes “no external adapter applicable” from “adapter certified.”
- Actual/shape: the boolean gate ID and pass value form a certification claim; absence of a receipt reference is an implicit convention, not an applicability state.
- Existing tests: they require the unsafe representation instead of detecting it.
- Smallest remediation: use the smallest schema-compatible explicit applicability representation available (or omit/replace this gate for no-adapter paths) so `passed=true` is reserved for a validated receipt.
- Blocks merge: yes. Blocks unscored retry: indirectly, because publication is not safe. Blocks scored operation: yes.

### P2 — public pre-host and per-dispatch enforcement lack load-bearing controls

- Locations: `packages/cli/src/journeyCommands.ts:297-320`; `packages/core/src/adapter/host.ts:421-430`; boundary: certification → host construction and admitted bytes → dispatch.
- Reproduction: deleting each enforcement call independently still passed 31 and 71 affected tests respectively.
- Expected: a targeted test fails if either security check disappears.
- Actual/shape: future regression can restore LIVE-001's pre-host bypass or executable substitution without breaking affected suites.
- Existing tests: no; helper-level and architectural tests are insufficient.
- Smallest remediation: add a public-path test proving an invalid receipt cannot construct/touch the host, plus a two-dispatch same-path and symlink-retarget control that fails when the comparison is removed. Add the missing adapter-path campaign red control.
- Blocks merge: yes. Blocks unscored retry: yes. Blocks scored operation: yes.

### P3 — security and evidence prose exceeds or contradicts retained proof

- Location: `docs/adr/ADR-ERL2-036.md:146-172`.
- Reproduction: source shows a check/spawn gap; hostile golden has no independent kill receipt; ADR says the hostile run became identity mismatch although the actual golden remains a certified timeout.
- Expected: claims match the implemented threat model and retained artifacts.
- Actual/shape: readers can over-credit atomic byte execution and golden process-tree proof.
- Existing tests: no documentation consistency check.
- Smallest remediation: narrow the guarantee to deterministic substitution detection, correct the hostile-golden description, and either retain independent kill evidence or stop claiming the golden alone proves termination.
- Blocks merge: no by itself, but blocks publishing the stated security claim unchanged. Blocks unscored retry: no by itself. Blocks scored operation: no by itself.

## Final state and remaining limitations

Both canonical repositories remained clean and unchanged. No branch, commit, stash, rebase, push, PR, merge, evidence regeneration, Qualiber checkout access, r5 execution, or live Qualiber run occurred. The review used a detached exact-head disposable clone and admission-only copies of the frozen real artifacts.

Remaining limitations are unchanged: B-129 (r5 rejects four evaluator-contract fields) and B-130 (CLI is host-provisioned/digest-verified rather than Lab-acquired/frozen); no real signer authority is pinned; no `adapter_certifier` signer role exists; onboarding still depends on out-of-band governor registry/policy preparation; authenticated/scored execution is unexercised; and the required adapter receipt-bypass campaign control is missing.

## Exactly one next recommendation

Create one bounded corrective package that durably freezes adapter mode and the exact current receipt at preregistration, fixes current-receipt failure evidence and no-adapter applicability semantics, adds the two surviving mutation controls plus the missing campaign red control, and corrects the overbroad/stale evidence claims; then rerun the affected gates, Docker tests, evidence verification, and one full campaign at the corrected exact head before requesting another merge-readiness review.
