# LIVE-001 — the blocking observation this remediation answers

The first bounded unscored live Reality Lab dry run stopped before
preregistration with:

```text
BLOCKED — NO SUPPORTED LIVE ADAPTER ADMISSION PATH
```

This directory preserves that run's report, because its evidence root was a
temporary directory and would otherwise have been lost.

## Provenance

- Original evidence root: `/private/tmp/qualiber-unscored-live-dry-run-20260811T031410Z/evidence`
- Run id: `20260811T031410Z`
- `SHA256SUMS` digest at the time of copying:
  `1d8f7da3c02403510d9d7f0eb5a7fb243d7a2f8613eb710b6257c3b080c840c4`
- All seven inventoried files verified `OK` against that inventory before the
  copy was taken.
- Reality Lab under test: `main` at
  `787281318c845c34d209127177b8355c66b47f5b`, tree
  `386b40da3a2151e56bb272226b110c67c3586649`, clean.

## What is here, and what is not

`report.md` is the run's own report, byte-identical to the original
(`22134d7d3902367cf5d3a31ccbb3f44f77bbd4504f19e50be98d2ba35a386118`).
`SHA256SUMS` is the original inventory, so the copy can still be checked against
the four logs that stayed behind.

The four logs themselves — `admission-source-inspection.log`,
`public-interface.log`, `preflight-coordinates.log`,
`environment-inventory.log`, `cleanup-final-state.log` and
`command-intervention-log.md` — are **not** copied. They are runtime output with
absolute local paths, and the report quotes the load-bearing lines from each.
Their digests are in `SHA256SUMS`, so a reader who still holds the original root
can verify them; a reader who does not can still verify this report.

## The finding

`LIVE-001 — P1 — REALITY_LAB_DEFECT`. Reproduced independently from source
before any change was made:

- `preregister-acquisition --certification-receipt <receipt>` exited 2 with
  `CFG_UNKNOWN_FLAG`;
- `AdmissionRegistry` indexed core-hashed JSON with no adapter-receipt workflow;
- preregistration required only `SubjectAdapterManifestV1`;
- the live external-adapter path resolved only the adapter manifest before
  constructing `AdapterHost`;
- both validity paths emitted a literal
  `{ gate_id: "adapter-certified", passed: true, evidence_refs: [adapterHash] }`.

The secondary finding is `LIVE-002 — P2 — ONBOARDING_OR_DOCUMENTATION_DEFECT`.

`LIVE-003` (execution-sandbox permissions) and `LIVE-004` (an unreviewed `npm
audit` signal) are recorded in the report and are **not** addressed here.

## What answers it

ADR-ERL2-036 and the controls in
`tests/adversarial/externalAdapterAdmission.test.ts`. The remediation is
recorded in `docs/ledger/remediation-live-001-adapter-admission.md`.
