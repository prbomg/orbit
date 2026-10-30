CREATE TABLE "ProxyTcpChannel" (
 "id" TEXT NOT NULL PRIMARY KEY, "providerProxyId" TEXT NOT NULL, "profileId" INTEGER NOT NULL,
 "profileName" TEXT NOT NULL, "parameters" JSONB NOT NULL, "family" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'pending',
 "generation" INTEGER NOT NULL DEFAULT 1, "appliedAt" DATETIME, "checkedAt" DATETIME,
 "diagnostic" JSONB, "errorCode" TEXT, "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "ProxyTcpChannel_providerProxyId_key" ON "ProxyTcpChannel"("providerProxyId");
ALTER TABLE "Proxy" ADD COLUMN "tcpChannelId" TEXT REFERENCES "ProxyTcpChannel"("id") ON DELETE SET NULL ON UPDATE CASCADE;
