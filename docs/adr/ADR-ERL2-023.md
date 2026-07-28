# ADR-ERL2-023 — two design discrepancies resolved: `select`'s flag, and the signed controller activation receipt

**Status:** accepted
**Date:** 2026-07-28
**Deciders:** Lab Core Owner, Integrity/Security Owner, Environment/Challenge Governor, Verifier Reviewer
**Amends:** `external-reality-lab-design-v2.md` `2.0.0-draft.11` Appendix C (the
`select` invocation) and §12 (the activation receipt). Both amendments are
recorded here rather than applied to the design in place, which is how
ADR-ERL2-020 §5 already handled a §8.5 ordering it could not take literally.
**Extends:** ADR-ERL2-020 (selection operates on a run), ADR-ERL2-021 and
ADR-ERL2-022 (environment signer roles and phase model).

## Context

Slice 6.5 shipped the selection and environment branches and, in doing so, made
two long-standing gaps between the design and the implementation impossible to
keep ignoring. Both were visible in the 6.5-B handoff as "documented
discrepancies", which is a polite way of saying nobody had decided. Calling 6.5
complete with either left ambiguous would mean shipping a normative document the
code knowingly contradicts.

### C-1. Appendix C says `erl2 select --request HASH`; the shipped flag is `--run`

Appendix C spells the invocation `erl2 select --request HASH --source-trust-config
PATH`, which describes a command that takes a free-standing selection request.
ADR-ERL2-020 §5 and §6 replaced that model: `select` advances a *run's* durable
selection walk one transition at a time, building the request from the run's own
retained evidence. There is no caller-supplied request to name.

The mismatch had been invisible because the only thing exercising it was a
negative case in the pinned evidence transcript — and that transcript is one of
the byte-pin's seven exclusions, so it went stale for a whole slice while
asserting `POLICY_COMMAND_NOT_IMPLEMENTED` for a command that had shipped.

### C-2. Design §12 requires a signed controller receipt; none existed

§12's phase table requires, for `activate/start/cutoff`, "signed controller and
traffic receipts, typed clock domain". The traffic receipt and the clock domain
exist. The controller receipt did not, and could not: the only artifact activation
produced was `EnvironmentOperationReceiptV1`, whose frozen schema has **no
signature field at all**. It records what the substrate did. It cannot say who
authorized it.

`controller` has been in the frozen `SignerRole` enum since V2 was frozen, with
nothing signing under it.

## Decision

### 1. Appendix C is amended: `select` takes `--run`, and `--request` is not a flag

The design's text is wrong and the implementation is right. `select` is a walk
over a durably accepted run, so it is addressed the way every other mutating
command is:

```text
erl2 select --run UUID --run-root PATH --registry PATH --source-trust-config PATH --expires INSTANT
```

`--request` is **not** accepted, and is not accepted as a deprecated alias
either. An alias would be worse than the mismatch it fixed: it would let a caller
believe a request can be supplied from outside, which is exactly the input
ADR-ERL2-020 §6 removed so that a second `select` cannot draw a second beacon
round. `erl2 select --request x` refuses with `CFG_UNKNOWN_FLAG`, and that
refusal is now pinned in `tests/e2e/expectedRefusals.test.ts` so the next drift is
a test failure rather than a stale golden.

Everything else Appendix C says about `select` — that it accepts no source,
fallback-source, seed, nonce, round, index, handle or retry flag, and that
`--source-trust-config` is verifier-controlled configuration and never policy or
receipt input — is unchanged and remains true.

### 2. `challenge-activation-receipt/v1` is added, signed by the `controller`

An additive contract, `ERL2-C-155`, on the same terms as `cancellation-request/v1`
(`ERL2-C-063`, ADR-ERL2-018): **no existing schema changed shape or meaning**, and
the role it uses was already in the frozen enum.

It binds what a controller must be accountable for, and nothing else:

| Field | Why it is there |
|---|---|
| `selected_challenge_journey_binding_hash` | *which* challenge went live |
| `environment_instance_hash` | *where* it went live |
| `execution_plan_hash` | under which plan |
| `environment_fingerprint_hash` | against which verified baseline |
| `connection_step_outcome_hash` | the connect outcome that made activation legal |
| `mutation_receipt_hash` | the substrate change the driver actually performed |
| `activated_at` | when |

The verifier authorizes it to `controller`, not to `environment_governor`. The
governor provisions the environment; the controller decides a challenge goes live
in it; §12 names them as separate receipts, and collapsing them would let the
authority that built the environment also attest, unobserved, that a sealed case
was opened inside it. The development trust policy grants `controller` to its own
key.

The schema is added to the environment closure's supporting set: a reader needs it
to check the activation, but it is not a separately roled output of the terminal.

### 2a. The driver receipt stays unsigned, deliberately

`EnvironmentOperationReceiptV1` is not given a signature field. It is the
*driver's* record of a substrate operation, and a driver is untrusted
infrastructure — the design's whole posture is that the Lab derives its
conclusions from what it observes of the driver rather than from what the driver
attests. The activation receipt is signed by the Lab-side controller and *cites*
the driver receipt by hash, which is the correct direction of trust.

## Consequences

- One new contract, one new trust-policy key, one new verifier signer row, one new
  supporting schema. Every golden was regenerated for the trust-policy change.
- `activate` now produces two artifacts: the driver's `mutation-receipt` and the
  controller's `challenge-activation-receipt`. The e2e suite asserts both are
  produced, and the pinned environment golden asserts the second by name.
- Appendix C and §12 of `external-reality-lab-design-v2.md` are amended by this
  ADR. The design file itself is unmodified; the next revision should fold both
  amendments in, along with ADR-ERL2-020 §5's §8.5 ordering amendment.
- A future signed environment contract still needs a row in ADR-ERL2-021 §2 or
  here before it can be retained. The fail-closed speed bump is preserved.

## Evidence

- `tests/e2e/expectedRefusals.test.ts` — `select|2|CFG_UNKNOWN_FLAG` pinned, with
  the reason recorded at the entry.
- `tests/e2e/environmentRun.test.ts` — `challenge-activation-receipt` among the
  produced roles of a completed environment run.
- `tests/contract/environmentGolden.test.ts` — the pinned golden asserts the
  activation receipt is produced.
- `npm run evidence:verify` — the environment run's bundle, carrying the signed
  activation receipt in its closure, verifies offline at exit 0.
