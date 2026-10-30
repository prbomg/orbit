import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { chromium } from 'playwright-extra';
// Register exactly the same browser plugins as production, without running jobs.
import '../worker/runner.mjs';
import { loadConfig } from '../worker/config.mjs';
import { readRuntimeBrands } from '../worker/runtime-metadata.mjs';
import { createMobileContext, createMobilePage } from '../worker/profiles.mjs';
import { inspectFingerprint } from '../worker/fingerprint-check.mjs';
import { controlTemplates, qualificationContext } from '../worker/qualification-context.mjs';
import fp from '../utils/fingerprint.js';

const output = process.argv[2];
if (!output) throw Error('Usage: node scripts/verify-server-contexts.mjs /path/to/report.json');
const config = loadConfig();
const browser = await chromium.launch({ executablePath: config.chromiumExecutablePath,
  headless: config.headless, timeout: config.navigationTimeoutMs, args: ['--proxy-bypass-list=<-loopback>'] });
const report = { version: 1, checkedAt: new Date().toISOString(), runtimeVersion: browser.version(),
  qualification: qualificationContext(browser.version()), productionBrowserPlugins: true,
  enforcement: 'diagnostic', controlsOnly: true, pilots: [] };
try {
  const brands = await readRuntimeBrands(browser);
  for (const template of controlTemplates()) {
    const passport = fp.localPassport({ fingerprintMode: 'local' }, {
      templateId: template.id, seed: '00000000000000000000000000000001', runtimeVersion: browser.version(), ...brands });
    const profile = fp.profileFromPassport(`server-control-${template.id}`, passport);
    const runs = [];
    for (let repeat = 0; repeat < 2; repeat++) {
      const context = await createMobileContext(browser, profile);
      try { runs.push(await inspectFingerprint(await createMobilePage(context, profile), profile, runs[0], browser.version())); }
      finally { await context.close(); }
    }
    report.pilots.push({ templateId: template.id, revision: template.revision, runs });
    console.log(JSON.stringify({ templateId: template.id, runs: runs.map(r => ({ status: r.status, matrix: r.contextMatrix.summary,
      canvasStable: r.checks.canvasStable ?? null, audioStable: r.checks.audioStable ?? null })) }));
  }
  report.summary = { models: report.pilots.length, runs: report.pilots.reduce((n, p) => n + p.runs.length, 0),
    profileChecksPassed: report.pilots.every(p => p.runs.every(r => r.status === 'passed')),
    matrixPassed: report.pilots.every(p => p.runs.every(r => r.contextMatrix.status === 'passed')),
    measurementErrors: report.pilots.reduce((n, p) => n + p.runs.reduce((sum, r) => sum + r.contextMatrix.summary.errors, 0), 0) };
} finally {
  await browser.close();
  const filename = resolve(output); await mkdir(dirname(filename), { recursive: true });
  await writeFile(filename, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}
console.log(JSON.stringify({ summary: report.summary, output: resolve(output) }));
if (!report.summary?.profileChecksPassed || !report.summary.matrixPassed || report.summary.measurementErrors) process.exitCode = 1;
