const { createHash } = require('node:crypto');
const proxyKey = proxy => proxy.channel?.trim()
 ? `proxy:${proxy.channel.trim().toLowerCase()}`
 : `proxy:endpoint:${proxy.host.trim().toLowerCase()}:${proxy.port}`;
const proxyKeys = proxy => [...new Set([proxyKey(proxy), ...(proxy.rotationUrl ? [`rotation:${createHash('sha256').update(proxy.rotationUrl).digest('hex')}`] : []), ...(proxy.tcpChannelId ? [`tcp:${proxy.tcpChannelId}`] : [])])];
function channelMembers(proxies, proxy) {
 const keys = new Set(proxyKeys(proxy)); const members = new Map([[proxy.id, proxy]]); let changed = true;
 while (changed) { changed = false; for (const item of proxies) if (!members.has(item.id) && proxyKeys(item).some(key => keys.has(key))) { members.set(item.id, item); for (const key of proxyKeys(item)) keys.add(key); changed = true; } }
 return [...members.values()];
}
// Reserve every known alias, including aliases whose rotation URL was edited
// after an older session acquired its original set of keys.
const channelKeys = (proxies, proxy) => [...new Set(channelMembers(proxies, proxy).flatMap(proxyKeys))];
module.exports = { proxyKey, proxyKeys, channelMembers, channelKeys };
