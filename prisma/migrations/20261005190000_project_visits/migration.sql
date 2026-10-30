CREATE TABLE "ProjectVisit" ("id" TEXT NOT NULL PRIMARY KEY, "projectId" TEXT NOT NULL, "taskId" TEXT, "executionId" TEXT, "kind" TEXT NOT NULL, "query" TEXT, "actualQuery" TEXT, "engine" TEXT NOT NULL, "visitedAt" DATETIME NOT NULL, "source" TEXT NOT NULL DEFAULT 'observed', FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE);
CREATE UNIQUE INDEX "ProjectVisit_executionId_key" ON "ProjectVisit"("executionId");
CREATE INDEX "ProjectVisit_projectId_visitedAt_idx" ON "ProjectVisit"("projectId", "visitedAt");
INSERT INTO "ProjectVisit" ("id","projectId","taskId","executionId","kind","query","engine","visitedAt","source")
SELECT 'import:'||e."id",t."projectId",t."id",e."id",'unknown',NULL,t."searchEngine",(CASE WHEN typeof(e."completedAt") IN ('integer','real') THEN e."completedAt" ELSE CAST(strftime('%s',e."completedAt") AS INTEGER)*1000 + CAST(substr(strftime('%f',e."completedAt"),4,3) AS INTEGER) END),'completed_execution' 
FROM "TaskExecution" e JOIN "Task" t ON t."id"=e."taskId" WHERE e."status"='completed' AND e."completedAt" IS NOT NULL AND t."projectId" IS NOT NULL AND t."taskType"='target';
-- Older successful runs have an execution history event but no TaskExecution.
-- Imported legacy timestamps are not exact visit dates and are not attributed.
INSERT INTO "ProjectVisit" ("id","projectId","kind","query","engine","visitedAt","source")
SELECT 'history:'||h."id",h."projectId",'unknown',NULL,'',(CASE WHEN typeof(h."executedAt") IN ('integer','real') THEN h."executedAt" ELSE CAST(strftime('%s',h."executedAt") AS INTEGER)*1000 + CAST(substr(strftime('%f',h."executedAt"),4,3) AS INTEGER) END),'completed_history'
FROM "ProfileProjectHistory" h WHERE h."source"='execution' AND NOT EXISTS (
 SELECT 1 FROM "TaskExecution" e JOIN "Task" t ON t."id"=e."taskId"
 WHERE e."status"='completed' AND e."completedAt" IS NOT NULL AND t."projectId"=h."projectId" AND e."profileId"=h."profileId"
 AND ABS((CASE WHEN typeof(e."completedAt") IN ('integer','real') THEN e."completedAt" ELSE CAST(strftime('%s',e."completedAt") AS INTEGER)*1000 END) -
 (CASE WHEN typeof(h."executedAt") IN ('integer','real') THEN h."executedAt" ELSE CAST(strftime('%s',h."executedAt") AS INTEGER)*1000 END)) <= 5000
);
