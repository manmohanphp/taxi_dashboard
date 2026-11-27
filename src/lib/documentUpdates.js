export const DOCUMENT_TYPES = ['aadhaar', 'licence', 'registration', 'insurance', 'fitness', 'permit', 'profile_photo'];
export const REQUEST_STATUSES = ['requested', 'approved', 'rejected', 'cancelled', 'expired', 'completed'];
export function listParams({ page, kind, driver, status, tab }) {
  const params = { page, per_page: 20 };
  if (kind) params.document_type = kind;
  if (driver?.trim()) params.driver_id = driver.trim();
  if (tab === 'requests' && status) params.status = status;
  return params;
}
export function workflowTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unavailable' : date.toLocaleString();
}
export function decisionBody({ reason, days = 7, invalidate = false, version }, action) {
  const text = String(reason || '').trim();
  if (text.length < 3 || text.length > 500) throw new Error('Reason must be between 3 and 500 characters.');
  const body = { reason: text };
  if (action !== 'unlock') {
    if (!Number.isInteger(Number(version)) || Number(version) < 1) throw new Error('A current request version is required.');
    body.version = Number(version);
  }
  if (action !== 'reject') {
    if (!Number.isInteger(Number(days)) || Number(days) < 1 || Number(days) > 30) throw new Error('Window must be between 1 and 30 days.');
    body.window_days = Number(days);
    body.invalidate_old = Boolean(invalidate);
  }
  return body;
}
export function reviewBody(update, decision, note) {
  const text = String(note || '').trim();
  if (!['approved', 'rejected'].includes(decision) || text.length < 3 || text.length > 500) throw new Error('Enter a review note between 3 and 500 characters.');
  if (!Number.isInteger(Number(update?.version)) || Number(update.version) < 1 || !update.candidate_version_id) throw new Error('Refresh the replacement before reviewing it.');
  return { version: Number(update.version), decision, note: text };
}
export function versionFilePath(slot, version, index) {
  return `/api/v1/admin/document-slots/${encodeURIComponent(slot)}/versions/${encodeURIComponent(version)}/files/${index}`;
}
