import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,writeFile,rm,appendFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import history from '../utils/liveHistory.js';
test('byte pagination returns every Unicode event once, ignores malformed lines and remains stable after append',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'orbit-history-')),file=join(dir,'events.jsonl');
 try{
 const rows=Array.from({length:355},(_,i)=>({time:new Date(1700000000000+i*1000).toISOString(),event:'действие_'+i,url:'https://пример.рф/страница'}));await writeFile(file,rows.map((r,i)=>JSON.stringify(r)+'\n'+(i===10?'bad json\n':'')).join(''));
 let page=await history.readEventPage(file);assert.equal(page.events.length,120);const cursor=page.nextCursor;assert(cursor>0);assert.equal(page.events[0].event,'действие_235');
 await appendFile(file,JSON.stringify({time:'2026-10-13T00:00:00Z',event:'новое'})+'\n');
 const collected=[...page.events];while(page.nextCursor!==null){page=await history.readEventPage(file,{before:page.nextCursor});collected.unshift(...page.events);}
 assert.equal(collected.length,355);assert.equal(new Set(collected.map(e=>e._offset)).size,355);assert.deepEqual(collected.map(e=>e.event),rows.map(r=>r.event));
 assert.equal((await history.readEventPage(file)).events.at(-1).event,'новое');assert.deepEqual((await history.readEventPage(file,{before:0})).events,[]);
 await assert.rejects(history.readEventPage(file,{before:-1}),/invalid_cursor/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('missing and empty event logs are valid empty history',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'orbit-history-'));try{assert.deepEqual(await history.readEventPage(join(dir,'missing')),{events:[],nextCursor:null});await writeFile(join(dir,'empty'),'');assert.deepEqual(await history.readEventPage(join(dir,'empty')),{events:[],nextCursor:null});}finally{await rm(dir,{recursive:true,force:true});}
});
