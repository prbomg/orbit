import { test } from 'node:test';
import assert from 'node:assert/strict';
import state from '../utils/sessionState.js';
const snapshot = record => ({ savedAt: new Date().toISOString(), cookies: [], origins: [{ origin: 'https://example.com', localStorage: [], indexedDB: [{ name: 'session', version: 1, stores: [{ name: 'records', autoIncrement: false, indexes: [], records: [record] }] }] }] });
const compare = (expected, actual) => state.compareRestoredSession(snapshot(expected), snapshot(actual));
test('IndexedDB JSON and encoded exports compare by data rather than serialization format', () => {
  const encoded = { valueEncoded: { o: [{ k: 'id', v: 1 }, { k: 'preferences', v: { o: [{ k: 'flag', v: false }, { k: 'cache', v: { o: [], id: 3 } }], id: 2 } }], id: 1 } };
  const plain = { value: { preferences: { cache: {}, flag: false }, id: 1 } };
  assert.equal(compare(encoded, plain).status, 'passed');
  assert.equal(compare(plain, encoded).status, 'passed');
  assert.equal(compare(encoded, { value: { ...plain.value, id: 2 } }).status, 'failed');
  assert.equal(compare({ keyEncoded: 1, valueEncoded: { v: 'null' } }, { key: 1, value: null }).status, 'passed');
  assert.equal(compare({ valueEncoded: false }, { value: false }).status, 'passed');
});
test('IndexedDB comparison retains types, negative zero and cyclic/shared references', () => {
  assert.equal(compare({ valueEncoded: { d: '2026-01-01T00:00:00.000Z' } }, { value: '2026-01-01T00:00:00.000Z' }).status, 'failed');
  assert.equal(compare({ valueEncoded: { ta: { k: 'ui8', b: 'AQID' } } }, { valueEncoded: { ta: { k: 'ui8c', b: 'AQID' } } }).status, 'failed');
  assert.equal(compare({ valueEncoded: { v: '-0' } }, { value: 0 }).status, 'failed');
  const a = { valueEncoded: { o: [{ k: 'self', v: { ref: 1 } }, { k: 'nested', v: { o: [], id: 2 } }], id: 1 } };
  const b = { valueEncoded: { o: [{ k: 'nested', v: { o: [], id: 44 } }, { k: 'self', v: { ref: 43 } }], id: 43 } };
  assert.equal(compare(a, b).status, 'passed');
  assert.equal(compare(a, { valueEncoded: { ref: 999 } }).status, 'failed');
});

test('cookie verification reports mismatch fields without names or values',()=>{
 const cookie={name:'private-name',value:'private-before',domain:'example.test',path:'/',expires:Date.now()/1000+3600,secure:true,httpOnly:true,sameSite:'Lax'};
 const saved={savedAt:new Date().toISOString(),cookies:[cookie],origins:[]};
 const report=state.compareRestoredSession(saved,{cookies:[{...cookie,value:'private-after'}],origins:[]});
 assert.equal(report.missingCookies,1);assert.equal(report.cookieMismatches.value,1);assert.equal(report.cookieMismatches.expires,0);
 assert.ok(!JSON.stringify(report).includes('private-'));
});
