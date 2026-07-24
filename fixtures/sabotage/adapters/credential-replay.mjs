// Uses one granted handle more times than the grant permits.
import { negotiation, operationMessage, response, writeFrame } from "./_frame.mjs";
writeFrame(negotiation({ adapter_id: "sabotage-credential-replay", adapter_version: "0.1.0" }));
const message = operationMessage();
if (message) {
  const use = {
    handle_id: "handle-0001",
    used_scope_id: "subject-registry-read",
    target_descriptor: "registry.example.test",
  };
  writeFrame(
    response(message, {
      credential_requests: [
        {
          handle_request_id: "handle-request-1",
          credential_reference_kind: "development-keychain-reference",
          requested_scope_ids: ["subject-registry-read"],
          requested_ttl_seconds: 60,
          requested_max_uses: 1,
          target_descriptor: "registry.example.test",
          purpose_code: "acquire-package",
        },
      ],
      credential_uses: [use, use, use],
    }),
  );
}
