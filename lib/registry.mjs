// The operation registry: one list of operations drives the REST API (lib/api-v1.mjs), its
// OpenAPI document, MCP tools, the CLI and the docs. Each operation is plain data:
//   {id, method, path, scope:'read'|'write'|'admin', tags, summary, description, input, output, examples:[{title,input,output}]}
// `input` is one flat JSON Schema object holding the path parameters ({env}, {card}, ...), query
// parameters (GET/DELETE) and body fields (POST/PATCH) together, so MCP and the CLI pass one object.
// invoke(id, input, ctx) checks the input against that schema and runs the operation.
//   ctx = {user:{id,email}, store, envCheck(envId,user,'read'|'write')}
//   store: lib/workspaces.mjs workspaceStore(); envCheck: truthy when the user may read/write it.
// Errors are thrown as {status, code, message} (an Error carrying those fields).
//
// Writes are revision-checked: read the workspace, change a copy, clean it with the client's own
// cleaners (lib/cleaners.mjs, public/devops-core.js), then store.put() with the revision it started
// from. If someone saved in between, the change is re-applied to the newer copy (up to 5 times).
// References accept an id or a name (project, label, person, entity, timeline item), like the inbox.
import {check,withDefaults} from './json-schema.mjs';
import {normalize,validChart,ITEM_KINDS,ITEM_STATUS,ITEM_PRIORITY,PERSON_IMAGE_MAX,PERSON_EMAIL_MAX,validPersonImage,cleanPersonEmail} from './cleaners.mjs';
import {COLUMNS,ROLES,LINK_KINDS,SECTIONS,COLORS,NEW_COLUMN,gateFor,moveCard,newCard,filterCards} from '../public/devops-core.js';
import {AGENT_KINDS,AGENT_STATUS,WORKFLOW_STATUS,TRIGGERS,LIMITS,newAgent,newWorkflow,removeAgent,canReportTo,pin,delegate,workQueue,agentsForCard,QUEUE_ORDER,filterAgents,filterWorkflows,agentBrief,workflowBrief,runnerOf,reportRunner,cleanJobLink,BILLING,JOB_STATUS,JOB_ORIGINS,JOB_TRIGGERS} from '../public/agentflow-core.js';

const fail=(status,code,message,extra={})=>{throw Object.assign(new Error(message),{status,code,message,...extra})};
const uid=()=>crypto.randomUUID(),norm=s=>String(s??'').trim().toLowerCase(),now=()=>new Date().toISOString();

// ---------- schemas ----------
const obj=(properties,required=[])=>({type:'object',properties,required,additionalProperties:false});
const out=(properties,required=Object.keys(properties))=>({type:'object',properties,required});
const ENV={type:'string',pattern:'^[A-Za-z0-9-]{1,64}$',description:'Environment id (see envs.list).'};
const REF=d=>({type:'string',minLength:1,maxLength:200,description:d});
const DATE={type:'string',pattern:'^(\\d{4}-\\d{2}-\\d{2})?$',description:'YYYY-MM-DD, or "" for none.'};
const PAGE={limit:{type:'integer',minimum:1,maximum:200,default:50,description:'Page size (1-200, default 50).'},cursor:{type:'string',maxLength:200,description:'nextCursor from the previous page.'}};
const REV={type:'integer',description:'Workspace revision after (or at) this call.'};
const CHART=REF('Chart id, or "active" for the chart open in the app.');
const COLUMN={type:'string',enum:COLUMNS.map(([k])=>k),description:'Board column: '+COLUMNS.map(([k,n])=>`${k} (${n})`).join(', ')+'.'};
const NODE_TYPES=['entity','person','area','note'],EDGE_TYPES=['ownership','group'];
const COLOR_HEX={type:'string',pattern:'^#[0-9a-fA-F]{6}$',description:'Hex colour, e.g. #7cb980.'};

const S={
  env:out({id:{type:'string'},name:{type:'string'},visibility:{enum:['private','public']},owner:{type:'string'},rev:{type:'integer'},updatedAt:{type:['string','null']}},['id','name','visibility','rev']),
  chart:out({id:{type:'string'},name:{type:'string'},active:{type:'boolean'},nodes:{type:'integer'},edges:{type:'integer'}}),
  node:out({id:{type:'string'},name:{type:'string'},type:{enum:NODE_TYPES},x:{type:'number'},y:{type:'number'},w:{type:'number'},h:{type:'number'},notes:{type:'string'},
    image:{type:'string',description:'Person photo: an https URL or a data:image/(png|jpeg|webp);base64 URL.'},email:{type:'string',description:'Person email, matching them to an account.'}},['id','name','type','x','y']),
  edge:out({id:{type:'string'},from:{type:'string'},to:{type:'string'},type:{enum:EDGE_TYPES},percent:{type:'string'}}),
  project:out({id:{type:'string'},name:{type:'string'},color:{type:'string'},entity:{type:'string'}}),
  item:out({id:{type:'string'},title:{type:'string'},kind:{enum:ITEM_KINDS},status:{enum:ITEM_STATUS},start:{type:'string'},end:{type:'string'},priority:{type:'string'},release:{type:'string'},projects:{type:'array',items:{type:'string'}},owner:{type:'string'},link:{type:'string'},notes:{type:'string'}},['id','title','kind','status','start','end','projects']),
  card:out({id:{type:'string'},number:{type:'integer'},title:{type:'string'},description:{type:'string'},column:{type:'string'},project:{type:'string'},labels:{type:'array',items:{type:'string'}},points:{type:['number','null']},due:{type:'string'},
    assignees:{type:'array',items:out({node:{type:'string'},role:{enum:ROLES}})},checklist:{type:'array',items:out({id:{type:'string'},text:{type:'string'},done:{type:'boolean'}})},
    links:{type:'array',items:out({id:{type:'string'},kind:{type:'string'},url:{type:'string'}})},item:{type:'string'},created:{type:'string'},updated:{type:'string'},moved:{type:'string'},
    agents:{type:'array',items:{type:'string'},description:'AgentFlow agents the card is delegated to (ids).'}},['id','number','title','column','labels','assignees','checklist','links']),
  label:out({id:{type:'string'},name:{type:'string'},section:{enum:SECTIONS.map(([k])=>k)},color:{type:'string'}}),
  agent:out({id:{type:'string'},name:{type:'string'},kind:{enum:Object.keys(AGENT_KINDS)},title:{type:'string'},status:{enum:Object.keys(AGENT_STATUS)},live:{type:'boolean'},reportsTo:{type:'string'},supervisor:{type:'string'},
    purpose:{type:'string'},instructions:{type:'string'},runtime:{type:'string'},models:{type:'array',items:{type:'string'}},model:{type:'string'},auto:{type:'boolean'},
    schedule:{type:'string',description:'When it runs: plain text or cron; "" for none.'},job:out({runner:{type:'string'},id:{type:'string'}},['runner','id']),inputs:{type:'array',items:{type:'string'}},outputs:{type:'array',items:{type:'string'}},tools:{type:'array',items:{type:'string'}},
    projects:{type:'array',items:{type:'string'}},cards:{type:'array',items:{type:'string'}},items:{type:'array',items:{type:'string'}},created:{type:'string'},updated:{type:'string'},x:{type:'number'},y:{type:'number'}},
    ['id','name','kind','status','live','reportsTo','supervisor','models','model','auto','inputs','outputs','tools','projects','cards','items']),
  runner:out({name:{type:'string'},models:{type:'array',items:out({id:{type:'string'},label:{type:'string'},provider:{type:'string'},billing:{enum:Object.keys(BILLING)}},['id','label'])},
    jobs:{type:'array',items:out({id:{type:'string'},name:{type:'string'},source:{type:'string'},group:{type:'string'},schedule:{type:'string'},cron:{type:'string'},
      timezone:{type:'string'},triggers:{type:'array',items:out({kind:{enum:Object.keys(JOB_TRIGGERS)},expr:{type:'string'},text:{type:'string'}},['kind'])},
      origin:{enum:Object.keys(JOB_ORIGINS)},file:{type:'string'},drift:{type:'string'},note:{type:'string'},command:{type:'string'},
      ai:{type:'boolean'},enabled:{type:'boolean'},lastRun:{type:'string'},lastStatus:{enum:Object.keys(JOB_STATUS)},nextRun:{type:'string'}},['id','name','source','schedule','ai','enabled','lastStatus'])},
    timezone:{type:'string'},reported:{type:'string'},jobsReported:{type:'string'}},['name','models','reported']),
  workflow:out({id:{type:'string'},name:{type:'string'},description:{type:'string'},status:{enum:Object.keys(WORKFLOW_STATUS)},trigger:{enum:Object.keys(TRIGGERS)},schedule:{type:'string'},
    steps:{type:'array',items:out({id:{type:'string'},agent:{type:'string'},action:{type:'string'},output:{type:'string'}})},
    projects:{type:'array',items:{type:'string'}},cards:{type:'array',items:{type:'string'}},items:{type:'array',items:{type:'string'}},created:{type:'string'},updated:{type:'string'}},
    ['id','name','status','trigger','steps','projects','cards','items']),
  hit:out({type:{enum:['node','project','item','card','agent','workflow']},id:{type:'string'},title:{type:'string'},chart:{type:'string'},number:{type:'integer'}},['type','id','title']),
};
const list=item=>out({items:{type:'array',items:item},nextCursor:{type:['string','null']},rev:REV});
const one=(k,s)=>out({rev:REV,[k]:s});

// Card fields shared by create and update (column moves go through cards.move and its gates).
const CARD_FIELDS={
  title:{type:'string',minLength:1,maxLength:200},description:{type:'string',maxLength:8000},
  project:REF('Project id or name; "" for none.'),labels:{type:'array',maxItems:50,items:REF('Label id or name.')},
  points:{type:['number','null'],minimum:0,maximum:1000},due:DATE,
  assignees:{type:'array',maxItems:20,items:obj({node:REF('A person on a chart: node id or name.'),role:{enum:ROLES,default:'developer'}},['node'])},
  checklist:{type:'array',maxItems:200,items:obj({id:{type:'string'},text:{type:'string',minLength:1,maxLength:300},done:{type:'boolean'}},['text'])},
  links:{type:'array',maxItems:50,items:obj({id:{type:'string'},kind:{enum:Object.keys(LINK_KINDS)},url:{type:'string',minLength:1,maxLength:500}},['url'])},
  item:REF('Timeline item id or title; "" for none.'),
  agents:{type:'array',maxItems:20,items:REF('AgentFlow agent id or name.'),description:'Delegate the card to these agents (replaces the list; [] for none). It joins each one\'s work queue (agents.work).'},
};
CARD_FIELDS.project.minLength=0;CARD_FIELDS.item.minLength=0;
// AgentFlow fields shared by create and update. Links (projects, cards, items) are ids or names
// (cards: number or id); lists you send replace the old ones.
const TEXTS=d=>({type:'array',maxItems:50,items:{type:'string',minLength:1,maxLength:200},description:d});
const FLOW_LINKS={
  projects:{type:'array',maxItems:100,items:REF('Project id or name.')},
  cards:{type:'array',maxItems:100,items:{type:['string','integer'],description:'Card number ("12", "#12") or id.'}},
  items:{type:'array',maxItems:100,items:REF('Timeline item id or title.')},
};
const AGENT_FIELDS={
  name:{type:'string',minLength:1,maxLength:120},kind:{enum:Object.keys(AGENT_KINDS),description:'agent (AI agent), human, team, or automation (a scripted job without AI that runs on its own schedule outside Flow: no models, never live).'},title:{type:'string',maxLength:120,description:'Role, e.g. Research.'},
  status:{enum:Object.keys(AGENT_STATUS)},live:{type:'boolean',description:'The switch runners obey: false (the default) and runners leave the agent alone; true and the runner named in runtime works its queue.'},reportsTo:{...REF('The agent it reports to: id or name; "" for top level.'),minLength:0},
  supervisor:{...REF('A person on a chart who oversees it: node id or name; "" for none.'),minLength:0},
  purpose:{type:'string',maxLength:2000},instructions:{type:'string',maxLength:20000,description:'System prompt or runbook.'},
  runtime:{type:'string',maxLength:200,description:'Where it runs: a runner name from runners.list, e.g. a home server.'},models:{type:'array',maxItems:LIMITS.agentModels,items:{type:'string',minLength:1,maxLength:120},description:'Model ids the runner reported (runners.list), in order: the primary first, then fallbacks it tries when one fails (or, with auto, the pool it picks from). Also sets model to the first. Wins over model when both are sent.'},
  model:{type:'string',maxLength:120,description:'One model id, e.g. claudeAgent:claude-sonnet-5-5: the same as sending models with just it ("" for none). Always reads back as the first of models.'},
  auto:{type:'boolean',description:'false (the default): the runner starts on the first of models and falls back in order. true: models is a pool and the runner picks one per card.'},
  schedule:{type:'string',maxLength:200,description:'When it runs, in plain words or cron, e.g. "Weekdays 09:00" (the runner starts it then); "" for none.'},
  job:{anyOf:[obj({runner:{type:'string',minLength:1,maxLength:200},id:{type:'string',minLength:1,maxLength:200}},['runner','id']),{type:'null'},{type:'string',maxLength:0}],
    description:'The runner job it was promoted from: {runner, id} (see runners.report jobs); null or "" for none.'},
  inputs:TEXTS('What it takes in.'),outputs:TEXTS('What it produces.'),tools:TEXTS('What it may use.'),...FLOW_LINKS,
  x:{type:'number',minimum:-100000,maximum:100000,description:'Canvas position (with y). Leave out to place it under its manager.'},y:{type:'number',minimum:-100000,maximum:100000},
};
const WORKFLOW_FIELDS={
  name:{type:'string',minLength:1,maxLength:120},description:{type:'string',maxLength:4000},status:{enum:Object.keys(WORKFLOW_STATUS)},
  trigger:{enum:Object.keys(TRIGGERS),description:'manual, schedule or event.'},schedule:{type:'string',maxLength:200,description:'When or on what it starts, e.g. "Weekdays at 09:00".'},
  steps:{type:'array',maxItems:100,items:obj({id:{type:'string',maxLength:80},agent:{...REF('Agent id or name; "" for unassigned.'),minLength:0},action:{type:'string',maxLength:500},output:{type:'string',maxLength:300}})},
  ...FLOW_LINKS,
};
const ITEM_FIELDS={
  title:{type:'string',minLength:1,maxLength:200},kind:{enum:ITEM_KINDS},status:{enum:ITEM_STATUS},start:DATE,end:DATE,
  priority:{enum:[...ITEM_PRIORITY,'']},release:{...REF('A release item: id or title; "" for none.'),minLength:0},
  projects:{type:'array',maxItems:50,items:REF('Project id or name.')},owner:{type:'string',maxLength:120},link:{type:'string',maxLength:500},notes:{type:'string',maxLength:4000},
};

// ---------- examples (test/api-v1.test.mjs checks each against its schemas) ----------
const T='2026-10-29T17:00:00.000Z';
const EX={
  env:{id:'default-workspace',name:"Default workspace",visibility:'private',owner:'owner@example.test',rev:42,updatedAt:T},
  chart:{id:'c1',name:'Flygon · brainstorm',active:true,nodes:7,edges:7},
  node:{id:'flygon',name:'Kestrel Group',type:'entity',x:400,y:0,notes:''},
  person:{id:'cleo',name:'Cleo Park',type:'person',x:320,y:144,notes:''},
  edge:{id:'o1',from:'cleo',to:'quill',type:'ownership',percent:'50'},
  project:{id:'p1',name:'Lantern',color:'#7cb980',entity:'flygon'},
  item:{id:'i1',title:'Public beta',kind:'release',status:'planned',start:'2026-12-01',end:'',priority:'',release:'',projects:['p1'],owner:'',link:'',notes:''},
  card:{id:'k1',number:12,title:'Build sign-up form',description:'',column:'requests',project:'p1',labels:['l-high'],points:3,due:'2026-11-15',assignees:[{node:'cleo',role:'developer'}],checklist:[{id:'x1',text:'Email field',done:false}],links:[],item:'i1',created:T,updated:T,moved:T,agents:['a1']},
  label:{id:'l-research',name:'Research',section:'area',color:'teal'},
  agent:{id:'a1',name:'Researcher',kind:'agent',title:'Research',status:'active',live:false,reportsTo:'a0',supervisor:'cleo',purpose:'Gathers context before work starts.',instructions:'',runtime:'T3',models:[],model:'',auto:false,schedule:'Weekdays 09:00',
    inputs:['A card that needs research'],outputs:['Research notes on the card'],tools:['Web search'],projects:['p1'],cards:['k1'],items:['i1'],created:T,updated:T},
  workflow:{id:'w1',name:'Ship a card',description:'',status:'active',trigger:'event',schedule:'A card enters Doing',steps:[{id:'s1',agent:'a1',action:'Research the approach',output:'Notes on the card'}],projects:['p1'],cards:[],items:[],created:T,updated:T},
};
EX.brief='# Researcher\n\nAI agent · Research · Active · Not live\n\n## Purpose\n\nGathers context before work starts.\n';
EX.runner={name:'Home server',models:[{id:'claudeAgent:claude-sonnet-5-5',label:'Claude · Sonnet 5.5',provider:'Claude',billing:'included'}],jobs:[],reported:T};
EX.job={id:'systemd:backup.timer',name:'Nightly backup',source:'systemd',group:'Home server',schedule:'Daily 22:30',cron:'30 22 * * *',timezone:'America/Phoenix',
  triggers:[{kind:'calendar',expr:'*-*-* 22:30:00',text:'Daily 22:30'}],origin:'machine',command:'restic backup /srv',ai:false,enabled:true,lastRun:T,lastStatus:'ok',nextRun:'2026-10-30T22:30:00.000Z'};

// ---------- workspace access ----------
async function open(ctx,envId,mode){
  if(!await ctx.envCheck(envId,ctx.user,mode))fail(404,'not_found','Environment not found');
  const w=await ctx.store.get(envId);
  if(!w||w.archivedAt||!w.data)fail(404,'not_found','Environment not found');
  return {w,data:normalize(structuredClone(w.data))};
}
// fn(data) changes the copy and returns pick(data) -> the result fields (read after cleaning).
async function write(ctx,envId,fn){
  for(let i=0;i<5;i++){
    const {w,data}=await open(ctx,envId,'write');
    const pick=fn(data);
    normalize(data);
    if(!Array.isArray(data.charts)||!data.charts.length||!data.charts.every(validChart))fail(400,'invalid_chart','That change would leave a chart invalid');
    const r=await ctx.store.put(envId,{baseRev:w.rev,data,by:ctx.user.email,owner:w.owner,visibility:w.visibility,name:w.name});
    if(r.ok)return {rev:r.rev,...pick(data)};
  }
  fail(409,'conflict','The workspace kept changing; try again');
}
// Pages are offsets in an opaque cursor.
function page(all,{limit=50,cursor},rev){
  let o=0;
  if(cursor){const s=Buffer.from(cursor,'base64url').toString();if(!/^\d{1,9}$/.test(s))fail(400,'bad_cursor','Invalid cursor');o=Number(s)}
  const items=all.slice(o,o+limit),n=o+limit;
  return {items,nextCursor:n<all.length?Buffer.from(String(n)).toString('base64url'):null,...(rev!==undefined?{rev}:{})};
}
const chartOf=(d,id)=>d.charts.find(c=>c.id===(id==='active'?d.active:id))||fail(404,'chart_not_found',`No chart ${id}`);
const nodeOf=(c,id)=>c.nodes.find(n=>n.id===id)||fail(404,'node_not_found',`No node ${id} on this chart`);
const allNodes=d=>d.charts.flatMap(c=>c.nodes);
// Find by id, else by name (case-insensitive). '' means none.
function resolve(list,ref,key,what){
  if(ref==='')return '';
  const x=list.find(v=>v.id===ref)||list.find(v=>norm(v[key])===norm(ref));
  return x?x.id:fail(400,`unknown_${what}`,`No ${what} "${ref}"`);
}
const person=(d,ref)=>resolve(allNodes(d).filter(n=>n.type==='person'),ref,'name','person');
const cardOf=(d,ref)=>{const s=String(ref),n=/^#?\d+$/.test(s)?Number(s.replace('#','')):null;return d.devops.cards.find(c=>n!==null?c.number===n:c.id===s)||fail(404,'card_not_found',`No card ${s}`)};
const strip=c=>{const {inbox,...rest}=c;return rest};
// A card as the API returns it: without the inbox stamp, with the agents it is delegated to.
const cardOut=(d,c,by)=>({...strip(c),agents:(by?by.get(c.id)||[]:agentsForCard(d.agentflow,c.id).map(a=>a.id))});
const agentsByCard=d=>{const m=new Map();for(const a of d.agentflow.agents)for(const id of a.cards)m.set(id,[...(m.get(id)||[]),a.id]);return m};
const summary=w=>({id:w.envId,name:w.name||w.data?.environment?.name||'Workspace',visibility:w.visibility,owner:w.owner,rev:w.rev,updatedAt:w.updatedAt||null});

// Card fields from input (references resolved) onto a card.
function cardFields(d,c,input){
  const set=(k,v)=>{if(input[k]!==undefined)c[k]=v(input[k])};
  set('title',v=>v);set('description',v=>v);set('points',v=>v);set('due',v=>v);
  set('project',v=>resolve(d.projects,v,'name','project'));
  set('labels',v=>[...new Set(v.map(l=>resolve(d.devops.labels,l,'name','label')))]);
  set('item',v=>resolve(d.timeline,v,'title','item'));
  set('assignees',v=>v.map(a=>({node:person(d,a.node),role:a.role||'developer'})));
  set('checklist',v=>v.map(x=>({id:x.id||uid(),text:x.text,done:!!x.done})));
  set('links',v=>v.map(x=>({id:x.id||uid(),kind:x.kind||'url',url:x.url})));
  if(input.agents!==undefined){
    const over=delegate(d.agentflow,c.id,[...new Set(input.agents.map(a=>agentRef(d,a)))]);
    if(over)fail(409,'agent_queue_full',`${over.name} already has ${over.cards.length} linked cards`);
  }
}
// AgentFlow references, resolved like the rest: id first, then name.
const agentRef=(d,ref)=>resolve(d.agentflow.agents,ref,'name','agent');
const agentOfRef=(d,ref)=>d.agentflow.agents.find(a=>a.id===agentRef(d,ref))||fail(404,'agent_not_found',`No agent ${ref}`);
const workflowOf=(d,ref)=>d.agentflow.workflows.find(w=>w.id===ref)||d.agentflow.workflows.find(w=>norm(w.name)===norm(ref))||fail(404,'workflow_not_found',`No workflow ${ref}`);
function linkFields(d,x,input){
  if(input.projects!==undefined)x.projects=[...new Set(input.projects.map(p=>resolve(d.projects,p,'name','project')))];
  if(input.cards!==undefined)x.cards=[...new Set(input.cards.map(c=>{try{return cardOf(d,c).id}catch{fail(400,'unknown_card',`No card ${c}`)}}))];
  if(input.items!==undefined)x.items=[...new Set(input.items.map(i=>resolve(d.timeline,i,'title','item')))];
}
function agentFields(d,a,input){
  for(const k of ['name','kind','title','status','live','purpose','instructions','runtime','auto','schedule','inputs','outputs','tools'])if(input[k]!==undefined)a[k]=input[k];
  if(input.job!==undefined){const j=cleanJobLink(input.job);if(j)a.job=j;else delete a.job}
  // models wins; model alone means just that one. The cleaner trims and dedupes them.
  const ms=input.models!==undefined?input.models:input.model!==undefined?(input.model.trim()?[input.model]:[]):undefined;
  if(ms!==undefined){a.models=ms;a.model=ms[0]||''}
  if((input.x===undefined)!==(input.y===undefined))fail(400,'invalid_position','Send x and y together');
  if(input.x!==undefined){pin(d.agentflow);a.x=input.x;a.y=input.y}
  if(input.supervisor!==undefined)a.supervisor=person(d,input.supervisor);
  if(input.reportsTo!==undefined){
    const to=resolve(d.agentflow.agents,input.reportsTo,'name','agent');
    if(!canReportTo(d.agentflow,a.id,to))fail(400,'reports_loop','An agent cannot report to itself or to someone who reports to it');
    a.reportsTo=to;
  }
  linkFields(d,a,input);a.updated=now();
}
function workflowFields(d,w,input){
  for(const k of ['name','description','status','trigger','schedule'])if(input[k]!==undefined)w[k]=input[k];
  if(input.steps!==undefined)w.steps=input.steps.map(s=>({id:s.id||uid(),agent:s.agent?agentRef(d,s.agent):'',action:s.action||'',output:s.output||''}));
  linkFields(d,w,input);w.updated=now();
}
function itemFields(d,i,input){
  for(const k of ['title','kind','status','start','end','priority','owner','link','notes'])if(input[k]!==undefined)i[k]=input[k];
  if(input.projects!==undefined)i.projects=[...new Set(input.projects.map(p=>resolve(d.projects,p,'name','project')))];
  if(input.release!==undefined)i.release=resolve(d.timeline.filter(x=>x.kind==='release'&&x.id!==i.id),input.release,'title','release');
  if(i.end&&!i.start)fail(400,'invalid_dates','An end date needs a start date');
  if(i.end&&i.end<i.start)fail(400,'invalid_dates','The end date is before the start');
  if(i.kind==='release')i.release='';
}

// ---------- operations ----------
export const operations=[];
const handlers=new Map();
function op(def,run){operations.push(Object.freeze(def));handlers.set(def.id,run)}
const B='/api/v1/envs/{env}';

op({id:'envs.list',method:'GET',path:'/api/v1/envs',scope:'read',tags:['envs'],summary:'List environments',
  description:'Environments (workspaces) you own, newest first. Use an id from here as {env} in every other call.',
  input:obj({...PAGE}),output:out({items:{type:'array',items:S.env},nextCursor:{type:['string','null']}}),
  examples:[{title:'Your environments',input:{},output:{items:[EX.env],nextCursor:null}}]},
async(input,ctx)=>page((await ctx.store.owned(ctx.user.email)).map(summary),input));

op({id:'envs.get',method:'GET',path:B,scope:'read',tags:['envs'],summary:'Get an environment',
  description:'One environment: name, visibility, owner, revision and how much it holds.',
  input:obj({env:ENV},['env']),output:out({environment:{...S.env,properties:{...S.env.properties,counts:out({charts:{type:'integer'},nodes:{type:'integer'},edges:{type:'integer'},projects:{type:'integer'},items:{type:'integer'},cards:{type:'integer'}})}}}),
  examples:[{title:"Default workspace",input:{env:'default-workspace'},output:{environment:{...EX.env,counts:{charts:1,nodes:7,edges:7,projects:3,items:12,cards:40}}}}]},
async({env},ctx)=>{const {w,data:d}=await open(ctx,env,'read');return {environment:{...summary(w),counts:{charts:d.charts.length,nodes:allNodes(d).length,edges:d.charts.reduce((s,c)=>s+c.edges.length,0),projects:d.projects.length,items:d.timeline.length,cards:d.devops.cards.length}}}});

op({id:'charts.list',method:'GET',path:B+'/charts',scope:'read',tags:['charts'],summary:'List charts',
  description:'The org charts in an environment, with node and edge counts. `active` marks the chart open in the app.',
  input:obj({env:ENV,...PAGE},['env']),output:list(S.chart),
  examples:[{title:'Charts',input:{env:'default-workspace'},output:{items:[EX.chart],nextCursor:null,rev:42}}]},
async(input,ctx)=>{const {w,data:d}=await open(ctx,input.env,'read');return page(d.charts.map(c=>({id:c.id,name:c.name,active:c.id===d.active,nodes:c.nodes.length,edges:c.edges.length})),input,w.rev)});

op({id:'nodes.list',method:'GET',path:B+'/charts/{chart}/nodes',scope:'read',tags:['nodes'],summary:'List nodes',
  description:'Cards on a chart (entities, people, areas, notes). Filter by `type`, or by `q` (name contains).',
  input:obj({env:ENV,chart:CHART,type:{enum:NODE_TYPES},q:{type:'string',maxLength:200},...PAGE},['env','chart']),output:list(S.node),
  examples:[{title:'People on the active chart',input:{env:'default-workspace',chart:'active',type:'person'},output:{items:[EX.person],nextCursor:null,rev:42}}]},
async(input,ctx)=>{const {w,data:d}=await open(ctx,input.env,'read'),q=norm(input.q);return page(chartOf(d,input.chart).nodes.filter(n=>(!input.type||n.type===input.type)&&(!q||norm(n.name).includes(q))),input,w.rev)});

op({id:'nodes.get',method:'GET',path:B+'/charts/{chart}/nodes/{node}',scope:'read',tags:['nodes'],summary:'Get a node',
  description:'One chart card by id.',
  input:obj({env:ENV,chart:CHART,node:REF('Node id.')},['env','chart','node']),output:one('node',S.node),
  examples:[{title:'Kestrel Group',input:{env:'default-workspace',chart:'active',node:'flygon'},output:{rev:42,node:EX.node}}]},
async(input,ctx)=>{const {w,data:d}=await open(ctx,input.env,'read');return {rev:w.rev,node:nodeOf(chartOf(d,input.chart),input.node)}});

const NODE_FIELDS={name:{type:'string',minLength:1,maxLength:200},notes:{type:'string',maxLength:4000},w:{type:'number',minimum:1,maximum:5000},h:{type:'number',minimum:1,maximum:5000},
  image:{type:'string',maxLength:PERSON_IMAGE_MAX,description:`Person cards only: a photo as an https URL, or a data:image/(png|jpeg|webp);base64 URL up to ${PERSON_IMAGE_MAX} characters. "" removes it.`},
  email:{type:'string',maxLength:PERSON_EMAIL_MAX,description:'Person cards only: their email, so the app can show the matching account photo. Never shared with share recipients. "" removes it.'}};
// Photo and email belong to person cards: checked here so a bad value is an error, not silently dropped.
function personFields(n,input){
  for(const k of ['image','email']){
    if(input[k]===undefined)continue;
    if(input[k]===''){delete n[k];continue}
    if(n.type!=='person')fail(400,'invalid_'+k,`Only person cards have ${k==='image'?'a photo':'an email'}`);
    const v=k==='image'?(validPersonImage(input[k])?input[k]:''):cleanPersonEmail(input[k]);
    if(!v)fail(400,'invalid_'+k,k==='image'?'The photo must be an https URL or a PNG, JPEG or WebP data URL':'That is not an email address');
    n[k]=v;
  }
}
op({id:'nodes.create',method:'POST',path:B+'/charts/{chart}/nodes',scope:'write',tags:['nodes'],summary:'Create a node',
  description:'Add a card to a chart. Without x/y it is placed at the origin, stepping 32px diagonally past occupied spots (as the app does).',
  input:obj({env:ENV,chart:CHART,type:{enum:NODE_TYPES},...NODE_FIELDS,x:{type:'number'},y:{type:'number'}},['env','chart','type','name']),output:one('node',S.node),
  examples:[{title:'Add a person',input:{env:'default-workspace',chart:'active',type:'person',name:'Cleo Park',x:320,y:144},output:{rev:43,node:EX.person}}]},
async(input,ctx)=>write(ctx,input.env,d=>{
  const c=chartOf(d,input.chart);let x=input.x??0,y=input.y??0;
  if(input.x===undefined&&input.y===undefined)while(c.nodes.some(n=>n.x===x&&n.y===y)){x+=32;y+=32}
  const n={id:uid(),name:input.name,type:input.type,x,y,notes:input.notes||''};if(input.w)n.w=input.w;if(input.h)n.h=input.h;personFields(n,input);
  c.nodes.push(n);return d2=>({node:nodeOf(chartOf(d2,input.chart),n.id)});
}));

op({id:'nodes.update',method:'PATCH',path:B+'/charts/{chart}/nodes/{node}',scope:'write',tags:['nodes'],summary:'Update a node',
  description:'Change a chart card\'s name, type, notes or size, or a person\'s photo and email. Fields left out stay as they are. Use nodes.move for position.',
  input:obj({env:ENV,chart:CHART,node:REF('Node id.'),type:{enum:NODE_TYPES},...NODE_FIELDS},['env','chart','node']),output:one('node',S.node),
  examples:[{title:'Rename',input:{env:'default-workspace',chart:'active',node:'flygon',name:'Kestrel Group'},output:{rev:43,node:EX.node}}]},
async(input,ctx)=>write(ctx,input.env,d=>{
  const n=nodeOf(chartOf(d,input.chart),input.node);
  for(const k of ['name','type','notes','w','h'])if(input[k]!==undefined)n[k]=input[k];
  personFields(n,input);
  return d2=>({node:nodeOf(chartOf(d2,input.chart),n.id)});
}));

op({id:'nodes.move',method:'POST',path:B+'/charts/{chart}/nodes/{node}/move',scope:'write',tags:['nodes'],summary:'Move a node',
  description:'Set a chart card\'s position (canvas pixels; the app snaps to a 16px grid when dragging, the API does not).',
  input:obj({env:ENV,chart:CHART,node:REF('Node id.'),x:{type:'number'},y:{type:'number'}},['env','chart','node','x','y']),output:one('node',S.node),
  examples:[{title:'Move',input:{env:'default-workspace',chart:'active',node:'flygon',x:400,y:0},output:{rev:44,node:EX.node}}]},
async(input,ctx)=>write(ctx,input.env,d=>{
  const n=nodeOf(chartOf(d,input.chart),input.node);n.x=input.x;n.y=input.y;
  return d2=>({node:nodeOf(chartOf(d2,input.chart),n.id)});
}));

op({id:'edges.list',method:'GET',path:B+'/charts/{chart}/edges',scope:'read',tags:['edges'],summary:'List edges',
  description:'Connections on a chart. Ownership edges carry a percent ("" when unspecified); group edges are grouping only.',
  input:obj({env:ENV,chart:CHART,node:REF('Only edges touching this node id.'),...PAGE},['env','chart']),output:list(S.edge),
  examples:[{title:'Edges',input:{env:'default-workspace',chart:'active'},output:{items:[EX.edge],nextCursor:null,rev:42}}]},
async(input,ctx)=>{const {w,data:d}=await open(ctx,input.env,'read');return page(chartOf(d,input.chart).edges.filter(e=>!input.node||e.from===input.node||e.to===input.node),input,w.rev)});

op({id:'edges.create',method:'POST',path:B+'/charts/{chart}/edges',scope:'write',tags:['edges'],summary:'Create an edge',
  description:'Connect two cards on the same chart. A second edge between the same pair (same direction) is refused with 409.',
  input:obj({env:ENV,chart:CHART,from:REF('Node id.'),to:REF('Node id.'),type:{enum:EDGE_TYPES,default:'ownership'},percent:{type:['string','number'],description:'0-100, or "" for unspecified.'}},['env','chart','from','to']),output:one('edge',S.edge),
  examples:[{title:'50% ownership',input:{env:'default-workspace',chart:'active',from:'cleo',to:'quill',percent:'50'},output:{rev:45,edge:EX.edge}}]},
async(input,ctx)=>write(ctx,input.env,d=>{
  const c=chartOf(d,input.chart);nodeOf(c,input.from);nodeOf(c,input.to);
  if(input.from===input.to)fail(400,'invalid_edge','An edge needs two different nodes');
  if(c.edges.some(e=>e.from===input.from&&e.to===input.to))fail(409,'edge_exists','These nodes are already connected');
  const p=input.percent===undefined?'':String(input.percent).trim();
  if(p!==''&&(!Number.isFinite(Number(p))||Number(p)<0||Number(p)>100))fail(400,'invalid_percent','percent must be 0-100 or ""');
  const e={id:uid(),from:input.from,to:input.to,type:input.type||'ownership',percent:input.type==='group'?'':p};
  c.edges.push(e);return d2=>({edge:chartOf(d2,input.chart).edges.find(x=>x.id===e.id)});
}));

op({id:'edges.delete',method:'DELETE',path:B+'/charts/{chart}/edges/{edge}',scope:'write',tags:['edges'],summary:'Delete an edge',
  description:'Remove one connection. The cards it joined stay. Earlier revisions are kept in the workspace history.',
  input:obj({env:ENV,chart:CHART,edge:REF('Edge id.')},['env','chart','edge']),output:out({rev:REV,deleted:{type:'string'}}),
  examples:[{title:'Delete',input:{env:'default-workspace',chart:'active',edge:'o1'},output:{rev:46,deleted:'o1'}}]},
async(input,ctx)=>write(ctx,input.env,d=>{
  const c=chartOf(d,input.chart);if(!c.edges.some(e=>e.id===input.edge))fail(404,'edge_not_found',`No edge ${input.edge}`);
  c.edges=c.edges.filter(e=>e.id!==input.edge);return ()=>({deleted:input.edge});
}));

const PROJECT_FIELDS={name:{type:'string',minLength:1,maxLength:80},color:COLOR_HEX,entity:{...REF('The chart entity or area it sits under: node id or name; "" for none.'),minLength:0}};
const entityOf=(d,ref)=>resolve(allNodes(d).filter(n=>n.type==='entity'||n.type==='area'),ref,'name','entity');
const projectNamed=(d,name,not)=>d.projects.some(p=>p.id!==not&&norm(p.name)===norm(name))&&fail(409,'project_exists',`A project named "${name}" exists`);
op({id:'projects.list',method:'GET',path:B+'/projects',scope:'read',tags:['projects'],summary:'List projects',
  description:'Timeline/board projects (coloured tags), optionally only those under one chart entity or area.',
  input:obj({env:ENV,entity:REF('Node id.'),...PAGE},['env']),output:list(S.project),
  examples:[{title:'Projects',input:{env:'default-workspace'},output:{items:[EX.project],nextCursor:null,rev:42}}]},
async(input,ctx)=>{const {w,data:d}=await open(ctx,input.env,'read');return page(d.projects.filter(p=>!input.entity||p.entity===input.entity),input,w.rev)});

op({id:'projects.create',method:'POST',path:B+'/projects',scope:'write',tags:['projects'],summary:'Create a project',
  description:'Add a project. Names are unique (case-insensitive); a duplicate gets 409. Without a colour the next palette colour is used.',
  input:obj({env:ENV,...PROJECT_FIELDS},['env','name']),output:one('project',S.project),
  examples:[{title:'Under Kestrel Group',input:{env:'default-workspace',name:'Lantern',color:'#7cb980',entity:'Kestrel Group'},output:{rev:47,project:EX.project}}]},
async(input,ctx)=>write(ctx,input.env,d=>{
  projectNamed(d,input.name);
  const p={id:uid(),name:input.name,color:input.color||'',entity:input.entity?entityOf(d,input.entity):''};
  d.projects.push(p);return d2=>({project:d2.projects.find(x=>x.id===p.id)});
}));

op({id:'projects.update',method:'PATCH',path:B+'/projects/{project}',scope:'write',tags:['projects'],summary:'Update a project',
  description:'Rename, recolour or re-parent a project. {project} is its id or name.',
  input:obj({env:ENV,project:REF('Project id or name.'),...PROJECT_FIELDS},['env','project']),output:one('project',S.project),
  examples:[{title:'Recolour',input:{env:'default-workspace',project:'Lantern',color:'#3d6fb6'},output:{rev:48,project:{...EX.project,color:'#3d6fb6'}}}]},
async(input,ctx)=>write(ctx,input.env,d=>{
  const id=resolve(d.projects,input.project,'name','project'),p=d.projects.find(x=>x.id===id);
  if(input.name!==undefined){projectNamed(d,input.name,id);p.name=input.name}
  if(input.color!==undefined)p.color=input.color;
  if(input.entity!==undefined)p.entity=entityOf(d,input.entity);
  return d2=>({project:d2.projects.find(x=>x.id===id)});
}));

op({id:'items.list',method:'GET',path:B+'/items',scope:'read',tags:['timeline'],summary:'List timeline items',
  description:'Timeline items (milestones, releases, features...). Filter by project (id or name), kind, status or `q` (title contains). Items with start "" are backlog.',
  input:obj({env:ENV,project:REF('Project id or name.'),kind:{enum:ITEM_KINDS},status:{enum:ITEM_STATUS},q:{type:'string',maxLength:200},...PAGE},['env']),output:list(S.item),
  examples:[{title:'Releases',input:{env:'default-workspace',kind:'release'},output:{items:[EX.item],nextCursor:null,rev:42}}]},
async(input,ctx)=>{
  const {w,data:d}=await open(ctx,input.env,'read'),q=norm(input.q),p=input.project?resolve(d.projects,input.project,'name','project'):null;
  return page(d.timeline.filter(i=>(!p||i.projects.includes(p))&&(!input.kind||i.kind===input.kind)&&(!input.status||i.status===input.status)&&(!q||norm(i.title).includes(q))).map(strip),input,w.rev);
});

op({id:'items.get',method:'GET',path:B+'/items/{item}',scope:'read',tags:['timeline'],summary:'Get a timeline item',
  description:'One timeline item by id (or exact title).',
  input:obj({env:ENV,item:REF('Item id or title.')},['env','item']),output:one('item',S.item),
  examples:[{title:'Public beta',input:{env:'default-workspace',item:'Public beta'},output:{rev:42,item:EX.item}}]},
async(input,ctx)=>{const {w,data:d}=await open(ctx,input.env,'read'),id=resolve(d.timeline,input.item,'title','item');return {rev:w.rev,item:strip(d.timeline.find(i=>i.id===id))}});

op({id:'items.create',method:'POST',path:B+'/items',scope:'write',tags:['timeline'],summary:'Create a timeline item',
  description:'Add a timeline item. Without a start date it is backlog (Board and List only). Kind defaults to milestone when dated, feature otherwise.',
  input:obj({env:ENV,...ITEM_FIELDS},['env','title']),output:one('item',S.item),
  examples:[{title:'A release',input:{env:'default-workspace',title:'Public beta',kind:'release',start:'2026-12-01',projects:['Lantern']},output:{rev:49,item:EX.item}}]},
async(input,ctx)=>write(ctx,input.env,d=>{
  const i={id:uid(),title:'',kind:input.start?'milestone':'feature',status:'planned',start:'',end:'',priority:'',release:'',projects:[],owner:'',link:'',notes:''};
  itemFields(d,i,input);d.timeline.push(i);return d2=>({item:strip(d2.timeline.find(x=>x.id===i.id))});
}));

op({id:'items.update',method:'PATCH',path:B+'/items/{item}',scope:'write',tags:['timeline'],summary:'Update a timeline item',
  description:'Change any field of a timeline item. Fields left out stay; `projects` replaces the list.',
  input:obj({env:ENV,item:REF('Item id or title.'),...ITEM_FIELDS},['env','item']),output:one('item',S.item),
  examples:[{title:'Mark done',input:{env:'default-workspace',item:'i1',status:'done'},output:{rev:50,item:{...EX.item,status:'done'}}}]},
async(input,ctx)=>write(ctx,input.env,d=>{
  const id=resolve(d.timeline,input.item,'title','item'),i=d.timeline.find(x=>x.id===id);
  itemFields(d,i,{...input,item:undefined});return d2=>({item:strip(d2.timeline.find(x=>x.id===id))});
}));

op({id:'cards.list',method:'GET',path:B+'/cards',scope:'read',tags:['cards'],summary:'List DevOps cards',
  description:'Board cards in board order. Filters: column, project (id, name or "none"), label (id or name), assignee (person id or name), agent (AgentFlow agent: cards delegated to it), q ("#12" or title text), hideDone.',
  input:obj({env:ENV,column:COLUMN,project:REF('Project id or name, or "none".'),label:REF('Label id or name.'),assignee:REF('Person node id or name.'),agent:REF('AgentFlow agent id or name: cards delegated to it.'),q:{type:'string',maxLength:200},hideDone:{type:'boolean'},...PAGE},['env']),output:list(S.card),
  examples:[{title:'Open cards for a project',input:{env:'default-workspace',project:'Lantern',hideDone:true},output:{items:[EX.card],nextCursor:null,rev:42}}]},
async(input,ctx)=>{
  const {w,data:d}=await open(ctx,input.env,'read');
  const f={q:input.q,hideDone:input.hideDone,projects:input.project?[input.project==='none'?'none':resolve(d.projects,input.project,'name','project')]:undefined,
    label:input.label?resolve(d.devops.labels,input.label,'name','label'):undefined,assignee:input.assignee?person(d,input.assignee):undefined,agents:input.agent?[agentRef(d,input.agent)]:undefined};
  const by=agentsByCard(d);
  return page(filterCards(d,f).filter(c=>!input.column||c.column===input.column).map(c=>cardOut(d,c,by)),input,w.rev);
});

op({id:'cards.get',method:'GET',path:B+'/cards/{card}',scope:'read',tags:['cards'],summary:'Get a DevOps card',
  description:'One card by number ("12" or "#12") or id.',
  input:obj({env:ENV,card:{type:['string','integer'],description:'Card number or id.'}},['env','card']),output:one('card',S.card),
  examples:[{title:'Card #12',input:{env:'default-workspace',card:12},output:{rev:42,card:EX.card}}]},
async(input,ctx)=>{const {w,data:d}=await open(ctx,input.env,'read');return {rev:w.rev,card:cardOut(d,cardOf(d,input.card))}});

op({id:'cards.create',method:'POST',path:B+'/cards',scope:'write',tags:['cards'],summary:'Create a DevOps card',
  description:'Add a card (it gets the next #number). Lands in Requests / Sprinted unless `column` says otherwise. References (project, labels, assignees, item) are ids or names; unknown ones are refused with 400.',
  input:obj({env:ENV,column:COLUMN,...CARD_FIELDS},['env','title']),output:one('card',S.card),
  examples:[{title:'New card',input:{env:'default-workspace',title:'Build sign-up form',project:'Lantern',labels:['High'],points:3,due:'2026-11-15',assignees:[{node:'Cleo Park',role:'developer'}],checklist:[{text:'Email field'}],item:'Public beta'},output:{rev:51,card:EX.card}}]},
async(input,ctx)=>write(ctx,input.env,d=>{
  const c=newCard(d.devops,{column:input.column||NEW_COLUMN});cardFields(d,c,input);
  return d2=>({card:cardOut(d2,d2.devops.cards.find(x=>x.id===c.id))});
}));

op({id:'cards.update',method:'PATCH',path:B+'/cards/{card}',scope:'write',tags:['cards'],summary:'Update a DevOps card',
  description:'Change a card\'s fields. Lists you send (labels, assignees, checklist, links) replace the old ones. The column only changes through cards.move, which applies the board\'s gates.',
  input:obj({env:ENV,card:{type:['string','integer'],description:'Card number or id.'},...CARD_FIELDS},['env','card']),output:one('card',S.card),
  examples:[{title:'Tick the checklist',input:{env:'default-workspace',card:12,checklist:[{id:'x1',text:'Email field',done:true}]},output:{rev:52,card:{...EX.card,checklist:[{id:'x1',text:'Email field',done:true}]}}}]},
async(input,ctx)=>write(ctx,input.env,d=>{
  const c=cardOf(d,input.card);cardFields(d,c,input);c.updated=now();
  return d2=>({card:cardOut(d2,d2.devops.cards.find(x=>x.id===c.id))});
}));

op({id:'cards.move',method:'POST',path:B+'/cards/{card}/move',scope:'write',tags:['cards'],summary:'Move a DevOps card',
  description:'Move a card to a column (and position: `index` among that column\'s other cards; end if left out). The board\'s gates apply: into Done needs `confirm: true`, or `approve: true` from UAT (the Approve button); out of Done needs `confirm: true`; into Doing without a developer needs `developer` (a person, who is assigned) or `confirm: true` to leave it unassigned. A refused gate is 409 with code confirm_done, confirm_reopen or pick_developer.',
  input:obj({env:ENV,card:{type:['string','integer'],description:'Card number or id.'},column:COLUMN,index:{type:'integer',minimum:0},confirm:{type:'boolean'},approve:{type:'boolean'},developer:REF('Person node id or name.')},['env','card','column']),output:one('card',S.card),
  examples:[{title:'Approve from UAT',input:{env:'default-workspace',card:12,column:'done',approve:true},output:{rev:53,card:{...EX.card,column:'done'}}},
    {title:'Start work',input:{env:'default-workspace',card:12,column:'doing',developer:'Cleo Park'},output:{rev:54,card:{...EX.card,column:'doing'}}}]},
async(input,ctx)=>write(ctx,input.env,d=>{
  const c=cardOf(d,input.card),to=input.column,gate=gateFor(c,to);
  if(input.approve&&!(c.column==='uat'&&to==='done'))fail(400,'approve_only_from_uat','approve moves a UAT card to Done');
  if(gate==='confirm-done'&&!input.confirm&&!input.approve)fail(409,'confirm_done','Moving a card to Done needs confirm: true (or approve: true from UAT)',{gate});
  if(gate==='confirm-reopen'&&!input.confirm)fail(409,'confirm_reopen','Moving a card out of Done needs confirm: true',{gate});
  if(gate==='pick-dev'){
    if(input.developer)c.assignees.push({node:person(d,input.developer),role:'developer'});
    else if(!input.confirm)fail(409,'pick_developer','Who is developing it? Send developer (a person), or confirm: true to leave it unassigned',{gate});
  }
  moveCard(d.devops,c.id,to,input.index);
  return d2=>({card:cardOut(d2,d2.devops.cards.find(x=>x.id===c.id))});
}));

op({id:'labels.list',method:'GET',path:B+'/labels',scope:'read',tags:['labels'],summary:'List DevOps labels',
  description:'Board labels with their section (priority, urgency, area, topic, other) and colour token.',
  input:obj({env:ENV,section:{enum:SECTIONS.map(([k])=>k)},...PAGE},['env']),output:list(S.label),
  examples:[{title:'Labels',input:{env:'default-workspace'},output:{items:[EX.label],nextCursor:null,rev:42}}]},
async(input,ctx)=>{const {w,data:d}=await open(ctx,input.env,'read');return page(d.devops.labels.filter(l=>!input.section||l.section===input.section),input,w.rev)});

op({id:'labels.create',method:'POST',path:B+'/labels',scope:'write',tags:['labels'],summary:'Create a DevOps label',
  description:'Add a label. `id` defaults to "l-" plus the name in lower case; a taken id or name gets 409. Colours: '+Object.keys(COLORS).join(', ')+'.',
  input:obj({env:ENV,id:{type:'string',pattern:'^[A-Za-z0-9_-]{1,80}$'},name:{type:'string',minLength:1,maxLength:40},section:{enum:SECTIONS.map(([k])=>k),default:'other'},color:{enum:Object.keys(COLORS),default:'black'}},['env','name']),output:one('label',S.label),
  examples:[{title:'Research',input:{env:'default-workspace',id:'l-research',name:'Research',section:'area',color:'teal'},output:{rev:55,label:EX.label}}]},
async(input,ctx)=>write(ctx,input.env,d=>{
  const id=input.id||'l-'+(norm(input.name).replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')||uid());
  if(d.devops.labels.some(l=>l.id===id||norm(l.name)===norm(input.name)))fail(409,'label_exists',`A label "${input.name}" (${id}) exists`);
  d.devops.labels.push({id,name:input.name,section:input.section||'other',color:input.color||'black'});
  return d2=>({label:d2.devops.labels.find(l=>l.id===id)});
}));

op({id:'agents.list',method:'GET',path:B+'/agents',scope:'read',tags:['agents'],summary:'List AgentFlow agents',
  description:'Agents in the AgentFlow org chart (AI agents, humans, teams and automations), in saved order. Filters: status, kind, live (true: the agents a runner should work), project (id or name) and q (name, role, purpose, inputs, outputs, tools).',
  input:obj({env:ENV,status:{enum:Object.keys(AGENT_STATUS)},kind:{enum:Object.keys(AGENT_KINDS)},live:{type:'boolean'},project:REF('Project id or name.'),q:{type:'string',maxLength:200},...PAGE},['env']),output:list(S.agent),
  examples:[{title:'Active agents',input:{env:'default-workspace',status:'active'},output:{items:[EX.agent],nextCursor:null,rev:42}}]},
async(input,ctx)=>{
  const {w,data:d}=await open(ctx,input.env,'read');
  return page(filterAgents(d.agentflow,{status:input.status,kind:input.kind,live:input.live,q:input.q,project:input.project?resolve(d.projects,input.project,'name','project'):undefined}),input,w.rev);
});

op({id:'agents.get',method:'GET',path:B+'/agents/{agent}',scope:'read',tags:['agents'],summary:'Get an AgentFlow agent and its brief',
  description:'One agent by id or name, with `brief`: Markdown for whatever runs the agent (purpose, reporting line, inputs, outputs, tools, runtime, workflow steps, linked projects, cards and deadlines, instructions).',
  input:obj({env:ENV,agent:REF('Agent id or name.')},['env','agent']),output:out({rev:REV,agent:S.agent,brief:{type:'string'}}),
  examples:[{title:'Researcher',input:{env:'default-workspace',agent:'Researcher'},output:{rev:42,agent:EX.agent,brief:EX.brief}}]},
async(input,ctx)=>{const {w,data:d}=await open(ctx,input.env,'read'),a=agentOfRef(d,input.agent);return {rev:w.rev,agent:a,brief:agentBrief(d,a.id)}});

op({id:'agents.work',method:'GET',path:B+'/agents/{agent}/work',scope:'read',tags:['agents'],summary:'Get an agent\'s work queue',
  description:'What a runner needs to work as this agent: its `brief` and its queue, the open DevOps cards delegated to it (cards.update agents, or the card\'s Delegated to picker). Order: '+QUEUE_ORDER.join(', ')+' (work in progress first; Blocked and UAT wait on others), then soonest due date, then #number. `columns` narrows the queue, e.g. ["doing","requests"] for cards it can act on now. Report back with cards.update (checklist, links) and cards.move.',
  input:obj({env:ENV,agent:REF('Agent id or name.'),columns:{type:'array',items:COLUMN,description:'Only these columns (comma-separated in a query string).'},...PAGE},['env','agent']),
  output:out({rev:REV,agent:S.agent,brief:{type:'string'},items:{type:'array',items:S.card},nextCursor:{type:['string','null']}}),
  examples:[{title:'What should the researcher do now?',input:{env:'default-workspace',agent:'Researcher',columns:['doing','requests']},output:{rev:42,agent:EX.agent,brief:EX.brief,items:[EX.card],nextCursor:null}}]},
async(input,ctx)=>{
  const {w,data:d}=await open(ctx,input.env,'read'),a=agentOfRef(d,input.agent),by=agentsByCard(d);
  const q=workQueue(d,a.id).filter(c=>!input.columns?.length||input.columns.includes(c.column)).map(c=>cardOut(d,c,by));
  return {agent:a,brief:agentBrief(d,a.id),...page(q,input,w.rev)};
});

op({id:'agents.create',method:'POST',path:B+'/agents',scope:'write',tags:['agents'],summary:'Create an AgentFlow agent',
  description:'Add an agent to the AgentFlow org chart. References (reportsTo, supervisor, projects, cards, items) are ids or names; unknown ones are refused with 400, and a reporting loop with reports_loop.',
  input:obj({env:ENV,...AGENT_FIELDS},['env','name']),output:one('agent',S.agent),
  examples:[{title:'New research agent',input:{env:'default-workspace',name:'Researcher',title:'Research',status:'active',reportsTo:'Chief of staff',supervisor:'Cleo Park',inputs:['A card that needs research'],outputs:['Research notes on the card'],cards:['#12']},output:{rev:56,agent:EX.agent}}]},
async(input,ctx)=>write(ctx,input.env,d=>{
  if(d.agentflow.agents.length>=LIMITS.agents)fail(409,'too_many_agents',`A workspace holds up to ${LIMITS.agents} agents`);
  const a=newAgent(d.agentflow);agentFields(d,a,input);
  return d2=>({agent:d2.agentflow.agents.find(x=>x.id===a.id)});
}));

op({id:'agents.update',method:'PATCH',path:B+'/agents/{agent}',scope:'write',tags:['agents'],summary:'Update an AgentFlow agent',
  description:'Change an agent\'s fields. Lists you send (inputs, outputs, tools, projects, cards, items) replace the old ones. Moving it under one of its own reports is refused with reports_loop.',
  input:obj({env:ENV,agent:REF('Agent id or name.'),...AGENT_FIELDS},['env','agent']),output:one('agent',S.agent),
  examples:[{title:'Activate and link a card',input:{env:'default-workspace',agent:'Researcher',status:'active',cards:['#12']},output:{rev:57,agent:EX.agent}}]},
async(input,ctx)=>write(ctx,input.env,d=>{
  const a=agentOfRef(d,input.agent);agentFields(d,a,input);
  return d2=>({agent:d2.agentflow.agents.find(x=>x.id===a.id)});
}));

op({id:'agents.delete',method:'DELETE',path:B+'/agents/{agent}',scope:'write',tags:['agents'],summary:'Delete an AgentFlow agent',
  description:'Remove an agent. Its direct reports move up to its manager, and workflow steps it ran become unassigned.',
  input:obj({env:ENV,agent:REF('Agent id or name.')},['env','agent']),output:out({rev:REV,deleted:{type:'string'}}),
  examples:[{title:'Remove the researcher',input:{env:'default-workspace',agent:'Researcher'},output:{rev:58,deleted:'a1'}}]},
async(input,ctx)=>write(ctx,input.env,d=>{
  const a=agentOfRef(d,input.agent);removeAgent(d.agentflow,a.id);
  return ()=>({deleted:a.id});
}));

op({id:'runners.list',method:'GET',path:B+'/runners',scope:'read',tags:['agents'],summary:'List AgentFlow runners',
  description:'Machines or services that run agents, with the models each one offers, as they last reported (runners.report). An agent\'s runtime names a runner and its models are some of that runner\'s model ids. Each model may say its provider (a display group) and billing (included or metered).',
  input:obj({env:ENV,...PAGE},['env']),output:list(S.runner),
  examples:[{title:'Runners',input:{env:'default-workspace'},output:{items:[EX.runner],nextCursor:null,rev:42}}]},
async(input,ctx)=>{const {w,data:d}=await open(ctx,input.env,'read');return page(d.agentflow.runners,input,w.rev)});

op({id:'runners.report',method:'POST',path:B+'/runners/{runner}',scope:'write',tags:['agents'],summary:'Report a runner and its models',
  description:'A runner says what it can run, and optionally which scheduled jobs it found (systemd timers, cron, hosted crons...). The model list replaces the old one when sent (leave models out to keep the stored ones, e.g. when a runner reports the jobs of another machine it reaches over SSH), and so does jobs (leave it out to keep the stored jobs; [] clears them). Nothing is saved when nothing changed, so a runner may report on every pass: a report that only moves lastRun or nextRun is not saved either, unless the jobs were last saved 6 hours ago or more (jobsReported); a changed lastStatus, job or field always is. Agents name the runner in runtime and pick model ids; jobs show in the AgentFlow Scheduled tray, where they can be promoted into the org. A job can carry its full schedule: its timezone, every trigger with its raw expression, where it was read (origin, and the repo file), drift from the live schedule on the platform, and a note on conditions its script applies. Give each model a provider to group it by, and billing: included (a subscription or free) or metered (paid per use), which runners prefer included models by when picking automatically. Up to '+LIMITS.runners+' runners, '+LIMITS.models+' models and '+LIMITS.jobs+' jobs each.',
  input:obj({env:ENV,runner:REF('Runner name, e.g. Home server.'),models:{type:'array',maxItems:LIMITS.models,items:obj({id:{type:'string',minLength:1,maxLength:120},label:{type:'string',maxLength:160},
    provider:{type:'string',maxLength:80,description:'Display group, e.g. Claude or OpenCode.'},billing:{enum:Object.keys(BILLING),description:'included (a subscription or free) or metered (paid per use).'}},['id']),description:'The models this runner can run (replaces the stored list; leave out to keep it).'},
    jobs:{type:'array',maxItems:LIMITS.jobs,description:'Scheduled jobs on this runner (replaces the stored list; leave out to keep it, [] to clear).',items:obj({
      id:{type:'string',minLength:1,maxLength:200,description:'Stable per runner, e.g. systemd:backup.timer or vercel:my-app:/api/cron/sync.'},name:{type:'string',maxLength:120,description:'Defaults to the id.'},
      source:{type:'string',maxLength:40,description:'Where it is scheduled: systemd, cron, t3, vercel, railway, aside, windows, claude, codex, github or other (any text; defaults to other).'},
      group:{type:'string',maxLength:120,description:'Display group, e.g. "Home server" or "Vercel · my-app".'},schedule:{type:'string',maxLength:200,description:'When, in words, e.g. "Daily 22:30" or "Every 5 min".'},
      cron:{type:'string',maxLength:120,description:'The cron expression, when there is one.'},
      timezone:{type:'string',maxLength:64,description:'The zone its times are in: an IANA name such as America/Phoenix, "UTC", or "local" (the runner\'s own; see timezone on the runner).'},
      triggers:{type:'array',maxItems:LIMITS.triggers,description:'Every rule it fires on, e.g. each OnCalendar line of a systemd timer or each trigger of a Windows task.',items:obj({
        kind:{enum:Object.keys(JOB_TRIGGERS),description:'cron, calendar (a calendar rule such as systemd OnCalendar or a daily or weekly trigger), interval, logon, boot, once, rrule (RFC 5545), manual or other.'},
        expr:{type:'string',maxLength:200,description:'The raw expression as the scheduler holds it, e.g. "*/5 * * * *" or "Mon *-*-* 09:00:00".'},text:{type:'string',maxLength:200,description:'It in words, e.g. "Every 5 min".'}},['kind'])},
      origin:{enum:Object.keys(JOB_ORIGINS),description:'Where the schedule was read: repo (a config file in a repo; see file), platform (the hosting platform\'s API) or machine (the machine\'s own scheduler).'},
      file:{type:'string',maxLength:200,description:'The repo-relative path of the config it came from, e.g. services/worker/railway.json.'},
      drift:{type:'string',maxLength:200,description:'How the platform\'s live schedule differs from the repo file, when it does.'},
      note:{type:'string',maxLength:500,description:'Conditions the job\'s script applies itself, e.g. "Exits early when nothing changed".'},
      command:{type:'string',maxLength:300,description:'A short summary of what it runs.'},
      ai:{type:'boolean',description:'It starts an AI agent (promoted as an AI agent rather than an automation).'},enabled:{type:'boolean',default:true},
      lastRun:{type:'string',maxLength:40,description:'ISO time of the last run.'},lastStatus:{enum:Object.keys(JOB_STATUS)},nextRun:{type:'string',maxLength:40,description:'ISO time of the next run.'}},['id'])},
    timezone:{type:'string',maxLength:64,description:'The runner machine\'s time zone (an IANA name), which jobs with timezone "local" are in. Left out, the stored one stays.'}},['env','runner']),
  output:out({rev:REV,runner:S.runner,changed:{type:'boolean'}}),
  examples:[{title:'Home server',input:{env:'default-workspace',runner:'Home server',models:[{id:'claudeAgent:claude-sonnet-5-5',label:'Claude · Sonnet 5.5',provider:'Claude',billing:'included'}]},output:{rev:59,runner:EX.runner,changed:true}},
    {title:'With scheduled jobs',input:{env:'default-workspace',runner:'Home server',models:[{id:'claudeAgent:claude-sonnet-5-5',label:'Claude · Sonnet 5.5'}],jobs:[EX.job]},output:{rev:60,runner:{...EX.runner,jobs:[EX.job],jobsReported:T},changed:true}}]},
async(input,ctx)=>{
  const {w,data:d}=await open(ctx,input.env,'read'),name=input.runner.trim(),rep={models:input.models,jobs:input.jobs,timezone:input.timezone};
  const first=reportRunner(runnerOf(d.agentflow,name),name,rep);
  if(!first.changed)return {rev:w.rev,runner:first.runner,changed:false};
  return {...await write(ctx,input.env,d2=>{
    const rs=d2.agentflow.runners,i=rs.findIndex(r=>r.name.toLowerCase()===name.toLowerCase()),r=reportRunner(i<0?null:rs[i],name,rep).runner;
    if(i<0&&rs.length>=LIMITS.runners)fail(409,'too_many_runners',`A workspace holds up to ${LIMITS.runners} runners`);
    if(i<0)rs.push(r);else if(r)rs[i]=r;
    return d3=>({runner:runnerOf(d3.agentflow,name)});
  }),changed:true};
});

op({id:'workflows.list',method:'GET',path:B+'/workflows',scope:'read',tags:['workflows'],summary:'List AgentFlow workflows',
  description:'Workflows: ordered steps, each handled by an agent, started by hand, on a schedule or by an event. Filters: status, agent (id or name: workflows with a step it runs), project and q.',
  input:obj({env:ENV,status:{enum:Object.keys(WORKFLOW_STATUS)},agent:REF('Agent id or name.'),project:REF('Project id or name.'),q:{type:'string',maxLength:200},...PAGE},['env']),output:list(S.workflow),
  examples:[{title:'Workflows the researcher is in',input:{env:'default-workspace',agent:'Researcher'},output:{items:[EX.workflow],nextCursor:null,rev:42}}]},
async(input,ctx)=>{
  const {w,data:d}=await open(ctx,input.env,'read');
  return page(filterWorkflows(d.agentflow,{status:input.status,q:input.q,agent:input.agent?agentRef(d,input.agent):undefined,project:input.project?resolve(d.projects,input.project,'name','project'):undefined}),input,w.rev);
});

op({id:'workflows.get',method:'GET',path:B+'/workflows/{workflow}',scope:'read',tags:['workflows'],summary:'Get an AgentFlow workflow and its brief',
  description:'One workflow by id or name, with `brief`: Markdown listing its trigger, its steps with the agent for each, and its linked projects, cards and deadlines.',
  input:obj({env:ENV,workflow:REF('Workflow id or name.')},['env','workflow']),output:out({rev:REV,workflow:S.workflow,brief:{type:'string'}}),
  examples:[{title:'Ship a card',input:{env:'default-workspace',workflow:'Ship a card'},output:{rev:42,workflow:EX.workflow,brief:'# Ship a card\n\nWorkflow · Active · Event: A card enters Doing\n'}}]},
async(input,ctx)=>{const {w,data:d}=await open(ctx,input.env,'read'),f=workflowOf(d,input.workflow);return {rev:w.rev,workflow:f,brief:workflowBrief(d,f.id)}});

op({id:'workflows.create',method:'POST',path:B+'/workflows',scope:'write',tags:['workflows'],summary:'Create an AgentFlow workflow',
  description:'Add a workflow. Each step names an agent (id or name, or "" for unassigned), what it does and what it produces. Links (projects, cards, items) are ids or names.',
  input:obj({env:ENV,...WORKFLOW_FIELDS},['env','name']),output:one('workflow',S.workflow),
  examples:[{title:'Ship a card',input:{env:'default-workspace',name:'Ship a card',status:'active',trigger:'event',schedule:'A card enters Doing',steps:[{agent:'Researcher',action:'Research the approach',output:'Notes on the card'}],projects:['Lantern']},output:{rev:59,workflow:EX.workflow}}]},
async(input,ctx)=>write(ctx,input.env,d=>{
  if(d.agentflow.workflows.length>=LIMITS.workflows)fail(409,'too_many_workflows',`A workspace holds up to ${LIMITS.workflows} workflows`);
  const f=newWorkflow(d.agentflow);workflowFields(d,f,input);
  return d2=>({workflow:d2.agentflow.workflows.find(x=>x.id===f.id)});
}));

op({id:'workflows.update',method:'PATCH',path:B+'/workflows/{workflow}',scope:'write',tags:['workflows'],summary:'Update an AgentFlow workflow',
  description:'Change a workflow\'s fields. `steps` you send replace the old ones (keep a step\'s `id` to keep it); so do projects, cards and items.',
  input:obj({env:ENV,workflow:REF('Workflow id or name.'),...WORKFLOW_FIELDS},['env','workflow']),output:one('workflow',S.workflow),
  examples:[{title:'Pause it',input:{env:'default-workspace',workflow:'Ship a card',status:'paused'},output:{rev:60,workflow:{...EX.workflow,status:'paused'}}}]},
async(input,ctx)=>write(ctx,input.env,d=>{
  const f=workflowOf(d,input.workflow);workflowFields(d,f,input);
  return d2=>({workflow:d2.agentflow.workflows.find(x=>x.id===f.id)});
}));

op({id:'search',method:'GET',path:B+'/search',scope:'read',tags:['search'],summary:'Search an environment',
  description:'Case-insensitive search over chart nodes (name, notes), projects, timeline items (title, notes), cards (#number, title, description), AgentFlow agents (name, role, purpose) and workflows (name, description). `types` narrows it (comma-separated in a query string).',
  input:obj({env:ENV,q:{type:'string',minLength:1,maxLength:200},types:{type:'array',items:{enum:['node','project','item','card','agent','workflow']}},...PAGE},['env','q']),output:list(S.hit),
  examples:[{title:'Sign-up',input:{env:'default-workspace',q:'sign-up'},output:{items:[{type:'card',id:'k1',title:'Build sign-up form',number:12}],nextCursor:null,rev:42}}]},
async(input,ctx)=>{
  const {w,data:d}=await open(ctx,input.env,'read'),q=norm(input.q),num=/^#?\d+$/.test(q)?Number(q.replace('#','')):null,has=(...s)=>s.some(v=>norm(v).includes(q)),want=t=>!input.types?.length||input.types.includes(t);
  const hits=[
    ...want('node')?d.charts.flatMap(c=>c.nodes.filter(n=>has(n.name,n.notes)).map(n=>({type:'node',id:n.id,title:n.name,chart:c.id}))):[],
    ...want('project')?d.projects.filter(p=>has(p.name)).map(p=>({type:'project',id:p.id,title:p.name})):[],
    ...want('item')?d.timeline.filter(i=>has(i.title,i.notes)).map(i=>({type:'item',id:i.id,title:i.title})):[],
    ...want('card')?d.devops.cards.filter(c=>c.number===num||has(c.title,c.description)).map(c=>({type:'card',id:c.id,title:c.title,number:c.number})):[],
    ...want('agent')?d.agentflow.agents.filter(a=>has(a.name,a.title,a.purpose)).map(a=>({type:'agent',id:a.id,title:a.name})):[],
    ...want('workflow')?d.agentflow.workflows.filter(w=>has(w.name,w.description)).map(w=>({type:'workflow',id:w.id,title:w.name})):[],
  ];
  return page(hits,input,w.rev);
});

export const getOperation=id=>operations.find(o=>o.id===id)||null;

export async function invoke(id,input,ctx){
  const o=getOperation(id);if(!o)fail(404,'unknown_operation',`No operation ${id}`);
  if(!ctx?.user?.email)fail(401,'unauthorized','Sign in or send an API key');
  const raw=input&&typeof input==='object'&&!Array.isArray(input)?input:fail(400,'invalid_input','Input must be an object');
  const problems=check(o.input,raw);if(problems.length)fail(400,'invalid_input',problems.join('; '),{details:problems});
  return handlers.get(id)(withDefaults(o.input,raw),ctx);
}
