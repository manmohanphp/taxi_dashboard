import React, { useEffect, useRef, useState } from "react";
import { Users, Route, RefreshCw, ArrowLeft } from "lucide-react";
import { api, formatError } from "./api";
import { valueIsPresent, valueAtPath, findNestedValue, firstValue, recordsFrom, countFromPayload, hasMoreFromPayload, unwrappedRecord, formatCell, detailEntries, formatDateTime } from "./lib/parsing.js";
function isDriverAccount(row) {
  const role = row?.role ?? row?.user_type ?? row?.account_type ?? row?.role_name ?? row?.account_role ?? row?.user?.role ?? row?.profile?.role ?? row?.account?.role;
  if (typeof role === "string" && /driver/i.test(role)) return true;
  if (valueIsPresent(row?.driver_id)) return true;
  if (row?.driver_profile && typeof row.driver_profile === "object") return true;
  if (row?.driver && typeof row.driver === "object" && valueIsPresent(row.driver?.id ?? row.driver?.driver_id)) return true;
  return false;
}
function PanelTitle({ title, subtitle, icon: Icon }) {
  return <div className="panel-title"><span className="panel-title-icon"><Icon size={18}/></span><div><h2>{title}</h2><p>{subtitle}</p></div></div>;
}
function Feedback({ message, error = false }) {
  if (!message) return null;
  return <div className={`manual-feedback ${error ? "error" : "success"}`} role="status">{message}</div>;
}

function RefreshButton({ onClick, busy }) {
  return <button type="button" className="btn secondary" onClick={onClick} disabled={busy}><RefreshCw size={15} className={busy ? "spin" : ""}/>{busy ? "Loading…" : "Refresh"}</button>;
}
function Field({ label, children, hint }) {
  return <label className="manual-field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}
function SubmitButton({ children, busy }) {
  return <button type="submit" className="btn primary" disabled={busy}>{busy ? "Saving…" : children}</button>;
}
function DataTable({ rows, columns, selectedId, onSelect, idKeys = [] }) {
  return <div className="manual-table-wrap"><table className="manual-table"><thead><tr>{columns.map(c => <th key={c.label}>{c.label}</th>)}{onSelect && <th>Action</th>}</tr></thead><tbody>
    {rows.map((row, index) => {
      const id = idKeys.map(k => (row?.[k] ?? "")).join("|") || index;
      const selected = selectedId != null && String(selectedId) === String(idKeys.length ? row?.[idKeys[0]] : index);
      return <tr key={id} className={selected ? "selected" : ""}>
        {columns.map(c => <td key={c.label}>{c.value ? c.value(row, index) : "-"}</td>)}
        {onSelect && <td><button type="button" className="table-action" onClick={() => onSelect(row)}>View Details</button></td>}
      </tr>;
    })}
  </tbody></table></div>;
}
export default function CustomerManagement({ customerId = "", onOpenCustomer, onBackToCustomers }) {
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(20);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(null);
  const [hasMore, setHasMore] = useState(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const selectedId = customerId;
  const [detail, setDetail] = useState(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [actionError, setActionError] = useState(false);
  const [confirmAction, setConfirmAction] = useState(null);
  const [bookingPage, setBookingPage] = useState(1);
  const [bookings, setBookings] = useState([]);
  const [bookingsBusy, setBookingsBusy] = useState(false);
  const [bookingsError, setBookingsError] = useState("");
  const [bookingsTotal, setBookingsTotal] = useState(null);
  const [bookingsRevision, setBookingsRevision] = useState(0);
  const loadRequestRef = useRef(0);
  const abortRef = useRef(null);

  useEffect(() => { window.scrollTo(0, 0); }, [selectedId]);

  async function loadCustomers() {
    const requestId = ++loadRequestRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true); setError("");
    try {
      const response = await api.get("/api/v1/admin/customers", { params: { page, per_page: perPage, search: search || undefined }, signal: controller.signal });
      if (requestId !== loadRequestRef.current) return;
      const customerRows = recordsFrom(response.data).filter(row => !isDriverAccount(row));
      setRows(customerRows);
      setTotal(countFromPayload(response.data));
      setHasMore(hasMoreFromPayload(response.data));
    } catch (e) {
      if (controller.signal.aborted || requestId !== loadRequestRef.current) return;
      setRows([]);
      setTotal(null);
      setHasMore(null);
      setError(formatError(e));
    } finally {
      if (requestId === loadRequestRef.current) setBusy(false);
    }
  }

  useEffect(() => {
    if (!selectedId) loadCustomers();
    return () => abortRef.current?.abort();
  }, [page, perPage, search, selectedId]);


  useEffect(() => {
    if (!selectedId) { setDetail(null); setDetailError(""); setDetailBusy(false); setBookings([]); return undefined; }
    let cancelled = false;
    setDetail(null); setDetailError(""); setDetailBusy(true); setDisplayName("");
    api.get(`/api/v1/admin/customers/${encodeURIComponent(selectedId)}`)
      .then(response => {
        if (cancelled) return;
        const record = unwrappedRecord(response.data);
        setDetail(record);
        setDisplayName(String(firstValue(record, ["display_name", "name", "full_name"]) || ""));
      })
      .catch(e => { if (!cancelled) setDetailError(formatError(e)); })
      .finally(() => { if (!cancelled) setDetailBusy(false); });
    return () => { cancelled = true; };
  }, [selectedId]);
  useEffect(() => {
    if (!selectedId) return undefined;
    let cancelled = false;
    setBookingsBusy(true); setBookingsError("");
    api.get(`/api/v1/admin/customers/${encodeURIComponent(selectedId)}/bookings`, { params: { page: bookingPage, per_page: 20 } })
      .then(response => {
        if (cancelled) return;
        setBookings(recordsFrom(response.data));
        setBookingsTotal(countFromPayload(response.data));
      })
      .catch(e => { if (!cancelled) setBookingsError(formatError(e)); })
      .finally(() => { if (!cancelled) setBookingsBusy(false); });
    return () => { cancelled = true; };
  }, [selectedId, bookingPage, bookingsRevision]);

  function selectCustomer(row) {
    const id = firstValue(row, ["customer_id", "id", "user_id", "uuid", "customer_uuid", "user_uuid", "account_id"]);
    if (id == null || String(id).trim() === "") return;
    setBookingPage(1);
    setMessage(""); setActionError(false); setConfirmAction(null);
    onOpenCustomer?.(String(id));
  }

  async function updateCustomer(e) {
    e.preventDefault();
    if (!selectedId) return;
    setSaving(true); setMessage(""); setActionError(false);
    try {
      const updatedName = displayName.trim();
      await api.patch(`/api/v1/admin/customers/${encodeURIComponent(selectedId)}`, { display_name: updatedName });
      setDisplayName(updatedName);
      setDetail(current => current ? { ...current, display_name: updatedName } : current);
      setMessage("Customer updated.");
    } catch (err) { setMessage(formatError(err)); setActionError(true); }
    finally { setSaving(false); }
  }

  async function runConfirmedAction() {
    if (!selectedId || !confirmAction) return;
    setSaving(true); setMessage(""); setActionError(false);
    try {
      if (confirmAction === "block") await api.post(`/api/v1/admin/customers/${encodeURIComponent(selectedId)}/block`);
      else if (confirmAction === "unblock") await api.post(`/api/v1/admin/customers/${encodeURIComponent(selectedId)}/unblock`);
      setMessage(confirmAction === "block" ? "Customer blocked." : "Customer unblocked.");
      setConfirmAction(null);
      await loadCustomers();
      try {
        const response = await api.get(`/api/v1/admin/customers/${encodeURIComponent(selectedId)}`);
        setDetail(unwrappedRecord(response.data));
        setDisplayName(String(firstValue(unwrappedRecord(response.data), ["display_name", "name", "full_name"]) || ""));
      } catch {}
    } catch (err) { setMessage(formatError(err)); setActionError(true); }
    finally { setSaving(false); }
  }
  const totalRecords = total ?? rows.length;
  const hasNext = hasMore != null ? hasMore : (total != null ? page * perPage < total : rows.length >= perPage);
  const hasPrev = page > 1;

  if (selectedId) return <div className="manual-stack">
    <div className="manual-toolbar customer-detail-toolbar">
      <button type="button" className="btn secondary" onClick={() => onBackToCustomers?.()}><ArrowLeft size={15}/> Back to Customers</button>
    </div>
    <div className="panel">
      <PanelTitle title={String(firstValue(detail, ["display_name", "full_name", "name", "customer_name"]) || selectedId)} subtitle={`Customer ID: ${selectedId}`} icon={Users}/>
      {detailBusy ? <div className="loading-row">Loading customer details...</div> : detailError ? <Feedback message={detailError} error/> : detail ? <>
        <div className="driver-detail-block"><h3>Customer information</h3>
          <dl className="profile-grid driver-detail-grid">
            {detailEntries(detail).filter(([label]) => !/email|mail/i.test(label)).map(([label, value]) => <div className="profile-field" key={label}><dt>{label}</dt><dd>{formatCell(value)}</dd></div>)}
          </dl>
          {detailEntries(detail).filter(([label]) => !/email|mail/i.test(label)).length === 0 && <p className="muted small">The API returned this customer ID but no additional profile fields.</p>}
        </div>
        <form className="manual-form" onSubmit={updateCustomer}>
          <Field label="Display name" hint="Only the customer display name is editable by an administrator."><input value={displayName} onChange={e => setDisplayName(e.target.value)} minLength="1" maxLength="100" required/></Field>
          <Feedback message={message} error={actionError}/>
          <SubmitButton busy={saving}>Save customer</SubmitButton>
        </form>
        <div className="manual-form-actions">
          <span className="muted small">Status: {String(firstValue(detail, ["status", "account_status", "is_blocked", "blocked"]) ?? "-")}</span>
          <div className="queue-pagination">
            <button type="button" className="btn secondary" disabled={saving} onClick={() => setConfirmAction("block")}>Block</button>
            <button type="button" className="btn secondary" disabled={saving} onClick={() => setConfirmAction("unblock")}>Unblock</button>
          </div>
        </div>
        {confirmAction && <div className="notice warning-notice"><span>Confirm {confirmAction} for this customer?</span><div className="queue-pagination"><button type="button" className="btn primary" disabled={saving} onClick={runConfirmedAction}>{saving ? "Working..." : "Confirm"}</button><button type="button" className="btn secondary" disabled={saving} onClick={() => setConfirmAction(null)}>Cancel</button></div></div>}
      </> : null}
    </div>
    <div className="panel">
      <div className="manual-panel-head"><PanelTitle title="Customer bookings" subtitle="Booking history for this customer" icon={Route}/><RefreshButton onClick={() => setBookingsRevision(value => value + 1)} busy={bookingsBusy}/></div>
      <div className="manual-toolbar"><span className="muted small">{bookingsTotal ?? bookings.length} bookings</span><div className="queue-pagination"><button type="button" className="btn secondary" disabled={bookingsBusy || bookingPage <= 1} onClick={() => setBookingPage(p => Math.max(1, p - 1))}>Previous</button><button type="button" className="btn secondary" disabled={bookingsBusy || bookings.length < 20} onClick={() => setBookingPage(p => p + 1)}>Next</button></div></div>
      {bookingsError && <Feedback message={bookingsError} error/>}
      {bookingsBusy ? <div className="loading-row">Loading bookings...</div> : bookings.length ? <DataTable rows={bookings} columns={[
        { label: "Booking", value: row => firstValue(row, ["booking_id", "id"]) },
        { label: "Status", value: row => firstValue(row, ["status"]) },
        { label: "Pickup", value: row => firstValue(row, ["pickup_label", "pickup", "origin"]) },
        { label: "Drop-off", value: row => firstValue(row, ["dropoff_label", "dropoff", "destination"]) },
        { label: "Created", value: row => formatDateTime(firstValue(row, ["created_at", "pickup_at"])) },
      ]}/> : <p className="muted small">No bookings found for this customer.</p>}
    </div>
  </div>;

  return <div className="manual-stack">
    <div className="panel">
      <div className="manual-panel-head"><PanelTitle title="Customers" subtitle="Search, review, and manage customer accounts" icon={Users}/><RefreshButton onClick={loadCustomers} busy={busy}/></div>
      <div className="manual-toolbar">
        <Field label="Search customers"><input type="search" value={searchInput} onChange={e => setSearchInput(e.target.value)} placeholder="Name, phone..." onKeyDown={e => { if (e.key === "Enter") { setSearch(searchInput.trim()); setPage(1); } }}/></Field>
        <button type="button" className="btn secondary" onClick={() => { setSearch(searchInput.trim()); setPage(1); }}>Search</button>
        <span className="muted small">{total != null ? `${total} customers` : `${rows.length} on this page`}</span>
        <div className="queue-pagination">
          <button type="button" className="btn secondary" disabled={busy || !hasPrev} onClick={() => setPage(p => Math.max(1, p - 1))}>Previous</button>
          <button type="button" className="btn secondary" disabled={busy || !hasNext} onClick={() => setPage(p => p + 1)}>Next</button>
        </div>
      </div>
      {error && <Feedback message={error} error/>}
      {busy ? <div className="loading-row">Loading customers…</div> : rows.length ? <DataTable rows={rows} idKeys={["customer_id", "id", "user_id"]} selectedId={selectedId} onSelect={selectCustomer} columns={[
        { label: "S. No.", value: (_, index) => (page - 1) * perPage + index + 1 },
        { label: "Customer / ID", value: row => firstValue(row, ["display_name", "full_name", "name", "customer_name", "user_name"]) || String(firstValue(row, ["customer_id", "id", "user_id", "uuid", "customer_uuid", "user_uuid", "account_id"]) ?? "-") },
        { label: "Phone", value: row => firstValue(row, ["phone", "phone_number", "mobile", "mobile_number", "customer_phone", "user_phone", "contact_phone", "contact_number", "msisdn"]) || "-" },
        { label: "Status", value: row => firstValue(row, ["status", "account_status", "is_blocked", "blocked"]) ?? "-" },
        { label: "Created", value: row => formatDateTime(firstValue(row, ["created_at", "registered_at"])) },
      ]}/> : <p className="muted small">No customers found.</p>}
    </div>

  </div>;
}
