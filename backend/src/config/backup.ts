import { join, resolve } from "path";

// ── Backup policy (task 3) ───────────────────────────────────────────────────
// Every number that defines the recovery contract lives here so the schedule,
// the dashboard and the documentation cannot drift apart. Backups are disabled
// until an operator supplies an encryption key and a destination: failing closed
// is safer than silently writing plaintext dumps next to the database.
//
// RPO is the maximum acceptable data loss, so the incremental interval must not
// exceed it. RTO is the target time to restore, measured by the periodic restore
// drill and reported by `npm run backup:status`.

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

function int(name: string, fallback: number, min: number, max: number): number {
  const raw = Number.parseInt(process.env[name] ?? "", 10);
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(Math.max(raw, min), max);
}

const workingDirectory = process.cwd();

export const backupConfig = {
  /** Automation and the admin API are active only when this is true. */
  enabled: bool("BACKUP_ENABLED", false),

  /** Encrypted local working copy (the "2" in 3-2-1: database + here + offsite). */
  directory: resolve(process.env.BACKUP_DIR || join(workingDirectory, "backups")),

  /** Offsite/WORM target. Must be a different filesystem or a mounted object store. */
  offsiteDirectory: process.env.BACKUP_OFFSITE_DIR
    ? resolve(process.env.BACKUP_OFFSITE_DIR)
    : null,

  /**
   * Development escape hatch. Production policy requires an offsite copy, so a
   * backup without one is recorded as degraded unless this is explicitly set.
   */
  allowLocalOnly: bool("BACKUP_ALLOW_LOCAL_ONLY", false),

  /** AES-256-GCM master key. Required; there is no plaintext fallback. */
  encryptionKey: process.env.BACKUP_ENCRYPTION_KEY ?? "",

  /** Directory holding pg_dump/pg_restore/psql. Empty means "find on PATH". */
  pgBin: process.env.BACKUP_PG_BIN ?? "",

  /** Full base snapshot cadence and the RPO-bearing incremental cadence. */
  fullIntervalHours: int("BACKUP_FULL_INTERVAL_HOURS", 168, 1, 24 * 90),
  incrementalIntervalHours: int("BACKUP_INCREMENTAL_INTERVAL_HOURS", 1, 0.25, 168),
  rpoMinutes: int("BACKUP_RPO_MINUTES", 60, 5, 24 * 60 * 30),
  rtoMinutes: int("BACKUP_RTO_MINUTES", 60, 5, 24 * 60),

  /** How long encrypted sets are kept, and the minimum number of full copies. */
  retentionDays: int("BACKUP_RETENTION_DAYS", 35, 7, 3650),
  minFullCopies: int("BACKUP_MIN_FULL_COPIES", 2, 1, 50),

  /** Periodic proof that the newest snapshot restores, not just decrypts. */
  restoreTestIntervalDays: int("BACKUP_RESTORE_TEST_INTERVAL_DAYS", 30, 1, 365),

  /** Scheduler wake-up and stale-lock recovery. */
  checkIntervalMinutes: int("BACKUP_CHECK_INTERVAL_MINUTES", 15, 1, 1440),
  lockStaleMinutes: int("BACKUP_LOCK_STALE_MINUTES", 180, 10, 1440),

  /** Immutable offsite copy: read-only local marker plus WORM documentation. */
  offsiteImmutable: bool("BACKUP_OFFSITE_IMMUTABLE", true),
  immutableRetentionDays: int("BACKUP_IMMUTABLE_RETENTION_DAYS", 35, 7, 3650),

  /** pg_dump parallelism. Directory format supports it; leave at 1 for small DBs. */
  pgDumpJobs: int("BACKUP_PG_DUMP_JOBS", 1, 1, 8),
} as const;

export interface BackupConfigIssue {
  variable: string;
  problem: string;
}

/**
 * Returns every reason the current configuration cannot honour the policy.
 * Used by the CLI (hard fail), the API (reported to the admin) and the scheduler
 * (logs and refuses to run) so an operator sees the same explanation everywhere.
 */
export function validateBackupConfig(): BackupConfigIssue[] {
  const issues: BackupConfigIssue[] = [];

  if (!backupConfig.enabled) return issues;

  if (!backupConfig.encryptionKey) {
    issues.push({
      variable: "BACKUP_ENCRYPTION_KEY",
      problem: "encryption key is required; backups are never written in plaintext",
    });
  } else if (backupConfig.encryptionKey.length < 32) {
    issues.push({
      variable: "BACKUP_ENCRYPTION_KEY",
      problem: "key must be at least 32 characters (use `openssl rand -base64 32`)",
    });
  }

  if (!backupConfig.offsiteDirectory && !backupConfig.allowLocalOnly) {
    issues.push({
      variable: "BACKUP_OFFSITE_DIR",
      problem:
        "no offsite destination configured (3-2-1 rule); set BACKUP_OFFSITE_DIR or BACKUP_ALLOW_LOCAL_ONLY=true for a development machine",
    });
  }

  if (
    backupConfig.offsiteDirectory &&
    resolve(backupConfig.offsiteDirectory) === resolve(backupConfig.directory)
  ) {
    issues.push({
      variable: "BACKUP_OFFSITE_DIR",
      problem: "offsite destination must not be the local backup directory",
    });
  }

  if (backupConfig.incrementalIntervalHours * 60 > backupConfig.rpoMinutes) {
    issues.push({
      variable: "BACKUP_INCREMENTAL_INTERVAL_HOURS",
      problem: `interval is longer than the declared RPO of ${backupConfig.rpoMinutes} minutes`,
    });
  }

  if (
    backupConfig.offsiteImmutable &&
    backupConfig.immutableRetentionDays < backupConfig.retentionDays
  ) {
    issues.push({
      variable: "BACKUP_IMMUTABLE_RETENTION_DAYS",
      problem: "immutable retention must be at least as long as BACKUP_RETENTION_DAYS so pruning never fights the WORM policy",
    });
  }

  return issues;
}

/** Safe, non-secret view of the policy for the admin API and config snapshot. */
export function backupPolicySnapshot() {
  return {
    enabled: backupConfig.enabled,
    offsiteConfigured: Boolean(backupConfig.offsiteDirectory),
    offsiteImmutable: backupConfig.offsiteDirectory ? backupConfig.offsiteImmutable : false,
    localOnlyAllowed: backupConfig.allowLocalOnly,
    encryption: "AES-256-GCM",
    schedule: {
      fullEveryHours: backupConfig.fullIntervalHours,
      incrementalEveryHours: backupConfig.incrementalIntervalHours,
      rpoMinutes: backupConfig.rpoMinutes,
      rtoMinutes: backupConfig.rtoMinutes,
    },
    retention: {
      days: backupConfig.retentionDays,
      minFullCopies: backupConfig.minFullCopies,
      immutableDays: backupConfig.immutableRetentionDays,
    },
    restoreTestEveryDays: backupConfig.restoreTestIntervalDays,
    encryptionKeyConfigured: Boolean(backupConfig.encryptionKey),
  };
}
