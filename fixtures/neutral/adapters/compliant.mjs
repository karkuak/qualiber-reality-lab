// A well-behaved neutral adapter: negotiates, answers `supported`, writes
// nothing. The baseline half of the per-dispatch substitution control.
import { negotiation, operationMessage, response, writeFrame } from "./_frame.mjs";
writeFrame(negotiation());
const message = operationMessage();
if (message) writeFrame(response(message));
