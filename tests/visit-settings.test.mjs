import test from 'node:test';
import assert from 'node:assert/strict';
import settings from '../utils/visitSettings.js';
import {poolFixture} from './helpers/pool-fixture.mjs';
test('section rules match path segments and reject traversal, external URLs and encoded bypasses',()=>{
 const parsed=settings.visitSettings({minSeconds:60,maxSeconds:120,maxInternalTransitions:2,allowedSections:['/catalog/','/catalog','/articles/']});assert.deepEqual(parsed.allowedSections,['/catalog','/articles']);
 assert.equal(settings.allowsSection('https://fixture.test/catalog/item',parsed.allowedSections),true);assert.equal(settings.allowsSection('https://fixture.test/catalogue',parsed.allowedSections),false);assert.equal(settings.allowsSection('https://fixture.test/%252e%252e/other',parsed.allowedSections),false);
 for(const path of ['https://other.test','//other.test','/catalog/../other','/catalog/%2e%2e/other','/catalog?x=1','/catalog\\other'])assert.throws(()=>settings.normalizeSection(path));
 for(const patch of [{minSeconds:200,maxSeconds:100},{maxInternalTransitions:11},{minSeconds:1},{allowedSections:['//other.test']}])assert.throws(()=>settings.visitSettings({...parsed,...patch}));
 assert.equal(settings.visitSettings({}),null);
});
test('existing task defaults remain legacy; visit settings persist separately from search phrases',async()=>{
 const f=await poolFixture();try{const task=await f.task();assert.deepEqual(task.visitSettings,{});const value={minSeconds:90,maxSeconds:180,maxInternalTransitions:0,allowedSections:['/catalog']};await f.db.task.update({where:{id:task.id},data:{visitSettings:value}});const saved=await f.db.task.findUnique({where:{id:task.id}});assert.deepEqual(saved.visitSettings,value);assert.deepEqual(saved.searchQueries,[]);}finally{await f.cleanup();}
});
