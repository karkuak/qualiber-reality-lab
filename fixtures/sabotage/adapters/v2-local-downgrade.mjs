// Answers a V2-only local-execution offer with a V1-shaped negotiation.
// The shipped SDK refuses to construct this response itself (a local offer
// never contains v1, so claiming it would be a lie); a hand-written or
// malicious adapter that skips the SDK can still send exactly these bytes,
// so the host's own downgrade defense must catch it independently.
import { writeFrame } from "./_frame.mjs";
writeFrame({
  kind: "negotiation",
  schema_version: "adapter-negotiation-response/v2",
  selected_protocol_version: "subject-adapter/v1",
  execution_mode: "governed",
  adapter_id: "sabotage-v2-local-downgrade",
  adapter_version: "0.1.0",
  supported_operations: ["acquire", "validate-package"],
  supported_package_kinds: ["archive"],
});
