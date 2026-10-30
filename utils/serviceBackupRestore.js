const fs=require('node:fs/promises');
const path=require('node:path');
const {createRequire}=require('node:module');
const {spawn}=require('node:child_process');
const {createWriteStream}=require('node:fs');
const {finished}=require('node:stream/promises');
const {createServer}=require('node:net');
const {randomUUID}=require('node:crypto');
const {withReleaseOperation}=require('./releaseManager');
const {BackupError}=require('./serviceBackups');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const exists=async p=>{try{await fs.access(p);return true;}catch{return false;}};
async function processes(){const rows=[];for(const p of await fs.readdir('/proc')){if(!/^\d+$/.test(p))continue;try{const base='/proc/'+p,s=await fs.stat(base);if(s.uid!==process.getuid())continue;rows.push({pid:Number(p),args:(await fs.readFile(base+'/cmdline','utf8')).split('\0'),cwd:await fs.readlink(base+'/cwd')});}catch{}}return rows;}
async function swap(current,target){const temp=current+'.backup-'+randomUUID();await fs.symlink(target,temp);await fs.rename(temp,current);}
async function health(port){try{const r=await fetch(`http://127.0.0.1:${port}/login/`,{redirect:'manual',signal:AbortSignal.timeout(3000)});await r.body?.cancel();return r.status===200;}catch{return false;}}
async function activeJobs(live){const require=createRequire(path.join(live,'package.json'));const {PrismaClient}=require('@prisma/client');const db=new PrismaClient();try{return await db.taskExecution.count({where:{status:'running'}})+await db.warmupJob.count({where:{status:'running'}});}finally{await db.$disconnect();}}
async function activate({config,current,root,source,manifest,update,snapshot,command,hash,atomic},adapters={}){
 const live=await fs.realpath(current),list=adapters.processes||processes,signal=adapters.signal||((pid,s)=>process.kill(pid,s)),probe=adapters.health||health;
 const releases=path.join(config.application,'releases');await fs.mkdir(releases,{recursive:true});if((await fs.lstat(releases)).isSymbolicLink())throw new BackupError('Небезопасный каталог релизов');
 const target=path.join(releases,'backup-'+new Date().toISOString().replace(/\D/g,'').slice(0,14)+'-'+manifest.id.slice(0,8));
 const log=createWriteStream(path.join(root,'restore-build.log'),{flags:'w',mode:0o600});await new Promise((resolve,reject)=>{log.once('open',resolve);log.once('error',reject);});let published=false;
 try{
  await update('Подготовка версии: зависимости и сборка');await fs.mkdir(target,{mode:0o750});await atomic(path.join(target,'.orbit-release.json'),{state:'preparing',sourceBackup:manifest.id});
  for(const row of manifest.files){const p=path.join(target,row.path);await fs.mkdir(path.dirname(p),{recursive:true});await fs.copyFile(path.join(source,row.path),p);await fs.chmod(p,row.mode&0o755);if(await hash(p)!==row.sha256)throw new BackupError('Файлы копии изменились');}
  for(const name of ['.env','.orbit-runtime','logs']){const original=path.join(live,name);if(await exists(original))await fs.symlink(await fs.realpath(original),path.join(target,name));else if(name==='logs')await fs.mkdir(path.join(target,name));else throw new BackupError('Не найдены внешние настройки или данные сервиса');}
  await (adapters.build||(async()=>{
   let store=[];try{const metadata=await fs.readFile(path.join(live,'node_modules/.modules.yaml'),'utf8');let location;try{location=JSON.parse(metadata).storeDir;}catch{location=metadata.match(/^storeDir:\s*['\"]?([^'\"\r\n]+)/m)?.[1];}if(location&&path.isAbsolute(location))store=['--store-dir',location.trim().replace(/\/v\d+$/,'')];}catch{}
   await command('pnpm',['install','--prefer-offline','--frozen-lockfile','--prod=false',...store],{cwd:target,log,env:{...process.env,NODE_ENV:'development'}});
   await command('pnpm',['build'],{cwd:target,log,env:{...process.env,NODE_ENV:'production'}});
  }))();
  // Independently start the prepared web build before switching production.
  await update('Проверка запуска подготовленной версии');
  if(adapters.smoke)await adapters.smoke(target);else{
   const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));
   const child=spawn(process.execPath,[path.join(target,'node_modules/next/dist/bin/next'),'start','--hostname','127.0.0.1','--port',String(port)],{cwd:target,env:{...process.env,NODE_ENV:'production'},stdio:['ignore',log,log]});
   try{let ready=false;for(let i=0;i<40;i++){if(await probe(port)){ready=true;break;}if(child.exitCode!==null)break;await delay(500);}if(!ready)throw new BackupError('Подготовленная версия не прошла проверку запуска');}finally{if(child.exitCode===null){child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),delay(5000)]);if(child.exitCode===null)child.kill('SIGKILL');}}
  }
  await withReleaseOperation(config.application,async()=>{
   if(await fs.realpath(current)!==live)throw new BackupError('Текущая версия изменилась во время подготовки');
   if(await hash(path.join(target,'prisma/schema.prisma'))!==await hash(path.join(live,'prisma/schema.prisma')))throw new BackupError('Структура БД изменилась во время подготовки');
   const procs=await list();if(procs.some(p=>p.cwd.startsWith(path.join(config.application,'releases')+path.sep)&&p.args.some(a=>/worker\/index\.(?:js|mjs)$/.test(a))))throw new BackupError('Перед восстановлением остановите исполнителей проектов');
   const web=procs.filter(p=>p.cwd===live&&p.args[0]?.startsWith('next-server'));
   if(web.length!==1)throw new BackupError('Не удалось определить процесс веб-сервиса');
   const warmup=procs.filter(p=>p.cwd.startsWith(path.join(config.application,'releases')+path.sep)&&p.args.some(a=>a.endsWith('worker/warmup-service.mjs'))),frozen=[];let switched=false;
   const intent={phase:'preparing-switch',pid:process.pid,previous:live,target,warmupPids:warmup.map(p=>p.pid),webPid:web[0].pid,at:new Date().toISOString()};await atomic(path.join(root,'activation.json'),intent);
   try{
    for(const p of warmup){signal(p.pid,'SIGSTOP');frozen.push(p.pid);}
    if(await (adapters.activeJobs||activeJobs)(live))throw new BackupError('Перед восстановлением дождитесь остановки заданий и прогрева');
    await update('Сохранение текущей версии перед восстановлением');const safety=await snapshot({important:true,source:'before-restore',label:'Перед восстановлением'});
    const state={...intent,phase:'switching',backupId:manifest.id,safetyId:safety.id};await atomic(path.join(root,'activation.json'),state);
    await atomic(path.join(target,'.orbit-release.json'),{state:'ready',sourceBackup:manifest.id,createdAt:state.at});
    await update('Переключение версии и перезапуск веб-сервиса');
    signal(web[0].pid,'SIGSTOP');try{await swap(current,target);switched=true;published=true;signal(web[0].pid,'SIGTERM');}finally{signal(web[0].pid,'SIGCONT');}
    for(const pid of frozen){signal(pid,'SIGTERM');signal(pid,'SIGCONT');}frozen.length=0;
    let healthy=false;for(let i=0;i<(adapters.attempts||60);i++){if((await list()).some(p=>p.cwd===target&&p.args[0]?.startsWith('next-server'))&&await probe(Number(process.env.ORBIT_SERVICE_HTTP_PORT||3000))){healthy=true;break;}await (adapters.delay||delay)(1000);}
    if(!healthy)throw new BackupError('Версия не запустилась. Выполнен возврат к предыдущей');
    await atomic(path.join(root,'activation.json'),{...state,phase:'completed',completedAt:new Date().toISOString()});
   }catch(e){
    if(switched&&await fs.realpath(current)===target){await swap(current,live);for(const p of await list())if(p.cwd===target&&(p.args[0]?.startsWith('next-server')||p.args.some(a=>a.endsWith('worker/warmup-service.mjs'))))signal(p.pid,'SIGTERM');await atomic(path.join(root,'activation.json'),{phase:'rolled-back',previous:live,target,at:new Date().toISOString()});}
    if(!switched)await atomic(path.join(root,'activation.json'),{...intent,phase:'cancelled'});
    throw e;
   }finally{for(const pid of frozen)try{signal(pid,'SIGCONT');}catch{}}
  });
 }finally{log.end();await finished(log);if(!published)await fs.rm(target,{recursive:true,force:true});}
}
async function preflight(config){if((await processes()).some(p=>p.cwd.startsWith(path.join(config.application,'releases')+path.sep)&&p.args.some(a=>/worker\/index\.(?:js|mjs)$/.test(a))))throw new BackupError('Перед восстановлением остановите исполнителей проектов');if(await activeJobs(await fs.realpath(path.join(config.application,'current'))))throw new BackupError('Перед восстановлением дождитесь остановки заданий и прогрева');}
async function recoverActivation(config,root){
 const p=path.join(root,'activation.json');let j;try{j=JSON.parse(await fs.readFile(p,'utf8'));}catch(e){if(e.code==='ENOENT')return;throw e;}
 if(!['preparing-switch','switching'].includes(j.phase))return;
 try{process.kill(j.pid,0);return;}catch(e){if(e.code!=='ESRCH')return;}
 const releases=path.join(config.application,'releases')+path.sep;
 if(!j.previous?.startsWith(releases)||!j.target?.startsWith(releases))throw new BackupError('Небезопасный журнал восстановления');
 const current=path.join(config.application,'current'),active=await fs.realpath(current),procs=await processes();
 if(j.phase==='switching'&&active===j.target&&!await health(Number(process.env.ORBIT_SERVICE_HTTP_PORT||3000))){await swap(current,j.previous);for(const x of procs)if(x.cwd===j.target&&x.args[0]?.startsWith('next-server')){try{process.kill(x.pid,'SIGTERM');process.kill(x.pid,'SIGCONT');}catch{}}}
 for(const pid of j.warmupPids||[]){const x=procs.find(x=>x.pid===pid&&x.cwd===j.previous&&x.args.some(a=>a.endsWith('worker/warmup-service.mjs')));if(x){try{if(active===j.target)process.kill(pid,'SIGTERM');process.kill(pid,'SIGCONT');}catch{}}}
 const web=procs.find(x=>x.pid===j.webPid&&x.cwd===j.previous&&x.args[0]?.startsWith('next-server'));if(web){try{if(active===j.target)process.kill(web.pid,'SIGTERM');process.kill(web.pid,'SIGCONT');}catch{}}
 await fs.writeFile(p,JSON.stringify({...j,phase:'recovered-interruption',recoveredAt:new Date().toISOString()}),{mode:0o600});
}
module.exports={activate,swap,health,processes,preflight,recoverActivation};
