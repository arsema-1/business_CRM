import { Request, Response } from "express";
import { prisma } from "../config/db";
import { loggingConfig } from "../config/logging";
import { getLogShippingStatus } from "../utils/logShipper";
import { getAuditRetentionStatus } from "../utils/retention";
import { getAlertRoutingStatus } from "../utils/alerting";
import { decryptField } from "../utils/logCrypto";
import { ApiError } from "../utils/ApiError";
import { writeAuditLog } from "../utils/audit";

// ── Security monitoring dashboard (task 2.4) ─────────────────────────────────
// Aggregates the audit trail into security-relevant trends so an administrator
// can see them without reading the raw log. The data source is the same
// tamper-evident AuditLog table the trail view uses; the operational log stream
// (rate limits, 5xx) is visible in the central collector instead, because a
// flood of throttled requests must not become a flood of database rows.

interface DailyRow {
  day: string;
  total: number;
  failures: number;
  critical: number;
  login_failures: number;
  login_blocked: number;
  lockouts: number;
  authz_denials: number;
  csrf_rejections: number;
  token_reuse: number;
}

// Audit timestamps are stored in UTC (Postgres timestamp without time zone), so
// the buckets are built in UTC too. Using local time here would shift counts by
// a day on hosts whose timezone is not UTC.
function startOfWindow(days: number): Date {
  const now = new Date();
  const utcMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(utcMidnight - (days - 1) * 24 * 60 * 60 * 1000);
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export async function getSecurityTrends(req: Request, res: Response) {
  const rawDays = parseInt((req.query.days as string) || "7", 10);
  const days = Number.isFinite(rawDays) ? Math.min(Math.max(rawDays, 1), 90) : 7;
  const since = startOfWindow(days);

  // One pass over the window produces the per-day series; Prisma's groupBy
  // cannot FILTER, so the raw query keeps this to a single table scan.
  const rows = await prisma.$queryRaw<DailyRow[]>`
    SELECT
      to_char(date_trunc('day', "createdAt"), 'YYYY-MM-DD') AS day,
      count(*)::int AS total,
      count(*) FILTER (WHERE "success" = false)::int AS failures,
      count(*) FILTER (WHERE "severity" = 'CRITICAL')::int AS critical,
      count(*) FILTER (WHERE "action" = 'LOGIN_FAILED')::int AS login_failures,
      count(*) FILTER (WHERE "action" = 'LOGIN_BLOCKED_LOCKED')::int AS login_blocked,
      count(*) FILTER (WHERE "action" = 'ACCOUNT_LOCKED')::int AS lockouts,
      count(*) FILTER (WHERE "action" = 'AUTHZ_DENIED')::int AS authz_denials,
      count(*) FILTER (WHERE "action" = 'CSRF_REJECTED')::int AS csrf_rejections,
      count(*) FILTER (WHERE "action" = 'REFRESH_TOKEN_REUSE')::int AS token_reuse
    FROM "AuditLog"
    WHERE "createdAt" >= ${since}
    GROUP BY 1
    ORDER BY 1
  `;

  // Fill missing days so the chart has a continuous axis.
  const byDay = new Map(rows.map((row) => [row.day, row]));
  const daily = Array.from({ length: days }, (_, i) => {
    const date = new Date(since.getTime() + i * 24 * 60 * 60 * 1000);
    const key = isoDay(date);
    const row = byDay.get(key);
    return {
      day: key,
      total: row?.total ?? 0,
      failures: row?.failures ?? 0,
      critical: row?.critical ?? 0,
      loginFailures: row?.login_failures ?? 0,
      loginBlocked: row?.login_blocked ?? 0,
      lockouts: row?.lockouts ?? 0,
      authzDenials: row?.authz_denials ?? 0,
      csrfRejections: row?.csrf_rejections ?? 0,
      tokenReuse: row?.token_reuse ?? 0,
    };
  });

  const summary = daily.reduce(
    (acc, d) => ({
      totalEvents: acc.totalEvents + d.total,
      failures: acc.failures + d.failures,
      critical: acc.critical + d.critical,
      failedLogins: acc.failedLogins + d.loginFailures,
      blockedLogins: acc.blockedLogins + d.loginBlocked,
      lockouts: acc.lockouts + d.lockouts,
      authzDenials: acc.authzDenials + d.authzDenials,
      csrfRejections: acc.csrfRejections + d.csrfRejections,
      tokenReuse: acc.tokenReuse + d.tokenReuse,
    }),
    {
      totalEvents: 0,
      failures: 0,
      critical: 0,
      failedLogins: 0,
      blockedLogins: 0,
      lockouts: 0,
      authzDenials: 0,
      csrfRejections: 0,
      tokenReuse: 0,
    }
  );

  const [actionGroups, severityGroups, actorGroups, recentCritical, auditRetention, alertSeverityGroups, openAlerts] = await Promise.all([
    prisma.auditLog.groupBy({
      by: ["action"],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
    }),
    prisma.auditLog.groupBy({
      by: ["severity"],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
    }),
    prisma.auditLog.groupBy({
      by: ["userEmail"],
      where: { createdAt: { gte: since }, success: false, userEmail: { not: null } },
      _count: { _all: true },
    }),
    prisma.auditLog.findMany({
      where: { createdAt: { gte: since }, severity: { in: ["WARN", "CRITICAL"] } },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: {
        id: true,
        userEmail: true,
        userRole: true,
        action: true,
        entity: true,
        detail: true,
        severity: true,
        success: true,
        createdAt: true,
      },
    }),
    getAuditRetentionStatus(),
    prisma.securityAlert.groupBy({
      by: ["severity"],
      where: { acknowledgedAt: null },
      _count: { _all: true },
    }),
    prisma.securityAlert.findMany({
      where: { acknowledgedAt: null },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: {
        id: true,
        alertType: true,
        severity: true,
        team: true,
        title: true,
        detail: true,
        occurrences: true,
        notifiedAt: true,
        escalatedAt: true,
        createdAt: true,
      },
    }),
  ]);

  const topActions = actionGroups
    .map((group) => ({ action: group.action, count: group._count._all }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  const severity = severityGroups.reduce<Record<string, number>>((acc, group) => {
    acc[group.severity] = group._count._all;
    return acc;
  }, {});

  const topActors = actorGroups
    .map((group) => ({ userEmail: group.userEmail, failures: group._count._all }))
    .sort((a, b) => b.failures - a.failures)
    .slice(0, 5);

  const shipping = getLogShippingStatus();
  const alertRouting = getAlertRoutingStatus();
  const openAlertCounts = alertSeverityGroups.reduce<Record<string, number>>((acc, group) => {
    acc[group.severity] = group._count._all;
    return acc;
  }, {});
  const openAlertTotal = Object.values(openAlertCounts).reduce((sum, count) => sum + count, 0);

  // Plain-language alerts: what an administrator should look at today.
  const alerts: string[] = [];
  const today = daily[daily.length - 1];
  if (summary.critical > 0) alerts.push(`${summary.critical} critical security event(s) in the selected window.`);
  if (today.loginFailures >= 10) alerts.push(`${today.loginFailures} failed sign-ins today; check for credential stuffing.`);
  if (summary.lockouts > 0) alerts.push(`${summary.lockouts} account lockout(s) occurred.`);
  if (summary.tokenReuse > 0) alerts.push("Refresh-token reuse detected; a session may be compromised.");
  if (summary.csrfRejections > 0) alerts.push(`${summary.csrfRejections} cross-site request refusal(s) recorded.`);
  if (shipping.enabled && shipping.dropped > 0) alerts.push(`${shipping.dropped} log record(s) were dropped before reaching the SIEM.`);
  if (shipping.enabled && shipping.failedBatches > 0) alerts.push("The central log collector rejected at least one batch.");
  if (!shipping.enabled) alerts.push("Central log shipping is not configured (SIEM_URL is empty).");
  if (auditRetention.archiveDue) alerts.push(auditRetention.note);
  if (openAlertTotal > 0) alerts.push(`${openAlertTotal} security alert(s) are open and need acknowledgement.`);
  if (
    alertRouting.enabled &&
    !alertRouting.webhookConfigured &&
    alertRouting.teams.every((team) => team.recipients === 0)
  ) {
    alerts.push("Security alerting has no delivery route configured (ALERT_WEBHOOK_URL or team emails).");
  }

  res.json({
    success: true,
    data: {
      window: { days, from: since.toISOString(), to: new Date().toISOString() },
      summary,
      severity,
      daily,
      topActions,
      topActors,
      recentCritical: recentCritical.map((row) => ({
        ...row,
        detail: (decryptField(row.detail) as string | null) ?? null,
      })),
      alerts,
      alerting: {
        routing: alertRouting,
        openTotal: openAlertTotal,
        openBySeverity: openAlertCounts,
        recent: openAlerts,
      },
      pipeline: {
        shipping,
        retention: {
          appLogDays: loggingConfig.retention.appLogDays,
          auditLogDays: loggingConfig.retention.auditDays,
          siemDays: loggingConfig.retention.siemDays,
          sweepHours: loggingConfig.retention.sweepHours,
        },
        auditRetention,
      },
    },
  });
}

// ── Routed security alerts (task 2.5) ───────────────────────────────────────
// Open alerts are what the responsible team must action. Acknowledgement is
// recorded (and audited) so the escalation sweep stops re-paging the team for an
// alert someone is already handling.

export async function listAlerts(req: Request, res: Response) {
  const status = (req.query.status as string | undefined) ?? "open";
  const severity = req.query.severity as string | undefined;
  const team = req.query.team as string | undefined;
  const limit = Math.min(Math.max(parseInt((req.query.limit as string) || "50", 10), 1), 200);

  const where: Record<string, unknown> = {};
  if (status === "open") where.acknowledgedAt = null;
  else if (status === "acknowledged") where.acknowledgedAt = { not: null };
  if (severity) where.severity = severity.toUpperCase();
  if (team) where.team = team.toUpperCase();

  const [rows, openGroups] = await Promise.all([
    prisma.securityAlert.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
    }),
    prisma.securityAlert.groupBy({
      by: ["severity"],
      where: { acknowledgedAt: null },
      _count: { _all: true },
    }),
  ]);

  const openBySeverity = openGroups.reduce<Record<string, number>>((acc, group) => {
    acc[group.severity] = group._count._all;
    return acc;
  }, {});

  res.json({
    success: true,
    data: rows,
    summary: {
      openTotal: Object.values(openBySeverity).reduce((sum, count) => sum + count, 0),
      openBySeverity,
    },
    routing: getAlertRoutingStatus(),
  });
}

export async function acknowledgeAlert(req: Request, res: Response) {
  const alert = await prisma.securityAlert.findUnique({ where: { id: req.params.id } });
  if (!alert) throw new ApiError(404, "Alert not found");

  if (alert.acknowledgedAt) {
    res.json({ success: true, message: "Alert was already acknowledged", data: alert });
    return;
  }

  const updated = await prisma.securityAlert.update({
    where: { id: alert.id },
    data: {
      acknowledgedAt: new Date(),
      acknowledgedById: req.user!.id,
      acknowledgedByEmail: req.user!.email,
    },
  });

  await writeAuditLog(
    req,
    "SECURITY_ALERT_ACKNOWLEDGED",
    "SecurityAlert",
    alert.id,
    `Acknowledged ${alert.severity} alert "${alert.title}" (${alert.alertType}) routed to ${alert.team}`
  );

  res.json({ success: true, data: updated });
}
