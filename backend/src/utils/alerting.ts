import { prisma } from "../config/db";
import { alertingConfig, type AlertSeverity, type AlertTeam } from "../config/alerting";
import { logger } from "./logger";
import { sendSecurityAlertEmail } from "./mailer";

// ── Security alerting (task 2.5) ─────────────────────────────────────────────
// Detection runs against the audit trail. Three kinds of rule are supported:
//
//   * immediate events  — a single critical action (token replay, lockout,
//                         privilege escalation, admin security change);
//   * threshold rules  — repeated failures in a window (failed sign-ins,
//                         authorization denials, CSRF refusals, sensitive
//                         reads), counted from the audit table;
//   * startup checks   — the configuration fingerprint changed since the last
//                         successful start.
//
// Every alert is persisted first, then delivered to the team that owns it. If
// it is still unacknowledged after ALERT_ESCALATION_MINUTES it is delivered
// again to the escalation contacts. Delivery problems never throw into the
// request path; they are stored on the alert and counted in the dashboard.

export interface AuditEvent {
  id: string;
  createdAt: Date;
  action: string;
  userId?: string | null;
  userEmail?: string | null;
  userRole?: string | null;
  entityId?: string | null;
  detail?: string | null;
  ipAddress?: string | null;
}

export interface RaiseAlertInput {
  alertType: string;
  severity: AlertSeverity;
  team: AlertTeam;
  title: string;
  detail: string;
  dedupKey?: string;
  sourceEventId?: string | null;
}

interface AlertsGlobal {
  escalationTimer?: NodeJS.Timeout;
  escalationRunning?: boolean;
}

const globalForAlerts = global as unknown as AlertsGlobal;

function windowStart(minutes: number): Date {
  return new Date(Date.now() - minutes * 60 * 1000);
}

function clip(value: string, max = 2000): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

async function notify(alert: {
  id: string;
  alertType: string;
  severity: string;
  team: string;
  title: string;
  detail: string;
  occurrences: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
}, stage: "PRIMARY" | "ESCALATION"): Promise<void> {
  const team = alert.team as AlertTeam;
  const escalation = stage === "ESCALATION";
  const recipients = escalation
    ? alertingConfig.escalation.emails
    : (alertingConfig.teams[team]?.emails ?? []);
  const errors: string[] = [];
  let delivered = false;

  const routingNote = escalation
    ? `Escalated after ${alertingConfig.escalation.afterMinutes} minute(s) without acknowledgement.`
    : `Routed to ${alertingConfig.teams[team]?.label ?? alert.team}.`;
  const text =
    `[${alert.severity}] ${alert.title}\n` +
    `${routingNote}\n` +
    `Occurrences: ${alert.occurrences} (first ${alert.firstSeenAt.toISOString()}, last ${alert.lastSeenAt.toISOString()})\n` +
    `Team: ${alert.team}\n` +
    `Runbook/dashboard: ${alertingConfig.runbookUrl}`;

  if (recipients.length > 0) {
    try {
      const sent = await sendSecurityAlertEmail(recipients, `[${alert.severity}] ${alert.title}`, text, {
        alertId: alert.id,
        team: alert.team,
        escalation,
        runbookUrl: alertingConfig.runbookUrl,
      });
      if (sent) delivered = true;
      else errors.push("email: SMTP is not configured");
    } catch (err) {
      errors.push(`email: ${(err as Error)?.message ?? "unknown error"}`);
    }
  }

  if (alertingConfig.webhook.url) {
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (alertingConfig.webhook.authHeader) {
        headers.Authorization = alertingConfig.webhook.authHeader;
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), alertingConfig.webhook.timeoutMs);
      try {
        const res = await fetch(alertingConfig.webhook.url, {
          method: "POST",
          headers,
          body: JSON.stringify({
            source: "mini-erp-crm",
            environment: process.env.NODE_ENV ?? "development",
            sentAt: new Date().toISOString(),
            text,
            escalation,
            alert,
            routing: {
              team: alert.team,
              escalationContacts: escalation,
              runbookUrl: alertingConfig.runbookUrl,
              dashboardUrl: alertingConfig.dashboardUrl,
            },
          }),
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`webhook responded ${res.status}`);
        delivered = true;
      } finally {
        clearTimeout(timeout);
      }
    } catch (err) {
      errors.push(`webhook: ${(err as Error)?.message ?? "unknown error"}`);
    }
  }

  if (!recipients.length && !alertingConfig.webhook.url) {
    errors.push("no recipients or webhook configured");
  }

  try {
    await prisma.securityAlert.update({
      where: { id: alert.id },
      data: escalation
        ? { escalatedAt: new Date(), notificationError: errors.length ? clip(errors.join("; "), 500) : null }
        : {
            notifiedAt: delivered ? new Date() : null,
            notificationError: errors.length ? clip(errors.join("; "), 500) : null,
          },
    });
  } catch (err) {
    logger.error("ALERT_STATE_UPDATE_FAILED", "Could not record alert delivery state", err, {
      alertId: alert.id,
    });
  }

  if (errors.length > 0) {
    logger.error("ALERT_DELIVERY_FAILED", `Could not fully deliver alert \"${alert.title}\"`, undefined, {
      alertId: alert.id,
      stage,
      errors,
    });
  }
}

/** Persist an alert and route it. De-duplicates within the cooldown window. */
export async function raiseAlert(input: RaiseAlertInput): Promise<void> {
  if (!alertingConfig.enabled) return;

  const dedupKey = input.dedupKey ?? `${input.alertType}:${input.team}`;
  const now = new Date();

  try {
    // Only OPEN alerts absorb repeats. Once someone has acknowledged an alert,
    // a new occurrence is a new event that must page the owning team again —
    // otherwise a second burst inside the cooldown window would be recorded on
    // an alert nobody is looking at any more.
    const existing = await prisma.securityAlert.findFirst({
      where: {
        dedupKey,
        acknowledgedAt: null,
        lastSeenAt: { gte: windowStart(alertingConfig.cooldownMinutes) },
      },
      orderBy: { lastSeenAt: "desc" },
    });

    if (existing) {
      await prisma.securityAlert.update({
        where: { id: existing.id },
        data: {
          occurrences: { increment: 1 },
          lastSeenAt: now,
          detail: clip(input.detail),
        },
      });
      return;
    }

    const alert = await prisma.securityAlert.create({
      data: {
        alertType: input.alertType,
        severity: input.severity,
        team: input.team,
        title: input.title,
        detail: clip(input.detail),
        dedupKey,
        source: "audit",
        sourceEventId: input.sourceEventId ?? null,
        firstSeenAt: now,
        lastSeenAt: now,
      },
    });

    logger.security("SECURITY_ALERT_RAISED", input.title, {
      alertId: alert.id,
      alertType: input.alertType,
      severity: input.severity,
      team: input.team,
    });

    await notify(alert, "PRIMARY");
  } catch (err) {
    // Alerting is a side channel: it must never break the audited operation.
    logger.error("ALERT_RAISE_FAILED", `Could not raise alert ${input.alertType}`, err, {
      severity: input.severity,
      team: input.team,
    });
  }
}

// ── Rule evaluation ──────────────────────────────────────────────────────────

async function countRecent(
  action: string | string[],
  userEmail: string,
  minutes: number
): Promise<number> {
  return prisma.auditLog.count({
    where: {
      action: Array.isArray(action) ? { in: action } : action,
      userEmail,
      createdAt: { gte: windowStart(minutes) },
    },
  });
}

/**
 * Evaluate one freshly written audit event. Fire-and-forget: callers do not
 * await it and it never throws.
 */
export async function evaluateAuditEvent(event: AuditEvent): Promise<void> {
  if (!alertingConfig.enabled) return;

  try {
    const actor = event.userEmail ?? "unknown";

    // Critical service failures (uncaught exceptions, bind failures) are
    // operational alerts, not user activity. They arrive through
    // writeSystemEvent rather than a request.
    if (event.action === "SERVICE_FAILURE") {
      await raiseAlert({
        alertType: "SERVICE_FAILURE",
        severity: "CRITICAL",
        team: "OPERATIONS",
        title: "Critical service failure",
        detail: `${event.detail ?? "The service reported a critical failure"}. Check the process supervisor, logs and dependency health.`,
        dedupKey: "SERVICE_FAILURE",
        sourceEventId: event.id,
      });
    }

    // Multiple failed sign-ins for one account. The lockout event is counted
    // too so the fifth failure is visible even though it is recorded as
    // ACCOUNT_LOCKED, but a lockout has its own higher-severity alert.
    if (event.action === "LOGIN_FAILED" && event.userEmail) {
      const rule = alertingConfig.thresholds.failedLogins;
      const count = await countRecent(
        ["LOGIN_FAILED", "ACCOUNT_LOCKED"],
        event.userEmail,
        rule.windowMinutes
      );
      if (count >= rule.count) {
        await raiseAlert({
          alertType: "FAILED_LOGIN_BURST",
          severity: "HIGH",
          team: "SECURITY",
          title: "Multiple failed sign-ins",
          detail:
            `${count} failed sign-in(s) for ${event.userEmail} in the last ` +
            `${rule.windowMinutes} minute(s), most recently from ${event.ipAddress ?? "an unknown address"}. ` +
            "Check for credential stuffing or a password-spray attempt, and contact the account owner.",
          dedupKey: `FAILED_LOGIN_BURST:${actor}`,
          sourceEventId: event.id,
        });
      }
    }

    if (event.action === "ACCOUNT_LOCKED") {
      await raiseAlert({
        alertType: "ACCOUNT_LOCKOUT",
        severity: "HIGH",
        team: "SECURITY",
        title: "Account locked after repeated failures",
        detail:
          `${event.userEmail ?? "An account"} was locked after repeated failed sign-ins ` +
          `(source ${event.ipAddress ?? "unknown"}). Verify with the account owner before unlocking.`,
        dedupKey: `ACCOUNT_LOCKOUT:${actor}`,
        sourceEventId: event.id,
      });
    }

    if (event.action === "REFRESH_TOKEN_REUSE") {
      await raiseAlert({
        alertType: "SESSION_TOKEN_REPLAY",
        severity: "CRITICAL",
        team: "SECURITY",
        title: "Refresh token replay detected",
        detail:
          `An already-rotated refresh token was replayed for ${event.userEmail ?? "a user"}; ` +
          "the session was revoked. Treat the account as potentially compromised and review recent activity.",
        dedupKey: `TOKEN_REPLAY:${actor}`,
        sourceEventId: event.id,
      });
    }

    if ((event.action === "AUTHZ_DENIED" || event.action === "CSRF_REJECTED") && event.userEmail) {
      const isCsrf = event.action === "CSRF_REJECTED";
      const rule = isCsrf
        ? alertingConfig.thresholds.csrfRejections
        : alertingConfig.thresholds.authzDenials;
      const count = await countRecent(event.action, event.userEmail, rule.windowMinutes);

      if (count >= rule.count) {
        await raiseAlert({
          alertType: isCsrf ? "CSRF_REJECTION_BURST" : "AUTHORIZATION_DENIAL_BURST",
          severity: isCsrf ? "MEDIUM" : "HIGH",
          team: "SECURITY",
          title: isCsrf ? "Repeated CSRF refusals" : "Repeated authorization denials",
          detail:
            `${count} ${isCsrf ? "CSRF refusal(s)" : "authorization denial(s)"} for ${event.userEmail} ` +
            `in the last ${rule.windowMinutes} minute(s). This can indicate a probing or compromised session.`,
          dedupKey: `${isCsrf ? "CSRF_BURST" : "AUTHZ_BURST"}:${actor}`,
          sourceEventId: event.id,
        });
      }
    }

    // Privilege escalation: an approved role change, or a direct role edit in
    // user management. Promotion to ADMIN is always critical.
    const roleChange =
      event.action === "ROLE_CHANGE_APPROVED" ||
      (event.action === "USER_UPDATED" && /\brole\b/i.test(event.detail ?? "") && (event.detail ?? "").includes("→"));

    if (roleChange) {
      const becameAdmin = /→\s*ADMIN\b/.test(event.detail ?? "");
      await raiseAlert({
        alertType: "PRIVILEGE_ESCALATION",
        severity: becameAdmin ? "CRITICAL" : "HIGH",
        team: "SECURITY",
        title: becameAdmin ? "Account promoted to administrator" : "User role changed",
        detail:
          `${event.detail ?? "A role change was approved"} (actor ${actor}, source ${event.ipAddress ?? "unknown"}). ` +
          "Confirm the change matches an approved request and that the approver was not the requester.",
        dedupKey: `PRIVILEGE_ESCALATION:${event.entityId ?? event.detail ?? actor}`,
        sourceEventId: event.id,
      });
    }

    // Break-glass account changes are high-risk: they can hand over an account
    // without the owner's second factor.
    if (event.action === "MFA_RESET_BY_ADMIN" || event.action === "PASSWORD_RESET") {
      await raiseAlert({
        alertType: "SENSITIVE_ACCOUNT_CHANGE",
        severity: "HIGH",
        team: "SECURITY",
        title: event.action === "MFA_RESET_BY_ADMIN" ? "Second factor reset by an administrator" : "Password reset by an administrator",
        detail:
          `${event.detail ?? event.action} requested by ${actor}. ` +
          "Verify the request came from the account owner and review the account's recent sessions.",
        dedupKey: `SENSITIVE_ACCOUNT_CHANGE:${event.entityId ?? event.userEmail ?? "unknown"}`,
        sourceEventId: event.id,
      });
    }

    // Unusual data access: an administrator repeatedly opening the audit trail
    // is the read activity this application records. It is routed to the data
    // owners, with security escalation if it is not acknowledged.
    if (event.action === "AUDIT_LOGS_VIEWED" && event.userEmail) {
      const rule = alertingConfig.thresholds.dataAccess;
      const count = await countRecent(event.action, event.userEmail, rule.windowMinutes);
      if (count >= rule.count) {
        await raiseAlert({
          alertType: "UNUSUAL_DATA_ACCESS",
          severity: "MEDIUM",
          team: "DATA",
          title: "Unusual audit-trail access",
          detail:
            `${event.userEmail} opened the audit trail ${count} time(s) in the last ` +
            `${rule.windowMinutes} minute(s) (source ${event.ipAddress ?? "unknown"}). ` +
            "Confirm the access is for an approved investigation.",
          dedupKey: `UNUSUAL_DATA_ACCESS:${actor}`,
          sourceEventId: event.id,
        });
      }
    }
  } catch (err) {
    logger.error("ALERT_EVALUATION_FAILED", "Could not evaluate an audit event for alerting", err, {
      action: event.action,
    });
  }
}

// ── Configuration-change detection ──────────────────────────────────────────

/**
 * Compare this start's configuration fingerprint with the previous recorded
 * one (stored as the CONFIG_LOADED audit row's entityId). Returns the previous
 * fingerprint when a change was detected. Called after the database connects.
 */
export async function checkConfigurationChange(currentFingerprint: string): Promise<string | null> {
  if (!alertingConfig.enabled) return null;

  try {
    const rows = await prisma.auditLog.findMany({
      where: { action: "CONFIG_LOADED", entityId: { not: null } },
      orderBy: { createdAt: "desc" },
      take: 2,
      select: { entityId: true, createdAt: true },
    });

    const previous = rows.find(
      (row) => row.entityId && row.entityId !== currentFingerprint
    );
    if (!previous?.entityId) return null;

    await raiseAlert({
      alertType: "CONFIGURATION_CHANGED",
      severity: "HIGH",
      team: "OPERATIONS",
      title: "Application configuration changed",
      detail:
        `The configuration fingerprint changed from ${previous.entityId} ` +
        `(recorded ${previous.createdAt.toISOString()}) to ${currentFingerprint}. ` +
        "Review the startup CONFIG_LOADED audit entry and confirm the change was scheduled.",
      dedupKey: `CONFIG_CHANGED:${currentFingerprint}`,
      sourceEventId: previous.entityId,
    });

    return previous.entityId;
  } catch (err) {
    logger.error("ALERT_CONFIG_CHECK_FAILED", "Could not compare configuration fingerprints", err);
    return null;
  }
}

// ── Escalation ───────────────────────────────────────────────────────────────

/**
 * Re-deliver HIGH/CRITICAL alerts that have stayed unacknowledged past
 * ALERT_ESCALATION_MINUTES, once each. Returns how many were escalated.
 */
export async function runEscalationSweep(): Promise<number> {
  if (!alertingConfig.enabled) return 0;
  if (globalForAlerts.escalationRunning) return 0;
  globalForAlerts.escalationRunning = true;

  try {
    const cutoff = new Date(
      Date.now() - alertingConfig.escalation.afterMinutes * 60 * 1000
    );

    const due = await prisma.securityAlert.findMany({
      where: {
        acknowledgedAt: null,
        escalatedAt: null,
        severity: { in: ["HIGH", "CRITICAL"] },
        createdAt: { lte: cutoff },
      },
      orderBy: { createdAt: "asc" },
      take: 50,
    });

    for (const alert of due) {
      await notify(alert, "ESCALATION");
    }

    if (due.length > 0) {
      logger.warn("SECURITY_ALERTS_ESCALATED", "Unacknowledged alerts escalated", {
        count: due.length,
        afterMinutes: alertingConfig.escalation.afterMinutes,
      });
    }

    return due.length;
  } catch (err) {
    logger.error("ALERT_ESCALATION_SWEEP_FAILED", "Could not escalate unacknowledged alerts", err);
    return 0;
  } finally {
    globalForAlerts.escalationRunning = false;
  }
}

export function startAlertEscalationSchedule(): void {
  if (!alertingConfig.enabled || globalForAlerts.escalationTimer) return;

  const run = () => {
    void runEscalationSweep();
  };

  run();
  const timer = setInterval(run, alertingConfig.escalation.sweepSeconds * 1000);
  timer.unref();
  globalForAlerts.escalationTimer = timer;

  logger.info("ALERT_ESCALATION_SCHEDULED", "Security alert escalation sweep scheduled", {
    everySeconds: alertingConfig.escalation.sweepSeconds,
    afterMinutes: alertingConfig.escalation.afterMinutes,
  });
}

// ── Routing status for the dashboard ────────────────────────────────────────

export interface AlertRoutingStatus {
  enabled: boolean;
  webhookConfigured: boolean;
  escalationAfterMinutes: number;
  runbookUrl: string;
  teams: { team: AlertTeam; label: string; recipients: number }[];
}

export function getAlertRoutingStatus(): AlertRoutingStatus {
  return {
    enabled: alertingConfig.enabled,
    webhookConfigured: Boolean(alertingConfig.webhook.url),
    escalationAfterMinutes: alertingConfig.escalation.afterMinutes,
    runbookUrl: alertingConfig.runbookUrl,
    teams: (Object.keys(alertingConfig.teams) as AlertTeam[]).map((team) => ({
      team,
      label: alertingConfig.teams[team].label,
      recipients: alertingConfig.teams[team].emails.length,
    })),
  };
}
