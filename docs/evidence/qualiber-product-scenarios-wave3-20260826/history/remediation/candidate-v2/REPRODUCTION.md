# REPRODUCTION — control-remediation-candidate-v2 (IRD-001)

All steps operate on **copies** in a fresh scratch root. They never touch the
immutable evidence roots, any repository, or GitHub. Node ≥ 20 (validated on
v26.4.0).

## 0. Real inputs (verify digests first)

| Input | Digest / location |
|---|---|
| Comparator `compare-scenario.mjs` | `83223022f1522f4c22607f02123e02a0c5ff9cf92363aba0ec1e8a256010bcc4` (in `qualiber-wave3-comparator-candidate/`) |
| Real `@erl2` anchor | `qualiber-wave3-comparator-freeze-readiness-1787714909978-15540/pkg-src/real-anchor/package.json` — `@erl2/contracts` entry `da45bec0…`, `@erl2/integrity` entry `c927d02c…` |
| Base scenario | `qualiber-wave3-execution-1787753088/evidence/scenarios/QLB-EXT-012` |
| Campaign oracle | same evidence root: `oracle-precommit.json`, `execution-lock.json`, `campaign-index.json`, `expectations/` |

## 1. Assemble copies

```bash
ROOT=/private/tmp/qualiber-wave3-ird001-repro-$$
SRC=/private/tmp/qualiber-wave3-execution-1787753088/evidence
ANCHOR_SRC=/private/tmp/qualiber-wave3-comparator-freeze-readiness-1787714909978-15540/pkg-src/real-anchor
mkdir -p "$ROOT"/{comparator,anchor,evidence-copy/scenarios,work}
cp -R /private/tmp/qualiber-wave3-comparator-candidate/. "$ROOT/comparator/"
cp -R "$ANCHOR_SRC/." "$ROOT/anchor/"
cp "$SRC"/{oracle-precommit.json,execution-lock.json,campaign-index.json} "$ROOT/evidence-copy/"
cp -R "$SRC/expectations" "$ROOT/evidence-copy/"
cp -R "$SRC/scenarios/QLB-EXT-012" "$ROOT/evidence-copy/scenarios/"
```

## 2. Reproduce the original QLB-EXT-012 verdict (invocation sanity)

```bash
node "$ROOT/comparator/compare-scenario.mjs" --scenario QLB-EXT-012 \
  --scenario-root "$ROOT/evidence-copy/scenarios/QLB-EXT-012" \
  --expected "$ROOT/evidence-copy/expectations/QLB-EXT-012.expected.json" \
  --oracle-precommit "$ROOT/evidence-copy/oracle-precommit.json" \
  --execution-lock "$ROOT/evidence-copy/execution-lock.json" \
  --campaign-index "$ROOT/evidence-copy/campaign-index.json" \
  --dependency-anchor "$ROOT/anchor/package.json" --output "$ROOT/work/baseline.json"
# => agree / product_agreement, binding.bound=true, observed.run_status=clean
```

## 3. Build the NC-11R fixture (v2 builder) and run NC-11R

```bash
V2=/private/tmp/qualiber-wave3-control-remediation-candidate-v2
DISP="$ROOT/work/disp"; FIX="$ROOT/work/fixture"
cp -R "$ROOT/evidence-copy/scenarios/QLB-EXT-012/." "$DISP/"; chmod -R u+w "$DISP"
node "$V2/tooling/nc11r-fixture-builder.mjs" --scenario-root "$DISP" \
  --output-dir "$FIX" --execution-lock "$ROOT/evidence-copy/execution-lock.json"

node "$V2/tooling/run-negative-control-v2.mjs" --control NC-11R \
  --fixture-dir "$FIX" --evidence-root "$DISP" \
  --comparator "$ROOT/comparator/compare-scenario.mjs" \
  --dependency-anchor "$ROOT/anchor/package.json" --output-dir "$ROOT/work/nc11r-out"
# => verdict "disagree/product_disagreement", exit 0,
#    observed_sub_reasons ["forbidden_run_status_observed"]
```

## 4. Run the focused suites

```bash
export NC11R_COMPARATOR="$ROOT/comparator/compare-scenario.mjs" \
       NC11R_ANCHOR="$ROOT/anchor/package.json" \
       NC11R_SCENARIO_SRC="$ROOT/evidence-copy/scenarios/QLB-EXT-012" \
       NC11R_EXECUTION_LOCK="$ROOT/evidence-copy/execution-lock.json" \
       NC11R_BUILDER="$V2/tooling/nc11r-fixture-builder.mjs" \
       NC11R_WORK_A="$ROOT/work/tA/deep" NC11R_WORK_B="$ROOT/work/tB"
node "$V2/tooling/tests/test-nc11r-binding.mjs"      # 18/18
node "$V2/tooling/tests/test-residue-scanner.mjs"    # 33/33
```

## 5. NC-12R

```bash
# evidence-copy must contain scenarios/QLB-EXT-009 (copy it in from $SRC)
node "$V2/tooling/run-negative-control-v2.mjs" --control NC-12R \
  --evidence-root "$ROOT/evidence-copy" \
  --residue-scanner "$V2/tooling/residue-scanner.mjs" --output-dir "$ROOT/work/nc12r-out"
# => verdict HELD, exit 0
```

## Tooling digests (v2)

See `digest-mode-inventory.json`. `residue-scanner.mjs` (`53b8c3f5…`) and
`test-residue-scanner.mjs` (`89de30d8…`) are **byte-identical to v1** (NC-12R was
already confirmed and is preserved unchanged). `nc11r-fixture-builder.mjs`,
`run-negative-control-v2.mjs`, and `test-nc11r-binding.mjs` are the v2 changes.
