import { maxProfileBytes as profileByteLimit } from './profile-limits.mjs';
import {observeCookies} from './cookie-observation.mjs';
import geo from '../utils/projectGeolocation.js';
import { applyProjectGeolocation } from './project-geolocation.mjs';
import cookieAge from '../utils/cookieAge.js';
import snapshots from '../utils/profileSnapshots.js';
import { FingerprintInjector } from 'fingerprint-injector';
import { randomUUID } from 'node:crypto';
import { open, mkdir, rename, rm, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { installCanvasProfile, canvasProfileOptions } from './canvas-profile.mjs';
import sessionState from '../utils/sessionState.js';
import fp from '../utils/fingerprint.js';
import batteryState from '../utils/batteryState.js';
import { buildCdpUserAgentOverride, initialProfileHeaders } from './client-hints.mjs';
import { batteryRuntimeScript } from './battery-runtime.mjs';
import { webglLimitsScript } from './webgl-limits.mjs';
import { workerPassportScript } from './worker-passport.mjs';
import { enablePersistentCache } from './persistent-cache.mjs';
import { getPageSession } from './page-session.mjs';
const { cookieActive, compareRestoredSession, storageStateSchema, sessionSummary } = sessionState;
const runtimeStates = new WeakMap();

const positive = z.number().finite().positive();
const profileSchema = z.object({
  snapshot: z.object({ version: z.literal(1), identityHashVersion: z.literal(4).optional(), id: z.string().uuid(), passportHash: z.string(), contentHash: z.string(), storageMode: z.enum(['snapshot','persistent']), warmupStage: z.number().int().min(1).max(6).optional() }).strict().optional(),
  passport: z.object({ timezone: z.string().nullable(), seed: z.string(), projectLocations: z.record(z.unknown()).optional() }).optional(),
  cookieObservations: z.array(z.object({key:z.string(),name:z.enum(['_ym_d','yandexuid']),domain:z.string(),valueHash:z.string().regex(/^[a-f0-9]{64}$/),firstSeenAt:z.string().datetime(),expires:z.number().finite()}).strict()).max(10000).optional(),
  runtime: z.object({ battery: batteryState.batteryModelSchema }).strict().optional(),
  version: z.literal(2), profileId: z.string(), mobileOS: z.enum(['android', 'ios']),
  canvasSeed: z.number().int().min(0).max(0xffffffff), createdAt: z.string().datetime(), savedAt: z.string().datetime().nullable(),
  fingerprint: z.object({
    canvas: z.object({version:z.literal(1),mode:z.literal('native')}).strict().optional(),
    navigator: z.object({ userAgent: z.string().min(1), language: z.string().min(1), languages: z.array(z.string()).min(1), maxTouchPoints: positive }).passthrough(),
    screen: z.object({ width: positive.max(2000), height: positive.max(4000), devicePixelRatio: positive.max(10), innerWidth: positive, innerHeight: positive }).passthrough(),
    videoCard: z.object({ vendor: z.string(), renderer: z.string() }).passthrough(),
  }).passthrough(),
  headers: z.record(z.string()), ...storageStateSchema.shape,
}).strict();

export class ProfileError extends Error {
  constructor(code) { super('Mobile profile could not be loaded or saved'); this.name = 'ProfileError'; this.code = code; }
}
function profilePath(directory, id) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new ProfileError('invalid_profile_id');
  return join(directory, `${id}.json`);
}
const mobileProfileOS = ua => /Android.*Mobile/i.test(ua) ? 'android' : /(?:iPhone|iPad|iPod).*Mobile/i.test(ua) ? 'ios' : null;
function validateProfile(value, profileId) {
  if (!snapshots.checkSnapshot(value)) throw new ProfileError('profile_snapshot_mismatch');
  const profile = profileSchema.parse(value);
  const ua = profile.fingerprint.navigator.userAgent;
  const os = mobileProfileOS(ua);
  if (profile.profileId !== profileId || os !== profile.mobileOS || !/Chrome\/|CriOS\//.test(ua) ||
      profile.headers['user-agent'] !== ua) throw new ProfileError('invalid_mobile_profile');
  return profile;
}

async function readProfileFile(filename, limit) {
  let file;
  try {
    file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (!stat.isFile()) throw new ProfileError('invalid_profile_file');
    if (stat.size > limit) throw new ProfileError('profile_too_large');
    const contents=await file.readFile();
    if(contents.byteLength>limit)throw new ProfileError('profile_too_large');
    return JSON.parse(contents.toString('utf8'));
  } finally { await file?.close(); }
}

export async function loadMobileProfile(directory, profileId, legacyTaskId, initialProfile, { maxProfileBytes } = {}) {
  const limit = profileByteLimit(maxProfileBytes);
  const filename = profilePath(directory, profileId);
  try {
    try {
      const savedSnapshot = await readProfileFile(filename, limit);
      return { profile: validateProfile(savedSnapshot, profileId), savedSnapshot, reused: true, storageStatePath: filename };
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (legacyTaskId && legacyTaskId !== profileId) {
      try {
        const old = await readProfileFile(profilePath(directory, legacyTaskId), limit);
        if (old.version !== 1 || old.taskId !== legacyTaskId) throw new ProfileError('invalid_legacy_profile');
        const { taskId: _taskId, ...fields } = old;
        return { profile: validateProfile({ ...fields, version: 2, profileId, origins: [] }, profileId), reused: true };
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return { profile: initialProfile ? validateProfile(initialProfile, profileId) : null, reused: false };
  } catch (error) {
    if (error instanceof ProfileError) throw error;
    throw new ProfileError('invalid_or_unreadable_profile');
  }
}

export function mobileContextOptions(profile, projectLocation) {
  const { screen, navigator, preferences } = fp.deviceFingerprint(profile.fingerprint);
  return { userAgent: navigator.userAgent, viewport: { width: screen.width, height: screen.height }, screen: { width: screen.width, height: screen.height }, deviceScaleFactor: screen.devicePixelRatio, isMobile: true, hasTouch: true, colorScheme: preferences?.colorScheme ?? 'dark', reducedMotion: preferences?.reducedMotion ?? 'no-preference', contrast: preferences?.contrast ?? 'no-preference', locale: navigator.language, ...(profile.passport?.timezone ? { timezoneId: profile.passport.timezone } : {}), serviceWorkers: 'allow', ...(projectLocation ? { geolocation: geo.browserGeolocation(projectLocation) } : {}) };
}

export async function createMobileContext(browser, profile, storageStatePath, persistentContext, hydrateSnapshot = true, projectLocation, project) {
  const fingerprint = fp.deviceFingerprint(profile.fingerprint);
  const runtime = { battery: batteryState.createBatteryModel(profile) };
  const state = { cookies: profile.cookies.filter(cookie => cookieActive(cookie, Date.now())), origins: profile.origins };
  const context = persistentContext || await browser.newContext({ ...mobileContextOptions(profile, projectLocation), storageState: state });
  if (persistentContext) {
    if (hydrateSnapshot) await context.setStorageState(state);
    else await context.addCookies(state.cookies.filter(cookie => cookie.expires === -1));
  }
  try {
    await applyProjectGeolocation(context, projectLocation, project);
    if (persistentContext) await enablePersistentCache(context);
    await context.addInitScript({ content: workerPassportScript(profile) });
    const injector = new FingerprintInjector();
    await context.setExtraHTTPHeaders(injector.onlyInjectableHeaders(initialProfileHeaders(profile.headers), browser.browserType().name()));
    await context.addInitScript({ content: injector.getInjectableScript({ fingerprint, headers: profile.headers }) + batteryRuntimeScript(runtime.battery) + webglLimitsScript(fingerprint.webglLimits, fingerprint.videoCard) });
    runtimeStates.set(context, runtime);
    await context.addInitScript(installCanvasProfile, canvasProfileOptions(profile));
    return context;
  } catch (error) { await context.close().catch(() => {}); throw error; }
}

export async function verifyRestoredSession(context, profile, { discoverOrigins = false } = {}) {
  let restored, readStage = 'export', readDomain;
  try {
    const orbitOrigins = discoverOrigins ? profile.origins.map(entry => entry.origin) : undefined;
    readStage = 'export';
    restored = await context.storageState({ indexedDB: true, ...(orbitOrigins ? { orbitOrigins } : {}) });
  }
  catch (cause) {
    const error = new ProfileError('profile_session_verification_failed');
    error.diagnostics = { version: 1, status: 'failed', checkedAt: new Date().toISOString(), sourceSavedAt: profile.savedAt, errorCode: error.code, readStage, ...(readDomain?{readDomain}:{}), readFailure: cause?.name === 'TimeoutError' ? 'timeout' : /closed/i.test(cause?.message||'') ? 'closed' : /navigation|context.*destroyed/i.test(cause?.message||'') ? 'navigation' : 'storage_read' };
    throw error;
  }
  const report = { ...compareRestoredSession(profile, restored), sourceSnapshotId: profile.snapshot?.id || null, passportHash: profile.snapshot?.passportHash || (profile.fingerprint ? snapshots.passportHash(profile) : null) };
  if (report.errorCode) {
    const error = new ProfileError(report.errorCode); error.diagnostics = report; throw error;
  }
  const cookieObservations=observeCookies(restored.cookies,profile.cookieObservations);
  return {...report,cookieObservations,cookieAge:cookieAge.assessCookieAge(cookieObservations)};
}

/** Set Chromium's network metadata before the page's first navigation. */
export async function createMobilePage(context, profile) {
  const page = await context.newPage();
  try {
    await prepareMobilePage(page, profile);
    return page;
  } catch (error) {
    await page.close().catch(() => {});
    throw error;
  }
}

export async function prepareMobilePage(page, profile) {
  const session = await getPageSession(page);
  const navigator = profile.fingerprint.navigator;
  const hints = navigator.userAgentData;
  try {
    await session.send('Network.setUserAgentOverride', profile.mobileOS === 'android' && hints ? buildCdpUserAgentOverride(profile) : {
      userAgent: navigator.userAgent, acceptLanguage: navigator.languages.join(','), platform: navigator.platform,
    });
  } catch (error) {
    await session.detach().catch(() => {});
    await page.close().catch(() => {});
    throw error;
  }
  return page;
}

export async function stageMobileProfile(directory, profile, context, { storageMode = 'snapshot', warmupStage = profile.snapshot?.warmupStage, maxProfileBytes } = {}) {
  const limit = profileByteLimit(maxProfileBytes);
  const target = profilePath(directory, profile.profileId);
  const temporary = join(directory, `.${profile.profileId}.${randomUUID()}.tmp`);
  let cookiesCount;
  let reason = 'profile_write_failed';
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ProfileError('invalid_profiles_directory');
    reason = 'profile_storage_failed';
    const exported = await context.storageState({ indexedDB: true });
    const state = typeof context.cookies === 'function' ? { ...exported, cookies: await context.cookies() } : exported;
    reason = 'profile_state_invalid';
    const { snapshot: _previousSnapshot, ...previous } = profile;
    const value = snapshots.stampSnapshot(validateProfile({ ...previous, fingerprint: fp.deviceFingerprint(profile.fingerprint), runtime: runtimeStates.get(context) || { battery: batteryState.createBatteryModel(profile) }, cookies: state.cookies, cookieObservations: observeCookies(state.cookies,profile.cookieObservations), origins: state.origins, savedAt: new Date().toISOString() }, profile.profileId), storageMode, warmupStage);
    cookiesCount = value.cookies.length;
    const json = JSON.stringify(value);
    if (Buffer.byteLength(json) > limit) throw new ProfileError('profile_too_large');
    reason = 'profile_write_failed';
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(json); await file.sync(); }
    finally { await file.close(); }
    return {
      publish: async () => { try { await snapshots.publishSnapshot(temporary, target); } catch (error) { throw profileSaveError(error); } },
      discard: async () => { await rm(temporary, { force: true }); },
      cookiesCount,
      snapshot: value,
      temporary,
      summary: { ...sessionSummary(value), savedAt: value.savedAt, snapshotId: value.snapshot.id, passportHash: value.snapshot.passportHash, storageMode },
    };
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    if (error instanceof ProfileError) throw error;
    throw profileSaveError(error, reason);
  }
}

function profileSaveError(error, fallback = 'profile_write_failed') {
  const code = ['EACCES', 'EPERM'].includes(error?.code) ? 'profile_permission_denied' : error?.code === 'ENOSPC' ? 'profile_disk_full' : fallback;
  return new ProfileError(code);
}