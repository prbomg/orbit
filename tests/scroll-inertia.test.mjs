import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { finishTouchScroll } from '../worker/scroll-inertia.mjs';

async function fixture(run) {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.ORBIT_TEST_CHROMIUM_EXECUTABLE_PATH || undefined });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await page.setContent('<meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}#box{height:400px;overflow:auto;scroll-behavior:smooth}</style><section id="box"><div style="height:2000px"></div></section><main style="height:8000px"></main>');
    const state = await page.evaluateHandle(() => {
      const node = document.querySelector('#box');node.scrollTo({ top: 100, behavior: 'instant' });
      return { node, nodes: [{ el: node, root: false, top: 0 }] };
    });
    try { await run(page, state); } finally { await state.dispose(); }
  } finally { await browser.close(); }
}

test('exponential release moves only the chosen surface in both directions and respects boundaries', async () => {
  await fixture(async (page, state) => {
    const first = await finishTouchScroll(state, { releasePosition: 100, velocity: 250 });
    assert.equal(first.method, 'exponential');
    assert(Math.abs(await page.locator('#box').evaluate(e => e.scrollTop) - 150) <= 1);
    assert.equal(await page.evaluate(() => scrollY), 0);
    await finishTouchScroll(state, { releasePosition: 150, velocity: -250 });
    assert(Math.abs(await page.locator('#box').evaluate(e => e.scrollTop) - 100) <= 2);
    await page.locator('#box').evaluate(e => e.scrollTo({ top: 1590, behavior: 'instant' }));
    await finishTouchScroll(state, { releasePosition: 1590, velocity: 250 });
    assert.equal(await page.locator('#box').evaluate(e => e.scrollTop), 1600);
    assert.equal(await page.evaluate(() => scrollY), 0);
  });
});

test('existing motion is allowed to settle without adding a second inertia curve', async () => {
  await fixture(async (page, state) => {
    await page.evaluate(() => {
      const node = document.querySelector('#box');const start = performance.now();
      const frame = () => { const elapsed = performance.now() - start;node.scrollTo({ top: 100 + Math.min(elapsed, 160) / 4, behavior: 'instant' });if (elapsed < 160) requestAnimationFrame(frame); };
      requestAnimationFrame(frame);
    });
    const result = await finishTouchScroll(state, { releasePosition: 100, velocity: 400 });
    assert.equal(result.method, 'native');assert.equal(result.settled, true);
    assert.equal(await page.locator('#box').evaluate(e => e.scrollTop), 140);
  });
});

test('blocked drags do not get artificial scroll and an aborted release stops promptly', async () => {
  await fixture(async (page, state) => {
    await state.evaluate(s => { s.nodes[0].top = 100; });
    assert.equal((await finishTouchScroll(state, { releasePosition: 100, velocity: 300 })).method, 'none');
    assert.equal(await page.locator('#box').evaluate(e => e.scrollTop), 100);
    await state.evaluate(s => { s.nodes[0].top = 0; });
    const controller = new AbortController();
    await page.exposeFunction('stopInertia', () => controller.abort());
    await page.locator('#box').evaluate(node => node.addEventListener('scroll', () => window.stopInertia(), { once: true }));
    await assert.rejects(finishTouchScroll(state, { releasePosition: 100, velocity: 400, signal: controller.signal }), { name: 'AbortError' });
    const stopped = await page.locator('#box').evaluate(e => e.scrollTop);
    await page.waitForTimeout(100);
    assert.equal(await page.locator('#box').evaluate(e => e.scrollTop), stopped);
    assert(stopped < 228);
  });
});
