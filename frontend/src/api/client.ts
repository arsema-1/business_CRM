const API_URL = import.meta.env.VITE_API_URL || "http://localhost:4000";

// The access and refresh tokens live in HttpOnly cookies, so nothing secret is
// reachable from JavaScript. Only the CSRF token is readable here: it must be
// echoed back in a header so another site cannot forge authenticated requests.
const CSRF_COOKIE = "erp_csrf";

function readCookie(name: string): string | null {
  const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

// Endpoints that must never trigger the silent-refresh retry: they are either
// the refresh itself or unauthenticated by design.
const NO_REFRESH_PREFIXES = [
  "/auth/login",
  "/auth/register",
  "/auth/refresh",
  "/auth/logout",
  "/auth/forgot-password",
  "/auth/reset-password",
  "/auth/verify-email",
  "/auth/webauthn/login",
  "/auth/mfa/verify",
  "/auth/mfa/recover",
];

export class ApiClientError extends Error {
  status: number;
  details?: unknown;
  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

async function doRefresh(): Promise<boolean> {
  try {
    const res = await fetch(`${API_URL}/auth/refresh`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        ...csrfHeader(),
      },
      body: "{}",
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Single-flight: many parallel requests failing at once must produce exactly one
// refresh call, or rotation would invalidate the token the others are using.
let refreshInFlight: Promise<boolean> | null = null;

export function refreshSession(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = doRefresh().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

function csrfHeader(): Record<string, string> {
  const csrf = readCookie(CSRF_COOKIE);
  return csrf ? { "X-CSRF-Token": csrf } : {};
}

async function request(path: string, options: RequestInit = {}, allowRefresh = true): Promise<any> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...csrfHeader(),
    ...(options.headers as Record<string, string> | undefined),
  };

  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers,
    credentials: "include", // send/receive the session cookies
  });

  // A 401 usually just means the 15-minute access token aged out. Refresh once
  // (rotating the refresh token) and replay the original request.
  const canRetry = allowRefresh && !NO_REFRESH_PREFIXES.some((p) => path.startsWith(p));
  if (res.status === 401 && canRetry) {
    if (await refreshSession()) return request(path, options, false);
  }

  const isJson = res.headers.get("content-type")?.includes("application/json");
  const body = isJson ? await res.json() : null;

  if (!res.ok) {
    throw new ApiClientError(res.status, body?.message || "Request failed", body?.details);
  }
  return body;
}

export const api = {
  get: (path: string) => request(path, { method: "GET" }),
  post: (path: string, data?: unknown) => request(path, { method: "POST", body: JSON.stringify(data) }),
  put: (path: string, data?: unknown) => request(path, { method: "PUT", body: JSON.stringify(data) }),
  delete: (path: string) => request(path, { method: "DELETE" }),
};
