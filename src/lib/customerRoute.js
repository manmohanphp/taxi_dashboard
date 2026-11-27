export function customerIdFromPath(pathname) {
  const match = String(pathname || "").match(/^\/customers\/([^/]+)\/?$/);
  if (!match) return "";
  try { return decodeURIComponent(match[1]); }
  catch { return match[1]; }
}

export function customerDetailsPath(customerId) {
  return `/customers/${encodeURIComponent(String(customerId))}`;
}
