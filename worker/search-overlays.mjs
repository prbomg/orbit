import { ensurePageReferences, searchReference } from './search-dom.mjs';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { activateElement } from './mobile-input.mjs';
import { sleep, TaskStoppedError } from './behavior.mjs';

function blocked() {
  const error = new Error('Search popup could not be closed');
  error.name = 'SearchError'; error.code = 'search_overlay_blocked';
  return error;
}
const contextChanged = error => /Execution context was destroyed|Cannot find context with specified id/.test(error.message);

// Only inspect the search engine document. Never accept a promotion or change settings.
export async function dismissSearchOverlays(page, { allowedHost, signal, shouldContinue = async () => true, log = () => {}, timeout = 5000 } = {}) {
  const active = async () => { signal?.throwIfAborted(); if (!await shouldContinue()) throw new TaskStoppedError(); };
  await active();
  if (!allowedHost(new URL(page.url()).hostname)) return false;
  let announced = false, dismissed = false, recognitionDeadline = performance.now() + timeout;
  let documentChanges = 0;
  const retryDocument = async () => {
    await active();
    if (++documentChanges > 3) {
      const error = new Error('Search document kept changing during interface inspection');
      error.name = 'SearchError'; error.code = 'search_navigation_unstable'; throw error;
    }
    // evaluateHandle may have waited for a slow navigation longer than the old
    // document's recognition budget. No overlay has been established by that
    // failed inspection: give the replacement document its own bounded check.
    recognitionDeadline = performance.now() + timeout;
    log('search_document_changed', { attempt: documentChanges, reason: 'interface_check_interrupted' });
    await sleep(50, signal);
  };
  for (let attempt = 0; attempt <= 3; attempt++) {
    await active();
    if (!allowedHost(new URL(page.url()).hostname)) return dismissed;
    try { await ensurePageReferences(page); }
    catch(error) {
      if(!contextChanged(error))throw error;
      await retryDocument();attempt--;continue;
    }
    const token = `overlay:${randomUUID()}`;
    const overlay = await page.evaluateHandle(token => {
      const selectors = '[role="dialog"], [aria-modal="true"], [class*="popup" i], [class*="modal" i], [class*="dialog" i], [class*="sheet" i], [class*="overlay" i]';
      const visible = el => {
        const r = el.getBoundingClientRect(), s = getComputedStyle(el);
        return r.width > 5 && r.height > 5 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth && s.display !== 'none' && s.visibility === 'visible' && Number(s.opacity) > 0;
      };
      const exposed = el => {
        const r = el.getBoundingClientRect();
        const x = Math.max(0, Math.min(innerWidth - 1, r.left + r.width / 2));
        const y = Math.max(0, Math.min(innerHeight - 1, r.top + r.height / 2));
        return el.contains(document.elementFromPoint(x, y));
      };
      const candidates = [...document.querySelectorAll(selectors)].filter(el => {
        if (!visible(el) || !exposed(el)) return false;
        const text = (el.innerText || '').slice(0, 6000);
        if (/captcha|капч|подтвердите.{0,40}(?:робот|человек)|не робот/i.test(text + ' ' + el.className) || el.querySelector('iframe[src*="captcha"], [class*="captcha" i]')) return false;
        const promo = /(?:сделайте|сделать|назначить|установить|установите).{0,90}(?:основн|по умолчанию)|(?:основн|по умолчанию).{0,70}(?:поиск|браузер)|(?:скачайте|установите|откройте|открыть).{0,50}(?:приложени|браузер)|включите уведомления|разрешить уведомления/is.test(text);
        const semantic = el.matches('[aria-modal="true"], [role="dialog"]') && !el.querySelector('input[name="text"],textarea[name="text"],[role="searchbox"]');
        const floating = [el, ...Array.from((function* () { let p = el.parentElement; while (p && p !== document.body) { yield p; p = p.parentElement; } })())].some(p => ['fixed', 'absolute'].includes(getComputedStyle(p).position));
        return semantic || promo && floating;
      });
      // Prefer the outer overlay: its close control can be a sibling of the bottom sheet.
      const root = candidates.find(el => !candidates.some(parent => parent !== el && parent.contains(el)));
      if (!root) return null;
      const controls = 'button, [role="button"], a, [class*="close" i], [class*="dismiss" i], [data-testid*="close" i], [data-icon*="close" i]';
      const close = [...document.querySelectorAll(controls)].filter(el => {
        if (!visible(el) || !exposed(el) || el.disabled || el.getAttribute('aria-disabled') === 'true' || el.matches('[type="reset"]')) return false;
        const label = [el.getAttribute('aria-label'), el.getAttribute('title'), el.textContent].filter(Boolean).join(' ').trim();
        // Yandex uses Button_view_clear for the visual style of BOTH its close
        // and confirmation buttons. It does not identify a search-clear action.
        const metadata = [el.getAttribute('data-testid'), el.getAttribute('data-icon'), typeof el.className === 'string' ? el.className.replace(/\bButton_view_clear\b/gi, '') : ''].filter(Boolean).join(' ');
        if (/очистить|clear|сбросить/i.test(label) || !/закрыть|close|dismiss/i.test(label) && /очистить|clear|сбросить/i.test(metadata)) return false;
        const name = `${label} ${metadata}`.trim();
        const identity = /закрыть|close|dismiss/i.test(name) || /^[×✕✖xх]$/i.test(el.textContent.trim()) || Boolean(el.querySelector('use[href*="close" i],use[*|href*="close" i]'));
        if (!identity) return false;
        if (root.contains(el)) return true;
        // A detached cross is allowed only in the same floating wrapper, never in the search form.
        let wrapper = root.parentElement;
        while (wrapper && wrapper !== document.body && wrapper !== document.documentElement) {
          if (wrapper.contains(el) && ['fixed', 'absolute'].includes(getComputedStyle(wrapper).position) && !el.closest('form')) return true;
          wrapper = wrapper.parentElement;
        }
        return false;
      });
      const button = close[0] || null;
      const references=window[Symbol.for('__ OrbitSearchRefs')];
      for(const key of references.keys())if(key.startsWith('overlay:'))references.delete(key);
      if(button)references.set(token,button);
      return { root, button };
    }, token).catch(error => { if (contextChanged(error)) return null; throw error; });
    if (!overlay) {
      await retryDocument(); attempt--; continue;
    }
    try {
      if (await overlay.evaluate(value => value === null)) return dismissed;
      if (!announced) { log('search_popup_detected', { reason: await overlay.evaluate(({ root }) => root.matches('[role="dialog"], [aria-modal="true"]') ? 'semantic_dialog' : 'promotion_prompt'), element: await overlay.evaluate(({ button }) => button ? 'close_button' : 'missing_close_button') }); announced = true; }
      if (attempt === 3) { log('search_popup_blocked'); throw blocked(); }
      if (!await overlay.evaluate(value => Boolean(value.button))) {
        if (performance.now() >= recognitionDeadline) { log('search_popup_blocked'); throw blocked(); }
        await sleep(100, signal); attempt--; continue;
      }
      await active();
      try { await activateElement(searchReference(page,token), { timeout, signal }); }
      catch (error) {
        signal?.throwIfAborted();
        if (error.name !== 'TimeoutError') throw error;
        log('search_popup_blocked'); throw blocked();
      }
      const deadline = performance.now() + timeout;
      let gone = false;
      while (performance.now() < deadline) {
        await active();
        gone = await overlay.evaluate(({ root }) => {
          if (!root.isConnected) return true;
          const r = root.getBoundingClientRect(), s = getComputedStyle(root);
          return s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0 || !r.width || !r.height || r.bottom <= 0 || r.top >= innerHeight;
        }).catch(error => {
          // The old document (and its prompt) is gone after navigation. Inspect
          // the replacement document on the next iteration instead of polling
          // a permanently invalid handle until a false timeout.
          if (contextChanged(error)) return true;
          throw error;
        });
        if (gone) break;
        await sleep(100, signal);
      }
      if (!gone) {
        // Mobile pages can ignore a tap while their event handlers initialize.
        // Re-detect the close control, bounded by the same three-tap limit.
        if (attempt < 2) { log('search_popup_retry'); continue; }
        log('search_popup_blocked'); throw blocked();
      }
      dismissed = true; announced = false; recognitionDeadline = performance.now() + timeout; log('search_popup_closed');
    } catch (error) {
      if (!contextChanged(error)) throw error;
      await retryDocument(); attempt--;
    } finally {
      await page.evaluate(token=>window[Symbol.for('__ OrbitSearchRefs')]?.delete(token),token).catch(()=>{});
      await overlay.dispose().catch(() => {});
    }
  }
  // Reappearing dialogs must not trap the worker in an unbounded clicking loop.
  log('search_popup_blocked'); throw blocked();
}
