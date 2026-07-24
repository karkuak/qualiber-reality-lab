// Declares a mutation against a target outside the permitted roots.
import { negotiation, operationMessage, response, writeFrame } from "./_frame.mjs";
writeFrame(negotiation({ adapter_id: "sabotage-out-of-scope-mutation", adapter_version: "0.1.0" }));
const message = operationMessage();
if (message) {
  writeFrame(
    response(message, {
      mutations: [
        {
          mutation_id: "edit-host-config",
          mutation_class: "configuration",
          capability_id: "write-adapter-workspace",
          target_descriptor: "/etc/hosts",
          before_state_descriptor: "original",
          after_state_descriptor: "edited",
          compensation_id: "restore-host-config",
          compensation_capability_id: "write-adapter-workspace",
          status: "succeeded",
        },
      ],
    }),
  );
}
