// ── Logging and monitoring configuration (task 2.4) ──────────────────────────
// One place for the log level, the central-collector (SIEM) target and the
// retention windows, so the logger, the shipper and the admin dashboard all
// report the same policy. Every value has a safe default; nothing here throws
// on a malformed .env.

function readInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

function readBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return raw.toLowerCase() === "true";
}

const LOG_DIR = process.env.LOG_DIR || "";

export const loggingConfig = {
  level: (process.env.LOG_LEVEL ?? "info").toLowerCase(),

  // Local JSONL files. OFF by default: in a container the platform normally
  // collects stdout, and the SIEM shipper below is the durable central copy.
  file: {
    enabled: readBool("LOG_TO_FILE", false),
    dir: LOG_DIR,
  },

  // Central collector. Compatible with any HTTP JSON endpoint (Vector, Fluent
  // Bit, Logstash HTTP input, a Splunk HEC adapter, a serverless ingest
  // function). Shipping is best-effort and never blocks a request.
  siem: {
    url: process.env.SIEM_URL ?? "",
    // Raw Authorization value, e.g. "Splunk <token>" or "Bearer <token>".
    authHeader: process.env.SIEM_AUTH_HEADER ?? "",
    source: process.env.SIEM_SOURCE || "mini-erp-crm",
    batchSize: readInt("SIEM_BATCH_SIZE", 50, 1, 500),
    flushSeconds: readInt("SIEM_FLUSH_SECONDS", 5, 1, 60),
    maxBuffer: readInt("SIEM_MAX_BUFFER", 1000, 10, 10000),
    timeoutMs: readInt("SIEM_TIMEOUT_MS", 5000, 500, 30000),
  },

  // Retention windows, in days. Application logs are pruned automatically.
  // The audit trail is append-only and is never deleted by the sweep: the
  // audit window is the point after which an operator must archive (see
  // docs/logging-and-monitoring.md).
  retention: {
    appLogDays: readInt("APP_LOG_RETENTION_DAYS", 30, 1, 3650),
    auditDays: readInt("AUDIT_LOG_RETENTION_DAYS", 365, 1, 36500),
    siemDays: readInt("SIEM_RETENTION_DAYS", 90, 1, 36500),
    sweepHours: readInt("RETENTION_SWEEP_HOURS", 24, 1, 168),
  },
};
