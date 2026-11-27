import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, formatError } from './api';
import { DOCUMENT_TYPES, REQUEST_STATUSES, decisionBody, listParams, reviewBody, versionFilePath, workflowTime } from './lib/documentUpdates';
import './documentUpdates.css';

const label = value => String(value || '—').replaceAll('_', ' ');
const changed = () => window.dispatchEvent(new Event('taxigo:document-updates-changed'));

function VersionFiles({ slot, version, title }) {
  const [files, setFiles] = useState([]);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false; const urls = [];
    setFiles([]); setError('');
    if (!slot || !version) return undefined;
    Promise.all(Array.from({ length: version.file_count || 0 }, async (_, index) => {
      try {
        const response = await api.get(versionFilePath(slot, version.id, index), { responseType: 'blob' });
        if (cancelled) return null;
        const url = URL.createObjectURL(response.data); urls.push(url);
        return { index, url, type: response.data.type, side: version.files?.[index]?.side || 'unknown' };
      } catch { return { index, error: true }; }
    })).then(result => { if (!cancelled) setFiles(result.filter(Boolean)); }).catch(() => { if (!cancelled) setError('Could not load files.'); });
    return () => { cancelled = true; urls.forEach(URL.revokeObjectURL); };
  }, [slot, version?.id]);
  return <section className="du-version"><h4>{title}</h4>{!version ? <p>Not available</p> : <><p>Status: {label(version.status)} · Expiry: {version.expires_on || '—'}</p>{error && <p role="alert">{error}</p>}{!version.file_count && <p>No files available.</p>}{files.map(file => <div key={file.index}><p>File {file.index + 1} · Side: {label(file.side)}</p>{file.error ? <p role="alert">File unavailable.</p> : file.type.startsWith('image/') ? <img src={file.url} alt={`${title}, ${file.side} side`}/> : file.type === 'application/pdf' ? <iframe src={file.url} title={`${title} PDF ${file.index + 1}`}/> : <a href={file.url} download>Download file</a>}</div>)}</>}</section>;
}

function Replacement({ slotId, onClose, onChanged }) {
  const [detail, setDetail] = useState(null); const [note, setNote] = useState(''); const [busy, setBusy] = useState(false); const [message, setMessage] = useState(''); const saving = useRef(false);
  const load = useCallback(async () => { const response = await api.get(`/api/v1/admin/document-slots/${encodeURIComponent(slotId)}`); setDetail(response.data); }, [slotId]);
  useEffect(() => { let active = true; api.get(`/api/v1/admin/document-slots/${encodeURIComponent(slotId)}`).then(r => { if (active) setDetail(r.data); }).catch(e => { if (active) setMessage(formatError(e)); }); return () => { active = false; }; }, [slotId]);
  async function review(decision) {
    if (saving.current) return;
    saving.current = true;
    try { const body = reviewBody(detail?.update, decision, note); setBusy(true); setMessage(''); await api.post(`/api/v1/admin/document-slots/${encodeURIComponent(slotId)}/review`, body); setMessage('Replacement review saved.'); setNote(''); await load(); onChanged(); changed(); }
    catch (e) { if (e?.response?.status === 409) { try { await load(); } catch {} setMessage('The replacement changed or cannot be reviewed. The latest available details are shown.'); } else setMessage(formatError(e)); } finally { saving.current = false; setBusy(false); }
  }
  const update = detail?.update; const versions = detail?.versions || [];
  return <section className="panel du-panel" aria-label="Replacement review"><div className="du-row"><h3>Replacement review: {label(detail?.document_type)}</h3><button type="button" className="btn secondary" onClick={onClose}>Close</button></div>{message && <p role="status">{message}</p>}{detail && <><p>Workflow: {label(update?.state)}. The old file remains active unless invalidated.</p><div className="du-compare"><VersionFiles slot={slotId} version={versions.find(v => v.id === update.active_version_id)} title="Current active version"/><VersionFiles slot={slotId} version={versions.find(v => v.id === update.candidate_version_id)} title="Replacement candidate"/></div>{update?.candidate_version_id && <><label>Review note<textarea value={note} maxLength={500} onChange={e => setNote(e.target.value)}/></label><div className="du-row"><button className="btn primary" disabled={busy || note.trim().length < 3} onClick={() => review('approved')}>Approve replacement</button><button className="btn secondary" disabled={busy || note.trim().length < 3} onClick={() => review('rejected')}>Reject replacement</button></div><p>After rejection, a new upload is allowed only while the original window remains open.</p></>}</>}</section>;
}

function Decision({ request, unlockDriver, unlockKind, action, onClose, onChanged }) {
  const [reason, setReason] = useState(''); const [days, setDays] = useState(7); const [invalidate, setInvalidate] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const saving = useRef(false);
  async function submit(e) {
    e.preventDefault(); if (saving.current) return;
    saving.current = true;
    try {
      const body = decisionBody({ reason, days, invalidate, version: request?.version }, action);
      if (body.invalidate_old && !window.confirm('Invalidating the old document may make the driver ineligible and take them offline. Continue?')) return;
      setBusy(true); setError('');
      const path = action === 'unlock' ? `/api/v1/admin/drivers/${encodeURIComponent(unlockDriver)}/documents/${encodeURIComponent(unlockKind)}/unlock` : `/api/v1/admin/document-update-requests/${encodeURIComponent(request.id)}/${action}`;
      await api.post(path, body); changed(); onChanged(); onClose();
    } catch (err) { if (err?.response?.status === 409) { setError('This record changed or cannot be updated. Refresh and review the latest details.'); onChanged(); } else setError(formatError(err)); } finally { saving.current = false; setBusy(false); }
  }
  return <form className="du-form" onSubmit={submit}><h4>{action === 'unlock' ? `Unlock ${label(unlockKind)}` : `${label(action)} request`}</h4><label>Reason<textarea autoFocus value={reason} onChange={e => setReason(e.target.value)} minLength={3} maxLength={500} required /></label>{action !== 'reject' && <><label>Update window (days)<input type="number" min="1" max="30" step="1" value={days} onChange={e => setDays(e.target.value)} required /></label><label className="du-checkbox"><input type="checkbox" checked={invalidate} onChange={e => setInvalidate(e.target.checked)}/> Invalidate the old document</label></>}{error && <p role="alert">{error}</p>}<div className="du-row"><button className="btn primary" disabled={busy}>{busy ? 'Saving…' : 'Confirm'}</button><button type="button" className="btn secondary" onClick={onClose} disabled={busy}>Cancel</button></div></form>;
}

export default function DocumentUpdates({ driverId = '', embedded = false, documents = [], driverDetail = null }) {
  const [tab, setTab] = useState('requests'); const [status, setStatus] = useState(''); const [kind, setKind] = useState(''); const [driver, setDriver] = useState(driverId); const [page, setPage] = useState(1); const [data, setData] = useState(null); const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [decision, setDecision] = useState(null); const [slot, setSlot] = useState(''); const [unlockKind, setUnlockKind] = useState('');
  const eligibleKinds = [...new Set(documents.filter(doc => String(doc.status || '').toLowerCase() === 'approved' && (!doc.update || doc.update.state === 'APPROVED_LOCKED')).map(doc => doc._kind === 'aadhaar' ? 'aadhaar' : doc.kind || doc.document_type).filter(kind => DOCUMENT_TYPES.includes(kind)))];
  if (driverDetail?.has_profile_photo && driverDetail?.verification_status === 'approved' && (!driverDetail.profile_photo_update || driverDetail.profile_photo_update.state === 'APPROVED_LOCKED') && !eligibleKinds.includes('profile_photo')) eligibleKinds.push('profile_photo');
  useEffect(() => { setDriver(driverId); setPage(1); }, [driverId]);
  const load = useCallback(async () => { setBusy(true); setError(''); try { const params = listParams({ page, kind, driver, status, tab }); const result = await api.get(tab === 'requests' ? '/api/v1/admin/document-update-requests' : '/api/v1/admin/document-replacements', { params }); setData(result.data); } catch (e) { setData(null); setError(formatError(e)); } finally { setBusy(false); } }, [page, kind, driver, status, tab]);
  useEffect(() => { load(); }, [load]);
  return <section className="panel du-panel" aria-label="Document updates"><h2>{embedded ? 'Document updates for this driver' : 'Document updates'}</h2><div className="du-row"><button className="btn secondary" onClick={() => { setTab('requests'); setPage(1); }} aria-pressed={tab === 'requests'}>Requests</button><button className="btn secondary" onClick={() => { setTab('replacements'); setPage(1); }} aria-pressed={tab === 'replacements'}>Replacement reviews</button><button className="btn secondary" onClick={load} disabled={busy}>Refresh</button></div><div className="du-filters">{tab === 'requests' && <label>Status<select value={status} onChange={e => { setStatus(e.target.value); setPage(1); }}><option value="">All</option>{REQUEST_STATUSES.map(x => <option key={x} value={x}>{label(x)}</option>)}</select></label>}<label>Document type<select value={kind} onChange={e => { setKind(e.target.value); setPage(1); }}><option value="">All</option>{DOCUMENT_TYPES.map(x => <option key={x} value={x}>{label(x)}</option>)}</select></label>{!embedded && <label>Driver ID<input value={driver} onChange={e => { setDriver(e.target.value); setPage(1); }} placeholder="Driver UUID" /></label>}</div>{embedded && <><div className="du-states"><h3>Document workflow status</h3>{documents.map((doc, index) => <p key={doc.id || index}>{label(doc._kind === 'aadhaar' ? 'aadhaar' : doc.kind || doc.document_type)}: {label(doc.update?.state || (doc.status === 'approved' ? 'APPROVED_LOCKED' : doc.status || 'unavailable'))}{doc.update?.old_document_valid === false ? ' · Old document is invalid' : ''}</p>)}{driverDetail?.has_profile_photo && <p>Profile photo: {label(driverDetail?.profile_photo_update?.state || 'status unavailable')}</p>}</div><div className="du-row"><label>Direct unlock document<select value={unlockKind} onChange={e => setUnlockKind(e.target.value)}><option value="">Select approved document</option>{eligibleKinds.map(x => <option key={x} value={x}>{label(x)}</option>)}</select></label><button className="btn secondary" disabled={!eligibleKinds.includes(unlockKind)} onClick={() => setDecision({ action: 'unlock' })}>Direct unlock</button></div>{decision?.action === 'unlock' && <Decision key={`unlock-${unlockKind}`} action="unlock" unlockDriver={driverId} unlockKind={unlockKind} onClose={() => setDecision(null)} onChanged={load}/>}</>}{data?.counts && <p>Requested: {data.counts.requested || 0}</p>}{error && <p role="alert">{error}</p>}{busy && <p role="status">Loading…</p>}{!busy && data?.items?.length === 0 && <p>No records found.</p>}{data?.items?.map(item => <article className="du-item" key={item.id || item.slot_id}><h3>{label(item.document_type)} · {label(tab === 'requests' ? item.status : item.update?.state)}</h3><p>Driver ID: {item.driver_id}</p>{tab === 'requests' ? <><p>Reason: {label(item.reason)}</p><p>Note: {item.note || '—'}</p><p>Requested: {workflowTime(item.requested_at)}</p><p>Decision reason: {item.decision_reason || '—'}</p><p>Unlock deadline: {workflowTime(item.unlock_expires_at)}</p>{item.status === 'requested' && <div className="du-row"><button className="btn primary" onClick={() => setDecision({ action: 'approve', request: item })}>Approve request</button><button className="btn secondary" onClick={() => setDecision({ action: 'reject', request: item })}>Reject request</button></div>}{decision?.request?.id === item.id && <Decision key={`${decision.action}-${item.id}`} action={decision.action} request={item} onClose={() => setDecision(null)} onChanged={load}/>} {item.slot_id && <button className="btn secondary" onClick={() => setSlot(item.slot_id)}>View versions</button>}</> : <><p>Uploaded: {workflowTime(item.uploaded_at)}</p><button className="btn primary" onClick={() => setSlot(item.slot_id)}>Review replacement</button></>}</article>)}{data && <div className="du-row"><button className="btn secondary" disabled={busy || page <= 1} onClick={() => setPage(page - 1)}>Previous</button><span>Page {page} · {data.total} total</span><button className="btn secondary" disabled={busy || page * 20 >= data.total} onClick={() => setPage(page + 1)}>Next</button></div>}{slot && <Replacement slotId={slot} onClose={() => setSlot('')} onChanged={load}/>}</section>;
}
