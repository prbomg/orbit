import test from 'node:test';
import assert from 'node:assert/strict';
import visits from '../utils/projectVisits.js';
import {poolFixture} from './helpers/pool-fixture.mjs';
test('calendar periods use Moscow boundaries, inclusive final dates and real calendar validation',()=>{
 const now=Date.parse('2026-10-05T21:05:00Z');
 const today=visits.visitWindow({period:'today'},now);assert.equal(today.from,'2026-10-06');assert.equal(today.start.toISOString(),'2026-10-05T21:00:00.000Z');assert.equal(today.end.toISOString(),'2026-10-06T21:00:00.000Z');
 assert.equal(visits.visitWindow({period:'week'},now).from,'2026-09-30');
 assert.equal(visits.visitWindow({period:'yesterday'},now).to,'2026-10-05');
 assert.equal(visits.visitWindow({period:'custom',from:'2026-10-01',to:'2026-10-05'}).end.toISOString(),'2026-10-05T21:00:00.000Z');
 for(const options of [{period:'custom',from:'2026-02-30',to:'2026-03-01'},{period:'custom',from:'2026-10-02',to:'2026-10-01'},{period:'other'}])assert.throws(()=>visits.visitWindow(options));
});
test('actual chosen query is immutable, counted once per execution and survives task deletion; date boundary is exclusive',async()=>{
 const f=await poolFixture();try{
  const task=await f.task();await f.db.task.update({where:{id:task.id},data:{searchEngine:'yandex',searchQueries:['Промышленный насос','Купить насос']}});
  const event={projectId:f.project.id,taskId:task.id,executionId:'observed-one',query:'Промышленный насос',actualQuery:'Промышленный насос бренд',engine:'yandex',visitedAt:new Date('2026-10-05T20:59:59Z')};
  await visits.recordProjectVisit(f.db,event);await visits.recordProjectVisit(f.db,event);
  await visits.recordProjectVisit(f.db,{...event,executionId:'next-day',query:'Купить насос',visitedAt:new Date('2026-10-05T21:00:00Z')});
  await visits.recordProjectVisit(f.db,{...event,executionId:'direct',engine:'',query:null});
  await f.db.projectVisit.create({data:{projectId:f.project.id,kind:'unknown',engine:'',visitedAt:event.visitedAt,source:'completed_execution'}});
  const stats=await visits.projectVisitStats(f.db,f.project.id,{period:'custom',from:'2026-10-05',to:'2026-10-05'});
  assert.equal(stats.total,3);assert.equal(stats.search,1);assert.equal(stats.direct,1);assert.equal(stats.unknown,1);
  assert.equal(stats.items.find(r=>r.query==='Купить насос').count,0);
  assert.equal(stats.items.find(r=>r.query==='Промышленный насос').count,1);
  await f.db.task.update({where:{id:task.id},data:{searchQueries:['Другой запрос']}});
  assert.equal((await visits.projectVisitStats(f.db,f.project.id,{period:'all'})).items.find(r=>r.query==='Промышленный насос').count,1);
  await f.db.task.delete({where:{id:task.id}});assert.equal((await visits.projectVisitStats(f.db,f.project.id,{period:'all'})).total,4);
  assert.equal(await visits.projectVisitStats(f.db,'missing',{period:'all'}),null);
 }finally{await f.cleanup();}
});

test('migration imports dated successful history without inventing queries or duplicating completed executions',async()=>{
 const {DatabaseSync}=await import('node:sqlite');const {migrations}=await import('./helpers/pool-fixture.mjs');const scripts=await migrations(),index=scripts.findIndex(s=>s.includes('CREATE TABLE "ProjectVisit"')),sql=new DatabaseSync(':memory:');
 try{
  for(const script of scripts.slice(0,index))sql.exec(script);
  sql.exec(`INSERT INTO Profile(id,name) VALUES ('p','Fixture');INSERT INTO Project(id,name,websiteUrl,yandexRegionId,regionName) VALUES ('project','Fixture','https://fixture.test','213','');INSERT INTO Task(id,projectId,profileId,searchEngine,searchQueries) VALUES ('task','project','p','yandex','["changed query"]');INSERT INTO TaskExecution(id,taskId,profileId,status,completedAt) VALUES ('exec','task','p','completed',1760000000000);INSERT INTO ProfileProjectHistory(id,profileId,projectId,executedAt,source) VALUES ('covered','p','project',1760000000000,'execution'),('old','p','project',1750000000000,'execution'),('imported','p','project',1740000000000,'legacy');`);
  sql.exec(scripts[index]);const rows=sql.prepare('SELECT kind,query,source FROM ProjectVisit ORDER BY source').all();assert.equal(rows.length,2);assert.ok(rows.every(r=>r.kind==='unknown'&&r.query===null));assert.deepEqual(sql.prepare('PRAGMA foreign_key_check').all(),[]);
 }finally{sql.close();}
});

test('plain and multiple vital queries share one base total, respect dates and retain unknown refinement',async()=>{
 const f=await poolFixture();try{
  const task=await f.task();await f.db.task.update({where:{id:task.id},data:{searchEngine:'yandex',searchQueries:['насос','нет переходов']}});
  const base={projectId:f.project.id,taskId:task.id,query:'насос',engine:'yandex',visitedAt:new Date('2026-10-05T12:00:00Z')};
  for(const [executionId,actualQuery] of [['plain','насос'],['vital-one','насос бренд'],['vital-two','насос бренд'],['vital-three','насос сайт'],['old',null]])await visits.recordProjectVisit(f.db,{...base,executionId,actualQuery});
  await visits.recordProjectVisit(f.db,{...base,executionId:'tomorrow',actualQuery:'насос завтра',visitedAt:new Date('2026-10-05T21:00:00Z')});
  await visits.recordProjectVisit(f.db,{...base,executionId:'vital-one',actualQuery:'изменённый запрос'});
  const stats=await visits.projectVisitStats(f.db,f.project.id,{period:'custom',from:'2026-10-05',to:'2026-10-05'}),row=stats.items.find(r=>r.query==='насос');
  assert.equal(stats.total,5);assert.equal(stats.search,5);assert.equal(stats.refined,3);
  assert.equal(row.count,5);assert.equal(row.plainCount,1);assert.equal(row.refinedCount,3);assert.equal(row.refinementUnknownCount,1);
  assert.deepEqual(row.variants.map(v=>[v.actualQuery,v.count]),[['насос бренд',2],['насос сайт',1]]);
  assert.equal(row.lastVisitAt,base.visitedAt.toISOString());assert.equal(stats.items.find(r=>r.query==='нет переходов').refinedCount,0);
  const all=await visits.projectVisitStats(f.db,f.project.id,{period:'all'});assert.equal(all.total,6);assert.equal(all.refined,4);
 }finally{await f.cleanup();}
});

test('task statistics isolate visits and zero-count queries from other tasks in the same project',async()=>{
 const f=await poolFixture();try{
  const task=await f.task(),other=await f.task();
  for(const [id,queries] of [[task.id,['общий','без переходов']],[other.id,['общий','чужой']]])await f.db.task.update({where:{id},data:{searchEngine:'yandex',searchQueries:queries}});
  const base={projectId:f.project.id,taskId:task.id,query:'общий',actualQuery:'общий',engine:'yandex',visitedAt:new Date('2026-10-05T20:59:59Z')};
  await visits.recordProjectVisit(f.db,{...base,executionId:'own'});
  await visits.recordProjectVisit(f.db,{...base,executionId:'refined',actualQuery:'общий бренд'});
  await visits.recordProjectVisit(f.db,{...base,executionId:'direct',engine:'',query:null});
  await visits.recordProjectVisit(f.db,{...base,executionId:'other',taskId:other.id,actualQuery:'чужой бренд'});
  await visits.recordProjectVisit(f.db,{...base,executionId:'unattributed',taskId:null});
  await visits.recordProjectVisit(f.db,{...base,executionId:'tomorrow',visitedAt:new Date('2026-10-05T21:00:00Z')});
  const stats=await visits.taskVisitStats(f.db,task.id,{period:'custom',from:'2026-10-05',to:'2026-10-05'});
  assert.equal(stats.total,3);assert.equal(stats.search,2);assert.equal(stats.refined,1);assert.equal(stats.direct,1);
  assert.equal(stats.items.find(r=>r.query==='без переходов').count,0);
  assert.ok(!stats.items.some(r=>r.query==='чужой'));
  assert.deepEqual(stats.items.find(r=>r.query==='общий').variants.map(v=>v.actualQuery),['общий бренд']);
  assert.equal((await visits.taskVisitStats(f.db,task.id,{period:'all'})).total,4);
  assert.equal((await visits.projectVisitStats(f.db,f.project.id,{period:'all'})).total,6);
  assert.equal(await visits.taskVisitStats(f.db,'missing',{period:'all'}),null);
 }finally{await f.cleanup();}
});
