import test from "node:test";
import assert from "node:assert/strict";
import {
  aadhaarReviewPayload,
  documentBelongsToDriver,
  driverKycCounts,
  driverIdentityIds,
  driverKycDocuments,
  kycReviewEndpoint,
  kycReviewPayload,
  reviewConflictMessage,
  reviewRequestError,
  reviewSuccessMessage,
  vehiclePricingVersion,
  vehiclePricingReviewPayload,
} from "../src/lib/kycDocuments.js";

test("vehicle pricing review uses the pricing version, never the vehicle version", () => {
  const vehicle = { version: 8, pricing_version: 2, pricing_status: "pending" };
  assert.equal(vehiclePricingVersion(vehicle), 2);
  assert.equal(vehiclePricingReviewPayload("approved", "Approved by admin", vehiclePricingVersion(vehicle)).version, 2);
  assert.equal(vehiclePricingVersion({ version: 8, pricing_status: "pending" }), undefined);
  assert.throws(() => vehiclePricingReviewPayload("approved", "Approved by admin", vehiclePricingVersion({ version: 8 })), /version/);
});

const selectedDriverId = "bfcf5988-6c5f-4374-9419-66cffc9dc083";
const otherDriverId = "ad01c188-0800-4d55-82fd-62029043e18f";

test("combines selected driver's detail arrays with only its associated queue records", () => {
  const driver = { driver_id: selectedDriverId };
  const detail = {
    id: selectedDriverId,
    documents: [{ id: "document-1", driver_id: selectedDriverId, kind: "permit", status: "approved", version: 1 }],
    aadhaar: [{ id: "aadhaar-1", driver_id: selectedDriverId, status: "approved", version: 2 }],
  };
  const queue = [
    { _kind: "documents", id: "document-1", driver_id: selectedDriverId, status: "pending", version: 3 },
    { _kind: "documents", id: "document-2", driver_id: selectedDriverId, kind: "insurance", status: "pending", version: 1 },
    { _kind: "aadhaar", id: "aadhaar-2", driver_id: selectedDriverId, status: "pending", version: 1 },
    { _kind: "aadhaar", id: "other-aadhaar", driver_id: otherDriverId, status: "pending", version: 1 },
  ];

  const records = driverKycDocuments(driver, detail, queue, selectedDriverId);

  assert.deepEqual(records.map(record => `${record._kind}:${record.id}`), [
    "documents:document-1",
    "documents:document-2",
    "aadhaar:aadhaar-2",
    "aadhaar:aadhaar-1",
  ]);
  assert.equal(records.find(record => record.id === "document-1").status, "approved");
  assert.equal(records.filter(record => record._kind === "aadhaar").length, 2);
  assert.ok(!records.some(record => record.id === "other-aadhaar"));
  assert.deepEqual(driverKycCounts(records), { submitted: 4, pending: 2 });
});

test("does not treat a submission's own ID as its driver association", () => {
  const driverIds = driverIdentityIds({ driver_id: selectedDriverId });
  assert.equal(documentBelongsToDriver({ id: selectedDriverId, driver_id: otherDriverId }, driverIds), false);
});

test("counts unique submissions and counts only explicit pending status as pending", () => {
  const counts = driverKycCounts([
    { id: "pending-doc", status: "pending" },
    { id: "approved-doc", status: "approved" },
    { id: "rejected-doc", status: "rejected" },
    { id: "missing-status" },
    { id: "uppercase-pending", review_status: " PENDING " },
  ]);

  assert.deepEqual(counts, { submitted: 5, pending: 2 });
});

test("builds Aadhaar review payload from the Swagger schema", () => {
  assert.deepEqual(aadhaarReviewPayload("approved", "Approved by admin", "2"), {
    decision: "approved",
    note: "Approved by admin",
    version: 2,
  });
  assert.deepEqual(aadhaarReviewPayload("rejected", "Image is unreadable", 1), {
    decision: "rejected",
    note: "Image is unreadable",
    version: 1,
  });
  assert.throws(() => aadhaarReviewPayload("suspended", "Valid note", 1), /approved or rejected/);
  assert.throws(() => aadhaarReviewPayload("rejected", "no", 1), /between 3 and 500/);
  assert.throws(() => aadhaarReviewPayload("approved", "Valid note", 0), /record version/);
});

test("targets the documented normal-document and Aadhaar review endpoints", () => {
  assert.equal(
    kycReviewEndpoint("documents", "document id/1"),
    "/api/v1/admin/documents/document%20id%2F1/review",
  );
  assert.equal(
    kycReviewEndpoint("aadhaar", "submission-123"),
    "/api/v1/admin/aadhaar/submission-123/review",
  );
  assert.throws(() => kycReviewEndpoint("drivers", "record-1"), /documents or aadhaar/);
});

test("builds Swagger-valid KYC approval payloads when the note is blank", () => {
  assert.deepEqual(kycReviewPayload("approved", "", "4", "documents"), {
    decision: "approved",
    note: "Approved by admin",
    version: 4,
  });
  assert.deepEqual(kycReviewPayload("approved", "", 2, "aadhaar"), {
    decision: "approved",
    note: "Approved by admin",
    version: 2,
  });
  assert.throws(() => kycReviewPayload("rejected", "", 1), /review note must be between 3 and 500/);
  assert.throws(() => kycReviewPayload("approved", "Approved", 0), /record version/);
});

test("uses short review error messages and backend success messages", () => {
  assert.equal(
    reviewRequestError({ response: { status: 409, data: { detail: "The review version is out of date." } } }),
    "This item changed or was already reviewed. Refresh and try again.",
  );
  assert.equal(reviewSuccessMessage({ message: "Aadhaar approved successfully." }), "Aadhaar approved successfully.");
  assert.equal(reviewSuccessMessage({}, "Document approved."), "Document approved.");
});

test("shows a short message for a KYC 409 using the fresh record", () => {
  const conflict = { response: { status: 409, data: { detail: "Document changed or already reviewed" } } };
  const staleVersionMessage = reviewConflictMessage(conflict, {
    requestVersion: 4,
    latestRecord: { status: "pending", version: 5 },
  });
  assert.equal(staleVersionMessage, "This item changed. Review the latest details and try again.");

  const rejectedMessage = reviewConflictMessage(conflict, {
    requestVersion: 5,
    latestRecord: { status: "rejected", version: 5 },
  });
  assert.equal(rejectedMessage, "This item has already been reviewed. The latest status is shown.");
});
