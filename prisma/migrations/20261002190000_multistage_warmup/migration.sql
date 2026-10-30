ALTER TABLE "WarmupJob" ADD COLUMN "currentStage" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "WarmupJob" ADD COLUMN "totalStages" INTEGER NOT NULL DEFAULT 4;
ALTER TABLE "WarmupJob" ADD COLUMN "nextStageAt" DATETIME;
UPDATE "WarmupJob" SET "currentStage"=4, "totalStages"=4 WHERE "status"='completed';

ALTER TABLE "Settings" ADD COLUMN "warmupStageIntervalMinutes" INTEGER NOT NULL DEFAULT 60;
