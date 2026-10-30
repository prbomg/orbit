ALTER TABLE "Project" ADD COLUMN "geolocation" JSONB NOT NULL DEFAULT '{"mode":"region"}';
ALTER TABLE "ProjectProfileUse" ADD COLUMN "geolocation" JSONB;
