// Serialized into owned fixture documents AND workers. No external state, page
// scripts, profile values or global prototypes are changed by these probes.
export async function sampleApiBehavior() {
  const stringify = Function.prototype.toString;
  const result = { version: 1, properties: {}, fonts: { supported: false }, errors: [] };
  const frame = line => line.trim().replace(/(?:https?:|blob:)[^\s)]+/g, '<fixture>').replace(/:\d+:\d+/g, ':<line>:<column>');
  async function outcome(action) {
    try {
      const value = await action();
      return { status: 'returned', type: typeof value };
    } catch (error) {
      return { status: 'threw', name: String(error.name), message: String(error.message),
        stack: String(error.stack || '').split('\n').slice(1, 7).map(frame) };
    }
  }
  function shape(fn) {
    return { name: fn.name, length: fn.length, source: Reflect.apply(stringify, fn, []),
      ownNames: Object.getOwnPropertyNames(fn).sort(),
      prototypeIsFunctionPrototype: Object.getPrototypeOf(fn) === Function.prototype };
  }
  async function property(label, object, key) {
    if (!object) { result.properties[label] = { supported: false }; return; }
    let owner = object, depth = 0, descriptor;
    while (owner && !(descriptor = Object.getOwnPropertyDescriptor(owner, key))) { owner = Object.getPrototypeOf(owner); depth++; }
    if (!descriptor) { result.properties[label] = { supported: false }; return; }
    const entry = { supported: true, depth, descriptor: { configurable: descriptor.configurable,
      enumerable: descriptor.enumerable, kind: 'value' in descriptor ? 'data' : 'accessor',
      ...('writable' in descriptor ? { writable: descriptor.writable } : {}),
      hasGetter: typeof descriptor.get === 'function', hasSetter: typeof descriptor.set === 'function' }, functions: {} };
    result.properties[label] = entry;
    for (const [kind, fn] of [['getter', descriptor.get], ['setter', descriptor.set], ['value', descriptor.value]]) {
      if (typeof fn !== 'function') continue;
      const proxy = new Proxy(fn, {});
      entry.functions[kind] = { ...shape(fn), proxy: shape(proxy),
        invalidReceiver: await outcome(() => Reflect.apply(fn, {}, [])),
        proxyInvalidReceiver: await outcome(() => Reflect.apply(proxy, {}, [])),
        construction: await outcome(() => Reflect.construct(fn, [])),
        inheritedToString: await outcome(() => Reflect.apply(stringify, Object.create(fn), [])) };
    }
  }
  async function measure(label, object, key) {
    try { await property(label, object, key); }
    catch { result.errors.push({ field: label, code: 'api_behavior_probe_failed' }); }
  }
  for (const key of ['userAgent', 'platform', 'hardwareConcurrency', 'deviceMemory', 'language', 'languages', 'maxTouchPoints', 'pdfViewerEnabled', 'userAgentData']) {
    await measure(`navigator.${key}`, navigator, key);
  }
  for (const key of ['getHighEntropyValues', 'toJSON']) await measure(`userAgentData.${key}`, navigator.userAgentData, key);
  const targets = [
    ['Function.toString', Function.prototype, 'toString'],
    ['WebGL.getParameter', globalThis.WebGLRenderingContext?.prototype, 'getParameter'],
    ['WebGL2.getParameter', globalThis.WebGL2RenderingContext?.prototype, 'getParameter'],
    ['WebGL.getShaderPrecisionFormat', globalThis.WebGLRenderingContext?.prototype, 'getShaderPrecisionFormat'],
    ['WebGL2.getShaderPrecisionFormat', globalThis.WebGL2RenderingContext?.prototype, 'getShaderPrecisionFormat'],
    ['Canvas2D.getImageData', globalThis.CanvasRenderingContext2D?.prototype, 'getImageData'],
    ['Canvas.toDataURL', globalThis.HTMLCanvasElement?.prototype, 'toDataURL'],
    ['Canvas.toBlob', globalThis.HTMLCanvasElement?.prototype, 'toBlob'],
    ['Offscreen2D.getImageData', globalThis.OffscreenCanvasRenderingContext2D?.prototype, 'getImageData'],
    ['Offscreen.convertToBlob', globalThis.OffscreenCanvas?.prototype, 'convertToBlob'],
    ['Element.getClientRects', globalThis.Element?.prototype, 'getClientRects'],
    ['Element.getBoundingClientRect', globalThis.Element?.prototype, 'getBoundingClientRect'],
    ['Range.getClientRects', globalThis.Range?.prototype, 'getClientRects'],
    ['AudioContext.createOscillator', globalThis.AudioContext?.prototype, 'createOscillator'],
    ['OfflineAudioContext.startRendering', globalThis.OfflineAudioContext?.prototype, 'startRendering'],
    ['AudioBuffer.getChannelData', globalThis.AudioBuffer?.prototype, 'getChannelData'],
    ['FontFaceSet.check', globalThis.FontFaceSet?.prototype, 'check'],
  ];
  for (const args of targets) await measure(...args);
  // These are measured installed fonts, not names asserted by a passport. Canvas
  // metrics provide evidence of fallback; FontFaceSet.check alone is insufficient.
  const fonts = globalThis.document?.fonts || globalThis.fonts;
  const canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(512, 128) : globalThis.document?.createElement('canvas');
  const context = canvas?.getContext('2d');
  if (fonts && context) {
    result.fonts = { supported: true, samples: {} };
    for (const name of ['Roboto', 'Noto Sans', 'Noto Serif','DejaVu Sans','Liberation Sans','Ubuntu']) {
      const metrics = {};
      for (const base of ['monospace', 'serif', 'sans-serif']) {
        context.font = `72px ${base}`;
        const fallback = context.measureText('mmmmmmmmmmlliWW012345').width;
        context.font = `72px "${name}", ${base}`;
        let dom=null;
        if(globalThis.document?.body){const el=document.createElement('span');el.textContent='Orbit ЖЩЙ mmmWWW012345';el.style.cssText=`position:absolute;visibility:hidden;font:72px "${name}",${base};white-space:nowrap`;document.body.append(el);dom={width:el.offsetWidth,height:el.offsetHeight};el.remove();}
        metrics[base] = { fallback, measured: context.measureText('mmmmmmmmmmlliWW012345').width,dom };
      }
      result.fonts.samples[name] = { check: fonts.check(`72px "${name}"`), metrics,
        differsFromFallback: Object.values(metrics).some(m => m.fallback !== m.measured) };
    }
  }
  return result;
}

// A difference is evidence of changed observable semantics, not a prediction
// about any third party's fraud classifier. Do not turn it into an admission gate.
export function compareApiBehavior(actual, baseline) {
  if (!actual || !baseline) return { status: 'incomplete', differences: [], reason: 'behavior_sample_missing' };
  const differences = [];
  function compare(path, value, expected) {
    if (JSON.stringify(value) === JSON.stringify(expected)) return;
    if (value && expected && typeof value === 'object' && typeof expected === 'object' && !Array.isArray(value) && !Array.isArray(expected)) {
      for (const key of new Set([...Object.keys(value), ...Object.keys(expected)])) compare(`${path}.${key}`, value[key], expected[key]);
    } else differences.push({ field: path, actual: value ?? null, baseline: expected ?? null });
  }
  compare('properties', actual.properties, baseline.properties);
  compare('fonts', actual.fonts, baseline.fonts);
  return { status: actual.errors?.length || baseline.errors?.length ? 'incomplete' : differences.length ? 'differences' : 'matched', differences,
    ...(actual.errors?.length || baseline.errors?.length ? { reason: 'api_behavior_probe_failed' } : {}) };
}
