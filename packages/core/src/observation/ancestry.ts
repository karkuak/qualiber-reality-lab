/**
 * Compact request ancestry for `subject-adapter/v2` local observation.
 *
 * `AdapterRequestAncestryV2.predecessor` is a five-field summary of the
 * operation that ran immediately before: its id, the hash of its operation
 * record, the hash of its request, its outcome, and — for a completed exchange
 * — the hash of the response envelope. It is deliberately not the operation
 * record itself. The record is large, carries evidence references, and grows;
 * a summary that the next request can carry is what makes the chain checkable
 * without making every later request quote every earlier one.
 *
 * A previous version of the public runner passed the entire terminal record
 * here. That is a closed-schema violation, so the second operation of every
 * plan refused with `SCHEMA_VALIDATION_FAILED` and no multi-operation plan
 * could run at all. This module exists so the compact form is derived in one
 * place, from the record the coordinator actually retained, rather than
 * assembled by each caller.
 */

import {
  CODES,
  Erl2Error,
  assertContract,
  type AdapterRequestPredecessorV2,
  type LocalObservationOperationRecordV1,
} from "@erl2/contracts";

/** The terminal states an operation record can end in. */
type TerminalRecord = Extract<
  LocalObservationOperationRecordV1,
  { readonly state: "completed" | "failed" | "ambiguous_not_replayed" }
>;

/**
 * Derives the compact predecessor for the operation that follows `previous`.
 *
 * The three outcomes are three different shapes in the contract, and each is
 * built explicitly rather than by filling one object and deleting fields:
 *
 *   - `completed` carries the response envelope hash, because there was one;
 *   - `failed` omits it, because the exchange produced no envelope;
 *   - `ambiguous_not_replayed` carries an explicit `null`, because the Lab
 *     does not know whether an envelope existed and says so rather than
 *     leaving the field out.
 */
export function compactPredecessorOf(
  previous: LocalObservationOperationRecordV1,
): AdapterRequestPredecessorV2 {
  if (!isTerminal(previous)) {
    throw new Erl2Error(
      CODES.ADAPTER_REQUEST_PREDECESSOR_INVALID,
      `operation ${previous.operation_id} has not reached a terminal state and cannot be a predecessor`,
    );
  }
  const common = {
    operation_id: previous.operation_id,
    operation_record_hash: previous.core_hash,
    request_hash: previous.request_hash,
  };
  const predecessor: AdapterRequestPredecessorV2 =
    previous.state === "completed"
      ? {
          ...common,
          outcome: "completed" as const,
          response_envelope_hash: previous.response_envelope_hash,
        }
      : previous.state === "failed"
        ? { ...common, outcome: "failed" as const }
        : { ...common, outcome: "ambiguous_not_replayed" as const, response_envelope_hash: null };
  return assertContract<AdapterRequestPredecessorV2>(
    "AdapterRequestPredecessorV2",
    predecessor,
  );
}

/**
 * Refuses a predecessor that is not exactly the one the run produced.
 *
 * The comparison is against a predecessor *derived here* from the retained
 * record, not against fields the caller supplied. That single equality is what
 * refuses an altered record hash, a reordered operation, an omitted one, a
 * duplicate, and a predecessor lifted from another run or another plan: none
 * of those can reproduce the compact form of the operation this coordinator
 * actually completed last.
 */
export function assertPredecessorMatches(
  supplied: AdapterRequestPredecessorV2 | null,
  expected: AdapterRequestPredecessorV2 | null,
  operationId: string,
): void {
  if (expected === null) {
    if (supplied !== null) {
      throw new Erl2Error(
        CODES.ADAPTER_REQUEST_PREDECESSOR_INVALID,
        `operation ${operationId} is first in its plan and must carry no predecessor`,
      );
    }
    return;
  }
  if (supplied === null) {
    throw new Erl2Error(
      CODES.ADAPTER_REQUEST_PREDECESSOR_INVALID,
      `operation ${operationId} follows ${expected.operation_id} and must carry its compact predecessor`,
    );
  }
  const suppliedKeys = Object.keys(supplied).sort();
  const expectedKeys = Object.keys(expected).sort();
  const same =
    suppliedKeys.length === expectedKeys.length &&
    suppliedKeys.every((key, index) => key === expectedKeys[index]) &&
    suppliedKeys.every(
      (key) =>
        (supplied as Record<string, unknown>)[key] ===
        (expected as Record<string, unknown>)[key],
    );
  if (!same) {
    throw new Erl2Error(
      CODES.ADAPTER_REQUEST_PREDECESSOR_INVALID,
      `operation ${operationId} carries a predecessor that is not the operation this run completed before it`,
    );
  }
}

function isTerminal(record: LocalObservationOperationRecordV1): record is TerminalRecord {
  return (
    record.state === "completed" ||
    record.state === "failed" ||
    record.state === "ambiguous_not_replayed"
  );
}
