import { withAuth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { json, apiError } from "@/lib/api";
import { resolveDonorSites } from "@/utils/donorSites";
export const dynamic = 'force-dynamic';
export const GET = withAuth(async () => {
  try {
    const [settings, events, health, rateLimits] = await Promise.all([
      prisma.settings.findUnique({ where: { id: 1 }, select: { warmupSites: true, warmupSitePauses: true, updatedAt: true } }),
      prisma.profileWarmupEvent.findMany({ where: { event: { in: ['warmup_site_completed','warmup_site_skipped'] }, createdAt: { gte: new Date(Date.now()-86400000) } }, orderBy: { id: 'desc' }, take: 5000, select: { event: true, proxyLabel: true, createdAt: true, details: true } }),
      prisma.warmupSiteHealth.findMany(),
      prisma.workflowLease.findMany({ where: { key: { startsWith: 'donor:rate:' }, expiresAt: { gt: new Date() } } }),
    ]);
    const pauses = (settings?.warmupSitePauses ?? []) as { domain: string; until: string }[];
    const items = resolveDonorSites(settings).map(url => {
      const domain = new URL(url).hostname, rows = events.filter(e => (e.details as {domain?: string}).domain === domain);
      const success = rows.filter(e => e.event === 'warmup_site_completed'), failure = rows.filter(e => e.event === 'warmup_site_skipped');
      const legacyChannels = [...new Set(rows.map(e => e.proxyLabel))].map(proxy => { const last = rows.find(e => e.proxyLabel === proxy)!; return { proxy, lastAt: last.createdAt, status: last.event === 'warmup_site_completed' ? 'success':'failure', cooldownUntil: last.event === 'warmup_site_skipped' ? new Date(last.createdAt.getTime()+900000) : null }; });
      const measured = health.filter(row => row.domain === domain.replace(/^www\./,''));
      const channels = measured.length ? measured.map(row => ({ proxy: row.channelLabel, channel: row.channel, lastAt: row.lastAttemptAt, status: row.lastReason ? 'failure' : 'success', cooldownUntil: row.cooldownUntil, consecutiveFailures: row.consecutiveFailures, lastStatus: row.lastStatus, lastReason: row.lastReason, success: row.success, failure: row.failure })) : legacyChannels;
      return { rateLimitedUntil: rateLimits.find(row => row.key === `donor:rate:${domain.replace(/^www\./,'')}`)?.expiresAt ?? null, url, domain, success: success.length, failure: failure.length, lastSuccessAt: success[0]?.createdAt ?? null, lastFailureAt: failure[0]?.createdAt ?? null, lastReason: (failure[0]?.details as {reason?: string})?.reason ?? null, durationMs: (success[0]?.details as {durationMs?: number})?.durationMs ?? null, pausedUntil: pauses.find(p => p.domain === domain && Date.parse(p.until)>Date.now())?.until ?? null, channels };
    });
    return json({ items, pauses, updatedAt: settings?.updatedAt, sampledEvents: events.length, truncated: events.length === 5000 });
  } catch(e) { return apiError(e); }
});
