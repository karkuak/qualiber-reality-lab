# The adapter runtime image (ERL2-OQ-008 gate 2, ADR-ERL2-034).
#
# ADR-ERL2-017 qualified `alpine@sha256:14358309...` — twenty controls observed
# enforcing — and the profile still could not run anything, because the adapter
# protocol speaks over a Node child process and that image has no Node runtime.
# Gate 2 therefore needs a *different* image, and a different image needs its own
# qualification: `assertObservedMatchesIsolationLock` compares the image digest
# before every run, so reusing the alpine evidence here is exactly the
# substitution the drift check exists to refuse.
#
# Two properties this image must have, and the second is why it is built here
# rather than pulled:
#
#   1. it can host the adapter protocol — a Node runtime, and a shell, since the
#      twenty enforcement probes execute `sh -c` inside the locked image;
#   2. it has **no ambient home directory**. `node:22-alpine` creates the `node`
#      user with `/home/node`, so the `no-ambient-home-directory` probe observes
#      `POPULATED=/home` and fails — correctly. The probe is over-broad about
#      whose home it found, but it is over-broad in the safe direction, and
#      loosening a probe so a chosen image passes is the exact move this
#      repository's review history is about. The image is changed instead.
#
# npm, npx and yarn are removed for the same reason the capability set is
# dropped: an adapter has no use for a package manager, and a package manager is
# a network client with a writable cache. The `deny-by-default-egress` and
# `read-only-root-filesystem` controls already refuse both, so this is
# defence in depth rather than the defence.
#
# Rebuild with `node scripts/build-adapter-runtime-image.mjs`, which prints the
# digest-pinned reference to qualify against.

FROM node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32

RUN rm -rf /home/node \
    /root/.npm \
    /usr/local/lib/node_modules/npm \
    /usr/local/bin/npm \
    /usr/local/bin/npx \
    /opt/yarn-v* \
    /usr/local/bin/yarn \
    /usr/local/bin/yarnpkg \
 && mkdir -p /home \
 && chmod 0755 /home \
 && [ -z "$(ls -A /home)" ] || (echo "/home is not empty" >&2; exit 1) \
 && node --version

# The launcher passes `--user 65532:65532` explicitly; this is the honest default
# for anything that runs the image without it.
USER 65532:65532
