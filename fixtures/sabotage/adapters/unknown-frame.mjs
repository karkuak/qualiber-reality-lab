// Sends a frame kind the protocol does not define.
import { negotiation, writeFrame } from "./_frame.mjs";
writeFrame(negotiation({ adapter_id: "sabotage-unknown-frame", adapter_version: "0.1.0" }));
writeFrame({ kind: "elevate", request: "root" });
