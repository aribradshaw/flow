import {icon,makerIcon} from './icons.js';
import {$,esc,ib,pickerButton,openPicker,pickerOpen,safeImg,personPhoto} from './ui.js';
import {panel,flipList,popIn,popOut} from './motion.js';
import {matches,keyLabel} from './shortcuts.js';
import {ask} from './modal.js';
import {openMenu,menuOpen} from './menu.js';
import {store,change,checkpoint,commit,save} from './store.js';
import {clone} from './ui.js';
import {AGENT_KINDS,AGENT_STATUS,WORKFLOW_STATUS,TRIGGERS,TRIGGER_HINT,newAgent,newWorkflow,newStep,agentOf,reportsOf,descendants,chainOf,
  removeAgent,full,LIMITS,workflowsFor,workFor,openWork,filterAgents,filterWorkflows,agentBrief,workflowBrief,starterAgentflow,peopleOf,
  canReportTo,CARD,STACK,stacked,reportLines,pathOf,positions,placed,pin,unpin,workQueue,duplicateWorkflow,runnerOf,runLine,modelLabel,liveProblem,modelChoices,modelMaker} from './agentflow-core.js';
import {colorOf,initials,memberColor} from './devops-core.js';

// AgentFlow tab: an org chart of agents (AI agents, humans, teams) and the workflows they run,
// tied to Flow projects, DevOps cards and timeline items. Data rules live in agentflow-core.js;
// this module draws the org as a pan-and-zoom canvas (like the MindMap) and the workflow list,
// and edits the selection in the shared #inspector side panel.
const UIKEY='flygon-flow-agentflow-ui';
const KIND_ICON={agent:'bot',human:'user',team:'users'},TRIGGER_ICON={manual:'play',schedule:'clock',event:'zap'};
const STATUS_TONE={draft:'slate',active:'green',paused:'amber',retired:'black'};
let ui={view:'org',q:''};
try{Object.assign(ui,JSON.parse(localStorage.getItem(UIKEY))||{})}catch{}
if(!['org','workflows'].includes(ui.view))ui.view='org';
const keepUi=()=>{try{localStorage.setItem(UIKEY,JSON.stringify(ui))}catch{}};
// selected = {type:'agent'|'workflow', id}
let selected=null,rerender=()=>{},openCard=()=>{},openItem=()=>{},openQueue=()=>{},toast=()=>{};
const edited=new WeakSet();
// Canvas: view = pan and zoom (this session only); drag = the gesture in progress.
const GRID=16,snap=(v,on=true)=>on?Math.round(v/GRID)*GRID:Math.round(v);
let view={x:60,y:60,z:1},fitted=false,drag=null,centerOn=null;

const db=()=>store.db,af=()=>store.db.agentflow;
const agent=id=>agentOf(af(),id),flow=id=>af().workflows.find(w=>w.id===id)||null;
const sel=()=>selected?.type==='agent'?agent(selected.id):selected?.type==='workflow'?flow(selected.id):null;
const touch=x=>x.updated=new Date().toISOString();
const card=id=>db().devops.cards.find(c=>c.id===id),item=id=>db().timeline.find(i=>i.id===id),project=id=>db().projects.find(p=>p.id===id);
const person=id=>peopleOf(db()).find(n=>n.id===id);
const opt=(v,l,cur)=>`<option value="${esc(v)}"${v===cur?' selected':''}>${esc(l)}</option>`;
const statusPill=(s,names)=>{const [bg,fg]=colorOf(STATUS_TONE[s]||'slate');return `<span class="pill" style="background:${bg};color:${fg}">${esc(names[s]||s)}</span>`};
const plural=(n,w)=>`${n} ${w}${n===1?'':'s'}`;

export function mount(opts){
  rerender=opts.rerender;openCard=opts.openCard||openCard;openItem=opts.openItem||openItem;openQueue=opts.openQueue||openQueue;toast=opts.toast||toast;
  const el=$('#agentflowView');
  el.addEventListener('click',e=>{
    const z=e.target.closest('[data-afz]')?.dataset.afz;
    if(z){({out:()=>zoom(1/1.2),in:()=>zoom(1.2),reset:()=>zoom(1/view.z),fit,tidy})[z]?.();return}
    const b=e.target.closest('[data-af]');if(b){action(b.dataset.af,b);return}
    const a=e.target.closest('[data-agent]');if(a){select('agent',a.dataset.agent);return}
    const w=e.target.closest('[data-flow]');if(w){select('workflow',w.dataset.flow);return}
    if(e.target.closest('.af-scroll')&&!e.target.closest('button,a,input')&&selected)select(null);
  });
  el.addEventListener('pointerdown',canvasDown);
  el.addEventListener('pointermove',canvasMove);
  el.addEventListener('pointerup',canvasUp);
  el.addEventListener('contextmenu',contextMenu);
  // Hovering a card highlights its reporting chain (only the highlight path is redrawn).
  el.addEventListener('pointerover',e=>{const id=!drag&&e.target.closest?.('#afCanvas [data-agent]')?.dataset.agent||null;if(id!==hoverId){hoverId=id;paintChain()}});
  el.addEventListener('pointerleave',()=>{if(hoverId){hoverId=null;paintChain()}});
  // A cancelled gesture (touch interrupted, capture lost) changes nothing.
  el.addEventListener('pointercancel',e=>{if(!drag||e.pointerId!==drag.pid)return;drag=null;$('#afCanvas')?.classList.remove('panning');paint()});
  el.addEventListener('wheel',e=>{const cv=e.target.closest('#afCanvas');if(!cv)return;e.preventDefault();const r=cv.getBoundingClientRect();zoom(Math.exp(-e.deltaY*.0015),e.clientX-r.left,e.clientY-r.top)},{passive:false});
  el.addEventListener('dblclick',e=>{
    const cv=e.target.closest('#afCanvas');if(!cv||e.target.closest('[data-agent],button'))return;
    const p=toWorld(e);addAgent('',{x:snap(p.x-CARD.w/2),y:snap(p.y-CARD.h/2)});
  });
  el.addEventListener('keydown',e=>{
    const t=e.target.closest('[data-agent],[data-flow]');
    if(t&&(e.key==='Enter'||e.key===' ')){e.preventDefault();t.dataset.agent?select('agent',t.dataset.agent):select('workflow',t.dataset.flow)}
  });
  el.addEventListener('input',e=>{
    if(e.target.id!=='af-q')return;
    ui.q=e.target.value;keepUi();const pos=e.target.selectionStart;render();const q=$('#af-q');q.focus();q.setSelectionRange(pos,pos);
  });
}
export function leave(){selected=null}
function select(type,id){selected=type?{type,id}:null;rerender()}

// Opened from elsewhere (a DevOps card's agent list).
export function focus({agentId,workflowId}={}){
  if(agentId&&agent(agentId)){ui.view='org';selected={type:'agent',id:agentId};centerOn=agentId}
  else if(workflowId&&flow(workflowId)){ui.view='workflows';selected={type:'workflow',id:workflowId}}
  ui.q='';keepUi();
}

// ---------- header, toolbar and views ----------
export function headerHtml(){
  const a=af().agents.length,w=af().workflows.length;
  return `<span class="meta" data-tip="${plural(a,'agent')} · ${plural(w,'workflow')}">${a} · ${w}</span>`;
}
function toolbar(){
  const view=(v,ic,label,sc)=>`<button type="button" class="${ui.view===v?'on':''}" data-af="view" data-v="${v}" data-tip="${label}" data-key="${esc(keyLabel(sc))}" aria-pressed="${ui.view===v}">${icon(ic,14)}${label}</button>`;
  return `<div class="tl-bar af-bar">
    <div class="seg txt" role="group" aria-label="View">${view('org','network','Org chart','agentflow.view1')}${view('workflows','flow','Workflows','agentflow.view2')}</div>
    <input id="af-q" type="search" placeholder="Search agents and workflows" value="${esc(ui.q)}" aria-label="Search agents and workflows">
    ${ui.q?`<button type="button" class="txt" data-af="clear">Clear</button>`:''}<span class="sp"></span>
    <button type="button" class="txt" data-af="addWorkflow" data-tip="New workflow" data-key="${esc(keyLabel('agentflow.addWorkflow'))}">${icon('plus',13)}Workflow</button>
    ${ib('plus','New agent',{key:keyLabel('agentflow.addAgent'),cls:'primary',attrs:'data-af="addAgent"'})}</div>`;
}
// A person's face: their photo when the person card has one (image: a URL or data URL), else
// initials on their member colour.
// A person's photo: their own, or the signed-in account's when the email matches (ui.js personPhoto).
const photo=n=>n?safeImg(personPhoto(n)):'';
const faceHtml=(n,cls,tip)=>{const src=photo(n),[bg,fg]=memberColor(n.id);
  return src?`<img class="${cls} img" src="${esc(src)}" alt="" draggable="false" data-tip="${esc(tip)}">`:`<span class="${cls}" style="background:${bg};color:${fg}" data-tip="${esc(tip)}">${esc(initials(n.name))}</span>`};
// The models an AI agent runs on, bottom-right of its card: up to three maker marks in order (the
// primary larger, fallbacks tucked behind) and "+N", or one auto mark and a count when on Auto.
function modelMarks(a){
  const ms=a.kind==='agent'?modelChoices(af(),a):[];if(!ms.length)return '';
  if(a.auto===true)return `<span class="af-n-mk auto" data-tip="${esc(`Auto from: ${ms.map(m=>m.label).join(', ')}`)}">${makerIcon({key:'auto'},12)}<b>${ms.length}</b></span>`;
  const tip=ms.map((m,i)=>`${i+1}. ${m.label}${i?'':' (primary)'}`).join('\n');
  return `<span class="af-n-mk" data-tip="${esc(tip)}">${ms.slice(0,3).map((m,i)=>`<i>${makerIcon(modelMaker(m.id,m.label),i?11:13)}</i>`).join('')}${ms.length>3?`<b>+${ms.length-3}</b>`:''}</span>`;
}
// The org card: avatar (its supervisor's face on the corner) and name, role, where it runs (and the
// Live badge), then counts and its models. The left stripe is the status. Every text row is one
// line, cut with an ellipsis; the tooltip has it all.
function nodeHtml(a,p,hits){
  const flows=workflowsFor(af(),a.id).length,open=openWork(db(),a),sup=person(a.supervisor);
  const isSel=selected?.type==='agent'&&selected.id===a.id,dim=hits&&!hits.has(a.id),drop=drag?.mode==='link'&&drag.over===a.id;
  const run=runLine(af(),a),live=a.kind==='agent'&&a.live,why=live&&liveProblem(af(),a),kind=AGENT_KINDS[a.kind],status=AGENT_STATUS[a.status];
  // A human agent is the person it is linked to; anyone else shows its kind.
  const me=a.kind==='human'&&sup,rt=a.runtime.trim(),glyph=(rt||a.model.trim()).charAt(0).toUpperCase(),[gb,gf]=glyph?memberColor(rt.toLowerCase()||a.model):[];
  const avatar=me?faceHtml(sup,'af-av',`${kind}: ${sup.name}`):`<span class="af-av k" data-tip="${kind}">${icon(KIND_ICON[a.kind],15)}</span>`;
  const runTip=`${run||'No runner or model yet'}\n${live?(why?`Live, but its runner will skip it: ${why}`:'Live: its runner works its queue'):'Not live: runners leave it alone'}`;
  return `<div class="af-node k-${a.kind} st-${a.status}${live?' live':''}${isSel?' sel':''}${dim?' dim':''}${drop?' drop':''}" data-agent="${esc(a.id)}" tabindex="0" role="button" aria-label="${esc(`${kind}: ${a.name}${a.title?`, ${a.title}`:''}. ${status}${live?', live':''}`)}" style="left:${p.x}px;top:${p.y}px">
    <i class="af-st" data-tip="Status: ${status}"></i>
    <div class="af-n-head"><span class="af-avw">${avatar}${sup&&!me?faceHtml(sup,'af-sup',`Supervised by ${sup.name}`):''}</span><div class="af-n-id"><span class="nm" data-tip="${esc(a.name)}">${esc(a.name)}</span>
      <span class="af-n-role${a.title?'':' none'}"${a.title?` data-tip="${esc(a.title)}"`:''}>${esc(a.title||kind)}</span></div></div>
    ${a.kind==='agent'?`<div class="af-n-run${run?'':' none'}${why?' warn':''}" data-tip="${esc(runTip)}">${live?`<b>Live</b>`:''}${glyph?`<i class="af-g" style="background:${gb};color:${gf}">${esc(glyph)}</i>`:''}<span>${esc(run||'No runner or model yet')}</span></div>`:''}
    <div class="af-n-foot"><span class="af-n-stats"><span data-tip="${plural(a.inputs.length,'input')} → ${plural(a.outputs.length,'output')}">${icon('arrowR',11)}${a.inputs.length}/${a.outputs.length}</span>
      ${flows?`<span data-tip="In ${plural(flows,'workflow')}">${icon('flow',11)}${flows}</span>`:''}
      ${open?`<span data-tip="${plural(open,'open card')}">${icon('branch',11)}${open}</span>`:''}
      </span>${modelMarks(a)}</div>
    <span class="af-port" data-port data-tip="Drag onto an agent to make it report here, or onto empty space for a new report" data-tip-delay="600"></span></div>`;
}
// The reporting chain above an agent, highlighted while it is hovered or selected: its own line and
// every line up to the top (routes come from reportLines on the last paint).
let routes=new Map(),hoverId=null;
function chainD(id){
  const out=[],n0=af().agents.length;
  for(let a=agent(id),n=0;a?.reportsTo&&n<=n0;a=agent(a.reportsTo),n++)if(routes.has(a.id))out.push(routes.get(a.id));
  return out.join('');
}
function paintChain(){
  const el=$('#afCanvas .af-chain');if(!el)return;
  const id=hoverId||(selected?.type==='agent'?selected.id:null);el.setAttribute('d',id?chainD(id):'');
}
const canvasHtml=()=>`<div id="afCanvas" class="af-canvas" aria-label="AgentFlow org canvas"><div class="af-world" style="--af-w:${CARD.w}px;--af-h:${CARD.h}px"><svg class="af-edges" aria-hidden="true"></svg><div class="af-nodes"></div></div></div>
  <div class="float af-zoom" role="toolbar" aria-label="Zoom"></div><div class="af-empty-wrap" hidden></div>`;
function paintZoom(){
  const z=$('#agentflowView .af-zoom');if(!z)return;
  z.innerHTML=ib('minus','Zoom out',{key:keyLabel('agentflow.zoomOut'),attrs:'data-afz="out" data-tip-pos="top"'})+`<button type="button" class="af-scale" data-afz="reset" data-tip="Reset to 100%" data-tip-pos="top">${Math.round(view.z*100)}%</button>`
    +ib('plus','Zoom in',{key:keyLabel('agentflow.zoomIn'),attrs:'data-afz="in" data-tip-pos="top"'})+ib('fit','Fit the org',{key:keyLabel('agentflow.fit'),attrs:'data-afz="fit" data-tip-pos="top"'})
    +'<i class="sep"></i>'+ib('network','Tidy up\nArrange as a tree again',{attrs:'data-afz="tidy" data-tip-pos="top"'})
    +ib('info','Drag a card to move it (Shift: with its reports, Alt: off the grid)\nDrag the dot under a card onto another agent to make that agent report to it,\nor onto empty space to add a new report\nDouble-click empty space to add an agent\nArrow keys nudge the selected agent',{label:'How the canvas works',attrs:'data-tip-pos="top"'});
}
// Draw the agents and their reporting lines (also on every frame of a drag).
function paint(){
  const cv=$('#afCanvas');if(!cv)return;
  const pos=positions(af()),hits=ui.q.trim()?new Set(filterAgents(af(),{q:ui.q}).map(a=>a.id)):null;
  if(drag?.mode==='move')for(const [id,p] of drag.live)pos.set(id,p);
  cv.querySelector('.af-world').style.transform=`translate(${view.x}px,${view.y}px) scale(${view.z})`;
  const g=GRID*view.z*(view.z<.45?4:view.z<.8?2:1);cv.style.backgroundSize=`${g}px ${g}px`;cv.style.backgroundPosition=`${view.x}px ${view.y}px`;
  cv.querySelector('.af-nodes').innerHTML=af().agents.map(a=>nodeHtml(a,pos.get(a.id),hits)).join('');
  // Close up the whole card; zoomed out (under 60%) just who it is, larger.
  cv.classList.toggle('lod',view.z<.6);
  // Each manager's lines are one bundle (see reportLines), drawn in at most two paths: what matches
  // the search and what does not. A bundle's shared trunk and bus dim only when none of its reports match.
  const lines=reportLines(af(),pos,stacked(af())),on=[],off=[];routes=lines.routes;
  for(const q of lines.pieces)(hits&&!(q.owners||q.bundle).some(x=>hits.has(x))?off:on).push(q.d||pathOf(q.pts,q.radii));
  // Each report's route also gets a wide invisible twin, so its line is easy to right-click.
  const hit=[...routes].map(([id,d])=>`<path class="af-hit" data-line="${esc(id)}" d="${d}"/>`).join('');
  const m=drag?.mode==='link'&&pos.get(drag.id),ghost=m&&drag.px!=null?`<path class="ghost" d="M${m.x+CARD.w/2} ${m.y+CARD.h}L${drag.px} ${drag.py}"/>`:'';
  cv.querySelector('.af-edges').innerHTML=`<path class="af-ln" d="${on.join('')}"/><path class="af-ln dim" d="${off.join('')}"/><path class="af-ln af-chain" d=""/>${hit}${ghost}`;
  paintChain();
  const sc=$('#agentflowView .af-scale');if(sc)sc.textContent=Math.round(view.z*100)+'%';
  const empty=$('#agentflowView .af-empty-wrap');
  if(empty){empty.hidden=!!af().agents.length;if(!af().agents.length&&!empty.firstChild)empty.innerHTML=`<div class="af-empty">${icon('bot',28)}<strong>Build your agent org</strong><p>Add agents with a purpose, inputs and outputs, arrange who reports to whom, and link them to projects, cards and deadlines. Double-click the canvas to drop one anywhere.</p>
    <div class="af-empty-b"><button type="button" class="txt" data-af="starter">Start from a template</button><button type="button" class="txt primary-txt" data-af="addAgent">${icon('plus',13)}Add an agent</button></div></div>`}
}
function fit(){
  const cv=$('#afCanvas');if(!cv?.clientWidth)return;fitted=true;
  const ps=[...positions(af()).values()];
  if(!ps.length){view={x:60,y:60,z:1};paint();return}
  const x0=Math.min(...ps.map(p=>p.x)),y0=Math.min(...ps.map(p=>p.y)),w=Math.max(...ps.map(p=>p.x))+CARD.w-x0,h=Math.max(...ps.map(p=>p.y))+CARD.h-y0,pad=56;
  view.z=Math.max(.2,Math.min(1,(cv.clientWidth-pad*2)/w,(cv.clientHeight-pad*2)/h));
  view.x=(cv.clientWidth-w*view.z)/2-x0*view.z;view.y=(cv.clientHeight-h*view.z)/2-y0*view.z;
  paint();
}
function zoom(f,x,y){
  const cv=$('#afCanvas');if(!cv)return;x??=cv.clientWidth/2;y??=cv.clientHeight/2;
  const z=Math.max(.2,Math.min(2.5,view.z*f));
  view.x=x-(x-view.x)*z/view.z;view.y=y-(y-view.y)*z/view.z;view.z=z;paint();
}
// Bring an agent into view (opened from a DevOps card) without changing the zoom.
function tidy(){if(af().agents.some(placed))change(()=>unpin(af()));requestAnimationFrame(fit)}
function center(id){
  const cv=$('#afCanvas'),p=positions(af()).get(id);if(!cv?.clientWidth||!p)return;
  view.x=cv.clientWidth/2-(p.x+CARD.w/2)*view.z;view.y=cv.clientHeight/2-(p.y+CARD.h/2)*view.z;paint();
}
const toWorld=e=>{const r=$('#afCanvas').getBoundingClientRect();return {x:(e.clientX-r.left-view.x)/view.z,y:(e.clientY-r.top-view.y)/view.z}};

// ---------- canvas gestures ----------
// Card: move (Shift carries its reports along). Dot under a card: link to a new manager's report.
// Empty space: pan. Every finished change is one undo step.
function canvasDown(e){
  const cv=e.target.closest('#afCanvas');if(!cv||(e.button!==0&&e.button!==1)||e.target.closest('button,input,a'))return;
  // Ctrl+click on a Mac is a right-click: leave it to the context menu.
  if(e.button===0&&e.ctrlKey&&/Mac/.test(navigator.platform))return;
  const el=e.target.closest('[data-agent]'),start={sx:e.clientX,sy:e.clientY,pid:e.pointerId};
  if(el&&e.button===0){
    const id=el.dataset.agent,pos=positions(af());
    if(e.target.closest('[data-port]'))drag={mode:'link',id,...start};
    else{
      const ids=[id,...(e.shiftKey?descendants(af(),id):[])];
      drag={mode:'move',id,...start,from:new Map(ids.map(x=>[x,{...pos.get(x)}])),live:new Map(),alt:false};
    }
    if(selected?.type!=='agent'||selected.id!==id){selected={type:'agent',id};rerender()}
  }else{
    if(selected&&e.button===0){selected=null;rerender()}
    drag={mode:'pan',...start,x:view.x,y:view.y};$('#afCanvas').classList.add('panning');
  }
  $('#afCanvas').setPointerCapture(e.pointerId);
}
function canvasMove(e){
  if(!drag||e.pointerId!==drag.pid)return;
  const dx=e.clientX-drag.sx,dy=e.clientY-drag.sy;
  if(drag.mode==='pan'){view.x=drag.x+dx;view.y=drag.y+dy}
  else if(drag.mode==='move'){
    if(!drag.moved&&Math.abs(dx)+Math.abs(dy)<=3)return;
    drag.moved=true;const lead=drag.from.get(drag.id),nx=snap(lead.x+dx/view.z,!e.altKey),ny=snap(lead.y+dy/view.z,!e.altKey);
    for(const [id,p] of drag.from)drag.live.set(id,{x:p.x+nx-lead.x,y:p.y+ny-lead.y});
  }else{
    const p=toWorld(e);drag.px=p.x;drag.py=p.y;drag.moved=drag.moved||Math.abs(dx)+Math.abs(dy)>6;
    const over=document.elementFromPoint(e.clientX,e.clientY)?.closest('#afCanvas [data-agent]')?.dataset.agent;drag.over=over!==drag.id?over:null;drag.self=over===drag.id;
  }
  paint();
}
function canvasUp(e){
  if(!drag||e.pointerId!==drag.pid)return;
  const d=drag;drag=null;$('#afCanvas')?.classList.remove('panning');
  if(d.mode==='move'&&d.moved){
    const before=clone(store.db);pin(af());
    for(const [id,p] of d.live){const a=agent(id);if(a){a.x=p.x;a.y=p.y;touch(a)}}
    commit(before);rerender();return;
  }
  if(d.mode==='link'){
    if(d.over){
      const r=agent(d.over),m=agent(d.id);
      if(r.reportsTo===m.id){paint();return}
      if(!canReportTo(af(),r.id,m.id)){toast(`${r.name} cannot report to ${m.name}: ${m.name} reports to ${r.name}.`,true);paint();return}
      change(()=>{r.reportsTo=m.id;touch(r);selected={type:'agent',id:r.id}});return;
    }
    // Back on its own card: nothing. On empty space: a new report there.
    if(d.moved&&!d.self&&d.px!=null){addAgent(d.id,{x:snap(d.px-CARD.w/2),y:snap(d.py)});return}
  }
  paint();
}
function nudge(e){
  const a=sel();if(!a||selected.type!=='agent')return false;
  const step=e.altKey?1:GRID,dx=e.key==='ArrowRight'?step:e.key==='ArrowLeft'?-step:0,dy=e.key==='ArrowDown'?step:e.key==='ArrowUp'?-step:0;
  change(()=>{pin(af());a.x+=dx;a.y+=dy;touch(a)});return true;
}
function flowHtml(w){
  const isSel=selected?.type==='workflow'&&selected.id===w.id,open=openWork(db(),w);
  return `<div class="af-flow${isSel?' sel':''}" data-flow="${esc(w.id)}" tabindex="0" role="button" aria-label="${esc('Workflow: '+w.name)}">
    <div class="af-f-head"><span class="af-k">${icon('flow',14)}</span><strong>${esc(w.name)}</strong>${statusPill(w.status,WORKFLOW_STATUS)}<span class="sp"></span>
      <span class="af-trig" data-tip="Trigger">${icon(TRIGGER_ICON[w.trigger],12)}${esc(TRIGGERS[w.trigger])}${w.schedule?` · ${esc(w.schedule)}`:''}</span>
      ${open?`<span class="af-trig" data-tip="${plural(open,'open card')}">${icon('branch',12)}${open}</span>`:''}</div>
    ${w.description?`<div class="af-f-desc">${esc(w.description)}</div>`:''}
    <ol class="af-steps">${w.steps.length?w.steps.map((s,i)=>{const a=agent(s.agent);
      return `${i?`<li class="af-arrow" aria-hidden="true">${icon('arrowR',12)}</li>`:''}<li class="af-step-chip"${s.output?` data-tip="Output: ${esc(s.output)}"`:''}><em>${i+1}</em><span class="af-who${a?'':' none'}">${a?icon(KIND_ICON[a.kind],11)+esc(a.name):'Unassigned'}</span><span class="af-act">${esc(s.action||'No action yet')}</span></li>`}).join('')
      :`<li class="af-step-chip none">No steps yet</li>`}</ol></div>`;
}
function flowsHtml(){
  const all=af().workflows,list=ui.q.trim()?filterWorkflows(af(),{q:ui.q}):all;
  if(!all.length)return `<div class="af-empty">${icon('flow',28)}<strong>No workflows yet</strong><p>A workflow is an ordered set of steps, each handled by an agent, started by hand, on a schedule or by an event.</p>
    <div class="af-empty-b"><button type="button" class="txt primary-txt" data-af="addWorkflow">${icon('plus',13)}Add a workflow</button></div></div>`;
  return `<div class="af-flows">${list.map(flowHtml).join('')||'<p class="af-none">No workflows match.</p>'}</div>`;
}
export function render(){
  const el=$('#agentflowView');
  // Clear a selection whose agent or workflow is gone (undo, sync).
  if(selected&&!sel())selected=null;
  if(ui.view==='org'){
    // Keep the canvas element between renders, so a gesture or the zoom is never interrupted.
    if(!el.querySelector('#afCanvas'))el.innerHTML=toolbar()+canvasHtml();
    else el.querySelector('.af-bar').outerHTML=toolbar();
    paintZoom();paint();
    if(!fitted)requestAnimationFrame(()=>{if(!fitted)fit()});
    if(centerOn){const id=centerOn;centerOn=null;requestAnimationFrame(()=>center(id))}
    return;
  }
  const old=el.querySelector('.af-scroll'),keep=old&&[old.scrollLeft,old.scrollTop];
  flipList(el,'.af-flow',x=>x.dataset.flow,()=>{el.innerHTML=toolbar()+`<div class="af-scroll" data-view="workflows">${flowsHtml()}</div>`});
  const sc=el.querySelector('.af-scroll');if(keep)[sc.scrollLeft,sc.scrollTop]=keep;
}
function action(name,b){
  ({
    view(){ui.view=b.dataset.v;keepUi();if(selected&&(selected.type==='agent')!==(ui.view==='org'))selected=null;rerender()},
    clear(){ui.q='';keepUi();render()},
    addAgent:()=>addAgent(),
    addWorkflow:()=>addWorkflow(),
    starter(){if(af().agents.length+4>LIMITS.agents||af().workflows.length+1>LIMITS.workflows){toast('This workspace is at its AgentFlow limit.',true);return}fitted=false;change(()=>{const lead=starterAgentflow(af());selected={type:'agent',id:lead.id}})},
  })[name]?.();
}
// A new agent goes under the selected one (if an agent is selected), or where it was dropped (at).
function addAgent(reportsTo=selected?.type==='agent'?selected.id:'',at=null){
  const no=full(af(),'agents');if(no){toast(no,true);return}
  if(ui.view!=='org'){ui.view='org';keepUi()}
  change(()=>{if(at)pin(af());const a=newAgent(af(),{reportsTo,...(at||{})});selected={type:'agent',id:a.id}});
  focusName();
}
function addWorkflow(first=selected?.type==='agent'?selected.id:''){
  const no=full(af(),'workflows');if(no){toast(no,true);return}
  ui.view='workflows';keepUi();
  change(()=>{const w=newWorkflow(af(),{steps:[newStep({agent:first})]});selected={type:'workflow',id:w.id}});
  focusName();
}
const focusName=()=>requestAnimationFrame(()=>{const i=$('#af-name');i?.focus();i?.select()});
async function removeSelected(){
  const x=sel();if(!x)return;
  if(selected.type==='agent'){
    const reps=reportsOf(af(),x.id).length,flows=workflowsFor(af(),x.id).length;
    const more=[reps&&`Its ${plural(reps,'direct report')} will report to ${agent(x.reportsTo)?.name||'nobody'}.`,flows&&`Its steps in ${plural(flows,'workflow')} become unassigned.`].filter(Boolean);
    if(!await ask([`Delete "${x.name}"?`,...more,'You can undo this.'].join('\n'),{ok:'Delete',danger:true}))return;
    change(()=>{removeAgent(af(),x.id);selected=null});
  }else{
    if(!await ask(`Delete the workflow "${x.name}"?\nYou can undo this.`,{ok:'Delete',danger:true}))return;
    change(()=>{af().workflows=af().workflows.filter(w=>w.id!==x.id);selected=null});
  }
}
async function copyBrief(){
  const x=sel();if(!x)return;
  const text=selected.type==='agent'?agentBrief(db(),x.id):workflowBrief(db(),x.id);
  try{await navigator.clipboard.writeText(text);toast('Brief copied as Markdown')}catch{toast('Could not copy: the browser blocked clipboard access',true)}
}

// ---------- right-click menus ----------
// On an agent, a workflow card, a reporting line or empty canvas. The agent or workflow is selected
// first, so the menu acts on what the side panel shows. Every change is one undo step.
const MENU_CAP=15,byName=(x,y)=>x.name.localeCompare(y.name);
function contextMenu(e){
  const cv=e.target.closest('#afCanvas'),w=e.target.closest('[data-flow]');
  if(!cv&&!w)return; // the toolbar and search field keep the browser's own menu
  e.preventDefault();
  if(drag)return; // a right-click mid-gesture must not interrupt it
  // Opened from the keyboard (menu key, Shift+F10): the menu goes under the card, which the
  // selection redraw replaced, so find and focus the new one.
  const kb=e.clientX===0&&e.clientY===0;
  const pick=(type,id,q)=>{if(selected?.type!==type||selected.id!==id)select(type,id);if(!kb)return e;const n=document.querySelector(q);n?.focus({preventScroll:true});return n||e};
  const n=e.target.closest('[data-agent]'),ln=e.target.closest('[data-line]');
  if(n){const id=n.dataset.agent;if(agent(id))agentMenu(pick('agent',id,`#afCanvas [data-agent="${CSS.escape(id)}"]`),id)}
  else if(w){const id=w.dataset.flow;if(flow(id))flowMenu(pick('workflow',id,`#agentflowView [data-flow="${CSS.escape(id)}"]`),id)}
  else if(ln)lineMenu(e,ln.dataset.line);
  else canvasMenu(e);
}
function setOn(get,k,v){
  const x=get();if(!x||x[k]===v)return;
  if(k==='reportsTo'&&!canReportTo(af(),x.id,v))return;
  change(()=>{x[k]=v;touch(x)});
}
function addStepFor(wid,aid){
  const w=flow(wid);if(!w)return;const no=full(af(),'steps',w);if(no){toast(no,true);return}
  change(()=>{w.steps.push(newStep({agent:aid}));touch(w)});toast(`Added as step ${w.steps.length} of "${w.name}"`);
}
function agentMenu(at,id){
  const a=agent(id),A=af(),get=()=>agent(id),q=workQueue(db(),id).length;
  // Reports to: everyone it may report to (not itself or its reports), the current manager always shown.
  const ok=A.agents.filter(x=>x.id!==id&&canReportTo(A,id,x.id)).sort(byName),cur=ok.find(x=>x.id===a.reportsTo);
  const shown=ok.slice(0,MENU_CAP);if(cur&&!shown.includes(cur))shown[MENU_CAP-1]=cur;
  const flows=A.workflows.slice(0,MENU_CAP).map(w=>({label:w.name,icon:'flow',run:()=>addStepFor(w.id,id)}));
  openMenu(at,[
    {label:'Edit',icon:'pencil',run:focusName},
    {label:'Add direct report',icon:'plus',key:keyLabel('agentflow.addAgent'),run:()=>addAgent(id)},
    '-',
    {label:'Kind',icon:KIND_ICON[a.kind],items:Object.entries(AGENT_KINDS).map(([k,n])=>({label:n,icon:KIND_ICON[k],checked:a.kind===k,run:()=>setOn(get,'kind',k)}))},
    {label:'Status',icon:'dot',items:Object.entries(AGENT_STATUS).map(([k,n])=>({label:n,checked:a.status===k,run:()=>setOn(get,'status',k)}))},
    {label:'Reports to',icon:'network',items:[{label:'Nobody (top level)',checked:!a.reportsTo,run:()=>setOn(get,'reportsTo','')},
      ...shown.map(x=>({label:x.name,icon:KIND_ICON[x.kind],checked:x.id===a.reportsTo,run:()=>setOn(get,'reportsTo',x.id)})),
      ...(ok.length>shown.length?['-',{label:'More in the side panel…',run(){ui.sec={...ui.sec,identity:true};keepUi();select('agent',id);requestAnimationFrame(()=>$('#af-reports')?.click())}}]:[])]},
    {label:'Add to workflow',icon:'flow',items:[...flows,...(flows.length?['-']:[]),{label:'New workflow starting here',icon:'plus',run:()=>addWorkflow(id)}]},
    '-',
    {label:q?`Open work queue (${q})`:'Open work queue',icon:'branch',run:()=>openQueue(id)},
    {label:'Copy brief',icon:'copy',run:copyBrief},
    '-',
    {label:'Delete agent',icon:'trash',danger:true,key:keyLabel('agentflow.delete'),run:removeSelected},
  ],{label:`Agent: ${a.name}`});
}
function canvasMenu(e){
  const cv=$('#afCanvas').getBoundingClientRect(),p=toWorld(e),A=af(),none=!A.agents.length;
  openMenu(e,[
    {label:'Add agent here',icon:'plus',run:()=>addAgent('',{x:snap(p.x-CARD.w/2),y:snap(p.y-CARD.h/2)})},
    // Not the selected agent's workflow: nothing was right-clicked.
    {label:'New workflow',icon:'flow',key:keyLabel('agentflow.addWorkflow'),run:()=>addWorkflow('')},
    ...(none?[{label:'Start from a template',icon:'rocket',run:()=>action('starter')}]:[]),
    '-',
    {label:'Fit the org',icon:'fit',key:keyLabel('agentflow.fit'),disabled:none,run:fit},
    {label:'Zoom to 100%',disabled:view.z===1,run:()=>zoom(1/view.z,e.clientX-cv.left,e.clientY-cv.top)},
    {label:'Tidy up',icon:'network',disabled:!A.agents.some(placed),run:tidy},
  ],{label:'Canvas'});
}
function lineMenu(e,id){
  const r=agent(id),m=r&&agent(r.reportsTo);if(!m)return;
  openMenu(e,[
    {label:`Remove reporting line (make ${r.name} top level)`,icon:'x',run:()=>setOn(()=>agent(id),'reportsTo','')},
    '-',
    {label:`Select ${m.name}`,icon:KIND_ICON[m.kind],run:()=>select('agent',m.id)},
    {label:`Select ${r.name}`,icon:KIND_ICON[r.kind],run:()=>select('agent',id)},
  ],{label:`${r.name} reports to ${m.name}`});
}
function flowMenu(at,id){
  const w=flow(id),get=()=>flow(id);
  openMenu(at,[
    {label:'Edit',icon:'pencil',run:focusName},
    {label:'Status',icon:'dot',items:Object.entries(WORKFLOW_STATUS).map(([k,n])=>({label:n,checked:w.status===k,run:()=>setOn(get,'status',k)}))},
    {label:'Duplicate workflow',icon:'filePlus',run(){
      const no=full(af(),'workflows');if(no){toast(no,true);return}
      change(()=>{const c=duplicateWorkflow(af(),id);if(c)selected={type:'workflow',id:c.id}});focusName();
    }},
    {label:'Copy brief',icon:'copy',run:copyBrief},
    '-',
    {label:'Delete workflow',icon:'trash',danger:true,key:keyLabel('agentflow.delete'),run:removeSelected},
  ],{label:`Workflow: ${w.name}`});
}

// ---------- side panel (shared #inspector) ----------
// The selection's header (avatar, name, status, Live), then collapsible sections. Which sections
// are open is remembered in ui.sec (localStorage); favourite models in ui.fav.
const SEC_OPEN={identity:true,run:true,work:true,instr:false,links:false,team:true,setup:true,steps:true};
const secOpen=k=>typeof ui.sec?.[k]==='boolean'?ui.sec[k]:SEC_OPEN[k]??true;
function sec(k,ic,title,body,meta=''){
  const open=secOpen(k);
  return `<section class="af-sec${open?' open':''}"><h3 class="af-sec-t"><button type="button" class="af-sec-h" id="af-sec-${k}" data-af-sec="${k}" aria-expanded="${open}" aria-controls="af-secb-${k}">${icon(ic,13)}<span>${title}</span>${meta?`<em>${meta}</em>`:''}<i class="af-chev">${icon('chevD',12)}</i></button></h3>
    <div class="af-sec-b" id="af-secb-${k}"${open?'':' hidden'}>${body}</div></section>`;
}
const ago=iso=>{const s=(Date.now()-Date.parse(iso))/1000;if(!Number.isFinite(s))return '';if(s<90)return 'just now';if(s<5400)return `${Math.round(s/60)} min ago`;if(s<129600)return `${Math.round(s/3600)} h ago`;return `${Math.round(s/86400)} days ago`};
const personAv=p=>{const [bg,fg]=memberColor(p.id);return {text:initials(p.name),bg,fg,img:photo(p)}};
const bub=(p,cls='')=>{const v=personAv(p),img=safeImg(v.img);return `<span class="bub ${cls}${img?' img':''}" style="background:${v.bg};color:${v.fg}">${img?`<img src="${esc(img)}" alt="">`:esc(v.text)}</span>`};
// The agent's face: its own image (if it ever has one), a human's supervisor photo, else its kind icon.
function avatarHtml(a){
  const sup=person(a.supervisor),img=safeImg(a.image)||(a.kind==='human'&&photo(sup));
  return `<span class="af-av k-${a.kind}${img?' img':''}" data-tip="${AGENT_KINDS[a.kind]}">${img?`<img src="${esc(img)}" alt="">`:icon(KIND_ICON[a.kind],20)}${sup&&!(a.kind==='human'&&img)?bub(sup,'af-av-sup'):''}</span>`;
}
// Status as coloured pills (one click each) for agents and workflows.
const statusPills=(cur,names)=>`<div class="af-pills" role="group" aria-label="Status">${Object.entries(names).map(([k,n])=>{const [bg,fg]=colorOf(STATUS_TONE[k]||'slate');
  return `<button type="button" class="af-pill${cur===k?' on':''}" id="af-st-${k}" data-af-status="${k}" aria-pressed="${cur===k}" style="--pb:${bg};--pf:${fg}"><i></i>${esc(n)}</button>`}).join('')}</div>`;
// A single-select picker trigger (ui.js openPicker) that shows the current choice.
const selBtn=(key,label,text,lead='',{none=false,disabled=false}={})=>`<button type="button" class="pk-btn af-sel${none?' none':''}" id="${key}" data-picker="${key}" aria-haspopup="listbox" aria-expanded="${pickerOpen(key)}" aria-label="${esc(`${label}: ${text}`)}"${disabled?' disabled':''}>${lead}<span class="pk-t">${esc(text)}</span>${icon('chevD',12)}</button>`;
// Inputs, outputs and tools: chips with ×, and an inline field that adds on Enter.
function chips(key,label,ic,hint,values){
  const one=label.toLowerCase().replace(/s$/,'');
  return `<div class="af-chips-l"><label for="af-new-${key}">${icon(ic,12)}${label}</label><em>${hint}</em></div>
    <div class="af-chips">${values.map((v,i)=>`<span class="af-chip"><span>${esc(v)}</span><button type="button" data-af-del="${key}" data-i="${i}" aria-label="${esc(`Remove ${one}: ${v}`)}">${icon('x',10)}</button></span>`).join('')}<input id="af-new-${key}" maxlength="200" placeholder="${values.length?'Add…':`Add ${one}, then Enter`}" aria-label="New ${one}"></div>`;
}
const projectItems=()=>db().projects.map(p=>({value:p.id,label:p.name,color:p.color}));
const cardItems=()=>db().devops.cards.map(c=>({value:c.id,label:`#${c.number} ${c.title}`,sub:db().devops.columns.find(x=>x.id===c.column)?.name||c.column,color:project(c.project)?.color}));
const itemItems=()=>[...db().timeline].sort((a,b)=>(a.start||'9999').localeCompare(b.start||'9999')).map(i=>({value:i.id,label:i.title,sub:`${i.kind}${i.start?' · '+i.start:''}`,color:project(i.projects[0])?.color}));
const PICKERS={'af-projects':['projects',projectItems,'Projects'],'af-cards':['cards',cardItems,'Cards'],'af-items':['items',itemItems,'Timeline items']};
const linkCount=x=>x.projects.length+x.cards.length+x.items.length;
function linksHtml(x){
  const w=workFor(db(),x);
  const cards=w.cards.map(c=>`<li><button type="button" data-af-card="${esc(c.id)}" data-tip="${x.cards.includes(c.id)?'Linked card':'Open card in a linked project'}">${icon('branch',12)}<span>#${c.number} ${esc(c.title)}</span><em>${esc(db().devops.columns.find(k=>k.id===c.column)?.name||c.column)}${c.due?' · '+esc(c.due):''}</em></button></li>`).join('');
  const items=w.items.map(i=>`<li><button type="button" data-af-item="${esc(i.id)}" data-tip="Open in the Timeline">${icon(i.kind==='deadline'?'flag':'gantt',12)}<span>${esc(i.title)}</span><em>${esc(i.start||'unscheduled')}</em></button></li>`).join('');
  return `<div class="af-pk">${pickerButton('af-projects','Projects',projectItems(),x.projects,{cls:'mini wide'})}${pickerButton('af-cards','Cards',cardItems(),x.cards,{cls:'mini wide'})}${pickerButton('af-items','Timeline',itemItems(),x.items,{cls:'mini wide'})}</div>
    ${cards||items?`<ul class="links af-links">${cards}${items}</ul>`:`<div class="dc-hint">Nothing linked yet: projects, cards and deadlines.</div>`}`;
}
// The candidates for Reports to: not itself and not one of its own reports.
const managersFor=a=>af().agents.filter(x=>x.id!==a.id&&!descendants(af(),a.id).has(x.id)).sort(byName);
function agentHtml(a){
  const ppl=peopleOf(db()),reps=reportsOf(af(),a.id),flows=workflowsFor(af(),a.id),chain=chainOf(af(),a.id),mgr=agent(a.reportsTo),sup=person(a.supervisor);
  const live=a.kind==='agent'&&a.live,why=live&&liveProblem(af(),a),ms=modelsOf(a);
  const identity=`<label>Kind</label><div class="seg wide">${Object.entries(AGENT_KINDS).map(([k,n])=>`<button type="button" class="${a.kind===k?'on':''}" id="af-kind-${k}" data-af-kind="${k}" aria-pressed="${a.kind===k}">${icon(KIND_ICON[k],13)}${n}</button>`).join('')}</div>
    <label for="af-title">Role</label><input id="af-title" maxlength="120" placeholder="e.g. Research" value="${esc(a.title)}">
    <label>Status</label>${statusPills(a.status,AGENT_STATUS)}
    <label for="af-reports">Reports to</label>${selBtn('af-reports','Reports to',mgr?mgr.name:'Nobody (top level)',`<span class="pk-ic">${icon(mgr?KIND_ICON[mgr.kind]:'network',13)}</span>`,{none:!mgr})}
    ${chain.length>1?`<div class="dc-hint af-chain">${esc(chain.map(x=>x.name).reverse().join(' › '))} › ${esc(a.name)}</div>`:''}
    <label for="af-sup">Supervisor <em>a person on your MindMap</em></label>${ppl.length?selBtn('af-sup','Supervisor',sup?sup.name:'None',sup?bub(sup,'mini'):`<span class="pk-ic">${icon('user',13)}</span>`,{none:!sup}):`<div class="dc-hint">Add people to a mind map to pick a supervisor.</div>`}`;
  const work=`<label for="af-purpose">Purpose</label><textarea id="af-purpose" rows="3" maxlength="2000" placeholder="What this agent is responsible for">${esc(a.purpose)}</textarea>
    ${chips('inputs','Inputs','inbox','what it takes in',a.inputs)}${chips('outputs','Outputs','send','what it produces',a.outputs)}${chips('tools','Tools','wrench','what it may use',a.tools)}`;
  const team=(reps.length?`<label>Direct reports</label><ul class="links">${reps.map(r=>`<li><button type="button" data-agent-go="${esc(r.id)}">${icon(KIND_ICON[r.kind],12)}<span>${esc(r.name)}</span><em>${esc(r.title)}</em></button></li>`).join('')}</ul>`:'')
    +(flows.length?`<label>Workflows</label><ul class="links">${flows.map(w=>`<li><button type="button" data-flow-go="${esc(w.id)}">${icon('flow',12)}<span>${esc(w.name)}</span><em>step ${w.steps.map((s,i)=>s.agent===a.id?i+1:0).filter(Boolean).join(', ')}</em></button></li>`).join('')}</ul>`:'');
  const instrMeta=a.instructions.trim()?plural(a.instructions.trim().split('\n').length,'line'):'empty';
  const runMeta=a.runtime.trim()?esc(a.runtime.trim()):'not set',linkMeta=linkCount(a)?String(linkCount(a)):'none';
  return `<div class="ihead"><span class="k af-k${a.kind==='human'?' human':''}">${icon(KIND_ICON[a.kind])}</span><strong>${AGENT_KINDS[a.kind]}</strong><span class="sp"></span>
    ${ib('copy','Copy brief as Markdown\nFor the runner that does the work',{attrs:'data-afi="brief"'})}${ib('plus','Add a direct report',{attrs:'data-afi="addReport"'})}
    ${ib('trash','Delete agent',{key:keyLabel('agentflow.delete'),cls:'danger',attrs:'data-afi="delete"'})}${ib('x','Close',{key:keyLabel('global.escape'),attrs:'data-afi="close"'})}</div>
    <form id="afedit" class="ibody af-panel" autocomplete="off">
    <div class="af-hero">${avatarHtml(a)}<div class="af-hero-m"><input id="af-name" class="af-name-in" maxlength="120" required value="${esc(a.name)}" aria-label="Name">
      <div class="af-hero-s">${statusPill(a.status,AGENT_STATUS)}<span>${esc([a.title,a.kind==='agent'&&ms.length?modelLabel(af(),{...a,model:ms[0]}):''].filter(Boolean).join(' · ')||AGENT_KINDS[a.kind])}</span></div></div>
      ${a.kind==='agent'?liveHtml(a,why):''}</div>
    ${why?`<div class="af-warn" role="status">${icon('alert',12)}<span>Its runner will skip it: ${esc(why)}</span></div>`:''}
    ${sec('identity','idCard','Identity',identity)}
    ${a.kind==='agent'?sec('run','server','Runs on',runtimeHtml(a),runMeta):''}
    ${sec('work','target','Work',work,`${a.inputs.length} in · ${a.outputs.length} out`)}
    ${sec('instr','book','Instructions',`<textarea id="af-instr" rows="8" maxlength="20000" aria-label="Instructions" placeholder="System prompt or runbook">${esc(a.instructions)}</textarea>`,instrMeta)}
    ${sec('links','link','Links',linksHtml(a),linkMeta)}
    ${team?sec('team','network','Team',team,[reps.length&&plural(reps.length,'report'),flows.length&&plural(flows.length,'workflow')].filter(Boolean).join(' · ')):''}
    </form>`;
}
// The switch a runner obeys. It stays off until someone turns it on, whatever the status says.
function liveHtml(a,why){
  const tip=a.live?(why?`Live, but its runner will skip it: ${why}`:`Live: ${a.runtime} works its queue`):'Not live: runners leave this agent alone';
  return `<label class="af-live af-live-c${a.live?' on':''}${why?' warn':''}" data-tip="${esc(tip)}"><input type="checkbox" id="af-live" role="switch"${a.live?' checked':''}><span class="af-sw" aria-hidden="true"></span><span class="af-live-l">Live</span></label>`;
}
// ---------- Runs on: a reported runner (or any name) and an ordered list of models ----------
// Agent models: `models` primary first then fallbacks (max 10), `model` = models[0] for older
// readers, `auto` = the runner picks from the list per card.
const MAX_MODELS=10,MP_CAP=200;
const modelsOf=a=>Array.isArray(a.models)?a.models:(a.model?[a.model]:[]);
const providerOf=m=>m.provider||(m.id.includes(':')?m.id.split(':')[0]:'Other');
const BILLING={included:['Included','green'],metered:['Metered','amber']};
const billBadge=m=>{const b=BILLING[m?.billing];if(!b)return '';const [bg,fg]=colorOf(b[1]);return `<span class="af-bill" style="background:${bg};color:${fg}">${b[0]}</span>`};
function modelPool(a){
  const r=runnerOf(af(),a.runtime),seen=new Set(),out=[];
  for(const m of r?r.models:(af().runners||[]).flatMap(x=>x.models))if(!seen.has(m.id)){seen.add(m.id);out.push(m)}
  return out;
}
function setModels(a,list){
  list=[...new Set(list)].slice(0,MAX_MODELS);
  change(()=>{a.models=list;a.model=list[0]||'';touch(a)});
}
function runtimeHtml(a){
  const rs=af().runners||[],r=runnerOf(af(),a.runtime),ms=modelsOf(a),pool=new Map(modelPool(a).map(m=>[m.id,m]));
  const rows=ms.map((id,i)=>{const m=pool.get(id);
    return `<li class="af-m${i?'':' first'}"><em>${i+1}</em>${makerIcon(modelMaker(id,m?.label),15)}<span class="af-m-l"><b>${esc(m?.label||id)}</b><small>${i?`Fallback ${i+1}`:a.auto===true?'Pool':'Primary'}${m?.label&&m.label!==id?` · ${esc(id)}`:''}${m||!pool.size?'':' · not reported'}</small></span>${billBadge(m)}
      <span class="af-m-b">${ib('chevU','Move up',{attrs:`id="af-mup-${i}" data-af-mup="${i}"${i?'':' disabled'}`})}${ib('chevD','Move down',{attrs:`id="af-mdn-${i}" data-af-mdn="${i}"${i<ms.length-1?'':' disabled'}`})}${ib('x','Remove',{attrs:`id="af-mdel-${i}" data-af-mdel="${i}"`,label:`Remove ${m?.label||id}`})}</span></li>`}).join('');
  return `<label for="af-runtime">Runner</label>
    <div class="af-combo"><input id="af-runtime" maxlength="200" placeholder="${rs.length?'Pick or type a runner':'e.g. T3, home server'}" value="${esc(a.runtime)}">
      <button type="button" class="af-combo-b" data-picker="af-runner" aria-haspopup="listbox" aria-expanded="${pickerOpen('af-runner')}" aria-label="Reported runners"${rs.length?'':' disabled'} data-tip="${rs.length?`${plural(rs.length,'runner')} reported`:'No runner has reported to this workspace yet'}">${icon('chevD',12)}</button></div>
    ${r?`<div class="dc-hint af-ok">${icon('check',11)}Reported ${esc(ago(r.reported))} · ${plural(r.models.length,'model')}</div>`
      :a.runtime.trim()&&rs.length?`<div class="dc-hint">No runner called “${esc(a.runtime.trim())}” has reported to this workspace.</div>`:''}
    <label for="af-model-add">Models <em>${a.auto===true?'the runner picks per card':'primary, then fallbacks'}</em></label>
    ${rows?`<ol class="af-models">${rows}</ol>`:''}
    <button type="button" class="pk-btn af-madd" id="af-model-add" data-af-models aria-haspopup="listbox" aria-expanded="${!!mp}"${ms.length>=MAX_MODELS?' disabled':''}>${icon('plus',12)}<span class="pk-t">${ms.length?'Add a fallback':'Choose a model'}</span><small>${pool.size?`${pool.size} available`:'type any id'}</small></button>
    <label class="af-tog${a.auto===true?' on':''}"><input type="checkbox" id="af-auto" role="switch"${a.auto===true?' checked':''}><span class="af-sw" aria-hidden="true"></span><span>${icon('sparkle',12)}Auto <em>let the runner pick from these per card</em></span></label>`;
}
// The model picker: searchable, grouped by provider, favourites first, and it stays open while you
// add (Enter or click), so a primary and its fallbacks are picked in one go. Rows are capped so a
// runner with hundreds of models stays quick; typing narrows the list.
let mp=null;
function closeModels(refocus=false){
  if(!mp)return;const p=mp;mp=null;popOut(p.el);document.removeEventListener('pointerdown',p.out,true);removeEventListener('resize',p.place);
  const b=$('#af-model-add');b?.setAttribute('aria-expanded','false');if(refocus)setTimeout(()=>$('#af-model-add')?.focus());
}
function openModels(btn){
  if(mp){closeModels();return}
  const id=sel()?.id,a0=agent(id);if(!a0)return;
  const pool=modelPool(a0).map(m=>{const p=providerOf(m);return {...m,p,h:`${m.label} ${m.id} ${p}`.toLowerCase()}});
  const el=document.createElement('div');el.className='picker af-mp';
  el.innerHTML=`<input class="pk-q" type="search" placeholder="${pool.length?`Search ${plural(pool.length,'model')}`:'Type a model id'}" aria-label="Search models" aria-controls="af-mp-list" autocomplete="off" role="combobox" aria-expanded="true">
    <div class="pk-list" role="listbox" id="af-mp-list" aria-multiselectable="true" aria-label="Models"></div><div class="af-mp-foot"></div>`;
  document.body.append(el);
  const input=el.querySelector('.pk-q'),list=el.querySelector('.pk-list'),foot=el.querySelector('.af-mp-foot');
  let rows=[],active=0;
  function draw(){
    const a=agent(id);if(!a){closeModels();return}
    const cur=modelsOf(a),raw=input.value.trim(),words=raw.toLowerCase().split(/\s+/).filter(Boolean),fav=new Set(ui.fav||[]);
    const hit=words.length?pool.filter(m=>words.every(w=>m.h.includes(w))):pool;
    const groups=new Map([['Favorites',[]]]);
    for(const m of hit){const g=fav.has(m.id)?'Favorites':m.p;if(!groups.has(g))groups.set(g,[]);groups.get(g).push(m)}
    rows=[];
    if(raw&&!pool.some(m=>m.id===raw))rows.push({id:raw.slice(0,120),label:raw.slice(0,120),custom:true,g:''});
    for(const [g,ms] of groups)for(const m of ms){if(rows.length>=MP_CAP)break;rows.push({...m,g})}
    active=Math.max(0,Math.min(active,rows.length-1));let g;
    list.innerHTML=rows.length?rows.map((m,k)=>{const at=cur.indexOf(m.id),head=m.g&&m.g!==g?(g=m.g,`<div class="pk-group" role="presentation">${m.g==='Favorites'?icon('star',10):''}${esc(m.g)}</div>`):'';
      return head+`<div class="pk-opt af-mo${k===active?' active':''}" role="option" id="af-mp-${k}" data-k="${k}" aria-selected="${at>=0}"><span class="af-mo-n${at>=0?' on':''}">${at>=0?at+1:icon('plus',10)}</span>
        ${makerIcon(modelMaker(m.id,m.label),14)}<span class="pk-l">${m.custom?`Use “${esc(m.id)}”`:esc(m.label||m.id)}<small>${m.custom?'a model id the runner knows':esc(m.id)}</small></span>${billBadge(m)}
        ${m.custom?'':`<button type="button" class="af-star${fav.has(m.id)?' on':''}" data-star="${k}" tabindex="-1" aria-label="${fav.has(m.id)?'Unfavorite':'Favorite'} ${esc(m.label||m.id)}">${icon('star',13)}</button>`}</div>`}).join('')
      :`<div class="pk-empty">${pool.length?'No models match':'This runner reported no models: type an id'}</div>`;
    input.setAttribute('aria-activedescendant',rows.length?`af-mp-${active}`:'');
    foot.innerHTML=`<span>${hit.length>MP_CAP?`${MP_CAP} of ${hit.length} shown · type to narrow`:`${cur.length}/${MAX_MODELS} chosen`}</span><span><kbd>Enter</kbd> add · <kbd>Shift+Enter</kbd> favorite</span>`;
    list.querySelector('.active')?.scrollIntoView({block:'nearest'});
  }
  function toggle(k){
    const m=rows[k],a=agent(id);if(!m||!a)return;const cur=modelsOf(a);
    if(cur.includes(m.id))setModels(a,cur.filter(x=>x!==m.id));
    else if(cur.length>=MAX_MODELS){toast(`Up to ${MAX_MODELS} models: a primary and its fallbacks.`,true);return}
    else{setModels(a,[...cur,m.id]);if(m.custom)input.value=''}
    active=k;draw();place();
  }
  function star(k){
    const m=rows[k];if(!m||m.custom)return;const f=new Set(ui.fav||[]);
    if(f.has(m.id))f.delete(m.id);else f.add(m.id);ui.fav=[...f].slice(-200);keepUi();draw();
  }
  function place(){
    const r=($('#af-model-add')||btn).getBoundingClientRect();el.style.width=Math.max(300,r.width)+'px';
    const H=el.offsetHeight;let top=r.bottom+4;if(top+H>innerHeight-6)top=Math.max(6,r.top-H-4);
    el.style.left=Math.max(6,Math.min(r.left,innerWidth-el.offsetWidth-6))+'px';el.style.top=top+'px';
  }
  el.addEventListener('keydown',e=>{
    e.stopPropagation();const n=rows.length;
    if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();active=(active+(e.key==='ArrowDown'?1:-1)+n)%Math.max(1,n);draw()}
    else if(e.key==='Enter'){e.preventDefault();e.shiftKey?star(active):toggle(active)}
    else if(e.key==='Escape'){e.preventDefault();closeModels(true)}
    else if(e.key==='Tab')closeModels();
    else if((e.key==='Home'||e.key==='End')&&!input.value){e.preventDefault();active=e.key==='Home'?0:n-1;draw()}
  });
  input.addEventListener('input',()=>{active=0;draw();place()});
  el.addEventListener('click',e=>{
    const s=e.target.closest('[data-star]');if(s){star(+s.dataset.star);input.focus();return}
    const o=e.target.closest('.pk-opt');if(o){toggle(+o.dataset.k);input.focus()}
  });
  const out=e=>{if(!el.contains(e.target)&&!e.target.closest?.('#af-model-add'))closeModels()};
  mp={id,el,out,place,draw};
  document.addEventListener('pointerdown',out,true);addEventListener('resize',place);
  btn.setAttribute('aria-expanded','true');
  draw();place();popIn(el);input.focus();
}
function workflowHtml(w){
  const agents=[...af().agents].sort(byName);
  const setup=`<label for="af-desc">Description</label><textarea id="af-desc" rows="3" maxlength="4000" placeholder="What this workflow achieves">${esc(w.description)}</textarea>
    <label>Trigger</label><div class="seg wide">${Object.entries(TRIGGERS).map(([k,n])=>`<button type="button" class="${w.trigger===k?'on':''}" id="af-trig-${k}" data-af-trigger="${k}" aria-pressed="${w.trigger===k}">${icon(TRIGGER_ICON[k],12)}${n}</button>`).join('')}</div>
    ${w.trigger==='manual'?'':`<label for="af-sched">${w.trigger==='schedule'?'When':'On'}</label><input id="af-sched" maxlength="200" placeholder="${esc(TRIGGER_HINT[w.trigger])}" value="${esc(w.schedule)}">`}`;
  const steps=`<ol class="af-step-list">${w.steps.map((s,i)=>`<li data-step="${esc(s.id)}"><em>${i+1}</em><div class="af-step-f">
      <select data-step-agent="${esc(s.id)}" aria-label="Step ${i+1} agent">${opt('','Unassigned',s.agent)}${agents.map(a=>opt(a.id,a.name,s.agent)).join('')}</select>
      <input data-step-action="${esc(s.id)}" id="af-act-${esc(s.id)}" maxlength="500" placeholder="What happens" value="${esc(s.action)}" aria-label="Step ${i+1} action">
      <input data-step-output="${esc(s.id)}" id="af-out-${esc(s.id)}" maxlength="300" placeholder="Output (optional)" value="${esc(s.output)}" aria-label="Step ${i+1} output"></div>
      <div class="af-step-b">${ib('chevU','Move up',{attrs:`data-step-up="${esc(s.id)}"${i?'':' disabled'}`})}${ib('chevD','Move down',{attrs:`data-step-down="${esc(s.id)}"${i<w.steps.length-1?'':' disabled'}`})}${ib('x','Remove step',{attrs:`data-step-del="${esc(s.id)}"`})}</div></li>`).join('')}</ol>
    <button type="button" class="txt af-addstep" data-afi="addStep">${icon('plus',13)}Add step</button>`;
  return `<div class="ihead"><span class="k af-k">${icon('flow')}</span><strong>Workflow</strong><span class="sp"></span>
    ${ib('copy','Copy brief as Markdown\nFor the runner that does the work',{attrs:'data-afi="brief"'})}${ib('trash','Delete workflow',{key:keyLabel('agentflow.delete'),cls:'danger',attrs:'data-afi="delete"'})}${ib('x','Close',{key:keyLabel('global.escape'),attrs:'data-afi="close"'})}</div>
    <form id="afedit" class="ibody af-panel" autocomplete="off">
    <div class="af-hero"><span class="af-av k-flow">${icon('flow',20)}</span><div class="af-hero-m"><input id="af-name" class="af-name-in" maxlength="120" required value="${esc(w.name)}" aria-label="Name">
      <div class="af-hero-s">${icon(TRIGGER_ICON[w.trigger],11)}<span>${esc(TRIGGERS[w.trigger])}${w.schedule&&w.trigger!=='manual'?` · ${esc(w.schedule)}`:''} · ${plural(w.steps.length,'step')}</span></div></div></div>
    ${statusPills(w.status,WORKFLOW_STATUS)}
    ${sec('setup','zap','Setup',setup)}
    ${sec('steps','list','Steps',steps,String(w.steps.length))}
    ${sec('links','link','Links',linksHtml(w),linkCount(w)?String(linkCount(w)):'none')}
    </form>`;
}
export function renderInspector(pane){
  const x=sel();
  if(mp&&(!x||x.id!==mp.id))closeModels();
  panel(pane,!!x,{onHidden:()=>{if(!sel())pane.innerHTML=''}});
  if(!x)return;
  // Keep focus and caret when the panel is redrawn after a change.
  const a=document.activeElement,keep=pane.contains(a)&&a.id?{id:a.id,s:a.selectionStart,e:a.selectionEnd}:null,top=pane.scrollTop;
  pane.innerHTML=selected.type==='agent'?agentHtml(x):workflowHtml(x);
  pane.scrollTop=top;
  const f=keep&&document.getElementById(keep.id);
  if(f){f.focus({preventScroll:true});try{if(keep.s!=null)f.setSelectionRange(keep.s,keep.e)}catch{}}
  if(mp){mp.draw();mp.place()}
}
function addTo(key){
  const x=sel(),i=$('#af-new-'+key),v=i?.value.trim();if(!x||!v)return;
  const no=!x[key].includes(v)&&full(af(),'list',x,key);if(no){toast(no,true);return}
  change(()=>{if(!x[key].includes(v))x[key].push(v.slice(0,200));touch(x)});
  $('#af-new-'+key)?.focus();
}
// Single-choice pickers in the side panel: who it reports to, its supervisor, its runner.
const SINGLE={
  'af-reports':{label:'Reports to',items:a=>[{value:'',label:'Nobody (top level)',icon:'network'},...managersFor(a).map(x=>({value:x.id,label:x.name,sub:x.title,icon:KIND_ICON[x.kind]}))],cur:a=>a.reportsTo,
    set(a,v){if(v&&!canReportTo(af(),a.id,v)){rerender();return}change(()=>{a.reportsTo=v;touch(a)})}},
  'af-sup':{label:'Supervisor',items:()=>[{value:'',label:'None',icon:'user'},...peopleOf(db()).sort(byName).map(p=>({value:p.id,label:p.name,sub:p.title||'',avatar:personAv(p)}))],cur:a=>a.supervisor,
    set(a,v){change(()=>{a.supervisor=v;touch(a)})}},
  'af-runner':{label:'Runners',items:()=>(af().runners||[]).map(r=>({value:r.name,label:r.name,sub:`${plural(r.models.length,'model')} · ${ago(r.reported)}`,icon:'server'})),cur:a=>runnerOf(af(),a.runtime)?.name||a.runtime,
    set(a,v){change(()=>{a.runtime=v;touch(a)})}},
};
export function inspectorClick(e){
  const box=e.target.closest('.af-chips');if(box&&e.target===box){box.querySelector('input')?.focus();return}
  const b=e.target.closest('button');if(!b)return;
  const x=sel();if(!x)return;
  if(b.dataset.afSec){const k=b.dataset.afSec;ui.sec={...ui.sec,[k]:!secOpen(k)};keepUi();rerender();return}
  const pk=PICKERS[b.dataset.picker];
  if(pk){const [k,items,label]=pk;openPicker(b,{items:items(),selected:x[k],label,placeholder:`Search ${label.toLowerCase()}`,onChange(v){if(v.length>LIMITS.refs){toast(`Up to ${LIMITS.refs} linked ${k} each.`,true);rerender();return}change(()=>{x[k]=v;touch(x)})}});return}
  const one=SINGLE[b.dataset.picker];
  if(one){const items=one.items(x);openPicker(b,{items,selected:[one.cur(x)],multi:false,search:items.length>6,label:one.label,placeholder:`Search ${one.label.toLowerCase()}`,onChange([v]){const y=sel();if(y&&v!==one.cur(y))one.set(y,v??'')}});return}
  if(b.dataset.afModels!==undefined){openModels(b);return}
  if(b.dataset.afMup||b.dataset.afMdn||b.dataset.afMdel){
    const ms=[...modelsOf(x)],i=+(b.dataset.afMup||b.dataset.afMdn||b.dataset.afMdel);
    if(b.dataset.afMdel){ms.splice(i,1);setModels(x,ms);requestAnimationFrame(()=>($(`#af-mdel-${Math.min(i,ms.length-1)}`)||$('#af-model-add'))?.focus());return}
    const j=b.dataset.afMup?i-1:i+1;if(j<0||j>=ms.length)return;[ms[i],ms[j]]=[ms[j],ms[i]];setModels(x,ms);
    requestAnimationFrame(()=>($(`#af-${b.dataset.afMup?'mup':'mdn'}-${j}:not([disabled])`)||$(`#af-mdel-${j}`))?.focus());return;
  }
  if(b.dataset.afKind){if(x.kind!==b.dataset.afKind)change(()=>{x.kind=b.dataset.afKind;touch(x)});return}
  if(b.dataset.afStatus){if(x.status!==b.dataset.afStatus)change(()=>{x.status=b.dataset.afStatus;touch(x)});return}
  if(b.dataset.afTrigger){if(x.trigger!==b.dataset.afTrigger)change(()=>{x.trigger=b.dataset.afTrigger;touch(x)});return}
  if(b.dataset.afAdd){addTo(b.dataset.afAdd);return}
  if(b.dataset.afDel){const k=b.dataset.afDel,i=+b.dataset.i;change(()=>{x[k].splice(i,1);touch(x)});requestAnimationFrame(()=>$('#af-new-'+k)?.focus());return}
  if(b.dataset.afCard){openCard(b.dataset.afCard);return}
  if(b.dataset.afItem){openItem(b.dataset.afItem);return}
  if(b.dataset.agentGo){select('agent',b.dataset.agentGo);return}
  if(b.dataset.flowGo){ui.view='workflows';keepUi();select('workflow',b.dataset.flowGo);return}
  const step=id=>x.steps.findIndex(s=>s.id===id);
  if(b.dataset.stepDel){change(()=>{x.steps.splice(step(b.dataset.stepDel),1);touch(x)});return}
  if(b.dataset.stepUp||b.dataset.stepDown){
    const id=b.dataset.stepUp||b.dataset.stepDown,i=step(id),j=b.dataset.stepUp?i-1:i+1;if(i<0||j<0||j>=x.steps.length)return;
    change(()=>{[x.steps[i],x.steps[j]]=[x.steps[j],x.steps[i]];touch(x)});
    requestAnimationFrame(()=>document.querySelector(`#inspector [data-step-${j<i?'up':'down'}="${CSS.escape(id)}"]:not([disabled])`)?.focus());return;
  }
  ({close:()=>select(null),delete:removeSelected,brief:copyBrief,addReport:()=>addAgent(x.id),
    addStep(){const no=full(af(),'steps',x);if(no){toast(no,true);return}const s=newStep();change(()=>{x.steps.push(s);touch(x)});requestAnimationFrame(()=>document.getElementById('af-act-'+s.id)?.focus())},
  })[b.dataset.afi]?.();
}
// Text fields autosave as you type: one undo step per open form.
const TEXT={'af-name':'name','af-title':'title','af-purpose':'purpose','af-runtime':'runtime','af-instr':'instructions','af-desc':'description','af-sched':'schedule'};
export function inspectorInput(e){
  const t=e.target,x=sel(),form=$('#afedit');if(!x||!form)return;
  const key=TEXT[t.id],sa=t.dataset.stepAction,so=t.dataset.stepOutput;
  if(!key&&!sa&&!so)return;
  if(key==='name'&&!t.value.trim())return;
  if(!edited.has(form)){checkpoint();edited.add(form)}
  if(key)x[key]=key==='name'?t.value.trim():t.value;
  else{const s=x.steps.find(y=>y.id===(sa||so));if(s)s[sa?'action':'output']=t.value}
  touch(x);save();render();
}
export function inspectorChange(e){
  const t=e.target,x=sel();if(!x)return;
  const set=(k,v)=>change(()=>{x[k]=v;touch(x)});
  if(t.id==='af-live')set('live',t.checked);
  else if(t.id==='af-auto')set('auto',t.checked);
  // The runner hint and the models it offers follow a typed runner name once the field is left.
  else if(t.id==='af-runtime')rerender();
  else if(t.dataset.stepAgent)change(()=>{const s=x.steps.find(y=>y.id===t.dataset.stepAgent);if(s)s.agent=t.value;touch(x)});
}
export function inspectorKey(e){
  const m=/^af-new-(\w+)$/.exec(e.target.id||'');
  // Backspace in an empty chip field removes the last chip.
  if(m&&e.key==='Backspace'&&!e.target.value){const x=sel();if(x?.[m[1]]?.length){e.preventDefault();change(()=>{x[m[1]].pop();touch(x)})}return}
  if(e.key!=='Enter')return;
  if(m){e.preventDefault();addTo(m[1])}else if(e.target.tagName==='INPUT')e.preventDefault();
}
export function key(e){
  if(e.key==='Escape'){if(selected&&!menuOpen())select(null);return}
  if(matches(e,'agentflow.delete')&&sel()){e.preventDefault();removeSelected();return}
  if(matches(e,'agentflow.addAgent')){e.preventDefault();addAgent()}
  else if(matches(e,'agentflow.addWorkflow')){e.preventDefault();addWorkflow()}
  else if(matches(e,'agentflow.search')){e.preventDefault();$('#af-q')?.focus()}
  else if(ui.view==='org'&&e.key.startsWith('Arrow')&&!e.ctrlKey&&!e.metaKey){if(nudge(e))e.preventDefault()}
  else if(ui.view==='org'&&matches(e,'agentflow.fit')){e.preventDefault();fit()}
  else if(ui.view==='org'&&matches(e,'agentflow.zoomIn')){e.preventDefault();zoom(1.2)}
  else if(ui.view==='org'&&matches(e,'agentflow.zoomOut')){e.preventDefault();zoom(1/1.2)}
  else if(matches(e,'agentflow.view1')||matches(e,'agentflow.view2')){
    const v=matches(e,'agentflow.view1')?'org':'workflows';if(ui.view===v)return;
    e.preventDefault();ui.view=v;keepUi();if(selected&&(selected.type==='agent')!==(v==='org'))selected=null;rerender();
  }
}
