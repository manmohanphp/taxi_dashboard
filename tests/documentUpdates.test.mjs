import test from 'node:test';
import assert from 'node:assert/strict';
import { decisionBody, listParams, reviewBody, versionFilePath, workflowTime } from '../src/lib/documentUpdates.js';

test('request filters map to API pagination and replacement filters omit status', () => {
  assert.deepEqual(listParams({ page: 2, kind: 'insurance', driver: ' driver-id ', status: 'requested', tab: 'requests' }), { page: 2, per_page: 20, document_type: 'insurance', driver_id: 'driver-id', status: 'requested' });
  assert.deepEqual(listParams({ page: 1, status: 'requested', tab: 'replacements' }), { page: 1, per_page: 20 });
});

test('approval and rejection use the request version and validate bounded windows', () => {
  assert.deepEqual(decisionBody({ reason: '  Renewal allowed ', version: 3 }, 'approve'), { reason: 'Renewal allowed', version: 3, window_days: 7, invalidate_old: false });
  assert.deepEqual(decisionBody({ reason: 'Not yet', version: 8 }, 'reject'), { reason: 'Not yet', version: 8 });
  for (const days of [0, 31, 1.5]) assert.throws(() => decisionBody({ reason: 'Valid reason', days }, 'unlock'), /between 1 and 30/);
  assert.throws(() => decisionBody({ reason: 'ok', version: 1 }, 'approve'), /Reason/);
  assert.throws(() => decisionBody({ reason: 'Valid reason' }, 'approve'), /version/);
});

test('direct unlock requires an explicit invalidation choice', () => {
  assert.deepEqual(decisionBody({ reason: 'Direct grant', days: 30 }, 'unlock'), { reason: 'Direct grant', window_days: 30, invalidate_old: false });
  assert.equal(decisionBody({ reason: 'Invalid old scan', days: 1, invalidate: true }, 'unlock').invalidate_old, true);
});

test('replacement review uses the slot revision even when a deadline has passed', () => {
  const update = { version: 4, candidate_version_id: 'candidate', request: { unlock_expires_at: '2020-01-01T00:00:00Z' } };
  assert.deepEqual(reviewBody(update, 'approved', 'Checked scan'), { version: 4, decision: 'approved', note: 'Checked scan' });
  assert.throws(() => reviewBody({ version: 4 }, 'approved', 'Checked scan'), /Refresh/);
  assert.throws(() => reviewBody(update, 'rejected', ''), /review note/);
});

test('version file paths encode IDs and timestamps tolerate missing values', () => {
  assert.equal(versionFilePath('slot/1', 'version/2', 0), '/api/v1/admin/document-slots/slot%2F1/versions/version%2F2/files/0');
  assert.equal(workflowTime(null), '—');
  assert.equal(workflowTime('invalid'), 'Unavailable');
});
