import fp from '../utils/fingerprint.js';
import structured from '../utils/structuredFields.js';
import { passportValidation } from './passport-validation.mjs';

export class BrowserUpgradeError extends Error {
  constructor(code) { super(code); this.name = 'BrowserUpgradeError'; this.code = code; }
}
const validVersion = value => typeof value === 'string' && /^\d{2,3}(\.\d{1,5}){3}$/.test(value);
const compareVersions = (a, b) => {
  const aa = a.split('.').map(Number), bb = b.split('.').map(Number);
  for (let i = 0; i < 4; i++) if (aa[i] !== bb[i]) return Math.sign(aa[i] - bb[i]);
  return 0;
};

// Called only after this binary passes qualifyBrowser. This updates version
// metadata; hardware, OS, locale, storage and readiness evidence are not rebuilt.
export function synchronizeBrowserRuntime(profileId, passport, { runtimeVersion, nativeBrands, nativeFullVersionList }) {
  if (!validVersion(runtimeVersion)) throw new BrowserUpgradeError('browser_runtime_version_invalid');
  if (!fp.supportsBrowserUpgrade(passport)) return { passport, changed: false, unsupported: true };
  const nav = passport.fingerprint.navigator, hints = nav.userAgentData;
  const previousVersion = passport.runtimeVersion || hints.uaFullVersion;
  if (passport.runtimeVersion && validVersion(previousVersion) && compareVersions(runtimeVersion, previousVersion) < 0) {
    throw new BrowserUpgradeError('browser_runtime_downgrade');
  }
  if (!Array.isArray(nativeBrands) || !nativeBrands.length || !Array.isArray(nativeFullVersionList) || !nativeFullVersionList.length) {
    throw new BrowserUpgradeError('browser_runtime_metadata_unavailable');
  }
  const metadata = fp.chromeMetadata({ fullVersion: runtimeVersion, osVersion: hints.platformVersion, modelCode: hints.model,
    bitness: hints.bitness ?? '', nativeBrands, nativeFullVersionList });
  const next = structuredClone(passport), n = next.fingerprint.navigator;
  n.userAgent = metadata.userAgent;
  n.appVersion = metadata.userAgent.replace(/^Mozilla\//, '');
  n.userAgentData = { ...n.userAgentData, uaFullVersion: runtimeVersion,
    ...(Object.hasOwn(n.userAgentData, 'fullVersion') ? { fullVersion: runtimeVersion } : {}),
    brands: metadata.userAgentData.brands, fullVersionList: metadata.userAgentData.fullVersionList };
  const versions = { 'user-agent': n.userAgent, 'sec-ch-ua': structured.formatBrandList(n.userAgentData.brands),
    'sec-ch-ua-full-version': structured.quoted(runtimeVersion), 'sec-ch-ua-full-version-list': structured.formatBrandList(n.userAgentData.fullVersionList) };
  for (const key of Object.keys(next.headers)) if (versions[key.toLowerCase()] !== undefined) next.headers[key] = versions[key.toLowerCase()];
  next.headers['user-agent'] = versions['user-agent'];
  next.headers['sec-ch-ua'] = versions['sec-ch-ua'];
  next.runtimeVersion = runtimeVersion;
  const changed = passport.runtimeVersion !== next.runtimeVersion || JSON.stringify(nav) !== JSON.stringify(n) || JSON.stringify(passport.headers) !== JSON.stringify(next.headers);
  if (!changed) return { passport, changed: false };
  if (fp.identityHash(profileId, passport) !== fp.identityHash(profileId, next)) throw new BrowserUpgradeError('browser_upgrade_identity_changed');
  const validation = passportValidation(next, runtimeVersion);
  if (validation.status !== 'passed') throw new BrowserUpgradeError('passport_invalid');
  next.validation = validation;
  if (passport.runtimeVersion && previousVersion !== runtimeVersion) next.browserUpgrades = [
    ...(Array.isArray(passport.browserUpgrades) ? passport.browserUpgrades : []).slice(-9),
    { fromVersion: previousVersion, toVersion: runtimeVersion, upgradedAt: new Date().toISOString() },
  ];
  return { passport: next, changed: true, fromVersion: previousVersion, toVersion: runtimeVersion };
}
