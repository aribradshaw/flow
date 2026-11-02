// AgentFlow data: an org chart of agents (AI agents, humans and teams) and the workflows they run.
// Defaults, validation and pure helpers (no DOM, no storage), so the server, the API and tests can
// use them in Node, as with devops-core.js.
//
// db.agentflow = {agents:[agent], workflows:[workflow], runners:[runner]}
// agent    = {id,name,kind,title,status,live,reportsTo,supervisor,purpose,instructions,runtime,models[],model,auto,schedule,
//             inputs[],outputs[],tools[],projects[],cards[],items[],created,updated, job?,x?,y?}
//   kind: agent (AI), human, team, or automation: a scripted job with no AI that runs on its own
//   schedule outside Flow (a systemd timer, a cron job). Automations have no models and are never live.
//   schedule: when it runs, plain text or cron ('' for none). job: {runner,id}, the runner job it was
//   promoted from (promoteJob); absent when none.
//   live: the switch a runner obeys. Off (the default), runners leave the agent alone whatever its
//   status; on, a runner whose name matches `runtime` works its queue on `models`.
//   models: model ids in order, the primary first and then fallbacks the runner tries when one fails
//   (unique, up to LIMITS.agentModels). model is always models[0] (or ''), kept for older readers.
//   auto: models is a pool, and the runner picks one per card instead of always starting on the first.
//   x, y: where the card sits on the AgentFlow canvas (optional; see positions()).
//   reportsTo: another agent (the AgentFlow org chart); supervisor: a person card on a Flow chart.
// workflow = {id,name,description,status,trigger,schedule,steps:[{id,agent,action,output}],
//             projects[],cards[],items[],created,updated}
// runner   = {name,models:[{id,label,provider?,billing?}],jobs:[job],timezone?,reported,jobsReported?}: a machine or service that runs
//   agents, as it reported itself (runners.report). Its name is what agents put in `runtime`, and its
//   models are the choices for `models`. provider groups models for display (e.g. "Claude"); billing is
//   'included' (a subscription or free) or 'metered' (paid per use). Flow never contacts a runner;
//   the runner calls Flow.
// job      = {id,name,source,group?,schedule,cron?,timezone?,triggers?,origin?,file?,drift?,note?,command?,ai,enabled,
//             lastRun?,lastStatus,nextRun?}: a scheduled job the runner found (a systemd timer, a crontab line, a
//   Vercel cron...). id is stable per runner; group is a display group ("Vercel · my-app"); ai: it starts
//   an AI agent. timezone: the zone its times are in (an IANA name, "UTC" or "local": the runner's own,
//   see runner.timezone). triggers: [{kind, expr?, text?}], every rule it fires on, expr the raw
//   expression as the scheduler holds it and text it in words. origin: where the schedule was read, a
//   repo file (file: its repo-relative path), the hosting platform's API or the machine's scheduler.
//   drift: how the platform's live schedule differs from the repo file. note: conditions the job's
//   script applies itself ("exits when nothing changed"). jobsReported: when the jobs were last saved
//   (see reportRunner for when a report is saved). runner.timezone: the runner machine's zone.
// projects, cards and items point at Flow projects, DevOps cards and timeline items (deadlines).
// Flow records the design. Running agents is left to outside runners (T3, a home server, cron),
// which read it through the API or MCP; agentBrief() and workflowBrief() give them a briefing.

export const AGENT_KINDS={agent:'AI agent',human:'Human',team:'Team',automation:'Automation'};
export const AGENT_STATUS={draft:'Draft',active:'Active',paused:'Paused',retired:'Retired'};
export const WORKFLOW_STATUS={draft:'Draft',active:'Active',paused:'Paused'};
export const TRIGGERS={manual:'Manual',schedule:'Schedule',event:'Event'};
export const TRIGGER_HINT={manual:'Someone starts it',schedule:'e.g. Weekdays at 09:00',event:'e.g. A card enters UAT'};
export const LIMITS={agents:500,workflows:500,steps:100,list:50,refs:100,runners:20,models:1500,agentModels:10,jobs:500,triggers:10};
export const JOB_STATUS={ok:'OK',failed:'Failed',running:'Running',unknown:'Unknown'};
// How a job's source reads as an agent's role when it is promoted (unknown sources: "<source> job").
export const JOB_SOURCES={systemd:'systemd timer',cron:'Cron job',t3:'T3 schedule',vercel:'Vercel cron',railway:'Railway cron',aside:'Aside schedule',
  windows:'Windows scheduled task',claude:'Claude schedule',codex:'Codex automation',github:'GitHub Actions schedule',other:'Scheduled job'};
// Where a job's schedule was read, and the kinds of rule (trigger) a job fires on.
export const JOB_ORIGINS={repo:'Repo file',platform:'Platform',machine:'Machine'};
export const JOB_TRIGGERS={cron:'Cron',calendar:'Calendar',interval:'Interval',logon:'At logon',boot:'At boot',once:'Once',rrule:'Recurrence rule',manual:'Manual',other:'Other'};
export const BILLING={included:'Included',metered:'Metered'};
// Ids of records shared in from another workspace. They are projected in on read and are not in
// stored data, so links to them are kept even when the record is not present (e.g. on the server).
const shared=x=>typeof x==='string'&&x.startsWith('sh.');

const str=(v,n)=>String(v??'').slice(0,n),id=()=>crypto.randomUUID();
const iso=(v,now)=>typeof v==='string'&&!Number.isNaN(Date.parse(v))?v:now;
const pick=(v,map,dflt)=>Object.hasOwn(map,v)?v:dflt;
// Short text lists (inputs, outputs, tools): trimmed, non-empty, unique.
const strs=(v,n=LIMITS.list,len=200)=>[...new Set((Array.isArray(v)?v:[]).filter(x=>typeof x==='string').map(x=>x.trim().slice(0,len)).filter(Boolean))].slice(0,n);
const refs=(v,ok)=>[...new Set((Array.isArray(v)?v:[]).filter(x=>typeof x==='string'&&(ok.has(x)||shared(x))))].slice(0,LIMITS.refs);

export const seedAgentflow=()=>({agents:[],workflows:[],runners:[]});
const clampXY=v=>Math.max(-1e5,Math.min(1e5,Math.round(v)));
export const placed=a=>Number.isFinite(a?.x)&&Number.isFinite(a?.y);

// Every person card across the workspace's charts (supervisors are people).
export function peopleOf(db){
  const m=new Map();for(const c of db.charts||[])for(const n of c.nodes||[])if(n.type==='person'&&!m.has(n.id))m.set(n.id,n);
  return [...m.values()];
}

// Matching people by name or email, for display only (photos); nothing here is ever saved.
// Names compare case-insensitively with runs of whitespace collapsed.
export const normName=s=>String(s??'').trim().replace(/\s+/g,' ').toLowerCase();
const normEmail=s=>String(s??'').trim().toLowerCase();
export const sameName=(a,b)=>{const x=normName(a);return !!x&&x===normName(b)};
// The one person in `people` called `name`, or null when nobody or several people are.
export function personNamed(people,name){
  const k=normName(name);if(!k)return null;let hit=null;
  for(const p of people||[])if(normName(p?.name)===k){if(hit&&hit.id!==p.id)return null;hit=p}
  return hit;
}
// Is person card `n` the signed-in user `me` ({email, name})? By email when the card has one;
// otherwise when it is the only person in `people` with their name and no card carries their email.
export function isSessionPerson(n,people,me){
  if(!n||!me)return false;
  const mail=normEmail(me.email),e=normEmail(n.email);
  if(e)return !!mail&&e===mail;
  if(mail&&(people||[]).some(p=>normEmail(p?.email)===mail))return false;
  return personNamed(people,me.name)?.id===n.id;
}

// Validate a saved AgentFlow against the rest of the database. Unknown kinds and statuses fall back
// to defaults; links to deleted agents, people, projects, cards or items are dropped, and a
// reportsTo loop is broken at the first agent (in saved order) that closes it.
export function cleanAgentflow(d,db={}){
  if(!d||typeof d!=='object')return seedAgentflow();
  const now=new Date().toISOString();
  const projects=new Set((db.projects||[]).map(p=>p.id)),cards=new Set((db.devops?.cards||[]).map(c=>c.id)),items=new Set((db.timeline||[]).map(i=>i.id));
  const people=new Set(peopleOf(db).map(n=>n.id));
  const links=x=>({projects:refs(x.projects,projects),cards:refs(x.cards,cards),items:refs(x.items,items)});
  const seen=new Set();
  const agents=(Array.isArray(d.agents)?d.agents:[]).filter(a=>a&&typeof a.id==='string'&&a.id&&typeof a.name==='string'&&!seen.has(a.id)&&seen.add(a.id)).slice(0,LIMITS.agents).map(a=>{
    const kind=pick(a.kind,AGENT_KINDS,'agent'),job=cleanJobLink(a.job);
    return {id:a.id.slice(0,80),name:a.name.trim().slice(0,120)||'Untitled agent',kind,title:str(a.title,120),status:pick(a.status,AGENT_STATUS,'draft'),live:a.live===true&&kind!=='automation',
    reportsTo:typeof a.reportsTo==='string'?a.reportsTo:'',supervisor:typeof a.supervisor==='string'&&(people.has(a.supervisor)||shared(a.supervisor))?a.supervisor:'',
    purpose:str(a.purpose,2000),instructions:str(a.instructions,20000),runtime:str(a.runtime,200),...cleanModels(a),schedule:str(a.schedule,200),
    inputs:strs(a.inputs),outputs:strs(a.outputs),tools:strs(a.tools),...links(a),created:iso(a.created,now),updated:iso(a.updated,now),
    ...(job?{job}:{}),...(placed(a)?{x:clampXY(a.x),y:clampXY(a.y)}:{})};
  });
  const byId=new Map(agents.map(a=>[a.id,a]));
  for(const a of agents){
    if(!byId.has(a.reportsTo)||a.reportsTo===a.id){a.reportsTo='';continue}
    // Walk up the chain; coming back to this agent means a loop.
    for(let up=byId.get(a.reportsTo),n=0;up;up=byId.get(up.reportsTo),n++)if(up.id===a.id||n>agents.length){a.reportsTo='';break}
  }
  const wseen=new Set();
  const workflows=(Array.isArray(d.workflows)?d.workflows:[]).filter(w=>w&&typeof w.id==='string'&&w.id&&typeof w.name==='string'&&!wseen.has(w.id)&&wseen.add(w.id)).slice(0,LIMITS.workflows).map(w=>{
    const sseen=new Set();
    return {id:w.id.slice(0,80),name:w.name.trim().slice(0,120)||'Untitled workflow',description:str(w.description,4000),status:pick(w.status,WORKFLOW_STATUS,'draft'),
      trigger:pick(w.trigger,TRIGGERS,'manual'),schedule:str(w.schedule,200),
      steps:(Array.isArray(w.steps)?w.steps:[]).filter(s=>s&&typeof s==='object').slice(0,LIMITS.steps).map(s=>{
        let sid=typeof s.id==='string'&&s.id?s.id.slice(0,80):id();if(sseen.has(sid))sid=id();sseen.add(sid);
        return {id:sid,agent:byId.has(s.agent)?s.agent:'',action:str(s.action,500),output:str(s.output,300)};
      }),
      ...links(w),created:iso(w.created,now),updated:iso(w.updated,now)};
  });
  return {agents,workflows,runners:cleanRunners(d.runners)};
}
// models wins over model; older saves with only model get models=[model]. model mirrors models[0].
function cleanModels(a){
  const models=strs(Array.isArray(a.models)&&a.models.length?a.models:typeof a.model==='string'?[a.model]:[],LIMITS.agentModels,120);
  return {models,model:models[0]||'',auto:a.auto===true};
}
// The runner job an agent was promoted from: {runner,id} (both non-empty, up to 200 characters), or null.
export function cleanJobLink(j){
  if(!j||typeof j!=='object'||typeof j.runner!=='string'||typeof j.id!=='string')return null;
  const runner=j.runner.trim().slice(0,200),id=j.id.slice(0,200);
  return runner&&id.trim()?{runner,id}:null;
}
// Scheduled jobs as a runner reported them: unique ids (the first wins), up to LIMITS.jobs. Text is
// trimmed and cut to its limit; group, cron, command, lastRun and nextRun are left out when empty
// (or, for the times, not a date). enabled is true unless false; lastStatus is unknown unless known.
const isoOr=v=>typeof v==='string'&&v.trim()&&!Number.isNaN(Date.parse(v))?v.trim().slice(0,40):'';
// timezone is an IANA name ("America/Phoenix"), "UTC" or "local"; anything else is left out. triggers
// keep up to LIMITS.triggers objects, an unknown kind as other, expr and text left out when empty.
// origin is left out unless it is one of JOB_ORIGINS; drift, note and file when empty.
export const cleanTz=v=>{const z=str(v,64).trim();return /^[A-Za-z][A-Za-z0-9_+\-]*(\/[A-Za-z0-9_+\-]+)*$/.test(z)?z:''};
export function cleanTriggers(v){
  return (Array.isArray(v)?v:[]).filter(t=>t&&typeof t==='object').slice(0,LIMITS.triggers).map(t=>{
    const expr=str(t.expr,200).trim(),text=str(t.text,200).trim();
    return {kind:pick(t.kind,JOB_TRIGGERS,'other'),...(expr?{expr}:{}),...(text?{text}:{})};
  });
}
export function cleanJobs(v){
  const seen=new Set();
  return (Array.isArray(v)?v:[]).filter(j=>j&&typeof j.id==='string'&&j.id.trim()).map(j=>({...j,id:j.id.trim().slice(0,200)}))
    .filter(j=>!seen.has(j.id)&&seen.add(j.id)).slice(0,LIMITS.jobs).map(j=>{
      const t=(k,n)=>str(j[k],n).trim(),group=t('group',120),cron=t('cron',120),command=t('command',300),lastRun=isoOr(j.lastRun),nextRun=isoOr(j.nextRun);
      const timezone=cleanTz(j.timezone),triggers=cleanTriggers(j.triggers),origin=pick(j.origin,JOB_ORIGINS,''),file=t('file',200),drift=t('drift',200),note=t('note',500);
      return {id:j.id,name:t('name',120)||j.id.slice(0,120),source:t('source',40)||'other',...(group?{group}:{}),schedule:t('schedule',200),...(cron?{cron}:{}),
        ...(timezone?{timezone}:{}),...(triggers.length?{triggers}:{}),...(origin?{origin}:{}),...(file?{file}:{}),...(drift?{drift}:{}),...(note?{note}:{}),
        ...(command?{command}:{}),ai:j.ai===true,enabled:j.enabled!==false,...(lastRun?{lastRun}:{}),lastStatus:pick(j.lastStatus,JOB_STATUS,'unknown'),...(nextRun?{nextRun}:{})};
    });
}
// Runners as they reported themselves: unique names, each with unique model ids and job ids.
export function cleanRunners(v){
  const seen=new Set();
  return (Array.isArray(v)?v:[]).filter(r=>r&&typeof r.name==='string'&&r.name.trim()).map(r=>({...r,name:r.name.trim().slice(0,200)}))
    .filter(r=>!seen.has(r.name.toLowerCase())&&seen.add(r.name.toLowerCase())).slice(0,LIMITS.runners).map(r=>{
      const ms=new Set();
      return {name:r.name,models:(Array.isArray(r.models)?r.models:[]).filter(m=>m&&typeof m.id==='string'&&m.id.trim()).map(m=>{
        const provider=str(m.provider,80).trim();
        return {id:m.id.trim().slice(0,120),label:str(m.label,160).trim(),...(provider?{provider}:{}),...(Object.hasOwn(BILLING,m.billing)?{billing:m.billing}:{})};
      })
        .filter(m=>!ms.has(m.id)&&ms.add(m.id)).slice(0,LIMITS.models),jobs:cleanJobs(r.jobs),...(cleanTz(r.timezone)?{timezone:cleanTz(r.timezone)}:{}),reported:iso(r.reported,new Date().toISOString()),
        ...(isoOr(r.jobsReported)?{jobsReported:isoOr(r.jobsReported)}:{})};
    });
}
// A runner's report (runners.report) against what is stored (had, or null): {runner, changed}.
// models replace the old list; left out (undefined), the stored models stay (a runner reporting
// another machine's jobs knows no models for it). jobs replace the old list too; left out, the
// stored jobs stay. Not every report is saved: changed is false, and had comes back as it is, when nothing
// changed but lastRun and nextRun, unless the jobs were last saved JOBS_STALE ago or more (then those
// are refreshed). A changed lastStatus, job set or any other field (timezone, triggers, drift, note...)
// always saves. jobsReported is set whenever jobs are saved. timezone (the runner machine's zone) is
// kept as stored when left out.
export const JOBS_STALE=6*3600e3;
const steady=js=>JSON.stringify(js.map(({lastRun,nextRun,...j})=>j));
export function reportRunner(had,name,{models,jobs,timezone}={},now=new Date().toISOString()){
  const want=cleanRunners([{name,models:models===undefined?had?.models:models,jobs:jobs||[],timezone:timezone===undefined?had?.timezone:timezone}])[0],keep=jobs===undefined;
  let changed=!had||JSON.stringify(had.models)!==JSON.stringify(want.models)||(had.timezone||'')!==(want.timezone||'');
  if(had&&!keep&&!changed){
    const old=had.jobs||[],stale=!had.jobsReported||Date.parse(now)-Date.parse(had.jobsReported)>=JOBS_STALE;
    changed=steady(old)!==steady(want.jobs)||(stale&&JSON.stringify(old)!==JSON.stringify(want.jobs));
  }
  if(!changed)return {runner:had,changed:false};
  const at=keep?had?.jobsReported:now;
  return {runner:{name:had?.name||want.name,models:want.models,jobs:keep?had?.jobs||[]:want.jobs,...(want.timezone?{timezone:want.timezone}:{}),reported:now,...(at?{jobsReported:at}:{})},changed:true};
}
// Runners belong to the server: only runners.report changes them, so a whole-workspace save (a
// browser, an import, a relay) must not drop or roll back what a runner reported. A browser running
// older code may not know newer fields (it saved runners without their jobs), and a stale copy may
// carry an older report. The runners a save keeps (stored: what the server has; incoming: what the
// save holds), by name: a stored runner stays as stored unless the incoming copy has a newer report
// (reported), and even then keeps its stored jobs if the incoming copy has none (no jobs field) or
// older ones (jobsReported). Stored runners the save left out stay; new ones (an import) are added.
// {runners, changed}: changed is true when the result differs from the incoming runners.
const time=v=>{const t=Date.parse(v);return Number.isFinite(t)?t:0};
export function keepRunners(stored,incoming){
  const have=Array.isArray(stored)?stored.filter(r=>r&&typeof r.name==='string'):[],sent=Array.isArray(incoming)?incoming.filter(r=>r&&typeof r.name==='string'):[];
  if(!have.length)return {runners:Array.isArray(incoming)?incoming:[],changed:false};
  const key=r=>r.name.trim().toLowerCase(),byName=new Map(sent.map(r=>[key(r),r])),out=[];
  for(const s of have){
    const r=byName.get(key(s));byName.delete(key(s));
    if(!r||time(r.reported)<=time(s.reported)){out.push(s);continue}
    const jobsOld=s.jobs?.length&&(!Array.isArray(r.jobs)||time(r.jobsReported)<time(s.jobsReported));
    out.push(jobsOld?{...r,jobs:s.jobs,...(s.jobsReported?{jobsReported:s.jobsReported}:{})}:r);
  }
  out.push(...[...byName.values()].slice(0,Math.max(0,LIMITS.runners-out.length)));
  return {runners:out,changed:JSON.stringify(out)!==JSON.stringify(Array.isArray(incoming)?incoming:[])};
}
// keepRunners for whole workspaces: {data, changed}, data being incoming with the runners to keep
// (incoming itself when nothing changed).
export function carryRunners(stored,incoming){
  const k=keepRunners(stored?.agentflow?.runners,incoming?.agentflow?.runners);
  if(!k.changed||!incoming||typeof incoming!=='object')return {data:incoming,changed:false};
  const af=incoming.agentflow&&typeof incoming.agentflow==='object'?incoming.agentflow:{};
  return {data:{...incoming,agentflow:{...af,runners:k.runners}},changed:true};
}
export const runnerOf=(af,name)=>{const n=String(name??'').trim().toLowerCase();return n?(af?.runners||[]).find(r=>r.name.toLowerCase()===n)||null:null};
// An agent's model ids in order. Agents not yet cleaned may only have model.
const idsOf=a=>Array.isArray(a.models)&&a.models.length?a.models:a.model?[a.model]:[];
// The agent's models in order, as {id,label,provider,billing}: label, provider and billing from its
// runner's report, else the id as the label and '' for the rest.
export function modelChoices(af,a){
  const r=runnerOf(af,a.runtime);
  return idsOf(a).map(id=>{const m=r?.models.find(x=>x.id===id);return {id,label:m?.label||id,provider:m?.provider||'',billing:m?.billing||''}});
}
// Who made a model (not which harness runs it), for its icon: {key,name,letter}. Read from the model
// part of "<providerInstance>:<model>" and the label, so "cursor:claude-opus-5-5" is Anthropic and
// "opencode:orcarouter/openai/gpt-5.4-mini" is OpenAI. Router "default"/"auto" models are auto. A
// single-maker harness (claude, codex, gemini, grok) is the last hint; else key 'other' with a letter.
const MAKERS=[
  ['anthropic','Anthropic',/anthropic|claude|\b(opus|sonnet|haiku)\b/],
  ['openai','OpenAI',/openai|chatgpt|\bgpt|codex|(^|[^a-z0-9])o\d($|[^a-z0-9])/],
  ['google','Google Gemini',/google|gemini|gemma/],
  ['xai','xAI',/\bx-?ai\b|grok/],
  ['meta','Meta',/meta-llama|llama|(^|\/)meta\//],
  ['qwen','Qwen',/qwen|qwq|alibaba/],
  ['deepseek','DeepSeek',/deepseek/],
  ['mistral','Mistral',/mistral|mixtral|[cd]evstral|codestral|magistral/],
  ['moonshot','Moonshot Kimi',/moonshot|kimi/],
  ['zhipu','Zhipu GLM',/zhipu|\bz-ai\b|glm/],
  ['abliterated','Abliterated',/abliterat/],
  ['cursor','Cursor',/composer|^cursor(-|\/|$)/],
];
const AUTO_IDS=new Set(['default','auto','auto-smart']);
export function modelMaker(id,label=''){
  const s=String(id??'').trim(),i=s.indexOf(':'),host=i>0?s.slice(0,i).toLowerCase():'',model=(i>0?s.slice(i+1):s).trim().toLowerCase();
  const lab=String(label??'').trim(),text=`${model} ${lab.toLowerCase()===s.toLowerCase()?'':lab.toLowerCase()}`;
  if(AUTO_IDS.has(model.split('/').pop())||/^auto\b/i.test(lab))return {key:'auto',name:'Auto',letter:''};
  for(const [key,name,re] of MAKERS)if(re.test(text))return {key,name,letter:''};
  const h=[['claude','anthropic'],['codex','openai'],['gemini','google'],['antigravity','google'],['grok','xai']].find(([k])=>host.startsWith(k));
  if(h){const [key,name]=MAKERS.find(m=>m[0]===h[1]);return {key,name,letter:''}}
  const word=(lab&&lab!==s?lab:model.split('/').pop()||host)||'',letter=(word.match(/[a-z0-9]/i)?.[0]||'?').toUpperCase();
  return {key:'other',name:'',letter};
}
// What the org card shows under the title: where it runs and on which model (the primary model's
// label when its runner reported one, "+N" for fallbacks, or "Auto (N models)"). Empty for neither.
export const modelLabel=(af,a)=>modelChoices(af,a)[0]?.label||'';
export function runLine(af,a){
  if(a.kind==='automation')return String(a.schedule||'').trim();
  const n=idsOf(a).length;
  const model=!n?'':a.auto?`Auto (${n} model${n===1?'':'s'})`:`${modelLabel(af,a).trim()}${n>1?` +${n-1}`:''}`;
  return [a.runtime.trim(),model].filter(Boolean).join(' · ');
}
// Why a live agent would be skipped by its runner, or '' when it is ready.
export function liveProblem(af,a){
  // Automations need no runner or model: they run on their own schedule, outside Flow, and are
  // never live, so nothing is missing.
  if(a.kind==='automation')return '';
  if(a.kind!=='agent')return 'Only AI agents run';
  if(!a.runtime.trim())return 'Pick where it runs';
  if(!idsOf(a).length)return 'Pick a model';
  const r=runnerOf(af,a.runtime),miss=r&&r.models.length&&modelChoices(af,a).find(m=>!r.models.some(x=>x.id===m.id));
  if(miss)return `${r.name} did not report ${miss.label}`;
  return '';
}

export function newAgent(af,over={}){
  const now=new Date().toISOString();
  const a={id:id(),name:'New agent',kind:'agent',title:'',status:'draft',live:false,reportsTo:'',supervisor:'',purpose:'',instructions:'',runtime:'',models:[],model:'',auto:false,schedule:'',
    inputs:[],outputs:[],tools:[],projects:[],cards:[],items:[],created:now,updated:now,...over};
  af.agents.push(a);return a;
}
export function newWorkflow(af,over={}){
  const now=new Date().toISOString();
  const w={id:id(),name:'New workflow',description:'',status:'draft',trigger:'manual',schedule:'',steps:[],projects:[],cards:[],items:[],created:now,updated:now,...over};
  af.workflows.push(w);return w;
}
export const newStep=(over={})=>({id:id(),agent:'',action:'',output:'',...over});
// A copy of a workflow with new ids (its own and every step's), placed right after the original.
// The caller checks full(af,'workflows') first.
export function duplicateWorkflow(af,workflowId){
  const i=af.workflows.findIndex(w=>w.id===workflowId);if(i<0)return null;
  const w=af.workflows[i],now=new Date().toISOString();
  const copy={...structuredClone(w),id:id(),name:`${w.name} (copy)`.slice(0,120),steps:w.steps.map(s=>({...s,id:id()})),created:now,updated:now};
  af.workflows.splice(i+1,0,copy);return copy;
}

// ---------- the org tree ----------
export const agentOf=(af,agentId)=>af.agents.find(a=>a.id===agentId)||null;
export const reportsOf=(af,agentId)=>af.agents.filter(a=>a.reportsTo===agentId);
export const rootsOf=af=>af.agents.filter(a=>!a.reportsTo);
// Every agent below this one (the ones it may not report to).
export function descendants(af,agentId){
  const out=new Set(),todo=[agentId];
  while(todo.length){const cur=todo.pop();for(const a of af.agents)if(a.reportsTo===cur&&!out.has(a.id)){out.add(a.id);todo.push(a.id)}}
  return out;
}
// The chain of managers above an agent, nearest first.
export function chainOf(af,agentId){
  const out=[];let a=agentOf(af,agentId);
  while(a?.reportsTo&&out.length<af.agents.length){a=agentOf(af,a.reportsTo);if(!a)break;out.push(a)}
  return out;
}
export const canReportTo=(af,agentId,managerId)=>!managerId||(managerId!==agentId&&!!agentOf(af,managerId)&&!descendants(af,agentId).has(managerId));
// Remove an agent: its reports move up to its manager, and workflow steps it ran become unassigned.
export function removeAgent(af,agentId){
  const a=agentOf(af,agentId);if(!a)return false;
  for(const r of af.agents)if(r.reportsTo===agentId)r.reportsTo=a.reportsTo;
  for(const w of af.workflows)for(const s of w.steps)if(s.agent===agentId)s.agent='';
  af.agents=af.agents.filter(x=>x.id!==agentId);return true;
}
export const workflowsFor=(af,agentId)=>af.workflows.filter(w=>w.steps.some(s=>s.agent===agentId));
export const agentsForCard=(af,cardId)=>(af?.agents||[]).filter(a=>a.cards.includes(cardId));
// Delegate a card to exactly these agents (the link lives on each agent's cards list). Checks room
// first: returns the first agent that is full and changes nothing, else null.
export function delegate(af,cardId,agentIds){
  const want=new Set(agentIds),now=new Date().toISOString();
  const over=af.agents.find(a=>want.has(a.id)&&!a.cards.includes(cardId)&&a.cards.length>=LIMITS.refs);if(over)return over;
  for(const a of af.agents){const has=a.cards.includes(cardId);if(has!==want.has(a.id)){a.cards=has?a.cards.filter(x=>x!==cardId):[...a.cards,cardId];a.updated=now}}
  return null;
}
// An agent's work queue: open cards delegated to it. Work in progress first, then new requests,
// then cards waiting on others (Blocked, UAT), then the backlogs; within each, soonest due, then #number.
export const QUEUE_ORDER=['doing','requests','blocked','uat','must','nice'];
export function workQueue(db,agentId){
  const a=agentOf(db.agentflow,agentId);if(!a)return [];
  const ids=new Set(a.cards),rank=c=>{const i=QUEUE_ORDER.indexOf(c.column);return i<0?QUEUE_ORDER.length:i};
  return (db.devops?.cards||[]).filter(c=>ids.has(c.id)&&c.column!=='done').sort((x,y)=>rank(x)-rank(y)||(x.due||'9999').localeCompare(y.due||'9999')||x.number-y.number);
}

// ---------- scheduled jobs ----------
// Every job every runner reported, each with its runner's name: {...job, runner}.
export const jobsOf=af=>(af?.runners||[]).flatMap(r=>(r.jobs||[]).map(j=>({...j,runner:r.name})));
export const jobOf=(af,runner,jobId)=>{const r=runnerOf(af,runner);return r&&(r.jobs||[]).find(j=>j.id===jobId)||null};
// Jobs for display, grouped by runner and then by the job's group: [{key, label, runner, jobs[]}],
// sorted by runner name, then group (a runner's ungrouped jobs first, labelled with the runner),
// and jobs by name.
const byText=(x,y)=>x.localeCompare(y,undefined,{sensitivity:'base',numeric:true});
export function jobGroups(af){
  const m=new Map();
  for(const r of af?.runners||[])for(const j of r.jobs||[]){
    const g=j.group||'',key=JSON.stringify([r.name,g]);
    if(!m.has(key))m.set(key,{key,label:g||r.name,runner:r.name,group:g,jobs:[]});
    m.get(key).jobs.push({...j,runner:r.name});
  }
  const out=[...m.values()].sort((x,y)=>byText(x.runner,y.runner)||(!y.group)-(!x.group)||byText(x.group,y.group));
  for(const g of out){g.jobs.sort((x,y)=>byText(x.name,y.name)||byText(x.id,y.id));delete g.group}
  return out;
}
const sameJob=(l,runner,jobId)=>!!l&&l.id===jobId&&l.runner.toLowerCase()===String(runner??'').trim().toLowerCase();
// The agent promoted from a runner's job, or null.
export const promotedAgent=(af,runner,jobId)=>(af?.agents||[]).find(a=>sameJob(a.job,runner,jobId))||null;
// Promote a runner's job into the org: a new agent linked to it (job: {runner, id}). An AI job becomes
// an AI agent (runtime: the runner, no models yet: pick them), any other an automation. Named after the
// job, its role from the source ("Vercel cron"), its schedule the job's (or its cron line), its purpose
// the job's command; active when the job is enabled, else paused; never live. opts: reportsTo (an
// agent id, else top level) and x, y (a canvas position; the rest are pinned first).
// A job is promoted once: promoting it again returns the agent it already became and changes nothing.
// Returns null when the job is unknown or the workspace is at LIMITS.agents.
export function promoteJob(af,runner,jobId,{reportsTo='',x,y}={}){
  const had=promotedAgent(af,runner,jobId);if(had)return had;
  const r=runnerOf(af,runner),j=r&&(r.jobs||[]).find(q=>q.id===jobId);
  if(!j||af.agents.length>=LIMITS.agents)return null;
  const at=Number.isFinite(x)&&Number.isFinite(y);if(at)pin(af);
  const src=String(j.source||'other').toLowerCase();
  return newAgent(af,{name:j.name.slice(0,120)||'Untitled job',kind:j.ai?'agent':'automation',title:(JOB_SOURCES[src]||`${j.source} job`).slice(0,120),
    status:j.enabled===false?'paused':'active',schedule:(j.schedule||j.cron||'').slice(0,200),runtime:j.ai?r.name:'',purpose:(j.command||'').slice(0,2000),
    job:{runner:r.name,id:j.id},reportsTo:agentOf(af,reportsTo)?reportsTo:'',...(at?{x:clampXY(x),y:clampXY(y)}:{})});
}

// ---------- canvas layout ----------
// Card size on the canvas and the spacing of the automatic tree.
export const CARD={w:216,h:96,auto:76},STEP={x:240,y:152};
// An automation's card is shorter (no models or counts); it keeps the same top edge and slot.
export const cardH=a=>a?.kind==='automation'?CARD.auto:CARD.h;
// A manager with STACK.min or more reports that have no reports of their own lists those in
// columns of up to STACK.rows, indented under it, so a big team doesn't stretch the chart sideways.
export const STACK={min:3,rows:6,y:CARD.h+20,indent:24};
const teams=af=>{
  const kids=new Map(af.agents.map(a=>[a.id,[]]));
  for(const a of af.agents)if(a.reportsTo&&kids.has(a.reportsTo)&&a.reportsTo!==a.id)kids.get(a.reportsTo).push(a);
  return kids;
};
// The agents drawn in a stacked column (their reporting line enters from the side).
export function stacked(af){
  const kids=teams(af),out=new Set();
  for(const list of kids.values()){
    const leaves=list.filter(k=>!kids.get(k.id).length);
    if(leaves.length>=STACK.min)for(const k of leaves)out.add(k.id);
  }
  return out;
}
// A tidy tree: each manager centred over its reports, root trees side by side. Reports without
// reports of their own are stacked in columns (left) when there are STACK.min or more of them.
export function treeLayout(af){
  const out=new Map(),kids=teams(af),gap=STEP.x-CARD.w,col=STEP.x+STACK.indent;
  const place=(a,x0,y)=>{
    if(out.has(a.id))return 0;
    out.set(a.id,{x:x0,y});
    const list=kids.get(a.id).filter(k=>!out.has(k.id));
    if(!list.length)return STEP.x;
    const leaves=list.filter(k=>!kids.get(k.id).length),stack=leaves.length>=STACK.min;
    let x=x0;
    if(stack){
      leaves.forEach((k,i)=>out.set(k.id,{x:x0+Math.floor(i/STACK.rows)*col+STACK.indent,y:y+STEP.y+(i%STACK.rows)*STACK.y}));
      x+=Math.ceil(leaves.length/STACK.rows)*col;
    }
    for(const k of list)if(!stack||!leaves.includes(k))x+=place(k,x,y+STEP.y);
    const w=Math.max(STEP.x,x-x0);
    out.get(a.id).x=x0+(w-gap-CARD.w)/2;
    return w;
  };
  let x=0;
  for(const a of af.agents)if(!a.reportsTo||!kids.has(a.reportsTo))x+=place(a,x,0);
  for(const a of af.agents)if(!out.has(a.id))x+=place(a,x,0); // only reachable through a loop
  return out;
}
// Where each agent is drawn: the tree until someone arranges the canvas; after that, saved
// positions, and agents without one (added through the API) go under their manager, else to
// the right, in the first free spot.
export function positions(af){
  if(!af.agents.some(placed))return treeLayout(af);
  const out=new Map(),taken=[];
  const free=(x,y)=>!taken.some(p=>Math.abs(p.x-x)<CARD.w+8&&Math.abs(p.y-y)<CARD.h+8);
  for(const a of af.agents)if(placed(a)){const p={x:a.x,y:a.y};out.set(a.id,p);taken.push(p)}
  const todo=af.agents.filter(a=>!out.has(a.id)),ids=new Set(af.agents.map(a=>a.id));
  while(todo.length){
    const i=Math.max(0,todo.findIndex(a=>!ids.has(a.reportsTo)||out.has(a.reportsTo))),a=todo.splice(i,1)[0],m=out.get(a.reportsTo);
    let x=m?m.x:Math.max(...taken.map(p=>p.x))+STEP.x,y=m?m.y+STEP.y:Math.min(...taken.map(p=>p.y));
    // Under a manager that already has reports drawn, continue the column below the last one.
    const sib=m&&af.agents.filter(s=>s.reportsTo===a.reportsTo&&s.id!==a.id&&out.has(s.id)).map(s=>out.get(s.id)).filter(p=>p.y>m.y).at(-1);
    if(sib&&!free(x,y)){x=sib.x;y=sib.y+STACK.y;while(!free(x,y))y+=STACK.y}
    while(!free(x,y))x+=STEP.x;
    const p={x,y};out.set(a.id,p);taken.push(p);
  }
  return out;
}
// Reporting lines, consolidated per manager: one trunk down from the manager, one shared bus across
// its reports and a short drop to each (a stacked column gets one spine with a stub per card), so
// no segment is drawn twice. A report that sits above or beside its manager (arranged by hand)
// gets its own curve instead. side: the ids drawn in stacked columns (stacked()).
// Returns pieces [{pts, radii, owners}] (owners: the report ids a piece serves, null when shared by
// the whole bundle; curve pieces carry d instead of pts) and routes: report id -> its own path from
// the manager, through the shared segments (for hit areas and highlighting the chain).
const BEND=8,near=(a,b)=>Math.abs(a-b)<.5;
// A polyline with rounded corners: radii[i] is the radius at point i (0: a sharp corner).
export function pathOf(pts,radii=[]){
  const p=pts.filter((q,i)=>!i||!(near(q.x,pts[i-1].x)&&near(q.y,pts[i-1].y))),f=n=>Math.round(n*10)/10;
  if(p.length<2)return '';
  let d=`M${f(p[0].x)} ${f(p[0].y)}`;
  for(let i=1;i<p.length-1;i++){
    const a=p[i-1],b=p[i],c=p[i+1],l1=Math.hypot(b.x-a.x,b.y-a.y),l2=Math.hypot(c.x-b.x,c.y-b.y),r=Math.min(radii[pts.indexOf(b)]||0,l1,l2);
    if(near((b.x-a.x)*(c.y-b.y),(b.y-a.y)*(c.x-b.x)))continue; // straight on
    if(r<.5){d+=`L${f(b.x)} ${f(b.y)}`;continue}
    d+=`L${f(b.x+(a.x-b.x)/l1*r)} ${f(b.y+(a.y-b.y)/l1*r)}Q${f(b.x)} ${f(b.y)} ${f(b.x+(c.x-b.x)/l2*r)} ${f(b.y+(c.y-b.y)/l2*r)}`;
  }
  const z=p.at(-1);return d+`L${f(z.x)} ${f(z.y)}`;
}
// A report arranged above or beside its manager: one curve between the facing edges.
function curve(m,r){
  const W=CARD.w,H=CARD.h,c=(x1,y1,x2,y2,h)=>{const k=Math.max(40,Math.abs(h?x2-x1:y2-y1)/2),s=h?Math.sign(x2-x1):Math.sign(y2-y1)||1;
    return h?`M${x1} ${y1}C${x1+s*k} ${y1} ${x2-s*k} ${y2} ${x2} ${y2}`:`M${x1} ${y1}C${x1} ${y1+s*k} ${x2} ${y2-s*k} ${x2} ${y2}`};
  if(r.y+H<=m.y)return c(m.x+W/2,m.y,r.x+W/2,r.y+H,false); // above: top to bottom
  if(r.x>=m.x+W)return c(m.x+W,m.y+H/2,r.x,r.y+H/2,true); // to the right: side to side
  if(r.x+W<=m.x)return c(m.x,m.y+H/2,r.x+W,r.y+H/2,true); // to the left
  return c(m.x+W/2,m.y+H,r.x+W/2,r.y,false);
}
export function reportLines(af,pos,side=stacked(af)){
  const pieces=[],routes=new Map(),byManager=new Map(),byId=new Map(af.agents.map(a=>[a.id,a]));
  for(const a of af.agents)if(a.reportsTo&&a.reportsTo!==a.id&&pos.has(a.reportsTo)&&pos.has(a.id)){
    if(!byManager.has(a.reportsTo))byManager.set(a.reportsTo,[]);byManager.get(a.reportsTo).push(a);
  }
  for(const [mid,reps] of byManager){
    const m=pos.get(mid),x1=m.x+CARD.w/2,y1=m.y+cardH(byId.get(mid));
    const below=[];
    for(const a of reps){const r=pos.get(a.id);if(r.y-y1>=24)below.push(a);else{const d=curve(m,r);pieces.push({d,owners:[a.id]});routes.set(a.id,d)}}
    if(!below.length)continue;
    const ym=y1+Math.min(28,Math.min(...below.map(a=>pos.get(a.id).y-y1))/2),bundle=below.map(a=>a.id);
    // Branches off the bus: a drop to the card(s) below one x, or a spine beside a stacked column.
    const br=new Map();
    for(const a of below){
      const r=pos.get(a.id),s=side.has(a.id),x=s?r.x-STACK.indent/2:r.x+CARD.w/2,k=`${s?'s':'d'}${Math.round(x*2)}`;
      if(!br.has(k))br.set(k,{x,spine:s,end:ym,stubs:[],owners:[]});
      const b=br.get(k);b.owners.push(a.id);
      if(s){const y=r.y+CARD.h/2;b.stubs.push({y,x:r.x,id:a.id});b.end=Math.max(b.end,y)}else b.end=Math.max(b.end,r.y);
    }
    const list=[...br.values()],xs=[x1,...list.map(b=>b.x)],xL=Math.min(...xs),xR=Math.max(...xs),bus=!near(xL,xR);
    // The trunk runs straight on into a branch right below it (no corner, no bus end there).
    const thru=list.find(b=>near(b.x,x1));
    // Corner radius where the bus turns at either end.
    const vlen=x=>near(x,x1)?(thru?0:ym-y1):Math.max(...list.filter(b=>near(b.x,x)).map(b=>b.end-ym));
    const rad=x=>bus?Math.min(BEND,(xR-xL)/2,vlen(x)/2):0,rL=rad(xL),rR=rad(xR);
    const rAt=x=>near(x,xL)?rL:near(x,xR)?rR:0;
    // A branch from the bus outwards (spines end in a rounded turn into their deepest stub).
    const tail=b=>{
      if(!b.spine)return {pts:[{x:b.x,y:b.end}],radii:[0]};
      const last=b.stubs.reduce((p,q)=>q.y>p.y?q:p),rb=Math.min(BEND,(b.end-ym)/2,last.x-b.x);
      return {pts:[{x:b.x,y:b.end},{x:last.x,y:b.end}],radii:[rb,0]};
    };
    // The trunk: straight down to the bus, or turning into it where the manager sits at one end.
    const tEnd=bus&&!thru&&(near(x1,xL)||near(x1,xR)),tR=tEnd?rAt(x1):0,tDir=near(x1,xL)?1:-1;
    pieces.push({pts:[...(tEnd?[{x:x1+tDir*tR,y:ym}]:[]),{x:x1,y:ym},{x:x1,y:y1}],radii:[0,tR,0],owners:null,bundle});
    if(bus)pieces.push({pts:[{x:xL+rL,y:ym},{x:xR-rR,y:ym}],radii:[],owners:null,bundle});
    for(const b of list){
      const t=tail(b),r=b===thru?0:rAt(b.x),dir=near(b.x,xL)?1:-1,head=r?[{x:b.x+dir*r,y:ym},{x:b.x,y:ym}]:[{x:b.x,y:ym}];
      pieces.push({pts:[...head,...t.pts],radii:[...(r?[0,r]:[0]),...t.radii],owners:b.owners});
      if(b.spine)for(const s of b.stubs)if(!near(s.y,b.end))pieces.push({pts:[{x:b.x,y:s.y},{x:s.x,y:s.y}],radii:[],owners:[s.id]});
    }
    // Each report's own route: down the trunk, along the bus, down its branch (into its stub).
    const trunkR=tR;
    for(const b of list)for(const id of b.owners){
      const r=pos.get(id),s=b.stubs.find(q=>q.id===id),bR=b===thru?0:rAt(b.x),deep=s&&near(s.y,b.end);
      const pts=[{x:x1,y:y1},{x:x1,y:ym},{x:b.x,y:ym},...(s?[{x:b.x,y:s.y},{x:r.x,y:s.y}]:[{x:b.x,y:r.y}])];
      const radii=[0,trunkR,bR,...(s?[deep?tail(b).radii[0]:0,0]:[0])];
      routes.set(id,pathOf(pts,radii));
    }
  }
  return {pieces,routes};
}
// Save the drawn position of every agent that has none (before the first manual move), so
// arranging one card never makes the others jump.
export function pin(af){
  const p=positions(af);
  for(const a of af.agents)if(!placed(a)){const q=p.get(a.id);a.x=clampXY(q.x);a.y=clampXY(q.y)}
}
export function unpin(af){for(const a of af.agents){delete a.x;delete a.y}}

// ---------- linked Flow work ----------
// Cards linked directly, then open cards in linked projects (most urgent due date first).
export function workFor(db,x){
  const all=db.devops?.cards||[],direct=new Set(x.cards);
  const cards=[...all.filter(c=>direct.has(c.id)),...all.filter(c=>!direct.has(c.id)&&c.column!=='done'&&x.projects.includes(c.project))];
  const items=(db.timeline||[]).filter(i=>x.items.includes(i.id)).sort((a,b)=>(a.start||'9999').localeCompare(b.start||'9999'));
  return {cards,items,projects:(db.projects||[]).filter(p=>x.projects.includes(p.id))};
}
export const openWork=(db,x)=>workFor(db,x).cards.filter(c=>c.column!=='done').length;

// What would go over a limit: '' when there is room. kind: 'agents', 'workflows', 'steps' (of x), 'list' (x[key])
// or 'refs' (x[key], links to projects, cards or items).
export function full(af,kind,x,key){
  if(kind==='agents'||kind==='workflows')return af[kind].length>=LIMITS[kind]?`A workspace holds up to ${LIMITS[kind]} ${kind}.`:'';
  if(kind==='steps')return x.steps.length>=LIMITS.steps?`A workflow holds up to ${LIMITS.steps} steps.`:'';
  if(kind==='refs')return x[key].length>=LIMITS.refs?`Up to ${LIMITS.refs} linked ${key} each.`:'';
  return x[key].length>=LIMITS.list?`Up to ${LIMITS.list} ${key} per agent.`:'';
}

// filter = {q, status, kind, project}. q matches name, title, purpose, inputs, outputs and tools.
export function filterAgents(af,f={}){
  const q=String(f.q||'').trim().toLowerCase();
  return af.agents.filter(a=>(!f.status||a.status===f.status)&&(!f.kind||a.kind===f.kind)&&(f.live===undefined||a.live===f.live)&&(!f.project||a.projects.includes(f.project))
    &&(!q||[a.name,a.title,a.purpose,a.schedule||'',...a.inputs,...a.outputs,...a.tools].some(s=>s.toLowerCase().includes(q))));
}
export function filterWorkflows(af,f={}){
  const q=String(f.q||'').trim().toLowerCase();
  return af.workflows.filter(w=>(!f.status||w.status===f.status)&&(!f.agent||w.steps.some(s=>s.agent===f.agent))&&(!f.project||w.projects.includes(f.project))
    &&(!q||[w.name,w.description,w.schedule,...w.steps.map(s=>s.action)].some(s=>s.toLowerCase().includes(q))));
}

// ---------- briefs ----------
// Markdown handed to whatever runs the agent or workflow: who it is, what it takes and produces,
// who it answers to and what Flow work it owns right now.
const bullets=(xs,empty='None')=>xs.length?xs.map(x=>`- ${x}`).join('\n'):`- ${empty}`;
const colName=(db,c)=>db.devops?.columns?.find(x=>x.id===c.column)?.name||c.column;
const cardLine=(db,c)=>`#${c.number} ${c.title} (${colName(db,c)}${c.due?`, due ${c.due}`:''})`;
const itemLine=i=>`${i.title} (${i.kind}${i.start?`, ${i.start}${i.end?` to ${i.end}`:''}`:', unscheduled'}, ${i.status})`;
function workSection(db,x){
  const w=workFor(db,x);
  return `## Linked Flow work\n\nProjects:\n${bullets(w.projects.map(p=>p.name))}\n\nCards:\n${bullets(w.cards.map(c=>cardLine(db,c)))}\n\nTimeline and deadlines:\n${bullets(w.items.map(itemLine))}`;
}
const modelText=m=>m.label!==m.id?`${m.label} (${m.id})`:m.id;
// Model lines for the brief: one model, the primary and fallbacks in order, or the auto pool.
const runtimeModels=(auto,ms)=>!ms.length?[]:auto?[`- Auto from: ${ms.map(modelText).join(', ')} (the runner picks one per card)`]
  :ms.length===1?[`- Model: ${modelText(ms[0])}`]:ms.map((m,i)=>`- Model ${i+1}: ${modelText(m)} (${i?'fallback':'primary'})`);
export function agentBrief(db,agentId){
  const af=db.agentflow,a=agentOf(af,agentId);if(!a)return '';
  const ms=a.kind==='automation'?[]:modelChoices(af,a),job=a.job&&jobOf(af,a.job.runner,a.job.id);
  const runtime=[...(a.runtime?[`- Runs on: ${a.runtime}`]:[]),...runtimeModels(a.auto,ms),...(a.schedule?.trim()?[`- Schedule: ${a.schedule.trim()}`]:[]),
    ...(a.job?[`- Promoted from: ${a.job.runner} · ${job?`${job.name}${job.command?` (${job.command})`:''}`:`${a.job.id} (no longer reported)`}`]:[])];
  const name=x=>x?`${x.name}${x.title?` (${x.title})`:''}`:'';
  const boss=agentOf(af,a.reportsTo),sup=peopleOf(db).find(n=>n.id===a.supervisor);
  const flows=workflowsFor(af,a.id).map(w=>{const steps=w.steps.map((s,i)=>s.agent===a.id?`step ${i+1}: ${s.action||'(no action)'}`:'').filter(Boolean);return `${w.name}: ${steps.join('; ')}`});
  return [`# ${a.name}`,
    `${AGENT_KINDS[a.kind]}${a.title?` · ${a.title}`:''} · ${AGENT_STATUS[a.status]}${a.kind==='agent'?` · ${a.live?'Live':'Not live'}`:''}`,
    `## Purpose\n\n${a.purpose.trim()||'Not written yet.'}`,
    `## Reporting\n\n- Reports to: ${name(boss)||'Nobody (top of the org)'}\n- Supervised by: ${sup?.name||'Nobody assigned'}\n- Direct reports: ${reportsOf(af,a.id).map(name).join(', ')||'None'}`,
    `## Inputs\n\n${bullets(a.inputs)}`,`## Outputs\n\n${bullets(a.outputs)}`,`## Tools\n\n${bullets(a.tools)}`,
    ...(runtime.length?[`## Runtime\n\n${runtime.join('\n')}`]:[]),
    `## Workflows\n\n${bullets(flows)}`,
    workSection(db,a),
    ...(a.instructions.trim()?[`## Instructions\n\n${a.instructions.trim()}`]:[]),
  ].join('\n\n')+'\n';
}
export function workflowBrief(db,workflowId){
  const af=db.agentflow,w=af.workflows.find(x=>x.id===workflowId);if(!w)return '';
  const trig=w.trigger==='manual'?'Started by hand':`${TRIGGERS[w.trigger]}${w.schedule?`: ${w.schedule}`:''}`;
  const steps=w.steps.map((s,i)=>{const a=agentOf(af,s.agent);return `${i+1}. **${a?a.name:'Unassigned'}**: ${s.action||'(no action)'}${s.output?` → ${s.output}`:''}`});
  return [`# ${w.name}`,`Workflow · ${WORKFLOW_STATUS[w.status]} · ${trig}`,
    ...(w.description.trim()?[w.description.trim()]:[]),
    `## Steps\n\n${steps.length?steps.join('\n'):'No steps yet.'}`,
    workSection(db,w)].join('\n\n')+'\n';
}

// A small starting org, so a new AgentFlow is not a blank page. Generic on purpose.
export function starterAgentflow(af){
  const lead=newAgent(af,{name:'Chief of staff',title:'Orchestrator',status:'draft',purpose:'Turns goals and incoming requests into cards, assigns them to the right agent and reports progress.',
    inputs:['New requests','Goals and deadlines'],outputs:['Prioritised DevOps cards','Weekly status summary'],tools:['Flow API / MCP']});
  const research=newAgent(af,{name:'Researcher',title:'Research',reportsTo:lead.id,purpose:'Gathers context and options before work starts.',inputs:['A card that needs research'],outputs:['Research notes on the card']});
  const build=newAgent(af,{name:'Builder',title:'Engineering',reportsTo:lead.id,purpose:'Implements cards and opens pull requests.',inputs:['A card in Doing','Research notes'],outputs:['Pull request linked on the card'],tools:['Git','Code editor']});
  const qa=newAgent(af,{name:'Reviewer',title:'Quality',reportsTo:lead.id,purpose:'Reviews and tests finished work, then moves it to UAT.',inputs:['A pull request'],outputs:['Review notes','Card moved to UAT']});
  newWorkflow(af,{name:'Ship a card',description:'From a new request to a change ready for approval.',trigger:'event',schedule:'A card enters Doing',steps:[
    newStep({agent:lead.id,action:'Clarify the request and split it into cards',output:'Cards in Requests'}),
    newStep({agent:research.id,action:'Research the approach',output:'Notes on the card'}),
    newStep({agent:build.id,action:'Implement and open a pull request',output:'PR link on the card'}),
    newStep({agent:qa.id,action:'Review, test and move to UAT',output:'Card in UAT'})]});
  return lead;
}
