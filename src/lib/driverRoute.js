export function driverIdFromPath(pathname) {
  const match = String(pathname || "").match(/^\/drivers\/([^/]+)\/?$/);
  if (!match) return "";
  try { return decodeURIComponent(match[1]); }
  catch { return match[1]; }
}

export function driverDetailsPath(driverId) {
  return `/drivers/${encodeURIComponent(String(driverId))}`;
}

export function kycDriverIdFromPath(pathname) {
  const match = String(pathname || "").match(/^\/kyc\/drivers\/([^/]+)\/?$/);
  if (!match) return "";
  try { return decodeURIComponent(match[1]); }
  catch { return match[1]; }
}

export function kycDriverDetailsPath(driverId) {
  return `/kyc/drivers/${encodeURIComponent(String(driverId))}`;
}
