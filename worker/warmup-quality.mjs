// Requirements describe test coverage, not a third-party assessment of a visitor.
export function assessVisit({ requirements = 'interaction', content = false, shortPage = false, movedPixels = 0, linkResult = false, returned = false }) {
  const link = ['url_changed', 'content_changed'].includes(linkResult);
  const interaction = Math.abs(movedPixels) > 0 || link || shortPage;
  const passed = content && (requirements === 'content' || requirements === 'return' ? requirements !== 'return' || returned : requirements === 'navigation' ? link : interaction);
  return { quality: passed ? 'passed' : 'partial', reason: !content ? 'content_unavailable' : requirements === 'return' && !returned ? 'return_not_confirmed' : requirements === 'navigation' && !link ? 'navigation_not_confirmed' : !passed ? 'interaction_not_confirmed' : shortPage && !link && !movedPixels ? 'short_page' : 'requirements_met', confirmedScrollPixels: Math.round(Math.abs(movedPixels)), confirmedLinks: link ? 1 : 0, contentConfirmed: content ? 1 : 0 };
}
export function inspectContent(page) {
  return page.evaluate(() => {
    const root = document.scrollingElement;
    const visible = node => { const rect = node.getBoundingClientRect(), style = getComputedStyle(node); return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'; };
    const content = Boolean(document.body && visible(document.body) && ((document.body.innerText || '').trim().length > 0 || [...document.images].some(img => img.complete && img.naturalWidth > 16 && visible(img))));
    const nestedScroll = [...document.querySelectorAll('main,section,article,div')].slice(0, 3000).some(node => visible(node) && /auto|scroll/.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight + 2);
    return { content, shortPage: Boolean(root && root.scrollHeight <= innerHeight + 2 && !nestedScroll) };
  });
}
