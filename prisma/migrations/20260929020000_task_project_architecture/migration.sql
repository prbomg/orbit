-- Import legacy target tasks before removing their target domain.
INSERT INTO "Project" ("id", "name", "websiteUrl", "yandexRegionId", "regionName", "createdAt", "updatedAt")
SELECT 'import-' || "id", 'Импорт · ' || substr("id", 1, 16),
  CASE WHEN "targetDomain" <> '' THEN 'https://' || "targetDomain" || '/' WHEN "url" <> '' THEN "url" ELSE 'https://example.invalid/' END,
  CAST(COALESCE("yandexRegionId", 213) AS TEXT), '', "createdAt", "createdAt"
FROM "Task" WHERE "projectId" IS NULL AND "taskType" = 'target';
UPDATE "Task" SET "projectId" = 'import-' || "id" WHERE "projectId" IS NULL AND "taskType" = 'target';

-- CreateTable
CREATE TABLE "ProfileProjectHistory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "profileId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "executedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL DEFAULT 'execution',
    CONSTRAINT "ProfileProjectHistory_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ProfileProjectHistory_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- Reservations are not executions. Only confirmed past usage is imported.
INSERT INTO "ProfileProjectHistory" ("id", "profileId", "projectId", "executedAt", "source")
SELECT 'history-use-' || "id", "profileId", "projectId", "usedAt", 'legacy' FROM "ProjectProfileUse" WHERE "usedAt" IS NOT NULL;
-- Old tasks have counts but no completion timestamp; mark their import explicitly.
INSERT INTO "ProfileProjectHistory" ("id", "profileId", "projectId", "executedAt", "source")
SELECT 'history-task-' || t."id", t."profileId", t."projectId", CURRENT_TIMESTAMP, 'legacy'
FROM "Task" t WHERE t."taskType" = 'target' AND t."projectId" IS NOT NULL AND t."executionsCount" > 0
AND NOT EXISTS (SELECT 1 FROM "ProfileProjectHistory" h WHERE h."profileId" = t."profileId" AND h."projectId" = t."projectId");

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Profile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'new',
    "warmupScore" INTEGER NOT NULL DEFAULT 0,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "warmedAt" DATETIME
);
INSERT INTO "new_Profile" ("createdAt", "id", "name", "status", "warmedAt", "warmupScore", "isEnabled")
SELECT p."createdAt", p."id", p."name",
 CASE WHEN p."status" = 'banned' THEN 'banned'
 WHEN EXISTS (SELECT 1 FROM "Task" t WHERE t."profileId" = p."id" AND t."taskType" = 'warmup' AND t."status" IN ('running','paused')) THEN 'warming_up'
 WHEN p."warmedAt" IS NOT NULL THEN 'ready' ELSE 'new' END,
 p."warmedAt", COALESCE((SELECT SUM(t."executionsCount") FROM "Task" t WHERE t."profileId" = p."id" AND t."taskType" = 'warmup'), 0),
 CASE WHEN p."status" IN ('paused','banned') THEN false ELSE true END FROM "Profile" p;
DROP TABLE "Profile";
ALTER TABLE "new_Profile" RENAME TO "Profile";
CREATE TABLE "new_Task" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT,
    "targetExecutions" INTEGER NOT NULL DEFAULT 1,
    "currentExecutions" INTEGER NOT NULL DEFAULT 0,
    "yandexRegionId" INTEGER,
    "profileId" TEXT NOT NULL,
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
INSERT INTO "new_Task" ("createdAt", "id", "profileId", "projectId", "searchEngine", "searchQueries", "status", "targetKeywords", "taskType", "url", "vitalPhrases", "yandexRegionId", "targetExecutions", "currentExecutions")
SELECT "createdAt", "id", "profileId", "projectId", "searchEngine", "searchQueries", "status", "targetKeywords", "taskType", "url", "vitalPhrases", "yandexRegionId", MAX(COALESCE("executionLimit", 1), "executionsCount", 1), "executionsCount" FROM "Task";
DROP TABLE "Task";
ALTER TABLE "new_Task" RENAME TO "Task";
UPDATE "Task" SET "status" = 'completed' WHERE "status" = 'running' AND "currentExecutions" >= "targetExecutions";
CREATE INDEX "Task_createdAt_idx" ON "Task"("createdAt");
CREATE INDEX "Task_status_idx" ON "Task"("status");
CREATE INDEX "Task_profileId_idx" ON "Task"("profileId");
CREATE INDEX "Task_projectId_idx" ON "Task"("projectId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "ProfileProjectHistory_profileId_projectId_idx" ON "ProfileProjectHistory"("profileId", "projectId");

-- CreateIndex
CREATE INDEX "ProfileProjectHistory_projectId_executedAt_idx" ON "ProfileProjectHistory"("projectId", "executedAt");
