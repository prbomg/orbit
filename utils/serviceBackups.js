// Files-only snapshots. Runtime data and secrets are never restored from a snapshot.
const fs = require('node:fs/promises');
const { constants, createReadStream, createWriteStream } = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const { resourcePaths } = require('./serviceResources');
const folders = new Set(['app','components','hooks','lib','utils','public','prisma','worker','patches','scripts','tests','deploy','third-party','runtime-fonts','docs']);
const validId = s => typeof s === 'string' && /^[a-f0-9-]{36}$/.test(s);
const stamp = () => new Date().toISOString();
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };
class BackupError extends Error { constructor(message, status = 409) { super(message); this.status = status; } }
async function directory(p) { const s = await fs.lstat(p); if (!s.isDirectory() || s.isSymbolicLink()) throw new BackupError('Небезопасный каталог резервных копий',503); }
async function json(p, fallback) { try { const s=await fs.lstat(p);if(!s.isFile()||s.isSymbolicLink())throw new BackupError('Небезопасный файл метаданных',503);return JSON.parse(await fs.readFile(p,'utf8')); } catch(e) { if(e.code==='ENOENT' && fallback!==undefined)return fallback;throw e; } }
async function atomic(p,v) { const t=p+'.'+randomUUID()+'.tmp';await fs.writeFile(t,JSON.stringify(v,null,2),{mode:0o600,flag:'wx'});await fs.rename(t,p); }
async function hash(p) { const h=createHash('sha256');const fd=await fs.open(p,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{if(!(await fd.stat()).isFile())throw new BackupError('Ожидался обычный файл');for await(const b of fd.createReadStream({autoClose:false}))h.update(b);return h.digest('hex');}finally{await fd.close();} }
function excluded(name) { return name==='node_modules'||name==='.next'||name==='.git'||name==='__pycache__'||name==='tsconfig.tsbuildinfo'||name.startsWith('.orbit-')||/\.(db|sqlite|sqlite3)(-|$|\.)/i.test(name)||name.startsWith('.env')&&name!=='.env.example'||/\.(pem|key)$/i.test(name); }
async function inventory(root,omit=[]) {
 const rows=[];let bytes=0;
 async function walk(base,relative='') {
  for(const e of await fs.readdir(base,{withFileTypes:true})){
   if(excluded(e.name))continue;const rel=relative?relative+'/'+e.name:e.name,p=path.join(base,e.name);if(omit.some(o=>p===o||p.startsWith(o+path.sep)))continue;
   if(!relative && !folders.has(e.name) && !(e.isFile()&&(/\.(js|mjs|cjs|ts|tsx|json|yaml|yml|css|md|sh|html|txt)$/.test(e.name)||e.name==='.env.example')))continue;
   const s=await fs.lstat(p);if(s.isSymbolicLink())continue;
   if(s.isDirectory())await walk(p,rel);
   else if(s.isFile()){bytes+=s.size;if(bytes>2_000_000_000||rows.length>=100000)throw new BackupError('Слишком большой объём исходников');rows.push({path:rel,bytes:s.size,sha256:await hash(p),mode:s.mode&0o777});}
  }
 }
 await walk(root);return rows.sort((a,b)=>a.path.localeCompare(b.path));
}
function safeFile(n){return typeof n==='string'&&n.length<1024&&!path.isAbsolute(n)&&!n.split('/').some(x=>!x||x==='.'||x==='..'||x.includes('\\')||x.includes('\0'))&&!n.split('/').some(excluded);}
async function command(bin,args,{cwd,log,timeout=600000,env=process.env}={}) {
 return new Promise((resolve,reject)=>{
  const child=spawn(bin,args,{cwd,env,stdio:['ignore','pipe','pipe'],detached:true});let timer,aborted=false;
  for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{if(log)log.write(b);});
  child.on('error',e=>{clearTimeout(timer);reject(e);});
  child.on('close',code=>{clearTimeout(timer);code===0&&!aborted?resolve():reject(new BackupError(aborted?'Превышено время подготовки версии':'Не удалось выполнить '+bin+'. Подробности сохранены в журнале операции'));});
  timer=setTimeout(()=>{aborted=true;try{process.kill(-child.pid,'SIGKILL');}catch{}},timeout);timer.unref();
 });
}
function createBackupManager(options={}) {
 const config=options.config||resourcePaths(),root=path.resolve(options.root||process.env.ORBIT_SERVICE_BACKUPS_DIRECTORY||path.join(config.data,'service-backups'));
 const current=path.join(config.application,'current');
 async function init(){await fs.mkdir(root,{recursive:true,mode:0o700});await directory(root);for(const n of ['copies','jobs']){await fs.mkdir(path.join(root,n),{mode:0o700,recursive:true});await directory(path.join(root,n));}}
 async function locked(fn){await init();const p=path.join(root,'.lock'),token=randomUUID();
  for(let i=0;i<2;i++){
   try{await fs.mkdir(p,{mode:0o700});await atomic(path.join(p,'owner.json'),{pid:process.pid,token});break;}
   catch(e){if(e.code!=='EEXIST')throw e;const old=await json(path.join(p,'owner.json'),null);if(!old||alive(old.pid))throw new BackupError('Другая операция с резервными копиями ещё выполняется');await fs.rm(p,{recursive:true});if(i===1)throw new BackupError('Не удалось получить блокировку');}
  }
  try{return await fn();}finally{const o=await json(path.join(p,'owner.json'),null);if(o?.token===token)await fs.rm(p,{recursive:true});}
 }
 const copyPath=id=>{if(!validId(id))throw new BackupError('Некорректный ID копии',400);return path.join(root,'copies',id);};
 async function read(id){const p=copyPath(id);await directory(p);const m=await json(path.join(p,'manifest.json'));if(m.id!==id||m.format!==1||!Array.isArray(m.files)||!m.files.every(f=>safeFile(f.path)&&/^[a-f0-9]{64}$/.test(f.sha256)))throw new BackupError('Повреждён манифест копии');return m;}
 async function all(){const out=[];for(const id of (await fs.readdir(path.join(root,'copies'))).filter(validId)){try{out.push(await read(id));}catch(e){if(e.code!=='ENOENT')out.push({id,createdAt:null,important:true,broken:true,label:'Повреждённая копия',bytes:0});}}return out.sort((a,b)=>(b.createdAt||'').localeCompare(a.createdAt||''));}
 const defaults={enabled:false,intervalHours:24,retentionDays:7};
 async function settings(){return {...defaults,...await json(path.join(root,'settings.json'),{})};}
 async function jobs(){const result=[];for(const id of (await fs.readdir(path.join(root,'jobs'))).filter(validId)){const j=await json(path.join(root,'jobs',id,'job.json'),null);if(j){if(['queued','running'].includes(j.status)&&!alive(j.pid)&&Date.now()-Date.parse(j.updatedAt)>30000){j.status='failed';j.message='Процесс операции был прерван';await atomic(path.join(root,'jobs',id,'job.json'),j);}result.push(j);}}return result.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,20);}
 async function list(){await init();const s=await settings();return {settings:s,nextAt:s.enabled?new Date(Date.parse(s.lastScheduledAt||s.updatedAt||stamp())+s.intervalHours*3600000).toISOString():null,backups:(await all()).map(({files,...m})=>({...m,fileCount:files?.length||0})),jobs:await jobs()};}
 async function configure(value){return locked(async()=>{const {enabled,intervalHours,retentionDays}=value;if(typeof enabled!=='boolean'||!Number.isInteger(intervalHours)||intervalHours<1||intervalHours>720||!Number.isInteger(retentionDays)||retentionDays<1||retentionDays>3650)throw new BackupError('Проверьте интервал (1–720 часов) и хранение (1–3650 дней)',400);const s={...await settings(),enabled,intervalHours,retentionDays,updatedAt:stamp()};await atomic(path.join(root,'settings.json'),s);return s;});}
 async function protect(id,important){return locked(async()=>{if(typeof important!=='boolean')throw new BackupError('Нужен признак важности',400);const m=await read(id);m.important=important;await atomic(path.join(copyPath(id),'manifest.json'),m);return {id,important};});}
 async function remove(id){return locked(async()=>{const m=await read(id);if(m.important)throw new BackupError('Сначала снимите отметку «Важная»');await fs.rm(copyPath(id),{recursive:true});return {deleted:true};});}
 async function cleanup(){const s=await settings(),cutoff=Date.now()-s.retentionDays*86400000;for(const m of await all())if(!m.important&&!m.broken&&Date.parse(m.createdAt)<cutoff)await fs.rm(copyPath(m.id),{recursive:true});}
 async function snapshot({label='',important=false,source='manual'}={}){
  const release=await fs.realpath(current).catch(()=>config.release),files=await inventory(release,[root]);
  if(!files.some(f=>f.path==='package.json')||!files.some(f=>f.path==='pnpm-lock.yaml'))throw new BackupError('В копии отсутствуют файлы сборки проекта');
  const id=randomUUID(),dir=copyPath(id),temp=path.join(root,'.preparing-'+id);await fs.mkdir(path.join(temp,'files'),{recursive:true,mode:0o700});
  try{
   for(const row of files){const dest=path.join(temp,'files',row.path);await fs.mkdir(path.dirname(dest),{recursive:true,mode:0o700});await fs.copyFile(path.join(release,row.path),dest,constants.COPYFILE_EXCL);await fs.chmod(dest,row.mode&0o755);if(await hash(dest)!==row.sha256)throw new BackupError('Файлы меняются во время копирования. Повторите создание');}
   if(JSON.stringify(files)!==JSON.stringify(await inventory(release,[root])))throw new BackupError('Файлы меняются во время копирования. Повторите создание');
   const m={format:1,id,label:String(label).trim().slice(0,120)||'Резервная копия',createdAt:stamp(),important,source,release:path.basename(release),bytes:files.reduce((n,f)=>n+f.bytes,0),files,excluded:['profiles','database','logs','.env','node_modules','.next']};
   await atomic(path.join(temp,'manifest.json'),m);
   // Archive is a download artifact; restoration always validates the files against the manifest.
   await command('tar',['-czf',path.join(temp,'backup.tar.gz'),'--','manifest.json','files'],{cwd:temp});
   await fs.chmod(path.join(temp,'backup.tar.gz'),0o600);m.archiveBytes=(await fs.stat(path.join(temp,'backup.tar.gz'))).size;await atomic(path.join(temp,'manifest.json'),m);await fs.rename(temp,dir);return m;
  }catch(e){await fs.rm(temp,{recursive:true,force:true});throw e;}
 }
 async function download(id){await init();await read(id);const p=path.join(copyPath(id),'backup.tar.gz');const h=await fs.open(p,constants.O_RDONLY|constants.O_NOFOLLOW);const s=await h.stat();if(!s.isFile()){await h.close();throw new BackupError('Архив недоступен');}return {handle:h,size:s.size};}
 async function enqueue(action,{id,label,confirmation}={}){
  if(!['create','restore'].includes(action))throw new BackupError('Неизвестная операция',400);
  return locked(async()=>{
   if((await jobs()).some(j=>['queued','running'].includes(j.status)))throw new BackupError('Дождитесь завершения текущей операции');
   if(action==='restore'){if(confirmation!=='ВОССТАНОВИТЬ')throw new BackupError('Подтвердите восстановление',400);await read(id);await require('./serviceBackupRestore').preflight(config);}
   const job={id:randomUUID(),action,backupId:id||null,label:String(label||'').slice(0,120),status:'queued',createdAt:stamp(),updatedAt:stamp(),pid:process.pid};const d=path.join(root,'jobs',job.id);await fs.mkdir(d,{mode:0o700});await atomic(path.join(d,'job.json'),job);
   const agent=options.agent||path.join(root,'agent','scripts','service-backups.cjs');const log=await fs.open(path.join(d,'operation.log'),'a',0o600);
   try{const c=spawn(process.execPath,[agent,'job',job.id],{cwd:config.release,env:{...process.env,ORBIT_SERVICE_BACKUPS_DIRECTORY:root},detached:true,stdio:['ignore',log.fd,log.fd]});await new Promise((resolve,reject)=>{c.once('spawn',resolve);c.once('error',reject);});job.pid=c.pid;await atomic(path.join(d,'job.json'),job);c.unref();return job;}catch(e){job.status='failed';job.message='Не удалось запустить операцию';await atomic(path.join(d,'job.json'),job);throw e;}finally{await log.close();}
  });
 }
 async function performJob(id){if(!validId(id))throw new BackupError('Некорректная операция',400);
  // Parent releases the filesystem lock after publishing our PID.
  for(let n=0;n<50;n++){try{return await locked(async()=>{const filename=path.join(root,'jobs',id,'job.json');let j=await json(filename);if(j.status!=='queued')return;j={...j,pid:process.pid,status:'running',updatedAt:stamp()};await atomic(filename,j);
   const update=async message=>{j.message=message;j.updatedAt=stamp();await atomic(filename,j);};
   try{if(j.action==='create'){await update('Создание копии файлов');const m=await snapshot({label:j.label});j.backupId=m.id;}else await restore(j.backupId,update);
    j.status='completed';j.message=j.action==='create'?'Копия создана':'Версия восстановлена';await cleanup();
   }catch(e){j.status='failed';j.message=e instanceof BackupError?e.message:'Операция не завершена. Проверьте журнал на сервере';console.error(e instanceof BackupError?e.message:String(e?.code||e?.name||'ERROR'));}
   j.updatedAt=stamp();await atomic(filename,j);return j;});}catch(e){if(!e.message.includes('Другая операция')||n===49)throw e;await new Promise(r=>setTimeout(r,100));}}
 }
 async function tick(){return locked(async()=>{await require('./serviceBackupRestore').recoverActivation(config,root);const s=await settings();await cleanup();if(!s.enabled)return;const last=Date.parse(s.lastScheduledAt||s.updatedAt||stamp());if(Date.now()-last<s.intervalHours*3600000)return;await snapshot({source:'schedule',label:'По расписанию'});s.lastScheduledAt=stamp();await atomic(path.join(root,'settings.json'),s);});}
 async function restore(id,update){
  const m=await read(id),source=path.join(copyPath(id),'files'),live=await fs.realpath(current);
  await update('Проверка целостности и совместимости');for(const f of m.files)if(await hash(path.join(source,f.path))!==f.sha256)throw new BackupError('Проверка целостности копии не пройдена');
  const schema=m.files.find(f=>f.path==='prisma/schema.prisma');if(!schema||schema.sha256!==await hash(path.join(live,'prisma/schema.prisma')))throw new BackupError('Структура БД отличается. Автоматическое восстановление этой версии недоступно');
  const { activate }=require('./serviceBackupRestore');
  await activate({config,current,root,source,manifest:m,update,snapshot,command,hash,atomic});
 }
 return {root,list,configure,protect,remove,download,enqueue,performJob,tick,snapshot:options.testing?opts=>locked(()=>snapshot(opts)):undefined,cleanup:options.testing?()=>locked(cleanup):undefined};
}
module.exports={createBackupManager,BackupError,inventory,safeFile,command};
