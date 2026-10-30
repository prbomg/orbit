ALTER TABLE "Settings" ADD COLUMN "warmupSharedProxy" BOOLEAN NOT NULL DEFAULT true;
CREATE TABLE "ProfileWarmupEvent" (
 "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
 "profileId" TEXT NOT NULL,
 "jobId" TEXT,
 "runId" TEXT,
 "stage" INTEGER,
 "attempt" INTEGER,
 "proxyId" TEXT,
 "proxyLabel" TEXT,
 "event" TEXT NOT NULL,
 "details" JSONB NOT NULL DEFAULT '{}',
 "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "ProfileWarmupEvent_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "ProfileWarmupEvent_profileId_id_idx" ON "ProfileWarmupEvent"("profileId", "id");
INSERT INTO "ProfileWarmupEvent" ("profileId", "jobId", "stage", "event")
 SELECT p."id", w."id", w."currentStage", 'history_started'
 FROM "Profile" p LEFT JOIN "WarmupJob" w ON w."profileId"=p."id" WHERE p."deletedAt" IS NULL;
