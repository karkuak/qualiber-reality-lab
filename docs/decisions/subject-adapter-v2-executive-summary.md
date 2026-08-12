# Executive decision — honest local observation through `subject-adapter/v2`

**Decision:** approve the architecture for implementation of Package A only.

The current adapter protocol is correctly strict: every v1 request asserts a
governed preregistration, execution plan or visible step. A local dry run does
not possess those artifacts. Filling the fields with fixture values or local
hashes would create formally valid but false evidence.

The approved correction is additive. `subject-adapter/v1` and all governed
behavior remain unchanged. Exact protocol `subject-adapter/v2` introduces an
explicit `local_observation` context whose schema cannot represent governor,
judge, score, qualification, reveal or governed-finalization claims. It carries
concrete resource limits, frozen inputs and mandatory exclusions, and it emits
unsigned, explicitly unauthenticated observation records.

This is a generic Lab correction, not a Qualiber customization: the protocol
contains only adapter-neutral operations, artifact references, limits and claim
boundaries. Product behavior remains behind independently certified adapters.

V2 reuses the existing adapter host for executable identity, framing, deadlines,
process-tree termination, sandbox reports, egress/capability controls, artifact
retention, output freeze, mutation accounting, compensation and residue. One
small linear coordinator may sequence a frozen observation plan; it is not a
second journey or run engine.

Because the assurance scope changes, v2 requires `ADAPTER-CERT-V2`. Any adapter
code change also changes its artifact digest. A dual-protocol replacement must
therefore receive a new v1 receipt for its new v1 manifest and a separate v2
receipt for its local profile. Existing v1 receipts stay valid only for their
existing frozen bytes and never authorize v2.

The design is generic and removable: no product vocabulary enters contracts or
core, no local record enters evaluation or finalization, and deleting the
additive local surface leaves governed v1 intact. Implementation is bounded to
24–32 Lab files, ten additive top-level contracts and at most two new production
modules.

The only next recommendation is Package A: implement the generic contracts,
existing host/SDK seam, structural claim firewall and neutral fixtures, then
stop for independent review. External adapter changes, recertification and real
subprocess observations remain later packages.
