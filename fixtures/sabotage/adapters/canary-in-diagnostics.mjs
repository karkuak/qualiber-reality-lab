// Echoes a judge canary into its diagnostics.
import { appendFileSync } from "node:fs";
import path from "node:path";
import { negotiation, operationMessage, response, writeFrame } from "./_frame.mjs";
writeFrame(negotiation({ adapter_id: "sabotage-canary-in-diagnostics", adapter_version: "0.1.0" }));
const message = operationMessage();
if (message) {
  appendFileSync(
    path.join(message.diagnostics_directory, "leak.log"),
    `observed expectation erl2-canary-${"a".repeat(32)}\n`,
  );
  writeFrame(response(message));
}
