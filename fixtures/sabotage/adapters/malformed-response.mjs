// A hostile adapter that omits the `mutations` array from an otherwise valid
// response. Before P2-6 the host iterated `response.mutations` before validating
// the frame and crashed with an untyped `TypeError: … is not iterable`; now the
// response-shape validator refuses the frame with a typed, adapter-owned code.
import { negotiation, operationMessage, response, writeFrame } from "./_frame.mjs";
writeFrame(negotiation({ adapter_id: "sabotage-malformed-response", adapter_version: "0.1.0" }));
const message = operationMessage();
if (message) {
  const frame = response(message);
  delete frame.mutations; // the exact "not iterable" shape from the review.
  writeFrame(frame);
}
