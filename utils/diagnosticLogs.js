const {open,readdir,lstat}=require('node:fs/promises');
const {resolve}=require('node:path');
const {isIP}=require('node:net');
const safeId=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(value);
const cache=new Map();
const numbers=['elapsedMs','status','navigationId','tab','retryAfterMs','durationMs','step','attempt'];
const strings=['stage','screenshotState','code','service','previousService','provider','reason','errorType','proxyId','proxyHost','browserIp','workerIp','previousIp','ipComparison','routeComparison'];
function projectEvent(row,offset,end){
 if(!row||typeof row.event!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(row.event)||!Number.isFinite(Date.parse(row.time)))return null;
 const out={time:new Date(row.time).toISOString(),event:row.event,_offset:offset,_end:end};
 for(const key of strings)if(typeof row[key]==='string'&&(key.endsWith('Ip')?isIP(row[key]):key==='proxyHost'?/^[a-zA-Z0-9.:[\]-]{1,253}$/.test(row[key]):/^[a-zA-Z0-9_-]{1,128}$/.test(row[key])))out[key]=row[key];
 for(const key of [...numbers,'proxyPort'])if(typeof row[key]==='number'&&Number.isFinite(row[key]))out[key]=row[key];
 if(typeof row.url==='string')try{const u=new URL(row.url);if(['http:','https:'].includes(u.protocol))out.url=`${u.protocol}//${u.host}${u.pathname}`;}catch{}
 return out;
}
async function readDiagnosticLog(path,{maxBytes=8*1024*1024}={}){
 let file;
 try{
  file=await open(path,'r');const info=await file.stat();if(!info.isFile())return {events:[],available:false,truncated:false,invalidLines:0};
  const cached=cache.get(path);if(cached&&cached.size===info.size&&cached.mtime===info.mtimeMs&&cached.maxBytes===maxBytes)return cached.value;
  const start=Math.max(0,info.size-maxBytes),buffer=Buffer.alloc(info.size-start);let read=0;while(read<buffer.length){const part=await file.read(buffer,read,buffer.length-read,start+read);if(!part.bytesRead)break;read+=part.bytesRead;}
  let at=start?buffer.indexOf(10)+1:0;const events=[];let invalidLines=0;
  if(start&&at===0)at=buffer.length;
  while(at<buffer.length){const nl=buffer.indexOf(10,at),end=nl<0?buffer.length:nl;try{const event=projectEvent(JSON.parse(buffer.subarray(at,end).toString('utf8')),start+at,start+(nl<0?end:end+1));if(event)events.push(event);else invalidLines++;}catch{if(nl>=0)invalidLines++;}at=end+1;}
  const value={events,available:true,truncated:start>0,invalidLines};cache.set(path,{size:info.size,mtime:info.mtimeMs,maxBytes,value});if(cache.size>16)cache.delete(cache.keys().next().value);
  return value;
 }catch(error){if(['ENOENT','EACCES'].includes(error.code))return {events:[],available:false,truncated:false,invalidLines:0};throw error;}finally{await file?.close();}
}
let indexCache=null;
async function diagnosticFileIndex(runtime){
 const root=resolve(runtime,'live');if(indexCache?.root===root&&indexCache.expires>Date.now())return indexCache.value;
 const value=new Map();
 try{for(const run of await readdir(root,{withFileTypes:true})){if(!run.isDirectory()||!safeId(run.name))continue;const directory=resolve(root,run.name);
  for(const file of await readdir(directory,{withFileTypes:true})){if(!file.isFile())continue;const match=/^([a-zA-Z0-9_-]{1,128})\.(jsonl|network\.json)$/.exec(file.name);if(!match)continue;const path=resolve(directory,file.name),stat=await lstat(path),entry=value.get(match[1])||{};const key=match[2]==='jsonl'?'events':'network';if(!entry[key]||stat.mtimeMs>entry[key].mtime)entry[key]={path,mtime:stat.mtimeMs,runId:run.name};value.set(match[1],entry);}
 }}catch(error){if(error.code!=='ENOENT')throw error;}
 indexCache={root,expires:Date.now()+15000,value};return value;
}
module.exports={readDiagnosticLog,diagnosticFileIndex};
