-- Optional display name; existing tasks keep their legacy labels.
ALTER TABLE "Task" ADD COLUMN "name" TEXT;
