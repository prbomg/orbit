import {MAX_LATERAL_WOBBLE} from './touch-trajectory.mjs';

/** Plan native input against the target's scroll ancestors and a clear gesture corridor. */
export async function planScrollSurface(page,{pixels,target,point,scope}={}) {
 return page.evaluateHandle(({pixels,target,point,scope,lateralWobble})=>{
  const root=document.scrollingElement||document.documentElement, direction=Math.sign(pixels)||1;
  const rect=el=>{const r=el.getBoundingClientRect();return {left:r.left+el.clientLeft,right:r.left+el.clientLeft+el.clientWidth,top:r.top+el.clientTop,bottom:r.top+el.clientTop+el.clientHeight};};
  const scrollable=el=>el===root||/auto|scroll/.test(getComputedStyle(el).overflowY)&&el.scrollHeight>el.clientHeight+2;
  const mapSymbol=Symbol.for('__ WeakSurfaceIds');
  if(!window[mapSymbol])Object.defineProperty(window,mapSymbol,{value:new WeakMap(),enumerable:false});
  const surfaceMap=window[mapSymbol];
  const key=el=>{if(el===root)return 'page';let value=surfaceMap.get(el);if(!value){value=`surface-${(surfaceMap.nextId=(surfaceMap.nextId||0)+1)}`;surfaceMap.set(el,value);}return value;};
  const topOf=el=>el===root?scrollY:el.scrollTop;
  const maxOf=el=>el===root?Math.max(0,Math.max(document.documentElement.scrollHeight,document.body?.scrollHeight||0)-innerHeight):Math.max(0,el.scrollHeight-el.clientHeight);
  const canMove=(el,dir)=>dir>0?topOf(el)<maxOf(el)-.5:topOf(el)>.5;
  const boxOf=el=>{
   let box=el===root?{left:8,right:innerWidth-8,top:8,bottom:innerHeight-16}:rect(el);
   box={left:Math.max(8,box.left),right:Math.min(innerWidth-8,box.right),top:Math.max(8,box.top),bottom:Math.min(innerHeight-16,box.bottom)};
   for(let p=el.parentElement;p&&p!==document.body;p=p.parentElement){const s=getComputedStyle(p),r=rect(p);if(/auto|scroll|hidden|clip/.test(s.overflowY)){box.top=Math.max(box.top,r.top);box.bottom=Math.min(box.bottom,r.bottom);}if(/auto|scroll|hidden|clip/.test(s.overflowX)){box.left=Math.max(box.left,r.left);box.right=Math.min(box.right,r.right);}}
   return box;
  };
  const chain=el=>{const out=[];for(let p=el?.parentElement;p&&p!==root;p=p.parentElement)if(scrollable(p))out.push(p);out.push(root);return out;};
  let node=root,goal=null,error=null;
  if(target){
   goal=window[Symbol.for('__ OrbitSearchRefs')]?.get(target.token??target.value);
   if(!goal||!goal.isConnected)return {ready:false,reason:'target_unavailable'};
   const ancestors=chain(goal);
   // Reveal an offscreen scroll box with its parent before scrolling inside it.
   for(const candidate of ancestors){
    const b=boxOf(candidate);
    if(b.bottom-b.top<100||b.right-b.left<40){if(candidate!==root)goal=candidate;continue;}
    const r=goal.getBoundingClientRect(),span=b.bottom-b.top;
    const outside=r.bottom<b.top+12||r.top>b.bottom-12;
    const desired=b.top+span*.35;
    const proposed=r.top-desired;
    if((outside||candidate===root)&&canMove(candidate,Math.sign(proposed)||direction)){node=candidate;error=proposed;break;}
    // A target clipped by an ancestor outside this box needs the outer scroll.
    const own=candidate===root?b:rect(candidate);
    if(r.top>=own.top&&r.bottom<=own.bottom){if(candidate!==root)goal=candidate;continue;}
    if(canMove(candidate,Math.sign(proposed)||direction)){node=candidate;error=proposed;break;}
   }
  }else{
   const x=point?.x??innerWidth*.55,y=point?point.top+(point.bottom-point.top)*(direction>0?.78:.25):innerHeight*(direction>0?.78:.25);
   const hit=document.elementFromPoint(x,y);
   const candidates=[];for(let p=hit;p&&p!==root;p=p.parentElement)if(scrollable(p))candidates.push(p);candidates.push(root);
   node=candidates.find(el=>canMove(el,direction))||candidates[0]||root;
   if(scope==='content'&&!point){
    const main=document.querySelector('main,[role="main"],article')||document.body;
    const surfaces=[main,...main.querySelectorAll('div,section')].slice(0,160).filter(el=>scrollable(el)&&canMove(el,direction)).map(el=>{const b=boxOf(el);return {el,b,score:Math.max(0,b.right-b.left)*Math.max(0,b.bottom-b.top)+el.querySelectorAll('p,table,[data-product],.product-card,a[href]').length*1500};}).filter(s=>s.b.bottom-s.b.top>100);
    surfaces.sort((a,b)=>b.score-a.score);if(surfaces[0])node=surfaces[0].el;
   }
  }
  const box=boxOf(node),height=box.bottom-box.top;
  const requested=error===null?pixels:Math.sign(error)*Math.max(16,Math.min(Math.abs(error),height*.4));
  const dir=Math.sign(requested)||direction;
  const nodes=[node,...chain(node)].filter((el,index,array)=>array.indexOf(el)===index).map(el=>({el,top:topOf(el),max:maxOf(el),root:el===root}));
  const kind=node===root?'page':'container',surfaceKey=key(node);
  const base={node,nodes,surfaceKey,scrollTarget:kind,pixels:requested,box,canMove:canMove(node,dir)};
  if(height<100||box.right-box.left<40)return {...base,ready:false,reason:'no_clear_scroll_point'};
  if(!base.canMove)return {...base,ready:false,reason:'boundary'};
  const hazards='iframe,canvas,video,audio,input,select,textarea,button,[contenteditable="true"],[role="slider"],[role="spinbutton"],[role="button"],[role="application"],[draggable="true"],[data-map],[data-carousel],.swiper,.slick-slider,.leaflet-container,.mapboxgl-map,[class*="ymaps-"],[class*="carousel" i],[aria-roledescription="carousel"],[role="tablist"]';
  const receiver=hit=>{
   for(let p=hit;p;p=p.parentElement){
    const s=getComputedStyle(p),ta=s.touchAction;
    if(ta==='none'||ta==='pan-x'||ta==='pinch-zoom'||ta==='pan-down'&&dir>0||ta==='pan-up'&&dir<0)return null;
    if(p!==root&&p.scrollWidth>p.clientWidth+20&&/auto|scroll/.test(s.overflowX))return null;
    if(scrollable(p)){
     if(canMove(p,dir))return p;
     if(p!==root&&/contain|none/.test(s.overscrollBehaviorY))return null;
    }
   }
   return canMove(root,dir)?root:null;
  };
  const isSafe=(x,y)=>{
   if(x<box.left||x>box.right||y<box.top||y>box.bottom)return false;
   const hit=document.elementFromPoint(x,y);if(!hit||hit.closest(hazards))return false;
   if(receiver(hit)!==node)return false;
   for(let p=hit;p&&p!==node;p=p.parentElement){const r=p.getBoundingClientRect(),s=getComputedStyle(p);if(/fixed|sticky/.test(s.position)&&r.width>innerWidth*.5)return false;}
   return true;
  };
  // Reserve the curve's full control-point envelope plus the contact radius.
  const clearance=lateralWobble+4;
  const distance=Math.min(Math.abs(requested),Math.min(height*.45,420));
  const xs=[point?.x,...[.5,.3,.7,.15,.85].map(r=>box.left+(box.right-box.left)*r)].filter(x=>Number.isFinite(x)&&x>box.left+4&&x<box.right-4);
  const starts=dir>0?[.78,.66,.9]:[.25,.36,.12];
  const hazardRects=[...document.querySelectorAll(hazards)].slice(0,200).map(el=>el.getBoundingClientRect()).filter(r=>r.width&&r.height);
  for(const x of xs)for(const ratio of starts){
   const fromY=box.top+height*ratio,toY=fromY-dir*distance;
   if(toY<box.top+8||toY>box.bottom-8)continue;
   let safe=true;for(let step=0;step<=10;step++)if(![-clearance,0,clearance].every(offset=>isSafe(x+offset,fromY+(toY-fromY)*step/10))){safe=false;break;}
   if(safe)for(const r of hazardRects){const low=Math.max(Math.min(fromY,toY),r.top),high=Math.min(Math.max(fromY,toY),r.bottom),left=Math.max(x-clearance,r.left),right=Math.min(x+clearance,r.right);if(right>left&&high>low&&!isSafe((left+right)/2,(low+high)/2)){safe=false;break;}}
   if(safe)return {...base,ready:true,x,fromY,toY,maxDistance:distance,lateralWobble,reason:null};
  }
  return {...base,ready:false,reason:'no_clear_scroll_point'};
 },{pixels,target,point,scope,lateralWobble:MAX_LATERAL_WOBBLE});
}
