ALTER TABLE "Settings" ADD COLUMN "fingerprintDeviceWeights" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "Settings" ADD COLUMN "fingerprintDistributionRevision" INTEGER NOT NULL DEFAULT 1;
