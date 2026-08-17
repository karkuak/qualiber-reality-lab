# LIVE-002 — the onboarding blocker that gates the first Qualiber dry run

The bounded unscored dry run against merged `main` proved that receipt-aware
adapter admission works, then stopped at `preregister-acquisition` with:

```text
BLOCKED — ONBOARDING
```

This directory preserves that run's report, because its evidence root was a
temporary directory and would otherwise be lost. Runtime logs and
absolute-path-heavy command output are deliberately **not** copied; the report
carries the findings.

## Provenance

- Original evidence root: `/private/tmp/qualiber-unscored-live-dry-run-retry-20260812T125150Z`
- Run id: `20260812T125150Z`
- `SHA256SUMS` digest at the time of copying:
  `aa1595ed1fa2db926412f46bdcbce04c085d236e2f3c4d21abd0bf92edb85195`
- All 17 inventoried files verified `OK` against that inventory before copying.
- Merged Lab under test: `70b7e6e00aabba30bc07ca2c15d35404e40439b7`,
  tree `b3b4e75f807608ff322f26649c9eacd5f8fef0fb`.

## What the run reached, and what it did not

Admission succeeded on the first attempt with the documented syntax. The
registry retained the manifest and receipt byte-identically
(`7893d048…`, `6f3087e7…`), and authenticity was labelled
`locally_observed_unauthenticated`.

**No adapter lifecycle operation ran, and no Qualiber or r5 product behaviour
was reached.** The run stopped at preregistration, before `acquire`. B-129 was
therefore neither exercised nor cleared.

## Why it stopped

`preregister-acquisition` requires eight governor-prepared hashes. No CLI
command, runbook, or shipped fixture produces them, and `README.md` states they
are prepared out of band. Hand-authoring registry internals was rejected as an
onboarding workaround rather than a supported path.

See `discovery-development-registry-preparation.md` in this directory for the
trace of what each of those eight artifacts actually requires, and why a generic
development-tier preparation command cannot yet be built without deciding
governance that is currently undefined.
