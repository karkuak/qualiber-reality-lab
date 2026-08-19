# Provenance — Qualiber Wave 1 product-scenario campaign

## Identity

| property | value |
|---|---|
| Campaign ID | `qualiber-product-scenarios-20260818` |
| Campaign date | 2026-08-18 |
| Evidence directory | `docs/evidence/qualiber-product-scenarios-20260818/` |
| `evidence-index.json` sha256 | `ec00d60fac6433c001aef78cb45724b248903f9bf1ab4a04ba9b3c5ae1e7ae08` |
| Indexed files | 732 |
| Indexed bytes | 1,203,136 |
| Files published under the evidence directory | 734 (732 indexed + `evidence-index.json` + `evidence-index.sha256`) |
| `oracle-precommit.json` sha256 | `b8f5fdb4786c1500d6d77454316c6e29a53d3cc51e3274ba0a425f1b30e62b69` |
| `execution-lock.json` sha256 | `a379c02c1c0862daf84da47cbf743a6638dd59629a2df81ad7501ead391bcaae` |

The index excludes exactly two files by its own declared convention — `evidence-index.json` and
`evidence-index.sha256` — which is why 734 files on disk correspond to 732 indexed entries.

### Source coordinates recorded by the campaign

| repository | commit | tree |
|---|---|---|
| Qualiber (subject) | `d3ebf37fc2cd5741c25eac22eaa20777153730ce` | `0d2a8c4de0196972ef1ed8844b3746a4cfa5df3a` |
| Reality Lab — campaign baseline | `3d2655f67ad14c16dd6148e4654cc0fa872cb4a4` | `74c633fb5546085de055abb92095442e375a03c4` |
| Reality Lab — dependency pin | `69ace16fb7ee021dddbcf3fa70e4295c2e5a400b` | `89988e5588b04534316c73901e34c56861caa494` |

### Independent review

| property | value |
|---|---|
| Report sha256 | `2cf0a98c0d37f8905ca81e42ebc9e8f07a4b5c78f8d6adfc54e379748d90eb8b` |
| Verdict | `READY TO PUBLISH — EVIDENCE-ONLY REALITY LAB PR` |
| Blocking findings | none |

The independent-review report itself is **not published** here: it records local operational paths
from the reviewer's environment. Its material findings are summarized in this note instead, so the
retained record carries the review's substance without carrying its environment.

## Subject relationship and neutrality

- **Subject:** Qualiber.
- **Relationship:** first-party dogfood — "subject zero." This classification is part of the retained
  publication record, not an aside.
- The campaign is **trusted-local exploratory evidence**. It is **not** independent certification. It
  is **not** a T3 or T4 claim.
- The Lab does **not** issue governed qualification or independent-certification claims about
  Qualiber or about an affiliate.
- Five synthetic scenarios were tested. **Zero product disagreements** were observed in those five
  scenarios. That does not establish correctness outside them.
- This is **not adoption evidence**.
- The process was **unconfined**: the adapter ran as an ordinary child process under the operator's
  own permissions, not isolated from the operator's filesystem or network.
- **No Reality Lab accommodation or product-code change** was made for this campaign.
- **No Qualiber product-code change** was made by this campaign.

## Independent-review result

- All 732 indexed files and byte lengths reproduced.
- All five observations passed offline verification.
- All five comparisons were independently re-derived.
- All seven negative controls were independently rerun against disposable copies.
- The source bundle remained byte-for-byte unchanged across the review.

## Errata and interpretation

**NC-2.** The required safety property held: the result was `unavailable`, and `clean` was never
observed as a value. Its secondary `lab_harness_failure` classification follows the mandatory
binding-first rule — the retained `run-summary.json` artifact-hash witness still declares a digest for
the deleted file, so the binding gate refuses before the missing-result branch is reached. The
differing label in the plan's table is a **prospective plan erratum**, not a campaign failure. The
comparator was deliberately not edited to make the table match.

**NC-5.** The first mutation attempt was **void**, because the retained scratch input was read-only;
it is retained and described as void rather than as a control that held. The authoritative NC-5 rerun
recorded and verified a changed input digest **before** either leg ran, and both the verifier and the
comparator then refused.

**Paused-campaign capture.** The bundle's plan-application note overstates what was captured about the
concurrently paused campaign:

- no opening paused-campaign coordinate capture is retained in this bundle;
- the paused campaign was checked read-only at close;
- exhaustive review found **no paused-campaign bytes copied into this publication**.

**Reality Lab delta.** The delta from `69ace16…` to `3d2655f…` included both the 2026-08-16 evidence
directory and its sibling provenance document. Nothing outside `docs/evidence/**` changed.

**Execution report.** The campaign's execution report is **not published**. Two documentation defects
sit in that report alone: its system-temp residue sentence lacked retained command output, and one
deviation cross-reference named the wrong bundle file.

None of these documentation findings alters any scenario result, binding, verifier outcome,
comparison, or claim ceiling.

## Publication note

The evidence directory was published unchanged, byte-for-byte, as reviewed. The reviewed evidence was
deliberately **not** edited to correct the documentation findings above: correcting bundle prose would
require rebuilding `evidence-index.json` and its sidecar and re-issuing the campaign identities, which
is a deliberate re-publication rather than an edit in place. This note is the correction record.

This note sits beside the indexed campaign directory, not inside it, so it does not disturb the
evidence index. It introduces no new JSON schema and no new assurance mechanism.

Absolute operator paths already retained inside the reviewed bundle are accepted here under the
independent review's stated limitation; no new local absolute path is introduced by this note.
