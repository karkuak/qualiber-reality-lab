/**
 * Narrow re-export surface the CLI is allowed to use from `@erl2/contracts`.
 *
 * Keeping it explicit means the core-purity scan has one place to check that
 * the CLI never reaches a product-specific contract or a development fixture.
 */

export {
  ADAPTER_PROTOCOL_VERSION,
  CODES,
  Erl2Error,
  assertContract,
  parseStrictJson,
  CONTRACTS,
  type Hash,
  type IsolationEnforcementProbeResultV1,
  type IsolationProbeSigningManifestV1,
  type IsolationSubstrateLockV1,
  type LabLifecycleEventV1,
  type SubjectAdapterCertificationReceiptV1,
  type SubjectAdapterManifestV1,
  type SubstrateLockV1,
  type Tier,
} from "@erl2/contracts";

import { CONTRACTS } from "@erl2/contracts";

export function registeredContractCount(): number {
  return CONTRACTS.length;
}
