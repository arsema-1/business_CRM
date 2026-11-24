-- Tamper-evident audit trail: sequence + hash chain, and append-only enforcement.

-- 1. Monotonic sequence so the chain has a stable order independent of timestamps.
ALTER TABLE "AuditLog" ADD COLUMN "seq" SERIAL NOT NULL,
ADD COLUMN "prevHash" TEXT,
ADD COLUMN "hash" TEXT;

CREATE UNIQUE INDEX "AuditLog_seq_key" ON "AuditLog"("seq");

-- 2. Write-once storage: modifications and deletions are rejected by the database
--    itself, not just by application code. Rows written before this migration keep
--    a NULL hash and are treated as a pre-chain prefix by the verifier.
CREATE OR REPLACE FUNCTION "deny_audit_log_mutation"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AuditLog is append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AuditLog_append_only"
BEFORE UPDATE OR DELETE ON "AuditLog"
FOR EACH ROW EXECUTE FUNCTION "deny_audit_log_mutation"();
