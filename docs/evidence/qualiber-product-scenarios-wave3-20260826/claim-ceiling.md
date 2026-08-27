# Wave 3 — claim ceiling

This document bounds exactly what the Wave 3 evidence in this candidate asserts. Every
statement elsewhere in the candidate is subordinate to these limits.

## What is claimed

- **Four bounded Wave 3 observations.** For scenarios QLB-EXT-009, QLB-EXT-010, QLB-EXT-011,
  and QLB-EXT-012 — at the exact pinned coordinates and against the specific frozen contracts
  and stimuli — the product and the Reality Lab comparator **agree** (`product_agreement`),
  with 0 product disagreements.
- **Determinism.** Each of the four scenarios is **semantically deterministic** between the
  first attempt and the completion run (only the expected nondeterministic fields —
  `oracle_precommit_sha256`, `execution_lock_sha256` — differ).
- **Negative controls.** The fifteen active `control-set-v2` controls each reproduced their
  precommitted verdict under independent re-execution, exercising the comparator's discrimination
  (mutations disagree, tampering unbinds, forbidden-status precedence fires, planted residue is
  refused and named).
- **Twelve cumulative Qualiber scenario agreements.** Across Waves to date, this brings the
  cumulative count of Qualiber product-scenario agreements to **twelve** (the four Wave 3
  scenarios plus the eight from prior waves). This is a count of *tested agreements*, nothing more.

## What is NOT claimed

- **No certification.** This is not a certification of Qualiber or of the Reality Lab.
- **No independent assurance.** The assembly session that produced this candidate is **not**
  an independent review. The included review reports are independent, but this candidate as a
  whole still **awaits** independent review.
- **No production readiness.** Nothing here asserts fitness for production, release, or
  operational deployment.
- **No claim beyond tested contracts and stimuli.** The observations hold only for the exact
  scenarios, contracts, stimuli, coordinates, and tooling recorded in `coordinates.json`. They
  do not generalize to other inputs, versions, environments, or behaviors.

## Trust and environment boundary

- **Trusted-local / unconfined / synthetic.** All execution was trusted-local and unconfined,
  against synthetic stimuli. There was no adversarial sandboxing, no untrusted-input hardening,
  and no real-world data.
- **Comparator-only integrity scope.** The campaign's comparator checks declared
  `retained_output_refs` against expected digests; it does **not**, on its own, guarantee
  tree-level integrity against undeclared extra files. That gap was the subject of NC-12 →
  NC-12R (see `supersession.json` and `errata.md`); the residue scanner supplies the enumeration
  check, but the claim ceiling for the *comparator alone* remains as stated.

## Historical defects do not raise the ceiling

The completion attempt's post-freeze runner digest mismatch, the original NC-11 property miss,
and the original NC-12 FAILED result are recorded in `errata.md` and `supersession.json`. Their
authoritative replacements (a re-frozen runner; NC-11R; NC-12R) restore the control properties,
but **no claim above** is enlarged by them.
