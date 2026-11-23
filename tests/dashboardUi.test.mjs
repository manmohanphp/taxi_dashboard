import test from "node:test";
import assert from "node:assert/strict";
import { accountHeading, clearStoredAuthToken, dashboardListState, isAdminSectionRestricted, reviewQueueCountLabel, reviewQueueCounts } from "../src/lib/dashboardUi.js";

test("restricts admin sections for non-admin users but allows account pages", () => {
  for (const section of ["drivers", "kyc", "customers", "rides", "communications", "pricing", "configuration"]) {
    assert.equal(isAdminSectionRestricted(false, section), true, `${section} should require admin access`);
    assert.equal(isAdminSectionRestricted(true, section), false, `${section} should remain available to admins`);
  }
  assert.equal(isAdminSectionRestricted(false, "dashboard"), false);
  assert.equal(isAdminSectionRestricted(false, "account"), false);
});

test("shows an account heading for the current user's role", () => {
  assert.equal(accountHeading(true), "TAXIGO ADMIN ACCOUNT");
  assert.equal(accountHeading(false), "TAXIGO ACCOUNT");
});

test("clears the stored access token on sign out", () => {
  const removedKeys = [];
  clearStoredAuthToken({ removeItem: key => removedKeys.push(key) });
  assert.deepEqual(removedKeys, ["taxigo_access_token"]);
});

test("keeps each dashboard list result independent and clears rows on failure", async () => {
  const [bookings, rideRequests] = await Promise.allSettled([
    Promise.resolve({ data: { items: [{ booking_id: "booking-1" }] } }),
    Promise.reject(new Error("ride request service unavailable")),
  ]);

  assert.deepEqual(dashboardListState(bookings), {
    rows: [{ booking_id: "booking-1" }],
    error: "",
  });
  const failedRideRequests = dashboardListState(rideRequests);
  assert.deepEqual(failedRideRequests.rows, []);
  assert.ok(failedRideRequests.error);
});

test("preserves a successful review queue count when the other queue fails", () => {
  assert.deepEqual(reviewQueueCounts(
    { status: "fulfilled", value: 7 },
    { status: "rejected", reason: new Error("queue unavailable") },
  ), { aadhaarCount: 7, documentCount: null, total: null });
  assert.equal(reviewQueueCountLabel(7, "", false), "7");
  assert.equal(reviewQueueCountLabel(null, "Document queue unavailable", false), "Unavailable");
});
