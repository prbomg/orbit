-- AlterTable
ALTER TABLE "Profile" ADD COLUMN "warmedAt" DATETIME;

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "websiteUrl" TEXT NOT NULL,
    "yandexRegionId" INTEGER NOT NULL,
    "regionName" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ProjectProfileUse" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "taskId" TEXT,
    "reservedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "usedAt" DATETIME,
    CONSTRAINT "ProjectProfileUse_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ProjectProfileUse_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ProjectProfileUse_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TaskExecution" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "retryAfter" DATETIME,
    "errorCode" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TaskExecution_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TaskExecution_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Settings" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT DEFAULT 1,
    "rucaptchaApiKey" TEXT,
    "openaiApiKey" TEXT,
    "autoReplenishEnabled" BOOLEAN NOT NULL DEFAULT false,
    "minReadyProfiles" INTEGER NOT NULL DEFAULT 100,
    "replenishBatchSize" INTEGER NOT NULL DEFAULT 100,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_Settings" ("id", "openaiApiKey", "rucaptchaApiKey", "updatedAt") SELECT "id", "openaiApiKey", "rucaptchaApiKey", "updatedAt" FROM "Settings";
DROP TABLE "Settings";
ALTER TABLE "new_Settings" RENAME TO "Settings";
CREATE TABLE "new_Task" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT,
    "executionLimit" INTEGER,
    "yandexRegionId" INTEGER,
    "profileId" TEXT NOT NULL,
    "taskType" TEXT NOT NULL DEFAULT 'target',
    "searchEngine" TEXT NOT NULL DEFAULT '',
    "searchQueries" JSONB NOT NULL DEFAULT [],
    "vitalPhrases" JSONB NOT NULL DEFAULT [],
    "targetDomain" TEXT NOT NULL DEFAULT '',
    "url" TEXT NOT NULL DEFAULT '',
    "targetKeywords" JSONB NOT NULL DEFAULT [],
    "status" TEXT NOT NULL DEFAULT 'running',
    "executionsCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Task_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Task_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Task" ("createdAt", "executionsCount", "id", "profileId", "searchEngine", "searchQueries", "status", "targetDomain", "targetKeywords", "taskType", "url", "vitalPhrases") SELECT "createdAt", "executionsCount", "id", "profileId", "searchEngine", "searchQueries", "status", "targetDomain", "targetKeywords", "taskType", "url", "vitalPhrases" FROM "Task";
DROP TABLE "Task";
ALTER TABLE "new_Task" RENAME TO "Task";
CREATE INDEX "Task_createdAt_idx" ON "Task"("createdAt");
CREATE INDEX "Task_status_idx" ON "Task"("status");
CREATE INDEX "Task_profileId_idx" ON "Task"("profileId");
CREATE INDEX "Task_projectId_idx" ON "Task"("projectId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "ProjectProfileUse_taskId_idx" ON "ProjectProfileUse"("taskId");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectProfileUse_projectId_profileId_key" ON "ProjectProfileUse"("projectId", "profileId");

-- CreateIndex
CREATE INDEX "TaskExecution_status_retryAfter_idx" ON "TaskExecution"("status", "retryAfter");

-- CreateIndex
CREATE UNIQUE INDEX "TaskExecution_taskId_profileId_key" ON "TaskExecution"("taskId", "profileId");


-- Existing successful warmups qualify; original UUIDs/counters are preserved.
UPDATE "Profile" SET "warmedAt" = (SELECT MAX("createdAt") FROM "Task" WHERE "profileId" = "Profile"."id" AND "taskType" = 'warmup' AND "executionsCount" > 0)
WHERE EXISTS (SELECT 1 FROM "Task" WHERE "profileId" = "Profile"."id" AND "taskType" = 'warmup' AND "executionsCount" > 0);
