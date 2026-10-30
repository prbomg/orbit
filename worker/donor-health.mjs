import {createHash,randomUUID} from 'node:crypto';
import channels from '../utils/proxyChannel.js';
import {sqliteWrite} from './sqlite-write.mjs';
import {retryAfterMs} from './http-retry.mjs';
const releasedReservations = new WeakSet();
const keyHash = value => createHash('sha256').update(value).digest('hex');
const host = value => new URL(value).hostname.replace(/^www\./,'');
export function donorChannel(proxy) {return keyHash(channels.proxyKeys(proxy).sort().join('|'));}
// Leases coordinate processes, including aliases of the same channel.
export async function reserveDonor(prisma, proxy, url, now = new Date()) {
 const domain=host(url),channel=donorChannel(proxy),resources=channels.proxyKeys(proxy).map(keyHash),owner=randomUUID();
 return sqliteWrite(prisma,async tx=>{
  await tx.workflowLease.deleteMany({where:{expiresAt:{lte:now},key:{startsWith:'donor:'}}});
  const health=await tx.warmupSiteHealth.findUnique({where:{domain_channel:{domain,channel}}});
  if(health?.cooldownUntil>now || await tx.workflowLease.findUnique({where:{key:`donor:rate:${domain}`}}))return null;
  const prefix=`donor:active:${domain}:`;
  const active=await tx.workflowLease.findMany({where:{key:{startsWith:prefix},expiresAt:{gt:now}},select:{key:true}});
  if(new Set(active.map(row=>row.key.split(':').at(-1))).size>=2 || active.some(row=>resources.some(r=>row.key.startsWith(`${prefix}${r}:`))))return null;
  await tx.workflowLease.createMany({data:resources.map(r=>({key:`${prefix}${r}:${owner}`,owner,expiresAt:new Date(+now+21*60000)}))});
  return {domain,channel,owner,channelLabel:proxy.channel||proxy.host};
 });
}
export async function finishDonor(prisma, reservation, {success=false,reason=null,status=null,retryAfter=null,durationMs=null}={}, now=new Date()) {
 if(!reservation)return;
 const result=await sqliteWrite(prisma,async tx=>{
  if(!await tx.workflowLease.count({where:{owner:reservation.owner}}))return;
  const {domain,channel,channelLabel}=reservation;
  const previous=await tx.warmupSiteHealth.findUnique({where:{domain_channel:{domain,channel}}});
  const failures=success?0:(previous?.consecutiveFailures||0)+1;
  const cooldownUntil=success?null:new Date(+now+Math.max(15*60000*2**Math.min(5,failures-1),retryAfterMs(retryAfter,+now)));
  const data={domain,channel,channelLabel,lastAttemptAt:now,lastStatus:status,lastReason:success?null:reason,consecutiveFailures:failures,cooldownUntil,...(success?{lastSuccessAt:now}:{}),...(Number.isSafeInteger(durationMs)&&durationMs>=0?{durationMs}:{})};
  await tx.warmupSiteHealth.upsert({where:{domain_channel:{domain,channel}},create:{id:keyHash(`${domain}:${channel}`),...data,success:success?1:0,failure:success?0:1},update:{...data,success:{increment:success?1:0},failure:{increment:success?0:1}}});
  if(status===429){
   const key=`donor:rate:${domain}`,old=await tx.workflowLease.findUnique({where:{key}}),expiresAt=new Date(Math.max(+cooldownUntil,old?.expiresAt?.getTime()||0));
   await tx.workflowLease.upsert({where:{key},create:{key,owner:'donor-rate-limit',expiresAt},update:{expiresAt}});
  }
  await tx.workflowLease.deleteMany({where:{owner:reservation.owner}});
  return {cooldownUntil,consecutiveFailures:failures};
 });
 releasedReservations.add(reservation);
 return result;
}
export async function releaseDonor(prisma,reservation){
 // finishDonor has already released the lease transactionally. A second queued
 // DELETE can exceed cleanup's deadline under load despite no remaining work.
 if(!reservation||releasedReservations.has(reservation))return;
 await sqliteWrite(prisma,tx=>tx.workflowLease.deleteMany({where:{owner:reservation.owner}}));
 releasedReservations.add(reservation);
}
export async function availableDonors(prisma,proxy,sites,now=new Date()) {
 const domainList=sites.map(host),channel=donorChannel(proxy);
 const [health,limited]=await Promise.all([
  prisma.warmupSiteHealth.findMany({where:{channel,domain:{in:domainList}}}),
  prisma.workflowLease.findMany({where:{key:{in:domainList.map(d=>`donor:rate:${d}`)},expiresAt:{gt:now}}})
 ]);
 return sites.filter(url=>!health.some(row=>row.domain===host(url)&&row.cooldownUntil>now)&&!limited.some(row=>row.key===`donor:rate:${host(url)}`));
}
