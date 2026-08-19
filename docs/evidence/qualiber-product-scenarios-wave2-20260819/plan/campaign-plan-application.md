# How revision 4.3 of the test plan applies to the Wave 2 campaign

Campaign: `qualiber-product-scenarios-wave2-20260819`
Scenarios: QLB-EXT-006, QLB-EXT-007, QLB-EXT-008 (plan §9)

---

## 1 · The bound plan is unchanged

This campaign binds **revision 4.3** of
`qualiber-product-external-scenario-test-plan.md`, sha256
`b1105dc7209cd8fcd32f10064ced6a4634c44b50faa582491376a37c9d019092`, byte-for-byte the same
document Wave 1 bound. The plan was **not amended** for Wave 2, and no erratum was applied to it.
§9 already specifies all three scenarios completely — stimulus change, expected `runStatus`,
expected finding type and the discrimination each adds. Wave 2 is the execution of a specification
that already existed, not a new specification.

## 2 · Wave 1 is frozen and is not amended

The published Wave 1 bundle `docs/evidence/qualiber-product-scenarios-20260818/**` is **frozen**.
Its `evidence-index.json` (sha256 `ec00d60fac6433c001aef78cb45724b248903f9bf1ab4a04ba9b3c5ae1e7ae08`)
was recomputed in full at the opening of this campaign: 732 of 732 files matched on both sha256 and
byte length, with exact path-set equality and no unindexed file on disk. Nothing in Wave 1 was
re-run, re-verified into a new verdict, corrected, or reinterpreted. Wave 1 outcomes are **cited**
here, never restated as Wave 2 results.

## 3 · Wave 2 uses the already-reviewed generic comparator with no code change

Plan §9 states the property directly: Wave 2 requires *zero* new adapter code, plan machinery or
comparator logic — three stimulus files and three expectation files. That property was **tested, not
assumed**, before any scenario ran:

* All four retained Wave 1 campaign scripts were copied byte-identically. Their digests match the
  published Wave 1 identities exactly: comparator `89e92a03…`, oracle-absence scanner `5a17321b…`,
  comparator tests `ecccd5a9…`, offline-verification runner `9ff27ced…`.
* The comparator contains **no** literal finding type and **no** scenario-specific branch. Every
  scenario-varying quantity — `expected_run_status`, `required_finding_types`,
  `permitted_additional_types`, `target_event`, `max_finding_count` — is read from the expectation
  file. The only occurrences of a scenario identifier in the comparator are two source comments.
* The unchanged comparator tests were re-run against freshly provisioned pinned dependencies:
  **12 of 12 passed**, and the recorded `comparator_sha256_tested` is `89e92a03…`, the same
  comparator Wave 1 tested.

No script, fixture, schema, contract, adapter operation or comparator branch was added, edited or
extended for Wave 2.

### 3.1 · One recorded operator-invocation deviation, and why it is not a seam failure

The first attempt at the tooling-test re-run reported `T5` failing. The cause was established before
anything else proceeded, and it was **operator invocation, not tooling**: the run passed
`--retain-fixtures campaign/fixtures` as a *relative* path, so the anchor the test derives for T5
(`<fixtures>/4-t5/lonely/package.json`) was also relative. The comparator refused it correctly, with
a hard tooling exit 3 and the message `createRequire failed for anchor … must be … absolute path
string`, plus `no scenario was evaluated; this is not a verdict.` T5 asserts the *other* legitimate
tooling exit — `cannot resolve @erl2/… MODULE_NOT_FOUND` — so the assertion did not match.

Re-running the **unchanged** test with an absolute `--retain-fixtures` path, the form Wave 1's own
command log used, passes 12 of 12. No script or fixture was edited to obtain that result. The
comparator behaved correctly in both invocations: it refused, exited 3, and explicitly declined to
emit a verdict. This is recorded as a friction datum (absolute-path exposure; undocumented operator
prerequisite), not as a defect and not as a Wave 2 blocker.

## 4 · Coordinates

| Coordinate | Value | Status |
|---|---|---|
| Reality Lab campaign baseline | `87a87e535db6f74f95f6de5f14b4870d973b00d7` / tree `36c588658cf9abc9de01a6dbe4a8dc04cdf98e43` | `main` is exactly here; no advancement |
| Reality Lab dependency pin | `69ace16fb7ee021dddbcf3fa70e4295c2e5a400b` / tree `89988e5588b04534316c73901e34c56861caa494` | resolved, unchanged |
| Qualiber product coordinate | `d3ebf37fc2cd5741c25eac22eaa20777153730ce` / tree `0d2a8c4de0196972ef1ed8844b3746a4cfa5df3a` | pinned |

**Qualiber `preprod` has advanced** to `a3d05f01bccd9590add9b61ad643d4fa07f3ef74`, one commit ahead
(`docs(ev3): the host dry run passed; CR-133 filed and amended (6gl) (#382)`). The delta was
inspected read-only and touches **three documentation files only** —
`docs/HANDOFF.md`, `docs/process/critical-review-2026-07-20-remediation-tracker.md`,
`docs/process/validation.md`. A path filter excluding `docs/**` returns an **empty** change set:
product validation behavior, collector behavior, the adapter, manifests, build topology, contracts
and CLI behavior are byte-identical to the pin. The advancement is recorded; the campaign stays
pinned to `d3ebf37…`.

## 5 · Prospective NC-2 correction

Wave 1 observed that deleting `run-result.json` does not reach §10.5 rule 5, because the deletion
also breaks the adapter's `artifact_hashes` witness and the binding gate runs first. Wave 2
precommits that outcome **prospectively** rather than discovering it again:

* a missing `run-result.json` must produce `unavailable`;
* a binding-first classification of `lab_harness_failure` is **accepted** as correct;
* `clean` must **never** be observed as a value;
* binding precedence must **not** be weakened to make the classification match a table.

Rule 5 remains covered directly by tooling test T7, which passed.

## 6 · Prospective NC-5 procedure

Wave 1's first NC-5 attempt mutated nothing: the host writes retained inputs mode `0444`, the write
was refused, and both legs passed trivially — a control that did not run. Wave 2 precommits the
corrected procedure **in advance**:

1. make the disposable copy writable if needed;
2. mutate exactly one byte;
3. **verify the digest changed**, recording both the pre- and post-mutation digests;
4. only then run the verifier and comparator refusal legs.

A leg that passes without a proven byte change is recorded as an aborted attempt, never as a control
that held.

## 7 · Claim ceiling

Wave 2 is a **first-party dogfood** exercise against **subject zero**, run **trusted-local** and
**unconfined** over **synthetic** stimuli. It is not certification, not adoption evidence, and not a
T3 or T4 claim. Three scenarios exercising cardinality, payload-presence and payload-type
enforcement are **not** a broad product pass, and nothing here should be read as one. A product
disagreement, if any, remains a **candidate** finding until independently reviewed.
