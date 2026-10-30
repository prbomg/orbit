ALTER TABLE "Settings" ADD COLUMN "warmupPlanPreset" TEXT NOT NULL DEFAULT 'standard';
CREATE INDEX "ProfileWarmupEvent_createdAt_id_idx" ON "ProfileWarmupEvent"("createdAt", "id");
