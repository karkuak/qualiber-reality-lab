/**
 * The semantic gate over `erl2 doctor` in the generated CLI transcript.
 *
 * ## Why a semantic gate and not a byte comparison
 *
 * `cli-transcript.json` records the absolute `--artifact-root`/path arguments of
 * every invocation, so it is one of the seven files `evidence:verify` cannot
 * byte-pin — and an excluded file is an uncovered file. The committed transcript
 * proved exactly that: it predated ERL2-OQ-005 and still carried a `doctor`
 * report with no `compose_substrate` block at all, and nothing noticed, because
 * the only gate over that file was a comparison that never ran.
 *
 * So the transcript gets a gate that does not depend on its bytes. It parses the
 * transcript the harness just generated and asserts the *structure* of the
 * current doctor report: the invocation succeeded, the report still carries the
 * sections a reader is promised, and the derived `compose_substrate` block is
 * present, is derived from the retained lock rather than restated as a constant,
 * and states the OQ-005 boundary the Lab is actually on.
 *
 * It asserts the boundary, not a stored verdict. A lock signed by this
 * repository's own development key is cryptographically valid and is **not** an
 * independent qualification, and doctor has to keep saying both. If the substrate
 * is ever independently qualified this gate fails loudly and is updated
 * deliberately — which is the point of pinning a boundary rather than a shape.
 *
 * Pure by construction: it takes an already-parsed transcript and returns the
 * failures it found, so the harness can exit on them and a test can drive every
 * branch without generating an evidence tree.
 */

/**
 * The OQ-005 boundary the Lab is on: the OTel Demo substrate lock is pinned and
 * qualified, it is signed by the repository's own development key, and that is
 * explicitly not an independent qualification.
 */
export const EXPECTED_COMPOSE_SUBSTRATE_BOUNDARY = Object.freeze({
  substrate_lock: "qualified_development_signed",
  driver: "enabled_by_development_signed_lock",
  signer_classification: "development_key",
  independently_qualified: false,
});

/** The doctor sections a reader of the report is promised. */
const REQUIRED_DOCTOR_KEYS = Object.freeze([
  "subject_isolation",
  "compose_substrate",
  "profile",
  "node_version",
  "registered_contracts",
  "adapter_protocol_version",
  "adapter_sandbox_profile",
]);

/** The fields the derived Compose-substrate block always carries. */
const REQUIRED_COMPOSE_KEYS = Object.freeze([
  "substrate_lock",
  "driver",
  "signer_classification",
  "independently_qualified",
]);

/**
 * Every way the generated transcript's doctor report departs from the current
 * contract, as human-readable strings. Empty means the gate passed.
 *
 * @param {readonly unknown[]} transcript the parsed `cli-transcript.json`
 * @returns {string[]}
 */
export function doctorTranscriptFailures(transcript) {
  const failures = [];
  const check = (ok, message) => {
    if (!ok) failures.push(message);
  };

  if (!Array.isArray(transcript)) return ["the transcript is not an array of CLI invocations"];

  const entries = transcript.filter(
    (t) => t !== null && typeof t === "object" && Array.isArray(t.argv) && t.argv[1] === "doctor",
  );
  check(
    entries.length === 1,
    `expected exactly 1 doctor invocation, found ${String(entries.length)}`,
  );
  const doctor = entries[0];
  if (doctor === undefined) return failures;

  check(doctor.exit_code === 0, `doctor exited ${String(doctor.exit_code)}`);
  const data = doctor.stdout?.data;
  check(
    data !== undefined && data !== null && typeof data === "object",
    "doctor produced no data section",
  );
  if (data === undefined || data === null || typeof data !== "object") return failures;

  // A dropped section is a silent narrowing of what doctor answers.
  for (const key of REQUIRED_DOCTOR_KEYS) {
    check(data[key] !== undefined, `doctor report is missing ${key}`);
  }

  const compose = data.compose_substrate;
  check(
    compose !== undefined && compose !== null && typeof compose === "object",
    "doctor report carries no compose_substrate block (the pre-OQ-005 shape)",
  );
  if (compose === undefined || compose === null || typeof compose !== "object") return failures;

  for (const key of REQUIRED_COMPOSE_KEYS) {
    check(compose[key] !== undefined, `compose_substrate is missing ${key}`);
  }

  // The derived block and the flat keys retained for older readers are one
  // verdict, never two constants that can disagree.
  check(
    data.compose_environment_driver === compose.driver,
    `compose_environment_driver ${String(data.compose_environment_driver)} disagrees with ` +
      `compose_substrate.driver ${String(compose.driver)}`,
  );
  check(
    data.otel_demo_substrate_lock === compose.substrate_lock,
    `otel_demo_substrate_lock ${String(data.otel_demo_substrate_lock)} disagrees with ` +
      `compose_substrate.substrate_lock ${String(compose.substrate_lock)}`,
  );

  for (const [key, expected] of Object.entries(EXPECTED_COMPOSE_SUBSTRATE_BOUNDARY)) {
    check(
      compose[key] === expected,
      `compose_substrate.${key} is ${String(compose[key])}, expected ${String(expected)}`,
    );
  }

  // Derived from the lock's own contents, not restated: these are absent in the
  // hardcoded pre-OQ-005 shape, so their presence is what distinguishes a derived
  // verdict from a remembered one.
  check(typeof compose.lock_hash === "string", "compose_substrate carries no derived lock_hash");
  check(
    Array.isArray(compose.services) && compose.services.length > 0,
    "compose_substrate lists no services",
  );
  check(
    Array.isArray(compose.platforms) && compose.platforms.length > 0,
    "compose_substrate lists no platforms",
  );

  return failures;
}

/**
 * The one-line summary printed when the gate passes.
 *
 * @param {readonly unknown[]} transcript
 * @returns {string}
 */
export function doctorTranscriptSummary(transcript) {
  const doctor = transcript.find((t) => Array.isArray(t?.argv) && t.argv[1] === "doctor");
  const compose = doctor?.stdout?.data?.compose_substrate ?? {};
  return (
    `doctor exit ${String(doctor?.exit_code)}, compose_substrate derived: ` +
    `${String(compose.substrate_lock)} / ${String(compose.driver)}, ` +
    `independently_qualified=${String(compose.independently_qualified)}`
  );
}
