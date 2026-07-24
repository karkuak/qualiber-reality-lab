// Answers with a response far larger than the negotiated response cap.
import { negotiation, operationMessage, response, writeFrame } from "./_frame.mjs";
writeFrame(negotiation({ adapter_id: "sabotage-oversized-response", adapter_version: "0.1.0" }));
const message = operationMessage();
if (message) {
  writeFrame(response(message, { result: { blob: "A".repeat(4 * 1024 * 1024) } }));
}
