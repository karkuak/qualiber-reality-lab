// The substitute. Byte-different from `compliant.mjs`, but announces the SAME
// neutral identity, so protocol negotiation and the host's identity check would
// both accept it. The ONLY thing that can stop it is the per-dispatch entry
// digest comparison — which is exactly what the control measures.
//
// It records that it executed *before* answering. The marker goes into its own
// working directory: the host's environment allowlist is deny-by-default, so no
// variable can be passed in to tell it where to write, and the working
// directory is the one location it is guaranteed to have. The control asserts
// no marker exists anywhere under the run root.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { negotiation, operationMessage, response, writeFrame } from "./_frame.mjs";

try {
  writeFileSync(path.join(process.cwd(), "SUBSTITUTE-EXECUTED"), "the substituted adapter executed\n");
} catch {
  // A marker that cannot be written must not stop the fixture from proving it ran.
}
writeFrame(negotiation());
const message = operationMessage();
if (message) writeFrame(response(message));
