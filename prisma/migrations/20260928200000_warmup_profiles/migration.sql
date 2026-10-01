CREATE TABLE "Profile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'active'
);
-- Keep profile IDs unchanged so existing session files remain usable.
INSERT INTO "Profile" ("id", "name", "createdAt", "status")
SELECT "profileId", 'Профиль ' || substr("profileId", 1, 8), min("createdAt"), 'active'
FROM "Task" GROUP BY "profileId";
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Task" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "profileId" TEXT NOT NULL,
    "taskType" TEXT NOT NULL DEFAULT 'target',
    "url" TEXT NOT NULL DEFAULT '',
    "targetKeywords" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'running',
    "executionsCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Task_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Task" ("id", "profileId", "url", "targetKeywords", "status", "executionsCount", "createdAt")
SELECT "id", "profileId", "url", "targetKeywords", "status", "executionsCount", "createdAt" FROM "Task";
DROP TABLE "Task";
ALTER TABLE "new_Task" RENAME TO "Task";
CREATE INDEX "Task_createdAt_idx" ON "Task"("createdAt");
CREATE INDEX "Task_status_idx" ON "Task"("status");
CREATE INDEX "Task_profileId_idx" ON "Task"("profileId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
