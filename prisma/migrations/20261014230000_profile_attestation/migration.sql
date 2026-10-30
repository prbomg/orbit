ALTER TABLE "Profile" ADD COLUMN "readinessVersion" INTEGER NOT NULL DEFAULT 0;
-- Preserve identities and saved sessions; renew the evidence before allocation.
UPDATE "Profile" SET "status" = 'needs_check', "readinessVerifiedAt" = NULL,
  "readinessValidUntil" = NULL WHERE "status" = 'ready' AND "deletedAt" IS NULL;
