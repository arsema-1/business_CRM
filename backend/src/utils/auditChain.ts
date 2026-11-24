import { prisma } from "../config/db";
import { chainHmac, encryptField, hashesEqual } from "./logCrypto";

// ── Tamper-evident append ────────────────────────────────────────────────────
// Every audit row is written in one transaction that:
//   1. takes a Postgres advisory lock, so concurrent requests cannot both read
//      the same predecessor and fork the chain;
//   2. reads the newest hashed row;
//   3. stores an HMAC over the row's own fields plus the predecessor's hash.
//
// Changing, deleting or reordering any row therefore invalidates every hash
// after it. A database trigger (see the migration) independently rejects UPDATE
// and DELETE on the table, so tampering requires dropping the trigger first.
// Verifying a single row needs only the stored values; no plaintext is required.

const CHAIN_LOCK_ID = 918273645;
const GENESIS = null;

export interface AuditRowInput {
  userId?: string | null;
  userEmail?: string | null;
  userRole?: string | null;
  action: string;
  entity?: string | null;
  entityId?: string | null;
  detail?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  method?: string | null;
  path?: string | null;
  severity: string;
  success: boolean;
}

interface ChainableRow {
  userId: string | null;
  userEmail: string | null;
  userRole: string | null;
  action: string;
  entity: string | null;
  entityId: string | null;
  detail: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  method: string | null;
  path: string | null;
  severity: string;
  success: boolean;
  createdAt: Date;
}

/** Stable serialisation of a row — the exact bytes the HMAC covers. */
function chainPayload(row: ChainableRow): string {
  return JSON.stringify([
    row.userId,
    row.userEmail,
    row.userRole,
    row.action,
    row.entity,
    row.entityId,
    row.detail,
    row.ipAddress,
    row.userAgent,
    row.method,
    row.path,
    row.severity,
    row.success,
    row.createdAt.toISOString(),
  ]);
}

export interface AppendedAuditRow {
  id: string;
  createdAt: Date;
}

export async function appendAuditRow(input: AuditRowInput): Promise<AppendedAuditRow> {
  // Confidential fields are encrypted before they reach the database. The
  // chain is computed over the stored (ciphertext) values.
  const encrypted = {
    ...input,
    detail: encryptField(input.detail) as string | null,
    ipAddress: encryptField(input.ipAddress) as string | null,
    userAgent: encryptField(input.userAgent) as string | null,
  };

  return prisma.$transaction(async (tx) => {
    // The ::text cast only exists so Prisma can deserialize the row; the lock
    // itself is held until this transaction commits.
    await tx.$queryRawUnsafe(`SELECT pg_advisory_xact_lock(${CHAIN_LOCK_ID})::text`);

    const last = await tx.auditLog.findFirst({
      where: { hash: { not: null } },
      orderBy: { seq: "desc" },
      select: { hash: true },
    });

    const prevHash = last?.hash ?? GENESIS;
    const createdAt = new Date();
    const row: ChainableRow = {
      userId: input.userId ?? null,
      userEmail: input.userEmail ?? null,
      userRole: input.userRole ?? null,
      action: input.action,
      entity: input.entity ?? null,
      entityId: input.entityId ?? null,
      detail: encrypted.detail ?? null,
      ipAddress: encrypted.ipAddress ?? null,
      userAgent: encrypted.userAgent ?? null,
      method: input.method ?? null,
      path: input.path ?? null,
      severity: input.severity,
      success: input.success,
      createdAt,
    };

    const created = await tx.auditLog.create({
      data: { ...row, createdAt, prevHash, hash: chainHmac(prevHash, chainPayload(row)) },
      select: { id: true, createdAt: true },
    });
    return created;
  });
}

export interface ChainVerification {
  valid: boolean;
  checked: number;
  legacyRows: number;
  head: string | null;
  brokenAtSeq?: number;
  reason?: string;
}

/**
 * Recompute the chain over every stored row. Rows written before the chain
 * existed (hash = NULL) are reported separately and skipped.
 */
export async function verifyAuditChain(): Promise<ChainVerification> {
  const BATCH = 500;
  let cursor = 0;
  let prevHash: string | null = GENESIS;
  let checked = 0;
  let legacyRows = 0;

  for (;;) {
    const batch = await prisma.auditLog.findMany({
      where: { seq: { gt: cursor } },
      orderBy: { seq: "asc" },
      take: BATCH,
    });
    if (batch.length === 0) break;

    for (const row of batch) {
      cursor = row.seq;

      if (!row.hash) {
        legacyRows += 1;
        continue;
      }

      // The first hashed row must start the chain; later rows must name it.
      if (row.prevHash !== prevHash) {
        return {
          valid: false,
          checked,
          legacyRows,
          head: prevHash,
          brokenAtSeq: row.seq,
          reason: "Previous-hash link does not match the preceding entry",
        };
      }

      const expected = chainHmac(prevHash, chainPayload(row));
      if (!hashesEqual(expected, row.hash)) {
        return {
          valid: false,
          checked,
          legacyRows,
          head: prevHash,
          brokenAtSeq: row.seq,
          reason: "Entry contents do not match its recorded hash",
        };
      }

      prevHash = row.hash;
      checked += 1;
    }
  }

  return { valid: true, checked, legacyRows, head: prevHash };
}
