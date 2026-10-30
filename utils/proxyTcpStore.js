const {Prisma}=require('@prisma/client');
const {randomUUID} = require('node:crypto');
const channels = require('./proxyChannel.js');
const tcp = require('./proxyTcp.js');
const messages = {
 tcp_key_missing:'Добавьте API-ключ MobileProxy в настройках профилей.', tcp_proxy_not_found:'Прокси не найден в аккаунте MobileProxy по адресу, порту и логину.',
 tcp_channel_conflict:'В одном канале указаны разные прокси MobileProxy. Разделите каналы по модемам.', tcp_busy:'Канал сейчас используется. Приостановите его прогрев и задачи и дождитесь освобождения перед сменой пресета.',
 tcp_rate_limit:'MobileProxy ограничил частоту запросов. Повторите немного позже.', tcp_invalid_response:'MobileProxy вернул неподдерживаемый ответ TCP API.', tcp_provider_unavailable:'TCP API MobileProxy недоступен. Повторите проверку.', tcp_provider_rejected:'MobileProxy отклонил запрос TCP API.', tcp_apply_rejected:'MobileProxy не подтвердил применение пресета.', tcp_preset_missing:'Выберите пресет из актуального списка MobileProxy.', tcp_missing:'Прокси не найден.', tcp_management_busy:'Другая операция TCP ещё выполняется. Дождитесь её окончания.', tcp_profile_changed:'У провайдера выбран другой TCP-пресет.', tcp_unverified:'Сетевой пресет пока не подтверждён диагностикой.', tcp_os_mismatch:'ОС профиля несовместима с TCP-пресетом канала.'
};
const message = error => messages[error?.code] || 'Не удалось выполнить операцию TCP-пресета.';
async function provider(db,fetchImpl,signal){const settings=await db.settings.findUnique({where:{id:1},select:{mobileProxyApiKey:true}});return tcp.client(settings?.mobileProxyApiKey||process.env.MOBILEPROXY_API_KEY,fetchImpl,signal);}
async function reserve(db,keys,exclusive=true){const owner=`tcp-operation:${randomUUID()}`;await db.$transaction(async tx=>{
 await tx.$executeRaw`UPDATE "Settings" SET "id"="id" WHERE "id"=1`;
 const now=new Date(); const leases=await tx.workflowLease.findMany({where:{expiresAt:{gt:now}}});
 if(leases.some(l=>keys.includes(l.key)||(exclusive&&keys.some(k=>['warmup-share','target-share'].some(kind=>l.key.startsWith(`${kind}:${k}:`))))))throw new tcp.TcpError(exclusive?'tcp_busy':'tcp_management_busy');
 await tx.workflowLease.deleteMany({where:{key:{in:keys},expiresAt:{lte:now}}});
 await tx.workflowLease.createMany({data:keys.map(key=>({key,owner,expiresAt:new Date(Date.now()+180000)}))});
 },{timeout:15000,maxWait:10000});return async()=>{await db.workflowLease.deleteMany({where:{owner}});};}
async function state(db,id,fetchImpl){const proxy=await db.proxy.findUnique({where:{id},include:{tcpChannel:true}});if(!proxy)throw new tcp.TcpError('tcp_missing');const api=await provider(db,fetchImpl);const rows=await api.proxies();const providerId=tcp.resolveProviderId(proxy,rows);const config=await db.proxyTcpChannel.findUnique({where:{providerProxyId:providerId}});const presets=await api.presets();const current=await api.current(providerId);const members=channels.channelMembers(await db.proxy.findMany(),proxy);const keys=members.flatMap(channels.proxyKeys);const busy=(await db.workflowLease.findMany({where:{expiresAt:{gt:new Date()}}})).some(l=>keys.includes(l.key)||keys.some(k=>['warmup-share','target-share'].some(kind=>l.key.startsWith(`${kind}:${k}:`))));
 return {providerId,config,presets,current,members:members.length,busy};}
async function apply(db,id,presetId,fetchImpl){const proxy=await db.proxy.findUnique({where:{id}});if(!proxy)throw new tcp.TcpError('tcp_missing');const api=await provider(db,fetchImpl);const rows=await api.proxies();const providerId=tcp.resolveProviderId(proxy,rows);const presets=await api.presets();const preset=presets.find(p=>p.id===presetId);if(!preset)throw new tcp.TcpError('tcp_preset_missing');
 const all=await db.proxy.findMany();const members=channels.channelMembers(all,proxy);const existing=await db.proxyTcpChannel.findUnique({where:{providerProxyId:providerId}});
 for(const member of members)if(tcp.resolveProviderId(member,rows)!==providerId)throw new tcp.TcpError('tcp_channel_conflict');
 for(const item of all){try{if(tcp.resolveProviderId(item,rows)===providerId&&!members.some(p=>p.id===item.id))members.push(item);}catch(error){if(error.code!=='tcp_proxy_not_found')throw error;}}
 const channelId=existing?.id||`mobileproxy:${providerId}`;
 const keys=[...new Set([...members.flatMap(channels.proxyKeys),`tcp:${channelId}`,`tcp-management:${providerId}`])];const release=await reserve(db,keys);
 try{
  const config=await db.$transaction(async tx=>{await tx.$executeRaw`UPDATE "Settings" SET "id"="id" WHERE "id"=1`;
   // Check membership again under the write lock; settings edits also use this lock.
   const latest=await tx.proxy.findMany();for(const row of latest){try{if(tcp.resolveProviderId(row,rows)===providerId&&!members.some(p=>p.id===row.id))throw new tcp.TcpError('tcp_channel_conflict');}catch(error){if(error.code!=='tcp_proxy_not_found')throw error;}}if(members.some(p=>!latest.some(q=>q.id===p.id&&q.host===p.host&&q.port===p.port&&q.username===p.username&&q.channel===p.channel&&q.rotationUrl===p.rotationUrl)))throw new tcp.TcpError('tcp_channel_conflict');
   const row=await tx.proxyTcpChannel.upsert({where:{providerProxyId:providerId},create:{id:channelId,providerProxyId:providerId,profileId:preset.id,profileName:preset.name,parameters:preset.parameters,family:preset.family,status:'pending'},update:{profileId:preset.id,profileName:preset.name,parameters:preset.parameters,family:preset.family,status:'pending',generation:{increment:1},appliedAt:null,checkedAt:null,diagnostic:Prisma.DbNull,errorCode:null}});
   await tx.proxy.updateMany({where:{id:{in:members.map(p=>p.id)}},data:{tcpChannelId:row.id}});return row;});
  try{await api.apply(providerId,preset.id);await db.proxyTcpChannel.update({where:{id:channelId},data:{appliedAt:new Date()}});}catch(error){await db.proxyTcpChannel.update({where:{id:channelId},data:{status:'failed',errorCode:error.code||'tcp_provider_unavailable'}});throw error;}
  return {config:{...config,appliedAt:new Date()},members:members.length};
 }finally{await release();}}
async function diagnose(db,id,fetchImpl){const proxy=await db.proxy.findUnique({where:{id},include:{tcpChannel:true}});if(!proxy)throw new tcp.TcpError('tcp_missing');const api=await provider(db,fetchImpl);const providerId=proxy.tcpChannel?.providerProxyId||tcp.resolveProviderId(proxy,await api.proxies());const release=await reserve(db,[`tcp-management:${providerId}`],false);
 try{const config=await db.proxyTcpChannel.findUnique({where:{providerProxyId:providerId}});const current=await api.current(providerId);const raw=await api.diagnose(providerId);const proof=config?tcp.channelDiagnostic(config,raw):{diagnostic:raw,verified:false};const diagnostic=proof.diagnostic;const verified=Boolean(config)&&current.profileId===config.profileId&&proof.verified;
  if(config)await db.proxyTcpChannel.updateMany({where:{id:config.id,generation:config.generation},data:{status:verified?'applied':config.status==='pending'?'pending':'failed',checkedAt:new Date(),diagnostic,errorCode:verified?null:current.profileId!==config.profileId?'tcp_profile_changed':'tcp_unverified'}});
  return {current,diagnostic,verified,managed:Boolean(config)};
 }finally{await release();}}
async function syncBinding(tx,id,rows){const item=await tx.proxy.findUniqueOrThrow({where:{id}});const all=await tx.proxy.findMany();const members=channels.channelMembers(all,{...item,tcpChannelId:null});const bindings=[...new Set(members.filter(p=>p.id!==id&&p.tcpChannelId).map(p=>p.tcpChannelId))];if(bindings.length>1)throw new tcp.TcpError('tcp_channel_conflict');
 let binding=bindings[0]||item.tcpChannelId;
 if(!binding&&rows){try{const providerId=tcp.resolveProviderId(item,rows);binding=(await tx.proxyTcpChannel.findUnique({where:{providerProxyId:providerId}}))?.id;}catch(error){if(error.code!=='tcp_proxy_not_found')throw error;}}
 if(binding){const config=await tx.proxyTcpChannel.findUniqueOrThrow({where:{id:binding}});if(!rows||tcp.resolveProviderId(item,rows)!==config.providerProxyId)throw new tcp.TcpError('tcp_channel_conflict');}
 if(binding)await tx.proxy.update({where:{id},data:{tcpChannelId:binding}});
}
module.exports={state,apply,diagnose,reserve,provider,syncBinding,message};
