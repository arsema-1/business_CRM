import crypto from "crypto";

// ── Audit log cryptography ───────────────────────────────────────────────────
// Two independent keys are derived from one configured secret:
//   • field-encryption — AES-256-GCM for the free-text parts of an audit row
//     (detail, IP address, user agent), so a database leak or a stolen backup
//     does not expose what people did or where they did it from.
//   • hash-chain — HMAC-SHA256 that links every row to its predecessor, making
//     silent edits, deletions and reordering detectable.
//
// `LOG_ENCRYPTION_KEY` should be set in production. Falling back to JWT_SECRET
// keeps development working and still means the database alone is not enough to
// read the trail. Rotating either key makes previously written rows unreadable /
// unverifiable, which is why the key belongs in the deployment's secret store.
//
// Only the fields that need filtering (actor email, role, action, entity,
// severity, timestamps) stay in cleartext; they are the indexes the admin UI
// queries. Nothing secret is ever written to an audit row in the first place.

const SECRET = process.env.LOG_ENCRYPTION_KEY || process.env.JWT_SECRET || "crm-audit-dev-key";

const MASTER = crypto.createHash("sha256").update(`audit-log:${SECRET}`).digest();

function deriveKey(info: string): Buffer {
  return Buffer.from(crypto.hkdfSync("sha256", MASTER, Buffer.alloc(0), Buffer.from(info), 32));
}

const ENCRYPTION_KEY = deriveKey("field-encryption");
const CHAIN_KEY = deriveKey("hash-chain");

const PREFIX = "enc:v1:";

export function isEncrypted(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(PREFIX);
}

/** Encrypt a field for storage. Null/empty values and already-encrypted values pass through. */
export function encryptField<T extends string | null | undefined>(plain: T): T | string {
  if (plain === null || plain === undefined || plain === "") return plain;
  if (isEncrypted(plain)) return plain;

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", ENCRYPTION_KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [
    PREFIX,
    iv.toString("base64url"),
    ":",
    cipher.getAuthTag().toString("base64url"),
    ":",
    ciphertext.toString("base64url"),
  ].join("");
}

/**
 * Decrypt a stored field. Values written before encryption was introduced (or
 * fields that were never encrypted) are returned unchanged.
 */
export function decryptField(value: string | null | undefined): string | null | undefined {
  if (!isEncrypted(value)) return value;

  const parts = value.slice(PREFIX.length).split(":");
  const [iv, tag, ciphertext] = parts;
  if (parts.length !== 3 || !iv || !tag || !ciphertext) return "[unreadable audit value]";

  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", ENCRYPTION_KEY, Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    const plain = Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]);
    return plain.toString("utf8");
  } catch {
    // Wrong key or a modified ciphertext: the GCM tag check failed.
    return "[unreadable audit value]";
  }
}

/** HMAC used to link one audit row to the next. */
export function chainHmac(prevHash: string | null, payload: string): string {
  return crypto.createHmac("sha256", CHAIN_KEY).update(`${prevHash ?? "genesis"}\n${payload}`).digest("base64url");
}

/** Constant-time comparison of two hex/base64url digests. */
export function hashesEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/** Whether operators configured a dedicated log key (surfaced at startup). */
export const hasDedicatedLogKey = Boolean(process.env.LOG_ENCRYPTION_KEY);
