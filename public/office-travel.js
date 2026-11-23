// "Go to…" and the minimap of the 3D office (docs/concepts/12-office.md "Getting about"). The same in every
// world: office.js says what there is to go to and where the floors and walls are (office-travel-core.js lists,
// filters and fits them), and walks the route this module asks for.
//
//   const travel=createTravel({root, stage, icon, places() -> placeList input, go(place), plan() -> {bounds,
//     nav, shapes:[{kind:'room'|'meeting'|'table'|'pod'|'board'|'door', x, z, w, d, yaw, color, name}], labels:[{x, z,
//     text}]}, me() -> {x, z, heading}, dots() -> [{x, z, color, kind:'person'|'waiting'}], route() -> [x, z, …]|null,
//     goPoint(x, z)})
//   travel.open() / close() / toggle()   the "Go to…" menu;  travel.escape() -> true when it closed something
//   travel.toggleMap()   travel.mapOn    travel.invalidate() (the plan changed)   travel.frame(t)   travel.dispose()
import {placeList,filterPlaces,mapFit} from './office-travel-core.js';

const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const MAP_KEY='flow.office.minimap';
const GROUP={place:'Places',room:'Rooms',person:'People here',session:'Live agents',agent:'AgentFlow'};
const GLYPH={place:'◆',room:'▣',person:'●',session:'◉',agent:'▪'};

export function createTravel(o){
  // ---------- Go to… ----------
  const menu=document.createElement('div');menu.className='of-goto';menu.hidden=true;menu.setAttribute('role','dialog');menu.setAttribute('aria-label','Go to');
  menu.innerHTML=`<div class="of-goto-h"><input type="text" class="of-goto-q" placeholder="Go to… a place, a person, an agent" aria-label="Go to" autocomplete="off" spellcheck="false" role="combobox" aria-expanded="true" aria-controls="of-goto-list"><kbd>Esc</kbd></div>
    <div class="of-goto-list" id="of-goto-list" role="listbox"></div>`;
  o.stage.append(menu);
  const input=menu.querySelector('.of-goto-q'),listEl=menu.querySelector('.of-goto-list');
  let shown=[],active=0,opener=null;
  function render(){
    shown=filterPlaces(placeList(o.places()),input.value).slice(0,80);active=Math.min(active,Math.max(0,shown.length-1));
    let html='',group='';
    shown.forEach((p,i)=>{
      const g=input.value.trim()?'':p.waiting?'Waiting on someone':GROUP[p.kind]||'';
      if(g&&g!==group){group=g;html+=`<div class="of-goto-g" role="presentation">${esc(g)}</div>`}
      html+=`<button type="button" role="option" id="of-goto-${i}" class="of-goto-i${p.waiting?' waiting':''}" data-i="${i}" aria-selected="${i===active}"><i class="of-goto-k ${p.kind}" aria-hidden="true">${GLYPH[p.kind]||''}</i><b>${esc(p.name)}</b>${p.sub?`<small>${esc(p.sub)}</small>`:''}</button>`;
    });
    listEl.innerHTML=html||'<p class="of-goto-none">Nothing by that name here.</p>';
    input.setAttribute('aria-activedescendant',shown.length?'of-goto-'+active:'');
  }
  function move(d){
    if(!shown.length)return;active=(active+d+shown.length)%shown.length;
    for(const b of listEl.querySelectorAll('.of-goto-i'))b.setAttribute('aria-selected',String(+b.dataset.i===active));
    listEl.querySelector(`[data-i="${active}"]`)?.scrollIntoView({block:'nearest'});input.setAttribute('aria-activedescendant','of-goto-'+active);
  }
  function choose(i){const p=shown[i];if(!p)return;close();o.go(p)}
  function open(){
    if(!menu.hidden)return;opener=document.activeElement;menu.hidden=false;input.value='';active=0;render();input.focus({preventScroll:true});
    o.root.querySelector('[data-of="goto"]')?.setAttribute('aria-expanded','true');
  }
  function close(){
    if(menu.hidden)return false;menu.hidden=true;
    o.root.querySelector('[data-of="goto"]')?.setAttribute('aria-expanded','false');
    (opener?.isConnected&&o.root.contains(opener)&&opener!==input?opener:o.root).focus({preventScroll:true});return true;
  }
  input.addEventListener('input',()=>{active=0;render()});
  input.addEventListener('keydown',e=>{
    if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();move(e.key==='ArrowDown'?1:-1)}
    else if(e.key==='Enter'){e.preventDefault();choose(active)}
    else if(e.key==='Tab'){e.preventDefault();move(e.shiftKey?-1:1)}
  });
  listEl.addEventListener('click',e=>{const b=e.target.closest('.of-goto-i');if(b)choose(+b.dataset.i)});
  listEl.addEventListener('pointermove',e=>{const b=e.target.closest('.of-goto-i');if(b&&+b.dataset.i!==active){active=+b.dataset.i;for(const x of listEl.querySelectorAll('.of-goto-i'))x.setAttribute('aria-selected',String(x===b))}});
  const outside=e=>{if(!menu.hidden&&!menu.contains(e.target)&&!e.target.closest?.('[data-of="goto"]'))close()};
  o.root.addEventListener('pointerdown',outside,true);

  // ---------- the minimap ----------
  const map=document.createElement('div');map.className='of-map';
  map.innerHTML=`<canvas class="of-map-c" role="img" aria-label="Minimap: click to walk there"></canvas>
    <div class="of-map-l" aria-hidden="true"><span><i class="me"></i>You</span><span><i></i>People</span><span><i class="w"></i>Waiting on someone</span></div>`;
  o.stage.append(map);
  const cv=map.querySelector('canvas'),ctx=cv.getContext('2d');
  // On: unless you turned it off. A phone-sized stage starts without it (it would cover the view) until you ask for it.
  const narrow=()=>(o.stage.clientWidth||innerWidth)<700;
  let on=!narrow();try{const v=localStorage.getItem(MAP_KEY);if(v==='0')on=false;else if(v==='1')on=true}catch{}
  let fit=null,base=null,dirty=true,drawnAt=-1,builtAt=-9,named=[];
  const paintToggle=()=>{map.hidden=!on;o.root.querySelector('[data-of="map"]')?.setAttribute('aria-pressed',String(on))};
  function toggleMap(){on=!on;try{localStorage.setItem(MAP_KEY,on?'1':'0')}catch{}paintToggle();dirty=true}
  // The plan that does not move: floors by height, what stops you, rooms, tables, the board. Drawn once per layout.
  function rebuild(){
    dirty=false;const plan=o.plan();if(!plan?.bounds){fit=null;return}
    const wide=o.stage.clientWidth||innerWidth;
    fit=mapFit(plan.bounds,narrow()?{maxW:Math.min(300,wide-30),maxH:120}:{maxW:Math.min(430,wide*0.36),maxH:210});
    const dpr=Math.min(2,devicePixelRatio||1);
    cv.width=Math.round(fit.w*dpr);cv.height=Math.round(fit.h*dpr);cv.style.width=fit.w+'px';cv.style.height=fit.h+'px';
    base=document.createElement('canvas');base.width=cv.width;base.height=cv.height;
    const g=base.getContext('2d');g.scale(dpr,dpr);
    const nav=plan.nav;
    if(nav){
      // Floors: one tone per height (lighter the higher); a cell something stands in is darker.
      const {minX,minZ}=nav.bounds,c=nav.cell,k=fit.scale*c+0.6;let lo=Infinity,hi=-Infinity;const hs=[];
      for(let j=0;j<nav.h;j++)for(let i=0;i<nav.w;i++){const y=plan.ground?plan.ground(minX+(i+0.5)*c,minZ+(j+0.5)*c):0;hs.push(y);if(y!==null&&y!==undefined){lo=Math.min(lo,y);hi=Math.max(hi,y)}}
      for(let j=0;j<nav.h;j++)for(let i=0;i<nav.w;i++){
        const y=hs[j*nav.w+i];if(y===null||y===undefined)continue;
        const x=minX+(i+0.5)*c,z=minZ+(j+0.5)*c,p=fit.toMap(x,z),t=hi>lo?(y-lo)/(hi-lo):0.5,blocked=nav.blocked[j*nav.w+i];
        g.fillStyle=blocked?`hsl(32 16% ${48+t*12}%)`:`hsl(34 38% ${70+t*18}%)`;g.fillRect(p.x-k/2,p.y-k/2,k,k);
      }
    }else{g.fillStyle='#e6ddcd';g.fillRect(0,0,fit.w,fit.h)}
    const rect=(s,fill,stroke)=>{
      const p=fit.toMap(s.x,s.z);g.save();g.translate(p.x,p.y);g.rotate(fit.turned?-(s.yaw||0)-Math.PI/2:-(s.yaw||0));
      const w=s.w*fit.scale,d=s.d*fit.scale;if(fill){g.fillStyle=fill;g.fillRect(-w/2,-d/2,w,d)}if(stroke){g.strokeStyle=stroke;g.lineWidth=1.2;g.strokeRect(-w/2,-d/2,w,d)}g.restore();
    };
    // What the pointer names as it moves over the map.
    named=[...(plan.shapes||[]).filter(s=>s.name),...(plan.labels||[]).filter(l=>l.text).map(l=>({...l,name:l.text}))].map(s=>({...fit.toMap(s.x,s.z),name:s.name}));
    for(const s of plan.shapes||[]){
      if(s.kind==='room')rect(s,s.color||'#dfe8e2','rgba(40,60,50,.55)');
      else if(s.kind==='meeting')rect(s,'rgba(120,190,215,.75)','#3c88a3');
      else if(s.kind==='table')rect(s,'#b98d63',null);
      else if(s.kind==='pod')rect(s,s.color?s.color+'55':'rgba(95,158,110,.3)','rgba(40,60,50,.35)');
      else if(s.kind==='board')rect({...s,d:Math.max(0.5,3/fit.scale)},'#22302c',null);
      else if(s.kind==='door'){const p=fit.toMap(s.x,s.z);g.fillStyle='#3d6fb6';g.beginPath();g.arc(p.x,p.y,3,0,7);g.fill()}
    }
    g.font='600 9.5px system-ui,sans-serif';g.textAlign='center';g.textBaseline='middle';g.lineJoin='round';
    // Names, the first given first; one that would sit on another is left out.
    const taken=[];
    for(const l of plan.labels||[]){
      if(!l.text)continue;
      const p=fit.toMap(l.x,l.z),w=g.measureText(l.text).width/2+3,x=Math.max(w,Math.min(fit.w-w,p.x)),y=Math.max(7,Math.min(fit.h-7,p.y));
      if(taken.some(t=>Math.abs(t.x-x)<t.w+w&&Math.abs(t.y-y)<11))continue;
      taken.push({x,y,w});g.strokeStyle='rgba(255,255,255,.9)';g.lineWidth=3;g.strokeText(l.text,x,y);g.fillStyle='#22302c';g.fillText(l.text,x,y);
    }
  }
  function frame(t){
    if(!on||map.hidden)return;
    // The plan is drawn again when something moved, at most twice a second (a busy office changes often).
    if(dirty&&(!fit||t-builtAt>0.5)){builtAt=t;rebuild()}
    if(!fit||t-drawnAt<0.1)return;drawnAt=t;
    const dpr=cv.width/fit.w;ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,cv.width,cv.height);ctx.drawImage(base,0,0);ctx.setTransform(dpr,0,0,dpr,0,0);
    const r=o.route?.();
    if(r&&r.length>=4){ctx.strokeStyle='rgba(61,143,102,.95)';ctx.lineWidth=2;ctx.setLineDash([4,3]);ctx.beginPath();const m=o.me(),a=fit.toMap(m.x,m.z);ctx.moveTo(a.x,a.y);for(let i=0;i<r.length;i+=2){const p=fit.toMap(r[i],r[i+1]);ctx.lineTo(p.x,p.y)}ctx.stroke();ctx.setLineDash([])}
    for(const d of o.dots()){
      const p=fit.toMap(d.x,d.z);
      if(d.kind==='waiting'){const pulse=3.6+Math.sin(t*5)*1.1;ctx.fillStyle='rgba(255,176,32,.35)';ctx.beginPath();ctx.arc(p.x,p.y,pulse+2.5,0,7);ctx.fill();ctx.fillStyle='#ffb020';ctx.strokeStyle='#7a4a00';ctx.lineWidth=1;ctx.beginPath();ctx.arc(p.x,p.y,3.4,0,7);ctx.fill();ctx.stroke()}
      else{ctx.fillStyle=d.color||'#3d6fb6';ctx.strokeStyle='#fff';ctx.lineWidth=1.5;ctx.beginPath();ctx.arc(p.x,p.y,4,0,7);ctx.fill();ctx.stroke()}
    }
    const m=o.me(),p=fit.toMap(m.x,m.z);
    ctx.save();ctx.translate(p.x,p.y);ctx.rotate(fit.turn(m.heading));ctx.fillStyle='#fff';ctx.strokeStyle='#1d2725';ctx.lineWidth=1.6;ctx.lineJoin='round';
    ctx.beginPath();ctx.moveTo(0,-7);ctx.lineTo(5,5.5);ctx.lineTo(0,2.6);ctx.lineTo(-5,5.5);ctx.closePath();ctx.fill();ctx.stroke();ctx.restore();
  }
  cv.addEventListener('pointermove',e=>{
    if(!fit)return;const b=cv.getBoundingClientRect(),x=(e.clientX-b.left)*fit.w/b.width,y=(e.clientY-b.top)*fit.h/b.height;
    let best='',bd=22;for(const n of named){const d=Math.hypot(n.x-x,n.y-y);if(d<bd){bd=d;best=n.name}}
    const tip=best?`${best}: click to go there`:'Click to walk there';if(cv.title!==tip)cv.title=tip;
  });
  cv.addEventListener('click',e=>{
    if(!fit)return;const b=cv.getBoundingClientRect(),w=fit.toWorld((e.clientX-b.left)*fit.w/b.width,(e.clientY-b.top)*fit.h/b.height);
    o.goPoint(w.x,w.z);
  });
  paintToggle();
  return {
    open,close,toggle:()=>menu.hidden?open():close(),get isOpen(){return !menu.hidden},escape:close,
    toggleMap,get mapOn(){return on},invalidate(){dirty=true},resize(){dirty=true},frame,
    // For tests and the screenshot harness.
    debug:()=>({shown:shown.map(p=>p.id),input:o.places(),fit:fit&&{w:fit.w,h:fit.h,turned:fit.turned,scale:fit.scale}}),
    dispose(){o.root.removeEventListener('pointerdown',outside,true);menu.remove();map.remove()},
  };
}
