-- Preserve project data and dependent rows while changing the region ID to text.
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Project" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "websiteUrl" TEXT NOT NULL,
  "yandexRegionId" TEXT NOT NULL,
  "regionName" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_Project" ("id", "name", "websiteUrl", "yandexRegionId", "regionName", "createdAt", "updatedAt")
SELECT "id", "name", "websiteUrl", CAST("yandexRegionId" AS TEXT), "regionName", "createdAt", "createdAt" FROM "Project";
DROP TABLE "Project";
ALTER TABLE "new_Project" RENAME TO "Project";
PRAGMA foreign_key_check;
PRAGMA foreign_keys=ON;
