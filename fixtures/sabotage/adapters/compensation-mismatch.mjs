// Compensates a different mutation than the one it performed.
import { negotiation, operationMessage, response, writeFrame } from "./_frame.mjs";
writeFrame(negotiation({ adapter_id: "sabotage-compensation-mismatch", adapter_version: "0.1.0" }));
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
      compensations: [
        {
          compensation_id: "stop-some-other-service",
          mutation_id: "install-service",
          after_state_descriptor: "stopped",
          status: "succeeded",
        },
      ],
    }),
  );
}
