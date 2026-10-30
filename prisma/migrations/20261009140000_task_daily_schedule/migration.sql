ALTER TABLE "Task" ADD COLUMN "dailyExecutionLimit" INTEGER;
CREATE TABLE "TaskDailyPlan" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "taskId" TEXT NOT NULL,
  "dayKey" TEXT NOT NULL,
  "settingsKey" TEXT NOT NULL,
  "baseCount" INTEGER NOT NULL DEFAULT 0,
  "slots" JSONB NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TaskDailyPlan_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "TaskDailyPlan_taskId_dayKey_key" ON "TaskDailyPlan"("taskId", "dayKey");
CREATE INDEX "TaskExecution_taskId_startedAt_status_idx" ON "TaskExecution"("taskId", "startedAt", "status");
