import crypto from "crypto";

// TOTP (RFC 6238) with the defaults every authenticator app understands:
// SHA-1, 6 digits, 30-second steps. Implemented on node:crypto so adding a
// second factor does not pull a new dependency into the supply chain.

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; // RFC 4648 base32
export const TOTP_DIGITS = 6;
export const TOTP_PERIOD_SECONDS = 30;
// One step of clock drift either way: phones are rarely more than 30s off.
const DRIFT_STEPS = 1;

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

// 160 bits is the size RFC 4226 recommends and what Google Authenticator expects.
export function generateTotpSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

export function totpCode(secret: string, counter: number): string {
  const key = base32Decode(secret);
  const message = Buffer.alloc(8);
  message.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  message.writeUInt32BE(counter >>> 0, 4);

  const hmac = crypto.createHmac("sha1", key).update(message).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    (hmac[offset + 1] << 16) |
    (hmac[offset + 2] << 8) |
    hmac[offset + 3];

  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function currentTotpCode(secret: string, at: number = Date.now()): string {
  return totpCode(secret, Math.floor(at / 1000 / TOTP_PERIOD_SECONDS));
}

// Constant-time check across the drift window. A code cannot be replayed within
// its own step only because the challenge that carried it is single use.
export function verifyTotp(secret: string, code: string, at: number = Date.now()): boolean {
  const candidate = String(code ?? "").replace(/\s+/g, "");
  if (!/^\d{6}$/.test(candidate)) return false;

  const counter = Math.floor(at / 1000 / TOTP_PERIOD_SECONDS);
  for (let step = -DRIFT_STEPS; step <= DRIFT_STEPS; step++) {
    if (safeEqual(totpCode(secret, counter + step), candidate)) return true;
  }
  return false;
}

// The otpauth:// URI is what an authenticator app scans or imports. It is not a
// secret in itself beyond the shared key it carries, so it is only shown to the
// signed-in user during enrollment.
export function otpauthUri(secret: string, issuer: string, account: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
