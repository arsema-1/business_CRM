import { Request, Response } from "express";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
// In @simplewebauthn/server v14 the shared types live in the server package itself
import type {
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
} from "@simplewebauthn/server";
import { prisma } from "../config/db";
import { ApiError } from "../utils/ApiError";
import { writeAuditLog } from "../utils/audit";
import { sanitizeString } from "../utils/sanitize";
import { assertPasswordAcceptable } from "../utils/password";
import { sendVerificationEmail, sendPasswordResetEmail } from "../utils/mailer";
import { verifyRecaptcha } from "../utils/recaptcha";
import { CHALLENGE_TTL_MINUTES, createMfaChallenge } from "../utils/mfa";
import {
  REFRESH_COOKIE,
  clearSessionCookies,
  createSession,
  csrfTokenMatches,
  getIP,
  hashToken,
  readCookie,
  revokeSession,
  revokeUserSessions,
  rotateSession,
  setMfaChallengeCookie,
  type SessionUser,
} from "../utils/session";

// ── Constants ────────────────────────────────────────────────────────────────

const RP_NAME = process.env.RP_NAME  ?? "Mini ERP CRM";
const RP_ID   = process.env.RP_ID    ?? "localhost";
const ORIGIN  = process.env.APP_URL  ?? "http://localhost:5173";

// Account lockout: N failed passwords locks the account for M minutes. A
// completed password reset clears the lock immediately.
const MAX_FAILED_ATTEMPTS = Number(process.env.LOGIN_MAX_ATTEMPTS ?? 5);
const LOCKOUT_MINUTES     = Number(process.env.LOGIN_LOCKOUT_MINUTES ?? 15);

// ── Helpers ───────────────────────────────────────────────────────────────────

// The shape returned to the client. Never includes the password hash, tokens or
// internal approval flags beyond what the UI needs.
function publicUser(
  user: { id: string; name: string; email: string; role: string; selfRegistered: boolean; approvedAt: Date | null }
): SessionUser {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    pendingApproval: isPendingApproval(user),
  };
}

// A verified self-signup stays restricted until an admin approves it.
function isPendingApproval(user: { selfRegistered: boolean; approvedAt: Date | null }) {
  return user.selfRegistered && !user.approvedAt;
}

// WebAuthn challenge is stored in passwordResetToken with a "wa:" prefix so
// it can coexist with password-reset tokens without a dedicated column.
const WA_PREFIX = "wa:";

// ── POST /auth/register ───────────────────────────────────────────────────────
// Public self-service signup. Collects only name, email and password.
// The account stays inactive until the emailed link is opened.

// Roles a self-registered account may receive. ADMIN is deliberately excluded
// so public signup can never mint an administrator.
const SIGNUP_ROLES = ["SALES", "WAREHOUSE", "ACCOUNTS"] as const;
type SignupRole = (typeof SIGNUP_ROLES)[number];

function signupRole(): SignupRole {
  const configured = process.env.DEFAULT_SIGNUP_ROLE as SignupRole | undefined;
  return configured && (SIGNUP_ROLES as readonly string[]).includes(configured)
    ? configured
    : "SALES";
}


// Identical response whether or not the address is already registered, so the
// endpoint cannot be used to enumerate existing accounts.
const REGISTER_ACK =
  "If this email can be registered, a verification link is on its way. Open it to activate your account.";

export async function register(req: Request, res: Response) {
  const { name, email, password, recaptchaToken } = req.body as {
    name?: string;
    email?: string;
    password?: string;
    recaptchaToken?: string;
  };

  const captchaOk = await verifyRecaptcha(recaptchaToken, "register");
  if (!captchaOk) throw new ApiError(400, "reCAPTCHA verification failed. Please try again.");

  const cleanName = sanitizeString(name);
  const cleanEmail = sanitizeString(email)?.toLowerCase();

  if (!cleanName || cleanName.length < 2) throw new ApiError(400, "Please enter your full name");
  if (cleanName.length > 100) throw new ApiError(400, "Name is too long");
  if (!cleanEmail || cleanEmail.length > 255 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    throw new ApiError(400, "Please enter a valid email address");
  }
  if (!password) throw new ApiError(400, "Password is required");
  await assertPasswordAcceptable(password, { email: cleanEmail, name: cleanName });

  const existing = await prisma.user.findUnique({ where: { email: cleanEmail } });
  if (existing) {
    await writeAuditLog(req, "REGISTRATION_DUPLICATE", "User", undefined, "Signup attempted for an existing email", {
      severity: "WARN",
      success: false,
      actor: { email: cleanEmail },
    });
    res.json({ success: true, message: REGISTER_ACK });
    return;
  }

  const verificationToken = crypto.randomBytes(32).toString("hex");
  const passwordHash = await bcrypt.hash(password, 12);

  const user = await prisma.user.create({
    data: {
      name: cleanName,
      email: cleanEmail,
      passwordHash,
      role: signupRole(),
      isActive: false,
      verificationToken,
      selfRegistered: true,
    },
    select: { id: true, name: true, email: true },
  });

  try {
    await sendVerificationEmail(user.email, user.name, verificationToken, true);
  } catch (err) {
    // Roll back so the address is not left stuck behind an unsent link
    await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
    console.error("[register] verification email failed", err);
    throw new ApiError(503, "Could not send the verification email. Please try again shortly.");
  }

  await writeAuditLog(
    req,
    "USER_REGISTERED",
    "User",
    user.id,
    `Self-registration pending email verification (role ${signupRole()})`,
    { actor: { id: user.id, email: user.email, role: signupRole() } }
  );

  res.json({ success: true, message: REGISTER_ACK });
}

// ── POST /auth/login ──────────────────────────────────────────────────────────

export async function login(req: Request, res: Response) {
  const { email, password, recaptchaToken } = req.body as {
    email?: string;
    password?: string;
    recaptchaToken?: string;
  };

  if (!email || !password) throw new ApiError(400, "Email and password are required");

  const captchaOk = await verifyRecaptcha(recaptchaToken, "login");
  if (!captchaOk) throw new ApiError(400, "reCAPTCHA verification failed. Please try again.");

  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
  const ipAddress = getIP(req);

  if (!user || !user.isActive) {
    await writeAuditLog(req, "LOGIN_FAILED", "User", undefined, "Invalid email or password", {
      severity: "WARN",
      success: false,
      actor: { email: email.toLowerCase().trim() },
    });
    throw new ApiError(401, "Invalid email or password");
  }

  if (!user.emailVerifiedAt) {
    await writeAuditLog(req, "LOGIN_FAILED", "User", user.id, "Email not verified", {
      severity: "WARN",
      success: false,
      actor: { id: user.id, email: user.email, role: user.role },
    });
    throw new ApiError(403, "Please verify your email address before signing in. Check your inbox for the verification link.");
  }

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    const minutesLeft = Math.max(1, Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60000));
    await writeAuditLog(req, "LOGIN_BLOCKED_LOCKED", "User", user.id, `Locked for ${minutesLeft} more minute(s)`, {
      severity: "WARN",
      success: false,
      actor: { id: user.id, email: user.email, role: user.role },
    });
    throw new ApiError(
      423,
      `Too many failed sign-in attempts. This account is locked for ${minutesLeft} more minute${minutesLeft === 1 ? "" : "s"}. Use "Forgot password" to unlock it now.`
    );
  }

  const isValid = await bcrypt.compare(password, user.passwordHash);
  if (!isValid) {
    const attempts = (user.failedLoginAttempts ?? 0) + 1;

    if (attempts >= MAX_FAILED_ATTEMPTS) {
      const lockedUntil = new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000);
      await prisma.user.update({
        where: { id: user.id },
        data: { failedLoginAttempts: 0, lockedUntil },
      });
      await writeAuditLog(
        req,
        "ACCOUNT_LOCKED",
        "User",
        user.id,
        `Locked for ${LOCKOUT_MINUTES} minutes after ${MAX_FAILED_ATTEMPTS} failed attempts`,
        { severity: "WARN", success: false, actor: { id: user.id, email: user.email, role: user.role } }
      );
      throw new ApiError(
        423,
        `Too many failed sign-in attempts. This account is locked for ${LOCKOUT_MINUTES} minutes. Use "Forgot password" to unlock it now.`
      );
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { failedLoginAttempts: attempts },
    });
    await writeAuditLog(
      req,
      "LOGIN_FAILED",
      "User",
      user.id,
      `Incorrect password (attempt ${attempts} of ${MAX_FAILED_ATTEMPTS})`,
      { severity: "WARN", success: false, actor: { id: user.id, email: user.email, role: user.role } }
    );
    throw new ApiError(401, "Invalid email or password");
  }

  // Successful sign-in clears any expired lock and the failure counter
  if (user.failedLoginAttempts > 0 || user.lockedUntil) {
    await prisma.user.update({
      where: { id: user.id },
      data: { failedLoginAttempts: 0, lockedUntil: null },
    });
  }

  // ── Second factor ──────────────────────────────────────────────────────────
  // The password is only the first factor. With MFA on, no session is created
  // here: the browser gets a short-lived ticket that only /auth/mfa/verify can
  // spend, and it carries no authority of its own.
  if (user.mfaEnabled && user.totpSecret) {
    // Drop any previous session: this browser must not sit half-authenticated.
    clearSessionCookies(res);
    const { token } = await createMfaChallenge(user.id, ipAddress);
    setMfaChallengeCookie(res, token, CHALLENGE_TTL_MINUTES * 60 * 1000);
    await writeAuditLog(req, "LOGIN_MFA_REQUIRED", "User", user.id, "Password accepted; second factor required", {
      actor: { id: user.id, email: user.email, role: user.role },
    });
    res.json({
      success: true,
      mfaRequired: true,
      methods: ["totp", "backup_code"],
      expiresInMinutes: CHALLENGE_TTL_MINUTES,
      // Browsers use the HttpOnly cookie; API clients may echo this back instead.
      challengeToken: token,
      message: "Enter the 6-digit code from your authenticator app, or one of your backup codes.",
    });
    return;
  }

  // A brand-new session id is minted on every sign-in: nothing the browser
  // carried in before authenticating is reused (session-fixation defense).
  clearSessionCookies(res);
  const sessionUser = publicUser(user);
  const { accessToken } = await createSession(req, res, sessionUser);

  await writeAuditLog(req, "LOGIN_SUCCESS", "User", user.id, "Password sign-in", {
    actor: { id: user.id, email: user.email, role: user.role },
  });

  res.json({ success: true, token: accessToken, user: sessionUser });
}

// ── GET /auth/me ──────────────────────────────────────────────────────────────

export async function me(req: Request, res: Response) {
  const user = await prisma.user.findUnique({
    where: { id: req.user!.id },
    select: {
      id: true, name: true, email: true, role: true, isActive: true,
      emailVerifiedAt: true, createdAt: true, selfRegistered: true, approvedAt: true,
      mfaEnabled: true, mfaEnabledAt: true,
      webAuthnCredentials: { select: { id: true, deviceName: true, createdAt: true } },
    },
  });
  if (!user) throw new ApiError(404, "User not found");
  res.json({
    success: true,
    user: {
      ...user,
      pendingApproval: isPendingApproval({ ...user, approvedAt: user.approvedAt ?? null }),
    },
  });
}

// ── POST /auth/refresh ────────────────────────────────────────────────────────
// Exchanges the HttpOnly refresh cookie for a fresh short-lived access token and
// rotates the refresh token. Replaying a token that was already rotated away is
// treated as theft and kills the whole session.

export async function refresh(req: Request, res: Response) {
  const presented = readCookie(req, REFRESH_COOKIE);
  if (!presented) {
    clearSessionCookies(res);
    throw new ApiError(401, "No active session");
  }

  const tokenHash = hashToken(presented);
  const session = await prisma.session.findUnique({ where: { refreshTokenHash: tokenHash } });

  if (!session) {
    const replayed = await prisma.session.findFirst({ where: { previousTokenHash: tokenHash } });
    if (replayed) {
      await revokeSession(replayed.id, "REFRESH_TOKEN_REUSE");
      const compromised = await prisma.user.findUnique({
        where: { id: replayed.userId },
        select: { email: true, role: true },
      });
      await writeAuditLog(
        req,
        "REFRESH_TOKEN_REUSE",
        "Session",
        replayed.id,
        "An already-rotated refresh token was replayed; session revoked",
        {
          severity: "CRITICAL",
          success: false,
          actor: { id: replayed.userId, email: compromised?.email, role: compromised?.role },
        }
      );
    }
    clearSessionCookies(res);
    throw new ApiError(401, "Session expired. Please sign in again.");
  }

  if (!csrfTokenMatches(session, req)) {
    throw new ApiError(403, "Invalid or missing CSRF token");
  }

  const now = new Date();
  if (session.revokedAt || session.expiresAt <= now || session.idleExpiresAt <= now) {
    clearSessionCookies(res);
    throw new ApiError(401, "Session expired. Please sign in again.");
  }

  const user = await prisma.user.findUnique({ where: { id: session.userId } });
  if (!user || !user.isActive) {
    await revokeSession(session.id, "USER_INACTIVE");
    clearSessionCookies(res);
    throw new ApiError(401, "Your account is not active");
  }

  const sessionUser = publicUser(user);
  const { accessToken } = await rotateSession(res, sessionUser, session);
  res.json({ success: true, token: accessToken, user: sessionUser });
}

// ── POST /auth/logout ─────────────────────────────────────────────────────────
// Revokes the current session server-side and clears the cookies, so a copied
// token cannot outlive the sign-out.

export async function logout(req: Request, res: Response) {
  const presented = readCookie(req, REFRESH_COOKIE);
  const session = presented
    ? await prisma.session.findUnique({ where: { refreshTokenHash: hashToken(presented) } })
    : null;

  if (session) {
    // Logout is not behind `authenticate`, so the CSRF check must happen here
    if (!csrfTokenMatches(session, req)) {
      throw new ApiError(403, "Invalid or missing CSRF token");
    }
    await revokeSession(session.id, "LOGOUT");
    const signedOut = await prisma.user.findUnique({
      where: { id: session.userId },
      select: { email: true, role: true },
    });
    await writeAuditLog(req, "LOGOUT", "Session", session.id, "Signed out", {
      actor: { id: session.userId, email: signedOut?.email, role: signedOut?.role },
    });
  }

  clearSessionCookies(res);
  res.json({ success: true, message: "Signed out" });
}

// ── POST /auth/logout-all ─────────────────────────────────────────────────────
// Revokes every session belonging to the signed-in user.

export async function logoutAll(req: Request, res: Response) {
  await revokeUserSessions(req.user!.id, "LOGOUT_ALL");
  clearSessionCookies(res);
  await writeAuditLog(req, "LOGOUT_ALL", "User", req.user!.id, "All sessions revoked by the user");
  res.json({ success: true, message: "Signed out on all devices" });
}

// ── PUT /auth/profile ─────────────────────────────────────────────────────────
// Self-service profile update — name and/or password change.
// Password change requires the current password.

export async function updateProfile(req: Request, res: Response) {
  const { name, currentPassword, newPassword } = req.body as {
    name?: string;
    currentPassword?: string;
    newPassword?: string;
  };

  const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
  if (!user) throw new ApiError(404, "User not found");

  const data: Record<string, unknown> = {};
  if (name?.trim()) data.name = name.trim();

  if (newPassword) {
    if (!currentPassword) throw new ApiError(400, "Current password is required to set a new password");
    const valid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!valid) throw new ApiError(401, "Current password is incorrect");
    await assertPasswordAcceptable(newPassword, {
      email: user.email,
      name: (data.name as string | undefined) ?? user.name,
    });
    data.passwordHash = await bcrypt.hash(newPassword, 12);
  }

  if (Object.keys(data).length === 0) throw new ApiError(400, "Nothing to update");

  const updated = await prisma.user.update({
    where: { id: req.user!.id },
    data,
    select: { id: true, name: true, email: true, role: true },
  });

  // A password change signs out every other device; this session stays valid.
  if (data.passwordHash) {
    await revokeUserSessions(user.id, "PASSWORD_CHANGED", req.sessionId);
  }

  await writeAuditLog(req, "PROFILE_UPDATED", "User", user.id, `Profile updated for ${user.email}`);
  res.json({ success: true, user: updated });
}

// ── GET /auth/verify-email?token= ────────────────────────────────────────────

export async function verifyEmail(req: Request, res: Response) {
  const token = req.query.token as string | undefined;
  if (!token) throw new ApiError(400, "Verification token is required");

  const user = await prisma.user.findUnique({ where: { verificationToken: token } });
  if (!user) throw new ApiError(400, "Invalid or expired verification link");

  await prisma.user.update({
    where: { id: user.id },
    data: { emailVerifiedAt: new Date(), verificationToken: null, isActive: true },
  });

  await writeAuditLog(req, "EMAIL_VERIFIED", "User", user.id, `Email verified for ${user.email}`);
  res.json({ success: true, message: "Email verified. You can now sign in." });
}

// ── POST /auth/forgot-password ────────────────────────────────────────────────
// Always returns 200 to prevent email enumeration.

export async function forgotPassword(req: Request, res: Response) {
  const { email } = req.body as { email?: string };
  if (!email?.trim()) throw new ApiError(400, "Email is required");

  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });

  if (user && user.isActive && user.emailVerifiedAt) {
    const token  = crypto.randomBytes(32).toString("hex");
    const expiry = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

    await prisma.user.update({
      where: { id: user.id },
      data: { passwordResetToken: token, passwordResetExpiry: expiry },
    });

    await sendPasswordResetEmail(user.email, user.name, token);
    await writeAuditLog(req, "PASSWORD_RESET_REQUESTED", "User", user.id, `Password reset requested for ${user.email}`);
  }

  res.json({ success: true, message: "If that email is registered you will receive a reset link shortly." });
}

// ── POST /auth/reset-password ─────────────────────────────────────────────────

export async function resetPassword(req: Request, res: Response) {
  const { token, password } = req.body as { token?: string; password?: string };
  if (!token) throw new ApiError(400, "Reset token is required");
  if (!password) throw new ApiError(400, "Password is required");

  const user = await prisma.user.findUnique({ where: { passwordResetToken: token } });

  if (!user || !user.passwordResetExpiry || user.passwordResetExpiry < new Date()) {
    throw new ApiError(400, "Invalid or expired reset link. Please request a new one.");
  }

  await assertPasswordAcceptable(password, { email: user.email, name: user.name });

  const passwordHash = await bcrypt.hash(password, 12);
  // A completed reset is also the documented way to clear a lockout early.
  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash,
      passwordResetToken: null,
      passwordResetExpiry: null,
      failedLoginAttempts: 0,
      lockedUntil: null,
    },
  });

  // Whoever completes a reset is trusted; every existing session is not.
  await revokeUserSessions(user.id, "PASSWORD_RESET");

  await writeAuditLog(req, "PASSWORD_RESET_COMPLETED", "User", user.id, `Password reset completed for ${user.email}`);
  res.json({ success: true, message: "Password updated. You can now sign in." });
}

// ── WebAuthn — registration ───────────────────────────────────────────────────
// Step 1: GET /auth/webauthn/register-options  (requires auth)
// Step 2: POST /auth/webauthn/register-verify  (requires auth)

export async function webAuthnRegisterOptions(req: Request, res: Response) {
  const user = await prisma.user.findUnique({
    where: { id: req.user!.id },
    include: { webAuthnCredentials: true },
  });
  if (!user) throw new ApiError(404, "User not found");

  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: RP_ID,
    userID: Buffer.from(user.id),
    userName: user.email,
    userDisplayName: user.name,
    attestationType: "none",
    excludeCredentials: user.webAuthnCredentials.map((c) => ({
      id: c.credentialId,
      type: "public-key" as const,
    })),
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "preferred",
    },
  });

  // Store the challenge temporarily using the passwordResetToken column with a prefix
  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordResetToken: `${WA_PREFIX}${options.challenge}`,
      passwordResetExpiry: new Date(Date.now() + 5 * 60 * 1000),
    },
  });

  res.json({ success: true, options });
}

export async function webAuthnRegisterVerify(req: Request, res: Response) {
  const { response, deviceName } = req.body as {
    response: RegistrationResponseJSON;
    deviceName?: string;
  };

  const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
  if (!user) throw new ApiError(404, "User not found");

  if (
    !user.passwordResetToken?.startsWith(WA_PREFIX) ||
    !user.passwordResetExpiry ||
    user.passwordResetExpiry < new Date()
  ) {
    throw new ApiError(400, "Registration challenge expired. Please start over.");
  }

  const expectedChallenge = user.passwordResetToken.slice(WA_PREFIX.length);

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
    });
  } catch (e: unknown) {
    throw new ApiError(400, `Passkey registration failed: ${(e as Error).message}`);
  }

  if (!verification.verified || !verification.registrationInfo) {
    throw new ApiError(400, "Passkey registration could not be verified");
  }

  const { credential } = verification.registrationInfo;

  // credential.publicKey is Uint8Array in v14 — convert to base64url for storage
  const publicKeyB64 = Buffer.from(credential.publicKey).toString("base64url");

  await prisma.$transaction([
    prisma.webAuthnCredential.create({
      data: {
        userId: user.id,
        credentialId: credential.id,
        publicKey: publicKeyB64,
        counter: BigInt(credential.counter),
        deviceName: deviceName?.trim() ?? null,
      },
    }),
    prisma.user.update({
      where: { id: user.id },
      data: { passwordResetToken: null, passwordResetExpiry: null },
    }),
  ]);

  await writeAuditLog(req, "WEBAUTHN_REGISTERED", "User", user.id, `Passkey registered for ${user.email}`);
  res.json({ success: true, message: "Passkey registered successfully." });
}

// ── WebAuthn — authentication ─────────────────────────────────────────────────
// Step 1: POST /auth/webauthn/login-options   { email }
// Step 2: POST /auth/webauthn/login-verify    { email, response }

export async function webAuthnLoginOptions(req: Request, res: Response) {
  const { email } = req.body as { email?: string };
  if (!email?.trim()) throw new ApiError(400, "Email is required");

  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase().trim() },
    include: { webAuthnCredentials: true },
  });

  if (!user || !user.isActive || !user.emailVerifiedAt || user.webAuthnCredentials.length === 0) {
    throw new ApiError(400, "No passkey registered for this account");
  }

  const options = await generateAuthenticationOptions({
    rpID: RP_ID,
    userVerification: "preferred",
    allowCredentials: user.webAuthnCredentials.map((c) => ({
      id: c.credentialId,
      type: "public-key" as const,
    })),
  });

  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordResetToken: `${WA_PREFIX}${options.challenge}`,
      passwordResetExpiry: new Date(Date.now() + 5 * 60 * 1000),
    },
  });

  res.json({ success: true, options });
}

export async function webAuthnLoginVerify(req: Request, res: Response) {
  const { email, response } = req.body as {
    email?: string;
    response: AuthenticationResponseJSON;
  };

  if (!email?.trim()) throw new ApiError(400, "Email is required");

  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase().trim() },
    include: { webAuthnCredentials: true },
  });

  if (!user || !user.isActive || !user.emailVerifiedAt) {
    throw new ApiError(401, "Invalid account");
  }

  if (
    !user.passwordResetToken?.startsWith(WA_PREFIX) ||
    !user.passwordResetExpiry ||
    user.passwordResetExpiry < new Date()
  ) {
    throw new ApiError(400, "Authentication challenge expired. Please try again.");
  }

  const expectedChallenge = user.passwordResetToken.slice(WA_PREFIX.length);
  const storedCred = user.webAuthnCredentials.find((c) => c.credentialId === response.id);
  if (!storedCred) throw new ApiError(400, "Passkey not recognised");

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      credential: {
        id: storedCred.credentialId,
        // Decode from base64url back to Uint8Array for the library
        publicKey: new Uint8Array(Buffer.from(storedCred.publicKey, "base64url")),
        counter: Number(storedCred.counter),
      },
    });
  } catch (e: unknown) {
    throw new ApiError(400, `Passkey authentication failed: ${(e as Error).message}`);
  }

  if (!verification.verified) {
    await writeAuditLog(req, "LOGIN_FAILED", "User", user.id, "Passkey verification failed", {
      severity: "WARN",
      success: false,
      actor: { id: user.id, email: user.email, role: user.role },
    });
    throw new ApiError(401, "Passkey authentication failed");
  }

  await prisma.$transaction([
    prisma.webAuthnCredential.update({
      where: { credentialId: storedCred.credentialId },
      data: { counter: BigInt(verification.authenticationInfo.newCounter) },
    }),
    prisma.user.update({
      where: { id: user.id },
      data: { passwordResetToken: null, passwordResetExpiry: null },
    }),
  ]);

  clearSessionCookies(res);
  const sessionUser = publicUser(user);
  const { accessToken } = await createSession(req, res, sessionUser);

  await writeAuditLog(req, "LOGIN_SUCCESS", "User", user.id, "Passkey login", {
    actor: { id: user.id, email: user.email, role: user.role },
  });

  res.json({ success: true, token: accessToken, user: sessionUser });
}

// ── DELETE /auth/webauthn/:credentialId ───────────────────────────────────────

export async function webAuthnRemoveCredential(req: Request, res: Response) {
  const cred = await prisma.webAuthnCredential.findUnique({ where: { id: req.params.credentialId } });
  if (!cred || cred.userId !== req.user!.id) throw new ApiError(404, "Credential not found");

  await prisma.webAuthnCredential.delete({ where: { id: req.params.credentialId } });
  await writeAuditLog(req, "WEBAUTHN_REMOVED", "User", req.user!.id, "Passkey removed");
  res.json({ success: true, message: "Passkey removed." });
}
