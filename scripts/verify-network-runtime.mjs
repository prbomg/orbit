import {chromium} from 'playwright-extra';
import '../worker/runner.mjs';
import {PrismaClient} from '@prisma/client';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {loadConfig} from '../worker/config.mjs';
import fp from '../utils/fingerprint.js';
import channels from '../utils/proxyChannel.js';
import {sqliteWrite} from '../worker/sqlite-write.mjs';
import {createMobileContext} from '../worker/profiles.mjs';
import {observeNetworkTransport,observeHttp3,transportReference,networkProbeUrl,reserveTransportProbe,unmeasuredTransport} from '../worker/network-transport.mjs';
const args=process.argv.slice(2),flag=args.indexOf('--proxy'),proxyId=flag>=0?args[flag+1]:null;
const output=args.find((v,i)=>!v.startsWith('--')&&(flag<0||i!==flag+1));
const config=loadConfig(),db=new PrismaClient(),owner=`network-diagnostic:${randomUUID()}`;
let browser,report;const controller=new AbortController();
const stop=()=>{controller.abort();void browser?.close().catch(()=>{});};process.once('SIGTERM',stop);process.once('SIGINT',stop);const deadline=setTimeout(stop,40000);deadline.unref();
try{
 const rows=await db.proxy.findMany(),proxy=proxyId?rows.find(p=>p.id===proxyId):null;
 if(proxyId&&!proxy)throw Error('proxy_missing');
 if(proxy&&!proxy.isActive)throw Error('proxy_inactive');
 if(!config.networkProbeUrl){report=unmeasuredTransport();}
 else{
  if(proxy){
   const keys=channels.channelKeys(rows,proxy);
   await sqliteWrite(db,async tx=>{
    await tx.$executeRaw`DELETE FROM "WorkflowLease" WHERE "expiresAt"<${new Date()}`;
    const active=await tx.workflowLease.findMany({where:{expiresAt:{gt:new Date()}}});
    if(active.some(l=>keys.includes(l.key)||keys.some(k=>['warmup-share','target-share','warmup-gate'].some(prefix=>l.key.startsWith(`${prefix}:${k}:`)))))throw Error('proxy_busy');
    await tx.workflowLease.createMany({data:keys.map(key=>({key,owner,expiresAt:new Date(Date.now()+90000)}))});
   });
  }
  if(!await reserveTransportProbe(db,config.networkProbeUrl)){report=unmeasuredTransport('probe_throttled');}
  else{
   browser=await chromium.launch({headless:true,timeout:10000,executablePath:config.chromiumExecutablePath,args:['--proxy-bypass-list=<-loopback>'],...(proxy?{proxy:{server:`${config.proxyScheme}://${proxy.host}:${proxy.port}`,username:proxy.username,password:proxy.password}}:{})});
   controller.signal.throwIfAborted();
   const passport=fp.localPassport({fingerprintMode:'local'},{runtimeVersion:browser.version()}),profile=fp.profileFromPassport('network-runtime-control',passport),context=await createMobileContext(browser,profile);
   try{
    const reference=await transportReference(config.networkReferenceFile,{runtimeVersion:browser.version(),locale:profile.fingerprint.navigator.language,endpointHost:networkProbeUrl(config.networkProbeUrl).host});
    report=await observeNetworkTransport(context,profile,{endpoint:config.networkProbeUrl,timeoutMs:config.networkProbeTimeoutMs,proxyScheme:proxy?config.proxyScheme:'direct',runtimeVersion:browser.version(),reference,signal:controller.signal});
    if(config.networkHttp3Url&&!controller.signal.aborted)report.http3=await observeHttp3(context,{endpoint:config.networkHttp3Url,timeoutMs:8000,signal:controller.signal});
    report.proxyId=proxy?.id||null;report.scope='ephemeral-runtime-control';report.profileIdentityPersisted=false;
   }finally{await context.close();}
  }
 }
}catch(error){report={...unmeasuredTransport('probe_unavailable'),status:'unavailable',reason:['proxy_missing','proxy_inactive','proxy_busy'].includes(error.message)?error.message:'probe_failed'};}
finally{clearTimeout(deadline);await browser?.close().catch(()=>{});await db.workflowLease.deleteMany({where:{owner}}).catch(()=>{});await db.$disconnect();}
if(output)await writeFile(output,JSON.stringify(report,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify(report));
