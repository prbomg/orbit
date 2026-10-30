import tcp from '../utils/proxyTcp.js';
import store from '../utils/proxyTcpStore.js';
import {rotateProxy, ProxyRotationError} from './proxy-rotation.mjs';
import {sleep, TaskStoppedError} from './behavior.mjs';
export async function prepareConfiguredProxy(options){await rotateProxy(options);await ensureTcpChannel(options);}
export async function ensureTcpChannel({prisma,proxy,signal,shouldContinue=async()=>true,log=()=>{},fetchImpl,waitFor=sleep,now=Date.now}){
 if(!proxy.tcpChannelId)return;
 const channel=await prisma.proxyTcpChannel.findUnique({where:{id:proxy.tcpChannelId}});if(!channel)throw new ProxyRotationError('tcp_unverified');
 const deadline=now()+145000;
 try{const api=await store.provider(prisma,fetchImpl,signal);
  while(true){signal?.throwIfAborted();if(!await shouldContinue())throw new TaskStoppedError();
   const current=await api.current(channel.providerProxyId);if(current.profileId!==channel.profileId)throw new ProxyRotationError('tcp_profile_changed');
   const {diagnostic,verified}=tcp.channelDiagnostic(channel,await api.diagnose(channel.providerProxyId));
   if(!await shouldContinue())throw new TaskStoppedError();signal?.throwIfAborted();
   await prisma.proxyTcpChannel.updateMany({where:{id:channel.id,generation:channel.generation},data:{status:verified?'applied':'pending',checkedAt:new Date(),diagnostic,errorCode:verified?null:'tcp_unverified'}});
   if(verified){log('proxy_tcp_verified',{proxyId:proxy.id,profileId:channel.profileId});return;}
   if(now()+65000>deadline)throw new ProxyRotationError('tcp_unverified');
   log('proxy_tcp_waiting',{proxyId:proxy.id});for(let left=65000;left>0;left-=1000){if(!await shouldContinue())throw new TaskStoppedError();await waitFor(Math.min(1000,left),signal);}
  }
 }catch(error){if(signal?.aborted||error instanceof TaskStoppedError)throw error;await prisma.proxyTcpChannel.updateMany({where:{id:channel.id,generation:channel.generation},data:{status:'failed',errorCode:error.code||'tcp_provider_unavailable'}});throw new ProxyRotationError(error.code||'tcp_provider_unavailable');}
}
