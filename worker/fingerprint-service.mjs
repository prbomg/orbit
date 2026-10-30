import {passportValidation,proxyBindingKey} from './passport-validation.mjs';
import { sqliteWrite } from './sqlite-write.mjs';
import fp from '../utils/fingerprint.js';
import { mobileProxyFingerprint } from './fingerprint-provider.mjs';
import { ProfileError } from './profiles.mjs';
export async function ensurePassport({ prisma, profileId, proxy, existing, signal, provider = mobileProxyFingerprint }) {
  const row = await prisma.profile.findUniqueOrThrow({ where: { id: profileId } });
  let passport = row.fingerprint ? fp.devicePassport(row.fingerprint) : null;
  // Adopt existing browser identity as-is; never regenerate a saved profile.
  if (existing) {
    if (!passport) {
      passport = { version: 1, source: 'legacy', requestedSource: 'legacy', resolved: true, seed: String(existing.canvasSeed), createdAt: existing.createdAt, timezone: existing.passport?.timezone || null, fingerprint: fp.deviceFingerprint(existing.fingerprint), headers: existing.headers, canvasSeed: existing.canvasSeed, limitations: ['Сохранён прежний отпечаток. Изменение источника применяется только к новым профилям.'] };
    }
    passport = { ...passport, identityHashVersion: fp.CURRENT_IDENTITY_HASH_VERSION, validation: passportValidation(passport) };
    if (passport.validation.status === 'failed') throw new ProfileError('passport_invalid');
    await sqliteWrite(prisma, tx => tx.profile.update({ where: { id: profileId }, data: { fingerprint: passport, fingerprintHash: fp.identityHash(profileId, passport) } }));
    return passport;
  }
  const settings = await prisma.settings.findUnique({ where: { id: 1 } });
  if (!passport) {
    passport = fp.localPassport(settings || {});
    await sqliteWrite(prisma, tx => tx.profile.update({ where: { id: profileId }, data: { fingerprint: passport, fingerprintHash: fp.identityHash(profileId, passport) } }));
  }
  if (!passport.resolved) {
    if (passport.requestedSource === 'local') passport = { ...passport, resolved: true };
    else {
      const token = settings?.mobileProxyApiKey || process.env.MOBILEPROXY_API_KEY || '';
      const bindingKey = proxyBindingKey(proxy,token);
      const storedProxy = proxy.id ? await prisma.proxy.findUnique({ where: { id: proxy.id }, select: { fingerprintBinding: true } }) : null;
      const binding = storedProxy?.fingerprintBinding;
      const cooldown = await prisma.workflowLease.findUnique({ where: { key: 'fingerprint-provider-cooldown' } });
      try {
        if (binding?.key === bindingKey && binding.status === 'not_found' && Date.parse(binding.validUntil) > Date.now()) { const e = new Error(); e.code = 'mobileproxy_proxy_not_found'; throw e; }
        if (cooldown && cooldown.expiresAt > new Date()) { const e = new Error(); e.code = 'mobileproxy_cooldown'; throw e; }
        passport = await provider({ passport, proxy, token, signal });
        if (storedProxy) await sqliteWrite(prisma, tx => tx.proxy.update({ where: { id: proxy.id }, data: { fingerprintBinding: { key: bindingKey, status: 'matched', providerProxyId: passport.providerProxyId || null, checkedAt: new Date().toISOString() } } }));
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        const reason = typeof error.code === 'string' && /^[a-z0-9_]{1,80}$/.test(error.code) ? error.code : 'mobileproxy_unavailable';
        if (reason === 'mobileproxy_proxy_not_found' && storedProxy && !(binding?.key === bindingKey && binding.status === 'not_found' && Date.parse(binding.validUntil) > Date.now())) await sqliteWrite(prisma, tx => tx.proxy.update({ where: { id: proxy.id }, data: { fingerprintBinding: { key: bindingKey, status: 'not_found', checkedAt: new Date().toISOString(), validUntil: new Date(Date.now() + 30 * 60000).toISOString() } } }));
        if (!['mobileproxy_cooldown', 'mobileproxy_proxy_not_found'].includes(reason)) await sqliteWrite(prisma, tx => tx.workflowLease.upsert({ where: { key: 'fingerprint-provider-cooldown' }, create: { key: 'fingerprint-provider-cooldown', owner: 'fingerprint-provider', expiresAt: new Date(Math.max(Date.now() + Math.max(60000, error.retryDelayMs || 0), cooldown?.expiresAt?.getTime() || 0)) }, update: { expiresAt: new Date(Math.max(Date.now() + Math.max(60000, error.retryDelayMs || 0), cooldown?.expiresAt?.getTime() || 0)) } }));
        if (passport.requestedSource === 'mobileproxy') throw new ProfileError(reason);
        passport = { ...passport, resolved: true, fallbackReason: reason };
      }
    }
  }
  passport = { ...passport, identityHashVersion: fp.CURRENT_IDENTITY_HASH_VERSION, validation: passportValidation(passport) };
  if (passport.validation.status === 'failed') throw new ProfileError('passport_invalid');
  // Binding happens before browser activity, so failed warmups retry the same identity.
  await sqliteWrite(prisma, tx => tx.profile.update({ where: { id: profileId }, data: { fingerprint: passport, fingerprintHash: fp.identityHash(profileId, passport) } }));
  return passport;
}
