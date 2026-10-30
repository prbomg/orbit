import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import fp from '../utils/fingerprint.js';
import { createMobileContext, createMobilePage } from '../worker/profiles.mjs';
import { verifyFingerprint } from '../worker/fingerprint-check.mjs';
import { qualifyBrowser } from '../worker/browser-qualification.mjs';
import { controlTemplates } from '../worker/qualification-context.mjs';
import { poolFixture } from './helpers/pool-fixture.mjs';
process.env.WORKER_PROFILES_DIR = '';
const launch = () => chromium.launch({ headless: true, executablePath: process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH });
function passport(browser) { const p = fp.localPassport(); const n = p.fingerprint.navigator; fp.chromeMetadata(p.fingerprint,p.headers,browser.version(),n.userAgentData.model,n.userAgentData.platformVersion); return p; }
test('first request and first script match in all document types; failed retries retain successful baseline', async () => {
  const f = await poolFixture(), browser = await launch();
  try {
    const row = await f.db.profile.create({ data: { name: 'Quality' } }), profile = fp.profileFromPassport(row.id,passport(browser));
    // Deterministic regression: legacy samples may disagree on HTTP/browser brands.
    profile.headers['sec-ch-ua'] = '"Brave";v="1"';
    const context = await createMobileContext(browser,profile);
    try {
      const page = await createMobilePage(context,profile), result = await verifyFingerprint({ prisma:f.db,page,profile,runtimeVersion:browser.version() });
      assert.equal(result.firstDocuments.records.length,5);
      assert.ok(result.warnings.some(w=>w.includes('HTTP Client Hints')));
      assert.ok(result.firstDocuments.records.every(r=>r.status==='passed'));
      assert.ok(result.observed.clientHints.model);
      assert.equal(result.observed.codecs.length,4);
      assert.equal(typeof result.observed.api.MediaSource,'boolean');
      const baseline = await f.db.fingerprintMeasurement.findFirst();
      await f.db.fingerprintMeasurement.update({ where:{id:baseline.id},data:{ report:{...baseline.report,canvasHash:'unexpected-baseline'} } });
      for (let i=0;i<2;i++) {
        await assert.rejects(verifyFingerprint({prisma:f.db,page,profile,runtimeVersion:browser.version()}), e=>e.code==='fingerprint_verification_failed');
        const saved = await f.db.profile.findUnique({where:{id:row.id}});
        assert.equal(saved.fingerprintCheck.checks.canvasStable,false);
      }
      assert.equal(await f.db.fingerprintMeasurement.count({where:{profileId:row.id}}),3);
    } finally { await context.close(); }
  } finally { await browser.close(); await f.cleanup(); }
});
test('new Chromium qualifies catalog control devices, invalidates old readiness, and caches its approval', async () => {
  const f = await poolFixture(), browser = await launch();
  try {
    const ready = await f.ready();
    await f.db.profile.update({where:{id:ready.id},data:{ fingerprintCheck:{status:'passed',runtimeVersion:'152.0.0.0'} }});
    await f.db.browserQualification.create({data:{ runtimeVersion:'152.0.0.0',status:'passed',report:{pilots:controlTemplates().map(t=>({templateId:t.id,passport:passport(browser),report:{canvasHash:'old',audioHash:'old'}}))} }});
    const result = await qualifyBrowser({prisma:f.db,browser});
    assert.equal(result.status,'passed'); assert.equal(result.report.pilots.length,controlTemplates().length);
    assert.ok(result.report.pilots.every(p=>p.report.status==='passed' && p.changes.canvas && p.changes.audio));
    const row = await f.db.profile.findUnique({where:{id:ready.id}});
    assert.equal(row.status,'needs_check');assert.equal(row.readinessValidUntil,null);
    const cached = await qualifyBrowser({prisma:f.db,browser});
    assert.equal(cached.status,'passed');assert.equal(await f.db.browserQualification.count(),2);
    await f.db.browserQualification.update({where:{runtimeVersion:browser.version()},data:{status:'failed'}});
    await assert.rejects(qualifyBrowser({prisma:f.db,browser}),e=>e.code==='browser_qualification_failed');
  } finally { await browser.close(); await f.cleanup(); }
});
