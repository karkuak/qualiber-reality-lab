# Qualiber product scenarios — Wave 2 (QLB-EXT-006 … 008), 2026-08-19

**Uncommitted evidence bundle. Ready for independent evidence review. Not published, not committed,
not adopted.**

This campaign executes the Wave 2 scenarios that plan revision 4.3 §9 already specified, against a
pinned Qualiber baseline, with **zero code change** to either product.

## What Qualiber is here

* **first-party dogfood** — the Lab's owner also owns the subject
* **subject zero** — the first product ever driven through this seam
* **trusted-local** — the adapter runs as an ordinary child process
* **unconfined** — not sandboxed, not isolated from the operator's filesystem or network
* **synthetic** — hand-authored stimuli, not a real customer journey
* **not certification**, **not adoption evidence**, **not a T3 or T4 claim**

Three scenarios exercising cardinality, payload-presence and payload-type enforcement are **not a
broad product pass**. The full claim ceiling is in `claim-ceiling.verbatim.txt`, bound by
`execution-lock.json`.

## Result

| scenario | discrimination | expected | observed | verdict |
|---|---|---|---|---|
| QLB-EXT-006 | cardinality (`occurrence_bounds.max = 1`) | `rule_violation_detected`, `duplicate_event` ×1 on `quote_requested_one` | exactly that | `agree` |
| QLB-EXT-007 | payload-level presence | `rule_violation_detected`, `missing_required_property` ×1 on `quote_requested_three` | exactly that | `agree` |
| QLB-EXT-008 | payload-level type | `rule_violation_detected`, `property_type_mismatch` ×1 on `quote_requested_three` | exactly that | `agree` |

All seven negative controls held. **Zero candidate product disagreements** — recorded as an
observation about these three scenarios, not as a broad pass and not as a finding.

## Zero-code extension, tested rather than assumed

All four Wave 1 campaign scripts were reused **byte-for-byte** (`compare-scenario.mjs`
`89e92a03…`, `oracle-absence-scan.mjs` `5a17321b…`, `compare-scenario.test.mjs` `ecccd5a9…`,
`run-offline-verification.mjs` `9ff27ced…`). The unchanged tests were re-run against freshly
provisioned pinned dependencies: **12 of 12 passed**, `comparator_sha256_tested` unchanged. Wave 2
added three stimulus files and three expectation files and nothing else — no script, helper,
comparator branch, plan generator, adapter operation or schema.

## Chronology of the oracle

`oracle-precommit.json` (`f22309b8…`, `revision: 1`, `amendments: []`) was written **before any
Qualiber execution against Wave 2 inputs**. It binds the reviewed plan, the plan-application note,
all three stimuli, the shared contract, all three expectations, the NC-1 counterfactual, the four
unchanged tooling digests, the tooling-test result, the scenario definitions and the pinned Qualiber
baseline. It binds **no** adapter artifact, manifest, observation id or sealed-plan hash, because
none existed yet. `execution-lock.json` (`165480e8…`) was written after the clean product build and
before the first scenario. **No expectation was amended after execution.**

## Wave 1 is frozen

`docs/evidence/qualiber-product-scenarios-20260818/**` was validated at campaign open — 732 of 732
indexed files matched, exact path-set equality — and then left untouched. Wave 1 was not re-run, not
amended and not copied into this bundle. No paused-campaign output appears here either.

## Two things a reviewer should check rather than take on trust

**A tooling-test failure occurred and was diagnosed, not edited away.** The first re-run reported
`T5` failing. Cause: the operator passed `--retain-fixtures` as a **relative** path, so the anchor
the test derives was relative too; the comparator refused it correctly with a hard exit 3 and
`createRequire failed for anchor … must be … absolute path string`, which is a *different*
legitimate tooling exit from the one T5 asserts. Re-running the **unchanged** test with an absolute
path — the form Wave 1's own command log used — passes 12 of 12. Both invocations are in
`commands/command-log.tsv`. No script or fixture was edited.

**`adapter/runtime-dependency-provenance.json` carries a campaign-local absolute path.** Wave 1
redacted that field before publishing. Wave 2 does **not**, because `execution-lock.json` was
written before execution and binds the unredacted digest (`0f4d9bc2…`); redacting afterwards would
have left a bound digest matching no published file, and rewriting a stage-2 artifact after the
comparisons had already bound it would have been a post-hoc amendment. Verifiable bindings were
preferred over path aesthetics. The semantic content — pinned Lab commit `69ace16…` and the three
package tarball digests — is identical to Wave 1's.

## Layout

| path | what it is |
|---|---|
| `plan/` | the unchanged reviewed plan (`b1105dc7…`) and the Wave 2 application note |
| `oracle-precommit.json` + `.sha256` | stage 1, frozen before execution |
| `execution-lock.json` + `.sha256` | stage 2, written before the first scenario |
| `claim-ceiling.verbatim.txt` | the ceiling, bound by the lock |
| `campaign/` | the four unchanged scripts, their retained fixtures, the tooling-test result and stdout |
| `expectations/` | the three precommitted expectations |
| `scenarios/<ID>/` | inputs, plan draft + sealed plan, declaration, run-output, scans, verification, comparison |
| `negative-controls/` | the counterfactual, seven result files and their README |
| `coordinates/` | opening and closing coordinates and porcelain for every worktree used |
| `provisioning/` | install, build and product-test logs |
| `commands/command-log.tsv` | every command, with exit codes |
| `campaign-index.json` | the three observation ids and plan hashes |
| `evidence-index.json` + `.sha256` | sorted index with byte lengths and sha256 |

`failed-attempts/` records attempts that did not become results.

## Repository preservation

Qualiber's opening and closing porcelain are **byte-identical** (both empty). The Reality Lab
evidence worktree differs from `87a87e53…` by exactly one untracked directory — this one. Nothing is
staged. Nothing was committed, pushed, published, or opened as a PR or issue.
