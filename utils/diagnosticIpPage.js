function diagnosticIpPage(summary, limit = 25) {
  if (!Number.isInteger(limit) || limit < 25 || limit > 5000 || limit % 25 !== 0) throw new RangeError('invalid_ip_limit');
  const timestamp = value => Number.isFinite(Date.parse(value)) ? Date.parse(value) : -Infinity;
  const ips = [...summary.stats.ips].sort((a, b) => {
    const left = timestamp(a.latestAt), right = timestamp(b.latestAt);
    return (left === right ? 0 : right - left) || a.ip.localeCompare(b.ip);
  });
  return { ...summary, stats: { ...summary.stats, ips: ips.slice(0, limit) }, ipPage: { limit, total: ips.length, hasMore: ips.length > limit } };
}
function diagnosticRecentPage(summary, limit = 25) {
  if (!Number.isInteger(limit) || limit < 25 || limit > 5000 || limit % 25 !== 0) throw new RangeError('invalid_recent_limit');
  return { ...summary, recent: summary.recent.slice(0, limit), recentPage: { limit, total: summary.recent.length, hasMore: summary.recent.length > limit } };
}
module.exports = { diagnosticIpPage, diagnosticRecentPage };
