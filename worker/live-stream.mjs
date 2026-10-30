import {createServer} from 'node:net';
import {chmodSync,unlinkSync} from 'node:fs';

export const LIVE_FRAMES_PER_SECOND = 7;
const frameIntervalMs = Math.ceil(1000 / LIVE_FRAMES_PER_SECOND);

/** One CDP producer per browser session; no viewers means no capture. */
export function startBrowserStream(context,{socketPath,getPage,onFrame=()=>{}}){
 const viewers=new Set();let stopped=false,session=null,activePage=null,busy=false,lastFrame=0,lastSaved=0,failedPage=null,failedAt=0,latest=null;
 const timers=new Set();
 const send=(viewer,message)=>{if(!viewer.destroyed&&viewer.writableLength===0)viewer.write(`${JSON.stringify(message)}\n`);};
 const broadcast=message=>{for(const viewer of viewers)send(viewer,message);};
 const closeCapture=async()=>{
  const old=session;
  if(latest&&activePage===getPage()){try{onFrame(Buffer.from(latest.data,'base64'));}catch{}}
  session=null;activePage=null;latest=null;
  if(old){try{await old.send('Page.stopScreencast');}catch{}try{await old.detach();}catch{}}
 };
 const update=async()=>{
  if(busy||stopped)return;busy=true;
  try{
   const page=viewers.size?getPage():null;
   if(page===activePage&&session)return;
   await closeCapture();
   if(!page||stopped||!viewers.size)return;
   if(page===failedPage&&Date.now()-failedAt<1000)return;
   const cdp=await context.newCDPSession(page);
   if(stopped||!viewers.size||page!==getPage()){await cdp.detach();return;}
   session=cdp;activePage=page;lastFrame=0;
   cdp.on('Page.screencastFrame',frame=>{
    const valid=!stopped&&session===cdp&&viewers.size&&getPage()===page;
    const now=Date.now();
    if(valid&&now-lastFrame>=frameIntervalMs){
     lastFrame=now;
     latest={type:'frame',data:frame.data,time:now};broadcast(latest);
     // Persist at most once per second; disk is not used to deliver live frames.
     if(now-lastSaved>=1000){lastSaved=now;try{onFrame(Buffer.from(frame.data,'base64'));}catch{}}
    }
    // Delay acknowledgements to bound the producer, including frames dropped above.
    const timer=setTimeout(()=>{timers.delete(timer);if(session===cdp)void cdp.send('Page.screencastFrameAck',{sessionId:frame.sessionId}).catch(()=>{});},frameIntervalMs);
    timers.add(timer);
   });
   await cdp.send('Page.startScreencast',{format:'jpeg',quality:55,maxWidth:720,maxHeight:1280,everyNthFrame:1});
   failedPage=null;
   broadcast({type:'status',state:'live'});
  }catch{
   failedPage=getPage();failedAt=Date.now();await closeCapture();broadcast({type:'status',state:'unavailable'});
  }finally{busy=false;}
 };
 const server=createServer(viewer=>{
  if(stopped||viewers.size>=10){viewer.destroy();return;}
  viewers.add(viewer);failedPage=null;send(viewer,{type:'status',state:session?'live':'waiting'});if(latest&&activePage===getPage())send(viewer,latest);
  viewer.on('error',()=>{});viewer.on('close',()=>{viewers.delete(viewer);void update();});
  // Clients only receive frames; input is ignored and bounded.
  viewer.on('data',()=>viewer.destroy());void update();
 });
 server.on('error',()=>{});
 try{unlinkSync(socketPath);}catch{}
 try{server.listen(socketPath,()=>{try{chmodSync(socketPath,0o600);}catch{}});}catch{}
 const timer=setInterval(()=>{void update();},250);
 return ()=>{
  stopped=true;clearInterval(timer);for(const timeout of timers)clearTimeout(timeout);timers.clear();
  for(const viewer of viewers)viewer.destroy();viewers.clear();
  try{unlinkSync(socketPath);}catch{}server.close(()=>{});void closeCapture();
 };
}
