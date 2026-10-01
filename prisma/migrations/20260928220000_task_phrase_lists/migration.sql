-- Preserve existing queries before removing the scalar field.
ALTER TABLE "Task" ADD COLUMN "searchQueries" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "Task" ADD COLUMN "vitalPhrases" JSONB NOT NULL DEFAULT '[]';
UPDATE "Task" SET "searchQueries" = json_array(trim("searchQuery")) WHERE trim("searchQuery") <> '';
ALTER TABLE "Task" DROP COLUMN "searchQuery";
