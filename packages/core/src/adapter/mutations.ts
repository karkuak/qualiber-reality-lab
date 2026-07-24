/**
 * Mutation intent, receipt and compensation control (design v2 §11.2/§20,
 * ERL2-FR-006, ERL2-OPS-001, ERL2-AC-017).
 *
 * Every external mutation follows intent → receipt → event → snapshot. The
 * ledger below owns the first two and the reconciliation, and refuses:
 *
 *   - a receipt with no declared intent (hidden mutation);
 *   - an intent whose capability was never granted;
 *   - an intent whose target lies outside the permitted root;
 *   - a mutation with no compensation identity;
 *   - a compensation that names a different mutation or a different target;
 *   - a resume that leaves a succeeded mutation uncompensated and unreconciled.
 *
 * A hidden or undeclared mutation is an adapter/Lab integrity failure. It is
 * never recorded as a subject-quality result, because the subject did not
 * choose the adapter's disclosure behaviour.
 */

import {
  assertContract,
  CODES,
  Erl2Error,
  type AdapterCapabilityId,
  type CompensationReceiptV1,
  type Hash,
  type Instant,
  type MutationIntentV1,
  type MutationReceiptV1,
  type MutationClass,
} from "@erl2/contracts";
import { coreHash, domainHash, HASH_DOMAINS } from "@erl2/integrity";

export function mutationTargetHash(
  runId: string,
  mutationClass: string,
  targetDescriptor: string,
): Hash {
  return domainHash(HASH_DOMAINS.RESOURCE_IDENTITY, {
    kind: "adapter-mutation-target",
    run_id: runId,
    mutation_class: mutationClass,
    descriptor: targetDescriptor,
  });
}

export function stateHash(descriptor: string): Hash {
  return domainHash(HASH_DOMAINS.DRIVER_STATE, { descriptor });
}

export interface DeclaredMutation {
  readonly mutationId: string;
  readonly mutationClass: MutationClass;
  readonly capabilityId: AdapterCapabilityId;
  readonly targetDescriptor: string;
  readonly beforeStateDescriptor: string;
  readonly afterStateDescriptor: string;
  readonly compensationId: string;
  readonly compensationCapabilityId: AdapterCapabilityId;
  readonly status: "succeeded" | "failed";
  readonly errorCode?: string;
}

export interface DeclaredCompensation {
  readonly compensationId: string;
  readonly mutationId: string;
  readonly afterStateDescriptor: string;
  readonly status: "succeeded" | "failed" | "not_required";
  readonly reasonCode?: string;
}

interface LedgerEntry {
  readonly intent: MutationIntentV1;
  readonly receipt: MutationReceiptV1;
  compensation?: CompensationReceiptV1;
}

export interface MutationLedgerOptions {
  readonly runId: string;
  /** Descriptor prefixes an adapter is permitted to mutate. */
  readonly permittedTargetPrefixes: readonly string[];
  readonly grantedCapabilities: readonly string[];
}

export class MutationLedger {
  private readonly runId: string;
  private readonly permitted: readonly string[];
  private readonly granted: readonly string[];
  private readonly entries = new Map<string, LedgerEntry>();

  constructor(options: MutationLedgerOptions) {
    this.runId = options.runId;
    this.permitted = options.permittedTargetPrefixes;
    this.granted = options.grantedCapabilities;
  }

  /**
   * Records one declared mutation as an intent plus its receipt.
   *
   * The intent is derived from the same declaration as the receipt and frozen
   * first, so a receipt can never exist without one. The adapter supplies
   * descriptors, never hashes: identity is Lab-derived.
   */
  record(declared: DeclaredMutation, operationId: string, now: Instant): LedgerEntry {
    if (this.entries.has(declared.mutationId)) {
      throw new Erl2Error(
        CODES.ADAPTER_UNDECLARED_MUTATION,
        `mutation ${declared.mutationId} is declared twice`,
        { owner: "adapter" },
      );
    }
    if (!this.granted.includes(declared.capabilityId)) {
      throw new Erl2Error(
        CODES.ADAPTER_CAPABILITY_NOT_GRANTED,
        `mutation ${declared.mutationId} uses ungranted capability ${declared.capabilityId}`,
        { owner: "adapter" },
      );
    }
    if (!this.permitted.some((prefix) => declared.targetDescriptor.startsWith(prefix))) {
      throw new Erl2Error(
        CODES.ADAPTER_MUTATION_TARGET_NOT_PERMITTED,
        `mutation ${declared.mutationId} targets ${declared.targetDescriptor.slice(0, 128)}, which is outside the permitted roots`,
        { owner: "adapter" },
      );
    }
    if (declared.compensationId.length === 0) {
      throw new Erl2Error(
        CODES.ADAPTER_COMPENSATION_MISSING,
        `mutation ${declared.mutationId} declares no compensation identity`,
        { owner: "adapter" },
      );
    }

    const target = mutationTargetHash(this.runId, declared.mutationClass, declared.targetDescriptor);
    const intentBase = {
      schema_version: "mutation-intent/v1" as const,
      run_id: this.runId,
      operation_id: operationId,
      mutation_id: declared.mutationId,
      mutation_class: declared.mutationClass,
      capability_id: declared.capabilityId,
      target_identity_hash: target,
      target_descriptor: declared.targetDescriptor,
      before_state_hash: stateHash(declared.beforeStateDescriptor),
      compensation_id: declared.compensationId,
      compensation_capability_id: declared.compensationCapabilityId,
      declared_at: now,
    };
    const intent = assertContract<MutationIntentV1>("MutationIntentV1", {
      ...intentBase,
      core_hash: coreHash(intentBase),
    });

    const receiptBase = {
      schema_version: "mutation-receipt/v1" as const,
      run_id: this.runId,
      operation_id: operationId,
      mutation_id: declared.mutationId,
      mutation_intent_hash: intent.core_hash,
      capability_id: declared.capabilityId,
      target_identity_hash: target,
      before_state_hash: intent.before_state_hash,
      after_state_hash: stateHash(declared.afterStateDescriptor),
      status: declared.status,
      ...(declared.status === "failed"
        ? { error_code: declared.errorCode ?? CODES.ADAPTER_EXECUTION_FAULT }
        : {}),
      compensation_id: declared.compensationId,
      idempotency_key: coreHash({
        run_id: this.runId,
        mutation_id: declared.mutationId,
        target: target,
      }).slice("sha256:".length),
      started_at: now,
      ended_at: now,
    };
    const receipt = assertContract<MutationReceiptV1>("MutationReceiptV1", {
      ...receiptBase,
      core_hash: coreHash(receiptBase),
    });

    const entry: LedgerEntry = { intent, receipt };
    this.entries.set(declared.mutationId, entry);
    return entry;
  }

  /** Records the compensation that reverses a previously declared mutation. */
  compensate(declared: DeclaredCompensation, now: Instant): CompensationReceiptV1 {
    const entry = this.entries.get(declared.mutationId);
    if (!entry) {
      throw new Erl2Error(
        CODES.ADAPTER_COMPENSATION_TARGET_MISMATCH,
        `compensation ${declared.compensationId} names mutation ${declared.mutationId}, which was never declared`,
        { owner: "adapter" },
      );
    }
    if (entry.intent.compensation_id !== declared.compensationId) {
      throw new Erl2Error(
        CODES.ADAPTER_COMPENSATION_TARGET_MISMATCH,
        `mutation ${declared.mutationId} declared compensation ${entry.intent.compensation_id}, not ${declared.compensationId}`,
        { owner: "adapter" },
      );
    }
    const base = {
      schema_version: "compensation-receipt/v1" as const,
      run_id: this.runId,
      compensation_id: declared.compensationId,
      mutation_id: declared.mutationId,
      mutation_receipt_hash: entry.receipt.core_hash,
      target_identity_hash: entry.receipt.target_identity_hash,
      before_state_hash: entry.receipt.after_state_hash,
      after_state_hash: stateHash(declared.afterStateDescriptor),
      status: declared.status,
      ...(declared.status === "succeeded"
        ? {}
        : { reason_code: declared.reasonCode ?? "COMPENSATION_INCOMPLETE" }),
      compensated_at: now,
    };
    const receipt = assertContract<CompensationReceiptV1>("CompensationReceiptV1", {
      ...base,
      core_hash: coreHash(base),
    });
    entry.compensation = receipt;
    return receipt;
  }

  /**
   * Refuses a receipt for a mutation that was never declared.
   *
   * This is the hidden-mutation check: the host discovers a filesystem or
   * service change, asks the ledger whether it was declared, and gets a typed
   * refusal when it was not.
   */
  assertDeclared(mutationId: string, targetDescriptor: string): void {
    const entry = this.entries.get(mutationId);
    if (!entry) {
      throw new Erl2Error(
        CODES.ADAPTER_UNDECLARED_MUTATION,
        `an undeclared mutation ${mutationId.slice(0, 64)} was observed`,
        { owner: "adapter" },
      );
    }
    if (entry.intent.target_descriptor !== targetDescriptor) {
      throw new Erl2Error(
        CODES.ADAPTER_MUTATION_TARGET_NOT_PERMITTED,
        `mutation ${mutationId} was declared against a different target`,
        { owner: "adapter" },
      );
    }
  }

  /**
   * Reconciles the ledger after a crash or at the end of an operation.
   *
   * Every succeeded mutation must have a compensation receipt. A mutation that
   * succeeded and was never compensated leaves the environment changed with no
   * way back, which is exactly the state the design forbids reaching a terminal
   * from.
   */
  assertReconciled(): void {
    const outstanding = [...this.entries.values()].filter(
      (e) => e.receipt.status === "succeeded" && e.compensation === undefined,
    );
    if (outstanding.length > 0) {
      const first = outstanding[0] as LedgerEntry;
      throw new Erl2Error(
        CODES.ADAPTER_MUTATION_UNRECONCILED,
        `${String(outstanding.length)} succeeded mutation(s) have no compensation receipt, starting with ${first.receipt.mutation_id}`,
        { owner: "adapter" },
      );
    }
  }

  /** Mutations that succeeded but are not yet compensated, for crash resume. */
  outstandingMutationIds(): readonly string[] {
    return [...this.entries.values()]
      .filter((e) => e.receipt.status === "succeeded" && e.compensation === undefined)
      .map((e) => e.receipt.mutation_id)
      .sort();
  }

  all(): readonly LedgerEntry[] {
    return [...this.entries.values()];
  }

  receiptHashes(): readonly Hash[] {
    return this.all().map((e) => e.receipt.core_hash);
  }

  compensationHashes(): readonly Hash[] {
    return this.all()
      .map((e) => e.compensation?.core_hash)
      .filter((h): h is Hash => h !== undefined);
  }
}
