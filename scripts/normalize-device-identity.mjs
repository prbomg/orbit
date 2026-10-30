import { PrismaClient } from '@prisma/client';
import { pathToFileURL } from 'node:url';
import fp from '../utils/fingerprint.js';

// No schema migration or session regeneration. Only separate battery snapshots
// from passports and consistently hash the existing permanent browser parameters.
export async function normalizeDeviceIdentities(prisma, { apply = false } = {}) {
  const rows = await prisma.profile.findMany({ select: { id: true, fingerprint: true, fingerprintHash: true, fingerprintCheck: true, fingerprintState: true } });
  const updates = [];
  for (const row of rows) {
    if (!row.fingerprint?.fingerprint) continue;
    const passport = fp.devicePassport(row.fingerprint);
    const hash = fp.identityHash(row.id, passport);
    const data = {};
    if (JSON.stringify(passport) !== JSON.stringify(row.fingerprint)) data.fingerprint = passport;
    if (hash !== row.fingerprintHash) data.fingerprintHash = hash;
    const check = row.fingerprintCheck;
    if (check?.checks && Object.hasOwn(check.checks, 'battery')) {
      const { battery: _battery, ...checks } = check.checks;
      const status = Object.keys(checks).length > 0 && Object.values(checks).every(value => value === true) ? 'passed' : 'failed';
      data.fingerprintCheck = { ...check, version: 2, checks, status,
        warnings: (check.warnings || []).filter(value => value !== 'Battery API недоступен'),
        dynamic: { battery: { mode: 'simulated', observedAt: check.checkedAt, supported: Boolean(check.observed?.battery), ...check.observed?.battery } } };
      data.fingerprintState = status === 'passed' ? 'verified' : 'failed';
    }
    if (Object.keys(data).length) updates.push({ id: row.id, data });
  }
  if (apply && updates.length) await prisma.$transaction(async tx => {
    for (const update of updates) await tx.profile.update({ where: { id: update.id }, data: update.data });
  }, { timeout: 30000 });
  return { inspected: rows.length, updated: updates.length, applied: apply };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const prisma = new PrismaClient();
  try { console.log(JSON.stringify(await normalizeDeviceIdentities(prisma, { apply: process.argv.includes('--apply') }))); }
  finally { await prisma.$disconnect(); }
}
