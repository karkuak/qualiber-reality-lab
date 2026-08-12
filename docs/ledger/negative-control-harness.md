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
| `mustFailCases` | no | the exact case names that must be among the failures |
| `requiresPrerequisite` | no | a host input the control needs — `otel-demo-upstream` or `docker-daemon`; see §8 |
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
| `unmeasured_here` | **neither** | the control declared a prerequisite this host cannot supply, and the designated case skipped itself; see §8 |
| `designated_case_skipped` | **no** | a designated case skipped with no prerequisite declared — fail-closed, because nobody said it might |
| `patch_not_applicable` | **no** | the preimage is gone |
| `ambiguous_patch_target` | **no** | the preimage is not unique |
| `anchor_not_found` / `anchor_ambiguous` | **no** | the window cannot be established |
| `postimage_missing` | **no** | the bytes on disk are not the planned bytes |
| `postimage_unexpected_elsewhere` | **no** | the postimage is not distinctive enough to prove anything |
| `preimage_residue_unexpected` | **no** | the preimage survived in places the declaration does not account for |
| `splice_changed_unrelated_bytes` | **no** | the patch moved bytes outside its target |
| `control_declaration_invalid` | **no** | the control is malformed |
| `build_failure` | **no** | the patched tree does not compile |
| `test_runner_failed` | **no** | no parseable summary, **or a summary with no outcomes**; never read as "nothing failed" |
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

### 3.1 Two defects the Step 6A campaign found, both in controls

Recorded because they are the two shapes a hardened harness still cannot catch by
targeting alone — the patch applied to exactly the right bytes in both cases.

**A patch that changes nothing.** `window-producer-uses-frozen-commitment`
substituted `2_000` / `4_000` for the frozen commitment's durations. Both are
inside the policy bounds and the patch landed exactly where declared — but
`2 000 + 4 000` is `1 000 + 5 000`, so the derived cutoff instant was
byte-identical and the run was unchanged. It scored **29 pass / 0 fail** against
an `expect: "fail"` and read as a guard that is not load-bearing.

Unique targeting cannot see this: the bytes changed, the meaning did not. What
catches it is the campaign, and what fixes it is choosing constants that move the
value the guard protects — `2_000` / `3_000`.

**A patch that crashes instead of refusing.**
`window-verifier-requires-commitment` disabled `retained.length === 0`, which left
`retained[0]` undefined; the CLI died on a TypeError rather than refusing, every
case in the suite was **cancelled**, and the summary read `0 pass / 0 fail` — which
the classifier scored as `tests_passed_unexpectedly`.

That was a real gap and it is now closed: a summary reporting tests but no
outcomes, or any cancellation, is `test_runner_failed`. A control that disables a
guard and crashes the process has not shown the guard is unnecessary; it has shown
the patch was wrong. The control was also re-pointed at the rule that actually
fires on a missing commitment — the conditional role check in
`deriveEnvironmentSemantics` — rather than at a refusal sitting behind it.

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

### 4.1 The cleanup discipline applies to the test that checks cleanup

The first version of `releasesOnSignal` hung the **entire suite for seven hours**,
and the bug was in the test, not in the harness. Driven directly,
`installSignalHandlers` fires, releases the worktree and exits cleanly every time
— reproduced in isolation before anything was changed.

What the test got wrong is the discipline this file exists to check. `spawn` with
piped stdio keeps the *parent's* event loop alive until the child exits, and the
driver child holds itself open with a `setInterval`. Every assertion before
`child.kill()` was therefore a path on which the child was never killed: the
parent could not exit, `node --test` waited on a file that would never finish, and
`--test-timeout=0` meant nothing rescued it.

The trigger was ordinary. Under the full suite, thirty test processes run
concurrently and `git worktree add` is slow; the marker did not appear inside the
poll window, the `assert.ok` threw, and the child outlived the run. In isolation
it had always passed.

Now: the child is killed in a `finally` on every path, its streams are destroyed,
and the wait for its exit is bounded and asserted. **A test that cannot prove
cleanup must fail, never hang** — the same rule the campaign applies to itself,
applied one layer out.

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
| **Step 6A** | **`c4e809c`** | **86** | **86** | **0** | yes | none |

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

## 8. Declared prerequisites, and the third column they need

Added by the validation-harness closure that answers the independent review of
`90a0039` ([`docs/evidence/independent-review-90a0039/`](../evidence/independent-review-90a0039/README.md)).

### 8.1 The defect: one control spent a full campaign being a false disagreement

The campaign at `90a0039` discovered 129 controls, agreed 128, and reported one
disagreement: `substrate-loopback-only-rendered`, recorded as
`tests_passed_unexpectedly`, `harnessError: false`, `replacedCount: 1`, 28 pass /
0 fail.

It was not a disagreement. Two independent defects produced it, and the review
proved both.

**The fixture was never in the worktree.** Controls are applied to a `git
worktree` checked out at HEAD, and a worktree carries tracked files only.
`environments/otel-demo/upstream/` is git-ignored — it is a 3 MB third-party
release archive and its extraction — so it is absent from every campaign
worktree that has ever run. The designated case, `COMPOSE-ADV: the RENDERED
configuration publishes one loopback port and nothing else`, renders the real
merged Compose configuration and skips itself, announcing `RENDERED TOPOLOGY
UNPROVEN`, when that extraction is missing. It did exactly what it says it does.

The review's four-cell matrix settled what that meant:

| revision | fixture | designated case | classification |
|---|---|---|---|
| `e9718e0` | absent | skipped | `tests_passed_unexpectedly` → disagreed |
| `90a0039` | absent | skipped | `tests_passed_unexpectedly` → disagreed |
| `e9718e0` | provisioned | ran | baseline passes, mutation fails → agreed |
| `90a0039` | provisioned | ran | baseline passes, mutation fails → agreed |

Identical at both revisions, so **not a receipt-admission regression**; and fully
load-bearing once provisioned — the unmodified baseline passes, the mutated
overlay fails the intended loopback assertion, and reverting restores the pass.

**The classifier could not say "not measured".** It parsed `tests`, `pass`,
`fail` and `cancelled`, and never `skipped`. With the designated case skipped and
the other 28 passing, it reached `fail === 0` and — for an `expect: "fail"`
control — returned `tests_passed_unexpectedly`. Worse, that short-circuit sits
*above* the `mustFailCases` check written to catch precisely "the declared case
did not fail", so the one mechanism that could have noticed never ran.

### 8.2 Provisioning: the pin decides, not the directory

`scripts/lib/campaignFixtures.mjs` provisions the fixture once per worktree, for
the controls that declare it.

The rule it exists to enforce is that the prerequisite can never be satisfied by
bytes nobody verified:

- the digest is **read** from the repository's own committed
  `environments/otel-demo/qualification/provenance.json`, not restated, so a
  re-pin cannot leave the campaign provisioning the previous release;
- the extraction directory is **derived** from that digest
  (`extracted-<first 16 hex>`), which is the same derivation
  `qualify-otel-demo.mjs` performs and the exact directory
  `composeSubstrate.test.ts` reads;
- only the qualifier's own three config paths are extracted;
- a pre-existing extraction is reused **only when complete**, and re-made from
  the verified archive when not — a half-extracted root is the case a bare
  `existsSync` would pass and `docker compose config` would then fail inside,
  where it looks like a substrate fault;
- a canonical ignored directory is **never copied**. Extraction is always from an
  archive that matched the pin;
- fetching is opt-in through `ERL2_CAMPAIGN_ALLOW_FETCH=1`. Absent that, a
  missing archive is an unavailable prerequisite, not a silent download of
  whatever the URL serves today.

Provisioned state lives inside the worktree, so `release()` removes it with
everything else, and the destination is git-ignored, so `restore()`'s `git status
--porcelain` cannot see it and the byte-identical-tree certification is
unaffected.

Two prerequisites exist, deliberately. `otel-demo-upstream` is *provisioned* —
the campaign can make it true. `docker-daemon` is only *detected*; nothing the
campaign does conjures a daemon, and pretending otherwise would turn a host fact
into a harness failure. `container-deadline-kills-the-container` has carried a
note since it was written asking readers to read its no-daemon result as
UNMEASURED HERE by hand; it now declares the prerequisite and the harness says it.

### 8.3 Why a skip needs its own column

A skip is neither a result nor a fault, and both existing columns lie about it.
Scoring it as a result claims the campaign learned something about a guard it
never ran. Scoring it as a harness error claims something broke when the only
fact is that this host is not the host.

| condition | result | agreement |
|---|---|---|
| designated case skipped, prerequisite **declared** | `unmeasured_here` | neither — `agreed: null` |
| designated case skipped, **no** prerequisite declared | `designated_case_skipped` | harness error |
| designated case failed | `named_tests_failed` | agreement |
| nothing skipped, nothing failed, kill expected | `tests_passed_unexpectedly` | disagreement |

The asymmetry is the point. A declared prerequisite is a claim made in advance
and reviewable; an undeclared skip is a designated case that vanished with nobody
having said it might, and that stays fail-closed. A typo in
`requiresPrerequisite` would otherwise buy a control a permanent, silent
`unmeasured_here`, so the name is validated against the registry before any
worktree exists.

The campaign summary now reconciles **discovered = agreements + disagreements +
unmeasured + harness errors** and refuses to finish if they do not add up. The
zero-disagreement rule is untouched: an unmeasured control is not an acceptable
disagreement, it is an absent measurement, and the summary says so in its own
section rather than folding it into a total.

Sixteen table-driven cases in `tests/integration/negativeControlHarness.test.ts`
pin the truth table, including the exact recorded defect (28 pass / 0 fail with
the designated case skipped), the undeclared variant, cancellation, truncated
output, multiple skips where the designated case still failed, and both
`container-deadline-kills-the-container` hosts. One control asserts the single
property the whole correction exists to guarantee: **a skipped designated case is
never an agreement, under any declaration.**

### 8.4 Targeted reproduction

Run through the real campaign path, one control, before any full campaign.

| fixture | outcome |
|---|---|
| available | `· prerequisite otel-demo-upstream: satisfied (provisioned …/extracted-1bf3ef8fbaffc049, archive sha256:1bf3ef8f…c051c)`; **28 pass / 1 fail**, `named_tests_failed`, **agreed**; accounting `1 = 1 + 0 + 0 + 0` |
| unavailable | prerequisite refused with the reason and no fallback; **not patched, not built, not run**; `unmeasured_here`; accounting `1 = 0 + 0 + 1 + 0` |

Both left the working tree byte-identical, no worktree registered, and no temp
root behind.

### 8.5 The campaign this closure gated

Run once, at `3392b8ec28cc6168292f421f0ae54e667b32bf22`, tree
`6aac61b9a6d89c25b8054f8ec0518eb0e69838ad`, on a clean worktree, immediately
after the exact-head clean gate passed at that same tree.

**Clean gate.** 1,246 tests, 1,244 passed, 0 failed, 0 cancelled, 2
Docker-gated skips, 1,056 s. The total is the previous 1,209 plus the 37
controls this closure adds. `verify:generated` current; `evidence:verify` 838
pinned / 7 excluded with no drift; `git diff --check` clean.

The previous package's gate was recorded by the independent review as
implementer-reported, because no durable log of it existed. This one was
captured to a log as it ran, which is the whole of the change: the numbers above
are read from that log rather than remembered.

**Campaign.**

| | |
|---|---|
| discovered | **129** |
| measured agreements | **129** |
| disagreements | **0** |
| unmeasured | **0** |
| harness errors | **0** |
| duration | 11,346 s (3 h 09 m 06 s) |
| output truncation | none |
| working tree afterwards | byte-identical |
| residue | none — no worktree, temp root, container, network, volume or surviving process |

`accounting: 129 discovered = 129 agreed + 0 disagreed + 0 unmeasured + 0
harness error(s)`, and `reconciled: true` in
`docs/ledger/negative-controls.json`.

Three rows are the point of this package:

- **`substrate-loopback-only-rendered`: 28 pass / 1 fail, `named_tests_failed`,
  agreed.** The same control, the same mutation, `replacedCount: 1` — and the
  designated case now *runs*. Its previous 28 pass / **0** fail was the skip.
- **`container-deadline-kills-the-container`: 0 pass / 2 fail, agreed**, with
  `docker-daemon` satisfied. Its declared prerequisite changes nothing on a host
  that has a daemon; it changes what gets reported on a host that does not.
- **`adapter-mode-binding`: 7 pass / 2 fail, agreed** — the LIVE-001 red control,
  unaffected by any of this.

This is the first campaign to reach 129/129. The previous one reached 128/129
with a disagreement that was never a disagreement.

**A note on runtime, deliberately not acted on here.** 3 h 09 m is within the
documented bound and close to the previous 3 h 16 m; per-control build and suite
time sums to ~189 minutes, so the campaign is very nearly all measurement. Making
it faster — a shared build, or parallel controls over several worktrees — is a
real opportunity and a separate one. It is recorded here as a follow-up rather
than folded into a correctness fix, because a harness that changes how it
measures while changing what it measures cannot tell you which change moved the
number.

## 9. Verified fixtures, fail-closed classification, durable evidence

The independent review of `07da5fe` approved the production receipt admission
unchanged and blocked publication on the *harness*. Three findings, all
validation-only, all reproduced by the reviewer against a disposable clone.

### 9.1 A fixture is bytes, not a directory that exists

`extractionComplete()` checked that three paths existed, and
`provisionOtelDemoUpstream()` returned `satisfied / reused: true` on the strength
of that alone — before it had found an archive, let alone hashed one. The review
put a symlink at the digest-derived extraction path, pointed it outside the
worktree at three arbitrary files with the right names, and got:

```json
{ "status": "satisfied", "reused": true, "insideWorktree": false, "sample": "UNVERIFIED" }
```

Reuse is now a proof, performed from scratch on every call:

1. **containment** — `resolveContained()` canonicalises the worktree once and
   `lstat`s every component as it descends, so a symbolic link anywhere in the
   path is *named and refused* rather than followed. If no component is a link,
   the result cannot denote a file outside the worktree; the final `realpath`
   equality is asserted anyway, because that is the containment claim and a test
   should be able to read it directly rather than infer it.
2. **a marker** — `.erl2-campaign-fixture.json`, written only by a verified
   extraction, naming the release, the archive digest, the exact required paths
   and a digest for each. Deterministic: no timestamps, no absolute paths.
3. **recomputation** — every required file is re-hashed and compared, every time.
   A marker is a file; anything that can plant three files can plant a fourth.

Which is why (3) is not the last word either. A forged marker describing forged
files recomputes perfectly, so verification also checks each digest against
`config_hashes` in the tracked `substrate-lock.json` — bytes the campaign
worktree cannot write, produced by `qualify-otel-demo.mjs` from the real release.
The marker says *which archive this claims to be*; the lock says *whether these
are the qualified bytes*. Only the second requires trusting something outside the
worktree, and that is the one that closes the attack.

Extraction is likewise no longer taken on trust from a matching digest. A
verified archive can still legitimately contain an absolute member, a `..`
traversal or a symlink — the digest would match, because those are the pinned
bytes — so `inspectArchiveMembers()` reads the listing first and refuses rather
than repairs. Only the three declared paths are extracted, each must be the sole
regular-file member selecting it, and the whole listing is rejected if any member
anywhere is absolute or traverses upward.

Nothing is removed until a verified archive is in hand: a campaign that deleted
an unverifiable extraction and *then* found nothing to rebuild from would have
destroyed state and reported unavailable. A link **at** the extraction root is
unlinked (never followed, never recursed into); a link **above** it is refused,
because writing through it lands outside the worktree and deleting it would
destroy something the campaign did not create.

### 9.2 An incomplete observation is not a measurement

`classifyTestRun` read a *tail* of the stage's output and never saw the process.
A tail is perfectly capable of carrying a well-formed summary from a run that was
cut in half, killed by a signal, or exited for a reason no test explains — and
truncation was applied afterwards as `outputTruncated: true`, an annotation on an
agreement that remained an agreement.

Classification now receives the stage's complete execution facts and decides in
this order, before a word of output is believed:

| # | observation | result |
|---|---|---|
| 1 | facts absent | `execution_facts_missing` |
| 2 | spawn error | `test_runner_failed` |
| 3 | timed out / group outlived its kill | `stage_timed_out` / `stage_tree_termination_failed` |
| 4 | output truncated | `output_truncated` |
| 5 | terminated by a signal, or no integer status | `stage_terminated_abnormally` |
| 6 | a counter missing, negative, or `tests ≠ pass + fail + skipped + cancelled` | `test_runner_failed` / `impossible_test_accounting` |
| 7 | anything cancelled | `test_runner_failed` |
| 8 | exit status disagrees with the counters it summarises | `stage_terminated_abnormally` |
| 9 | a case named twice, or both failed and skipped | `impossible_test_accounting` |
| 10 | designated case skipped, prerequisite's own marker in the reason | `unmeasured_here` |
| 11 | designated case skipped otherwise | `designated_case_skipped` |
| 12 | any remaining skip the control did not declare | `unexpected_case_skipped` |
| 13 | …then the pre-existing kill/no-kill/stray/declared-case reading, unchanged |

Everything from 1 to 12 is a harness error. `unmeasured_here` is the one outcome
that is neither agreement nor disagreement, so it is now the *hardest* to reach
rather than the easiest: a declared prerequisite excuses a skipped designated
case only when the suite's own skip reason names what that prerequisite stands
for (`skipEvidence`). Declaring a prerequisite is not a licence to reinterpret
any disappearance in the file as that prerequisite's fault.

Two behaviours are deliberately unchanged: a genuine intended failure is still an
agreement, and a genuine unexpected pass is still a disagreement.

**Skips are now published rather than absent.** Every result carries `tests`,
`pass`, `fail`, `cancelled`, `skipped` and the name and reason of every skipped
case — on the agreeing rows too, which is exactly where they used to be dropped.
The review's objection was that the 129-row record *could not be asked* whether
skips were hidden behind its agreements. It can now.

It turned out there were three. `composeSubstrate.test.js` has one case that
skips itself without the upstream fixture, four controls run that suite, and only
`substrate-loopback-only-rendered` declares the fixture — and it is the last of
the four. So for `telemetry-driver-verified-collector`,
`compose-ownership-label-verification` and `compose-running-image-verification`
the rendered-topology case was skipping, unrecorded, on every campaign. Those
three now declare it with `expectedSkips`, which does not excuse the skip so much
as publish it: the case, the required reason marker, and the skip itself all
appear on the row. An undeclared skip, or a declared one whose reason has since
changed, is `unexpected_case_skipped` and fails the campaign.

### 9.3 Evidence that survives a fresh clone

The campaign's only complete record was `docs/ledger/negative-controls.json`,
which `.gitignore` excludes: no commit, no tree, no integrity binding, overwritten
by every targeted run, absent from a fresh clone. The clean gate fared worse — a
prose paragraph naming a log nobody retained.

The format is three things and stops there: a JSON record, whatever bounded logs
it refers to, and a `SHA256SUMS` over both, under
`docs/evidence/validation-harness-closure/`. There is no evidence platform. The
repository already byte-pins its deterministic artifacts through
`generate-evidence.mjs`; a three-hour campaign is not deterministic, so pinning
its bytes would be a lie. What can honestly be claimed is *this run, at this
commit, produced these numbers, and here is the output they were read from*.

- `scripts/negative-control.mjs --evidence-out <file>` writes what the campaign
  knows about itself: commit and tree, command and configuration, timing,
  discovered controls, prerequisite provisioning outcomes, per-control mutation
  target and replacement count, designated command and cases, exit status,
  signal, truncation, every counter, every skip and reason, per-stage durations,
  stage cleanup, byte-identity certification, residue, and a digest plus 16 KiB
  tail of each control's output.
- `scripts/capture-validation-evidence.mjs --mode gate|campaign --out <dir>`
  records what a process cannot certify about itself: repository identity before
  and after, Docker inventory on both sides, wall-clock timing, surviving
  processes, and the complete unbounded log of each step. It refuses to write
  into a directory that already holds a capture.
- `scripts/verify-validation-evidence.mjs` recomputes every digest, requires the
  gate and the campaign to name the same executable commit and tree, reconciles
  both sets of totals, and refuses the combinations the classifier made
  unreachable — an agreement coexisting with truncation, a signal, an abnormal
  exit, a harness error or an undeclared skip. It also asks `git check-ignore`
  whether each retained file would survive a clone, because that is the defect
  itself. It runs in the ordinary suite; the long runs do not.

The ignored ledger JSON is still written, now marked `authoritative: false` and
with the retained tails stripped. Targeted runs write wherever `--evidence-out`
says, so they cannot overwrite a full-campaign record.
