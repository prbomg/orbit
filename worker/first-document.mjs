import { clientHintHeaders } from './client-hints.mjs';
// Owned offline diagnostic origins: no profile cookies or external requests are recorded.
const states = new WeakMap();
const capture = `window.__orbitFirst=(async()=>({ua:navigator.userAgent,platform:navigator.platform,cpu:navigator.hardwareConcurrency,touch:navigator.maxTouchPoints,language:navigator.language,languages:navigator.languages,colorScheme:matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light',width:screen.width,height:screen.height,dpr:devicePixelRatio,hints:navigator.userAgentData?await navigator.userAgentData.getHighEntropyValues(['model','platformVersion','architecture','bitness','fullVersionList','wow64']):null}))();`;
export async function installFirstDocumentDiagnostics(context) {
  const requests = new Map(); states.set(context, requests);
  const matcher = /^https:\/\/orbit-(?:fingerprint|frame)\.invalid\//;
  const handler = async route => {
    const url = new URL(route.request().url());
    requests.set(url.href, Object.fromEntries(Object.entries(route.request().headers()).filter(([k]) => k === 'user-agent' || k === 'accept-language' || k.startsWith('sec-ch-ua'))));
    if (url.pathname === '/redirect') return route.fulfill({ status: 307, headers: { location: 'https://orbit-fingerprint.invalid/after-redirect', 'cache-control': 'no-store' } });
    await route.fulfill({ contentType: 'text/html', headers: { 'cache-control': 'no-store', 'accept-ch': 'Sec-CH-UA-Model, Sec-CH-UA-Platform-Version, Sec-CH-UA-Full-Version-List, Sec-CH-UA-Arch, Sec-CH-UA-Bitness' }, body: `<!doctype html><html><head><script>${capture}</script><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>Orbit diagnostic</body></html>` });
  };
  await context.route(matcher, handler);
  return async () => {
    try { await context.unroute(matcher, handler); }
    finally { if (states.get(context) === requests) states.delete(context); }
  };
}
export async function inspectFirstDocuments(page, profile) {
  const dispose = await installFirstDocumentDiagnostics(page.context());
  try { return await readFirstDocuments(page, profile); }
  finally { await dispose(); }
}
async function readFirstDocuments(page, profile) {
  const origin = 'https://orbit-fingerprint.invalid', records = [], requests = states.get(page.context());
  const n = profile.fingerprint.navigator, s = profile.fingerprint.screen;
  async function read(frame, scene, url) {
    const actual = await frame.evaluate(() => window.__orbitFirst);
    const headers = requests?.get(url) || {};
    const expected = n.userAgentData;
    const checks = { firstRequestUA: headers['user-agent'] === n.userAgent, firstScriptUA: actual?.ua === n.userAgent, cpu: actual?.cpu === n.hardwareConcurrency, touch: actual?.touch === n.maxTouchPoints, language: actual?.language === n.language, screen: actual?.width === s.width && actual?.height === s.height && actual?.dpr === s.devicePixelRatio };
    if(profile.fingerprint.preferences){
      checks.platform=actual?.platform===n.platform;
      checks.languages=JSON.stringify(actual?.languages)===JSON.stringify(n.languages);
      checks.languageHeader=headers['accept-language']===profile.headers['accept-language'];
      checks.colorScheme=actual?.colorScheme===profile.fingerprint.preferences.colorScheme;
      checks.wow64=actual?.hints?.wow64===n.userAgentData?.wow64;
    }
    if (expected && profile.mobileOS === 'android') {
      checks.clientHints = actual?.hints?.architecture === expected.architecture && actual?.hints?.bitness === expected.bitness && actual?.hints?.model === expected.model && actual?.hints?.platformVersion === expected.platformVersion && JSON.stringify(actual?.hints?.fullVersionList) === JSON.stringify(expected.fullVersionList);
      const values = clientHintHeaders(expected);
      checks.networkHints = ['sec-ch-ua','sec-ch-ua-platform','sec-ch-ua-mobile'].every(key => headers[key] === values[key]) && Object.entries(values).every(([key,value]) => !headers[key] || headers[key] === value);
    }
    records.push({ scene, status: Object.values(checks).every(Boolean) ? 'passed' : 'failed', checks, headers, observed: actual });
  }
  await page.goto(`${origin}/document`, { waitUntil: 'domcontentloaded' });
  await read(page, 'document', `${origin}/document`);
  for (const [scene, url] of [['iframe', `${origin}/frame`], ['crossOriginIframe','https://orbit-frame.invalid/frame']]) {
    await page.evaluate(url => new Promise(resolve => { const f = document.createElement('iframe'); f.onload = resolve; f.src = url; document.body.append(f); }), url);
    await read(page.frames().find(frame => frame.url() === url), scene, url);
  }
  let popup;
  try {
    const promise = page.waitForEvent('popup');
    // A cancelled window.open can fail before we reach the event await.
    // Still consume its later rejection when the context closes.
    promise.catch(() => {});
    await page.evaluate(url => window.open(url), `${origin}/popup`);
    popup = await promise; await popup.waitForLoadState('domcontentloaded');
    await read(popup, 'popup', `${origin}/popup`);
  } finally { await popup?.close(); }
  // Playwright routes only the initial request in a redirect chain. CDP Fetch
  // captures the redirected network request, before DNS or a proxy is contacted.
  const cdp = await page.context().newCDPSession(page);
  const redirected = async event => {
    requests.set(event.request.url, Object.fromEntries(Object.entries(event.request.headers).map(([k,v]) => [k.toLowerCase(),v]).filter(([k]) => k === 'user-agent' || k === 'accept-language' || k.startsWith('sec-ch-ua'))));
    await cdp.send('Fetch.fulfillRequest', { requestId: event.requestId, responseCode: 200, responseHeaders: [{name:'Content-Type',value:'text/html'}], body: Buffer.from(`<!doctype html><script>${capture}</script>`).toString('base64') }).catch(() => {});
  };
  cdp.on('Fetch.requestPaused', redirected);
  try {
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: `${origin}/after-redirect`, requestStage: 'Request' }] });
    await page.goto(`${origin}/redirect`, { waitUntil: 'domcontentloaded' });
    await read(page, 'redirect', `${origin}/after-redirect`);
  } finally { await cdp.send('Fetch.disable').catch(() => {}); cdp.off('Fetch.requestPaused', redirected); await cdp.detach(); }
  return { status: records.every(r => r.status === 'passed') ? 'passed' : 'failed', records };
}
