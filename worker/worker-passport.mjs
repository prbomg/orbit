import { installNativeSignatures } from './native-signatures.mjs';
import { buildCdpUserAgentOverride } from './client-hints.mjs';
import { installCanvasProfile, canvasProfileOptions } from './canvas-profile.mjs';
import { installWebglLimits } from './webgl-limits.mjs';
import { assertAdapterCapability } from './playwright-adapter.mjs';

export const WORKER_PASSPORT_MARKER = '/* orbit-worker-passport-v1:';
let adapterChecked = false;
export function assertWorkerAdapterInstalled(read) {
  if (adapterChecked && !read) return;
  assertAdapterCapability('passport', read);
  if (!read) adapterChecked = true;
}

export function installWorkerPassport(fingerprint, signature = wrapper => wrapper) {
  const nav = navigator, prototype = Object.getPrototypeOf(nav), expected = fingerprint.navigator;
  for (const key of ['userAgent', 'platform', 'hardwareConcurrency', 'deviceMemory', 'language', 'languages']) {
    if (!(key in nav) || expected[key] === undefined) continue;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
    // CDP already supplies some of these fields natively. Preserve that getter
    // whenever it agrees with the passport instead of installing a redundant JS
    // replacement. Remaining proxies retain native receiver validation.
    const actual = descriptor?.get ? Reflect.apply(descriptor.get, nav, []) : nav[key];
    if (Array.isArray(expected[key]) ? Array.isArray(actual) && actual.length === expected[key].length && actual.every((v, i) => v === expected[key][i]) : actual === expected[key]) continue;
    if (!descriptor?.configurable) throw Error('worker_navigator_property_not_configurable');
    const value = Array.isArray(expected[key]) ? Object.freeze([...expected[key]]) : expected[key];
    Object.defineProperty(prototype, key, { ...descriptor, get: signature(new Proxy(descriptor.get, { apply(native, receiver, args) {
      Reflect.apply(native, receiver, args);
      return value;
    } }), descriptor.get) });
  }
}

// Playwright's versioned patch reads this marked context script immediately
// before its own Runtime.runIfWaitingForDebugger. It never copies Window code
// into WorkerGlobalScope, and each BrowserContext owns its own passport.
export function workerPassportScript(profile) {
  assertWorkerAdapterInstalled();
  const override = profile.fingerprint.navigator.userAgentData ? buildCdpUserAgentOverride(profile) : {
    userAgent: profile.fingerprint.navigator.userAgent, platform: profile.fingerprint.navigator.platform,
    acceptLanguage: profile.fingerprint.navigator.languages.join(','),
  };
  return `${WORKER_PASSPORT_MARKER}${JSON.stringify({ override }).replaceAll('*/', '*\\/')} */\n` +
    `if(typeof WorkerGlobalScope!=='undefined'&&globalThis instanceof WorkerGlobalScope){` +
    `const signature=(${installNativeSignatures.toString()})();` +
    `(${installWorkerPassport.toString()})(${JSON.stringify(profile.fingerprint)},signature);` +
    `(${installWebglLimits.toString()})(${JSON.stringify(profile.fingerprint.webglLimits)},${JSON.stringify(profile.fingerprint.videoCard)},signature);` +
    `(${installCanvasProfile.toString()})(${JSON.stringify(canvasProfileOptions(profile))});` +
    `}`;
}
