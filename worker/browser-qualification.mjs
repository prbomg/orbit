import { qualificationContext, controlTemplates } from './qualification-context.mjs';
import fp from '../utils/fingerprint.js';
import { createMobileContext, createMobilePage, ProfileError } from './profiles.mjs';
import { inspectFingerprint } from './fingerprint-check.mjs';
import { setTimeout as pause } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { readRuntimeBrands } from './runtime-metadata.mjs';
import { readNativeBaseline, inspectNativeCpuOverride } from './native-baseline.mjs';
import { unmeasuredTransport } from './network-transport.mjs';
import { sqliteWrite } from './sqlite-write.mjs';

// Never transfer full fingerprintCheck reports for this lookup: a large pool
// can exceed Node's single-string limit in Prisma's native response. SQLite
// extracts the small version field and returns only IDs; updates stay bounded.
export async function invalidateOutdatedBrowserProfiles(tx, runtimeVersion) {
  const rows = await tx.$queryRaw`
    SELECT "id" FROM "Profile"
    WHERE "status" = 'ready' AND "deletedAt" IS NULL
      AND json_extract("fingerprintCheck", '$.runtimeVersion') IS NOT NULL
      AND json_extract("fingerprintCheck", '$.runtimeVersion') NOT IN ('', 0)
      AND json_extract("fingerprintCheck", '$.runtimeVersion') <> ${runtimeVersion}
  `;
  let count = 0;
  for (let offset = 0; offset < rows.length; offset += 500) {
    const ids = rows.slice(offset, offset + 500).map(row => row.id);
    const result = await tx.profile.updateMany({ where: { id: { in: ids }, status: 'ready' },
      data: { status: 'needs_check', readinessVerifiedAt: null, readinessValidUntil: null } });
    count += result.count;
  }
  return count;
}

// Database lease coordinates workers; a browser update is approved only by explicit
// catalog control devices, never by visiting external sites or changing user state.
export async function qualifyBrowser({ prisma, browser, signal }) {
  const runtimeVersion = browser.version(), owner = randomUUID();
  const qualification = qualificationContext(runtimeVersion);
  const templates = controlTemplates();
  let previous;
  for (;;) {
    signal?.throwIfAborted();
    const current = await prisma.browserQualification.findUnique({ where: { runtimeVersion } });
    if (current?.status === 'passed' && current.report?.qualification?.key === qualification.key) return current;
    if (current?.status === 'failed' && current.report?.qualification?.key === qualification.key) throw new ProfileError('browser_qualification_failed');
    const claimed = await sqliteWrite(prisma, async tx => {
      await tx.$executeRaw`UPDATE "Settings" SET "id"="id" WHERE "id"=1`;
      const row = await tx.browserQualification.findUnique({ where: { runtimeVersion } });
      if (row && (row.status === 'running' ? Date.now() - row.checkedAt.getTime() < 120_000 : row.report?.qualification?.key === qualification.key)) return false;
      previous = row?.status === 'passed' ? row : await tx.browserQualification.findFirst({ where: { status: 'passed', runtimeVersion: { not: runtimeVersion } }, orderBy: { checkedAt: 'desc' } });
      await tx.browserQualification.upsert({ where: { runtimeVersion }, create: { runtimeVersion, status: 'running', report: { owner, qualification } }, update: { status: 'running', checkedAt: new Date(), report: { owner, qualification } } });
      return true;
    });
    if (claimed) break;
    await pause(500, undefined, { signal });
  }
  const pilots = [];
  try {
    const runtimeBrands=await readRuntimeBrands(browser);
    const nativeBaseline = await readNativeBaseline(browser);
    const nativeCpuOverride = await inspectNativeCpuOverride(browser);
    for (let i = 0; i < templates.length; i++) {
      signal?.throwIfAborted();
      const template = templates[i];
      const old = previous?.report?.pilots?.find(p => p.templateId === template.id);
      const passport = fp.localPassport({ fingerprintMode: 'local' }, { templateId: template.id, seed: '00000000000000000000000000000001',runtimeVersion,...runtimeBrands });
      const profile = fp.profileFromPassport(`control-${i}`, passport);
      let first, result;
      for (let repeat = 0; repeat < 2; repeat++) {
        const context = await createMobileContext(browser, profile);
        try { const page = await createMobilePage(context, profile); result = await inspectFingerprint(page, profile, first, runtimeVersion); first ||= result; }
        finally { await context.close(); }
        if (result.status !== 'passed') break;
      }
      pilots.push({ templateId: template.id, revision: template.revision, index: i + 1, passport, report: result, changes: old ? { canvas: old.report.canvasHash !== result.canvasHash, audio: old.report.audioHash !== result.audioHash } : null });
    }
    const status = pilots.length === templates.length && pilots.every(p => p.report.status === 'passed') ? 'passed' : 'failed';
    const contextMatrix = { enforcement: 'diagnostic', status: pilots.every(p => p.report.contextMatrix?.status === 'passed') ? 'passed' : 'failed',
      mismatches: pilots.reduce((sum, p) => sum + (p.report.contextMatrix?.summary.mismatches || 0), 0),
      errors: pilots.reduce((sum, p) => sum + (p.report.contextMatrix?.summary.errors || 0), 0) };
    const apiBehavior = { enforcement: 'diagnostic', baselineStatus: nativeBaseline.status, baselineScope: nativeBaseline.scope,
      differences: pilots.reduce((sum, p) => sum + (p.report.contextMatrix?.apiBehavior?.differences || 0), 0),
      incomplete: pilots.some(p => p.report.contextMatrix?.apiBehavior?.status === 'incomplete') };
    const report = { qualification, networkTransport:unmeasuredTransport('offline_browser_qualification'), ...runtimeBrands, contextMatrix, apiBehavior, nativeBaseline, nativeCpuOverride, previousVersion: previous?.runtimeVersion || null, pilots, reason: status === 'failed' ? 'control_device_mismatch' : null };
    await sqliteWrite(prisma, async tx => {
      const row = await tx.browserQualification.findUnique({ where: { runtimeVersion } });
      if (row?.report?.owner !== owner) throw new ProfileError('browser_qualification_lease_lost');
      await tx.browserQualification.update({ where: { runtimeVersion }, data: { status, checkedAt: new Date(), report } });
      if (status === 'passed') {
        await invalidateOutdatedBrowserProfiles(tx, runtimeVersion);
      }
    });
    if (status !== 'passed') throw new ProfileError('browser_qualification_failed');
    return { runtimeVersion, status, report };
  } catch (error) {
    // Unexpected launch/transport errors release the lease for a later attempt;
    // measured mismatches stay blocked with their complete diagnostic report.
    await sqliteWrite(prisma, async tx => {
      const row = await tx.browserQualification.findUnique({ where: { runtimeVersion } });
      if (row?.status === 'running' && row.report?.owner === owner) await tx.browserQualification.delete({ where: { runtimeVersion } });
    }).catch(() => {});
    throw error;
  }
}
