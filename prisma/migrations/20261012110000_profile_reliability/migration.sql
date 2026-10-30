ALTER TABLE "Profile" ADD COLUMN "snapshotId" TEXT;
ALTER TABLE "Profile" ADD COLUMN "storageResetRequested" BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE "WarmupSiteHealth" (
 "id" TEXT NOT NULL PRIMARY KEY, "domain" TEXT NOT NULL, "channel" TEXT NOT NULL, "channelLabel" TEXT NOT NULL,
 "success" INTEGER NOT NULL DEFAULT 0, "failure" INTEGER NOT NULL DEFAULT 0, "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
 "lastStatus" INTEGER, "lastReason" TEXT, "lastSuccessAt" DATETIME, "lastAttemptAt" DATETIME NOT NULL,
 "cooldownUntil" DATETIME, "durationMs" INTEGER
);
CREATE UNIQUE INDEX "WarmupSiteHealth_domain_channel_key" ON "WarmupSiteHealth"("domain", "channel");
CREATE INDEX "WarmupSiteHealth_cooldownUntil_idx" ON "WarmupSiteHealth"("cooldownUntil");
ALTER TABLE "Proxy" ADD COLUMN "fingerprintBinding" JSONB;
