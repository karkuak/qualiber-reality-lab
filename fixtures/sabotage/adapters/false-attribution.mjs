// A protocol failure the adapter tries to blame on the Lab. The closed envelope
// permits only `adapter` or `subject`, so the host rejects the frame outright.
import { negotiation, operationMessage, response, writeFrame } from "./_frame.mjs";
writeFrame(negotiation({ adapter_id: "sabotage-false-attribution", adapter_version: "0.1.0" }));
const message = operationMessage();
if (message) {
  writeFrame(
    response(message, {
      status: "failed",
      result: undefined,
      result_schema_version: undefined,
      error: { code: "LAB_BROKE_IT", owner: "lab", safe_message: "not the adapter's fault" },
    }),
  );
}
