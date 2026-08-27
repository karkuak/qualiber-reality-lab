# IRD-001 Disposition — NC-11R retained-output binding

**Status: CONFIRMED as a real builder defect — but the original diagnosis inspected the wrong record layer. Corrected in candidate v2.**

## 1. What IRD-001 claimed

The v1 independent review inspected QLB-EXT-012's top-level observation result and found:

```
result.retained_output_refs = []
```

and concluded that `nc11r-fixture-builder.mjs` "might silently skip the retained-output binding update," leaving Gate 1 unverified.

## 2. What the comparator actually binds

The comparator (`compare-scenario.mjs`, digest `83223022…`) never reads
`record.result.retained_output_refs`. Its primary artifact binding is:

```js
function findInteractCompletedRecord(record) {           // line 208
  return (record.operation_records ?? []).find(
    (r) => r.operation === "interact" && r.state === "completed") ?? null;
}
...
const opRecord = findInteractCompletedRecord(record);     // line 420
for (const r of opRecord.retained_output_refs ?? []) refs.set(r.path, r);   // line 469
const bindArtifact = (absPath) => { ... refs.get(logical) ... };            // line 473
```

For QLB-EXT-012 the `interact`/`completed` operation record is
`operation_records[2]` (`operation_id = interact-validate-stimulus`) and it
carries **11 populated `retained_output_refs`**, `run-result.json` among them
(`sha256:3d496e9b…`). The empty top-level `result.retained_output_refs` is
**never consulted by the comparator**.

**Therefore IRD-001's premise is inverted:** the review flagged an empty array
that the comparator does not read. The genuine binding target — the operation
record — is fully populated and QLB-EXT-012 *can* support complete binding.

## 3. Why the v1 builder was nonetheless defective (a worse defect than named)

1. `findRunResult` only checked `run-output/product-out/run-result.json` and
   `qualiber/product-out/run-result.json`. The real path is
   `run-output/store/local-observation-output/interact-validate-stimulus/qualiber/product-out/run-result.json`.
   Pointed at a real QLB-EXT-012 tree the v1 builder **exits 3 before doing
   anything** (empirically reproduced).
2. `updateRefs` was called only on `obs.retained_output_refs` (absent at top
   level) and `obs.result.retained_output_refs` (the empty array) — **never on
   `obs.operation_records[].retained_output_refs`**, the real binding source.
3. Its match predicate compared a **bare** hex digest against the record's
   `sha256:`-**prefixed** `file_sha256`, and keyed on `logical_path` where the
   refs use `path`. Both mismatches would prevent any match even if reached.
4. It never re-bound `run-summary.json` after editing its `artifact_hashes`,
   so the cascade would leave run-summary's own operation-record ref mismatched.

**Consequence (proven empirically):** a run-result mutated without updating the
operation-record ref fails `bindArtifact` →
`record_retained_output_refs_mismatched.length > 0` → `bound = false` at the
rule-7 gate (lines 609–619) → the comparator returns `unavailable`/
`lab_harness_failure` and **never reaches rule 6**. NC-11R could not have
demonstrated forbidden-status precedence. (A naive run-result-only mutation was
run through the real comparator and returned `unavailable`.)

## 4. The correction (candidate v2)

`nc11r-fixture-builder.mjs` v2 locates every file from the record's own refs and
binds **every layer the comparator reads**, each **exactly once, fail-closed**:

| Layer | Comparator role | v2 action |
|---|---|---|
| `run-result.json` content | run-status source | mutated → `inconclusive` |
| `operation_records[interact/completed].retained_output_refs[run-result]` | **PRIMARY** (`bound` gate) | updated ×1 (0 or >1 ⇒ hard fail) |
| `run-summary.json artifact_hashes[run-result]` | **SECONDARY** (`bound` gate) | updated ×1 |
| `operation_records[…].retained_output_refs[run-summary]` | PRIMARY (cascade) | updated ×1 |
| `run-result.json.frozen` | weak local check | updated ×1 |
| `run-summary.json.frozen` | — | **inapplicable** (comparator only walks product-out sidecars) |
| top-level `result.retained_output_refs` | **not read** | intentionally untouched |

The record's `core_hash` is intentionally **not** recomputed: the comparator
applies `coreHash` only to the response envelope, never to the record, and the
record file is not itself a bound artifact under `run-output/store`.

## 5. End-to-end proof (real comparator, real bytes)

| Scenario | expected | forbidden | verdict | bound | sub_reasons |
|---|---|---|---|---|---|
| POSITIVE-BOUND-CONTROL | inconclusive | — | **agree** | true | `[]` |
| FORBIDDEN-PRECEDENCE (NC-11R) | inconclusive | `[inconclusive]` | **disagree / product_disagreement** | true | `[forbidden_run_status_observed]` |
| MUTATION-NO-FORBIDDEN | inconclusive | — | **agree** | true | `[]` |
| precedence branch disabled | inconclusive | `[inconclusive]` | agree | true | `[]` (property correctly red) |

`run_status_mismatch` is never the cause: expected == observed == inconclusive
throughout, so the disagree comes solely from the forbidden branch; removing the
forbidden list flips it to `agree`.

**Disposition: the builder now updates the actual operation-record reference,
requires exactly one matching primary ref, fails closed on zero or multiple, and
updates every other authoritative witness. Regression tests added. QLB-EXT-012
is retained; complete binding is proven.**
