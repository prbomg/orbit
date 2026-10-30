import { randomUUID } from 'node:crypto';
import { sampleApiBehavior, compareApiBehavior } from './api-behavior.mjs';

// This function is serialized into documents and WorkerGlobalScope. Keep it free
// of imports and Window-only assumptions. Missing optional APIs are capabilities,
// not fabricated values or evidence of an identity mismatch.
export async function sampleContext(behaviorProbe) {
  const n = navigator;
  const result = { navigator: {}, capabilities: {}, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };
  for (const key of ['userAgent', 'platform', 'hardwareConcurrency', 'deviceMemory', 'language', 'languages']) {
    result.capabilities[key] = key in n;
    if (key in n) result.navigator[key] = key === 'languages' ? Array.from(n[key]) : n[key];
  }
  result.capabilities.clientHints = Boolean(n.userAgentData?.getHighEntropyValues);
  if (result.capabilities.clientHints) {
    result.clientHints = await n.userAgentData.getHighEntropyValues(['model', 'platformVersion', 'architecture', 'bitness', 'fullVersionList', 'uaFullVersion', 'wow64']);
  }
  const digest = async data => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), b => b.toString(16).padStart(2, '0')).join('');
  async function canvasSample(canvas) {
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#336699'; ctx.fillRect(0, 0, 64, 64);
    return digest(ctx.getImageData(0, 0, 64, 64).data);
  }
  function gpuSample(canvas, api) {
    const gl = canvas.getContext(api);
    if (!gl) return null;
    try {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      const shaderPrecision = {};
      for (const stage of ['VERTEX_SHADER','FRAGMENT_SHADER']) {
        shaderPrecision[stage] = {};
        for (const format of ['LOW_FLOAT','MEDIUM_FLOAT','HIGH_FLOAT','LOW_INT','MEDIUM_INT','HIGH_INT']) {
          const value = gl.getShaderPrecisionFormat(gl[stage], gl[format]);
          shaderPrecision[stage][format] = value ? {rangeMin:value.rangeMin,rangeMax:value.rangeMax,precision:value.precision} : null;
        }
      }
      return { vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : null,
        renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null,
        shaderPrecision, extensions: gl.getSupportedExtensions()?.slice().sort() ?? null,
        limits: { maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE), maxCubeMapTextureSize: gl.getParameter(gl.MAX_CUBE_MAP_TEXTURE_SIZE),
          maxRenderbufferSize: gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), maxViewportDims: Array.from(gl.getParameter(gl.MAX_VIEWPORT_DIMS)), maxVertexAttribs: gl.getParameter(gl.MAX_VERTEX_ATTRIBS),
          maxVertexUniformVectors: gl.getParameter(gl.MAX_VERTEX_UNIFORM_VECTORS), maxFragmentUniformVectors: gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS),
          maxVaryingVectors: gl.getParameter(gl.MAX_VARYING_VECTORS), maxTextureImageUnits: gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS),
          maxVertexTextureImageUnits: gl.getParameter(gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS), maxCombinedTextureImageUnits: gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS),
          ...(api==='webgl2'?{maxVertexUniformComponents:gl.getParameter(gl.MAX_VERTEX_UNIFORM_COMPONENTS),maxFragmentUniformComponents:gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_COMPONENTS),maxUniformBufferBindings:gl.getParameter(gl.MAX_UNIFORM_BUFFER_BINDINGS)}:{}) } };
    } finally { gl.getExtension('WEBGL_lose_context')?.loseContext(); }
  }
  result.capabilities.offscreenCanvas = typeof OffscreenCanvas !== 'undefined';
  if (result.capabilities.offscreenCanvas) {
    result.offscreen = { canvasHash: await canvasSample(new OffscreenCanvas(64, 64)),
      webgl: gpuSample(new OffscreenCanvas(64, 64), 'webgl'), webgl2: gpuSample(new OffscreenCanvas(64, 64), 'webgl2') };
  }
  if (typeof document !== 'undefined') {
    const canvas = () => { const c = document.createElement('canvas'); c.width = c.height = 64; return c; };
    result.documentCanvas = { canvasHash: await canvasSample(canvas()), webgl: gpuSample(canvas(), 'webgl'), webgl2: gpuSample(canvas(), 'webgl2') };
  }
  if (typeof behaviorProbe === 'function') result.apiBehavior = await behaviorProbe();
  return result;
}

const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export function compareContext(scene, observed, profile, main) {
  const checks = [];
  const check = (field, actual, expected, supported = true) => checks.push({ field,
    status: !supported ? 'unsupported' : equal(actual, expected) ? 'passed' : 'failed',
    ...(supported ? { expected, actual } : { reason: 'API недоступен в этом контексте' }) });
  const nav = profile.fingerprint.navigator;
  for (const key of ['userAgent', 'platform', 'hardwareConcurrency', 'deviceMemory', 'language', 'languages']) {
    if (nav[key] !== undefined) check(`navigator.${key}`, observed.navigator?.[key], nav[key], observed.capabilities?.[key]);
  }
  if (profile.passport?.timezone) check('timezone', observed.timezone, new Intl.DateTimeFormat('en', { timeZone: profile.passport.timezone }).resolvedOptions().timeZone);
  for (const [key, expected] of Object.entries(nav.userAgentData || {})) {
    check(`clientHints.${key}`, observed.clientHints?.[key], expected, observed.capabilities?.clientHints);
  }
  for (const source of ['documentCanvas', 'offscreen']) {
    for (const api of ['webgl', 'webgl2']) {
      const gpu = observed[source]?.[api];
      for (const key of ['vendor', 'renderer']) check(`${source}.${api}.${key}`, gpu?.[key], profile.fingerprint.videoCard[key], gpu?.[key] != null);
      for (const [key, expected] of Object.entries(profile.fingerprint.webglLimits || {}).filter(([key]) => api === 'webgl2' || !['maxVertexUniformComponents','maxFragmentUniformComponents'].includes(key))) check(`${source}.${api}.limits.${key}`, gpu?.limits?.[key], expected, Boolean(gpu));
      const reference=main?.documentCanvas?.[api];
      for(const key of ['maxVertexUniformVectors','maxFragmentUniformVectors','maxVaryingVectors','maxTextureImageUnits','maxVertexUniformComponents','maxFragmentUniformComponents','maxUniformBufferBindings','maxVertexTextureImageUnits','maxCombinedTextureImageUnits']) {
        if(reference?.limits?.[key]!==undefined)check(`${source}.${api}.runtimeLimits.${key}`,gpu?.limits?.[key],reference.limits[key],Boolean(gpu));
      }
      if(reference?.extensions)check(`${source}.${api}.extensionsMatchMain`,gpu?.extensions,reference.extensions,Boolean(gpu));
      if(reference?.shaderPrecision)check(`${source}.${api}.shaderPrecisionMatchesMain`,gpu?.shaderPrecision,reference.shaderPrecision,Boolean(gpu));
    }
    check(`${source}.canvasMatchesMain`, observed[source]?.canvasHash, main?.documentCanvas?.canvasHash, Boolean(observed[source]?.canvasHash && main?.documentCanvas?.canvasHash));
  }
  return { scene, status: checks.some(c => c.status === 'failed') ? 'failed' : 'passed', checks, observed };
}

// All resources are fulfilled locally by Playwright: no DNS, proxy or external
// website is contacted. A unique path isolates SW scopes and SharedWorker names.
export async function inspectContextMatrix(page, profile, { timeoutMs = 5000, baseline = null, native = false } = {}) {
  if (!profile && !native) throw Error('context_matrix_profile_required');
  const id = randomUUID(), base = `https://orbit-context.invalid/${id}/`;
  const frameBase = `https://orbit-context-frame.invalid/${id}/`;
  const context = page.context(), records = [];
  const sample = `(${sampleContext.toString()})(${sampleApiBehavior.toString()})`;
  const snapshot = `const snapshot=${sample};snapshot.catch(()=>{});`;
  const handler = async route => {
    const url = new URL(route.request().url());
    let body;
    if (url.pathname.endsWith('/dedicated.js')) body = `${snapshot}snapshot.then(value=>postMessage({value}),error=>postMessage({error:String(error)}));`;
    else if (url.pathname.endsWith('/shared.js')) body = `${snapshot}onconnect=e=>{const p=e.ports[0];snapshot.then(value=>p.postMessage({value}),error=>p.postMessage({error:String(error)}));};`;
    else if (url.pathname.endsWith('/service.js')) body = `${snapshot}oninstall=()=>skipWaiting();onactivate=e=>e.waitUntil(clients.claim());onmessage=e=>e.waitUntil(snapshot.then(value=>e.ports[0].postMessage({value}),error=>e.ports[0].postMessage({error:String(error)})));`;
    else body = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><script>globalThis.__orbitContextSnapshot=${sample};globalThis.__orbitContextSnapshot.catch(()=>{});</script><body>Orbit context diagnostic</body>`;
    await route.fulfill({ contentType: url.pathname.endsWith('.js') ? 'application/javascript' : 'text/html', headers: { 'cache-control': 'no-store' }, body });
  };
  const matcher = url => url.href.startsWith(base) || url.href.startsWith(frameBase);
  await context.route(matcher, handler);
  let main;
  async function measure(scene, run) {
    let timer;
    try {
      const observed = await Promise.race([run(), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('probe_timeout')), timeoutMs + 500); })]);
      if (scene === 'main') main = observed;
      const record = native ? { scene, status: 'passed', checks: [], observed } : compareContext(scene, observed, profile, main);
      if (!native) record.apiBehavior = compareApiBehavior(observed.apiBehavior, baseline?.records?.find(r => r.scene === scene && r.status !== 'error')?.observed?.apiBehavior);
      records.push(record);
    } catch {
      // Do not persist transport errors that might include proxy credentials.
      records.push({ scene, status: 'error', error: 'context_probe_failed_or_timed_out', checks: [] });
    } finally { clearTimeout(timer); }
  }
  try {
    await page.goto(base, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await measure('main', () => page.evaluate(() => globalThis.__orbitContextSnapshot));
    for (const [scene, url] of [['iframe', `${base}frame`], ['crossOriginIframe', `${frameBase}frame`]]) {
      await measure(scene, async () => {
        const navigated = page.waitForEvent('framenavigated', { predicate: frame => frame.url() === url, timeout: timeoutMs }).catch(() => null);
        await page.evaluate(({ scene, url }) => { const f = document.createElement('iframe'); f.name = scene; f.src = url; document.body.append(f); }, { scene, url });
        const frame = await navigated;
        if (!frame) throw Error('frame_unavailable');
        await frame.waitForFunction(() => Boolean(globalThis.__orbitContextSnapshot), null, { timeout: timeoutMs });
        return await frame.evaluate(() => globalThis.__orbitContextSnapshot);
      });
    }
    for (const scene of ['dedicatedWorker', 'sharedWorker', 'serviceWorker']) {
      await measure(scene, () => page.evaluate(async ({ scene, base, id, timeoutMs }) => {
        let worker, port, registration, timer;
        try {
          return await new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(Error('probe_timeout')), timeoutMs);
            const receive = e => e.data.error ? reject(Error('probe_failed')) : resolve(e.data.value);
            if (scene === 'dedicatedWorker') { worker = new Worker(`${base}dedicated.js`); worker.onmessage = receive; worker.onerror = () => reject(Error('worker_error')); }
            else if (scene === 'sharedWorker') { worker = new SharedWorker(`${base}shared.js`, id); port = worker.port; port.onmessage = receive; worker.onerror = () => reject(Error('worker_error')); port.start(); }
            else {
              navigator.serviceWorker.register(`${base}service.js`, { scope: base }).then(async reg => {
                registration = reg;
                // An outstanding registration may finish after the deadline.
                if (!timer) { await reg.unregister(); return; }
                const active = reg.active || reg.installing || reg.waiting;
                if (!active) throw Error('worker_missing');
                if (active.state !== 'activated') await new Promise((done, fail) => {
                  active.addEventListener('statechange', () => { if (active.state === 'activated') done(); if (active.state === 'redundant') fail(Error('worker_redundant')); });
                  if (active.state === 'activated') done();
                });
                if (!timer) return;
                const channel = new MessageChannel(); port = channel.port1; port.onmessage = receive;
                active.postMessage('probe', [channel.port2]);
              }).catch(reject);
            }
          });
        } finally {
          clearTimeout(timer); timer = null;
          worker?.terminate?.(); port?.close(); await registration?.unregister();
        }
      }, { scene, base, id, timeoutMs }));
    }
  } catch {
    for (const scene of ['main', 'iframe', 'crossOriginIframe', 'dedicatedWorker', 'sharedWorker', 'serviceWorker']) {
      if (!records.some(r => r.scene === scene)) records.push({ scene, status: 'error', error: 'context_probe_failed_or_timed_out', checks: [] });
    }
  } finally {
    // Remove diagnostic frames and the SW-controlled document, then its routes.
    await page.goto('about:blank', { timeout: timeoutMs }).catch(() => {});
    await context.unroute(matcher, handler);
  }
  return { version: 3, status: records.every(r => r.status === 'passed') ? 'passed' : 'failed', records,
    apiBehavior: native ? { status: 'baseline', enforcement: 'diagnostic', errors: records.filter(r => r.status === 'error' || r.observed?.apiBehavior?.errors?.length).length } : {
      status: records.some(r => r.status === 'error' || r.apiBehavior?.status === 'incomplete') ? 'incomplete' : records.some(r => r.apiBehavior?.status === 'differences') ? 'differences' : 'matched',
      enforcement: 'diagnostic', baselineScope: baseline?.scope || null,
      differences: records.reduce((n, r) => n + (r.apiBehavior?.differences.length || 0), 0),
      errors: records.filter(r => r.status === 'error' || r.apiBehavior?.status === 'incomplete').length,
    },
    summary: { contexts: records.length, failed: records.filter(r => r.status === 'failed').length,
      errors: records.filter(r => r.status === 'error').length, mismatches: records.flatMap(r => r.checks).filter(c => c.status === 'failed').length } };
}
