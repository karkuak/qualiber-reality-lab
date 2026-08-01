/**
 * The verifier's **own** derivation of a terminal's signer inventory
 * (ADR-ERL2-030; design v2 §14 step 7 — *independently compute signer inventory
 * for valid branches*).
 *
 * ## The direction nothing checked
 *
 * `verifySignedMembers` is strong in one direction: every retained file carrying
 * an authority-bearing signature is verified under a verifier-owned role table,
 * an undeclared signed contract is refused outright, and every inventory entry
 * must name a retained artifact whose schema and key match it.
 *
 * What nothing checked is the other direction. An inventory that simply
 * **omits** an applicable signed member was accepted, and its own claim to be
 * complete is `complete_for_terminal_chain` — a `const: true` in the frozen
 * schema that the producer wrote unconditionally. So the inventory's central
 * property, the one a reader consults it for, was the single unverified thing
 * about it: `lab_validity` again with a different field name (ADR-ERL2-029
 * §1.1).
 *
 * Measured before this derivation existed:
 *
 * | terminal | retained signed | applicable | listed |
 * |---|---|---|---|
 * | `valid-pre-environment-run` (fixture-built) | 9 | 7 | **1** |
 * | `generic-finalization-*` (CLI-produced) | 9 | 7 | **6** |
 * | environment terminal (CLI-produced) | 66 | 63 | **61** |
 *
 * and every one of them asserted `complete_for_terminal_chain: true`.
 *
 * ## What the expected set is derived from
 *
 * The retained evidence, this package's own `SIGNED_MEMBER_RULES`, the authority
 * field each *frozen schema* declares, the terminal variant and the acyclic
 * boundary. Never from the inventory's entries, never from the producer's
 * derivation, and never from `complete_for_terminal_chain`, which is not read
 * anywhere in this file.
 */

import { CODES, Erl2Error, type Hash, type LabLifecycleEventV1 } from "@erl2/contracts";
import type { TrustEvaluator } from "@erl2/integrity";
import type { ArtifactIndex } from "./artifactIndex.js";
import { authoritySignatureOf, signedMemberRuleFor } from "./signedMembers.js";

/** A signer-inventory entry as the verifier reads it — evidence, never authority. */
export interface InventoryEntryView {
  readonly artifact_schema_version: string;
  readonly artifact_core_hash: string;
  readonly signer_key_id: string;
  readonly signature_sha256: string;
  readonly security_timestamp: string;
}

export interface ExpectedSignedMember {
  readonly logicalPath: string;
  readonly coreHash: Hash;
  readonly schemaVersion: string;
  readonly signerRole: string;
  readonly signerKeyId: string;
  readonly signedHash: string;
}

/**
 * The deterministic completeness report.
 *
 * Deliberately **internal**. Adding it to `TrustVerificationReportV2` would
 * change a frozen contract to carry a diagnostic, which ADR-ERL2-030 §7 refuses;
 * it is returned so tests and callers can read the derivation, and it is what the
 * refusal messages quote.
 */
export interface SignerInventoryCompletenessReport {
  readonly terminalVariant: "pre_environment" | "environment";
  readonly excludedTypes: readonly string[];
  readonly retainedSignedMembers: number;
  readonly expected: readonly string[];
  readonly listed: readonly string[];
  readonly missing: readonly string[];
  readonly extra: readonly string[];
  readonly duplicates: readonly string[];
  readonly roleMismatches: readonly string[];
  readonly reachabilityFailures: readonly string[];
  readonly complete: boolean;
}

/**
 * The inventory can never carry an entry for itself.
 *
 * An entry names an artifact by `core_hash`, so an entry for the inventory would
 * change the very hash the entry names — the applicable set has no fixpoint that
 * includes it. ADR-ERL2-029 §4.1 stated the applicable set with three conditions
 * and omitted this one; ADR-ERL2-030 §3.2 records the omission and closes it,
 * rather than treating it as licence to omit anything else.
 */
export const SELF_REFERENTIAL_INVENTORY_SCHEMA = "signer-inventory/v2";

/**
 * The acyclic boundary, per terminal variant, **owned by the verifier**.
 *
 * Each exclusion is a fact about ordering rather than a preference: the final
 * attestation is sealed after the inventory and binds its hash, so an inventory
 * covering it could not exist; the environment selection verification receipt
 * travels in the public bundle, so a reader holds it independently. Both are
 * pinned by the frozen schema as a fixed tuple per variant, which is why the
 * verifier can supply them from the variant it derived rather than reading the
 * producer's list.
 *
 * The public bundle is absent because it carries no signature at all: it is a
 * container of already-signed members, bound by hash, and is therefore never an
 * applicable signed member under any variant.
 */
export function excludedTerminalTypesFor(
  variant: "pre_environment" | "environment",
): readonly string[] {
  return variant === "pre_environment"
    ? ["pre-environment-final-lab-attestation/v1"]
    : ["selection-verification-receipt/v2", "environment-final-lab-attestation/v1"];
}

const identityOf = (schemaVersion: string, coreHash: string): string => `${schemaVersion}@${coreHash}`;

/**
 * The run a signed contract belongs to, when it declares one.
 *
 * Most contracts carry a top-level `run_id`. The timestamp checkpoint carries
 * its run under `context.run_id`, because a checkpoint is a log entry about a
 * run rather than an artifact of it. A contract with neither is genuinely not
 * run-scoped (the trust policy manifest, the registry-supplied policies and
 * manifests admitted at preregistration), and is bound to the terminal by the
 * closure and by the pinned trust head instead.
 */
function declaredRunIdOf(value: Record<string, unknown>): string | undefined {
  const direct = value["run_id"];
  if (typeof direct === "string") return direct;
  const context = value["context"];
  if (context !== null && typeof context === "object" && !Array.isArray(context)) {
    const nested = (context as Record<string, unknown>)["run_id"];
    if (typeof nested === "string") return nested;
  }
  return undefined;
}

/**
 * Every applicable signed member of the terminal, derived from retained bytes.
 *
 * Applicability is exactly ADR-ERL2-030 §3.2: a retained **file** (not one
 * representative per core hash — a signature is excluded from the core, so two
 * files can agree on every hashed byte and disagree on their authority) that
 * carries the authority-bearing signature its registered contract declares,
 * whose schema this verifier declares a role for, and whose schema is neither a
 * public terminal type of this variant nor the inventory's own.
 */
export function deriveExpectedSignedMembers(input: {
  readonly index: ArtifactIndex;
  readonly excludedTypes: readonly string[];
}): readonly ExpectedSignedMember[] {
  const excluded = new Set<string>([...input.excludedTypes, SELF_REFERENTIAL_INVENTORY_SCHEMA]);
  const expected: ExpectedSignedMember[] = [];
  for (const artifact of input.index.retainedFiles()) {
    const found = authoritySignatureOf(artifact);
    if (found === undefined) continue;
    // An undeclared signed contract is also refused by `verifySignedMembers`,
    // which runs first. Refusing again rather than skipping keeps this
    // derivation independently fail-closed: it must never be the pass that waves
    // a contract through because another pass was expected to catch it.
    const rule = signedMemberRuleFor(artifact.schemaVersion);
    if (rule === undefined) {
      throw new Erl2Error(
        CODES.TRUST_SIGNATURE_INVALID,
        `retained artifact ${artifact.logicalPath} carries a ${found.field} for ${artifact.schemaVersion}, ` +
          `a contract this verifier declares no authorized signer role for`,
      );
    }
    if (excluded.has(artifact.schemaVersion)) continue;
    expected.push({
      logicalPath: artifact.logicalPath,
      coreHash: artifact.coreHash,
      schemaVersion: artifact.schemaVersion,
      signerRole: rule.role,
      signerKeyId: found.signature.key_id,
      signedHash: found.signature.signed_hash,
    });
  }
  return [...expected].sort((a, b) => a.coreHash.localeCompare(b.coreHash));
}

/**
 * Compares the independently derived expected set with the retained inventory,
 * **bijectively**.
 *
 * Every divergence is a separate refusal reached by a separate rule, so a
 * mutation battery can prove which one it exercised:
 *
 * | divergence | refusal |
 * |---|---|
 * | an applicable member with no entry | `INVENTORY_ENTRY_MISSING` |
 * | an entry for an inapplicable, excluded or non-retained artifact | `INVENTORY_ENTRY_EXTRA` |
 * | two entries for one artifact core hash | `INVENTORY_ENTRY_EXTRA` |
 * | an entry whose schema, key or signature hash contradicts the artifact | `INVENTORY_ENTRY_MISMATCH` |
 * | an entry whose key is not granted the contract's role | `TRUST_KEY_NOT_AUTHORIZED_FOR_ROLE` |
 * | a member belonging to another run | `GRAPH_CLOSURE_TERMINAL_MISMATCH` |
 * | a member the lifecycle never reached | `GRAPH_CLOSURE_UNREACHABLE_ARTIFACT` |
 *
 * A **false** `complete_for_terminal_chain` needs no rule of its own: the field
 * is never read, so an inventory that omits a member is refused by the
 * derivation rather than by disagreeing with a boolean.
 */
export function verifySignerInventoryCompleteness(input: {
  readonly index: ArtifactIndex;
  readonly trust: TrustEvaluator;
  readonly lifecycle: readonly LabLifecycleEventV1[];
  readonly runId: string;
  readonly terminalVariant: "pre_environment" | "environment";
  readonly inventoryEntries: readonly InventoryEntryView[];
  /** The run the retained inventory names — an inventory is run-scoped evidence. */
  readonly inventoryRunId: string;
  /** The inventory's own declared exclusions, checked against the variant's. */
  readonly declaredExcludedTypes: readonly string[];
}): SignerInventoryCompletenessReport {
  // An inventory is evidence *about a run*. Substituting another terminal's
  // inventory wholesale — bound into this attestation, so every hash agrees —
  // was otherwise only caught by whichever member hash happened not to resolve.
  if (input.inventoryRunId !== input.runId) {
    throw new Erl2Error(
      CODES.GRAPH_CLOSURE_TERMINAL_MISMATCH,
      `the signer inventory names run ${input.inventoryRunId}, but this terminal is run ${input.runId}`,
    );
  }
  const excludedTypes = excludedTerminalTypesFor(input.terminalVariant);
  // The excluded list is schema-fixed per variant, so the verifier supplies its
  // own and requires the retained one to equal it. Reading the inventory's list
  // as the boundary would let a producer widen its own exclusions and call the
  // result complete.
  if (
    input.declaredExcludedTypes.length !== excludedTypes.length ||
    input.declaredExcludedTypes.some((type, i) => type !== excludedTypes[i])
  ) {
    throw new Erl2Error(
      CODES.INVENTORY_ENTRY_EXTRA,
      `the signer inventory declares exclusions [${input.declaredExcludedTypes.join(", ")}], but a ` +
        `${input.terminalVariant} terminal excludes exactly [${excludedTypes.join(", ")}]`,
    );
  }

  const expected = deriveExpectedSignedMembers({ index: input.index, excludedTypes });
  const expectedByHash = new Map(expected.map((member) => [member.coreHash as string, member]));

  const reached = new Set<string>();
  for (const event of input.lifecycle) {
    for (const produced of event.produced) reached.add(produced.artifact_core_hash);
  }

  const listed: string[] = [];
  const duplicates: string[] = [];
  const extra: string[] = [];
  const seen = new Set<string>();
  for (const entry of input.inventoryEntries) {
    const identity = identityOf(entry.artifact_schema_version, entry.artifact_core_hash);
    listed.push(identity);
    if (seen.has(entry.artifact_core_hash)) duplicates.push(identity);
    seen.add(entry.artifact_core_hash);
    if (!expectedByHash.has(entry.artifact_core_hash)) extra.push(identity);
  }
  const missing = expected
    .filter((member) => !seen.has(member.coreHash))
    .map((member) => identityOf(member.schemaVersion, member.coreHash));

  const reachabilityFailures: string[] = [];
  const foreignRunMembers: string[] = [];
  for (const member of expected) {
    if (signedMemberRuleFor(member.schemaVersion)?.externallyAnchored !== true && !reached.has(member.coreHash)) {
      reachabilityFailures.push(identityOf(member.schemaVersion, member.coreHash));
    }
    const declaredRunId = declaredRunIdOf(input.index.get(member.coreHash).value);
    if (declaredRunId !== undefined && declaredRunId !== input.runId) {
      foreignRunMembers.push(`${member.logicalPath} (run ${declaredRunId})`);
    }
  }

  const roleMismatches: string[] = [];
  for (const entry of input.inventoryEntries) {
    const member = expectedByHash.get(entry.artifact_core_hash);
    if (member === undefined) continue;
    if (entry.signer_key_id !== member.signerKeyId) {
      roleMismatches.push(identityOf(entry.artifact_schema_version, entry.artifact_core_hash));
    }
  }

  const report: SignerInventoryCompletenessReport = {
    terminalVariant: input.terminalVariant,
    excludedTypes,
    retainedSignedMembers: input.index
      .retainedFiles()
      .filter((artifact) => authoritySignatureOf(artifact) !== undefined).length,
    expected: expected.map((member) => identityOf(member.schemaVersion, member.coreHash)),
    listed,
    missing,
    extra,
    duplicates,
    roleMismatches,
    reachabilityFailures,
    complete: false,
  };

  // Ordered so the most fundamental cause survives. A member from another run,
  // or one the run never reached, is a worse defect than a bookkeeping
  // divergence and must not be reported as a missing entry.
  if (foreignRunMembers.length > 0) {
    throw new Erl2Error(
      CODES.GRAPH_CLOSURE_TERMINAL_MISMATCH,
      `${String(foreignRunMembers.length)} retained signed member(s) belong to another run, not to ` +
        `${input.runId}: ${foreignRunMembers.join(", ")}`,
    );
  }
  if (reachabilityFailures.length > 0) {
    throw new Erl2Error(
      CODES.GRAPH_CLOSURE_UNREACHABLE_ARTIFACT,
      `${String(reachabilityFailures.length)} retained signed member(s) were never reached by the ` +
        `lifecycle: ${reachabilityFailures.join(", ")}`,
    );
  }
  if (duplicates.length > 0) {
    throw new Erl2Error(
      CODES.INVENTORY_ENTRY_EXTRA,
      `the signer inventory lists ${duplicates.join(", ")} more than once; an applicable member is ` +
        `inventoried exactly once`,
    );
  }
  if (extra.length > 0) {
    throw new Erl2Error(
      CODES.INVENTORY_ENTRY_EXTRA,
      `the signer inventory lists ${extra.join(", ")}, which is not an applicable signed member of ` +
        `this terminal`,
    );
  }
  if (missing.length > 0) {
    throw new Erl2Error(
      CODES.INVENTORY_ENTRY_MISSING,
      `the signer inventory omits ${String(missing.length)} of ${String(expected.length)} applicable ` +
        `signed member(s): ${missing.join(", ")}`,
    );
  }

  // The bijection holds; now every entry must agree with the artifact it names,
  // in every field the entry asserts about it.
  for (const entry of input.inventoryEntries) {
    const member = expectedByHash.get(entry.artifact_core_hash) as ExpectedSignedMember;
    if (entry.artifact_schema_version !== member.schemaVersion) {
      throw new Erl2Error(
        CODES.INVENTORY_ENTRY_MISMATCH,
        `signer inventory declares ${entry.artifact_schema_version} for an artifact that is ${member.schemaVersion}`,
      );
    }
    if (entry.signer_key_id !== member.signerKeyId) {
      throw new Erl2Error(
        CODES.INVENTORY_ENTRY_MISMATCH,
        `signer inventory declares signer ${entry.signer_key_id} for ${member.logicalPath}, ` +
          `which is signed by ${member.signerKeyId}`,
      );
    }
    if (entry.signature_sha256 !== member.signedHash) {
      throw new Erl2Error(
        CODES.INVENTORY_ENTRY_MISMATCH,
        `signer inventory declares a signature over ${entry.signature_sha256} for ${member.logicalPath}, ` +
          `whose authority signature covers ${member.signedHash}`,
      );
    }
    // The role is the verifier's, never the entry's: an entry carries a key id
    // and nothing else, so "this key may sign this contract" is re-decided here
    // under the pinned policy rather than inherited from the producer's choice.
    input.trust.assertRole(entry.signer_key_id, member.signerRole as never);
    input.trust.evaluate(entry.signer_key_id, entry.security_timestamp);
  }

  return { ...report, complete: true };
}
