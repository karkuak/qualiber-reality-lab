/**
 * `erl2 doctor`'s Compose-substrate section (ERL2-OQ-005).
 *
 * The same rule the isolation section follows: doctor re-derives the verdict
 * from the retained lock on every call and never repeats a stored one. Before
 * OQ-005 was qualified this was two hardcoded strings, which was accurate then
 * and would have gone on being reported after it stopped being true — a stored
 * verdict is exactly the thing doctor exists not to be.
 *
 * The signer's *classification* is part of the answer, not a footnote. A lock
 * signed by the repository's own development key is cryptographically valid and
 * is not an independent qualification, and doctor says both.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { assertContract, parseStrictJson, type SubstrateLockV1 } from "./contractsFacade.js";
import {
  assertSubstrateQualified,
  composeDriverManifestBody,
  verifySubstrateLockSignature,
} from "@erl2/core";
import { coreHash } from "@erl2/integrity";

/** Where the environment governor publishes the OTel Demo lock. */
export const OTEL_DEMO_LOCK_FILE = path.join("environments", "otel-demo", "substrate-lock.json");

export interface ComposeSubstrateStatus {
  /** The lock's own qualification state, as derived rather than as recorded. */
  readonly substrate_lock: string;
  /** Whether a Compose driver built from this lock would be admissible. */
  readonly driver: string;
  readonly lock_hash?: string;
  readonly signer_key_id?: string;
  /** `development_key`, `pinned_authority`, `invalid` or `absent`. */
  readonly signer_classification: string;
  readonly release_tag?: string;
  readonly source_commit?: string;
  readonly platforms?: readonly string[];
  readonly services?: readonly string[];
  readonly independently_qualified: boolean;
  readonly reason_code?: string;
}

const ABSENT: ComposeSubstrateStatus = {
  substrate_lock: "not_pinned",
  driver: "disabled_pending_erl2_oq_005",
  signer_classification: "absent",
  independently_qualified: false,
  reason_code: "SUBSTRATE_LOCK_NOT_PINNED",
};

export function composeSubstrateStatus(lockFile: string): ComposeSubstrateStatus {
  if (!existsSync(lockFile)) return ABSENT;
  let lock: SubstrateLockV1;
  try {
    lock = assertContract<SubstrateLockV1>("SubstrateLockV1", parseStrictJson(readFileSync(lockFile, "utf8")));
  } catch {
    return { ...ABSENT, substrate_lock: "unreadable", reason_code: "SUBSTRATE_LOCK_UNREADABLE" };
  }
  const signature = verifySubstrateLockSignature(lock);
  const classification = !signature.signatureValid
    ? "invalid"
    : signature.signerIsPinnedAuthority
      ? "pinned_authority"
      : "development_key";
  let qualified = true;
  let reasonCode: string | undefined;
  try {
    assertSubstrateQualified(lock);
  } catch (cause) {
    qualified = false;
    reasonCode = (cause as { code?: string }).code ?? "ENV_SUBSTRATE_LOCK_UNQUALIFIED";
  }
  const admissible = qualified && signature.signatureValid;
  const manifest = composeDriverManifestBody(lock, coreHash(lock));
  return {
    substrate_lock: qualified
      ? signature.signerIsPinnedAuthority
        ? "qualified_authenticated"
        : "qualified_development_signed"
      : "unqualified_pending_erl2_oq_005",
    driver:
      admissible && manifest.enabled
        ? signature.signerIsPinnedAuthority
          ? "enabled_by_qualified_lock"
          : "enabled_by_development_signed_lock"
        : "disabled_pending_erl2_oq_005",
    lock_hash: coreHash(lock),
    signer_key_id: signature.signerKeyId,
    signer_classification: classification,
    release_tag: lock.source_archive.release_tag,
    source_commit: lock.source_archive.source_commit,
    platforms: [...new Set(lock.images.map((image) => image.platform))].sort(),
    services: [...new Set(lock.images.map((image) => image.service_id))].sort(),
    // Never true for a development-signed lock, and the field exists so no
    // reader has to infer it from the signer id.
    independently_qualified: signature.signerIsPinnedAuthority,
    ...(reasonCode === undefined ? {} : { reason_code: reasonCode }),
  };
}
