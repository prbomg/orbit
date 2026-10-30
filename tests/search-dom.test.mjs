import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { prepareSearchReferences, searchReference, withSameTabLink } from '../worker/search-dom.mjs';
import { findInSerpOrPaginate } from '../worker/search.mjs';

const launch = { headless: true, executablePath: process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH };
async function fixture(run) {
  const browser = await chromium.launch(launch);
  try { const context = await browser.newContext(); await run(await context.newPage(), context); }
  finally { await browser.close(); }
}

test('page-realm search references are non-enumerable, do not stamp HTML and reject detached replacements', async () => {
  await fixture(async page => {
    await page.setContent('<a id="result" href="/one">One</a><button id="next">Next</button>');
    const before = await page.content();
    await prepareSearchReferences(page, true);
    await page.evaluate(() => {
      const map = window[Symbol.for('__ OrbitSearchRefs')];
      map.set('result-one', document.querySelector('#result'));
      map.set('next:one', document.querySelector('#next'));
    });
    assert.equal(await searchReference(page, 'result-one').textContent(), 'One');
    assert.equal(await searchReference(page, 'next:one').textContent(), 'Next');
    assert.equal(await page.content(), before);
    assert.equal(await page.evaluate(() => Object.getOwnPropertyDescriptor(window, Symbol.for('__ OrbitSearchRefs')).enumerable), false);
    await prepareSearchReferences(page);
    assert.equal(await searchReference(page, 'next:one').count(), 0);
    assert.equal(await searchReference(page, 'result-one').count(), 1);
    await page.evaluate(() => document.querySelector('#result').outerHTML = '<a id="result" href="/changed">Replacement</a>');
    assert.equal(await searchReference(page, 'result-one').count(), 0, 'a replacement never inherits the old reference');
    await prepareSearchReferences(page, true);
    assert.equal(await page.evaluate(() => window[Symbol.for('__ OrbitSearchRefs')].size), 0);
  });
});

test('tokens resolve only inside their owning page realm', async () => {
  await fixture(async (page, context) => {
    const other = await context.newPage();
    for (const [current, label] of [[page, 'First'], [other, 'Second']]) {
      await current.setContent(`<a>${label}</a>`); await prepareSearchReferences(current, true);
      await current.evaluate(() => window[Symbol.for('__ OrbitSearchRefs')].set('shared-token', document.querySelector('a')));
    }
    assert.equal(await searchReference(page, 'shared-token').textContent(), 'First');
    assert.equal(await searchReference(other, 'shared-token').textContent(), 'Second');
  });
});

for (const target of [null, '', '_blank', '_parent', '_self']) test(`same-tab activation restores the exact target attribute (${target})`, async () => {
  await fixture(async page => {
    await page.setContent('<a id="link" href="/next">Next</a>');
    const anchor = page.locator('#link');
    if (target !== null) await anchor.evaluate((el, target) => el.setAttribute('target', target), target);
    assert.equal(await withSameTabLink(anchor, async () => {
      assert.equal(await anchor.getAttribute('target'), '_self'); return 'activated';
    }, 1000), 'activated');
    assert.equal(await anchor.getAttribute('target'), target);
    const stopped = new Error('cancelled_or_failed');
    await assert.rejects(withSameTabLink(anchor, async () => { throw stopped; }, 1000), error => error === stopped);
    assert.equal(await anchor.getAttribute('target'), target);
  });
});

test('pagehide restores target before the old document can enter BFCache', async () => {
  await fixture(async page => {
    await page.setContent('<a id="link" target="_blank">Next</a>');
    const anchor = page.locator('#link');
    await withSameTabLink(anchor, async () => {
      await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
      assert.equal(await anchor.getAttribute('target'), '_blank');
    }, 1000);
    assert.equal(await anchor.getAttribute('target'), '_blank');
  });
});

test('AJAX pagination adds no search marker attributes and restores target on the retained next link', async () => {
  await fixture(async (page, context) => {
    await context.route('http://search.test/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html>
      <ul><li class="serp-item"><h2><a href="http://other.test/">Other</a></h2></li></ul>
      <nav class="Pager"><a id="next" target="_blank" href="/page2" onclick="event.preventDefault();document.querySelector('ul').innerHTML='<li class=serp-item><h2><a href=http://target.test/>Target</a></h2></li>'">Далее</a></nav>
      <script>window.markerMutations=[];new MutationObserver(records=>{for(const r of records)if(/^data-worker-search-(result|next)$/.test(r.attributeName))markerMutations.push(r.attributeName);}).observe(document.documentElement,{attributes:true,subtree:true});</script>` }));
    await page.goto('http://search.test/');
    const session = { timeout: 2000, searchDomains: ['search.test'], document: async () => {}, check: async () => {}, pause: async () => {}, log: () => {} };
    const result = await findInSerpOrPaginate(page, { targetDomain: 'target.test' }, session);
    assert.equal(result.pagesVisited, 2); assert.equal(result.target.domain, 'target.test');
    assert.equal(await page.locator('#next').getAttribute('target'), '_blank');
    assert.deepEqual(await page.evaluate(() => window.markerMutations), []);
    assert.equal(await page.locator('[data-worker-search-result],[data-worker-search-next]').count(), 0);
    assert.equal(await searchReference(page, result.target.token).getAttribute('href'), 'http://target.test/');
    assert.equal(context.pages().length, 1);
    assert.equal(await page.evaluate(() => window[Symbol.for('__ OrbitSearchRefs')].size), 1, 'a rescan releases the preceding page references');
  });
});

for (const target of [null, '', '_self', '_top', '_blank', 'named-window']) test(`form submission restores its target and avoids redundant main-frame writes (${target})`, async () => {
  const { withSameTabForm } = await import('../worker/search-dom.mjs');
  await fixture(async page => {
    await page.setContent('<form><input name="q"><button>Search</button></form>');
    const input = page.locator('input'), form = page.locator('form');
    if (target !== null) await form.evaluate((el, value) => el.setAttribute('target', value), target);
    await page.evaluate(() => {
      window.targetWrites = [];
      new MutationObserver(records => targetWrites.push(...records.map(r => r.attributeName)))
        .observe(document.querySelector('form'), { attributes: true });
    });
    const overridden = ![null, '', '_self', '_top'].includes(target);
    await withSameTabForm(input, async () => {
      assert.equal(await form.getAttribute('target'), overridden ? '_top' : target);
    }, 1000);
    assert.equal(await form.getAttribute('target'), target);
    if (!overridden) assert.deepEqual(await page.evaluate(() => targetWrites), []);
    await assert.rejects(withSameTabForm(input, async () => { throw Error('fixture-cancelled'); }, 1000), /fixture-cancelled/);
    assert.equal(await form.getAttribute('target'), target);
    await withSameTabForm(input, async () => {
      await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
      assert.equal(await form.getAttribute('target'), target);
    }, 1000);
  });
});

test('iframe forms restore absent and explicit targets after AJAX submission', async () => {
  const { withSameTabForm } = await import('../worker/search-dom.mjs');
  const { prepareSearchQuery, submitSearch } = await import('../worker/search.mjs');
  await fixture(async page => {
    await page.setContent('<form action="/search"><iframe class="search-frame" srcdoc="<form onsubmit=\'event.preventDefault();window.submitted=true\'><input name=q><button type=submit>Search</button></form>"></iframe></form>');
    const input = page.frameLocator('iframe').locator('input');
    await input.waitFor();
    const frame = page.frames().find(frame => frame !== page.mainFrame()), form = frame.locator('form');
    for (const target of [null, '', '_self', '_blank', '_top']) {
      await form.evaluate((el, target) => target === null ? el.removeAttribute('target') : el.setAttribute('target', target), target);
      await withSameTabForm(input, async () => assert.equal(await form.getAttribute('target'), '_top'), 1000);
      assert.equal(await form.getAttribute('target'), target);
    }
    await form.evaluate(el => el.removeAttribute('target'));
    // Preparation must not mutate the form before submission begins.
    await prepareSearchQuery(page, 'q', '', { allowedHost: () => true, timeout: 2000, check: async () => {}, document: async () => {} });
    assert.equal(await form.getAttribute('target'), null);
    await submitSearch(input, 2000, () => {}, { expected: 'q' });
    assert.equal(await frame.evaluate(() => submitted), true);
    assert.equal(await form.getAttribute('target'), null);
  });
});
