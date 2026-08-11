// A neutral *external* subject for the Docker-gated Compose end-to-end file.
//
// That test refuses to couple this repository to an outside checkout, so it
// takes its subject from `ERL2_EXTERNAL_ADAPTER_ENTRY`/`_ID` and skips when
// none is supplied. This fixture supplies one whose identity is neutral —
// `neutral-external-subject`, not a built-in id, which the governor registry
// would refuse as a collision — while reusing a definition that really performs
// the environment journey against a live endpoint.
//
// It proves the generic external-subject path, not any particular product.
import { main } from "@erl2/adapter-sdk";
import { REFERENCE_OTEL_DEMO_ADAPTER } from "../../../adapters/reference-otel-demo/dist/src/adapter.js";

await main({ ...REFERENCE_OTEL_DEMO_ADAPTER, adapterId: "neutral-external-subject" });
