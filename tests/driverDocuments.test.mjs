import test from "node:test";
import assert from "node:assert/strict";
import { driverDocumentActions, driverDocumentCollections, driverDocumentFileCount, driverDocumentFileEndpoint, driverDocumentPresentation, driverDocumentSubmissionDate, formatDriverDocumentFileCount, normalizeDriverDocumentStatus } from "../src/lib/driverDocuments.js";
import { formatDateTime } from "../src/lib/parsing.js";
import { driverKycCounts } from "../src/lib/kycDocuments.js";

const approvedDriverId = "bfcf5988-6c5f-4374-9419-66cffc9dc083";

function approvedDriverResponse() {
  return {
    id: approvedDriverId,
    status: "approved",
    documents: Array.from({ length: 9 }, (_, index) => ({
      id: `approved-document-${index + 1}`,
      driver_id: approvedDriverId,
      kind: "vehicle_registration",
      status: "approved",
      created_at: "2026-10-29T11:30:00Z",
      file_count: 1,
      version: 1,
    })),
    aadhaar: [{
      id: "approved-aadhaar-submission",
      status: "approved",
      review_note: null,
      consent_version: "v1",
      requires_review: false,
      file_count: 2,
      version: 1,
    }],
  };
}

test("reads all 9 approved documents and the approved Aadhaar submission from driver detail", () => {
  const collections = driverDocumentCollections(approvedDriverResponse());

  assert.equal(collections.documents.length, 9);
  assert.equal(collections.aadhaar.length, 1);
  assert.ok(collections.documents.every(document => document.status === "approved"));
  assert.equal(collections.documents[0].kind, "vehicle_registration");
  assert.equal(collections.documents[0].created_at, "2026-10-29T11:30:00Z");
  assert.equal(collections.documents[0].file_count, 1);
  assert.equal(collections.aadhaar[0].status, "approved");
  assert.deepEqual(driverKycCounts([...collections.documents, ...collections.aadhaar]), { submitted: 10, pending: 0 });

  assert.deepEqual(driverDocumentPresentation(collections.documents[0], "documents"), {
    label: "vehicle_registration",
    status: "approved",
    uploadedAt: "2026-10-29T11:30:00Z",
    fileCount: 1,
  });
  assert.deepEqual(driverDocumentPresentation(collections.aadhaar[0], "aadhaar"), {
    label: "Aadhaar submission",
    status: "approved",
    uploadedAt: undefined,
    fileCount: 2,
  });
});

test("formats the confirmed Aadhaar Admin Read file_count and does not infer a date", () => {
  const aadhaarReadResponse = {
    id: "approved-aadhaar-submission",
    status: "approved",
    review_note: null,
    version: 1,
    consent_version: "v1",
    file_count: 1,
    requires_review: false,
  };

  assert.equal(driverDocumentFileCount(aadhaarReadResponse, "aadhaar"), 1);
  assert.equal(formatDriverDocumentFileCount(aadhaarReadResponse, "aadhaar"), "1 file");
  assert.equal(driverDocumentSubmissionDate(aadhaarReadResponse, "aadhaar"), undefined);
  assert.equal(formatDateTime(driverDocumentSubmissionDate(aadhaarReadResponse, "aadhaar")), "-");
  assert.equal(formatDriverDocumentFileCount({ ...aadhaarReadResponse, file_count: 2 }, "aadhaar"), "2 files");
  assert.equal(formatDriverDocumentFileCount({ ...aadhaarReadResponse, file_count: null }, "aadhaar"), "-");
});

test("preserves pending, rejected, and suspended documents without status filtering", () => {
  const statuses = ["pending", "rejected", "suspended"];
  const collections = driverDocumentCollections({
    documents: statuses.map((status, index) => ({
      id: `document-${index + 1}`,
      driver_id: approvedDriverId,
      kind: "driver_permit",
      status,
      created_at: "2026-10-29T11:30:00Z",
      file_count: 1,
      version: 1,
    })),
    aadhaar: [],
  });

  assert.deepEqual(collections.documents.map(document => document.status), statuses);
  assert.equal(collections.documents.length, 3);
  assert.deepEqual(collections.documents.map(document => driverDocumentPresentation(document, "documents").status), statuses);
});

test("returns empty arrays when driver detail has no documents", () => {
  assert.deepEqual(driverDocumentCollections({ documents: [], aadhaar: [] }), { documents: [], aadhaar: [] });
  assert.deepEqual(driverDocumentCollections({}), { documents: [], aadhaar: [] });
});

test("builds the authenticated admin file endpoints for documents and Aadhaar", () => {
  assert.equal(
    driverDocumentFileEndpoint("documents", "document-123", 0),
    "/api/v1/admin/documents/document-123/files/0",
  );
  assert.equal(
    driverDocumentFileEndpoint("aadhaar", "aadhaar-456", 1),
    "/api/v1/admin/aadhaar/aadhaar-456/files/1",
  );
});

test("shows only View Document for an approved document from the actual driver detail response", () => {
  const driver = approvedDriverResponse();
  const approvedDocuments = [...driver.documents, ...driver.aadhaar];

  const onlyView = {
    view: true,
    approve: false,
    reject: false,
  };
  assert.ok(approvedDocuments.every(document => document.status === "approved"));
  for (const document of approvedDocuments) assert.deepEqual(driverDocumentActions(document), onlyView);
});

test("shows View, Approve, and Reject for a pending document", () => {
  assert.deepEqual(driverDocumentActions({
    id: "pending-document",
    driver_id: approvedDriverId,
    kind: "vehicle_registration",
    status: " PENDING ",
  }), {
    view: true,
    approve: true,
    reject: true,
  });
});

test("shows only View Document for a rejected document", () => {
  assert.deepEqual(driverDocumentActions({
    id: "rejected-document",
    driver_id: approvedDriverId,
    kind: "vehicle_registration",
    status: " Rejected ",
  }), {
    view: true,
    approve: false,
    reject: false,
  });
});

test("keeps document actions removal-free for every status", () => {
  for (const status of ["pending", "submitted", "approved", "rejected", "suspended"]) {
    assert.equal(Object.hasOwn(driverDocumentActions(status), "remove"), false);
  }
});

test("shows View, Approve, and Reject for submitted documents and case variations with whitespace", () => {
  for (const statusVal of ["submitted", " Submitted ", "SUBMITTED", "  submitted  "]) {
    assert.deepEqual(driverDocumentActions({
      id: "submitted-doc",
      driver_id: approvedDriverId,
      kind: "aadhaar",
      status: statusVal,
    }), {
      view: true,
      approve: true,
      reject: true,
    });
  }
});

test("normalizes direct and nested document review status without using driver account status", () => {
  assert.equal(normalizeDriverDocumentStatus({ status: " APPROVED ", review: { status: "pending" } }), "approved");
  assert.equal(normalizeDriverDocumentStatus({ review: { status: " Rejected " } }), "rejected");
  assert.equal(normalizeDriverDocumentStatus({ status: "   " }), "unknown");
  assert.equal(normalizeDriverDocumentStatus({ account: { status: "approved" } }), "unknown");
});
