import test from 'node:test';
import assert from 'node:assert/strict';
import {previewPlan} from '../worker/search-preview-policy.mjs';
test('preview selects one or two unique non-target domains only from top five and skips at 65 percent threshold',()=>{
 const results=['target.test','a.test','a.test','b.test','sub.target.test','six.test'].map(domain=>({domain,destination:'https://'+domain}));
 assert.deepEqual(previewPlan(results,'target.test',()=>0.65),[]);
 const draws=[0.64,0.99,0,0],chosen=previewPlan(results,'target.test',()=>draws.shift());assert.deepEqual(chosen.map(r=>r.domain),['a.test','b.test']);
 assert.equal(previewPlan(results,'target.test',()=>0).length,1);assert.deepEqual(previewPlan([],'target.test',()=>0),[]);
});
