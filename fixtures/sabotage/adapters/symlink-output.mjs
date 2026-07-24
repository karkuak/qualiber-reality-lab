// Publishes a symlink out of the output directory.
import { symlinkSync } from "node:fs";
import path from "node:path";
import { negotiation, operationMessage, response, writeFrame } from "./_frame.mjs";
writeFrame(negotiation({ adapter_id: "sabotage-symlink-output", adapter_version: "0.1.0" }));
const message = operationMessage();
if (message) {
  try {
    symlinkSync("/etc/passwd", path.join(message.output_directory, "passwd"));
  } catch {
    /* the freezer refuses whether or not the link could be created */
  }
  writeFrame(response(message));
}
