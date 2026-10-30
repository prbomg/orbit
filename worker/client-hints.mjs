// The saved navigator metadata is the single source for HTTP and CDP values.
import structuredFields from '../utils/structuredFields.js';
const { quoted } = structuredFields;
export const formatBrandList = structuredFields.formatBrandList;
function userAgentData(passport) {
  const hints = passport?.fingerprint?.navigator?.userAgentData;
  if (!hints) throw new Error('Passport is missing fingerprint.navigator.userAgentData');
  return hints;
}
export function buildHttpClientHints(passport, includeHighEntropy = false) {
  const hints = userAgentData(passport);
  const headers = {
    'Sec-CH-UA': formatBrandList(hints.brands),
    'Sec-CH-UA-Mobile': hints.mobile ? '?1' : '?0',
    'Sec-CH-UA-Platform': quoted(hints.platform),
  };
  if (includeHighEntropy) Object.assign(headers, {
    'Sec-CH-UA-Platform-Version': quoted(hints.platformVersion),
    'Sec-CH-UA-Model': quoted(hints.model),
    'Sec-CH-UA-Full-Version-List': formatBrandList(hints.fullVersionList),
    'Sec-CH-UA-Arch': quoted(hints.architecture ?? ''),
    'Sec-CH-UA-Bitness': quoted(hints.bitness ?? '64'),
    'Sec-CH-UA-WoW64': hints.wow64 ? '?1' : '?0',
  });
  return headers;
}
export function buildCdpUserAgentOverride(passport) {
  const hints = userAgentData(passport), nav = passport.fingerprint.navigator;
  const languageHeader = Object.entries(passport.headers || {}).find(([key]) => key.toLowerCase() === 'accept-language')?.[1];
  const languages = nav.languages?.length ? nav.languages : [nav.language || 'ru-RU'];
  return {
    userAgent: nav.userAgent,
    // Chromium adds q weights itself. Passing a weighted HTTP header here
    // duplicates q parameters on redirects. Keep the saved language ordering.
    acceptLanguage: languageHeader == null ? languages.join(',') : languageHeader.split(',').map(value => value.split(';')[0].trim()).filter(Boolean).join(','),
    // Preserve the saved platform, including Chromium's frozen Linux armv81.
    platform: nav.platform,
    userAgentMetadata: {
      brands: structuredClone(hints.brands), fullVersionList: structuredClone(hints.fullVersionList),
      fullVersion: hints.uaFullVersion, platform: hints.platform, platformVersion: hints.platformVersion,
      architecture: hints.architecture ?? '', model: hints.model, mobile: Boolean(hints.mobile),
      bitness: hints.bitness ?? '64',
      ...(typeof hints.wow64 === 'boolean' ? { wow64: hints.wow64 } : {}),
    },
  };
}
// Compatibility for existing callers using lowercase names and the deprecated
// full-version hint. Browser requests use native CDP metadata instead.
export function clientHintHeaders(hints) {
  const headers = Object.fromEntries(Object.entries(buildHttpClientHints({ fingerprint: { navigator: { userAgentData: hints } } }, true)).map(([key, value]) => [key.toLowerCase(), value]));
  headers['sec-ch-ua-full-version'] = quoted(hints.uaFullVersion);
  if (typeof hints.wow64 !== 'boolean') delete headers['sec-ch-ua-wow64'];
  return headers;
}

// Chromium owns User-Agent and all UA Client Hints, including Accept-CH opt-in.
// Keep saved passports intact; omit these fields only from extraHTTPHeaders.
export function initialProfileHeaders(headers={}) {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => {
    const lower = name.toLowerCase();
    return lower !== 'user-agent' && !lower.startsWith('sec-ch-ua');
  }));
}
