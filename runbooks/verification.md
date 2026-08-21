# Runbook — offline verification

**Audience:** an external consumer who trusts nothing in the bundle.
**Network:** must be disabled. `--offline` is mandatory; omitting it is refused
with `VERIFY_OFFLINE_REQUIRED` and exit code 10.

## Inputs you control

`--root-config` is the **only** verifier-controlled input, and the only trust
anchor. `--public-bundle`, `--artifact-root` and `--lifecycle` are all
**caller-supplied evidence**: they arrive from the party whose claim you are
checking, and nothing in them is believed because it is presented. The lifecycle
stream in particular is evidence, not testimony — the verifier re-derives the
required artifact set from its hash chain and refuses anything the signed
terminal does not account for.

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
6. **Derives the signer inventory independently and compares it bijectively**
   (ADR-ERL2-030). The expected set comes from the retained bytes, the verifier's
   own signer-role table, the authority field each *frozen schema* declares, the
   terminal variant and the acyclic boundary — never from the inventory's own
   entries, and never from `complete_for_terminal_chain`, which is not read as
   evidence anywhere. A missing member, an extra one, a duplicate, an entry whose
   schema/key/signature hash contradicts the artifact, a member from another run,
   an inventory naming another run, and a member no lifecycle event produced are
   seven separate refusals.

   Two contracts are exempt from lifecycle reachability by name — the trust policy
   manifest and the terminal timestamp checkpoint — because neither is produced by
   any lifecycle event; both are bound to the terminal by hash instead. Nothing
   else is exempt.

   Read the boundary before quoting it: completeness is a statement about the
   *set* of signed members and about each member's identity, authority and scope.
   It is not a statement about what those members say.
7. Runs `erl2-mandatory-closure/v1`, deriving the required artifact set from the
   **lifecycle chain**, not from any producer array, and reporting missing roles
   and rejected extras.

   Admitting a retained artifact to closure requires more than hash resolution:
   an artifact declaring a `schema_version` this verifier's contract registry
   defines must satisfy one of the contracts registered under it, or admission is
   refused with `GRAPH_CLOSURE_RETAINED_CONTRACT_INVALID` before the closure
   records it under a role. A `schema_version` the registry does not define stays
   opaque product output and is not parsed as a Lab artifact.

   The terminal is closed structurally. The event that published the run record
   is located by the *signed* `run_record_hash`, and it must publish exactly the
   role set its terminal variant publishes — no missing role, no extra, no
   duplicate (`GRAPH_CLOSURE_TERMINAL_EVENT_EXTRA_PRODUCT`) — and nothing may
   enter the closure after it (`GRAPH_CLOSURE_LIFECYCLE_TAIL_AFTER_TERMINAL`). A
   valid terminal's publishing event is the last event outright; an invalid
   terminal may be followed only by the non-producing `invalidated` transition.
   Together with the signed `lifecycle_head_hash`, which pins every event up to
   the freeze point, this leaves no unbound surface for an appended or injected
   `produced` entry to enter through.
8. Re-derives **Lab validity** from the retained validity result on both terminal
   branches. The declared `status` is not read as an answer: it is recomputed
   from the result's own `gate_results`, and a result that disagrees with its own
   gates, evaluates a gate twice, leaves a failed gate unexplained by any
   retained invalidity finding, or cites an invalidity while every gate passed is
   refused with `EVALUATOR_VALIDITY_GATE_FAILED`. A public bundle whose retained
   result derives `invalid` is refused with `BUNDLE_VARIANT_MISMATCH`, whatever
   the signed `lab_validity` constant says.

   Read the boundary before quoting it: the verifier does not re-run the gates —
   several read evidence a public reader does not hold. It requires the retained
   gate set to be self-consistent and corroborated, and it owns the verdict.

9. Re-derives the **evidence cutoff** for a run that realized one (ADR-ERL2-029
   §3). All three cutoff inputs are resolved by exact hash *and* schema; the
   runtime milestone must bind the process-start receipt the **cutoff** names and
   be lifecycle-reached and run-bound; clock domains must agree; wall and
   monotonic views of the warmup interval must agree within the committed bound;
   and the warmup and observation windows — derived from three separately signed
   instants — must satisfy every committed policy bound.

10. Re-derives the **exact evidence window** for a run that started traffic
   (ADR-ERL2-031). The run freezes a signed `evidence-window-commitment/v1`
   carrying the exact warmup and observation durations before it observes the
   milestone, sealed under `policy_author` — the authority that already bounds the
   window, and deliberately not either of the roles that stamp the clocks the
   derivation is anchored on. The verifier resolves it by hash, authorizes its
   signer, checks its run, policy, process-start, clock-domain and observation
   bindings, requires it to be lifecycle-reached and to precede the capture it
   governs, and then recomputes in integer arithmetic:

   - `cutoff.instant === process_started_at + warmup_ms + observation_ms`;
   - `milestone.occurred_at === process_started_at + warmup_ms`;
   - the observation bundle's window, and every source snapshot's.

   Read the boundary before quoting it. What this proves is that a window was
   fixed under an authorized key **before capture** and that every later instant
   matches it exactly. It does **not** prove the window was the right one: an
   authorized `policy_author` may commit a different window on purpose, and which
   windows are permissible is the cutoff policy's bounds, not this arithmetic. See
   ADR-ERL2-031 §3.4.

   Step 8 was bounds-exact until this landed — a window moved *within* the
   committed bounds, with its milestone moved to match, verified. It no longer
   does.
11. Accounts the **subject-output payload root** in both directions
   (ADR-ERL2-029 §5): every declared payload must exist as a regular file inside
   the authorized root with its exact declared length and digest, and every file
   in that root must be a declared payload or the freeze marker of one. Declared
   payloads are collected from every indexed artifact's descriptors — the
   manifest declares the step-outcome copies, and each step outcome declares the
   subject's own raw output bytes one level down.

   This is byte correspondence, **not** content scanning: payloads are not
   searched for secrets or canaries here, and the declared output-size ceiling is
   not enforced here.

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

Since ADR-ERL2-027 the cleanup derivation runs on **every** invalid environment
terminal, not only the emergency one, and the verifier rebuilds the expectation
rather than reading it:

- the expected safe-action set is recomputed from the pre-action frontier, so an
  omitted action (`EMERGENCY_ACTION_SAFE_ACTION_SKIPPED`) and one relabelled
  unsafe are both refused;
- an aggregate destruction is accepted only when every observed frontier member
  derives an authorized action (`EMERGENCY_ACTION_UNDECLARED_TARGET`);
- the independent post-cleanup observation must exist, be about this run, this
  substrate binding and this frontier, and its `observed_before` must be the
  frontier's own — a probe assembled over an inventory taken *after* a
  destruction is `RESIDUE_PROBE_MISSING`;
- a resource present in the frontier and absent afterwards that was never an
  authorized target is `RESIDUE_UNDECLARED_DESTRUCTION`, which is the
  offline-detectable form of destroy-first-classify-afterwards;
- an action reported `succeeded` whose target is still observed, one reported
  `failed` whose target is gone, a `remaining_resources` set that disagrees with
  the observation, and a record whose `cleanup.status` reads
  `attempted_succeeded` over a non-empty observed residue are all refused;
- the primary finding must name the gate its own `failed_phase` falsifies
  (`INVALID_REASON_PHASE_MISMATCH`) and must be Lab-owned with no subject
  attribution and no scoreable plane (`INVALID_REASON_FABRICATED_FINDING`).

Since ADR-ERL2-029 an invalid terminal that froze a subject output also has its
payload root accounted, on exactly the terms the valid branch uses. A terminal
that failed before freezing one is unaffected — the derivation returns without a
finding rather than inventing a missing role.

### The invalid goldens are verified by the mandatory gate

`npm run evidence:verify` now runs `verify-record` in a **fresh process** against
every invalid-run golden under `fixtures/golden` and requires exit 0 **and** a
derived closure verdict of `valid`. The fixture list is enumerated from the
directory and its count is asserted, so a new invalid golden is covered the day it
lands and none can silently leave.

This closes a real blind spot rather than adding belt and braces. The generator's
`runCli` records `exit_code` and never asserts it, and the transcript it lands in
is the single file excluded from the byte pin — so a verifier regression against
invalid records, which changes no producer bytes, used to leave the gate green.

If the gate fails, read the per-fixture line it prints: it names the fixture, the
exit code and the refusal. **Do not regenerate the fixture to make it pass.** A
golden that stopped verifying means either the fixture or the verifier changed
semantically, and which one it was is the question worth answering.

## When verification fails

Do not weaken the check. Record the refusal code, retain the bundle unchanged,
and treat the run as unverified. Verification is read-only and can be repeated
without limit.
