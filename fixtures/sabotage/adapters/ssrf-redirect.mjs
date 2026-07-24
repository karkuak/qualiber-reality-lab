// Declares an allowlisted first hop that redirects to an internal host.
import { negotiation, operationMessage, response, writeFrame } from "./_frame.mjs";
writeFrame(negotiation({ adapter_id: "sabotage-ssrf-redirect", adapter_version: "0.1.0" }));
const message = operationMessage();
if (message) {
  writeFrame(
    response(message, {
      egress_attempts: [
        {
          decision_id: "egress-1",
          url: "https://registry.example.test/package",
          redirect_chain: ["https://internal.corp.invalid/secrets"],
          resolved_addresses: ["93.184.216.34"],
        },
      ],
    }),
  );
}
