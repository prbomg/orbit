CREATE TABLE "AuthUser" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "email" TEXT NOT NULL,
  "passwordHash" TEXT NOT NULL
);
CREATE UNIQUE INDEX "AuthUser_email_key" ON "AuthUser"("email");
CREATE TABLE "AuthSession" (
  "tokenHash" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "expiresAt" DATETIME NOT NULL,
  CONSTRAINT "AuthSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AuthUser"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "AuthSession_expiresAt_idx" ON "AuthSession"("expiresAt");
CREATE TABLE "AuthThrottle" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "attempts" INTEGER NOT NULL,
  "resetAt" BIGINT NOT NULL
);
