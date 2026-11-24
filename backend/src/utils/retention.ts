import { readdir, stat, unlink } from "fs/promises";
import { join } from "path";
import { loggingConfig } from "../config/logging";
import { prisma } from "../config/db";
import { logger } from "./logger";

// ── Log retention (task 2.4) ─────────────────────────────────────────────────
// Two very different stores need two different policies:
//
//  1. Application log files (LOG_TO_FILE) are operational data. Files older
//     than APP_LOG_RETENTION_DAYS are deleted by the sweep. The central
//     collector keeps its own copy for SIEM_RETENTION_DAYS.
//
//  2. The audit trail is legal/forensic evidence and is protected by an
//     append-only database trigger and a hash chain. The sweep NEVER deletes
//     audit rows: deleting the oldest link would destroy the chain and the
//     evidence. After AUDIT_LOG_RETENTION_DAYS the trail must be archived to
//     encrypted, access-controlled storage by an operator (see
//     docs/logging-and-monitoring.md); the dashboard reports how many rows are
//     past that point so archival is never forgotten.

export interface AuditRetentionStatus {
  policyDays: number;
  totalEntries: number;
  entriesBeyondRetention: number;
  oldestEntryAt: string | null;
  archiveDue: boolean;
  note: string;
}

export interface RetentionSweepResult {
  ranAt: string;
  appLogs: {
    directory: string;
    policyDays: number;
    filesDeleted: number;
    bytesFreed: number;
    errors: number;
  };
  audit: AuditRetentionStatus;
}

const APP_LOG_FILE = /^app-\d{4}-\d{2}-\d{2}\.log$/;

function logDirectory(): string {
  return loggingConfig.file.dir || join(process.cwd(), "logs");
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

async function pruneAppLogs(policyDays: number): Promise<RetentionSweepResult["appLogs"]> {
  const directory = logDirectory();
  const result = { directory, policyDays, filesDeleted: 0, bytesFreed: 0, errors: 0 };
  const cutoff = daysAgo(policyDays).getTime();

  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    // No log directory (file logging off, or nothing written yet).
    return result;
  }

  for (const name of names) {
    if (!APP_LOG_FILE.test(name)) continue;
    const path = join(directory, name);
    try {
      const info = await stat(path);
      if (info.mtime.getTime() >= cutoff) continue;
      await unlink(path);
      result.filesDeleted += 1;
      result.bytesFreed += info.size;
    } catch {
      result.errors += 1;
    }
  }

  return result;
}

export async function getAuditRetentionStatus(): Promise<AuditRetentionStatus> {
  const policyDays = loggingConfig.retention.auditDays;

  // The append-only trigger forbids deletion, so the only correct action here
  // is to measure and report. No count is attempted if the DB is unreachable.
  try {
    const [total, beyond, oldest] = await Promise.all([
      prisma.auditLog.count(),
      prisma.auditLog.count({ where: { createdAt: { lt: daysAgo(policyDays) } } }),
      prisma.auditLog.findFirst({ orderBy: { createdAt: "asc" }, select: { createdAt: true } }),
    ]);

    return {
      policyDays,
      totalEntries: total,
      entriesBeyondRetention: beyond,
      oldestEntryAt: oldest?.createdAt.toISOString() ?? null,
      archiveDue: beyond > 0,
      note:
        beyond > 0
          ? `${beyond} audit entr${beyond === 1 ? "y is" : "ies are"} past the ${policyDays}-day policy. ` +
            "Archive the trail (encrypted) per docs/logging-and-monitoring.md; rows cannot be deleted in place."
          : `Audit trail is within its ${policyDays}-day retention window; no archival due.`,
    };
  } catch (err) {
    logger.error("AUDIT_RETENTION_CHECK_FAILED", "Could not read audit retention status", err);
    return {
      policyDays,
      totalEntries: 0,
      entriesBeyondRetention: 0,
      oldestEntryAt: null,
      archiveDue: false,
      note: "Retention status unavailable: the audit database could not be read.",
    };
  }
}

export async function runRetentionSweep(): Promise<RetentionSweepResult> {
  const appLogs = await pruneAppLogs(loggingConfig.retention.appLogDays);
  const audit = await getAuditRetentionStatus();

  const result: RetentionSweepResult = {
    ranAt: new Date().toISOString(),
    appLogs,
    audit,
  };

  // Report only when the sweep actually did something or archival is due, so
  // a quiet daily sweep does not add noise to the central collector.
  if (appLogs.filesDeleted > 0 || appLogs.errors > 0 || audit.archiveDue) {
    logger.info("LOG_RETENTION_SWEEP", "Log retention sweep completed", {
      filesDeleted: appLogs.filesDeleted,
      bytesFreed: appLogs.bytesFreed,
      errors: appLogs.errors,
      appLogPolicyDays: appLogs.policyDays,
      auditPolicyDays: audit.policyDays,
      auditEntriesBeyondRetention: audit.entriesBeyondRetention,
      archiveDue: audit.archiveDue,
    });
  }

  return result;
}

// One sweep at startup, then daily (RETENTION_SWEEP_HOURS). `unref` so the
// timer never keeps the process alive on its own. The global guard survives
// ts-node-dev hot reloads and prevents duplicate schedulers.
const globalForRetention = global as unknown as { retentionSweepTimer?: NodeJS.Timeout };

export function startRetentionSchedule(): void {
  if (globalForRetention.retentionSweepTimer) return;

  const run = () => {
    void runRetentionSweep().catch((err) =>
      logger.error("LOG_RETENTION_SWEEP_FAILED", "Log retention sweep failed", err)
    );
  };

  run();
  const timer = setInterval(run, loggingConfig.retention.sweepHours * 60 * 60 * 1000);
  timer.unref();
  globalForRetention.retentionSweepTimer = timer;
  logger.info("LOG_RETENTION_SCHEDULED", "Log retention sweep scheduled", {
    everyHours: loggingConfig.retention.sweepHours,
    appLogDays: loggingConfig.retention.appLogDays,
    auditDays: loggingConfig.retention.auditDays,
  });
}
