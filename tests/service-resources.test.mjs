import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, link, rm, stat, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import resources from '../utils/serviceResources.js';

test('disk accounting uses allocated blocks, skips symlink targets and counts a hardlinked profile once',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'orbit-resources-'));
 try{
  const app=join(dir,'app'),data=join(dir,'data'),logs=join(dir,'logs'),release=join(app,'releases','current');
  for(const p of [release,join(app,'releases','previous'),logs,...['profiles','backups','browsers','runtime'].map(n=>join(data,n))])await mkdir(p,{recursive:true});
  await writeFile(join(release,'code'),Buffer.alloc(10000));
  const profile=join(data,'profiles','session');await writeFile(profile,Buffer.alloc(8192));await link(profile,join(data,'profiles','same-session'));
  await writeFile(join(data,'database'),Buffer.alloc(4096));
  const external=join(dir,'external');await writeFile(external,Buffer.alloc(1000000));await symlink(external,join(release,'linked-external'));
  const sparse=join(release,'sparse');await writeFile(sparse,'');await truncate(sparse,200000000);
  await writeFile(join(logs,'orbit.log'),Buffer.alloc(5120));await writeFile(join(logs,'other-service.log'),Buffer.alloc(1000000));
  const result=await resources.collectDisk({application:app,data,logs,release});
  assert.equal(result.complete,true);assert.equal(result.releaseCount,2);
  assert.equal(result.bytes,result.breakdown.reduce((sum,row)=>sum+row.bytes,0));
  assert.ok(result.bytes<1000000,'sparse file and external symlinks do not inflate allocated storage');
  const profileBytes=(await stat(profile)).blocks*512+(await stat(join(data,'profiles'))).blocks*512;
  assert.equal(result.breakdown.find(row=>row.key==='profiles').bytes,profileBytes);
  assert.equal(result.breakdown.find(row=>row.key==='logs').bytes,(await stat(join(logs,'orbit.log'))).blocks*512);
  assert.ok(result.volume.totalBytes>=result.volume.usedBytes);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('data nested in the application is not added to the total twice; unavailable data stays unknown',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'orbit-resources-'));
 try{
  const data=join(dir,'data');await mkdir(join(data,'profiles'),{recursive:true});await writeFile(join(data,'profiles','session'),Buffer.alloc(4096));
  const result=await resources.collectDisk({application:dir,data,logs:join(dir,'logs'),release:dir});
  assert.equal(result.bytes,result.activeReleaseBytes);assert.equal(result.complete,true);
  const missing=await resources.collectDisk({application:dir,data:join(dir,'missing'),logs:join(dir,'logs'),release:dir});
  assert.equal(missing.bytes,null);assert.equal(missing.complete,false);assert.ok(missing.knownBytes>0);
  assert.equal(missing.breakdown.find(row=>row.key==='otherData').bytes,null);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('simultaneous refreshes share one scan and a failed scan can be retried',async()=>{
 let now=0,calls=0,release;
 const cached=resources.cachedCollector(()=>{calls++;return new Promise(resolve=>{release=resolve;});},100,()=>now);
 const a=cached(),b=cached();await Promise.resolve();assert.equal(calls,1);release({value:1});assert.deepEqual(await a,await b);
 now=50;assert.equal((await cached()).value,1);assert.equal(calls,1);
 now=101;const next=cached();await Promise.resolve();assert.equal(calls,2);release({value:2});assert.equal((await next).value,2);
 let failures=0;const retry=resources.cachedCollector(async()=>{if(failures++===0)throw new Error('Temporary failure');return {ok:true};},100);
 await assert.rejects(retry());assert.equal((await retry()).ok,true);
});

test('process stat parsing handles spaces and parentheses in names and ignores exited zombies',()=>{
 const fields=Array(22).fill('0');fields[0]='S';fields[11]='15';fields[12]='5';fields[19]='123';fields[21]='10';
 assert.deepEqual(resources.parseProcessStat(`12 (node (worker)) ${fields.join(' ')}`,4096),{name:'node (worker)',parentPid:'0',ticks:20,started:'123',rssBytes:40960});
 fields[0]='Z';assert.equal(resources.parseProcessStat(`12 (node) ${fields.join(' ')}`),null);
 assert.equal(resources.parseProcessStat('invalid'),null);
});

test('browser children with a different working directory remain counted, unrelated services do not',()=>{
 const rows=new Map([['4',{owned:false,parentPid:'3'}],['1',{owned:true,parentPid:'0'}],['2',{owned:false,parentPid:'0'}],['3',{owned:false,parentPid:'1'}],['5',{owned:false,parentPid:'2'}]]);
 assert.deepEqual([...resources.selectServiceProcesses(rows).keys()].sort(),['1','3','4']);
});

test('partial traversal exposes measured categories without inventing zero sizes or a complete total',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'orbit-partial-resources-'));
 try{
  const app=join(dir,'app'),data=join(dir,'data');
  for(const p of [app,join(data,'profiles'),join(data,'backups')])await mkdir(p,{recursive:true});
  const progress=[];
  const result=await resources.collectDisk({application:app,release:app,data,logs:join(dir,'logs')},{onProgress:value=>progress.push(value),scan:async directories=>{assert.ok(directories.includes(join(data,'profiles')));return {sizes:new Map([[join(data,'backups'),8192],[app,4096]]),complete:false};}});
  assert.equal(result.bytes,null);assert.equal(result.complete,false);
  assert.equal(result.breakdown.find(x=>x.key==='profiles').bytes,null);
  assert.equal(result.breakdown.find(x=>x.key==='backups').bytes,8192);
  assert.equal(result.breakdown.find(x=>x.key==='browsers').bytes,0,'confirmed missing directory is zero');
  assert.ok(result.knownBytes>=12288);assert.ok(progress.some(value=>value.knownBytes>=8192));
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('an application nested inside data is not counted twice',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'orbit-data-parent-'));
 try{
  const data=join(dir,'data'),app=join(data,'profiles','app');await mkdir(app,{recursive:true});await writeFile(join(app,'code'),Buffer.alloc(8192));
  const result=await resources.collectDisk({application:app,release:app,data,logs:join(dir,'logs')});
  const allocated=(await stat(data)).blocks*512+(await stat(join(data,'profiles'))).blocks*512+(await stat(app)).blocks*512+(await stat(join(app,'code'))).blocks*512;
  assert.equal(result.complete,true);assert.equal(result.bytes,allocated);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('monitor returns live metrics during a long scan, shares forced refresh and retains last successful sizes after failure',async()=>{
 let now=0,calls=0,finish,progress,volume=10;
 const config={application:'/nonexistent-orbit-monitor',release:'/nonexistent-orbit-monitor',data:'/nonexistent-orbit-data',logs:'/nonexistent-orbit-log'};
 const live={available:true,measuredAt:'live',count:2};
 const partial={measuredAt:'partial',complete:false,bytes:null,knownBytes:4,breakdown:[{key:'profiles',bytes:null}],activeReleaseBytes:null,releaseCount:1};
 const complete={...partial,measuredAt:'complete',complete:true,bytes:123,knownBytes:123,breakdown:[{key:'profiles',bytes:123}]};
 const monitor=resources.resourceMonitor(config,{now:()=>now,collectProcesses:async()=>live,collectVolume:async()=>({availableBytes:volume++}),collectDisk:async(_config,options)=>{calls++;progress=options.onProgress;progress(partial);return new Promise(resolve=>{finish=resolve;});}});
 const a=await monitor();assert.equal(a.disk.scanState,'scanning');assert.equal(a.disk.bytes,null);assert.equal(a.processes,live);assert.equal(calls,1);
 const b=await monitor({refresh:true});assert.equal(calls,1);assert.notEqual(a.disk.volume.availableBytes,b.disk.volume.availableBytes,'free space bypasses the size cache');
 finish(complete);await new Promise(setImmediate);
 const cached=await monitor();assert.equal(cached.disk.bytes,123);assert.equal(cached.disk.scanState,'idle');assert.equal(calls,1);
 now=1000;const refreshing=await monitor({refresh:true});assert.equal(calls,2);assert.equal(refreshing.disk.scanState,'scanning');assert.equal(refreshing.disk.bytes,123);
 finish(partial);await new Promise(setImmediate);
 const failed=await monitor();assert.equal(failed.disk.scanState,'error');assert.equal(failed.disk.bytes,123);assert.equal(calls,2);
 now+=30001;await monitor();assert.equal(calls,3,'incomplete scan retries in 30 seconds rather than five minutes');finish(complete);await new Promise(setImmediate);
});

test('a disk collector failure keeps live metrics available and retries with backoff',async()=>{
 let now=0,calls=0;
 const monitor=resources.resourceMonitor({application:'/nonexistent-orbit-monitor'}, {now:()=>now,collectDisk:async()=>{calls++;throw new Error('Filesystem unavailable');},collectVolume:async()=>null,collectProcesses:async()=>({available:true,count:2})});
 await monitor();await new Promise(setImmediate);
 const result=await monitor();assert.equal(result.disk.scanState,'error');assert.equal(result.disk.bytes,null);assert.equal(result.processes.count,2);assert.equal(calls,1);
 now=30001;await monitor();await new Promise(setImmediate);assert.equal(calls,2);
});

test('release deletion during a scan queues one follow-up scan without overlapping traversals',async()=>{
 let epoch=null,calls=0,finish;
 const monitor=resources.resourceMonitor({application:'/nonexistent-orbit-monitor'},{readEpoch:async()=>epoch,collectVolume:async()=>null,collectProcesses:async()=>({available:true}),collectDisk:async()=>{calls++;return new Promise(resolve=>{finish=resolve;});}});
 await monitor();assert.equal(calls,1);epoch='deleted';await monitor();await monitor();assert.equal(calls,1);
 const value={complete:true,bytes:100,knownBytes:100,measuredAt:'before',breakdown:[]};finish(value);await new Promise(setImmediate);
 assert.equal(calls,2);assert.equal((await monitor()).disk.scanState,'scanning');finish({...value,bytes:50,knownBytes:50,measuredAt:'after'});await new Promise(setImmediate);
 const result=await monitor();assert.equal(calls,2);assert.equal(result.disk.bytes,50);assert.equal(result.disk.scanState,'idle');
});


test('all service files have disjoint categories, including external log links and shared package hardlinks',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'orbit-all-resources-'));
 try {
  const app=join(dir,'app'),data=join(dir,'data'),logs=join(dir,'supervisor'),release=join(app,'releases','new');
  const old=join(app,'releases','old'),externalLogs=join(dir,'external-logs');
  for(const p of [release,old,logs,externalLogs,...['profiles','service-backups','runtime','maintenance','reports','home','.pnpm-store','android-fonts-v1'].map(n=>join(data,n))])await mkdir(p,{recursive:true});
  await writeFile(join(externalLogs,'task.txt'),Buffer.alloc(8192));await symlink(externalLogs,join(release,'logs'));await symlink(externalLogs,join(old,'logs'));
  await symlink(join(data,'runtime'),join(release,'.orbit-runtime'));
  await writeFile(join(data,'runtime','state'),Buffer.alloc(4096));
  for(const filename of ['orbit.db','orbit.db-wal','orbit.db-shm'])await writeFile(join(data,filename),Buffer.alloc(4096));
  await writeFile(join(data,'service-backups','copy.tar.gz'),Buffer.alloc(4096));await writeFile(join(data,'maintenance','report.txt'),Buffer.alloc(4096));
  await writeFile(join(data,'home','package'),Buffer.alloc(65536));await link(join(data,'home','package'),join(release,'same-package'));
  await writeFile(join(logs,'orbit.log'),Buffer.alloc(4096));await writeFile(join(logs,'foreign.log'),Buffer.alloc(1000000));
  const result=await resources.collectDisk({application:app,data,logs,release});
  assert.equal(result.complete,true);assert.equal(result.bytes,result.breakdown.reduce((s,x)=>s+x.bytes,0));
  const row=key=>result.breakdown.find(x=>x.key===key).bytes;
  assert.equal(row('taskLogs'),(await stat(externalLogs)).blocks*512+(await stat(join(externalLogs,'task.txt'))).blocks*512);
  assert.equal(row('database'),12288);assert.ok(row('serviceBackups')>=4096);assert.ok(row('maintenance')>=4096);assert.ok(row('caches')>0);
  // Independent inode-aware traversal of exactly the intended physical roots.
  const seen=new Set();let expected=0;
  const {lstat,readdir}=await import('node:fs/promises');
  async function walk(p){const s=await lstat(p),id=s.dev+':'+s.ino;if(seen.has(id))return;seen.add(id);expected+=s.blocks*512;if(s.isDirectory())for(const child of await readdir(p))await walk(join(p,child));}
  for(const p of [app,data,externalLogs,join(logs,'orbit.log')])await walk(p);
  assert.equal(result.bytes,expected,'each physical inode counted once across all categories and symlink targets');
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('NUL-separated du output preserves filenames containing newlines',()=>{
 assert.deepEqual([...resources.parseDu('4096\t/path/with\nnewline\0')],[['/path/with\nnewline',4096]]);
});


test('an incomplete scan remains visible during the next scan and is replaced by fresher partial results',async()=>{
 let now=0,finish,progress;
 const partial={complete:false,bytes:null,knownBytes:123,measuredAt:'first',breakdown:[]};
 const monitor=resources.resourceMonitor({application:'/nonexistent-orbit-partial'}, {now:()=>now,readEpoch:async()=>null,collectVolume:async()=>null,collectProcesses:async()=>({available:true}),collectDisk:async(_config,options)=>{progress=options.onProgress;return new Promise(resolve=>{finish=resolve;});}});
 await monitor();finish(partial);await new Promise(setImmediate);assert.equal((await monitor()).disk.knownBytes,123);
 now=31000;await monitor();progress({...partial,knownBytes:0,measuredAt:'in-progress'});
 assert.equal((await monitor()).disk.knownBytes,123,'completed partial results do not disappear during a fresh scan');
 finish({...partial,knownBytes:140,measuredAt:'second'});await new Promise(setImmediate);
 assert.equal((await monitor()).disk.knownBytes,140);assert.equal((await monitor()).disk.scanState,'error');
});
