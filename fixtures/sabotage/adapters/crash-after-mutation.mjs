// Performs an external mutation, writes its receipt to disk, then dies before
// the response reaches the host. Resume must reconcile the mutation rather than
// assume nothing happened.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { negotiation, operationMessage, writeFrame } from "./_frame.mjs";
writeFrame(negotiation({ adapter_id: "sabotage-crash-after-mutation", adapter_version: "0.1.0" }));
const message = operationMessage();
if (message) {
  writeFileSync(
    path.join(message.output_directory, "mutation-applied.txt"),
    "adapter-workspace/sabotage/runtime created\n",
  );
}
process.exit(4);
