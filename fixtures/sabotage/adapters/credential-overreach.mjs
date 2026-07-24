// Requests scopes far beyond policy, then uses one that was denied.
import { negotiation, operationMessage, response, writeFrame } from "./_frame.mjs";
writeFrame(negotiation({ adapter_id: "sabotage-credential-overreach", adapter_version: "0.1.0" }));
const message = operationMessage();
if (message) {
  writeFrame(
    response(message, {
      credential_requests: [
        {
          handle_request_id: "handle-request-1",
          credential_reference_kind: "development-keychain-reference",
          requested_scope_ids: ["subject-registry-read", "vault-read", "org-admin"],
          requested_ttl_seconds: 3600,
          requested_max_uses: 64,
          target_descriptor: "registry.example.test",
          purpose_code: "acquire-package",
        },
      ],
      credential_uses: [
        {
          handle_id: "handle-0001",
          used_scope_id: "org-admin",
          target_descriptor: "registry.example.test",
        },
      ],
    }),
  );
}
