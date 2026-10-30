-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Task" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT,
    "targetExecutions" INTEGER NOT NULL DEFAULT 1,
    "currentExecutions" INTEGER NOT NULL DEFAULT 0,
    "concurrency" INTEGER NOT NULL DEFAULT 1,
    "dailyExecutionLimit" INTEGER,
    "retryState" JSONB NOT NULL DEFAULT '{}',
    "yandexRegionId" INTEGER,
    "profileId" TEXT,
    "taskType" TEXT NOT NULL DEFAULT 'target',
    "searchEngine" TEXT NOT NULL DEFAULT '',
    "searchDepth" INTEGER NOT NULL DEFAULT 3,
    "searchQueries" JSONB NOT NULL DEFAULT '[]',
    "vitalPhrases" JSONB NOT NULL DEFAULT '[]',
    "visitSettings" JSONB NOT NULL DEFAULT '{}',
    "url" TEXT NOT NULL DEFAULT '',
    "targetKeywords" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'running',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Task_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Task_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Task" ("concurrency", "createdAt", "currentExecutions", "dailyExecutionLimit", "id", "profileId", "projectId", "retryState", "searchDepth", "searchEngine", "searchQueries", "status", "targetExecutions", "targetKeywords", "taskType", "url", "visitSettings", "vitalPhrases", "yandexRegionId") SELECT "concurrency", "createdAt", "currentExecutions", "dailyExecutionLimit", "id", "profileId", "projectId", "retryState", "searchDepth", "searchEngine", "searchQueries", "status", "targetExecutions", "targetKeywords", "taskType", "url", "visitSettings", "vitalPhrases", "yandexRegionId" FROM "Task";
DROP TABLE "Task";
ALTER TABLE "new_Task" RENAME TO "Task";
CREATE INDEX "Task_createdAt_idx" ON "Task"("createdAt");
CREATE INDEX "Task_status_idx" ON "Task"("status");
CREATE INDEX "Task_profileId_idx" ON "Task"("profileId");
CREATE INDEX "Task_projectId_idx" ON "Task"("projectId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

