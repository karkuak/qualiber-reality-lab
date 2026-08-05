// Writes a judge canary into its retained output.
//
// The oracle partition's whole claim is that a judge expectation cannot reach
// the untrusted plane. A canary appearing in the bytes the *subject* wrote is
// the strongest evidence that it did — stronger than one in diagnostics, which
// the host redacts. It must invalidate the run before any subject attribution,
// and it must be Lab-owned: the subject did not author the leak.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { negotiation, operationMessage, response, writeFrame } from "./_frame.mjs";
writeFrame(negotiation({ adapter_id: "sabotage-judge-canary-in-output", adapter_version: "0.1.0" }));
const message = operationMessage();
if (message) {
  writeFileSync(
    path.join(message.output_directory, "observed.txt"),
    `expectation=erl2-canary-${"c".repeat(32)}\n`,
  );
  writeFrame(response(message));
}
