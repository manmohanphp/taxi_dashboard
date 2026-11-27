export const STATUS_MESSAGES = {
  400: "Please check your input and try again.",
  401: "Your session has expired. Please log in again.",
  403: "You don't have permission to perform this action.",
  404: "The requested information could not be found.",
  405: "This action is not allowed.",
  409: "This item changed or was already reviewed. Refresh and try again.",
  422: "Please check the entered information.",
  429: "Too many requests. Please try again shortly.",
  500: "Something went wrong on the server. Please try again later.",
  502: "Something went wrong on the server. Please try again later.",
  503: "Something went wrong on the server. Please try again later.",
};

export const NETWORK_ERROR_MESSAGE =
  "Can't connect right now. Check your internet and try again.";

export const GENERIC_ERROR_MESSAGE = "Something went wrong. Please try again.";

const GENERIC_BACKEND_MESSAGES = new Set([
  "bad request",
  "unauthorized",
  "forbidden",
  "not found",
  "conflict",
  "unprocessable entity",
  "too many requests",
  "internal server error",
  "bad gateway",
  "service unavailable",
  "error",
  "failed",
]);

function normalizeText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function extractFromValue(value, depth = 0) {
  if (value == null || depth > 4) return "";

  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);

  if (Array.isArray(value)) {
    const messages = value
      .map((item) => {
        if (typeof item === "string") return item.trim();
        if (item && typeof item === "object") {
          return (
            normalizeText(item.msg) ||
            normalizeText(item.message) ||
            normalizeText(item.detail) ||
            normalizeText(item.description) ||
            normalizeText(item.error)
          );
        }
        return "";
      })
      .filter(Boolean);
    if (messages.length) return messages.join(" ");
    return "";
  }

  if (typeof value === "object") {
    for (const key of ["detail", "message", "error", "msg", "description", "title", "detail_message"]) {
      const found = extractFromValue(value[key], depth + 1);
      if (found) return found;
    }
  }

  return "";
}

function extractBackendMessage(error) {
  const data = error?.response?.data ?? error?.data;
  const validationDetails = extractValidationDetails(data);
  if (validationDetails) return validationDetails;
  const fromData = extractFromValue(data);
  if (fromData) return fromData;
  if (!error?.response && typeof error?.message === "string") return error.message.trim();
  return "";
}

function isSafeUserMessage(text) {
  if (typeof text !== "string") return false;
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 120) return false;
  if (/^[\[{]/.test(trimmed)) return false;
  if (/[{}[\]]/.test(trimmed)) return false;

  const lower = trimmed.toLowerCase();
  if (GENERIC_BACKEND_MESSAGES.has(lower)) return false;

  const technicalPatterns = [
    /status code/i,
    /request failed/i,
    /network error/i,
    /timeout/i,
    /axios/i,
    /typeerror/i,
    /referenceerror/i,
    /syntaxerror/i,
    /stack/i,
    /undefined/i,
    /\bnull\b/i,
    /err_/i,
    /cors/i,
    /json/i,
    /<!doctype/i,
    /<html/i,
    /failed to fetch/i,
    /load failed/i,
    /traceback/i,
  ];
  if (technicalPatterns.some((pattern) => pattern.test(lower))) return false;

  return true;
}

function validationLocation(value) {
  const parts = Array.isArray(value)
    ? value
    : typeof value === "string" ? value.split(".") : [];
  return parts
    .map(part => String(part ?? "").trim())
    .filter(part => part && !/^(body|query|path|header|cookie)$/i.test(part) && !/^\d+$/.test(part))
    .filter(part => /^[a-z0-9_-]{1,40}$/i.test(part) && !/(token|password|secret|authorization)/i.test(part))
    .slice(-4)
    .join(".");
}

function safeValidationText(value) {
  const text = normalizeText(value);
  if (!isSafeUserMessage(text)) return "";
  if (/[+\w.-]+@[\w.-]+\.[a-z]{2,}/i.test(text) || /\+\d{8,15}/.test(text)) return "";
  if (/\bbearer\s+[a-z0-9._~-]{8,}/i.test(text) || /(?:access|refresh)[_-]?token\s*[:=]\s*\S+/i.test(text) || /(?:password|secret|api[_ -]?key)\s*[:=]\s*\S+/i.test(text)) return "";
  return text;
}

function collectValidationMessages(value, location = "", depth = 0) {
  if (value == null || depth > 5) return [];
  if (Array.isArray(value)) {
    return value.flatMap(item => collectValidationMessages(item, location, depth + 1));
  }
  if (typeof value === "string") {
    const message = safeValidationText(value);
    return message ? [`${location ? `${location}: ` : ""}${message}`] : [];
  }
  if (typeof value !== "object") return [];

  const itemLocation = validationLocation(value.location ?? value.loc ?? value.field ?? value.path) || location;
  const message = safeValidationText(value.message ?? value.msg ?? value.detail ?? value.description);
  if (message) return [`${itemLocation ? `${itemLocation}: ` : ""}${message}`];

  const results = [];
  for (const key of ["details", "issues", "errors"]) {
    if (value[key] !== undefined) results.push(...collectValidationMessages(value[key], itemLocation, depth + 1));
  }
  if (results.length) return results;

  // Some APIs encode field errors as a map: { field_name: "message" }.
  for (const [key, child] of Object.entries(value)) {
    if (["location", "loc", "field", "path", "input", "ctx", "type", "code"].includes(key.toLowerCase())) continue;
    const childLocation = validationLocation(key);
    if (childLocation) results.push(...collectValidationMessages(child, [itemLocation, childLocation].filter(Boolean).join("."), depth + 1));
  }
  return results;
}

function extractValidationDetails(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 5 || Array.isArray(value)) return "";
  for (const key of ["details", "issues", "errors"]) {
    if (value[key] !== undefined) {
      const messages = collectValidationMessages(value[key]).slice(0, 5);
      if (messages.length) return messages.join("; ").slice(0, 500);
    }
  }
  for (const key of ["error", "data", "detail"]) {
    const nested = extractValidationDetails(value[key], depth + 1);
    if (nested) return nested;
  }
  return "";
}

export function formatError(error) {
  if (typeof console !== "undefined" && typeof console.error === "function") {
    try {
      const status = Number(error?.response?.status || error?.status);
      const code = typeof error?.code === "string" ? error.code : undefined;
      console.error("TaxiGo API request failed", {
        status: Number.isFinite(status) && status > 0 ? status : undefined,
        code,
      });
    } catch {
      // Ignore console failures.
    }
  }

  if (typeof error === "string") {
    return isSafeUserMessage(error) ? error : GENERIC_ERROR_MESSAGE;
  }

  if (!error) return GENERIC_ERROR_MESSAGE;

  const response = error.response || (error.status ? error : null);
  const status = Number(response?.status || error?.status);

  // Non-HTTP errors: network, timeout, cancellation, etc.
  if (!response) {
    const raw = `${error.code || ""} ${error.message || ""}`.toLowerCase();
    if (
      raw.includes("timeout") ||
      raw.includes("network") ||
      raw.includes("econnaborted") ||
      raw.includes("err_network") ||
      raw.includes("failed to fetch") ||
      raw.includes("load failed")
    ) {
      return NETWORK_ERROR_MESSAGE;
    }

    const extracted = extractBackendMessage(error);
    if (isSafeUserMessage(extracted)) return extracted;
    return GENERIC_ERROR_MESSAGE;
  }

  if (status === 408) return NETWORK_ERROR_MESSAGE;
  if (status === 409) return STATUS_MESSAGES[409];
  if (status >= 500) return STATUS_MESSAGES[500];

  const extracted = extractBackendMessage(error);
  if (isSafeUserMessage(extracted)) return extracted;

  if (STATUS_MESSAGES[status]) return STATUS_MESSAGES[status];
  return GENERIC_ERROR_MESSAGE;
}

// Aliases for compatibility with different shared-utility naming conventions.
export const getErrorMessage = formatError;
export const getUserFriendlyError = formatError;
export const toErrorMessage = formatError;
export const handleError = formatError;

export default formatError;
