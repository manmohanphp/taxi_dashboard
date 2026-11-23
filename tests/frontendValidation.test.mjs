import test from "node:test";
import assert from "node:assert/strict";
import {
  createConversationMessagePayload,
  createUuidV4,
  isValidE164Phone,
  normalizeIndianPhone,
  isValidOtpCode,
  settlementPolicyError,
} from "../src/lib/frontendValidation.js";

test("E.164 phone validation follows the published OTP request pattern", () => {
  assert.equal(isValidE164Phone("+919876543210"), true);
  assert.equal(isValidE164Phone(" +919876543210 "), true);
  assert.equal(isValidE164Phone("919876543210"), false);
  assert.equal(isValidE164Phone("+0123456789"), false);
  assert.equal(isValidE164Phone("+1234567"), false);
});

test("normalizes Indian mobile numbers for OTP requests", () => {
  assert.equal(normalizeIndianPhone("9876543210"), "+919876543210");
  assert.equal(normalizeIndianPhone(" +919876543210 "), "+919876543210");
  assert.equal(normalizeIndianPhone("987654321"), "");
  assert.equal(normalizeIndianPhone("1234567890"), "");
  assert.equal(normalizeIndianPhone("+9198765432100"), "");
});

test("OTP validation accepts only 4 to 10 digits", () => {
  assert.equal(isValidOtpCode("1234"), true);
  assert.equal(isValidOtpCode("1234567890"), true);
  assert.equal(isValidOtpCode("123"), false);
  assert.equal(isValidOtpCode("12345678901"), false);
  assert.equal(isValidOtpCode("12a4"), false);
});

test("settlement policy validation allows blank or 3 to 255 characters", () => {
  assert.equal(settlementPolicyError(""), "");
  assert.equal(settlementPolicyError(null), "");
  assert.equal(settlementPolicyError("abc"), "");
  assert.match(settlementPolicyError("ab"), /3 and 255/);
  assert.match(settlementPolicyError("x".repeat(256)), /3 and 255/);
});

test("conversation payload uses a UUID and the documented body field", () => {
  const payload = createConversationMessagePayload("  Hello TaxiGo  ", {
    randomUUID: () => "123e4567-e89b-42d3-a456-426614174000",
  });
  assert.deepEqual(payload, {
    client_message_id: "123e4567-e89b-42d3-a456-426614174000",
    body: "Hello TaxiGo",
  });
  assert.match(payload.client_message_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
});

test("UUID fallback uses secure random bytes and sets RFC 4122 version bits", () => {
  const uuid = createUuidV4({ getRandomValues: bytes => bytes.fill(0) });
  assert.equal(uuid, "00000000-0000-4000-8000-000000000000");
  const fallbackUuid = createUuidV4({ randomUUID: () => { throw new Error("unavailable"); }, getRandomValues: bytes => bytes.fill(0) });
  assert.equal(fallbackUuid, "00000000-0000-4000-8000-000000000000");
});

test("conversation message payload rejects blank and overlong text", () => {
  assert.throws(() => createConversationMessagePayload("   ", { randomUUID: () => "123e4567-e89b-42d3-a456-426614174000" }), /Enter a message/);
  assert.throws(() => createConversationMessagePayload("x".repeat(4001), { randomUUID: () => "123e4567-e89b-42d3-a456-426614174000" }), /4000 characters/);
});
