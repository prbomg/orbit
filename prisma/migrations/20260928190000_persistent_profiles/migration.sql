-- Preserve existing tasks and assign each one an RFC 4122 version 4 UUID.
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Task" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "profileId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "targetKeywords" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'running',
    "executionsCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_Task" ("id", "profileId", "url", "targetKeywords", "status", "executionsCount", "createdAt")
SELECT "id",
    lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2) || '-' ||
    substr('89ab', (random() & 3) + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
    "url", "targetKeywords", "status", "executionsCount", "createdAt"
FROM "Task";
DROP TABLE "Task";
ALTER TABLE "new_Task" RENAME TO "Task";
CREATE INDEX "Task_createdAt_idx" ON "Task"("createdAt");
CREATE INDEX "Task_status_idx" ON "Task"("status");
CREATE INDEX "Task_profileId_idx" ON "Task"("profileId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
