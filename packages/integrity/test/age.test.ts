/**
 * age v1 round-trip and tamper behaviour.
 *
 * The judge expectation ciphertext referenced by `JourneyStepCommitmentV1` is a
 * real age file, so these are the properties the oracle partition rests on.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { ageDecrypt, ageEncrypt, ageRecipientOf, developmentAgeIdentity } from "../src/index.js";

test("age: round-trips for a single recipient", () => {
  const judge = developmentAgeIdentity("judge");
  const plaintext = Buffer.from(JSON.stringify({ expected: "value", canary: "erl2-canary-" + "0".repeat(32) }));
  const file = ageEncrypt(plaintext, [ageRecipientOf(judge)]);
  assert.ok(file.toString("utf8").startsWith("age-encryption.org/v1\n"));
  assert.deepEqual(ageDecrypt(file, judge), plaintext);
  // The plaintext, and in particular the canary, never appears in the file.
  assert.ok(!file.toString("latin1").includes("erl2-canary-"));
});

test("age: every named recipient can open the same file, others cannot", () => {
  const a = developmentAgeIdentity("judge-a");
  const b = developmentAgeIdentity("judge-b");
  const outsider = developmentAgeIdentity("selector");
  const plaintext = Buffer.from("expectation");
  const file = ageEncrypt(plaintext, [ageRecipientOf(a), ageRecipientOf(b)]);
  assert.deepEqual(ageDecrypt(file, a), plaintext);
  assert.deepEqual(ageDecrypt(file, b), plaintext);
  assert.throws(() => ageDecrypt(file, outsider), /no age stanza decrypts/);
});

test("age: a mutated header or payload fails to open", () => {
  const judge = developmentAgeIdentity("judge");
  const file = ageEncrypt(Buffer.from("expectation"), [ageRecipientOf(judge)]);

  const flippedPayload = Buffer.from(file);
  const lastIndex = flippedPayload.length - 1;
  flippedPayload[lastIndex] = (flippedPayload[lastIndex] as number) ^ 0xff;
  assert.throws(() => ageDecrypt(flippedPayload, judge));

  const macStart = file.toString("latin1").indexOf("--- ") + 4;
  const tamperedMac = Buffer.from(file);
  tamperedMac[macStart] = (tamperedMac[macStart] as number) === 0x41 ? 0x42 : 0x41;
  assert.throws(() => ageDecrypt(tamperedMac, judge), /MAC does not verify|no age stanza/);
});

test("age: an empty plaintext round-trips", () => {
  const judge = developmentAgeIdentity("judge");
  const file = ageEncrypt(Buffer.alloc(0), [ageRecipientOf(judge)]);
  assert.equal(ageDecrypt(file, judge).length, 0);
});

test("age: a payload spanning several STREAM chunks round-trips", () => {
  const judge = developmentAgeIdentity("judge");
  const plaintext = Buffer.alloc(65536 * 2 + 17, 0x5a);
  const file = ageEncrypt(plaintext, [ageRecipientOf(judge)]);
  assert.deepEqual(ageDecrypt(file, judge), plaintext);
});
