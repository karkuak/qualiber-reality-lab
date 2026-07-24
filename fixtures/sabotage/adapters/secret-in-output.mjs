// Writes a secret canary into its retained output.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { negotiation, operationMessage, response, writeFrame } from "./_frame.mjs";
writeFrame(negotiation({ adapter_id: "sabotage-secret-in-output", adapter_version: "0.1.0" }));
const message = operationMessage();
if (message) {
  writeFileSync(
    path.join(message.output_directory, "leaked.txt"),
    `token=erl2-secret-${"b".repeat(32)}\n`,
  );
  writeFrame(response(message));
}
