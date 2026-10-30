// Bounded heuristic, not language understanding. Safe without a model service.
export function readingPause({ words = 0, kind = 'text' } = {}, random = () => .5) {
  const rate = kind === 'heading' ? 110 : kind === 'specification' ? 210 : 165;
  const base = kind === 'heading' ? 500 : 800;
  return Math.round(Math.min(6000, Math.max(base, base + Math.min(300, Math.max(0, words)) * rate)) * (.9 + .2 * random()));
}

// Self-contained so the same policy can be serialized into the page realm.
export function linkSemantics({ href, text = '', rel = '', context = '', intent = '' }) {
  let url;
  try { url = new URL(href); } catch { return { allowed: false, relevance: 0 }; }
  let path;
  try { path = decodeURIComponent(url.pathname + url.search); } catch { return { allowed: false, relevance: 0 }; }
  const label = `${path} ${text}`.toLowerCase();
  const unsafe = /(?:logout|signout|delete|remove|checkout|purchase|payment|unsubscribe)|оформить\s+заказ|оплатить|выйти/i;
  const legalPath = /(?:^|\/)(?:privacy(?:-policy)?|policy|terms(?:-of-use|-and-conditions)?|cookie(?:s|-policy|-settings|-consent)?|consent|legal|impressum|politika(?:-konfidencialnosti)?|soglasie|oferta)(?:\.(?:html?|php))?(?:\/|$|\?)/i.test(path);
  const legalText = /политик[аиу]\s+(?:обработки\s+персональных\s+данных|конфиденциальности)|согласие\s+на\s+обработку\s+персональных\s+данных|пользовательское\s+соглашение|(?:публичная\s+)?оферта|privacy\s+policy|terms\s+(?:of\s+(?:use|service)|and\s+conditions)|cookie\s+policy|^(?:consent|privacy|terms|cookies?|legal)$/i.test(text.trim());
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password || /\b(?:sponsored|nofollow)\b/i.test(rel) || unsafe.test(label) || legalPath || legalText || /\.(?:pdf|docx?|xlsx?|pptx?|odt|ods|odp|rtf|csv|zip|rar|7z|tar|gz|png|jpe?g|gif|webp|svg|ico|mp[34]|wav|webm|avi|exe|dmg)$/i.test(url.pathname)) return { allowed: false, relevance: 0 };
  const words = [...new Set(intent.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || [])].filter(word => !['купить','заказать','цена','сайт','товар','the','and'].includes(word)).map(word => word.slice(0,5));
  const haystack = `${label} ${context.toLowerCase()}`;
  return { allowed: true, relevance: words.filter(word => haystack.includes(word)).length };
}

export function chooseReadingLink(candidates, intent, random) {
  const eligible = candidates.flatMap(link => {
    const semantics = linkSemantics({ ...link, intent });
    return semantics.allowed ? [{ link, weight: 1 + semantics.relevance * 12 + Number(Boolean(link.contentLink)) }] : [];
  });
  if (!eligible.length) return null;
  let point = random() * eligible.reduce((sum, row) => sum + row.weight, 0);
  for (const row of eligible) { point -= row.weight; if (point < 0) return row.link; }
  return eligible.at(-1).link;
}

export function inspectReadingBlock(page) {
  return page.evaluate(() => {
    const main=document.querySelector('main,article,[role="main"]')||document.body;
    if(!main)return {words:0,kind:'text'};
    const blocks=[...main.querySelectorAll('h1,h2,h3,p,table,dl')].slice(0,160).filter(el=>{
      const r=el.getBoundingClientRect(),s=getComputedStyle(el);
      return r.height>0&&r.width>0&&r.top<innerHeight&&r.bottom>0&&s.visibility!=='hidden'&&s.display!=='none';
    });
    const element=blocks.find(el=>el.matches('p,table,dl'))||blocks[0]||main;
    return { words:Math.min(300,(element.innerText||'').trim().split(/\s+/).filter(Boolean).length),kind:element.matches('h1,h2,h3')?'heading':element.matches('table,dl')?'specification':'text' };
  });
}
