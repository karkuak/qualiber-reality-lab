# Ledger — the negative-control harness

The campaign in `scripts/negative-control.mjs` is this repository's instrument for
one question: *is this guard load-bearing?* Every claim in every remediation
ledger's negative-control section rests on it.

Until this package the instrument was itself unmeasured. This ledger is its
record: what it used to do, what it now proves, and what each campaign since has
found.

---

## 1. The defect: `String.replace` takes the first match and says nothing

Every control declares a `find` string and a `replace` string, and the campaign
applied them with

```js
writeFileSync(target, source.replace(control.find, control.replace));
```

`String.prototype.replace` with a **string** pattern replaces the first
occurrence only, and reports nothing about the others. So a control whose anchor
stopped being unique kept producing a number — for a measurement that had not
happened.

Three controls have died that way, and the pattern in how they were found is the
argument for fixing it structurally:

| control | how it died | how it was found |
|---|---|---|
| `invalid-finding-lab-attribution` | ADR-ERL2-028 replaced the branch it was anchored on, so from that package on the patch did not apply at all | the full campaign, packages later |
| `cutoff-milestone-resolution` | anchored around a `strictNullChecks` narrowing trap; the obvious patch stopped compiling | re-patched during its own package |
| `pre-dispatch-intent` | ADR-ERL2-028 inserted a **second** `this.advance(spec.operationId, "dispatching")` above the intended one, on the resume path. `String.replace` disabled the resume branch instead of the first-dispatch path | the full campaign at Step 5B, scoring 7 pass / 0 fail |

**Two of the three were found only by running the full set.** The focused subsets
run in between reported nothing, because a control that patches the wrong line
still builds, still runs, and still prints a pass/fail pair. `pre-dispatch-intent`
read as *a guard that is not load-bearing* — the most expensive possible way to be
wrong, because that reading invites deleting the guard.

A harness that can silently measure the wrong thing will eventually do so. The
lesson is the same one the worktree rewrite recorded about tree mutation: make the
property structural, not remembered.

---

## 2. What a control must now declare

`scripts/lib/controlTarget.mjs` is a pure module — no filesystem, no processes, no
git — that decides what a patch *would* do before anything is written.

| field | required | meaning |
|---|---|---|
| `id` | yes | control name |
| `what` | yes | the named invariant |
| `file` | yes | target file |
| `find` | yes | the exact preimage |
| `replace` | yes | the expected postimage (`""` deletes) |
| `tests` | yes | the suites expected to notice |
| `expect` | yes | `"fail"` or `"pass"` |
| `expectedMatches` | no — **defaults to exactly one** | how many occurrences the control means |
| `anchor` | no | a string occurring exactly once, after which `find` is searched |
| `mustFail` | no | a subset of `tests`; a failure outside it is not this control's kill |
| `uniquePostimage` | no | also require the postimage not to already occur elsewhere |
| `note` | no | why an `expect: "pass"` control is kept |

`validateControlDeclarations` checks the table before a worktree exists, so a
malformed control fails in the first second of a four-hour campaign rather than in
its last.

### 2.1 The default is the load-bearing part

`expectedMatches` defaults to **one**. A control that says nothing gets the
strictest rule, not the loosest — which is what turns a preimage that quietly
stopped being unique from a silent mis-patch into a failed campaign.

### 2.2 The sequence

1. count exact, non-overlapping occurrences of `find` (within the `anchor` window
   if one is declared — and the anchor must itself be unique, since an ambiguous
   anchor disambiguates nothing);
2. **zero matches** → `patch_not_applicable`, a harness error;
3. **any count other than `expectedMatches`** → `ambiguous_patch_target`, a
   harness error, in both directions;
4. splice right-to-left so earlier offsets stay valid;
5. confirm the postimage sits at each computed offset, byte for byte;
6. confirm every byte outside the spliced ranges is unchanged, by rebuilding the
   untouched segments from the patched text and comparing them with the source;
7. confirm the preimage survives in exactly the number of places the declaration
   accounts for;
8. write, **re-read from disk**, and confirm the bytes the compiler is about to
   read are the bytes that were planned;
9. build; then run the named suites;
10. restore with `git checkout -- .` and **prove** `git status --porcelain` is
    empty in the worktree;
11. release the worktree, and prove no temp directory and no registration remain;
12. prove the measured tree is byte-identical to how the campaign started.

### 2.3 Why the postimage check is positional and not a count

`post-capture-activation-requirement` replaces a four-line list with `];`, and
`];` occurs **ten times** in `packages/core/src/journey/prerequisites.ts`.

A "the postimage now appears" count proves nothing there. Worse, a "the postimage
appears exactly once more than before" identity is not even well-defined, because
that control's postimage *overlaps its own preimage* — the preimage ends in `];`
too.

So the total check is positional, and `uniquePostimage` is an opt-in
strengthening rather than the default. Defaulting it on would refuse a control
that is correct as written, which is the failure mode where a rule stops being
about the code and starts being about the rule.

---

## 3. Result classification

The distinction that matters is between a **behavioural kill** — the guard was
disabled and the named suite noticed — and everything else. All three used to
share one column.

| result | measured the guard? | meaning |
|---|---|---|
| `named_tests_failed` | yes | the kill; the guard is load-bearing |
| `no_kill_as_declared` | yes | an `expect: "pass"` control, agreeing |
| `tests_passed_unexpectedly` | yes | a control that expected a kill and got none |
| `patch_not_applicable` | **no** | the preimage is gone |
| `ambiguous_patch_target` | **no** | the preimage is not unique |
| `anchor_not_found` / `anchor_ambiguous` | **no** | the window cannot be established |
| `postimage_missing` | **no** | the bytes on disk are not the planned bytes |
| `postimage_unexpected_elsewhere` | **no** | the postimage is not distinctive enough to prove anything |
| `preimage_residue_unexpected` | **no** | the preimage survived in places the declaration does not account for |
| `splice_changed_unrelated_bytes` | **no** | the patch moved bytes outside its target |
| `control_declaration_invalid` | **no** | the control is malformed |
| `build_failure` | **no** | the patched tree does not compile |
| `test_runner_failed` | **no** | no parseable summary; never read as "nothing failed" |
| `unrelated_tests_failed` | **no** | a suite the control did not name failed |
| `restoration_failure` | **no** | the worktree could not be restored; the campaign stops |
| `residue_failure` | **no** | something survived the campaign |

Two rules follow, and both are asserted in
`tests/integration/negativeControlHarness.test.ts`:

- **A build failure is not a load-bearing behavioural kill.** It is a fact about
  the patch. The campaign has hit the `strictNullChecks` narrowing trap four
  times — deleting a guard usually deletes a type narrowing with it — and a
  patched tree that does not compile measures nothing.
- **A patch that modified the wrong location is not evidence.** Every targeting
  outcome other than `patch_applied` fails the campaign as a harness error and
  can never be scored as a passing or non-load-bearing control.

---

## 4. Restoration, signals and residue

`scripts/lib/disposableWorktree.mjs` is extracted from the campaign so the three
things that only happen when something goes wrong can be driven by a test against
a throwaway repository, rather than asserted by reading the code.

- **Restoration is verified, not assumed.** `git checkout -- .` restores from the
  object store and says nothing about whether it worked. The residual
  `git status --porcelain` is now read, and a non-empty one **stops the
  campaign** rather than letting every later control be measured against a tree
  still carrying this one's patch.
- **`SIGINT` and `SIGTERM` release the worktree**, then re-raise with the default
  disposition so the exit status stays the signal's own. The independent review
  found this by killing a campaign by hand ("Review-process defect (P3)"); a
  property discovered that way should not stay discoverable only that way.
- **Residue is enumerated**: the temp directory must be gone and `git worktree
  list` must no longer name the worktree.
- `SIGKILL` remains uncatchable by construction. The next campaign still starts
  cleanly, because `worktree add` into a fresh `mkdtemp` path never collides and
  `release`'s `prune` removes the stale registration.

---

## 5. The tests

`tests/integration/negativeControlHarness.test.ts` — 26 cases:

unique match applies and lands where planned · zero matches refuses · two matches
refuse under the default · **the regression**: two identical anchors where the
intended occurrence is the second, `String.replace` shown taking the first, the
hardened harness refusing, and the `anchor` form landing on the second · an
explicit expected count replaces every declared occurrence · a count the source
does not satisfy refuses in both directions · an ambiguous anchor refuses · a
missing anchor refuses · a postimage that reintroduces its own preimage is
accounted rather than refused · an empty postimage deletes · a postimage already
present elsewhere refuses only when uniqueness is declared · a no-op patch is
malformed · an empty preimage names no target · the bytes on disk are re-read and
checked · classification: named kill, no-kill, unexpected pass, stray suite,
unparseable run, and every targeting outcome barred from being scored as a kill ·
declaration validation, positive and negative · tree-digest certification refuses
on both a digest change and a status change · restoration after a mutation, with
residue proven · `SIGINT` release · `SIGTERM` release.

`tests/architecture/negativeControlTargeting.test.ts` — 4 cases: the harness never
mutates the source under test with `String.replace`; every patch goes through
`planControlPatch` and is confirmed by `verifyPatchOnDisk`, with exactly one write
site; the targeting module imports nothing and is pure; the expected match count
defaults to one.

### 5.1 The case that earns its place

**`NC-CAMPAIGN: every shipped control still targets exactly what it declares`**
runs the hardened targeting over every control against the real source tree, on
every `npm test`.

That is the whole point. The failure mode that killed three controls — a later
package inserting similar text above an anchor — now surfaces in seconds, in the
ordinary suite, instead of in a four-hour campaign nobody runs between packages.
A companion case asserts that every suite a control names still exists.

---

## 6. What hardening did *not* change

Measured before any code was written, over all 72 inherited controls against
`bf75926`: **every control matched exactly once.** Zero ambiguous, zero missing.

`pre-dispatch-intent` had already been re-anchored at `77c519c`, and the other two
repairs held. So the hardening changes **no control's result**; it converts a
property that happened to hold into one that is enforced.

That is worth stating plainly, because the alternative reading — that hardening
found and fixed live defects — would be false. What it buys is that the next time
a package edits above an anchor, the campaign says so instead of printing a
number.

One control needed no change but did settle the design:
`post-capture-activation-requirement`'s postimage is `];`, which is why §2.3 is
positional.

---

## 7. Campaign results

*(one row per campaign; see each package's remediation ledger for the per-control
table)*

| campaign | HEAD | controls | agreed | harness errors | tree restored | residue |
|---|---|---|---|---|---|---|
| Step 5B (pre-hardening) | `723935f` | 72 | 72 | — (not distinguished) | yes | none |
| **harness hardening** | **`6985297`** | **72** | **72** | **0** | yes | none |

### 7.1 The hardening campaign, in full

Run against the committed candidate `6985297`, 17:01 → 19:23 (2 h 22 m). **72 of
72 scored, 72 agreed, 0 disagreed, 0 harness errors.**

By classification:

| result | count |
|---|---|
| `named_tests_failed` (behavioural kill) | **70** |
| `no_kill_as_declared` (the two recorded `expect: "pass"`) | 2 |
| every harness-error class | **0** |

Zero is the number that matters in the second column. No control reported
`ambiguous_patch_target`, `patch_not_applicable`, `postimage_missing`,
`build_failure`, `test_runner_failed`, `unrelated_tests_failed` or
`restoration_failure`. Every patch was proven to land on its declared target
before its suite ran.

**Every one of the 72 reproduces its Step 5B pass/fail pair exactly** — checked
mechanically against §10.1 and §10.2 of
[`remediation-6.5-signer-inventory.md`](remediation-6.5-signer-inventory.md), all
72 rows, no drift.

That is the result this package predicted in §6 and it is the honest one to
report: hardening found no live defect, because there was none left to find. What
it changed is that the property is now enforced rather than remembered.

Two rows are worth reading twice:

- **`pre-dispatch-intent` at 3 pass / 4 fail.** Before its repair at `77c519c` it
  scored 7/0 — a control that had been measuring nothing since ADR-ERL2-028. It is
  load-bearing, the repair held, and it is now the case
  `NC-TARGET-REGRESSION` reproduces in miniature.
- **`invalid-finding-lab-attribution` at 18 pass / 2 fail**, so the repair one
  package earlier also held. Two controls that had both silently expired are both
  alive, and the mechanism that let them expire is now a campaign failure rather
  than a number.

### 7.2 Residue

`the working tree is byte-identical to how the campaign started`. Afterwards:
`git worktree list` shows only the repository; no `erl2-negative-control-*` temp
directory remains; no `node --test` or harness process survives; `git status
--short` is empty and `git diff --check` is clean.
