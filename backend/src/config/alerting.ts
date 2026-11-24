// ── Security alerting configuration (task 2.5) ───────────────────────────────
// Alert thresholds, team routes and escalation timing in one place. Every
// value has a safe default; a malformed .env never throws at startup.

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

function readEmails(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value));
}

export type AlertTeam = "SECURITY" | "OPERATIONS" | "DATA";
export type AlertSeverity = "MEDIUM" | "HIGH" | "CRITICAL";

const securityTeam = readEmails("ALERT_SECURITY_EMAILS");
const escalationContacts = readEmails("ALERT_ESCALATION_EMAILS");
const appUrl = (process.env.APP_URL ?? "http://localhost:5173").replace(/\/+$/, "");

export const alertingConfig = {
  enabled: readBool("ALERTING_ENABLED", true),

  // One generic HTTP webhook reaches chat/on-call tooling (Slack, Teams, a
  // PagerDuty events adapter, or an internal relay). No vendor SDK is needed.
  webhook: {
    url: process.env.ALERT_WEBHOOK_URL ?? "",
    authHeader: process.env.ALERT_WEBHOOK_AUTH_HEADER ?? "",
    timeoutMs: readInt("ALERT_WEBHOOK_TIMEOUT_MS", 5000, 500, 30000),
  },

  // Responsible teams. Alerts are routed by type: sign-in abuse and privilege
  // changes go to security, service/configuration events to operations, and
  // unusual data access to the data owners.
  teams: {
    SECURITY: {
      label: "Security team",
      emails: securityTeam,
    },
    OPERATIONS: {
      label: "IT operations",
      emails: readEmails("ALERT_OPERATIONS_EMAILS"),
    },
    DATA: {
      label: "Data owners",
      emails: readEmails("ALERT_DATA_EMAILS"),
    },
  } satisfies Record<AlertTeam, { label: string; emails: string[] }>,

  // Unacknowledged HIGH/CRITICAL alerts escalate to these contacts (the
  // security team when unset). This is the second tier of the escalation path.
  escalation: {
    emails: escalationContacts.length > 0 ? escalationContacts : securityTeam,
    afterMinutes: readInt("ALERT_ESCALATION_MINUTES", 15, 1, 1440),
    sweepSeconds: readInt("ALERT_ESCALATION_SWEEP_SECONDS", 60, 10, 3600),
  },

  thresholds: {
    // Failed sign-ins (including the lockout event itself) per account.
    failedLogins: {
      count: readInt("ALERT_FAILED_LOGIN_THRESHOLD", 5, 1, 1000),
      windowMinutes: readInt("ALERT_FAILED_LOGIN_WINDOW_MINUTES", 15, 1, 1440),
    },
    // Refused actions (wrong role) per actor.
    authzDenials: {
      count: readInt("ALERT_AUTHZ_DENIAL_THRESHOLD", 10, 1, 1000),
      windowMinutes: readInt("ALERT_AUTHZ_DENIAL_WINDOW_MINUTES", 10, 1, 1440),
    },
    // CSRF refusals per actor.
    csrfRejections: {
      count: readInt("ALERT_CSRF_THRESHOLD", 10, 1, 1000),
      windowMinutes: readInt("ALERT_CSRF_WINDOW_MINUTES", 10, 1, 1440),
    },
    // Reads of the audit trail per actor.
    dataAccess: {
      count: readInt("ALERT_DATA_ACCESS_THRESHOLD", 20, 1, 1000),
      windowMinutes: readInt("ALERT_DATA_ACCESS_WINDOW_MINUTES", 10, 1, 1440),
    },
  },

  // Repeated instances of the same condition inside this window update the
  // existing alert instead of paging the team again.
  cooldownMinutes: readInt("ALERT_COOLDOWN_MINUTES", 30, 1, 1440),

  runbookUrl: process.env.ALERT_RUNBOOK_URL ?? `${appUrl}/monitoring`,
  dashboardUrl: `${appUrl}/monitoring`,
};
