-- Security alerting (task 2.5): persisted alerts, acknowledgement state and
-- escalation tracking. Not append-only: an administrator must be able to
-- acknowledge an alert. The underlying security event is already immutable in
-- "AuditLog".

-- CreateTable
CREATE TABLE "SecurityAlert" (
    "id" TEXT NOT NULL,
    "alertType" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "team" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" VARCHAR(2000) NOT NULL,
    "dedupKey" TEXT NOT NULL,
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "source" TEXT,
    "sourceEventId" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedById" TEXT,
    "acknowledgedByEmail" TEXT,
    "escalatedAt" TIMESTAMP(3),
    "notifiedAt" TIMESTAMP(3),
    "notificationError" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SecurityAlert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SecurityAlert_dedupKey_idx" ON "SecurityAlert"("dedupKey");
CREATE INDEX "SecurityAlert_createdAt_idx" ON "SecurityAlert"("createdAt");
CREATE INDEX "SecurityAlert_acknowledgedAt_idx" ON "SecurityAlert"("acknowledgedAt");
CREATE INDEX "SecurityAlert_severity_idx" ON "SecurityAlert"("severity");
CREATE INDEX "SecurityAlert_team_idx" ON "SecurityAlert"("team");
