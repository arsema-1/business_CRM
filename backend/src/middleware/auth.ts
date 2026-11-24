import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { ApiError } from "../utils/ApiError";
import { writeAuditLog } from "../utils/audit";
import { logger } from "../utils/logger";
import {
  ACCESS_COOKIE,
  clearSessionCookies,
  csrfTokenMatches,
  loadValidSession,
  readCookie,
  touchSession,
} from "../utils/session";

export interface AuthPayload {
  id: string;
  email: string;
  role: "ADMIN" | "SALES" | "WAREHOUSE" | "ACCOUNTS";
  name: string;
  // Session id this access token belongs to. Absent on legacy tokens only.
  sid?: string;
  // True for a verified self-registered user who has not been approved yet
  pendingApproval?: boolean;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthPayload;
      sessionId?: string;
    }
  }
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// Accepts either the HttpOnly session cookie (browsers) or a Bearer header
// (API clients, Postman). Cookie-authenticated state-changing requests must
// also echo the CSRF token: that, plus SameSite=strict, is what stops another
// site from riding the session.
export async function authenticate(req: Request, res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization;
    let token: string | undefined;
    let viaCookie = false;

    if (header?.startsWith("Bearer ")) {
      token = header.slice("Bearer ".length).trim();
    } else {
      token = readCookie(req, ACCESS_COOKIE);
      viaCookie = Boolean(token);
    }

    if (!token) return next(new ApiError(401, "Not authenticated. Please sign in."));

    let payload: AuthPayload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET as string) as AuthPayload;
    } catch {
      void writeAuditLog(req, "AUTH_TOKEN_REJECTED", undefined, undefined, "Invalid or expired access token", {
        severity: "WARN",
        success: false,
      });
      return next(new ApiError(401, "Invalid or expired token"));
    }

    if (!payload.sid) {
      void writeAuditLog(req, "AUTH_TOKEN_REJECTED", undefined, undefined, "Access token carries no session id", {
        severity: "WARN",
        success: false,
        actor: { id: payload.id, email: payload.email, role: payload.role },
      });
      return next(new ApiError(401, "Invalid session token"));
    }

    // The session row is the source of truth: revoking it (logout, password
    // change, admin action, reuse detection) invalidates tokens immediately.
    const session = await loadValidSession(payload.sid);
    if (!session || session.userId !== payload.id) {
      clearSessionCookies(res);
      // The token was validly signed but its session is gone: revocation,
      // timeout or a replayed token. Worth a record either way.
      void writeAuditLog(req, "SESSION_REJECTED", "Session", payload.sid, "Access token presented for a revoked or expired session", {
        severity: "WARN",
        success: false,
        actor: { id: payload.id, email: payload.email, role: payload.role },
      });
      return next(
        new ApiError(401, viaCookie ? "Your session has expired. Please sign in again." : "Session revoked")
      );
    }

    if (viaCookie && !SAFE_METHODS.has(req.method) && !csrfTokenMatches(session, req)) {
      void writeAuditLog(req, "CSRF_REJECTED", "Session", session.id, "State-changing request without a matching CSRF token", {
        severity: "WARN",
        success: false,
        actor: { id: payload.id, email: payload.email, role: payload.role },
      });
      logger.security("CSRF_REJECTED", "Request rejected: missing or mismatched CSRF token", {
        email: payload.email,
        method: req.method,
        path: req.originalUrl,
        ip: req.ip,
      });
      return next(new ApiError(403, "Invalid or missing CSRF token"));
    }

    req.user = payload;
    req.sessionId = session.id;
    void touchSession(session);
    next();
  } catch (err) {
    next(err);
  }
}

// Blocks all business routes until an admin approves a self-registered account.
// Profile, password and passkey endpoints deliberately stay reachable.
export function requireApproved(req: Request, _res: Response, next: NextFunction) {
  if (req.user?.pendingApproval) {
    void writeAuditLog(
      req,
      "AUTHZ_DENIED",
      "User",
      req.user.id,
      `Pending-approval account blocked from ${req.method} ${req.originalUrl}`,
      { severity: "WARN", success: false }
    );
    return next(new ApiError(403, "Your account is pending administrator approval."));
  }
  next();
}

// Usage: authorize("ADMIN", "SALES")
export function authorize(...roles: AuthPayload["role"][]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(new ApiError(401, "Not authenticated"));
    if (roles.length > 0 && !roles.includes(req.user.role)) {
      // Authorization decision: record the denial with the role that was tried
      // and the route it tried to reach.
      void writeAuditLog(
        req,
        "AUTHZ_DENIED",
        undefined,
        undefined,
        `Role ${req.user.role} denied ${req.method} ${req.originalUrl} (allowed: ${roles.join(", ")})`,
        { severity: "WARN", success: false }
      );
      return next(new ApiError(403, `Role '${req.user.role}' is not permitted to perform this action`));
    }
    next();
  };
}
