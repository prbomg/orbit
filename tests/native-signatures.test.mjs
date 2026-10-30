import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { installNativeSignatures } from '../worker/native-signatures.mjs';

test('native signatures retain descriptor, receiver errors and unrelated source', () => {
  const result = runInNewContext(`
    const before = Object.getOwnPropertyDescriptor(Function.prototype, 'toString');
    const source = before.value.call(Array.prototype.push);
    const register = (${installNativeSignatures})();
    const wrapper = register(new Proxy(Array.prototype.push, {}), Array.prototype.push);
    const after = Object.getOwnPropertyDescriptor(Function.prototype, 'toString');
    let threw = false; try { Function.prototype.toString.call({}); } catch(e) { threw = e instanceof TypeError; }
    ({ source, actual: Function.prototype.toString.call(wrapper), threw,
       descriptor: before.configurable === after.configurable && before.enumerable === after.enumerable && before.writable === after.writable,
       ordinary: Function.prototype.toString.call(function ordinary() { return 3; }),
       own: Function.prototype.toString.call(Function.prototype.toString) });
  `);
  assert.equal(result.actual, result.source);
  assert.equal(result.descriptor, true);
  assert.equal(result.threw, true);
  assert.match(result.ordinary, /return 3/);
  assert.equal(result.own, 'function toString() { [native code] }');
});

test('worker navigator proxies preserve descriptor flags and native receiver exceptions',async()=>{
 const {installWorkerPassport}=await import('../worker/worker-passport.mjs');
 const result=runInNewContext(`
   class WorkerNavigator { get hardwareConcurrency() { if(!(this instanceof WorkerNavigator))throw new TypeError('Illegal invocation');return 16; } }
   globalThis.navigator=new WorkerNavigator();
   const before=Object.getOwnPropertyDescriptor(WorkerNavigator.prototype,'hardwareConcurrency');
   (${installWorkerPassport})({navigator:{hardwareConcurrency:8}},(${installNativeSignatures})());
   const after=Object.getOwnPropertyDescriptor(WorkerNavigator.prototype,'hardwareConcurrency');
   let error;try{after.get.call({});}catch(e){error=[e.name,e.message];}
   ({before:{configurable:before.configurable,enumerable:before.enumerable},after:{configurable:after.configurable,enumerable:after.enumerable},value:navigator.hardwareConcurrency,error,name:after.get.name,length:after.get.length,source:after.get.toString(),native:before.get.toString()});
 `);
 assert.deepEqual(result.after,result.before);assert.equal(result.value,8);
 assert.deepEqual(Array.from(result.error),['TypeError','Illegal invocation']);
 assert.equal(result.name,'get hardwareConcurrency');assert.equal(result.length,0);assert.equal(result.source,result.native);
});


test('WebGL wrapper keeps native coercion side effects and unsigned enum conversion', async () => {
 const {installWebglLimits}=await import('../worker/webgl-limits.mjs');
 const result=runInNewContext(`
   let conversions=0;
   class GL { getParameter(parameter) { if(!(this instanceof GL))throw new TypeError('Illegal invocation'); return Number(parameter)>>>0; } }
   globalThis.WebGLRenderingContext=GL;
   (${installWebglLimits})({maxTextureSize:8192});
   const gl=new GL(),argument={valueOf(){conversions++;return 0x0d33;}};
   const objectResult=gl.getParameter(argument);
   let receiverError;try{GL.prototype.getParameter.call({},argument);}catch(e){receiverError=e.name;}
   ({conversions,objectResult,receiverError,stringResult:gl.getParameter('3379'),wrappedEnum:gl.getParameter(0x100000000+3379.5)});
 `);
 assert.equal(result.conversions,1);assert.equal(result.objectResult,8192);
 assert.equal(result.receiverError,'TypeError');assert.equal(result.stringResult,8192);assert.equal(result.wrappedEnum,8192);
});
