-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Profile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'new',
    "warmupScore" INTEGER NOT NULL DEFAULT 0,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "warmedAt" DATETIME,
    "fingerprint" JSONB,
    "fingerprintHash" TEXT,
    "fingerprintState" TEXT NOT NULL DEFAULT 'pending',
    "fingerprintCheck" JSONB
);
INSERT INTO "new_Profile" ("createdAt", "id", "isEnabled", "name", "status", "warmedAt", "warmupScore") SELECT "createdAt", "id", "isEnabled", "name", "status", "warmedAt", "warmupScore" FROM "Profile";
DROP TABLE "Profile";
ALTER TABLE "new_Profile" RENAME TO "Profile";
CREATE UNIQUE INDEX "Profile_fingerprintHash_key" ON "Profile"("fingerprintHash");
CREATE TABLE "new_Settings" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT DEFAULT 1,
    "rucaptchaApiKey" TEXT,
    "openaiApiKey" TEXT,
    "autoReplenishEnabled" BOOLEAN NOT NULL DEFAULT false,
    "minReadyProfiles" INTEGER NOT NULL DEFAULT 100,
    "replenishBatchSize" INTEGER NOT NULL DEFAULT 100,
    "warmupEnabled" BOOLEAN NOT NULL DEFAULT true,
    "warmupConcurrency" INTEGER NOT NULL DEFAULT 1,
    "maxPendingProfiles" INTEGER NOT NULL DEFAULT 500,
    "mobileProxyApiKey" TEXT,
    "fingerprintMode" TEXT NOT NULL DEFAULT 'auto',
    "fingerprintLocale" TEXT NOT NULL DEFAULT 'ru-RU',
    "fingerprintTimezone" TEXT NOT NULL DEFAULT 'Europe/Moscow',
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_Settings" ("autoReplenishEnabled", "id", "maxPendingProfiles", "minReadyProfiles", "openaiApiKey", "replenishBatchSize", "rucaptchaApiKey", "updatedAt", "warmupConcurrency", "warmupEnabled") SELECT "autoReplenishEnabled", "id", "maxPendingProfiles", "minReadyProfiles", "openaiApiKey", "replenishBatchSize", "rucaptchaApiKey", "updatedAt", "warmupConcurrency", "warmupEnabled" FROM "Settings";
DROP TABLE "Settings";
ALTER TABLE "new_Settings" RENAME TO "Settings";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

