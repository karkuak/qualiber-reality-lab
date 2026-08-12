# Subject Adapter V2 Package A implementation record

Date: 2026-08-12

Design baseline: `1d9d27ad32548323f94bb36e992b62030ce8d452`

Mutation baseline: `ab6aca571f207bd838f83d87df5b35e4f1f0ab33`

## Scope delivered

Package A adds only the local-observation `subject-adapter/v2` seam approved by
ADR-ERL2-037. It registers ERL2-C-161 through ERL2-C-170, extends the existing
SDK and `AdapterHost`, adds one generic observation reducer, and provides
unsigned neutral certification-scope fixtures. Governed V2 remains a closed
structural discriminator and is refused before dispatch. V1 remains the default
for V1 manifests.

The implementation does not contain a local-to-governed converter, public CLI,
second supervisor, second artifact store, second mutation ledger, second output
freeze mechanism, second cleanup engine, product-specific field, signer, or
governor authority.

## Targeted validation

The focused Package A suites passed before mutation testing:

- local contract closure and all thirteen correlated payloads: 6/6;
- local V2 negotiation, admission, limits, controls, subprocess, and
  certification-scope checks: 10/10;
- reducer sequencing, replay, recovery, cleanup, and freeze behavior: 6/6;
- local-to-governed claim firewall: 3/3, including 36 local-type/consumer
  combinations;
- local architecture boundary: 4/4;
- affected V1 contract, host, mode-binding, applicability, and certification
  regressions: 142/142.

Both neutral adapters use the existing framed subprocess launcher, supervisor,
diagnostics freezer, output freezer, artifact store, mutation ledger, and
per-dispatch entrypoint digest verification.

## Load-bearing mutation record

All mutations were built and tested independently in disposable detached
worktrees. Every mutation was killed by the named focused test:

| Mutation | Killed by |
|---|---|
| NC-V2-01 local mode accepts V1 | `LOCAL-V2: V1 remains the default and cannot be selected for local mode` |
| NC-V2-02 V1 receipt authorizes V2 | `LOCAL-V2: V1 receipts and altered manifest/artifact/profile scope never authorize V2` |
| NC-V2-03 governed field permitted | `LOCAL-CLOSURE: governed fields, claim changes, signatures and trusted status words are unrepresentable` |
| NC-V2-04 `not_scored` not constant | `LOCAL-CLOSURE: governed fields, claim changes, signatures and trusted status words are unrepresentable` |
| NC-V2-05 local result enters finalization | `LOCAL-FIREWALL: every local type is rejected by every governed consumer contract` |
| NC-V2-06 receipt operation scope ignored | `LOCAL-V2: V1 receipts and altered manifest/artifact/profile scope never authorize V2` |
| NC-V2-07 dispatch digest check skipped | `LOCAL-V2: per-dispatch artifact verification is load-bearing` |
| NC-V2-08 local output limit skipped | `LOCAL-LIMITS: plan ceilings intersect with host, output, diagnostics and controls` |
| NC-V2-09 ambiguous effect replayed | `LOCAL-REDUCER: ambiguous effects are never replayed and force cleanup-only progress` |
| NC-V2-10 post-freeze dispatch allowed | `LOCAL-REDUCER: output freeze irreversibly refuses subsequent subject operations` |
| NC-V2-11 cleanup completed without evidence | `LOCAL-REDUCER: ambiguous effects are never replayed and force cleanup-only progress` |
| NC-V2-12 coordinator directly spawns | `LOCAL-ARCH: the coordinator delegates execution exclusively to AdapterHost` |

No mutation was committed. The harness restores the original worktree inventory
after every case.

## Generated evidence audit

One authorized `evidence:update` was run after the targeted suites and mutation
matrix. It generated 845 files from 91 CLI invocations with 11 expected
refusals, and the staged invalid/valid golden gates passed.

The only legitimate semantic golden delta is the doctor transcript's public
contract count, from 156 to 166. The other six changed files were already
declared unpinnable: five request-frame files differed only in the fixed-length
staging suffix and one grandchild PID contained a new real OS process ID. Those
six changes, plus unrelated path/time/environment-run churn in the excluded CLI
transcript, were rejected. The committed transcript retains only the 166 count.
Pinned coverage remains 838 files with 7 exact exclusions. No V1 request
payload, manifest, receipt, negotiation, response envelope, or core hash moved.

## Campaign carry-forward

The repository-wide negative-control campaign was not run. Existing campaign
carry-forward cannot be claimed unchanged because Package A alters the adapter
host and protocol boundary. Whether the full campaign must be rerun is left to
the independent Package B architecture, security, compatibility, and
certification-scope review, as required by the approved package boundary.
