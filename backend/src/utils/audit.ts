import { Request } from "express";
import { appendAuditRow } from "./auditChain";
import { logger, safeUrl } from "./logger";
import { evaluateAuditEvent } from "./alerting";

// ── Audit trail ──────────────────────────────────────────────────────────────
// One append-only row per security-relevant action: who (user id + email +
// role), when (createdAt), from where (IP + user agent), what (action, entity,
// detail) and how it went (success, severity). Every write is fire-and-forget
// with respect to the request: a logging failure is reported but never turns a
// successful business operation into an error.
//
// Rows are written through `appendAuditRow`, which encrypts the free-text fields
// and HMAC-links the row to its predecessor, so the trail is confidential at
// rest and any later edit or deletion is detectable.

export type AuditSeverity = "INFO" | "WARN" | "CRITICAL";

export interface AuditOptions {
  severity?: AuditSeverity;
  success?: boolean;
  /** Actor to record when req.user is not populated (failed sign-ins, system jobs). */
  actor?: { id?: string | null; email?: string | null; role?: string | null };
}

// Behind a proxy the socket address is the proxy, so trust the first hop.
export function getClientIp(req: Request): string {
  const forwarded = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim();
  return forwarded || req.socket.remoteAddress || "unknown";
}

export function getUserAgent(req: Request): string | undefined {
  const ua = req.headers["user-agent"];
  return typeof ua === "string" ? ua.slice(0, 300) : undefined;
}

export async function writeAuditLog(
  req: Request,
  action: string,
  entity?: string,
  entityId?: string,
  detail?: string,
  options: AuditOptions = {}
) {
  const actor = options.actor;
  try {
    const userId = actor ? actor.id ?? undefined : req.user?.id;
    const userEmail = actor ? actor.email ?? undefined : req.user?.email;
    const userRole = actor ? actor.role ?? undefined : req.user?.role;
    const ipAddress = getClientIp(req);

    const appended = await appendAuditRow({
      userId,
      userEmail,
      userRole,
      action,
      entity,
      entityId,
      detail,
      ipAddress,
      userAgent: getUserAgent(req),
      method: req.method,
      path: safeUrl(req.originalUrl),
      severity: options.severity ?? "INFO",
      success: options.success ?? true,
    });

    // Detection is a side channel: the audited operation never waits for it.
    // evaluateAuditEvent catches its own errors.
    void evaluateAuditEvent({
      id: appended.id,
      createdAt: appended.createdAt,
      action,
      userId,
      userEmail,
      userRole,
      entityId,
      detail,
      ipAddress,
    });
  } catch (err) {
    // Audit log failures must never break the main request
    logger.error("AUDIT_WRITE_FAILED", `Could not persist audit entry ${action}`, err);
  }
}

// System events (startup, shutdown, configuration, dependency failures) share
// the audit table so an administrator sees them next to user activity, but they
// carry no user: the actor is recorded as "system".
export async function writeSystemEvent(
  action: string,
  detail: string,
  severity: AuditSeverity = "INFO",
  meta?: Record<string, unknown>,
  options: { entity?: string; entityId?: string } = {}
) {
  try {
    const appended = await appendAuditRow({
      userEmail: "system",
      userRole: "SYSTEM",
      action,
      entity: options.entity,
      entityId: options.entityId,
      detail,
      severity,
      // A recorded service failure is a failed event regardless of how loudly
      // it is reported; startup/shutdown/configuration events succeeded.
      success: action !== "SERVICE_FAILURE",
    });

    // Critical system events are routed like any other alert (task 2.5).
    if (severity === "CRITICAL") {
      void evaluateAuditEvent({
        id: appended.id,
        createdAt: appended.createdAt,
        action,
        userEmail: "system",
        userRole: "SYSTEM",
        detail,
      });
    }
  } catch (err) {
    logger.error("AUDIT_WRITE_FAILED", `Could not persist system event ${action}`, err);
  }

  // Mirror into the operational log stream as well, so a log collector sees
  // system events even when the database is the thing that is broken.
  if (severity === "CRITICAL") logger.error(action, detail, undefined, meta);
  else if (severity === "WARN") logger.warn(action, detail, meta);
  else logger.info(action, detail, meta);
}
