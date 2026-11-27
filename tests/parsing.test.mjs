import { formatDateTime } from "../src/lib/parsing.js";

test("formatDateTime converts to IST", () => {
  assert.equal(formatDateTime("2026-10-23T11:50:00Z"), "23 Oct 2026, 05:20 PM");
});

test("formatDateTime handles invalid", () => {
  assert.equal(formatDateTime(null), "-");
  assert.equal(formatDateTime(""), "-");
  assert.equal(formatDateTime("not-a-date"), "-");
});
import test from "node:test";
import assert from "node:assert/strict";
import { recordsFrom, countFromPayload, firstValue } from "../src/lib/parsing.js";

test("recordsFrom reads items", () => {
  assert.deepEqual(recordsFrom({ items: [{ id: 1 }, { id: 2 }] }), [{ id: 1 }, { id: 2 }]);
});

test("recordsFrom reads customers", () => {
  assert.deepEqual(recordsFrom({ customers: [{ id: 3 }] }), [{ id: 3 }]);
});

test("recordsFrom reads nested data.items", () => {
  assert.deepEqual(recordsFrom({ data: { items: [{ id: 4 }] } }), [{ id: 4 }]);
});

test("countFromPayload prefers total", () => {
  assert.equal(countFromPayload({ total: 42, items: [1, 2] }), 42);
});

test("countFromPayload supports count", () => {
  assert.equal(countFromPayload({ count: "7" }), 7);
});

test("countFromPayload falls back to null", () => {
  assert.equal(countFromPayload({ items: [1, 2] }), null);
});

test("firstValue finds nested email", () => {
  assert.equal(firstValue({ profile: { email: "a@example.com" } }, ["email"]), "a@example.com");
});

test("firstValue returns undefined when missing", () => {
  assert.equal(firstValue({ id: 1 }, ["email"]), undefined);
});