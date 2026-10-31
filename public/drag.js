// Tactile drag and drop for card lists, with pointer events (mouse, touch, pen) and the keyboard.
// Reusable: the DevOps board uses it; any board of lists can.
//
//   const sortable=createSortable(root,{
//     item:'[data-card]',                      cards (need a stable data id attribute, see idOf)
//     list:'.dcol-b',                          containers the cards live in
//     listOf:el=>el.closest('[data-dcol]'),   the drop zone that owns a list (gets .drag-over)
//     keyOf:zone=>zone.dataset.dcol,          a zone's id passed to onDrop
//     idOf:el=>el.dataset.card,
//     ignore:'button,a,input,select',
//     scroller:()=>root.querySelector('.dv-scroll'),   optional horizontal scroller
//     describe:(id,key,pos,total)=>'…',        aria-live text
//     onTap:id=>…,                             a press without a drag
//     onDrop:async({id,from,to,beforeId,afterId},ctx)=>true|false,   false: put it back
//   });
//   sortable.active()   true while a card is lifted (hosts should not re-render then)
//
// Pick up: press and move 4px (mouse/pen) or hold 180ms (touch). The card lifts into a floating
// clone that keeps the grab offset, scales up, tilts with velocity and casts a deeper shadow. A gap
// the size of the card follows the pointer between cards (FLIP, transform only, slight overshoot),
// with hysteresis at midpoints. Drop: the clone flies into the gap, then the host commits. Esc,
// dropping outside or a declined gate fly it home. Keyboard: Space picks up, arrows move,
// Space drops, Esc cancels. Reduced motion: no tilt or springs.
const reduced=()=>matchMedia('(prefers-reduced-motion: reduce)').matches;
const SPRING='cubic-bezier(.2,.9,.3,1.15)',OUT='cubic-bezier(.2,.7,.2,1)';
export function createSortable(root,o){
  // Cards actually shown in a list (the lifted original and skeleton copies do not count).
  const shownIn=list=>list?[...list.children].filter(c=>c.matches?.(o.item)&&!c.classList.contains('drag-src')&&!c.classList.contains('sk-clone')):[];
  // The live region sits on <body> so host re-renders of root cannot remove it.
  const live=document.createElement('div');live.className='sr-only';live.dataset.dragLive='';live.setAttribute('aria-live','assertive');document.body.append(live);
  const say=t=>{live.textContent='';requestAnimationFrame(()=>live.textContent=t)};
  let d=null;   // the current drag
  const zones=()=>[...root.querySelectorAll(o.list)].map(l=>o.listOf(l)).filter(Boolean);
  const listIn=z=>z?.querySelector(o.list);

  // FLIP: remember where things are, change the DOM, then animate each from its old place.
  function flip(els,change,{dur=180,ease=SPRING}={}){
    const before=new Map(els.map(e=>[e,e.getBoundingClientRect().top]));
    change();
    if(reduced())return;
    for(const [e,top] of before){
      if(!e.isConnected)continue;const dy=top-e.getBoundingClientRect().top;if(Math.abs(dy)<1)continue;
      e.animate([{transform:`translateY(${dy}px)`},{transform:'none'}],{duration:dur,easing:ease});
    }
  }
  const neighbours=()=>[...root.querySelectorAll(o.list)].flatMap(l=>shownIn(l));

  // ---------- pointer ----------
  root.addEventListener('pointerdown',e=>{
    if(d||e.button!==0||e.target.closest(o.ignore))return;
    const el=e.target.closest(o.item);if(!el||!root.contains(el))return;
    const r=el.getBoundingClientRect();
    d={el,id:o.idOf(el),pid:e.pointerId,sx:e.clientX,sy:e.clientY,x:e.clientX,y:e.clientY,ox:e.clientX-r.left,oy:e.clientY-r.top,touch:e.pointerType==='touch',lifted:false,mode:'pointer'};
    if(d.touch)d.hold=setTimeout(()=>{if(d&&!d.lifted)lift()},180);
    root.setPointerCapture(e.pointerId);
  });
  root.addEventListener('pointermove',e=>{
    if(!d||e.pointerId!==d.pid||d.mode!=='pointer')return;
    d.x=e.clientX;d.y=e.clientY;
    if(!d.lifted){
      const moved=Math.hypot(d.x-d.sx,d.y-d.sy);
      if(d.touch){if(moved>8){clearTimeout(d.hold);try{root.releasePointerCapture(d.pid)}catch{}d=null}return}
      if(moved>=4)lift();else return;
    }
    d.dirty=true;
  });
  // While a touch drag is lifted, stop the page from scrolling instead.
  root.addEventListener('touchmove',e=>{if(d?.lifted)e.preventDefault()},{passive:false});
  const up=e=>{
    if(!d||e.pointerId!==d.pid||d.mode!=='pointer')return;
    clearTimeout(d.hold);
    if(!d.lifted){const id=d.id;d=null;if(e.type==='pointerup')o.onTap?.(id);return}
    if(d.flying)return;
    // Settle the gap at the release point before deciding (the last move may not have had a frame yet).
    if(e.type==='pointerup'){d.x=e.clientX;d.y=e.clientY;track()}
    if(e.type==='pointercancel'||!d.zone)cancel();else drop();
  };
  root.addEventListener('pointerup',up);root.addEventListener('pointercancel',up);
  addEventListener('keydown',e=>{if(d?.lifted&&e.key==='Escape'){e.preventDefault();e.stopPropagation();cancel()}},true);

  function lift(){
    const el=d.el,r=el.getBoundingClientRect();
    d.lifted=true;d.h=r.height;d.w=r.width;d.home=listIn(o.listOf(el));d.homeNext=el.nextElementSibling;d.from=o.keyOf(o.listOf(el));
    const c=el.cloneNode(true);c.classList.add('drag-clone');c.removeAttribute('tabindex');c.setAttribute('aria-hidden','true');
    Object.assign(c.style,{width:r.width+'px',height:r.height+'px',left:'0px',top:'0px'});
    document.body.append(c);d.clone=c;d.vx=0;d.tilt=0;d.lx=d.x;d.lt=performance.now();
    // The card's slot becomes the gap (same height), so nothing jumps at pick-up.
    const gap=document.createElement('div');gap.className='drag-gap';gap.style.height=r.height+'px';d.gap=gap;
    el.before(gap);el.classList.add('drag-src');
    d.zone=o.listOf(el);d.zone.classList.add('drag-over');d.index=shownIn(d.home).filter(x=>x.compareDocumentPosition(gap)&Node.DOCUMENT_POSITION_PRECEDING).length;
    document.documentElement.classList.add('dragging-cards');
    place(true);
    // The lift scale is its own property, so the clone tracks the pointer from the first frame
    // while it grows (an animated transform would pin it in place until the animation ended).
    if(!reduced()){c.style.scale='1.04';c.animate([{scale:'1'},{scale:'1.04'}],{duration:90,easing:OUT})}
    d.raf=requestAnimationFrame(frame);
    say(`Picked up ${o.describe?.(d.id,d.from,d.index+1,shownIn(d.home).length+1)||''}`);
  }
  const transformAt=(x,y,deg)=>`translate(${x}px,${y}px) rotate(${deg}deg)`;
  function place(now){
    const x=d.x-d.ox,y=d.y-d.oy;
    d.clone.style.transform=transformAt(x,y,reduced()?0:d.tilt);
  }
  // One frame per animation tick: follow the pointer, ease the tilt, move the gap, auto-scroll.
  function frame(t){
    if(!d?.lifted||d.mode!=='pointer'||d.flying)return;
    const dt=Math.max(1,t-d.lt);d.vx=d.vx*.8+((d.x-d.lx)/dt)*.2;d.lx=d.x;d.lt=t;
    const target=Math.max(-3,Math.min(3,d.vx*6));d.tilt+=(target-d.tilt)*.18;if(Math.abs(d.tilt)<.01)d.tilt=0;
    place();
    if(d.dirty){d.dirty=false;track()}
    autoscroll();
    d.raf=requestAnimationFrame(frame);
  }
  function track(){
    const zs=new Set(zones());let realZone=document.elementFromPoint(d.x,d.y);
    while(realZone&&!zs.has(realZone))realZone=realZone.parentElement;
    if(!realZone){if(d.zone)moveGap(null,0);return}
    const list=listIn(realZone),items=shownIn(list);
    // Layout midpoints (offsetTop, so running FLIP transforms cannot cause jitter) of the visible
    // cards as if the gap were not there; hysteresis at the current boundary keeps the gap steady.
    const gapIn=d.gap.parentElement===list,gh=gapIn?d.gap.offsetHeight+gapMargin(list):0,lr=list.getBoundingClientRect();
    const mids=items.map(c=>{const after=gapIn&&(d.gap.compareDocumentPosition(c)&Node.DOCUMENT_POSITION_FOLLOWING);return lr.top+list.clientTop+c.offsetTop-list.scrollTop-(after?gh:0)+c.offsetHeight/2});
    let idx=mids.filter(m=>m<d.y).length;
    if(realZone===d.zone&&idx!==d.index){const edge=mids[Math.min(idx,d.index)];if(edge!==undefined&&Math.abs(d.y-edge)<8)idx=d.index}
    if(realZone!==d.zone||idx!==d.index)moveGap(realZone,idx);
  }
  const gapMargin=list=>parseFloat(getComputedStyle(list).rowGap)||0;
  function moveGap(zone,idx){
    const affected=neighbours();
    flip(affected,()=>{
      if(d.zone&&d.zone!==zone)d.zone.classList.remove('drag-over');
      if(!zone){d.gap.remove();d.zone=null;d.index=0;return}
      const list=listIn(zone),items=shownIn(list),before=items[idx]||list.querySelector(':scope>button')||null;
      list.insertBefore(d.gap,before);zone.classList.add('drag-over');d.zone=zone;d.index=idx;
    });
    if(zone&&!reduced())d.gap.animate([{transform:'scaleY(.6)',opacity:.4},{transform:'none',opacity:1}],{duration:160,easing:SPRING});
    if(d.mode==='key'&&zone)say(o.describe?.(d.id,o.keyOf(zone),idx+1,shownIn(listIn(zone)).length+1)||'');
  }
  function autoscroll(){
    const z=d.zone,list=listIn(z);
    if(list){const r=list.getBoundingClientRect(),edge=40;if(d.y<r.top+edge)list.scrollTop-=Math.ceil((r.top+edge-d.y)/4);else if(d.y>r.bottom-edge)list.scrollTop+=Math.ceil((d.y-r.bottom+edge)/4);if(list.scrollTop!==d.lastScroll){d.lastScroll=list.scrollTop;d.dirty=true}}
    const sc=o.scroller?.();if(sc&&sc.scrollWidth>sc.clientWidth+1){const r=sc.getBoundingClientRect();if(d.x<r.left+48)sc.scrollLeft-=12;else if(d.x>r.right-48)sc.scrollLeft+=12;d.dirty=true}
  }

  // ---------- finish ----------
  function fly(to,dur,s=1){
    if(reduced()||!d.clone.animate)return Promise.resolve();
    const from=d.clone.style.transform,fromScale=d.clone.style.scale||'1';d.clone.style.transform=transformAt(to.left,to.top,0);d.clone.style.scale=String(s);
    return d.clone.animate([{transform:from,scale:fromScale},{transform:d.clone.style.transform,scale:String(s)}],{duration:dur,easing:OUT}).finished.catch(()=>{});
  }
  function neighboursOf(){return [d.gap.previousElementSibling,d.gap.nextElementSibling].map(x=>x?.matches?.(o.item)?o.idOf(x):null)}
  async function drop(){
    cancelAnimationFrame(d.raf);d.flying=true;
    const g=d.gap.getBoundingClientRect(),cur=d;
    await fly({left:g.left,top:g.top},160);
    const [afterId,beforeId]=neighboursOf();
    const to=o.keyOf(d.zone),from=d.from;
    let ok=false;
    try{ok=await o.onDrop({id:d.id,from,to,beforeId,afterId},{hideClone:()=>{cur.clone.style.opacity='0'}})}catch{ok=false}
    if(d!==cur)return;
    if(!ok){d.flying=false;return goHome()}
    cleanup(true);
  }
  async function goHome(){
    cancelAnimationFrame(d.raf);d.flying=true;
    const cur=d;
    // Reopen the slot at home, then fly back into it.
    flip(neighbours(),()=>{d.zone?.classList.remove('drag-over');d.el.before(d.gap);d.zone=null});
    const g=d.gap.getBoundingClientRect();
    if(cur.clone)await fly({left:g.left,top:g.top},200);
    if(d!==cur)return;
    cleanup(false);
  }
  function cancel(){if(!d)return;if(d.mode==='key')return keyCancel();goHome();say('Move cancelled')}
  function cleanup(moved){
    const cur=d;d=null;
    cur.clone?.remove();cur.gap.remove();cur.el.classList.remove('drag-src','kb-lifted');
    for(const z of root.querySelectorAll('.drag-over'))z.classList.remove('drag-over');
    document.documentElement.classList.remove('dragging-cards');
    try{root.releasePointerCapture(cur.pid)}catch{}
    o.afterDrop?.(cur.id,moved);
  }

  // ---------- keyboard ----------
  root.addEventListener('keydown',e=>{
    const el=e.target.closest?.(o.item);
    if(!d&&el&&e.key===' '){e.preventDefault();e.stopPropagation();keyLift(el);return}
    if(!d||d.mode!=='key')return;
    if(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight',' ','Escape','Enter'].includes(e.key)){e.preventDefault();e.stopPropagation()}
    if(e.key==='ArrowUp'||e.key==='ArrowDown'){const n=shownIn(listIn(d.zone)).length;keyMove(d.zone,Math.max(0,Math.min(n,d.index+(e.key==='ArrowUp'?-1:1))))}
    else if(e.key==='ArrowLeft'||e.key==='ArrowRight'){const zs=zones(),i=zs.indexOf(d.zone)+(e.key==='ArrowLeft'?-1:1);if(zs[i])keyMove(zs[i],Math.min(d.index,shownIn(listIn(zs[i])).length))}
    else if(e.key===' '||e.key==='Enter')keyDrop();
    else if(e.key==='Escape')keyCancel();
  },true);
  function keyLift(el){
    d={el,id:o.idOf(el),mode:'key',lifted:true,from:o.keyOf(o.listOf(el)),zone:o.listOf(el),home:listIn(o.listOf(el)),homeNext:el.nextElementSibling};
    d.index=shownIn(d.home).indexOf(el);el.classList.add('kb-lifted');d.zone.classList.add('drag-over');
    // In keyboard mode the card itself moves (it stays focused); the gap is the card.
    d.gap=el;
    say(`Picked up ${o.describe?.(d.id,d.from,d.index+1,shownIn(d.home).length)||''}. Arrows move, Space drops, Escape cancels.`);
  }
  function keyMove(zone,idx){
    flip(neighbours(),()=>{
      d.zone.classList.remove('drag-over');
      const list=listIn(zone),items=shownIn(list).filter(x=>x!==d.el),before=items[idx]||list.querySelector(':scope>button')||null;
      list.insertBefore(d.el,before);zone.classList.add('drag-over');d.zone=zone;d.index=idx;
    });
    d.el.focus();say(o.describe?.(d.id,o.keyOf(zone),d.index+1,shownIn(listIn(zone)).length)||'');
  }
  async function keyDrop(){
    const cur=d,prev=d.el.previousElementSibling,next=d.el.nextElementSibling;
    const afterId=prev?.matches?.(o.item)?o.idOf(prev):null,beforeId=next?.matches?.(o.item)?o.idOf(next):null;
    const to=o.keyOf(d.zone);d.flying=true;
    let ok=false;try{ok=await o.onDrop({id:d.id,from:d.from,to,beforeId,afterId},{hideClone(){}})}catch{}
    if(d!==cur)return;
    if(!ok)return keyCancel();
    d=null;cur.el.classList.remove('kb-lifted');for(const z of root.querySelectorAll('.drag-over'))z.classList.remove('drag-over');
    say(`Dropped in ${to}`);o.afterDrop?.(cur.id,true);
  }
  function keyCancel(){
    const cur=d;
    flip(neighbours(),()=>{cur.home.insertBefore(cur.el,cur.homeNext&&cur.homeNext.parentElement===cur.home?cur.homeNext:null)});
    d=null;cur.el.classList.remove('kb-lifted');for(const z of root.querySelectorAll('.drag-over'))z.classList.remove('drag-over');
    cur.el.focus();say('Move cancelled');o.afterDrop?.(cur.id,false);
  }
  // True while a card is lifted and following the pointer or keys (not while it settles after a drop).
  return {active:()=>!!d&&!d.flying};
}
// A small settle after a card lands (scale .98 → 1), and a bump for count badges.
export function settle(el){if(el&&!reduced())el.animate([{transform:'scale(.98)'},{transform:'scale(1.01)',offset:.6},{transform:'none'}],{duration:220,easing:'ease-out'})}
export function bump(el){if(el&&!reduced())el.animate([{transform:'none'},{transform:'scale(1.35)'},{transform:'none'}],{duration:260,easing:SPRING})}
