// The operation registry: one list of operations drives the REST API (lib/api-v1.mjs), its
// OpenAPI document, MCP tools, the CLI and the docs. Each operation is plain data:
//   {id, method, path, scope:'read'|'write'|'admin', tags, summary, description, input, output, examples:[{title,input,output}]}
// `input` is one flat JSON Schema object holding the path parameters ({env}, {card}, ...), query
// parameters (GET/DELETE) and body fields (POST/PATCH) together, so MCP and the CLI pass one object.
// invoke(id, input, ctx) checks the input against that schema and runs the operation.
//   ctx = {user:{id,email}, store, envCheck(envId,user,'read'|'write'), proposals?}
//   proposals: {list(envId,user,{status}), decide(id,user,approve)} for share additions (server.mjs).
//   store: lib/workspaces.mjs workspaceStore(); envCheck: truthy when the user may read/write it.
//   Optional: ctx.office (lib/office.mjs officeState(), office.*), ctx.sharing (lib/share-service.mjs forUser(), shares.*).
// Errors are thrown as {status, code, message} (an Error carrying those fields).
//
// Writes are revision-checked: read the workspace, change a copy, clean it with the client's own
// cleaners (lib/cleaners.mjs, public/devops-core.js), then store.put() with the revision it started
// from. If someone saved in between, the change is re-applied to the newer copy (up to 5 times).
// References accept an id or a name (project, label, person, entity, timeline item), like the inbox.
import {check,withDefaults} from './json-schema.mjs';
import {RETAIN_DAYS} from './workspaces.mjs';
import {REPOS_MAX,REPO_MAX} from './cleaners.mjs';
import {normalize,validChart,ITEM_KINDS,ITEM_STATUS,ITEM_PRIORITY,PERSON_IMAGE_MAX,PERSON_EMAIL_MAX,validPersonImage,cleanPersonEmail} from './cleaners.mjs';
import {COLUMNS,ROLES,LINK_KINDS,SECTIONS,COLORS,NEW_COLUMN,gateFor,moveCard,newCard,filterCards,snoozeIso} from '../public/devops-core.js';
import {AGENT_KINDS,AGENT_STATUS,WORKFLOW_STATUS,TRIGGERS,LIMITS,newAgent,newWorkflow,removeAgent,canReportTo,pin,delegate,workQueue,agentsForCard,QUEUE_ORDER,filterAgents,filterWorkflows,agentBrief,workflowBrief,runnerOf,reportRunner,cleanJobLink,BILLING,JOB_STATUS,JOB_ORIGINS,JOB_TRIGGERS} from '../public/agentflow-core.js';

const fail=(status,code,message,extra={})=>{throw Object.assign(new Error(message),{status,code,message,...extra})};
const uid=()=>crypto.randomUUID(),norm=s=>String(s??'').trim().toLowerCase(),now=()=>new Date().toISOString();

// ---------- schemas ----------
const obj=(properties,required=[])=>({type:'object',properties,required,additionalProperties:false});
const out=(properties,required=Object.keys(properties))=>({type:'object',properties,required});
const ENV={type:'string',pattern:'^[A-Za-z0-9-]{1,64}$',description:'Environment id (see envs.list).'};
const REF=d=>({type:'string',minLength:1,maxLength:200,description:d});
const DATE={type:'string',pattern:'^(\\d{4}-\\d{2}-\\d{2})?$',description:'YYYY-MM-DD, or "" for none.'};
const SNOOZE='When the snooze ends (ISO time). Until then the board hides the card for everyone (a column header can show its snoozed cards); afterwards it is a normal card again. null when not snoozed.';
const ACTUAL='Points the card actually took, recorded after the work (for example from the agents\' token use). Separate from points, the up-front estimate.';
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
    image:{type:'string',description:'Person photo: an https URL or a data:image/(png|jpeg|webp);base64 URL.'},email:{type:'string',description:'Person email, matching them to an account.'},
    opidUser:{type:'string',description:'Read only: the OneProfileID account the person linked this card to, so it shows their account photo. Only that person can link it, from the app. Changing or removing the card\'s email unlinks it.'}},['id','name','type','x','y']),
  edge:out({id:{type:'string'},from:{type:'string'},to:{type:'string'},type:{enum:EDGE_TYPES},percent:{type:'string'}}),
  project:out({id:{type:'string'},name:{type:'string'},color:{type:'string'},entity:{type:'string'},repos:{type:'array',items:{type:'string'},description:'Code repositories that belong to the project (absent when none).'}},['id','name','color','entity']),
  item:out({id:{type:'string'},title:{type:'string'},kind:{enum:ITEM_KINDS},status:{enum:ITEM_STATUS},start:{type:'string'},end:{type:'string'},priority:{type:'string'},release:{type:'string'},projects:{type:'array',items:{type:'string'}},owner:{type:'string'},link:{type:'string'},notes:{type:'string'}},['id','title','kind','status','start','end','projects']),
  card:out({id:{type:'string'},number:{type:'integer'},title:{type:'string'},description:{type:'string'},column:{type:'string'},project:{type:'string'},labels:{type:'array',items:{type:'string'}},points:{type:['number','null']},actual:{type:['number','null'],description:ACTUAL},due:{type:'string'},snoozedUntil:{type:['string','null'],description:SNOOZE},
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
// How a deleted card was removed (lib/workspaces.mjs records every removal): deleted on the board, by
// undo or redo, by a snapshot restore or other whole-workspace save from a browser, through the API or MCP.
const DELETED_VIA=['board','undo','snapshot','save','api','mcp','relay'];
S.deleted=out({id:{type:'string',description:'Entry id, for cards.restore.'},env:{type:'string'},cardId:{type:'string'},number:{type:['integer','null']},title:{type:'string'},
  card:{...S.card,description:'The card as it was when it was removed.'},deletedAt:{type:'string'},deletedBy:{type:'string',description:'Email of the account that saved the change.'},
  via:{enum:DELETED_VIA,description:'board (deleted on the board), undo (undo or redo), snapshot (a snapshot restore or other whole-workspace save from a browser), save (a save from an older browser tab), api, mcp, relay.'},
  actor:{type:'string',description:'The API key\'s name, when an API key or MCP client removed it.'},fromRev:{type:'integer',description:'The last revision the card was in.'},rev:{type:'integer',description:'The revision that removed it.'},
  restoredAt:{type:['string','null']},restoredBy:{type:'string'},restoredNumber:{type:['integer','null'],description:'The number it was restored as.'}},
  ['id','env','cardId','number','title','card','deletedAt','deletedBy','via','actor','fromRev','rev','restoredAt']);
const list=item=>out({items:{type:'array',items:item},nextCursor:{type:['string','null']},rev:REV});
const one=(k,s)=>out({rev:REV,[k]:s});
// Creates: inside a share whose owner approves additions, pending: true (the owner has not approved it yet).
const PENDING={type:'boolean',description:'Only when true: the record was added inside a share whose owner approves additions, and waits for them (docs/sharing.md). It shows as "Pending approval" until they approve or deny it.'};
const SHARE_INPUT={type:'string',pattern:'^[A-Za-z0-9_-]{1,64}$',description:'Add it to the owner of a share placed in this environment (the <share> in its sh.<share>.<id> ids), when that share lets you add. Without it, a record that refers to a share\'s records (a card in a shared project, say) goes to that share\'s owner anyway.'};
const oneNew=(k,s)=>out({rev:REV,[k]:s,pending:PENDING},['rev',k]);

// Card fields shared by create and update (column moves go through cards.move and its gates).
const CARD_FIELDS={
  title:{type:'string',minLength:1,maxLength:200},description:{type:'string',maxLength:8000},
  project:REF('Project id or name; "" for none.'),labels:{type:'array',maxItems:50,items:REF('Label id or name.')},
  points:{type:['number','null'],minimum:0,maximum:1000},actual:{type:['number','null'],minimum:0,maximum:1000,description:ACTUAL},due:DATE,
  snoozedUntil:{type:['string','null'],maxLength:40,description:'Snooze the card until this time: an ISO time such as 2026-11-23T16:00:00Z (include Z or a time zone offset). "" or null wakes it. A time already past wakes it too.'},
  assignees:{type:'array',maxItems:20,items:obj({node:REF('A person on a chart (node id or name), or someone the card is shared with (@email, email or name).'),role:{enum:ROLES,default:'developer'}},['node'])},
  checklist:{type:'array',maxItems:200,items:obj({id:{type:'string'},text:{type:'string',minLength:1,maxLength:300},done:{type:'boolean'}},['text'])},
  links:{type:'array',maxItems:50,items:obj({id:{type:'string'},kind:{enum:Object.keys(LINK_KINDS)},url:{type:'string',minLength:1,maxLength:500}},['url'])},
  item:REF('Timeline item id or title; "" for none.'),
  agents:{type:'array',maxItems:20,items:REF('AgentFlow agent id or name.'),description:'Delegate the card to these agents (replaces the list; [] for none). It joins each one\'s work queue (agents.work).'},
};
CARD_FIELDS.project.minLength=0;CARD_FIELDS.item.minLength=0;
// Optional guard for read-change-write (e.g. adding to a description you read): the card's `updated` as you read it.
const IF_UPDATED={type:'string',maxLength:40,description:'The card\'s `updated` as you read it (cards.get). If the card changed since, nothing is written: 409 card_changed, with the current card in details.card. Read it again and reapply your change.'};
// The card as read must still be the card now (ifUpdated), or the caller would overwrite a newer edit.
const unchanged=(d,c,input)=>{if(input.ifUpdated!=null&&input.ifUpdated!==c.updated)fail(409,'card_changed',`Card #${c.number} changed since you read it (updated ${c.updated}). Read it again and reapply your change.`,{details:{card:cardOut(d,c)}})};
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
  schedule:{type:'string',maxLength:200,description:'When it runs, in plain words or cron, e.g. "Weekdays 09:00" (a note carried in the brief for an AI agent; the reference runner does not start work from it); "" for none.'},
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
  card:{id:'k1',number:12,title:'Build sign-up form',description:'',column:'requests',project:'p1',labels:['l-high'],points:3,actual:null,due:'2026-11-15',assignees:[{node:'cleo',role:'developer'}],checklist:[{id:'x1',text:'Email field',done:false}],links:[],item:'i1',created:T,updated:T,moved:T,snoozedUntil:null,agents:['a1']},
  label:{id:'l-research',name:'Research',section:'area',color:'teal'},
  agent:{id:'a1',name:'Researcher',kind:'agent',title:'Research',status:'active',live:false,reportsTo:'a0',supervisor:'cleo',purpose:'Gathers context before work starts.',instructions:'',runtime:'T3',models:[],model:'',auto:false,schedule:'Weekdays 09:00',
    inputs:['A card that needs research'],outputs:['Research notes on the card'],tools:['Web search'],projects:['p1'],cards:['k1'],items:['i1'],created:T,updated:T},
  workflow:{id:'w1',name:'Ship a card',description:'',status:'active',trigger:'event',schedule:'A card enters Doing',steps:[{id:'s1',agent:'a1',action:'Research the approach',output:'Notes on the card'}],projects:['p1'],cards:[],items:[],created:T,updated:T},
};
EX.deleted={id:'del_6f1c2a4e-0b7d-4c55-9a3e-2d8f1b0c9e11',env:'default-workspace',cardId:'k1',number:12,title:'Build sign-up form',card:{...EX.card,agents:['a1']},deletedAt:T,deletedBy:'owner@example.test',
  via:'snapshot',actor:'',fromRev:61,rev:62,restoredAt:null,restoredBy:'',restoredNumber:null};
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
// One at a time per environment, so parallel calls queue instead of using up each other's retries;
// the revision check still covers other writers (browsers, another server during a deploy).
const writes=new Map();
function inTurn(envId,fn){
  const run=(writes.get(envId)||Promise.resolve()).then(fn),tail=run.catch(()=>{});
  writes.set(envId,tail);
  tail.then(()=>{if(writes.get(envId)===tail)writes.delete(envId)});
  return run;
}
const write=(ctx,envId,fn)=>inTurn(envId,()=>writeNow(ctx,envId,fn));
async function writeNow(ctx,envId,fn){
  for(let i=0;i<5;i++){
    const {w,data}=await open(ctx,envId,'write');
    const pick=fn(data);
    normalize(data);
    if(!Array.isArray(data.charts)||!data.charts.length||!data.charts.every(validChart))fail(400,'invalid_chart','That change would leave a chart invalid');
    const r=await ctx.store.put(envId,{baseRev:w.rev,data,by:ctx.user.email,owner:w.owner,visibility:w.visibility,name:w.name,source:{via:ctx.via||'api',actor:ctx.user.key?.name||''}});
    if(r.refused)fail(r.refused.status,r.refused.code,r.refused.error);
    if(r.ok)return r.added?addedTo(r.added,{rev:r.rev,...pick(data)}):{rev:r.rev,...pick(data)};
  }
  fail(409,'conflict','The workspace kept changing; try again');
}
// A record made inside a share went to its owner (store.put's added: {id it had: {id, pending, number?}}): the
// result names it by its linked id, with pending: true while the owner has not approved it yet. A card the
// owner took at once carries the owner's #number (the one the board shows after sync), not the local one.
function addedTo(added,result){
  let pending=false;
  const walk=v=>{if(typeof v==='string'&&added[v]){pending||=added[v].pending;return added[v].id}
    if(Array.isArray(v))return v.map(walk);
    if(v&&typeof v==='object'){const a=typeof v.id==='string'?added[v.id]:null,o=Object.fromEntries(Object.entries(v).map(([k,x])=>[k,walk(x)]));
      if(a&&Number.isInteger(a.number)&&Number.isInteger(v.number))o.number=a.number;return o}
    return v};
  const out=walk(result);return pending?{...out,pending:true}:out;
}
// share input: a new record for the owner of a share placed in this environment (docs/sharing.md, additions).
// It gets the id sh.<share>.new-<id>, which marks it for that share.
function shareFor(d,ref){
  if(ref===undefined)return null;
  const s=(d.shares||[]).find(x=>x.id===ref)||fail(404,'share_not_found',`No share ${ref} in this environment`);
  return s.id;
}
const newId=(d,share)=>share?`sh.${share}.new-${uid()}`:uid();
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
// People a card can be assigned to besides person cards: share members (docs/sharing.md, card #63). On a
// linked card (sh.<share>.<id>), the members of its share; on one's own card, the recipients of the shares
// that cover it (shareMembers). With no card (filters), every member. Matched by id (@email), email or name.
const membersFor=(d,c,share)=>{
  const sid=share||(c?/^sh\.([A-Za-z0-9_-]+)\./.exec(c.id)?.[1]:null),mine=(d.shareMembers||[]).filter(m=>!c||m.cards?.includes(c.id));
  if(sid)return (d.shares||[]).find(s=>s.id===sid)?.members||[];
  return c?mine:[...(d.shares||[]).flatMap(s=>s.members||[]),...mine];
};
// The share a card belongs to or goes to: its own linked id, else a linked project or item it sits in.
const cardShare=c=>{for(const v of [c?.id,c?.project,c?.item]){const m=typeof v==='string'&&/^sh\.([A-Za-z0-9_-]+)\./.exec(v);if(m)return m[1]}return null};
function assignee(d,ref,c){
  const shared=cardShare(c),people=allNodes(d).filter(n=>n.type==='person'),r=norm(ref),mem=membersFor(d,c,shared);
  const member=()=>mem.find(m=>m.id===ref)||mem.find(m=>norm(m.email)===r)||mem.find(m=>norm(m.name)===r);
  const sharedPeople=people.filter(v=>v.id.startsWith(`sh.${shared}.`));
  const node=(list=people)=>list.find(v=>v.id===ref)||list.find(v=>norm(v.name)===r);
  // A shared card is assigned to the share's people only: its owner never sees anyone else, so one's own
  // person card would be dropped on sync. Refuse it instead, naming who can be.
  if(shared){
    const x=member()||node(sharedPeople);if(x)return x.id;
    if(node())fail(400,'person_not_in_share',`"${ref}" is a person in your own environment, which this shared card's owner cannot see. Assign someone in the share instead: their linked person card (sh.${shared}.…) or a share member (@email)`);
    fail(400,'unknown_person',`No person "${ref}" who can be assigned to this card`);
  }
  const x=node()||member();
  return x?x.id:fail(400,'unknown_person',`No person "${ref}"${c?' who can be assigned to this card':''}`);
}
const cardOf=(d,ref)=>{const s=String(ref),n=/^#?\d+$/.test(s)?Number(s.replace('#','')):null;return d.devops.cards.find(c=>n!==null?c.number===n:c.id===s)||fail(404,'card_not_found',`No card ${s}`)};
const strip=c=>{const {inbox,...rest}=c;return rest};
// A card as the API returns it: without the inbox stamp, with the agents it is delegated to.
const cardOut=(d,c,by)=>({...strip(c),snoozedUntil:c.snoozedUntil||null,agents:(by?by.get(c.id)||[]:agentsForCard(d.agentflow,c.id).map(a=>a.id))});
const agentsByCard=d=>{const m=new Map();for(const a of d.agentflow.agents)for(const id of a.cards)m.set(id,[...(m.get(id)||[]),a.id]);return m};
const summary=w=>({id:w.envId,name:w.name||w.data?.environment?.name||'Workspace',visibility:w.visibility,owner:w.owner,rev:w.rev,updatedAt:w.updatedAt||null});

// Card fields from input (references resolved) onto a card.
function cardFields(d,c,input){
  const set=(k,v)=>{if(input[k]!==undefined)c[k]=v(input[k])};
  set('title',v=>v);set('description',v=>v);set('points',v=>v);set('actual',v=>v);set('due',v=>v);
  if(input.snoozedUntil!==undefined){
    const v=input.snoozedUntil,iso=snoozeIso(v);
    if(v!==null&&v!==''&&!iso)fail(400,'invalid_snooze','snoozedUntil must be an ISO date and time, or "" / null to wake the card');
    if(iso&&Date.parse(iso)>Date.now())c.snoozedUntil=iso;else delete c.snoozedUntil;
  }else if(c.snoozedUntil&&Date.parse(c.snoozedUntil)<=Date.now())delete c.snoozedUntil; // a snooze that ended: tidy it on the next write
  set('project',v=>resolve(d.projects,v,'name','project'));
  set('labels',v=>[...new Set(v.map(l=>resolve(d.devops.labels,l,'name','label')))]);
  set('item',v=>resolve(d.timeline,v,'title','item'));
  set('assignees',v=>v.map(a=>({node:assignee(d,a.node,c),role:a.role||'developer'})));
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
  description:'Environments (workspaces) you own, newest first. Use an id from here as {env} in every other call. What others share with you is inside the environment you added it to: a chart named "Shared · <their environment>" (unless you moved its cards), with ids sh.<share>.<id>. Edits to it go back to its owner when the share allows them.',
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
  email:{type:'string',maxLength:PERSON_EMAIL_MAX,description:'Person cards only: their email, so the app can show the matching account photo. Never shared with share recipients. Changing or removing it unlinks the card from its OneProfileID account. "" removes it.'}};
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
  description:'Add a card to a chart. Without x/y it is placed at the origin, stepping 32px diagonally past occupied spots (as the app does). On a share\'s chart ("Shared · …") it is added to the share\'s owner when the share lets you add (pending: true while it waits for their approval); a share that does not is refused with 403 share_adds_off.',
  input:obj({env:ENV,chart:CHART,type:{enum:NODE_TYPES},...NODE_FIELDS,x:{type:'number'},y:{type:'number'}},['env','chart','type','name']),output:oneNew('node',S.node),
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
  description:'Connect two cards on the same chart. A second edge between the same pair (same direction) is refused with 409. Joining two cards of the same share adds the connection to its owner, as nodes.create does.',
  input:obj({env:ENV,chart:CHART,from:REF('Node id.'),to:REF('Node id.'),type:{enum:EDGE_TYPES,default:'ownership'},percent:{type:['string','number'],description:'0-100, or "" for unspecified.'}},['env','chart','from','to']),output:oneNew('edge',S.edge),
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

op({id:'edges.update',method:'PATCH',path:B+'/charts/{chart}/edges/{edge}',scope:'write',tags:['edges'],summary:'Update an edge',
  description:'Change a connection\'s ownership percent or its type, keeping the edge. Fields left out stay as they are; a group edge carries no percent. On a share\'s chart an edit share lets you change the percent, and the change goes back to its owner; the type stays the owner\'s.',
  input:obj({env:ENV,chart:CHART,edge:REF('Edge id.'),type:{enum:EDGE_TYPES},percent:{type:['string','number'],description:'0-100, or "" for unspecified.'}},['env','chart','edge']),output:one('edge',S.edge),
  examples:[{title:'Full ownership',input:{env:'default-workspace',chart:'active',edge:'o1',percent:'100'},output:{rev:46,edge:{...EX.edge,percent:'100'}}}]},
async(input,ctx)=>write(ctx,input.env,d=>{
  const c=chartOf(d,input.chart),e=c.edges.find(x=>x.id===input.edge);if(!e)fail(404,'edge_not_found',`No edge ${input.edge}`);
  if(input.type!==undefined)e.type=input.type;
  if(input.percent!==undefined){
    const p=String(input.percent).trim();
    if(p!==''&&(!Number.isFinite(Number(p))||Number(p)<0||Number(p)>100))fail(400,'invalid_percent','percent must be 0-100 or ""');
    e.percent=p===''?'':String(Number(p));
  }
  if(e.type==='group')e.percent='';
  return d2=>({edge:chartOf(d2,input.chart).edges.find(x=>x.id===e.id)});
}));

op({id:'edges.delete',method:'DELETE',path:B+'/charts/{chart}/edges/{edge}',scope:'write',tags:['edges'],summary:'Delete an edge',
  description:'Remove one connection. The cards it joined stay. Earlier revisions are kept in the workspace history.',
  input:obj({env:ENV,chart:CHART,edge:REF('Edge id.')},['env','chart','edge']),output:out({rev:REV,deleted:{type:'string'}}),
  examples:[{title:'Delete',input:{env:'default-workspace',chart:'active',edge:'o1'},output:{rev:46,deleted:'o1'}}]},
async(input,ctx)=>write(ctx,input.env,d=>{
  const c=chartOf(d,input.chart);if(!c.edges.some(e=>e.id===input.edge))fail(404,'edge_not_found',`No edge ${input.edge}`);
  c.edges=c.edges.filter(e=>e.id!==input.edge);return ()=>({deleted:input.edge});
}));

const PROJECT_FIELDS={name:{type:'string',minLength:1,maxLength:80},color:COLOR_HEX,entity:{...REF('The chart entity or area it sits under: node id or name; "" for none.'),minLength:0},
  repos:{type:'array',maxItems:REPOS_MAX,items:{type:'string',minLength:1,maxLength:REPO_MAX},description:'Code repositories that belong to the project: a name ("flow"), owner/name ("acme/flow") or a git remote URL. The 3D office shows a teammate\'s live agent working in one of them to everyone who can see this project. Replaces the list; [] clears it.'}};
const entityOf=(d,ref)=>resolve(allNodes(d).filter(n=>n.type==='entity'||n.type==='area'),ref,'name','entity');
const projectNamed=(d,name,not)=>d.projects.some(p=>p.id!==not&&norm(p.name)===norm(name))&&fail(409,'project_exists',`A project named "${name}" exists`);
op({id:'projects.list',method:'GET',path:B+'/projects',scope:'read',tags:['projects'],summary:'List projects',
  description:'Timeline/board projects (coloured tags), optionally only those under one chart entity or area.',
  input:obj({env:ENV,entity:REF('Node id.'),...PAGE},['env']),output:list(S.project),
  examples:[{title:'Projects',input:{env:'default-workspace'},output:{items:[EX.project],nextCursor:null,rev:42}}]},
async(input,ctx)=>{const {w,data:d}=await open(ctx,input.env,'read');return page(d.projects.filter(p=>!input.entity||p.entity===input.entity),input,w.rev)});

op({id:'projects.create',method:'POST',path:B+'/projects',scope:'write',tags:['projects'],summary:'Create a project',
  description:'Add a project. Names are unique (case-insensitive); a duplicate gets 409. Without a colour the next palette colour is used. Under a shared entity, or with share, it is added to that share\'s owner when the share lets you add (pending: true while it waits for their approval).',
  input:obj({env:ENV,...PROJECT_FIELDS,share:SHARE_INPUT},['env','name']),output:oneNew('project',S.project),
  examples:[{title:'Under Kestrel Group',input:{env:'default-workspace',name:'Lantern',color:'#7cb980',entity:'Kestrel Group'},output:{rev:47,project:EX.project}}]},
async(input,ctx)=>write(ctx,input.env,d=>{
  projectNamed(d,input.name);
  const p={id:newId(d,shareFor(d,input.share)),name:input.name,color:input.color||'',entity:input.entity?entityOf(d,input.entity):'',...(input.repos?.length?{repos:input.repos}:{})};
  d.projects.push(p);return d2=>({project:d2.projects.find(x=>x.id===p.id)});
}));

op({id:'projects.update',method:'PATCH',path:B+'/projects/{project}',scope:'write',tags:['projects'],summary:'Update a project',
  description:'Rename, recolour or re-parent a project, or set its code repositories (repos). {project} is its id or name.',
  input:obj({env:ENV,project:REF('Project id or name.'),...PROJECT_FIELDS},['env','project']),output:one('project',S.project),
  examples:[{title:'Recolour',input:{env:'default-workspace',project:'Lantern',color:'#3d6fb6'},output:{rev:48,project:{...EX.project,color:'#3d6fb6'}}}]},
async(input,ctx)=>write(ctx,input.env,d=>{
  const id=resolve(d.projects,input.project,'name','project'),p=d.projects.find(x=>x.id===id);
  if(input.name!==undefined){projectNamed(d,input.name,id);p.name=input.name}
  if(input.color!==undefined)p.color=input.color;
  if(input.entity!==undefined)p.entity=entityOf(d,input.entity);
  if(input.repos!==undefined){if(input.repos.length)p.repos=input.repos;else delete p.repos}
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
  description:'Add a timeline item. Without a start date it is backlog (Board and List only). Kind defaults to milestone when dated, feature otherwise. Tagged only with shared projects, or with share, it is added to that share\'s owner when the share lets you add (pending: true while it waits for their approval).',
  input:obj({env:ENV,...ITEM_FIELDS,share:SHARE_INPUT},['env','title']),output:oneNew('item',S.item),
  examples:[{title:'A release',input:{env:'default-workspace',title:'Public beta',kind:'release',start:'2026-12-01',projects:['Lantern']},output:{rev:49,item:EX.item}}]},
async(input,ctx)=>write(ctx,input.env,d=>{
  const i={id:newId(d,shareFor(d,input.share)),title:'',kind:input.start?'milestone':'feature',status:'planned',start:'',end:'',priority:'',release:'',projects:[],owner:'',link:'',notes:''};
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
  description:'Board cards in board order. Filters: column, project (id, name or "none"), label (id or name), assignee (person id or name), agent (AgentFlow agent: cards delegated to it), q ("#12" or title text), hideDone, snoozed (true: only cards snoozed now; false: only awake ones; left out: both). notProject, notLabel, notAssignee, notAgent and notEntity leave out cards that match. Include and exclude combine.',
  input:obj({env:ENV,column:COLUMN,project:REF('Project id or name, or "none".'),label:REF('Label id or name.'),assignee:REF('Person node id or name, or a share member (@email or email).'),agent:REF('AgentFlow agent id or name: cards delegated to it.'),notProject:REF('Project id or name, or "none": leave these cards out.'),notLabel:REF('Label id or name: leave cards with this label out.'),notAssignee:REF('Person node id or name, or a share member (@email or email): leave their cards out.'),notAgent:REF('AgentFlow agent id or name: leave out cards delegated to it.'),notEntity:REF('Entity or area id or name: leave out cards in the projects under it.'),q:{type:'string',maxLength:200},hideDone:{type:'boolean'},snoozed:{type:'boolean',description:'true: only cards snoozed now; false: leave them out.'},...PAGE},['env']),output:list(S.card),
  examples:[{title:'Open cards for a project',input:{env:'default-workspace',project:'Lantern',hideDone:true},output:{items:[EX.card],nextCursor:null,rev:42}}]},
async(input,ctx)=>{
  const {w,data:d}=await open(ctx,input.env,'read');
  const f={q:input.q,hideDone:input.hideDone,projects:input.project?[input.project==='none'?'none':resolve(d.projects,input.project,'name','project')]:undefined,
    notProject:input.notProject?(input.notProject==='none'?'none':resolve(d.projects,input.notProject,'name','project')):undefined,
    label:input.label?resolve(d.devops.labels,input.label,'name','label'):undefined,notLabel:input.notLabel?resolve(d.devops.labels,input.notLabel,'name','label'):undefined,
    assignee:input.assignee?assignee(d,input.assignee):undefined,notAssignee:input.notAssignee?assignee(d,input.notAssignee):undefined,
    agents:input.agent?[agentRef(d,input.agent)]:undefined,notAgent:input.notAgent?agentRef(d,input.notAgent):undefined,
    notEntity:input.notEntity?entityOf(d,input.notEntity):undefined,snoozed:input.snoozed};
  const by=agentsByCard(d);
  return page(filterCards(d,f).filter(c=>!input.column||c.column===input.column).map(c=>cardOut(d,c,by)),input,w.rev);
});

op({id:'cards.get',method:'GET',path:B+'/cards/{card}',scope:'read',tags:['cards'],summary:'Get a DevOps card',
  description:'One card by number ("12" or "#12") or id.',
  input:obj({env:ENV,card:{type:['string','integer'],description:'Card number or id.'}},['env','card']),output:one('card',S.card),
  examples:[{title:'Card #12',input:{env:'default-workspace',card:12},output:{rev:42,card:EX.card}}]},
async(input,ctx)=>{const {w,data:d}=await open(ctx,input.env,'read');return {rev:w.rev,card:cardOut(d,cardOf(d,input.card))}});

op({id:'cards.create',method:'POST',path:B+'/cards',scope:'write',tags:['cards'],summary:'Create a DevOps card',
  description:'Add a card (it gets the next #number). Lands in Requests / Sprinted unless `column` says otherwise. References (project, labels, assignees, item) are ids or names; unknown ones are refused with 400. In a shared project, or with share, it is added to that share\'s owner when the share lets you add, and number is the owner\'s (pending: true while it waits for their approval: number is provisional until the owner numbers it); a share that does not is refused with 403 share_adds_off. A shared card takes only the share\'s people (their linked person cards or share members); a person card of your own is refused with 400 person_not_in_share.',
  input:obj({env:ENV,column:COLUMN,...CARD_FIELDS,share:SHARE_INPUT},['env','title']),output:oneNew('card',S.card),
  examples:[{title:'New card',input:{env:'default-workspace',title:'Build sign-up form',project:'Lantern',labels:['High'],points:3,due:'2026-11-15',assignees:[{node:'Cleo Park',role:'developer'}],checklist:[{text:'Email field'}],item:'Public beta'},output:{rev:51,card:EX.card}}]},
async(input,ctx)=>write(ctx,input.env,d=>{
  const c=newCard(d.devops,{column:input.column||NEW_COLUMN}),share=shareFor(d,input.share);if(share)c.id=newId(d,share);cardFields(d,c,input);
  return d2=>({card:cardOut(d2,d2.devops.cards.find(x=>x.id===c.id))});
}));

op({id:'cards.update',method:'PATCH',path:B+'/cards/{card}',scope:'write',tags:['cards'],summary:'Update a DevOps card',
  description:'Change a card\'s fields. Lists you send (labels, assignees, checklist, links) replace the old ones. snoozedUntil snoozes the card until an ISO time ("" or null wakes it). The column only changes through cards.move, which applies the board\'s gates. A description you send replaces the old one: to add to it, read the card and send ifUpdated (its `updated`), so a change someone made meanwhile is refused with 409 card_changed instead of lost.',
  input:obj({env:ENV,card:{type:['string','integer'],description:'Card number or id.'},...CARD_FIELDS,ifUpdated:IF_UPDATED},['env','card']),output:one('card',S.card),
  examples:[{title:'Tick the checklist',input:{env:'default-workspace',card:12,checklist:[{id:'x1',text:'Email field',done:true}]},output:{rev:52,card:{...EX.card,checklist:[{id:'x1',text:'Email field',done:true}]}}},
    {title:'Snooze until Monday',input:{env:'default-workspace',card:12,snoozedUntil:'2026-11-23T16:00:00Z'},output:{rev:53,card:{...EX.card,snoozedUntil:'2026-11-23T16:00:00.000Z'}}}]},
async(input,ctx)=>write(ctx,input.env,d=>{
  const c=cardOf(d,input.card);unchanged(d,c,input);cardFields(d,c,input);c.updated=now();
  return d2=>({card:cardOut(d2,d2.devops.cards.find(x=>x.id===c.id))});
}));

op({id:'cards.move',method:'POST',path:B+'/cards/{card}/move',scope:'write',tags:['cards'],summary:'Move a DevOps card',
  description:'Move a card to a column (and position: `index` among that column\'s other cards; end if left out). The board\'s gates apply: into Done needs `confirm: true`, or `approve: true` from UAT (the Approve button); out of Done needs `confirm: true`; into Doing without a developer needs `developer` (a person, who is assigned) or `confirm: true` to leave it unassigned. A refused gate is 409 with code confirm_done, confirm_reopen or pick_developer. ifUpdated (the card\'s `updated` as you read it) refuses the move with 409 card_changed if the card changed since.',
  input:obj({env:ENV,card:{type:['string','integer'],description:'Card number or id.'},column:COLUMN,index:{type:'integer',minimum:0},confirm:{type:'boolean'},approve:{type:'boolean'},developer:REF('Person node id or name, or someone the card is shared with (@email or email).'),ifUpdated:IF_UPDATED},['env','card','column']),output:one('card',S.card),
  examples:[{title:'Approve from UAT',input:{env:'default-workspace',card:12,column:'done',approve:true},output:{rev:53,card:{...EX.card,column:'done'}}},
    {title:'Start work',input:{env:'default-workspace',card:12,column:'doing',developer:'Cleo Park'},output:{rev:54,card:{...EX.card,column:'doing'}}}]},
async(input,ctx)=>write(ctx,input.env,d=>{
  const c=cardOf(d,input.card),to=input.column,gate=gateFor(c,to);unchanged(d,c,input);
  if(input.approve&&!(c.column==='uat'&&to==='done'))fail(400,'approve_only_from_uat','approve moves a UAT card to Done');
  if(gate==='confirm-done'&&!input.confirm&&!input.approve)fail(409,'confirm_done','Moving a card to Done needs confirm: true (or approve: true from UAT)',{gate});
  if(gate==='confirm-reopen'&&!input.confirm)fail(409,'confirm_reopen','Moving a card out of Done needs confirm: true',{gate});
  if(gate==='pick-dev'){
    if(input.developer)c.assignees.push({node:assignee(d,input.developer,c),role:'developer'});
    else if(!input.confirm)fail(409,'pick_developer','Who is developing it? Send developer (a person), or confirm: true to leave it unassigned',{gate});
  }
  moveCard(d.devops,c.id,to,input.index);
  return d2=>({card:cardOut(d2,d2.devops.cards.find(x=>x.id===c.id))});
}));

// Deleted cards (lib/workspaces.mjs): every removal is recorded, whatever made it, for RETAIN_DAYS.
const deletedOut=e=>({...e,card:{...strip(e.card),agents:e.agents||[]}});
async function deletedEntry(ctx,envId,ref){
  const s=String(ref),all=ctx.store.deletedCards?await ctx.store.deletedCards(envId,{limit:5000}):[];
  const n=/^#?\d+$/.test(s)?Number(s.replace('#','')):null;
  const hits=all.filter(e=>e.id===s||(n!==null?e.number===n:e.cardId===s));
  return hits.find(e=>e.id===s)||hits.find(e=>!e.restoredAt)||hits[0]||fail(404,'deleted_card_not_found',`No deleted card ${s}`);
}
op({id:'cards.deleted',method:'GET',path:B+'/deleted-cards',scope:'read',tags:['cards'],summary:'List recently deleted cards',
  description:`Cards removed from the board in the last ${RETAIN_DAYS} days, newest first, whatever removed them: deleting on the board, undo, a snapshot restore or other whole-workspace save, or the API and MCP. Each entry holds the whole card as it was, who removed it (deletedBy, via and, for an API key or MCP client, actor: the key's name), when, and the last revision it was in (fromRev). They outlive the revision history. Bring one back with cards.restore. Filters: q ("#12" or title text); pending: true leaves out the ones already restored.`,
  input:obj({env:ENV,q:{type:'string',maxLength:200},pending:{type:'boolean'},...PAGE},['env']),output:list(S.deleted),
  examples:[{title:'Recently deleted',input:{env:'default-workspace'},output:{items:[EX.deleted],nextCursor:null,rev:62}},
    {title:'Card #12, not yet restored',input:{env:'default-workspace',q:'#12',pending:true},output:{items:[EX.deleted],nextCursor:null,rev:62}}]},
async(input,ctx)=>{
  const {w}=await open(ctx,input.env,'read'),q=norm(input.q),num=/^#?\d+$/.test(q)?Number(q.replace('#','')):null;
  const all=ctx.store.deletedCards?await ctx.store.deletedCards(input.env,{pending:!!input.pending,limit:5000}):[];
  return page(all.filter(e=>!q||(num!==null?e.number===num:norm(e.title).includes(q))).map(deletedOut),input,w.rev);
});

op({id:'cards.restore',method:'POST',path:B+'/deleted-cards/{entry}/restore',scope:'write',tags:['cards'],summary:'Restore a deleted card',
  description:'Put a deleted card back on the board: same id, column, fields, checklist and links, and its agent links where the agents still exist (labels, projects or people since removed are dropped). It keeps its number if no other card has taken it; otherwise it gets the next number, renumbered is true and message says so. entry is an id from cards.deleted, or a card number ("#12") or card id for its latest deletion. A card that is already back is refused with 409 already_restored.',
  input:obj({env:ENV,entry:REF('Entry id from cards.deleted, or a card number ("#12") or card id.')},['env','entry']),
  output:out({rev:REV,card:S.card,renumbered:{type:'boolean'},previousNumber:{type:['integer','null'],description:'The number it had before, when renumbered.'},message:{type:'string'}},['rev','card','renumbered','previousNumber','message']),
  examples:[{title:'Restore #12',input:{env:'default-workspace',entry:'#12'},output:{rev:63,card:EX.card,renumbered:false,previousNumber:null,message:'Restored #12.'}},
    {title:'Its number was taken',input:{env:'default-workspace',entry:'del_6f1c2a4e-0b7d-4c55-9a3e-2d8f1b0c9e11'},output:{rev:63,card:{...EX.card,number:40},renumbered:true,previousNumber:12,message:'Restored as #40: #12 is now another card.'}}]},
async(input,ctx)=>inTurn(input.env,async()=>{
  await open(ctx,input.env,'write');
  const e=await deletedEntry(ctx,input.env,input.entry);
  if(e.restoredAt)fail(409,'already_restored',`That card was already restored${e.restoredNumber!=null?` as #${e.restoredNumber}`:''}`);
  let was=null;
  const r=await writeNow(ctx,input.env,d=>{
    if(d.devops.cards.some(c=>c.id===e.cardId))fail(409,'already_restored',`That card is on the board again (#${d.devops.cards.find(c=>c.id===e.cardId).number})`);
    const c=strip(structuredClone(e.card));was=null;
    if(!Number.isInteger(c.number)||d.devops.cards.some(x=>x.number===c.number)){was=Number.isInteger(c.number)?c.number:null;c.number=d.devops.nextNumber++}
    c.updated=now();d.devops.cards.push(c);
    for(const a of d.agentflow.agents)if((e.agents||[]).includes(a.id)&&!a.cards.includes(c.id)&&a.cards.length<LIMITS.refs)a.cards=[...a.cards,c.id];
    return d2=>({card:cardOut(d2,d2.devops.cards.find(x=>x.id===c.id))});
  });
  await ctx.store.markRestored?.(input.env,e.id,{by:ctx.user.email,number:r.card.number});
  const renumbered=was!==null||e.number===null;
  return {...r,renumbered,previousNumber:renumbered?e.number:null,message:renumbered?(e.number!=null?`Restored as #${r.card.number}: #${e.number} is now another card.`:`Restored as #${r.card.number}.`):`Restored #${r.card.number}.`};
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
  description:'What a runner needs to work as this agent: its `brief` and its queue, the open DevOps cards delegated to it (cards.update agents, or the card\'s Delegated to picker). A card last changed by someone outside the environment (through an edit share) is left out until the owner changes it again. A snoozed card (snoozedUntil in the future) is left out too, still delegated, and comes back on its own when the snooze ends; includeSnoozed: true keeps snoozed cards in. Order: '+QUEUE_ORDER.join(', ')+' (work in progress first; Blocked and UAT wait on others), then soonest due date, then #number. `columns` narrows the queue, e.g. ["doing","requests"] for cards it can act on now. Report back with cards.update (checklist, links) and cards.move.',
  input:obj({env:ENV,agent:REF('Agent id or name.'),columns:{type:'array',items:COLUMN,description:'Only these columns (comma-separated in a query string).'},includeSnoozed:{type:'boolean',description:'true: keep cards that are snoozed now (left out by default).'},...PAGE},['env','agent']),
  output:out({rev:REV,agent:S.agent,brief:{type:'string'},items:{type:'array',items:S.card},nextCursor:{type:['string','null']}}),
  examples:[{title:'What should the researcher do now?',input:{env:'default-workspace',agent:'Researcher',columns:['doing','requests']},output:{rev:42,agent:EX.agent,brief:EX.brief,items:[EX.card],nextCursor:null}}]},
async(input,ctx)=>{
  const {w,data:d}=await open(ctx,input.env,'read'),a=agentOfRef(d,input.agent),by=agentsByCard(d);
  // A card someone outside the environment changed last (an edit share's recipient) waits for the
  // owner to touch it again: outsider text never starts a runner on its own.
  const all=workQueue(d,a.id,{includeSnoozed:!!input.includeSnoozed}),held=ctx.heldCards?await ctx.heldCards(input.env,all.map(c=>c.id)):new Set();
  const q=all.filter(c=>!held.has(c.id)&&(!input.columns?.length||input.columns.includes(c.column))).map(c=>cardOut(d,c,by));
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

// ---------- sharing: the shares.* operations (docs/sharing.md) ----------
// What Settings › Sharing does, for the caller's own environments. ctx.sharing is the server's share
// service for the caller (lib/share-service.mjs forUser): it holds the rules (only an environment's owner
// shares it, linked sh.* records are never shared on, recipients ask the owner) and the key's scope and
// environment checks. Here: the schemas, and scope references resolved from names to ids.
const sharingOf=ctx=>ctx.sharing||fail(501,'sharing_unavailable','Sharing is not available on this server');
const SHARE_KINDS=['environment','project','label','person','nodes'];
const PERMISSION={enum:['view','comment','edit'],description:'view (read only), comment (read and comment) or edit (change the shared fields and comment).'};
const SHARE_ID=REF('Share id (from shares.list or shares.incoming).');
const ADDS_FIELD={enum:['off','approve','direct'],description:'Edit shares only: what the recipient may add to your environment inside the share (cards, timeline items, projects, mind map cards). off (the default), approve (each addition waits for you: proposals.list, proposals.approve, proposals.deny) or direct (added at once). View and comment shares are always off.'};
const SHARE_SCOPE={...obj({
  kind:{enum:SHARE_KINDS,description:'environment (everything in it), project (a project with its timeline items and DevOps cards), label (the DevOps cards with a label), person (a chart card and everything connected below it, with their projects) or nodes (hand-picked chart cards, nothing below them).'},
  project:REF('For kind project: the project, id or name.'),
  label:REF('For kind label: the DevOps label, id or name.'),
  node:REF('For kind person: the chart card to start from (a person or any card), id or name.'),
  nodes:{type:'array',minItems:1,maxItems:2000,items:REF('Chart card id or name.'),description:'For kind nodes: the chart cards, ids or names.'},
  chart:REF('Optional: only this chart\'s cards and lines (chart id or name, or "active").'),
},['kind']),description:'What to share. Names are matched like everywhere else (id first, then the name, ignoring case), against your own records.'};
S.shareScope=out({kind:{enum:SHARE_KINDS},projectId:{type:'string'},label:{type:'string'},nodeId:{type:'string'},nodeIds:{type:'array',items:{type:'string'}},chartId:{type:'string'}},['kind']);
const COUNTS=out({nodes:{type:'integer'},stubs:{type:'integer'},projects:{type:'integer'},items:{type:'integer'},cards:{type:'integer'}});
S.share=out({id:{type:['string','null'],description:'null in a preview of a share that does not exist yet.'},ownerEnv:{type:'string'},ownerEnvName:{type:'string'},ownerEmail:{type:'string'},recipientEmail:{type:'string'},permission:{enum:['view','comment','edit']},adds:{enum:['off','approve','direct'],description:'What the recipient may add (edit shares only).'},
  scope:S.shareScope,name:{type:'string'},createdAt:{type:'string'},createdBy:{type:'string',description:'Email of the owner who shared it.'},
  actor:{type:['string','null'],description:'The API key (or MCP connector) that created it, by name; null when made in the app. Settings › Sharing shows it as "Created by".'},
  via:{type:['string','null'],description:'The re-share request it was approved from, if any.'},revokedAt:{type:['string','null']},
  scopeLabel:{type:'string',description:'What it holds, in words.'},summary:{anyOf:[COUNTS,{type:'null'}]},tip:{type:['string','null'],description:'A note when the scope may not hold what people expect (e.g. mind map cards but no DevOps cards).'}},
  ['id','ownerEnv','ownerEmail','recipientEmail','permission','scope','createdAt','revokedAt','scopeLabel']);
S.shareRequest=out({id:{type:'string'},shareId:{type:'string'},ownerEmail:{type:'string'},requestedBy:{type:'string'},toEmail:{type:'string'},permission:{enum:['view','comment','edit']},note:{type:'string'},
  status:{enum:['pending','approved','denied']},createdAt:{type:'string'},decidedAt:{type:['string','null']},decidedBy:{type:['string','null']},newShareId:{type:['string','null']}},
  ['id','shareId','ownerEmail','requestedBy','toEmail','permission','status','createdAt']);
S.sharePreview=out({
  nodes:{type:'array',items:out({id:{type:'string'},name:{type:'string'},type:{type:'string'}}),description:'Chart cards the recipient will see.'},
  stubs:{type:'array',items:out({id:{type:'string'},name:{type:'string'},type:{type:'string'},owns:{type:'string'},edge:{type:'string'},percent:{type:'string'}},['id','name']),description:'Co-owners shown by name only (read only).'},
  projects:{type:'array',items:out({id:{type:'string'},name:{type:'string'},color:{type:'string'}},['id','name'])},
  items:{type:'array',items:out({id:{type:'string'},title:{type:'string'},kind:{type:'string'},start:{type:'string'}},['id','title'])},
  cards:{type:'array',items:out({id:{type:'string'},number:{type:['integer','null']},title:{type:'string'},project:{type:['string','null']}},['id','title'])},
  summary:COUNTS,tip:{type:['string','null']}},['nodes','stubs','projects','items','cards','summary','tip']);

// A scope from the API's form ({kind, project|label|node|nodes, chart}, ids or names) to the stored form.
// Your own records win over linked copies of the same name; a linked one (sh.*) resolves and is then
// refused by the share service, with a pointer to shares.requests.create.
async function shareScope(ctx,env,s){
  const {data:d}=await open(ctx,env,'read');
  const find=(list,ref,key,what)=>{
    if(String(ref).startsWith('sh.'))return ref; // a linked id: refused below as share_linked, whether or not it is here
    const own=list.filter(x=>!String(x.id).startsWith('sh.')),r=norm(ref);
    const x=own.find(v=>v.id===ref)||own.find(v=>norm(v[key])===r)||list.find(v=>v.id===ref)||list.find(v=>norm(v[key])===r);
    return x?x.id:fail(400,`unknown_${what}`,`No ${what} "${ref}"`);
  };
  const needs=k=>s[k]===undefined&&fail(400,'invalid_scope',`A ${s.kind} share needs ${k}`);
  const chart=s.chart===undefined?null:d.charts.find(c=>c.id===(s.chart==='active'?d.active:s.chart))||d.charts.find(c=>norm(c.name)===norm(s.chart))||fail(404,'chart_not_found',`No chart ${s.chart}`);
  const nodes=chart?chart.nodes:allNodes(d);
  const sc={kind:s.kind,...(chart?{chartId:chart.id}:{})};
  if(s.kind==='project'){needs('project');sc.projectId=find(d.projects,s.project,'name','project')}
  else if(s.kind==='label'){needs('label');sc.label=find(d.devops.labels,s.label,'name','label')}
  else if(s.kind==='person'){needs('node');sc.nodeId=find(nodes,s.node,'name','node')}
  else if(s.kind==='nodes'){needs('nodes');sc.nodeIds=[...new Set(s.nodes.map(n=>find(nodes,n,'name','node')))]}
  return sc;
}
const SHARE_EX={id:'6f1c2a4e-0b7d-4c55-9a3e-2d8f1b0c9e11',ownerEnv:'default-workspace',ownerEnvName:'Default workspace',ownerEmail:'owner@example.test',recipientEmail:'bo@example.com',permission:'edit',
  adds:'off',scope:{kind:'project',projectId:'p1'},name:'',createdAt:T,createdBy:'owner@example.test',actor:'Laptop agent',via:null,revokedAt:null,scopeLabel:'Project Lantern',summary:{nodes:0,stubs:0,projects:1,items:1,cards:4},tip:null};
const PREVIEW_EX={nodes:[],stubs:[],projects:[{id:'p1',name:'Lantern',color:'#7cb980'}],items:[{id:'i1',title:'Public beta',kind:'release',start:'2026-12-01'}],cards:[{id:'k1',number:12,title:'Build sign-up form',project:'p1'}],summary:{nodes:0,stubs:0,projects:1,items:1,cards:1},tip:null};
const REQUEST_EX={id:'0c7e9a52-3b1d-4f0e-8a6c-5d2b9e4f1a77',shareId:SHARE_EX.id,ownerEmail:'owner@example.test',requestedBy:'bo@example.com',toEmail:'kim@example.com',permission:'view',note:'Kim helps with the launch',status:'pending',createdAt:T,decidedAt:null,decidedBy:null,newShareId:null};

op({id:'shares.list',method:'GET',path:B+'/shares',scope:'read',tags:['sharing'],summary:'List shares of an environment',
  description:'Who you share this environment (or parts of it) with: each share\'s recipient, permission, scope in words and counts, plus the pending re-share requests on them (approve or deny with shares.requests.decide). Only the environment\'s owner can list them; anyone else gets 404.',
  input:obj({env:ENV},['env']),output:out({shares:{type:'array',items:S.share},requests:{type:'array',items:S.shareRequest}}),
  examples:[{title:'Shares of the default workspace',input:{env:'default-workspace'},output:{shares:[SHARE_EX],requests:[REQUEST_EX]}}]},
async({env},ctx)=>sharingOf(ctx).list(env));

op({id:'shares.preview',method:'POST',path:B+'/shares/preview',scope:'read',tags:['sharing'],summary:'Preview what a share would show',
  description:'Exactly what a recipient would see for a scope, before you share: chart cards, co-owner stubs (name only), projects, timeline items and DevOps cards, with counts and a tip when the scope may surprise people. Nothing is stored. Owner only.',
  input:obj({env:ENV,scope:SHARE_SCOPE},['env','scope']),output:out({preview:S.sharePreview,label:{type:'string',description:'The scope in words, as Settings › Sharing shows it.'}}),
  examples:[{title:'Project Lantern by name',input:{env:'default-workspace',scope:{kind:'project',project:'Lantern'}},output:{preview:PREVIEW_EX,label:'Project Lantern'}}]},
async({env,scope},ctx)=>sharingOf(ctx).preview(env,await shareScope(ctx,env,scope)));

op({id:'shares.create',method:'POST',path:B+'/shares',scope:'write',tags:['sharing'],summary:'Share part of an environment with someone',
  description:'Gives another Flow user (by email) access to part of your environment: they see it as linked records they can add to their own environments, and edit or comment when the permission allows. Two steps, because this grants a person access to data: without confirm: true it only answers with the preview (what they would see) and stores nothing (200, created false). Show that preview to your user and ask them before you call again with confirm: true, which creates the share (201). Sharing the same scope with the same person again changes the permission instead (existing true). Only the environment\'s owner can share it; records shared with you (ids sh.…) cannot be shared on: ask their owner with shares.requests.create. Needs a key with write access to this environment. The share records the key\'s name, shown in Settings › Sharing as "Created by".',
  input:obj({env:ENV,recipientEmail:{type:'string',minLength:3,maxLength:254,description:'Who to share with: their email (the account they sign in to Flow with).'},scope:SHARE_SCOPE,
    permission:{...PERMISSION,default:'view'},adds:ADDS_FIELD,name:{type:'string',maxLength:80,description:'Optional label for the share.'},
    confirm:{type:'boolean',default:false,description:'false (the default): preview only, nothing is shared. true: create the share. Only send true after your user has seen the preview and agreed.'}},['env','recipientEmail','scope']),
  output:out({created:{type:'boolean',description:'True when this call created a new share.'},existing:{type:'boolean',description:'The same scope is already shared with this person (its permission is changed on confirm).'},
    confirmed:{type:'boolean',description:'Whether confirm was true. false: nothing was stored.'},share:S.share,preview:S.sharePreview,label:{type:'string'}},['created','existing','confirmed','share','preview','label']),
  examples:[
    {title:'Preview first: project Lantern with edit access',input:{env:'default-workspace',recipientEmail:'bo@example.com',scope:{kind:'project',project:'Lantern'},permission:'edit'},
      output:{created:false,existing:false,confirmed:false,share:{...SHARE_EX,id:null},preview:PREVIEW_EX,label:'Project Lantern'}},
    {title:'Then, once your user agrees, share it',input:{env:'default-workspace',recipientEmail:'bo@example.com',scope:{kind:'project',project:'Lantern'},permission:'edit',confirm:true},
      output:{created:true,existing:false,confirmed:true,share:SHARE_EX,preview:PREVIEW_EX,label:'Project Lantern'}}]},
async(input,ctx)=>sharingOf(ctx).create(input.env,{recipientEmail:input.recipientEmail,scope:await shareScope(ctx,input.env,input.scope),permission:input.permission,adds:input.adds,name:input.name},input.confirm===true));

op({id:'shares.update',method:'PATCH',path:'/api/v1/shares/{share}',scope:'write',tags:['sharing'],summary:'Change a share\'s permission',
  description:'Set what the recipient may do: permission view, comment or edit, and for edit shares adds (whether they may add records). Send either or both. Lowering an edit share to view or comment turns additions off. Owner only (anyone else gets 404); a revoked share gets 409.',
  input:obj({share:SHARE_ID,permission:PERMISSION,adds:ADDS_FIELD},['share']),output:out({share:S.share}),
  examples:[{title:'Down to view',input:{share:SHARE_EX.id,permission:'view'},output:{share:{...SHARE_EX,permission:'view',adds:'off'}}},
    {title:'Let them add, with your approval',input:{share:SHARE_EX.id,adds:'approve'},output:{share:{...SHARE_EX,adds:'approve'}}}]},
async({share,permission,adds},ctx)=>sharingOf(ctx).update(share,{permission,adds}));

op({id:'shares.revoke',method:'DELETE',path:'/api/v1/shares/{share}',scope:'write',tags:['sharing'],summary:'Revoke a share',
  description:'Stop sharing: the linked records leave every environment of the recipient\'s on their next read (their own records stay). The share and its history are kept, marked revoked. Owner only.',
  input:obj({share:SHARE_ID},['share']),output:out({share:S.share,revoked:{type:'boolean'}}),
  examples:[{title:'Revoke',input:{share:SHARE_EX.id},output:{share:{...SHARE_EX,revokedAt:T},revoked:true}}]},
async({share},ctx)=>sharingOf(ctx).revoke(share));

op({id:'shares.incoming',method:'GET',path:'/api/v1/shares/incoming',scope:'read',tags:['sharing'],summary:'List shares with you',
  description:'What others share with you: owner, scope, permission, and envs, the environments of yours it is placed in (where its linked records show, with ids sh.<share>.<id>). To have it shared with someone else, ask its owner with shares.requests.create.',
  input:obj({}),output:out({shares:{type:'array',items:{...S.share,properties:{...S.share.properties,envs:{type:'array',items:{type:'string'},description:'Your environments it is placed in.'}}}}}),
  examples:[{title:'Shared with you',input:{},output:{shares:[{...SHARE_EX,ownerEmail:'cleo@example.com',recipientEmail:'owner@example.test',envs:['default-workspace']}]}}]},
async(input,ctx)=>sharingOf(ctx).incoming());

op({id:'shares.requests.list',method:'GET',path:'/api/v1/share-requests',scope:'read',tags:['sharing'],summary:'List re-share requests',
  description:'requests: pending requests from the recipients of your shares to share them on with someone else (decide with shares.requests.decide). mine: the requests you sent, with their status.',
  input:obj({}),output:out({requests:{type:'array',items:S.shareRequest},mine:{type:'array',items:S.shareRequest}}),
  examples:[{title:'Waiting for you',input:{},output:{requests:[REQUEST_EX],mine:[]}}]},
async(input,ctx)=>sharingOf(ctx).requests());

op({id:'shares.requests.create',method:'POST',path:'/api/v1/shares/{share}/requests',scope:'write',tags:['sharing'],summary:'Ask the owner to share it on',
  description:'You cannot share what is shared with you, but you can ask its owner to share the same records with someone else. The permission defaults to yours and cannot be more than yours. The owner approves (maybe at a lower permission) or denies it in Settings › Sharing or with shares.requests.decide.',
  input:obj({share:SHARE_ID,toEmail:{type:'string',minLength:3,maxLength:254,description:'Who it should be shared with.'},permission:PERMISSION,note:{type:'string',maxLength:500,description:'A note for the owner.'}},['share','toEmail']),
  output:out({request:S.shareRequest}),
  examples:[{title:'Ask to share with Kim',input:{share:SHARE_EX.id,toEmail:'kim@example.com',permission:'view',note:'Kim helps with the launch'},output:{request:REQUEST_EX}}]},
async({share,...b},ctx)=>sharingOf(ctx).ask(share,b));

op({id:'shares.requests.decide',method:'POST',path:'/api/v1/share-requests/{request}',scope:'write',tags:['sharing'],summary:'Approve or deny a re-share request',
  description:'The owner\'s answer to a request from shares.requests.list. approve: true creates a new share of the same scope with the person asked for, at the requested permission or the lower one you pass; false denies it. Like shares.create, approving grants a person access: show the request to your user first. A request already decided gets 409.',
  input:obj({request:REF('Request id.'),approve:{type:'boolean'},permission:{...PERMISSION,description:'Optional: approve at this permission (not more than requested).'}},['request','approve']),
  output:out({request:S.shareRequest,share:{anyOf:[S.share,{type:'null'}],description:'The new share when approved; null when denied.'}}),
  examples:[{title:'Approve at view',input:{request:REQUEST_EX.id,approve:true,permission:'view'},output:{request:{...REQUEST_EX,status:'approved',decidedAt:T,decidedBy:'owner@example.test',newShareId:'9a3e2d8f-1b0c-4e11-8f1c-2a4e0b7d4c55'},
    share:{...SHARE_EX,id:'9a3e2d8f-1b0c-4e11-8f1c-2a4e0b7d4c55',recipientEmail:'kim@example.com',permission:'view',via:REQUEST_EX.id}}}]},
async({request,approve,permission},ctx)=>sharingOf(ctx).decide(request,{approve,permission}));

// ---------- 3D office: live coding agents, reported per person (lib/office.mjs) ----------
// Not per environment: an agent belongs to the API key's owner and shows in the office of every
// environment they are a member of, redacted per viewer. ctx.office is the server's officeState().
const OFFICE='/api/v1/office';
const officeOf=ctx=>ctx.office||fail(501,'office_unavailable','The 3D office is not available on this server');
const SOURCE={type:'string',minLength:1,maxLength:60,description:'The reporter, e.g. "bridge:laptop". Each source replaces only its own agents.'};
const OFFICE_ACTION=out({id:{type:'string'},agentId:{type:'string'},source:{type:'string'},
  kind:{enum:['answer','message','stop','history'],description:'answer: Allow / Deny (requestId, decision); message: send text as a new user turn (to a live agent, or to any thread in your threads index, idle ones too); stop: interrupt its running turn; history: send back a page of the thread\'s conversation as the result\'s data. Treat a missing kind as answer.'},
  requestId:{type:'string',description:'answer only.'},decision:{enum:['allow','deny'],description:'answer only.'},text:{type:'string',maxLength:2000,description:'message only: what its owner wrote.'},
  before:{type:'string',maxLength:200,description:'history only: the cursor from the last page (its before); missing for the newest page.'},at:{type:'string'},
  result:out({ok:{type:'boolean'},message:{type:'string'},at:{type:'string'}})},['id','agentId','kind','at']);
// Reporters are taken leniently: an unknown vendor is "other", an unknown status "idle".
const LIVE_STATUS={type:'string',description:'running (working), waiting (on its person: a permission prompt or a question) or idle.'};
const LIVE_VENDOR={type:'string',description:'Which mascot it gets: claude, codex, gemini, deepseek, grok or other (other: picked from the model when it names one).'};
const LIVE_KIND={type:'string',enum:['edit','read','search','run','test','think','web','idle'],description:'What kind of work it is doing, for its animation in the office: edit (changing files), read, search, run (shell commands), test, think, web or idle. Optional: when missing or unknown, Flow infers it from activity (a tool name such as Edit, Read, Grep, Bash or WebFetch, or words such as "Running tests"); an idle agent is always idle. Shown for private agents too.'};
// What an agent is doing this moment, and a source's thread index (lib/office-threads.mjs): owner only, always.
const LIVE_NOW={type:['object','null'],description:'What it is doing this moment, for its owner only (never anyone else, whatever they can see; dropped while idle): its latest reasoning snippet, tool call or partial reply, and its last steps. Masked again on the server. Send it with each report, and in between with office.live.report as it changes.',
  properties:{phase:{type:'string',enum:['thinking','tool','writing'],description:'thinking (reasoning), tool (a tool call or command) or writing (its reply).'},text:{type:'string',description:'The latest reasoning snippet, tool call summary ("Read lib/auth.mjs", "Run: npm test") or partial reply (up to 600 characters).'},
    steps:{type:'array',description:'Its last steps, oldest first (up to 8; each text up to 200 characters).',items:{type:'object',properties:{kind:{type:'string',enum:['thinking','tool','writing']},text:{type:'string'},at:{type:'string',description:'When (ISO time).'}}}},
    at:{type:'string',description:'When it was read (ISO time).'}}};
const THREADS={type:['object','null'],description:'Your recent threads on this source, as your T3 sidebar shows them, for you only: never sent to anyone else. Send it when it changes (and now and then); a report without it keeps the last one, null clears it.',
  properties:{items:{type:'array',description:'Up to 150, newest first.',items:{type:'object',required:['id','state'],properties:{id:{type:'string',description:'The thread, as its agent id when it runs (so a working thread is the same as its live agent).'},title:{type:'string'},project:{type:'string',description:'The T3 project\'s name.'},
      state:{type:'string',enum:['working','waiting','woke','done','snoozed','settled'],description:'working (a turn is running), waiting (on you: an approval or a question), woke (back from a snooze), done (its last turn finished), snoozed or settled.'},
      updatedAt:{type:'string'},branch:{type:'string'},unread:{type:'boolean',description:'Its last turn finished after you last looked at it.'}}}},
    counts:{type:'object',description:'How many threads are snoozed and settled in all (the index may list only recent ones).',properties:{snoozed:{type:'integer',minimum:0},settled:{type:'integer',minimum:0}}},
    can:{type:'array',items:{type:'string',enum:['message','history']},description:'What the office may ask of any thread in it: message (a new user turn, idle threads too) and history (a page of its conversation).'},
    at:{type:'string'}}};
const LIVE_AGENT={type:'object',required:['id'],properties:{
  id:{type:'string',description:'Stable and unique within the source, e.g. "laptop:t3:thread-abc".'},title:{type:'string',description:'What it is working on (up to 200 characters).'},
  vendor:LIVE_VENDOR,model:{type:'string',description:'Display name, e.g. "Opus 5.5".'},status:LIVE_STATUS,activity:{type:'string',description:'What it is doing right now, e.g. "Running tests" or "Edit lib/auth.mjs".'},activityKind:LIVE_KIND,
  host:{type:'string',description:'The machine, e.g. "laptop".'},hostLabel:{type:'string',description:'How to show where it runs, e.g. "laptop · T3".'},
  repo:{type:['object','null'],properties:{name:{type:'string'},remote:{type:'string',description:'The git remote; credentials are dropped.'}},description:'The repository it works in: matched against projects\' repos to decide who may see the details.'},
  children:{type:'array',description:'Its subagents (up to 20 kept).',items:{type:'object',properties:{id:{type:'string'},title:{type:'string'},vendor:LIVE_VENDOR,model:{type:'string'},status:LIVE_STATUS,activityKind:{...LIVE_KIND,description:'As for the agent; inferred from the title when missing.'}}}},
  pending:{type:['object','null'],description:'What it waits on (only kept while status is waiting).',properties:{requestId:{type:'string'},kind:{type:'string',description:'approval or question.'},summary:{type:'string',description:'e.g. "Run: npm test" (up to 500 characters).'},
    can:{type:'array',items:{type:'string'},description:'allow and/or deny: the answers the reporter can carry out; [] when it can only be answered where it runs.'}}},
  agentflow:{type:['object','null'],description:'The AgentFlow agent and card it works on, when the reporter knows: it then sits at that agent\'s desk in the office\'s common area. Resolved in each environment against its own agents and cards (elsewhere it keeps its own desk). Without it, Flow reads the title: "[Flow] <Agent>: #<n> …" (the agent runner\'s threads), or "#<n>" for a card delegated to exactly one agent.',
    properties:{agent:{type:'string',description:'The AgentFlow agent\'s id or name.'},card:{type:['integer','string'],description:'The card\'s number (12 or "#12") or id.'}}},
  can:{type:'array',items:{type:'string'},description:'What its owner may do from the office besides Allow / Deny: "message" (send it a message as a new user turn), "stop" (interrupt its running turn) and "history" (send back a page of its conversation, office.actions.wait kind history). Only list what this reporter can carry out; [] or none when it can only be steered where it runs.'},
  live:LIVE_NOW,
  transcript:{type:'array',description:'The latest lines of its conversation (the last 12 are kept, each cut to 400 characters), shown only to its owner: never to anyone else, whatever they can see. Mask secrets before sending; Flow masks tokens, keys, Authorization headers and .env-looking lines again.',
    items:{type:'object',properties:{role:{type:'string',description:'user, assistant or tool (other roles are dropped).'},text:{type:'string',description:'What was said, or what a tool did ("Run: npm test").'},at:{type:'string',description:'When (ISO time).'}}}},
  role:{type:'string',enum:['conductor'],description:'conductor: this agent is its owner\'s Chief of Staff, a long-lived thread that takes their messages from the office, routes work to AgentFlow agents and answers questions. The office draws it as their companion. Always private to everyone but its owner (others see only that it is one, and its status), whatever its repo. Report at most one per person; list "message" in can.'},
  reply:{type:['object','null'],description:'A conductor\'s latest reply, for its owner only (like transcript; masked again on the server): what the office shows in its bubble and log.',
    properties:{text:{type:'string',description:'What it said (up to 600 characters), e.g. the say of its [[office]] line, else the start of its last message.'},at:{type:'string',description:'When (ISO time).'},cards:{type:'array',items:{type:'integer'},description:'Card numbers it names, shown as links (up to 12).'}}},
  usage:{type:['object','null'],description:'Optional model use for today, as the reporter measured it. Omit the object when you do not measure use: the office meter then shows a dash. The office bridge does not send this yet. Someone who cannot see the agent does not receive it (they still see running or waiting).',
    properties:{tokens:{type:'number',minimum:0,description:'Tokens used today.'},costUsd:{type:'number',minimum:0,description:'Cost in US dollars today.'}}}}};
// Reports are checked leniently: the documented fields without their types, so one odd row (a null remote,
// a number for a string) never fails the whole report. lib/office.mjs cleanReport cleans each row and drops bad ones.
const loose=x=>{if(!x||typeof x!=='object'||Array.isArray(x))return x;const {type,required,enum:_,...rest}=x;const o={};for(const [k,v] of Object.entries(rest))o[k]=k==='properties'?Object.fromEntries(Object.entries(v).map(([n,s])=>[n,loose(s)])):k==='items'?loose(v):v;return o};
const OFFICE_EX_AGENT={id:'laptop:t3:thread-abc',title:'Fix login bug',vendor:'claude',model:'Opus 5.5',status:'waiting',activity:'Waiting for approval',activityKind:'test',host:'laptop',hostLabel:'laptop · T3',
  repo:{name:'flow',remote:'https://github.com/acme/flow.git'},children:[],pending:{requestId:'req-1',kind:'approval',summary:'Run: npm test',can:['allow','deny']},agentflow:{agent:'Builder',card:12},can:['message','stop'],
  transcript:[{role:'user',text:'Fix the login redirect loop.',at:T},{role:'assistant',text:'The callback keeps ?next=/login. Running the tests next.',at:T},{role:'tool',text:'Run: npm test',at:T}]};

op({id:'office.agents.report',method:'PUT',path:OFFICE+'/agents',scope:'write',tags:['office'],summary:'Report your live coding agents',
  description:'A reporter on your machine (flow office bridge, or any integration) sends every coding agent running there, every few seconds. Agents belong to you (the key\'s owner) and show at your desk in the 3D office of every environment you are a member of, or, working on an AgentFlow agent\'s card (agentflow, or a title such as "[Flow] Builder: #12 …"), at that agent\'s desk in the common area. Each source replaces only its own set, and a source that has not reported for 90 seconds is gone. Others see an agent\'s details only when its repo belongs to a project they can see (projects.update repos); otherwise just its mascot and status, as "Private project". An optional usage object ({tokens, costUsd} for the reporter’s local day) contributes to that person\'s room meter when the viewer can see the agent. The office bridge sends measured usage and estimates cost at API list prices. Up to 200 agents and 20 children each are kept, and long strings are cut. The answer holds the actions from the office that this source has not been sent yet (also served by office.actions.wait): Allow / Deny answers, and messages and stops for agents that list them in can.',
  input:{type:'object',properties:{source:SOURCE,at:{type:'string',maxLength:40,description:'When the reporter read its agents (ISO time).'},agents:{type:'array',items:loose(LIVE_AGENT)},threads:loose(THREADS)},required:['source','agents']},
  output:out({actions:{type:'array',items:OFFICE_ACTION},accepted:{type:'integer',description:'How many agents were kept.'}},['actions']),
  examples:[{title:'One agent waiting on a prompt',input:{source:'bridge:laptop',at:T,agents:[OFFICE_EX_AGENT]},output:{actions:[],accepted:1}}]},
async(input,ctx)=>officeOf(ctx).report(ctx.user.email,input));

op({id:'office.agents.list',method:'GET',path:OFFICE+'/agents',scope:'read',tags:['office'],summary:'List your reported agents',
  description:'Your live agents as Flow holds them (every source that reported in the last 90 seconds), in full, and the sources.',
  input:obj({}),output:out({agents:{type:'array',items:LIVE_AGENT},sources:{type:'array',items:out({source:{type:'string'},at:{type:'string'},agents:{type:'integer'}})},
    threads:{type:'array',description:'Each source\'s thread index (office.agents.report threads), with its source.',items:{...THREADS,type:'object'}}}),
  examples:[{title:'Yours',input:{},output:{agents:[{...OFFICE_EX_AGENT,source:'bridge:laptop'}],sources:[{source:'bridge:laptop',at:T,agents:1}],threads:[]}}]},
async(input,ctx)=>{const o=officeOf(ctx);await o.refresh?.([ctx.user.email.trim().toLowerCase()]);return {agents:o.live(ctx.user.email),sources:o.sources(ctx.user.email),threads:o.threads?.(ctx.user.email)??[]}});

op({id:'office.live.report',method:'POST',path:OFFICE+'/live',scope:'write',tags:['office'],summary:'Stream what your agents are doing',
  description:'Between reports, as it changes: each agent\'s live field (its latest reasoning, tool call or partial reply, and its last steps) for agents in this source\'s current report. Only you, their owner, ever see it, in your own office. live null clears it; idle agents and unknown ids are skipped. Up to 30 in a burst, then 8 a second per source: debounce on your side (about 150 ms). Kept in memory only: the next office.agents.report carries it too.',
  input:{type:'object',properties:{source:SOURCE,agents:{type:'array',items:{type:'object',properties:{id:{type:'string'},live:loose(LIVE_NOW)}}}},required:['source','agents']},
  output:out({accepted:{type:'integer',description:'How many agents\' live fields changed.'}},['accepted']),
  examples:[{title:'Thinking',input:{source:'bridge:laptop',agents:[{id:'laptop:t3:thread-abc',live:{phase:'tool',text:'Run: npm test',steps:[{kind:'thinking',text:'Checking the redirect',at:T},{kind:'tool',text:'Run: npm test',at:T}]}}]},output:{accepted:1}}]},
async(input,ctx)=>officeOf(ctx).patchLive(ctx.user.email,input));

op({id:'office.actions.wait',method:'GET',path:OFFICE+'/actions',scope:'write',tags:['office'],summary:'Wait for answers to your agents\' prompts',
  description:'Long-poll for the actions taken in the 3D office on this source\'s agents by their owner: returns as soon as one is queued, or an empty list after wait seconds (0 to 30; 0 answers at once). kind answer is Allow / Deny on pending.requestId (a missing kind is answer); message is text to send as a new user turn; stop interrupts its running turn (both only for agents whose can lists them). Each action is delivered once (here or in the office.agents.report answer). Check the agent is still the same and still yours, carry it out, then send the result with office.actions.result.',
  input:obj({source:SOURCE,wait:{type:'integer',minimum:0,maximum:30,default:0,description:'Seconds to wait for an answer (0-30).'}},['source']),output:out({actions:{type:'array',items:OFFICE_ACTION}}),
  examples:[{title:'An answer',input:{source:'bridge:laptop',wait:25},output:{actions:[{id:'act_1',agentId:'laptop:t3:thread-abc',source:'bridge:laptop',kind:'answer',requestId:'req-1',decision:'allow',at:T}]}},
    {title:'A message and a stop',input:{source:'bridge:laptop',wait:25},output:{actions:[{id:'act_2',agentId:'laptop:t3:thread-abc',source:'bridge:laptop',kind:'message',text:'Also add a test for it.',at:T},{id:'act_3',agentId:'laptop:t3:thread-abc',source:'bridge:laptop',kind:'stop',at:T}]}}]},
async(input,ctx)=>({actions:await officeOf(ctx).wait(ctx.user.email,input.source,input.wait*1000)}));

op({id:'office.actions.result',method:'POST',path:OFFICE+'/actions/{id}',scope:'write',tags:['office'],summary:'Say how an answer went',
  description:'The reporter carried out (or could not carry out) an action from office.actions.wait: the agent\'s owner sees the message in the office right away. Keep it short, and never echo a message\'s text.',
  input:obj({id:REF('The action id (act_…).'),ok:{type:'boolean'},message:{type:'string',maxLength:300,description:'e.g. "Approved in T3".'},
    data:{type:['object','null'],description:'history only: the page, {items, before, more}, oldest first. Each item: id (stable within the thread, up to 80 characters, so pages merge), role (user, assistant, reasoning or tool), text (up to 4000 characters), title (a tool call or reasoning summary, up to 200), detail (a tool\'s short result, up to 600), status, at, turn. Up to 60 items and 64 KB; masked again. before: the cursor for the page before this one; more: there is one. Delivered to the owner\'s open office and never stored.',
      properties:{items:{type:'array',items:{type:'object'}},before:{type:['string','null']},more:{type:'boolean'}}}},['id','ok']),output:out({action:OFFICE_ACTION}),
  examples:[{title:'Done',input:{id:'act_1',ok:true,message:'Approved in T3'},output:{action:{id:'act_1',agentId:'laptop:t3:thread-abc',source:'bridge:laptop',kind:'answer',requestId:'req-1',decision:'allow',at:T,result:{ok:true,message:'Approved in T3',at:T}}}}]},
async(input,ctx)=>({action:await officeOf(ctx).result(ctx.user.email,input.id,{ok:input.ok,message:input.message,data:input.data})}));
// ---------- share additions (docs/sharing.md): records recipients add inside your shares ----------
const PSTATUS=['pending','approved','denied','applied','withdrawn'];
S.proposal=out({id:{type:'string'},shareId:{type:'string'},env:{type:'string',description:'The environment of the share\'s owner.'},proposedBy:{type:'string',description:'Who added them (the share\'s recipient).'},
  status:{enum:PSTATUS},role:{enum:['owner','proposer'],description:'owner: yours to approve or deny; proposer: you added it to someone else\'s share.'},createdAt:{type:'string'},updatedAt:{type:'string'},decidedAt:{type:['string','null']},decidedBy:{type:['string','null']},
  preview:{type:'array',items:out({kind:{enum:['node','edge','project','item','card']},id:{type:'string'},title:{type:'string'},detail:{type:'string'}},['kind','id','title'])},
  records:{type:'object',description:'The records as they would land in the owner\'s data, by kind (node, edge, project, item, card). Owner only.'}},['id','shareId','env','proposedBy','status','createdAt','preview']);
EX.proposal={id:'5b0c7f2e-61d4-4e0f-9c8a-3f1e2d4c5b6a',shareId:'9a7e3c1b-2d4f-4b6a-8c0e-1f3a5b7d9e2c',env:'default-workspace',proposedBy:'kim@example.test',status:'pending',role:'owner',createdAt:T,updatedAt:T,decidedAt:null,decidedBy:null,
  preview:[{kind:'card',id:'k9',title:'Draft the launch email',detail:'Lantern'}],records:{node:[],edge:[],project:[],item:[],card:[{id:'k9',title:'Draft the launch email',column:'requests',project:'p1'}]}};
const proposalsOf=ctx=>ctx.proposals||fail(501,'not_available','Share additions are not available here');
async function decided(ctx,input,approve){
  await open(ctx,input.env,'write');
  const r=await proposalsOf(ctx).decide(input.proposal,ctx.user,approve,input.env);
  if(r.status!==200)fail(r.status,r.body.code||'refused',r.body.error);
  return r.body;
}
op({id:'proposals.list',method:'GET',path:B+'/proposals',scope:'read',tags:['sharing'],summary:'List share additions',
  description:'Records that recipients of this environment\'s edit shares added while their share needs your approval (role owner), and the ones you added from this environment to someone else\'s share (role proposer). status: pending (the default), approved, denied, withdrawn, or applied (added at once by a share that allows it). preview says what each one adds. Decide with proposals.approve or proposals.deny; set what a share allows in the app (Settings › Sharing).',
  input:obj({env:ENV,status:{enum:PSTATUS,default:'pending'},...PAGE},['env']),output:list(S.proposal),
  examples:[{title:'Waiting for you',input:{env:'default-workspace'},output:{items:[EX.proposal],nextCursor:null,rev:42}}]},
async(input,ctx)=>{const {w}=await open(ctx,input.env,'read');return page(await proposalsOf(ctx).list(input.env,ctx.user,{status:input.status}),input,w.rev)});
op({id:'proposals.approve',method:'POST',path:B+'/proposals/{proposal}/approve',scope:'write',tags:['sharing'],summary:'Approve a share addition',
  description:'Add a pending proposal\'s records to this environment, owned by you (cards get your next numbers). The recipient then sees them as ordinary shared records. Only the environment\'s owner can; a decided one is refused with 409 proposal_decided, and one that no longer fits its share (what it was added to is gone or no longer shared) with 409 proposal_out_of_scope.',
  input:obj({env:ENV,proposal:REF('Proposal id (proposals.list).')},['env','proposal']),output:out({proposal:S.proposal}),
  examples:[{title:'Approve',input:{env:'default-workspace',proposal:EX.proposal.id},output:{proposal:{...EX.proposal,status:'approved',decidedAt:T,decidedBy:'owner@example.test'}}}]},
async(input,ctx)=>decided(ctx,input,true));
op({id:'proposals.deny',method:'POST',path:B+'/proposals/{proposal}/deny',scope:'write',tags:['sharing'],summary:'Deny a share addition',
  description:'Turn down a pending proposal. Nothing is added; the recipient\'s pending copy disappears and they are told it was denied. A decided one is refused with 409 proposal_decided.',
  input:obj({env:ENV,proposal:REF('Proposal id (proposals.list).')},['env','proposal']),output:out({proposal:S.proposal}),
  examples:[{title:'Deny',input:{env:'default-workspace',proposal:EX.proposal.id},output:{proposal:{...EX.proposal,status:'denied',decidedAt:T,decidedBy:'owner@example.test'}}}]},
async(input,ctx)=>decided(ctx,input,false));

export const getOperation=id=>operations.find(o=>o.id===id)||null;

export async function invoke(id,input,ctx){
  const o=getOperation(id);if(!o)fail(404,'unknown_operation',`No operation ${id}`);
  if(!ctx?.user?.email)fail(401,'unauthorized','Sign in or send an API key');
  // An API key's scopes, for every caller (/api/v1 checks them too; MCP relies on this).
  const RANK={read:1,write:2,admin:3},key=ctx.user.key;
  if(key&&Array.isArray(key.scopes)&&!key.scopes.some(x=>RANK[x]>=RANK[o.scope]))fail(403,'insufficient_scope',`This needs the ${o.scope} scope`);
  const raw=input&&typeof input==='object'&&!Array.isArray(input)?input:fail(400,'invalid_input','Input must be an object');
  const problems=check(o.input,raw);if(problems.length)fail(400,'invalid_input',problems.join('; '),{details:problems});
  return handlers.get(id)(withDefaults(o.input,raw),ctx);
}
