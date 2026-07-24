# Runbook — offline verification

**Audience:** an external consumer who trusts nothing in the bundle.
**Network:** must be disabled. `--offline` is mandatory; omitting it is refused
with `VERIFY_OFFLINE_REQUIRED` and exit code 10.

## Inputs you control

`--root-config` is **verifier-controlled local configuration**. It must be
populated out of band and never from a policy, receipt, bundle or report. It
declares:

```json
{
  "rootKeyIds": ["<trust root key ids you pinned>"],
  "currentTrustHeadHash": "sha256:<the trust policy core hash you accept>",
  "randomnessSources": [{ "sourceId": "...", "sourceTrustPolicyHash": "sha256:...",
                          "beaconKeyIds": ["..."], "beaconPublicKeysPem": ["..."],
                          "nativeSignatureDomain": "...", "revoked": false }],
  "randomnessRegistryHeadHash": "sha256:<the source registry head you pinned>"
}
```

If the bundle presents a trust policy whose core hash differs from
`currentTrustHeadHash`, verification fails with `TRUST_HEAD_NOT_LOCALLY_PINNED`.
A self-consistent bundle can never establish its own trust anchor.

## Verify a public bundle

```bash
erl2 verify --public-bundle PATH --root-config PATH --artifact-root PATH --lifecycle PATH --offline
```

What the verifier does, in order:

1. Validates the bundle against the closed `public-verification-bundle/v2`
   schema and refuses any execution body.
2. Scans the artifact root itself, recomputing every `core_hash`. A file whose
   declared hash disagrees with its canonical bytes is rejected on sight.
3. Loads the presented trust policy and refuses it unless your local
   configuration already pins its head and root key.
4. Verifies the timestamp checkpoint chain: contiguous sequences, correct
   `prior_checkpoint_hash` links, no self-anchoring, authorized timestamp
   authority.
5. Verifies the final attestation's signature, role authorization and both trust
   verdicts (valid-when-signed and currently-trusted).
6. Recomputes the signer inventory and refuses an entry for an excluded public
   terminal type.
7. Runs `erl2-mandatory-closure/v1`, deriving the required artifact set from the
   **lifecycle chain**, not from any producer array, and reporting missing roles
   and rejected extras.

Exit 0 means the verdict is valid. Exit 10 means a trust, tamper or closure
failure; the JSON envelope names the exact refusal code.

## Verify a retained invalid run record

```bash
erl2 verify-record --record PATH --lifecycle PATH --artifact-root PATH --root-config PATH --offline
```

`verify-record` is read-only and grants no attestation authority. It accepts
exactly an `invalid-lab-run-record/v1`. A valid run record, an attestation or a
public bundle is refused with `VERIFY_RECORD_EXPECTED_INVALID_RECORD` or
`VERIFY_RECORD_ATTESTATION_PRESENT`. It additionally proves that:

- no attestation or bundle root exists anywhere beneath the artifact root;
- the discriminated phase and reason match lifecycle evidence;
- a cancellation carries no fabricated finding;
- a restoration or teardown failure passed through receipt-backed emergency
  cleanup, with a receipt for every attempted action and a reason and no receipt
  for every independently unsafe skip.

## When verification fails

Do not weaken the check. Record the refusal code, retain the bundle unchanged,
and treat the run as unverified. Verification is read-only and can be repeated
without limit.
