// Motion and skeletons for Flygon Flow. Dependency-free and opt-in; any module can use it.
//
// View transitions
//   swap({from, update, to})  Switch views: `from` (the outgoing view element) fades out with a ~6px
//                             slide, update() re-renders, then to() returns [root, groups] and the
//                             incoming view staggers in. Uses the View Transitions API when present,
//                             a Web Animations fallback otherwise.
//   popIn(el)                 Subtle entrance for popovers and menus.
//   enter(root, groups)       Stagger-in only. groups are selectors animated in order, e.g.
//                             ['.tl-bar', '.panel', '.dcol']: toolbar, then panels, then cards.
//   Only opacity and transform move (no layout shift). prefers-reduced-motion disables all motion.
//   Nothing can stay half-hidden: entrance animations fill 'backwards' only, and every new swap
//   cancels the previous one's animations; a superseded swap still renders the latest state.
//
// Skeletons
//   skeletonize(el)           Covers el with shimmer blocks measured from its real DOM: each visible
//                             leaf (controls, pills, avatars, icons) gets a block and text gets one
//                             block per rendered line. Subtrees marked data-no-skeleton are skipped.
//   skeletonize(el,{rows:n})  For an empty container: n placeholder rows (rowHeight px tall).
//   skeletonAppend(list, n)   Appends n placeholder copies shaped like the list's last item (Load more).
//   unskeletonize(el)         Removes all of the above and aria-busy. Safe to call at any time.
//   busy(el, promise|ms, opts) skeletonize(el) until the promise settles (or ms pass), then always
//                             clears it, success or error.
//   The container gets aria-busy="true" while it shows a skeleton. Shimmer uses the grey base
//   tokens (--hover, --line) and stops under prefers-reduced-motion.

const reduced=()=>matchMedia('(prefers-reduced-motion: reduce)').matches;
const EASE='cubic-bezier(.2,.7,.2,1)';
let running=[],seq=0;
const stop=()=>{for(const a of running)a.cancel();running=[]};
const shown=e=>e.getClientRects().length>0;

export function enter(root,groups=[]){
  if(!root||reduced()||!root.animate)return;
  let delay=0;
  for(const sel of groups){
    const els=[...root.querySelectorAll(sel)].filter(shown).slice(0,24);
    els.forEach((el,i)=>running.push(el.animate([{opacity:0,transform:'translateY(6px)'},{opacity:1,transform:'none'}],{duration:140,delay:delay+Math.min(i,6)*8,easing:EASE,fill:'backwards'})));
    if(els.length)delay+=20;
  }
}
export function swap({from,update,to}){
  stop();const mine=++seq;
  const after=()=>{if(mine!==seq)return;const t=to?.();if(t)enter(...t)};
  if(reduced()){update();return}
  if(document.startViewTransition){
    // The API snapshots the old frame and fades it out (see ::view-transition-old in style.css).
    // A newer swap skips this one; its promises then reject, which is expected and not an error.
    try{const t=document.startViewTransition(()=>{update();after()});for(const p of [t.ready,t.finished,t.updateCallbackDone])p?.catch(()=>{});return}catch{}
  }
  const outs=from&&shown(from)?[...from.children].filter(shown):[];
  if(!outs.length){update();after();return}
  for(const el of outs)running.push(el.animate([{opacity:1,transform:'none'},{opacity:0,transform:'translateY(-6px)'}],{duration:120,easing:'ease-in',fill:'forwards'}));
  setTimeout(()=>{if(mine!==seq)return;stop();update();after()},120);
}

// A small pop-in for menus and popovers.
export function popIn(el){if(el?.animate&&!reduced())el.animate([{opacity:0,transform:'translateY(-4px) scale(.98)'},{opacity:1,transform:'none'}],{duration:120,easing:EASE})}

// ---------- show / hide without snapping ----------
// popOut(el): the exit for popovers, menus and toasts; resolves after it is removed.
export function popOut(el){
  if(!el?.isConnected)return Promise.resolve();
  el.style.pointerEvents='none';
  if(reduced()||!el.animate){el.remove();return Promise.resolve()}
  const a=el.animate([{opacity:1,transform:'none'},{opacity:0,transform:'translateY(-4px) scale(.98)'}],{duration:100,easing:'ease-in',fill:'forwards'});
  return a.finished.catch(()=>{}).then(()=>el.remove());
}
// panel(el, show): side panels slide in (200 ms) and out (150 ms) while the area beside them
// resizes smoothly; a reopen during the exit cancels it. onHidden runs once it is really hidden.
const panels=new WeakMap();
export function panel(el,show,{onHidden}={}){
  const cur=panels.get(el);
  if(show){
    if(cur){cur.cancel();panels.delete(el);el.style.pointerEvents=''}
    if(!el.hidden)return;
    el.hidden=false;
    if(!reduced()&&el.animate){const w=el.offsetWidth;el.animate([{width:'0px',opacity:0,transform:'translateX(12px)'},{width:w+'px',opacity:1,transform:'none'}],{duration:200,easing:EASE})}
    return;
  }
  if(el.hidden||cur)return;
  if(reduced()||!el.animate){el.hidden=true;onHidden?.();return}
  const w=el.offsetWidth;el.style.pointerEvents='none';
  const a=el.animate([{width:w+'px',opacity:1,transform:'none'},{width:'0px',opacity:0,transform:'translateX(12px)'}],{duration:150,easing:'ease-in',fill:'forwards'});
  panels.set(el,a);
  a.finished.then(()=>{if(panels.get(el)!==a)return;panels.delete(el);el.hidden=true;el.style.pointerEvents='';a.cancel();onHidden?.()},()=>{});
}
// flipList(root, selector, key, mutate): re-render a list; items that stay glide to their new
// place, new ones fade in, removed ones fade out where they were (FLIP, transform/opacity only).
export function flipList(root,selector,key,mutate){
  const old=[...root.querySelectorAll(selector)];
  if(reduced()||!old.length||old.length>400){mutate();return}
  const before=new Map(old.map(el=>[key(el),{el,r:el.getBoundingClientRect()}]));
  mutate();
  const seen=new Set();
  for(const el of root.querySelectorAll(selector)){
    const k=key(el),b=before.get(k);seen.add(k);
    if(!b){el.animate([{opacity:0,transform:'scale(.96)'},{opacity:1,transform:'none'}],{duration:160,easing:EASE});continue}
    if(!b.r.width)continue;
    const r=el.getBoundingClientRect(),dx=b.r.left-r.left,dy=b.r.top-r.top;
    if(Math.abs(dx)+Math.abs(dy)>1)el.animate([{transform:`translate(${dx}px,${dy}px)`},{transform:'none'}],{duration:200,easing:EASE});
  }
  for(const [k,{el,r}] of before){
    if(seen.has(k)||!r.width)continue;
    // A ghost of the removed item fades out where it was.
    for(const at of [...el.attributes])if(at.name.startsWith('data-')||at.name==='id'||at.name==='tabindex')el.removeAttribute(at.name);
    el.setAttribute('aria-hidden','true');el.classList.add('ghost-out');
    Object.assign(el.style,{position:'fixed',left:r.left+'px',top:r.top+'px',width:r.width+'px',height:r.height+'px',margin:'0',pointerEvents:'none',zIndex:5});
    document.body.append(el);
    el.animate([{opacity:1,transform:'none'},{opacity:0,transform:'scale(.96)'}],{duration:140,easing:'ease-in',fill:'forwards'}).finished.catch(()=>{}).then(()=>el.remove());
  }
}

// ---------- skeletons ----------
const LEAF='input,select,textarea,button,svg,img,canvas,.pill,.bub,.tag,.dot';
const MAX=320;
function measure(el,layer){
  const box=el.getBoundingClientRect(),ox=box.left+el.clientLeft,oy=box.top+el.clientTop,out=[];
  const add=(r,cls)=>{
    if(out.length>=MAX||r.width<2||r.height<2||r.bottom<box.top||r.top>box.bottom||r.right<box.left||r.left>box.right)return;
    const b=document.createElement('i');b.className=cls;
    Object.assign(b.style,{left:r.left-ox+'px',top:r.top-oy+'px',width:r.width+'px',height:r.height+'px'});out.push(b);
  };
  const text=node=>{
    const range=document.createRange();range.selectNodeContents(node);
    for(const r of range.getClientRects()){const h=Math.min(r.height,12);add({left:r.left,top:r.top+(r.height-h)/2,width:r.width,height:h,right:r.right,bottom:r.bottom},'sk-b')}
  };
  const walk=n=>{
    for(const c of n.children){
      if(out.length>=MAX)return;
      if(c===layer||c.classList.contains('sk-layer')||c.hasAttribute('data-no-skeleton')||!shown(c))continue;
      const r=c.getBoundingClientRect(),cs=getComputedStyle(c);
      if(cs.visibility==='hidden'||cs.opacity==='0')continue;
      if(c.matches(LEAF)){add(r,c.matches('.bub,.dot')?'sk-b round':'sk-b');continue}
      // Cards, rows and panels keep their outline so the skeleton reads as the same layout.
      if(parseFloat(cs.borderTopWidth)>0&&r.width*r.height>0&&c!==el)add(r,'sk-box');
      if(c.children.length)walk(c);
      if([...c.childNodes].some(t=>t.nodeType===3&&t.textContent.trim()))text(c);
    }
  };
  walk(el);
  return out;
}
export function skeletonize(el,{rows=0,rowHeight=28}={}){
  if(!el||el.querySelector(':scope>.sk-layer:not(.sk-leaving)'))return;
  el.setAttribute('aria-busy','true');
  if(rows&&!el.children.length){
    for(let i=0;i<rows;i++){const r=document.createElement('div');r.className='sk-clone sk-row';r.setAttribute('aria-hidden','true');r.style.height=rowHeight+'px';r.innerHTML=`<i class="sk-b" style="width:${[78,62,70,55][i%4]}%"></i>`;el.append(r)}
    return;
  }
  if(getComputedStyle(el).position==='static'){el.style.position='relative';el.dataset.skPos=''}
  const layer=document.createElement('div');layer.className='sk-layer';layer.setAttribute('aria-hidden','true');
  if(!el.clientWidth||!el.clientHeight){el.removeAttribute('aria-busy');return}
  Object.assign(layer.style,{left:el.scrollLeft+'px',top:el.scrollTop+'px',width:el.clientWidth+'px',height:el.clientHeight+'px'});
  const bg=getComputedStyle(el).backgroundColor;layer.style.background=bg&&bg!=='rgba(0, 0, 0, 0)'?bg:'#fff';
  const blocks=measure(el,layer);
  for(const b of blocks){b.style.left=parseFloat(b.style.left)-el.scrollLeft+'px';b.style.top=parseFloat(b.style.top)-el.scrollTop+'px'}
  layer.append(...blocks);el.append(layer);
}
export function skeletonAppend(list,n=3){
  if(!list)return;
  const tpl=[...list.children].filter(c=>!c.matches('button,.sk-clone,.sk-layer')).at(-1);if(!tpl)return;
  const before=[...list.children].find(c=>c.matches('button'))||null;
  list.setAttribute('aria-busy','true');
  for(let i=0;i<n;i++){
    const c=tpl.cloneNode(true);
    for(const x of [c,...c.querySelectorAll('*')]){for(const a of [...x.attributes])if(a.name==='id'||a.name==='tabindex'||a.name==='role'||a.name.startsWith('data-')||a.name.startsWith('aria-'))x.removeAttribute(a.name)}
    c.classList.add('sk-clone');c.setAttribute('aria-hidden','true');list.insertBefore(c,before);skeletonize(c);
  }
}
export function unskeletonize(el){
  if(!el)return;
  for(const c of el.querySelectorAll('.sk-clone'))c.remove();
  for(const l of el.querySelectorAll('.sk-layer')){
    if(reduced()||l.classList.contains('sk-leaving')){l.remove();continue}
    l.classList.add('sk-leaving');setTimeout(()=>l.remove(),130);
  }
  el.removeAttribute('aria-busy');
  if(el.dataset.skPos!==undefined){el.style.position='';delete el.dataset.skPos}
}
export function busy(el,work,opts){
  skeletonize(el,opts);
  const done=()=>unskeletonize(el);
  if(typeof work==='number'){setTimeout(done,work);return Promise.resolve()}
  return Promise.resolve(work).finally(done);
}
