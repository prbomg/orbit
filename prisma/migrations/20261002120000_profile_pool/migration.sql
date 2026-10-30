-- CreateTable
CREATE TABLE "WarmupJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "profileId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "stage" TEXT NOT NULL DEFAULT 'queued',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "errorCode" TEXT,
    "retryAfter" DATETIME,
    "owner" TEXT,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "WarmupJob_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WorkflowLease" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "owner" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Task" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT,
    "targetExecutions" INTEGER NOT NULL DEFAULT 1,
    "currentExecutions" INTEGER NOT NULL DEFAULT 0,
    "yandexRegionId" INTEGER,
    "profileId" TEXT,
    "taskType" TEXT NOT NULL DEFAULT 'target',
    "searchEngine" TEXT NOT NULL DEFAULT '',
    "searchQueries" JSONB NOT NULL DEFAULT [],
    "vitalPhrases" JSONB NOT NULL DEFAULT [],
    "url" TEXT NOT NULL DEFAULT '',
    "targetKeywords" JSONB NOT NULL DEFAULT [],
    "status" TEXT NOT NULL DEFAULT 'running',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Task_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Task_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Task" ("createdAt", "currentExecutions", "id", "profileId", "projectId", "searchEngine", "searchQueries", "status", "targetExecutions", "targetKeywords", "taskType", "url", "vitalPhrases", "yandexRegionId") SELECT "createdAt", "currentExecutions", "id", "profileId", "projectId", "searchEngine", "searchQueries", "status", "targetExecutions", "targetKeywords", "taskType", "url", "vitalPhrases", "yandexRegionId" FROM "Task";
DROP TABLE "Task";
ALTER TABLE "new_Task" RENAME TO "Task";
CREATE INDEX "Task_createdAt_idx" ON "Task"("createdAt");
CREATE INDEX "Task_status_idx" ON "Task"("status");
CREATE INDEX "Task_profileId_idx" ON "Task"("profileId");
CREATE INDEX "Task_projectId_idx" ON "Task"("projectId");
CREATE TABLE "new_Proxy" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "username" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "rotationUrl" TEXT,
    "channel" TEXT NOT NULL DEFAULT '',
    "purpose" TEXT NOT NULL DEFAULT 'shared'
);
INSERT INTO "new_Proxy" ("host", "id", "isActive", "password", "port", "rotationUrl", "username") SELECT "host", "id", "isActive", "password", "port", "rotationUrl", "username" FROM "Proxy";
DROP TABLE "Proxy";
ALTER TABLE "new_Proxy" RENAME TO "Proxy";
CREATE UNIQUE INDEX "Proxy_host_port_username_key" ON "Proxy"("host", "port", "username");
CREATE TABLE "new_Settings" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT DEFAULT 1,
    "rucaptchaApiKey" TEXT,
    "openaiApiKey" TEXT,
    "autoReplenishEnabled" BOOLEAN NOT NULL DEFAULT false,
    "minReadyProfiles" INTEGER NOT NULL DEFAULT 100,
    "replenishBatchSize" INTEGER NOT NULL DEFAULT 100,
    "warmupEnabled" BOOLEAN NOT NULL DEFAULT true,
    "warmupConcurrency" INTEGER NOT NULL DEFAULT 1,
    "maxPendingProfiles" INTEGER NOT NULL DEFAULT 500,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_Settings" ("autoReplenishEnabled", "id", "minReadyProfiles", "openaiApiKey", "replenishBatchSize", "rucaptchaApiKey", "updatedAt") SELECT "autoReplenishEnabled", "id", "minReadyProfiles", "openaiApiKey", "replenishBatchSize", "rucaptchaApiKey", "updatedAt" FROM "Settings";
DROP TABLE "Settings";
ALTER TABLE "new_Settings" RENAME TO "Settings";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "WarmupJob_profileId_key" ON "WarmupJob"("profileId");

-- CreateIndex
CREATE INDEX "WarmupJob_status_retryAfter_idx" ON "WarmupJob"("status", "retryAfter");

-- CreateIndex
CREATE INDEX "WorkflowLease_owner_idx" ON "WorkflowLease"("owner");

-- CreateIndex
CREATE INDEX "WorkflowLease_expiresAt_idx" ON "WorkflowLease"("expiresAt");

-- Preserve historical project/profile exclusions before detaching legacy tasks.
INSERT OR IGNORE INTO "ProjectProfileUse" ("id","projectId","profileId","reservedAt","usedAt")
SELECT 'pool-history-' || "id", "projectId", "profileId", "executedAt", "executedAt" FROM "ProfileProjectHistory";
INSERT OR IGNORE INTO "ProjectProfileUse" ("id","projectId","profileId","taskId","reservedAt","usedAt")
SELECT 'pool-legacy-' || "id", "projectId", "profileId", "id", "createdAt", "createdAt" FROM "Task"
WHERE "taskType"='target' AND "currentExecutions">0 AND "projectId" IS NOT NULL AND "profileId" IS NOT NULL;
UPDATE "ProjectProfileUse" SET "usedAt"=COALESCE("usedAt", "reservedAt")
WHERE EXISTS (SELECT 1 FROM "ProfileProjectHistory" h WHERE h."projectId"="ProjectProfileUse"."projectId" AND h."profileId"="ProjectProfileUse"."profileId")
OR EXISTS (SELECT 1 FROM "Task" t WHERE t."id"="ProjectProfileUse"."taskId" AND t."currentExecutions">0 AND t."profileId"="ProjectProfileUse"."profileId");
DELETE FROM "ProjectProfileUse" WHERE "usedAt" IS NULL;
UPDATE "TaskExecution" SET "status"='failed', "errorCode"='pool_migration' WHERE "status" IN ('queued','running');
UPDATE "Task" SET "profileId"=NULL WHERE "taskType"='target';

INSERT INTO "WarmupJob" ("id","profileId","status","stage","progress","completedAt","updatedAt")
SELECT 'warmup-' || p."id", p."id",
 CASE WHEN EXISTS(SELECT 1 FROM "Task" t WHERE t."profileId"=p."id" AND t."taskType"='warmup' AND t."status"='running') THEN 'queued'
      WHEN EXISTS(SELECT 1 FROM "Task" t WHERE t."profileId"=p."id" AND t."taskType"='warmup' AND t."status"='paused') THEN 'paused'
      WHEN p."warmedAt" IS NOT NULL THEN 'completed' ELSE 'queued' END,
 'migrated', CASE WHEN p."warmedAt" IS NOT NULL THEN 100 ELSE 0 END, p."warmedAt", CURRENT_TIMESTAMP
FROM "Profile" p;
DELETE FROM "Task" WHERE "taskType"='warmup';
UPDATE "Profile" SET "status"=CASE
 WHEN (SELECT "status" FROM "WarmupJob" w WHERE w."profileId"="Profile"."id")='completed' THEN 'ready'
 ELSE 'queued' END WHERE "status"!='banned';
