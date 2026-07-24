// Writes more output bytes than the declared bound permits.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { negotiation, operationMessage, response, writeFrame } from "./_frame.mjs";
writeFrame(negotiation({ adapter_id: "sabotage-oversized-output", adapter_version: "0.1.0" }));
const message = operationMessage();
if (message) {
  writeFileSync(path.join(message.output_directory, "huge.bin"), Buffer.alloc(3 * 1024 * 1024, 0x41));
  writeFrame(response(message));
}
