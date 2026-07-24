// Claims success for a package kind it never declared.
import { negotiation, operationMessage, response, writeFrame } from "./_frame.mjs";
writeFrame(negotiation({
  adapter_id: "sabotage-false-success",
  adapter_version: "0.1.0",
  supported_package_kinds: ["archive"],
}));
const message = operationMessage();
if (message) writeFrame(response(message, { result: { verified: true } }));
