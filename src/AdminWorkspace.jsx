import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, ArrowLeft, CarFront, ChevronRight, CircleDollarSign, FileCheck2, FileText, MapPinned, MessageSquare, Phone, RefreshCw, Route, Search, ShieldCheck, Tag, Users, X } from "lucide-react";
import { API_BASE_URL, api, formatError } from "./api";
import "./communications.css";
import "./drivers.css";
import "./kyc.css";
import "./rides.css";
import CustomerManagement from "./CustomerManagement.jsx";
import DocumentUpdates from "./DocumentUpdates.jsx";
import { valueIsPresent, valueAtPath, findNestedValue, recordsFrom, countFromPayload, hasMoreFromPayload, formatDateTime, isSafeDocumentUrl } from "./lib/parsing.js";
import { driverDocumentActions, driverDocumentCollections, driverDocumentFileCount, driverDocumentFileEndpoint, driverDocumentPresentation, driverDocumentSubmissionDate, formatDriverDocumentFileCount, normalizeDriverDocumentStatus } from "./lib/driverDocuments.js";
import { documentBelongsToDriver, documentHasDriverAssociation, driverIdentityIds, driverKycCounts, driverKycDocuments, kycReviewEndpoint, kycReviewPayload, reviewConflictMessage, reviewRequestError, reviewSuccessMessage, vehicleBelongsToDriver, vehicleHasDriverAssociation, vehiclePricingReviewEndpoint, vehiclePricingReviewPayload, vehiclePricingStatus, vehiclePricingVersion } from "./lib/kycDocuments.js";
import { createConversationMessagePayload, settlementPolicyError } from "./lib/frontendValidation.js";

const pageInfo = {
  drivers: ["Drivers", "Review applications and update driver approval status."],
  kyc: ["Driver Verification", "Review identity submissions and driver documents."],
  rides: ["Rides & Bookings", "Review ride requests and update booking status."],
  communications: ["Callbacks & Messages", "Review callback requests and conversations."],
  pricing: ["Categories & Offers", "Configure vehicle categories and promotional coupons."],
  configuration: ["Areas & Routes", "Update service area and route settings."],
  customers: ["Customers", "Customer management depends on the admin APIs enabled by the backend."],
};
const DRIVER_APPROVAL_STATUS_FIELDS = [
  "application_status", "approval_status", "driver_status",
  "driver_approval_status", "verification_status"
];
const DRIVER_GENERIC_STATUS_PATHS = ["status", "current_status", "driver_state"];
const DRIVER_ACCOUNT_STATUS_FIELDS = ["account_status", "user.account_status", "account.status", "is_active", "active"];
const DRIVER_AVAILABILITY_FIELDS = ["is_online", "online", "availability", "driver_availability", "availability_status", "on_duty"];

function normalizedKey(value) { return String(value).toLowerCase().replace(/[^a-z0-9]/g, ""); }
function valueFor(row, keys) {
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
function findPhoneValue(record) {
  const matches = [];
  const ignored = /(verified|verification|status|last\d*|hash|otp|countrycode|updatedat|createdat|extension)/;
  function visit(value, path = [], depth = 0) {
    if (!value || typeof value !== "object" || depth > 5) return;
    if (Array.isArray(value)) { value.forEach((item, index) => visit(item, [...path, String(index)], depth + 1)); return; }
    for (const [name, child] of Object.entries(value)) {
      const key = normalizedKey(name);
      const nextPath = [...path, name];
      const valueInPhoneObject = /(^|\.)(phones?|mobile|contact)(\.|\[|$)/i.test(path.join(".")) && /^(number|value|e164|formatted|normalized)$/.test(key);
      if ((/(phone|mobile|msisdn|telephone)/.test(key) || valueInPhoneObject) && !ignored.test(key) && (typeof child === "string" || typeof child === "number") && String(child).trim()) {
        const updated = /^(updated|new)phone/.test(key) ? -2 : 0;
        const accountPath = /(^|\.)(user|profile|account|contact|driver)(\.|$)/i.test(nextPath.join(".")) ? -1 : 0;
        const canonical = /e164|phone(number)?$|mobile(number)?$/.test(key) ? -0.5 : 0;
        matches.push({ value: child, score: updated + accountPath + canonical + depth * 0.01 });
      }
      if (child && typeof child === "object") visit(child, nextPath, depth + 1);
    }
  }
  visit(record);
  matches.sort((left, right) => left.score - right.score);
  return matches[0]?.value;
}
function firstValue(row, keys) { return valueFor(row, keys) ?? "-"; }
function shortCommunicationId(value) {
  const id = value == null ? "" : String(value);
  return id.length > 16 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id || "—";
}
function recordId(row, keys = ["id", "driver_id", "booking_id", "submission_id", "document_id", "request_id", "conversation_id"]) {
  const value = valueFor(row, keys);
  return value == null ? "" : String(value);
}
function parseSnapshot(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
function locationText(value, depth = 0) {
  if (typeof value === "string") {
    const text = value.trim();
    return text && !["-", "—", "n/a", "na", "null", "none"].includes(text.toLowerCase()) ? text : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) {
    return value.length >= 2 && value.slice(0, 2).every(coordinate => Number.isFinite(Number(coordinate)))
      ? `${value[0]}, ${value[1]}`
      : undefined;
  }
  if (!value || typeof value !== "object" || depth > 3) return undefined;
  const label = valueFor(value, ["label", "address", "formatted_address", "formattedAddress", "place_name", "placeName", "location_name", "locationName", "name", "city", "description", "text", "value"]);
  if (valueIsPresent(label) && label !== value) {
    const text = locationText(label, depth + 1);
    if (text) return text;
  }
  const latitude = valueFor(value, ["latitude", "lat"]);
  const longitude = valueFor(value, ["longitude", "lng", "lon"]);
  if (latitude != null && longitude != null) return `${latitude}, ${longitude}`;
  const coordinates = valueFor(value, ["coordinates", "coords"]);
  if (Array.isArray(coordinates) && coordinates.length >= 2) return `${coordinates[0]}, ${coordinates[1]}`;
  return undefined;
}
function bookingLocation(booking, side) {
  const isPickup = side === "pickup";
  const fields = isPickup
    ? ["pickup", "pickup_location", "pickup_location_snapshot", "pickup_point", "pickup_details", "pickup_address", "pickup_label", "origin", "origin_location", "origin_address", "origin_name", "from", "start_location"]
    : ["dropoff", "drop_off", "dropoff_location", "drop_off_location", "dropoff_location_snapshot", "dropoff_point", "dropoff_details", "dropoff_address", "drop_off_address", "dropoff_label", "destination", "destination_location", "destination_address", "destination_name", "to", "end_location"];
  const snapshots = [
    parseSnapshot(valueFor(booking, ["itinerary_snapshot", "itinerary", "route_snapshot", "trip_snapshot"])),
    parseSnapshot(valueFor(booking, ["trip_details", "route_details", "fare_snapshot"])),
    parseSnapshot(valueFor(booking, ["booking_snapshot"])),
    booking,
  ];
  for (const source of snapshots) {
    for (const field of fields) {
      const text = locationText(valueFor(source, [field]));
      if (text) return text;
    }
    const latitude = valueFor(source, isPickup ? ["pickup_latitude", "pickup_lat", "origin_latitude", "origin_lat"] : ["dropoff_latitude", "dropoff_lat", "destination_latitude", "destination_lat"]);
    const longitude = valueFor(source, isPickup ? ["pickup_longitude", "pickup_lng", "origin_longitude", "origin_lng"] : ["dropoff_longitude", "dropoff_lng", "destination_longitude", "destination_lng"]);
    if (latitude != null && longitude != null) return `${latitude}, ${longitude}`;
  }
  return undefined;
}
function formatPaiseAmount(value, currency = "INR") {
  const amount = Number(value);
  return Number.isFinite(amount) ? `${currency} ${(amount / 100).toFixed(2)}` : "-";
}
function driverLabel(row) {
  const name = valueFor(row, ["display_name", "full_name", "name", "driver_name", "driver_profile.display_name", "profile.display_name", "user.full_name", "user.name"]);
  if (valueIsPresent(name)) return name;
  const parts = [valueFor(row, ["first_name", "given_name"]), valueFor(row, ["last_name", "family_name"])].filter(valueIsPresent);
  return parts.join(" ") || recordId(row, ["driver_id", "id", "user_id", "driver.id", "user.id"]) || "-";
}
function displayDriverName(value) {
  return String(value ?? "").trim().toLowerCase().replace(/(^|[\s'-])([\p{L}\p{N}])/gu, (_, separator, character) => `${separator}${character.toUpperCase()}`);
}
function driverSearchName(row) {
  const name = valueFor(row, ["display_name", "full_name", "name", "driver_name", "driver_profile.display_name", "profile.display_name", "user.full_name", "user.name"]);
  if (valueIsPresent(name)) return String(name);
  return [valueFor(row, ["first_name", "given_name"]), valueFor(row, ["last_name", "family_name"])].filter(valueIsPresent).join(" ");
}
function linkedDriverLabel(row, detail) {
  const nameFields = ["driver_name", "display_name", "full_name", "name", "driver_profile.display_name", "profile.display_name", "user.full_name", "user.name", "driver.full_name", "driver.name", "applicant.full_name", "applicant.name"];
  const name = valueFor(detail, nameFields) ?? valueFor(row, nameFields);
  if (valueIsPresent(name)) return name;
  const idFields = ["driver_id", "driver_user_id", "user_id", "owner_id", "owner_user_id", "subject_user_id", "account_id", "applicant_id", "driver.id", "user.id", "applicant.id"];
  return valueFor(detail, idFields) ?? valueFor(row, idFields) ?? "-";
}
function profileUserId(profile) {
  if (!profile) return "";
  const value = valueFor(profile, ["id", "user_id", "account_id", "sub", "uuid", "user.id", "account.id", "profile.id"]);
  return value == null ? "" : String(value);
}
const adminUserId = profileUserId;
function documentOwnerId(record, detail) {
  const fields = ["user_id", "driver_user_id", "owner_id", "owner_user_id", "subject_user_id", "account_id", "applicant_id", "driver.id", "user.id", "applicant.id", "driver.user_id", "profile.id"];
  const value = valueFor(detail, fields) ?? valueFor(record, fields);
  return value == null ? "" : String(value);
}
function currentReviewStatus(record, detail) {
  const value = valueFor(detail, ["status", "review_status", "decision", "review_decision"]) ?? valueFor(record, ["status", "review_status", "decision", "review_decision"]);
  return value == null ? "-" : String(value);
}
function currentReviewNote(record, detail) {
  const value = valueFor(detail, ["review_note", "note", "rejection_reason", "reason", "review_comment", "comment", "review_notes"]) ?? valueFor(record, ["review_note", "note", "rejection_reason", "reason", "review_comment", "comment", "review_notes"]);
  return value == null ? "" : String(value);
}
function driverPhone(row, detail) {
  const fields = [
    "driver_profile.phone_number", "profile.phone_number", "user.phone_number", "account.phone_number", "contact.phone_number",
    "driver_profile.phone", "profile.phone", "user.phone", "account.phone", "contact.phone",
    "updated_phone_number", "new_phone_number", "phone_number_e164", "phone_e164", "mobile_e164", "phone_number", "driver_phone", "user_phone", "contact_phone", "mobile_phone", "mobile_number", "mobile_no", "msisdn", "contact_number", "primary_contact_number", "primary_phone_number", "primary_phone", "phone", "mobile", "telephone",
  ];
  return findPhoneValue(detail) ?? valueFor(detail, fields) ?? findPhoneValue(row) ?? valueFor(row, fields) ?? "-";
}
function driverServiceAreas(row) {
  const areas = valueFor(row, ["service_areas"]) || valueFor(row, ["requirements", "service_areas"]) || [];
  const codes = valueFor(row, ["service_area_codes"]) || [];
  if (Array.isArray(areas) && areas.length) {
    const names = areas
      .map(area => {
        if (typeof area === "string") return area;
        if (area && typeof area === "object") return area.name || area.city_code || area.code || "-";
        return String(area);
      })
      .filter(Boolean);
    if (names.length) return names.join(", ");
  }
  if (Array.isArray(codes) && codes.length) return codes.join(", ");
  return "-";
}
function driverVehicle(row) {
  const vehicles = (Array.isArray(row?.requirements?.vehicles) ? row.requirements.vehicles : [])
    .concat(Array.isArray(row?.vehicles) ? row.vehicles : [])
    .filter(Boolean);
  if (!vehicles.length) return "-";
  const vehicle = vehicles[0];
  const label = valueFor(vehicle, ["make_model", "model", "category"]) || "Vehicle";
  const registration = valueFor(vehicle, ["registration_number", "vehicle_number"]);
  return registration ? `${label} (${registration})` : label;
}
function formatCell(value) {
  if (value == null || value === "") return "-";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
function directValue(row, paths) {
  for (const path of paths) {
    const value = valueAtPath(row, path);
    if (valueIsPresent(value)) return value;
  }
  return undefined;
}
function personName(record, prefixes = [], standaloneNameKeys = []) {
  const pathsFor = keys => [...prefixes.flatMap(prefix => keys.map(key => `${prefix}.${key}`)), ...standaloneNameKeys];
  const name = directValue(record, pathsFor(["display_name", "full_name", "fullName", "name"]));
  if (typeof name === "string" || typeof name === "number") return String(name);
  const first = directValue(record, pathsFor(["first_name", "firstName", "given_name"]));
  const last = directValue(record, pathsFor(["last_name", "lastName", "family_name"]));
  const combined = [first, last].filter(valueIsPresent).map(String).join(" ").trim();
  return combined || null;
}
function unwrappedRecord(data) {
  const payload = data?.data ?? data;
  if (payload && !Array.isArray(payload) && typeof payload === "object") {
    for (const key of ["driver", "customer", "user", "rider", "profile", "record", "submission", "aadhaar", "booking"]) {
      if (payload[key] && typeof payload[key] === "object") return { ...payload, ...payload[key] };
    }
  }
  return payload;
}
function detailEntries(record) {
  const entries = [];
  const hidden = /(token|password|secret|authorization|url|file|image|blob|base64|content|bytes)/i;
  const requirementField = /(requirement|issue)/i;
  function visit(value, prefix = "", depth = 0) {
    if (!value || typeof value !== "object" || depth > 3 || entries.length >= 24) return;
    for (const [key, child] of Object.entries(value)) {
      if (hidden.test(key) || requirementField.test(key)) continue;
      const label = prefix ? `${prefix} / ${key.replace(/_/g, " ")}` : key.replace(/_/g, " ");
      if (child && typeof child === "object" && !Array.isArray(child)) visit(child, label, depth + 1);
      else if (Array.isArray(child)) {
        const values = child.filter(valueIsPresent);
        if (values.length && values.every(item => typeof item !== "object")) entries.push([label, values.join(", ")]);
      } else if (valueIsPresent(child)) entries.push([label, child]);
      if (entries.length >= 24) break;
    }
  }
  visit(record);
  return entries;
}
function cleanIssueText(raw) {
  let text = raw;
  if (raw == null) return "";
  if (typeof raw === "object") {
    text = raw.message || raw.description || raw.name || raw.code || raw.label || raw.title;
    if (text == null) {
      text = "";
    }
  } else {
    text = String(raw).trim();
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object") {
        if (Array.isArray(parsed.issues)) return parsed.issues.map(cleanIssueText).filter(Boolean).join("\n");
        text = parsed.message || parsed.description || parsed.name || parsed.code || parsed.label || parsed.title;
        if (text == null) text = "";
      }
    } catch {}
  }
  text = String(text ?? "").trim();
  text = text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, "");
  text = text.replace(/\b[0-9a-f]{16,}\b/gi, "");
  if (/[\\/]/.test(text)) text = text.split(/[\\/]/).pop();
  text = text.trim().replace(/^[-:,\s]+/, "").replace(/\s+/g, " ");
  text = text.replace(/(^|:\s*)([a-z])/g, (match, prefix, char) => prefix + char.toUpperCase());
  return text;
}

function hasRequirementData(record) {
  if (!record || typeof record !== "object") return false;
  let found = false;
  const requirementField = /(requirement|issue)/i;
  function visit(value, depth = 0) {
    if (!value || typeof value !== "object" || depth > 3 || found) return;
    for (const [key, child] of Object.entries(value)) {
      if (requirementField.test(key)) { found = true; return; }
      if (child && typeof child === "object") visit(child, depth + 1);
    }
  }
  visit(record);
  return found;
}
function requirementIssues(record) {
  const collected = [];
  const seen = new Set();
  const requirementField = /(requirement|issue)/i;

  function collect(value, depth = 0) {
    if (value == null || depth > 4) return;
    if (Array.isArray(value)) {
      value.forEach(item => collect(item, depth + 1));
      return;
    }
    if (typeof value === "string") {
      try {
        const parsed = JSON.parse(value);
        if (parsed && typeof parsed === "object") {
          collect(parsed, depth);
          return;
        }
      } catch {}
      const cleaned = cleanIssueText(value);
      if (cleaned) {
        cleaned.split("\n").forEach(part => {
          const item = part.trim();
          if (item && !seen.has(item.toLowerCase())) {
            seen.add(item.toLowerCase());
            collected.push(item);
          }
        });
      }
      return;
    }
    if (typeof value === "object") {
      if (Array.isArray(value.issues)) {
        value.issues.forEach(item => collect(item, depth + 1));
        return;
      }
      if (Array.isArray(value.requirements)) {
        value.requirements.forEach(item => collect(item, depth + 1));
        return;
      }
      const cleaned = cleanIssueText(value);
      if (cleaned) {
        cleaned.split("\n").forEach(part => {
          const item = part.trim();
          if (item && !seen.has(item.toLowerCase())) {
            seen.add(item.toLowerCase());
            collected.push(item);
          }
        });
      }
    }
  }

  function visit(value, depth = 0) {
    if (!value || typeof value !== "object" || depth > 3) return;
    for (const [key, child] of Object.entries(value)) {
      if (requirementField.test(key)) collect(child, 0);
      else if (child && typeof child === "object") visit(child, depth + 1);
    }
  }

  visit(record);
  return collected.filter(item => !/^(-|none|null|n\/a|na|all requirements met\.?|no outstanding requirements\.?)$/i.test(item));
}
function searchRecord(record) {
  const values = [];
  function visit(value, depth = 0) {
    if (value == null || depth > 4 || values.length > 100) return;
    if (Array.isArray(value)) { value.forEach(item => visit(item, depth + 1)); return; }
    if (typeof value === "object") {
      for (const [key, child] of Object.entries(value)) { values.push(key); visit(child, depth + 1); }
      return;
    }
    values.push(String(value));
  }
  visit(record);
  return values.join(" ").toLowerCase();
}
function readableApiError(error) {
  return formatError(error);
}
function errorText(error) {
  const payload = error?.response?.data?.error || error?.response?.data;
  const parts = [];
  if (payload?.message) parts.push(String(payload.message));
  if (typeof payload?.detail === "string") parts.push(payload.detail);
  else if (Array.isArray(payload?.detail)) parts.push(payload.detail.map(item => (typeof item === "string" ? item : item?.msg || item?.message || JSON.stringify(item))).join(" "));
  else if (payload?.detail && typeof payload.detail === "object") parts.push(JSON.stringify(payload.detail));
  if (Array.isArray(payload?.issues)) parts.push(payload.issues.map(item => (typeof item === "string" ? item : item?.message || JSON.stringify(item))).join(" "));
  if (Array.isArray(payload?.details)) parts.push(payload.details.map(item => (typeof item === "string" ? item : item?.message || JSON.stringify(item))).join(" "));
  return parts.join(" ");
}
function needsDocumentReview(error) {
  const text = errorText(error).toLowerCase();
  return error?.response?.status === 409 && /(document|permit|aadhaar)/.test(text);
}
function documentRequirement(error) {
  if (!needsDocumentReview(error)) return null;
  const text = errorText(error);
  const match = text.match(/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\s*\/\s*([a-z0-9_-]+)/i);
  return match ? { driverId: match[1], documentKind: match[2] } : null;
}

function PageHeading({ title, description }) {
  return <div className="page-intro"><div><div className="eyebrow">TAXIGO OPERATIONS</div><h1>{title}</h1><p>{description}</p></div><span className="page-icon"><Activity size={22}/></span></div>;
}
function PanelTitle({ title, subtitle, icon: Icon }) {
  return <div className="panel-title"><span className="panel-title-icon"><Icon size={18}/></span><div><h2>{title}</h2><p>{subtitle}</p></div></div>;
}
function Feedback({ message, error = false }) {
  if (!message) return null;
  return <div className={`manual-feedback ${error ? "error" : "success"}`} role="status">{message}</div>;
}
function DataTable({ rows, columns, onSelect, onDetails, onRowSelect, selectedId, idKeys, getRowId, renderAction, actionDisabled, detailDisabled, empty = "No records found.", page = 1, perPage = 50 }) {
  if (!rows.length) return <div className="empty-state">{empty}</div>;
  return <div className="manual-table-wrap"><table className="manual-table"><thead><tr>{columns.map(column => <th key={column.label}>{column.label}</th>)}{(onSelect || renderAction) && <th>Action</th>}{onDetails && <th>Details</th>}</tr></thead><tbody>
    {rows.map((row, index) => {
      const recordKey = getRowId ? String(getRowId(row) ?? "") : recordId(row, idKeys);
      const id = recordKey || String(index);
      const serial = (page - 1) * perPage + index + 1;
      return <tr className={`${selectedId === id ? "selected" : ""}${onRowSelect ? " clickable-row" : ""}`} key={id} tabIndex={onRowSelect ? 0 : undefined} onClick={onRowSelect ? () => onRowSelect(row) : undefined} onKeyDown={onRowSelect ? event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onRowSelect(row); } } : undefined}>{columns.map(column => { const content = column.render ? column.render(row, index, page, perPage, serial) : formatCell(column.value(row, index, page, perPage, serial)); return <td key={column.label}>{content}</td>; })}{(onSelect || renderAction) && <td>{renderAction ? renderAction(row) : <button type="button" className="table-action" disabled={actionDisabled?.(row)} onClick={event => { event.stopPropagation(); onSelect(row); }}>{selectedId === id ? "Selected" : "Manage"}</button>}</td>}{onDetails && <td><button type="button" className="table-action" disabled={detailDisabled?.(row)} onClick={event => { event.stopPropagation(); onDetails(row); }}>View Details</button></td>}</tr>;
    })}
  </tbody></table></div>;
}
function useList(path, params = {}) {
  const [rows, setRows] = useState([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [total, setTotal] = useState(null);
  const [hasMore, setHasMore] = useState(null);
  const requestIdRef = useRef(0);
  const abortRef = useRef(null);
  const reload = async () => {
    const requestId = ++requestIdRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true); setError("");
    try {
      const response = await api.get(path, { params, signal: controller.signal });
      if (requestId !== requestIdRef.current) return;
      setRows(recordsFrom(response.data));
      setTotal(countFromPayload(response.data));
      setHasMore(hasMoreFromPayload(response.data));
    } catch (e) {
      if (controller.signal.aborted || requestId !== requestIdRef.current) return;
      setRows([]);
      setTotal(null);
      setHasMore(null);
      setError(formatError(e));
    } finally {
      if (requestId === requestIdRef.current) setBusy(false);
    }
  };
  useEffect(() => { reload(); return () => abortRef.current?.abort(); }, [path, JSON.stringify(params)]);
  return { rows, busy, error, reload, total, hasMore };
}
function RefreshButton({ onClick, busy }) {
  return <button type="button" className="btn secondary" onClick={onClick} disabled={busy}><RefreshCw size={15} className={busy ? "spin" : ""}/>{busy ? "Loading…" : "Refresh"}</button>;
}
function Field({ label, children, hint }) {
  return <label className="manual-field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}
function SubmitButton({ children, busy, disabled = false }) {
  return <button type="submit" className="btn primary" disabled={busy || disabled}>{busy ? "Saving…" : children}</button>;
}

function DriversPage({ onOpenDriver }) {
  const [filter, setFilter] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [page, setPage] = useState(1);
  const driverListParams = { ...(filter === "all" ? {} : { status: filter }), page, per_page: 50 };
  const { rows, busy, error, reload, total, hasMore } = useList("/api/v1/admin/drivers", driverListParams);
  const [driverDetails, setDriverDetails] = useState({});
  const [driverDetailStatus, setDriverDetailStatus] = useState({});
  async function refreshDrivers() {
    setDriverDetails({});
    setDriverDetailStatus({});
    await reload();
  }
  useEffect(() => {
    const pending = rows.filter(row => {
      const id = recordId(row, ["driver_id", "id", "user_id", "driver.id", "user.id"]);
      return id && !driverDetails[id];
    });
    if (!pending.length) return undefined;
    let cancelled = false;
    let next = 0;
    setDriverDetailStatus(current => ({ ...current, ...Object.fromEntries(pending.map(row => [recordId(row, ["driver_id", "id", "user_id", "driver.id", "user.id"]), "loading"])) }));
    async function loadNext() {
      while (next < pending.length && !cancelled) {
        const row = pending[next++];
        const id = recordId(row, ["driver_id", "id", "user_id", "driver.id", "user.id"]);
        try {
          const response = await api.get(`/api/v1/admin/drivers/${encodeURIComponent(id)}`);
          if (!cancelled) {
            setDriverDetails(current => ({ ...current, [id]: unwrappedRecord(response.data) }));
            setDriverDetailStatus(current => ({ ...current, [id]: "ready" }));
          }
        } catch {
          if (!cancelled) setDriverDetailStatus(current => ({ ...current, [id]: "error" }));
        }
      }
    }
    Promise.all(Array.from({ length: Math.min(4, pending.length) }, () => loadNext()));
    return () => { cancelled = true; };
  }, [rows]);
  function phoneCell(row) {
    const id = recordId(row, ["driver_id", "id", "user_id", "driver.id", "user.id"]);
    if (driverDetailStatus[id] === "loading") return "Loading...";
    if (driverDetailStatus[id] === "error") return "Unavailable";
    const phone = driverPhone(row, driverDetails[id]);
    if (phone !== "-") return phone;
    return "Not returned by API";
  }
  const filteredRows = rows.filter(driver => {
    const term = searchQuery.trim().toLowerCase();
    if (!term) return true;
    const detail = driverDetails[recordId(driver, ["driver_id", "id", "user_id", "driver.id", "user.id"])];
    const name = `${driverSearchName(driver)} ${driverSearchName(detail)}`.toLowerCase();
    const phone = String(driverPhone(driver, detail) || "").toLowerCase();
    return name.includes(term) || phone.includes(term);
  });
  const hasSearchQuery = Boolean(searchQuery.trim());
  const displayedDriverCount = hasSearchQuery ? filteredRows.length : (total ?? rows.length);
  const phoneMissingForAll = filteredRows.length > 0 && filteredRows.every(row => {
    const id = recordId(row, ["driver_id", "id", "user_id", "driver.id", "user.id"]);
    return driverDetailStatus[id] === "ready" && driverPhone(row, driverDetails[id]) === "-";
  });
  const statusCounts = rows.reduce((counts, driver) => {
    const id = recordId(driver, ["driver_id", "id", "user_id", "driver.id", "user.id"]);
    const status = driverStatusPresentation(driver, driverDetails[id]);
    if (status?.category && Object.hasOwn(counts, status.category)) counts[status.category] += 1;
    else counts.other += 1;
    return counts;
  }, { pending: 0, approved: 0, rejected: 0, suspended: 0, other: 0 });
  const canGoNext = hasMore != null ? hasMore : (total != null ? page * 50 < total : rows.length >= 50);
  const openDriver = row => {
    const id = recordId(row, ["driver_id", "id", "user_id", "driver.id", "user.id"]);
    if (id) onOpenDriver?.(id);
  };
  const statusClass = status => {
    if (status?.category === "approved") return "approved";
    if (status?.category === "pending") return "pending";
    if (status?.category === "rejected" || status?.category === "suspended") return "attention";
    return "neutral";
  };
  const statCards = [
    { label: "Total drivers", value: total ?? rows.length, note: "Matching this status filter", icon: Users, tone: "blue" },
    { label: "Pending review", value: statusCounts.pending, note: "In the loaded page", icon: FileCheck2, tone: "amber" },
    { label: "Approved", value: statusCounts.approved, note: "In the loaded page", icon: ShieldCheck, tone: "green" },
    { label: "Needs attention", value: statusCounts.rejected + statusCounts.suspended, note: "Rejected or suspended", icon: Activity, tone: "violet" },
  ];
  return <div className="drivers-page manual-stack">
    <section className="drivers-overview" aria-label="Driver application overview">
      {statCards.map(({ label, value, note, icon: Icon, tone }) => <article className="drivers-stat-card" key={label}>
        <span className={`drivers-stat-icon ${tone}`}><Icon size={17}/></span>
        <div className="drivers-stat-copy"><span>{label}</span><strong>{value}</strong><small>{note}</small></div>
      </article>)}
    </section>
    <section className="panel drivers-panel">
      <div className="manual-panel-head drivers-panel-head">
        <PanelTitle title="Driver applications" subtitle="Review applications and manage driver approval status" icon={CarFront}/>
        <RefreshButton onClick={refreshDrivers} busy={busy}/>
      </div>
      <div className="drivers-toolbar">
        <div className="drivers-filters">
          <Field label="Driver status"><select value={filter} onChange={e => { setFilter(e.target.value); setPage(1); }}><option value="all">All statuses</option><option value="pending">Pending</option><option value="approved">Approved</option><option value="rejected">Rejected</option><option value="suspended">Suspended</option></select></Field>
          <label className="manual-field drivers-search"><span>Find a driver</span><input type="search" value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder="Search by name or phone" aria-label="Search by driver name or phone"/></label>
        </div>
        <div className="drivers-result-count"><strong>{displayedDriverCount}</strong><span>{hasSearchQuery ? "matching drivers" : "drivers"}</span></div>
      </div>
      {phoneMissingForAll && <div className="notice warning-notice"><ShieldCheck size={18}/><div><b>Driver phone numbers are missing from the connected API</b><p>The driver detail response omits each phone number, and this API does not provide an admin phone update route. The backend must return the phone field before this dashboard can display or edit it.</p></div></div>}
      {error && <Feedback message={error} error/>}
      {busy ? <div className="loading-row drivers-loading"><RefreshCw size={16} className="spin"/>Loading driver applications...</div> : filteredRows.length === 0 ? <div className="drivers-empty"><span><CarFront size={20}/></span><b>{searchQuery.trim() ? "No drivers match your search" : "No driver applications found"}</b><p>{searchQuery.trim() ? "Try another name or phone number." : "Driver applications will appear here when available."}</p></div> : <div className="drivers-table-wrap"><table className="drivers-table">
        <thead><tr><th className="drivers-number-col">#</th><th>Driver</th><th>Phone</th><th>Driver status</th><th>Last updated</th><th className="drivers-action-col">Action</th></tr></thead>
        <tbody>{filteredRows.map((row, index) => {
          const id = recordId(row, ["driver_id", "id", "user_id", "driver.id", "user.id"]);
          const status = driverStatusPresentation(row, driverDetails[id]);
          const name = driverLabel(row);
          return <tr key={id || index}>
            <td className="drivers-row-number">{(page - 1) * 50 + index + 1}</td>
            <td><div className="drivers-identity"><span className="drivers-avatar">{String(name).trim().slice(0, 1).toUpperCase() || "D"}</span><span><strong>{displayDriverName(name)}</strong><small>{id || "Driver ID unavailable"}</small></span></div></td>
            <td className="drivers-phone">{phoneCell(row)}</td>
            <td><span className={`drivers-status ${statusClass(status)}`}><i/>{status?.label || "Not returned by API"}</span></td>
            <td className="drivers-updated">{formatDateTime(firstValue(row, ["updated_at", "modified_at", "created_at"]))}</td>
            <td><button type="button" className="drivers-manage" disabled={!id} onClick={() => openDriver(row)}>Manage<ChevronRight size={14}/></button></td>
          </tr>;
        })}</tbody>
      </table></div>}
      <div className="drivers-pagination">
        <span>Page {page}{total != null ? ` (${total} total)` : ""}</span>
        <div className="queue-pagination"><button className="btn secondary" type="button" disabled={busy || page <= 1} onClick={() => setPage(current => Math.max(1, current - 1))}>Previous</button><button className="btn secondary" type="button" disabled={busy || !canGoNext} onClick={() => setPage(current => current + 1)}>Next</button></div>
      </div>
    </section>
  </div>;
}
function driverPhotoUrl(record) {
  let photo = valueFor(record, ["profile_photo_url", "profile_image_url", "profile_picture_url", "photo_url", "picture_url", "avatar_url", "avatar", "profile_picture", "profile_image", "profile_photo", "photo", "image"]);
  if (photo && typeof photo === "object") photo = valueFor(photo, ["url", "file_url", "image_url", "download_url"]);
  if (typeof photo !== "string" || !photo.trim()) return "";
  try {
    const url = new URL(photo.trim(), API_BASE_URL);
    return isSafeDocumentUrl(url.href) ? url.href : "";
  } catch { return ""; }
}

function statusLabel(value, field) {
  if (!valueIsPresent(value)) return null;
  if (typeof value === "boolean") {
    const isActiveField = /active|account/i.test(field);
    return { label: isActiveField ? (value ? "Active" : "Inactive") : (value ? "Online" : "Offline"), category: value && isActiveField ? "approved" : null };
  }

  const raw = String(value).trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    if (/online|availability|on_duty/i.test(field)) {
      const isOnline = Number(raw) === 1;
      return { label: isOnline ? "Online" : "Offline", category: null };
    }
    if (/active|account/i.test(field)) {
      const isActive = Number(raw) === 1;
      return { label: isActive ? "Active" : "Inactive", category: isActive ? "approved" : null };
    }
    const numericStatuses = { 0: "pending", 1: "approved", 2: "rejected", 3: "suspended" };
    const label = numericStatuses[Number(raw)];
    return label ? { label: label[0].toUpperCase() + label.slice(1), category: label } : { label: `Unknown (${raw})`, category: null };
  }

  const normalized = raw.toLowerCase().replace(/[\s-]+/g, "_");
  if (["pending", "submitted", "in_review", "under_review", "awaiting_review", "awaiting_approval"].includes(normalized)) return { label: "Pending", category: "pending" };
  if (["approved", "active", "verified", "enabled"].includes(normalized)) return { label: normalized === "active" ? "Active" : "Approved", category: "approved" };
  if (["rejected", "declined", "denied"].includes(normalized)) return { label: "Rejected", category: "rejected" };
  if (["suspended", "blocked", "disabled"].includes(normalized)) return { label: "Suspended", category: "suspended" };
  const label = normalized.split("_").filter(Boolean).map(part => part[0].toUpperCase() + part.slice(1)).join(" ");
  return label ? { label, category: null } : null;
}
function driverStatusPresentation(record, detail) {
  const sources = [detail, record].filter(Boolean);
  for (const field of DRIVER_APPROVAL_STATUS_FIELDS) {
    for (const source of sources) {
      const status = statusLabel(valueFor(source, [field]), field);
      if (status) return status;
    }
  }
  for (const field of DRIVER_GENERIC_STATUS_PATHS) {
    for (const source of sources) {
      const status = statusLabel(valueAtPath(source, field), field);
      if (status) return status;
    }
  }
  for (const field of DRIVER_ACCOUNT_STATUS_FIELDS) {
    for (const source of sources) {
      const status = statusLabel(valueFor(source, [field]), field);
      if (status) return status;
    }
  }
  for (const field of DRIVER_AVAILABILITY_FIELDS) {
    for (const source of sources) {
      const status = statusLabel(valueFor(source, [field]), field);
      if (status) return status;
    }
  }
  return null;
}
function driverStatus(record, fields) {
  for (const field of fields) {
    const status = statusLabel(valueFor(record, [field]), field);
    if (status) return status.label;
  }
  return "Not returned by API";
}

function verificationStatusFromRequirements(record, driverRecord = record) {
  let submissions = record;
  if (!Array.isArray(submissions)) {
    const { documents, aadhaar } = driverDocumentCollections(record);
    submissions = [...documents, ...aadhaar];
  }

  const vehicleIds = driverIdentityIds(driverRecord);
  const vehicles = (Array.isArray(driverRecord?.requirements?.vehicles) ? driverRecord.requirements.vehicles : [])
    .filter(vehicle => !vehicleHasDriverAssociation(vehicle) || vehicleBelongsToDriver(vehicle, vehicleIds));
  const documentsApproved = submissions.length > 0
    && submissions.every(document => normalizeDriverDocumentStatus(document) === "approved");
  const vehicleRatesApproved = vehicles.length > 0
    && vehicles.every(vehicle => vehiclePricingStatus(vehicle) === "approved");

  return documentsApproved && vehicleRatesApproved ? "approved" : "pending";
}

function vehiclePerKilometreRate(vehicle) {
  const paiseFields = [
    "approved_rate_paise_per_km", "agreed_rate_paise_per_km", "vehicle_rate_paise_per_km",
    "pricing_rate_paise_per_km", "rate_paise_per_km", "per_km_rate_paise", "per_kilometre_rate_paise",
    "per_kilometer_rate_paise", "price_paise_per_km", "fare_paise_per_km", "per_km_paise", "rate_paise",
    "rate_amount_paise", "pricing.approved_rate_paise_per_km", "pricing.rate_paise_per_km",
    "vehicle_pricing.approved_rate_paise_per_km", "vehicle_pricing.rate_paise_per_km", "rate_details.rate_paise_per_km",
  ];
  for (const field of paiseFields) {
    const value = valueFor(vehicle, [field]);
    if (valueIsPresent(value) && Number.isFinite(Number(value))) return { amount: Number(value), unit: "paise" };
  }

  const rupeeFields = [
    "approved_rate_per_km", "agreed_rate_per_km", "rate_per_km", "per_km_rate", "per_kilometre_rate",
    "per_kilometer_rate", "price_per_km", "price_per_kilometer", "fare_per_km", "charge_per_km",
    "amount_per_km", "tariff_per_km", "base_rate_per_km", "pricing.per_km_rate", "pricing.price_per_km",
    "vehicle_pricing.per_km_rate", "vehicle_pricing.price_per_km",
  ];
  for (const field of rupeeFields) {
    const value = valueFor(vehicle, [field]);
    if (valueIsPresent(value) && Number.isFinite(Number(value))) return { amount: Number(value), unit: "rupees" };
  }

  const genericFields = [
    "per_km", "km_rate", "pricing_rate", "fare_per_km", "rate", "base_rate", "base_fare_per_km", "km_charge",
    "pricing.per_km", "pricing.rate", "vehicle_pricing.rate", "vehicle_pricing.per_km",
  ];
  for (const field of genericFields) {
    const value = valueFor(vehicle, [field]);
    if (!valueIsPresent(value) || !Number.isFinite(Number(value))) continue;
    const unit = String(valueFor(vehicle, ["rate_unit", "pricing_unit", "currency_unit"]) ?? "").toLowerCase();
    return { amount: Number(value), unit: /paise|paisa/.test(unit) || (!/rupee|inr/.test(unit) && Number(value) >= 1000) ? "paise" : "rupees" };
  }
  return null;
}

function driverPerKilometreRate(...records) {
  for (const record of records) {
    const rawAmount = valueFor(record, ["current_price"]);
    if (!valueIsPresent(rawAmount) || !Number.isFinite(Number(rawAmount))) continue;
    const amount = Number(rawAmount);
    return { amount, unit: amount >= 1000 ? "paise" : "rupees" };
  }
  return null;
}

function taxiCategoryRateRange(vehicle, categories) {
  const rawCategory = valueFor(vehicle, ["taxi_category_code", "category_code", "vehicle_category_code", "vehicle_category", "taxi_category", "category"]);
  const category = rawCategory && typeof rawCategory === "object"
    ? valueFor(rawCategory, ["code", "category_code", "taxi_category_code", "legacy_category", "display_name", "name"])
    : rawCategory;
  if (!valueIsPresent(category)) return null;
  const normalize = value => String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  const normalizedCategory = normalize(category);
  const match = categories.find(record => ["code", "category_code", "taxi_category_code", "legacy_category", "display_name", "name"]
    .some(key => normalize(valueFor(record, [key])) === normalizedCategory));
  if (!match) return null;
  const minRaw = valueFor(match, ["min_rate_paise_per_km"]);
  const maxRaw = valueFor(match, ["max_rate_paise_per_km"]);
  const baseRaw = valueFor(match, ["base_rate_paise_per_km", "rate_paise_per_km"]);
  const min = minRaw == null ? null : Number(minRaw);
  const max = maxRaw == null ? null : Number(maxRaw);
  const base = baseRaw == null ? null : Number(baseRaw);
  const money = amount => `INR ${(amount / 100).toFixed(2)}`;
  if (Number.isFinite(min) && Number.isFinite(max)) {
    return { display: min === max ? `${money(min)} / km` : `${money(min)} – ${money(max)} / km`, label: "Taxi category rate range" };
  }
  if (Number.isFinite(min)) return { display: `From ${money(min)} / km`, label: "Taxi category minimum rate" };
  if (Number.isFinite(max)) return { display: `Up to ${money(max)} / km`, label: "Taxi category maximum rate" };
  if (Number.isFinite(base)) return { display: `${money(base)} / km`, label: "Taxi category rate" };
  return null;
}

function DriverDetailsPage({ driverId, onBackToDrivers, onNavigate }) {
  const [driverState, setDriverState] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [revision, setRevision] = useState(0);
  const [preview, setPreview] = useState("");
  const [version, setVersion] = useState("");
  const [decision, setDecision] = useState("approved");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [actionError, setActionError] = useState(false);
  const [confirmDecision, setConfirmDecision] = useState("");
  const [documentReviewRequired, setDocumentReviewRequired] = useState(false);
  const [requirement, setRequirement] = useState(null);
  const driver = driverState?.id === driverId ? driverState.record : null;

  useEffect(() => {
    const controller = new AbortController();
    setDriverState(null); setLoading(true); setLoadError(null); setPreview("");
    api.get(`/api/v1/admin/drivers/${encodeURIComponent(driverId)}`, { signal: controller.signal })
      .then(response => {
        const record = unwrappedRecord(response.data);
        setDriverState({ id: driverId, record });
        setVersion(String(valueFor(record, ["version", "version_number"]) ?? ""));
      })
      .catch(error => { if (!controller.signal.aborted) setLoadError(error); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [driverId, revision]);

  useEffect(() => {
    if (!confirmDecision) return undefined;
    function closeOnEscape(event) {
      if (event.key === "Escape" && !saving) setConfirmDecision("");
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [confirmDecision, saving]);

  const { documents: driverDocuments, aadhaar: driverAadhaar } = driverDocumentCollections(driver);
  const verificationStatus = verificationStatusFromRequirements(driver);
  const issues = requirementIssues(driver);
  const photoUrl = driverPhotoUrl(driver);

  async function submitReview() {
    if (!confirmDecision || !driver) return;
    setSaving(true); setMessage(""); setActionError(false); setDocumentReviewRequired(false); setRequirement(null);
    try {
      await api.post(`/api/v1/admin/drivers/${encodeURIComponent(driverId)}/review`, {
        decision: confirmDecision,
        note: note.trim(),
        version: Number(version),
      });
      setMessage("Driver status updated."); setNote(""); setConfirmDecision("");
      setRevision(value => value + 1);
    } catch (error) {
      const required = documentRequirement(error);
      setMessage(readableApiError(error)); setActionError(true);
      setDocumentReviewRequired(Boolean(required) || needsDocumentReview(error)); setRequirement(required);
      setConfirmDecision("");
    } finally { setSaving(false); }
  }

  function requestReview(event) {
    event.preventDefault();
    if (note.trim().length < 3) {
      setMessage("Review note must contain at least 3 non-space characters."); setActionError(true); return;
    }
    if (!Number.isInteger(Number(version)) || Number(version) < 1) {
      setMessage("Record version must be a whole number of at least 1."); setActionError(true); return;
    }
    setMessage(""); setActionError(false);
    setConfirmDecision(decision);
  }

  function renderDocument(record, kind) {
    const idKeys = kind === "aadhaar" ? ["submission_id", "id"] : ["document_id", "id"];
    const id = recordId(record, idKeys);
    const key = `${kind}:${id}`;
    const { label, status, uploadedAt, fileCount } = driverDocumentPresentation(record, kind);
    const uploadedAtLabel = valueIsPresent(uploadedAt) ? formatDateTime(uploadedAt) : "Not returned by API";
    return <div className="driver-document-card" key={key}>
      <div><b>{label}</b><span>Verification status: {status}</span><span>Uploaded: {uploadedAtLabel}</span><span>Files: {formatDriverDocumentFileCount(record, kind)}</span><span>Record ID: {id || "Not returned"}</span></div>
      <span className={`driver-document-status ${status}`} aria-label={`Verification status: ${status}`}>{status}</span>
      <button type="button" className="btn secondary" disabled={!id} onClick={() => setPreview(preview === key ? "" : key)}>{preview === key ? "Hide preview" : "Preview"}</button>
      {preview === key && <div className="driver-document-preview"><KycFilePreview kind={kind} record={record} idKeys={idKeys} metadata={record}/></div>}
    </div>;
  }

  const loadErrorStatus = loadError?.response?.status;
  const loadErrorTitle = loadErrorStatus === 404 ? "Driver not found" : loadErrorStatus === 422 ? "Invalid driver ID" : "Could not load driver details";
  const loadErrorMessage = loadErrorStatus === 404
    ? "This driver record may have been removed or is not available to this account."
    : formatError(loadError);

  return <div className="manual-stack">
    <div className="manual-panel-head driver-details-toolbar">
      <button type="button" className="btn secondary" onClick={onBackToDrivers}>← Back to Drivers</button>
      {driver && <RefreshButton onClick={() => setRevision(value => value + 1)} busy={loading}/>}
    </div>
    <PageHeading title={driver ? driverLabel(driver) : "Driver details"} description={`Driver ID: ${driverId}`} />
    {loading && <div className="panel loading-row" role="status">Loading driver details…</div>}
    {!loading && loadError && <div className="panel driver-load-error"><PanelTitle title={loadErrorTitle} subtitle={loadErrorMessage} icon={ShieldCheck}/><button type="button" className="btn secondary" onClick={() => setRevision(value => value + 1)}>Try again</button></div>}
    {!loading && driver && <>
      <section className="panel driver-profile-panel">
        <PanelTitle title="Driver information" subtitle="Profile and current account status" icon={ShieldCheck}/>
        <div className="driver-profile-summary">
          <div className="driver-profile-photo"><span>{String(driverLabel(driver)).slice(0, 1).toUpperCase()}</span>{photoUrl && <img src={photoUrl} alt={`${driverLabel(driver)} profile`} onError={event => { event.currentTarget.style.display = "none"; }}/>}</div>
          <dl className="profile-grid driver-detail-grid">
            <div className="profile-field"><dt>Full name</dt><dd>{driverLabel(driver)}</dd></div>
            <div className="profile-field"><dt>Driver ID</dt><dd>{recordId(driver, ["driver_id", "id", "user_id", "driver.id", "user.id"]) || driverId}</dd></div>
            <div className="profile-field"><dt>Phone number</dt><dd>{driverPhone(driver)}</dd></div>
            <div className="profile-field"><dt>Driver status</dt><dd>{driverStatusPresentation(driver)?.label || "Not returned by API"}</dd></div>
            <div className="profile-field"><dt>Verification status</dt><dd>{verificationStatus}</dd></div>
            <div className="profile-field"><dt>Account status</dt><dd>{driverStatus(driver, DRIVER_ACCOUNT_STATUS_FIELDS)}</dd></div>
            <div className="profile-field"><dt>Service area</dt><dd>{driverServiceAreas(driver)}</dd></div>
            <div className="profile-field"><dt>Vehicle</dt><dd>{driverVehicle(driver)}</dd></div>
          </dl>
        </div>
        {detailEntries(driver).length > 0 && <details className="driver-extra-details"><summary>Additional profile information</summary><dl className="profile-grid driver-detail-grid">{detailEntries(driver).map(([label, value]) => <div className="profile-field" key={label}><dt>{label}</dt><dd>{formatCell(value)}</dd></div>)}</dl></details>}
      </section>

      <section className="panel">
        <PanelTitle title="Driver documents" subtitle="Aadhaar verification and available submissions" icon={FileCheck2}/>
        <div className="driver-aadhaar-status"><b>Aadhaar verification status</b><span>{driverAadhaar.length ? [...new Set(driverAadhaar.map(docStatus))].join(", ") : "No Aadhaar submission found"}</span></div>
        <h3 className="driver-documents-heading">Aadhaar submissions</h3>
        {driverAadhaar.length ? driverAadhaar.map(record => renderDocument(record, "aadhaar")) : <div className="empty-state driver-empty-state">No Aadhaar submissions were returned for this driver.</div>}
        <h3 className="driver-documents-heading">Other driver documents</h3>
        {driverDocuments.length ? driverDocuments.map(record => renderDocument(record, "documents")) : <div className="empty-state driver-empty-state">No driver documents were returned for this driver.</div>}
      </section>

      <section className="panel">
        <PanelTitle title="Approval requirements" subtitle="Requirements and issues returned by TaxiGo" icon={ShieldCheck}/>
        {issues.length ? <div className="driver-requirements"><ul className="requirement-list">{issues.map((issue, index) => <li className="requirement-badge" key={`${issue}-${index}`}>{issue}</li>)}</ul></div>
          : hasRequirementData(driver) ? <div className="driver-requirements empty"><p className="muted small">No outstanding requirements.</p></div>
            : <div className="empty-state driver-empty-state">No requirement issues were returned for this driver.</div>}
      </section>

      <section className="panel">
        <PanelTitle title="Review decision" subtitle="Approve, reject, or suspend this driver" icon={ShieldCheck}/>
        <form className="manual-form" onSubmit={requestReview}>
          <Field label="Decision"><select value={decision} onChange={event => setDecision(event.target.value)} disabled={saving}><option value="approved">Approve</option><option value="rejected">Reject</option><option value="suspended">Suspend</option></select></Field>
          <Field label="Record version" hint="Required by the TaxiGo API to update this record safely."><input type="number" min="1" step="1" value={version} onChange={event => setVersion(event.target.value)} required disabled={saving}/></Field>
          <Field label="Review note"><textarea minLength="3" maxLength="500" rows="3" value={note} onChange={event => setNote(event.target.value)} required disabled={saving}/></Field>
          {message && <Feedback message={message} error={actionError}/>}
          {documentReviewRequired && <button type="button" className="text-button" onClick={() => onNavigate?.("kyc", requirement || { driverId, documentKind: "permit" })}>Review the required document <span aria-hidden="true">→</span></button>}
          <SubmitButton busy={saving}>Review driver</SubmitButton>
        </form>
      </section>
    </>}
    {confirmDecision && <div className="driver-confirm-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !saving) setConfirmDecision(""); }}>
      <section className="driver-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="driver-confirm-title">
        <h2 id="driver-confirm-title">Confirm {confirmDecision}</h2>
        <p>Apply the {confirmDecision} decision to {driverLabel(driver)}? This updates the driver record.</p>
        <div className="driver-confirm-actions"><button type="button" className="btn secondary" onClick={() => setConfirmDecision("")} disabled={saving}>Cancel</button><button type="button" className="btn primary" onClick={submitReview} disabled={saving}>{saving ? "Saving…" : `Confirm ${confirmDecision}`}</button></div>
      </section>
    </div>}
  </div>;
}

const reviewConfigs = {
  aadhaar: { title: "Aadhaar submissions", endpoint: "/api/v1/admin/aadhaar", idKeys: ["submission_id", "id"], columns: [
    { label: "Submission", value: row => firstValue(row, ["submission_id", "id"]) },
    { label: "Driver", value: row => linkedDriverLabel(row) },
    { label: "Status", value: row => firstValue(row, ["status", "decision"]) },
    { label: "Version", value: row => firstValue(row, ["version"]) },
  ] },
  documents: { title: "Driver documents", endpoint: "/api/v1/admin/documents", idKeys: ["document_id", "id"], columns: [
    { label: "Document", value: row => firstValue(row, ["document_id", "id"]) },
    { label: "Driver", value: row => linkedDriverLabel(row) },
    { label: "Type", value: row => firstValue(row, ["document_type", "document_kind", "kind", "type"]) },
    { label: "Status", value: row => firstValue(row, ["status", "review_status", "decision"]) },
    { label: "Version", value: row => firstValue(row, ["version"]) },
    { label: "Latest", value: row => firstValue(row, ["is_latest", "latest"]) },
    { label: "Updated", value: row => formatDateTime(firstValue(row, ["updated_at", "created_at", "submitted_at"])) },
  ] },
};
function ReviewQueue({ kind, focus, adminProfile }) {
  const config = reviewConfigs[kind];
  const [offset, setOffset] = useState(0);
  const { rows, busy, error, reload } = useList(config.endpoint, { offset, limit: 50 });
  const [recordDetails, setRecordDetails] = useState({});
  const [filter, setFilter] = useState(() => focus ? `${focus.driverId || ""} ${focus.documentKind || ""}`.trim() : "");
  const [selected, setSelected] = useState(null);
  const [version, setVersion] = useState("");
  const [decision, setDecision] = useState("approved");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [actionError, setActionError] = useState(false);
  const terms = filter.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const filteredRows = rows.filter(row => { const id = recordId(row, config.idKeys); const text = searchRecord({ row, detail: recordDetails[id] }); return terms.every(term => text.includes(term)); });
  const columns = config.columns.map(column => column.label === "Driver"
    ? { ...column, value: row => linkedDriverLabel(row, recordDetails[recordId(row, config.idKeys)]) }
    : column);
  async function refreshQueue() { setRecordDetails({}); await reload(); }
  useEffect(() => {
    if (kind !== "aadhaar" || !rows.length) return undefined;
    const pending = rows.filter(row => {
      const id = recordId(row, config.idKeys);
      return id && !recordDetails[id];
    });
    if (!pending.length) return undefined;
    let cancelled = false;
    let next = 0;
    const loaded = {};
    async function loadNext() {
      while (next < pending.length && !cancelled) {
        const row = pending[next++];
        const id = recordId(row, config.idKeys);
        try {
          const response = await api.get(`/api/v1/admin/aadhaar/${encodeURIComponent(id)}`);
          if (!cancelled) loaded[id] = unwrappedRecord(response.data);
        } catch { /* Queue rows remain reviewable if a detail record is unavailable. */ }
      }
    }
    Promise.all(Array.from({ length: Math.min(4, pending.length) }, () => loadNext())).then(() => {
      if (!cancelled && Object.keys(loaded).length) setRecordDetails(current => ({ ...current, ...loaded }));
    });
    return () => { cancelled = true; };
  }, [kind, rows]);
  function select(row) { setSelected(row); setVersion(String(row.version ?? row.version_number ?? "")); setNote(""); setMessage(""); setActionError(false); }
  async function submit(e) {
    e.preventDefault();
    const id = recordId(selected, config.idKeys);
    if (!id) { setMessage("This row has no record ID."); setActionError(true); return; }
    if (saving) return;
    const ownerId = documentOwnerId(selected, recordDetails[recordId(selected, config.idKeys)]);
    const currentAdminId = adminUserId(adminProfile);
    if (currentAdminId && ownerId && currentAdminId === ownerId) {
      setMessage("You cannot review your own documents.");
      setActionError(true);
      return;
    }
    if (decision === "rejected" && !String(note || "").trim()) {
      setMessage("A rejection reason is required.");
      setActionError(true);
      return;
    }
    if (String(note || "").trim().length > 0 && String(note).trim().length < 3) {
      setMessage("Review note must be at least 3 characters.");
      setActionError(true);
      return;
    }
    setSaving(true); setMessage(""); setActionError(false);
    let requestVersion;
    let requestPayload;
    const reviewEndpoint = kycReviewEndpoint(kind, id);
    try {
      let currentVersion;
      if (kind === "aadhaar") {
        const detailResponse = await api.get(`/api/v1/admin/aadhaar/${encodeURIComponent(id)}`);
        const latestRecord = unwrappedRecord(detailResponse.data);
        currentVersion = Number(valueFor(latestRecord, ["version", "version_number"]));
        setRecordDetails(current => ({ ...current, [id]: latestRecord }));
      } else {
        const queueResponse = await api.get(config.endpoint, { params: { offset, limit: 50 } });
        const latestRecord = recordsFrom(queueResponse.data).find(row => recordId(row, config.idKeys) === id);
        if (!latestRecord) {
          throw new Error("This document is no longer in the current admin queue. Refresh the queue and try again.");
        }
        currentVersion = Number(valueFor(latestRecord, ["version", "version_number"]));
        setSelected(latestRecord);
      }
      const payload = kycReviewPayload(decision, note, currentVersion, kind);
      requestVersion = payload.version;
      requestPayload = payload;
      const reviewResponse = await api.post(reviewEndpoint, payload);
      const successMessage = reviewSuccessMessage(reviewResponse.data, decision === "approved" ? "Document approved." : "Document rejected.");
      setSelected(null);
      setRecordDetails({});
      await reload();
      setMessage(successMessage);
    } catch (err) {
      let actionMessage = reviewRequestError(err);
      if (Number(err?.response?.status) === 409) {
        try {
          let latestRecord = null;
          if (kind === "aadhaar") {
            const response = await api.get(`/api/v1/admin/aadhaar/${encodeURIComponent(id)}`);
            latestRecord = unwrappedRecord(response.data);
            setRecordDetails(current => ({ ...current, [id]: latestRecord }));
            setSelected(current => current ? { ...current, ...latestRecord } : current);
          } else {
            const response = await api.get(config.endpoint, { params: { offset, limit: 50 } });
            latestRecord = recordsFrom(response.data).find(row => recordId(row, config.idKeys) === id) || null;
            setSelected(latestRecord);
          }
          if (latestRecord) setVersion(String(valueFor(latestRecord, ["version", "version_number"]) ?? ""));
          else setVersion("");
          await reload();
          actionMessage = reviewConflictMessage(err, { requestVersion, latestRecord });
        } catch (refreshError) {
          actionMessage = "Couldn't refresh the latest status. Please try again.";
        }
      }
      setMessage(actionMessage); setActionError(true);
    }
    finally { setSaving(false); }
  }
  return <>
    <div className="panel"><div className="manual-panel-head"><PanelTitle title={config.title} subtitle="Select a record to approve or reject it" icon={FileCheck2}/><RefreshButton onClick={refreshQueue} busy={busy}/></div>
      <div className="manual-toolbar"><Field label="Filter by driver, type, or status"><input type="search" value={filter} onChange={event => { setFilter(event.target.value); setOffset(0); }} placeholder="Driver ID, permit, pending..."/></Field><span className="muted small">{filteredRows.length} matches on this page</span><div className="queue-pagination"><button className="btn secondary" type="button" disabled={busy || offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>Previous</button><button className="btn secondary" type="button" disabled={busy || rows.length < 50} onClick={() => setOffset(offset + 50)}>Next</button></div></div>
      {error && <Feedback message={error} error/>}{busy ? <div className="loading-row">Loading review queue…</div> : <DataTable rows={filteredRows} empty="No documents match this filter." idKeys={config.idKeys} selectedId={selected ? recordId(selected, config.idKeys) : ""} onSelect={select} columns={columns}/>}</div>
    {selected && <div className="panel"><PanelTitle title="Review submission" subtitle={`Record ID: ${recordId(selected, config.idKeys)}`} icon={ShieldCheck}/><KycFilePreview kind={kind} record={selected} idKeys={config.idKeys} metadata={recordDetails[recordId(selected, config.idKeys)]}/>
      <div className="driver-detail-block"><h3>Submission details</h3><dl className="profile-grid driver-detail-grid">
        <div className="profile-field"><dt>Driver</dt><dd>{linkedDriverLabel(selected, recordDetails[recordId(selected, config.idKeys)])}</dd></div>
        <div className="profile-field"><dt>Driver ID</dt><dd>{documentOwnerId(selected, recordDetails[recordId(selected, config.idKeys)]) || "-"}</dd></div>
        <div className="profile-field"><dt>Current status</dt><dd>{currentReviewStatus(selected, recordDetails[recordId(selected, config.idKeys)])}</dd></div>
        {currentReviewNote(selected, recordDetails[recordId(selected, config.idKeys)]) && <div className="profile-field"><dt>Review note</dt><dd>{currentReviewNote(selected, recordDetails[recordId(selected, config.idKeys)])}</dd></div>}
      </dl></div>
      {(() => {
        const ownerId = documentOwnerId(selected, recordDetails[recordId(selected, config.idKeys)]);
        const currentAdminId = adminUserId(adminProfile);
        const isOwn = Boolean(currentAdminId && ownerId && currentAdminId === ownerId);
        return isOwn ? <div className="notice warning-notice"><ShieldCheck size={18}/><div><b>You cannot review your own documents.</b><p>The logged-in admin account matches this document owner, so approve/reject actions are disabled.</p></div></div> : null;
      })()}
      <form className="manual-form" onSubmit={submit}>
        <Field label="Decision"><select value={decision} onChange={e => setDecision(e.target.value)} disabled={saving || (adminUserId(adminProfile) && documentOwnerId(selected, recordDetails[recordId(selected, config.idKeys)]) && adminUserId(adminProfile) === documentOwnerId(selected, recordDetails[recordId(selected, config.idKeys)]))}><option value="approved">Approve</option><option value="rejected">Reject</option></select></Field>
        <Field label="Record version"><input type="number" min="1" value={version} onChange={e => setVersion(e.target.value)} required disabled={saving}/></Field>
        <Field label="Review note"><textarea minLength="3" maxLength="500" rows="3" value={note} onChange={e => setNote(e.target.value)} required disabled={saving}/></Field>
        <Feedback message={message} error={actionError}/><SubmitButton busy={saving} disabled={saving || (adminUserId(adminProfile) && documentOwnerId(selected, recordDetails[recordId(selected, config.idKeys)]) && adminUserId(adminProfile) === documentOwnerId(selected, recordDetails[recordId(selected, config.idKeys)]))}>Save review</SubmitButton>
      </form>
    </div>}
  </>;
}
function attachmentIndexes(record, kind) {
  if (kind === "aadhaar") {
    const count = driverDocumentFileCount(record, kind);
    return count > 0 ? Array.from({ length: count }, (_, index) => index) : [0, 1];
  }
  const attachments = valueFor(record, ["files", "images", "attachments", "file_metadata", "file_names"]);
  if (Array.isArray(attachments) && attachments.length) return attachments.map((_, index) => index);
  const countValue = valueFor(record, ["file_count", "files_count", "image_count", "attachment_count", "number_of_files"]);
  const count = Number(countValue);
  if (Number.isInteger(count) && count > 0 && count <= 20) return Array.from({ length: count }, (_, index) => index);
  return [0, 1, 2, 3];
}
function sniffFileType(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return "application/pdf";
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return "image/webp";
  return "";
}
async function fileBlobFromResponse(response) {
  const source = response.data;
  const responseType = response.headers?.["content-type"] || source?.type || "application/octet-stream";
  let payload = source;
  if (source instanceof Blob) {
    const bytes = new Uint8Array(await source.slice(0, 16).arrayBuffer());
    const detected = sniffFileType(bytes);
    if (detected) return new Blob([source], { type: detected });
    if (!responseType.includes("json") && !source.type.includes("json")) return source;
    try { payload = JSON.parse(await source.text()); }
    catch { return source; }
  }
  if (payload && typeof payload === "object" && !ArrayBuffer.isView(payload) && !(payload instanceof ArrayBuffer)) payload = payload.data ?? payload;
  if (payload instanceof Blob) return payload;
  if (payload instanceof ArrayBuffer || ArrayBuffer.isView(payload)) return new Blob([payload], { type: responseType });
  if (Array.isArray(payload) && payload.every(value => Number.isInteger(value))) return new Blob([new Uint8Array(payload)], { type: responseType });
  const encoded = typeof payload === "string" ? payload : payload?.base64 ?? payload?.data_base64 ?? payload?.content_base64 ?? payload?.image_base64 ?? payload?.file_base64;
  if (typeof encoded === "string") {
    const dataUrl = encoded.match(/^data:([^;]+);base64,(.+)$/);
    const mime = dataUrl?.[1] || payload?.content_type || payload?.mime_type || responseType;
    const base64 = dataUrl?.[2] || encoded;
    const binary = atob(base64.replace(/\s/g, ""));
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    return new Blob([bytes], { type: mime });
  }
  const returnedUrl = payload?.file_url ?? payload?.image_url ?? payload?.download_url ?? payload?.signed_url ?? payload?.url;
  if (typeof returnedUrl === "string") {
    const url = new URL(returnedUrl, API_BASE_URL);
    if (!new Set(["http:", "https:"]).has(url.protocol)) throw new Error("The file endpoint returned an unsupported URL.");
    if (url.origin === new URL(API_BASE_URL).origin) {
      const authorizedResponse = await api.get(`${url.pathname}${url.search}`, { responseType: "blob" });
      return fileBlobFromResponse(authorizedResponse);
    }
    return { url: url.href, type: payload?.content_type || payload?.mime_type || "application/octet-stream" };
  }
  throw new Error(payload?.message || "The file endpoint returned no previewable file data.");
}
function KycFilePreview({ kind, record, idKeys, metadata: initialMetadata }) {
  const id = recordId(record, idKeys);
  const [metadata, setMetadata] = useState(initialMetadata || record);
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!id) { setError("This submission has no ID for its file endpoint."); return undefined; }
    let cancelled = false;
    const objectUrls = [];
    setMetadata(initialMetadata || record); setFiles([]); setError(""); setLoading(true);
    async function loadFiles() {
      let detail = initialMetadata || record;
      if (kind === "aadhaar" && !initialMetadata) {
        try {
          const response = await api.get(`/api/v1/admin/aadhaar/${encodeURIComponent(id)}`);
          detail = unwrappedRecord(response.data) || record;
          if (!cancelled) setMetadata(detail);
        } catch { /* The file route may still work if the detail route is unavailable. */ }
      }
      const indexes = attachmentIndexes(detail, kind);
      const fileResults = await Promise.all(indexes.map(async index => {
        const path = driverDocumentFileEndpoint(kind, id, index);
        try {
          const response = await api.get(path, { responseType: "blob" });
          const file = await fileBlobFromResponse(response);
          return file instanceof Blob ? { index, blob: file } : { index, remoteFile: file };
        } catch (fileError) { return { index, error: formatError(fileError) }; }
      }));
      if (cancelled) return;
      const validFiles = fileResults.filter(file => file?.blob || file?.remoteFile);
      if (!validFiles.length) {
        const reason = fileResults.find(file => file?.error)?.error;
        setError(reason
          ? `Could not load the ${kind === "aadhaar" ? "Aadhaar image" : "document file"}: ${reason}`
          : `No ${kind === "aadhaar" ? "Aadhaar image" : "document file"} was returned. Check that this submission has an uploaded file and that the admin file endpoint is enabled.`);
        return;
      }
      setFiles(validFiles.map(file => {
        if (file.remoteFile) return { index: file.index, url: file.remoteFile.url, type: file.remoteFile.type };
        const url = URL.createObjectURL(file.blob);
        objectUrls.push(url);
        return { index: file.index, url, type: file.blob.type || "application/octet-stream" };
      }));
    }
    loadFiles().catch(loadError => { if (!cancelled) setError(loadError?.message || "Could not load this submission's files."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; objectUrls.forEach(url => URL.revokeObjectURL(url)); };
  }, [kind, id]);
  const docType = firstValue(metadata, ["document_type", "document_kind", "kind", "type"]);
  return <section className="kyc-file-panel" aria-label="Submitted identity files">
    <div className="kyc-file-heading"><div><h3>{kind === "aadhaar" ? "Submitted Aadhaar card" : `${docType === "-" ? "Submitted document" : `Submitted ${docType}`}`}</h3><p>Driver: {linkedDriverLabel(metadata)}</p></div><span>{files.length ? `${files.length} file${files.length === 1 ? "" : "s"}` : "Private file preview"}</span></div>
    {loading ? <div className="loading-row">Loading secure file preview...</div> : error ? <Feedback message={error} error/> : <div className="kyc-file-grid">{files.map(file => { const safeUrl = isSafeDocumentUrl(file.url) ? file.url : ""; return <div className="kyc-file-card" key={file.index}>
      {file.type.startsWith("image/") && safeUrl ? <img src={safeUrl} alt={`${kind === "aadhaar" ? "Aadhaar card" : "Driver document"} file ${file.index + 1}`}/> : file.type === "application/pdf" && safeUrl ? <iframe src={safeUrl} title={`Document file ${file.index + 1}`}/> : <p>Preview is not available for {file.type}.</p>}
      {safeUrl ? <a href={safeUrl} download={`${kind}-${id}-${file.index + 1}`}>Open or download file {file.index + 1}</a> : <p className="muted small">Preview URL is not available.</p>}
    </div>; })}</div>}
  </section>;
}
function KycPage({ focus, adminProfile, driverId, onOpenKycDriver, onBackToKycDocuments }) {
  return <KycDriverDocumentsPage focus={focus} adminProfile={adminProfile} routeDriverId={driverId} onOpenKycDriver={onOpenKycDriver} onBackToKycDocuments={onBackToKycDocuments}/>;
}

function SimpleList({ title, endpoint, columns, icon = Route, customPerPage, onDetails, detailDisabled, selectedId, idKeys }) {
  const [page, setPage] = useState(1);
  const perPage = customPerPage || 50;
  const offset = (page - 1) * perPage;
  const pageBased = endpoint.includes("/admin/") && !/aadhaar|documents/.test(endpoint);
  const params = pageBased ? { page, per_page: perPage } : { offset, limit: perPage };
  const { rows, busy, error, reload, total, hasMore } = useList(endpoint, params);
  const totalRecords = total ?? rows.length;
  const startRecord = rows.length === 0 ? 0 : (page - 1) * perPage + 1;
  const endRecord = Math.min(page * perPage, totalRecords > rows.length ? totalRecords : (page - 1) * perPage + rows.length);
  const hasNext = hasMore != null
    ? hasMore
    : total != null
      ? page * perPage < total
      : rows.length >= perPage;
  return <div className="panel"><div className="manual-panel-head"><PanelTitle title={title} subtitle="Records available to this admin account" icon={icon}/><RefreshButton onClick={reload} busy={busy}/></div><div className="manual-toolbar"><span className="muted small">{totalRecords > 0 ? `Showing ${startRecord} - ${endRecord} of ${totalRecords} records` : `${rows.length} records on this page`}</span><div className="queue-pagination"><button className="btn secondary" type="button" disabled={busy || page <= 1} onClick={() => setPage(p => Math.max(1, p - 1))}>Previous</button><button className="btn secondary" type="button" disabled={busy || !hasNext} onClick={() => setPage(p => p + 1)}>Next</button></div></div>{error && <Feedback message={error} error/>}{busy ? <div className="loading-row">Loading records…</div> : <DataTable rows={rows} columns={columns} page={page} perPage={perPage} onDetails={onDetails} detailDisabled={detailDisabled} selectedId={selectedId} idKeys={idKeys}/>}</div>;
}
function bookingVehicleRegistration(booking, driver) {
  const directRegistration = valueFor(booking, [
    "vehicle.registration_number", "vehicle.registrationNumber", "vehicle_registration_number", "registration_number",
  ]);
  if (valueIsPresent(directRegistration) && typeof directRegistration !== "object") return String(directRegistration);

  const vehicleId = valueFor(booking, ["vehicle_id", "vehicle.id"]);
  const vehicles = [
    valueFor(driver, ["requirements.vehicles"]),
    valueFor(driver, ["vehicles"]),
    valueFor(driver, ["vehicle_records"]),
  ].filter(Array.isArray).flat();
  const matchingVehicle = vehicleId == null
    ? (vehicles.length === 1 ? vehicles[0] : null)
    : vehicles.find(vehicle => String(recordId(vehicle, ["vehicle_id", "id"])) === String(vehicleId));
  const registration = valueFor(matchingVehicle, ["registration_number", "registrationNumber", "registration_no"]);
  return valueIsPresent(registration) && typeof registration !== "object" ? String(registration) : null;
}
const BOOKING_DRIVER_ID_FIELDS = [
  "driver_id", "driver_user_id", "assigned_driver_id", "driver.id", "driver.user_id",
  "assigned_driver.id", "assigned_driver.user_id", "confirmed_by_driver_id", "accepted_by_driver_id",
  "confirmed_by_driver.id", "accepted_by_driver.id",
];
function bookingDriverId(booking) {
  return valueFor(booking, BOOKING_DRIVER_ID_FIELDS);
}
function bookingDriverName(booking) {
  return personName(booking,
    ["driver", "assigned_driver", "confirmed_by_driver", "accepted_by_driver"],
    ["driver_name", "assigned_driver_name", "confirmed_by_driver_name", "accepted_by_driver_name"]);
}
function bookingDriverProfileName(profile) {
  return personName(profile, ["driver", "user", "profile"], ["display_name", "full_name", "fullName", "name", "driver_name"]);
}

function BookingDetailsPage({ bookingId, onBackToBookings }) {
  const [bookingState, setBookingState] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [revision, setRevision] = useState(0);
  const [resolvedCustomer, setResolvedCustomer] = useState(null);
  const [resolvedDriver, setResolvedDriver] = useState(null);
  const [resolvingContacts, setResolvingContacts] = useState(false);
  const booking = bookingState?.id === bookingId ? bookingState.record : null;

  useEffect(() => { window.scrollTo(0, 0); }, [bookingId]);

  useEffect(() => {
    const controller = new AbortController();
    setBookingState(null); setLoading(true); setLoadError(null);
    api.get(`/api/v1/admin/bookings/${encodeURIComponent(bookingId)}`, { signal: controller.signal })
      .then(response => {
        if (!controller.signal.aborted) setBookingState({ id: bookingId, record: unwrappedRecord(response.data) });
      })
      .catch(error => { if (!controller.signal.aborted) setLoadError(error); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [bookingId, revision]);

  useEffect(() => {
    if (!booking) { setResolvedCustomer(null); setResolvedDriver(null); setResolvingContacts(false); return; }
    const cid = valueFor(booking, ["customer_id", "customer_user_id", "rider_id", "passenger_id", "customer.id", "customer.user_id", "user.customer_id", "user.id", "user_id"]);
    const did = valueFor(booking, [
      "driver_id", "driver_user_id", "assigned_driver_id", "driver.id", "driver.user_id",
      "confirmed_by_driver_id", "accepted_by_driver_id", "confirmed_by_driver.id", "accepted_by_driver.id",
    ]);
    const hasVehicleRegistration = valueIsPresent(bookingVehicleRegistration(booking, null));
    const hasCustomerName = valueIsPresent(personName(booking, ["customer", "user", "rider", "passenger"], ["customer_name", "passenger_name", "rider_name"]));
    const hasCustomerPhone = valueIsPresent(valueFor(booking, ["customer.phone", "customer.phone_number", "customer_phone"]));
    const hasDriverName = valueIsPresent(personName(booking, ["driver", "assigned_driver"], ["driver_name"]));
    const hasDriverPhone = valueIsPresent(valueFor(booking, ["driver.phone", "driver.phone_number", "driver_phone"]));
    let cancelled = false;
    setResolvingContacts(true);
    (async () => {
      const tasks = [];
      if (cid && !(hasCustomerName && hasCustomerPhone)) {
        tasks.push(api.get(`/api/v1/admin/customers/${encodeURIComponent(cid)}`).then(r => { if (!cancelled) setResolvedCustomer(unwrappedRecord(r.data)); }).catch(() => { if (!cancelled) setResolvedCustomer(null); }));
      } else { setResolvedCustomer(null); }
      if (did && (!(hasDriverName && hasDriverPhone) || !hasVehicleRegistration)) {
        tasks.push(api.get(`/api/v1/admin/drivers/${encodeURIComponent(did)}`).then(r => { if (!cancelled) setResolvedDriver(unwrappedRecord(r.data)); }).catch(() => { if (!cancelled) setResolvedDriver(null); }));
      } else { setResolvedDriver(null); }
      await Promise.allSettled(tasks);
      if (!cancelled) setResolvingContacts(false);
    })();
    return () => { cancelled = true; };
  }, [booking]);

  const fareSnapshot = parseSnapshot(valueFor(booking, ["fare_snapshot"]));
  const bookingStatus = valueFor(booking, ["status", "booking_status"]);
  const publicReference = valueFor(booking, ["public_reference"]);
  const customerName = personName(booking, ["customer", "user", "rider", "passenger"], ["customer_name", "passenger_name", "rider_name"])
    || personName(resolvedCustomer, ["customer", "user", "profile"], ["display_name", "full_name", "fullName", "name", "customer_name"]);
  const customerId = valueFor(booking, ["customer_id", "customer_user_id", "rider_id", "passenger_id", "customer.id", "customer.user_id", "user.customer_id", "user.id", "user_id"]);
  const customerPhone = valueFor(booking, ["customer.phone", "customer.phone_number", "customer_phone"])
    || (resolvedCustomer ? (resolvedCustomer.phone || resolvedCustomer.phone_number || resolvedCustomer.mobile || resolvedCustomer.mobile_number) : null);
  const driverName = personName(booking, ["driver", "assigned_driver"], ["driver_name"])
    || personName(resolvedDriver, ["driver", "user", "profile"], ["display_name", "full_name", "fullName", "name", "driver_name"]);
  const driverId = valueFor(booking, [
    "driver_id", "driver_user_id", "assigned_driver_id", "driver.id", "driver.user_id",
    "confirmed_by_driver_id", "accepted_by_driver_id", "confirmed_by_driver.id", "accepted_by_driver.id",
  ]);
  const driverPhone = valueFor(booking, ["driver.phone", "driver.phone_number", "driver_phone"])
    || (resolvedDriver ? (resolvedDriver.phone || resolvedDriver.phone_number || resolvedDriver.mobile || resolvedDriver.mobile_number) : null);
  const vehicleName = valueFor(booking, ["vehicle.make_model", "vehicle.model", "vehicle_category", "category"]);
  const vehicleId = valueFor(booking, ["vehicle_id", "vehicle.id"]);
  const vehicleRegistration = bookingVehicleRegistration(booking, resolvedDriver);
  const pickup = bookingLocation(booking, "pickup") ?? "—";
  const dropoff = bookingLocation(booking, "dropoff") ?? "—";
  const currency = String(valueFor(booking, ["currency"]) ?? valueFor(fareSnapshot, ["currency"]) ?? "INR");
  const agreedFare = valueFor(booking, ["agreed_fare_paise", "fare_paise", "total_fare_paise"])
    ?? valueFor(fareSnapshot, ["total_paise", "offer_amount_paise"]);
  const tollPaise = valueFor(booking, ["toll_paise"]) ?? valueFor(fareSnapshot, ["toll_paise"]);
  const discountPaise = valueFor(booking, ["discount_paise"]) ?? valueFor(fareSnapshot, ["discount_paise"]);
  const customerDisplay = resolvingContacts && !customerName && !customerPhone
    ? "Loading…"
    : customerName && customerPhone
      ? `${customerName} (${customerPhone})`
      : (customerName || customerPhone || (customerId != null ? String(customerId) : "—"));
  const driverDisplay = !driverId && !driverName
    ? "Not assigned"
    : (resolvingContacts && !driverName && !driverPhone
      ? "Loading…"
      : driverName && driverPhone
        ? `${driverName} (${driverPhone})`
        : (driverName || driverPhone || (driverId != null ? String(driverId) : "—")));
  const bookedByName = personName(booking, ["booked_by", "created_by", "creator", "booking_creator"], ["booked_by_name", "created_by_name", "creator_name", "booking_creator_name"]);
  const bookedById = directValue(booking, ["booked_by_id", "booked_by_user_id", "created_by_id", "created_by_user_id", "creator_id", "booked_by.id", "created_by.id", "creator.id"]);
  const bookedByDisplay = bookedByName
    || (bookedById != null && String(bookedById) === String(customerId) ? customerDisplay : null)
    || (bookedById != null && String(bookedById) === String(driverId) ? driverDisplay : null)
    || (bookedById != null ? String(bookedById) : customerDisplay);
  const confirmedByName = personName(booking,
    ["confirmed_by", "accepted_by", "approved_by", "confirmation_actor", "confirmed_by_user", "confirmed_by_driver", "status_updated_by"],
    ["confirmed_by_name", "accepted_by_name", "approved_by_name", "confirmation_actor_name", "status_updated_by_name"]);
  const confirmedById = directValue(booking, [
    "confirmed_by_id", "confirmed_by_user_id", "confirmed_by_driver_id", "accepted_by_id", "accepted_by_user_id",
    "approved_by_id", "confirmation_actor_id", "status_updated_by_id", "confirmed_by.id", "accepted_by.id", "approved_by.id",
    "confirmed_by_driver.id", "accepted_by_driver.id",
  ]);
  const isConfirmed = /confirmed|accepted/i.test(String(bookingStatus ?? ""));
  const confirmedByDisplay = confirmedByName
    || (confirmedById != null && String(confirmedById) === String(driverId) ? driverDisplay : null)
    || (confirmedById != null && String(confirmedById) === String(customerId) ? customerDisplay : null)
    || (confirmedById != null ? String(confirmedById) : null)
    || (isConfirmed && driverName ? driverDisplay : (isConfirmed ? "Not returned by API" : null));
  const rideFields = [
    ["Public reference", publicReference],
    ["Ride request ID", valueFor(booking, ["request_id"])],
    ["Offer ID", valueFor(booking, ["offer_id"])],
    ["Booked by", bookedByDisplay],
    ["Customer", customerDisplay],
    ["Confirmed by", confirmedByDisplay],
    ["Driver", driverDisplay],
    ...(valueIsPresent(vehicleId) || valueIsPresent(vehicleRegistration) || valueIsPresent(vehicleName)
      ? [["Vehicle registration number", vehicleRegistration ?? "Not returned by API"]]
      : []),
    ...(valueIsPresent(vehicleName) ? [["Vehicle", vehicleName]] : []),
    ["Passengers", valueFor(booking, ["passenger_count", "passengers"])],
    ["Pickup", pickup],
    ["Drop-off", dropoff],
    ["Pickup time", valueFor(booking, ["pickup_at", "scheduled_at"])],
    ["Reserved until", valueFor(booking, ["reserved_until"])],
    ["Booked on", valueFor(booking, ["created_at"])],
    ["Last updated", valueFor(booking, ["updated_at"])],
    ["Payment status", valueFor(booking, ["payment_status", "payment.status"])],
  ].filter(([, value]) => valueIsPresent(value));
  const fareFields = [
    ["Offer amount", valueFor(fareSnapshot, ["offer_amount_paise"]) ?? agreedFare],
    ["Approved rate per km", valueFor(fareSnapshot, ["approved_rate_paise_per_km"])],
    ["Base fare", valueFor(fareSnapshot, ["estimate_rules.base_fare_paise"])],
    ["Minimum fare", valueFor(fareSnapshot, ["estimate_rules.minimum_fare_paise"])],
    ["Toll", tollPaise],
    ["Discount", discountPaise],
    ["Total", valueFor(fareSnapshot, ["total_paise"]) ?? agreedFare],
    ["Fare estimate ID", valueFor(booking, ["fare_estimate_id"]) ?? valueFor(fareSnapshot, ["estimate_id"])],
  ].filter(([, value]) => valueIsPresent(value));
  const loadErrorStatus = loadError?.response?.status;
  const loadErrorTitle = loadErrorStatus === 404 ? "Booking not found" : "Could not load booking details";

  function formatBookingValue(label, value) {
    const isDateField = /(?:_at|\sat|_date|\sdate|_time|\stime)$/i.test(label)
      || /^(?:Booked on|Last updated|Reserved until)$/i.test(label);
    return isDateField && value != null && !Number.isNaN(new Date(value).getTime())
      ? formatDateTime(value)
      : formatCell(value);
  }

  return <div className="manual-stack rides-detail-page">
    <div className="manual-panel-head driver-details-toolbar">
      <button type="button" className="btn secondary" onClick={onBackToBookings}><ArrowLeft size={15}/> Back to Bookings</button>
      {booking && <RefreshButton onClick={() => setRevision(value => value + 1)} busy={loading}/>}
    </div>
    <PageHeading title="Booking details" description="Review who booked and confirmed this ride, plus the fare information." />
    {loading && <div className="panel loading-row" role="status">Loading booking details…</div>}
    {!loading && loadError && <div className="panel driver-load-error"><PanelTitle title={loadErrorTitle} subtitle={formatError(loadError)}/><button type="button" className="btn secondary" onClick={() => setRevision(value => value + 1)}>Try again</button></div>}
    {!loading && booking && <section className="panel">
      <PanelTitle title="Ride information" subtitle={bookingStatus == null ? "Booking overview" : `Status: ${formatCell(bookingStatus)}`} icon={Route}/>
      {rideFields.length ? <dl className="profile-grid driver-detail-grid">
        {rideFields.map(([label, value]) => <div className="profile-field" key={label}><dt>{label}</dt><dd>{formatBookingValue(label, value)}</dd></div>)}
      </dl> : <p className="muted small">The API did not return ride details for this booking.</p>}
    </section>}
    {!loading && booking && <section className="panel">
      <PanelTitle title="Fare breakdown" subtitle="Amounts are shown in the booking currency" icon={CircleDollarSign}/>
      {fareFields.length ? <dl className="profile-grid driver-detail-grid">
        {fareFields.map(([label, value]) => {
          const isRate = label === "Approved rate per km";
          const isIdentifier = label === "Fare estimate ID";
          const formatted = isIdentifier ? formatCell(value) : `${formatPaiseAmount(value, currency)}${isRate ? " / km" : ""}`;
          return <div className="profile-field" key={label}><dt>{label}</dt><dd>{formatted}</dd></div>;
        })}
      </dl> : <p className="muted small">The API did not return fare amounts for this booking.</p>}
    </section>}
  </div>;
}

function RideStatusBadge({ value }) {
  const status = String(value ?? "").trim();
  const normalized = status.toLowerCase();
  const tone = /complete|confirmed|accepted|success/.test(normalized)
    ? "success"
    : /cancel|reject|fail|suspend/.test(normalized)
      ? "danger"
      : /pending|open|requested/.test(normalized)
        ? "warning"
        : /progress|en_route|arrived/.test(normalized)
          ? "active"
          : "neutral";
  return <span className={`ride-status-badge ${tone}`}><i/>{status ? formatCell(status) : "Unknown"}</span>;
}

function BookingManager({ onOpenBooking, onCountChange, customers }) {
  const [page, setPage] = useState(1);
  const perPage = 20;
  const { rows, busy, error, reload, total, hasMore } = useList("/api/v1/admin/bookings", { page, per_page: perPage });
  const customerMap = useMemo(() => {
    const map = new Map();
    for (const customer of customers) {
      for (const key of ["id", "customer_id", "user_id"]) {
        const id = customer?.[key];
        if (id !== undefined && id !== null && String(id).trim()) map.set(String(id), customer);
      }
    }
    return map;
  }, [customers]);
  function bookingCustomerName(row) {
    const customerId = row?.customer_id ?? row?.user_id ?? row?.customer?.customer_id ?? row?.customer?.id ?? row?.customer?.user_id ?? row?.user?.customer_id ?? row?.user?.id;
    const customer = (customerId !== undefined && customerId !== null ? customerMap.get(String(customerId)) : null) || row?.customer || null;
    const name = customer?.full_name || customer?.name || customer?.display_name || customer?.customer_name || row?.customer_name || row?.customer?.full_name || row?.customer?.name || row?.customer?.display_name || row?.user?.full_name || row?.user?.name || row?.rider?.name || row?.passenger_name || row?.contact_name;
    if (name) return name;
    return customerId !== undefined && customerId !== null
      ? `Customer (${String(customerId).slice(0, 6)})`
      : "Unknown";
  }
  useEffect(() => { onCountChange?.(busy && !rows.length ? null : (total ?? rows.length)); }, [busy, rows.length, total, onCountChange]);
  const hasNext = hasMore != null
    ? hasMore
    : total != null
      ? page * perPage < total
      : rows.length >= perPage;
  const [selected, setSelected] = useState(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [bookingLocationDetails, setBookingLocationDetails] = useState({});
  const [bookingDriverProfiles, setBookingDriverProfiles] = useState({});
  const driverProfileRequests = useRef(new Set());
  const [status, setStatus] = useState("en_route");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [actionError, setActionError] = useState(false);
  useEffect(() => {
    const rowsNeedingDetails = rows.filter(row => {
      const id = recordId(row, ["booking_id", "id"]);
      const needsLocations = !bookingLocation(row, "pickup") || !bookingLocation(row, "dropoff");
      const needsDriver = !bookingDriverName(row) && !bookingDriverId(row);
      return id && (needsLocations || needsDriver);
    });
    const ids = rowsNeedingDetails.map(row => recordId(row, ["booking_id", "id"]));
    if (!ids.length) {
      setBookingLocationDetails({});
      return undefined;
    }
    const controller = new AbortController();
    setBookingLocationDetails(Object.fromEntries(ids.map(id => [id, { loading: true }])));
    let next = 0;
    async function loadNext() {
      while (next < rowsNeedingDetails.length && !controller.signal.aborted) {
        const row = rowsNeedingDetails[next++];
        const id = recordId(row, ["booking_id", "id"]);
        try {
          const response = await api.get(`/api/v1/admin/bookings/${encodeURIComponent(id)}`, { signal: controller.signal });
          if (!controller.signal.aborted) {
            setBookingLocationDetails(current => ({ ...current, [id]: { record: unwrappedRecord(response.data) } }));
          }
        } catch {
          if (!controller.signal.aborted) setBookingLocationDetails(current => ({ ...current, [id]: { error: true } }));
        }
      }
    }
    Promise.all(Array.from({ length: Math.min(4, rowsNeedingDetails.length) }, () => loadNext()));
    return () => controller.abort();
  }, [rows]);

  function bookingLocationForRow(row, side) {
    const id = recordId(row, ["booking_id", "id"]);
    const summaryLocation = bookingLocation(row, side);
    if (summaryLocation) return summaryLocation;
    const detail = bookingLocationDetails[id];
    return bookingLocation(detail?.record, side) ?? (detail?.loading ? "Loading..." : "-");
  }
  useEffect(() => {
    const driverIds = new Set();
    for (const row of rows) {
      const bookingId = recordId(row, ["booking_id", "id"]);
      const detail = bookingLocationDetails[bookingId]?.record;
      const driverId = bookingDriverId(row) ?? bookingDriverId(detail);
      if (valueIsPresent(driverId) && !bookingDriverName(row) && !bookingDriverName(detail)) driverIds.add(String(driverId));
    }
    for (const driverId of driverIds) {
      if (bookingDriverProfiles[driverId] || driverProfileRequests.current.has(driverId)) continue;
      driverProfileRequests.current.add(driverId);
      setBookingDriverProfiles(current => ({ ...current, [driverId]: { loading: true } }));
      api.get(`/api/v1/admin/drivers/${encodeURIComponent(driverId)}`)
        .then(response => setBookingDriverProfiles(current => ({ ...current, [driverId]: { record: unwrappedRecord(response.data) } })))
        .catch(() => setBookingDriverProfiles(current => ({ ...current, [driverId]: { error: true } })))
        .finally(() => driverProfileRequests.current.delete(driverId));
    }
  }, [rows, bookingLocationDetails, bookingDriverProfiles]);
  function bookingDriverForRow(row) {
    const bookingId = recordId(row, ["booking_id", "id"]);
    const detailState = bookingLocationDetails[bookingId];
    const detail = detailState?.record;
    const name = bookingDriverName(row) || bookingDriverName(detail);
    if (name) return name;
    const driverId = bookingDriverId(row) ?? bookingDriverId(detail);
    if (valueIsPresent(driverId)) {
      const profile = bookingDriverProfiles[String(driverId)];
      const profileName = bookingDriverProfileName(profile?.record);
      if (profileName) return profileName;
      if (profile?.loading || !profile) return "Loading driver...";
      return profile.error ? "Driver name unavailable" : "Driver name not returned";
    }
    if (detailState?.loading || !detailState) return "Loading...";
    return detailState.error ? "Unavailable" : "Not assigned";
  }
  async function submit(e) {
    e.preventDefault(); const id = recordId(selected, ["booking_id", "id"]);
    if (!id) { setMessage("This booking has no booking ID."); setActionError(true); return; }
    setSaving(true); setMessage(""); setActionError(false);
    try { await api.patch(`/api/v1/bookings/${encodeURIComponent(id)}/status`, { status }); setMessage("Booking status updated."); setSelected(null); await reload(); }
    catch (err) { setMessage(formatError(err)); setActionError(true); }
    finally { setSaving(false); }
  }

  function bookingFare(row) {
    const snapshot = parseSnapshot(valueFor(row, ["fare_snapshot"]));
    const fare = valueFor(row, ["agreed_fare_paise"]) ?? valueFor(snapshot, ["total_paise", "offer_amount_paise"]);
    const currency = valueFor(row, ["currency"]) ?? "INR";
    return formatPaiseAmount(fare, currency);
  }
  const statusOptions = [...new Set(rows.map(row => String(valueFor(row, ["status", "booking_status"]) || "").trim().toLowerCase()).filter(Boolean))];
  if (!statusOptions.includes("completed")) statusOptions.push("completed");
  const completedBookingCount = rows.filter(row => String(valueFor(row, ["status", "booking_status"]) || "").trim().toLowerCase() === "completed").length;
  const searchTerm = search.trim().toLowerCase();
  const filteredRows = rows.filter(row => {
    const rowStatus = String(valueFor(row, ["status", "booking_status"]) || "").trim().toLowerCase();
    if (statusFilter !== "all" && rowStatus !== statusFilter) return false;
    if (!searchTerm) return true;
    const searchable = [
      recordId(row, ["booking_id", "id"]), rowStatus,
      bookingDriverForRow(row),
      bookingLocationForRow(row, "pickup"), bookingLocationForRow(row, "dropoff"),
    ].join(" ").toLowerCase();
    return searchable.includes(searchTerm);
  });
  const isLocallyFiltered = Boolean(searchTerm) || statusFilter !== "all";
  const resultCount = isLocallyFiltered ? filteredRows.length : (total ?? rows.length);
  return <section className="panel ride-bookings-panel">
    <div className="manual-panel-head ride-panel-head"><PanelTitle title="Bookings" subtitle="See the assigned driver, review confirmed rides, and update trip progress" icon={Route}/><RefreshButton onClick={reload} busy={busy}/></div>
    <div className="ride-list-toolbar">
      <div className="ride-list-filters">
        <label className="manual-field ride-search-field"><span>Find a booking</span><input type="search" value={search} onChange={event => { setSearch(event.target.value); setPage(1); }} placeholder="Booking ID, driver, or pickup location" aria-label="Search bookings"/></label>
        <Field label="Status"><select value={statusFilter} onChange={event => { setStatusFilter(event.target.value); setPage(1); }}><option value="all">All statuses</option>{statusOptions.map(option => <option key={option} value={option}>{displayDriverName(option.replaceAll("_", " "))}</option>)}</select></Field>
      </div>
      <div className="ride-result-count"><strong>{resultCount}</strong><span>{isLocallyFiltered ? "matches on this page" : "bookings"}</span><small>{busy && !rows.length ? "Completed: —" : `Completed: ${completedBookingCount}`}</small></div>
    </div>
    {error && <Feedback message={error} error/>}
    {busy ? <div className="loading-row ride-loading">Loading bookings...</div> : filteredRows.length === 0 ? <div className="ride-empty-state"><span><Route size={20}/></span><b>{isLocallyFiltered ? "No bookings match these filters" : "No bookings found"}</b><p>Try another booking ID, location, or status.</p></div> : <DataTable rows={filteredRows} page={page} perPage={perPage} idKeys={["booking_id", "id"]} selectedId={selected ? recordId(selected, ["booking_id", "id"]) : ""} onRowSelect={row => { setSelected(row); const allowed = Array.isArray(row?.allowed_next_statuses) ? row.allowed_next_statuses : null; setStatus(allowed && allowed.length ? String(allowed[0]) : "en_route"); setMessage(""); }} onDetails={row => { const id = recordId(row, ["booking_id", "id"]); if (id) onOpenBooking?.(id); }} detailDisabled={row => !recordId(row, ["booking_id", "id"])} columns={[
      { label: "S. No.", value: (_, index, currentPage, pageSize) => (currentPage - 1) * pageSize + index + 1 },
      { label: "Booking ID", value: row => firstValue(row, ["booking_id", "id"]) },
      { label: "Driver", value: bookingDriverForRow },
      { label: "Customer", value: bookingCustomerName },
      { label: "Status", value: row => valueFor(row, ["status", "booking_status"]), render: row => <RideStatusBadge value={valueFor(row, ["status", "booking_status"])} /> },
      { label: "Pickup", value: row => bookingLocationForRow(row, "pickup") },
      { label: "Drop-off", value: row => bookingLocationForRow(row, "dropoff") },
      { label: "Pickup time", value: row => formatDateTime(firstValue(row, ["pickup_at"])) },
      { label: "Created", value: row => formatDateTime(firstValue(row, ["created_at", "pickup_at"])) },
    ]}/>}
    <div className="ride-pagination"><span>Page {page}{total != null ? ` (${total} total)` : ""}</span><div className="queue-pagination"><button className="btn secondary" type="button" disabled={busy || page <= 1} onClick={() => setPage(current => Math.max(1, current - 1))}>Previous</button><button className="btn secondary" type="button" disabled={busy || !hasNext} onClick={() => setPage(current => current + 1)}>Next</button></div></div>
    {selected && <form className="manual-form compact-form ride-status-form" onSubmit={submit}><Field label={`New status for booking ${recordId(selected, ["booking_id", "id"])}`}><select value={status} onChange={e => setStatus(e.target.value)}>{Array.isArray(selected?.allowed_next_statuses) && selected.allowed_next_statuses.length ? selected.allowed_next_statuses.map(option => <option key={String(option)} value={String(option)}>{displayDriverName(String(option).replaceAll("_", " "))}</option>) : [<option key="en_route" value="en_route">En route</option>, <option key="arrived" value="arrived">Arrived</option>, <option key="in_progress" value="in_progress">In progress</option>, <option key="completed" value="completed">Completed</option>]}</select></Field><Feedback message={message} error={actionError}/><SubmitButton busy={saving}>Update booking</SubmitButton></form>}
  </section>;
}
function RideRequestsPanel({ customerName, customerPhone, onDetails, onCountChange }) {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const perPage = 20;
  const { rows, busy, error, reload, total, hasMore } = useList("/api/v1/admin/ride-requests", { page, per_page: perPage });
  useEffect(() => { onCountChange?.(busy && !rows.length ? null : (total ?? rows.length)); }, [busy, rows.length, total, onCountChange]);
  const statusOptions = [...new Set(rows.map(row => String(firstValue(row, ["status", "request_status"]) || "").trim()).filter(status => status && status !== "-"))];
  const term = search.trim().toLowerCase();
  const filteredRows = rows.filter(row => {
    const status = String(firstValue(row, ["status", "request_status"]) || "").toLowerCase();
    if (statusFilter !== "all" && status !== statusFilter) return false;
    if (!term) return true;
    const searchable = [customerName(row), customerPhone(row), status, bookingLocation(row, "pickup"), bookingLocation(row, "dropoff"), recordId(row, ["ride_request_id", "request_id", "id"])].join(" ").toLowerCase();
    return searchable.includes(term);
  });
  const filteredLocally = Boolean(term) || statusFilter !== "all";
  const resultCount = filteredLocally ? filteredRows.length : (total ?? rows.length);
  const hasNext = hasMore != null ? hasMore : (total != null ? page * perPage < total : rows.length >= perPage);
  return <section className="panel ride-requests-panel">
    <div className="manual-panel-head ride-panel-head"><PanelTitle title="Ride requests" subtitle="Review customer requests and inspect route details" icon={MessageSquare}/><RefreshButton onClick={reload} busy={busy}/></div>
    <div className="ride-list-toolbar">
      <div className="ride-list-filters">
        <label className="manual-field ride-search-field"><span>Find a request</span><input type="search" value={search} onChange={event => { setSearch(event.target.value); setPage(1); }} placeholder="Customer, route, phone, or request ID" aria-label="Search ride requests"/></label>
        <Field label="Status"><select value={statusFilter} onChange={event => { setStatusFilter(event.target.value); setPage(1); }}><option value="all">All statuses</option>{statusOptions.map(option => <option key={option} value={option.toLowerCase()}>{displayDriverName(option.replaceAll("_", " "))}</option>)}</select></Field>
      </div>
      <div className="ride-result-count"><strong>{resultCount}</strong><span>{filteredLocally ? "matches on this page" : "requests"}</span></div>
    </div>
    {error && <Feedback message={error} error/>}
    {busy ? <div className="loading-row ride-loading">Loading ride requests...</div> : filteredRows.length === 0 ? <div className="ride-empty-state"><span><MessageSquare size={20}/></span><b>{filteredLocally ? "No requests match these filters" : "No ride requests found"}</b><p>Try another customer, route, phone number, or status.</p></div> : <DataTable rows={filteredRows} page={page} perPage={perPage} idKeys={["ride_request_id", "request_id", "id"]} onDetails={onDetails} detailDisabled={row => !recordId(row, ["ride_request_id", "request_id", "id"])} columns={[
      { label: "S. No.", value: (_, index, currentPage, pageSize) => (currentPage - 1) * pageSize + index + 1 },
      { label: "Customer", value: customerName, render: row => <div className="ride-customer-cell"><strong>{customerName(row)}</strong><small>{customerPhone(row) === "-" ? "Phone unavailable" : customerPhone(row)}</small></div> },
      { label: "Status", value: row => firstValue(row, ["status", "request_status"]), render: row => <RideStatusBadge value={firstValue(row, ["status", "request_status"])} /> },
      { label: "Pickup", value: row => bookingLocation(row, "pickup") || locationText(valueFor(row, ["pickup_label", "pickup", "origin"])) },
      { label: "Drop-off", value: row => bookingLocation(row, "dropoff") || locationText(valueFor(row, ["dropoff_label", "dropoff", "destination"])) },
      { label: "Requested", value: row => formatDateTime(firstValue(row, ["requested_at", "pickup_at", "created_at", "submitted_at"])) },
    ]}/>}
    <div className="ride-pagination"><span>Page {page}{total != null ? ` (${total} total)` : ""}</span><div className="queue-pagination"><button className="btn secondary" type="button" disabled={busy || page <= 1} onClick={() => setPage(current => Math.max(1, current - 1))}>Previous</button><button className="btn secondary" type="button" disabled={busy || !hasNext} onClick={() => setPage(current => current + 1)}>Next</button></div></div>
  </section>;
}

function RidesPage({ onOpenBooking }) {
  const [customers, setCustomers] = useState([]);
  const [customersError, setCustomersError] = useState("");
  const [selectedRideRequest, setSelectedRideRequest] = useState(null);
  const [activeRidesTab, setActiveRidesTab] = useState("bookings");
  const [rideCounts, setRideCounts] = useState({ bookings: null, requests: null });
  const reportBookingCount = useCallback(count => setRideCounts(current => current.bookings === count ? current : { ...current, bookings: count }), []);
  const reportRequestCount = useCallback(count => setRideCounts(current => current.requests === count ? current : { ...current, requests: count }), []);
  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    async function loadCustomers() {
      const allCustomers = [];
      try {
        for (let page = 1; page <= 1000 && !cancelled; page += 1) {
          const response = await api.get("/api/v1/admin/customers", {
            params: { page, per_page: 100 },
            signal: controller.signal,
          });
          const batch = recordsFrom(response.data);
          allCustomers.push(...batch);
          if (batch.length < 100) break;
        }
        if (!cancelled) {
          setCustomers(allCustomers);
          setCustomersError("");
        }
      } catch (error) {
        if (!cancelled) setCustomersError(formatError(error));
      }
    }
    loadCustomers();
    return () => { cancelled = true; controller.abort(); };
  }, []);

  const customerMap = useMemo(() => {
    const map = new Map();
    for (const customer of customers) {
      for (const key of ["id", "customer_id", "user_id"]) {
        const id = customer?.[key];
        if (id !== undefined && id !== null && String(id).trim()) map.set(String(id), customer);
      }
    }
    return map;
  }, [customers]);

  function rideRequestCustomerName(row) {
    const customerId = row?.customer_id ?? row?.user_id ?? row?.customer?.customer_id ?? row?.customer?.id ?? row?.customer?.user_id ?? row?.user?.customer_id ?? row?.user?.id;
    const customer = (customerId !== undefined && customerId !== null ? customerMap.get(String(customerId)) : null) || row?.customer || null;
    const name = customer?.full_name || customer?.name || customer?.display_name || customer?.customer_name || row?.customer_name || row?.customer?.full_name || row?.customer?.name || row?.customer?.display_name || row?.user?.full_name || row?.user?.name || row?.rider?.name || row?.passenger_name || row?.contact_name;
    if (name) return name;
    const phone = customer?.phone || customer?.phone_number || customer?.mobile || row?.customer?.phone || row?.phone || row?.customer_phone || row?.user?.phone || row?.rider?.phone;
    if (phone) return phone;
    return customerId !== undefined && customerId !== null
      ? `Customer (${String(customerId).slice(0, 6)})`
      : "Unknown";
  }

  function rideRequestCustomerPhone(row) {
    const customerId = row?.customer_id ?? row?.user_id ?? row?.customer?.customer_id ?? row?.customer?.id ?? row?.customer?.user_id ?? row?.user?.customer_id ?? row?.user?.id;
    const customer = (customerId !== undefined && customerId !== null ? customerMap.get(String(customerId)) : null) || row?.customer || null;
    return customer?.phone_number || customer?.phone || customer?.mobile_number || customer?.mobile
      || row?.customer_phone || row?.phone_number || row?.phone || row?.contact_phone
      || row?.user?.phone_number || row?.user?.phone || row?.rider?.phone || "-";
  }

  function rideRequestDetailFields(row) {
    const requestId = valueFor(row, ["ride_request_id", "request_id", "id"]);
    const requestedAt = valueFor(row, ["requested_at", "created_at", "pickup_at", "submitted_at"]);
    const primaryFields = [
      ["Request ID", requestId],
      ["Customer", rideRequestCustomerName(row)],
      ["Phone number", rideRequestCustomerPhone(row)],
      ["Status", valueFor(row, ["status", "request_status"])],
      ["Pickup", bookingLocation(row, "pickup") || locationText(valueFor(row, ["pickup_label", "pickup_address", "origin", "pickup"]))],
      ["Drop-off", bookingLocation(row, "dropoff") || locationText(valueFor(row, ["dropoff_label", "dropoff_address", "destination", "dropoff"]))],
      ["Requested date/time", valueIsPresent(requestedAt) ? formatDateTime(requestedAt) : undefined],
      ["Passenger count", valueFor(row, ["passenger_count", "passengers", "seats_requested"])],
      ["Vehicle category", valueFor(row, ["vehicle_category", "taxi_category", "category"])],
    ].filter(([, value]) => valueIsPresent(value) && value !== "-");
    const primaryKeys = new Set([
      "requestid", "riderequestid", "callbackrequestid", "id", "customerid", "userid", "name", "customername", "fullname", "displayname",
      "phone", "phonenumber", "customerphone", "contactphone", "status", "requeststatus", "pickup", "pickuplabel", "pickupaddress", "origin",
      "dropoff", "dropofflabel", "dropoffaddress", "destination", "createdat", "requestedat", "pickupat", "submittedat",
      "passengercount", "passengers", "seatsrequested", "vehiclecategory", "taxicategory", "category",
    ]);
    const additionalFields = detailEntries(row).filter(([label]) => {
      const normalizedLabel = normalizedKey(label.split(" / ").at(-1));
      return !primaryKeys.has(normalizedLabel) && !/snapshot/i.test(label)
        && !/^(pickup|drop.?off|origin|destination)\b/i.test(label);
    });
    return { primaryFields, additionalFields, requestId };
  }

  const selectedRequestDetails = selectedRideRequest ? rideRequestDetailFields(selectedRideRequest) : null;

  if (selectedRideRequest && selectedRequestDetails) {
    return <div className="manual-stack rides-detail-page">
      <div className="manual-panel-head driver-details-toolbar">
        <button type="button" className="btn secondary" onClick={() => { setSelectedRideRequest(null); window.scrollTo(0, 0); }}><ArrowLeft size={15}/> Back to Ride Requests</button>
      </div>
      <PageHeading title="Ride request details" description="Review the customer, route, and request information."/>
      <section className="panel">
        <PanelTitle title="Request information" subtitle={`Request ID: ${selectedRequestDetails.requestId || "-"}`} icon={Route}/>
        <dl className="profile-grid driver-detail-grid">
          {selectedRequestDetails.primaryFields.map(([label, value]) => <div className="profile-field" key={label}><dt>{label}</dt><dd>{formatCell(value)}</dd></div>)}
        </dl>
        {selectedRequestDetails.additionalFields.length > 0 && <details className="driver-extra-details">
          <summary>Other request details</summary>
          <dl className="profile-grid driver-detail-grid">
            {selectedRequestDetails.additionalFields.map(([label, value]) => {
              const isDate = /(?:_at|\bat\b|date|time)$/i.test(label);
              const displayValue = isDate && valueIsPresent(value) ? formatDateTime(value) : formatCell(value);
              return <div className="profile-field" key={label}><dt>{label}</dt><dd>{displayValue}</dd></div>;
            })}
          </dl>
        </details>}
      </section>
    </div>;
  }

  return <div className="manual-stack rides-page">
    <section className="panel rides-workspace">
      <div className="communications-inbox-toolbar rides-inbox-toolbar">
        <div className="communications-tabs rides-tabs" role="tablist" aria-label="Ride operations">
          <button type="button" role="tab" id="rides-tab-bookings" aria-controls="rides-panel-bookings" aria-selected={activeRidesTab === "bookings"} className={activeRidesTab === "bookings" ? "active" : ""} onClick={() => setActiveRidesTab("bookings")}><Route size={15}/> Bookings <span>{rideCounts.bookings ?? "-"}</span></button>
          <button type="button" role="tab" id="rides-tab-requests" aria-controls="rides-panel-requests" aria-selected={activeRidesTab === "requests"} className={activeRidesTab === "requests" ? "active" : ""} onClick={() => setActiveRidesTab("requests")}><MessageSquare size={15}/> Ride requests <span>{rideCounts.requests ?? "-"}</span></button>
        </div>
      </div>
      {customersError && <div className="rides-customer-error"><Feedback message={`Could not load customer names: ${customersError}`} error/></div>}
      <div className="rides-tab-panel" id="rides-panel-bookings" role="tabpanel" aria-labelledby="rides-tab-bookings" hidden={activeRidesTab !== "bookings"}>
        <BookingManager onOpenBooking={onOpenBooking} onCountChange={reportBookingCount} customers={customers}/>
      </div>
      <div className="rides-tab-panel" id="rides-panel-requests" role="tabpanel" aria-labelledby="rides-tab-requests" hidden={activeRidesTab !== "requests"}>
        <RideRequestsPanel customerName={rideRequestCustomerName} customerPhone={rideRequestCustomerPhone} onCountChange={reportRequestCount} onDetails={row => { setSelectedRideRequest(row); window.scrollTo(0, 0); }}/>
      </div>
    </section>
    <p className="rides-capability-note">Booking status updates are available through the admin API. Ride requests can be reviewed, but the API does not expose delete actions.</p>
  </div>;
}
function findValueDeep(row, wantedNames) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return undefined;
  const wanted = wantedNames.map(n => String(n).toLowerCase().replace(/[^a-z0-9]/g, ""));
  function visit(value, depth) {
    if (!value || typeof value !== "object" || depth > 6) return undefined;
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = visit(item, depth + 1);
        if (found !== undefined) return found;
      }
      return undefined;
    }
    // First, recurse into nested objects to find leaf-level fields
    for (const val of Object.values(value)) {
      if (val && typeof val === "object" && !Array.isArray(val)) {
        const found = visit(val, depth + 1);
        if (found !== undefined) return found;
      }
    }
    // Then check direct keys (only return primitives, not objects)
    for (const [key, val] of Object.entries(value)) {
      const keyNorm = String(key).toLowerCase().replace(/[^a-z0-9]/g, "");
      if (wanted.includes(keyNorm) && valueIsPresent(val) && typeof val !== "object") return val;
    }
    return undefined;
  }
  return visit(row, 0);
}

function callbackCustomerName(row) {
  const name = valueFor(row, [
    "customer_name", "customer.full_name", "customer.fullName", "customer.name", "customer.display_name",
    "requester_name", "requester.full_name", "requester.name",
    "user.full_name", "user.name", "user.display_name",
    "full_name", "display_name", "contact_name",
  ]);
  if (valueIsPresent(name) && typeof name !== "object") return String(name);
  const phone = valueFor(row, ["phone_number", "phone", "customer_phone", "mobile_number", "mobile", "contact_phone", "contact_number", "msisdn"]);
  if (valueIsPresent(phone)) return String(phone);
  const id = valueFor(row, ["customer_id", "user_id", "requester_id", "id"]);
  return id != null ? `Customer (${String(id).slice(0, 6)})` : "Unknown";
}

function callbackPhone(row) {
  return firstValue(row, ["phone_number", "phone", "customer_phone", "mobile_number", "mobile", "contact_phone", "contact_number", "msisdn", "user_phone", "requester_phone", "customer.phone", "customer.phone_number", "user.phone", "user.phone_number"]) ?? "-";
}

function callbackStatus(row) {
  return firstValue(row, ["status", "callback_status", "request_status", "state", "callback_state"]) ?? "-";
}

function callbackDriverId(row) {
  return valueFor(row, ["driver_id", "requested_driver_id", "recipient_driver_id", "requested_to_driver_id", "assigned_driver_id", "driver.id", "recipient_driver.id", "recipient.id", "requested_to.id", "conversation.driver_id", "conversation.driver.id"]);
}

function callbackRideRequestId(row) {
  return valueFor(row, ["ride_request_id", "ride_request.id", "ride_request.request_id", "booking.ride_request_id"]);
}

function findNameInObject(obj, depth = 0) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj) || depth > 3) return undefined;
  const nameKeys = ["name", "full_name", "fullName", "display_name", "displayName", "customer_name", "customerName", "first_name", "firstName", "last_name", "lastName", "contact_name", "contactName"];
  for (const [key, value] of Object.entries(obj)) {
    const normalizedKey = String(key).toLowerCase().replace(/[^a-z0-9]/g, "");
    if (nameKeys.some(nk => normalizedKey === nk.toLowerCase().replace(/[^a-z0-9]/g, "")) && valueIsPresent(value) && typeof value !== "object") {
      return String(value);
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const found = findNameInObject(value, depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

function communicationsCustomerInfo(row, customerDetails, kind = "conversation") {
  const customerId = valueFor(row, ["customer_id", "user_id", "requester_id", "customer.id", "user.id"]);
  const detail = customerId == null ? null : customerDetails[String(customerId)];
  const nameKeys = kind === "callback"
    ? ["customer_name", "customer.full_name", "customer.name", "customer.display_name", "requester_name", "requester.full_name", "requester.name", "user.full_name", "user.name", "full_name", "display_name", "contact_name"]
    : ["customer_name", "customer.full_name", "customer.name", "customer.display_name", "user.full_name", "user.name", "user.display_name", "full_name", "display_name", "contact_name"];
  const phoneKeys = ["phone_number", "phone", "customer_phone", "contact_phone", "customer.phone", "customer.phone_number", "user.phone", "user.phone_number", "mobile", "mobile_number"];
  let name = valueFor(row, nameKeys) ?? valueFor(detail, ["display_name", "full_name", "name", "customer_name"]);
  if (!valueIsPresent(name) && detail) {
    name = findNameInObject(detail);
  }
  const phone = valueFor(row, phoneKeys) ?? valueFor(detail, ["phone", "phone_number", "mobile", "mobile_number"]) ?? findPhoneValue(detail);
  return {
    name: valueIsPresent(name) && typeof name !== "object" ? String(name) : "",
    phone: valueIsPresent(phone) && typeof phone !== "object" ? String(phone) : "",
    id: customerId == null ? "" : String(customerId),
  };
}

function communicationsCustomerSummary(row, customerDetails, kind = "conversation") {
  const customer = communicationsCustomerInfo(row, customerDetails, kind);
  const displayName = customer.name || "Customer";
  const secondary = customer.phone || (customer.id ? `ID ${customer.id.slice(0, 8)}` : "");
  return secondary ? `${displayName} · ${secondary}` : displayName;
}

function messageSender(row) {
  const value = valueFor(row, [
    "sender_name", "sender.full_name", "sender.name", "sender.display_name",
    "customer_name", "customer.full_name", "customer.name",
    "user.full_name", "user.name", "driver.full_name", "driver.name",
  ]);
  return value == null || typeof value === "object" ? "-" : String(value);
}

function messageText(row) {
  const value = valueFor(row, ["text", "message.text", "message", "body", "content"]);
  if (value && typeof value === "object") {
    const nested = valueFor(value, ["text", "body", "content"]);
    return nested == null || typeof nested === "object" ? "-" : String(nested);
  }
  return value == null ? "-" : String(value);
}

function messageTime(row) {
  return valueFor(row, ["created_at", "sent_at", "timestamp", "createdAt"]) || "";
}

function CommunicationsPage() {
  const [activeCommunicationsTab, setActiveCommunicationsTab] = useState("callbacks");
  const [communicationsSearch, setCommunicationsSearch] = useState("");
  const [callbackPage, setCallbackPage] = useState(1);
  const [conversationPage, setConversationPage] = useState(1);
  const communicationsPerPage = 10;
  const callbackList = useList("/api/v1/admin/callback-requests", { page: callbackPage, per_page: communicationsPerPage });
  const conversationList = useList("/api/v1/admin/conversations", { page: conversationPage, per_page: communicationsPerPage });
  const [communicationCustomers, setCommunicationCustomers] = useState({});
  const [communicationDrivers, setCommunicationDrivers] = useState({});
  const [communicationRideRequests, setCommunicationRideRequests] = useState({});
  const requestedCustomerIdsRef = useRef(new Set());
  const requestedDriverIdsRef = useRef(new Set());
  const requestedRideRequestIdsRef = useRef(new Set());
  const [selectedConversation, setSelectedConversation] = useState(null);
  const [conversationMessages, setConversationMessages] = useState([]);
  const [messagesBusy, setMessagesBusy] = useState(false);
  const [newMessage, setNewMessage] = useState("");
  const [callbackPhoneInput, setCallbackPhoneInput] = useState("");
  const [callbackNoteInput, setCallbackNoteInput] = useState("");
  const [callbackBusy, setCallbackBusy] = useState(false);
  const [messageError, setMessageError] = useState("");
  const [callbackError, setCallbackError] = useState("");
  const [callbackSuccess, setCallbackSuccess] = useState("");
  const [sharedLocation, setSharedLocation] = useState(null);
  const [locationBusy, setLocationBusy] = useState(false);
  const [locationError, setLocationError] = useState("");
  const [locationLatitude, setLocationLatitude] = useState("");
  const [locationLongitude, setLocationLongitude] = useState("");
  const [locationShareBusy, setLocationShareBusy] = useState(false);
  const [locationShareError, setLocationShareError] = useState("");
  const [locationShareSuccess, setLocationShareSuccess] = useState("");
  const messagesRequestRef = useRef(0);
  const locationRequestRef = useRef(0);

  const conversationId = selectedConversation
    ? valueFor(selectedConversation, ["conversation_id", "id"])
    : null;

  useEffect(() => {
    const sourceRows = [...callbackList.rows, ...conversationList.rows, ...Object.values(communicationRideRequests).filter(row => row && typeof row === "object")];
    const customerIds = [...new Set(sourceRows.map(row => String(valueFor(row, ["customer_id", "user_id", "requester_id", "customer.id", "user.id"]) ?? "").trim()).filter(Boolean))]
      .filter(id => !requestedCustomerIdsRef.current.has(id));
    customerIds.forEach(id => requestedCustomerIdsRef.current.add(id));
    let next = 0;
    async function loadCustomerDetails() {
      while (next < customerIds.length) {
        const id = customerIds[next++];
        try {
          const response = await api.get(`/api/v1/admin/customers/${encodeURIComponent(id)}`);
          setCommunicationCustomers(current => ({ ...current, [id]: unwrappedRecord(response.data) }));
        } catch {
          setCommunicationCustomers(current => ({ ...current, [id]: null }));
        }
      }
    }
    Promise.all(Array.from({ length: Math.min(4, customerIds.length) }, () => loadCustomerDetails()));
  }, [callbackList.rows, conversationList.rows, communicationRideRequests]);

  useEffect(() => {
    const communicationRows = [...conversationList.rows, ...callbackList.rows];
    const driverIds = [...new Set(communicationRows.map(row => String(valueFor(row, ["driver_id"]) ?? callbackDriverId(row) ?? "").trim()).filter(Boolean))];
    driverIds.forEach(id => {
      if (requestedDriverIdsRef.current.has(id)) return;
      requestedDriverIdsRef.current.add(id);
      api.get(`/api/v1/admin/drivers/${encodeURIComponent(id)}`)
        .then(response => setCommunicationDrivers(current => ({ ...current, [id]: unwrappedRecord(response.data) })))
        .catch(() => setCommunicationDrivers(current => ({ ...current, [id]: null })));
    });

    const requestIds = [...new Set([
      ...conversationList.rows.map(row => valueFor(row, ["request_id", "ride_request_id"])),
      ...callbackList.rows.map(callbackRideRequestId),
    ].map(id => String(id ?? "").trim()).filter(Boolean))];
    const pendingRequestIds = requestIds.filter(id => !requestedRideRequestIdsRef.current.has(id));
    pendingRequestIds.forEach(id => requestedRideRequestIdsRef.current.add(id));
    if (!pendingRequestIds.length) return;

    const unresolved = new Set(pendingRequestIds);
    async function loadRideRequestDetails() {
      try {
        for (let page = 1; page <= 1000 && unresolved.size; page += 1) {
          const response = await api.get("/api/v1/admin/ride-requests", { params: { page, per_page: 100 } });
          const rows = recordsFrom(response.data);
          rows.forEach(row => {
            const id = recordId(row, ["ride_request_id", "request_id", "id"]);
            if (!unresolved.has(id)) return;
            unresolved.delete(id);
            setCommunicationRideRequests(current => ({ ...current, [id]: row }));
          });
          const total = countFromPayload(response.data);
          const hasMore = hasMoreFromPayload(response.data);
          if (!rows.length || hasMore === false || rows.length < 100 || (total != null && page * 100 >= total)) break;
        }
      } catch {
        // Keep the conversation list usable when ride-request details are unavailable.
      } finally {
        unresolved.forEach(id => setCommunicationRideRequests(current => ({ ...current, [id]: null })));
      }
    }
    loadRideRequestDetails();
  }, [callbackList.rows, conversationList.rows, communicationRideRequests]);

  async function loadMessages(id = conversationId) {
    if (!id) return;
    const requestId = ++messagesRequestRef.current;
    setMessagesBusy(true); setMessageError("");
    try {
      const response = await api.get(`/api/v1/conversations/${encodeURIComponent(id)}/messages`);
      if (requestId !== messagesRequestRef.current) return;
      const rows = recordsFrom(response.data);
      setConversationMessages(rows);
    } catch (err) {
      if (requestId === messagesRequestRef.current) setMessageError(err?.response?.status === 404
        ? "This conversation could not be found. Go back, refresh the conversation list, and open it again."
        : formatError(err));
    } finally {
      if (requestId === messagesRequestRef.current) setMessagesBusy(false);
    }
  }

  async function loadSharedLocation(id = conversationId) {
    if (!id) return;
    const requestId = ++locationRequestRef.current;
    setLocationBusy(true); setLocationError("");
    try {
      const response = await api.get(`/api/v1/conversations/${encodeURIComponent(id)}/location`);
      if (requestId !== locationRequestRef.current) return;
      const payload = response.data?.data ?? response.data;
      const record = payload?.location ?? payload?.shared_location ?? payload;
      const location = record && typeof record === "object" && !Array.isArray(record) ? record : null;
      setSharedLocation(location);
      if (location) {
        const latitude = valueFor(location, ["latitude", "lat"]);
        const longitude = valueFor(location, ["longitude", "lng", "lon"]);
        if (latitude != null) setLocationLatitude(String(latitude));
        if (longitude != null) setLocationLongitude(String(longitude));
      }
    } catch (err) {
      if (requestId !== locationRequestRef.current) return;
      if (err?.response?.status === 404) {
        setSharedLocation(null);
        setLocationError("");
      } else {
        setLocationError(formatError(err));
      }
    } finally {
      if (requestId === locationRequestRef.current) setLocationBusy(false);
    }
  }

  async function sendMessage(e) {
    e.preventDefault();
    let payload;
    try {
      payload = createConversationMessagePayload(newMessage);
    } catch (validationError) {
      setMessageError(validationError.message);
      return;
    }
    if (!conversationId) return;
    const id = conversationId;
    const requestVersion = messagesRequestRef.current;
    setMessagesBusy(true); setMessageError("");
    try {
      await api.post(`/api/v1/conversations/${encodeURIComponent(id)}/messages`, payload);
      if (requestVersion !== messagesRequestRef.current) return;
      setNewMessage("");
      await loadMessages(id);
      await conversationList.reload();
    } catch (err) {
      if (requestVersion === messagesRequestRef.current) {
        setMessageError(err?.response?.status === 404
          ? "This conversation could not be found. Go back, refresh the conversation list, and open it again."
          : formatError(err));
        setMessagesBusy(false);
      }
    }
  }

  async function requestCallback(e) {
    e.preventDefault();
    if (!callbackPhoneInput.trim()) return;
    if (!conversationId) return;
    setCallbackBusy(true); setCallbackError(""); setCallbackSuccess("");
    try {
      await api.post(`/api/v1/conversations/${encodeURIComponent(conversationId)}/callback-requests`);
      setCallbackPhoneInput("");
      setCallbackNoteInput("");
      setCallbackSuccess("Callback requested successfully.");
      await callbackList.reload();
    } catch (err) {
      setCallbackError(formatError(err));
    } finally {
      setCallbackBusy(false);
    }
  }

  async function shareLocation(e) {
    e.preventDefault();
    if (!conversationId) return;
    const latitude = Number(locationLatitude);
    const longitude = Number(locationLongitude);
    if (!locationLatitude.trim() || !locationLongitude.trim()
      || !Number.isFinite(latitude) || latitude < -90 || latitude > 90
      || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      setLocationShareError("Enter a valid latitude (−90 to 90) and longitude (−180 to 180).");
      setLocationShareSuccess("");
      return;
    }
    const id = conversationId;
    setLocationShareBusy(true); setLocationShareError(""); setLocationShareSuccess("");
    try {
      await api.put(`/api/v1/conversations/${encodeURIComponent(id)}/location`, { is_active: true, latitude, longitude });
      setLocationShareSuccess("Location shared successfully.");
      await loadSharedLocation(id);
    } catch (err) {
      setLocationShareError(formatError(err));
    } finally {
      setLocationShareBusy(false);
    }
  }

  function closeConversation() {
    messagesRequestRef.current += 1;
    locationRequestRef.current += 1;
    setSelectedConversation(null);
    setConversationMessages([]);
    setSharedLocation(null);
    setMessagesBusy(false);
    setLocationBusy(false);
    setNewMessage("");
    setCallbackPhoneInput("");
    setCallbackNoteInput("");
    setLocationLatitude("");
    setLocationLongitude("");
    setMessageError("");
    setCallbackError("");
    setCallbackSuccess("");
    setLocationError("");
    setLocationShareError("");
    setLocationShareSuccess("");
  }

  const activeCommunicationList = activeCommunicationsTab === "callbacks" ? callbackList : conversationList;
  const activeCommunicationPage = activeCommunicationsTab === "callbacks" ? callbackPage : conversationPage;
  const visibleCommunicationRows = activeCommunicationList.rows.filter(row => {
    const id = recordId(row, activeCommunicationsTab === "callbacks"
      ? ["callback_request_id", "request_id", "callback_id", "id"]
      : ["conversation_id", "id"]);
    const context = activeCommunicationsTab === "callbacks"
      ? [communicationsCustomerSummary(row, communicationCustomers, "callback"), callbackDriverName(row), callbackPhone(row), callbackStatus(row), firstValue(row, ["note", "callback_note", "reason"])]
      : [firstValue(row, ["request_id", "ride_request_id", "ride_request.id"]), firstValue(row, ["driver_id"]), conversationCustomerName(row), conversationDriverName(row), firstValue(row, ["created_at"]), firstValue(row, ["updated_at"])];
    return `${id} ${context.join(" ")}`.toLowerCase().includes(communicationsSearch.trim().toLowerCase());
  });
  const activeCommunicationTotal = activeCommunicationList.total ?? activeCommunicationList.rows.length;
  const activeCommunicationStart = activeCommunicationList.rows.length ? (activeCommunicationPage - 1) * communicationsPerPage + 1 : 0;
  const activeCommunicationEnd = activeCommunicationList.rows.length
    ? Math.min(activeCommunicationPage * communicationsPerPage, activeCommunicationTotal > activeCommunicationList.rows.length
      ? activeCommunicationTotal
      : (activeCommunicationPage - 1) * communicationsPerPage + activeCommunicationList.rows.length)
    : 0;
  const activeCommunicationHasNext = activeCommunicationList.hasMore != null
    ? activeCommunicationList.hasMore
    : activeCommunicationList.total != null
      ? activeCommunicationPage * communicationsPerPage < activeCommunicationList.total
      : activeCommunicationList.rows.length >= communicationsPerPage;
  function changeCommunicationsPage(nextPage) {
    if (activeCommunicationsTab === "callbacks") setCallbackPage(nextPage);
    else setConversationPage(nextPage);
  }
  function openConversation(row) {
    const id = recordId(row, ["conversation_id", "id"]);
    if (!id) return;
    setActiveCommunicationsTab("conversations");
    setSelectedConversation(row);
    setConversationMessages([]);
    setSharedLocation(null);
    setNewMessage(""); setCallbackPhoneInput(""); setCallbackNoteInput("");
    setLocationLatitude(""); setLocationLongitude("");
    setMessageError(""); setLocationError(""); setLocationShareError(""); setLocationShareSuccess(""); setCallbackError(""); setCallbackSuccess("");
    window.scrollTo(0, 0);
    loadMessages(id);
    loadSharedLocation(id);
  }

  function conversationDriverName(row) {
    const driverId = valueFor(row, ["driver_id"]);
    const driver = driverId == null ? null : communicationDrivers[String(driverId)];
    const name = personName(row, ["driver", "assigned_driver"], ["driver_name"])
      || personName(driver, ["driver", "user", "profile"], ["display_name", "full_name", "fullName", "name", "driver_name"]);
    return name || (driverId != null && driver === undefined ? "Loading driver…" : "Driver name unavailable");
  }

  function callbackDriverName(row) {
    const requestId = callbackRideRequestId(row);
    const request = requestId == null ? null : communicationRideRequests[String(requestId)];
    const driverId = callbackDriverId(row) ?? valueFor(request, ["driver_id", "requested_driver_id", "assigned_driver_id", "driver.id"]);
    const driver = driverId == null ? null : communicationDrivers[String(driverId)];
    const name = personName(row, ["driver", "recipient_driver", "assigned_driver", "recipient", "requested_to", "conversation.driver"], ["driver_name", "requested_driver_name", "recipient_name", "requested_to_name"])
      || personName(request, ["driver", "recipient_driver", "assigned_driver"], ["driver_name", "requested_driver_name"])
      || personName(driver, ["driver", "user", "profile"], ["display_name", "full_name", "fullName", "name", "driver_name"]);
    return name || (driverId != null && driver === undefined || requestId != null && request === undefined
      ? "Loading driver…"
      : driverId != null ? "Driver name unavailable" : "Driver not provided");
  }

  function conversationCustomerName(row) {
    const requestId = valueFor(row, ["request_id", "ride_request_id"]);
    const request = requestId == null ? null : communicationRideRequests[String(requestId)];
    const directName = personName(row, ["customer", "user", "rider", "passenger", "ride_request.customer", "ride_request.user"], ["customer_name", "requester_name", "passenger_name", "rider_name"])
      || communicationsCustomerInfo(row, communicationCustomers).name;
    const requestName = request && (
      personName(request, ["customer", "user", "rider", "passenger"], ["customer_name", "requester_name", "passenger_name", "rider_name"])
      || communicationsCustomerInfo(request, communicationCustomers).name
    );
    return directName || requestName || (requestId != null && request === undefined ? "Loading customer…" : "Customer name unavailable");
  }

  return <div className="communications-page manual-stack">
    {!selectedConversation && <>
      <div className="communications-summary">
        <article className="communications-summary-card">
          <span className="communications-summary-icon callback"><Phone size={18}/></span>
          <div><small>Callback requests</small><strong>{callbackList.busy && !callbackList.rows.length ? "—" : callbackList.total ?? callbackList.rows.length}</strong><span>Requests in the admin queue</span></div>
        </article>
        <article className="communications-summary-card">
          <span className="communications-summary-icon conversation"><MessageSquare size={18}/></span>
          <div><small>Conversations</small><strong>{conversationList.busy && !conversationList.rows.length ? "—" : conversationList.total ?? conversationList.rows.length}</strong><span>Customer conversations available</span></div>
        </article>
        <div className="communications-summary-note"><b>Communications workspace</b><span>Review callback requests and see the customers, drivers, and rides linked to each conversation.</span></div>
      </div>
      <section className="panel communications-inbox">
        <div className="communications-inbox-toolbar">
          <div className="communications-tabs" role="tablist" aria-label="Communication queues">
            <button type="button" role="tab" aria-selected={activeCommunicationsTab === "callbacks"} className={activeCommunicationsTab === "callbacks" ? "active" : ""} onClick={() => { setActiveCommunicationsTab("callbacks"); setCommunicationsSearch(""); }}><Phone size={15}/> Callbacks <span>{callbackList.busy && !callbackList.rows.length ? "—" : callbackList.total ?? callbackList.rows.length}</span></button>
            <button type="button" role="tab" aria-selected={activeCommunicationsTab === "conversations"} className={activeCommunicationsTab === "conversations" ? "active" : ""} onClick={() => { setActiveCommunicationsTab("conversations"); setCommunicationsSearch(""); }}><MessageSquare size={15}/> Conversations <span>{conversationList.busy && !conversationList.rows.length ? "—" : conversationList.total ?? conversationList.rows.length}</span></button>
          </div>
          <div className="communications-controls">
            <label className="communications-search"><input aria-label="Search this queue" value={communicationsSearch} onChange={event => setCommunicationsSearch(event.target.value)} placeholder={activeCommunicationsTab === "callbacks" ? "Search customer, driver, phone, status…" : "Search conversation, request, customer, driver…"}/></label>
            <RefreshButton onClick={activeCommunicationList.reload} busy={activeCommunicationList.busy}/>
          </div>
        </div>
        <div className="communications-list-heading">
          <div><h2>{activeCommunicationsTab === "callbacks" ? "Callback requests" : "Conversations"}</h2><p>{activeCommunicationsTab === "callbacks" ? "Follow up on customers who asked to be contacted." : "Each row shows a customer and driver conversation linked to a ride."}</p></div>
          <span className="communications-list-count">{communicationsSearch.trim() ? `${visibleCommunicationRows.length} matching on this page` : activeCommunicationTotal === 1 ? "1 record" : `${activeCommunicationTotal} records`}</span>
        </div>
        <div className="communications-pagination">
          <span>{activeCommunicationTotal ? `Showing ${activeCommunicationStart}–${activeCommunicationEnd} of ${activeCommunicationTotal}` : "No records yet"}</span>
          <div><button className="btn secondary" type="button" disabled={activeCommunicationList.busy || activeCommunicationPage <= 1} onClick={() => changeCommunicationsPage(Math.max(1, activeCommunicationPage - 1))}>Previous</button><button className="btn secondary" type="button" disabled={activeCommunicationList.busy || !activeCommunicationHasNext} onClick={() => changeCommunicationsPage(activeCommunicationPage + 1)}>Next</button></div>
        </div>
        {activeCommunicationList.error && <Feedback message={activeCommunicationList.error} error/>}
        {activeCommunicationList.busy ? <div className="loading-row">Loading {activeCommunicationsTab === "callbacks" ? "callback requests" : "conversations"}…</div> : visibleCommunicationRows.length ? (
          <div className="manual-table-wrap communications-table-wrap"><table className={`manual-table communications-table ${activeCommunicationsTab === "conversations" ? "communications-conversation-table" : "communications-callback-table"}`}>
            <thead><tr>{activeCommunicationsTab === "callbacks"
              ? <><th>#</th><th>Request</th><th>Requested by customer</th><th>Requested to (driver)</th><th>Status</th><th>Note</th><th>Requested</th></>
              : <><th>#</th><th>Conversation</th><th>Ride request</th><th>Customer</th><th>Driver</th><th>Last activity</th></>}</tr></thead>
            <tbody>{visibleCommunicationRows.map((row, index) => {
              const isCallback = activeCommunicationsTab === "callbacks";
              const rowId = recordId(row, isCallback ? ["callback_request_id", "request_id", "callback_id", "id"] : ["conversation_id", "id"]);
              const customerInfo = communicationsCustomerInfo(row, communicationCustomers, isCallback ? "callback" : "conversation");
              const status = isCallback ? callbackStatus(row) : "";
              const normalizedStatus = String(status).toLowerCase().replace(/[^a-z0-9]+/g, "-");
              const note = firstValue(row, ["note", "callback_note", "reason"]);
              const requested = firstValue(row, ["created_at", "requested_at", "submitted_at", "createdAt", "requestedAt", "submittedAt"]);
              const requestId = firstValue(row, ["request_id", "ride_request_id", "ride_request.id", "ride_request.request_id", "request.id"]);
              const lastActivity = firstValue(row, ["updated_at", "updatedAt", "created_at", "createdAt"]);
              return <tr key={rowId || JSON.stringify(row)}>
                <td className="communications-sno">{ (activeCommunicationPage - 1) * communicationsPerPage + index + 1 }</td><td className="communications-id-cell" title={rowId}><span className="communications-row-title">{rowId ? `${rowId.slice(0, 8)}…${rowId.slice(-4)}` : "—"}</span><small>{isCallback ? "Callback request" : "Chat thread"}</small></td>
                {isCallback
                  ? <><td><span className="communications-customer">{customerInfo.name || "Name not returned by API"}</span><small>{customerInfo.phone || "Phone not returned by API"}</small></td><td><span className="communications-customer">{callbackDriverName(row)}</span></td><td><span className={`communications-status status-${normalizedStatus}`}>{status}</span></td><td className="communications-note-cell" title={note === "-" ? "No note" : note}>{note === "-" ? <span className="communications-muted-cell">No note</span> : note}</td><td className="communications-requested-cell">{requested === "-" ? "—" : formatDateTime(requested)}</td></>
                  : <><td className="communications-id-cell" title={requestId}>{shortCommunicationId(requestId)}</td><td><span className="communications-customer">{conversationCustomerName(row)}</span>{customerInfo.phone && <small>{customerInfo.phone}</small>}</td><td><span className="communications-customer">{conversationDriverName(row)}</span></td><td>{lastActivity === "-" ? "—" : formatDateTime(lastActivity)}</td></>}
              </tr>;
            })}</tbody>
          </table></div>
        ) : <div className="communications-empty"><span className="communications-empty-icon">{activeCommunicationsTab === "callbacks" ? <Phone size={20}/> : <MessageSquare size={20}/>}</span><b>{communicationsSearch.trim() ? "No matching records" : activeCommunicationsTab === "callbacks" ? "No callback requests" : "No conversations yet"}</b><p>{communicationsSearch.trim() ? "Try a different search term." : "New records will appear here when the backend receives them."}</p></div>}
      </section>
    </>}
    {selectedConversation && conversationId && (
      <div className="communications-detail-view">
        <div className="manual-panel-head driver-details-toolbar communications-detail-toolbar">
          <button type="button" className="btn secondary" onClick={closeConversation}><ArrowLeft size={15}/> Back to Conversations</button>
          <RefreshButton onClick={loadMessages} busy={messagesBusy}/>
        </div>
        <div className="communications-detail-heading"><div><span>CONVERSATION</span><h2>Conversation {shortCommunicationId(conversationId)}</h2><p>Customer: {conversationCustomerName(selectedConversation)} · Ride request: {firstValue(selectedConversation, ["request_id", "ride_request_id"])} · Driver: {conversationDriverName(selectedConversation)}</p></div><span className="communications-detail-icon"><MessageSquare size={20}/></span></div>
        <div className="panel communications-messages-panel">
          <PanelTitle title="Message history" subtitle="Read and reply in this conversation" icon={MessageSquare}/>
          {messageError && <Feedback message={messageError} error/>}
          {messagesBusy ? <div className="loading-row">Loading messages…</div> : conversationMessages.length ? (
            <div className="message-thread">
              {conversationMessages.map((msg, index) => (
                <div className="message-bubble" key={recordId(msg, ["message_id", "id"]) || `${messageTime(msg)}-${index}`}>
                  <div className="message-meta"><span className="message-from">{messageSender(msg)}</span><span className="message-time">{messageTime(msg) ? formatDateTime(messageTime(msg)) : ""}</span></div>
                  <div className="message-body">{messageText(msg)}</div>
                </div>
              ))}
            </div>
          ) : !messageError ? <div className="communications-thread-empty"><MessageSquare size={22}/><b>No messages yet</b><p>This chat has no messages so far. Write a reply below to start the conversation.</p></div> : null}
        </div>
        <div className="panel communications-composer-panel">
          <PanelTitle title="Reply" subtitle="Send a message to this conversation" icon={MessageSquare}/>
          <form className="manual-form" onSubmit={sendMessage}>
            <Field label={`Message (${newMessage.length}/4000)`}><textarea value={newMessage} onChange={e => { setNewMessage(e.target.value); if (messageError) setMessageError(""); }} rows={3} maxLength={4000} required disabled={messagesBusy} placeholder="Write your reply…"/></Field>
            <SubmitButton busy={messagesBusy} disabled={!newMessage.trim() || Boolean(messageError)}>Send message</SubmitButton>
          </form>
        </div>
        <div className="panel communications-location-panel">
          <div className="manual-panel-head"><PanelTitle title="Shared location" subtitle="Location attached to this conversation" icon={MapPinned}/><RefreshButton onClick={() => loadSharedLocation()} busy={locationBusy}/></div>
          {locationError && <Feedback message={locationError} error/>}
          {locationBusy ? <div className="loading-row">Loading shared location…</div> : sharedLocation ? (
            detailEntries(sharedLocation).length ? <dl className="profile-grid driver-detail-grid">
              {detailEntries(sharedLocation).map(([label, value]) => <div className="profile-field" key={label}><dt>{label}</dt><dd>{formatCell(value)}</dd></div>)}
            </dl> : <p className="muted small">Location data was returned, but it contains no displayable fields.</p>
          ) : <p className="muted small">No shared location is currently available for this conversation.</p>}
          <form className="manual-form compact-form" onSubmit={shareLocation}>
            <Field label="Latitude"><input type="number" min="-90" max="90" step="any" value={locationLatitude} onChange={event => setLocationLatitude(event.target.value)} required placeholder="e.g. 29.6857"/></Field>
            <Field label="Longitude"><input type="number" min="-180" max="180" step="any" value={locationLongitude} onChange={event => setLocationLongitude(event.target.value)} required placeholder="e.g. 76.9905"/></Field>
            {locationShareError && <Feedback message={locationShareError} error/>}
            {locationShareSuccess && <Feedback message={locationShareSuccess}/>}
            <SubmitButton busy={locationShareBusy} disabled={!locationLatitude.trim() || !locationLongitude.trim()}>Share location</SubmitButton>
          </form>
        </div>
        <div className="panel communications-callback-panel">
          <PanelTitle title="Request a callback" subtitle="Ask the customer to call back on a number" icon={Phone}/>
          {callbackError && <Feedback message={callbackError} error/>}
          {callbackSuccess && <Feedback message={callbackSuccess}/>}
          <form className="manual-form" onSubmit={requestCallback}>
            <Field label="Phone number"><input type="tel" value={callbackPhoneInput} onChange={e => setCallbackPhoneInput(e.target.value)} maxLength="32" required placeholder="Customer phone number"/></Field>
            <Field label="Note (optional)"><input value={callbackNoteInput} onChange={e => setCallbackNoteInput(e.target.value)} placeholder="Reason for callback…"/></Field>
            <SubmitButton busy={callbackBusy}>Request callback</SubmitButton>
          </form>
        </div>
      </div>
    )}
  </div>;
}

function PricingPage() {
  const categories = useList("/api/v1/taxi-categories");
  const [activePricingTab, setActivePricingTab] = useState("categories");
  const [selectedCategory, setSelectedCategory] = useState(null);
  const [categoryPage, setCategoryPage] = useState(1);
  const categoriesPerPage = 10;
  const [createdCategoryRows, setCreatedCategoryRows] = useState(() => {
    try {
      if (typeof window === "undefined") return [];
      const saved = JSON.parse(window.sessionStorage.getItem("taxigo_admin_created_taxi_categories") || "[]");
      return Array.isArray(saved) ? saved.filter(row => row && typeof row === "object" && valueIsPresent(firstValue(row, ["code", "category_code"]))) : [];
    } catch { return []; }
  });
  const [couponPage, setCouponPage] = useState(1);
  const couponsPerPage = 5;
  const coupons = useList("/api/v1/admin/coupons", { page: couponPage, per_page: couponsPerPage });
  const [categorySearch, setCategorySearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [couponSearch, setCouponSearch] = useState("");
  const [couponFilter, setCouponFilter] = useState("all");
  const [categorySaving, setCategorySaving] = useState(false);
  const [couponSaving, setCouponSaving] = useState(false);
  const [categoryMessage, setCategoryMessage] = useState("");
  const [categoryError, setCategoryError] = useState(false);
  const [couponMessage, setCouponMessage] = useState("");
  const [couponError, setCouponError] = useState(false);
  const [category, setCategory] = useState({ code: "", display_name: "", legacy_category: "", is_enabled: true, min_rate_paise_per_km: "", max_rate_paise_per_km: "" });
  const [coupon, setCoupon] = useState({ code: "", discount_type: "percent", amount: "", starts_at: "", ends_at: "", minimum_fare_paise: 0, max_discount_paise: "", taxi_category_code: "", funding_model: "platform", settlement_policy: "", is_active: false });
  useEffect(() => {
    try { window.sessionStorage.setItem("taxigo_admin_created_taxi_categories", JSON.stringify(createdCategoryRows)); } catch {}
  }, [createdCategoryRows]);
  useEffect(() => {
    if (!selectedCategory) return undefined;
    const closeOnEscape = event => { if (event.key === "Escape") setSelectedCategory(null); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [selectedCategory]);
  const knownCategoryCodes = new Set(categories.rows.map(row => String(firstValue(row, ["code", "category_code"])).trim().toLowerCase()));
  const allCategoryRows = [...categories.rows];
  for (const row of createdCategoryRows) {
    const code = String(firstValue(row, ["code", "category_code"])).trim().toLowerCase();
    if (code && !knownCategoryCodes.has(code)) {
      allCategoryRows.push(row);
      knownCategoryCodes.add(code);
    }
  }
  const categoryTotal = Math.max(categories.total ?? 0, allCategoryRows.length);
  const normalizedCategoryCode = category.code.trim().toLowerCase();
  const duplicateCategoryCode = Boolean(normalizedCategoryCode) && allCategoryRows.some(row => String(firstValue(row, ["code", "category_code"])).trim().toLowerCase() === normalizedCategoryCode);
  const couponTotal = coupons.total ?? coupons.rows.length;
  const couponStart = coupons.rows.length ? (couponPage - 1) * couponsPerPage + 1 : 0;
  const couponEnd = coupons.rows.length ? couponStart + coupons.rows.length - 1 : 0;
  const couponHasNext = coupons.hasMore != null
    ? coupons.hasMore
    : coupons.total != null
      ? couponPage * couponsPerPage < coupons.total
      : coupons.rows.length >= couponsPerPage;

  function enabledLabel(row, keys = ["is_enabled", "enabled"]) {
    const value = valueFor(row, keys);
    if (value === true || value === 1 || String(value).toLowerCase() === "true" || String(value) === "1") return "Yes";
    if (value === false || value === 0 || String(value).toLowerCase() === "false" || String(value) === "0") return "No";
    return formatCell(value);
  }

  function couponStatus(row) {
    const activeValue = valueFor(row, ["is_active", "active", "status"]);
    const normalized = String(activeValue ?? "").trim().toLowerCase();
    if (["false", "0", "no", "inactive", "disabled", "off"].includes(normalized)) return "inactive";
    const starts = new Date(valueFor(row, ["starts_at", "start_at"]));
    const ends = new Date(valueFor(row, ["ends_at", "end_at"]));
    const now = Date.now();
    if (!Number.isNaN(starts.getTime()) && starts.getTime() > now) return "scheduled";
    if (!Number.isNaN(ends.getTime()) && ends.getTime() < now) return "expired";
    if (["true", "1", "yes", "active", "enabled", "on"].includes(normalized)) return "active";
    return normalized || "unknown";
  }

  function categoryRate(row) {
    const min = valueFor(row, ["min_rate_paise_per_km"]);
    const max = valueFor(row, ["max_rate_paise_per_km"]);
    const base = valueFor(row, ["base_rate_paise_per_km", "rate_paise_per_km", "approved_rate_paise_per_km"]);
    if (min != null && max != null) return Number(min) === Number(max) ? formatCell(min) : `${formatCell(min)} – ${formatCell(max)}`;
    return formatCell(min ?? max ?? base);
  }

  function categoryName(row) {
    const name = firstValue(row, ["display_name", "name", "title"]);
    return name === "-" ? name : displayDriverName(String(name).replace(/_+/g, " "));
  }

  function couponDiscount(row) {
    const amount = valueFor(row, ["amount", "discount_amount"]);
    if (amount == null) return "-";
    const type = String(valueFor(row, ["discount_type", "type"]) ?? "").toLowerCase();
    if (type.includes("percent")) return `${formatCell(amount)}%`;
    return couponMoney(row, ["amount", "discount_amount"]);
  }

  function couponMoney(row, keys) {
    const amount = valueFor(row, keys);
    if (amount == null || amount === "") return "-";
    const numericAmount = Number(amount);
    const currency = valueFor(row, ["currency"]) ?? "INR";
    return Number.isFinite(numericAmount) ? `${currency} ${(numericAmount / 100).toFixed(2)}` : formatCell(amount);
  }

  const normalizedCategorySearch = categorySearch.trim().toLowerCase();
  const filteredCategories = allCategoryRows.filter(row => {
    const enabled = enabledLabel(row).toLowerCase();
    if (categoryFilter === "enabled" && enabled !== "yes") return false;
    if (categoryFilter === "disabled" && enabled !== "no") return false;
    if (!normalizedCategorySearch) return true;
    return [firstValue(row, ["code", "category_code"]), firstValue(row, ["display_name", "name", "title"])]
      .join(" ").toLowerCase().includes(normalizedCategorySearch);
  });
  const categoryPageCount = Math.max(1, Math.ceil(filteredCategories.length / categoriesPerPage));
  const currentCategoryPage = Math.min(categoryPage, categoryPageCount);
  const categoryStart = filteredCategories.length ? (currentCategoryPage - 1) * categoriesPerPage + 1 : 0;
  const categoryEnd = Math.min(currentCategoryPage * categoriesPerPage, filteredCategories.length);
  const visibleCategories = filteredCategories.slice(categoryStart - 1, categoryEnd);
  const normalizedCouponSearch = couponSearch.trim().toLowerCase();
  const filteredCoupons = coupons.rows.filter(row => {
    const status = couponStatus(row);
    if (couponFilter !== "all" && status !== couponFilter) return false;
    if (!normalizedCouponSearch) return true;
    return [firstValue(row, ["code", "coupon_code"]), firstValue(row, ["taxi_category_code", "category_code"])]
      .join(" ").toLowerCase().includes(normalizedCouponSearch);
  });
  const enabledCategoryCount = allCategoryRows.filter(row => enabledLabel(row) === "Yes").length;
  const activeCouponCount = coupons.rows.filter(row => couponStatus(row) === "active").length;

  async function createCategory(e) {
    e.preventDefault(); setCategorySaving(true); setCategoryMessage(""); setCategoryError(false);
    if (duplicateCategoryCode) {
      setCategoryMessage(`Category code “${category.code.trim()}” already exists. Choose a unique code.`);
      setCategoryError(true);
      setCategorySaving(false);
      return;
    }
    const minRate = category.min_rate_paise_per_km === "" ? null : Number(category.min_rate_paise_per_km);
    const maxRate = category.max_rate_paise_per_km === "" ? null : Number(category.max_rate_paise_per_km);
    if (minRate != null && maxRate != null && minRate > maxRate) { setCategoryMessage("Minimum rate cannot be greater than maximum rate."); setCategoryError(true); setCategorySaving(false); return; }
    const body = { ...category, code: category.code.trim(), legacy_category: category.legacy_category || null, min_rate_paise_per_km: minRate, max_rate_paise_per_km: maxRate };
    try {
      const response = await api.post("/api/v1/admin/taxi-categories", body);
      const responseRecord = response.data?.category ?? response.data?.data?.category ?? response.data?.data ?? response.data;
      const createdRecord = { ...body, ...(responseRecord && typeof responseRecord === "object" && !Array.isArray(responseRecord) ? responseRecord : {}) };
      setCreatedCategoryRows(current => {
        const createdCode = String(firstValue(createdRecord, ["code", "category_code"])).trim().toLowerCase();
        return [...current.filter(row => String(firstValue(row, ["code", "category_code"])).trim().toLowerCase() !== createdCode), createdRecord];
      });
      setCategoryMessage("Taxi category created.");
      setCategory({ code: "", display_name: "", legacy_category: "", is_enabled: true, min_rate_paise_per_km: "", max_rate_paise_per_km: "" });
      setCategorySearch("");
      setCategoryFilter("all");
      setCategoryPage(1);
      await categories.reload();
    }
    catch (err) {
      if (Number(err?.response?.status) === 409) {
        const detail = errorText(err).trim();
        const safeDetail = detail && detail.length <= 160 && !/[{}[\]]/.test(detail) && !/(traceback|sqlalchemy|database|internal server error|constraint violation)/i.test(detail);
        setCategoryMessage(safeDetail ? detail : "Category creation was rejected. Check for a duplicate code or a category limit, then try again.");
      } else setCategoryMessage(formatError(err));
      setCategoryError(true);
    }
    finally { setCategorySaving(false); }
  }
  async function createCoupon(e) {
    e.preventDefault(); setCouponSaving(true); setCouponMessage(""); setCouponError(false);
    const policyError = settlementPolicyError(coupon.settlement_policy);
    if (policyError) { setCouponMessage(policyError); setCouponError(true); setCouponSaving(false); return; }
    const startsAt = new Date(coupon.starts_at);
    const endsAt = new Date(coupon.ends_at);
    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()) || endsAt <= startsAt) {
      setCouponMessage("Enter valid coupon dates and make sure the end time is after the start time."); setCouponError(true); setCouponSaving(false); return;
    }
    if (coupon.discount_type === "percent" && (Number(coupon.amount) <= 0 || Number(coupon.amount) > 100)) {
      setCouponMessage("Percent discount must be greater than 0 and no more than 100."); setCouponError(true); setCouponSaving(false); return;
    }
    try {
      const body = { ...coupon, amount: Number(coupon.amount), starts_at: startsAt.toISOString(), ends_at: endsAt.toISOString(), minimum_fare_paise: Number(coupon.minimum_fare_paise), max_discount_paise: coupon.max_discount_paise === "" ? null : Number(coupon.max_discount_paise), taxi_category_code: coupon.taxi_category_code || null, funding_model: coupon.funding_model || null, settlement_policy: coupon.settlement_policy || null };
      await api.post("/api/v1/admin/coupons", body);
      setCouponMessage("Coupon created.");
      setCoupon({ code: "", discount_type: "percent", amount: "", starts_at: "", ends_at: "", minimum_fare_paise: 0, max_discount_paise: "", taxi_category_code: "", funding_model: "platform", settlement_policy: "", is_active: false });
      if (couponPage === 1) await coupons.reload();
      else setCouponPage(1);
    }
    catch (err) { setCouponMessage(formatError(err)); setCouponError(true); }
    finally { setCouponSaving(false); }
  }
  const selectedCategoryDetails = selectedCategory ? detailEntries(selectedCategory) : [];
  return <div className="manual-stack pricing-page">
    <div className="pricing-summary-grid" aria-label="Pricing summary">
      <div className="pricing-summary-card"><span className="pricing-summary-icon blue"><CarFront size={18}/></span><div><small>Taxi categories</small><strong>{categories.busy ? "—" : categoryTotal}</strong><span>Configured vehicle types</span></div></div>
      <div className="pricing-summary-card"><span className="pricing-summary-icon green"><CarFront size={18}/></span><div><small>Enabled categories</small><strong>{categories.busy ? "—" : enabledCategoryCount}</strong><span>From loaded categories</span></div></div>
      <div className="pricing-summary-card"><span className="pricing-summary-icon violet"><Tag size={18}/></span><div><small>Coupons</small><strong>{coupons.busy ? "—" : couponTotal}</strong><span>Configured campaigns</span></div></div>
      <div className="pricing-summary-card"><span className="pricing-summary-icon amber"><Tag size={18}/></span><div><small>Active coupons</small><strong>{coupons.busy ? "—" : activeCouponCount}</strong><span>On the current page</span></div></div>
    </div>
    <div className="pricing-section-nav" role="tablist" aria-label="Pricing sections">
      <button type="button" id="pricing-tab-categories" role="tab" aria-selected={activePricingTab === "categories"} aria-controls="pricing-categories" tabIndex={activePricingTab === "categories" ? 0 : -1} onClick={() => setActivePricingTab("categories")} onKeyDown={event => { if (event.key === "ArrowRight" || event.key === "ArrowLeft") { event.preventDefault(); const next = activePricingTab === "categories" ? "coupons" : "categories"; setActivePricingTab(next); document.getElementById(`pricing-tab-${next}`)?.focus(); } }}><CarFront size={17}/> <span className="pricing-tab-label">Taxi categories</span><span className="pricing-tab-count">{categoryTotal}</span></button>
      <button type="button" id="pricing-tab-coupons" role="tab" aria-selected={activePricingTab === "coupons"} aria-controls="pricing-coupons" tabIndex={activePricingTab === "coupons" ? 0 : -1} onClick={() => setActivePricingTab("coupons")} onKeyDown={event => { if (event.key === "ArrowRight" || event.key === "ArrowLeft") { event.preventDefault(); const next = activePricingTab === "categories" ? "coupons" : "categories"; setActivePricingTab(next); document.getElementById(`pricing-tab-${next}`)?.focus(); } }}><Tag size={17}/> <span className="pricing-tab-label">Coupons</span><span className="pricing-tab-count">{couponTotal}</span></button>
    </div>
    <section className="pricing-section" id="pricing-categories" role="tabpanel" aria-labelledby="pricing-tab-categories" tabIndex={0} hidden={activePricingTab !== "categories"}>
    <div className="pricing-section-layout pricing-categories-layout">
    <div className="panel pricing-panel"><div className="manual-panel-head"><PanelTitle title="Taxi categories" subtitle="Available vehicle types and per-kilometre rates" icon={CarFront}/><RefreshButton onClick={categories.reload} busy={categories.busy}/></div>
      <div className="pricing-toolbar">
        <label className="pricing-search"><Search size={15}/><input type="search" aria-label="Search taxi categories" placeholder="Search code or name" value={categorySearch} onChange={event => { setCategorySearch(event.target.value); setCategoryPage(1); }}/></label>
        <Field label="Availability"><select value={categoryFilter} onChange={event => { setCategoryFilter(event.target.value); setCategoryPage(1); }}><option value="all">All categories</option><option value="enabled">Enabled</option><option value="disabled">Disabled</option></select></Field>
        <div className="pricing-category-controls"><span className="pricing-results-count">{categoryStart}–{categoryEnd} of {filteredCategories.length}</span><div className="queue-pagination"><button className="btn secondary" type="button" disabled={categories.busy || currentCategoryPage <= 1} onClick={() => setCategoryPage(currentCategoryPage - 1)}>Previous</button><button className="btn secondary" type="button" disabled={categories.busy || currentCategoryPage >= categoryPageCount} onClick={() => setCategoryPage(currentCategoryPage + 1)}>Next</button></div></div>
      </div>
      {categories.error && <Feedback message={categories.error} error/>}{categories.busy ? <div className="loading-row">Loading categories…</div> : <DataTable rows={visibleCategories} page={currentCategoryPage} perPage={categoriesPerPage} onDetails={setSelectedCategory} empty={categoryFilter === "disabled" && !normalizedCategorySearch && !allCategoryRows.some(row => enabledLabel(row) === "No") ? "The category API does not return existing disabled categories. Disabled categories created here will appear in this browser session." : allCategoryRows.length ? "No categories match these filters." : "No taxi categories returned by the API."} columns={[
        { label: "No.", render: (_row, _index, _page, _perPage, serial) => <span className="pricing-row-number">{serial}</span> },
        { label: "Code", render: row => { const code = firstValue(row, ["code", "category_code"]); return <span className="pricing-code" title={String(code)}>{code}</span>; } },
        { label: "Name", value: categoryName },
        { label: "Availability", render: row => { const enabled = enabledLabel(row); return <span className={`pricing-badge ${enabled === "Yes" ? "is-enabled" : enabled === "No" ? "is-disabled" : "is-unknown"}`}>{enabled}</span>; } },
        { label: "Rate (paise/km)", value: categoryRate },
      ]}/>}
      <p className="pricing-note">The public category API currently lists enabled categories only and does not expose an admin list, edit, or delete operation. Disabled categories created here are retained in this browser session.</p>
    </div>
    <div className="panel pricing-panel pricing-form-panel"><PanelTitle title="Add taxi category" subtitle="Create a vehicle type for the platform" icon={CarFront}/><form className="manual-form pricing-form" onSubmit={createCategory}>
      <Field label="Category code"><input aria-invalid={duplicateCategoryCode} value={category.code} onChange={e => { setCategory({ ...category, code: e.target.value }); setCategoryMessage(""); setCategoryError(false); }} minLength="2" maxLength="64" pattern="[a-z0-9_]+" required />{duplicateCategoryCode ? <small className="pricing-field-warning" role="alert">This category code already exists. Please enter a unique code.</small> : <small>{categories.busy ? "Checking existing category codes…" : "Use a unique lowercase code, such as mini_6_seater."}</small>}</Field>
      <Field label="Display name"><input value={category.display_name} onChange={e => setCategory({ ...category, display_name: e.target.value })} minLength="2" maxLength="100" required /></Field>
      <Field label="Legacy category"><select value={category.legacy_category} onChange={e => setCategory({ ...category, legacy_category: e.target.value })}><option value="">None</option><option value="sedan">Sedan</option><option value="suv">SUV</option><option value="tempo_traveller">Tempo traveller</option></select></Field>
      <Field label="Minimum rate (paise/km)"><input type="number" min="0" value={category.min_rate_paise_per_km} onChange={e => setCategory({ ...category, min_rate_paise_per_km: e.target.value })}/></Field>
      <Field label="Maximum rate (paise/km)"><input type="number" min="0" value={category.max_rate_paise_per_km} onChange={e => setCategory({ ...category, max_rate_paise_per_km: e.target.value })}/></Field>
      <Field label="Enabled"><select value={String(category.is_enabled)} onChange={e => setCategory({ ...category, is_enabled: e.target.value === "true" })}><option value="true">Yes</option><option value="false">No</option></select></Field>
      <Feedback message={categoryMessage} error={categoryError}/><SubmitButton busy={categorySaving} disabled={categories.busy || duplicateCategoryCode}>Create category</SubmitButton>
    </form></div>
    </div></section>
    <section className="pricing-section" id="pricing-coupons" role="tabpanel" aria-labelledby="pricing-tab-coupons" tabIndex={0} hidden={activePricingTab !== "coupons"}>
    <div className="pricing-section-layout pricing-coupons-layout">
    <div className="panel pricing-panel"><div className="manual-panel-head"><PanelTitle title="Coupons" subtitle="Discount campaigns and validity" icon={Tag}/><RefreshButton onClick={coupons.reload} busy={coupons.busy}/></div>
      <div className="pricing-toolbar pricing-coupon-toolbar">
        <label className="pricing-search"><Search size={15}/><input type="search" aria-label="Search coupons" placeholder="Search code or category" value={couponSearch} onChange={event => setCouponSearch(event.target.value)}/></label>
        <Field label="Coupon status"><select value={couponFilter} onChange={event => setCouponFilter(event.target.value)}><option value="all">All statuses</option><option value="active">Active</option><option value="scheduled">Scheduled</option><option value="expired">Expired</option><option value="inactive">Inactive</option></select></Field>
        <div className="pricing-pagination"><span>{couponStart}–{couponEnd} of {couponTotal}</span><div className="queue-pagination"><button className="btn secondary" type="button" disabled={coupons.busy || couponPage <= 1} onClick={() => setCouponPage(page => Math.max(1, page - 1))}>Previous</button><button className="btn secondary" type="button" disabled={coupons.busy || !couponHasNext} onClick={() => setCouponPage(page => page + 1)}>Next</button></div></div>
      </div>
      <p className="pricing-filter-count">{filteredCoupons.length} {filteredCoupons.length === 1 ? "match" : "matches"} on this page</p>
      {coupons.error && <Feedback message={coupons.error} error/>}{coupons.busy ? <div className="loading-row">Loading coupons…</div> : <DataTable rows={filteredCoupons} empty={coupons.rows.length ? "No coupons match these filters on this page." : "No coupons returned by the API."} page={couponPage} perPage={couponsPerPage} columns={[
        { label: "#", render: (_row, _index, _page, _perPage, serial) => <span className="pricing-row-number">{serial}</span> },
        { label: "Code", render: row => { const code = firstValue(row, ["code", "coupon_code"]); return <span className="pricing-code" title={String(code)}>{code}</span>; } },
        { label: "Discount", value: couponDiscount },
        { label: "Minimum fare", value: row => couponMoney(row, ["minimum_fare_paise"]) },
        { label: "Maximum discount", value: row => couponMoney(row, ["max_discount_paise", "maximum_discount_paise"]) },
        { label: "Category", value: row => firstValue(row, ["taxi_category_code", "category_code"]) },
        { label: "Funding", value: row => firstValue(row, ["funding_model"]) },
        { label: "Validity window", render: row => <span className="pricing-period"><span>{formatDateTime(valueFor(row, ["starts_at", "start_at"]))}</span><small>to {formatDateTime(valueFor(row, ["ends_at", "end_at"]))}</small></span> },
        { label: "Status", render: row => { const status = couponStatus(row); return <span className={`pricing-badge is-${status}`}>{displayDriverName(status)}</span>; } },
      ]}/>}
      <p className="pricing-note">Search and status filters apply to this page of results. Coupon edit and delete operations are not exposed by the API.</p>
    </div>
    <div className="panel pricing-panel pricing-form-panel"><PanelTitle title="Create coupon" subtitle="Set the discount and validity window" icon={Tag}/><form className="manual-form pricing-form" onSubmit={createCoupon}>
      <Field label="Coupon code"><input value={coupon.code} onChange={e => setCoupon({ ...coupon, code: e.target.value })} minLength="2" maxLength="64" pattern="[A-Za-z0-9_-]+" required /></Field>
      <Field label="Discount type"><select value={coupon.discount_type} onChange={e => setCoupon({ ...coupon, discount_type: e.target.value })}><option value="percent">Percent</option><option value="fixed">Fixed amount</option></select></Field>
      <Field label={coupon.discount_type === "percent" ? "Percent" : "Amount (paise)"}><input type="number" min="1" value={coupon.amount} onChange={e => setCoupon({ ...coupon, amount: e.target.value })} required /></Field>
      <Field label="Starts at"><input type="datetime-local" value={coupon.starts_at} onChange={e => setCoupon({ ...coupon, starts_at: e.target.value })} required /></Field>
      <Field label="Ends at"><input type="datetime-local" value={coupon.ends_at} onChange={e => setCoupon({ ...coupon, ends_at: e.target.value })} required /></Field>
      <Field label="Minimum fare (paise)" hint="100 paise = INR 1.00"><input type="number" min="0" value={coupon.minimum_fare_paise} onChange={e => setCoupon({ ...coupon, minimum_fare_paise: e.target.value })}/></Field>
      <Field label="Maximum discount (paise)" hint="Leave blank for no cap"><input type="number" min="0" value={coupon.max_discount_paise} onChange={e => setCoupon({ ...coupon, max_discount_paise: e.target.value })}/></Field>
      <Field label="Taxi category code"><select value={coupon.taxi_category_code} onChange={e => setCoupon({ ...coupon, taxi_category_code: e.target.value })}><option value="">All categories</option>{allCategoryRows.map((row, index) => { const code = firstValue(row, ["code", "category_code", "taxi_category_code"]); if (!code) return null; const name = categoryName(row); return <option key={`${code}-${index}`} value={code}>{code}{name !== "-" ? ` - ${name}` : ""}</option>; })}</select></Field>
      <Field label="Funding model"><select value={coupon.funding_model} onChange={e => setCoupon({ ...coupon, funding_model: e.target.value })}><option value="">Not specified</option><option value="platform">Platform</option><option value="driver">Driver</option><option value="merchant">Merchant</option></select></Field>
      <Field label="Settlement policy"><input value={coupon.settlement_policy} onChange={e => setCoupon({ ...coupon, settlement_policy: e.target.value })}/></Field>
      <Field label="Active"><select value={String(coupon.is_active)} onChange={e => setCoupon({ ...coupon, is_active: e.target.value === "true" })}><option value="false">No</option><option value="true">Yes</option></select></Field>
      <Feedback message={couponMessage} error={couponError}/><SubmitButton busy={couponSaving}>Create coupon</SubmitButton>
    </form></div>
    </div></section>
    {selectedCategory && <div className="pricing-detail-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setSelectedCategory(null); }}>
      <section className="pricing-detail-dialog" role="dialog" aria-modal="true" aria-labelledby="pricing-detail-title">
        <header className="pricing-detail-header"><div className="pricing-detail-heading"><span className="panel-title-icon"><CarFront size={18}/></span><div><h2 id="pricing-detail-title">{categoryName(selectedCategory)}</h2><p>Taxi category details</p></div></div><button type="button" className="icon-btn" aria-label="Close category details" autoFocus onClick={() => setSelectedCategory(null)}><X size={18}/></button></header>
        <div className="pricing-detail-status"><span>Availability</span><span className={`pricing-badge ${enabledLabel(selectedCategory) === "Yes" ? "is-enabled" : enabledLabel(selectedCategory) === "No" ? "is-disabled" : "is-unknown"}`}>{enabledLabel(selectedCategory)}</span></div>
        {selectedCategoryDetails.length ? <dl className="profile-grid pricing-detail-grid">{selectedCategoryDetails.map(([label, value]) => <div className="profile-field" key={label}><dt>{displayDriverName(label.replace(/[_.]/g, " "))}</dt><dd>{formatCell(value)}</dd></div>)}</dl> : <p className="muted small">No additional category fields were returned.</p>}
        <div className="pricing-detail-footer"><span>Read-only category information</span><button type="button" className="btn secondary" onClick={() => setSelectedCategory(null)}>Close</button></div>
      </section>
    </div>}
  </div>;
}

function ConfigurationPage() {
  const [activeConfigurationTab, setActiveConfigurationTab] = useState("service-areas");
  const emptyArea = { city_code: "", display_name: "", center_lat: "", center_lng: "", radius_m: "", area_type: "city", is_enabled: false };
  const [area, setArea] = useState(emptyArea);
  const [editingArea, setEditingArea] = useState(false);
  const [areaEditorOpen, setAreaEditorOpen] = useState(false);
  const [areaSaving, setAreaSaving] = useState(false);
  const [areaMessage, setAreaMessage] = useState("");
  const [areaError, setAreaError] = useState(false);
  const [areaPage, setAreaPage] = useState(1);
  const areasPerPage = 20;
  const [areaSearch, setAreaSearch] = useState("");
  const [areaTypeFilter, setAreaTypeFilter] = useState("all");
  const [areaStatusFilter, setAreaStatusFilter] = useState("all");
  const [viewingArea, setViewingArea] = useState(null);
  const [areaDetailsByCode, setAreaDetailsByCode] = useState(() => {
    if (typeof window === "undefined") return {};
    try {
      const cached = JSON.parse(window.localStorage.getItem("taxigo_service_area_details_v1") || "{}");
      return cached && typeof cached === "object" && !Array.isArray(cached) ? cached : {};
    } catch { return {}; }
  });
  const areaParams = {
    page: areaPage,
    per_page: areasPerPage,
    ...(areaSearch.trim() ? { search: areaSearch.trim() } : {}),
    ...(areaTypeFilter !== "all" ? { area_type: areaTypeFilter } : {}),
    ...(areaStatusFilter !== "all" ? { is_enabled: areaStatusFilter === "enabled" } : {}),
  };
  const areas = useList("/api/v1/admin/service-areas", areaParams);
  const selectableServiceAreas = useList("/api/v1/drivers/service-areas");
  const selectableAreaCodes = useMemo(() => new Set(selectableServiceAreas.rows
    .map(row => String(valueFor(row, ["city_code", "code", "service_area.city_code", "area.city_code"]) ?? "").trim().toLowerCase())
    .filter(Boolean)), [selectableServiceAreas.rows]);
  const areaTotal = areas.total ?? areas.rows.length;
  const areaStart = areas.rows.length ? (areaPage - 1) * areasPerPage + 1 : 0;
  const areaEnd = areas.rows.length ? areaStart + areas.rows.length - 1 : 0;
  const areaHasNext = areas.hasMore != null ? areas.hasMore : areas.total != null ? areaPage * areasPerPage < areas.total : areas.rows.length >= areasPerPage;
  const areaCodeAlreadyExists = Boolean(String(area.city_code).trim()) && areas.rows.some(row =>
    String(valueFor(row, ["city_code", "code"]) ?? "").trim().toLowerCase() === String(area.city_code).trim().toLowerCase());
  const areaFormIsEditing = editingArea || areaCodeAlreadyExists;
  useEffect(() => {
    if (typeof window === "undefined") return;
    const cache = Object.fromEntries(Object.entries(areaDetailsByCode).map(([code, record]) => [code, {
      city_code: valueFor(record, ["city_code", "code"]) ?? code,
      display_name: valueFor(record, ["display_name", "name"]) ?? "",
      area_type: valueFor(record, ["area_type"]) ?? "city",
      is_enabled: valueFor(record, ["is_enabled", "enabled", "active"]),
      center_lat: valueFor(record, ["center_lat", "center_latitude", "latitude", "center.lat", "center.latitude", "location.latitude"]) ?? null,
      center_lng: valueFor(record, ["center_lng", "center_longitude", "longitude", "lng", "center.lng", "center.longitude", "location.longitude"]) ?? null,
      radius_m: valueFor(record, ["radius_m", "radius_meters", "radius"]) ?? null,
    }]));
    try { window.localStorage.setItem("taxigo_service_area_details_v1", JSON.stringify(cache)); } catch {}
  }, [areaDetailsByCode]);
  const viewingAreaDetails = viewingArea ? (() => {
    const geometryKeys = new Set([
      "centerlat", "centerlatitude", "latitude", "lat", "locationlatitude",
      "centerlng", "centerlongitude", "longitude", "lng", "locationlongitude",
      "radius", "radiusm", "radiusmeters",
    ]);
    const extraDetails = detailEntries(viewingArea).filter(([label]) =>
      !geometryKeys.has(label.toLowerCase().replace(/[^a-z]/g, "")));
    return extraDetails;
  })() : [];

  const [route, setRoute] = useState({ origin: "", destination: "", enabled: true });
  const [selectedRouteKey, setSelectedRouteKey] = useState("");
  const [routeSaving, setRouteSaving] = useState(false);
  const [routeToggleBusyKey, setRouteToggleBusyKey] = useState("");
  const [routeMessage, setRouteMessage] = useState("");
  const [routeError, setRouteError] = useState(false);
  const [routeActionMessage, setRouteActionMessage] = useState("");
  const [routeActionError, setRouteActionError] = useState(false);
  const [routePage, setRoutePage] = useState(1);
  const [routeSearch, setRouteSearch] = useState("");
  const [routeStatusFilter, setRouteStatusFilter] = useState("all");
  const routesPerPage = 20;
  const routes = useList("/api/v1/admin/supported-routes", { page: routePage, per_page: routesPerPage });
  const routeTotal = routes.total ?? routes.rows.length;
  const routeStart = routes.rows.length ? (routePage - 1) * routesPerPage + 1 : 0;
  const routeEnd = routes.rows.length ? routeStart + routes.rows.length - 1 : 0;
  const routeHasNext = routes.hasMore != null ? routes.hasMore : routes.total != null ? routePage * routesPerPage < routes.total : routes.rows.length >= routesPerPage;

  function statusLabel(row) {
    const value = valueFor(row, ["is_enabled", "enabled", "active", "status"]);
    const normalized = String(value ?? "").trim().toLowerCase();
    if (value === true || value === 1 || ["true", "1", "yes", "enabled", "active", "on"].includes(normalized)) return "Enabled";
    if (value === false || value === 0 || ["false", "0", "no", "disabled", "inactive", "off"].includes(normalized)) return "Disabled";
    return value == null ? "Unknown" : displayDriverName(value);
  }
  function statusBadge(row) {
    const status = statusLabel(row);
    const className = status === "Enabled" ? "is-enabled" : status === "Disabled" ? "is-disabled" : "is-unknown";
    return <span className={`pricing-badge ${className}`}>{status}</span>;
  }
  function driverSelectabilityBadge(row) {
    const code = String(valueFor(row, ["city_code", "code"]) ?? "").trim().toLowerCase();
    if (selectableServiceAreas.error) return <span className="pricing-badge is-unknown" title={selectableServiceAreas.error}>Unavailable</span>;
    if (selectableServiceAreas.busy && !selectableServiceAreas.rows.length) return <span className="pricing-badge is-unknown">Loading</span>;
    if (!code) return <span className="pricing-badge is-unknown">Unknown</span>;
    const selectable = selectableAreaCodes.has(code);
    return <span className={`pricing-badge ${selectable ? "is-enabled" : "is-disabled"}`}>{selectable ? "Selectable" : "Not selectable"}</span>;
  }
  function selectableAreaFor(cityCode) {
    const normalizedCode = String(cityCode ?? "").trim().toLowerCase();
    return selectableServiceAreas.rows.find(row =>
      String(valueFor(row, ["city_code", "code", "service_area.city_code", "area.city_code"]) ?? "").trim().toLowerCase() === normalizedCode);
  }
  async function reloadAreaData() {
    await Promise.all([areas.reload(), selectableServiceAreas.reload()]);
  }
  function selectArea(row) {
    const code = valueFor(row, ["city_code", "code"]);
    const cached = areaDetailsByCode[String(code ?? "").trim().toLowerCase()] || {};
    const selectable = selectableAreaFor(code) || {};
    const enabled = statusLabel(row) === "Enabled";
    setArea({
      city_code: code == null ? "" : String(code),
      display_name: String(valueFor(row, ["display_name", "name"]) ?? ""),
      center_lat: valueFor(row, ["center_lat", "center_latitude", "latitude", "center.lat", "center.latitude", "location.latitude"]) ?? valueFor(cached, ["center_lat", "center_latitude", "latitude", "center.lat", "center.latitude", "location.latitude"]) ?? valueFor(selectable, ["center_lat", "center_latitude", "latitude", "center.lat", "center.latitude", "location.latitude"]) ?? "",
      center_lng: valueFor(row, ["center_lng", "center_longitude", "longitude", "lng", "center.lng", "center.longitude", "location.longitude"]) ?? valueFor(cached, ["center_lng", "center_longitude", "longitude", "lng", "center.lng", "center.longitude", "location.longitude"]) ?? valueFor(selectable, ["center_lng", "center_longitude", "longitude", "lng", "center.lng", "center.longitude", "location.longitude"]) ?? "",
      radius_m: valueFor(row, ["radius_m", "radius_meters", "radius"]) ?? valueFor(cached, ["radius_m", "radius_meters", "radius"]) ?? valueFor(selectable, ["radius_m", "radius_meters", "radius"]) ?? "",
      area_type: String(valueFor(row, ["area_type"]) ?? "city"),
      is_enabled: enabled,
    });
    setEditingArea(true);
    setActiveConfigurationTab("service-areas");
    setAreaEditorOpen(true);
    setAreaMessage("");
    setAreaError(false);
  }
  function createArea() {
    setArea({ ...emptyArea });
    setEditingArea(false);
    setActiveConfigurationTab("service-areas");
    setAreaEditorOpen(true);
    setAreaMessage("");
    setAreaError(false);
  }
  function showAreaDetails(row) {
    const cityCode = String(valueFor(row, ["city_code", "code"]) ?? "").trim();
    const cached = areaDetailsByCode[cityCode.toLowerCase()] || {};
    const selectable = selectableAreaFor(cityCode) || {};
    const details = { ...selectable, ...cached, ...row };
    const geometryFields = [
      ["center_lat", ["center_lat", "center_latitude", "latitude", "center.lat", "center.latitude", "location.latitude"]],
      ["center_lng", ["center_lng", "center_longitude", "longitude", "lng", "center.lng", "center.longitude", "location.longitude"]],
      ["radius_m", ["radius_m", "radius_meters", "radius"]],
    ];
    for (const [field, aliases] of geometryFields) {
      const apiValue = valueFor(row, aliases);
      const savedValue = valueFor(cached, aliases);
      const selectableValue = valueFor(selectable, aliases);
      if (apiValue != null) details[field] = apiValue;
      else if (savedValue != null) details[field] = savedValue;
      else if (selectableValue != null) details[field] = selectableValue;
    }
    setViewingArea(details);
  }
  function resetAreaForm() {
    setArea(emptyArea);
    setEditingArea(false);
    setAreaEditorOpen(false);
    setAreaMessage("");
    setAreaError(false);
  }
  async function saveArea(event) {
    event.preventDefault(); setAreaMessage(""); setAreaError(false);
    const centerLat = Number(area.center_lat);
    const centerLng = Number(area.center_lng);
    const radiusMeters = Number(area.radius_m);
    if (!String(area.center_lat).trim() || !String(area.center_lng).trim() || !String(area.radius_m).trim()
      || !Number.isFinite(centerLat) || centerLat < -90 || centerLat > 90
      || !Number.isFinite(centerLng) || centerLng < -180 || centerLng > 180
      || !Number.isInteger(radiusMeters) || radiusMeters < 1 || radiusMeters > 500000) {
      setAreaMessage("Enter a valid center latitude (-90 to 90), center longitude (-180 to 180), and radius (1 to 500,000 meters).");
      setAreaError(true);
      return;
    }
    setAreaSaving(true);
    const cityCode = area.city_code.trim();
    const wasEditing = editingArea || areas.rows.some(row =>
      String(valueFor(row, ["city_code", "code"]) ?? "").trim().toLowerCase() === cityCode.toLowerCase());
    const body = {
      display_name: area.display_name.trim(),
      center_lat: centerLat,
      center_lng: centerLng,
      radius_m: radiusMeters,
      area_type: area.area_type,
      is_enabled: area.is_enabled,
    };
    try {
      const response = wasEditing
        ? await api.put(`/api/v1/admin/service-areas/${encodeURIComponent(cityCode)}`, body)
        : await api.post("/api/v1/admin/service-areas", { city_code: cityCode, ...body });
      const responseData = response?.data?.data ?? response?.data;
      const responseArea = responseData?.service_area ?? responseData?.area ?? responseData;
      const savedDetails = responseArea && typeof responseArea === "object" && !Array.isArray(responseArea)
        ? responseArea
        : {};
      const savedValueOrSubmitted = (keys, submittedValue) => valueFor(savedDetails, keys) ?? submittedValue;
      const persistedDetails = {
        ...savedDetails,
        city_code: valueFor(savedDetails, ["city_code", "code"]) ?? cityCode,
        display_name: savedValueOrSubmitted(["display_name", "name"], body.display_name),
        area_type: savedValueOrSubmitted(["area_type"], body.area_type),
        is_enabled: savedValueOrSubmitted(["is_enabled", "enabled", "active"], body.is_enabled),
        center_lat: savedValueOrSubmitted(["center_lat", "center_latitude", "latitude", "center.lat", "center.latitude", "location.latitude"], body.center_lat),
        center_lng: savedValueOrSubmitted(["center_lng", "center_longitude", "longitude", "lng", "center.lng", "center.longitude", "location.longitude"], body.center_lng),
        radius_m: savedValueOrSubmitted(["radius_m", "radius_meters", "radius"], body.radius_m),
      };
      setAreaDetailsByCode(current => ({
        ...current,
        [cityCode.toLowerCase()]: persistedDetails,
      }));
      setArea({ ...emptyArea });
      setEditingArea(false);
      setAreaEditorOpen(false);
      setAreaMessage(wasEditing ? "Service area updated." : "Service area created.");
      setAreaError(false);
      if (!wasEditing) {
        setAreaSearch("");
        setAreaTypeFilter("all");
        setAreaStatusFilter("all");
        setAreaPage(1);
      }
      await reloadAreaData();
    } catch (error) {
      setAreaMessage(formatError(error));
      setAreaError(true);
    } finally { setAreaSaving(false); }
  }
  function routeOrigin(row) {
    const value = valueFor(row, ["origin_city_code", "origin", "from_city_code", "source_city_code"]);
    return value && typeof value === "object" ? valueFor(value, ["city_code", "code", "name"]) : value;
  }
  function routeDestination(row) {
    const value = valueFor(row, ["destination_city_code", "destination", "to_city_code", "target_city_code"]);
    return value && typeof value === "object" ? valueFor(value, ["city_code", "code", "name"]) : value;
  }
  function routeKey(row) {
    const origin = String(routeOrigin(row) ?? "").trim().toLowerCase();
    const destination = String(routeDestination(row) ?? "").trim().toLowerCase();
    return origin && destination ? `${origin}::${destination}` : "";
  }
  const routeFilteredRows = routes.rows.filter(row => {
    const term = routeSearch.trim().toLowerCase();
    const status = statusLabel(row).toLowerCase();
    if (routeStatusFilter !== "all" && status !== routeStatusFilter) return false;
    return !term || `${routeOrigin(row) ?? ""} ${routeDestination(row) ?? ""} ${status}`.toLowerCase().includes(term);
  });
  const routeFilteredLocally = Boolean(routeSearch.trim()) || routeStatusFilter !== "all";
  const routeResultCount = routeFilteredLocally ? routeFilteredRows.length : routeTotal;
  function selectRoute(row) {
    const origin = String(routeOrigin(row) ?? "");
    const destination = String(routeDestination(row) ?? "");
    setRoute({ origin, destination, enabled: statusLabel(row) === "Enabled" });
    setSelectedRouteKey(routeKey(row));
    setRouteMessage("");
    setRouteError(false);
    setRouteActionMessage("");
    setRouteActionError(false);
    document.getElementById("supported-route-form")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  async function toggleRouteStatus(row) {
    const origin = String(routeOrigin(row) ?? "").trim();
    const destination = String(routeDestination(row) ?? "").trim();
    if (!origin || !destination) return;
    const key = routeKey(row);
    const enabled = statusLabel(row) !== "Enabled";
    setRouteToggleBusyKey(key);
    setRouteActionMessage("");
    setRouteActionError(false);
    try {
      await api.put(`/api/v1/admin/supported-routes/${encodeURIComponent(origin)}/${encodeURIComponent(destination)}`, null, { params: { enabled } });
      if (selectedRouteKey === key) setRoute(current => ({ ...current, enabled }));
      setRouteActionMessage(`${origin} → ${destination} ${enabled ? "enabled" : "disabled"}.`);
      await routes.reload();
    } catch (error) {
      setRouteActionMessage(formatError(error));
      setRouteActionError(true);
    } finally {
      setRouteToggleBusyKey("");
    }
  }
  async function updateRoute(event) {
    event.preventDefault(); setRouteSaving(true); setRouteMessage(""); setRouteError(false);
    try {
      await api.put(`/api/v1/admin/supported-routes/${encodeURIComponent(route.origin.trim())}/${encodeURIComponent(route.destination.trim())}`, null, { params: { enabled: route.enabled } });
      setRouteMessage("Supported route updated.");
      await routes.reload();
    } catch (error) { setRouteMessage(formatError(error)); setRouteError(true); }
    finally { setRouteSaving(false); }
  }
  function handleConfigurationTabKeyDown(event) {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    const nextTab = activeConfigurationTab === "service-areas" ? "supported-routes" : "service-areas";
    setActiveConfigurationTab(nextTab);
    document.getElementById(`${nextTab}-tab`)?.focus();
  }

  return <div className="manual-stack configuration-page">
    {!areaEditorOpen && <section className="configuration-overview" aria-label="Coverage overview">
      <div className="configuration-overview-heading">
        <div><span>OPERATIONS CONFIGURATION</span><h2>Coverage overview</h2><p>Manage service areas and the routes your network supports.</p></div>
      </div>
      <div className="configuration-metrics">
        <article className="configuration-metric-card"><span className="configuration-metric-icon areas"><MapPinned size={18}/></span><div><small>Service areas</small><strong>{areas.busy && !areas.rows.length ? "—" : areaTotal}</strong><span>Configured locations</span></div></article>
        <article className="configuration-metric-card"><span className="configuration-metric-icon selectable"><Users size={18}/></span><div><small>Driver selectable</small><strong>{(selectableServiceAreas.busy && !selectableServiceAreas.rows.length) || selectableServiceAreas.error ? "—" : (selectableServiceAreas.total ?? selectableServiceAreas.rows.length)}</strong><span>Available to drivers</span></div></article>
        <article className="configuration-metric-card"><span className="configuration-metric-icon routes"><Route size={18}/></span><div><small>Supported routes</small><strong>{routes.busy && !routes.rows.length ? "—" : routeTotal}</strong><span>Configured corridors</span></div></article>
      </div>
    </section>}
    {!areaEditorOpen && <div className="notice configuration-notice"><MapPinned size={18}/><div><b>Coverage settings</b><p>Choose service areas, set a coverage center and radius, then manage which city pairs are enabled. The admin API does not expose delete operations.</p></div></div>}
    {!areaEditorOpen && <div className="communications-tabs configuration-tabs" role="tablist" aria-label="Areas and routes sections">
      <button type="button" role="tab" id="service-areas-tab" aria-controls="service-areas-panel" aria-selected={activeConfigurationTab === "service-areas"} tabIndex={activeConfigurationTab === "service-areas" ? 0 : -1} className={activeConfigurationTab === "service-areas" ? "active" : ""} onClick={() => setActiveConfigurationTab("service-areas")} onKeyDown={handleConfigurationTabKeyDown}><MapPinned size={15}/>Service Areas <span>{areas.busy && !areas.rows.length ? "—" : areaTotal}</span></button>
      <button type="button" role="tab" id="supported-routes-tab" aria-controls="supported-routes-panel" aria-selected={activeConfigurationTab === "supported-routes"} tabIndex={activeConfigurationTab === "supported-routes" ? 0 : -1} className={activeConfigurationTab === "supported-routes" ? "active" : ""} onClick={() => setActiveConfigurationTab("supported-routes")} onKeyDown={handleConfigurationTabKeyDown}><Route size={15}/>Supported Routes <span>{routes.busy && !routes.rows.length ? "—" : routeTotal}</span></button>
    </div>}
    {!areaEditorOpen && <div className="configuration-tabpanel" id="service-areas-panel" role="tabpanel" aria-labelledby="service-areas-tab" hidden={activeConfigurationTab !== "service-areas"}>
    <section className="panel configuration-panel configuration-area-panel" id="service-areas" aria-label="Service areas">
      <div className="manual-panel-head"><PanelTitle title="Service areas" subtitle="Create and configure coverage, and check driver availability" icon={MapPinned}/><div className="configuration-panel-actions"><button type="button" className="btn secondary" onClick={createArea}>Add service area</button><RefreshButton onClick={reloadAreaData} busy={areas.busy || selectableServiceAreas.busy}/></div></div>
      <div className="configuration-filters">
        <label className="pricing-search"><Search size={15}/><input type="search" aria-label="Search service areas" placeholder="Search city code or name" value={areaSearch} onChange={event => { setAreaSearch(event.target.value); setAreaPage(1); }}/></label>
        <Field label="Area type"><select value={areaTypeFilter} onChange={event => { setAreaTypeFilter(event.target.value); setAreaPage(1); }}><option value="all">All types</option><option value="city">City</option><option value="airport">Airport</option><option value="other">Other</option></select></Field>
        <Field label="Status"><select value={areaStatusFilter} onChange={event => { setAreaStatusFilter(event.target.value); setAreaPage(1); }}><option value="all">All statuses</option><option value="enabled">Enabled</option><option value="disabled">Disabled</option></select></Field>
      </div>
      {areas.error && <Feedback message={areas.error} error/>}
      {areaMessage && !areaError && <Feedback message={areaMessage}/>}
      {selectableServiceAreas.error && <Feedback message={`Driver-selectable areas could not be loaded: ${selectableServiceAreas.error}`} error/>}
      {areas.busy ? <div className="loading-row">Loading service areas…</div> : <DataTable rows={areas.rows} page={areaPage} perPage={areasPerPage} selectedId={area.city_code} idKeys={["city_code", "code"]} empty="No service areas match these filters." columns={[
        { label: "#", value: (_, index, currentPage, pageSize) => (currentPage - 1) * pageSize + index + 1 },
        { label: "City code", value: row => firstValue(row, ["city_code", "code"]) },
        { label: "Name", value: row => firstValue(row, ["display_name", "name"]) },
        { label: "Type", value: row => displayDriverName(valueFor(row, ["area_type"]) ?? "city") },
        { label: "Status", render: statusBadge },
        { label: "Driver selection", render: driverSelectabilityBadge },
      ]} renderAction={row => <div className="route-table-actions">
        <button type="button" className="table-action" onClick={event => { event.stopPropagation(); selectArea(row); }}>Manage</button>
        <button type="button" className="table-action" aria-label={`View details for ${firstValue(row, ["display_name", "name", "city_code", "code"])}`} onClick={event => { event.stopPropagation(); showAreaDetails(row); }}>View details</button>
      </div>}/>}
      <div className="configuration-table-footer">
        <span>{areaTotal ? `Showing ${areaStart}–${areaEnd} of ${areaTotal} service areas` : "No service areas"}</span>
        <div className="configuration-footer-pagination"><button className="btn secondary" type="button" aria-label="Previous service areas page" disabled={areas.busy || areaPage <= 1} onClick={() => setAreaPage(page => Math.max(1, page - 1))}>Previous</button><span>{areas.total != null ? `Page ${areaPage} of ${Math.max(1, Math.ceil(areas.total / areasPerPage))}` : `Page ${areaPage}`}</span><button className="btn secondary" type="button" aria-label="Next service areas page" disabled={areas.busy || !areaHasNext} onClick={() => setAreaPage(page => page + 1)}>Next</button></div>
      </div>
    </section>
    </div>}
    {!areaEditorOpen && <div className="configuration-tabpanel" id="supported-routes-panel" role="tabpanel" aria-labelledby="supported-routes-tab" hidden={activeConfigurationTab !== "supported-routes"}>
    <section className="panel configuration-panel configuration-routes-panel" id="supported-routes" aria-label="Supported routes">
      <div className="manual-panel-head"><PanelTitle title="Supported routes" subtitle="Review each corridor and update its availability" icon={Route}/><div className="configuration-panel-actions"><button type="button" className="btn secondary" onClick={() => document.getElementById("supported-route-form")?.scrollIntoView({ behavior: "smooth", block: "start" })}>Configure route</button><RefreshButton onClick={routes.reload} busy={routes.busy}/></div></div>
      <div className="configuration-route-toolbar">
        <label className="pricing-search"><Search size={15}/><input type="search" aria-label="Search supported routes" placeholder="Search origin or destination" value={routeSearch} onChange={event => { setRouteSearch(event.target.value); setRoutePage(1); }}/></label>
        <Field label="Route status"><select value={routeStatusFilter} onChange={event => { setRouteStatusFilter(event.target.value); setRoutePage(1); }}><option value="all">All statuses</option><option value="enabled">Enabled</option><option value="disabled">Disabled</option></select></Field>
        {routeFilteredLocally && <span className="configuration-route-count">{routeResultCount} matches on this page</span>}
      </div>
      {routes.error && <Feedback message={routes.error} error/>}
      {routeActionMessage && <Feedback message={routeActionMessage} error={routeActionError}/>}
      {routes.busy ? <div className="loading-row">Loading supported routes…</div> : <DataTable rows={routeFilteredRows} page={routePage} perPage={routesPerPage} onSelect={selectRoute} selectedId={selectedRouteKey} getRowId={routeKey} empty={routeFilteredLocally ? "No routes match these filters on this page." : "No supported routes were returned by the API."} columns={[
        { label: "#", value: (_, index, currentPage, pageSize) => (currentPage - 1) * pageSize + index + 1 },
        { label: "Origin city", value: row => routeOrigin(row) },
        { label: "Destination city", value: row => routeDestination(row) },
        { label: "Status", render: statusBadge },
      ]} renderAction={row => {
        const key = routeKey(row);
        const isEnabled = statusLabel(row) === "Enabled";
        const isBusy = Boolean(key) && routeToggleBusyKey === key;
        return <div className="route-table-actions">
          <button type="button" className="table-action" onClick={event => { event.stopPropagation(); selectRoute(row); }}>{selectedRouteKey === key ? "Selected" : "Manage"}</button>
          <button type="button" className={`table-action route-toggle-action ${isEnabled ? "disable" : "enable"}`} disabled={!key || Boolean(routeToggleBusyKey) || routes.busy || routeSaving} aria-label={`${isEnabled ? "Disable" : "Enable"} ${routeOrigin(row)} to ${routeDestination(row)} route`} onClick={event => { event.stopPropagation(); toggleRouteStatus(row); }}>{isBusy ? "Saving…" : isEnabled ? "Disable" : "Enable"}</button>
        </div>;
      }}/>} 
      <div className="configuration-table-footer">
        <span>{routeFilteredLocally ? `${routeResultCount} matches on this page · ${routeTotal ? `Showing ${routeStart}–${routeEnd} of ${routeTotal} routes` : "No routes"}` : routeTotal ? `Showing ${routeStart}–${routeEnd} of ${routeTotal} routes` : "No supported routes"}</span>
        <div className="configuration-footer-pagination"><button className="btn secondary" type="button" aria-label="Previous supported routes page" disabled={routes.busy || routePage <= 1} onClick={() => setRoutePage(page => Math.max(1, page - 1))}>Previous</button><span>{routes.total != null ? `Page ${routePage} of ${Math.max(1, Math.ceil(routes.total / routesPerPage))}` : `Page ${routePage}`}</span><button className="btn secondary" type="button" aria-label="Next supported routes page" disabled={routes.busy || !routeHasNext} onClick={() => setRoutePage(page => page + 1)}>Next</button></div>
      </div>
    </section>
    <section className="panel configuration-panel configuration-form-panel" id="supported-route-form" aria-label="Update supported route">
      <div className="configuration-form-heading"><PanelTitle title="Update supported route" subtitle={selectedRouteKey ? `Editing ${route.origin} → ${route.destination}` : "Select a route above or enter its city codes"} icon={Route}/><span className="configuration-mode-badge editing">Route settings</span></div>
      <form className="manual-form configuration-form" onSubmit={updateRoute}>
        <Field label="Origin city code"><input value={route.origin} onChange={event => { setRoute({ ...route, origin: event.target.value }); setSelectedRouteKey(""); }} minLength="2" maxLength="64" pattern="[A-Za-z0-9_-]+" required /></Field>
        <Field label="Destination city code"><input value={route.destination} onChange={event => { setRoute({ ...route, destination: event.target.value }); setSelectedRouteKey(""); }} minLength="2" maxLength="64" pattern="[A-Za-z0-9_-]+" required /></Field>
        <Field label="Route enabled"><select value={String(route.enabled)} onChange={event => setRoute({ ...route, enabled: event.target.value === "true" })}><option value="true">Yes</option><option value="false">No</option></select></Field>
        <div className="configuration-form-actions"><Feedback message={routeMessage} error={routeError}/><SubmitButton busy={routeSaving}>Save route</SubmitButton></div>
      </form>
    </section>
    </div>}
    {areaEditorOpen && <>
      <div className="configuration-editor-header">
        <button type="button" className="btn secondary" onClick={resetAreaForm}><ArrowLeft size={15}/>Back to service areas</button>
        <span>Areas &amp; Routes / {areaFormIsEditing ? "Update service area" : "Create service area"}</span>
      </div>
      <section className="panel configuration-panel configuration-form-panel" id="service-area-form" aria-label={areaFormIsEditing ? "Update service area" : "Create service area"}>
        <div className="configuration-form-heading"><PanelTitle title={areaFormIsEditing ? "Update service area" : "Create service area"} subtitle={areaFormIsEditing ? `Editing ${area.city_code}` : "Add a city, airport, or other service area"} icon={MapPinned}/><span className={`configuration-mode-badge ${areaFormIsEditing ? "editing" : "creating"}`}>{areaFormIsEditing ? "Editing" : "New area"}</span></div>
        <form className="manual-form configuration-form" onSubmit={saveArea}>
          <Field label="City code"><input value={area.city_code} onChange={event => setArea({ ...area, city_code: event.target.value })} minLength="2" maxLength="64" pattern="[A-Za-z0-9_-]+" readOnly={areaFormIsEditing} required /></Field>
          <Field label="Display name"><input value={area.display_name} onChange={event => setArea({ ...area, display_name: event.target.value })} minLength="2" maxLength="100" required /></Field>
          <Field label="Area type"><select value={area.area_type} onChange={event => setArea({ ...area, area_type: event.target.value })}><option value="city">City</option><option value="airport">Airport</option><option value="other">Other</option></select></Field>
          <Field label="Center latitude"><input type="number" min="-90" max="90" step="any" value={area.center_lat} onChange={event => setArea({ ...area, center_lat: event.target.value })} required/></Field>
          <Field label="Center longitude"><input type="number" min="-180" max="180" step="any" value={area.center_lng} onChange={event => setArea({ ...area, center_lng: event.target.value })} required/></Field>
          <Field label="Radius in meters"><input type="number" min="1" max="500000" step="1" value={area.radius_m} onChange={event => setArea({ ...area, radius_m: event.target.value })} required/></Field>
          <Field label="Enabled"><select value={String(area.is_enabled)} onChange={event => setArea({ ...area, is_enabled: event.target.value === "true" })}><option value="false">No</option><option value="true">Yes</option></select></Field>
          <div className="configuration-form-actions"><Feedback message={areaMessage} error={areaError}/><div><button type="button" className="btn secondary" onClick={resetAreaForm}>Cancel</button><SubmitButton busy={areaSaving}>{areaFormIsEditing ? "Update service area" : "Create service area"}</SubmitButton></div></div>
        </form>
      </section>
    </>}
    {viewingArea && <div className="pricing-detail-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setViewingArea(null); }}>
      <section className="pricing-detail-dialog" role="dialog" aria-modal="true" aria-labelledby="service-area-detail-title">
        <header className="pricing-detail-header"><div className="pricing-detail-heading"><span className="panel-title-icon"><MapPinned size={18}/></span><div><h2 id="service-area-detail-title">{firstValue(viewingArea, ["display_name", "name", "city_code", "code"]) || "Service area"}</h2><p>Service area details · {firstValue(viewingArea, ["city_code", "code"]) || "City code not returned"}</p></div></div><button type="button" className="icon-btn" aria-label="Close service area details" autoFocus onClick={() => setViewingArea(null)}><X size={18}/></button></header>
        <div className="pricing-detail-status"><span>Status</span>{statusBadge(viewingArea)}</div>
        <div className="pricing-detail-status"><span>Driver selection</span>{driverSelectabilityBadge(viewingArea)}</div>
        {viewingAreaDetails.length ? <dl className="profile-grid pricing-detail-grid">{viewingAreaDetails.map(([label, value]) => <div className="profile-field" key={label}><dt>{displayDriverName(label.replace(/[_.]/g, " "))}</dt><dd>{formatCell(value)}</dd></div>)}</dl> : <p className="muted small">No service area details were returned.</p>}
        <div className="pricing-detail-footer"><span>Service area details returned by the API</span><button type="button" className="btn secondary" onClick={() => setViewingArea(null)}>Close</button></div>
      </section>
    </div>}
  </div>;
}

function CustomersPage({ customerId, onOpenCustomer, onBackToCustomers }) {
  return <CustomerManagement customerId={customerId} onOpenCustomer={onOpenCustomer} onBackToCustomers={onBackToCustomers}/>;
}

function docStatus(record) {
  return normalizeDriverDocumentStatus(record);
}
function KycDriverDocumentsPage({ focus, adminProfile, routeDriverId = "", onOpenKycDriver, onBackToKycDocuments }) {
  const [drivers, setDrivers] = useState([]);
  const [aadhaar, setAadhaar] = useState([]);
  const [documents, setDocuments] = useState([]);
  const [taxiCategories, setTaxiCategories] = useState([]);
  const [summaryDocuments, setSummaryDocuments] = useState([]);
  const [summaryDetailsIncomplete, setSummaryDetailsIncomplete] = useState(false);
  const [driverCountDetails, setDriverCountDetails] = useState({});
  const [countRefreshVersion, setCountRefreshVersion] = useState(0);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState(focus?.driverId ? String(focus.driverId) : "");
  const [page, setPage] = useState(1);
  const [perPage] = useState(10);
  const [selectedDriver, setSelectedDriver] = useState(null);
  const [selectedDriverDetail, setSelectedDriverDetail] = useState(null);
  const [selectedDriverDetailLoading, setSelectedDriverDetailLoading] = useState(false);
  const [selectedDriverDetailError, setSelectedDriverDetailError] = useState("");
  const [aadhaarReadCounts, setAadhaarReadCounts] = useState({});
  const [aadhaarReadStatus, setAadhaarReadStatus] = useState({});
  const [docStatusFilter, setDocStatusFilter] = useState("all");
  const [reviewingId, setReviewingId] = useState("");
  const [rejectingId, setRejectingId] = useState("");
  const [rejectNote, setRejectNote] = useState("");
  const [vehicleReviewingId, setVehicleReviewingId] = useState("");
  const [rejectingVehicleId, setRejectingVehicleId] = useState("");
  const [vehicleRejectNote, setVehicleRejectNote] = useState("");
  const [message, setMessage] = useState("");
  const [actionError, setActionError] = useState(false);
  const [previewDoc, setPreviewDoc] = useState(null);
  const [pendingReview, setPendingReview] = useState(null);
  const mountedRef = useRef(true);
  useEffect(() => { return () => { mountedRef.current = false; }; }, []);
  const adminId = adminUserId(adminProfile);

  useEffect(() => {
    const controller = new AbortController();
    api.get("/api/v1/taxi-categories", { signal: controller.signal })
      .then(response => {
        if (!controller.signal.aborted) setTaxiCategories(recordsFrom(response.data));
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  async function fetchAllDrivers() {
    const all = [];
    let currentPage = 1;
    while (true) {
      if (!mountedRef.current) break;
      const response = await api.get("/api/v1/admin/drivers", { params: { page: currentPage, per_page: 100 } });
      const batch = recordsFrom(response.data);
      all.push(...batch);
      if (batch.length < 100) break;
      currentPage += 1;
      if (currentPage > 100) break;
    }
    return all;
  }
  async function fetchAllAadhaar() {
    const all = [];
    let offset = 0;
    while (true) {
      if (!mountedRef.current) break;
      const response = await api.get("/api/v1/admin/aadhaar", { params: { offset, limit: 100 } });
      const batch = Array.isArray(response.data) ? response.data : recordsFrom(response.data);
      all.push(...batch);
      if (batch.length < 100) break;
      offset += batch.length;
      if (offset > 100000) break;
    }
    return all;
  }
  async function fetchAllDocuments() {
    const all = [];
    let offset = 0;
    while (true) {
      if (!mountedRef.current) break;
      const response = await api.get("/api/v1/admin/documents", { params: { offset, limit: 100 } });
      const batch = Array.isArray(response.data) ? response.data : recordsFrom(response.data);
      all.push(...batch);
      if (batch.length < 100) break;
      offset += batch.length;
      if (offset > 100000) break;
    }
    return all;
  }
  async function loadData() {
    setBusy(true); setError(""); setMessage(""); setSummaryDetailsIncomplete(false);
    try {
      const [driverRows, aadhaarRows, documentRows] = await Promise.all([fetchAllDrivers(), fetchAllAadhaar(), fetchAllDocuments()]);
      const queueRecords = [
        ...aadhaarRows.map(row => ({ ...row, _kind: "aadhaar" })),
        ...documentRows.map(row => ({ ...row, _kind: "documents" })),
      ];
      const driverDetails = new Array(driverRows.length);
      let nextDriverIndex = 0;
      let detailFailures = 0;
      async function loadDriverDetails() {
        while (nextDriverIndex < driverRows.length) {
          const index = nextDriverIndex++;
          const driver = driverRows[index];
          const id = recordId(driver, ["driver_id", "id", "user_id", "driver.id", "user.id"]);
          if (!id) {
            detailFailures += 1;
            continue;
          }
          try {
            const response = await api.get(`/api/v1/admin/drivers/${encodeURIComponent(id)}`);
            const detail = unwrappedRecord(response.data);
            if (!detail || typeof detail !== "object" || Array.isArray(detail)) {
              detailFailures += 1;
              continue;
            }
            driverDetails[index] = detail;
          } catch {
            detailFailures += 1;
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(4, driverRows.length) }, () => loadDriverDetails()));

      const summaryById = new Map();
      function addSummaryDocument(record) {
        const kind = record?._kind === "aadhaar" ? "aadhaar" : "documents";
        const id = recordId(record, kind === "aadhaar" ? ["submission_id", "id"] : ["document_id", "id"]);
        const key = id ? `${kind}:${id}` : `${kind}:anonymous:${JSON.stringify(record)}`;
        summaryById.set(key, {
          ...(summaryById.get(key) || {}),
          ...record,
          _kind: kind,
        });
      }
      queueRecords.forEach(addSummaryDocument);
      driverRows.forEach((driver, index) => {
        const detail = driverDetails[index];
        if (!detail) return;
        const id = recordId(driver, ["driver_id", "id", "user_id", "driver.id", "user.id"]);
        driverKycDocuments(driver, detail, queueRecords, id).forEach(addSummaryDocument);
      });

      setDrivers(driverRows);
      setAadhaar(aadhaarRows.map(row => ({ ...row, _kind: "aadhaar" })));
      setDocuments(documentRows.map(row => ({ ...row, _kind: "documents" })));
      setSummaryDocuments([...summaryById.values()]);
      setSummaryDetailsIncomplete(detailFailures > 0);
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
      setCountRefreshVersion(value => value + 1);
    }
  }
  useEffect(() => { loadData(); }, []);

  const selectedDriverId = selectedDriver
    ? recordId(selectedDriver, ["driver_id", "id", "user_id", "driver.id", "user.id"])
    : "";

  useEffect(() => {
    if (!selectedDriver) return undefined;
    const id = recordId(selectedDriver, ["driver_id", "id", "user_id", "driver.id", "user.id"]);
    const controller = new AbortController();
    setSelectedDriverDetail(null);
    setSelectedDriverDetailError("");
    if (!id) {
      setSelectedDriverDetailLoading(false);
      setSelectedDriverDetailError("This driver has no ID for the detail endpoint.");
      return () => controller.abort();
    }
    setSelectedDriverDetailLoading(true);
    api.get(`/api/v1/admin/drivers/${encodeURIComponent(id)}`, { signal: controller.signal })
      .then(response => {
        if (!controller.signal.aborted) setSelectedDriverDetail({ id, record: unwrappedRecord(response.data) });
      })
      .catch(error => {
        if (!controller.signal.aborted) setSelectedDriverDetailError(formatError(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setSelectedDriverDetailLoading(false);
      });
    return () => controller.abort();
  }, [selectedDriver]);

  const selectedDriverDetailRecord = selectedDriverDetail?.id === selectedDriverId ? selectedDriverDetail.record : null;
  useEffect(() => {
    if (!selectedDriverId) return undefined;
    let active = true;
    const refresh = () => api.get(`/api/v1/admin/drivers/${encodeURIComponent(selectedDriverId)}`)
      .then(response => { if (active) { setSelectedDriverDetail({ id: selectedDriverId, record: unwrappedRecord(response.data) }); setSelectedDriverDetailError(""); } })
      .catch(error => { if (active) setSelectedDriverDetailError(formatError(error)); });
    window.addEventListener("taxigo:document-updates-changed", refresh);
    return () => { active = false; window.removeEventListener("taxigo:document-updates-changed", refresh); };
  }, [selectedDriverId]);
  const selectedDriverIds = driverIdentityIds(selectedDriver, selectedDriverDetailRecord, selectedDriverId);
  const selectedVehiclePricingRecords = (Array.isArray(selectedDriverDetailRecord?.requirements?.vehicles)
    ? selectedDriverDetailRecord.requirements.vehicles
    : []).filter(vehicle => !vehicleHasDriverAssociation(vehicle) || vehicleBelongsToDriver(vehicle, selectedDriverIds));

  const allDocs = [...aadhaar, ...documents];
  const summary = {
    drivers: drivers.length,
    pending: summaryDocuments.filter(doc => ["pending", "submitted"].includes(docStatus(doc))).length,
    approved: summaryDocuments.filter(doc => docStatus(doc) === "approved").length,
    rejected: summaryDocuments.filter(doc => docStatus(doc) === "rejected").length,
  };

  const filteredDrivers = drivers.filter(driver => {
    const term = search.trim().toLowerCase();
    if (!term) return true;
    const haystack = [
      driverLabel(driver),
      String(valueFor(driver, ["driver_id", "id", "user_id", "driver.id", "user.id"]) || ""),
      String(valueFor(driver, ["phone", "phone_number", "mobile", "mobile_number"]) || ""),
    ].join(" ").toLowerCase();
    return haystack.includes(term);
  });

  const totalPages = Math.max(1, Math.ceil(filteredDrivers.length / perPage));
  const currentPage = Math.min(page, totalPages);
  const pagedDrivers = filteredDrivers.slice((currentPage - 1) * perPage, currentPage * perPage);
  const pageDriverIds = pagedDrivers.map(driver => recordId(driver, ["driver_id", "id", "user_id", "driver.id", "user.id"]));
  const pageDriverKey = pageDriverIds.join("\u001f");

  useEffect(() => {
    const uniqueRows = new Map();
    for (const driver of pagedDrivers) {
      const id = recordId(driver, ["driver_id", "id", "user_id", "driver.id", "user.id"]);
      if (id) uniqueRows.set(id, driver);
    }
    const rowsToLoad = [...uniqueRows.entries()];
    if (!rowsToLoad.length) {
      setDriverCountDetails({});
      return undefined;
    }

    const controller = new AbortController();
    setDriverCountDetails(Object.fromEntries(rowsToLoad.map(([id]) => [id, { status: "loading" }])));
    const loaded = {};
    let next = 0;
    async function loadNext() {
      while (next < rowsToLoad.length && !controller.signal.aborted) {
        const [id] = rowsToLoad[next++];
        try {
          const response = await api.get(`/api/v1/admin/drivers/${encodeURIComponent(id)}`, { signal: controller.signal });
          if (!controller.signal.aborted) loaded[id] = { status: "ready", record: unwrappedRecord(response.data) };
        } catch (requestError) {
          if (!controller.signal.aborted) loaded[id] = { status: "error", error: formatError(requestError) };
        }
      }
    }
    Promise.all(Array.from({ length: Math.min(4, rowsToLoad.length) }, () => loadNext())).then(() => {
      if (!controller.signal.aborted) setDriverCountDetails(loaded);
    });
    return () => controller.abort();
  }, [pageDriverKey, countRefreshVersion]);

  useEffect(() => {
    if (!routeDriverId) {
      setSelectedDriver(null);
      setSelectedDriverDetail(null);
      setSelectedDriverDetailLoading(false);
      setSelectedDriverDetailError("");
      return undefined;
    }
    if (busy) return undefined;
    const row = drivers.find(driver => recordId(driver, ["driver_id", "id", "user_id", "driver.id", "user.id"]) === routeDriverId);
    if (row) {
      setSelectedDriver(row);
      return undefined;
    }
    const controller = new AbortController();
    setMessage(""); setActionError(false);
    api.get(`/api/v1/admin/drivers/${encodeURIComponent(routeDriverId)}`, { signal: controller.signal })
      .then(response => {
        if (!controller.signal.aborted) setSelectedDriver(unwrappedRecord(response.data));
      })
      .catch(requestError => {
        if (!controller.signal.aborted) {
          setMessage(`Could not open this driver’s KYC records: ${formatError(requestError)}`);
          setActionError(true);
        }
      });
    return () => controller.abort();
  }, [routeDriverId, busy]);

  function docsForDriver(driver, detail = null, driverId = "") {
    return driverKycDocuments(driver, detail, allDocs, driverId);
  }

  async function handleReview(doc, newDecision, noteText = "") {
    const id = recordId(doc, doc._kind === "aadhaar" ? ["submission_id", "id"] : ["document_id", "id"]);
    if (!id) { setMessage("This document has no ID."); setActionError(true); return; }
    const ownerId = documentOwnerId(doc, doc);
    if (adminId && ownerId && adminId === ownerId) {
      setMessage("You cannot review your own documents."); setActionError(true); return;
    }
    const finalNote = newDecision === "rejected" ? String(noteText || "").trim() : "Approved by admin";
    if (newDecision === "rejected" && finalNote.length < 3) {
      setMessage("A rejection reason of at least 3 characters is required."); setActionError(true); return;
    }
    if (newDecision !== "rejected" && finalNote.length < 3) {
      setMessage("A review note of at least 3 characters is required."); setActionError(true); return;
    }
    const selectedId = selectedDriverId || recordId(selectedDriver, ["driver_id", "id", "user_id", "driver.id", "user.id"]);
    if (!selectedId) { setMessage("The selected driver ID is unavailable. Reopen the driver details and try again."); setActionError(true); return; }
    if (!window.confirm(`Are you sure you want to ${newDecision} this document?`)) return;
    const reviewKey = `${doc._kind}:${id}`;
    setReviewingId(reviewKey); setMessage(""); setActionError(false);
    let requestVersion;
    let requestPayload;
    const reviewEndpoint = kycReviewEndpoint(doc._kind, id);
    try {
      let reviewRecord = doc;
      const driverResponse = await api.get(`/api/v1/admin/drivers/${encodeURIComponent(selectedId)}`);
      const freshDriver = unwrappedRecord(driverResponse.data);
      const selectedIds = driverIdentityIds(selectedDriver, freshDriver, selectedId);
      const collection = doc._kind === "aadhaar" ? "aadhaar" : "documents";
      const freshRecords = Array.isArray(freshDriver[collection]) ? freshDriver[collection] : [];
      const freshDocument = freshRecords.find(record => recordId(
        record,
        doc._kind === "aadhaar" ? ["submission_id", "id"] : ["document_id", "id"]
      ) === id);
      if (!freshDocument) {
        throw new Error("The latest driver details no longer contain this submission. Refresh the KYC list and try again.");
      }
      if (documentHasDriverAssociation(freshDocument) && !documentBelongsToDriver(freshDocument, selectedIds)) {
        throw new Error("This submission is not associated with the selected driver. Review cancelled.");
      }
      reviewRecord = { ...doc, ...freshDocument, _kind: doc._kind };
      if (doc._kind === "aadhaar") {
        const detailResponse = await api.get(`/api/v1/admin/aadhaar/${encodeURIComponent(id)}`);
        const aadhaarDetail = unwrappedRecord(detailResponse.data);
        if (documentHasDriverAssociation(aadhaarDetail) && !documentBelongsToDriver(aadhaarDetail, selectedIds)) {
          throw new Error("This Aadhaar submission is not associated with the selected driver. Review cancelled.");
        }
        reviewRecord = { ...reviewRecord, ...aadhaarDetail, _kind: "aadhaar" };
      }
      const versionValue = valueFor(reviewRecord, ["version", "version_number"]);
      const payload = kycReviewPayload(newDecision, finalNote, versionValue, doc._kind);
      requestVersion = payload.version;
      requestPayload = payload;
      const reviewResponse = await api.post(reviewEndpoint, payload);
      const backendSuccessMessage = reviewSuccessMessage(
        reviewResponse.data,
        newDecision === "approved" ? "Document approved." : "Document rejected."
      );
      setMessage("Review saved. Refreshing driver documents...");
      setRejectingId(""); setRejectNote(""); setPreviewDoc(null);
      await loadData();
      const refreshErrors = [];
      let refreshedDriverRecord = null;
      try {
        const response = await api.get(`/api/v1/admin/drivers/${encodeURIComponent(selectedId)}`);
        refreshedDriverRecord = unwrappedRecord(response.data);
      } catch (refreshError) {
        refreshErrors.push(`driver details: ${formatError(refreshError)}`);
      }
      if (doc._kind === "aadhaar") {
        try {
          const response = await api.get(`/api/v1/admin/aadhaar/${encodeURIComponent(id)}`);
          const refreshedAadhaar = unwrappedRecord(response.data);
          const selectedIds = driverIdentityIds(selectedDriver, refreshedDriverRecord || selectedDriverDetailRecord, selectedId);
          if (documentHasDriverAssociation(refreshedAadhaar) && !documentBelongsToDriver(refreshedAadhaar, selectedIds)) {
            throw new Error("The refreshed Aadhaar record does not match the selected driver.");
          }
          const baseRecord = refreshedDriverRecord || selectedDriverDetailRecord || {};
          const existingAadhaar = Array.isArray(baseRecord.aadhaar) ? baseRecord.aadhaar : [];
          const remainingAadhaar = existingAadhaar.filter(record => recordId(record, ["submission_id", "id"]) !== id);
          refreshedDriverRecord = { ...baseRecord, aadhaar: [...remainingAadhaar, refreshedAadhaar] };
        } catch (refreshError) {
          refreshErrors.push(`Aadhaar status: ${formatError(refreshError)}`);
        }
      }
      if (refreshedDriverRecord) setSelectedDriverDetail({ id: selectedId, record: refreshedDriverRecord });
      const refreshMessage = refreshErrors.length ? refreshErrors.join(" ") : "";
      setSelectedDriverDetailError(refreshMessage);
      if (refreshMessage) {
        setMessage(`${backendSuccessMessage} Status refresh was incomplete: ${refreshMessage}`);
        setActionError(true);
      } else {
        setMessage(`${backendSuccessMessage} Driver documents refreshed.`);
      }
    } catch (error) {
      let actionMessage = reviewRequestError(error);
      if (Number(error?.response?.status) === 409) {
        try {
          await loadData();
          const response = await api.get(`/api/v1/admin/drivers/${encodeURIComponent(selectedId)}`);
          let latestDriver = unwrappedRecord(response.data);
          const collection = doc._kind === "aadhaar" ? "aadhaar" : "documents";
          const idKeys = doc._kind === "aadhaar" ? ["submission_id", "id"] : ["document_id", "id"];
          let latestRecord = (Array.isArray(latestDriver[collection]) ? latestDriver[collection] : [])
            .find(record => recordId(record, idKeys) === id) || null;
          if (doc._kind === "aadhaar") {
            const aadhaarResponse = await api.get(`/api/v1/admin/aadhaar/${encodeURIComponent(id)}`);
            const latestAadhaar = unwrappedRecord(aadhaarResponse.data);
            const selectedIds = driverIdentityIds(selectedDriver, latestDriver, selectedId);
            if (documentHasDriverAssociation(latestAadhaar) && !documentBelongsToDriver(latestAadhaar, selectedIds)) {
              throw new Error("The latest Aadhaar record is not associated with the selected driver.");
            }
            if (latestRecord) {
              latestRecord = { ...latestRecord, ...latestAadhaar, _kind: "aadhaar" };
              latestDriver = {
                ...latestDriver,
                aadhaar: latestDriver.aadhaar.map(record => recordId(record, idKeys) === id ? latestRecord : record),
              };
            }
          }
          setSelectedDriverDetail({ id: selectedId, record: latestDriver });
          setSelectedDriverDetailError("");
          actionMessage = reviewConflictMessage(error, { requestVersion, latestRecord });
        } catch (refreshError) {
          actionMessage = "Couldn't refresh the latest status. Please try again.";
        }
      }
      setMessage(actionMessage); setActionError(true);
    } finally {
      setReviewingId("");
    }
  }

  async function handleVehiclePricingReview(vehicle, newDecision, noteText = "") {
    const vehicleId = recordId(vehicle, ["vehicle_id", "id"]);
    if (!vehicleId) {
      setMessage("This vehicle pricing record has no vehicle ID."); setActionError(true); return;
    }
    const selectedId = selectedDriverId || recordId(selectedDriver, ["driver_id", "id", "user_id", "driver.id", "user.id"]);
    if (!selectedId) {
      setMessage("The selected driver ID is unavailable. Reopen the driver details and try again."); setActionError(true); return;
    }
    const ownerIds = [vehicle?.driver_id, vehicle?.current_driver_id].filter(Boolean).map(String);
    if (ownerIds.length && !ownerIds.some(id => selectedDriverIds.has(id))) {
      setMessage("This vehicle pricing record is not associated with the selected driver. Review cancelled."); setActionError(true); return;
    }
    if (adminId && ownerIds.includes(String(adminId))) {
      setMessage("You cannot review your own vehicle pricing."); setActionError(true); return;
    }
    const finalNote = newDecision === "rejected" ? String(noteText || "").trim() : "Approved by admin";
    if (finalNote.length < 3 || finalNote.length > 500) {
      setMessage("A review note between 3 and 500 characters is required."); setActionError(true); return;
    }
    if (newDecision !== "approved" && newDecision !== "rejected") {
      setMessage("Choose approve or reject for vehicle pricing."); setActionError(true); return;
    }
    if (!window.confirm(`Are you sure you want to ${newDecision} this vehicle's per-kilometre rate?`)) return;

    setVehicleReviewingId(vehicleId); setMessage(""); setActionError(false);
    const reviewEndpoint = vehiclePricingReviewEndpoint(vehicleId);
    let requestPayload;
    let requestVersion;
    try {
      const driverResponse = await api.get(`/api/v1/admin/drivers/${encodeURIComponent(selectedId)}`);
      const freshDriver = unwrappedRecord(driverResponse.data);
      const freshIds = driverIdentityIds(selectedDriver, freshDriver, selectedId);
      const freshVehicles = Array.isArray(freshDriver?.requirements?.vehicles) ? freshDriver.requirements.vehicles : [];
      const freshVehicle = freshVehicles.find(record => recordId(record, ["vehicle_id", "id"]) === vehicleId);
      if (!freshVehicle) throw new Error("The latest driver details no longer contain this vehicle pricing record. Refresh and try again.");
      if (vehicleHasDriverAssociation(freshVehicle) && !vehicleBelongsToDriver(freshVehicle, freshIds)) {
        throw new Error("This vehicle pricing record is not associated with the selected driver. Review cancelled.");
      }
      const latestStatus = vehiclePricingStatus(freshVehicle);
      if (latestStatus !== "pending") {
        throw new Error(`Vehicle pricing is currently ${latestStatus}; refresh the driver details before reviewing it.`);
      }
      requestVersion = vehiclePricingVersion(freshVehicle);
      if (requestVersion == null) throw new Error("The API did not return the pricing version. Update the backend and refresh before reviewing this rate.");
      requestPayload = vehiclePricingReviewPayload(newDecision, finalNote, requestVersion);
      const response = await api.post(reviewEndpoint, requestPayload);
      const successMessage = reviewSuccessMessage(response.data, newDecision === "approved" ? "Vehicle rate approved." : "Vehicle rate rejected.");
      setRejectingVehicleId(""); setVehicleRejectNote("");

      const refreshErrors = [];
      try {
        await loadData();
      } catch (refreshError) {
        refreshErrors.push(`KYC list: ${formatError(refreshError)}`);
      }
      try {
        const detailResponse = await api.get(`/api/v1/admin/drivers/${encodeURIComponent(selectedId)}`);
        setSelectedDriverDetail({ id: selectedId, record: unwrappedRecord(detailResponse.data) });
        setSelectedDriverDetailError("");
      } catch (refreshError) {
        refreshErrors.push(`driver details: ${formatError(refreshError)}`);
      }
      if (refreshErrors.length) {
        setMessage(`${successMessage} Status refresh was incomplete: ${refreshErrors.join("; ")}`);
        setActionError(true);
      } else {
        setMessage(`${successMessage} Driver verification refreshed.`);
        setActionError(false);
      }
    } catch (requestError) {
      let actionMessage = reviewRequestError(requestError);
      if (Number(requestError?.response?.status) === 409) {
        try {
          const latestResponse = await api.get(`/api/v1/admin/drivers/${encodeURIComponent(selectedId)}`);
          const latestDriver = unwrappedRecord(latestResponse.data);
          const latestVehicles = Array.isArray(latestDriver?.requirements?.vehicles) ? latestDriver.requirements.vehicles : [];
          const latestVehicle = latestVehicles.find(record => recordId(record, ["vehicle_id", "id"]) === vehicleId) || null;
          setSelectedDriverDetail({ id: selectedId, record: latestDriver });
          setSelectedDriverDetailError("");
          actionMessage = latestVehicle
            ? reviewConflictMessage(requestError, { requestVersion, latestRecord: latestVehicle })
            : "This vehicle is no longer listed for this driver. Refresh and try again.";
        } catch (refreshError) {
          actionMessage = "Couldn't refresh the vehicle status. Please try again.";
        }
      }
      setMessage(actionMessage);
      setActionError(true);
    } finally {
      setVehicleReviewingId("");
    }
  }

  const baseSelectedDocs = selectedDriver ? docsForDriver(selectedDriver, selectedDriverDetailRecord, selectedDriverId) : [];
  const selectedDocs = baseSelectedDocs.map(doc => {
    if (doc._kind !== "aadhaar") return doc;
    const id = recordId(doc, ["submission_id", "id"]);
    const count = aadhaarReadCounts[id];
    return driverDocumentFileCount(doc, "aadhaar") === undefined && count !== undefined
      ? { ...doc, file_count: count }
      : doc;
  });
  const aadhaarCountReadIds = [...new Set(selectedDocs
    .filter(doc => doc._kind === "aadhaar" && driverDocumentFileCount(doc, "aadhaar") === undefined)
    .map(doc => recordId(doc, ["submission_id", "id"]))
    .filter(Boolean))];
  const aadhaarCountReadKey = aadhaarCountReadIds.join("\u001f");

  useEffect(() => {
    if (!aadhaarCountReadIds.length) return undefined;
    const controller = new AbortController();
    setAadhaarReadStatus(current => ({
      ...current,
      ...Object.fromEntries(aadhaarCountReadIds.map(id => [id, { status: "loading" }])),
    }));
    Promise.all(aadhaarCountReadIds.map(async id => {
      try {
        const response = await api.get(`/api/v1/admin/aadhaar/${encodeURIComponent(id)}`, { signal: controller.signal });
        const record = unwrappedRecord(response.data);
        const fileCount = driverDocumentFileCount(record, "aadhaar");
        if (fileCount === undefined) throw new Error("The Aadhaar Admin Read response did not include file_count.");
        if (!controller.signal.aborted) {
          setAadhaarReadCounts(current => ({ ...current, [id]: fileCount }));
          setAadhaarReadStatus(current => ({ ...current, [id]: { status: "ready" } }));
        }
      } catch (requestError) {
        if (!controller.signal.aborted) {
          setAadhaarReadStatus(current => ({ ...current, [id]: { status: "error", error: formatError(requestError) } }));
        }
      }
    }));
    return () => controller.abort();
  }, [selectedDriverId, aadhaarCountReadKey, countRefreshVersion]);

  const visibleSelectedDocs = selectedDocs.filter(doc => docStatusFilter === "all" || docStatus(doc) === docStatusFilter);
  const countErrors = Object.entries(driverCountDetails).filter(([, count]) => count.status === "error");

  if (busy) return <div className="kyc-load-state" role="status"><span><RefreshCw size={17} className="spin"/></span><div><b>Loading verification records</b><p>Gathering driver profiles and submitted documents.</p></div></div>;
  if (error) return <section className="panel kyc-error-state"><PanelTitle title="Could not load Driver Verification" subtitle="The document queue could not be retrieved." icon={FileCheck2}/><Feedback message={error} error/><RefreshButton onClick={loadData} busy={busy}/></section>;

  if (selectedDriver) {
    const formattedDriverName = displayDriverName(linkedDriverLabel(selectedDriver));
    const selectedDriverName = formattedDriverName === "-" ? "Driver" : formattedDriverName;
    return <div className="manual-stack kyc-detail-page">
      <div className="manual-toolbar kyc-driver-summary-toolbar">
        <button type="button" className="btn secondary" onClick={() => { setSelectedDriver(null); setSelectedDriverDetail(null); setSelectedDriverDetailLoading(false); setSelectedDriverDetailError(""); setPreviewDoc(null); setRejectingId(""); setRejectNote(""); setMessage(""); onBackToKycDocuments?.(); }}>Back to Driver Verification</button>
        <div className="kyc-driver-summary">
          <span className="kyc-driver-summary-name">{selectedDriverName || "Driver"}</span>
          <span className="kyc-document-count"><FileText size={14} aria-hidden="true"/><span>{selectedDocs.length} {selectedDocs.length === 1 ? "Document" : "Documents"}</span></span>
        </div>
        <Field label="Document status"><select value={docStatusFilter} onChange={e => setDocStatusFilter(e.target.value)}><option value="all">All</option><option value="pending">Pending</option><option value="approved">Approved</option><option value="rejected">Rejected</option></select></Field>
      </div>
      {message && <Feedback message={message} error={actionError}/>}
      {selectedDriverDetailLoading && <div className="loading-row">Loading this driver’s submitted documents...</div>}
      {selectedDriverDetailError && <Feedback message={`Could not load or refresh this driver’s detail: ${selectedDriverDetailError}`} error/>}
      {selectedDriverDetailRecord && <section className="panel vehicle-pricing-review" aria-label="Vehicle per-kilometre rate review">
        <div className="manual-panel-head">
          <PanelTitle title="Vehicle per-kilometre rate" subtitle="Current driver rate with vehicle pricing details" icon={CircleDollarSign}/>
        </div>
        {selectedVehiclePricingRecords.length === 0
          ? <p className="muted small">No vehicle pricing records were returned for this driver.</p>
          : selectedVehiclePricingRecords.map(vehicle => {
            const vehicleId = recordId(vehicle, ["vehicle_id", "id"]);
            const pricingStatus = vehiclePricingStatus(vehicle);
            const vehicleRate = driverPerKilometreRate(selectedDriverDetailRecord, selectedDriver)
              ?? vehiclePerKilometreRate(vehicle);
            const categoryRate = vehicleRate ? null : taxiCategoryRateRange(vehicle, taxiCategories);
            const rateDisplay = vehicleRate
              ? `INR ${(vehicleRate.unit === "paise" ? vehicleRate.amount / 100 : vehicleRate.amount).toFixed(2)} / km`
              : categoryRate?.display ?? "Not returned by API";
            const vehicleLabel = valueFor(vehicle, ["make_model", "model", "category"]) || "Vehicle";
            const registration = valueFor(vehicle, ["registration_number"]);
            const isReviewing = vehicleReviewingId === vehicleId;
            return <article className="panel vehicle-pricing-record" key={vehicleId || `${vehicleLabel}-${registration || "vehicle"}`}>
              <div className="manual-toolbar">
                <div>
                  <b>{vehicleLabel}</b>
                  {registration && <span className="muted small" style={{ marginLeft: 8 }}>{registration}</span>}
                  {vehicleId && <span className="muted small" style={{ display: "block", marginTop: 5 }}>Vehicle ID: {vehicleId}</span>}
                </div>
                <span className={`driver-document-status ${pricingStatus}`}>{pricingStatus}</span>
              </div>
              <dl className="profile-grid driver-detail-grid">
                <div className="profile-field"><dt>{categoryRate?.label ?? "Per-kilometre rate"}</dt><dd>{rateDisplay}</dd></div>
                <div className="profile-field"><dt>Pricing version</dt><dd>{vehiclePricingVersion(vehicle) ?? "Not returned by API"}</dd></div>
                <div className="profile-field"><dt>Vehicle category</dt><dd>{valueFor(vehicle, ["category"]) || "-"}</dd></div>
                <div className="profile-field"><dt>Passenger capacity</dt><dd>{valueFor(vehicle, ["passenger_capacity"]) ?? "-"}</dd></div>
              </dl>
              {pricingStatus === "pending" && <div className="queue-pagination" style={{ marginTop: 8 }}>
                <button type="button" className="btn primary" disabled={isReviewing || !vehicleId} onClick={() => handleVehiclePricingReview(vehicle, "approved")}>
                  {isReviewing ? "Saving..." : "Approve rate"}
                </button>
                <button type="button" className="btn secondary" disabled={isReviewing || !vehicleId} onClick={() => { setRejectingVehicleId(vehicleId); setVehicleRejectNote(""); }}>
                  {isReviewing ? "Saving..." : "Reject rate"}
                </button>
              </div>}
              {pricingStatus === "pending" && rejectingVehicleId === vehicleId && <div className="manual-form" style={{ marginTop: 10 }}>
                <Field label="Rejection reason"><textarea minLength="3" maxLength="500" rows="3" value={vehicleRejectNote} onChange={event => setVehicleRejectNote(event.target.value)} required disabled={isReviewing}/></Field>
                <div className="queue-pagination">
                  <button type="button" className="btn primary" disabled={isReviewing || vehicleRejectNote.trim().length < 3} onClick={() => handleVehiclePricingReview(vehicle, "rejected", vehicleRejectNote)}>Submit rejection</button>
                  <button type="button" className="btn secondary" disabled={isReviewing} onClick={() => { setRejectingVehicleId(""); setVehicleRejectNote(""); }}>Cancel</button>
                </div>
              </div>}
            </article>;
          })}
      </section>}
      {selectedDriverId && <DocumentUpdates key={selectedDriverId} driverId={selectedDriverId} embedded documents={selectedDocs} driverDetail={selectedDriverDetailRecord} />}
      {visibleSelectedDocs.length === 0 ? selectedDriverDetailLoading ? null : <p className="muted small">No documents match this filter.</p> : visibleSelectedDocs.map(doc => {
        const docId = recordId(doc, doc._kind === "aadhaar" ? ["submission_id", "id"] : ["document_id", "id"]);
        const reviewKey = `${doc._kind}:${docId}`;
        const ownerId = documentOwnerId(doc, doc);
        const isOwn = Boolean(adminId && ownerId && adminId === ownerId);
        const status = docStatus(doc);
        const actions = driverDocumentActions(status);
        const readStatus = doc._kind === "aadhaar" ? aadhaarReadStatus[docId] : null;
        const fileCount = doc._kind === "aadhaar" && readStatus?.status === "loading" && driverDocumentFileCount(doc, "aadhaar") === undefined
          ? "Loading..."
          : formatDriverDocumentFileCount(doc, doc._kind);
        const submissionDate = driverDocumentSubmissionDate(doc, doc._kind);
        const label = doc._kind === "aadhaar"
          ? "Aadhaar Card"
          : String(valueFor(doc, ["kind", "document_type", "document_kind", "type"]) || "Document");
        return <div className="panel" key={`${doc._kind}-${docId}`}>
          <div className="manual-toolbar">
            <div>
              <b>{label}</b>
              <span className="muted small" style={{ marginLeft: 8 }}>{doc._kind === "aadhaar" ? "Submission ID" : "ID"}: {docId}</span>
            </div>
            <span aria-label={`${doc._kind === "aadhaar" ? "Aadhaar" : "Document"} status: ${status}`} style={{ padding: "3px 9px", borderRadius: 999, fontSize: 11, fontWeight: 600, background: status === "approved" ? "#e6f7ee" : status === "rejected" ? "#fff0f0" : "#fff7e6", color: status === "approved" ? "#18734f" : status === "rejected" ? "#ad3b42" : "#9a6b00", border: "1px solid #dce6f5" }}>{status}</span>
          </div>
          <dl className="profile-grid driver-detail-grid">
            <div className="profile-field"><dt>Submission date</dt><dd>{valueIsPresent(submissionDate) ? formatDateTime(submissionDate) : "Not returned by API"}</dd></div>
            <div className="profile-field"><dt>Version</dt><dd>{valueFor(doc, ["version", "version_number"]) ?? "-"}</dd></div>
            <div className="profile-field"><dt>Uploaded files</dt><dd>{fileCount}</dd></div>
            {currentReviewNote(doc, doc) && <div className="profile-field"><dt>Review note</dt><dd>{currentReviewNote(doc, doc)}</dd></div>}
            {valueFor(doc, ["rejection_reason", "reason"]) && <div className="profile-field"><dt>Rejection reason</dt><dd>{valueFor(doc, ["rejection_reason", "reason"])}</dd></div>}
          </dl>
          {status === "rejected" && <p className="muted small">This submission has already been reviewed. Re-review isn't available for this submission.</p>}
          {doc._kind === "aadhaar" && readStatus?.status === "error" && <Feedback message={`Could not load Aadhaar file count: ${readStatus.error}`} error/>}
          {isOwn && <div className="notice warning-notice"><ShieldCheck size={18}/><div><b>You cannot review your own documents.</b></div></div>}
          <div className="queue-pagination" style={{ marginTop: 8 }}>
            {actions.view && <button type="button" className="btn secondary" onClick={() => setPreviewDoc(previewDoc && recordId(previewDoc, previewDoc._kind === "aadhaar" ? ["submission_id", "id"] : ["document_id", "id"]) === docId && previewDoc._kind === doc._kind ? null : doc)}>{previewDoc && previewDoc._kind === doc._kind && recordId(previewDoc, previewDoc._kind === "aadhaar" ? ["submission_id", "id"] : ["document_id", "id"]) === docId ? "Hide Document" : "View Document"}</button>}
            {actions.approve && <button type="button" className="btn primary" disabled={reviewingId === reviewKey || isOwn} onClick={() => handleReview(doc, "approved")}>{reviewingId === reviewKey ? "Saving…" : "Approve"}</button>}
            {actions.reject && <button type="button" className="btn secondary" disabled={reviewingId === reviewKey || isOwn} onClick={() => setRejectingId(reviewKey)}>{reviewingId === reviewKey ? "Saving…" : "Reject"}</button>}
          </div>
          {actions.reject && rejectingId === reviewKey && <div className="manual-form" style={{ marginTop: 10 }}>
            <Field label="Rejection reason"><textarea minLength="3" maxLength="500" rows="3" value={rejectNote} onChange={e => setRejectNote(e.target.value)} required disabled={reviewingId === reviewKey}/></Field>
            <div className="queue-pagination">
              <button type="button" className="btn primary" disabled={reviewingId === reviewKey} onClick={() => handleReview(doc, "rejected", rejectNote)}>Submit rejection</button>
              <button type="button" className="btn secondary" disabled={reviewingId === reviewKey} onClick={() => { setRejectingId(""); setRejectNote(""); }}>Cancel</button>
            </div>
          </div>}
          {previewDoc && previewDoc._kind === doc._kind && recordId(previewDoc, previewDoc._kind === "aadhaar" ? ["submission_id", "id"] : ["document_id", "id"]) === docId && <KycFilePreview kind={doc._kind} record={doc} idKeys={doc._kind === "aadhaar" ? ["submission_id", "id"] : ["document_id", "id"]} metadata={doc._kind === "aadhaar" ? null : doc}/>}
        </div>;
      })}
    </div>;
  }

  const verificationStats = [
    { label: "Total drivers", value: summary.drivers, note: "Driver profiles in TaxiGo", icon: Users, tone: "blue" },
    { label: "Pending documents", value: summary.pending, note: "Awaiting admin review", icon: FileText, tone: "amber" },
    { label: "Approved documents", value: summary.approved, note: "Successfully verified", icon: ShieldCheck, tone: "green" },
    { label: "Rejected documents", value: summary.rejected, note: "Review history", icon: Activity, tone: "red" },
  ];
  const firstVisibleDriver = filteredDrivers.length ? (currentPage - 1) * perPage + 1 : 0;
  const lastVisibleDriver = Math.min(currentPage * perPage, filteredDrivers.length);
  return <div className="kyc-page manual-stack">
    <section className="kyc-summary" aria-label="Verification overview">
      {verificationStats.map(({ label, value, note, icon: Icon, tone }) => <article className="kyc-summary-card" key={label}>
        <span className={`kyc-summary-icon ${tone}`}><Icon size={17}/></span>
        <div><span>{label}</span><strong>{value}</strong><small>{note}</small></div>
      </article>)}
    </section>
    {summaryDetailsIncomplete && <div className="notice warning-notice"><ShieldCheck size={18}/><div><b>Some document counts may be incomplete</b><p>Driver details could not be loaded for every profile. Refresh to try again.</p></div></div>}
    {focus && <div className="notice warning-notice"><ShieldCheck size={18}/><div><b>Driver approval is waiting on a document</b><p>Review the latest {focus.documentKind || "required"} document for driver {focus.driverId || "shown in the filter"}, then return to Drivers and submit the approval again.</p></div></div>}
    <section className="panel kyc-queue-panel">
      <div className="manual-panel-head kyc-queue-head"><PanelTitle title="Driver Verification" subtitle="Status is approved only when all documents and vehicle rates are approved" icon={FileCheck2}/><RefreshButton onClick={loadData} busy={busy}/></div>
      <div className="kyc-queue-toolbar">
        <label className="manual-field kyc-search-field"><span>Search drivers</span><input type="search" value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} placeholder="Name, phone, or driver ID" aria-label="Search drivers by name, phone, or driver ID"/></label>
        <div className="kyc-queue-result"><strong>{filteredDrivers.length}</strong><span>{filteredDrivers.length === 1 ? "driver" : "drivers"}</span></div>
      </div>
      {message && <Feedback message={message} error={actionError}/>}
      {countErrors.length > 0 && <Feedback message="Some driver counts could not be loaded. Please refresh and try again." error/>}
      {filteredDrivers.length === 0 ? <div className="kyc-empty-state"><span><FileCheck2 size={20}/></span><b>{search.trim() ? "No drivers match your search" : "No drivers to verify yet"}</b><p>{search.trim() ? "Try a different name, phone number, or driver ID." : "Driver profiles will appear here when available."}</p></div> : <div className="kyc-table-wrap"><table className="kyc-table">
        <thead><tr><th className="kyc-number-col">#</th><th>Driver</th><th>Phone</th><th>Verification status</th><th>Documents submitted</th><th>Pending review</th><th className="kyc-action-col">Action</th></tr></thead>
        <tbody>{pagedDrivers.map((driver, index) => {
          const id = recordId(driver, ["driver_id", "id", "user_id", "driver.id", "user.id"]);
          const countState = driverCountDetails[id];
          const driverDocuments = docsForDriver(driver, countState?.status === "ready" ? countState.record : null, id);
          const counts = driverKycCounts(driverDocuments);
          const countDisplay = countState?.status === "ready" ? counts : null;
          const countValue = field => !id || countState?.status === "error" ? "Unavailable" : countDisplay ? countDisplay[field] : "Loading...";
          const verificationStatus = countState?.status === "ready"
            ? verificationStatusFromRequirements(driverDocuments, countState.record)
            : countState?.status === "error" || !id ? "pending" : "Loading...";
          const name = displayDriverName(driverLabel(driver));
          const phone = String(valueFor(driver, ["phone", "phone_number", "mobile", "mobile_number"]) || "-");
          const submitted = countValue("submitted");
          const pending = countValue("pending");
          return <tr key={id || index}>
            <td className="kyc-row-number">{(currentPage - 1) * perPage + index + 1}</td>
            <td><div className="kyc-driver-identity"><span className="kyc-driver-avatar">{String(name).trim().slice(0, 1).toUpperCase() || "D"}</span><span><strong>{name}</strong><small>{id || "Driver ID unavailable"}</small></span></div></td>
            <td className="kyc-phone">{phone}</td>
            <td><span className={`driver-document-status ${verificationStatus}`} aria-label={`Verification status: ${verificationStatus}`}>{verificationStatus}</span></td>
            <td><span className="kyc-count-value">{submitted}</span></td>
            <td><span className={`kyc-count-value ${Number(pending) > 0 ? "has-pending" : ""}`}>{pending}</span></td>
            <td><button type="button" className="kyc-review-button" disabled={!id} onClick={() => { setSelectedDriver(driver); setDocStatusFilter("all"); setPreviewDoc(null); setMessage(""); onOpenKycDriver?.(id); }}>Review documents<ChevronRight size={14}/></button></td>
          </tr>;
        })}</tbody>
      </table></div>}
      <div className="kyc-pagination"><span>Showing {firstVisibleDriver}-{lastVisibleDriver} of {filteredDrivers.length}</span><div className="queue-pagination"><button className="btn secondary" type="button" disabled={currentPage <= 1} onClick={() => setPage(current => Math.max(1, current - 1))}>Previous</button><span className="kyc-page-indicator">Page {currentPage} of {totalPages}</span><button className="btn secondary" type="button" disabled={currentPage >= totalPages} onClick={() => setPage(current => Math.min(totalPages, current + 1))}>Next</button></div></div>
    </section>
  </div>;
}


export default function AdminWorkspace({ section, onNavigate, focusDocument, adminProfile, driverId, onOpenDriver, onBackToDrivers, kycDriverId, onOpenKycDriver, onBackToKycDocuments, customerId, onOpenCustomer, onBackToCustomers, bookingId, onOpenBooking, onBackToBookings }) {
  if (section === "drivers" && driverId) return <DriverDetailsPage driverId={driverId} onBackToDrivers={onBackToDrivers} onNavigate={onNavigate}/>;
  if (section === "rides" && bookingId) return <BookingDetailsPage bookingId={bookingId} onBackToBookings={onBackToBookings}/>;
  const [title, description] = section === "customers" && customerId
    ? ["Customer details", "Review and manage this customer account."]
    : pageInfo[section] || ["Operations", "Manage TaxiGo operations."];
  let body;
  if (section === "drivers") body = <DriversPage onOpenDriver={onOpenDriver}/>;
  else if (section === "kyc") body = <KycPage focus={focusDocument} adminProfile={adminProfile} driverId={kycDriverId} onOpenKycDriver={onOpenKycDriver} onBackToKycDocuments={onBackToKycDocuments}/>;
  else if (section === "document-updates") body = <DocumentUpdates/>;
  else if (section === "rides") body = <RidesPage onOpenBooking={onOpenBooking}/>;
  else if (section === "communications") body = <CommunicationsPage/>;
  else if (section === "pricing") body = <PricingPage/>;
  else if (section === "configuration") body = <ConfigurationPage/>;
  else body = <CustomersPage customerId={customerId} onOpenCustomer={onOpenCustomer} onBackToCustomers={onBackToCustomers}/>;
  return <div className="manual-stack"><PageHeading title={title} description={description}/>{body}</div>;
}
