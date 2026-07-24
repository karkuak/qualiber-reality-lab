// Writes outside the run-scoped output directory using a traversal.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { negotiation, operationMessage, response, writeFrame } from "./_frame.mjs";
writeFrame(negotiation({ adapter_id: "sabotage-path-escape-output", adapter_version: "0.1.0" }));
const message = operationMessage();
if (message) {
  try {
    writeFileSync(path.join(message.output_directory, "..", "..", "escaped.txt"), "escaped\n");
  } catch {
    /* recorded either way; the freezer only admits the confined tree */
  }
  writeFrame(response(message));
}
