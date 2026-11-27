import axios from "axios";

export const API_BASE_URL = (import.meta.env.VITE_TAXIGO_API_BASE_URL || "https://taxi.retradviews.com").replace(/\/+$/, "");

export const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 30000,
  headers: { "Content-Type": "application/json" }
});

api.interceptors.request.use((config) => {
  const token = sessionStorage.getItem("taxigo_access_token");
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

let _isRefreshing = false;
let _refreshQueue = [];

function processRefreshQueue(error, token = null) {
  _refreshQueue.forEach(({ resolve, reject }) => (error ? reject(error) : resolve(token)));
  _refreshQueue = [];
}

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error?.config;
    if (error?.response?.status === 401 && !originalRequest?._retry) {
      const refreshToken = sessionStorage.getItem("taxigo_refresh_token");
      if (!refreshToken) {
        sessionStorage.removeItem("taxigo_access_token");
        if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("taxigo:unauthorized"));
        return Promise.reject(error);
      }
      if (_isRefreshing) {
        return new Promise((resolve, reject) => {
          _refreshQueue.push({ resolve, reject });
        }).then((token) => {
          originalRequest.headers.Authorization = `Bearer ${token}`;
          return api.request(originalRequest);
        });
      }
      originalRequest._retry = true;
      _isRefreshing = true;
      try {
        const response = await api.post("/api/v1/auth/refresh", { refresh_token: refreshToken });
        const { access_token, refresh_token: newRefreshToken } = response.data?.data || response.data || {};
        if (!access_token) throw new Error("Refresh response missing access_token");
        sessionStorage.setItem("taxigo_access_token", access_token);
        if (newRefreshToken) sessionStorage.setItem("taxigo_refresh_token", newRefreshToken);
        api.defaults.headers.common.Authorization = `Bearer ${access_token}`;
        processRefreshQueue(null, access_token);
        originalRequest.headers.Authorization = `Bearer ${access_token}`;
        return api.request(originalRequest);
      } catch (refreshError) {
        processRefreshQueue(refreshError, null);
        sessionStorage.removeItem("taxigo_access_token");
        sessionStorage.removeItem("taxigo_refresh_token");
        if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("taxigo:unauthorized"));
        return Promise.reject(refreshError);
      } finally {
        _isRefreshing = false;
      }
    }
    return Promise.reject(error);
  }
);
export * from "./lib/errors.js";

export async function sendApiRequest({ method, path, body, params }) {
  const config = { method: method.toLowerCase(), url: path, params };
  if (!["GET", "HEAD"].includes(method.toUpperCase()) && body !== undefined && body !== "") {
    try { config.data = typeof body === "string" ? JSON.parse(body) : body; }
    catch { throw new Error("Request body must be valid JSON."); }
  }
  return api.request(config);
}