ALTER TABLE "Settings" ADD COLUMN "capguruApiKey" TEXT;
ALTER TABLE "Settings" ADD COLUMN "captchaPrimary" TEXT NOT NULL DEFAULT 'rucaptcha';
ALTER TABLE "Settings" ADD COLUMN "captchaFallbackAfter" INTEGER NOT NULL DEFAULT 2;
