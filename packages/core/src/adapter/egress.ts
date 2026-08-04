/**
 * Egress adjudication (design v2 §21 SSRF/unrestricted-egress control).
 *
 * Deny by default. An adapter declares the request it intends to make — URL,
 * redirect chain and the addresses it resolved — and the broker decides against
 * a scheme/host/port allowlist, revalidating **every** redirect hop rather than
 * only the first. Loopback is denied unless explicitly granted, link-local and
 * cloud metadata services are always denied, and a host that resolves to a
 * private or link-local address after passing the name allowlist is a DNS
 * rebinding attempt and is denied.
 *
 * What this module is: the adjudication and its receipt. What it is not: a
 * kernel-level block. On the local-process sandbox profile the host cannot stop
 * a child from opening a socket, and `sandboxControlReport` says so — the
 * enforced control is `egress-policy-adjudication`, and `deny-by-default-egress`
 * is reported `unsupported_on_this_host`. Certification runs adapters that
 * declare their egress; an adapter that opened a socket without declaring it
 * would be caught by the mount-tamper and output checks, not by this module,
 * and the claim scope is capped accordingly.
 */

import {
  assertContract,
  CODES,
  Erl2Error,
  type EgressAllowlistPolicyV1,
  type EgressDecisionReceiptV1,
  type Hash,
  type Instant,
} from "@erl2/contracts";
import { coreHash, domainHash, HASH_DOMAINS } from "@erl2/integrity";

/** Metadata endpoints that are never reachable, whatever the allowlist says. */
const METADATA_HOSTS = new Set([
  "169.254.169.254",
  "metadata.google.internal",
  "metadata.goog",
  "169.254.170.2",
  "100.100.100.200",
  "fd00:ec2::254",
]);

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0", "[::1]"]);

export function denyByDefaultEgressPolicy(policyId: string): EgressAllowlistPolicyV1 {
  const base = {
    schema_version: "egress-allowlist-policy/v1" as const,
    policy_id: policyId,
    default_action: "deny" as const,
    allowed_schemes: ["https"] as ("https" | "http")[],
    allowed_hosts: [] as string[],
    allowed_ports: [443],
    max_redirects: 0,
    revalidate_redirect_targets: true as const,
    allow_loopback_hosts: [] as string[],
    deny_link_local: true as const,
    deny_metadata_service: true as const,
    deny_proxy_bypass: true as const,
  };
  return assertContract<EgressAllowlistPolicyV1>("EgressAllowlistPolicyV1", {
    ...base,
    core_hash: coreHash(base),
  });
}

/**
 * The one loopback address this policy will build an allowlist for.
 *
 * Not a set of "loopback-ish" spellings. `localhost` is whatever the host's
 * resolver says it is and can be pointed elsewhere; `0.0.0.0` is every
 * interface, not a loopback address at all; `::1` is a different address family
 * than the one the subset publishes on. Accepting any of them would widen the
 * allowlist to something other than the endpoint that was observed.
 */
const CANONICAL_LOOPBACK_HOST = "127.0.0.1";

/**
 * An allowlist for exactly one loopback endpoint (ERL2-OQ-005).
 *
 * The Compose environment publishes the subset's endpoint as one ephemeral host
 * port bound to `127.0.0.1` — and publishes nothing else, the collector's OTLP
 * receivers included — so a subject that is supposed to interact with the real
 * environment has to be allowed to reach exactly that. Everything the default
 * policy denies is still denied: one scheme, one host, one port, no redirects,
 * link-local and metadata services refused outright. `allow_loopback_hosts` names
 * the single address rather than lifting the loopback rule.
 *
 * ## It validates its own arguments
 *
 * This function turns two values into a *grant*, so it does not trust them
 * because a caller passed them. It is the second, independent check on the host
 * and port — `readComposeEndpoint` is the first — and it is deliberately
 * independent: a host of `example.com`, or a port of `0`, `-1`, `1.5`, `NaN` or
 * `70000`, is refused here even if some future caller reached this function without
 * going through the endpoint reader at all. A policy is not the place to discover
 * that its host was arbitrary.
 *
 * The two checks are separate for a reason worth stating, because a record like
 * `example.com:80` invites conflating them: **the host is what makes that
 * inadmissible.** `80` is a perfectly valid numeric port and this function accepts
 * it on `127.0.0.1`. Nothing here treats a port *number* as suspicious — the port
 * check is a range and integrality check and nothing more — and a reading that had
 * `80` refused on its own account would be describing a rule that does not exist.
 */
export function loopbackEgressPolicy(policyId: string, host: string, port: number): EgressAllowlistPolicyV1 {
  if (host !== CANONICAL_LOOPBACK_HOST) {
    throw new Erl2Error(
      CODES.ADAPTER_EGRESS_HOST_NOT_ALLOWED,
      `a loopback egress allowlist may name ${CANONICAL_LOOPBACK_HOST} and nothing else; ${JSON.stringify(host)} is not it`,
      { owner: "lab" },
    );
  }
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Erl2Error(
      CODES.ADAPTER_EGRESS_PORT_NOT_ALLOWED,
      `a loopback egress allowlist needs one real host port; ${JSON.stringify(port)} is not one`,
      { owner: "lab" },
    );
  }
  const base = {
    schema_version: "egress-allowlist-policy/v1" as const,
    policy_id: policyId,
    default_action: "deny" as const,
    allowed_schemes: ["http"] as ("https" | "http")[],
    allowed_hosts: [host],
    allowed_ports: [port],
    max_redirects: 0,
    revalidate_redirect_targets: true as const,
    allow_loopback_hosts: [host],
    deny_link_local: true as const,
    deny_metadata_service: true as const,
    deny_proxy_bypass: true as const,
  };
  return assertContract<EgressAllowlistPolicyV1>("EgressAllowlistPolicyV1", {
    ...base,
    core_hash: coreHash(base),
  });
}

function isLinkLocalOrPrivate(address: string): boolean {
  if (address.startsWith("169.254.") || address.startsWith("fe80:")) return true;
  if (address.startsWith("10.") || address.startsWith("192.168.")) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(address)) return true;
  if (address.startsWith("127.") || address === "::1") return true;
  if (address.startsWith("fc") || address.startsWith("fd")) return true;
  return false;
}

interface ParsedTarget {
  readonly scheme: string;
  readonly host: string;
  readonly port: number;
}

function parseTarget(url: string): ParsedTarget {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Erl2Error(CODES.ADAPTER_EGRESS_DENIED, "egress target is not a valid absolute URL", {
      owner: "adapter",
    });
  }
  const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
  const host = parsed.hostname.toLowerCase();
  const port = parsed.port === "" ? (scheme === "https" ? 443 : scheme === "http" ? 80 : 0) : Number(parsed.port);
  return { scheme, host, port };
}

/** Adjudicates one hop against the policy; returns a denial code or undefined. */
function decideHop(policy: EgressAllowlistPolicyV1, target: ParsedTarget): string | undefined {
  if (!(policy.allowed_schemes as readonly string[]).includes(target.scheme)) {
    return CODES.ADAPTER_EGRESS_SCHEME_NOT_ALLOWED;
  }
  if (policy.deny_metadata_service && METADATA_HOSTS.has(target.host)) {
    return CODES.ADAPTER_EGRESS_METADATA_SERVICE_DENIED;
  }
  if (LOOPBACK_HOSTS.has(target.host) && !policy.allow_loopback_hosts.includes(target.host)) {
    return CODES.ADAPTER_EGRESS_HOST_NOT_ALLOWED;
  }
  if (!policy.allowed_hosts.includes(target.host) && !policy.allow_loopback_hosts.includes(target.host)) {
    return CODES.ADAPTER_EGRESS_HOST_NOT_ALLOWED;
  }
  if (!policy.allowed_ports.includes(target.port)) {
    return CODES.ADAPTER_EGRESS_PORT_NOT_ALLOWED;
  }
  return undefined;
}

export interface EgressDecisionOptions {
  readonly runId: string;
  readonly operationId: string;
  readonly decisionId: string;
  readonly policy: EgressAllowlistPolicyV1;
  readonly url: string;
  readonly redirectChain: readonly string[];
  readonly resolvedAddresses: readonly string[];
  readonly proxyEnvironmentPresent?: boolean;
  readonly now: Instant;
}

/**
 * Decides one egress attempt and freezes the receipt.
 *
 * The URL is recorded only as a hash — a URL can carry a token in its query
 * string, and a receipt is a retained artifact.
 */
export function decideEgress(options: EgressDecisionOptions): EgressDecisionReceiptV1 {
  const target = parseTarget(options.url);
  let denialCode = decideHop(options.policy, target);

  if (denialCode === undefined && options.redirectChain.length > options.policy.max_redirects) {
    denialCode = CODES.ADAPTER_EGRESS_REDIRECT_ESCAPED;
  }
  if (denialCode === undefined) {
    // Every hop is revalidated; a redirect cannot launder a denied target.
    for (const hop of options.redirectChain) {
      const hopDenial = decideHop(options.policy, parseTarget(hop));
      if (hopDenial !== undefined) {
        denialCode = CODES.ADAPTER_EGRESS_REDIRECT_ESCAPED;
        break;
      }
    }
  }
  if (denialCode === undefined && options.policy.deny_proxy_bypass && options.proxyEnvironmentPresent === true) {
    denialCode = CODES.ADAPTER_EGRESS_PROXY_BYPASS_DENIED;
  }
  if (denialCode === undefined) {
    for (const address of options.resolvedAddresses) {
      if (METADATA_HOSTS.has(address)) {
        denialCode = CODES.ADAPTER_EGRESS_METADATA_SERVICE_DENIED;
        break;
      }
      // An allowlisted name that resolves into private or link-local space is
      // DNS rebinding, whatever the name said.
      if (isLinkLocalOrPrivate(address) && !options.policy.allow_loopback_hosts.includes(target.host)) {
        denialCode = CODES.ADAPTER_EGRESS_DNS_REBOUND;
        break;
      }
    }
  }

  const hash = (value: string): Hash =>
    domainHash(HASH_DOMAINS.RESOURCE_IDENTITY, { kind: "egress-target", value });

  const base = {
    schema_version: "egress-decision-receipt/v1" as const,
    run_id: options.runId,
    operation_id: options.operationId,
    decision_id: options.decisionId,
    policy_hash: options.policy.core_hash,
    request_url_hash: hash(options.url),
    scheme: target.scheme,
    host: target.host,
    port: target.port,
    resolved_address_hashes: options.resolvedAddresses.map(hash),
    redirect_chain_url_hashes: options.redirectChain.map(hash),
    decision: (denialCode === undefined ? "allowed" : "denied") as "allowed" | "denied",
    ...(denialCode === undefined ? {} : { denial_code: denialCode }),
    decided_at: options.now,
  };
  return assertContract<EgressDecisionReceiptV1>("EgressDecisionReceiptV1", {
    ...base,
    core_hash: coreHash(base),
  });
}
