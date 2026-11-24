import { Request, Response } from "express";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import { prisma } from "../config/db";
import { ApiError } from "../utils/ApiError";
import { writeAuditLog } from "../utils/audit";
import { sendMfaDisabledEmail, sendMfaRecoveryEmail } from "../utils/mailer";
import { otpauthUri, generateTotpSecret, verifyTotp } from "../utils/totp";
import {
  MAX_CHALLENGE_ATTEMPTS,
  PENDING_SETUP_TTL_MINUTES,
  challengeTicketFrom,
  clearChallenges,
  consumeBackupCode,
  decodeChallengeTicket,
  decryptSecret,
  encryptSecret,
  generateBackupCodes,
  remainingBackupCodes,
} from "../utils/mfa";
import {
  clearMfaChallengeCookie,
  clearSessionCookies,
  createSession,
  hashToken,
  revokeUserSessions,
  type SessionUser,
} from "../utils/session";

// ── Configuration ────────────────────────────────────────────────────────────

const ISSUER = process.env.MFA_ISSUER ?? "Mini ERP CRM";
const RECOVERY_TTL_MINUTES = 30;

// ── Helpers ──────────────────────────────────────────────────────────────────

function toSessionUser(user: {
  id: string;
  name: string;
  email: string;
  role: string;
  selfRegistered: boolean;
  approvedAt: Date | null;
}): SessionUser {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    pendingApproval: user.selfRegistered && !user.approvedAt,
  };
}

// A code is either the current 6-digit TOTP or one of the one-time backup codes.
async function codeSatisfies(user: { id: string; totpSecret: string | null }, code: unknown) {
  const secret = decryptSecret(user.totpSecret);
  if (secret && verifyTotp(secret, String(code ?? ""))) return { ok: true, kind: "totp" as const };
  if (await consumeBackupCode(user.id, code)) return { ok: true, kind: "backup_code" as const };
  return { ok: false, kind: null };
}

// ── POST /auth/mfa/verify ─────────────────────────────────────────────────────
// Second step of the login flow. The password step already succeeded, so this
// endpoint only accepts a live challenge ticket and turns it into a session.

export async function verifyMfaLogin(req: Request, res: Response) {
  const { code, challengeToken } = req.body as { code?: string; challengeToken?: string };

  const ticket = decodeChallengeTicket(challengeTicketFrom(req, challengeToken));
  if (!ticket) {
    clearMfaChallengeCookie(res);
    throw new ApiError(401, "Your two-factor sign-in expired. Please sign in again.");
  }

  const challenge = await prisma.mfaChallenge.findUnique({
    where: { id: ticket.challengeId },
    include: { user: true },
  });

  if (
    !challenge ||
    challenge.userId !== ticket.userId ||
    challenge.consumedAt ||
    challenge.expiresAt <= new Date()
  ) {
    clearMfaChallengeCookie(res);
    throw new ApiError(401, "Your two-factor sign-in expired. Please sign in again.");
  }

  if (challenge.attempts >= MAX_CHALLENGE_ATTEMPTS) {
    await prisma.mfaChallenge.update({ where: { id: challenge.id }, data: { consumedAt: new Date() } });
    clearMfaChallengeCookie(res);
    throw new ApiError(429, "Too many incorrect codes. Please sign in again to get a new challenge.");
  }

  const user = challenge.user;
  if (!user.isActive || !user.emailVerifiedAt || !user.mfaEnabled) {
    await prisma.mfaChallenge.update({ where: { id: challenge.id }, data: { consumedAt: new Date() } });
    clearMfaChallengeCookie(res);
    throw new ApiError(401, "Your account cannot sign in right now.");
  }

  const result = await codeSatisfies(user, code);
  if (!result.ok) {
    const attempts = challenge.attempts + 1;
    await prisma.mfaChallenge.update({ where: { id: challenge.id }, data: { attempts } });
    await writeAuditLog(
      req,
      "MFA_FAILED",
      "User",
      user.id,
      `Incorrect second factor (attempt ${attempts} of ${MAX_CHALLENGE_ATTEMPTS})`,
      { severity: "WARN", success: false, actor: { id: user.id, email: user.email, role: user.role } }
    );
    const left = MAX_CHALLENGE_ATTEMPTS - attempts;
    throw new ApiError(
      401,
      left > 0
        ? `That code is not valid. ${left} attempt${left === 1 ? "" : "s"} remaining.`
        : "Too many incorrect codes. Please sign in again to get a new challenge."
    );
  }

  // Single use: the ticket dies the moment it is spent.
  await prisma.mfaChallenge.update({ where: { id: challenge.id }, data: { consumedAt: new Date() } });
  clearMfaChallengeCookie(res);
  // Fresh cookies every time, never a reused session id (fixation defense)
  clearSessionCookies(res);

  const sessionUser = toSessionUser(user);
  const { accessToken } = await createSession(req, res, sessionUser);

  await writeAuditLog(
    req,
    "LOGIN_SUCCESS",
    "User",
    user.id,
    result.kind === "backup_code" ? "Password + backup code" : "Password + TOTP",
    { actor: { id: user.id, email: user.email, role: user.role } }
  );

  if (result.kind === "backup_code") {
    const left = await remainingBackupCodes(user.id);
    res.json({
      success: true,
      token: accessToken,
      user: sessionUser,
      usedBackupCode: true,
      backupCodesRemaining: left,
    });
    return;
  }

  res.json({ success: true, token: accessToken, user: sessionUser });
}

// ── GET /auth/mfa/status ──────────────────────────────────────────────────────

export async function mfaStatus(req: Request, res: Response) {
  const user = await prisma.user.findUnique({
    where: { id: req.user!.id },
    select: { mfaEnabled: true, mfaEnabledAt: true },
  });
  if (!user) throw new ApiError(404, "User not found");

  res.json({
    success: true,
    enabled: user.mfaEnabled,
    enabledAt: user.mfaEnabledAt,
    backupCodesRemaining: user.mfaEnabled ? await remainingBackupCodes(req.user!.id) : 0,
  });
}

// ── POST /auth/mfa/setup ──────────────────────────────────────────────────────
// Step 1 of enrollment: mint a secret and hand it to the user. The account is
// NOT protected yet — `enable` only flips the switch once a live code proves the
// authenticator is actually set up.

export async function setupMfa(req: Request, res: Response) {
  const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
  if (!user) throw new ApiError(404, "User not found");
  if (user.mfaEnabled) {
    throw new ApiError(400, "Two-factor authentication is already enabled. Disable it first to re-enroll.");
  }

  const secret = generateTotpSecret();
  await prisma.user.update({
    where: { id: user.id },
    data: { pendingTotpSecret: encryptSecret(secret), pendingTotpAt: new Date() },
  });

  await writeAuditLog(req, "MFA_SETUP_STARTED", "User", user.id, `TOTP enrollment started for ${user.email}`);

  res.json({
    success: true,
    secret,
    otpauthUri: otpauthUri(secret, ISSUER, user.email),
    issuer: ISSUER,
    account: user.email,
    digits: 6,
    period: 30,
    expiresInMinutes: PENDING_SETUP_TTL_MINUTES,
  });
}

// ── POST /auth/mfa/enable ─────────────────────────────────────────────────────

export async function enableMfa(req: Request, res: Response) {
  const { code } = req.body as { code?: string };
  if (!code?.trim()) throw new ApiError(400, "Enter the 6-digit code from your authenticator app");

  const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
  if (!user) throw new ApiError(404, "User not found");
  if (user.mfaEnabled) throw new ApiError(400, "Two-factor authentication is already enabled");

  const pending = decryptSecret(user.pendingTotpSecret);
  if (
    !pending ||
    !user.pendingTotpAt ||
    Date.now() - user.pendingTotpAt.getTime() > PENDING_SETUP_TTL_MINUTES * 60 * 1000
  ) {
    throw new ApiError(400, "Your enrollment expired. Please start the setup again.");
  }

  if (!verifyTotp(pending, code)) {
    throw new ApiError(400, "That code is not valid. Check that your authenticator uses the current code and the clock is correct.");
  }

  const backupCodes = await generateBackupCodes(user.id);
  await prisma.user.update({
    where: { id: user.id },
    data: {
      mfaEnabled: true,
      mfaEnabledAt: new Date(),
      totpSecret: user.pendingTotpSecret,
      pendingTotpSecret: null,
      pendingTotpAt: null,
      mfaRecoveryHash: null,
      mfaRecoveryExpiry: null,
    },
  });

  await writeAuditLog(req, "MFA_ENABLED", "User", user.id, `TOTP enabled for ${user.email}`);

  // The plaintext codes are returned exactly once; only hashes are kept.
  res.json({
    success: true,
    message: "Two-factor authentication is now on. Store your backup codes somewhere safe.",
    backupCodes,
  });
}

// ── POST /auth/mfa/disable ────────────────────────────────────────────────────
// Turning the second factor off is itself a two-factor action: password plus a
// live code, so a hijacked session alone cannot weaken the account.

export async function disableMfa(req: Request, res: Response) {
  const { password, code } = req.body as { password?: string; code?: string };
  if (!password) throw new ApiError(400, "Your password is required");
  if (!code?.trim()) throw new ApiError(400, "Enter a code from your authenticator app or a backup code");

  const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
  if (!user) throw new ApiError(404, "User not found");
  if (!user.mfaEnabled) throw new ApiError(400, "Two-factor authentication is not enabled");

  if (!(await bcrypt.compare(password, user.passwordHash))) {
    await writeAuditLog(req, "MFA_DISABLE_FAILED", "User", user.id, "Incorrect password");
    throw new ApiError(401, "Password is incorrect");
  }

  const result = await codeSatisfies(user, code);
  if (!result.ok) {
    await writeAuditLog(req, "MFA_DISABLE_FAILED", "User", user.id, "Incorrect second factor");
    throw new ApiError(401, "That code is not valid");
  }

  await prisma.$transaction([
    prisma.user.update({
      where: { id: user.id },
      data: {
        mfaEnabled: false,
        totpSecret: null,
        pendingTotpSecret: null,
        pendingTotpAt: null,
        mfaEnabledAt: null,
        mfaRecoveryHash: null,
        mfaRecoveryExpiry: null,
      },
    }),
    prisma.mfaBackupCode.deleteMany({ where: { userId: user.id } }),
    prisma.mfaChallenge.updateMany({ where: { userId: user.id, consumedAt: null }, data: { consumedAt: new Date() } }),
  ]);

  await writeAuditLog(req, "MFA_DISABLED", "User", user.id, `TOTP disabled for ${user.email}`);
  res.json({ success: true, message: "Two-factor authentication is off." });
}

// ── POST /auth/mfa/backup-codes ───────────────────────────────────────────────
// Regenerate the recovery set (codes lost, some used, or routine rotation).

export async function regenerateBackupCodes(req: Request, res: Response) {
  const { code } = req.body as { code?: string };
  if (!code?.trim()) throw new ApiError(400, "Enter a code from your authenticator app or a backup code");

  const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
  if (!user) throw new ApiError(404, "User not found");
  if (!user.mfaEnabled) throw new ApiError(400, "Two-factor authentication is not enabled");

  const result = await codeSatisfies(user, code);
  if (!result.ok) {
    await writeAuditLog(req, "MFA_BACKUP_CODES_FAILED", "User", user.id, "Incorrect second factor");
    throw new ApiError(401, "That code is not valid");
  }

  const backupCodes = await generateBackupCodes(user.id);
  await writeAuditLog(req, "MFA_BACKUP_CODES_REGENERATED", "User", user.id, "Backup codes regenerated");

  res.json({
    success: true,
    message: "Your old backup codes no longer work. Store the new ones somewhere safe.",
    backupCodes,
  });
}

// ── POST /auth/mfa/recover/request ────────────────────────────────────────────
// Account recovery for a lost authenticator. Proving control of the verified
// email address lets the user clear the second factor; the same reply is always
// returned so this endpoint cannot be used to discover who has MFA enabled.

const RECOVERY_ACK =
  "If that account has two-factor authentication enabled, a recovery link is on its way.";

export async function requestMfaRecovery(req: Request, res: Response) {
  const { email } = req.body as { email?: string };
  if (!email?.trim()) throw new ApiError(400, "Email is required");

  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });

  if (user && user.isActive && user.mfaEnabled) {
    const token = crypto.randomBytes(32).toString("hex");
    await prisma.user.update({
      where: { id: user.id },
      data: {
        mfaRecoveryHash: hashToken(token),
        mfaRecoveryExpiry: new Date(Date.now() + RECOVERY_TTL_MINUTES * 60 * 1000),
      },
    });

    try {
      await sendMfaRecoveryEmail(user.email, user.name, token);
    } catch (err) {
      console.error("[mfa] recovery email failed", err);
      // The token is still stored; asking again will send a new one.
    }

    await writeAuditLog(
      req,
      "MFA_RECOVERY_REQUESTED",
      "User",
      user.id,
      "Recovery link requested after losing the authenticator",
      { actor: { id: user.id, email: user.email, role: user.role } }
    );
  }

  res.json({ success: true, message: RECOVERY_ACK });
}

// ── POST /auth/mfa/recover/confirm ────────────────────────────────────────────
// The link alone is not enough: the account password must also match. That stops
// a compromised mailbox from turning straight into a compromised CRM account.

export async function confirmMfaRecovery(req: Request, res: Response) {
  const { token, password } = req.body as { token?: string; password?: string };
  if (!token) throw new ApiError(400, "Recovery token is required");
  if (!password) throw new ApiError(400, "Your password is required");

  const user = await prisma.user.findUnique({ where: { mfaRecoveryHash: hashToken(token) } });
  if (!user || !user.mfaRecoveryExpiry || user.mfaRecoveryExpiry < new Date()) {
    throw new ApiError(400, "This recovery link is invalid or has expired. Request a new one.");
  }
  if (!user.isActive) throw new ApiError(403, "This account is not active.");

  if (!(await bcrypt.compare(password, user.passwordHash))) {
    await writeAuditLog(req, "MFA_RECOVERY_FAILED", "User", user.id, "Incorrect password on recovery link", {
      severity: "WARN",
      success: false,
      actor: { id: user.id, email: user.email, role: user.role },
    });
    throw new ApiError(401, "Password is incorrect");
  }

  await prisma.$transaction([
    prisma.user.update({
      where: { id: user.id },
      data: {
        mfaEnabled: false,
        totpSecret: null,
        pendingTotpSecret: null,
        pendingTotpAt: null,
        mfaEnabledAt: null,
        mfaRecoveryHash: null,
        mfaRecoveryExpiry: null,
        // Recovery also clears any lockout: the user has proved both email and
        // password, and being stuck outside the account serves nobody.
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
    }),
    prisma.mfaBackupCode.deleteMany({ where: { userId: user.id } }),
    prisma.mfaChallenge.updateMany({ where: { userId: user.id, consumedAt: null }, data: { consumedAt: new Date() } }),
  ]);

  // Anything that was signed in before the recovery is not trusted afterwards
  await revokeUserSessions(user.id, "MFA_RECOVERY");
  await clearChallenges(user.id);

  await writeAuditLog(
    req,
    "MFA_RECOVERY_COMPLETED",
    "User",
    user.id,
    "Second factor removed via email recovery; all sessions revoked",
    { severity: "WARN", actor: { id: user.id, email: user.email, role: user.role } }
  );

  try {
    await sendMfaDisabledEmail(user.email, user.name, "email account recovery");
  } catch (err) {
    console.error("[mfa] notification email failed", err);
  }

  res.json({
    success: true,
    message: "Two-factor authentication has been turned off. Sign in with your password and set it up again.",
  });
}
