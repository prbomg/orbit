import test from 'node:test';
import assert from 'node:assert/strict';
import {reserveProjectLocation} from '../worker/project-geolocation.mjs';
import geo from '../utils/projectGeolocation.js';
const project={id:'p',yandexRegionId:'213'};
const execution={id:'e',profileId:'profile',status:'running',attempts:1};
test('execution reservation produces valid location without mutating fingerprint',async()=>{
 const point=await reserveProjectLocation({},project,'profile',execution);assert.ok(geo.validProjectLocation(point,project));assert.equal(point.executionId,'e');assert.equal(point.attempt,1);
});
test('runner uses exactly reserved execution location',async()=>{
 const point=await reserveProjectLocation({},project,'profile',execution);
 const tx={projectProfileUse:{findUnique:async()=>({taskId:'t',geolocation:point})},taskExecution:{findUnique:async()=>execution}};
 assert.deepEqual(await reserveProjectLocation(tx,project,'profile'),point);
 tx.taskExecution.findUnique=async()=>({...execution,attempts:2});
 await assert.rejects(reserveProjectLocation(tx,project,'profile'),/invalid_saved_execution_geolocation/);
});
test('invalid execution and completed execution cannot allocate location',async()=>{
 for(const change of [{profileId:'other'},{status:'completed'},{attempts:0}])await assert.rejects(reserveProjectLocation({},project,'profile',{...execution,...change}),/invalid_geolocation_execution/);
});
test('disabled geolocation does not touch database',async()=>assert.equal(await reserveProjectLocation({}, {...project,geolocation:{mode:'off'}},'profile'),null));
