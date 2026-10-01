import { FingerprintGenerator } from 'fingerprint-generator';
import { FingerprintInjector } from 'fingerprint-injector';
import { randomBytes, randomUUID } from 'node:crypto';
import { open, mkdir, rename, rm, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { installCanvasProfile } from './canvas-profile.mjs';

const generator = new FingerprintGenerator({ devices: ['mobile'], operatingSystems: ['android', 'ios'], browsers: ['chrome'], strict: true });
const positive = z.number().finite().positive();
const cookieSchema = z.object({
  name: z.string(), value: z.string(), domain: z.string(), path: z.string(),
  expires: z.number().finite(), httpOnly: z.boolean(), secure: z.boolean(),
  sameSite: z.enum(['Strict', 'Lax', 'None']), partitionKey: z.string().optional(),
}).strict();
const profileSchema = z.object({
  version: z.literal(2), profileId: z.string(), mobileOS: z.enum(['android', 'ios']),
  canvasSeed: z.number().int().min(0).max(0xffffffff), createdAt: z.string().datetime(), savedAt: z.string().datetime().nullable(),
  fingerprint: z.object({
    navigator: z.object({ userAgent: z.string().min(1), language: z.string().min(1), languages: z.array(z.string()).min(1), maxTouchPoints: positive }).passthrough(),
    screen: z.object({ width: positive.max(2000), height: positive.max(4000), devicePixelRatio: positive.max(10), innerWidth: positive, innerHeight: positive }).passthrough(),
    videoCard: z.object({ vendor: z.string(), renderer: z.string() }).passthrough(),
  }).passthrough(),
  headers: z.record(z.string()), cookies: z.array(cookieSchema).max(10_000),
  origins: z.array(z.object({
    origin: z.string().url(),
    localStorage: z.array(z.object({ name: z.string(), value: z.string() }).strict()),
  }).strict()),
}).strict();

export class ProfileError extends Error {
  constructor(code) { super('Mobile profile could not be loaded or saved'); this.name = 'ProfileError'; this.code = code; }
}
function profilePath(directory, id) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new ProfileError('invalid_profile_id');
  return join(directory, `${id}.json`);
}
function validateProfile(value, profileId) {
  const profile = profileSchema.parse(value);
  const ua = profile.fingerprint.navigator.userAgent;
  const os = /Android.*Mobile/i.test(ua) ? 'android' : /(?:iPhone|iPad|iPod).*Mobile/i.test(ua) ? 'ios' : null;
  if (profile.profileId !== profileId || os !== profile.mobileOS || !/Chrome\/|CriOS\//.test(ua) ||
      profile.headers['user-agent'] !== ua) throw new ProfileError('invalid_mobile_profile');
  return profile;
}

export function generateMobileProfile(profileId, mobileOS) {
  const { fingerprint, headers } = generator.getFingerprint(mobileOS ? { operatingSystems: [mobileOS] } : {});
  // Some samples contain zero viewport dimensions. Use one coherent mobile viewport.
  const screen = fingerprint.screen;
  Object.assign(screen, { innerWidth: screen.width, innerHeight: screen.height,
    clientWidth: screen.width, clientHeight: screen.height, outerWidth: screen.width, outerHeight: screen.height });
  const os = /Android/i.test(fingerprint.navigator.userAgent) ? 'android' : 'ios';
  if (os === 'ios') fingerprint.navigator.userAgentData = null;
  return validateProfile({ version: 2, profileId, mobileOS: os, fingerprint, headers,
    canvasSeed: randomBytes(4).readUInt32BE(), cookies: [], origins: [], createdAt: new Date().toISOString(), savedAt: null }, profileId);
}

async function readProfileFile(filename) {
  let file;
  try {
    file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 10_000_000) throw new ProfileError('invalid_profile_file');
    return JSON.parse(await file.readFile('utf8'));
  } finally { await file?.close(); }
}

export async function loadMobileProfile(directory, profileId, legacyTaskId) {
  const filename = profilePath(directory, profileId);
  try {
    try {
      return { profile: validateProfile(await readProfileFile(filename), profileId), reused: true, storageStatePath: filename };
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    // Older workers saved fingerprints/cookies under taskId. Upgrade on success only.
    if (legacyTaskId && legacyTaskId !== profileId) {
      try {
        const old = await readProfileFile(profilePath(directory, legacyTaskId));
        if (old.version !== 1 || old.taskId !== legacyTaskId) throw new ProfileError('invalid_legacy_profile');
        const { taskId: _taskId, ...fields } = old;
        return { profile: validateProfile({ ...fields, version: 2, profileId, origins: [] }, profileId), reused: true };
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return { profile: generateMobileProfile(profileId), reused: false };
  } catch (error) {
    if (error instanceof ProfileError) throw error;
    throw new ProfileError('invalid_or_unreadable_profile');
  }
}

export async function createMobileContext(browser, profile, storageStatePath) {
  const { fingerprint } = profile;
  const { screen, navigator } = fingerprint;
  const context = await browser.newContext({
    userAgent: navigator.userAgent, viewport: { width: screen.width, height: screen.height },
    screen: { width: screen.width, height: screen.height }, deviceScaleFactor: screen.devicePixelRatio,
    isMobile: true, hasTouch: true, locale: navigator.language, serviceWorkers: 'block',
    storageState: storageStatePath ?? { cookies: profile.cookies, origins: profile.origins },
  });
  try {
    await new FingerprintInjector().attachFingerprintToPlaywright(context, { fingerprint, headers: profile.headers });
    await context.addInitScript(installCanvasProfile, { seed: profile.canvasSeed, ios: profile.mobileOS === 'ios' });
    await context.route('**/*', async route => {
      const headers = { ...route.request().headers() };
      const requested = new Set(Object.keys(headers));
      for (const name of Object.keys(headers)) if (name.startsWith('sec-ch-ua')) delete headers[name];
      const hints = fingerprint.navigator.userAgentData;
      if (profile.mobileOS === 'android' && hints) {
        for (const name of ['sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform']) {
          if (profile.headers[name]) headers[name] = profile.headers[name];
        }
        const high = {
          'sec-ch-ua-full-version': JSON.stringify(hints.uaFullVersion),
          'sec-ch-ua-full-version-list': hints.fullVersionList.map(brand => `${JSON.stringify(brand.brand)};v=${JSON.stringify(brand.version)}`).join(', '),
          'sec-ch-ua-arch': JSON.stringify(hints.architecture), 'sec-ch-ua-bitness': JSON.stringify(hints.bitness),
          'sec-ch-ua-model': JSON.stringify(hints.model), 'sec-ch-ua-platform-version': JSON.stringify(hints.platformVersion),
        };
        for (const [name, value] of Object.entries(high)) if (requested.has(name)) headers[name] = value;
      }
      await route.continue({ headers });
    });
    return context;
  } catch (error) { await context.close().catch(() => {}); throw error; }
}

/** Set Chromium's network metadata before the page's first navigation. */
export async function createMobilePage(context, profile) {
  const page = await context.newPage();
  await prepareMobilePage(page, profile);
  return page;
}

export async function prepareMobilePage(page, profile) {
  const session = await page.context().newCDPSession(page);
  const navigator = profile.fingerprint.navigator;
  const hints = navigator.userAgentData;
  try {
    await session.send('Network.setUserAgentOverride', {
      userAgent: navigator.userAgent, acceptLanguage: navigator.languages.join(','), platform: navigator.platform,
      ...(profile.mobileOS === 'android' && hints ? { userAgentMetadata: {
        brands: hints.brands, fullVersionList: hints.fullVersionList, fullVersion: hints.uaFullVersion,
        platform: hints.platform, platformVersion: hints.platformVersion, architecture: hints.architecture,
        model: hints.model, mobile: true, bitness: hints.bitness,
      } } : {}),
    });
  } catch (error) {
    await session.detach().catch(() => {});
    await page.close().catch(() => {});
    throw error;
  }
  // Detaching earlier resets Chromium's network override, including Client Hints.
  page.once('close', () => { void session.detach().catch(() => {}); });
  return page;
}

/** Stage a private file, then publish by atomic rename only on a completed session. */
export async function stageMobileProfile(directory, profile, context) {
  const target = profilePath(directory, profile.profileId);
  const temporary = join(directory, `.${profile.profileId}.${randomUUID()}.tmp`);
  let cookiesCount;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ProfileError('invalid_profiles_directory');
    const file = await open(temporary, 'wx', 0o600);
    try {
      // Capture both cookies and each origin's localStorage while context is open.
      const state = await context.storageState({ path: temporary });
      cookiesCount = state.cookies.length;
      const value = validateProfile({ ...profile, ...state, savedAt: new Date().toISOString() }, profile.profileId);
      const json = JSON.stringify(value, null, 2);
      if (Buffer.byteLength(json) > 10_000_000) throw new ProfileError('profile_too_large');
      await file.truncate(0); await file.writeFile(json); await file.sync();
    }
    finally { await file.close(); }
    return {
      publish: async () => { try { await rename(temporary, target); } catch { throw new ProfileError('profile_write_failed'); } },
      discard: async () => { await rm(temporary, { force: true }); },
      cookiesCount,
    };
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    if (error instanceof ProfileError) throw error;
    throw new ProfileError('profile_write_failed');
  }
}
