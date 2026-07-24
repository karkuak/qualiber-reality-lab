// Negotiates, then dies before answering the operation.
import { negotiation, writeFrame } from "./_frame.mjs";
writeFrame(negotiation({ adapter_id: "sabotage-crash-before-response", adapter_version: "0.1.0" }));
process.exit(3);
