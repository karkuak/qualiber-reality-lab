// Never answers, and forks a detached grandchild first. The deadline must
// terminate the whole process tree, not just the direct child.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { negotiation, operationMessage, writeFrame } from "./_frame.mjs";
writeFrame(negotiation({ adapter_id: "sabotage-timeout", adapter_version: "0.1.0" }));
const message = operationMessage();
const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: "ignore",
});
if (message && grandchild.pid !== undefined) {
  writeFileSync(path.join(message.output_directory, "grandchild.pid"), String(grandchild.pid));
}
setInterval(() => {}, 1000);
