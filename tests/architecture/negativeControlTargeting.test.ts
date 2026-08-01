/**
 * The negative-control harness may not target a patch it cannot prove it hit.
 *
 * This is the structural half of `tests/integration/negativeControlHarness.test.ts`.
 * That suite measures the behaviour; this one pins the shape, because the defect
 * it exists to prevent is not a wrong answer — it is a harness quietly returning
 * to a construct that gives no answer at all.
 *
 * The construct is `String.prototype.replace` with a string pattern. It replaces
 * the **first** occurrence and reports nothing about the others, so a control
 * whose anchor stops being unique keeps producing a number. Three controls died
 * that way, and two were found only by running the full campaign months later.
 * Re-introducing it in the harness is a one-line edit that would look like a
 * simplification, which is exactly the kind of regression an architecture test is
 * for.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const scriptsDir = path.join(repoRoot, "scripts");

function harnessSources(): readonly { readonly path: string; readonly text: string }[] {
  const out: { path: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const child = path.join(dir, name);
      if (statSync(child).isDirectory()) {
        walk(child);
        continue;
      }
      if (!name.endsWith(".mjs")) continue;
      out.push({ path: path.relative(repoRoot, child), text: readFileSync(child, "utf8") });
    }
  };
  walk(path.join(scriptsDir, "lib"));
  out.push({
    path: "scripts/negative-control.mjs",
    text: readFileSync(path.join(scriptsDir, "negative-control.mjs"), "utf8"),
  });
  return out;
}

test("NC-ARCH: the harness never applies a control with an unconstrained replace", () => {
  // `.replace(` and `.replaceAll(` over the *source under test* are the shape;
  // the check is deliberately blunt, because a targeted regex here would be one
  // more thing to keep in step with the code it guards. The harness has no
  // legitimate need for either: mutation goes through `planControlPatch`, which
  // counts first.
  for (const file of harnessSources()) {
    const offenders = file.text
      .split("\n")
      .map((line, index) => ({ line: line.trim(), number: index + 1 }))
      // A control's own `replace:` field and the display-only path tidying in
      // `classifyTestRun` are not source mutation; `source.replace(` is.
      .filter(({ line }) => /\bsource\s*\.\s*replaceAll?\s*\(/.test(line) || /\bpatched\s*\.\s*replaceAll?\s*\(/.test(line));
    assert.deepEqual(
      offenders,
      [],
      `${file.path} mutates the source under test with String.replace; every control patch must go through ` +
        "planControlPatch, which counts occurrences before it writes anything",
    );
  }
});

test("NC-ARCH: the campaign applies its patches only through the targeting module", () => {
  const campaign = readFileSync(path.join(scriptsDir, "negative-control.mjs"), "utf8");
  assert.ok(
    campaign.includes('from "./lib/controlTarget.mjs"'),
    "the campaign must import the targeting module rather than open-coding a patch",
  );
  assert.ok(
    campaign.includes("planControlPatch("),
    "the campaign must plan every patch through planControlPatch",
  );
  assert.ok(
    campaign.includes("verifyPatchOnDisk("),
    "the campaign must re-read the patched file and confirm the postimage landed",
  );

  // Exactly one write of a patched file, so a second, unproven path cannot creep
  // in beside the checked one.
  const writes = [...campaign.matchAll(/writeFileSync\(\s*target\b/g)];
  assert.equal(writes.length, 1, "the campaign must write a patched control file in exactly one place");
});

test("NC-ARCH: the targeting module is pure", () => {
  // It decides what a patch *would* do. A module that could also read a file or
  // spawn a process would be able to answer with something other than its
  // arguments, and the unit tests that pin its refusals would stop being total.
  const text = readFileSync(path.join(scriptsDir, "lib", "controlTarget.mjs"), "utf8");
  const imports = text
    .split("\n")
    .filter((line) => line.startsWith("import ") || /^\s*(const|let)\s.*\brequire\(/.test(line));
  assert.deepEqual(imports, [], "controlTarget.mjs must import nothing; it is pure string arithmetic");
  for (const forbidden of ["node:fs", "node:child_process", "node:process", "process.env"]) {
    assert.ok(!text.includes(forbidden), `controlTarget.mjs reaches for ${forbidden}`);
  }
});

test("NC-ARCH: a control declaration carries everything a proof needs", () => {
  // The fields are the contract between a control and the harness: the target,
  // the exact preimage, how many occurrences are meant, the postimage, the
  // invariant's name and the suites that must notice. `expectedMatches` defaults
  // to one rather than being required, and the default is the load-bearing part —
  // a control that says nothing gets the strictest rule, not the loosest.
  const campaign = readFileSync(path.join(scriptsDir, "negative-control.mjs"), "utf8");
  assert.ok(
    /expectedMatches\s*=\s*1/.test(readFileSync(path.join(scriptsDir, "lib", "controlTarget.mjs"), "utf8")),
    "the expected match count must default to exactly one",
  );
  for (const required of ["validateControlDeclarations", "CONTROL_RESULT", "isHarnessError"]) {
    assert.ok(campaign.includes(required), `the campaign no longer exports ${required}`);
  }
});
