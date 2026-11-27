import { formatError } from "./errors.js";

const DRIVER_ID_PATHS = [
  "driver_id", "id", "user_id", "driver_user_id", "driver.id", "user.id", "driver.user_id",
];

const DOCUMENT_OWNER_PATHS = [
  "driver_id", "driver_user_id", "user_id", "owner_id", "owner_user_id", "subject_user_id",
  "account_id", "applicant_id", "driver.id", "user.id", "applicant.id", "driver.user_id",
];

function valueAtDirectPath(record, path) {
  return path.split(".").reduce((value, part) => value?.[part], record);
}

function valuesAtPaths(record, paths) {
  return [...new Set(paths
    .map(path => valueAtDirectPath(record, path))
    .filter(value => (typeof value === "string" || typeof value === "number") && String(value).trim())
    .map(String))];
}

export function driverIdentityIds(...records) {
  return new Set(records.flatMap(record => valuesAtPaths(record, DRIVER_ID_PATHS)));
}

export function documentHasDriverAssociation(record) {
  return valuesAtPaths(record, DOCUMENT_OWNER_PATHS).length > 0;
}

export function documentBelongsToDriver(record, driverIds) {
  const ownerIds = valuesAtPaths(record, DOCUMENT_OWNER_PATHS);
  return ownerIds.some(id => driverIds.has(id));
}

function documentRecordId(record, kind) {
  const fields = kind === "aadhaar" ? ["submission_id", "id"] : ["document_id", "id"];
  const id = valuesAtPaths(record, fields)[0];
  return id || "";
}

export function driverKycDocuments(driver, detail, queueRecords, selectedDriverId = "") {
  const driverIds = driverIdentityIds(driver, detail);
  if ((typeof selectedDriverId === "string" || typeof selectedDriverId === "number") && String(selectedDriverId).trim()) {
    driverIds.add(String(selectedDriverId));
  }

  const records = new Map();
  let anonymousId = 0;
  function addRecord(record, kind) {
    if (!record || typeof record !== "object" || Array.isArray(record)) return;
    const id = documentRecordId(record, kind);
    const key = id ? `${kind}:${id}` : `${kind}:anonymous:${anonymousId++}`;
    const existing = records.get(key);
    records.set(key, existing ? { ...existing, ...record, _kind: kind } : { ...record, _kind: kind });
  }

  for (const record of Array.isArray(queueRecords) ? queueRecords : []) {
    const kind = record?._kind === "aadhaar" ? "aadhaar" : "documents";
    if (documentBelongsToDriver(record, driverIds)) addRecord(record, kind);
  }

  for (const [kind, field] of [["documents", "documents"], ["aadhaar", "aadhaar"]]) {
    const embeddedRecords = Array.isArray(detail?.[field]) ? detail[field] : [];
    for (const record of embeddedRecords) {
      if (!documentHasDriverAssociation(record) || documentBelongsToDriver(record, driverIds)) {
        addRecord(record, kind);
      }
    }
  }

  return [...records.values()];
}

export function isPendingReview(record) {
  const status = ["status", "review_status", "decision", "review_decision"]
    .map(key => record?.[key])
    .find(value => value !== undefined && value !== null && value !== "");
  const normalized = typeof status === "string" ? status.trim().toLowerCase() : "";
  return normalized === "pending" || normalized === "submitted";
}

export function driverKycCounts(records) {
  const submissions = Array.isArray(records) ? records : [];
  return {
    submitted: submissions.length,
    pending: submissions.filter(isPendingReview).length,
  };
}

export function aadhaarReviewPayload(decision, note, version) {
  return kycReviewPayload(decision, note, version, "aadhaar");
}

export function kycReviewEndpoint(kind, id) {
  if (kind !== "documents" && kind !== "aadhaar") {
    throw new Error("KYC review type must be documents or aadhaar.");
  }
  const collection = kind === "aadhaar" ? "aadhaar" : "documents";
  return `/api/v1/admin/${collection}/${encodeURIComponent(String(id))}/review`;
}

export function kycReviewPayload(decision, note, version, kind = "documents") {
  if (decision !== "approved" && decision !== "rejected") {
    throw new Error("A KYC review decision must be approved or rejected.");
  }
  const normalizedNote = String(note ?? "").trim() || (decision === "approved" ? "Approved by admin" : "");
  if (normalizedNote.length < 3 || normalizedNote.length > 500) {
    throw new Error("A KYC review note must be between 3 and 500 characters.");
  }
  const numericVersion = Number(version);
  if (!Number.isInteger(numericVersion) || numericVersion < 1) {
    throw new Error("A valid KYC record version is required.");
  }
  return { decision, note: normalizedNote, version: numericVersion };
}

export function vehicleBelongsToDriver(vehicle, driverIds) {
  const ownerIds = [vehicle?.driver_id, vehicle?.current_driver_id]
    .filter(value => (typeof value === "string" || typeof value === "number") && String(value).trim())
    .map(String);
  return ownerIds.length > 0 && ownerIds.some(id => driverIds.has(id));
}

export function vehicleHasDriverAssociation(vehicle) {
  return [vehicle?.driver_id, vehicle?.current_driver_id]
    .some(value => (typeof value === "string" || typeof value === "number") && String(value).trim());
}

export function vehiclePricingVersion(vehicle) {
  const values = [
    vehicle?.pricing_version,
    vehicle?.vehicle_pricing_version,
    vehicle?.rate_version,
    vehicle?.pricing?.version,
    vehicle?.pricing?.version_number,
    vehicle?.vehicle_pricing?.version,
    vehicle?.vehicle_pricing?.version_number,
    vehicle?.rate?.version,
    vehicle?.rate?.version_number,
    vehicle?.rate_details?.version,
    vehicle?.rate_details?.version_number,
  ];
  for (const value of values) {
    const version = Number(value);
    if (Number.isInteger(version) && version > 0) return version;
  }
  return undefined;
}

export function vehiclePricingStatus(vehicle) {
  const value = [
    vehicle?.pricing_status,
    vehicle?.pricing?.status,
    vehicle?.pricing?.review_status,
    vehicle?.rate?.pricing_status,
    vehicle?.rate?.status,
  ].find(status => status !== undefined && status !== null && String(status).trim());
  return value == null ? "unknown" : String(value).trim().toLowerCase();
}

export function vehiclePricingReviewEndpoint(vehicleId) {
  if (vehicleId == null || String(vehicleId).trim() === "") {
    throw new Error("A vehicle ID is required for pricing review.");
  }
  return `/api/v1/admin/vehicles/${encodeURIComponent(String(vehicleId))}/pricing/review`;
}

export function vehiclePricingReviewPayload(decision, note, version) {
  return kycReviewPayload(decision, note, version, "documents");
}

export function reviewSuccessMessage(responseData, fallback = "Review saved.") {
  const payload = responseData?.data ?? responseData;
  if (typeof payload === "string" && payload.trim()) return payload.trim();
  for (const value of [payload?.message, payload?.detail, payload?.result?.message, payload?.result?.detail]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return fallback;
}

export function reviewRequestError(error) {
  return formatError(error);
}

function safeReviewConflictDetail(error) {
  const data = error?.response?.data;
  const candidates = [
    data?.detail,
    data?.message,
    data?.error,
    data?.error?.detail,
    data?.error?.message,
    data?.data?.detail,
    data?.data?.message,
    data?.data?.error?.detail,
    data?.data?.error?.message,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const detail = candidate.trim();
    if (!detail || detail.length > 180 || /[{}\[\]]/.test(detail)) continue;
    if (/traceback|stack trace|sql|database|exception|status code|request failed|internal server|bearer|token|password|secret|<!doctype|<html/i.test(detail)) continue;
    return detail;
  }
  return "";
}

export function reviewConflictMessage(error, { requestVersion, latestRecord } = {}) {
  if (Number(error?.response?.status) !== 409) return reviewRequestError(error);
  const requestVersionNumber = Number(requestVersion);
  const latestVersionNumber = vehiclePricingVersion(latestRecord) ?? Number(latestRecord?.version ?? latestRecord?.version_number);
  const statusValue = [latestRecord?.pricing_status, latestRecord?.pricing?.status, latestRecord?.pricing?.review_status, latestRecord?.status, latestRecord?.review_status, latestRecord?.decision, latestRecord?.review_decision]
    .find(value => value !== undefined && value !== null && String(value).trim());
  const latestStatus = statusValue == null ? "unknown" : String(statusValue).trim().toLowerCase();
  if (["approved", "rejected"].includes(latestStatus)) {
    return "This item has already been reviewed. The latest status is shown.";
  }
  if (["pending", "submitted"].includes(latestStatus) && Number.isInteger(latestVersionNumber) && latestVersionNumber > 0 && Number.isInteger(requestVersionNumber) && latestVersionNumber !== requestVersionNumber) {
    return "This item changed. Review the latest details and try again.";
  }
  if (["pending", "submitted"].includes(latestStatus)) {
    const detail = safeReviewConflictDetail(error);
    return detail
      ? `The API rejected the review: ${detail}`
      : "The API rejected the review, but the latest record is still pending at this version. Refresh and try again.";
  }
  return "This item may have changed or was already reviewed. Refresh and try again.";
}
