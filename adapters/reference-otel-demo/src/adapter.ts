/**
 * Reference subject: one real interaction with the run's real environment
 * (ERL2-OQ-005).
 *
 * ## What it is for, and what it deliberately is not
 *
 * The other reference adapters prove the *protocol*: they behave correctly,
 * limitedly, misleadingly or inconclusively without ever leaving their own
 * workspace. None of them touches the environment the Lab provisions, so none of
 * them can show that the subject path reaches it. This one does exactly that and
 * nothing more: on `interact` it makes a single HTTP request to the one endpoint
 * the qualified Compose subset publishes, and reports what came back.
 *
 * It is **not** an HTTP adapter SDK and **not** a configurable workflow engine.
 * There is one request, to one host and port it is told about through a
 * host-declared read-only mount, with one path, one method and one body shape.
 * A different environment would need a different adapter, which is the correct
 * amount of generality for a reference subject.
 *
 * ## Trusted, local, and honest about it
 *
 * This is a *trusted, repository-owned* local-process subject. It is not opaque,
 * not third-party, and not evidence that the Lab can measure a subject it did
 * not write — ERL2-OQ-008 stays open, and no claim derived from a run driven by
 * this adapter may say otherwise.
 *
 * ## The egress it makes, it declares
 *
 * `attemptEgress` is called with the exact URL before the request is issued, so
 * the host adjudicates it against its allowlist and receipts the decision. The
 * Compose composition grants exactly one loopback host and one port; anything
 * else this adapter tried to reach would be denied with a receipt rather than
 * silently succeeding.
 */

import {
  checkPackageKind,
  type AdapterDefinition,
  type AdapterOperationContext,
  type AdapterOperationOutcome,
} from "@erl2/adapter-sdk";
import { packageKindFromMediaType } from "@erl2/contracts";

const PACKAGE_BYTES = Buffer.from("reference-otel-demo subject package v0.1.0\n", "utf8");

/** The endpoint of the qualified subset. One path, one method. */
const ENDPOINT_PATH = "/getquote";
const REQUEST_TIMEOUT_MS = 15_000;

interface EndpointRecord {
  readonly host: string;
  readonly port: number;
  readonly container: string;
}

/**
 * Where the environment is.
 *
 * Read from a host-declared read-only mount, never from an environment variable:
 * the adapter environment allowlist is a fail-closed gate, and a locator that
 * arrived by widening it would have cost more than it bought.
 */
function endpoint(context: AdapterOperationContext): EndpointRecord | undefined {
  let bytes: Buffer;
  try {
    bytes = context.readInput("environment-endpoint", "endpoint.json");
  } catch {
    return undefined;
  }
  const value = JSON.parse(bytes.toString("utf8")) as Partial<EndpointRecord>;
  if (typeof value.host !== "string" || typeof value.port !== "number") return undefined;
  return { host: value.host, port: value.port, container: value.container ?? "" };
}

function acquire(context: AdapterOperationContext): AdapterOperationOutcome {
  context.writeOutput("acquisition/notes.txt", "followed the environment quickstart\n");
  return {
    status: "supported",
    resultSchemaVersion: "reference-otel-demo-acquisition/v1",
    activeOperatorMs: 1200,
    result: {
      package_base64: PACKAGE_BYTES.toString("base64"),
      attempts: [
        {
          attempt_id: "attempt-1",
          status: "completed",
          bytes: PACKAGE_BYTES.byteLength,
          redirect_count: 0,
          error_codes: [],
        },
      ],
      authentication_prompt_count: 0,
      documentation_step_ids: ["doc-quickstart"],
      elapsed_ms: 1400,
    },
  };
}

function validatePackage(context: AdapterOperationContext): AdapterOperationOutcome {
  const artifact = context.request["frozen_acquired_artifact"] as { readonly media_type?: string } | undefined;
  const kind = packageKindFromMediaType(artifact?.media_type ?? "") ?? "unknown";
  const supported = checkPackageKind(REFERENCE_OTEL_DEMO_ADAPTER, kind);
  if (!supported.supported) {
    return {
      status: "unsupported",
      activeOperatorMs: 150,
      unsupportedInputs: [supported.reason as string],
      error: {
        code: "SUBJECT_PACKAGE_KIND_UNSUPPORTED",
        owner: "subject",
        safeMessage: `this subject is distributed as an archive; ${kind} is not a form it can verify`,
      },
    };
  }
  return {
    status: "supported",
    resultSchemaVersion: "reference-otel-demo-package-verification/v1",
    activeOperatorMs: 300,
    result: {
      package_kind: kind,
      declared_entrypoints: REFERENCE_OTEL_DEMO_ADAPTER.declaredEntrypoints,
      checks: [{ check_id: "package-kind-declared", passed: true }],
    },
  };
}

/**
 * `install` declares no mutation, and that is the honest answer.
 *
 * Everything this subject writes goes through `writeOutput`, into the run-scoped
 * output directory the host owns, bounds and discards. That is not a change to
 * anything outside the subject, so declaring it as a mutation would overstate
 * what happened — and a mutation the adapter cannot compensate inside the same
 * operation is refused by the host's ledger anyway, which is the correct rule.
 * The subject's one real effect on the world is the HTTP request in `interact`,
 * and the endpoint it calls computes a price without storing anything.
 */
function install(context: AdapterOperationContext): AdapterOperationOutcome {
  context.writeOutput("install/runtime.txt", "runtime directory created\n");
  return {
    status: "supported",
    activeOperatorMs: 600,
    resultSchemaVersion: "reference-otel-demo-install/v1",
    result: { installed: true },
  };
}

/**
 * `configure` records where the environment is; it makes no request.
 *
 * Separating "I can see the environment" from "I used it" is what makes the
 * `interact` outcome mean something: a `configure` that succeeds and an
 * `interact` that fails is a reachable, distinguishable state.
 */
function configure(context: AdapterOperationContext): AdapterOperationOutcome {
  const target = endpoint(context);
  if (target === undefined) {
    return {
      status: "unsupported",
      activeOperatorMs: 100,
      unsupportedInputs: ["environment-endpoint"],
      error: {
        code: "SUBJECT_ENVIRONMENT_ENDPOINT_ABSENT",
        owner: "subject",
        safeMessage: "no environment endpoint was made available to this subject",
      },
    };
  }
  context.writeOutput("configure/endpoint.txt", `${target.host}:${String(target.port)}${ENDPOINT_PATH}\n`);
  return {
    status: "supported",
    activeOperatorMs: 200,
    resultSchemaVersion: "reference-otel-demo-configure/v1",
    result: { endpoint_configured: true },
  };
}

function start(context: AdapterOperationContext): AdapterOperationOutcome {
  const target = endpoint(context);
  return target === undefined
    ? {
        status: "failed",
        activeOperatorMs: 100,
        error: {
          code: "SUBJECT_ENVIRONMENT_ENDPOINT_ABSENT",
          owner: "subject",
          safeMessage: "the environment endpoint is not reachable from this subject",
        },
      }
    : {
        status: "supported",
        activeOperatorMs: 250,
        resultSchemaVersion: "reference-otel-demo-connect/v1",
        result: { connected_to: `${target.host}:${String(target.port)}` },
      };
}

/**
 * The one real interaction.
 *
 * A single POST to the qualified subset's endpoint. The run id travels in the
 * query string for exactly one reason: the service's OpenTelemetry
 * auto-instrumentation records the request URL as a span attribute, so the
 * telemetry the collector receives is *attributable to this run* rather than
 * merely non-zero. Nothing about the response is interpreted beyond its status
 * and its body length — this adapter is a subject, not an oracle.
 */
async function interact(context: AdapterOperationContext): Promise<AdapterOperationOutcome> {
  const target = endpoint(context);
  if (target === undefined) {
    return {
      status: "unsupported",
      activeOperatorMs: 100,
      unsupportedInputs: ["environment-endpoint"],
      error: {
        code: "SUBJECT_ENVIRONMENT_ENDPOINT_ABSENT",
        owner: "subject",
        safeMessage: "no environment endpoint was made available to this subject",
      },
    };
  }
  const url = `http://${target.host}:${String(target.port)}${ENDPOINT_PATH}?erl2_run=${encodeURIComponent(context.runId)}`;
  // Declared before it is made, so the host adjudicates and receipts it.
  context.attemptEgress({
    decision_id: `egress-${context.operationId}`,
    url,
    redirect_chain: [],
    resolved_addresses: [target.host],
  });

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ numberOfItems: 3 }),
      signal: controller.signal,
      redirect: "error",
    });
    const body = (await response.text()).slice(0, 256);
    const elapsedMs = Date.now() - started;
    context.writeOutput(
      "interact/quote.json",
      `${JSON.stringify({ status: response.status, body, elapsed_ms: elapsedMs }, null, 2)}\n`,
    );
    if (!response.ok) {
      return {
        status: "failed",
        activeOperatorMs: elapsedMs,
        error: {
          code: "SUBJECT_ENVIRONMENT_ENDPOINT_REJECTED",
          owner: "subject",
          safeMessage: `the environment endpoint answered ${String(response.status)}`,
        },
      };
    }
    return {
      status: "supported",
      activeOperatorMs: elapsedMs,
      resultSchemaVersion: "reference-otel-demo-interaction/v1",
      result: { http_status: response.status, response_bytes: body.length, elapsed_ms: elapsedMs },
    };
  } catch (cause) {
    return {
      status: "failed",
      activeOperatorMs: Date.now() - started,
      error: {
        code: "SUBJECT_ENVIRONMENT_ENDPOINT_UNREACHABLE",
        owner: "subject",
        safeMessage: `the environment endpoint could not be reached: ${
          cause instanceof Error ? cause.message.slice(0, 120) : "unknown"
        }`,
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

function uninstall(context: AdapterOperationContext): AdapterOperationOutcome {
  context.diagnostic("removal: the subject holds nothing outside its own run-scoped output directory");
  return {
    status: "supported",
    activeOperatorMs: 200,
    resultSchemaVersion: "reference-otel-demo-uninstall/v1",
    result: { removed: true },
  };
}

function translateEvidence(context: AdapterOperationContext): AdapterOperationOutcome {
  const entries = context.listInput("canonical-evidence");
  const entryIds = entries.map((entry) => entry.replace(/\.json$/, ""));
  const mappings = entryIds.map((entryId) => {
    const target = `translated/${entryId}.json`;
    context.writeOutput(target, context.readInput("canonical-evidence", `${entryId}.json`));
    return { entry_id: entryId, disposition: "mapped_exact" as const, target_paths: [target] };
  });
  return {
    status: "supported",
    resultSchemaVersion: "adapter-translation-receipt-draft/v1",
    activeOperatorMs: 300,
    result: {
      schema_version: "adapter-translation-receipt-draft/v1",
      target_root: "translated",
      mappings,
      unmapped_entry_ids: [],
      complete: true,
    },
  };
}

function project(context: AdapterOperationContext): AdapterOperationOutcome {
  const claims = [
    {
      claim_id: "environment-endpoint-answered",
      category: "fact",
      predicate_id: "endpoint-responded",
      polarity: "asserted",
      confidence: "1",
      authority: "none",
      citations: [{ locator: "interact/quote.json" }],
    },
  ];
  context.writeOutput("claims/generic.json", `${JSON.stringify({ claims }, null, 2)}\n`);
  return {
    status: "supported",
    resultSchemaVersion: "generic-claim-set-draft/v1",
    activeOperatorMs: 200,
    result: { claims, unprojected: [], complete: true },
  };
}

function reportResidue(context: AdapterOperationContext): AdapterOperationOutcome {
  context.diagnostic("residue scan: adapter workspace only; the environment is the Lab's to clean");
  return {
    status: "supported",
    resultSchemaVersion: "residue-report-draft/v1",
    activeOperatorMs: 100,
    result: { residual_paths: [], status: "clean" },
  };
}

function compensate(context: AdapterOperationContext): AdapterOperationOutcome {
  context.diagnostic("compensation: this subject declared no mutation, so there is nothing to reverse");
  return {
    status: "supported",
    activeOperatorMs: 150,
    resultSchemaVersion: "reference-otel-demo-compensation/v1",
    result: { compensated: true },
  };
}

export const REFERENCE_OTEL_DEMO_ADAPTER: AdapterDefinition = {
  adapterId: "reference-otel-demo",
  version: "0.1.0",
  supportedPackageKinds: ["archive"],
  declaredEntrypoints: ["bin/reference-otel-demo"],
  handlers: {
    acquire,
    "validate-package": validatePackage,
    install,
    configure,
    start,
    interact,
    uninstall,
    "translate-evidence": translateEvidence,
    project,
    "report-residue": reportResidue,
    compensate,
  },
};
