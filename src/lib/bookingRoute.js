export function bookingIdFromPath(pathname) {
  const match = String(pathname || "").match(/^\/bookings\/([^/]+)\/?$/);
  if (!match) return "";
  try { return decodeURIComponent(match[1]); }
  catch { return match[1]; }
}

export function bookingDetailsPath(bookingId) {
  return `/bookings/${encodeURIComponent(String(bookingId))}`;
}
