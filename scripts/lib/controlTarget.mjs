/**
 * Negative-control patch targeting: prove a control mutated what it named.
 *
 * ## Why this module exists
 *
 * The campaign used to apply its patches with `source.replace(find, replace)`.
 * With a string pattern that replaces the **first** occurrence and says nothing,
 * so a control whose anchor stopped being unique kept reporting a number. Three
 * controls have died that way and each was found late:
 *
 *   - `invalid-finding-lab-attribution` — ADR-ERL2-028 replaced the branch it was
 *     anchored on, so from that package on it patched nothing;
 *   - `cutoff-milestone-resolution` — re-patched around a narrowing trap;
 *   - `pre-dispatch-intent` — ADR-ERL2-028 inserted a second
 *     `this.advance(spec.operationId, "dispatching")` *above* the one the control
 *     meant, so `String.replace` disabled the resume branch instead of the
 *     first-dispatch path and killed nothing. It scored 7 pass / 0 fail and read
 *     as a passing control.
 *
 * Two of the three were found only by running the **full** campaign; the focused
 * subsets in between reported nothing. That is the argument for making the
 * property structural rather than remembered: a control must declare enough for
 * the harness to *prove* it modified its intended target, and a control that
 * cannot prove it is a harness error rather than a result.
 *
 * ## What a control must now declare
 *
 * `find` (the exact preimage) and `expectedMatches` (defaulting to exactly one).
 * Optionally an `anchor` — a string that must itself occur exactly once, after
 * which `find` is searched only in the text that follows it. That is the
 * structured-targeting escape hatch for a preimage that is legitimately
 * repeated: the anchor is the stable thing the invariant owns, and the preimage
 * is located relative to it rather than from the top of the file.
 *
 * ## Why the postimage check is positional and not a count
 *
 * `post-capture-activation-requirement` replaces a four-line list with `];`, and
 * `];` occurs ten times in that file. A "the postimage now appears" count proves
 * nothing there, and a "the postimage appears exactly once more than before"
 * identity is not even well-defined when the postimage overlaps the preimage.
 *
 * So the total check is positional: after splicing, the bytes at each computed
 * offset must be the postimage, every byte outside the spliced ranges must be
 * unchanged, and the preimage must survive in exactly the number of places the
 * declaration accounts for. A control that additionally wants its postimage to
 * be distinctive asks for it with `uniquePostimage`, which is a strengthening
 * and not the default — defaulting it on would refuse the control above, which
 * is correct as written.
 *
 * This module is pure: no filesystem, no processes, no git. It is unit-tested in
 * `tests/integration/negativeControlHarness.test.ts`, including a regression for
 * the two-identical-anchors shape that killed `pre-dispatch-intent`.
 */

/**
 * How a targeting attempt ended.
 *
 * Everything except `patch_applied` is a **harness error** — the campaign learned
 * nothing about the guard — and must never be reported as a passing or
 * non-load-bearing control. That distinction is the whole point: a patch that
 * modified the wrong location is not evidence, and neither is one that modified
 * nothing.
 */
export const TARGET_OUTCOME = Object.freeze({
  APPLIED: "patch_applied",
  NOT_APPLICABLE: "patch_not_applicable",
  AMBIGUOUS: "ambiguous_patch_target",
  ANCHOR_NOT_FOUND: "anchor_not_found",
  ANCHOR_AMBIGUOUS: "anchor_ambiguous",
  POSTIMAGE_MISSING: "postimage_missing",
  POSTIMAGE_ELSEWHERE: "postimage_unexpected_elsewhere",
  PREIMAGE_RESIDUE: "preimage_residue_unexpected",
  SPLICE_COLLATERAL: "splice_changed_unrelated_bytes",
  DECLARATION_INVALID: "control_declaration_invalid",
});

/** The outcomes that mean the campaign measured nothing. */
export const HARNESS_ERROR_OUTCOMES = Object.freeze(
  Object.values(TARGET_OUTCOME).filter((outcome) => outcome !== TARGET_OUTCOME.APPLIED),
);

/**
 * Every offset at which `needle` occurs in `haystack`, scanning
 * **non-overlapping** from the left.
 *
 * An empty needle is rejected rather than treated as matching everywhere: a
 * control that declares no preimage has declared no target, and silently
 * "finding" it at every offset is how a harness reports a number for a
 * measurement it did not make.
 */
export function occurrenceOffsets(haystack, needle) {
  if (typeof needle !== "string" || needle === "") {
    throw new TypeError("an empty preimage names no target");
  }
  const found = [];
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return found;
    found.push(at);
    from = at + needle.length;
  }
}

/** Convenience over {@link occurrenceOffsets}. */
export function countOccurrences(haystack, needle) {
  return occurrenceOffsets(haystack, needle).length;
}

function invalid(detail) {
  return { outcome: TARGET_OUTCOME.DECLARATION_INVALID, detail };
}

/**
 * Locate and apply one control's textual mutation, proving it landed where the
 * control said it would.
 *
 * @param {object} spec
 * @param {string} spec.source            the file's current bytes
 * @param {string} spec.find              the exact preimage
 * @param {string} spec.replace           the postimage (`""` deletes)
 * @param {number} [spec.expectedMatches] how many occurrences the control means
 *                                        to replace; defaults to exactly one
 * @param {string} [spec.anchor]          a string occurring exactly once, after
 *                                        which `find` is searched
 * @param {boolean} [spec.uniquePostimage] also require the postimage not to
 *                                        already occur outside the target ranges
 * @returns {{outcome: string} & Record<string, unknown>}
 */
export function planControlPatch(spec) {
  const {
    source,
    find,
    replace,
    expectedMatches = 1,
    anchor,
    uniquePostimage = false,
  } = spec;

  if (typeof source !== "string") return invalid("source is not a string");
  if (typeof find !== "string" || find === "") return invalid("`find` must be a non-empty string");
  if (typeof replace !== "string") return invalid("`replace` must be a string");
  if (!Number.isSafeInteger(expectedMatches) || expectedMatches < 1) {
    return invalid(`\`expectedMatches\` must be a positive integer, got ${String(expectedMatches)}`);
  }
  if (find === replace) {
    return invalid("the preimage and the postimage are identical, so the patch is a no-op");
  }

  // -- the window ----------------------------------------------------------
  //
  // Without an anchor the window is the whole file. With one, the anchor must be
  // unique on its own terms first: an ambiguous anchor cannot disambiguate
  // anything, and accepting its first occurrence would reintroduce the exact
  // defect at one remove.
  let windowStart = 0;
  if (anchor !== undefined) {
    if (typeof anchor !== "string" || anchor === "") return invalid("`anchor` must be a non-empty string");
    const anchorAt = occurrenceOffsets(source, anchor);
    if (anchorAt.length === 0) {
      return { outcome: TARGET_OUTCOME.ANCHOR_NOT_FOUND, anchor, found: 0 };
    }
    if (anchorAt.length > 1) {
      return { outcome: TARGET_OUTCOME.ANCHOR_AMBIGUOUS, anchor, found: anchorAt.length };
    }
    windowStart = anchorAt[0];
  }

  const offsets = occurrenceOffsets(source.slice(windowStart), find).map((at) => at + windowStart);

  if (offsets.length === 0) {
    return { outcome: TARGET_OUTCOME.NOT_APPLICABLE, expected: expectedMatches, found: 0 };
  }
  if (offsets.length !== expectedMatches) {
    // Both directions are refusals. Fewer than declared means the source moved
    // under the control; more means the control names a target it cannot
    // identify, which is `pre-dispatch-intent` exactly.
    return {
      outcome: TARGET_OUTCOME.AMBIGUOUS,
      expected: expectedMatches,
      found: offsets.length,
      offsets,
    };
  }

  // -- the postimage, before anything is written ---------------------------
  if (uniquePostimage && replace !== "") {
    const ranges = offsets.map((at) => [at, at + find.length]);
    const outside = occurrenceOffsets(source, replace).filter(
      (at) => !ranges.some(([lo, hi]) => at >= lo && at + replace.length <= hi),
    );
    if (outside.length > 0) {
      return { outcome: TARGET_OUTCOME.POSTIMAGE_ELSEWHERE, offsets, strayOffsets: outside };
    }
  }

  // -- splice, right to left so earlier offsets stay valid -----------------
  let patched = source;
  for (let i = offsets.length - 1; i >= 0; i -= 1) {
    const at = offsets[i];
    patched = patched.slice(0, at) + replace + patched.slice(at + find.length);
  }

  // -- prove the splice landed exactly where it was aimed -------------------
  //
  // Each match shifts every later match by the same delta, so the postimage's
  // offset in the patched text is computable and is checked byte for byte. A
  // harness that only asked "does the postimage appear somewhere" would accept a
  // patch that landed in the wrong place and happened to contain the right text.
  const delta = replace.length - find.length;
  const landedAt = offsets.map((at, i) => at + i * delta);
  for (const at of landedAt) {
    if (replace !== "" && patched.slice(at, at + replace.length) !== replace) {
      return { outcome: TARGET_OUTCOME.POSTIMAGE_MISSING, offsets, expectedAt: at };
    }
  }

  // Every byte outside the spliced ranges must be untouched. Reconstructing the
  // untouched segments from the *patched* text and comparing them with the
  // source is an independent check on the offset arithmetic above, rather than a
  // restatement of how `patched` was built.
  const rebuilt = [];
  let cursor = 0;
  for (const at of landedAt) {
    rebuilt.push(patched.slice(cursor, at));
    cursor = at + replace.length;
  }
  rebuilt.push(patched.slice(cursor));

  const untouched = [];
  let from = 0;
  for (const at of offsets) {
    untouched.push(source.slice(from, at));
    from = at + find.length;
  }
  untouched.push(source.slice(from));

  for (let i = 0; i < untouched.length; i += 1) {
    if (rebuilt[i] !== untouched[i]) {
      return { outcome: TARGET_OUTCOME.SPLICE_COLLATERAL, offsets, segment: i };
    }
  }

  // -- prove the preimage was removed only as declared ----------------------
  //
  // Several controls legitimately *contain* their preimage in their postimage —
  // an inserted early return above the call it disables, for instance — so the
  // preimage surviving is not by itself wrong. What must hold is the exact
  // accounting: every occurrence the control did not claim is still there, and
  // every occurrence its own postimage reintroduces is there too.
  const outsideWindow = countOccurrences(source, find) - offsets.length;
  const reintroduced = replace === "" ? 0 : countOccurrences(replace, find);
  const expectedAfter = outsideWindow + expectedMatches * reintroduced;
  const actualAfter = countOccurrences(patched, find);
  if (actualAfter !== expectedAfter) {
    return {
      outcome: TARGET_OUTCOME.PREIMAGE_RESIDUE,
      offsets,
      expectedAfter,
      actualAfter,
      outsideWindow,
    };
  }

  return {
    outcome: TARGET_OUTCOME.APPLIED,
    patched,
    offsets,
    landedAt,
    replacedCount: offsets.length,
    preimageRemaining: actualAfter,
  };
}

/**
 * Confirm the bytes that actually reached the disk carry the postimage where the
 * plan said they would.
 *
 * {@link planControlPatch} computes a patch; this checks that the patch is what
 * the compiler is about to read. The gap is small and real — a short write, a
 * stale handle, an editor or generator rewriting the file between the write and
 * the build — and the whole point of this module is that a control proves its
 * mutation rather than assuming it.
 *
 * @param {object} check
 * @param {string} check.written  the file's bytes, re-read from disk
 * @param {{patched: string, landedAt: number[]}} check.plan
 * @param {string} check.replace
 */
export function verifyPatchOnDisk({ written, plan, replace }) {
  if (typeof written !== "string") return invalid("the re-read file is not a string");
  for (const at of plan.landedAt) {
    if (replace !== "" && written.slice(at, at + replace.length) !== replace) {
      return { outcome: TARGET_OUTCOME.POSTIMAGE_MISSING, expectedAt: at };
    }
  }
  if (written !== plan.patched) {
    return { outcome: TARGET_OUTCOME.SPLICE_COLLATERAL, detail: "the file on disk is not the planned text" };
  }
  return { outcome: TARGET_OUTCOME.APPLIED };
}
