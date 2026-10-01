import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isAbsolute, resolve } from 'node:path';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));
export function loadConfig() {
  const envFile = resolve(projectRoot, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl?.startsWith('file:')) throw new Error('Set DATABASE_URL to a local SQLite file');
  const filename = decodeURIComponent(databaseUrl.slice(5).split('?')[0]);
  if (!filename) throw new Error('DATABASE_URL must include a filename');
  const databasePath = isAbsolute(filename) ? filename : resolve(projectRoot, 'prisma', filename);
  // Refuse a typo rather than silently creating an empty database.
  if (!existsSync(databasePath)) throw new Error('SQLite file not found; run pnpm db:setup first');
  const number = (name, fallback) => {
    const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
    if (!Number.isSafeInteger(value) || value < 1 || value > 3_600_000) throw new Error(`Invalid ${name}`);
    return value;
  };
  const minDwellMs = number('WORKER_MIN_DWELL_MS', 60_000);
  const maxDwellMs = number('WORKER_MAX_DWELL_MS', 120_000);
  if (maxDwellMs < minDwellMs) throw new Error('WORKER_MAX_DWELL_MS must be >= WORKER_MIN_DWELL_MS');
  const proxyCheckUrl = process.env.WORKER_PROXY_CHECK_URL ?? 'https://example.com/';
  const parsed = new URL(proxyCheckUrl);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('Invalid WORKER_PROXY_CHECK_URL');
  const proxyScheme = process.env.WORKER_PROXY_SCHEME ?? 'http';
  if (!['http', 'https'].includes(proxyScheme)) throw new Error('WORKER_PROXY_SCHEME must be http or https');
  const openaiBaseUrl = (process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, '');
  const apiUrl = new URL(openaiBaseUrl);
  // HTTP is permitted only for local mock servers, never a remote API key endpoint.
  if (apiUrl.username || apiUrl.password || apiUrl.search || apiUrl.hash ||
      !(apiUrl.protocol === 'https:' || (apiUrl.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(apiUrl.hostname)))) {
    throw new Error('Invalid OPENAI_BASE_URL');
  }
  const captchaBaseUrl = (process.env.WORKER_CAPTCHA_BASE_URL ?? 'https://rucaptcha.com').replace(/\/$/, '');
  const captchaUrl = new URL(captchaBaseUrl);
  const localCaptchaApi = captchaUrl.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(captchaUrl.hostname);
  if (captchaUrl.username || captchaUrl.password || captchaUrl.search || captchaUrl.hash ||
      !(localCaptchaApi || ['https://rucaptcha.com', 'https://2captcha.com'].includes(captchaUrl.origin))) throw new Error('Invalid WORKER_CAPTCHA_BASE_URL');
  const captchaV2BaseUrl = (process.env.WORKER_CAPTCHA_V2_BASE_URL ?? (localCaptchaApi ? captchaBaseUrl : captchaUrl.origin === 'https://2captcha.com' ? 'https://api.2captcha.com' : 'https://api.rucaptcha.com')).replace(/\/$/, '');
  const captchaV2Url = new URL(captchaV2BaseUrl);
  const localCaptchaV2Api = captchaV2Url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(captchaV2Url.hostname);
  if (captchaV2Url.username || captchaV2Url.password || captchaV2Url.search || captchaV2Url.hash || captchaV2Url.pathname !== '/' ||
      !(localCaptchaV2Api || ['https://api.rucaptcha.com', 'https://api.2captcha.com'].includes(captchaV2Url.origin))) throw new Error('Invalid WORKER_CAPTCHA_V2_BASE_URL');
  const captchaPollingMs = number('WORKER_CAPTCHA_POLL_MS', 5000);
  if (!localCaptchaApi && captchaPollingMs < 5000) throw new Error('Invalid WORKER_CAPTCHA_POLL_MS');
  const captchaMaxSolves = number('WORKER_CAPTCHA_MAX_SOLVES', 3);
  if (captchaMaxSolves > 10) throw new Error('Invalid WORKER_CAPTCHA_MAX_SOLVES');
  const captchaWidgetWaitMs = number('WORKER_CAPTCHA_WIDGET_WAIT_MS', 15_000);
  if (captchaWidgetWaitMs > 30_000) throw new Error('Invalid WORKER_CAPTCHA_WIDGET_WAIT_MS');
  const headless = process.env.WORKER_HEADLESS !== '0';
  const captchaManualWaitMs = process.env.WORKER_CAPTCHA_MANUAL_WAIT_MS === undefined ? 0 : Number(process.env.WORKER_CAPTCHA_MANUAL_WAIT_MS);
  if (!Number.isSafeInteger(captchaManualWaitMs) || captchaManualWaitMs < 0 || captchaManualWaitMs > 600_000) throw new Error('Invalid WORKER_CAPTCHA_MANUAL_WAIT_MS');
  const planMode = process.env.WORKER_PLAN_MODE ?? 'local';
  if (!['local', 'openai'].includes(planMode)) throw new Error('Invalid WORKER_PLAN_MODE');
  return {
    databasePath, databaseUrl: `file:${databasePath}`,
    profilesDirectory: resolve(projectRoot, process.env.WORKER_PROFILES_DIR ?? 'profiles'),
    minDwellMs, maxDwellMs, proxyCheckUrl, proxyScheme,
    pollMs: number('WORKER_POLL_MS', 10_000),
    cooldownMs: number('WORKER_COOLDOWN_MS', 60_000),
    navigationTimeoutMs: number('WORKER_NAVIGATION_TIMEOUT_MS', 30_000),
    headless,
    planMode, openaiApiKey: process.env.OPENAI_API_KEY?.trim(), openaiBaseUrl,
    openaiTimeoutMs: number('WORKER_OPENAI_TIMEOUT_MS', 30_000),
    rotationTimeoutMs: number('WORKER_ROTATION_TIMEOUT_MS', 30_000),
    captchaBaseUrl, captchaV2BaseUrl, captchaPollingMs, captchaMaxSolves, captchaWidgetWaitMs, captchaManualWaitMs,
    captchaTimeoutMs: number('WORKER_CAPTCHA_TIMEOUT_MS', 180_000),
  };
}
