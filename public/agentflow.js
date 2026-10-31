import {icon} from './icons.js';
import {$,esc,ib,pickerButton,openPicker} from './ui.js';
import {panel,flipList} from './motion.js';
import {matches,keyLabel} from './shortcuts.js';
import {ask} from './modal.js';
import {openMenu,menuOpen} from './menu.js';
import {store,change,checkpoint,commit,save} from './store.js';
import {clone} from './ui.js';
import {AGENT_KINDS,AGENT_STATUS,WORKFLOW_STATUS,TRIGGERS,TRIGGER_HINT,newAgent,newWorkflow,newStep,agentOf,reportsOf,descendants,chainOf,
  removeAgent,full,LIMITS,workflowsFor,workFor,openWork,filterAgents,filterWorkflows,agentBrief,workflowBrief,starterAgentflow,peopleOf,
  canReportTo,CARD,positions,placed,pin,unpin,workQueue,duplicateWorkflow} from './agentflow-core.js';
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
function nodeHtml(a,p,hits){
  const flows=workflowsFor(af(),a.id).length,open=openWork(db(),a),sup=person(a.supervisor);
  const isSel=selected?.type==='agent'&&selected.id===a.id,dim=hits&&!hits.has(a.id),drop=drag?.mode==='link'&&drag.over===a.id;
  const [bg,fg]=sup?memberColor(sup.id):[];
  return `<div class="af-node k-${a.kind} st-${a.status}${isSel?' sel':''}${dim?' dim':''}${drop?' drop':''}" data-agent="${esc(a.id)}" tabindex="0" role="button" aria-label="${esc(`${AGENT_KINDS[a.kind]}: ${a.name}`)}" style="left:${p.x}px;top:${p.y}px">
    <div class="af-n-top"><span class="af-k" data-tip="${AGENT_KINDS[a.kind]}">${icon(KIND_ICON[a.kind],14)}</span><span class="nm">${esc(a.name)}</span><i class="af-st" data-tip="${AGENT_STATUS[a.status]}"></i></div>
    <div class="af-n-title">${esc(a.title)}</div>
    <div class="af-n-foot"><span data-tip="${plural(a.inputs.length,'input')} → ${plural(a.outputs.length,'output')}">${icon('arrowR',11)}${a.inputs.length}/${a.outputs.length}</span>
      ${flows?`<span data-tip="In ${plural(flows,'workflow')}">${icon('flow',11)}${flows}</span>`:''}
      ${open?`<span data-tip="${plural(open,'open card')}">${icon('branch',11)}${open}</span>`:''}
      ${sup?`<span class="sp"></span><span class="bub mini" style="background:${bg};color:${fg}" data-tip="Supervised by ${esc(sup.name)}">${esc(initials(sup.name))}</span>`:''}</div>
    <span class="af-port" data-port data-tip="Drag onto an agent to make it report here, or onto empty space for a new report" data-tip-delay="600"></span></div>`;
}
// Manager to report: a rounded elbow down from the manager when the report sits below, else a curve.
function linkPath(m,r){
  const x1=m.x+CARD.w/2,y1=m.y+CARD.h,x2=r.x+CARD.w/2,y2=r.y;
  if(y2-y1>=24){
    const ym=y1+Math.min(28,(y2-y1)/2),dx=x2-x1,rad=Math.min(8,Math.abs(dx)/2,(y2-ym)/2),sx=Math.sign(dx);
    return dx===0?`M${x1} ${y1}V${y2}`:`M${x1} ${y1}V${ym-rad}Q${x1} ${ym} ${x1+sx*rad} ${ym}H${x2-sx*rad}Q${x2} ${ym} ${x2} ${ym+rad}V${y2}`;
  }
  const k=Math.max(40,Math.abs(y2-y1)/2);
  return `M${x1} ${y1}C${x1} ${y1+k} ${x2} ${y2-k} ${x2} ${y2}`;
}
const canvasHtml=()=>`<div id="afCanvas" class="af-canvas" aria-label="AgentFlow org canvas"><div class="af-world"><svg class="af-edges" aria-hidden="true"></svg><div class="af-nodes"></div></div></div>
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
  // Each line also gets a wide invisible twin, so it is easy to right-click.
  const lines=af().agents.filter(a=>a.reportsTo&&pos.has(a.reportsTo)).map(a=>{const d=linkPath(pos.get(a.reportsTo),pos.get(a.id));
    return `<path class="af-ln${hits&&!(hits.has(a.id)&&hits.has(a.reportsTo))?' dim':''}" d="${d}"/><path class="af-hit" data-line="${esc(a.id)}" d="${d}"/>`}).join('');
  const m=drag?.mode==='link'&&pos.get(drag.id),ghost=m&&drag.px!=null?`<path class="ghost" d="M${m.x+CARD.w/2} ${m.y+CARD.h}L${drag.px} ${drag.py}"/>`:'';
  cv.querySelector('.af-edges').innerHTML=lines+ghost;
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
      ...(ok.length>shown.length?['-',{label:'More in the side panel…',run(){select('agent',id);requestAnimationFrame(()=>$('#af-reports')?.focus())}}]:[])]},
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
const listEditor=(key,label,hint,values)=>`<label>${label} <em>${hint}</em></label><ul class="dc-list">${values.map((v,i)=>`<li><span class="nm">${esc(v)}</span>${ib('x','Remove',{attrs:`data-af-del="${key}" data-i="${i}"`})}</li>`).join('')}</ul>
  <div class="dc-row"><input id="af-new-${key}" maxlength="200" placeholder="Add and press Enter" aria-label="New ${label.toLowerCase().replace(/s$/,'')}">${ib('plus','Add',{attrs:`data-af-add="${key}"`})}</div>`;
const projectItems=()=>db().projects.map(p=>({value:p.id,label:p.name,color:p.color}));
const cardItems=()=>db().devops.cards.map(c=>({value:c.id,label:`#${c.number} ${c.title}`,sub:db().devops.columns.find(x=>x.id===c.column)?.name||c.column,color:project(c.project)?.color}));
const itemItems=()=>[...db().timeline].sort((a,b)=>(a.start||'9999').localeCompare(b.start||'9999')).map(i=>({value:i.id,label:i.title,sub:`${i.kind}${i.start?' · '+i.start:''}`,color:project(i.projects[0])?.color}));
const PICKERS={'af-projects':['projects',projectItems,'Projects'],'af-cards':['cards',cardItems,'Cards'],'af-items':['items',itemItems,'Timeline items']};
function linksHtml(x){
  const w=workFor(db(),x);
  const cards=w.cards.map(c=>`<li><button type="button" data-af-card="${esc(c.id)}" data-tip="${x.cards.includes(c.id)?'Linked card':'Open card in a linked project'}">${icon('branch',12)}<span>#${c.number} ${esc(c.title)}</span><em>${esc(db().devops.columns.find(k=>k.id===c.column)?.name||c.column)}${c.due?' · '+esc(c.due):''}</em></button></li>`).join('');
  const items=w.items.map(i=>`<li><button type="button" data-af-item="${esc(i.id)}" data-tip="Open in the Timeline">${icon(i.kind==='deadline'?'flag':'gantt',12)}<span>${esc(i.title)}</span><em>${esc(i.start||'unscheduled')}</em></button></li>`).join('');
  return `<label>Flow work <em>projects, cards and deadlines</em></label>
    <div class="af-pk">${pickerButton('af-projects','Projects',projectItems(),x.projects,{cls:'mini wide'})}${pickerButton('af-cards','Cards',cardItems(),x.cards,{cls:'mini wide'})}${pickerButton('af-items','Timeline',itemItems(),x.items,{cls:'mini wide'})}</div>
    ${cards||items?`<ul class="links af-links">${cards}${items}</ul>`:`<div class="dc-hint">Nothing linked yet.</div>`}`;
}
function agentHtml(a){
  const others=af().agents.filter(x=>x.id!==a.id&&!descendants(af(),a.id).has(x.id)).sort((x,y)=>x.name.localeCompare(y.name));
  const ppl=peopleOf(db()).sort((x,y)=>x.name.localeCompare(y.name)),reps=reportsOf(af(),a.id),flows=workflowsFor(af(),a.id),chain=chainOf(af(),a.id);
  return `<div class="ihead"><span class="k af-k">${icon(KIND_ICON[a.kind])}</span><strong>${AGENT_KINDS[a.kind]}</strong><span class="sp"></span>
    ${ib('copy','Copy brief as Markdown\nFor the runner that does the work',{attrs:'data-afi="brief"'})}${ib('plus','Add a direct report',{attrs:'data-afi="addReport"'})}
    ${ib('trash','Delete agent',{key:keyLabel('agentflow.delete'),cls:'danger',attrs:'data-afi="delete"'})}${ib('x','Close',{key:keyLabel('global.escape'),attrs:'data-afi="close"'})}</div>
    <form id="afedit" class="ibody" autocomplete="off">
    <label for="af-name">Name</label><input id="af-name" maxlength="120" required value="${esc(a.name)}">
    <label>Kind</label><div class="seg wide">${Object.entries(AGENT_KINDS).map(([k,n])=>`<button type="button" class="${a.kind===k?'on':''}" data-af-kind="${k}" aria-pressed="${a.kind===k}">${icon(KIND_ICON[k],13)}${n}</button>`).join('')}</div>
    <div class="two"><div><label for="af-title">Role</label><input id="af-title" maxlength="120" placeholder="e.g. Research" value="${esc(a.title)}"></div>
      <div><label for="af-status">Status</label><select id="af-status">${Object.entries(AGENT_STATUS).map(([k,n])=>opt(k,n,a.status)).join('')}</select></div></div>
    <label for="af-reports">Reports to</label><select id="af-reports">${opt('','Nobody (top level)',a.reportsTo)}${others.map(x=>opt(x.id,x.name+(x.title?` · ${x.title}`:''),a.reportsTo)).join('')}</select>
    ${chain.length>1?`<div class="dc-hint">${esc(chain.map(x=>x.name).reverse().join(' › '))} › ${esc(a.name)}</div>`:''}
    <label for="af-sup">Supervisor <em>a person on your MindMap</em></label>${ppl.length?`<select id="af-sup">${opt('','None',a.supervisor)}${ppl.map(p=>opt(p.id,p.name,a.supervisor)).join('')}</select>`:`<div class="dc-hint">Add people to a mind map to pick a supervisor.</div>`}
    <label for="af-purpose">Purpose</label><textarea id="af-purpose" rows="3" maxlength="2000" placeholder="What this agent is responsible for">${esc(a.purpose)}</textarea>
    ${listEditor('inputs','Inputs','what it takes in',a.inputs)}
    ${listEditor('outputs','Outputs','what it produces',a.outputs)}
    ${listEditor('tools','Tools','what it may use',a.tools)}
    <div class="two"><div><label for="af-runtime">Runs on</label><input id="af-runtime" maxlength="200" placeholder="e.g. T3, home server" value="${esc(a.runtime)}"></div>
      <div><label for="af-model">Model</label><input id="af-model" maxlength="120" placeholder="optional" value="${esc(a.model)}"></div></div>
    <label for="af-instr">Instructions <em>system prompt or runbook</em></label><textarea id="af-instr" rows="7" maxlength="20000">${esc(a.instructions)}</textarea>
    ${linksHtml(a)}
    ${reps.length?`<label>Direct reports</label><ul class="links">${reps.map(r=>`<li><button type="button" data-agent-go="${esc(r.id)}">${icon(KIND_ICON[r.kind],12)}<span>${esc(r.name)}</span><em>${esc(r.title)}</em></button></li>`).join('')}</ul>`:''}
    ${flows.length?`<label>Workflows</label><ul class="links">${flows.map(w=>`<li><button type="button" data-flow-go="${esc(w.id)}">${icon('flow',12)}<span>${esc(w.name)}</span><em>step ${w.steps.map((s,i)=>s.agent===a.id?i+1:0).filter(Boolean).join(', ')}</em></button></li>`).join('')}</ul>`:''}
    </form>`;
}
function workflowHtml(w){
  const agents=[...af().agents].sort((x,y)=>x.name.localeCompare(y.name));
  return `<div class="ihead"><span class="k af-k">${icon('flow')}</span><strong>Workflow</strong><span class="sp"></span>
    ${ib('copy','Copy brief as Markdown\nFor the runner that does the work',{attrs:'data-afi="brief"'})}${ib('trash','Delete workflow',{key:keyLabel('agentflow.delete'),cls:'danger',attrs:'data-afi="delete"'})}${ib('x','Close',{key:keyLabel('global.escape'),attrs:'data-afi="close"'})}</div>
    <form id="afedit" class="ibody" autocomplete="off">
    <label for="af-name">Name</label><input id="af-name" maxlength="120" required value="${esc(w.name)}">
    <label for="af-desc">Description</label><textarea id="af-desc" rows="3" maxlength="4000" placeholder="What this workflow achieves">${esc(w.description)}</textarea>
    <div class="two"><div><label for="af-trigger">Trigger</label><select id="af-trigger">${Object.entries(TRIGGERS).map(([k,n])=>opt(k,n,w.trigger)).join('')}</select></div>
      <div><label for="af-wstatus">Status</label><select id="af-wstatus">${Object.entries(WORKFLOW_STATUS).map(([k,n])=>opt(k,n,w.status)).join('')}</select></div></div>
    ${w.trigger==='manual'?'':`<label for="af-sched">${w.trigger==='schedule'?'When':'On'}</label><input id="af-sched" maxlength="200" placeholder="${esc(TRIGGER_HINT[w.trigger])}" value="${esc(w.schedule)}">`}
    <label>Steps <em>in order</em></label>
    <ol class="af-step-list">${w.steps.map((s,i)=>`<li data-step="${esc(s.id)}"><em>${i+1}</em><div class="af-step-f">
      <select data-step-agent="${esc(s.id)}" aria-label="Step ${i+1} agent">${opt('','Unassigned',s.agent)}${agents.map(a=>opt(a.id,a.name,s.agent)).join('')}</select>
      <input data-step-action="${esc(s.id)}" id="af-act-${esc(s.id)}" maxlength="500" placeholder="What happens" value="${esc(s.action)}" aria-label="Step ${i+1} action">
      <input data-step-output="${esc(s.id)}" id="af-out-${esc(s.id)}" maxlength="300" placeholder="Output (optional)" value="${esc(s.output)}" aria-label="Step ${i+1} output"></div>
      <div class="af-step-b">${ib('chevU','Move up',{attrs:`data-step-up="${esc(s.id)}"${i?'':' disabled'}`})}${ib('chevD','Move down',{attrs:`data-step-down="${esc(s.id)}"${i<w.steps.length-1?'':' disabled'}`})}${ib('x','Remove step',{attrs:`data-step-del="${esc(s.id)}"`})}</div></li>`).join('')}</ol>
    <button type="button" class="txt af-addstep" data-afi="addStep">${icon('plus',13)}Add step</button>
    ${linksHtml(w)}
    </form>`;
}
export function renderInspector(pane){
  const x=sel();
  panel(pane,!!x,{onHidden:()=>{if(!sel())pane.innerHTML=''}});
  if(!x)return;
  // Keep focus and caret when the panel is redrawn after a change.
  const a=document.activeElement,keep=pane.contains(a)&&a.id?{id:a.id,s:a.selectionStart,e:a.selectionEnd}:null,top=pane.scrollTop;
  pane.innerHTML=selected.type==='agent'?agentHtml(x):workflowHtml(x);
  pane.scrollTop=top;
  const f=keep&&document.getElementById(keep.id);
  if(f){f.focus({preventScroll:true});try{if(keep.s!=null)f.setSelectionRange(keep.s,keep.e)}catch{}}
}
function addTo(key){
  const x=sel(),i=$('#af-new-'+key),v=i?.value.trim();if(!x||!v)return;
  const no=!x[key].includes(v)&&full(af(),'list',x,key);if(no){toast(no,true);return}
  change(()=>{if(!x[key].includes(v))x[key].push(v.slice(0,200));touch(x)});
  $('#af-new-'+key)?.focus();
}
export function inspectorClick(e){
  const b=e.target.closest('button');if(!b)return;
  const x=sel();if(!x)return;
  const pk=PICKERS[b.dataset.picker];
  if(pk){const [k,items,label]=pk;openPicker(b,{items:items(),selected:x[k],label,placeholder:`Search ${label.toLowerCase()}`,onChange(v){if(v.length>LIMITS.refs){toast(`Up to ${LIMITS.refs} linked ${k} each.`,true);rerender();return}change(()=>{x[k]=v;touch(x)})}});return}
  if(b.dataset.afKind){if(x.kind!==b.dataset.afKind)change(()=>{x.kind=b.dataset.afKind;touch(x)});return}
  if(b.dataset.afAdd){addTo(b.dataset.afAdd);return}
  if(b.dataset.afDel){const k=b.dataset.afDel,i=+b.dataset.i;change(()=>{x[k].splice(i,1);touch(x)});return}
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
const TEXT={'af-name':'name','af-title':'title','af-purpose':'purpose','af-runtime':'runtime','af-model':'model','af-instr':'instructions','af-desc':'description','af-sched':'schedule'};
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
  if(t.id==='af-status'||t.id==='af-wstatus')set('status',t.value);
  else if(t.id==='af-sup')set('supervisor',t.value);
  else if(t.id==='af-trigger')set('trigger',t.value);
  else if(t.id==='af-reports'){if(t.value===x.reportsTo)return;if(t.value&&descendants(af(),x.id).has(t.value)){rerender();return}set('reportsTo',t.value)}
  else if(t.dataset.stepAgent)change(()=>{const s=x.steps.find(y=>y.id===t.dataset.stepAgent);if(s)s.agent=t.value;touch(x)});
}
export function inspectorKey(e){
  if(e.key!=='Enter')return;
  const m=/^af-new-(\w+)$/.exec(e.target.id||'');
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
