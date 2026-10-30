import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, symlink, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import store from '../utils/taskLogStore.js';
import download from '../utils/taskLogDownloads.js';
const exec = promisify(execFile);
const stamp = '2026-10-23T10:00:00.000Z';
const options = { now: Date.parse(stamp), reserveBytes: 0, budgetBytes: 1_000_000, partBytes: 512 };
const record = (id, line = 'Строка события\n', extra = {}) => ({ meta: { id, taskId: 'task1', executionId: 'execution1', startedAt: stamp, executionStartedAt: stamp }, time: stamp, event: 'navigation', line, ...extra });
async function fixture(fn) { const root = await mkdtemp(join(tmpdir(),'orbit-logs-')); try { return await fn(root); } finally { await rm(root,{recursive:true,force:true}); } }
test('UTF-8 rotation preserves ordered complete records and bounded parts',()=>fixture(async root=>{
 const lines=Array.from({length:100},(_,i)=>record('a',`${i}: русский текст 😀 ${'x'.repeat(30)}\n`));
 await store.writeBatch(root,lines,options);const cat=await store.readCatalog(root),a=cat.attempts[0];
 assert.ok(a.parts.length>1);assert.ok(a.parts.every(p=>p.bytes<=512));
 const buffers=await Promise.all(a.parts.map(p=>store.readPart(root,a,p)));assert.equal(Buffer.concat(buffers).toString().replace(/^# Orbit.*\n/gm,''),lines.map(l=>l.line).join(''));
}));
test('quota evicts completed successes before failures; active attempts retained with visible drop count',()=>fixture(async root=>{
 for(const [id,end] of [['success','success'],['error','error'],['active',undefined]])await store.writeBatch(root,[record(id,'x\n',{end})],options);
 await store.writeBatch(root,[record('new','new\n')],{...options,budgetBytes:26000});
 let cat=await store.readCatalog(root);assert.equal(cat.attempts.find(a=>a.id==='success').parts.length,0);assert.ok(cat.attempts.find(a=>a.id==='active').parts.length);
 await store.writeBatch(root,[record('new','another\n')],{...options,budgetBytes:1});cat=await store.readCatalog(root);assert.ok(cat.attempts.find(a=>a.id==='new').dropped>0);assert.ok(cat.attempts.find(a=>a.id==='active').parts.length);
}));
test('retention retains summaries, expires success after 7 days and errors after 30 days',()=>fixture(async root=>{
 await store.writeBatch(root,[record('ok','ok\n',{end:'success'}),record('bad','bad\n',{end:'error'})],options);
 await store.writeBatch(root,[],{...options,now:options.now+8*86400000});let cat=await store.readCatalog(root);assert.equal(cat.attempts.find(a=>a.id==='ok').parts.length,0);assert.equal(cat.attempts.find(a=>a.id==='bad').parts.length,1);
 await store.writeBatch(root,[],{...options,now:options.now+31*86400000});cat=await store.readCatalog(root);assert.equal(cat.attempts.length,2);assert.ok(cat.attempts.every(a=>!a.parts.length));
}));
test('parallel OS processes do not lose catalog entries or mix attempts',()=>fixture(async root=>{
 const module=resolve('utils/taskLogStore.js');
 await Promise.all(Array.from({length:4},(_,i)=>exec(process.execPath,['-e',`const s=require(${JSON.stringify(module)});s.writeBatch(process.argv[1],JSON.parse(process.argv[2]),JSON.parse(process.argv[3])).catch(e=>{console.error(e);process.exitCode=1})`,root,JSON.stringify([record(`p${i}`,`process ${i}\n`,{end:'success'})]),JSON.stringify(options)])));
 const cat=await store.readCatalog(root);assert.equal(cat.attempts.length,4);for(const a of cat.attempts)assert.match((await store.readPart(root,a,a.parts[0])).toString(),/process [0-3]/);
}));
test('download lease protects closed files from cleanup, released leases allow cleanup',()=>fixture(async root=>{
 await store.writeBatch(root,[record('protected','text\n',{end:'success'})],options);
 const release=await store.acquireReadLease(root,['protected']);
 try { await store.writeBatch(root,[],{...options,now:options.now+31*86400000});assert.equal((await store.readCatalog(root)).attempts[0].parts.length,1); }
 finally { await release(); }
 await store.writeBatch(root,[],{...options,now:options.now+31*86400000});assert.equal((await store.readCatalog(root)).attempts[0].parts.length,0);
}));
test('download selects exact task/execution/start; retry IDs do not leak previous attempts; ZIP is readable',()=>fixture(async root=>{
 const later='2026-10-23T11:00:00.000Z';
 await store.writeBatch(root,[record('old','old\n',{end:'success'}),record('new','new\n',{meta:{...record('new').meta,startedAt:later,executionStartedAt:later},time:later,end:'error'})],options);
 const req=q=>new Request('http://localhost/api?'+q);
 let response=await download.response(req('format=index&executionId=execution1&startedAt='+encodeURIComponent(later)),'task1',root);assert.deepEqual((await response.json()).attempts.map(a=>a.id),['new']);
 response=await download.response(req('attemptId=old'),'task1',root);assert.match(await response.text(),/\nold\n$/);assert.match(response.headers.get('Content-Disposition'),/attachment/);
 response=await download.response(req('attemptId=old'),'otherTask',root);assert.equal(response.status,404);
 response=await download.response(req('attemptId=../../secret'),'task1',root);assert.equal(response.status,400);
 response=await download.response(req('format=zip&from=bad&to=bad'),'task1',root);assert.equal(response.status,400);
 response=await download.response(req('format=zip&from=2026-10-23T00:00:00Z&to=2026-10-24T00:00:00Z'),'task1',root);
 const zip=join(root,'test.zip');await writeFile(zip,Buffer.from(await response.arrayBuffer()));
 const out=await exec('python3',['-c',"import zipfile,sys,json; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; s=json.loads(z.read('summary.json')); assert len(s['attempts'])==2; assert all(i.file_size<=65536 for i in z.infolist() if 'part-' in i.filename); print('ok')",zip]);assert.equal(out.stdout.trim(),'ok');
}));
test('symlinked part is rejected',()=>fixture(async root=>{
 await store.writeBatch(root,[record('a')],options);const a=(await store.readCatalog(root)).attempts[0];const file=join(root,'v2',a.id,a.parts[0].name);await rm(file);await symlink('/etc/passwd',file);await assert.rejects(store.readPart(root,a,a.parts[0]));
}));
test('logger redacts secrets, records retries independently, flushes on shutdown and preserves live callback',()=>fixture(async root=>{
 const cwd=process.cwd();const logger=await import('../worker/tech-logger.mjs');process.chdir(root);
 try {
  let n=0;const l=await logger.createTechLogger('task1',()=>n++,{runId:'run1'},async()=>({startedAt:stamp,attempts:1}));
  l.log('execution_allocated',{executionId:'execution1'});l.log('event',{executionId:'execution1',password:'SECRET',body:'HUGE',url:'https://example.org/a?token=SECRET'});l.log('session_completed',{executionId:'execution1'});
  l.log('execution_allocated',{executionId:'execution1'});l.log('session_failed',{executionId:'execution1',code:'test_error'});
  l.log('execution_allocated',{executionId:'execution2'});l.log('execution_allocated',{executionId:'execution2'});l.log('task_retry_scheduled',{executionId:'execution2',code:'test_retry'});
  await logger.closeTechLogs();assert.equal(n,8);const cat=await store.readCatalog(join(root,'logs/tasks'));assert.equal(cat.attempts.length,4);assert.deepEqual(cat.attempts.map(a=>a.status),['success','error','interrupted','error']);
  let text='';for(const a of cat.attempts)for(const p of a.parts)text+=(await store.readPart(join(root,'logs/tasks'),a,p)).toString();assert.ok(!text.includes('SECRET'));assert.ok(!text.includes('HUGE'));
 } finally { process.chdir(cwd); }
}));
