import { DatabaseSync } from 'node:sqlite';
import { chromium } from 'playwright';
import { loadConfig } from '../worker/config.mjs';
import { checkProxyIP } from '../worker/proxy-ip.mjs';

// Read-only diagnostic: no rotation, task execution, profile or database writes.
async function main() {
const args=process.argv.slice(2),selected=args.find(arg=>arg.startsWith('--proxy='))?.slice(8);
if(args.some(arg=>arg!=='--all'&&!/^--proxy=[a-zA-Z0-9_-]{1,128}$/.test(arg))||args.length>1)throw new Error('Usage: node scripts/check-proxy.mjs [--all | --proxy=ID]');
const config=loadConfig(),db=new DatabaseSync(config.databasePath,{readOnly:true});
let proxies;
try{proxies=db.prepare('SELECT id,host,port,username,password,isActive,rotationUrl FROM Proxy WHERE isActive=1'+(selected?' AND id=?':'')).all(...(selected?[selected]:[]));}finally{db.close();}
if(!args.length){
 console.log(JSON.stringify({proxies:proxies.map(p=>({id:p.id,host:p.host,port:p.port,rotationConfigured:Boolean(p.rotationUrl)})),usage:'node scripts/check-proxy.mjs --all or --proxy=ID'}));
}else{
 if(!proxies.length)throw new Error('No matching active proxy');
 const controller=new AbortController();let activeBrowser;
 const stop=()=>{controller.abort();void activeBrowser?.close().catch(()=>{});};
 process.once('SIGINT',stop);process.once('SIGTERM',stop);
 try{
  for(const proxy of proxies){
   controller.signal.throwIfAborted();
   try{
    activeBrowser=await chromium.launch({executablePath:config.chromiumExecutablePath,headless:true,timeout:config.navigationTimeoutMs,args:['--proxy-bypass-list=<-loopback>'],proxy:{server:`${config.proxyScheme}://${proxy.host}:${proxy.port}`,username:proxy.username,password:proxy.password}});
    const context=await activeBrowser.newContext();
    console.log(JSON.stringify({event:'proxy_configuration',proxyId:proxy.id,rotationConfigured:Boolean(proxy.rotationUrl)}));
    await checkProxyIP(context,{proxy,config:{...config,proxyIPCheckMode:'required'},signal:controller.signal,log:(event,data)=>console.log(JSON.stringify({event,...data}))});
   }catch(error){
    controller.signal.throwIfAborted();process.exitCode=1;
    console.log(JSON.stringify({event:'proxy_diagnostic_failed',proxyId:proxy.id,code:error.code||'browser_launch_failed'}));
   }finally{await activeBrowser?.close().catch(()=>{});activeBrowser=null;}
  }
 }finally{process.off('SIGINT',stop);process.off('SIGTERM',stop);}
}

}
try { await main(); } catch (error) {
 process.exitCode=error.name==='AbortError'?130:1;
 const safe=/^(Usage:|No matching active proxy|Set DATABASE_URL|SQLite file|DATABASE_URL must|Invalid WORKER_PROXY_IP_CHECK)/.test(error.message);
 console.error(JSON.stringify({event:'proxy_diagnostic_failed',code:error.name==='AbortError'?'cancelled':'configuration_error',message:safe?error.message:'Check the worker environment, database access and Chromium installation'}));
}
