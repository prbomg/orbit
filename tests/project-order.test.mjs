import test from 'node:test';
import assert from 'node:assert/strict';
import order from '../utils/projectOrder.js';
import {poolFixture} from './helpers/pool-fixture.mjs';
test('moves retain hidden projects and forbid crossing active/archive groups',()=>{
 const rows=[{id:'a'},{id:'hidden'},{id:'b'},{id:'archive',archivedAt:'now'}];
 assert.deepEqual(order.moveProject(rows,'a','b').map(p=>p.id),['hidden','b','a','archive']);
 assert.equal(order.moveProject(rows,'a','archive'),rows);assert.equal(order.moveProject(rows,'unknown','b'),rows);
});
test('order persists and malformed or stale lists do not partially change it',async()=>{
 const f=await poolFixture();try{
  const other=await f.db.project.create({data:{name:'Second',targetUrl:'https://second.test',yandexRegionId:'213',regionName:''}});
  await f.db.$transaction(tx=>order.saveProjectOrder(tx,[other.id,f.project.id],false));
  assert.deepEqual((await f.db.project.findMany({orderBy:{sortOrder:'asc'}})).map(p=>p.id),[other.id,f.project.id]);
  await assert.rejects(f.db.$transaction(tx=>order.saveProjectOrder(tx,[f.project.id,f.project.id],false)),/invalid_order/);
  await assert.rejects(f.db.$transaction(tx=>order.saveProjectOrder(tx,[f.project.id],false)),/order_changed/);
  assert.equal((await f.db.project.findUnique({where:{id:other.id}})).sortOrder,0);
 }finally{await f.cleanup();}
});
