import { chromium as vanilla } from 'playwright';
import { chromium as production } from 'playwright-extra';
// Match production's plugin registration; importing this module runs no jobs.
import '../worker/runner.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import fp from '../utils/fingerprint.js';
import { readNativeBaseline, inspectNativeCpuOverride } from '../worker/native-baseline.mjs';
import { readRuntimeBrands } from '../worker/runtime-metadata.mjs';
import { createMobileContext, createMobilePage } from '../worker/profiles.mjs';
import { inspectFingerprint } from '../worker/fingerprint-check.mjs';
import { controlTemplates, qualificationContext } from '../worker/qualification-context.mjs';

if (process.argv.length !== 3) throw Error('Usage: node scripts/verify-profile-runtime.mjs /path/to/report.json');
const output = resolve(process.argv[2]);
const options = { headless: process.env.WORKER_HEADLESS !== '0',
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH,
  args: ['--proxy-bypass-list=<-loopback>'] };
const report = { version: 1, checkedAt: new Date().toISOString(), controlsOnly: true, enforcement: 'diagnostic', pilots: [] };
let baselineBrowser, browser;
try {
  baselineBrowser = await vanilla.launch(options);
  browser = await production.launch(options);
  if (baselineBrowser.version() !== browser.version()) throw Error('baseline_runtime_version_mismatch');
  report.runtimeVersion = browser.version();
  report.qualification = qualificationContext(browser.version());
  const nativeBaseline = { ...await readNativeBaseline(baselineBrowser), scope: 'vanilla-playwright-same-executable-and-launch-options' };
  report.nativeBaseline = nativeBaseline;
  report.nativeCpuOverride = await inspectNativeCpuOverride(baselineBrowser);
  const brands = await readRuntimeBrands(baselineBrowser);
  for (const template of controlTemplates()) {
    const passport = fp.localPassport({ fingerprintMode: 'local' }, { templateId: template.id,
      seed: '00000000000000000000000000000001', runtimeVersion: browser.version(), ...brands });
    const profile = fp.profileFromPassport(`runtime-control-${template.id}`, passport), runs = [];
    for (let repeat = 0; repeat < 2; repeat++) {
      const context = await createMobileContext(browser, profile);
      try { runs.push(await inspectFingerprint(await createMobilePage(context, profile), profile, runs[0], browser.version(), { nativeBaseline })); }
      finally { await context.close(); }
    }
    report.pilots.push({ templateId: template.id, runs });
    console.log(JSON.stringify({ templateId: template.id, runs: runs.map(r => ({ status: r.status, identity: r.contextMatrix.summary, apiBehavior: r.contextMatrix.apiBehavior })) }));
  }
  const runs = report.pilots.flatMap(p => p.runs);
  report.summary = { models: report.pilots.length, runs: runs.length,
    profileChecksPassed: runs.every(r => r.status === 'passed'),
    identityMismatches: runs.reduce((n, r) => n + r.contextMatrix.summary.mismatches, 0),
    measurementErrors: runs.reduce((n, r) => n + r.contextMatrix.apiBehavior.errors, 0),
    behaviorDifferences: runs.reduce((n, r) => n + r.contextMatrix.apiBehavior.differences, 0),
    baselinePassed: nativeBaseline.status === 'passed',
    nativeBehaviorConfirmed: runs.every(r => r.contextMatrix.apiBehavior.status === 'matched') };
} catch (error) {
  report.error = error.message === 'baseline_runtime_version_mismatch' ? error.message : 'runtime_audit_failed';
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  await baselineBrowser?.close().catch(() => {});
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
}
console.log(JSON.stringify({ summary: report.summary || null, error: report.error || null, output }));
// Observable differences are findings, not broken execution. Errors and passport
// mismatches fail the audit; the JSON explicitly reports nativeBehaviorConfirmed.
if (!report.summary?.profileChecksPassed || !report.summary?.baselinePassed || report.summary?.identityMismatches || report.summary?.measurementErrors) process.exitCode = 1;
