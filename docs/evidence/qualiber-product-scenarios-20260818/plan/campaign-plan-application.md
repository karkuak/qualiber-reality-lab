# How revision 4.3 of the test plan applies to this campaign

**Campaign:** `qualiber-product-scenarios-20260818`
**Reviewed plan:** `qualiber-product-external-scenario-test-plan.md`, **Revision 4.3**, sha256
`b1105dc7209cd8fcd32f10064ced6a4634c44b50faa582491376a37c9d019092` — verified before this note was
written and again when the plan was copied into this bundle.

## 1 · The plan was written before the product integration merged

Revision 4.3 is dated 2026-08-17 and was written while the Qualiber validation adapter was still an
*intake* — a thing to be built. Its §19 sequence therefore contains implementation steps (3 through
8: the `contractBytes` seam, the stimulus parser, the validation adapter, the build scripts, the plan
generator, the docs) and §21 instructs an implementation agent to build a second Qualiber-owned
subject adapter.

**None of that applies here, because all of it is already merged.** Qualiber integrated the
validation adapter as PR #379, squash-merged at `a4c6e2b5a7164ae52af8d855bb256dd927b26867`, and
`preprod` has since advanced to `d3ebf37fc2cd5741c25eac22eaa20777153730ce`. This campaign changes no
Qualiber product code, no Qualiber test, no manifest, no documentation and no build configuration.
It is an evidence-generation and product-testing exercise, not an implementation exercise.

## 2 · This run applies the plan **prospectively**, to the merged coordinate

The plan's expectations were fixed against a product that had not yet been built. This campaign
applies them, unchanged, to the merged product at `d3ebf37…`. That is the strongest form the
plan's central property can take: the expectations were authored before the product existed in the
form being tested, and they are being applied without a single edit made in the product's favour.

**Scenario meanings and expectations are unchanged.** Every `expected.json` in this bundle is
derived from §8 of revision 4.3 and from `C-VALID`'s own semantics — never from any observed
Qualiber output, and never from a Qualiber fixture. In particular:

- QLB-EXT-002's allowlist is **empty** and its bound is **1**, per the revision-3 correction.
- QLB-EXT-003's target event is **`quote_requested_three`**, derived from the two predecessor
  ordering constraints a three-state `expected_path` yields, per the revision-4 correction.
- QLB-EXT-005 expects record `state: "completed"` with `response_status: "failed"` — never
  `state: "failed"` — and reads `SUBJECT_PRODUCT_CLI_REFUSED` from a four-step hash-bound response
  envelope.

## 3 · Coordinates: what moved since the plan was written, and why it does not matter

| | plan revision 4.3 named | this campaign binds | delta |
|---|---|---|---|
| Qualiber `origin/preprod` | `b07746e…` / tree `b9a7c66f…` | `d3ebf37fc2cd5741c25eac22eaa20777153730ce` / tree `0d2a8c4de0196972ef1ed8844b3746a4cfa5df3a` | advanced |
| Reality Lab `origin/main` | `69ace16…` / tree `89988e55…` | campaign baseline `3d2655f67ad14c16dd6148e4654cc0fa872cb4a4` / tree `74c633fb5546085de055abb92095442e375a03c4`; dependency pin remains `69ace16fb7ee021dddbcf3fa70e4295c2e5a400b` / tree `89988e5588b04534316c73901e34c56861caa494` | advanced |

Both advancements were inspected read-only before any execution:

- **Qualiber `a4c6e2b…` → `d3ebf37…`** touches exactly three paths, all documentation:
  `docs/process/erl2-validation-adapter-handoff-DRAFT.md` → `docs/process/erl2-validation-adapter-handoff.md`
  (rename), `docs/process/intake-response-validation-adapter.md` (new), and `docs/process/validation.md`.
  `adapters/erl2-subject/**` is **untouched** by the delta, and `a4c6e2b…` is an ancestor of
  `d3ebf37…`. No adapter, collector, package, build, manifest, trusted-local, contract, schema or CI
  behaviour changed.
- **Reality Lab `69ace16…` → `3d2655f…`** adds only `docs/evidence/qualiber-trusted-local-product-run-20260816/**`.
  No file outside `docs/evidence/` changed, so the three Lab packages at the campaign baseline are
  byte-identical to those at the pinned dependency commit.

Both are documentation- or evidence-only advancement. Recorded, and the campaign continues against
the pinned coordinates, per the plan's step-0 instruction to re-review rather than to stop.

## 4 · The paused 2026-08-17 campaign is excluded from this evidence

A Wave 1 campaign was started on 2026-08-17 and paused. Its worktree and its untracked evidence
directory `docs/evidence/qualiber-product-scenarios-20260817/` were **not used and not modified** by
this campaign; their opening state is recorded in `coordinates/` and re-checked at close.

**No artifact, record, expectation, lock, comparison or verdict from that campaign was copied into
this one.** Every stimulus, contract, expectation, counterfactual, tooling script, observation,
comparison and negative-control result here was authored or produced fresh. The paused campaign may
be read as historical diagnostic material; it is not evidence for this one, and nothing here cites it.

The retained, **committed** Lab bundle `docs/evidence/qualiber-trusted-local-product-run-20260816/`
was read during tool authoring to learn the *shape* of an observation record, a `.frozen` sidecar and
a response envelope. It is not campaign evidence either, no comparison was run against it, and the
plan's §19 step 9 prohibition on rehearsing the comparator against it was observed: it predates every
binding this comparator requires and the gate would refuse it.

## 5 · Recorded deviations from the literal text of revision 4.3

Stated here rather than left for a reader to discover.

1. **Implementation steps §19.3–§19.8 were not performed.** They are already merged. See §1.
2. **No feasibility spike (§19 step 2) was run.** The spike existed to de-risk an unbuilt adapter
   against a plan that could still amend a stimulus. The adapter is merged and its own test suite
   covers it; running Qualiber against campaign stimuli before the first official scenario would add
   an unrecorded execution without adding evidence. The consequence is accepted and stated: no
   stimulus amendment opportunity was taken, and no `stimulus_did_not_express_condition` amendment
   exists. `amendments` is empty in both commitment files.
3. **Build command names differ from the plan's.** The plan named
   `build:artifact:validation` / `build:manifest:validation`. The merged product deliberately has no
   per-artifact build scripts — `scripts/artifact-identity.mjs` declares both artifacts and one
   build path covers them, which Qualiber records as the fix for its issue #372. This campaign
   therefore uses the product's own documented command, `npm run test:adapters`, exactly as
   `docs/process/erl2-validation-adapter-handoff.md` §3 specifies.
4. **A fourth task-local script exists: `run-offline-verification.mjs`.** The plan names three
   scripts and binds three tooling digests. The Lab's offline verifier is exported from `@erl2/core`,
   which is neither of the comparator's two permitted imports and is not one of the adapter's three
   provisioned peers, so it cannot be reached through the comparator's dependency anchor — and §10.6
   requires the comparator to recompute the envelope core hash itself rather than delegate to it.
   The runner is therefore separate, is retained in `campaign/`, and its digest is bound in
   `oracle-precommit.json` under its own field, `campaign_local_verification_runner`, deliberately
   **outside** the three-script `tooling` block so that block still means exactly what the plan says
   it means. This follows the same retained-but-never-promoted precedent as `task-local-verify.mjs`
   in the 2026-08-16 bundle. It adds no assurance machinery: it calls one Lab function and records
   what that function returned.

No deviation changes a scenario meaning, an expectation, a bound, a classification or a verdict.
