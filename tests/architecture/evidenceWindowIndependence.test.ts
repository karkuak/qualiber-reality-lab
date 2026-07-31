/**
 * The producer's evidence-window construction and the verifier's re-derivation
 * must stay **independent** (ADR-ERL2-031 §7).
 *
 * This is the same argument ADR-ERL2-030 §5 makes for the signer inventory, and
 * it matters more here. The whole point of the window commitment is that a
 * reader can recompute the cutoff *without trusting the producer*. A verifier
 * that reached into `sealWindowCommitment` or `committedCutoffMs` for its
 * expected value would be re-reading a producer computation with extra steps —
 * the `lab_validity` defect ADR-ERL2-024 named, one contract further on.
 *
 * So the two arithmetics are written separately, and this suite pins that:
 * neither package imports the other's, and the verifier does not read the
 * producer's role table.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PRODUCER_SIGNED_MEMBER_ROLES } from "@erl2/core";
import { signedMemberRuleFor } from "@erl2/public-verifier";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function sourceFiles(relative: string): readonly { readonly path: string; readonly text: string }[] {
  const out: { path: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const child = path.join(dir, name);
      if (statSync(child).isDirectory()) {
        walk(child);
        continue;
      }
      if (!name.endsWith(".ts")) continue;
      out.push({ path: path.relative(repoRoot, child), text: readFileSync(child, "utf8") });
    }
  };
  walk(path.join(repoRoot, relative));
  return out;
}

test("WINDOW-INDEPENDENCE: the verifier never imports the producer's window construction", () => {
  for (const file of sourceFiles("packages/public-verifier/src")) {
    for (const producerSymbol of [
      "evidenceWindow",
      "sealWindowCommitment",
      "assertMilestoneOnCommittedBoundary",
      "committedCutoffMs",
    ]) {
      assert.ok(
        !file.text.includes(producerSymbol),
        `${file.path} reaches into the producer's evidence-window construction (${producerSymbol}); ` +
          `the verifier must recompute the window from retained bytes and its own arithmetic`,
      );
    }
  }
});

test("WINDOW-INDEPENDENCE: the producer never imports the verifier's derivation", () => {
  for (const file of sourceFiles("packages/core/src")) {
    assert.ok(
      !file.text.includes("windowDerivation"),
      `${file.path} reaches into the verifier's exact window derivation`,
    );
    assert.ok(
      !file.text.includes("deriveExactEvidenceWindow"),
      `${file.path} calls the verifier's exact window derivation`,
    );
  }
});

test("WINDOW-INDEPENDENCE: both role tables declare the commitment, and agree", () => {
  // A divergence here is a real defect in either direction: the producer would
  // inventory a member the verifier refuses outright, or the verifier would
  // require one the producer cannot classify — which stops finalization. It must
  // fail here rather than in a golden.
  assert.equal(
    PRODUCER_SIGNED_MEMBER_ROLES.get("evidence-window-commitment/v1"),
    "policy_author",
    "the producer must seal the evidence window under policy_author",
  );
  assert.equal(
    signedMemberRuleFor("evidence-window-commitment/v1")?.role,
    "policy_author",
    "the verifier must authorize the evidence window under policy_author",
  );
});

test("WINDOW-INDEPENDENCE: the window signer is not one of the two clock-stamping roles", () => {
  // The load-bearing half of §4. The cutoff derivation is anchored on two
  // independently signed instants — the supervisor's process start and the
  // attestor's milestone. A signer that both chose the window and stamped one of
  // those instants could move them together and leave the arithmetic closing,
  // which is exactly the residual this package closes.
  const windowRole = signedMemberRuleFor("evidence-window-commitment/v1")?.role;
  for (const clockRole of ["traffic_supervisor", "runtime_attestor"]) {
    assert.notEqual(
      windowRole,
      clockRole,
      `the evidence window is signed by ${clockRole}, which also stamps a clock the cutoff ` +
        `derivation is anchored on`,
    );
  }
  assert.equal(signedMemberRuleFor("traffic-process-start-receipt/v1")?.role, "traffic_supervisor");
  assert.equal(signedMemberRuleFor("runtime-milestone/v1")?.role, "runtime_attestor");
});
