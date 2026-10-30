import { maxProfileBytes } from './profile-limits.mjs';
import { ipCheckURL, DEFAULT_PROXY_IP_URL } from './proxy-ip.mjs';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { networkProbeUrl } from './network-transport.mjs';
import { isAbsolute, resolve } from 'node:path';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));

export function loadConfig() {
  const envFile = resolve(projectRoot, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  if (process.env.FONTCONFIG_FILE && (!isAbsolute(process.env.FONTCONFIG_FILE) || !existsSync(process.env.FONTCONFIG_FILE))) {
    throw Error('Invalid FONTCONFIG_FILE');
  }
  const cookieAgeHours = Number(process.env.ORBIT_COOKIE_MIN_AGE_HOURS || 0);
  if (![0, 72, 96].includes(cookieAgeHours)) throw Error('Invalid ORBIT_COOKIE_MIN_AGE_HOURS');
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
  const openaiBaseUrl = (process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
  const apiUrl = new URL(openaiBaseUrl);
  // HTTP is permitted only for local mock servers, never a remote API key endpoint.
  if (apiUrl.username || apiUrl.password || apiUrl.search || apiUrl.hash ||
      !(apiUrl.protocol === 'https:' || (apiUrl.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(apiUrl.hostname)))) {
    throw new Error('Invalid OPENAI_BASE_URL');
  }

  // --- ВАЛИДАЦИЯ И НАСТРОЙКА API RUCAPTCHA V1 / V2 ---
  // Базовый URL для классического протокола SDK (in.php / res.php) или API v2
  const captchaBaseUrl = (process.env.WORKER_CAPTCHA_BASE_URL ?? 'https://rucaptcha.com').replace(/\/+$/, '');
  const captchaUrl = new URL(captchaBaseUrl);
  const localCaptchaApi = captchaUrl.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(captchaUrl.hostname);
  const allowedCaptchaOrigins = [
    'https://rucaptcha.com',
    'https://2captcha.com',
    'https://api.rucaptcha.com',
    'https://api.2captcha.com',
  ];
  if (captchaUrl.username || captchaUrl.password || captchaUrl.search || captchaUrl.hash ||
      !(localCaptchaApi || allowedCaptchaOrigins.includes(captchaUrl.origin))) {
    throw new Error('Invalid WORKER_CAPTCHA_BASE_URL');
  }

  // Базовый URL для современного API v2 (https://api.rucaptcha.com/createTask и /getTaskResult)
  const defaultV2Url = localCaptchaApi
    ? captchaBaseUrl
    : captchaUrl.origin.includes('2captcha.com')
      ? 'https://api.2captcha.com'
      : 'https://api.rucaptcha.com';
  const captchaV2BaseUrl = (process.env.WORKER_CAPTCHA_V2_BASE_URL ?? defaultV2Url)
    .replace(/\/+$/, '')
    .replace(/\/api\/v2$/, '');
  const captchaV2Url = new URL(captchaV2BaseUrl);
  const localCaptchaV2Api = captchaV2Url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(captchaV2Url.hostname);
  if (captchaV2Url.username || captchaV2Url.password || captchaV2Url.search || captchaV2Url.hash ||
      !(localCaptchaV2Api || allowedCaptchaOrigins.includes(captchaV2Url.origin))) {
    throw new Error('Invalid WORKER_CAPTCHA_V2_BASE_URL');
  }

  const captchaPollingMs = number('WORKER_CAPTCHA_POLL_MS', 5000);
  if (!localCaptchaApi && captchaPollingMs < 5000) throw new Error('Invalid WORKER_CAPTCHA_POLL_MS');
  const captchaMaxSolves = number('WORKER_CAPTCHA_MAX_SOLVES', 15);
  if (captchaMaxSolves > 10) throw new Error('Invalid WORKER_CAPTCHA_MAX_SOLVES');
  const captchaMaxIncorrect = number('WORKER_CAPTCHA_MAX_INCORRECT', 3);
  if (captchaMaxIncorrect > 10) throw new Error('Invalid WORKER_CAPTCHA_MAX_INCORRECT');
  const captchaWidgetWaitMs = number('WORKER_CAPTCHA_WIDGET_WAIT_MS', 15_000);
  if (captchaWidgetWaitMs > 30_000) throw new Error('Invalid WORKER_CAPTCHA_WIDGET_WAIT_MS');
  const proxyIPCheckMode = process.env.WORKER_PROXY_IP_CHECK_MODE ?? 'warn';
  if (!['warn', 'required', 'off'].includes(proxyIPCheckMode)) throw new Error('Invalid WORKER_PROXY_IP_CHECK_MODE');
  const proxyIPCheckUrl = ipCheckURL(process.env.WORKER_PROXY_IP_CHECK_URL ?? DEFAULT_PROXY_IP_URL).href;
  const directIPCheckUrl = process.env.WORKER_DIRECT_IP_CHECK_URL ? ipCheckURL(process.env.WORKER_DIRECT_IP_CHECK_URL).href : proxyIPCheckUrl;
  const proxyIPCheckTimeoutMs = number('WORKER_PROXY_IP_CHECK_TIMEOUT_MS', 5000);
  const headless = process.env.WORKER_HEADLESS !== '0';
  const captchaManualWaitMs = process.env.WORKER_CAPTCHA_MANUAL_WAIT_MS === undefined ? 0 : Number(process.env.WORKER_CAPTCHA_MANUAL_WAIT_MS);
  if (!Number.isSafeInteger(captchaManualWaitMs) || captchaManualWaitMs < 0 || captchaManualWaitMs > 600_000) throw new Error('Invalid WORKER_CAPTCHA_MANUAL_WAIT_MS');
  const planMode = process.env.WORKER_PLAN_MODE ?? 'local';
  if (!['local', 'openai'].includes(planMode)) throw new Error('Invalid WORKER_PLAN_MODE');
  const motionMode = process.env.WORKER_MOTION_MODE ?? 'quiet-held';
  if (!['quiet-held', 'off'].includes(motionMode)) throw new Error('Invalid WORKER_MOTION_MODE');
  const networkProbeUrlValue = networkProbeUrl(process.env.ORBIT_NETWORK_PROBE_URL)?.href;
  const networkHttp3Url = networkProbeUrl(process.env.ORBIT_NETWORK_HTTP3_URL)?.href;
  const preSearchWarmup = process.env.WORKER_PRE_SEARCH_WARMUP ?? 'true';
  if (!['true', 'false'].includes(preSearchWarmup)) throw new Error('Invalid WORKER_PRE_SEARCH_WARMUP');
  const rateLimitCooldownMs = number('WORKER_RATE_LIMIT_COOLDOWN_MS', 30_000);
  const maxRateLimitCooldownMs = number('WORKER_MAX_RATE_LIMIT_COOLDOWN_MS', 180_000);
  if (maxRateLimitCooldownMs < rateLimitCooldownMs) throw new Error('WORKER_MAX_RATE_LIMIT_COOLDOWN_MS must be >= WORKER_RATE_LIMIT_COOLDOWN_MS');

  return {
    preSearchWarmup: preSearchWarmup === 'true',
    preSearchTimeoutMs: number('WORKER_PRE_SEARCH_TIMEOUT_MS', 20_000),
    rateLimitCooldownMs, maxRateLimitCooldownMs,
    databasePath, databaseUrl: `file:${databasePath}`,
    networkProbeUrl: networkProbeUrlValue, networkHttp3Url,
    networkReferenceFile: process.env.ORBIT_NETWORK_REFERENCE_FILE || undefined,
    networkProbeTimeoutMs: Math.min(30000, number('ORBIT_NETWORK_PROBE_TIMEOUT_MS', 12000)),
    maxProfileBytes: maxProfileBytes(),
    warmupIntent: process.env.WORKER_WARMUP_INTENT || '',
    profilesDirectory: resolve(projectRoot, process.env.WORKER_PROFILES_DIR ?? 'profiles'),
    minDwellMs, maxDwellMs, proxyCheckUrl, proxyScheme, proxyIPCheckMode, proxyIPCheckUrl, directIPCheckUrl, proxyIPCheckTimeoutMs,
    pollMs: number('WORKER_POLL_MS', 10_000),
    cooldownMs: number('WORKER_COOLDOWN_MS', 60_000),
    navigationTimeoutMs: number('WORKER_NAVIGATION_TIMEOUT_MS', 30_000),
    warmupOperationTimeoutMs: number('WORKER_WARMUP_OPERATION_TIMEOUT_MS', 60_000),
    warmupSiteTimeoutMs: number('WORKER_WARMUP_SITE_TIMEOUT_MS', 300_000),
    warmupRunTimeoutMs: number('WORKER_WARMUP_RUN_TIMEOUT_MS', 1_200_000),
    warmupCleanupTimeoutMs: number('WORKER_WARMUP_CLEANUP_TIMEOUT_MS', 5_000),
    headless, motionMode, chromiumExecutablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    planMode, openaiApiKey: process.env.OPENAI_API_KEY?.trim(), openaiBaseUrl,
    openaiTimeoutMs: number('WORKER_OPENAI_TIMEOUT_MS', 30_000),
    rotationTimeoutMs: number('WORKER_ROTATION_TIMEOUT_MS', 30_000),
    capguruBaseUrl: (process.env.WORKER_CAPGURU_BASE_URL || 'https://api.cap.guru').replace(/\/+$/, ''),
    captchaBaseUrl, captchaV2BaseUrl, captchaPollingMs, captchaMaxSolves, captchaMaxIncorrect, captchaWidgetWaitMs, captchaManualWaitMs,
    captchaTimeoutMs: number('WORKER_CAPTCHA_TIMEOUT_MS', 180_000),
  };
}
