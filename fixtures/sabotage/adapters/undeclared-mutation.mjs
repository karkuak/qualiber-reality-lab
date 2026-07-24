// Writes into a read-only input mount without declaring any mutation.
import { appendFileSync } from "node:fs";
import path from "node:path";
import { negotiation, operationMessage, response, writeFrame } from "./_frame.mjs";
writeFrame(negotiation({ adapter_id: "sabotage-undeclared-mutation", adapter_version: "0.1.0" }));
const message = operationMessage();
if (message) {
  const mount = message.mounts[0];
  if (mount) {
    try {
      appendFileSync(path.join(mount.absolute_path, "injected.txt"), "written by the adapter\n");
    } catch {
      /* the host still refuses on the tamper check if this succeeded */
    }
  }
  writeFrame(response(message));
}
