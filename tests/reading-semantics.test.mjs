import test from 'node:test';
import assert from 'node:assert/strict';
import { readingPause, linkSemantics } from '../worker/reading-semantics.mjs';
import { assessVisit } from '../worker/warmup-quality.mjs';
test('reading time depends on block length and type, with bounded jitter', () => {
 assert.ok(readingPause({words:3}) < 1800);
 assert.ok(readingPause({words:3,kind:'heading'}) < readingPause({words:3}));
 assert.ok(readingPause({words:30,kind:'specification'}) > readingPause({words:30}));
 assert.ok(readingPause({words:100000},()=>1) <= 6600);
});
test('intent favors relevant text and breadcrumb context, legal/action/file/nofollow links are excluded', () => {
 const score = text => linkSemantics({href:'https://example.com/article',text,intent:'Выбор велосипеда'}).relevance;
 assert.ok(score('Велосипеды и аксессуары') > score('Садовые инструменты'));
 assert.ok(linkSemantics({href:'https://example.com/article',context:'Велосипеды',intent:'велосипед'}).relevance > 0);
 for(const path of ['privacy','consent','logout','checkout','terms','privacy-policy.html','cookie-settings','terms.php','file.pdf']) assert.equal(linkSemantics({href:`https://example.com/${path}`}).allowed,false);
 for(const rel of ['nofollow','sponsored','nofollow noopener']) assert.equal(linkSemantics({href:'https://example.com/a',rel}).allowed,false);
 assert.equal(linkSemantics({href:'javascript:void(0)'}).allowed,false);
 assert.equal(linkSemantics({href:'https://example.com/a',text:'Политика конфиденциальности'}).allowed,false);
});
test('unconfirmed click never increases quality or confirmed link count', () => {
 const quality=assessVisit({requirements:'navigation',content:true,linkResult:'no_change'});
 assert.equal(quality.quality,'partial');assert.equal(quality.confirmedLinks,0);
});

test('weighted choice favors relevance without eliminating other safe links', async () => {
 const {chooseReadingLink}=await import('../worker/reading-semantics.mjs');
 const {createBehaviorRandom}=await import('../worker/behavior-random.mjs');
 const random=createBehaviorRandom('relevance');let relevant=0;
 const candidates=[{href:'https://example.com/bikes',text:'Велосипеды'},{href:'https://example.com/garden',text:'Сад'}];
 for(let i=0;i<1000;i++)if(chooseReadingLink(candidates,'велосипед',random)===candidates[0])relevant++;
 assert.ok(relevant>850&&relevant<1000);
 assert.equal(chooseReadingLink([{href:'https://example.com/legal'}],'',random),null);
});
