import test from 'node:test';
import assert from 'node:assert/strict';
import {get} from 'node:http';
import {createConnection} from 'node:net';
import {isolateVerificationNetwork} from '../worker/verification-network.mjs';

test('verification rejects traffic locally and discards upstream proxy credentials and bypass flags',async()=>{
 const launch={headless:true,args:['--some-kept-flag','--no-proxy-server','--proxy-server=http://unused.fixture.test','--proxy-bypass-list=*'],proxy:{server:'http://unused.fixture.test',username:'fixture-only',password:'fixture-only'}};
 const before=JSON.stringify(launch),network=await isolateVerificationNetwork(launch);
 try{
  assert.equal(JSON.stringify(launch),before);assert.deepEqual(network.options.args,['--some-kept-flag']);assert.deepEqual(Object.keys(network.options.proxy),['server']);
  const response=await new Promise((resolve,reject)=>get(network.options.proxy.server,resolve).once('error',reject));
  assert.equal(response.statusCode,502);response.resume();
 }finally{await network.close();}
});
test('abrupt HTTP and CONNECT client resets never escape the rejecting proxy and cleanup releases the port',async()=>{
 const network=await isolateVerificationNetwork(),url=new URL(network.options.proxy.server);
 try{
  for(let i=0;i<32;i++)await new Promise((resolve,reject)=>{
   const socket=createConnection({host:url.hostname,port:Number(url.port)});
   socket.once('error',reject);socket.once('close',resolve);
   socket.once('connect',()=>{socket.write(i%2?'CONNECT fixture.test:443 HTTP/1.1\r\nHost: fixture.test\r\n\r\n':'GET http://fixture.test/ HTTP/1.1\r\nHost: fixture.test\r\n\r\n');setImmediate(()=>socket.resetAndDestroy());});
  });
 }finally{await network.close();}
 await assert.rejects(new Promise((resolve,reject)=>{const socket=createConnection({host:url.hostname,port:Number(url.port)});socket.once('error',reject);socket.once('connect',()=>{socket.destroy();resolve();});}),{code:'ECONNREFUSED'});
});
