import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {profileSaveDiagnostics} from '../worker/profile-save-diagnostics.mjs';
const src=await readFile(new URL('../worker/profiles.mjs',import.meta.url),'utf8');
const code=src.slice(src.indexOf('export async function stageMobileProfile')).replace('export async function','async function');
class ProfileError extends Error {constructor(code){super('safe profile error');this.name='ProfileError';this.code=code;}}
function fixture(failingStage, suppliedError, loggerFails = false) {
 const events=[],removed=[],writes=[];
 const error=suppliedError??new TypeError('PRIVATE_COOKIE_VALUE');
 const step=(name,value)=>{if(name===failingStage)throw error;return value;};
 const file={writeFile:async value=>{step('file_write');writes.push(value);},sync:async()=>step('file_sync'),close:async()=>step('file_close')};
 const context={storageState:async()=>step('storage_export',{cookies:[],origins:[]}),cookies:async()=>step('cookies_export',[])};
 const globals={profileSaveDiagnostics,ProfileError,Buffer,profileByteLimit:()=>100000,profilePath:()=>'/profiles/id.json',join:(...s)=>s.join('/'),randomUUID:()=> 'temporary',
  mkdir:async()=>step('directory'),lstat:async()=>({isDirectory:()=>true,isSymbolicLink:()=>false}),
  rm:async path=>removed.push(path),open:async()=>step('file_open',file),
  fp:{deviceFingerprint:()=>step('fingerprint',{})},runtimeStates:new WeakMap(),batteryState:{createBatteryModel:()=>step('runtime',{})},
  observeCookies:()=>step('cookie_observations',[]),validateProfile:v=>step('validation',v),
  snapshots:{stampSnapshot:v=>step('snapshot_stamp',{...v,snapshot:{id:'new',passportHash:'hash'},...(failingStage==='serialization'?{unsupported:1n}:{})})},
  sessionSummary:()=>step('session_summary',{hasData:true}),
 };
 const ctx=vm.createContext(globals);vm.runInContext(code,ctx);
 const run=()=>ctx.stageMobileProfile('/profiles',{profileId:'id',fingerprint:{}},context,{log:(event,details)=>{events.push({event,details});if(loggerFails)throw Error('logger');}});
 return{run,events,removed,writes,error};
}
for(const stage of ['directory','storage_export','cookies_export','fingerprint','runtime','cookie_observations','validation','snapshot_stamp','file_open','file_write','file_sync','file_close','session_summary'])test('reports precise stage '+stage,async()=>{
 const f=fixture(stage);await assert.rejects(f.run(),e=>e instanceof ProfileError&&e.saveDiagnostics.stage===stage);
 assert.equal(f.events.length,1);assert.equal(f.events[0].event,'profile_save_failed');
 assert.equal(JSON.stringify(f.events).includes('PRIVATE_COOKIE_VALUE'),false);assert.equal(f.removed.length,1);
});
test('schema issues retain structural paths, exclude dynamic keys and messages',async()=>{
 const e=Object.assign(new Error('PRIVATE_COOKIE_VALUE'),{name:'ZodError',issues:[{path:['cookies',3,'sameSite'],code:'invalid_enum_value',message:'PRIVATE_COOKIE_VALUE',received:'PRIVATE_COOKIE_VALUE'},{path:['origins',0,'localStorage','PRIVATE_STORAGE_KEY'],code:'custom'}]});
 const f=fixture('validation',e);await assert.rejects(f.run(),e=>e.code==='profile_state_invalid');
 const d=f.events[0].details;assert.deepEqual(d.issues[0].path,['cookies',3,'sameSite']);assert.equal(d.issues[1].path.at(-1),'[field]');assert.equal(d.sourceErrorType,'ZodError');assert.equal(JSON.stringify(d).includes('PRIVATE'),false);
});
test('JSON serialization failure is distinguished',async()=>{const f=fixture('serialization');await assert.rejects(f.run(),e=>e.saveDiagnostics.stage==='serialization'&&e.code==='profile_state_invalid');});
test('existing error code is preserved',async()=>{const f=fixture('validation',new ProfileError('invalid_mobile_profile'));await assert.rejects(f.run(),e=>e.code==='invalid_mobile_profile'&&e.saveDiagnostics.stage==='validation');});
test('disk full retains its existing code',async()=>{const f=fixture('file_write',Object.assign(Error('private path'),{code:'ENOSPC'}));await assert.rejects(f.run(),e=>e.code==='profile_disk_full');});
test('successful save adds no failure event and keeps staged publish contract',async()=>{const f=fixture();const result=await f.run();assert.equal(typeof result.publish,'function');assert.equal(typeof result.discard,'function');assert.equal(result.cookiesCount,0);assert.equal(f.events.length,0);assert.equal(f.writes.length,1);assert.equal(f.removed.length,0);});
test('diagnostic payload is bounded and omits arbitrary exception names',()=>{
 const d=profileSaveDiagnostics({name:'PRIVATE_VALUE',issues:Array.from({length:30},()=>({path:Array(40).fill('PRIVATE_KEY'),code:'PRIVATE_CODE'}))},'PRIVATE_STAGE');
 assert.equal(d.stage,'unknown');assert.equal(d.sourceErrorType,'Error');assert.equal(d.issueCount,30);assert.equal(d.issues.length,20);assert.equal(d.issues[0].path.length,16);assert.equal(d.issuesTruncated,true);assert.equal(JSON.stringify(d).includes('PRIVATE'),false);
});

test('logger failure never masks original profile failure',async()=>{const f=fixture('validation',undefined,true);await assert.rejects(f.run(),e=>e.code==='profile_state_invalid'&&e.saveDiagnostics.stage==='validation');});
test('failure cleanup targets only temporary file',async()=>{const f=fixture('validation');await assert.rejects(f.run());assert.deepEqual(f.removed,['/profiles/.id.temporary.tmp']);});
