// Negotiates a protocol version the host does not offer.
import { negotiation, writeFrame } from "./_frame.mjs";
writeFrame(negotiation({ adapter_id: "sabotage-protocol-mismatch", protocol_version: "subject-adapter/v2" }));
