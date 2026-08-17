# Provenance advisory — Qualiber trusted-local product run, 2026-08-16

This advisory accompanies the retained evidence bundle in
`docs/evidence/qualiber-trusted-local-product-run-20260816/`. It is deliberately
**outside** that directory: the bundle is a closed, indexed set, and adding a
file to it would change the index. Keeping this file as a sibling leaves the
bundle byte-for-byte as retained, with its evidence index still
`4d37cb07be117145021fef1ea94bb884dc7c08c76bd8c0aa4e017e8632544c7b`
(117 indexed files, 119 regular files including the index and its digest
sidecar).

Nothing in the bundle was edited, regenerated, or reordered to publish it.

---

## What the bundle is

An immutable retained bundle from a single owner-trusted, development-tier local
observation performed on 2026-08-16. It retains the actual bytes of that run.
It is not a re-execution, not a reconstruction, and not a summary.

## Working-tree provenance

The run was executed from **accepted dirty working trees** on both sides. It was
not produced from clean checkouts.

The HEAD and tree values recorded inside the bundle identify the **committed
baselines** the working trees were sitting on:

| Side          | Committed baseline                         | Committed tree                             |
| ------------- | ------------------------------------------ | ------------------------------------------ |
| Qualiber      | `6e7f5bbdbb70397922bd8fee923fcc2db321ead9` | `169e0aaaba6c0611cd33f16b3f57ccd3d6d170c6` |
| Reality Lab   | `561d782a92543b95246cce6405cf1cea258edd63` | `5871e2d834f7c61ea221c5b750916765203b9fd3` |

Those coordinates identify the committed baselines only. They do **not** identify
the complete executable working-tree closure that was actually loaded at run
time. Anyone reading them as a recipe for reproducing the run would be reading
more into them than they carry.

## What actually executed

The run executed the retained adapter artifact and manifest, whose bytes are in
the bundle and are recomputable from it:

- adapter artifact — `sha256:3af5a4f0bee08d65f7730d8b5825dd4637141a5bc00f3b4c48711bb17e5a4548` (42,782 bytes)
- manifest file — `sha256:984dfcbdc84f496aad6ac78fcc0b79faf9d534d8a669313d7cc680af2a2ef38a`
- manifest core — `sha256:dc062eeacf498030b5a0b85608b40ebd95a2b82781abc75bbfb8771720df9a47`

## The later integrated Qualiber source did not produce these bytes

Qualiber PR #369 has since merged into `preprod` at merge commit `b07746e`.
Building the adapter from that later integrated source produces a **different**
artifact — `sha256:9dac36ee…` (43,436 bytes), with manifest file
`sha256:0c4ce827…` and manifest core `sha256:344f2dbe…`.

That later artifact is a different artifact. It was **not** executed by this
retained run, and it must not be described as reproducing, regenerating, or
having produced the retained bytes above. The two are not interchangeable and
the newer one is not evidence for the older one.

The known reason for the divergence is that the later-integrated source pulls in
the #364 redaction hardening through the bundled collector, which the retained
build predates.

## Dependency provisioning

Qualiber PR #369 also closes future clean-checkout onboarding by adding a
dependency-provisioning mechanism. That gate is closed going forward, but it was
**not** used by this historical run — the run resolved its dependencies from the
operator's existing local trees, as
`adapter/runtime-dependency-provenance.json` inside the bundle records.

## Nothing is being hidden or rewritten

No source defect is being concealed by this disclosure, and no historical byte
is being rewritten. The divergence is a build-input difference across time,
disclosed here so the retained evidence is not later mistaken for evidence about
current source.

---

## Authority ceiling (unchanged)

This is owner-trusted, unauthenticated, unscored, unconfined **development
evidence only**.

It does not establish, and must not be cited as: certification; independent
assurance; confinement or sandboxing; scoring or authentication; production
readiness; or reproducibility from a clean checkout.

The bundle's own `README.md` states the same ceiling, and the retained record
states it in its own bytes (`independent_certification: "absent"`,
`confinement: "absent"`).
