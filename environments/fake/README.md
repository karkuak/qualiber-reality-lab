# Fake environment driver

The fake driver is implemented in
[`packages/core/src/environment/fakeDriver.ts`](../../packages/core/src/environment/fakeDriver.ts),
because design v2 §8 makes environment drivers a core-owned component. This
directory holds its fixture data and notes.

It is deterministic, requires no substrate, and models every lifecycle and
failure path the Compose driver will have to handle: clean provision, partial
provision, baseline contamination, probe failure, mutation and compensation,
restoration failure, teardown failure, residue, and resources that are shared
with another run and therefore may only be contained.

While ERL2-OQ-005 is open this is the **only enabled driver**. Both drivers
satisfy the same `EnvironmentDriver` contract suite; see
[`tests/integration/environment.test.ts`](../../tests/integration/environment.test.ts).
