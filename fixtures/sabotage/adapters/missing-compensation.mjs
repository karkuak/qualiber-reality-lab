// Declares a succeeded mutation and supplies no compensation receipt.
import { negotiation, operationMessage, response, writeFrame } from "./_frame.mjs";
writeFrame(negotiation({ adapter_id: "sabotage-missing-compensation", adapter_version: "0.1.0" }));
const message = operationMessage();
if (message) {
  writeFrame(
    response(message, {
      mutations: [
        {
          mutation_id: "install-service",
          mutation_class: "service",
          capability_id: "write-adapter-workspace",
          target_descriptor: "adapter-workspace/sabotage/service",
          before_state_descriptor: "absent",
          after_state_descriptor: "running",
          compensation_id: "stop-service",
          compensation_capability_id: "write-adapter-workspace",
          status: "succeeded",
        },
      ],
    }),
  );
}
