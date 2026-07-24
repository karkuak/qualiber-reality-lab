/**
 * The journey oracle partition (design v2 §10, ERL2-FR-015).
 *
 * A logical step is split before admission into two different closed contracts:
 *
 *   - `SubjectVisibleJourneyStepV1` — intent, persona role, permitted
 *     interaction kinds, visible prerequisites and inputs, retry and timeout.
 *     This is the only thing an adapter ever sees.
 *   - `JudgeJourneyExpectationV1` — success observations, proof predicates,
 *     failure-attribution constraints and the earliest reveal phase. It is
 *     encrypted to the judge with age-x25519 and never leaves that boundary
 *     before the permitted reveal.
 *
 * `JourneyStepCommitmentV1` binds the visible-step core hash to the judge
 * expectation's plaintext core hash and ciphertext file digest, so an adapter
 * can verify it is executing the committed visible step without being able to
 * recover the expectation.
 *
 * Every expectation carries a unique canary token. `oracle.ts` scans every
 * adapter-visible surface for it.
 */

import { randomBytes } from "node:crypto";
import {
  assertContract,
  CODES,
  Erl2Error,
  type ArtifactRef,
  type Hash,
  type JourneyIntent,
  type JourneyStepCommitmentV1,
  type JudgeJourneyExpectationV1,
  type SubjectVisibleJourneyStepV1,
} from "@erl2/contracts";
import {
  ageEncrypt,
  ArtifactStore,
  coreHash,
  hashBytes,
  jcsBytes,
  sealSigned,
  type AgeRecipient,
  type SigningKey,
} from "@erl2/integrity";

/** Generates a fresh oracle canary token. */
export function newCanaryId(random: (n: number) => Buffer = randomBytes): string {
  return `erl2-canary-${random(16).toString("hex")}`;
}

export interface VisibleStepInput {
  readonly stepId: string;
  readonly intent: JourneyIntent;
  readonly actorRole: string;
  readonly interactionKinds: readonly ("cli" | "api" | "ui" | "file" | "documentation")[];
  readonly visiblePrerequisiteIds?: readonly string[];
  readonly visibleInputRefs?: readonly Hash[];
  readonly timeoutMs: number;
  readonly maxAttempts: number;
  readonly backoffId: string;
  readonly compensationIntent?: string;
}

export interface JudgeExpectationInput {
  readonly expectedObservations: readonly {
    readonly observation_id: string;
    readonly predicate_id: string;
    readonly required: boolean;
    readonly proof_source_ids: readonly string[];
  }[];
  readonly permittedFailureCategories: readonly string[];
  readonly attributionRequirements: readonly Hash[];
  readonly truthScope: "journey_only" | "functional";
  readonly canaryId?: string;
}

export interface CommittedStep {
  readonly visibleStep: SubjectVisibleJourneyStepV1;
  readonly visibleStepHash: Hash;
  readonly visibleStepRef: ArtifactRef;
  readonly commitment: JourneyStepCommitmentV1;
  readonly commitmentHash: Hash;
  readonly ciphertextRef: ArtifactRef;
  /** Retained by the judge/vault only; never published or handed to an adapter. */
  readonly judgeExpectation: JudgeJourneyExpectationV1;
  readonly canaryId: string;
}

export interface CommitStepOptions {
  readonly visible: VisibleStepInput;
  readonly expectation: JudgeExpectationInput;
  readonly store: ArtifactStore;
  readonly recipients: readonly AgeRecipient[];
  readonly governorKey: SigningKey;
  readonly committedAt: string;
  readonly random?: (n: number) => Buffer;
}

/**
 * Builds the visible step, the judge expectation and their commitment, and
 * freezes the ciphertext.
 *
 * The plaintext expectation is returned to the caller (the judge/vault side)
 * but is never written to the run's artifact store: only the ciphertext is.
 */
export function commitJourneyStep(options: CommitStepOptions): CommittedStep {
  const visibleBase = {
    schema_version: "subject-visible-journey-step/v1" as const,
    step_id: options.visible.stepId,
    intent: options.visible.intent,
    actor_role: options.visible.actorRole,
    interaction_kinds: [...options.visible.interactionKinds],
    visible_prerequisite_ids: [...(options.visible.visiblePrerequisiteIds ?? [])],
    visible_input_refs: [...(options.visible.visibleInputRefs ?? [])],
    timeout_ms: options.visible.timeoutMs,
    retry_policy: {
      max_attempts: options.visible.maxAttempts,
      backoff_id: options.visible.backoffId,
    },
    ...(options.visible.compensationIntent === undefined
      ? {}
      : { compensation_intent: options.visible.compensationIntent }),
  };
  const visibleStep = assertContract<SubjectVisibleJourneyStepV1>("SubjectVisibleJourneyStepV1", {
    ...visibleBase,
    core_hash: coreHash(visibleBase),
  });
  const visibleStepHash = visibleStep.core_hash;
  const visibleStepRef = options.store.freezeJson(
    `commitments/visible-steps/${options.visible.stepId}.json`,
    visibleStep,
    "PUBLIC",
  );

  const canaryId = options.expectation.canaryId ?? newCanaryId(options.random ?? randomBytes);
  const expectationBase = {
    schema_version: "judge-journey-expectation/v1" as const,
    step_id: options.visible.stepId,
    visible_step_hash: visibleStepHash,
    expected_observations: options.expectation.expectedObservations.map((o) => ({
      observation_id: o.observation_id,
      predicate_id: o.predicate_id,
      required: o.required,
      proof_source_ids: [...o.proof_source_ids],
    })),
    permitted_failure_categories: [...options.expectation.permittedFailureCategories],
    attribution_requirements: [...options.expectation.attributionRequirements],
    earliest_reveal: "after_subject_output_freeze" as const,
    truth_scope: options.expectation.truthScope,
    oracle_canary_id: canaryId,
  };
  const judgeExpectation = assertContract<JudgeJourneyExpectationV1>("JudgeJourneyExpectationV1", {
    ...expectationBase,
    core_hash: coreHash(expectationBase),
  });

  const plaintext = jcsBytes(judgeExpectation);
  const ciphertext = ageEncrypt(plaintext, options.recipients, options.random);
  if (ciphertext.toString("latin1").includes(canaryId)) {
    /* c8 ignore next 4 */
    throw new Erl2Error(
      "JOURNEY_ORACLE_CANARY_LEAKED",
      "the judge expectation ciphertext exposes its canary in cleartext",
    );
  }
  const ciphertextRef = options.store.freeze({
    logicalPath: `commitments/judge-expectations/${options.visible.stepId}.age`,
    bytes: ciphertext,
    mediaType: "application/octet-stream",
    classification: "SECRET",
  });

  const commitment = assertContract<JourneyStepCommitmentV1>(
    "JourneyStepCommitmentV1",
    sealSigned(
      {
        schema_version: "journey-step-commitment/v1" as const,
        step_id: options.visible.stepId,
        visible_step_hash: visibleStepHash,
        judge_expectation_core_hash: judgeExpectation.core_hash,
        judge_expectation_plaintext_file_sha256: hashBytes(plaintext),
        judge_expectation_ciphertext: ciphertextRef,
        encryption: "age-x25519" as const,
        recipient_key_ids: options.recipients.map((r) => r.keyId),
        committed_at: options.committedAt,
      },
      options.governorKey,
    ),
  );

  return {
    visibleStep,
    visibleStepHash,
    visibleStepRef,
    commitment,
    commitmentHash: commitment.core_hash,
    ciphertextRef,
    judgeExpectation,
    canaryId,
  };
}

/**
 * An adapter may verify it is executing the committed visible step. It cannot
 * learn anything about the expectation from this check.
 */
export function assertVisibleStepMatchesCommitment(
  visibleStep: SubjectVisibleJourneyStepV1,
  commitment: JourneyStepCommitmentV1,
): void {
  if (coreHash(visibleStep) !== commitment.visible_step_hash) {
    throw new Erl2Error(
      CODES.REQUEST_ANCESTRY_INVALID,
      `visible step ${visibleStep.step_id} does not match its commitment`,
    );
  }
  if (visibleStep.step_id !== commitment.step_id) {
    throw new Erl2Error(
      CODES.REQUEST_ANCESTRY_INVALID,
      "visible step and commitment name different steps",
    );
  }
}
