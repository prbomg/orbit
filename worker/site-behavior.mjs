import { ensurePageReferences } from './search-dom.mjs';
import { readingPause, linkSemantics } from './reading-semantics.mjs';
import visitPolicy from '../utils/visitSettings.js';
import {performance} from 'node:perf_hooks';
import {sleep} from './behavior.mjs';

export function canonicalVisitUrl(value){
 const url=new URL(value);url.hash='';for(const key of [...url.searchParams.keys()])if(/^utm_|^(?:yclid|gclid|fbclid)$/i.test(key))url.searchParams.delete(key);
 url.searchParams.sort();return url.href;
}

/** Inspect bounded DOM samples; return geometry and semantic hints, never executable page instructions. */
export async function inspectSite(page,{marker,domain,visited=[],sections=[],intent=''}={}){
 await ensurePageReferences(page);
 const view=await page.evaluate(({marker,domain,visited,intent})=>{
  const mapSymbol=Symbol.for('__ WeakSurfaceIds');
  if(!window[mapSymbol])Object.defineProperty(window,mapSymbol,{value:new WeakMap(),enumerable:false});
  const surfaceMap=window[mapSymbol];
  const vh=innerHeight,vw=innerWidth;
  const header=document.querySelector('header'),headerRect=header?.getBoundingClientRect();
  const safeTop=header&&/fixed|sticky/.test(getComputedStyle(header).position)&&headerRect.bottom<vh*.4?Math.max(8,headerRect.bottom):8;
  const main=document.querySelector('main,[role="main"],article')||document.body;
  
  // ЭВРИСТИКА: Расширенный и гибкий поиск карточек товаров/услуг
  const cardSelector='[data-product],.product-card,.catalog-item,[itemtype$="/Product"],.product-item,[class*="product-card"],[class*="productCard"],[class*="item-card"],[class*="catalog__item"]';
  
  const cards=main.querySelectorAll(cardSelector).length;
  const type=cards>=3?'catalog':main.matches('article')||main.querySelector('article')?'article':main.querySelector('[itemprop="sku"],[itemprop="price"],.product-description,.product-detail')?'product':'generic';
  const readable=element=>{
   if(element.closest('[hidden],[inert],[aria-hidden="true"],[aria-disabled="true"]'))return false;
   for(let el=element;el;el=el.parentElement){const s=getComputedStyle(el);if(s.display==='none'||s.visibility==='hidden'||s.opacity==='0'||s.pointerEvents==='none')return false;}return true;
  };
  const geometry=element=>{
   const r=element.getBoundingClientRect();let viewportTop=safeTop,viewportBottom=vh-16,left=Math.max(r.left,8),right=Math.min(r.right,vw-8);
   for(let p=element.parentElement;p&&p!==document.body;p=p.parentElement){const style=getComputedStyle(p);if(/auto|scroll|hidden|clip/.test(style.overflowY)){const box=p.getBoundingClientRect();viewportTop=Math.max(viewportTop,box.top);viewportBottom=Math.min(viewportBottom,box.bottom);}}
   const top=Math.max(r.top,viewportTop),bottom=Math.min(r.bottom,viewportBottom);
   const visible=bottom>top&&right>left;
   let accessible=false;
   if(visible){for(const ry of [.5,.2,.8]){for(const rx of [.5,.2,.8]){const hit=document.elementFromPoint(left+(right-left)*rx,top+(bottom-top)*ry);const nested=hit?.closest('button,input,select,textarea,[role="button"],[role="slider"]');if(hit&&element.contains(hit)&&(!nested||nested===element||!element.contains(nested))){accessible=true;break;}}if(accessible)break;}}
   let scrollKey='page';
   for(let p=element.parentElement;p&&p!==document.scrollingElement;p=p.parentElement)if(/auto|scroll/.test(getComputedStyle(p).overflowY)&&p.scrollHeight>p.clientHeight+2){scrollKey=surfaceMap.get(p);if(!scrollKey){scrollKey=`surface-${(surfaceMap.nextId=(surfaceMap.nextId||0)+1)}`;surfaceMap.set(p,scrollKey);}break;}
   return {top:r.top,bottom:r.bottom,height:r.height,viewportTop,viewportBottom,scrollKey,visible,accessible,visibleRatio:visible?Math.min(1,(bottom-top)/Math.max(1,r.height)):0};
  };
  const fingerprint=value=>{let hash=2166136261;for(const char of value)hash=Math.imul(hash^char.charCodeAt(0),16777619);return hash>>>0;};
  const references=window[Symbol.for('__ OrbitSearchRefs')];
  for(const token of references.keys())if(token.startsWith('site:'))references.delete(token);
  const idsSymbol=Symbol.for('__ OrbitSiteIds');
  if(!window[idsSymbol])Object.defineProperty(window,idsSymbol,{value:{elements:new WeakMap(),next:0},enumerable:false});
  const ids=window[idsSymbol];
  const remember=element=>{let token=ids.elements.get(element);if(!token){token=`site:${++ids.next}`;ids.elements.set(element,token);}references.set(token,element);return token;};
  const goals=intent.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu)?.filter(w=>!['купить','заказать','цена','сайт','товар','the','and'].includes(w)).map(w=>w.slice(0,5))||[];
  const blocks=[];
  for(const element of [...main.querySelectorAll(`h1,h2,h3,p,table,dl,${cardSelector},[class*="description"],[class*="specification"]`)].slice(0,160)){
   if(!readable(element))continue;const g=geometry(element);if(g.height<10)continue;
   const card=element.closest(cardSelector);if(card&&card!==element&&!/^H[123]$/.test(element.tagName))continue;
   const text=(element.innerText||'').trim();if(!text&&element.tagName!=='TABLE')continue;
   const id=remember(element);
   const kind=/^H[123]$/.test(element.tagName)?'heading':element.matches(cardSelector)?'card':element.matches('table,dl,[class*="specification"]')?'specification':'text';
   blocks.push({id,kind,relevance:goals.filter(goal=>text.toLowerCase().includes(goal)).length,revision:fingerprint(text.slice(0,1000).replace(/\b\d[\d:.,/-]*\b/g,'#')),words:Math.min(300,text.split(/\s+/).length),...g});
   if(blocks.length>=80)break;
  }

  const links=[];
  for(const a of [...new Set([...main.querySelectorAll('a[href]'),...document.querySelectorAll('a[href]')])].slice(0,1500)){
   try{
    const url=new URL(a.href);url.hash='';for(const key of [...url.searchParams.keys()])if(/^utm_|^(?:yclid|gclid|fbclid)$/i.test(key))url.searchParams.delete(key);url.searchParams.sort();
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password||!(url.hostname===domain||url.hostname.endsWith(`.${domain}`))||visited.includes(url.href)||url.href===location.href.split('#')[0]||a.hasAttribute('download')||/\b(?:sponsored|nofollow)\b/i.test(a.rel)||
      /(?:logout|signout|delete|remove|checkout|purchase|payment|unsubscribe)/i.test(decodeURIComponent(url.pathname+url.search))||/\.(?:pdf|docx?|xlsx?|pptx?|odt|ods|odp|rtf|csv|zip|rar|7z|tar|gz|png|jpe?g|gif|webp|svg|ico|mp[34]|wav|webm|avi|exe|dmg)$/i.test(url.pathname)||
      a.closest('[role="button"],[aria-haspopup="dialog"]')||!readable(a))continue;
    const g=geometry(a);if(!g.height||!a.getBoundingClientRect().width)continue;
    const zone=a.closest('footer')?'footer':a.closest('nav,header,aside')?'navigation':main.contains(a)?'main':'other';
    const text=(a.innerText||a.getAttribute('aria-label')||a.querySelector('img')?.alt||'').toLowerCase().slice(0,300);
    if(/(?:^|\/)(?:politika|politika-konfidencialnosti|privacy(?:-policy)?|policy|terms(?:-of-use|-and-conditions)?|cookie(?:s|-policy)?|consent|soglasie)(?:\/|$)/i.test(decodeURIComponent(url.pathname))||
      /политик[аиу]\s+(?:обработки\s+персональных\s+данных|конфиденциальности)|согласие\s+на\s+обработку\s+персональных\s+данных|пользовательское\s+соглашение|privacy\s+policy|terms\s+(?:of\s+(?:use|service)|and\s+conditions)|cookie\s+policy/i.test(text))continue;
    
    // Более умное определение карточек товаров для оценки качества ссылок
    const isProductLink = a.closest(cardSelector) || /(?:product|item|kartochka|tovar|p|id)[\/-]\d+/i.test(url.pathname);
    const kind=isProductLink?'product':/каталог|категори|catalog|category|ассортимент/.test(text+' '+url.pathname)?'category':'link';
    
    let score=zone==='main'?40:zone==='footer'?-60:zone==='navigation'?0:10;
    const context=[a.closest(cardSelector)?.innerText,a.closest('section,article')?.querySelector('h1,h2,h3')?.innerText,document.querySelector('[aria-label*=breadcrumb i],.breadcrumbs,[itemtype$=BreadcrumbList]')?.innerText].filter(Boolean).join(' ').toLowerCase().slice(0,700);
    const matches=new Set(goals.filter(goal=>text.includes(goal)||context.includes(goal)||url.pathname.toLowerCase().includes(goal))).size;
    score+=matches?25+Math.min(66,matches*22):0;
    if(type==='catalog'&&kind==='product')score+=30;
    if(type==='generic'&&kind==='category')score+=35;
    if(type==='article'&&zone==='main')score+=10;
    const token=remember(a);
    links.push({token,href:a.href,semantics:{text,rel:a.rel,context},canonical:url.href,kind,zone,score,...g});
    if(links.length>=100)break;
   }catch{}
  }
  let box={left:8,right:vw-8,top:safeTop,bottom:vh-16},scrollTop=scrollY,scrollMax=Math.max(0,Math.max(document.documentElement.scrollHeight,document.body?.scrollHeight||0)-vh),scroller='page';
  for(const el of [main,...main.querySelectorAll('div,section')].slice(0,120)){
   const r=el.getBoundingClientRect();if(el.clientHeight>140&&el.scrollHeight>el.clientHeight+20&&/auto|scroll/.test(getComputedStyle(el).overflowY)&&r.bottom>100&&r.top<vh-100){box={left:Math.max(8,r.left),right:Math.min(vw-8,r.right),top:Math.max(safeTop,r.top),bottom:Math.min(vh-16,r.bottom)};scrollTop=el.scrollTop;scrollMax=el.scrollHeight-el.clientHeight;scroller='container';break;}
  }
  const isCover=hit=>{
   if(hit?.closest('[role="dialog"],[aria-modal="true"]'))return true;
   for(let el=hit;el&&el!==document.body;el=el.parentElement){const r=el.getBoundingClientRect(),style=getComputedStyle(el);if(el!==main&&/fixed|absolute/.test(style.position)&&r.width>vw*.7&&r.height>vh*.45)return true;}
   return false;
  };
  const points=[];
  if(box.bottom-box.top>80&&box.right-box.left>40)for(const ratio of [.5,.3,.7]){
   const x=box.left+(box.right-box.left)*ratio,y=box.top+(box.bottom-box.top)*.5,hit=document.elementFromPoint(x,y);
   if(hit&&(main.contains(hit)&&!isCover(hit)))points.push({x,top:box.top,bottom:box.bottom});
  }
  const middle=document.elementFromPoint(vw*.5,vh*.5),dialog=middle?.closest('[role="dialog"],[aria-modal="true"]');
  const obstruction=dialog?'dialog':isCover(middle)?'overlay':'none';
  const loadingElements=[...(main.matches('[aria-busy="true"],[data-loading="true"]')?[main]:[]),...main.querySelectorAll('[aria-busy="true"],[data-loading="true"],[data-skeleton],.skeleton,.skeleton-loader,.loading-placeholder,.loading-spinner,[role="progressbar"]')].slice(0,60);
  const busy=document.readyState==='loading'||loadingElements.some(el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>0&&r.height>0&&r.bottom>safeTop&&r.top<vh&&s.display!=='none'&&s.visibility!=='hidden'&&s.opacity!=='0';});
  const hasContent=Boolean(main.innerText.trim());
  const signature=JSON.stringify([type,Math.round(scrollTop),Math.round(scrollMax),blocks.map(b=>[b.id,b.revision,Math.round(b.top/2),Math.round(b.height/2)]),links.map(l=>[l.canonical,l.score,Math.round(l.top/2),Math.round(l.height/2)]),busy,obstruction]);
  return {type,blocks,links,points,obstruction,hasContent,readiness:{busy:busy||!hasContent&&!links.length,signature},scrollTop,scrollMax,scroller,height:vh,extent:Math.round(scrollMax),canDown:scrollTop<scrollMax-1,canUp:scrollTop>1};
 },{marker,domain,visited,intent});
 view.links=view.links.filter(link=>visitPolicy.allowsSection(link.href,sections)&&linkSemantics({href:link.href,...link.semantics,intent}).allowed).map(({semantics,...link})=>link);
 return view;
}

export async function waitForSiteReady(inspect, state, {view, timeout=2500, stableMs=180, signal, check=async()=>{}}={}) {
 const deadline=performance.now()+Math.max(0,timeout);
 const cache=state.readiness ||= {signature:null,since:0,ready:false,retryAt:0};
 let current=view || await inspect();
 for(;;){
  signal?.throwIfAborted();await check();
  const now=performance.now(),{signature,busy}=current.readiness;
  if(signature!==cache.signature){cache.signature=signature;cache.since=now;cache.ready=false;cache.retryAt=0;}
  if(!busy&&(cache.ready||now-cache.since>=stableMs)){cache.ready=true;return {view:current,ready:true};}
  if(busy&&now<cache.retryAt)return {view:current,ready:false,reason:'content_loading'};
  if(now>=deadline){cache.ready=false;cache.retryAt=now+350;return {view:current,ready:false,reason:busy?'content_loading':'layout_stabilizing'};}
  await sleep(Math.min(80,Math.max(1,deadline-now)),signal);
  current=await inspect();
 }
}

export function createPageBehavior(now,remaining,transitions){
 return {started:now,due:now+Math.max(1000,remaining/(transitions+1)),seen:new Set(),direction:1,noProgress:0,scrollDisabled:false,extent:null,upFinished:false,reveals:new Map(),linkRetries:new Map(),obstruction:null,scrollGains:{page:1,container:1},surfaceGains:{},activeSurface:'page',surfaceStates:new Map(),scrollTarget:null,abandonedBlocks:new Set()};
}
function switchSurface(state,key){
 if(!key||key===state.activeSurface)return;
 state.surfaceStates.set(state.activeSurface,{noProgress:state.noProgress,scrollDisabled:state.scrollDisabled,upFinished:state.upFinished});
 Object.assign(state,state.surfaceStates.get(key)||{noProgress:0,scrollDisabled:false,upFinished:false});state.activeSurface=key;
}
export function observeScroll(state,result,view,action){
 switchSurface(state,result.surfaceKey);
 if(result.result==='scrolled'){
  state.noProgress=0;
  if(state.scrollTarget)state.scrollTarget.awaitingProgress=true;
  if(action?.pixels&&result.settled!==false&&Math.sign(action.pixels)===Math.sign(result.movedPixels)){
   const kind=result.scrollTarget==='container'?'container':'page';
   const measured=Math.max(.25,Math.min(3,Math.abs(result.movedPixels/action.pixels)));
   state.scrollGains[kind]=state.scrollGains[kind]*.5+measured*.5;
   if(result.surfaceKey)state.surfaceGains[result.surfaceKey]=(state.surfaceGains[result.surfaceKey]??1)*.5+measured*.5;
  }
  return;
 }
 state.noProgress++;
 if(result.result==='boundary'){
  if(state.direction>0){state.direction=-1;state.upFinished=!view.canUp;}else state.upFinished=true;
 }
 if(state.noProgress>=2||result.result==='blocked'&&view.obstruction!=='none'){state.scrollDisabled=true;state.scrollTarget=null;}
}
function targetGeometry(target,view){
 let top=target.viewportTop??8,bottom=target.viewportBottom??view.height-16;
 if(bottom<=top){top=8;bottom=view.height-16;}
 const span=Math.max(80,bottom-top);
 return {span,error:target.top-(top+span*.35)};
}
function targetScroll(view,state,target,reason,type='scroll'){
 switchSurface(state,target.scrollKey);
 const {span,error}=targetGeometry(target,view),direction=Math.sign(error);
 const key=type==='reveal'?target.canonical:target.id;
 const previous=state.scrollTarget;
 const reversals=previous?.key===key?previous.reversals+(previous.direction!==direction?1:0):0;
 const stalls=previous?.key===key?previous.stalls+(previous.awaitingProgress&&previous.direction===direction&&Math.abs(error)>=Math.abs(previous.error)-4?1:0):0;
 if(reversals>=3||stalls>=2){state.scrollTarget=null;if(type==='scroll')state.abandonedBlocks.add(key);return null;}
 state.scrollTarget={key,type,reason,direction,reversals,stalls,error,awaitingProgress:false};
 const gain=state.surfaceGains[target.scrollKey]??state.scrollGains[view.scroller==='container'?'container':'page'];
 const pixels=direction*Math.max(16,Math.min(span*.4,Math.abs(error)/gain));
 return {type,pixels,reason,...(type==='reveal'?{link:target}:{block:target})};
}
function linkCandidates(view,state,remaining){
 const preferred=view.links.some(l=>l.zone!=='footer')?view.links.filter(l=>l.zone!=='footer'):view.links;
 const scores=new Map();for(const link of preferred)scores.set(link.canonical,Math.max(link.score,scores.get(link.canonical)??-Infinity));
 return preferred.flatMap(link=>{
  if(link.visible&&!link.accessible)return [];
  const {span,error}=targetGeometry(link,view);
  const distance=link.visible?0:Math.abs(error);
  const disabled=link.scrollKey&&link.scrollKey!==state.activeSurface?state.surfaceStates.get(link.scrollKey)?.scrollDisabled:state.scrollDisabled;
  if(distance&&(disabled||(state.reveals.get(link.canonical)||0)>=2))return [];
  const gain=state.surfaceGains[link.scrollKey]??state.scrollGains[view.scroller==='container'?'container':'page'];
  const cost=Math.ceil(distance/(span*.4*gain))*1500;
  if(distance&&cost>Math.min(remaining*.8,remaining-1500))return [];
  const utility=scores.get(link.canonical)-12*Math.log2(1+distance/span)+(link.visible?3:0);
  return [{link,utility}];
 }).sort((a,b)=>b.utility-a.utility||a.link.canonical.localeCompare(b.link.canonical));
}
export function chooseSiteAction(view,state,{now,remaining,canNavigate}){
 if(state.extent!==null&&state.extent!==view.extent){state.scrollDisabled=false;state.noProgress=0;state.abandonedBlocks.clear();if(view.extent>state.extent){state.direction=1;state.upFinished=false;}}
 if(state.obstruction&&state.obstruction!==view.obstruction&&view.obstruction==='none'){state.scrollDisabled=false;state.noProgress=0;}
 state.obstruction=view.obstruction;state.extent=view.extent;
 const best=canNavigate?linkCandidates(view,state,remaining)[0]?.link:undefined;
 if(canNavigate&&now>=state.due&&remaining>1500){
  if(best){
   if(best.visible&&best.accessible){state.scrollTarget=null;return {type:'navigate',link:best,reason:'relevant_visible_link'};}
   const action=targetScroll(view,state,best,'reveal_relevant_link','reveal');if(action)return action;
   state.reveals.set(best.canonical,2);
  }
 }
 if(state.scrollTarget?.type==='scroll'&&!state.scrollDisabled){
  const target=view.blocks.find(b=>b.id===state.scrollTarget.key);
  if(target&&!state.seen.has(target.id)&&!target.visible){const correction=targetScroll(view,state,target,'correct_scroll_position');if(correction)return correction;}
  state.scrollTarget=null;
 }
 const visible=view.blocks.filter(b=>b.visible&&b.accessible&&!state.seen.has(b.id)&&b.visibleRatio>=.2);
 if(visible.length){visible.sort((a,b)=>(b.relevance||0)-(a.relevance||0)||a.top-b.top);const block=visible[0];return {type:'read',block,pauseMs:readingPause(block),reason:'content_block'};}
 if(!view.hasContent&&!view.blocks.length)return {type:'wait',pauseMs:Math.min(3000,remaining),reason:'content_exhausted'};
 if(!state.scrollDisabled&&!state.upFinished){
  const next=view.blocks.filter(b=>!state.seen.has(b.id)&&!state.abandonedBlocks.has(b.id)&&(state.direction>0?b.top>view.height*.65:b.bottom<64)).sort((a,b)=>state.direction>0?a.top-b.top:b.bottom-a.bottom)[0];
  if(next){const action=targetScroll(view,state,next,'next_content_block');if(action)return action;}
  if(best&&now<state.due){
   if(best.visible&&best.accessible)return {type:'wait',pauseMs:Math.min(3000,state.due-now,remaining),reason:'reading_before_transition'};
   const action=targetScroll(view,state,best,'prepare_relevant_link','reveal');if(action)return action;
   state.reveals.set(best.canonical,2);
  }
  if(state.direction>0&&view.canDown||state.direction<0&&view.canUp)return {type:'scroll',pixels:state.direction*Math.min(view.height*.4,view.height*.35/state.scrollGains[view.scroller==='container'?'container':'page']),reason:'inspect_next_viewport'};
  if(state.direction>0){state.direction=-1;if(view.canUp)return {type:'scroll',pixels:-view.height*.3,reason:'review_previous_content'};}
  state.upFinished=true;
 }
 return {type:'wait',pauseMs:Math.min(3000,remaining),reason:state.scrollDisabled?'scroll_unavailable':'content_exhausted'};
}