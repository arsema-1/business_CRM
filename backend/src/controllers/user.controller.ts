import { Request, Response } from "express";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import { prisma } from "../config/db";
import { ApiError } from "../utils/ApiError";
import { writeAuditLog } from "../utils/audit";
import { assertPasswordAcceptable } from "../utils/password";
import { sendMfaDisabledEmail, sendVerificationEmail } from "../utils/mailer";
import { revokeUserSessions } from "../utils/session";

const VALID_ROLES = ["ADMIN", "SALES", "WAREHOUSE", "ACCOUNTS"];

export async function listUsers(req: Request, res: Response) {
  const users = await prisma.user.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id: true, name: true, email: true, role: true, isActive: true,
      emailVerifiedAt: true, lastReviewedAt: true, reviewDueAt: true, createdAt: true,
      selfRegistered: true, approvedAt: true, mfaEnabled: true,
    },
  });
  res.json({ success: true, data: users });
}

export async function createUser(req: Request, res: Response) {
  const { name, email, password, role } = req.body as {
    name?: string; email?: string; password?: string; role?: string;
  };

  if (!name?.trim()) throw new ApiError(400, "name is required");
  if (!email?.trim()) throw new ApiError(400, "email is required");
  if (!password) throw new ApiError(400, "password is required");
  await assertPasswordAcceptable(password, { email, name });
  if (!role || !VALID_ROLES.includes(role)) {
    throw new ApiError(400, `role must be one of: ${VALID_ROLES.join(", ")}`);
  }

  const existing = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
  if (existing) throw new ApiError(409, "A user with this email already exists");

  const passwordHash = await bcrypt.hash(password, 12);

  // New users start inactive and unverified — they must click the email link
  const verificationToken = crypto.randomBytes(32).toString("hex");

  const user = await prisma.user.create({
    data: {
      name: name.trim(),
      email: email.toLowerCase().trim(),
      passwordHash,
      role: role as any,
      isActive: false,
      verificationToken,
    },
    select: { id: true, name: true, email: true, role: true, isActive: true, createdAt: true },
  });

  // Send verification email — non-blocking; mailer logs to console if SMTP unconfigured
  await sendVerificationEmail(user.email, user.name, verificationToken);

  await writeAuditLog(req, "USER_CREATED", "User", user.id, `Created user ${user.email} with role ${user.role} (pending verification)`);
  res.status(201).json({ success: true, data: user });
}

// Approve a verified self-registered account. Until this runs the account can
// sign in and manage its own profile, but every business route returns 403.
export async function approveUser(req: Request, res: Response) {
  const existing = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!existing) throw new ApiError(404, "User not found");

  if (!existing.selfRegistered) {
    throw new ApiError(400, "Only self-registered accounts require approval");
  }
  if (existing.approvedAt) {
    res.json({ success: true, message: "User is already approved" });
    return;
  }
  if (!existing.emailVerifiedAt) {
    throw new ApiError(400, "User must verify their email address before approval");
  }

  const user = await prisma.user.update({
    where: { id: existing.id },
    data: { approvedAt: new Date(), approvedById: req.user!.id },
    select: { id: true, name: true, email: true, role: true, isActive: true, approvedAt: true },
  });

  await writeAuditLog(req, "USER_APPROVED", "User", user.id, `Approved self-registered account ${user.email}`);
  res.json({ success: true, data: user });
}

export async function updateUser(req: Request, res: Response) {
  const { name, role, isActive } = req.body as { name?: string; role?: string; isActive?: boolean };

  const existing = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!existing) throw new ApiError(404, "User not found");

  // Prevent admin from deactivating themselves
  if (req.params.id === req.user?.id && isActive === false) {
    throw new ApiError(400, "You cannot deactivate your own account");
  }

  if (role && !VALID_ROLES.includes(role)) {
    throw new ApiError(400, `role must be one of: ${VALID_ROLES.join(", ")}`);
  }

  const user = await prisma.user.update({
    where: { id: req.params.id },
    data: {
      ...(name?.trim() && { name: name.trim() }),
      ...(role && { role: role as any }),
      ...(isActive !== undefined && { isActive }),
    },
    select: { id: true, name: true, email: true, role: true, isActive: true, createdAt: true },
  });

  // Deactivating an account must take effect now, not when its token expires
  if (isActive === false) {
    await revokeUserSessions(user.id, "ACCOUNT_DEACTIVATED");
  }

  const roleNote =
    role && role !== existing.role ? ` (role ${existing.role} → ${user.role})` : "";
  await writeAuditLog(req, "USER_UPDATED", "User", user.id, `Updated user ${user.email}${roleNote}`);
  res.json({ success: true, data: user });
}

// Break glass for a lost authenticator: an admin clears the second factor so
// the user can sign in with their password and enroll again. Every use is
// audited and all of that user's sessions are revoked, because the request
// proves nothing about who is holding the account right now.
export async function resetMfa(req: Request, res: Response) {
  const existing = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!existing) throw new ApiError(404, "User not found");

  if (!existing.mfaEnabled) {
    res.json({ success: true, message: "Two-factor authentication is not enabled for this user" });
    return;
  }

  await prisma.$transaction([
    prisma.user.update({
      where: { id: existing.id },
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
    prisma.mfaBackupCode.deleteMany({ where: { userId: existing.id } }),
    prisma.mfaChallenge.updateMany({
      where: { userId: existing.id, consumedAt: null },
      data: { consumedAt: new Date() },
    }),
  ]);

  await revokeUserSessions(existing.id, "MFA_RESET_BY_ADMIN");

  await writeAuditLog(
    req,
    "MFA_RESET_BY_ADMIN",
    "User",
    existing.id,
    `Two-factor authentication reset for ${existing.email} by ${req.user!.email}`
  );

  try {
    await sendMfaDisabledEmail(existing.email, existing.name, "an administrator request");
  } catch (err) {
    console.error("[mfa] notification email failed", err);
  }

  res.json({ success: true, message: "Two-factor authentication reset for this user" });
}

export async function resetPassword(req: Request, res: Response) {
  const { password } = req.body as { password?: string };
  if (!password) throw new ApiError(400, "password is required");

  const existing = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!existing) throw new ApiError(404, "User not found");

  await assertPasswordAcceptable(password, { email: existing.email, name: existing.name });

  const passwordHash = await bcrypt.hash(password, 12);
  // Resetting the password also clears any active lockout
  await prisma.user.update({
    where: { id: req.params.id },
    data: { passwordHash, failedLoginAttempts: 0, lockedUntil: null },
  });

  // An admin reset invalidates every existing session for that user
  await revokeUserSessions(existing.id, "PASSWORD_RESET_BY_ADMIN");

  await writeAuditLog(req, "PASSWORD_RESET", "User", req.params.id, `Password reset for ${existing.email}`);
  res.json({ success: true, message: "Password updated" });
}
