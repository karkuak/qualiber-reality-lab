// A subject whose installer genuinely fails. The failure is attributed to the
// subject, and the Lab re-checks that its own controls passed before it may be
// recorded as a subject finding (ERL2-AC-003).
import { negotiation, operationMessage, response, writeFrame } from "./_frame.mjs";
writeFrame(negotiation({
  adapter_id: "sabotage-broken-installer",
  adapter_version: "0.1.0",
  supported_operations: ["acquire", "validate-package", "install"],
}));
const message = operationMessage();
if (message) {
  if (message.operation === "install") {
    writeFrame(
      response(message, {
        status: "failed",
        result: undefined,
        result_schema_version: undefined,
        error: {
          code: "SUBJECT_INSTALL_FAILED",
          owner: "subject",
          safe_message: "the installer exited non-zero: missing runtime dependency",
        },
      }),
    );
  } else {
    writeFrame(response(message, { result: { package_base64: Buffer.from("broken\n").toString("base64") } }));
  }
}
