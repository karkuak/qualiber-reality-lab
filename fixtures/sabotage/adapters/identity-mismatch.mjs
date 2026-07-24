// Negotiates an adapter identity that is not the certified one.
import { negotiation, writeFrame } from "./_frame.mjs";
writeFrame(negotiation({ adapter_id: "someone-else", adapter_version: "9.9.9" }));
