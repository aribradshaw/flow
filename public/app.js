import {icon} from './icons.js';
import {$,esc,ib,uid,clone,initTooltips,initSelects,hideTip,personAvatar,personPhoto,setPeopleSource} from './ui.js';
import {store,chart,change,checkpoint,commit,step,save,validChart,validDb,replaceDb,validPersonImage,cleanPersonEmail} from './store.js';
import * as tl from './timeline.js';
import * as dv from './devops.js';
import * as af from './agentflow.js';
import {openCardsFor} from './devops-core.js';
import {peopleOf} from './agentflow-core.js';
import {swap,busy,unskeletonize,panel,panelReset,popOut} from './motion.js';
import {TABS,parseHash,hashFor,clampRatio,openSplit,closePane,clickTab,revealTab,cleanSplit,NARROW,DIVIDER} from './split-core.js';
import {logoMark} from './logo-mark.js';
import {accountHtml,sessionUser} from './account.js';
import {startInbox} from './inbox.js';
import {startSync} from './sync.js';
import {loadDevlog} from './devlog.js';
import {matches,keyLabel} from './shortcuts.js';
import {onPrefs,syncPrefs} from './prefs.js';
import {ask} from './modal.js';
import {openMenu} from './menu.js';
import {linkOf,canEdit,sharedTip,historyHtml,loadHistory,postComment,openShareDialog} from './share.js';

let instanceName='Flow',instanceLogo='';
fetch('/api/instance').then(r=>r.ok?r.json():null).then(v=>{
  if(!v)return;
  instanceName=v.name||'Flow';instanceLogo=v.logo||'';
  document.title=instanceName;
  document.documentElement.style.setProperty('--flygon-green',v.accent);
  renderTop();
}).catch(()=>{});

const GRID=16;
const KINDS={
  entity:{icon:'building',label:'Entity',sc:'chart.addEntity',size:[176,48]},
  person:{icon:'user',label:'Person',sc:'chart.addPerson',size:[160,48]},
  area:{icon:'area',label:'Project area',sc:'chart.addArea',size:[192,48]},
  note:{icon:'note',label:'Note',sc:'chart.addNote',size:[160,64]},
};
const snap=(v,on=true)=>on?Math.round(v/GRID)*GRID:Math.round(v);
const size=n=>[n.w||KINDS[n.type].size[0],n.h||KINDS[n.type].size[1]];
const rect=n=>{const [w,h]=size(n);return {x:n.x,y:n.y,w,h}};
const node=id=>chart().nodes.find(n=>n.id===id);
const edge=id=>chart().edges.find(e=>e.id===id);

// Split view: split.tabs is [left, right] while two tabs show side by side (null: one view) and
// split.ratio the left pane's share. tab is the focused pane's tab, so everything that follows "the
// current tab" (header, side panel, shortcuts, Escape) follows focus. Kept per device in localStorage
// (it depends on the screen); the hash is #left|right. A bare URL brings the last split back.
const SPLITKEY='flygon-flow-split';
const split=(()=>{try{return cleanSplit(JSON.parse(localStorage.getItem(SPLITKEY)))}catch{return cleanSplit()}})();
const keepSplit=()=>{try{localStorage.setItem(SPLITKEY,JSON.stringify(split))}catch{}};
const narrow=()=>innerWidth<NARROW,isSplit=()=>!!split.tabs&&!narrow();
const openTabs=()=>isSplit()?split.tabs:[tab],isOpen=t=>openTabs().includes(t);
const layoutNow=()=>({tabs:split.tabs,focus:split.tabs?Math.max(0,split.tabs.indexOf(tab)):0});
const startHash=parseHash(location.hash);
if(startHash.tabs||location.hash)split.tabs=startHash.tabs;
let tab=split.tabs?split.tabs[0]:startHash.tab,selected=null,connecting=false,source=null,renaming=false,fitted=false;
let view={x:40,y:40,z:1},drag=null,statusState='ok',statusText='Saved';
const tools=[],edited=new WeakSet();
let stripOff=localStorage.getItem('org-chart-studio-strip')==='off';


// ---------- top bar ----------
// A tab that is not showing has a split notch (top right, on hover); in split view both shown tabs
// are selected, mark their side and have an × there that closes their pane.
function tabBtn(id,ic,label){
  const sp=isSplit(),side=sp?split.tabs.indexOf(id):-1,on=sp?side>=0:tab===id,where=side?'right':'left';
  const corner=narrow()?'':side>=0?`<button type="button" class="tab-x" data-split-close="${id}" data-tip="Close this pane" aria-label="Close the ${label} pane">${icon('x',10)}</button>`
    :!sp&&!on?`<button type="button" class="tab-x" data-split-open="${id}" data-tip="Open in split view" aria-label="Open ${label} in split view">${icon('split',11)}</button>`:'';
  return `<span class="tab-w"><button type="button" class="tab${side>=0?` in-split${id===tab?' focus':''}`:''}" role="tab" data-tab="${id}" aria-selected="${on}"${side>=0?` data-side="${where}" aria-label="${label}, ${where} pane${id===tab?', focused':''}"`:''}>${icon(ic,15)}${label}${side>=0?`<span class="tab-side" aria-hidden="true">${icon(side?'paneR':'paneL',11)}</span>`:''}</button>${corner}</span>`;
}
function renderTop(){
  const c=chart(),db=store.db;
  const ctx=tab==='chart'
    ?(renaming?`<input id="chartName" class="chart-name" maxlength="120" value="${esc(c.name)}" aria-label="Mind map name">`
      :`<select id="charts" data-tip="Switch mind map" aria-label="Mind map">${db.charts.map(x=>`<option value="${esc(x.id)}"${x.id===db.active?' selected':''}>${esc(x.name)}</option>`).join('')}</select>`)
      +ib('pencil','Rename mind map',{attrs:'data-act="rename"'})+ib('filePlus','New mind map',{attrs:'data-act="new"'})
      +(db.charts.length>1?ib('trash','Delete this mind map',{cls:'danger',attrs:'data-act="dropChart"'}):'')
      +`<span class="meta" data-tip="${c.nodes.length} cards · ${c.edges.length} connections">${c.nodes.length} · ${c.edges.length}</span>`
    :tab==='timeline'?tl.headerHtml():tab==='devops'?dv.headerHtml():af.headerHtml();
  $('#top').innerHTML=`<span class="logo" data-tip="${esc(instanceName)}">${instanceLogo?`<img src="${esc(instanceLogo)}" alt="" width="20" height="20">`:logoMark(20)}</span>
    <nav class="tabs" role="tablist"${isSplit()?' aria-multiselectable="true"':''}>${tabBtn('chart','network','MindMap')}${tabBtn('timeline','gantt','Timeline')}${tabBtn('devops','branch','DevOps')}${tabBtn('agentflow','bot','AgentFlow')}</nav>
    <div class="ctx">${ctx}</div><span class="sp"></span>
    ${ib('save','Save\nTo this computer and the Flygon cloud',{key:keyLabel('global.save'),attrs:'data-act="saveNow"'})}${ib('open','Load a save',{cls:loadPop?'on':'',attrs:'data-act="load"'})}
    <span id="status" class="dot ${statusState}" data-tip="${esc(statusText)}" role="status" aria-label="${esc(statusText)}"></span>
    ${accountHtml()}`;
}
store.onStatus=(s,text)=>{statusState=s;statusText=text;const el=$('#status');if(el){el.className='dot '+s;el.dataset.tip=text;el.setAttribute('aria-label',text)}};

const VIEWS={chart:'#chartView',timeline:'#timelineView',devops:'#devopsView',agentflow:'#agentflowView'};
// Entrance order per view: toolbar, then panels, then columns / rows / cards.
const ENTER={chart:['#canvas','#tools,#zoom','#strip'],timeline:['.tl-bar','.tl-scroll','.lane,.board .col,.lr'],devops:['.dv-bar','.dcol'],agentflow:['.af-bar','.af-canvas,.af-flows']};
function setTab(t){
  // A single-view change (a narrow window) drops a stored split that no longer holds the tab.
  if(split.tabs&&!split.tabs.includes(t)){split.tabs=null;keepSplit()}
  if(t===tab)return;
  const from=$(VIEWS[tab]);
  tab=t;selected=null;connecting=false;source=null;renaming=false;tl.leave();dv.leave();af.leave();
  swap({from,update(){render();if(tab==='chart'&&!fitted)fit()},to:()=>[$(VIEWS[tab]),ENTER[tab]]});
}
// ---------- split view ----------
// Each pane wraps one view's own <section> (moved in, so its listeners and state come along) and the
// focused pane also holds the one side panel (#inspector), which shows the focused view's selection.
// The other pane keeps its selection on its canvas and gets its panel back when it is focused again.
const mainEl=$('main'),inspectorEl=$('#inspector'),SCROLLERS='.tl-scroll,.dv-scroll,.af-scroll,.dcol-b';
let panes=null;
function leaveTab(t){if(t==='chart'){selected=null;connecting=false;source=null}else ({timeline:tl,devops:dv,agentflow:af})[t].leave()}
// Moving a section keeps its scroll positions.
function moveView(sec,parent,before=null){
  if(sec.parentNode===parent&&(before?sec.nextSibling===before:true))return;
  const keep=[...sec.querySelectorAll(SCROLLERS)].map(el=>[el,el.scrollLeft,el.scrollTop]);
  parent.insertBefore(sec,before);
  for(const [el,l,t] of keep){el.scrollLeft=l;el.scrollTop=t}
}
function makeDivider(){
  const d=document.createElement('div');
  Object.assign(d,{className:'split-div',tabIndex:0});
  for(const [k,v] of Object.entries({role:'separator','aria-orientation':'vertical','aria-label':'Resize the split panes','aria-valuemin':'0','aria-valuemax':'100','data-tip':'Drag to resize · double-click for 50/50','data-tip-delay':'700'}))d.setAttribute(k,v);
  let pid=null;
  d.addEventListener('pointerdown',e=>{if(e.button!==0)return;e.preventDefault();pid=e.pointerId;d.setPointerCapture(pid);hideTip();document.body.classList.add('split-drag')});
  d.addEventListener('pointermove',e=>{if(e.pointerId!==pid)return;const r=mainEl.getBoundingClientRect();setRatio((e.clientX-r.left-DIVIDER/2)/(r.width-DIVIDER),false)});
  const end=e=>{if(e.pointerId!==pid)return;pid=null;document.body.classList.remove('split-drag');keepSplit()};
  d.addEventListener('pointerup',end);d.addEventListener('pointercancel',end);
  d.addEventListener('dblclick',()=>setRatio(.5));
  d.addEventListener('keydown',e=>{
    const k={ArrowLeft:-.02,ArrowRight:.02}[e.key];
    if(k||e.key==='Home'||e.key==='End'||e.key==='Enter'){e.preventDefault();e.stopPropagation();setRatio(k?clampRatio(split.ratio,mainEl.clientWidth)+k:e.key==='Home'?0:e.key==='End'?1:.5)}
  });
  return d;
}
const applyRatio=()=>{const r=clampRatio(split.ratio,mainEl.clientWidth);mainEl.style.setProperty('--split',String(r));panes?.[1].setAttribute('aria-valuenow',String(Math.round(r*100)))};
function setRatio(r,persist=true){split.ratio=clampRatio(r,mainEl.clientWidth);keepCentre(applyRatio);if(persist)keepSplit()}
// Resizing a pane keeps the MindMap and the AgentFlow org centred in it.
function keepCentre(fn){
  const cv=$('#canvas'),c0=cv.clientWidth,a0=$('#afCanvas')?.clientWidth||0;
  fn();
  const c1=cv.clientWidth,a1=$('#afCanvas')?.clientWidth||0;
  if(c0&&c1&&c0!==c1){view.x+=(c1-c0)/2;renderCanvas()}
  if(a0&&a1&&a0!==a1)af.pan((a1-a0)/2);
}
// Put the DOM in step with the state: sections in their panes (or back in <main>), the side panel in
// the focused pane, the divider at the ratio.
function layout(){
  const on=isSplit();
  document.body.classList.toggle('split',on);
  if(!on){
    if(!panes)return;
    if(inspectorFor!==tab)panelReset(inspectorEl);
    mainEl.append(inspectorEl);for(const t of TABS)moveView($(VIEWS[t]),mainEl,inspectorEl);
    for(const p of panes)p.remove();panes=null;mainEl.style.removeProperty('--split');return;
  }
  if(!panes){
    const pane=i=>{const p=document.createElement('div');p.className='pane';p.dataset.pane=String(i);return p};
    panes=[pane(0),makeDivider(),pane(1)];mainEl.append(...panes);
  }
  split.tabs.forEach((t,i)=>{
    const p=panes[i*2],sec=$(VIEWS[t]);
    for(const old of p.querySelectorAll(':scope>.view'))if(old!==sec)moveView(old,mainEl,panes[0]);
    moveView(sec,p,p.firstChild);
    p.classList.toggle('focus',t===tab);p.dataset.paneTab=t;
  });
  const fp=panes[split.tabs.indexOf(tab)*2];
  if(inspectorEl.parentNode!==fp){if(inspectorFor!==tab)panelReset(inspectorEl);fp.append(inspectorEl)}
  applyRatio();
}
// Change what shows: tabs [left, right] or null, focused tab `to`; how = 'push' | 'replace' the hash.
// Tabs that stop showing are left (their selection clears); new ones animate in.
function setLayout(tabs,to,how){
  if(renaming)$('#chartName')?.blur();
  const before=openTabs();
  split.tabs=tabs;tab=to;keepSplit();
  const now=openTabs();
  for(const t of before)if(!now.includes(t))leaveTab(t);
  if(how)history[how==='push'?'pushState':'replaceState'](null,'',hashFor(tab,split.tabs)||location.pathname);
  const fresh=now.find(t=>!before.includes(t));
  const update=()=>{keepCentre(layout);render();if(isOpen('chart')&&!fitted)fit();af.resized()};
  if(fresh)swap({from:null,update,to:()=>[$(VIEWS[fresh]),ENTER[fresh]]});else update();
}
// Focus a pane: the header, side panel, shortcuts and Escape follow it. Its contents are not redrawn
// (this runs on pointerdown, before the view's own handlers see the press).
function focusPane(i){
  const t=split.tabs?.[i];if(!t||t===tab)return;
  if(!isSplit()){setLayout(split.tabs,t);return}
  if(renaming)$('#chartName')?.blur();
  tab=t;hideTip();layout();document.body.dataset.tab=tab;renderTop();renderInspector(false);
}
// Focus follows a press in a pane, or keyboard Tab into it (programmatic focus, e.g. a closing modal
// handing focus back, does not move it).
let tabbing=false;
document.addEventListener('keydown',e=>{tabbing=e.key==='Tab'},true);
document.addEventListener('pointerdown',()=>{tabbing=false},true);
mainEl.addEventListener('pointerdown',e=>{const p=isSplit()&&e.target.closest?.('.pane');if(p)focusPane(+p.dataset.pane)},true);
mainEl.addEventListener('focusin',e=>{const p=tabbing&&isSplit()&&e.target.closest?.('.pane');if(p)focusPane(+p.dataset.pane)});
// Narrow windows show the focused pane alone; the split comes back when there is room again.
let wasNarrow=narrow();
window.addEventListener('resize',()=>{
  if(narrow()!==wasNarrow){wasNarrow=narrow();if(split.tabs){keepCentre(layout);render();if(isOpen('chart')&&!fitted)fit()}else renderTop()}
  else if(isSplit())applyRatio();
});
// Canvases size to their pane: a first fit waits for a width, and the chart strip follows the divider.
let chartW=0;
new ResizeObserver(()=>{
  const w=$('#chartView').clientWidth;
  if(w&&w!==chartW){chartW=w;if(!fitted&&isOpen('chart'))fit();if(isSplit()&&isOpen('chart')&&!stripAdding)renderStrip()}
  if(isOpen('agentflow'))af.resized();
}).observe($('#chartView'));
new ResizeObserver(()=>{if(isOpen('agentflow'))af.resized()}).observe($('#agentflowView'));

// Back / Forward: a split hash restores that split; a deep link (#devops/card/4) into a shown pane
// focuses it; any other single-tab hash leaves the split.
window.addEventListener('popstate',()=>{
  const h=parseHash(location.hash);
  if(h.tabs){if(h.tabs.join()!==split.tabs?.join())setLayout(h.tabs,h.tabs.includes(tab)?tab:h.tabs.find(t=>!split.tabs?.includes(t))||h.tabs[0])}
  else if(split.tabs&&location.hash.includes('/')&&split.tabs.includes(h.tab))focusPane(split.tabs.indexOf(h.tab));
  else if(split.tabs)setLayout(null,h.tab);
  else setTab(h.tab);
  if(isOpen('devops'))dv.syncHash();
});
$('#top').addEventListener('click',e=>{
  const so=e.target.closest('[data-split-open]');if(so){const n=!narrow()&&openSplit(tab,so.dataset.splitOpen);if(n)setLayout(n.tabs,n.tabs[n.focus],'replace');return}
  const sc=e.target.closest('[data-split-close]');if(sc){const n=closePane(layoutNow(),sc.dataset.splitClose);if(n)setLayout(null,n.tab,'replace');return}
  const t=e.target.closest('.tab[data-tab]');
  // In split view a shown tab takes focus; any other tab replaces the focused pane.
  if(t&&isSplit()){const n=clickTab(layoutNow(),t.dataset.tab);if(n.replaced)setLayout(n.tabs,n.tab,'push');else focusPane(n.focus);return}
  if(t){if(t.dataset.tab!==tab){history.pushState(null,'',t.dataset.tab==='chart'?location.pathname:'#'+t.dataset.tab);setTab(t.dataset.tab)}else if(split.tabs){split.tabs=null;keepSplit();history.replaceState(null,'',hashFor(tab,null)||location.pathname)}return}
  const b=e.target.closest('[data-act],[data-tl]');if(!b)return;
  if(b.dataset.tl)return tl.action(b.dataset.tl,b);
  ({rename(){renaming=true;renderTop();const i=$('#chartName');i.focus();i.select()},
    new(){change(()=>{const c={id:uid(),name:'Untitled mind map',nodes:[],edges:[]};store.db.charts.push(c);store.db.active=c.id;selected=null});fit()},
    saveNow,load:()=>loadPop?closeLoad():openLoad(b),
    dropChart(){ask(`Delete "${chart().name}"?
You can undo this.`,{ok:'Delete',danger:true}).then(ok=>{if(ok){change(()=>{store.db.charts=store.db.charts.filter(c=>c.id!==store.db.active);store.db.active=store.db.charts[0].id;selected=null});fit()}})},
  })[b.dataset.act]?.();
});
$('#top').addEventListener('change',e=>{if(e.target.id==='charts'){store.db.active=e.target.value;selected=null;connecting=false;source=null;save();render();fit()}});
$('#top').addEventListener('keydown',e=>{if(e.target.id!=='chartName')return;if(e.key==='Enter')e.target.blur();if(e.key==='Escape'){renaming=false;renderTop()}});
$('#top').addEventListener('focusout',e=>{
  if(e.target.id!=='chartName'||!renaming)return;
  const name=e.target.value.trim();renaming=false;
  if(name&&name!==chart().name)change(()=>chart().name=name);else renderTop();
});
$('#file').onchange=async e=>{
  const file=e.target.files[0];if(!file)return;
  try{
    if(file.size>5_000_000)throw Error('File is too large (5 MB maximum)');
    const data=JSON.parse(await file.text()),c=data.chart||data;
    if(validDb(data)){replaceDb(data);toast('Loaded '+file.name+' · Ctrl Z to undo');if(isOpen('chart'))fit();e.target.value='';return}
    if(!validChart(c))throw Error('Invalid mind map: check entities, connections and percentages');
    change(()=>{c.id=uid();c.name+=' (imported)';store.db.charts.push(c);store.db.active=c.id;selected=null});fit();
  }catch(err){alert(err.message)}
  e.target.value='';
};

// ---------- save / load: snapshots on this computer (saves/) and in the cloud (Railway Postgres) ----------
let loadPop=null,toastTimer=0;
const when=iso=>new Date(iso).toLocaleString([],{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
function toast(text,warn=false){
  let el=$('#toast');if(!el){el=document.createElement('div');el.id='toast';el.setAttribute('role','status');document.body.append(el)}
  el.textContent=text;el.className=warn?'warn on':'on';clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.className=warn?'warn':'',warn?6000:2600);
}
async function saveNow(){
  store.onStatus('saving','Saving…');
  try{
    const r=await fetch('/api/saves',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(store.db)}),s=await r.json();
    if(!r.ok)throw Error(s.error||'Save failed');
    const where=s.local&&s.cloud?'this computer and the cloud':s.cloud?'the cloud only':'this computer only';
    store.onStatus(s.error?'warn':'ok',`Saved to ${where} · ${when(s.at)}${s.error?'\n'+s.error:''}`);
    toast(`Saved to ${where}`+(s.error?` · ${s.error}`:''),!!s.error);
  }catch(err){store.onStatus('warn','Save failed\n'+err.message);toast('Save failed · '+err.message,true)}
  if(loadPop)openLoad();
}
function closeLoad(){loadPop=null;const el=$('#loadPop');if(el){el.id='';popOut(el)}renderTop()}
async function openLoad(btn){
  if(btn){const r=btn.getBoundingClientRect();loadPop={top:r.bottom+4,right:innerWidth-r.right}}
  let el=$('#loadPop');if(!el){el=document.createElement('div');el.id='loadPop';el.className='pop load';document.body.append(el);renderTop()}
  Object.assign(el.style,{top:loadPop.top+'px',right:loadPop.right+'px'});
  el.innerHTML=`<div class="lp-list"></div>`;
  let res;const req=fetch('/api/saves').then(r=>r.json()).catch(()=>({cloud:'error: server unreachable',saves:[]}));
  busy(el.querySelector('.lp-list'),req,{rows:4,rowHeight:30});res=await req;
  if(!loadPop)return;
  const where=s=>`${s.local?`<span data-tip="On this computer">${icon('laptop',13)}</span>`:''}${s.cloud?`<span data-tip="In the cloud">${icon('cloud',13)}</span>`:''}`;
  const cloud=res.cloud==='ok'?'':`<div class="lp-msg warn">${icon('alert',13)}<span>${res.cloud==='off'?'Cloud not configured · local saves only':esc('Cloud unavailable · '+res.cloud.replace(/^error: /,''))}</span></div>`;
  el.innerHTML=cloud+(res.saves.length?`<div class="lp-list">${res.saves.map(s=>`<button type="button" data-load="${esc(s.id)}" data-tip="${esc(s.label)}
${s.charts} mind map${s.charts===1?'':'s'} · ${s.items} timeline item${s.items===1?'':'s'}" data-tip-delay="500"><span class="lp-when">${esc(when(s.at))}</span><span class="lp-label">${esc(s.label)}</span><span class="lp-where">${where(s)}</span></button>`).join('')}</div>`:`<div class="lp-msg">No saves yet</div>`)
    +`<button type="button" class="txt lp-file" data-load-file>${icon('upload',13)}From a file…</button>`;
}
document.addEventListener('pointerdown',e=>{if(loadPop&&!e.target.closest('#loadPop,[data-act="load"]'))closeLoad()},true);
document.addEventListener('click',async e=>{
  const b=e.target.closest('#loadPop button');if(!b)return;
  if(b.hasAttribute('data-load-file')){closeLoad();$('#file').click();return}
  const at=b.querySelector('.lp-when').textContent;closeLoad();
  try{
    // The splash only appears if loading takes over 300 ms.
    const req=fetch('/api/saves/'+b.dataset.load);window.flowSplash?.during(req);
    const r=await busy($('main'),req),s=await r.json();
    if(!r.ok||!validDb(s.data))throw Error(s.error||'That save is not a valid workspace');
    replaceDb(s.data);if(isOpen('chart'))fit();toast(`Loaded save from ${at} · Ctrl Z to undo`);
  }catch(err){toast('Load failed · '+err.message,true)}
  finally{unskeletonize($('main'))}
});

// ---------- canvas ----------
const DEFS=`<defs><marker id="arrow" viewBox="0 0 8 8" markerWidth="8" markerHeight="8" refX="8" refY="4" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0.5 L8,4 L0,7.5 z" fill="#4d6e62"/></marker><marker id="arrowSel" viewBox="0 0 8 8" markerWidth="9" markerHeight="9" refX="8" refY="4" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0.5 L8,4 L0,7.5 z" fill="#a8524c"/></marker></defs>`;

// Each edge attaches to the facing sides of its two cards. Edges sharing a side are spread
// along it (ordered by where the other card sits) so busy cards don't collect a knot of lines.
const NORMAL={t:[0,-1],b:[0,1],l:[-1,0],r:[1,0]};
function sides(a,b){
  const dx=b.x+b.w/2-a.x-a.w/2,dy=b.y+b.h/2-a.y-a.h/2;
  return Math.abs(dy)-(a.h+b.h)/2>=Math.abs(dx)-(a.w+b.w)/2?(dy>=0?['b','t']:['t','b']):(dx>=0?['r','l']:['l','r']);
}
function layoutEdges(c){
  const rects=new Map(c.nodes.map(n=>[n.id,rect(n)])),slots=new Map(),out=new Map();
  for(const e of c.edges){
    const a=rects.get(e.from),b=rects.get(e.to);if(!a||!b)continue;
    const [sa,sb]=sides(a,b);
    for(const [id,side,other] of [[e.from,sa,b],[e.to,sb,a]]){
      const key=id+':'+side,along='tb'.includes(side)?other.x+other.w/2:other.y+other.h/2;
      if(!slots.has(key))slots.set(key,[]);slots.get(key).push({e:e.id,end:id===e.from?0:1,along});
    }
    out.set(e.id,{a,b,sa,sb,t:[.5,.5]});
  }
  for(const list of slots.values()){
    if(list.length<2)continue;
    list.sort((p,q)=>p.along-q.along);
    list.forEach((p,i)=>out.get(p.e).t[p.end]=.15+.7*(i+.5)/list.length);
  }
  for(const [id,g] of out){
    const pt=(r,side,t)=>side==='t'?{x:r.x+r.w*t,y:r.y}:side==='b'?{x:r.x+r.w*t,y:r.y+r.h}:side==='l'?{x:r.x,y:r.y+r.h*t}:{x:r.x+r.w,y:r.y+r.h*t};
    const p0=pt(g.a,g.sa,g.t[0]),p3=pt(g.b,g.sb,g.t[1]),n0=NORMAL[g.sa],n3=NORMAL[g.sb];
    const k=Math.max(20,Math.min(120,Math.hypot(p3.x-p0.x,p3.y-p0.y)/2.5));
    const p1={x:p0.x+n0[0]*k,y:p0.y+n0[1]*k},p2={x:p3.x+n3[0]*k,y:p3.y+n3[1]*k};
    out.set(id,{d:`M${p0.x} ${p0.y}C${p1.x} ${p1.y} ${p2.x} ${p2.y} ${p3.x} ${p3.y}`,mx:(p0.x+3*p1.x+3*p2.x+p3.x)/8,my:(p0.y+3*p1.y+3*p2.y+p3.y)/8});
  }
  return out;
}
function edgeHtml(e,geo){
  const a=node(e.from),b=node(e.to),g=geo.get(e.id);if(!a||!b||!g)return '';
  const group=e.type==='group',sel=selected===e.id;
  // Unspecified shares only show "?" when selected; the tooltip explains it otherwise.
  const label=group?'':e.percent===''?(sel?'?':''):`${e.percent}%`,w=label.length*6+10;
  const tip=`${a.name} → ${b.name}
${group?'Grouping only · no ownership implied':e.percent===''?'Ownership · percentage unspecified':`${e.percent}% ownership`}`;
  return `<g class="edge${group?' group':''}${sel?' selected':''}" data-edge="${esc(e.id)}" data-tip="${esc(tip)}" data-tip-delay="500" tabindex="0" role="button" aria-label="${esc(a.name+' to '+b.name)}"><path class="hit" d="${g.d}"/><path class="ln" d="${g.d}"${group?'':` marker-end="url(#${sel?'arrowSel':'arrow'})"`}/>${label?`<g class="lbl${e.percent===''?' unk':''}"><rect x="${g.mx-w/2}" y="${g.my-8}" width="${w}" height="16" rx="2"/><text x="${g.mx}" y="${g.my+3.5}" text-anchor="middle">${esc(label)}</text></g>`:''}</g>`;
}
function nodeHtml(n){
  const [w,h]=size(n),k=KINDS[n.type],notes=(n.notes||'').trim();
  const l=linkOf(n);
  const cls=`node ${n.type}${selected===n.id?' selected':''}${source===n.id?' source':''}${drag?.mode==='link'&&drag.over===n.id?' drop':''}${l?' linked':''}${l?.stub?' stub':''}`;
  const tip=(notes?`${n.name}\n${notes.length>280?notes.slice(0,280)+'…':notes}`:'')+(l?(notes?'\n\n':`${n.name}\n`)+sharedTip(l):'');
  return `<div class="${cls}" data-node="${esc(n.id)}" tabindex="0" role="button" aria-label="${esc(k.label+': '+n.name)}"${tip?` data-tip="${esc(tip)}" data-tip-delay="700"`:''} style="left:${n.x}px;top:${n.y}px;width:${w}px;height:${h}px;--lines:${Math.max(1,Math.floor((h-10)/16))}">${n.type==='person'&&personPhoto(n)?personAvatar(n,{size:22,cls:'k-av'}):`<span class="k">${icon(k.icon,14)}</span>`}<span class="nm">${esc(n.name)}</span>${notes?`<span class="has-notes">${icon('text',12)}</span>`:''}${l?`<span class="sh-badge" aria-label="${l.stub?'Co-owner stub, read-only':'Shared with you'}">${icon(l.stub?'ban':'link',11)}</span>`:''}<span class="port" data-port></span><span class="grip" data-grip></span></div>`;
}
function renderCanvas(){
  const c=chart(),cv=$('#canvas');
  $('#world').style.transform=`translate(${view.x}px,${view.y}px) scale(${view.z})`;
  const g=GRID*view.z*(view.z<.45?4:view.z<.8?2:1);cv.style.backgroundSize=`${g}px ${g}px`;cv.style.backgroundPosition=`${view.x}px ${view.y}px`;
  cv.classList.toggle('connecting',connecting);
  $('#scale').textContent=Math.round(view.z*100)+'%';
  $('#areas').innerHTML=c.nodes.filter(n=>n.type==='area').map(nodeHtml).join('');
  $('#nodes').innerHTML=c.nodes.filter(n=>n.type!=='area').map(nodeHtml).join('');
  const ghost=drag?.mode==='link'?(()=>{const a=rect(node(drag.id));return `<path class="ghost" d="M${a.x+a.w} ${a.y+a.h/2}L${drag.px??a.x+a.w} ${drag.py??a.y+a.h/2}"/>`})():'';
  const geo=layoutEdges(c);$('#edges').innerHTML=DEFS+c.edges.map(e=>edgeHtml(e,geo)).join('')+ghost;
  const hint=$('#modeHint');hint.hidden=!connecting;
  if(connecting)hint.innerHTML=`${icon('connect',13)}${source?'Pick the destination card':'Pick the source card'}<kbd>Esc</kbd>`;
}
function renderTools(){
  const r='data-tip-pos="right"';
  $('#tools').innerHTML=Object.entries(KINDS).map(([t,k])=>ib(k.icon,`Add ${k.label.toLowerCase()}`,{key:keyLabel(k.sc),attrs:`data-add="${t}" ${r}`})).join('')
    +'<i class="sep"></i>'+ib('connect',connecting?'Cancel connecting':'Connect two cards',{key:keyLabel('chart.connect'),cls:connecting?'on':'',attrs:`data-act="connect" ${r}`})
    +'<i class="sep"></i>'+ib('undo','Undo',{key:keyLabel('global.undo'),attrs:`data-act="undo" ${r}${store.undo.length?'':' disabled'}`})+ib('redo','Redo',{key:keyLabel('global.redo'),attrs:`data-act="redo" ${r}${store.redo.length?'':' disabled'}`})
    +(tools.length?'<i class="sep"></i>'+tools.map((t,i)=>t.icon?ib(t.icon,t.label,{attrs:`data-tool="${i}" ${r}`}):`<button type="button" class="ib txt-tool" data-tool="${i}" data-tip="${esc(t.label)}" ${r}>${esc(t.label.slice(0,2))}</button>`).join(''):'');
}
const renderZoom=()=>{$('#zoom').innerHTML=ib('minus','Zoom out',{key:keyLabel('chart.zoomOut'),attrs:'data-z="out" data-tip-pos="top"'})+`<button type="button" id="scale" data-z="reset" data-tip="Reset to 100%" data-tip-pos="top">100%</button>`+ib('plus','Zoom in',{key:keyLabel('chart.zoomIn'),attrs:'data-z="in" data-tip-pos="top"'})+ib('fit','Fit mind map',{key:keyLabel('chart.fit'),attrs:'data-z="fit" data-tip-pos="top"'})
  +'<i class="sep"></i>'+ib('info','Solid arrow: ownership, labelled with %\n? = percentage not specified\nDashed line: grouping only, no ownership\nA brainstorm, not a verified legal structure',{label:'Legend',attrs:'data-tip-pos="top"'});};renderZoom();
$('#zoom').addEventListener('click',e=>{const z=e.target.closest('[data-z]')?.dataset.z;if(z==='out')zoom(1/1.2);if(z==='in')zoom(1.2);if(z==='fit')fit();if(z==='reset')zoom(1/view.z)});

function addNode(type='entity',at){
  const cv=$('#canvas'),[w,h]=KINDS[type].size;
  let x=snap(at?at.x:(cv.clientWidth/2-view.x)/view.z-w/2),y=snap(at?at.y:(cv.clientHeight/2-view.y)/view.z-h/2);
  while(chart().nodes.some(n=>n.x===x&&n.y===y)){x+=GRID*2;y+=GRID*2}
  change(()=>{const n={id:uid(),name:`New ${type==='area'?'area':type}`,type,x,y,notes:''};chart().nodes.push(n);selected=n.id});
  const i=$('#name');i?.focus();i?.select();
}
function duplicate(){
  const n=node(selected);if(!n||linkOf(n))return;
  change(()=>{const c={...clone(n),id:uid(),x:n.x+GRID*2,y:n.y+GRID*2};chart().nodes.push(c);selected=c.id});
}
function deleteSelection(){
  if(!node(selected)&&!edge(selected))return;
  // Shared cards and their connections belong to their owner (they would come back on the next sync).
  if(linkOf(node(selected)||edge(selected))){toast('Shared cards belong to their owner. Remove the share in Settings › Sharing.',true);return}
  // A card deleted mid-connect (from its menu) can't stay the pending source.
  change(()=>{const id=selected;chart().nodes=chart().nodes.filter(n=>n.id!==id);chart().edges=chart().edges.filter(e=>e.id!==id&&e.from!==id&&e.to!==id);selected=null;if(source===id)source=null});
}
function toggleConnect(){connecting=!connecting;source=null;renderCanvas();renderTools()}
function connectTo(from,to){
  const dup=chart().edges.find(e=>e.from===from&&e.to===to);
  if(dup){selected=dup.id;connecting=false;source=null;render();return}
  change(()=>{const e={id:uid(),from,to,type:'ownership',percent:''};chart().edges.push(e);selected=e.id;connecting=false;source=null});
  $('#percent')?.focus();
}
$('#tools').addEventListener('click',e=>{
  const b=e.target.closest('button');if(!b)return;
  if(b.dataset.add)addNode(b.dataset.add);
  else if(b.dataset.tool){const t=tools[b.dataset.tool];t.run({addNode,getChart:()=>clone(chart()),mutate:change})}
  else ({connect:toggleConnect,undo:()=>step(-1),redo:()=>step(1)})[b.dataset.act]?.();
});

function fit(){
  const ns=chart().nodes,cv=$('#canvas');if(!cv.clientWidth)return;fitted=true;
  if(!ns.length){view={x:80,y:80,z:1};renderCanvas();return}
  const rs=ns.map(rect),x0=Math.min(...rs.map(r=>r.x)),y0=Math.min(...rs.map(r=>r.y)),w=Math.max(...rs.map(r=>r.x+r.w))-x0,h=Math.max(...rs.map(r=>r.y+r.h))-y0,pad=64;
  view.z=Math.max(.2,Math.min(1,(cv.clientWidth-pad*2)/w,(cv.clientHeight-pad*2)/h));
  view.x=(cv.clientWidth-w*view.z)/2-x0*view.z;view.y=(cv.clientHeight-h*view.z)/2-y0*view.z;
  renderCanvas();
}
function zoom(f,x=$('#canvas').clientWidth/2,y=$('#canvas').clientHeight/2){
  const z=Math.max(.2,Math.min(2.5,view.z*f));
  view.x=x-(x-view.x)*z/view.z;view.y=y-(y-view.y)*z/view.z;view.z=z;renderCanvas();
}
const canvas=$('#canvas');
const toWorld=e=>{const r=canvas.getBoundingClientRect();return {x:(e.clientX-r.left-view.x)/view.z,y:(e.clientY-r.top-view.y)/view.z}};
canvas.addEventListener('wheel',e=>{e.preventDefault();const r=canvas.getBoundingClientRect();zoom(Math.exp(-e.deltaY*.0015),e.clientX-r.left,e.clientY-r.top)},{passive:false});
canvas.onpointerdown=e=>{
  if(e.button!==0&&e.button!==1)return;
  const el=e.target.closest('[data-node]'),edgeEl=e.target.closest('[data-edge]'),start={sx:e.clientX,sy:e.clientY};
  if(el&&e.button===0){
    const id=el.dataset.node,n=node(id);
    if(connecting){if(!source){source=id;renderCanvas()}else if(source!==id)connectTo(source,id);return}
    if(e.target.closest('[data-grip]')){const [w,h]=size(n);drag={mode:'resize',id,...start,w,h,before:clone(store.db)}}
    else if(e.target.closest('[data-port]')){drag={mode:'link',id,...start}}
    else{
      // An area carries along every card that sits fully inside it.
      const r=rect(n),inside=n.type==='area'?chart().nodes.filter(m=>m.id!==id&&(q=>q.x>=r.x&&q.y>=r.y&&q.x+q.w<=r.x+r.w&&q.y+q.h<=r.y+r.h)(rect(m))).map(m=>({id:m.id,x:m.x,y:m.y})):[];
      drag={mode:'move',id,...start,x:n.x,y:n.y,inside,before:clone(store.db)};
    }
    if(selected!==id){selected=id;renderCanvas();renderInspector()}
  }else if(edgeEl&&e.button===0){selected=edgeEl.dataset.edge;render();return}
  else{
    if(selected&&e.button===0){selected=null;renderCanvas();renderInspector()}
    drag={mode:'pan',...start,x:view.x,y:view.y};canvas.classList.add('panning');
  }
  canvas.setPointerCapture(e.pointerId);
};
canvas.onpointermove=e=>{
  if(!drag)return;
  const dx=e.clientX-drag.sx,dy=e.clientY-drag.sy,free=e.altKey;
  if(drag.mode==='pan'){view.x=drag.x+dx;view.y=drag.y+dy}
  else if(drag.mode==='move'){
    if(!drag.moved&&Math.abs(dx)+Math.abs(dy)<=3)return;
    drag.moved=true;const n=node(drag.id);
    n.x=snap(drag.x+dx/view.z,!free);n.y=snap(drag.y+dy/view.z,!free);
    for(const m of drag.inside){const c=node(m.id);if(c){c.x=m.x+n.x-drag.x;c.y=m.y+n.y-drag.y}}
  }
  else if(drag.mode==='resize'){drag.moved=true;const n=node(drag.id);n.w=Math.max(64,snap(drag.w+dx/view.z,!free));n.h=Math.max(32,snap(drag.h+dy/view.z,!free))}
  else if(drag.mode==='link'){const p=toWorld(e);drag.px=p.x;drag.py=p.y;const over=document.elementFromPoint(e.clientX,e.clientY)?.closest('[data-node]')?.dataset.node;drag.over=over!==drag.id?over:null}
  renderCanvas();
};
function endDrag(e){
  if(!drag)return;
  const d=drag;drag=null;canvas.classList.remove('panning');
  if(d.mode==='link'){if(d.over)connectTo(d.id,d.over);else renderCanvas();return}
  if(d.moved){commit(d.before);render()}
}
canvas.onpointerup=endDrag;canvas.onpointercancel=endDrag;
canvas.addEventListener('dblclick',e=>{
  const el=document.elementFromPoint(e.clientX,e.clientY)?.closest('[data-node]');
  if(el){selected=el.dataset.node;render();const i=$('#name');i?.focus();i?.select();return}
  if(!e.target.closest('[data-edge]')){const p=toWorld(e),[w,h]=KINDS.entity.size;addNode('entity',{x:p.x-w/2,y:p.y-h/2})}
});

// ---------- right-click menus ----------
// Right-clicking a card or connection selects it first, so the menu acts on what the inspector shows.
// They follow the inspector's rules for shared cards: whatever it hides for them, the menu leaves out.
const cardEl=id=>canvas.querySelector(`[data-node="${CSS.escape(id)}"],[data-edge="${CSS.escape(id)}"]`);
function nodeMenu(n){
  const l=linkOf(n),id=n.id,org=n.type==='entity'||n.type==='area';
  const kind=t=>()=>{const m=node(id);if(m&&m.type!==t)change(()=>m.type=t)};
  return [
    canEdit(n)&&{label:'Rename',icon:'pencil',run(){selected=id;render();const i=$('#name');i?.focus();i?.select()}},
    !l&&{label:'Kind',icon:KINDS[n.type].icon,items:Object.entries(KINDS).map(([t,k])=>({label:k.label,icon:k.icon,checked:t===n.type,run:kind(t)}))},
    {label:'Connect from here',icon:'connect',run(){connecting=true;source=id;renderCanvas();renderTools()}},
    !l&&{label:'Duplicate',icon:'copy',key:keyLabel('chart.duplicate'),run(){selected=id;duplicate()}},
    !l&&{label:'Share…',icon:'link',run:()=>openShareDialog({nodeId:id,from:cardEl(id)})},
    !l&&n.type!=='note'&&{label:'Open DevOps cards',icon:'branch',run:()=>toDevops(()=>dv.focus(n.type==='person'?{person:id}:{entity:id}))},
    !l&&org&&{label:stripOff?'Show project timeline':'Hide project timeline',icon:'gantt',run:()=>setStripOff(!stripOff)},
    (n.w||n.h)&&{label:'Reset size',icon:'shrink',run:()=>change(()=>{const m=node(id);if(m){delete m.w;delete m.h}})},
    '-',
    !l&&{label:'Delete card',icon:'trash',danger:true,key:keyLabel('chart.delete'),run(){selected=id;deleteSelection()}},
  ].filter(Boolean);
}
function edgeMenu(ed){
  if(linkOf(ed))return []; // a shared connection is read-only: no menu, just the inspector
  const id=ed.id,type=t=>()=>{const x=edge(id);if(x&&x.type!==t)change(()=>{x.type=t;if(t==='group')x.percent=''})};
  return [{label:'Ownership',icon:'arrowR',checked:ed.type==='ownership',run:type('ownership')},{label:'Grouping',icon:'dashed',checked:ed.type==='group',run:type('group')},
    {label:'Reverse direction',icon:'swap',run:()=>change(()=>{const x=edge(id);if(x)[x.from,x.to]=[x.to,x.from]})},'-',
    {label:'Delete connection',icon:'trash',danger:true,key:keyLabel('chart.delete'),run(){selected=id;deleteSelection()}}];
}
function canvasMenu(p){
  // Cards land centred on the pointer, like a double-click; a keyboard-opened menu adds at the centre.
  return [...Object.entries(KINDS).map(([t,k])=>({label:`Add ${k.label.toLowerCase()} here`,icon:k.icon,key:keyLabel(k.sc),run:()=>addNode(t,p&&{x:p.x-k.size[0]/2,y:p.y-k.size[1]/2})})),'-',
    {label:'Connect two cards',icon:'connect',checked:connecting,key:keyLabel('chart.connect'),run:toggleConnect},
    {label:'Fit to window',icon:'fit',key:keyLabel('chart.fit'),run:fit},{label:'Zoom to 100%',run:()=>zoom(1/view.z)},'-',
    {label:'Undo',icon:'undo',key:keyLabel('global.undo'),disabled:!store.undo.length,run:()=>step(-1)},
    {label:'Redo',icon:'redo',key:keyLabel('global.redo'),disabled:!store.redo.length,run:()=>step(1)}];
}
canvas.addEventListener('contextmenu',e=>{
  e.preventDefault();if(drag)return;
  const kb=e.clientX===0&&e.clientY===0,hit=e.target.closest('[data-node],[data-edge]'),id=hit&&(hit.dataset.node||hit.dataset.edge);
  if(id&&selected!==id){selected=id;render()}
  // render() rebuilt the card, so focus (where the menu returns focus) and a keyboard anchor use the new element.
  const el=id&&cardEl(id);if(el){el.focus({preventScroll:true});hideTip()}
  const at=kb&&el?el:e,n=node(id),ed=edge(id);
  if(n)openMenu(at,nodeMenu(n),{label:n.name});
  else if(ed)openMenu(at,edgeMenu(ed),{label:'Connection'});
  else openMenu(e,canvasMenu(kb?null:toWorld(e)),{label:'Mind map'});
});

// ---------- inspector ----------
const segBtn=(attr,val,ic,label,on)=>`<button type="button" class="ib${on?' on':''}" data-${attr}="${val}" data-tip="${label}" aria-label="${label}" aria-pressed="${on}">${icon(ic)}</button>`;
// A person's photo and email. A shared card shows its photo read-only (its email never crosses a share).
// With no photo of its own, a card that is the signed-in user's (their email or, with no email, the only
// person with their name) shows their account photo. "This is me" links a card with no email to the
// account by setting the email only, so the live account photo keeps showing.
function photoHtml(n,shared){
  const src=personPhoto(n),mine=!n.image&&!!src,me=sessionUser();
  if(shared)return src?`<label>Photo</label><div class="pp-row">${personAvatar(n,{size:48,cls:'pp-av'})}</div>`:'';
  return `<label>Photo</label><div class="pp-row">${personAvatar(n,{size:48,cls:'pp-av'})}<div class="pp-acts">
      <button type="button" class="txt" data-i="photoUpload" data-tip="PNG, JPEG or WebP · cropped to a 128 px square">${icon('upload',13)}Upload photo</button><input type="file" id="photoFile" accept="image/png,image/jpeg,image/webp" hidden>
      ${n.image?`<button type="button" class="txt" data-i="photoRemove">${icon('trash',13)}Remove</button>`:''}
      ${me?.image&&n.image!==me.image?`<button type="button" class="txt" data-i="photoMine" data-tip="Use your account photo and email (${esc(me.email)})">${icon('user',13)}Use my photo</button>`:''}
      ${me?.email&&!n.email?`<button type="button" class="txt" data-i="thisIsMe" data-tip="Link this card to your account (${esc(me.email)}) so it shows your account photo">${icon('check',13)}This is me</button>`:''}</div></div>
    ${mine?`<p class="pp-note">Showing your account photo: ${n.email?'this email is yours':'this card has your name'}.</p>`:''}
    <label for="pemail">Email</label><input id="pemail" type="email" maxlength="200" placeholder="Matches them to an account" value="${esc(n.email||'')}">`;
}
// Any picked image becomes a 128x128 centre-cropped WebP (JPEG where WebP encoding is missing) data URL.
async function squarePhoto(blob){
  const bmp=await createImageBitmap(blob);
  try{
    const S=128,c=document.createElement('canvas'),s=Math.min(bmp.width,bmp.height);c.width=c.height=S;
    c.getContext('2d').drawImage(bmp,(bmp.width-s)/2,(bmp.height-s)/2,s,s,0,0,S,S);
    let url=c.toDataURL('image/webp',.85);if(!url.startsWith('data:image/webp'))url=c.toDataURL('image/jpeg',.85);
    if(!validPersonImage(url))throw Error('That photo is too large');
    return url;
  }finally{bmp.close()}
}
function setPhoto(id,fields){change(()=>{const n=node(id);if(!n)return;for(const [k,v] of Object.entries(fields))if(v)n[k]=v;else delete n[k]})}
async function uploadPhoto(file){
  const id=selected;if(!file)return;
  if(!['image/png','image/jpeg','image/webp'].includes(file.type)||file.size>15e6){toast('Choose a PNG, JPEG or WebP image under 15 MB',true);return}
  try{setPhoto(id,{image:await squarePhoto(file)})}catch(err){toast('Could not use that photo · '+err.message,true)}
}
// The account photo as it is when it fits (an https URL or a small data URL), otherwise a 128 px copy.
async function useMyPhoto(){
  const id=selected,me=sessionUser();if(!me?.image)return;
  try{
    const image=validPersonImage(me.image)?me.image:me.image.startsWith('data:image/')?await squarePhoto(await (await fetch(me.image)).blob()):'';
    if(!image)throw Error('it is not an https or image link');
    setPhoto(id,{image,email:cleanPersonEmail(me.email)||node(id)?.email});
  }catch(err){toast('Could not use your photo · '+err.message,true)}
}
const options=id=>chart().nodes.map(n=>`<option value="${esc(n.id)}"${id===n.id?' selected':''}>${esc(n.name)}</option>`).join('');
let inspectorFor=null;
// strip=false: a focus change in split view, which leaves the chart's strip (possibly under the pointer) alone.
function renderInspector(strip=true){
  const pane=$('#inspector');inspectorFor=tab;
  if(tab==='timeline'){tl.renderInspector(pane);return}
  if(tab==='devops'){dv.renderInspector(pane);return}
  if(tab==='agentflow'){af.renderInspector(pane);return}
  const n=node(selected),e=edge(selected);
  // The panel slides in and out; its old content stays visible while it leaves.
  panel(pane,!!(n||e),{onHidden:()=>{if(!node(selected)&&!edge(selected))pane.innerHTML=''}});
  if(n){
    const k=KINDS[n.type],links=chart().edges.filter(x=>x.from===n.id||x.to===n.id),l=linkOf(n),ro=!canEdit(n)?' disabled':'';
    pane.innerHTML=`<div class="ihead"><span class="k ${n.type}">${icon(k.icon)}</span><strong>${k.label}</strong>${l?`<span class="sh-chip${l.stub?' stub':''}" data-tip="${esc(sharedTip(l))}">${icon(l.stub?'ban':'link',11)}${l.stub?'Co-owner':'Shared'}</span>`:''}<span class="sp"></span>
      ${!l&&(n.type==='entity'||n.type==='area')?ib('gantt',stripOff?'Show project timeline':'Hide project timeline',{cls:stripOff?'':'on',attrs:'data-i="strip"'}):''}${l?'':ib('link','Share…',{attrs:'data-i="share"'})}${ib('connect','Connect from here',{attrs:'data-i="from"'})}${l?'':ib('copy','Duplicate',{key:keyLabel('chart.duplicate'),attrs:'data-i="dup"'})}${n.w||n.h?ib('shrink','Reset size',{attrs:'data-i="resetSize"'}):''}
      ${l?'':ib('trash','Delete card',{key:keyLabel('chart.delete'),cls:'danger',attrs:'data-i="delete"'})}${ib('x','Close',{key:keyLabel('global.escape'),attrs:'data-i="close"'})}</div>
      <form id="edit" class="ibody" autocomplete="off">${l?`<p class="sh-note">${esc(sharedTip(l))}</p>`:''}<label for="name">Name</label><input id="name" maxlength="160" required value="${esc(n.name)}"${ro}>
      ${l?'':`<label>Kind</label><div class="seg">${Object.entries(KINDS).map(([t,x])=>segBtn('kind',t,x.icon,x.label,t===n.type)).join('')}</div>`}
      ${l?.stub?'':`<label for="notes">Notes</label><textarea id="notes" maxlength="2000" rows="4"${ro}>${esc(n.notes||'')}</textarea>`}
      ${n.type==='person'?photoHtml(n,!!l):''}
      ${l?historyHtml(n,'node'):''}
      ${n.type==='note'||l?'':(c=>`<label>DevOps</label><button type="button" class="txt dv-open" data-i="devops" data-tip="${n.type==='person'?'Open cards assigned to this person':'Open cards in the projects under this card'}">${icon('branch',13)}<span>${c} open card${c===1?'':'s'}</span>${icon('arrowR',13)}</button>`)(openCardsFor(store.db,n.type==='person'?{person:n.id}:{entity:n.id}).length)}
      ${links.length?`<label>Connections</label><ul class="links">${links.map(x=>{const out=x.from===n.id,o=node(out?x.to:x.from),what=x.type==='group'?'grouping':x.percent===''?'ownership, % unspecified':x.percent+'% ownership';
        return `<li><button type="button" data-goto="${esc(x.id)}" data-tip="${out?'Outgoing':'Incoming'} · ${what}">${icon(out?'arrowR':'arrowL',12)}<span>${esc(o?.name)}</span><em>${x.type==='group'?'┄':x.percent===''?'?':esc(x.percent)+'%'}</em></button></li>`}).join('')}</ul>`:''}</form>`;
  }else if(e){
    const own=e.type==='ownership',l=linkOf(e),ro=!canEdit(e)?' disabled':'';
    pane.innerHTML=`<div class="ihead"><span class="k">${icon(own?'connect':'dashed')}</span><strong>${own?'Ownership':'Grouping'}</strong>${l?`<span class="sh-chip${l.stub?' stub':''}">${icon('link',11)}Shared</span>`:''}<span class="sp"></span>
      ${l?'':ib('swap','Reverse direction',{attrs:'data-i="reverse"'})+ib('trash','Delete connection',{key:keyLabel('chart.delete'),cls:'danger',attrs:'data-i="delete"'})}${ib('x','Close',{key:keyLabel('global.escape'),attrs:'data-i="close"'})}</div>
      <form id="edit" class="ibody" autocomplete="off">${l?`<p class="sh-note">${esc(sharedTip(l))}</p>`:''}<label for="fromNode">From</label><select id="fromNode"${l?' disabled':''}>${options(e.from)}</select><label for="toNode">To</label><select id="toNode"${l?' disabled':''}>${options(e.to)}</select>
      ${l?'':`<label>Type</label><div class="seg wide"><button type="button" class="${own?'on':''}" data-etype="ownership" data-tip="Solid arrow with an ownership percentage">${icon('arrowR',14)}Ownership</button><button type="button" class="${own?'':'on'}" data-etype="group" data-tip="Dashed line that implies no ownership">${icon('dashed',14)}Grouping</button></div>`}
      ${own?`<label for="percent">Share</label><div class="pct"><input id="percent" type="number" min="0" max="100" step="any" placeholder="unspecified" value="${esc(e.percent)}"${ro}><span>%</span></div>`:''}${l?historyHtml(e,'edge'):''}</form>`;
  }
  if(linkOf(n||e))loadHistory(pane);
  if(strip)renderStrip();
}
// Selecting an entity or area shows its slice of the Timeline along the bottom of the canvas.
function renderStrip(){
  const el=$('#strip'),cv=$('#chartView'),n=node(selected),show=isOpen('chart')&&!!n&&(n.type==='entity'||n.type==='area')&&!stripOff;
  el.hidden=!show;cv.classList.toggle('has-strip',show);
  if(!show){stripAdding=false;return}
  if(stripAdding!==false&&stripAdding!==n.id)stripAdding=false;
  el.innerHTML=tl.stripHtml(n,el.clientWidth,!!stripAdding);
  cv.style.setProperty('--sh',el.offsetHeight+'px');
}
let stripAdding=false;
function setStripOff(v){stripOff=v;localStorage.setItem('org-chart-studio-strip',v?'off':'on');renderInspector()}
// Cross-links. In split view the target opens in the other pane (the source stays in view) and takes
// focus; a DevOps card or timeline item the link came from closes, since its modal covers both panes.
function reveal(t){
  const n=revealTab(layoutNow(),t);
  if(tab!==t&&(tab==='devops'||tab==='timeline'))leaveTab(tab);
  if(n.replaced)setLayout(n.tabs,t,'push');else focusPane(n.focus);
}
function toTimeline(fn){if(isSplit())reveal('timeline');else{history.pushState(null,'','#timeline');setTab('timeline')}fn();render()}
function toDevops(fn){if(isSplit())reveal('devops');else if(tab!=='devops'){history.pushState(null,'','#devops');setTab('devops')}fn();render()}
function toAgentflow(fn){if(isSplit())reveal('agentflow');else if(tab!=='agentflow'){history.pushState(null,'','#agentflow');setTab('agentflow')}fn();render()}
$('#strip').addEventListener('click',e=>{
  const n=node(selected),it=e.target.closest('[data-item]'),proj=e.target.closest('[data-strip-proj]')?.dataset.stripProj,a=e.target.closest('[data-strip]')?.dataset.strip;if(!n)return;
  const ids=tl.projectsFor(n).map(p=>p.id);
  if(it)toTimeline(()=>tl.focus({itemId:it.dataset.item}));
  else if(proj)toTimeline(()=>tl.focus({projects:[proj]}));
  else if(a==='close')setStripOff(true);
  else if(a==='open')toTimeline(()=>tl.focus({projects:ids}));
  else if(a==='board')toTimeline(()=>tl.focus({projects:ids,view:'board'}));
  else if(a==='newProject'){stripAdding=n.id;renderStrip();$('#stripNew')?.focus()}
  else if(a==='add'){
    // No project yet: create one named after the card, placed under it.
    if(!ids.length)tl.addProject(n.name,n.id);
    const id=tl.projectsFor(n)[0].id;toTimeline(()=>tl.focus({projects:[id]}));tl.add({projects:[id]});
  }
});
$('#strip').addEventListener('keydown',e=>{
  if(e.target.id!=='stripNew')return;
  if(e.key==='Enter'){e.preventDefault();const v=e.target.value.trim(),n=node(selected);stripAdding=false;if(v&&n)tl.addProject(v,n.id);else renderStrip()}
  if(e.key==='Escape'){e.stopPropagation();stripAdding=false;renderStrip()}
});
$('#strip').addEventListener('focusout',e=>{if(e.target.id==='stripNew'&&stripAdding&&!e.target.value.trim()){stripAdding=false;setTimeout(renderStrip)}});
window.addEventListener('resize',()=>{if(isOpen('chart'))renderStrip()});
const pane=$('#inspector');
pane.addEventListener('submit',e=>e.preventDefault());
pane.addEventListener('click',e=>{
  if(tab==='timeline')return tl.inspectorClick(e);
  if(tab==='devops')return dv.inspectorClick(e);
  if(tab==='agentflow')return af.inspectorClick(e);
  const b=e.target.closest('button');if(!b)return;
  const n=node(selected),ed=edge(selected);
  if(b.dataset.kind&&n){if(!linkOf(n))change(()=>n.type=b.dataset.kind)}
  else if(b.dataset.etype&&ed){if(!linkOf(ed))change(()=>{ed.type=b.dataset.etype;if(ed.type==='group')ed.percent=''})}
  else if(b.dataset.i==='share'&&n)openShareDialog({nodeId:n.id,from:b});
  else if(b.dataset.i==='shComment')postComment(pane,n||ed).catch(err=>toast(err.message,true));
  else if(b.dataset.goto){selected=b.dataset.goto;render()}
  else ({from(){connecting=true;source=n.id;renderCanvas();renderTools()},dup:duplicate,delete:deleteSelection,close(){selected=null;render()},
    resetSize(){change(()=>{delete n.w;delete n.h})},photoUpload:()=>$('#photoFile')?.click(),photoRemove:()=>setPhoto(n.id,{image:''}),photoMine:useMyPhoto,thisIsMe(){const em=cleanPersonEmail(sessionUser()?.email);if(em)setPhoto(n.id,{email:em})},devops:()=>toDevops(()=>dv.focus(n.type==='person'?{person:n.id}:{entity:n.id})),strip:()=>setStripOff(!stripOff),reverse(){if(!linkOf(ed))change(()=>[ed.from,ed.to]=[ed.to,ed.from])}})[b.dataset.i]?.();
});
// Inspector fields autosave as you type: one undo step per open form.
pane.addEventListener('input',e=>{
  if(tab==='timeline')return tl.inspectorInput(e);
  if(tab==='devops')return dv.inspectorInput(e);
  if(tab==='agentflow')return af.inspectorInput(e);
  const form=$('#edit'),n=node(selected),ed=edge(selected);
  if(!form||e.target.type==='file'||!form.checkValidity()||e.target.matches?.('[data-sh-comment]')||!canEdit(n||ed))return;
  if(n&&!$('#name').value.trim())return;
  if(ed&&$('#fromNode').value===$('#toNode').value)return;
  if(!edited.has(form)){checkpoint();edited.add(form)}
  if(n)Object.assign(n,{name:$('#name').value.trim(),...($('#notes')?{notes:$('#notes').value}:{})});
  if(n&&$('#pemail')){
    const em=cleanPersonEmail($('#pemail').value);if(em)n.email=em;else delete n.email;
    const av=pane.querySelector('.pp-av');if(av)av.outerHTML=personAvatar(n,{size:48,cls:'pp-av'});
  }
  if(ed){if(!linkOf(ed))Object.assign(ed,{from:$('#fromNode').value,to:$('#toNode').value});if($('#percent'))ed.percent=$('#percent').value}
  save();renderCanvas();renderTools();renderStrip();
});
pane.addEventListener('change',e=>{if(tab==='chart'&&e.target.id==='photoFile'){uploadPhoto(e.target.files?.[0]);return}if(tab==='timeline')tl.inspectorChange(e);if(tab==='devops')dv.inspectorChange(e);if(tab==='agentflow')af.inspectorChange(e)});
pane.addEventListener('keydown',e=>{if(tab==='timeline')tl.inspectorKey(e);if(tab==='devops')dv.inspectorKey(e);if(tab==='agentflow')af.inspectorKey(e)});

// ---------- keyboard ----------
// Every key comes from the shortcut registry (shortcuts.js), so rebinding in Settings applies here.
const ADD={'chart.addEntity':'entity','chart.addPerson':'person','chart.addArea':'area','chart.addNote':'note'};
document.addEventListener('keydown',e=>{
  const typing=/INPUT|TEXTAREA|SELECT/.test(e.target.tagName);
  if(matches(e,'global.save')){e.preventDefault();saveNow();return}
  if(e.key==='Escape'&&loadPop){closeLoad();return}
  if(!typing&&matches(e,'global.undo')){e.preventDefault();step(-1);return}
  if(!typing&&matches(e,'global.redo')){e.preventDefault();step(1);return}
  if(typing){if(e.key==='Escape')e.target.blur();return}
  if(tab==='timeline')return tl.key(e);
  if(tab==='devops')return dv.key(e);
  if(tab==='agentflow')return af.key(e);
  if(e.key==='Escape'){if(connecting){connecting=false;source=null;renderCanvas();renderTools()}else if(selected){selected=null;render()}return}
  if(matches(e,'chart.delete')){e.preventDefault();deleteSelection();return}
  if(matches(e,'chart.duplicate')){e.preventDefault();duplicate();return}
  const card=e.target.closest?.('[data-node],[data-edge]');
  if((e.key==='Enter'||e.key===' ')&&card){e.preventDefault();selected=card.dataset.node||card.dataset.edge;render();return}
  if(e.key.startsWith('Arrow')&&node(selected)){
    e.preventDefault();const d=e.altKey?1:GRID,id=selected;
    change(()=>{const n=node(id);n.x+=e.key==='ArrowRight'?d:e.key==='ArrowLeft'?-d:0;n.y+=e.key==='ArrowDown'?d:e.key==='ArrowUp'?-d:0});return;
  }
  const add=Object.keys(ADD).find(id=>matches(e,id));
  if(add){e.preventDefault();addNode(ADD[add])}
  else if(matches(e,'chart.connect'))toggleConnect();
  else if(matches(e,'chart.fit'))fit();
  else if(matches(e,'chart.zoomIn'))zoom(1.2);
  else if(matches(e,'chart.zoomOut'))zoom(1/1.2);
});

// Every shown view renders (both panes in split view, from the one store); hidden views do no work.
function render(){
  document.body.dataset.tab=tab;unskeletonize($('main'));
  hideTip();renderTop();
  for(const t of openTabs()){if(t==='chart'){renderCanvas();renderTools();if(tab!=='chart')renderStrip()}else if(t==='timeline')tl.render();else if(t==='devops')dv.render();else af.render()}
  renderInspector();
  // A DevOps card deep link (#devops/card/4) may stand in for the split hash while its card is open.
  if(isSplit()&&!location.hash.startsWith('#devops/card/')){const h=hashFor(tab,split.tabs);if(location.hash!==h)history.replaceState(null,'',h)}
}
store.onChange=render;
setPeopleSource(()=>peopleOf(store.db||{}));
// Signing in (or changing the account photo) changes which cards show the user's photo.
window.addEventListener('flow:session',()=>render());
// Cross-links: timeline items open linked DevOps cards; cards open their timeline item and agents.
tl.mount({rerender:render,openCard:id=>toDevops(()=>dv.focus({cardId:id}))});
dv.mount({rerender:render,openItem:id=>toTimeline(()=>tl.focus({itemId:id})),openAgent:id=>toAgentflow(()=>af.focus({agentId:id})),toast});
// AgentFlow agents and workflows link to cards and timeline items.
af.mount({rerender:render,toast,openCard:id=>toDevops(()=>dv.focus({cardId:id})),openQueue:id=>toDevops(()=>dv.focus({agent:id})),openItem:id=>toTimeline(()=>tl.focus({itemId:id}))});

// Extension point: add palette tools without changing the canvas engine.
// window.orgChartStudio stays as an alias from before the rename to Flygon Flow.
window.flygonFlow=window.orgChartStudio={registerTool({id,label,icon:ic,run}){tools.push({id,label,icon:ic,run});renderTools()},getChart:()=>clone(chart())};

initTooltips();initSelects();layout();render();if(isOpen('chart'))fit();save();startSync();startInbox();if(isOpen('devops'))dv.syncHash();loadDevlog().then(()=>renderTop());
// Rebinding a shortcut re-renders, so tooltips show the new keys.
onPrefs((p,k)=>{if(k==='shortcuts'||k==='*'){renderZoom();render()}});syncPrefs();
document.body.removeAttribute('aria-busy');
