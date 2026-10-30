ALTER TABLE "Profile" ADD COLUMN "deletedAt" DATETIME;
CREATE INDEX "Profile_deletedAt_idx" ON "Profile"("deletedAt");
