import { assertAdapterCapability } from './playwright-adapter.mjs';

export const PERSISTENT_CACHE_MARKER = '/* orbit-persistent-cache-v1 */';
export const HTTP_CACHE_BUDGET_BYTES = 12_000_000;
const persistentContexts = new WeakSet();
let checked = false;
export async function enablePersistentCache(context, read) {
  if (!checked || read) {
    assertAdapterCapability('persistentCache', read);
    if (!read) checked = true;
  }
  // Versioned adapter opt-in; no globals or browser prototypes are changed.
  await context.addInitScript({ content: PERSISTENT_CACHE_MARKER });
  persistentContexts.add(context);
}
export const persistentCacheEnabled = context => persistentContexts.has(context);
// Keep one blank tab alive while storage probes open/close temporary pages.
// Closing the last native window can clear session cookies in Chromium.
export async function closePersistentStartupPages(context) {
  const startup = context.pages();
  await context.newPage();
  for (const page of startup) await page.close();
}
export function persistentLaunchOptions(options = {}, profile) {
  const userAgent = profile?.fingerprint?.navigator?.userAgent;
  const args = (options.args || []).filter(arg => !userAgent || !arg.startsWith('--user-agent='));
  if (userAgent) args.push(`--user-agent=${userAgent}`);
  if (!args.some(arg => arg.startsWith('--disk-cache-size='))) args.push(`--disk-cache-size=${HTTP_CACHE_BUDGET_BYTES}`);
  if (!args.some(arg => arg.startsWith('--media-cache-size='))) args.push('--media-cache-size=1048576');
  return { ...options, args };
}
