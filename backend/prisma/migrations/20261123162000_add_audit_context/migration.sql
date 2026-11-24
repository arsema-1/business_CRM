-- Task 2: richer audit rows (actor role, request context, outcome, severity)
ALTER TABLE "AuditLog" ADD COLUMN "userRole" TEXT,
ADD COLUMN "userAgent" TEXT,
ADD COLUMN "method" TEXT,
ADD COLUMN "path" TEXT,
ADD COLUMN "severity" TEXT NOT NULL DEFAULT 'INFO',
ADD COLUMN "success" BOOLEAN NOT NULL DEFAULT true;

-- CreateIndex
CREATE INDEX "AuditLog_severity_idx" ON "AuditLog"("severity");

-- CreateIndex
CREATE INDEX "AuditLog_userEmail_idx" ON "AuditLog"("userEmail");
