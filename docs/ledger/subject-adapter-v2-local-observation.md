# `subject-adapter/v2` local-observation decision ledger

**Status:** `approved_for_implementation_package_a_only`

**Recorded:** 2026-08-12

**Normative ADR:** [ADR-ERL2-037](../adr/ADR-ERL2-037.md)

## Repository coordinates

| Coordinate | Value |
|---|---|
| expected and observed `origin/main` | `70b7e6e00aabba30bc07ca2c15d35404e40439b7` |
| observed `origin/main` parents | `787281318c845c34d209127177b8355c66b47f5b`, `9ddfe971672c76214a8ff906bdcd4d6655917735` |
| expected and observed `origin/main` tree | `b3b4e75f807608ff322f26649c9eacd5f8fef0fb` |
| design starting branch | `codex/local-observation-workflow` |
| design starting commit | `0bc7c1cb5559b9a8d9c5bd6fe5839591d9acfa17` |
| design starting tree | `5279ce99a028105fa68cfe87b0ead2235db10438` |
| design branch | `codex/subject-adapter-v2-local-observation-design` |
| branch construction | created directly from the starting commit; no main update or history rewrite |

One unrelated worktree was inventoried and not opened, changed or executed:
`.claude/worktrees/practical-mestorf-5e0215`, branch
`claude/practical-mestorf-5e0215`, commit
`25d3f57c833f50f84d4eaba783900593719d651e`.

## Evidence accepted for the decision

The two evidence manifests verified before design work.

### Governed dry-run discovery

Directory:
`docs/evidence/live-002-unscored-dry-run-retry-20260812T125150Z/`

| File | SHA-256 |
|---|---|
| `README.md` | `cc7df8271fe1e3799a40686a8233cb72229855dd5058c5f61b4f50e56f9f10b9` |
| `discovery-development-registry-preparation.md` | `2cae6c1076d88313d653e03119ee92d1ed3001fe9cd1d8a56b2a891c8b957a51` |
| `report.md` | `d5bba566722425ec1b38561047283c53a4b412f4628f382ccb114c54ea8ca693` |

Finding: adapter admission succeeded with locally observed unauthenticated
certification evidence, but honest governed preparation stopped before adapter
operations. Eight governor inputs depend on four unresolved normative decisions:
judge expectation/encryption recipient, trust root, signer roles and the
meanings of opaque policy hashes. Test fixtures are not permissible defaults.

### Local-observation design gate

Directory: `docs/evidence/local-observation-design-gate-20260812/`

| File | SHA-256 |
|---|---|
| `README.md` | `ea7dcf19d48fad8db10b34ee77229f4a9fa5a5f44c122f1bfaf04233664ec2f3` |
| `probe-acquire.txt` | `530a9bdaaf395bf85e196b8df5bddbdaa9115caf01f361fa761051749d4701ff` |
| `probe-step-ops.txt` | `20039366885380c2026d61e918a18721b738ca8ffd28861acee4db10fac378c2` |

Finding: the real v1 adapter rejects minimal local requests and accepts
governed fixture-shaped requests. Orchestration and claim constants are
separable, but the v1 request context is not. The smallest truthful seam is a
new non-governed protocol request, with v1 left unchanged.

## Independent-QA read-only coordinate

The external repository was inspected only; no code or evidence was changed or
executed.

| Coordinate | Value |
|---|---|
| repository | `/Users/karthik/Developer/qualiber-independent-qa` |
| branch | `codex/stage3-adapter-certification` |
| commit | `a699383045d24c91876a8dd176ae8572612c7cb1` |
| tree | `2156bce3df5b468eec2ee6aabba30b1c50f25e16` |
| adapter | `independent-analytics-validator` `0.1.0` |
| protocol | `subject-adapter/v1` |
| artifact hash | `sha256:b977ac2ad4698de7145ddc1d01b4aa27f2bc4c7a8d5b13d57ce997289b976893` |
| manifest core | `sha256:45d6428e1da4879e38dd0f56c6f28d74e4e0d7e516c022653f019779583e9b07` |
| receipt core | `sha256:24d75c1c347f2c3444dc7bfe7f4f337c03f7b4eb72054717e3e47deb31e6239b` |

The v1 receipt is unsigned and scoped to the frozen artifact, manifest, eleven
declared operations and its package kinds. `collect-outputs` and `stop` are
honestly omitted. It cannot authorize changed bytes or v2.

## Root cause and disposition

| Question | Decision |
|---|---|
| Is the blocker a missing governor default? | No. The missing values encode real trust, signer and judge decisions. |
| Can a local plan hash occupy a v1 governed field? | No. That would preserve valid JSON while making a false semantic claim. |
| Does v1 change? | No. Its contracts, handshake, semantics, certification and governed use remain unchanged. |
| What is added? | Exact protocol `subject-adapter/v2` with a closed `local_observation` context and a defined-but-deferred governed branch. |
| Is local observation a lower tier? | No. It is a separate evidence class with no promotion path. |
| Is there a new run engine? | No. One small linear coordinator delegates all effects to the existing `AdapterHost`. |
| Where do contracts live? | Additively in `@erl2/contracts`; no new contracts package. |
| Is a new certification suite required? | Yes, `ADAPTER-CERT-V2`, because mode/claim/recovery assurance changes. |
| Does a v1 receipt carry over after adapter code changes? | No. New bytes require new v1 and v2 receipts for their separate manifests. |
| Are local plan/results signed? | No normative signer exists. They are core-hashed and labeled `unauthenticated_local_record`. |

## Approved scope

The architecture package consists of:

- ADR-ERL2-037;
- the exact protocol/contract design;
- the compatibility and recertification plan;
- Packages A–F with owners, scopes, tests, evidence and stop conditions;
- the structural claim/threat matrix;
- the requirements-to-tests matrix; and
- the executive decision summary.

This design reserves ERL2-C-161 through ERL2-C-170 but creates no contract or
registry entry. It changes no SDK, host, adapter, certification runtime, CLI or
execution path.

## Deferred and prohibited scope

- governed v2 implementation or migration;
- governor, trust-root, signer, judge-expectation or policy construction;
- scoring, qualification, reveal, judge evaluation or governed finalization;
- a local-to-governed import, conversion or tier upgrade;
- product-specific protocol concepts;
- new UI, production rollout or hostile-code containment claims;
- Independent-QA adapter changes before Package A and independent review; and
- Package B or later execution under this approval.

## Gate status

| Gate | Status |
|---|---|
| Evidence integrity | satisfied |
| Root-cause confirmation on real v1 adapter | satisfied |
| Generic protocol and contract shape | accepted |
| V1 compatibility strategy | accepted |
| V2 certification and recertification strategy | accepted |
| Claim-boundary threat model | accepted for implementation |
| Thin-extension bound | accepted: 24–32 Lab files, ten top-level contracts, at most two new production modules |
| Runtime implementation | not started |
| Independent review | required after Package A |
| External adapter support/recertification | deferred to Packages C/D |
| Real subprocess evidence | deferred to Packages E/F |

## Next authorized recommendation

Implement Package A only: the generic additive contracts, existing host/SDK
seam, structural claim firewall and neutral fixtures. Freeze its evidence and
stop for Package B independent review before touching the Independent-QA
adapter or running a product-adapter observation.
