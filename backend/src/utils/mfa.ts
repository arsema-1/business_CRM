import crypto from "crypto";
import { Request } from "express";
import jwt from "jsonwebtoken";
import { prisma } from "../config/db";
import { MFA_COOKIE, readCookie } from "./session";

// ── Configuration ────────────────────────────────────────────────────────────
// The second factor has its own key: `MFA_ENCRYPTION_KEY` should be set in
// production, but deriving from JWT_SECRET keeps development working and still
// means the TOTP seed is unreadable to anyone who only has the database.

export const CHALLENGE_TTL_MINUTES = Number(process.env.MFA_CHALLENGE_MINUTES ?? 5);
export const MAX_CHALLENGE_ATTEMPTS = Number(process.env.MFA_MAX_ATTEMPTS ?? 5);
export const BACKUP_CODE_COUNT = Number(process.env.MFA_BACKUP_CODES ?? 10);
export const PENDING_SETUP_TTL_MINUTES = 15;

const CHALLENGE_TTL_MS = CHALLENGE_TTL_MINUTES * 60 * 1000;

const KEY = crypto
  .createHash("sha256")
  .update(`mfa:${process.env.MFA_ENCRYPTION_KEY || process.env.JWT_SECRET || "crm-mfa-dev-key"}`)
  .digest();

// ── Secret at rest ───────────────────────────────────────────────────────────
// AES-256-GCM so the stored value is both confidential and tamper-evident.

export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(":");
}

export function decryptSecret(payload: string | null | undefined): string | null {
  if (!payload) return null;
  const [version, iv, tag, ciphertext] = payload.split(":");
  if (version !== "v1" || !iv || !tag || !ciphertext) return null;
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", KEY, Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    const plain = Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]);
    return plain.toString("utf8");
  } catch {
    return null;
  }
}

// ── Backup codes ─────────────────────────────────────────────────────────────
// 10 characters from a 32-symbol alphabet (50 bits) shown once, stored only as
// an HMAC. Comparing hashes rather than the codes keeps a database leak useless
// while staying fast enough to check on every attempt.

const CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function randomBackupCode(): string {
  const bytes = crypto.randomBytes(10);
  let raw = "";
  for (const byte of bytes) raw += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

export function normalizeBackupCode(code: unknown): string {
  return String(code ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

export function hashBackupCode(code: string): string {
  return crypto.createHmac("sha256", KEY).update(normalizeBackupCode(code)).digest("hex");
}

export async function generateBackupCodes(userId: string): Promise<string[]> {
  const codes = Array.from({ length: BACKUP_CODE_COUNT }, () => randomBackupCode());
  await prisma.$transaction([
    prisma.mfaBackupCode.deleteMany({ where: { userId } }),
    prisma.mfaBackupCode.createMany({
      data: codes.map((code) => ({ userId, codeHash: hashBackupCode(code) })),
    }),
    // Setup, regeneration and disable all invalidate any half-finished login
    prisma.mfaChallenge.updateMany({
      where: { userId, consumedAt: null },
      data: { consumedAt: new Date() },
    }),
  ]);
  return codes;
}

// Each code works exactly once. The conditional `updateMany` is what makes that
// true even if two requests race with the same code.
export async function consumeBackupCode(userId: string, code: unknown): Promise<boolean> {
  const normalized = normalizeBackupCode(code);
  if (normalized.length !== 10) return false;

  const match = await prisma.mfaBackupCode.findUnique({ where: { codeHash: hashBackupCode(normalized) } });
  if (!match || match.userId !== userId || match.usedAt) return false;

  const claimed = await prisma.mfaBackupCode.updateMany({
    where: { id: match.id, usedAt: null },
    data: { usedAt: new Date() },
  });
  return claimed.count === 1;
}

export async function remainingBackupCodes(userId: string): Promise<number> {
  return prisma.mfaBackupCode.count({ where: { userId, usedAt: null } });
}

// ── Login challenges ─────────────────────────────────────────────────────────
// The ticket handed back after a correct password is a short-lived JWT pointing
// at a database row. It is useless on its own, single use, and attempt-limited.

export interface MfaChallengeTicket {
  challengeId: string;
  userId: string;
}

export async function createMfaChallenge(userId: string, ipAddress: string | null) {
  // Opportunistic cleanup of challenges nobody came back for
  await prisma.mfaChallenge
    .deleteMany({ where: { expiresAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } } })
    .catch(() => undefined);

  const challenge = await prisma.mfaChallenge.create({
    data: {
      userId,
      ipAddress,
      expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
    },
  });

  const token = jwt.sign(
    { sub: userId, purpose: "mfa", jti: challenge.id },
    process.env.JWT_SECRET as string,
    { expiresIn: `${CHALLENGE_TTL_MINUTES}m` }
  );

  return { challenge, token };
}

export function decodeChallengeTicket(token: string | undefined): MfaChallengeTicket | null {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET as string) as jwt.JwtPayload & { purpose?: string };
    if (payload.purpose !== "mfa" || !payload.jti || !payload.sub) return null;
    return { challengeId: payload.jti, userId: payload.sub };
  } catch {
    return null;
  }
}

// The SPA gets the ticket in an HttpOnly cookie so JavaScript cannot copy or
// replay it; API clients may instead pass it in the request body.
export function challengeTicketFrom(req: Request, bodyToken?: unknown): string | undefined {
  if (typeof bodyToken === "string" && bodyToken) return bodyToken;
  return readCookie(req, MFA_COOKIE);
}

export async function clearChallenges(userId: string) {
  await prisma.mfaChallenge
    .updateMany({ where: { userId, consumedAt: null }, data: { consumedAt: new Date() } })
    .catch(() => undefined);
}
