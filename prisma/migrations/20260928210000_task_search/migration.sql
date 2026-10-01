-- Empty defaults preserve existing direct-URL tasks and their session IDs.
ALTER TABLE "Task" ADD COLUMN "searchEngine" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Task" ADD COLUMN "searchQuery" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Task" ADD COLUMN "targetDomain" TEXT NOT NULL DEFAULT '';
