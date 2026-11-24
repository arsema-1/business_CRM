-- AlterTable
ALTER TABLE "User" ADD COLUMN "emailVerifiedAt"     TIMESTAMP(3),
                  ADD COLUMN "passwordResetExpiry"  TIMESTAMP(3),
                  ADD COLUMN "passwordResetToken"   TEXT,
                  ADD COLUMN "verificationToken"    TEXT;

-- CreateTable
CREATE TABLE "WebAuthnCredential" (
    "id"           TEXT        NOT NULL,
    "userId"       TEXT        NOT NULL,
    "credentialId" TEXT        NOT NULL,
    "publicKey"    TEXT        NOT NULL,
    "counter"      BIGINT      NOT NULL DEFAULT 0,
    "deviceName"   TEXT,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WebAuthnCredential_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WebAuthnCredential_credentialId_key" ON "WebAuthnCredential"("credentialId");
CREATE INDEX        "WebAuthnCredential_userId_idx"       ON "WebAuthnCredential"("userId");
CREATE UNIQUE INDEX "User_verificationToken_key"          ON "User"("verificationToken");
CREATE UNIQUE INDEX "User_passwordResetToken_key"         ON "User"("passwordResetToken");

-- AddForeignKey
ALTER TABLE "WebAuthnCredential"
    ADD CONSTRAINT "WebAuthnCredential_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
