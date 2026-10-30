const {createConnection}=require('node:net');
function liveEventStream({signal,getSocket,lifetime=60_000,retryDelay=2000}){
 let cleanup=()=>{};
 const stream=new ReadableStream({
  start(controller){
   let done=false,socket=null,connecting=false,retry=null,buffer='';
   const encoder=new TextEncoder();
   const emit=(type,value)=>{if(!done&&(controller.desiredSize??0)>0)controller.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`));};
   const finish=()=>{if(done)return;done=true;clearInterval(heartbeat);clearTimeout(expiry);clearTimeout(retry);signal.removeEventListener('abort',finish);socket?.destroy();try{controller.close();}catch{}};
   cleanup=finish;
   const connect=async()=>{
    if(done||connecting||socket)return;connecting=true;
    try{
     const path=await getSocket();if(done)return;
     if(!path){emit('status',{state:'waiting'});return;}
     const client=createConnection(path);socket=client;buffer='';
     client.on('data',chunk=>{
      buffer+=chunk.toString();if(buffer.length>2_000_000){client.destroy();return;}
      let end;while((end=buffer.indexOf('\n'))>=0){
       const line=buffer.slice(0,end);buffer=buffer.slice(end+1);
       try{const value=JSON.parse(line);if(value.type==='frame'&&typeof value.data==='string'&&Number.isFinite(value.time))emit('frame',{data:value.data,time:value.time});else if(value.type==='status')emit('status',{state:value.state});}catch{}
      }
     });
     client.on('error',()=>{});client.on('close',()=>{if(socket===client)socket=null;if(!done){emit('status',{state:'waiting'});retry=setTimeout(()=>{retry=null;void connect();},retryDelay);}});
    }catch{emit('status',{state:'waiting'});}
    finally{connecting=false;if(!done&&!socket&&!retry)retry=setTimeout(()=>{retry=null;void connect();},retryDelay);}
   };
   const heartbeat=setInterval(()=>{emit('heartbeat',{time:Date.now()});},10_000);
   const expiry=setTimeout(finish,lifetime);
   controller.enqueue(encoder.encode('retry: 2000\n\n'));
   signal.addEventListener('abort',finish,{once:true});
   if(signal.aborted)finish();else void connect();
  },cancel(){cleanup();}
 },{highWaterMark:1});
 return stream;
}
module.exports={liveEventStream};
