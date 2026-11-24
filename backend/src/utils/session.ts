import crypto from "crypto";
import { Request, Response } from "express";
import jwt from "jsonwebtoken";
import { prisma } from "../config/db";
import { parseCookies } from "./cookies";

// ── Configuration ────────────────────────────────────────────────────────────
// Access tokens are short-lived (15 min by default) and never stored in JS.
// The refresh token is rotated on every use, and a session dies either when it
// hits the absolute lifetime or after a stretch of inactivity.

export const ACCESS_TTL_MINUTES  = Number(process.env.ACCESS_TOKEN_MINUTES  ?? 15);
export const IDLE_TIMEOUT_MINUTES = Number(process.env.SESSION_IDLE_MINUTES ?? 30);
export const SESSION_TTL_HOURS    = Number(process.env.SESSION_TTL_HOURS    ?? 12);

const ACCESS_TTL_MS = ACCESS_TTL_MINUTES * 60 * 1000;
const IDLE_TTL_MS   = IDLE_TIMEOUT_MINUTES * 60 * 1000;
const SESSION_TTL_MS = SESSION_TTL_HOURS * 60 * 60 * 1000;

// How often an active request may extend the idle deadline. Writing on every
// request would be wasteful; a minute of slack keeps timeouts accurate enough.
const TOUCH_INTERVAL_MS = 60 * 1000;

export const ACCESS_COOKIE  = "erp_access";
export const REFRESH_COOKIE = "erp_refresh";
export const CSRF_COOKIE    = "erp_csrf";
// Holds a short-lived "password accepted, second factor pending" ticket. It can
// never be exchanged for a session on its own.
export const MFA_COOKIE     = "erp_mfa";

// The refresh token is only ever sent to /auth/* so it never rides along on
// ordinary API calls where it is not needed.
const REFRESH_PATH = "/auth";

export interface SessionUser {
  id: string;
  email: string;
  role: string;
  name: string;
  pendingApproval?: boolean;
}

export function getIP(req: Request) {
  return ((req.headers["x-forwarded-for"] as string) || req.socket.remoteAddress || null)?.toString().slice(0, 255) ?? null;
}

export function hashToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function randomToken() {
  return crypto.randomBytes(48).toString("base64url");
}

export function readCookie(req: Request, name: string) {
  return parseCookies(req.headers.cookie)[name];
}

// ── Cookie flags ─────────────────────────────────────────────────────────────
// Secure unless explicitly disabled, because a session cookie on plain HTTP is
// as good as a published password. SameSite=strict is the primary CSRF defense;
// the double-submit token below is the second layer.

function secureCookies(): boolean {
  if (process.env.COOKIE_SECURE === "false") return false;
  return process.env.NODE_ENV === "production" || process.env.FORCE_HTTPS === "true";
}

function sameSite(): "strict" | "lax" | "none" {
  const configured = (process.env.COOKIE_SAME_SITE ?? "strict").toLowerCase();
  return configured === "lax" || configured === "none" ? configured : "strict";
}

function cookieDomain(): string | undefined {
  return process.env.COOKIE_DOMAIN?.trim() || undefined;
}

interface CookieSpec {
  httpOnly: boolean;
  secure: boolean;
  sameSite: "strict" | "lax" | "none";
  path: string;
  domain?: string;
  maxAge?: number;
}

function cookieSpec(httpOnly: boolean, path: string, maxAge?: number): CookieSpec {
  const same = sameSite();
  const domain = cookieDomain();
  return {
    httpOnly,
    // SameSite=None is rejected by browsers unless the cookie is Secure
    secure: same === "none" ? true : secureCookies(),
    sameSite: same,
    path,
    ...(domain ? { domain } : {}),
    ...(maxAge !== undefined ? { maxAge } : {}),
  };
}

// ── Access tokens ────────────────────────────────────────────────────────────

export function signAccessToken(user: SessionUser & { id: string }, sessionId: string) {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      role: user.role,
      name: user.name,
      sid: sessionId,
      ...(user.pendingApproval ? { pendingApproval: true } : {}),
    },
    process.env.JWT_SECRET as string,
    { expiresIn: `${ACCESS_TTL_MINUTES}m` } as jwt.SignOptions
  );
}

// ── Cookie writing ───────────────────────────────────────────────────────────

export function setSessionCookies(
  res: Response,
  user: SessionUser,
  session: { id: string; expiresAt: Date },
  secrets: { refreshToken: string; csrfToken: string }
) {
  const accessToken = signAccessToken(user, session.id);
  const remaining = Math.max(0, session.expiresAt.getTime() - Date.now());

  res.cookie(ACCESS_COOKIE, accessToken, cookieSpec(true, "/", ACCESS_TTL_MS));
  res.cookie(REFRESH_COOKIE, secrets.refreshToken, cookieSpec(true, REFRESH_PATH, remaining));
  // Readable by the SPA on purpose: it must be echoed back in X-CSRF-Token.
  res.cookie(CSRF_COOKIE, secrets.csrfToken, cookieSpec(false, "/", remaining));

  return accessToken;
}

export function clearSessionCookies(res: Response) {
  res.clearCookie(ACCESS_COOKIE, cookieSpec(true, "/"));
  res.clearCookie(REFRESH_COOKIE, cookieSpec(true, REFRESH_PATH));
  res.clearCookie(CSRF_COOKIE, cookieSpec(false, "/"));
}

export function setMfaChallengeCookie(res: Response, token: string, ttlMs: number) {
  res.cookie(MFA_COOKIE, token, cookieSpec(true, REFRESH_PATH, ttlMs));
}

export function clearMfaChallengeCookie(res: Response) {
  res.clearCookie(MFA_COOKIE, cookieSpec(true, REFRESH_PATH));
}

// ── Session lifecycle ────────────────────────────────────────────────────────

export async function createSession(req: Request, res: Response, user: SessionUser) {
  const refreshToken = randomToken();
  const csrfToken = randomToken();
  const now = Date.now();

  const session = await prisma.session.create({
    data: {
      userId: user.id,
      refreshTokenHash: hashToken(refreshToken),
      csrfTokenHash: hashToken(csrfToken),
      userAgent: (req.headers["user-agent"] as string | undefined)?.slice(0, 255) ?? null,
      ipAddress: getIP(req),
      lastSeenAt: new Date(now),
      idleExpiresAt: new Date(now + IDLE_TTL_MS),
      expiresAt: new Date(now + SESSION_TTL_MS),
    },
  });

  const accessToken = setSessionCookies(res, user, session, { refreshToken, csrfToken });
  return { session, accessToken };
}

// Loads a session and reports whether it may still be used. Sessions are
// checked on every request, which is what makes revocation take effect
// immediately instead of whenever the access token happens to expire.
export async function loadValidSession(sessionId: string) {
  const session = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!session) return null;
  const now = new Date();
  if (session.revokedAt) return null;
  if (session.expiresAt <= now) return null;
  if (session.idleExpiresAt <= now) return null;
  return session;
}

// Extends the idle deadline, throttled so normal browsing does not write to the
// database on every single request.
export async function touchSession(session: { id: string; lastSeenAt: Date; expiresAt: Date }) {
  if (Date.now() - session.lastSeenAt.getTime() < TOUCH_INTERVAL_MS) return;
  const next = new Date();
  await prisma.session
    .update({
      where: { id: session.id },
      data: {
        lastSeenAt: next,
        idleExpiresAt: new Date(Math.min(next.getTime() + IDLE_TTL_MS, session.expiresAt.getTime())),
      },
    })
    .catch(() => undefined); // never fail a request because bookkeeping failed
}

// Replaces the refresh token (rotation) and mints a new access token. The token
// that was just used is remembered so replay can be detected.
export async function rotateSession(
  res: Response,
  user: SessionUser,
  session: { id: string; refreshTokenHash: string; csrfTokenHash: string; expiresAt: Date }
) {
  const refreshToken = randomToken();
  const csrfToken = randomToken();
  const now = new Date();

  const updated = await prisma.session.update({
    where: { id: session.id },
    data: {
      previousTokenHash: session.refreshTokenHash,
      refreshTokenHash: hashToken(refreshToken),
      csrfTokenHash: hashToken(csrfToken),
      lastSeenAt: now,
      idleExpiresAt: new Date(Math.min(now.getTime() + IDLE_TTL_MS, session.expiresAt.getTime())),
    },
  });

  const accessToken = setSessionCookies(res, user, updated, { refreshToken, csrfToken });
  return { session: updated, accessToken };
}

export async function revokeSession(sessionId: string, reason: string) {
  await prisma.session
    .updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    })
    .catch(() => undefined);
}

// Used by logout-all, password changes and admin deactivation. `exceptSessionId`
// keeps the caller signed in on the device they are using right now.
export async function revokeUserSessions(userId: string, reason: string, exceptSessionId?: string) {
  await prisma.session.updateMany({
    where: {
      userId,
      revokedAt: null,
      ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}),
    },
    data: { revokedAt: new Date(), revokedReason: reason },
  });
}

// Double-submit check: the token from X-CSRF-Token must hash to the value bound
// to this session. Compared in constant time to avoid leaking via timing.
export function csrfTokenMatches(session: { csrfTokenHash: string }, req: Request) {
  const supplied = (req.headers["x-csrf-token"] as string | undefined) ?? req.body?._csrf;
  if (!supplied || typeof supplied !== "string") return false;
  const expected = Buffer.from(session.csrfTokenHash, "hex");
  const actual = Buffer.from(hashToken(supplied), "hex");
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}
