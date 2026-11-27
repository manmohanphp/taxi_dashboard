export function driverDocumentCollections(driver) {
  return {
    documents: Array.isArray(driver?.documents) ? driver.documents : [],
    aadhaar: Array.isArray(driver?.aadhaar) ? driver.aadhaar : [],
  };
}

function firstPresent(record, keys) {
  for (const key of keys) {
    const value = record?.[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

export function driverDocumentPresentation(record, kind) {
  const documentKind = firstPresent(record, ["kind", "document_type", "document_kind", "type"]);

  return {
    label: kind === "aadhaar" ? "Aadhaar submission" : documentKind ?? "-",
    status: normalizeDriverDocumentStatus(record),
    uploadedAt: driverDocumentSubmissionDate(record, kind),
    fileCount: driverDocumentFileCount(record, kind),
  };
}

export function driverDocumentSubmissionDate(record, kind) {
  const fields = kind === "aadhaar"
    ? ["submitted_at", "submission_date", "submission_datetime", "submitted_on", "date_submitted", "submittedAt", "submissionDate", "submittedOn", "dateSubmitted", "created_at", "createdAt", "created_on", "createdOn", "uploaded_at", "uploadedAt", "uploaded_on", "uploadedOn", "upload_date", "uploadDate"]
    : ["created_at", "submitted_at", "uploaded_at", "submission_date", "submitted_on", "date_submitted", "createdAt", "created_on", "submittedAt", "submissionDate", "submittedOn", "dateSubmitted", "uploadedAt", "uploaded_on", "uploadedOn", "upload_date", "uploadDate"];
  return firstPresent(record, fields);
}

function parseFileCount(value) {
  if (typeof value === "number") return Number.isInteger(value) && value >= 0 ? value : undefined;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value.trim());
  return undefined;
}

export function driverDocumentFileCount(record, kind) {
  const value = kind === "aadhaar"
    ? record?.file_count
    : firstPresent(record, ["file_count", "files_count", "image_count", "attachment_count", "number_of_files"]);
  return parseFileCount(value);
}

export function formatDriverDocumentFileCount(record, kind) {
  const count = driverDocumentFileCount(record, kind);
  if (count === undefined) return "-";
  return `${count} file${count === 1 ? "" : "s"}`;
}

const DOCUMENT_STATUS_PATHS = [
  "status",
  "review_status",
  "decision",
  "review_decision",
  "review.status",
  "review.review_status",
  "verification.status",
  "document.status",
  "document.review_status",
];

function valueAtPath(record, path) {
  return path.split(".").reduce((value, part) => value?.[part], record);
}

export function normalizeDriverDocumentStatus(record) {
  const value = DOCUMENT_STATUS_PATHS
    .map(path => valueAtPath(record, path))
    .find(candidate => typeof candidate === "string" && candidate.trim());
  return value ? value.trim().toLowerCase() : "unknown";
}

export function driverDocumentActions(statusOrRecord) {
  const status = typeof statusOrRecord === "object" && statusOrRecord !== null
    ? normalizeDriverDocumentStatus(statusOrRecord)
    : String(statusOrRecord ?? "").trim().toLowerCase();
  const isPendingOrSubmitted = status === "pending" || status === "submitted";
  return {
    view: true,
    approve: isPendingOrSubmitted,
    reject: isPendingOrSubmitted,
  };
}

export function driverDocumentFileEndpoint(kind, id, index) {
  const collection = kind === "aadhaar" ? "aadhaar" : "documents";
  const recordId = encodeURIComponent(String(id));
  return `/api/v1/admin/${collection}/${recordId}/files/${index}`;
}
