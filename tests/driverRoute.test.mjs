import test from "node:test";
import assert from "node:assert/strict";
import { driverDetailsPath, driverIdFromPath, kycDriverDetailsPath, kycDriverIdFromPath } from "../src/lib/driverRoute.js";

test("driver detail URLs preserve and encode the driver ID", () => {
  assert.equal(driverDetailsPath("driver-123"), "/drivers/driver-123");
  assert.equal(driverDetailsPath("driver/123"), "/drivers/driver%2F123");
});

test("driver IDs are read from direct detail URLs, including a trailing slash", () => {
  assert.equal(driverIdFromPath("/drivers/driver-123"), "driver-123");
  assert.equal(driverIdFromPath("/drivers/driver-123/"), "driver-123");
  assert.equal(driverIdFromPath("/drivers/driver%2F123"), "driver/123");
});

test("the list route and unrelated paths are not treated as driver detail routes", () => {
  assert.equal(driverIdFromPath("/drivers"), "");
  assert.equal(driverIdFromPath("/rides/driver-123"), "");
  assert.equal(driverIdFromPath("/drivers/driver-123/history"), "");
});

test("malformed encoded driver IDs remain available for a proper API error", () => {
  assert.equal(driverIdFromPath("/drivers/%E0%A4%A"), "%E0%A4%A");
});

test("KYC driver detail routes preserve and encode the driver ID", () => {
  assert.equal(kycDriverDetailsPath("driver/123"), "/kyc/drivers/driver%2F123");
  assert.equal(kycDriverIdFromPath("/kyc/drivers/driver%2F123"), "driver/123");
  assert.equal(kycDriverIdFromPath("/kyc/drivers/driver-123/"), "driver-123");
  assert.equal(kycDriverIdFromPath("/kyc"), "");
  assert.equal(kycDriverIdFromPath("/drivers/driver-123"), "");
});

test("malformed encoded KYC driver IDs remain available for a proper API error", () => {
  assert.equal(kycDriverIdFromPath("/kyc/drivers/%E0%A4%A"), "%E0%A4%A");
});
