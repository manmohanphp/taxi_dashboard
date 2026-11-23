import { formatError } from "./errors.js";
import { recordsFrom } from "./parsing.js";

const accountSections = new Set(["dashboard", "account"]);

export function isAdminSectionRestricted(isAdmin, section) {
  return !isAdmin && !accountSections.has(section);
}

export function accountHeading(isAdmin) {
  return isAdmin ? "TAXIGO ADMIN ACCOUNT" : "TAXIGO ACCOUNT";
}

export function clearStoredAuthToken(storage) {
  storage.removeItem("taxigo_access_token");
}

export function dashboardListState(result) {
  if (result?.status === "fulfilled") {
    return { rows: recordsFrom(result.value?.data), error: "" };
  }
  return { rows: [], error: formatError(result?.reason) };
}

export function reviewQueueCounts(aadhaarResult, documentResult) {
  const aadhaarCount = aadhaarResult?.status === "fulfilled" ? aadhaarResult.value : null;
  const documentCount = documentResult?.status === "fulfilled" ? documentResult.value : null;
  return {
    aadhaarCount,
    documentCount,
    total: aadhaarCount != null && documentCount != null ? aadhaarCount + documentCount : null,
  };
}

export function reviewQueueCountLabel(count, error, loading) {
  if (Number.isFinite(count)) return String(count);
  if (error) return "Unavailable";
  return loading ? "Loading…" : "—";
}
