-- Preserve the existing five-page limit for all previously created tasks.
ALTER TABLE "Task" ADD COLUMN "searchDepth" INTEGER NOT NULL DEFAULT 5;
