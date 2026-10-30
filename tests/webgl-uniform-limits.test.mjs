import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import catalog from '../utils/deviceCatalog.js';
import fp from '../utils/fingerprint.js';
import { webglLimitSources } from '../worker/webgl-limits.mjs';
import { createMobileContext, createMobilePage } from '../worker/profiles.mjs';
import { inspectContextMatrix } from '../worker/context-matrix.mjs';
import { inspectFingerprint } from '../worker/fingerprint-check.mjs';

// Test-only values. These are not measurements of Adreno/Mali hardware.
const additional = { maxVertexUniformVectors: 256, maxFragmentUniformVectors: 128,
  maxVaryingVectors: 8, maxTextureImageUnits: 8, maxVertexUniformComponents: 1024,
  maxFragmentUniformComponents: 512, maxVertexTextureImageUnits: 8, maxCombinedTextureImageUnits: 16 };
const base = catalog.DEVICE_CATALOG.templates[0].webglLimits;

test('extended limits are optional, validated and compared against the declared template', () => {
  assert.deepEqual(catalog.webglLimitsSchema.parse(base), base);
  const limits = { ...base, ...additional };
  assert.deepEqual(catalog.webglLimitsSchema.parse(limits), limits);
  for (const bad of [NaN, Infinity, -1, 0, 1.5, 2 ** 31, null])
    assert.equal(catalog.webglLimitsSchema.safeParse({ ...limits, maxVertexUniformVectors: bad }).success, false);
  for (const patch of [{ maxVertexUniformComponents: 100 }, { maxFragmentUniformComponents: 100 }, { maxCombinedTextureImageUnits: 4 }])
    assert.equal(catalog.webglLimitsSchema.safeParse({ ...limits, ...patch }).success, false);
  const input = structuredClone(catalog.DEVICE_CATALOG);
  input.version = 'test-only-uniforms'; input.templates[0].webglLimits = limits;
  const registry = catalog.createCatalogRegistry(input, []);
  const passport = fp.localPassport({}, { templateId: input.templates[0].id });
  passport.deviceTemplate.catalogVersion = input.version;
  passport.fingerprint.webglLimits = structuredClone(limits);
  assert.deepEqual(catalog.templateIssues(passport, registry), []);
  passport.fingerprint.webglLimits.maxFragmentUniformVectors++;
  assert.ok(catalog.templateIssues(passport, registry).includes('device_template_webgl_limits'));
});

test('diagnostics distinguish runtime, partial and fully declared uniform limits', () => {
  assert.equal(webglLimitSources(null).uniformLimitsSource, 'browser-runtime');
  assert.equal(webglLimitSources(base).uniformLimitsSource, 'browser-runtime');
  const partial = webglLimitSources({ ...base, maxVertexUniformVectors: 256 });
  assert.equal(partial.uniformLimitsSource, 'mixed');
  assert.equal(partial.parameterSources.maxVertexUniformVectors, 'catalog-emulation');
  assert.equal(partial.parameterSources.maxFragmentUniformVectors, 'browser-runtime');
  const full = webglLimitSources(additional);
  assert.equal(full.uniformLimitsSource, 'catalog-emulation');
  assert.equal(full.extensionsSource, 'browser-runtime');
  assert.equal(full.shaderPrecisionSource, 'browser-runtime');
  assert.equal(full.deviceDumpVerified, false);
});

test('declared uniforms reach all six realms; extensions and unconfigured values remain native', { timeout: 90000 }, async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH });
  try {
    const plain = await browser.newContext();
    let native;
    try {
      const page = await plain.newPage();
      native = await page.evaluate(() => ['webgl', 'webgl2'].map(api => {
        const gl = document.createElement('canvas').getContext(api);
        return { extensions: gl.getSupportedExtensions().sort(), textureUnits: gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS),
          uniform: gl.getParameter(gl.MAX_VERTEX_UNIFORM_VECTORS) };
      }));
    } finally { await plain.close(); }
    for (const extended of [false, true]) {
      const passport = fp.localPassport({}, { templateId: catalog.DEVICE_CATALOG.templates[0].id, runtimeVersion: browser.version() });
      // A synthetic fixture only; never saved as a catalog-backed production passport.
      if (extended) Object.assign(passport.fingerprint.webglLimits, additional);
      const profile = fp.profileFromPassport('uniform-fixture', passport), before = JSON.stringify(profile);
      const context = await createMobileContext(browser, profile);
      try {
        const page = await createMobilePage(context, profile);
        const report = await inspectContextMatrix(page, profile);
        assert.equal(report.status, 'passed', JSON.stringify(report));
        assert.equal(report.records.length, 6);
        for (const row of report.records) for (const source of ['offscreen', 'documentCanvas']) {
          if (!row.observed[source]) continue;
          for (const [index, api] of ['webgl', 'webgl2'].entries()) {
            const observed = row.observed[source][api];
            assert.ok(observed, `${row.scene}/${source}/${api}`);
            assert.deepEqual(observed.extensions, native[index].extensions);
            assert.equal(observed.limits.maxVertexUniformVectors, extended ? additional.maxVertexUniformVectors : native[index].uniform);
            assert.equal(observed.limits.maxTextureImageUnits, extended ? additional.maxTextureImageUnits : native[index].textureUnits);
            if (extended) for (const [key, expected] of Object.entries(additional)) {
              if (api === 'webgl' && key.endsWith('UniformComponents')) continue;
              assert.equal(observed.limits[key], expected, `${row.scene}/${source}/${api}/${key}`);
            }
          }
        }
        if (extended) {
          const measurement = await inspectFingerprint(page, profile, undefined, browser.version());
          assert.equal(measurement.status, 'passed', JSON.stringify(measurement.checks));
          assert.equal(measurement.graphics.uniformLimitsSource, 'catalog-emulation');
          assert.deepEqual(measurement.observed.webglExtensions.webgl2, native[1].extensions);
          const errors = await page.evaluate(() => {
            const gl = document.createElement('canvas').getContext('webgl');
            let receiverThrows = false;
            try { gl.getParameter.call({}, gl.MAX_VERTEX_UNIFORM_VECTORS); } catch { receiverThrows = true; }
            const unsupported = gl.getParameter(0x8b4a), error = gl.getError();
            const ext = gl.getExtension('WEBGL_lose_context'); ext.loseContext();
            return { receiverThrows, unsupported, error, lost: gl.getParameter(gl.MAX_VERTEX_UNIFORM_VECTORS) };
          });
          assert.deepEqual(errors, { receiverThrows: true, unsupported: null, error: 1280, lost: null });
        }
        assert.equal(JSON.stringify(profile), before);
      } finally { await context.close(); }
    }
  } finally { await browser.close(); }
});

test('synchronous dynamic iframe access inherits WebGL limits, receivers and native signatures', async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH });
  try {
    const profile = fp.profileFromPassport('dynamic-webgl', fp.localPassport({}, { runtimeVersion: browser.version() }));
    const context = await createMobileContext(browser, profile);
    const page = await createMobilePage(context, profile);
    await page.goto('data:text/html,<body>Dynamic iframe fixture</body>');
    const result = await page.evaluate(async () => {
      const read = realm => {
        const gl = realm.document.createElement('canvas').getContext('webgl');
        gl.getExtension('WEBGL_debug_renderer_info');
        const descriptor = Object.getOwnPropertyDescriptor(realm.WebGLRenderingContext.prototype, 'getParameter');
        let count = 0, badCount = 0, receiverError;
        const renderer = gl.getParameter({ valueOf() { count++; return 0x9246; } });
        try { descriptor.value.call({}, { valueOf() { badCount++; return 0x9246; } }); } catch(e) { receiverError = e.name; }
        const dims = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
        return { texture: gl.getParameter(gl.MAX_TEXTURE_SIZE), renderer, count, badCount, receiverError,
          typed: dims instanceof realm.Int32Array, source: realm.Function.prototype.toString.call(descriptor.value),
          parentSource: Function.prototype.toString.call(descriptor.value),
          flags: [descriptor.configurable, descriptor.enumerable, descriptor.writable] };
      };
      const main = read(window), rows = [];
      for (const srcdoc of [false, true]) {
        const frame = document.createElement('iframe');
        const loaded = new Promise(resolve => frame.onload = resolve);
        if (srcdoc) frame.srcdoc = '<body>Frame</body>';
        document.body.append(frame);
        rows.push(read(frame.contentWindow)); // Same JavaScript turn: no observer can help.
        rows.push(read(frame.contentDocument.defaultView));
        await loaded;
        rows.push(read(frame.contentWindow));
        const nested = frame.contentDocument.createElement('iframe');
        frame.contentDocument.body.append(nested);
        rows.push(read(nested.contentWindow));
        const before = frame.contentWindow.WebGLRenderingContext.prototype.getParameter;
        void frame.contentWindow; void frame.contentDocument;
        if (before !== frame.contentWindow.WebGLRenderingContext.prototype.getParameter) throw Error('duplicate wrapper');
        const reloaded = new Promise(resolve => frame.onload = resolve);
        frame.srcdoc = '<body>Replacement</body>'; await reloaded;
        rows.push(read(frame.contentWindow)); frame.remove();
      }
      const getter = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow');
      let getterError;
      try { getter.get.call({}); } catch(e) { getterError = e.name; }
      return { main, rows, getterError, getterSource: getter.get.toString() };
    });
    assert.equal(result.main.renderer, profile.fingerprint.videoCard.renderer);
    for (const row of [result.main, ...result.rows]) {
      assert.equal(row.texture, profile.fingerprint.webglLimits.maxTextureSize);
      assert.equal(row.renderer, profile.fingerprint.videoCard.renderer);
      assert.equal(row.count, 1); assert.equal(row.badCount, 0); assert.equal(row.receiverError, 'TypeError');
      assert.equal(row.typed, true); assert.deepEqual(row.flags, result.main.flags);
      assert.equal(row.source, 'function getParameter() { [native code] }');
      assert.equal(row.parentSource, row.source);
    }
    assert.equal(result.getterError, 'TypeError');
    assert.equal(result.getterSource, 'function get contentWindow() { [native code] }');
  } finally { await browser.close(); }
});
