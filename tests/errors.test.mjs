import test from "node:test";
import assert from "node:assert/strict";
import { formatError, NETWORK_ERROR_MESSAGE } from "../src/lib/errors.js";

test("formatError maps 401 to friendly message", () => {
  const error = { response: { status: 401, data: {} } };
  assert.equal(formatError(error), "Your session has expired. Please log in again.");
});

test("formatError preserves safe business message on 403", () => {
  const error = { response: { status: 403, data: { detail: "An administrator cannot review their own document" } } };
  assert.equal(formatError(error), "An administrator cannot review their own document");
});

test("formatError extracts FastAPI validation messages", () => {
  const error = { response: { status: 422, data: { detail: [{ msg: "Field required" }, { msg: "value is not a valid email address" }] } } };
  assert.equal(formatError(error), "Field required value is not a valid email address");
});

test("formatError displays safe nested OpenAPI validation details with field locations", () => {
  const error = { response: { status: 422, data: { error: {
    code: "validation_error",
    message: "Request validation failed",
    details: [
      { location: ["body", "phone"], message: "String should match the expected pattern" },
      { location: ["body", "code"], message: "Field required" },
    ],
  } } } };
  assert.equal(formatError(error), "phone: String should match the expected pattern; code: Field required");
});

test("formatError supports safe validation detail maps without exposing supplied values", () => {
  const error = { response: { status: 422, data: { error: {
    message: "Request validation failed",
    details: { phone: "Use international format", password: "Traceback contains password=secret" },
  } } } };
  assert.equal(formatError(error), "phone: Use international format");
});

test("formatError maps network errors", () => {
  const error = { code: "ERR_NETWORK", message: "Network Error" };
  assert.equal(formatError(error), NETWORK_ERROR_MESSAGE);
});

test("formatError maps timeout errors", () => {
  const error = { code: "ECONNABORTED", message: "timeout of 30000ms exceeded" };
  assert.equal(formatError(error), NETWORK_ERROR_MESSAGE);
});

test("formatError handles detail/message/error fields", () => {
  assert.equal(formatError({ response: { status: 400, data: { message: "Invalid phone number" } } }), "Invalid phone number");
  assert.equal(formatError({ response: { status: 404, data: { error: { message: "Customer not found" } } } }), "Customer not found");
});

test("formatError never returns raw JSON", () => {
  const error = { response: { status: 500, data: { detail: { foo: "bar" } } } };
  const result = formatError(error);
  assert(!result.includes("{"), "result should not contain JSON");
  assert.equal(result, "Something went wrong on the server. Please try again later.");
});

test("formatError handles null and strings", () => {
  assert.equal(formatError(null), "Something went wrong. Please try again.");
  assert.equal(formatError("  "), "Something went wrong. Please try again.");
  assert.equal(formatError("Safe message"), "Safe message");
});
