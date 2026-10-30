import test from 'node:test';
import assert from 'node:assert/strict';
import { pageSessions } from '../worker/page-session.mjs';
import { sampleKeystrokeDelay } from '../worker/keystroke-cadence.mjs';

function seededRandom(seed = 12345) {
  return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
}

test('keystroke intervals have a 110 ms median, a right tail and 45–380 ms bounds', () => {
  const random = seededRandom();
  const values = Array.from({ length: 20000 }, () => sampleKeystrokeDelay('а', 'б', random)).sort((a, b) => a - b);
  assert.ok(values.every(value => Number.isInteger(value) && value >= 45 && value <= 380));
  assert.ok(Math.abs(values[10000] - 110) <= 2);
  assert.ok(values[18000] >= 180 && values[18000] <= 200);
  assert.ok(values.filter(value => value > 250).length / values.length < .04);
  assert.ok(values.filter(value => value > 250).length / values.length > .01);
  assert.equal(sampleKeystrokeDelay('a', 'b', () => 0), 380);
  assert.equal(sampleKeystrokeDelay('a', 'b', () => 1), 110);
});

test('word boundaries increase the sampled interval by 1.3–1.5 before the final clamp', () => {
  const draw = multiplier => { const values = [.5, .25, multiplier]; return () => values.shift(); };
  assert.equal(sampleKeystrokeDelay('a', 'b', draw(.5)), 110);
  for (const [previous, character] of [['a', ' '], [' ', 'б'], ['\t', '🙂'], ['а', '\n']]) {
    assert.equal(sampleKeystrokeDelay(previous, character, draw(0)), 143);
    assert.equal(sampleKeystrokeDelay(previous, character, draw(.5)), 154);
    assert.equal(sampleKeystrokeDelay(previous, character, draw(1)), 165);
    assert.equal(sampleKeystrokeDelay(previous, character, () => 0), 380);
  }
});

test('stopping during an inter-character pause prevents the next character', async () => {
  const { typeTextHumanLike } = await import('../worker/search.mjs');
  const stopped = new Error('typing_stopped');
  let stop = false;
  const element = { value: '' };
  element.ownerDocument = { activeElement: element, hasFocus: () => true };
  const page = {
    evaluate: async () => true,
  };
  const calls=[];
  pageSessions.set(page,{send:async(method,{text})=>{
    calls.push(method);
    if(method==='Input.insertText'){element.value+=text;setTimeout(()=>{stop=true;},0);}
  }});
  const input = { page: () => page, evaluate: async fn => fn(element), selectText: async () => {} };
  await assert.rejects(typeTextHumanLike(input, 'ab', {
    check: async () => { if (stop) throw stopped; }, timeout: 1000,
  }), error => error === stopped);
  assert.equal(element.value, 'a');
  assert.deepEqual(calls,['Input.imeSetComposition','Input.insertText']);
  pageSessions.delete(page);
});
