# Reproduction instructions — Wave 3 control remediation candidate

## Prerequisites

- Node.js v20+ (tested with v26.4.0)
- Both immutable evidence roots present at their declared paths
- No repository access required (all inputs are local files)

## Reproduce test results

```bash
# 1. Verify candidate tooling digests
cd /private/tmp/qualiber-wave3-control-remediation-candidate
shasum -a 256 tooling/residue-scanner.mjs
# Expected: 53b8c3f5a482c10bfdfa810c7bb0695d6e2236412a146d96550c4a91cfecaa99

shasum -a 256 tooling/nc11r-fixture-builder.mjs
# Expected: 00e7abe80c208d95c9acfb33898be6bbf85d55028945b132344fab1cd125d81f

shasum -a 256 tooling/run-negative-control-v2.mjs
# Expected: 9edf808b40f4e52c352a7cbc8461d427ceb411dfbad515e2f4410dfa4695b415

shasum -a 256 tooling/tests/test-residue-scanner.mjs
# Expected: 89de30d80068398058b9e536aa2af1ff9b4339cc92df23574e69746eacac78a5
```

```bash
# 2. Run the test suite (33 tests: 6 unit + 4 mutation + 4 regression + 1 path-neutrality)
node tooling/tests/test-residue-scanner.mjs
# Expected: 33/33 passed, 0 failed
```

```bash
# 3. Run the NC-12R rehearsal against attempt 1 evidence
node tooling/run-negative-control-v2.mjs \
  --control NC-12R \
  --evidence-root /private/tmp/qualiber-wave3-execution-1787753088/evidence \
  --residue-scanner tooling/residue-scanner.mjs \
  --output-dir /tmp/nc12r-repro
# Expected: verdict=HELD, clean scan PASS, planted file identified
```

```bash
# 4. Path-neutrality: run tests from a different directory
cd /tmp
node /private/tmp/qualiber-wave3-control-remediation-candidate/tooling/tests/test-residue-scanner.mjs
# Expected: 33/33 passed (identical structural results)
```

## Verify preservation

```bash
# 5. Verify evidence roots are unchanged
cd /private/tmp/qualiber-wave3-completion-1787755899/evidence
find . -type f | wc -l
# Expected: 36

cd /private/tmp/qualiber-wave3-execution-1787753088/evidence
find . -type f | wc -l
# Expected: 315
```

## Verify deliverable manifest

```bash
# 6. Verify all deliverable digests
cd /private/tmp
shasum -c qualiber-wave3-control-remediation-sha256.txt
# Expected: all OK
```

## NC-11R fixture rehearsal (requires dependency anchor)

NC-11R full rehearsal requires the real `@erl2/contracts` and
`@erl2/integrity` packages resolved through a dependency anchor.
This cannot be reproduced without a Reality Lab checkout.

The fixture builder can be validated independently:

```bash
# Construct fixture from a disposable scenario copy
cp -r /private/tmp/qualiber-wave3-execution-1787753088/evidence/scenarios/QLB-EXT-012 /tmp/nc11r-fixture-input
node tooling/nc11r-fixture-builder.mjs \
  --scenario-root /tmp/nc11r-fixture-input \
  --output-dir /tmp/nc11r-fixture-output
# Verify: run_result_modified_status=inconclusive, binding_proofs non-empty
rm -rf /tmp/nc11r-fixture-input /tmp/nc11r-fixture-output
```

## What this reproduction does NOT cover

- Official negative control execution (prohibited by design)
- Campaign precommit or execution lock creation (prohibited)
- Repository or GitHub modifications (prohibited)
- Evidence publication (prohibited)
- NC-11R full comparator execution (requires dependency anchor)

## Immutable coordinates

| Coordinate | Value |
|---|---|
| Qualiber commit | `236282a667fa161ee16fd363e33559cfe7871ba0` |
| Qualiber tree | `e40e5028ef172590ce482debf18e5d99f6099971` |
| Reality Lab commit | `02de870ef593c2cbd8c517792072769867f33e46` |
| Reality Lab tree | `16e20fff5f09535ccb0014c4346258f34ec94ef6` |
| Adapter dependency | `69ace16fb7ee021dddbcf3fa70e4295c2e5a400b` |
| Comparator | `83223022f1522f4c22607f02123e02a0c5ff9cf92363aba0ec1e8a256010bcc4` |
