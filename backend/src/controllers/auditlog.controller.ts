import { Request, Response } from "express";
import { prisma } from "../config/db";
import { ApiError } from "../utils/ApiError";
import { writeAuditLog } from "../utils/audit";
import { verifyAuditChain } from "../utils/auditChain";
import { decryptField } from "../utils/logCrypto";

// Free-text fields are encrypted at rest, so they are decrypted here for the
// administrator — and only here: no other endpoint returns audit rows.
function decryptRow<T extends { detail: string | null; ipAddress: string | null; userAgent: string | null }>(row: T): T {
  return {
    ...row,
    detail: (decryptField(row.detail) as string | null) ?? null,
    ipAddress: (decryptField(row.ipAddress) as string | null) ?? null,
    userAgent: (decryptField(row.userAgent) as string | null) ?? null,
  };
}

// Reading the security trail is itself a sensitive action, so every view of it
// is recorded (task 2.1: "log access to sensitive resources").
export async function listAuditLogs(req: Request, res: Response) {
  const page = Math.max(parseInt((req.query.page as string) || "1", 10), 1);
  const limit = Math.min(Math.max(parseInt((req.query.limit as string) || "50", 10), 1), 100);
  const action = req.query.action as string | undefined;
  const userEmail = req.query.userEmail as string | undefined;
  const entity = req.query.entity as string | undefined;
  const severity = req.query.severity as string | undefined;
  const from = req.query.from as string | undefined;
  const to = req.query.to as string | undefined;

  const where: Record<string, unknown> = {};
  if (action) where.action = action;
  if (entity) where.entity = entity;
  if (severity) where.severity = severity.toUpperCase();
  if (userEmail) where.userEmail = { contains: userEmail, mode: "insensitive" };

  if (from || to) {
    const range: Record<string, Date> = {};
    if (from) {
      const start = new Date(from);
      if (isNaN(start.getTime())) throw new ApiError(400, "from must be an ISO date");
      range.gte = start;
    }
    if (to) {
      const end = new Date(to);
      if (isNaN(end.getTime())) throw new ApiError(400, "to must be an ISO date");
      range.lte = end;
    }
    where.createdAt = range;
  }

  const [total, rows] = await Promise.all([
    prisma.auditLog.count({ where }),
    prisma.auditLog.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { createdAt: "desc" },
    }),
  ]);

  const data = rows.map(decryptRow);

  await writeAuditLog(
    req,
    "AUDIT_LOGS_VIEWED",
    "AuditLog",
    undefined,
    `Viewed audit trail (page ${page}, ${total} matching entries)` +
      [
        action && `action=${action}`,
        severity && `severity=${severity}`,
        userEmail && `userEmail=${userEmail}`,
        entity && `entity=${entity}`,
      ]
        .filter(Boolean)
        .map((part) => `, ${part}`)
        .join("")
  );

  res.json({ success: true, data, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
}

// ── GET /audit-logs/verify ────────────────────────────────────────────────────
// Recomputes the HMAC chain and reports the first broken link, if any. Admin
// only, like the trail itself.
export async function verifyAuditLogs(req: Request, res: Response) {
  const result = await verifyAuditChain();

  await writeAuditLog(
    req,
    "AUDIT_LOGS_VERIFIED",
    "AuditLog",
    undefined,
    result.valid
      ? `Audit chain verified (${result.checked} entries, ${result.legacyRows} pre-chain)`
      : `Audit chain BROKEN at seq ${result.brokenAtSeq}: ${result.reason}`,
    { severity: result.valid ? "INFO" : "CRITICAL", success: result.valid }
  );

  res.json({ success: true, data: result });
}
