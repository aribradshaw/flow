import {icon,makerIcon} from './icons.js';
import {$,esc,ib,hint,prop,choice,pickerButton,openPicker,pickerOpen,safeImg,personPhoto,personAvatar,photoImg,sessionPhotoNamed} from './ui.js';
import {panel,flipList,popIn,popOut} from './motion.js';
import {matches,keyLabel} from './shortcuts.js';
import {ask,detailModal} from './modal.js';
import {openMenu,menuOpen} from './menu.js';
import {store,change,checkpoint,commit,save} from './store.js';
import {clone} from './ui.js';
import {AGENT_KINDS,AGENT_STATUS,WORKFLOW_STATUS,TRIGGERS,TRIGGER_HINT,newAgent,newWorkflow,newStep,agentOf,reportsOf,rootsOf,setupSteps,JOBS_STALE,descendants,chainOf,
  removeAgent,full,LIMITS,workflowsFor,workFor,openWork,filterAgents,filterWorkflows,agentBrief,workflowBrief,starterAgentflow,peopleOf,personNamed,sameName,
  canReportTo,CARD,STACK,stacked,reportLines,pathOf,positions,placed,pin,unpin,workQueue,duplicateWorkflow,runnerOf,runLine,liveProblem,modelChoices,modelMaker,
  jobGroups,jobOf,promotedAgent,promoteJob,JOB_STATUS,JOB_SOURCES,JOB_ORIGINS,JOB_TRIGGERS,cardH} from './agentflow-core.js';
import {colorOf,initials,memberColor} from './devops-core.js';

// AgentFlow tab: an org chart of agents (AI agents, humans, teams) and the workflows they run,
// tied to Flow projects, DevOps cards and timeline items. Data rules live in agentflow-core.js;
// this module draws the org as a pan-and-zoom canvas (like the MindMap) and the workflow list,
// and edits the selection in the shared #inspector side panel.
const UIKEY='flygon-flow-agentflow-ui';
const KIND_ICON={agent:'bot',human:'user',team:'users',automation:'gear'},TRIGGER_ICON={manual:'play',schedule:'clock',event:'zap'};
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
  // A press outside the open job details (and outside the job rows, which switch them) closes them.
  document.addEventListener('pointerdown',e=>{if(jobPop&&!e.target.closest?.('.af-jpop,.af-tray [data-jid],.cm'))closeJob()},true);
  el.addEventListener('pointermove',canvasMove);
  el.addEventListener('pointerup',canvasUp);
  el.addEventListener('contextmenu',contextMenu);
  // Hovering a card highlights its reporting chain (only the highlight path is redrawn).
  el.addEventListener('pointerover',e=>{const id=!drag&&e.target.closest?.('#afCanvas [data-agent]')?.dataset.agent||null;if(id!==hoverId){hoverId=id;paintChain()}});
  el.addEventListener('pointerleave',()=>{if(hoverId){hoverId=null;paintChain()}});
  // A cancelled gesture (touch interrupted, capture lost) changes nothing.
  el.addEventListener('pointercancel',e=>{if(!drag||e.pointerId!==drag.pid)return;if(drag.mode==='job'){drag.moved=false;jobUp(e,drag)}drag=null;$('#afCanvas')?.classList.remove('panning');paint()});
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
// Split view (app.js): the org canvas follows its pane. A first fit waits until it has a width;
// pan(dx) keeps the org centred while the pane is resized.
export function resized(){if(!fitted&&ui.view==='org'&&$('#afCanvas')?.clientWidth)fit()}
export function pan(dx){if(!$('#afCanvas')?.clientWidth)return;view.x+=dx;paint()}
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
  return `<span class="meta">${plural(a,'agent')} · ${plural(w,'workflow')}</span>`;
}
function toolbar(){
  const view=(v,ic,label,sc)=>`<button type="button" class="${ui.view===v?'on':''}" data-af="view" data-v="${v}" data-tip="${label}" data-key="${esc(keyLabel(sc))}" aria-label="${label}" aria-pressed="${ui.view===v}">${icon(ic,14)}</button>`;
  return `<div class="tl-bar af-bar">
    <div class="seg txt" role="group" aria-label="View">${view('org','network','Org chart','agentflow.view1')}${view('workflows','flow','Workflows','agentflow.view2')}</div>
    ${ui.view==='org'?trayButton():''}
    <input id="af-q" type="search" placeholder="Search agents and workflows" value="${esc(ui.q)}" aria-label="Search agents and workflows">
    ${ui.q?`<button type="button" class="txt" data-af="clear">Clear</button>`:''}
    <button type="button" class="txt" data-af="addWorkflow" data-tip="New workflow" data-key="${esc(keyLabel('agentflow.addWorkflow'))}">${icon('plus',13)}Workflow</button>
    ${ib('plus','New agent',{key:keyLabel('agentflow.addAgent'),cls:'primary',attrs:'data-af="addAgent"'})}</div>`;
}
// A person's photo: their own, or the signed-in account's when the card is theirs (ui.js personPhoto).
const photo=n=>n?safeImg(personPhoto(n)):'';
// A human agent's face, {id, name, src} or null: the person it is linked to (its supervisor), else the
// one person card with its name, else (no person has that name) the signed-in user when it has theirs.
// Display only: nothing is linked or saved.
function humanFace(a){
  if(a.kind!=='human')return null;
  const sup=person(a.supervisor);if(sup)return {id:sup.id,name:sup.name,src:photo(sup)};
  const ppl=peopleOf(db()),p=personNamed(ppl,a.name);if(p)return {id:p.id,name:p.name,src:photo(p)};
  const src=!ppl.some(x=>sameName(x.name,a.name))&&safeImg(sessionPhotoNamed(a.name));
  return src?{id:a.id,name:a.name,src}:null;
}
// A face: the photo over initials on the member colour (initials show if the photo fails to load).
const faceHtml=(f,cls,tip)=>{const [bg,fg]=memberColor(f.id);
  return `<span class="${cls}${f.src?' has-photo':''}" style="background:${bg};color:${fg}" data-tip="${esc(tip)}"><span class="pa-txt">${esc(initials(f.name))}</span>${f.src?photoImg(f.src):''}</span>`};
const faceOf=n=>({id:n.id,name:n.name,src:photo(n)}),faceNode=f=>({id:f.id,name:f.name,image:f.src});
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
  if(a.kind==='automation')return autoNodeHtml(a,p,hits);
  const flows=workflowsFor(af(),a.id).length,open=openWork(db(),a),sup=person(a.supervisor);
  const isSel=selected?.type==='agent'&&selected.id===a.id,dim=hits&&!hits.has(a.id),drop=drag?.mode==='link'&&drag.over===a.id;
  const run=runLine(af(),a),live=a.kind==='agent'&&a.live,why=live&&liveProblem(af(),a),kind=AGENT_KINDS[a.kind],status=AGENT_STATUS[a.status];
  // A human agent is the person it is linked to (or named after, when that person has a photo);
  // anyone else shows its kind.
  const hf=humanFace(a),me=hf&&(hf.id===sup?.id||hf.src)?hf:null,rt=a.runtime.trim(),glyph=(rt||a.model.trim()).charAt(0).toUpperCase(),[gb,gf]=glyph?memberColor(rt.toLowerCase()||a.model):[];
  const avatar=me?faceHtml(me,'af-av',`${kind}: ${me.name}`):`<span class="af-av k" data-tip="${kind}">${icon(KIND_ICON[a.kind],15)}</span>`;
  const sched=a.schedule?.trim(),runTip=`${run||'No runner or model yet'}${sched?`\nSchedule: ${sched}`:''}\n${live?(why?`Live, but its runner will skip it: ${why}`:'Live: its runner works its queue'):'Not live: runners leave it alone'}`;
  return `<div class="af-node k-${a.kind} st-${a.status}${live?' live':''}${isSel?' sel':''}${dim?' dim':''}${drop?' drop':''}" data-agent="${esc(a.id)}" tabindex="0" role="button" aria-label="${esc(`${kind}: ${a.name}${a.title?`, ${a.title}`:''}. ${status}${live?', live':''}`)}" style="left:${p.x}px;top:${p.y}px">
    <i class="af-st" data-tip="Status: ${status}"></i>
    <div class="af-n-head"><span class="af-avw">${avatar}${sup&&!me?faceHtml(faceOf(sup),'af-sup',`Supervised by ${sup.name}`):''}</span><div class="af-n-id"><span class="nm" data-tip="${esc(a.name)}">${esc(a.name)}</span>
      <span class="af-n-role${a.title?'':' none'}"${a.title?` data-tip="${esc(a.title)}"`:''}>${esc(a.title||kind)}</span></div></div>
    ${a.kind==='agent'?`<div class="af-n-run${run?'':' none'}${why?' warn':''}" data-tip="${esc(runTip)}">${live?`<b>Live</b>`:''}${glyph?`<i class="af-g" style="background:${gb};color:${gf}">${icon(rt?'server':'cpu',10)}</i>`:''}<span>${esc(run||'No runner or model yet')}</span>${sched?`<i class="af-clk">${icon('clock',11)}</i>`:''}</div>`:''}
    <div class="af-n-foot"><span class="af-n-stats"><span data-tip="${plural(a.inputs.length,'input')} → ${plural(a.outputs.length,'output')}">${icon('arrowR',11)}${a.inputs.length}/${a.outputs.length}</span>
      ${flows?`<span data-tip="In ${plural(flows,'workflow')}">${icon('flow',11)}${flows}</span>`:''}
      ${open?`<span data-tip="${plural(open,'open card')}">${icon('branch',11)}${open}</span>`:''}
      </span>${modelMarks(a)}</div>
    <span class="af-port" data-port data-tip="Drag onto an agent to make it report here, or onto empty space for a new report" data-tip-delay="600"></span></div>`;
}
// An automation: a shorter, greyer card with a gear, its schedule on the run line and the status of
// the job it was promoted from. No models, no Live badge (it runs on its own schedule, outside Flow).
function autoNodeHtml(a,p,hits){
  const isSel=selected?.type==='agent'&&selected.id===a.id,dim=hits&&!hits.has(a.id),drop=drag?.mode==='link'&&drag.over===a.id,status=AGENT_STATUS[a.status];
  const sched=a.schedule.trim(),j=a.job&&jobOf(af(),a.job.runner,a.job.id),st=j?.lastStatus||'';
  const tip=`${sched?`Schedule: ${sched}`:'No schedule yet'}${a.job?`\n${j?`${a.job.runner} · ${j.name}${j.lastRun?`\nLast run ${rel(j.lastRun)}: ${JOB_STATUS[st]}`:''}${j.nextRun?`\nNext run ${rel(j.nextRun)}`:''}`:`${a.job.runner} no longer reports this job`}`:''}\nRuns on its own schedule, outside Flow`;
  return `<div class="af-node k-automation st-${a.status}${isSel?' sel':''}${dim?' dim':''}${drop?' drop':''}" data-agent="${esc(a.id)}" tabindex="0" role="button" aria-label="${esc(`Automation: ${a.name}${a.title?`, ${a.title}`:''}. ${status}${sched?`. ${sched}`:''}`)}" style="left:${p.x}px;top:${p.y}px">
    <i class="af-st" data-tip="Status: ${status}"></i>
    <div class="af-n-head"><span class="af-avw"><span class="af-av k" data-tip="Automation">${icon('gear',15)}</span></span><div class="af-n-id"><span class="nm" data-tip="${esc(a.name)}">${esc(a.name)}</span>
      <span class="af-n-role${a.title?'':' none'}"${a.title?` data-tip="${esc(a.title)}"`:''}>${esc(a.title||'Automation')}</span></div></div>
    <div class="af-n-run${sched?'':' none'}" data-tip="${esc(tip)}">${icon('clock',11)}<span>${esc(sched||'No schedule yet')}</span>${st?`<i class="af-jdot s-${st}"></i>`:''}</div>
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
const canvasHtml=()=>`<div id="afCanvas" class="af-canvas" aria-label="AgentFlow org canvas"><div class="af-world" style="--af-w:${CARD.w}px;--af-h:${CARD.h}px;--af-ha:${CARD.auto}px"><svg class="af-edges" aria-hidden="true"></svg><div class="af-nodes"></div></div></div>
  <div class="float af-zoom" role="toolbar" aria-label="Zoom"></div><div class="af-empty-wrap" hidden></div><aside class="af-tray" aria-label="Scheduled jobs" hidden></aside><div class="af-jpop" role="dialog" aria-label="Job details" tabindex="-1" hidden></div>`;
function paintZoom(){
  const z=$('#agentflowView .af-zoom');if(!z)return;
  z.innerHTML=ib('minus','Zoom out',{key:keyLabel('agentflow.zoomOut'),attrs:'data-afz="out" data-tip-pos="top"'})+`<button type="button" class="af-scale" data-afz="reset" data-tip="Reset to 100%" data-tip-pos="top">${Math.round(view.z*100)}%</button>`
    +ib('plus','Zoom in',{key:keyLabel('agentflow.zoomIn'),attrs:'data-afz="in" data-tip-pos="top"'})+ib('fit','Fit the org',{key:keyLabel('agentflow.fit'),attrs:'data-afz="fit" data-tip-pos="top"'})
    +'<i class="sep"></i>'+ib('network','Tidy up\nArrange as a tree again',{attrs:'data-afz="tidy" data-tip-pos="top"'})
    +ib('info','Drag a card to move it (Shift: with its reports, Alt: off the grid)\nDrag the dot under a card onto another agent to make that agent report to it,\nor onto empty space to add a new report\nDouble-click empty space to add an agent\nArrow keys nudge the selected agent',{label:'How the canvas works',attrs:'data-tip-pos="top"'});
}
// ---------- the Scheduled tray: jobs runners reported, to promote into the org ----------
// Docked on the left of the canvas. Drawn by render() only while open (never per canvas frame), and
// its HTML is only replaced when it changed (t.drawn: the HTML it holds), so hover and scroll
// survive unrelated redraws.
// ui.tray: open or not; ui.jobGroups: {groupKey: open} for the groups someone opened or closed.
const BIG_GROUP=8;
const JOB_ICON={systemd:'timer',cron:'cron',vercel:'cloud',railway:'cloud',t3:'bot',claude:'sparkle',codex:'sparkle',github:'branch',windows:'laptop',aside:'clock',other:'clock'};
const jobIcon=j=>JOB_ICON[String(j.source||'').toLowerCase()]||'clock';
const sourceName=j=>JOB_SOURCES[String(j.source||'').toLowerCase()]||j.source||'Scheduled job';
// A time relative to now: "3 h ago", "in 20 min".
function rel(iso){
  const t=Date.parse(iso);if(!Number.isFinite(t))return '';
  const s=(t-Date.now())/1000,a=Math.abs(s),v=a<90?'':a<5400?`${Math.round(a/60)} min`:a<129600?`${Math.round(a/3600)} h`:`${Math.round(a/86400)} days`;
  return !v?(s<0?'just now':'in a moment'):s<0?`${v} ago`:`in ${v}`;
}
// Time zones. A job's zone: its timezone ("UTC", an IANA name), "local" read as its runner's zone when
// the runner reported one, '' when not reported. The row names the zone only when it is not the
// viewer's own and the schedule has a time of day that does not already say it.
const viewerZone=(()=>{try{return Intl.DateTimeFormat().resolvedOptions().timeZone||''}catch{return ''}})();
const jobZone=j=>{const z=j.timezone||'';return z==='local'?runnerOf(af(),j.runner)?.timezone||'local':z};
function zoneShort(z,at=Date.now()){
  if(!z||z==='local'||z==='UTC')return z;
  try{return new Intl.DateTimeFormat('en-US',{timeZone:z,timeZoneName:'short'}).formatToParts(new Date(at)).find(p=>p.type==='timeZoneName')?.value||z}catch{return z}
}
function zoneTag(j){
  const z=jobZone(j),s=j.schedule||'';
  if(!z||z==='local'||z===viewerZone||!/\d:\d\d/.test(s))return '';
  const t=zoneShort(z);return s.includes(t)||s.includes(z)?'':t;
}
// "Nov 2, 15:30 MST", and in the job's zone too when that is another one.
function when(iso,z){
  const t=Date.parse(iso);if(!Number.isFinite(t))return '';
  const o={month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',hourCycle:'h23',timeZoneName:'short'},f=zz=>{try{return new Intl.DateTimeFormat('en-US',{...o,...(zz?{timeZone:zz}:{})}).format(new Date(t))}catch{return ''}};
  const there=z&&z!=='local'&&z!==viewerZone?f(z):'';
  return f('')+(there&&there!==f('')?` · ${there}`:'');
}
const jobTip=j=>[j.lastRun?`Last run ${rel(j.lastRun)}: ${JOB_STATUS[j.lastStatus]}`:`Last run: ${j.lastStatus==='unknown'?'not reported':JOB_STATUS[j.lastStatus]}`,j.nextRun?`Next run ${rel(j.nextRun)}`:'',j.enabled?'':'Disabled on the runner'].filter(Boolean).join('\n');
const jobCount=()=>(af().runners||[]).reduce((n,r)=>n+(r.jobs?.length||0),0);
function trayButton(){
  const n=jobCount();
  return `<button type="button" class="txt af-tray-b${ui.tray?' on':''}" data-af="tray" aria-pressed="${!!ui.tray}" data-tip="${ui.tray?'Hide':'Show'} scheduled jobs" aria-label="Scheduled jobs${n?`: ${n}`:''}">${icon('clock',13)}${n?`<em>${n}</em>`:''}</button>`;
}
const groupOpen=g=>typeof ui.jobGroups?.[g.key]==='boolean'?ui.jobGroups[g.key]:g.jobs.length<=BIG_GROUP;
const jobKey=(runner,id)=>`${runner.toLowerCase()}\u0001${id}`;
// The job whose details are open (a popover beside the tray): {runner, id}, or null.
let jobPop=null;
const popOf=(runner,id)=>!!jobPop&&jobPop.id===id&&jobPop.runner.toLowerCase()===String(runner).toLowerCase();
function jobRow(j,promoted){
  const by=promoted.get(jobKey(j.runner,j.id)),tag=zoneTag(j),open=popOf(j.runner,j.id);
  return `<li class="af-job${j.enabled?'':' off'}${by?' done':''}${open?' open':''}" data-jr="${esc(j.runner)}" data-jid="${esc(j.id)}">
    <span class="af-job-ic" data-tip="${esc(sourceName(j))}">${icon(jobIcon(j),13)}</span>
    <span class="af-job-m"><b data-tip="${esc(`${j.name}${j.command?`\n${j.command}`:''}\nClick for the full schedule`)}">${esc(j.name)}</b>${j.ai?`<i class="af-job-ai" data-tip="Starts an AI agent">${icon('sparkle',10)}</i>`:''}<span class="af-job-s"><small>${esc(j.schedule||j.cron||'No schedule reported')}${tag?`<em class="af-tz" data-tip="${esc(`Times in ${jobZone(j)}`)}">${esc(tag)}</em>`:''}${j.drift?`<i class="af-jdrift" data-tip="${esc(`Drift: ${j.drift}`)}" aria-label="Schedule drift"></i>`:''}</small>${by?`<button type="button" class="af-job-done" data-af="goAgent" data-id="${esc(by.id)}" data-tip="${esc(`In the org as ${by.name}`)}">${icon('check',10)}Promoted</button>`:''}</span></span>
    <i class="af-jdot s-${j.lastStatus}" data-tip="${esc(jobTip(j))}" aria-label="${esc(JOB_STATUS[j.lastStatus])}"></i>
    <span class="af-job-acts"><button type="button" class="af-job-i" data-af="jinfo" aria-expanded="${open}" aria-label="Schedule details" data-tip="Schedule details">${icon('info',12)}</button>${by?'':`<button type="button" class="af-job-go" data-af="promote" data-tip="Add to the org (top level).\nOr drag it onto an agent to report there">Promote</button>`}</span></li>`;
}
function trayHtml(){
  const all=jobGroups(af()),total=all.reduce((n,g)=>n+g.jobs.length,0);
  const q=ui.q.trim().toLowerCase(),hit=j=>[j.name,j.schedule,j.command||'',j.group||'',j.source,j.cron||'',j.timezone||'',j.file||'',j.note||'',j.drift||'',...(j.triggers||[]).map(t=>t.expr||'')].some(x=>x.toLowerCase().includes(q));
  const groups=q?all.map(g=>({...g,jobs:g.jobs.filter(hit)})).filter(g=>g.jobs.length):all;
  const promoted=new Map(af().agents.filter(a=>a.job).map(a=>[jobKey(a.job.runner,a.job.id),a]));
  const head=`<div class="af-tray-h">${icon('clock',13)}<strong>Scheduled</strong><em>${total?plural(total,'job'):''}</em><span class="sp"></span>${ib('x','Hide scheduled jobs',{attrs:'data-af="tray"'})}</div>`;
  if(!total)return head+`<div class="af-tray-e">${icon('timer',22)}<strong>No scheduled jobs yet</strong><p>Runners report the timers, cron jobs and scheduled functions they find (runners.report with <code>jobs</code>). They show up here, and you can promote any of them into the org.</p></div>`;
  const body=groups.map(g=>{
    const open=q||groupOpen(g),failed=g.jobs.filter(j=>j.lastStatus==='failed').length,done=g.jobs.filter(j=>promoted.has(jobKey(j.runner,j.id))).length;
    const srcs=new Set(g.jobs.map(jobIcon)),ic=srcs.size===1?[...srcs][0]:'server';
    return `<section class="af-jg${open?' open':''}"><button type="button" class="af-jg-h" data-af="jgroup" data-k="${esc(g.key)}" aria-expanded="${!!open}"><i class="af-jg-c">${icon('chevD',11)}</i>${icon(ic,12)}<span class="af-jg-l">${esc(g.label)}</span>${g.label!==g.runner?`<small>${esc(g.runner)}</small>`:''}
      ${failed?`<span class="af-jg-f" data-tip="${plural(failed,'job')} failed on the last run">${failed}</span>`:''}<span class="af-jg-n">${g.jobs.length}</span></button>
      ${open?`<ul class="af-jobs">${g.jobs.map(j=>jobRow(j,promoted)).join('')}</ul>`
        :`<button type="button" class="af-jg-chip" data-af="jgroup" data-k="${esc(g.key)}">${icon('list',11)}${plural(g.jobs.length,'job')}${failed?` · <b>${failed} failed</b>`:''}${done?` · ${done} promoted`:''}</button>`}</section>`;
  }).join('');
  return head+`<div class="af-tray-l">${body||'<p class="af-none">No jobs match.</p>'}</div><div class="af-tray-f">Drag a job onto an agent to report there, or onto the canvas</div>`;
}
function paintTray(){
  const t=$('#agentflowView .af-tray');if(!t)return;
  t.hidden=!ui.tray;
  const cv=$('#afCanvas');if(ui.tray&&cv)t.style.top=cv.offsetTop+10+'px';
  if(!ui.tray){if(t.drawn){t.innerHTML='';t.drawn=''}return}
  const html=trayHtml();
  if(html!==t.drawn){
    const top=t.querySelector('.af-tray-l')?.scrollTop||0;
    t.innerHTML=html;t.drawn=html;const l=t.querySelector('.af-tray-l');if(l){l.scrollTop=top;l.addEventListener('scroll',placePop,{passive:true})}
  }
  paintPop();
}
// ---------- job details: the full schedule, where it was read, and what the runner knows ----------
// Shared by the tray's popover and the side panel's "Promoted from". j has its runner's name.
const ORIGIN_ICON={repo:'branch',platform:'cloud',machine:'server'};
function jobTriggers(j){
  const ts=j.triggers?.length?j.triggers:j.cron?[{kind:'cron',expr:j.cron,text:j.schedule}]:[];
  if(!ts.length)return '<span class="af-dim">None reported</span>';
  return `<ul class="af-trigs">${ts.map(t=>`<li><span class="af-tk">${esc(JOB_TRIGGERS[t.kind]||t.kind)}</span>${t.text?`<span class="af-tt">${esc(t.text)}</span>`:''}${t.expr?`<code>${esc(t.expr)}</code>`:''}</li>`).join('')}</ul>`;
}
function zoneHtml(j){
  const z=jobZone(j),r=runnerOf(af(),j.runner);
  if(!z)return '<span class="af-dim">Not reported</span>';
  if(z==='local')return `Local time on ${esc(j.runner)} <span class="af-dim">(zone not reported)</span>`;
  const s=zoneShort(z);
  return `<b>${esc(z)}</b>${s&&s!==z?` <span class="af-dim">${esc(s)}</span>`:''}${j.timezone==='local'||(r?.timezone&&r.timezone===z&&z!=='UTC')?` <span class="af-dim">· ${esc(j.runner)}'s zone</span>`:''}${z!==viewerZone&&viewerZone?` <span class="af-dim">· you: ${esc(zoneShort(viewerZone))}</span>`:''}`;
}
function originHtml(j){
  if(!j.origin)return j.file?`<code>${esc(j.file)}</code>`:'';
  const t={repo:'Read from a config file in the repo',platform:'Read from the hosting platform\'s live settings',machine:'Read from the machine\'s own scheduler'}[j.origin];
  return `<span class="af-orig o-${j.origin}" data-tip="${esc(t)}">${icon(ORIGIN_ICON[j.origin],10)}${esc(JOB_ORIGINS[j.origin])}</span>${j.file?` <code>${esc(j.file)}</code>`:''}`;
}
const timeHtml=(iso,z)=>iso?`<span>${esc(rel(iso))}</span><small class="af-when">${esc(when(iso,z))}</small>`:'';
function jobDetails(j){
  const row=(k,v,cls='')=>v?`<dt>${k}</dt><dd${cls?` class="${cls}"`:''}>${v}</dd>`:'',z=jobZone(j);
  const [bg,fg]=colorOf({ok:'green',failed:'red',running:'blue'}[j.lastStatus]||'slate');
  return `${j.drift?`<div class="af-drift">${icon('alert',12)}<span><b>Drift</b> ${esc(j.drift)}</span></div>`:''}<dl>
    ${row('Schedule',`<b>${esc(j.schedule||'No schedule reported')}</b>`)}${row('Triggers',jobTriggers(j))}${row('Time zone',zoneHtml(j))}
    ${row('Origin',originHtml(j))}${row('Note',j.note?esc(j.note):'')}${row('Runs',j.command?`<code>${esc(j.command)}</code>`:'')}
    ${row('Last run',`<span class="pill" style="background:${bg};color:${fg}">${esc(JOB_STATUS[j.lastStatus])}</span>${j.lastRun?` ${timeHtml(j.lastRun,z)}`:''}`)}
    ${row('Next run',j.nextRun?timeHtml(j.nextRun,z):j.enabled?'<span class="af-dim">Not reported</span>':'')}
    ${row('Source',esc(`${sourceName(j)} · ${j.runner}${j.group&&j.group!==j.runner?` · ${j.group}`:''}`))}
    ${row('Flags',`<span class="af-flag${j.enabled?' on':''}">${j.enabled?'Enabled':'Disabled on the runner'}</span>${j.ai?`<span class="af-flag ai">${icon('sparkle',10)}Starts an AI agent</span>`:'<span class="af-flag">No AI</span>'}`)}</dl>`;
}
function popHtml(j){
  const by=promotedAgent(af(),j.runner,j.id);
  return `<div class="af-jpop-h">${icon(jobIcon(j),14)}<div><b>${esc(j.name)}</b><small>${esc(sourceName(j))} · ${esc(j.runner)}</small></div><span class="sp"></span>${ib('x','Close',{attrs:'data-af="jclose"'})}</div>
    <div class="af-jobinfo af-jpop-b">${jobDetails(j)}</div>
    <div class="af-jpop-f">${by?`<button type="button" class="txt" data-af="goAgent" data-id="${esc(by.id)}">${icon('check',12)}In the org as ${esc(by.name)}</button>`
      :`<button type="button" class="txt primary-txt" data-af="promote">${icon('plus',12)}Promote to org</button>`}</div>`;
}
const rowOf=(runner,id)=>[...document.querySelectorAll('#agentflowView .af-tray [data-jid]')].find(r=>r.dataset.jid===id&&r.dataset.jr.toLowerCase()===runner.toLowerCase())||null;
function paintPop(){
  const p=$('#agentflowView .af-jpop');if(!p)return;
  const j=jobPop&&ui.tray?jobOf(af(),jobPop.runner,jobPop.id):null,row=j&&rowOf(jobPop.runner,jobPop.id);
  if(!j||!row){if(jobPop&&(!j||!ui.tray))jobPop=null;p.hidden=true;if(p.drawn){p.innerHTML='';p.drawn=''}return}
  const runner=runnerOf(af(),jobPop.runner)?.name||jobPop.runner,html=popHtml({...j,runner});
  p.dataset.jr=runner;p.dataset.jid=j.id;
  if(html!==p.drawn){p.innerHTML=html;p.drawn=html}
  p.hidden=false;placePop();
}
// Beside the tray, level with the job's row (inside the view, over the tray when there is no room).
function placePop(){
  const p=$('#agentflowView .af-jpop'),v=$('#agentflowView'),t=$('#agentflowView .af-tray');if(!p||p.hidden||!jobPop||!t)return;
  const row=rowOf(jobPop.runner,jobPop.id);if(!row)return;
  const V=v.getBoundingClientRect(),T=t.getBoundingClientRect(),R=row.getBoundingClientRect(),w=p.offsetWidth,h=p.offsetHeight;
  const room=V.right-T.right-16>=w,left=room?T.right-V.left+8:Math.max(8,T.left-V.left+12);
  const top=Math.max(T.top-V.top,Math.min(R.top-V.top-10,V.height-h-10));
  p.style.left=left+'px';p.style.top=Math.max(8,top)+'px';
  p.classList.toggle('over',!room);
}
function toggleJob(runner,id){
  jobPop=popOf(runner,id)?null:{runner,id};
  paintTray();
  if(jobPop)$('#agentflowView .af-jpop')?.focus({preventScroll:true});
}
function closeJob(){if(!jobPop)return false;const k=jobPop;jobPop=null;paintTray();rowOf(k.runner,k.id)?.querySelector('[data-af=jinfo]')?.focus({preventScroll:true});return true}
// Promote a job (promoteJob): select the new agent and open its side panel. One undo step. A job
// already in the org selects the agent it became instead.
function promote(runner,jobId,opts={}){
  const had=promotedAgent(af(),runner,jobId);
  if(had){toast(`Already in the org as ${had.name}`);centerOn=had.id;select('agent',had.id);return}
  if(!jobOf(af(),runner,jobId))return;
  const no=full(af(),'agents');if(no){toast(no,true);return}
  // Placed automatically (no drop point): bring it into view.
  change(()=>{const a=promoteJob(af(),runner,jobId,opts);if(a){selected={type:'agent',id:a.id};if(opts.x===undefined)centerOn=a.id}});
}
const jobAt=el=>{const r=el?.closest('[data-jid]');return r?{runner:r.dataset.jr,id:r.dataset.jid}:null};
// A job dragged out of the tray: a ghost follows the pointer and the agent card under it lights up
// (classes set directly, no canvas repaint).
function jobMove(e){
  const d=drag;
  if(!d.moved){if(Math.abs(e.clientX-d.sx)+Math.abs(e.clientY-d.sy)<=4)return;d.moved=true;
    const g=document.createElement('div');g.className='af-jghost';g.innerHTML=`${icon(d.icon,13)}<span>${esc(d.name)}</span><em></em>`;document.body.append(g);d.ghost=g;document.body.classList.add('af-jdrag')}
  d.ghost.style.transform=`translate(${e.clientX+12}px,${e.clientY+10}px)`;
  const hit=document.elementFromPoint(e.clientX,e.clientY),card=hit?.closest('#afCanvas [data-agent]'),over=card?.dataset.agent||null;
  if(over!==d.over){d.card?.classList.remove('drop');d.over=over;d.card=card;card?.classList.add('drop')}
  d.canvas=!!hit?.closest('#afCanvas')&&!over;
  d.ghost.classList.toggle('off',!over&&!d.canvas);
  d.ghost.querySelector('em').textContent=over?`reports to ${agent(over)?.name||''}`:d.canvas?'top level, here':'';
}
function jobUp(e,d){
  d.ghost?.remove();d.card?.classList.remove('drop');document.body.classList.remove('af-jdrag');
  // A click (no drag) on a row opens or closes its details.
  if(!d.moved){if(e.type==='pointerup')toggleJob(d.runner,d.id);return}
  if(d.over){promote(d.runner,d.id,{reportsTo:d.over});return}
  if(d.canvas){const p=toWorld(e);promote(d.runner,d.id,{x:snap(p.x-CARD.w/2),y:snap(p.y-CARD.h/2)})}
}
function jobMenu(e,runner,jobId){
  const j=jobOf(af(),runner,jobId);if(!j)return;
  const by=promotedAgent(af(),runner,jobId),s=selected?.type==='agent'?agent(selected.id):null;
  openMenu(e,by?[{label:`Show ${by.name} in the org`,icon:KIND_ICON[by.kind],run:()=>{centerOn=by.id;select('agent',by.id)}}]:[
    {label:'Promote to org',icon:'plus',run:()=>promote(runner,jobId)},
    ...(s?[{label:`Promote under ${s.name}`,icon:KIND_ICON[s.kind],run:()=>promote(runner,jobId,{reportsTo:s.id})}]:[]),
  ],{label:`Job: ${j.name}`});
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
  const x0=Math.min(...ps.map(p=>p.x)),y0=Math.min(...ps.map(p=>p.y)),w=Math.max(...ps.map(p=>p.x))+CARD.w-x0,h=Math.max(...ps.map(p=>p.y))+CARD.h-y0,pad=56,l=trayInset(),W=cv.clientWidth-l;
  view.z=Math.max(.2,Math.min(1,(W-pad*2)/w,(cv.clientHeight-pad*2)/h));
  view.x=l+(W-w*view.z)/2-x0*view.z;view.y=(cv.clientHeight-h*view.z)/2-y0*view.z;
  paint();
}
// The canvas width the open Scheduled tray covers (fit and centring leave it clear).
const trayInset=()=>{const t=ui.tray&&$('#agentflowView .af-tray');return t&&!t.hidden&&t.offsetWidth?t.offsetLeft+t.offsetWidth:0};
function zoom(f,x,y){
  const cv=$('#afCanvas');if(!cv)return;x??=cv.clientWidth/2;y??=cv.clientHeight/2;
  const z=Math.max(.2,Math.min(2.5,view.z*f));
  view.x=x-(x-view.x)*z/view.z;view.y=y-(y-view.y)*z/view.z;view.z=z;paint();
}
// Bring an agent into view (opened from a DevOps card) without changing the zoom.
function tidy(){if(af().agents.some(placed))change(()=>unpin(af()));requestAnimationFrame(fit)}
function center(id){
  const cv=$('#afCanvas'),p=positions(af()).get(id);if(!cv?.clientWidth||!p)return;
  const l=trayInset();view.x=l+(cv.clientWidth-l)/2-(p.x+CARD.w/2)*view.z;view.y=cv.clientHeight/2-(p.y+CARD.h/2)*view.z;paint();
}
const toWorld=e=>{const r=$('#afCanvas').getBoundingClientRect();return {x:(e.clientX-r.left-view.x)/view.z,y:(e.clientY-r.top-view.y)/view.z}};

// ---------- canvas gestures ----------
// Card: move (Shift carries its reports along). Dot under a card: link to a new manager's report.
// Empty space: pan. Every finished change is one undo step.
function canvasDown(e){
  // A job row in the Scheduled tray: drag it onto an agent or the canvas to promote it.
  const row=e.button===0&&!e.target.closest('button')&&e.target.closest('.af-tray [data-jid]');
  if(row){const j=jobAt(row),job=jobOf(af(),j.runner,j.id);if(!job)return;
    drag={mode:'job',...j,name:job.name,icon:jobIcon(job),sx:e.clientX,sy:e.clientY,pid:e.pointerId};e.currentTarget.setPointerCapture(e.pointerId);return}
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
  if(drag.mode==='job'){jobMove(e);return}
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
  if(d.mode==='job'){jobUp(e,d);return}
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
    paintZoom();paint();paintTray();
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
    tray(){ui.tray=!ui.tray;keepUi();render()},
    jgroup(){const g=jobGroups(af()).find(x=>x.key===b.dataset.k);if(!g)return;ui.jobGroups={...ui.jobGroups,[g.key]:!groupOpen(g)};keepUi();paintTray()},
    promote(){const j=jobAt(b);if(j){jobPop=null;promote(j.runner,j.id)}},
    jinfo(){const j=jobAt(b);if(j)toggleJob(j.runner,j.id)},
    jclose(){closeJob()},
    goAgent(){const id=b.dataset.id;if(agent(id)){if(b.closest('.af-jpop'))jobPop=null;centerOn=id;select('agent',id)}},
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
  const jr=e.target.closest('.af-tray [data-jid]');
  if(jr){e.preventDefault();if(!drag){const j=jobAt(jr);jobMenu(e,j.runner,j.id)}return}
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
  change(()=>{x[k]=v;if(k==='kind'&&v==='automation')x.live=false;touch(x)});
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
      ...(ok.length>shown.length?['-',{label:'More in the side panel…',run(){ui.tab='org';keepUi();select('agent',id);requestAnimationFrame(()=>$('#af-reports')?.click())}}]:[])]},
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
// A sticky block (header, name, role, Live, kind, status, setup, warnings, tab bar), then the tabs of
// an agent, or a workflow's steps. All tab panels are in the DOM, hidden when inactive, so every field
// id stays. Remembered in localStorage: the active tab in ui.tab, open sections in ui.sec, favourite
// models in ui.fav.
const SEC_OPEN={links:false};
const secOpen=k=>typeof ui.sec?.[k]==='boolean'?ui.sec[k]:SEC_OPEN[k]??true;
function sec(k,ic,title,body,meta=''){
  const open=secOpen(k);
  return `<section class="af-sec${open?' open':''}"><h3 class="af-sec-t"><button type="button" class="af-sec-h" id="af-sec-${k}" data-af-sec="${k}" aria-expanded="${open}" aria-controls="af-secb-${k}">${icon(ic,13)}<span>${title}</span>${meta?`<em>${meta}</em>`:''}<i class="af-chev">${icon('chevD',12)}</i></button></h3>
    <div class="af-sec-b" id="af-secb-${k}"${open?'':' hidden'}>${body}</div></section>`;
}
const ago=iso=>{const s=(Date.now()-Date.parse(iso))/1000;if(!Number.isFinite(s))return '';if(s<90)return 'just now';if(s<5400)return `${Math.round(s/60)} min ago`;if(s<129600)return `${Math.round(s/3600)} h ago`;return `${Math.round(s/86400)} days ago`};
const personAv=p=>{const [bg,fg]=memberColor(p.id);return {text:initials(p.name),bg,fg,img:photo(p)}};
const bub=(p,cls='')=>personAvatar(p,{cls});
// The agent's face: its own image (if it ever has one), a human's face photo (humanFace), else its kind
// icon; its supervisor on the corner unless the face is theirs. A photo that fails shows initials.
function avatarHtml(a){
  const sup=person(a.supervisor),hf=humanFace(a),img=safeImg(a.image)||hf?.src||'';
  const face=img?`<span class="pa-txt">${esc(initials(hf?.name||a.name))}</span>${photoImg(img)}`:icon(KIND_ICON[a.kind],20);
  return `<span class="af-av k-${a.kind}${img?' has-photo':''}" data-tip="${AGENT_KINDS[a.kind]}">${face}${sup&&!(hf&&hf.id===sup.id&&img)?bub(sup,'af-av-sup'):''}</span>`;
}
// A picker or button lead for an agent: a human's face photo, else its kind icon.
const agentAv=x=>{const f=humanFace(x);if(!f?.src)return null;const [bg,fg]=memberColor(f.id);return {text:initials(f.name),bg,fg,img:f.src}};
// Status as a one-click choice with a coloured dot, for agents and workflows.
const statusChoice=(cur,names,tips)=>choice('af-status',Object.entries(names).map(([k,n])=>({value:k,label:n,tip:`${n}: ${tips[k]}`,lead:`<i class="dot" style="--pf:${colorOf(STATUS_TONE[k]||'slate')[1]}"></i>`})),cur,{label:'Status',idp:'af-st'});
// A single-select picker trigger (ui.js openPicker) that shows the current choice.
const selBtn=(key,label,text,lead='',{none=false,disabled=false}={})=>`<button type="button" class="pk-btn af-sel${none?' none':''}" id="${key}" data-picker="${key}" aria-haspopup="listbox" aria-expanded="${pickerOpen(key)}" aria-label="${esc(`${label}: ${text}`)}"${disabled?' disabled':''}>${lead}<span class="pk-t">${esc(text)}</span>${icon('chevD',12)}</button>`;
// Inputs, outputs and tools: chips with ×, and an inline field that adds on Enter. The full text is
// in the chip's tip and in its remove button's name.
const chipHtml=(key,one,v,i)=>`<span class="af-chip" data-tip="${esc(v)}"><span>${esc(v)}</span><button type="button" id="af-del-${key}-${i}" data-af-del="${key}" data-i="${i}" data-tip="${esc(`Remove ${one}: ${v}`)}" aria-label="${esc(`Remove ${one}: ${v}`)}">${icon('x',10)}</button></span>`;
const newChip=(key,one,placeholder)=>`<input id="af-new-${key}" maxlength="200" placeholder="${placeholder}" aria-label="New ${one}">`;
// What goes in, the agent, what comes out: two columns of chips joined by CSS connectors.
function pipelineHtml(a){
  const they=a.kind==='human'||a.kind==='team';
  const head=(key,label,ic,tip)=>`<div class="af-ph af-ph-${key}"><label for="af-new-${key}">${icon(ic,12)}${label}</label>${hint(tip,label)}</div>`;
  // An empty column has just its add field, on the connector.
  const add=(key,one)=>`<div class="af-padd af-padd-${key}">${newChip(key,one,`Add ${one}`)}</div>`;
  const list=(key,one,values)=>`<div class="af-plist af-plist-${key}">${values.map((v,i)=>chipHtml(key,one,v,i)).join('')||add(key,one)}</div>`;
  return `<div class="af-pipe">
    ${head('inputs','Inputs','inbox',they?'What they take in':'What it takes in')}${head('outputs','Outputs','send',they?'What they produce':'What it produces')}
    ${list('inputs','input',a.inputs)}<div class="af-pmid" aria-hidden="true"><span>${icon(KIND_ICON[a.kind],13)}</span></div>${list('outputs','output',a.outputs)}
    ${a.inputs.length?add('inputs','input'):''}${a.outputs.length?add('outputs','output'):''}</div>`;
}
function toolsHtml(a){
  const they=a.kind==='human'||a.kind==='team';
  return `<div class="af-ph af-ph-tools"><label for="af-new-tools">${icon('wrench',12)}Tools</label>${hint(they?'What they may use':'What it may use','Tools')}</div>
    <div class="af-chips">${a.tools.map((v,i)=>chipHtml('tools','tool',v,i)).join('')}${newChip('tools','tool',a.tools.length?'Add…':'Add tool, then Enter')}</div>`;
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
const WORDS={agent:{purpose:'What this agent is responsible for',instr:'System prompt or runbook'},
  human:{purpose:'What this person is responsible for',instr:'How this person works, or a runbook'},
  team:{purpose:'What this team is responsible for',instr:'How this team works, or a runbook'},
  automation:{purpose:'What this automation does',instr:'Runbook: what it runs and what to check'}};
const KIND_TIP={agent:'AI agent: works cards through a runner',human:'Human: a person in the org',team:'Team: a group with its own reports',automation:'Automation: a scripted job without AI, on its own schedule'};
const STATUS_TIP={draft:'still being set up',active:'in use',paused:'on hold',retired:'no longer used'};
const AI_STATUS_TIP={...STATUS_TIP,paused:'on hold. A label only: runners go by Live',retired:'no longer used. A label only: runners go by Live'};
const FLOW_STATUS_TIP={draft:'still being written',active:'in use',paused:'on hold'};
const TRIGGER_TIP={manual:'Manual: someone starts it',schedule:'Schedule: at a set time',event:'Event: when something happens'};
const lineCount=t=>{const s=String(t||'').trim();return s?s.split('\n').length:0};
// ---------- tabs ----------
// Humans and teams have no Run tab. The remembered tab wins while the kind has it; with none
// remembered, an AI agent still being set up opens on Run.
const tabsFor=a=>a.kind==='human'||a.kind==='team'?['job','org','links']:['job','run','org','links'];
function activeTab(a){
  // Settle the default once, so finishing setup mid-edit does not flip the panel to another tab.
  if(!ui.tab)ui.tab=setupSteps(af(),a).some(s=>!s.done)?'run':'job';
  return tabsFor(a).includes(ui.tab)?ui.tab:'job';
}
// Each tab's word, icon, short badge and full summary (tip and accessible name).
function tabInfo(a){
  const reps=reportsOf(af(),a.id).length,flows=workflowsFor(af(),a.id).length,ms=modelsOf(a).length,links=linkCount(a),lines=lineCount(a.instructions),mgr=agent(a.reportsTo);
  const sch=a.schedule.trim(),auto=a.kind==='automation',job=a.job&&jobOf(af(),a.job.runner,a.job.id);
  return {
    job:{word:'Job',ic:'target',badge:a.inputs.length||a.outputs.length?`${a.inputs.length}·${a.outputs.length}`:'',
      text:`${a.inputs.length} in · ${a.outputs.length} out · ${plural(a.tools.length,'tool')} · ${lines?plural(lines,'line'):'no lines'} of instructions`},
    run:auto?{word:'Schedule',ic:'clock',badge:job?`<i class="af-jdot s-${esc(job.lastStatus)}"></i>`:'',text:`${sch||'No schedule set'}${a.job?` · job on ${a.job.runner}`:''}`}
      :{word:'Run',ic:'server',badge:ms?String(ms):'',text:`${a.runtime.trim()||'No runner'} · ${plural(ms,'model')}${sch?` · ${sch}`:''}`},
    org:{word:'Org',ic:'network',badge:reps+flows?String(reps+flows):'',text:`Reports to ${mgr?mgr.name:'nobody'} · ${plural(reps,'direct report')} · ${plural(flows,'workflow')}`},
    links:{word:'Links',ic:'link',badge:links?String(links):'',text:`${plural(a.projects.length,'project')} · ${plural(a.cards.length,'card')} · ${plural(a.items.length,'timeline item')}`},
  };
}
function tabBar(a,cur){
  const info=tabInfo(a);
  return `<div class="af-tabs" role="tablist" aria-label="Agent details">${tabsFor(a).map(k=>{const t=info[k],on=k===cur;
    return `<button type="button" role="tab" class="af-tab${on?' on':''}" id="af-tab-${k}" data-af-tab="${k}" aria-selected="${on}" aria-controls="af-pane-${k}" tabindex="${on?0:-1}" aria-label="${esc(`${t.word}: ${t.text}`)}" data-tip="${esc(t.text)}">${icon(t.ic,13)}<span>${t.word}</span>${t.badge?`<small>${t.badge}</small>`:''}</button>`}).join('')}</div>`;
}
const tabPane=(k,cur,html)=>`<div class="af-pane af-pane-${k}" role="tabpanel" id="af-pane-${k}" data-af-pane="${k}" aria-labelledby="af-tab-${k}"${k===cur?'':' hidden'}>${html}</div>`;
// Show a tab without redrawing the panel, so focus and caret stay where they are.
function showTab(k,{focus=false}={}){
  const pane=$('#inspector');if(!pane)return;
  ui.tab=k;keepUi();
  for(const t of pane.querySelectorAll('[role=tab]')){const on=t.dataset.afTab===k;t.classList.toggle('on',on);t.setAttribute('aria-selected',on);t.tabIndex=on?0:-1;if(on&&focus)t.focus()}
  for(const p of pane.querySelectorAll('[role=tabpanel]'))p.hidden=p.dataset.afPane!==k;
  pane.scrollTop=0;
}
// ---------- setup strip: what an AI agent still needs, each chip jumping to its field ----------
const SETUP_GO={runner:['run','#af-runtime','Pick where it runs'],model:['run','#af-model-add','Pick the model it runs on'],
  cards:['links','#inspector [data-picker=af-cards]','Link a card. Runners work cards linked directly to the agent; cards in a linked project stay out of its queue']};
function setupHtml(a){
  const steps=setupSteps(af(),a),done=steps.filter(s=>s.done).length;
  if(done===steps.length)return '';
  return `<div class="af-setup"><span class="af-setup-n">Setup ${done}/${steps.length}</span><span class="af-setup-bar" role="progressbar" aria-label="Setup progress" aria-valuemin="0" aria-valuemax="${steps.length}" aria-valuenow="${done}"><i style="width:${Math.round(done/steps.length*100)}%"></i></span>
    ${steps.filter(s=>!s.done).map(s=>`<button type="button" class="af-setup-c" id="af-setup-${s.key}" data-af-setup="${s.key}" data-tip="${esc(SETUP_GO[s.key][2])}">${esc(s.label)}</button>`).join('')}</div>`;
}
function goSetup(key){const [tab,q]=SETUP_GO[key]||[];if(!tab)return;showTab(tab);document.querySelector(q)?.focus()}
// ---------- the agent panel ----------
function jobPane(a){
  const w=WORDS[a.kind]||WORDS.agent,n=lineCount(a.instructions);
  return `<div class="af-field"><label for="af-purpose">Purpose</label><textarea id="af-purpose" class="af-grow" rows="2" maxlength="2000" placeholder="${esc(w.purpose)}">${esc(a.purpose)}</textarea></div>
    ${pipelineHtml(a)}${toolsHtml(a)}
    <div class="af-ph af-ph-instr"><label for="af-instr">${icon('book',12)}Instructions</label><span class="sp"></span><span class="af-count" id="af-instr-n">${n?plural(n,'line'):'Empty'}</span>${ib('fit','Open in a large editor',{cls:'af-instr-open',attrs:'id="af-instr-open" data-afi="instr"'})}</div>
    <textarea id="af-instr" rows="4" maxlength="20000" placeholder="${esc(w.instr)}">${esc(a.instructions)}</textarea>`;
}
function orgChain(a,reps){
  const up=chainOf(af(),a.id).reverse().map(m=>`<button type="button" class="af-link" id="af-up-${esc(m.id)}" data-agent-go="${esc(m.id)}" data-tip="${esc(m.name)}" aria-label="${esc(`Open ${m.name}`)}">${icon(KIND_ICON[m.kind],11)}<span>${esc(m.name)}</span></button>`);
  const parts=[...up,`<span class="af-link me" aria-current="true">${icon(KIND_ICON[a.kind],11)}<span>${esc(a.name)}</span></span>`,...(reps.length?[`<span class="af-link n">${plural(reps.length,'report')}</span>`]:[])];
  return `<div class="af-orgchain" role="group" aria-label="Place in the org">${parts.join(`<i class="af-sepr">${icon('chevR',10)}</i>`)}</div>`;
}
function orgPane(a){
  const ppl=peopleOf(db()),reps=reportsOf(af(),a.id),flows=workflowsFor(af(),a.id),mgr=agent(a.reportsTo),sup=person(a.supervisor);
  return `${orgChain(a,reps)}
    ${prop('Reports to',selBtn('af-reports','Reports to',mgr?mgr.name:'Nobody (top level)',mgr&&agentAv(mgr)?bub(faceNode(humanFace(mgr)),'mini'):`<span class="pk-ic">${icon(mgr?KIND_ICON[mgr.kind]:'network',13)}</span>`,{none:!mgr}),{hint:'Another agent. Sets its place in the org chart.'})}
    ${prop('Supervisor',ppl.length?selBtn('af-sup','Supervisor',sup?sup.name:'None',sup?bub(sup,'mini'):`<span class="pk-ic">${icon('user',13)}</span>`,{none:!sup}):`<div class="dc-hint">Add people to a mind map to pick a supervisor.</div>`,{hint:'The person accountable, from your MindMap. Their face shows on the card.'})}
    ${reps.length?`<div class="af-h">Direct reports<em>${reps.length}</em></div><ul class="links">${reps.map(r=>`<li><button type="button" id="af-rep-${esc(r.id)}" data-agent-go="${esc(r.id)}">${icon(KIND_ICON[r.kind],12)}<span>${esc(r.name)}</span><em>${esc(r.title)}</em></button></li>`).join('')}</ul>`:''}
    ${flows.length?`<div class="af-h">Workflows<em>${flows.length}</em></div><ul class="links">${flows.map(w=>`<li><button type="button" id="af-wf-${esc(w.id)}" data-flow-go="${esc(w.id)}">${icon('flow',12)}<span>${esc(w.name)}</span><em>step ${w.steps.map((s,i)=>s.agent===a.id?i+1:0).filter(Boolean).join(', ')}</em></button></li>`).join('')}</ul>`:''}`;
}
function agentHtml(a){
  const live=a.kind==='agent'&&a.live,why=live&&liveProblem(af(),a),cur=activeTab(a);
  const label=live&&(a.status==='paused'||a.status==='retired')?`Live while ${AGENT_STATUS[a.status]}: runners still pick it up. Status is your label, Live is what runners obey.`:'';
  const warn=t=>`<div class="af-warn" role="status">${icon('alert',12)}<span>${esc(t)}</span></div>`;
  const tips=a.kind==='agent'?AI_STATUS_TIP:STATUS_TIP;
  return `<form id="afedit" class="ibody af-panel" autocomplete="off"><div class="af-top">
    <div class="ihead"><span class="k af-k${a.kind==='human'?' human':''}">${icon(KIND_ICON[a.kind])}</span><strong>${AGENT_KINDS[a.kind]}</strong><span class="sp"></span>
    ${ib('copy','Copy brief as Markdown\nFor the runner that does the work',{attrs:'data-afi="brief"'})}${ib('plus','Add a direct report',{attrs:'data-afi="addReport"'})}
    ${ib('trash','Delete agent',{key:keyLabel('agentflow.delete'),cls:'danger',attrs:'data-afi="delete"'})}${ib('x','Close',{key:keyLabel('global.escape'),attrs:'data-afi="close"'})}</div>
    <div class="af-hero">${avatarHtml(a)}<div class="af-hero-m"><input id="af-name" class="af-name-in" maxlength="120" required value="${esc(a.name)}" aria-label="Name">
      <input id="af-title" class="af-role-in" maxlength="120" placeholder="Add a role" value="${esc(a.title)}" aria-label="Role"></div>
      ${a.kind==='agent'?liveHtml(a,why):''}</div>
    <div class="af-row">${choice('af-kind',Object.entries(AGENT_KINDS).map(([k,n])=>({value:k,label:n,icon:KIND_ICON[k],tip:KIND_TIP[k]})),a.kind,{label:'Kind',idp:'af-kind'})}${statusChoice(a.status,AGENT_STATUS,tips)}</div>
    ${a.kind==='agent'?setupHtml(a):''}
    ${why?warn(`Its runner will skip it: ${why}`):''}${label?warn(label):''}
    ${tabBar(a,cur)}</div>
    ${tabPane('job',cur,jobPane(a))}
    ${a.kind==='agent'?tabPane('run',cur,runtimeHtml(a)):a.kind==='automation'?tabPane('run',cur,scheduleHtml(a)):''}
    ${tabPane('org',cur,orgPane(a))}
    ${tabPane('links',cur,linksHtml(a))}
    </form>`;
}
// When it runs, and the runner job it was promoted from (read-only: the runner reports it).
const scheduleInput=(a,ph,tip)=>prop('Schedule',`<input id="af-schedule" maxlength="200" placeholder="${esc(ph)}" value="${esc(a.schedule)}">`,{ic:'clock',for:'af-schedule',hint:tip});
function scheduleHtml(a){
  return scheduleInput(a,'e.g. Daily 22:30 or 30 22 * * *','Plain text or cron. Automations run on their own schedule, outside Flow: no runner works them and they have no models.')+jobHtml(a);
}
// One status line; Details opens everything the runner reported. Open state lasts while the panel does.
let jobOpen=false;
function jobHtml(a){
  if(!a.job)return '';
  const j=jobOf(af(),a.job.runner,a.job.id);
  if(!j)return `<div class="af-h">${icon('clock',12)}Promoted from</div><div class="dc-hint">${esc(a.job.runner)} no longer reports this job (${esc(a.job.id)}).</div>`;
  const runner=runnerOf(af(),a.job.runner)?.name||a.job.runner,status=JOB_STATUS[j.lastStatus]||'Unknown';
  const time=j.nextRun?`next ${rel(j.nextRun)}`:j.lastRun?`last ${rel(j.lastRun)}`:'',line=[time,sourceName(j),runner].filter(Boolean).join(' · ');
  return `<div class="af-h">${icon(jobIcon(j),12)}<span class="af-h-n">Promoted from ${esc(j.name)}</span></div>
    <div class="af-jobline"><i class="af-jdot s-${esc(j.lastStatus)}"></i><span class="af-jobline-t"><b>${esc(status)}</b>${line?` · ${esc(line)}`:''}${j.enabled?'':' · <b>Off</b>'}${j.drift?` · <b class="af-jobline-w">Drift</b>`:''}</span>
      <button type="button" class="af-more" id="af-job-more" data-af-job-more aria-expanded="${jobOpen}" aria-controls="af-job-more-b" aria-label="${esc(`Details: ${status}${line?`, ${line}`:''}`)}">Details<i class="af-chev">${icon('chevD',12)}</i></button></div>
    <div class="dc-hint af-jobnote">Reported by ${esc(runner)}. Change it there, not here.</div>
    <div class="af-jobinfo" id="af-job-more-b"${jobOpen?'':' hidden'}><div class="af-jobinfo-h">${icon(jobIcon(j),13)}<b>${esc(j.name)}</b>${j.enabled?'':'<span class="af-off">Off</span>'}</div>${jobDetails({...j,runner})}</div>`;
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
const BILL_TIP={included:'Covered by your plan',metered:'Costs per use'};
const billBadge=(m,tip=false)=>{const b=BILLING[m?.billing];if(!b)return '';const [bg,fg]=colorOf(b[1]);return `<span class="af-bill" style="background:${bg};color:${fg}"${tip?` data-tip="${BILL_TIP[m.billing]}"`:''}>${b[0]}</span>`};
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
  const rs=af().runners||[],r=runnerOf(af(),a.runtime),ms=modelsOf(a),pool=new Map(modelPool(a).map(m=>[m.id,m])),auto=a.auto===true;
  const rows=ms.map((id,i)=>{const m=pool.get(id),name=m?.label||id,role=auto?'Pool':i?`Fallback ${i}`:'Primary',missing=!!pool.size&&!m,bill=BILL_TIP[m?.billing];
    const text=[`${name}${m?.label&&m.label!==id?` (${id})`:''}`,role,bill&&`${BILLING[m.billing][0]}: ${bill}`,missing&&'Not reported by this runner'].filter(Boolean);
    return `<li class="af-m${i?'':' first'}" data-tip="${esc(text.join('\n'))}"><em>${i+1}</em>${makerIcon(modelMaker(id,m?.label),15)}<span class="af-m-l" id="af-ml-${i}" tabindex="0" role="group" aria-label="${esc(`${i+1}. ${text.join('. ')}`)}"><b>${esc(name)}</b></span>${missing?`<i class="af-m-miss">${icon('alert',12)}</i>`:''}${billBadge(m,true)}
      <span class="af-m-b">${ib('chevU','Move up',{attrs:`id="af-mup-${i}" data-af-mup="${i}"${i?'':' disabled'}`})}${ib('chevD','Move down',{attrs:`id="af-mdn-${i}" data-af-mdn="${i}"${i<ms.length-1?'':' disabled'}`})}${ib('x','Remove',{attrs:`id="af-mdel-${i}" data-af-mdel="${i}"`,label:`Remove ${name}`})}</span></li>`}).join('');
  const stale=r&&Date.now()-Date.parse(r.reported)>JOBS_STALE;
  return `${prop('Runner',`<div class="af-combo"><input id="af-runtime" maxlength="200" placeholder="${rs.length?'Pick or type a runner':'e.g. T3, home server'}" value="${esc(a.runtime)}">
      <button type="button" class="af-combo-b" data-picker="af-runner" aria-haspopup="listbox" aria-expanded="${pickerOpen('af-runner')}" aria-label="Reported runners"${rs.length?'':' disabled'} data-tip="${rs.length?`${plural(rs.length,'runner')} reported`:'No runner has reported to this workspace yet'}">${icon('chevD',12)}</button></div>`,{ic:'server',for:'af-runtime',hint:'The machine that works its cards. Pick one that has reported, or type a name. The line below says when it last reported and how many models it offers.'})}
    ${r?`<div class="af-runline"><i class="af-rdot${stale?' stale':''}"></i>${esc(ago(r.reported))} · ${plural(r.models.length,'model')}</div>`
      :a.runtime.trim()&&rs.length?`<div class="af-runline"><i class="af-rdot none"></i>No runner called “${esc(a.runtime.trim())}” has reported to this workspace.</div>`:''}
    <div class="af-mh"><label for="af-model-add">Models</label>${hint(auto?'A pool: the runner picks one from these per card.':'The first is the primary. The rest are fallbacks, tried in order.','Models')}<span class="sp"></span>
      <label class="af-tog af-auto${auto?' on':''}" data-tip="Auto: let the runner pick from these per card"><input type="checkbox" id="af-auto" role="switch"${auto?' checked':''}><span class="af-sw" aria-hidden="true"></span><span>${icon('sparkle',12)}Auto</span></label></div>
    ${rows?`<ol class="af-models">${rows}</ol>`:''}
    <button type="button" class="pk-btn af-madd" id="af-model-add" data-af-models aria-haspopup="listbox" aria-expanded="${!!mp}"${ms.length>=MAX_MODELS?' disabled':''}>${icon('plus',12)}<span class="pk-t">${!ms.length?'Choose a model':auto?'Add to the pool':'Add a fallback'}</span><small>${pool.size?`${pool.size} available`:'type any id'}</small></button>
    ${scheduleInput(a,'e.g. Weekdays 09:00','A note in its brief. Runners do not start it at this time: they work its queue while it is Live.')}${jobHtml(a)}`;
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
// Steps: a rail of one-line summaries; one opens in place into its editor (openStep). All editors are
// in the DOM, hidden when collapsed, so their ids stay.
let openStep=null;
function stepHtml(w,s,i,agents){
  const a=s.agent?agent(s.agent):null,open=openStep===s.id,sid=esc(s.id),name=a?a.name:'Unassigned',act=s.action.trim(),out=s.output.trim();
  const face=a&&agentAv(a)?bub(faceNode(humanFace(a)),'mini'):`<span class="af-sr-ic">${icon(a?KIND_ICON[a.kind]:'user',12)}</span>`;
  const text=`Step ${i+1}: ${name}. ${act||'No action yet'}${out?`. Output: ${out}`:''}`;
  return `<li data-step="${sid}"${open?' class="open"':''}><button type="button" class="af-sr" id="af-srow-${sid}" data-step-open="${sid}" aria-expanded="${open}" aria-controls="af-sed-${sid}" aria-label="${esc(text)}" data-tip="${esc(text)}">
      <em>${i+1}</em>${face}<span class="af-sr-m"><b>${esc(name)}</b><small class="af-sr-a${act?'':' none'}">${esc(act||'No action yet')}</small></span>${out?`<i class="af-sr-o" data-tip="${esc(`Output: ${out}`)}">${icon('send',11)}</i>`:''}<i class="af-chev">${icon('chevD',12)}</i></button>
    <div class="af-sed" id="af-sed-${sid}"${open?'':' hidden'}>
      <select id="af-agt-${sid}" data-step-agent="${sid}" aria-label="Step ${i+1} agent">${opt('','Unassigned',s.agent)}${agents.map(x=>opt(x.id,x.name,s.agent)).join('')}</select>
      <input data-step-action="${sid}" id="af-act-${sid}" maxlength="500" placeholder="What happens" value="${esc(s.action)}" aria-label="Step ${i+1} action">
      <input data-step-output="${sid}" id="af-out-${sid}" maxlength="300" placeholder="Output (optional)" value="${esc(s.output)}" aria-label="Step ${i+1} output">
      <div class="af-sed-b">${ib('chevU','Move up',{attrs:`id="af-sup-${sid}" data-step-up="${sid}"${i?'':' disabled'}`})}${ib('chevD','Move down',{attrs:`id="af-sdn-${sid}" data-step-down="${sid}"${i<w.steps.length-1?'':' disabled'}`})}<span class="sp"></span>${ib('x','Remove step',{attrs:`id="af-sdel-${sid}" data-step-del="${sid}"`})}</div></div></li>`;
}
function workflowHtml(w){
  const agents=[...af().agents].sort(byName);
  return `<form id="afedit" class="ibody af-panel" autocomplete="off"><div class="af-top">
    <div class="ihead"><span class="k af-k">${icon('flow')}</span><strong>Workflow</strong><span class="sp"></span>
    ${ib('copy','Copy brief as Markdown\nFor the runner that does the work',{attrs:'data-afi="brief"'})}${ib('trash','Delete workflow',{key:keyLabel('agentflow.delete'),cls:'danger',attrs:'data-afi="delete"'})}${ib('x','Close',{key:keyLabel('global.escape'),attrs:'data-afi="close"'})}</div>
    <div class="af-hero one"><span class="af-av k-flow">${icon('flow',20)}</span><div class="af-hero-m"><input id="af-name" class="af-name-in" maxlength="120" required value="${esc(w.name)}" aria-label="Name"></div></div>
    <div class="af-row">${statusChoice(w.status,WORKFLOW_STATUS,FLOW_STATUS_TIP)}${choice('af-trigger',Object.entries(TRIGGERS).map(([k,n])=>({value:k,label:n,icon:TRIGGER_ICON[k],tip:TRIGGER_TIP[k]})),w.trigger,{label:'Trigger',idp:'af-trig'})}</div></div>
    <div class="af-pane">
    ${w.trigger==='manual'?'':prop('When',`<input id="af-sched" maxlength="200" placeholder="${esc(TRIGGER_HINT[w.trigger])}" value="${esc(w.schedule)}">`,{ic:TRIGGER_ICON[w.trigger],for:'af-sched'})}
    <div class="af-field"><label for="af-desc">Description</label><textarea id="af-desc" class="af-grow" rows="2" maxlength="4000" placeholder="What this workflow achieves">${esc(w.description)}</textarea></div>
    <div class="af-h">${icon('list',12)}Steps<em>${w.steps.length}</em></div>
    ${w.steps.length?`<ol class="af-rail">${w.steps.map((s,i)=>stepHtml(w,s,i,agents)).join('')}</ol>`:''}
    <button type="button" class="af-addstep" id="af-addstep" data-afi="addStep"><i>${icon('plus',12)}</i>Add step</button>
    </div>
    ${sec('links','link','Links',linksHtml(w),linkCount(w)?String(linkCount(w)):'none')}
    </form>`;
}
function openInstructions(btn){
  const id=sel()?.id,a=agent(id);if(!a)return;
  const m=detailModal({cls:'af-instr-dlg',label:`Instructions for ${a.name}`,from:btn,
    onClose(){rerender();requestAnimationFrame(()=>$('#af-instr-open')?.focus())},
    events:{input(e){if(e.target.id==='af-instr-big')setInstructions(agent(id),e.target.value)},click(e){if(e.target.closest('[data-instr-close]'))m.close()}}});
  m.body.innerHTML=`<div class="af-instr-h">${icon('book',14)}<strong>Instructions</strong><span class="af-count">${esc(a.name)}</span><span class="sp"></span>${ib('x','Close',{key:keyLabel('global.escape'),attrs:'data-instr-close'})}</div>
    <textarea id="af-instr-big" maxlength="20000" aria-label="Instructions" placeholder="${esc((WORDS[a.kind]||WORDS.agent).instr)}"></textarea>`;
  const t=m.body.querySelector('textarea');t.value=a.instructions;t.focus();t.setSelectionRange(t.value.length,t.value.length);
}
// Autosaves like the panel's own fields: same undo step, and the short field and its count follow.
function setInstructions(a,v){
  if(!a)return;autosave(a,()=>{a.instructions=v});
  const t=$('#af-instr');if(t&&t.value!==v)t.value=v;
  countInstructions(v);
}
const countInstructions=v=>{const c=$('#af-instr-n'),n=lineCount(v);if(c)c.textContent=n?plural(n,'line'):'Empty'};
export function renderInspector(pane){
  const x=sel();
  if(mp&&(!x||x.id!==mp.id))closeModels();
  panel(pane,!!x,{onHidden:()=>{if(!sel())pane.innerHTML=''}});
  if(!x)return;
  // Keep focus and caret when the panel is redrawn after a change.
  const a=document.activeElement,had=pane.contains(a),keep=had&&a.id?{id:a.id,s:a.selectionStart,e:a.selectionEnd}:null,top=pane.scrollTop;
  pane.innerHTML=selected.type==='agent'?agentHtml(x):workflowHtml(x);
  pane.scrollTop=top;
  const f=keep&&document.getElementById(keep.id);
  if(f){f.focus({preventScroll:true});try{if(keep.s!=null)f.setSelectionRange(keep.s,keep.e)}catch{}}
  // The field is gone or on a tab this kind lacks: stay in the panel, never drop to the page.
  if(had&&!pane.contains(document.activeElement))(pane.querySelector('[role=tab][aria-selected=true]')||$('#af-name'))?.focus({preventScroll:true});
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
  'af-reports':{label:'Reports to',items:a=>[{value:'',label:'Nobody (top level)',icon:'network'},...managersFor(a).map(x=>{const av=agentAv(x);return {value:x.id,label:x.name,sub:x.title,...(av?{avatar:av}:{icon:KIND_ICON[x.kind]})}})],cur:a=>a.reportsTo,
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
  if(b.dataset.afTab){showTab(b.dataset.afTab);return}
  if(b.dataset.afSetup){goSetup(b.dataset.afSetup);return}
  if(b.dataset.afJobMore!==undefined){jobOpen=!jobOpen;const box=$('#af-job-more-b');if(box)box.hidden=!jobOpen;b.setAttribute('aria-expanded',jobOpen);return}
  if(b.dataset.stepOpen){openStep=openStep===b.dataset.stepOpen?null:b.dataset.stepOpen;rerender();return}
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
  // Automations are never live (they run on their own schedule, outside Flow).
  if(b.dataset.afKind){const k=b.dataset.afKind;if(x.kind!==k)change(()=>{x.kind=k;if(k==='automation')x.live=false;touch(x)});return}
  if(b.dataset.afStatus){if(x.status!==b.dataset.afStatus)change(()=>{x.status=b.dataset.afStatus;touch(x)});return}
  if(b.dataset.afTrigger){if(x.trigger!==b.dataset.afTrigger)change(()=>{x.trigger=b.dataset.afTrigger;touch(x)});return}
  if(b.dataset.afAdd){addTo(b.dataset.afAdd);return}
  if(b.dataset.afDel){const k=b.dataset.afDel,i=+b.dataset.i;change(()=>{x[k].splice(i,1);touch(x)});requestAnimationFrame(()=>$('#af-new-'+k)?.focus());return}
  if(b.dataset.afCard){openCard(b.dataset.afCard);return}
  if(b.dataset.afItem){openItem(b.dataset.afItem);return}
  if(b.dataset.agentGo){select('agent',b.dataset.agentGo);return}
  if(b.dataset.flowGo){ui.view='workflows';keepUi();select('workflow',b.dataset.flowGo);return}
  const step=id=>x.steps.findIndex(s=>s.id===id);
  if(b.dataset.stepDel){
    const i=step(b.dataset.stepDel);if(i<0)return;
    change(()=>{x.steps.splice(i,1);touch(x)});
    const next=x.steps[Math.min(i,x.steps.length-1)];
    requestAnimationFrame(()=>(next&&document.getElementById('af-srow-'+next.id)||$('#af-addstep'))?.focus());return;
  }
  if(b.dataset.stepUp||b.dataset.stepDown){
    const id=b.dataset.stepUp||b.dataset.stepDown,i=step(id),j=b.dataset.stepUp?i-1:i+1;if(i<0||j<0||j>=x.steps.length)return;
    change(()=>{[x.steps[i],x.steps[j]]=[x.steps[j],x.steps[i]];touch(x)});
    // At the top or bottom its own arrow is disabled: fall back to the other one, or to Remove.
    const q=`#inspector [data-step-%="${CSS.escape(id)}"]`,dir=j<i?'up':'down',other=j<i?'down':'up';
    requestAnimationFrame(()=>(document.querySelector(q.replace('%',dir)+':not([disabled])')||document.querySelector(q.replace('%',other)+':not([disabled])')||document.querySelector(q.replace('%','del')))?.focus());return;
  }
  ({close:()=>select(null),delete:removeSelected,brief:copyBrief,addReport:()=>addAgent(x.id),instr:()=>openInstructions(b),
    addStep(){const no=full(af(),'steps',x);if(no){toast(no,true);return}const s=newStep();openStep=s.id;change(()=>{x.steps.push(s);touch(x)});requestAnimationFrame(()=>document.getElementById('af-act-'+s.id)?.focus())},
  })[b.dataset.afi]?.();
}
// Text fields autosave as you type: one undo step per open form.
const TEXT={'af-name':'name','af-title':'title','af-schedule':'schedule','af-purpose':'purpose','af-runtime':'runtime','af-instr':'instructions','af-desc':'description','af-sched':'schedule'};
function autosave(x,apply){
  const form=$('#afedit');if(form&&!edited.has(form)){checkpoint();edited.add(form)}
  apply();touch(x);save();render();
}
export function inspectorInput(e){
  const t=e.target,x=sel(),form=$('#afedit');if(!x||!form)return;
  const key=TEXT[t.id],sa=t.dataset.stepAction,so=t.dataset.stepOutput;
  if(!key&&!sa&&!so)return;
  if(key==='name'&&!t.value.trim())return;
  autosave(x,()=>{
    if(key)x[key]=key==='name'?t.value.trim():t.value;
    else{const s=x.steps.find(y=>y.id===(sa||so));if(s)s[sa?'action':'output']=t.value}
  });
  if(key==='instructions')countInstructions(t.value);
  // The open step's summary line follows its action as you type.
  if(sa){const l=document.querySelector(`#af-srow-${CSS.escape(sa)} .af-sr-a`),v=t.value.trim();if(l){l.textContent=v||'No action yet';l.classList.toggle('none',!v)}}
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
// Alt+J / Alt+K: the next or previous agent in reading order of the org (or workflow), keeping the tab
// and the field, so one field can be edited across many agents.
function orgOrder(){const A=af(),out=[],walk=a=>{out.push(a);reportsOf(A,a.id).forEach(walk)};rootsOf(A).forEach(walk);return out}
function stepSelection(by){
  const x=sel();if(!x)return false;
  const type=selected.type,list=type==='agent'?orgOrder():af().workflows;if(list.length<2)return true;
  const i=list.findIndex(y=>y.id===x.id),next=list[(i+by+list.length)%list.length];
  if(type==='agent')ui.tab=activeTab(x),keepUi();
  select(type,next.id);
  if(type==='agent'){const cv=$('#afCanvas')?.getBoundingClientRect(),n=document.querySelector(`#afCanvas [data-agent="${CSS.escape(next.id)}"]`)?.getBoundingClientRect();
    if(cv&&n&&(n.left<cv.left||n.right>cv.right||n.top<cv.top||n.bottom>cv.bottom))center(next.id)}
  return true;
}
const stepKey=e=>matches(e,'agentflow.nextAgent')?1:matches(e,'agentflow.prevAgent')?-1:0;
export function inspectorKey(e){
  const by=stepKey(e),typing=/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)||e.target.isContentEditable;
  // A shortcut rebound to a bare letter must not take that letter from a text field.
  if(by&&(!typing||e.altKey||e.ctrlKey||e.metaKey)){if(stepSelection(by)){e.preventDefault();e.stopPropagation()}return}
  // The tab bar: arrows and Home/End move and select (and stay out of the canvas's arrow keys).
  if(e.target.getAttribute?.('role')==='tab'&&['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(e.key)){
    const a=sel();if(!a?.kind)return;e.preventDefault();e.stopPropagation();
    if(e.key==='ArrowUp'||e.key==='ArrowDown')return;
    const t=tabsFor(a),i=t.indexOf(e.target.dataset.afTab),n=t.length;
    showTab(e.key==='Home'?t[0]:e.key==='End'?t[n-1]:t[(i+(e.key==='ArrowRight'?1:-1)+n)%n],{focus:true});return;
  }
  const m=/^af-new-(\w+)$/.exec(e.target.id||'');
  // Backspace in an empty chip field removes the last chip.
  if(m&&e.key==='Backspace'&&!e.target.value){const x=sel();if(x?.[m[1]]?.length){e.preventDefault();change(()=>{x[m[1]].pop();touch(x)})}return}
  if(e.key!=='Enter')return;
  if(m){e.preventDefault();addTo(m[1])}else if(e.target.tagName==='INPUT')e.preventDefault();
}
export function key(e){
  if(e.key==='Escape'){if(menuOpen())return;if(closeJob())return;if(selected)select(null);return}
  if(stepKey(e)&&selected){if(stepSelection(stepKey(e)))e.preventDefault();return}
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
