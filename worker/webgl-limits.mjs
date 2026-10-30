import { installNativeSignatures } from './native-signatures.mjs';
// Declared emulation limits belong to a saved passport, never to the host GPU.
// This does not change the physical rendering capacity of Chromium.
export function installWebglLimits(limits, videoCard, signature = wrapper => wrapper, realm = globalThis) {
  if (!limits && !videoCard) return;
  limits ||= {};
  const values = new Map([
    [0x9245, videoCard?.vendor], [0x9246, videoCard?.renderer],
    [0x0d33, limits.maxTextureSize], [0x851c, limits.maxCubeMapTextureSize],
    [0x84e8, limits.maxRenderbufferSize], [0x0d3a, limits.maxViewportDims],
    [0x8869, limits.maxVertexAttribs],
    [0x8dfb, limits.maxVertexUniformVectors], [0x8dfd, limits.maxFragmentUniformVectors],
    [0x8dfc, limits.maxVaryingVectors], [0x8872, limits.maxTextureImageUnits],
    [0x8b4a, limits.maxVertexUniformComponents], [0x8b49, limits.maxFragmentUniformComponents],
    [0x8b4c, limits.maxVertexTextureImageUnits], [0x8b4d, limits.maxCombinedTextureImageUnits],
  ].filter(([, value]) => value !== undefined));
  for (const Context of [realm.WebGLRenderingContext, realm.WebGL2RenderingContext]) {
    if (!Context) continue;
    const descriptor = Object.getOwnPropertyDescriptor(Context.prototype, 'getParameter');
    const native = descriptor?.value;
    if (typeof native !== 'function') continue;
    Object.defineProperty(Context.prototype, 'getParameter', {
      ...descriptor,
      value: signature(new Proxy(native, {
        apply(target, receiver, args) {
          let parameter;
          if (!args.length || (typeof args[0] !== 'object' || args[0] === null) && typeof args[0] !== 'function') {
            const actual = Reflect.apply(target, receiver, args);
            parameter = Number(args[0]) >>> 0;
            if (actual === null || !values.has(parameter)) return actual;
          } else {
            // Validate this before invoking user valueOf/Symbol.toPrimitive.
            const probe = Reflect.apply(target, receiver, [0]);
            const raw = Number(args[0]);
            parameter = raw >>> 0;
            if (!values.has(parameter)) return Reflect.apply(target, receiver, [raw]);
            if (probe === null && typeof receiver?.isContextLost === 'function' && receiver.isContextLost()) return null;
          }
          const value = values.get(parameter);
          return Array.isArray(value) ? new realm.Int32Array(value) : value;
        },
      }), native),
    });
  }
}
// Initial about:blank documents can be inspected before Chromium dispatches an
// init script. Guard synchronous iframe access, including nested frames. Each
// Window owns its state, so navigation/replacement installs against new natives.
export function installWindowWebgl(limits, videoCard, installLimits, installSignatures) {
  const rootSignature = installSignatures();
  const key = Symbol.for('__ OrbitWebglRealms');
  const install = realm => {
    if (!realm) return;
    try { void realm.document; } catch { return; } // Cross-origin WindowProxy.
    let state = realm[key];
    if (!state) {
      state = { methods: new WeakSet(), signature: realm === globalThis ? rootSignature : installSignatures(realm), guarded: false };
      Object.defineProperty(realm, key, { value: state, enumerable: false });
    }
    const signature = (wrapper, native) => {
      state.methods.add(wrapper);
      return rootSignature(state.signature(wrapper, native), native);
    };
    const contexts = [realm.WebGLRenderingContext, realm.WebGL2RenderingContext].filter(Boolean);
    if (contexts.some(Context => !state.methods.has(Context.prototype.getParameter))) {
      installLimits(limits, videoCard, signature, realm);
    }
    if (state.guarded || !realm.HTMLIFrameElement) return;
    state.guarded = true;
    const prototype = realm.HTMLIFrameElement.prototype;
    for (const name of ['contentWindow', 'contentDocument']) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
      if (!descriptor?.get || !descriptor.configurable) continue;
      Object.defineProperty(prototype, name, { ...descriptor, get: signature(new Proxy(descriptor.get, {
        apply(native, receiver, args) {
          const value = Reflect.apply(native, receiver, args);
          install(name === 'contentWindow' ? value : value?.defaultView);
          return value;
        },
      }), descriptor.get) });
    }
  };
  install(globalThis);
}

export function webglLimitsScript(limits, videoCard) {
  return limits || videoCard ? `;(${installWindowWebgl.toString()})(${JSON.stringify(limits)},${JSON.stringify(videoCard)},${installWebglLimits.toString()},${installNativeSignatures.toString()});` : '';
}

export function webglLimitSources(limits = {}) {
  limits ||= {};
  const uniforms = ['maxVertexUniformVectors', 'maxFragmentUniformVectors', 'maxVaryingVectors', 'maxVertexUniformComponents', 'maxFragmentUniformComponents'];
  const keys = [...uniforms, 'maxTextureImageUnits', 'maxVertexTextureImageUnits', 'maxCombinedTextureImageUnits'];
  const parameterSources = Object.fromEntries(keys.map(key => [key, Number.isInteger(limits[key]) ? 'catalog-emulation' : 'browser-runtime']));
  const count = uniforms.filter(key => parameterSources[key] === 'catalog-emulation').length;
  return { uniformLimitsSource: count === 0 ? 'browser-runtime' : count === uniforms.length ? 'catalog-emulation' : 'mixed',
    parameterSources, shaderPrecisionSource: 'browser-runtime', extensionsSource: 'browser-runtime', deviceDumpVerified: false };
}
