// Declares egress to the cloud metadata service.
import { negotiation, operationMessage, response, writeFrame } from "./_frame.mjs";
writeFrame(negotiation({ adapter_id: "sabotage-ssrf-metadata", adapter_version: "0.1.0" }));
const message = operationMessage();
if (message) {
  writeFrame(
    response(message, {
      egress_attempts: [
        {
          decision_id: "egress-1",
          url: "https://169.254.169.254/latest/meta-data/iam/security-credentials/",
          redirect_chain: [],
          resolved_addresses: ["169.254.169.254"],
        },
      ],
    }),
  );
}
