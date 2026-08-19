# Provenance — Qualiber Wave 2 prospective product-scenario campaign

## Identity

| property | value |
|---|---|
| Campaign ID | `qualiber-product-scenarios-wave2-20260819` |
| Campaign date | 2026-08-19 |
| Evidence directory | `docs/evidence/qualiber-product-scenarios-wave2-20260819/` |
| Scenarios | `QLB-EXT-006`, `QLB-EXT-007`, `QLB-EXT-008` |
| `evidence-index.json` sha256 | `c71a02ab42aa10d9c904aebf6f70a16be9869602169dc45d1486adbd4c4e3beb` |
| Indexed files | 666 |
| Indexed bytes | 1,091,242 |
| Files published under the evidence directory | 668 (666 indexed + `evidence-index.json` + `evidence-index.sha256`) |
| On-disk bytes under the evidence directory | 1,257,046 |
| Symlinks, non-regular entries, executable files | 0 / 0 / 0 |
| `oracle-precommit.json` sha256 | `f22309b860304163c9195196161fe7897b3d80db0a5edb8c349a1c77dad745ca` |
| `execution-lock.json` sha256 | `165480e83e61343773651f5ae13759f262dbe9b64fbfb4527c3c6f03f910c16b` |
| `campaign-index.json` sha256 | `bad6214ee0f01363652c47d106d60dc3ab9c3bd7c4518d2030f671b4fd6aafdb` |
| `claim-ceiling.verbatim.txt` sha256 | `bdf8c332dc0b19b9a1d183ee3ae833ac84d0d69c90c5ca913a304fdabc87beea` |
| `tooling-test-result.json` sha256 | `27dcb8cfb3ae8429a79a65cf49c9923944c22742a439af75bcd65ca874940e20` |
| Reviewed plan, revision 4.3 | `b1105dc7209cd8fcd32f10064ced6a4634c44b50faa582491376a37c9d019092` |

The index excludes exactly two files by its own declared convention — `evidence-index.json` and
`evidence-index.sha256` — which is why 668 files on disk correspond to 666 indexed entries.

### Source coordinates recorded by the campaign

| repository | commit | tree |
|---|---|---|
| Qualiber (subject) | `d3ebf37fc2cd5741c25eac22eaa20777153730ce` | `0d2a8c4de0196972ef1ed8844b3746a4cfa5df3a` |
| Reality Lab — campaign baseline | `87a87e535db6f74f95f6de5f14b4870d973b00d7` | `36c588658cf9abc9de01a6dbe4a8dc04cdf98e43` |
| Reality Lab — dependency pin | `69ace16fb7ee021dddbcf3fa70e4295c2e5a400b` | `89988e5588b04534316c73901e34c56861caa494` |

### Validation artifact identity

| item | value |
|---|---|
| Retained adapter | `c65c6393af5e6d83f937c3d0d7f274101e915922494d8fcec26f8865fe05e762`, 41,472 bytes |
| Retained manifest file | `91e830d253e23194ecb9bbd0a206c20699b610333821c25074a6dc6345c9e85a` |
| Manifest core hash | `504ab99b85804ad900bc56fac89d3e64da5295a772dfaef1be4848eef9b5b393` |
| Provenance receipt input digest | `a0bc5288c9c8f960fdc6fa9d316cf171d7be2cd39d631b90a28c461f7bbbc96d` |
| Adapter topology | `package-local-tarball` — no workspace-symlink topology |

### Independent review

| property | value |
|---|---|
| Report sha256 | `d87c4252b1802eac2643c3bdcd8aabc55a5cd073c67e5cde341d405c341643af` |
| Verdict | `READY TO PUBLISH — WAVE 2 EVIDENCE-ONLY REALITY LAB PR` |
| Blocking findings | none |
| Minor findings | four (M-1 … M-4) |
| Informational findings | four (I-1 … I-4) |

The independent-review report itself is **not published** here, and neither is the campaign's
execution report: both record local operational paths from the environments that produced them.
Their identities are recorded above and in the correction section below, and their material
conclusions are summarized in this note, so the retained record carries their substance without
carrying their environment.

## Subject relationship and neutrality

- **Subject:** Qualiber.
- **Relationship:** first-party dogfood — "subject zero." This classification is part of the retained
  publication record, not an aside.
- The campaign is **trusted-local exploratory evidence**, run **unconfined** over **synthetic**
  stimuli. The adapter ran as an ordinary child process under the operator's own permissions and was
  **not** isolated from the operator's filesystem or network.
- It is **not** certification. It is **not** independent assurance. It is **not** adoption evidence.
  It is **not** a T3 or T4 claim. It is **not** a broad Qualiber pass.
- The Lab does **not** issue governed qualification or independent-certification claims about
  Qualiber or about an affiliate.
- **Three** bounded synthetic scenarios were tested — cardinality (`QLB-EXT-006`), payload-presence
  (`QLB-EXT-007`) and payload-type (`QLB-EXT-008`) enforcement. All three product outcomes **agreed**
  with their precommitted expectations. **Zero product disagreements** were observed. That is an
  observation about **these three scenarios only**; it establishes nothing about Qualiber's behavior
  outside them.
- **No Reality Lab accommodation or product-code change** was made for this campaign.
- **No Qualiber product-code change** was made by this campaign, and none was made for it.

## Independent-review result

- All 668 files preserved byte-for-byte across the review; opening-versus-closing manifest diff empty.
- All 666 indexed digests and byte lengths recomputed; exact path-set equality.
- All three pinned commit-to-tree bindings verified in fresh clones.
- The three pinned Lab package tarball digests were **reproduced from source** on an unrelated
  machine, reproducing the provenance the execution lock binds.
- Both comparator entrypoint digests (`@erl2/contracts`, `@erl2/integrity`) reproduced and matched
  the execution lock, with the entrypoint-versus-closure limitation intact and preserved.
- All 17 precommit bindings recomputed exactly; `revision: 1`, `amendments: []`.
- All three expectations were independently re-derived from the `C-VALID` contract alone, without
  consulting any Qualiber test or reference-oracle fixture, and matched.
- All three scenario verdicts independently reproduced, with byte-identical `observed` blocks.
- All seven negative controls independently rerun against disposable copies, including the exact
  one-byte NC-5 digest transition.
- An independent oracle sweep, four times wider than the retained scans, found zero oracle content.

## Correction to the unpublished execution report

The campaign's execution report states, in its §5 and §8, that a final sweep covered "all
product-facing inputs and outputs — 51 files per scenario, 47 needles" and returned CLEAN for all
three scenarios. **The "51 files per scenario" figure is unsupported by the retained bytes and is
corrected here.**

- The bundle retains exactly **nine** oracle-absence scans — three per scenario — covering **seven
  files per scenario**: two mounted inputs, one sealed plan, and four retained inputs and envelopes.
  Each scan records `needle_count: 47`. No retained scan artifact and no command-log row records a
  51-file sweep.
- The underlying property is nonetheless independently established. The independent reviewer
  **separately swept 73 product-facing files per scenario** — mounted inputs, plan draft, sealed plan
  and the entire `run-output` tree — and found **no oracle content**. The only matches were the
  scenario identifier appearing as a directory-name component of a filesystem path, carrying no
  finding type, no run status and no expectation digest. The reviewer additionally confirmed that the
  pinned Qualiber tree contains zero occurrences of the Wave 2 scenario identifiers, campaign
  expectation field names, campaign schema ids or campaign digests, so the product cannot interpret a
  scenario label.
- The original execution report is **not published** in this repository and has **not been edited**;
  its reviewed digest, recorded above, remains intact. This note is the public correction record.

No bundle byte is affected by this correction.

## Retained-path disclosure and portability

The ephemeral campaign path `/private/tmp/qlb-wave2-prospective-897e4a0f/work` appears in **25**
retained files — the runtime dependency-provenance file plus, per scenario, the seal and run stdout
captures, both `request.frames` workspace captures, the three scans and the verification result. The
bundle's own README and the execution report disclose the path's presence in one file only; the true
count is 25, and this note is the corrected disclosure.

- The path is an **ephemeral task path** under the system temp root with a random campaign suffix. It
  discloses **no username, no credential, no token, no secret and no persistent repository location.**
- It is **deliberately left unredacted.** The execution lock binds the dependency-provenance file's
  digest, and that binding was written **before** execution. Rewriting these bytes after execution
  would leave a precommitted binding asserting a digest that matches no published file — orphaning
  the binding — and the comparator would **not** refuse the rewritten file, so the damage would be
  silent. It would also defeat the independent reproduction of the pinned tarball provenance.
  Publishing unredacted is the sounder choice, and it is an accepted, disclosed limitation rather
  than a closed one.
- **The bundle is consequently not path-portable.** It reproduces as a record, not as a relocatable
  workspace.

One further absolute path — a username-bearing path inside
`plan/qualiber-product-external-scenario-test-plan.md` — is **not a new disclosure**: that file is
byte-identical to the copy already committed in this repository at `87a87e53…`.

**Clarification on the embedded "never committed" statement.** The runtime dependency-provenance file
states that it "lives in gitignored node_modules and is never committed." That sentence describes the
**origin** of the file in Qualiber's working tree, where it is indeed gitignored. It does **not**
describe this retained publication copy, which is committed here as evidence. The file **must not be
edited** — the execution lock binds its digest — so this note is the correct remedy.

## Interpretation notes

**`tooling-test-result.json` is deterministic, not reused output.** The file is byte-identical to
Wave 1's. The independent reviewer **regenerated it byte-for-byte from a different filesystem
location**. It contains no campaign identifier, no timestamp and no absolute path, so any correct
12-of-12 run reproduces it exactly. Identity across waves is the expected outcome of a correct run.

**Regenerated fixtures.** 74 retained fixture files differ from committed Wave 1. Every differing key
is a **per-run identity field** — `observation_id`, `execution_id`, `plan_hash`, `core_hash`,
`response_envelope_hash`, `file_sha256` and `evidence_refs[].sha256`. No verdict, expectation,
finding-type or outcome field differs. These are regenerated test outputs, not authored edits. One
genuine addition is a log, `campaign/tooling-tests-stdout.log`.

**Comparator literals.** The comparator holds one literal event-name pair, used to select between two
disagreement **sub-reason labels**. **Both branches set the verdict to `disagree`**, so no `agree` or
`disagree` outcome can depend on it. The comparator is inherited byte-identically from the reviewed
and published Wave 1 comparator, and contains no literal finding type and no scenario-specific
verdict branch.

## Carried-forward work

These are recorded for the next campaign. Neither affects a Wave 2 verdict.

1. **The forbidden-status gate was inert for Wave 2.** `oracle-precommit.json` declares
   `forbidden_statuses` for all three scenarios, but the `*.expected.json` files the comparator
   actually reads carry **no** `forbidden_run_status` field, and the comparator reads
   `expectation.forbidden_run_status ?? []`. That secondary gate therefore never fired. **No verdict
   is affected:** `expected_run_status: rule_violation_detected` already forces `disagree` on any
   forbidden value, confirmed empirically by negative control NC-1, whose `clean` counterfactual
   produced `run_status_mismatch → disagree`. Wave 1's `QLB-EXT-004` did carry the field, so this is a
   Wave 2 expectation-authoring gap, not a tooling regression. Future expectation authoring should
   populate the field, or the tooling should require it.
2. **Oracle-scan completeness is operator-parameterized and unenforced.** Omitting `--digest-source`
   silently narrows the needle set from 47 to 21 and still reports `CLEAN` at exit 0; an
   existing-but-empty target yields `CLEAN over 0 file(s)`, also at exit 0. A nonexistent target does
   hard-error, so a mistyped path cannot be silently skipped. Wave 2's own nine scans are correctly
   parameterized — every one records `needle_count: 47` and the same 11 needle kinds — and a
   reviewer-planted genuine needle **was detected**, so these CLEAN results are meaningful rather than
   vacuous. Future tooling should **refuse an empty target set and an incomplete needle set** rather
   than reporting CLEAN over them.

## Publication note

The evidence directory is published **unchanged, byte-for-byte, as reviewed**. The reviewed evidence
was deliberately **not** edited to carry the corrections above: correcting bundle prose would require
rebuilding `evidence-index.json` and its sidecar and re-issuing the campaign identities, which is a
deliberate re-publication rather than an edit in place — and, for the retained-path disclosure, would
orphan a binding written before execution. This note is the correction record.

This note sits **beside** the indexed campaign directory, not inside it, so it does not disturb the
evidence index and does not appear in `evidence-index.json`. It introduces no new JSON schema and no
new assurance mechanism.

Absolute paths already retained inside the reviewed bundle are accepted here under the independent
review's stated limitation; **no new local absolute path is introduced by this note.**
