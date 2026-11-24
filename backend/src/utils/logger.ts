import { appendFile, mkdir } from "fs";
import { join } from "path";
import { loggingConfig } from "../config/logging";
import { shipLog } from "./logShipper";

// ── Structured application log ───────────────────────────────────────────────
// Security and operational events are written as one JSON object per line, so
// they can be shipped straight into any log collector (Loki, CloudWatch, Datadog)
// without a parsing rule. Audit *records* live in the AuditLog table; this module
// is the operational/system side of task 2.2 and the console trail for 2.1.
//
// No third-party logger: nothing here is allowed to throw into a request path.

export type LogLevel = "debug" | "info" | "warn" | "error" | "security";

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  security: 45,
};

function configuredMinLevel(): LogLevel {
  const raw = loggingConfig.level;
  return (["debug", "info", "warn", "error", "security"] as LogLevel[]).includes(raw as LogLevel)
    ? (raw as LogLevel)
    : "info";
}

const MIN_LEVEL = LEVEL_RANK[configuredMinLevel()];
const LOG_TO_FILE = loggingConfig.file.enabled;
const LOG_DIR = loggingConfig.file.dir || join(process.cwd(), "logs");

// Anything that could carry a credential is never written out, even inside a
// nested object or a request body fragment handed to the logger.
const SENSITIVE_KEY = /(password|passwd|secret|token|cookie|authorization|captcha|api_?key|credential|otp)/i;
// Exact names that are secrets on their own but would false-positive as
// substrings (`statusCode`, `countryCode`, …).
const SENSITIVE_EXACT = new Set(["code", "hash", "key", "pin"]);

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_EXACT.has(key.toLowerCase()) || SENSITIVE_KEY.test(key);
}

function scrub(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return value.length > 2000 ? `${value.slice(0, 2000)}…` : value;
  if (typeof value !== "object") return value;
  if (depth > 4) return "[depth limit]";
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (Array.isArray(value)) return value.slice(0, 25).map((v) => scrub(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = isSensitiveKey(k) ? "[redacted]" : scrub(v, depth + 1);
  }
  return out;
}

// Query strings may carry reset/recovery tokens; keep the parameters, drop the
// values.
export function safeUrl(url: string): string {
  const [path, query] = url.split("?", 2);
  if (!query) return path;
  const cleaned = query
    .split("&")
    .map((pair) => {
      const [name] = pair.split("=", 1);
      return isSensitiveKey(name) ? `${name}=[redacted]` : pair;
    })
    .join("&");
  return `${path}?${cleaned}`;
}

let dirReady = false;

function writeLine(level: LogLevel, event: string, message?: string, meta?: Record<string, unknown>) {
  const record = {
    ts: new Date().toISOString(),
    level,
    event,
    ...(message ? { message } : {}),
    pid: process.pid,
    ...(meta ? (scrub(meta) as Record<string, unknown>) : {}),
  };

  const line = `${JSON.stringify(record)}\n`;
  try {
    process.stdout.write(line);
  } catch {
    // stdout closed: nothing sensible left to do
  }

  // Central collector gets the same record, with the same scrubbing applied.
  // Queued locally: the request path never waits for the network.
  shipLog(record);

  if (!LOG_TO_FILE) return;
  try {
    const day = record.ts.slice(0, 10);
    const file = join(LOG_DIR, `app-${day}.log`);
    if (!dirReady) {
      // Logs can contain personal data: keep the directory and files private to
      // the service account (0700/0600) instead of relying on the umask.
      mkdir(LOG_DIR, { recursive: true, mode: 0o700 }, () => undefined);
      dirReady = true;
    }
    appendFile(file, line, { mode: 0o600 }, () => undefined);
  } catch {
    // never let a log sink failure break the caller
  }
}

function emit(level: LogLevel, event: string, message?: string, meta?: Record<string, unknown>) {
  try {
    if (LEVEL_RANK[level] < MIN_LEVEL) return;
    writeLine(level, event, message, meta);
  } catch {
    // logging must never throw
  }
}

export const logger = {
  debug: (event: string, message?: string, meta?: Record<string, unknown>) => emit("debug", event, message, meta),
  info: (event: string, message?: string, meta?: Record<string, unknown>) => emit("info", event, message, meta),
  warn: (event: string, message?: string, meta?: Record<string, unknown>) => emit("warn", event, message, meta),
  // A failure worth investigating: operational error or failed dependency.
  error: (event: string, message?: string, error?: unknown, meta?: Record<string, unknown>) =>
    emit("error", event, message, { ...(meta ?? {}), ...(error ? { error: scrub(error) } : {}) }),
  // A security-relevant event that is not a business audit row (rate limits,
  // suspicious input, dependency tampering).
  security: (event: string, message?: string, meta?: Record<string, unknown>) =>
    emit("security", event, message, meta),
};
