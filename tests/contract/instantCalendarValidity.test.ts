/**
 * CONTRACT: `Instant` admits exactly the real UTC calendar instants.
 *
 * ## Why this exists
 *
 * `Instant` is the workspace's only timestamp type — one `$defs` entry in
 * `common.schema.json`, referenced from thirteen schemas. Its `$comment` has
 * always said "UTC RFC 3339 with second precision and a literal Z", but the
 * pattern under it was a *shape* check: four digits, two digits, two digits.
 * `2026-06-31T23:59:59Z`, `2026-02-30T00:00:00Z`, `2026-01-01T24:00:00Z` and
 * `2026-12-31T23:59:60Z` all satisfied it, and none of them is an instant.
 *
 * That is not a cosmetic gap, because roughly thirty-five production sites
 * across five packages turn an `Instant` into a number with `Date.parse` —
 * trust-key validity windows, revocation effective times, checkpoint chain
 * ordering, selection round ordering, lease expiry, adapter deadlines, evidence
 * window arithmetic, and the public bundle's back-dating check. `Date.parse`
 * does not reject an impossible date; it **rolls it forward**. So a stamp whose
 * literal text reads as one instant was compared as a different, later one:
 *
 *     2026-06-31T23:59:59Z  reads as June, parses as 2026-07-01T23:59:59Z
 *     2026-02-30T00:00:00Z  reads as February, parses as 2026-03-02T00:00:00Z
 *     2026-01-01T24:00:00Z  reads as the 1st, parses as the 2nd
 *
 * Every one of those comparisons was answerable with a document a reader would
 * misread. The property this file pins is the one that makes all of them
 * honest at once: **a schema-admitted `Instant` denotes exactly the instant its
 * own text spells.**
 *
 * ## Method
 *
 * The oracle is an independent Gregorian calendar written out longhand below —
 * not the pattern, and not `Date`, whose `Date.UTC` maps years 0-99 into the
 * 1900s and would agree with a wrong answer. The pattern is read from the
 * schema file rather than restated here, so this measures the contract that
 * ships rather than a copy of it, and a handful of end-to-end
 * `validateContract` calls prove that pattern is the one real documents are
 * held to.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateContract } from "@erl2/contracts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const COMMON_SCHEMA = path.join(repoRoot, "packages", "contracts", "schemas", "common.schema.json");

/** The shipped `Instant` pattern, read from the contract rather than restated. */
function instantPattern(): RegExp {
  const schema = JSON.parse(readFileSync(COMMON_SCHEMA, "utf8")) as {
    $defs: Record<string, { pattern?: string }>;
  };
  const pattern = schema.$defs["Instant"]?.pattern;
  assert.equal(typeof pattern, "string", "common.schema.json must define Instant with a pattern");
  return new RegExp(pattern as string, "u");
}

const ADMITS = instantPattern();

/**
 * The independent oracle: proleptic Gregorian, written longhand.
 *
 * Deliberately not `Date`. `Date.UTC(26, 1, 30)` is the year 1926, and a test
 * that reached for it would confirm the wrong answer for every year below 100.
 */
function isRealInstant(text: string): boolean {
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/u.test(text)) return false;
  const year = Number(text.slice(0, 4));
  const month = Number(text.slice(5, 7));
  const day = Number(text.slice(8, 10));
  const hour = Number(text.slice(11, 13));
  const minute = Number(text.slice(14, 16));
  const second = Number(text.slice(17, 19));
  if (month < 1 || month > 12 || day < 1) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const lengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;
  return day <= (lengths[month - 1] as number);
}

const pad = (n: number, width: number): string => String(n).padStart(width, "0");
const instant = (y: number, mo: number, d: number, h = 12, mi = 0, s = 0): string =>
  `${pad(y, 4)}-${pad(mo, 2)}-${pad(d, 2)}T${pad(h, 2)}:${pad(mi, 2)}:${pad(s, 2)}Z`;

// -- the pattern is the one real documents are held to ------------------------

/** A minimal valid carrier, so `observed_at` is the only thing under test. */
function observation(observedAt: string): Record<string, unknown> {
  return {
    schema_version: "attributable-telemetry-observation/v1",
    run_id: "01890000-0000-7000-8000-00000000000d",
    marker: "01890000-0000-7000-8000-00000000000d",
    evidence: "absent",
    observed_at: observedAt,
    reason_code: "collector-not-observed",
    core_hash: `sha256:${"0".repeat(64)}`,
  };
}

function contractAdmits(observedAt: string): boolean {
  return validateContract("AttributableTelemetryObservationV1", observation(observedAt)).valid;
}

test("INSTANT-WIRED: the pattern under test is the one validateContract enforces", () => {
  // Without this the sweeps below would measure a regex nothing uses.
  assert.equal(contractAdmits("2026-07-01T00:00:00Z"), true, "a real instant must validate");
  for (const impossible of [
    "2026-06-31T23:59:59Z",
    "2026-02-30T00:00:00Z",
    "2026-01-01T24:00:00Z",
    "2026-12-31T23:59:60Z",
  ]) {
    assert.equal(contractAdmits(impossible), false, `${impossible} must not validate`);
    assert.equal(ADMITS.test(impossible), false, `${impossible} must not match the shipped pattern`);
  }
});

// -- the calendar ------------------------------------------------------------

test("INSTANT-CALENDAR: the pattern admits exactly the real dates, over every leap-rule case", () => {
  // Century years are the cases a hand-written pattern gets wrong: 1900 and 2100
  // are not leap years, 1600, 2000 and 2400 are. Year 0 and year 9999 are the
  // representable ends. The contiguous modern span catches anything a
  // hand-picked list would miss by construction.
  const years = [
    0, 1, 4, 100, 200, 300, 400, 1582, 1600, 1700, 1800, 1900, 1996, 1999,
    2000, 2001, 2003, 2004, 2100, 2200, 2300, 2400, 9998, 9999,
    ...Array.from({ length: 16 }, (_, i) => 2020 + i),
  ];
  let checked = 0;
  let admitted = 0;
  for (const year of years) {
    for (let month = 0; month <= 13; month += 1) {
      for (let day = 0; day <= 32; day += 1) {
        const text = instant(year, month, day);
        const expected = isRealInstant(text);
        assert.equal(ADMITS.test(text), expected, `${text}: pattern and calendar disagree`);
        checked += 1;
        if (expected) admitted += 1;
      }
    }
  }
  assert.ok(checked > 15_000, `the sweep must be broad, checked ${String(checked)}`);
  assert.ok(admitted > 14_000, `the sweep must admit real dates, admitted ${String(admitted)}`);
});

test("INSTANT-LEAP: 29 February follows the Gregorian rule, not the four-year approximation", () => {
  for (const [year, leap] of [
    [1600, true], [1700, false], [1800, false], [1900, false],
    [2000, true], [2020, true], [2023, false], [2024, true],
    [2026, false], [2100, false], [2400, true],
  ] as const) {
    assert.equal(ADMITS.test(instant(year, 2, 29)), leap, `${String(year)}-02-29`);
    assert.equal(contractAdmits(instant(year, 2, 29)), leap, `${String(year)}-02-29 through the contract`);
    assert.equal(ADMITS.test(instant(year, 2, 28)), true, `${String(year)}-02-28 is always real`);
    assert.equal(ADMITS.test(instant(year, 2, 30)), false, `${String(year)}-02-30 is never real`);
  }
});

test("INSTANT-TIME: hours, minutes and seconds are bounded, and there is no leap second", () => {
  for (let hour = 0; hour <= 25; hour += 1) {
    for (let minute = 0; minute <= 61; minute += 1) {
      for (let second = 0; second <= 61; second += 1) {
        const text = instant(2026, 7, 1, hour, minute, second);
        assert.equal(ADMITS.test(text), isRealInstant(text), `${text}: pattern and clock disagree`);
      }
    }
  }
  // A leap second is representable in UTC and not in this contract, which is
  // what `evidenceWindowDerivation` already assumed when it asserted that
  // `Date.parse("2026-12-31T23:59:60Z")` is NaN.
  assert.equal(ADMITS.test("2026-12-31T23:59:60Z"), false);
  assert.equal(ADMITS.test("2026-12-31T23:59:59Z"), true);
});

// -- the property the thirty-five Date.parse sites depend on ------------------

test("INSTANT-ROUNDTRIP: every admitted instant parses to exactly the instant it spells", () => {
  // This is the security property. `Date.parse` rolls an impossible date
  // forward rather than refusing it, so before the calendar was enforced a
  // document could read as one instant and be compared as a later one. Pinned
  // by round-trip, over the same sweep the calendar case uses.
  const years = [0, 1, 400, 1600, 1900, 2000, 2024, 2026, 2100, 2400, 9999];
  let roundTripped = 0;
  for (const year of years) {
    for (let month = 1; month <= 12; month += 1) {
      for (let day = 1; day <= 31; day += 1) {
        for (const [hour, minute, second] of [[0, 0, 0], [12, 34, 56], [23, 59, 59]] as const) {
          const text = instant(year, month, day, hour, minute, second);
          if (!ADMITS.test(text)) continue;
          const parsed = Date.parse(text);
          assert.equal(Number.isNaN(parsed), false, `${text} must parse`);
          const back = new Date(parsed).toISOString().replace(/\.\d{3}Z$/u, "Z");
          assert.equal(back, text, `${text} must round-trip, got ${back}`);
          roundTripped += 1;
        }
      }
    }
  }
  assert.ok(roundTripped > 3_000, `the sweep must be broad, round-tripped ${String(roundTripped)}`);
});

test("INSTANT-ROLLOVER: the specific stamps that used to read earlier than they compared", () => {
  // Each of these satisfied the old shape check, and `Date.parse` moved it
  // forward past the instant its own text names.
  for (const [text, rollsTo] of [
    ["2026-06-31T23:59:59Z", "2026-07-01T23:59:59.000Z"],
    ["2026-02-30T00:00:00Z", "2026-03-02T00:00:00.000Z"],
    ["2026-02-29T00:00:00Z", "2026-03-01T00:00:00.000Z"],
    ["2026-04-31T00:00:00Z", "2026-05-01T00:00:00.000Z"],
    ["2026-01-01T24:00:00Z", "2026-01-02T00:00:00.000Z"],
  ] as const) {
    assert.equal(
      new Date(Date.parse(text)).toISOString(),
      rollsTo,
      `${text} must still be the rollover this case is about`,
    );
    assert.equal(ADMITS.test(text), false, `${text} must no longer be a representable Instant`);
    assert.equal(contractAdmits(text), false, `${text} must be refused by the contract`);
  }
});

// -- nothing that exists is refused ------------------------------------------

test("INSTANT-COMMITTED: every instant in the committed fixtures and evidence still validates", () => {
  // Tightening a contract may only refuse documents that were always malformed.
  // This walks the committed goldens and evidence and requires every
  // instant-shaped literal in them to survive.
  const roots = [path.join(repoRoot, "fixtures"), path.join(repoRoot, "docs", "evidence")];
  const shape = /[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z/gu;
  const seen = new Set<string>();
  let files = 0;
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const child = path.join(dir, name);
      const st = statSync(child);
      if (st.isDirectory()) {
        walk(child);
        continue;
      }
      if (!st.isFile() || st.size > 4_000_000) continue;
      let text: string;
      try {
        text = readFileSync(child, "utf8");
      } catch {
        continue;
      }
      files += 1;
      for (const match of text.matchAll(shape)) seen.add(match[0]);
    }
  };
  for (const root of roots) walk(root);
  assert.ok(files > 100, `the walk must reach the committed tree, saw ${String(files)} files`);
  assert.ok(seen.size > 50, `the walk must find instants, saw ${String(seen.size)}`);
  const refused = [...seen].filter((value) => !ADMITS.test(value));
  assert.deepEqual(refused, [], "no committed instant may be refused by the tightened contract");
});
