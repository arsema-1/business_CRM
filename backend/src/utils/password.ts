import crypto from "crypto";
import { ApiError } from "./ApiError";

// ── Policy ───────────────────────────────────────────────────────────────────
// Shared by registration, password reset, self-service change and admin-created
// accounts so every path into the system enforces the same rules.

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 72; // bcrypt only reads the first 72 bytes

// Small built-in list for the obvious cases. The real check is the breached
// password lookup below, which covers far more than a static list can.
const COMMON_PASSWORDS = new Set([
  "password", "password1", "password12", "password123", "password1234",
  "passw0rd", "p@ssw0rd", "p@ssword", "passwort", "pa55word",
  "123456", "1234567", "12345678", "123456789", "1234567890", "12345",
  "111111", "000000", "654321", "987654321", "qwerty", "qwerty123",
  "qwertyuiop", "1q2w3e4r", "1qaz2wsx", "zaq12wsx", "asdfghjkl",
  "letmein", "letmein123", "welcome", "welcome1", "welcome123",
  "admin", "admin123", "administrator", "root", "toor", "changeme",
  "iloveyou", "monkey", "dragon", "football", "baseball", "superman",
  "trustno1", "sunshine", "master", "shadow", "michael", "jennifer",
  "abc123", "abcd1234", "test1234", "secret", "secret123",
  "companyname", "crm123456", "letmeinplease", "correcthorsebattery",
]);

export interface PasswordContext {
  email?: string;
  name?: string;
}

// Synchronous policy check — no network. Returns a user-facing reason or null.
export function passwordPolicyError(password: string, ctx: PasswordContext = {}): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters long`;
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return `Password must be ${PASSWORD_MAX_LENGTH} characters or fewer`;
  }

  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  if (classes < 3) {
    return "Password must use at least three of: lowercase letters, uppercase letters, numbers and symbols";
  }

  if (/(.)\1{3,}/.test(password)) {
    return "Password must not repeat the same character four or more times in a row";
  }

  const lower = password.toLowerCase();
  const alphanumeric = lower.replace(/[^a-z0-9]/g, "");
  if (COMMON_PASSWORDS.has(lower) || COMMON_PASSWORDS.has(alphanumeric)) {
    return "That password is too common. Please choose something less predictable";
  }

  const personalTokens = [ctx.email?.split("@")[0], ctx.name]
    .map((v) => v?.toLowerCase().trim())
    .filter((v): v is string => !!v && v.length >= 3);
  if (personalTokens.some((token) => lower.includes(token))) {
    return "Password must not contain your name or email address";
  }

  return null;
}

// ── Breached-password check (HIBP k-anonymity) ───────────────────────────────
// Only the first 5 hex chars of the SHA-1 hash leave the server; the full
// password and full hash never do.
// Returns true = breached, false = not found, null = service unavailable.

async function isBreachedPassword(password: string): Promise<boolean | null> {
  const sha1 = crypto.createHash("sha1").update(password).digest("hex").toUpperCase();
  const prefix = sha1.slice(0, 5);
  const suffix = sha1.slice(5);

  try {
    const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
      headers: {
        "Add-Padding": "true",
        "User-Agent": "mini-erp-crm-password-check",
      },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;

    const body = await res.text();
    for (const line of body.split("\n")) {
      const [hashSuffix, count] = line.trim().split(":");
      if (hashSuffix?.toUpperCase() === suffix && Number(count) > 0) return true;
    }
    return false;
  } catch {
    // Fail open: an outage of the lookup service must not block password
    // changes. The local policy checks have already run.
    console.warn("[password] breached-password lookup unavailable; skipping");
    return null;
  }
}

// Full check: local policy first, then the breached-password list.
// Throws ApiError(400) with an actionable message when the password is refused.
export async function assertPasswordAcceptable(
  password: string,
  ctx: PasswordContext = {}
): Promise<void> {
  const policyError = passwordPolicyError(password, ctx);
  if (policyError) throw new ApiError(400, policyError);

  const breached = await isBreachedPassword(password);
  if (breached === true) {
    throw new ApiError(
      400,
      "This password has appeared in a known data breach. Please choose a different one"
    );
  }
}
