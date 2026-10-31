// AgentFlow data: an org chart of agents (AI agents, humans and teams) and the workflows they run.
// Defaults, validation and pure helpers (no DOM, no storage), so the server, the API and tests can
// use them in Node, as with devops-core.js.
//
// db.agentflow = {agents:[agent], workflows:[workflow]}
// agent    = {id,name,kind,title,status,reportsTo,supervisor,purpose,instructions,runtime,model,
//             inputs[],outputs[],tools[],projects[],cards[],items[],created,updated, x?,y?}
//   x, y: where the card sits on the AgentFlow canvas (optional; see positions()).
//   reportsTo: another agent (the AgentFlow org chart); supervisor: a person card on a Flow chart.
// workflow = {id,name,description,status,trigger,schedule,steps:[{id,agent,action,output}],
//             projects[],cards[],items[],created,updated}
// projects, cards and items point at Flow projects, DevOps cards and timeline items (deadlines).
// Flow records the design. Running agents is left to outside runners (T3, a home server, cron),
// which read it through the API or MCP; agentBrief() and workflowBrief() give them a briefing.

export const AGENT_KINDS={agent:'AI agent',human:'Human',team:'Team'};
export const AGENT_STATUS={draft:'Draft',active:'Active',paused:'Paused',retired:'Retired'};
export const WORKFLOW_STATUS={draft:'Draft',active:'Active',paused:'Paused'};
export const TRIGGERS={manual:'Manual',schedule:'Schedule',event:'Event'};
export const TRIGGER_HINT={manual:'Someone starts it',schedule:'e.g. Weekdays at 09:00',event:'e.g. A card enters UAT'};
export const LIMITS={agents:500,workflows:500,steps:100,list:50,refs:100};
// Ids of records shared in from another workspace. They are projected in on read and are not in
// stored data, so links to them are kept even when the record is not present (e.g. on the server).
const shared=x=>typeof x==='string'&&x.startsWith('sh.');

const str=(v,n)=>String(v??'').slice(0,n),id=()=>crypto.randomUUID();
const iso=(v,now)=>typeof v==='string'&&!Number.isNaN(Date.parse(v))?v:now;
const pick=(v,map,dflt)=>Object.hasOwn(map,v)?v:dflt;
// Short text lists (inputs, outputs, tools): trimmed, non-empty, unique.
const strs=(v,n=LIMITS.list,len=200)=>[...new Set((Array.isArray(v)?v:[]).filter(x=>typeof x==='string').map(x=>x.trim().slice(0,len)).filter(Boolean))].slice(0,n);
const refs=(v,ok)=>[...new Set((Array.isArray(v)?v:[]).filter(x=>typeof x==='string'&&(ok.has(x)||shared(x))))].slice(0,LIMITS.refs);

export const seedAgentflow=()=>({agents:[],workflows:[]});
const clampXY=v=>Math.max(-1e5,Math.min(1e5,Math.round(v)));
export const placed=a=>Number.isFinite(a?.x)&&Number.isFinite(a?.y);

// Every person card across the workspace's charts (supervisors are people).
export function peopleOf(db){
  const m=new Map();for(const c of db.charts||[])for(const n of c.nodes||[])if(n.type==='person'&&!m.has(n.id))m.set(n.id,n);
  return [...m.values()];
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
  const agents=(Array.isArray(d.agents)?d.agents:[]).filter(a=>a&&typeof a.id==='string'&&a.id&&typeof a.name==='string'&&!seen.has(a.id)&&seen.add(a.id)).slice(0,LIMITS.agents).map(a=>({
    id:a.id.slice(0,80),name:a.name.trim().slice(0,120)||'Untitled agent',kind:pick(a.kind,AGENT_KINDS,'agent'),title:str(a.title,120),status:pick(a.status,AGENT_STATUS,'draft'),
    reportsTo:typeof a.reportsTo==='string'?a.reportsTo:'',supervisor:typeof a.supervisor==='string'&&(people.has(a.supervisor)||shared(a.supervisor))?a.supervisor:'',
    purpose:str(a.purpose,2000),instructions:str(a.instructions,20000),runtime:str(a.runtime,200),model:str(a.model,120),
    inputs:strs(a.inputs),outputs:strs(a.outputs),tools:strs(a.tools),...links(a),created:iso(a.created,now),updated:iso(a.updated,now),
    ...(placed(a)?{x:clampXY(a.x),y:clampXY(a.y)}:{})}));
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
  return {agents,workflows};
}

export function newAgent(af,over={}){
  const now=new Date().toISOString();
  const a={id:id(),name:'New agent',kind:'agent',title:'',status:'draft',reportsTo:'',supervisor:'',purpose:'',instructions:'',runtime:'',model:'',
    inputs:[],outputs:[],tools:[],projects:[],cards:[],items:[],created:now,updated:now,...over};
  af.agents.push(a);return a;
}
export function newWorkflow(af,over={}){
  const now=new Date().toISOString();
  const w={id:id(),name:'New workflow',description:'',status:'draft',trigger:'manual',schedule:'',steps:[],projects:[],cards:[],items:[],created:now,updated:now,...over};
  af.workflows.push(w);return w;
}
export const newStep=(over={})=>({id:id(),agent:'',action:'',output:'',...over});

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

// ---------- canvas layout ----------
// Card size on the canvas and the spacing of the automatic tree.
export const CARD={w:188,h:76},STEP={x:212,y:128};
// A tidy tree: leaves side by side, each manager centred over its reports, root trees side by side.
export function treeLayout(af){
  const out=new Map(),kids=new Map(af.agents.map(a=>[a.id,[]]));
  for(const a of af.agents)if(a.reportsTo&&kids.has(a.reportsTo)&&a.reportsTo!==a.id)kids.get(a.reportsTo).push(a);
  let slot=0;
  const place=(a,depth)=>{
    if(out.has(a.id))return out.get(a.id).x;
    out.set(a.id,{x:0,y:depth*STEP.y});
    const xs=kids.get(a.id).map(k=>place(k,depth+1)).filter(x=>x!==undefined);
    const x=xs.length?(xs[0]+xs.at(-1))/2:slot++*STEP.x;
    out.get(a.id).x=x;return x;
  };
  for(const a of af.agents)if(!a.reportsTo||!kids.has(a.reportsTo))place(a,0);
  for(const a of af.agents)if(!out.has(a.id))place(a,0); // only reachable through a loop
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
    while(!free(x,y))x+=STEP.x;
    const p={x,y};out.set(a.id,p);taken.push(p);
  }
  return out;
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
  return af.agents.filter(a=>(!f.status||a.status===f.status)&&(!f.kind||a.kind===f.kind)&&(!f.project||a.projects.includes(f.project))
    &&(!q||[a.name,a.title,a.purpose,...a.inputs,...a.outputs,...a.tools].some(s=>s.toLowerCase().includes(q))));
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
export function agentBrief(db,agentId){
  const af=db.agentflow,a=agentOf(af,agentId);if(!a)return '';
  const name=x=>x?`${x.name}${x.title?` (${x.title})`:''}`:'';
  const boss=agentOf(af,a.reportsTo),sup=peopleOf(db).find(n=>n.id===a.supervisor);
  const flows=workflowsFor(af,a.id).map(w=>{const steps=w.steps.map((s,i)=>s.agent===a.id?`step ${i+1}: ${s.action||'(no action)'}`:'').filter(Boolean);return `${w.name}: ${steps.join('; ')}`});
  return [`# ${a.name}`,
    `${AGENT_KINDS[a.kind]}${a.title?` · ${a.title}`:''} · ${AGENT_STATUS[a.status]}`,
    `## Purpose\n\n${a.purpose.trim()||'Not written yet.'}`,
    `## Reporting\n\n- Reports to: ${name(boss)||'Nobody (top of the org)'}\n- Supervised by: ${sup?.name||'Nobody assigned'}\n- Direct reports: ${reportsOf(af,a.id).map(name).join(', ')||'None'}`,
    `## Inputs\n\n${bullets(a.inputs)}`,`## Outputs\n\n${bullets(a.outputs)}`,`## Tools\n\n${bullets(a.tools)}`,
    ...(a.runtime||a.model?[`## Runtime\n\n${a.runtime?`- Runs on: ${a.runtime}\n`:''}${a.model?`- Model: ${a.model}`:''}`.trim()]:[]),
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
