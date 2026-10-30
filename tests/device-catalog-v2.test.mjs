import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import catalog from '../utils/deviceCatalog.js';
import fp from '../utils/fingerprint.js';
import { passportValidation } from '../worker/passport-validation.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/device-catalog-v1-passports.json', import.meta.url)));
test('v1 is byte-for-byte unchanged; v2 is registered and has the requested distribution', () => {
  const archived = readFileSync(new URL('../utils/device-catalog-archive/android-catalog-2026-10-v1.json', import.meta.url));
  assert.equal(createHash('sha256').update(archived).digest('hex'), 'b8a4d825669ff4b8d1246cb609e22f55d304e810ee6c39e489836b7fbc7f2497');
  const current = readFileSync(new URL('../utils/device-catalog.json', import.meta.url));
  assert.equal(current.toString(), readFileSync(new URL('../utils/device-catalog-archive/android-catalog-2026-10-v2.json', import.meta.url), 'utf8'));
  assert.equal(catalog.DEVICE_CATALOG.version, 'android-catalog-2026-10-v2');
  assert.equal(catalog.DEVICE_CATALOG.templates.length, 10);
  assert.deepEqual(catalog.DEFAULT_WEIGHTS, {redmi_note13_4g_android14:220,redmi_note12_android14:170,a54_android14:160,a15_android14:130,poco_x6_pro_android14:90,s23_android14:85,realme_11_pro_android14:75,a52_android12:35,s23_android13:25,pixel7_android13:10});
  for (const t of catalog.DEVICE_CATALOG.templates) {
    assert.equal(t.revision, fixture.some(f => f.profileId === t.id) ? 2 : 1);
    assert.ok(t.webglLimits);
    const p = fp.localPassport({}, {templateId:t.id});
    assert.deepEqual(p.fingerprint.webglLimits, t.webglLimits);
    p.fingerprint.webglLimits.maxTextureSize /= 2;
    assert.ok(passportValidation(p).errors.includes('device_template_webgl_limits'));
  }
  const invalid = structuredClone(catalog.DEVICE_CATALOG);
  delete invalid.templates[0].webglLimits;
  assert.equal(catalog.catalogSchema.safeParse(invalid).success, false);
});

test('saved v1 passports validate without identity, distribution or WebGL changes', () => {
  for (const f of fixture) {
    const before = JSON.stringify(f.passport);
    assert.equal(passportValidation(f.passport).status, 'passed');
    // This archived fixture predates identityHashVersion=4. Its stored
    // legacy hash must still validate through the compatibility contract.
    assert.equal(fp.legacyIdentityHash(f.profileId, f.passport), f.identityHash);
    assert.equal(fp.matchesIdentityHash(f.profileId, f.passport, f.identityHash), true);
    assert.equal(JSON.stringify(f.passport), before);
    assert.equal(f.passport.fingerprint.webglLimits, undefined);
  }
});

test('legacy custom weights remain readable, without silently activating new models', () => {
  const old = {s23_android13:3,pixel7_android13:2,a52_android12:2,s23_android14:1};
  const expanded = catalog.resolveWeights(old);
  assert.equal(Object.keys(expanded).length, 10);
  for (const [id, weight] of Object.entries(expanded)) assert.equal(weight, old[id] ?? 0);
  assert.equal(passportValidation(fp.localPassport({fingerprintDeviceWeights:old})).status, 'passed');
  assert.throws(() => catalog.resolveWeights({...old,unknown:1}));
  assert.deepEqual(catalog.resolveWeights({}), catalog.DEFAULT_WEIGHTS);
});

test('WebGL limits apply in WebGL 1/2 and frames, preserve types and native errors', async () => {
  const {chromium} = await import('playwright');
  const {createMobileContext, createMobilePage} = await import('../worker/profiles.mjs');
  const browser = await chromium.launch({headless:true,executablePath:process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH});
  const observe = () => ['webgl','webgl2'].map(type => {
    const gl = document.createElement('canvas').getContext(type);
    const view = gl.getParameter(gl.MAX_VIEWPORT_DIMS); view[0] = 1;
    let receiverThrows = false;
    try { gl.getParameter.call({}, gl.MAX_TEXTURE_SIZE); } catch { receiverThrows = true; }
    const invalid = gl.getParameter(0xffffffff), error = gl.getError();
    return {texture:gl.getParameter(gl.MAX_TEXTURE_SIZE),buffer:gl.getParameter(gl.MAX_RENDERBUFFER_SIZE),cube:gl.getParameter(gl.MAX_CUBE_MAP_TEXTURE_SIZE),viewport:Array.from(gl.getParameter(gl.MAX_VIEWPORT_DIMS)),typed:gl.getParameter(gl.MAX_VIEWPORT_DIMS) instanceof Int32Array,receiverThrows,invalid,error};
  });
  try {
    for (const id of ['a54_android14','s23_android14']) {
      const passport = fp.localPassport({}, {templateId:id}), profile = fp.profileFromPassport(id,passport);
      const context = await createMobileContext(browser, profile);
      try {
        await context.route('https://gpu-test.invalid/**', route => route.fulfill({contentType:'text/html',body:'<!doctype html><iframe src="https://gpu-frame.invalid/"></iframe>'}));
        await context.route('https://gpu-frame.invalid/**', route => route.fulfill({contentType:'text/html',body:'<!doctype html><p>Frame</p>'}));
        const page = await createMobilePage(context,profile); await page.goto('https://gpu-test.invalid/');
        for (const frame of page.frames()) for (const result of await frame.evaluate(observe)) {
          const size = passport.fingerprint.webglLimits.maxTextureSize;
          assert.deepEqual(result,{texture:size,buffer:size,cube:size,viewport:[size,size],typed:true,receiverThrows:true,invalid:null,error:1280});
        }
      } finally { await context.close(); }
    }
  } finally { await browser.close(); }
});
