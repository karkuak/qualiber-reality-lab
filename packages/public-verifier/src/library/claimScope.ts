/**
 * The evidence-derived claim-scope ceiling (ADR-ERL2-025).
 *
 * ## What this closes
 *
 * `claim_scope` is the one field in a signed attestation that says how strongly
 * the run may be spoken about, and it was set like this:
 *
 * ```ts
 * const claimScope = flags["claim-scope"] ?? "T1";
 * ```
 *
 * `erl2 finalize-generic --claim-scope T3` produced a signed, offline-valid
 * attestation asserting historical-reproduction evidence over a development-tier
 * run against the fake driver, with non-blind selection and
 * `DomainResultNotApplicableV1` — a run that measured no domain outcome at all.
 * The verifier's only check was `["T1","T2","T3"].includes(...)`, so it accepted
 * the string. Every other verdict in the system is derived; this one was typed
 * in at the command line (review P2, and ADR-ERL2-024 §11 recorded it as
 * explicitly still open).
 *
 * ## The rule
 *
 * A ceiling per component, and the answer is the **weakest** of them:
 *
 * ```
 * ceiling = min over applicable components of component.ceiling
 * ```
 *
 * No component can raise another's ceiling, missing evidence lowers or refuses
 * and never raises, and an inapplicable component is excluded rather than
 * defaulted upward. `T1` is the floor rather than a zero: a terminal is only
 * derived at all once it is *valid*, and a valid terminal is capability evidence
 * by construction.
 *
 * ## Why this lives in the verifier
 *
 * Same reason the closure derivation does (ADR-ERL2-022 §1, ADR-ERL2-024 §7.1):
 * the derivation is verifier-owned and the finalizer *injects* it, so the
 * producer cannot sign a scope its own reader would reject. Two implementations
 * agreeing would prove only that the implementations agree.
 */

import {
  CODES,
  Erl2Error,
  type ChallengeManifestV1,
  type ClaimScope,
  type EnvironmentDriverManifestV1,
  type Hash,
  type IsolationQualificationReportV1,
  type LabLifecycleEventV1,
  type MetricResultV1,
  type SelectedChallengeJourneyBindingV1,
  type SelectionAssuranceV1,
  type SubstrateBindingV1,
} from "@erl2/contracts";
import type { ArtifactIndex } from "./artifactIndex.js";

/** T1 < T2 < T3. The order the whole derivation is a minimum over. */
const ORDER: readonly ClaimScope[] = ["T1", "T2", "T3"];

/**
 * The strongest scope any base Lab attestation may carry, whatever the
 * evidence says.
 *
 * T4 is not in `ClaimScope` at all, and is unreachable at schema level: design
 * v2 §25 puts contextual T4 behind a separately verified
 * `CustomerVerificationBundleV1` that does not exist, and `FinalLabAttestationV1`
 * has no encoding for it. This constant is about T1–T3 only.
 */
export const MAX_BASE_CLAIM_SCOPE: ClaimScope = "T3";

export function claimScopeRank(scope: ClaimScope): number {
  const rank = ORDER.indexOf(scope);
  if (rank < 0) {
    throw new Erl2Error(
      CODES.POLICY_CLAIM_SCOPE_EXCEEDS_EVIDENCE,
      `${String(scope)} is not a base claim scope; a base attestation carries T1, T2 or T3`,
    );
  }
  return rank;
}

/** True when `a` is a stronger claim than `b`. */
export function claimScopeExceeds(a: ClaimScope, b: ClaimScope): boolean {
  return claimScopeRank(a) > claimScopeRank(b);
}

function weakest(a: ClaimScope, b: ClaimScope): ClaimScope {
  return claimScopeRank(a) <= claimScopeRank(b) ? a : b;
}

/**
 * One constraint the run's own evidence places on how strongly it may be
 * spoken about.
 *
 * `applicable: false` means the component has nothing to say about this
 * terminal — not that it says "anything goes". It is excluded from the minimum,
 * and the reason is recorded so a reader can see which constraints were even in
 * play.
 */
export interface ClaimScopeComponent {
  readonly component_id: string;
  readonly applicable: boolean;
  /** Only meaningful when `applicable`. */
  readonly ceiling: ClaimScope;
  /** What was observed, in one line, for the refusal message and the handoff. */
  readonly observed: string;
}

export interface ClaimCeilingReport {
  readonly ceiling: ClaimScope;
  readonly components: readonly ClaimScopeComponent[];
  /** The components that are actually holding the ceiling down. */
  readonly binding: readonly string[];
}

function component(
  id: string,
  ceiling: ClaimScope,
  observed: string,
): ClaimScopeComponent {
  return { component_id: id, applicable: true, ceiling, observed };
}

function inapplicable(id: string, observed: string): ClaimScopeComponent {
  return { component_id: id, applicable: false, ceiling: MAX_BASE_CLAIM_SCOPE, observed };
}

/** Folds the components into the ceiling. This is the whole policy. */
export function combineClaimScopeComponents(
  components: readonly ClaimScopeComponent[],
): ClaimCeilingReport {
  if (!components.some((entry) => entry.applicable)) {
    // Unreachable through `deriveClaimCeiling` — the terminal variant always
    // applies — and refused rather than defaulted anyway. A minimum over an
    // empty set is the identity element, which here is the *strongest* scope:
    // an implementation that quietly returned it would answer "everything is
    // permitted" to "no evidence applies", which is the one direction §4.1 says
    // missing evidence must never move in.
    throw new Erl2Error(
      CODES.POLICY_CLAIM_SCOPE_EXCEEDS_EVIDENCE,
      "no claim-scope component applies to this terminal, so no scope can be derived from it",
      { owner: "lab" },
    );
  }
  let ceiling = MAX_BASE_CLAIM_SCOPE;
  for (const entry of components) {
    if (!entry.applicable) continue;
    ceiling = weakest(ceiling, entry.ceiling);
  }
  return {
    ceiling,
    components,
    binding: components
      .filter((entry) => entry.applicable && entry.ceiling === ceiling)
      .map((entry) => entry.component_id),
  };
}

// -- the components ----------------------------------------------------------

function rolesOf(events: readonly LabLifecycleEventV1[]): Map<string, Hash[]> {
  const roles = new Map<string, Hash[]>();
  for (const event of events) {
    for (const produced of event.produced) {
      const bucket = roles.get(produced.artifact_role) ?? [];
      bucket.push(produced.artifact_core_hash);
      roles.set(produced.artifact_role, bucket);
    }
  }
  return roles;
}

/**
 * A pre-environment terminal proves the Lab's own lifecycle over an acquisition
 * and nothing about an environment, because there was none.
 */
function terminalVariantComponent(variant: "pre_environment" | "environment"): ClaimScopeComponent {
  return variant === "pre_environment"
    ? component(
        "terminal-variant",
        "T1",
        "pre-environment terminal: no environment was provisioned, so no robustness or " +
          "regression evidence exists to constrain",
      )
    : component("terminal-variant", "T3", "environment terminal");
}

/**
 * The tier the **selected** challenge was drawn at.
 *
 * Development means the case was visible to the people who built the run, so
 * nothing it shows is robustness evidence. Held-out earns robustness; blind is
 * the only tier that constrains nothing.
 *
 * Read through the selected binding, not by looking for "the" retained challenge
 * manifest: a run retains **every admitted candidate**, which is what makes the
 * pool checkable, so counting them and giving up when there is more than one
 * would reach the right answer here for entirely the wrong reason. It is the
 * selected one whose tier the run actually executed at.
 */
function tierComponent(index: ArtifactIndex, roles: Map<string, Hash[]>): ClaimScopeComponent {
  const bindings = roles.get("selected-challenge-journey-binding") ?? [];
  if (bindings.length !== 1) {
    return component(
      "execution-tier",
      "T1",
      bindings.length === 0
        ? "this run selected no challenge, so the tier it executed at cannot be established"
        : `${String(bindings.length)} selected-challenge bindings; a run selects one case`,
    );
  }
  const binding = index.typed<SelectedChallengeJourneyBindingV1>(
    bindings[0] as Hash,
    "selected-challenge-journey-binding/v1",
  );
  const manifest = index.typed<ChallengeManifestV1>(
    binding.challenge_manifest_hash,
    "challenge-manifest/v1",
  );
  const ceiling: ClaimScope =
    manifest.tier === "blind" ? "T3" : manifest.tier === "held_out" ? "T2" : "T1";
  return component(
    "execution-tier",
    ceiling,
    `the selected challenge was admitted at tier ${manifest.tier}`,
  );
}

/**
 * Non-blind selection means the Lab chose which case to run knowing what it
 * was. That is a fine way to prove a mechanism and no way at all to prove a
 * capability generalises.
 */
function selectionAssuranceComponent(assurance: SelectionAssuranceV1 | undefined): ClaimScopeComponent {
  if (assurance === undefined) {
    return inapplicable(
      "selection-assurance",
      "this terminal variant runs no selection, so there is no selection assurance to constrain",
    );
  }
  return assurance.mode === "blind_or_held_out"
    ? component("selection-assurance", "T3", "role-separated threshold selection")
    : component(
        "selection-assurance",
        "T1",
        "non-blind development selection: the case was chosen with full visibility",
      );
}

/**
 * Whether anything real was measured.
 *
 * A fake driver is a fixture. Its resources, probes and evidence sources are
 * constants, so a run against it demonstrates that the Lab's mechanism closes
 * and demonstrates nothing whatever about an ecosystem. A real driver earns
 * robustness evidence — never regression evidence, which is a claim about
 * *history* and not about infrastructure — and only when it is enabled and its
 * substrate is governed by a qualified lock.
 */
function environmentRealismComponent(index: ArtifactIndex, hasEnvironment: boolean): ClaimScopeComponent {
  if (!hasEnvironment) {
    return inapplicable("environment-realism", "no environment was provisioned");
  }
  const manifests = index.ofSchema("environment-driver-manifest/v1");
  const manifest = manifests[0] as { value: Record<string, unknown> } | undefined;
  if (manifests.length !== 1 || manifest === undefined) {
    return component(
      "environment-realism",
      "T1",
      "the driver this run used cannot be established from exactly one retained manifest",
    );
  }
  const driver = manifest.value as unknown as EnvironmentDriverManifestV1;
  if (driver.driver_kind === "fake") {
    return component(
      "environment-realism",
      "T1",
      `driver ${driver.driver_id} is a fake driver: a deterministic fixture, not an ecosystem`,
    );
  }
  if (!driver.enabled) {
    return component("environment-realism", "T1", `driver ${driver.driver_id} is disabled`);
  }
  const bindings = index.ofSchema("substrate-binding/v1");
  const binding = bindings[0] as { value: Record<string, unknown> } | undefined;
  const lockHash =
    bindings.length === 1 && binding !== undefined
      ? (binding.value as unknown as SubstrateBindingV1).substrate_lock_hash
      : undefined;
  if (lockHash === undefined) {
    return component(
      "environment-realism",
      "T1",
      `driver ${driver.driver_id} operated a substrate no qualified lock governs`,
    );
  }
  return component(
    "environment-realism",
    "T2",
    `driver ${driver.driver_id} on a locked substrate: robustness evidence, never regression evidence`,
  );
}

/**
 * Whether the subject was contained while it ran.
 *
 * An uncontained subject can read whatever the operator can read, so a run's
 * outcome is not attributable to the subject alone. The report is derived, not
 * asserted (ADR-ERL2-017), and its absence is the fail-closed reading: a
 * containment nobody qualified is not a containment.
 */
function containmentComponent(index: ArtifactIndex): ClaimScopeComponent {
  const reports = index.ofSchema("isolation-qualification-report/v1");
  const report = reports[0] as { value: Record<string, unknown> } | undefined;
  if (reports.length !== 1 || report === undefined) {
    return component(
      "subject-containment",
      "T1",
      "no isolation qualification report is retained; the subject ran under a profile nothing " +
        "qualified",
    );
  }
  const verdict = (report.value as unknown as IsolationQualificationReportV1).verdict;
  return verdict === "qualified"
    ? component("subject-containment", "T3", "the execution profile qualified")
    : component("subject-containment", "T1", `the execution profile derived ${verdict}`);
}

/**
 * Whether the domain plane was evaluated at all.
 *
 * `DomainResultNotApplicableV1` means no functional outcome was measured. There
 * is no scale on which "we measured nothing" is robustness or regression
 * evidence, and the reason it says so is retained, so the constraint is
 * checkable rather than inferred.
 */
function domainComponent(index: ArtifactIndex, roles: Map<string, Hash[]>): ClaimScopeComponent {
  const hashes = roles.get("domain-result") ?? [];
  if (hashes.length !== 1) {
    return component(
      "domain-evaluation",
      "T1",
      `${String(hashes.length)} domain results; a terminal carries exactly one`,
    );
  }
  const artifact = index.get(hashes[0] as Hash);
  const schema = artifact.value["schema_version"];
  if (schema === "domain-result-not-applicable/v1") {
    return component(
      "domain-evaluation",
      "T1",
      `the domain plane was not evaluated (${String(artifact.value["reason"])})`,
    );
  }
  const status = artifact.value["status"];
  if (status !== "evaluated") {
    return component("domain-evaluation", "T1", `the domain result is ${String(status)}`);
  }
  return component("domain-evaluation", "T3", "the domain plane was evaluated");
}

/**
 * The metric ceilings the run's own measurements carry, combined
 * conservatively.
 *
 * Each `MetricDefinitionV1` declares the strongest claim its metric can support,
 * and `MetricResultV1` carries it forward. A run is no stronger than its
 * weakest *applicable* measurement:
 *
 *  - `measured` counts, at its declared `claim_ceiling`;
 *  - `inconclusive` counts, at T1: a measurement that concluded nothing cannot
 *    support a stronger claim than one that concluded something;
 *  - `not_applicable` is excluded, because a metric that did not apply is not a
 *    weak result — it is not a result;
 *  - a `hard_safety` metric whose threshold is not satisfied caps at T1
 *    unconditionally. Design v2 §17 makes hard safety non-tradeable, and
 *    claim-scope capping is the route the design gives it.
 */
function metricComponent(index: ArtifactIndex, roles: Map<string, Hash[]>): ClaimScopeComponent {
  const hashes = roles.get("metric-result") ?? [];
  if (hashes.length === 0) {
    return inapplicable("metric-ceilings", "this run froze no metric result");
  }
  let ceiling: ClaimScope = MAX_BASE_CLAIM_SCOPE;
  let applicable = 0;
  const notes: string[] = [];
  for (const hash of hashes) {
    const metric = index.typed<MetricResultV1>(hash, "metric-result/v1");
    if (metric.threshold_class === "hard_safety" && metric.threshold_satisfied === false) {
      return component(
        "metric-ceilings",
        "T1",
        `hard-safety metric ${metric.metric_id} did not satisfy its threshold`,
      );
    }
    if (metric.status === "not_applicable") continue;
    applicable += 1;
    const contributed = metric.status === "inconclusive" ? "T1" : metric.claim_ceiling;
    if (claimScopeRank(contributed) < claimScopeRank(ceiling)) {
      notes.length = 0;
      notes.push(`${metric.metric_id} (${metric.status}) caps at ${contributed}`);
      ceiling = contributed;
    } else if (contributed === ceiling) {
      notes.push(`${metric.metric_id} (${metric.status})`);
    }
  }
  if (applicable === 0) {
    return inapplicable(
      "metric-ceilings",
      `all ${String(hashes.length)} retained metrics are not_applicable`,
    );
  }
  return component(
    "metric-ceilings",
    ceiling,
    `${String(applicable)} applicable metrics, weakest ceiling ${ceiling}: ${notes.slice(0, 3).join("; ")}`,
  );
}

/**
 * Regression and historical-reproduction evidence.
 *
 * T3 is the design's *regression* level (design v2 §25, implementation plan
 * §3.1: "OSS time-machine extension — T3 historical reproduction only"). It
 * needs a historical case, a pre-fix/fix archive, an evidence mirror and a
 * cutoff-reachability manifest, and none of those is a contract in this
 * repository: Slice 12 owns them. So this component's evidence is *structurally*
 * absent, and it caps at T2 for every run this build can produce.
 *
 * That is deliberately a derivation and not a constant `if (true) return "T2"`:
 * when the Slice 12 contracts exist, this function reads them, and until they
 * do it says exactly why it cannot.
 */
function regressionComponent(index: ArtifactIndex): ClaimScopeComponent {
  const reproductions = index.ofSchema("historical-reproduction-record/v1");
  if (reproductions.length === 0) {
    return component(
      "regression-evidence",
      "T2",
      "no historical-reproduction evidence is retained; T3 is the design's regression level and " +
        "its evidence contracts belong to slice 12",
    );
  }
  return component(
    "regression-evidence",
    "T3",
    `${String(reproductions.length)} historical reproductions retained`,
  );
}

// -- the derivation ----------------------------------------------------------

export interface DeriveClaimCeilingOptions {
  readonly index: ArtifactIndex;
  readonly lifecycle: readonly LabLifecycleEventV1[];
  readonly terminalVariant: "pre_environment" | "environment";
  /**
   * The attestation's selection assurance, when the variant has one.
   *
   * Read from the attestation rather than re-derived: it is a *signed* member of
   * the attestation itself, and the selection chain it summarises is verified
   * separately by `deriveSelectionEvidence`. What matters here is that a
   * non-blind assurance cannot be talked up into a blind one, and for that the
   * attestation's own copy is the right input.
   */
  readonly selectionAssurance?: SelectionAssuranceV1;
}

/**
 * Derives the strongest claim this run's retained evidence supports.
 *
 * Pure over the retained bytes and the hash-chained lifecycle: two readers
 * holding the same artifact root derive the same ceiling, which is what makes
 * the producer's choice checkable rather than merely declared.
 */
export function deriveClaimCeiling(options: DeriveClaimCeilingOptions): ClaimCeilingReport {
  const roles = rolesOf(options.lifecycle);
  const hasEnvironment = options.terminalVariant === "environment";
  return combineClaimScopeComponents([
    terminalVariantComponent(options.terminalVariant),
    tierComponent(options.index, roles),
    selectionAssuranceComponent(options.selectionAssurance),
    environmentRealismComponent(options.index, hasEnvironment),
    containmentComponent(options.index),
    domainComponent(options.index, roles),
    metricComponent(options.index, roles),
    regressionComponent(options.index),
  ]);
}

/**
 * Refuses a claim stronger than the evidence.
 *
 * Used by the producer against `--claim-scope` before anything is signed, and
 * again — independently, from retained bytes alone — by the offline verifier
 * against the scope that *was* signed. A lower scope than the ceiling is
 * accepted on both sides: under-claiming is honest, and an operator who wants to
 * say less than the evidence permits is never refused.
 */
export function assertClaimScopeWithinCeiling(options: {
  readonly claimScope: ClaimScope;
  readonly report: ClaimCeilingReport;
  readonly who: string;
}): void {
  if (!claimScopeExceeds(options.claimScope, options.report.ceiling)) return;
  const binding = options.report.components
    .filter((entry) => options.report.binding.includes(entry.component_id))
    .map((entry) => `${entry.component_id}: ${entry.observed}`);
  throw new Erl2Error(
    CODES.POLICY_CLAIM_SCOPE_EXCEEDS_EVIDENCE,
    `${options.who} claims ${options.claimScope}, but this run's own retained evidence supports at ` +
      `most ${options.report.ceiling} — ${binding.join("; ")}`,
    { owner: "lab" },
  );
}
