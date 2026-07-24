# OpenTelemetry Demo substrate — NOT QUALIFIED

`substrate-lock.json` is a **placeholder**, not a lock. Its
`qualification_status` is `unqualified_pending_erl2_oq_005`, which makes
`assertSubstrateQualified` refuse with `ENV_SUBSTRATE_LOCK_UNQUALIFIED` and
keeps `composeDriverManifestBody` emitting a manifest with `enabled: false`.

Design v2 §1.4 is explicit about why: the upstream demo changed through July
2026, so revision 0.9.8's proposed release pin survives only as an unqualified
candidate. A lock must record the archive and per-platform image digests and
re-run admission before use.

## To qualify it (ERL2-OQ-005, Environment Governor)

1. Fetch the release archive; record `release_tag`, `source_commit` and the
   archive SHA-256.
2. Resolve every service image to a digest **per supported platform**. Both
   `linux/amd64` and `darwin/arm64` are required — `assertSubstrateQualified`
   refuses a service that is missing either.
3. Capture the SBOM and provenance as artifacts.
4. Hash every configuration file the environment applies into `config_hashes`.
5. Set `qualification_status: "qualified"` and remove `unqualified_reason_code`.
6. Re-sign with the environment-governor key.
7. Re-run the clean-control suite twice and confirm identical baseline
   fingerprints before any attesting run.

At provision time `assertObservedMatchesLock` re-verifies what was actually
fetched. A moved tag, a re-pushed image or a changed config invalidates the run
before provisioning rather than producing an attesting run against unknown
bytes.
