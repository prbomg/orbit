-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "url" TEXT NOT NULL,
    "targetKeywords" JSONB NOT NULL DEFAULT [],
    "status" TEXT NOT NULL DEFAULT 'running',
    "executionsCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Proxy" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "username" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true
);

-- CreateIndex
CREATE INDEX "Task_createdAt_idx" ON "Task"("createdAt");

-- CreateIndex
CREATE INDEX "Task_status_idx" ON "Task"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Proxy_host_port_username_key" ON "Proxy"("host", "port", "username");
