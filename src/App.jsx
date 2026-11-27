import React, { useEffect, useRef, useState, Component } from "react";
import {
  CarFront, Users, UserRound, FileCheck2, FileText, ShieldCheck, MapPinned,
  CircleDollarSign, LogOut, Menu, ChevronDown, ChevronRight, LayoutDashboard,
  Route, RefreshCw, CheckCircle2, AlertCircle, KeyRound, X,
  Gauge, Database, ArrowUpRight, MessageSquare, User,
  Phone, Mail, Key, Clock, CheckCircle
} from "lucide-react";
import { api, formatError } from "./api";
import { formatDateTime, recordsFrom, countFromPayload, hasMoreFromPayload, firstValue } from "./lib/parsing";
import { driverIdFromPath, driverDetailsPath, kycDriverIdFromPath, kycDriverDetailsPath } from "./lib/driverRoute.js";
import { customerIdFromPath, customerDetailsPath } from "./lib/customerRoute.js";
import { bookingIdFromPath, bookingDetailsPath } from "./lib/bookingRoute.js";
import { accountHeading, clearStoredAuthToken, dashboardListState, isAdminSectionRestricted, reviewQueueCountLabel, reviewQueueCounts } from "./lib/dashboardUi.js";
import { normalizeIndianPhone, isValidOtpCode } from "./lib/frontendValidation.js";
import AdminWorkspace from "./AdminWorkspace";
import "./dashboard.css";

const groups = [
  { title: "Overview", items: [{ id: "dashboard", label: "Dashboard", icon: LayoutDashboard }] },
  { title: "Operations", items: [
    { id: "drivers", label: "Drivers", icon: CarFront },
    { id: "kyc", label: "Driver Verification", icon: FileCheck2 },
    { id: "document-updates", label: "Document updates", icon: FileText },
    { id: "rides", label: "Rides & Bookings", icon: Route },
    { id: "communications", label: "Callbacks & Messages", icon: MessageSquare },
  ]},
  { title: "Platform", items: [
    { id: "pricing", label: "Categories & Offers", icon: CircleDollarSign },
    { id: "configuration", label: "Areas & Routes", icon: MapPinned },
    { id: "customers", label: "Customers", icon: Users },
    { id: "account", label: "Admin Account", icon: ShieldCheck },
  ]}
];
const visibleSectionIds = new Set(groups.flatMap(group => group.items.map(item => item.id)));

class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  componentDidCatch(error, info) {
    console.error("[ErrorBoundary] Caught error:", error, info);
  }
  reset() {
    this.setState({ hasError: false, error: null });
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: "2rem", textAlign: "center" }}>
          <h2 style={{ color: "#dc2626", marginBottom: "0.5rem" }}>Something went wrong</h2>
          <p style={{ color: "#6b7280", marginBottom: "1rem" }}>
            {this.state.error?.message || "An unexpected error occurred."}
          </p>
          <button
            type="button"
            style={{ padding: "0.5rem 1.25rem", borderRadius: "6px", background: "#2563eb", color: "#fff", border: "none", cursor: "pointer" }}
            onClick={() => { this.reset(); window.location.reload(); }}
          >
            Reload page
          </button>
          <button
            type="button"
            style={{ marginLeft: "0.75rem", padding: "0.5rem 1.25rem", borderRadius: "6px", background: "#e5e7eb", color: "#374151", border: "none", cursor: "pointer" }}
            onClick={() => this.reset()}
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function Icon({ icon: I, size = 18 }) { return <I size={size} strokeWidth={1.8} />; }
function Button({ children, onClick, variant = "primary", disabled = false }) {
  return <button type="button" className={`btn ${variant}`} onClick={onClick} disabled={disabled}>{children}</button>;
}
const adminRoles = new Set(["admin", "administrator", "super_admin", "super-admin", "superadmin", "platform_admin", "platform-admin"]);
function roleNames(value) {
  if (Array.isArray(value)) return value.flatMap(roleNames);
  if (value && typeof value === "object") return [value.name, value.code, value.key, value.slug, value.role].flatMap(roleNames);
  return typeof value === "string" && value.trim() ? [value.trim().toLowerCase()] : [];
}
function profileRoleNames(profile) {
  return [profile?.role, profile?.user_type, profile?.account_type, profile?.roles, profile?.role_claims].flatMap(roleNames);
}
function withoutAccessTokens(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const safe = { ...value };
  delete safe.access_token; delete safe.accessToken; delete safe.token;
  return safe;
}
function accountProfile(data) {
  const payload = data?.data || data;
  const nested = payload?.user || payload?.profile;
  const safePayload = withoutAccessTokens(payload);
  if (!nested || typeof nested !== "object") return safePayload;
  const safeNested = withoutAccessTokens(nested);
  return {
    ...safePayload,
    ...safeNested,
    roles: [...profileRoleNames(payload), ...profileRoleNames(nested)],
    is_admin: payload?.is_admin === true || nested?.is_admin === true,
    is_superuser: payload?.is_superuser === true || nested?.is_superuser === true,
  };
}
function mergeAccountProfiles(...profiles) {
  const validProfiles = profiles.filter(profile => profile && typeof profile === "object");
  if (!validProfiles.length) return null;
  return {
    ...Object.assign({}, ...validProfiles),
    roles: validProfiles.flatMap(profileRoleNames),
    is_admin: validProfiles.some(profile => profile.is_admin === true),
    is_superuser: validProfiles.some(profile => profile.is_superuser === true),
  };
}
function isAdminProfile(profile) {
  return profile?.is_admin === true || profile?.is_superuser === true || profileRoleNames(profile).some(role => adminRoles.has(role));
}
function accountRole(profile) {
  const roles = profileRoleNames(profile);
  const role = roles.find(candidate => adminRoles.has(candidate)) || (isAdminProfile(profile) ? "admin" : roles[0] || "user");
  return role.replace(/[_-]/g, " ").replace(/\b\w/g, letter => letter.toUpperCase());
}

function apiRecordCount(data) {
  const payload = data?.data ?? data;
  if (Array.isArray(payload)) return payload.length;
  const containers = [payload, payload?.data, payload?.meta, payload?.pagination, payload?.page];
  for (const container of containers) {
    if (!container || typeof container !== "object" || Array.isArray(container)) continue;
    for (const key of ["total", "count", "total_count", "totalCount", "total_records", "totalRecords", "record_count", "recordCount"]) {
      const value = container[key];
      if (typeof value === "number" && Number.isFinite(value)) return value;
      if (typeof value === "string" && /^\\d+$/.test(value.trim())) return Number(value);
    }
  }
  if (Array.isArray(payload?.items)) return payload.items.length;
  if (Array.isArray(payload?.results)) return payload.results.length;
  if (Array.isArray(payload?.records)) return payload.records.length;
  return null;
}

function normalizedBookingStatus(booking) {
  const rawStatus = firstValue(booking, ["status", "booking_status", "ride_status", "trip_status"]);
  const status = rawStatus && typeof rawStatus === "object"
    ? firstValue(rawStatus, ["code", "value", "name", "status"])
    : rawStatus;
  return String(status ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_").replace(/^_+|_+$/g, "");
}

function isCompletedBooking(booking) {
  const status = normalizedBookingStatus(booking);
  return /(?:^|_)(?:complete|completed|finished|done)$/.test(status);
}

function isTerminalBooking(booking) {
  const status = normalizedBookingStatus(booking);
  return isCompletedBooking(booking)
    || status.includes("cancel")
    || ["rejected", "expired", "failed", "no_show", "noshow"].includes(status);
}


function App() {
  const [active, setActive] = useState(() => {
    const pathname = window.location.pathname.replace(/\/$/, "") || "/";
    if (driverIdFromPath(pathname) || pathname === "/drivers") return "drivers";
    if (pathname === "/kyc" || kycDriverIdFromPath(pathname)) return "kyc";
    if (pathname === "/customers" || customerIdFromPath(pathname)) return "customers";
    if (pathname === "/bookings" || bookingIdFromPath(pathname)) return "rides";
    return "dashboard";
  });
  const [driverId, setDriverId] = useState(() => driverIdFromPath(window.location.pathname));
  const [kycDriverId, setKycDriverId] = useState(() => kycDriverIdFromPath(window.location.pathname));
  const [customerId, setCustomerId] = useState(() => customerIdFromPath(window.location.pathname));
  const [bookingId, setBookingId] = useState(() => bookingIdFromPath(window.location.pathname));
  const [kycFocus, setKycFocus] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [authStatus, setAuthStatus] = useState(sessionStorage.getItem("taxigo_access_token") ? "checking" : "signedOut");
  const [me, setMe] = useState(null);
  const [health, setHealth] = useState("Checking");
  const [driverCount, setDriverCount] = useState(null);
  const [openBookingCount, setOpenBookingCount] = useState(null);
  const [completedBookingCount, setCompletedBookingCount] = useState(null);
  const [queueCount, setQueueCount] = useState(null);
  const [updateRequestCount, setUpdateRequestCount] = useState(null);
  const [aadhaarQueueCount, setAadhaarQueueCount] = useState(null);
  const [documentQueueCount, setDocumentQueueCount] = useState(null);
  const [aadhaarQueueError, setAadhaarQueueError] = useState("");
  const [documentQueueError, setDocumentQueueError] = useState("");
  const [rideRequestCount, setRideRequestCount] = useState(null);
  const [recent, setRecent] = useState([]);
  const [overviewRefreshing, setOverviewRefreshing] = useState(false);
  const [overviewLastUpdated, setOverviewLastUpdated] = useState(null);
  const [globalError, setGlobalError] = useState("");
  const [otpPhone, setOtpPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [authChallengeId, setAuthChallengeId] = useState("");
  const [authStep, setAuthStep] = useState("request");
  const [authMessage, setAuthMessage] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const previousDashboardActive = useRef(active === "dashboard");
  const overviewRequestRef = useRef(0);

  useEffect(() => {
    const handler = () => {
      setMe(null); setAuthStatus("signedOut"); setAuthMessage("Your session expired. Please sign in again.");
    };
    window.addEventListener("taxigo:unauthorized", handler);
    return () => window.removeEventListener("taxigo:unauthorized", handler);
  }, []);

  useEffect(() => {
    function handlePopState() {
      const pathname = window.location.pathname.replace(/\/$/, "") || "/";
      const id = driverIdFromPath(pathname);
      const kycId = kycDriverIdFromPath(pathname);
      const customerId = customerIdFromPath(pathname);
      const bookingId = bookingIdFromPath(pathname);
      const isDriverList = pathname === "/drivers";
      const isKycRoute = pathname === "/kyc" || Boolean(kycId);
      const isCustomerList = pathname === "/customers";
      const isBookingsList = pathname === "/bookings";
      const historySection = window.history.state?.taxigoSection;
      const validSection = visibleSectionIds.has(historySection) ? historySection : "dashboard";
      setDriverId(id);
      setKycDriverId(kycId);
      setCustomerId(customerId);
      setBookingId(bookingId);
      setActive(id || isDriverList ? "drivers" : isKycRoute ? "kyc" : customerId || isCustomerList ? "customers" : bookingId || isBookingsList ? "rides" : validSection);
    }
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  function navigate(section, focus = null) {
    const pathname = window.location.pathname.replace(/\/$/, "") || "/";
    const onDriverRoute = /^\/drivers(?:\/|$)/.test(pathname);
    const onKycRoute = /^\/kyc(?:\/|$)/.test(pathname);
    const onCustomerRoute = /^\/customers(?:\/|$)/.test(pathname);
    const onBookingRoute = /^\/bookings(?:\/|$)/.test(pathname);
    if (section === "drivers") {
      if (pathname !== "/drivers") {
        window.history.replaceState({ ...(window.history.state || {}), taxigoSection: active }, "", pathname);
        window.history.pushState({ taxigoSection: "drivers" }, "", "/drivers");
      }
      setDriverId("");
      setKycDriverId("");
      setCustomerId("");
      setBookingId("");
    } else if (section === "kyc") {
      if (pathname !== "/kyc") window.history.pushState({ taxigoSection: "kyc" }, "", "/kyc");
      setDriverId("");
      setKycDriverId("");
      setCustomerId("");
      setBookingId("");
    } else if (section === "customers") {
      if (pathname !== "/customers") window.history.pushState({ taxigoSection: "customers" }, "", "/customers");
      setDriverId("");
      setKycDriverId("");
      setCustomerId("");
      setBookingId("");
    } else if (section === "rides") {
      if (pathname !== "/bookings") window.history.pushState({ taxigoSection: "rides" }, "", "/bookings");
      setDriverId("");
      setKycDriverId("");
      setCustomerId("");
      setBookingId("");
    } else if (onDriverRoute || onKycRoute || onCustomerRoute || onBookingRoute) {
      window.history.pushState({ taxigoSection: section }, "", "/");
      setDriverId("");
      setKycDriverId("");
      setCustomerId("");
      setBookingId("");
    }
    setActive(section);
    setKycFocus(section === "kyc" ? focus : null);
  }

  function openDriver(id) {
    const driverPath = driverDetailsPath(id);
    window.history.pushState({ taxigoDriverDetails: true, fromDriverList: window.location.pathname.replace(/\/$/, "") === "/drivers" }, "", driverPath);
    setDriverId(String(id));
    setKycDriverId("");
    setCustomerId("");
    setBookingId("");
    setActive("drivers");
    setSidebarOpen(false);
  }

  function backToDrivers() {
    if (window.history.state?.taxigoDriverDetails && window.history.state?.fromDriverList) {
      window.history.back();
      return;
    }
    window.history.pushState({ taxigoSection: "drivers" }, "", "/drivers");
    setDriverId("");
    setKycDriverId("");
    setCustomerId("");
    setBookingId("");
    setActive("drivers");
  }

  function openKycDriver(id) {
    const fromKycList = window.location.pathname.replace(/\/$/, "") === "/kyc";
    window.history.pushState({ taxigoSection: "kyc", taxigoKycDetail: true, fromKycList }, "", kycDriverDetailsPath(id));
    setDriverId("");
    setKycDriverId(String(id));
    setCustomerId("");
    setBookingId("");
    setActive("kyc");
    setSidebarOpen(false);
  }

  function backToKycDocuments() {
    const onKycDriverRoute = Boolean(kycDriverIdFromPath(window.location.pathname));
    if (onKycDriverRoute && window.history.state?.taxigoKycDetail && window.history.state?.fromKycList) {
      window.history.back();
      return;
    }
    window.history.replaceState({ taxigoSection: "kyc" }, "", "/kyc");
    setDriverId("");
    setKycDriverId("");
    setCustomerId("");
    setBookingId("");
    setActive("kyc");
  }

  function openCustomer(id) {
    const fromCustomerList = window.location.pathname.replace(/\/$/, "") === "/customers";
    window.history.pushState({ taxigoCustomerDetails: true, fromCustomerList }, "", customerDetailsPath(id));
    setDriverId("");
    setKycDriverId("");
    setCustomerId(String(id));
    setBookingId("");
    setActive("customers");
    setSidebarOpen(false);
  }

  function backToCustomers() {
    if (customerIdFromPath(window.location.pathname) && window.history.state?.taxigoCustomerDetails && window.history.state?.fromCustomerList) {
      window.history.back();
      return;
    }
    window.history.pushState({ taxigoSection: "customers" }, "", "/customers");
    setDriverId("");
    setKycDriverId("");
    setCustomerId("");
    setBookingId("");
    setActive("customers");
  }

  function openBooking(id) {
    const fromBookingsList = window.location.pathname.replace(/\/$/, "") === "/bookings";
    window.history.pushState({ taxigoBookingDetails: true, fromBookingsList }, "", bookingDetailsPath(id));
    setDriverId("");
    setKycDriverId("");
    setCustomerId("");
    setBookingId(String(id));
    setActive("rides");
    setSidebarOpen(false);
  }

  function backToBookings() {
    if (bookingIdFromPath(window.location.pathname) && window.history.state?.taxigoBookingDetails && window.history.state?.fromBookingsList) {
      window.history.back();
      return;
    }
    window.history.pushState({ taxigoSection: "rides" }, "", "/bookings");
    setDriverId("");
    setKycDriverId("");
    setCustomerId("");
    setBookingId("");
    setActive("rides");
  }

  async function fetchAllAdminBookings() {
    const perPage = 100;
    const bookingsById = new Map();
    const bookingsWithoutId = [];
    const bookingsWithoutIdSignatures = new Set();
    for (let page = 1; page <= 1000; page += 1) {
      const response = await api.get("/api/v1/admin/bookings", { params: { page, per_page: perPage } });
      const batch = recordsFrom(response.data);
      let added = 0;
      for (const booking of batch) {
        const id = firstValue(booking, ["booking_id", "id"]);
        if (id === undefined || id === null || String(id).trim() === "") {
          const signature = JSON.stringify(booking);
          if (!bookingsWithoutIdSignatures.has(signature)) {
            bookingsWithoutIdSignatures.add(signature);
            bookingsWithoutId.push(booking);
            added += 1;
          }
        } else {
          const key = String(id);
          if (!bookingsById.has(key)) added += 1;
          bookingsById.set(key, booking);
        }
      }
      const hasMore = hasMoreFromPayload(response.data);
      const total = countFromPayload(response.data);
      const uniqueCount = bookingsById.size + bookingsWithoutId.length;
      if (hasMore === false || batch.length === 0 || added === 0) break;
      if (total != null) {
        if (uniqueCount >= total) break;
        continue;
      }
      if (hasMore === true) continue;
      if (batch.length < perPage) break;
    }
    return [...bookingsById.values(), ...bookingsWithoutId];
  }

  async function fetchAllAdminRideRequests() {
    const perPage = 20;
    const requestsById = new Map();
    const requestsWithoutId = [];
    const requestsWithoutIdSignatures = new Set();
    for (let page = 1; page <= 1000; page += 1) {
      const response = await api.get("/api/v1/admin/ride-requests", { params: { page, per_page: perPage } });
      const batch = recordsFrom(response.data);
      let added = 0;
      for (const request of batch) {
        const id = firstValue(request, ["request_id", "ride_request_id", "id"]);
        if (id === undefined || id === null || String(id).trim() === "") {
          const signature = JSON.stringify(request);
          if (!requestsWithoutIdSignatures.has(signature)) {
            requestsWithoutIdSignatures.add(signature);
            requestsWithoutId.push(request);
            added += 1;
          }
        } else {
          const key = String(id);
          if (!requestsById.has(key)) added += 1;
          requestsById.set(key, request);
        }
      }
      if (batch.length < perPage || hasMoreFromPayload(response.data) === false || (batch.length > 0 && added === 0)) break;
    }
    return [...requestsById.values(), ...requestsWithoutId];
  }

  async function fetchAdminReviewQueueCount(endpoint) {
    const perPage = 100;
    let offset = 0;
    let count = 0;
    for (let page = 0; page < 1000; page += 1) {
      const response = await api.get(endpoint, { params: { offset, limit: perPage } });
      const total = countFromPayload(response.data);
      if (total != null) return total;
      const batch = recordsFrom(response.data);
      count += batch.length;
      if (hasMoreFromPayload(response.data) === false || batch.length < perPage) return count;
      offset += batch.length;
    }
    return count;
  }

  async function loadOverview(profile = me) {
    const requestId = ++overviewRequestRef.current;
    setOverviewRefreshing(true);
    setGlobalError("");
    try {
      const admin = isAdminProfile(profile);
      if (admin) {
        setQueueCount(null);
        setAadhaarQueueCount(null);
        setDocumentQueueCount(null);
        setAadhaarQueueError("");
        setDocumentQueueError("");
      }
      const requests = [api.get("/api/v1/health/live"), api.get("/api/v1/health/ready")];
      if (admin) {
        const loadQueueCount = (endpoint, setCount, setQueueError) => fetchAdminReviewQueueCount(endpoint)
          .then(count => {
            if (requestId === overviewRequestRef.current) {
              setCount(count);
              setQueueError("");
            }
            return count;
          })
          .catch(error => {
            if (requestId === overviewRequestRef.current) {
              setCount(null);
              setQueueError(formatError(error));
            }
            throw error;
          });
        requests.push(
          api.get("/api/v1/admin/drivers"),
          fetchAllAdminBookings(),
          loadQueueCount("/api/v1/admin/aadhaar", setAadhaarQueueCount, setAadhaarQueueError),
          loadQueueCount("/api/v1/admin/documents", setDocumentQueueCount, setDocumentQueueError),
          fetchAllAdminRideRequests()
        );
      }
      const results = await Promise.allSettled(requests);
      if (requestId !== overviewRequestRef.current) return;
      const [h, ready, d, b, q, docs, r] = results;
      const isLive = h.status === "fulfilled";
      const isReady = ready.status === "fulfilled";
      setHealth(isLive ? "Online" : "Unavailable");
      if (!admin) {
        setDriverCount(null); setOpenBookingCount(null); setCompletedBookingCount(null); setRideRequestCount(null); setQueueCount(null);
        setAadhaarQueueCount(null); setDocumentQueueCount(null); setAadhaarQueueError(""); setDocumentQueueError("");
        setRecent([
          { label: "Service status (live)", state: isLive ? "Healthy" : "Unavailable", tone: isLive ? "success" : "danger" },
          { label: "Service status (ready)", state: isReady ? "Ready" : "Not ready", tone: isReady ? "success" : "warning" },
          { label: "Current account", state: "Authenticated", tone: "success" },
        ]);
        if (!isLive) setGlobalError("Could not reach TaxiGo. Check backend availability and connection settings.");
        return;
      }
      if (d.status === "fulfilled") { setDriverCount(countFromPayload(d.value.data)); } else setDriverCount(null);
      const reviewCounts = reviewQueueCounts(q, docs);
      setAadhaarQueueCount(reviewCounts.aadhaarCount);
      setDocumentQueueCount(reviewCounts.documentCount);
      setQueueCount(reviewCounts.total);
      if (b.status === "fulfilled") {
        const bookingRows = b.value;
        const openCount = bookingRows.filter(item => Boolean(normalizedBookingStatus(item)) && !isTerminalBooking(item)).length;
        const completedCount = bookingRows.filter(isCompletedBooking).length;
        setOpenBookingCount(openCount);
        setCompletedBookingCount(completedCount);
      } else {
        setOpenBookingCount(null);
        setCompletedBookingCount(null);
      }
      if (r && r.status === "fulfilled") {
        const openStatuses = new Set(["open", "pending"]);
        const openCount = r.value.filter(item => {
          const status = String(firstValue(item, ["status", "request_status"]) || "")
            .trim().toLowerCase().replace(/[\s-]+/g, "_");
          return openStatuses.has(status);
        }).length;
        setRideRequestCount(openCount);
      } else if (r) {
        setRideRequestCount(null);
      }
      const failed = results.filter(result => result.status === "rejected");
      if (failed.length === results.length) setGlobalError("Could not load the overview. Check service availability, connection settings, and account access.");
      setRecent([
        { label: "Service status (live)", state: isLive ? "Healthy" : "Unavailable", tone: isLive ? "success" : "danger" },
        { label: "Service status (ready)", state: isReady ? "Ready" : "Not ready", tone: isReady ? "success" : "warning" },
        { label: "Admin account", state: "Signed in", tone: "success" },
        { label: "Driver records", state: d.status === "fulfilled" ? "Available" : "Needs access", tone: d.status === "fulfilled" ? "success" : "warning" },
        { label: "Bookings", state: b.status === "fulfilled" ? "Accessible" : "Needs access", tone: b.status === "fulfilled" ? "success" : "warning" },
      ]);
    } catch (error) {
      if (requestId === overviewRequestRef.current) setGlobalError(formatError(error));
    } finally {
      if (requestId === overviewRequestRef.current) {
        setOverviewRefreshing(false);
        setOverviewLastUpdated(new Date());
      }
    }
  }
  useEffect(() => {
    const wasDashboardActive = previousDashboardActive.current;
    previousDashboardActive.current = active === "dashboard";
    if (!wasDashboardActive && active === "dashboard" && authStatus === "authenticated" && isAdminProfile(me)) {
      loadOverview(me);
    }
  }, [active, authStatus, me]);
  useEffect(() => {
    if (!sessionStorage.getItem("taxigo_access_token")) return;
    let cancelled = false;
    (async () => {
      try {
        const response = await api.get("/api/v1/me");
        const profile = accountProfile(response.data);
        if (!profile || typeof profile !== "object") throw new Error("The account profile was not returned by the API.");
        if (cancelled) return;
        setMe(profile); setAuthStatus("authenticated");
        await loadOverview(profile);
      } catch {
        if (cancelled) return;
        sessionStorage.removeItem("taxigo_access_token");
        setMe(null); setAuthStatus("signedOut");
        setAuthMessage("Your session expired or could not be verified. Please sign in again.");
      }
    })();
    return () => { cancelled = true; };
  }, []);

  async function requestOtp(e) {
    e.preventDefault(); setAuthMessage("");
    const phone = normalizeIndianPhone(otpPhone);
    if (!phone) {
      setAuthMessage("Enter a valid 10-digit Indian mobile number.");
      return;
    }
    setAuthBusy(true);
    try {
      const res = await api.post("/api/v1/auth/otp/request", { phone });
      const challengeId = res.data?.challenge_id ?? res.data?.data?.challenge_id;
      if (challengeId === undefined || challengeId === null || challengeId === "") {
        setAuthMessage("We couldn't start sign-in. Please try again.");
        return;
      }
      // Non-production backends echo the code; prefill it when present and well-formed.
      const echoedOtp = String(res.data?.otp ?? res.data?.data?.otp ?? "").trim();
      setOtp(isValidOtpCode(echoedOtp) ? echoedOtp : "");
      setAuthChallengeId(String(challengeId)); setAuthStep("verify");
      setAuthMessage(String(res.data?.message || res.data?.data?.message || "Code sent. Enter it below to sign in."));
    } catch (e) { setAuthMessage(formatError(e)); }
    finally { setAuthBusy(false); }
  }
  async function verifyOtp(e) {
    e.preventDefault(); setAuthMessage("");
    if (!isValidOtpCode(otp)) {
      setAuthMessage("Enter the 4–10 digit code you received.");
      return;
    }
    setAuthBusy(true);
    try {
      const res = await api.post("/api/v1/auth/otp/verify", { challenge_id: authChallengeId, code: otp });
      const payload = res.data?.data || res.data;
      const access = payload?.access_token || payload?.accessToken || payload?.token;
      if (access) {
        sessionStorage.setItem("taxigo_access_token", access);
        const profileResponse = await api.get("/api/v1/me");
        const profile = mergeAccountProfiles(accountProfile(payload), accountProfile(profileResponse.data));
        if (!profile || typeof profile !== "object") throw new Error("The account profile was not returned by the API.");
        const requestedDriverId = driverIdFromPath(window.location.pathname);
        const requestedKycDriverId = kycDriverIdFromPath(window.location.pathname);
        const requestedPath = window.location.pathname.replace(/\/$/, "") || "/";
        const requestedCustomerId = customerIdFromPath(requestedPath);
        const requestedBookingId = bookingIdFromPath(requestedPath);
        const requestedSection = requestedDriverId || requestedPath === "/drivers" ? "drivers"
          : requestedKycDriverId || requestedPath === "/kyc" ? "kyc"
            : requestedCustomerId || requestedPath === "/customers" ? "customers"
              : requestedBookingId || requestedPath === "/bookings" ? "rides" : "dashboard";
        setMe(profile); setAuthStatus("authenticated"); setActive(requestedSection); setDriverId(requestedDriverId); setKycDriverId(requestedKycDriverId); setCustomerId(requestedCustomerId); setBookingId(requestedBookingId); setKycFocus(null); setGlobalError("");
        setAuthStep("request"); setOtp(""); setAuthChallengeId(""); setAuthMessage("");
        await loadOverview(profile);
      } else setAuthMessage("Sign-in couldn't be completed. Please try again.");
    } catch (e) {
      sessionStorage.removeItem("taxigo_access_token");
      setMe(null); setAuthStatus("signedOut");
      setAuthMessage(formatError(e));
    }
    finally { setAuthBusy(false); }
  }

  async function logout() {
    const access = sessionStorage.getItem("taxigo_access_token");
    clearStoredAuthToken(sessionStorage);
    if (access) api.post("/api/v1/auth/logout", null, { headers: { Authorization: `Bearer ${access}` } }).catch(() => {});
    if (/^\/(?:drivers|kyc|customers|bookings)(?:\/|$)/.test(window.location.pathname)) window.history.replaceState({}, "", "/");
    setMe(null); setAuthStatus("signedOut"); setActive("dashboard"); setDriverId(""); setKycDriverId(""); setCustomerId(""); setBookingId(""); setKycFocus(null); setSidebarOpen(false);
    setAuthStep("request"); setOtp(""); setAuthChallengeId(""); setAuthMessage("You have been signed out.");
  }

  const admin = isAdminProfile(me);
  useEffect(() => {
    if (!admin || authStatus !== "authenticated") { setUpdateRequestCount(null); return undefined; }
    let active = true;
    const refresh = () => api.get("/api/v1/admin/document-update-requests", { params: { page: 1, per_page: 1 } })
      .then(response => { if (active) setUpdateRequestCount(Number(response.data?.counts?.requested || 0)); })
      .catch(() => { if (active) setUpdateRequestCount(null); });
    refresh();
    window.addEventListener("taxigo:document-updates-changed", refresh);
    return () => { active = false; window.removeEventListener("taxigo:document-updates-changed", refresh); };
  }, [admin, authStatus]);
  const restrictedAdminSection = isAdminSectionRestricted(admin, active);
  const visibleGroups = admin ? groups : [
    { title: "Overview", items: [{ id: "dashboard", label: "Dashboard", icon: LayoutDashboard }] },
    { title: "Account", items: [{ id: "account", label: "My account", icon: UserRound }] },
  ];
  const title = driverId && admin ? "Driver details" : customerId ? "Customer details" : bookingId ? "Booking details" : visibleGroups.flatMap(g => g.items).find(i => i.id === active)?.label || "Dashboard";
  const accountName = me?.full_name || me?.name || me?.phone || me?.email || "Account";
  const roleLabel = accountRole(me);
  if (authStatus === "checking") return <AuthLoading />;
  if (authStatus !== "authenticated") return <LoginScreen phone={otpPhone} setPhone={setOtpPhone} otp={otp} setOtp={setOtp} step={authStep} setStep={setAuthStep} setChallengeId={setAuthChallengeId} setMessage={setAuthMessage} busy={authBusy} message={authMessage} requestOtp={requestOtp} verifyOtp={verifyOtp} />;

  return <div className="app-shell">
    <aside className={`sidebar ${sidebarOpen ? "open" : ""}`}>
      <div className="brand"><div className="brand-mark"><CarFront size={26}/></div><div><b>TaxiGo</b><span>{admin ? "ADMIN DASHBOARD" : "ACCOUNT PORTAL"}</span></div></div>
      <div className="workspace"><div className="workspace-dot">T</div><div><b>TaxiGo Platform</b><span>Management workspace</span></div><ChevronDown size={15}/></div>
      <nav>{visibleGroups.map(group => <div className="nav-group" key={group.title}><div className="nav-label">{group.title}</div>{group.items.map(item => <button key={item.id} className={`nav-item ${active === item.id ? "active" : ""}`} onClick={() => {navigate(item.id);setSidebarOpen(false);}}><Icon icon={item.icon}/><span>{item.label}</span>{item.id === "kyc" && queueCount != null && <i>{queueCount}</i>}{item.id === "document-updates" && updateRequestCount != null && <i>{updateRequestCount}</i>}</button>)}</div>)}</nav>
      <div className="sidebar-bottom"><div className="api-status"><span className={`pulse ${health === "Online" ? "good" : ""}`}/><div><b>Backend {health}</b><small>FastAPI service</small></div></div></div>
    </aside>
    {sidebarOpen && <button className="scrim" onClick={() => setSidebarOpen(false)} aria-label="Close menu"/>}
    <main className="main-area">
      <header className="topbar">
        <button className="icon-btn menu-btn" onClick={() => setSidebarOpen(!sidebarOpen)}><Menu size={21}/></button>
        <div className="crumb"><span>TaxiGo</span><ChevronRight size={15}/><b>{title}</b></div>
        <div className="top-actions"><div className="connection"><span className={`pulse ${health === "Online" ? "good" : ""}`}/>{health}</div><div className="avatar">{String(accountName).slice(0,1).toUpperCase()}</div><div className="admin-meta"><b>{accountName}</b><span>{roleLabel}</span></div><button className="icon-btn" title="Sign out" onClick={logout}><LogOut size={17}/></button></div>
      </header>

      <div className="page-content">
        {globalError && <div className="notice warning-notice"><AlertCircle size={18}/><div><b>Overview data unavailable</b><p>{globalError} Some admin endpoints may also be unavailable for the current role.</p></div><button className="icon-btn" onClick={() => setGlobalError("")}><X size={16}/></button></div>}
        {restrictedAdminSection && <div className="notice warning-notice" role="alert"><AlertCircle size={18}/><div><b>Admin access required</b><p>This section is available only to authorized TaxiGo administrators. No admin data or actions are available in this account.</p><button type="button" className="btn secondary" onClick={() => navigate("dashboard")}>Return to dashboard</button></div></div>}
        {!driverId && active === "dashboard" && (admin
          ? <Dashboard health={health} driverCount={driverCount} openBookingCount={openBookingCount} completedBookingCount={completedBookingCount} rideRequestCount={rideRequestCount} queueCount={queueCount} aadhaarQueueCount={aadhaarQueueCount} documentQueueCount={documentQueueCount} aadhaarQueueError={aadhaarQueueError} documentQueueError={documentQueueError} recent={recent} refreshing={overviewRefreshing} lastUpdated={overviewLastUpdated} onNavigate={navigate} onRefresh={() => loadOverview(me)} />
          : <UserDashboard profile={me} health={health} onNavigate={navigate} onLogout={logout} />)}
        {!driverId && active === "account" && <section className="content-grid"><div className="panel full"><PanelTitle title="Current account" subtitle="Your signed-in TaxiGo profile" icon={UserRound}/><AccountSummary profile={me} onLogout={logout}/></div></section>}
        {admin && !["dashboard", "account"].includes(active) && <ErrorBoundary><AdminWorkspace section={active} onNavigate={navigate} focusDocument={kycFocus} adminProfile={me} driverId={active === "drivers" ? driverId : ""} kycDriverId={active === "kyc" ? kycDriverId : ""} customerId={active === "customers" ? customerId : ""} bookingId={active === "rides" ? bookingId : ""} onOpenDriver={openDriver} onBackToDrivers={backToDrivers} onOpenKycDriver={openKycDriver} onBackToKycDocuments={backToKycDocuments} onOpenCustomer={openCustomer} onBackToCustomers={backToCustomers} onOpenBooking={openBooking} onBackToBookings={backToBookings}/></ErrorBoundary>}
      </div>
      <footer><span>TaxiGo {admin ? "Admin Dashboard" : "Account Portal"}</span><span>{admin ? "Admin workspace" : "Personal account"}</span></footer>
    </main>
  </div>;
}

function AuthLoading() {
  return <main className="auth-screen"><div className="auth-loading"><span className="brand-mark"><CarFront size={25}/></span><RefreshCw size={17} className="spin"/><span>Checking your session…</span></div></main>;
}

function LoginScreen({ phone, setPhone, otp, setOtp, step, setStep, setChallengeId, setMessage, busy, message, requestOtp, verifyOtp }) {
  const submit = step === "request" ? requestOtp : verifyOtp;
  return <main className="auth-screen">
    <section className="auth-card">
      <div className="auth-brand"><span className="brand-mark"><CarFront size={25}/></span><div><b>TaxiGo</b><span>ACCOUNT ACCESS</span></div></div>
      <div className="auth-heading"><span className="auth-icon"><KeyRound size={21}/></span><div><p className="eyebrow">SECURE SIGN IN</p><h1>{step === "request" ? "Welcome back" : "Verify your number"}</h1><p>{step === "request" ? "Sign in to your TaxiGo account with a one-time code." : `Enter the code sent to ${phone}.`}</p></div></div>
      <form onSubmit={submit} className="auth-form" noValidate>
        {step === "request" ? <label htmlFor="login-phone">Phone number<input id="login-phone" type="tel" autoComplete="tel-national" maxLength={16} value={phone} onChange={e => { setPhone(e.target.value); setMessage(""); }} placeholder="10-digit mobile number" required /></label>
          : <><label htmlFor="login-phone-verify">Phone number<input id="login-phone-verify" type="tel" autoComplete="tel" value={phone} readOnly /></label><label htmlFor="login-otp">One-time code<input id="login-otp" type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={10} value={otp} onChange={e => { setOtp(e.target.value); setMessage(""); }} placeholder="Enter the 4–10 digit code" required /></label></>}
        {message && <div className="auth-message" role="status">{message}</div>}
        <button className="btn primary auth-submit" disabled={busy}>{busy ? <><RefreshCw size={15} className="spin"/> Please wait…</> : step === "request" ? "Send sign-in code" : "Verify & sign in"}</button>
        {step === "verify" && <button type="button" className="auth-back" onClick={() => {setStep("request");setOtp("");setChallengeId("");setMessage("");}}>Use a different phone number</button>}
      </form>
      <div className="auth-footnote"><ShieldCheck size={15}/><span>Your account role is verified by TaxiGo after sign-in. Admin tools appear only for authorized admins.</span></div>
    </section>
    <p className="auth-caption">TaxiGo · Secure account access</p>
  </main>;
}

function AccountSummary({ profile, onLogout }) {
  const admin = isAdminProfile(profile);
  const displayName = profile?.full_name || profile?.name || (admin ? "Admin" : "Account");
  const initials = displayName
    .split(/\s+/)
    .map(part => part[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  const email = profile?.email || "Not provided";
  const phone = profile?.phone || "Not provided";
  const role = accountRole(profile) || "Admin";
  const accountId = profile?.id ?? profile?.user_id ?? "—";

  return (
    <section className="account-page">
      <div className="account-header">
        <div className="account-avatar">{initials}</div>
        <div className="account-info">
          <div className="account-welcome">
            <span className="account-eyebrow">{accountHeading(admin)}</span>
            <h1 className="account-title">{displayName}</h1>
            <p className="account-subtitle">Your signed-in TaxiGo profile</p>
          </div>
          <div className="account-meta">
            <span className="status-badge success"><CheckCircle size={12} /> Active session</span>
          </div>
        </div>
        <button type="button" className="btn danger" onClick={onLogout}>
          <LogOut size={14} /> Sign out
        </button>
      </div>

      <div className="account-grid">
        <div className="account-card">
          <div className="card-head">
            <User size={18} />
            <div>
              <div className="card-title">Profile Information</div>
              <div className="card-subtitle">Personal account details</div>
            </div>
          </div>
          <dl className="account-fields">
            <div className="account-field">
              <dt><Mail size={14} /> Email</dt>
              <dd>{email}</dd>
            </div>
            <div className="account-field">
              <dt><Phone size={14} /> Phone</dt>
              <dd>{phone}</dd>
            </div>
            <div className="account-field">
              <dt><User size={14} /> Full name</dt>
              <dd>{displayName}</dd>
            </div>
          </dl>
        </div>

        <div className="account-card">
          <div className="card-head">
            <ShieldCheck size={18} />
            <div>
              <div className="card-title">Account Details</div>
              <div className="card-subtitle">Role and identification</div>
            </div>
          </div>
          <dl className="account-fields">
            <div className="account-field">
              <dt><Key size={14} /> Role</dt>
              <dd><span className={`role-badge role-${String(role).toLowerCase()}`}>{role}</span></dd>
            </div>
            <div className="account-field">
              <dt><ShieldCheck size={14} /> Account ID</dt>
              <dd>{accountId}</dd>
            </div>
            <div className="account-field">
              <dt><Clock size={14} /> Session status</dt>
              <dd><span className="session-badge">Authenticated via OTP</span></dd>
            </div>
          </dl>
        </div>

      </div>

      <div className="account-footer">
          <small>TaxiGo {admin ? "Admin Dashboard" : "Account Portal"} &middot; Secure session managed by TaxiGo API</small>
      </div>
    </section>
  );
}

function UserDashboard({ profile, health, onNavigate, onLogout }) {
  const displayName = profile?.full_name || profile?.name || "there";
  const makeRideForm = () => {
    const later = new Date(Date.now() + 60 * 60 * 1000);
    later.setMinutes(later.getMinutes() - later.getTimezoneOffset());
    return { pickupLabel: "", pickupLat: "", pickupLng: "", dropoffLabel: "", dropoffLat: "", dropoffLng: "", pickupAt: later.toISOString().slice(0, 16), passengers: "1", category: "sedan" };
  };
  const [ride, setRide] = useState(makeRideForm);
  const [bookings, setBookings] = useState([]);
  const [rideRequests, setRideRequests] = useState([]);
  const [bookingsLoading, setBookingsLoading] = useState(true);
  const [rideRequestsLoading, setRideRequestsLoading] = useState(true);
  const [bookingsError, setBookingsError] = useState("");
  const [rideRequestsError, setRideRequestsError] = useState("");
  const bookingsRequestRef = useRef(0);
  const rideRequestsRequestRef = useRef(0);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [actionError, setActionError] = useState(false);
  async function loadDashboardList(path, requestRef, setRows, setError, setListLoading) {
    const requestId = ++requestRef.current;
    setListLoading(true);
    setError("");
    const [result] = await Promise.allSettled([
      api.get(path, { params: { offset: 0, limit: 10 } }),
    ]);
    if (requestId !== requestRef.current) return;
    const listState = dashboardListState(result);
    setRows(listState.rows);
    setError(listState.error);
    setListLoading(false);
  }
  function loadBookings() {
    return loadDashboardList("/api/v1/bookings", bookingsRequestRef, setBookings, setBookingsError, setBookingsLoading);
  }
  function loadRideRequests() {
    return loadDashboardList("/api/v1/ride-requests", rideRequestsRequestRef, setRideRequests, setRideRequestsError, setRideRequestsLoading);
  }
  async function loadMyRides() {
    await Promise.all([loadBookings(), loadRideRequests()]);
  }
  useEffect(() => { loadMyRides(); }, []);
  async function requestRide(e) {
    e.preventDefault(); setSaving(true); setMessage(""); setActionError(false);
    try {
      const payload = {
        pickup: { latitude: Number(ride.pickupLat), longitude: Number(ride.pickupLng), label: ride.pickupLabel },
        dropoff: { latitude: Number(ride.dropoffLat), longitude: Number(ride.dropoffLng), label: ride.dropoffLabel },
        pickup_at: new Date(ride.pickupAt).toISOString(),
        passenger_count: Number(ride.passengers),
        vehicle_category: ride.category,
      };
      await api.post("/api/v1/ride-requests", payload); setMessage("Ride request submitted."); setRide(makeRideForm()); await loadMyRides();
    }
    catch (error) { setMessage(formatError(error)); setActionError(true); }
    finally { setSaving(false); }
  }
  const updateRide = (key, value) => setRide(current => ({ ...current, [key]: value }));
  const tableRows = (rows, type) => rows.length ? <div className="manual-table-wrap"><table className="manual-table"><thead><tr><th>{type} ID</th><th>Status</th><th>Pickup</th><th>Destination</th><th>Time</th></tr></thead><tbody>{rows.map((row, index) => <tr key={row.id || row.booking_id || row.request_id || index}><td>{row.booking_id || row.request_id || row.id || "—"}</td><td>{row.status || "—"}</td><td>{row.pickup?.label || row.pickup_label || "—"}</td><td>{row.dropoff?.label || row.dropoff_label || "—"}</td><td>{formatDateTime(row.pickup_at || row.created_at)}</td></tr>)}</tbody></table></div> : <div className="empty-state">No {type.toLowerCase()} found.</div>;
  return <>
    <div className="welcome-row"><div><div className="eyebrow">TAXIGO ACCOUNT</div><h1>Welcome, {displayName}</h1><p>Your TaxiGo account is signed in and ready.</p></div></div>
    <div className="content-grid">
      <div className="panel"><PanelTitle title="Request a ride" subtitle="Create a request from your account" icon={Route}/><form className="manual-form" onSubmit={requestRide}>
        <label className="manual-field"><span>Pickup address or landmark</span><input value={ride.pickupLabel} onChange={e => updateRide("pickupLabel", e.target.value)} minLength="2" maxLength="255" required /></label>
        <label className="manual-field"><span>Pickup latitude</span><input type="number" min="-90" max="90" step="any" value={ride.pickupLat} onChange={e => updateRide("pickupLat", e.target.value)} required /></label>
        <label className="manual-field"><span>Pickup longitude</span><input type="number" min="-180" max="180" step="any" value={ride.pickupLng} onChange={e => updateRide("pickupLng", e.target.value)} required /></label>
        <label className="manual-field"><span>Destination address or landmark</span><input value={ride.dropoffLabel} onChange={e => updateRide("dropoffLabel", e.target.value)} minLength="2" maxLength="255" required /></label>
        <label className="manual-field"><span>Destination latitude</span><input type="number" min="-90" max="90" step="any" value={ride.dropoffLat} onChange={e => updateRide("dropoffLat", e.target.value)} required /></label>
        <label className="manual-field"><span>Destination longitude</span><input type="number" min="-180" max="180" step="any" value={ride.dropoffLng} onChange={e => updateRide("dropoffLng", e.target.value)} required /></label>
        <label className="manual-field"><span>Pickup time</span><input type="datetime-local" value={ride.pickupAt} onChange={e => updateRide("pickupAt", e.target.value)} required /></label>
        <label className="manual-field"><span>Passengers</span><input type="number" min="1" max="30" value={ride.passengers} onChange={e => updateRide("passengers", e.target.value)} required /></label>
        <label className="manual-field"><span>Vehicle category</span><select value={ride.category} onChange={e => updateRide("category", e.target.value)}><option value="sedan">Sedan</option><option value="suv">SUV</option><option value="tempo_traveller">Tempo traveller</option></select></label>
        <div className="manual-form-actions"><div className="manual-feedback-slot">{message && <div className={`manual-feedback ${actionError ? "error" : "success"}`} role="status">{message}</div>}</div><button className="btn primary" disabled={saving}>{saving ? "Submitting…" : "Submit ride request"}</button></div>
      </form></div>
      <div className="panel"><PanelTitle title="Account details" subtitle="Verified by the TaxiGo API" icon={ShieldCheck}/><AccountSummary profile={profile} onLogout={onLogout}/><button className="text-button" onClick={() => onNavigate("account")}>View my account <ChevronRight size={15}/></button><div className="check-list"><div className="check-row"><span className={`check-icon ${health === "Online" ? "success" : "warning"}`}><CheckCircle2 size={16}/></span><span>TaxiGo API</span><span className="check-state">{health}</span></div></div></div>
      <div className="panel full"><div className="manual-panel-head"><PanelTitle title="My bookings" subtitle="Your recent rides" icon={Route}/><button type="button" className="btn secondary" onClick={loadBookings} disabled={bookingsLoading}><RefreshCw size={15} className={bookingsLoading ? "spin" : ""}/>{bookingsLoading ? "Loading…" : "Refresh"}</button></div>{bookingsError && <div className="manual-feedback error" role="alert">{bookingsError}</div>}{bookingsLoading ? <div className="loading-row">Loading your rides…</div> : tableRows(bookings, "Booking")}</div>
      <div className="panel full"><div className="manual-panel-head"><PanelTitle title="My ride requests" subtitle="Requests waiting for a booking" icon={Route}/><button type="button" className="btn secondary" onClick={loadRideRequests} disabled={rideRequestsLoading}><RefreshCw size={15} className={rideRequestsLoading ? "spin" : ""}/>{rideRequestsLoading ? "Loading…" : "Refresh"}</button></div>{rideRequestsError && <div className="manual-feedback error" role="alert">{rideRequestsError}</div>}{rideRequestsLoading ? <div className="loading-row">Loading requests…</div> : tableRows(rideRequests, "Request")}</div>
    </div>
  </>;
}

function Dashboard({ health, driverCount, openBookingCount, completedBookingCount, rideRequestCount, queueCount, aadhaarQueueCount, documentQueueCount, aadhaarQueueError, documentQueueError, recent, refreshing, lastUpdated, onNavigate, onRefresh }) {
 const queueNote = `Aadhaar: ${reviewQueueCountLabel(aadhaarQueueCount, aadhaarQueueError, refreshing)} · Documents: ${reviewQueueCountLabel(documentQueueCount, documentQueueError, refreshing)}`;
 const cards = [
  { label: "Driver records", value: driverCount ?? "—", note: "Drivers in the platform", icon: CarFront, color: "blue", target: "drivers" },
  { label: "Open bookings", value: openBookingCount ?? "—", note: "Active and in-progress rides", icon: Route, color: "violet", target: "rides" },
  { label: "Completed bookings", value: completedBookingCount ?? "—", note: "Successfully completed rides", icon: CheckCircle2, color: "amber", target: "rides" },
  { label: "Ride requests", value: rideRequestCount ?? "—", note: "Open and pending requests", icon: MessageSquare, color: "violet", target: "rides" },
  { label: "Verification queue", value: queueCount ?? "—", note: queueNote, icon: FileCheck2, color: "teal", target: "kyc" },
 ];
 return <div className="admin-dashboard">
  <section className="dashboard-welcome">
   <div><div className="eyebrow">ADMIN WORKSPACE</div><h1>Good to see you <span className="wave">✦</span></h1><p>Your TaxiGo operations, all in one place.</p></div>
   <div className="dashboard-welcome-actions"><span className={`dashboard-health-chip ${health === "Online" ? "online" : "offline"}`}><i/>Backend {health}</span><span className="dashboard-refresh-status" role="status" aria-live="polite">{refreshing ? "Updating dashboard…" : lastUpdated ? `Last checked ${formatDateTime(lastUpdated)}` : "Ready to refresh"}</span><Button variant="secondary" disabled={refreshing} onClick={onRefresh}><RefreshCw size={15} className={refreshing ? "spin" : ""}/>{refreshing ? "Refreshing…" : "Refresh data"}</Button></div>
  </section>
  <div className="dashboard-stats">{cards.map(c => <button className="dashboard-stat-card" key={c.label} onClick={() => onNavigate(c.target)} aria-label={`${c.label}: ${c.value}. Open ${c.target}`}>
    <span className={`dashboard-stat-icon ${c.color}`}><Icon icon={c.icon} size={19}/></span>
    <span className="dashboard-stat-copy"><small>{c.label}</small><strong>{c.value}</strong><span>{c.note}</span></span>
    <ArrowUpRight className="dashboard-stat-arrow" size={15}/>
   </button>)}</div>
  <div className="dashboard-content-grid">
   <section className="panel dashboard-actions-panel"><PanelTitle title="Quick actions" subtitle="Go straight to a daily operation" icon={Gauge}/><div className="dashboard-quick-grid">
    <QuickAction icon={CarFront} title="Review drivers" desc="Applications and profiles" onClick={() => onNavigate("drivers")}/>
    <QuickAction icon={FileCheck2} title="Driver verification" desc="Identity and document queue" onClick={() => onNavigate("kyc")}/>
    <QuickAction icon={Route} title="Bookings" desc="Ride operations and status" onClick={() => onNavigate("rides")}/>
    <QuickAction icon={MessageSquare} title="Callbacks & messages" desc="Customer communication" onClick={() => onNavigate("communications")}/>
    <QuickAction icon={CircleDollarSign} title="Categories & offers" desc="Categories and offers" onClick={() => onNavigate("pricing")}/>
    <QuickAction icon={MapPinned} title="Areas & routes" desc="Service coverage settings" onClick={() => onNavigate("configuration")}/>
   </div></section>
   <section className="panel dashboard-health-panel"><div className="dashboard-health-heading"><PanelTitle title="System health" subtitle="Current service and account checks" icon={Database}/><span className={`dashboard-health-chip ${health === "Online" ? "online" : "offline"}`}><i/>{health}</span></div><div className="dashboard-health-list">{recent.map(x => <div className="dashboard-health-row" key={x.label}><span className={`dashboard-health-check ${x.tone}`}><CheckCircle2 size={15}/></span><span>{x.label}</span><strong>{x.state}</strong></div>)}</div><div className="dashboard-health-footer"><span>Review identity submissions that need attention.</span><button className="text-button" onClick={() => onNavigate("kyc")}>Open verification queue <ChevronRight size={15}/></button></div></section>
  </div>
 </div>;
}
function QuickAction({ icon, title, desc, onClick }) { return <button className="quick-action" onClick={onClick}><span className="quick-icon"><Icon icon={icon}/></span><span><b>{title}</b><small>{desc}</small></span><ChevronRight size={16}/></button>; }
function PanelTitle({ title, subtitle, icon: I }) { return <div className="panel-title"><span className="panel-title-icon"><I size={18}/></span><div><h2>{title}</h2><p>{subtitle}</p></div></div>; }
export default App;
