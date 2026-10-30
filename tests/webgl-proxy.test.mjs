import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { installWorkerPassport } from '../worker/worker-passport.mjs';
import { installWebglLimits } from '../worker/webgl-limits.mjs';

for (const limits of [undefined, { maxTextureSize: 8192, maxViewportDims: [8192, 8192] }]) {
  test(`worker WebGL uses one Proxy per native getParameter (${limits ? 'with limits' : 'vendor only'})`, () => {
    const result = runInNewContext(`
      const NativeProxy = Proxy, wrapped = [];
      globalThis.Proxy = function(target, handler) { wrapped.push(target); return new NativeProxy(target, handler); };
      class GL {
        getParameter(parameter) {
          if (!(this instanceof GL)) throw new TypeError('Invalid receiver');
          if (this.lost) return null;
          return parameter === 0x0d3a ? new Int32Array([16384, 16384]) : 'native';
        }
      }
      class GL2 extends GL { getParameter(parameter) { return super.getParameter(parameter); } }
      globalThis.WebGLRenderingContext = GL;
      globalThis.WebGL2RenderingContext = GL2;
      globalThis.navigator = {};
      const natives = [GL.prototype.getParameter, GL2.prototype.getParameter];
      (${installWorkerPassport.toString()})({ navigator: {}, videoCard: { vendor: 'Fixture vendor', renderer: 'Fixture renderer' } });
      (${installWebglLimits.toString()})(limits, { vendor: 'Fixture vendor', renderer: 'Fixture renderer' });
      const readings = [GL, GL2].map(Context => {
        const gl = new Context();
        const values = [gl.getParameter(0x9245), gl.getParameter(0x9246), gl.getParameter(0x0d33), Array.from(gl.getParameter(0x0d3a)), gl.getParameter(123)];
        let invalidReceiver = false;
        try { Context.prototype.getParameter.call({}, 0x9245); } catch (error) { invalidReceiver = error instanceof TypeError; }
        gl.lost = true;
        return { values, invalidReceiver, lost: gl.getParameter(0x9245) };
      });
      ({ readings, wrappers: wrapped.length, nativeTargets: wrapped.every((target, index) => target === natives[index]) });
    `, { limits });
    assert.equal(result.wrappers, 2);
    assert.equal(result.nativeTargets, true);
    for (const reading of result.readings) {
      assert.equal(reading.values[0], 'Fixture vendor');
      assert.equal(reading.values[1], 'Fixture renderer');
      assert.equal(reading.values[2], limits ? 8192 : 'native');
      assert.deepEqual(Array.from(reading.values[3]), limits ? [8192, 8192] : [16384, 16384]);
      assert.equal(reading.values[4], 'native');
      assert.equal(reading.invalidReceiver, true);
      assert.equal(reading.lost, null);
    }
  });
}

test('boxed WebGL enums are coerced once after receiver validation, including lost contexts', () => {
  const result = runInNewContext(`
    class GL {
      getParameter(parameter) {
        if (!(this instanceof GL)) throw new TypeError('Illegal invocation');
        if (!arguments.length) throw new TypeError('1 argument required');
        parameter = Number(parameter) >>> 0;
        return this.lost ? null : parameter;
      }
      isContextLost() { return Boolean(this.lost); }
    }
    globalThis.WebGLRenderingContext = GL;
    (${installWebglLimits})({ maxViewportDims: [8192, 8192] }, { vendor: 'Fixture vendor', renderer: 'Fixture renderer' });
    const gl = new GL(); let count = 0;
    const argument = { valueOf() { count++; return 0x9246; } };
    const renderer = gl.getParameter(argument), conversions = count;
    count = 0; let receiverError;
    try { GL.prototype.getParameter.call({}, argument); } catch (e) { receiverError = e.name; }
    const receiverConversions = count;
    const boxed = gl.getParameter(new Number(0x9245));
    function callable() {} callable.valueOf = () => { count++; return 0x9246; };
    const callableResult = gl.getParameter(callable);
    count = 0;
    const unknown = gl.getParameter({ valueOf() { count++; return 123; } }), unknownConversions = count;
    const dims = gl.getParameter({ valueOf() { return 0x0d3a; } }); dims[0] = 1;
    const freshDims = Array.from(gl.getParameter(new Number(0x0d3a)));
    let coercionError, missingError;
    try { gl.getParameter({ valueOf() { throw Error('conversion'); } }); } catch(e) { coercionError = e.message; }
    try { gl.getParameter(); } catch(e) { missingError = e.name; }
    gl.lost = true; count = 0;
    const lost = gl.getParameter(argument);
    ({renderer, conversions, receiverError, receiverConversions, boxed, callableResult, unknown,
      unknownConversions, freshDims, coercionError, missingError, lost, lostConversions: count});
  `);
  assert.equal(result.renderer, 'Fixture renderer'); assert.equal(result.conversions, 1);
  assert.equal(result.receiverError, 'TypeError'); assert.equal(result.receiverConversions, 0);
  assert.equal(result.boxed, 'Fixture vendor'); assert.equal(result.callableResult, 'Fixture renderer');
  assert.equal(result.unknown, 123); assert.equal(result.unknownConversions, 1);
  assert.deepEqual(Array.from(result.freshDims), [8192, 8192]);
  assert.equal(result.coercionError, 'conversion'); assert.equal(result.missingError, 'TypeError');
  assert.equal(result.lost, null); assert.equal(result.lostConversions, 1);
});
