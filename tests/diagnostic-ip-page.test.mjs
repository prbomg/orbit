import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnosticIpPage, diagnosticRecentPage } from '../utils/diagnosticIpPage.js';
const ips = Array.from({ length: 60 }, (_, index) => ({ ip: `198.51.100.${index + 1}`, latestAt: new Date(Date.UTC(2026, 9, 20, 0, index)).toISOString(), total: 60 - index }));
const summary = { stats: { ips, counts: { failed: 7 } }, checkedAt: 'fixture' };

test('IP first page contains 25 latest measurements rather than the most frequent addresses', () => {
  const result = diagnosticIpPage(summary);
  assert.equal(result.stats.ips.length, 25);
  assert.equal(result.stats.ips[0].ip, '198.51.100.60');
  assert.deepEqual(result.ipPage, { total: 60, limit: 25, hasMore: true });
  assert.equal(result.stats.counts.failed, 7);
  assert.equal(summary.stats.ips, ips);
  assert.equal(summary.stats.ips[0].ip, '198.51.100.1');
});
test('loading further batches replaces a stable prefix without duplicate IPs', () => {
  const first = diagnosticIpPage(summary), second = diagnosticIpPage(summary, 50), last = diagnosticIpPage(summary, 75);
  assert.deepEqual(second.stats.ips.slice(0, 25), first.stats.ips);
  assert.equal(new Set(second.stats.ips.map(item => item.ip)).size, 50);
  assert.equal(last.stats.ips.length, 60);
  assert.equal(last.ipPage.hasMore, false);
});
test('missing timestamps sort last, equal dates are deterministic and empty lists are final', () => {
  const result = diagnosticIpPage({ stats: { ips: [{ ip: 'z', latestAt: null }, { ip: 'b', latestAt: 'bad' }, { ip: 'c', latestAt: '2026-10-01' }, { ip: 'a', latestAt: '2026-10-01' }] } });
  assert.deepEqual(result.stats.ips.map(item => item.ip), ['a', 'c', 'b', 'z']);
  assert.deepEqual(diagnosticIpPage({ stats: { ips: [] } }).ipPage, { limit: 25, total: 0, hasMore: false });
});
test('IP limits must be bounded batches of 25', () => {
  for (const limit of [0, -25, 1, 26, 25.5, 5025, Infinity, NaN, '25']) assert.throws(() => diagnosticIpPage(summary, limit), /invalid_ip_limit/);
});

test('error pages are independent from IP pages and preserve newest-first order beyond the old 30-row cap', () => {
  const recent = Array.from({ length: 55 }, (_, index) => ({ id: `error-${index}`, startedAt: new Date(Date.UTC(2026, 9, 20, 0, 55 - index)).toISOString() }));
  const source = { ...summary, recent };
  const first = diagnosticRecentPage(diagnosticIpPage(source));
  assert.equal(first.recent.length, 25); assert.equal(first.stats.ips.length, 25);
  assert.deepEqual(first.recentPage, { limit: 25, total: 55, hasMore: true });
  const second = diagnosticRecentPage(diagnosticIpPage(source), 50);
  assert.deepEqual(second.recent.slice(0, 25), first.recent);
  assert.equal(second.recent.length, 50); assert.equal(second.stats.ips.length, 25);
  const last = diagnosticRecentPage(diagnosticIpPage(source, 50), 75);
  assert.equal(last.recent.length, 55); assert.equal(last.recentPage.hasMore, false);
  assert.equal(last.stats.ips.length, 50); assert.equal(source.recent.length, 55);
  assert.deepEqual(diagnosticRecentPage({ recent: [] }).recentPage, { limit: 25, total: 0, hasMore: false });
  for (const limit of [0, 26, 5025, Infinity, '25']) assert.throws(() => diagnosticRecentPage(source, limit), /invalid_recent_limit/);
});
