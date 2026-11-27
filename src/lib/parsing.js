export function formatDateTime(value) {
  if (value == null || value === "") return "-";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  const formatted = new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).format(date);
  return formatted.replace(/\b(am|pm)\b/g, (match) => match.toUpperCase());
}


export function valueIsPresent(value) {
  return value !== undefined && value !== null && value !== "";
}

export function valueAtPath(row, path) {
  return path.split(".").reduce((value, part) => value?.[part], row);
}

export function findNestedValue(row, key, depth = 0) {
  if (!row || typeof row !== "object" || Array.isArray(row) || depth > 4) return undefined;
  const wanted = String(key).toLowerCase().replace(/[^a-z0-9]/g, "");
  for (const [name, value] of Object.entries(row)) {
    if (String(name).toLowerCase().replace(/[^a-z0-9]/g, "") === wanted && valueIsPresent(value)) return value;
  }
  for (const value of Object.values(row)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const found = findNestedValue(value, key, depth + 1);
      if (valueIsPresent(found)) return found;
    }
  }
  return undefined;
}

export function firstValue(row, keys) {
  for (const key of keys) {
    const value = valueAtPath(row, key);
    if (valueIsPresent(value)) return value;
  }
  for (const key of keys) {
    const value = findNestedValue(row, key.split(".").at(-1));
    if (valueIsPresent(value)) return value;
  }
  return undefined;
}

export function recordsFrom(data) {
  const payload = data?.data ?? data;
  const containers = [payload, payload?.data].filter(container => container && typeof container === "object" && !Array.isArray(container));
  const keys = [
    "items", "results", "records", "customers", "drivers", "bookings",
    "ride_requests", "documents", "aadhaar", "submissions", "callback_requests", "messages",
    "conversations", "taxi_categories", "coupons", "service_areas", "supported_routes",
    "areas", "routes", "vehicles",
  ];
  for (const container of containers) {
    for (const key of keys) {
      if (Array.isArray(container[key])) {
        return container[key].filter(item => item && typeof item === "object" && !Array.isArray(item));
      }
    }
  }
  if (Array.isArray(payload)) return payload.filter(item => item && typeof item === "object" && !Array.isArray(item));
  return [];
}

export function hasMoreFromPayload(data) {
  const payload = data?.data ?? data;
  const containers = [payload, payload?.data, payload?.meta, payload?.pagination, payload?.page].filter(container => container && typeof container === "object" && !Array.isArray(container));
  for (const container of containers) {
    for (const key of ["has_more", "hasMore", "more"]) {
      if (typeof container[key] === "boolean") return container[key];
    }
  }
  return null;
}

export function countFromPayload(data) {
  const payload = data?.data ?? data;
  const containers = [payload, payload?.data, payload?.meta, payload?.pagination, payload?.page];
  for (const container of containers) {
    if (!container || typeof container !== "object" || Array.isArray(container)) continue;
    for (const key of ["total", "count", "total_count", "totalCount", "total_records"]) {
      const value = container[key];
      if (typeof value === "number" && Number.isFinite(value)) return value;
      if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value);
    }
  }
  return null;
}
export function unwrappedRecord(data) {
  const payload = data?.data ?? data;
  if (payload && !Array.isArray(payload) && typeof payload === "object") {
    for (const key of ["customer", "profile", "record", "submission", "user", "driver"]) {
      if (payload[key] && typeof payload[key] === "object") return { ...payload, ...payload[key] };
    }
  }
  return payload;
}

export function displayText(value) {
  if (value == null || value === "") return "-";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "-";
}
export function formatCell(value) {
  if (value == null || value === "") return "-";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "object") return "-";
  return String(value);
}

export function isSafeDocumentUrl(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  const trimmed = value.trim();
  if (trimmed.startsWith("blob:")) return true;
  try {
    const url = new URL(trimmed, typeof window !== "undefined" ? window.location.origin : "http://localhost");
    if (url.protocol === "https:") return true;
    if (url.protocol === "http:") {
      if (typeof window !== "undefined" && url.origin === window.location.origin) return true;
      return url.hostname === "localhost" || url.hostname === "127.0.0.1";
    }
    return false;
  } catch {
    return false;
  }
}

export function detailEntries(record) {
  const entries = [];
  const hidden = /(token|password|secret|authorization|url|file|image|blob|base64|content|bytes)/i;
  function visit(value, prefix = "", depth = 0) {
    if (!value || typeof value !== "object" || depth > 3 || entries.length >= 24) return;
    for (const [key, child] of Object.entries(value)) {
      if (hidden.test(key)) continue;
      const label = prefix ? `${prefix} / ${key.replace(/_/g, " ")}` : key.replace(/_/g, " ");
      if (child && typeof child === "object" && !Array.isArray(child)) visit(child, label, depth + 1);
      else if (Array.isArray(child)) {
        const values = child.filter(valueIsPresent);
        if (values.length && values.every(item => typeof item !== "object")) entries.push([label, values.join(", ")]);
      } else if (valueIsPresent(child)) {
        const isTimestamp = /(created_at|updated_at|modified_at|pickup_at|submitted_at|registered_at)$/i.test(key);
        entries.push([label, isTimestamp ? formatDateTime(child) : child]);
      }
      if (entries.length >= 24) break;
    }
  }
  visit(record);
  return entries;
}
