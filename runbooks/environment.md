# Runbook — environments and the clean control

## Which driver is active

```bash
node packages/cli/dist/src/bin.js doctor --profile local-developer
```

Today it reports:

```text
fake_environment_driver:      enabled
compose_environment_driver:   disabled_pending_erl2_oq_005
otel_demo_substrate_lock:     unqualified_pending_erl2_oq_005
constrained_archetypes:       clean_greenfield_only_pending_erl2_oq_002
```

The fake driver is deterministic, needs no substrate, and models every lifecycle
and failure path the Compose driver will have to handle. Both satisfy the same
`EnvironmentDriver` contract suite.

## The clean control

`clean-greenfield` is the required control archetype (design v2 §9). A run is
only admissible from a clean baseline:

1. `provision` creates run-scoped resources. Every resource name embeds the run
   id, and `resourceIdentityHash` refuses one that does not.
2. `probe --phase baseline` produces an `EnvironmentBaselineFingerprintV1`.
3. `assertBaselineClean` refuses a contaminated baseline or a failed probe. The
   failure is Lab-owned; no subject finding may be derived from it.
4. `assertRepeatableBaseline` compares two clean provisions. The fingerprint is
   derived from ordered probe observations and evidence-source states only — not
   from run id, instance identity or timestamps — so two clean runs of the same
   archetype must produce **identical** fingerprint bytes.

If two clean provisions disagree, the archetype is not repeatable. Do not
attest against it; fix the archetype or the driver.

## Isolation between concurrent runs

The global allocator stores **reservation leases only** — never resource state.

- Two runs cannot reserve the same network, volume, port, tenant or project.
  The second gets `ENV_RESERVATION_CONFLICT`; it does not wait.
- A lease from a crashed run is reclaimable once it expires, so a dead run
  cannot deadlock the substrate. `reclaimExpired()` reports exactly what it
  reclaimed.
- A run cannot release another run's lease.

## Cleanup and the resource frontier

Cleanup targets exact validated identities. A wildcard or unscoped selector is
refused with `ENV_BROAD_DELETE_REJECTED`; ambient project discovery does not
exist.

When restoration or teardown fails:

1. Freeze the frontier with `freezeResourceFrontier`. It records what the driver
   *observed*.
2. The safe-action set is **derived here**, not supplied by the driver. A
   resource is independently safe to act on only when it is provably this run's,
   marked destroyable, and not shared with another run. Anything else becomes a
   `contain_residual` action marked unsafe with a reason.
3. Attempt every independently safe action and freeze a receipt for each — for
   failures as well as successes.
4. Record each unsafe skip with a reason and **no** receipt.
5. Freeze `EmergencyCleanupVerificationV1`, and only then the invalid record.

`erl2 verify-record` refuses a restoration or teardown failure that reached the
invalid record without this path (`EMERGENCY_CLEANUP_BYPASSED`), and
`assertFrontierActionsDerivable` refuses a frontier whose action list was edited.

## Enabling Compose (ERL2-OQ-005)

Follow `environments/otel-demo/README.md`. In short: capture the archive digest,
per-platform image digests for both `linux/amd64` and `darwin/arm64`, the SBOM,
provenance and config hashes; set `qualification_status: "qualified"`; re-sign;
then re-run the clean-control suite twice and confirm identical fingerprints.

There is no flag that skips this. `composeDriverManifestBody` derives `enabled`
from the lock, so an unqualified lock always produces a disabled driver.
