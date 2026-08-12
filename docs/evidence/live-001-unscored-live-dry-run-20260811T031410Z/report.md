# First bounded unscored live Reality Lab dry run

## 1. Primary verdict

`BLOCKED — ADMISSION`

Required supported-interface status: `BLOCKED — NO SUPPORTED LIVE ADAPTER ADMISSION PATH`.

The run stopped before Lab preregistration. This is not a Qualiber quality verdict, score, certification, campaign result, or claim that the r5 evaluator failed. The frozen adapter and r5 coordinates matched; the independent receipt verified. The settled Lab did not expose a public input or command that consumes and validates the external adapter certification receipt. The intuitive receipt flag was rejected as `CFG_UNKNOWN_FLAG`, while minimum source inspection showed the live path resolves only `SubjectAdapterManifestV1` and later hard-codes the `adapter-certified` validity gate to `passed: true` with the manifest hash as evidence.

## 2. Preflight coordinates and hashes

### Independent QA repository

- Path: `/Users/karthik/Developer/qualiber-independent-qa`
- Branch: `codex/stage3-adapter-certification`
- HEAD: `a699383045d24c91876a8dd176ae8572612c7cb1`
- HEAD parent: `02fea7a4578473574ad1b80334c1e7083dfaca94`
- Remote: none
- Worktrees: one
- Worktree: clean
- Adapter entrypoint SHA-256: `b977ac2ad4698de7145ddc1d01b4aa27f2bc4c7a8d5b13d57ce997289b976893`
- Manifest file SHA-256: `7893d048f888ec24fdb9c311a7cd864e0b8782b0b56c414b72077d2b326dfb27`
- Manifest core hash: `sha256:45d6428e1da4879e38dd0f56c6f28d74e4e0d7e516c022653f019779583e9b07`
- Receipt file SHA-256: `6f3087e7ed9a9fea916baeedbc55baf2b26749286daee5c799cc49a6c0d7f4ed`
- Receipt core hash: `sha256:24d75c1c347f2c3444dc7bfe7f4f337c03f7b4eb72054717e3e47deb31e6239b`
- Receipt verifier: exit 0, `PASS adapter-certification-receipt (14 checks; core hash, manifest, entrypoint, controls and scope verified)`
- Receipt verdict: `certified`; identity `independent-analytics-validator` `0.1.0`; protocol-negotiation certification check `passed` and reports repeated identifiers.

The manifest contains `certification_receipt_hash: sha256:0000…0000`, an all-zero development sentinel, and an all-zero signature placeholder. The receipt has `signature: null`. Those are observed facts and were not interpreted as authenticated admission.

### Reality Lab

- Canonical path: `/Users/karthik/Developer/qualiber-reality-lab`
- Branch: `main`
- HEAD/local main/origin main: `787281318c845c34d209127177b8355c66b47f5b`
- Tree: `386b40da3a2151e56bb272226b110c67c3586649`
- Canonical worktree: clean
- Disposable clone HEAD/tree: exact match
- The canonical repository was not built, installed into, switched, or modified.

The canonical Lab has one additional pre-existing worktree on another branch. It was inventoried only and not inspected or altered; the requested settled canonical checkout itself matched.

### Frozen r5 artifacts

- CLI tgz: `e95220cb516ac977a32b60bfc554cbf793f8c8a61b9330a4c2e5f9f963803887`
- Collector tgz: `79b4e930d4e523749e843bb212adb839578212747cddcde26fc353d5c9f30820`
- Schema: `b8c264d1e8077f6331b2671dde5eccbc106656d0bd1f69cdfdc5a282de0d244b`
- Example: `e8c5368c8fc5c503dca92db2e72c765a382ec3a93fe8b473c5fdda1918e8f55f`
- Producer-declared commit/tree: `bc0c2d1f6029294e8fea8dff8af30407fb331127` / `38611a2f39db799d3ba10ba2746f25a9a1eae22e`

No Qualiber source checkout was read or executed. Only the supplied packed artifacts and their public manifest were accessed.

## 3. Run identity and evidence root

- Run ID: `20260811T031410Z`
- Evidence root: `/private/tmp/qualiber-unscored-live-dry-run-20260811T031410Z`
- Started: `2026-08-11T03:14:10Z`
- Finished: `2026-08-11T03:22:54Z`
- Total elapsed: 8 minutes 44 seconds
- Confirmed admission blocker by approximately `2026-08-11T03:17:50Z`
- Time to first meaningful product result: not reached
- Time to deterministic blocking result: approximately 3 minutes 40 seconds

## 4. Onboarding path attempted first

Starting instruction: the settled Lab root `README.md`, section `Quick start`. Public follow-on documentation: `runbooks/adapter.md`, `runbooks/journey.md`, and `runbooks/evaluation.md`. Implementation source was not inspected until this documented route stopped.

The public path required Node/npm, Git, a built Lab CLI, a governor-prepared content-addressed registry, a run root, tier, adapter entry path, ten artifact hashes, and an expiry. It documented neither a command to prepare/admit that registry nor any input for the external certification receipt. Subcommand `--help` was also rejected.

Command counts and recovery steps are complete in `evidence/command-intervention-log.md`: 5 Lab CLI invocations, 2 documented setup commands, and 12 grouped setup/preflight/inspection interventions. There were 4 sandbox escalation requests and no credentials or global installation.

Prerequisites stated: `npm install`, build, Node >=20 for r5, governor-prepared registry, development tier. Prerequisites discovered through friction: source inspection to learn receipt admission is absent; sandbox approval for Docker/process visibility and loopback binding. Ambiguous terms included “governor-prepared directory,” “certified” on `--adapter-entry`, and the relationship between a manifest’s receipt hash and the receipt itself.

Assessment: the current flow is not reducible to a safe one- or two-command external-adapter run until receipt-aware admission and a supported registry-preparation surface exist. The desired interface is one admission command accepting manifest, receipt, and entrypoint, followed by one run command accepting the r5 artifact drop and output root.

## 5. Exact supported Lab invocation

No exact supported invocation exists that both selects the external adapter and consumes/adjudicates its certification receipt.

The documented journey template accepts `--adapter-entry` and `--adapter HASH`, but assumes a governor-prepared registry. The CLI’s global help lists no admission/registry command. `preregister-acquisition --help` and `acquire --help` reject `--help`. The concrete admission probe was:

```text
npm run erl2 -- preregister-acquisition --certification-receipt /Users/karthik/Developer/qualiber-independent-qa/certification/receipt.json
```

It exited 2 with:

```json
{"code":"CFG_UNKNOWN_FLAG","message":"unknown flag --certification-receipt"}
```

Manual copying of JSON into a registry was not used because it is undocumented, requires internal governor knowledge, and the live code path does not validate the receipt.

## 6. Certification/admission result

- Independent certification verification: passed, 14 checks, receipt verdict `certified`.
- Live Lab certification admission: not available; the receipt input was rejected before run creation.
- Typed unsigned/development-manifest decision: not produced by the Lab because the receipt never reaches an admission validator.
- Run preregistration: not attempted after the deterministic interface failure.

## 7. Lifecycle operations

| Adapter operation | Invoked | Exit | Duration | Declared mutation/result |
|---|---:|---:|---:|---|
| acquire | no | n/a | n/a | blocked before preregistration |
| validate-package | no | n/a | n/a | blocked before preregistration |
| install | no | n/a | n/a | blocked before preregistration |
| configure | no | n/a | n/a | blocked before preregistration |
| start | no | n/a | n/a | blocked before preregistration |
| interact | no | n/a | n/a | blocked before preregistration |
| translate-evidence | no | n/a | n/a | blocked before preregistration |
| project | no | n/a | n/a | blocked before preregistration |
| report-residue | no | n/a | n/a | blocked before preregistration |
| compensate | no | n/a | n/a | not applicable; no adapter dispatch/mutation |
| uninstall | no | n/a | n/a | not applicable; nothing installed by adapter |

No retry occurred. The admission failure was deterministic and therefore not retried.

## 8. Real Qualiber artifact interaction

None occurred. The r5 collector tarball was hash-validated but not acquired or run through the Lab. The host-provisioned r5 CLI tarball was hash-validated but not installed for adapter execution. No browser, evaluator, collector, contract translation, projection, product evidence, or Qualiber result was produced. This absence is required by the supported-interface stop rule and must not be represented as a product failure.

## 9. Findings

### LIVE-001 — P1

- Category: `REALITY_LAB_DEFECT`
- Dimensions: functionality, accuracy, security, onboarding
- Roles: QA engineer, QA manager, QA director, product manager, developer, DevOps engineer, release manager, development manager
- Reproduction: build settled main; run global help; attempt `preregister-acquisition --certification-receipt <receipt>`; observe `CFG_UNKNOWN_FLAG`; inspect the minimal registry/preregistration/validity path.
- Expected: a supported public path consumes the manifest, receipt, entrypoint digest, receipt verdict, manifest-receipt linkage, and authentication status, then returns an explicit typed admission or refusal.
- Actual: no receipt input or admission command exists. The registry indexes arbitrary core-hashed JSON and preregistration requires only `SubjectAdapterManifestV1`. The validity gate later emits `adapter-certified: passed: true` with only the adapter-manifest hash as evidence. The development manifest’s all-zero receipt sentinel is therefore not adjudicated by the observed live path.
- Evidence: `public-interface.log`, `admission-source-inspection.log`, `preflight-coordinates.log` (hashes in `SHA256SUMS`).
- Reproducible: yes, deterministic on settled main.
- Recommended owner: Reality Lab core/admission maintainers.
- Blocks another unscored run: yes.
- Blocks a scored campaign: yes.

### LIVE-002 — P2

- Category: `ONBOARDING_OR_DOCUMENTATION_DEFECT`
- Dimensions: usability, onboarding, reliability
- Roles: QA engineer, QA manager, developer, DevOps engineer, release manager
- Reproduction: begin at root README; follow the external-adapter runbook; request subcommand help.
- Expected: a novice can discover a complete external-adapter setup and invocation, including registry construction/admission, required configuration, and cleanup, through one or two documented commands or actionable help.
- Actual: examples contain opaque `HASH` placeholders and an unexplained governor-prepared registry; no registry/admission command is documented; subcommand help is rejected as an unknown flag.
- Evidence: `public-interface.log`, `command-intervention-log.md`.
- Reproducible: yes.
- Recommended owner: Reality Lab CLI and operator-documentation maintainers.
- Blocks another unscored run: yes for the specified new-evaluator onboarding protocol; an insider could manually compensate, but that would violate this run’s supported-interface rule.
- Blocks a scored campaign: yes until admission is explicit and reviewable.

### LIVE-003 — P3

- Category: `ENVIRONMENTAL_FAILURE`
- Dimensions: usability, security, reliability
- Roles: QA engineer, DevOps engineer
- Reproduction: attempt Docker API inventory, global process inventory, or bind `127.0.0.1:0` inside the default execution sandbox.
- Expected: read-only inventory and loopback allocation succeed.
- Actual: Docker and `ps` were initially permission-denied and loopback bind returned `EPERM`; approved escalated execution succeeded. No product command failed for this reason.
- Evidence: `environment-inventory.log`; operator transcript records the initial errors.
- Reproducible: yes in this execution layer; transient only through approval.
- Recommended owner: execution-environment policy/operator.
- Blocks another unscored run: no if scoped approval remains available.
- Blocks a scored campaign: no by itself.

### LIVE-004 — P3

- Category: `INCONCLUSIVE`
- Dimensions: security
- Roles: developer, DevOps engineer, release manager, development manager
- Reproduction: run documented `npm install` in a clean disposable Lab clone.
- Expected: setup reports no known dependency advisory signal, or supplies a documented risk disposition.
- Actual: npm reported 2 vulnerabilities (1 moderate, 1 high). No `npm audit` investigation was performed because this bounded observation task did not authorize remediation or a broader dependency review; reachability and impact are unverified.
- Evidence: `command-intervention-log.md`.
- Reproducible: observed once; not independently confirmed.
- Recommended owner: Reality Lab dependency maintainers.
- Blocks another unscored run: no.
- Blocks a scored campaign: undetermined; triage is required.

## 10. Timing observations

| Activity | Single-run observation |
|---|---:|
| Disposable local clone | ~0.4 s |
| Lab dependency install | 0.704 s reported by npm |
| Lab build | ~7.8 s |
| Receipt verification | <1 s |
| Each CLI help/admission probe | ~0.4 s |
| Time to confirmed admission blocker | ~3 min 40 s from task start |
| Artifact validation | <1 s for all four r5 files |
| Installation/startup/interaction/translation/cleanup lifecycle timings | not observed; blocked before dispatch |

These are observations, not benchmarks.

## 11. Security and isolation observations

- No sudo, global package installation, credentials, external service reuse, or Qualiber source access occurred.
- Docker baseline: two unrelated exited containers, three default networks, zero volumes. None was altered.
- No task-created Docker container, network, or volume was observed.
- Dynamic loopback allocation succeeded at `127.0.0.1:50308` and was immediately closed.
- No adapter process was launched; therefore no adapter environment variables, mounts, Docker socket, capabilities, or egress were actually passed.
- Lab `doctor` reported `local-process` with 12 enforced and 13 unsupported adapter controls; container qualification was `locally_observed_unauthenticated`, launcher `not_probed`, and adapter container profile disabled until host derivation.
- Minimum source inspection shows the local-process child environment would contain only `ERL2_ADAPTER_PROTOCOL_VERSION`, `ERL2_RUN_ID`, and `ERL2_OPERATION_ID`; this is implementation-derived, not run-observed.
- The admission gap is a bypass opportunity: a manifest may be treated as certified without evidence that the referenced receipt exists or passed.
- No secret values or unrelated environment dump was retained.

## 12. Cleanup and residue

Because no run was preregistered and no adapter operation began, supported `compensate`/`uninstall` were not applicable and were not invoked. The only task runtime was the disposable Lab clone and its local dependencies/build outputs; it was removed after evidence capture. Docker/process inventories found no task-created runtime resource. Final proof is in `cleanup-final-state.log`.

Global inventory was unavailable without execution-layer escalation; the retained scoped/global checks after approval are the basis for the stated cleanup. No claim is made beyond the observed Docker objects, scoped processes, task path, and repository states.

## 13. Final repository and artifact state

Final verification reconfirmed:

- independent QA branch/HEAD/parent, clean worktree, no remote, one worktree;
- Lab canonical main/HEAD/origin main, clean canonical worktree;
- adapter, manifest, receipt, CLI tgz, collector tgz, schema, and example hashes unchanged;
- no disposable runtime directory remained;
- the evidence root remained.

No branch, commit, stash, reset, rebase, push, merge, install, or source edit occurred in either canonical repository.

## 14. Limitations and unresolved blockers

- B-129 remains unresolved: the canonical evaluator contract is rejected by r5 for four unknown fields. It was not modified or exercised because admission blocked earlier.
- B-130 remains unresolved: the CLI is host-provisioned and digest-verified by the adapter, not acquired/frozen by the Lab. No contrary claim is made.
- The adapter-path red control remains missing.
- Certification remains unsigned; the manifest remains a development placeholder with a zero receipt sentinel.
- Certification used `local-process`; 13 kernel/container controls remain unsupported there.
- No lifecycle, real interaction, translation, projection, residue report, product behavior, evidence contract validation, score, or quality claim was observed.
- The receipt’s stored protocol-negotiation check confirms the certified run’s identity, but this task could not obtain a fresh live Lab negotiation because the supported Lab path stopped before adapter dispatch.

Observed facts are the command outputs, file hashes, repository states, and cited source lines. The conclusion that receipt admission is absent is an evaluator interpretation supported by the public CLI rejection and the minimal source path. No unsupported claim about Qualiber quality is made.

## 15. Exactly one next action

Create the smallest Reality Lab admission remediation package: add one public receipt-aware adapter admission/registry command that validates the exact external manifest, receipt, entrypoint digest, certified verdict/scope, manifest-receipt linkage, and authentication status, returns a typed refusal for unsigned/development evidence, and makes the `adapter-certified` validity gate derive from the retained validated receipt rather than a constant. Do not change the adapter, r5 artifacts, or evaluator contract in that package.
